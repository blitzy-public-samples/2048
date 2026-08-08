// Move resolution: direction vectors, traversal ordering, the
// farthest-position walk, tile preparation and the merge branch.
//
// Ported from js/game_manager.js, which is deleted: prepareTiles(), moveTile(),
// getVector(), buildTraversals(), findFarthestPosition(), positionsEqual() and
// the traversal walk with its merge branch.
//
// docs/TRACEABILITY_MATRIX.md:
//   TR-MOVE-01  L113-L120 prepareTiles()         -> prepareTiles()
//   TR-MOVE-02  L123-L127 moveTile()             -> moveTile()
//   TR-MOVE-03  L138-L143 vector, traversals and -> resolveMove()
//   TR-MOVE-04  L146-L180 traversal walk and     -> resolveMove()
//   TR-MOVE-05  L194-L204 getVector()            -> vectorForDirection()
//   TR-MOVE-06  L207-L220 buildTraversals()      -> buildTraversals()
//   TR-MOVE-07  L222-L236 findFarthestPosition() -> findFarthestPosition()
//   TR-MOVE-08  L270-L272 positionsEqual()       -> positionsEqual()
//
// The traversal reversal is preserved exactly: the x order is reversed when
// the vector's x is 1 and the y order when its y is 1, so tiles are always
// visited from the farthest cell in the direction of travel. The walk
// terminates on the bounds valve of src/engine/grid.ts's `cellContent`.
//
// THREE CHANGES TO THE PORTED BEHAVIOUR
//
//   The vanilla merge condition is split: the `next &&` existence guard stays
//   in this module and the two remaining tests are `config.merge.canMerge`.
//   The face value the vanilla branch computed as `tile.value * 2` is
//   `config.merge.produce`.
//
//   The `onMerge` transformation reaches the merge branch through the callback
//   `resolveMove` takes in its options, which defaults to
//   `identityMergeDispatch`. This module names no hook bus.
//
//   The win test the vanilla merge branch performed inline is not performed
//   here. `MoveOutcome.merges` carries every tile a merge produced, and
//   src/engine/terminal-state.ts compares those values against
//   `RulesConfig.winValue`.
//
// The vanilla post-move branch — the spawn, the loss check and the
// actuation — belongs to src/engine/engine.ts.
//
// This module reads no DOM, performs no I/O, consumes no randomness and reads
// no clock.
//
// Decisions behind this file, argued in docs/DECISION_LOG.md and named here
// only so the construct can be found from the log:
//   DL-MOVE-01  the merge condition split between the existence guard and
//               `config.merge.canMerge`
//   DL-MOVE-02  the `onMerge` transformation arriving as an injected callback,
//               so this module names no bus
//   DL-MOVE-03  the win test leaving this module for
//               src/engine/terminal-state.ts

import type { RulesConfig } from '../config/rules-config';
import type { Grid } from './grid';
import type { MergeDispatchPayload, MergePayload } from './hooks';
import { Tile } from './tile';
import type { Direction, Position, Vector } from './types';

/* --------------------------------------------------------------------------
 * Direction vectors
 * ----------------------------------------------------------------------- */

/**
 * The four movement vectors, keyed by direction. Frozen, and every returned
 * vector is frozen, so a caller cannot mutate the table a later move reads.
 */
const VECTORS: Readonly<Record<Direction, Vector>> = Object.freeze({
  0: Object.freeze({ x: 0, y: -1 }),
  1: Object.freeze({ x: 1, y: 0 }),
  2: Object.freeze({ x: 0, y: 1 }),
  3: Object.freeze({ x: -1, y: 0 }),
});

/**
 * Resolves a direction to its movement vector: 0 up, 1 right, 2 down, 3 left.
 */
export function vectorForDirection(direction: Direction): Vector {
  return VECTORS[direction];
}

/** The cell orders one move visits, per axis. */
export interface Traversals {
  readonly x: readonly number[];
  readonly y: readonly number[];
}

/**
 * Builds the cell orders one move visits, including the two reversals. `size`
 * is read at call time, as the vanilla builder did on every move.
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

/** The two positions the farthest-position walk yields. */
export interface FarthestPosition {
  /** Last empty cell reached before the obstacle. */
  readonly farthest: Position;

  /**
   * The cell beyond `farthest`, which is where a merge candidate would sit.
   * May lie outside the lattice, in which case `Grid.cellContent` reads it as
   * empty.
   */
  readonly next: Position;
}

/**
 * Walks from a cell along a vector until an obstacle is reached: the loop
 * advances while the next cell is both within bounds and empty, so it stops on
 * the board edge or on the first occupied cell. `next` is that stopping cell
 * and `farthest` the last empty one before it. Each step allocates a fresh
 * position, so `farthest` never aliases `next`.
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
 * Reports whether two positions name the same cell. This comparison is the
 * SOLE signal that a move changed the board, applied to a tile's starting cell
 * and its cell after resolution. A `Tile` satisfies the parameter type,
 * because a tile carries its coordinates flattened onto `x` and `y`.
 */
