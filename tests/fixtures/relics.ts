// The two harnesses every suite under tests/unit/relics/ drives a relic
// through.
//
// This module reads no DOM and no storage, performs no I/O, reads no clock,
// writes no log and takes no unseeded randomness: every draw comes from a
// substream derived from a seed the caller names.

import { expect } from 'vitest';

import {
  DEFAULT_BOARD_SIZE,
  createDefaultRulesConfig,
} from '../../src/config/default-config';
import type { RulesConfig } from '../../src/config/rules-config';
import { Grid } from '../../src/engine/grid';
import { createHookBus } from '../../src/engine/hook-bus';
import type { HookBus, HookDispatchResult } from '../../src/engine/hook-bus';
import type {
  HookDispatchPayloadMap,
  HookEnvironment,
  HookName,
  HookPayloadMap,
} from '../../src/engine/hooks';
import { Tile } from '../../src/engine/tile';
import { DIRECTION_LEFT } from '../../src/engine/types';
import type { Position } from '../../src/engine/types';
import { findRelicById } from '../../src/relics/relic-registry';
import type { Relic } from '../../src/relics/relic-types';
import { createRngStreams } from '../../src/rng/rng-streams';
import type { RngStreams } from '../../src/rng/rng-streams';

/** Seed every harness environment derives its substreams from by default. */
export const HARNESS_SEED = 'blitzy-relic-harness';

/**
 * One board laid out as text, row by row: the value in each cell, or `null`
 * for an empty one. `layout[y][x]` — ROW MAJOR, so a literal in a suite reads
 * the way the board looks — while the lattice it builds is the x-major
 * `cells[x][y]` store the engine owns.
 */
export type BoardLayout = readonly (readonly (number | null)[])[];

/**
 * What a harness hands a suite: the collaborators plus the bus driving them.
 */
export interface RelicHarness extends HookEnvironment {
  /** The live rules the dispatch reads, and that a relic may write. */
  readonly config: RulesConfig;

  /** The live lattice the dispatch reads, and that a relic may write. */
  readonly grid: Grid;

  /** The run's named substreams. */
  readonly rng: RngStreams;

  /** The bus the relics are registered with. */
  readonly bus: HookBus;

  /**
   * Dispatches one hook and returns the bus's result, exactly as the engine
   * receives it.
   */
  dispatch<K extends HookName>(
    hook: K,
    payload: HookDispatchPayloadMap[K],
  ): HookDispatchResult<K>;

  /** The state slot the bus holds for one registered relic. */
  stateOf(relicId: string): unknown;

  /** The charge budget the bus holds for one registered relic. */
  chargesOf(relicId: string): number | undefined;

  /** The board as a row-major layout, for comparison against a literal. */
  layout(): (number | null)[][];

  /** Face values on the board, ascending, with empty cells left out. */
  values(): number[];

  /** Cells holding a tile, x-outer and y-inner. */
  occupied(): Position[];
}

/** Options a harness is built with. Every member has a working default. */
export interface RelicHarnessOptions {
  /** Relics to register, in the pickup order they are listed in. */
  readonly relics?: readonly Relic[];

  /** Board to start from. An absent layout builds an empty board. */
  readonly layout?: BoardLayout;

  /** Edge length. Defaults to the layout's own length, then to the rules'. */
  readonly boardSize?: number;

  /** Run seed the substreams derive from. */
  readonly seed?: string;

  /** Rules to run under. Defaults to a fresh mutable default config. */
  readonly config?: RulesConfig;
}

/**
 * Builds a mutable rules object carrying the vanilla-equivalent defaults.
 *
 * @param boardSize Edge length to declare, where it differs from the
 *   default.
 * @returns A fresh, writable rules object.
 */
export function createHarnessConfig(boardSize?: number): RulesConfig {
  const config = createDefaultRulesConfig();

  if (boardSize !== undefined) {
    config.boardSize = boardSize;
  }

  return config;
}

/**
 * Builds a lattice from a row-major layout.
 *
 * @param layout Values by row, `layout[y][x]`.
 * @param size Edge length. Defaults to the number of rows.
 * @returns A live grid holding one tile per stated value.
 */
