// Contract suite for src/engine/board-effects.ts: the transactional board and
// rules write channel a hook handler records through.
//
// What is pinned here:
//   the seven commands and their validation;
//   the projection a multi-step handler plans against;
//   the record order the applier replays in;
//   the vanilla relocation order of js/game_manager.js L123-L127 and the
//   flattened indexing of js/grid.js L88-L94, verified by asserting every
//   occupant's own x/y match its array coordinates after every effect;
//   `previousPosition` as the animation protocol of js/tile.js L6-L7;
//   `cellContent`'s off-lattice `null` valve of js/grid.js L79-L85, which the
//   move resolver's farthest-position walk terminates on;
//   rollback leaving NOTHING behind;
//   the inert queue refusing every command.
//
// This suite reads no DOM and no storage, consumes no randomness of its own
// beyond a seeded substream table, and writes no snapshot.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BOARD_SIZE,
  createDefaultRulesConfig,
} from '../../../src/config/default-config';
import type { RulesConfig } from '../../../src/config/rules-config';
import {
  BOARD_EFFECT_NAMES,
  INERT_BOARD_EFFECTS,
  applyBoardEffects,
  openBoardEffects,
} from '../../../src/engine/board-effects';
import type {
  BoardEffect,
  BoardEffectQueue,
  BoardEffectTransaction,
} from '../../../src/engine/board-effects';
import { Grid } from '../../../src/engine/grid';
import { Tile } from '../../../src/engine/tile';
import type { Position, SerializedGrid } from '../../../src/engine/types';

/* ==========================================================================
 * Harness
 * ========================================================================== */

const SIZE = DEFAULT_BOARD_SIZE;

/** Every command name the module declares. */
const EXPECTED_EFFECT_NAMES: readonly string[] = [
  'insertTile',
  'removeTile',
  'moveTile',
  'restoreBoard',
  'resizeBoard',
  'setMergePredicate',
  'setSpawnWeights',
];

interface Harness {
  readonly grid: Grid;
  readonly config: RulesConfig;
  readonly effects: BoardEffectTransaction;
  readonly queue: BoardEffectQueue;
}

/** Opens a transaction over an empty board of the default size. */
function open(size = SIZE): Harness {
  const grid = new Grid(size);
  const config = createDefaultRulesConfig();

  config.boardSize = size;

  const effects = openBoardEffects(grid, grid, config);

  return { grid, config, effects, queue: effects.queue };
}

/** Writes a tile straight onto the live board, bypassing the queue. */
function place(grid: Grid, x: number, y: number, value: number): Tile {
  const tile = new Tile({ x, y }, value);

  grid.insertTile(tile);

  return tile;
}

/** Every occupied cell of a live board, x-outer and y-inner. */
function occupants(grid: Grid): { x: number; y: number; value: number }[] {
  const found: { x: number; y: number; value: number }[] = [];

  grid.eachCell((_x, _y, tile): void => {
    if (tile !== null) {
      found.push({ x: tile.x, y: tile.y, value: tile.value });
    }
  });

  return found;
}

/**
 * Asserts the lattice is internally consistent: every slot holds a `Tile` or
 * `null`, every occupant's own coordinates match its array coordinates, every
 * row has the grid's edge length, and an off-lattice probe still reads `null`.
 */
function expectConsistentLattice(grid: Grid): void {
  expect(grid.cells).toHaveLength(grid.size);

  for (let x = 0; x < grid.size; x += 1) {
    const column = grid.cells[x];

    expect(column).toHaveLength(grid.size);

    for (let y = 0; y < grid.size; y += 1) {
      const slot = column[y];

      expect(slot === null || slot instanceof Tile).toBe(true);

      if (slot !== null) {
        expect(slot.x).toBe(x);
        expect(slot.y).toBe(y);
      }
    }
  }

  expect(grid.cellContent({ x: grid.size, y: 0 })).toBeNull();
  expect(grid.cellContent({ x: 0, y: grid.size })).toBeNull();
  expect(grid.cellContent({ x: -1, y: 0 })).toBeNull();
}

