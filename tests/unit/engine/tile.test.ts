// Ported-fidelity suite for src/engine/tile.ts against its deleted vanilla
// predecessor js/tile.js. The constructs pinned are the constructor,
// `savePosition()`, `updatePosition()` and `serialize()`.
//
// The assertions hold those constructs to the consumers the vanilla sources
// were: grid rehydration reconstructing a tile from a position and a value,
// grid insertion indexing `cells[tile.x][tile.y]`, the merge condition
// comparing values and rejecting an already-merged neighbour, the merged tile
// carrying both source tiles in `mergedFrom`, and the change check comparing a
// cell against a tile.
//
// This suite reads no DOM, no storage and no clock, consumes no randomness,
// installs no mock and writes no snapshot.

import { describe, expect, it } from 'vitest';

import type { MergeTileView } from '../../../src/config/rules-config';
import { Tile } from '../../../src/engine/tile';
import type {
  Position,
  SerializedGameState,
  SerializedTile,
} from '../../../src/engine/types';
import {
  MERGE_PAIR_BOARD,
  createMergePairBoard,
} from '../../fixtures/boards';

const ORIGIN_X = 1;

const ORIGIN_Y = 2;

const TARGET_X = 3;

const TARGET_Y = 0;

const TILE_VALUE = 4;

const DEFAULT_VALUE = 2;

const MERGED_VALUE = 8;

const MERGE_PAIR_X = 0;

const MERGE_PAIR_NEXT_X = 1;

const MERGE_PAIR_Y = 0;

const MERGE_PAIR_VALUE = 2;

const MERGE_SOURCE_COUNT = 2;

function originCell(): Position {
  return { x: ORIGIN_X, y: ORIGIN_Y };
}

function targetCell(): Position {
  return { x: TARGET_X, y: TARGET_Y };
}

function fixtureTileAt(
  board: SerializedGameState,
  x: number,
  y: number,
): SerializedTile {
  const cell = board.grid.cells[x][y];

  if (cell === null) {
    throw new Error(`Fixture cell (${x}, ${y}) carries no tile.`);
  }

  return cell;
}

function savedCellOf(tile: Tile): Position {
  const saved = tile.previousPosition;

  if (saved === null) {
    throw new Error('previousPosition is null.');
  }

  return saved;
}

function sourcesOf(tile: Tile): readonly [Tile, Tile] {
  const sources = tile.mergedFrom;

  if (sources === null) {
    throw new Error('mergedFrom is null.');
  }

  return sources;
}

