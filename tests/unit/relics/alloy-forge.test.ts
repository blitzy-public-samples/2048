// Isolation suite for the `merge-magic` relic `alloy-forge`, AAP 0.6.3
// Group 5: the three properties every per-relic suite pins — the hooks the
// relic fires on, the effect it produces, and its charge behaviour including
// an invocation made at a spent budget.
//
// The unit under test is the `alloy-forge` entry of `MERGE_MAGIC_FAMILY` in
// src/relics/families/merge-magic.ts. Its handler is invoked directly, over a
// `HookContext` assembled here from a fresh `RulesConfig`, a live `Grid`, the
// run's named substreams and the run correlation identifier.
// src/engine/hook-bus.ts owns the charge guard, the dispatch order and the
// error isolation, and tests/unit/engine holds those mechanism suites.
//
// PROVENANCE of the arithmetic under test, from the vanilla merge branch:
//
//   js/game_manager.js L156  `next && next.value === tile.value &&
//                            !next.mergedFrom`
//                            -> `config.merge.canMerge`.
//   js/game_manager.js L157  `new Tile(positions.next, tile.value * 2)`
//                            -> `config.merge.produce`, the producer this
//                               relic applies a SECOND time. Every expected
//                               number below is computed by calling
//                               `defaultProduceMergeValue`; none restates the
//                               doubling as a literal.
//   js/game_manager.js L167  `self.score += merged.value`
//                            -> the payload's `scoreDelta`, dispatched equal
//                               to `resultValue`.
//   js/game_manager.js L170  `if (merged.value === 2048) self.won = true`
//                            -> `config.winValue`. The win flag is resolved in
//                               src/engine/terminal-state.ts and is asserted
//                               in tests/unit/engine, not here.
//
// The dispatch driven here is drawn in Figure 5, "Hook Dispatch Sequence:
// Pickup-Order Fan-Out with Charge Guard and Error Isolation"
// (docs/architecture/hook-dispatch-sequence.md), in which `alloy-forge` is the
// second handler of the compounding chain. The turn steps it occupies are the
// `Merge condition from config.merge.canMerge` and `onMerge dispatch - score
// delta applied` nodes of Figure 4, "Turn Data Flow"
// (docs/architecture/data-flow.md).
//
// Traceability row of docs/TRACEABILITY_MATRIX.md evidenced here:
//   TR-MERGE-02  the `alloy-forge` declaration and its `onMerge` binding
//
// Decisions this suite holds to the letter, argued in docs/DECISION_LOG.md and
// named here only so the construct can be found from the log:
//   DL-MERGE-01  all four merge-magic relics bound to `onMerge` alone
//   DL-MERGE-02  `scoreDelta` transformed independently of `resultValue`
//
// This file reads no DOM, no clock and no storage, takes no unseeded
// randomness, installs no timer and writes no log. It is collected by the
// `unit:dom-free` project of vitest.config.ts and runs under `npm test`.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  createDefaultRulesConfig,
  defaultCanMerge,
  defaultProduceMergeValue,
} from '../../../src/config/default-config';
import type {
  MergePredicate,
  MergeProducer,
  MergeTileView,
  RulesConfig,
} from '../../../src/config/rules-config';
import { Grid } from '../../../src/engine/grid';
import { HOOK_NAMES } from '../../../src/engine/hooks';
import type {
  BoardEffectQueue,
  HookContext,
  HookHandler,
  MergePayload,
  ReadonlyGridView,
} from '../../../src/engine/hooks';
import { Tile } from '../../../src/engine/tile';
import type {
  CorrelationId,
  Position,
  SerializedGrid,
} from '../../../src/engine/types';
import { MERGE_MAGIC_FAMILY } from '../../../src/relics/families/merge-magic';
import { findRelicById } from '../../../src/relics/relic-registry';
import { RARITIES } from '../../../src/relics/relic-types';
import type { Rarity, Relic } from '../../../src/relics/relic-types';
import {
  RNG_STREAM_NAMES,
  createRngStreams,
} from '../../../src/rng/rng-streams';
import type { RngStreams } from '../../../src/rng/rng-streams';
import { MERGE_PAIR_BOARD } from '../../fixtures/boards';

