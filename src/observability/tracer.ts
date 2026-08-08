// Performance-API tracing for the observability layer: the span vocabulary,
// the span and span-record shapes, the bounded record buffer, the parent
// stack, the frame-callback wrapper, the engine-event listeners, and the
// boundary helpers the input adapter, the hook bus, the relic layer and the
// renderer wrap their own work in.
//
// PROVENANCE — the three `requestAnimationFrame` call sites of the retired
// sources, none of which was instrumented:
//   js/html_actuator.js L13      the frame `actuate` wrapped every DOM write
//                                in.
//   js/html_actuator.js L69      the nested frame inside `addTile`, which
//                                re-applied the position class so the move
//                                transition fired.
//   js/application.js L2         the frame construction was deferred to.
// Their successor is src/render/render-loop.ts, whose per-frame work
// `instrumentFrameCallback` wraps and whose `onFrameBegin`/`onFrameEnd` seam
// `frameLifecycleHooks()` fills.
//
// Two further boundaries this module spans, and one it subscribes through, are
// js/game_manager.js L130 where the turn span opens, js/game_manager.js L91-L97
// where it closes, and js/keyboard_input_manager.js L18-L23's appended listener
// array, the property src/engine/engine-events.ts preserves and the one
// `attachEngineTracing` attaches through with no engine-side call site. The
// traced boundary chain is drawn as a named Mermaid figure in
// docs/architecture/hook-dispatch-sequence.md.
//
// `DEFAULT_FRAME_BUDGET_MS` carries the 16 of js/animframe_polyfill.js L13,
// `Math.max(0, 16 - (currTime - lastTime))`.
//
// `performance` is invoked nowhere in the retired sources, so every call to it
// here is an addition rather than a port.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
// this module's area enumerated:
//   TR-TRACE-01  js/html_actuator.js L13       the frame `actuate` wrapped
//                                              every DOM write in
//   TR-TRACE-02  js/html_actuator.js L69       the nested frame inside
//                                              `addTile`
//   TR-TRACE-03  js/application.js L2          the frame construction was
//                                              deferred to
//   TR-TRACE-04  js/animframe_polyfill.js L13  the 16ms budget, carried as
//                                              `DEFAULT_FRAME_BUDGET_MS`
//   TR-TRACE-05  js/game_manager.js L130,      the turn boundary, where the
//                L91-L97                       turn span opens and closes
//   TR-TRACE-06  js/keyboard_input_manager.js  the appended listener array
//                L18-L23                       `attachEngineTracing` attaches
//                                              through
//   TR-TRACE-07  target-only row               the span vocabulary,
//                                              `SPAN_NAMES`, `SPAN_NAME_LIST`
//                                              and `BOUNDARY_SPAN_NAMES`
//   TR-TRACE-08  target-only row               the bounded span-record buffer
//   TR-TRACE-09  target-only row               the parent stack and the span
//                                              identifier
//   TR-TRACE-10  target-only row               `createBoundaryTracing` and the
//                                              boundary helpers
//
// Decisions behind this file, argued in docs/DECISION_LOG.md and named here
// only so the construct can be found from the log:
//   DL-TRACE-01  module boundaries as the traced boundaries
//   DL-TRACE-02  the span identifier composed from a counter and the
//                correlation identifier
//   DL-TRACE-03  span durations recorded into the metrics histograms
//   DL-TRACE-04  merge and spawn recorded as span events
//   DL-TRACE-05  the closed span vocabulary bounding the histogram's series
//   DL-TRACE-06  over-budget frames counted on the tracer's own snapshot
//   DL-TRACE-07  marks and measures cleared as each span closes
//   DL-TRACE-08  turn latency recorded on commit alone
//   DL-TRACE-09  frame spans opened as roots
//   DL-TRACE-10  `performance` re-read per call
//   DL-TRACE-11  a commit arriving with no turn span open ACCOUNTED — against
//                the lifecycle path that armed it, or against the stage span it
//                itself opened — rather than reported as an orphan anomaly
//   DL-TRACE-12  the stage span opened off the parent stack, and a span handle
//                retained across `reset()` invalidated rather than reusable
//
// Imports are type-only apart from `serializeError`. The module names no
// package, reads no DOM node and writes to no global: `performance` is reached
// through `globalThis` behind a guard on every member it uses. Exported members
// report rather than throw, and the two that wrap a caller's function rethrow
// what that function threw.

import type {
  EngineEventListener,
  EngineEventName,
  EngineEventSubscription,
  StateCommitEvent,
} from '../engine/engine-events';
import type { HookName } from '../engine/hooks';
import type { CorrelationId, CorrelationSource } from '../engine/types';
import type { LogFields, Logger, SerializedError } from './logger';
import { serializeError } from './logger';
import type { MetricsRegistry } from './metrics';

/* ==========================================================================
 * 1. Span vocabulary
 * ========================================================================== */

/**
 * Every span name, frozen and the single declaration of each.
 *
 * The seven boundary names are the chain validation gate V8 requires trace
 * coverage of — input, engine turn, move resolution, hook dispatch, relic
 * handler, render commit and the frame callback — plus `engineStage` for the
 * stage a run's turns sit inside, and `inert` for the shared span
 * `Tracer.startSpan` returns while tracing is disabled.
 *
 * Decision DL-TRACE-05.
 */
export const SPAN_NAMES = Object.freeze({
  /** One input dispatch: a key, a gesture, or an on-screen control. */
  inputDispatch: 'input.dispatch',

  /**
   * One turn, `move:before` through `state:commit`. The boundary
   * js/game_manager.js L130 opened and L91-L97 closed.
   */
  engineTurn: 'engine.turn',

  /** The traversal walk and merge resolution within one turn. */
  moveResolution: 'engine.move.resolve',

  /** One stage, `stage:start` through `stage:end`. */
  engineStage: 'engine.stage',

  /**
   * One hook dispatch. Attributed to a hook by `SPAN_ATTRIBUTES.hook` rather
   * than by a name per hook.
   */
  hookDispatch: 'hook.dispatch',

  /**
   * One relic handler invocation. Attributed to a relic by
   * `SPAN_ATTRIBUTES.relic`.
   */
  relicHandler: 'relic.handler',

  /** One renderer commit. */
  renderCommit: 'render.commit',

  /**
   * One frame callback. The successor of the rAF sites at
   * js/html_actuator.js L13 and L69 and js/application.js L2.
   */
  frameCallback: 'render.frame',

  /** The shared span returned while tracing is disabled. */
  inert: 'tracer.inert',
} as const);

/** One of the names `SPAN_NAMES` declares. */
export type SpanName = (typeof SPAN_NAMES)[keyof typeof SPAN_NAMES];

/** Every span name, in declaration order. */
export const SPAN_NAME_LIST: readonly SpanName[] = Object.freeze([
  SPAN_NAMES.inputDispatch,
  SPAN_NAMES.engineTurn,
  SPAN_NAMES.moveResolution,
  SPAN_NAMES.engineStage,
  SPAN_NAMES.hookDispatch,
  SPAN_NAMES.relicHandler,
  SPAN_NAMES.renderCommit,
  SPAN_NAMES.frameCallback,
  SPAN_NAMES.inert,
]);

/**
 * The module-boundary chain, in the order one turn reaches it, and the list
 * validation gate V8 is asserted against. The chain is drawn as a named Mermaid
 * figure in docs/architecture/hook-dispatch-sequence.md.
 */
export const BOUNDARY_SPAN_NAMES: readonly SpanName[] = Object.freeze([
  SPAN_NAMES.inputDispatch,
  SPAN_NAMES.engineTurn,
  SPAN_NAMES.moveResolution,
  SPAN_NAMES.hookDispatch,
  SPAN_NAMES.relicHandler,
  SPAN_NAMES.renderCommit,
  SPAN_NAMES.frameCallback,
]);

/**
 * Narrows an arbitrary value to a declared span name.
 *
 * @param value Value to test.
 * @returns `true` when `value` is one of `SPAN_NAME_LIST`.
 */
export function isSpanName(value: unknown): value is SpanName {
  return (
    typeof value === 'string' &&
    SPAN_NAME_LIST.includes(value as SpanName)
  );
}

/**
 * Every attribute key a span carries, frozen. `hook` and `relic` are the two
 * dimensions the chain's per-hook and per-relic spans are attributed by.
 */
export const SPAN_ATTRIBUTES = Object.freeze({
  hook: 'hook',
  relic: 'relic',
  action: 'action',
  direction: 'direction',
  cancelled: 'cancelled',
  moved: 'moved',
  outcome: 'outcome',
  merges: 'merges',
  spawns: 'spawns',
  score: 'score',
  over: 'over',
  won: 'won',
  terminated: 'terminated',
  stageIndex: 'stageIndex',
  boardSize: 'boardSize',
  cleared: 'cleared',
  frame: 'frame',
  overBudget: 'overBudget',
  budgetMs: 'budgetMs',
  resultValue: 'resultValue',
  scoreDelta: 'scoreDelta',
  value: 'value',
  inserted: 'inserted',
  failed: 'failed',
  unwound: 'unwound',

  /** Which of `COMMIT_PHASES` a commit with no turn span open belongs to. */
  phase: 'phase',

  /** Commits the turn observed: one for a turn, two where a stage resolved. */
  commits: 'commits',
} as const);

/**
 * Every outcome a span closes with, frozen.
 *
 * `committed` is the turn that reached `state:commit`, `cancelled` the move the
 * engine withdrew, `unmoved` the move whose position comparison changed
 * nothing, `blocked` the move src/engine/engine.ts L965-L976 refused because
 * play is terminated, which emits no event at all, `failed` the move whose call
 * threw, `superseded` the span a later span of the same kind replaced,
 * `unwound` the span closed by its parent closing first, and `detached` the
 * span open when tracing was detached.
 */
export const SPAN_OUTCOMES = Object.freeze({
  committed: 'committed',
  cancelled: 'cancelled',
  unmoved: 'unmoved',
  blocked: 'blocked',
  failed: 'failed',
  superseded: 'superseded',
  unwound: 'unwound',
  detached: 'detached',
} as const);

/**
 * Every phase a `state:commit` arriving with no turn span open belongs to,
 * frozen.
 *
 * The four commit paths of src/engine/engine.ts that carry no move: `setup`
 * for the commit L866 ends stage initialisation with, which `restart()` reaches
 * through `setup()` too; `stage` for the commit `endStage()` makes at L1218
 * after emitting `stage:end`, including the nested one the run controller
 * triggers from inside a turn's own commit; and `continue` for the commit
 * `continuePlaying()` makes at L893. `unknown` is the commit none of the three
 * markers accounts for.
 */
export const COMMIT_PHASES = Object.freeze({
  setup: 'setup',
  stage: 'stage',
  continue: 'continue',
  unknown: 'unknown',
} as const);

/** One of the phases `COMMIT_PHASES` declares. */
export type CommitPhase = (typeof COMMIT_PHASES)[keyof typeof COMMIT_PHASES];

/** One of the outcomes `SPAN_OUTCOMES` declares. */
export type SpanOutcome = (typeof SPAN_OUTCOMES)[keyof typeof SPAN_OUTCOMES];

/**
 * Which path a requested move took, as `EngineTracingSubscription.settleMove`
 * receives it.
 *
 * The four of `MoveResolution` in src/engine/engine.ts, which `Engine.attemptMove`
 * reports and which this type is satisfied by structurally — src/engine imports
 * nothing from here — plus `'failed'`, which only the CALLER can report: an
 * attempt that threw returned no outcome at all.
 */
export type FinalMoveResolution =
  | 'blocked'
  | 'cancelled'
  | 'idle'
  | 'moved'
  | 'failed';

/** The outcome of one whole move attempt, as a caller reports it. */
export interface FinalMoveResult {
  /** Which path the attempt took. */
  readonly resolution: FinalMoveResolution;
}

/**
 * The span outcome each move path closes its turn span under.
 *
 * A committed turn has already closed its own span by the time a caller settles,
 * so `'moved'` maps to the outcome that turn was closed under and settling it is
 * a no-op.
 */