describe('Tile constructor (js/tile.js L1-L8)', () => {
  it('flattens position onto top-level x and y (js/tile.js L2-L3)', () => {
    const tile = new Tile({ x: ORIGIN_X, y: ORIGIN_Y }, TILE_VALUE);

    expect(tile.x).toBe(ORIGIN_X);
    expect(tile.y).toBe(ORIGIN_Y);
    expect(Object.prototype.hasOwnProperty.call(tile, 'x')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(tile, 'y')).toBe(true);
  });

  it('exposes no nested position member (js/tile.js L2-L3)', () => {
    const tile = new Tile(originCell(), TILE_VALUE);

    expect('position' in tile).toBe(false);
    expect(Object.keys(tile)).not.toContain('position');
  });

  it('declares exactly the five vanilla members (js/tile.js L1-L8)', () => {
    const tile = new Tile(originCell(), TILE_VALUE);

    expect(Object.keys(tile).sort()).toEqual([
      'mergedFrom',
      'previousPosition',
      'value',
      'x',
      'y',
    ]);
  });

  it('is usable as a Position by its flat members (js/tile.js L2-L3)', () => {
    const tile = new Tile(originCell(), TILE_VALUE);
    const asPosition: Position = tile;

    expect(asPosition.x).toBe(ORIGIN_X);
    expect(asPosition.y).toBe(ORIGIN_Y);
  });

  it('copies the position argument, not the object (js/tile.js L2-L3)', () => {
    const cell = originCell();
    const tile = new Tile(cell, TILE_VALUE);

    cell.x = TARGET_X;
    cell.y = TARGET_Y;

    expect(tile.x).toBe(ORIGIN_X);
    expect(tile.y).toBe(ORIGIN_Y);
  });

  it('accepts a frozen position argument (js/tile.js L2-L3)', () => {
    const frozen = fixtureTileAt(
      MERGE_PAIR_BOARD,
      MERGE_PAIR_NEXT_X,
      MERGE_PAIR_Y,
    );
    const tile = new Tile(frozen.position, frozen.value);

    expect(Object.isFrozen(frozen.position)).toBe(true);
    expect(tile.x).toBe(MERGE_PAIR_NEXT_X);
    expect(tile.y).toBe(MERGE_PAIR_Y);
    expect(tile.value).toBe(MERGE_PAIR_VALUE);
  });

  it('retains an explicit value (js/tile.js L4)', () => {
    expect(new Tile(originCell(), TILE_VALUE).value).toBe(TILE_VALUE);
    expect(new Tile(originCell(), MERGED_VALUE).value).toBe(MERGED_VALUE);
  });

  it('coerces a falsy 0 value to 2 (js/tile.js L4)', () => {
    const tile = new Tile(originCell(), 0);

    expect(tile.value).toBe(DEFAULT_VALUE);
  });

  it('coerces a NaN value to 2 (js/tile.js L4)', () => {
    const tile = new Tile(originCell(), Number.NaN);

    expect(tile.value).toBe(DEFAULT_VALUE);
  });

  it('coerces an omitted value to 2 (js/tile.js L4)', () => {
    const tile = new Tile(originCell());

    expect(tile.value).toBe(DEFAULT_VALUE);
  });

  it('coerces an explicit undefined value to 2 (js/tile.js L4)', () => {
    const tile = new Tile(originCell(), undefined);

    expect(tile.value).toBe(DEFAULT_VALUE);
  });

  it('initialises previousPosition to null (js/tile.js L6)', () => {
    const tile = new Tile(originCell(), TILE_VALUE);

    expect(tile.previousPosition).toBeNull();
    expect(tile.previousPosition).not.toBeUndefined();
    expect(Object.is(tile.previousPosition, null)).toBe(true);
  });

  it('initialises mergedFrom to null (js/tile.js L7)', () => {
    const tile = new Tile(originCell(), TILE_VALUE);

    expect(tile.mergedFrom).toBeNull();
    expect(tile.mergedFrom).not.toBeUndefined();
    expect(Object.is(tile.mergedFrom, null)).toBe(true);
  });
});

describe('Tile.savePosition (js/tile.js L10-L12)', () => {
  it('snapshots the current x and y (js/tile.js L10-L12)', () => {
    const tile = new Tile(originCell(), TILE_VALUE);

    tile.savePosition();

    expect(savedCellOf(tile)).toEqual({ x: ORIGIN_X, y: ORIGIN_Y });
    expect(Object.keys(savedCellOf(tile)).sort()).toEqual(['x', 'y']);
  });

  it('writes a fresh object, not the tile (js/tile.js L11)', () => {
    const tile = new Tile(originCell(), TILE_VALUE);

    tile.savePosition();

    expect(tile.previousPosition).not.toBe(tile);
    expect(savedCellOf(tile)).not.toBe(tile);
  });

  it('writes a fresh object, not the argument (js/tile.js L11)', () => {
    const cell = originCell();
    const tile = new Tile(cell, TILE_VALUE);

    tile.savePosition();

    expect(tile.previousPosition).not.toBe(cell);
    expect(tile.previousPosition).toEqual(cell);
  });

  it('survives a later x and y mutation (js/tile.js L11)', () => {
    const tile = new Tile(originCell(), TILE_VALUE);

    tile.savePosition();

    tile.x = TARGET_X;
    tile.y = TARGET_Y;

    expect(savedCellOf(tile)).toEqual({ x: ORIGIN_X, y: ORIGIN_Y });
  });

  it('survives a later updatePosition (js/tile.js L11)', () => {
    const tile = new Tile(originCell(), TILE_VALUE);

    tile.savePosition();
    tile.updatePosition(targetCell());

    expect(savedCellOf(tile)).toEqual({ x: ORIGIN_X, y: ORIGIN_Y });
  });

  it('writes a fresh object on every call (js/tile.js L10-L12)', () => {
    const tile = new Tile(originCell(), TILE_VALUE);

    tile.savePosition();

    const first = savedCellOf(tile);

    tile.updatePosition(targetCell());
    tile.savePosition();

    const second = savedCellOf(tile);

    expect(second).not.toBe(first);
    expect(first).toEqual({ x: ORIGIN_X, y: ORIGIN_Y });
    expect(second).toEqual({ x: TARGET_X, y: TARGET_Y });
  });
});

