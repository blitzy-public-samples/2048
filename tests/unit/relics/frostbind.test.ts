// Per-relic isolation suite for the `merge-magic` relic `frostbind`.
//
// PROVENANCE
//   js/game_manager.js L156 — `next && next.value === tile.value &&
//   !next.mergedFrom` — is the merge predicate this relic wraps. It ports to
//   `RulesConfig.merge.canMerge` of src/config/rules-config.ts and to
//   `defaultCanMerge` of src/config/default-config.ts, which is the
//   traceability row this suite evidences. The `!next.mergedFrom` half is what
//   holds one merger per traversal; the `next &&` existence guard stayed
//   OUTSIDE the predicate, in src/engine/move-resolver.ts.
//
//   AAP working assumption A2 places the charge-based freeze and thaw relic in
//   `merge-magic` rather than in `board-manipulation`.
//
//   Figure 5, "Hook Dispatch Sequence: Pickup-Order Fan-Out with Charge Guard
//   and Error Isolation" (docs/architecture/hook-dispatch-sequence.md), is the
//   diagram this suite is the executable counterpart of: its legend records
//   that the charge guard is implemented once in the bus rather than sixteen
//   times in handlers. Figure 4, "Turn Data Flow"
//   (docs/architecture/data-flow.md), carries the `Merge condition from
//   config.merge.canMerge` decision node this relic wraps.
//
//   docs/DECISION_LOG.md holds every decision; DL-MERGE-01 and DL-MERGE-02
//   name the family module's own.
//
// WHAT THIS SUITE HOLDS
//   The three mandatory per-relic properties, plus the two catalogue-level
//   invariants this relic is the only one to exercise:
//     1. it fires on its bound hooks alone;
//     2. its `onMerge` handler returns nothing, and the bus therefore keeps
//        the incoming payload — one void-returning handler in the catalogue;
//     3. it records the frozen-cell merge predicate, freezing and thawing a
//        cell without losing the base rule's semantics;
//     4. it is one of five charge-bearing relics, its handlers hold no charge
//        guard of their own, and a direct invocation at zero and at negative
//        charges neither throws nor corrupts run state;
//     5. it consumes no randomness.
//
// WHAT THIS SUITE DOES NOT HOLD
//   The `HookBus` mechanism itself — pickup-order dispatch, the charge guard,
//   error isolation and the compounding protocol — belong to the suites under
//   tests/unit/engine, which drive it with synthetic handlers. The bus appears
//   here only as the vehicle carrying the real handler's return and its
//   recorded effect, and neither suite duplicates the other.
//
// This suite reads no DOM, no storage and no clock, calls no `Math.random`,
// installs no timer and no mock library, and runs under the `test` script with
// no server, browser or network.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  createDefaultRulesConfig,
  defaultCanMerge,
  defaultProduceMergeValue,
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
import type { HookBus } from '../../../src/engine/hook-bus';
import { HOOK_NAMES } from '../../../src/engine/hooks';
import type {
  BoardEffect,
  BoardEffectQueue,
  HookContext,
  HookDispatchPayloadMap,
  HookEnvironment,
  HookHandler,
  HookName,
  MergePayload,
  StageStartPayload,
} from '../../../src/engine/hooks';
import { Tile } from '../../../src/engine/tile';
import { NOOP_ENGINE_REPORTER } from '../../../src/engine/types';
import type { CorrelationId, Position } from '../../../src/engine/types';
import { MERGE_MAGIC_FAMILY } from '../../../src/relics/families/merge-magic';
import {
  RELIC_CATALOGUE,
  RelicRegistry,
  findRelicById,
} from '../../../src/relics/relic-registry';
import type { Relic } from '../../../src/relics/relic-types';
import {
  RNG_STREAM_NAMES,
  createRngStreams,
} from '../../../src/rng/rng-streams';
import type { RngCursorMap, RngStreams } from '../../../src/rng/rng-streams';
import {
  createBlockedBoard,
  createMergePairBoard,
} from '../../fixtures/boards';

/* ==========================================================================
 * Fixtures
 * ========================================================================== */

/** Identifier the family module declares for the unit under test. */
const RELIC_ID = 'frostbind';

/** Fixed literal run seed: no draw here is allowed to vary between runs. */
const SEED = 'frostbind-suite-seed';

/** Run correlation identifier carried on every context this suite builds. */
const CORRELATION_ID: CorrelationId = 'run-frostbind-suite';

/** How many relics of the sixteen declare a charge budget. */
const CHARGE_BEARING_RELICS = 5;

/** Cell a merge lands on in the payloads below: the frost destination. */
const DESTINATION: Position = { x: 0, y: 0 };

/** Cell the moving tile of those payloads starts in. */
const ORIGIN: Position = { x: 1, y: 0 };

/** Face value of both merge operands, which `defaultCanMerge` accepts. */
const OPERAND_VALUE = 2;

/* ==========================================================================
 * The unit under test, resolved two ways
 * ========================================================================== */

/**
 * The relic as the family module declares it, reached through
 * `MERGE_MAGIC_FAMILY.relics` by identifier.
 *
 * @returns The declaration.
 */
function declaredRelic(): Relic {
  const found = MERGE_MAGIC_FAMILY.relics.find(
    (entry) => entry.id === RELIC_ID,
  );

  expect(
    found,
    `the merge-magic family declares a relic with id ${RELIC_ID}`,
  ).toBeDefined();

  return found as Relic;
}

/**
 * The same relic reached through the flattened catalogue, so a rename that
 * left the family intact but broke the index still fails.
 *
 * @returns The declaration.
 */
function catalogueRelic(): Relic {
  const found = findRelicById(RELIC_ID);

  expect(
    found,
    `the catalogue index resolves ${RELIC_ID}`,
  ).toBeDefined();

  return found as Relic;
}