/* ==========================================================================
 * 1. The declared command vocabulary
 * ========================================================================== */

describe('BOARD_EFFECT_NAMES', () => {
  it('declares exactly the seven commands, in declaration order', () => {
    expect([...BOARD_EFFECT_NAMES]).toEqual(EXPECTED_EFFECT_NAMES);
  });

  it('is frozen, so the vocabulary cannot be extended through it', () => {
    expect(Object.isFrozen(BOARD_EFFECT_NAMES)).toBe(true);
  });
});

/* ==========================================================================
 * 2. Nothing reaches the board until commit
 * ========================================================================== */

describe('the transaction boundary', () => {
  it('records without writing the board', () => {
    const harness = open();

    expect(harness.queue.insertTile({ x: 1, y: 2 }, 4)).toBe(true);
    expect(harness.queue.length).toBe(1);
    expect(occupants(harness.grid)).toEqual([]);
  });

  it('writes on commit and reports how many commands it wrote', () => {
    const harness = open();

    harness.queue.insertTile({ x: 1, y: 2 }, 4);
    harness.queue.insertTile({ x: 0, y: 0 }, 2);

    expect(harness.effects.commit()).toBe(2);
    expect(occupants(harness.grid)).toEqual([
      { x: 0, y: 0, value: 2 },
      { x: 1, y: 2, value: 4 },
    ]);
    expectConsistentLattice(harness.grid);
  });

  it('leaves NOTHING behind on rollback', () => {
    const harness = open();

    place(harness.grid, 3, 3, 8);
    harness.queue.insertTile({ x: 1, y: 1 }, 2);
    harness.queue.removeTile({ x: 3, y: 3 });
    harness.queue.resizeBoard(2);

    expect(harness.effects.rollback()).toBe(3);
    expect(occupants(harness.grid)).toEqual([{ x: 3, y: 3, value: 8 }]);
    expect(harness.grid.size).toBe(SIZE);
    expect(harness.config.boardSize).toBe(SIZE);
    expectConsistentLattice(harness.grid);
  });

  it('empties the queue on commit, so a second commit writes nothing', () => {
    const harness = open();

    harness.queue.insertTile({ x: 1, y: 1 }, 2);

    expect(harness.effects.commit()).toBe(1);
    expect(harness.queue.length).toBe(0);
    expect(harness.effects.commit()).toBe(0);
    expect(occupants(harness.grid)).toHaveLength(1);
  });

  it('discards recorded commands through clear()', () => {
    const harness = open();

    harness.queue.insertTile({ x: 1, y: 1 }, 2);
    harness.queue.clear();

    expect(harness.queue.length).toBe(0);
    expect(harness.effects.commit()).toBe(0);
    expect(occupants(harness.grid)).toEqual([]);
  });
});

/* ==========================================================================
 * 3. insertTile
 * ========================================================================== */

