// Unit suite over src/observability/metrics.ts: the counter, gauge and
// histogram primitives, the default duration buckets, the canonical metric
// names, the engine-facing recorders, the three spawn families they write —
// `game2048_spawn_attempts_total`, `game2048_spawns_total` and
// `game2048_spawn_suppressed_total` — and the Prometheus text exposition the
// registry stands the metrics endpoint up with.
//
// Section map. Sections 2 through 7 cover the engine-facing recorders;
// sections 8 through 14 cover the primitives, the bucket layout, the canonical
// names, the text exposition, the snapshot-to-text round trip and the
// registry's reporting and download surfaces.
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
// in Prometheus text format, and the families it exports are true. Sections 12
// and 13 are that gate: the exposition is read back through the structural
// validator of section 8 and reconciled against `snapshot()`, which is the
// pair docs/dashboards/dashboard.html and docs/dashboards/dashboard.json
// consume.
//
// Coverage owned by sibling suites and not repeated here: the logger's own
// buffer, level and sink mechanics (tests/unit/observability/logger.test.ts),
// the dynamic-series caches for spans, health checks and RNG substreams
// (tests/unit/observability/metrics-series-cache.test.ts), and the hook-bus
// counters this registry folds (tests/unit/engine/hook-bus.test.ts). What
// sections 11 and 14 add is the registry's side of those seams: the per-hook
// series it holds, and the records its rejections reach an injected logger
// with.
//
// Sections 2 through 13 read no DOM and no storage; the engine's persistence
// port is a hand-written double and every logger built here writes to no
// console. Section 14 exercises `download`, which is the module's one member
// that reaches a document: it spies on the three globals that member
// feature-detects — `URL.createObjectURL`, `URL.revokeObjectURL` and the
// anchor's `click` — and asserts the module's documented guard where the
// active environment supplies none of them. `vitest.config.ts` sets
// `restoreMocks`, and section 14 also restores explicitly.
// tests/fixtures/storage.ts is loaded as a setup file for every unit suite and
// removes every owned key after each test.
//
// Decisions behind this file: DL-METRIC-01 and DL-METRIC-02 in
// docs/DECISION_LOG.md.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import type { LogRecord, Logger } from '../../../src/observability/logger';
import {
  DEFAULT_DURATION_BUCKETS,
  DEFAULT_METRICS_FILENAME,
  METRICS_SNAPSHOT_SCHEMA_VERSION,
  METRIC_LABELS,
  METRIC_NAMES,
  METRIC_PREFIX,
  createMetricsRegistry,
  isValidMetricName,
} from '../../../src/observability/metrics';
import type {
  LabelSet,
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

  it('declares all THREE encodings the health gauge carries', () => {
    const registry = createMetricsRegistry();

    registry.recordHealthCheck('storage', true);

    const help =
      registry
        .snapshot()
        .series.find(
          (series): boolean => series.name === METRIC_NAMES.healthCheckStatus,
        )?.help ?? '';

    // The series carries -1 for a check the host offers nothing to evaluate —
    // src/observability/health.ts writes it directly from
    // `HEALTH_GAUGE_VALUES` — so a reader of the exposition sees a value the
    // help text did not declare.
    expect(help).toContain('1 healthy');
    expect(help).toContain('0 unhealthy');
    expect(help).toContain('-1 not applicable');
    expect(registry.toPrometheusText()).toContain(
      `# HELP ${METRIC_NAMES.healthCheckStatus} `,
    );
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

  it('throws for NO input, absent payload and empty name included', () => {
    const registry = createMetricsRegistry();

    // The claim is CONTAINMENT, not that anything raises: every call below is
    // one a caller can make and none of them may throw.
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

  it('follows the logger through a run rotation, so a bus stays local', () => {
    const logger = createSilentLogger('run-first');
    const registry = createMetricsRegistry({ logger });

    // A second run of one page load. The registry captured its identifier at
    // construction, so a bus reporting under the run that was actually playing
    // was refused as foreign and its counts were dropped.
    logger.setCorrelationId('run-second');

    registry.foldHookDispatchCounts({
      correlationId: 'run-second',
      hooks: hookTable(2),
    });

    expect(registry.correlationId).toBe('run-second');
    expect(registry.snapshot().correlationId).toBe('run-second');
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

/* ===== 8. The structural exposition validator ===== */

/** The exposition format's metric name grammar. */
const PROMETHEUS_METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

/** The exposition format's label name grammar. */
const PROMETHEUS_LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** One `name="value"` pair, with the value's escape sequences preserved. */
const LABEL_PAIR = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

/** A sample value a strict consumer parses as a float. */
const NUMERIC_VALUE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** An optional trailing sample timestamp, in milliseconds. */
const SAMPLE_TIMESTAMP = /^[+-]?\d+$/;

/** The three spellings the format defines for a non-finite sample value. */
const SPECIAL_VALUES: ReadonlySet<string> = new Set([
  'NaN',
  '+Inf',
  '-Inf',
]);

/** Every `# TYPE` kind the exposition format defines. */
const EXPOSITION_KINDS: ReadonlySet<string> = new Set([
  'counter',
  'gauge',
  'histogram',
  'summary',
  'untyped',
]);

/** The suffixes a histogram family's generated sample names carry. */
const HISTOGRAM_SUFFIXES: readonly string[] = Object.freeze([
  '_bucket',
  '_sum',
  '_count',
]);

/** The reserved bucket-bound label name. */
const BUCKET_BOUND_LABEL = 'le';

/** The bound label value of the overflow bucket. */
const INFINITY_BOUND = '+Inf';

/** One parsed sample line. */
interface ParsedSample {
  /** Line as it was emitted, for a failure message. */
  readonly line: string;

  /** One-based line number. */
  readonly lineNumber: number;

  /** Sample name, which for a histogram carries a generated suffix. */
  readonly name: string;

  /** Labels with every escape sequence resolved back to its character. */
  readonly labels: Readonly<Record<string, string>>;

  /** Whether the line carried a label block at all. */
  readonly hadBraces: boolean;

  /** The sample value, as a strict consumer would parse it. */
  readonly value: number;

  /** The value token verbatim, before it was parsed. */
  readonly valueToken: string;
}

/** One `# HELP` or `# TYPE` declaration. */
interface ParsedMetadata {
  readonly name: string;

  /** Help text with its escape sequences resolved, or the kind for a type. */
  readonly text: string;

  /** One-based line number. */
  readonly lineNumber: number;
}

/** The whole exposition, as the validator reads it back. */
interface ParsedExposition {
  /** Every structural violation found. Empty for a valid exposition. */
  readonly problems: readonly string[];
  readonly help: readonly ParsedMetadata[];
  readonly type: readonly ParsedMetadata[];
  readonly samples: readonly ParsedSample[];

  /** Series identity of every sample, in emission order. */
  readonly identities: readonly string[];
}

/**
 * Resolves the escape sequences of a label value.
 *
 * @param raw Value as it was emitted, between its quotes.
 * @returns The value the label carries.
 */
function unescapeLabelValue(raw: string): string {
  return raw.replace(/\\(.)/g, (_match: string, char: string): string => {
    if (char === 'n') {
      return '\n';
    }

    return char;
  });
}

/**
 * Resolves the escape sequences of a help text.
 *
 * @param raw Text as it was emitted.
 * @returns The text the family carries.
 */
function unescapeHelp(raw: string): string {
  return unescapeLabelValue(raw);
}

/**
 * Names every escape sequence of a string that the format does not define.
 *
 * @param raw String as it was emitted.
 * @param allowed Characters a backslash may introduce.
 * @returns One entry per undefined sequence.
 */
function invalidEscapes(
  raw: string,
  allowed: readonly string[],
): readonly string[] {
  const found: string[] = [];

  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== '\\') {
      continue;
    }

    const next = raw[index + 1];

    if (next === undefined || !allowed.includes(next)) {
      found.push(`\\${next ?? ''}`);
    }

    index += 1;
  }

  return found;
}

/** A label block, as the validator reads it back. */
interface ParsedLabels {
  readonly labels: Readonly<Record<string, string>>;
  readonly problems: readonly string[];
}

/**
 * Reads a label block back, and reports every way it is malformed.
 *
 * The pairs are matched, then RECONSTRUCTED and compared against the block
 * they came from, so a block whose quoting does not close — an unescaped
 * double quote inside a value, a missing comma, trailing text — fails here
 * rather than parsing as a shorter label set.
 *
 * @param inner Block content, between the braces.
 * @returns The labels and the problems.
 */
function parseLabelBlock(inner: string): ParsedLabels {
  const problems: string[] = [];
  const labels: Record<string, string> = {};
  const rendered: string[] = [];
  const seen = new Set<string>();

  LABEL_PAIR.lastIndex = 0;

  for (
    let match = LABEL_PAIR.exec(inner);
    match !== null;
    match = LABEL_PAIR.exec(inner)
  ) {
    const name = match[1] ?? '';
    const raw = match[2] ?? '';

    rendered.push(`${name}="${raw}"`);

    if (!PROMETHEUS_LABEL_NAME.test(name)) {
      problems.push(`label name "${name}" is not a valid label name`);
    }

    if (seen.has(name)) {
      problems.push(`label name "${name}" appears twice in one series`);
    }

    seen.add(name);

    for (const sequence of invalidEscapes(raw, ['\\', '"', 'n'])) {
      problems.push(
        `label "${name}" carries the undefined escape "${sequence}"`,
      );
    }

    labels[name] = unescapeLabelValue(raw);
  }

  if (rendered.join(',') !== inner) {
    problems.push(`label block does not parse: {${inner}}`);
  }

  return { labels, problems };
}

/**
 * Reads one sample line back, and reports every way it is malformed.
 *
 * @param line Line as it was emitted.
 * @param lineNumber One-based line number.
 * @returns The sample, or `null` when the line could not be read at all,
 *   alongside the problems.
 */
function parseSampleLine(
  line: string,
  lineNumber: number,
): { readonly sample: ParsedSample | null; readonly problems: string[] } {
  const problems: string[] = [];
  const nameMatch = /^[a-zA-Z_:][a-zA-Z0-9_:]*/.exec(line);

  if (nameMatch === null) {
    problems.push(`line ${lineNumber} does not start with a metric name`);

    return { sample: null, problems };
  }

  const name = nameMatch[0];
  let cursor = name.length;
  let labels: Readonly<Record<string, string>> = {};
  let hadBraces = false;

  if (line[cursor] === '{') {
    hadBraces = true;

    const close = line.lastIndexOf('}');

    if (close <= cursor) {
      problems.push(`line ${lineNumber} has an unclosed label block`);

      return { sample: null, problems };
    }

    const parsed = parseLabelBlock(line.slice(cursor + 1, close));

    for (const problem of parsed.problems) {
      problems.push(`line ${lineNumber}: ${problem}`);
    }

    labels = parsed.labels;
    cursor = close + 1;
  }

  const remainder = line.slice(cursor);

  if (!remainder.startsWith(' ')) {
    problems.push(
      `line ${lineNumber} has no whitespace before its value`,
    );
  }

  const tokens = remainder.trim().split(/\s+/);
  const valueToken = tokens[0] ?? '';

  if (tokens.length > 2) {
    problems.push(`line ${lineNumber} carries trailing content`);
  }

  if (tokens.length === 2 && !SAMPLE_TIMESTAMP.test(tokens[1] ?? '')) {
    problems.push(`line ${lineNumber} has an unparseable timestamp`);
  }

  if (!NUMERIC_VALUE.test(valueToken) && !SPECIAL_VALUES.has(valueToken)) {
    problems.push(
      `line ${lineNumber} has an unparseable value "${valueToken}"`,
    );

    return { sample: null, problems };
  }

  const value =
    valueToken === INFINITY_BOUND
      ? Number.POSITIVE_INFINITY
      : Number(valueToken);

  return {
    sample: {
      line,
      lineNumber,
      name,
      labels: Object.freeze(labels),
      hadBraces,
      value,
      valueToken,
    },
    problems,
  };
}

/**
 * Builds the identity of a series: its name and its whole label set, with the
 * label names sorted so two orderings of one series compare equal.
 *
 * @param name Sample name.
 * @param labels Labels, with their escape sequences already resolved.
 * @returns The identity.
 */
function seriesIdentity(
  name: string,
  labels: Readonly<Record<string, string>>,
): string {
  const pairs = Object.keys(labels)
    .sort()
    .map((key: string): [string, string] => [key, labels[key] ?? '']);

  return `${name}${JSON.stringify(pairs)}`;
}

/**
 * Builds the identity of a series with its bucket-bound label removed, which
 * is the identity every generated sample of one histogram series shares.
 *
 * @param name Family name.
 * @param labels Labels of the sample.
 * @returns The identity.
 */
function histogramSeriesIdentity(
  name: string,
  labels: Readonly<Record<string, string>>,
): string {
  const withoutBound: Record<string, string> = {};

  for (const key of Object.keys(labels)) {
    if (key !== BUCKET_BOUND_LABEL) {
      withoutBound[key] = labels[key] ?? '';
    }
  }

  return seriesIdentity(name, withoutBound);
}

/**
 * Resolves the family a sample name belongs to.
 *
 * An exact `# TYPE` declaration wins, so a counter named `x_count` resolves to
 * itself rather than to a histogram it merely looks like. Only when there is
 * none is a generated suffix stripped.
 *
 * @param name Sample name.
 * @param kinds Declared kind of every family, keyed by family name.
 * @returns The family name and its kind, or `null` when neither resolves.
 */
function resolveFamily(
  name: string,
  kinds: ReadonlyMap<string, string>,
): { readonly family: string; readonly kind: string } | null {
  const exact = kinds.get(name);

  if (exact !== undefined) {
    return { family: name, kind: exact };
  }

  for (const suffix of HISTOGRAM_SUFFIXES) {
    if (name.length <= suffix.length || !name.endsWith(suffix)) {
      continue;
    }

    const base = name.slice(0, name.length - suffix.length);
    const kind = kinds.get(base);

    if (kind !== undefined) {
      return { family: base, kind };
    }
  }

  return null;
}

/**
 * Checks the generated samples of every histogram series: that a bucket
 * carries a bound, that the overflow bucket exists, that the counts rise with
 * the bound, that the overflow count is the observation count, and that a sum
 * and a count accompany them.
 *
 * @param samples Every sample of the exposition.
 * @param kinds Declared kind of every family.
 * @returns One entry per violation.
 */
function checkHistogramSeries(
  samples: readonly ParsedSample[],
  kinds: ReadonlyMap<string, string>,
): readonly string[] {
  const problems: string[] = [];
  const buckets = new Map<string, { bound: number; count: number }[]>();
  const sums = new Map<string, number>();
  const counts = new Map<string, number>();

  for (const sample of samples) {
    const resolved = resolveFamily(sample.name, kinds);

    if (resolved === null || resolved.kind !== 'histogram') {
      continue;
    }

    const identity = histogramSeriesIdentity(resolved.family, sample.labels);
    const bound = sample.labels[BUCKET_BOUND_LABEL];

    if (sample.name === `${resolved.family}_bucket`) {
      if (bound === undefined) {
        problems.push(
          `line ${sample.lineNumber}: a bucket sample carries no ` +
            `"${BUCKET_BOUND_LABEL}" label`,
        );

        continue;
      }

      const numeric =
        bound === INFINITY_BOUND
          ? Number.POSITIVE_INFINITY
          : Number(bound);

      if (!Number.isFinite(numeric) && bound !== INFINITY_BOUND) {
        problems.push(
          `line ${sample.lineNumber}: bucket bound "${bound}" is not a ` +
            'number',
        );

        continue;
      }

      const held = buckets.get(identity) ?? [];

      held.push({ bound: numeric, count: sample.value });
      buckets.set(identity, held);

      continue;
    }

    if (bound !== undefined) {
      problems.push(
        `line ${sample.lineNumber}: ${sample.name} carries a ` +
          `"${BUCKET_BOUND_LABEL}" label`,
      );
    }

    if (sample.name === `${resolved.family}_sum`) {
      sums.set(identity, sample.value);
    } else if (sample.name === `${resolved.family}_count`) {
      counts.set(identity, sample.value);
    } else {
      problems.push(
        `line ${sample.lineNumber}: ${sample.name} is not a sample a ` +
          `histogram family generates`,
      );
    }
  }

  for (const [identity, held] of buckets) {
    const ordered = [...held].sort(
      (left, right): number => left.bound - right.bound,
    );
    const overflow = ordered[ordered.length - 1];

    if (overflow === undefined || overflow.bound !== Number.POSITIVE_INFINITY) {
      problems.push(`${identity} has no ${INFINITY_BOUND} bucket`);

      continue;
    }

    let previous = Number.NEGATIVE_INFINITY;

    for (const entry of ordered) {
      if (entry.count < previous) {
        problems.push(
          `${identity} bucket counts fall at bound ${entry.bound}`,
        );
      }

      previous = entry.count;
    }

    const count = counts.get(identity);

    if (count === undefined) {
      problems.push(`${identity} has no _count sample`);
    } else if (count !== overflow.count) {
      problems.push(
        `${identity} has a ${INFINITY_BOUND} bucket of ${overflow.count} ` +
          `and a _count of ${count}`,
      );
    }

    if (!sums.has(identity)) {
      problems.push(`${identity} has no _sum sample`);
    }
  }

  return problems;
}

/**
 * Reads a Prometheus text exposition back and reports every way it is
 * malformed.
 *
 * @param text Exposition to read.
 * @returns The parsed structure and its problems.
 */
function parseExposition(text: string): ParsedExposition {
  const problems: string[] = [];
  const help: ParsedMetadata[] = [];
  const type: ParsedMetadata[] = [];
  const samples: ParsedSample[] = [];

  if (text.length === 0) {
    return Object.freeze({
      problems: Object.freeze<string[]>([]),
      help: Object.freeze(help),
      type: Object.freeze(type),
      samples: Object.freeze(samples),
      identities: Object.freeze<string[]>([]),
    });
  }

  if (!text.endsWith('\n')) {
    problems.push('the exposition does not end with a newline');
  }

  const lines = text.split('\n');

  if (lines[lines.length - 1] === '') {
    lines.pop();
  }

  lines.forEach((line: string, index: number): void => {
    const lineNumber = index + 1;

    if (line.length === 0) {
      problems.push(`line ${lineNumber} is blank`);

      return;
    }

    if (line.startsWith('# HELP')) {
      const match = /^# HELP ([^\s]+)(?: (.*))?$/.exec(line);

      if (match === null) {
        problems.push(`line ${lineNumber} is a malformed # HELP line`);

        return;
      }

      const name = match[1] ?? '';
      const raw = match[2] ?? '';

      if (!PROMETHEUS_METRIC_NAME.test(name)) {
        problems.push(
          `line ${lineNumber}: "${name}" is not a valid metric name`,
        );
      }

      for (const sequence of invalidEscapes(raw, ['\\', 'n'])) {
        problems.push(
          `line ${lineNumber}: help carries the undefined escape ` +
            `"${sequence}"`,
        );
      }

      help.push({ name, text: unescapeHelp(raw), lineNumber });

      return;
    }

    if (line.startsWith('# TYPE')) {
      const match = /^# TYPE ([^\s]+) ([^\s]+)$/.exec(line);

      if (match === null) {
        problems.push(`line ${lineNumber} is a malformed # TYPE line`);

        return;
      }

      const name = match[1] ?? '';
      const kind = match[2] ?? '';

      if (!PROMETHEUS_METRIC_NAME.test(name)) {
        problems.push(
          `line ${lineNumber}: "${name}" is not a valid metric name`,
        );
      }

      if (!EXPOSITION_KINDS.has(kind)) {
        problems.push(`line ${lineNumber}: "${kind}" is not a metric type`);
      }

      type.push({ name, text: kind, lineNumber });

      return;
    }

    if (line.startsWith('#')) {
      return;
    }

    const read = parseSampleLine(line, lineNumber);

    problems.push(...read.problems);

    if (read.sample !== null) {
      samples.push(read.sample);
    }
  });

  const helpLines = new Map<string, number[]>();
  const typeLines = new Map<string, number[]>();
  const kinds = new Map<string, string>();

  for (const entry of help) {
    helpLines.set(entry.name, [
      ...(helpLines.get(entry.name) ?? []),
      entry.lineNumber,
    ]);
  }

  for (const entry of type) {
    typeLines.set(entry.name, [
      ...(typeLines.get(entry.name) ?? []),
      entry.lineNumber,
    ]);
    kinds.set(entry.name, entry.text);
  }

  for (const [name, at] of helpLines) {
    if (at.length !== 1) {
      problems.push(
        `${name} carries ${at.length} # HELP lines, at ${at.join(', ')}`,
      );
    }
  }

  for (const [name, at] of typeLines) {
    if (at.length !== 1) {
      problems.push(
        `${name} carries ${at.length} # TYPE lines, at ${at.join(', ')}`,
      );
    }
  }

  const identities: string[] = [];
  const identityLines = new Map<string, number[]>();

  for (const sample of samples) {
    const resolved = resolveFamily(sample.name, kinds);

    if (resolved === null) {
      problems.push(
        `line ${sample.lineNumber}: ${sample.name} has no # TYPE line`,
      );
    } else {
      const helpAt = helpLines.get(resolved.family)?.[0];
      const typeAt = typeLines.get(resolved.family)?.[0];

      if (helpAt === undefined) {
        problems.push(`${resolved.family} has no # HELP line`);
      } else if (helpAt > sample.lineNumber) {
        problems.push(
          `${resolved.family} declares # HELP at line ${helpAt}, after a ` +
            `sample at line ${sample.lineNumber}`,
        );
      }

      if (typeAt !== undefined && typeAt > sample.lineNumber) {
        problems.push(
          `${resolved.family} declares # TYPE at line ${typeAt}, after a ` +
            `sample at line ${sample.lineNumber}`,
        );
      }

      if (
        resolved.kind !== 'histogram' &&
        sample.labels[BUCKET_BOUND_LABEL] !== undefined
      ) {
        problems.push(
          `line ${sample.lineNumber}: a ${resolved.kind} carries a ` +
            `"${BUCKET_BOUND_LABEL}" label`,
        );
      }
    }

    if (sample.hadBraces && Object.keys(sample.labels).length === 0) {
      problems.push(
        `line ${sample.lineNumber}: an empty label set emitted braces`,
      );
    }

    const identity = seriesIdentity(sample.name, sample.labels);

    identities.push(identity);
    identityLines.set(identity, [
      ...(identityLines.get(identity) ?? []),
      sample.lineNumber,
    ]);
  }

  for (const [identity, at] of identityLines) {
    if (at.length !== 1) {
      problems.push(
        `${identity} appears ${at.length} times, at lines ${at.join(', ')}`,
      );
    }
  }

  problems.push(...checkHistogramSeries(samples, kinds));

  return Object.freeze({
    problems: Object.freeze(problems),
    help: Object.freeze(help),
    type: Object.freeze(type),
    samples: Object.freeze(samples),
    identities: Object.freeze(identities),
  });
}

/**
 * Reads an exposition back and asserts it is free of structural violations.
 *
 * @param text Exposition to read.
 * @returns The parsed structure.
 */
function expectValidExposition(text: string): ParsedExposition {
  const parsed = parseExposition(text);

  expect(parsed.problems).toEqual([]);

  return parsed;
}

/**
 * Finds one sample by its series identity.
 *
 * @param parsed Parsed exposition.
 * @param name Sample name.
 * @param labels Labels the series carries.
 * @returns The sample, or `undefined`.
 */
function findSample(
  parsed: ParsedExposition,
  name: string,
  labels: Readonly<Record<string, string>> = {},
): ParsedSample | undefined {
  const wanted = seriesIdentity(name, labels);

  return parsed.samples.find(
    (sample: ParsedSample): boolean =>
      seriesIdentity(sample.name, sample.labels) === wanted,
  );
}

/**
 * Reads the declared kind of one family out of a parsed exposition.
 *
 * @param parsed Parsed exposition.
 * @param name Family name.
 * @returns The kind, or `undefined` when the family declared none.
 */
function declaredKind(
  parsed: ParsedExposition,
  name: string,
): string | undefined {
  return parsed.type.find(
    (entry: ParsedMetadata): boolean => entry.name === name,
  )?.text;
}

/**
 * Reads the help text of one family out of a parsed exposition, with its
 * escape sequences already resolved.
 *
 * @param parsed Parsed exposition.
 * @param name Family name.
 * @returns The text, or `undefined` when the family declared none.
 */
function declaredHelp(
  parsed: ParsedExposition,
  name: string,
): string | undefined {
  return parsed.help.find(
    (entry: ParsedMetadata): boolean => entry.name === name,
  )?.text;
}

/**
 * Projects a snapshot into the sample identities and values a valid
 * exposition of the same registry state must carry, generated names included.
 *
 * @param snapshot Snapshot to project.
 * @returns Every expected sample, keyed by series identity.
 */
function samplesFromSnapshot(
  snapshot: MetricsSnapshot,
): ReadonlyMap<string, number> {
  const expected = new Map<string, number>();

  for (const series of snapshot.series) {
    const labels: Record<string, string> = { ...series.labels };

    if (series.kind !== 'histogram') {
      expected.set(seriesIdentity(series.name, labels), series.value);

      continue;
    }

    series.buckets.forEach((bound: number, index: number): void => {
      expected.set(
        seriesIdentity(`${series.name}_bucket`, {
          ...labels,
          [BUCKET_BOUND_LABEL]: String(bound),
        }),
        series.bucketCounts[index] ?? Number.NaN,
      );
    });

    expected.set(
      seriesIdentity(`${series.name}_bucket`, {
        ...labels,
        [BUCKET_BOUND_LABEL]: INFINITY_BOUND,
      }),
      series.infCount,
    );
    expected.set(seriesIdentity(`${series.name}_sum`, labels), series.sum);
    expected.set(seriesIdentity(`${series.name}_count`, labels), series.count);
  }

  return expected;
}

/**
 * Drops the two snapshot members a clock supplies, so two projections of one
 * registry state compare equal whatever the clock did between them.
 *
 * @param value Snapshot, or a snapshot already parsed back out of JSON.
 * @returns The snapshot without its wall-clock and elapsed readings.
 */
function withoutClockReadings(value: unknown): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    ...(value as Record<string, unknown>),
  };

  delete projected.generatedAt;
  delete projected.elapsedMs;

  return projected;
}

/** A fresh registry, the logger it reports through, and that logger's sink. */
interface RegistryHarness {
  readonly logger: Logger;
  readonly registry: MetricsRegistry;

  /** Every record the logger emitted, in order, as the sink received them. */
  readonly records: readonly LogRecord[];

  /** Detaches the sink. */
  readonly release: () => void;
}

/** Identifier every harness logger and registry below carries. */
const HARNESS_CORRELATION_ID = 'run-metrics-suite-0001';

/**
 * Builds a fresh registry reporting through a fresh logger, with a sink
 * capturing every record the registry causes.
 *
 * @returns The harness.
 */
function createHarness(): RegistryHarness {
  const logger = createSilentLogger(HARNESS_CORRELATION_ID);
  const records: LogRecord[] = [];
  const release = logger.subscribe((record: LogRecord): void => {
    records.push(record);
  });

  return {
    logger,
    registry: createMetricsRegistry({ logger }),
    records,
    release,
  };
}

/**
 * Reads the `reason` field of the records a harness captured.
 *
 * @param harness Harness to read.
 * @returns One entry per record carrying a string `reason`.
 */
function capturedReasons(harness: RegistryHarness): readonly string[] {
  const reasons: string[] = [];

  for (const record of harness.records) {
    const reason: unknown = record.fields?.reason;

    if (typeof reason === 'string') {
      reasons.push(reason);
    }
  }

  return reasons;
}


/* ===== 9. The counter, gauge and histogram primitives ===== */

describe('a counter only rises', () => {
  let harness: RegistryHarness;

  beforeEach((): void => {
    harness = createHarness();
  });

  afterEach((): void => {
    harness.release();
    vi.restoreAllMocks();
  });

  it('starts at zero', () => {
    expect(harness.registry.counter('suite_counter_total').value).toBe(0);
  });

  it('rises by one for inc() with no argument', () => {
    const counter = harness.registry.counter('suite_counter_total');

    counter.inc();

    expect(counter.value).toBe(1);
  });

  it('rises by the delta it is given', () => {
    const counter = harness.registry.counter('suite_counter_total');

    counter.inc(7);

    expect(counter.value).toBe(7);
  });

  it('accumulates across repeated increments', () => {
    const counter = harness.registry.counter('suite_counter_total');

    counter.inc();
    counter.inc(4);
    counter.inc();
    counter.inc(0.5);

    expect(counter.value).toBe(6.5);
  });

  it('accepts a zero delta without changing or rejecting', () => {
    const counter = harness.registry.counter('suite_counter_total');

    counter.inc(3);
    counter.inc(0);

    expect(counter.value).toBe(3);
    expect(harness.registry.snapshot().rejected).toBe(0);
  });

  it('refuses a negative delta, reports it and does not fall', () => {
    const counter = harness.registry.counter('suite_counter_total');

    counter.inc(5);
    counter.inc(-2);

    expect(counter.value).toBe(5);
    expect(capturedReasons(harness)).toContain('negativeDelta');
    expect(harness.registry.snapshot().rejected).toBe(1);
  });

  it('refuses a non-finite delta and does not throw', () => {
    const counter = harness.registry.counter('suite_counter_total');

    counter.inc(2);

    expect((): void => {
      counter.inc(Number.NaN);
      counter.inc(Number.POSITIVE_INFINITY);
      counter.inc(Number.NEGATIVE_INFINITY);
    }).not.toThrow();

    expect(counter.value).toBe(2);
    expect(capturedReasons(harness)).toContain('notFinite');
  });

  it('counts every refusal in the registry rejection counter', () => {
    const counter = harness.registry.counter('suite_counter_total');

    counter.inc(-1);
    counter.inc(Number.NaN);

    expect(
      counterValue(
        harness.registry.snapshot(),
        METRIC_NAMES.metricsRejectedTotal,
      ),
    ).toBe(2);
  });
});

describe('a gauge moves in both directions', () => {
  let harness: RegistryHarness;

  beforeEach((): void => {
    harness = createHarness();
  });

  afterEach((): void => {
    harness.release();
    vi.restoreAllMocks();
  });

  it('starts at zero', () => {
    expect(harness.registry.gauge('suite_gauge').value).toBe(0);
  });

  it('replaces its value on set', () => {
    const gauge = harness.registry.gauge('suite_gauge');

    gauge.set(11);
    gauge.set(4);

    expect(gauge.value).toBe(4);
  });

  it('reads back exactly what was set, including zero', () => {
    const gauge = harness.registry.gauge('suite_gauge');

    gauge.set(9);
    gauge.set(0);

    expect(gauge.value).toBe(0);
    expect(Object.is(gauge.value, 0)).toBe(true);
  });

  it('rises and falls by one with no argument', () => {
    const gauge = harness.registry.gauge('suite_gauge');

    gauge.inc();
    gauge.inc();
    gauge.dec();

    expect(gauge.value).toBe(1);
  });

  it('rises and falls by the delta it is given', () => {
    const gauge = harness.registry.gauge('suite_gauge');

    gauge.inc(6);
    gauge.dec(2.5);

    expect(gauge.value).toBe(3.5);
  });

  it('represents a negative value', () => {
    const gauge = harness.registry.gauge('suite_gauge');

    gauge.set(2);
    gauge.dec(5);

    expect(gauge.value).toBe(-3);

    gauge.set(-12.25);

    expect(gauge.value).toBe(-12.25);
  });

  it('accepts a negative delta, which a counter refuses', () => {
    const gauge = harness.registry.gauge('suite_gauge');

    gauge.set(4);
    gauge.inc(-1.5);

    expect(gauge.value).toBe(2.5);
    expect(harness.registry.snapshot().rejected).toBe(0);
  });

  it('refuses a non-finite value and keeps the one it holds', () => {
    const gauge = harness.registry.gauge('suite_gauge');

    gauge.set(8);

    expect((): void => {
      gauge.set(Number.NaN);
      gauge.inc(Number.POSITIVE_INFINITY);
      gauge.dec(Number.NEGATIVE_INFINITY);
    }).not.toThrow();

    expect(gauge.value).toBe(8);
    expect(capturedReasons(harness)).toContain('notFinite');
  });
});

describe('a histogram buckets its observations cumulatively', () => {
  let harness: RegistryHarness;

  beforeEach((): void => {
    harness = createHarness();
  });

  afterEach((): void => {
    harness.release();
    vi.restoreAllMocks();
  });

  it('starts with no observation, a zero sum and zeroed buckets', () => {
    const histogram = harness.registry.histogram(
      'suite_histogram',
      {},
      [10, 20, 30],
    );

    expect(histogram.count).toBe(0);
    expect(histogram.sum).toBe(0);
    expect(histogram.bucketCounts).toEqual([0, 0, 0]);
  });

  it('raises the count and the sum for each observation', () => {
    const histogram = harness.registry.histogram(
      'suite_histogram',
      {},
      [10, 20, 30],
    );

    histogram.observe(5);
    histogram.observe(15);
    histogram.observe(25);

    expect(histogram.count).toBe(3);
    expect(histogram.sum).toBe(45);
  });

  it('counts one observation into its bucket AND every bucket above it',
    () => {
      const histogram = harness.registry.histogram(
        'suite_histogram',
        {},
        [100, 200, 400, 800],
      );

      histogram.observe(150);

      // 150 exceeds 100 and does not exceed 200, so the 200 bucket and every
      // bucket above it count it, and the 100 bucket does not.
      expect(histogram.bucketCounts).toEqual([0, 1, 1, 1]);
      expect(histogram.count).toBe(1);
    });

  it('keeps the bucket counts non-decreasing across many observations', () => {
    const histogram = harness.registry.histogram(
      'suite_histogram',
      {},
      [10, 20, 30, 40],
    );

    for (const value of [5, 35, 12, 38, 21, 8, 44]) {
      histogram.observe(value);
    }

    const counts = histogram.bucketCounts;

    counts.forEach((count: number, index: number): void => {
      if (index === 0) {
        return;
      }

      expect(count).toBeGreaterThanOrEqual(counts[index - 1] ?? 0);
    });

    expect(counts).toEqual([2, 3, 4, 6]);
    expect(histogram.count).toBe(7);
  });

  it('counts an observation equal to a bound in that bound\'s bucket', () => {
    const histogram = harness.registry.histogram('suite_histogram');
    const bounds = histogram.buckets;
    const at16 = bounds.indexOf(16);
    const at100 = bounds.indexOf(100);

    expect(at16).toBeGreaterThanOrEqual(0);
    expect(at100).toBeGreaterThan(at16);

    // `le` is less-than-or-equal, so the bound itself belongs to its bucket.
    histogram.observe(16);

    expect(histogram.bucketCounts[at16]).toBe(1);
    expect(histogram.bucketCounts[at16 - 1]).toBe(0);

    histogram.observe(100);

    expect(histogram.bucketCounts[at100]).toBe(2);
    expect(histogram.bucketCounts[at100 - 1]).toBe(1);
  });

  it('holds an overflow count equal to the observation count', () => {
    const histogram = harness.registry.histogram(
      'suite_histogram',
      {},
      [10, 20],
    );

    histogram.observe(5);
    histogram.observe(1000);
    histogram.observe(15);

    // The overflow slot is not a member of `bucketCounts`; it is `count`, and
    // it is what the exposition emits as the +Inf bucket.
    expect(histogram.bucketCounts).toEqual([1, 2]);
    expect(histogram.count).toBe(3);

    const series = harness.registry
      .snapshot()
      .series.find(
        (entry): boolean =>
          entry.name === 'suite_histogram' && entry.kind === 'histogram',
      );

    expect(series?.kind).toBe('histogram');
    expect(series?.kind === 'histogram' ? series.infCount : -1).toBe(3);
  });

  it('observes zero into its first bucket', () => {
    const histogram = harness.registry.histogram(
      'suite_histogram',
      {},
      [10, 20],
    );

    histogram.observe(0);

    expect(histogram.bucketCounts).toEqual([1, 1]);
    expect(histogram.count).toBe(1);
    expect(histogram.sum).toBe(0);
  });

  it('observes a very large value into the overflow slot alone', () => {
    const histogram = harness.registry.histogram(
      'suite_histogram',
      {},
      [10, 20],
    );

    histogram.observe(1e12);

    expect(histogram.bucketCounts).toEqual([0, 0]);
    expect(histogram.count).toBe(1);
    expect(histogram.sum).toBe(1e12);
  });

  it('refuses NaN and infinity without corrupting the sum or the count',
    () => {
      const histogram = harness.registry.histogram(
        'suite_histogram',
        {},
        [10, 20],
      );

      histogram.observe(12);

      expect((): void => {
        histogram.observe(Number.NaN);
        histogram.observe(Number.POSITIVE_INFINITY);
        histogram.observe(Number.NEGATIVE_INFINITY);
      }).not.toThrow();

      expect(histogram.count).toBe(1);
      expect(histogram.sum).toBe(12);
      expect(Number.isNaN(histogram.sum)).toBe(false);
      expect(capturedReasons(harness)).toContain('notFinite');
    });

  it('estimates a quantile from a distribution with one value per bucket',
    () => {
      const histogram = harness.registry.histogram(
        'suite_histogram',
        {},
        [10, 20, 30],
      );

      histogram.observe(5);
      histogram.observe(15);
      histogram.observe(25);

      // Bucket-approximated: the estimate is interpolated inside the bucket
      // the rank falls in, and the first bucket's lower edge is the smallest
      // observation recorded.
      expect(histogram.quantile(0)).toBe(5);
      expect(histogram.quantile(0.5)).toBe(15);
      expect(histogram.quantile(1)).toBe(30);
    });

  it('estimates no quantile from an empty histogram and does not throw', () => {
    const histogram = harness.registry.histogram(
      'suite_histogram',
      {},
      [10, 20],
    );

    expect((): number => histogram.quantile(0.5)).not.toThrow();
    expect(Number.isNaN(histogram.quantile(0))).toBe(true);
    expect(Number.isNaN(histogram.quantile(0.5))).toBe(true);
    expect(Number.isNaN(histogram.quantile(1))).toBe(true);
  });

  it('estimates no quantile outside zero to one', () => {
    const histogram = harness.registry.histogram(
      'suite_histogram',
      {},
      [10, 20],
    );

    histogram.observe(5);

    expect(Number.isNaN(histogram.quantile(-0.1))).toBe(true);
    expect(Number.isNaN(histogram.quantile(1.1))).toBe(true);
    expect(Number.isNaN(histogram.quantile(Number.NaN))).toBe(true);
    expect(capturedReasons(harness)).toContain('outOfRange');
  });

  it('estimates inside the bucket the rank falls in, never outside it', () => {
    const histogram = harness.registry.histogram(
      'suite_histogram',
      {},
      [10, 100, 1000],
    );

    // Both observations fall in the 100 bucket, whose edges are 10 and 100.
    // Every estimate is interpolated between those two edges, so the bucket's
    // width bounds the estimate's accuracy.
    histogram.observe(40);
    histogram.observe(60);

    expect(histogram.quantile(0)).toBe(10);
    expect(histogram.quantile(1)).toBe(100);

    for (const q of [0, 0.25, 0.5, 0.75, 1]) {
      const estimate = histogram.quantile(q);

      expect(estimate).toBeGreaterThanOrEqual(10);
      expect(estimate).toBeLessThanOrEqual(100);
    }
  });

  it('never selects an empty bucket', () => {
    const histogram = harness.registry.histogram(
      'suite_histogram',
      {},
      [1, 2, 4, 100],
    );

    // The 1, 2 and 4 buckets hold nothing, so no rank resolves into one of
    // them: every estimate lies between the edges of the one bucket that does
    // hold the observation, and none of the three empty upper bounds is
    // returned.
    histogram.observe(50);

    for (const q of [0, 0.25, 0.5, 0.75, 1]) {
      const estimate = histogram.quantile(q);

      expect(estimate).toBeGreaterThanOrEqual(4);
      expect(estimate).toBeLessThanOrEqual(100);
      expect([1, 2]).not.toContain(estimate);
    }

    expect(histogram.quantile(0)).toBe(4);
    expect(histogram.quantile(1)).toBe(100);
  });

  it('takes the first bucket\'s lower edge from the smallest observation',
    () => {
      const histogram = harness.registry.histogram(
        'suite_histogram',
        {},
        [1000],
      );

      // The first bucket is unbounded below, so its lower edge is the
      // smallest observation rather than zero.
      histogram.observe(400);

      expect(histogram.quantile(0)).toBe(400);
      expect(histogram.quantile(1)).toBe(1000);
    });
});

describe('a label set identifies one series', () => {
  let harness: RegistryHarness;

  beforeEach((): void => {
    harness = createHarness();
  });

  afterEach((): void => {
    harness.release();
    vi.restoreAllMocks();
  });

  it('returns the same series for the same name and the same labels', () => {
    const labels: LabelSet = { hook: 'onMerge', reason: 'exhausted' };
    const first = harness.registry.counter('suite_labelled_total', labels);
    const second = harness.registry.counter('suite_labelled_total', {
      hook: 'onMerge',
      reason: 'exhausted',
    });

    expect(second).toBe(first);

    first.inc(3);

    expect(second.value).toBe(3);
  });

  it('returns a distinct series for the same name and other labels', () => {
    const first = harness.registry.counter('suite_labelled_total', {
      hook: 'onMerge',
    });
    const second = harness.registry.counter('suite_labelled_total', {
      hook: 'onSpawn',
    });

    expect(second).not.toBe(first);

    first.inc(2);
    second.inc(5);

    expect(first.value).toBe(2);
    expect(second.value).toBe(5);
  });

  it('resolves one series whichever order the label names are written in',
    () => {
      const written = harness.registry.counter('suite_labelled_total', {
        a: '1',
        b: '2',
      });
      const reversed = harness.registry.counter('suite_labelled_total', {
        b: '2',
        a: '1',
      });

      expect(reversed).toBe(written);

      written.inc();

      expect(reversed.value).toBe(1);
      expect(Object.keys(reversed.labels)).toEqual(['a', 'b']);
    });

  it('treats an omitted label set and an empty one as one series', () => {
    const omitted = harness.registry.counter('suite_plain_total');
    const empty = harness.registry.counter('suite_plain_total', {});

    expect(empty).toBe(omitted);
    expect(Object.keys(omitted.labels)).toEqual([]);
  });

  it('emits one sample per label set and never a duplicate series', () => {
    for (const hook of HOOK_NAMES) {
      harness.registry
        .counter('suite_labelled_total', { hook })
        .inc(hook.length);
      harness.registry.counter('suite_labelled_total', { hook }).inc(0);
    }

    const parsed = expectValidExposition(
      harness.registry.toPrometheusText(),
    );
    const emitted = parsed.samples.filter(
      (sample: ParsedSample): boolean =>
        sample.name === 'suite_labelled_total',
    );

    expect(emitted).toHaveLength(HOOK_NAMES.length);
    expect(new Set(parsed.identities).size).toBe(parsed.identities.length);
  });
});

describe('reset returns every value to zero', () => {
  let harness: RegistryHarness;

  beforeEach((): void => {
    harness = createHarness();
  });

  afterEach((): void => {
    harness.release();
    vi.restoreAllMocks();
  });

  it('zeroes a counter, a gauge and a histogram', () => {
    const counter = harness.registry.counter('suite_counter_total');
    const gauge = harness.registry.gauge('suite_gauge');
    const histogram = harness.registry.histogram(
      'suite_histogram',
      {},
      [10, 20],
    );

    counter.inc(4);
    gauge.set(-7);
    histogram.observe(5);
    histogram.observe(50);

    harness.registry.reset();

    expect(counter.value).toBe(0);
    expect(gauge.value).toBe(0);
    expect(histogram.count).toBe(0);
    expect(histogram.sum).toBe(0);
    expect(histogram.bucketCounts).toEqual([0, 0]);
  });

  it('hands back the same series it held before the reset', () => {
    const before = harness.registry.counter('suite_counter_total');

    before.inc(9);
    harness.registry.reset();

    const after = harness.registry.counter('suite_counter_total');

    expect(after).toBe(before);
    expect(after.value).toBe(0);
  });

  it('leaves the registry usable, with its families and bounds intact', () => {
    const histogram = harness.registry.histogram(
      'suite_histogram',
      {},
      [10, 20],
    );

    histogram.observe(5);
    harness.registry.reset();

    harness.registry.counter('suite_counter_total').inc(2);
    histogram.observe(15);

    expect(
      counterValue(harness.registry.snapshot(), 'suite_counter_total'),
    ).toBe(2);
    expect(histogram.buckets).toEqual([10, 20]);
    expect(histogram.bucketCounts).toEqual([0, 1]);

    expectValidExposition(harness.registry.toPrometheusText());
  });

  it('forgets the rejections it had counted', () => {
    harness.registry.counter('suite_counter_total').inc(-1);

    expect(harness.registry.snapshot().rejected).toBe(1);

    harness.registry.reset();

    expect(harness.registry.snapshot().rejected).toBe(0);
    expect(
      counterValue(
        harness.registry.snapshot(),
        METRIC_NAMES.metricsRejectedTotal,
      ),
    ).toBe(0);
  });
});


/* ===== 10. DEFAULT_DURATION_BUCKETS carries the product's own timing budget,
 * extracted from js/animframe_polyfill.js and style/main.scss ===== */

/**
 * The frame budget of js/animframe_polyfill.js L13,
 * `var timeToCall = Math.max(0, 16 - (currTime - lastTime));`.
 */
const FRAME_BUDGET_MS = 16;

/**
 * The animation cadence of the retired stylesheet, each boundary at the line
 * it was read from.
 *
 * style/main.scss L22  `$transition-speed: 100ms`, the move transition of L329
 * style/main.scss L430 `appear 200ms ease $transition-speed`, the spawn
 * style/main.scss L450 `pop 200ms ease $transition-speed`, the merge
 * style/main.scss L104 `move-up 600ms ease-in`, the score delta
 * style/main.scss L234 `fade-in 800ms ease $transition-speed * 12`, the
 *                      terminal overlay's 800 ms fade after its 1200 ms delay
 */
const STYLESHEET_CADENCE_MS: readonly number[] = Object.freeze([
  100, 200, 600, 800, 1200,
]);

describe('the default duration buckets come from the timing budget', () => {
  it('carries the frame budget of js/animframe_polyfill.js L13', () => {
    expect(DEFAULT_DURATION_BUCKETS).toContain(FRAME_BUDGET_MS);
  });

  it('carries the animation cadence of style/main.scss', () => {
    for (const boundary of STYLESHEET_CADENCE_MS) {
      expect(DEFAULT_DURATION_BUCKETS).toContain(boundary);
    }
  });

  it('gives sub-frame resolution below the frame budget', () => {
    const below = DEFAULT_DURATION_BUCKETS.filter(
      (bound: number): boolean => bound < FRAME_BUDGET_MS,
    );

    expect(below.length).toBeGreaterThan(0);
  });

  it('reaches past the 1200 ms overlay delay', () => {
    const last = DEFAULT_DURATION_BUCKETS[DEFAULT_DURATION_BUCKETS.length - 1];

    expect(last).toBeGreaterThan(1200);
  });

  it('is strictly ascending, as the exposition format requires', () => {
    DEFAULT_DURATION_BUCKETS.forEach((bound: number, index: number): void => {
      if (index === 0) {
        return;
      }

      expect(bound).toBeGreaterThan(DEFAULT_DURATION_BUCKETS[index - 1] ?? 0);
    });
  });

  it('holds no duplicate boundary', () => {
    expect(new Set(DEFAULT_DURATION_BUCKETS).size).toBe(
      DEFAULT_DURATION_BUCKETS.length,
    );
  });

  it('holds only finite positive boundaries', () => {
    for (const bound of DEFAULT_DURATION_BUCKETS) {
      expect(Number.isFinite(bound)).toBe(true);
      expect(bound).toBeGreaterThan(0);
    }
  });

  it('is frozen, so no consumer can reorder or extend it', () => {
    expect(Object.isFrozen(DEFAULT_DURATION_BUCKETS)).toBe(true);
  });
});

describe('a duration histogram exposes the default layout', () => {
  let harness: RegistryHarness;

  beforeEach((): void => {
    harness = createHarness();
  });

  afterEach((): void => {
    harness.release();
    vi.restoreAllMocks();
  });

  it('gives a histogram created with no bounds exactly the defaults', () => {
    const histogram = harness.registry.histogram('suite_default_histogram');

    expect(histogram.buckets).toEqual([...DEFAULT_DURATION_BUCKETS]);
  });

  it('gives the frame-time and turn-latency families the defaults', () => {
    harness.registry.recordFrame(4);
    harness.registry.recordTurnLatency(4);

    const parsed = expectValidExposition(
      harness.registry.toPrometheusText(),
    );

    for (const family of [
      METRIC_NAMES.frameTimeMilliseconds,
      METRIC_NAMES.turnLatencyMilliseconds,
    ]) {
      const bounds = parsed.samples
        .filter(
          (sample: ParsedSample): boolean =>
            sample.name === `${family}_bucket` &&
            sample.labels[BUCKET_BOUND_LABEL] !== INFINITY_BOUND,
        )
        .map((sample: ParsedSample): number =>
          Number(sample.labels[BUCKET_BOUND_LABEL]),
        );

      expect(bounds).toEqual([...DEFAULT_DURATION_BUCKETS]);
    }
  });

  it('emits one bucket per boundary plus the overflow bucket', () => {
    const histogram = harness.registry.histogram('suite_default_histogram');

    histogram.observe(FRAME_BUDGET_MS);

    const parsed = expectValidExposition(
      harness.registry.toPrometheusText(),
    );
    const buckets = parsed.samples.filter(
      (sample: ParsedSample): boolean =>
        sample.name === 'suite_default_histogram_bucket',
    );

    expect(buckets).toHaveLength(DEFAULT_DURATION_BUCKETS.length + 1);
    expect(
      findSample(parsed, 'suite_default_histogram_bucket', {
        [BUCKET_BOUND_LABEL]: INFINITY_BOUND,
      })?.value,
    ).toBe(1);
  });

  it('lets an explicit bound list override the defaults', () => {
    const explicit: readonly number[] = [5, 50, 500];
    const histogram = harness.registry.histogram(
      'suite_explicit_histogram',
      {},
      explicit,
    );

    expect(histogram.buckets).toEqual([...explicit]);
    expect(histogram.buckets).not.toEqual([...DEFAULT_DURATION_BUCKETS]);
  });

  it('sorts and deduplicates an explicit bound list', () => {
    const histogram = harness.registry.histogram(
      'suite_messy_histogram',
      {},
      [500, 5, 5, 50],
    );

    expect(histogram.buckets).toEqual([5, 50, 500]);
  });

  it('falls back to the defaults for an unusable bound list', () => {
    const histogram = harness.registry.histogram(
      'suite_unusable_histogram',
      {},
      [Number.NaN, Number.POSITIVE_INFINITY],
    );

    expect(histogram.buckets).toEqual([...DEFAULT_DURATION_BUCKETS]);
  });

  it('reads its observations in milliseconds', () => {
    const histogram = harness.registry.histogram('suite_default_histogram');
    const bounds = histogram.buckets;
    const atFrameBudget = bounds.indexOf(FRAME_BUDGET_MS);

    // One frame over budget by a hair: 16.5 ms exceeds the 16 ms boundary and
    // not the next one, so the frame-budget bucket must not count it and the
    // next bucket must.
    histogram.observe(16.5);

    expect(histogram.bucketCounts[atFrameBudget]).toBe(0);
    expect(histogram.bucketCounts[atFrameBudget + 1]).toBe(1);

    // The 1200 ms overlay delay lands in the 1200 ms bucket, which is the
    // boundary style/main.scss L234 supplied.
    histogram.observe(1200);

    expect(histogram.bucketCounts[bounds.indexOf(1200)]).toBe(2);
    expect(histogram.bucketCounts[bounds.indexOf(1200) - 1]).toBe(1);
    expect(histogram.sum).toBe(1216.5);
  });
});


/* ===== 11. The canonical metric names ===== */

/** Every canonical family name, as the module declares them. */
const CANONICAL_NAMES: readonly string[] = Object.freeze(
  Object.values(METRIC_NAMES),
);

/** The per-hook families, each one family carrying a `hook` label. */
const PER_HOOK_FAMILIES: readonly string[] = Object.freeze([
  METRIC_NAMES.hookDispatchesTotal,
  METRIC_NAMES.hookHandlerInvocationsTotal,
  METRIC_NAMES.hookPayloadRejectionsTotal,
  METRIC_NAMES.relicHandlerErrorsTotal,
]);

describe('the canonical names cover every hook of the engine tuple', () => {
  let harness: RegistryHarness;

  beforeEach((): void => {
    harness = createHarness();
  });

  afterEach((): void => {
    harness.release();
    vi.restoreAllMocks();
  });

  it('holds one dispatch-count series per HOOK_NAMES member and no other',
    () => {
      const labelled = harness.registry
        .snapshot()
        .series.filter(
          (series): boolean =>
            series.name === METRIC_NAMES.hookDispatchesTotal,
        )
        .map((series): string | undefined =>
          series.labels[METRIC_LABELS.hook],
        );

      expect([...labelled].sort()).toEqual([...HOOK_NAMES].sort());
    });

  it('holds one series per HOOK_NAMES member in every per-hook family', () => {
    const snapshot = harness.registry.snapshot();

    for (const family of PER_HOOK_FAMILIES) {
      const labelled = snapshot.series
        .filter((series): boolean => series.name === family)
        .map((series): string | undefined =>
          series.labels[METRIC_LABELS.hook],
        );

      expect([...labelled].sort()).toEqual([...HOOK_NAMES].sort());
    }
  });

  it('holds one skip series per hook and reason', () => {
    const snapshot = harness.registry.snapshot();
    const perHook = new Map<string, number>();

    for (const series of snapshot.series) {
      if (series.name !== METRIC_NAMES.hookHandlerSkippedTotal) {
        continue;
      }

      const hook = series.labels[METRIC_LABELS.hook] ?? '';
      const reason = series.labels[METRIC_LABELS.reason] ?? '';

      expect(reason.length).toBeGreaterThan(0);
      perHook.set(hook, (perHook.get(hook) ?? 0) + 1);
    }

    expect([...perHook.keys()].sort()).toEqual([...HOOK_NAMES].sort());

    const reasonsPerHook = perHook.get(HOOK_NAMES[0]) ?? 0;

    expect(reasonsPerHook).toBeGreaterThan(0);

    for (const count of perHook.values()) {
      expect(count).toBe(reasonsPerHook);
    }
  });

  it('holds one emission series per ENGINE_EVENT_NAMES member', () => {
    const labelled = harness.registry
      .snapshot()
      .series.filter(
        (series): boolean => series.name === METRIC_NAMES.engineEventsTotal,
      )
      .map((series): string | undefined =>
        series.labels[METRIC_LABELS.event],
      );

    expect([...labelled].sort()).toEqual([...ENGINE_EVENT_NAMES].sort());
  });

  it('exposes every hook and every event in the text exposition', () => {
    const parsed = expectValidExposition(
      harness.registry.toPrometheusText(),
    );

    for (const hook of HOOK_NAMES) {
      for (const family of PER_HOOK_FAMILIES) {
        expect(
          findSample(parsed, family, { [METRIC_LABELS.hook]: hook }),
        ).toBeDefined();
      }
    }

    for (const event of ENGINE_EVENT_NAMES) {
      expect(
        findSample(parsed, METRIC_NAMES.engineEventsTotal, {
          [METRIC_LABELS.event]: event,
        }),
      ).toBeDefined();
    }
  });
});

describe('the canonical names are valid, distinct and prefixed', () => {
  let harness: RegistryHarness;

  beforeEach((): void => {
    harness = createHarness();
  });

  afterEach((): void => {
    harness.release();
    vi.restoreAllMocks();
  });

  it('declares the turn, merge, spawn, error and frame counters', () => {
    expect(CANONICAL_NAMES).toContain(METRIC_NAMES.turnsTotal);
    expect(CANONICAL_NAMES).toContain(METRIC_NAMES.mergesTotal);
    expect(CANONICAL_NAMES).toContain(METRIC_NAMES.spawnsTotal);
    expect(CANONICAL_NAMES).toContain(METRIC_NAMES.relicHandlerErrorsTotal);
    expect(CANONICAL_NAMES).toContain(METRIC_NAMES.framesRenderedTotal);
  });

  it('declares the frame-time and turn-latency histograms', () => {
    expect(CANONICAL_NAMES).toContain(METRIC_NAMES.frameTimeMilliseconds);
    expect(CANONICAL_NAMES).toContain(METRIC_NAMES.turnLatencyMilliseconds);
  });

  it('collides with nothing: every name is distinct', () => {
    expect(new Set(CANONICAL_NAMES).size).toBe(CANONICAL_NAMES.length);
  });

  it('gives every name the exposition format\'s grammar', () => {
    for (const name of CANONICAL_NAMES) {
      expect(name).toMatch(PROMETHEUS_METRIC_NAME);
      expect(isValidMetricName(name)).toBe(true);
    }
  });

  it('prefixes every name with the product prefix', () => {
    expect(METRIC_PREFIX.length).toBeGreaterThan(0);
    expect(isValidMetricName(METRIC_PREFIX)).toBe(true);

    for (const name of CANONICAL_NAMES) {
      expect(name.startsWith(METRIC_PREFIX)).toBe(true);
      expect(name.length).toBeGreaterThan(METRIC_PREFIX.length);
    }
  });

  it('freezes the name table', () => {
    expect(Object.isFrozen(METRIC_NAMES)).toBe(true);
    expect(Object.isFrozen(METRIC_LABELS)).toBe(true);
  });

  it('gives every canonical label the format\'s label grammar', () => {
    for (const label of Object.values(METRIC_LABELS)) {
      expect(label).toMatch(PROMETHEUS_LABEL_NAME);
      expect(label).not.toBe(BUCKET_BOUND_LABEL);
    }

    expect(new Set(Object.values(METRIC_LABELS)).size).toBe(
      Object.values(METRIC_LABELS).length,
    );
  });

  it('ends no family name in a suffix the serialiser appends', () => {
    const parsed = expectValidExposition(
      harness.registry.toPrometheusText(),
    );

    expect(parsed.type.length).toBeGreaterThan(0);

    for (const family of parsed.type) {
      for (const suffix of HISTOGRAM_SUFFIXES) {
        expect(family.name.endsWith(suffix)).toBe(false);
      }
    }
  });

  it('declares a kind for every canonical name it registers', () => {
    const parsed = expectValidExposition(
      harness.registry.toPrometheusText(),
    );

    for (const name of CANONICAL_NAMES) {
      expect(declaredKind(parsed, name)).toBeDefined();
      expect(declaredHelp(parsed, name)?.length).toBeGreaterThan(0);
    }
  });

  it('registers the three duration families as histograms', () => {
    const parsed = expectValidExposition(
      harness.registry.toPrometheusText(),
    );

    for (const name of [
      METRIC_NAMES.frameTimeMilliseconds,
      METRIC_NAMES.turnLatencyMilliseconds,
      METRIC_NAMES.spanDurationMilliseconds,
    ]) {
      expect(declaredKind(parsed, name)).toBe('histogram');
      expect(name.endsWith('_milliseconds')).toBe(true);
    }

    expect(declaredKind(parsed, METRIC_NAMES.healthCheckStatus)).toBe('gauge');
    expect(declaredKind(parsed, METRIC_NAMES.turnsTotal)).toBe('counter');
  });
});


/* ===== 12. The text exposition is VALID Prometheus (V8, third bullet) ===== */

/** Family the escaping cases below are emitted under. */
const ESCAPE_FAMILY = 'suite_escaped_total';

/** A label value carrying each of the three characters the format escapes. */
const AWKWARD_LABEL_VALUE = 'a"b\\c\nd';

/** A help text carrying a newline and a backslash. */
const AWKWARD_HELP = 'first line\nsecond \\ line';

/** Observations the exposed histogram below records. Sum is exactly 1360. */
const EXPOSED_OBSERVATIONS: readonly number[] = Object.freeze([
  8, 16, 100, 36, 1200,
]);

/**
 * Populates a registry with one described counter, one described gauge, one
 * labelled counter whose value needs escaping, one undescribed counter and one
 * histogram carrying several observations.
 *
 * @param registry Registry to populate.
 */
function populateExposition(registry: MetricsRegistry): void {
  registry.describe('suite_exposed_total', 'Requests handled.', 'counter');
  registry.counter('suite_exposed_total').inc(12);

  registry.describe('suite_exposed_gauge', 'Tiles on the board.', 'gauge');
  registry.gauge('suite_exposed_gauge').set(-4.5);

  registry.describe(ESCAPE_FAMILY, AWKWARD_HELP, 'counter');
  registry.counter(ESCAPE_FAMILY, { path: AWKWARD_LABEL_VALUE }).inc(3);
  registry.counter(ESCAPE_FAMILY, { path: 'plain', scope: 'run' }).inc(1);

  registry.counter('suite_undescribed_total').inc(2);

  const histogram = registry.histogram('suite_exposed_histogram');

  for (const observation of EXPOSED_OBSERVATIONS) {
    histogram.observe(observation);
  }
}

describe('the Prometheus text exposition', () => {
  let harness: RegistryHarness;

  beforeEach((): void => {
    harness = createHarness();
    populateExposition(harness.registry);
  });

  afterEach((): void => {
    harness.release();
    vi.restoreAllMocks();
  });

  it('is structurally valid throughout', () => {
    const parsed = expectValidExposition(
      harness.registry.toPrometheusText(),
    );

    expect(parsed.samples.length).toBeGreaterThan(0);
    expect(parsed.type.length).toBeGreaterThan(0);
  });

  it('reads the same through the prometheusText accessor', () => {
    expect(harness.registry.prometheusText).toBe(
      harness.registry.toPrometheusText(),
    );
  });

  it('declares one # HELP and one # TYPE per family', () => {
    const parsed = expectValidExposition(
      harness.registry.toPrometheusText(),
    );
    const helpNames = parsed.help.map(
      (entry: ParsedMetadata): string => entry.name,
    );
    const typeNames = parsed.type.map(
      (entry: ParsedMetadata): string => entry.name,
    );

    expect(new Set(helpNames).size).toBe(helpNames.length);
    expect(new Set(typeNames).size).toBe(typeNames.length);
    expect([...helpNames].sort()).toEqual([...typeNames].sort());
  });

  it('declares both before the family\'s first sample', () => {
    const parsed = expectValidExposition(
      harness.registry.toPrometheusText(),
    );
    const firstSample = parsed.samples.find(
      (sample: ParsedSample): boolean =>
        sample.name === 'suite_exposed_total',
    );
    const help = parsed.help.find(
      (entry: ParsedMetadata): boolean =>
        entry.name === 'suite_exposed_total',
    );
    const type = parsed.type.find(
      (entry: ParsedMetadata): boolean =>
        entry.name === 'suite_exposed_total',
    );

    expect(help?.lineNumber).toBeLessThan(firstSample?.lineNumber ?? 0);
    expect(type?.lineNumber).toBeLessThan(firstSample?.lineNumber ?? 0);
    expect(help?.lineNumber).toBeLessThan(type?.lineNumber ?? 0);
  });

  it('declares a kind that matches the family it was registered as', () => {
    const parsed = expectValidExposition(
      harness.registry.toPrometheusText(),
    );

    expect(declaredKind(parsed, 'suite_exposed_total')).toBe('counter');
    expect(declaredKind(parsed, 'suite_exposed_gauge')).toBe('gauge');
    expect(declaredKind(parsed, 'suite_exposed_histogram')).toBe('histogram');
    expect(declaredKind(parsed, 'suite_undescribed_total')).toBe('counter');

    for (const entry of parsed.type) {
      expect(EXPOSITION_KINDS.has(entry.text)).toBe(true);
    }
  });

  it('carries the help text it was described with', () => {
    const parsed = expectValidExposition(
      harness.registry.toPrometheusText(),
    );

    expect(declaredHelp(parsed, 'suite_exposed_total')).toBe(
      'Requests handled.',
    );
    expect(declaredHelp(parsed, 'suite_exposed_gauge')).toBe(
      'Tiles on the board.',
    );
  });

  it('gives an undescribed family a help line of its own', () => {
    const parsed = expectValidExposition(
      harness.registry.toPrometheusText(),
    );
    const help = declaredHelp(parsed, 'suite_undescribed_total');

    expect(help).toBeDefined();
    expect(help?.length).toBeGreaterThan(0);
  });

  it('escapes a help text onto a single line', () => {
    const text = harness.registry.toPrometheusText();
    const parsed = expectValidExposition(text);
    const emitted = text
      .split('\n')
      .filter((line: string): boolean =>
        line.startsWith(`# HELP ${ESCAPE_FAMILY} `),
      );

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain('\\n');
    expect(emitted[0]).toContain('\\\\');
    expect(declaredHelp(parsed, ESCAPE_FAMILY)).toBe(AWKWARD_HELP);
  });

  it('escapes a quote, a backslash and a newline in a label value', () => {
    const text = harness.registry.toPrometheusText();
    const emitted = text
      .split('\n')
      .filter(
        (line: string): boolean =>
          line.startsWith(`${ESCAPE_FAMILY}{`) && line.includes('a\\"b'),
      );

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toBe(`${ESCAPE_FAMILY}{path="a\\"b\\\\c\\nd"} 3`);
  });

  it('reads an escaped label value back as the value it was given', () => {
    const parsed = expectValidExposition(
      harness.registry.toPrometheusText(),
    );
    const sample = findSample(parsed, ESCAPE_FAMILY, {
      path: AWKWARD_LABEL_VALUE,
    });

    expect(sample?.labels.path).toBe(AWKWARD_LABEL_VALUE);
    expect(sample?.value).toBe(3);
  });

  it('renders a multi-label series as one comma-separated block', () => {
    const text = harness.registry.toPrometheusText();

    expect(text).toContain(
      `${ESCAPE_FAMILY}{path="plain",scope="run"} 1`,
    );
  });

  it('emits no braces for a series carrying no labels', () => {
    const text = harness.registry.toPrometheusText();

    expect(text).toContain('suite_exposed_total 12');
    expect(text).not.toContain('suite_exposed_total{}');
    expect(text).not.toContain('{}');
  });

  it('emits a bucket per boundary, an overflow bucket, a sum and a count',
    () => {
      const parsed = expectValidExposition(
        harness.registry.toPrometheusText(),
      );
      const bounds = DEFAULT_DURATION_BUCKETS;

      for (const bound of bounds) {
        expect(
          findSample(parsed, 'suite_exposed_histogram_bucket', {
            [BUCKET_BOUND_LABEL]: String(bound),
          }),
        ).toBeDefined();
      }

      expect(
        findSample(parsed, 'suite_exposed_histogram_bucket', {
          [BUCKET_BOUND_LABEL]: INFINITY_BOUND,
        }),
      ).toBeDefined();
      expect(findSample(parsed, 'suite_exposed_histogram_sum')).toBeDefined();
      expect(findSample(parsed, 'suite_exposed_histogram_count')).toBeDefined();
    });

  it('rises its bucket counts with the bound and never falls', () => {
    const parsed = expectValidExposition(
      harness.registry.toPrometheusText(),
    );
    const ordered = parsed.samples
      .filter(
        (sample: ParsedSample): boolean =>
          sample.name === 'suite_exposed_histogram_bucket',
      )
      .map((sample: ParsedSample): { bound: number; count: number } => ({
        bound:
          sample.labels[BUCKET_BOUND_LABEL] === INFINITY_BOUND
            ? Number.POSITIVE_INFINITY
            : Number(sample.labels[BUCKET_BOUND_LABEL]),
        count: sample.value,
      }))
      .sort((left, right): number => left.bound - right.bound);

    ordered.forEach((entry, index: number): void => {
      if (index === 0) {
        return;
      }

      expect(entry.count).toBeGreaterThanOrEqual(
        ordered[index - 1]?.count ?? 0,
      );
    });

    // 8, 16, 36, 100 and 1200 against the default layout.
    expect(ordered[ordered.length - 1]?.count).toBe(
      EXPOSED_OBSERVATIONS.length,
    );
  });

  it('gives the overflow bucket the count of every observation', () => {
    const parsed = expectValidExposition(
      harness.registry.toPrometheusText(),
    );
    const overflow = findSample(parsed, 'suite_exposed_histogram_bucket', {
      [BUCKET_BOUND_LABEL]: INFINITY_BOUND,
    });
    const count = findSample(parsed, 'suite_exposed_histogram_count');

    expect(overflow?.value).toBe(EXPOSED_OBSERVATIONS.length);
    expect(count?.value).toBe(overflow?.value);
  });

  it('gives the sum the total of every observation', () => {
    const parsed = expectValidExposition(
      harness.registry.toPrometheusText(),
    );
    const expected = EXPOSED_OBSERVATIONS.reduce(
      (total: number, observation: number): number => total + observation,
      0,
    );
    const sum = findSample(parsed, 'suite_exposed_histogram_sum');

    expect(sum?.value).toBeCloseTo(expected, 10);
    expect(sum?.value).toBe(1360);
  });

  it('emits no duplicate series', () => {
    const parsed = expectValidExposition(
      harness.registry.toPrometheusText(),
    );

    expect(new Set(parsed.identities).size).toBe(parsed.identities.length);
  });

  it('gives every sample line a valid name, an optional label block and a ' +
    'parseable value', () => {
    const text = harness.registry.toPrometheusText();
    const parsed = expectValidExposition(text);
    const sampleLines = text
      .split('\n')
      .filter(
        (line: string): boolean =>
          line.length > 0 && !line.startsWith('#'),
      );

    expect(parsed.samples).toHaveLength(sampleLines.length);

    for (const sample of parsed.samples) {
      expect(sample.name).toMatch(PROMETHEUS_METRIC_NAME);
      expect(Number.isFinite(sample.value)).toBe(true);

      for (const label of Object.keys(sample.labels)) {
        expect(label).toMatch(PROMETHEUS_LABEL_NAME);
      }
    }
  });

  it('formats every value as a token a strict consumer parses', () => {
    const text = harness.registry.toPrometheusText();

    for (const sample of expectValidExposition(text).samples) {
      expect(
        NUMERIC_VALUE.test(sample.valueToken) ||
          SPECIAL_VALUES.has(sample.valueToken),
      ).toBe(true);
      expect(sample.valueToken).not.toContain('Infinity');
      expect(sample.valueToken.toLowerCase()).not.toContain('undefined');
      expect(Number(sample.valueToken)).toBe(sample.value);
    }

    expect(text).toContain('suite_exposed_gauge -4.5');
  });

  it('ends with a newline and carries no blank line', () => {
    const text = harness.registry.toPrometheusText();

    expect(text.endsWith('\n')).toBe(true);
    expect(text).not.toContain('\n\n');
    expect(text.startsWith('\n')).toBe(false);
  });

  it('renders one exposition for one registry state', () => {
    const first = harness.registry.toPrometheusText();
    const second = harness.registry.toPrometheusText();

    expect(second).toBe(first);
  });
});

describe('a registry with nothing recorded still exposes valid text', () => {
  let harness: RegistryHarness;

  beforeEach((): void => {
    harness = createHarness();
  });

  afterEach((): void => {
    harness.release();
    vi.restoreAllMocks();
  });

  it('exposes its canonical families without throwing', () => {
    let text = '';

    expect((): void => {
      text = harness.registry.toPrometheusText();
    }).not.toThrow();

    const parsed = expectValidExposition(text);

    expect(parsed.type.length).toBeGreaterThan(0);
    expect(parsed.problems).toEqual([]);
  });

  it('exposes every sample at zero', () => {
    const parsed = expectValidExposition(
      harness.registry.toPrometheusText(),
    );

    for (const sample of parsed.samples) {
      expect(sample.value).toBe(0);
    }
  });

  it('exposes metadata alone for a family holding no series yet', () => {
    const parsed = expectValidExposition(
      harness.registry.toPrometheusText(),
    );
    const dynamic = [
      METRIC_NAMES.rngDrawsTotal,
      METRIC_NAMES.healthCheckStatus,
      METRIC_NAMES.spanDurationMilliseconds,
    ];

    for (const family of dynamic) {
      expect(declaredKind(parsed, family)).toBeDefined();
      expect(declaredHelp(parsed, family)?.length).toBeGreaterThan(0);
      expect(
        parsed.samples.filter((sample: ParsedSample): boolean =>
          sample.name.startsWith(family),
        ),
      ).toEqual([]);
    }
  });

  it('reads an exposition holding no line at all as valid', () => {
    const parsed = parseExposition('');

    expect(parsed.problems).toEqual([]);
    expect(parsed.samples).toEqual([]);
    expect(parsed.type).toEqual([]);
  });

  it('stays valid once the dynamic families hold series', () => {
    harness.registry.recordSpanDuration('turn', 12);
    harness.registry.recordHealthCheck('webgl', false);
    harness.registry.recordRngCursors({ 'spawn-value': 3 });

    const parsed = expectValidExposition(
      harness.registry.toPrometheusText(),
    );

    expect(
      findSample(parsed, `${METRIC_NAMES.spanDurationMilliseconds}_count`, {
        [METRIC_LABELS.span]: 'turn',
      })?.value,
    ).toBe(1);
    expect(
      findSample(parsed, METRIC_NAMES.healthCheckStatus, {
        [METRIC_LABELS.check]: 'webgl',
      })?.value,
    ).toBe(0);
    expect(
      findSample(parsed, METRIC_NAMES.rngDrawsTotal, {
        [METRIC_LABELS.stream]: 'spawn-value',
      })?.value,
    ).toBe(3);
  });
});


/* ===== 13. snapshot() and toPrometheusText() describe one state ===== */

describe('the snapshot and the exposition agree', () => {
  let harness: RegistryHarness;

  beforeEach((): void => {
    harness = createHarness();
    populateExposition(harness.registry);
  });

  afterEach((): void => {
    harness.release();
    vi.restoreAllMocks();
  });

  it('carries every snapshot series into the exposition, at its value', () => {
    const snapshot = harness.registry.snapshot();
    const parsed = expectValidExposition(
      harness.registry.toPrometheusText(),
    );
    const expected = samplesFromSnapshot(snapshot);

    for (const [identity, value] of expected) {
      const sample = parsed.samples.find(
        (candidate: ParsedSample): boolean =>
          seriesIdentity(candidate.name, candidate.labels) === identity,
      );

      expect(sample, `no sample for ${identity}`).toBeDefined();
      expect(sample?.value).toBe(value);
    }
  });

  it('carries no sample the snapshot does not hold', () => {
    const expected = samplesFromSnapshot(harness.registry.snapshot());
    const parsed = expectValidExposition(
      harness.registry.toPrometheusText(),
    );

    expect([...parsed.identities].sort()).toEqual([...expected.keys()].sort());
  });

  it('gives one series the same help text in both projections', () => {
    const snapshot = harness.registry.snapshot();
    const parsed = expectValidExposition(
      harness.registry.toPrometheusText(),
    );

    for (const series of snapshot.series) {
      expect(declaredHelp(parsed, series.name)).toBe(series.help);
    }
  });

  it('gives one series the same kind in both projections', () => {
    const snapshot = harness.registry.snapshot();
    const parsed = expectValidExposition(
      harness.registry.toPrometheusText(),
    );

    for (const series of snapshot.series) {
      expect(declaredKind(parsed, series.name)).toBe(series.kind);
    }
  });

  it('gives a histogram the same bounds, counts, sum and overflow', () => {
    const snapshot = harness.registry.snapshot();
    const parsed = expectValidExposition(
      harness.registry.toPrometheusText(),
    );
    const histogram = snapshot.series.find(
      (series): boolean =>
        series.name === 'suite_exposed_histogram' &&
        series.kind === 'histogram',
    );

    expect(histogram?.kind).toBe('histogram');

    if (histogram === undefined || histogram.kind !== 'histogram') {
      return;
    }

    histogram.buckets.forEach((bound: number, index: number): void => {
      expect(
        findSample(parsed, 'suite_exposed_histogram_bucket', {
          [BUCKET_BOUND_LABEL]: String(bound),
        })?.value,
      ).toBe(histogram.bucketCounts[index]);
    });

    expect(
      findSample(parsed, 'suite_exposed_histogram_bucket', {
        [BUCKET_BOUND_LABEL]: INFINITY_BOUND,
      })?.value,
    ).toBe(histogram.infCount);
    expect(findSample(parsed, 'suite_exposed_histogram_sum')?.value).toBe(
      histogram.sum,
    );
    expect(findSample(parsed, 'suite_exposed_histogram_count')?.value).toBe(
      histogram.count,
    );
    expect(histogram.infCount).toBe(histogram.count);
  });

  it('stays in agreement after a reset', () => {
    harness.registry.reset();

    const expected = samplesFromSnapshot(harness.registry.snapshot());
    const parsed = expectValidExposition(
      harness.registry.toPrometheusText(),
    );

    expect([...parsed.identities].sort()).toEqual([...expected.keys()].sort());

    for (const value of expected.values()) {
      expect(value).toBe(0);
    }
  });

  it('carries the schema version and the correlation identifier', () => {
    const snapshot = harness.registry.snapshot();

    expect(snapshot.schemaVersion).toBe(METRICS_SNAPSHOT_SCHEMA_VERSION);
    expect(snapshot.correlationId).toBe(HARNESS_CORRELATION_ID);
    expect(harness.registry.correlationId).toBe(HARNESS_CORRELATION_ID);
  });

  it('round-trips through JSON unchanged', () => {
    const snapshot = harness.registry.snapshot();
    const revived: unknown = JSON.parse(JSON.stringify(snapshot));

    expect(revived).toEqual(snapshot);

    // `generatedAt` and `elapsedMs` are clock readings. The comparison below
    // covers the remaining members; the two readings are checked for shape.
    expect(withoutClockReadings(JSON.parse(harness.registry.toJson()))).toEqual(
      withoutClockReadings(revived),
    );
    expect(snapshot.generatedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(Number.isFinite(snapshot.elapsedMs)).toBe(true);
    expect(snapshot.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('freezes the snapshot it hands out', () => {
    const snapshot = harness.registry.snapshot();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.series)).toBe(true);
  });
});

/* ===== 14. Registry reporting, isolation and download ===== */

describe('the registry reports through the logger it was given', () => {
  let harness: RegistryHarness;

  beforeEach((): void => {
    harness = createHarness();
  });

  afterEach((): void => {
    harness.release();
    vi.restoreAllMocks();
  });

  it('reports an invalid metric name to the sink', () => {
    harness.registry.counter('not a metric name!').inc();

    expect(capturedReasons(harness)).toContain('invalidMetricName');
  });

  it('reports a kind collision between two describes', () => {
    harness.registry.describe('suite_collision', 'A counter.', 'counter');
    harness.registry.describe('suite_collision', 'A gauge.', 'gauge');

    const messages = harness.records.map(
      (record: LogRecord): string => record.message,
    );

    expect(messages).toContain('metric kind collision');
  });

  it('reports nothing for a second describe of the same kind', () => {
    harness.registry.describe('suite_quiet_total', 'First.', 'counter');
    harness.registry.describe('suite_quiet_total', 'Second.', 'counter');

    expect(harness.records).toEqual([]);
    expect(harness.registry.snapshot().rejected).toBe(0);

    const parsed = expectValidExposition(
      harness.registry.toPrometheusText(),
    );

    expect(declaredHelp(parsed, 'suite_quiet_total')).toBe('Second.');
  });

  it('reports an invalid label name and exports no series for it', () => {
    const rejected = harness.registry.counter('suite_labels_total', {
      'not a label': 'x',
    });

    rejected.inc();

    expect(rejected.value).toBe(0);
    expect(capturedReasons(harness)).toContain('invalidLabelName');
    expect(harness.registry.toPrometheusText()).not.toContain(
      'suite_labels_total',
    );
  });

  it('reports the reserved bucket-bound label name', () => {
    harness.registry
      .counter('suite_reserved_total', { [BUCKET_BOUND_LABEL]: '5' })
      .inc();

    expect(capturedReasons(harness)).toContain('reservedLabelName');
  });

  it('reports a family name a histogram already generates', () => {
    harness.registry.describe('suite_gen', 'A histogram.', 'histogram');
    harness.registry.describe('suite_gen_bucket', 'A counter.', 'counter');

    expect(capturedReasons(harness)).toContain('nameGeneratedByHistogram');

    const parsed = expectValidExposition(
      harness.registry.toPrometheusText(),
    );

    expect(declaredKind(parsed, 'suite_gen_bucket')).toBeUndefined();
  });

  it('gives every record the run correlation identifier and its subsystem',
    () => {
      harness.registry.counter('suite_counter_total').inc(-1);

      expect(harness.records.length).toBeGreaterThan(0);

      for (const record of harness.records) {
        expect(record.correlationId).toBe(HARNESS_CORRELATION_ID);
        expect(record.subsystem).toBe('metrics');
        expect(record.level).toBe('warn');
      }
    });

  it('reports without throwing when it was given no logger at all', () => {
    const registry = createMetricsRegistry();

    expect((): void => {
      registry.counter('suite_counter_total').inc(-1);
    }).not.toThrow();

    expect(registry.correlationId).toBe('');
    expect(registry.snapshot().rejected).toBe(1);
    expect(registry.snapshot().reporterFaults).toBe(0);
  });

  it('contains a logger that throws', () => {
    // The registry tags its logger through `child` before it reports through
    // it; the double answers `child` with itself.
    const thrower: Logger = {
      ...harness.logger,
      child: (): Logger => thrower,
      warn: (): void => {
        throw new Error('sink is down');
      },
    };
    const registry = createMetricsRegistry({ logger: thrower });

    expect((): void => {
      registry.counter('suite_counter_total').inc(-1);
    }).not.toThrow();

    expect(registry.snapshot().reporterFaults).toBeGreaterThan(0);
  });
});

describe('two registries share no state', () => {
  afterEach((): void => {
    vi.restoreAllMocks();
  });

  it('keeps one registry\'s counters out of the other', () => {
    const first = createMetricsRegistry();
    const second = createMetricsRegistry();

    first.counter('suite_shared_total').inc(4);

    expect(counterValue(first.snapshot(), 'suite_shared_total')).toBe(4);
    expect(counterValue(second.snapshot(), 'suite_shared_total')).toBeNull();
  });

  it('keeps one registry\'s canonical families at zero', () => {
    const first = createMetricsRegistry();
    const second = createMetricsRegistry();

    first.recordFrame(8);
    first.recordEngineEvent('move:after');

    expect(
      counterValue(first.snapshot(), METRIC_NAMES.framesRenderedTotal),
    ).toBe(1);
    expect(
      counterValue(second.snapshot(), METRIC_NAMES.framesRenderedTotal),
    ).toBe(0);
    expect(counterValue(second.snapshot(), METRIC_NAMES.turnsTotal)).toBe(0);
  });

  it('keeps one registry\'s rejections out of the other', () => {
    const first = createMetricsRegistry();
    const second = createMetricsRegistry();

    first.counter('suite_shared_total').inc(-1);

    expect(first.snapshot().rejected).toBe(1);
    expect(second.snapshot().rejected).toBe(0);
  });

  it('resets one registry without touching the other', () => {
    const first = createMetricsRegistry();
    const second = createMetricsRegistry();

    first.counter('suite_shared_total').inc(3);
    second.counter('suite_shared_total').inc(7);
    first.reset();

    expect(counterValue(first.snapshot(), 'suite_shared_total')).toBe(0);
    expect(counterValue(second.snapshot(), 'suite_shared_total')).toBe(7);
  });
});

/** Whether the active environment supplies everything `download` needs. */
function downloadIsReachable(): boolean {
  const urlApi: unknown = globalThis.URL;
  const create =
    typeof urlApi === 'function'
      ? (urlApi as { createObjectURL?: unknown }).createObjectURL
      : undefined;

  return (
    typeof globalThis.document === 'object' &&
    globalThis.document !== null &&
    typeof globalThis.Blob === 'function' &&
    typeof create === 'function'
  );
}

/** A payload `download` handed to `URL.createObjectURL`. */
interface CapturedBlob {
  readonly type?: string;
  readonly text?: () => Promise<string>;
  readonly arrayBuffer?: () => Promise<ArrayBuffer>;
}

/**
 * Replaces the anchor click `download` triggers, so the anchor it built is
 * observable and no navigation is attempted.
 *
 * @param onClick Receives the anchor that was clicked.
 */
function stubAnchorClick(onClick: (anchor: HTMLAnchorElement) => void): void {
  if (typeof globalThis.HTMLAnchorElement !== 'function') {
    return;
  }

  const anchors = globalThis.HTMLAnchorElement.prototype;

  vi.spyOn(anchors, 'click').mockImplementation(
    function capture(this: HTMLAnchorElement): void {
      onClick(this);
    },
  );
}

/**
 * Reads a captured payload back as text through whichever accessor the
 * active environment's `Blob` supplies.
 *
 * @param blob Payload `download` built.
 * @returns The payload as text.
 */
async function readCapturedBlob(blob: CapturedBlob): Promise<string> {
  if (typeof blob.text === 'function') {
    return blob.text();
  }

  if (typeof blob.arrayBuffer === 'function') {
    return new TextDecoder().decode(await blob.arrayBuffer());
  }

  throw new Error('the active Blob supplies no text accessor');
}

describe('download exports the same bytes the exposition carries', () => {
  let harness: RegistryHarness;

  beforeEach((): void => {
    harness = createHarness();
    populateExposition(harness.registry);
  });

  afterEach((): void => {
    harness.release();
    vi.restoreAllMocks();
  });

  it('reports its guard and returns false where a document is absent', () => {
    if (downloadIsReachable()) {
      const created = vi
        .spyOn(globalThis.URL, 'createObjectURL')
        .mockReturnValue('blob:suite');

      vi.spyOn(globalThis, 'document', 'get').mockReturnValue(
        undefined as unknown as Document,
      );

      expect(harness.registry.download()).toBe(false);
      expect(created).not.toHaveBeenCalled();
      expect(capturedReasons(harness)).toContain('noDocument');

      return;
    }

    expect(harness.registry.download()).toBe(false);
    expect(capturedReasons(harness).length).toBeGreaterThan(0);
  });

  it('exports the Prometheus text byte for byte', async () => {
    if (!downloadIsReachable()) {
      expect(harness.registry.download()).toBe(false);

      return;
    }

    const captured: CapturedBlob[] = [];
    const revoked: string[] = [];

    vi.spyOn(globalThis.URL, 'createObjectURL').mockImplementation(
      (payload: unknown): string => {
        captured.push(payload as CapturedBlob);

        return 'blob:suite-metrics';
      },
    );
    vi.spyOn(globalThis.URL, 'revokeObjectURL').mockImplementation(
      (url: string): void => {
        revoked.push(url);
      },
    );
    stubAnchorClick((): void => undefined);

    const expected = harness.registry.toPrometheusText();

    expect(harness.registry.download()).toBe(true);
    expect(captured).toHaveLength(1);
    expect(revoked).toEqual(['blob:suite-metrics']);

    const first = captured[0];

    expect(first).toBeDefined();

    if (first === undefined) {
      return;
    }

    expect(first.type).toContain('text/plain');
    expect(await readCapturedBlob(first)).toBe(expected);
  });

  it('exports the JSON snapshot for a .json filename', async () => {
    if (!downloadIsReachable()) {
      expect(harness.registry.download('metrics.json')).toBe(false);

      return;
    }

    const captured: CapturedBlob[] = [];

    vi.spyOn(globalThis.URL, 'createObjectURL').mockImplementation(
      (payload: unknown): string => {
        captured.push(payload as CapturedBlob);

        return 'blob:suite-json';
      },
    );
    stubAnchorClick((): void => undefined);

    expect(harness.registry.download('metrics.json')).toBe(true);

    const first = captured[0];

    expect(first).toBeDefined();

    if (first === undefined) {
      return;
    }

    expect(first.type).toContain('application/json');

    const payload: unknown = JSON.parse(await readCapturedBlob(first));

    expect(withoutClockReadings(payload)).toEqual(
      withoutClockReadings(JSON.parse(harness.registry.toJson())),
    );
  });

  it('names the file after the default when it is given none', () => {
    if (!downloadIsReachable()) {
      expect(harness.registry.download()).toBe(false);

      return;
    }

    const names: string[] = [];

    vi.spyOn(globalThis.URL, 'createObjectURL').mockReturnValue('blob:suite');
    stubAnchorClick((anchor: HTMLAnchorElement): void => {
      names.push(anchor.download);
    });

    expect(harness.registry.download()).toBe(true);
    expect(names).toEqual([DEFAULT_METRICS_FILENAME]);
    expect(DEFAULT_METRICS_FILENAME.endsWith('.prom')).toBe(true);
  });

  it('leaves no anchor behind in the document', () => {
    if (!downloadIsReachable()) {
      expect(harness.registry.download()).toBe(false);

      return;
    }

    vi.spyOn(globalThis.URL, 'createObjectURL').mockReturnValue('blob:suite');
    stubAnchorClick((): void => undefined);

    expect(harness.registry.download()).toBe(true);
    expect(globalThis.document.querySelectorAll('a')).toHaveLength(0);
  });
});


/* ===== 15. The validator of section 8 rejects a malformed exposition ===== */

/**
 * Replaces the first line satisfying a test, or removes it.
 *
 * @param text Exposition to alter.
 * @param matches Selects the line to alter.
 * @param replacement Lines to put in its place; an empty list removes it.
 * @returns The altered exposition.
 */
function alterFirstLine(
  text: string,
  matches: (line: string) => boolean,
  replacement: readonly string[],
): string {
  const lines = text.split('\n');
  const index = lines.findIndex(matches);

  expect(index, 'the exposition carried no line to alter').toBeGreaterThan(-1);
  lines.splice(index, 1, ...replacement);

  return lines.join('\n');
}

/**
 * Asserts the validator rejects an exposition, and that it names the problem.
 *
 * @param text Altered exposition.
 * @param fragment Text the reported problem must carry.
 */
function expectRejected(text: string, fragment: string): void {
  const problems = parseExposition(text).problems;

  expect(problems.length).toBeGreaterThan(0);
  expect(problems.join(' | ')).toContain(fragment);
}

describe('the exposition validator has teeth', () => {
  let valid = '';

  beforeEach((): void => {
    const registry = createMetricsRegistry();

    populateExposition(registry);
    valid = registry.toPrometheusText();
  });

  afterEach((): void => {
    vi.restoreAllMocks();
  });

  it('accepts the exposition it is about to be handed corrupted', () => {
    expect(parseExposition(valid).problems).toEqual([]);
  });

  it('rejects a dropped overflow bucket', () => {
    const corrupted = alterFirstLine(
      valid,
      (line: string): boolean =>
        line.startsWith('suite_exposed_histogram_bucket{le="+Inf"}'),
      [],
    );

    expectRejected(corrupted, `no ${INFINITY_BOUND} bucket`);
  });

  it('rejects a duplicated series', () => {
    const duplicated = 'suite_exposed_total 12';
    const corrupted = alterFirstLine(
      valid,
      (line: string): boolean => line === duplicated,
      [duplicated, duplicated],
    );

    expectRejected(corrupted, 'appears 2 times');
  });

  it('rejects an unescaped quote in a label value', () => {
    const corrupted = alterFirstLine(
      valid,
      (line: string): boolean => line.startsWith(`${ESCAPE_FAMILY}{path="a`),
      [`${ESCAPE_FAMILY}{path="a"b"} 3`],
    );

    expectRejected(corrupted, 'label block does not parse');
  });

  it('rejects an undefined escape in a label value', () => {
    const corrupted = alterFirstLine(
      valid,
      (line: string): boolean => line.startsWith(`${ESCAPE_FAMILY}{path="a`),
      [`${ESCAPE_FAMILY}{path="a\\qb"} 3`],
    );

    expectRejected(corrupted, 'undefined escape');
  });

  it('rejects an undefined escape in a help text', () => {
    const corrupted = alterFirstLine(
      valid,
      (line: string): boolean =>
        line.startsWith(`# HELP ${ESCAPE_FAMILY} `),
      [`# HELP ${ESCAPE_FAMILY} first \\q line`],
    );

    expectRejected(corrupted, 'undefined escape');
  });

  it('rejects a missing trailing newline', () => {
    expectRejected(valid.slice(0, -1), 'does not end with a newline');
  });

  it('rejects a blank line', () => {
    const corrupted = alterFirstLine(
      valid,
      (line: string): boolean => line === 'suite_exposed_total 12',
      ['', 'suite_exposed_total 12'],
    );

    expectRejected(corrupted, 'is blank');
  });

  it('rejects a second # HELP line for one family', () => {
    const corrupted = alterFirstLine(
      valid,
      (line: string): boolean =>
        line === '# HELP suite_exposed_total Requests handled.',
      [
        '# HELP suite_exposed_total Requests handled.',
        '# HELP suite_exposed_total Requests handled.',
      ],
    );

    expectRejected(corrupted, 'carries 2 # HELP lines');
  });

  it('rejects a # TYPE line that follows its family\'s samples', () => {
    const declaration = '# TYPE suite_exposed_total counter';
    const moved = alterFirstLine(
      valid,
      (line: string): boolean => line === declaration,
      [],
    );
    const corrupted = alterFirstLine(
      moved,
      (line: string): boolean => line === 'suite_exposed_gauge -4.5',
      ['suite_exposed_gauge -4.5', declaration],
    );

    expectRejected(corrupted, 'declares # TYPE at line');
  });

  it('rejects a sample whose family declares no type', () => {
    const corrupted = alterFirstLine(
      valid,
      (line: string): boolean => line === '# TYPE suite_exposed_total counter',
      [],
    );

    expectRejected(corrupted, 'has no # TYPE line');
  });

  it('rejects a sample name that cannot open a metric name', () => {
    const corrupted = alterFirstLine(
      valid,
      (line: string): boolean => line === 'suite_exposed_total 12',
      ['9suite_exposed_total 12'],
    );

    expectRejected(corrupted, 'does not start with a metric name');
  });

  it('rejects a sample name carrying a character outside the grammar', () => {
    const corrupted = alterFirstLine(
      valid,
      (line: string): boolean => line === 'suite_exposed_total 12',
      ['suite-exposed-total 12'],
    );

    expectRejected(corrupted, 'unparseable value');
  });

  it('rejects an invalid metric name on a # HELP line', () => {
    const corrupted = alterFirstLine(
      valid,
      (line: string): boolean =>
        line === '# HELP suite_exposed_total Requests handled.',
      ['# HELP suite-exposed-total Requests handled.'],
    );

    expectRejected(corrupted, 'is not a valid metric name');
  });

  it('rejects an unparseable value', () => {
    const corrupted = alterFirstLine(
      valid,
      (line: string): boolean => line === 'suite_exposed_total 12',
      ['suite_exposed_total twelve'],
    );

    expectRejected(corrupted, 'unparseable value');
  });

  it('rejects a value written as the JavaScript spelling of infinity', () => {
    const corrupted = alterFirstLine(
      valid,
      (line: string): boolean => line === 'suite_exposed_total 12',
      ['suite_exposed_total Infinity'],
    );

    expectRejected(corrupted, 'unparseable value');
  });

  it('rejects an empty label block', () => {
    const corrupted = alterFirstLine(
      valid,
      (line: string): boolean => line === 'suite_exposed_total 12',
      ['suite_exposed_total{} 12'],
    );

    expectRejected(corrupted, 'an empty label set emitted braces');
  });

  it('rejects a missing space before the value', () => {
    const corrupted = alterFirstLine(
      valid,
      (line: string): boolean => line === 'suite_exposed_total 12',
      ['suite_exposed_total12'],
    );

    expectRejected(corrupted, 'unparseable value');
  });

  it('rejects bucket counts that fall as the bound rises', () => {
    const corrupted = alterFirstLine(
      valid,
      (line: string): boolean =>
        line.startsWith('suite_exposed_histogram_bucket{le="200"}'),
      ['suite_exposed_histogram_bucket{le="200"} 0'],
    );

    expectRejected(corrupted, 'bucket counts fall at bound');
  });

  it('rejects an overflow bucket that disagrees with the count', () => {
    const corrupted = alterFirstLine(
      valid,
      (line: string): boolean =>
        line.startsWith('suite_exposed_histogram_bucket{le="+Inf"}'),
      ['suite_exposed_histogram_bucket{le="+Inf"} 99'],
    );

    expectRejected(corrupted, `and a _count of ${EXPOSED_OBSERVATIONS.length}`);
  });

  it('rejects a histogram with no sum sample', () => {
    const corrupted = alterFirstLine(
      valid,
      (line: string): boolean =>
        line.startsWith('suite_exposed_histogram_sum'),
      [],
    );

    expectRejected(corrupted, 'has no _sum sample');
  });

  it('rejects a bucket sample carrying no bound label', () => {
    const corrupted = alterFirstLine(
      valid,
      (line: string): boolean =>
        line.startsWith('suite_exposed_histogram_bucket{le="1"}'),
      ['suite_exposed_histogram_bucket 0'],
    );

    expectRejected(
      corrupted,
      `a bucket sample carries no "${BUCKET_BOUND_LABEL}" label`,
    );
  });

  it('rejects a bound label on a counter sample', () => {
    const corrupted = alterFirstLine(
      valid,
      (line: string): boolean => line === 'suite_exposed_total 12',
      [`suite_exposed_total{${BUCKET_BOUND_LABEL}="5"} 12`],
    );

    expectRejected(corrupted, 'a counter carries a');
  });

  it('rejects a repeated label name in one series', () => {
    const corrupted = alterFirstLine(
      valid,
      (line: string): boolean =>
        line === `${ESCAPE_FAMILY}{path="plain",scope="run"} 1`,
      [`${ESCAPE_FAMILY}{path="plain",path="run"} 1`],
    );

    expectRejected(corrupted, 'appears twice in one series');
  });

  it('rejects a malformed # TYPE kind', () => {
    const corrupted = alterFirstLine(
      valid,
      (line: string): boolean => line === '# TYPE suite_exposed_total counter',
      ['# TYPE suite_exposed_total tally'],
    );

    expectRejected(corrupted, 'is not a metric type');
  });

  it('rejects trailing content after the value', () => {
    const corrupted = alterFirstLine(
      valid,
      (line: string): boolean => line === 'suite_exposed_total 12',
      ['suite_exposed_total 12 1700000000000 extra'],
    );

    expectRejected(corrupted, 'carries trailing content');
  });
});
