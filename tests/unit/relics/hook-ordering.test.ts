// Ordering and compounding suite over the catalogue's `onMerge` relics: AAP
// Contract 2 and validation gate V6 row 1, "two relics on one hook - both
// fire, in pickup order, and compound".
//
// The executable counterpart of Figure 5, "Hook Dispatch Sequence: Pickup-Order
// Fan-Out with Charge Guard and Error Isolation", in
// docs/architecture/hook-dispatch-sequence.md.
//
// PROVENANCE. js/keyboard_input_manager.js L18-L32 is the publish/subscribe
// pair this dispatch descends from: `on` pushed a callback onto the array keyed
// by event name and `emit` walked that array inline with one argument,
// returning nothing — no queue, no charge notion, no return value and no error
// isolation. Row TR-HOOKBUS-01 of docs/TRACEABILITY_MATRIX.md carries that
// shape into src/engine/hook-bus.ts, and rows TR-HOOKBUS-02 and TR-HOOKBUS-03
// add the two properties this file measures over REAL relics: pickup-order
// dispatch and the compounding payload return.
//
// The two arithmetic sites being compounded are js/game_manager.js L157, the
// merge producer `new Tile(positions.next, tile.value * 2)`, and L167, the
// score accrual `self.score += merged.value`. The relics under test are rows
// TR-MERGE-01 `echo-chamber`, TR-MERGE-02 `alloy-forge`, TR-MERGE-03
// `frostbind` and TR-MERGE-04 `chain-catalyst`.
//
// SCOPE. tests/unit/engine/hook-bus.test.ts holds the mechanism against
// SYNTHETIC subscriptions: pickup order with stub handlers, the charge guard,
// error isolation, and the payload-return protocol in the abstract. This file
// holds the catalogue-level measurement alone and stubs nothing.
//
// Every expected figure below is DERIVED at run time — from
// `defaultProduceMergeValue` and from a solo dispatch of the relic itself — and
// no magnitude declared inside src/relics/families/merge-magic.ts is copied
// here.
//
// Decisions behind this file are recorded in docs/DECISION_LOG.md and named
// there: DL-HOOKBUS-02, the pickup-order index deciding dispatch order;
// DL-HOOKBUS-03, the compounding return protocol in which a handler returning
// nothing leaves the payload as it stands; DL-HOOKBUS-01, the charge guard
// living in the bus; and DL-MERGE-02, `scoreDelta` transformed independently of
// `resultValue`.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  createDefaultRulesConfig,
  defaultCanMerge,
  defaultProduceMergeValue,
} from '../../../src/config/default-config';
import type {
  MergeTileView,
  RulesConfig,
} from '../../../src/config/rules-config';
import { Grid } from '../../../src/engine/grid';
import { createHookBus, type HookBus } from '../../../src/engine/hook-bus';
import { HOOK_NAMES } from '../../../src/engine/hooks';
import type {
  HookContext,
  HookSubscription,
  MergePayload,
} from '../../../src/engine/hooks';
import { Tile } from '../../../src/engine/tile';
import { NOOP_ENGINE_REPORTER } from '../../../src/engine/types';
import type { CorrelationId } from '../../../src/engine/types';
import { MERGE_MAGIC_FAMILY } from '../../../src/relics/families/merge-magic';
import {
  SPAWN_CONTROL_FAMILY,
} from '../../../src/relics/families/spawn-control';
import {
  findRelicById,
  RelicRegistry,
} from '../../../src/relics/relic-registry';
import type { Relic } from '../../../src/relics/relic-types';
import {
  createRngStreams,
  RNG_STREAM_NAMES,
} from '../../../src/rng/rng-streams';
import type { RngCursorMap, RngStreams } from '../../../src/rng/rng-streams';
import { createMergePairBoard } from '../../fixtures/boards';

/* ==========================================================================
 * 1. Identifiers and the dispatch input
 * ========================================================================== */

/** Relic raising `scoreDelta` by a fraction of `resultValue`. */
const ECHO_CHAMBER = 'echo-chamber';

/** Relic raising `resultValue` one step and scoring the increment. */
const ALLOY_FORGE = 'alloy-forge';

/** The catalogue's one `onMerge` handler that returns nothing. */
const FROSTBIND = 'frostbind';

/** Third `onMerge` relic, acting on an unequal pair alone. */
const CHAIN_CATALYST = 'chain-catalyst';

/** Relic bound to `onSpawn` and to no other hook. */
const TWIN_SEED = 'twin-seed';

/** Fixed literal run seed. No test derives a seed from the clock. */
const RUN_SEED = 'blitzy-hook-ordering';

/** Run correlation identifier injected into every bus built below. */
const RUN_CORRELATION_ID: CorrelationId = 'run-hook-ordering-0001';

/** Cell the moving tile of every dispatch below occupies. */
const SOURCE_CELL = Object.freeze({ x: 1, y: 0 });

/** Cell the merge resolves onto. */
const TARGET_CELL = Object.freeze({ x: 0, y: 0 });

/** One `onMerge` dispatch input, in the members a handler transforms. */
interface MergeInput {
  readonly sourceValue: number;
  readonly targetValue: number;
  readonly resultValue: number;
  readonly scoreDelta: number;
}

/** What one dispatch reports, flattened onto one record. */
interface MergeOutcome {
  readonly resultValue: number;
  readonly scoreDelta: number;
  readonly invoked: number;
  readonly skipped: number;
  readonly failed: number;
  readonly rejected: number;
  readonly effectsApplied: number;
  readonly chargesConsumed: number;
}

/* ==========================================================================
 * 2. Derivation, from the producer in force and from the relics themselves
 * ========================================================================== */

/**
 * The operand shape `MergeProducer` reads.
 *
 * @param value Face value the operand carries.
 * @returns A fresh operand.
 */
function mergeOperand(value: number): MergeTileView {
  return { value, mergedFrom: null };
}

