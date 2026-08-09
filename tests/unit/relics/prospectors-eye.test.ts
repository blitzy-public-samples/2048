// Per-relic suite for the `spawn-control` relic `prospectors-eye`, AAP 0.6.3
// Group 5. Three properties, in this order: the hooks the relic binds, the
// effect it produces, and its treatment of a charge budget it does not carry.
//
// UNIT UNDER TEST: the `prospectors-eye` entry of `SPAWN_CONTROL_FAMILY` in
// src/relics/families/spawn-control.ts, reached by id and cross-checked against
// `findRelicById` of src/relics/relic-registry.ts.
//
// The `HookContext` every dispatch below receives is assembled here rather than
// by src/engine/hook-bus.ts: a live `RulesConfig` from
// `createDefaultRulesConfig()`, the four named substreams from
// `createRngStreams()` on a fixed literal seed, a live `Grid` behind the query
// surface of `ReadonlyGridView`, a board-effect queue that refuses and records
// every command, the run correlation identifier, and the subscriber's own
// mutable state slot.
//
// VANILLA ANCHORS, the mechanical provenance of the boundaries asserted below:
//   js/grid.js L37-L43    `randomAvailableCell` yields no cell on a full board:
//                         its `if (cells.length)` branch has no else. `pick` of
//                         src/rng/rng-streams.ts carries that boundary forward
//                         and consumes no draw on an empty candidate list.
//   js/grid.js L45-L55    `availableCells` collects the empty cells x-outer and
//                         y-inner, through `eachCell` at L58-L64. That order is
//                         part of the seeded-spawn reproducibility contract and
//                         is the order a uniform draw resolves against.
//   js/grid.js L80-L86    `cellContent` yields null for a cell outside the
//                         lattice rather than throwing, so an off-lattice cell
//                         reads as empty. Every steered cell below is asserted
//                         against `withinBounds`.
//   js/application.js L3  the board-size literal `4`, one of the three
//                         declaration sites AAP R4 replaces with configuration.
//                         The ring assertions read `RulesConfig.boardSize` and
//                         run at three board sizes and at one reduced mid-run.
//
// FIXTURES, from tests/fixtures/boards.ts: `createNearLossBoard(n)` is the FULL
// board, every cell occupied, and is the board the absent-cell case runs on;
// `createBlockedBoard(n)` fills column 0 alone and still reports empty cells.
// `createEmptyBoard(n)` is size-parameterised, which the three-size ring cases
// call. Each case asserts the board property it depends on before using it.
//
// TRACEABILITY, docs/TRACEABILITY_MATRIX.md: this suite is the evidence for the
// rows mapping js/grid.js L37-L43 `randomAvailableCell` and L45-L55
// `availableCells` onto the seeded spawn-position draw and the `onSpawn` hook,
// and for TR-SPAWN-03, the `prospectors-eye` declaration.
//
// Decisions this suite asserts against, argued in docs/DECISION_LOG.md and
// named here only so the construct can be found from the log:
//   DL-SPAWN-01  a spawn relic acting through the `onSpawn` payload's `value`,
//                `position` and `count` members alone
//   DL-SPAWN-02  the substream a relic effect draws from
//
// Figure 7, "Seeded Determinism: One Run Seed Fanned into Named RNG
// Substreams" (docs/architecture/data-flow.md), carries the substream fan-out
// that the cursor assertions of section 6 measure.
//
// This suite reads no DOM, starts no server, performs no network call, patches
// no global and reads no clock. It is collected by the `unit:dom-free` project
// of vitest.config.ts under `npm test`.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BOARD_SIZE,
  createDefaultRulesConfig,
} from '../../../src/config/default-config';
import type { RulesConfig } from '../../../src/config/rules-config';
import { Grid } from '../../../src/engine/grid';
import { HOOK_NAMES } from '../../../src/engine/hooks';
import type {
  BoardEffectQueue,
  HookContext,
  HookHandler,
  HookName,
  ReadonlyGridView,
  SpawnPayload,
  StageStartPayload,
} from '../../../src/engine/hooks';
import { Tile } from '../../../src/engine/tile';
import type {
  CorrelationId,
  Position,
  SerializedGameState,
} from '../../../src/engine/types';
import {
  SPAWN_CONTROL_FAMILY,
} from '../../../src/relics/families/spawn-control';
import { findRelicById } from '../../../src/relics/relic-registry';
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
  createEmptyBoard,
  createNearLossBoard,
} from '../../fixtures/boards';

/* ==========================================================================
 * 1. Constants
 * ========================================================================== */

/** Identifier the family declares the relic under. */
const RELIC_ID = 'prospectors-eye';

/** Display name the family declares. */
const RELIC_NAME = "Prospector's Eye";

/** Position of the relic in the family's declaration order. */
const DECLARATION_INDEX = 2;

