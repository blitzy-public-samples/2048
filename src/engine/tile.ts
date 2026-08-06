// One tile: the cell it occupies, its face value and the two members a
// view reads to animate it.
//
// Ported from js/tile.js, which is deleted. Every member and every method
// below is a one-for-one port:
//   js/tile.js L1-L8   constructor
//   js/tile.js L2-L3   position flattened onto x and y
//   js/tile.js L4      value, with a falsy argument coerced to 2
//   js/tile.js L6      previousPosition
//   js/tile.js L7      mergedFrom
//   js/tile.js L10-L12 savePosition()
//   js/tile.js L14-L17 updatePosition()
//   js/tile.js L19-L27 serialize()
//
// The map above covers all 28 lines of js/tile.js, and this module adds no
// member that source did not carry.
//
// Invariants of this module: it names no engine module other than the
// type-only import below, reads no DOM, performs no I/O, consumes no
// randomness and reads no clock.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import type { Position, SerializedTile } from './types';

/**
 * Face value of a tile constructed without one.
 *
 * js/tile.js L4 is `this.value = value || 2`: a falsy argument — an
 * omitted value, `0`, or `NaN` — yields 2.
 */
const DEFAULT_TILE_VALUE = 2;

/**
 * A tile on the board: a plain mutable object carrying its cell, its face
 * value and its animation state.
 *
 * js/game_manager.js wrote a tile's coordinates in place through
 * `updatePosition` (L126 and L164), so one object served a tile for the
 * whole game, and js/html_actuator.js read `previousPosition` and
 * `mergedFrom` off those same objects (L54, L67-L80).
 * src/engine/engine.ts and src/engine/grid.ts write these members the
 * same way.
 */
export class Tile {
  /** Zero-based column index of the tile's cell. Ported from L2. */
  x: number;

  /** Zero-based row index of the tile's cell. Ported from L3. */
  y: number;

  /** Face value. Ported from L4. */
  value: number;

  /**
   * The cell this tile occupied before the move in progress, or `null`
   * when it has not moved this turn.
   *
   * Ported from L6. `savePosition()` writes it, and src/engine/engine.ts
   * takes a fresh snapshot of every tile at the start of each move,
   * which is what js/game_manager.js L113-L120 did.
   */
  previousPosition: Position | null;

  /**
   * The two tiles this tile was produced by, or `null` when it was not
   * produced by a merge this turn.
   *
   * Ported from L7, whose comment reads "Tracks tiles that merged
   * together". js/game_manager.js L158 assigned exactly two tiles,
   * `[tile, next]`, and L116 cleared the member at the start of every
   * move.
   *
   * Both tiles held here are out of the lattice by the time a view reads
   * them: js/game_manager.js L160-L161 inserted the merged tile over one
   * of them and removed the other from `grid.cells`. They reach
   * js/html_actuator.js L78-L80, which draws each of them underneath the
   * merged tile, as the live references this member holds. This class
   * clears neither of them and pools nothing.
   */
  mergedFrom: [Tile, Tile] | null;

  /**
   * Ported from js/tile.js L1-L8.
   *
   * @param position Cell the tile occupies. Its coordinates are copied
   *   onto `x` and `y` (L2-L3); the object itself is not retained.
   * @param value Face value. A falsy value yields `DEFAULT_TILE_VALUE`,
   *   which is L4's coercion.
   */
  constructor(position: Position, value?: number) {
    this.x = position.x;
    this.y = position.y;
    this.value = value || DEFAULT_TILE_VALUE;

    this.previousPosition = null;
    this.mergedFrom = null;
  }

  /**
   * Records the tile's current cell as the cell it is moving from.
   *
   * Ported from L10-L12, including the fresh object: the recorded
   * coordinates are a copy, so a later `updatePosition` leaves them
   * unchanged.
   */
  savePosition(): void {
    this.previousPosition = { x: this.x, y: this.y };
  }

  /**
   * Moves the tile to a cell.
   *
   * Ported from L14-L17: it writes the two coordinates and nothing else,
   * leaving `previousPosition` as `savePosition()` recorded it. The
   * lattice's backing matrix is written by src/engine/grid.ts, exactly
   * as js/game_manager.js L124-L125 wrote it.
   *
   * @param position Cell to move to.
   */
  updatePosition(position: Position): void {
    this.x = position.x;
    this.y = position.y;
  }

  /**
   * Projects the tile to its persisted form.
   *
   * Ported from L19-L27: the coordinates are re-nested under `position`,
   * and `previousPosition` and `mergedFrom` are not carried. This is the
   * innermost stage of the snapshot js/grid.js L102-L117 and
   * js/game_manager.js L102-L110 wrapped around it.
   *
   * @returns A fresh plain object; writing to it does not reach the
   *   tile.
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
