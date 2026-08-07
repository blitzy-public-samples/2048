// Unit suite over the engine-facing recorders of src/observability/metrics.ts
// and the three spawn families they write: `game2048_spawn_attempts_total`,
// `game2048_spawns_total` and `game2048_spawn_suppressed_total`.
//
// WHAT THIS SUITE PINS. A metric must measure the boundary it names. Two of
// those boundaries are events and one is not, and conflating them is the
// defect the suite exists to prevent:
//
//   spawns_total            one tile:spawn emission carrying a position, so
//                           one tile that entered the lattice
//   spawn_attempts_total    one engine spawn entry, which is the engine's own
//                           `engine.spawn.attempt` counter and NOT an event
//   spawn_suppressed_total  one engine spawn that inserted nothing
//
// The distinction comes from the retired sources. js/grid.js L40 guarded
// `randomAvailableCell` with `if (cells.length)` and had no else branch, so it
// returned `undefined` on a full board and js/game_manager.js L72-L75
// inserted no tile. src/engine/engine.ts carries that forward by returning
// BEFORE it dispatches `onSpawn` and before it emits, which is what keeps a
// full board free of draws — so a full-board attempt emits nothing at all and
// a counter fed from emissions cannot see it. Attempts are therefore counted
// at the engine boundary and nowhere else, and section 7 drives the real
// engine to prove the two agree.
//
// It also pins that an emission count does not vary with observers, and that
// the event dimension of a count report is the only dimension an emission is
// read from: an event name arriving in the `hook` dimension is refused rather
// than folded under that hook.
//
// Validation gate: AAP 0.8.8 V8, third bullet — the metrics snapshot exports
// in Prometheus text format, and the families it exports are true.
//
// Coverage owned by sibling suites and not repeated here: the correlation
// identifier the snapshot carries and the logger records it emits
// (tests/unit/observability/logger.test.ts), the dynamic-series caches
// (tests/unit/observability/metrics-series-cache.test.ts), and the hook-bus
// counters this registry folds (tests/unit/engine/hook-bus.test.ts).
//
// This suite reads no DOM and no storage, installs no mock and replaces no
// global; the engine's persistence port is a hand-written double and every
// logger it builds writes to no console. tests/fixtures/storage.ts is loaded
// as a setup file for every unit suite and removes every owned key after each
// test.
//
// Decisions behind this file: DL-METRIC-01 and DL-METRIC-02 in
// docs/DECISION_LOG.md.

import { describe, expect, it } from 'vitest';

import { DEFAULT_RULES_CONFIG } from '../../../src/config/default-config';
import { Engine } from '../../../src/engine/engine';
import type { EngineStoragePort } from '../../../src/engine/engine';
import { ENGINE_EVENT_NAMES } from '../../../src/engine/engine-events';
import type { EngineEventName } from '../../../src/engine/engine-events';
import { Grid } from '../../../src/engine/grid';
import { createHookBus } from '../../../src/engine/hook-bus';
import { Tile } from '../../../src/engine/tile';
import type { HookBusMetrics } from '../../../src/engine/hook-bus';
import { HOOK_NAMES } from '../../../src/engine/hooks';
import type {
  HookEnvironment,
  SpawnPayload,
} from '../../../src/engine/hooks';
import { DIRECTION_LEFT } from '../../../src/engine/types';
import { createLogger } from '../../../src/observability/logger';
import type { Logger } from '../../../src/observability/logger';
import {
  METRIC_LABELS,
  METRIC_NAMES,
  createMetricsRegistry,
} from '../../../src/observability/metrics';
import type {
  MetricsRegistry,
  MetricsSnapshot,
} from '../../../src/observability/metrics';
import { createRngStreams } from '../../../src/rng/rng-streams';

/* ===== 1. Helpers ===== */

/** A cell a successful spawn reports. */
const SPAWNED_CELL = Object.freeze({ x: 1, y: 2 });

/** Seed every engine below runs on, so each run is reproducible. */
const RUN_SEED = 'metrics-spawn-boundary-seed';

/**
 * Counter name the emitter raises once per emission, before it looks a
 * listener up. Declared privately by src/engine/engine-events.ts, so the
 * literal is repeated here rather than imported.
 */
const EMIT_METRIC = 'engine.event.emit';

/** Counter name the engine raises on entry to every spawn. */
const SPAWN_ATTEMPT_METRIC = 'engine.spawn.attempt';