/* ==========================================================================
 * 1. Suite constants
 * ========================================================================== */

/** Identifier the family declares this relic under. */
const RELIC_ID = 'alloy-forge';

/** Fixed seed every substream in this suite is derived from. */
const SUITE_SEED = 'alloy-forge-isolation';

/** Run correlation identifier every context below carries. */
const SUITE_CORRELATION_ID: CorrelationId = 'run-alloy-forge-isolation';

/** Subscriber identity the dispatch is attributed to. */
const SUBSCRIBER_ID = 'alloy-forge';

/** Pickup position the dispatch is attributed to. */
const PICKUP_ORDER = 1;

/**
 * Value of the pair `MERGE_PAIR_BOARD` places at (0, 0) and (1, 0), which is
 * the pair js/game_manager.js L156 admitted as a merge.
 */
const PAIR_VALUE = 2;

/** Cell the moving tile of the pair occupies. */
const SOURCE_CELL: Position = { x: 1, y: 0 };

/** Cell the merge resolves on. */
const TARGET_CELL: Position = { x: 0, y: 0 };

/**
 * Merge value dispatched by the win-value case: one further application of the
 * default producer reaches `config.winValue`.
 */
const NEAR_WIN_RESULT = 1024;

/** Factor of the substituted producer that scales rather than doubles. */
const TRIPLE_FACTOR = 3;

/** Addend of the substituted producer that steps rather than scales. */
const CONSTANT_STEP = 6;

/** Value written into the state slot before every dispatch. */
const STATE_SENTINEL = 'alloy-forge-slot-untouched';

/** Charge budget of the spent-budget cases. */
const SPENT_BUDGET = 0;

/* ==========================================================================
 * 2. Merge-rule access
 * ========================================================================== */

/**
 * Projects a face value onto the operand shape the merge rules read, as
 * `mergeOperand` of src/relics/families/merge-magic.ts projects it: the value
 * alone, with no merge recorded against it.
 *
 * @param value Face value to project.
 * @returns An operand carrying `value` and no merge history.
 */
function operandOf(value: number): MergeTileView {
  return { value, mergedFrom: null };
}

/**
 * Applies a producer to a face value the way the relic applies it: both
 * operands are the same projected value.
 *
 * @param produce Producer to apply.
 * @param value Face value to raise.
 * @returns The value the producer yields.
 */
function raiseWith(produce: MergeProducer, value: number): number {
  const operand = operandOf(value);

  return produce(operand, operand);
}

/**
 * Producer that scales by `TRIPLE_FACTOR`.
 *
 * @param moving Operand the value is read from.
 * @returns Three times the operand's value.
 */
function tripleProducer(moving: MergeTileView): number {
  return moving.value * TRIPLE_FACTOR;
}

/**
 * Producer that adds `CONSTANT_STEP` rather than scaling.
 *
 * @param moving Operand the value is read from.
 * @returns The operand's value plus the constant step.
 */
function constantStepProducer(moving: MergeTileView): number {
  return moving.value + CONSTANT_STEP;
}

/**
 * Producer that yields the value it was given, which is no rise.
 *
 * @param moving Operand the value is read from.
 * @returns The operand's own value.
 */
function nonRisingProducer(moving: MergeTileView): number {
  return moving.value;
}

/**
 * Producer that yields no finite value.
 *
 * @returns Positive infinity.
 */
function nonFiniteProducer(): number {
  return Number.POSITIVE_INFINITY;
}

/* ==========================================================================
 * 3. The merge as it arrives at the hook
 * ========================================================================== */