describe('Tile.updatePosition (js/tile.js L14-L17)', () => {
  it('writes the new x and y (js/tile.js L15-L16)', () => {
    const tile = new Tile(originCell(), TILE_VALUE);

    tile.updatePosition(targetCell());

    expect(tile.x).toBe(TARGET_X);
    expect(tile.y).toBe(TARGET_Y);
  });

  it('leaves a saved previousPosition intact (js/tile.js L14-L17)', () => {
    const tile = new Tile(originCell(), TILE_VALUE);

    tile.savePosition();
    tile.updatePosition(targetCell());

    expect(tile.x).toBe(TARGET_X);
    expect(tile.y).toBe(TARGET_Y);
    expect(savedCellOf(tile)).toEqual({ x: ORIGIN_X, y: ORIGIN_Y });
  });

  it('does not mutate the caller argument (js/tile.js L14-L17)', () => {
    const tile = new Tile(originCell(), TILE_VALUE);
    const cell = targetCell();

    tile.updatePosition(cell);

    expect(cell).toEqual({ x: TARGET_X, y: TARGET_Y });
    expect(Object.keys(cell).sort()).toEqual(['x', 'y']);
    expect(tile.previousPosition).not.toBe(cell);
  });

  it('accepts a frozen position argument (js/tile.js L14-L17)', () => {
    const tile = new Tile(originCell(), TILE_VALUE);
    const frozen = Object.freeze({ x: TARGET_X, y: TARGET_Y });

    tile.updatePosition(frozen);

    expect(tile.x).toBe(TARGET_X);
    expect(tile.y).toBe(TARGET_Y);
  });

  it('leaves previousPosition null when unsaved (js/tile.js L14-L17)', () => {
    const tile = new Tile(originCell(), TILE_VALUE);

    tile.updatePosition(targetCell());

    expect(tile.previousPosition).toBeNull();
  });

  it('touches neither value nor mergedFrom (js/tile.js L14-L17)', () => {
    const left = new Tile(originCell(), TILE_VALUE);
    const right = new Tile(targetCell(), TILE_VALUE);
    const merged = new Tile(originCell(), MERGED_VALUE);

    merged.mergedFrom = [left, right];
    merged.updatePosition(targetCell());

    expect(merged.value).toBe(MERGED_VALUE);
    expect(sourcesOf(merged)[0]).toBe(left);
    expect(sourcesOf(merged)[1]).toBe(right);
  });
});

