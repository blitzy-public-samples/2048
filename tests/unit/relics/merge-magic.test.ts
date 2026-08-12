// Compounding, charge and reload suite for the `merge-magic` family, AAP R3
// and Contract 2.
//
// `frostbind` and `chain-catalyst` install a merge rule and are covered by
// tests/unit/relics/relic-effects.test.ts. What had no test at all is the
// family property the prompt states as an edge case outright.
//
// And the two conditions under which a handler must NOT fire.

import { describe, expect, it } from 'vitest';

import {
  createDefaultRulesConfig,
  defaultCanMerge,
} from '../../../src/config/default-config';
import type { MergePredicate } from '../../../src/config/rules-config';
import {
  dispatchOn,
  mergePayload,
  place,
  relicBench,
  relicById,
  resultOn,
  stateOf,
  stageStartPayload,
} from '../../fixtures/relics';
import type { RelicBench } from '../../fixtures/relics';

/** The score and value one merge resolves to through a bench. */
function resolveMerge(
  target: RelicBench,
  resultValue: number,
  scoreDelta: number,
): { resultValue: number; scoreDelta: number; invoked: number } {
  const outcome = resultOn(
    target,
    'onMerge',
    mergePayload({ x: 1, y: 0 }, { x: 0, y: 0 }, 2, 2, resultValue, scoreDelta),
  );

  return {
    resultValue: outcome.payload.resultValue,
    scoreDelta: outcome.payload.scoreDelta,
    invoked: outcome.invoked,
  };
}

describe('echo-chamber (merge-magic)', () => {
  it('binds onMerge and nothing else', () => {
    expect(Object.keys(relicById('echo-chamber').hooks)).toEqual(['onMerge']);
  });

  it('pays a quarter of the value on top, leaving the value alone', () => {
    const target = relicBench(['echo-chamber']);
    const resolved = resolveMerge(target, 64, 64);

    // The separation of score from value the vanilla merge did not have: the
    // tile is unchanged and only the score moves.
    expect(resolved.resultValue).toBe(64);
    expect(resolved.scoreDelta).toBe(80);
  });

  it('floors the bonus to a whole point', () => {
    const target = relicBench(['echo-chamber']);

    // A quarter of 6 is 1.5.
    expect(resolveMerge(target, 6, 6).scoreDelta).toBe(7);
  });

  it('leaves a merge whose bonus does not reach one point alone', () => {
    const target = relicBench(['echo-chamber']);
    const resolved = resolveMerge(target, 2, 2);

    expect(resolved.scoreDelta).toBe(2);
    expect(resolved.resultValue).toBe(2);
  });

  it('consumes no randomness', () => {
    const target = relicBench(['echo-chamber']);

    resolveMerge(target, 64, 64);

    expect({ ...target.streams.snapshotCursors() }).toEqual({
      'spawn-value': 0,
      'spawn-position': 0,
      'relic-draw': 0,
      'rarity-weight': 0,
    });
  });
});

describe('alloy-forge (merge-magic)', () => {
  it('binds onMerge and nothing else', () => {
    expect(Object.keys(relicById('alloy-forge').hooks)).toEqual(['onMerge']);
  });

  it('raises the produced value one step and scores the increment', () => {
    const target = relicBench(['alloy-forge']);
    const resolved = resolveMerge(target, 4, 4);

    expect(resolved.resultValue).toBe(8);
    expect(resolved.scoreDelta).toBe(8);
  });

  it('applies the producer in force, not a doubling of its own', () => {
    const target = relicBench(['alloy-forge']);

    target.config.merge.produce = (moving): number => moving.value + 10;

    const resolved = resolveMerge(target, 4, 4);

    expect(resolved.resultValue).toBe(14);
    expect(resolved.scoreDelta).toBe(14);
  });

  it('raises the score BY the increment rather than replacing it', () => {
    const target = relicBench(['alloy-forge']);

    // A score an earlier handler on this hook had already accumulated.
    const resolved = resolveMerge(target, 4, 100);

    expect(resolved.scoreDelta).toBe(104);
  });

  it('leaves a merge alone when the producer yields no higher value', () => {
    const target = relicBench(['alloy-forge']);

    target.config.merge.produce = (): number => 1;

    const resolved = resolveMerge(target, 8, 8);

    expect(resolved.resultValue).toBe(8);
    expect(resolved.scoreDelta).toBe(8);
  });

  it('leaves a merge alone when the producer yields nothing finite', () => {
    const target = relicBench(['alloy-forge']);

    target.config.merge.produce = (): number => Number.NaN;

    expect(resolveMerge(target, 8, 8).resultValue).toBe(8);
  });
});