/**
 * The relic's `onMerge` handler.
 *
 * @returns The bound handler.
 */
function mergeHandler(): HookHandler<'onMerge'> {
  const bound = declaredRelic().hooks.onMerge;

  expect(bound, `${RELIC_ID} binds onMerge`).toBeTypeOf('function');

  return bound as HookHandler<'onMerge'>;
}

/**
 * The relic's `onStageStart` handler.
 *
 * @returns The bound handler.
 */
function stageStartHandler(): HookHandler<'onStageStart'> {
  const bound = declaredRelic().hooks.onStageStart;

  expect(bound, `${RELIC_ID} binds onStageStart`).toBeTypeOf('function');

  return bound as HookHandler<'onStageStart'>;
}

/**
 * The declaration as it stood when this module loaded, read once and compared
 * against at the end of the suite.
 */
const DECLARED_AT_LOAD = Object.freeze({
  id: declaredRelic().id,
  name: declaredRelic().name,
  rarity: declaredRelic().rarity,
  description: declaredRelic().description,
  charges: declaredRelic().charges,
  hookNames: Object.freeze(Object.keys(declaredRelic().hooks)),
  onMerge: declaredRelic().hooks.onMerge,
  onStageStart: declaredRelic().hooks.onStageStart,
  state: declaredRelic().state,
});

/* ==========================================================================
 * Payload builders
 * ========================================================================== */

/**
 * A merge dispatch payload over real tiles, which is what
 * src/engine/move-resolver.ts dispatches: the bus projects each tile into the
 * frozen view a handler reads.
 *
 * @param destination Cell the merge resolves onto.
 * @returns The dispatch payload and the two tiles it carries.
 */
function mergeDispatch(destination: Position = DESTINATION): {
  readonly payload: HookDispatchPayloadMap['onMerge'];
  readonly source: Tile;
  readonly target: Tile;
} {
  const source = new Tile(ORIGIN, OPERAND_VALUE);
  const target = new Tile(destination, OPERAND_VALUE);

  // js/game_manager.js L167 added the produced value to the score, so the two
  // payload members are dispatched equal, as src/engine/move-resolver.ts does.
  const produced = defaultProduceMergeValue(source, target);

  return {
    payload: { source, target, resultValue: produced, scoreDelta: produced },
    source,
    target,
  };
}

/**
 * A handler-facing merge payload over real tiles, for a direct invocation that
 * does not go through the bus. `Tile` satisfies `ReadonlyTileView`
 * structurally, which is the shape the bus would otherwise project.
 *
 * @param destination Cell the merge resolves onto.
 * @returns The payload.
 */
function mergePayload(destination: Position = DESTINATION): MergePayload {
  const source = new Tile(ORIGIN, OPERAND_VALUE);
  const target = new Tile(destination, OPERAND_VALUE);
  const produced = defaultProduceMergeValue(source, target);

  return { source, target, resultValue: produced, scoreDelta: produced };
}

/**
 * A stage-start payload at one board size.
 *
 * @param boardSize Reconciled edge length the stage begins at.
 * @returns The payload, which is identical on the dispatch and handler sides.
 */
function stageStartPayload(boardSize: number): StageStartPayload {
  return {
    stageIndex: 0,
    goal: { kind: 'highest-tile', target: 128 },
    seed: SEED,
    boardSize,
  };
}

/* ==========================================================================
 * Harness
 *
 * Every collaborator is rebuilt for each test. The rules in particular:
 * `createDefaultRulesConfig()` of src/config/default-config.ts returns a fresh
 * mutable configuration on every call, while `DEFAULT_RULES_CONFIG` beside it
 * is deep-frozen, and this relic installs a merge predicate over
 * `config.merge.canMerge`. The `beforeEach` below calls the factory.
 * ========================================================================== */

/** One test's collaborators, with the relic registered on the bus. */
interface Bench {
  readonly config: RulesConfig;
  readonly grid: Grid;
  readonly streams: RngStreams;
  readonly bus: HookBus;
  readonly environment: HookEnvironment;
}

/** The live collaborators, rebuilt by `beforeEach`. */
let config: RulesConfig;
let grid: Grid;
let streams: RngStreams;

beforeEach((): void => {
  config = createDefaultRulesConfig();
  grid = new Grid(
    config.boardSize,
    createMergePairBoard(config.boardSize).grid.cells,
  );
  streams = createRngStreams(SEED);
});

/**
 * Builds a bus holding the relic under test, over the collaborators
 * `beforeEach` rebuilt.
 *
 * @param charges Budget to register the subscription with. Defaults to the
 *   budget the declaration carries.
 * @param board Board the dispatch runs against. Defaults to the board
 *   `beforeEach` rebuilt.
 * @returns The bench.
 */
function benchWithRelic(
  charges = declaredRelic().charges,
  board: Grid = grid,
): Bench {
  const definition = declaredRelic();
  const bus = createHookBus({
    correlationId: CORRELATION_ID,
    reporter: NOOP_ENGINE_REPORTER,
  });

  expect(
    bus.register({
      id: definition.id,
      hooks: definition.hooks,
      charges,
      state: definition.state,
    }),
    `the bus accepts the ${RELIC_ID} registration`,
  ).toBe(true);

  return {
    config,
    grid: board,
    streams,
    bus,
    environment: { config, rng: streams, grid: board },
  };
}

/**
 * Builds a bus holding no subscriber at all, over the same collaborators: the
 * baseline a dispatch's payload is compared against.
 *
 * @returns The bench.
 */
