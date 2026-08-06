// The cell lattice: availability queries, bounds checking and
// serialisation.
//
// Ported from js/grid.js, which is deleted. Every method below is a
// one-for-one port:
//   js/grid.js L1-L4     constructor, empty-or-restore
//   js/grid.js L7-L19    empty()
//   js/grid.js L21-L34   fromState()
//   js/grid.js L45-L55   availableCells()
//   js/grid.js L58-L64   eachCell()
//   js/grid.js L67-L69   cellsAvailable()
//   js/grid.js L72-L74   cellAvailable()
//   js/grid.js L76-L78   cellOccupied()
//   js/grid.js L80-L86   cellContent()
//   js/grid.js L89-L91   insertTile()
//   js/grid.js L93-L95   removeTile()
//   js/grid.js L97-L100  withinBounds()
//   js/grid.js L102-L117 serialize()
//
// `randomAvailableCell` at js/grid.js L37-L43 has no counterpart here.
// It held one of the vanilla sources' two `Math.random()` calls (L41);
// the draw moves to the `spawn-position` substream of
// src/rng/rng-streams.ts, which selects from the list `availableCells()`
// returns. The list's order is unchanged, so a given draw selects the
// same cell it selected there.
//
// Invariants of this module: it names no engine module other than
// ./tile and the type-only imports below, reads no DOM, performs no I/O,
// consumes no randomness and reads no clock.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import { Tile } from './tile';
import type {
  CellMatrix,
  Position,
  SerializedGrid,
  SerializedTile,
} from './types';

/**
 * A square board of cells, each holding one tile or nothing.
 *
 * The backing store is `cells[x][y]`, x-major on the outer array, with
 * `null` in every empty cell — the layout js/grid.js L7-L19 built and
 * every access in the vanilla sources used.
 */
export class Grid {
  /**
   * Edge length in cells.
   *
   * Fixed for the lifetime of the instance. A board whose size changes
   * is a new grid: src/engine/engine.ts constructs one at the
   * reconciled size, which is what js/game_manager.js L40 and L47 did
   * on every setup.
   */
  readonly size: number;

  /** The backing store, `cells[x][y]`. Ported from js/grid.js L3. */
  cells: CellMatrix<Tile>;

  /**
   * @param size Edge length in cells.
   * @param previousState Serialised cell matrix to restore from, read
   *   as `previousState[x][y]` exactly as js/grid.js L28 read it. Absent
   *   or `null`, an empty lattice is built.
   */
  constructor(
    size: number,
    previousState?: CellMatrix<SerializedTile> | null,
  ) {
    this.size = size;
    this.cells = previousState ? this.fromState(previousState) : this.empty();
  }

  /**
   * Builds an empty lattice.
   *
   * Ported from js/grid.js L7-L19.
   *
   * @returns A fresh matrix of `null`.
   */
  private empty(): CellMatrix<Tile> {
    const cells: CellMatrix<Tile> = [];

    for (let x = 0; x < this.size; x += 1) {
      const row: (Tile | null)[] = [];

      cells[x] = row;

      for (let y = 0; y < this.size; y += 1) {
        row.push(null);
      }
    }

    return cells;
  }

  /**
   * Builds a lattice from a serialised matrix.
   *
   * Ported from js/grid.js L21-L34. The loop is bounded by this grid's
   * own size, so a matrix larger than the grid is truncated and one
   * smaller yields empty cells rather than throwing: L28 read
   * `state[x][y]` unguarded, and the guard below is the one addition.
   *
   * @param state Serialised matrix, read as `state[x][y]`.
   * @returns A fresh matrix of tiles and `null`.
   */
  private fromState(state: CellMatrix<SerializedTile>): CellMatrix<Tile> {
    const cells: CellMatrix<Tile> = [];

    for (let x = 0; x < this.size; x += 1) {
      const row: (Tile | null)[] = [];

      cells[x] = row;

      const column = state[x];

      for (let y = 0; y < this.size; y += 1) {
        const tile = column === undefined ? null : column[y];

        row.push(
          tile === null || tile === undefined
            ? null
            : new Tile(tile.position, tile.value),
        );
      }
    }

    return cells;
  }

