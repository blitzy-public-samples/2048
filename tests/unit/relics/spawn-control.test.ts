// Per-handler suite for the `spawn-control` relics that reshape a spawn rather
// than adding a tile, AAP R3.
//
// `fertile-ground` writes the board and is covered by
// tests/unit/relics/relic-effects.test.ts. The other three transform the
// payload the engine resolves, and none of them had a test: the family's rules
// were asserted nowhere, and nor was the discipline that makes them replayable.
//
// Four properties per handler:
//
//   the rule       what the handler does to the spawn, read from the rules in
//                  force rather than from a literal.
//   determinism    the same seed yields the same spawn, and a handler that
//                  cannot act takes NO draw — so a spawn it declines cannot
//                  shift the sequence for the spawn after it.
//   no mutation    the board and the rules are left exactly as they arrived. A
//                  spawn handler owns its payload and nothing else.
//   binding        the handler fires on the hooks its definition declares,
//                  and on no others.

import { describe, expect, it } from 'vitest';

import { DEFAULT_BOARD_SIZE } from '../../../src/config/default-config';
import {
  afterMovePayload,
  beforeMovePayload,
  dispatchOn,
  expectConsistentLattice,
  mergePayload,
  occupants,
  place,
  relicBench,
  relicById,
  resultOn,
  spawnPayload,
  stageEndPayload,
  stageStartPayload,
  stateOf,
} from '../../fixtures/relics';
import { cursorOf } from '../../fixtures/relics';
import type { RelicBench } from '../../fixtures/relics';

/* ==========================================================================
 * Harness
 * ========================================================================== */

/** The relic-draw cursor, which is the only substream the family reads. */
function draws(target: RelicBench): number {
  return cursorOf(target, 'relic-draw');
}

/**
 * Resolves one spawn through a bench.
 *
 * @param target Bench to dispatch on.
 * @param x Column the engine resolved, or `undefined` for no cell.
 * @param y Row the engine resolved.
 * @param value Value the rules produced.
 * @returns The resolved spawn payload.
 */
function spawn(
  target: RelicBench,
  x: number | undefined,
  y: number,
  value: number,
): { position?: { x: number; y: number }; value: number } {
  return dispatchOn(
    target,
    'onSpawn',
    spawnPayload(x === undefined ? undefined : { x, y }, value),
  );
}

/* ==========================================================================
 * 1. twin-seed
 * ========================================================================== */