export function positionsEqual(
  first: Position,
  second: Position,
): boolean {
  return first.x === second.x && first.y === second.y;
}

/**
 * Records every tile's cell and clears its merge history, in the vanilla order
 * of the two writes: `mergedFrom` is cleared first and the position recorded
 * second. The iteration is `Grid.eachCell`, x-outer and y-inner. The board is
 * mutated in place.
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
 * Moves a tile to a cell, in the lattice and on the tile, in the vanilla
 * order: the cell the tile is leaving is cleared through the tile's own
 * coordinates, which are still its pre-move ones, the destination cell is
 * written second, and the tile's coordinates are updated last. The grid and
 * the tile are mutated in place; `cell` is read only and not retained.
 */
export function moveTile(grid: Grid, tile: Tile, cell: Position): void {
  grid.cells[tile.x][tile.y] = null;
  grid.cells[cell.x][cell.y] = tile;
  tile.updatePosition(cell);
}

/**
 * Transforms one `onMerge` payload inside the merge branch, before the merged
 * tile is written to the board.
 *
 * Takes and returns the same payload shape, carrying the two live tiles:
 * `resolveMove` reads `resultValue` and `scoreDelta` back from the returned
 * payload and nothing else, so a dispatch that rewrites either changes the
 * merge and a dispatch that rewrites neither leaves it as it stood.
 */
export type MergeDispatch = (payload: MergeDispatchPayload) => MergePayload;

/**
 * The `MergeDispatch` `resolveMove` uses when none is supplied: returns the
 * payload's four members unchanged, so the merge resolves on the values
 * `config.merge.produce` yielded. The dispatched payload and the handler's
 * payload are one type — the live tiles travel through both — so this is the
 * identity over a fresh shell.
 */
export function identityMergeDispatch(
  payload: MergeDispatchPayload,
): MergePayload {
  return {
    source: payload.source,
    target: payload.target,
    resultValue: payload.resultValue,
    scoreDelta: payload.scoreDelta,
  };
}

/**
 * One merge a move resolved. `source` and `target` are the pair recorded as
 * the merged tile's `mergedFrom`, and both are out of the lattice by the time
 * the move returns.
 */
export interface ResolvedMerge {
  readonly source: Tile;
  readonly target: Tile;

  /**
   * The live tile the merge produced, which is the tile now in the destination
   * cell. Its `value` is the produced face value after the falsy-to-2
   * coercion a tile applies.
   */
  readonly merged: Tile;
  readonly scoreDelta: number;
}

/**
 * What one resolved move changed. `moved` is the position-comparison flag,
 * `scoreDelta` the sum of the merge additions, and `merges` every merge the
 * move resolved, in the order the traversal reached them.
 */
export interface MoveOutcome {
  readonly moved: boolean;
  readonly scoreDelta: number;

  /** Every merge resolved, in traversal order. Empty when none was. */
  readonly merges: readonly ResolvedMerge[];
}

/** The optional collaborators `resolveMove` accepts. */
export interface ResolveMoveOptions {
  /**
   * Transforms each merge before the merged tile is written to the board.
   * Defaults to `identityMergeDispatch`.
   */
  readonly dispatchMerge?: MergeDispatch;
}

/**
 * Resolves one move: prepares the tiles, then walks the traversal orders and
 * either merges or slides each tile it reaches.
 *
 * The board and its tiles are mutated in place and nothing else is touched: no
 * tile is spawned, no terminal state is evaluated, nothing is committed or
 * persisted and no event is emitted — those belong to src/engine/engine.ts.
 *
 * `grid.size` and `config.merge` are read on every call, so a board size or a
 * merge rule changed during a run takes effect on the next move.
 */
export function resolveMove(
  grid: Grid,
  direction: Direction,
  config: RulesConfig,
  options: ResolveMoveOptions = {},
): MoveOutcome {

  const vector = vectorForDirection(direction);
  const traversals = buildTraversals(vector, grid.size);
  const dispatchMerge = options.dispatchMerge ?? identityMergeDispatch;

  const merges: ResolvedMerge[] = [];
  let moved = false;
  let scoreDelta = 0;

  prepareTiles(grid);

  for (const x of traversals.x) {
    for (const y of traversals.y) {
      const cell: Position = { x, y };
      const tile = grid.cellContent(cell);

      if (!tile) {
        continue;
      }

      const positions = findFarthestPosition(grid, cell, vector);
      const next = grid.cellContent(positions.next);

      if (next && config.merge.canMerge(tile, next)) {
        const produced = config.merge.produce(tile, next);

        const resolved = dispatchMerge({
          source: tile,
          target: next,
          resultValue: produced,
          scoreDelta: produced,
        });


        const merged = new Tile(positions.next, resolved.resultValue);

        merged.mergedFrom = [tile, next];

        grid.insertTile(merged);
        grid.removeTile(tile);

        tile.updatePosition(positions.next);

        scoreDelta += resolved.scoreDelta;

        merges.push({
          source: tile,
          target: next,
          merged,
          scoreDelta: resolved.scoreDelta,
        });
      } else {
        moveTile(grid, tile, positions.farthest);
      }

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
