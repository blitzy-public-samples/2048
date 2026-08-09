// Direct-invocation suite for the `risk-reward-cursed` relic `gilded-rot`: the
// three properties AAP 0.6.3 Group 5 requires of every relic — it fires only
// on its bound hooks, it produces its specified effect, and it respects
// charges, including an invocation made with none left.
//
// SPECIFICATION, from the family module contract. `gilded-rot` binds two hooks
// and is the family's only relic on both the merge and the spawn path. At
// `onMerge` it multiplies `scoreDelta` and leaves `resultValue` alone; at
// `onSpawn` it raises the spawning tile to the largest value the live rules can
// spawn. It declares no charge budget and no state slot.
//
// The two handlers are invoked DIRECTLY here, through a `HookContext` this file
// builds by hand out of a live `RulesConfig`, a live `Grid` and the run's named
// substreams. tests/unit/relics/risk-reward-cursed.test.ts drives the same
// relic through the real src/engine/hook-bus.ts, and tests/unit/engine/ owns
// the bus mechanisms themselves, the charge guard included. No assertion below
// re-states either of those two.
//
// Provenance of the numbers this suite asserts against, from the deleted
// vanilla sources:
//   js/game_manager.js L71   `Math.random() < 0.9 ? 2 : 4`, the distribution
//                            `RulesConfig.spawn` carries as values [2, 4] at
//                            weights [0.9, 0.1]
//   js/game_manager.js L157  `new Tile(positions.next, tile.value * 2)`, the
//                            producer behind `MergePayload.resultValue`
//   js/game_manager.js L167  `self.score += merged.value`, the accrual behind
//                            `MergePayload.scoreDelta`. L157 and L167 read the
//                            same number, so the two payload members arrive
//                            carrying it
//   js/grid.js L37-L43       `randomAvailableCell()` returns no cell on a full
//                            board, the boundary `SpawnPayload.position` is
//                            optional for
//   .jshintrc L3-L6          two-space indentation, 80 columns and camelCase,
//                            carried forward by AAP 0.3.3
//
// Figures this suite exercises, named as Rule 2 requires:
//   Figure 4  "Turn Data Flow: From Keystroke to Composited Frame and
//             Persisted Run State", docs/architecture/data-flow.md. Its
//             `onMerge dispatch — score delta applied` and `onSpawn
//             dispatch — value + position from named RNG substreams` steps
//             are the two this relic transforms.
//   Figure 5  "Hook Dispatch Sequence: Pickup-Order Fan-Out with Charge Guard
//             and Error Isolation", in
//             docs/architecture/hook-dispatch-sequence.md, for the
//             transformed-payload return each handler makes.
//
// Traceability row of docs/TRACEABILITY_MATRIX.md this suite evidences:
//   TR-RISK-02  gilded-rot  onMerge, onSpawn
//
// Decisions behind the constructs asserted below, argued in
// docs/DECISION_LOG.md and named here only so each can be found from the log:
//   DL-RISK-02  each cursed effect paid for through a transformable payload
//               member or a `context.effects` command the engine applies
//   DL-TEST-01  tests/unit/relics/ collected by the DOM-free unit project
//
// This suite reads no DOM, no storage and no clock, performs no I/O, takes no
// unseeded randomness, patches no global and writes no log.