function benchWithoutRelic(): Bench {
  return {
    config,
    grid,
    streams,
    bus: createHookBus({
      correlationId: CORRELATION_ID,
      reporter: NOOP_ENGINE_REPORTER,
    }),
    environment: { config, rng: streams, grid },
  };
}

/**
 * Builds a registry that seats the relic on its own bus, which is the path a
 * reward selection takes and the path that owns the live charge pool.
 *
 * @returns The registry, its bus and the environment dispatches run against.
 */
function benchWithRegistry(): {
  readonly registry: RelicRegistry;
  readonly bus: HookBus;
  readonly environment: HookEnvironment;
} {
  const bus = createHookBus({
    correlationId: CORRELATION_ID,
    reporter: NOOP_ENGINE_REPORTER,
  });
  const registry = new RelicRegistry({
    bus,
    reporter: NOOP_ENGINE_REPORTER,
    correlationId: CORRELATION_ID,
  });

  const seated = registry.pickUp(RELIC_ID);

  expect(seated?.definition.id, `the registry seats ${RELIC_ID}`).toBe(
    RELIC_ID,
  );
  expect(registry.has(RELIC_ID)).toBe(true);
  expect(seated?.charges).toBe(declaredRelic().charges);

  return {
    registry,
    bus,
    environment: { config, rng: streams, grid },
  };
}

/* ==========================================================================
 * A recording board-effect queue
 *
 * The channel a handler records through. The product's own queue is
 * transactional and is opened by the bus per handler; this double is what a
 * DIRECT invocation is handed, so a test that never goes through the bus can
 * still read what the handler recorded. Every lattice command is refused, as
 * the product's inert queue refuses them; this relic records none.
 * ========================================================================== */

/** The double, and what was recorded through it. */
interface RecordingQueue {
  readonly queue: BoardEffectQueue;

  /** Commands recorded, in record order. */
  readonly recorded: readonly BoardEffect[];

  /** Merge predicates recorded, in record order. */
  installed(): readonly MergePredicate[];
}

/**
 * Opens a recording queue over one board.
 *
 * @param board Board the queries read.
 * @returns The double.
 */
function openRecordingQueue(board: Grid): RecordingQueue {
  const recorded: BoardEffect[] = [];
  const view = createReadonlyGridView(board);
  let refusals = 0;

  /** Refuses one command, as the inert queue does, and counts it. */
  const refuse = (): boolean => {
    refusals += 1;

    return false;
  };

  const queue: BoardEffectQueue = {
    get size(): number {
      return view.size;
    },

    get length(): number {
      return recorded.length;
    },

    get refused(): number {
      return refusals;
    },

    insertTile: refuse,
    removeTile: refuse,
    moveTile: refuse,
    restoreBoard: refuse,
    resizeBoard: refuse,

    setMergePredicate: (predicate: MergePredicate): boolean => {
      recorded.push({ kind: 'setMergePredicate', predicate });

      return true;
    },

    setSpawnWeights: refuse,
    request: refuse,
    requested: (): readonly BoardEffect[] => Object.freeze([...recorded]),
    cellValue: (cell: Position): number | null => view.cellValue(cell),
    cellOccupied: (cell: Position): boolean => view.cellOccupied(cell),
    availableCells: (): Position[] => view.availableCells(),
    occupiedCells: (): readonly { x: number; y: number; value: number }[] =>
      Object.freeze([]),

    clear: (): void => {
      recorded.length = 0;
    },
  };

  return {
    queue,
    recorded,
    installed: (): readonly MergePredicate[] =>
      recorded
        .filter((effect) => effect.kind === 'setMergePredicate')
        .map((effect) => effect.predicate),
  };
}

/* ==========================================================================
 * A hand-built dispatch context
 * ========================================================================== */

/** One hand-built context, and what a direct invocation can be read from. */
interface DirectContext {
  readonly context: HookContext;
  readonly effects: RecordingQueue;

  /** Charges the handler asked the notional bus to spend. */
  requested(): number;
}

/**
 * Builds the context a direct invocation is handed: the rules, board and
 * substreams `beforeEach` rebuilt, a recording effect queue, the run
 * correlation identifier, and a `spendCharge` that records the request exactly
 * as the bus does rather than writing a budget.
 *
 * @param hook Hook the invocation stands for.
 * @param charges Budget the notional subscription holds.
 * @param state Slot value the notional subscription carries.
 * @returns The context and its readable collaborators.
 */
function directContext(
  hook: HookName,
  charges: number | undefined,
  state: unknown = declaredRelic().state,
): DirectContext {
  const effects = openRecordingQueue(grid);
  let requested = 0;

  const context: HookContext = {
    config: {
      boardSize: config.boardSize,
      winValue: config.winValue,
      startTiles: config.startTiles,
      spawn: {
        values: [...config.spawn.values],
        weights: [...config.spawn.weights],
      },
      merge: { canMerge: config.merge.canMerge, produce: config.merge.produce },
    },
    rng: {
      seed: streams.seed,
      stream: (name) => streams.stream(name),
      snapshotCursors: (): RngCursorMap => streams.snapshotCursors(),
    },
    grid: createReadonlyGridView(grid),
    effects: effects.queue,
    correlationId: CORRELATION_ID,
    hook,
    subscriberId: RELIC_ID,
    pickupOrder: 0,
    charges,

    // As the bus does: the request is RECORDED and the budget is not written
    // here. A subscription carrying no budget has nothing to spend.
    spendCharge: (amount = 1): boolean => {
      if (charges === undefined || !Number.isFinite(amount)) {
        return false;
      }

      const wanted = Math.max(0, Math.trunc(amount));

      if (wanted === 0) {
        return false;
      }

      requested = Math.min(
        Math.max(0, Math.trunc(charges)),
        requested + wanted,
      );

      return requested > 0;
    },

    state,
  };

  return { context, effects, requested: (): number => requested };
}


