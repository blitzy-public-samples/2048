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
// Section 7 covers the flag js/game_manager.js L24-L27 assigned over its own
// prototype method of the same name, which L31 then read back and L45 and
// L51 wrote. It reaches this module as `TerminalStateInput.continuedPlay`,
// the name src/engine/engine.ts carries it under. The Engine method is
// `continuePlaying()`, and the persisted member name and the input event
// name keep the vanilla spelling; those three are asserted in
// tests/unit/engine/engine-snapshot-bounds.test.ts and
// tests/unit/input/input-dispatch.test.ts and are not repeated here.
//
// Section 9 is the AAP R4 evidence: the win value and the merge predicate
// are read from the argument at every call, so a replaced predicate moves
// the loss verdict with it and the terminal evaluation and
// src/engine/move-resolver.ts cannot disagree.
//
// The verdicts asserted below appear in two further named figures. Figure 4,
// "Turn Data Flow: From Keystroke to Composited Frame and Persisted Run
// State", in docs/architecture/data-flow.md, carries the win check against
// `config.winValue` and the `Moves available?` decision that gates game
// over; Figure 6, "Screen Flow State Machine: Run Start to Run Summary",
// carries the `Won -> keep playing` and `Won -> RunSummary` transitions the
// flag of section 7 governs. The test names below are stable so both
// documents can cite them.
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
// Decisions of docs/DECISION_LOG.md this suite is the evidence for, one apiece:
// DL-TERM-01, DL-TERM-02, DL-TERM-03, DL-TERM-04, and DL-ENGINE-04 for the flag
// of section 7.

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_BOARD_SIZE,
  createDefaultRulesConfig,
} from '../../../src/config/default-config';
import type {
  MergeTileView,
  RulesConfig,
} from '../../../src/config/rules-config';
import { Grid } from '../../../src/engine/grid';
import * as terminalState from '../../../src/engine/terminal-state';
import {
  hasReachedWinValue,
  highestTileValue,
  isGameTerminated,
  isWinningMergeValue,
  movesAvailable,
  tileMatchesAvailable,
  type TerminalStateInput,
} from '../../../src/engine/terminal-state';
import type {
  SerializedGameState,
  SerializedTile,
} from '../../../src/engine/types';
import {
  BLOCKED_BOARD,
  EMPTY_BOARD,
  MERGE_PAIR_BOARD,
  NEAR_LOSS_BOARD,
  NEAR_WIN_BOARD,
  copyBoard,
  createEmptyBoard,
  createNearLossBoard,
  createNearWinBoard,
} from '../../fixtures/boards';

/* ===== 1. Sizes, values and helpers ===== */

/** A board smaller than the configured size. */
const SHRUNK_SIZE = 3;

/** A board larger than the configured size. */
const GROWN_SIZE = 5;

/** A win value other than the configured one. */
const ALTERNATIVE_WIN_VALUE = 1024;

/**
 * The win value `createDefaultRulesConfig()` carries, ported from
 * js/game_manager.js L170. Section 2 asserts it against that configuration
 * before moving the target off it.
 */
const DEFAULT_CONFIG_WIN_VALUE = 2048;

/** A win value a stage configuration moves the target to. */
const MOVED_WIN_VALUE = 128;

/** Factor by which an overshooting merge exceeds a doubling one. */
const OVERSHOOT_FACTOR = 3;

/** Divisor taking the win value to the face value one merge below it. */
const WIN_VALUE_HALVING = 2;

/** Face value carried by the one tile of a single-tile board. */
const SINGLE_TILE_VALUE = 8;

/**
 * Directions js/game_manager.js L253 walked from each occupied cell.
 */
const PROBE_DIRECTION_COUNT = 4;

/** Length of the cycle a perimeter board draws its face values from. */
const PERIMETER_CYCLE_LENGTH = 3;

/** Members `TerminalStateInput` carries. */
const TERMINAL_STATE_MEMBER_COUNT = 3;

/** Every function src/engine/terminal-state.ts exports. */
const EXPORTED_QUERY_NAMES: readonly string[] = [
  'hasReachedWinValue',
  'highestTileValue',
  'isGameTerminated',
  'isWinningMergeValue',
  'movesAvailable',
  'tileMatchesAvailable',
];

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
 * Reads an occupied cell of a serialised board.
 *
 * @param board Board to read. Frozen boards read as well as unfrozen ones.
 * @param x Column index.
 * @param y Row index.
 * @returns The tile occupying that cell.
 * @throws {Error} If the cell is empty.
 */
