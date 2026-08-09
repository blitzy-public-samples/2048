// Ported-fidelity suite of src/engine/move-resolver.ts, the TypeScript port of
// the move pipeline of js/game_manager.js, which is deleted. Every describe
// below names one ported construct.
//
// Three signatures changed with the move off the prototype: `getVector` is
// `vectorForDirection`, `buildTraversals` takes the board size where the
// method read `this.size`, and `findFarthestPosition` takes the grid where the
// method read `this.grid`.
//
// Decisions: DL-MOVE-01, DL-MOVE-02, DL-MOVE-03 (docs/DECISION_LOG.md).

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_BOARD_SIZE,
  createDefaultRulesConfig,
  defaultCanMerge,
  defaultProduceMergeValue,
} from '../../../src/config/default-config';
import type {
  MergePredicate,
  MergeProducer,
  MergeTileView,
  RulesConfig,
} from '../../../src/config/rules-config';
import { Grid } from '../../../src/engine/grid';
import type {
  MergeDispatchPayload,
  MergePayload,
} from '../../../src/engine/hooks';
import {
  buildTraversals,
  findFarthestPosition,
  identityMergeDispatch,
  moveTile,
  positionsEqual,
  prepareTiles,
  resolveMove,
  vectorForDirection,
} from '../../../src/engine/move-resolver';
import type {
  FarthestPosition,
  MergeDispatch,
  MoveOutcome,
  ResolvedMerge,
  Traversals,
} from '../../../src/engine/move-resolver';
import { Tile } from '../../../src/engine/tile';
import {
  DIRECTION_DOWN,
  DIRECTION_LEFT,
  DIRECTION_RIGHT,
  DIRECTION_UP,
} from '../../../src/engine/types';
import type {
  Direction,
  Position,
  SerializedGameState,
  Vector,
} from '../../../src/engine/types';
import {
  createBlockedBoard,
  createEmptyBoard,
  createMergePairBoard,
  createNearLossBoard,
  createNearWinBoard,
} from '../../fixtures/boards';


const EVERY_DIRECTION: readonly Direction[] = [
  DIRECTION_UP,
  DIRECTION_RIGHT,
  DIRECTION_DOWN,
  DIRECTION_LEFT,
];

const SHRUNK_SIZE = 3;

const GROWN_SIZE = 5;

const ROW_ZERO = 0;

const LONE_CELL: Position = { x: 1, y: 1 };

const LONE_VALUE = 2;

/** A value no rule produces, written by a dispatch that tries to interfere. */
const HUGE_VALUE = 999_999;

const BLOCKER_VALUE = 8;

const TRIPLE = 3;

const RESULT_BONUS = 6;

const DELTA_MULTIPLIER = 10;

function ascendingIndices(size: number): number[] {
  const indices: number[] = [];

  for (let pos = 0; pos < size; pos += 1) {
    indices.push(pos);
  }

  return indices;
}


function descendingIndices(size: number): number[] {
  return ascendingIndices(size).reverse();
}


function buildRowGrid(
  values: readonly (number | null)[],
  size: number = DEFAULT_BOARD_SIZE,
): Grid {
  const grid = new Grid(size);

  values.forEach((value, x) => {
    if (value !== null) {
      grid.insertTile(new Tile({ x, y: ROW_ZERO }, value));
    }
  });

  return grid;
}


function buildLoneTileGrid(size: number = DEFAULT_BOARD_SIZE): Grid {
  const grid = new Grid(size);

  grid.insertTile(new Tile(LONE_CELL, LONE_VALUE));

  return grid;
}


function rehydrate(board: SerializedGameState): Grid {
  return new Grid(board.grid.size, board.grid.cells);
}


function tileAt(grid: Grid, cell: Position): Tile {
  const tile = grid.cellContent(cell);

  if (tile === null) {
    throw new Error(`no tile at (${cell.x}, ${cell.y})`);
  }

  return tile;
}


function latticeValues(grid: Grid): (number | null)[][] {
  const values: (number | null)[][] = [];

  for (let x = 0; x < grid.size; x += 1) {
    const column: (number | null)[] = [];

    for (let y = 0; y < grid.size; y += 1) {
      const tile = grid.cells[x][y];

      column.push(tile === null ? null : tile.value);
    }

    values.push(column);
  }

  return values;
}


function countOccurrences(grid: Grid, tile: Tile): number {
  let count = 0;

  grid.eachCell((_x, _y, held) => {
    if (held === tile) {
      count += 1;
    }
  });

  return count;
}


function occupiedTiles(grid: Grid): Tile[] {
  const tiles: Tile[] = [];

  grid.eachCell((_x, _y, tile) => {
    if (tile !== null) {
      tiles.push(tile);
    }
  });

  return tiles;
}

interface TileOrigin {
  readonly tile: Tile;
  readonly cell: Position;
}

function originsOf(grid: Grid): TileOrigin[] {
  const origins: TileOrigin[] = [];

  grid.eachCell((x, y, tile) => {
    if (tile !== null) {
      origins.push({ tile, cell: { x, y } });
    }
  });

  return origins;
}


function anyTileLeftItsCell(origins: readonly TileOrigin[]): boolean {
  return origins.some((origin) => !positionsEqual(origin.cell, origin.tile));
}


function configWithMerge(
  canMerge: MergePredicate,
  produce: MergeProducer,
): RulesConfig {
  const config = createDefaultRulesConfig();

  config.merge = { canMerge, produce };

  return config;
}


function resolveDefault(grid: Grid, direction: Direction): MoveOutcome {
  return resolveMove(grid, direction, createDefaultRulesConfig());
}


function recordMergeWrites(grid: Grid, source: Tile): string[] {
  const calls: string[] = [];
  const insertTile = grid.insertTile.bind(grid);
  const removeTile = grid.removeTile.bind(grid);
  const updatePosition = source.updatePosition.bind(source);

  grid.insertTile = (tile: Tile): void => {
    calls.push('insertTile');
    insertTile(tile);
  };

  grid.removeTile = (tile: Tile): void => {
    calls.push('removeTile');
    removeTile(tile);
  };

  source.updatePosition = (position: Position): void => {
    calls.push('updatePosition');
    updatePosition(position);
  };

  return calls;
}


function recordInsertions(grid: Grid, calls: string[]): void {
  const insertTile = grid.insertTile.bind(grid);

  grid.insertTile = (tile: Tile): void => {
    calls.push(`insertTile:${tile.value}`);
    insertTile(tile);
  };
}


function recordPrepareWrites(tile: Tile): string[] {
  const writes: string[] = [];
  const savePosition = tile.savePosition.bind(tile);
  let mergedFrom = tile.mergedFrom;

  Object.defineProperty(tile, 'mergedFrom', {
    configurable: true,
    enumerable: true,
    get: (): [Tile, Tile] | null => mergedFrom,
    set: (next: [Tile, Tile] | null): void => {
      writes.push('mergedFrom');
      mergedFrom = next;
    },
  });

  tile.savePosition = (): void => {
    writes.push('savePosition');
    savePosition();
  };

  return writes;
}


function markMergedLastTurn(tile: Tile, stale: Position): void {
  tile.mergedFrom = [tile, tile];
  tile.previousPosition = { x: stale.x, y: stale.y };
}


describe('vectorForDirection (js/game_manager.js L196-L201)', () => {
  it('resolves direction 0 to the up vector (L197)', () => {
    expect(vectorForDirection(DIRECTION_UP)).toEqual({ x: 0, y: -1 });
  });

  it('resolves direction 1 to the right vector (L198)', () => {
    expect(vectorForDirection(DIRECTION_RIGHT)).toEqual({ x: 1, y: 0 });
  });

  it('resolves direction 2 to the down vector (L199)', () => {
    expect(vectorForDirection(DIRECTION_DOWN)).toEqual({ x: 0, y: 1 });
  });

  it('resolves direction 3 to the left vector (L200)', () => {
    expect(vectorForDirection(DIRECTION_LEFT)).toEqual({ x: -1, y: 0 });
  });

  it('keys by the bare numbers the input layer emits (L196-L201)', () => {
    expect(DIRECTION_UP).toBe(0);
    expect(DIRECTION_RIGHT).toBe(1);
    expect(DIRECTION_DOWN).toBe(2);
    expect(DIRECTION_LEFT).toBe(3);
    expect(vectorForDirection(0)).toEqual({ x: 0, y: -1 });
    expect(vectorForDirection(1)).toEqual({ x: 1, y: 0 });
    expect(vectorForDirection(2)).toEqual({ x: 0, y: 1 });
    expect(vectorForDirection(3)).toEqual({ x: -1, y: 0 });
  });

  it('resolves all four directions to a single-step delta (L196-L201)', () => {
    for (const direction of EVERY_DIRECTION) {
      const vector: Vector = vectorForDirection(direction);

      expect(Math.abs(vector.x) + Math.abs(vector.y)).toBe(1);
      expect([-1, 0, 1]).toContain(vector.x);
      expect([-1, 0, 1]).toContain(vector.y);
    }
  });

  it('resolves the four directions to four distinct vectors (L196)', () => {
    const seen = EVERY_DIRECTION.map((direction) => {
      const vector = vectorForDirection(direction);

      return `${vector.x},${vector.y}`;
    });

    expect(new Set(seen).size).toBe(EVERY_DIRECTION.length);
  });

  it('returns the same vector on every call (L203)', () => {
    for (const direction of EVERY_DIRECTION) {
      const first = vectorForDirection(direction);
      const second = vectorForDirection(direction);

      expect(first).toEqual(second);
    }
  });
});