const MOVE_SPAN_OUTCOMES: Readonly<Record<FinalMoveResolution, SpanOutcome>> =
  Object.freeze({
    blocked: SPAN_OUTCOMES.blocked,
    cancelled: SPAN_OUTCOMES.cancelled,
    idle: SPAN_OUTCOMES.unmoved,
    moved: SPAN_OUTCOMES.committed,
    failed: SPAN_OUTCOMES.failed,
  });

/**
 * The value `settledStageIndex` carries while no closed stage span is standing.
 *
 * `null` rather than a number, because stage indices are non-negative whole
 * numbers and `null` is already what "no stage" means in this module.
 */
const NO_SETTLED_STAGE: number | null = null;

/**
 * The engine paths that commit outside a turn, as the `path` field of the
 * record each is reported under.
 *
 * Named after the emission that precedes the commit rather than after the
 * method that makes it, because the emission is what this module observes.
 */
export const UNTRACED_COMMIT_PATHS = Object.freeze({
  /** `setup()`: emits `stage:start`, then commits. */
  stageStart: 'stage:start',

  /** `endStage()`: emits `stage:end`, then commits. */
  stageEnd: 'stage:end',
} as const);

/** One of the paths `UNTRACED_COMMIT_PATHS` declares. */
export type UntracedCommitPath =
  (typeof UNTRACED_COMMIT_PATHS)[keyof typeof UNTRACED_COMMIT_PATHS];

/**
 * How a `state:commit` is attributed.
 *
 * `turn` is a commit that closed an open turn span. `lifecycle` is a commit
 * src/engine/engine.ts makes outside a move and this module can attribute: the
 * commit `setup()` makes after emitting `stage:start`, the one `restart()`
 * makes through `setup()`, the one `resolveMetStageGoal()` makes after emitting
 * `stage:end`, and the one a method reached through the input boundary makes
 * while that boundary's span is open — `continuePlaying()`, which
 * js/game_manager.js L11 bound the `keepPlaying` event to. `unattributed` is
 * every other commit: `state:commit` carries no commit source — AAP 0.6.1.1
 * fixes its members — so a lifecycle commit made outside those four cases and
 * a commit no engine method produced are one bucket.
 *
 * None of the three is an anomaly.
 */
export const COMMIT_ATTRIBUTIONS = Object.freeze({
  turn: 'turn',
  lifecycle: 'lifecycle',
  unattributed: 'unattributed',
} as const);

/** One of the attributions `COMMIT_ATTRIBUTIONS` declares. */
export type CommitAttribution =
  (typeof COMMIT_ATTRIBUTIONS)[keyof typeof COMMIT_ATTRIBUTIONS];

/** How many commits each attribution accounted for. */
export interface CommitTraceCounts {
  /** Commits that closed an open turn span. */
  readonly turn: number;

  /** Attributed non-turn commits. */
  readonly lifecycle: number;

  /** Commits neither a turn span nor an observed lifecycle signal explains. */
  readonly unattributed: number;
}

/**
 * Names of the span events a turn's internal detail is recorded as. The two
 * tile names are the engine event names they are taken from: a record reads in
 * the emitter's own vocabulary. Decision DL-TRACE-04.
 */
export const SPAN_EVENT_NAMES = Object.freeze({
  merge: 'tile:merge',
  spawn: 'tile:spawn',

  /**
   * A commit that belongs to a stage rather than to a turn, recorded on the
   * stage span.
   *
   * `Engine` commits from five paths and only one of them is a turn: `setup()` —
   * which is the commit js/game_manager.js L59 made before any move —
   * `continuePlaying()`, `endStage()`, `startStage()` and `restart()` each commit
   * outside any move. Naming the occurrence lets it be recorded where it happened
   * rather than reported as an anomaly.
   */
  stageCommit: 'state:commit',
  error: 'error',

  /**
   * A `state:commit` that arrived with no turn span open, recorded on the open
   * stage span and attributed by `SPAN_ATTRIBUTES.phase`.
   */
  commit: 'state:commit',
} as const);

/**
 * The frame budget in milliseconds, from js/animframe_polyfill.js L13's
 * `Math.max(0, 16 - (currTime - lastTime))`, and the boundary
 * `DEFAULT_DURATION_BUCKETS` of src/observability/metrics.ts also carries.
 */
export const DEFAULT_FRAME_BUDGET_MS = 16;

/** Span records a tracer retains where the caller sets no capacity. */
export const DEFAULT_TRACE_CAPACITY = 200;

/** Version of the `TraceSnapshot` shape. */
export const TRACE_SNAPSHOT_SCHEMA_VERSION = 1;

const MIN_TRACE_CAPACITY = 1;

const MAX_TRACE_CAPACITY = 5000;

const MAX_SPAN_ATTRIBUTES = 32;

const MAX_SPAN_EVENTS = 32;

const MAX_ATTRIBUTE_CHARS = 200;

/** Subsystem tag every record this module emits is written under. */
const TRACER_SUBSYSTEM = 'tracer';

/** Prefix every mark and measure name carries. */
const MARK_PREFIX = 'game2048.span:';

const SPAN_ID_SEPARATOR = '#';

const START_MARK_SUFFIX = '/start';

const END_MARK_SUFFIX = '/end';

/* ==========================================================================
 * 2. Span, record and snapshot shapes
 * ========================================================================== */

/**
 * A value an attribute may carry. A subset of `LogFieldValue` of
 * src/observability/logger.ts: an attribute bag reaches a log record unchanged
 * and survives `JSON.stringify` unaltered.
 */
export type SpanAttributeValue = string | number | boolean | null;

/** The attribute bag a span and a span event carry. */
export interface SpanAttributes {
  readonly [key: string]: SpanAttributeValue;
}

/** One event recorded on a span rather than as a span of its own. */
export interface SpanEvent {
  /** Name of the event, from `SPAN_EVENT_NAMES` or a caller's own. */
  readonly name: string;

  /** Clock reading at which the event was added. */
  readonly timestamp: number;

  /** Attributes the event carries, absent when it carries none. */
  readonly attributes?: SpanAttributes;
}

/**
 * One open span.
 *
 * Every member reports rather than throws: an attribute set after `end`, an
 * event added after `end`, and a second `end` are each recorded as an anomaly
 * and otherwise ignored.
 */
export interface Span {
  /** Name this span was opened under. */
  readonly name: SpanName;

  /**
   * Identifier of this span: the correlation identifier, a separator, and this
   * tracer's span counter. Empty on the inert span. Decision DL-TRACE-02.
   */
  readonly id: string;

  /** Identifier of the enclosing span, absent on a root span. */
  readonly parentId: string | undefined;

  /** Clock reading at which the span was opened. */
  readonly startTime: number;

  /** Whether the span has been closed. */
  readonly ended: boolean;

  /**
   * Sets one attribute, replacing any value already held under `key`.
   *
   * @param key Attribute name, ideally one of `SPAN_ATTRIBUTES`.
   * @param value Attribute value.
   */
  setAttribute(key: string, value: SpanAttributeValue): void;

  /**
   * Adds one event to the span.
   *
   * @param name Event name.
   * @param attributes Attributes the event carries.
   */
  addEvent(name: string, attributes?: SpanAttributes): void;

  /**
   * Records a caught value on the span. The first value recorded is kept; a
   * later one is ignored. The span is not closed by this call and the value is
   * not rethrown.
   *
   * @param thrown The caught value, serialised by `serializeError` of
   *   src/observability/logger.ts.
   */
  recordError(thrown: unknown): void;

  /**
   * Closes the span, records its duration into the span-duration histogram of
   * src/observability/metrics.ts, and files the completed `SpanRecord`.
   *
   * @param attributes Attributes applied as the span closes.
   */
  end(attributes?: SpanAttributes): void;
}

/**
 * One closed span, as `Tracer.recent` and `Tracer.snapshot` carry it. Plain
 * frozen data: a record round-trips through
 * `JSON.parse(JSON.stringify(record))` unchanged.
 */
export interface SpanRecord {
  readonly name: SpanName;
  readonly id: string;
  readonly parentId: string | undefined;
  readonly startTime: number;

  /** Duration in milliseconds. Never negative. */
  readonly durationMs: number;
  readonly attributes: SpanAttributes;

  /** Events recorded on the span, in the order they were added. */
  readonly events: readonly SpanEvent[];

  /**
   * Correlation identifier of the run, as `Logger.correlationId` carries it.
   */
  readonly correlationId: string;

  /** The caught value, absent when the span recorded none. */
  readonly error?: SerializedError;

  /** Attributes refused for exceeding the per-span bound. */
  readonly droppedAttributes: number;

  /** Events refused for exceeding the per-span bound. */
  readonly droppedEvents: number;
}

/** What one instrumented frame contributed, summed over the tracer's life. */
export interface FrameTraceStats {
  /** Frames measured through `instrumentFrameCallback` or the frame hooks. */
  readonly frames: number;

  /** Frames whose duration exceeded `budgetMs`. Decision DL-TRACE-06. */
  readonly overBudgetFrames: number;

  /** The budget those frames were classified against, in milliseconds. */
  readonly budgetMs: number;

  /** Duration of the most recent frame, in milliseconds. */
  readonly lastFrameMs: number;

  /** Longest frame measured, in milliseconds. */
  readonly maxFrameMs: number;

  /** Every measured frame's duration summed, in milliseconds. */
  readonly totalFrameMs: number;
}

/**
 * The whole tracer as plain frozen data, for the diagnostics surface to render
 * and for `JSON.stringify` to export.
 */
export interface TraceSnapshot {
  readonly schemaVersion: number;
  readonly correlationId: string;
  readonly enabled: boolean;

  /** Span records the buffer holds at most. */
  readonly capacity: number;

  /** Spans opened over the tracer's life. */
  readonly started: number;

  /** Spans closed over the tracer's life. */
  readonly ended: number;

  /** Spans open at the moment of the snapshot. */
  readonly open: number;

  /** Records evicted from the buffer to make room. */
  readonly dropped: number;

  /** Caught failures contained inside the tracer. */
  readonly faults: number;

  /**
   * Caller anomalies reported: a double end, a stage end with no stage open,
   * and the like.
   */
  readonly anomalies: number;

  /** Spans ended more than once. */
  readonly doubleEnds: number;

  /** Spans ended while a child of theirs was still open. */
  readonly outOfOrderEnds: number;

  /**
   * Spans discarded by `reset()` while still open, whose retained handles are
   * inert.
   */
  readonly discarded: number;

  /**
   * Commits observed with no turn span open: the setup, stage and continue
   * commits of src/engine/engine.ts, which are lifecycle commits rather than
   * anomalies. Counted by `attachEngineTracing` through
   * `recordLifecycleCommit`.
   */
  readonly lifecycleCommits: number;
  /** How the `state:commit` emissions seen were attributed. */
  readonly commits: CommitTraceCounts;
  readonly frames: FrameTraceStats;

  /** The retained records, oldest first. */
  readonly spans: readonly SpanRecord[];
}

/** Everything `Tracer` is constructed with. */
export interface TracerOptions {
  /**
   * Logger anomalies and contained failures are reported through. Tagged
   * `TRACER_SUBSYSTEM` by `child()` at construction.
   */
  readonly logger: Logger;

  /**
   * Registry span, turn and frame durations are recorded into. No duration is
   * stored a second time here. Decision DL-TRACE-03.
   */
  readonly metrics: MetricsRegistry;

  /**
   * Correlation identifier span identifiers are derived from. Defaults to
   * `logger.correlationId`, which `deriveCorrelationId` of
   * src/observability/logger.ts is the single authority for.
   *
   * A FUNCTION IS READ PER SPAN, so every span resolves the identifier at the
   * moment it is opened, and the default follows the injected logger, which
   * `Logger.setCorrelationId` rotates. A STRING PINS one identifier for the life
   * of the tracer, so a second run played without a reload would derive its span
   * identifiers from the first run's.
   */
  readonly correlationId?: CorrelationSource;

  /** Whether spans are opened at all. Defaults to `true`. */
  readonly enabled?: boolean;