/** Counter name the engine raises for a spawn that inserted nothing. */
const SPAWN_SUPPRESSED_METRIC = 'engine.spawn.suppressed';

/**
 * Reads one unlabelled counter's value out of a snapshot.
 *
 * @param snapshot Snapshot to read.
 * @param name Family name to find.
 * @returns The counter's value, or `null` when the family holds no series.
 */
function counterValue(
  snapshot: MetricsSnapshot,
  name: string,
): number | null {
  for (const series of snapshot.series) {
    if (series.name === name && series.kind === 'counter') {
      return series.value;
    }
  }

  return null;
}

/**
 * Reads one per-event counter's value out of a snapshot.
 *
 * @param snapshot Snapshot to read.
 * @param event Event the series is labelled with.
 * @returns The counter's value, or `null` when no such series exists.
 */
function eventCounterValue(
  snapshot: MetricsSnapshot,
  event: string,
): number | null {
  for (const series of snapshot.series) {
    if (
      series.name === METRIC_NAMES.engineEventsTotal &&
      series.kind === 'counter' &&
      series.labels[METRIC_LABELS.event] === event
    ) {
      return series.value;
    }
  }

  return null;
}

/**
 * Reads a registry's three spawn counters.
 *
 * @param registry Registry to read.
 * @returns The attempt, insertion and suppression counts.
 */
function spawnCounts(registry: MetricsRegistry): {
  readonly attempts: number | null;
  readonly inserted: number | null;
  readonly suppressed: number | null;
} {
  const snapshot = registry.snapshot();

  return {
    attempts: counterValue(snapshot, METRIC_NAMES.spawnAttemptsTotal),
    inserted: counterValue(snapshot, METRIC_NAMES.spawnsTotal),
    suppressed: counterValue(snapshot, METRIC_NAMES.spawnSuppressedTotal),
  };
}

/**
 * Builds a logger that writes to no console and carries a known identifier.
 *
 * @param correlationId Identifier every record and the registry carry.
 * @returns The logger.
 */
function createSilentLogger(correlationId: string): Logger {
  return createLogger({ correlationId, consoleOutput: false });
}

/**
 * Reads the `reason` field of every record a logger buffered.
 *
 * @param logger Logger to read.
 * @returns One entry per record carrying a string `reason`.
 */
function loggedReasons(logger: Logger): readonly string[] {
  const reasons: string[] = [];

  for (const record of logger.snapshot().records) {
    const reason: unknown = record.fields?.reason;

    if (typeof reason === 'string') {
      reasons.push(reason);
    }
  }

  return reasons;
}

/** A port that reports no best score and discards every write. */
function createPort(): EngineStoragePort {
  return {
    getBestScore: (): string | 0 => 0,
    setBestScore: (): unknown => undefined,
    getGameState: (): unknown => null,
    setGameState: (): unknown => undefined,
    clearGameState: (): unknown => undefined,
  };
}

/**
 * Builds every per-hook counter row at one value, so a fold has something to
 * fold.
 *
 * @param dispatched Value every counter of every hook carries.
 * @returns The `hooks` table of a `HookBusMetrics`.
 */
function hookTable(dispatched: number): HookBusMetrics['hooks'] {
  const table: Record<string, unknown> = {};

  for (const hook of HOOK_NAMES) {
    table[hook] = {
      dispatched,
      invoked: dispatched,
      skippedExhausted: 0,
      skippedDegraded: 0,
      skippedDetached: 0,
      rejected: 0,
      failed: 0,
    };
  }

  return table as HookBusMetrics['hooks'];
}

/**
 * Builds the live collaborators one dispatch carries.
 *
 * @returns The environment, on the default rules and one fixed seed.
 */
function createEnvironment(): HookEnvironment {
  return {
    config: { ...DEFAULT_RULES_CONFIG },
    rng: createRngStreams(RUN_SEED),
    grid: new Grid(DEFAULT_RULES_CONFIG.boardSize),
  };
}

/**
 * Sums the per-hook dispatch counters of a registry.
 *
 * @param registry Registry to read.
 * @returns The total across every hook series.
 */
function dispatchTotal(registry: MetricsRegistry): number {
  let total = 0;

  for (const series of registry.snapshot().series) {
    if (
      series.name === METRIC_NAMES.hookDispatchesTotal &&
      series.kind === 'counter'
    ) {
      total += series.value;
    }
  }

  return total;
}