describe('two relics on one hook', () => {
  it('fires both, compounding what the first returned into the second', () => {
    const target = relicBench(['echo-chamber', 'alloy-forge']);
    const resolved = resolveMerge(target, 4, 4);

    expect(resolved.invoked).toBe(2);

    // `echo-chamber` first, reading value 4: score 4 + 1 = 5.
    expect(resolved.resultValue).toBe(8);
    expect(resolved.scoreDelta).toBe(9);
  });

  it('produces a different score when the pickup order is reversed', () => {
    const target = relicBench(['alloy-forge', 'echo-chamber']);
    const resolved = resolveMerge(target, 4, 4);

    expect(resolved.invoked).toBe(2);

    // `alloy-forge` first: value 8, score 8.
    expect(resolved.resultValue).toBe(8);
    expect(resolved.scoreDelta).toBe(10);
  });

  it('fires in registration order however the identifiers sort', () => {
    // `alloy-forge` sorts before `echo-chamber`, so a bus dispatching by
    // identifier would give both benches the same answer.
    const forwards = relicBench(['echo-chamber', 'alloy-forge']);
    const backwards = relicBench(['alloy-forge', 'echo-chamber']);

    expect(resolveMerge(forwards, 4, 4).scoreDelta).not.toBe(
      resolveMerge(backwards, 4, 4).scoreDelta,
    );
  });

  it('compounds three handlers on the one hook', () => {
    const target = relicBench([
      'echo-chamber',
      'alloy-forge',
      'chain-catalyst',
    ]);

    dispatchOn(target, 'onStageStart', stageStartPayload(4));

    const resolved = resolveMerge(target, 4, 4);

    // `chain-catalyst` leaves an equal-valued pair exactly as it arrived, so
    // the pair before it still compounds and all three are invoked.
    expect(resolved.invoked).toBe(3);
    expect(resolved.resultValue).toBe(8);
    expect(resolved.scoreDelta).toBe(9);
  });
});

