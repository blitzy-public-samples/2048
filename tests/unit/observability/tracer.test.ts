// Unit suite over src/observability/tracer.ts: the span vocabulary, the span
// lifecycle, the parent stack, the bounded record buffer, the boundary
// wrappers, the frame-callback seam, the engine-event attachment and the
// disabled path.
//
// Validation gate: AAP 0.8.8 V8, second bullet. The boundaries that gate names
// are the members of the module's own `BOUNDARY_SPAN_NAMES`; section 3 iterates
// that list and asserts a record for each member of it.
//
// PROVENANCE of the seams pinned below, as docs/TRACEABILITY_MATRIX.md rows
// them. Each citation states what the cited lines are. docs/DECISION_LOG.md is
// the single source of truth for why anything here was decided this way,
// including the synchronous driving of the frame wrapper.
//   TR-TRACE-01  js/html_actuator.js L13, the frame `actuate` wrapped every
//                DOM write in.
//   TR-TRACE-02  js/html_actuator.js L69, the second frame, nested inside
//                `addTile` under `if (tile.previousPosition)`, which
//                re-applied the position class.
//   TR-TRACE-03  js/application.js L2, the frame construction was deferred
//                to.
//   TR-TRACE-04  js/animframe_polyfill.js L13,
//                `Math.max(0, 16 - (currTime - lastTime))`, which is the 16 of
//                `DEFAULT_FRAME_BUDGET_MS`.
//   TR-TRACE-05  js/game_manager.js L130 and L91-L97, the two boundaries one
//                turn span spans.
//   TR-TRACE-06  js/keyboard_input_manager.js L18-L23, where `on()` created
//                the listener array at L19-L21 and PUSHED at L22, and L25-L32,
//                where `emit()` walked it synchronously with one payload
//                argument.
// None of those three frame sites was measured; sections 4 and 6 measure them.
//
// WHAT THIS SUITE PINS:
//   a measured duration is asserted finite and at or above zero, and never
//     exactly; every exact duration asserted is one the caller supplied to
//     `frameLifecycleHooks().onFrameEnd` or to `recordTurnLatency`;
//   no assertion waits on an animation frame, a timer or the wall clock, and
//     the frame wrapper is invoked directly and synchronously;
//   a throw reaches the caller, and its span is closed and recorded;
//   `setEnabled(false)` stops recording AND every observation this tracer
//     owns, the turn latency included, and leaves the wrapped work running;
//   the Performance API is reached through feature detection alone, so an
//     absent, partial or throwing host degrades and never throws, and the
//     tracer leaves none of its own marks or measures behind;
//   a span identifier sequence is reproducible: one correlation identifier and
//     one call sequence yield one identifier sequence, after a reset and from
//     a second tracer;
//   span durations reach the histograms of src/observability/metrics.ts, and
//     the tracer holds no second aggregate of them.
//
// Coverage owned by sibling suites and not repeated here: the logger's buffer,
// level and sink mechanics (tests/unit/observability/logger.test.ts); the
// registry's primitives, bucket layout and Prometheus exposition
// (tests/unit/observability/metrics.test.ts); the emitter's own `on`, `off` and
// `emit` semantics (tests/unit/engine/engine-events.test.ts); and the hook
// bus's protocol against the real engine collaborators
// (tests/unit/engine/hook-bus.test.ts). The real bus is driven here, and so is
// the collaborator bundle it dispatches with: `createDefaultRulesConfig()`,
// `Grid` and `createRngStreams()`, which is what makes `HookEnvironment`
// satisfied by construction rather than by a cast.
//
// A real `Engine` is driven where the contract under test is between this
// module and src/engine/engine.ts: the no-op turn's completion signal, and the
// four places the engine commits from.
//
// This suite reads no DOM node, writes no storage, awaits nothing and writes no
// snapshot artifact.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ENGINE_EVENT_NAMES,
  createEngineEvents,
} from '../../../src/engine/engine-events';
import type {
  EngineEventName,
  EngineEvents,
  MoveAfterEvent,
  MoveBeforeEvent,
  StageEndEvent,
  StageStartEvent,
  StateCommitEvent,
  TileMergeEvent,
  TileSpawnEvent,
} from '../../../src/engine/engine-events';
import { Grid } from '../../../src/engine/grid';
import { Tile } from '../../../src/engine/tile';
import { createDefaultRulesConfig } from '../../../src/config/default-config';
import { Engine } from '../../../src/engine/engine';
import { createHookBus } from '../../../src/engine/hook-bus';
import type {
  HookBus,
  HookDispatchResult,
} from '../../../src/engine/hook-bus';
import { HOOK_NAMES } from '../../../src/engine/hooks';
import type {
  HookEnvironment,
  HookName,
  SpawnPayload,
} from '../../../src/engine/hooks';
import {
  DIRECTION_LEFT,
  DIRECTION_UP,
  EMPTY_RELIC_CONTEXT,
  EMPTY_STAGE_CONTEXT,
} from '../../../src/engine/types';
import type {
  EngineHookErrorReport,
  EngineListenerErrorReport,
  EngineReporter,
  SerializedGameState,
} from '../../../src/engine/types';
import { createLogger } from '../../../src/observability/logger';
import type { Logger } from '../../../src/observability/logger';
import {
  DEFAULT_DURATION_BUCKETS,
  METRIC_LABELS,
  METRIC_NAMES,
  createMetricsRegistry,
} from '../../../src/observability/metrics';
import type { MetricsRegistry } from '../../../src/observability/metrics';
import {
  BOUNDARY_SPAN_NAMES,
  DEFAULT_FRAME_BUDGET_MS,
  DEFAULT_TRACE_CAPACITY,
  INERT_SPAN,
  SPAN_ATTRIBUTES,
  SPAN_EVENT_NAMES,
  SPAN_NAMES,
  SPAN_NAME_LIST,
  SPAN_OUTCOMES,
  TRACE_SNAPSHOT_SCHEMA_VERSION,
  UNTRACED_COMMIT_PATHS,
  attachEngineTracing,
  createBoundaryTracing,
  createTracer,
  isSpanName,
} from '../../../src/observability/tracer';
import type {
  BoundaryTracing,
  SpanName,
  SpanRecord,
  Tracer,
} from '../../../src/observability/tracer';
import { createRngStreams } from '../../../src/rng/rng-streams';
import { OWNED_STORAGE_KEYS } from '../../../src/storage/storage-keys';
import {
  BLOCKED_BOARD,
  NEAR_WIN_BOARD,
  copyBoard,
  createNearWinBoard,
} from '../../fixtures/boards';

/* ==========================================================================
 * Harness
 * ========================================================================== */

/** Identifier every span, record and report of this suite is keyed under. */
const CORRELATION_ID = 'tracer-suite-correlation';

const RUN_SEED = 'tracer-suite-seed';

const BOARD_SIZE = 4;

/** The hook every dispatch below is driven through. */
const SPAWN_HOOK = 'onSpawn' satisfies HookName;

let logger: Logger;
let registry: MetricsRegistry;
let tracer: Tracer;
let events: EngineEvents;
let bus: HookBus;
let boundary: BoundaryTracing;
let hookErrors: EngineHookErrorReport[] = [];
let listenerErrors: EngineListenerErrorReport[] = [];

/**
 * A reporter satisfying `EngineReporter` that files what it receives into the
 * suite's two arrays. `onCount` is omitted: every member of the interface is
 * optional, and both the emitter and the bus guard its absence.
 */
const capturingReporter: EngineReporter = Object.freeze({
  onHookError: (report: EngineHookErrorReport): void => {
    hookErrors.push(report);
  },
  onListenerError: (report: EngineListenerErrorReport): void => {
    listenerErrors.push(report);
  },
});

/**
 * Reads the mark names the tracer wrote for one correlation identifier.
 *
 * Feature-detected: `performance.getEntriesByType` is absent on some hosts, and
 * the two DOM libraries `vitest.config.ts` selects between differ. An absent
 * reader yields an empty list, which the mark-hygiene case treats as nothing
 * left behind.
 *
 * @param correlationId Identifier the marks are keyed under.
 * @returns The mark names carrying it.
 */
const markNamesFor = (correlationId: string): readonly string[] => {
  const clock: unknown = globalThis.performance;

  if (typeof clock !== 'object' || clock === null) {
    return [];
  }

  const reader: unknown = (clock as Record<string, unknown>).getEntriesByType;

  if (typeof reader !== 'function') {
    return [];
  }

  const entries = (reader as (type: string) => readonly { name: string }[])
    .call(clock, 'mark');

  return entries
    .map((entry) => entry.name)
    .filter((name) => name.includes(correlationId));
};

/**
 * Clears the marks and measures a closed span may have written. Each member is
 * feature-detected, and no assertion in this suite reads a mark or a measure:
 * the two DOM libraries `vitest.config.ts` selects between are not asserted on
 * anywhere here.
 */
const clearPerformanceEntries = (): void => {
  const clock: unknown = globalThis.performance;

  if (typeof clock !== 'object' || clock === null) {
    return;
  }

  for (const member of ['clearMarks', 'clearMeasures']) {
    const callable: unknown = (clock as Record<string, unknown>)[member];

    if (typeof callable === 'function') {
      (callable as () => void).call(clock);
    }
  }
};

beforeEach(() => {
  hookErrors = [];
  listenerErrors = [];
  logger = createLogger({
    correlationId: CORRELATION_ID,
    consoleOutput: false,
  });
  registry = createMetricsRegistry({ logger });
  tracer = createTracer({ logger, metrics: registry });
  events = createEngineEvents({
    correlationId: CORRELATION_ID,
    reporter: capturingReporter,
  });
  bus = createHookBus({
    correlationId: CORRELATION_ID,
    reporter: capturingReporter,
  });
  boundary = createBoundaryTracing(tracer);
  clearPerformanceEntries();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  clearPerformanceEntries();
});

/* ==========================================================================
 * Fixtures
 * ========================================================================== */

/**
 * The three collaborators `HookBus.dispatch` reads, as the REAL modules that
 * own them.
 *
 * `createDefaultRulesConfig()` of src/config/default-config.ts supplies the
 * rules — including the `merge.canMerge` whose operands are `MergeTileView`
 * and not two numbers — `Grid` of src/engine/grid.ts supplies the lattice, and
 * `createRngStreams()` of src/rng/rng-streams.ts supplies the seeded
 * substreams. `HookEnvironment` is satisfied structurally by construction, so
 * no assertion here is written through a cast: a drift between this bundle and
 * the interface the bus reads becomes a compile error rather than a fake that
 * keeps agreeing with itself.
 *
 * @param boardSize Edge length of the lattice. Defaults to `BOARD_SIZE`.
 * @returns The environment one dispatch is driven with.
 */
const createHookEnvironment = (
  boardSize: number = BOARD_SIZE,
): HookEnvironment => ({
  config: { ...createDefaultRulesConfig(), boardSize },
  grid: new Grid(boardSize),
  rng: createRngStreams(RUN_SEED),
});

// The live board every payload carrying one travels with, per AAP Contract 1.
const emptyBoard = (size: number = BOARD_SIZE): Grid => new Grid(size);

const mergeTile = (x: number, y: number, value: number): Tile =>
  new Tile({ x, y }, value);

const stageStartEvent = (stageIndex: number): StageStartEvent => ({
  stageIndex,
  goal: EMPTY_STAGE_CONTEXT.goal,
  seed: RUN_SEED,
  boardSize: BOARD_SIZE,
});

const beforeEvent = (cancelled: boolean): MoveBeforeEvent => ({
  direction: DIRECTION_LEFT,
  board: emptyBoard(),
  cancelled,
});

const mergeEvent = (resultValue: number): TileMergeEvent => ({
  turn: 1,
  source: mergeTile(0, 0, resultValue / 2),
  target: mergeTile(1, 0, resultValue / 2),
  resultValue,
  scoreDelta: resultValue,
});

const spawnEvent = (value: number): TileSpawnEvent => ({
  turn: 1,
  position: { x: 2, y: 3 },
  value,
});

const afterEvent = (moved: boolean): MoveAfterEvent => ({
  turn: 1,
  moved,
  board: emptyBoard(),
  score: 24,
  over: false,
  won: false,
  terminated: false,
});

const stageEndEvent = (stageIndex: number): StageEndEvent => ({
  stageIndex,
  cleared: true,
  score: 24,
});

/**
 * A commit, optionally reporting a stage other than the first.
 *
 * The stage index is a parameter because a commit is the only event that
 * carries the stage on every emission, so it is how a suite expresses a run
 * moving from one stage to the next. Defaulted to `EMPTY_STAGE_CONTEXT`'s own
 * index, which leaves every existing case unchanged.
 *
 * @param score Score the commit reports.
 * @param stageIndex Stage the commit reports, defaulting to the first.
 * @returns The commit payload.
 */
const commitEvent = (
  score: number,
  stageIndex: number = EMPTY_STAGE_CONTEXT.stageIndex,
): StateCommitEvent => ({
  turn: 1,
  degraded: false,
  board: emptyBoard(),
  score,
  bestScore: 0,
  over: false,
  won: false,
  terminated: false,
  stage:
    stageIndex === EMPTY_STAGE_CONTEXT.stageIndex
      ? EMPTY_STAGE_CONTEXT
      : { ...EMPTY_STAGE_CONTEXT, stageIndex },
  relics: EMPTY_RELIC_CONTEXT,
});

/**
 * One emitter per event name, keyed by a mapped type over `EngineEventName`. An
 * event added to or renamed in `ENGINE_EVENT_NAMES` fails to compile here.
 */
const ENGINE_EVENT_EMITTERS: {
  readonly [K in EngineEventName]: (target: EngineEvents) => void;
} = Object.freeze({
  'stage:start': (target): void => {
    target.emit('stage:start', stageStartEvent(0));
  },
  'move:before': (target): void => {
    target.emit('move:before', beforeEvent(false));
  },
  'tile:merge': (target): void => {
    target.emit('tile:merge', mergeEvent(4));
  },
  'tile:spawn': (target): void => {
    target.emit('tile:spawn', spawnEvent(2));
  },
  'move:after': (target): void => {
    target.emit('move:after', afterEvent(true));
  },
  'stage:end': (target): void => {
    target.emit('stage:end', stageEndEvent(0));
  },
  'state:commit': (target): void => {
    target.emit('state:commit', commitEvent(24));
  },
});

/**
 * One coherent stage-and-turn sequence covering every declared event name.
 *
 * The stage span is pushed onto the parent stack before the turn span, and this
 * order drives the commit that closes the turn ahead of the stage end that
 * closes the stage. `ENGINE_EVENT_NAMES` fixes the MEMBERSHIP of this list and a
 * test below asserts the two agree; the ORDER is a property of one turn.
 */
const TURN_SEQUENCE: readonly EngineEventName[] = Object.freeze([
  'stage:start',
  'move:before',
  'tile:merge',
  'tile:spawn',
  'move:after',
  'state:commit',
  'stage:end',
]);

