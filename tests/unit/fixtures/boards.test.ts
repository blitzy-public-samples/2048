// Contract suite over tests/fixtures/boards.ts, the five board fixtures every
// other suite under tests/ builds engine state from.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import { describe, expect, it } from 'vitest';

import {
  BLOCKED_BOARD,
  EMPTY_BOARD,
  MERGE_PAIR_BOARD,
  NEAR_LOSS_BOARD,
  NEAR_WIN_BOARD,
  copyBoard,
  createBlockedBoard,
  createEmptyBoard,
  createMergePairBoard,
  createNearLossBoard,
  createNearWinBoard,
} from '../../fixtures/boards';
import {
  DEFAULT_BOARD_SIZE,
  DEFAULT_RULES_CONFIG,
} from '../../../src/config/default-config';
import type {
  SerializedGameState,
  SerializedTile,
} from '../../../src/engine/types';

/** Builds one board at a requested size. */
type BoardBuilder = (size?: number) => SerializedGameState;

/** One builder, with the smallest size it is defined at. */
interface BuilderCase {
  /** Name quoted in the test title. */
  readonly name: string;

  /** The builder itself. */
  readonly build: BoardBuilder;

  /** Smallest edge length the builder accepts. */
  readonly minimumSize: number;

  /** The frozen constant the builder's default call corresponds to. */
  readonly constant: SerializedGameState;
}

/** Smallest board the empty fixture is defined at. */
const MIN_EMPTY_SIZE = 1;

/** Smallest board every occupied fixture is defined at. */
const MIN_OCCUPIED_SIZE = 2;

/** Every builder the module exports, each with its own minimum. */
const BUILDERS: readonly BuilderCase[] = [
  {
    name: 'createEmptyBoard',
    build: createEmptyBoard,
    minimumSize: MIN_EMPTY_SIZE,
    constant: EMPTY_BOARD,
  },
  {
    name: 'createMergePairBoard',
    build: createMergePairBoard,
    minimumSize: MIN_OCCUPIED_SIZE,
    constant: MERGE_PAIR_BOARD,
  },
  {
    name: 'createBlockedBoard',
    build: createBlockedBoard,
    minimumSize: MIN_OCCUPIED_SIZE,
    constant: BLOCKED_BOARD,
  },
  {
    name: 'createNearWinBoard',
    build: createNearWinBoard,
    minimumSize: MIN_OCCUPIED_SIZE,
    constant: NEAR_WIN_BOARD,
  },
  {
    name: 'createNearLossBoard',
    build: createNearLossBoard,
    minimumSize: MIN_OCCUPIED_SIZE,
    constant: NEAR_LOSS_BOARD,
  },
];

/**
 * Sizes every builder is exercised at, all at or above `MIN_OCCUPIED_SIZE`.
 */
const EXERCISED_SIZES: readonly number[] = [2, 3, 4, 5];

/** Sizes rejected as not being a safe integer of at least the minimum. */
const REJECTED_SIZES: readonly number[] = [
  0,
  -1,
  -4,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 2,
];

/** Win values `createNearWinBoard` refuses to halve. */
const REJECTED_WIN_VALUES: readonly number[] = [
  0,
  1,
  -2,
  3,
  2047,
  6.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
];

/** Win values `createNearWinBoard` accepts, each an even integer above 1. */
const ACCEPTED_WIN_VALUES: readonly number[] = [2, 8, 512, 2048, 4096];

/** Face value both tiles of the merge-pair fixture carry. */
const MERGE_PAIR_VALUE = 2;

/** Tiles the merge-pair and near-win fixtures place in row 0. */
const PAIR_TILE_COUNT = 2;

/** Distinct values the near-loss fixture cycles through. */
const CROWDED_CYCLE_LENGTH = 5;

/** One cell address. */
interface CellAddress {
  readonly x: number;
  readonly y: number;
}

/**
 * Lists every cell address of a board, x-outer and y-inner.
 *
 * @param size Edge length in cells.
 * @returns Every address, in js/grid.js L58-L64's order.
 */
function everyAddress(size: number): CellAddress[] {
  const addresses: CellAddress[] = [];

  for (let x = 0; x < size; x += 1) {
    for (let y = 0; y < size; y += 1) {
      addresses.push({ x, y });
    }
  }

  return addresses;
}

