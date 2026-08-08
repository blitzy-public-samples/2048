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
// Two further boundaries this module spans, and one it subscribes through:
//   js/game_manager.js L130      `GameManager.prototype.move`, where the turn
//                                span opens.
//   js/game_manager.js L91-L97   the actuation push, where the turn span
//                                closes.
//   js/keyboard_input_manager.js L18-L23  `on()` appending to the listener
//                                array, a property src/engine/
//                                engine-events.ts preserves, and the whole of
//                                how `attachEngineTracing` attaches without an
//                                engine-side call site.
//
// `DEFAULT_FRAME_BUDGET_MS` carries the 16 of js/animframe_polyfill.js L13,
// `Math.max(0, 16 - (currTime - lastTime))`.
//
// `performance` is invoked nowhere in the retired sources, so every call to it
// here is an addition rather than a port.
//
// docs/TRACEABILITY_MATRIX.md:
//   TR-TRACE-01  js/html_actuator.js L13
//   TR-TRACE-02  js/html_actuator.js L69
//   TR-TRACE-03  js/application.js L2
//   TR-TRACE-04  js/animframe_polyfill.js L13
//   TR-TRACE-05  js/game_manager.js L130 and L91-L97
//   TR-TRACE-06  js/keyboard_input_manager.js L18-L23
// Target-only rows, TR-TRACE-07 through TR-TRACE-10: the span vocabulary, the
// bounded record buffer, the parent stack, and the boundary helpers.
//
// docs/DECISION_LOG.md is the single source of truth for why each of the
// following was decided:
//   DL-TRACE-01  module boundaries traced in place of service boundaries
//   DL-TRACE-02  the counter-and-correlation-identifier span identifier
//   DL-TRACE-03  span durations recorded into the metrics histograms
//   DL-TRACE-04  span events rather than child spans for merge and spawn
//   DL-TRACE-05  the closed span vocabulary bounding the histogram's series
//   DL-TRACE-06  over-budget frames counted here and not as a metric family
//   DL-TRACE-07  marks and measures cleared as each span closes
//   DL-TRACE-08  turn latency recorded on commit alone
//   DL-TRACE-09  frame spans opened as roots rather than nested
//   DL-TRACE-10  `performance` re-read per call rather than resolved once
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
} from '../engine/engine-events';
import type { HookName } from '../engine/hooks';
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
 * The module-boundary chain, in the order one turn reaches it: input, engine
 * turn, move resolution, hook dispatch, relic handler, render commit, frame
 * callback. The list validation gate V8 is asserted against.
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
} as const);

/**
 * Every outcome a span closes with, frozen.
 *
 * `committed` is the turn that reached `state:commit`, `cancelled` the move the
 * engine withdrew, `unmoved` the move whose position comparison changed
 * nothing, `superseded` the span a later span of the same kind replaced,
 * `unwound` the span closed by its parent closing first, and `detached` the
 * span open when tracing was detached.
 */
export const SPAN_OUTCOMES = Object.freeze({
  committed: 'committed',
  cancelled: 'cancelled',
  unmoved: 'unmoved',
  superseded: 'superseded',
  unwound: 'unwound',
  detached: 'detached',
} as const);

/** One of the outcomes `SPAN_OUTCOMES` declares. */
export type SpanOutcome = (typeof SPAN_OUTCOMES)[keyof typeof SPAN_OUTCOMES];

/**
 * Names of the span events a turn's internal detail is recorded as. The two
 * tile names are the engine event names they are taken from: a record reads in
 * the emitter's own vocabulary. Decision DL-TRACE-04.
 */