/* ==========================================================================
 * Shared assertions
 * ========================================================================== */

/** The rule members that must never change: everything but `canMerge`. */
function rulesBeyondThePredicate(rules: RulesConfig): unknown {
  return {
    boardSize: rules.boardSize,
    winValue: rules.winValue,
    startTiles: rules.startTiles,
    spawnValues: [...rules.spawn.values],
    spawnWeights: [...rules.spawn.weights],
    produce: rules.merge.produce,
  };
}

/** One tile projected to the members a merge rule and a view read. */
function tileFacts(tile: Tile): unknown {
  return {
    x: tile.x,
    y: tile.y,
    value: tile.value,
    previousPosition: tile.previousPosition,
    mergedFrom: tile.mergedFrom,
  };
}

/**
 * Asserts that nothing but `config.merge.canMerge` moved: the other rule
 * members, the board and the two operands are all as they were.
 *
 * @param rulesBefore Rule projection taken before the invocation.
 * @param boardBefore Board projection taken before the invocation.
 * @param operandsBefore Operand projections taken before the invocation.
 * @param operands The operands those projections were taken from.
 */
function expectOnlyThePredicateChanged(
  rulesBefore: unknown,
  boardBefore: unknown,
  operandsBefore: readonly unknown[],
  operands: readonly Tile[],
): void {
  expect(rulesBeyondThePredicate(config)).toEqual(rulesBefore);
  expect(grid.serialize()).toEqual(boardBefore);
  expect(operands.map(tileFacts)).toEqual(operandsBefore);
  expect(config.merge.canMerge).toBeTypeOf('function');
}

/* ==========================================================================
 * 1. The declaration, and the hooks it binds
 * ========================================================================== */

describe('the frostbind declaration', () => {
  it('is declared by merge-magic and indexed by the catalogue', () => {
    expect(declaredRelic()).toBe(catalogueRelic());
    expect(catalogueRelic().id).toBe(RELIC_ID);
    expect(catalogueRelic().name).toBe('Frostbind');
    expect(catalogueRelic().description.length).toBeGreaterThan(0);
  });

  it('binds onStageStart and onMerge, and no other hook', () => {
    expect(Object.keys(declaredRelic().hooks)).toEqual([
      'onStageStart',
      'onMerge',
    ]);
  });

  it('binds only names the hook contract declares', () => {
    for (const name of Object.keys(declaredRelic().hooks)) {
      expect(HOOK_NAMES).toContain(name);
    }
  });

  it('leaves every unbound hook name absent rather than undefined', () => {
    const bound: readonly string[] = ['onStageStart', 'onMerge'];
    const hooks = declaredRelic().hooks as Record<string, unknown>;

    for (const name of HOOK_NAMES) {
      if (bound.includes(name)) {
        continue;
      }

      expect(Object.prototype.hasOwnProperty.call(hooks, name)).toBe(false);
      expect(name in hooks).toBe(false);
    }
  });

  it('binds a callable handler to each of the two names', () => {
    expect(mergeHandler()).toBeTypeOf('function');
    expect(stageStartHandler()).toBeTypeOf('function');
  });
});

/* ==========================================================================
 * 2. The void return, and the payload the bus keeps
 * ========================================================================== */

describe('the frostbind onMerge handler', () => {
  it('returns undefined, not null and not a payload of its own', () => {
    const invocation = directContext('onMerge', declaredRelic().charges);
    const returned = mergeHandler()(mergePayload(), invocation.context);

    expect(returned).toBeUndefined();
    expect(returned).not.toBeNull();
    expect(returned).toBe(undefined);
  });

  it('returns undefined from onStageStart as well', () => {
    const invocation = directContext('onStageStart', declaredRelic().charges);
    const returned = stageStartHandler()(
      stageStartPayload(config.boardSize),
      invocation.context,
    );

    expect(returned).toBeUndefined();
  });

  it('leaves resultValue and scoreDelta exactly as they arrived', () => {
    const payload = mergePayload();
    const invocation = directContext('onMerge', declaredRelic().charges);

    mergeHandler()(payload, invocation.context);

    expect(payload.resultValue).toBe(OPERAND_VALUE * 2);
    expect(payload.scoreDelta).toBe(OPERAND_VALUE * 2);
  });
});

describe('the bus keeps the incoming payload on the void return', () => {
  it('resolves what a subscriber-free dispatch would have resolved', () => {
    const dispatched = mergeDispatch();
    const baseline = benchWithoutRelic();
    const kept = baseline.bus.dispatch(
      'onMerge',
      dispatched.payload,
      baseline.environment,
    ).payload;

    const withRelic = benchWithRelic();
    const resolved = withRelic.bus.dispatch(
      'onMerge',
      mergeDispatch().payload,
      withRelic.environment,
    );

    expect(resolved.invoked).toBe(1);
    expect(resolved.failed).toBe(0);
    expect(resolved.rejected).toBe(0);
    expect(resolved.payload).toEqual(kept);
  });

  it('hands the same source and target views on to the next handler', () => {
    const bench = benchWithRelic();
    let seenSource: unknown = null;
    let seenTarget: unknown = null;

    // Registered AFTER the relic, so what it receives is what the relic's void
    // return left standing. It transforms nothing and returns nothing.
    expect(
      bench.bus.register({
        id: 'downstream-observer',
        hooks: {
          onMerge: (payload): void => {
            seenSource = payload.source;
            seenTarget = payload.target;
          },
        },
      }),
    ).toBe(true);

    const resolved = bench.bus.dispatch(
      'onMerge',
      mergeDispatch().payload,
      bench.environment,
    );

    expect(resolved.invoked).toBe(2);
    expect(seenSource).toBe(resolved.payload.source);
    expect(seenTarget).toBe(resolved.payload.target);
  });

  it('carries the dispatched operands and score through unchanged', () => {
    const dispatched = mergeDispatch();
    const bench = benchWithRelic();
    const resolved = bench.bus.dispatch(
      'onMerge',
      dispatched.payload,
      bench.environment,
    );

    expect(resolved.payload.resultValue).toBe(dispatched.payload.resultValue);
    expect(resolved.payload.scoreDelta).toBe(dispatched.payload.scoreDelta);
    expect(resolved.payload.source.x).toBe(dispatched.source.x);
    expect(resolved.payload.source.y).toBe(dispatched.source.y);
    expect(resolved.payload.source.value).toBe(dispatched.source.value);
    expect(resolved.payload.target.x).toBe(dispatched.target.x);
    expect(resolved.payload.target.y).toBe(dispatched.target.y);
    expect(resolved.payload.target.value).toBe(dispatched.target.value);
  });
});


