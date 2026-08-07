// Win and loss evaluation, read from the rules in force rather than from
// a literal.
//
// Ported from js/game_manager.js, which is deleted:
//   L170      the win test the merge branch performed inline
//   L238-L240 movesAvailable()
//   L243-L268 tileMatchesAvailable()
//   L30-L32   isGameTerminated()
//
// Two exports have no vanilla source and are marked as additions at their
// declarations: hasReachedWinValue and highestTileValue.
//
// The win value and the board's edge length are read from the arguments
// at every call. No binding in this module holds either: the win value is
// read through the `config` argument as `RulesConfig.winValue`, and the
// edge length through the live `Grid.size`, which is what
// js/game_manager.js L248-L249 did by rereading `this.size` on each
// check.
//
// L31 read `this.keepPlaying`: the boolean L25 assigned over the
// prototype method of the same name declared at L24.
// src/engine/engine.ts carries that boolean as `continuedPlay`, and
// `TerminalStateInput` below names it the same. Two other uses of the
// vanilla name are unchanged — the input event name at L11 and the
// persisted member name at L108.
//
// Invariants of this module: every export is a query that mutates no grid
// and no tile, and it names no engine module other than the imports
// below, reads no DOM, performs no I/O, consumes no randomness, reads no
// clock, memoises nothing and reports nothing.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import type { RulesConfig } from '../config/rules-config';
import type { Grid } from './grid';
import { vectorForDirection } from './move-resolver';
import type { Direction, Position } from './types';

/**
 * The directions the neighbour probe walks, in the order
 * js/game_manager.js L253 counted them: 0 up, 1 right, 2 down, 3 left.
 * Frozen: the order is fixed for every probe.
 */
const PROBE_DIRECTIONS: readonly Direction[] = Object.freeze([0, 1, 2, 3]);

/**
 * The value `highestTileValue` reports for a board holding no tiles. It
 * is the empty-board reading src/config/stage-config.ts specifies for
 * `StageProgressInput.highestTileValue`.
 */
const EMPTY_BOARD_HIGHEST_VALUE = 0;

/* --------------------------------------------------------------------------
 * Win evaluation
 * ----------------------------------------------------------------------- */

/**
 * Reports whether a face value a merge produced wins the game.
 *
 * Ported from js/game_manager.js L170, which compared the merged tile's
 * face value against a literal with `===` and set the win flag on a
 * match. The comparison is carried over unchanged; the literal L170
 * carried is `DEFAULT_WIN_VALUE` in src/config/default-config.ts and
 * reaches this function through `config.winValue`, read at call time.
 *
 * The comparison is equality and not a threshold: a value above
 * `config.winValue` is not a winning value.
 *
 * @param resultValue Face value a merge produced.
 * @param config Rules in force.
 * @returns `true` when `resultValue` equals `config.winValue`.
 *
 * @example
 * isWinningMergeValue(config.winValue, config); // true
 * isWinningMergeValue(config.winValue / 2, config); // false
 */
export function isWinningMergeValue(
  resultValue: number,
  config: RulesConfig,
): boolean {
  return resultValue === config.winValue;
}

/**
 * Reports whether any tile on the board carries the win value.
 *
 * ADDITION — no vanilla source. js/game_manager.js evaluated the win in
 * the merge branch alone (L170) and read the flag back from the persisted
 * snapshot on setup (L44), so it never scanned a board for the value.
 *
 * The scan is x-outer and y-inner, the cell order of js/grid.js L58-L64,
 * it reads each cell through `cellContent`, and it returns at the first
 * tile carrying the value.
 *
 * @param grid Board to scan. Its `size` is read at call time.
 * @param config Rules in force.
 * @returns `true` when at least one tile's value equals
 *   `config.winValue`, and `false` for a board holding no tiles.
 *
 * @example
 * hasReachedWinValue(grid, config);
 */
export function hasReachedWinValue(
  grid: Grid,
  config: RulesConfig,
): boolean {
  for (let x = 0; x < grid.size; x += 1) {
    for (let y = 0; y < grid.size; y += 1) {
      const tile = grid.cellContent({ x, y });

      if (tile && isWinningMergeValue(tile.value, config)) {
        return true;
      }
    }
  }

  return false;
}

/* --------------------------------------------------------------------------
 * Loss evaluation
 * ----------------------------------------------------------------------- */

