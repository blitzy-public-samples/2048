// Unit suite for the `collapsing-vault` relic of the `risk-reward-cursed`
// family, declared in src/relics/families/risk-reward-cursed.ts. Three
// properties are proved: the hooks it binds, the collapse it applies, and its
// charge surface.
//
// The reload half of the board-size edge case — `reconcileBoardSize` and a
// save/load round trip — is asserted by the sibling suite
// tests/unit/relics/board-mutation.test.ts and is not repeated here. This
// suite asserts the relic's immediate, in-memory effect.
//
// The context both harnesses build carries the run correlation identifier, so
// the correlation plumbing is exercised end to end. Nothing here reads a DOM,
// `Math.random`, a clock or a timer, and nothing here writes a snapshot file.
//
// Decisions: DL-RISK-01, DL-RISK-02 (docs/DECISION_LOG.md).

import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_BOARD_SIZE,
  createDefaultRulesConfig,
} from '../../../src/config/default-config';
import type {
  MergePredicate,
  RulesConfig,
} from '../../../src/config/rules-config';
import { createDefaultStageConfig } from '../../../src/config/stage-config';
import { Engine } from '../../../src/engine/engine';
import type { StateCommitEvent } from '../../../src/engine/engine-events';
import { Grid } from '../../../src/engine/grid';
import {
  createHookBus,
  createReadonlyGridView,
} from '../../../src/engine/hook-bus';
import type {
  HookBus,
  HookDispatchResult,
} from '../../../src/engine/hook-bus';
import { HOOK_NAMES } from '../../../src/engine/hooks';
import type {
  BoardEffect,
  BoardEffectQueue,
  BoardEffectRequest,
  HookContext,
  HookHandler,
  HookName,
  StageEndPayload,
} from '../../../src/engine/hooks';
import {
  hasReachedWinValue,
  movesAvailable,
  tileMatchesAvailable,
} from '../../../src/engine/terminal-state';
import { Tile } from '../../../src/engine/tile';
import type {
  CellMatrix,
  CorrelationId,
  Position,
  SerializedGameState,
  SerializedGrid,
  SerializedTile,
} from '../../../src/engine/types';
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
  RISK_REWARD_CURSED_FAMILY,
} from '../../../src/relics/families/risk-reward-cursed';
import {
  RelicRegistry,
  findRelicById,
} from '../../../src/relics/relic-registry';
import { RARITIES } from '../../../src/relics/relic-types';
import type { Relic } from '../../../src/relics/relic-types';
import {
  createBlockedBoard,
  createNearLossBoard,
  createNearWinBoard,
} from '../../fixtures/boards';

/** Catalogue identifier of the relic under test, and of its registration. */
const RELIC_ID = 'collapsing-vault';

/** Family that publishes the relic, hyphenated as `RelicFamilyName` is. */
const FAMILY_NAME = 'risk-reward-cursed';

/** The one hook the relic binds. It has no vanilla analogue. */
const BOUND_HOOK = 'onStageEnd';

/** Hook names the relic leaves unbound. */
const UNBOUND_HOOKS: readonly HookName[] = HOOK_NAMES.filter(
  (name): boolean => name !== BOUND_HOOK,
);

/** Cells the relic takes off each edge per cleared stage. */
const SHRINK_STEP = 1;

/** Smallest edge length the relic collapses a board to. */
const SIZE_FLOOR = 3;

/** Edge length one collapse above the floor. */
const ONE_ABOVE_FLOOR = SIZE_FLOOR + SHRINK_STEP;

/** Run seed every bench is built from. A fixed literal, never derived. */
const SEED = 'collapsing-vault-0001';

/** A second fixed literal seed, for the seed-sensitivity assertion. */
const OTHER_SEED = 'collapsing-vault-0002';

/** Run correlation identifier carried into every dispatch context. */
const CORRELATION_ID: CorrelationId = 'run-collapsing-vault-0001';

/** The substream the relic draws its re-homing destinations from. */
const REHOME_STREAM: StreamName = 'relic-draw';

/** Substreams the relic never draws from. */
const UNTOUCHED_STREAMS: readonly StreamName[] = RNG_STREAM_NAMES.filter(
  (name): boolean => name !== REHOME_STREAM,
);

/** Score every dispatch below carries, so a changed score is visible. */
const STAGE_SCORE = 40;

/**
 * Resolves the catalogue entry, failing loudly on a renamed or withdrawn id.
 *
 * @returns The relic registered under `RELIC_ID`.
 * @throws {Error} If no relic carries that id.
 */
function relicUnderTest(): Relic {
  const relic = findRelicById(RELIC_ID);

  if (relic === undefined) {
    throw new Error(`No relic is registered under the id "${RELIC_ID}".`);
  }

  return relic;
}

/**
 * Resolves the handler the relic binds to `onStageEnd`.
 *
 * @returns The bound handler.
 * @throws {Error} If the relic binds no handler to that hook.
 */
function stageEndHandler(): HookHandler<'onStageEnd'> {
  const handler = relicUnderTest().hooks[BOUND_HOOK];

  if (handler === undefined) {
    throw new Error(`Relic "${RELIC_ID}" binds no ${BOUND_HOOK} handler.`);
  }

  return handler;
}

/** The handler's source text, read once for the static assertions. */
function handlerSource(): string {
  return stageEndHandler().toString();
}

interface StageBench {
  /** Live rules, rebuilt per bench so no mutation crosses a test. */
  readonly config: RulesConfig;

  /** Live lattice. */
  readonly grid: Grid;

  /** The run's four named substreams. */
  readonly streams: RngStreams;

  /** The bus the relic is registered on. */
  readonly bus: HookBus;
}

/**
 * Builds a bench with the relic registered as the only subscriber.
 *
 * @param size Edge length the rules and the lattice both open at.
 * @param cells Serialised cell matrix, read as `cells[x][y]`.
 * @param seed Run seed. A fixed literal in every caller.
 * @returns The bench.
 */
function stageBench(
  size: number = DEFAULT_BOARD_SIZE,
  cells?: CellMatrix<SerializedTile>,
  seed: string = SEED,
): StageBench {
  const config = createDefaultRulesConfig();
  const relic = relicUnderTest();

  config.boardSize = size;

  const bench: StageBench = {
    config,
    grid: new Grid(size, cells ?? null),
    streams: createRngStreams(seed),
    bus: createHookBus({ correlationId: CORRELATION_ID }),
  };

  const registered = bench.bus.register({
    id: RELIC_ID,
    hooks: relic.hooks,
    state: relic.state,
  });

  if (!registered) {
    throw new Error(`Relic "${RELIC_ID}" could not be registered.`);
  }

  return bench;
}

/**
 * Dispatches one `onStageEnd` through the bench.
 *
 * @param bench Bench to dispatch on.
 * @param cleared Whether the stage was cleared.
 * @param stageIndex Stage ordinal the payload carries.
 * @returns The dispatch result, carrying the accumulated payload and counts.
 */
