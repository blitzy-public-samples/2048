// Integration suite over the relic subsystem driven through a REAL ENGINE.
//
// The per-relic suites beside this one dispatch hooks directly, which pins each
// relic's effect precisely. This suite closes the remaining gap: that the
// sixteen relics compose with the engine's own turn pipeline — the move
// resolver, the terminal-state evaluation and the commit — rather than only
// with a hand-built dispatch.
//
// The composition asserted here is the one src/main.ts performs, so this suite
// is also the pattern that wiring follows: ONE shared `HookBus`, a
// `RelicRegistry` registered against it, and that same bus handed to the
// `Engine`, with the registry's commit-context provider supplying the relic
// slice of every `state:commit`.
//
// Four prompt-level edge cases are asserted end-to-end here:
//
//   BOARD-SIZE MUTATION. "board-size-altering cursed relics (e.g. shrink board)
//   must not corrupt existing tile positions or win/lose check". Asserted by
//   ending a stage with `collapsing-vault` held and then continuing to PLAY:
//   the engine's traversal and its neighbour probe must both read the smaller
//   board.
//
//   MULTIPLE RELICS ON ONE HOOK. Every relic in the catalogue is held at once
//   and a run of moves is played; the turn completes, no handler is reported
//   degraded, and the board stays consistent.
//
//   CHARGE EXHAUSTION. A relic registered at zero charges is skipped by the
//   bus, and the turn it was skipped on still resolves.
//
//   SEEDED REPRODUCIBILITY. Two engines on one seed holding one relic set play
//   the same move list to the same board and the same score.
//
// This suite reads no DOM and no storage: the engine is built with no storage
// port, so it plays a complete game and persists nothing.

import { describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import type { RulesConfig } from '../../../src/config/rules-config';
import { Engine } from '../../../src/engine/engine';
import { createHookBus, type HookBus } from '../../../src/engine/hook-bus';
import {
  DIRECTION_DOWN,
  DIRECTION_LEFT,
  DIRECTION_RIGHT,
  DIRECTION_UP,
  type Direction,
  type SerializedGameState,
} from '../../../src/engine/types';
import {
  RELIC_CATALOGUE,
  RelicRegistry,
} from '../../../src/relics/relic-registry';
import type { Relic } from '../../../src/relics/relic-types';
import { createRngStreams } from '../../../src/rng/rng-streams';

/* ===== Fixtures ===== */

const SEED = 'blitzy-relic-integration';

/** A move list long enough to resolve merges, spawns and a stage's worth. */
const MOVE_LIST: readonly Direction[] = [
  DIRECTION_LEFT,
  DIRECTION_UP,
  DIRECTION_RIGHT,
  DIRECTION_DOWN,
  DIRECTION_LEFT,
  DIRECTION_UP,
  DIRECTION_RIGHT,
  DIRECTION_DOWN,
  DIRECTION_LEFT,
  DIRECTION_UP,
  DIRECTION_RIGHT,
  DIRECTION_DOWN,
];

interface Composed {
  readonly engine: Engine;
  readonly bus: HookBus;
  readonly registry: RelicRegistry;
  readonly config: RulesConfig;
}

/**
 * Composes engine, bus and registry exactly as the composition root does.
 *
 * @param relics Relics the run holds, in pickup order.
 * @param seed Run seed.
 * @returns The composed run.
 */
function compose(
  relics: readonly Relic[] = [],
  seed = SEED,
): Composed {
  const config = createDefaultRulesConfig();
  const streams = createRngStreams(seed);
  const bus = createHookBus();
  const registry = new RelicRegistry({ bus });

  for (const relic of relics) {
    registry.pickUp(relic);
  }

  const engine = new Engine({
    config,
    streams,
    hooks: bus,
    relicContext: registry.commitContextProvider(),
  });

  return { engine, bus, registry, config };
}

/** Plays a move list, reporting how many moves changed the board. */
function play(engine: Engine, moves: readonly Direction[] = MOVE_LIST): number {
  let moved = 0;

  for (const direction of moves) {
    if (engine.move(direction)) {
      moved += 1;
    }
  }

  return moved;
}

/** Reports whether every tile's coordinates agree with the cell holding it. */
function isLatticeConsistent(engine: Engine): boolean {
  let consistent = true;

  engine.grid.eachCell((x, y, tile) => {
    if (tile !== null && (tile.x !== x || tile.y !== y)) {
      consistent = false;
    }
  });

  return consistent;
}

/** Every tile face value on the board. */
function faceValues(engine: Engine): number[] {
  const values: number[] = [];

  engine.grid.eachCell((_x, _y, tile) => {
    if (tile !== null) {
      values.push(tile.value);
    }
  });

  return values;
}

/* ===== The composition itself ===== */

describe('relic subsystem composed with the engine', () => {
  it('reports the held relics in every commit, in pickup order', () => {
    const taken = RELIC_CATALOGUE.slice(0, 3);
    const { engine } = compose(taken);
    const commits: readonly string[][] = [];
    const seen: string[][] = commits.slice();

    engine.events.on('state:commit', (payload) => {
      seen.push(payload.relics.map((entry) => entry.id));
    });

    engine.setup();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toEqual(taken.map((relic) => relic.id));
  });

  it('reports no relic when the run holds none', () => {
    const { engine } = compose();
    let reported = -1;

    engine.events.on('state:commit', (payload) => {
      reported = payload.relics.length;
    });

    engine.setup();

    expect(reported).toBe(0);
  });

  it('brings a relic picked up mid-run into the next commit', () => {
    const { engine, registry } = compose();

    engine.setup();
    registry.pickUp(RELIC_CATALOGUE[0] as Relic);

    let reported: readonly string[] = [];

    engine.events.on('state:commit', (payload) => {
      reported = payload.relics.map((entry) => entry.id);
    });

    engine.move(DIRECTION_LEFT);

    expect(reported).toEqual([(RELIC_CATALOGUE[0] as Relic).id]);
  });
});

/* ===== Every relic at once ===== */

describe('all sixteen relics held at once', () => {
  it('plays a full move list without a handler throwing', () => {
    const { engine, bus } = compose(RELIC_CATALOGUE);

    engine.setup();
    play(engine);

    expect(bus.degraded()).toEqual([]);
    expect(bus.metrics().totals.failed).toBe(0);
  });

  it('leaves the lattice consistent after every turn', () => {
    const { engine } = compose(RELIC_CATALOGUE);

    engine.setup();

    for (const direction of MOVE_LIST) {
      engine.move(direction);

      expect(isLatticeConsistent(engine)).toBe(true);
    }
  });

  it('keeps every tile inside the board the rules declare', () => {
    const { engine, config } = compose(RELIC_CATALOGUE);

    engine.setup();
    play(engine);

    engine.grid.eachCell((x, y, tile) => {
      if (tile !== null) {
        expect(x).toBeLessThan(config.boardSize);
        expect(y).toBeLessThan(config.boardSize);
      }
    });
  });

  it('keeps the score a finite number at or above zero', () => {
    const { engine } = compose(RELIC_CATALOGUE);

    engine.setup();
    play(engine);

    expect(Number.isFinite(engine.score)).toBe(true);
    expect(engine.score).toBeGreaterThanOrEqual(0);
  });

  it('serialises to a snapshot the engine restores', () => {
    const { engine } = compose(RELIC_CATALOGUE);

    engine.setup();
    play(engine);

    const snapshot: SerializedGameState = engine.serialize();
    const resumed = compose(RELIC_CATALOGUE).engine;

    resumed.setup(snapshot);

    expect(resumed.serialize().grid).toEqual(snapshot.grid);
    expect(resumed.score).toBe(snapshot.score);
  });

  it('takes only the draws the run consumes, so the seed still governs', () => {
    const first = compose(RELIC_CATALOGUE);
    const second = compose(RELIC_CATALOGUE);

    first.engine.setup();
    play(first.engine);
    second.engine.setup();
    play(second.engine);

    expect(second.engine.serialize()).toEqual(first.engine.serialize());
    expect(second.engine.streams.snapshotCursors()).toEqual(
      first.engine.streams.snapshotCursors(),
    );
  });
});

/* ===== Seeded reproducibility with relics held ===== */

describe('seeded reproducibility with relics held', () => {
  it('plays one seed and one move list to one board', () => {
    const relics = RELIC_CATALOGUE.slice(0, 8);
    const runOne = compose(relics, 'reproducible-run');
    const runTwo = compose(relics, 'reproducible-run');

    runOne.engine.setup();
    runTwo.engine.setup();
    play(runOne.engine);
    play(runTwo.engine);

    expect(runTwo.engine.serialize()).toEqual(runOne.engine.serialize());
  });

  it('plays a different seed to a different board', () => {
    const relics = RELIC_CATALOGUE.slice(0, 8);
    const runOne = compose(relics, 'reproducible-run');
    const runTwo = compose(relics, 'reproducible-run-beta');

    runOne.engine.setup();
    runTwo.engine.setup();
    play(runOne.engine);
    play(runTwo.engine);

    expect(runTwo.engine.serialize()).not.toEqual(runOne.engine.serialize());
  });

  it('never patches Math.random, however many relics draw', () => {
    const before = Math.random;
    const { engine } = compose(RELIC_CATALOGUE);

    engine.setup();
    play(engine);

    expect(Math.random).toBe(before);
  });
});

/* ===== Board-size mutation (finding CR-4, end to end) ===== */

describe('board shrink under a cursed relic, end to end', () => {
  const cursed = RELIC_CATALOGUE.find(
    (relic) => relic.id === 'collapsing-vault',
  ) as Relic;

  it('shrinks the engine board when a stage is cleared', () => {
    const { engine, config } = compose([cursed]);

    engine.setup();
    engine.endStage(true);

    expect(engine.grid.size).toBe(3);
    expect(config.boardSize).toBe(3);
  });

  it('keeps every surviving tile in the exact cell it occupied', () => {
    const { engine } = compose([cursed]);

    engine.setup(<SerializedGameState>{
      grid: {
        size: 4,
        cells: [
          [
            { position: { x: 0, y: 0 }, value: 2 },
            null,
            null,
            { position: { x: 0, y: 3 }, value: 8 },
          ],
          [null, { position: { x: 1, y: 1 }, value: 4 }, null, null],
          [null, null, { position: { x: 2, y: 2 }, value: 16 }, null],
          [{ position: { x: 3, y: 0 }, value: 32 }, null, null, null],
        ],
      },
      score: 100,
      over: false,
      won: false,
      keepPlaying: false,
    });

    engine.endStage(true);

    expect(engine.grid.cellContent({ x: 0, y: 0 })?.value).toBe(2);
    expect(engine.grid.cellContent({ x: 1, y: 1 })?.value).toBe(4);
    expect(engine.grid.cellContent({ x: 2, y: 2 })?.value).toBe(16);
    expect(isLatticeConsistent(engine)).toBe(true);
  });

  it('keeps playing on the smaller board, with the traversal reading it', () => {
    const { engine } = compose([cursed]);

    // An explicit board, so what survives the collapse does not depend on
    // where the seed happened to place the starting tiles.
    engine.setup(<SerializedGameState>{
      grid: {
        size: 4,
        cells: [
          [{ position: { x: 0, y: 0 }, value: 2 }, null, null, null],
          [null, { position: { x: 1, y: 1 }, value: 2 }, null, null],
          [null, null, null, null],
          [{ position: { x: 3, y: 0 }, value: 64 }, null, null, null],
        ],
      },
      score: 0,
      over: false,
      won: false,
      keepPlaying: false,
    });
    engine.endStage(true);

    const moved = play(engine);

    expect(moved).toBeGreaterThan(0);
    expect(isLatticeConsistent(engine)).toBe(true);

    engine.grid.eachCell((x, y, tile) => {
      if (tile !== null) {
        expect(x).toBeLessThan(3);
        expect(y).toBeLessThan(3);
      }
    });
  });

  it('evaluates the loss check against the board that exists', () => {
    const { engine } = compose([cursed]);

    // A 4x4 board whose top-left 3x3 is a jam under the default merge rule,
    // and whose outer row and column are empty.
    engine.setup(<SerializedGameState>{
      grid: {
        size: 4,
        cells: [
          [
            { position: { x: 0, y: 0 }, value: 2 },
            { position: { x: 0, y: 1 }, value: 4 },
            { position: { x: 0, y: 2 }, value: 2 },
            null,
          ],
          [
            { position: { x: 1, y: 0 }, value: 4 },
            { position: { x: 1, y: 1 }, value: 2 },
            { position: { x: 1, y: 2 }, value: 4 },
            null,
          ],
          [
            { position: { x: 2, y: 0 }, value: 2 },
            { position: { x: 2, y: 1 }, value: 4 },
            { position: { x: 2, y: 2 }, value: 2 },
            null,
          ],
          [null, null, null, null],
        ],
      },
      score: 0,
      over: false,
      won: false,
      keepPlaying: false,
    });

    // Open on the 4x4 board: the empty outer row and column both allow a move.
    expect(engine.move(DIRECTION_RIGHT)).toBe(true);

    engine.setup(<SerializedGameState>{
      grid: {
        size: 4,
        cells: [
          [
            { position: { x: 0, y: 0 }, value: 2 },
            { position: { x: 0, y: 1 }, value: 4 },
            { position: { x: 0, y: 2 }, value: 2 },
            null,
          ],
          [
            { position: { x: 1, y: 0 }, value: 4 },
            { position: { x: 1, y: 1 }, value: 2 },
            { position: { x: 1, y: 2 }, value: 4 },
            null,
          ],
          [
            { position: { x: 2, y: 0 }, value: 2 },
            { position: { x: 2, y: 1 }, value: 4 },
            { position: { x: 2, y: 2 }, value: 2 },
            null,
          ],
          [null, null, null, null],
        ],
      },
      score: 0,
      over: false,
      won: false,
      keepPlaying: false,
    });
    engine.endStage(true);

    // The collapse leaves exactly that 3x3 jam, and the engine now reads it as
    // a jam: no move changes the board.
    expect(engine.grid.size).toBe(3);
    expect(engine.move(DIRECTION_RIGHT)).toBe(false);
    expect(engine.move(DIRECTION_LEFT)).toBe(false);
    expect(engine.move(DIRECTION_UP)).toBe(false);
    expect(engine.move(DIRECTION_DOWN)).toBe(false);
  });

  it('spawns only inside the smaller board after the collapse', () => {
    const { engine } = compose([cursed]);

    engine.setup();
    engine.endStage(true);
    engine.restart();

    const values = faceValues(engine);

    expect(values.length).toBeGreaterThan(0);

    engine.grid.eachCell((x, y, tile) => {
      if (tile !== null) {
        expect(x).toBeLessThan(3);
        expect(y).toBeLessThan(3);
      }
    });
  });
});

/* ===== Charge exhaustion, end to end ===== */

describe('charge exhaustion, end to end', () => {
  it('skips a relic whose budget is spent and still resolves the turn', () => {
    const charged = RELIC_CATALOGUE.find(
      (relic) => relic.charges !== undefined,
    ) as Relic;
    const { engine, bus } = compose();

    bus.register({
      id: charged.id,
      hooks: charged.hooks,
      charges: 0,
      state: charged.state,
    });

    engine.setup();

    const moved = play(engine);

    expect(moved).toBeGreaterThan(0);
    expect(bus.metrics().totals.failed).toBe(0);
    expect(bus.metrics().totals.skippedExhausted).toBeGreaterThan(0);
  });

  it('spends a budget as effects trigger and skips the relic once it is gone', () => {
    const charged = RELIC_CATALOGUE.filter(
      (relic) => relic.charges !== undefined,
    );
    const { engine, bus } = compose(charged);

    engine.setup();
    play(engine);

    const metrics = bus.metrics();

    // Something was spent — the decrement is wired at all — and nothing threw.
    expect(metrics.chargesConsumed).toBeGreaterThan(0);
    expect(metrics.totals.failed).toBe(0);

    // Every budget the run spent from stayed inside the declaration's own
    // budget and never fell below zero.
    for (const row of metrics.subscribers) {
      const declared = charged.find((relic) => relic.id === row.id)?.charges;

      if (declared !== undefined) {
        expect(row.chargesConsumed).toBeLessThanOrEqual(declared);
        expect(row.charges).toBe(declared - row.chargesConsumed);
        expect(row.charges).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('leaves a relic that never triggers at its full budget', () => {
    // `tumbler` acts only inside the scarcity band, and an opening board is
    // wide open, so it is dispatched and spends nothing.
    const tumbler = RELIC_CATALOGUE.find(
      (relic) => relic.id === 'tumbler',
    ) as Relic;
    const { engine, bus } = compose([tumbler]);

    engine.setup();
    play(engine);

    const row = bus.metrics().subscribers.find((entry) => entry.id === 'tumbler');

    expect(row?.invoked).toBeGreaterThan(0);
    expect(row?.chargesConsumed).toBe(0);
    expect(row?.charges).toBe(tumbler.charges);
  });
});