describe('buildTraversals (js/game_manager.js L207-L220)', () => {
  it('pushes 0 to size - 1 onto both axes (L210-L213)', () => {
    const traversals: Traversals = buildTraversals(
      vectorForDirection(DIRECTION_LEFT),
      DEFAULT_BOARD_SIZE,
    );

    expect(traversals.x).toEqual(ascendingIndices(DEFAULT_BOARD_SIZE));
    expect(traversals.y).toEqual(ascendingIndices(DEFAULT_BOARD_SIZE));
  });

  it('reverses x when the vector x is 1 (L216)', () => {
    const traversals = buildTraversals({ x: 1, y: 0 }, DEFAULT_BOARD_SIZE);

    expect(traversals.x).toEqual(descendingIndices(DEFAULT_BOARD_SIZE));
  });

  it('leaves x ascending when the vector x is -1 (L216)', () => {
    const traversals = buildTraversals({ x: -1, y: 0 }, DEFAULT_BOARD_SIZE);

    expect(traversals.x).toEqual(ascendingIndices(DEFAULT_BOARD_SIZE));
  });

  it('reverses y when the vector y is 1 (L217)', () => {
    const traversals = buildTraversals({ x: 0, y: 1 }, DEFAULT_BOARD_SIZE);

    expect(traversals.y).toEqual(descendingIndices(DEFAULT_BOARD_SIZE));
  });

  it('leaves y ascending when the vector y is -1 (L217)', () => {
    const traversals = buildTraversals({ x: 0, y: -1 }, DEFAULT_BOARD_SIZE);

    expect(traversals.y).toEqual(ascendingIndices(DEFAULT_BOARD_SIZE));
  });

  it('leaves an axis ascending when its component is 0 (L216-L217)', () => {
    const rightward = buildTraversals({ x: 1, y: 0 }, DEFAULT_BOARD_SIZE);
    const downward = buildTraversals({ x: 0, y: 1 }, DEFAULT_BOARD_SIZE);

    expect(rightward.y).toEqual(ascendingIndices(DEFAULT_BOARD_SIZE));
    expect(downward.x).toEqual(ascendingIndices(DEFAULT_BOARD_SIZE));
  });

  it('produces the visit order of all four directions (L216-L217)', () => {
    const ascending = ascendingIndices(DEFAULT_BOARD_SIZE);
    const descending = descendingIndices(DEFAULT_BOARD_SIZE);

    const up = buildTraversals(
      vectorForDirection(DIRECTION_UP),
      DEFAULT_BOARD_SIZE,
    );
    const right = buildTraversals(
      vectorForDirection(DIRECTION_RIGHT),
      DEFAULT_BOARD_SIZE,
    );
    const down = buildTraversals(
      vectorForDirection(DIRECTION_DOWN),
      DEFAULT_BOARD_SIZE,
    );
    const left = buildTraversals(
      vectorForDirection(DIRECTION_LEFT),
      DEFAULT_BOARD_SIZE,
    );

    expect(up.x).toEqual(ascending);
    expect(up.y).toEqual(ascending);
    expect(right.x).toEqual(descending);
    expect(right.y).toEqual(ascending);
    expect(down.x).toEqual(ascending);
    expect(down.y).toEqual(descending);
    expect(left.x).toEqual(ascending);
    expect(left.y).toEqual(ascending);
  });

  it('is driven by the size it is passed, at size 3 and size 5 (L210)', () => {
    for (const size of [SHRUNK_SIZE, GROWN_SIZE]) {
      const ascending = ascendingIndices(size);
      const descending = descendingIndices(size);

      const right = buildTraversals(vectorForDirection(DIRECTION_RIGHT), size);
      const down = buildTraversals(vectorForDirection(DIRECTION_DOWN), size);
      const left = buildTraversals(vectorForDirection(DIRECTION_LEFT), size);

      expect(right.x).toEqual(descending);
      expect(right.y).toEqual(ascending);
      expect(down.x).toEqual(ascending);
      expect(down.y).toEqual(descending);
      expect(left.x).toEqual(ascending);
      expect(left.y).toEqual(ascending);
    }
  });

  it('lists every index of the passed size exactly once (L210-L213)', () => {
    for (const size of [SHRUNK_SIZE, DEFAULT_BOARD_SIZE, GROWN_SIZE]) {
      for (const direction of EVERY_DIRECTION) {
        const traversals = buildTraversals(
          vectorForDirection(direction),
          size,
        );

        expect(traversals.x).toHaveLength(size);
        expect(traversals.y).toHaveLength(size);
        expect(new Set(traversals.x).size).toBe(size);
        expect(new Set(traversals.y).size).toBe(size);
        expect([...traversals.x].sort()).toEqual(
          [...traversals.y].sort(),
        );
      }
    }
  });

  it('yields an empty order for a size of 0 (L210)', () => {
    const traversals = buildTraversals(
      vectorForDirection(DIRECTION_RIGHT),
      0,
    );

    expect(traversals.x).toEqual([]);
    expect(traversals.y).toEqual([]);
  });
});