function tileAt(
  board: SerializedGameState,
  x: number,
  y: number,
): SerializedTile {
  const tile = board.grid.cells[x][y];

  if (tile === null) {
    throw new Error(
      `The fixture left cell (${String(x)}, ${String(y)}) empty.`,
    );
  }

  return tile;
}

/**
 * Writes a tile carrying `value` into one cell of a board, overwriting
 * whatever the cell held.
 *
 * @param board Board to write into. It must be unfrozen, so a fixture
 *   constant reaches this through `copyBoard` or through its builder.
 * @param x Column index.
 * @param y Row index.
 * @param value Face value the written tile carries.
 */
function putTile(
  board: SerializedGameState,
  x: number,
  y: number,
  value: number,
): void {
  board.grid.cells[x][y] = { position: { x, y }, value };
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

  putTile(board, 0, 0, UNMATCHED_VALUE);

  return board;
}

/**
 * Builds a full board whose one adjacent equal pair runs down a column.
 *
 * `createLostBoard` carries no adjacent equal pair. Writing the face value
 * of (0, 2) into (0, 1) pairs those two cells; at the configured size the
 * other two neighbours of (0, 1) are the overwritten corner and the cell at
 * (1, 1), and the fixture gives neither of them that value.
 *
 * @returns A fresh, unfrozen board with no empty cell.
 */
function createColumnPairBoard(): SerializedGameState {
  const board = createLostBoard();

  putTile(board, 0, 1, tileAt(board, 0, 2).value);

  return board;
}

/**
 * Builds a full board whose one adjacent equal pair sits in the last cells
 * the walk of js/game_manager.js L248-L249 reaches: (size - 1, size - 2)
 * and (size - 1, size - 1).
 *
 * `createLostBoard` carries no adjacent equal pair. Writing the face value
 * of the final cell into the one above it pairs those two; at the configured
 * size the other two neighbours of that cell are (size - 2, size - 2) and
 * (size - 1, size - 3), and the fixture gives neither that value.
 *
 * @returns A fresh, unfrozen board with no empty cell.
 */
function createLateColumnPairBoard(): SerializedGameState {
  const board = createLostBoard();
  const last = board.grid.size - 1;

  putTile(board, last, last - 1, tileAt(board, last, last).value);

  return board;
}

/**
 * The face value a perimeter board carries at one cell. Two adjacent cells
 * differ by exactly one in `x + y`, so no two of them share a value.
 *
 * @param x Column index.
 * @param y Row index.
 * @returns A face value drawn from a cycle of `PERIMETER_CYCLE_LENGTH`.
 */
function perimeterValue(x: number, y: number): number {
  return 2 ** (1 + ((x + y) % PERIMETER_CYCLE_LENGTH));
}

/**
 * Builds a board whose tiles sit only in the corners and along the edges,
 * with every interior cell empty. Every one of those tiles addresses at
 * least one cell outside the lattice when it is probed.
 *
 * @returns A fresh, unfrozen board at the configured size.
 */
function createPerimeterBoard(): SerializedGameState {
  const board = createEmptyBoard();
  const last = board.grid.size - 1;

  for (let x = 0; x <= last; x += 1) {
    for (let y = 0; y <= last; y += 1) {
      if (x === 0 || y === 0 || x === last || y === last) {
        putTile(board, x, y, perimeterValue(x, y));
      }
    }
  }

  return board;
}

/**
 * The neighbour probes a full board of this edge length reads inside the
 * lattice: four per cell, less the one each edge cell and the two each
 * corner cell address outside it.
 *
 * @param size Edge length in cells.
 * @returns The count of in-bounds probes.
 */
function inBoundsProbeCount(size: number): number {
  return PROBE_DIRECTION_COUNT * size * (size - 1);
}

/**
 * The neighbour probes a board of this edge length addresses at most: one
 * per cell per direction, in bounds or out of it.
 *
 * @param size Edge length in cells.
 * @returns The count of addressed probes.
 */
function attemptedProbeCount(size: number): number {
  return PROBE_DIRECTION_COUNT * size * size;
}

