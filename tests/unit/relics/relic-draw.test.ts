// The seeded reward draw: `drawRelicOffers` and `eligibleRelics` of
// src/relics/relic-draw.ts.
//
// Measures AAP validation gate V6 row 6, "Reward set of three: never contains
// duplicates", and the seeded half of AAP 0.1.2.5's second key flow, identical
// relic draws from one seed. AAP Contract 6 fixes the mechanism:
// rarity-weighted sampling WITHOUT replacement across the `relic-draw` and
// `rarity-weight` substreams.
//
// The without-replacement property is asserted STRUCTURALLY. A three-relic pool
// asked for three offers must return all three, once each, for every seed
// below; no repetition loop and no statistical threshold stands in for that
// proof.
//
// PROVENANCE
//   Every generator reached here is a LOCAL INSTANCE built from a literal seed.
//   Nothing in this file assigns to, wraps or reads `Math.random`; the global
//   never-patched invariant belongs to tests/unit/rng/math-random-guard.test.ts
//   and is not restated here. Section 4 carries the module-level source
//   assertion alone.
//   The two audited vanilla randomness sites are js/game_manager.js L71, the
//   spawn value, and js/grid.js L41, the spawn position. A reward draw reaches
//   neither, and the cursor assertions of section 4 are what measures that.
//
// TRACEABILITY (docs/TRACEABILITY_MATRIX.md)
//   `relic-draw` and `rarity-weight` are TARGET-ONLY substreams: no vanilla
//   construct drew for a reward, so their rows carry no source anchor. The two
//   substreams this suite proves untouched do carry one each: `spawn-value`
//   maps to js/game_manager.js L71 and `spawn-position` to js/grid.js L41.
//
// FIGURES THIS SUITE IS THE MECHANICAL PROOF OF
//   Figure 7, "Seeded Determinism: One Run Seed Fanned into Named RNG
//   Substreams", of docs/architecture/data-flow.md, whose `relic-draw` and
//   `rarity-weight` edges feed the `Sample 3 without replacement` node that
//   produces the `Reward offer set, no duplicates`, and whose legend records
//   that substream separation is what lets a relic draw without shifting the
//   spawn sequence.
//   Figure 6, "Screen Flow State Machine: Run Start to Run Summary", whose
//   Reward note records that three cards are drawn without replacement so no
//   duplicate can appear in one set.
//
// Collected by the unit:dom-free project of vitest.config.ts, environment
// 'node'. Nothing here reads a document, a Web Storage global, a clock, a
// timer or a network; no snapshot artifact is written, and reporting reaches
// this file only through an injected sink.
//
// COVERAGE BOUNDARIES THIS SUITE STAYS INSIDE
//   The catalogue's own shape is tests/unit/relics/relic-registry.test.ts, the
//   substream derivation and the draw arithmetic are tests/unit/rng/*.test.ts,
//   the reward transaction is tests/unit/relics/reward-resolution.test.ts, and
//   the recorded offer sequences are tests/snapshot/, run under
//   vitest.snapshot.config.ts.
//
// Decisions behind the module under test, argued in docs/DECISION_LOG.md and
// named here only so each construct can be found from the log:
//   DL-DRAW-01  sampling without replacement
//   DL-DRAW-02  the two substreams consumed, and no others
//   DL-DRAW-03  one draw from each substream per offer RETURNED

import { beforeEach, describe, expect, it } from 'vitest';

import type { HookHandler } from '../../../src/engine/hooks';
import {
  drawRelicOffers,
  eligibleRelics,
} from '../../../src/relics/relic-draw';
import {
  RELIC_CATALOGUE,
  RELIC_FAMILIES,
} from '../../../src/relics/relic-registry';
import {
  DEFAULT_RARITY_WEIGHTS,
  RARITIES,
} from '../../../src/relics/relic-types';
import type { Rarity, Relic } from '../../../src/relics/relic-types';
import {
  RNG_STREAM_NAMES,
  createRngStreams,
} from '../../../src/rng/rng-streams';
import type {
  RngRejection,
  RngReporter,
  RngStreams,
  StreamName,
} from '../../../src/rng/rng-streams';
import {
  createSeededRng,
  deriveStreamSeed,
} from '../../../src/rng/seeded-rng';

/* ==========================================================================
 * Harness
 * ========================================================================== */

/** Offers one reward screen presents: three cards. */
const OFFER_COUNT = 3;

/** Relics the catalogue declares: sixteen. */
const CATALOGUE_SIZE = 16;

/** Seed the stream set rebuilt before every test is derived from. */
const SEED = 'blitzy-relic-draw';

/** A second seed, distinct from `SEED`. */
const OTHER_SEED = 'blitzy-relic-draw-beta';

/**
 * Seeds a structural property is asserted against, one assertion per seed.
 * Enumerated literals, so the inputs are identical on every run.
 */
const SEEDS: readonly string[] = Object.freeze([
  'alpha',
  'beta',
  'gamma',
  'delta',
  'epsilon',
  'zeta',
  'eta',
  'theta',
]);

/** The two substreams one reward draw consumes. */
const CONSUMED_STREAMS: readonly StreamName[] = Object.freeze([
  'relic-draw',
  'rarity-weight',
]);