describe('findFarthestPosition (js/game_manager.js L222-L236)', () => {
  it('walks an unobstructed tile to the wall (L226-L233)', () => {
    const grid = buildLoneTileGrid();
    const positions: FarthestPosition = findFarthestPosition(
      grid,
      LONE_CELL,
      vectorForDirection(DIRECTION_LEFT),
    );

    expect(positions.farthest).toEqual({ x: 0, y: LONE_CELL.y });
    expect(positions.next).toEqual({ x: -1, y: LONE_CELL.y });
    expect(grid.withinBounds(positions.next)).toBe(false);
  });

  it('leaves next outside the lattice at every wall (L229-L234)', () => {
    const last = DEFAULT_BOARD_SIZE - 1;
    const beyond = DEFAULT_BOARD_SIZE;

    const walls: readonly {
      readonly direction: Direction;
      readonly farthest: Position;
      readonly next: Position;
    }[] = [
      {
        direction: DIRECTION_UP,
        farthest: { x: LONE_CELL.x, y: 0 },
        next: { x: LONE_CELL.x, y: -1 },
      },
      {
        direction: DIRECTION_RIGHT,
        farthest: { x: last, y: LONE_CELL.y },
        next: { x: beyond, y: LONE_CELL.y },
      },
      {
        direction: DIRECTION_DOWN,
        farthest: { x: LONE_CELL.x, y: last },
        next: { x: LONE_CELL.x, y: beyond },
      },
      {
        direction: DIRECTION_LEFT,
        farthest: { x: 0, y: LONE_CELL.y },
        next: { x: -1, y: LONE_CELL.y },
      },
    ];

    for (const wall of walls) {
      const grid = buildLoneTileGrid();
      const positions = findFarthestPosition(
        grid,
        LONE_CELL,
        vectorForDirection(wall.direction),
      );

      expect(positions.farthest).toEqual(wall.farthest);
      expect(positions.next).toEqual(wall.next);
      expect(grid.withinBounds(positions.next)).toBe(false);
      expect(grid.cellContent(positions.next)).toBeNull();
    }
  });

  it('terminates on the bounds valve of cellContent (L229-L230)', () => {
    for (const direction of EVERY_DIRECTION) {
      const grid = buildLoneTileGrid();
      const vector = vectorForDirection(direction);
      const positions = findFarthestPosition(grid, LONE_CELL, vector);
      const oneStepOn: Position = {
        x: positions.farthest.x + vector.x,
        y: positions.farthest.y + vector.y,
      };

      expect(positions.next).toEqual(oneStepOn);
      expect(grid.withinBounds(positions.farthest)).toBe(true);
      expect(grid.withinBounds(positions.next)).toBe(false);
    }
  });

  it('stops adjacent to an occupant, next naming it (L229-L235)', () => {
    const grid = new Grid(DEFAULT_BOARD_SIZE);
    const occupantCell: Position = { x: 0, y: ROW_ZERO };
    const startCell: Position = { x: DEFAULT_BOARD_SIZE - 1, y: ROW_ZERO };

    grid.insertTile(new Tile(occupantCell, BLOCKER_VALUE));
    grid.insertTile(new Tile(startCell, LONE_VALUE));

    const occupant = tileAt(grid, occupantCell);
    const positions = findFarthestPosition(
      grid,
      startCell,
      vectorForDirection(DIRECTION_LEFT),
    );

    expect(positions.farthest).toEqual({ x: 1, y: ROW_ZERO });
    expect(positions.next).toEqual(occupantCell);
    expect(grid.withinBounds(positions.next)).toBe(true);
    expect(grid.cellContent(positions.next)).toBe(occupant);
  });

  it('returns the start cell when the neighbour is taken (L226-L233)', () => {
    const grid = new Grid(DEFAULT_BOARD_SIZE);
    const occupantCell: Position = { x: 0, y: ROW_ZERO };
    const startCell: Position = { x: 1, y: ROW_ZERO };

    grid.insertTile(new Tile(occupantCell, BLOCKER_VALUE));
    grid.insertTile(new Tile(startCell, LONE_VALUE));

    const occupant = tileAt(grid, occupantCell);
    const positions = findFarthestPosition(
      grid,
      startCell,
      vectorForDirection(DIRECTION_LEFT),
    );

    expect(positions.farthest).toBe(startCell);
    expect(positions.next).toEqual(occupantCell);
    expect(grid.cellContent(positions.next)).toBe(occupant);
  });

  it('returns the starting cell for a tile at the wall (L223-L233)', () => {
    const grid = new Grid(DEFAULT_BOARD_SIZE);
    const startCell: Position = { x: 0, y: ROW_ZERO };

    grid.insertTile(new Tile(startCell, LONE_VALUE));

    const positions = findFarthestPosition(
      grid,
      startCell,
      vectorForDirection(DIRECTION_LEFT),
    );

    expect(positions.farthest).toBe(startCell);
    expect(positions.next).toEqual({ x: -1, y: ROW_ZERO });
    expect(grid.withinBounds(positions.next)).toBe(false);
  });

  it('steps before testing, so its own cell never stops it (L226-L230)', () => {
    const grid = buildLoneTileGrid();

    expect(grid.cellAvailable(LONE_CELL)).toBe(false);

    const positions = findFarthestPosition(
      grid,
      LONE_CELL,
      vectorForDirection(DIRECTION_LEFT),
    );

    expect(positions.farthest).not.toEqual(LONE_CELL);
    expect(positions.farthest).toEqual({ x: 0, y: LONE_CELL.y });
  });

  it('allocates a fresh position for each step (L228)', () => {
    const grid = buildLoneTileGrid();
    const positions = findFarthestPosition(
      grid,
      LONE_CELL,
      vectorForDirection(DIRECTION_LEFT),
    );

    expect(positions.farthest).not.toBe(positions.next);
    expect(positions.farthest).not.toBe(LONE_CELL);
  });

  it('reads the size of the grid it is passed (L229)', () => {
    for (const size of [SHRUNK_SIZE, GROWN_SIZE]) {
      const grid = new Grid(size);
      const startCell: Position = { x: 0, y: ROW_ZERO };

      grid.insertTile(new Tile(startCell, LONE_VALUE));

      const positions = findFarthestPosition(
        grid,
        startCell,
        vectorForDirection(DIRECTION_RIGHT),
      );

      expect(positions.farthest).toEqual({ x: size - 1, y: ROW_ZERO });
      expect(positions.next).toEqual({ x: size, y: ROW_ZERO });
    }
  });
});


describe('positionsEqual (js/game_manager.js L270-L272)', () => {
  it('reports two equal coordinate pairs as equal (L271)', () => {
    expect(positionsEqual({ x: 0, y: 0 }, { x: 0, y: 0 })).toBe(true);
    expect(positionsEqual({ x: 2, y: 3 }, { x: 2, y: 3 })).toBe(true);
  });

  it('reports a differing x as unequal (L271)', () => {
    expect(positionsEqual({ x: 1, y: 3 }, { x: 2, y: 3 })).toBe(false);
  });

  it('reports a differing y as unequal (L271)', () => {
    expect(positionsEqual({ x: 2, y: 1 }, { x: 2, y: 3 })).toBe(false);
  });

  it('reports two differing coordinates as unequal (L271)', () => {
    expect(positionsEqual({ x: 1, y: 1 }, { x: 2, y: 3 })).toBe(false);
  });

  it('compares an off-lattice pair like any other (L271)', () => {
    expect(positionsEqual({ x: -1, y: 2 }, { x: -1, y: 2 })).toBe(true);
    expect(positionsEqual({ x: -1, y: 2 }, { x: 0, y: 2 })).toBe(false);
  });

  it('accepts a tile in place of a position (js/tile.js L2-L3)', () => {
    const cell: Position = { x: 2, y: 3 };
    const tile = new Tile(cell, BLOCKER_VALUE);

    expect(positionsEqual(cell, tile)).toBe(true);
    expect(positionsEqual(tile, cell)).toBe(true);
  });

  it('follows the flattened coordinates of a tile as it moves (L271)', () => {
    const cell: Position = { x: 2, y: 3 };
    const tile = new Tile(cell, BLOCKER_VALUE);

    tile.updatePosition({ x: 0, y: 3 });

    expect(positionsEqual(cell, tile)).toBe(false);
    expect(positionsEqual({ x: 0, y: 3 }, tile)).toBe(true);
  });

  it('compares coordinates only, not the whole tile (L271)', () => {
    const cell: Position = { x: 2, y: 3 };
    const tile = new Tile(cell, BLOCKER_VALUE);

    tile.savePosition();

    expect(positionsEqual(cell, tile)).toBe(true);
    expect(tile).not.toEqual(cell);
  });

  it('is symmetric in its two arguments (L271)', () => {
    const first: Position = { x: 1, y: 2 };
    const second: Position = { x: 3, y: 2 };

    expect(positionsEqual(first, second)).toBe(
      positionsEqual(second, first),
    );
    expect(positionsEqual(first, first)).toBe(true);
  });
});


