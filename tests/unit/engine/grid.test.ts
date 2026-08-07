// Ported-fidelity suite of src/engine/grid.ts, the TypeScript port of
// js/grid.js, which is deleted. That port is the
// `js/grid.js -> src/engine/grid.ts` edge of Figure 8, "File Transformation
// Map: Superseded Modules to TypeScript Targets", the visual index of
// docs/TRACEABILITY_MATRIX.md, and this suite is the evidence that matrix
// row cites.
//
// Every describe below names one ported construct and the lines of
// js/grid.js it came from, so a matrix row cites a test by name. All
// thirteen ported methods are covered, in the order the source declared
// them:
//   js/grid.js L1-L4     constructor      section 2
//   js/grid.js L7-L19    empty()          section 3
//   js/grid.js L21-L34   fromState()      section 4
//   js/grid.js L58-L64   eachCell()       section 5
//   js/grid.js L45-L55   availableCells() section 6
//   js/grid.js L37-L43   randomAvailableCell()  section 7
//   js/grid.js L80-L86   cellContent()    section 8
//   js/grid.js L76-L78   cellOccupied()   section 9
//   js/grid.js L72-L74   cellAvailable()  section 10
//   js/grid.js L67-L69   cellsAvailable() section 11
//   js/grid.js L89-L91   insertTile()     section 12
//   js/grid.js L93-L95   removeTile()     section 13
//   js/grid.js L97-L100  withinBounds()   section 14
//   js/grid.js L102-L117 serialize()      section 15
//
// Section 16 repeats the lattice, the bounds valve and the projection at
// board sizes other than the configured one.
//
// Two of those lines changed rather than moved, and each is pinned as
// changed:
//   js/grid.js L29  reached `Tile` as an ambient global; the port imports
//                   it. Section 4 asserts a rehydrated cell holds a `Tile`
//                   instance.
//   js/grid.js L41  drew from the global random source; the port draws
//                   from the `spawn-position` substream it is handed.
//                   Section 7 asserts the draw and the cursor.
//
// Coverage owned by sibling suites and not repeated here: the substreams'
// own sequence properties (tests/unit/rng), prepareTiles, moveTile and the
// traversals (tests/unit/engine/move-resolver.test.ts), loss detection
// (tests/unit/engine/terminal-state.test.ts), and saved-versus-configured
// board-size reconciliation (tests/unit/run).
//
// This suite reads no DOM and no storage, installs no mock and replaces no
// global; the one test double below is hand-written. It runs in the
// `unit:dom-free` project of vitest.config.ts, whose environment is 'node'.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import { describe, expect, it } from 'vitest';

import { DEFAULT_BOARD_SIZE } from '../../../src/config/default-config';
import { Grid } from '../../../src/engine/grid';
import { Tile } from '../../../src/engine/tile';
import type {
  CellMatrix,
  Position,
  SerializedTile,
} from '../../../src/engine/types';
import {
  createRngStreams,
  type RngStream,
} from '../../../src/rng/rng-streams';
import {
  BLOCKED_BOARD,
  EMPTY_BOARD,
  MERGE_PAIR_BOARD,
  NEAR_LOSS_BOARD,
  NEAR_WIN_BOARD,
  copyBoard,
  createBlockedBoard,
  createMergePairBoard,
  createNearLossBoard,
} from '../../fixtures/boards';

/* ===== 1. Sizes, seeds, helpers and the one test double ===== */

/** A board smaller than the configured size. */
const SHRUNK_SIZE = 3;

/** A board larger than the configured size. */
const GROWN_SIZE = 5;

/** A coordinate far outside every lattice this suite builds. */
const FAR_OFF_COORDINATE = 99;

/** The substream js/grid.js L41's draw was moved onto. */
const SPAWN_POSITION = 'spawn-position';

/** Run seed the deterministic draws below are taken under. */
const RUN_SEED = 'grid-suite-run-seed';

/** Seeds the availability assertion repeats a draw under. */
const DRAW_SEEDS: readonly string[] = [
  'grid-seed-a',
  'grid-seed-b',
  'grid-seed-c',
  'grid-seed-d',
];

/**
 * Builds the `spawn-position` substream of one run, at cursor 0.
 *
 * @param seed Run seed to derive the substream from.
 * @returns The run's `spawn-position` substream.
 */
function spawnPositionStream(seed: string): RngStream {
  return createRngStreams(seed).stream(SPAWN_POSITION);
}

/**
 * Lists every cell of a `size` lattice in js/grid.js L58-L64's order:
 * x-outer, y-inner.
 *
 * @param size Edge length in cells.
 * @returns Fresh coordinates, `size * size` of them.
 */