/**
 * Correlation identifier of the run these assertions stand for. Carried by the
 * handler the fixture relics bind and by the reporter injected into a restore,
 * so neither drops it.
 */
const CORRELATION_ID = 'run-blitzy-relic-draw';

/** Every tier weighted out of reach, for an override to build on. */
const NO_TIER_WEIGHTED: Readonly<Record<Rarity, number>> = Object.freeze({
  common: 0,
  uncommon: 0,
  rare: 0,
  legendary: 0,
});

/**
 * An override that leaves the common tier overwhelmingly likely and the
 * legendary tier reachable in principle alone. Both weights are finite, so
 * `weightOf` honours each as written rather than falling back per key.
 */
const COMMON_FAVOURED: Readonly<Record<Rarity, number>> = Object.freeze({
  common: 1_000_000,
  uncommon: 0,
  rare: 0,
  legendary: 0.000_001,
});

/**
 * Handler the fixture relics bind. Carries the dispatch's correlation
 * identifier into the relic's own state slot and returns nothing, so the
 * identifier travels with the dispatch rather than being dropped.
 */
const carryCorrelation: HookHandler<'onAfterMove'> = (_payload, context) => {
  context.state = context.correlationId;
};

/** One fixture relic: the seven members `Relic` declares and no eighth. */
function relicNamed(id: string, rarity: Rarity): Relic {
  return Object.freeze<Relic>({
    id,
    name: `Fixture ${id}`,
    rarity,
    description: `Fixture relic ${id}.`,
    hooks: Object.freeze({ onAfterMove: carryCorrelation }),
  });
}

/** One fixture relic per tier, in `RARITIES` order. */
function oneOfEachTier(): Relic[] {
  return RARITIES.map((rarity, index) => relicNamed(`tier-${index}`, rarity));
}

/** `size` fixture relics sharing one tier, in declaration order. */
function oneTierOnly(rarity: Rarity, size: number): Relic[] {
  return Array.from({ length: size }, (_unused, index) =>
    relicNamed(`${rarity}-${String(index)}`, rarity),
  );
}

function idsOf(relics: readonly Relic[]): string[] {
  return relics.map((entry) => entry.id);
}

/** Every substream cursor of `source`, as a plain record. */
function cursorsOf(source: RngStreams): Record<string, number> {
  return { ...source.snapshotCursors() };
}

/** Draws an offer set over a stream set built from `seed` alone. */
function drawFrom(
  pool: readonly Relic[],
  seed: string,
  count = OFFER_COUNT,
): readonly Relic[] {
  return drawRelicOffers({ pool, count, streams: createRngStreams(seed) });
}

/** One rejection a restore reported, tagged with the correlation identifier. */
interface TaggedRejection {
  readonly correlationId: string;
  readonly rejection: RngRejection;
}

/**
 * A reporter that records what a restore refused, tagging every entry with
 * `CORRELATION_ID`. No `console` member is reached, and no observability module
 * is imported: the sink is injected and read by the assertion alone.
 */
function recordingReporter(sink: TaggedRejection[]): RngReporter {
  return {
    onRejected: (rejection: RngRejection): void => {
      sink.push({ correlationId: CORRELATION_ID, rejection });
    },
  };
}

/** The tiers `pool` still holds a candidate in, in `RARITIES` order. */
function tiersOf(pool: readonly Relic[]): Rarity[] {
  return RARITIES.filter((rarity) =>
    pool.some((entry) => entry.rarity === rarity),
  );
}

/** The relics of `pool` sitting in `rarity`, in pool order. */
function candidatesOf(
  pool: readonly Relic[],
  rarity: Rarity | undefined,
): Relic[] {
  return pool.filter((entry) => entry.rarity === rarity);
}

/**
 * The first offer a PARALLEL pair of substreams selects from `pool` under the
 * default weights: one `rarity-weight` draw over the tiers holding a candidate,
 * then one `relic-draw` draw within the tier that won. Built from `seed` at
 * cursor zero, which is where the draw under test starts.
 */
function firstOfferByParallelStreams(
  pool: readonly Relic[],
  seed: string,
): Relic | undefined {
  const parallel = createRngStreams(seed);
  const tiers = tiersOf(pool);
  const weights = tiers.map((rarity) => DEFAULT_RARITY_WEIGHTS[rarity]);
  const tier = parallel.stream('rarity-weight').pickWeighted(tiers, weights);

  return parallel.stream('relic-draw').pick(candidatesOf(pool, tier));
}

/**
 * The same first offer computed from the DERIVED SUBSTREAM SEEDS directly: the
 * weighted walk src/rng/rng-streams.ts documents applied to one draw of the
 * `rarity-weight` generator, then the index arithmetic applied to one draw of
 * the `relic-draw` generator.
 */