/* ==========================================================================
 * 3. The merge-predicate wrapper: freeze, thaw, and the base rule beneath
 * ========================================================================== */

describe('frostbind records the frozen-cell merge predicate', () => {
  it('records a command and writes the rules through no other path', () => {
    const invocation = directContext('onMerge', declaredRelic().charges);
    const before = config.merge.canMerge;

    mergeHandler()(mergePayload(), invocation.context);

    expect(invocation.effects.installed()).toHaveLength(1);
    expect(invocation.effects.installed()[0]).toBeTypeOf('function');
    expect(config.merge.canMerge).toBe(before);
  });

  it('installs the wrapper on the live rules once the bus commits', () => {
    const bench = benchWithRelic();
    const before = config.merge.canMerge;

    expect(before).toBe(defaultCanMerge);

    const resolved = bench.bus.dispatch(
      'onMerge',
      mergeDispatch().payload,
      bench.environment,
    );

    expect(resolved.effectsApplied).toBeGreaterThan(0);
    expect(config.merge.canMerge).not.toBe(before);
    expect(config.merge.canMerge).toBeTypeOf('function');
  });

  it('leaves the predicate it wrapped callable and unchanged', () => {
    const bench = benchWithRelic();
    const before = config.merge.canMerge;

    bench.bus.dispatch('onMerge', mergeDispatch().payload, bench.environment);

    const moving = new Tile(ORIGIN, OPERAND_VALUE);
    const frosted = new Tile(DESTINATION, OPERAND_VALUE);

    expect(before(moving, frosted)).toBe(true);
    expect(before).toBe(defaultCanMerge);
  });

  it('refuses a merge onto the frosted cell the base rule would accept', () => {
    const bench = benchWithRelic();

    bench.bus.dispatch('onMerge', mergeDispatch().payload, bench.environment);

    const moving = new Tile(ORIGIN, OPERAND_VALUE);
    const frosted = new Tile(DESTINATION, OPERAND_VALUE);

    // The refused side is asserted against what the base rule answers on the
    // same operands rather than against a hardcoded verdict.
    expect(defaultCanMerge(moving, frosted)).toBe(true);
    expect(config.merge.canMerge(moving, frosted)).toBe(false);
  });

  it('accepts that merge again once a second merge there thaws it', () => {
    const bench = benchWithRelic();
    const moving = new Tile(ORIGIN, OPERAND_VALUE);
    const frosted = new Tile(DESTINATION, OPERAND_VALUE);

    bench.bus.dispatch('onMerge', mergeDispatch().payload, bench.environment);

    expect(config.merge.canMerge(moving, frosted)).toBe(false);

    bench.bus.dispatch('onMerge', mergeDispatch().payload, bench.environment);

    expect(config.merge.canMerge(moving, frosted)).toBe(
      defaultCanMerge(moving, frosted),
    );
    expect(config.merge.canMerge(moving, frosted)).toBe(true);
  });

  it('accepts a merge onto a cell the ledger does not hold', () => {
    const bench = benchWithRelic();

    bench.bus.dispatch('onMerge', mergeDispatch().payload, bench.environment);

    const moving = new Tile({ x: 3, y: 3 }, OPERAND_VALUE);
    const elsewhere = new Tile({ x: 2, y: 3 }, OPERAND_VALUE);

    expect(config.merge.canMerge(moving, elsewhere)).toBe(
      defaultCanMerge(moving, elsewhere),
    );
    expect(config.merge.canMerge(moving, elsewhere)).toBe(true);
  });

  it('still refuses a pair of unequal values, as the base rule does', () => {
    const bench = benchWithRelic();

    bench.bus.dispatch('onMerge', mergeDispatch().payload, bench.environment);

    const moving = new Tile({ x: 2, y: 2 }, OPERAND_VALUE);
    const unequal = new Tile({ x: 1, y: 2 }, OPERAND_VALUE * 2);

    expect(defaultCanMerge(moving, unequal)).toBe(false);
    expect(config.merge.canMerge(moving, unequal)).toBe(false);
  });

  it('still refuses a target that already merged this turn', () => {
    // js/game_manager.js L156's `!next.mergedFrom` half, which is what holds
    // one merger per traversal. A wrapper that lost it would let a traversal
    // merge the same target twice.
    const bench = benchWithRelic();

    bench.bus.dispatch('onMerge', mergeDispatch().payload, bench.environment);

    const moving = new Tile({ x: 2, y: 1 }, OPERAND_VALUE);
    const merged = new Tile({ x: 1, y: 1 }, OPERAND_VALUE);

    merged.mergedFrom = [
      new Tile({ x: 1, y: 1 }, OPERAND_VALUE),
      new Tile({ x: 2, y: 1 }, OPERAND_VALUE),
    ];

    expect(defaultCanMerge(moving, merged)).toBe(false);
    expect(config.merge.canMerge(moving, merged)).toBe(false);
  });

  it('leaves a probe carrying no cell to the base rule alone', () => {
    // src/engine/move-resolver.ts keeps js/game_manager.js L156's `next &&`
    // existence guard outside the predicate, and the loss check probes with
    // value projections that carry no coordinates.
    const bench = benchWithRelic();

    bench.bus.dispatch('onMerge', mergeDispatch().payload, bench.environment);

    const probe = { value: OPERAND_VALUE, mergedFrom: null };

    expect(config.merge.canMerge(probe, probe)).toBe(
      defaultCanMerge(probe, probe),
    );
    expect(config.merge.canMerge(probe, probe)).toBe(true);
  });

  it('raises nothing on either operand shape its callers supply', () => {
    const bench = benchWithRelic();

    bench.bus.dispatch('onMerge', mergeDispatch().payload, bench.environment);

    const moving = new Tile(ORIGIN, OPERAND_VALUE);
    const frosted = new Tile(DESTINATION, OPERAND_VALUE);
    const probe = { value: OPERAND_VALUE, mergedFrom: null };

    expect((): boolean => config.merge.canMerge(moving, frosted)).not.toThrow();
    expect((): boolean => config.merge.canMerge(probe, probe)).not.toThrow();
  });

  it('leaves a blocked board untouched and still frosts its cell', () => {
    const blocked = new Grid(
      config.boardSize,
      createBlockedBoard(config.boardSize).grid.cells,
    );
    const bench = benchWithRelic(declaredRelic().charges, blocked);
    const before = blocked.serialize();

    bench.bus.dispatch('onMerge', mergeDispatch().payload, bench.environment);

    const moving = new Tile(ORIGIN, OPERAND_VALUE);
    const frosted = new Tile(DESTINATION, OPERAND_VALUE);

    expect(blocked.serialize()).toEqual(before);
    expect(config.merge.canMerge(moving, frosted)).toBe(false);
  });

  it('installs one wrapper however many merges resolve', () => {
    // Three toggles: frost (0, 0), frost (1, 1), thaw (0, 0). A wrapper nested
    // inside its predecessor would answer against a stale ledger and keep
    // refusing (0, 0); a wrapper that REPLACED it answers against the ledger
    // the third toggle left.
    const bench = benchWithRelic();

    bench.bus.dispatch(
      'onMerge',
      mergeDispatch({ x: 0, y: 0 }).payload,
      bench.environment,
    );
    bench.bus.dispatch(
      'onMerge',
      mergeDispatch({ x: 1, y: 1 }).payload,
      bench.environment,
    );
    bench.bus.dispatch(
      'onMerge',
      mergeDispatch({ x: 0, y: 0 }).payload,
      bench.environment,
    );

    const moving = new Tile(ORIGIN, OPERAND_VALUE);
    const thawed = new Tile({ x: 0, y: 0 }, OPERAND_VALUE);
    const stillFrosted = new Tile({ x: 1, y: 1 }, OPERAND_VALUE);

    expect(config.merge.canMerge(moving, thawed)).toBe(true);
    expect(config.merge.canMerge(moving, stillFrosted)).toBe(false);
  });

  it('installs the rule at stage start and spends nothing for it', () => {
    const bench = benchWithRelic();
    const before = config.merge.canMerge;
    const resolved = bench.bus.dispatch(
      'onStageStart',
      stageStartPayload(config.boardSize),
      bench.environment,
    );

    expect(resolved.invoked).toBe(1);
    expect(resolved.chargesConsumed).toBe(0);
    expect(resolved.effectsApplied).toBeGreaterThan(0);
    expect(config.merge.canMerge).not.toBe(before);
  });

  it('changes no rule but the merge predicate, and no tile', () => {
    const dispatched = mergeDispatch();
    const bench = benchWithRelic();
    const rulesBefore = rulesBeyondThePredicate(config);
    const boardBefore = grid.serialize();
    const operands = [dispatched.source, dispatched.target];
    const operandsBefore = operands.map(tileFacts);

    bench.bus.dispatch('onMerge', dispatched.payload, bench.environment);

    expectOnlyThePredicateChanged(
      rulesBefore,
      boardBefore,
      operandsBefore,
      operands,
    );
  });

  it('records no lattice command, so the board is never rewritten', () => {
    const invocation = directContext('onMerge', declaredRelic().charges);
    const boardBefore = grid.serialize();

    mergeHandler()(mergePayload(), invocation.context);

    expect(
      invocation.effects.recorded.every(
        (effect) => effect.kind === 'setMergePredicate',
      ),
    ).toBe(true);
    expect(invocation.effects.queue.refused).toBe(0);
    expect(grid.serialize()).toEqual(boardBefore);
  });
});


