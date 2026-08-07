// Persisted-snapshot bounds suite of src/engine/engine.ts.
//
// The legacy `gameState` entry is attacker-controllable in the only sense that
// matters for a client-only game: anything with access to the origin's Web
// Storage can write it, and every later page load reads it. Two properties of
// that read are pinned here.
//
// SIZE. `grid.size` drives a `size` by `size` allocation in `Grid` and both
// loops of every traversal. Accepting any positive safe integer meant a stored
// `2 ** 40` froze startup on every load until the entry was cleared by hand.
// `isSupportedBoardSize` of src/config/default-config.ts is the product-wide
// ceiling and is now applied BEFORE any grid is built.
//
// TILE COORDINATES. `Grid.fromState` places a tile at the matrix coordinate it
// was found at while building it from the RECORDED position, so a snapshot whose
// two disagree produced a tile that believed it was elsewhere; the first move
// then indexed `grid.cells[tile.x]` outside the lattice and threw. Every
// restored tile now carries the coordinate of the cell holding it.
//
// This suite reads no DOM and no storage; the storage port is a hand-written
// double. It runs in the `unit:dom-free` project of vitest.config.ts.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BOARD_SIZE,
  MAX_BOARD_SIZE,
  createDefaultRulesConfig,
} from '../../../src/config/default-config';
import { Engine } from '../../../src/engine/engine';
import type { EngineStoragePort } from '../../../src/engine/engine';
import type {
  EngineCountReport,
  EngineReporter,
} from '../../../src/engine/types';
import { DIRECTION_LEFT, DIRECTION_UP } from '../../../src/engine/types';
import { createRngStreams } from '../../../src/rng/rng-streams';

const RUN_SEED = 'snapshot-bounds-suite';

interface Harness {
  readonly engine: Engine;
  readonly counts: EngineCountReport[];
}

/** Builds an engine over a stored value of any shape at all. */
function createHarness(stored: unknown): Harness {
  const counts: EngineCountReport[] = [];
  const reporter: EngineReporter = {
    onCount: (report): void => {
      counts.push(report);
    },
  };
  const port: EngineStoragePort = {
    getBestScore: (): string | 0 => 0,
    setBestScore: (): unknown => undefined,
    getGameState: (): unknown => stored,
    setGameState: (): unknown => undefined,
    clearGameState: (): unknown => undefined,
  };

  return {
    counts,
    engine: new Engine({
      config: createDefaultRulesConfig(),
      streams: createRngStreams(RUN_SEED),
      storage: port,
      correlationId: 'run-snapshot-bounds',
      reporter,
    }),
  };
}

/** An otherwise valid snapshot carrying one column of one tile. */
function createStored(size: unknown, cell: unknown): Record<string, unknown> {
  return {
    grid: { size, cells: [[cell]] },
    score: 10,
    over: false,
    won: false,
    keepPlaying: false,
  };
}

function rejectedCount(counts: readonly EngineCountReport[]): number {
  return counts.filter(
    (report) => report.metric === 'engine.snapshot.rejected',
  ).length;
}

function restoredCount(counts: readonly EngineCountReport[]): number {
  return counts.filter(
    (report) => report.metric === 'engine.snapshot.restored',
  ).length;
}