/**
 * Reads the highest face value of a serialised board, and 0 for a board
 * holding no tiles. Independent of the walk `highestTileValue` performs.
 *
 * @param board Board to scan.
 * @returns The highest face value on it.
 */
function highestSerializedValue(board: SerializedGameState): number {
  let highest = 0;

  for (const column of board.grid.cells) {
    for (const tile of column) {
      if (tile !== null && tile.value > highest) {
        highest = tile.value;
      }
    }
  }

  return highest;
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

/**
 * Builds a configuration whose merge predicate records every pair it is
 * asked about and answers with the default rule of
 * src/config/default-config.ts.
 *
 * @returns The configuration and the recorded operand pairs, in the order
 *   the probe asked about them.
 */
function configWithObservedPredicate(): {
  readonly config: RulesConfig;
  readonly calls: (readonly [MergeTileView, MergeTileView])[];
} {
  const calls: (readonly [MergeTileView, MergeTileView])[] = [];
  const config = createDefaultRulesConfig();
  const observed = config.merge.canMerge;

  config.merge.canMerge = (
    moving: MergeTileView,
    target: MergeTileView,
  ): boolean => {
    calls.push([moving, target]);

    return observed(moving, target);
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

  it('does not privilege the vanilla value once the target moves', () => {
    const config = createDefaultRulesConfig();

    expect(config.winValue).toBe(DEFAULT_CONFIG_WIN_VALUE);

    config.winValue = MOVED_WIN_VALUE;

    expect(isWinningMergeValue(MOVED_WIN_VALUE, config)).toBe(true);
    expect(isWinningMergeValue(DEFAULT_CONFIG_WIN_VALUE, config)).toBe(false);
  });

  it('reports false for a merge value that overshoots the target', () => {
    const config = createDefaultRulesConfig();
    // A producer trebling rather than doubling takes the face value one
    // merge below the target past it rather than onto it.
    const belowTarget = config.winValue / WIN_VALUE_HALVING;
    const overshoot = belowTarget * OVERSHOOT_FACTOR;

    expect(isWinningMergeValue(belowTarget * WIN_VALUE_HALVING, config)).toBe(
      true,
    );
    expect(overshoot).toBeGreaterThan(config.winValue);
    expect(isWinningMergeValue(overshoot, config)).toBe(false);
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

    expect(tileAt(board, 0, 0).value).not.toBe(config.winValue);

    putTile(board, 0, 0, config.winValue);

    expect(hasReachedWinValue(gridOf(board), config)).toBe(true);
  });

  it('follows the configured value rather than a literal', () => {
    const config = createDefaultRulesConfig();
    const board = createNearWinBoard(DEFAULT_BOARD_SIZE, config.winValue);

    config.winValue = config.winValue / WIN_VALUE_HALVING;

    expect(hasReachedWinValue(gridOf(board), config)).toBe(true);
  });

  it('reads the win value off each config handed to it', () => {
    const grid = gridOf(NEAR_WIN_BOARD);
    const target = createDefaultRulesConfig();
    const halved = createDefaultRulesConfig();

    halved.winValue = target.winValue / WIN_VALUE_HALVING;

    expect(hasReachedWinValue(grid, target)).toBe(false);
    expect(hasReachedWinValue(grid, halved)).toBe(true);
    expect(hasReachedWinValue(grid, target)).toBe(false);
  });

  it('agrees with isWinningMergeValue over every fixture board', () => {
    const config = createDefaultRulesConfig();
    const won = copyBoard(NEAR_WIN_BOARD);

    putTile(won, 0, 0, config.winValue);

    for (const board of [
      EMPTY_BOARD,
      MERGE_PAIR_BOARD,
      BLOCKED_BOARD,
      NEAR_WIN_BOARD,
      NEAR_LOSS_BOARD,
      won,
    ]) {
      const grid = gridOf(board);
      let anyWinning = false;

      grid.eachCell((_x, _y, tile) => {
        if (tile && isWinningMergeValue(tile.value, config)) {
          anyWinning = true;
        }
      });

      expect(hasReachedWinValue(grid, config)).toBe(anyWinning);
    }

    expect(hasReachedWinValue(gridOf(won), config)).toBe(true);
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

  it('finds an adjacent equal pair along a row', () => {
    const config = createDefaultRulesConfig();
    const board = createNearLossBoard();

    // The fixture documents its one pair as (0, 0) and (1, 0), in row 0.
    expect(tileAt(board, 0, 0).value).toBe(tileAt(board, 1, 0).value);
    expect(tileMatchesAvailable(gridOf(board), config)).toBe(true);
  });

  it('finds an adjacent equal pair down a column', () => {
    const config = createDefaultRulesConfig();
    const board = createColumnPairBoard();

    expect(tileAt(board, 0, 1).value).toBe(tileAt(board, 0, 2).value);
    expect(tileAt(board, 0, 1).value).not.toBe(tileAt(board, 1, 1).value);
    expect(tileAt(board, 0, 1).value).not.toBe(tileAt(board, 0, 0).value);
    expect(tileMatchesAvailable(gridOf(board), config)).toBe(true);
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

  it('evaluates a board of corner and edge tiles without raising', () => {
    const config = createDefaultRulesConfig();
    const board = createPerimeterBoard();

    // js/grid.js L84 answers the off-lattice cells js/game_manager.js L255
    // addresses. Every tile of this board sits on an edge, so each one
    // addresses at least one such cell and each corner addresses two.
    expect(() =>
      tileMatchesAvailable(gridOf(board), config),
    ).not.toThrow();
    expect(tileMatchesAvailable(gridOf(board), config)).toBe(false);
    expect(gridOf(board).cellsAvailable()).toBe(true);
  });

  it('finds a pair at a corner that probes off the lattice twice', () => {
    const config = createDefaultRulesConfig();
    const board = createPerimeterBoard();

    putTile(board, 0, 0, tileAt(board, 1, 0).value);

    expect(tileAt(board, 0, 0).value).toBe(tileAt(board, 1, 0).value);
    expect(tileMatchesAvailable(gridOf(board), config)).toBe(true);
  });

  it('asks the predicate once per in-bounds probe and no more', () => {
    const { config, calls } = configWithRecordingPredicate(false);

    // js/game_manager.js L248-L253 addressed four cells from each of the
    // size by size cells, so a full board addresses `attemptedProbeCount`
    // in all; js/grid.js L84 answers the ones outside the lattice with
    // `null`, leaving `inBoundsProbeCount` pairs for the predicate.
    expect(tileMatchesAvailable(gridOf(createLostBoard()), config)).toBe(
      false,
    );
    expect(calls).toHaveLength(inBoundsProbeCount(DEFAULT_BOARD_SIZE));
    expect(calls.length).toBeLessThan(
      attemptedProbeCount(DEFAULT_BOARD_SIZE),
    );
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

  it('walks x-outer then y-inner and returns at the first match', () => {
    const early = configWithObservedPredicate();
    const late = configWithObservedPredicate();
    const lateBoard = createLateColumnPairBoard();
    const inBounds = inBoundsProbeCount(DEFAULT_BOARD_SIZE);
    const lastCellReached = inBounds - PROBE_DIRECTION_COUNT;

    // The near-loss fixture's pair is (0, 0) and (1, 0), the first cell of
    // the walk of L248-L249 and its first in-bounds probe.
    expect(tileMatchesAvailable(gridOf(NEAR_LOSS_BOARD), early.config)).toBe(
      true,
    );
    expect(early.calls).toHaveLength(1);

    expect(tileMatchesAvailable(gridOf(lateBoard), late.config)).toBe(true);
    expect(late.calls.length).toBeGreaterThan(lastCellReached);
    expect(late.calls.length).toBeLessThan(inBounds);

    const opening = late.calls[0];
    const closing = late.calls[late.calls.length - 1];

    expect(opening[0].value).toBe(tileAt(lateBoard, 0, 0).value);
    expect(closing[0].value).toBe(closing[1].value);
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

  it('reads the board edge length at call time', () => {
    const config = createDefaultRulesConfig();

    expect(config.boardSize).toBe(DEFAULT_BOARD_SIZE);

    for (const size of [SHRUNK_SIZE, GROWN_SIZE]) {
      const lost = gridOf(createLostBoard(size));
      const alive = gridOf(createNearLossBoard(size));

      expect(lost.size).toBe(size);
      expect(lost.cellsAvailable()).toBe(false);
      expect(movesAvailable(lost, config)).toBe(false);
      expect(movesAvailable(alive, config)).toBe(true);
    }
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

  it('terminates a won game only while play has not continued', () => {
    const won = { over: false, won: true } as const;

    expect(isGameTerminated({ ...won, continuedPlay: false })).toBe(true);
    expect(isGameTerminated({ ...won, continuedPlay: true })).toBe(false);
  });
});

/* == 7. The continue-after-win flag, js/game_manager.js L24-L27, L45, L51 == */

describe('the continue-after-win flag, js/game_manager.js L24-L27', () => {
  it('is a boolean member of the state, not a callable', () => {
    const state: TerminalStateInput = {
      over: false,
      won: true,
      continuedPlay: false,
    };
    const members = Object.entries(state);

    expect(members).toHaveLength(TERMINAL_STATE_MEMBER_COUNT);

    for (const [, value] of members) {
      expect(typeof value).toBe('boolean');
    }

    expect(typeof state.continuedPlay).toBe('boolean');
  });

  it('is read as a value and never invoked', () => {
    // js/game_manager.js L24-L27 assigned a boolean over its own prototype
    // method and L31 read that same name back, so until L45 or L51 ran the
    // name resolved to the method.
    const shadowing = vi.fn(() => true);
    const shadowed: TerminalStateInput = {
      over: false,
      won: true,
      continuedPlay: shadowing as unknown as boolean,
    };

    expect(isGameTerminated(shadowed)).toBe(false);
    expect(shadowing).not.toHaveBeenCalled();
    expect(
      isGameTerminated({ over: false, won: true, continuedPlay: false }),
    ).toBe(true);
  });

  it('shares its name with no export of the module', () => {
    const exported: Record<string, unknown> = { ...terminalState };
    const names = Object.keys(exported);

    for (const name of EXPORTED_QUERY_NAMES) {
      expect(names).toContain(name);
      expect(typeof exported[name]).toBe('function');
    }

    expect(names).not.toContain('continuedPlay');
    expect(names).not.toContain('keepPlaying');
  });
});

/* ===== 8. TR-TERM-06 highestTileValue, no vanilla source ===== */

describe('highestTileValue, an addition with no vanilla source', () => {
  it('reports 0 for a board holding no tiles', () => {
    expect(highestTileValue(gridOf(EMPTY_BOARD))).toBe(0);
  });

  it('reports half the win value for the near-win fixture', () => {
    const config = createDefaultRulesConfig();

    expect(highestTileValue(gridOf(NEAR_WIN_BOARD))).toBe(
      config.winValue / WIN_VALUE_HALVING,
    );
  });

  it('reports the maximum wherever it sits on the board', () => {
    const board = copyBoard(BLOCKED_BOARD);
    const last = board.grid.size - 1;

    expect(highestTileValue(gridOf(board))).toBe(
      tileAt(board, 0, last).value,
    );
  });

  it('reads the board edge length at call time', () => {
    expect(highestTileValue(gridOf(createNearLossBoard(SHRUNK_SIZE))))
      .toBeGreaterThan(0);
  });

  it('reports the value of the one tile on a single-tile board', () => {
    const board = createEmptyBoard();

    putTile(board, 1, 2, SINGLE_TILE_VALUE);

    expect(highestTileValue(gridOf(board))).toBe(SINGLE_TILE_VALUE);
  });

  it('reports the maximum of a board with no empty cell', () => {
    const board = createNearLossBoard();

    expect(gridOf(board).cellsAvailable()).toBe(false);
    expect(highestTileValue(gridOf(board))).toBe(
      highestSerializedValue(board),
    );
  });

  it('reports a maximum sitting at either end of the walk', () => {
    const last = DEFAULT_BOARD_SIZE - 1;
    const atFirstCell = createNearLossBoard();
    const atLastCell = createNearLossBoard();
    const above = highestSerializedValue(atFirstCell) * WIN_VALUE_HALVING;

    putTile(atFirstCell, 0, 0, above);
    putTile(atLastCell, last, last, above);

    expect(highestTileValue(gridOf(atFirstCell))).toBe(above);
    expect(highestTileValue(gridOf(atLastCell))).toBe(above);
  });
});

/* ===== 9. AAP R4: the merge rule in force decides the loss verdict ===== */

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