/**
 * Reports whether any two adjacent tiles carry equal face values.
 *
 * Ported from js/game_manager.js L243-L268. Every element is carried
 * over: the x-outer, y-inner walk over the board's edge length
 * (L248-L249), the read through `cellContent` (L250), the walk of all
 * four directions from each occupied cell (L253-L255), the return at the
 * first match (L259-L260), and the fall-through `false` after both loops
 * (L267).
 *
 * Each probe steps one cell off the walked cell, so along every edge it
 * addresses a cell outside the lattice. js/grid.js L80-L86 returns `null`
 * for such a cell rather than raising, and src/engine/grid.ts's
 * `cellContent` carries that valve forward; the probe below reads it and
 * adds no bounds test of its own.
 *
 * The comparison reads face values alone, as L259 did, and reads no merge
 * state: a tile whose `mergedFrom` is set counts as a match.
 *
 * Each adjacent pair is probed twice, once from each of its two cells,
 * which is what L253's per-cell walk over all four directions did.
 *
 * @param grid Board to probe. Its `size` is read at call time.
 * @returns `true` when at least one adjacent pair carries equal face
 *   values.
 *
 * @example
 * tileMatchesAvailable(grid);
 */
export function tileMatchesAvailable(grid: Grid): boolean {
  for (let x = 0; x < grid.size; x += 1) {
    for (let y = 0; y < grid.size; y += 1) {
      const tile = grid.cellContent({ x, y });

      if (tile) {
        for (const direction of PROBE_DIRECTIONS) {
          const vector = vectorForDirection(direction);
          const cell: Position = { x: x + vector.x, y: y + vector.y };
          const other = grid.cellContent(cell);

          if (other && other.value === tile.value) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

/**
 * Reports whether any move can still change the board.
 *
 * Ported from js/game_manager.js L238-L240,
 * `return this.grid.cellsAvailable() || this.tileMatchesAvailable();`.
 * The operands keep their order and the `||` keeps its short circuit: the
 * emptiness test runs first, and the neighbour probe runs only when no
 * cell is empty.
 *
 * @param grid Board to test.
 * @returns `true` when a move is available, and `false` when the board is
 *   full and carries no adjacent equal pair.
 *
 * @example
 * movesAvailable(grid);
 */
export function movesAvailable(grid: Grid): boolean {
  return grid.cellsAvailable() || tileMatchesAvailable(grid);
}

/* --------------------------------------------------------------------------
 * Terminal state
 * ----------------------------------------------------------------------- */

/**
 * The three flags a terminal-state verdict is read from.
 *
 * The members are the three js/game_manager.js L31 read off the game
 * manager, carried as one object rather than read off an instance. All
 * three are readonly: the verdict reads them and writes none.
 */
export interface TerminalStateInput {
  /** Whether the game is lost. Ported from L31's `this.over`. */
  readonly over: boolean;

  /**
   * Whether the win value has been reached. Ported from L31's
   * `this.won`.
   */
  readonly won: boolean;

  /**
   * Whether play continued past the win. This is the boolean
   * js/game_manager.js L25 assigned as `this.keepPlaying` and L31 read,
   * which src/engine/engine.ts carries under this name.
   */
  readonly continuedPlay: boolean;
}

/**
 * Reports whether the engine refuses further moves.
 *
 * Ported from js/game_manager.js L30-L32,
 * `return this.over || (this.won && !this.keepPlaying);`. The expression
 * is carried over unchanged, with `state.continuedPlay` in place of the
 * flag L31 read.
 *
 * @param state The three flags the verdict is read from.
 * @returns `true` when the game is lost, or is won and play has not
 *   continued.
 *
 * @example
 * isGameTerminated({ over: false, won: true, continuedPlay: false });
 * // true
 * isGameTerminated({ over: false, won: true, continuedPlay: true });
 * // false
 */
export function isGameTerminated(state: TerminalStateInput): boolean {
  return state.over || (state.won && !state.continuedPlay);
}

/* --------------------------------------------------------------------------
 * Board reading
 * ----------------------------------------------------------------------- */

/**
 * Reads the highest face value on the board.
 *
 * ADDITION — no vanilla source. js/game_manager.js tracked no such
 * value. It is the quantity src/config/stage-config.ts evaluates a
 * `'highest-tile'` goal against, through
 * `StageProgressInput.highestTileValue`.
 *
 * The walk is `Grid.eachCell`, x-outer and y-inner, the cell order of
 * js/grid.js L58-L64.
 *
 * @param grid Board to read. `eachCell` reads its `size` at call time.
 * @returns The highest face value on the board, and 0 for a board holding
 *   no tiles.
 *
 * @example
 * highestTileValue(grid);
 */
export function highestTileValue(grid: Grid): number {
  let highest = EMPTY_BOARD_HIGHEST_VALUE;

  grid.eachCell((_x, _y, tile) => {
    if (tile && tile.value > highest) {
      highest = tile.value;
    }
  });

  return highest;
}
