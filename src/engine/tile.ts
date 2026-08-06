// One tile: its cell, its face value and the two members a view reads to
// animate it.
//
// Ported from js/tile.js, which is deleted. Every member and every method
// below is a one-for-one port:
//   js/tile.js L2-L3   position destructured onto x and y
//   js/tile.js L4      value, with a falsy argument coerced to 2
//   js/tile.js L6      previousPosition
//   js/tile.js L7      mergedFrom
//   js/tile.js L10-L12 savePosition()
//   js/tile.js L14-L17 updatePosition()
//   js/tile.js L19-L27 serialize()
//
// Invariants of this module: it names no engine module other than the
// type-only import below, reads no DOM, performs no I/O, consumes no
// randomness and reads no clock.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import type { Position, SerializedTile } from './types';

/**
 * The default face value of a tile constructed without one.
 *
 * js/tile.js L4 is `this.value = value || 2;`: a falsy argument — an
 * omitted value, `0`, or `NaN` — yields 2.
 */
const DEFAULT_TILE_VALUE = 2;

/**
 * A tile on the board.
 *
 * Mutable by design. js/game_manager.js moved tiles by writing their
 * coordinates in place (L126 through `updatePosition`) rather than by
 * replacing them, and js/html_actuator.js read `previousPosition` and
 * `mergedFrom` off the same objects the manager had just mutated. Both
 * properties are preserved: src/engine/grid.ts writes a tile's cell
 * through `updatePosition`, and the board projection an event carries is
 * built from these members.
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
   * Ported from L6. `savePosition()` sets it and
   * src/engine/engine.ts clears it by taking a fresh snapshot at the
   * start of every move, which is what js/game_manager.js L113-L120
   * did.
   */
  previousPosition: Position | null;

  /**
   * The two tiles this tile was produced by, or `null` when it was not
   * produced by a merge this turn.
   *
   * Ported from L7. js/game_manager.js L158 assigned the populated
   * form and L116 cleared it at the start of every move.
   */
  mergedFrom: Tile[] | null;

  /**
   * @param position Cell the tile occupies.
   * @param value Face value. A falsy value yields 2, which is L4's
   *   coercion.
   */
  constructor(position: Position, value?: number) {
    this.x = position.x;
    this.y = position.y;
    this.value = value ? value : DEFAULT_TILE_VALUE;

    this.previousPosition = null;
    this.mergedFrom = null;
  }

  /**
   * Records the tile's current cell as the cell it is moving from.
   *
   * Ported from L10-L12, including the fresh object: the saved position
   * is a copy, so a later coordinate write does not change it.
   */
  savePosition(): void {
    this.previousPosition = { x: this.x, y: this.y };
  }

  /**
   * Moves the tile to a cell.
   *
   * Ported from L14-L17. It writes the two coordinates and nothing
   * else; the grid's backing matrix is written by
   * src/engine/grid.ts, exactly as js/game_manager.js L124-L126 did.
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
   * Ported from L19-L27: the coordinates are re-nested under
   * `position` and no animation state is carried.
   *
   * @returns A fresh plain object; mutating it does not affect the
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
