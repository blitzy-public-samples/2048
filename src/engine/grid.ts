// The cell lattice: availability queries, bounds checking and serialisation.
//
// Ported construct for construct from js/grid.js, which is deleted; nothing
// here was added to that source. Two of its lines changed rather than moved:
// the `Tile` constructor it reached as an ambient global is the imported
// binding below, and the draw it took from the global random source comes from
// the `spawn-position` substream `randomAvailableCell` receives as an
// argument.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
// this module's area enumerated:
//   TR-GRID-01  js/grid.js L1-L4     constructor, empty-or-restore
//   TR-GRID-02  js/grid.js L7-L19    empty()
//   TR-GRID-03  js/grid.js L21-L34   fromState()
//   TR-GRID-04  js/grid.js L37-L43   randomAvailableCell()
//   TR-GRID-05  js/grid.js L45-L55   availableCells()
//   TR-GRID-06  js/grid.js L58-L64   eachCell()
//   TR-GRID-07  js/grid.js L67-L69   cellsAvailable()
//   TR-GRID-08  js/grid.js L72-L74   cellAvailable()
//   TR-GRID-09  js/grid.js L76-L78   cellOccupied()
//   TR-GRID-10  js/grid.js L80-L86   cellContent()
//   TR-GRID-11  js/grid.js L89-L91   insertTile()
//   TR-GRID-12  js/grid.js L93-L95   removeTile()
//   TR-GRID-13  js/grid.js L97-L100  withinBounds()
//   TR-GRID-14  js/grid.js L102-L117 serialize()
//
// This module reads no DOM, performs no I/O, owns no source of randomness and
// reads no clock.
//
// The two lines that changed rather than moved:
//   js/grid.js L29, inside TR-GRID-03, constructed `Tile` through the ambient
//   global that load order supplied; it is the imported binding here.
//   js/grid.js L41, inside TR-GRID-04, drew from the global random source; the
//   draw comes from the injected `spawn-position` substream here.
//
// Decisions behind this file, argued in docs/DECISION_LOG.md and named here
// only so the construct can be found from the log:
//   DL-GRID-01  the spawn-position substream injected into
//               `randomAvailableCell` rather than reached as a module binding
//   DL-GRID-02  the restore walk bounded by this grid's own edge length

import { Tile } from './tile';
import type {
  CellMatrix,
  Position,
  SerializedGrid,
  SerializedTile,
} from './types';
import type { RngStream } from '../rng/rng-streams';

/**
 * A square board of cells, each holding one tile or nothing.
 *
 * The backing store is `cells[x][y]`, x-major on the outer array, with `null`
 * in every empty cell.
 */
export class Grid {
  /**
   * Edge length in cells. Every method below reads this member at call time;
   * none captures it. A grid is constructed at the size its board has been
   * reconciled to.
   */
  size: number;

  /**
   * The backing store, `cells[x][y]`. Written in place from outside the
   * class: the engine assigns `grid.cells[x][y]` directly, as the vanilla
   * game did.
   */
  cells: CellMatrix<Tile>;

  /**
   * Builds a grid empty or restored from a serialised matrix. `size` is
   * assigned first; both builders read it.
   *
   * @param previousState Serialised cell matrix, read as
   *   `previousState[x][y]`. Absent or `null`, an empty lattice is built.
   */
  constructor(
    size: number,
    previousState?: CellMatrix<SerializedTile> | null,
  ) {
    this.size = size;
    this.cells = previousState ? this.fromState(previousState) : this.empty();
  }

  empty(): CellMatrix<Tile> {
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
   * Builds a lattice from a serialised matrix, treating a cell as a tile when
   * its entry is truthy and as empty otherwise.
   *
   * The double loop is bounded by this grid's own size, so a matrix wider or
   * taller than the grid is truncated and a smaller one yields empty cells;
   * the check on the column absorbs a missing one, where the vanilla source
   * read `state[x][y]` unguarded.
   */
  fromState(state: CellMatrix<SerializedTile>): CellMatrix<Tile> {
    const cells: CellMatrix<Tile> = [];

    for (let x = 0; x < this.size; x += 1) {
      const row: (Tile | null)[] = [];

      cells[x] = row;

      const column: (SerializedTile | null)[] | undefined = state[x];

      for (let y = 0; y < this.size; y += 1) {
        const tile = column === undefined ? null : column[y];

        row.push(tile ? new Tile(tile.position, tile.value) : null);
      }
    }

    return cells;
  }

  /**
   * Draws one empty cell from the injected substream. `RngStream.pick`
   * reduces the draw by flooring it scaled by the list length, over a list
   * whose order is unchanged, which is the arithmetic the vanilla draw
   * applied.
   *
   * The full-board boundary is the vanilla one: no cell empty yields
   * `undefined`, and `RngStream.pick` consumes no draw for an empty list.
   */
  randomAvailableCell(stream: RngStream): Position | undefined {
    const cells = this.availableCells();

    if (cells.length) {
      return stream.pick(cells);
    }

    return undefined;
  }

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
   * Calls `callback` once per cell, x-outer and y-inner, with the cell's
   * coordinates before its contents.
   */
  eachCell(callback: (x: number, y: number, tile: Tile | null) => void): void {
    for (let x = 0; x < this.size; x += 1) {
      for (let y = 0; y < this.size; y += 1) {
        callback(x, y, this.cells[x][y]);
      }
    }
  }

  cellsAvailable(): boolean {
    return !!this.availableCells().length;
  }

  /**
   * Reports whether a cell is empty. A cell OUTSIDE the lattice reads as
   * available, because `cellContent` returns `null` for it; the
   * farthest-position walk pairs this call with `withinBounds` and guards the
   * bounds itself.
   */
  cellAvailable(cell: Position): boolean {
    return !this.cellOccupied(cell);
  }

  cellOccupied(cell: Position): boolean {
    return !!this.cellContent(cell);
  }

  /**
   * Reads a cell's contents, or `null` when the cell is empty OR lies outside
   * the lattice.
   *
   * Two callers depend on that second `null`: the farthest-position walk in
   * src/engine/move-resolver.ts steps one cell beyond the last empty cell and
   * terminates on it, and the neighbour probe in src/engine/terminal-state.ts
   * reads cells deliberately off the lattice along every edge.
   */
  cellContent(cell: Position): Tile | null {
    if (this.withinBounds(cell)) {
      return this.cells[cell.x][cell.y];
    }

    return null;
  }

  /**
   * Writes a tile into the cell its own `x` and `y` name, not a nested
   * position member.
   *
   * WRITES THE ADDRESSED CELL WHATEVER IT HOLDS, which the merge branch of
   * src/engine/move-resolver.ts depends on: the merged tile is inserted into the
   * cell the tile it merged with still occupies. A caller that must not replace
   * a tile — the spawn boundary of src/engine/engine.ts is the one such caller —
   * tests `cellAvailable` first.
   */
  insertTile(tile: Tile): void {
    this.cells[tile.x][tile.y] = tile;
  }

  removeTile(tile: Tile): void {
    this.cells[tile.x][tile.y] = null;
  }

  withinBounds(position: Position): boolean {
    return (
      position.x >= 0 &&
      position.x < this.size &&
      position.y >= 0 &&
      position.y < this.size
    );
  }

  /**
   * Projects the lattice to its persisted form, keeping `null` for an empty
   * cell: an entry is never omitted or compacted, so the matrix stays square
   * and `fromState` reads it back. This is the middle stage of the persisted
   * three-stage board snapshot. The returned object is fresh; mutating it
   * does not reach the grid.
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