  /**
   * Collects every empty cell.
   *
   * Ported from js/grid.js L45-L55. The collection order is
   * `eachCell`'s x-outer, y-inner order and is part of the seeded-spawn
   * contract: the `spawn-position` substream indexes this list.
   *
   * @returns A fresh array of cell coordinates.
   */
  availableCells(): Position[] {
    const cells: Position[] = [];

    this.eachCell((x, y, tile) => {
      if (!tile) {
        cells.push({ x, y });
      }
    });

    return cells;
  }

  /**
   * Calls `callback` once per cell, x-outer and y-inner.
   *
   * Ported from js/grid.js L58-L64.
   *
   * @param callback Receives the cell's coordinates and its contents.
   */
  eachCell(callback: (x: number, y: number, tile: Tile | null) => void): void {
    for (let x = 0; x < this.size; x += 1) {
      for (let y = 0; y < this.size; y += 1) {
        callback(x, y, this.cells[x][y]);
      }
    }
  }

  /**
   * Reports whether any cell is empty.
   *
   * Ported from js/grid.js L67-L69.
   *
   * @returns `true` when at least one cell is empty.
   */
  cellsAvailable(): boolean {
    return this.availableCells().length > 0;
  }

  /**
   * Reports whether a cell is empty.
   *
   * Ported from js/grid.js L72-L74. A cell outside the lattice reads as
   * available, because `cellContent` returns `null` for it; the
   * farthest-position walk relies on that, guarding bounds itself.
   *
   * @param cell Cell to test.
   * @returns `true` when the cell holds no tile.
   */
  cellAvailable(cell: Position): boolean {
    return !this.cellOccupied(cell);
  }

  /**
   * Reports whether a cell holds a tile.
   *
   * Ported from js/grid.js L76-L78.
   *
   * @param cell Cell to test.
   * @returns `true` when the cell holds a tile.
   */
  cellOccupied(cell: Position): boolean {
    return this.cellContent(cell) !== null;
  }

  /**
   * Reads a cell's contents.
   *
   * Ported from js/grid.js L80-L86, including the bounds safety valve
   * that returns `null` outside the lattice. That valve is what
   * terminates the farthest-position walk, and it is preserved
   * unchanged.
   *
   * @param cell Cell to read.
   * @returns The tile, or `null` when the cell is empty or outside the
   *   lattice.
   */
  cellContent(cell: Position): Tile | null {
    if (this.withinBounds(cell)) {
      return this.cells[cell.x][cell.y];
    }

    return null;
  }

  /**
   * Writes a tile into the cell its own coordinates name.
   *
   * Ported from js/grid.js L89-L91.
   *
   * @param tile Tile to insert.
   */
  insertTile(tile: Tile): void {
    this.cells[tile.x][tile.y] = tile;
  }

  /**
   * Clears the cell a tile's own coordinates name.
   *
   * Ported from js/grid.js L93-L95.
   *
   * @param tile Tile whose cell is cleared.
   */
  removeTile(tile: Tile): void {
    this.cells[tile.x][tile.y] = null;
  }

  /**
   * Reports whether a position lies inside the lattice.
   *
   * Ported from js/grid.js L97-L100.
   *
   * @param position Position to test.
   * @returns `true` when both coordinates are within `[0, size)`.
   */
  withinBounds(position: Position): boolean {
    return (
      position.x >= 0 &&
      position.x < this.size &&
      position.y >= 0 &&
      position.y < this.size
    );
  }

  /**
   * Projects the lattice to its persisted form.
   *
   * Ported from js/grid.js L102-L117: an empty cell is a `null` entry
   * and is never omitted or compacted, so the matrix stays square and
   * `fromState` can read it back.
   *
   * @returns A fresh plain object; mutating it does not affect the
   *   grid.
   */
  serialize(): SerializedGrid {
    const cellState: CellMatrix<SerializedTile> = [];

    for (let x = 0; x < this.size; x += 1) {
      const row: (SerializedTile | null)[] = [];

      cellState[x] = row;

      for (let y = 0; y < this.size; y += 1) {
        const tile = this.cells[x][y];

        row.push(tile ? tile.serialize() : null);
      }
    }

    return {
      size: this.size,
      cells: cellState,
    };
  }
}
