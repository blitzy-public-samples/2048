// The `tumbler` relic of the `board-manipulation` family, in isolation: the
// shuffle relic, and one of the FIVE charge-bearing relics of the catalogue
// (`frostbind`, `temporal-anchor`, `tumbler`, `culling-blade`,
// `scouring-wind`).
//
// Three properties are asserted here, and one gate:
//   property one    it fires on the hooks it binds and on no other
//   property two    its effect is a value-preserving permutation of the board
//   property three  its charge budget, including the zero-charge invocation
//   the gate        seeded determinism, and which RNG substream it advances
//
// PROVENANCE OF THE LATTICE FACTS ASSERTED BELOW, from the deleted vanilla
// sources this engine was ported from:
//   js/grid.js L45-L64    `availableCells()` and `eachCell()` walk the board
//                         x-outer and y-inner; that order is the order a
//                         destination draw resolves against.
//   js/grid.js L89-L95    `insertTile()` and `removeTile()` index
//                         `cells[tile.x][tile.y]`, with no occupancy check on
//                         the destination.
//   js/grid.js L102-L117  `serialize()` yields `{ size, cells }`, occupied
//                         cells as `{ position, value }` and empty cells kept
//                         as `null`.
//   js/tile.js L10-L17    `savePosition()` snapshots the current cell into a
//                         fresh object; `updatePosition()` changes the current
//                         cell and leaves `previousPosition` alone.
//
// AAP working assumption A2 places the shuffle relic in `board-manipulation`.
//
// The two figures this suite stands on, each named here and carried by the
// document named beside it:
//   Figure 5, "Hook Dispatch Sequence: Pickup-Order Fan-Out with Charge Guard
//     and Error Isolation", in docs/architecture/hook-dispatch-sequence.md —
//     the charge-guard path.
//   Figure 7, "Seeded Determinism: One Run Seed Fanned into Named RNG
//     Substreams", in docs/architecture/data-flow.md — whose legend states
//     that substream separation is what makes relic composition safe, which is
//     the property the cursor assertions below enforce.
//
// Every dispatch runs through a real `HookBus` against a real `Grid`, so the
// charge guard, the per-handler randomness fork and the board-effect
// transaction are the production ones. The bus mechanism itself is covered by
// tests/unit/engine; nothing here re-proves it.
//
// Decisions behind this file are recorded in docs/DECISION_LOG.md.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_BOARD_SIZE,
  createDefaultRulesConfig,
} from '../../../src/config/default-config';
import type { RulesConfig } from '../../../src/config/rules-config';
import { Grid } from '../../../src/engine/grid';
import { createHookBus } from '../../../src/engine/hook-bus';
import type {
  HookBus,
  HookDispatchResult,
  HookSubscriber,
} from '../../../src/engine/hook-bus';
import { HOOK_NAMES } from '../../../src/engine/hooks';
import type {
  HookContext,
  HookEnvironment,
  HookHandler,
  HookHandlerTable,
  HookName,
} from '../../../src/engine/hooks';
import { Tile } from '../../../src/engine/tile';
import {
  DIRECTION_LEFT,
  NOOP_ENGINE_REPORTER,
} from '../../../src/engine/types';
import type {
  CellMatrix,
  CorrelationId,
  Position,
  SerializedGrid,
  SerializedTile,
} from '../../../src/engine/types';
import { BOARD_MANIPULATION_FAMILY } from '../../../src/relics/families/board-manipulation';
import {
  RELIC_CATALOGUE,
  RelicRegistry,
  findRelicById,
} from '../../../src/relics/relic-registry';
import { RARITIES } from '../../../src/relics/relic-types';
import type { Relic } from '../../../src/relics/relic-types';
import {
  RNG_STREAM_NAMES,
  createRngStreams,
} from '../../../src/rng/rng-streams';
import type {
  RngCursorMap,
  RngStreams,
  StreamName,
} from '../../../src/rng/rng-streams';
import {
  createBlockedBoard,
  createEmptyBoard,
  createMergePairBoard,
  createNearLossBoard,
} from '../../fixtures/boards';

/* ==========================================================================
 * 1. Harness
 * ========================================================================== */

/** Identifier the relic is registered and drawn under. */
const TUMBLER_ID = 'tumbler';

/** Family the relic is declared in. */
const FAMILY_NAME = 'board-manipulation';

/** Charge budget the definition declares. */
const DECLARED_CHARGES = 3;

/** Relics of the whole catalogue that declare a charge budget. */
const CHARGE_BEARING_RELICS = 5;

/** The hooks the definition binds, and the only ones. */
const BOUND_HOOKS: readonly HookName[] = ['onBeforeMove'];

/** Fixed seed every determinism assertion resolves against. */
const SUITE_SEED = 'tumbler-suite-seed';

/** A second fixed seed, resolving the same board to a different tumble. */
const ALTERNATE_SEED = 'tumble-alt-seed';

/** Run correlation identifier every bus and registry below is built with. */
const RUN_CORRELATION_ID: CorrelationId = 'run-tumbler-suite';

/** The substream the family contract draws from. */
const DRAW_STREAM: StreamName = 'relic-draw';

/**
 * Cells opened in the fully-occupied fixture to put each board size inside the
 * relic's scarcity band, which is a quarter of the board rounded up.
 *
 * At size 4 the band is 4 cells and the four openings fill it, so each
 * destination draw resolves against more than one candidate. At size 3 the
 * band is 3 cells and at size 5 it is 7.
 */
