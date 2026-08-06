// Direction vectors, traversal ordering, the farthest-position walk and
// the position comparison a move's outcome is read from.
//
// Ported from js/game_manager.js, which is deleted:
//   js/game_manager.js L194-L204 getVector()
//   js/game_manager.js L207-L220 buildTraversals()
//   js/game_manager.js L222-L236 findFarthestPosition()
//   js/game_manager.js L270-L272 positionsEqual()
//
// The traversal reversal is preserved exactly: the x order is reversed
// when the vector's x is 1 and the y order when its y is 1 (L216-L217),
// so tiles are always visited from the farthest cell in the direction of
// travel. The walk terminates on the bounds valve of
// src/engine/grid.ts's `cellContent`, exactly as L229-L230 did.
//
// Invariants of this module: it names no engine module other than the
// type-only imports below, reads no DOM, performs no I/O, consumes no
// randomness and reads no clock. Importing it defines functions and
// freezes the vector table, and does nothing else.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import type { Grid } from './grid';
import type { Direction, Position, Vector } from './types';

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

/**
 * Walks from a cell along a vector until an obstacle is reached.
 *
 * Ported from js/game_manager.js L222-L236. The loop advances while the
 * next cell is both within bounds and empty, so it stops on the board
 * edge or on the first occupied cell; `next` is that stopping cell and
 * `farthest` is the last empty one before it.
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

/**
 * Reports whether two positions name the same cell.
 *
 * Ported from js/game_manager.js L270-L272. This comparison is the sole
 * signal that a move changed the board: L175 applied it to a tile's
 * starting cell and its cell after resolution.
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