/* ===== 2. The three spawn families (F7) ===== */

describe('the spawn families', () => {
  it('names attempts, insertions and suppressions separately', () => {
    expect(METRIC_NAMES.spawnAttemptsTotal).toBe(
      'game2048_spawn_attempts_total',
    );
    expect(METRIC_NAMES.spawnsTotal).toBe('game2048_spawns_total');
    expect(METRIC_NAMES.spawnSuppressedTotal).toBe(
      'game2048_spawn_suppressed_total',
    );
    expect(
      new Set([
        METRIC_NAMES.spawnAttemptsTotal,
        METRIC_NAMES.spawnsTotal,
        METRIC_NAMES.spawnSuppressedTotal,
      ]).size,
    ).toBe(3);
  });

  it('registers all three families at zero', () => {
    const counts = spawnCounts(createMetricsRegistry());

    expect(counts.attempts).toBe(0);
    expect(counts.inserted).toBe(0);
    expect(counts.suppressed).toBe(0);
  });

  it('counts an attempt from the engine boundary and nothing else', () => {
    const registry = createMetricsRegistry();

    registry.recordSpawnAttempt();

    const counts = spawnCounts(registry);

    expect(counts.attempts).toBe(1);
    expect(counts.inserted).toBe(0);
    expect(counts.suppressed).toBe(0);
  });

  it('counts a suppression from the engine boundary and nothing else', () => {
    const registry = createMetricsRegistry();

    registry.recordSpawnSuppressed();

    const counts = spawnCounts(registry);

    expect(counts.attempts).toBe(0);
    expect(counts.inserted).toBe(0);
    expect(counts.suppressed).toBe(1);
  });

  it('counts an insertion from the emission and NOT an attempt (F7)', () => {
    const registry = createMetricsRegistry();

    // The emission is the insertion signal alone. Counting an attempt here
    // is the defect: the engine returns before emitting on a full board, so
    // the emissions are a subset of the attempts.
    registry.recordEngineEvent('tile:spawn', {
      position: SPAWNED_CELL,
    });

    const counts = spawnCounts(registry);

    expect(counts.attempts).toBe(0);
    expect(counts.inserted).toBe(1);
    expect(counts.suppressed).toBe(0);
  });

  it('counts nothing for an emission carrying no position', () => {
    const registry = createMetricsRegistry();

    // The payload an `onSpawn` handler produces by returning the payload
    // without a cell. The suppression itself is counted at the engine
    // boundary, so this emission adds to no spawn family.
    registry.recordEngineEvent('tile:spawn', { position: undefined });

    const counts = spawnCounts(registry);

    expect(counts.attempts).toBe(0);
    expect(counts.inserted).toBe(0);
    expect(counts.suppressed).toBe(0);
  });

  it('treats a payload with no position member the same way', () => {
    const registry = createMetricsRegistry();

    registry.recordEngineEvent('tile:spawn', {});

    expect(spawnCounts(registry).inserted).toBe(0);
  });

  it('counts no insertion when no payload is supplied', () => {
    const registry = createMetricsRegistry();

    registry.recordEngineEvent('tile:spawn');

    expect(spawnCounts(registry).inserted).toBe(0);
  });

  it('keeps insertions at or below attempts over a mixed sequence', () => {
    const registry = createMetricsRegistry();

    // One turn per entry: the engine counts every attempt at its own
    // boundary, then either emits an insertion or counts a suppression. The
    // family relationship, not the individual counts, is what this asserts —
    // an emission-fed attempt counter breaks it on the `false` entries.
    const inserted: readonly boolean[] = [
      true,
      true,
      false,
      true,
      false,
      false,
      true,
    ];

    for (const didInsert of inserted) {
      registry.recordSpawnAttempt();

      if (didInsert) {
        registry.recordEngineEvent('tile:spawn', { position: SPAWNED_CELL });
      } else {
        registry.recordSpawnSuppressed();
      }
    }

    const counts = spawnCounts(registry);
    const insertions = inserted.filter((did: boolean): boolean => did).length;

    expect(counts.attempts).toBe(inserted.length);
    expect(counts.inserted).toBe(insertions);
    expect(counts.suppressed).toBe(inserted.length - insertions);
    expect(counts.inserted ?? 0).toBeLessThanOrEqual(counts.attempts ?? 0);
  });

  it('sees a full-board attempt that emits nothing at all (F7)', () => {
    const registry = createMetricsRegistry();

    // What the engine does on a full board: it counts the attempt, counts
    // the suppression, and returns before any emission. A counter fed from
    // `tile:spawn` would report zero attempts for this turn.
    registry.recordSpawnAttempt();
    registry.recordSpawnSuppressed();

    const counts = spawnCounts(registry);

    expect(counts.attempts).toBe(1);
    expect(counts.suppressed).toBe(1);
    expect(counts.inserted).toBe(0);
  });

  it('keeps attempts equal to insertions plus suppressions', () => {
    const registry = createMetricsRegistry();
    const outcomes: readonly boolean[] = [
      true,
      true,
      false,
      true,
      false,
      false,
      true,
    ];

    for (const inserted of outcomes) {
      registry.recordSpawnAttempt();

      if (inserted) {
        registry.recordEngineEvent('tile:spawn', {
          position: SPAWNED_CELL,
        });
      } else {
        registry.recordSpawnSuppressed();
      }
    }

    const counts = spawnCounts(registry);
    const expectedInserted = outcomes.filter(
      (inserted: boolean): boolean => inserted,
    ).length;

    expect(counts.attempts).toBe(outcomes.length);
    expect(counts.inserted).toBe(expectedInserted);
    expect(counts.suppressed).toBe(outcomes.length - expectedInserted);
    expect((counts.inserted ?? 0) + (counts.suppressed ?? 0)).toBe(
      counts.attempts,
    );
  });

  it('exports all three families in the Prometheus text', () => {
    const registry = createMetricsRegistry();

    registry.recordSpawnAttempt();
    registry.recordSpawnAttempt();
    registry.recordSpawnSuppressed();
    registry.recordEngineEvent('tile:spawn', { position: SPAWNED_CELL });

    const text = registry.prometheusText;

    expect(text).toContain(`${METRIC_NAMES.spawnAttemptsTotal} 2`);
    expect(text).toContain(`${METRIC_NAMES.spawnsTotal} 1`);
    expect(text).toContain(`${METRIC_NAMES.spawnSuppressedTotal} 1`);
    expect(text).toContain(`# TYPE ${METRIC_NAMES.spawnAttemptsTotal} counter`);
    expect(text).toContain(`# TYPE ${METRIC_NAMES.spawnsTotal} counter`);
    expect(text).toContain(
      `# TYPE ${METRIC_NAMES.spawnSuppressedTotal} counter`,
    );
  });

  it('gives each family help text that says what it counts', () => {
    const snapshot = createMetricsRegistry().snapshot();
    const helpOf = (name: string): string =>
      snapshot.series.find(
        (series): boolean => series.name === name,
      )?.help ?? '';
    const attempts = helpOf(METRIC_NAMES.spawnAttemptsTotal);
    const inserted = helpOf(METRIC_NAMES.spawnsTotal);
    const suppressed = helpOf(METRIC_NAMES.spawnSuppressedTotal);

    expect(attempts).toContain('attempt');
    expect(inserted).toContain('Tiles inserted');
    expect(suppressed).toContain('inserted no tile');
    expect(new Set([attempts, inserted, suppressed]).size).toBe(3);

    // The attempt family must not name the event as its boundary: that
    // sentence is what made the metric untrue.
    expect(attempts).not.toContain('tile:spawn');
    expect(inserted).toContain('tile:spawn');
  });
});