function endStage(
  bench: StageBench,
  cleared: boolean,
  stageIndex = 0,
): HookDispatchResult<'onStageEnd'> {
  return bench.bus.dispatch(
    BOUND_HOOK,
    { stageIndex, cleared, score: STAGE_SCORE },
    { config: bench.config, rng: bench.streams, grid: bench.grid },
  );
}

/** Reads the state slot the bus holds for the relic's registration. */
function slotOf(bench: StageBench): unknown {
  return bench.bus.subscriptions(BOUND_HOOK)[0]?.state;
}

/** One occupied cell, paired with the tile object standing in it. */
interface Occupant {
  readonly x: number;
  readonly y: number;
  readonly value: number;
  readonly tile: Tile;
}

/** A tile to place, in the vocabulary `place` reads. */
interface Placement {
  readonly x: number;
  readonly y: number;
  readonly value: number;
}

/**
 * Lists the lattice's occupants, x-outer and y-inner — the order js/grid.js
 * L58-L64 walked cells in.
 *
 * @param grid Lattice to walk.
 * @returns One record per occupied cell.
 */
function occupants(grid: Grid): Occupant[] {
  const found: Occupant[] = [];

  grid.eachCell((x: number, y: number, tile: Tile | null): void => {
    if (tile !== null) {
      found.push({ x, y, value: tile.value, tile });
    }
  });

  return found;
}

/**
 * Inserts one tile per placement through `Grid.insertTile`.
 *
 * @param grid Lattice to write.
 * @param placements Cells and values to occupy.
 */
function place(grid: Grid, placements: readonly Placement[]): void {
  for (const placement of placements) {
    grid.insertTile(
      new Tile({ x: placement.x, y: placement.y }, placement.value),
    );
  }
}

/**
 * Occupies every cell of the lattice.
 *
 * @param grid Lattice to write.
 * @param valueAt Face value for each cell.
 */
function fill(grid: Grid, valueAt: (x: number, y: number) => number): void {
  for (let x = 0; x < grid.size; x += 1) {
    for (let y = 0; y < grid.size; y += 1) {
      grid.insertTile(new Tile({ x, y }, valueAt(x, y)));
    }
  }
}

/**
 * Serialises a lattice and rebuilds it from that snapshot, then serialises the
 * rebuild.
 *
 * @param grid Lattice to round-trip.
 * @returns The rebuild's own snapshot.
 */
function roundTrip(grid: Grid): SerializedGrid {
  const snapshot = grid.serialize();

  return new Grid(snapshot.size, snapshot.cells).serialize();
}

/**
 * Asserts the lattice is square at `size`, that every occupant is in bounds,
 * that every occupant's own x/y match the slot holding it, and that no tile
 * object appears in two cells.
 *
 * @param grid Lattice to check.
 * @param size Edge length the lattice must report.
 */
function expectCoherentLattice(grid: Grid, size: number): void {
  expect(grid.size).toBe(size);
  expect(grid.cells.length).toBe(size);

  for (let x = 0; x < size; x += 1) {
    expect(grid.cells[x].length).toBe(size);
  }

  const seen = new Set<Tile>();
  const found = occupants(grid);

  for (const occupant of found) {
    expect(grid.withinBounds({ x: occupant.x, y: occupant.y })).toBe(true);
    expect(occupant.tile.x).toBe(occupant.x);
    expect(occupant.tile.y).toBe(occupant.y);
    expect(seen.has(occupant.tile)).toBe(false);
    seen.add(occupant.tile);
  }

  expect(found.length).toBeLessThanOrEqual(size * size);
  expect(roundTrip(grid)).toEqual(grid.serialize());
}

/**
 * Subtracts one cursor snapshot from another, over every named substream.
 *
 * @param before Cursors read before the dispatch.
 * @param after Cursors read after it.
 * @returns Draws taken per substream.
 */
function cursorDelta(
  before: RngCursorMap,
  after: RngCursorMap,
): RngCursorMap {
  return {
    'spawn-value': after['spawn-value'] - before['spawn-value'],
    'spawn-position': after['spawn-position'] - before['spawn-position'],
    'relic-draw': after['relic-draw'] - before['relic-draw'],
    'rarity-weight': after['rarity-weight'] - before['rarity-weight'],
  };
}

interface RecordingQueue {
  /** The queue as a handler receives it. */
  readonly queue: BoardEffectQueue;

  /** Commands recorded so far, in record order. */
  readonly commands: () => readonly BoardEffect[];
}

/**
 * Builds a recording queue over a lattice.
 *
 * @param grid Lattice the query members read.
 * @returns The queue and a reader for what it recorded.
 */
function recordingQueue(grid: Grid): RecordingQueue {
  const recorded: BoardEffect[] = [];
  let projectedSize = grid.size;

  const record = (effect: BoardEffect): boolean => {
    recorded.push(effect);

    return true;
  };

  const queue: BoardEffectQueue = {
    get size(): number {
      return projectedSize;
    },

    get length(): number {
      return recorded.length;
    },

    get refused(): number {
      return 0;
    },

    insertTile: (cell: Position, value: number): boolean =>
      record({ kind: 'insertTile', cell: { x: cell.x, y: cell.y }, value }),

    removeTile: (cell: Position): boolean =>
      record({ kind: 'removeTile', cell: { x: cell.x, y: cell.y } }),

    moveTile: (from: Position, to: Position, tween = true): boolean =>
      record({
        kind: 'moveTile',
        from: { x: from.x, y: from.y },
        to: { x: to.x, y: to.y },
        tween,
      }),

    restoreBoard: (snapshot: SerializedGrid, score?: number): boolean =>
      record({ kind: 'restoreBoard', snapshot, score }),

    resizeBoard: (size: number): boolean => {
      projectedSize = size;

      return record({ kind: 'resizeBoard', size });
    },

    setMergePredicate: (predicate: MergePredicate): boolean =>
      record({ kind: 'setMergePredicate', predicate }),

    setSpawnWeights: (weights: readonly number[]): boolean =>
      record({ kind: 'setSpawnWeights', weights: [...weights] }),

    request: (effect: BoardEffectRequest): boolean => {
      switch (effect.kind) {
        case 'insertTile':
          return queue.insertTile(effect.cell, effect.value);
        case 'removeTile':
          return queue.removeTile(effect.cell);
        case 'moveTile':
          return queue.moveTile(effect.from, effect.to, effect.tween ?? true);
        case 'restoreBoard': {
          const snapshot = effect.snapshot ?? effect.board;

          return snapshot === undefined
            ? false
            : queue.restoreBoard(snapshot, effect.score);
        }
        case 'resizeBoard': {
          const size = effect.size ?? effect.boardSize;

          return size === undefined ? false : queue.resizeBoard(size);
        }
        case 'setMergePredicate':
          return queue.setMergePredicate(effect.predicate);
        case 'setSpawnWeights':
          return queue.setSpawnWeights(effect.weights);
      }
    },

    requested: (): readonly BoardEffect[] => Object.freeze([...recorded]),

    cellValue: (cell: Position): number | null => {
      const tile = grid.cellContent(cell);

      return tile === null ? null : tile.value;
    },

    cellOccupied: (cell: Position): boolean => grid.cellOccupied(cell),

    availableCells: (): Position[] => grid.availableCells(),

    occupiedCells: () =>
      occupants(grid).map((occupant: Occupant) => ({
        x: occupant.x,
        y: occupant.y,
        value: occupant.value,
      })),

    clear: (): void => {
      recorded.length = 0;
    },
  };

  return { queue, commands: (): readonly BoardEffect[] => [...recorded] };
}

