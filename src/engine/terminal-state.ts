// Win and loss evaluation, read from the rules in force rather than from a
// literal.
//
// Ported from js/game_manager.js, which is deleted: the inline win test of the
// merge branch, movesAvailable(), tileMatchesAvailable() and
// isGameTerminated(). hasReachedWinValue and highestTileValue are additions
// and are marked as such at their declarations.
//
// The win value and the board's edge length are read from the arguments at
// every call: no binding in this module holds either. The vanilla flag
// `keepPlaying` is carried as `continuedPlay` here and in
// src/engine/engine.ts; the input event name and the persisted member name
// keep the vanilla spelling.
//
// Every export is a query that mutates no grid and no tile. This module reads
// no DOM, performs no I/O, consumes no randomness, reads no clock, memoises
// nothing and reports nothing.

import type { MergeTileView, RulesConfig } from '../config/rules-config';
import type { Grid } from './grid';
import { vectorForDirection } from './move-resolver';
import type { Direction, Position } from './types';

/**
 * The directions the neighbour probe walks, in the order the vanilla probe
 * counted them: 0 up, 1 right, 2 down, 3 left. Frozen: the order is fixed for
 * every probe.
 */
const PROBE_DIRECTIONS: readonly Direction[] = Object.freeze([0, 1, 2, 3]);

/**
 * Presents a face value to the merge predicate with no merge history.
 *
 * `mergedFrom` is `null` on every view this builds. js/game_manager.js
 * L243-L268 ran between turns, after L116 had cleared `mergedFrom` on
 * every tile, so the state the predicate reads here is the state the
 * vanilla probe read.
 *
 * @param value Face value to present.
 * @returns A frozen view carrying that value and no merge history.
 */
function probeView(value: number): MergeTileView {
  return Object.freeze({ value, mergedFrom: null });
}

/**
 * The value `highestTileValue` reports for a board holding no tiles. It
 * is the empty-board reading src/config/stage-config.ts specifies for
 * `StageProgressInput.highestTileValue`.
 */
const EMPTY_BOARD_HIGHEST_VALUE = 0;

/**
 * Reports whether a face value a merge produced wins the game, by comparing
 * it against `config.winValue`, read at call time.
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
 * merge branch alone and read the flag back from the persisted snapshot, so
 * it never scanned a board for the value.
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
 * Reports whether any two adjacent tiles can merge under the rules in
 * force.
 *
 * ONE CHANGE TO THE PORTED BEHAVIOUR. L259 wrote the match test inline as
 * `other.value === tile.value`. It is `config.merge.canMerge` here, the
 * same member src/engine/move-resolver.ts resolves a merge through, read
 * off the argument at every probe. Both tiles reach it as
 * `probeView` projections, so the predicate sees the face values
 * L259 compared and the cleared merge state L113-L120 produced; under the
 * default predicate in src/config/default-config.ts the two tests agree
 * for every pair.
 *
 * The walked tile is the moving operand and the probed neighbour the
 * target, which is the operand order src/engine/move-resolver.ts passes
 * at its merge branch. Each adjacent pair is probed twice, once from each
 * of its two cells, which is what L253's per-cell walk over all four
 * directions did, so an asymmetric predicate is asked both ways.
 *
 * Each probe steps one cell off the walked cell, so along every edge it
 * addresses a cell outside the lattice. `Grid.cellContent` returns `null` for
 * such a cell rather than raising, and the probe relies on that valve and
 * adds no bounds test of its own.
 *
 * The comparison reads face values alone and reads no merge state: a tile
 * whose `mergedFrom` is set counts as a match. Each adjacent pair is probed
 * twice, once from each of its two cells. `grid.size` is read at call time.
 */
export function tileMatchesAvailable(
  grid: Grid,
  config: RulesConfig,
): boolean {
  for (let x = 0; x < grid.size; x += 1) {
    for (let y = 0; y < grid.size; y += 1) {
      const tile = grid.cellContent({ x, y });

      if (tile) {
        for (const direction of PROBE_DIRECTIONS) {
          const vector = vectorForDirection(direction);
          const cell: Position = { x: x + vector.x, y: y + vector.y };
          const other = grid.cellContent(cell);

          if (
            other &&
            config.merge.canMerge(probeView(tile.value), probeView(other.value))
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
 * Reports whether any move can still change the board:
 * `cellsAvailable() || tileMatchesAvailable()`. The operands keep their order
 * and the `||` keeps its short circuit, so the neighbour probe runs only when
 * no cell is empty.
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
   * held as `keepPlaying`, which src/engine/engine.ts carries under this
   * name.
   */
  readonly continuedPlay: boolean;
}

/**
 * Reports whether the engine refuses further moves:
 * `over || (won && !continuedPlay)`, the vanilla expression unchanged.
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
