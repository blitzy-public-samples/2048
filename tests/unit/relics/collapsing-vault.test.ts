// Unit suite for the `collapsing-vault` relic of the `risk-reward-cursed`
// family, declared in src/relics/families/risk-reward-cursed.ts. Three
// properties are proved: the hooks it binds, the collapse it applies, and its
// charge surface. AAP Group 5.
//
// The reload half of the board-size edge case — `reconcileBoardSize` and a
// save/load round trip — is asserted by the sibling suite
// tests/unit/relics/board-mutation.test.ts and is not repeated here. This suite
// asserts the relic's immediate, in-memory effect.
//
// PROVENANCE OF THE ANCHORS THIS SUITE ASSERTS AGAINST
//   js/grid.js L89-L91   `insertTile` wrote `cells[tile.x][tile.y] = tile`, so
//                        a tile's own x/y and its slot in the matrix are one
//                        fact; L93-L95 `removeTile` cleared that same slot.
//   js/grid.js L97-L100  `withinBounds` compared a position against
//                        `this.size`, the lattice's own field.
//   js/grid.js L102-L117 `serialize` reported `size` and kept `null` for an
//                        empty cell rather than omitting or compacting it.
//   js/tile.js L10-L12   `savePosition` copied the current x/y into a fresh
//                        `previousPosition` object; L14-L17 `updatePosition`
//                        wrote x/y alone and left `previousPosition` standing.
//   js/game_manager.js L238-L240  `movesAvailable` was
//                        `cellsAvailable() || tileMatchesAvailable()`, and
//                        L243-L268 bounded the neighbour probe by `this.size`
//                        at L248-L249.
//   js/application.js L3 carried the board dimension as the literal `4`. The
//                        vanilla product declared that dimension in three
//                        independent places — that literal, the Sass variable
//                        `$grid-row-cells`, and sixteen static `.grid-cell`
//                        elements — and reconciled none of them. One
//                        configured value now drives all three.
//   CONTRIBUTING.md L27  listed changes to the grid size among changes that
//                        might not be accepted, superseded by the design-freeze
//                        entry of docs/DECISION_LOG.md.
//
// Rationale for every choice named here lives in docs/DECISION_LOG.md, which
// is the single source of truth for "why": DL-RISK-01 and DL-RISK-02 are the
// entries src/relics/families/risk-reward-cursed.ts declares for this relic.
//
// Traceability rows of docs/TRACEABILITY_MATRIX.md this suite evidences:
// TR-RISK-01, the relic's own row; the board-dimension consolidation
// (js/application.js L3 to src/config/**); js/grid.js L89-L100; and
// js/game_manager.js L238-L268. The command queue the handler records through
// carries its own rows, TR-EFFECT-01 through TR-EFFECT-03.
//
// Figures this dispatch sits inside, per Rule 2: Figure 4, "Turn Data Flow:
// From Keystroke to Composited Frame and Persisted Run State"
// (docs/architecture/data-flow.md), whose `onStageEnd dispatch` node is where
// the relic runs and whose `Moves available?` node the terminal-state block
// below asserts against; and Figure 6, "Screen Flow State Machine", whose
// `StageClear -> Reward` transition the same dispatch drives.
//
// TWO HARNESSES, each measuring a different thing.
//   `stageBench` dispatches through the real src/engine/hook-bus.ts, which
//   applies the commands the handler records. Every assertion about the
//   lattice, the rules and the substream cursors runs through it.
//   `directDispatch` invokes the handler with a `HookContext` assembled in this
//   file over a recording queue that applies nothing. The zero-budget
//   invocation runs through it.
//
// The context both harnesses build carries the run correlation identifier, so
// the correlation plumbing is exercised end to end. Nothing here reads a DOM,
// `Math.random`, a clock or a timer, and nothing here writes a snapshot file.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_BOARD_SIZE,
  createDefaultRulesConfig,
} from '../../../src/config/default-config';
import type {
  MergePredicate,
  RulesConfig,
} from '../../../src/config/rules-config';
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
import { findRelicById } from '../../../src/relics/relic-registry';
import { RARITIES } from '../../../src/relics/relic-types';
import type { Relic } from '../../../src/relics/relic-types';
import {
  createBlockedBoard,
  createNearLossBoard,
  createNearWinBoard,
} from '../../fixtures/boards';

/* ==========================================================================
 * Constants
 * ========================================================================== */

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

/* ==========================================================================
 * The unit under test
 * ========================================================================== */

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