describe('Tile.serialize (js/tile.js L19-L27)', () => {
  it('returns exactly position and value keys (js/tile.js L20-L26)', () => {
    const tile = new Tile(originCell(), TILE_VALUE);

    expect(Object.keys(tile.serialize()).sort()).toEqual([
      'position',
      'value',
    ]);
  });

  it('re-nests x and y under position (js/tile.js L21-L24)', () => {
    const tile = new Tile(originCell(), TILE_VALUE);
    const serialized = tile.serialize();

    expect(serialized).toEqual({
      position: { x: ORIGIN_X, y: ORIGIN_Y },
      value: TILE_VALUE,
    });
    expect(Object.keys(serialized.position).sort()).toEqual(['x', 'y']);
  });

  it('excludes previousPosition and mergedFrom (js/tile.js L19-L27)', () => {
    const left = new Tile(originCell(), TILE_VALUE);
    const right = new Tile(targetCell(), TILE_VALUE);
    const tile = new Tile(originCell(), MERGED_VALUE);

    tile.savePosition();
    tile.mergedFrom = [left, right];

    const serialized = tile.serialize();

    expect(tile.previousPosition).not.toBeNull();
    expect(tile.mergedFrom).not.toBeNull();
    expect('previousPosition' in serialized).toBe(false);
    expect('mergedFrom' in serialized).toBe(false);
    expect(Object.keys(serialized).sort()).toEqual(['position', 'value']);
  });

  it('returns a fresh object on every call (js/tile.js L19-L27)', () => {
    const tile = new Tile(originCell(), TILE_VALUE);
    const first = tile.serialize();
    const second = tile.serialize();

    expect(second).not.toBe(first);
    expect(second.position).not.toBe(first.position);
    expect(second).toEqual(first);
  });

  it('does not alias the tile or its saved cell (js/tile.js L19-L27)', () => {
    const tile = new Tile(originCell(), TILE_VALUE);

    tile.savePosition();

    const serialized = tile.serialize();

    expect(serialized.position).not.toBe(tile);
    expect(serialized.position).not.toBe(tile.previousPosition);

    serialized.position.x = TARGET_X;
    serialized.value = MERGED_VALUE;

    expect(tile.x).toBe(ORIGIN_X);
    expect(tile.value).toBe(TILE_VALUE);
    expect(savedCellOf(tile).x).toBe(ORIGIN_X);
  });

  it('reports the current cell, not the saved one (js/tile.js L22-L23)', () => {
    const tile = new Tile(originCell(), TILE_VALUE);

    tile.savePosition();
    tile.updatePosition(targetCell());

    expect(tile.serialize().position).toEqual({
      x: TARGET_X,
      y: TARGET_Y,
    });
    expect(savedCellOf(tile)).toEqual({ x: ORIGIN_X, y: ORIGIN_Y });
  });

  it('carries the coerced default value (js/tile.js L4, L25)', () => {
    expect(new Tile(originCell(), 0).serialize().value).toBe(DEFAULT_VALUE);
    expect(new Tile(originCell()).serialize().value).toBe(DEFAULT_VALUE);
  });
});

describe('Tile serialize round trip (js/grid.js L29)', () => {
  it('accepts its own output as construction input (js/grid.js L29)', () => {
    const tile = new Tile(originCell(), TILE_VALUE);

    tile.savePosition();
    tile.updatePosition(targetCell());

    const serialized = tile.serialize();
    const rehydrated = new Tile(serialized.position, serialized.value);

    expect(rehydrated.x).toBe(TARGET_X);
    expect(rehydrated.y).toBe(TARGET_Y);
    expect(rehydrated.value).toBe(TILE_VALUE);
    expect(rehydrated.previousPosition).toBeNull();
    expect(rehydrated.mergedFrom).toBeNull();
    expect(rehydrated.serialize()).toEqual(serialized);
  });

  it('rehydrates a fixture tile with state null (js/grid.js L29)', () => {
    const board = createMergePairBoard();
    const source = fixtureTileAt(board, MERGE_PAIR_X, MERGE_PAIR_Y);
    const rehydrated = new Tile(source.position, source.value);

    expect(rehydrated.x).toBe(MERGE_PAIR_X);
    expect(rehydrated.y).toBe(MERGE_PAIR_Y);
    expect(rehydrated.value).toBe(MERGE_PAIR_VALUE);
    expect(rehydrated.previousPosition).toBeNull();
    expect(rehydrated.mergedFrom).toBeNull();
    expect(rehydrated.serialize()).toEqual(source);
  });

  it('round-trips every merge-pair fixture tile (js/grid.js L29)', () => {
    const board = createMergePairBoard();
    const sources = [
      fixtureTileAt(board, MERGE_PAIR_X, MERGE_PAIR_Y),
      fixtureTileAt(board, MERGE_PAIR_NEXT_X, MERGE_PAIR_Y),
    ];

    for (const source of sources) {
      const rehydrated = new Tile(source.position, source.value);

      expect(rehydrated.serialize()).toEqual(source);
      expect(rehydrated.serialize().position).not.toBe(source.position);
    }
  });
});

