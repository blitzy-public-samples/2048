// Direction vectors, traversal ordering, the farthest-position walk,
// merge resolution and the position comparison a move's outcome is read
// from.
//
// Ported from js/game_manager.js, which is deleted. Every line number
// below is that file's:
//   L113-L120 prepareTiles()         -> prepareTiles()
//   L123-L127 moveTile()             -> moveTile()
//   L138-L143 vector, traversals and -> resolveMove()
//             the prepareTiles call
//   L146-L180 traversal walk and     -> resolveMove()
//             merge branch
//   L194-L204 getVector()            -> vectorForDirection()
//   L207-L220 buildTraversals()      -> buildTraversals()
//   L222-L236 findFarthestPosition() -> findFarthestPosition()
//   L270-L272 positionsEqual()       -> positionsEqual()
//
// The traversal reversal is preserved exactly: the x order is reversed
// when the vector's x is 1 and the y order when its y is 1 (L216-L217),
// so tiles are always visited from the farthest cell in the direction of
// travel. The walk terminates on the bounds valve of
// src/engine/grid.ts's `cellContent`, exactly as L229-L230 did.
//
// THREE CHANGES TO THE PORTED BEHAVIOUR
//   The merge condition L156 wrote as
//   `next && next.value === tile.value && !next.mergedFrom` is split:
//   the `next &&` existence guard stays in this module and the two
//   remaining tests are `config.merge.canMerge`. The face value L157
//   wrote as `tile.value * 2` is `config.merge.produce`.
//
//   The `onMerge` transformation reaches the merge branch through the
//   callback `resolveMove` takes in its options, which defaults to
//   `identityMergeDispatch`. This module names no hook bus.
//
//   The win test L170 wrote inline, as a strict comparison of the merged
//   tile's value against a literal, is not performed here.
//   `MoveOutcome.merges` carries every tile a merge produced, and
//   src/engine/terminal-state.ts compares those values against
//   `RulesConfig.winValue`.
//
// The post-move branch L182-L190 — the spawn, the loss check and the
// actuation — is not performed here either: it belongs to
// src/engine/engine.ts.
//
// Invariants of this module: it names no engine module other than ./tile
// and the type-only imports below, reads no DOM, performs no I/O,
// consumes no randomness and reads no clock. Importing it defines
// functions and freezes the vector table, and does nothing else.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import type { RulesConfig } from '../config/rules-config';
import type { Grid } from './grid';
import type { MergePayload } from './hooks';
import { Tile } from './tile';
import type { Direction, Position, Vector } from './types';

/* --------------------------------------------------------------------------
 * Direction vectors
 * ----------------------------------------------------------------------- */

/**
 * The four movement vectors, keyed by direction.
 *
 * Ported verbatim from the map at js/game_manager.js L196-L201. Frozen,
 * and every returned vector is frozen, so a caller cannot mutate the
 * table a later move reads.
 */
const VECTORS: Readonly<Record<Direction, Vector>> = Object.freeze({
  0: Object.freeze({ x: 0, y: -1 }),
  1: Object.freeze({ x: 1, y: 0 }),
  2: Object.freeze({ x: 0, y: 1 }),
  3: Object.freeze({ x: -1, y: 0 }),
});

/**
 * Resolves a direction to its movement vector.
 *
 * Ported from js/game_manager.js L194-L204.
 *
 * @param direction Direction to resolve: 0 up, 1 right, 2 down, 3 left.
 * @returns The frozen vector for that direction.
 *
 * @example
 * vectorForDirection(0); // { x: 0, y: -1 }
 */
export function vectorForDirection(direction: Direction): Vector {
  return VECTORS[direction];
}

/* --------------------------------------------------------------------------
 * Traversal ordering
 * ----------------------------------------------------------------------- */

/**
 * The cell orders one move visits, per axis.
 *
 * Ported from the object js/game_manager.js L208 builds.
 */
