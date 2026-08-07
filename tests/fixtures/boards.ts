// The five board fixtures every suite under tests/ builds engine state from,
// expressed in the product's own persisted vocabulary.
//
// Provenance of that vocabulary, from the deleted vanilla sources: tile
// serialised to `{ position: { x, y }, value }` with a falsy value coerced to
// 2; grid serialised to `{ size, cells }` with an empty cell as `null` and cell
// order x-outer, y-inner; rehydration reading `state[x][y]`; the manager
// snapshot `{ grid, score, over, won, keepPlaying }`; the win comparison being
// strict equality; the four direction vectors 0 up, 1 right, 2 down, 3 left
// with y increasing downward; and the loss check being `cellsAvailable() ||
// tileMatchesAvailable()`.
//
// The persisted member name is `keepPlaying`, unchanged from the vanilla
// snapshot, while the in-class flag it restores is named `continuedPlay` in
// src/engine/engine.ts.
//
// MUTABILITY CONTRACT: every builder returns a freshly allocated, unfrozen
// board sharing no object — not the board, its grid, the cell matrix, a column,
// a tile or a tile's position — with any earlier return value or with the
// frozen constants below.
//
// This module imports two values and three types and nothing else. It reads no
// DOM and no storage, performs no I/O, consumes no randomness, reads no clock
// and writes no log.
//
// Decisions behind this file: DL-FIXTURE-01, the five boards expressed in
// the product's own persisted vocabulary, and DL-FIXTURE-02, every builder

import {
  DEFAULT_BOARD_SIZE,
  DEFAULT_RULES_CONFIG,
} from '../../src/config/default-config';
import type {
  CellMatrix,
  SerializedGameState,
  SerializedTile,
} from '../../src/engine/types';

/* ===== 1. Cell values ===== */

type CellValue = (x: number, y: number) => number | null;

const MIN_EMPTY_BOARD_SIZE = 1;

const MIN_OCCUPIED_BOARD_SIZE = 2;

const MERGE_PAIR_VALUE = 2;

const PAIR_TILE_COUNT = 2;

const CROWDED_CYCLE: readonly number[] = [2, 4, 8, 16, 32];

const CROWDED_ROW_STEP = 2;

const CROWDED_PAIR_INDEX = 1;

const MIN_WIN_VALUE = 2;

const WIN_VALUE_HALVING = 2;

/* ===== 2. Argument guards ===== */

function requireBoardSize(size: number, minimum: number): void {
  if (!Number.isSafeInteger(size) || size < minimum) {
    throw new RangeError(
      `A board fixture needs an integer size of at least ${minimum}; ` +
        `received ${String(size)}.`,
    );
  }
}

function requireWinValue(winValue: number): void {
  if (
    !Number.isSafeInteger(winValue) ||
    winValue < MIN_WIN_VALUE ||
    winValue % WIN_VALUE_HALVING !== 0
  ) {
    throw new RangeError(
      'A near-win fixture needs an even integer win value of at least ' +
        `${MIN_WIN_VALUE}; received ${String(winValue)}.`,
    );
  }
}

/* ===== 3. Matrix construction ===== */

function buildCellMatrix(
  size: number,
  cellValue: CellValue,
): CellMatrix<SerializedTile> {
  const cells: CellMatrix<SerializedTile> = [];

  for (let x = 0; x < size; x += 1) {
    const column: (SerializedTile | null)[] = [];

    cells[x] = column;

    for (let y = 0; y < size; y += 1) {
      const value = cellValue(x, y);

      column.push(value === null ? null : { position: { x, y }, value });
    }
  }

  return cells;
}

function buildBoard(
  size: number,
  cells: CellMatrix<SerializedTile>,
): SerializedGameState {
  return {
    grid: { size, cells },
    score: 0,
    over: false,
    won: false,
    keepPlaying: false,
  };
}

/* ===== 4. Copying ===== */

function copyTile(tile: SerializedTile): SerializedTile {
  return {
    position: { x: tile.position.x, y: tile.position.y },
    value: tile.value,
  };
}

function copyCellMatrix(
  cells: CellMatrix<SerializedTile>,
): CellMatrix<SerializedTile> {
  const copy: CellMatrix<SerializedTile> = [];

  for (let x = 0; x < cells.length; x += 1) {
    const column = cells[x];
    const columnCopy: (SerializedTile | null)[] = [];

    copy[x] = columnCopy;

    for (let y = 0; y < column.length; y += 1) {
      const tile = column[y];

      columnCopy.push(tile === null ? null : copyTile(tile));
    }
  }

  return copy;
}

/**
 * Copies a board, rebuilding every object it holds: the board, its grid, the
 * cell matrix, every column, every tile and every tile's position.
 *
 * @param board Board to copy. A frozen board — one of the constants in
 *   section 7 — copies to an unfrozen one.
 * @returns A fresh, unfrozen board sharing no object with `board`.
 */