/* ===== 3. recordEngineEvent, every other event ===== */

describe('recordEngineEvent', () => {
  it('counts every emission in the per-event family', () => {
    const registry = createMetricsRegistry();

    for (const event of ENGINE_EVENT_NAMES) {
      registry.recordEngineEvent(event);
    }

    const snapshot = registry.snapshot();
    const perEvent = snapshot.series.filter(
      (series): boolean => series.name === METRIC_NAMES.engineEventsTotal,
    );

    expect(perEvent).toHaveLength(ENGINE_EVENT_NAMES.length);

    for (const series of perEvent) {
      expect(series.kind).toBe('counter');

      if (series.kind === 'counter') {
        expect(series.value).toBe(1);
      }
    }
  });

  it('closes one turn per move:after emission', () => {
    const registry = createMetricsRegistry();

    registry.recordEngineEvent('move:after');
    registry.recordEngineEvent('move:after');

    expect(counterValue(registry.snapshot(), METRIC_NAMES.turnsTotal)).toBe(2);
  });

  it('counts one merge per tile:merge emission', () => {
    const registry = createMetricsRegistry();

    // js/game_manager.js L156-L170 was entered once per merge inside the
    // traversal, so a move resolving two merges emits twice.
    registry.recordEngineEvent('tile:merge');
    registry.recordEngineEvent('tile:merge');

    expect(counterValue(registry.snapshot(), METRIC_NAMES.mergesTotal)).toBe(
      2,
    );
  });

  it('leaves the spawn families untouched by other events', () => {
    const registry = createMetricsRegistry();

    for (const event of ENGINE_EVENT_NAMES) {
      if (event !== 'tile:spawn') {
        registry.recordEngineEvent(event);
      }
    }

    const counts = spawnCounts(registry);

    expect(counts.attempts).toBe(0);
    expect(counts.inserted).toBe(0);
    expect(counts.suppressed).toBe(0);
  });

  it('rejects a name outside ENGINE_EVENT_NAMES and counts it nowhere', () => {
    const registry = createMetricsRegistry();

    registry.recordEngineEvent('tile:vanish' as EngineEventName, {
      position: SPAWNED_CELL,
    });

    const snapshot = registry.snapshot();
    const counts = spawnCounts(registry);

    expect(snapshot.rejected).toBe(1);
    expect(counts.attempts).toBe(0);
    expect(counts.inserted).toBe(0);
    expect(counterValue(snapshot, METRIC_NAMES.turnsTotal)).toBe(0);
  });

  it('throws for no input', () => {
    const registry = createMetricsRegistry();

    expect(() => {
      registry.recordEngineEvent('tile:spawn', { position: SPAWNED_CELL });
      registry.recordEngineEvent('tile:spawn');
      registry.recordEngineEvent('tile:spawn', { position: null });
      registry.recordEngineEvent('' as EngineEventName);
      registry.recordSpawnAttempt();
      registry.recordSpawnSuppressed();
    }).not.toThrow();

    const counts = spawnCounts(registry);

    expect(counts.attempts).toBe(1);
    expect(counts.inserted).toBe(1);
    expect(counts.suppressed).toBe(1);
  });
});