const OPENED_CELLS: Readonly<Record<number, readonly Position[]>> =
  Object.freeze({
    3: Object.freeze([{ x: 2, y: 2 }]),
    4: Object.freeze([
      { x: 3, y: 3 },
      { x: 3, y: 2 },
      { x: 0, y: 0 },
      { x: 2, y: 1 },
    ]),
    5: Object.freeze([
      { x: 4, y: 4 },
      { x: 4, y: 3 },
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ]),
  });

/**
 * The relic as the family declares it.
 *
 * Resolved once, asserted in section 5, and read through `tumbler()`, which
 * throws a named error on an identifier the family no longer declares.
 */
const DECLARED_TUMBLER: Relic | undefined =
  BOARD_MANIPULATION_FAMILY.relics.find(
    (relic: Relic): boolean => relic.id === TUMBLER_ID,
  );

/**
 * The relic under test.
 *
 * @returns The definition the family declares.
 * @throws {Error} If the family declares no relic under the identifier.
 */
function tumbler(): Relic {
  if (DECLARED_TUMBLER === undefined) {
    throw new Error(
      `The ${FAMILY_NAME} family declares no relic under the identifier ` +
        `${TUMBLER_ID}.`,
    );
  }

  return DECLARED_TUMBLER;
}

/**
 * The handler the relic binds to `onBeforeMove`.
 *
 * @returns The bound handler.
 * @throws {Error} If the relic binds no handler to that hook.
 */
function tumbleHandler(): HookHandler<'onBeforeMove'> {
  const bound = tumbler().hooks.onBeforeMove;

  if (bound === undefined) {
    throw new Error(`Relic ${TUMBLER_ID} binds no onBeforeMove handler.`);
  }

  return bound;
}

/** The bound handler's own source, as the assertions on it read it. */
function handlerSource(): string {
  return String(tumbleHandler());
}

/** The hooks the relic is expected to bind, sorted for comparison. */
function sortedBoundHooks(): HookName[] {
  return [...BOUND_HOOKS].sort();
}

/** One dispatch's collaborators, all live. */
interface Bench {
  readonly grid: Grid;
  readonly config: RulesConfig;
  readonly streams: RngStreams;
  readonly bus: HookBus;
  readonly environment: HookEnvironment;
}

/**
 * Builds a bench around one board and one subscriber.
 *
 * @param grid Live board the dispatch resolves against.
 * @param seed Run seed the substreams are derived from.
 * @param subscriber Subscriber registered with the bus.
 * @returns The bench.
 */
function benchFor(grid: Grid, seed: string, subscriber: HookSubscriber): Bench {
  const config = createDefaultRulesConfig();

  config.boardSize = grid.size;

  const streams = createRngStreams(seed);
  const bus = createHookBus({
    correlationId: RUN_CORRELATION_ID,
    reporter: NOOP_ENGINE_REPORTER,
  });

  expect(bus.register(subscriber), `${subscriber.id} registers`).toBe(true);

  return {
    grid,
    config,
    streams,
    bus,
    environment: { config, rng: streams, grid },
  };
}

/**
 * A bench with the relic itself registered.
 *
 * @param grid Live board.
 * @param seed Run seed. Defaults to the suite seed.
 * @param charges Budget the subscription starts with. Defaults to the budget
 *   the definition declares.
 * @param state Slot the subscription starts with. Defaults to the definition's.
 * @returns The bench.
 */
function tumblerBench(
  grid: Grid,
  seed: string = SUITE_SEED,
  charges: number | undefined = tumbler().charges,
  state: unknown = tumbler().state,
): Bench {
  return benchFor(grid, seed, {
    id: TUMBLER_ID,
    hooks: tumbler().hooks,
    charges,
    state,
  });
}

/**
 * Dispatches one `onBeforeMove` against a bench.
 *
 * @param bench Bench to dispatch on.
 * @returns The dispatch's accumulated payload and counts.
 */
function tumble(bench: Bench): HookDispatchResult<'onBeforeMove'> {
  return bench.bus.dispatch(
    'onBeforeMove',
    { direction: DIRECTION_LEFT, board: bench.grid, cancelled: false },
    bench.environment,
  );
}

/* ==========================================================================
 * 2. Boards
 * ========================================================================== */

// Every board below is built through `new Grid(size, cells)`, whose
// `fromState` reads `state[x][y]` and therefore takes the CELL MATRIX rather
// than the whole `{ size, cells }` fixture, and is opened through
// `Grid.removeTile` rather than by writing into `Grid.cells`.

/**
 * A live board restored from one fixture's cell matrix.
 *
 * @param cells Serialised cell matrix, read as `cells[x][y]`.
 * @param size Edge length the lattice is built at.
 * @returns The live board.
 */
function gridFrom(cells: CellMatrix<SerializedTile>, size: number): Grid {
  return new Grid(size, cells);
}

/**
 * A live board of the configured size, from one fixture's cell matrix.
 *
 * @param cells Serialised cell matrix, read as `cells[x][y]`.
 * @returns The live board.
 */
function defaultGrid(cells: CellMatrix<SerializedTile>): Grid {
  return gridFrom(cells, DEFAULT_BOARD_SIZE);
}

/**
 * Empties the named cells of a board through the lattice's own removal path.
 *
 * @param grid Board to open.
 * @param cells Cells to empty.
 * @returns The same board.
 */