describe('a spent charge budget', () => {
  it('declares eight charges for frostbind', () => {
    expect(relicById('frostbind').charges).toBe(8);
  });

  it('skips the effect hook at zero charges, without throwing', () => {
    const target = relicBench([{ id: 'frostbind', charges: 0 }]);

    place(target.grid, 0, 0, 4);

    const started = resultOn(target, 'onStageStart', stageStartPayload(4));

    // STAGE PREPARATION IS NOT WITHHELD. `STANDING_HOOK_NAMES` of
    // src/engine/hooks.ts exempts `onStageStart` from the charge guard, because
    // the install reinstates the standing rule the ALREADY SPENT charges
    // established and a reload hands the relic a fresh default to reinstate it
    // over. It costs nothing: the handler asks for no charge.
    expect(started.invoked).toBe(1);
    expect(started.skipped).toBe(0);
    expect(started.failed).toBe(0);
    expect(started.chargesConsumed).toBe(0);

    // An empty ledger installs a wrapper that refuses no cell, so the rule in
    // force is a layer over the base rule rather than the base rule itself.
    expect(target.config.merge.canMerge).not.toBe(defaultCanMerge);

    const moving = { value: 4, mergedFrom: null };
    const stationary = { value: 4, mergedFrom: null };

    expect(target.config.merge.canMerge(moving, stationary)).toBe(
      defaultCanMerge(moving, stationary),
    );

    const merged = resultOn(
      target,
      'onMerge',
      mergePayload({ x: 1, y: 0 }, { x: 0, y: 0 }, 2, 2, 4, 4),
    );

    // The EFFECT hook is the one the guard withholds, so nothing new is frosted
    // and the merge resolves exactly as the rules produced it.
    expect(merged.invoked).toBe(0);
    expect(merged.skipped).toBe(1);
    expect(merged.failed).toBe(0);
    expect(merged.payload.resultValue).toBe(4);
    expect(merged.payload.scoreDelta).toBe(4);
  });

  it('leaves the relic s own state intact when invoked at zero', () => {
    const target = relicBench([{ id: 'frostbind', charges: 0 }]);

    dispatchOn(target, 'onStageStart', stageStartPayload(4));
    dispatchOn(
      target,
      'onMerge',
      mergePayload({ x: 1, y: 0 }, { x: 0, y: 0 }, 2, 2, 4, 4),
    );

    // The ledger it shipped with, unchanged and still serialisable.
    expect(JSON.parse(JSON.stringify(stateOf(target, 'frostbind')))).toEqual({
      frozen: [],
    });
  });

  it('keeps firing an unlimited relic beside an exhausted one', () => {
    const target = relicBench([
      { id: 'frostbind', charges: 0 },
      'echo-chamber',
    ]);
    const resolved = resultOn(
      target,
      'onMerge',
      mergePayload({ x: 1, y: 0 }, { x: 0, y: 0 }, 2, 2, 64, 64),
    );

    // One skipped, one invoked: an exhausted relic must not stop the dispatch.
    expect(resolved.invoked).toBe(1);
    expect(resolved.skipped).toBe(1);
    expect(resolved.payload.scoreDelta).toBe(80);
  });

  it('stops firing once the budget is spent through the bus', () => {
    const target = relicBench([{ id: 'frostbind', charges: 1 }]);

    expect(
      resultOn(target, 'onStageStart', stageStartPayload(4)).invoked,
    ).toBe(1);

    // The bus is the only thing that deducts, and a dispatch alone spends
    // nothing — so the budget falls exactly when a charge is consumed.
    const spent = target.bus.consumeCharge('frostbind', 1);

    expect(spent.held).toBe(true);
    expect(spent.limited).toBe(true);
    expect(spent.remaining).toBe(0);

    const after = resultOn(
      target,
      'onMerge',
      mergePayload({ x: 1, y: 0 }, { x: 0, y: 0 }, 2, 2, 4, 4),
    );

    expect(after.invoked).toBe(0);
    expect(after.skipped).toBe(1);
  });

  it('refuses to spend more than the budget holds, never going below 0', () => {
    const target = relicBench([{ id: 'frostbind', charges: 2 }]);
    const spent = target.bus.consumeCharge('frostbind', 5);

    expect(spent.remaining ?? -1).toBeGreaterThanOrEqual(0);
    expect(spent.consumed).toBeLessThanOrEqual(2);
  });
});