export interface Traversals {
  /** Column indices, in visit order. */
  readonly x: readonly number[];

  /** Row indices, in visit order. */
  readonly y: readonly number[];
}

/**
 * Builds the cell orders one move visits.
 *
 * Ported from js/game_manager.js L207-L220, including the two
 * reversals at L216-L217. `size` is read at call time, which is what
 * L210 did by rereading `this.size` on every move.
 *
 * @param vector Vector of the move in progress.
 * @param size Edge length in cells of the board being traversed.
 * @returns The visit order for each axis.
 *
 * @example
 * buildTraversals({ x: 1, y: 0 }, 4); // { x: [3, 2, 1, 0], y: [0, 1, 2, 3] }
 */
export function buildTraversals(vector: Vector, size: number): Traversals {
  const x: number[] = [];
  const y: number[] = [];

  for (let pos = 0; pos < size; pos += 1) {
    x.push(pos);
    y.push(pos);
  }

  return {
    x: vector.x === 1 ? x.reverse() : x,
    y: vector.y === 1 ? y.reverse() : y,
  };
}

/* --------------------------------------------------------------------------
 * Farthest-position walk
 * ----------------------------------------------------------------------- */

/**
 * The two positions the farthest-position walk yields.
 *
 * Ported from the object js/game_manager.js L232-L235 returns.
 */
export interface FarthestPosition {
  /** Last empty cell reached before the obstacle. */
  readonly farthest: Position;

  /**
   * The cell beyond `farthest`, which is where a merge candidate would
   * sit. May lie outside the lattice, in which case
   * `Grid.cellContent` reads it as empty.
   */
  readonly next: Position;
}

/**
 * Walks from a cell along a vector until an obstacle is reached.
 *
 * Ported from js/game_manager.js L222-L236. The loop advances while the
 * next cell is both within bounds and empty, so it stops on the board
 * edge or on the first occupied cell; `next` is that stopping cell and
 * `farthest` is the last empty one before it. Each step allocates a
 * fresh position, as L228 did, so `farthest` never aliases `next`.
 *
 * @param grid Board being walked.
 * @param cell Cell the walk starts from.
 * @param vector Direction of travel.
 * @returns The farthest empty cell and the cell beyond it.
 */
export function findFarthestPosition(
  grid: Grid,
  cell: Position,
  vector: Vector,
): FarthestPosition {
  let previous: Position = cell;
  let candidate: Position = cell;

  do {
    previous = candidate;
    candidate = { x: previous.x + vector.x, y: previous.y + vector.y };
  } while (grid.withinBounds(candidate) && grid.cellAvailable(candidate));

  return {
    farthest: previous,
    next: candidate,
  };
}

/* --------------------------------------------------------------------------
 * Position comparison
 * ----------------------------------------------------------------------- */

/**
 * Reports whether two positions name the same cell.
 *
 * Ported from js/game_manager.js L270-L272. This comparison is the sole
 * signal that a move changed the board: L175 applied it to a tile's
 * starting cell and its cell after resolution. A `Tile` satisfies the
 * parameter type, which is how L175 passed one: js/tile.js L2-L3
 * flattened a position onto `x` and `y`.
 *
 * @param first First position.
 * @param second Second position.
 * @returns `true` when both coordinates are equal.
 */
export function positionsEqual(
  first: Position,
  second: Position,
): boolean {
  return first.x === second.x && first.y === second.y;
}

/* --------------------------------------------------------------------------
 * Tile preparation and relocation
 * ----------------------------------------------------------------------- */

/**
 * Records every tile's cell and clears its merge history.
 *
 * Ported from js/game_manager.js L113-L120, including the order of the
 * two writes: `mergedFrom` is cleared first (L116) and the position is
 * recorded second (L117). The iteration is `Grid.eachCell`, so tiles are
 * visited in the x-outer, y-inner order of js/grid.js L58-L64.
 *
 * @param grid Board whose tiles are prepared. Mutated in place.
 *
 * @example
 * prepareTiles(grid);
 * // every tile now: mergedFrom === null, previousPosition === its cell
 */