/* ===== 4. recordEngineEventCount, the event dimension (F8) ===== */

describe('recordEngineEventCount reads the event dimension', () => {
  it('counts one emission from a report carrying no value', () => {
    const registry = createMetricsRegistry();

    registry.recordEngineEventCount({ event: 'state:commit' });

    const snapshot = registry.snapshot();

    expect(eventCounterValue(snapshot, 'state:commit')).toBe(1);
    expect(snapshot.rejected).toBe(0);
  });

  it('counts the emissions a report stands for', () => {
    const registry = createMetricsRegistry();

    registry.recordEngineEventCount({ event: 'tile:merge', value: 3 });

    const snapshot = registry.snapshot();

    expect(eventCounterValue(snapshot, 'tile:merge')).toBe(3);
    expect(counterValue(snapshot, METRIC_NAMES.mergesTotal)).toBe(3);
  });

  it('closes one turn per move:after report', () => {
    const registry = createMetricsRegistry();

    registry.recordEngineEventCount({ event: 'move:after' });
    registry.recordEngineEventCount({ event: 'move:after', value: 1 });

    expect(counterValue(registry.snapshot(), METRIC_NAMES.turnsTotal)).toBe(2);
  });

  it('refuses an event name arriving in the hook dimension (F8)', () => {
    const logger = createSilentLogger('run-hook-dimension');
    const registry = createMetricsRegistry({ logger });

    // The exact confusion that made emissions and dispatches
    // indistinguishable: the event name reported under `hook`.
    registry.recordEngineEventCount({ hook: 'tile:spawn' });

    const snapshot = registry.snapshot();

    expect(eventCounterValue(snapshot, 'tile:spawn')).toBe(0);
    expect(snapshot.rejected).toBe(1);
    expect(loggedReasons(logger)).toContain('eventNameInHookDimension');
  });

  it('distinguishes a hook-scoped report from a missing dimension', () => {
    const logger = createSilentLogger('run-no-dimension');
    const registry = createMetricsRegistry({ logger });

    registry.recordEngineEventCount({ hook: 'onMerge' });

    expect(registry.snapshot().rejected).toBe(1);
    expect(loggedReasons(logger)).toContain('noEventDimension');
    expect(loggedReasons(logger)).not.toContain('eventNameInHookDimension');
  });

  it('refuses a report carrying neither dimension', () => {
    const registry = createMetricsRegistry();

    registry.recordEngineEventCount({});

    expect(registry.snapshot().rejected).toBe(1);
  });

  it('refuses an event outside ENGINE_EVENT_NAMES', () => {
    const logger = createSilentLogger('run-unknown-event');
    const registry = createMetricsRegistry({ logger });

    registry.recordEngineEventCount({ event: 'tile:vanish' });

    expect(registry.snapshot().rejected).toBe(1);
    expect(loggedReasons(logger)).toContain('unknownEvent');
  });

  it('refuses a value that is not a non-negative integer', () => {
    const registry = createMetricsRegistry();
    const refused: readonly unknown[] = [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '2',
      null,
    ];

    for (const value of refused) {
      registry.recordEngineEventCount({ event: 'move:after', value });
    }

    const snapshot = registry.snapshot();

    expect(snapshot.rejected).toBe(refused.length);
    expect(eventCounterValue(snapshot, 'move:after')).toBe(0);
    expect(counterValue(snapshot, METRIC_NAMES.turnsTotal)).toBe(0);
  });

  it('accepts a zero-emission report without counting or rejecting', () => {
    const registry = createMetricsRegistry();

    registry.recordEngineEventCount({ event: 'move:after', value: 0 });

    const snapshot = registry.snapshot();

    expect(eventCounterValue(snapshot, 'move:after')).toBe(0);
    expect(snapshot.rejected).toBe(0);
  });

  it('records no insertion, because a count report carries no payload', () => {
    const registry = createMetricsRegistry();

    registry.recordEngineEventCount({ event: 'tile:spawn' });

    const snapshot = registry.snapshot();
    const counts = spawnCounts(registry);

    expect(eventCounterValue(snapshot, 'tile:spawn')).toBe(1);
    expect(counts.inserted).toBe(0);
    expect(counts.attempts).toBe(0);
  });

  it('reports rather than throws for every malformed input', () => {
    const registry = createMetricsRegistry();

    expect(() => {
      registry.recordEngineEventCount(
        null as unknown as Record<string, unknown>,
      );
      registry.recordEngineEventCount(
        undefined as unknown as Record<string, unknown>,
      );
      registry.recordEngineEventCount({ event: 42 });
      registry.recordEngineEventCount({ event: '' });
    }).not.toThrow();
    expect(registry.snapshot().rejected).toBe(4);
  });
});