export function createGridFromLayout(
  layout: BoardLayout,
  size = layout.length,
): Grid {
  const grid = new Grid(size);

  for (let y = 0; y < layout.length; y += 1) {
    const row = layout[y] ?? [];

    for (let x = 0; x < row.length; x += 1) {
      const value = row[x];

      if (value !== null && value !== undefined) {
        grid.insertTile(new Tile({ x, y }, value));
      }
    }
  }

  return grid;
}

/**
 * Reads a lattice back out as a row-major layout.
 *
 * @param grid Board to read.
 * @returns `layout[y][x]`, with `null` for an empty cell.
 */
export function readLayout(grid: Grid): (number | null)[][] {
  const rows: (number | null)[][] = [];

  for (let y = 0; y < grid.size; y += 1) {
    const row: (number | null)[] = [];

    for (let x = 0; x < grid.size; x += 1) {
      row.push(grid.cellContent({ x, y })?.value ?? null);
    }

    rows.push(row);
  }

  return rows;
}

/**
 * Face values a lattice holds, ascending.
 *
 * @param grid Board to read.
 * @returns The occupied values, sorted low to high.
 */
export function readValues(grid: Grid): number[] {
  const values: number[] = [];

  grid.eachCell((_x, _y, tile) => {
    if (tile !== null) {
      values.push(tile.value);
    }
  });

  return values.sort((left, right) => left - right);
}

/**
 * Cells a lattice holds a tile in, x-outer and y-inner.
 *
 * @param grid Board to read.
 * @returns A fresh array of fresh coordinates.
 */
export function readOccupied(grid: Grid): Position[] {
  const cells: Position[] = [];

  grid.eachCell((x, y, tile) => {
    if (tile !== null) {
      cells.push({ x, y });
    }
  });

  return cells;
}

/**
 * Builds a harness: live rules, a live lattice, seeded substreams, a bus, and
 * the named relics registered in pickup order.
 *
 * @param options What to build. Every member has a default.
 * @returns The harness.
 */
export function createRelicHarness(
  options: RelicHarnessOptions = {},
): RelicHarness {
  const layout = options.layout;
  const size =
    options.boardSize ??
    (layout !== undefined ? layout.length : undefined) ??
    options.config?.boardSize;
  const config = options.config ?? createHarnessConfig(size);

  if (size !== undefined) {
    config.boardSize = size;
  }

  const grid =
    layout === undefined
      ? new Grid(config.boardSize)
      : createGridFromLayout(layout, config.boardSize);
  const rng = createRngStreams(options.seed ?? HARNESS_SEED);
  const bus = createHookBus();

  for (const relic of options.relics ?? []) {
    bus.register({
      id: relic.id,
      hooks: relic.hooks,
      charges: relic.charges,
      state: relic.state,
    });
  }

  const environment: HookEnvironment = { config, rng, grid };

  return {
    config,
    grid,
    rng,
    bus,

    dispatch: <K extends HookName>(
      hook: K,
      payload: HookDispatchPayloadMap[K],
    ): HookDispatchResult<K> => bus.dispatch(hook, payload, environment),

    stateOf: (relicId: string): unknown =>
      bus.subscribers().find((entry) => entry.id === relicId)?.state,

    chargesOf: (relicId: string): number | undefined =>
      bus.subscribers().find((entry) => entry.id === relicId)?.charges,

    layout: (): (number | null)[][] => readLayout(grid),
    values: (): number[] => readValues(grid),
    occupied: (): Position[] => readOccupied(grid),
  };
}

/**
 * Builds a tile.
 *
 * @param x Column.
 * @param y Row.
 * @param value Face value.
 * @returns A fresh tile at that cell.
 */
export function tileAt(x: number, y: number, value: number): Tile {
  return new Tile({ x, y }, value);
}



/** The one seed every bench built here is drawn from. */
export const RELIC_BENCH_SEED = 'relic-family-suite';

/** The correlation identifier the bench's bus reports under. */
export const RELIC_BENCH_CORRELATION = 'run-relic-family';

export interface RelicBench {
  readonly grid: Grid;
  readonly config: RulesConfig;
  readonly streams: RngStreams;
  readonly bus: HookBus;
  readonly environment: HookEnvironment;
}