describe('insertTile', () => {
  it('inserts a fresh tile that renders as a spawn, not a move', () => {
    const harness = open();

    harness.queue.insertTile({ x: 2, y: 1 }, 4);
    harness.effects.commit();

    const inserted = harness.grid.cellContent({ x: 2, y: 1 });

    expect(inserted?.value).toBe(4);
    expect(inserted?.previousPosition).toBeNull();
  });

  it('refuses an occupied cell', () => {
    const harness = open();

    place(harness.grid, 1, 1, 2);

    expect(harness.queue.insertTile({ x: 1, y: 1 }, 4)).toBe(false);
    expect(harness.queue.length).toBe(0);
  });

  it('refuses a cell it has already claimed within the same handler', () => {
    const harness = open();

    expect(harness.queue.insertTile({ x: 1, y: 1 }, 2)).toBe(true);
    expect(harness.queue.insertTile({ x: 1, y: 1 }, 4)).toBe(false);
    expect(harness.queue.length).toBe(1);
  });

  it('refuses an off-lattice cell', () => {
    const harness = open();

    expect(harness.queue.insertTile({ x: SIZE, y: 0 }, 2)).toBe(false);
    expect(harness.queue.insertTile({ x: 0, y: SIZE }, 2)).toBe(false);
  });

  it('refuses a coordinate that is not an index', () => {
    const harness = open();
    const bad: readonly Position[] = [
      { x: -1, y: 0 },
      { x: 0.5, y: 0 },
      { x: Number.NaN, y: 0 },
      { x: 0, y: Number.POSITIVE_INFINITY },
    ];

    for (const cell of bad) {
      expect(harness.queue.insertTile(cell, 2)).toBe(false);
    }

    expect(harness.queue.length).toBe(0);
  });

  it('refuses a value that is not a positive integer', () => {
    const harness = open();

    expect(harness.queue.insertTile({ x: 0, y: 0 }, 0)).toBe(false);
    expect(harness.queue.insertTile({ x: 0, y: 0 }, -2)).toBe(false);
    expect(harness.queue.insertTile({ x: 0, y: 0 }, 2.5)).toBe(false);
    expect(harness.queue.insertTile({ x: 0, y: 0 }, Number.NaN)).toBe(false);
  });
});

/* ==========================================================================
 * 4. removeTile
 * ========================================================================== */

describe('removeTile', () => {
  it('clears an occupied cell', () => {
    const harness = open();

    place(harness.grid, 2, 2, 16);

    expect(harness.queue.removeTile({ x: 2, y: 2 })).toBe(true);
    harness.effects.commit();

    expect(occupants(harness.grid)).toEqual([]);
    expectConsistentLattice(harness.grid);
  });

  it('refuses an empty cell', () => {
    const harness = open();

    expect(harness.queue.removeTile({ x: 2, y: 2 })).toBe(false);
    expect(harness.queue.length).toBe(0);
  });

  it('refuses a cell it has already cleared within the same handler', () => {
    const harness = open();

    place(harness.grid, 2, 2, 16);

    expect(harness.queue.removeTile({ x: 2, y: 2 })).toBe(true);
    expect(harness.queue.removeTile({ x: 2, y: 2 })).toBe(false);
  });
});

/* ==========================================================================
 * 5. moveTile
 * ========================================================================== */

describe('moveTile', () => {
  it('relocates a tile and records where it came from', () => {
    const harness = open();

    place(harness.grid, 0, 0, 8);

    expect(harness.queue.moveTile({ x: 0, y: 0 }, { x: 3, y: 3 })).toBe(true);
    harness.effects.commit();

    const moved = harness.grid.cellContent({ x: 3, y: 3 });

    expect(moved?.value).toBe(8);
    expect(moved?.previousPosition).toEqual({ x: 0, y: 0 });
    expect(harness.grid.cellContent({ x: 0, y: 0 })).toBeNull();
    expectConsistentLattice(harness.grid);
  });

  it('leaves previousPosition null when the caller asks for no tween', () => {
    const harness = open();

    place(harness.grid, 0, 0, 8);
    harness.queue.moveTile({ x: 0, y: 0 }, { x: 1, y: 0 }, false);
    harness.effects.commit();

    expect(
      harness.grid.cellContent({ x: 1, y: 0 })?.previousPosition,
    ).toBeNull();
  });

  it('refuses an empty origin and an occupied destination', () => {
    const harness = open();

    place(harness.grid, 0, 0, 8);
    place(harness.grid, 1, 0, 4);

    expect(harness.queue.moveTile({ x: 2, y: 2 }, { x: 3, y: 3 })).toBe(false);
    expect(harness.queue.moveTile({ x: 0, y: 0 }, { x: 1, y: 0 })).toBe(false);
    expect(harness.queue.length).toBe(0);
  });

  it('accepts a relocation onto the cell the tile already occupies', () => {
    const harness = open();

    place(harness.grid, 2, 3, 8);

    expect(harness.queue.moveTile({ x: 2, y: 3 }, { x: 2, y: 3 })).toBe(true);
    expect(harness.queue.length).toBe(0);
  });

  it('swaps two tiles when the caller frees a cell first', () => {
    const harness = open();

    place(harness.grid, 0, 0, 2);
    place(harness.grid, 1, 1, 4);

    expect(harness.queue.moveTile({ x: 0, y: 0 }, { x: 3, y: 3 })).toBe(true);
    expect(harness.queue.moveTile({ x: 1, y: 1 }, { x: 0, y: 0 })).toBe(true);
    expect(harness.queue.moveTile({ x: 3, y: 3 }, { x: 1, y: 1 })).toBe(true);
    harness.effects.commit();

    expect(harness.grid.cellContent({ x: 0, y: 0 })?.value).toBe(4);
    expect(harness.grid.cellContent({ x: 1, y: 1 })?.value).toBe(2);
    expect(occupants(harness.grid)).toHaveLength(2);
    expectConsistentLattice(harness.grid);
  });
});