/* ==========================================================================
 * 4. Charges, and the zero-charge edge case
 * ========================================================================== */

describe('the frostbind charge budget', () => {
  it('is declared on the relic, finite, whole and above zero', () => {
    const relic = declaredRelic();
    const declared = relic.charges;

    expect(Object.prototype.hasOwnProperty.call(relic, 'charges')).toBe(true);
    expect(declared).toBeTypeOf('number');
    expect(Number.isFinite(declared)).toBe(true);
    expect(Number.isSafeInteger(declared)).toBe(true);
    expect(declared as number).toBeGreaterThan(0);
  });

  it('is one of exactly five in a catalogue of sixteen', () => {
    const charged = RELIC_CATALOGUE.filter(
      (entry) => entry.charges !== undefined,
    );

    expect(RELIC_CATALOGUE).toHaveLength(16);
    expect(charged).toHaveLength(CHARGE_BEARING_RELICS);
    expect(charged.map((entry) => entry.id)).toContain(RELIC_ID);
  });

  it('is guarded by the bus, and named by neither handler', () => {
    // AAP Contract 2 puts the guard in src/engine/hook-bus.ts once rather than
    // sixteen times in handlers, which is Figure 5's legend.
    for (const source of [
      String(mergeHandler()),
      String(stageStartHandler()),
    ]) {
      expect(source).not.toContain('charges');
    }
  });

  it('is asked for through the context and written by neither handler', () => {
    const declared = declaredRelic().charges;
    const invocation = directContext('onMerge', declared);

    mergeHandler()(mergePayload(), invocation.context);

    expect(invocation.requested()).toBe(1);
    expect(declaredRelic().charges).toBe(declared);
    expect(invocation.context.charges).toBe(declared);
  });

  it('is not asked for at stage start, which prepares the rule', () => {
    const invocation = directContext('onStageStart', declaredRelic().charges);

    stageStartHandler()(
      stageStartPayload(config.boardSize),
      invocation.context,
    );

    expect(invocation.requested()).toBe(0);
    expect(invocation.effects.installed()).toHaveLength(1);
  });
});