/** Drives one stage and one turn through every declared event name. */
const driveOneTurn = (target: EngineEvents): void => {
  for (const name of TURN_SEQUENCE) {
    ENGINE_EVENT_EMITTERS[name](target);
  }
};

/* ==========================================================================
 * Real engine fixtures
 * ========================================================================== */

/**
 * A real, set-up `Engine` on one of the shared fixture boards.
 *
 * The two contracts of finding M12 and finding M13 are between this module and
 * src/engine/engine.ts, so the cases that pin them drive the engine itself
 * rather than an emission fabricated to match. Everything the engine needs
 * arrives through its options object, so no mocking library is involved.
 *
 * @param board Snapshot to restore.
 * @returns The engine, ready for its first move.
 */
const engineOn = (board: SerializedGameState): Engine => {
  const engine = new Engine({ streams: createRngStreams(RUN_SEED) });

  engine.setup(copyBoard(board));

  return engine;
};

/** An engine whose every move is a no-op. */
const blockedEngine = (): Engine => engineOn(BLOCKED_BOARD);

/* ==========================================================================
 * Record readers
 * ========================================================================== */

const recordsFor = (name: SpanName): readonly SpanRecord[] =>
  tracer.recent().filter((record) => record.name === name);

const oneRecordFor = (name: SpanName): SpanRecord => {
  const held = recordsFor(name);

  expect(held).toHaveLength(1);

  return held[0];
};

const relicOrder = (): readonly unknown[] =>
  recordsFor(SPAN_NAMES.relicHandler).map(
    (record) => record.attributes[SPAN_ATTRIBUTES.relic],
  );

/** What a relic's handler body receives. */
type RelicBody = (payload: SpawnPayload) => void;

/**
 * Registers one subscriber whose `onSpawn` handler runs its body inside a
 * relic-handler span, which is the wrapper a composition root injects.
 */
const registerSpawnRelic = (
  id: string,
  body: RelicBody,
  extra: {
    readonly pickupOrder?: number;
    readonly charges?: number;
  } = {},
): void => {
  const registered = bus.register({
    id,
    ...extra,
    hooks: {
      onSpawn: (payload): void => {
        boundary.traceRelicHandler(SPAWN_HOOK, id, (): void => {
          body(payload);
        });
      },
    },
  });

  expect(registered).toBe(true);
};

/** Dispatches `onSpawn` inside a hook-dispatch span. */
const dispatchSpawn = (value = 2): HookDispatchResult<'onSpawn'> =>
  boundary.traceHookDispatch(SPAWN_HOOK, () =>
    bus.dispatch(SPAWN_HOOK, { value }, createHookEnvironment()),
  );

/* ==========================================================================
 * 1. Span lifecycle, identity and the bounded record buffer
 * ========================================================================== */

describe('Tracer span lifecycle and the bounded record buffer', () => {
  it('opens a span under the name it was asked for, with a present identifier and a finite non-negative start time', () => {
    const span = tracer.startSpan(SPAN_NAMES.engineTurn);

    expect(span.name).toBe(SPAN_NAMES.engineTurn);
    expect(typeof span.id).toBe('string');
    expect(span.id.length).toBeGreaterThan(0);
    expect(span.id.startsWith(CORRELATION_ID)).toBe(true);
    expect(Number.isFinite(span.startTime)).toBe(true);
    expect(span.startTime).toBeGreaterThanOrEqual(0);
    expect(span.ended).toBe(false);
  });

  it('gives every span an identifier no other span of the tracer shares', () => {
    const identifiers = SPAN_NAME_LIST.map((name) => {
      const span = tracer.startSpan(name);

      span.end();

      return span.id;
    });

    expect(new Set(identifiers).size).toBe(identifiers.length);
  });

  it('files a record whose duration is a finite number at or above zero', () => {
    const span = tracer.startSpan(SPAN_NAMES.renderCommit);

    span.end();

    const record = oneRecordFor(SPAN_NAMES.renderCommit);

    expect(Number.isFinite(record.durationMs)).toBe(true);
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
    expect(record.id).toBe(span.id);
    expect(Number.isFinite(record.startTime)).toBe(true);
  });

  it('carries the logger correlation identifier on every record, tying a trace to the logs of the same run', () => {
    expect(tracer.correlationId).toBe(logger.correlationId);

    tracer.withSpan(SPAN_NAMES.inputDispatch, (): void => undefined);
    tracer.withSpan(SPAN_NAMES.renderCommit, (): void => undefined);

    const records = tracer.recent();

    expect(records).toHaveLength(2);

    for (const record of records) {
      expect(record.correlationId).toBe(logger.correlationId);
    }
  });

  it('reflects attributes and events set during the span, and merges the attributes passed to end', () => {
    const span = tracer.startSpan(SPAN_NAMES.engineTurn, {
      attributes: { [SPAN_ATTRIBUTES.direction]: DIRECTION_UP },
    });

    span.setAttribute(SPAN_ATTRIBUTES.score, 128);
    span.addEvent(SPAN_EVENT_NAMES.merge, {
      [SPAN_ATTRIBUTES.resultValue]: 8,
    });
    span.end({ [SPAN_ATTRIBUTES.outcome]: SPAN_OUTCOMES.committed });

    const record = oneRecordFor(SPAN_NAMES.engineTurn);

    expect(record.attributes[SPAN_ATTRIBUTES.direction]).toBe(DIRECTION_UP);
    expect(record.attributes[SPAN_ATTRIBUTES.score]).toBe(128);
    expect(record.attributes[SPAN_ATTRIBUTES.outcome]).toBe(
      SPAN_OUTCOMES.committed,
    );
    expect(record.events).toHaveLength(1);
    expect(record.events[0].name).toBe(SPAN_EVENT_NAMES.merge);
    expect(record.events[0].attributes?.[SPAN_ATTRIBUTES.resultValue]).toBe(8);
    expect(Number.isFinite(record.events[0].timestamp)).toBe(true);
  });

  it('records a caught value on the span without closing it or rethrowing', () => {
    const span = tracer.startSpan(SPAN_NAMES.relicHandler);

    expect(() => {
      span.recordError(new TypeError('handler misbehaved'));
    }).not.toThrow();
    expect(span.ended).toBe(false);
    expect(tracer.recent()).toHaveLength(0);

    span.end();

    const record = oneRecordFor(SPAN_NAMES.relicHandler);

    expect(record.error?.name).toBe('TypeError');
    expect(record.error?.message).toBe('handler misbehaved');
    expect(record.attributes[SPAN_ATTRIBUTES.failed]).toBe(true);
  });

  it('leaves an unended span out of the completed records while counting it as open', () => {
    tracer.startSpan(SPAN_NAMES.engineStage);

    expect(tracer.recent()).toHaveLength(0);

    const snapshot = tracer.snapshot();

    expect(snapshot.started).toBe(1);
    expect(snapshot.ended).toBe(0);
    expect(snapshot.open).toBe(1);
  });

  it('reports a second end without filing a second record or corrupting the record set', () => {
    const span = tracer.startSpan(SPAN_NAMES.moveResolution);

    span.end();
    expect(() => {
      span.end();
    }).not.toThrow();

    expect(recordsFor(SPAN_NAMES.moveResolution)).toHaveLength(1);

    const snapshot = tracer.snapshot();

    expect(snapshot.doubleEnds).toBe(1);
    expect(snapshot.anomalies).toBe(1);
    expect(snapshot.ended).toBe(1);
    expect(snapshot.open).toBe(0);
  });

  it('reports an attribute or event applied after the end and changes the record with neither', () => {
    const span = tracer.startSpan(SPAN_NAMES.renderCommit);

    span.end();
    span.setAttribute(SPAN_ATTRIBUTES.score, 4);
    span.addEvent(SPAN_EVENT_NAMES.spawn);

    const record = oneRecordFor(SPAN_NAMES.renderCommit);

    expect(record.attributes[SPAN_ATTRIBUTES.score]).toBeUndefined();
    expect(record.events).toHaveLength(0);
    expect(tracer.snapshot().anomalies).toBe(2);
  });

  it('returns the inert span and records nothing for a name the vocabulary does not declare', () => {
    const rejected = 'render.frames' as SpanName;

    expect(isSpanName(rejected)).toBe(false);
    expect(tracer.startSpan(rejected)).toBe(INERT_SPAN);
    expect(tracer.recent()).toHaveLength(0);
    expect(tracer.snapshot().anomalies).toBe(1);
  });

  it('respects the record limit that recent is asked for and returns the most recent records', () => {
    for (const name of [
      SPAN_NAMES.inputDispatch,
      SPAN_NAMES.engineTurn,
      SPAN_NAMES.renderCommit,
    ]) {
      tracer.withSpan(name, (): void => undefined);
    }

    expect(tracer.recent()).toHaveLength(3);
    expect(tracer.recent(2).map((record) => record.name)).toEqual([
      SPAN_NAMES.engineTurn,
      SPAN_NAMES.renderCommit,
    ]);
    expect(tracer.recent(0)).toHaveLength(0);
    expect(tracer.recent(99)).toHaveLength(3);
  });

  it('bounds the retained records at the configured capacity however many spans are closed', () => {
    const capacity = 4;
    const bounded = createTracer({ logger, metrics: registry, capacity });
    const closed = capacity * 25;

    for (let index = 0; index < closed; index += 1) {
      bounded.withSpan(SPAN_NAMES.frameCallback, (): void => undefined);
    }

    const snapshot = bounded.snapshot();

    expect(bounded.capacity).toBe(capacity);
    expect(snapshot.capacity).toBe(capacity);
    expect(bounded.recent()).toHaveLength(capacity);
    expect(snapshot.spans).toHaveLength(capacity);
    expect(snapshot.started).toBe(closed);
    expect(snapshot.ended).toBe(closed);
    expect(snapshot.dropped).toBe(closed - capacity);
  });

  it('defaults the capacity to the declared default', () => {
    expect(tracer.capacity).toBe(DEFAULT_TRACE_CAPACITY);
    expect(tracer.frameBudgetMs).toBe(DEFAULT_FRAME_BUDGET_MS);
  });

  it('reports a snapshot consistent with the records it retains', () => {
    tracer.withSpan(SPAN_NAMES.inputDispatch, (): void => undefined);
    tracer.startSpan(SPAN_NAMES.engineStage);

    const snapshot = tracer.snapshot();

    expect(snapshot.schemaVersion).toBe(TRACE_SNAPSHOT_SCHEMA_VERSION);
    expect(snapshot.correlationId).toBe(tracer.correlationId);
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.spans).toEqual(tracer.recent());
    expect(snapshot.started).toBe(2);
    expect(snapshot.ended).toBe(1);
    expect(snapshot.open).toBe(1);
    expect(snapshot.faults).toBe(0);
  });

  it('empties the record store on reset and stays usable afterwards', () => {
    tracer.withSpan(SPAN_NAMES.engineTurn, (): void => undefined);
    tracer.startSpan(SPAN_NAMES.engineStage);

    tracer.reset();

    const cleared = tracer.snapshot();

    expect(tracer.recent()).toHaveLength(0);
    expect(cleared.started).toBe(0);
    expect(cleared.ended).toBe(0);
    expect(cleared.open).toBe(0);
    expect(cleared.dropped).toBe(0);
    expect(cleared.frames.frames).toBe(0);

    tracer.withSpan(SPAN_NAMES.renderCommit, (): void => undefined);

    expect(oneRecordFor(SPAN_NAMES.renderCommit).correlationId).toBe(
      tracer.correlationId,
    );
  });

  it('invalidates a span handle retained across a reset, so no duplicate identifier is filed', () => {
    const retained = tracer.startSpan(SPAN_NAMES.engineTurn);
    const firstId = retained.id;

    tracer.reset();

    expect(tracer.discardedSpanCount()).toBe(1);
    expect(tracer.snapshot().open).toBe(0);

    // The counter has restarted, so this span takes the identifier the
    // discarded one held.
    const reissued = tracer.startSpan(SPAN_NAMES.renderCommit);

    expect(reissued.id).toBe(firstId);

    // Ending the stale handle must file nothing: a record here would carry an
    // identifier the reissued span also carries.
    retained.end();
    retained.setAttribute(SPAN_ATTRIBUTES.score, 99);
    retained.addEvent(SPAN_EVENT_NAMES.merge);
    reissued.end();

    const records = tracer.recent();

    expect(records).toHaveLength(1);
    expect(records[0].name).toBe(SPAN_NAMES.renderCommit);
    expect(records[0].id).toBe(firstId);
    expect(
      records.filter((record) => record.name === SPAN_NAMES.engineTurn),
    ).toHaveLength(0);

    const snapshot = tracer.snapshot();

    expect(snapshot.ended).toBe(1);

    // Reported once, and as a discarded-handle anomaly rather than as a double
    // end, which is a different caller mistake.
    expect(snapshot.anomalies).toBe(1);
    expect(snapshot.doubleEnds).toBe(0);
    expect(snapshot.faults).toBe(0);
  });

  it('records no duration for a span handle ended after a reset', () => {
    const turnSpans = registry.histogram(
      METRIC_NAMES.spanDurationMilliseconds,
      { [METRIC_LABELS.span]: SPAN_NAMES.engineTurn },
    );
    const retained = tracer.startSpan(SPAN_NAMES.engineTurn);

    tracer.reset();
    retained.end();

    expect(turnSpans.count).toBe(0);
    expect(tracer.frameStats().frames).toBe(0);
  });

  it('clears the marks of every span a reset discarded', () => {
    const marked = createTracer({
      logger,
      metrics: registry,
      correlationId: 'reset-mark-hygiene',
    });

    marked.startSpan(SPAN_NAMES.engineTurn);
    marked.startSpan(SPAN_NAMES.hookDispatch);

    expect(markNamesFor('reset-mark-hygiene')).toHaveLength(2);

    marked.reset();

    expect(markNamesFor('reset-mark-hygiene')).toHaveLength(0);
    expect(marked.discardedSpanCount()).toBe(2);
  });

  it('discards a frame span the lifecycle hooks left pending across a reset', () => {
    const hooks = tracer.frameLifecycleHooks();

    hooks.onFrameBegin();
    tracer.reset();

    expect(tracer.snapshot().open).toBe(0);

    // The pending frame span is gone, so the end reports rather than filing a
    // record under an identifier the restarted counter has reissued.
    hooks.onFrameEnd(undefined, 8);

    expect(recordsFor(SPAN_NAMES.frameCallback)).toHaveLength(0);
    expect(tracer.snapshot().anomalies).toBe(1);
  });
});

/* ==========================================================================
 * 2. The parent stack
 * ========================================================================== */