/* ==========================================================================
 * 6. The projection a multi-step handler plans against
 * ========================================================================== */

describe('the projection', () => {
  it('reports the board as the recorded commands leave it', () => {
    const harness = open();

    place(harness.grid, 0, 0, 2);

    expect(harness.queue.cellValue({ x: 0, y: 0 })).toBe(2);
    expect(harness.queue.cellOccupied({ x: 0, y: 0 })).toBe(true);

    harness.queue.moveTile({ x: 0, y: 0 }, { x: 2, y: 2 });

    expect(harness.queue.cellOccupied({ x: 0, y: 0 })).toBe(false);
    expect(harness.queue.cellValue({ x: 2, y: 2 })).toBe(2);
  });

  it('lists available cells x-outer and y-inner, minus claimed cells', () => {
    const harness = open(2);

    expect(harness.queue.availableCells()).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
    ]);

    harness.queue.insertTile({ x: 0, y: 1 }, 2);

    expect(harness.queue.availableCells()).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
    ]);
  });

  it('lists occupied cells with their values, x-outer and y-inner', () => {
    const harness = open(2);

    place(harness.grid, 1, 0, 8);
    place(harness.grid, 0, 1, 4);

    expect(harness.queue.occupiedCells()).toEqual([
      { x: 0, y: 1, value: 4 },
      { x: 1, y: 0, value: 8 },
    ]);
  });

  it('reads the live board once, not on every query', () => {
    const harness = open();

    // The first query fixes the projection. A write made straight to the live
    // board afterwards is invisible to it, which is exactly the property a
    // handler needs: it plans against one board rather than a moving one.
    expect(harness.queue.cellOccupied({ x: 0, y: 0 })).toBe(false);
    place(harness.grid, 0, 0, 2);

    expect(harness.queue.cellOccupied({ x: 0, y: 0 })).toBe(false);
  });

  it('reads null and false outside the projected board', () => {
    const harness = open();

    expect(harness.queue.cellValue({ x: SIZE, y: 0 })).toBeNull();
    expect(harness.queue.cellOccupied({ x: 0, y: SIZE })).toBe(false);
  });
});

/* ==========================================================================
 * 7. restoreBoard
 * ========================================================================== */