  /**
   * Span records retained. Defaults to `DEFAULT_TRACE_CAPACITY` and is clamped
   * between `MIN_TRACE_CAPACITY` and `MAX_TRACE_CAPACITY`.
   */
  readonly capacity?: number;

  /**
   * Frame budget in milliseconds. Defaults to `DEFAULT_FRAME_BUDGET_MS`, the 16
   * of js/animframe_polyfill.js L13.
   */
  readonly frameBudgetMs?: number;

  /**
   * Whether `performance.mark` and `performance.measure` are written. Defaults
   * to `true`; marking is skipped anyway wherever the platform offers neither.
   */
  readonly marks?: boolean;
}

/** Everything `Tracer.startSpan` accepts besides the span name. */
export interface StartSpanOptions {
  /**
   * Enclosing span. Omitted, the innermost open span encloses the new one;
   * `null` opens a root span whatever is open.
   */
  readonly parent?: Span | null;

  /** Attributes applied as the span opens. */
  readonly attributes?: SpanAttributes;

  /** Hook the span is attributed to, under `SPAN_ATTRIBUTES.hook`. */
  readonly hook?: HookName;

  /** Relic the span is attributed to, under `SPAN_ATTRIBUTES.relic`. */
  readonly relicId?: string;

  /**
   * Keeps the span OFF the implicit-parent stack, for a span whose lifetime is
   * event-driven rather than call-nested.
   *
   * WHY THIS EXISTS. The stack models one synchronous call nesting: a span
   * closing while a span above it is still open closes that one too, as
   * `unwound`, because a child cannot outlive its parent. A LIFECYCLE span —
   * opened by one event and closed by a different one many turns later, as the
   * stage span is — sits at the bottom of that stack for its whole life, and
   * closing it mid-turn would unwind whatever the current call happens to have
   * open: the turn being played, and the input dispatch that started it. Those
   * are not its children; they merely began after it.
   *
   * A detached span is still counted as open, still recorded when it closes and
   * still carries whatever parent it was given. It simply neither adopts the
   * spans opened after it nor is adopted by the span open when it began.
   * Defaults to `false`.
   *
   * The inverse of `stacked` below, which is the same decision stated the other
   * way round: either spelling opens the same span, and `detached: true` and
   * `stacked: false` are interchangeable. Decision DL-TRACE-12.
   */
  readonly detached?: boolean;

  /**
   * Whether the span joins the parent stack. Defaults to `true`.
   *
   * `false` opens a span that is neither the implicit parent of a span opened
   * inside it nor unwound by an enclosing span closing first — the shape a
   * span outliving many synchronous frames needs. `engine.stage` is opened this
   * way: a stage spans every turn of that stage, and closing it while a turn is
   * in flight must close the stage and nothing else. It is still counted among
   * the open spans. Decision DL-TRACE-12.
   */
  readonly stacked?: boolean;
}

/**
 * The one member of the engine's emitter this module uses: the append-only
 * registration of js/keyboard_input_manager.js L18-L23, preserved by
 * `EngineEvents` of src/engine/engine-events.ts, which satisfies this shape.
 *
 * Narrowed to `on`: tracing cannot emit an event or remove another
 * subscriber's listener.
 */
export interface EngineEventSource {
  on<K extends EngineEventName>(
    event: K,
    listener: EngineEventListener<K>,
  ): EngineEventSubscription;
}

/**
 * The handle `attachEngineTracing` returns.
 *
 * CALLABLE. Calling it detaches every listener and closes the turn and stage
 * spans it left open; calling it more than once detaches nothing further and
 * throws nothing.
 */
export interface EngineTracingSubscription {
  /** Detaches every listener and closes whatever span is still open. */
  (): void;

  /**
   * Closes an open turn span that will never commit, as an IDLE turn.
   *
   * WHY A CALLER HAS TO SAY SO. A turn span opens on `move:before` and closes
   * on `state:commit`. A move the resolver found changed nothing commits
   * nothing and — unlike a withdrawn move, which reports itself through
   * `cancelled`, and unlike a resolved move, which emits `move:after` — emits
   * NO further event at all: `Engine.move()` counts it and returns `false`. The
   * span would therefore stay open until the next input arrived and would
   * measure the player's think time as turn latency.
   *
   * The engine cannot close it without emitting `move:after` for a move that
   * did not happen, which five other subscribers would act on — the announcer
   * would narrate it and the renderer would animate it. So the caller that
   * KNOWS the move was idle, because `move()` returned `false`, closes it here.
   *
   * A MOVE WITHDRAWN BY AN `onBeforeMove` HANDLER ARRIVES HERE TOO. A veto a
   * LISTENER cast is already on the emitted payload, so the `move:before`
   * listener above closes that turn as `cancelled` on the spot. A veto a HOOK
   * HANDLER cast is resolved after the emission and, like an idle move, ends
   * the turn with no further event, so from the caller's side the two are one:
   * `move()` returned `false` with a span open. Both are closed here, and the
   * span's `direction` attribute plus the `engine.move.cancelled` counter are
   * what separate them afterwards.
   *
   * Safe to call when no turn span is open, after detaching, and repeatedly:
   * each does nothing. A move refused because the game is already over opens no
   * span at all, so the call is a no-op there.
   */
  closeIdleTurn(): void;

  /**
   * Closes the turn span an attempt left open, under an outcome of the caller's
   * choosing, and reports whether there was one.
   *
   * The general form of `closeIdleTurn`, which is this called with the default
   * outcome. A caller that has the `move()` return value — the composition root —
   * closes an idle attempt through either.
   *
   * @param outcome Outcome to close the span under; `'unmoved'` by default,
   *   which is the outcome an idle attempt has.
   * @returns `true` when a span was open and has been closed, and `false` when
   *   there was none — after a committed turn, or once detached.
   */
  readonly settleTurn: (outcome?: SpanOutcome) => boolean;

  /**
   * Closes an open turn span under the outcome the WHOLE ATTEMPT had.
   *
   * The form a caller holding `Engine.attemptMove()`'s outcome uses, and the one
   * that classifies correctly: `settleTurn()`'s default reports every unresolved
   * attempt as an idle turn, so a move an `onBeforeMove` handler withdrew, a
   * move refused because the game is already over, and an attempt that threw
   * were all recorded as the player having pressed into a wall.
   *
   * Safe on every path: a committed turn has already closed its own span and a
   * blocked move opened none, so both are no-ops.
   *
   * @param result The attempt's outcome. `'failed'` is the caller's to report —
   *   an attempt that threw returned no outcome at all.
   * @returns `true` when a span was open and has been closed.
   */
  readonly settleMove: (result: FinalMoveResult) => boolean;

  /**
   * The turn span open right now, or `undefined` between turns.
   *
   * Read by a caller that opens a span of its own for work belonging to the
   * turn — the renderer's `render.commit` — so the parent link is EXPLICIT
   * rather than inherited from the implicit-parent stack, which depends on the
   * order listeners happen to be registered in.
   */
  readonly currentTurnSpan: () => Span | undefined;

  /**
   * Moves this subscription's `state:commit` listener to the end of the
   * emitter's registration order.
   *
   * That listener CLOSES the turn span, and listeners run in registration order,
   * so any listener registered after this subscription was attached ran with the
   * turn already closed. A caller subscribing a renderer — at boot, and again
   * whenever the renderer is swapped — calls this afterwards, so the turn is
   * closed last. Does nothing once detached.
   */
  readonly reattachCommitClosing: () => void;
}

/**
 * The `onFrameBegin`/`onFrameEnd` pair src/render/render-loop.ts accepts,
 * filled by `Tracer.frameLifecycleHooks`.
 */
export interface FrameLifecycleHooks {
  readonly onFrameBegin: (context?: unknown) => void;
  readonly onFrameEnd: (context: unknown, durationMs: number) => void;
}

/**
 * One wrapper per module boundary of the chain validation gate V8 names, each
 * running a synchronous function inside its span and rethrowing whatever that
 * function threw.
 */
export interface BoundaryTracing {
  readonly traceInput: <T>(action: string, run: () => T) => T;
  readonly traceMoveResolution: <T>(run: () => T) => T;
  readonly traceHookDispatch: <T>(hook: HookName, run: () => T) => T;
  readonly traceRelicHandler: <T>(
    hook: HookName,
    relicId: string,
    run: () => T,
  ) => T;
  /**
   * Wraps a renderer's `state:commit` reconciliation.
   *
   * @param run The reconciliation to measure.
   * @param parent The turn span the commit belongs to, where the caller has it.
   *   Passed EXPLICITLY, because the implicit-parent stack depends on listener
   *   registration order and the listener that closes the turn span is another
   *   listener of the same event.
   */
  readonly traceRenderCommit: <T>(run: () => T, parent?: Span | null) => T;
}

/* ==========================================================================
 * 3. Guarded platform access
 * ========================================================================== */

// `performance` is read off `globalThis` on every call and never cached: a
// host that gains or loses it — a Vitest run with no DOM, a suite that stubs
// it — is followed. Each member is guarded independently: `now` may exist
// where `mark` does not, and either may throw. Decision DL-TRACE-10.

function readGlobalPerformance(): object | null {
  try {
    const host: unknown = (globalThis as { performance?: unknown })
      .performance;

    return typeof host === 'object' && host !== null ? host : null;
  } catch {
    return null;
  }
}