/**
 * The value the default producer yields from a pair standing at `value`.
 * js/game_manager.js L157.
 *
 * @param value Face value of the pair.
 * @returns The produced value.
 */
function producedFrom(value: number): number {
  return defaultProduceMergeValue(mergeOperand(value), mergeOperand(value));
}

/**
 * The increment `alloy-forge` adds to `resultValue` and to `scoreDelta`, read
 * from the producer in force alone.
 *
 * @param value `resultValue` as the handler receives it.
 * @returns The increment.
 */
function alloyIncrement(value: number): number {
  return producedFrom(value) - value;
}

/**
 * One dispatch input, with `resultValue` taken from the producer and
 * `scoreDelta` from the accrual of js/game_manager.js L167, which adds the
 * produced value to the score.
 *
 * @param sourceValue Face value of the moving tile.
 * @param targetValue Face value of the tile merged onto.
 * @returns A fresh input.
 */
function mergeInput(sourceValue: number, targetValue: number): MergeInput {
  const resultValue = producedFrom(sourceValue);

  return { sourceValue, targetValue, resultValue, scoreDelta: resultValue };
}

/** Face value of the equal pair every ordering assertion below merges. */
const EQUAL_PAIR_VALUE = 32;

/** The equal-valued input: the merge vanilla 2048 itself resolves. */
const EQUAL_MERGE = mergeInput(EQUAL_PAIR_VALUE, EQUAL_PAIR_VALUE);

/** Lower face value of the one-step-apart pair `chain-catalyst` acts on. */
const LADDER_LOWER_VALUE = 4;

/** Upper face value of that pair, one step up the doubling ladder. */
const LADDER_UPPER_VALUE = producedFrom(LADDER_LOWER_VALUE);

/** The unequal input `chain-catalyst` transforms. */
const LADDER_MERGE = mergeInput(LADDER_LOWER_VALUE, LADDER_UPPER_VALUE);

/* ==========================================================================
 * 3. The bench: a live config, live substreams, a live board and one bus
 * ========================================================================== */

/** One run's collaborators, built fresh for every test. */
interface OrderingBench {
  readonly config: RulesConfig;
  readonly rng: RngStreams;
  readonly grid: Grid;
  readonly bus: HookBus;
  readonly registry: RelicRegistry;
}

/**
 * Builds a bench and takes on `pickups` in the order given, which is the
 * pickup order `RelicRegistry` assigns.
 *
 * The config comes from `createDefaultRulesConfig`, which returns a live
 * object; `DEFAULT_RULES_CONFIG` is deep-frozen and is never used here, and a
 * relic installing a merge rule writes the config this bench owns.
 *
 * @param pickups Relic identifiers, in pickup order.
 * @param seed Run seed the substreams are derived from.
 * @returns A fresh bench holding the relics named.
 */
function benchFor(
  pickups: readonly string[],
  seed: string = RUN_SEED,
): OrderingBench {
  const config = createDefaultRulesConfig();
  const board = createMergePairBoard(config.boardSize);
  const bus = createHookBus({
    correlationId: RUN_CORRELATION_ID,
    reporter: NOOP_ENGINE_REPORTER,
  });
  const registry = new RelicRegistry({
    bus,
    reporter: NOOP_ENGINE_REPORTER,
    correlationId: RUN_CORRELATION_ID,
  });

  for (const id of pickups) {
    expect(registry.pickUp(id)?.definition.id).toBe(id);
  }

  return {
    config,
    rng: createRngStreams(seed),
    grid: new Grid(config.boardSize, board.grid.cells),
    bus,
    registry,
  };
}

/**
 * Dispatches one `onMerge` over `bench` and flattens what the bus reports.
 *
 * The two tiles are live `Tile` objects, which is what the move resolver hands
 * the hook; the bus substitutes its frozen views before the first handler is
 * reached.
 *
 * @param bench Bench to dispatch over.
 * @param input Dispatch input.
 * @returns The accumulated payload's two arithmetic members and the counts.
 */
function fireMerge(bench: OrderingBench, input: MergeInput): MergeOutcome {
  const outcome = bench.bus.dispatch(
    'onMerge',
    {
      source: new Tile(SOURCE_CELL, input.sourceValue),
      target: new Tile(TARGET_CELL, input.targetValue),
      resultValue: input.resultValue,
      scoreDelta: input.scoreDelta,
    },
    { config: bench.config, rng: bench.rng, grid: bench.grid },
  );

  return {
    resultValue: outcome.payload.resultValue,
    scoreDelta: outcome.payload.scoreDelta,
    invoked: outcome.invoked,
    skipped: outcome.skipped,
    failed: outcome.failed,
    rejected: outcome.rejected,
    effectsApplied: outcome.effectsApplied,
    chargesConsumed: outcome.chargesConsumed,
  };
}

/**
 * The bonus `echo-chamber` adds at one `resultValue`, MEASURED by dispatching
 * the relic alone over a scratch bench at `scoreDelta` zero.
 *
 * The fraction itself is module-private in
 * src/relics/families/merge-magic.ts; this reads it out of the relic's own
 * behaviour.
 *
 * @param value `resultValue` the handler is to read.
 * @returns The bonus added to `scoreDelta`.
 */
function echoBonusFor(value: number): number {
  return fireMerge(benchFor([ECHO_CHAMBER]), {
    sourceValue: EQUAL_PAIR_VALUE,
    targetValue: EQUAL_PAIR_VALUE,
    resultValue: value,
    scoreDelta: 0,
  }).scoreDelta;
}

/**
 * The subscriber identifiers bound to one hook, in the order the bus will walk
 * them.
 *
 * @param bench Bench to read.
 * @param hook Hook to read the subscriptions of.
 * @returns The identifiers, in pickup order.
 */
function dispatchOrder(
  bench: OrderingBench,
  hook: (typeof HOOK_NAMES)[number],
): readonly string[] {
  return bench.bus
    .subscriptions(hook)
    .map((subscription: HookSubscription) => subscription.subscriberId);
}