describe('Tracer parent and child linkage', () => {
  it('leaves a root span without a parent and links a child to the span open around it', () => {
    const parent = tracer.startSpan(SPAN_NAMES.engineTurn);
    const child = tracer.startSpan(SPAN_NAMES.hookDispatch);

    expect(parent.parentId).toBeUndefined();
    expect(child.parentId).toBe(parent.id);

    child.end();
    parent.end();

    expect(oneRecordFor(SPAN_NAMES.engineTurn).parentId).toBeUndefined();
    expect(oneRecordFor(SPAN_NAMES.hookDispatch).parentId).toBe(parent.id);
  });

  it('links a three-deep nesting correctly at every level', () => {
    const outer = tracer.startSpan(SPAN_NAMES.engineTurn);
    const middle = tracer.startSpan(SPAN_NAMES.hookDispatch);
    const inner = tracer.startSpan(SPAN_NAMES.relicHandler);

    expect(outer.parentId).toBeUndefined();
    expect(middle.parentId).toBe(outer.id);
    expect(inner.parentId).toBe(middle.id);

    inner.end();
    middle.end();
    outer.end();

    expect(oneRecordFor(SPAN_NAMES.relicHandler).parentId).toBe(middle.id);
    expect(oneRecordFor(SPAN_NAMES.hookDispatch).parentId).toBe(outer.id);
    expect(tracer.snapshot().outOfOrderEnds).toBe(0);
  });

  it('takes an explicit parent over the open span, and opens a root when the parent is null', () => {
    const first = tracer.startSpan(SPAN_NAMES.engineStage);
    const second = tracer.startSpan(SPAN_NAMES.engineTurn);
    const explicit = tracer.startSpan(SPAN_NAMES.renderCommit, {
      parent: first,
    });
    const forcedRoot = tracer.startSpan(SPAN_NAMES.frameCallback, {
      parent: null,
    });

    expect(second.parentId).toBe(first.id);
    expect(explicit.parentId).toBe(first.id);
    expect(forcedRoot.parentId).toBeUndefined();
  });

  /* ---- A detached span: open, recorded, and outside the nesting ---- */

  it('keeps a detached span off the implicit-parent stack', () => {
    const lifecycle = tracer.startSpan(SPAN_NAMES.engineStage, {
      parent: null,
      detached: true,
    });
    const nested = tracer.startSpan(SPAN_NAMES.engineTurn);

    // A span opened while a detached span is open is NOT its child: that
    // detached
    // one never joined the stack, so it never became the innermost open span.
    expect(nested.parentId).toBeUndefined();
    expect(tracer.activeSpan()).toBe(nested);

    nested.end();
    lifecycle.end();

    expect(tracer.snapshot().outOfOrderEnds).toBe(0);
    expect(tracer.snapshot().doubleEnds).toBe(0);
  });

  it('does not unwind the spans open above it when it closes', () => {
    const lifecycle = tracer.startSpan(SPAN_NAMES.engineStage, {
      parent: null,
      detached: true,
    });
    const inFlight = tracer.startSpan(SPAN_NAMES.inputDispatch);
    const inner = tracer.startSpan(SPAN_NAMES.engineTurn);

    // The stage closing MID-TURN is the real sequence: the goal is met during a
    // move, and the stage is resolved from inside that move's commit. The turn
    // and the keypress that caused it are still running, and neither is the
    // stage's child.
    lifecycle.end();

    expect(recordsFor(SPAN_NAMES.inputDispatch)).toHaveLength(0);
    expect(recordsFor(SPAN_NAMES.engineTurn)).toHaveLength(0);

    inner.end();
    inFlight.end();

    // Both closed exactly once, with their own outcomes rather than as unwound
    // orphans, and the tracer reports no anomaly of any kind.
    expect(recordsFor(SPAN_NAMES.engineTurn)).toHaveLength(1);
    expect(
      oneRecordFor(SPAN_NAMES.inputDispatch).attributes[
        SPAN_ATTRIBUTES.unwound
      ],
    ).toBeUndefined();
    expect(tracer.snapshot().doubleEnds).toBe(0);
    expect(tracer.snapshot().outOfOrderEnds).toBe(0);
    expect(tracer.snapshot().anomalies).toBe(0);
  });

  it('counts a detached span as open until it closes', () => {
    const lifecycle = tracer.startSpan(SPAN_NAMES.engineStage, {
      parent: null,
      detached: true,
    });

    // Off the stack is not the same as invisible: a stage being played is an
    // open span, and a surface reporting otherwise would hide it.
    expect(tracer.snapshot().open).toBe(1);

    const nested = tracer.startSpan(SPAN_NAMES.engineTurn);

    expect(tracer.snapshot().open).toBe(2);

    nested.end();

    expect(tracer.snapshot().open).toBe(1);

    lifecycle.end();

    expect(tracer.snapshot().open).toBe(0);
    expect(tracer.snapshot().ended).toBe(2);
  });

  it('records a detached span exactly once however it is closed', () => {
    const lifecycle = tracer.startSpan(SPAN_NAMES.engineStage, {
      detached: true,
    });

    lifecycle.end();
    lifecycle.end();

    expect(recordsFor(SPAN_NAMES.engineStage)).toHaveLength(1);
    expect(tracer.snapshot().doubleEnds).toBe(1);
    expect(tracer.snapshot().open).toBe(0);
  });

  it('reports the innermost open span and reverts to its parent as each closes', () => {
    expect(tracer.activeSpan()).toBeUndefined();

    const parent = tracer.startSpan(SPAN_NAMES.engineTurn);

    expect(tracer.activeSpan()).toBe(parent);

    const child = tracer.startSpan(SPAN_NAMES.hookDispatch);

    expect(tracer.activeSpan()).toBe(child);

    child.end();
    expect(tracer.activeSpan()).toBe(parent);

    parent.end();
    expect(tracer.activeSpan()).toBeUndefined();
  });

  it('returns the value of the wrapped function unchanged and closes its span', () => {
    const marker = { rendered: true };
    const returned = tracer.withSpan(
      SPAN_NAMES.renderCommit,
      (): object => marker,
    );

    expect(returned).toBe(marker);
    expect(tracer.activeSpan()).toBeUndefined();
    expect(oneRecordFor(SPAN_NAMES.renderCommit).error).toBeUndefined();
  });

  it('hands the wrapped function the span it runs inside', () => {
    let seen = '';

    tracer.withSpan(SPAN_NAMES.moveResolution, (span): void => {
      seen = span.id;
      span.setAttribute(SPAN_ATTRIBUTES.moved, true);
    });

    const record = oneRecordFor(SPAN_NAMES.moveResolution);

    expect(record.id).toBe(seen);
    expect(record.attributes[SPAN_ATTRIBUTES.moved]).toBe(true);
  });

  it('rethrows what the wrapped function threw and still closes and records its span', () => {
    const failure = new Error('resolution failed');

    expect(() => {
      tracer.withSpan(SPAN_NAMES.moveResolution, (): never => {
        throw failure;
      });
    }).toThrow(failure);

    const record = oneRecordFor(SPAN_NAMES.moveResolution);

    expect(record.error?.message).toBe('resolution failed');
    expect(record.attributes[SPAN_ATTRIBUTES.failed]).toBe(true);
    expect(tracer.activeSpan()).toBeUndefined();
    expect(tracer.snapshot().open).toBe(0);
  });

  it('leaves the parent stack usable for the next span after a throw', () => {
    expect(() => {
      tracer.withSpan(SPAN_NAMES.hookDispatch, (): never => {
        throw new Error('first failed');
      });
    }).toThrow('first failed');

    const next = tracer.startSpan(SPAN_NAMES.engineTurn);

    expect(next.parentId).toBeUndefined();

    next.end();

    expect(tracer.snapshot().open).toBe(0);
  });

  it('unwinds a child left open when its parent closes first', () => {
    const parent = tracer.startSpan(SPAN_NAMES.engineTurn);
    const orphan = tracer.startSpan(SPAN_NAMES.hookDispatch);

    parent.end();

    const unwound = oneRecordFor(SPAN_NAMES.hookDispatch);
    const snapshot = tracer.snapshot();

    expect(unwound.id).toBe(orphan.id);
    expect(unwound.attributes[SPAN_ATTRIBUTES.outcome]).toBe(
      SPAN_OUTCOMES.unwound,
    );
    expect(unwound.attributes[SPAN_ATTRIBUTES.unwound]).toBe(true);
    expect(snapshot.outOfOrderEnds).toBe(1);
    expect(snapshot.open).toBe(0);
    expect(tracer.activeSpan()).toBeUndefined();
  });
});


/* ==========================================================================
 * 3. Module-boundary coverage, validation gate V8
 * ========================================================================== */

describe('Module-boundary span coverage for validation gate V8', () => {
  it('records a span for every boundary the module declares, driving each one synchronously', () => {
    const detach = attachEngineTracing(events, tracer);

    registerSpawnRelic('boundary-relic', (): void => undefined);

    boundary.traceInput('move', (): void => {
      events.emit('move:before', beforeEvent(false));
      boundary.traceMoveResolution((): void => {
        dispatchSpawn();
      });
      boundary.traceRenderCommit((): void => undefined);
      events.emit('state:commit', commitEvent(8));
    });

    tracer.instrumentFrameCallback((): void => undefined)();
    detach();

    const covered = new Set(tracer.recent().map((record) => record.name));

    expect(BOUNDARY_SPAN_NAMES.length).toBeGreaterThan(0);

    for (const name of BOUNDARY_SPAN_NAMES) {
      expect(covered.has(name)).toBe(true);
    }

    expect(tracer.snapshot().open).toBe(0);
    expect(tracer.snapshot().faults).toBe(0);
  });

  it('nests the hook-dispatch span under the engine turn span and the relic-handler span under the dispatch', () => {
    const detach = attachEngineTracing(events, tracer);

    registerSpawnRelic('nested-relic', (): void => undefined);

    events.emit('move:before', beforeEvent(false));
    dispatchSpawn();
    events.emit('state:commit', commitEvent(8));
    detach();

    const turn = oneRecordFor(SPAN_NAMES.engineTurn);
    const dispatch = oneRecordFor(SPAN_NAMES.hookDispatch);
    const handler = oneRecordFor(SPAN_NAMES.relicHandler);

    expect(turn.parentId).toBeUndefined();
    expect(dispatch.parentId).toBe(turn.id);
    expect(handler.parentId).toBe(dispatch.id);
  });

  it('records one relic-handler span per handler invocation, attributed to the subscriber the real bus invoked', () => {
    const invoked: string[] = [];

    registerSpawnRelic('spawn-doubler', (payload): void => {
      invoked.push(`spawn-doubler:${payload.value}`);
    });

    const result = dispatchSpawn(4);
    const handler = oneRecordFor(SPAN_NAMES.relicHandler);

    expect(invoked).toEqual(['spawn-doubler:4']);
    expect(result.invoked).toBe(1);
    expect(handler.attributes[SPAN_ATTRIBUTES.relic]).toBe('spawn-doubler');
    expect(handler.attributes[SPAN_ATTRIBUTES.hook]).toBe(SPAWN_HOOK);
    expect(HOOK_NAMES).toContain(handler.attributes[SPAN_ATTRIBUTES.hook]);
    expect(oneRecordFor(SPAN_NAMES.hookDispatch).attributes[
      SPAN_ATTRIBUTES.hook
    ]).toBe(SPAWN_HOOK);
  });

  it('files the relic-handler spans in the pickup order the bus dispatched them in', () => {
    const invoked: string[] = [];

    registerSpawnRelic(
      'second-picked',
      (): void => {
        invoked.push('second-picked');
      },
      { pickupOrder: 2 },
    );
    registerSpawnRelic(
      'first-picked',
      (): void => {
        invoked.push('first-picked');
      },
      { pickupOrder: 1 },
    );

    const result = dispatchSpawn();

    expect(invoked).toEqual(['first-picked', 'second-picked']);
    expect(result.invoked).toBe(2);
    expect(relicOrder()).toEqual(['first-picked', 'second-picked']);
  });

  it('files no relic-handler span for a subscription the charge guard skipped, and throws nothing', () => {
    const invoked: string[] = [];

    registerSpawnRelic(
      'charged-relic',
      (): void => {
        invoked.push('charged-relic');
      },
      { pickupOrder: 1, charges: 1 },
    );
    registerSpawnRelic(
      'spent-relic',
      (): void => {
        invoked.push('spent-relic');
      },
      { pickupOrder: 2, charges: 0 },
    );

    const result = dispatchSpawn();
    const snapshot = tracer.snapshot();

    expect(invoked).toEqual(['charged-relic']);
    expect(result.invoked).toBe(1);
    expect(result.skipped).toBe(1);
    expect(relicOrder()).toEqual(['charged-relic']);
    expect(snapshot.faults).toBe(0);
    expect(snapshot.anomalies).toBe(0);
    expect(hookErrors).toHaveLength(0);
  });

  it('carries the error of a throwing handler on its own span, completes the turn, and reports the failure under the run correlation identifier', () => {
    const failure = new Error('relic handler failed');
    const detach = attachEngineTracing(events, tracer);

    registerSpawnRelic(
      'cursed-relic',
      (): never => {
        throw failure;
      },
      { pickupOrder: 1 },
    );
    registerSpawnRelic(
      'steady-relic',
      (): void => undefined,
      { pickupOrder: 2 },
    );

    events.emit('move:before', beforeEvent(false));

    const result = dispatchSpawn();

    events.emit('state:commit', commitEvent(16));
    detach();

    const handlers = recordsFor(SPAN_NAMES.relicHandler);

    expect(handlers).toHaveLength(2);
    expect(handlers[0].attributes[SPAN_ATTRIBUTES.relic]).toBe('cursed-relic');
    expect(handlers[0].error?.message).toBe('relic handler failed');
    expect(handlers[0].attributes[SPAN_ATTRIBUTES.failed]).toBe(true);
    expect(handlers[1].attributes[SPAN_ATTRIBUTES.relic]).toBe('steady-relic');
    expect(handlers[1].error).toBeUndefined();

    expect(result.invoked).toBe(2);
    expect(result.failed).toBe(1);
    expect(bus.degraded()).toEqual(['cursed-relic']);

    expect(hookErrors).toHaveLength(1);
    expect(hookErrors[0].correlationId).toBe(logger.correlationId);
    expect(hookErrors[0].subscriberId).toBe('cursed-relic');
    expect(hookErrors[0].hook).toBe(SPAWN_HOOK);

    expect(oneRecordFor(SPAN_NAMES.hookDispatch).error).toBeUndefined();
    expect(oneRecordFor(SPAN_NAMES.engineTurn).attributes[
      SPAN_ATTRIBUTES.outcome
    ]).toBe(SPAN_OUTCOMES.committed);
    expect(tracer.snapshot().open).toBe(0);
  });

  it('opens and closes a render-commit span inside an ordinary commit subscriber, with no engine module reaching the tracer', () => {
    const rendered: number[] = [];

    events.on('state:commit', (commit): void => {
      boundary.traceRenderCommit((): void => {
        rendered.push(commit.score);
      });
    });

    events.emit('state:commit', commitEvent(64));

    const render = oneRecordFor(SPAN_NAMES.renderCommit);

    expect(rendered).toEqual([64]);
    expect(render.parentId).toBeUndefined();
    expect(listenerErrors).toHaveLength(0);
    expect(tracer.snapshot().open).toBe(0);
  });

  it('attributes an input span to the action it was given', () => {
    const returned = boundary.traceInput('restart', (): string => 'restarted');

    expect(returned).toBe('restarted');
    expect(oneRecordFor(SPAN_NAMES.inputDispatch).attributes[
      SPAN_ATTRIBUTES.action
    ]).toBe('restart');
  });

  it('rethrows out of every boundary wrapper, leaving containment to the caller that owns it', () => {
    const failure = new Error('boundary failed');

    expect(() => {
      boundary.traceInput('move', (): never => {
        throw failure;
      });
    }).toThrow(failure);
    expect(() => {
      boundary.traceMoveResolution((): never => {
        throw failure;
      });
    }).toThrow(failure);
    expect(() => {
      boundary.traceHookDispatch(SPAWN_HOOK, (): never => {
        throw failure;
      });
    }).toThrow(failure);
    expect(() => {
      boundary.traceRelicHandler(SPAWN_HOOK, 'relic', (): never => {
        throw failure;
      });
    }).toThrow(failure);
    expect(() => {
      boundary.traceRenderCommit((): never => {
        throw failure;
      });
    }).toThrow(failure);

    expect(tracer.recent()).toHaveLength(5);

    for (const record of tracer.recent()) {
      expect(record.error?.message).toBe('boundary failed');
    }

    expect(tracer.snapshot().open).toBe(0);
  });

  it('reads and writes no owned storage key while tracing the whole chain', () => {
    const detach = attachEngineTracing(events, tracer);

    registerSpawnRelic('storage-free-relic', (): void => undefined);

    boundary.traceInput('move', (): void => {
      driveOneTurn(events);
      dispatchSpawn();
    });

    tracer.instrumentFrameCallback((): void => undefined)();
    detach();

    expect(OWNED_STORAGE_KEYS.length).toBeGreaterThan(0);

    for (const key of OWNED_STORAGE_KEYS) {
      expect(window.localStorage.getItem(key)).toBeNull();
    }
  });
});