/**
 * Collects the occupied cells of a board with the address each was found at.
 *
 * @param board Board to walk.
 * @returns One entry per occupied cell, in traversal order.
 */
function occupiedCells(
  board: SerializedGameState,
): { address: CellAddress; tile: SerializedTile }[] {
  const found: { address: CellAddress; tile: SerializedTile }[] = [];

  for (const address of everyAddress(board.grid.size)) {
    const tile = board.grid.cells[address.x][address.y];

    if (tile !== null) {
      found.push({ address, tile });
    }
  }

  return found;
}

/**
 * Reads the face value of one cell.
 *
 * @param board Board to read.
 * @param x Column index.
 * @param y Row index.
 * @returns The tile's value, or `null` for an empty cell.
 */
function valueAt(
  board: SerializedGameState,
  x: number,
  y: number,
): number | null {
  return board.grid.cells[x][y]?.value ?? null;
}

/**
 * Counts the adjacent pairs of equal value on a board, horizontally and
 * vertically — the neighbour probe of js/game_manager.js L238-L240 expressed
 * as a count.
 *
 * @param board Board to probe.
 * @returns How many adjacent equal pairs the board carries.
 */
function adjacentEqualPairs(board: SerializedGameState): number {
  const size = board.grid.size;
  let pairs = 0;

  for (let x = 0; x < size; x += 1) {
    for (let y = 0; y < size; y += 1) {
      const value = valueAt(board, x, y);

      if (value === null) {
        continue;
      }

      if (x + 1 < size && valueAt(board, x + 1, y) === value) {
        pairs += 1;
      }

      if (y + 1 < size && valueAt(board, x, y + 1) === value) {
        pairs += 1;
      }
    }
  }

  return pairs;
}

/**
 * Lists every object a board graph holds, so two graphs can be checked for a
 * shared reference at every level.
 *
 * @param board Board to flatten.
 * @returns The board, its grid, the matrix, every column, every tile and
 *   every tile's position.
 */
function everyObject(board: SerializedGameState): object[] {
  const objects: object[] = [board, board.grid, board.grid.cells];

  for (const column of board.grid.cells) {
    objects.push(column);

    for (const tile of column) {
      if (tile !== null) {
        objects.push(tile, tile.position);
      }
    }
  }

  return objects;
}

describe('every board fixture builder', () => {
  it.each(BUILDERS)(
    '$name returns a size by size matrix with no missing cell',
    ({ build, minimumSize }: BuilderCase) => {
      for (const size of EXERCISED_SIZES) {
        expect(size).toBeGreaterThanOrEqual(minimumSize);

        const board = build(size);

        expect(board.grid.size).toBe(size);
        expect(board.grid.cells).toHaveLength(size);

        for (const column of board.grid.cells) {
          expect(column).toHaveLength(size);
        }
      }
    },
  );

  it.each(BUILDERS)(
    '$name places every tile in the slot its position names',
    ({ build }: BuilderCase) => {
      for (const size of EXERCISED_SIZES) {
        const board = build(size);

        for (const { address, tile } of occupiedCells(board)) {
          expect(tile.position).toStrictEqual({ x: address.x, y: address.y });
          expect(tile.value).toBeGreaterThan(0);
          expect(Number.isSafeInteger(tile.value)).toBe(true);
        }
      }
    },
  );

  it.each(BUILDERS)(
    '$name holds only a tile or null in every cell, never 0',
    ({ build }: BuilderCase) => {
      for (const size of EXERCISED_SIZES) {
        const board = build(size);

        for (const address of everyAddress(size)) {
          const cell = board.grid.cells[address.x][address.y];

          if (cell === null) {
            continue;
          }

          expect(Object.keys(cell).sort()).toStrictEqual([
            'position',
            'value',
          ]);
          expect(cell.value).not.toBe(0);
        }
      }
    },
  );

  it.each(BUILDERS)(
    '$name returns a fresh board that is neither over nor won',
    ({ build }: BuilderCase) => {
      const board = build();

      expect(board.score).toBe(0);
      expect(board.over).toBe(false);
      expect(board.won).toBe(false);
      expect(board.keepPlaying).toBe(false);
      expect(Object.keys(board).sort()).toStrictEqual([
        'grid',
        'keepPlaying',
        'over',
        'score',
        'won',
      ]);
    },
  );

  it.each(BUILDERS)(
    '$name defaults to the configured board size',
    ({ build }: BuilderCase) => {
      const board = build();

      expect(board.grid.size).toBe(DEFAULT_BOARD_SIZE);
      expect(board).toStrictEqual(build(DEFAULT_BOARD_SIZE));
    },
  );

  it.each(BUILDERS)(
    '$name returns an unfrozen graph at every level',
    ({ build }: BuilderCase) => {
      const board = build();

      for (const held of everyObject(board)) {
        expect(Object.isFrozen(held)).toBe(false);
      }
    },
  );
});