/**
 * Face value the merge of the pair already carries when `onMerge` is
 * dispatched: the producer of js/game_manager.js L157 applied once.
 */
const BASELINE_RESULT = raiseWith(defaultProduceMergeValue, PAIR_VALUE);

/**
 * Score the merge already carries when `onMerge` is dispatched. Equal to
 * `BASELINE_RESULT`, which is what js/game_manager.js L167 accrued.
 */
const BASELINE_SCORE = BASELINE_RESULT;

/* ==========================================================================
 * 4. The relic under test
 * ========================================================================== */

/**
 * Reads the `alloy-forge` declaration out of the family it is declared in.
 *
 * @returns The declaration, or `undefined` where the family declares no relic
 *   under that identifier.
 */
function findInFamily(): Relic | undefined {
  return MERGE_MAGIC_FAMILY.relics.find((relic) => relic.id === RELIC_ID);
}

/**
 * Reads the `alloy-forge` declaration, failing loudly where the family no
 * longer declares it.
 *
 * @returns The declaration.
 * @throws {Error} If the family declares no relic under `RELIC_ID`.
 */
function requireRelic(): Relic {
  const relic = findInFamily();

  if (relic === undefined) {
    throw new Error(
      `MERGE_MAGIC_FAMILY declares no relic under the id ${RELIC_ID}.`,
    );
  }

  return relic;
}

/**
 * Reads the relic's `onMerge` handler, failing loudly where the binding is
 * gone.
 *
 * @param relic Declaration to read.
 * @returns The bound handler.
 * @throws {Error} If the relic binds no `onMerge` handler.
 */
function requireMergeHandler(relic: Relic): HookHandler<'onMerge'> {
  const handler = relic.hooks.onMerge;

  if (handler === undefined) {
    throw new Error(`Relic ${RELIC_ID} binds no onMerge handler.`);
  }

  return handler;
}

/* ==========================================================================
 * 5. The hand-assembled dispatch context
 * ========================================================================== */

/** A board-effect queue paired with the log of the calls made on it. */
interface EffectLog {
  /** The queue handed to the context. */
  readonly queue: BoardEffectQueue;

  /** Name of every command recorded against the queue, in call order. */
  readonly calls: readonly string[];
}

/**
 * Builds a board-effect queue that accepts nothing and logs every call made on
 * it. A board command a relic records appears in the log under the command's
 * own name.
 *
 * @param grid Board the read members resolve against.
 * @returns The queue and its call log.
 */
function createRecordingEffects(grid: Grid): EffectLog {
  const calls: string[] = [];
  const record = (name: string): boolean => {
    calls.push(name);

    return false;
  };

  const queue: BoardEffectQueue = {
    size: grid.size,
    length: 0,
    refused: 0,
    insertTile: (): boolean => record('insertTile'),
    removeTile: (): boolean => record('removeTile'),
    moveTile: (): boolean => record('moveTile'),
    restoreBoard: (): boolean => record('restoreBoard'),
    resizeBoard: (): boolean => record('resizeBoard'),
    setMergePredicate: (): boolean => record('setMergePredicate'),
    setSpawnWeights: (): boolean => record('setSpawnWeights'),
    request: (): boolean => record('request'),
    requested: () => [],
    cellValue: (): number | null => null,
    cellOccupied: (): boolean => false,
    availableCells: (): Position[] => grid.availableCells(),
    occupiedCells: () => [],
    clear: (): void => {
      calls.push('clear');
    },
  };

  return { queue, calls };
}

/**
 * Builds the query-only board view a handler is handed. `cellValue` stands in
 * for `cellContent`: the face value of a cell rather than the tile in it.
 *
 * @param grid Live board the view reads.
 * @returns The view, resolving every read against the live board.
 */