/* ===== 5. The canonical tuples drive construction (F9) ===== */

describe('the canonical event tuple drives construction', () => {
  it('is frozen at its declaration', () => {
    expect(Object.isFrozen(ENGINE_EVENT_NAMES)).toBe(true);
  });

  it('holds one per-event series per member and no other', () => {
    const registry = createMetricsRegistry();
    const labelled: string[] = [];

    for (const series of registry.snapshot().series) {
      if (series.name === METRIC_NAMES.engineEventsTotal) {
        labelled.push(series.labels[METRIC_LABELS.event] ?? '');
      }
    }

    expect(labelled.slice().sort()).toEqual(
      [...ENGINE_EVENT_NAMES].sort(),
    );
  });

  it('still validates rather than trusting a name it is handed', () => {
    const logger = createSilentLogger('run-bounded-validation');
    const registry = createMetricsRegistry({ logger });

    // The freeze protects the tuple; the validation protects the registry
    // from a name that never came from it. Both hold at once.
    registry.recordEngineEvent('game2048_evil{label="x"}' as EngineEventName);
    registry.recordEngineEventCount({ event: 'x'.repeat(400) });

    const snapshot = registry.snapshot();

    expect(snapshot.rejected).toBe(2);

    for (const series of snapshot.series) {
      expect(series.name.startsWith('game2048_')).toBe(true);
      expect(series.name).not.toContain('{');
    }
  });
});

/* ===== 6. foldHookDispatchCounts rejects before folding (F6) ===== */