describe('board fixture freshness', () => {
  it.each(BUILDERS)(
    '$name shares no object between two returns',
    ({ build }: BuilderCase) => {
      const first = build();
      const second = build();
      const held = new Set<object>(everyObject(first));

      expect(second).toStrictEqual(first);
      expect(held.size).toBeGreaterThan(0);

      for (const candidate of everyObject(second)) {
        expect(held.has(candidate)).toBe(false);
      }
    },
  );

  it.each(BUILDERS)(
    '$name shares no object with the frozen constant it matches',
    ({ build, constant }: BuilderCase) => {
      const board = build();
      const frozen = new Set<object>(everyObject(constant));

      expect(board).toStrictEqual(constant);

      for (const candidate of everyObject(board)) {
        expect(frozen.has(candidate)).toBe(false);
      }
    },
  );

  it.each(BUILDERS)(
    '$name isolates a mutation of one return from the next',
    ({ build }: BuilderCase) => {
      const pristine = build();
      const mutated = build();

      mutated.score = 512;
      mutated.over = true;
      mutated.won = true;
      mutated.keepPlaying = true;
      mutated.grid.size = 1;
      mutated.grid.cells.length = 0;

      const rebuilt = build();

      expect(rebuilt).toStrictEqual(pristine);
      expect(rebuilt.grid.cells).not.toHaveLength(0);
    },
  );

  it.each(BUILDERS)(
    '$name isolates a mutation of a column, a tile and a position',
    ({ build }: BuilderCase) => {
      const pristine = build();
      const mutated = build();

      mutated.grid.cells[0][0] = { position: { x: 9, y: 9 }, value: 4096 };
      mutated.grid.cells[1] = [];

      for (const { tile } of occupiedCells(pristine)) {
        expect(tile.value).not.toBe(4096);
      }

      const rebuilt = build();

      expect(rebuilt).toStrictEqual(pristine);
      expect(rebuilt.grid.cells[1]).toHaveLength(rebuilt.grid.size);
    },
  );
});

describe('copyBoard', () => {
  it.each(BUILDERS)(
    'copies a $name board deep-equal and object-disjoint',
    ({ build }: BuilderCase) => {
      const board = build();
      const copy = copyBoard(board);
      const original = new Set<object>(everyObject(board));

      expect(copy).toStrictEqual(board);

      for (const candidate of everyObject(copy)) {
        expect(original.has(candidate)).toBe(false);
      }
    },
  );

  it('returns an unfrozen copy of a frozen constant', () => {
    for (const { constant } of BUILDERS) {
      const copy = copyBoard(constant);

      expect(copy).toStrictEqual(constant);

      for (const held of everyObject(copy)) {
        expect(Object.isFrozen(held)).toBe(false);
      }
    }
  });

  it('leaves the board it copied untouched when the copy is mutated', () => {
    const board = createMergePairBoard();
    const copy = copyBoard(board);

    copy.score = 64;
    copy.grid.cells[0][0] = null;
    copy.grid.cells[1][0] = { position: { x: 1, y: 0 }, value: 1024 };

    expect(board.score).toBe(0);
    expect(valueAt(board, 0, 0)).toBe(MERGE_PAIR_VALUE);
    expect(valueAt(board, 1, 0)).toBe(MERGE_PAIR_VALUE);
  });

  it('rebuilds each tile position rather than sharing it', () => {
    const board = createBlockedBoard();
    const copy = copyBoard(board);

    for (const { address, tile } of occupiedCells(copy)) {
      const source = board.grid.cells[address.x][address.y];

      expect(source).not.toBeNull();
      expect(tile.position).not.toBe(source?.position);
      expect(tile.position).toStrictEqual(source?.position);
    }
  });
});