function createGridView(grid: Grid): ReadonlyGridView {
  return {
    get size(): number {
      return grid.size;
    },
    withinBounds: (position: Position): boolean => grid.withinBounds(position),
    cellAvailable: (cell: Position): boolean => grid.cellAvailable(cell),
    cellOccupied: (cell: Position): boolean => grid.cellOccupied(cell),
    cellValue: (cell: Position): number | null =>
      grid.cellContent(cell)?.value ?? null,
    availableCells: (): Position[] => grid.availableCells(),
    cellsAvailable: (): boolean => grid.cellsAvailable(),
    serialize: (): SerializedGrid => grid.serialize(),
  };
}

/** One assembled dispatch, with every collaborator reachable for assertion. */
interface Harness {
  readonly relic: Relic;
  readonly handler: HookHandler<'onMerge'>;

  /** The live rules the context reads, replaceable member by member. */
  readonly config: RulesConfig;

  /** The live board the context's view reads. */
  readonly grid: Grid;

  /** The run's named substreams, reached as the context's randomness. */
  readonly streams: RngStreams;

  /** Name of every board command recorded during the dispatch. */
  readonly effectCalls: readonly string[];

  /** Amount of every charge the handler asked for, in request order. */
  readonly chargeRequests: readonly number[];

  /** The context handed to the handler. */
  readonly context: HookContext;
}

/**
 * Assembles one dispatch: a fresh live `RulesConfig`, the merge-pair board, the
 * run's substreams derived from `SUITE_SEED`, a logging board-effect queue, the
 * run correlation identifier, and a state slot carrying `STATE_SENTINEL`.
 *
 * @param charges Charge budget the context reports. Omitted, the context
 *   carries no budget, which is what this relic's declaration produces.
 * @returns The assembled dispatch.
 */
function createHarness(charges?: number): Harness {
  const relic = requireRelic();
  const config = createDefaultRulesConfig();
  const grid = new Grid(config.boardSize, MERGE_PAIR_BOARD.grid.cells);
  const streams = createRngStreams(SUITE_SEED);
  const effects = createRecordingEffects(grid);
  const chargeRequests: number[] = [];

  const context: HookContext = {
    config,
    rng: streams,
    grid: createGridView(grid),
    effects: effects.queue,
    correlationId: SUITE_CORRELATION_ID,
    hook: 'onMerge',
    subscriberId: SUBSCRIBER_ID,
    pickupOrder: PICKUP_ORDER,
    charges,
    spendCharge: (amount = 1): boolean => {
      chargeRequests.push(amount);

      return false;
    },
    state: STATE_SENTINEL,
  };

  return {
    relic,
    handler: requireMergeHandler(relic),
    config,
    grid,
    streams,
    effectCalls: effects.calls,
    chargeRequests,
    context,
  };
}

/* ==========================================================================
 * 6. Payloads and comparators
 * ========================================================================== */

/** One merge payload with the two live tiles it projects. */
interface MergeCase {
  readonly payload: MergePayload;
  readonly source: Tile;
  readonly target: Tile;
}

/**
 * Builds a merge payload over two freshly constructed tiles. The payload is
 * frozen: none of its members can be written in place, and a transformed
 * payload reaches the caller as the handler's return value alone.
 *
 * @param resultValue Value the merge already produces.
 * @param scoreDelta Score the merge already accrues.
 * @returns The payload and the two tiles it projects.
 */
function createMergeCase(resultValue: number, scoreDelta: number): MergeCase {
  const source = new Tile(SOURCE_CELL, PAIR_VALUE);
  const target = new Tile(TARGET_CELL, PAIR_VALUE);

  return {
    source,
    target,
    payload: Object.freeze({ source, target, resultValue, scoreDelta }),
  };
}

/** The merge payload of the baseline case, dispatched by most tests below. */
function baselineCase(): MergeCase {
  return createMergeCase(BASELINE_RESULT, BASELINE_SCORE);
}