/* ==========================================================================
 * 4. The frame-callback seam: TR-TRACE-01, TR-TRACE-02, TR-TRACE-03
 * ========================================================================== */

describe('The frame-callback seam (TR-TRACE-01, TR-TRACE-02, TR-TRACE-03)', () => {
  it('records one frame span per direct synchronous invocation of the wrapper', () => {
    const inner = vi.fn((): void => undefined);
    const wrapped = tracer.instrumentFrameCallback(inner);

    wrapped();
    wrapped();
    wrapped();

    expect(inner).toHaveBeenCalledTimes(3);
    expect(recordsFor(SPAN_NAMES.frameCallback)).toHaveLength(3);
    expect(tracer.frameStats().frames).toBe(3);
  });

  it('hands the wrapped callback its arguments intact and returns its return value unchanged', () => {
    const context = { frame: 'context-object' };
    const seen: unknown[][] = [];
    const wrapped = tracer.instrumentFrameCallback(
      (...args: readonly unknown[]): object => {
        seen.push([...args]);

        return context;
      },
    );

    expect(wrapped(16.7, 'second', context)).toBe(context);
    expect(seen).toEqual([[16.7, 'second', context]]);

    wrapped();

    expect(seen[1]).toEqual([]);
    expect(recordsFor(SPAN_NAMES.frameCallback)).toHaveLength(2);
  });

  it('numbers each successive frame of one wrapper above the last', () => {
    const wrapped = tracer.instrumentFrameCallback((): void => undefined);

    wrapped();
    wrapped();
    wrapped();

    const numbered = recordsFor(SPAN_NAMES.frameCallback).map(
      (record) => record.attributes[SPAN_ATTRIBUTES.frame],
    );

    expect(numbered).toEqual([1, 2, 3]);
    expect(tracer.frameStats().frames).toBe(3);
  });

  it('opens every frame span as a root, whatever else is open around it', () => {
    const turn = tracer.startSpan(SPAN_NAMES.engineTurn);

    tracer.instrumentFrameCallback((): void => undefined)();

    const frame = oneRecordFor(SPAN_NAMES.frameCallback);

    expect(frame.parentId).toBeUndefined();
    expect(tracer.activeSpan()).toBe(turn);

    turn.end();

    expect(tracer.snapshot().outOfOrderEnds).toBe(0);
  });

  it('closes and records the frame span when the wrapped callback throws, and reports the failure', () => {
    const failure = new Error('frame callback failed');
    const wrapped = tracer.instrumentFrameCallback((): never => {
      throw failure;
    });

    expect(() => {
      wrapped();
    }).toThrow(failure);

    const frame = oneRecordFor(SPAN_NAMES.frameCallback);
    const snapshot = tracer.snapshot();

    expect(frame.error?.message).toBe('frame callback failed');
    expect(frame.attributes[SPAN_ATTRIBUTES.failed]).toBe(true);
    expect(frame.attributes[SPAN_ATTRIBUTES.frame]).toBe(1);
    expect(snapshot.open).toBe(0);
    expect(snapshot.faults).toBe(1);
    expect(tracer.frameStats().frames).toBe(1);
  });

  it('leaves the seam usable for the frame after a throwing one', () => {
    let succeed = false;
    const wrapped = tracer.instrumentFrameCallback((): string => {
      if (!succeed) {
        throw new Error('first frame failed');
      }

      return 'second frame';
    });

    expect(() => {
      wrapped();
    }).toThrow('first frame failed');

    succeed = true;

    expect(wrapped()).toBe('second frame');

    const frames = recordsFor(SPAN_NAMES.frameCallback);

    expect(frames).toHaveLength(2);
    expect(frames[1].error).toBeUndefined();
    expect(frames[1].attributes[SPAN_ATTRIBUTES.frame]).toBe(2);
    expect(tracer.snapshot().open).toBe(0);
  });

  it('adds one frame span per wrapping when the wrapper is applied twice, and calls the callback once', () => {
    const inner = vi.fn((): number => 7);
    const wrapped = tracer.instrumentFrameCallback(
      tracer.instrumentFrameCallback(inner),
    );

    expect(wrapped()).toBe(7);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(recordsFor(SPAN_NAMES.frameCallback)).toHaveLength(2);
    expect(tracer.frameStats().frames).toBe(2);
    expect(tracer.snapshot().open).toBe(0);
    expect(tracer.snapshot().faults).toBe(0);
  });

  it('reports rather than throws when the value handed to the seam is not callable', () => {
    const notCallable = 16 as unknown as () => void;

    expect(tracer.instrumentFrameCallback(notCallable)).toBe(notCallable);
    expect(tracer.snapshot().anomalies).toBe(1);
    expect(tracer.recent()).toHaveLength(0);
  });

  it('classifies a frame the caller measured inside the budget as within it and one beyond it as over it', () => {
    const hooks = tracer.frameLifecycleHooks();

    hooks.onFrameBegin();
    hooks.onFrameEnd(undefined, DEFAULT_FRAME_BUDGET_MS / 2);
    hooks.onFrameBegin();
    hooks.onFrameEnd(undefined, DEFAULT_FRAME_BUDGET_MS * 3);

    const frames = recordsFor(SPAN_NAMES.frameCallback);
    const stats = tracer.frameStats();

    expect(frames).toHaveLength(2);
    expect(frames[0].durationMs).toBe(DEFAULT_FRAME_BUDGET_MS / 2);
    expect(frames[0].attributes[SPAN_ATTRIBUTES.overBudget]).toBe(false);
    expect(frames[0].attributes[SPAN_ATTRIBUTES.budgetMs]).toBe(
      DEFAULT_FRAME_BUDGET_MS,
    );
    expect(frames[1].durationMs).toBe(DEFAULT_FRAME_BUDGET_MS * 3);
    expect(frames[1].attributes[SPAN_ATTRIBUTES.overBudget]).toBe(true);

    expect(stats.frames).toBe(2);
    expect(stats.overBudgetFrames).toBe(1);
    expect(tracer.overBudgetFrameCount()).toBe(1);
    expect(stats.budgetMs).toBe(DEFAULT_FRAME_BUDGET_MS);
    expect(stats.lastFrameMs).toBe(DEFAULT_FRAME_BUDGET_MS * 3);
    expect(stats.maxFrameMs).toBe(DEFAULT_FRAME_BUDGET_MS * 3);
    expect(stats.totalFrameMs).toBe(DEFAULT_FRAME_BUDGET_MS * 3.5);
  });

  it('honours a frame budget the tracer was constructed with', () => {
    const strict = createTracer({
      logger,
      metrics: registry,
      frameBudgetMs: 8,
    });
    const hooks = strict.frameLifecycleHooks();

    hooks.onFrameBegin();
    hooks.onFrameEnd(undefined, 12);

    expect(strict.frameBudgetMs).toBe(8);
    expect(strict.overBudgetFrameCount()).toBe(1);
    expect(strict.recent()[0].attributes[SPAN_ATTRIBUTES.budgetMs]).toBe(8);
  });

  it('supersedes a frame span left open when the next frame begins', () => {
    const hooks = tracer.frameLifecycleHooks();

    hooks.onFrameBegin();
    hooks.onFrameBegin();
    hooks.onFrameEnd(undefined, 4);

    const frames = recordsFor(SPAN_NAMES.frameCallback);

    expect(frames).toHaveLength(2);
    expect(frames[0].attributes[SPAN_ATTRIBUTES.outcome]).toBe(
      SPAN_OUTCOMES.superseded,
    );
    expect(frames[1].durationMs).toBe(4);
    expect(tracer.frameStats().frames).toBe(1);
    expect(tracer.snapshot().open).toBe(0);
  });

  it('reports a frame end that arrives with no frame span open', () => {
    const hooks = tracer.frameLifecycleHooks();

    hooks.onFrameEnd(undefined, 4);

    expect(recordsFor(SPAN_NAMES.frameCallback)).toHaveLength(0);
    expect(tracer.snapshot().anomalies).toBe(1);
    expect(tracer.frameStats().frames).toBe(1);
  });
});


/* ==========================================================================
 * 5. Engine attachment with no engine-side call site: TR-TRACE-05,
 *    TR-TRACE-06
 * ========================================================================== */