/**
 * The pickup positions the bus holds for one hook's subscribers, in the order
 * it will walk them.
 *
 * @param bench Bench to read.
 * @param hook Hook to read the subscriptions of.
 * @returns The pickup positions, in walk order.
 */
function pickupPositions(
  bench: OrderingBench,
  hook: (typeof HOOK_NAMES)[number],
): readonly number[] {
  return bench.bus
    .subscriptions(hook)
    .map((subscription: HookSubscription) => subscription.pickupOrder);
}

/**
 * The charges the bus holds for one relic, read through its own snapshot.
 *
 * @param bench Bench to read.
 * @param id Relic identifier.
 * @returns The remaining charges, `undefined` on a relic with no budget.
 */
function chargesOf(bench: OrderingBench, id: string): number | undefined {
  return bench.registry.find(id)?.charges;
}

/* ==========================================================================
 * 4. The derived figures every expectation below is stated in
 *
 * Each figure below is an expression over `producedFrom` and `echoBonusFor`,
 * evaluated once at module scope.
 * ========================================================================== */

/** `resultValue` as the dispatch input carries it. */
const ARRIVING_VALUE = EQUAL_MERGE.resultValue;

/** `scoreDelta` as the dispatch input carries it. */
const ARRIVING_SCORE = EQUAL_MERGE.scoreDelta;

/** `resultValue` after `alloy-forge` has raised it one step. */
const RAISED_VALUE = producedFrom(ARRIVING_VALUE);

/** The bonus `echo-chamber` adds reading the value as it arrives. */
const BONUS_ON_ARRIVING_VALUE = echoBonusFor(ARRIVING_VALUE);

/** The bonus `echo-chamber` adds reading the value `alloy-forge` raised. */
const BONUS_ON_RAISED_VALUE = echoBonusFor(RAISED_VALUE);

/** The increment `alloy-forge` adds reading the value as it arrives. */
const INCREMENT_ON_ARRIVING_VALUE = alloyIncrement(ARRIVING_VALUE);

/** Set 2a: `echo-chamber` held alone. */
const ECHO_ALONE_SCORE = ARRIVING_SCORE + BONUS_ON_ARRIVING_VALUE;

/** Set 2b: `alloy-forge` held alone. */
const ALLOY_ALONE_SCORE = ARRIVING_SCORE + INCREMENT_ON_ARRIVING_VALUE;

/** Set 3: pickup order `echo-chamber` then `alloy-forge`. */
const ECHO_THEN_ALLOY_SCORE =
  ARRIVING_SCORE + BONUS_ON_ARRIVING_VALUE + INCREMENT_ON_ARRIVING_VALUE;

/** Set 4: pickup order `alloy-forge` then `echo-chamber`. */
const ALLOY_THEN_ECHO_SCORE =
  ARRIVING_SCORE + INCREMENT_ON_ARRIVING_VALUE + BONUS_ON_RAISED_VALUE;

/** The signature the catalogue binds on `onMerge`. */
type MergeHandler = (
  payload: MergePayload,
  context: HookContext,
) => MergePayload | void;

/**
 * The `onMerge` handler one catalogue relic binds.
 *
 * @param id Relic identifier.
 * @returns The handler, or `undefined` where the relic binds none.
 */
function mergeHandlerOf(id: string): MergeHandler | undefined {
  return findRelicById(id)?.hooks.onMerge;
}

/**
 * The catalogue position of one relic within `MERGE_MAGIC_FAMILY`, which is the
 * order src/relics/relic-registry.ts flattens.
 *
 * @param id Relic identifier.
 * @returns The zero-based position, or `-1` where the family omits it.
 */
function cataloguePositionOf(id: string): number {
  return MERGE_MAGIC_FAMILY.relics.findIndex(
    (relic: Relic) => relic.id === id,
  );
}

/**
 * The data members of one catalogue declaration, as a comparable string.
 *
 * `hooks` holds functions and is compared by identity separately.
 *
 * @param id Relic identifier.
 * @returns The serialised declaration.
 */
function declarationOf(id: string): string {
  const relic = findRelicById(id);

  return JSON.stringify({
    id: relic?.id,
    name: relic?.name,
    rarity: relic?.rarity,
    description: relic?.description,
    charges: relic?.charges ?? null,
    state: relic?.state ?? null,
    hooks: Object.keys(relic?.hooks ?? {}).slice().sort(),
  });
}

/** Every relic this suite picks up, in catalogue order. */
const RELICS_UNDER_TEST: readonly string[] = Object.freeze([
  ECHO_CHAMBER,
  ALLOY_FORGE,
  FROSTBIND,
  CHAIN_CATALYST,
  TWIN_SEED,
]);

/** The declarations as they stood before the first test ran. */
const DECLARATIONS_BEFORE: readonly string[] = Object.freeze(
  RELICS_UNDER_TEST.map(declarationOf),
);

/** The `onMerge` handlers as they stood before the first test ran. */
const HANDLERS_BEFORE: readonly (MergeHandler | undefined)[] = Object.freeze(
  RELICS_UNDER_TEST.map(mergeHandlerOf),
);

/* ==========================================================================
 * 5. The four expectation sets
 * ========================================================================== */