describe('twin-seed (spawn-control)', () => {
  it('binds onSpawn and nothing else', () => {
    expect(Object.keys(relicById('twin-seed').hooks)).toEqual(['onSpawn']);
  });

  it('promotes a lowest-value spawn to a configured value above it', () => {
    // Every seed: the promotion is a coin flip, so the property asserted is
    // that the value is ALWAYS one the rules can produce and nothing else.
    const promotions = new Set<number>();

    for (let index = 0; index < 60; index += 1) {
      const target = relicBench(['twin-seed'], { seed: `twin-${index}` });
      const resolved = spawn(target, 0, 0, 2);

      expect(target.config.spawn.values).toContain(resolved.value);
      promotions.add(resolved.value);
    }

    // Both outcomes occur, so neither branch is dead.
    expect([...promotions].sort()).toEqual([2, 4]);
  });

  it('leaves a spawn above the lowest value alone, taking no draw', () => {
    const target = relicBench(['twin-seed']);
    const resolved = spawn(target, 1, 1, 4);

    expect(resolved.value).toBe(4);

    // NO DRAW for a spawn it cannot act on. A draw taken here would shift the
    // sequence every later spawn resolves against.
    expect(draws(target)).toBe(0);
  });

  it('leaves the spawn alone when the rules offer only one value', () => {
    const target = relicBench(['twin-seed']);

    target.config.spawn.values = [2];
    target.config.spawn.weights = [1];

    expect(spawn(target, 0, 0, 2).value).toBe(2);
    expect(draws(target)).toBe(0);
  });

  it('promotes to the next configured value, not to double', () => {
    const target = relicBench(['twin-seed'], { seed: 'twin-ladder' });

    // A distribution whose step is not a doubling: a handler reading a literal
    // rather than the rules would produce 6 here.
    target.config.spawn.values = [3, 7, 11];
    target.config.spawn.weights = [0.8, 0.15, 0.05];

    const seen = new Set<number>();

    for (let index = 0; index < 40; index += 1) {
      const bench = relicBench(['twin-seed'], { seed: `ladder-${index}` });

      bench.config.spawn.values = [3, 7, 11];
      bench.config.spawn.weights = [0.8, 0.15, 0.05];
      seen.add(spawn(bench, 0, 0, 3).value);
    }

    expect([...seen].sort((left, right) => left - right)).toEqual([3, 7]);
    expect(seen.has(6)).toBe(false);
    expect(target.config.spawn.values).toEqual([3, 7, 11]);
  });

  it('is deterministic under a fixed seed', () => {
    const first = relicBench(['twin-seed'], { seed: 'twin-fixed' });
    const second = relicBench(['twin-seed'], { seed: 'twin-fixed' });

    expect(spawn(first, 2, 2, 2).value).toBe(spawn(second, 2, 2, 2).value);
    expect(draws(first)).toBe(draws(second));
  });

  it('leaves the board and the rules untouched', () => {
    const target = relicBench(['twin-seed'], { seed: 'twin-pure' });

    place(target.grid, 1, 1, 8);

    const weights = [...target.config.spawn.weights];

    spawn(target, 0, 0, 2);

    expect(occupants(target.grid)).toEqual([{ x: 1, y: 1, value: 8 }]);
    expect(target.config.spawn.weights).toEqual(weights);
    expect(target.config.boardSize).toBe(DEFAULT_BOARD_SIZE);
    expectConsistentLattice(target.grid);
  });

  it('is invoked by no other hook', () => {
    const target = relicBench(['twin-seed']);

    place(target.grid, 0, 0, 2);

    expect(
      resultOn(target, 'onBeforeMove', beforeMovePayload(target.grid)).invoked,
    ).toBe(0);
    expect(
      resultOn(
        target,
        'onMerge',
        mergePayload({ x: 0, y: 0 }, { x: 0, y: 1 }, 2, 2, 4, 4),
      ).invoked,
    ).toBe(0);
    expect(
      resultOn(target, 'onAfterMove', afterMovePayload(target.grid)).invoked,
    ).toBe(0);
    expect(
      resultOn(target, 'onStageStart', stageStartPayload(4)).invoked,
    ).toBe(0);
    expect(resultOn(target, 'onStageEnd', stageEndPayload(true)).invoked).toBe(
      0,
    );
    expect(draws(target)).toBe(0);
  });
});

/* ==========================================================================
 * 2. prospectors-eye
 * ========================================================================== */