describe('prepareTiles (js/game_manager.js L113-L120)', () => {
  it('clears mergedFrom on every occupied cell (L116)', () => {
    const grid = buildRowGrid([2, 4, BLOCKER_VALUE, 16]);

    for (const tile of occupiedTiles(grid)) {
      markMergedLastTurn(tile, { x: 9, y: 9 });
      expect(tile.mergedFrom).not.toBeNull();
    }

    prepareTiles(grid);

    for (const tile of occupiedTiles(grid)) {
      expect(tile.mergedFrom).toBeNull();
    }
  });

  it('records the cell of each tile as its previous position (L117)', () => {
    const grid = buildRowGrid([2, 4, BLOCKER_VALUE, 16]);

    prepareTiles(grid);

    grid.eachCell((x, y, tile) => {
      if (tile !== null) {
        expect(tile.previousPosition).toEqual({ x, y });
      }
    });
  });

  it('overwrites a merge left from the previous turn (L116-L117)', () => {
    const grid = buildRowGrid([2, 4]);
    const tile = tileAt(grid, { x: 1, y: ROW_ZERO });

    markMergedLastTurn(tile, { x: 3, y: 2 });
    prepareTiles(grid);
    expect(tile.mergedFrom).toBeNull();
    expect(tile.previousPosition).toEqual({ x: 1, y: ROW_ZERO });
  });

  it('writes mergedFrom before the position snapshot (L116-L117)', () => {
    const grid = buildRowGrid([2]);
    const tile = tileAt(grid, { x: 0, y: ROW_ZERO });

    markMergedLastTurn(tile, { x: 3, y: 3 });

    const writes = recordPrepareWrites(tile);

    prepareTiles(grid);
    expect(writes).toEqual(['mergedFrom', 'savePosition']);
    expect(tile.mergedFrom).toBeNull();
    expect(tile.previousPosition).toEqual({ x: 0, y: ROW_ZERO });
  });

  it('leaves every empty cell empty (L114-L118)', () => {
    const grid = buildRowGrid([2, null, BLOCKER_VALUE]);
    const before = latticeValues(grid);

    prepareTiles(grid);
    expect(latticeValues(grid)).toEqual(before);
    expect(grid.availableCells()).toHaveLength(
      DEFAULT_BOARD_SIZE * DEFAULT_BOARD_SIZE - 2,
    );
  });

  it('visits every cell of the lattice (L114)', () => {
    const grid = new Grid(DEFAULT_BOARD_SIZE);

    grid.eachCell((x, y) => {
      const tile = new Tile({ x, y }, LONE_VALUE);

      markMergedLastTurn(tile, { x: 9, y: 9 });
      grid.insertTile(tile);
    });

    prepareTiles(grid);

    const prepared = occupiedTiles(grid);

    expect(prepared).toHaveLength(DEFAULT_BOARD_SIZE * DEFAULT_BOARD_SIZE);

    for (const tile of prepared) {
      expect(tile.mergedFrom).toBeNull();
      expect(tile.previousPosition).toEqual({ x: tile.x, y: tile.y });
    }
  });

  it('visits every cell at size 3 and size 5 (L114)', () => {
    for (const size of [SHRUNK_SIZE, GROWN_SIZE]) {
      const grid = new Grid(size);

      grid.eachCell((x, y) => {
        grid.insertTile(new Tile({ x, y }, LONE_VALUE));
      });

      prepareTiles(grid);

      const prepared = occupiedTiles(grid);

      expect(prepared).toHaveLength(size * size);

      for (const tile of prepared) {
        expect(tile.previousPosition).toEqual({ x: tile.x, y: tile.y });
      }
    }
  });

  it('records a copy, so a later move leaves it alone (L117)', () => {
    const grid = buildRowGrid([2]);
    const tile = tileAt(grid, { x: 0, y: ROW_ZERO });

    prepareTiles(grid);

    const recorded = tile.previousPosition;

    tile.updatePosition({ x: 2, y: ROW_ZERO });

    expect(recorded).toEqual({ x: 0, y: ROW_ZERO });
    expect(tile.previousPosition).toEqual({ x: 0, y: ROW_ZERO });
    expect(tile.x).toBe(2);
  });

  it('does nothing to an empty lattice (L114-L118)', () => {
    const grid = new Grid(DEFAULT_BOARD_SIZE);

    prepareTiles(grid);
    expect(occupiedTiles(grid)).toHaveLength(0);
    expect(grid.availableCells()).toHaveLength(
      DEFAULT_BOARD_SIZE * DEFAULT_BOARD_SIZE,
    );
  });

  it('leaves face values untouched (L116-L117)', () => {
    const grid = buildRowGrid([2, 4, BLOCKER_VALUE, 16]);
    const before = latticeValues(grid);

    prepareTiles(grid);
    expect(latticeValues(grid)).toEqual(before);
  });
});


describe('moveTile (js/game_manager.js L123-L127)', () => {
  it('clears the cell the tile is leaving (L124)', () => {
    const grid = buildRowGrid([LONE_VALUE]);
    const tile = tileAt(grid, { x: 0, y: ROW_ZERO });

    moveTile(grid, tile, { x: DEFAULT_BOARD_SIZE - 1, y: ROW_ZERO });
    expect(grid.cells[0][ROW_ZERO]).toBeNull();
  });

  it('writes the tile into the destination cell (L125)', () => {
    const grid = buildRowGrid([LONE_VALUE]);
    const tile = tileAt(grid, { x: 0, y: ROW_ZERO });
    const destination: Position = {
      x: DEFAULT_BOARD_SIZE - 1,
      y: ROW_ZERO,
    };

    moveTile(grid, tile, destination);
    expect(grid.cells[destination.x][destination.y]).toBe(tile);
    expect(grid.cellContent(destination)).toBe(tile);
  });

  it('updates the flattened coordinates of the tile (L126)', () => {
    const grid = buildRowGrid([LONE_VALUE]);
    const tile = tileAt(grid, { x: 0, y: ROW_ZERO });
    const destination: Position = { x: 2, y: ROW_ZERO };

    moveTile(grid, tile, destination);
    expect(tile.x).toBe(destination.x);
    expect(tile.y).toBe(destination.y);
    expect(positionsEqual(destination, tile)).toBe(true);
  });

  it('leaves the tile in exactly one cell (L124-L126)', () => {
    const grid = buildRowGrid([LONE_VALUE]);
    const tile = tileAt(grid, { x: 0, y: ROW_ZERO });

    moveTile(grid, tile, { x: DEFAULT_BOARD_SIZE - 1, y: ROW_ZERO });
    expect(countOccurrences(grid, tile)).toBe(1);
    expect(occupiedTiles(grid)).toEqual([tile]);
  });

  it('keeps the tile when the destination is its own cell (L124-L126)', () => {
    const grid = buildRowGrid([LONE_VALUE]);
    const cell: Position = { x: 0, y: ROW_ZERO };
    const tile = tileAt(grid, cell);

    moveTile(grid, tile, cell);
    expect(grid.cellContent(cell)).toBe(tile);
    expect(countOccurrences(grid, tile)).toBe(1);
    expect(tile.x).toBe(cell.x);
    expect(tile.y).toBe(cell.y);
  });

  it('leaves every other cell as it was (L124-L125)', () => {
    const grid = buildRowGrid([LONE_VALUE, null, BLOCKER_VALUE]);
    const tile = tileAt(grid, { x: 0, y: ROW_ZERO });

    moveTile(grid, tile, { x: 1, y: ROW_ZERO });
    expect(latticeValues(grid)[0][ROW_ZERO]).toBeNull();
    expect(latticeValues(grid)[1][ROW_ZERO]).toBe(LONE_VALUE);
    expect(latticeValues(grid)[2][ROW_ZERO]).toBe(BLOCKER_VALUE);
    expect(occupiedTiles(grid)).toHaveLength(2);
  });

  it('writes only the two coordinates on the tile (L126)', () => {
    const grid = buildRowGrid([LONE_VALUE]);
    const tile = tileAt(grid, { x: 0, y: ROW_ZERO });

    prepareTiles(grid);
    moveTile(grid, tile, { x: 2, y: ROW_ZERO });
    expect(tile.previousPosition).toEqual({ x: 0, y: ROW_ZERO });
    expect(tile.mergedFrom).toBeNull();
    expect(tile.value).toBe(LONE_VALUE);
  });

  it('does not retain the destination object (L126)', () => {
    const grid = buildRowGrid([LONE_VALUE]);
    const tile = tileAt(grid, { x: 0, y: ROW_ZERO });
    const destination: Position = { x: 2, y: ROW_ZERO };

    moveTile(grid, tile, destination);

    destination.x = 0;

    expect(tile.x).toBe(2);
    expect(grid.cells[2][ROW_ZERO]).toBe(tile);
  });
});