function firstOfferBySeedArithmetic(
  pool: readonly Relic[],
  seed: string,
): Relic | undefined {
  const tiers = tiersOf(pool);
  const weights = tiers.map((rarity) => DEFAULT_RARITY_WEIGHTS[rarity]);
  const total = weights.reduce((running, weight) => running + weight, 0);
  const target =
    createSeededRng(deriveStreamSeed(seed, 'rarity-weight')).next() * total;
  let accumulated = 0;
  let index = 0;

  for (const weight of weights) {
    accumulated += weight;

    if (accumulated > target) {
      break;
    }

    index += 1;
  }

  const tier = tiers[Math.min(index, tiers.length - 1)];
  const candidates = candidatesOf(pool, tier);
  const draw = createSeededRng(deriveStreamSeed(seed, 'relic-draw')).next();

  return candidates[Math.floor(draw * candidates.length)];
}

/** The catalogue order read once, for the closing immutability assertion. */
const CATALOGUE_IDS_AT_LOAD: readonly string[] = Object.freeze(
  idsOf(RELIC_CATALOGUE),
);

/** Rebuilt before every test, so no cursor position leaks between them. */
let streams: RngStreams;

beforeEach(() => {
  streams = createRngStreams(SEED);
});

/* ==========================================================================
 * 1. Eligibility: the relics a run does not already hold
 * ========================================================================== */

describe('eligibleRelics', () => {
  it('returns the whole pool, in pool order, for a run holding nothing', () => {
    const pool = oneOfEachTier();

    expect(idsOf(eligibleRelics(pool))).toEqual(idsOf(pool));
    expect(idsOf(eligibleRelics(RELIC_CATALOGUE))).toEqual(
      idsOf(RELIC_CATALOGUE),
    );
  });

  it('returns exactly the pool minus the owned ids, in pool order', () => {
    const pool = oneOfEachTier();

    expect(idsOf(eligibleRelics(pool, ['tier-1', 'tier-3']))).toEqual([
      'tier-0',
      'tier-2',
    ]);
  });

  it('reads an owned Set exactly as it reads an owned array', () => {
    const pool = oneOfEachTier();
    const asArray = eligibleRelics(pool, ['tier-0', 'tier-3']);
    const asSet = eligibleRelics(pool, new Set(['tier-0', 'tier-3']));

    expect(idsOf(asArray)).toEqual(['tier-1', 'tier-2']);
    expect(idsOf(asSet)).toEqual(idsOf(asArray));
  });

  it('excludes an owned relic by identifier, never by object identity', () => {
    const pool = oneOfEachTier();

    // A DIFFERENT object under the same identifier, which is what a restored
    // run holds: the envelope persists identifiers, not instances.
    const restored = relicNamed('tier-2', RARITIES[2]);

    expect(restored).not.toBe(pool[2]);
    expect(idsOf(eligibleRelics(pool, [restored.id]))).toEqual([
      'tier-0',
      'tier-1',
      'tier-3',
    ]);
  });

  it('returns the whole pool for an empty array and for an empty Set', () => {
    const pool = oneOfEachTier();

    expect(idsOf(eligibleRelics(pool, []))).toEqual(idsOf(pool));
    expect(idsOf(eligibleRelics(pool, new Set<string>()))).toEqual(idsOf(pool));
  });

  it('ignores an owned identifier the pool does not carry', () => {
    const pool = oneOfEachTier();

    expect(
      idsOf(eligibleRelics(pool, ['no-such-relic', '', 'tier-99'])),
    ).toEqual(idsOf(pool));
  });

  it('keeps the first of a repeated identifier and drops the rest', () => {
    const first = relicNamed('twin', RARITIES[0]);
    const second = relicNamed('twin', RARITIES[1]);
    const other = relicNamed('other', RARITIES[2]);
    const eligible = eligibleRelics([first, second, other]);

    expect(eligible).toHaveLength(2);
    expect(eligible[0]).toBe(first);
    expect(idsOf(eligible)).toEqual(['twin', 'other']);
  });

  it('returns nothing, without throwing, for a pool owned outright', () => {
    const pool = oneOfEachTier();

    expect(() => eligibleRelics(pool, idsOf(pool))).not.toThrow();
    expect(eligibleRelics(pool, idsOf(pool))).toEqual([]);
    expect(eligibleRelics(RELIC_CATALOGUE, idsOf(RELIC_CATALOGUE))).toEqual([]);
  });

  it('returns nothing, without throwing, for an empty pool', () => {
    expect(() => eligibleRelics([])).not.toThrow();
    expect(eligibleRelics([])).toEqual([]);
    expect(eligibleRelics([], ['tier-0'])).toEqual([]);
  });

  it('modifies neither the pool array nor the owned collection', () => {
    const pool = oneOfEachTier();
    const members = [...pool];
    const ownedArray = ['tier-0'];
    const ownedSet = new Set(['tier-1']);

    eligibleRelics(pool, ownedArray);
    eligibleRelics(pool, ownedSet);

    expect(pool).toHaveLength(members.length);
    expect(idsOf(pool)).toEqual(idsOf(members));
    pool.forEach((entry, index) => {
      expect(entry).toBe(members[index]);
    });
    expect(ownedArray).toEqual(['tier-0']);
    expect([...ownedSet]).toEqual(['tier-1']);
  });

  it('consumes no randomness, so every cursor stands where it stood', () => {
    const before = cursorsOf(streams);

    eligibleRelics(RELIC_CATALOGUE, ['twin-seed']);
    eligibleRelics(oneOfEachTier(), new Set(['tier-2']));

    expect(cursorsOf(streams)).toEqual(before);
  });
});