describe('the input and the relics under test', () => {
  /** Rebuilt per test, so no pickup order leaks from one test to the next. */
  let bench: OrderingBench;

  beforeEach(() => {
    bench = benchFor([]);
  });

  it('arrives carrying the value and the score one merge produces', () => {
    expect(ARRIVING_VALUE).toBe(producedFrom(EQUAL_PAIR_VALUE));
    expect(ARRIVING_SCORE).toBe(ARRIVING_VALUE);
    expect(RAISED_VALUE).toBe(producedFrom(ARRIVING_VALUE));
  });

  it('derives two bonuses that differ, one per value the chain reaches', () => {
    // The two bonuses differ: a fraction of the raised value is not the
    // fraction of the arriving one.
    expect(BONUS_ON_ARRIVING_VALUE).toBeGreaterThan(0);
    expect(BONUS_ON_RAISED_VALUE).toBeGreaterThan(BONUS_ON_ARRIVING_VALUE);
    expect(INCREMENT_ON_ARRIVING_VALUE).toBe(
      producedFrom(ARRIVING_VALUE) - ARRIVING_VALUE,
    );
  });

  it('binds a callable onMerge handler on each of the three relics', () => {
    for (const id of [ECHO_CHAMBER, ALLOY_FORGE, FROSTBIND, CHAIN_CATALYST]) {
      expect(typeof mergeHandlerOf(id)).toBe('function');
    }

    expect(mergeHandlerOf(TWIN_SEED)).toBeUndefined();
    expect(findRelicById(TWIN_SEED)?.hooks.onSpawn).toBeTypeOf('function');
  });

  it('passes the payload through unchanged when no relic is held', () => {
    const resolved = fireMerge(bench, EQUAL_MERGE);

    expect(resolved.invoked).toBe(0);
    expect(resolved.skipped).toBe(0);
    expect(resolved.resultValue).toBe(ARRIVING_VALUE);
    expect(resolved.scoreDelta).toBe(ARRIVING_SCORE);
    expect(dispatchOrder(bench, 'onMerge')).toEqual([]);
  });

  it('raises the score alone when echo-chamber is held alone', () => {
    const resolved = fireMerge(benchFor([ECHO_CHAMBER]), EQUAL_MERGE);

    expect(resolved.invoked).toBe(1);
    expect(resolved.resultValue).toBe(ARRIVING_VALUE);
    expect(resolved.scoreDelta).toBe(ECHO_ALONE_SCORE);
  });

  it('raises the value and the score when alloy-forge is held alone', () => {
    const resolved = fireMerge(benchFor([ALLOY_FORGE]), EQUAL_MERGE);

    expect(resolved.invoked).toBe(1);
    expect(resolved.resultValue).toBe(RAISED_VALUE);
    expect(resolved.scoreDelta).toBe(ALLOY_ALONE_SCORE);
  });
});

/* ==========================================================================
 * 6. Two relics on one hook: both fire, in pickup order, and compound
 * ========================================================================== */

describe('two onMerge relics on one hook', () => {
  /** Pickup order `echo-chamber` then `alloy-forge`, rebuilt per test. */
  let forwards: OrderingBench;

  /** Pickup order `alloy-forge` then `echo-chamber`, rebuilt per test. */
  let backwards: OrderingBench;

  beforeEach(() => {
    forwards = benchFor([ECHO_CHAMBER, ALLOY_FORGE]);
    backwards = benchFor([ALLOY_FORGE, ECHO_CHAMBER]);
  });

  it('fires both, neither being an alternative to the other', () => {
    const resolved = fireMerge(forwards, EQUAL_MERGE);

    expect(resolved.invoked).toBe(2);
    expect(resolved.skipped).toBe(0);
    expect(resolved.failed).toBe(0);
    expect(resolved.rejected).toBe(0);

    // alloy-forge's effect: the value is raised.
    expect(resolved.resultValue).toBe(RAISED_VALUE);

    // echo-chamber's effect AND alloy-forge's, both on one score.
    expect(resolved.scoreDelta).toBe(ECHO_THEN_ALLOY_SCORE);
    expect(resolved.scoreDelta - ARRIVING_SCORE).toBe(
      BONUS_ON_ARRIVING_VALUE + INCREMENT_ON_ARRIVING_VALUE,
    );
  });

  it('scores one figure in pickup order and another reversed', () => {
    expect(fireMerge(forwards, EQUAL_MERGE).scoreDelta).toBe(
      ECHO_THEN_ALLOY_SCORE,
    );
    expect(fireMerge(backwards, EQUAL_MERGE).scoreDelta).toBe(
      ALLOY_THEN_ECHO_SCORE,
    );
  });

  it('scores two figures that differ, which is what proves the order', () => {
    const inOrder = fireMerge(forwards, EQUAL_MERGE);
    const reversed = fireMerge(backwards, EQUAL_MERGE);

    expect(inOrder.scoreDelta).not.toBe(reversed.scoreDelta);
    expect(reversed.scoreDelta - inOrder.scoreDelta).toBe(
      BONUS_ON_RAISED_VALUE - BONUS_ON_ARRIVING_VALUE,
    );

    // Both orders raise the value identically: the score is the only member
    // the order is visible on.
    expect(inOrder.resultValue).toBe(RAISED_VALUE);
    expect(reversed.resultValue).toBe(RAISED_VALUE);
  });

  it('walks the subscribers in the order they were picked up', () => {
    expect(dispatchOrder(forwards, 'onMerge')).toEqual([
      ECHO_CHAMBER,
      ALLOY_FORGE,
    ]);
    expect(dispatchOrder(backwards, 'onMerge')).toEqual([
      ALLOY_FORGE,
      ECHO_CHAMBER,
    ]);
    expect(pickupPositions(forwards, 'onMerge')).toEqual([0, 1]);
    expect(pickupPositions(backwards, 'onMerge')).toEqual([0, 1]);
  });

  it('repeats its figure across four dispatches over one bench', () => {
    const scores = [0, 1, 2, 3].map(
      () => fireMerge(forwards, EQUAL_MERGE).scoreDelta,
    );

    expect(scores).toEqual([
      ECHO_THEN_ALLOY_SCORE,
      ECHO_THEN_ALLOY_SCORE,
      ECHO_THEN_ALLOY_SCORE,
      ECHO_THEN_ALLOY_SCORE,
    ]);
  });
});

/* ==========================================================================
 * 7. Pickup order, not catalogue order and not identifier order
 * ========================================================================== */