export function prepareTiles(grid: Grid): void {
  grid.eachCell((_x: number, _y: number, tile: Tile | null) => {
    if (tile) {
      tile.mergedFrom = null;
      tile.savePosition();
    }
  });
}

/**
 * Moves a tile to a cell, in the lattice and on the tile.
 *
 * Ported from js/game_manager.js L123-L127, in that order: the cell the
 * tile is leaving is cleared through the tile's own coordinates (L124),
 * which are still its pre-move ones, the destination cell is written
 * second (L125), and the tile's coordinates are updated last (L126).
 *
 * @param grid Board holding the tile. Mutated in place.
 * @param tile Tile to move. Mutated in place.
 * @param cell Cell to move it to. Read only; not retained.
 */
export function moveTile(grid: Grid, tile: Tile, cell: Position): void {
  grid.cells[tile.x][tile.y] = null;
  grid.cells[cell.x][cell.y] = tile;
  tile.updatePosition(cell);
}

/* --------------------------------------------------------------------------
 * Merge dispatch
 * ----------------------------------------------------------------------- */

/**
 * Transforms one `onMerge` payload inside the merge branch, before the
 * merged tile is written to the board.
 *
 * src/engine/engine.ts supplies a closure over its hook bus. A caller
 * with no relic machinery supplies nothing, and `resolveMove` uses
 * `identityMergeDispatch`.
 *
 * @param payload The merge as `resolveMove` assembled it.
 * @returns The payload the merge resolves with. `resolveMove` reads
 *   `resultValue` and `scoreDelta` back from it and nothing else.
 */
export type MergeDispatch = (payload: MergePayload) => MergePayload;

/**
 * The `MergeDispatch` `resolveMove` uses when none is supplied: returns
 * its argument unchanged, so the merge resolves on the values
 * `config.merge.produce` yielded.
 *
 * @param payload The merge as `resolveMove` assembled it.
 * @returns `payload`, the same object.
 */
export function identityMergeDispatch(payload: MergePayload): MergePayload {
  return payload;
}

/* --------------------------------------------------------------------------
 * Move outcome
 * ----------------------------------------------------------------------- */

/**
 * One merge a move resolved.
 *
 * Ported from the three tiles js/game_manager.js L156-L167 held at once:
 * the moving tile, the tile it ran into and the tile L157 built from the
 * pair. `source` and `target` are the pair L158 recorded as
 * `mergedFrom`, and both are out of the lattice by L161.
 */
export interface ResolvedMerge {
  /** The live tile that moved into the target's cell. */
  readonly source: Tile;

  /** The live tile that was already occupying the destination cell. */
  readonly target: Tile;

  /**
   * The live tile the merge produced, which is the tile now in the
   * destination cell. Its `value` is the produced face value after the
   * coercion js/tile.js L4 applies to a falsy one.
   */
  readonly merged: Tile;

  /** Amount this merge added to `MoveOutcome.scoreDelta`. */
  readonly scoreDelta: number;
}

/**
 * What one resolved move changed.
 *
 * `moved` is the flag js/game_manager.js L175-L177 set, `scoreDelta` is
 * the sum of the additions L167 made, and `merges` carries every merge
 * the move resolved, in the order the traversal reached them.
 */
export interface MoveOutcome {
  /** Whether any tile ended the move in a different cell. */
  readonly moved: boolean;

  /** Total the move adds to the score. `0` when nothing merged. */
  readonly scoreDelta: number;

  /** Every merge resolved, in traversal order. Empty when none was. */
  readonly merges: readonly ResolvedMerge[];
}

/** The optional collaborators `resolveMove` accepts. */
export interface ResolveMoveOptions {
  /**
   * Transforms each merge before the merged tile is written to the
   * board. Defaults to `identityMergeDispatch`.
   */
  readonly dispatchMerge?: MergeDispatch;
}

