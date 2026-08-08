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
// including the synchronous driving of the frame wrapper and the local
// collaborator double the hook bus dispatches with.
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
//   `setEnabled(false)` stops recording and leaves the wrapped work running;
//   span durations reach the histograms of src/observability/metrics.ts, and
//     the tracer holds no second aggregate of them.
//
// Coverage owned by sibling suites and not repeated here: the logger's buffer,
// level and sink mechanics (tests/unit/observability/logger.test.ts); the
// registry's primitives, bucket layout and Prometheus exposition
// (tests/unit/observability/metrics.test.ts); the emitter's own `on`, `off` and
// `emit` semantics (tests/unit/engine/engine-events.test.ts); and the hook
// bus's protocol against the real engine collaborators
// (tests/unit/engine/hook-bus.test.ts). The real bus is driven here; the
// collaborator bundle it dispatches with is a local double.
//
// This suite reads no DOM node, writes no storage, awaits nothing, imports no
// module beyond `vitest` and the modules under test, and writes no snapshot
// artifact.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ENGINE_EVENT_NAMES,
  createEngineEvents,
} from '../../../src/engine/engine-events';
import type {
  BoardProjection,
  EngineEventName,
  EngineEvents,
  MoveAfterEvent,
  MoveBeforeEvent,
  StageEndEvent,
  StageStartEvent,
  StateCommitEvent,
  TileMergeEvent,
  TileProjection,
  TileSpawnEvent,
} from '../../../src/engine/engine-events';
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
import { OWNED_STORAGE_KEYS } from '../../../src/storage/storage-keys';

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
 * The three collaborators `HookBus.dispatch` reads, as a local double.
 *
 * The members it reaches, and the whole of them: `config.boardSize`,
 * `config.winValue`, `config.startTiles`, `config.spawn.values`,
 * `config.spawn.weights`, `config.merge.canMerge` and `config.merge.produce`;
 * the eight query members of `grid`, of which `size` is the one this suite's
 * dispatches cause to be read; and `rng.seed`, `rng.stream` and
 * `rng.snapshotCursors`.
 */
interface StreamDouble {
  cursor: number;
  next(): number;
  fork(): StreamDouble;
}

const createStreamDouble = (): StreamDouble => {
  const stream: StreamDouble = {
    cursor: 0,
    next(): number {
      stream.cursor += 1;

      return 0;
    },
    fork(): StreamDouble {
      return createStreamDouble();
    },
  };

  return stream;
};

const createHookEnvironment = (
  boardSize: number = BOARD_SIZE,
): HookEnvironment => {
  const environment = {
    config: {
      boardSize,
      winValue: 2048,
      startTiles: 2,
      spawn: { values: [2, 4], weights: [0.9, 0.1] },
      merge: {
        canMerge: (left: number, right: number): boolean => left === right,
        produce: (value: number): number => value * 2,
      },
    },
    grid: {
      size: boardSize,
      withinBounds: (): boolean => true,
      cellAvailable: (): boolean => true,
      cellOccupied: (): boolean => false,
      cellContent: (): null => null,
      availableCells: (): readonly never[] => [],
      cellsAvailable: (): boolean => true,
      serialize: (): { size: number; cells: readonly never[] } => ({
        size: boardSize,
        cells: [],
      }),
    },
    rng: {
      seed: RUN_SEED,
      stream: (): StreamDouble => createStreamDouble(),
      snapshotCursors: (): Record<string, number> => ({}),
    },
  };

  return environment as unknown as HookEnvironment;
};

const emptyBoard = (size: number = BOARD_SIZE): BoardProjection => ({
  size,
  cells: [],
});

const tileProjection = (
  x: number,
  y: number,
  value: number,
): TileProjection => ({
  x,
  y,
  value,
  previousPosition: null,
  mergedFrom: null,
});

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
  source: tileProjection(0, 0, resultValue / 2),
  target: tileProjection(1, 0, resultValue / 2),
  resultValue,
  scoreDelta: resultValue,
});

const spawnEvent = (value: number): TileSpawnEvent => ({
  position: { x: 2, y: 3 },
  value,
});

const afterEvent = (moved: boolean): MoveAfterEvent => ({
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

const commitEvent = (score: number): StateCommitEvent => ({
  board: emptyBoard(),
  score,
  bestScore: 0,
  over: false,
  won: false,
  terminated: false,
  stage: EMPTY_STAGE_CONTEXT,
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
    expect(tracer.snapshot().open).toBe(0);
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

  it('closes the turn span of a move that changed nothing without recording a latency', () => {
    const latency = registry.histogram(METRIC_NAMES.turnLatencyMilliseconds);

    attachEngineTracing(events, tracer);

    events.emit('move:before', beforeEvent(false));
    events.emit('move:after', afterEvent(false));

    const turn = oneRecordFor(SPAN_NAMES.engineTurn);

    expect(turn.attributes[SPAN_ATTRIBUTES.moved]).toBe(false);
    expect(turn.attributes[SPAN_ATTRIBUTES.outcome]).toBe(
      SPAN_OUTCOMES.unmoved,
    );
    expect(latency.count).toBe(0);
    expect(tracer.snapshot().open).toBe(0);
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
    expect(tracer.snapshot().open).toBe(0);
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

    expect(turn.parentId).toBe(stage.id);
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

  it('reports a commit that arrives with no turn span open and opens no span for it', () => {
    attachEngineTracing(events, tracer);

    events.emit('state:commit', commitEvent(4));

    expect(recordsFor(SPAN_NAMES.engineTurn)).toHaveLength(0);
    expect(tracer.snapshot().anomalies).toBe(1);
    expect(tracer.snapshot().open).toBe(0);
  });

  it('reports a stage end that arrives with no stage span open', () => {
    attachEngineTracing(events, tracer);

    events.emit('stage:end', stageEndEvent(0));

    expect(recordsFor(SPAN_NAMES.engineStage)).toHaveLength(0);
    expect(tracer.snapshot().anomalies).toBe(1);
  });

  it('produces its spans even when another listener of the same event throws', () => {
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

    events.emit('move:before', beforeEvent(false));
    events.emit('state:commit', commitEvent(8));

    expect(tracer.recent()).toHaveLength(produced);
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

  it('keeps observing the turn latency the engine attachment measured while spans are disabled', () => {
    const latency = registry.histogram(METRIC_NAMES.turnLatencyMilliseconds);
    const detach = attachEngineTracing(events, tracer);

    tracer.setEnabled(false);

    events.emit('move:before', beforeEvent(false));
    events.emit('state:commit', commitEvent(8));
    detach();

    // `Tracer.setEnabled` governs span creation, and `recordTurnLatency`
    // carries no enabled guard: the duration it observes is measured between
    // the two emissions rather than read off a span.
    expect(latency.count).toBe(1);
    expect(latency.sum).toBeGreaterThanOrEqual(0);
    expect(tracer.recent()).toHaveLength(0);
    expect(
      registry.histogram(METRIC_NAMES.spanDurationMilliseconds, {
        [METRIC_LABELS.span]: SPAN_NAMES.engineTurn,
      }).count,
    ).toBe(0);
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