export function copyBoard(board: SerializedGameState): SerializedGameState {
  return {
    grid: {
      size: board.grid.size,
      cells: copyCellMatrix(board.grid.cells),
    },
    score: board.score,
    over: board.over,
    won: board.won,
    keepPlaying: board.keepPlaying,
  };
}

/* ===== 5. The five fixtures ===== */

/**
 * An empty board: every cell `null`, score 0, and neither lost nor won.
 *
 * Cell values at size 4, row y = 0 first:
 *   .  .  .  .
 *   .  .  .  .
 *   .  .  .  .
 *   .  .  .  .
 *
 * `availableCells()` on this board returns all of its cells in
 * js/grid.js L58-L64's order, which at size 4 is (0,0) (0,1) (0,2) (0,3)
 * (1,0) (1,1) (1,2) (1,3) (2,0) (2,1) (2,2) (2,3) (3,0) (3,1) (3,2) (3,3).
 *
 * @param size Edge length in cells. Defaults to the configured board size.
 * @returns A fresh, unfrozen board.
 * @throws {RangeError} If `size` is not a safe integer of at least 1.
 *
 * @example
 * const board = createEmptyBoard();
 * const grid = new Grid(board.grid.size, board.grid.cells);
 */
export function createEmptyBoard(
  size: number = DEFAULT_BOARD_SIZE,
): SerializedGameState {
  requireBoardSize(size, MIN_EMPTY_BOARD_SIZE);

  return buildBoard(
    size,
    buildCellMatrix(size, () => null),
  );
}

/**
 * Two equal tiles side by side at the start of row 0, with every other cell
 * empty.
 *
 * Cell values at size 4, row y = 0 first:
 *   2  2  .  .
 *   .  .  .  .
 *   .  .  .  .
 *   .  .  .  .
 *
 * A left move merges the pair once, into a tile of double the value at
 * (0, 0), and a right move merges it once at (size - 1, 0). An up move
 * changes nothing, both tiles already being in row 0. A down move slides both
 * to row size - 1 without merging them, the two occupying different columns.
 *
 * @param size Edge length in cells. Defaults to the configured board size.
 * @returns A fresh, unfrozen board.
 * @throws {RangeError} If `size` is not a safe integer of at least 2.
 */
export function createMergePairBoard(
  size: number = DEFAULT_BOARD_SIZE,
): SerializedGameState {
  requireBoardSize(size, MIN_OCCUPIED_BOARD_SIZE);

  return buildBoard(
    size,
    buildCellMatrix(size, (x, y) =>
      y === 0 && x < PAIR_TILE_COUNT ? MERGE_PAIR_VALUE : null,
    ),
  );
}

/**
 * Column 0 filled top to bottom with ascending powers of two, with every
 * other cell empty.
 *
 * Cell values at size 4, row y = 0 first:
 *    2  .  .  .
 *    4  .  .  .
 *    8  .  .  .
 *   16  .  .  .
 *
 * LEFT is the fixture's blocked direction: every tile already sits in column
 * 0, so no tile changes cell, js/game_manager.js L175's `positionsEqual`
 * check never reports a change, and the `if (moved)` branch at L182 — which
 * is what spawns a tile at L183 — is skipped. Up and down are blocked as
 * well: the column is filled without a gap and no two neighbouring values are
 * equal. A right move slides all of the tiles to column size - 1 and merges
 * none of them.
 *
 * @param size Edge length in cells. Defaults to the configured board size.
 * @returns A fresh, unfrozen board.
 * @throws {RangeError} If `size` is not a safe integer of at least 2.
 */
export function createBlockedBoard(
  size: number = DEFAULT_BOARD_SIZE,
): SerializedGameState {
  requireBoardSize(size, MIN_OCCUPIED_BOARD_SIZE);

  return buildBoard(
    size,
    buildCellMatrix(size, (x, y) => (x === 0 ? 2 ** (y + 1) : null)),
  );
}

/**
 * Two tiles of half the win value side by side at the start of row 0, with
 * every other cell empty.
 *
 * Cell values at size 4 and win value 2048, row y = 0 first:
 *   1024  1024  .  .
 *      .     .  .  .
 *      .     .  .  .
 *      .     .  .  .
 *
 * The tile value is `winValue / WIN_VALUE_HALVING`, so one merge under the
 * default producer lands on `winValue` exactly and the strict comparison at
 * js/game_manager.js L170 reports the win. The highest value on the board
 * before that move is half the win value.
 *
 * @param size Edge length in cells. Defaults to the configured board size.
 * @param winValue Win value the pair merges into. Defaults to the configured
 *   win value.
 * @returns A fresh, unfrozen board.
 * @throws {RangeError} If `size` is not a safe integer of at least 2, or if
 *   `winValue` is not an even safe integer of at least 2.
 *
 * @example
 * const board = createNearWinBoard(DEFAULT_BOARD_SIZE, 512);
 * // two tiles of 256, one merge away from 512
 */