function emptyCells(grid: Grid, cells: readonly Position[]): Grid {
  for (const cell of cells) {
    const tile = grid.cellContent(cell);

    if (tile !== null) {
      grid.removeTile(tile);
    }
  }

  return grid;
}

/**
 * A board inside the relic's scarcity band at the given size: the
 * fully-occupied fixture with `OPENED_CELLS` emptied.
 *
 * @param size Edge length. Defaults to the configured board size.
 * @returns The live board.
 * @throws {Error} If no opening is declared for the size.
 */
function tumblingBoard(size: number = DEFAULT_BOARD_SIZE): Grid {
  const opened = OPENED_CELLS[size];

  if (opened === undefined) {
    throw new Error(`No scarcity-band opening is declared for size ${size}.`);
  }

  return emptyCells(
    gridFrom(createNearLossBoard(size).grid.cells, size),
    opened,
  );
}

/** The fully-occupied fixture, with no empty cell at all. */
function fullBoard(size: number = DEFAULT_BOARD_SIZE): Grid {
  return gridFrom(createNearLossBoard(size).grid.cells, size);
}

/** The cell and value of the one tile `singleTileBoard()` places. */
const LONE_TILE = Object.freeze({ x: 1, y: 2, value: 8 });

/** A board of the default size holding exactly one tile. */
function singleTileBoard(): Grid {
  const grid = gridFrom(
    createEmptyBoard(DEFAULT_BOARD_SIZE).grid.cells,
    DEFAULT_BOARD_SIZE,
  );

  grid.insertTile(
    new Tile({ x: LONE_TILE.x, y: LONE_TILE.y }, LONE_TILE.value),
  );

  return grid;
}

/* ==========================================================================
 * 3. Lattice inspectors
 * ========================================================================== */

/** One occupied cell, with the tile object that occupies it. */
interface Occupant {
  readonly tile: Tile;
  readonly x: number;
  readonly y: number;
  readonly value: number;
}

/**
 * Every occupied cell, x-outer and y-inner — js/grid.js L45-L64's order.
 *
 * @param grid Board to read.
 * @returns The occupants, in scan order.
 */
function occupantsOf(grid: Grid): Occupant[] {
  const found: Occupant[] = [];

  grid.eachCell((x: number, y: number, tile: Tile | null): void => {
    if (tile !== null) {
      found.push({ tile, x, y, value: tile.value });
    }
  });

  return found;
}

/**
 * Face values on the board, ascending: the multiset a permutation preserves.
 *
 * @param grid Board to read.
 * @returns The sorted values.
 */
function sortedValuesOf(grid: Grid): number[] {
  return occupantsOf(grid)
    .map((occupant: Occupant): number => occupant.value)
    .sort((left: number, right: number): number => left - right);
}

/**
 * The cell each live tile occupies, keyed by the tile object itself: a
 * relocation is then read per TILE, not per cell.
 *
 * @param grid Board to read.
 * @returns The map.
 */
function placementsOf(grid: Grid): Map<Tile, Position> {
  const placements = new Map<Tile, Position>();

  for (const occupant of occupantsOf(grid)) {
    placements.set(occupant.tile, { x: occupant.x, y: occupant.y });
  }

  return placements;
}

/**
 * How many tiles hold a different cell than the one captured for them.
 *
 * @param before Placements captured before the dispatch.
 * @returns The relocation count.
 */
function relocationCount(before: Map<Tile, Position>): number {
  let moved = 0;

  for (const [tile, origin] of before) {
    if (tile.x !== origin.x || tile.y !== origin.y) {
      moved += 1;
    }
  }

  return moved;
}

/**
 * Asserts the lattice is coherent: every occupant inside the bounds, in the
 * cell its own coordinates name, and alone in it.
 *
 * `Grid.insertTile` assigns `cells[tile.x][tile.y]` with no occupancy check
 * (js/grid.js L89-L91), so a tile whose coordinates disagree with its slot, and
 * a tile object sitting in two slots, are both silent corruption.
 *
 * @param grid Board to check.
 * @param label Name reported with each failure.
 */
function expectCoherentLattice(grid: Grid, label: string): void {
  const occupants = occupantsOf(grid);
  const distinct = new Set<Tile>(
    occupants.map((occupant: Occupant): Tile => occupant.tile),
  );

  expect(distinct.size, `${label}: one tile object per occupied cell`).toBe(
    occupants.length,
  );

  for (const occupant of occupants) {
    const cell = { x: occupant.x, y: occupant.y };

    expect(
      grid.withinBounds(cell),
      `${label}: (${cell.x},${cell.y}) is in bounds`,
    ).toBe(true);
    expect(
      { x: occupant.tile.x, y: occupant.tile.y },
      `${label}: tile coordinates name their own slot`,
    ).toEqual(cell);
    expect(grid.cellContent(cell), `${label}: the slot holds that tile`).toBe(
      occupant.tile,
    );
  }
}

/**
 * Asserts a board serialises to the `{ size, cells }` shape js/grid.js
 * L102-L117 wrote — empty cells kept as `null`, occupied cells carrying the
 * position they sit at — and that restoring from it reproduces it exactly.
 *
 * @param grid Board to check.
 * @param label Name reported with each failure.
 */