describe('foldHookDispatchCounts rejects before folding', () => {
  it('folds a snapshot whose identifier matches the registry', () => {
    const logger = createSilentLogger('run-matching');
    const registry = createMetricsRegistry({ logger });

    registry.foldHookDispatchCounts({
      correlationId: 'run-matching',
      hooks: hookTable(2),
    });

    expect(dispatchTotal(registry)).toBe(2 * HOOK_NAMES.length);
    expect(registry.snapshot().rejected).toBe(0);
  });

  it('folds nothing from a snapshot carrying no identifier', () => {
    const logger = createSilentLogger('run-missing');
    const registry = createMetricsRegistry({ logger });

    registry.foldHookDispatchCounts({ hooks: hookTable(5) });

    expect(dispatchTotal(registry)).toBe(0);
    expect(registry.snapshot().rejected).toBe(1);
    expect(loggedReasons(logger)).toEqual(['noCorrelationId']);
  });

  it('folds nothing from a snapshot carrying an empty identifier', () => {
    const logger = createSilentLogger('run-empty');
    const registry = createMetricsRegistry({ logger });

    registry.foldHookDispatchCounts({
      correlationId: '',
      hooks: hookTable(5),
    });

    expect(dispatchTotal(registry)).toBe(0);
    expect(loggedReasons(logger)).toEqual(['noCorrelationId']);
  });

  it('folds nothing from a foreign run (F6)', () => {
    const logger = createSilentLogger('run-mine');
    const registry = createMetricsRegistry({ logger });

    registry.foldHookDispatchCounts({
      correlationId: 'run-theirs',
      hooks: hookTable(9),
    });

    expect(dispatchTotal(registry)).toBe(0);
    expect(registry.snapshot().rejected).toBe(1);
    expect(loggedReasons(logger)).toEqual(['foreignCorrelationId']);
  });

  it('keeps a foreign snapshot out of a registry already folding', () => {
    const logger = createSilentLogger('run-mine');
    const registry = createMetricsRegistry({ logger });

    registry.foldHookDispatchCounts({
      correlationId: 'run-mine',
      hooks: hookTable(4),
    });

    const mine = dispatchTotal(registry);

    registry.foldHookDispatchCounts({
      correlationId: 'run-theirs',
      hooks: hookTable(1000),
    });

    // The per-hook totals are this run's alone, so the exported figure is
    // still what this run dispatched.
    expect(dispatchTotal(registry)).toBe(mine);
    expect(mine).toBe(4 * HOOK_NAMES.length);
  });

  it('accepts any identifier when the registry holds none of its own', () => {
    const registry = createMetricsRegistry();

    // With no logger there is no identifier to disagree with, so the
    // snapshot's own namespaces the reconciliation.
    registry.foldHookDispatchCounts({
      correlationId: 'run-anything',
      hooks: hookTable(3),
    });

    expect(dispatchTotal(registry)).toBe(3 * HOOK_NAMES.length);
    expect(registry.snapshot().rejected).toBe(0);
  });

  it('folds a real hook bus and refuses the same counts relabelled', () => {
    const logger = createSilentLogger('run-real-bus');
    const registry = createMetricsRegistry({ logger });
    const bus = createHookBus({ correlationId: 'run-real-bus' });

    bus.register({
      id: 'counts-a-dispatch',
      hooks: {
        onMerge: (payload): typeof payload => payload,
      },
    });
    bus.dispatch(
      'onMerge',
      {
        source: new Tile({ x: 0, y: 0 }, 2),
        target: new Tile({ x: 1, y: 0 }, 2),
        resultValue: 4,
        scoreDelta: 4,
      },
      createEnvironment(),
    );

    const reported = bus.metrics();

    registry.foldHookDispatchCounts(reported);

    expect(dispatchTotal(registry)).toBe(1);

    registry.foldHookDispatchCounts({
      correlationId: 'run-somewhere-else',
      hooks: reported.hooks,
    });

    expect(dispatchTotal(registry)).toBe(1);
    expect(loggedReasons(logger)).toEqual(['foreignCorrelationId']);
  });

  it('reports rather than throws for a malformed snapshot', () => {
    const registry = createMetricsRegistry();

    expect(() => {
      registry.foldHookDispatchCounts(
        null as unknown as HookBusMetrics,
      );
      registry.foldHookDispatchCounts({});
      registry.foldHookDispatchCounts({
        correlationId: 'run-x',
        hooks: 'not a table' as unknown as HookBusMetrics['hooks'],
      });
    }).not.toThrow();
    expect(registry.snapshot().rejected).toBe(3);
    expect(dispatchTotal(registry)).toBe(0);
  });
});

/* ===== 7. The engine boundary, end to end (F7, F8) ===== */