/* ==========================================================================
 * 2. The offer set: sampling WITHOUT replacement
 * ========================================================================== */

describe('drawRelicOffers samples without replacement', () => {
  it('returns all three of a three-relic pool, once each, per seed', () => {
    const pool = oneOfEachTier().slice(0, OFFER_COUNT);

    for (const seed of SEEDS) {
      const offered = idsOf(drawFrom(pool, seed));

      // Sampling without replacement can produce only total coverage of the
      // pool; sampling with replacement cannot produce it for every seed.
      expect(offered, seed).toHaveLength(OFFER_COUNT);
      expect(new Set(offered).size, seed).toBe(OFFER_COUNT);
      expect([...offered].sort(), seed).toEqual([...idsOf(pool)].sort());
    }
  });

  it('returns all three of a single-tier three-relic pool, per seed', () => {
    const pool = oneTierOnly('rare', OFFER_COUNT);

    for (const seed of SEEDS) {
      const offered = idsOf(drawFrom(pool, seed));

      expect(offered, seed).toHaveLength(OFFER_COUNT);
      expect([...offered].sort(), seed).toEqual([...idsOf(pool)].sort());
    }
  });

  it('offers three pairwise distinct catalogue relics for every seed', () => {
    for (const seed of SEEDS) {
      const offered = idsOf(drawFrom(RELIC_CATALOGUE, seed));
      const distinct = new Set(offered);

      expect(offered, seed).toHaveLength(OFFER_COUNT);
      expect(distinct.size, `${seed}: ${offered.join(', ')}`).toBe(
        offered.length,
      );
    }
  });

  it('returns min(count, pool length) distinct relics, never padding', () => {
    const twoRelics = oneOfEachTier().slice(0, 2);
    const oneRelic = oneOfEachTier().slice(0, 1);
    const fromTwo = drawFrom(twoRelics, SEED);
    const fromOne = drawFrom(oneRelic, SEED);

    expect(fromTwo).toHaveLength(2);
    expect(new Set(idsOf(fromTwo)).size).toBe(2);
    expect(fromOne).toHaveLength(1);
    expect(idsOf(fromOne)).toEqual(['tier-0']);

    for (const offered of [fromTwo, fromOne]) {
      for (const entry of offered) {
        expect(entry).toBeDefined();
        expect(typeof entry.id).toBe('string');
      }
    }
  });

  it('offers nothing, without throwing, for an empty pool', () => {
    expect(() => drawFrom([], SEED)).not.toThrow();
    expect(drawFrom([], SEED)).toEqual([]);
  });

  it('returns nothing for a count of zero and one for a count of one', () => {
    expect(drawFrom(RELIC_CATALOGUE, SEED, 0)).toEqual([]);
    expect(drawFrom(RELIC_CATALOGUE, SEED, 1)).toHaveLength(1);
    expect(drawFrom(oneOfEachTier(), SEED, 0)).toEqual([]);
    expect(drawFrom(oneOfEachTier(), SEED, 1)).toHaveLength(1);
  });

  it('returns the sixteen distinct catalogue relics for a larger count', () => {
    const offered = drawFrom(RELIC_CATALOGUE, SEED, CATALOGUE_SIZE + 5);

    expect(RELIC_CATALOGUE).toHaveLength(CATALOGUE_SIZE);
    expect(offered).toHaveLength(CATALOGUE_SIZE);
    expect(new Set(idsOf(offered)).size).toBe(CATALOGUE_SIZE);
  });

  it('returns three offers when the caller names no count', () => {
    expect(
      drawRelicOffers({ pool: RELIC_CATALOGUE, streams }),
    ).toHaveLength(OFFER_COUNT);
  });

  it('truncates a fractional count towards zero', () => {
    expect(drawFrom(RELIC_CATALOGUE, SEED, 2.9)).toHaveLength(2);
    expect(drawFrom(RELIC_CATALOGUE, SEED, 1.1)).toHaveLength(1);
  });

  it('returns nothing for a count that is not a positive finite number', () => {
    for (const count of [0, -1, -2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(drawFrom(RELIC_CATALOGUE, SEED, count), String(count)).toEqual([]);
    }
  });

  it('offers only relics the supplied pool carries, as its own objects', () => {
    const pool = oneOfEachTier();

    for (const seed of SEEDS) {
      for (const offered of drawFrom(pool, seed)) {
        expect(idsOf(pool), seed).toContain(offered.id);
        expect(pool, seed).toContain(offered);
      }

      for (const offered of drawFrom(RELIC_CATALOGUE, seed)) {
        expect(idsOf(RELIC_CATALOGUE), seed).toContain(offered.id);
        expect(offered).toBe(
          RELIC_CATALOGUE.find((entry) => entry.id === offered.id),
        );
      }
    }
  });

  it('offers no relic whose rarity falls outside the four tiers', () => {
    const offBook = relicNamed('off-book', 'mythic' as Rarity);
    const offered = drawFrom(
      [offBook, ...RELIC_CATALOGUE],
      SEED,
      CATALOGUE_SIZE + 1,
    );

    expect(offered).toHaveLength(CATALOGUE_SIZE);
    expect(idsOf(offered)).not.toContain('off-book');
  });

  it('offers no relic the run already holds, for every seed', () => {
    const owned = idsOf(RELIC_CATALOGUE).slice(0, 6);

    for (const seed of SEEDS) {
      const offered = drawRelicOffers({
        pool: RELIC_CATALOGUE,
        ownedIds: owned,
        streams: createRngStreams(seed),
      });

      expect(offered, seed).toHaveLength(OFFER_COUNT);

      for (const entry of offered) {
        expect(owned, seed).not.toContain(entry.id);
      }
    }
  });

  it('offers the two remaining relics when a run owns all but two', () => {
    const owned = idsOf(RELIC_CATALOGUE).slice(0, CATALOGUE_SIZE - 2);
    const remaining = idsOf(RELIC_CATALOGUE).slice(CATALOGUE_SIZE - 2);
    const offered = drawRelicOffers({
      pool: RELIC_CATALOGUE,
      ownedIds: owned,
      count: OFFER_COUNT,
      streams,
    });

    expect(offered).toHaveLength(2);
    expect([...idsOf(offered)].sort()).toEqual([...remaining].sort());
    expect(new Set(idsOf(offered)).size).toBe(2);
  });

  it('offers nothing, without throwing, for a pool owned outright', () => {
    const owned = idsOf(RELIC_CATALOGUE);

    expect(() =>
      drawRelicOffers({ pool: RELIC_CATALOGUE, ownedIds: owned, streams }),
    ).not.toThrow();
    expect(
      drawRelicOffers({
        pool: RELIC_CATALOGUE,
        ownedIds: owned,
        streams: createRngStreams(SEED),
      }),
    ).toEqual([]);
  });

  it('offers what it would have offered when an owned id is unknown', () => {
    const withUnknown = drawRelicOffers({
      pool: RELIC_CATALOGUE,
      ownedIds: ['no-such-relic', '', 'tier-99'],
      streams,
    });

    expect(idsOf(withUnknown)).toEqual(idsOf(drawFrom(RELIC_CATALOGUE, SEED)));
  });
});


/* ==========================================================================
 * 3. Rarity weighting
 * ========================================================================== */

describe('drawRelicOffers weights the rarity tiers', () => {
  it('carries a positive finite default weight for every tier', () => {
    for (const rarity of RARITIES) {
      const weight = DEFAULT_RARITY_WEIGHTS[rarity];

      expect(weight, rarity).toBeTypeOf('number');
      expect(Number.isFinite(weight), rarity).toBe(true);
      expect(weight, rarity).toBeGreaterThan(0);
    }

    expect(Object.keys(DEFAULT_RARITY_WEIGHTS).sort()).toEqual(
      [...RARITIES].sort(),
    );
  });

  it('weights the tiers strictly downwards from common to legendary', () => {
    const weights = RARITIES.map((rarity) => DEFAULT_RARITY_WEIGHTS[rarity]);

    weights.forEach((weight, index) => {
      const next = weights[index + 1];

      if (next !== undefined) {
        expect(weight, RARITIES[index]).toBeGreaterThan(next);
      }
    });
  });

  it('selects the first offer a parallel substream pair selects', () => {
    const pool = oneOfEachTier();

    for (const seed of SEEDS) {
      const drawn = drawFrom(pool, seed, 1)[0];

      expect(drawn?.id, seed).toBe(firstOfferByParallelStreams(pool, seed)?.id);
    }
  });

  it('selects the first offer the derived seeds compute independently', () => {
    const pools = [oneOfEachTier(), oneTierOnly('uncommon', 4)];

    for (const pool of pools) {
      for (const seed of SEEDS) {
        const drawn = drawFrom(pool, seed, 1)[0];

        expect(drawn?.id, seed).toBe(
          firstOfferBySeedArithmetic(pool, seed)?.id,
        );
      }
    }
  });

  it('offers the favoured tier alone when an override skews the draw', () => {
    const pool = [...oneTierOnly('common', 4), relicNamed('l0', 'legendary')];

    for (const seed of SEEDS) {
      const offered = drawRelicOffers({
        pool,
        count: 1,
        weights: COMMON_FAVOURED,
        streams: createRngStreams(seed),
      });

      expect(offered, seed).toHaveLength(1);
      expect(offered[0]?.rarity, seed).toBe('common');
      expect(offered[0]?.id, seed).not.toBe('l0');
    }
  });

  it('offers three pairwise distinct relics under a skewed override', () => {
    const pool = [...oneTierOnly('common', 4), relicNamed('l0', 'legendary')];

    for (const seed of SEEDS) {
      const offered = drawRelicOffers({
        pool,
        count: OFFER_COUNT,
        weights: COMMON_FAVOURED,
        streams: createRngStreams(seed),
      });
      const offeredIds = idsOf(offered);

      expect(offered, seed).toHaveLength(OFFER_COUNT);
      expect(new Set(offeredIds).size, offeredIds.join(', ')).toBe(
        OFFER_COUNT,
      );
    }
  });

  it('never offers a tier an override weights at zero', () => {
    const pool = oneOfEachTier();
    const zeroCommon: Readonly<Record<Rarity, number>> = {
      ...DEFAULT_RARITY_WEIGHTS,
      common: 0,
    };

    for (const seed of SEEDS) {
      for (const offered of drawRelicOffers({
        pool,
        count: OFFER_COUNT,
        weights: zeroCommon,
        streams: createRngStreams(seed),
      })) {
        expect(offered.rarity, seed).not.toBe('common');
      }
    }
  });

  it('offers nothing when an override weights every tier at zero', () => {
    expect(
      drawRelicOffers({
        pool: RELIC_CATALOGUE,
        weights: NO_TIER_WEIGHTED,
        streams,
      }),
    ).toEqual([]);
  });

  it('reaches every tier an override singles out, one tier at a time', () => {
    const pool = oneOfEachTier();

    // Deterministic reachability: each tier is favoured alone, so the tier the
    // draw resolves to is fixed rather than sampled.
    for (const rarity of RARITIES) {
      const only: Readonly<Record<Rarity, number>> = {
        ...NO_TIER_WEIGHTED,
        [rarity]: 1,
      };
      const offered = drawRelicOffers({
        pool,
        count: OFFER_COUNT,
        weights: only,
        streams: createRngStreams(SEED),
      });

      expect(offered, rarity).toHaveLength(1);
      expect(offered[0]?.rarity, rarity).toBe(rarity);
    }
  });

  it('keeps the default weight of a tier an override leaves unstated', () => {
    const pool = oneOfEachTier();
    const partial = { common: 1 } as Readonly<Record<Rarity, number>>;
    const reached = new Set<Rarity>();

    for (const seed of SEEDS) {
      for (const offered of drawRelicOffers({
        pool,
        count: RARITIES.length,
        weights: partial,
        streams: createRngStreams(seed),
      })) {
        reached.add(offered.rarity);
      }
    }

    // Every unstated tier keeps a positive default weight, so a request for
    // four from a four-relic pool still exhausts it.
    expect([...reached].sort()).toEqual([...RARITIES].sort());
  });

  it('keeps the default weight of a tier stated as a non-finite number', () => {
    const pool = oneOfEachTier();
    const notFinite = {
      ...NO_TIER_WEIGHTED,
      common: Number.NaN,
    } as Readonly<Record<Rarity, number>>;
    const offered = drawRelicOffers({
      pool,
      count: OFFER_COUNT,
      weights: notFinite,
      streams,
    });

    expect(offered).toHaveLength(1);
    expect(offered[0]?.rarity).toBe('common');
  });

  it('draws the requested count from a pool of one tier alone', () => {
    const pool = oneTierOnly('legendary', 5);

    for (const seed of SEEDS) {
      const offered = drawFrom(pool, seed);

      expect(offered, seed).toHaveLength(OFFER_COUNT);
      expect(new Set(idsOf(offered)).size, seed).toBe(OFFER_COUNT);

      for (const entry of offered) {
        expect(entry.rarity, seed).toBe('legendary');
      }
    }
  });

  it('offers the common tier more often than the legendary tier', () => {
    const pool = oneOfEachTier();
    const counted = new Map<Rarity, number>();

    // Sixty enumerated literal seeds, drawn one offer each. The seed list is
    // fixed, so this is a fixed computation rather than a sample. The two
    // deterministic selection assertions above hold the same property.
    for (let index = 0; index < 60; index += 1) {
      for (const offered of drawFrom(pool, `frequency-${String(index)}`, 1)) {
        counted.set(offered.rarity, (counted.get(offered.rarity) ?? 0) + 1);
      }
    }

    expect(counted.get('common') ?? 0).toBeGreaterThan(
      counted.get('legendary') ?? 0,
    );
  });
});


/* ==========================================================================
 * 4. Determinism, cursor accounting and substream discipline
 * ========================================================================== */

describe('drawRelicOffers is reproducible from its seed', () => {
  it('offers the same relics, in the same order, from one seed', () => {
    const first = idsOf(drawFrom(RELIC_CATALOGUE, SEED));
    const second = idsOf(drawFrom(RELIC_CATALOGUE, SEED));

    expect(second).toEqual(first);
    expect(second).toHaveLength(OFFER_COUNT);
  });

  it('offers the same three successive sets from one seed', () => {
    const drawThree = (source: RngStreams): string[][] =>
      [0, 1, 2].map(() =>
        idsOf(drawRelicOffers({ pool: RELIC_CATALOGUE, streams: source })),
      );
    const live = drawThree(createRngStreams(SEED));
    const replayed = drawThree(createRngStreams(SEED));

    expect(replayed).toEqual(live);
    expect(live[0]).not.toEqual(live[1]);
  });

  it('offers a different set from a different seed', () => {
    expect(idsOf(drawFrom(RELIC_CATALOGUE, OTHER_SEED))).not.toEqual(
      idsOf(drawFrom(RELIC_CATALOGUE, SEED)),
    );
  });

  it('advances the relic-draw and rarity-weight cursors and no others', () => {
    const before = cursorsOf(streams);

    drawRelicOffers({ pool: RELIC_CATALOGUE, streams });

    const after = cursorsOf(streams);

    // Iterated rather than enumerated, so a substream added later is asserted
    // untouched instead of being ignored.
    for (const name of RNG_STREAM_NAMES) {
      if (CONSUMED_STREAMS.includes(name)) {
        expect(after[name], name).toBeGreaterThan(before[name] ?? 0);
      } else {
        expect(after[name], name).toBe(before[name]);
      }
    }

    expect(after['spawn-value']).toBe(0);
    expect(after['spawn-position']).toBe(0);
  });

  it('takes one draw from each consumed substream per offer returned', () => {
    const before = cursorsOf(streams);
    const offered = drawRelicOffers({
      pool: RELIC_CATALOGUE,
      count: OFFER_COUNT,
      streams,
    });
    const after = cursorsOf(streams);

    for (const name of CONSUMED_STREAMS) {
      expect((after[name] ?? 0) - (before[name] ?? 0), name).toBe(
        offered.length,
      );
    }
  });

  it('takes no draw at all for a count of zero', () => {
    const before = cursorsOf(streams);

    drawRelicOffers({ pool: RELIC_CATALOGUE, count: 0, streams });

    expect(cursorsOf(streams)).toEqual(before);
  });

  it('leaves every cursor unmoved when the pool is empty', () => {
    const before = cursorsOf(streams);

    expect(drawRelicOffers({ pool: [], streams })).toEqual([]);

    const after = cursorsOf(streams);

    for (const name of RNG_STREAM_NAMES) {
      expect(after[name], name).toBe(before[name]);
    }
  });

  it('leaves every cursor unmoved when the run owns the pool outright', () => {
    const before = cursorsOf(streams);

    expect(
      drawRelicOffers({
        pool: RELIC_CATALOGUE,
        ownedIds: idsOf(RELIC_CATALOGUE),
        streams,
      }),
    ).toEqual([]);

    for (const name of RNG_STREAM_NAMES) {
      expect(cursorsOf(streams)[name], name).toBe(before[name]);
    }
  });

  it('takes no draw once the pool is exhausted mid-request', () => {
    const pool = oneOfEachTier().slice(0, 2);

    drawRelicOffers({ pool, count: OFFER_COUNT, streams });

    const spent = cursorsOf(streams);

    for (const name of CONSUMED_STREAMS) {
      expect(spent[name], name).toBe(2);
    }
  });

  it('advances its cursors, so a second draw on one stream set differs', () => {
    const first = idsOf(drawRelicOffers({ pool: RELIC_CATALOGUE, streams }));
    const second = idsOf(drawRelicOffers({ pool: RELIC_CATALOGUE, streams }));

    expect(second).not.toEqual(first);
  });

  it('reproduces the interrupted draw from the cursors it recorded', () => {
    const live = createRngStreams(SEED);
    const first = idsOf(
      drawRelicOffers({ pool: RELIC_CATALOGUE, streams: live }),
    );
    const captured = live.snapshotCursors();
    const continued = idsOf(
      drawRelicOffers({
        pool: RELIC_CATALOGUE,
        ownedIds: first,
        streams: live,
      }),
    );
    const resumed = createRngStreams(SEED, captured);
    const afterReload = idsOf(
      drawRelicOffers({
        pool: RELIC_CATALOGUE,
        ownedIds: first,
        streams: resumed,
      }),
    );

    // Non-vacuous: the captured cursors stand three draws in, so a restore that
    // silently started over would disagree.
    expect(captured['relic-draw']).toBe(OFFER_COUNT);
    expect(captured['rarity-weight']).toBe(OFFER_COUNT);
    expect(afterReload).toEqual(continued);
  });

  it('restores a well-formed cursor map without reporting a rejection', () => {
    const sink: TaggedRejection[] = [];
    const live = createRngStreams(SEED);

    drawRelicOffers({ pool: RELIC_CATALOGUE, streams: live });

    const resumed = createRngStreams(
      SEED,
      live.snapshotCursors(),
      recordingReporter(sink),
    );

    expect(idsOf(drawRelicOffers({ pool: RELIC_CATALOGUE, streams: resumed })))
      .toEqual(
        idsOf(drawRelicOffers({ pool: RELIC_CATALOGUE, streams: live })),
      );
    expect(sink).toEqual([]);
  });

  it('draws from the start, without throwing, on an unusable cursor', () => {
    const sink: TaggedRejection[] = [];
    const restored = createRngStreams(
      SEED,
      { 'relic-draw': -1 },
      recordingReporter(sink),
    );

    expect(
      idsOf(drawRelicOffers({ pool: RELIC_CATALOGUE, streams: restored })),
    ).toEqual(idsOf(drawFrom(RELIC_CATALOGUE, SEED)));
    expect(sink).toHaveLength(1);
    expect(sink[0]?.correlationId).toBe(CORRELATION_ID);
    expect(sink[0]?.rejection.stream).toBe('relic-draw');
    expect(sink[0]?.rejection.kind).toBe('cursor-unusable');
  });

  it('reaches Math.random in neither exported function', () => {
    for (const exported of [drawRelicOffers, eligibleRelics]) {
      expect(exported.toString(), exported.name).not.toContain('Math.random');
    }
  });
});


/* ==========================================================================
 * 5. Pool order, which a draw resolves its index against
 * ========================================================================== */

describe('drawRelicOffers resolves a draw against pool order', () => {
  it('offers a different relic from a reordered single-tier pool', () => {
    const pool = oneTierOnly('common', 4);
    const reordered = [...pool].reverse();

    // One tier and an even member count: the index a draw resolves to addresses
    // a different relic in each order, whatever the seed.
    for (const seed of SEEDS) {
      const fromPool = drawFrom(pool, seed, 1)[0]?.id;
      const fromReordered = drawFrom(reordered, seed, 1)[0]?.id;

      expect(fromPool, seed).toBeDefined();
      expect(fromReordered, seed).not.toBe(fromPool);
    }
  });

  it('offers a different set from the reversed catalogue, per seed', () => {
    const reversed = [...RELIC_CATALOGUE].reverse();

    for (const seed of SEEDS) {
      expect(idsOf(drawFrom(reversed, seed)), seed).not.toEqual(
        idsOf(drawFrom(RELIC_CATALOGUE, seed)),
      );
    }
  });

  it('resolves against the catalogue order the families flatten into', () => {
    const flattened = RELIC_FAMILIES.flatMap((family) => [...family.relics]);

    expect(idsOf(RELIC_CATALOGUE)).toEqual(idsOf(flattened));
    expect(idsOf(RELIC_CATALOGUE)).toEqual([...CATALOGUE_IDS_AT_LOAD]);
  });

  it('keeps the pool order of a partially owned pool eligible', () => {
    const pool = RELIC_CATALOGUE;
    const owned = [pool[0]?.id ?? '', pool[7]?.id ?? ''];
    const eligible = eligibleRelics(pool, owned);

    expect(idsOf(eligible)).toEqual(
      idsOf(pool).filter((id) => !owned.includes(id)),
    );
  });
});

/* ==========================================================================
 * 6. The caller's own inputs
 * ========================================================================== */

describe('drawRelicOffers leaves the caller inputs as it found them', () => {
  it('leaves the pool length, order and member identities untouched', () => {
    const pool = [...RELIC_CATALOGUE];
    const members = [...pool];

    drawRelicOffers({ pool, count: 5, streams });

    expect(pool).toHaveLength(members.length);
    expect(idsOf(pool)).toEqual(idsOf(members));
    pool.forEach((entry, index) => {
      expect(entry).toBe(members[index]);
    });
  });

  it('leaves the frozen catalogue untouched when drawn from directly', () => {
    drawRelicOffers({
      pool: RELIC_CATALOGUE,
      count: CATALOGUE_SIZE,
      streams,
    });

    expect(idsOf(RELIC_CATALOGUE)).toEqual([...CATALOGUE_IDS_AT_LOAD]);
    expect(RELIC_CATALOGUE).toHaveLength(CATALOGUE_SIZE);
  });

  it('leaves an owned array and an owned Set untouched', () => {
    const ownedArray = ['twin-seed', 'frostbind'];
    const ownedSet = new Set(['echo-chamber', 'tumbler']);

    drawRelicOffers({
      pool: RELIC_CATALOGUE,
      ownedIds: ownedArray,
      streams,
    });
    drawRelicOffers({
      pool: RELIC_CATALOGUE,
      ownedIds: ownedSet,
      streams,
    });

    expect(ownedArray).toEqual(['twin-seed', 'frostbind']);
    expect([...ownedSet]).toEqual(['echo-chamber', 'tumbler']);
  });

  it('leaves every relic of the pool, and its hook table, untouched', () => {
    const pool = oneOfEachTier();
    const hookTables = pool.map((entry) => entry.hooks);

    drawRelicOffers({ pool, count: RARITIES.length, streams });

    pool.forEach((entry, index) => {
      expect(entry.hooks).toBe(hookTables[index]);
      expect(entry.hooks.onAfterMove).toBe(carryCorrelation);
      expect(entry.charges).toBeUndefined();
      expect(entry.state).toBeUndefined();
    });
  });

  it('leaves the catalogue and a fixture pool intact after many draws', () => {
    const pool = oneOfEachTier();
    const members = [...pool];

    for (const seed of SEEDS) {
      drawFrom(pool, seed);
      drawFrom(pool, seed, RARITIES.length);
      drawFrom(RELIC_CATALOGUE, seed, CATALOGUE_SIZE);
      drawRelicOffers({
        pool,
        count: OFFER_COUNT,
        weights: COMMON_FAVOURED,
        streams: createRngStreams(seed),
      });
    }

    expect(idsOf(pool)).toEqual(idsOf(members));
    expect(idsOf(RELIC_CATALOGUE)).toEqual([...CATALOGUE_IDS_AT_LOAD]);
    expect(RELIC_CATALOGUE).toHaveLength(CATALOGUE_SIZE);
  });
});