describe('prospectors-eye (spawn-control)', () => {
  it('binds onStageStart and onSpawn', () => {
    expect(Object.keys(relicById('prospectors-eye').hooks).sort()).toEqual([
      'onSpawn',
      'onStageStart',
    ]);
  });

  it('moves a spawn onto the outer ring of the board', () => {
    for (let index = 0; index < 40; index += 1) {
      const target = relicBench(['prospectors-eye'], { seed: `ring-${index}` });

      // The centre of a 4x4: whatever the engine resolved, the relic must place
      // the tile on the ring.
      const resolved = spawn(target, 1, 1, 2);
      const cell = resolved.position;

      expect(cell).toBeDefined();

      const onRing =
        cell !== undefined &&
        (cell.x === 0 || cell.y === 0 || cell.x === 3 || cell.y === 3);

      expect(onRing, `cell ${JSON.stringify(cell)} is on the ring`).toBe(true);
    }
  });

  it('never moves a spawn onto an occupied cell', () => {
    for (let index = 0; index < 40; index += 1) {
      const target = relicBench(['prospectors-eye'], { seed: `busy-${index}` });

      // The whole ring but one cell is taken, so only that cell is a candidate.
      for (let x = 0; x < 4; x += 1) {
        for (let y = 0; y < 4; y += 1) {
          const isRing = x === 0 || y === 0 || x === 3 || y === 3;

          if (isRing && !(x === 3 && y === 3)) {
            place(target.grid, x, y, 2);
          }
        }
      }

      expect(spawn(target, 1, 1, 2).position).toEqual({ x: 3, y: 3 });
    }
  });

  it('leaves a spawn that carried no cell absent, taking no draw', () => {
    const target = relicBench(['prospectors-eye']);
    const resolved = spawn(target, undefined, 0, 2);

    expect(resolved.position).toBeUndefined();
    expect(resolved.value).toBe(2);
    expect(draws(target)).toBe(0);
  });

  it('leaves the spawn alone when the ring offers no empty cell', () => {
    const target = relicBench(['prospectors-eye']);

    for (let x = 0; x < 4; x += 1) {
      for (let y = 0; y < 4; y += 1) {
        if (x === 0 || y === 0 || x === 3 || y === 3) {
          place(target.grid, x, y, 2);
        }
      }
    }

    expect(spawn(target, 1, 1, 2).position).toEqual({ x: 1, y: 1 });
    expect(draws(target)).toBe(0);
  });

  it('reads the board size in force, not the one the stage opened at', () => {
    const target = relicBench(['prospectors-eye'], { seed: 'shrunk-ring' });

    dispatchOn(target, 'onStageStart', stageStartPayload(4));

    // A board-mutating relic reduced the board after the stage began. The ring
    // must be the ring of the CURRENT edge length, so no cell beyond it is ever
    // offered.
    target.config.boardSize = 3;

    for (let index = 0; index < 20; index += 1) {
      const cell = spawn(target, 1, 1, 2).position;

      expect(cell).toBeDefined();

      if (cell !== undefined) {
        expect(cell.x).toBeLessThan(3);
        expect(cell.y).toBeLessThan(3);
      }
    }
  });

  it('records the opening board size as plain JSON', () => {
    const target = relicBench(['prospectors-eye']);

    dispatchOn(target, 'onStageStart', stageStartPayload(4));

    const state = stateOf(target, 'prospectors-eye');

    // Persisted inside the run envelope, so it must round-trip.
    expect(JSON.parse(JSON.stringify(state))).toEqual({ stageBoardSize: 4 });
  });

  it('is deterministic under a fixed seed', () => {
    const first = relicBench(['prospectors-eye'], { seed: 'eye-fixed' });
    const second = relicBench(['prospectors-eye'], { seed: 'eye-fixed' });

    expect(spawn(first, 1, 1, 2).position).toEqual(
      spawn(second, 1, 1, 2).position,
    );
    expect(draws(first)).toBe(draws(second));
  });

  it('leaves the board untouched', () => {
    const target = relicBench(['prospectors-eye'], { seed: 'eye-pure' });

    place(target.grid, 2, 2, 16);
    spawn(target, 1, 1, 2);

    // A spawn relic RESHAPES the payload; the engine is the one that inserts.
    expect(occupants(target.grid)).toEqual([{ x: 2, y: 2, value: 16 }]);
    expectConsistentLattice(target.grid);
  });
});

/* ==========================================================================
 * 3. loaded-dice
 * ========================================================================== */