/** Relics the family declares. */
const FAMILY_RELIC_COUNT = 4;

/** The two hook names the relic binds, in declaration order. */
const BOUND_HOOKS: readonly HookName[] = ['onStageStart', 'onSpawn'];

/** The four hook names the relic leaves unbound. */
const UNBOUND_HOOKS: readonly HookName[] = [
  'onBeforeMove',
  'onMerge',
  'onAfterMove',
  'onStageEnd',
];

/**
 * Run correlation identifier carried on every context this file builds, so the
 * correlation plumbing is exercised on both dispatches.
 */
const RUN_CORRELATION_ID: CorrelationId = 'run-prospectors-eye';

/** Seed every bench uses unless a case names its own. */
const DEFAULT_SEED = 'prospectors-eye-default';

/** Tile value the spawn payloads carry unless a case names its own. */
const SPAWN_VALUE = 2;

/**
 * A second configured spawn value, for the cases asserting that the relic
 * carries `value` through untransformed while it steers `position`.
 */
const OTHER_SPAWN_VALUE = 4;

/** Target of the goal the `onStageStart` payload carries. */
const STAGE_GOAL_TARGET = 64;

/** Board sizes the ring assertions run at. */
const BOARD_SIZES: readonly number[] = [3, 4, 5];

/** Edge length a board-shrinking relic leaves in force mid-run. */
const REDUCED_BOARD_SIZE = 3;

/** Fixed seeds the repeated ring cases iterate. */
const RING_SEEDS: readonly string[] = [
  'eye-ring-a',
  'eye-ring-b',
  'eye-ring-c',
  'eye-ring-d',
  'eye-ring-e',
  'eye-ring-f',
];

/** Distinct seeds the spread case draws from. */
const SEED_SPREAD = 12;

/** No substream advanced. */
const NO_DRAWS: RngCursorMap = {
  'spawn-value': 0,
  'spawn-position': 0,
  'relic-draw': 0,
  'rarity-weight': 0,
};

/** One draw taken from `relic-draw` and none from the other three. */
const ONE_RELIC_DRAW: RngCursorMap = {
  'spawn-value': 0,
  'spawn-position': 0,
  'relic-draw': 1,
  'rarity-weight': 0,
};

/* ==========================================================================
 * 2. The relic under test
 * ========================================================================== */

/**
 * Resolves the relic out of the family it is declared in, failing loudly when
 * the family carries no entry under `RELIC_ID`.
 *
 * @returns The family's own declaration.
 * @throws {Error} If the family declares no relic under that id.
 */
function relicUnderTest(): Relic {
  const found = SPAWN_CONTROL_FAMILY.relics.find(
    (relic) => relic.id === RELIC_ID,
  );

  if (found === undefined) {
    throw new Error(
      `The spawn-control family declares no relic with id ${RELIC_ID}.`,
    );
  }

  return found;
}

/** The declaration under test, resolved once. */
const EYE: Relic = relicUnderTest();

/**
 * The relic's plain members as they stand at import, for the closing
 * comparison against the same members after every case has run.
 */
const DECLARED_SHAPE = JSON.stringify({
  id: EYE.id,
  name: EYE.name,
  rarity: EYE.rarity,
  description: EYE.description,
  hooks: Object.keys(EYE.hooks),
  charges: EYE.charges ?? null,
  state: EYE.state ?? null,
});

/**
 * Resolves the `onSpawn` handler, failing loudly when the binding is absent.
 *
 * @returns The bound handler.
 * @throws {Error} If the relic binds no `onSpawn` handler.
 */
function spawnHandler(): HookHandler<'onSpawn'> {
  const handler = EYE.hooks.onSpawn;

  if (handler === undefined) {
    throw new Error(`${RELIC_ID} binds no onSpawn handler.`);
  }

  return handler;
}

/**
 * Resolves the `onStageStart` handler, failing loudly when the binding is
 * absent.
 *
 * @returns The bound handler.
 * @throws {Error} If the relic binds no `onStageStart` handler.
 */
function stageStartHandler(): HookHandler<'onStageStart'> {
  const handler = EYE.hooks.onStageStart;

  if (handler === undefined) {
    throw new Error(`${RELIC_ID} binds no onStageStart handler.`);
  }

  return handler;
}

/** The bodies of both bound handlers, as source text. */
function boundHandlerSources(): string[] {
  return [String(stageStartHandler()), String(spawnHandler())];
}

/* ==========================================================================
 * 3. Geometry helpers
 * ========================================================================== */

/**
 * Reports whether a cell lies on the outer ring of a square board of edge
 * length `size`: the first or last column, or the first or last row.
 *
 * @param cell Cell to test.
 * @param size Edge length in force.
 * @returns `true` when the cell is on the ring.
 */
function isOnOuterRing(cell: Position, size: number): boolean {
  const edge = size - 1;

  return cell.x === 0 || cell.y === 0 || cell.x === edge || cell.y === edge;
}