import { beforeEach, describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import type { RulesConfig } from '../../../src/config/rules-config';
import { Grid } from '../../../src/engine/grid';
import { HOOK_NAMES } from '../../../src/engine/hooks';
import type {
  BoardEffect,
  BoardEffectQueue,
  HookContext,
  HookHandler,
  HookName,
  MergePayload,
  ReadonlyGridView,
  SpawnPayload,
} from '../../../src/engine/hooks';
import { Tile } from '../../../src/engine/tile';
import type { CorrelationId, Position } from '../../../src/engine/types';
import {
  RISK_REWARD_CURSED_FAMILY,
} from '../../../src/relics/families/risk-reward-cursed';
import { findRelicById } from '../../../src/relics/relic-registry';
import {
  RARITIES,
  RELIC_FAMILY_NAMES,
} from '../../../src/relics/relic-types';
import type { Relic } from '../../../src/relics/relic-types';
import {
  RNG_STREAM_NAMES,
  createRngStreams,
} from '../../../src/rng/rng-streams';
import type { RngCursorMap, RngStreams } from '../../../src/rng/rng-streams';
import { createMergePairBoard } from '../../fixtures/boards';

/* ==========================================================================
 * 1. Constants
 * ========================================================================== */

/** Identifier the family module declares the relic under. */
const RELIC_ID = 'gilded-rot';

/** Family the declaration belongs to, hyphenated as `RelicFamilyName` is. */
const FAMILY_NAME = 'risk-reward-cursed';

/** Seed every substream in this suite is derived from. */
const SUITE_SEED = 'blitzy-gilded-rot';

/**
 * Run correlation identifier every context below carries, and that section 10
 * reads back off the context. `CorrelationId` is a string, and
 * src/observability/logger.ts is the one deriver of a real one.
 */
const SUITE_CORRELATION_ID: CorrelationId = 'run-gilded-rot-suite';

/** Subscriber identity a dispatch carries. */
const SUBSCRIBER_ID = 'relic:gilded-rot';

/** Pickup position a dispatch carries. */
const PICKUP_ORDER = 1;

/**
 * Factor the merge half declares: the relic's own description states that
 * every merge pays double. Every expected score below is this factor applied
 * to the arriving contribution, never a transcribed number.
 */
const SCORE_MULTIPLIER = 2;

/** Hooks the relic binds, in declaration order. */
const BOUND_HOOKS: readonly HookName[] = ['onMerge', 'onSpawn'];

/** The rest of `HOOK_NAMES`, which the relic must not bind. */
const UNBOUND_HOOKS: readonly HookName[] = HOOK_NAMES.filter(
  (name) => !BOUND_HOOKS.includes(name),
);

/**
 * Tokens neither bound handler's own source may contain. `charges` is guarded
 * in src/engine/hook-bus.ts and read by no handler; randomness is drawn from
 * named substreams; and the family module owns no error handling and no
 * reporting of its own, both of which are injected into the bus.
 */
const FORBIDDEN_HANDLER_TOKENS: readonly string[] = [
  'charges',
  'Math.random',
  'catch',
  'console',
];

/** Longer ladder the live-rules assertions install. */
const LONGER_SPAWN_VALUES: readonly number[] = [2, 4, 8, 16];

/** Weights paired with `LONGER_SPAWN_VALUES`, summing to 1. */
const LONGER_SPAWN_WEIGHTS: readonly number[] = [0.7, 0.1, 0.1, 0.1];

/* ==========================================================================
 * 2. Harness
 * ========================================================================== */

/** What one hand-built dispatch environment hands a test. */
interface Bench {
  /** The live rules the dispatch reads, and that a test may rewrite. */
  readonly config: RulesConfig;

  /** The live lattice the dispatch reads through its query surface. */
  readonly grid: Grid;

  /** The run's named substreams, read for their cursors. */
  readonly streams: RngStreams;

  /** The one context object both bindings are invoked with. */
  readonly context: HookContext;

  /** Hook the context reports, written before each invocation. */
  readonly dispatched: { hook: HookName };

  /** Board commands the handlers attempted, in attempt order. */
  readonly effectAttempts: string[];

  /** Charge amounts the handlers requested, in request order. */
  readonly chargeRequests: number[];
}

/**
 * Builds the board-write channel a handler is handed: every command is refused
 * and logged, and every query reads an empty board. This mirrors
 * `INERT_BOARD_EFFECTS` of src/engine/board-effects.ts, with an added log of
 * every refused command that the assertions read.
 *
 * @param attempts Log every refused command's name is appended to.
 * @returns The channel, refusing everything.
 */
function createRefusingEffects(attempts: string[]): BoardEffectQueue {
  const refuse = (command: string): boolean => {
    attempts.push(command);

    return false;
  };

  return {
    size: 0,
    length: 0,

    get refused(): number {
      return attempts.length;
    },

    insertTile: (): boolean => refuse('insertTile'),
    removeTile: (): boolean => refuse('removeTile'),
    moveTile: (): boolean => refuse('moveTile'),
    restoreBoard: (): boolean => refuse('restoreBoard'),
    resizeBoard: (): boolean => refuse('resizeBoard'),
    setMergePredicate: (): boolean => refuse('setMergePredicate'),
    setSpawnWeights: (): boolean => refuse('setSpawnWeights'),
    request: (): boolean => refuse('request'),
    requested: (): readonly BoardEffect[] => [],
    cellValue: (): number | null => null,
    cellOccupied: (): boolean => false,

    availableCells(): Position[] {
      return [];
    },

    occupiedCells() {
      return [];
    },

    clear: (): void => undefined,
  };
}

/**
 * Builds the board a handler reads: the query half of the live lattice and none
 * of its writes. The view declares `cellValue` where `Grid` declares
 * `cellContent`; this facade maps the one onto the other. Every member
 * delegates on each call, so a read resolves against the lattice as it stands.
 *
 * @param grid Live lattice to read through.
 * @returns The board view, reading live and writing nothing.
 */
function createGridView(grid: Grid): ReadonlyGridView {
  return {
    get size(): number {
      return grid.size;
    },

    withinBounds: (position: Position): boolean => grid.withinBounds(position),
    cellAvailable: (cell: Position): boolean => grid.cellAvailable(cell),
    cellOccupied: (cell: Position): boolean => grid.cellOccupied(cell),

    cellValue: (cell: Position): number | null => {
      const tile = grid.cellContent(cell);

      return tile === null ? null : tile.value;
    },

    availableCells(): Position[] {
      return grid.availableCells();
    },

    cellsAvailable: (): boolean => grid.cellsAvailable(),

    serialize() {
      return grid.serialize();
    },
  };
}

/**
 * Assembles one dispatch environment: a fresh mutable `RulesConfig`, a live
 * `Grid` restored from the merge-pair fixture, the four substreams derived from
 * `SUITE_SEED`, and one context carrying the correlation identifier.
 *
 * The rules come from `createDefaultRulesConfig()`, which allocates a fresh
 * mutable config on every call. `DEFAULT_RULES_CONFIG` is deep-frozen and
 * shared, and no member of this suite reads it.
 *
 * @param charges Charge budget the context reports. Absent on a subscriber
 *   carrying no budget, which is what the catalogue declares for this relic.
 * @returns A fresh bench sharing nothing with any earlier one.
 */
function createBench(charges?: number): Bench {
  const config = createDefaultRulesConfig();
  const board = createMergePairBoard(config.boardSize);
  const grid = new Grid(config.boardSize, board.grid.cells);
  const streams = createRngStreams(SUITE_SEED);
  const dispatched: { hook: HookName } = { hook: 'onMerge' };
  const effectAttempts: string[] = [];
  const chargeRequests: number[] = [];

  const context: HookContext = {
    config,
    rng: streams,
    grid: createGridView(grid),
    effects: createRefusingEffects(effectAttempts),
    correlationId: SUITE_CORRELATION_ID,

    get hook(): HookName {
      return dispatched.hook;
    },

    subscriberId: SUBSCRIBER_ID,
    pickupOrder: PICKUP_ORDER,
    charges,

    spendCharge: (amount?: number): boolean => {
      chargeRequests.push(amount === undefined ? 1 : amount);

      return false;
    },

    state: undefined,
  };

  return {
    config,
    grid,
    streams,
    context,
    dispatched,
    effectAttempts,
    chargeRequests,
  };
}

/* ==========================================================================
 * 3. Reaching the relic and its two handlers
 * ========================================================================== */

/**
 * Reads the declaration out of the family the module under test exports.
 *
 * @returns The `gilded-rot` declaration.
 * @throws {Error} If the family declares no relic under that identifier.
 */
function relicUnderTest(): Relic {
  const declared = RISK_REWARD_CURSED_FAMILY.relics.find(
    (entry) => entry.id === RELIC_ID,
  );

  if (declared === undefined) {
    throw new Error(
      `the ${FAMILY_NAME} family declares no relic "${RELIC_ID}"`,
    );
  }

  return declared;
}

/**
 * Reads the handler bound to `onMerge`.
 *
 * @returns The handler.
 * @throws {Error} If the relic binds none.
 */
function mergeHandler(): HookHandler<'onMerge'> {
  const handler = relicUnderTest().hooks.onMerge;

  if (handler === undefined) {
    throw new Error(`relic "${RELIC_ID}" binds no onMerge handler`);
  }

  return handler;
}

/**
 * Reads the handler bound to `onSpawn`.
 *
 * @returns The handler.
 * @throws {Error} If the relic binds none.
 */
function spawnHandler(): HookHandler<'onSpawn'> {
  const handler = relicUnderTest().hooks.onSpawn;

  if (handler === undefined) {
    throw new Error(`relic "${RELIC_ID}" binds no onSpawn handler`);
  }

  return handler;
}

/**
 * Invokes the `onMerge` handler and hands back exactly what it returned,
 * including nothing.
 *
 * @param bench Environment to dispatch through.
 * @param payload Merge as it arrives at the handler.
 * @returns The handler's return, transformed payload or nothing.
 */
function dispatchMerge(
  bench: Bench,
  payload: MergePayload,
): MergePayload | void {
  bench.dispatched.hook = 'onMerge';

  return mergeHandler()(payload, bench.context);
}

/**
 * Invokes the `onMerge` handler and requires a payload back.
 *
 * @param bench Environment to dispatch through.
 * @param payload Merge as it arrives at the handler.
 * @returns The transformed merge.
 * @throws {Error} If the handler returned nothing.
 */
function resolveMerge(bench: Bench, payload: MergePayload): MergePayload {
  const returned = dispatchMerge(bench, payload);

  if (returned === undefined) {
    throw new Error('the onMerge handler returned no payload');
  }

  return returned;
}

/**
 * Invokes the `onSpawn` handler and hands back exactly what it returned,
 * including nothing.
 *
 * @param bench Environment to dispatch through.
 * @param payload Spawn as it arrives at the handler.
 * @returns The handler's return, transformed payload or nothing.
 */
function dispatchSpawn(
  bench: Bench,
  payload: SpawnPayload,
): SpawnPayload | void {
  bench.dispatched.hook = 'onSpawn';

  return spawnHandler()(payload, bench.context);
}

/**
 * Invokes the `onSpawn` handler and requires a payload back.
 *
 * @param bench Environment to dispatch through.
 * @param payload Spawn as it arrives at the handler.
 * @returns The transformed spawn.
 * @throws {Error} If the handler returned nothing.
 */
function resolveSpawn(bench: Bench, payload: SpawnPayload): SpawnPayload {
  const returned = dispatchSpawn(bench, payload);

  if (returned === undefined) {
    throw new Error('the onSpawn handler returned no payload');
  }

  return returned;
}

/**
 * The declaration and its two handlers as they stand at module load. Section 11
 * reads each of them again and compares by identity.
 */
const DECLARED_RELIC: Relic = relicUnderTest();
const DECLARED_MERGE_HANDLER: HookHandler<'onMerge'> = mergeHandler();
const DECLARED_SPAWN_HANDLER: HookHandler<'onSpawn'> = spawnHandler();

/* ==========================================================================
 * 4. Payloads and readings
 * ========================================================================== */

/**
 * Builds one live tile, which satisfies the merge payload's tile view.
 *
 * @param x Zero-based column.
 * @param y Zero-based row.
 * @param value Face value.
 * @returns A fresh tile recording no previous position and no parents.
 */
function tileAt(x: number, y: number, value: number): Tile {
  return new Tile({ x, y }, value);
}

/**
 * Builds a merge of two tiles of equal value, laid out as the merge-pair
 * fixture lays them out: the moving tile at column 1 and the tile it runs into
 * at column 0, both on row 0.
 *
 * @param tileValue Face value both consumed tiles carry.
 * @param resultValue Value the merge produces.
 * @param scoreDelta Contribution the merge adds to the score.
 * @returns The merge as it arrives at a handler.
 */
function mergeOf(
  tileValue: number,
  resultValue: number,
  scoreDelta: number,
): MergePayload {
  return {
    source: tileAt(1, 0, tileValue),
    target: tileAt(0, 0, tileValue),
    resultValue,
    scoreDelta,
  };
}

/**
 * Builds a spawn.
 *
 * @param position Cell the tile arrives in, or nothing for the full-board
 *   boundary of js/grid.js L37-L43.
 * @param value Face value the tile arrives with.
 * @returns The spawn as it arrives at a handler.
 */
function spawnOf(
  position: Position | undefined,
  value: number,
): SpawnPayload {
  return { position, value };
}

/**
 * Reads the largest value a distribution can spawn.
 *
 * @param values `spawn.values` of the rules in force.
 * @returns The largest entry.
 */
function ceilingOf(values: readonly number[]): number {
  return values.reduce(
    (highest, value) => (value > highest ? value : highest),
    values[0],
  );
}

/**
 * Reads the smallest value a distribution can spawn.
 *
 * @param values `spawn.values` of the rules in force.
 * @returns The smallest entry.
 */
function floorOf(values: readonly number[]): number {
  return values.reduce(
    (lowest, value) => (value < lowest ? value : lowest),
    values[0],
  );
}

/** Reads the distribution as two plain arrays, for a before-and-after. */
function distributionOf(config: RulesConfig): {
  values: number[];
  weights: number[];
} {
  return {
    values: [...config.spawn.values],
    weights: [...config.spawn.weights],
  };
}

/** The bench each test starts from, rebuilt before every one of them. */
let bench: Bench = createBench();

beforeEach(() => {
  bench = createBench();
});

/* ==========================================================================
 * 5. The declaration
 * ========================================================================== */

describe('the gilded-rot declaration', () => {
  it('is reachable by identifier from the family it belongs to', () => {
    expect(relicUnderTest().id).toBe(RELIC_ID);
    expect(relicUnderTest().name).toBe('Gilded Rot');
  });

  it('is the same object the relic catalogue indexes by identifier', () => {
    expect(findRelicById(RELIC_ID)).toBe(relicUnderTest());
  });

  it('belongs to the hyphenated family name risk-reward-cursed', () => {
    expect(RISK_REWARD_CURSED_FAMILY.name).toBe(FAMILY_NAME);
    expect(RELIC_FAMILY_NAMES).toContain(FAMILY_NAME);
  });

  it('declares one of the rarities the relic vocabulary carries', () => {
    expect(RARITIES).toContain(relicUnderTest().rarity);
  });

  it('describes both halves of the effect in its own description', () => {
    const description = relicUnderTest().description;

    expect(description).toContain('double');
    expect(description).toContain('largest value the run can spawn');
  });

  it('opens the bench on the vanilla distribution of two and four', () => {
    // js/game_manager.js L71, `Math.random() < 0.9 ? 2 : 4`.
    expect(bench.config.spawn.values).toEqual([2, 4]);
    expect(bench.config.spawn.weights).toEqual([0.9, 0.1]);
  });
});

/* ==========================================================================
 * 6. Property 1: it fires only on the hooks it binds
 * ========================================================================== */

describe('gilded-rot binds onMerge and onSpawn and no other hook', () => {
  it('carries exactly the two keys onMerge and onSpawn', () => {
    expect(Object.keys(relicUnderTest().hooks)).toEqual([
      'onMerge',
      'onSpawn',
    ]);
  });

  it('names only hooks the engine declares in HOOK_NAMES', () => {
    for (const key of Object.keys(relicUnderTest().hooks)) {
      expect(HOOK_NAMES).toContain(key);
    }
  });

  it('leaves the other four hook names absent, not undefined', () => {
    expect(UNBOUND_HOOKS.length).toBe(4);

    for (const name of UNBOUND_HOOKS) {
      expect(name in relicUnderTest().hooks).toBe(false);
    }
  });

  it('binds a function to each of the two names', () => {
    for (const name of BOUND_HOOKS) {
      expect(typeof relicUnderTest().hooks[name]).toBe('function');
    }
  });

  it('reports the hook under dispatch through the context it is given', () => {
    resolveMerge(bench, mergeOf(2, 4, 4));
    expect(bench.context.hook).toBe('onMerge');

    resolveSpawn(bench, spawnOf({ x: 2, y: 1 }, 2));
    expect(bench.context.hook).toBe('onSpawn');
  });

  it('carries one state slot across both bindings, writing to neither', () => {
    const slot = { written: 'by the suite' };

    bench.context.state = slot;
    resolveMerge(bench, mergeOf(2, 4, 4));
    expect(bench.context.state).toBe(slot);

    resolveSpawn(bench, spawnOf({ x: 2, y: 1 }, 2));
    expect(bench.context.state).toBe(slot);
    expect(slot).toEqual({ written: 'by the suite' });
  });

  it('hands a slot written between the two dispatches to the later one', () => {
    resolveMerge(bench, mergeOf(2, 4, 4));
    bench.context.state = { written: 'after onMerge' };

    const beforeSpawn = bench.context.state;

    resolveSpawn(bench, spawnOf({ x: 2, y: 1 }, 2));
    expect(bench.context.state).toBe(beforeSpawn);
    expect(bench.context.state).toEqual({ written: 'after onMerge' });
  });

  it('declares no initial state slot of its own', () => {
    expect('state' in relicUnderTest()).toBe(false);
  });

  it('keeps no module-level state: two slots produce two equal runs', () => {
    const first = createBench();
    const second = createBench();

    first.context.state = { run: 'first' };
    second.context.state = { run: 'second' };

    const firstMerge = resolveMerge(first, mergeOf(2, 4, 4));
    const secondMerge = resolveMerge(second, mergeOf(2, 4, 4));
    const firstSpawn = resolveSpawn(first, spawnOf({ x: 3, y: 3 }, 2));
    const secondSpawn = resolveSpawn(second, spawnOf({ x: 3, y: 3 }, 2));

    expect(secondMerge.scoreDelta).toBe(firstMerge.scoreDelta);
    expect(secondMerge.resultValue).toBe(firstMerge.resultValue);
    expect(secondSpawn.value).toBe(firstSpawn.value);
    expect(secondSpawn.position).toEqual(firstSpawn.position);
    expect(first.context.state).toEqual({ run: 'first' });
    expect(second.context.state).toEqual({ run: 'second' });
  });
});

/* ==========================================================================
 * 7. Property 2a: onMerge multiplies scoreDelta and leaves resultValue alone
 * ========================================================================== */

describe('onMerge: gilded-rot multiplies scoreDelta, not resultValue', () => {
  it('multiplies the contribution and leaves resultValue unchanged', () => {
    // The vanilla baseline: the producer of js/game_manager.js L157 makes 4
    // out of two 2s, and the accrual of L167 adds that same 4 to the score.
    const arriving = mergeOf(2, 4, 4);
    const resolved = resolveMerge(bench, arriving);

    expect(resolved.scoreDelta).toBe(arriving.scoreDelta * SCORE_MULTIPLIER);
    expect(resolved.resultValue).toBe(arriving.resultValue);
  });

  it('multiplies a high merge by the same factor, not by a flat bonus', () => {
    const low = mergeOf(2, 4, 4);
    const high = mergeOf(512, 1024, 1024);
    const resolvedLow = resolveMerge(bench, low);
    const resolvedHigh = resolveMerge(createBench(), high);

    expect(resolvedLow.scoreDelta - low.scoreDelta).toBe(low.scoreDelta);
    expect(resolvedHigh.scoreDelta - high.scoreDelta).toBe(high.scoreDelta);
    expect(resolvedHigh.scoreDelta).toBe(high.scoreDelta * SCORE_MULTIPLIER);
    expect(resolvedHigh.scoreDelta / high.scoreDelta).toBe(
      resolvedLow.scoreDelta / low.scoreDelta,
    );
  });

  it('reads scoreDelta alone, so resultValue does not move the result', () => {
    const small = resolveMerge(bench, mergeOf(32, 64, 64));
    const large = resolveMerge(createBench(), mergeOf(512, 1024, 64));

    expect(small.scoreDelta).toBe(64 * SCORE_MULTIPLIER);
    expect(large.scoreDelta).toBe(small.scoreDelta);
    expect(small.resultValue).toBe(64);
    expect(large.resultValue).toBe(1024);
  });

  it('floors a product that is not whole', () => {
    const arriving = mergeOf(8, 16, 2.25);
    const resolved = resolveMerge(bench, arriving);

    expect(arriving.scoreDelta * SCORE_MULTIPLIER).toBe(4.5);
    expect(resolved.scoreDelta).toBe(4);
    expect(Number.isInteger(resolved.scoreDelta)).toBe(true);
    expect(resolved.resultValue).toBe(16);
  });

  it('leaves a whole product exactly as the multiplication produced it', () => {
    const resolved = resolveMerge(bench, mergeOf(8, 16, 2.5));

    expect(resolved.scoreDelta).toBe(5);
    expect(resolved.resultValue).toBe(16);
  });

  it('carries a contribution of zero across as zero, without throwing', () => {
    const resolved = resolveMerge(bench, mergeOf(2, 4, 0));

    expect(resolved.scoreDelta).toBe(0);
    expect(resolved.resultValue).toBe(4);
  });

  it('transforms nothing when the arriving contribution is not finite', () => {
    expect(dispatchMerge(bench, mergeOf(2, 4, Number.NaN))).toBeUndefined();
    expect(
      dispatchMerge(bench, mergeOf(2, 4, Number.POSITIVE_INFINITY)),
    ).toBeUndefined();
  });

  it('leaves both consumed tiles exactly as they arrived', () => {
    const source = tileAt(1, 0, 2);
    const target = tileAt(0, 0, 2);
    const resolved = resolveMerge(bench, {
      source,
      target,
      resultValue: 4,
      scoreDelta: 4,
    });

    expect(resolved.source).toBe(source);
    expect(resolved.target).toBe(target);
    expect([source.x, source.y, source.value]).toEqual([1, 0, 2]);
    expect([target.x, target.y, target.value]).toEqual([0, 0, 2]);
    expect(source.previousPosition).toBeNull();
    expect(target.previousPosition).toBeNull();
    expect(source.mergedFrom).toBeNull();
    expect(target.mergedFrom).toBeNull();
  });

  it('returns a payload rather than nothing on a finite contribution', () => {
    const returned = dispatchMerge(bench, mergeOf(2, 4, 4));

    expect(returned).toBeDefined();
    expect(typeof returned).toBe('object');
  });

  it('writes neither the board nor the rules while resolving a merge', () => {
    const lattice = bench.grid.serialize();
    const distribution = distributionOf(bench.config);

    resolveMerge(bench, mergeOf(2, 4, 4));

    expect(bench.grid.serialize()).toEqual(lattice);
    expect(distributionOf(bench.config)).toEqual(distribution);
    expect(bench.config.boardSize).toBe(4);
    expect(bench.config.winValue).toBe(2048);
    expect(bench.effectAttempts).toEqual([]);
  });

  it('multiplies again what an earlier dispatch already multiplied', () => {
    const first = resolveMerge(bench, mergeOf(2, 4, 4));
    const second = resolveMerge(bench, first);
    const third = resolveMerge(bench, second);

    expect(first.scoreDelta).toBe(4 * SCORE_MULTIPLIER);
    expect(second.scoreDelta).toBe(first.scoreDelta * SCORE_MULTIPLIER);
    expect(third.scoreDelta).toBe(second.scoreDelta * SCORE_MULTIPLIER);
    expect(third.resultValue).toBe(4);
  });
});

/* ==========================================================================
 * 8. Property 2b: onSpawn raises the value to the configured ceiling
 * ========================================================================== */

describe('onSpawn: gilded-rot raises the value to the live maximum', () => {
  it('raises the lowest spawnable value to the highest one', () => {
    const values = bench.config.spawn.values;
    const arriving = spawnOf({ x: 2, y: 1 }, floorOf(values));
    const resolved = resolveSpawn(bench, arriving);

    expect(resolved.value).toBe(ceilingOf(values));
    expect(resolved.value).not.toBe(arriving.value);
  });

  it('reads the ceiling from the rules in force, not from a literal', () => {
    bench.config.spawn.values = [...LONGER_SPAWN_VALUES];
    bench.config.spawn.weights = [...LONGER_SPAWN_WEIGHTS];

    const resolved = resolveSpawn(bench, spawnOf({ x: 0, y: 0 }, 2));

    expect(resolved.value).toBe(16);
    expect(resolved.value).toBe(ceilingOf(bench.config.spawn.values));
  });

  it('follows the ceiling down when the ladder is shortened', () => {
    bench.config.spawn.values = [2];
    bench.config.spawn.weights = [1];

    expect(dispatchSpawn(bench, spawnOf({ x: 0, y: 0 }, 2))).toBeUndefined();

    bench.config.spawn.values = [2, 8];
    bench.config.spawn.weights = [0.9, 0.1];

    expect(resolveSpawn(bench, spawnOf({ x: 0, y: 0 }, 2)).value).toBe(8);
  });

  it('holds a spawn already at the ceiling at the ceiling', () => {
    const ceiling = ceilingOf(bench.config.spawn.values);
    const arriving = spawnOf({ x: 1, y: 2 }, ceiling);

    expect(dispatchSpawn(bench, arriving)).toBeUndefined();
    expect(arriving.value).toBe(ceiling);
  });

  it('does not climb past the ceiling when dispatched twice', () => {
    const ceiling = ceilingOf(bench.config.spawn.values);
    const once = resolveSpawn(
      bench,
      spawnOf({ x: 3, y: 0 }, floorOf(bench.config.spawn.values)),
    );

    expect(once.value).toBe(ceiling);
    expect(dispatchSpawn(bench, once)).toBeUndefined();
    expect(once.value).toBe(ceiling);
  });

  it('carries the cell across untouched, as the same coordinates', () => {
    const position: Position = { x: 2, y: 3 };
    const resolved = resolveSpawn(bench, spawnOf(position, 2));

    expect(resolved.position).toBe(position);
    expect(resolved.position).toEqual({ x: 2, y: 3 });
  });

  it('carries a spawn that arrived with no cell across unchanged', () => {
    // js/grid.js L37-L43 returns no cell on a full board, which is the case
    // `SpawnPayload.position` is optional for. The handler transforms nothing
    // here, so the payload the dispatch carries forward is the one that
    // arrived, and no cell is invented for it.
    const arriving = spawnOf(undefined, 2);
    const returned = dispatchSpawn(bench, arriving);

    expect(returned).toBeUndefined();
    expect(arriving.position).toBeUndefined();
    expect(arriving.value).toBe(2);
  });

  it('rewrites neither the spawn values nor the spawn weights', () => {
    const distribution = distributionOf(bench.config);

    resolveSpawn(bench, spawnOf({ x: 0, y: 3 }, 2));

    expect(distributionOf(bench.config)).toEqual(distribution);
    expect(bench.config.spawn.values).toEqual([2, 4]);
    expect(bench.config.spawn.weights).toEqual([0.9, 0.1]);
  });

  it('returns a payload rather than nothing when it raises a value', () => {
    const returned = dispatchSpawn(bench, spawnOf({ x: 1, y: 1 }, 2));

    expect(returned).toBeDefined();
    expect(typeof returned).toBe('object');
  });

  it('writes neither the board nor the rules while raising a spawn', () => {
    const lattice = bench.grid.serialize();

    resolveSpawn(bench, spawnOf({ x: 2, y: 2 }, 2));

    expect(bench.grid.serialize()).toEqual(lattice);
    expect(bench.grid.size).toBe(4);
    expect(bench.config.boardSize).toBe(4);
    expect(bench.effectAttempts).toEqual([]);
  });
});

/* ==========================================================================
 * 9. Property 3: charges
 *
 * The five charge-bearing relics are `frostbind` and the four of
 * board-manipulation. `gilded-rot` is not one of them, and the guard that
 * skips a spent subscriber lives in src/engine/hook-bus.ts, which
 * tests/unit/engine/ asserts. What is asserted here is the relic's own half:
 * it declares no budget, neither handler reads one, and neither handler is
 * harmed by being invoked while a budget stands at zero.
 * ========================================================================== */

describe('gilded-rot carries no charge budget and reads none', () => {
  it('declares no charges member at all, absent rather than null', () => {
    expect('charges' in relicUnderTest()).toBe(false);
    expect(relicUnderTest().charges).toBeUndefined();
  });

  it('names charges, Math.random, catch and console in neither handler', () => {
    const sources: readonly string[] = [
      mergeHandler().toString(),
      spawnHandler().toString(),
    ];

    expect(sources.length).toBe(2);

    for (const source of sources) {
      expect(source.length).not.toBe(0);

      for (const token of FORBIDDEN_HANDLER_TOKENS) {
        expect(source).not.toContain(token);
      }
    }
  });

  it('requests no charge on either hook', () => {
    resolveMerge(bench, mergeOf(2, 4, 4));
    resolveSpawn(bench, spawnOf({ x: 2, y: 1 }, 2));

    expect(bench.chargeRequests).toEqual([]);
  });

  it('still resolves both hooks when the context reports zero charges', () => {
    const spent = createBench(0);
    const merge = resolveMerge(spent, mergeOf(2, 4, 4));
    const spawn = resolveSpawn(spent, spawnOf({ x: 2, y: 1 }, 2));

    expect(spent.context.charges).toBe(0);
    expect(merge.scoreDelta).toBe(4 * SCORE_MULTIPLIER);
    expect(spawn.value).toBe(ceilingOf(spent.config.spawn.values));
  });

  it('corrupts nothing when invoked with a spent budget', () => {
    const spent = createBench(0);
    const lattice = spent.grid.serialize();
    const distribution = distributionOf(spent.config);
    let merge: MergePayload | undefined;
    let spawn: SpawnPayload | undefined;

    spent.context.state = { run: 'spent budget' };

    expect(() => {
      merge = resolveMerge(spent, mergeOf(2, 4, 4));
    }).not.toThrow();
    expect(() => {
      spawn = resolveSpawn(spent, spawnOf({ x: 3, y: 3 }, 2));
    }).not.toThrow();

    expect(merge?.scoreDelta).toBe(4 * SCORE_MULTIPLIER);
    expect(merge?.resultValue).toBe(4);
    expect(spawn?.value).toBe(ceilingOf(spent.config.spawn.values));
    expect(spawn?.position).toEqual({ x: 3, y: 3 });
    expect(spent.grid.serialize()).toEqual(lattice);
    expect(distributionOf(spent.config)).toEqual(distribution);
    expect(spent.context.state).toEqual({ run: 'spent budget' });
    expect(spent.context.charges).toBe(0);
    expect(spent.chargeRequests).toEqual([]);
    expect(spent.effectAttempts).toEqual([]);
  });

  it('throws on neither hook where a spent budget transforms nothing', () => {
    const spent = createBench(0);

    expect(() => dispatchSpawn(spent, spawnOf(undefined, 2))).not.toThrow();
    expect(() =>
      dispatchMerge(spent, mergeOf(2, 4, Number.NaN)),
    ).not.toThrow();

    expect(dispatchSpawn(spent, spawnOf(undefined, 2))).toBeUndefined();
    expect(dispatchMerge(spent, mergeOf(2, 4, Number.NaN))).toBeUndefined();
    expect(spent.effectAttempts).toEqual([]);
    expect(spent.chargeRequests).toEqual([]);
  });
});

/* ==========================================================================
 * 10. Determinism: neither half consumes randomness
 * ========================================================================== */

describe('gilded-rot consumes no randomness on either hook', () => {
  it('opens every one of the four substreams at zero', () => {
    const cursors = bench.streams.snapshotCursors();

    expect(Object.keys(cursors).sort()).toEqual([...RNG_STREAM_NAMES].sort());

    for (const name of RNG_STREAM_NAMES) {
      expect(cursors[name]).toBe(0);
    }
  });

  it('leaves every cursor where it stood across an onMerge dispatch', () => {
    const before: RngCursorMap = bench.streams.snapshotCursors();

    resolveMerge(bench, mergeOf(2, 4, 4));

    const after: RngCursorMap = bench.streams.snapshotCursors();

    for (const name of RNG_STREAM_NAMES) {
      expect(after[name]).toBe(before[name]);
    }

    expect(after).toEqual(before);
  });

  it('leaves every cursor where it stood across an onSpawn dispatch', () => {
    const before: RngCursorMap = bench.streams.snapshotCursors();

    resolveSpawn(bench, spawnOf({ x: 2, y: 1 }, 2));

    const after: RngCursorMap = bench.streams.snapshotCursors();

    for (const name of RNG_STREAM_NAMES) {
      expect(after[name]).toBe(before[name]);
    }

    expect(after).toEqual(before);
  });

  it('takes no draw on a dispatch it transforms nothing on', () => {
    const ceiling = ceilingOf(bench.config.spawn.values);
    const before: RngCursorMap = bench.streams.snapshotCursors();

    dispatchSpawn(bench, spawnOf(undefined, 2));
    dispatchSpawn(bench, spawnOf({ x: 0, y: 0 }, ceiling));
    dispatchMerge(bench, mergeOf(2, 4, Number.NaN));

    expect(bench.streams.snapshotCursors()).toEqual(before);
  });

  it('takes no draw on the longer ladder either', () => {
    bench.config.spawn.values = [...LONGER_SPAWN_VALUES];
    bench.config.spawn.weights = [...LONGER_SPAWN_WEIGHTS];

    const before: RngCursorMap = bench.streams.snapshotCursors();

    expect(resolveSpawn(bench, spawnOf({ x: 1, y: 1 }, 2)).value).toBe(16);
    expect(bench.streams.snapshotCursors()).toEqual(before);
  });

  it('carries the run seed and the correlation identifier unchanged', () => {
    resolveMerge(bench, mergeOf(2, 4, 4));
    resolveSpawn(bench, spawnOf({ x: 2, y: 1 }, 2));

    expect(bench.context.rng.seed).toBe(SUITE_SEED);
    expect(bench.context.correlationId).toBe(SUITE_CORRELATION_ID);
    expect(bench.context.subscriberId).toBe(SUBSCRIBER_ID);
    expect(bench.context.pickupOrder).toBe(PICKUP_ORDER);
  });
});

/* ==========================================================================
 * 11. What the suite leaves behind
 * ========================================================================== */

describe('the catalogue and the vanilla defaults outlive the suite', () => {
  it('leaves the declaration frozen and its handler table intact', () => {
    const declared = relicUnderTest();

    expect(Object.isFrozen(declared)).toBe(true);
    expect(Object.isFrozen(declared.hooks)).toBe(true);
    expect(declared.hooks.onMerge).toBe(DECLARED_MERGE_HANDLER);
    expect(declared.hooks.onSpawn).toBe(DECLARED_SPAWN_HANDLER);
    expect(declared).toBe(DECLARED_RELIC);
  });

  it('leaves the vanilla defaults reporting the distribution of L71', () => {
    const fresh = createDefaultRulesConfig();

    expect(fresh.spawn.values).toEqual([2, 4]);
    expect(fresh.spawn.weights).toEqual([0.9, 0.1]);
    expect(fresh.boardSize).toBe(4);
    expect(fresh.winValue).toBe(2048);
    expect(fresh.startTiles).toBe(2);
  });
});