describe('restoreBoard', () => {
  it('replaces the whole lattice with the snapshot', () => {
    const harness = open();

    place(harness.grid, 0, 0, 2);
    place(harness.grid, 1, 1, 4);

    const snapshot = harness.grid.serialize();

    place(harness.grid, 3, 3, 1024);
    harness.grid.removeTile(
      harness.grid.cellContent({ x: 0, y: 0 }) ?? new Tile({ x: 0, y: 0 }),
    );

    const restore = openBoardEffects(
      harness.grid,
      harness.grid,
      harness.config,
    );

    expect(restore.queue.restoreBoard(snapshot)).toBe(true);
    restore.commit();

    expect(occupants(harness.grid)).toEqual([
      { x: 0, y: 0, value: 2 },
      { x: 1, y: 1, value: 4 },
    ]);
    expectConsistentLattice(harness.grid);
  });

  it('restores tiles that render as appearing rather than moving', () => {
    const harness = open();

    place(harness.grid, 0, 0, 2);

    const snapshot = harness.grid.serialize();
    const restore = openBoardEffects(
      harness.grid,
      harness.grid,
      harness.config,
    );

    restore.queue.restoreBoard(snapshot);
    restore.commit();

    expect(
      harness.grid.cellContent({ x: 0, y: 0 })?.previousPosition,
    ).toBeNull();
  });

  it('drops a snapshot tile beyond the live board instead of inserting', () => {
    const harness = open(2);
    const oversized: SerializedGrid = {
      size: 4,
      cells: [
        [{ position: { x: 0, y: 0 }, value: 2 }, null, null, null],
        [null, null, null, null],
        [null, null, { position: { x: 2, y: 2 }, value: 64 }, null],
        [null, null, null, null],
      ],
    };

    expect(harness.queue.restoreBoard(oversized)).toBe(true);
    harness.effects.commit();

    expect(occupants(harness.grid)).toEqual([{ x: 0, y: 0, value: 2 }]);
    expect(harness.grid.size).toBe(2);
    expectConsistentLattice(harness.grid);
  });

  it('empties the board for a snapshot carrying no tile', () => {
    const harness = open(2);

    place(harness.grid, 0, 0, 2);

    expect(
      harness.queue.restoreBoard({
        size: 2,
        cells: [
          [null, null],
          [null, null],
        ],
      }),
    ).toBe(true);
    harness.effects.commit();

    expect(occupants(harness.grid)).toEqual([]);
  });

  it('refuses a snapshot that carries no cell matrix', () => {
    const harness = open();
    const malformed = { size: 4 } as unknown as SerializedGrid;

    expect(harness.queue.restoreBoard(malformed)).toBe(false);
    expect(harness.queue.length).toBe(0);
  });

  it('projects the restored board, so a later command plans against it', () => {
    const harness = open(2);

    place(harness.grid, 0, 0, 2);
    place(harness.grid, 1, 1, 4);

    const snapshot = harness.grid.serialize();
    const restore = openBoardEffects(
      harness.grid,
      harness.grid,
      harness.config,
    );

    harness.grid.removeTile(
      harness.grid.cellContent({ x: 1, y: 1 }) ?? new Tile({ x: 1, y: 1 }),
    );

    restore.queue.restoreBoard(snapshot);

    expect(restore.queue.cellOccupied({ x: 1, y: 1 })).toBe(true);
    expect(restore.queue.insertTile({ x: 1, y: 1 }, 8)).toBe(false);
  });
});

/* ==========================================================================
 * 8. resizeBoard
 * ========================================================================== */