describe('invoked with zero charges', () => {
  it('neither throws nor corrupts run state', () => {
    // The bus would have skipped the handler outright; this asserts a DIRECT
    // invocation cannot corrupt anything either. The bus's own skip is held by
    // the suites under tests/unit/engine.
    const payload = mergePayload();
    const invocation = directContext('onMerge', 0);
    const rulesBefore = rulesBeyondThePredicate(config);
    const boardBefore = grid.serialize();
    const predicateBefore = config.merge.canMerge;
    const operands = [payload.source as Tile, payload.target as Tile];
    const operandsBefore = operands.map(tileFacts);

    let returned: MergePayload | void = payload;

    expect((): void => {
      returned = mergeHandler()(payload, invocation.context);
    }).not.toThrow();

    expect(returned).toBe(undefined);
    expect(config.merge.canMerge).toBe(predicateBefore);
    expect(invocation.requested()).toBe(0);
    expectOnlyThePredicateChanged(
      rulesBefore,
      boardBefore,
      operandsBefore,
      operands,
    );
  });

  it('leaves the state slot in the shape the envelope persists', () => {
    const invocation = directContext('onMerge', 0);

    mergeHandler()(mergePayload(), invocation.context);

    const slot = invocation.context.state as { frozen?: unknown };

    expect(slot).toBeTypeOf('object');
    expect(Array.isArray(slot.frozen)).toBe(true);
    expect(slot.frozen).toEqual([DESTINATION]);
    expect(JSON.parse(JSON.stringify(slot))).toEqual(slot);
  });

  it('records a coherent predicate, never a missing one', () => {
    const invocation = directContext('onMerge', 0);

    mergeHandler()(mergePayload(), invocation.context);

    const installed = invocation.effects.installed();

    expect(installed).toHaveLength(1);
    expect(installed[0]).toBeTypeOf('function');

    const moving = new Tile(ORIGIN, OPERAND_VALUE);
    const frosted = new Tile(DESTINATION, OPERAND_VALUE);

    expect((installed[0] as MergePredicate)(moving, frosted)).toBe(false);
  });
});

describe('invoked with a negative charge budget', () => {
  it('is exactly as safe as the zero-charge invocation', () => {
    // src/relics/relic-registry.ts restores a persisted budget without
    // clamping, so a negative value is reachable from a written envelope.
    const payload = mergePayload();
    const invocation = directContext('onMerge', -3);
    const rulesBefore = rulesBeyondThePredicate(config);
    const boardBefore = grid.serialize();
    const operands = [payload.source as Tile, payload.target as Tile];
    const operandsBefore = operands.map(tileFacts);

    let returned: MergePayload | void = payload;

    expect((): void => {
      returned = mergeHandler()(payload, invocation.context);
    }).not.toThrow();

    expect(returned).toBe(undefined);
    expect(invocation.requested()).toBe(0);
    expect(invocation.effects.installed()).toHaveLength(1);
    expectOnlyThePredicateChanged(
      rulesBefore,
      boardBefore,
      operandsBefore,
      operands,
    );
  });

  it('leaves the declared budget untouched', () => {
    const invocation = directContext('onMerge', -1);

    mergeHandler()(mergePayload(), invocation.context);

    expect(declaredRelic().charges).toBe(DECLARED_AT_LOAD.charges);
    expect(declaredRelic().charges as number).toBeGreaterThan(0);
    expect(invocation.context.charges).toBe(-1);
  });
});