/**
 * Renders a cell as a comparable key, for membership assertions against a
 * candidate list whose entries are fresh objects on every call.
 *
 * @param cell Cell to render.
 * @returns The cell as `"x,y"`.
 */
function cellKey(cell: Position): string {
  return `${String(cell.x)},${String(cell.y)}`;
}

/**
 * Lists the empty cells NOT on the outer ring of the lattice's own edge
 * length, in the x-outer, y-inner order js/grid.js L45-L64 collects them in.
 *
 * @param grid Board to read.
 * @returns A fresh array of the interior empty cells.
 */
function interiorCells(grid: Grid): Position[] {
  return grid
    .availableCells()
    .filter((cell) => !isOnOuterRing(cell, grid.size));
}

/**
 * Fills every empty outer-ring cell of the lattice, leaving the interior as it
 * stands. The candidate list is a fresh array, so inserting while walking it is
 * safe.
 *
 * @param grid Board to fill.
 * @param value Face value each inserted tile carries.
 */
function fillOuterRing(grid: Grid, value: number): void {
  for (const cell of grid.availableCells()) {
    if (isOnOuterRing(cell, grid.size)) {
      grid.insertTile(new Tile(cell, value));
    }
  }
}

/* ==========================================================================
 * 4. The hand-built dispatch bench
 * ========================================================================== */

/**
 * The query half of a live `Grid`, as `HookContext.grid` declares it.
 *
 * `size` is a getter, so it is read at call time rather than captured, and
 * `cellValue` stands in for `cellContent`: js/grid.js L80-L86 yields null both
 * for an empty cell and for one outside the lattice, and this view carries that
 * single null forward.
 *
 * @param grid Board the view reads.
 * @returns The read-only view over that board.
 */
function gridView(grid: Grid): ReadonlyGridView {
  return {
    get size(): number {
      return grid.size;
    },

    withinBounds: (position) => grid.withinBounds(position),
    cellAvailable: (cell) => grid.cellAvailable(cell),
    cellOccupied: (cell) => grid.cellOccupied(cell),
    cellValue: (cell) => grid.cellContent(cell)?.value ?? null,
    availableCells: () => grid.availableCells(),
    cellsAvailable: () => grid.cellsAvailable(),
    serialize: () => grid.serialize(),
  };
}

/**
 * A board-effect queue that refuses every command and records the name of each
 * one it refused, and answers every query from the live lattice.
 *
 * @param grid Board the queries read.
 * @param refusals Sink each refused command name is appended to.
 * @returns The recording queue.
 */
function recordingEffects(
  grid: Grid,
  refusals: string[],
): BoardEffectQueue {
  const refuse = (command: string): boolean => {
    refusals.push(command);

    return false;
  };

  return {
    get size(): number {
      return grid.size;
    },

    length: 0,

    get refused(): number {
      return refusals.length;
    },

    insertTile: () => refuse('insertTile'),
    removeTile: () => refuse('removeTile'),
    moveTile: () => refuse('moveTile'),
    restoreBoard: () => refuse('restoreBoard'),
    resizeBoard: () => refuse('resizeBoard'),
    setMergePredicate: () => refuse('setMergePredicate'),
    setSpawnWeights: () => refuse('setSpawnWeights'),
    request: () => refuse('request'),
    requested: () => [],
    cellValue: (cell) => grid.cellContent(cell)?.value ?? null,
    cellOccupied: (cell) => grid.cellOccupied(cell),
    availableCells: () => grid.availableCells(),
    occupiedCells: () => [],
    clear: () => undefined,
  };
}

/** One assembled dispatch bench and the live collaborators behind it. */
interface EyeBench {
  /** The rules in force, mutable, as a run's own configuration is. */
  readonly config: RulesConfig;

  /** The live lattice the context's view reads. */
  readonly grid: Grid;

  /** The run's four named substreams. */
  readonly streams: RngStreams;

  /** The context handed to the handler under test. */
  readonly context: HookContext;

  /** Board commands the handler recorded, in record order. */
  readonly refusals: string[];

  /** Charge amounts the handler requested, in request order. */
  readonly chargeRequests: number[];
}

/** What `bench()` accepts, every member defaulted. */
interface BenchOptions {
  /** Fixed literal seed the substreams are derived from. */
  readonly seed?: string;

  /** Board the lattice is restored from. */
  readonly board?: SerializedGameState;

  /** Edge length the rules carry, defaulting to the board's own. */
  readonly boardSize?: number;

  /** Charge budget the notional subscription holds. */
  readonly charges?: number;

  /** Hook the context names as the one being dispatched. */
  readonly hook?: HookName;
}