function expectSerializationRoundTrip(grid: Grid, label: string): void {
  const snapshot: SerializedGrid = grid.serialize();

  expect(snapshot.size, `${label}: serialised size`).toBe(grid.size);
  expect(snapshot.cells, `${label}: one column per index`).toHaveLength(
    grid.size,
  );

  for (let x = 0; x < grid.size; x += 1) {
    const column = snapshot.cells[x];

    expect(
      column,
      `${label}: column ${x} holds one entry per row`,
    ).toHaveLength(grid.size);

    for (let y = 0; y < grid.size; y += 1) {
      const entry = column[y];
      const tile = grid.cellContent({ x, y });

      if (tile === null) {
        expect(entry, `${label}: empty cell (${x},${y}) is null`).toBeNull();
      } else {
        expect(entry, `${label}: occupied cell (${x},${y})`).toEqual({
          position: { x, y },
          value: tile.value,
        });
      }
    }
  }

  expect(
    gridFrom(snapshot.cells, snapshot.size).serialize(),
    `${label}: restoring from the snapshot reproduces it`,
  ).toEqual(snapshot);
}

/**
 * Asserts no tile carries a merge record, so no view is asked to draw two
 * source tiles beneath a relocated one.
 *
 * @param grid Board to check.
 * @param label Name reported with each failure.
 */
function expectNoDanglingMerge(grid: Grid, label: string): void {
  for (const occupant of occupantsOf(grid)) {
    expect(
      occupant.tile.mergedFrom,
      `${label}: (${occupant.x},${occupant.y}) carries no merge record`,
    ).toBeNull();
  }
}

/** The rules members this suite holds a relic to leaving alone. */
interface RulesSnapshot {
  readonly boardSize: number;
  readonly winValue: number;
  readonly startTiles: number;
  readonly spawnValues: readonly number[];
  readonly spawnWeights: readonly number[];
  readonly canMerge: RulesConfig['merge']['canMerge'];
  readonly produce: RulesConfig['merge']['produce'];
}

/**
 * Reads the rules members a board relic must not change.
 *
 * @param config Rules in force.
 * @returns The snapshot.
 */
function snapshotRules(config: RulesConfig): RulesSnapshot {
  return {
    boardSize: config.boardSize,
    winValue: config.winValue,
    startTiles: config.startTiles,
    spawnValues: [...config.spawn.values],
    spawnWeights: [...config.spawn.weights],
    canMerge: config.merge.canMerge,
    produce: config.merge.produce,
  };
}

/**
 * Reads one substream's draw count from a cursor snapshot.
 *
 * @param cursors Cursor snapshot.
 * @param name Substream to read.
 * @returns The draw count.
 */
function cursorOf(cursors: RngCursorMap, name: StreamName): number {
  return cursors[name];
}

/* ==========================================================================
 * 4. A freshly built default per test
 * ========================================================================== */

// `DEFAULT_RULES_CONFIG` is deep-frozen and shared, so the baseline every
// rules assertion below compares against is built from
// `createDefaultRulesConfig()` afresh for each test, exactly as each bench
// builds the config it dispatches with.

let baselineRules: RulesSnapshot;

beforeEach((): void => {
  baselineRules = snapshotRules(createDefaultRulesConfig());
});

/* ==========================================================================
 * 5. The definition
 * ========================================================================== */

describe('the tumbler relic definition', () => {
  it('is declared by the board-manipulation family under its own id', () => {
    expect(BOARD_MANIPULATION_FAMILY.name).toBe(FAMILY_NAME);
    expect(DECLARED_TUMBLER, `${FAMILY_NAME} declares it`).toBeDefined();
    expect(tumbler().id).toBe(TUMBLER_ID);
  });

  it('is the same object the run catalogue resolves that id to', () => {
    expect(findRelicById(TUMBLER_ID)).toBe(tumbler());
    expect(RELIC_CATALOGUE).toContain(tumbler());
  });

  it('carries the relic data shape and nothing beyond it', () => {
    expect(Object.getOwnPropertyNames(tumbler()).sort()).toEqual([
      'charges',
      'description',
      'hooks',
      'id',
      'name',
      'rarity',
    ]);
    expect(tumbler().name).toBe('Tumbler');
    expect(tumbler().rarity).toBe(RARITIES[1]);
    expect(tumbler().description).toBeTypeOf('string');
    expect(tumbler().description.length).toBeGreaterThan(0);
  });

  it('declares no state slot of its own', () => {
    expect('state' in tumbler()).toBe(false);
    expect(tumbler().state).toBeUndefined();
  });
});

/* ==========================================================================
 * 6. Property one: the hooks it binds, and only those
 * ========================================================================== */

// The relic binds ONE hook, so a shared state slot across two bindings has no
// subject here; the registry-owned single-slot contract is proved in
// tests/unit/relics/relic-registry.test.ts.

