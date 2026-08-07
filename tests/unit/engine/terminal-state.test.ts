// Ported-fidelity suite of src/engine/terminal-state.ts, which carries the
// win and loss evaluation of js/game_manager.js, deleted. That port is part
// of the `js/game_manager.js -> src/engine/*` edge of Figure 8, "File
// Transformation Map: Superseded Modules to TypeScript Targets", the visual
// index of docs/TRACEABILITY_MATRIX.md, and this suite is the evidence
// those rows cite.
//
// Every describe below names one construct and the traceability row it
// belongs to:
//   TR-TERM-01  js/game_manager.js L170      the inline win comparison
//                                            -> isWinningMergeValue()
//   TR-TERM-02  js/game_manager.js L238-L240 movesAvailable()
//                                            -> movesAvailable()
//   TR-TERM-03  js/game_manager.js L243-L268 tileMatchesAvailable()
//                                            -> tileMatchesAvailable()
//   TR-TERM-04  js/game_manager.js L30-L32   isGameTerminated()
//                                            -> isGameTerminated()
//   TR-TERM-05  no vanilla source            -> hasReachedWinValue()
//   TR-TERM-06  no vanilla source            -> highestTileValue()
//
// Section 8 is the AAP R4 evidence: the win value and the merge predicate
// are read from the argument at every call, so a replaced predicate moves
// the loss verdict with it and the terminal evaluation and
// src/engine/move-resolver.ts cannot disagree.
//
// Coverage owned by sibling suites and not repeated here: the lattice, the
// bounds valve and the projection (tests/unit/engine/grid.test.ts), the
// traversals and the merge branch
// (tests/unit/engine/move-resolver.test.ts), and the merge schema itself
// (tests/unit/config/rules-config.test.ts).
//
// This suite reads no DOM and no storage, installs no mock and replaces no
// global; every test double below is hand-written. It runs in the
// `unit:dom-free` project of vitest.config.ts, whose environment is 'node'.
//
// Decisions behind this file: DL-TERM-01 through DL-TERM-04 in
// docs/DECISION_LOG.md.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BOARD_SIZE,
  createDefaultRulesConfig,
} from '../../../src/config/default-config';
import type {
  MergeTileView,
  RulesConfig,
} from '../../../src/config/rules-config';
import { Grid } from '../../../src/engine/grid';
import {
  hasReachedWinValue,
  highestTileValue,
  isGameTerminated,
  isWinningMergeValue,
  movesAvailable,
  tileMatchesAvailable,
} from '../../../src/engine/terminal-state';
import type { SerializedGameState } from '../../../src/engine/types';
import {
  BLOCKED_BOARD,
  EMPTY_BOARD,
  MERGE_PAIR_BOARD,
  NEAR_LOSS_BOARD,
  NEAR_WIN_BOARD,
  copyBoard,
  createNearLossBoard,
  createNearWinBoard,
} from '../../fixtures/boards';

/* ===== 1. Sizes, values and helpers ===== */

/** A board smaller than the configured size. */
const SHRUNK_SIZE = 3;

/** A win value other than the configured one. */
const ALTERNATIVE_WIN_VALUE = 1024;

/**
 * Face value written over cell (0, 0) of the near-loss fixture to remove
 * its one adjacent equal pair. It differs from that cell's two neighbours
 * — the fixture documents them as 4 at (1, 0) and 8 at (0, 1) — and from
 * every value the fixture's cycle emits.
 */
const UNMATCHED_VALUE = 1024;

/** Sum the alternative merge predicate of section 8 accepts. */
const ALTERNATIVE_MERGE_SUM = 6;

/**
 * Builds a grid from a serialised board.
 *
 * The two-argument constructor is the one js/game_manager.js L40-L41 used
 * to restore a snapshot, and the size comes from the board rather than
 * from the configuration.
 *
 * @param board Serialised board to restore.
 * @returns A grid holding that board's tiles.
 */
function gridOf(board: SerializedGameState): Grid {
  return new Grid(board.grid.size, board.grid.cells);
}

/**
 * Builds a full board carrying no pair the default predicate accepts.
 *
 * The near-loss fixture is a full board with exactly one adjacent equal
 * pair, at (0, 0) and (1, 0). Overwriting (0, 0) with `UNMATCHED_VALUE`
 * removes that pair and leaves every other cell as the fixture built it.
 *
 * @param size Edge length in cells. Defaults to the configured size.
 * @returns A fresh, unfrozen board with no empty cell.
 */
