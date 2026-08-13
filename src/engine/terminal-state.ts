// Win and loss evaluation, read from the rules in force rather than from a
// literal.
//
// Ported from js/game_manager.js, which is deleted: the inline win test of the
// merge branch, movesAvailable, tileMatchesAvailable and isGameTerminated.
// hasReachedWinValue and highestTileValue are additions and are marked as such
// at their declarations.
//
// Every export is a query that mutates no grid and no tile. This module reads
// no DOM, performs no I/O, consumes no randomness, reads no clock, memoises
// nothing and reports nothing.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
// this module's area enumerated:
//   TR-TERM-01  js/game_manager.js L170      the win test the merge branch
//                                            performed inline
//   TR-TERM-02  js/game_manager.js L238-L240 movesAvailable()
//   TR-TERM-03  js/game_manager.js L243-L268 tileMatchesAvailable()
//   TR-TERM-04  js/game_manager.js L30-L32   isGameTerminated()
//   TR-TERM-05  hasReachedWinValue           target-only row
//   TR-TERM-06  highestTileValue             target-only row
//
// Decisions: DL-TERM-01, DL-TERM-02, DL-TERM-03, DL-TERM-04, DL-TERM-05
// (docs/DECISION_LOG.md).

import type { MergeTileView, RulesConfig } from '../config/rules-config';
import type { Grid } from './grid';
import { vectorForDirection } from './move-resolver';
import type { Direction, Position } from './types';

/**
 * The directions the neighbour probe walks, in the order the vanilla probe
 * counted them: 0 up, 1 right, 2 down, 3 left.
 */
const PROBE_DIRECTIONS: readonly Direction[] = Object.freeze([0, 1, 2, 3]);

/**
 * A probed operand: the face value the merge predicate reads, with no merge
 * history, AND the cell the probed tile stands in.
 *
 * The cell is what a POSITION-AWARE merge predicate reads. `resolveMove` of
 * ./move-resolver.ts hands the predicate live `Tile` instances, which carry
 * `x` and `y`, so a probe that omits them presents a shape the resolved move
 * never presents.
 */
interface ProbeTileView extends MergeTileView {
  /** Column the probed tile stands in. */
  readonly x: number;

  /** Row the probed tile stands in. */
  readonly y: number;
}

/**
 * Presents a face value and its cell to the merge predicate with no merge
 * history.
 *
 * The view carries the cell as well as the value, so it is the operand shape
 * `resolveMove` presents and a predicate keyed on position answers the probe
 * from its rule rather than from a no-position fall-through. DL-TERM-05.
 *
 * @param value Face value to present.
 * @param cell Cell the probed tile stands in.
 * @returns A frozen view carrying that value, that cell and no merge history.
 */
function probeView(value: number, cell: Position): ProbeTileView {
  return Object.freeze({ value, mergedFrom: null, x: cell.x, y: cell.y });
}

/** The value `highestTileValue` reports for a board holding no tiles. */
const EMPTY_BOARD_HIGHEST_VALUE = 0;

/**
 * Reports whether a face value a merge produced wins the game, by comparing it
 * against `config.winValue`, read at call time.
 *
 * The comparison is EQUALITY and not a threshold: a value above
 * `config.winValue` is not a winning value, which is what the vanilla merge
 * branch tested with `===`.
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
 * ADDITION — no vanilla source: the vanilla game evaluated the win in the
 * merge branch alone and read the flag back from the persisted snapshot, so it
 * never scanned a board for the value.
 *
 * The scan is x-outer and y-inner, reads each cell through `cellContent`, and
 * returns at the first tile carrying the value. A board holding no tiles
 * reports `false`. `grid.size` is read at call time.
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

/**
 * Reports whether any two adjacent tiles can merge under the rules in force.
 *
 * `grid.size` is read at call time.
 */
export function tileMatchesAvailable(
  grid: Grid,
  config: RulesConfig,
): boolean {
  for (let x = 0; x < grid.size; x += 1) {
    for (let y = 0; y < grid.size; y += 1) {
      const tile = grid.cellContent({ x, y });

      if (tile) {
        const origin: Position = { x, y };

        for (const direction of PROBE_DIRECTIONS) {
          const vector = vectorForDirection(direction);
          const cell: Position = { x: x + vector.x, y: y + vector.y };
          const other = grid.cellContent(cell);

          if (
            other &&
            // Operand ORDER is the resolved move's own: the probed tile is the
            // one that would move and the neighbour is the one it would run
            // into, so a predicate that distinguishes the two — one keyed on
            // the DESTINATION cell does — is asked the same question the walk
            // would ask. Each operand carries its own cell. DL-TERM-05.
            config.merge.canMerge(
              probeView(tile.value, origin),
              probeView(other.value, cell),
            )
          ) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

/**
 * Reports whether any move can still change the board: `cellsAvailable ||
 * tileMatchesAvailable`.
 */
export function movesAvailable(grid: Grid, config: RulesConfig): boolean {
  return grid.cellsAvailable() || tileMatchesAvailable(grid, config);
}

/**
 * The three flags a terminal-state verdict is read from, carried as one object
 * rather than read off an instance. All three are readonly: the verdict reads
 * them and writes none.
 */
export interface TerminalStateInput {
  readonly over: boolean;
  readonly won: boolean;

  /**
   * Whether play continued past the win. This is the boolean the vanilla game
   * held as `keepPlaying`, which src/engine/engine.ts carries under this name.
   */
  readonly continuedPlay: boolean;
}

/**
 * Reports whether the engine refuses further moves: `over || (won &&
 * !continuedPlay)`, the vanilla expression unchanged.
 */
export function isGameTerminated(state: TerminalStateInput): boolean {
  return state.over || (state.won && !state.continuedPlay);
}

/**
 * Reads the highest face value on the board, and 0 for a board holding no
 * tiles.
 *
 * ADDITION — no vanilla source. It is the quantity src/config/stage-config.ts
 * evaluates a `'highest-tile'` goal against, through
 * `StageProgressInput.highestTileValue`. The walk is `Grid.eachCell`, x-outer
 * and y-inner, which reads `grid.size` at call time.
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
