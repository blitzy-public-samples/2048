// Safety suite for the `risk-reward-cursed` family, AAP R3 and Contract 5.
//
// `collapsing-vault` and `brittle-crown` are covered handler-by-handler by
// tests/unit/relics/relic-effects.test.ts. Three things had no test, and the
// third is the edge case the prompt states outright:
//
//   gilded-rot        doubles every merge's pay and raises every spawn to the
//                     ceiling the rules declare, both read at use time.
//   hollow-ascension  banks a charge per merge and sweetens the merges that
//                     follow, and a stage that is NOT cleared empties the bank.
//                     Its state is a bare number, which is the one relic state
//                     that is not an object.
//   shrink safety     a board-size-altering cursed relic must not corrupt tile
//                     positions OR the win/lose check. The check is asserted
//                     against the REAL src/engine/terminal-state.ts over the
//                     reconciled board, because a size read from the wrong
//                     place is how a shrunk board reports a loss it is not in.

import { describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import { Grid } from '../../../src/engine/grid';
import {
  hasReachedWinValue,
  highestTileValue,
  movesAvailable,
} from '../../../src/engine/terminal-state';
import {
  afterMovePayload,
  cursorOf,
  dispatchOn,
  expectConsistentLattice,
  fill,
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
  values,
} from '../../fixtures/relics';
import type { RelicBench } from '../../fixtures/relics';

/* ==========================================================================
 * Harness
 * ========================================================================== */

/** Resolves one merge through a bench and hands back what it paid. */
function pay(
  target: RelicBench,
  resultValue: number,
  scoreDelta: number,
): { resultValue: number; scoreDelta: number } {
  const resolved = dispatchOn(
    target,
    'onMerge',
    mergePayload({ x: 1, y: 0 }, { x: 0, y: 0 }, 2, 2, resultValue, scoreDelta),
  );

  return {
    resultValue: resolved.resultValue,
    scoreDelta: resolved.scoreDelta,
  };
}

/* ==========================================================================
 * 1. gilded-rot
 * ========================================================================== */

describe('gilded-rot (risk-reward-cursed)', () => {
  it('binds onMerge and onSpawn', () => {
    expect(Object.keys(relicById('gilded-rot').hooks).sort()).toEqual([
      'onMerge',
      'onSpawn',
    ]);
  });

  it('carries no charge budget', () => {
    expect(relicById('gilded-rot').charges).toBeUndefined();
  });

  it('doubles what a merge pays, leaving the value alone', () => {
    const target = relicBench(['gilded-rot']);
    const paid = pay(target, 64, 64);

    expect(paid.scoreDelta).toBe(128);
    expect(paid.resultValue).toBe(64);
  });

  it('doubles what an earlier handler accumulated, not the base pay', () => {
    const target = relicBench(['gilded-rot']);

    expect(pay(target, 64, 100).scoreDelta).toBe(200);
  });

  it('floors the doubled pay to a whole point', () => {
    const target = relicBench(['gilded-rot']);

    expect(pay(target, 8, 2.5).scoreDelta).toBe(5);
  });

  it('raises a spawn to the highest value the rules can produce', () => {
    const target = relicBench(['gilded-rot']);
    const resolved = dispatchOn(
      target,
      'onSpawn',
      spawnPayload({ x: 2, y: 1 }, 2),
    );

    expect(resolved.value).toBe(4);
    expect(resolved.position).toEqual({ x: 2, y: 1 });
  });

  it('reads the ceiling from the rules in force, not from a literal', () => {
    const target = relicBench(['gilded-rot']);

    target.config.spawn.values = [3, 9, 27];
    target.config.spawn.weights = [0.7, 0.2, 0.1];

    expect(
      dispatchOn(target, 'onSpawn', spawnPayload({ x: 0, y: 0 }, 3)).value,
    ).toBe(27);
  });

  it('leaves a spawn that already carries the ceiling alone', () => {
    const target = relicBench(['gilded-rot']);

    expect(
      dispatchOn(target, 'onSpawn', spawnPayload({ x: 0, y: 0 }, 4)).value,
    ).toBe(4);
  });

  it('leaves a spawn that carried no cell absent', () => {
    const target = relicBench(['gilded-rot']);
    const resolved = dispatchOn(target, 'onSpawn', spawnPayload(undefined, 2));

    expect(resolved.position).toBeUndefined();
    expect(resolved.value).toBe(2);
  });

  it('consumes no randomness on either hook', () => {
    const target = relicBench(['gilded-rot']);

    pay(target, 64, 64);
    dispatchOn(target, 'onSpawn', spawnPayload({ x: 0, y: 0 }, 2));

    expect(cursorOf(target, 'relic-draw')).toBe(0);
    expect(cursorOf(target, 'spawn-value')).toBe(0);
  });

  it('leaves the board and the rules untouched', () => {
    const target = relicBench(['gilded-rot']);

    place(target.grid, 1, 1, 8);

    const weights = [...target.config.spawn.weights];

    pay(target, 64, 64);
    dispatchOn(target, 'onSpawn', spawnPayload({ x: 0, y: 0 }, 2));

    expect(occupants(target.grid)).toEqual([{ x: 1, y: 1, value: 8 }]);
    expect(target.config.spawn.weights).toEqual(weights);
  });
});

/* ==========================================================================
 * 2. hollow-ascension
 * ========================================================================== */

describe('hollow-ascension (risk-reward-cursed)', () => {
  it('binds onMerge and onStageEnd', () => {
    expect(Object.keys(relicById('hollow-ascension').hooks).sort()).toEqual([
      'onMerge',
      'onStageEnd',
    ]);
  });

  it('opens with an empty bank, held as a bare number', () => {
    expect(relicById('hollow-ascension').state).toBe(0);
  });

  it('pays nothing on the first merge, and banks it', () => {
    const target = relicBench(['hollow-ascension']);

    // The bonus is taken from the bank as it stood BEFORE the merge, so the
    // first merge of a run pays exactly what the rules paid.
    expect(pay(target, 4, 4).scoreDelta).toBe(4);
    expect(stateOf(target, 'hollow-ascension')).toBe(1);
  });

  it('sweetens each merge by what the ones before it banked', () => {
    const target = relicBench(['hollow-ascension']);

    expect(pay(target, 4, 4).scoreDelta).toBe(4);
    expect(pay(target, 4, 4).scoreDelta).toBe(8);
    expect(pay(target, 4, 4).scoreDelta).toBe(12);
    expect(stateOf(target, 'hollow-ascension')).toBe(3);
  });

  it('keeps the produced value out of it', () => {
    const target = relicBench(['hollow-ascension']);

    pay(target, 4, 4);

    expect(pay(target, 4, 4).resultValue).toBe(4);
  });

  it('empties the bank when a stage is not cleared', () => {
    const target = relicBench(['hollow-ascension']);

    pay(target, 4, 4);
    pay(target, 4, 4);

    expect(stateOf(target, 'hollow-ascension')).toBe(2);

    dispatchOn(target, 'onStageEnd', stageEndPayload(false));

    expect(stateOf(target, 'hollow-ascension')).toBe(0);

    // And the next merge pays the base rate again.
    expect(pay(target, 4, 4).scoreDelta).toBe(4);
  });

  it('carries the bank forward across a stage that was cleared', () => {
    const target = relicBench(['hollow-ascension']);

    pay(target, 4, 4);
    pay(target, 4, 4);
    dispatchOn(target, 'onStageEnd', stageEndPayload(true));

    expect(stateOf(target, 'hollow-ascension')).toBe(2);
    expect(pay(target, 4, 4).scoreDelta).toBe(12);
  });

  it('keeps its bank JSON-serialisable across a round trip', () => {
    const target = relicBench(['hollow-ascension']);

    pay(target, 4, 4);
    pay(target, 4, 4);

    const held = stateOf(target, 'hollow-ascension');

    // The run envelope persists this, so a bare number must survive it.
    expect(JSON.parse(JSON.stringify(held))).toBe(2);
  });

  it('consumes no randomness', () => {
    const target = relicBench(['hollow-ascension']);

    pay(target, 4, 4);
    dispatchOn(target, 'onStageEnd', stageEndPayload(false));

    expect(cursorOf(target, 'relic-draw')).toBe(0);
  });
});

/* ==========================================================================
 * 3. Shrink safety: positions and the win/lose check
 * ========================================================================== */

describe('a board the vault shrank', () => {
  /** Shrinks a bench's board by clearing a stage. */
  function collapse(target: RelicBench): void {
    dispatchOn(target, 'onStageEnd', stageEndPayload(true));
  }

  it('leaves every surviving tile at coordinates that match its slot', () => {
    const target = relicBench(['collapsing-vault'], { seed: 'shrink-coords' });

    place(target.grid, 0, 0, 2);
    place(target.grid, 3, 3, 4);
    place(target.grid, 1, 2, 8);
    place(target.grid, 3, 0, 16);
    collapse(target);

    expect(target.grid.size).toBe(3);
    expect(target.config.boardSize).toBe(3);

    // The corruption mode the discipline exists to prevent: a tile whose own
    // x/y no longer matches the cell holding it.
    expectConsistentLattice(target.grid);

    for (const cell of occupants(target.grid)) {
      expect(cell.x).toBeLessThan(3);
      expect(cell.y).toBeLessThan(3);
    }
  });

  it('keeps the loss check honest on the tighter board', () => {
    const target = relicBench(['collapsing-vault'], { seed: 'shrink-loss' });

    // Four tiles that cannot merge, on a 4x4 board with room to move.
    place(target.grid, 0, 0, 2);
    place(target.grid, 1, 0, 4);
    place(target.grid, 0, 1, 8);
    place(target.grid, 1, 1, 16);

    expect(movesAvailable(target.grid, target.config)).toBe(true);

    collapse(target);

    // Four tiles on a 3x3 board still leave five empty cells, so a move is
    // available — and the check must read the RECONCILED size to say so. One
    // reading the old edge length probes cells the lattice no longer holds.
    expect(target.grid.size).toBe(3);
    expect(movesAvailable(target.grid, target.config)).toBe(true);
  });

  it('reports a loss on a shrunk board that genuinely has no move', () => {
    const target = relicBench(['collapsing-vault'], { seed: 'shrink-dead' });

    // A 4x4 checkerboard of values that cannot merge in any direction, which
    // survives the collapse as a 3x3 board with the same property.
    const ladder = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096];
    let index = 0;

    for (let x = 0; x < 4; x += 1) {
      for (let y = 0; y < 4; y += 1) {
        place(target.grid, x, y, ladder[index % ladder.length]);
        index += 1;
      }
    }

    collapse(target);

    expect(target.grid.size).toBe(3);
    expectConsistentLattice(target.grid);

    // Nine cells, nine tiles, and no two neighbours equal.
    expect(occupants(target.grid)).toHaveLength(9);
    expect(movesAvailable(target.grid, target.config)).toBe(false);
  });

  it('keeps the win check honest, and the win value untouched', () => {
    const target = relicBench(['collapsing-vault'], { seed: 'shrink-win' });

    place(target.grid, 0, 0, 2048);
    place(target.grid, 3, 3, 2);

    expect(hasReachedWinValue(target.grid, target.config)).toBe(true);

    collapse(target);

    // The tile survived the collapse, and the target it is measured against was
    // never rewritten — so a run that had won has not un-won by losing an edge.
    expect(target.config.winValue).toBe(2048);
    expect(highestTileValue(target.grid)).toBe(2048);
    expect(hasReachedWinValue(target.grid, target.config)).toBe(true);
  });

  it('never drops a tile it could have re-homed', () => {
    const target = relicBench(['collapsing-vault'], { seed: 'shrink-rehome' });

    // Five tiles, two of them beyond the 3x3 lattice: nine cells is more than
    // enough to hold all five.
    place(target.grid, 0, 0, 2);
    place(target.grid, 1, 1, 4);
    place(target.grid, 3, 0, 8);
    place(target.grid, 0, 3, 16);
    place(target.grid, 2, 2, 32);
    collapse(target);

    expect(values(target.grid)).toEqual([2, 4, 8, 16, 32]);
    expectConsistentLattice(target.grid);
  });

  it('survives a reload: the snapshot rebuilds at the reconciled size', () => {
    const target = relicBench(['collapsing-vault'], { seed: 'shrink-reload' });

    place(target.grid, 0, 0, 2);
    place(target.grid, 3, 3, 4);
    place(target.grid, 2, 1, 8);
    collapse(target);

    const snapshot = target.grid.serialize();

    // What src/run/run-state-store.ts persists and rehydrates.
    const rebuilt = new Grid(
      snapshot.size,
      JSON.parse(JSON.stringify(snapshot)).cells,
    );

    expect(rebuilt.size).toBe(3);
    expect(values(rebuilt)).toEqual(values(target.grid));
    expectConsistentLattice(rebuilt);

    // And the reconciled rules still describe the board that was rebuilt.
    const reloaded = createDefaultRulesConfig();

    reloaded.boardSize = snapshot.size;

    expect(movesAvailable(rebuilt, reloaded)).toBe(true);
  });

  it('does nothing at all for a stage that was not cleared', () => {
    const target = relicBench(['collapsing-vault'], { seed: 'shrink-none' });

    place(target.grid, 3, 3, 2);
    dispatchOn(target, 'onStageEnd', stageEndPayload(false));

    expect(target.grid.size).toBe(4);
    expect(target.config.boardSize).toBe(4);
    expect(occupants(target.grid)).toEqual([{ x: 3, y: 3, value: 2 }]);
    expect(cursorOf(target, 'relic-draw')).toBe(0);
  });
});