describe('createEmptyBoard', () => {
  it('leaves every cell null at every exercised size', () => {
    for (const size of [MIN_EMPTY_SIZE, ...EXERCISED_SIZES]) {
      const board = createEmptyBoard(size);

      expect(occupiedCells(board)).toStrictEqual([]);

      for (const address of everyAddress(size)) {
        expect(board.grid.cells[address.x][address.y]).toBeNull();
      }
    }
  });

  it('builds the single-cell board the occupied fixtures refuse', () => {
    const board = createEmptyBoard(MIN_EMPTY_SIZE);

    expect(board.grid.size).toBe(MIN_EMPTY_SIZE);
    expect(board.grid.cells).toStrictEqual([[null]]);
  });
});

describe('createMergePairBoard', () => {
  it('places exactly two equal tiles at the start of row 0', () => {
    for (const size of EXERCISED_SIZES) {
      const board = createMergePairBoard(size);
      const occupied = occupiedCells(board);

      expect(occupied).toHaveLength(PAIR_TILE_COUNT);
      expect(occupied.map(({ address }) => address)).toStrictEqual([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ]);

      for (const { tile } of occupied) {
        expect(tile.value).toBe(MERGE_PAIR_VALUE);
      }
    }
  });

  it('carries exactly one adjacent equal pair, the mergeable one', () => {
    expect(adjacentEqualPairs(createMergePairBoard())).toBe(1);
  });
});

describe('createBlockedBoard', () => {
  it('fills column 0 with ascending powers of two and nothing else', () => {
    for (const size of EXERCISED_SIZES) {
      const board = createBlockedBoard(size);
      const occupied = occupiedCells(board);

      expect(occupied).toHaveLength(size);

      for (let y = 0; y < size; y += 1) {
        expect(valueAt(board, 0, y)).toBe(2 ** (y + 1));
      }

      for (let x = 1; x < size; x += 1) {
        for (let y = 0; y < size; y += 1) {
          expect(board.grid.cells[x][y]).toBeNull();
        }
      }
    }
  });

  it('carries no adjacent equal pair, so left, up and down are blocked', () => {
    for (const size of EXERCISED_SIZES) {
      expect(adjacentEqualPairs(createBlockedBoard(size))).toBe(0);
    }
  });
});

describe('createNearWinBoard', () => {
  it('places two tiles of half the configured win value', () => {
    const board = createNearWinBoard();
    const occupied = occupiedCells(board);

    expect(occupied).toHaveLength(PAIR_TILE_COUNT);

    for (const { tile } of occupied) {
      expect(tile.value * 2).toBe(DEFAULT_RULES_CONFIG.winValue);
    }
  });

  it.each(ACCEPTED_WIN_VALUES)(
    'halves a win value of %i into the pair that merges onto it',
    (winValue: number) => {
      const board = createNearWinBoard(DEFAULT_BOARD_SIZE, winValue);
      const occupied = occupiedCells(board);

      expect(occupied).toHaveLength(PAIR_TILE_COUNT);
      expect(occupied.map(({ address }) => address)).toStrictEqual([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ]);

      for (const { tile } of occupied) {
        expect(tile.value).toBe(winValue / 2);
        expect(tile.value * 2).toBe(winValue);
      }
    },
  );

  it('leaves every cell outside the pair empty', () => {
    const size = 4;
    const board = createNearWinBoard(size);

    for (const address of everyAddress(size)) {
      const occupiedSlot = address.y === 0 && address.x < PAIR_TILE_COUNT;

      if (!occupiedSlot) {
        expect(board.grid.cells[address.x][address.y]).toBeNull();
      }
    }
  });
});

describe('createNearLossBoard', () => {
  it('fills every cell at every exercised size', () => {
    for (const size of EXERCISED_SIZES) {
      const board = createNearLossBoard(size);

      expect(occupiedCells(board)).toHaveLength(size * size);
    }
  });

  it('carries exactly one adjacent equal pair, at (0,0) and (1,0)', () => {
    for (const size of EXERCISED_SIZES) {
      const board = createNearLossBoard(size);

      expect(adjacentEqualPairs(board)).toBe(1);
      expect(valueAt(board, 0, 0)).toBe(valueAt(board, 1, 0));
    }
  });

  it('draws every value from a cycle of five distinct values', () => {
    const board = createNearLossBoard(DEFAULT_BOARD_SIZE);
    const values = new Set(
      occupiedCells(board).map(({ tile }) => tile.value),
    );

    expect(values.size).toBeLessThanOrEqual(CROWDED_CYCLE_LENGTH);

    for (const value of values) {
      expect([2, 4, 8, 16, 32]).toContain(value);
    }
  });

  it('stays far below the configured win value', () => {
    for (const size of EXERCISED_SIZES) {
      const board = createNearLossBoard(size);
      const highest = Math.max(
        ...occupiedCells(board).map(({ tile }) => tile.value),
      );

      expect(highest).toBeLessThan(DEFAULT_RULES_CONFIG.winValue);
    }
  });
});