describe('a persisted board size above the product ceiling is refused', () => {
  it('refuses a size beyond MAX_BOARD_SIZE and starts fresh', () => {
    const { engine, counts } = createHarness(
      createStored(MAX_BOARD_SIZE + 1, null),
    );

    engine.setup();

    expect(engine.grid.size).toBe(DEFAULT_BOARD_SIZE);
    expect(rejectedCount(counts)).toBe(1);
    expect(restoredCount(counts)).toBe(0);

    // A fresh board is dealt the configured number of start tiles, which a
    // restored board is not, so this is also the proof that the restore path
    // was not taken.
    expect(engine.grid.availableCells()).toHaveLength(
      DEFAULT_BOARD_SIZE * DEFAULT_BOARD_SIZE - 2,
    );
  });

  it('refuses the size that used to freeze startup, quickly', () => {
    const { engine } = createHarness(createStored(2 ** 40, null));
    const startedAt = Date.now();

    engine.setup();

    // Constructing 2**40 columns would not return at all; the assertion is
    // that the load is refused, and the elapsed bound states why it matters.
    expect(engine.grid.size).toBe(DEFAULT_BOARD_SIZE);
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it('accepts the ceiling itself', () => {
    const { engine, counts } = createHarness(
      createStored(MAX_BOARD_SIZE, null),
    );

    engine.setup();

    expect(engine.grid.size).toBe(MAX_BOARD_SIZE);
    expect(restoredCount(counts)).toBe(1);
  });

  it.each([
    ['zero', 0],
    ['negative', -4],
    ['fractional', 4.5],
    ['not a number', '4'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('refuses a size that is %s', (_label, size) => {
    const { engine, counts } = createHarness(createStored(size, null));

    engine.setup();

    expect(engine.grid.size).toBe(DEFAULT_BOARD_SIZE);
    expect(rejectedCount(counts)).toBe(1);
  });
});

describe('a persisted tile is restored into the cell that holds it', () => {
  it('normalises a position that disagrees with its cell', () => {
    // The tile sits at cells[0][0] but claims to be at (9, 9), which is outside
    // a four-cell lattice entirely.
    const { engine } = createHarness(
      createStored(DEFAULT_BOARD_SIZE, {
        position: { x: 9, y: 9 },
        value: 2,
      }),
    );

    engine.setup();

    const tile = engine.grid.cellContent({ x: 0, y: 0 });

    expect(tile).not.toBeNull();
    expect(tile?.x).toBe(0);
    expect(tile?.y).toBe(0);
    expect(tile?.value).toBe(2);

    // The move used to throw here: `grid.cells[9]` is undefined, so writing
    // `grid.cells[tile.x][tile.y] = null` dereferenced it.
    expect(() => {
      engine.move(DIRECTION_UP);
    }).not.toThrow();
  });

  it.each([
    ['a non-finite coordinate', { position: { x: Number.NaN, y: 0 }, value: 2 }],
    ['a fractional coordinate', { position: { x: 0.5, y: 0 }, value: 2 }],
    ['a negative coordinate', { position: { x: -1, y: 0 }, value: 2 }],
    ['a missing position', { value: 2 }],
    ['a string position', { position: 'somewhere', value: 2 }],
  ])('survives %s and still resolves a move', (_label, cell) => {
    const { engine } = createHarness(createStored(DEFAULT_BOARD_SIZE, cell));

    engine.setup();

    // The recorded position is not consulted at all, so the tile is restored
    // into the cell it was found at whatever the position said.
    const tile = engine.grid.cellContent({ x: 0, y: 0 });

    expect(tile?.x).toBe(0);
    expect(tile?.y).toBe(0);
    expect(() => {
      engine.move(DIRECTION_LEFT);
    }).not.toThrow();
  });

  it.each([
    ['zero', 0],
    ['negative', -8],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a string', '4'],
  ])('drops a tile whose value is %s rather than coercing it', (_label, value) => {
    const { engine } = createHarness(
      createStored(DEFAULT_BOARD_SIZE, { position: { x: 0, y: 0 }, value }),
    );

    engine.setup();

    // `Tile` coerces a falsy value to 2, which would have turned a corrupted
    // entry into a playable tile of a value the snapshot never held.
    expect(engine.grid.cellContent({ x: 0, y: 0 })).toBeNull();
    expect(engine.grid.availableCells()).toHaveLength(
      DEFAULT_BOARD_SIZE * DEFAULT_BOARD_SIZE,
    );
  });

  it('ignores stored cells outside the declared board size', () => {
    const oversized: (unknown[])[] = [];

    for (let x = 0; x < 8; x += 1) {
      const column: unknown[] = [];

      for (let y = 0; y < 8; y += 1) {
        column.push({ position: { x, y }, value: 2 });
      }

      oversized.push(column);
    }

    const { engine } = createHarness({
      grid: { size: 4, cells: oversized },
      score: 0,
      over: false,
      won: false,
      keepPlaying: false,
    });

    engine.setup();

    // Sixteen cells, all occupied; nothing from the 8x8 region beyond them.
    expect(engine.grid.size).toBe(4);
    expect(engine.grid.availableCells()).toHaveLength(0);
    expect(engine.grid.cellContent({ x: 3, y: 3 })?.value).toBe(2);
  });

  it('tolerates a matrix shorter than the size it declares', () => {
    // One column of one cell, against a declared edge length of four: the
    // missing columns and rows read as empty rather than failing the load.
    const { engine } = createHarness({
      grid: { size: 4, cells: [[{ position: { x: 0, y: 0 }, value: 4 }], []] },
      score: 0,
      over: false,
      won: false,
      keepPlaying: false,
    });

    engine.setup();

    expect(engine.grid.size).toBe(4);
    expect(engine.grid.cellContent({ x: 0, y: 0 })?.value).toBe(4);
    expect(engine.grid.availableCells()).toHaveLength(15);
  });

  it('refuses a matrix whose column is not an array at all', () => {
    const { engine, counts } = createHarness({
      grid: { size: 4, cells: [[{ position: { x: 0, y: 0 }, value: 4 }], null] },
      score: 0,
      over: false,
      won: false,
      keepPlaying: false,
    });

    engine.setup();

    // A value that is not a matrix is not a partially corrupted matrix, so the
    // whole snapshot is discarded and the run starts fresh.
    expect(rejectedCount(counts)).toBe(1);
    expect(engine.grid.availableCells()).toHaveLength(
      DEFAULT_BOARD_SIZE * DEFAULT_BOARD_SIZE - 2,
    );
  });
});

describe('an unsupported configured board size never reaches an allocation', () => {
  it('falls back to the default edge length', () => {
    const config = createDefaultRulesConfig();

    // The write a board-mutating relic makes, at a value the product refuses.
    config.boardSize = MAX_BOARD_SIZE + 100;

    const engine = new Engine({
      config,
      streams: createRngStreams(RUN_SEED),
      storage: {
        getBestScore: (): string | 0 => 0,
        setBestScore: (): unknown => undefined,
        getGameState: (): unknown => null,
        setGameState: (): unknown => undefined,
        clearGameState: (): unknown => undefined,
      },
      correlationId: 'run-config-bounds',
    });

    engine.setup();

    expect(engine.grid.size).toBe(DEFAULT_BOARD_SIZE);
    expect(config.boardSize).toBe(DEFAULT_BOARD_SIZE);
  });
});