interface DirectDispatch {
  /** The context handed to the handler. */
  readonly context: HookContext;

  /** Commands the handler recorded. */
  readonly commands: () => readonly BoardEffect[];

  /** Amounts passed to `spendCharge`, one entry per call. */
  readonly spendRequests: () => readonly (number | undefined)[];
}

/**
 * @param bench Bench supplying the rules, the substreams and the lattice.
 * @param charges Charge budget the context declares. Absent by default,
 *   which is the budget the relic's own registration carries.
 * @returns The context, plus readers for what the handler did with it.
 */
function directDispatch(
  bench: StageBench,
  charges?: number,
): DirectDispatch {
  const recorder = recordingQueue(bench.grid);
  const spendRequests: (number | undefined)[] = [];

  const context: HookContext = {
    config: bench.config,
    rng: bench.streams,
    grid: createReadonlyGridView(bench.grid),
    effects: recorder.queue,
    correlationId: CORRELATION_ID,
    hook: BOUND_HOOK,
    subscriberId: RELIC_ID,
    pickupOrder: 0,
    charges,
    spendCharge: (amount?: number): boolean => {
      spendRequests.push(amount);

      return false;
    },
    state: relicUnderTest().state,
  };

  return {
    context,
    commands: recorder.commands,
    spendRequests: (): readonly (number | undefined)[] => [...spendRequests],
  };
}

/**
 * Occupants at edge length 4 for the main re-homing scenario: two cells inside
 * the collapsed bound, and three outside it — one on the outermost column, one
 * on the outermost row, and one on their corner.
 */
const OUTER_SCENARIO: readonly Placement[] = [
  { x: 0, y: 0, value: 2 },
  { x: 1, y: 1, value: 4 },
  { x: 3, y: 0, value: 8 },
  { x: 0, y: 3, value: 16 },
  { x: 3, y: 3, value: 32 },
];

/** Occupants of `OUTER_SCENARIO` that fall inside the collapsed bound. */
const KEPT_OCCUPANTS: readonly Placement[] = OUTER_SCENARIO.filter(
  (cell: Placement): boolean =>
    cell.x < SIZE_FLOOR && cell.y < SIZE_FLOOR,
);

/** Occupants of `OUTER_SCENARIO` that fall outside the collapsed bound. */
const EXILED_OCCUPANTS: readonly Placement[] = OUTER_SCENARIO.filter(
  (cell: Placement): boolean =>
    cell.x >= SIZE_FLOOR || cell.y >= SIZE_FLOOR,
);

/**
 * Face value of the collapse-terminal scenario: a strict doubling ladder
 * inside the collapsed bound, where no two orthogonal neighbours are equal,
 * and one repeated value across the band the collapse drops.
 *
 * @param x Column.
 * @param y Row.
 * @returns The face value for that cell.
 */
function terminalScenarioValue(x: number, y: number): number {
  return x >= SIZE_FLOOR || y >= SIZE_FLOOR ? 1024 : 2 ** (1 + x + y);
}

/**
 * Occupies every cell, putting the winning value on the far corner, which the
 * collapse drops.
 *
 * @param grid Lattice to fill.
 * @param winValue Value placed on the corner cell.
 */
function fillWithCornerWinner(grid: Grid, winValue: number): void {
  const corner = grid.size - 1;

  fill(grid, (x: number, y: number): number =>
    x === corner && y === corner
      ? winValue
      : 2 ** (1 + ((x + 2 * y) % 5)),
  );
}

/** A default config rebuilt before every test. */
let baseline: RulesConfig;

beforeEach((): void => {
  baseline = createDefaultRulesConfig();
});