describe('the engine boundary agrees with the spawn families', () => {
  /**
   * Wires a registry to a real engine the way a composition root does: the
   * engine's spawn counters feed the attempt and suppression families, its
   * emit counter feeds the per-event family, and its `tile:spawn` payloads
   * feed the insertion family.
   *
   * @param registry Registry to feed.
   * @returns The set-up engine.
   */
  function createWiredEngine(registry: MetricsRegistry): Engine {
    const engine = new Engine({
      config: { ...DEFAULT_RULES_CONFIG },
      streams: createRngStreams(RUN_SEED),
      storage: createPort(),
      reporter: {
        onCount: (report): void => {
          if (report.metric === SPAWN_ATTEMPT_METRIC) {
            registry.recordSpawnAttempt();
          } else if (report.metric === SPAWN_SUPPRESSED_METRIC) {
            registry.recordSpawnSuppressed();
          } else if (report.metric === EMIT_METRIC) {
            registry.recordEngineEventCount(report);
          }
        },
      },
    });

    engine.events.on('tile:spawn', (payload) => {
      registry.recordEngineEvent('tile:spawn', payload);
    });
    engine.setup();

    return engine;
  }

  it('counts the two starting tiles as two attempts and two insertions',
    () => {
      const registry = createMetricsRegistry();

      createWiredEngine(registry);

      const counts = spawnCounts(registry);

      expect(counts.attempts).toBe(2);
      expect(counts.inserted).toBe(2);
      expect(counts.suppressed).toBe(0);
    });

  it('keeps attempts equal to insertions plus suppressions over a run',
    () => {
      const registry = createMetricsRegistry();
      const engine = createWiredEngine(registry);

      for (let move = 0; move < 12; move += 1) {
        engine.move(((move % 4) as 0 | 1 | 2 | 3));
      }

      const counts = spawnCounts(registry);

      expect(counts.attempts).toBeGreaterThan(2);
      expect((counts.inserted ?? 0) + (counts.suppressed ?? 0)).toBe(
        counts.attempts,
      );
    });

  it('counts an attempt and a suppression for a suppressed spawn (F7)',
    () => {
      const registry = createMetricsRegistry();
      const engine = createWiredEngine(registry);
      const before = spawnCounts(registry);

      engine.hooks.register({
        id: 'suppresses-the-spawn',
        hooks: {
          onSpawn: (payload): SpawnPayload => ({ value: payload.value }),
        },
      });

      expect(engine.move(DIRECTION_LEFT)).toBe(true);

      const counts = spawnCounts(registry);

      // The attempt and its suppression are both visible, and no insertion
      // was counted from the emission that carried no position.
      expect(counts.attempts).toBe((before.attempts ?? 0) + 1);
      expect(counts.suppressed).toBe((before.suppressed ?? 0) + 1);
      expect(counts.inserted).toBe(before.inserted);
    });

  it('counts every emission through the event dimension (F8)', () => {
    const registry = createMetricsRegistry();
    const engine = createWiredEngine(registry);

    expect(engine.move(DIRECTION_LEFT)).toBe(true);

    const snapshot = registry.snapshot();

    // No listener is registered for these two events, and both are still
    // counted: the emitter counts before it looks a listener up.
    expect(eventCounterValue(snapshot, 'move:before')).toBe(1);
    expect(eventCounterValue(snapshot, 'move:after')).toBe(1);
    expect(counterValue(snapshot, METRIC_NAMES.turnsTotal)).toBe(1);
    expect(snapshot.rejected).toBe(0);
  });

  it('counts the same emissions whether or not a listener is registered',
    () => {
      const plainRegistry = createMetricsRegistry();
      const observedRegistry = createMetricsRegistry();
      const plain = createWiredEngine(plainRegistry);
      const observed = createWiredEngine(observedRegistry);

      observed.events.on('move:before', () => undefined);
      observed.events.on('move:after', () => undefined);
      observed.events.on('state:commit', () => undefined);

      expect(plain.move(DIRECTION_LEFT)).toBe(true);
      expect(observed.move(DIRECTION_LEFT)).toBe(true);

      const dimensions = (registry: MetricsRegistry): readonly number[] =>
        ENGINE_EVENT_NAMES.map(
          (event: EngineEventName): number =>
            eventCounterValue(registry.snapshot(), event) ?? -1,
        );

      expect(dimensions(observedRegistry)).toEqual(
        dimensions(plainRegistry),
      );
    });
});