describe('attachEngineTracing over the append-only emitter (TR-TRACE-05, TR-TRACE-06)', () => {
  it('leaves the listeners registered before it firing, appending rather than replacing', () => {
    const directions: number[] = [];
    const scores: number[] = [];

    events.on('move:before', (payload): void => {
      directions.push(payload.direction);
    });
    events.on('state:commit', (payload): void => {
      scores.push(payload.score);
    });

    attachEngineTracing(events, tracer);

    events.emit('move:before', beforeEvent(false));
    events.emit('state:commit', commitEvent(48));

    expect(directions).toEqual([DIRECTION_LEFT]);
    expect(scores).toEqual([48]);
    expect(oneRecordFor(SPAN_NAMES.engineTurn).attributes[
      SPAN_ATTRIBUTES.outcome
    ]).toBe(SPAN_OUTCOMES.committed);
    expect(listenerErrors).toHaveLength(0);
  });

  it('opens the turn span at move:before and closes it at state:commit, recording one turn latency for the pair', () => {
    const latency = registry.histogram(METRIC_NAMES.turnLatencyMilliseconds);

    attachEngineTracing(events, tracer);

    events.emit('move:before', beforeEvent(false));

    expect(tracer.snapshot().open).toBe(1);
    expect(tracer.recent()).toHaveLength(0);
    expect(latency.count).toBe(0);

    events.emit('state:commit', commitEvent(48));

    const turn = oneRecordFor(SPAN_NAMES.engineTurn);

    expect(turn.attributes[SPAN_ATTRIBUTES.direction]).toBe(DIRECTION_LEFT);
    expect(turn.attributes[SPAN_ATTRIBUTES.cancelled]).toBe(false);
    expect(turn.attributes[SPAN_ATTRIBUTES.score]).toBe(48);
    expect(turn.attributes[SPAN_ATTRIBUTES.outcome]).toBe(
      SPAN_OUTCOMES.committed,
    );
    expect(Number.isFinite(turn.durationMs)).toBe(true);
    expect(turn.durationMs).toBeGreaterThanOrEqual(0);
    expect(latency.count).toBe(1);

    // ONE span remains open, and it is the STAGE, not the turn. A commit
    // reports the stage in force, and the tracer follows it, so a stage span
    // is open from the first commit until the stage ends or tracing detaches.
    // The turn itself is closed: it has a record and the pair produced exactly
    // one latency observation.
    expect(tracer.snapshot().open).toBe(1);
    expect(recordsFor(SPAN_NAMES.engineStage)).toHaveLength(0);
  });

  it('produces no span from a bare emitter and begins producing them only once tracing subscribes', () => {
    driveOneTurn(events);

    expect(tracer.recent()).toHaveLength(0);

    const bare = tracer.snapshot();

    expect(bare.started).toBe(0);
    expect(bare.ended).toBe(0);
    expect(bare.anomalies).toBe(0);
    expect(registry.histogram(METRIC_NAMES.turnLatencyMilliseconds).count)
      .toBe(0);

    const detach = attachEngineTracing(events, tracer);

    driveOneTurn(events);
    detach();

    expect(tracer.recent().length).toBeGreaterThan(0);
    expect(registry.histogram(METRIC_NAMES.turnLatencyMilliseconds).count)
      .toBe(1);
  });

  it('closes the turn span of a withdrawn move and leaves the turn after it correct', () => {
    const latency = registry.histogram(METRIC_NAMES.turnLatencyMilliseconds);

    attachEngineTracing(events, tracer);

    events.emit('move:before', beforeEvent(true));

    const withdrawn = oneRecordFor(SPAN_NAMES.engineTurn);

    expect(withdrawn.attributes[SPAN_ATTRIBUTES.cancelled]).toBe(true);
    expect(withdrawn.attributes[SPAN_ATTRIBUTES.outcome]).toBe(
      SPAN_OUTCOMES.cancelled,
    );
    expect(tracer.snapshot().open).toBe(0);
    expect(latency.count).toBe(0);

    events.emit('move:before', beforeEvent(false));
    events.emit('state:commit', commitEvent(96));

    const turns = recordsFor(SPAN_NAMES.engineTurn);

    expect(turns).toHaveLength(2);
    expect(turns[1].id).not.toBe(turns[0].id);
    expect(turns[1].attributes[SPAN_ATTRIBUTES.outcome]).toBe(
      SPAN_OUTCOMES.committed,
    );
    expect(turns[1].attributes[SPAN_ATTRIBUTES.score]).toBe(96);
    expect(latency.count).toBe(1);
    expect(tracer.snapshot().doubleEnds).toBe(0);
  });

  it('closes the turn span of a real engine move that changed nothing without recording a latency', () => {
    // Driven through a REAL `Engine` on a blocked board rather than through a
    // fabricated `move:after`: the completion signal this closure depends on
    // has to be one src/engine/engine.ts actually emits, and the no-op branch
    // is the branch that emits it.
    const latency = registry.histogram(METRIC_NAMES.turnLatencyMilliseconds);
    const engine = blockedEngine();

    attachEngineTracing(engine.events, tracer);

    expect(engine.move(DIRECTION_LEFT)).toBe(false);

    const turn = oneRecordFor(SPAN_NAMES.engineTurn);

    expect(turn.attributes[SPAN_ATTRIBUTES.moved]).toBe(false);
    expect(turn.attributes[SPAN_ATTRIBUTES.outcome]).toBe(
      SPAN_OUTCOMES.unmoved,
    );
    expect(latency.count).toBe(0);

    const snapshot = tracer.snapshot();

    expect(snapshot.open).toBe(0);
    expect(snapshot.anomalies).toBe(0);
    expect(snapshot.faults).toBe(0);
  });

  it('leaks no turn span across two consecutive real no-op moves', () => {
    // Without the engine's no-op completion signal the first turn span stayed
    // open and the second `move:before` superseded it, which is the leak this
    // case measures the absence of: two turns, both `unmoved`, none superseded.
    const engine = blockedEngine();

    attachEngineTracing(engine.events, tracer);

    expect(engine.move(DIRECTION_LEFT)).toBe(false);
    expect(engine.move(DIRECTION_LEFT)).toBe(false);

    const turns = recordsFor(SPAN_NAMES.engineTurn);

    expect(turns).toHaveLength(2);

    for (const turn of turns) {
      expect(turn.attributes[SPAN_ATTRIBUTES.outcome]).toBe(
        SPAN_OUTCOMES.unmoved,
      );
    }

    expect(tracer.snapshot().open).toBe(0);
    expect(tracer.snapshot().anomalies).toBe(0);
  });

  it('supersedes a turn span still open when the next move begins', () => {
    attachEngineTracing(events, tracer);

    events.emit('move:before', beforeEvent(false));
    events.emit('move:before', beforeEvent(false));
    events.emit('state:commit', commitEvent(12));

    const turns = recordsFor(SPAN_NAMES.engineTurn);

    expect(turns).toHaveLength(2);
    expect(turns[0].attributes[SPAN_ATTRIBUTES.outcome]).toBe(
      SPAN_OUTCOMES.superseded,
    );
    expect(turns[1].attributes[SPAN_ATTRIBUTES.outcome]).toBe(
      SPAN_OUTCOMES.committed,
    );
    expect(turns[1].id).not.toBe(turns[0].id);

    // The one span still open is the stage the commit reported, which the
    // tracer follows; both turns are closed and neither was ended twice.
    expect(tracer.snapshot().open).toBe(1);
    expect(recordsFor(SPAN_NAMES.engineStage)).toHaveLength(0);
    expect(tracer.snapshot().doubleEnds).toBe(0);
  });

  it('gives two consecutive turns two distinct spans rather than one merged span', () => {
    attachEngineTracing(events, tracer);

    events.emit('move:before', beforeEvent(false));
    events.emit('state:commit', commitEvent(4));
    events.emit('move:before', beforeEvent(false));
    events.emit('state:commit', commitEvent(8));

    const turns = recordsFor(SPAN_NAMES.engineTurn);

    expect(turns).toHaveLength(2);
    expect(new Set(turns.map((record) => record.id)).size).toBe(2);
    expect(turns[0].attributes[SPAN_ATTRIBUTES.score]).toBe(4);
    expect(turns[1].attributes[SPAN_ATTRIBUTES.score]).toBe(8);
    expect(registry.histogram(METRIC_NAMES.turnLatencyMilliseconds).count)
      .toBe(2);
  });

  it('records one span event per tile:merge emission, so two merges in one move carry two', () => {
    attachEngineTracing(events, tracer);

    events.emit('move:before', beforeEvent(false));
    events.emit('tile:merge', mergeEvent(4));
    events.emit('tile:merge', mergeEvent(8));
    events.emit('tile:spawn', spawnEvent(2));
    events.emit('state:commit', commitEvent(12));

    const turn = oneRecordFor(SPAN_NAMES.engineTurn);
    const merges = turn.events.filter(
      (event) => event.name === SPAN_EVENT_NAMES.merge,
    );
    const spawns = turn.events.filter(
      (event) => event.name === SPAN_EVENT_NAMES.spawn,
    );

    expect(merges).toHaveLength(2);
    expect(merges[0].attributes?.[SPAN_ATTRIBUTES.resultValue]).toBe(4);
    expect(merges[1].attributes?.[SPAN_ATTRIBUTES.resultValue]).toBe(8);
    expect(spawns).toHaveLength(1);
    expect(spawns[0].attributes?.[SPAN_ATTRIBUTES.value]).toBe(2);
    expect(spawns[0].attributes?.[SPAN_ATTRIBUTES.inserted]).toBe(true);
    expect(turn.attributes[SPAN_ATTRIBUTES.merges]).toBe(2);
    expect(turn.attributes[SPAN_ATTRIBUTES.spawns]).toBe(1);
    expect(recordsFor(SPAN_NAMES.relicHandler)).toHaveLength(0);
  });

  it('resets the per-turn merge and spawn tallies for the turn that follows', () => {
    attachEngineTracing(events, tracer);

    events.emit('move:before', beforeEvent(false));
    events.emit('tile:merge', mergeEvent(4));
    events.emit('state:commit', commitEvent(4));
    events.emit('move:before', beforeEvent(false));
    events.emit('state:commit', commitEvent(6));

    const turns = recordsFor(SPAN_NAMES.engineTurn);

    expect(turns[0].attributes[SPAN_ATTRIBUTES.merges]).toBe(1);
    expect(turns[1].attributes[SPAN_ATTRIBUTES.merges]).toBe(0);
    expect(turns[1].attributes[SPAN_ATTRIBUTES.spawns]).toBe(0);
  });

  it('opens a stage span at stage:start and closes it at stage:end', () => {
    attachEngineTracing(events, tracer);

    events.emit('stage:start', stageStartEvent(3));

    expect(tracer.snapshot().open).toBe(1);

    events.emit('stage:end', stageEndEvent(3));

    const stage = oneRecordFor(SPAN_NAMES.engineStage);

    expect(stage.parentId).toBeUndefined();
    expect(stage.attributes[SPAN_ATTRIBUTES.stageIndex]).toBe(3);
    expect(stage.attributes[SPAN_ATTRIBUTES.boardSize]).toBe(BOARD_SIZE);
    expect(stage.attributes[SPAN_ATTRIBUTES.cleared]).toBe(true);
    expect(stage.attributes[SPAN_ATTRIBUTES.outcome]).toBe(
      SPAN_OUTCOMES.committed,
    );
    expect(tracer.snapshot().open).toBe(0);
  });

  it('traces every event name the emitter declares over one stage and one turn', () => {
    expect(new Set(TURN_SEQUENCE)).toEqual(new Set(ENGINE_EVENT_NAMES));
    expect(TURN_SEQUENCE).toHaveLength(ENGINE_EVENT_NAMES.length);
    expect(Object.keys(ENGINE_EVENT_EMITTERS).sort()).toEqual(
      [...ENGINE_EVENT_NAMES].sort(),
    );

    const detach = attachEngineTracing(events, tracer);

    driveOneTurn(events);
    detach();

    const stage = oneRecordFor(SPAN_NAMES.engineStage);
    const turn = oneRecordFor(SPAN_NAMES.engineTurn);
    const snapshot = tracer.snapshot();

    // NOT PARENTED TO THE STAGE, and deliberately. A stage span is opened by
    // one event and closed by another many turns later, so it is a LIFECYCLE
    // span rather than a call-nesting one: on the implicit-parent stack it
    // would
    // sit beneath whatever the keypress in flight has open, and closing it —
    // which
    // happens inside the commit of the turn that clears the goal — would unwind
    // that turn and its input dispatch as though they were its children. It is
    // therefore detached, and the association a reader wants travels as an
    // attribute instead. The turn's parent is whatever opened it: nothing here,
    // and the input dispatch in the composed application.
    expect(turn.parentId).toBeUndefined();
    expect(turn.attributes[SPAN_ATTRIBUTES.stageIndex]).toBe(
      stage.attributes[SPAN_ATTRIBUTES.stageIndex],
    );
    expect(turn.attributes[SPAN_ATTRIBUTES.moved]).toBe(true);
    expect(turn.attributes[SPAN_ATTRIBUTES.terminated]).toBe(false);
    expect(turn.attributes[SPAN_ATTRIBUTES.merges]).toBe(1);
    expect(turn.attributes[SPAN_ATTRIBUTES.spawns]).toBe(1);
    expect(turn.attributes[SPAN_ATTRIBUTES.outcome]).toBe(
      SPAN_OUTCOMES.committed,
    );
    expect(turn.events.map((event) => event.name)).toEqual([
      SPAN_EVENT_NAMES.merge,
      SPAN_EVENT_NAMES.spawn,
    ]);
    expect(stage.attributes[SPAN_ATTRIBUTES.outcome]).toBe(
      SPAN_OUTCOMES.committed,
    );

    expect(snapshot.open).toBe(0);
    expect(snapshot.anomalies).toBe(0);
    expect(snapshot.faults).toBe(0);
    expect(snapshot.doubleEnds).toBe(0);
    expect(snapshot.outOfOrderEnds).toBe(0);
  });

  it("accounts the real engine's setup commit as a lifecycle commit, not an anomaly", () => {
    // `setup()` emits `stage:start` and then commits. It is one of the four
    // commit sites src/engine/engine.ts has and only one of them is a move, so
    // treating a commit with no open turn span as a caller fault reported the
    // engine's own lifecycle as broken.
    const engine = new Engine({ streams: createRngStreams(RUN_SEED) });

    attachEngineTracing(engine.events, tracer);
    engine.setup(null);

    const snapshot = tracer.snapshot();

    expect(recordsFor(SPAN_NAMES.engineTurn)).toHaveLength(0);
    expect(snapshot.commits.lifecycle).toBe(1);
    expect(snapshot.commits.turn).toBe(0);
    expect(snapshot.commits.unattributed).toBe(0);
    expect(snapshot.anomalies).toBe(0);

    // The stage span the same `setup()` opened is still open — a stage spans
    // the stage, not the commit — and it is the only span open. It is opened
    // UNSTACKED, so it is not the ACTIVE span: on the stack it would sit beneath
    // whatever the keypress in flight has open, and closing it inside a turn's
    // commit would unwind that turn as though it were its child.
    expect(snapshot.open).toBe(1);
    expect(tracer.activeSpan()).toBeUndefined();
  });

  it("accounts the real engine's restart commit as a lifecycle commit", () => {
    const engine = engineOn(BLOCKED_BOARD);

    attachEngineTracing(engine.events, tracer);
    engine.restart();

    const snapshot = tracer.snapshot();

    expect(snapshot.commits.lifecycle).toBe(1);
    expect(snapshot.commits.unattributed).toBe(0);
    expect(snapshot.anomalies).toBe(0);
  });

  it("accounts the real engine's stage-end commit as a lifecycle commit beside the turn's own", () => {
    // A turn that clears the stage goal commits TWICE: once for the turn, and
    // once from `resolveMetStageGoal()` after it emits `stage:end`. Under the
    // `'engine'` resolution authority the engine takes that second path itself.
    const engine = new Engine({
      streams: createRngStreams(RUN_SEED),
      stageResolution: 'engine',
    });

    // Attached BEFORE `setup()`, so the stage span the stage-end closes was
    // opened by the same engine's own `stage:start`.
    attachEngineTracing(engine.events, tracer);
    engine.setup(createNearWinBoard(BOARD_SIZE, 32));

    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(engine.stageProgress().cleared).toBe(true);

    const snapshot = tracer.snapshot();

    // The setup commit, then the turn's, then the stage-end's.
    expect(snapshot.commits.turn).toBe(1);
    expect(snapshot.commits.lifecycle).toBe(2);
    expect(snapshot.commits.unattributed).toBe(0);
    expect(snapshot.anomalies).toBe(0);
    expect(oneRecordFor(SPAN_NAMES.engineStage).attributes[
      SPAN_ATTRIBUTES.outcome
    ]).toBe(SPAN_OUTCOMES.committed);
  });

  it("accounts continuePlaying's commit as a lifecycle commit when it is reached through the input boundary", () => {
    // js/keyboard_input_manager.js L11 bound `keepPlaying` to this method, and
    // src/main.ts wraps that subscription in an input-dispatch span. The open
    // boundary span is what attributes the commit the method makes.
    const engine = engineOn(NEAR_WIN_BOARD);

    attachEngineTracing(engine.events, tracer);

    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(engine.isGameTerminated()).toBe(true);

    boundary.traceInput('keepPlaying', (): void => {
      engine.continuePlaying();
    });

    const snapshot = tracer.snapshot();

    expect(engine.continuedPlay).toBe(true);
    expect(snapshot.commits.turn).toBe(1);
    expect(snapshot.commits.lifecycle).toBe(1);
    expect(snapshot.commits.unattributed).toBe(0);
    expect(snapshot.anomalies).toBe(0);
  });

  it('accounts a commit that opens the stage it reports as a lifecycle commit', () => {
    // js/game_manager.js L59 actuated from `setup()` before any move, so the
    // first commit of a run arrives with no turn span and opens the span for the
    // stage it reports — and THAT is what accounts for it.
    attachEngineTracing(events, tracer);

    events.emit('state:commit', commitEvent(4));

    const snapshot = tracer.snapshot();

    expect(recordsFor(SPAN_NAMES.engineTurn)).toHaveLength(0);
    expect(snapshot.commits.lifecycle).toBe(1);
    expect(snapshot.commits.unattributed).toBe(0);
    expect(snapshot.commits.turn).toBe(0);
    expect(snapshot.anomalies).toBe(0);

    // The stage this commit opened, still open because nothing has ended it.
    expect(snapshot.open).toBe(1);
  });

  it('accounts a commit no signal explains as unattributed, and reports it', () => {
    // The genuinely orphaned case: a SECOND commit for a stage already spanned,
    // with no turn span, no preceding lifecycle emission and no stage opened by
    // it. `state:commit` carries no commit source — AAP 0.6.1.1 fixes its
    // members — so this is where a lifecycle commit made outside the accounted
    // paths lands too.
    attachEngineTracing(events, tracer);

    events.emit('state:commit', commitEvent(4));
    events.emit('state:commit', commitEvent(8));

    const snapshot = tracer.snapshot();

    expect(snapshot.commits.lifecycle).toBe(1);
    expect(snapshot.commits.unattributed).toBe(1);
    expect(snapshot.commits.turn).toBe(0);

    // COUNTED AND REPORTED, which are different questions: the bucket says what
    // it was, and the anomaly says a state change arrived that nothing explains.
    expect(snapshot.anomalies).toBe(1);
  });

  it('accounts a committed turn as a turn commit', () => {
    attachEngineTracing(events, tracer);

    events.emit('move:before', beforeEvent(false));
    events.emit('state:commit', commitEvent(8));

    expect(tracer.snapshot().commits).toEqual({
      turn: 1,
      lifecycle: 0,
      unattributed: 0,
    });
  });

  it('discards a pending lifecycle attribution once a move begins', () => {
    // A stage start followed by a turn: the turn's commit is the turn's own,
    // and the stage start does not lend it an attribution.
    attachEngineTracing(events, tracer);

    events.emit('stage:start', stageStartEvent(0));
    events.emit('move:before', beforeEvent(false));
    events.emit('state:commit', commitEvent(8));
    events.emit('state:commit', commitEvent(8));

    expect(tracer.snapshot().commits).toEqual({
      turn: 1,
      lifecycle: 0,
      unattributed: 1,
    });
  });

  it('returns the commit counts to zero on reset', () => {
    attachEngineTracing(events, tracer);

    events.emit('state:commit', commitEvent(4));
    tracer.reset();

    expect(tracer.snapshot().commits).toEqual({
      turn: 0,
      lifecycle: 0,
      unattributed: 0,
    });
  });

  it('reports a stage end that arrives with no stage span open', () => {
    attachEngineTracing(events, tracer);

    events.emit('stage:end', stageEndEvent(0));

    expect(recordsFor(SPAN_NAMES.engineStage)).toHaveLength(0);
    expect(tracer.snapshot().anomalies).toBe(1);
  });

  // TWO ENGINE PATHS COMMIT OUTSIDE A TURN BY DESIGN. `Engine.setup()` emits
  // `stage:start` and commits; `Engine.endStage()` emits `stage:end` and
  // commits, after the turn that cleared the goal has already committed and
  // closed its own span. Reporting either as an anomaly warned once per page
  // load and once per cleared stage about correct behaviour, which is what
  // these
  // cases pin shut.
  it('accounts for the commit that closes a stage start', () => {
    attachEngineTracing(events, tracer);

    events.emit('stage:start', stageStartEvent(0));
    events.emit('state:commit', commitEvent(0));

    expect(tracer.snapshot().anomalies).toBe(0);
    expect(recordsFor(SPAN_NAMES.engineTurn)).toHaveLength(0);
  });

  it('accounts for the commit that follows a stage end', () => {
    attachEngineTracing(events, tracer);

    events.emit('stage:start', stageStartEvent(0));
    events.emit('state:commit', commitEvent(0));

    // The turn that cleared the goal: it commits and closes its own span, and
    // the stage-end commit arrives after it.
    events.emit('move:before', beforeEvent(false));
    events.emit('state:commit', commitEvent(56));

    events.emit('stage:end', stageEndEvent(0));
    events.emit('state:commit', commitEvent(56));

    expect(tracer.snapshot().anomalies).toBe(0);
    expect(oneRecordFor(SPAN_NAMES.engineTurn).attributes[
      SPAN_ATTRIBUTES.outcome
    ]).toBe(SPAN_OUTCOMES.committed);
  });

  it('names the path an accounted commit came from, at debug level', () => {
    const records: { message: string; fields?: Record<string, unknown> }[] = [];

    logger.setLevel('debug');
    logger.subscribe((record) => {
      records.push({ message: record.message, fields: record.fields });
    });

    attachEngineTracing(events, tracer);

    events.emit('stage:start', stageStartEvent(2));
    events.emit('state:commit', commitEvent(12));

    const accounted = records.filter(
      (record) => record.message === 'commit outside a turn',
    );

    expect(accounted).toHaveLength(1);
    expect(accounted[0].fields?.path).toBe(UNTRACED_COMMIT_PATHS.stageStart);
    expect(accounted[0].fields?.score).toBe(12);
  });

  it('emits nothing for an accounted commit at the default level', () => {
    const records: string[] = [];

    logger.subscribe((record) => {
      records.push(record.message);
    });

    attachEngineTracing(events, tracer);

    events.emit('stage:start', stageStartEvent(0));
    events.emit('state:commit', commitEvent(0));

    expect(records).not.toContain('commit outside a turn');
    expect(tracer.snapshot().anomalies).toBe(0);
  });

  it('spends the account on one commit and no more', () => {
    attachEngineTracing(events, tracer);

    events.emit('stage:start', stageStartEvent(0));
    events.emit('state:commit', commitEvent(0));

    // A SECOND commit with no turn open and nothing left to account for it: the
    // arm is consumed rather than standing until something else uses it.
    events.emit('state:commit', commitEvent(0));

    expect(tracer.snapshot().anomalies).toBe(1);
  });

  // A STAGE IS SPANNED FOR AS LONG AS IT IS IN FORCE, AND `stage:start` IS NOT
  // ENOUGH TO KNOW THAT. `Engine.setup()` is the only emitter of `stage:start`,
  // so within one run it fires once while `stage:end` fires once per cleared
  // stage: advancing a stage keeps the board and raises the goal rather than
  // setting up again. Following the stage each commit reports is what covers
  // stages 1..N — before it, stage 0 was the only stage ever spanned, every
  // later turn recorded stage 0 as its own, and every later `stage:end`
  // reported
  // an anomaly against a span that had never been opened.
  it('spans each cleared stage in turn without a stage:start for each', () => {
    attachEngineTracing(events, tracer);

    // Stage 0 opens the way a boot opens it.
    events.emit('stage:start', stageStartEvent(0));
    events.emit('state:commit', commitEvent(0, 0));

    // The turn that clears stage 0, then the stage resolving and the commit
    // that reports stage 1 — which is the whole of what the engine emits.
    events.emit('move:before', beforeEvent(false));
    events.emit('state:commit', commitEvent(56, 0));
    events.emit('stage:end', stageEndEvent(0));
    events.emit('state:commit', commitEvent(56, 1));

    // The turn that clears stage 1, with NO `stage:start` for stage 1 anywhere.
    events.emit('move:before', beforeEvent(false));
    events.emit('state:commit', commitEvent(176, 1));
    events.emit('stage:end', stageEndEvent(1));
    events.emit('state:commit', commitEvent(176, 2));

    const stages = recordsFor(SPAN_NAMES.engineStage);

    expect(stages).toHaveLength(2);
    expect(stages[0].attributes[SPAN_ATTRIBUTES.stageIndex]).toBe(0);
    expect(stages[0].attributes[SPAN_ATTRIBUTES.outcome]).toBe(
      SPAN_OUTCOMES.committed,
    );
    expect(stages[1].attributes[SPAN_ATTRIBUTES.stageIndex]).toBe(1);
    expect(stages[1].attributes[SPAN_ATTRIBUTES.outcome]).toBe(
      SPAN_OUTCOMES.committed,
    );

    // NOT ONE ANOMALY across two cleared stages: this is the warning the
    // running game produced on every stage clear after the first.
    expect(tracer.snapshot().anomalies).toBe(0);

    // Stage 2 is in force and open, and it is the only thing open.
    expect(tracer.snapshot().open).toBe(1);
  });

  it('records each turn against the stage in force at the time', () => {
    attachEngineTracing(events, tracer);

    events.emit('stage:start', stageStartEvent(0));
    events.emit('state:commit', commitEvent(0, 0));

    events.emit('move:before', beforeEvent(false));
    events.emit('state:commit', commitEvent(56, 0));
    events.emit('stage:end', stageEndEvent(0));
    events.emit('state:commit', commitEvent(56, 1));

    // A turn played entirely inside stage 1.
    events.emit('move:before', beforeEvent(false));
    events.emit('state:commit', commitEvent(64, 1));

    const turns = recordsFor(SPAN_NAMES.engineTurn);

    expect(turns).toHaveLength(2);
    expect(turns[0].attributes[SPAN_ATTRIBUTES.stageIndex]).toBe(0);
    expect(turns[1].attributes[SPAN_ATTRIBUTES.stageIndex]).toBe(1);
  });

  it('replaces a stage span when a commit reports a stage it left', () => {
    attachEngineTracing(events, tracer);

    events.emit('stage:start', stageStartEvent(3));
    events.emit('state:commit', commitEvent(0, 3));

    // A restart into a different stage: no `stage:end` closes stage 3, so the
    // span it left behind is superseded rather than abandoned open.
    events.emit('state:commit', commitEvent(0, 0));

    const stages = recordsFor(SPAN_NAMES.engineStage);

    expect(stages).toHaveLength(1);
    expect(stages[0].attributes[SPAN_ATTRIBUTES.stageIndex]).toBe(3);
    expect(stages[0].attributes[SPAN_ATTRIBUTES.outcome]).toBe(
      SPAN_OUTCOMES.superseded,
    );
    expect(tracer.snapshot().open).toBe(1);
    expect(tracer.snapshot().doubleEnds).toBe(0);
    expect(tracer.snapshot().outOfOrderEnds).toBe(0);
  });

  it('opens one stage span across many commits of the same stage', () => {
    attachEngineTracing(events, tracer);

    events.emit('stage:start', stageStartEvent(0));

    for (let index = 0; index < 5; index += 1) {
      events.emit('move:before', beforeEvent(false));
      events.emit('state:commit', commitEvent(index * 4, 0));
    }

    expect(recordsFor(SPAN_NAMES.engineStage)).toHaveLength(0);
    expect(recordsFor(SPAN_NAMES.engineTurn)).toHaveLength(5);
    expect(tracer.snapshot().open).toBe(1);
  });

  it('does not let a stage arm outlive the turn that commits', () => {
    attachEngineTracing(events, tracer);

    events.emit('stage:start', stageStartEvent(0));

    // The turn commits FIRST, so it — not the stage start — is what this commit
    // belongs to, and the arm must not survive it.
    events.emit('move:before', beforeEvent(false));
    events.emit('state:commit', commitEvent(8));
    events.emit('state:commit', commitEvent(8));

    expect(tracer.snapshot().anomalies).toBe(1);
  });

  it("produces its spans even when a listener the emitter's own containment catches throws", () => {
    // The subject here is src/engine/engine-events.ts's containment, not this
    // module's `guarded()` wrapper: the listener that throws is an unrelated
    // one. The case below is the one that measures `guarded()`.
    events.on('move:before', (): never => {
      throw new Error('unrelated listener failed');
    });

    attachEngineTracing(events, tracer);

    events.emit('move:before', beforeEvent(false));
    events.emit('state:commit', commitEvent(8));

    expect(listenerErrors).toHaveLength(1);
    expect(listenerErrors[0].correlationId).toBe(CORRELATION_ID);
    expect(listenerErrors[0].event).toBe('move:before');
    expect(oneRecordFor(SPAN_NAMES.engineTurn).attributes[
      SPAN_ATTRIBUTES.outcome
    ]).toBe(SPAN_OUTCOMES.committed);
  });

  it("contains a throw from a tracer method called inside its own attached listener", () => {
    // `guarded()`'s actual subject: a tracer member invoked from INSIDE one of
    // the listeners this function registers. `startSpan` is the member the
    // `move:before` listener calls, so making it throw exercises the wrapper
    // rather than the emitter's containment.
    const seen: string[] = [];

    attachEngineTracing(events, tracer);

    // Registered after the tracing listeners, so its arrival proves the
    // emission continued past the failure.
    events.on('move:before', (): void => {
      seen.push('listener after tracing');
    });

    const spy = vi
      .spyOn(tracer, 'startSpan')
      .mockImplementation((): never => {
        throw new Error('the tracer refused to open a span');
      });

    expect(() => {
      events.emit('move:before', beforeEvent(false));
    }).not.toThrow();

    spy.mockRestore();

    // Nothing escaped: the emitter never saw a listener error, because the
    // wrapper caught it before the emitter's own containment could.
    expect(listenerErrors).toHaveLength(0);

    // The failure was reported rather than swallowed.
    expect(tracer.snapshot().faults).toBe(1);

    // The later listener still ran.
    expect(seen).toEqual(['listener after tracing']);

    // And no turn state leaked: nothing is open, and the commit that follows is
    // not mistaken for the failed turn's — it is accounted as a commit with no
    // turn, and no span is recorded for it.
    expect(tracer.snapshot().open).toBe(0);

    events.emit('state:commit', commitEvent(8));

    expect(recordsFor(SPAN_NAMES.engineTurn)).toHaveLength(0);
    expect(tracer.snapshot().anomalies).toBe(0);

    // Accounted by the stage span it opened, not left as an orphan.
    expect(tracer.snapshot().commits.lifecycle).toBe(1);
    expect(tracer.snapshot().commits.unattributed).toBe(0);
  });

  it('contains a throw from a tracer method called inside the stage listener', () => {
    attachEngineTracing(events, tracer);

    const spy = vi
      .spyOn(tracer, 'reportAnomaly')
      .mockImplementation((): never => {
        throw new Error('the tracer refused to report');
      });

    expect(() => {
      // No stage span is open, so the listener reaches `reportAnomaly`.
      events.emit('stage:end', stageEndEvent(0));
    }).not.toThrow();

    spy.mockRestore();

    expect(listenerErrors).toHaveLength(0);
    expect(tracer.snapshot().faults).toBe(1);
    expect(tracer.snapshot().open).toBe(0);
  });

  it('stops producing spans once detached and leaves the other listeners in place', () => {
    const scores: number[] = [];

    events.on('state:commit', (payload): void => {
      scores.push(payload.score);
    });

    const detach = attachEngineTracing(events, tracer);

    events.emit('move:before', beforeEvent(false));
    events.emit('state:commit', commitEvent(4));

    const produced = tracer.recent().length;

    expect(produced).toBeGreaterThan(0);

    detach();
    detach();

    // Detaching closes the stage span the commit above opened and that closure
    // produces its record. Counted here rather than against `produced`, because
    // what this case is about is the EMITTER: nothing emitted after detaching
    // may produce a span, and the detach's own bookkeeping is not an emission.
    const afterDetach = tracer.recent().length;

    expect(afterDetach).toBeGreaterThanOrEqual(produced);

    events.emit('move:before', beforeEvent(false));
    events.emit('state:commit', commitEvent(8));

    expect(tracer.recent()).toHaveLength(afterDetach);
    expect(scores).toEqual([4, 8]);
    expect(tracer.snapshot().faults).toBe(0);
  });

  it('closes a turn and a stage span left open when tracing detaches', () => {
    const detach = attachEngineTracing(events, tracer);

    events.emit('stage:start', stageStartEvent(1));
    events.emit('move:before', beforeEvent(false));

    expect(tracer.snapshot().open).toBe(2);

    detach();

    expect(tracer.snapshot().open).toBe(0);
    expect(oneRecordFor(SPAN_NAMES.engineTurn).attributes[
      SPAN_ATTRIBUTES.outcome
    ]).toBe(SPAN_OUTCOMES.detached);
    expect(oneRecordFor(SPAN_NAMES.engineStage).attributes[
      SPAN_ATTRIBUTES.outcome
    ]).toBe(SPAN_OUTCOMES.detached);
    expect(registry.histogram(METRIC_NAMES.turnLatencyMilliseconds).count)
      .toBe(0);
  });

  it('takes the emitter and the tracer alone, and lets two tracers observe one emitter', () => {
    const second = createTracer({ logger, metrics: registry });
    const detachFirst = attachEngineTracing(events, tracer);
    const detachSecond = attachEngineTracing(events, second);

    events.emit('move:before', beforeEvent(false));
    events.emit('state:commit', commitEvent(20));

    detachFirst();
    detachSecond();

    expect(recordsFor(SPAN_NAMES.engineTurn)).toHaveLength(1);
    expect(
      second.recent().filter((record) => record.name === SPAN_NAMES.engineTurn),
    ).toHaveLength(1);
    expect(listenerErrors).toHaveLength(0);
  });
});