export const SPAN_EVENT_NAMES = Object.freeze({
  merge: 'tile:merge',
  spawn: 'tile:spawn',
  error: 'error',
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
   * Caller anomalies reported: a double end, an orphan commit, and the like.
   */
  readonly anomalies: number;

  /** Spans ended more than once. */
  readonly doubleEnds: number;

  /** Spans ended while a child of theirs was still open. */
  readonly outOfOrderEnds: number;
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
   */
  readonly correlationId?: string;

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
 * Detaches every listener `attachEngineTracing` registered and closes the turn
 * and stage spans it left open. Calling it more than once detaches nothing
 * further and throws nothing.
 */
export type EngineTracingSubscription = () => void;

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
  readonly traceRenderCommit: <T>(run: () => T) => T;
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

  readonly parentId: string | undefined;

  readonly startTime: number;

  /** Mark written as the span opened, absent where marking was unavailable. */
  readonly startMark: string | undefined;

  readonly attributes: Record<string, SpanAttributeValue> =
    Object.create(null) as Record<string, SpanAttributeValue>;

  readonly events: SpanEvent[] = [];

  attributeCount = 0;

  error: SerializedError | undefined = undefined;

  ended = false;

  droppedAttributes = 0;

  droppedEvents = 0;

  private readonly host: SpanHost;

  constructor(
    host: SpanHost,
    name: SpanName,
    id: string,
    parentId: string | undefined,
    startTime: number,
    startMark: string | undefined,
  ) {
    this.host = host;
    this.name = name;
    this.id = id;
    this.parentId = parentId;
    this.startTime = startTime;
    this.startMark = startMark;
  }

  setAttribute(key: string, value: SpanAttributeValue): void {
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
    if (this.error !== undefined) {
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
  /** Identifier every span of this tracer is keyed under. */
  readonly correlationId: string;

  /** Budget a frame is classified against, in milliseconds. */
  readonly frameBudgetMs: number;

  private readonly logger: Logger;

  private readonly metrics: MetricsRegistry;

  private readonly marksEnabled: boolean;

  private readonly buffer: (SpanRecord | undefined)[];

  /** Open spans, innermost last. */
  private readonly stack: LiveSpan[] = [];

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
    this.correlationId =
      typeof options.correlationId === 'string' &&
      options.correlationId.length > 0
        ? options.correlationId
        : this.logger.correlationId;
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
   * Turns span creation on or off.
   *
   * Disabled, `startSpan` returns `INERT_SPAN` and allocates nothing, and
   * `instrumentFrameCallback` returns the callback it was given. A span already
   * open when tracing is disabled still closes normally.
   *
   * @param next Whether to open spans.
   */
  setEnabled(next: boolean): void {
    if (typeof next !== 'boolean') {
      this.reportAnomaly('enabled flag rejected', { received: typeof next });

      return;
    }

    this.enabled = next;
  }

  /** Records the tracer retains at most. */
  get capacity(): number {
    return this.buffer.length;
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

      const id = `${this.correlationId}${SPAN_ID_SEPARATOR}${this.counter}`;
      const startMark = `${MARK_PREFIX}${id}${START_MARK_SUFFIX}`;
      const marked = this.marksEnabled && writeMark(startMark);
      const span = new LiveSpan(
        this.host,
        name,
        id,
        this.resolveParentId(options),
        readNow(),
        marked ? startMark : undefined,
      );

      span.applyAttributes(options.attributes);

      if (options.hook !== undefined) {
        span.setAttribute(SPAN_ATTRIBUTES.hook, options.hook);
      }

      if (options.relicId !== undefined) {
        span.setAttribute(SPAN_ATTRIBUTES.relic, options.relicId);
      }

      this.stack.push(span);
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
   * @param durationMs Latency in milliseconds.
   */
  recordTurnLatency(durationMs: number): void {
    try {
      this.metrics.recordTurnLatency(durationMs);
    } catch (thrown) {
      this.reportFailure('turn latency could not be recorded', thrown, {
        durationMs: Number.isFinite(durationMs) ? durationMs : 0,
      });
    }
  }

  /**
   * Reports a caller anomaly: a span ended twice, an attribute set after the
   * end, a commit with no open turn span.
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
      correlationId: this.correlationId,
      enabled: this.enabled,
      capacity: this.buffer.length,
      started: this.startedSpans,
      ended: this.endedSpans,
      open: this.stack.length,
      dropped: this.dropped,
      faults: this.faults,
      anomalies: this.anomalies,
      doubleEnds: this.doubleEnds,
      outOfOrderEnds: this.outOfOrderEnds,
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
   */
  reset(): void {
    this.buffer.fill(undefined);
    this.stack.length = 0;
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
    this.frames = 0;
    this.overBudgetFrames = 0;
    this.lastFrameMs = 0;
    this.maxFrameMs = 0;
    this.totalFrameMs = 0;
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
    this.store(span.toRecord(this.correlationId, measured));
    this.closeMarks(span);

    try {
      this.metrics.recordSpanDuration(span.name, measured);
    } catch {
      this.faults += 1;
    }

    return measured;
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
// src/engine/engine-events.ts preserves. No engine module is edited, no engine
// module calls this, and no listener registered here writes to its payload.
// Every engine payload is a detached frozen projection: a write would throw
// inside the emitter's own containment.

/**
 * Subscribes turn and stage spans to an engine emitter.
 *
 * A turn span opens on `move:before` and closes on `state:commit`, whose
 * duration reaches the turn-latency histogram. It closes without a commit in
 * three cases: a move the engine withdrew, which `move:before` reports through
 * its readonly `cancelled` flag; a `move:after` carrying `moved === false`; and
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
  let merges = 0;
  let spawns = 0;
  let detached = false;

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
    span.end({ ...extra, [SPAN_ATTRIBUTES.outcome]: outcome });
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
        stageSpan = tracer.startSpan(SPAN_NAMES.engineStage, {
          parent: null,
          attributes: {
            [SPAN_ATTRIBUTES.stageIndex]: payload.stageIndex,
            [SPAN_ATTRIBUTES.boardSize]: payload.boardSize,
          },
        });
      }),
    ),
  );

  stops.push(
    events.on(
      'move:before',
      guarded('move:before', (payload): void => {
        endTurn(SPAN_OUTCOMES.superseded);
        turnStart = readNow();
        turnSpan = tracer.startSpan(SPAN_NAMES.engineTurn, {
          attributes: {
            [SPAN_ATTRIBUTES.direction]: payload.direction,
            [SPAN_ATTRIBUTES.cancelled]: payload.cancelled,
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

  stops.push(
    events.on(
      'state:commit',
      guarded('state:commit', (payload): void => {
        if (turnSpan === undefined) {
          tracer.reportAnomaly('commit with no turn span open', {
            score: payload.score,
            terminated: payload.terminated,
          });

          return;
        }

        turnSpan.setAttribute(SPAN_ATTRIBUTES.score, payload.score);
        turnSpan.setAttribute(
          SPAN_ATTRIBUTES.terminated,
          payload.terminated,
        );
        endTurn(SPAN_OUTCOMES.committed);
      }),
    ),
  );

  stops.push(
    events.on(
      'stage:end',
      guarded('stage:end', (payload): void => {
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

  return (): void => {
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
    traceRenderCommit: <T>(run: () => T): T =>
      tracer.withSpan(SPAN_NAMES.renderCommit, run),
  });
}