/**
 * Invokes the handler and requires a payload back.
 *
 * @param harness Assembled dispatch to invoke.
 * @param payload Payload to dispatch.
 * @returns The payload the handler returned.
 * @throws {Error} If the handler returned nothing.
 */
function dispatch(harness: Harness, payload: MergePayload): MergePayload {
  const returned: MergePayload | void = harness.handler(
    payload,
    harness.context,
  );

  if (returned === undefined) {
    throw new Error(`Relic ${RELIC_ID} returned no payload from onMerge.`);
  }

  return returned;
}

/** Every rule of a config, flattened for comparison. */
interface RulesSnapshot {
  readonly boardSize: number;
  readonly winValue: number;
  readonly startTiles: number;
  readonly spawnValues: readonly number[];
  readonly spawnWeights: readonly number[];
  readonly canMerge: MergePredicate;
  readonly produce: MergeProducer;
}

/**
 * Flattens the rules in force, copying both spawn arrays and carrying both
 * merge members by reference.
 *
 * @param config Rules to read.
 * @returns A fresh snapshot.
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

/** The declared members of a relic, flattened for comparison. */
interface DeclarationSnapshot {
  readonly id: string;
  readonly name: string;
  readonly rarity: Rarity;
  readonly description: string;
  readonly hookNames: readonly string[];
  readonly onMerge: HookHandler<'onMerge'> | undefined;
  readonly declaresCharges: boolean;
  readonly declaresState: boolean;
}

/**
 * Flattens a declaration, recording whether the two optional members are
 * declared at all rather than what they hold.
 *
 * @param relic Declaration to read.
 * @returns A fresh snapshot.
 */
function snapshotDeclaration(relic: Relic): DeclarationSnapshot {
  return {
    id: relic.id,
    name: relic.name,
    rarity: relic.rarity,
    description: relic.description,
    hookNames: Object.keys(relic.hooks),
    onMerge: relic.hooks.onMerge,
    declaresCharges: 'charges' in relic,
    declaresState: 'state' in relic,
  };
}

/** The declaration as it stood when this module was imported. */
const DECLARED_AT_IMPORT = snapshotDeclaration(requireRelic());

/** The dispatch under test, rebuilt before every test below. */
let harness: Harness = createHarness();

beforeEach(() => {
  harness = createHarness();
});

/* ==========================================================================
 * 7. The declaration is reachable, and it is the catalogue's own object
 * ========================================================================== */

describe('the alloy-forge declaration', () => {
  it('is declared by the merge-magic family under the id alloy-forge', () => {
    expect(findInFamily()).toBeDefined();
    expect(requireRelic().id).toBe(RELIC_ID);
  });

  it('is the same object findRelicById resolves for that id', () => {
    expect(findRelicById(RELIC_ID)).toBe(requireRelic());
  });

  it('carries a name, a description and a rarity drawn from RARITIES', () => {
    const relic = requireRelic();

    expect(relic.name).toBe('Alloy Forge');
    expect(typeof relic.description).toBe('string');
    expect(relic.description).not.toBe('');
    expect(RARITIES).toContain(relic.rarity);
  });

  it('is frozen, declaration and hooks table alike', () => {
    const relic = requireRelic();

    expect(Object.isFrozen(relic)).toBe(true);
    expect(Object.isFrozen(relic.hooks)).toBe(true);
  });
});

/* ==========================================================================
 * 8. Property 1 — it fires only on the hooks it binds
 * ========================================================================== */