/* ==========================================================================
 * 6. Durations in the metrics histograms and nowhere else: TR-TRACE-04
 * ========================================================================== */

describe('Span durations in the metrics histograms (TR-TRACE-04)', () => {
  it('observes every frame the seam measured into the frame-time histogram and the frame counter', () => {
    const frameTime = registry.histogram(METRIC_NAMES.frameTimeMilliseconds);
    const wrapped = tracer.instrumentFrameCallback((): void => undefined);
    const frames = 5;

    for (let index = 0; index < frames; index += 1) {
      wrapped();
    }

    expect(frameTime.count).toBe(frames);
    expect(registry.counter(METRIC_NAMES.framesRenderedTotal).value).toBe(
      frames,
    );
    expect(frameTime.sum).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(frameTime.sum)).toBe(true);
  });

  it('observes a caller-measured frame duration into the frame-time histogram exactly once', () => {
    const frameTime = registry.histogram(METRIC_NAMES.frameTimeMilliseconds);
    const hooks = tracer.frameLifecycleHooks();
    const measured = [2, 8, 12];

    for (const duration of measured) {
      hooks.onFrameBegin();
      hooks.onFrameEnd(undefined, duration);
    }

    expect(frameTime.count).toBe(measured.length);
    expect(frameTime.sum).toBeCloseTo(22, 6);
    expect(tracer.frameStats().totalFrameMs).toBeCloseTo(frameTime.sum, 6);
  });

  it('places a frame inside the budget in the sixteen-millisecond bucket of the shared layout', () => {
    const budgetIndex = DEFAULT_DURATION_BUCKETS.indexOf(
      DEFAULT_FRAME_BUDGET_MS,
    );

    expect(budgetIndex).toBeGreaterThanOrEqual(0);

    const frameTime = registry.histogram(METRIC_NAMES.frameTimeMilliseconds);
    const hooks = tracer.frameLifecycleHooks();

    hooks.onFrameBegin();
    hooks.onFrameEnd(undefined, DEFAULT_FRAME_BUDGET_MS - 4);

    expect(frameTime.buckets[budgetIndex]).toBe(DEFAULT_FRAME_BUDGET_MS);
    expect(frameTime.bucketCounts[budgetIndex]).toBe(1);
    expect(frameTime.count).toBe(1);
  });

  it('observes one turn latency per committed turn and none for a turn that never commits', () => {
    const latency = registry.histogram(METRIC_NAMES.turnLatencyMilliseconds);
    const detach = attachEngineTracing(events, tracer);

    events.emit('move:before', beforeEvent(false));
    events.emit('state:commit', commitEvent(4));

    expect(latency.count).toBe(1);

    events.emit('move:before', beforeEvent(true));
    events.emit('move:before', beforeEvent(false));
    events.emit('move:after', afterEvent(false));
    detach();

    expect(latency.count).toBe(1);
    expect(latency.sum).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(latency.sum)).toBe(true);
  });

  it('observes a turn latency the caller reports directly', () => {
    const latency = registry.histogram(METRIC_NAMES.turnLatencyMilliseconds);

    tracer.recordTurnLatency(24);
    tracer.recordTurnLatency(8);

    expect(latency.count).toBe(2);
    expect(latency.sum).toBeCloseTo(32, 6);
    expect(tracer.snapshot().faults).toBe(0);
  });

  it('observes every closed span into the span-duration histogram under its own name', () => {
    tracer.withSpan(SPAN_NAMES.renderCommit, (): void => undefined);
    tracer.withSpan(SPAN_NAMES.renderCommit, (): void => undefined);
    tracer.withSpan(SPAN_NAMES.inputDispatch, (): void => undefined);

    const renderSeries = registry.histogram(
      METRIC_NAMES.spanDurationMilliseconds,
      { [METRIC_LABELS.span]: SPAN_NAMES.renderCommit },
    );
    const inputSeries = registry.histogram(
      METRIC_NAMES.spanDurationMilliseconds,
      { [METRIC_LABELS.span]: SPAN_NAMES.inputDispatch },
    );

    expect(renderSeries.count).toBe(2);
    expect(inputSeries.count).toBe(1);
    expect(renderSeries.sum).toBeGreaterThanOrEqual(0);
  });

  it('keeps no aggregate of durations beside the registry that could disagree with it', () => {
    const frameTime = registry.histogram(METRIC_NAMES.frameTimeMilliseconds);
    const hooks = tracer.frameLifecycleHooks();
    const measured = [1, 4, 20];

    for (const duration of measured) {
      hooks.onFrameBegin();
      hooks.onFrameEnd(undefined, duration);
    }

    const snapshot = tracer.snapshot();
    const surfaced = [
      ...Object.keys(snapshot),
      ...Object.keys(snapshot.frames),
    ].map((key) => key.toLowerCase());

    // The tracer's surface carries individual records plus the frame summary,
    // and no distribution of its own.
    for (const forbidden of ['bucket', 'histogram', 'quantile', 'percentile']) {
      expect(surfaced.some((key) => key.includes(forbidden))).toBe(false);
    }

    for (const record of snapshot.spans) {
      expect(Number.isFinite(record.durationMs)).toBe(true);
    }

    // The summary it does keep reports the same frames the registry counted and
    // the same total it summed.
    expect(snapshot.frames.frames).toBe(frameTime.count);
    expect(snapshot.frames.totalFrameMs).toBeCloseTo(frameTime.sum, 6);
    expect(snapshot.frames.maxFrameMs).toBe(20);
    expect(snapshot.frames.overBudgetFrames).toBe(1);
    expect(frameTime.count).toBe(measured.length);
  });

  it('reconciles the per-hook dispatch counts with the relic-handler spans recorded', () => {
    const dispatches = 3;

    registerSpawnRelic('reconciled-first', (): void => undefined, {
      pickupOrder: 1,
    });
    registerSpawnRelic('reconciled-second', (): void => undefined, {
      pickupOrder: 2,
    });

    for (let index = 0; index < dispatches; index += 1) {
      dispatchSpawn();
    }

    const handlerSpans = recordsFor(SPAN_NAMES.relicHandler);
    const dispatchSpans = recordsFor(SPAN_NAMES.hookDispatch);
    const busMetrics = bus.metrics();

    expect(handlerSpans).toHaveLength(dispatches * 2);
    expect(dispatchSpans).toHaveLength(dispatches);
    expect(busMetrics.correlationId).toBe(tracer.correlationId);
    expect(busMetrics.hooks[SPAWN_HOOK].dispatched).toBe(dispatchSpans.length);
    expect(busMetrics.hooks[SPAWN_HOOK].invoked).toBe(handlerSpans.length);
    expect(busMetrics.hooks[SPAWN_HOOK].failed).toBe(0);

    registry.foldHookDispatchCounts(busMetrics);

    expect(
      registry.counter(METRIC_NAMES.hookDispatchesTotal, {
        [METRIC_LABELS.hook]: SPAWN_HOOK,
      }).value,
    ).toBe(dispatchSpans.length);
    expect(
      registry.counter(METRIC_NAMES.hookHandlerInvocationsTotal, {
        [METRIC_LABELS.hook]: SPAWN_HOOK,
      }).value,
    ).toBe(handlerSpans.length);
    expect(
      registry.histogram(METRIC_NAMES.spanDurationMilliseconds, {
        [METRIC_LABELS.span]: SPAN_NAMES.relicHandler,
      }).count,
    ).toBe(handlerSpans.length);
  });

  it('reconciles a skipped handler across the bus counts and the absent spans', () => {
    registerSpawnRelic('with-charge', (): void => undefined, {
      pickupOrder: 1,
      charges: 2,
    });
    registerSpawnRelic('without-charge', (): void => undefined, {
      pickupOrder: 2,
      charges: 0,
    });

    dispatchSpawn();

    const busMetrics = bus.metrics();

    registry.foldHookDispatchCounts(busMetrics);

    expect(recordsFor(SPAN_NAMES.relicHandler)).toHaveLength(1);
    expect(busMetrics.hooks[SPAWN_HOOK].invoked).toBe(1);
    expect(busMetrics.hooks[SPAWN_HOOK].skippedExhausted).toBe(1);
    expect(
      registry.counter(METRIC_NAMES.hookHandlerInvocationsTotal, {
        [METRIC_LABELS.hook]: SPAWN_HOOK,
      }).value,
    ).toBe(1);
    expect(
      registry.counter(METRIC_NAMES.hookHandlerSkippedTotal, {
        [METRIC_LABELS.hook]: SPAWN_HOOK,
        [METRIC_LABELS.reason]: 'exhausted',
      }).value,
    ).toBe(1);
  });

  it('contains a registry that throws rather than letting it reach the caller', () => {
    const failing = createMetricsRegistry({ logger });

    vi.spyOn(failing, 'recordSpanDuration').mockImplementation((): never => {
      throw new Error('registry unavailable');
    });
    vi.spyOn(failing, 'recordFrame').mockImplementation((): never => {
      throw new Error('registry unavailable');
    });
    vi.spyOn(failing, 'recordTurnLatency').mockImplementation((): never => {
      throw new Error('registry unavailable');
    });

    const guarded = createTracer({ logger, metrics: failing });

    expect(() => {
      guarded.withSpan(SPAN_NAMES.renderCommit, (): void => undefined);
      guarded.instrumentFrameCallback((): void => undefined)();
      guarded.recordTurnLatency(8);
    }).not.toThrow();

    expect(guarded.recent().length).toBeGreaterThan(0);
    expect(guarded.snapshot().faults).toBeGreaterThan(0);
  });
});