/** How one relic is seated on a bench. */
export interface RelicSeat {
  readonly id: string;

  /**
   * Charge budget to register with, overriding the definition's own. `0` is
   * the exhausted budget the zero-charge cases drive.
   */
  readonly charges?: number;
}

export interface RelicBenchOptions {
  readonly size?: number;
  readonly seed?: string;
}

/**
 * Resolves one relic out of the shipped catalogue, failing the case when the
 * catalogue does not carry it.
 *
 * @param id Identifier to resolve.
 * @returns The catalogue's own definition.
 */
export function relicById(id: string): Relic {
  const found = findRelicById(id);

  expect(found, `relic ${id} is in the catalogue`).toBeDefined();

  return found as Relic;
}

/**
 * Builds a bench seating the named relics, in the order given.
 *
 * @param seats Relics to seat, by identifier or with a charge override.
 * @param options Board size and seed, each defaulted.
 * @returns The assembled bench.
 */
export function relicBench(
  seats: readonly (string | RelicSeat)[],
  options: RelicBenchOptions = {},
): RelicBench {
  const size = options.size ?? DEFAULT_BOARD_SIZE;
  const grid = new Grid(size);
  const config = createDefaultRulesConfig();

  config.boardSize = size;

  const streams = createRngStreams(options.seed ?? RELIC_BENCH_SEED);
  const bus = createHookBus({ correlationId: RELIC_BENCH_CORRELATION });

  for (const seat of seats) {
    const requested = typeof seat === 'string' ? { id: seat } : seat;
    const definition = relicById(requested.id);

    expect(
      bus.register({
        id: definition.id,
        hooks: definition.hooks,
        charges: requested.charges ?? definition.charges,
        state: definition.state,
      }),
      `relic ${requested.id} registers`,
    ).toBe(true);
  }

  return {
    grid,
    config,
    streams,
    bus,
    environment: { config, rng: streams, grid },
  };
}

/**
 * Dispatches one hook against a bench and hands back the resolved payload.
 *
 * @param target Bench to dispatch on.
 * @param hook Hook to dispatch.
 * @param payload Payload to dispatch with.
 * @returns The payload the dispatch resolved to.
 */
export function dispatchOn<K extends HookName>(
  target: RelicBench,
  hook: K,
  payload: HookDispatchPayloadMap[K],
): HookPayloadMap[K] {
  return target.bus.dispatch(hook, payload, target.environment).payload;
}

/**
 * Dispatches one hook and hands back the whole result, for a case asserting on
 * how many handlers were invoked, skipped or refused.
 *
 * @param target Bench to dispatch on.
 * @param hook Hook to dispatch.
 * @param payload Payload to dispatch with.
 * @returns The dispatch result.
 */
export function resultOn<K extends HookName>(
  target: RelicBench,
  hook: K,
  payload: HookDispatchPayloadMap[K],
): HookDispatchResult<K> {
  return target.bus.dispatch(hook, payload, target.environment);
}

/**
 * The state slot one seated relic holds, live.
 *
 * @param target Bench to read.
 * @param id Relic whose slot is read.
 * @returns The slot as the bus holds it.
 */
export function stateOf(target: RelicBench, id: string): unknown {
  return target.bus.subscribers().find((subscriber) => subscriber.id === id)
    ?.state;
}

/**
 * The cursor of one substream on a bench.
 *
 * @param target Bench to read.
 * @param stream Substream name.
 * @returns Draws taken from it so far.
 */
export function cursorOf(target: RelicBench, stream: string): number {
  const snapshot: Record<string, number> = {
    ...target.streams.snapshotCursors(),
  };

  return snapshot[stream];
}

/**
 * Places one tile.
 *
 * @param grid Board to place on.
 * @param x Column.
 * @param y Row.
 * @param value Tile value.
 */
export function place(
  grid: Grid,
  x: number,
  y: number,
  value: number,
): void {
  grid.insertTile(new Tile({ x, y }, value));
}

/**
 * Fills every cell of a board.
 *
 * @param grid Board to fill.
 * @param value Value every cell takes.
 */