function createLostBoard(
  size: number = DEFAULT_BOARD_SIZE,
): SerializedGameState {
  const board = createNearLossBoard(size);
  const corner = board.grid.cells[0][0];

  if (corner === null) {
    throw new Error('The near-loss fixture left cell (0, 0) empty.');
  }

  board.grid.cells[0][0] = {
    position: corner.position,
    value: UNMATCHED_VALUE,
  };

  return board;
}

/**
 * Builds a configuration whose merge predicate records every pair it is
 * asked about and answers with `verdict`.
 *
 * @param verdict Verdict the predicate returns for every pair.
 * @returns The configuration and the recorded operand pairs.
 */
function configWithRecordingPredicate(verdict: boolean): {
  readonly config: RulesConfig;
  readonly calls: (readonly [MergeTileView, MergeTileView])[];
} {
  const calls: (readonly [MergeTileView, MergeTileView])[] = [];
  const config = createDefaultRulesConfig();

  config.merge.canMerge = (
    moving: MergeTileView,
    target: MergeTileView,
  ): boolean => {
    calls.push([moving, target]);

    return verdict;
  };

  return { config, calls };
}

/* ===== 2. TR-TERM-01 isWinningMergeValue, js/game_manager.js L170 ===== */

describe('isWinningMergeValue, ported from js/game_manager.js L170', () => {
  it('accepts the configured win value', () => {
    const config = createDefaultRulesConfig();

    expect(isWinningMergeValue(config.winValue, config)).toBe(true);
  });

  it('is strict equality and not a threshold', () => {
    const config = createDefaultRulesConfig();

    expect(isWinningMergeValue(config.winValue - 1, config)).toBe(false);
    expect(isWinningMergeValue(config.winValue / 2, config)).toBe(false);
    expect(isWinningMergeValue(config.winValue * 2, config)).toBe(false);
  });

  it('follows the configured value rather than a literal', () => {
    const config = createDefaultRulesConfig();

    config.winValue = ALTERNATIVE_WIN_VALUE;

    expect(isWinningMergeValue(ALTERNATIVE_WIN_VALUE, config)).toBe(true);
    expect(isWinningMergeValue(DEFAULT_BOARD_SIZE, config)).toBe(false);
  });

  it('reads the value at call time, not at first call', () => {
    const config = createDefaultRulesConfig();
    const original = config.winValue;

    expect(isWinningMergeValue(original, config)).toBe(true);

    config.winValue = ALTERNATIVE_WIN_VALUE;

    expect(isWinningMergeValue(original, config)).toBe(false);
    expect(isWinningMergeValue(ALTERNATIVE_WIN_VALUE, config)).toBe(true);
  });
});

/* ===== 3. TR-TERM-05 hasReachedWinValue, no vanilla source ===== */

describe('hasReachedWinValue, an addition with no vanilla source', () => {
  it('reports false for a board holding no tiles', () => {
    const config = createDefaultRulesConfig();

    expect(hasReachedWinValue(gridOf(EMPTY_BOARD), config)).toBe(false);
  });

  it('reports false for a board one merge short of the win', () => {
    const config = createDefaultRulesConfig();

    expect(hasReachedWinValue(gridOf(NEAR_WIN_BOARD), config)).toBe(false);
  });

  it('reports true once a tile carries the configured value', () => {
    const config = createDefaultRulesConfig();
    const board = copyBoard(NEAR_WIN_BOARD);
    const tile = board.grid.cells[0][0];

    if (tile === null) {
      throw new Error('The near-win fixture left cell (0, 0) empty.');
    }

    board.grid.cells[0][0] = {
      position: tile.position,
      value: config.winValue,
    };

    expect(hasReachedWinValue(gridOf(board), config)).toBe(true);
  });

  it('follows the configured value rather than a literal', () => {
    const config = createDefaultRulesConfig();
    const board = createNearWinBoard(DEFAULT_BOARD_SIZE, config.winValue);

    config.winValue = config.winValue / 2;

    expect(hasReachedWinValue(gridOf(board), config)).toBe(true);
  });
});

/* == 4. TR-TERM-03 tileMatchesAvailable, js/game_manager.js L243-L268 == */