describe('board fixture argument guards', () => {
  it.each(BUILDERS)(
    '$name throws RangeError below its own minimum size',
    ({ build, minimumSize }: BuilderCase) => {
      expect(() => build(minimumSize)).not.toThrow();
      expect(() => build(minimumSize - 1)).toThrow(RangeError);
    },
  );

  it.each(BUILDERS)(
    '$name throws RangeError for every size that is not a usable integer',
    ({ build, minimumSize }: BuilderCase) => {
      for (const size of REJECTED_SIZES) {
        if (Number.isSafeInteger(size) && size >= minimumSize) {
          continue;
        }

        expect(() => build(size)).toThrow(RangeError);
      }
    },
  );

  it('rejects a single-cell board from every occupied fixture', () => {
    for (const { build, minimumSize } of BUILDERS) {
      if (minimumSize <= MIN_EMPTY_SIZE) {
        continue;
      }

      expect(() => build(MIN_EMPTY_SIZE)).toThrow(RangeError);
    }
  });

  it.each(REJECTED_WIN_VALUES)(
    'createNearWinBoard throws RangeError for a win value of %s',
    (winValue: number) => {
      expect(() => createNearWinBoard(DEFAULT_BOARD_SIZE, winValue)).toThrow(
        RangeError,
      );
    },
  );

  it('createNearWinBoard rejects a bad size before a bad win value', () => {
    expect(() => createNearWinBoard(1, 2048)).toThrow(RangeError);
    expect(() => createNearWinBoard(4, 2048)).not.toThrow();
  });
});

describe('the five frozen board constants', () => {
  it.each(BUILDERS)(
    '$name has a frozen constant equal to its default call',
    ({ build, constant }: BuilderCase) => {
      expect(constant).toStrictEqual(build());
      expect(constant.grid.size).toBe(DEFAULT_BOARD_SIZE);
    },
  );

  it.each(BUILDERS)(
    'the constant matching $name is frozen at every level',
    ({ constant }: BuilderCase) => {
      const held = everyObject(constant);

      expect(held.length).toBeGreaterThan(0);

      for (const object of held) {
        expect(Object.isFrozen(object)).toBe(true);
      }
    },
  );

  it('refuses a write to a constant, its grid, a column or a tile', () => {
    const board = MERGE_PAIR_BOARD;
    const tile = board.grid.cells[0][0];

    expect(tile).not.toBeNull();

    expect(() => {
      (board as { score: number }).score = 99;
    }).toThrow(TypeError);
    expect(() => {
      (board.grid as { size: number }).size = 9;
    }).toThrow(TypeError);
    expect(() => {
      board.grid.cells[1] = [];
    }).toThrow(TypeError);
    expect(() => {
      board.grid.cells[0][0] = null;
    }).toThrow(TypeError);

    if (tile !== null) {
      expect(() => {
        tile.value = 4096;
      }).toThrow(TypeError);
      expect(() => {
        tile.position.x = 3;
      }).toThrow(TypeError);
    }

    expect(board.score).toBe(0);
    expect(board.grid.size).toBe(DEFAULT_BOARD_SIZE);
    expect(valueAt(board, 0, 0)).toBe(MERGE_PAIR_VALUE);
  });

  it('names five distinct constants, one per builder', () => {
    const constants = [
      EMPTY_BOARD,
      MERGE_PAIR_BOARD,
      BLOCKED_BOARD,
      NEAR_WIN_BOARD,
      NEAR_LOSS_BOARD,
    ];

    expect(new Set(constants).size).toBe(BUILDERS.length);
    expect(constants.map((board) => board.grid.size)).toStrictEqual(
      constants.map(() => DEFAULT_BOARD_SIZE),
    );
  });
});