/**
 * Assembles a bench: a fresh live configuration, a lattice restored from a
 * fixture board, substreams on a fixed seed, and a context carrying the run
 * correlation identifier and a mutable state slot.
 *
 * `new Grid(size, cells)` takes the CELL MATRIX, not the whole serialised
 * board, and reads it as `state[x][y]`.
 *
 * @param options Seed, board, edge length, charge budget and hook name.
 * @returns The assembled bench.
 */
function bench(options: BenchOptions = {}): EyeBench {
  const board = options.board ?? createEmptyBoard(DEFAULT_BOARD_SIZE);
  const grid = new Grid(board.grid.size, board.grid.cells);

  // `createDefaultRulesConfig()` yields a fresh mutable configuration;
  // `DEFAULT_RULES_CONFIG` beside it is deep-frozen and shared.
  const config = createDefaultRulesConfig();

  config.boardSize = options.boardSize ?? board.grid.size;

  const streams = createRngStreams(options.seed ?? DEFAULT_SEED);
  const refusals: string[] = [];
  const chargeRequests: number[] = [];

  const context: HookContext = {
    config,
    rng: streams,
    grid: gridView(grid),
    effects: recordingEffects(grid, refusals),
    correlationId: RUN_CORRELATION_ID,
    hook: options.hook ?? 'onSpawn',
    subscriberId: RELIC_ID,
    pickupOrder: 1,
    charges: options.charges,

    spendCharge: (amount?: number) => {
      chargeRequests.push(amount ?? 1);

      return false;
    },

    state: undefined,
  };

  return { config, grid, streams, context, refusals, chargeRequests };
}

/**
 * Builds an `onSpawn` payload carrying a cell.
 *
 * @param cell Cell the engine resolved.
 * @param value Value the rules produced.
 * @returns The payload, with a fresh position object.
 */
function spawnAt(cell: Position, value: number = SPAWN_VALUE): SpawnPayload {
  return { position: { x: cell.x, y: cell.y }, value };
}

/**
 * Builds an `onSpawn` payload carrying NO cell, which is the payload a full
 * board produces: js/grid.js L37-L43 returned no cell in that case.
 *
 * @param value Value the rules produced.
 * @returns The payload, with no `position` key at all.
 */
function spawnWithoutCell(value: number = SPAWN_VALUE): SpawnPayload {
  return { value };
}

/**
 * Builds an `onStageStart` payload. The goal is typed through
 * `StageStartPayload['goal']`, so no module outside this suite's dependency set
 * is named.
 *
 * @param stageIndex Stage the payload opens.
 * @param boardSize Reconciled edge length the stage's grid was built at.
 * @param seed Seed of the run in progress.
 * @returns The payload.
 */
function stageStartPayload(
  stageIndex: number,
  boardSize: number,
  seed: string,
): StageStartPayload {
  const goal: StageStartPayload['goal'] = {
    kind: 'highest-tile',
    target: STAGE_GOAL_TARGET,
  };

  return { stageIndex, goal, seed, boardSize };
}

/**
 * Dispatches one spawn through a bench.
 *
 * @param target Bench to dispatch on.
 * @param payload Spawn the engine resolved.
 * @returns The payload the handler resolved to.
 * @throws {Error} If the handler returned nothing.
 */
function resolveSpawn(
  target: EyeBench,
  payload: SpawnPayload,
): SpawnPayload {
  const resolved = spawnHandler()(payload, target.context);

  if (resolved === undefined) {
    throw new Error(
      `${RELIC_ID} returned no payload from onSpawn; it resolves the spawn ` +
        'it was given.',
    );
  }

  return resolved;
}

/**
 * Dispatches one spawn and asserts the dispatch itself does not throw. The
 * boundary cases that use it are a full board, an occupied ring and an
 * exhausted charge budget.
 *
 * @param target Bench to dispatch on.
 * @param payload Spawn the engine resolved.
 * @returns The payload the handler resolved to.
 * @throws {Error} If the handler returned nothing.
 */
function resolveWithoutThrowing(
  target: EyeBench,
  payload: SpawnPayload,
): SpawnPayload {
  let resolved: SpawnPayload | undefined;

  expect(() => {
    resolved = resolveSpawn(target, payload);
  }).not.toThrow();

  if (resolved === undefined) {
    throw new Error(`${RELIC_ID} resolved no payload from onSpawn.`);
  }

  return resolved;
}

/**
 * Reads the cell a resolved spawn carries.
 *
 * @param payload Resolved spawn.
 * @returns The cell.
 * @throws {Error} If the payload carries no cell.
 */
function requireCell(payload: SpawnPayload): Position {
  const cell = payload.position;

  if (cell === undefined) {
    throw new Error('The resolved spawn carried no cell.');
  }

  return cell;
}

/**
 * Reads the draw count of all four substreams.
 *
 * @param target Bench to read.
 * @returns A fresh total cursor map.
 */
