// The cell lattice: availability queries, bounds checking and
// serialisation.
//
// Ported from js/grid.js, which is deleted. Every construct below is a
// one-for-one port, and the map covers all 118 lines of that source:
//   js/grid.js L1-L4     constructor, empty-or-restore
//   js/grid.js L7-L19    empty()
//   js/grid.js L21-L34   fromState()
//   js/grid.js L37-L43   randomAvailableCell()
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
// This module adds no member that source did not carry.
//
// Two of those lines changed rather than moved:
//   js/grid.js L29  constructed `Tile` through the ambient global the
//                   script tags left in scope. It is the imported
//                   binding below.
//   js/grid.js L41  drew from the global random source. The draw comes
//                   from the `spawn-position` substream that
//                   `randomAvailableCell` receives as an argument.
//                   That line and js/game_manager.js L71 were the
//                   vanilla sources' only two randomness call sites.
//
// Invariants of this module: it names no engine module other than
// ./tile and the type-only imports below, reads no DOM, performs no
// I/O, owns no source of randomness and reads no clock.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

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
 * The backing store is `cells[x][y]`, x-major on the outer array, with
 * `null` in every empty cell — the layout js/grid.js L7-L19 built and
 * every access in the vanilla sources used.
 */
export class Grid {
  /**
   * Edge length in cells. Ported from js/grid.js L2.
   *
   * Every method below reads this member at call time; none captures
   * it. A grid is constructed at the size its board has been
   * reconciled to, which is what js/game_manager.js L40 and L47 did on
   * every setup.
   */
  size: number;

  /**
   * The backing store, `cells[x][y]`. Ported from js/grid.js L3.
   *
   * Written in place from outside the class: js/game_manager.js
   * L124-L125 assigned `grid.cells[x][y]` directly, and
   * src/engine/engine.ts assigns it the same way.
   */
  cells: CellMatrix<Tile>;

  /**
   * Ported from js/grid.js L1-L4, including the two-argument shape: a
   * grid is built empty or restored from a serialised matrix, which is
   * how js/game_manager.js L40-L41 and L47 built one. `size` is
   * assigned first, as L2 did; both builders read it.
   *
   * @param size Edge length in cells.
   * @param previousState Serialised cell matrix to restore from, read
   *   as `previousState[x][y]` exactly as js/grid.js L28 read it.
   *   Absent or `null`, an empty lattice is built.
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
   * Ported from js/grid.js L7-L19: `size` columns on the outer array,
   * x-outer and y-inner, every cell `null`.
   *
   * @returns A fresh matrix of `null`.
   */
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
   * Builds a lattice from a serialised matrix.
   *
   * Ported from js/grid.js L21-L34, including L29's truthy test on the
   * entry: a serialised cell is either a truthy object or `null`.
   * L29 reached `Tile` as an ambient global; the imported binding
   * replaces that.
   *
   * The double loop is bounded by this grid's own size, so a matrix
   * wider or taller than the grid is truncated and a smaller one
   * yields empty cells. src/run/run-state.ts validates a persisted
   * matrix without requiring it to measure `size` by `size` and
   * records that this restore absorbs the difference; the check on the
   * column absorbs a missing one, where js/grid.js L28 read
   * `state[x][y]` unguarded.
   *
   * @param state Serialised matrix, read as `state[x][y]`.
   * @returns A fresh matrix of tiles and `null`.
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
   * Draws one empty cell.
   *
   * Ported from js/grid.js L37-L43. L41 indexed the list
   * `availableCells()` returns with a draw from the global random
   * source; the draw is taken from the injected substream instead, and
   * `RngStream.pick` reduces it by flooring the draw scaled by the
   * list length, which is the arithmetic L41 applied, over a list whose
   * order is unchanged.
   *
   * The full-board boundary is L40's: `if (cells.length)` carried no
   * else branch, so the vanilla function fell through and returned
   * `undefined`. That is preserved, and `RngStream.pick` consumes no
   * draw for an empty list. js/game_manager.js L70 guarded the call
   * with `cellsAvailable()`, and src/engine/engine.ts guards its spawn
   * the same way.
   *
   * @param stream The `spawn-position` substream to draw from.
   * @returns The drawn cell, or `undefined` when no cell is empty.
   */
  randomAvailableCell(stream: RngStream): Position | undefined {
    const cells = this.availableCells();

    if (cells.length) {
      return stream.pick(cells);
    }

    return undefined;
  }

  /**
   * Collects every empty cell.
   *
   * Ported from js/grid.js L45-L55. The order is `eachCell`'s, x-outer
   * and y-inner, and it is the order `randomAvailableCell` draws
   * against: the same draw selects a different cell if it changes.
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
   * Ported from js/grid.js L58-L64, including the argument order:
   * js/game_manager.js L114-L119 read the coordinates and the cell's
   * contents in that order.
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
    return !!this.availableCells().length;
  }

  /**
   * Reports whether a cell is empty.
   *
   * Ported from js/grid.js L72-L74. A cell outside the lattice reads as
   * available: `cellContent` returns `null` for it. The
   * farthest-position walk of src/engine/move-resolver.ts pairs this
   * call with `withinBounds` and guards the bounds itself, exactly as
   * js/game_manager.js L229-L230 did.
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
    return !!this.cellContent(cell);
  }

  /**
   * Reads a cell's contents.
   *
   * Ported from js/grid.js L80-L86, including the bounds valve at L84:
   * a cell outside the lattice reads as `null` rather than raising.
   * Two callers depend on that `null`. The farthest-position walk of
   * src/engine/move-resolver.ts, ported from js/game_manager.js
   * L226-L235, steps one cell beyond the last empty cell and
   * terminates on it, and the neighbour probe of
   * src/engine/terminal-state.ts, ported from L257, reads cells
   * deliberately off the lattice along every edge.
   *
   * @param cell Cell to read.
   * @returns The tile, or `null` when the cell is empty or lies
   *   outside the lattice.
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
   * Ported from js/grid.js L89-L91, which indexed by `tile.x` and
   * `tile.y` — the coordinates js/tile.js L2-L3 flattened off the
   * position the tile was constructed with — and not through a nested
   * position member.
   *
   * @param tile Tile to insert.
   */
  insertTile(tile: Tile): void {
    this.cells[tile.x][tile.y] = tile;
  }

  /**
   * Clears the cell a tile's own coordinates name.
   *
   * Ported from js/grid.js L93-L95, indexing by `tile.x` and `tile.y`
   * as L94 did and writing `null`.
   *
   * @param tile Tile whose cell is cleared.
   */
  removeTile(tile: Tile): void {
    this.cells[tile.x][tile.y] = null;
  }

  /**
   * Reports whether a position lies inside the lattice.
   *
   * Ported from js/grid.js L97-L100, reading `this.size` at call time.
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
   * Ported from js/grid.js L102-L117, including L109's `null` for an
   * empty cell: an entry is never omitted or compacted, so the matrix
   * stays square and `fromState` reads it back. This is the middle
   * stage of the three-stage snapshot js/game_manager.js L102-L110
   * wrapped around it, and src/run/run-state.ts carries it verbatim.
   *
   * @returns A fresh plain object; mutating it does not reach the grid.
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