describe('dispatch order follows pickup, not the declaration', () => {
  it('declares echo-chamber ahead of alloy-forge in the catalogue', () => {
    expect(cataloguePositionOf(ECHO_CHAMBER)).toBeGreaterThanOrEqual(0);
    expect(cataloguePositionOf(ALLOY_FORGE)).toBe(
      cataloguePositionOf(ECHO_CHAMBER) + 1,
    );
  });

  it('walks the reverse of catalogue order when picked up that way', () => {
    const bench = benchFor([ALLOY_FORGE, ECHO_CHAMBER]);

    expect(dispatchOrder(bench, 'onMerge')).toEqual([
      ALLOY_FORGE,
      ECHO_CHAMBER,
    ]);
    expect(fireMerge(bench, EQUAL_MERGE).scoreDelta).toBe(
      ALLOY_THEN_ECHO_SCORE,
    );
  });

  it('scores against the catalogue figure when picked up that way', () => {
    const bench = benchFor([ECHO_CHAMBER, ALLOY_FORGE]);

    expect(fireMerge(bench, EQUAL_MERGE).scoreDelta).toBe(
      ECHO_THEN_ALLOY_SCORE,
    );
  });

  it('scores against identifier order on one bench and not the other', () => {
    // 'alloy-forge' sorts ahead of 'echo-chamber', so a dispatch keyed to the
    // identifier would return one figure for both benches.
    const sorted = [ECHO_CHAMBER, ALLOY_FORGE].slice().sort();

    expect(sorted).toEqual([ALLOY_FORGE, ECHO_CHAMBER]);
    expect(fireMerge(benchFor(sorted), EQUAL_MERGE).scoreDelta).toBe(
      ALLOY_THEN_ECHO_SCORE,
    );
    expect(
      fireMerge(benchFor([ECHO_CHAMBER, ALLOY_FORGE]), EQUAL_MERGE).scoreDelta,
    ).not.toBe(ALLOY_THEN_ECHO_SCORE);
  });
});

/* ==========================================================================
 * 8. Compounding, not overwriting
 * ========================================================================== */

describe('the second handler compounds onto the first', () => {
  it('scores above either relic held alone, and the compound exactly', () => {
    const resolved = fireMerge(
      benchFor([ECHO_CHAMBER, ALLOY_FORGE]),
      EQUAL_MERGE,
    );

    expect(resolved.scoreDelta).toBe(ECHO_THEN_ALLOY_SCORE);
    expect(resolved.scoreDelta).toBeGreaterThan(ECHO_ALONE_SCORE);
    expect(resolved.scoreDelta).toBeGreaterThan(ALLOY_ALONE_SCORE);
  });

  it('scores neither solo figure, so neither handler overwrote', () => {
    const inOrder = fireMerge(
      benchFor([ECHO_CHAMBER, ALLOY_FORGE]),
      EQUAL_MERGE,
    );
    const reversed = fireMerge(
      benchFor([ALLOY_FORGE, ECHO_CHAMBER]),
      EQUAL_MERGE,
    );

    // Overwriting rather than accumulating would land the chain on one of
    // these two figures.
    expect(inOrder.scoreDelta).not.toBe(ECHO_ALONE_SCORE);
    expect(inOrder.scoreDelta).not.toBe(ALLOY_ALONE_SCORE);
    expect(reversed.scoreDelta).not.toBe(ECHO_ALONE_SCORE);
    expect(reversed.scoreDelta).not.toBe(ALLOY_ALONE_SCORE);
  });

  it('carries the arriving score into the compound, never dropping it', () => {
    const resolved = fireMerge(
      benchFor([ECHO_CHAMBER, ALLOY_FORGE]),
      EQUAL_MERGE,
    );

    expect(resolved.scoreDelta - ARRIVING_SCORE).toBe(
      BONUS_ON_ARRIVING_VALUE + INCREMENT_ON_ARRIVING_VALUE,
    );
  });
});

/* ==========================================================================
 * 9. Each handler receives the payload the one before it returned
 * ========================================================================== */

describe('each handler reads the accumulated payload', () => {
  it('takes its fraction from the raised value, picked up second', () => {
    const resolved = fireMerge(
      benchFor([ALLOY_FORGE, ECHO_CHAMBER]),
      EQUAL_MERGE,
    );

    // Reachable only by reading the value alloy-forge raised.
    expect(resolved.scoreDelta).toBe(
      ARRIVING_SCORE + INCREMENT_ON_ARRIVING_VALUE + BONUS_ON_RAISED_VALUE,
    );

    // The figure a handler reading the ORIGINAL payload would have produced.
    expect(resolved.scoreDelta).not.toBe(
      ARRIVING_SCORE + INCREMENT_ON_ARRIVING_VALUE + BONUS_ON_ARRIVING_VALUE,
    );
  });

  it('takes its increment from the arriving value, picked up second', () => {
    const resolved = fireMerge(
      benchFor([ECHO_CHAMBER, ALLOY_FORGE]),
      EQUAL_MERGE,
    );

    // echo-chamber leaves resultValue alone, so alloy-forge reads the value as
    // it arrived and adds the increment on top of the bonus already accrued.
    expect(resolved.resultValue).toBe(producedFrom(ARRIVING_VALUE));
    expect(resolved.scoreDelta).toBe(
      ARRIVING_SCORE + BONUS_ON_ARRIVING_VALUE + INCREMENT_ON_ARRIVING_VALUE,
    );
  });
});

/* ==========================================================================
 * 10. A third relic on the one hook
 * ========================================================================== */

/** `resultValue` the unequal input carries. */
const LADDER_ARRIVING_VALUE = LADDER_MERGE.resultValue;

/** `scoreDelta` the unequal input carries. */
const LADDER_ARRIVING_SCORE = LADDER_MERGE.scoreDelta;

/** `resultValue` after `chain-catalyst` has yielded from the larger tile. */
const CHAINED_VALUE = producedFrom(LADDER_UPPER_VALUE);

/** The increment `chain-catalyst` adds over the arriving value. */
const CHAIN_INCREMENT = CHAINED_VALUE - LADDER_ARRIVING_VALUE;

/** `resultValue` after `alloy-forge` has raised the chained value. */
const THREE_WAY_VALUE = producedFrom(CHAINED_VALUE);