function everyCellInOrder(size: number): Position[] {
  const cells: Position[] = [];

  for (let x = 0; x < size; x += 1) {
    for (let y = 0; y < size; y += 1) {
      cells.push({ x, y });
    }
  }

  return cells;
}

/**
 * Puts one tile in every cell of `grid`, through `insertTile`.
 *
 * @param grid Grid to fill in place.
 * @param value Face value every inserted tile carries.
 */
function fillEveryCell(grid: Grid, value: number): void {
  for (const cell of everyCellInOrder(grid.size)) {
    grid.insertTile(new Tile(cell, value));
  }
}

/**
 * Asserts that `grid` holds a `Tile` at the coordinates and face value of
 * every occupied cell of `expected`, and `null` at every empty one, with
 * neither animation member set.
 *
 * @param grid Grid to read.
 * @param expected Serialised matrix to compare against, read as
 *   `expected[x][y]`, which is how js/grid.js L28 read it.
 */
function expectLatticeMatches(
  grid: Grid,
  expected: CellMatrix<SerializedTile>,
): void {
  for (const cell of everyCellInOrder(grid.size)) {
    const held = grid.cells[cell.x][cell.y];
    const source = expected[cell.x][cell.y];

    if (source === null) {
      expect(held).toBeNull();
      continue;
    }

    expect(held).toBeInstanceOf(Tile);
    expect(held?.value).toBe(source.value);
    expect(held?.x).toBe(source.position.x);
    expect(held?.y).toBe(source.position.y);
    expect(held?.previousPosition).toBeNull();
    expect(held?.mergedFrom).toBeNull();
  }
}

/** A hand-written `RngStream` together with the calls it recorded. */
interface RecordedStream {
  /** The substream handed to the subject under test. */
  readonly stream: RngStream;

  /** Candidate lists handed to `pick`, in call order. */
  readonly picked: readonly unknown[][];
}

/**
 * Builds a hand-written `RngStream` that records every candidate list
 * handed to `pick` and selects the entry at `selectedIndex`.
 *
 * The object satisfies the `RngStream` interface of src/rng/rng-streams.ts
 * member for member. Neither this suite nor vitest.config.ts installs a
 * mocking library.
 *
 * @param selectedIndex Index `pick` selects from a non-empty list.
 * @returns The substream and the list of candidate lists it received.
 */
function createRecordedStream(selectedIndex: number): RecordedStream {
  const picked: unknown[][] = [];
  let cursor = 0;

  const stream: RngStream = {
    name: SPAWN_POSITION,

    get cursor(): number {
      return cursor;
    },

    next(): number {
      cursor += 1;

      return 0;
    },

    nextInt(maxExclusive: number): number {
      if (maxExclusive <= 0) {
        return 0;
      }

      cursor += 1;

      return selectedIndex;
    },

    pick<T>(items: readonly T[]): T | undefined {
      picked.push([...items]);

      if (items.length === 0) {
        return undefined;
      }

      cursor += 1;

      return items[selectedIndex];
    },

    pickWeighted<T>(items: readonly T[]): T | undefined {
      if (items.length === 0) {
        return undefined;
      }

      cursor += 1;

      return items[selectedIndex];
    },
  };

  return { stream, picked };
}

/* ===== 2. Constructor: js/grid.js L1-L4 ===== */

describe('Grid constructor (js/grid.js L1-L4)', () => {
  it('exposes the size it was constructed at (L2)', () => {
    expect(new Grid(DEFAULT_BOARD_SIZE).size).toBe(DEFAULT_BOARD_SIZE);
    expect(new Grid(SHRUNK_SIZE).size).toBe(SHRUNK_SIZE);
    expect(new Grid(GROWN_SIZE).size).toBe(GROWN_SIZE);
  });

  it('builds a size by size lattice with no previous state (L3)', () => {
    const grid = new Grid(GROWN_SIZE);

    expect(grid.cells).toHaveLength(GROWN_SIZE);

    for (const column of grid.cells) {
      expect(column).toHaveLength(GROWN_SIZE);
    }
  });

  it('builds a size by size lattice from a previous state (L3)', () => {
    const board = copyBoard(MERGE_PAIR_BOARD);
    const grid = new Grid(board.grid.size, board.grid.cells);

    expect(grid.size).toBe(board.grid.size);
    expect(grid.cells).toHaveLength(board.grid.size);

    for (const column of grid.cells) {
      expect(column).toHaveLength(board.grid.size);
    }
  });

  it('treats a null previous state as none (L3)', () => {
    const grid = new Grid(DEFAULT_BOARD_SIZE, null);

    expect(grid.availableCells()).toHaveLength(
      DEFAULT_BOARD_SIZE * DEFAULT_BOARD_SIZE,
    );
  });
});