/* ==========================================================================
 * 7. Disabled tracing
 * ========================================================================== */

describe('Disabled tracing', () => {
  it('runs the wrapped function and returns its value while recording nothing', () => {
    tracer.setEnabled(false);

    const run = vi.fn((): string => 'work done');

    expect(tracer.isEnabled()).toBe(false);
    expect(tracer.withSpan(SPAN_NAMES.engineTurn, run)).toBe('work done');
    expect(run).toHaveBeenCalledTimes(1);
    expect(tracer.recent()).toHaveLength(0);

    const snapshot = tracer.snapshot();

    expect(snapshot.enabled).toBe(false);
    expect(snapshot.started).toBe(0);
    expect(snapshot.ended).toBe(0);
    expect(snapshot.open).toBe(0);
    expect(snapshot.anomalies).toBe(0);
    expect(snapshot.faults).toBe(0);
  });

  it('still rethrows what the wrapped function threw while disabled', () => {
    tracer.setEnabled(false);

    const failure = new Error('work failed');

    expect(() => {
      tracer.withSpan(SPAN_NAMES.hookDispatch, (): never => {
        throw failure;
      });
    }).toThrow(failure);
    expect(tracer.recent()).toHaveLength(0);
  });

  it('returns a usable inert span whose members change nothing', () => {
    tracer.setEnabled(false);

    const span = tracer.startSpan(SPAN_NAMES.renderCommit);

    expect(span).toBe(INERT_SPAN);
    expect(span.name).toBe(SPAN_NAMES.inert);
    expect(span.id).toBe('');
    expect(span.parentId).toBeUndefined();
    expect(span.startTime).toBe(0);
    expect(span.ended).toBe(true);

    expect(() => {
      span.setAttribute(SPAN_ATTRIBUTES.action, 'move');
      span.addEvent(SPAN_EVENT_NAMES.error);
      span.recordError(new Error('ignored'));
      span.end({ [SPAN_ATTRIBUTES.outcome]: SPAN_OUTCOMES.committed });
      span.end();
    }).not.toThrow();

    expect(tracer.recent()).toHaveLength(0);
    expect(tracer.activeSpan()).toBeUndefined();
    expect(tracer.snapshot().doubleEnds).toBe(0);
  });

  it('stops observing the duration histograms for work started while disabled', () => {
    const frameTime = registry.histogram(METRIC_NAMES.frameTimeMilliseconds);
    const spanSeries = registry.histogram(
      METRIC_NAMES.spanDurationMilliseconds,
      { [METRIC_LABELS.span]: SPAN_NAMES.renderCommit },
    );
    const hooks = tracer.frameLifecycleHooks();

    hooks.onFrameBegin();
    hooks.onFrameEnd(undefined, 4);
    tracer.withSpan(SPAN_NAMES.renderCommit, (): void => undefined);

    expect(frameTime.count).toBe(1);
    expect(spanSeries.count).toBe(1);

    tracer.setEnabled(false);

    hooks.onFrameBegin();
    hooks.onFrameEnd(undefined, 4);
    tracer.withSpan(SPAN_NAMES.renderCommit, (): void => undefined);
    tracer.instrumentFrameCallback((): void => undefined)();

    expect(frameTime.count).toBe(1);
    expect(spanSeries.count).toBe(1);
    expect(registry.counter(METRIC_NAMES.framesRenderedTotal).value).toBe(1);
    expect(tracer.frameStats().frames).toBe(1);
  });

  it('returns the frame callback untouched and passes its arguments and value through', () => {
    tracer.setEnabled(false);

    const inner = vi.fn((timestamp: number): number => timestamp * 2);
    const wrapped = tracer.instrumentFrameCallback(inner);

    expect(wrapped).toBe(inner);
    expect(wrapped(21)).toBe(42);
    expect(inner).toHaveBeenCalledWith(21);
    expect(tracer.recent()).toHaveLength(0);
    expect(tracer.frameStats().frames).toBe(0);
  });

  it('runs the callback of a wrapper made before disabling, and records nothing for it', () => {
    const inner = vi.fn((timestamp: number): number => timestamp + 1);
    const wrapped = tracer.instrumentFrameCallback(inner);

    tracer.setEnabled(false);

    expect(wrapped(41)).toBe(42);
    expect(inner).toHaveBeenCalledWith(41);
    expect(tracer.recent()).toHaveLength(0);
    expect(tracer.frameStats().frames).toBe(0);
  });

  it('records no span from an engine emitter while disabled and resumes when re-enabled', () => {
    const detach = attachEngineTracing(events, tracer);

    tracer.setEnabled(false);
    driveOneTurn(events);

    expect(tracer.recent()).toHaveLength(0);
    expect(tracer.snapshot().started).toBe(0);
    expect(tracer.snapshot().anomalies).toBe(0);

    tracer.setEnabled(true);
    driveOneTurn(events);
    detach();

    expect(recordsFor(SPAN_NAMES.engineTurn)).toHaveLength(1);
    expect(recordsFor(SPAN_NAMES.engineStage)).toHaveLength(1);
    expect(tracer.snapshot().doubleEnds).toBe(0);
  });

  it('observes no turn latency while disabled, and the application work still runs', () => {
    // `setEnabled(false)` stops EVERY observation this tracer owns, not span
    // creation alone: a disabled tracer must leave the histograms of
    // src/observability/metrics.ts exactly where they stood. What must not stop
    // is the application's own work, so the emitter's other listener runs.
    const latency = registry.histogram(METRIC_NAMES.turnLatencyMilliseconds);
    const scores: number[] = [];

    events.on('state:commit', (payload): void => {
      scores.push(payload.score);
    });

    const detach = attachEngineTracing(events, tracer);

    tracer.setEnabled(false);

    events.emit('move:before', beforeEvent(false));
    events.emit('state:commit', commitEvent(8));
    detach();

    expect(latency.count).toBe(0);
    expect(latency.sum).toBe(0);
    expect(scores).toEqual([8]);
    expect(tracer.recent()).toHaveLength(0);
    expect(
      registry.histogram(METRIC_NAMES.spanDurationMilliseconds, {
        [METRIC_LABELS.span]: SPAN_NAMES.engineTurn,
      }).count,
    ).toBe(0);
    expect(tracer.snapshot().frames.frames).toBe(0);
  });

  it('resumes observing the turn latency once re-enabled', () => {
    const latency = registry.histogram(METRIC_NAMES.turnLatencyMilliseconds);
    const detach = attachEngineTracing(events, tracer);

    tracer.setEnabled(false);
    events.emit('move:before', beforeEvent(false));
    events.emit('state:commit', commitEvent(8));

    expect(latency.count).toBe(0);

    tracer.setEnabled(true);
    events.emit('move:before', beforeEvent(false));
    events.emit('state:commit', commitEvent(16));
    detach();

    expect(latency.count).toBe(1);
    expect(latency.sum).toBeGreaterThanOrEqual(0);
    expect(recordsFor(SPAN_NAMES.engineTurn)).toHaveLength(1);
  });

  it('observes nothing for a direct recordTurnLatency call while disabled', () => {
    const latency = registry.histogram(METRIC_NAMES.turnLatencyMilliseconds);

    tracer.setEnabled(false);
    tracer.recordTurnLatency(12.5);

    expect(latency.count).toBe(0);

    tracer.setEnabled(true);
    tracer.recordTurnLatency(12.5);

    expect(latency.count).toBe(1);
    expect(latency.sum).toBe(12.5);
  });

  it('resumes recording on re-enable and leaves the records taken before it untouched', () => {
    tracer.withSpan(SPAN_NAMES.inputDispatch, (): void => undefined);

    const before = tracer.recent();

    expect(before).toHaveLength(1);

    tracer.setEnabled(false);
    tracer.withSpan(SPAN_NAMES.inputDispatch, (): void => undefined);

    expect(tracer.recent()).toHaveLength(1);

    tracer.setEnabled(true);
    tracer.withSpan(SPAN_NAMES.renderCommit, (): void => undefined);

    const after = tracer.recent();

    expect(after).toHaveLength(2);
    expect(after[0]).toBe(before[0]);
    expect(after[1].name).toBe(SPAN_NAMES.renderCommit);
  });

  it('closes a span that was already open when tracing was disabled', () => {
    const span = tracer.startSpan(SPAN_NAMES.engineStage);

    tracer.setEnabled(false);
    span.end();

    expect(oneRecordFor(SPAN_NAMES.engineStage).id).toBe(span.id);
    expect(tracer.snapshot().open).toBe(0);
  });

  it('starts disabled when constructed so, and records nothing until enabled', () => {
    const dormant = createTracer({
      logger,
      metrics: registry,
      enabled: false,
    });

    expect(dormant.isEnabled()).toBe(false);
    expect(dormant.withSpan(SPAN_NAMES.renderCommit, (): number => 3)).toBe(3);
    expect(dormant.recent()).toHaveLength(0);

    dormant.setEnabled(true);
    dormant.withSpan(SPAN_NAMES.renderCommit, (): void => undefined);

    expect(dormant.recent()).toHaveLength(1);
  });

  it('reports rather than accepts an enabled flag that is not a boolean', () => {
    tracer.setEnabled('yes' as unknown as boolean);

    expect(tracer.isEnabled()).toBe(true);
    expect(tracer.snapshot().anomalies).toBe(1);
  });
});