/** The bonus `echo-chamber` adds reading the unequal input's value. */
const LADDER_BONUS = echoBonusFor(LADDER_ARRIVING_VALUE);

/** Pickup order `echo-chamber`, `chain-catalyst`, `alloy-forge`. */
const THREE_WAY_SCORE =
  LADDER_ARRIVING_SCORE +
  LADDER_BONUS +
  CHAIN_INCREMENT +
  alloyIncrement(CHAINED_VALUE);

describe('three onMerge relics on one hook', () => {
  it('derives an unequal pair one step apart on the doubling ladder', () => {
    expect(LADDER_UPPER_VALUE).toBe(producedFrom(LADDER_LOWER_VALUE));
    expect(LADDER_MERGE.sourceValue).not.toBe(LADDER_MERGE.targetValue);
    expect(CHAIN_INCREMENT).toBeGreaterThan(0);
    expect(LADDER_BONUS).toBeGreaterThan(0);
  });

  it('fires all three in pickup order and compounds all three effects', () => {
    const bench = benchFor([ECHO_CHAMBER, CHAIN_CATALYST, ALLOY_FORGE]);

    expect(dispatchOrder(bench, 'onMerge')).toEqual([
      ECHO_CHAMBER,
      CHAIN_CATALYST,
      ALLOY_FORGE,
    ]);

    const resolved = fireMerge(bench, LADDER_MERGE);

    expect(resolved.invoked).toBe(3);
    expect(resolved.skipped).toBe(0);
    expect(resolved.failed).toBe(0);
    expect(resolved.resultValue).toBe(THREE_WAY_VALUE);
    expect(resolved.scoreDelta).toBe(THREE_WAY_SCORE);
  });

  it('compounds above every pair drawn from the same three', () => {
    const bench = benchFor([ECHO_CHAMBER, CHAIN_CATALYST, ALLOY_FORGE]);
    const three = fireMerge(bench, LADDER_MERGE).scoreDelta;
    const pairs = [
      [ECHO_CHAMBER, CHAIN_CATALYST],
      [ECHO_CHAMBER, ALLOY_FORGE],
      [CHAIN_CATALYST, ALLOY_FORGE],
    ];

    for (const pair of pairs) {
      expect(three).toBeGreaterThan(
        fireMerge(benchFor(pair), LADDER_MERGE).scoreDelta,
      );
    }
  });

  it('reaches a third pickup that declines to change the payload', () => {
    // chain-catalyst returns nothing on an EQUAL pair, so the pair ahead of it
    // must reach the same figure it reaches without a third relic held.
    const bench = benchFor([ECHO_CHAMBER, ALLOY_FORGE, CHAIN_CATALYST]);
    const resolved = fireMerge(bench, EQUAL_MERGE);

    expect(dispatchOrder(bench, 'onMerge')).toEqual([
      ECHO_CHAMBER,
      ALLOY_FORGE,
      CHAIN_CATALYST,
    ]);
    expect(resolved.invoked).toBe(3);
    expect(resolved.skipped).toBe(0);
    expect(resolved.resultValue).toBe(RAISED_VALUE);
    expect(resolved.scoreDelta).toBe(ECHO_THEN_ALLOY_SCORE);
  });
});

/* ==========================================================================
 * 11. A pickup on another hook leaves this hook's order alone
 * ========================================================================== */

/**
 * The hooks carrying at least one subscriber, walked over all six names.
 *
 * @param bench Bench to read.
 * @returns The hook names carrying a subscriber, in declaration order.
 */
function hooksWithSubscribers(bench: OrderingBench): readonly string[] {
  return HOOK_NAMES.filter(
    (hook) => bench.bus.subscriptions(hook).length > 0,
  );
}

describe('a pickup bound to another hook', () => {
  it('declares twin-seed on onSpawn alone, in the spawn-control family', () => {
    const twinSeed = SPAWN_CONTROL_FAMILY.relics.find(
      (relic: Relic) => relic.id === TWIN_SEED,
    );

    expect(twinSeed).toBeDefined();
    expect(Object.keys(twinSeed?.hooks ?? {})).toEqual(['onSpawn']);
  });

  it('leaves the onMerge order and figure exactly as they were', () => {
    const bench = benchFor([ECHO_CHAMBER, TWIN_SEED, ALLOY_FORGE]);
    const resolved = fireMerge(bench, EQUAL_MERGE);

    expect(dispatchOrder(bench, 'onMerge')).toEqual([
      ECHO_CHAMBER,
      ALLOY_FORGE,
    ]);
    expect(resolved.invoked).toBe(2);
    expect(resolved.skipped).toBe(0);
    expect(resolved.scoreDelta).toBe(ECHO_THEN_ALLOY_SCORE);
    expect(resolved.resultValue).toBe(RAISED_VALUE);
  });

  it('holds its own pickup position between the two onMerge relics', () => {
    const bench = benchFor([ECHO_CHAMBER, TWIN_SEED, ALLOY_FORGE]);

    expect(dispatchOrder(bench, 'onSpawn')).toEqual([TWIN_SEED]);
    expect(pickupPositions(bench, 'onSpawn')).toEqual([1]);

    // The two onMerge subscribers keep the positions they were given: they are
    // not renumbered to close the gap the interleaved pickup left.
    expect(pickupPositions(bench, 'onMerge')).toEqual([0, 2]);
  });

  it('adds no subscriber to any hook but onMerge and onSpawn', () => {
    const bench = benchFor([ECHO_CHAMBER, TWIN_SEED, ALLOY_FORGE]);

    expect(hooksWithSubscribers(bench)).toEqual(['onMerge', 'onSpawn']);
  });
});

/* ==========================================================================
 * 12. A handler returning nothing, mid-chain
 * ========================================================================== */

/** Charge budget `frostbind` declares, read from the declaration. */
const FROSTBIND_DECLARED_CHARGES = findRelicById(FROSTBIND)?.charges ?? 0;