describe('two relics that both install a merge rule', () => {
  it('composes them into one chain, one layer per relic', () => {
    const target = relicBench(['frostbind', 'chain-catalyst']);

    dispatchOn(target, 'onStageStart', stageStartPayload(4));

    const composed = target.config.merge.canMerge;

    expect(composed).not.toBe(defaultCanMerge);

    // `frostbind` installed first, so `chain-catalyst` wrapped ITS wrapper:
    // unwrapping the ladder tag reaches the frost rule, and unwrapping the
    // frost tag from there reaches the untagged default.
    const ladder: unknown = (composed as unknown as Record<string, unknown>)[
      '__chainCatalystLadder'
    ];

    expect(typeof ladder).toBe('function');

    const frost: unknown = (ladder as Record<string, unknown>)[
      '__frostbindFrozenCells'
    ];

    expect(frost).toBe(defaultCanMerge);
  });

  it('keeps the verdicts of both relics, and of the base rule', () => {
    const target = relicBench(['frostbind', 'chain-catalyst']);

    dispatchOn(target, 'onStageStart', stageStartPayload(4));

    const composed = target.config.merge.canMerge;

    // The base rule's own verdict, the ladder pair `chain-catalyst` admits,
    // and a pair neither admits.
    expect(
      composed({ value: 4, mergedFrom: null }, { value: 4, mergedFrom: null }),
    ).toBe(true);
    expect(
      composed({ value: 2, mergedFrom: null }, { value: 4, mergedFrom: null }),
    ).toBe(true);
    expect(
      composed({ value: 2, mergedFrom: null }, { value: 16, mergedFrom: null }),
    ).toBe(false);
  });

  it('keeps the base rule reachable, and its verdicts, across stages', () => {
    const target = relicBench(['frostbind', 'chain-catalyst']);

    dispatchOn(target, 'onStageStart', stageStartPayload(4));

    const equalPair = (predicate: MergePredicate): boolean =>
      predicate(
        { value: 4, mergedFrom: null },
        { value: 4, mergedFrom: null },
      );
    const ladderPair = (predicate: MergePredicate): boolean =>
      predicate(
        { value: 2, mergedFrom: null },
        { value: 4, mergedFrom: null },
      );
    const unrelatedPair = (predicate: MergePredicate): boolean =>
      predicate(
        { value: 2, mergedFrom: null },
        { value: 16, mergedFrom: null },
      );
    const after = target.config.merge.canMerge;
    const opening = [
      equalPair(after),
      ladderPair(after),
      unrelatedPair(after),
    ];

    dispatchOn(target, 'onStageStart', stageStartPayload(4, 1));
    dispatchOn(target, 'onStageStart', stageStartPayload(4, 2));

    const later = target.config.merge.canMerge;

    // No drift: three stages of re-installation leave the same verdicts the
    // first stage produced.
    expect([equalPair(later), ladderPair(later), unrelatedPair(later)]).toEqual(
      opening,
    );

    // And the untagged default is still at the bottom of the chain, so no
    // re-installation has cut the base rule out of it.
    let base: unknown = later;

    for (let step = 0; step < 64; step += 1) {
      const held = ['__chainCatalystLadder', '__frostbindFrozenCells']
        .map((tag) => (base as Record<string, unknown>)[tag])
        .find((candidate) => typeof candidate === 'function');

      if (held === undefined) {
        break;
      }

      base = held;
    }

    expect(base).toBe(defaultCanMerge);
  });

  it('reinstalls over the fresh configuration a resumed run hands it', () => {
    const target = relicBench(['frostbind', 'chain-catalyst']);

    dispatchOn(target, 'onStageStart', stageStartPayload(4));

    // What a resumed run supplies: rules rebuilt from the defaults, so every
    // wrapper the previous session installed is gone.
    const fresh = createDefaultRulesConfig();

    target.config.merge.canMerge = fresh.merge.canMerge;
    dispatchOn(target, 'onStageStart', stageStartPayload(4, 1));

    const ladder: unknown = (
      target.config.merge.canMerge as unknown as Record<string, unknown>
    )['__chainCatalystLadder'];
    const frost: unknown = (ladder as Record<string, unknown>)[
      '__frostbindFrozenCells'
    ];

    expect(frost).toBe(defaultCanMerge);
  });

  it('reinstalls a spent relic s standing layer beside an unspent one', () => {
    const target = relicBench([
      { id: 'frostbind', charges: 0 },
      'chain-catalyst',
    ]);

    dispatchOn(target, 'onStageStart', stageStartPayload(4));

    // TWO LAYERS, in pickup order. The exhausted relic's stage-start install is
    // exempt from the charge guard, so its standing layer is at the bottom of
    // the chain and the unspent relic wraps it — which is what carries a frozen
    // ledger through a reload that restored a spent budget.
    const ladder: unknown = (
      target.config.merge.canMerge as unknown as Record<string, unknown>
    )['__chainCatalystLadder'];

    expect(ladder).toBeTypeOf('function');
    expect(ladder).not.toBe(defaultCanMerge);

    const frost: unknown = (ladder as Record<string, unknown>)[
      '__frostbindFrozenCells'
    ];

    expect(frost).toBe(defaultCanMerge);

    // The spent budget is still spent: nothing was deducted to reinstate it.
    expect(target.bus.subscribers()[0]?.charges).toBe(0);
  });
});