/* ==========================================================================
 * 8. The Performance API boundary and identifier determinism
 * ========================================================================== */

/** Prefix every mark and measure this module writes carries. */
const MARK_PREFIX = 'game2048.span:';

/** One recorded call on a Performance-API double. */
interface PerformanceCall {
  readonly member: string;
  readonly args: readonly unknown[];
}

/** A Performance-API double and the calls it received. */
interface PerformanceDouble {
  readonly calls: PerformanceCall[];

  /** Names currently held, in the order they were written. */
  readonly marks: string[];
  readonly measures: string[];
  readonly host: Record<string, unknown>;
}

/**
 * Builds a Performance-API double carrying only the members named.
 *
 * `now` is always present because the tracer reads a clock through it and every
 * duration assertion below depends on one; every other member is opt-in, which
 * is how the absent and partial hosts are expressed.
 *
 * @param members Members to offer beside `now`.
 * @param throwing Members that throw when called.
 * @returns The double.
 */
const createPerformanceDouble = (
  members: readonly string[],
  throwing: readonly string[] = [],
): PerformanceDouble => {
  const calls: PerformanceCall[] = [];
  const marks: string[] = [];
  const measures: string[] = [];
  const host: Record<string, unknown> = {};
  let clock = 0;

  host.now = (): number => {
    clock += 1;

    return clock;
  };

  const record = (member: string, args: readonly unknown[]): void => {
    calls.push({ member, args });

    if (throwing.includes(member)) {
      throw new Error(`performance.${member} refused`);
    }
  };

  if (members.includes('mark')) {
    host.mark = (name: string): void => {
      record('mark', [name]);
      marks.push(name);
    };
  }

  if (members.includes('measure')) {
    host.measure = (name: string, start: string, end: string): void => {
      record('measure', [name, start, end]);
      measures.push(name);
    };
  }

  if (members.includes('clearMarks')) {
    host.clearMarks = (name?: string): void => {
      record('clearMarks', [name]);

      for (let index = marks.length - 1; index >= 0; index -= 1) {
        if (name === undefined || marks[index] === name) {
          marks.splice(index, 1);
        }
      }
    };
  }

  if (members.includes('clearMeasures')) {
    host.clearMeasures = (name?: string): void => {
      record('clearMeasures', [name]);

      for (let index = measures.length - 1; index >= 0; index -= 1) {
        if (name === undefined || measures[index] === name) {
          measures.splice(index, 1);
        }
      }
    };
  }

  return { calls, marks, measures, host };
};

/** Every member the tracer reaches for on `performance`. */
const EVERY_PERFORMANCE_MEMBER: readonly string[] = Object.freeze([
  'mark',
  'measure',
  'clearMarks',
  'clearMeasures',
]);

describe('The Performance API boundary', () => {
  it('opens, closes and records spans with no Performance API at all', () => {
    // The bare Node environment the `unit:dom-free` project runs in offers no
    // `performance` at all in older hosts, and the tracer has to degrade rather
    // than throw. `readNow()` falls back to the two clocks.
    vi.stubGlobal('performance', undefined);

    const bare = createTracer({ logger, metrics: registry });

    expect(() => {
      bare.withSpan(SPAN_NAMES.inputDispatch, (): void => undefined);
    }).not.toThrow();

    const records = bare.recent();

    expect(records).toHaveLength(1);
    expect(records[0].name).toBe(SPAN_NAMES.inputDispatch);
    expect(Number.isFinite(records[0].durationMs)).toBe(true);
    expect(records[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(bare.snapshot().faults).toBe(0);
    expect(bare.snapshot().anomalies).toBe(0);
  });

  it('records a span where the host offers a clock but no mark', () => {
    // A partial host: `now` alone. Nothing may be marked and nothing measured,
    // and the span record must still be complete.
    const host = createPerformanceDouble([]);

    vi.stubGlobal('performance', host.host);

    const partial = createTracer({ logger, metrics: registry });

    partial.withSpan(SPAN_NAMES.renderCommit, (): void => undefined);

    expect(host.calls).toHaveLength(0);
    expect(partial.recent()).toHaveLength(1);
    expect(partial.snapshot().faults).toBe(0);
  });

  it('clears the start mark where the host marks but cannot measure', () => {
    // The other partial host: `mark` and `clearMarks` without `measure`. The
    // start mark must still be cleared, or a span leaks a timeline entry on
    // every turn.
    const host = createPerformanceDouble(['mark', 'clearMarks']);

    vi.stubGlobal('performance', host.host);

    const partial = createTracer({ logger, metrics: registry });

    partial.withSpan(SPAN_NAMES.engineTurn, (): void => undefined);

    expect(host.marks).toEqual([]);
    expect(host.measures).toEqual([]);
    expect(partial.recent()).toHaveLength(1);
    expect(partial.snapshot().faults).toBe(0);
  });

  it('records a span where every Performance member throws', () => {
    const host = createPerformanceDouble(
      EVERY_PERFORMANCE_MEMBER,
      EVERY_PERFORMANCE_MEMBER,
    );

    vi.stubGlobal('performance', host.host);

    const hostile = createTracer({ logger, metrics: registry });

    expect(() => {
      hostile.withSpan(SPAN_NAMES.hookDispatch, (): void => undefined);
    }).not.toThrow();

    expect(hostile.recent()).toHaveLength(1);
    expect(hostile.snapshot().faults).toBe(0);
    expect(hostile.snapshot().anomalies).toBe(0);

    // The write was attempted and refused; nothing was retained for it.
    expect(host.calls.some((call) => call.member === 'mark')).toBe(true);
    expect(host.marks).toEqual([]);
  });

  it('leaves no mark or measure of its own behind after many closed spans', () => {
    // The bound: the tracer's own entries after N spans is ZERO, because each
    // span clears the two marks and the measure it wrote.
    const host = createPerformanceDouble(EVERY_PERFORMANCE_MEMBER);

    vi.stubGlobal('performance', host.host);

    const marking = createTracer({ logger, metrics: registry });

    for (let index = 0; index < 40; index += 1) {
      marking.withSpan(SPAN_NAMES.frameCallback, (): void => undefined);
    }

    expect(marking.recent()).toHaveLength(40);
    expect(host.marks).toEqual([]);
    expect(host.measures).toEqual([]);

    // Every entry it wrote carried the module's own prefix, so nothing outside
    // its own namespace was cleared.
    const cleared = host.calls.filter(
      (call) => call.member === 'clearMarks' || call.member === 'clearMeasures',
    );

    expect(cleared.length).toBeGreaterThan(0);

    for (const call of cleared) {
      expect(String(call.args[0]).startsWith(MARK_PREFIX)).toBe(true);
    }
  });

  it('clears the start mark of an open span discarded by reset', () => {
    // The leak: `closeMarks()` runs from `finishSpan()` alone, so a span the
    // stack still held when `reset()` ran left its mark behind — and because
    // the identifier counter also returns to its start, the replayed span
    // writes the SAME mark name and would measure against the leaked entry.
    const host = createPerformanceDouble(EVERY_PERFORMANCE_MEMBER);

    vi.stubGlobal('performance', host.host);

    const marking = createTracer({ logger, metrics: registry });
    const open = marking.startSpan(SPAN_NAMES.engineStage);

    expect(host.marks).toHaveLength(1);
    expect(host.marks[0]).toBe(`${MARK_PREFIX}${open.id}/start`);

    marking.reset();

    expect(host.marks).toEqual([]);
    expect(host.measures).toEqual([]);
  });

  it('clears the pending frame mark the frame hooks left open on reset', () => {
    const host = createPerformanceDouble(EVERY_PERFORMANCE_MEMBER);

    vi.stubGlobal('performance', host.host);

    const marking = createTracer({ logger, metrics: registry });
    const hooks = marking.frameLifecycleHooks();

    hooks.onFrameBegin(undefined);

    expect(host.marks).toHaveLength(1);

    marking.reset();

    expect(host.marks).toEqual([]);
  });

  it('leaves no mark behind across repeated resets with spans open each time', () => {
    const host = createPerformanceDouble(EVERY_PERFORMANCE_MEMBER);

    vi.stubGlobal('performance', host.host);

    const marking = createTracer({ logger, metrics: registry });

    for (let round = 0; round < 5; round += 1) {
      marking.startSpan(SPAN_NAMES.engineTurn);
      marking.startSpan(SPAN_NAMES.hookDispatch);

      expect(host.marks).toHaveLength(2);

      marking.reset();

      expect(host.marks).toEqual([]);
    }

    // A second reset with nothing open changes nothing and throws nothing.
    expect(() => {
      marking.reset();
    }).not.toThrow();
    expect(host.marks).toEqual([]);
    expect(marking.snapshot().faults).toBe(0);
  });
});

describe('Span identifier determinism', () => {
  /**
   * Drives one fixed call sequence and returns the identifiers it produced, in
   * order.
   *
   * @param subject Tracer to drive.
   * @returns Every identifier, oldest first.
   */
  const driveIdentifierSequence = (subject: Tracer): readonly string[] => {
    subject.withSpan(SPAN_NAMES.inputDispatch, (): void => {
      subject.withSpan(SPAN_NAMES.moveResolution, (): void => {
        subject.withSpan(SPAN_NAMES.hookDispatch, (): void => {
          subject.withSpan(SPAN_NAMES.relicHandler, (): void => undefined);
        });
      });
      subject.withSpan(SPAN_NAMES.renderCommit, (): void => undefined);
    });
    subject.instrumentFrameCallback((): void => undefined)();

    return subject.recent().map((record) => record.id);
  };

  it('replays the whole identifier sequence after a reset', () => {
    const first = driveIdentifierSequence(tracer);

    expect(first.length).toBeGreaterThan(1);

    tracer.reset();

    const second = driveIdentifierSequence(tracer);

    expect(second).toEqual(first);
  });

  it('produces the same sequence from a second tracer on the same identifier', () => {
    const first = driveIdentifierSequence(tracer);
    const twin = createTracer({
      logger,
      metrics: registry,
      correlationId: tracer.correlationId,
    });

    expect(driveIdentifierSequence(twin)).toEqual(first);
  });

  it('produces a different sequence under a different correlation identifier', () => {
    const first = driveIdentifierSequence(tracer);
    const other = createTracer({
      logger,
      metrics: registry,
      correlationId: 'tracer-suite-other-correlation',
    });
    const second = driveIdentifierSequence(other);

    expect(second).toHaveLength(first.length);
    expect(second).not.toEqual(first);

    // Every identifier still carries its own tracer's identifier as its prefix.
    for (const id of second) {
      expect(id.startsWith('tracer-suite-other-correlation')).toBe(true);
    }
  });

  it('keeps every identifier of one sequence distinct', () => {
    const ids = driveIdentifierSequence(tracer);

    expect(new Set(ids).size).toBe(ids.length);
  });
});