describe('a mid-chain handler that returns nothing', () => {
  /** Pickup order `echo-chamber`, `frostbind`, `alloy-forge`. */
  let bench: OrderingBench;

  beforeEach(() => {
    bench = benchFor([ECHO_CHAMBER, FROSTBIND, ALLOY_FORGE]);
  });

  it('declares a charge budget and an onMerge binding on frostbind', () => {
    expect(FROSTBIND_DECLARED_CHARGES).toBeGreaterThan(0);
    expect(chargesOf(bench, FROSTBIND)).toBe(FROSTBIND_DECLARED_CHARGES);
    expect(dispatchOrder(bench, 'onMerge')).toEqual([
      ECHO_CHAMBER,
      FROSTBIND,
      ALLOY_FORGE,
    ]);
  });

  it('takes its state slot from the declaration and carries it forward', () => {
    const declared = findRelicById(FROSTBIND)?.state;

    expect(bench.registry.find(FROSTBIND)?.state).toEqual(declared);

    fireMerge(bench, EQUAL_MERGE);

    // The slot the registry seeded is the slot the handler wrote through, so
    // the dispatch moved it off the declared value.
    expect(bench.registry.find(FROSTBIND)?.state).not.toEqual(declared);
    expect(findRelicById(FROSTBIND)?.state).toEqual(declared);
  });

  it('keeps the accumulated payload rather than erasing it', () => {
    const resolved = fireMerge(bench, EQUAL_MERGE);
    const withoutIt = fireMerge(
      benchFor([ECHO_CHAMBER, ALLOY_FORGE]),
      EQUAL_MERGE,
    );

    expect(resolved.invoked).toBe(3);
    expect(resolved.failed).toBe(0);

    // Identical to the chain without it: the return neither replaced the
    // payload with nothing nor discarded echo-chamber's bonus.
    expect(resolved.resultValue).toBe(withoutIt.resultValue);
    expect(resolved.scoreDelta).toBe(withoutIt.scoreDelta);
    expect(resolved.scoreDelta).toBe(ECHO_THEN_ALLOY_SCORE);
  });

  it('applies its own merge rule, so the return is no payload change', () => {
    expect(bench.config.merge.canMerge).toBe(defaultCanMerge);

    const resolved = fireMerge(bench, EQUAL_MERGE);

    expect(resolved.effectsApplied).toBe(1);
    expect(resolved.chargesConsumed).toBe(1);
    expect(bench.config.merge.canMerge).not.toBe(defaultCanMerge);
    expect(typeof bench.config.merge.canMerge).toBe('function');
  });

  it('leaves the relics around it at the positions they were given', () => {
    fireMerge(bench, EQUAL_MERGE);

    expect(pickupPositions(bench, 'onMerge')).toEqual([0, 1, 2]);
    expect(dispatchOrder(bench, 'onMerge')).toEqual([
      ECHO_CHAMBER,
      FROSTBIND,
      ALLOY_FORGE,
    ]);
  });
});

/* ==========================================================================
 * 13. A spent budget mid-chain
 * ========================================================================== */

describe('a spent mid-chain relic', () => {
  /** Pickup order `echo-chamber`, `frostbind`, `alloy-forge`. */
  let bench: OrderingBench;

  beforeEach(() => {
    bench = benchFor([ECHO_CHAMBER, FROSTBIND, ALLOY_FORGE]);

    // Every dispatch here toggles frostbind's ledger, which is what it asks a
    // charge for, so the budget is spent in exactly this many dispatches.
    for (let spent = 0; spent < FROSTBIND_DECLARED_CHARGES; spent += 1) {
      fireMerge(bench, EQUAL_MERGE);
    }
  });

  it('reaches zero charges after the budget has been drawn down', () => {
    expect(chargesOf(bench, FROSTBIND)).toBe(0);
  });

  it('keeps the chain around the skip firing to the same figure', () => {
    const resolved = fireMerge(bench, EQUAL_MERGE);

    expect(resolved.invoked).toBe(2);
    expect(resolved.skipped).toBe(1);
    expect(resolved.failed).toBe(0);
    expect(resolved.chargesConsumed).toBe(0);
    expect(resolved.resultValue).toBe(RAISED_VALUE);
    expect(resolved.scoreDelta).toBe(ECHO_THEN_ALLOY_SCORE);
  });

  it('renumbers no surviving relic, so the walk order is unchanged', () => {
    fireMerge(bench, EQUAL_MERGE);

    expect(dispatchOrder(bench, 'onMerge')).toEqual([
      ECHO_CHAMBER,
      FROSTBIND,
      ALLOY_FORGE,
    ]);
    expect(pickupPositions(bench, 'onMerge')).toEqual([0, 1, 2]);
    expect(bench.registry.ownedIds()).toEqual([
      ECHO_CHAMBER,
      FROSTBIND,
      ALLOY_FORGE,
    ]);
  });

  it('reaches the reversed figure when the pair is picked up reversed', () => {
    const reversed = benchFor([ALLOY_FORGE, FROSTBIND, ECHO_CHAMBER]);

    for (let spent = 0; spent < FROSTBIND_DECLARED_CHARGES; spent += 1) {
      fireMerge(reversed, EQUAL_MERGE);
    }

    const resolved = fireMerge(reversed, EQUAL_MERGE);

    expect(resolved.invoked).toBe(2);
    expect(resolved.skipped).toBe(1);
    expect(resolved.scoreDelta).toBe(ALLOY_THEN_ECHO_SCORE);
  });

  it('counts the invocations and the one skip on the hook it walked', () => {
    fireMerge(bench, EQUAL_MERGE);

    const counters = bench.bus.metrics().hooks.onMerge;
    const dispatched = FROSTBIND_DECLARED_CHARGES + 1;

    expect(counters.dispatched).toBe(dispatched);
    expect(counters.invoked).toBe(FROSTBIND_DECLARED_CHARGES * 3 + 2);
    expect(counters.skippedExhausted).toBe(1);
    expect(counters.skippedDegraded).toBe(0);
    expect(counters.failed).toBe(0);
    expect(counters.rejected).toBe(0);
    expect(bench.bus.degraded()).toEqual([]);

    // The identifier injected into both collaborators is the identifier they
    // report, and it is the one the bus puts on every HookContext it builds.
    expect(bench.bus.metrics().correlationId).toBe(RUN_CORRELATION_ID);
    expect(bench.registry.correlationId).toBe(RUN_CORRELATION_ID);
  });

  it('counts three fired and one skipped over a four-relic chain', () => {
    const four = benchFor([
      ECHO_CHAMBER,
      FROSTBIND,
      ALLOY_FORGE,
      CHAIN_CATALYST,
    ]);

    for (let spent = 0; spent < FROSTBIND_DECLARED_CHARGES; spent += 1) {
      fireMerge(four, EQUAL_MERGE);
    }

    const resolved = fireMerge(four, EQUAL_MERGE);
    const counters = four.bus.metrics().hooks.onMerge;

    expect(resolved.invoked).toBe(3);
    expect(resolved.skipped).toBe(1);
    expect(resolved.scoreDelta).toBe(ECHO_THEN_ALLOY_SCORE);
    expect(counters.skippedExhausted).toBe(1);
    expect(counters.invoked).toBe(FROSTBIND_DECLARED_CHARGES * 4 + 3);

    // The per-subscriber rows the metrics surface carries, in pickup order.
    expect(
      four.bus.metrics().subscribers.map((row) => [row.id, row.pickupOrder]),
    ).toEqual([
      [ECHO_CHAMBER, 0],
      [FROSTBIND, 1],
      [ALLOY_FORGE, 2],
      [CHAIN_CATALYST, 3],
    ]);
  });
});