describe('resizeBoard', () => {
  it('sets BOTH the lattice size and the configured board size', () => {
    const harness = open();

    expect(harness.queue.resizeBoard(3)).toBe(true);
    harness.effects.commit();

    expect(harness.grid.size).toBe(3);
    expect(harness.config.boardSize).toBe(3);
  });

  it('rebuilds the lattice so every traversal agrees on the new bound', () => {
    const harness = open();

    place(harness.grid, 0, 0, 2);
    place(harness.grid, 3, 3, 64);
    harness.queue.resizeBoard(2);
    harness.effects.commit();

    expect(harness.grid.cells).toHaveLength(2);
    expect(harness.grid.availableCells()).toHaveLength(3);
    expect(occupants(harness.grid)).toEqual([{ x: 0, y: 0, value: 2 }]);
    expectConsistentLattice(harness.grid);
  });

  it('leaves a shrunk board serialising coherently at the new size', () => {
    const harness = open();

    place(harness.grid, 0, 0, 2);
    harness.queue.resizeBoard(2);
    harness.effects.commit();

    const snapshot = harness.grid.serialize();
    const roundTripped = JSON.parse(
      JSON.stringify(snapshot),
    ) as SerializedGrid;
    const rebuilt = new Grid(roundTripped.size, roundTripped.cells);

    expect(roundTripped.size).toBe(2);
    expect(rebuilt.serialize()).toEqual(snapshot);
    expectConsistentLattice(rebuilt);
  });

  it('does not touch the win value', () => {
    const harness = open();
    const winValue = harness.config.winValue;

    harness.queue.resizeBoard(2);
    harness.effects.commit();

    expect(harness.config.winValue).toBe(winValue);
  });

  it('refuses a size below the floor, above the ceiling, or unchanged', () => {
    const harness = open();

    expect(harness.queue.resizeBoard(1)).toBe(false);
    expect(harness.queue.resizeBoard(17)).toBe(false);
    expect(harness.queue.resizeBoard(SIZE)).toBe(false);
    expect(harness.queue.resizeBoard(2.5)).toBe(false);
    expect(harness.queue.length).toBe(0);
  });

  it('trims the projection, so a dropped cell cannot be addressed', () => {
    const harness = open();

    place(harness.grid, 3, 3, 64);

    expect(harness.queue.resizeBoard(2)).toBe(true);
    expect(harness.queue.size).toBe(2);
    expect(harness.queue.cellOccupied({ x: 3, y: 3 })).toBe(false);
    expect(harness.queue.insertTile({ x: 3, y: 3 }, 2)).toBe(false);
  });

  it('re-homes a survivor recorded before the resize', () => {
    const harness = open();

    place(harness.grid, 3, 3, 64);

    expect(harness.queue.moveTile({ x: 3, y: 3 }, { x: 1, y: 1 })).toBe(true);
    expect(harness.queue.resizeBoard(2)).toBe(true);
    harness.effects.commit();

    expect(occupants(harness.grid)).toEqual([{ x: 1, y: 1, value: 64 }]);
    expect(harness.grid.size).toBe(2);
    expectConsistentLattice(harness.grid);
  });
});

/* ==========================================================================
 * 9. The rules commands
 * ========================================================================== */

describe('setMergePredicate', () => {
  it('installs the predicate on the live rules', () => {
    const harness = open();
    const always = (): boolean => true;

    expect(harness.queue.setMergePredicate(always)).toBe(true);
    expect(harness.config.merge.canMerge).not.toBe(always);

    harness.effects.commit();

    expect(harness.config.merge.canMerge).toBe(always);
  });

  it('refuses a value that is not callable', () => {
    const harness = open();
    const notAPredicate = 4 as unknown as () => boolean;

    expect(harness.queue.setMergePredicate(notAPredicate)).toBe(false);
    expect(harness.queue.length).toBe(0);
  });
});

describe('setSpawnWeights', () => {
  it('installs a fresh array on the live rules', () => {
    const harness = open();
    const weights = [0.5, 0.5];

    expect(harness.queue.setSpawnWeights(weights)).toBe(true);
    harness.effects.commit();

    expect(harness.config.spawn.weights).toEqual([0.5, 0.5]);
    expect(harness.config.spawn.weights).not.toBe(weights);
  });

  it('copies at record time, so a later caller edit does not reach it', () => {
    const harness = open();
    const weights = [0.5, 0.5];

    harness.queue.setSpawnWeights(weights);
    weights[0] = 99;
    harness.effects.commit();

    expect(harness.config.spawn.weights).toEqual([0.5, 0.5]);
  });

  it('refuses a list nothing can be drawn from', () => {
    const harness = open();

    expect(harness.queue.setSpawnWeights([])).toBe(false);
    expect(harness.queue.setSpawnWeights([0, 0])).toBe(false);
    expect(harness.queue.setSpawnWeights([1, -1])).toBe(false);
    expect(harness.queue.setSpawnWeights([1, Number.NaN])).toBe(false);
    expect(
      harness.queue.setSpawnWeights([1, Number.POSITIVE_INFINITY]),
    ).toBe(false);
    expect(harness.queue.length).toBe(0);
  });
});

/* ==========================================================================
 * 10. The applier, called directly
 * ========================================================================== */