describe('loaded-dice (spawn-control)', () => {
  it('binds onSpawn and nothing else', () => {
    expect(Object.keys(relicById('loaded-dice').hooks)).toEqual(['onSpawn']);
  });

  it('draws a value the rules can produce, and only those', () => {
    for (let index = 0; index < 60; index += 1) {
      const target = relicBench(['loaded-dice'], { seed: `dice-${index}` });

      const resolved = spawn(target, 0, 0, 2);

      expect(target.config.spawn.values).toContain(resolved.value);
    }
  });

  it('inverts the odds, so the rarest value becomes the commonest', () => {
    let highest = 0;

    for (let index = 0; index < 200; index += 1) {
      const target = relicBench(['loaded-dice'], { seed: `odds-${index}` });

      if (spawn(target, 0, 0, 2).value === 4) {
        highest += 1;
      }
    }

    // The default distribution weights 4 at a tenth. Inverted it is nine
    // tenths, so a clear majority is the assertion, not an exact count.
    expect(highest).toBeGreaterThan(120);
  });

  it('keeps the cell the engine resolved', () => {
    const target = relicBench(['loaded-dice'], { seed: 'dice-cell' });

    expect(spawn(target, 3, 1, 2).position).toEqual({ x: 3, y: 1 });
  });

  it('leaves a mismatched distribution to the rules, taking no draw', () => {
    const target = relicBench(['loaded-dice']);

    target.config.spawn.values = [2, 4, 8];
    target.config.spawn.weights = [1, 1];

    expect(spawn(target, 0, 0, 2).value).toBe(2);
    expect(draws(target)).toBe(0);
  });

  it('leaves an empty distribution to the rules, taking no draw', () => {
    const target = relicBench(['loaded-dice']);

    target.config.spawn.values = [];
    target.config.spawn.weights = [];

    expect(spawn(target, 0, 0, 2).value).toBe(2);
    expect(draws(target)).toBe(0);
  });

  it('is deterministic under a fixed seed', () => {
    const first = relicBench(['loaded-dice'], { seed: 'dice-fixed' });
    const second = relicBench(['loaded-dice'], { seed: 'dice-fixed' });

    expect(spawn(first, 0, 0, 2).value).toBe(spawn(second, 0, 0, 2).value);
    expect(draws(first)).toBe(draws(second));
  });

  it('leaves the configured weights untouched', () => {
    const target = relicBench(['loaded-dice'], { seed: 'dice-pure' });
    const values = [...target.config.spawn.values];
    const weights = [...target.config.spawn.weights];

    spawn(target, 0, 0, 2);

    // The inversion is taken on a copy: a relic that reversed the live array
    // would leave the rules skewed for the rest of the run.
    expect(target.config.spawn.values).toEqual(values);
    expect(target.config.spawn.weights).toEqual(weights);
  });
});

/* ==========================================================================
 * 4. The family as a whole
 * ========================================================================== */

describe('the spawn-control family', () => {
  it('reads only the relic-draw substream', () => {
    const target = relicBench([
      'twin-seed',
      'fertile-ground',
      'prospectors-eye',
      'loaded-dice',
    ]);

    place(target.grid, 1, 1, 2);
    dispatchOn(target, 'onStageStart', stageStartPayload(4));
    spawn(target, 0, 0, 2);

    const spent: Record<string, number> = {
      ...target.streams.snapshotCursors(),
    };

    // Neither spawn substream moved, so a run carrying every relic of this
    // family still reproduces the board a recorded seed produced.
    expect(spent['spawn-value']).toBe(0);
    expect(spent['spawn-position']).toBe(0);
    expect(spent['relic-draw']).toBeGreaterThan(0);
  });

  it('compounds in pickup order, and the order decides what is drawn', () => {
    // A distribution `loaded-dice` inverts into a certainty, so the only thing
    // left varying between the benches is the ORDER the two handlers run in.
    const skew = (target: RelicBench): RelicBench => {
      target.config.spawn.values = [2, 4];
      target.config.spawn.weights = [1, 0];

      return target;
    };
    const forwards = skew(
      relicBench(['twin-seed', 'loaded-dice'], { seed: 'order-check' }),
    );
    const backwards = skew(
      relicBench(['loaded-dice', 'twin-seed'], { seed: 'order-check' }),
    );
    const opening = spawnPayload({ x: 0, y: 0 }, 2);
    const first = resultOn(forwards, 'onSpawn', opening);
    const second = resultOn(
      backwards,
      'onSpawn',
      spawnPayload({ x: 0, y: 0 }, 2),
    );

    // BOTH handlers fire either way, which is the compounding contract.
    expect(first.invoked).toBe(2);
    expect(second.invoked).toBe(2);
    expect(first.payload.value).toBe(4);
    expect(second.payload.value).toBe(4);

    // The RANDOMNESS CONSUMED differs, and that is why pickup order is part of
    // the determinism contract rather than a presentation detail. Reversed,
    // `loaded-dice` raises the value first and `twin-seed` then declines a
    // spawn that is no longer the lowest, so it takes no draw at all.
    expect(draws(forwards)).toBe(2);
    expect(draws(backwards)).toBe(1);
  });
});