describe('resolveMove merge branch (js/game_manager.js L156-L170)', () => {
  it('reads config.merge.canMerge for the merge test (L156)', () => {
    const canMerge = vi.fn(defaultCanMerge);
    const config = configWithMerge(canMerge, defaultProduceMergeValue);
    const grid = rehydrate(createMergePairBoard());
    const target = tileAt(grid, { x: 0, y: ROW_ZERO });
    const source = tileAt(grid, { x: 1, y: ROW_ZERO });

    const outcome = resolveMove(grid, DIRECTION_LEFT, config);

    expect(canMerge).toHaveBeenCalledTimes(1);
    expect(canMerge.mock.calls[0][0]).toBe(source);
    expect(canMerge.mock.calls[0][1]).toBe(target);
    expect(outcome.merges).toHaveLength(1);
  });

  it('merges no pair when the predicate refuses (L156)', () => {
    const alwaysBlocked: MergePredicate = () => false;
    const config = configWithMerge(alwaysBlocked, defaultProduceMergeValue);
    const grid = rehydrate(createMergePairBoard());
    const last = DEFAULT_BOARD_SIZE - 1;

    const outcome = resolveMove(grid, DIRECTION_RIGHT, config);

    expect(outcome.merges).toEqual([]);
    expect(outcome.scoreDelta).toBe(0);
    expect(outcome.moved).toBe(true);
    expect(occupiedTiles(grid)).toHaveLength(2);
    expect(latticeValues(grid)[last][ROW_ZERO]).toBe(LONE_VALUE);
    expect(latticeValues(grid)[last - 1][ROW_ZERO]).toBe(LONE_VALUE);
  });

  it('reads config.merge.produce for the face value (L157)', () => {
    const tripleProducer: MergeProducer = (moving: MergeTileView) =>
      moving.value * TRIPLE;
    const config = configWithMerge(defaultCanMerge, tripleProducer);
    const grid = rehydrate(createMergePairBoard());
    const expected = LONE_VALUE * TRIPLE;

    const outcome = resolveMove(grid, DIRECTION_LEFT, config);

    expect(outcome.merges).toHaveLength(1);
    expect(outcome.merges[0].merged.value).toBe(expected);
    expect(outcome.scoreDelta).toBe(expected);
    expect(tileAt(grid, { x: 0, y: ROW_ZERO }).value).toBe(expected);
  });

  it('calls the producer only for an accepted pair (L156-L157)', () => {
    const accepted = vi.fn(defaultProduceMergeValue);
    const refused = vi.fn(defaultProduceMergeValue);
    const alwaysBlocked: MergePredicate = () => false;

    resolveMove(
      rehydrate(createMergePairBoard()),
      DIRECTION_LEFT,
      configWithMerge(defaultCanMerge, accepted),
    );
    resolveMove(
      rehydrate(createMergePairBoard()),
      DIRECTION_LEFT,
      configWithMerge(alwaysBlocked, refused),
    );

    expect(accepted).toHaveBeenCalledTimes(1);
    expect(refused).toHaveBeenCalledTimes(0);
  });

  it('reproduces the vanilla predicate under the defaults (L156)', () => {
    const equalPair = buildRowGrid([LONE_VALUE, LONE_VALUE]);
    const unequalPair = buildRowGrid([LONE_VALUE, BLOCKER_VALUE]);

    const merged = resolveDefault(equalPair, DIRECTION_LEFT);
    const slid = resolveDefault(unequalPair, DIRECTION_LEFT);

    expect(merged.merges).toHaveLength(1);
    expect(slid.merges).toEqual([]);
    expect(latticeValues(unequalPair)[0][ROW_ZERO]).toBe(LONE_VALUE);
    expect(latticeValues(unequalPair)[1][ROW_ZERO]).toBe(BLOCKER_VALUE);
  });

  it('reproduces the vanilla producer under the defaults (L157)', () => {
    const grid = buildRowGrid([LONE_VALUE, LONE_VALUE]);

    const outcome = resolveDefault(grid, DIRECTION_LEFT);

    expect(outcome.merges[0].merged.value).toBe(LONE_VALUE * 2);
    expect(outcome.scoreDelta).toBe(LONE_VALUE * 2);
  });

  it('never invokes the predicate for an absent neighbour (L156)', () => {
    const canMerge = vi.fn(() => true);
    const config = configWithMerge(canMerge, defaultProduceMergeValue);
    const grid = buildLoneTileGrid();

    const outcome = resolveMove(grid, DIRECTION_LEFT, config);

    expect(canMerge).toHaveBeenCalledTimes(0);
    expect(outcome.merges).toEqual([]);
    expect(outcome.moved).toBe(true);
  });

  it('never invokes the predicate for an empty lattice (L151, L156)', () => {
    const canMerge = vi.fn(() => true);
    const config = configWithMerge(canMerge, defaultProduceMergeValue);

    for (const direction of EVERY_DIRECTION) {
      resolveMove(rehydrate(createEmptyBoard()), direction, config);
    }

    expect(canMerge).toHaveBeenCalledTimes(0);
  });

  it('records both source tiles on the merged tile, in order (L158)', () => {
    const grid = rehydrate(createMergePairBoard());
    const target = tileAt(grid, { x: 0, y: ROW_ZERO });
    const source = tileAt(grid, { x: 1, y: ROW_ZERO });

    const outcome = resolveDefault(grid, DIRECTION_LEFT);
    const merge: ResolvedMerge = outcome.merges[0];

    expect(merge.merged.mergedFrom).toHaveLength(2);
    expect(merge.merged.mergedFrom?.[0]).toBe(source);
    expect(merge.merged.mergedFrom?.[1]).toBe(target);
    expect(merge.source).toBe(source);
    expect(merge.target).toBe(target);
    expect(merge.merged).not.toBe(source);
    expect(merge.merged).not.toBe(target);
  });

  it('inserts the merged tile before clearing the source (L160-L161)', () => {
    const grid = rehydrate(createMergePairBoard());
    const source = tileAt(grid, { x: 1, y: ROW_ZERO });
    const calls = recordMergeWrites(grid, source);

    resolveDefault(grid, DIRECTION_LEFT);
    expect(calls).toEqual(['insertTile', 'removeTile', 'updatePosition']);
  });

  it('holds the merged tile and empties the source cell (L160-L161)', () => {
    const grid = rehydrate(createMergePairBoard());
    const destination: Position = { x: 0, y: ROW_ZERO };
    const sourceCell: Position = { x: 1, y: ROW_ZERO };

    const outcome = resolveDefault(grid, DIRECTION_LEFT);
    const merged = outcome.merges[0].merged;

    expect(grid.cellContent(destination)).toBe(merged);
    expect(grid.cellContent(sourceCell)).toBeNull();
    expect(countOccurrences(grid, merged)).toBe(1);
    expect(occupiedTiles(grid)).toEqual([merged]);
    expect(merged.value).toBe(LONE_VALUE * 2);
  });

  it('converges the source tile onto the destination (L164)', () => {
    const grid = rehydrate(createMergePairBoard());
    const sourceCell: Position = { x: 1, y: ROW_ZERO };
    const destination: Position = { x: 0, y: ROW_ZERO };
    const source = tileAt(grid, sourceCell);

    resolveDefault(grid, DIRECTION_LEFT);
    expect(positionsEqual(destination, source)).toBe(true);
    expect(positionsEqual(sourceCell, source)).toBe(false);
    expect(countOccurrences(grid, source)).toBe(0);
  });

  it('reports the score one merge added (L167)', () => {
    const grid = buildRowGrid([LONE_VALUE, LONE_VALUE]);

    const outcome = resolveDefault(grid, DIRECTION_LEFT);

    expect(outcome.scoreDelta).toBe(LONE_VALUE * 2);
    expect(outcome.merges[0].scoreDelta).toBe(LONE_VALUE * 2);
  });

  it('sums the score over a move with two merges (L167)', () => {
    const grid = buildRowGrid([
      LONE_VALUE,
      LONE_VALUE,
      LONE_VALUE,
      LONE_VALUE,
    ]);

    const outcome = resolveDefault(grid, DIRECTION_LEFT);
    const merged = LONE_VALUE * 2;

    expect(outcome.merges).toHaveLength(2);
    expect(outcome.scoreDelta).toBe(merged * 2);
    expect(
      outcome.merges.reduce((total, merge) => total + merge.scoreDelta, 0),
    ).toBe(outcome.scoreDelta);
  });

  it('reports the delta and touches no score of its own (L167)', () => {
    const board = createMergePairBoard();
    const grid = rehydrate(board);
    const config = createDefaultRulesConfig();

    const outcome = resolveMove(grid, DIRECTION_LEFT, config);

    expect(outcome.scoreDelta).toBe(LONE_VALUE * 2);
    expect(board.score).toBe(0);
    expect(config).not.toHaveProperty('score');
    expect(grid).not.toHaveProperty('score');
  });

  it('reports no delta when nothing merged (L167)', () => {
    const grid = rehydrate(createBlockedBoard());

    const outcome = resolveDefault(grid, DIRECTION_LEFT);

    expect(outcome.scoreDelta).toBe(0);
    expect(outcome.merges).toEqual([]);
  });

  it('merges each pair once per traversal (L156)', () => {
    const grid = buildRowGrid([
      LONE_VALUE,
      LONE_VALUE,
      LONE_VALUE,
      LONE_VALUE,
    ]);
    const merged = LONE_VALUE * 2;

    const outcome = resolveDefault(grid, DIRECTION_LEFT);

    expect(outcome.merges).toHaveLength(2);
    expect(latticeValues(grid)[0][ROW_ZERO]).toBe(merged);
    expect(latticeValues(grid)[1][ROW_ZERO]).toBe(merged);
    expect(latticeValues(grid)[2][ROW_ZERO]).toBeNull();
    expect(latticeValues(grid)[3][ROW_ZERO]).toBeNull();
    expect(occupiedTiles(grid).map((tile) => tile.value)).toEqual([
      merged,
      merged,
    ]);
  });

  it('does not merge into a tile that merged this turn (L156)', () => {
    const grid = buildRowGrid([LONE_VALUE, LONE_VALUE, LONE_VALUE * 2]);
    const merged = LONE_VALUE * 2;

    const outcome = resolveDefault(grid, DIRECTION_LEFT);
    const blocked = tileAt(grid, { x: 1, y: ROW_ZERO });

    expect(outcome.merges).toHaveLength(1);
    expect(outcome.scoreDelta).toBe(merged);
    expect(tileAt(grid, { x: 0, y: ROW_ZERO }).value).toBe(merged);
    expect(blocked.value).toBe(merged);
    expect(blocked.mergedFrom).toBeNull();
    expect(occupiedTiles(grid)).toHaveLength(2);
  });

  it('leaves the win test to terminal-state (L170)', () => {
    const winValue = createDefaultRulesConfig().winValue;
    const grid = rehydrate(createNearWinBoard());

    const outcome = resolveDefault(grid, DIRECTION_LEFT);

    expect(outcome.merges).toHaveLength(1);
    expect(outcome.merges[0].merged.value).toBe(winValue);
    expect(outcome.scoreDelta).toBe(winValue);
    expect(Object.keys(outcome).sort()).toEqual([
      'merges',
      'moved',
      'scoreDelta',
    ]);
    expect(outcome).not.toHaveProperty('won');
    expect(outcome).not.toHaveProperty('over');
  });

  it('reports a produced value above the win value plainly (L170)', () => {
    const winValue = createDefaultRulesConfig().winValue;
    const grid = buildRowGrid([winValue, winValue]);

    const outcome = resolveDefault(grid, DIRECTION_LEFT);

    expect(outcome.merges[0].merged.value).toBe(winValue * 2);
    expect(outcome).not.toHaveProperty('won');
  });
});