describe('alloy-forge fires only on the hooks it binds', () => {
  it('binds onMerge and no other hook', () => {
    expect(Object.keys(requireRelic().hooks)).toEqual(['onMerge']);
  });

  it('binds only names that are members of HOOK_NAMES', () => {
    const bound = Object.keys(requireRelic().hooks);

    expect(bound).not.toEqual([]);

    for (const name of bound) {
      expect(HOOK_NAMES).toContain(name);
    }
  });

  it('omits every hook it does not bind, absent rather than undefined', () => {
    const hooks = requireRelic().hooks;

    for (const name of HOOK_NAMES) {
      expect(name in hooks).toBe(name === 'onMerge');
    }
  });

  it('does not bind onSpawn and does not bind onStageEnd', () => {
    const hooks = requireRelic().hooks;

    expect('onSpawn' in hooks).toBe(false);
    expect('onStageEnd' in hooks).toBe(false);
    expect(hooks.onSpawn).toBeUndefined();
    expect(hooks.onStageEnd).toBeUndefined();
  });

  it('binds a function to every hook name it declares', () => {
    const hooks = requireRelic().hooks;

    for (const name of HOOK_NAMES) {
      if (name in hooks) {
        expect(typeof hooks[name]).toBe('function');
      }
    }
  });
});

/* ==========================================================================
 * 9. Property 2 — the specified effect
 * ========================================================================== */