function readMember(host: object, key: string): unknown {
  try {
    return (host as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function fallbackNow(): number {
  try {
    return Date.now();
  } catch {
    return 0;
  }
}

/**
 * Reads the millisecond clock.
 *
 * @returns `performance.now()` where it is callable and returns a finite
 *   number, otherwise `Date.now()`, otherwise `0`.
 */
function readNow(): number {
  const host = readGlobalPerformance();

  if (host !== null) {
    const now = readMember(host, 'now');

    if (typeof now === 'function') {
      try {
        const reading: unknown = (now as () => unknown).call(host);

        if (typeof reading === 'number' && Number.isFinite(reading)) {
          return reading;
        }
      } catch {
        return fallbackNow();
      }
    }
  }

  return fallbackNow();
}

/**
 * Calls one member of `performance` for its effect.
 *
 * @param key Member to call.
 * @param args Arguments to call it with.
 * @returns `true` when the member was callable and did not throw.
 */
function callPerformanceMember(
  key: string,
  args: readonly unknown[],
): boolean {
  const host = readGlobalPerformance();

  if (host === null) {
    return false;
  }

  const member = readMember(host, key);

  if (typeof member !== 'function') {
    return false;
  }

  try {
    (member as (...rest: unknown[]) => unknown).apply(host, [...args]);

    return true;
  } catch {
    return false;
  }
}

function writeMark(name: string): boolean {
  return callPerformanceMember('mark', [name]);
}

function writeMeasure(
  name: string,
  startMark: string,
  endMark: string,
): boolean {
  return callPerformanceMember('measure', [name, startMark, endMark]);
}

function clearMark(name: string): void {
  callPerformanceMember('clearMarks', [name]);
}

function clearMeasure(name: string): void {
  callPerformanceMember('clearMeasures', [name]);
}

function boundText(text: string): string {
  return text.length <= MAX_ATTRIBUTE_CHARS
    ? text
    : text.slice(0, MAX_ATTRIBUTE_CHARS);
}

/**
 * Narrows a value to one an attribute may carry, bounding a string's length.
 *
 * @param value Value to normalise.
 * @returns The value, or `undefined` when an attribute cannot carry it.
 */
function normaliseAttribute(value: unknown): SpanAttributeValue | undefined {
  if (typeof value === 'string') {
    return boundText(value);
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === 'boolean' || value === null) {
    return value;
  }

  return undefined;
}

/* ==========================================================================
 * 4. The open span
 * ========================================================================== */

/**
 * The two operations an open span needs from the tracer that opened it. One
 * frozen instance per tracer: a span carries a reference to it and not a
 * closure per member.
 */
interface SpanHost {
  readonly finish: (
    span: LiveSpan,
    attributes: SpanAttributes | undefined,
    durationMs: number | undefined,
  ) => number;
  readonly anomaly: (message: string, fields: LogFields) => void;
}

class LiveSpan implements Span {
  readonly name: SpanName;

  readonly id: string;

  /**
   * Correlation identifier resolved when the span OPENED, and the same value
   * `id` was built from.
   *
   * Carried on the span rather than read again at close, so a span opened in
   * one run and closed after a second run rotated the scope files its record
   * under the run that opened it and cannot disagree with its own identifier.
   */
  readonly correlationId: string;

  readonly parentId: string | undefined;

  readonly startTime: number;

  /** Mark written as the span opened, absent where marking was unavailable. */
  readonly startMark: string | undefined;

  /** Whether the span joined the parent stack. */
  readonly stacked: boolean;

  readonly attributes: Record<string, SpanAttributeValue> =
    Object.create(null) as Record<string, SpanAttributeValue>;

  readonly events: SpanEvent[] = [];

  attributeCount = 0;

  error: SerializedError | undefined = undefined;

  ended = false;

  /**
   * Whether `Tracer.reset()` discarded this span while it was still open.
   *
   * An invalidated span files no record, writes no duration and accepts no
   * further attribute or event, so a handle a caller retained across a reset
   * cannot reappear under an identifier the restarted counter has reissued.
   */
  invalidated = false;

  droppedAttributes = 0;

  droppedEvents = 0;

  private readonly host: SpanHost;

  constructor(
    host: SpanHost,
    name: SpanName,
    id: string,
    correlationId: string,
    parentId: string | undefined,
    startTime: number,
    startMark: string | undefined,
    stacked: boolean,
  ) {
    this.host = host;
    this.name = name;
    this.id = id;
    this.correlationId = correlationId;
    this.parentId = parentId;
    this.startTime = startTime;
    this.startMark = startMark;
    this.stacked = stacked;
  }

  /**
   * Marks the span discarded: closed, invalidated, and never to be recorded.
   *
   * Called by `Tracer.reset()` alone, for every span the stack still held. The
   * span's own marks are cleared by the caller, which owns the platform access.
   */
  discard(): void {
    this.invalidated = true;
    this.ended = true;
  }

  setAttribute(key: string, value: SpanAttributeValue): void {
    if (this.invalidated) {
      return;
    }

    if (this.ended) {
      this.host.anomaly('attribute set on a closed span', {
        span: this.name,
        spanId: this.id,
        attribute: typeof key === 'string' ? boundText(key) : '',
      });

      return;
    }

    this.write(key, value);
  }

  /**
   * Applies a bag of attributes. The path `startSpan` and `end` both take, so
   * a rejected member is counted the same way from either.
   */
  applyAttributes(attributes: SpanAttributes | undefined): void {
    if (attributes === undefined || attributes === null) {
      return;
    }

    for (const key of Object.keys(attributes)) {
      this.write(key, attributes[key]);
    }
  }

  private write(key: string, value: SpanAttributeValue | undefined): void {
    if (typeof key !== 'string' || key.length === 0) {
      this.droppedAttributes += 1;

      return;
    }

    const normalised = normaliseAttribute(value);

    if (normalised === undefined) {
      this.droppedAttributes += 1;

      return;
    }

    const held = Object.prototype.hasOwnProperty.call(this.attributes, key);

    if (!held && this.attributeCount >= MAX_SPAN_ATTRIBUTES) {
      this.droppedAttributes += 1;

      return;
    }

    if (!held) {
      this.attributeCount += 1;
    }

    this.attributes[boundText(key)] = normalised;
  }

  addEvent(name: string, attributes?: SpanAttributes): void {
    if (this.invalidated) {
      return;
    }

    if (this.ended) {
      this.host.anomaly('event added to a closed span', {
        span: this.name,
        spanId: this.id,
        event: typeof name === 'string' ? boundText(name) : '',
      });

      return;
    }

    if (typeof name !== 'string' || name.length === 0) {
      this.droppedEvents += 1;

      return;
    }

    if (this.events.length >= MAX_SPAN_EVENTS) {
      this.droppedEvents += 1;

      return;
    }

    const carried = normaliseAttributes(attributes);
    const base = { name: boundText(name), timestamp: readNow() };

    this.events.push(
      Object.freeze(
        carried === undefined ? base : { ...base, attributes: carried },
      ),
    );
  }

  recordError(thrown: unknown): void {
    if (this.invalidated || this.error !== undefined) {
      return;
    }

    try {
      this.error = serializeError(thrown);
    } catch {
      this.error = Object.freeze({
        name: 'Error',
        message: 'unserialisable',
      });
    }

    this.write(SPAN_ATTRIBUTES.failed, true);
  }

  end(attributes?: SpanAttributes): void {
    this.host.finish(this, attributes, undefined);
  }

  /**
   * Renders the closed span as plain frozen data.
   *
   * @param correlationId Identifier the record carries.
   * @param durationMs Duration the record carries.
   * @returns The record.
   */
  toRecord(correlationId: string, durationMs: number): SpanRecord {
    const base = {
      name: this.name,
      id: this.id,
      parentId: this.parentId,
      startTime: this.startTime,
      durationMs,
      attributes: Object.freeze({ ...this.attributes }) as SpanAttributes,
      events: Object.freeze([...this.events]) as readonly SpanEvent[],
      correlationId,
      droppedAttributes: this.droppedAttributes,
      droppedEvents: this.droppedEvents,
    };

    return Object.freeze(
      this.error === undefined ? base : { ...base, error: this.error },
    );
  }
}

/**
 * Copies an attribute bag onto a frozen object, dropping every member an
 * attribute cannot carry.
 *
 * @param attributes Bag to copy.
 * @returns The frozen copy, or `undefined` when nothing survived.
 */
function normaliseAttributes(
  attributes: SpanAttributes | undefined,
): SpanAttributes | undefined {
  if (attributes === undefined || attributes === null) {
    return undefined;
  }

  const copy: Record<string, SpanAttributeValue> = {};
  let held = 0;

  for (const key of Object.keys(attributes)) {
    if (held >= MAX_SPAN_ATTRIBUTES) {
      break;
    }

    const normalised = normaliseAttribute(attributes[key]);

    if (normalised !== undefined) {
      copy[boundText(key)] = normalised;
      held += 1;
    }
  }

  return held === 0 ? undefined : (Object.freeze(copy) as SpanAttributes);
}

/**
 * The shared span `Tracer.startSpan` returns while tracing is disabled. Frozen,
 * already closed, and allocating nothing per call.
 */
export const INERT_SPAN: Span = Object.freeze({
  name: SPAN_NAMES.inert,
  id: '',
  parentId: undefined,
  startTime: 0,
  ended: true,
  setAttribute(): void {
    return;
  },
  addEvent(): void {
    return;
  },
  recordError(): void {
    return;
  },
  end(): void {
    return;
  },
});

/* ==========================================================================
 * 5. The tracer
 * ========================================================================== */

function clampCapacity(capacity: number | undefined): number {
  if (
    capacity === undefined ||
    typeof capacity !== 'number' ||
    !Number.isFinite(capacity)
  ) {
    return DEFAULT_TRACE_CAPACITY;
  }

  const floored = Math.floor(capacity);

  if (floored < MIN_TRACE_CAPACITY) {
    return MIN_TRACE_CAPACITY;
  }

  return floored > MAX_TRACE_CAPACITY ? MAX_TRACE_CAPACITY : floored;
}

function clampBudget(budget: number | undefined): number {
  if (
    budget === undefined ||
    typeof budget !== 'number' ||
    !Number.isFinite(budget) ||
    budget <= 0
  ) {
    return DEFAULT_FRAME_BUDGET_MS;
  }

  return budget;
}

/**
 * Reads a logger's correlation identifier without letting it throw.
 *
 * @param logger Logger to read.
 * @returns The identifier, or the empty string where none could be read.
 */
function readLoggerCorrelation(logger: Logger): string {
  try {
    const read: unknown = logger.correlationId;

    return typeof read === 'string' ? read : '';
  } catch {
    return '';
  }
}

/**
 * Performance-API spans across the module boundaries of the chain validation
 * gate V8 names, plus the frame-callback seam.
 *
 * Span durations land in the histograms of src/observability/metrics.ts and in
 * a bounded ring buffer of `SpanRecord`s this class owns; no duration is stored
 * anywhere else. Decision DL-TRACE-03.
 *
 * @example
 * ```ts
 * const tracer = createTracer({ logger, metrics });
 * const detach = attachEngineTracing(events, tracer);
 * const onFrame = tracer.instrumentFrameCallback(renderOneFrame);
 * ```
 */
export class Tracer {
  /** Budget a frame is classified against, in milliseconds. */
  readonly frameBudgetMs: number;

  private readonly logger: Logger;

  /**
   * Reads the identifier every span and every snapshot carries.
   *
   * Resolved once from `TracerOptions.correlationId`: a pinned string, a shared
   * scope, or the logger's own identifier where neither was given.
   */
  private readonly readCorrelationId: () => string;

  private readonly metrics: MetricsRegistry;

  private readonly marksEnabled: boolean;

  private readonly buffer: (SpanRecord | undefined)[];

  /** Open spans, innermost last. */
  private readonly stack: LiveSpan[] = [];

  /**
   * Open spans that did not join the stack, so an enclosing span closing does
   * not unwind them. Counted among the open spans and discarded by `reset()`.
   */
  private readonly unstacked = new Set<LiveSpan>();

  private readonly host: SpanHost;

  private enabled: boolean;

  private nextIndex = 0;

  private stored = 0;

  private dropped = 0;

  private counter = 0;

  private startedSpans = 0;

  private endedSpans = 0;

  private faults = 0;

  private anomalies = 0;

  private doubleEnds = 0;

  private outOfOrderEnds = 0;

  private discarded = 0;

  private lifecycleCommits = 0;
  /** `state:commit` emissions accounted to each attribution. */
  private readonly commitCountsByAttribution: Record<
    CommitAttribution,
    number
  > = { turn: 0, lifecycle: 0, unattributed: 0 };

  private frames = 0;

  private overBudgetFrames = 0;

  private lastFrameMs = 0;

  private maxFrameMs = 0;

  private totalFrameMs = 0;

  /** The span `frameLifecycleHooks().onFrameBegin` left open. */
  private pendingFrameSpan: LiveSpan | undefined = undefined;

  private pendingFrameStart = 0;

  constructor(options: TracerOptions) {
    this.logger = options.logger.child(TRACER_SUBSYSTEM);
    this.metrics = options.metrics;
    // A READER, not a captured value. An injected non-empty identifier still
    // wins over the logger's, pinned for the life of the tracer where it is a
    // string; a function and an absent value both fall through to the shared
    // scope, which is the logger's own identifier, read through the total
    // `readLoggerCorrelation` so a logger that refuses the read cannot take a
    // span down.
    const scoped = this.logger;
    const source = options.correlationId;
    const fromLogger = (): string => readLoggerCorrelation(scoped);

    if (typeof source === 'function') {
      this.readCorrelationId = (): string => {
        try {
          const read: unknown = source();

          return typeof read === 'string' && read.length > 0
            ? read
            : fromLogger();
        } catch {
          return fromLogger();
        }
      };
    } else if (typeof source === 'string' && source.length > 0) {
      this.readCorrelationId = (): string => source;
    } else {
      this.readCorrelationId = fromLogger;
    }
    this.enabled = options.enabled !== false;
    this.marksEnabled = options.marks !== false;
    this.frameBudgetMs = clampBudget(options.frameBudgetMs);
    this.buffer = new Array<SpanRecord | undefined>(
      clampCapacity(options.capacity),
    ).fill(undefined);
    this.host = Object.freeze({
      finish: (
        span: LiveSpan,
        attributes: SpanAttributes | undefined,
        durationMs: number | undefined,
      ): number => this.finishSpan(span, attributes, durationMs),
      anomaly: (message: string, fields: LogFields): void => {
        this.reportAnomaly(message, fields);
      },
    });
  }

  /** Whether spans are being opened. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Turns span creation and every observation this tracer owns on or off.
   *
   * Disabled, `startSpan` returns `INERT_SPAN` and allocates nothing,
   * `instrumentFrameCallback` returns the callback it was given, and
   * `recordTurnLatency` observes nothing — so no series of
   * src/observability/metrics.ts this tracer writes moves while it is off. Work
   * the caller wrapped still runs; only the measurement stops. A span already
   * open when tracing is disabled still closes normally, and its duration is
   * observed with it.
   *
   * @param next Whether to open spans and take observations.
   */
  setEnabled(next: boolean): void {
    if (typeof next !== 'boolean') {
      this.reportAnomaly('enabled flag rejected', { received: typeof next });

      return;
    }

    this.enabled = next;
  }

  /**
   * Identifier every span of this tracer is keyed under.
   *
   * A GETTER, not a captured value: one page load can play more than one run,
   * and `Logger.setCorrelationId` rotating the run scope rotates this too, so
   * a snapshot taken in the second run is never keyed to the first. Decision
   * DL-TYPES-04.
   */
  get correlationId(): CorrelationId {
    return this.readCorrelationId();
  }

  /** Records the tracer retains at most. */
  get capacity(): number {
    return this.buffer.length;
  }

  /**
   * Spans open at this moment: those on the parent stack, and those opened with
   * `stacked: false`.
   *
   * @returns The count.
   */
  private openSpanCount(): number {
    return this.stack.length + this.unstacked.size;
  }

  /**
   * The innermost open span.
   *
   * @returns The span, or `undefined` when none is open.
   */
  activeSpan(): Span | undefined {
    return this.stack.length === 0
      ? undefined
      : this.stack[this.stack.length - 1];
  }

  /**
   * Whether a span of one name is open, at any depth of the stack.
   *
   * The query `attachEngineTracing` attributes a commit made inside the input
   * boundary with: `activeSpan()` alone answers only for the innermost span.
   *
   * @param name Span name to look for.
   * @returns `true` when a span of that name is open.
   */
  hasOpenSpan(name: SpanName): boolean {
    for (const span of this.stack) {
      if (span.name === name) {
        return true;
      }
    }

    return false;
  }

  /**
   * Opens a span.
   *
   * @param name Span name, one of `SPAN_NAMES`.
   * @param options Parent, attributes and the hook and relic dimensions.
   * @returns The open span, or `INERT_SPAN` when tracing is disabled, when the
   *   name is not a declared one, or when opening the span threw.
   */
  startSpan(name: SpanName, options: StartSpanOptions = {}): Span {
    if (!this.enabled) {
      return INERT_SPAN;
    }

    try {
      if (!isSpanName(name)) {
        this.reportAnomaly('span name rejected', {
          received: typeof name === 'string' ? boundText(name) : typeof name,
        });

        return INERT_SPAN;
      }

      this.counter += 1;

      // Resolved ONCE per span, and carried on it: the identifier the span is
      // keyed under is the one in force when it opened, whatever the scope has
      // rotated to by the time it closes.
      const correlationId = this.readCorrelationId();
      const id = `${correlationId}${SPAN_ID_SEPARATOR}${this.counter}`;
      const startMark = `${MARK_PREFIX}${id}${START_MARK_SUFFIX}`;
      const marked = this.marksEnabled && writeMark(startMark);
      // BOTH SPELLINGS, ONE REPRESENTATION. `detached: true` and
      // `stacked: false` are the same request, and every call site of either
      // reaches the `unstacked` set below.
      const stacked = options.stacked !== false && options.detached !== true;
      const span = new LiveSpan(
        this.host,
        name,
        id,
        correlationId,
        this.resolveParentId(options),
        readNow(),
        marked ? startMark : undefined,
        stacked,
      );

      span.applyAttributes(options.attributes);

      if (options.hook !== undefined) {
        span.setAttribute(SPAN_ATTRIBUTES.hook, options.hook);
      }

      if (options.relicId !== undefined) {
        span.setAttribute(SPAN_ATTRIBUTES.relic, options.relicId);
      }

      if (stacked) {
        this.stack.push(span);
      } else {
        // Off the stack, so this span neither adopts what opens after it nor is
        // unwound by what closes below it.
        this.unstacked.add(span);
      }

      this.startedSpans += 1;

      return span;
    } catch (thrown) {
      this.reportFailure('span could not be opened', thrown, {
        span: typeof name === 'string' ? boundText(name) : '',
      });

      return INERT_SPAN;
    }
  }

  /**
   * Runs a synchronous function inside a span.
   *
   * The span closes on every exit — a value returned, an early return, a throw
   * — and a throw is recorded on the span and RETHROWN unchanged: containing a
   * caller's failure is the hook bus's contract, not this one's.
   *
   * @param name Span name.
   * @param run The function, receiving the span it runs inside.
   * @param options Parent, attributes and the two dimensions.
   * @returns Whatever `run` returned.
   */
  withSpan<T>(
    name: SpanName,
    run: (span: Span) => T,
    options?: StartSpanOptions,
  ): T {
    const span = this.startSpan(name, options);

    try {
      return run(span);
    } catch (thrown) {
      span.recordError(thrown);

      throw thrown;
    } finally {
      span.end();
    }
  }

  /**
   * Records one turn's latency into the turn-latency histogram of
   * src/observability/metrics.ts. The boundary js/game_manager.js L130 opened
   * and L91-L97 closed. Decision DL-TRACE-08.
   *
   * Observes NOTHING while tracing is disabled: `setEnabled(false)` stops every
   * observation this tracer owns, not span creation alone, so a disabled tracer
   * leaves the histograms of src/observability/metrics.ts where they stood. The
   * caller's own work still runs — it is the measurement that stops.
   *
   * @param durationMs Latency in milliseconds.
   */
  recordTurnLatency(durationMs: number): void {
    if (!this.enabled) {
      return;
    }

    try {
      this.metrics.recordTurnLatency(durationMs);
    } catch (thrown) {
      this.reportFailure('turn latency could not be recorded', thrown, {
        durationMs: Number.isFinite(durationMs) ? durationMs : 0,
      });
    }
  }

  /**
   * Records something worth seeing that is nonetheless correct, at debug level
   * and without counting against `anomalies`.
   *
   * Separate from `reportAnomaly` because the two answer different questions.
   * An anomaly is a condition that should not arise; this is one the engine's
   * own contract produces — a commit outside a turn is the documented shape of
   * `setup()` and of `endStage()`, so reporting it as an anomaly raised a
   * warning on every page load and on every cleared stage and left nothing for
   * a reader to act on.
   *
   * Debug is below the logger's default level, so at that level this reaches no
   * console and no sink; lowering the level to `debug` is what surfaces it.
   *
   * @param message What was observed.
   * @param fields Structured fields describing it.
   */
  reportExpected(message: string, fields?: LogFields): void {
    try {
      this.logger.debug(message, fields);
    } catch {
      this.faults += 1;
    }
  }

  /**
   * Accounts one `state:commit` to an attribution.
   *
   * A `turn` commit is not written to the log — its span record already
   * carries it. The other two are written at DEBUG, because neither is a
   * fault: `anomalies` is untouched by every attribution.
   *
   * @param attribution How the commit was attributed.
   * @param fields Structured fields describing it.
   */
  recordCommitAttribution(
    attribution: CommitAttribution,
    fields?: LogFields,
  ): void {
    const counted = this.commitCountsByAttribution[attribution];

    if (typeof counted !== 'number') {
      this.reportAnomaly('commit attribution rejected', {
        received: typeof attribution === 'string' ? attribution : '',
      });

      return;
    }

    this.commitCountsByAttribution[attribution] = counted + 1;

    if (attribution === COMMIT_ATTRIBUTIONS.turn) {
      return;
    }

    try {
      // A MESSAGE OF ITS OWN, because `reportExpected` writes 'commit outside a
      // turn' for the same commit from the accounting side: two records under
      // one message would read as two commits.
      this.logger.debug('commit attributed', {
        ...fields,
        attribution,
      });
    } catch {
      this.faults += 1;
    }
  }

  /**
   * How the `state:commit` emissions seen were attributed.
   *
   * @returns A frozen count per attribution, built fresh on each call.
   */
  commitCounts(): CommitTraceCounts {
    return Object.freeze({ ...this.commitCountsByAttribution });
  }

  /**
   * Reports a caller anomaly: a span ended twice, an attribute set after the
   * end, a commit with no open turn span and nothing that accounts for it.
   *
   * Reports a caller anomaly: a span ended twice, an attribute set after the
   * end, a stage end with no stage span open.
   *
   * @param message What was observed.
   * @param fields Structured fields describing it.
   */
  reportAnomaly(message: string, fields?: LogFields): void {
    this.anomalies += 1;

    try {
      this.logger.warn(message, fields);
    } catch {
      this.faults += 1;
    }
  }

  /**
   * Reports a caught failure. The sink every listener
   * `attachEngineTracing` registers contains its own throws through.
   *
   * @param message What failed.
   * @param thrown The caught value.
   * @param fields Structured fields describing it.
   */
  reportFailure(message: string, thrown: unknown, fields?: LogFields): void {
    this.faults += 1;

    try {
      this.logger.failure('warn', message, { fields, thrown });
    } catch {
      this.faults += 1;
    }
  }

  /**
   * The retained span records, oldest first.
   *
   * @param limit Most recent records to return. Omitted, every retained record
   *   is returned.
   * @returns A frozen array that shares no object with the buffer's own
   *   storage. Every record in it is itself frozen.
   */
  recent(limit?: number): readonly SpanRecord[] {
    const held = this.stored;
    let wanted = held;

    if (limit !== undefined) {
      if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0) {
        this.reportAnomaly('record limit rejected', {
          received: typeof limit === 'number' ? limit : typeof limit,
        });
      } else {
        wanted = Math.min(held, Math.floor(limit));
      }
    }

    const capacity = this.buffer.length;
    const out: SpanRecord[] = [];

    for (let offset = held - wanted; offset < held; offset += 1) {
      const index = (this.nextIndex - held + offset + capacity) % capacity;
      const record = this.buffer[index];

      if (record !== undefined) {
        out.push(record);
      }
    }

    return Object.freeze(out);
  }

  /** What every instrumented frame has contributed. */
  frameStats(): FrameTraceStats {
    return Object.freeze({
      frames: this.frames,
      overBudgetFrames: this.overBudgetFrames,
      budgetMs: this.frameBudgetMs,
      lastFrameMs: this.lastFrameMs,
      maxFrameMs: this.maxFrameMs,
      totalFrameMs: this.totalFrameMs,
    });
  }

  /** Frames whose duration exceeded `frameBudgetMs`. */
  overBudgetFrameCount(): number {
    return this.overBudgetFrames;
  }

  /**
   * The whole tracer as plain frozen data.
   *
   * @param limit Most recent records to carry.
   * @returns The snapshot, which `JSON.stringify` renders unchanged.
   */
  snapshot(limit?: number): TraceSnapshot {
    return Object.freeze({
      schemaVersion: TRACE_SNAPSHOT_SCHEMA_VERSION,
      correlationId: this.readCorrelationId(),
      enabled: this.enabled,
      capacity: this.buffer.length,
      started: this.startedSpans,
      ended: this.endedSpans,
      open: this.openSpanCount(),
      dropped: this.dropped,
      faults: this.faults,
      anomalies: this.anomalies,
      doubleEnds: this.doubleEnds,
      outOfOrderEnds: this.outOfOrderEnds,
      discarded: this.discarded,
      lifecycleCommits: this.lifecycleCommits,
      commits: this.commitCounts(),
      frames: this.frameStats(),
      spans: this.recent(limit),
    });
  }

  /**
   * The snapshot as JSON, for the diagnostics surface to export.
   *
   * @param limit Most recent records to carry.
   * @returns The JSON text, or `'{}'` when serialisation threw.
   */
  toJson(limit?: number): string {
    try {
      return JSON.stringify(this.snapshot(limit));
    } catch (thrown) {
      this.reportFailure('trace snapshot could not be serialised', thrown);

      return '{}';
    }
  }

  /**
   * Discards every retained record, every open span and every counter, and
   * returns the span counter to its start: a replayed sequence yields the same
   * identifiers. Nothing is recorded for a span the stack still held.
   *
   * EVERY OPEN SPAN IS INVALIDATED BEFORE THE COUNTER RESTARTS, and its start
   * mark is cleared with it. A handle a caller retained across this call is
   * therefore inert: ending it files no record, writes no duration and reports
   * one bounded anomaly, so the identifier the restarted counter reissues
   * cannot be filed twice and no mark of a discarded span survives.
   * `discardedSpanCount()` reports how many were taken down this way.
   */
  reset(): void {
    this.discarded = 0;

    for (const open of this.stack) {
      this.discardSpan(open);
    }

    for (const open of this.unstacked) {
      this.discardSpan(open);
    }

    const pending = this.pendingFrameSpan;

    if (pending !== undefined && !pending.invalidated) {
      this.discardSpan(pending);
    }

    // Held across the field wipe below: it describes THIS reset, and a caller
    // reading it wants to know what this reset took down.
    const discarded = this.discarded;

    // THE MARKS GO WITH THEM. `closeMarks()` runs from `finishSpan()` alone, so
    // a span the stack still held would otherwise leave its `performance.mark`
    // behind — and because the counter returns to its start, the next span of a
    // replayed sequence takes the same identifier and therefore the same mark
    // name, which is how a leaked entry would contaminate the replay's measure.
    // `discardSpan` above clears the mark of each span it takes down; this
    // sweeps any the stack no longer references.
    this.discardMarks();
    this.buffer.fill(undefined);
    this.stack.length = 0;
    this.unstacked.clear();
    this.pendingFrameSpan = undefined;
    this.pendingFrameStart = 0;
    this.nextIndex = 0;
    this.stored = 0;
    this.dropped = 0;
    this.counter = 0;
    this.startedSpans = 0;
    this.endedSpans = 0;
    this.faults = 0;
    this.anomalies = 0;
    this.doubleEnds = 0;
    this.outOfOrderEnds = 0;
    this.discarded = discarded;
    this.lifecycleCommits = 0;
    this.commitCountsByAttribution.turn = 0;
    this.commitCountsByAttribution.lifecycle = 0;
    this.commitCountsByAttribution.unattributed = 0;
    this.frames = 0;
    this.overBudgetFrames = 0;
    this.lastFrameMs = 0;
    this.maxFrameMs = 0;
    this.totalFrameMs = 0;
  }

  /**
   * Spans `reset()` discarded while they were still open, since that reset.
   *
   * @returns The count, which is `0` on a tracer whose resets found nothing
   *   open.
   */
  discardedSpanCount(): number {
    return this.discarded;
  }

  /**
   * Counts one `state:commit` that arrived with no turn span open.
   *
   * The setup, stage and continue commit paths of src/engine/engine.ts, which
   * `attachEngineTracing` classifies rather than reporting as anomalies.
   *
   * @param phase Which of `COMMIT_PHASES` the commit belongs to.
   */
  recordLifecycleCommit(phase: CommitPhase): void {
    this.lifecycleCommits += 1;

    try {
      this.logger.debug('commit with no turn span open', { phase });
    } catch {
      this.faults += 1;
    }
  }

  /**
   * Takes one open span down without recording it, and clears its start mark.
   *
   * @param span The span to discard.
   */
  private discardSpan(span: LiveSpan): void {
    span.discard();
    this.discarded += 1;

    const startMark = span.startMark;

    if (startMark !== undefined) {
      clearMark(startMark);
    }
  }

  /* ------------------------------------------------------------------------
   * The frame-callback seam
   * --------------------------------------------------------------------- */

  // The successor of the three unmeasured rAF sites: js/html_actuator.js L13,
  // its nested frame at L69, and js/application.js L2. Frame spans are opened
  // as ROOTS whatever else is open. Decision DL-TRACE-09.

  /**
   * Wraps one frame callback in a span.
   *
   * Records the frame's duration into the frame-time histogram and its
   * occurrence into the frame counter of src/observability/metrics.ts, and
   * classifies it against `frameBudgetMs` — the 16 of
   * js/animframe_polyfill.js L13.
   *
   * The wrapper throws nothing of its own accord, and does not contain what
   * the wrapped callback threw: the value is recorded on the span, reported
   * through the logger, and RETHROWN.
   *
   * @param callback The per-frame work. Returned unchanged where tracing is
   *   disabled: a disabled tracer adds no call frame at all.
   * @returns A function of the same shape.
   */
  instrumentFrameCallback<A extends readonly unknown[], R>(
    callback: (...args: A) => R,
  ): (...args: A) => R {
    if (typeof callback !== 'function') {
      this.reportAnomaly('frame callback rejected', {
        received: typeof callback,
      });

      return callback;
    }

    if (!this.enabled) {
      return callback;
    }

    return (...args: A): R => {
      if (!this.enabled) {
        return callback(...args);
      }

      const frame = this.frames + 1;
      const span = this.startSpan(SPAN_NAMES.frameCallback, { parent: null });
      const startedAt = span === INERT_SPAN ? readNow() : span.startTime;

      try {
        return callback(...args);
      } catch (thrown) {
        span.recordError(thrown);
        this.reportFailure('frame callback threw', thrown, { frame });

        throw thrown;
      } finally {
        const durationMs = Math.max(0, readNow() - startedAt);
        const overBudget = durationMs > this.frameBudgetMs;

        this.recordFrameSample(durationMs, overBudget);
        this.endFrameSpan(span, frame, durationMs, overBudget);
      }
    };
  }

  /**
   * The `onFrameBegin`/`onFrameEnd` pair src/render/render-loop.ts accepts,
   * for a loop that reports its own per-frame duration rather than having its
   * callbacks wrapped.
   *
   * @returns The frozen hook pair.
   */
  frameLifecycleHooks(): FrameLifecycleHooks {
    return Object.freeze({
      onFrameBegin: (): void => {
        if (!this.enabled) {
          return;
        }

        const open = this.pendingFrameSpan;

        if (open !== undefined) {
          this.pendingFrameSpan = undefined;
          this.finishSpan(
            open,
            { [SPAN_ATTRIBUTES.outcome]: SPAN_OUTCOMES.superseded },
            undefined,
          );
        }

        const span = this.startSpan(SPAN_NAMES.frameCallback, {
          parent: null,
        });

        this.pendingFrameSpan = span instanceof LiveSpan ? span : undefined;
        this.pendingFrameStart = readNow();
      },
      onFrameEnd: (_context: unknown, durationMs: number): void => {
        const span = this.pendingFrameSpan;

        this.pendingFrameSpan = undefined;

        if (span === undefined && !this.enabled) {
          return;
        }

        const measured =
          typeof durationMs === 'number' &&
          Number.isFinite(durationMs) &&
          durationMs >= 0
            ? durationMs
            : Math.max(0, readNow() - this.pendingFrameStart);
        const frame = this.frames + 1;
        const overBudget = measured > this.frameBudgetMs;

        this.recordFrameSample(measured, overBudget);

        if (span === undefined) {
          this.reportAnomaly('frame ended with no frame span open', { frame });

          return;
        }

        this.endFrameSpan(span, frame, measured, overBudget);
      },
    });
  }

  private endFrameSpan(
    span: Span,
    frame: number,
    durationMs: number,
    overBudget: boolean,
  ): void {
    const attributes: SpanAttributes = {
      [SPAN_ATTRIBUTES.frame]: frame,
      [SPAN_ATTRIBUTES.overBudget]: overBudget,
      [SPAN_ATTRIBUTES.budgetMs]: this.frameBudgetMs,
    };

    if (span instanceof LiveSpan) {
      this.finishSpan(span, attributes, durationMs);

      return;
    }

    span.end(attributes);
  }

  /**
   * Counts one frame and records its duration.
   *
   * `recordFrame` raises the frame counter and observes the frame-time
   * histogram in one call; neither is written anywhere else. The over-budget
   * tally is kept here and not as a metric family of its own.
   * `METRIC_NAMES` of src/observability/metrics.ts is the single declaration
   * of every metric name. Decision DL-TRACE-06.
   */
  private recordFrameSample(durationMs: number, overBudget: boolean): void {
    this.frames += 1;

    if (overBudget) {
      this.overBudgetFrames += 1;
    }

    this.lastFrameMs = durationMs;
    this.totalFrameMs += durationMs;

    if (durationMs > this.maxFrameMs) {
      this.maxFrameMs = durationMs;
    }

    try {
      this.metrics.recordFrame(durationMs);
    } catch {
      this.faults += 1;
    }
  }

  private resolveParentId(options: StartSpanOptions): string | undefined {
    const explicit = options.parent;

    if (explicit === null) {
      return undefined;
    }

    if (explicit !== undefined) {
      return typeof explicit.id === 'string' && explicit.id.length > 0
        ? explicit.id
        : undefined;
    }

    return this.stack.length === 0
      ? undefined
      : this.stack[this.stack.length - 1].id;
  }

  /**
   * Closes one span, unwinding to it first where a child of it is still open.
   *
   * @param span The span to close.
   * @param attributes Attributes applied as it closes.
   * @param durationMs Duration to record, where the caller measured its own.
   * @returns The recorded duration, or `0` where nothing was recorded.
   */
  private finishSpan(
    span: LiveSpan,
    attributes: SpanAttributes | undefined,
    durationMs: number | undefined,
  ): number {
    try {
      // Read BEFORE `ended`: a discarded span is also closed, and the two
      // states are reported differently. A stale handle ended after a reset is
      // the caller keeping a reference across a reset, not a double end, and it
      // must file nothing at all — the counter has reissued its identifier.
      if (span.invalidated) {
        this.reportAnomaly('span discarded by reset was ended', {
          span: span.name,
          spanId: span.id,
        });

        return 0;
      }

      if (span.ended) {
        this.doubleEnds += 1;
        this.reportAnomaly('span ended more than once', {
          span: span.name,
          spanId: span.id,
        });

        return 0;
      }

      const index = this.stack.lastIndexOf(span);

      if (index >= 0) {
        let unwound = 0;

        while (this.stack.length - 1 > index) {
          const orphan = this.stack.pop();

          if (orphan !== undefined && !orphan.ended) {
            this.closeSpan(
              orphan,
              {
                [SPAN_ATTRIBUTES.outcome]: SPAN_OUTCOMES.unwound,
                [SPAN_ATTRIBUTES.unwound]: true,
              },
              undefined,
            );
            unwound += 1;
          }
        }

        this.stack.pop();

        if (unwound > 0) {
          this.outOfOrderEnds += 1;
          this.reportAnomaly('span ended while a child was open', {
            span: span.name,
            spanId: span.id,
            unwound,
          });
        }
      }

      return this.closeSpan(span, attributes, durationMs);
    } catch (thrown) {
      this.reportFailure('span could not be closed', thrown, {
        span: span.name,
        spanId: span.id,
      });

      return 0;
    }
  }

  /**
   * Files one span's record, writes its measure and clears its marks. The
   * stack is not consulted here: unwinding cannot recurse.
   */
  private closeSpan(
    span: LiveSpan,
    attributes: SpanAttributes | undefined,
    durationMs: number | undefined,
  ): number {
    const supplied =
      durationMs !== undefined &&
      typeof durationMs === 'number' &&
      Number.isFinite(durationMs) &&
      durationMs >= 0;
    const measured = supplied
      ? (durationMs as number)
      : Math.max(0, readNow() - span.startTime);

    span.applyAttributes(attributes);
    span.ended = true;
    this.endedSpans += 1;

    // Removed by identity, so a double close cannot take the open count below
    // what is actually open.
    this.unstacked.delete(span);
    this.store(span.toRecord(span.correlationId, measured));
    this.closeMarks(span);

    try {
      this.metrics.recordSpanDuration(span.name, measured);
    } catch {
      this.faults += 1;
    }

    return measured;
  }

  /**
   * Clears the start mark of every span `reset()` is about to discard: those
   * still on the stack and the one the frame hooks left pending.
   *
   * A span the stack holds twice — it cannot, `startSpan` pushes each once —
   * and a span with no mark are both handled: `clearMark` names one entry and
   * does nothing where none exists.
   */
  private discardMarks(): void {
    const pending = this.pendingFrameSpan;

    for (const span of this.stack) {
      const mark = span.startMark;

      if (mark !== undefined) {
        clearMark(mark);
      }
    }

    // Held outside the stack: `frameLifecycleHooks().onFrameBegin` opens a
    // frame span as a root and keeps it here until the matching end.
    if (pending !== undefined && !this.stack.includes(pending)) {
      const mark = pending.startMark;

      if (mark !== undefined) {
        clearMark(mark);
      }
    }
  }

  /**
   * Writes the span's measure, then clears that measure and both marks.
   *
   * Order: end mark, measure, clear measure, clear end mark, clear start
   * mark. Decision DL-TRACE-07.
   */
  private closeMarks(span: LiveSpan): void {
    const startMark = span.startMark;

    if (startMark === undefined) {
      return;
    }

    const endMark = `${MARK_PREFIX}${span.id}${END_MARK_SUFFIX}`;

    if (writeMark(endMark)) {
      const measureName = `${MARK_PREFIX}${span.name}/${span.id}`;

      if (writeMeasure(measureName, startMark, endMark)) {
        clearMeasure(measureName);
      }

      clearMark(endMark);
    }

    clearMark(startMark);
  }

  private store(record: SpanRecord): void {
    const capacity = this.buffer.length;

    if (capacity === 0) {
      return;
    }

    if (this.stored === capacity) {
      this.dropped += 1;
    } else {
      this.stored += 1;
    }

    this.buffer[this.nextIndex] = record;
    this.nextIndex = (this.nextIndex + 1) % capacity;
  }
}

/**
 * Creates a tracer.
 *
 * @param options Logger, registry and the optional identifier, enabled flag,
 *   capacity, frame budget and marking flag.
 * @returns The tracer.
 */
export function createTracer(options: TracerOptions): Tracer {
  return new Tracer(options);
}

/* ==========================================================================
 * 6. Engine attachment
 * ========================================================================== */

// Attaches through `on` alone, which APPENDS — the property
// js/keyboard_input_manager.js L18-L23 established and
// src/engine/engine-events.ts preserves. No engine module is edited and no
// engine module calls this. Every payload carries the live board, and no
// listener registered here writes to one — `move:before.cancelled` included,
// so tracing never withdraws a move.

/**
 * Subscribes turn and stage spans to an engine emitter.
 *
 * A turn span opens on `move:before` and closes on `state:commit`, whose
 * duration reaches the turn-latency histogram. It closes without a commit in
 * three cases: a move the engine withdrew, which `move:before` carries in its
 * `cancelled` flag; a `move:after` carrying `moved === false`; and
 * a `move:before` arriving while an earlier turn span is still open, which
 * supersedes it rather than leaking it. A `state:commit` with no turn span open
 * is reported and otherwise ignored.
 *
 * `tile:merge` and `tile:spawn` are recorded as span EVENTS on the turn span
 * and not as spans of their own: a turn resolving two merges carries two
 * events. Decision DL-TRACE-04.
 *
 * Every listener contains its own throws and returns normally. No failure
 * here reaches the emitter's loop.
 *
 * @param events The emitter, whose `on` is the only member used.
 * @param tracer Tracer the spans are opened on.
 * @returns A handle that detaches every listener and closes what it left open.
 */
export function attachEngineTracing(
  events: EngineEventSource,
  tracer: Tracer,
): EngineTracingSubscription {
  const stops: EngineEventSubscription[] = [];
  let turnSpan: Span | undefined;
  let turnStart = 0;
  let stageSpan: Span | undefined;

  /**
   * Index of the stage in force, or `null` before any `stage:start`.
   *
   * Held so a TURN span can carry the stage it belongs to as an attribute. The
   * stage span is detached from the implicit-parent stack, so that association
   * is no longer expressible as a parent link — and should not be one anyway:
   * the turn's parent is the input dispatch that caused it, which is the chain
   * a reader follows.
   */
  let stageIndex: number | null = null;

  /**
   * Index of the stage whose span has been CLOSED and not yet superseded, or
   * `NO_SETTLED_STAGE` where none is.
   *
   * `endStage()` commits immediately after the emission that closes the span,
   * and that commit still reports the stage it just resolved; this is what tells
   * the commit handler the report belongs to a stage already accounted for
   * rather than to one it should open a second span for.
   */
  let settledStageIndex: number | null = NO_SETTLED_STAGE;
  let merges = 0;
  let spawns = 0;
  let detached = false;

  /**
   * The engine path that is about to commit outside a turn, or `null` when
   * none is.
   *
   * TWO ENGINE PATHS EMIT AND THEN COMMIT IMMEDIATELY, both by their own
   * documented design: `setup()` emits `stage:start` and commits, and
   * `endStage()` emits `stage:end` and commits. Neither is inside a turn, so
   * neither has a turn span, and treating either as an anomaly warned once per
   * page load and once per cleared stage about correct behaviour.
   *
   * Armed by those two emissions and consumed by the commit that follows, so a
   * commit that arrives with no turn span AND nothing accounting for it is
   * still reported as an anomaly. `continuePlaying()` commits outside a turn
   * with no emission ahead of it and so remains in that second category: the
   * engine offers no signal to arm this with, and a state change out of turn is
   * worth surfacing.
   */
  let expectedUntracedCommit: string | null = null;

  /**
   * Classifies a `state:commit` that arrived with no turn span open.
   *
   * The classification `Tracer.recordLifecycleCommit` counts under, and the
   * value the stage-span event carries as `SPAN_ATTRIBUTES.phase`. Read from
   * the marker the preceding emission armed where there is one, and from the
   * commit itself where there is not: `continuePlaying()` (src/engine/engine.ts
   * L1162-L1166) emits nothing ahead of its commit, and a commit with the win
   * reached and play NOT blocked is that path and no other — the winning turn's
   * own commit blocks play, and a stage opening has not won.
   *
   * @param path Marker the preceding emission armed, or `null`.
   * @param openedStage Whether this commit opened the stage span it landed on.
   * @param commit The commit payload.
   * @returns The phase it belongs to.
   */
  const commitPhaseFor = (
    path: string | null,
    openedStage: boolean,
    commit: StateCommitEvent,
  ): CommitPhase => {
    if (path === UNTRACED_COMMIT_PATHS.stageEnd) {
      return COMMIT_PHASES.stage;
    }

    if (path === UNTRACED_COMMIT_PATHS.stageStart || openedStage) {
      return COMMIT_PHASES.setup;
    }

    if (commit.won && !commit.terminated) {
      return COMMIT_PHASES.continue;
    }

    return COMMIT_PHASES.unknown;
  };

  const endTurn = (outcome: SpanOutcome): void => {
    const span = turnSpan;

    if (span === undefined) {
      return;
    }

    turnSpan = undefined;

    const durationMs = Math.max(0, readNow() - turnStart);

    span.setAttribute(SPAN_ATTRIBUTES.merges, merges);
    span.setAttribute(SPAN_ATTRIBUTES.spawns, spawns);
    merges = 0;
    spawns = 0;
    span.end({ [SPAN_ATTRIBUTES.outcome]: outcome });

    if (outcome === SPAN_OUTCOMES.committed) {
      tracer.recordTurnLatency(durationMs);
    }
  };

  const endStage = (outcome: SpanOutcome, extra?: SpanAttributes): void => {
    const span = stageSpan;

    if (span === undefined) {
      return;
    }

    stageSpan = undefined;

    // REMEMBERED SO THE COMMIT THAT FOLLOWS DOES NOT RE-OPEN IT. `endStage()`
    // emits `stage:end` and then commits, and that commit still reports the
    // stage that just ended — so following it blindly would open a second span
    // for a stage nothing is playing and leave it open for the rest of the run.
    // The next `stage:start`, or a commit reporting a DIFFERENT stage, opens the
    // next one.
    settledStageIndex = stageIndex;
    span.end({ ...extra, [SPAN_ATTRIBUTES.outcome]: outcome });
  };

  /**
   * Opens the span for the stage now in force.
   *
   * @param index Index of that stage.
   * @param boardSize Board dimension it runs on.
   */
  const beginStage = (index: number, boardSize: number): void => {
    stageIndex = index;
    settledStageIndex = NO_SETTLED_STAGE;
    stageSpan = tracer.startSpan(SPAN_NAMES.engineStage, {
      parent: null,

      // DETACHED, because a stage outlives the call that started it: it is
      // open across every turn of that stage and closes on an event of its
      // own. On the stack it would sit beneath whatever the keypress in
      // flight has open, and closing it — which happens INSIDE the commit
      // of the turn that cleared the goal — would unwind that turn and its
      // input dispatch as though they were its children.
      detached: true,

      attributes: {
        [SPAN_ATTRIBUTES.stageIndex]: index,
        [SPAN_ATTRIBUTES.boardSize]: boardSize,
      },
    });
  };

  /**
   * Aligns the open stage span with the stage a commit reports.
   *
   * Opens one when none is open, and replaces one that belongs to a stage the
   * run has left. Called on every commit, so the stage a turn span records and
   * the stage a `stage:end` closes are the stage the engine says is in force
   * rather than one inferred from an emission that fires once per run.
   *
   * @param index Stage index the commit reports.
   * @param boardSize Board dimension the commit reports.
   */
  const followCommittedStage = (index: number, boardSize: number): boolean => {
    if (stageSpan !== undefined && stageIndex === index) {
      return false;
    }

    // The stage this index belongs to has already been resolved and its span
    // closed; the commit that closes it is not a new stage.
    if (stageSpan === undefined && settledStageIndex === index) {
      return false;
    }

    // The stage this span belonged to is over: the run left it without the
    // `stage:end` that would have closed it, which is what a restart into a
    // different stage does.
    endStage(SPAN_OUTCOMES.superseded);
    beginStage(index, boardSize);

    // OPENED HERE, which is itself an account for a commit outside a turn: the
    // commit that opens a stage is the vanilla actuation of js/game_manager.js
    // L59, which ran from `setup()` before any move.
    return true;
  };

  /**
   * Wraps one listener: a failure inside it is reported and the listener
   * returns normally.
   */
  const guarded = <K extends EngineEventName>(
    event: K,
    body: EngineEventListener<K>,
  ): EngineEventListener<K> =>
    (payload): void => {
      try {
        body(payload);
      } catch (thrown) {
        tracer.reportFailure('engine tracing listener threw', thrown, {
          event,
        });
      }
    };

  stops.push(
    events.on(
      'stage:start',
      guarded('stage:start', (payload): void => {
        endStage(SPAN_OUTCOMES.superseded);

        // `setup()` commits immediately after this emission, outside any turn.
        expectedUntracedCommit = UNTRACED_COMMIT_PATHS.stageStart;
        beginStage(payload.stageIndex, payload.boardSize);
      }),
    ),
  );

  stops.push(
    events.on(
      'move:before',
      guarded('move:before', (payload): void => {
        endTurn(SPAN_OUTCOMES.superseded);

        // A turn supersedes a lifecycle emission awaiting a commit: the
        // commit this turn ends with is the turn's own.
        expectedUntracedCommit = null;
        turnStart = readNow();
        turnSpan = tracer.startSpan(SPAN_NAMES.engineTurn, {
          attributes: {
            [SPAN_ATTRIBUTES.direction]: payload.direction,
            [SPAN_ATTRIBUTES.cancelled]: payload.cancelled,

            // The stage this turn belongs to, carried as an attribute rather
            // than as a parent link: the stage span is detached, and the turn's
            // parent is whatever opened the turn — the input dispatch, in the
            // composed application.
            ...(stageIndex === null
              ? {}
              : { [SPAN_ATTRIBUTES.stageIndex]: stageIndex }),
          },
        });

        if (payload.cancelled) {
          endTurn(SPAN_OUTCOMES.cancelled);
        }
      }),
    ),
  );

  stops.push(
    events.on(
      'tile:merge',
      guarded('tile:merge', (payload): void => {
        merges += 1;

        if (turnSpan !== undefined) {
          turnSpan.addEvent(SPAN_EVENT_NAMES.merge, {
            [SPAN_ATTRIBUTES.resultValue]: payload.resultValue,
            [SPAN_ATTRIBUTES.scoreDelta]: payload.scoreDelta,
          });
        }
      }),
    ),
  );

  stops.push(
    events.on(
      'tile:spawn',
      guarded('tile:spawn', (payload): void => {
        spawns += 1;

        if (turnSpan !== undefined) {
          turnSpan.addEvent(SPAN_EVENT_NAMES.spawn, {
            [SPAN_ATTRIBUTES.value]: payload.value,
            [SPAN_ATTRIBUTES.inserted]: payload.position !== undefined,
          });
        }
      }),
    ),
  );

  stops.push(
    events.on(
      'move:after',
      guarded('move:after', (payload): void => {
        const span = turnSpan;

        if (span === undefined) {
          return;
        }

        span.setAttribute(SPAN_ATTRIBUTES.moved, payload.moved);
        span.setAttribute(SPAN_ATTRIBUTES.score, payload.score);
        span.setAttribute(SPAN_ATTRIBUTES.over, payload.over);
        span.setAttribute(SPAN_ATTRIBUTES.won, payload.won);
        span.setAttribute(SPAN_ATTRIBUTES.terminated, payload.terminated);

        if (!payload.moved) {
          endTurn(SPAN_OUTCOMES.unmoved);
        }
      }),
    ),
  );

  /**
   * The `state:commit` listener, held so it can be moved to the END of the
   * emitter's registration order.
   *
   * IT CLOSES THE TURN SPAN, and listeners run in registration order, so every
   * listener registered after it runs with the turn already closed — which put
   * the renderer's own `render.commit` span outside the turn that produced it
   * rather than inside it. `reattachCommitClosing()` re-registers this listener
   * so it is last again, and a caller calls it after subscribing a renderer.
   */
  const commitListener = guarded('state:commit', (payload): void => {
        // THE STAGE A COMMIT REPORTS IS THE AUTHORITATIVE ONE, and this is
        // the only event carrying it on every emission. `stage:start` is
        // emitted by `setup()` alone, so within one run it fires ONCE while
        // `stage:end` fires once per cleared stage: advancing a stage keeps
        // the board and raises the goal rather than setting up again.
        // Following the committed index is what keeps a span open for the
        // stage actually in force — without it, stage 0 was the only stage
        // ever spanned, every later turn carried stage 0 as its attribute,
        // and every later `stage:end` reported an anomaly against a span
        // that had never been opened.
        const openedStage = followCommittedStage(
          payload.stage.stageIndex,
          payload.board.size,
        );

        if (turnSpan === undefined) {
          // A NON-TURN COMMIT, WHICH IS ORDINARY: four of the engine's five
          // commit paths are not moves — `setup()`, `continuePlaying()`,
          // `endStage()` and `startStage()`, plus `restart()` through `setup()` —
          // so every board a run opens on, every win continued and every stage
          // resolved reaches here with no turn span open. Reporting those as
          // anomalies would make the anomaly count a measure of how many stages
          // had been played rather than of anything wrong.
          //
          // A commit with no turn span belongs to one of two boundaries. An
          // ARMED lifecycle path — setup, a stage start, a stage end, a
          // continue — is an expected commit outside a turn and is reported as
          // such. Otherwise js/game_manager.js L59 actuated from `setup()`
          // before any move, so the commit that opens a stage arrives with a
          // stage span open and no turn span, and it is recorded on the stage
          // span. A commit with NEITHER an armed path nor a stage span has no
          // boundary to belong to and is reported as an anomaly.
          const path = expectedUntracedCommit;
          expectedUntracedCommit = null;

          // KEPT WHERE IT HAPPENED, whatever accounts for it. The commit is an
          // event on the stage span in force, so a reader following one stage
          // sees every commit that landed inside it — the boards a stage opened
          // on and the stage it resolved through included — rather than only the
          // turns. Recorded before the accounting below, because the two answer
          // different questions: this is WHERE it happened, that is WHETHER it
          // should have.
          const phase = commitPhaseFor(path, openedStage, payload);

          // COUNTED, whichever path it belongs to. `lifecycleCommits` measures
          // the commits made outside a turn, so a reader comparing it against
          // the turn count sees the lifecycle traffic separately rather than
          // having to read it out of the anomaly count.
          tracer.recordLifecycleCommit(phase);

          // AND INTO THE THREE-WAY BREAKDOWN, beside the turn commits accounted
          // below: `lifecycle` for a commit an observed signal explains, and
          // `unattributed` for one nothing does — which is the same commit this
          // reports as an anomaly a few lines on. `state:commit` carries no
          // commit source (AAP 0.6.1.1 fixes its members), so a lifecycle commit
          // made outside the accounted paths and a commit no engine method
          // produced share that bucket.
          tracer.recordCommitAttribution(
            phase === COMMIT_PHASES.unknown
              ? COMMIT_ATTRIBUTIONS.unattributed
              : COMMIT_ATTRIBUTIONS.lifecycle,
            {
              phase,
              score: payload.score,
              terminated: payload.terminated,
            },
          );

          if (stageSpan !== undefined) {
            stageSpan.addEvent(SPAN_EVENT_NAMES.stageCommit, {
              [SPAN_ATTRIBUTES.phase]: phase,
              [SPAN_ATTRIBUTES.score]: payload.score,
              [SPAN_ATTRIBUTES.terminated]: payload.terminated,
            });
          }

          // THE ACCOUNT, spent once. An ARMED lifecycle path — setup, a stage
          // start, a stage end, a continue — accounts for exactly the next
          // commit and is then consumed, so an arm cannot be carried over to a
          // later commit it has no relationship to. A commit that OPENED the
          // stage span it just landed on accounts for itself. A commit with
          // neither has no boundary to belong to and is an anomaly.
          if (path !== null) {
            tracer.reportExpected('commit outside a turn', {
              path,
              score: payload.score,
              terminated: payload.terminated,
            });
          } else if (openedStage) {
            tracer.reportExpected('commit outside a turn', {
              path: UNTRACED_COMMIT_PATHS.stageStart,
              score: payload.score,
              terminated: payload.terminated,
            });
          } else if (phase === COMMIT_PHASES.continue) {
            // `continuePlaying()` commits with nothing emitted ahead of it, so
            // no arm can account for it — but a win the player chose to play on
            // from is ordinary, and reporting it as an anomaly made the anomaly
            // count rise once per continued win.
            tracer.reportExpected('commit outside a turn', {
              path: COMMIT_PHASES.continue,
              score: payload.score,
              terminated: payload.terminated,
            });
          } else {
            tracer.reportAnomaly('commit with no turn span open', {
              score: payload.score,
              terminated: payload.terminated,
            });
          }

          return;
        }

        // A turn is committing, so nothing outside a turn is pending any more:
        // an arm left standing here would be consumed by a later commit it has
        // no relationship to.
        expectedUntracedCommit = null;

        turnSpan.setAttribute(SPAN_ATTRIBUTES.score, payload.score);
        turnSpan.setAttribute(
          SPAN_ATTRIBUTES.terminated,
          payload.terminated,
        );
        endTurn(SPAN_OUTCOMES.committed);
        tracer.recordCommitAttribution(COMMIT_ATTRIBUTIONS.turn);
  });

  /** The registration `commitListener` currently holds, or `null`. */
  let stopCommit: EngineEventSubscription | null = null;

  /**
   * Registers the commit listener, moving it to the end of the order where it
   * is already registered.
   */
  const attachCommitClosing = (): void => {
    if (detached) {
      return;
    }

    stopCommit?.();
    stopCommit = events.on('state:commit', commitListener);
  };

  attachCommitClosing();

  stops.push((): void => {
    stopCommit?.();
    stopCommit = null;
  });

  stops.push(
    events.on(
      'stage:end',
      guarded('stage:end', (payload): void => {
        // Armed ahead of the stage-span check, because `endStage()` commits
        // immediately after this emission whether or not this tracer was
        // attached in time to hold a span for the stage that just ended. The
        // turn that cleared the goal has already committed and closed its own
        // span, so that commit is outside any turn.
        expectedUntracedCommit = UNTRACED_COMMIT_PATHS.stageEnd;

        if (stageSpan === undefined) {
          tracer.reportAnomaly('stage end with no stage span open', {
            stageIndex: payload.stageIndex,
          });

          return;
        }

        endStage(SPAN_OUTCOMES.committed, {
          [SPAN_ATTRIBUTES.cleared]: payload.cleared,
          [SPAN_ATTRIBUTES.score]: payload.score,
        });
      }),
    ),
  );

  const detach = (): void => {
    if (detached) {
      return;
    }

    detached = true;

    for (const stop of stops) {
      try {
        stop();
      } catch (thrown) {
        tracer.reportFailure('listener would not detach', thrown);
      }
    }

    stops.length = 0;
    endTurn(SPAN_OUTCOMES.detached);
    endStage(SPAN_OUTCOMES.detached);
  };

  // THE ONE CLOSER. Both members below reach it, so an idle turn is closed the
  // same way whichever a caller holds. Reported as `unmoved` by default, the
  // outcome an idle turn already has, so the turn-latency histogram records only
  // turns that actually resolved.
  const settleTurn = (
    outcome: SpanOutcome = SPAN_OUTCOMES.unmoved,
  ): boolean => {
    if (detached || turnSpan === undefined) {
      return false;
    }

    endTurn(outcome);

    return true;
  };

  // THE OUTCOME OF A WHOLE ATTEMPT, not of the boolean it projects to. Every
  // path is closed under the outcome that path has: a withdrawn move as
  // `cancelled`, an idle one as `unmoved`, an attempt that threw as `failed`,
  // and a move refused because the game is over as `blocked` — which normally
  // has no span to close, because no `move:before` was emitted for it.
  const settleMove = (result: FinalMoveResult): boolean =>
    settleTurn(MOVE_SPAN_OUTCOMES[result.resolution]);

  // Attached to the detach function rather than returned beside it, so every
  // existing caller — which calls the handle to detach — is unaffected.
  return Object.assign(detach, {
    settleTurn,
    settleMove,

    closeIdleTurn: (): void => {
      settleTurn();
    },

    currentTurnSpan: (): Span | undefined => turnSpan,

    reattachCommitClosing: (): void => {
      attachCommitClosing();
    },
  });
}

/* ==========================================================================
 * 7. Boundary helpers
 * ========================================================================== */

/**
 * One wrapper per module boundary of the chain validation gate V8 names.
 *
 * Injectable: the hook bus and the relic layer receive the wrapper they need
 * and import nothing from here; src/engine imports no src/observability
 * module. Each wrapper rethrows whatever the wrapped function threw, leaving
 * containment to the hook bus that owns it.
 *
 * @param tracer Tracer the spans are opened on.
 * @returns The frozen wrapper set.
 */
export function createBoundaryTracing(tracer: Tracer): BoundaryTracing {
  return Object.freeze({
    traceInput: <T>(action: string, run: () => T): T =>
      tracer.withSpan(SPAN_NAMES.inputDispatch, run, {
        attributes: { [SPAN_ATTRIBUTES.action]: action },
      }),
    traceMoveResolution: <T>(run: () => T): T =>
      tracer.withSpan(SPAN_NAMES.moveResolution, run),
    traceHookDispatch: <T>(hook: HookName, run: () => T): T =>
      tracer.withSpan(SPAN_NAMES.hookDispatch, run, { hook }),
    traceRelicHandler: <T>(hook: HookName, relicId: string, run: () => T): T =>
      tracer.withSpan(SPAN_NAMES.relicHandler, run, { hook, relicId }),
    traceRenderCommit: <T>(run: () => T, parent?: Span | null): T =>
      tracer.withSpan(
        SPAN_NAMES.renderCommit,
        run,
        parent === undefined ? undefined : { parent },
      ),
  });
}