/* ===== 3. empty(): js/grid.js L7-L19 ===== */

describe('Grid.empty (js/grid.js L7-L19)', () => {
  it('fills every cell with null at the configured size (L14)', () => {
    const grid = new Grid(DEFAULT_BOARD_SIZE);

    for (const cell of everyCellInOrder(DEFAULT_BOARD_SIZE)) {
      expect(grid.cells[cell.x][cell.y]).toBeNull();
    }
  });

  it('builds a square null lattice at size 3 and size 5 (L10-L16)', () => {
    for (const size of [SHRUNK_SIZE, GROWN_SIZE]) {
      const cells = new Grid(size).cells;

      expect(cells).toHaveLength(size);

      for (const column of cells) {
        expect(column).toHaveLength(size);
        expect(column.every((cell) => cell === null)).toBe(true);
      }
    }
  });

  it('returns a fresh matrix on each call (L8, L18)', () => {
    const grid = new Grid(DEFAULT_BOARD_SIZE);
    const rebuilt = grid.empty();

    expect(rebuilt).not.toBe(grid.cells);
    expect(rebuilt).toEqual(grid.cells);
  });
});

/* ===== 4. fromState(): js/grid.js L21-L34 ===== */

describe('Grid.fromState (js/grid.js L21-L34)', () => {
  it('reads the cell matrix it is handed, not the board (L28)', () => {
    const board = copyBoard(MERGE_PAIR_BOARD);
    const grid = new Grid(board.grid.size, board.grid.cells);

    expectLatticeMatches(grid, board.grid.cells);
  });

  it('rehydrates an occupied cell as a Tile instance (L29)', () => {
    const board = copyBoard(BLOCKED_BOARD);
    const grid = new Grid(board.grid.size, board.grid.cells);

    for (let y = 0; y < board.grid.size; y += 1) {
      const held = grid.cells[0][y];

      expect(held).toBeInstanceOf(Tile);
      expect(held?.value).toBe(board.grid.cells[0][y]?.value);
      expect(held?.x).toBe(0);
      expect(held?.y).toBe(y);
    }
  });

  it('rehydrates an empty cell as null (L29)', () => {
    const board = copyBoard(BLOCKED_BOARD);
    const grid = new Grid(board.grid.size, board.grid.cells);

    for (let x = 1; x < board.grid.size; x += 1) {
      for (let y = 0; y < board.grid.size; y += 1) {
        expect(board.grid.cells[x][y]).toBeNull();
        expect(grid.cells[x][y]).toBeNull();
      }
    }
  });

  it('rehydrates a tile with no animation state (L29)', () => {
    const board = copyBoard(NEAR_LOSS_BOARD);
    const grid = new Grid(board.grid.size, board.grid.cells);

    for (const cell of everyCellInOrder(board.grid.size)) {
      const held = grid.cells[cell.x][cell.y];

      expect(held).toBeInstanceOf(Tile);
      expect(held?.previousPosition).toBeNull();
      expect(held?.mergedFrom).toBeNull();
    }
  });

  it('holds no reference to the matrix it read (L22, L29)', () => {
    const board = copyBoard(MERGE_PAIR_BOARD);
    const grid = new Grid(board.grid.size, board.grid.cells);
    const rehydrated = grid.cells[0][0];

    board.grid.cells[0][0] = null;

    expect(grid.cells).not.toBe(board.grid.cells);
    expect(grid.cells[0][0]).toBe(rehydrated);
    expect(rehydrated).toBeInstanceOf(Tile);
  });
});

/* ===== 5. eachCell(): js/grid.js L58-L64 ===== */

describe('Grid.eachCell (js/grid.js L58-L64)', () => {
  it('visits every cell x-outer then y-inner at size 3 (L59-L61)', () => {
    const grid = new Grid(SHRUNK_SIZE);
    const visited: string[] = [];

    grid.eachCell((x, y) => {
      visited.push(`${x},${y}`);
    });

    expect(visited).toEqual([
      '0,0',
      '0,1',
      '0,2',
      '1,0',
      '1,1',
      '1,2',
      '2,0',
      '2,1',
      '2,2',
    ]);
  });

  it('fixes the available-cell order the spawn draw indexes (L61)', () => {
    const grid = new Grid(DEFAULT_BOARD_SIZE);
    const visited: Position[] = [];

    grid.eachCell((x, y) => {
      visited.push({ x, y });
    });

    expect(visited).toHaveLength(DEFAULT_BOARD_SIZE * DEFAULT_BOARD_SIZE);
    expect(grid.availableCells()).toEqual(visited);
  });

  it('passes the cell coordinates and its contents (L61)', () => {
    const board = copyBoard(MERGE_PAIR_BOARD);
    const grid = new Grid(board.grid.size, board.grid.cells);
    const received: [number, number, Tile | null][] = [];

    grid.eachCell((...args) => {
      received.push(args);
    });

    expect(received).toHaveLength(board.grid.size * board.grid.size);
    expect(received[0]).toHaveLength(3);
    expect(received[0][0]).toBe(0);
    expect(received[0][1]).toBe(0);
    expect(received[0][2]).toBeInstanceOf(Tile);

    for (const [x, y, tile] of received) {
      expect(tile).toBe(grid.cells[x][y]);
    }
  });
});