describe('the hooks the tumbler relic binds', () => {
  it('binds onBeforeMove and no other of the six named hooks', () => {
    expect(Object.keys(tumbler().hooks).sort()).toEqual(sortedBoundHooks());

    for (const bound of BOUND_HOOKS) {
      expect(HOOK_NAMES, `${bound} is a named hook`).toContain(bound);
    }
  });

  it('omits every unbound hook name rather than binding undefined', () => {
    const table: HookHandlerTable = tumbler().hooks;

    for (const name of HOOK_NAMES) {
      if (BOUND_HOOKS.includes(name)) {
        continue;
      }

      expect(name in table, `${name} is absent from the table`).toBe(false);
      expect(
        Object.prototype.hasOwnProperty.call(table, name),
        `${name} is not an own property`,
      ).toBe(false);
    }
  });

  it('binds a callable handler to each hook it declares', () => {
    for (const bound of BOUND_HOOKS) {
      expect(tumbler().hooks[bound], `${bound} is callable`).toBeTypeOf(
        'function',
      );
    }
  });

  it('keeps no module state: two slots, one seed, one board', () => {
    const first = tumblerBench(tumblingBoard(), SUITE_SEED, DECLARED_CHARGES, {
      slot: 'first',
    });
    const second = tumblerBench(tumblingBoard(), SUITE_SEED, DECLARED_CHARGES, {
      slot: 'second',
    });

    expect(tumble(first).effectsApplied).toBeGreaterThan(0);
    expect(tumble(second).effectsApplied).toBeGreaterThan(0);

    expect(second.grid.serialize()).toEqual(first.grid.serialize());
  });

  it('leaves each subscription its own untouched state slot', () => {
    const bench = tumblerBench(tumblingBoard(), SUITE_SEED, DECLARED_CHARGES, {
      slot: 'held',
    });

    expect(tumble(bench).effectsApplied).toBeGreaterThan(0);

    const held = bench.bus
      .subscribers()
      .find((entry: HookSubscriber): boolean => entry.id === TUMBLER_ID);

    expect(held?.state).toEqual({ slot: 'held' });
  });
});

/* ==========================================================================
 * 7. Property two: the effect is a value-preserving permutation
 * ========================================================================== */