/* ==========================================================================
 * Harness 1: dispatch through the real hook bus
 *
 * The handler records commands on `HookContext.effects`; the bus applies them
 * once the handler has returned and its return has validated. A bench
 * therefore carries the live rules and the live lattice both commands write.
 * ========================================================================== */

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
 * @param cells Serialised cell matrix, read as `cells[x][y]`. `Grid.fromState`
 *   indexes the matrix itself, so a fixture is passed as `board.grid.cells`
 *   rather than as the whole board.
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

/* ==========================================================================
 * Lattice helpers
 * ========================================================================== */

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
 * Lists the lattice's occupants, x-outer and y-inner — the order
 * js/grid.js L58-L64 walked cells in.
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
 * rebuild. The two are equal for a coherent lattice: `Grid.fromState` reads the
 * matrix `Grid.serialize` writes, `null` empties included
 * (js/grid.js L102-L117).
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

/* ==========================================================================
 * Harness 2: direct invocation over a recording queue
 *
 * The queue below satisfies `BoardEffectQueue` and RECORDS every command it
 * accepts without writing the lattice or the rules, so a direct invocation
 * leaves the board and the config exactly as they stood. Its five query members
 * read the LIVE lattice rather than a projection of the recorded commands, so
 * the boards passed to this harness carry at most one cell outside the next
 * bound and a projection cannot change what is recorded.
 * ========================================================================== */

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
 * Assembles a `HookContext` by hand over a bench, so the handler can be invoked
 * with a charge budget the bus would have guarded on.
 *
 * `RulesConfig` satisfies `ReadonlyRulesView` and `RngStreams` satisfies
 * `ReadonlyRngView` structurally; the lattice is reached through
 * `createReadonlyGridView`, the same facade the bus builds.
 *
 * @param bench Bench supplying the rules, the substreams and the lattice.
 * @param charges Charge budget the context declares. Absent by default, which
 *   is the budget the relic's own registration carries.
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

/* ==========================================================================
 * Scenario boards
 * ========================================================================== */

/**
 * Occupants at edge length 4 for the main re-homing scenario: two cells inside
 * the collapsed bound, and three outside it — one on the outermost column,
 * one on the outermost row, and one on their corner.
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
 * Face value of the collapse-terminal scenario: a strict doubling ladder inside
 * the collapsed bound, where no two orthogonal neighbours are equal, and one
 * repeated value across the band the collapse drops.
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

/* ==========================================================================
 * Shared per-test state
 * ========================================================================== */

/**
 * A default config rebuilt before every test. The relic writes `boardSize`, so
 * each test reads its untouched members from this rather than from a shared
 * singleton, and the closing block asserts this one still opens at the
 * configured edge length.
 */
let baseline: RulesConfig;

beforeEach((): void => {
  baseline = createDefaultRulesConfig();
});

/* ==========================================================================
 * 1. The relic declaration
 * ========================================================================== */

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

/* ==========================================================================
 * 2. Both board-size declarations move together
 *
 * The crux of the suite. js/grid.js L97-L100 tested `withinBounds` against the
 * lattice's own `size`, while the configured dimension lived elsewhere
 * (js/application.js L3). A collapse that moved one and not the other would be
 * silent.
 * ========================================================================== */

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

/* ==========================================================================
 * 3. Out-of-range tiles are re-homed or dropped, never orphaned
 * ========================================================================== */

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

/* ==========================================================================
 * 4. The win and loss checks resolve at the collapsed size
 *
 * js/game_manager.js L238-L240 read
 * `cellsAvailable() || tileMatchesAvailable()` and L248-L249 bounded the probe
 * by `this.size`. The exported checks of src/engine/terminal-state.ts are
 * called here rather than re-implemented.
 * ========================================================================== */

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

/* ==========================================================================
 * 5. Charges: none declared, none consulted, none required
 *
 * The guard and the decrement both belong to src/engine/hook-bus.ts, whose own
 * suites under tests/unit/engine own the mechanism. Asserted here: this relic
 * neither declares a budget nor reads one.
 * ========================================================================== */

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

/* ==========================================================================
 * 6. Determinism and substream hygiene
 *
 * The handler draws its re-homing destinations from the `relic-draw` substream,
 * so the same seed must land the same tiles in the same cells. The three other
 * substreams belong to the engine's spawns and to the rarity weighting and are
 * never touched here.
 * ========================================================================== */

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

/* ==========================================================================
 * 7. Nothing shared is left behind
 * ========================================================================== */

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