function cursorsOf(target: EyeBench): RngCursorMap {
  return target.streams.snapshotCursors();
}

/**
 * Subtracts two cursor maps, walking `RNG_STREAM_NAMES` so all four substreams
 * are reported whether or not they moved.
 *
 * @param before Cursors read before the dispatch.
 * @param after Cursors read after it.
 * @returns The per-substream difference.
 */
function cursorDelta(
  before: RngCursorMap,
  after: RngCursorMap,
): RngCursorMap {
  const delta: Partial<Record<StreamName, number>> = {};

  for (const name of RNG_STREAM_NAMES) {
    delta[name] = after[name] - before[name];
  }

  return delta as RngCursorMap;
}

/* ==========================================================================
 * 5. Property 1: the relic fires only on the hooks it binds
 * ========================================================================== */

describe('prospectors-eye binds onStageStart and onSpawn alone', () => {
  it('declares exactly those two hook keys, in declaration order', () => {
    expect(Object.keys(EYE.hooks)).toEqual(['onStageStart', 'onSpawn']);
    expect(Object.keys(EYE.hooks)).toHaveLength(2);
  });

  it('declares only names the engine publishes in HOOK_NAMES', () => {
    for (const name of Object.keys(EYE.hooks)) {
      expect(HOOK_NAMES).toContain(name);
    }

    expect(HOOK_NAMES).toHaveLength(6);
  });

  it('omits the other four hook names rather than binding undefined', () => {
    for (const name of UNBOUND_HOOKS) {
      expect(Object.prototype.hasOwnProperty.call(EYE.hooks, name)).toBe(false);
      expect(name in EYE.hooks).toBe(false);
    }

    expect(UNBOUND_HOOKS).toHaveLength(4);
    expect([...BOUND_HOOKS, ...UNBOUND_HOOKS].sort()).toEqual(
      [...HOOK_NAMES].sort(),
    );
  });

  it('binds a function at each of its two hook names', () => {
    for (const name of BOUND_HOOKS) {
      expect(EYE.hooks[name]).toBeTypeOf('function');
    }
  });

  it('is published by the family and by the catalogue as one object', () => {
    expect(findRelicById(RELIC_ID)).toBe(EYE);
    expect(SPAWN_CONTROL_FAMILY.name).toBe('spawn-control');
    expect(SPAWN_CONTROL_FAMILY.relics).toHaveLength(FAMILY_RELIC_COUNT);
    expect(SPAWN_CONTROL_FAMILY.relics[DECLARATION_INDEX]).toBe(EYE);
  });

  it('declares the plain data members the relic shape names', () => {
    expect(EYE.id).toBe(RELIC_ID);
    expect(EYE.name).toBe(RELIC_NAME);
    expect(RARITIES).toContain(EYE.rarity);
    expect(EYE.description.length).toBeGreaterThan(0);
  });
});

/* ==========================================================================
 * 6. Property 2: the effect, read against the configured board size
 * ========================================================================== */