export function createNearWinBoard(
  size: number = DEFAULT_BOARD_SIZE,
  winValue: number = DEFAULT_RULES_CONFIG.winValue,
): SerializedGameState {
  requireBoardSize(size, MIN_OCCUPIED_BOARD_SIZE);
  requireWinValue(winValue);

  const tileValue = winValue / WIN_VALUE_HALVING;

  return buildBoard(
    size,
    buildCellMatrix(size, (x, y) =>
      y === 0 && x < PAIR_TILE_COUNT ? tileValue : null,
    ),
  );
}

/**
 * A full board carrying exactly one adjacent equal pair.
 *
 * Every cell holds the `CROWDED_CYCLE` entry at index
 * `(x + CROWDED_ROW_STEP * y) % CROWDED_CYCLE.length`, except cell (0, 0),
 * which holds the entry at `CROWDED_PAIR_INDEX`.
 *
 * Cell values at size 4, row y = 0 first:
 *    4   4   8  16
 *    8  16  32   2
 *   32   2   4   8
 *    4   8  16  32
 *
 * The same board in the x-outer form it serialises to: `cells[0]` is
 * 4, 8, 32, 4; `cells[1]` is 4, 16, 2, 8; `cells[2]` is 8, 32, 4, 16;
 * `cells[3]` is 16, 2, 8, 32.
 *
 * No cell is empty, so `cellsAvailable()` is false and
 * js/game_manager.js L238-L240's `cellsAvailable() || tileMatchesAvailable()`
 * falls through to the neighbour probe. That probe matches on exactly one
 * pair, (0, 0) and (1, 0), so a move remains available and the board is not
 * lost. The highest value is 32 at size 3 and above, and 16 at size 2, in
 * every case far below the default win value.
 *
 * Left and right each merge that one pair; up and down change nothing.
 *
 * @param size Edge length in cells. Defaults to the configured board size.
 * @returns A fresh, unfrozen board.
 * @throws {RangeError} If `size` is not a safe integer of at least 2.
 */
export function createNearLossBoard(
  size: number = DEFAULT_BOARD_SIZE,
): SerializedGameState {
  requireBoardSize(size, MIN_OCCUPIED_BOARD_SIZE);

  return buildBoard(
    size,
    buildCellMatrix(size, (x, y) => {
      if (x === 0 && y === 0) {
        return CROWDED_CYCLE[CROWDED_PAIR_INDEX];
      }

      return CROWDED_CYCLE[(x + CROWDED_ROW_STEP * y) % CROWDED_CYCLE.length];
    }),
  );
}

/* ===== 6. Freezing ===== */

function deepFreezeBoard(board: SerializedGameState): SerializedGameState {
  const cells = board.grid.cells;

  for (let x = 0; x < cells.length; x += 1) {
    const column = cells[x];

    for (let y = 0; y < column.length; y += 1) {
      const tile = column[y];

      if (tile !== null) {
        Object.freeze(tile.position);
        Object.freeze(tile);
      }
    }

    Object.freeze(column);
  }

  Object.freeze(cells);
  Object.freeze(board.grid);

  return Object.freeze(board);
}

/* ===== 7. Frozen boards at the configured defaults ===== */

/**
 * `createEmptyBoard()` at the configured board size, frozen at every level.
 * `copyBoard()` returns an unfrozen copy of it.
 */
export const EMPTY_BOARD: SerializedGameState = deepFreezeBoard(
  /* @__PURE__ */ createEmptyBoard(),
);

/**
 * `createMergePairBoard()` at the configured board size, frozen at every
 * level. `copyBoard()` returns an unfrozen copy of it.
 */
export const MERGE_PAIR_BOARD: SerializedGameState = deepFreezeBoard(
  /* @__PURE__ */ createMergePairBoard(),
);

/**
 * `createBlockedBoard()` at the configured board size, frozen at every level.
 * `copyBoard()` returns an unfrozen copy of it.
 */
export const BLOCKED_BOARD: SerializedGameState = deepFreezeBoard(
  /* @__PURE__ */ createBlockedBoard(),
);

/**
 * `createNearWinBoard()` at the configured board size and win value, frozen at
 * every level. `copyBoard()` returns an unfrozen copy of it.
 */
export const NEAR_WIN_BOARD: SerializedGameState = deepFreezeBoard(
  /* @__PURE__ */ createNearWinBoard(),
);

/**
 * `createNearLossBoard()` at the configured board size, frozen at every level.
 * `copyBoard()` returns an unfrozen copy of it.
 */
export const NEAR_LOSS_BOARD: SerializedGameState = deepFreezeBoard(
  /* @__PURE__ */ createNearLossBoard(),
);