/* ===== 6. availableCells(): js/grid.js L45-L55 ===== */

describe('Grid.availableCells (js/grid.js L45-L55)', () => {
  it('returns every cell of an empty board, in order (L50)', () => {
    const board = copyBoard(EMPTY_BOARD);
    const grid = new Grid(board.grid.size, board.grid.cells);

    expect(grid.availableCells()).toEqual(everyCellInOrder(board.grid.size));
  });

  it('lists the holes of a blocked board in order (L49-L52)', () => {
    const board = createBlockedBoard(SHRUNK_SIZE);
    const grid = new Grid(board.grid.size, board.grid.cells);

    expect(grid.availableCells()).toEqual([
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
      { x: 2, y: 0 },
      { x: 2, y: 1 },
      { x: 2, y: 2 },
    ]);
  });

  it('lists the holes of a merge-pair board in order (L49-L52)', () => {
    const board = createMergePairBoard(SHRUNK_SIZE);
    const grid = new Grid(board.grid.size, board.grid.cells);

    expect(grid.availableCells()).toEqual([
      { x: 0, y: 1 },
      { x: 0, y: 2 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
      { x: 2, y: 0 },
      { x: 2, y: 1 },
      { x: 2, y: 2 },
    ]);
  });

  it('returns no cell when every cell is occupied (L49)', () => {
    const board = copyBoard(NEAR_LOSS_BOARD);
    const grid = new Grid(board.grid.size, board.grid.cells);

    expect(grid.availableCells()).toEqual([]);
  });

  it('returns a fresh array on each call (L46, L54)', () => {
    const grid = new Grid(DEFAULT_BOARD_SIZE);
    const first = grid.availableCells();
    const second = grid.availableCells();

    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });
});


/* ===== 7. randomAvailableCell(): js/grid.js L37-L43 ===== */

describe('Grid.randomAvailableCell (js/grid.js L37-L43)', () => {
  it('returns undefined for a full fixture board (L40-L43)', () => {
    const board = copyBoard(NEAR_LOSS_BOARD);
    const grid = new Grid(board.grid.size, board.grid.cells);

    expect(grid.cellsAvailable()).toBe(false);
    expect(
      grid.randomAvailableCell(spawnPositionStream(RUN_SEED)),
    ).toBeUndefined();
  });

  it('returns undefined for a filled lattice (L40-L43)', () => {
    const grid = new Grid(GROWN_SIZE);

    fillEveryCell(grid, 2);

    expect(grid.availableCells()).toEqual([]);
    expect(
      grid.randomAvailableCell(spawnPositionStream(RUN_SEED)),
    ).toBeUndefined();
  });

  it('leaves the cursor where it was on a full board (L40)', () => {
    const board = copyBoard(NEAR_LOSS_BOARD);
    const grid = new Grid(board.grid.size, board.grid.cells);
    const stream = spawnPositionStream(RUN_SEED);
    const before = stream.cursor;

    expect(before).toBe(0);
    expect(grid.randomAvailableCell(stream)).toBeUndefined();
    expect(stream.cursor).toBe(before);

    expect(grid.randomAvailableCell(stream)).toBeUndefined();
    expect(stream.cursor).toBe(before);
  });

  it('selects nothing at all on a full board (L40)', () => {
    const board = copyBoard(NEAR_LOSS_BOARD);
    const grid = new Grid(board.grid.size, board.grid.cells);
    const recorded = createRecordedStream(0);

    expect(grid.randomAvailableCell(recorded.stream)).toBeUndefined();
    expect(recorded.picked).toEqual([]);
    expect(recorded.stream.cursor).toBe(0);
  });

  it('consumes one draw per call from the substream (L41)', () => {
    const grid = new Grid(DEFAULT_BOARD_SIZE);
    const stream = spawnPositionStream(RUN_SEED);

    expect(stream.cursor).toBe(0);

    expect(grid.randomAvailableCell(stream)).not.toBeUndefined();
    expect(stream.cursor).toBe(1);

    expect(grid.randomAvailableCell(stream)).not.toBeUndefined();
    expect(stream.cursor).toBe(2);
  });

  it('hands the available-cell list to the substream (L38, L41)', () => {
    const board = createBlockedBoard(SHRUNK_SIZE);
    const grid = new Grid(board.grid.size, board.grid.cells);
    const recorded = createRecordedStream(0);
    const available = grid.availableCells();

    expect(grid.randomAvailableCell(recorded.stream)).toEqual(available[0]);
    expect(recorded.picked).toHaveLength(1);
    expect(recorded.picked[0]).toEqual(available);
    expect(recorded.stream.cursor).toBe(1);
  });

  it('returns the cell the substream selected (L41)', () => {
    const board = createBlockedBoard(SHRUNK_SIZE);
    const grid = new Grid(board.grid.size, board.grid.cells);
    const available = grid.availableCells();
    const lastIndex = available.length - 1;
    const recorded = createRecordedStream(lastIndex);

    expect(grid.randomAvailableCell(recorded.stream)).toEqual(
      available[lastIndex],
    );
  });

  it('selects the same cell under one seed on two grids (L41)', () => {
    const firstBoard = createBlockedBoard(DEFAULT_BOARD_SIZE);
    const secondBoard = createBlockedBoard(DEFAULT_BOARD_SIZE);
    const first = new Grid(firstBoard.grid.size, firstBoard.grid.cells);
    const second = new Grid(secondBoard.grid.size, secondBoard.grid.cells);

    const drawn = first.randomAvailableCell(spawnPositionStream(RUN_SEED));

    expect(drawn).not.toBeUndefined();
    expect(second.randomAvailableCell(spawnPositionStream(RUN_SEED))).toEqual(
      drawn,
    );
  });

  it('draws a cell that is one of the available cells (L38, L41)', () => {
    for (const seed of DRAW_SEEDS) {
      const board = createBlockedBoard(DEFAULT_BOARD_SIZE);
      const grid = new Grid(board.grid.size, board.grid.cells);
      const available = grid.availableCells();
      const drawn = grid.randomAvailableCell(spawnPositionStream(seed));

      expect(available).toContainEqual(drawn);
      expect(grid.cellAvailable(drawn ?? { x: -1, y: -1 })).toBe(true);
    }
  });
});

/* ===== 8. cellContent(): js/grid.js L80-L86 ===== */

describe('Grid.cellContent (js/grid.js L80-L86)', () => {
  it('returns the tile occupying an in-bounds cell (L82)', () => {
    const board = copyBoard(MERGE_PAIR_BOARD);
    const grid = new Grid(board.grid.size, board.grid.cells);

    expect(grid.cellContent({ x: 0, y: 0 })).toBeInstanceOf(Tile);
    expect(grid.cellContent({ x: 0, y: 0 })).toBe(grid.cells[0][0]);
    expect(grid.cellContent({ x: 1, y: 0 })).toBe(grid.cells[1][0]);
  });

  it('returns null for an empty in-bounds cell (L82)', () => {
    const board = copyBoard(MERGE_PAIR_BOARD);
    const grid = new Grid(board.grid.size, board.grid.cells);

    expect(grid.cellContent({ x: 0, y: 1 })).toBeNull();
    expect(grid.cellContent({ x: 2, y: 2 })).toBeNull();
  });

  it('returns null off the lattice, terminating the walk (L84)', () => {
    const grid = new Grid(DEFAULT_BOARD_SIZE);
    const edge = grid.size;

    fillEveryCell(grid, 2);

    const offLattice: Position[] = [
      { x: -1, y: 0 },
      { x: 0, y: -1 },
      { x: -1, y: -1 },
      { x: edge, y: 0 },
      { x: 0, y: edge },
      { x: edge, y: edge },
      { x: -1, y: edge },
      { x: edge, y: -1 },
    ];

    for (const cell of offLattice) {
      expect(grid.withinBounds(cell)).toBe(false);
      expect(grid.cellContent(cell)).toBeNull();
    }
  });

  it('returns null for a far-off cell the probe reads (L84)', () => {
    const grid = new Grid(DEFAULT_BOARD_SIZE);

    fillEveryCell(grid, 4);

    const far = FAR_OFF_COORDINATE;

    expect(grid.cellContent({ x: far, y: far })).toBeNull();
    expect(grid.cellContent({ x: -far, y: -far })).toBeNull();
    expect(grid.cellContent({ x: far, y: 0 })).toBeNull();
    expect(grid.cellContent({ x: 0, y: -far })).toBeNull();
  });
});

/* ===== 9. cellOccupied(): js/grid.js L76-L78 ===== */

describe('Grid.cellOccupied (js/grid.js L76-L78)', () => {
  it('reports the truthiness of cellContent (L77)', () => {
    const board = copyBoard(MERGE_PAIR_BOARD);
    const grid = new Grid(board.grid.size, board.grid.cells);
    const occupied: Position = { x: 0, y: 0 };
    const empty: Position = { x: 2, y: 2 };

    expect(grid.cellContent(occupied)).not.toBeNull();
    expect(grid.cellOccupied(occupied)).toBe(true);

    expect(grid.cellContent(empty)).toBeNull();
    expect(grid.cellOccupied(empty)).toBe(false);
  });

  it('reports an off-lattice cell as unoccupied (L77 via L84)', () => {
    const grid = new Grid(DEFAULT_BOARD_SIZE);

    fillEveryCell(grid, 2);

    expect(grid.cellOccupied({ x: grid.size, y: 0 })).toBe(false);
    expect(grid.cellOccupied({ x: -1, y: 0 })).toBe(false);
  });
});

/* ===== 10. cellAvailable(): js/grid.js L72-L74 ===== */

describe('Grid.cellAvailable (js/grid.js L72-L74)', () => {
  it('negates cellOccupied (L73)', () => {
    const board = copyBoard(BLOCKED_BOARD);
    const grid = new Grid(board.grid.size, board.grid.cells);

    for (const cell of everyCellInOrder(grid.size)) {
      expect(grid.cellAvailable(cell)).toBe(!grid.cellOccupied(cell));
    }

    expect(grid.cellAvailable({ x: 0, y: 0 })).toBe(false);
    expect(grid.cellAvailable({ x: 1, y: 0 })).toBe(true);
  });

  it('reports an off-lattice cell as available (L73 via L84)', () => {
    const grid = new Grid(DEFAULT_BOARD_SIZE);

    fillEveryCell(grid, 2);

    expect(grid.cellAvailable({ x: grid.size, y: 0 })).toBe(true);
    expect(grid.cellAvailable({ x: 0, y: grid.size })).toBe(true);
    expect(grid.cellAvailable({ x: -1, y: -1 })).toBe(true);
  });
});

/* ===== 11. cellsAvailable(): js/grid.js L67-L69 ===== */

describe('Grid.cellsAvailable (js/grid.js L67-L69)', () => {
  it('is true for an empty board (L68)', () => {
    const board = copyBoard(EMPTY_BOARD);
    const grid = new Grid(board.grid.size, board.grid.cells);

    expect(grid.availableCells()).toHaveLength(grid.size * grid.size);
    expect(grid.cellsAvailable()).toBe(true);
  });

  it('is false when every cell is occupied (L68)', () => {
    const board = copyBoard(NEAR_LOSS_BOARD);
    const grid = new Grid(board.grid.size, board.grid.cells);

    expect(grid.availableCells()).toHaveLength(0);
    expect(grid.cellsAvailable()).toBe(false);
  });

  it('is true again once one cell is cleared (L68)', () => {
    const board = copyBoard(NEAR_LOSS_BOARD);
    const grid = new Grid(board.grid.size, board.grid.cells);
    const held = grid.cells[0][0];

    expect(grid.cellsAvailable()).toBe(false);
    expect(held).toBeInstanceOf(Tile);

    if (held !== null) {
      grid.removeTile(held);
    }

    expect(grid.cellsAvailable()).toBe(true);
    expect(grid.availableCells()).toEqual([{ x: 0, y: 0 }]);
  });
});


/* ===== 12. insertTile(): js/grid.js L89-L91 ===== */

describe('Grid.insertTile (js/grid.js L89-L91)', () => {
  it('writes the tile into the cell its coordinates name (L90)', () => {
    const grid = new Grid(DEFAULT_BOARD_SIZE);
    const tile = new Tile({ x: 1, y: 2 }, 8);

    grid.insertTile(tile);

    expect(grid.cells[1][2]).toBe(tile);
    expect(grid.cellContent({ x: 1, y: 2 })).toBe(tile);
    expect(grid.availableCells()).not.toContainEqual({ x: 1, y: 2 });
  });

  it('indexes by the coordinates updatePosition wrote (L90)', () => {
    const grid = new Grid(DEFAULT_BOARD_SIZE);
    const tile = new Tile({ x: 0, y: 0 }, 4);

    tile.updatePosition({ x: 3, y: 1 });
    grid.insertTile(tile);

    expect(grid.cells[3][1]).toBe(tile);
    expect(grid.cells[0][0]).toBeNull();
  });

  it('has no nested position member to index by (L90)', () => {
    const tile = new Tile({ x: 2, y: 3 }, 16);

    expect('position' in tile).toBe(false);
    expect(tile.x).toBe(2);
    expect(tile.y).toBe(3);
  });

  it('overwrites the tile already in that cell (L90)', () => {
    const grid = new Grid(DEFAULT_BOARD_SIZE);
    const first = new Tile({ x: 2, y: 2 }, 2);
    const second = new Tile({ x: 2, y: 2 }, 4);

    grid.insertTile(first);
    grid.insertTile(second);

    expect(grid.cells[2][2]).toBe(second);
    expect(grid.availableCells()).not.toContainEqual({ x: 2, y: 2 });
  });
});

/* ===== 13. removeTile(): js/grid.js L93-L95 ===== */

describe('Grid.removeTile (js/grid.js L93-L95)', () => {
  it('clears the cell the tile coordinates name (L94)', () => {
    const grid = new Grid(DEFAULT_BOARD_SIZE);
    const tile = new Tile({ x: 1, y: 3 }, 32);

    grid.insertTile(tile);
    grid.removeTile(tile);

    expect(grid.cells[1][3]).toBeNull();
    expect(grid.cellContent({ x: 1, y: 3 })).toBeNull();
    expect(grid.availableCells()).toContainEqual({ x: 1, y: 3 });
  });

  it('clears the pre-move cell before updatePosition (L94)', () => {
    const grid = new Grid(DEFAULT_BOARD_SIZE);
    const tile = new Tile({ x: 0, y: 0 }, 2);
    const next = new Tile({ x: 1, y: 0 }, 2);

    grid.insertTile(tile);
    grid.insertTile(next);

    const merged = new Tile({ x: 1, y: 0 }, tile.value * 2);

    merged.mergedFrom = [tile, next];

    grid.insertTile(merged);
    grid.removeTile(tile);
    tile.updatePosition({ x: 1, y: 0 });

    expect(grid.cells[0][0]).toBeNull();
    expect(grid.cells[1][0]).toBe(merged);
    expect(tile.x).toBe(1);
    expect(tile.y).toBe(0);
  });

  it('clears a cell the tile does not hold (L94)', () => {
    const grid = new Grid(DEFAULT_BOARD_SIZE);
    const held = new Tile({ x: 2, y: 1 }, 8);

    grid.insertTile(held);
    grid.removeTile(new Tile({ x: 2, y: 1 }, 8));

    expect(grid.cells[2][1]).toBeNull();
    expect(held.x).toBe(2);
    expect(held.y).toBe(1);
  });
});

/* ===== 14. withinBounds(): js/grid.js L97-L100 ===== */

describe('Grid.withinBounds (js/grid.js L97-L100)', () => {
  it('accepts all four corners at the configured size (L98-L99)', () => {
    const grid = new Grid(DEFAULT_BOARD_SIZE);
    const last = DEFAULT_BOARD_SIZE - 1;

    expect(grid.withinBounds({ x: 0, y: 0 })).toBe(true);
    expect(grid.withinBounds({ x: last, y: 0 })).toBe(true);
    expect(grid.withinBounds({ x: 0, y: last })).toBe(true);
    expect(grid.withinBounds({ x: last, y: last })).toBe(true);
  });

  it('rejects one step outside each edge (L98-L99)', () => {
    const grid = new Grid(DEFAULT_BOARD_SIZE);
    const edge = DEFAULT_BOARD_SIZE;

    expect(grid.withinBounds({ x: -1, y: 0 })).toBe(false);
    expect(grid.withinBounds({ x: 0, y: -1 })).toBe(false);
    expect(grid.withinBounds({ x: edge, y: 0 })).toBe(false);
    expect(grid.withinBounds({ x: 0, y: edge })).toBe(false);
  });

  it('reads the size at call time, at size 3 and size 5 (L98-L99)', () => {
    for (const size of [SHRUNK_SIZE, GROWN_SIZE]) {
      const grid = new Grid(size);
      const last = size - 1;

      expect(grid.withinBounds({ x: 0, y: 0 })).toBe(true);
      expect(grid.withinBounds({ x: last, y: last })).toBe(true);
      expect(grid.withinBounds({ x: size, y: last })).toBe(false);
      expect(grid.withinBounds({ x: last, y: size })).toBe(false);
      expect(grid.withinBounds({ x: -1, y: last })).toBe(false);
    }
  });
});

/* ===== 15. serialize(): js/grid.js L102-L117 ===== */

describe('Grid.serialize (js/grid.js L102-L117)', () => {
  it('projects to a size and a square cell matrix (L113-L116)', () => {
    const grid = new Grid(GROWN_SIZE);
    const projected = grid.serialize();

    expect(Object.keys(projected).sort()).toEqual(['cells', 'size']);
    expect(projected.size).toBe(GROWN_SIZE);
    expect(projected.cells).toHaveLength(GROWN_SIZE);

    for (const column of projected.cells) {
      expect(column).toHaveLength(GROWN_SIZE);
    }
  });

  it('projects an occupied cell through tile.serialize (L109)', () => {
    const grid = new Grid(DEFAULT_BOARD_SIZE);
    const tile = new Tile({ x: 2, y: 1 }, 64);

    tile.savePosition();
    tile.mergedFrom = [
      new Tile({ x: 2, y: 1 }, 32),
      new Tile({ x: 2, y: 0 }, 32),
    ];

    grid.insertTile(tile);

    expect(grid.serialize().cells[2][1]).toEqual({
      position: { x: 2, y: 1 },
      value: 64,
    });
  });

  it('retains an empty cell as null (L109)', () => {
    const board = createBlockedBoard(SHRUNK_SIZE);
    const grid = new Grid(board.grid.size, board.grid.cells);
    const projected = grid.serialize();

    expect(projected.cells[1]).toEqual([null, null, null]);
    expect(projected.cells[2]).toEqual([null, null, null]);
    expect(projected.cells[0][0]).toEqual({
      position: { x: 0, y: 0 },
      value: 2,
    });
  });

  it('round trips through the constructor (L109, L113-L116)', () => {
    const board = copyBoard(NEAR_WIN_BOARD);
    const grid = new Grid(board.grid.size, board.grid.cells);
    const projected = grid.serialize();
    const restored = new Grid(projected.size, projected.cells);

    expect(restored.size).toBe(grid.size);
    expect(restored.serialize()).toEqual(projected);
    expect(restored.availableCells()).toEqual(grid.availableCells());
    expectLatticeMatches(restored, board.grid.cells);
  });

  it('returns a fresh projection on each call (L103, L106)', () => {
    const board = copyBoard(MERGE_PAIR_BOARD);
    const grid = new Grid(board.grid.size, board.grid.cells);
    const first = grid.serialize();
    const second = grid.serialize();

    expect(second).not.toBe(first);
    expect(second.cells).not.toBe(first.cells);
    expect(second).toEqual(first);

    first.cells[0][0] = null;

    expect(grid.cells[0][0]).toBeInstanceOf(Tile);
    expect(grid.serialize().cells[0][0]).not.toBeNull();
  });
});

/* ===== 16. Board sizes other than the configured one ===== */

describe('Grid at a size other than the configured one (L2)', () => {
  it('carries the lattice, the valve and the projection (L2-L3)', () => {
    for (const size of [SHRUNK_SIZE, GROWN_SIZE]) {
      const board = createNearLossBoard(size);
      const grid = new Grid(board.grid.size, board.grid.cells);

      expect(grid.size).toBe(size);
      expect(grid.cells).toHaveLength(size);
      expectLatticeMatches(grid, board.grid.cells);

      expect(grid.cellContent({ x: size, y: 0 })).toBeNull();
      expect(grid.cellContent({ x: 0, y: size })).toBeNull();
      expect(grid.cellsAvailable()).toBe(false);
      expect(
        grid.randomAvailableCell(spawnPositionStream(RUN_SEED)),
      ).toBeUndefined();

      const projected = grid.serialize();

      expect(projected.size).toBe(size);
      expect(projected.cells).toHaveLength(size);
      expect(new Grid(projected.size, projected.cells).serialize()).toEqual(
        projected,
      );
    }
  });

  it('draws inside a lattice smaller than the default (L38)', () => {
    const grid = new Grid(SHRUNK_SIZE);
    const drawn = grid.randomAvailableCell(spawnPositionStream(RUN_SEED));

    expect(drawn).not.toBeUndefined();
    expect(grid.withinBounds(drawn ?? { x: -1, y: -1 })).toBe(true);
    expect(everyCellInOrder(SHRUNK_SIZE)).toContainEqual(drawn);
  });

  it('draws inside a lattice larger than the default (L38)', () => {
    const grid = new Grid(GROWN_SIZE);
    const drawn = grid.randomAvailableCell(spawnPositionStream(RUN_SEED));

    expect(drawn).not.toBeUndefined();
    expect(grid.withinBounds(drawn ?? { x: -1, y: -1 })).toBe(true);
    expect(everyCellInOrder(GROWN_SIZE)).toContainEqual(drawn);
  });
});