describe('prospectors-eye steers a spawn onto the outer ring', () => {
  it('counts four times the edge length less four ring cells', () => {
    for (const size of BOARD_SIZES) {
      const target = bench({ board: createEmptyBoard(size) });
      const cells = target.grid.availableCells();
      const ring = cells.filter((cell) => isOnOuterRing(cell, size));

      expect(target.config.boardSize).toBe(size);
      expect(cells).toHaveLength(size * size);
      expect(ring).toHaveLength(4 * size - 4);
      expect(cells.length - ring.length).toBe((size - 2) ** 2);
    }
  });

  it(
    'steers an interior spawn position to an available outer-ring ' +
      'cell of the configured board size',
    () => {
      for (const seed of RING_SEEDS) {
        const target = bench({ seed });
        const available = target.grid.availableCells().map(cellKey);
        const cell = requireCell(
          resolveSpawn(target, spawnAt({ x: 1, y: 1 })),
        );

        expect(isOnOuterRing(cell, target.config.boardSize)).toBe(true);
        expect(available).toContain(cellKey(cell));
        expect(target.grid.withinBounds(cell)).toBe(true);
      }
    },
  );

  it('steers only onto a cell available before the dispatch', () => {
    for (const seed of RING_SEEDS) {
      const target = bench({ seed });

      target.grid.insertTile(new Tile({ x: 0, y: 0 }, 8));
      target.grid.insertTile(new Tile({ x: 3, y: 2 }, 8));

      const available = target.grid.availableCells().map(cellKey);
      const cell = requireCell(resolveSpawn(target, spawnAt({ x: 1, y: 1 })));

      expect(available).toContain(cellKey(cell));
      expect(target.grid.cellAvailable(cell)).toBe(true);
      expect(target.grid.cellOccupied(cell)).toBe(false);
      expect(isOnOuterRing(cell, target.config.boardSize)).toBe(true);
    }
  });

  it('leaves a spawn already on the ring on the ring, never inward', () => {
    for (const seed of RING_SEEDS) {
      const target = bench({ seed });
      const cell = requireCell(resolveSpawn(target, spawnAt({ x: 0, y: 0 })));

      expect(isOnOuterRing(cell, target.config.boardSize)).toBe(true);
      expect(interiorCells(target.grid).map(cellKey)).not.toContain(
        cellKey(cell),
      );
    }
  });

  it('leaves the spawn on its interior cell when the ring is full', () => {
    const target = bench({ seed: 'eye-ring-occupied' });

    fillOuterRing(target.grid, 2);

    const interior = interiorCells(target.grid);

    expect(interior).toHaveLength((target.config.boardSize - 2) ** 2);

    const before = cursorsOf(target);
    const resolved = resolveWithoutThrowing(
      target,
      spawnAt(interior[0], OTHER_SPAWN_VALUE),
    );
    const cell = requireCell(resolved);

    expect(cell).toEqual(interior[0]);
    expect(target.grid.cellAvailable(cell)).toBe(true);
    expect(target.grid.withinBounds(cell)).toBe(true);
    expect(resolved.value).toBe(OTHER_SPAWN_VALUE);

    // `pick` of src/rng/rng-streams.ts consumes no draw on an empty candidate
    // list, which is the boundary js/grid.js L37-L43 expressed.
    expect(cursorDelta(before, cursorsOf(target))).toEqual(NO_DRAWS);
  });

  it('leaves a cell-less spawn absent on a full board, taking no draw', () => {
    const target = bench({
      seed: 'eye-full-board',
      board: createNearLossBoard(DEFAULT_BOARD_SIZE),
    });

    expect(target.grid.availableCells()).toHaveLength(0);
    expect(target.grid.cellsAvailable()).toBe(false);

    const before = cursorsOf(target);
    const resolved = resolveWithoutThrowing(target, spawnWithoutCell());

    expect(resolved.position).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(resolved, 'position')).toBe(
      false,
    );
    expect(resolved.value).toBe(SPAWN_VALUE);
    expect(cursorDelta(before, cursorsOf(target))).toEqual(NO_DRAWS);
  });

  it('reads the ring from the size in force at three edge lengths', () => {
    for (const size of BOARD_SIZES) {
      for (const seed of RING_SEEDS) {
        const target = bench({
          seed: `${seed}-${String(size)}`,
          board: createEmptyBoard(size),
        });
        const interior = interiorCells(target.grid);

        expect(interior.length).toBeGreaterThan(0);

        const cell = requireCell(
          resolveSpawn(target, spawnAt(interior[0])),
        );

        expect(target.config.boardSize).toBe(size);
        expect(isOnOuterRing(cell, target.config.boardSize)).toBe(true);
        expect(cell.x).toBeLessThan(size);
        expect(cell.y).toBeLessThan(size);
        expect(cell.x).toBeGreaterThanOrEqual(0);
        expect(cell.y).toBeGreaterThanOrEqual(0);
        expect(target.grid.withinBounds(cell)).toBe(true);
      }
    }
  });

  it('steers onto the ring of the reduced board after a shrink', () => {
    const offTheLatticeRing: string[] = [];

    for (const seed of RING_SEEDS) {
      const target = bench({
        seed: `${seed}-shrunk`,
        board: createEmptyBoard(DEFAULT_BOARD_SIZE),
        boardSize: REDUCED_BOARD_SIZE,
      });

      expect(target.grid.size).toBe(DEFAULT_BOARD_SIZE);
      expect(target.config.boardSize).toBe(REDUCED_BOARD_SIZE);

      const cell = requireCell(resolveSpawn(target, spawnAt({ x: 1, y: 1 })));

      expect(isOnOuterRing(cell, target.config.boardSize)).toBe(true);
      expect(cell.x).toBeLessThan(REDUCED_BOARD_SIZE);
      expect(cell.y).toBeLessThan(REDUCED_BOARD_SIZE);
      expect(target.grid.withinBounds(cell)).toBe(true);

      if (!isOnOuterRing(cell, target.grid.size)) {
        offTheLatticeRing.push(cellKey(cell));
      }
    }

    // Cells collected here are interior to the LATTICE and on the ring of the
    // CONFIGURED board, which are two different rings at these two sizes.
    expect(offTheLatticeRing.length).toBeGreaterThan(0);
  });

  it('resolves to a fresh payload carrying position and value alone', () => {
    const target = bench({ seed: 'eye-payload-shape' });
    const payload = spawnAt({ x: 1, y: 2 });
    const resolved = spawnHandler()(payload, target.context);

    expect(resolved).not.toBeUndefined();

    if (resolved === undefined) {
      throw new Error(`${RELIC_ID} resolved no payload from onSpawn.`);
    }

    expect(resolved).not.toBe(payload);
    expect(Object.keys(resolved).sort()).toEqual(['position', 'value']);
    expect(resolved.value).toBe(SPAWN_VALUE);
    expect(payload.position).toEqual({ x: 1, y: 2 });
  });

  it('leaves the lattice, the rules and the effect queue untouched', () => {
    const target = bench({ seed: 'eye-purity' });

    target.grid.insertTile(new Tile({ x: 2, y: 2 }, 16));

    const latticeBefore = JSON.stringify(target.grid.serialize());
    const rulesBefore = JSON.stringify({
      boardSize: target.config.boardSize,
      winValue: target.config.winValue,
      startTiles: target.config.startTiles,
      values: target.config.spawn.values,
      weights: target.config.spawn.weights,
    });

    resolveSpawn(target, spawnAt({ x: 1, y: 1 }));

    expect(JSON.stringify(target.grid.serialize())).toBe(latticeBefore);
    expect(
      JSON.stringify({
        boardSize: target.config.boardSize,
        winValue: target.config.winValue,
        startTiles: target.config.startTiles,
        values: target.config.spawn.values,
        weights: target.config.spawn.weights,
      }),
    ).toBe(rulesBefore);
    expect(target.refusals).toEqual([]);
    expect(target.context.effects.requested()).toEqual([]);
    expect(target.context.effects.refused).toBe(0);
  });
});

