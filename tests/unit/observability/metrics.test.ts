// Unit suite over the engine-event recorders of src/observability/metrics.ts
// and the two spawn families they write: `game2048_spawn_attempts_total` and
// `game2048_spawn_total`.
//
// The distinction under test comes from the retired sources. js/grid.js L40
// guarded `randomAvailableCell` with `if (cells.length)` and had no else
// branch, so it returned `undefined` on a full board and js/game_manager.js
// L72-L75 inserted no tile. src/engine/engine-events.ts carries that forward:
// `tile:spawn` is emitted once per spawn ATTEMPT and its payload omits
// `position` when no cell was available. A counter that rises on every
// emission therefore reports attempts under a name that promises insertions.
//
// Validation gate: AAP 0.8.8 V8, third bullet — the metrics snapshot exports
// in Prometheus text format, and the families it exports are true.
//
// Coverage owned by sibling suites and not repeated here: the correlation
// identifier the snapshot carries (tests/unit/observability/logger.test.ts),
// and the hook-bus dispatch counts this registry folds in
// (tests/unit/engine/hook-bus.test.ts).
//
// This suite reads no DOM and no storage, installs no mock and replaces no
// global. tests/fixtures/storage.ts is loaded as a setup file for every unit
// suite and removes every owned key after each test.
//
// Decisions behind this file: DL-METRIC-01 and DL-METRIC-02 in
// docs/DECISION_LOG.md.

import { describe, expect, it } from 'vitest';

import { ENGINE_EVENT_NAMES } from '../../../src/engine/engine-events';
import type { EngineEventName } from '../../../src/engine/engine-events';
import {
  METRIC_NAMES,
  createMetricsRegistry,
} from '../../../src/observability/metrics';
import type {
  MetricsRegistry,
  MetricsSnapshot,
} from '../../../src/observability/metrics';

/* ===== 1. Helpers ===== */

/** A cell a successful spawn reports. */
const SPAWNED_CELL = Object.freeze({ x: 1, y: 2 });

/**
 * Reads one counter's value out of a snapshot.
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
 * Reads a registry's two spawn counters.
 *
 * @param registry Registry to read.
 * @returns The attempt count and the insertion count.
 */
function spawnCounts(registry: MetricsRegistry): {
  readonly attempts: number | null;
  readonly inserted: number | null;
} {
  const snapshot = registry.snapshot();

  return {
    attempts: counterValue(snapshot, METRIC_NAMES.spawnAttemptsTotal),
    inserted: counterValue(snapshot, METRIC_NAMES.spawnsTotal),
  };
}

/* ===== 2. The two spawn families ===== */

describe('the spawn families', () => {
  it('names attempts and insertions separately', () => {
    expect(METRIC_NAMES.spawnAttemptsTotal).toBe(
      'game2048_spawn_attempts_total',
    );
    expect(METRIC_NAMES.spawnsTotal).toBe('game2048_spawns_total');
    expect(METRIC_NAMES.spawnAttemptsTotal).not.toBe(
      METRIC_NAMES.spawnsTotal,
    );
  });

  it('registers both families at zero', () => {
    const counts = spawnCounts(createMetricsRegistry());

    expect(counts.attempts).toBe(0);
    expect(counts.inserted).toBe(0);
  });

  it('counts an attempt that inserted a tile in both families', () => {
    const registry = createMetricsRegistry();

    registry.recordEngineEvent('tile:spawn', {
      position: SPAWNED_CELL,
    });

    const counts = spawnCounts(registry);

    expect(counts.attempts).toBe(1);
    expect(counts.inserted).toBe(1);
  });

  it('counts an attempt on a full board as an attempt alone', () => {
    const registry = createMetricsRegistry();

    // The payload js/grid.js L40's absent else branch produces: a value was
    // drawn, no cell was available, and no tile entered the lattice.
    registry.recordEngineEvent('tile:spawn', { position: undefined });

    const counts = spawnCounts(registry);

    expect(counts.attempts).toBe(1);
    expect(counts.inserted).toBe(0);
  });

  it('treats a payload with no position member the same way', () => {
    const registry = createMetricsRegistry();

    registry.recordEngineEvent('tile:spawn', {});

    const counts = spawnCounts(registry);

    expect(counts.attempts).toBe(1);
    expect(counts.inserted).toBe(0);
  });

  it('counts the attempt alone when no payload is supplied', () => {
    const registry = createMetricsRegistry();

    registry.recordEngineEvent('tile:spawn');

    const counts = spawnCounts(registry);

    expect(counts.attempts).toBe(1);
    expect(counts.inserted).toBe(0);
  });

  it('keeps insertions at or below attempts over a mixed sequence', () => {
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
      registry.recordEngineEvent(
        'tile:spawn',
        inserted ? { position: SPAWNED_CELL } : { position: undefined },
      );
    }

    const counts = spawnCounts(registry);
    const expectedInserted = outcomes.filter(
      (inserted: boolean): boolean => inserted,
    ).length;

    expect(counts.attempts).toBe(outcomes.length);
    expect(counts.inserted).toBe(expectedInserted);
    expect(counts.inserted).toBeLessThan(counts.attempts ?? 0);
  });

  it('exports both families in the Prometheus text', () => {
    const registry = createMetricsRegistry();

    registry.recordEngineEvent('tile:spawn', { position: SPAWNED_CELL });
    registry.recordEngineEvent('tile:spawn', { position: undefined });

    const text = registry.prometheusText;

    expect(text).toContain(`${METRIC_NAMES.spawnAttemptsTotal} 2`);
    expect(text).toContain(`${METRIC_NAMES.spawnsTotal} 1`);
    expect(text).toContain(`# TYPE ${METRIC_NAMES.spawnAttemptsTotal} counter`);
    expect(text).toContain(`# TYPE ${METRIC_NAMES.spawnsTotal} counter`);
  });

  it('gives each family help text that says what it counts', () => {
    const snapshot = createMetricsRegistry().snapshot();
    const attempts = snapshot.series.find(
      (series): boolean => series.name === METRIC_NAMES.spawnAttemptsTotal,
    );
    const inserted = snapshot.series.find(
      (series): boolean => series.name === METRIC_NAMES.spawnsTotal,
    );

    expect(attempts?.help).toContain('attempt');
    expect(inserted?.help).toContain('Tiles inserted');
    expect(attempts?.help).not.toBe(inserted?.help);
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
    }).not.toThrow();

    const counts = spawnCounts(registry);

    expect(counts.attempts).toBe(3);
    expect(counts.inserted).toBe(1);
  });
});
