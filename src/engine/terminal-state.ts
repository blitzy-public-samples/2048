// Win and loss evaluation, read from the configured rules rather than
// from a literal.
//
// Ported from js/game_manager.js, which is deleted:
//   js/game_manager.js L170      the win test, `merged.value === 2048`
//   js/game_manager.js L238-L240 movesAvailable()
//   js/game_manager.js L243-L268 tileMatchesAvailable()
//   js/game_manager.js L30-L32   isGameTerminated()
//
// Two properties of the vanilla checks are preserved deliberately:
//
//   The win test is strict equality against one value, not a threshold.
//   L170 fired only on a merge that produced exactly 2048, so a board
//   that reaches a higher value without ever producing the win value
//   does not win. The value comes from `RulesConfig.winValue`.
//
//   The neighbour probe compares values only. L259 tested
//   `other.value === tile.value` and read no merge state, so a tile that
//   merged earlier in the same turn still counts as a match. The probe
//   below reaches the configured predicate with `mergedFrom: null` on
//   both operands, which is config-driven and evaluates to exactly that
//   comparison under the default rule.
//
// Invariants of this module: it names no engine module other than the
// type-only imports below, reads no DOM, performs no I/O, consumes no
// randomness and reads no clock.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import type { MergeTileView, RulesConfig } from '../config/rules-config';
import type { Grid } from './grid';
import { vectorForDirection } from './move-resolver';
import type { Direction, Position } from './types';

/**
 * The four directions the neighbour probe walks, in the order
 * js/game_manager.js L253 iterated them.
 */
const PROBE_DIRECTIONS: readonly Direction[] = Object.freeze([0, 1, 2, 3]);

/**
 * Builds the merge-rule view of a tile value with no merge history.
 *
 * The probe asks whether two values could merge, not whether they may
 * merge this turn, so both operands are presented with `mergedFrom`
 * cleared. Under `defaultCanMerge` — equal value and an unmerged
 * target — this reduces to the value comparison js/game_manager.js L259
 * performed.
 *
 * @param value Face value to present.
 * @returns A frozen view carrying that value and no merge history.
 */
function probeView(value: number): MergeTileView {
  return Object.freeze({ value, mergedFrom: null });
}

/**
 * Reports whether a produced value wins the game.
 *
 * Ported from js/game_manager.js L170. Strict equality, against the
 * configured win value read at call time.
 *
 * @param value Face value a merge produced.
 * @param config Rules in force.
 * @returns `true` when the value is the win value.
 *
 * @example
 * isWinningValue(2048, config); // true under the default rules
 */
export function isWinningValue(value: number, config: RulesConfig): boolean {
  return value === config.winValue;
}

/**
 * Reports whether any two adjacent tiles could merge.
 *
 * Ported from js/game_manager.js L243-L268, including its short-circuit:
 * the first match found returns immediately, so the worst case is one
 * probe of all four neighbours of every cell.
 *
 * @param grid Board to probe.
 * @param config Rules whose merge predicate decides a match.
 * @returns `true` when at least one adjacent pair could merge.
 */
export function tileMatchesAvailable(
  grid: Grid,
  config: RulesConfig,
): boolean {
  for (let x = 0; x < grid.size; x += 1) {
    for (let y = 0; y < grid.size; y += 1) {
      const tile = grid.cellContent({ x, y });

      if (!tile) {
        continue;
      }

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

  return false;
}

/**
 * Reports whether any move can still change the board.
 *
 * Ported from js/game_manager.js L238-L240: an empty cell is enough, and
 * only a full board pays for the neighbour probe.
 *
 * @param grid Board to test.
 * @param config Rules whose merge predicate decides a match.
 * @returns `true` when a move is available.
 */
export function movesAvailable(grid: Grid, config: RulesConfig): boolean {
  return grid.cellsAvailable() || tileMatchesAvailable(grid, config);
}

/**
 * Reports whether play is blocked pending an acknowledgement.
 *
 * Ported from js/game_manager.js L30-L32,
 * `return this.over || (this.won && !this.keepPlaying);`. The third
 * argument is the continued-play flag, which
 * src/engine/engine.ts carries under a name of its own; the persisted
 * member name `keepPlaying` is unchanged by that.
 *
 * @param over Whether the game is lost.
 * @param won Whether the win value has been reached.
 * @param continuedPlay Whether play continued past the win.
 * @returns `true` when the engine refuses further moves.
 */
export function isTerminated(
  over: boolean,
  won: boolean,
  continuedPlay: boolean,
): boolean {
  return over || (won && !continuedPlay);
}

/**
 * Reads the highest face value on the board.
 *
 * Has no vanilla analogue: js/game_manager.js tracked no such value. It
 * is what src/config/stage-config.ts's `'highest-tile'` goal is
 * evaluated against.
 *
 * @param grid Board to read.
 * @returns The highest face value, or 0 on an empty board.
 */
export function highestTileValue(grid: Grid): number {
  let highest = 0;

  grid.eachCell((_x, _y, tile) => {
    if (tile && tile.value > highest) {
      highest = tile.value;
    }
  });

  return highest;
}