/* ==========================================================================
 * 7. Property 3: charges, including a zero-charge invocation
 * ========================================================================== */

describe('prospectors-eye carries no charge budget and reads none', () => {
  it('declares no charges member at all, and none that is null', () => {
    expect(Object.prototype.hasOwnProperty.call(EYE, 'charges')).toBe(false);
    expect('charges' in EYE).toBe(false);
    expect(EYE.charges).toBeUndefined();
    expect(EYE.charges).not.toBeNull();
  });

  it('names neither charges nor spendCharge in either handler body', () => {
    // AAP Contract 2 places the charge guard and the decrement in
    // src/engine/hook-bus.ts.
    for (const source of boundHandlerSources()) {
      expect(source).not.toContain('charges');
      expect(source).not.toContain('spendCharge');
    }

    expect(boundHandlerSources()).toHaveLength(2);
  });

  it('steers a spawn without throwing when the budget in force is zero', () => {
    const target = bench({ seed: 'eye-zero-charge', charges: 0 });

    expect(target.context.charges).toBe(0);

    const before = cursorsOf(target);
    const cell = requireCell(
      resolveWithoutThrowing(target, spawnAt({ x: 1, y: 1 })),
    );

    expect(isOnOuterRing(cell, target.config.boardSize)).toBe(true);
    expect(target.grid.withinBounds(cell)).toBe(true);
    expect(cursorDelta(before, cursorsOf(target))).toEqual(ONE_RELIC_DRAW);
  });

  it('requests no charge and corrupts nothing at zero charges', () => {
    const target = bench({
      seed: 'eye-zero-charge-state',
      charges: 0,
      board: createEmptyBoard(DEFAULT_BOARD_SIZE),
    });

    target.grid.insertTile(new Tile({ x: 2, y: 1 }, 4));

    const latticeBefore = JSON.stringify(target.grid.serialize());

    resolveWithoutThrowing(target, spawnAt({ x: 1, y: 1 }));

    expect(target.chargeRequests).toEqual([]);
    expect(target.refusals).toEqual([]);
    expect(target.context.charges).toBe(0);
    expect(target.context.state).toBeUndefined();
    expect(JSON.stringify(target.grid.serialize())).toBe(latticeBefore);
    expect(target.config.boardSize).toBe(DEFAULT_BOARD_SIZE);
  });

  it('requests no charge on a dispatch it declines to act on', () => {
    const target = bench({ seed: 'eye-decline-charge' });

    fillOuterRing(target.grid, 2);
    resolveWithoutThrowing(target, spawnAt(interiorCells(target.grid)[0]));
    resolveWithoutThrowing(target, spawnWithoutCell());

    expect(target.chargeRequests).toEqual([]);
  });
});

/* ==========================================================================
 * 8. Determinism and substream hygiene
 * ========================================================================== */