describe('applyBoardEffects', () => {
  it('replays commands in record order', () => {
    const grid = new Grid(SIZE);
    const config = createDefaultRulesConfig();
    const effects: readonly BoardEffect[] = [
      { kind: 'insertTile', cell: { x: 0, y: 0 }, value: 2 },
      {
        kind: 'moveTile',
        from: { x: 0, y: 0 },
        to: { x: 1, y: 0 },
        tween: true,
      },
      { kind: 'insertTile', cell: { x: 0, y: 0 }, value: 4 },
    ];

    expect(applyBoardEffects(effects, grid, config)).toBe(3);
    expect(occupants(grid)).toEqual([
      { x: 0, y: 0, value: 4 },
      { x: 1, y: 0, value: 2 },
    ]);
    expectConsistentLattice(grid);
  });

  it('absorbs a command the live board no longer supports', () => {
    const grid = new Grid(SIZE);
    const config = createDefaultRulesConfig();
    const effects: readonly BoardEffect[] = [
      { kind: 'removeTile', cell: { x: 0, y: 0 } },
      {
        kind: 'moveTile',
        from: { x: 2, y: 2 },
        to: { x: 3, y: 3 },
        tween: true,
      },
      { kind: 'insertTile', cell: { x: 99, y: 99 }, value: 2 },
    ];

    expect(applyBoardEffects(effects, grid, config)).toBe(3);
    expect(occupants(grid)).toEqual([]);
    expectConsistentLattice(grid);
  });
});

/* ==========================================================================
 * 11. The inert queue
 * ========================================================================== */

describe('INERT_BOARD_EFFECTS', () => {
  it('refuses every command and throws nothing', () => {
    expect(INERT_BOARD_EFFECTS.insertTile({ x: 0, y: 0 }, 2)).toBe(false);
    expect(INERT_BOARD_EFFECTS.removeTile({ x: 0, y: 0 })).toBe(false);
    expect(INERT_BOARD_EFFECTS.moveTile({ x: 0, y: 0 }, { x: 1, y: 1 })).toBe(
      false,
    );
    expect(
      INERT_BOARD_EFFECTS.restoreBoard({ size: 0, cells: [] }),
    ).toBe(false);
    expect(INERT_BOARD_EFFECTS.resizeBoard(2)).toBe(false);
    expect(INERT_BOARD_EFFECTS.setMergePredicate((): boolean => true)).toBe(
      false,
    );
    expect(INERT_BOARD_EFFECTS.setSpawnWeights([1])).toBe(false);
  });

  it('reads an empty board', () => {
    expect(INERT_BOARD_EFFECTS.size).toBe(0);
    expect(INERT_BOARD_EFFECTS.length).toBe(0);
    expect(INERT_BOARD_EFFECTS.cellValue({ x: 0, y: 0 })).toBeNull();
    expect(INERT_BOARD_EFFECTS.cellOccupied({ x: 0, y: 0 })).toBe(false);
    expect(INERT_BOARD_EFFECTS.availableCells()).toEqual([]);
    expect(INERT_BOARD_EFFECTS.occupiedCells()).toEqual([]);
    expect(INERT_BOARD_EFFECTS.clear()).toBeUndefined();
  });

  it('is frozen', () => {
    expect(Object.isFrozen(INERT_BOARD_EFFECTS)).toBe(true);
  });
});

/* ==========================================================================
 * 12. Bounds
 * ========================================================================== */

describe('the queue bound', () => {
  it('refuses a command beyond the per-handler ceiling', () => {
    const harness = open(16);
    let recorded = 0;

    for (let index = 0; index < 600; index += 1) {
      const x = index % 16;
      const y = Math.floor(index / 16) % 16;

      if (harness.queue.removeTile({ x, y })) {
        recorded += 1;
      } else if (harness.queue.setMergePredicate((): boolean => true)) {
        recorded += 1;
      }
    }

    expect(recorded).toBeLessThanOrEqual(512);
    expect(harness.queue.length).toBeLessThanOrEqual(512);
  });
});
