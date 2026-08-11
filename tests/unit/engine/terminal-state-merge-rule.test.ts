// Contract suite for src/engine/terminal-state.ts: win and loss evaluation
// read from the rules in force rather than from a literal, AAP R4.
//
// The closing block holds the operand-shape contract the loss probe owes a
// POSITION-AWARE merge predicate, and drives it against the real `frostbind`
// relic through the real bus. DL-TERM-05.
//
// This suite reads no DOM, no storage and no clock, installs no mock library
// and writes no snapshot. The relic bench seeds one RNG from a fixed seed; no
// case below reads a draw from it.

import { describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import type {
  MergeTileView,
  RulesConfig,
} from '../../../src/config/rules-config';
import { Grid } from '../../../src/engine/grid';
import {
  hasReachedWinValue,
  highestTileValue,
  isGameTerminated,
  movesAvailable,
  tileMatchesAvailable,
} from '../../../src/engine/terminal-state';
import { Tile } from '../../../src/engine/tile';
import type { Position } from '../../../src/engine/types';
import {
  dispatchOn,
  mergePayload,
  place,
  relicBench,
  stageStartPayload,
} from '../../fixtures/relics';
import type { RelicBench } from '../../fixtures/relics';

/** Edge length every board below is built at. */
const BOARD_SIZE = 4;

/**
 * Builds a grid from a row-major table of values, `null` for an empty cell.
 *
 * @param rows One array per row, outermost row first, which is the reading
 *   order the fixture tables below are written in.
 * @returns The populated grid.
 */
function gridOf(rows: readonly (readonly (number | null)[])[]): Grid {
  const grid = new Grid(rows.length);

  rows.forEach((row, y) => {
    row.forEach((value, x) => {
      if (value !== null) {
        grid.insertTile(new Tile({ x, y }, value));
      }
    });
  });

  return grid;
}

/**
 * A full board carrying no two adjacent equal values: the board L243-L268
 * reported no match for.
 *
 * @returns The grid.
 */
function fullBoardWithNoEqualNeighbours(): Grid {
  return gridOf([
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [4, 2, 4, 2],
  ]);
}

/**
 * The rules in force, with `merge.canMerge` replaced.
 *
 * @param canMerge Predicate to install.
 * @returns The configuration.
 */
function configWithPredicate(
  canMerge: (moving: MergeTileView, target: MergeTileView) => boolean,
): RulesConfig {
  const config = createDefaultRulesConfig();

  config.merge.canMerge = canMerge;

  return config;
}

describe('tileMatchesAvailable resolves a merge through ' +
  'config.merge.canMerge (js/game_manager.js L243-L268)', () => {
  it('reports a match for an adjacent equal pair, as L259 did', () => {
    const config = createDefaultRulesConfig();

    expect(
      tileMatchesAvailable(
        gridOf([
          [2, 2, 4, 8],
          [4, 8, 16, 32],
          [8, 16, 32, 64],
          [16, 32, 64, 128],
        ]),
        config,
      ),
    ).toBe(true);
  });

  it('reports no match for a full board of unequal neighbours, as L267 did',
    () => {
      expect(
        tileMatchesAvailable(
          fullBoardWithNoEqualNeighbours(),
          createDefaultRulesConfig(),
        ),
      ).toBe(false);
    });

  it('reports a match a configured predicate admits and L259 refused', () => {
    // Sums to a power of two: the 2-and-4 pairs of the fixture merge, which
    // equality never admitted.
    const config = configWithPredicate(
      (moving, target) => moving.value + target.value === 6,
    );

    expect(
      tileMatchesAvailable(fullBoardWithNoEqualNeighbours(), config),
    ).toBe(true);
  });

  it('reports no match where a configured predicate refuses an equal pair',
    () => {
      const config = configWithPredicate(() => false);

      expect(
        tileMatchesAvailable(
          gridOf([
            [2, 2, null, null],
            [null, null, null, null],
            [null, null, null, null],
            [null, null, null, null],
          ]),
          config,
        ),
      ).toBe(false);
    });

  it('presents both operands unmerged, so a tile merged this turn still ' +
    'counts as a match (L259 read no merge state)', () => {
    const grid = gridOf([
      [4, 4, 2, 8],
      [2, 8, 16, 32],
      [8, 16, 32, 64],
      [16, 32, 64, 128],
    ]);
    const merged = grid.cellContent({ x: 0, y: 0 });

    // The state js/game_manager.js L163 left on a tile the merge branch
    // produced, which L253's probe ran against on the same turn.
    if (merged !== null) {
      merged.mergedFrom = [
        new Tile({ x: 0, y: 0 }, 2),
        new Tile({ x: 1, y: 0 }, 2),
      ];
    }

    expect(tileMatchesAvailable(grid, createDefaultRulesConfig())).toBe(true);
  });

  it('asks an asymmetric predicate about both orderings of every pair', () => {
    const seen: [number, number][] = [];
    const config = configWithPredicate((moving, target) => {
      seen.push([moving.value, target.value]);

      return false;
    });

    tileMatchesAvailable(
      gridOf([
        [2, 4, null, null],
        [null, null, null, null],
        [null, null, null, null],
        [null, null, null, null],
      ]),
      config,
    );

    expect(seen).toContainEqual([2, 4]);
    expect(seen).toContainEqual([4, 2]);
  });

  it('probes cells outside the lattice without raising (js/grid.js L80-L86)',
    () => {
      expect(() =>
        tileMatchesAvailable(
          gridOf([
            [2, null, null, null],
            [null, null, null, null],
            [null, null, null, null],
            [null, null, null, 2],
          ]),
          createDefaultRulesConfig(),
        ),
      ).not.toThrow();
    });
});

describe('movesAvailable (js/game_manager.js L238-L240)', () => {
  it('reports a move for a board with an empty cell without probing', () => {
    let probed = false;
    const config = configWithPredicate(() => {
      probed = true;

      return false;
    });

    expect(
      movesAvailable(
        gridOf([
          [2, 4, 2, 4],
          [4, 2, 4, 2],
          [2, 4, 2, 4],
          [4, 2, 4, null],
        ]),
        config,
      ),
    ).toBe(true);
    expect(probed).toBe(false);
  });

  it('reports no move for a full board no configured merge admits', () => {
    expect(
      movesAvailable(
        fullBoardWithNoEqualNeighbours(),
        createDefaultRulesConfig(),
      ),
    ).toBe(false);
  });

  it('reports a move for a full board a configured merge admits', () => {
    const config = configWithPredicate(
      (moving, target) => moving.value !== target.value,
    );

    expect(movesAvailable(fullBoardWithNoEqualNeighbours(), config)).toBe(true);
  });
});

describe('win evaluation reads RulesConfig.winValue (L170)', () => {
  it('reports the win where a tile reaches the configured value', () => {
    const config = createDefaultRulesConfig();

    config.winValue = 8;

    expect(
      hasReachedWinValue(
        gridOf([
          [8, null, null, null],
          [null, null, null, null],
          [null, null, null, null],
          [null, null, null, null],
        ]),
        config,
      ),
    ).toBe(true);
  });

  it('reports no win below the configured value', () => {
    expect(
      hasReachedWinValue(
        gridOf([
          [1024, null, null, null],
          [null, null, null, null],
          [null, null, null, null],
          [null, null, null, null],
        ]),
        createDefaultRulesConfig(),
      ),
    ).toBe(false);
  });

  it('reads the highest face value, and 0 for an empty board', () => {
    expect(highestTileValue(new Grid(BOARD_SIZE))).toBe(0);
    expect(highestTileValue(fullBoardWithNoEqualNeighbours())).toBe(4);
  });

  it('carries L30-L32 unchanged', () => {
    expect(
      isGameTerminated({ over: false, won: true, continuedPlay: false }),
    ).toBe(true);
    expect(
      isGameTerminated({ over: false, won: true, continuedPlay: true }),
    ).toBe(false);
    expect(
      isGameTerminated({ over: true, won: false, continuedPlay: true }),
    ).toBe(true);
  });
});

/* ==========================================================================
 * The operand shape the loss probe owes a POSITION-AWARE predicate.
 *
 * `resolveMove` of src/engine/move-resolver.ts hands `config.merge.canMerge`
 * live `Tile` instances, which carry `x` and `y`. The probe must present the
 * same shape or a predicate keyed on the cell answers from its own
 * no-position fall-through and the walk and the probe disagree — the board is
 * reported playable when every remaining pair would in fact be refused, which
 * is a run that can neither be played nor ended. DL-TERM-05.
 * ========================================================================== */

/**
 * The full board of Issue 7, written in the reading order `gridOf` takes.
 *
 * Exactly two adjacent equal pairs exist — the 2s at `(0,2)`/`(0,3)` and the
 * 2s at `(3,0)`/`(3,1)` — and no cell is empty, so those two pairs are the
 * whole of the board's remaining play.
 */
const ISSUE_SEVEN_ROWS: readonly (readonly number[])[] = Object.freeze([
  Object.freeze([4, 2, 4, 2]),
  Object.freeze([32, 4, 8, 2]),
  Object.freeze([2, 16, 64, 8]),
  Object.freeze([2, 8, 16, 4]),
]);

/**
 * Every cell either pair of `ISSUE_SEVEN_ROWS` can merge INTO. A vertical pair
 * resolves upward or downward depending on the direction pressed, so both of a
 * pair's cells are destinations and both have to be frosted for the pair to be
 * refused outright.
 */
const ISSUE_SEVEN_PAIR_CELLS: readonly Position[] = Object.freeze([
  Object.freeze({ x: 0, y: 2 }),
  Object.freeze({ x: 0, y: 3 }),
  Object.freeze({ x: 3, y: 0 }),
  Object.freeze({ x: 3, y: 1 }),
]);

/** Cells frosted only to run the budget down; none carries a pair. */
const ISSUE_SEVEN_FILLER_CELLS: readonly Position[] = Object.freeze([
  Object.freeze({ x: 1, y: 0 }),
  Object.freeze({ x: 1, y: 1 }),
  Object.freeze({ x: 2, y: 2 }),
  Object.freeze({ x: 2, y: 3 }),
]);

/**
 * Seats `frostbind` and builds the Issue 7 board underneath it.
 *
 * @returns The bench, whose grid is full and whose rules are the default ones.
 */
function issueSevenBench(): RelicBench {
  const bench = relicBench(['frostbind']);

  ISSUE_SEVEN_ROWS.forEach((row, y) => {
    row.forEach((value, x) => {
      place(bench.grid, x, y, value);
    });
  });

  return bench;
}

/**
 * Frosts one cell the way play frosts it: by resolving a merge there.
 *
 * @param bench Bench to dispatch on.
 * @param cell Cell the merge lands on, which is the cell that gets frosted.
 */
function frost(bench: RelicBench, cell: Position): void {
  dispatchOn(
    bench,
    'onMerge',
    mergePayload({ x: cell.x, y: cell.y }, cell, 2, 2, 4, 4),
  );
}

/**
 * Reads the charge budget left on the bench's only subscriber.
 *
 * @param bench Bench to read.
 * @returns Charges remaining.
 */
function chargesLeft(bench: RelicBench): number | undefined {
  return bench.bus
    .subscribers()
    .find((entry) => entry.id === 'frostbind')?.charges;
}

describe('the loss probe presents each operand with its cell (DL-TERM-05)', () => {
  it('hands the predicate the moving cell and the destination cell', () => {
    const seen: { moving: unknown; target: unknown }[] = [];
    const config = configWithPredicate((moving, target): boolean => {
      seen.push({ moving, target });

      return false;
    });

    // A single pair, so the probe's operand order is unambiguous.
    tileMatchesAvailable(
      gridOf([
        [2, null, null, null],
        [2, null, null, null],
        [null, null, null, null],
        [null, null, null, null],
      ]),
      config,
    );

    expect(seen.length).toBeGreaterThan(0);

    for (const call of seen) {
      for (const operand of [call.moving, call.target]) {
        const cell = operand as { x?: unknown; y?: unknown; value?: unknown };

        expect(typeof cell.x).toBe('number');
        expect(typeof cell.y).toBe('number');
        expect(typeof cell.value).toBe('number');
      }
    }

    // The tile at (0,0) probed downward: it is the operand that would MOVE and
    // (0,1) is the cell it would move INTO, which is the order the walk uses.
    const downward = seen.find((call) => {
      const moving = call.moving as Position;
      const target = call.target as Position;

      return moving.y === 0 && target.y === 1;
    });

    expect(downward).toBeDefined();
    expect((downward?.moving as Position).x).toBe(0);
    expect((downward?.target as Position).x).toBe(0);
  });

  it('presents no merge history, exactly as it always did', () => {
    const histories: unknown[] = [];
    const config = configWithPredicate((moving, target): boolean => {
      histories.push(moving.mergedFrom, target.mergedFrom);

      return false;
    });

    tileMatchesAvailable(fullBoardWithNoEqualNeighbours(), config);

    expect(histories.length).toBeGreaterThan(0);
    expect(histories.every((entry) => entry === null)).toBe(true);
  });

  it('lets a cell-keyed predicate refuse, so a frozen board reads as lost',
    () => {
      // The predicate the Issue 7 soft-lock was built from, stated directly:
      // it refuses any merge landing on a listed cell.
      const config = configWithPredicate((moving, target): boolean => {
        const destination = target as unknown as Position;
        const sameValue = moving.value === target.value;

        return (
          sameValue &&
          !ISSUE_SEVEN_PAIR_CELLS.some(
            (cell) => cell.x === destination.x && cell.y === destination.y,
          )
        );
      });
      const grid = gridOf(ISSUE_SEVEN_ROWS);

      expect(grid.cellsAvailable()).toBe(false);
      expect(tileMatchesAvailable(grid, config)).toBe(false);
      expect(movesAvailable(grid, config)).toBe(false);
    });
});

describe('the real frostbind relic on the Issue 7 board', () => {
  it('reports the board playable while nothing is frosted', () => {
    const bench = issueSevenBench();

    // Installs the wrapper over an empty ledger, which refuses no cell.
    dispatchOn(bench, 'onStageStart', stageStartPayload(bench.grid.size));

    expect(bench.grid.cellsAvailable()).toBe(false);
    expect(tileMatchesAvailable(bench.grid, bench.config)).toBe(true);
    expect(movesAvailable(bench.grid, bench.config)).toBe(true);
  });

  it('reports the board LOST once both pairs are frosted and the budget spent',
    () => {
      const bench = issueSevenBench();

      for (const cell of ISSUE_SEVEN_PAIR_CELLS) {
        frost(bench, cell);
      }

      for (const cell of ISSUE_SEVEN_FILLER_CELLS) {
        frost(bench, cell);
      }

      // Exhausted, which is the state Issue 7 was reached in.
      expect(chargesLeft(bench)).toBe(0);

      // A further merge cannot reach the handler, so the frost can never thaw.
      const spent = bench.bus.dispatch(
        'onMerge',
        mergePayload({ x: 0, y: 2 }, { x: 0, y: 3 }, 2, 2, 4, 4),
        bench.environment,
      );

      expect(spent.invoked).toBe(0);
      expect(spent.skipped).toBe(1);

      // The board is full and every remaining pair is refused by the rule in
      // force, so the run resolves rather than stranding.
      expect(bench.grid.cellsAvailable()).toBe(false);
      expect(tileMatchesAvailable(bench.grid, bench.config)).toBe(false);
      expect(movesAvailable(bench.grid, bench.config)).toBe(false);
    });

  it('reports the board LOST while the relic still holds charges', () => {
    const bench = issueSevenBench();

    for (const cell of ISSUE_SEVEN_PAIR_CELLS) {
      frost(bench, cell);
    }

    // Half the budget is still in hand: an exhausted relic is not what makes
    // the board unplayable, so clearing a spent ledger would not have reached
    // this case.
    expect(chargesLeft(bench)).toBe(4);
    expect(movesAvailable(bench.grid, bench.config)).toBe(false);
  });

  it('agrees with the rule the resolved walk reads, cell for cell', () => {
    const bench = issueSevenBench();

    for (const cell of ISSUE_SEVEN_PAIR_CELLS) {
      frost(bench, cell);
    }

    // The walk's own operands: real tiles at the pair's two cells.
    const lower = new Tile({ x: 0, y: 3 }, 2);
    const upper = new Tile({ x: 0, y: 2 }, 2);

    expect(bench.config.merge.canMerge(lower, upper)).toBe(false);
    expect(bench.config.merge.canMerge(upper, lower)).toBe(false);

    // An equal pair on cells the ledger does not hold is still admitted, so
    // the refusal is the ledger's and not a blanket one.
    const freeLower = new Tile({ x: 2, y: 1 }, 8);
    const freeUpper = new Tile({ x: 2, y: 0 }, 8);

    expect(bench.config.merge.canMerge(freeLower, freeUpper)).toBe(true);
  });

  it('still refuses only the frosted cells, leaving an escape playable', () => {
    const bench = issueSevenBench();

    // Frost one cell of each pair rather than both: pressing toward the
    // unfrosted cell still resolves, so the board must read as playable.
    frost(bench, { x: 0, y: 2 });
    frost(bench, { x: 3, y: 0 });

    expect(bench.grid.cellsAvailable()).toBe(false);
    expect(movesAvailable(bench.grid, bench.config)).toBe(true);
  });
});