describe('Tile.mergedFrom (js/tile.js L7)', () => {
  it('holds exactly two source tiles (js/game_manager.js L158)', () => {
    const left = new Tile(originCell(), TILE_VALUE);
    const right = new Tile(targetCell(), TILE_VALUE);
    const merged = new Tile(targetCell(), MERGED_VALUE);

    merged.mergedFrom = [left, right];

    expect(sourcesOf(merged)).toHaveLength(MERGE_SOURCE_COUNT);
    expect(sourcesOf(merged)[0]).toBe(left);
    expect(sourcesOf(merged)[1]).toBe(right);
  });

  it('holds live references to both sources (js/tile.js L7)', () => {
    const left = new Tile(originCell(), TILE_VALUE);
    const right = new Tile(targetCell(), TILE_VALUE);
    const merged = new Tile(targetCell(), MERGED_VALUE);

    merged.mergedFrom = [left, right];

    left.savePosition();
    left.updatePosition(targetCell());

    expect(sourcesOf(merged)[0]).toBe(left);
    expect(sourcesOf(merged)[0].x).toBe(TARGET_X);
    expect(sourcesOf(merged)[0].previousPosition).toEqual({
      x: ORIGIN_X,
      y: ORIGIN_Y,
    });
  });

  it('holds both sources until explicitly cleared (js/tile.js L7)', () => {
    const left = new Tile(originCell(), TILE_VALUE);
    const right = new Tile(targetCell(), TILE_VALUE);
    const merged = new Tile(targetCell(), MERGED_VALUE);

    merged.mergedFrom = [left, right];

    merged.savePosition();
    merged.updatePosition(originCell());

    expect(sourcesOf(merged)).toEqual([left, right]);

    merged.mergedFrom = null;

    expect(merged.mergedFrom).toBeNull();
  });
});

describe('Tile as MergeTileView (js/game_manager.js L156)', () => {
  it('satisfies MergeTileView with no adapter (js/tile.js L4, L7)', () => {
    const tile = new Tile(originCell(), TILE_VALUE);
    const view: MergeTileView = tile;

    expect(view.value).toBe(TILE_VALUE);
    expect(view.mergedFrom).toBeNull();
  });

  it('presents mergedFrom as absent when unmerged (js/tile.js L7)', () => {
    const moving = new Tile(originCell(), TILE_VALUE);
    const target = new Tile(targetCell(), TILE_VALUE);
    const movingView: MergeTileView = moving;
    const targetView: MergeTileView = target;

    expect(movingView.value === targetView.value).toBe(true);
    expect(Boolean(targetView.mergedFrom)).toBe(false);
  });

  it('presents mergedFrom as present when merged (js/tile.js L7)', () => {
    const left = new Tile(originCell(), TILE_VALUE);
    const right = new Tile(targetCell(), TILE_VALUE);
    const merged = new Tile(targetCell(), MERGED_VALUE);

    merged.mergedFrom = [left, right];

    const view: MergeTileView = merged;

    expect(Boolean(view.mergedFrom)).toBe(true);
    expect(view.mergedFrom).toHaveLength(MERGE_SOURCE_COUNT);
    expect(view.value).toBe(MERGED_VALUE);
  });
});