describe('resolveMove reposition branch (js/game_manager.js L172)', () => {
  it('slides a tile to the farthest empty cell (L172)', () => {
    const grid = buildLoneTileGrid();
    const tile = tileAt(grid, LONE_CELL);

    const outcome = resolveDefault(grid, DIRECTION_LEFT);

    expect(grid.cellContent({ x: 0, y: LONE_CELL.y })).toBe(tile);
    expect(grid.cellContent(LONE_CELL)).toBeNull();
    expect(countOccurrences(grid, tile)).toBe(1);
    expect(outcome.moved).toBe(true);
    expect(outcome.merges).toEqual([]);
  });

  it('leaves a blocked tile in its own cell (L172)', () => {
    const grid = rehydrate(createBlockedBoard());
    const before = latticeValues(grid);

    const outcome = resolveDefault(grid, DIRECTION_UP);

    expect(latticeValues(grid)).toEqual(before);
    expect(outcome.moved).toBe(false);
    expect(outcome.merges).toEqual([]);
  });

  it('takes the reposition path when the predicate refuses (L172)', () => {
    const alwaysBlocked: MergePredicate = () => false;
    const config = configWithMerge(alwaysBlocked, defaultProduceMergeValue);
    const grid = rehydrate(createMergePairBoard());
    const target = tileAt(grid, { x: 0, y: ROW_ZERO });
    const source = tileAt(grid, { x: 1, y: ROW_ZERO });
    const last = DEFAULT_BOARD_SIZE - 1;

    resolveMove(grid, DIRECTION_RIGHT, config);
    expect(grid.cellContent({ x: last, y: ROW_ZERO })).toBe(source);
    expect(grid.cellContent({ x: last - 1, y: ROW_ZERO })).toBe(target);
    expect(source.value).toBe(LONE_VALUE);
    expect(target.value).toBe(LONE_VALUE);
  });

  it('takes the reposition path past a merged neighbour (L156, L172)', () => {
    const grid = buildRowGrid([LONE_VALUE, LONE_VALUE, LONE_VALUE * 2]);
    const blocked = tileAt(grid, { x: 2, y: ROW_ZERO });

    resolveDefault(grid, DIRECTION_LEFT);
    expect(grid.cellContent({ x: 1, y: ROW_ZERO })).toBe(blocked);
    expect(grid.cellContent({ x: 2, y: ROW_ZERO })).toBeNull();
    expect(blocked.mergedFrom).toBeNull();
  });

  it('reports no change for a tile whose farthest is its cell (L172)', () => {
    const grid = rehydrate(createBlockedBoard());
    const origins = originsOf(grid);
    const vector = vectorForDirection(DIRECTION_UP);

    for (const origin of origins) {
      const positions = findFarthestPosition(grid, origin.cell, vector);

      expect(positions.farthest).toEqual(origin.cell);
    }

    const outcome = resolveDefault(grid, DIRECTION_UP);

    expect(outcome.moved).toBe(false);

    for (const origin of origins) {
      expect(positionsEqual(origin.cell, origin.tile)).toBe(true);
    }
  });
});


describe('positionsEqual call site (js/game_manager.js L175-L177)', () => {
  it('reads the live coordinates of the tile to report a move (L175)', () => {
    const grid = rehydrate(createMergePairBoard());
    const sourceCell: Position = { x: 1, y: ROW_ZERO };
    const source = tileAt(grid, sourceCell);

    const outcome = resolveDefault(grid, DIRECTION_LEFT);

    expect(positionsEqual(sourceCell, source)).toBe(false);
    expect(outcome.moved).toBe(true);
  });

  it('is not the previousPosition comparison (L117, L175)', () => {
    const grid = rehydrate(createMergePairBoard());
    const sourceCell: Position = { x: 1, y: ROW_ZERO };
    const source = tileAt(grid, sourceCell);

    const outcome = resolveDefault(grid, DIRECTION_LEFT);
    const recorded = source.previousPosition;

    expect(recorded).not.toBeNull();
    expect(positionsEqual(sourceCell, recorded as Position)).toBe(true);
    expect(positionsEqual(sourceCell, source)).toBe(false);
    expect(outcome.moved).toBe(true);
  });

  it('agrees with the comparison over every starting tile (L175-L177)', () => {
    const boards: readonly (() => SerializedGameState)[] = [
      createEmptyBoard,
      createMergePairBoard,
      createBlockedBoard,
      createNearWinBoard,
      createNearLossBoard,
    ];

    for (const makeBoard of boards) {
      for (const direction of EVERY_DIRECTION) {
        const grid = rehydrate(makeBoard());
        const origins = originsOf(grid);

        const outcome = resolveDefault(grid, direction);

        expect(outcome.moved).toBe(anyTileLeftItsCell(origins));
      }
    }
  });

  it('reports no change when every tile kept its cell (L175-L177)', () => {
    const grid = rehydrate(createBlockedBoard());
    const cell: Position = { x: 0, y: ROW_ZERO };

    const outcome = resolveDefault(grid, DIRECTION_LEFT);
    const tile = tileAt(grid, cell);

    expect(outcome.moved).toBe(false);
    expect(positionsEqual(cell, tile)).toBe(true);
    expect(tile).not.toEqual(cell);
  });

  it('reports a change for a single sliding tile (L176)', () => {
    const grid = buildLoneTileGrid();
    const tile = tileAt(grid, LONE_CELL);

    const outcome = resolveDefault(grid, DIRECTION_LEFT);

    expect(outcome.moved).toBe(true);
    expect(positionsEqual(LONE_CELL, tile)).toBe(false);
  });

  it('reads the source tile of a merge, not the merged one (L164)', () => {
    const grid = rehydrate(createMergePairBoard());
    const sourceCell: Position = { x: 1, y: ROW_ZERO };
    const source = tileAt(grid, sourceCell);

    const outcome = resolveDefault(grid, DIRECTION_LEFT);
    const merged = outcome.merges[0].merged;

    expect(merged.previousPosition).toBeNull();
    expect(source.previousPosition).toEqual(sourceCell);
    expect(positionsEqual(sourceCell, source)).toBe(false);
    expect(outcome.moved).toBe(true);
  });
});