describe('prospectors-eye draws only from the substream a relic owns', () => {
  it('takes exactly one relic-draw value and moves no other substream', () => {
    const target = bench({ seed: 'eye-one-draw' });
    const before = cursorsOf(target);

    resolveSpawn(target, spawnAt({ x: 1, y: 1 }));

    expect(cursorDelta(before, cursorsOf(target))).toEqual(ONE_RELIC_DRAW);
  });

  it('takes one draw per steered spawn and none from the spawn pair', () => {
    const target = bench({ seed: 'eye-three-draws' });
    const dispatches = 3;

    for (let index = 0; index < dispatches; index += 1) {
      requireCell(resolveSpawn(target, spawnAt({ x: 1, y: 1 })));
    }

    const cursors = cursorsOf(target);

    expect(cursors['relic-draw']).toBe(dispatches);
    expect(cursors['spawn-value']).toBe(0);
    expect(cursors['spawn-position']).toBe(0);
    expect(cursors['rarity-weight']).toBe(0);
  });

  it('yields one cell from two independent streams on one fixed seed', () => {
    for (const seed of RING_SEEDS) {
      const first = bench({ seed });
      const second = bench({ seed });

      expect(first.streams).not.toBe(second.streams);

      const firstCell = requireCell(
        resolveSpawn(first, spawnAt({ x: 1, y: 1 })),
      );
      const secondCell = requireCell(
        resolveSpawn(second, spawnAt({ x: 1, y: 1 })),
      );

      expect(firstCell).toEqual(secondCell);
      expect(cursorsOf(first)).toEqual(cursorsOf(second));
    }
  });

  it('does not collapse to one cell across twelve different seeds', () => {
    const steered = new Set<string>();

    for (let index = 0; index < SEED_SPREAD; index += 1) {
      const target = bench({ seed: `eye-spread-${String(index)}` });
      const cell = requireCell(resolveSpawn(target, spawnAt({ x: 1, y: 1 })));

      expect(isOnOuterRing(cell, target.config.boardSize)).toBe(true);
      steered.add(cellKey(cell));
    }

    expect(steered.size).toBeGreaterThan(1);
  });

  it('names no unseeded randomness in either handler body', () => {
    for (const source of boundHandlerSources()) {
      expect(source).not.toContain('Math.random');
      expect(source).not.toContain('crypto');
    }
  });
});

/* ==========================================================================
 * 9. The dispatch surface the relic is handed
 * ========================================================================== */

describe('prospectors-eye owns no observability and no error handling', () => {
  it('receives the run correlation identifier on both of its hooks', () => {
    const spawnBench = bench({ seed: 'eye-correlation-spawn' });
    const stageBench = bench({
      seed: 'eye-correlation-stage',
      hook: 'onStageStart',
    });

    expect(spawnBench.context.correlationId).toBe(RUN_CORRELATION_ID);
    expect(stageBench.context.correlationId).toBe(RUN_CORRELATION_ID);

    requireCell(resolveSpawn(spawnBench, spawnAt({ x: 1, y: 1 })));
    stageStartHandler()(
      stageStartPayload(0, DEFAULT_BOARD_SIZE, 'eye-correlation-stage'),
      stageBench.context,
    );

    expect(spawnBench.context.correlationId).toBe(RUN_CORRELATION_ID);
    expect(stageBench.context.correlationId).toBe(RUN_CORRELATION_ID);
    expect(RUN_CORRELATION_ID.length).toBeGreaterThan(0);
  });

  it('names no console call and no catch in either handler body', () => {
    for (const source of boundHandlerSources()) {
      expect(source).not.toContain('console');
      expect(source).not.toContain('catch');
      expect(source).not.toContain('finally');
    }
  });

  it('records the opening board size in its state slot as plain JSON', () => {
    const target = bench({
      seed: 'eye-stage-start',
      hook: 'onStageStart',
    });
    const returned = stageStartHandler()(
      stageStartPayload(0, DEFAULT_BOARD_SIZE, 'eye-stage-start'),
      target.context,
    );

    expect(returned).toBeUndefined();
    expect(target.context.state).toEqual({
      stageBoardSize: DEFAULT_BOARD_SIZE,
    });
    expect(JSON.parse(JSON.stringify(target.context.state))).toEqual({
      stageBoardSize: DEFAULT_BOARD_SIZE,
    });
    expect(target.chargeRequests).toEqual([]);
    expect(cursorsOf(target)).toEqual(NO_DRAWS);
  });
});

/* ==========================================================================
 * 10. The declaration is left as the family wrote it
 * ========================================================================== */

describe('the catalogue entry is unmutated once every case has run', () => {
  it('is frozen, with a frozen hook table and a frozen family array', () => {
    expect(Object.isFrozen(EYE)).toBe(true);
    expect(Object.isFrozen(EYE.hooks)).toBe(true);
    expect(Object.isFrozen(SPAWN_CONTROL_FAMILY)).toBe(true);
    expect(Object.isFrozen(SPAWN_CONTROL_FAMILY.relics)).toBe(true);
  });

  it('carries the same plain members it carried at import', () => {
    expect(
      JSON.stringify({
        id: EYE.id,
        name: EYE.name,
        rarity: EYE.rarity,
        description: EYE.description,
        hooks: Object.keys(EYE.hooks),
        charges: EYE.charges ?? null,
        state: EYE.state ?? null,
      }),
    ).toBe(DECLARED_SHAPE);
    expect(findRelicById(RELIC_ID)).toBe(EYE);
  });
});