describe(
  'alloy-forge applies the live config.merge.produce a second time and ' +
    'adds only the resulting increment to scoreDelta',
  () => {
    it('raises resultValue to a second application of the producer', () => {
      const merge = baselineCase();
      const returned = dispatch(harness, merge.payload);

      expect(returned.resultValue).toBe(
        raiseWith(defaultProduceMergeValue, BASELINE_RESULT),
      );
    });

    it('adds the increment alone, never the whole raised value', () => {
      const merge = baselineCase();
      const raised = raiseWith(defaultProduceMergeValue, BASELINE_RESULT);
      const increment = raised - BASELINE_RESULT;
      const returned = dispatch(harness, merge.payload);

      expect(returned.scoreDelta).toBe(BASELINE_SCORE + increment);
      expect(returned.scoreDelta).not.toBe(BASELINE_SCORE + raised);
    });

    it('follows a producer substituted on the live rules', () => {
      const merge = baselineCase();

      harness.config.merge.produce = tripleProducer;

      const raised = raiseWith(tripleProducer, BASELINE_RESULT);
      const returned = dispatch(harness, merge.payload);

      expect(returned.resultValue).toBe(raised);
      expect(returned.scoreDelta).toBe(
        BASELINE_SCORE + (raised - BASELINE_RESULT),
      );
      expect(returned.resultValue).not.toBe(
        raiseWith(defaultProduceMergeValue, BASELINE_RESULT),
      );
    });

    it('follows a substituted producer that steps rather than scales', () => {
      const merge = baselineCase();

      harness.config.merge.produce = constantStepProducer;

      const raised = raiseWith(constantStepProducer, BASELINE_RESULT);
      const returned = dispatch(harness, merge.payload);

      expect(returned.resultValue).toBe(raised);
      expect(returned.scoreDelta).toBe(
        BASELINE_SCORE + (raised - BASELINE_RESULT),
      );
    });

    it('returns the arriving payload where the producer yields no rise', () => {
      const merge = baselineCase();

      harness.config.merge.produce = nonRisingProducer;

      const returned = dispatch(harness, merge.payload);

      expect(returned).toBe(merge.payload);
      expect(returned.resultValue).toBe(BASELINE_RESULT);
      expect(returned.scoreDelta).toBe(BASELINE_SCORE);
    });

    it('returns the arriving payload on a non-finite producer', () => {
      const merge = baselineCase();

      harness.config.merge.produce = nonFiniteProducer;

      const returned = dispatch(harness, merge.payload);

      expect(returned).toBe(merge.payload);
      expect(returned.resultValue).toBe(BASELINE_RESULT);
      expect(returned.scoreDelta).toBe(BASELINE_SCORE);
    });

    it('hands forward a resultValue that reaches the win value', () => {
      const merge = createMergeCase(NEAR_WIN_RESULT, NEAR_WIN_RESULT);
      const raised = raiseWith(defaultProduceMergeValue, NEAR_WIN_RESULT);
      const returned = dispatch(harness, merge.payload);

      expect(returned.resultValue).toBe(raised);
      expect(returned.resultValue).toBe(harness.config.winValue);
      expect(returned.scoreDelta).toBe(
        NEAR_WIN_RESULT + (raised - NEAR_WIN_RESULT),
      );
      expect(returned.scoreDelta).not.toBe(NEAR_WIN_RESULT + raised);
      expect('won' in returned).toBe(false);
    });

    it('leaves both merged tiles exactly as they arrived', () => {
      const merge = baselineCase();

      dispatch(harness, merge.payload);

      expect(merge.source.value).toBe(PAIR_VALUE);
      expect(merge.target.value).toBe(PAIR_VALUE);
      expect(merge.source.x).toBe(SOURCE_CELL.x);
      expect(merge.source.y).toBe(SOURCE_CELL.y);
      expect(merge.target.x).toBe(TARGET_CELL.x);
      expect(merge.target.y).toBe(TARGET_CELL.y);
      expect(merge.source.previousPosition).toBeNull();
      expect(merge.target.previousPosition).toBeNull();
      expect(merge.source.mergedFrom).toBeNull();
      expect(merge.target.mergedFrom).toBeNull();
    });

    it('leaves the board it was dispatched over unchanged', () => {
      const before = harness.grid.serialize();

      dispatch(harness, baselineCase().payload);

      expect(harness.grid.serialize()).toEqual(before);
      expect(harness.grid.size).toBe(before.size);
    });

    it('leaves every rule on the live rules object unchanged', () => {
      const before = snapshotRules(harness.config);

      dispatch(harness, baselineCase().payload);

      expect(snapshotRules(harness.config)).toEqual(before);
      expect(harness.config.merge.produce).toBe(defaultProduceMergeValue);
      expect(harness.config.merge.canMerge).toBe(defaultCanMerge);
    });

    it('records no board effect and writes no state slot', () => {
      dispatch(harness, baselineCase().payload);

      expect(harness.effectCalls).toEqual([]);
      expect(harness.context.state).toBe(STATE_SENTINEL);
    });

    it('leaves the dispatch identity, correlation id included, intact', () => {
      dispatch(harness, baselineCase().payload);

      expect(harness.context.correlationId).toBe(SUITE_CORRELATION_ID);
      expect(harness.context.hook).toBe('onMerge');
      expect(harness.context.subscriberId).toBe(SUBSCRIBER_ID);
      expect(harness.context.pickupOrder).toBe(PICKUP_ORDER);
    });

    it('returns a payload rather than nothing', () => {
      const merge = baselineCase();
      const returned = harness.handler(merge.payload, harness.context);

      expect(returned).not.toBeUndefined();
      expect(returned).not.toBe(merge.payload);
    });

    it('compounds across two dispatches, each adding its own increment', () => {
      const merge = baselineCase();
      const firstRaised = raiseWith(defaultProduceMergeValue, BASELINE_RESULT);
      const secondRaised = raiseWith(defaultProduceMergeValue, firstRaised);

      const first = dispatch(harness, merge.payload);
      const second = dispatch(harness, first);

      expect(first.resultValue).toBe(firstRaised);
      expect(first.scoreDelta).toBe(
        BASELINE_SCORE + (firstRaised - BASELINE_RESULT),
      );
      expect(second.resultValue).toBe(secondRaised);
      expect(second.scoreDelta).toBe(
        first.scoreDelta + (secondRaised - firstRaised),
      );
      expect(second.source).toBe(merge.source);
      expect(second.target).toBe(merge.target);
    });
  },
);

/* ==========================================================================
 * 10. Property 3 — charges, including an invocation at a spent budget
 * ========================================================================== */