describe('tileMatchesAvailable, from js/game_manager.js L243-L268', () => {
  it('reports false for a board holding no tiles', () => {
    const config = createDefaultRulesConfig();

    expect(tileMatchesAvailable(gridOf(EMPTY_BOARD), config)).toBe(false);
  });

  it('finds the adjacent equal pair of the merge-pair fixture', () => {
    const config = createDefaultRulesConfig();

    expect(tileMatchesAvailable(gridOf(MERGE_PAIR_BOARD), config)).toBe(true);
  });

  it('finds the one pair of the full near-loss fixture', () => {
    const config = createDefaultRulesConfig();

    expect(tileMatchesAvailable(gridOf(NEAR_LOSS_BOARD), config)).toBe(true);
  });

  it('reports false once that pair is removed', () => {
    const config = createDefaultRulesConfig();

    expect(tileMatchesAvailable(gridOf(createLostBoard()), config)).toBe(
      false,
    );
  });

  it('reports false for the blocked fixture, whose column is graded', () => {
    const config = createDefaultRulesConfig();

    expect(tileMatchesAvailable(gridOf(BLOCKED_BOARD), config)).toBe(false);
  });

  it('does not throw on the deliberately out-of-bounds edge probes', () => {
    const config = createDefaultRulesConfig();

    // js/grid.js L80-L86 returned `null` for a cell outside the lattice, so
    // the probe of js/game_manager.js L253-L255 stepped off every edge
    // without a bounds test. Every tile of the blocked fixture sits in
    // column 0, so each of them probes out of bounds at least once.
    expect(() =>
      tileMatchesAvailable(gridOf(BLOCKED_BOARD), config),
    ).not.toThrow();
    expect(() =>
      tileMatchesAvailable(gridOf(createLostBoard()), config),
    ).not.toThrow();
  });

  it('presents both operands with no merge history', () => {
    const { config, calls } = configWithRecordingPredicate(false);

    tileMatchesAvailable(gridOf(MERGE_PAIR_BOARD), config);

    expect(calls.length).toBeGreaterThan(0);

    for (const [moving, target] of calls) {
      expect(moving.mergedFrom).toBeNull();
      expect(target.mergedFrom).toBeNull();
      expect(Object.isFrozen(moving)).toBe(true);
      expect(Object.isFrozen(target)).toBe(true);
    }
  });

  it('returns at the first accepted pair', () => {
    const { config, calls } = configWithRecordingPredicate(true);

    expect(tileMatchesAvailable(gridOf(NEAR_LOSS_BOARD), config)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('reads the board edge length at call time', () => {
    const config = createDefaultRulesConfig();
    const shrunk = createLostBoard(SHRUNK_SIZE);

    expect(shrunk.grid.size).toBe(SHRUNK_SIZE);
    expect(config.boardSize).toBe(DEFAULT_BOARD_SIZE);
    expect(tileMatchesAvailable(gridOf(shrunk), config)).toBe(false);
    expect(
      tileMatchesAvailable(gridOf(createNearLossBoard(SHRUNK_SIZE)), config),
    ).toBe(true);
  });

  it('mutates neither the board nor any tile', () => {
    const config = createDefaultRulesConfig();
    const board = createLostBoard();
    const before = JSON.stringify(board);
    const grid = gridOf(board);

    tileMatchesAvailable(grid, config);

    expect(JSON.stringify(grid.serialize())).toBe(
      JSON.stringify(gridOf(board).serialize()),
    );
    expect(JSON.stringify(board)).toBe(before);
  });
});

/* ===== 5. TR-TERM-02 movesAvailable, js/game_manager.js L238-L240 ===== */

describe('movesAvailable, ported from js/game_manager.js L238-L240', () => {
  it('reports true while any cell is empty', () => {
    const config = createDefaultRulesConfig();

    expect(movesAvailable(gridOf(EMPTY_BOARD), config)).toBe(true);
    expect(movesAvailable(gridOf(BLOCKED_BOARD), config)).toBe(true);
    expect(movesAvailable(gridOf(MERGE_PAIR_BOARD), config)).toBe(true);
  });

  it('short-circuits before the neighbour probe on an open board', () => {
    const { config, calls } = configWithRecordingPredicate(true);

    expect(movesAvailable(gridOf(BLOCKED_BOARD), config)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('probes the neighbours only once no cell is empty', () => {
    const { config, calls } = configWithRecordingPredicate(false);

    expect(movesAvailable(gridOf(createLostBoard()), config)).toBe(false);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('reports true for a full board carrying one mergeable pair', () => {
    const config = createDefaultRulesConfig();

    expect(movesAvailable(gridOf(NEAR_LOSS_BOARD), config)).toBe(true);
  });

  it('reports false for a full board carrying none', () => {
    const config = createDefaultRulesConfig();

    expect(movesAvailable(gridOf(createLostBoard()), config)).toBe(false);
  });
});

/* ===== 6. TR-TERM-04 isGameTerminated, js/game_manager.js L30-L32 ===== */

describe('isGameTerminated, ported from js/game_manager.js L30-L32', () => {
  it('covers every combination of the three flags', () => {
    const cases: readonly {
      readonly over: boolean;
      readonly won: boolean;
      readonly continuedPlay: boolean;
      readonly expected: boolean;
    }[] = [
      { over: false, won: false, continuedPlay: false, expected: false },
      { over: false, won: false, continuedPlay: true, expected: false },
      { over: false, won: true, continuedPlay: false, expected: true },
      { over: false, won: true, continuedPlay: true, expected: false },
      { over: true, won: false, continuedPlay: false, expected: true },
      { over: true, won: false, continuedPlay: true, expected: true },
      { over: true, won: true, continuedPlay: false, expected: true },
      { over: true, won: true, continuedPlay: true, expected: true },
    ];

    for (const { over, won, continuedPlay, expected } of cases) {
      expect(isGameTerminated({ over, won, continuedPlay })).toBe(expected);
    }
  });
});

/* ===== 7. TR-TERM-06 highestTileValue, no vanilla source ===== */

describe('highestTileValue, an addition with no vanilla source', () => {
  it('reports 0 for a board holding no tiles', () => {
    expect(highestTileValue(gridOf(EMPTY_BOARD))).toBe(0);
  });

  it('reports half the win value for the near-win fixture', () => {
    const config = createDefaultRulesConfig();

    expect(highestTileValue(gridOf(NEAR_WIN_BOARD))).toBe(
      config.winValue / 2,
    );
  });

  it('reports the maximum wherever it sits on the board', () => {
    const board = copyBoard(BLOCKED_BOARD);
    const last = board.grid.size - 1;
    const tile = board.grid.cells[0][last];

    if (tile === null) {
      throw new Error('The blocked fixture left the column bottom empty.');
    }

    expect(highestTileValue(gridOf(board))).toBe(tile.value);
  });

  it('reads the board edge length at call time', () => {
    expect(highestTileValue(gridOf(createNearLossBoard(SHRUNK_SIZE))))
      .toBeGreaterThan(0);
  });
});

/* ===== 8. AAP R4: the merge rule in force decides the loss verdict ===== */

describe('the loss verdict follows the configured merge predicate', () => {
  it('finds a move a widened predicate accepts and equality does not', () => {
    const equality = createDefaultRulesConfig();
    const widened = createDefaultRulesConfig();

    // The near-loss fixture is documented as carrying a 2 adjacent to a 4;
    // removing its one equal pair leaves that unequal pair in place.
    widened.merge.canMerge = (
      moving: MergeTileView,
      target: MergeTileView,
    ): boolean => moving.value + target.value === ALTERNATIVE_MERGE_SUM;

    const board = createLostBoard();

    expect(movesAvailable(gridOf(board), equality)).toBe(false);
    expect(movesAvailable(gridOf(board), widened)).toBe(true);
  });

  it('declares a board lost when the predicate accepts nothing', () => {
    const equality = createDefaultRulesConfig();
    const { config: refusing } = configWithRecordingPredicate(false);
    const board = createNearLossBoard();

    expect(movesAvailable(gridOf(board), equality)).toBe(true);
    expect(movesAvailable(gridOf(board), refusing)).toBe(false);
  });

  it('moves with the predicate when it is replaced mid-run', () => {
    const config = createDefaultRulesConfig();
    const board = createLostBoard();
    const grid = gridOf(board);

    expect(movesAvailable(grid, config)).toBe(false);

    config.merge.canMerge = (): boolean => true;

    expect(movesAvailable(grid, config)).toBe(true);
  });

  it('reduces to the vanilla comparison under the default predicate', () => {
    const config = createDefaultRulesConfig();

    // js/game_manager.js L259 compared face values alone. The default
    // predicate adds `!target.mergedFrom`, which every probe view satisfies,
    // so the two verdicts agree cell for cell.
    for (const board of [
      EMPTY_BOARD,
      MERGE_PAIR_BOARD,
      BLOCKED_BOARD,
      NEAR_WIN_BOARD,
      NEAR_LOSS_BOARD,
      createLostBoard(),
    ]) {
      const grid = gridOf(board);
      let vanilla = false;

      grid.eachCell((x, y, tile) => {
        if (tile === null || vanilla) {
          return;
        }

        for (const vector of [
          { x: 0, y: -1 },
          { x: 1, y: 0 },
          { x: 0, y: 1 },
          { x: -1, y: 0 },
        ]) {
          const other = grid.cellContent({ x: x + vector.x, y: y + vector.y });

          if (other && other.value === tile.value) {
            vanilla = true;

            return;
          }
        }
      });

      expect(tileMatchesAvailable(grid, config)).toBe(vanilla);
    }
  });
});