/* --------------------------------------------------------------------------
 * Move resolution
 * ----------------------------------------------------------------------- */

/**
 * Resolves one move: prepares the tiles, then walks the traversal orders
 * and either merges or slides each tile it reaches.
 *
 * Ported from js/game_manager.js L138-L143 and L146-L180. The board and
 * its tiles are mutated in place, which is what those lines did, and
 * nothing else is touched: no tile is spawned, no terminal state is
 * evaluated, nothing is committed or persisted and no event is emitted.
 * Those are L182-L190 and belong to src/engine/engine.ts.
 *
 * `grid.size` and `config.merge` are read on every call, so a board size
 * or a merge rule changed during a run takes effect on the next move.
 *
 * @param grid Board to resolve the move on. Mutated in place.
 * @param direction Direction to move in: 0 up, 1 right, 2 down, 3 left.
 * @param config Rules in force for this move; `merge.canMerge` and
 *   `merge.produce` are read from it.
 * @param options Optional collaborators.
 * @returns What the move changed.
 *
 * @example
 * const outcome = resolveMove(grid, 3, config);
 * outcome.moved; // false when every tile kept its cell
 */
export function resolveMove(
  grid: Grid,
  direction: Direction,
  config: RulesConfig,
  options: ResolveMoveOptions = {},
): MoveOutcome {
  // Ported from L138-L140.
  const vector = vectorForDirection(direction);
  const traversals = buildTraversals(vector, grid.size);
  const dispatchMerge = options.dispatchMerge ?? identityMergeDispatch;

  const merges: ResolvedMerge[] = [];
  let moved = false;
  let scoreDelta = 0;

  // Ported from L143.
  prepareTiles(grid);

  // Ported from L146-L147: the two traversal orders, x on the outer loop
  // and y on the inner, each already reversed where the vector requires
  // it.
  for (const x of traversals.x) {
    for (const y of traversals.y) {
      // Ported from L148-L149.
      const cell: Position = { x, y };
      const tile = grid.cellContent(cell);

      // Ported from L151: an empty cell is skipped.
      if (!tile) {
        continue;
      }

      // Ported from L152-L153. `positions.next` may lie outside the
      // lattice, and `cellContent` reads it as `null`.
      const positions = findFarthestPosition(grid, cell, vector);
      const next = grid.cellContent(positions.next);

      // Ported from L156. The existence guard is L156's own `next &&`;
      // its two remaining tests are `config.merge.canMerge`.
      if (next && config.merge.canMerge(tile, next)) {
        // Ported from L157: the face value the merge yields, taken once.
        const produced = config.merge.produce(tile, next);

        // The payload carries that value as both the result and the
        // score addition L167 made, and is dispatched before the merged
        // tile is built.
        const resolved = dispatchMerge({
          source: tile,
          target: next,
          resultValue: produced,
          scoreDelta: produced,
        });

        // Ported from L157-L158.
        const merged = new Tile(positions.next, resolved.resultValue);

        merged.mergedFrom = [tile, next];

        // Ported from L160-L161: the merged tile overwrites the
        // target's cell first, and the moving tile's own cell is
        // cleared second, through its pre-move coordinates.
        grid.insertTile(merged);
        grid.removeTile(tile);

        // Ported from L164: the two tiles' positions converge.
        tile.updatePosition(positions.next);

        // Ported from L167.
        scoreDelta += resolved.scoreDelta;

        merges.push({
          source: tile,
          target: next,
          merged,
          scoreDelta: resolved.scoreDelta,
        });
      } else {
        // Ported from L172.
        moveTile(grid, tile, positions.farthest);
      }

      // Ported from L175-L177: the sole signal that the board changed.
      if (!positionsEqual(cell, tile)) {
        moved = true;
      }
    }
  }

  return {
    moved,
    scoreDelta,
    merges,
  };
}