describe('resolveMove merge dispatch (js/game_manager.js L156-L167)', () => {
  it('carries both transformable members through unchanged', () => {
    const source = new Tile({ x: 1, y: ROW_ZERO }, LONE_VALUE);
    const target = new Tile({ x: 0, y: ROW_ZERO }, LONE_VALUE);
    const payload: MergeDispatchPayload = {
      source,
      target,
      resultValue: LONE_VALUE * 2,
      scoreDelta: LONE_VALUE * 2,
    };

    const resolved = identityMergeDispatch(payload);

    expect(resolved.resultValue).toBe(LONE_VALUE * 2);
    expect(resolved.scoreDelta).toBe(LONE_VALUE * 2);
  });

  it('passes the two live tiles straight through', () => {
    const source = new Tile({ x: 1, y: ROW_ZERO }, LONE_VALUE);
    const target = new Tile({ x: 0, y: ROW_ZERO }, LONE_VALUE);

    source.savePosition();

    const resolved = identityMergeDispatch({
      source,
      target,
      resultValue: LONE_VALUE * 2,
      scoreDelta: LONE_VALUE * 2,
    });

    // AAP Contract 1: the payload carries the live tiles, so the identity
    // dispatch hands back the very objects the merge branch assembled.
    expect(resolved.source).toBe(source);
    expect(resolved.target).toBe(target);
    expect(resolved.source.previousPosition).toEqual({ x: 1, y: ROW_ZERO });
    expect(resolved.target.previousPosition).toBeNull();
  });

  it('defaults to the identity dispatch when none is given (L157)', () => {
    const config = createDefaultRulesConfig();
    const withoutOption = rehydrate(createMergePairBoard());
    const withIdentity = rehydrate(createMergePairBoard());

    const plain = resolveMove(withoutOption, DIRECTION_LEFT, config);
    const identity = resolveMove(withIdentity, DIRECTION_LEFT, config, {
      dispatchMerge: identityMergeDispatch,
    });

    expect(identity.moved).toBe(plain.moved);
    expect(identity.scoreDelta).toBe(plain.scoreDelta);
    expect(identity.merges).toHaveLength(plain.merges.length);
    expect(identity.merges[0].merged.value).toBe(
      plain.merges[0].merged.value,
    );
    expect(latticeValues(withIdentity)).toEqual(
      latticeValues(withoutOption),
    );
  });

  it('is invoked once for a move with one merge (L156-L167)', () => {
    const dispatchMerge = vi.fn(
      (payload: MergeDispatchPayload): MergePayload =>
        identityMergeDispatch(payload),
    );
    const grid = rehydrate(createMergePairBoard());

    resolveMove(grid, DIRECTION_LEFT, createDefaultRulesConfig(), {
      dispatchMerge,
    });

    expect(dispatchMerge).toHaveBeenCalledTimes(1);
  });

  it('is invoked twice for a move with two merges (L156-L167)', () => {
    const dispatchMerge = vi.fn(
      (payload: MergeDispatchPayload): MergePayload =>
        identityMergeDispatch(payload),
    );
    const grid = buildRowGrid([
      LONE_VALUE,
      LONE_VALUE,
      LONE_VALUE,
      LONE_VALUE,
    ]);

    resolveMove(grid, DIRECTION_LEFT, createDefaultRulesConfig(), {
      dispatchMerge,
    });

    expect(dispatchMerge).toHaveBeenCalledTimes(2);
  });

  it('is not invoked when no merge resolves (L156)', () => {
    const dispatchMerge = vi.fn(
      (payload: MergeDispatchPayload): MergePayload =>
        identityMergeDispatch(payload),
    );
    const config = createDefaultRulesConfig();

    resolveMove(rehydrate(createBlockedBoard()), DIRECTION_LEFT, config, {
      dispatchMerge,
    });
    resolveMove(buildLoneTileGrid(), DIRECTION_LEFT, config, {
      dispatchMerge,
    });

    expect(dispatchMerge).toHaveBeenCalledTimes(0);
  });

  it('is handed the assembled merge payload (L157-L158, L167)', () => {
    const dispatchMerge = vi.fn(
      (payload: MergeDispatchPayload): MergePayload =>
        identityMergeDispatch(payload),
    );
    const grid = rehydrate(createMergePairBoard());
    const target = tileAt(grid, { x: 0, y: ROW_ZERO });
    const source = tileAt(grid, { x: 1, y: ROW_ZERO });
    const produced = LONE_VALUE * 2;

    resolveMove(grid, DIRECTION_LEFT, createDefaultRulesConfig(), {
      dispatchMerge,
    });

    const payload = dispatchMerge.mock.calls[0][0];

    // The two live tiles of the merge branch, and the produced value twice.
    expect(payload.source).toBe(source);
    expect(payload.target).toBe(target);
    expect(payload.resultValue).toBe(produced);
    expect(payload.scoreDelta).toBe(produced);
  });

  it('reads back only the result value and the score delta', () => {
    const grid = rehydrate(createMergePairBoard());
    const target = tileAt(grid, { x: 0, y: ROW_ZERO });
    const source = tileAt(grid, { x: 1, y: ROW_ZERO });

    // A dispatch that returns foreign tile members changes nothing: the
    // resolver reads `resultValue` and `scoreDelta` back and dereferences
    // neither tile, so a substituted tile reaches nothing.
    const outcome = resolveMove(
      grid,
      DIRECTION_LEFT,
      createDefaultRulesConfig(),
      {
        dispatchMerge: (payload): MergePayload => ({
          ...identityMergeDispatch(payload),
          source: new Tile({ x: HUGE_VALUE, y: HUGE_VALUE }, HUGE_VALUE),
          target: new Tile({ x: HUGE_VALUE, y: HUGE_VALUE }, HUGE_VALUE),
        }),
      },
    );

    expect(source.value).toBe(LONE_VALUE);
    expect(target.value).toBe(LONE_VALUE);
    expect(outcome.merges[0].merged.value).toBe(LONE_VALUE * 2);
    expect(outcome.scoreDelta).toBe(LONE_VALUE * 2);
  });

  it('leaves the merged tile on the values the resolver produced even when ' +
    'a dispatch writes the two consumed tiles', () => {
    const grid = rehydrate(createMergePairBoard());
    const target = tileAt(grid, { x: 0, y: ROW_ZERO });
    const source = tileAt(grid, { x: 1, y: ROW_ZERO });

    const outcome = resolveMove(
      grid,
      DIRECTION_LEFT,
      createDefaultRulesConfig(),
      {
        dispatchMerge: (payload): MergePayload => {
          // The payload carries the live tiles, so these writes reach them.
          payload.source.value = HUGE_VALUE;
          payload.target.value = HUGE_VALUE;

          return identityMergeDispatch(payload);
        },
      },
    );

    expect(source.value).toBe(HUGE_VALUE);
    expect(target.value).toBe(HUGE_VALUE);
    expect(outcome.merges[0].merged.value).toBe(LONE_VALUE * 2);
    expect(grid.cellContent({ x: 1, y: ROW_ZERO })).toBeNull();
    expect(tileAt(grid, { x: 0, y: ROW_ZERO }).value).toBe(LONE_VALUE * 2);
  });

  it('writes the returned result value onto the merged tile (L157)', () => {
    const dispatchMerge: MergeDispatch = (payload) => ({
      ...payload,
      resultValue: payload.resultValue + RESULT_BONUS,
    });
    const grid = rehydrate(createMergePairBoard());
    const expected = LONE_VALUE * 2 + RESULT_BONUS;

    const outcome = resolveMove(
      grid,
      DIRECTION_LEFT,
      createDefaultRulesConfig(),
      { dispatchMerge },
    );

    expect(outcome.merges[0].merged.value).toBe(expected);
    expect(tileAt(grid, { x: 0, y: ROW_ZERO }).value).toBe(expected);
  });

  it('accumulates the returned score delta (L167)', () => {
    const dispatchMerge: MergeDispatch = (payload) => ({
      ...payload,
      scoreDelta: payload.scoreDelta * DELTA_MULTIPLIER,
    });
    const grid = rehydrate(createMergePairBoard());
    const expected = LONE_VALUE * 2 * DELTA_MULTIPLIER;

    const outcome = resolveMove(
      grid,
      DIRECTION_LEFT,
      createDefaultRulesConfig(),
      { dispatchMerge },
    );

    expect(outcome.scoreDelta).toBe(expected);
    expect(outcome.merges[0].scoreDelta).toBe(expected);
    expect(outcome.merges[0].merged.value).toBe(LONE_VALUE * 2);
  });

  it('accumulates the returned delta over two merges (L167)', () => {
    const dispatchMerge: MergeDispatch = (payload) => ({
      ...payload,
      scoreDelta: payload.scoreDelta * DELTA_MULTIPLIER,
    });
    const grid = buildRowGrid([
      LONE_VALUE,
      LONE_VALUE,
      LONE_VALUE,
      LONE_VALUE,
    ]);
    const perMerge = LONE_VALUE * 2 * DELTA_MULTIPLIER;

    const outcome = resolveMove(
      grid,
      DIRECTION_LEFT,
      createDefaultRulesConfig(),
      { dispatchMerge },
    );

    expect(outcome.merges).toHaveLength(2);
    expect(outcome.scoreDelta).toBe(perMerge * 2);
  });

  it('runs before the merged tile reaches the lattice (L160)', () => {
    const grid = rehydrate(createMergePairBoard());
    const calls: string[] = [];
    const expected = LONE_VALUE * 2 + RESULT_BONUS;

    recordInsertions(grid, calls);

    const dispatchMerge: MergeDispatch = (payload) => {
      calls.push('dispatchMerge');

      return { ...payload, resultValue: payload.resultValue + RESULT_BONUS };
    };

    resolveMove(grid, DIRECTION_LEFT, createDefaultRulesConfig(), {
      dispatchMerge,
    });

    expect(calls).toEqual(['dispatchMerge', `insertTile:${expected}`]);
  });

  it('leaves the recorded source pair to the resolver (L158)', () => {
    const dispatchMerge: MergeDispatch = (payload) => ({
      ...payload,
      resultValue: payload.resultValue + RESULT_BONUS,
    });
    const grid = rehydrate(createMergePairBoard());
    const target = tileAt(grid, { x: 0, y: ROW_ZERO });
    const source = tileAt(grid, { x: 1, y: ROW_ZERO });

    const outcome = resolveMove(
      grid,
      DIRECTION_LEFT,
      createDefaultRulesConfig(),
      { dispatchMerge },
    );

    expect(outcome.merges[0].merged.mergedFrom?.[0]).toBe(source);
    expect(outcome.merges[0].merged.mergedFrom?.[1]).toBe(target);
  });
});