describe('alloy-forge carries no charge budget and consults none', () => {
  it('declares no charges member, absent rather than null', () => {
    const relic = requireRelic();

    expect('charges' in relic).toBe(false);
    expect(relic.charges).toBeUndefined();
  });

  it('declares no state member, absent rather than null', () => {
    const relic = requireRelic();

    expect('state' in relic).toBe(false);
    expect(relic.state).toBeUndefined();
  });

  it('names charges nowhere in its handler', () => {
    expect(requireMergeHandler(requireRelic()).toString()).not.toContain(
      'charges',
    );
  });

  it('requests no charge from the dispatch context', () => {
    dispatch(harness, baselineCase().payload);

    expect(harness.chargeRequests).toEqual([]);
  });

  it('neither throws nor changes its result at a spent budget', () => {
    const spent = createHarness(SPENT_BUDGET);
    const raised = raiseWith(defaultProduceMergeValue, BASELINE_RESULT);

    expect(spent.context.charges).toBe(SPENT_BUDGET);
    expect(() =>
      spent.handler(baselineCase().payload, spent.context),
    ).not.toThrow();

    const returned = dispatch(spent, baselineCase().payload);

    expect(returned.resultValue).toBe(raised);
    expect(returned.scoreDelta).toBe(
      BASELINE_SCORE + (raised - BASELINE_RESULT),
    );
  });

  it('corrupts no state slot, board or rule at a spent budget', () => {
    const spent = createHarness(SPENT_BUDGET);
    const beforeBoard = spent.grid.serialize();
    const beforeRules = snapshotRules(spent.config);

    dispatch(spent, baselineCase().payload);

    expect(spent.context.state).toBe(STATE_SENTINEL);
    expect(spent.grid.serialize()).toEqual(beforeBoard);
    expect(snapshotRules(spent.config)).toEqual(beforeRules);
    expect(spent.effectCalls).toEqual([]);
    expect(spent.chargeRequests).toEqual([]);
    expect(spent.context.charges).toBe(SPENT_BUDGET);
  });
});

/* ==========================================================================
 * 11. Determinism — the relic consumes no randomness
 * ========================================================================== */

describe('alloy-forge consumes no randomness', () => {
  it('leaves every named substream cursor where it stood', () => {
    const before = harness.streams.snapshotCursors();

    expect(Object.keys(before)).toHaveLength(RNG_STREAM_NAMES.length);

    for (const name of RNG_STREAM_NAMES) {
      expect(typeof before[name]).toBe('number');
    }

    dispatch(harness, baselineCase().payload);

    const after = harness.streams.snapshotCursors();

    expect(after).toEqual(before);

    for (const name of RNG_STREAM_NAMES) {
      expect(after[name]).toBe(before[name]);
    }
  });

  it('names Math.random nowhere in its handler', () => {
    expect(requireMergeHandler(requireRelic()).toString()).not.toContain(
      'Math.random',
    );
  });

  it('catches nothing and logs nothing in its handler', () => {
    const body = requireMergeHandler(requireRelic()).toString();

    expect(body).not.toContain('catch');
    expect(body).not.toContain('console');
  });
});

/* ==========================================================================
 * 12. The shared declaration and the per-test rules
 * ========================================================================== */

describe('the shared alloy-forge declaration survives the suite', () => {
  it('rebuilds the rules for every test, leaking no substitution', () => {
    expect(harness.config.merge.produce).toBe(defaultProduceMergeValue);
    expect(harness.config.merge.canMerge).toBe(defaultCanMerge);
    expect(harness.config.boardSize).toBe(MERGE_PAIR_BOARD.grid.size);
  });

  it('carries the same members it carried at import', () => {
    expect(snapshotDeclaration(requireRelic())).toEqual(DECLARED_AT_IMPORT);
    expect(DECLARED_AT_IMPORT.hookNames).toEqual(['onMerge']);
    expect(DECLARED_AT_IMPORT.declaresCharges).toBe(false);
    expect(DECLARED_AT_IMPORT.declaresState).toBe(false);
  });
});