/* ==========================================================================
 * 4. The family together
 * ========================================================================== */

describe('the cursed family held together', () => {
  it('carries four relics, none of them charge-limited', () => {
    for (const id of [
      'collapsing-vault',
      'gilded-rot',
      'brittle-crown',
      'hollow-ascension',
    ]) {
      expect(relicById(id).charges, id).toBeUndefined();
    }
  });

  it('compounds the two merge relics in pickup order', () => {
    const forwards = relicBench(['gilded-rot', 'hollow-ascension']);
    const backwards = relicBench(['hollow-ascension', 'gilded-rot']);

    // Bank one charge on each, so the ascension bonus is live.
    pay(forwards, 4, 4);
    pay(backwards, 4, 4);

    // Forwards: rot doubles 4 to 8, then ascension adds 4 to 12.
    expect(pay(forwards, 4, 4).scoreDelta).toBe(12);

    // Backwards: ascension adds 4 to 8, then rot doubles it to 16.
    expect(pay(backwards, 4, 4).scoreDelta).toBe(16);
  });

  it('resolves a whole stage with all four held, coherently', () => {
    const target = relicBench(
      ['collapsing-vault', 'gilded-rot', 'brittle-crown', 'hollow-ascension'],
      { seed: 'cursed-stage' },
    );

    place(target.grid, 0, 0, 2);
    place(target.grid, 1, 1, 4);
    place(target.grid, 3, 3, 8);

    const started = resultOn(target, 'onStageStart', stageStartPayload(4));

    // Only `brittle-crown` binds `onStageStart`.
    expect(started.invoked).toBe(1);

    const merged = resultOn(
      target,
      'onMerge',
      mergePayload({ x: 1, y: 0 }, { x: 0, y: 0 }, 2, 2, 4, 4),
    );

    expect(merged.invoked).toBe(2);
    dispatchOn(target, 'onAfterMove', afterMovePayload(target.grid, 40));

    const ended = resultOn(target, 'onStageEnd', stageEndPayload(true, 200));

    // Three of the four bind `onStageEnd`.
    expect(ended.invoked).toBe(3);
    expect(ended.failed).toBe(0);

    // The board collapsed once, holds every tile it started with, and is
    // internally consistent.
    expect(target.grid.size).toBe(3);
    expect(values(target.grid)).toEqual([2, 4, 8]);
    expectConsistentLattice(target.grid);

    // The bounty was paid on top of the score the stage ended with, and the
    // spawn distribution was handed back.
    expect(ended.payload.score).toBeGreaterThan(200);
    expect(target.config.spawn.weights).toEqual(
      createDefaultRulesConfig().spawn.weights,
    );
  });

  it('leaves a full board it shrank without an impossible lattice', () => {
    const target = relicBench(['collapsing-vault'], { seed: 'cursed-full' });

    fill(target.grid, 2);
    dispatchOn(target, 'onStageEnd', stageEndPayload(true));

    // Sixteen tiles into nine cells: seven are discarded rather than stacked,
    // and every remaining slot holds exactly one tile at its own coordinates.
    expect(target.grid.size).toBe(3);
    expect(occupants(target.grid)).toHaveLength(9);
    expectConsistentLattice(target.grid);
    expect(target.grid.cellsAvailable()).toBe(false);
  });
});