export function fill(grid: Grid, value = 2): void {
  for (let x = 0; x < grid.size; x += 1) {
    for (let y = 0; y < grid.size; y += 1) {
      place(grid, x, y, value);
    }
  }
}

/**
 * Every occupant of a board, in the grid's own scan order.
 *
 * @param grid Board to read.
 * @returns One entry per occupied cell.
 */
export function occupants(
  grid: Grid,
): { x: number; y: number; value: number }[] {
  const found: { x: number; y: number; value: number }[] = [];

  grid.eachCell((_x, _y, tile): void => {
    if (tile !== null) {
      found.push({ x: tile.x, y: tile.y, value: tile.value });
    }
  });

  return found;
}

/**
 * The value multiset of a board, ascending.
 *
 * @param grid Board to read.
 * @returns The sorted values.
 */
export function values(grid: Grid): number[] {
  return occupants(grid)
    .map((cell) => cell.value)
    .sort((left, right) => left - right);
}

/**
 * Asserts the lattice is internally consistent: square, holding only tiles or
 * `null`, every occupant's own coordinates matching its slot, and off-lattice
 * reads still refused.
 *
 * This is the corruption mode the grid-mutation discipline exists to prevent,
 * so every board assertion in the relic suites runs it.
 *
 * @param grid Board to check.
 */
export function expectConsistentLattice(grid: Grid): void {
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
}

/**
 * A spawn dispatch payload. An absent cell is the spawn that inserted nothing.
 *
 * @param position Cell the spawn resolved into, or `undefined`.
 * @param value Tile value.
 * @returns The payload.
 */
export function spawnPayload(
  position: Position | undefined,
  value: number,
): HookDispatchPayloadMap['onSpawn'] {
  return position === undefined ? { value } : { position, value };
}

/**
 * A before-move dispatch payload, leftwards and uncancelled.
 *
 * @param grid Board the move is resolving against.
 * @returns The payload.
 */
export function beforeMovePayload(
  grid: Grid,
): HookDispatchPayloadMap['onBeforeMove'] {
  return { direction: DIRECTION_LEFT, board: grid, cancelled: false };
}

/**
 * An after-move dispatch payload for a move that changed the board.
 *
 * @param grid Board as the move left it.
 * @param score Score after the move.
 * @returns The payload.
 */
export function afterMovePayload(
  grid: Grid,
  score = 0,
): HookDispatchPayloadMap['onAfterMove'] {
  return {
    moved: true,
    board: grid,
    score,
    over: false,
    won: false,
    terminated: false,
  };
}

/**
 * A stage-start dispatch payload.
 *
 * @param boardSize Edge length the stage opens at.
 * @param stageIndex Stage the run is on.
 * @returns The payload.
 */
export function stageStartPayload(
  boardSize: number,
  stageIndex = 0,
): HookDispatchPayloadMap['onStageStart'] {
  return {
    stageIndex,
    goal: { kind: 'highest-tile', target: 128 },
    seed: RELIC_BENCH_SEED,
    boardSize,
  };
}

/**
 * A merge dispatch payload over real tiles, which is what
 * src/engine/move-resolver.ts dispatches: the bus projects each of them into
 * the frozen view a handler reads.
 *
 * @param source Cell the absorbed tile came from.
 * @param target Cell the merge lands on.
 * @param sourceValue Value of the absorbed tile.
 * @param targetValue Value of the tile it merged into.
 * @param resultValue Value the merge produces.
 * @param scoreDelta Points the merge pays.
 * @returns The payload.
 */
export function mergePayload(
  source: Position,
  target: Position,
  sourceValue: number,
  targetValue: number,
  resultValue: number,
  scoreDelta: number,
): HookDispatchPayloadMap['onMerge'] {
  return {
    source: new Tile(source, sourceValue),
    target: new Tile(target, targetValue),
    resultValue,
    scoreDelta,
  };
}

/**
 * A stage-end dispatch payload.
 *
 * @param cleared Whether the stage goal was met.
 * @param score Score at the close of the stage.
 * @returns The payload.
 */
export function stageEndPayload(
  cleared: boolean,
  score = 100,
): HookDispatchPayloadMap['onStageEnd'] {
  return { stageIndex: 0, cleared, score };
}
