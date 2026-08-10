// One tile: the cell it occupies, its face value and the two members a view
// reads to animate it.
//
// Ported member for member and method for method from js/tile.js, which is
// deleted; nothing here was added to that source.
//
// This module reads no DOM, performs no I/O, consumes no randomness and reads
// no clock.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
// this module's area enumerated:
//   TR-TILE-01  js/tile.js L1-L8   constructor
//   TR-TILE-02  js/tile.js L2-L3   position flattened onto x and y
//   TR-TILE-03  js/tile.js L4      value, falsy argument coerced to 2
//   TR-TILE-04  js/tile.js L6      previousPosition
//   TR-TILE-05  js/tile.js L7      mergedFrom
//   TR-TILE-06  js/tile.js L10-L12 savePosition()
//   TR-TILE-07  js/tile.js L14-L17 updatePosition()
//   TR-TILE-08  js/tile.js L19-L27 serialize()
//
// Decisions: DL-TILE-01 (docs/DECISION_LOG.md).

import type { Position, SerializedTile } from './types';

/**
 * Face value of a tile constructed without one. js/tile.js L4 is `this.value =
 * value || 2`, so a falsy argument — an omitted value, `0`, or `NaN` — yields
 * 2.
 */
const DEFAULT_TILE_VALUE = 2;

/**
 * A tile on the board: a plain mutable object carrying its cell, its face
 * value and its animation state.
 *
 * A tile's coordinates are written in place, so one object serves a tile for
 * the whole game and a view reads `previousPosition` and `mergedFrom` off that
 * same object.
 */
export class Tile {
  x: number;
  y: number;
  value: number;

  /**
   * The cell this tile occupied before the move in progress, or `null` when it
   * has not moved this turn. `savePosition` writes it, and the engine takes a
   * fresh snapshot of every tile at the start of each move.
   */
  previousPosition: Position | null;

  /**
   * The two tiles this tile was produced by, or `null` when it was not
   * produced by a merge this turn. Exactly two are recorded, and the member is
   * cleared at the start of every move.
   */
  mergedFrom: [Tile, Tile] | null;

  constructor(position: Position, value?: number) {
    this.x = position.x;
    this.y = position.y;
    this.value = value || DEFAULT_TILE_VALUE;

    this.previousPosition = null;
    this.mergedFrom = null;
  }

  /**
   * Records the tile's current cell as the cell it is moving from. The
   * recorded coordinates are a fresh copy, so a later `updatePosition` leaves
   * them unchanged.
   */
  savePosition(): void {
    this.previousPosition = { x: this.x, y: this.y };
  }

  /**
   * Moves the tile to a cell: it writes the two coordinates and nothing else,
   * leaving `previousPosition` as `savePosition` recorded it. The lattice's
   * backing matrix is written by src/engine/grid.ts.
   */
  updatePosition(position: Position): void {
    this.x = position.x;
    this.y = position.y;
  }

  /**
   * Projects the tile to its persisted form: the coordinates re-nested under
   * `position`, with `previousPosition` and `mergedFrom` not carried. This is
   * the innermost stage of the persisted board snapshot.
   */
  serialize(): SerializedTile {
    return {
      position: {
        x: this.x,
        y: this.y,
      },
      value: this.value,
    };
  }
}