/* ==========================================================================
 * 14. Determinism and substream hygiene
 * ========================================================================== */

/** A cursor map reading zero on every named substream. */
function zeroCursors(): RngCursorMap {
  const cursors: Partial<RngCursorMap> = {};

  for (const name of RNG_STREAM_NAMES) {
    cursors[name] = 0;
  }

  return cursors as RngCursorMap;
}

/** What one full pickup-and-dispatch sequence produced. */
interface SequenceRun {
  readonly outcomes: readonly MergeOutcome[];
  readonly cursors: RngCursorMap;
  readonly order: readonly string[];
  readonly seed: string;
}

/**
 * Runs one fixed pickup order through one fixed dispatch sequence.
 *
 * @param seed Run seed the substreams are derived from.
 * @returns The outcomes in dispatch order, the cursors afterwards, the walk
 *   order and the seed the substreams reported.
 */
function runSequence(seed: string): SequenceRun {
  const bench = benchFor(
    [ECHO_CHAMBER, FROSTBIND, ALLOY_FORGE, CHAIN_CATALYST],
    seed,
  );

  return {
    outcomes: [
      fireMerge(bench, EQUAL_MERGE),
      fireMerge(bench, LADDER_MERGE),
      fireMerge(bench, EQUAL_MERGE),
    ],
    cursors: bench.rng.snapshotCursors(),
    order: dispatchOrder(bench, 'onMerge'),
    seed: bench.rng.seed,
  };
}

describe('one seed and one pickup order', () => {
  it('produces the identical payloads across two independent runs', () => {
    const first = runSequence(RUN_SEED);
    const second = runSequence(RUN_SEED);

    expect(first.seed).toBe(RUN_SEED);
    expect(second.seed).toBe(RUN_SEED);
    expect(second.outcomes).toEqual(first.outcomes);
    expect(second.order).toEqual(first.order);
  });

  it('produces the identical cursor snapshot across two runs', () => {
    expect(runSequence(RUN_SEED).cursors).toEqual(
      runSequence(RUN_SEED).cursors,
    );
  });

  it('advances no substream, so a merge chain shifts no later spawn', () => {
    const run = runSequence(RUN_SEED);

    expect(run.cursors).toEqual(zeroCursors());

    for (const name of RNG_STREAM_NAMES) {
      expect(run.cursors[name]).toBe(0);
    }
  });

  it('walks the four relics in pickup order on every run', () => {
    expect(runSequence(RUN_SEED).order).toEqual([
      ECHO_CHAMBER,
      FROSTBIND,
      ALLOY_FORGE,
      CHAIN_CATALYST,
    ]);
  });
});

/* ==========================================================================
 * 15. What the suite left behind
 * ========================================================================== */

describe('the catalogue and the rules after every dispatch above', () => {
  it('leaves every declaration this suite picked up unmutated', () => {
    expect(RELICS_UNDER_TEST.map(declarationOf)).toEqual(DECLARATIONS_BEFORE);
    expect(RELICS_UNDER_TEST.map(mergeHandlerOf)).toEqual(HANDLERS_BEFORE);
  });

  it('leaves every declaration frozen, with its hook table frozen', () => {
    for (const id of RELICS_UNDER_TEST) {
      const relic = findRelicById(id);

      expect(relic).toBeDefined();
      expect(Object.isFrozen(relic)).toBe(true);
      expect(Object.isFrozen(relic?.hooks)).toBe(true);
    }
  });

  it('builds a fresh config still carrying the default merge rules', () => {
    // frostbind and chain-catalyst each install a predicate over the config
    // they were dispatched against; a config built now carries neither.
    const config = createDefaultRulesConfig();

    expect(config.merge.canMerge).toBe(defaultCanMerge);
    expect(config.merge.produce).toBe(defaultProduceMergeValue);
    expect(config.boardSize).toBeGreaterThan(0);
  });

  it('reports a charge budget on frostbind and none on the other three', () => {
    expect(findRelicById(FROSTBIND)?.charges).toBe(FROSTBIND_DECLARED_CHARGES);

    for (const id of [ECHO_CHAMBER, ALLOY_FORGE, CHAIN_CATALYST]) {
      expect(findRelicById(id)?.charges).toBeUndefined();
    }
  });
});