describe('charge exhaustion across a run', () => {
  it('spends one charge per merge until the pool is empty', () => {
    const seated = benchWithRegistry();
    const declared = declaredRelic().charges as number;

    for (let spent = 1; spent <= declared; spent += 1) {
      const resolved = seated.bus.dispatch(
        'onMerge',
        mergeDispatch().payload,
        seated.environment,
      );

      expect(resolved.invoked).toBe(1);
      expect(resolved.chargesConsumed).toBe(1);
      expect(seated.registry.find(RELIC_ID)?.charges).toBe(declared - spent);
    }

    expect(seated.registry.find(RELIC_ID)?.charges).toBe(0);
  });

  it('stops taking effect once the pool is empty, without throwing', () => {
    const seated = benchWithRegistry();
    const declared = declaredRelic().charges as number;

    for (let spent = 0; spent < declared; spent += 1) {
      seated.bus.dispatch(
        'onMerge',
        mergeDispatch().payload,
        seated.environment,
      );
    }

    const exhausted = config.merge.canMerge;
    const resolved = seated.bus.dispatch(
      'onMerge',
      mergeDispatch().payload,
      seated.environment,
    );

    expect(resolved.invoked).toBe(0);
    expect(resolved.skipped).toBe(1);
    expect(resolved.failed).toBe(0);
    expect(resolved.chargesConsumed).toBe(0);
    expect(resolved.effectsApplied).toBe(0);
    expect(config.merge.canMerge).toBe(exhausted);
    expect(seated.registry.find(RELIC_ID)?.charges).toBe(0);
  });

  it('leaves the standing frost in force once the pool is empty', () => {
    const seated = benchWithRegistry();
    const declared = declaredRelic().charges as number;

    // An odd number of toggles on one cell leaves it frosted, so the last
    // toggle before exhaustion is the one still in force afterwards.
    for (let spent = 0; spent < declared; spent += 1) {
      const destination = spent === declared - 1 ? { x: 2, y: 2 } : DESTINATION;

      seated.bus.dispatch(
        'onMerge',
        mergeDispatch(destination).payload,
        seated.environment,
      );
    }

    seated.bus.dispatch(
      'onMerge',
      mergeDispatch({ x: 3, y: 3 }).payload,
      seated.environment,
    );

    const moving = new Tile(ORIGIN, OPERAND_VALUE);
    const frosted = new Tile({ x: 2, y: 2 }, OPERAND_VALUE);
    const untouched = new Tile({ x: 3, y: 3 }, OPERAND_VALUE);

    expect(config.merge.canMerge(moving, frosted)).toBe(false);
    expect(config.merge.canMerge(moving, untouched)).toBe(true);
  });
});

/* ==========================================================================
 * 5. Determinism and substream hygiene
 * ========================================================================== */

describe('frostbind consumes no randomness', () => {
  it('leaves every substream cursor where it stood on a merge', () => {
    const bench = benchWithRelic();
    const before = streams.snapshotCursors();

    bench.bus.dispatch('onMerge', mergeDispatch().payload, bench.environment);

    const after = streams.snapshotCursors();

    for (const name of RNG_STREAM_NAMES) {
      expect(after[name], `${name} cursor`).toBe(before[name]);
      expect(after[name], `${name} cursor`).toBe(0);
    }

    expect(after).toEqual(before);
  });

  it('leaves every substream cursor where it stood at stage start', () => {
    const bench = benchWithRelic();
    const before = streams.snapshotCursors();

    bench.bus.dispatch(
      'onStageStart',
      stageStartPayload(config.boardSize),
      bench.environment,
    );

    expect(streams.snapshotCursors()).toEqual(before);
  });

  it('names no Math.random, no console and no catch in either handler', () => {
    // The family module owns no error handling of its own: a throw surfaces
    // through the bus's injected reporter, never through a local catch.
    for (const source of [
      String(mergeHandler()),
      String(stageStartHandler()),
    ]) {
      expect(source).not.toContain('Math.random');
      expect(source).not.toContain('console');
      expect(source).not.toContain('catch');
    }
  });
});


/* ==========================================================================
 * 6. The dispatch context, and the correlation identifier on it
 * ========================================================================== */

describe('the context frostbind is dispatched with', () => {
  it('carries the run correlation identifier through the bus', () => {
    const bench = benchWithRelic();
    let seen: unknown = null;

    expect(
      bench.bus.register({
        id: 'correlation-observer',
        hooks: {
          onMerge: (_payload, context): void => {
            seen = context.correlationId;
          },
        },
      }),
    ).toBe(true);

    bench.bus.dispatch('onMerge', mergeDispatch().payload, bench.environment);

    expect(seen).toBe(CORRELATION_ID);
  });

  it('carries it on the context a direct invocation is handed', () => {
    const invocation = directContext('onMerge', declaredRelic().charges);

    expect(invocation.context.correlationId).toBe(CORRELATION_ID);
    expect(invocation.context.hook).toBe('onMerge');
    expect(invocation.context.subscriberId).toBe(RELIC_ID);
  });
});

/* ==========================================================================
 * 7. The declaration is a template, and stays one
 * ========================================================================== */

describe('the catalogue declaration after every dispatch above', () => {
  it('carries the members it carried when this module loaded', () => {
    const relic = declaredRelic();

    expect(relic.id).toBe(DECLARED_AT_LOAD.id);
    expect(relic.name).toBe(DECLARED_AT_LOAD.name);
    expect(relic.rarity).toBe(DECLARED_AT_LOAD.rarity);
    expect(relic.description).toBe(DECLARED_AT_LOAD.description);
    expect(relic.charges).toBe(DECLARED_AT_LOAD.charges);
    expect(Object.keys(relic.hooks)).toEqual(DECLARED_AT_LOAD.hookNames);
    expect(relic.hooks.onMerge).toBe(DECLARED_AT_LOAD.onMerge);
    expect(relic.hooks.onStageStart).toBe(DECLARED_AT_LOAD.onStageStart);
  });

  it('still declares the empty ledger a run starts from', () => {
    // The live slot belongs to src/engine/hook-bus.ts and the live budget to
    // src/relics/relic-registry.ts; the declaration is the shared template.
    expect(declaredRelic().state).toEqual({ frozen: [] });
    expect(declaredRelic().state).toBe(DECLARED_AT_LOAD.state);
  });

  it('is frozen at the level the family module froze it', () => {
    expect(Object.isFrozen(declaredRelic())).toBe(true);
    expect(Object.isFrozen(declaredRelic().hooks)).toBe(true);
    expect(Object.isFrozen(MERGE_MAGIC_FAMILY)).toBe(true);
    expect(Object.isFrozen(MERGE_MAGIC_FAMILY.relics)).toBe(true);
  });
});