describe('resolveMove traversal walk (js/game_manager.js L146-L180)', () => {
  it('merges the pair of the merge-pair board (L156-L167)', () => {
    const grid = rehydrate(createMergePairBoard());
    const merged = LONE_VALUE * 2;

    const outcome = resolveDefault(grid, DIRECTION_LEFT);

    expect(outcome.moved).toBe(true);
    expect(outcome.merges).toHaveLength(1);
    expect(outcome.scoreDelta).toBe(merged);
    expect(tileAt(grid, { x: 0, y: ROW_ZERO }).value).toBe(merged);
    expect(occupiedTiles(grid)).toHaveLength(1);
  });

  it('merges the pair of the merge-pair board rightward (L216)', () => {
    const grid = rehydrate(createMergePairBoard());
    const last = DEFAULT_BOARD_SIZE - 1;
    const merged = LONE_VALUE * 2;

    const outcome = resolveDefault(grid, DIRECTION_RIGHT);

    expect(outcome.merges).toHaveLength(1);
    expect(tileAt(grid, { x: last, y: ROW_ZERO }).value).toBe(merged);
    expect(occupiedTiles(grid)).toHaveLength(1);
  });

  it('changes nothing on the merge-pair board upward (L175-L177)', () => {
    const grid = rehydrate(createMergePairBoard());
    const before = latticeValues(grid);

    const outcome = resolveDefault(grid, DIRECTION_UP);

    expect(outcome.moved).toBe(false);
    expect(outcome.merges).toEqual([]);
    expect(latticeValues(grid)).toEqual(before);
  });

  it('reports no movement in the blocked directions (L175-L177)', () => {
    for (const direction of [DIRECTION_LEFT, DIRECTION_UP, DIRECTION_DOWN]) {
      const grid = rehydrate(createBlockedBoard());
      const before = latticeValues(grid);

      const outcome = resolveDefault(grid, direction);

      expect(outcome.moved).toBe(false);
      expect(outcome.scoreDelta).toBe(0);
      expect(outcome.merges).toEqual([]);
      expect(latticeValues(grid)).toEqual(before);
    }
  });

  it('slides the blocked board without merging it (L172)', () => {
    const grid = rehydrate(createBlockedBoard());
    const last = DEFAULT_BOARD_SIZE - 1;

    const outcome = resolveDefault(grid, DIRECTION_RIGHT);

    expect(outcome.moved).toBe(true);
    expect(outcome.merges).toEqual([]);
    expect(outcome.scoreDelta).toBe(0);
    expect(occupiedTiles(grid)).toHaveLength(DEFAULT_BOARD_SIZE);

    for (let y = 0; y < DEFAULT_BOARD_SIZE; y += 1) {
      expect(grid.cellContent({ x: last, y })).not.toBeNull();
    }
  });

  it('resolves the empty board as a no-op in every direction (L151)', () => {
    for (const direction of EVERY_DIRECTION) {
      const grid = rehydrate(createEmptyBoard());

      const outcome = resolveDefault(grid, direction);

      expect(outcome.moved).toBe(false);
      expect(outcome.scoreDelta).toBe(0);
      expect(outcome.merges).toEqual([]);
      expect(occupiedTiles(grid)).toHaveLength(0);
      expect(grid.availableCells()).toHaveLength(
        DEFAULT_BOARD_SIZE * DEFAULT_BOARD_SIZE,
      );
    }
  });

  it('merges the near-win board up to the win value (L157, L170)', () => {
    const winValue = createDefaultRulesConfig().winValue;
    const grid = rehydrate(createNearWinBoard());

    const outcome = resolveDefault(grid, DIRECTION_LEFT);

    expect(outcome.moved).toBe(true);
    expect(outcome.merges).toHaveLength(1);
    expect(outcome.merges[0].merged.value).toBe(winValue);
    expect(tileAt(grid, { x: 0, y: ROW_ZERO }).value).toBe(winValue);
    expect(outcome).not.toHaveProperty('won');
  });

  it('resolves the one move the near-loss board has left (L156-L167)', () => {
    const grid = rehydrate(createNearLossBoard());
    const first = tileAt(grid, { x: 0, y: ROW_ZERO });
    const second = tileAt(grid, { x: 1, y: ROW_ZERO });

    expect(first.value).toBe(second.value);
    expect(grid.cellsAvailable()).toBe(false);

    const produced = first.value * 2;
    const outcome = resolveDefault(grid, DIRECTION_LEFT);

    expect(outcome.moved).toBe(true);
    expect(outcome.merges).toHaveLength(1);
    expect(outcome.scoreDelta).toBe(produced);
    expect(outcome.merges[0].merged.value).toBe(produced);
    expect(grid.cellsAvailable()).toBe(true);
  });

  it('changes nothing on the near-loss board vertically (L175-L177)', () => {
    for (const direction of [DIRECTION_UP, DIRECTION_DOWN]) {
      const grid = rehydrate(createNearLossBoard());
      const before = latticeValues(grid);

      const outcome = resolveDefault(grid, direction);

      expect(outcome.moved).toBe(false);
      expect(outcome.merges).toEqual([]);
      expect(latticeValues(grid)).toEqual(before);
    }
  });

  it('resolves on the grid alone, leaving the fixture intact (L146)', () => {
    const board = createMergePairBoard();
    const grid = rehydrate(board);

    resolveDefault(grid, DIRECTION_LEFT);

    expect(board.grid.cells[0][ROW_ZERO]).toEqual({
      position: { x: 0, y: ROW_ZERO },
      value: LONE_VALUE,
    });
    expect(board.grid.cells[1][ROW_ZERO]).toEqual({
      position: { x: 1, y: ROW_ZERO },
      value: LONE_VALUE,
    });
    expect(board.score).toBe(0);
    expect(board.won).toBe(false);
    expect(board.over).toBe(false);
  });

  it('resolves at board sizes other than the configured one (L146)', () => {
    for (const size of [SHRUNK_SIZE, GROWN_SIZE]) {
      const grid = buildRowGrid([LONE_VALUE, LONE_VALUE], size);
      const merged = LONE_VALUE * 2;

      const outcome = resolveDefault(grid, DIRECTION_RIGHT);

      expect(outcome.merges).toHaveLength(1);
      expect(outcome.scoreDelta).toBe(merged);
      expect(tileAt(grid, { x: size - 1, y: ROW_ZERO }).value).toBe(merged);
      expect(occupiedTiles(grid)).toHaveLength(1);
    }
  });

  it('prepares the tiles before walking the traversal (L143)', () => {
    const grid = buildRowGrid([LONE_VALUE, null, BLOCKER_VALUE]);
    const stayed = tileAt(grid, { x: 2, y: ROW_ZERO });

    markMergedLastTurn(stayed, { x: 9, y: 9 });
    resolveDefault(grid, DIRECTION_RIGHT);
    expect(stayed.mergedFrom).toBeNull();
    expect(stayed.previousPosition).toEqual({ x: 2, y: ROW_ZERO });
  });
});