describe('the collapsing-vault relic declaration', () => {
  it('is published by the risk-reward-cursed family and found by id', () => {
    expect(RISK_REWARD_CURSED_FAMILY.name).toBe(FAMILY_NAME);

    const published = RISK_REWARD_CURSED_FAMILY.relics.filter(
      (relic: Relic): boolean => relic.id === RELIC_ID,
    );

    expect(published).toHaveLength(1);
    expect(findRelicById(RELIC_ID)).toBe(published[0]);
  });

  it('carries the id, name and rarity of the relic data shape', () => {
    const relic = relicUnderTest();

    expect(relic.id).toBe(RELIC_ID);
    expect(relic.name).toBe('Collapsing Vault');
    expect(relic.rarity).toBe(RARITIES[0]);
    expect(typeof relic.description).toBe('string');
    expect(relic.description.length).toBeGreaterThan(0);
  });

  it('binds onStageEnd and nothing else', () => {
    expect(Object.keys(relicUnderTest().hooks)).toEqual([BOUND_HOOK]);
  });

  it('binds a hook name drawn from HOOK_NAMES', () => {
    for (const name of Object.keys(relicUnderTest().hooks)) {
      expect(HOOK_NAMES).toContain(name);
    }
  });

  it('leaves every other hook name absent, not present and undefined', () => {
    const hooks = relicUnderTest().hooks;

    expect(UNBOUND_HOOKS).toHaveLength(HOOK_NAMES.length - 1);

    for (const name of UNBOUND_HOOKS) {
      expect(Object.prototype.hasOwnProperty.call(hooks, name)).toBe(false);
      expect(name in hooks).toBe(false);
    }
  });

  it('does not bind onBeforeMove, onMerge or onSpawn', () => {
    const hooks = relicUnderTest().hooks;

    expect('onBeforeMove' in hooks).toBe(false);
    expect('onMerge' in hooks).toBe(false);
    expect('onSpawn' in hooks).toBe(false);
  });

  it('binds every declared hook to a function', () => {
    const hooks = relicUnderTest().hooks;

    for (const name of Object.keys(hooks) as HookName[]) {
      expect(typeof hooks[name]).toBe('function');
    }

    expect(stageEndHandler()).toBe(hooks[BOUND_HOOK]);
  });

  it('writes the lattice through recorded commands, never a cells subscript',
    () => {
      expect(handlerSource()).not.toMatch(/cells\s*\[/u);
      expect(handlerSource()).toContain('moveTile');
      expect(handlerSource()).toContain('resizeBoard');
    });

  it('reads no clock, no Math.random and no console, and catches nothing',
    () => {
      const source = handlerSource();

      expect(source).not.toContain('Math.random');
      expect(source).not.toContain('Date.now');
      expect(source).not.toContain('console');
      expect(source).not.toContain('catch');
    });

  it('is dispatched with the run correlation identifier on its context', () => {
    const bench = stageBench(DEFAULT_BOARD_SIZE);
    const observed: string[] = [];

    bench.bus.register({
      id: `${RELIC_ID}-correlation-probe`,
      hooks: {
        onStageEnd: (
          _payload: StageEndPayload,
          context: HookContext,
        ): void => {
          observed.push(context.correlationId);
        },
      },
    });

    place(bench.grid, OUTER_SCENARIO);
    endStage(bench, true);

    expect(observed).toEqual([CORRELATION_ID]);
    expect(directDispatch(bench).context.correlationId).toBe(CORRELATION_ID);
  });
});

describe('collapsing-vault at onStageEnd moves both size declarations', () => {
  it('mutates Grid.size and config.boardSize to the same collapsed value',
    () => {
      const bench = stageBench(DEFAULT_BOARD_SIZE);

      place(bench.grid, OUTER_SCENARIO);
      endStage(bench, true);

      expect(bench.grid.size).toBe(SIZE_FLOOR);
      expect(bench.config.boardSize).toBe(SIZE_FLOOR);
      expect(bench.grid.size).toBe(bench.config.boardSize);
    });

  it('takes exactly one cell off each edge per cleared stage', () => {
    const bench = stageBench(DEFAULT_BOARD_SIZE);

    place(bench.grid, OUTER_SCENARIO);
    endStage(bench, true);

    expect(bench.grid.size).toBe(DEFAULT_BOARD_SIZE - SHRINK_STEP);
    expect(bench.config.boardSize).toBe(DEFAULT_BOARD_SIZE - SHRINK_STEP);
  });

  it('collapses one edge per dispatch down to the floor of 3', () => {
    const bench = stageBench(SIZE_FLOOR + 2 * SHRINK_STEP);
    const observed: number[] = [];

    for (let dispatch = 0; dispatch < 4; dispatch += 1) {
      endStage(bench, true, dispatch);
      observed.push(bench.grid.size);
      expect(bench.grid.size).toBe(bench.config.boardSize);
    }

    expect(observed).toEqual([
      ONE_ABOVE_FLOOR,
      SIZE_FLOOR,
      SIZE_FLOOR,
      SIZE_FLOOR,
    ]);
  });

  it('records nothing once the board already stands at the floor', () => {
    const bench = stageBench(SIZE_FLOOR);

    place(bench.grid, [{ x: 0, y: 0, value: 2 }]);

    const result = endStage(bench, true);

    expect(result.effectsApplied).toBe(0);
    expect(result.effectsRefused).toBe(0);
    expect(result.failed).toBe(0);
    expect(bench.grid.size).toBe(SIZE_FLOOR);
    expect(bench.config.boardSize).toBe(SIZE_FLOOR);
    expectCoherentLattice(bench.grid, SIZE_FLOOR);
  });

  it('never collapses a board below the floor of 3', () => {
    const bench = stageBench(ONE_ABOVE_FLOOR);

    for (let dispatch = 0; dispatch < 6; dispatch += 1) {
      endStage(bench, true, dispatch);
      expect(bench.grid.size).toBeGreaterThanOrEqual(SIZE_FLOOR);
      expect(bench.config.boardSize).toBeGreaterThanOrEqual(SIZE_FLOOR);
    }

    expect(bench.grid.size).toBe(SIZE_FLOOR);
    expect(bench.config.boardSize).toBe(SIZE_FLOOR);
  });

  it('changes neither declaration when the stage was not cleared', () => {
    const bench = stageBench(DEFAULT_BOARD_SIZE);

    place(bench.grid, OUTER_SCENARIO);

    const result = endStage(bench, false);

    expect(result.effectsApplied).toBe(0);
    expect(bench.grid.size).toBe(DEFAULT_BOARD_SIZE);
    expect(bench.config.boardSize).toBe(DEFAULT_BOARD_SIZE);
    expect(occupants(bench.grid)).toHaveLength(OUTER_SCENARIO.length);
  });

  it('leaves winValue, startTiles, spawn and merge exactly as configured',
    () => {
      const bench = stageBench(DEFAULT_BOARD_SIZE);

      place(bench.grid, OUTER_SCENARIO);
      endStage(bench, true);

      expect(bench.config.winValue).toBe(baseline.winValue);
      expect(bench.config.startTiles).toBe(baseline.startTiles);
      expect(bench.config.spawn.values).toEqual(baseline.spawn.values);
      expect(bench.config.spawn.weights).toEqual(baseline.spawn.weights);
      expect(bench.config.merge.canMerge).toBe(baseline.merge.canMerge);
      expect(bench.config.merge.produce).toBe(baseline.merge.produce);
    });

  it('carries the stage payload through unchanged', () => {
    const bench = stageBench(DEFAULT_BOARD_SIZE);

    place(bench.grid, OUTER_SCENARIO);

    const result = endStage(bench, true, 7);

    expect(result.payload).toEqual({
      stageIndex: 7,
      cleared: true,
      score: STAGE_SCORE,
    });
    expect(result.failed).toBe(0);
    expect(result.rejected).toBe(0);
    expect(result.invoked).toBe(1);
  });

  it('declares the collapsed edge length in its own state slot', () => {
    const bench = stageBench(DEFAULT_BOARD_SIZE);

    place(bench.grid, OUTER_SCENARIO);
    endStage(bench, true);

    expect(slotOf(bench)).toEqual({ boardSize: SIZE_FLOOR });
  });
});

/**
 * Reads the occupant standing in a cell.
 *
 * @param found Occupants to search.
 * @param cell Cell to read.
 * @returns The occupant there.
 * @throws {Error} If the cell stands empty.
 */
function occupantAt(found: readonly Occupant[], cell: Position): Occupant {
  const match = found.find(
    (occupant: Occupant): boolean =>
      occupant.x === cell.x && occupant.y === cell.y,
  );

  if (match === undefined) {
    throw new Error(`No tile stands at (${cell.x}, ${cell.y}).`);
  }

  return match;
}

/**
 * Reads where a given tile object ended up.
 *
 * @param found Occupants to search.
 * @param tile Tile object to locate.
 * @returns The occupant holding that tile.
 * @throws {Error} If the tile is no longer on the lattice.
 */
function survivorOf(found: readonly Occupant[], tile: Tile): Occupant {
  const match = found.find(
    (occupant: Occupant): boolean => occupant.tile === tile,
  );

  if (match === undefined) {
    throw new Error(
      `The tile of value ${tile.value} did not survive the collapse.`,
    );
  }

  return match;
}

describe('collapsing-vault re-homes or drops every out-of-range tile', () => {
  it('keeps every tile already inside the new bound at its cell and value',
    () => {
      const bench = stageBench(DEFAULT_BOARD_SIZE);

      place(bench.grid, OUTER_SCENARIO);

      const before = occupants(bench.grid);

      endStage(bench, true);

      const after = occupants(bench.grid);

      expect(KEPT_OCCUPANTS).toHaveLength(2);

      for (const kept of KEPT_OCCUPANTS) {
        const original = occupantAt(before, kept);
        const survivor = occupantAt(after, kept);

        expect(survivor.tile).toBe(original.tile);
        expect(survivor.value).toBe(kept.value);
        expect(survivor.tile.x).toBe(kept.x);
        expect(survivor.tile.y).toBe(kept.y);
      }
    });

  it('re-homes every out-of-range tile into a cell that stood free', () => {
    const bench = stageBench(DEFAULT_BOARD_SIZE);

    place(bench.grid, OUTER_SCENARIO);

    const before = occupants(bench.grid);
    const freeInsideBound = bench.grid
      .availableCells()
      .filter(
        (cell: Position): boolean =>
          cell.x < SIZE_FLOOR && cell.y < SIZE_FLOOR,
      );

    endStage(bench, true);

    const after = occupants(bench.grid);

    expect(EXILED_OCCUPANTS).toHaveLength(3);
    expect(freeInsideBound.length).toBeGreaterThanOrEqual(
      EXILED_OCCUPANTS.length,
    );

    for (const exile of EXILED_OCCUPANTS) {
      const original = occupantAt(before, exile);
      const survivor = survivorOf(after, original.tile);

      expect(survivor.value).toBe(exile.value);
      expect(survivor.x).toBeLessThan(SIZE_FLOOR);
      expect(survivor.y).toBeLessThan(SIZE_FLOOR);
      expect(bench.grid.withinBounds({ x: survivor.x, y: survivor.y })).toBe(
        true,
      );
      expect(
        freeInsideBound.some(
          (cell: Position): boolean =>
            cell.x === survivor.x && cell.y === survivor.y,
        ),
      ).toBe(true);
    }

    expect(after).toHaveLength(OUTER_SCENARIO.length);
  });

  it('leaves every survivor in bounds and matching its slot in grid.cells',
    () => {
      const bench = stageBench(DEFAULT_BOARD_SIZE);

      place(bench.grid, OUTER_SCENARIO);
      endStage(bench, true);

      expectCoherentLattice(bench.grid, SIZE_FLOOR);
      expect(occupants(bench.grid)).toHaveLength(OUTER_SCENARIO.length);
    });

  it('reshapes grid.cells to the new size, leaving no phantom column', () => {
    const bench = stageBench(DEFAULT_BOARD_SIZE);

    place(bench.grid, OUTER_SCENARIO);
    endStage(bench, true);

    expect(bench.grid.cells).toHaveLength(SIZE_FLOOR);

    for (let x = 0; x < SIZE_FLOOR; x += 1) {
      expect(bench.grid.cells[x]).toHaveLength(SIZE_FLOOR);
    }

    expect(bench.grid.cells[DEFAULT_BOARD_SIZE - 1]).toBeUndefined();
  });

  it('serialises the new size with a square matrix and null for each empty',
    () => {
      const bench = stageBench(DEFAULT_BOARD_SIZE);

      place(bench.grid, OUTER_SCENARIO);
      endStage(bench, true);

      const snapshot = bench.grid.serialize();
      let empties = 0;

      expect(snapshot.size).toBe(SIZE_FLOOR);
      expect(snapshot.cells).toHaveLength(SIZE_FLOOR);

      for (let x = 0; x < SIZE_FLOOR; x += 1) {
        expect(snapshot.cells[x]).toHaveLength(SIZE_FLOOR);

        for (let y = 0; y < SIZE_FLOOR; y += 1) {
          if (snapshot.cells[x][y] === null) {
            empties += 1;
          }
        }
      }

      expect(empties).toBe(SIZE_FLOOR * SIZE_FLOOR - OUTER_SCENARIO.length);
      expect(roundTrip(bench.grid)).toEqual(snapshot);
    });

  it('records where a re-homed tile came from and leaves a kept tile without ' +
    'a previous position',
    () => {
      const board = createBlockedBoard(DEFAULT_BOARD_SIZE);
      const bench = stageBench(DEFAULT_BOARD_SIZE, board.grid.cells);
      const exileCell: Position = { x: 0, y: DEFAULT_BOARD_SIZE - 1 };
      const before = occupants(bench.grid);
      const exiled = occupantAt(before, exileCell).tile;

      expect(before).toHaveLength(DEFAULT_BOARD_SIZE);

      for (const occupant of before) {
        expect(occupant.tile.previousPosition).toBeNull();
      }

      endStage(bench, true);

      const after = occupants(bench.grid);
      const survivor = survivorOf(after, exiled);

      expect(survivor.tile.previousPosition).toEqual(exileCell);
      expect(survivor.tile.x).toBe(survivor.x);
      expect(survivor.tile.y).toBe(survivor.y);
      expect(survivor.x).toBeLessThan(SIZE_FLOOR);
      expect(survivor.y).toBeLessThan(SIZE_FLOOR);

      for (const kept of [
        { x: 0, y: 0 },
        { x: 0, y: 1 },
        { x: 0, y: 2 },
      ]) {
        expect(occupantAt(after, kept).tile.previousPosition).toBeNull();
      }
    });

  it('introduces no mergedFrom pair, so nothing points off the new lattice',
    () => {
      const bench = stageBench(DEFAULT_BOARD_SIZE);

      place(bench.grid, OUTER_SCENARIO);
      endStage(bench, true);

      for (const survivor of occupants(bench.grid)) {
        expect(survivor.tile.mergedFrom).toBeNull();
      }

      expect(handlerSource()).not.toContain('mergedFrom');
    });

  it('drops what it cannot re-home when no cell inside the bound is free',
    () => {
      const board = createNearLossBoard(DEFAULT_BOARD_SIZE);
      const bench = stageBench(DEFAULT_BOARD_SIZE, board.grid.cells);

      expect(bench.grid.cellsAvailable()).toBe(false);
      expect(occupants(bench.grid)).toHaveLength(
        DEFAULT_BOARD_SIZE * DEFAULT_BOARD_SIZE,
      );

      const before = occupants(bench.grid);
      const result = endStage(bench, true);
      const after = occupants(bench.grid);

      expect(result.failed).toBe(0);
      expect(result.effectsRefused).toBe(0);
      expect(after).toHaveLength(SIZE_FLOOR * SIZE_FLOOR);
      expect(after.length).toBeLessThanOrEqual(SIZE_FLOOR * SIZE_FLOOR);
      expectCoherentLattice(bench.grid, SIZE_FLOOR);

      for (const survivor of after) {
        const original = occupantAt(before, survivor);

        expect(survivor.tile).toBe(original.tile);
        expect(survivor.value).toBe(original.value);
        expect(survivor.tile.previousPosition).toBeNull();
      }
    });
});

/** Win value the config-driven comparison is re-pointed at. */
const CUSTOM_WIN_VALUE = 512;

/** Face value `createNearWinBoard` places for `CUSTOM_WIN_VALUE`. */
const CUSTOM_WIN_TILE = CUSTOM_WIN_VALUE / 2;

describe('collapsing-vault leaves the win and loss checks on the new size',
  () => {
    it('reports no move available once the collapse leaves a full board with ' +
      'no equal neighbours',
      () => {
        const bench = stageBench(DEFAULT_BOARD_SIZE);

        fill(bench.grid, terminalScenarioValue);

        expect(bench.grid.cellsAvailable()).toBe(false);
        expect(tileMatchesAvailable(bench.grid, bench.config)).toBe(true);
        expect(movesAvailable(bench.grid, bench.config)).toBe(true);

        endStage(bench, true);

        expect(bench.grid.size).toBe(SIZE_FLOOR);
        expect(bench.config.boardSize).toBe(SIZE_FLOOR);
        expect(bench.grid.cellsAvailable()).toBe(false);
        expect(tileMatchesAvailable(bench.grid, bench.config)).toBe(false);
        expect(movesAvailable(bench.grid, bench.config)).toBe(false);
      });

    it('reports a move available when the collapsed board keeps an equal ' +
      'adjacent pair',
      () => {
        const board = createNearLossBoard(DEFAULT_BOARD_SIZE);
        const bench = stageBench(DEFAULT_BOARD_SIZE, board.grid.cells);

        endStage(bench, true);

        expect(bench.grid.size).toBe(SIZE_FLOOR);
        expect(bench.grid.cellsAvailable()).toBe(false);
        expect(tileMatchesAvailable(bench.grid, bench.config)).toBe(true);
        expect(movesAvailable(bench.grid, bench.config)).toBe(true);
      });

    it('short-circuits on an empty cell of the collapsed lattice', () => {
      const bench = stageBench(DEFAULT_BOARD_SIZE);

      place(bench.grid, OUTER_SCENARIO);
      endStage(bench, true);

      expect(bench.grid.availableCells()).toHaveLength(
        SIZE_FLOOR * SIZE_FLOOR - OUTER_SCENARIO.length,
      );
      expect(bench.grid.cellsAvailable()).toBe(true);
      expect(movesAvailable(bench.grid, bench.config)).toBe(true);
    });

    it('keeps hasReachedWinValue true when the winning tile stands inside ' +
      'the bound',
      () => {
        const bench = stageBench(DEFAULT_BOARD_SIZE);

        place(bench.grid, [{ x: 0, y: 0, value: bench.config.winValue }]);

        expect(hasReachedWinValue(bench.grid, bench.config)).toBe(true);

        endStage(bench, true);

        expect(bench.grid.size).toBe(SIZE_FLOOR);
        expect(hasReachedWinValue(bench.grid, bench.config)).toBe(true);
        expect(bench.config.winValue).toBe(baseline.winValue);
      });

    it('reports hasReachedWinValue false once the collapse drops the only ' +
      'winning tile',
      () => {
        const bench = stageBench(DEFAULT_BOARD_SIZE);

        fillWithCornerWinner(bench.grid, bench.config.winValue);

        expect(hasReachedWinValue(bench.grid, bench.config)).toBe(true);

        endStage(bench, true);

        expect(bench.grid.size).toBe(SIZE_FLOOR);
        expect(hasReachedWinValue(bench.grid, bench.config)).toBe(false);
        expect(bench.config.winValue).toBe(baseline.winValue);
      });

    it('compares against config.winValue rather than a captured constant',
      () => {
        const board = createNearWinBoard(
          DEFAULT_BOARD_SIZE,
          CUSTOM_WIN_VALUE,
        );
        const bench = stageBench(DEFAULT_BOARD_SIZE, board.grid.cells);

        expect(occupantAt(occupants(bench.grid), { x: 0, y: 0 }).value).toBe(
          CUSTOM_WIN_TILE,
        );
        expect(hasReachedWinValue(bench.grid, bench.config)).toBe(false);

        bench.config.winValue = CUSTOM_WIN_TILE;

        expect(hasReachedWinValue(bench.grid, bench.config)).toBe(true);

        endStage(bench, true);

        expect(bench.grid.size).toBe(SIZE_FLOOR);
        expect(bench.config.winValue).toBe(CUSTOM_WIN_TILE);
        expect(hasReachedWinValue(bench.grid, bench.config)).toBe(true);
      });
  });

/** A board with exactly one occupant outside the collapsed bound. */
const SINGLE_EXILE: readonly Placement[] = [
  { x: 0, y: 0, value: 2 },
  { x: DEFAULT_BOARD_SIZE - 1, y: DEFAULT_BOARD_SIZE - 1, value: 8 },
];

/**
 * Builds a stage-end payload.
 *
 * @param cleared Whether the stage was cleared.
 * @param stageIndex Stage ordinal.
 * @returns The payload.
 */
function stageEndPayload(cleared: boolean, stageIndex = 0): StageEndPayload {
  return { stageIndex, cleared, score: STAGE_SCORE };
}

describe('collapsing-vault carries no charge budget and consults none', () => {
  it('declares charges absent rather than null', () => {
    const relic = relicUnderTest();

    expect(Object.prototype.hasOwnProperty.call(relic, 'charges')).toBe(false);
    expect('charges' in relic).toBe(false);
    expect(relic.charges).toBeUndefined();
  });

  it('names neither charges nor spendCharge in its handler', () => {
    const source = handlerSource();

    expect(source).not.toContain('charges');
    expect(source).not.toContain('spendCharge');
  });

  it('asks for no charge when invoked with no budget', () => {
    const bench = stageBench(DEFAULT_BOARD_SIZE);

    place(bench.grid, SINGLE_EXILE);

    const direct = directDispatch(bench);

    stageEndHandler()(stageEndPayload(true), direct.context);

    expect(direct.spendRequests()).toEqual([]);
    expect(direct.commands()).toHaveLength(2);
  });

  it('spends no charge through the bus', () => {
    const bench = stageBench(DEFAULT_BOARD_SIZE);

    place(bench.grid, SINGLE_EXILE);

    const result = endStage(bench, true);

    expect(result.chargesConsumed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.invoked).toBe(1);
  });

  it('records the same commands with a zero budget as with none', () => {
    const withBudget = stageBench(DEFAULT_BOARD_SIZE);
    const withoutBudget = stageBench(DEFAULT_BOARD_SIZE);

    place(withBudget.grid, SINGLE_EXILE);
    place(withoutBudget.grid, SINGLE_EXILE);

    const zero = directDispatch(withBudget, 0);
    const none = directDispatch(withoutBudget);

    stageEndHandler()(stageEndPayload(true), zero.context);
    stageEndHandler()(stageEndPayload(true), none.context);

    expect(zero.context.charges).toBe(0);
    expect(none.context.charges).toBeUndefined();
    expect(zero.commands()).toEqual(none.commands());
    expect(zero.spendRequests()).toEqual([]);
    expect(none.spendRequests()).toEqual([]);
  });

  it('throws nothing and corrupts nothing when invoked with zero charges',
    () => {
      const bench = stageBench(DEFAULT_BOARD_SIZE);

      place(bench.grid, SINGLE_EXILE);

      const direct = directDispatch(bench, 0);

      expect((): void => {
        stageEndHandler()(stageEndPayload(true), direct.context);
      }).not.toThrow();

      expect(bench.grid.size).toBe(bench.config.boardSize);
      expect(bench.grid.size).toBe(DEFAULT_BOARD_SIZE);
      expect(bench.config.boardSize).toBeGreaterThanOrEqual(SIZE_FLOOR);
      expectCoherentLattice(bench.grid, DEFAULT_BOARD_SIZE);
      expect(occupants(bench.grid)).toHaveLength(SINGLE_EXILE.length);
      expect(direct.context.state).toEqual({ boardSize: SIZE_FLOOR });
      expect(relicUnderTest().state).toEqual({});
    });
});

describe('collapsing-vault collapses deterministically from one substream',
  () => {
    it('produces an identical board from two stream sets built on one seed',
      () => {
        const first = stageBench(DEFAULT_BOARD_SIZE, undefined, SEED);
        const second = stageBench(DEFAULT_BOARD_SIZE, undefined, SEED);

        place(first.grid, OUTER_SCENARIO);
        place(second.grid, OUTER_SCENARIO);
        endStage(first, true);
        endStage(second, true);

        expect(second.grid.serialize()).toEqual(first.grid.serialize());
        expect(second.config.boardSize).toBe(first.config.boardSize);
        expect(second.streams.snapshotCursors()).toEqual(
          first.streams.snapshotCursors(),
        );
        expect(slotOf(second)).toEqual(slotOf(first));
      });

    it('re-homes to different cells under a different seed', () => {
      const first = stageBench(DEFAULT_BOARD_SIZE, undefined, SEED);
      const other = stageBench(DEFAULT_BOARD_SIZE, undefined, OTHER_SEED);

      place(first.grid, OUTER_SCENARIO);
      place(other.grid, OUTER_SCENARIO);
      endStage(first, true);
      endStage(other, true);

      expect(other.grid.size).toBe(first.grid.size);
      expect(other.grid.serialize()).not.toEqual(first.grid.serialize());
    });

    it('leaves the spawn and rarity cursors exactly where they stood', () => {
      const bench = stageBench(DEFAULT_BOARD_SIZE);

      place(bench.grid, OUTER_SCENARIO);

      const before = bench.streams.snapshotCursors();

      endStage(bench, true);

      const delta = cursorDelta(before, bench.streams.snapshotCursors());

      expect(UNTOUCHED_STREAMS).toHaveLength(RNG_STREAM_NAMES.length - 1);

      for (const name of UNTOUCHED_STREAMS) {
        expect(delta[name]).toBe(0);
      }
    });

    it('advances the relic-draw cursor once per re-homed tile', () => {
      const bench = stageBench(DEFAULT_BOARD_SIZE);

      place(bench.grid, OUTER_SCENARIO);

      const before = bench.streams.snapshotCursors();

      endStage(bench, true);

      const delta = cursorDelta(before, bench.streams.snapshotCursors());

      expect(delta[REHOME_STREAM]).toBe(EXILED_OCCUPANTS.length);
    });

    it('advances no cursor when the stage was not cleared', () => {
      const bench = stageBench(DEFAULT_BOARD_SIZE);

      place(bench.grid, OUTER_SCENARIO);

      const before = bench.streams.snapshotCursors();

      endStage(bench, false);

      expect(bench.streams.snapshotCursors()).toEqual(before);
    });

    it('advances no cursor when no cell inside the bound stands free', () => {
      const board = createNearLossBoard(DEFAULT_BOARD_SIZE);
      const bench = stageBench(DEFAULT_BOARD_SIZE, board.grid.cells);
      const before = bench.streams.snapshotCursors();

      endStage(bench, true);

      expect(bench.grid.size).toBe(SIZE_FLOOR);
      expect(bench.streams.snapshotCursors()).toEqual(before);
    });

    it('advances no cursor once the board already stands at the floor', () => {
      const bench = stageBench(SIZE_FLOOR);

      place(bench.grid, [{ x: 0, y: 0, value: 2 }]);

      const before = bench.streams.snapshotCursors();

      endStage(bench, true);

      expect(bench.streams.snapshotCursors()).toEqual(before);
    });

    it('records the destination the bus goes on to apply, on one seed', () => {
      const recorded = stageBench(DEFAULT_BOARD_SIZE, undefined, SEED);
      const applied = stageBench(DEFAULT_BOARD_SIZE, undefined, SEED);

      place(recorded.grid, SINGLE_EXILE);
      place(applied.grid, SINGLE_EXILE);

      const direct = directDispatch(recorded);

      stageEndHandler()(stageEndPayload(true), direct.context);

      const result = endStage(applied, true);

      expect(direct.commands()).toEqual(result.effects);
      expect(result.effectsApplied).toBe(2);
    });
  });

describe('the collapsing-vault suite leaves no shared state behind', () => {
  it('reads a freshly built config that still opens at the default size',
    () => {
      expect(baseline.boardSize).toBe(DEFAULT_BOARD_SIZE);
      expect(createDefaultRulesConfig().boardSize).toBe(DEFAULT_BOARD_SIZE);
      expect(DEFAULT_BOARD_SIZE).toBe(4);
    });

  it('leaves the catalogue relic and its hook table unmutated', () => {
    const relic = relicUnderTest();

    expect(relic.id).toBe(RELIC_ID);
    expect(relic.name).toBe('Collapsing Vault');
    expect(relic.rarity).toBe(RARITIES[0]);
    expect(relic.state).toEqual({});
    expect(Object.keys(relic.hooks)).toEqual([BOUND_HOOK]);
    expect(Object.prototype.hasOwnProperty.call(relic, 'charges')).toBe(false);
    expect(findRelicById(RELIC_ID)).toBe(relic);
    expect(RISK_REWARD_CURSED_FAMILY.relics).toContain(relic);
  });

  it('collapses two benches to the same board, the second not reading the ' +
    'first',
    () => {
      const first = stageBench(DEFAULT_BOARD_SIZE);

      place(first.grid, OUTER_SCENARIO);
      endStage(first, true);

      const firstBoard = first.grid.serialize();
      const firstSlot = slotOf(first);
      const second = stageBench(DEFAULT_BOARD_SIZE);

      place(second.grid, OUTER_SCENARIO);
      endStage(second, true);

      expect(second.grid.serialize()).toEqual(firstBoard);
      expect(slotOf(second)).toEqual(firstSlot);
      expect(second.config.boardSize).toBe(first.config.boardSize);
      expect(slotOf(first)).toEqual(firstSlot);
    });
});

/* ==========================================================================
 * The terminal verdict the collapse leaves behind
 *
 * Every section above dispatches `onStageEnd` on a bus and asserts what the
 * handler did to the lattice. None of them asks what the ENGINE then published,
 * and that is where the defect lived: `Engine.endStage()` applied the stage-end
 * board commands and committed without re-deriving the loss flag, so a collapse
 * that left a full board with no adjacent match published `over: false` and the
 * run carried a stale playable verdict into its reward screen and its next stage.
 *
 * These cases therefore drive a real `Engine` and read the verdict off the
 * commit, not off the handler. The board is a nine-tile arrangement in which no
 * two orthogonal neighbours are equal, so at the collapsed edge length it is
 * full and unplayable — the exact state the stale verdict misreported.
 *
 * Decisions: DL-RISK-01, DL-ENGINE-15.
 * ========================================================================== */

/**
 * Nine cells filling a 3x3 lattice with no two orthogonal neighbours equal, so
 * the default merge rule finds no match anywhere on it.
 */
const NO_MATCH_AT_FLOOR: readonly { x: number; y: number; value: number }[] =
  Object.freeze([
    { x: 0, y: 0, value: 2 },
    { x: 1, y: 0, value: 8 },
    { x: 2, y: 0, value: 32 },
    { x: 0, y: 1, value: 128 },
    { x: 1, y: 1, value: 512 },
    { x: 2, y: 1, value: 2048 },
    { x: 0, y: 2, value: 4 },
    { x: 1, y: 2, value: 16 },
    { x: 2, y: 2, value: 64 },
  ]);

/** One tile outside the collapsed bound, so the collapse has work to do. */
const OUTSIDE_THE_BOUND = Object.freeze({ x: 3, y: 3, value: 2 });

/**
 * A board snapshot from a sparse list of occupied cells.
 *
 * @param size Edge length.
 * @param occupied Cells to fill.
 * @returns The snapshot, empty cells kept as `null`.
 */
function verdictBoard(
  size: number,
  occupied: readonly { x: number; y: number; value: number }[],
): SerializedGameState {
  const cells: (SerializedTile | null)[][] = [];

  for (let x = 0; x < size; x += 1) {
    const column: (SerializedTile | null)[] = [];

    for (let y = 0; y < size; y += 1) {
      const found = occupied.find((cell) => cell.x === x && cell.y === y);

      column.push(
        found === undefined ? null : { position: { x, y }, value: found.value },
      );
    }

    cells.push(column);
  }

  return {
    grid: { size, cells },
    score: 0,
    over: false,
    won: false,
    keepPlaying: false,
  };
}

/** A run composed as src/main.ts composes it, holding the relic under test. */
interface VerdictRun {
  readonly config: RulesConfig;
  readonly engine: Engine;
  readonly commits: StateCommitEvent[];
}

/**
 * Composes engine, bus and registry with the relic held, and opens `board`.
 *
 * @param board Snapshot the stage opens on.
 * @returns The composed run and the commits it emits from here on.
 */
function composeVerdictRun(board: SerializedGameState): VerdictRun {
  const live = createDefaultRulesConfig();
  const bus = createHookBus({ correlationId: CORRELATION_ID });
  const registry = new RelicRegistry({
    bus,
    catalogue: RISK_REWARD_CURSED_FAMILY.relics,
  });

  expect(registry.pickUp(RELIC_ID)).not.toBeUndefined();

  const engine = new Engine({
    config: live,
    stages: createDefaultStageConfig(),
    streams: createRngStreams(SEED),
    hooks: bus,
    relicContext: registry.commitContextProvider(),
  });

  engine.setup(board);

  const commits: StateCommitEvent[] = [];

  engine.events.on('state:commit', (event): void => {
    commits.push(event);
  });

  return { config: live, engine, commits };
}

describe('the terminal verdict a collapse leaves on the committed board', () => {
  it('publishes over on a collapse that left no move available', () => {
    const run = composeVerdictRun(
      verdictBoard(DEFAULT_BOARD_SIZE, [
        ...NO_MATCH_AT_FLOOR,
        OUTSIDE_THE_BOUND,
      ]),
    );

    // The board is playable before the collapse: the tile outside the bound has
    // room to move, so nothing here starts out terminal.
    expect(run.engine.serialize().over).toBe(false);

    run.engine.endStage(true);

    const committed = run.engine.serialize();

    // The collapse landed.
    expect(committed.grid.size).toBe(SIZE_FLOOR);
    expect(run.config.boardSize).toBe(SIZE_FLOOR);

    // And the verdict describes the board the collapse produced, not the board
    // it replaced. Both readings are asserted, because the defect was exactly a
    // disagreement between them.
    expect(
      movesAvailable(
        new Grid(committed.grid.size, committed.grid.cells),
        run.config,
      ),
    ).toBe(false);
    expect(committed.over).toBe(true);

    // The commit a subscriber received carries the same verdict, so a view and
    // the run envelope cannot read a playable board off a terminal one.
    expect(run.commits.at(-1)?.over).toBe(true);
  });

  it('leaves a playable collapse playable', () => {
    const run = composeVerdictRun(
      verdictBoard(DEFAULT_BOARD_SIZE, [
        { x: 0, y: 0, value: 2 },
        { x: 1, y: 0, value: 2 },
        OUTSIDE_THE_BOUND,
      ]),
    );

    run.engine.endStage(true);

    const committed = run.engine.serialize();

    expect(committed.grid.size).toBe(SIZE_FLOOR);
    expect(
      movesAvailable(
        new Grid(committed.grid.size, committed.grid.cells),
        run.config,
      ),
    ).toBe(true);
    expect(committed.over).toBe(false);
  });

  it('agrees with the loss probe on every collapse it makes', () => {
    for (const occupied of [
      [...NO_MATCH_AT_FLOOR, OUTSIDE_THE_BOUND],
      [...NO_MATCH_AT_FLOOR.slice(0, 8), OUTSIDE_THE_BOUND],
      [{ x: 3, y: 0, value: 4 }, { x: 3, y: 1, value: 4 }],
    ]) {
      const run = composeVerdictRun(verdictBoard(DEFAULT_BOARD_SIZE, occupied));

      run.engine.endStage(true);

      const committed = run.engine.serialize();
      const probe = movesAvailable(
        new Grid(committed.grid.size, committed.grid.cells),
        run.config,
      );

      // The invariant, stated once and asserted for every collapse: the
      // published flag is the negation of the probe on the board it published.
      expect(committed.over).toBe(!probe);
    }
  });
});