describe('the tumble inside the scarcity band', () => {
  it(
    'preserves the tile count and the sorted value multiset while ' +
      'changing at least one position',
    () => {
      const bench = tumblerBench(tumblingBoard());
      const before = occupantsOf(bench.grid);
      const valuesBefore = sortedValuesOf(bench.grid);
      const placements = placementsOf(bench.grid);

      const result = tumble(bench);

      expect(result.invoked, 'the handler ran').toBe(1);
      expect(occupantsOf(bench.grid), 'tile count').toHaveLength(before.length);
      expect(sortedValuesOf(bench.grid), 'multiset').toEqual(valuesBefore);
      expect(relocationCount(placements), 'relocated tiles').toBeGreaterThan(0);
    },
  );

  it(
    'leaves every tile in bounds, in the cell its own coordinates name, ' +
      'and alone in it',
    () => {
      const bench = tumblerBench(tumblingBoard());

      expect(tumble(bench).effectsApplied).toBeGreaterThan(0);

      expectCoherentLattice(bench.grid, 'the tumbled board');
    },
  );

  it('round-trips the tumbled board through its snapshot shape', () => {
    const bench = tumblerBench(tumblingBoard());

    expect(tumble(bench).effectsApplied).toBeGreaterThan(0);

    expectSerializationRoundTrip(bench.grid, 'the tumbled board');
  });

  it('records the cell every relocated tile came from', () => {
    // js/tile.js L10-L17: `savePosition()` writes `previousPosition` as a fresh
    // object holding the coordinates at the time of the call, and
    // `updatePosition()` then changes only the current coordinates. The two
    // together are the from/to pair a view tweens.
    const bench = tumblerBench(tumblingBoard());
    const placements = placementsOf(bench.grid);

    expect(tumble(bench).effectsApplied).toBeGreaterThan(0);

    let checked = 0;

    for (const [tile, origin] of placements) {
      if (tile.x === origin.x && tile.y === origin.y) {
        continue;
      }

      expect(tile.previousPosition, 'the origin is recorded').toEqual(origin);
      expect(tile.previousPosition, 'the record is its own object').not.toBe(
        origin,
      );
      checked += 1;
    }

    expect(
      checked,
      'at least one tile was relocated and checked',
    ).toBeGreaterThan(0);
  });

  it('leaves no tile carrying a merge record', () => {
    const bench = tumblerBench(tumblingBoard());

    expect(tumble(bench).effectsApplied).toBeGreaterThan(0);

    expectNoDanglingMerge(bench.grid, 'the tumbled board');
  });

  it(
    'reaches the lattice through move commands alone, so it removes ' +
      'nothing, inserts nothing and awards no score',
    () => {
      const bench = tumblerBench(tumblingBoard());
      const before = occupantsOf(bench.grid).length;

      const result = tumble(bench);

      expect(result.effectsApplied, 'one command per tile placed').toBe(before);
      expect(result.effectsRefused, 'no command was refused').toBe(0);

      const kinds = [
        ...new Set(result.effects.map((effect): string => effect.kind)),
      ];

      expect(kinds, 'the command vocabulary the tumble uses').toEqual([
        'moveTile',
      ]);

      // `restoreBoard` is the one command of the vocabulary that carries a
      // score, and the tumble records none.
      expect(kinds, 'no score-bearing command').not.toContain('restoreBoard');
      expect(kinds, 'no removal').not.toContain('removeTile');
    },
  );

  it('writes the lattice without a direct cells subscript assignment', () => {
    expect(handlerSource(), 'no cells[...] = write').not.toMatch(/cells\s*\[/u);
  });

  it(
    'returns the payload it was handed, neither withdrawing nor ' +
      'redirecting the move',
    () => {
      const bench = tumblerBench(tumblingBoard());

      const result = tumble(bench);

      expect(result.payload, 'a payload came back').toBeDefined();
      expect(result.payload.direction, 'the requested direction').toBe(
        DIRECTION_LEFT,
      );
      expect(result.payload.cancelled, 'the move still resolves').toBe(false);
      expect(result.rejected, 'the return was accepted').toBe(0);
      expect(result.failed, 'the handler did not throw').toBe(0);
    },
  );

  it('leaves the rules in force exactly as they were', () => {
    const bench = tumblerBench(tumblingBoard());

    expect(tumble(bench).effectsApplied).toBeGreaterThan(0);

    expect(snapshotRules(bench.config)).toEqual(baselineRules);
  });
});

/* ==========================================================================
 * 8. Property two, continued: board sizes other than four
 * ========================================================================== */

describe('the tumble at a board size the run reconciled to', () => {
  for (const size of [3, 5] as const) {
    it(`conserves the value multiset and the lattice at size ${size}`, () => {
      const bench = tumblerBench(tumblingBoard(size));

      expect(bench.config.boardSize, 'the rules carry the size').toBe(size);

      const valuesBefore = sortedValuesOf(bench.grid);
      const placements = placementsOf(bench.grid);

      const result = tumble(bench);

      expect(result.invoked, 'the handler ran').toBe(1);
      expect(result.effectsApplied, 'one command per tile').toBe(
        placements.size,
      );
      expect(sortedValuesOf(bench.grid), 'multiset').toEqual(valuesBefore);
      expect(relocationCount(placements), 'relocated').toBeGreaterThan(0);
      expectCoherentLattice(bench.grid, `the tumbled board at size ${size}`);
      expectSerializationRoundTrip(
        bench.grid,
        `the tumbled board at size ${size}`,
      );
    });
  }
});

/* ==========================================================================
 * 9. Property two, continued: boards outside the scarcity band
 * ========================================================================== */

describe('a board outside the scarcity band', () => {
  const outside: readonly (readonly [string, () => Grid])[] = [
    [
      'the empty fixture',
      (): Grid => defaultGrid(createEmptyBoard().grid.cells),
    ],
    [
      'the merge-pair fixture',
      (): Grid => defaultGrid(createMergePairBoard().grid.cells),
    ],
    [
      'the blocked fixture',
      (): Grid => defaultGrid(createBlockedBoard().grid.cells),
    ],
    ['a board holding one tile', (): Grid => singleTileBoard()],
    ['a board with no empty cell', (): Grid => fullBoard()],
  ];

  for (const [label, build] of outside) {
    it(`leaves ${label} untouched, without throwing`, () => {
      const bench = tumblerBench(build());
      const snapshot = bench.grid.serialize();
      const valuesBefore = sortedValuesOf(bench.grid);

      const result = tumble(bench);

      expect(result.invoked, 'the handler still ran').toBe(1);
      expect(result.failed, 'it did not throw').toBe(0);
      expect(result.effectsApplied, 'it wrote nothing').toBe(0);
      expect(result.chargesConsumed, 'it paid nothing').toBe(0);
      expect(bench.grid.serialize(), 'the board is untouched').toEqual(
        snapshot,
      );
      expect(sortedValuesOf(bench.grid), 'multiset').toEqual(valuesBefore);
      expectCoherentLattice(bench.grid, label);
    });
  }

  it('creates no tile on the empty fixture', () => {
    const bench = tumblerBench(defaultGrid(createEmptyBoard().grid.cells));

    expect(tumble(bench).failed).toBe(0);
    expect(occupantsOf(bench.grid), 'still empty').toHaveLength(0);
  });

  it('keeps the one tile of a single-tile board, at its value', () => {
    const bench = tumblerBench(singleTileBoard());

    expect(tumble(bench).failed).toBe(0);

    const occupants = occupantsOf(bench.grid);

    expect(occupants).toHaveLength(1);
    expect(occupants[0]).toMatchObject({
      x: LONE_TILE.x,
      y: LONE_TILE.y,
      value: LONE_TILE.value,
    });
  });
});

/* ==========================================================================
 * 10. Property three: the charge budget, and the zero-charge invocation
 * ========================================================================== */

// The notional charge a DIRECT call is made under. The bus builds the real
// context — the frozen views, the per-handler randomness fork and the
// board-effect transaction — and the probe below hands the relic's handler
// that same context with `charges` alone replaced. Every collaborator the
// direct call reads is therefore the production one. Decision DL-BOARD-01
// records where the guard and the decrement live.

/** Identifier the probe subscribes under. */
const PROBE_ID = 'tumbler-direct-call-probe';

/** The notional charge the next direct call is made under. */
interface DirectPlan {
  notionalCharges: number | undefined;
}

/** What one direct call was observed to do. */
interface DirectRecord {
  invocations: number;
  notionalCharges: unknown;
  correlationId: CorrelationId;
  contextMembers: readonly string[];
  returnedTheSamePayload: boolean;
  stateAfterCall: unknown;
}

/** A record with nothing yet observed. */
function emptyRecord(): DirectRecord {
  return {
    invocations: 0,
    notionalCharges: 'unobserved',
    correlationId: '',
    contextMembers: [],
    returnedTheSamePayload: false,
    stateAfterCall: 'unobserved',
  };
}

/**
 * A subscriber that calls the relic's handler directly, under the notional
 * charge `plan` holds, and records what it observed.
 *
 * @param plan Notional charge the call is made under.
 * @param record Sink the observation is written to.
 * @returns The handler table to register.
 */
function directProbe(plan: DirectPlan, record: DirectRecord): HookHandlerTable {
  return {
    onBeforeMove: (payload, context: HookContext) => {
      const forced: HookContext = {
        ...context,
        charges: plan.notionalCharges,
      };

      record.invocations += 1;
      record.notionalCharges = forced.charges;
      record.correlationId = forced.correlationId;
      record.contextMembers = Object.keys(forced).sort();

      let returned: unknown;

      expect((): void => {
        returned = tumbleHandler()(payload, forced);
      }, 'a direct call does not throw').not.toThrow();

      record.returnedTheSamePayload = returned === payload;
      record.stateAfterCall = forced.state;

      return payload;
    },
  };
}

describe('the charge budget of the tumbler relic', () => {
  it(
    'declares a finite positive budget, one of the five charge-bearing ' +
      'relics',
    () => {
      expect(tumbler().charges, 'a budget is declared').toBeTypeOf('number');
      expect(tumbler().charges).toBe(DECLARED_CHARGES);
      expect(Number.isFinite(tumbler().charges ?? Number.NaN)).toBe(true);
      expect(tumbler().charges ?? 0).toBeGreaterThan(0);

      expect(
        RELIC_CATALOGUE.filter(
          (relic: Relic): boolean => relic.charges !== undefined,
        ),
        'charge-bearing relics in the catalogue',
      ).toHaveLength(CHARGE_BEARING_RELICS);
    },
  );

  it('never reads, compares or writes the budget in its handler', () => {
    expect(handlerSource(), 'no charges reference').not.toMatch(/charges/u);
  });

  it('spends one charge for a tumble and none for an idle turn', () => {
    const acting = tumblerBench(tumblingBoard());
    const idle = tumblerBench(fullBoard());

    expect(tumble(acting).chargesConsumed, 'a tumble costs one').toBe(1);
    expect(tumble(idle).chargesConsumed, 'an idle turn costs nothing').toBe(0);
  });

  for (const notional of [0, -3] as const) {
    it(`neither throws nor corrupts the board at ${notional} charges`, () => {
      const plan: DirectPlan = { notionalCharges: notional };
      const record = emptyRecord();
      const bench = benchFor(tumblingBoard(), SUITE_SEED, {
        id: PROBE_ID,
        hooks: directProbe(plan, record),
      });
      const valuesBefore = sortedValuesOf(bench.grid);
      const countBefore = occupantsOf(bench.grid).length;

      const result = tumble(bench);

      expect(record.invocations, 'the direct call was made').toBe(1);
      expect(record.notionalCharges, 'the notional budget').toBe(notional);
      expect(result.failed, 'nothing was thrown').toBe(0);
      expect(result.rejected, 'the return was accepted').toBe(0);
      expect(record.returnedTheSamePayload, 'a payload came back').toBe(true);

      expect(occupantsOf(bench.grid), 'tile count').toHaveLength(countBefore);
      expect(sortedValuesOf(bench.grid), 'multiset').toEqual(valuesBefore);
      expectCoherentLattice(bench.grid, `a call at ${notional} charges`);
      expectSerializationRoundTrip(bench.grid, `a call at ${notional} charges`);
      expectNoDanglingMerge(bench.grid, `a call at ${notional} charges`);

      expect(snapshotRules(bench.config), 'the rules').toEqual(baselineRules);
      expect(record.stateAfterCall, 'the slot holds nothing').toBeUndefined();
      expect((): string => JSON.stringify(record.stateAfterCall)).not.toThrow();
    });
  }

  it('carries the run correlation identifier into the direct call', () => {
    const plan: DirectPlan = { notionalCharges: 0 };
    const record = emptyRecord();
    const bench = benchFor(tumblingBoard(), SUITE_SEED, {
      id: PROBE_ID,
      hooks: directProbe(plan, record),
    });

    expect(tumble(bench).failed).toBe(0);

    expect(record.correlationId, 'the identifier is carried verbatim').toBe(
      RUN_CORRELATION_ID,
    );
    expect(record.contextMembers, 'the context members the call reads').toEqual(
      expect.arrayContaining([
        'charges',
        'config',
        'correlationId',
        'effects',
        'grid',
        'rng',
        'spendCharge',
        'state',
      ]),
    );
  });

  it('still tumbles correctly on the call after a zero-charge one', () => {
    const plan: DirectPlan = { notionalCharges: 0 };
    const record = emptyRecord();
    const bench = benchFor(tumblingBoard(), SUITE_SEED, {
      id: PROBE_ID,
      hooks: directProbe(plan, record),
    });
    const valuesBefore = sortedValuesOf(bench.grid);

    expect(tumble(bench).failed, 'the zero-charge call').toBe(0);

    plan.notionalCharges = DECLARED_CHARGES;

    const placements = placementsOf(bench.grid);
    const result = tumble(bench);

    expect(record.invocations, 'both calls were made').toBe(2);
    expect(result.failed, 'the second call did not throw').toBe(0);
    expect(
      result.effectsApplied,
      'the second call moved tiles',
    ).toBeGreaterThan(0);
    expect(relocationCount(placements), 'relocated tiles').toBeGreaterThan(0);
    expect(sortedValuesOf(bench.grid), 'value multiset').toEqual(valuesBefore);
    expectCoherentLattice(bench.grid, 'the board after both calls');
  });

  it('stops taking effect once the live budget is exhausted', () => {
    const grid = tumblingBoard();
    const config = createDefaultRulesConfig();
    const streams = createRngStreams(SUITE_SEED);
    const bus = createHookBus({
      correlationId: RUN_CORRELATION_ID,
      reporter: NOOP_ENGINE_REPORTER,
    });
    const registry = new RelicRegistry({
      catalogue: [tumbler()],
      bus,
      reporter: NOOP_ENGINE_REPORTER,
      correlationId: RUN_CORRELATION_ID,
    });

    expect(registry.pickUp(TUMBLER_ID)?.charges, 'the budget at pickup').toBe(
      DECLARED_CHARGES,
    );

    const environment: HookEnvironment = { config, rng: streams, grid };
    const valuesBefore = sortedValuesOf(grid);
    const changed: boolean[] = [];

    for (let turn = 0; turn < DECLARED_CHARGES + 2; turn += 1) {
      const before = JSON.stringify(grid.serialize());
      const result = bus.dispatch(
        'onBeforeMove',
        { direction: DIRECTION_LEFT, board: grid, cancelled: false },
        environment,
      );

      expect(result.failed, `turn ${turn} did not throw`).toBe(0);
      changed.push(JSON.stringify(grid.serialize()) !== before);
    }

    expect(changed, 'the board changes until the budget runs out').toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
    expect(registry.find(TUMBLER_ID)?.charges, 'the live budget').toBe(0);
    expect(sortedValuesOf(grid), 'value multiset across the run').toEqual(
      valuesBefore,
    );
    expectCoherentLattice(grid, 'the board after the budget ran out');
  });
});

/* ==========================================================================
 * 11. Seeded determinism and substream hygiene
 * ========================================================================== */

describe('the seeded determinism of the tumble', () => {
  it('resolves one seed to one board across two built runs', () => {
    const first = tumblerBench(tumblingBoard(), SUITE_SEED);
    const second = tumblerBench(tumblingBoard(), SUITE_SEED);

    expect(tumble(first).effectsApplied).toBeGreaterThan(0);
    expect(tumble(second).effectsApplied).toBeGreaterThan(0);

    expect(second.grid.serialize(), 'the same seed, the same board').toEqual(
      first.grid.serialize(),
    );
    expect(
      second.streams.snapshotCursors(),
      'the same seed, the same draw counts',
    ).toEqual(first.streams.snapshotCursors());
  });

  it('resolves two different seeds to two different boards', () => {
    const first = tumblerBench(tumblingBoard(), SUITE_SEED);
    const second = tumblerBench(tumblingBoard(), ALTERNATE_SEED);

    expect(tumble(first).effectsApplied).toBeGreaterThan(0);
    expect(tumble(second).effectsApplied).toBeGreaterThan(0);

    expect(
      second.grid.serialize(),
      'a second seed throws the tiles differently',
    ).not.toEqual(first.grid.serialize());
    expect(sortedValuesOf(second.grid), 'both conserve the multiset').toEqual(
      sortedValuesOf(first.grid),
    );
  });

  it('advances the relic-draw cursor alone, once per tile placed', () => {
    const bench = tumblerBench(tumblingBoard());
    const before = bench.streams.snapshotCursors();
    const tiles = occupantsOf(bench.grid).length;

    expect(tumble(bench).effectsApplied).toBe(tiles);

    const after = bench.streams.snapshotCursors();

    expect(
      cursorOf(after, DRAW_STREAM) - cursorOf(before, DRAW_STREAM),
      'one draw per tile placed',
    ).toBe(tiles);

    for (const name of RNG_STREAM_NAMES) {
      if (name === DRAW_STREAM) {
        continue;
      }

      expect(cursorOf(after, name), `${name} is unmoved`).toBe(
        cursorOf(before, name),
      );
    }
  });

  it('leaves the rarity-weight cursor of the reward draw at zero', () => {
    const bench = tumblerBench(tumblingBoard());

    expect(tumble(bench).effectsApplied).toBeGreaterThan(0);

    const cursors = bench.streams.snapshotCursors();

    expect(cursorOf(cursors, 'rarity-weight'), 'rarity-weight').toBe(0);
    expect(cursorOf(cursors, 'spawn-value'), 'spawn-value').toBe(0);
    expect(cursorOf(cursors, 'spawn-position'), 'spawn-position').toBe(0);
  });

  it('takes no draw at all on a board outside the scarcity band', () => {
    const idle: readonly (() => Grid)[] = [
      fullBoard,
      singleTileBoard,
      (): Grid => defaultGrid(createEmptyBoard().grid.cells),
      (): Grid => defaultGrid(createMergePairBoard().grid.cells),
    ];

    for (const build of idle) {
      const bench = tumblerBench(build());

      expect(tumble(bench).effectsApplied).toBe(0);

      for (const name of RNG_STREAM_NAMES) {
        expect(
          cursorOf(bench.streams.snapshotCursors(), name),
          `${name} did not drift`,
        ).toBe(0);
      }
    }
  });

  it('reaches no unseeded randomness and handles no error itself', () => {
    const source = handlerSource();

    expect(source, 'no Math.random').not.toMatch(/Math\s*\.\s*random/u);
    expect(source, 'no catch clause').not.toMatch(/\bcatch\b/u);
    expect(source, 'no console call').not.toMatch(/console/u);
  });
});

/* ==========================================================================
 * 12. The catalogue definition is left as it shipped
 * ========================================================================== */

describe('the catalogue definition after every case above', () => {
  it('still declares its own budget, and is still frozen', () => {
    expect(tumbler().charges, 'the declared budget').toBe(DECLARED_CHARGES);
    expect(Object.isFrozen(tumbler()), 'the definition is frozen').toBe(true);
    expect(Object.isFrozen(tumbler().hooks), 'its hooks are frozen').toBe(true);
    expect(Object.keys(tumbler().hooks).sort()).toEqual(sortedBoundHooks());
  });

  it('still holds no state slot of its own', () => {
    expect('state' in tumbler()).toBe(false);
  });
});
