// The seeded reward draw: rarity-weighted sampling WITHOUT replacement.
//
// TWO SUITES IN ONE FILE, because two review units each wrote one against the
// same unchanged module and both sets of expectations are worth keeping. Each
// derives its own substreams from its own seed, so neither observes the other's
// draw sequence.

import { describe, expect, it } from 'vitest';

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
import { createRngStreams } from '../../../src/rng/rng-streams';
import type { RngStreams } from '../../../src/rng/rng-streams';

/* ===== Fixtures ===== */

const SEED = 'blitzy-reward-draw';

const OTHER_SEED = 'blitzy-reward-draw-beta';

const OFFER_COUNT = 3;

/** Seeds the duplicate-freedom and weighting properties are swept over. */
const SWEEP = 200;

const ZERO_WEIGHTS: Readonly<Record<Rarity, number>> = Object.freeze({
  common: 0,
  uncommon: 0,
  rare: 0,
  legendary: 0,
});

function streams(seed = SEED): ReturnType<typeof createRngStreams> {
  return createRngStreams(seed);
}

function offerIds(seed: string, count = OFFER_COUNT): string[] {
  return drawRelicOffers({
    pool: RELIC_CATALOGUE,
    count,
    streams: streams(seed),
  }).map((relic) => relic.id);
}

/* ===== eligibleRelics ===== */

describe('eligibleRelics', () => {
  it('offers the whole pool to a run holding nothing', () => {
    expect(eligibleRelics(RELIC_CATALOGUE)).toHaveLength(
      RELIC_CATALOGUE.length,
    );
  });

  it('keeps the pool order', () => {
    expect(eligibleRelics(RELIC_CATALOGUE).map((relic) => relic.id)).toEqual(
      RELIC_CATALOGUE.map((relic) => relic.id),
    );
  });

  it('excludes an owned relic by identifier', () => {
    const owned = [RELIC_CATALOGUE[0]?.id ?? '', RELIC_CATALOGUE[5]?.id ?? ''];
    const eligible = eligibleRelics(RELIC_CATALOGUE, owned);

    expect(eligible).toHaveLength(RELIC_CATALOGUE.length - 2);

    for (const id of owned) {
      expect(eligible.map((relic) => relic.id)).not.toContain(id);
    }
  });

  it('accepts a set as readily as an array', () => {
    const owned = new Set([RELIC_CATALOGUE[1]?.id ?? '']);

    expect(eligibleRelics(RELIC_CATALOGUE, owned)).toHaveLength(
      RELIC_CATALOGUE.length - 1,
    );
  });

  it('never returns two relics under one identifier', () => {
    const doubled = [...RELIC_CATALOGUE, ...RELIC_CATALOGUE];
    const ids = eligibleRelics(doubled).map((relic) => relic.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('modifies neither the pool nor the owned set it was given', () => {
    const owned = new Set([RELIC_CATALOGUE[0]?.id ?? '']);

    eligibleRelics(RELIC_CATALOGUE, owned);

    expect(owned.size).toBe(1);
    expect(RELIC_CATALOGUE).toHaveLength(16);
  });

  it('consumes no randomness', () => {
    const set = streams();
    const before = set.snapshotCursors();

    eligibleRelics(RELIC_CATALOGUE);

    expect(set.snapshotCursors()).toEqual(before);
  });
});

/* ===== drawRelicOffers: no duplicates ===== */

describe('drawRelicOffers duplicate freedom', () => {
  it('NEVER offers one relic twice in one set of three', () => {
    for (let seed = 0; seed < SWEEP; seed += 1) {
      const ids = offerIds(`${SEED}-${String(seed)}`);

      expect(ids).toHaveLength(OFFER_COUNT);
      expect(new Set(ids).size).toBe(OFFER_COUNT);
    }
  });

  it('never offers a relic the run already holds', () => {
    const owned = RELIC_CATALOGUE.slice(0, 6).map((relic) => relic.id);

    for (let seed = 0; seed < SWEEP; seed += 1) {
      const offered = drawRelicOffers({
        pool: RELIC_CATALOGUE,
        ownedIds: owned,
        streams: streams(`${SEED}-owned-${String(seed)}`),
      });

      for (const relic of offered) {
        expect(owned).not.toContain(relic.id);
      }
    }
  });

  it('exhausts the pool without repeating, however large the request', () => {
    const offered = drawRelicOffers({
      pool: RELIC_CATALOGUE,
      count: RELIC_CATALOGUE.length + 5,
      streams: streams(),
    });

    expect(offered).toHaveLength(RELIC_CATALOGUE.length);
    expect(new Set(offered.map((relic) => relic.id)).size).toBe(
      RELIC_CATALOGUE.length,
    );
  });

  it('offers a pool of one relic exactly once', () => {
    const pool = RELIC_CATALOGUE.slice(0, 1);

    expect(
      drawRelicOffers({ pool, count: OFFER_COUNT, streams: streams() }),
    ).toHaveLength(1);
  });
});

/* ===== drawRelicOffers: seeded reproducibility ===== */

describe('drawRelicOffers determinism', () => {
  it('offers the same relics, in the same order, from one seed', () => {
    expect(offerIds(SEED)).toEqual(offerIds(SEED));
  });

  it('offers a different set from a different seed', () => {
    expect(offerIds(SEED)).not.toEqual(offerIds(OTHER_SEED));
  });

  it('continues the same sequence from a restored cursor', () => {
    const live = streams();
    const first = drawRelicOffers({
      pool: RELIC_CATALOGUE,
      streams: live,
    }).map((relic) => relic.id);
    const second = drawRelicOffers({
      pool: RELIC_CATALOGUE,
      ownedIds: first,
      streams: live,
    }).map((relic) => relic.id);

    // A run resumed from the recorded cursors draws what the live run drew.
    const resumed = createRngStreams(SEED, live.snapshotCursors());
    const beforeReload = createRngStreams(SEED);

    drawRelicOffers({ pool: RELIC_CATALOGUE, streams: beforeReload });
    drawRelicOffers({
      pool: RELIC_CATALOGUE,
      ownedIds: first,
      streams: beforeReload,
    });

    const continued = drawRelicOffers({
      pool: RELIC_CATALOGUE,
      ownedIds: [...first, ...second],
      streams: resumed,
    }).map((relic) => relic.id);
    const uninterrupted = drawRelicOffers({
      pool: RELIC_CATALOGUE,
      ownedIds: [...first, ...second],
      streams: beforeReload,
    }).map((relic) => relic.id);

    expect(continued).toEqual(uninterrupted);
  });

  it('advances the two draw substreams and no others', () => {
    const set = streams();
    const before = set.snapshotCursors();

    drawRelicOffers({ pool: RELIC_CATALOGUE, streams: set });

    const after = set.snapshotCursors();

    expect(after['rarity-weight']).toBeGreaterThan(before['rarity-weight']);
    expect(after['relic-draw']).toBeGreaterThan(before['relic-draw']);
    expect(after['spawn-value']).toBe(before['spawn-value']);
    expect(after['spawn-position']).toBe(before['spawn-position']);
  });

  it('takes one draw from each of the two per offer returned', () => {
    const set = streams();
    const before = set.snapshotCursors();
    const offered = drawRelicOffers({
      pool: RELIC_CATALOGUE,
      count: OFFER_COUNT,
      streams: set,
    });
    const after = set.snapshotCursors();

    expect(after['rarity-weight'] - before['rarity-weight']).toBe(
      offered.length,
    );
    expect(after['relic-draw'] - before['relic-draw']).toBe(offered.length);
  });

  it('takes no draw at all for a request of no offers', () => {
    const set = streams();
    const before = set.snapshotCursors();

    expect(
      drawRelicOffers({ pool: RELIC_CATALOGUE, count: 0, streams: set }),
    ).toHaveLength(0);
    expect(set.snapshotCursors()).toEqual(before);
  });

  it('takes no draw at all from an empty pool', () => {
    const set = streams();
    const before = set.snapshotCursors();

    expect(drawRelicOffers({ pool: [], streams: set })).toHaveLength(0);
    expect(set.snapshotCursors()).toEqual(before);
  });
});

/* ===== drawRelicOffers: rarity weighting ===== */

describe('drawRelicOffers rarity weighting', () => {
  it('offers the common tier more often than the legendary one', () => {
    const counts: Record<string, number> = {};

    for (let seed = 0; seed < SWEEP; seed += 1) {
      for (const relic of drawRelicOffers({
        pool: RELIC_CATALOGUE,
        streams: streams(`${SEED}-weight-${String(seed)}`),
      })) {
        counts[relic.rarity] = (counts[relic.rarity] ?? 0) + 1;
      }
    }

    const common = counts[RARITIES[0]] ?? 0;
    const legendary = counts[RARITIES[3]] ?? 0;

    expect(common).toBeGreaterThan(legendary);
  });

  it('reaches every tier over many draws', () => {
    const seen = new Set<string>();

    for (let seed = 0; seed < SWEEP; seed += 1) {
      for (const relic of drawRelicOffers({
        pool: RELIC_CATALOGUE,
        streams: streams(`${SEED}-cover-${String(seed)}`),
      })) {
        seen.add(relic.rarity);
      }
    }

    for (const rarity of RARITIES) {
      expect(seen).toContain(rarity);
    }
  });

  it('honours an override that weights one tier alone', () => {
    const onlyRare: Readonly<Record<Rarity, number>> = {
      ...ZERO_WEIGHTS,
      rare: 1,
    };

    for (let seed = 0; seed < 40; seed += 1) {
      for (const relic of drawRelicOffers({
        pool: RELIC_CATALOGUE,
        weights: onlyRare,
        streams: streams(`${SEED}-only-rare-${String(seed)}`),
      })) {
        expect(relic.rarity).toBe('rare');
      }
    }
  });

  it('offers nothing when every tier is weighted to zero', () => {
    expect(
      drawRelicOffers({
        pool: RELIC_CATALOGUE,
        weights: ZERO_WEIGHTS,
        streams: streams(),
      }),
    ).toHaveLength(0);
  });

  it('falls back per key for an override that states no finite weight', () => {
    const partial = {
      ...ZERO_WEIGHTS,
      common: Number.NaN,
    } as Readonly<Record<Rarity, number>>;
    const offered = drawRelicOffers({
      pool: RELIC_CATALOGUE,
      weights: partial,
      streams: streams(),
    });

    for (const relic of offered) {
      expect(relic.rarity).toBe(RARITIES[0]);
    }

    expect(offered.length).toBeGreaterThan(0);
  });
});

/* ===== drawRelicOffers: degradation ===== */

describe('drawRelicOffers degradation', () => {
  it('offers nothing when the run owns the pool outright', () => {
    expect(
      drawRelicOffers({
        pool: RELIC_CATALOGUE,
        ownedIds: RELIC_CATALOGUE.map((relic) => relic.id),
        streams: streams(),
      }),
    ).toHaveLength(0);
  });

  it('reduces a count that is not a usable number to none', () => {
    for (const count of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        drawRelicOffers({
          pool: RELIC_CATALOGUE,
          count,
          streams: streams(),
        }).length,
      ).toBeLessThanOrEqual(RELIC_CATALOGUE.length);
    }

    expect(
      drawRelicOffers({ pool: RELIC_CATALOGUE, count: -1, streams: streams() }),
    ).toHaveLength(0);
    expect(
      drawRelicOffers({
        pool: RELIC_CATALOGUE,
        count: Number.NaN,
        streams: streams(),
      }),
    ).toHaveLength(0);
  });

  it('truncates a fractional count towards zero', () => {
    expect(
      drawRelicOffers({ pool: RELIC_CATALOGUE, count: 2.9, streams: streams() }),
    ).toHaveLength(2);
  });

  it('defaults to three offers when the caller names no count', () => {
    expect(
      drawRelicOffers({ pool: RELIC_CATALOGUE, streams: streams() }),
    ).toHaveLength(OFFER_COUNT);
  });

  it('returns the relics of the pool themselves, not copies', () => {
    for (const relic of drawRelicOffers({
      pool: RELIC_CATALOGUE,
      streams: streams(),
    })) {
      expect(RELIC_CATALOGUE).toContain(relic);
    }
  });

  it('modifies neither the pool nor any relic in it', () => {
    const before = JSON.stringify(
      RELIC_CATALOGUE.map((relic) => ({
        id: relic.id,
        charges: relic.charges,
        state: relic.state,
      })),
    );

    drawRelicOffers({ pool: RELIC_CATALOGUE, count: 8, streams: streams() });

    expect(
      JSON.stringify(
        RELIC_CATALOGUE.map((relic) => ({
          id: relic.id,
          charges: relic.charges,
          state: relic.state,
        })),
      ),
    ).toBe(before);
  });

  it('never offers a relic whose rarity is outside the four tiers', () => {
    const offBook = {
      ...(RELIC_CATALOGUE[0] as (typeof RELIC_CATALOGUE)[number]),
      id: 'off-book',
      rarity: 'mythic' as Rarity,
    };

    for (const relic of drawRelicOffers({
      pool: [offBook, ...RELIC_CATALOGUE],
      count: RELIC_CATALOGUE.length + 1,
      streams: streams(),
    })) {
      expect(relic.id).not.toBe('off-book');
    }
  });
});

/* ==========================================================================
 * Harness
 * ========================================================================== */

const BENCH_SEED = 'relic-draw-suite';

/** A minimal relic carrying only what the draw reads. */
function stub(id: string, rarity: Rarity): Relic {
  return Object.freeze<Relic>({
    id,
    name: id,
    rarity,
    description: id,
    hooks: Object.freeze({}),
  });
}

/** One stub per tier, in `RARITIES` order. */
function oneOfEachTier(): Relic[] {
  return RARITIES.map((rarity, index) => stub(`tier-${index}`, rarity));
}

function benchStreams(seed = BENCH_SEED): RngStreams {
  return createRngStreams(seed);
}

function idsOf(offers: readonly Relic[]): string[] {
  return offers.map((relic) => relic.id);
}

/** Every cursor of a stream set, as a plain record. */
function cursors(source: RngStreams): Record<string, number> {
  return { ...source.snapshotCursors() };
}

/* ==========================================================================
 * 1. Eligibility
 * ========================================================================== */

describe('eligibility', () => {
  it('offers the whole pool when the run holds nothing', () => {
    const pool = oneOfEachTier();

    expect(idsOf(eligibleRelics(pool))).toEqual(idsOf(pool));
  });

  it('excludes an owned relic by identifier, not by object identity', () => {
    const pool = oneOfEachTier();

    // A DIFFERENT OBJECT carrying the same identifier, which is what a restored
    // run holds after a reload: the envelope persists identifiers, so the relic
    // a run owns is never the catalogue's own instance.
    const owned = [stub('tier-1', RARITIES[1]).id];
    const eligible = eligibleRelics(pool, owned);

    expect(idsOf(eligible)).toEqual(['tier-0', 'tier-2', 'tier-3']);
  });

  it('accepts the owned set as an array or as a Set', () => {
    const pool = oneOfEachTier();
    const asArray = eligibleRelics(pool, ['tier-0', 'tier-3']);
    const asSet = eligibleRelics(pool, new Set(['tier-0', 'tier-3']));

    expect(idsOf(asArray)).toEqual(idsOf(asSet));
    expect(idsOf(asArray)).toEqual(['tier-1', 'tier-2']);
  });

  it('keeps the first of a repeated identifier and drops the rest', () => {
    const first = stub('twin', RARITIES[0]);
    const second = stub('twin', RARITIES[1]);
    const other = stub('other', RARITIES[2]);
    const eligible = eligibleRelics([first, second, other]);

    expect(eligible).toHaveLength(2);
    expect(eligible[0]).toBe(first);
    expect(idsOf(eligible)).toEqual(['twin', 'other']);
  });

  it('writes to neither the pool nor the owned set', () => {
    const pool = oneOfEachTier();
    const owned = ['tier-0'];

    eligibleRelics(pool, owned);

    expect(idsOf(pool)).toEqual(['tier-0', 'tier-1', 'tier-2', 'tier-3']);
    expect(owned).toEqual(['tier-0']);
  });

  it('consumes no randomness', () => {
    const source = benchStreams();
    const before = cursors(source);

    eligibleRelics(oneOfEachTier(), ['tier-2']);

    expect(cursors(source)).toEqual(before);
  });

  it('yields nothing for a pool the run owns outright', () => {
    const pool = oneOfEachTier();

    expect(eligibleRelics(pool, idsOf(pool))).toEqual([]);
  });
});

/* ==========================================================================
 * 2. The offer set
 * ========================================================================== */

describe('the offer set', () => {
  it('draws three by default', () => {
    const offers = drawRelicOffers({
      pool: oneOfEachTier(),
      streams: benchStreams(),
    });

    expect(offers).toHaveLength(3);
  });

  it('never offers the same relic twice in one set', () => {
    // Every seed, over the whole catalogue: the property is structural, so it
    // must hold for all of them rather than for the one a fixture picked.
    for (let index = 0; index < 200; index += 1) {
      const offers = drawRelicOffers({
        pool: RELIC_CATALOGUE,
        streams: benchStreams(`no-duplicates-${index}`),
      });
      const ids = idsOf(offers);

      expect(offers).toHaveLength(3);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('offers no relic the run already holds', () => {
    const owned = idsOf(RELIC_CATALOGUE).slice(0, 13);

    for (let index = 0; index < 50; index += 1) {
      const offers = drawRelicOffers({
        pool: RELIC_CATALOGUE,
        ownedIds: owned,
        streams: benchStreams(`owned-${index}`),
      });

      expect(offers).toHaveLength(3);

      for (const relic of offers) {
        expect(owned).not.toContain(relic.id);
      }
    }
  });

  it('returns what it can rather than raising when the pool runs short', () => {
    const pool = oneOfEachTier().slice(0, 2);
    const offers = drawRelicOffers({ pool, streams: benchStreams() });

    expect(offers).toHaveLength(2);
    expect(new Set(idsOf(offers)).size).toBe(2);
  });

  it('returns nothing for an empty pool, and for one owned outright', () => {
    expect(drawRelicOffers({ pool: [], streams: benchStreams() })).toEqual([]);
    expect(
      drawRelicOffers({
        pool: RELIC_CATALOGUE,
        ownedIds: idsOf(RELIC_CATALOGUE),
        streams: benchStreams(),
      }),
    ).toEqual([]);
  });

  it('honours a count, and refuses one that is not a positive number', () => {
    const pool = RELIC_CATALOGUE;

    const one = drawRelicOffers({ pool, count: 1, streams: benchStreams() });
    const five = drawRelicOffers({ pool, count: 5, streams: benchStreams() });

    expect(one).toHaveLength(1);
    expect(five).toHaveLength(5);

    // Truncated towards zero rather than rounded.
    expect(
      drawRelicOffers({ pool, count: 2.9, streams: benchStreams() }),
    ).toHaveLength(2);

    for (const refused of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        drawRelicOffers({ pool, count: refused, streams: benchStreams() }),
      ).toEqual([]);
    }
  });

  it('never offers more than the pool holds, however large the count', () => {
    const offers = drawRelicOffers({
      pool: RELIC_CATALOGUE,
      count: RELIC_CATALOGUE.length + 20,
      streams: benchStreams(),
    });

    expect(offers).toHaveLength(RELIC_CATALOGUE.length);
    expect(new Set(idsOf(offers)).size).toBe(RELIC_CATALOGUE.length);
  });
});

/* ==========================================================================
 * 3. Rarity weighting
 * ========================================================================== */

describe('rarity weighting', () => {
  it('reaches every tier the default weights admit', () => {
    const seen = new Set<Rarity>();

    for (let index = 0; index < 300; index += 1) {
      for (const relic of drawRelicOffers({
        pool: RELIC_CATALOGUE,
        count: 1,
        streams: benchStreams(`tiers-${index}`),
      })) {
        seen.add(relic.rarity);
      }
    }

    // All four are weighted above zero by `DEFAULT_RARITY_WEIGHTS`, so all four
    // must be reachable.
    expect(seen.size).toBe(RARITIES.length);
  });

  it('offers the more heavily weighted tier more often', () => {
    const pool = oneOfEachTier();
    const counts = new Map<Rarity, number>();

    for (let index = 0; index < 400; index += 1) {
      for (const relic of drawRelicOffers({
        pool,
        count: 1,
        streams: benchStreams(`weighted-${index}`),
      })) {
        counts.set(relic.rarity, (counts.get(relic.rarity) ?? 0) + 1);
      }
    }

    const common = counts.get(RARITIES[0]) ?? 0;
    const rarest = counts.get(RARITIES[RARITIES.length - 1]) ?? 0;

    // The default table weights the tiers strictly downwards, and one relic per
    // tier makes the tier draw the only thing deciding the outcome.
    expect(DEFAULT_RARITY_WEIGHTS[RARITIES[0]]).toBeGreaterThan(
      DEFAULT_RARITY_WEIGHTS[RARITIES[RARITIES.length - 1]],
    );
    expect(common).toBeGreaterThan(rarest);
  });

  it('makes a tier weighted at zero unreachable', () => {
    const pool = oneOfEachTier();
    const weights = { ...DEFAULT_RARITY_WEIGHTS, [RARITIES[0]]: 0 };

    for (let index = 0; index < 60; index += 1) {
      for (const relic of drawRelicOffers({
        pool,
        count: 3,
        weights,
        streams: benchStreams(`zeroed-${index}`),
      })) {
        expect(relic.rarity).not.toBe(RARITIES[0]);
      }
    }
  });

  it('stops at the tiers a weight table leaves reachable', () => {
    const pool = oneOfEachTier();
    const only = RARITIES.reduce<Record<string, number>>((table, rarity) => {
      table[rarity] = rarity === RARITIES[2] ? 1 : 0;

      return table;
    }, {}) as Record<Rarity, number>;

    // One tier reachable and one relic in it: three were asked for and one is
    // all that can be offered.
    const offers = drawRelicOffers({
      pool,
      count: 3,
      weights: only,
      streams: benchStreams(),
    });

    expect(idsOf(offers)).toEqual(['tier-2']);
  });

  it('falls back per key for a weight a table leaves unstated', () => {
    const pool = oneOfEachTier();

    // Only one key given: every other tier keeps its default weight, so all
    // four stay reachable.
    const partial = { [RARITIES[0]]: 1 } as Record<Rarity, number>;
    const seen = new Set<Rarity>();

    for (let index = 0; index < 200; index += 1) {
      for (const relic of drawRelicOffers({
        pool,
        count: 1,
        weights: partial,
        streams: benchStreams(`partial-${index}`),
      })) {
        seen.add(relic.rarity);
      }
    }

    expect(seen.size).toBe(RARITIES.length);
  });
});

/* ==========================================================================
 * 4. Determinism and cursor consumption
 * ========================================================================== */

describe('determinism', () => {
  it('offers the same set for the same seed, every time', () => {
    const first = drawRelicOffers({
      pool: RELIC_CATALOGUE,
      streams: benchStreams('replay'),
    });
    const second = drawRelicOffers({
      pool: RELIC_CATALOGUE,
      streams: benchStreams('replay'),
    });

    expect(idsOf(first)).toEqual(idsOf(second));
  });

  it('offers a different set for a different seed', () => {
    const seen = new Set<string>();

    for (let index = 0; index < 40; index += 1) {
      seen.add(
        idsOf(
          drawRelicOffers({
            pool: RELIC_CATALOGUE,
            streams: benchStreams(`varies-${index}`),
          }),
        ).join(','),
      );
    }

    expect(seen.size).toBeGreaterThan(1);
  });

  it('takes one draw from each of its two substreams per offer', () => {
    const source = benchStreams();
    const before = cursors(source);

    drawRelicOffers({ pool: RELIC_CATALOGUE, count: 3, streams: source });

    const after = cursors(source);

    expect(after['rarity-weight'] - before['rarity-weight']).toBe(3);
    expect(after['relic-draw'] - before['relic-draw']).toBe(3);
  });

  it('moves neither spawn substream', () => {
    const source = benchStreams();
    const before = cursors(source);

    drawRelicOffers({ pool: RELIC_CATALOGUE, streams: source });

    const after = cursors(source);

    // A reward that moved these would change the board a recorded seed
    // produces, which is the whole reason the substreams are separate.
    expect(after['spawn-value']).toBe(before['spawn-value']);
    expect(after['spawn-position']).toBe(before['spawn-position']);
  });

  it('takes no draw at all for a count that yields nothing', () => {
    const source = benchStreams();
    const before = cursors(source);

    drawRelicOffers({ pool: RELIC_CATALOGUE, count: 0, streams: source });

    expect(cursors(source)).toEqual(before);
  });

  it('takes no draw once the pool is exhausted', () => {
    const source = benchStreams();
    const pool = oneOfEachTier().slice(0, 2);

    drawRelicOffers({ pool, count: 3, streams: source });

    const spent = cursors(source);

    // Two offers were returned, so two draws were taken from each substream —
    // not the three that were asked for.
    expect(spent['rarity-weight']).toBe(2);
    expect(spent['relic-draw']).toBe(2);
  });

  it('advances the cursors, so a second draw on one set differs', () => {
    const source = benchStreams('sequential');
    const first = idsOf(
      drawRelicOffers({ pool: RELIC_CATALOGUE, streams: source }),
    );
    const second = idsOf(
      drawRelicOffers({ pool: RELIC_CATALOGUE, streams: source }),
    );

    // Both sets are drawn from the same pool with no owned list, so an
    // identical pair would mean the second draw had restarted the sequence.
    expect(second).not.toEqual(first);
  });
});

/* ==========================================================================
 * 5. Immutability of the caller's inputs
 * ========================================================================== */

describe('the caller s inputs', () => {
  it('leaves the pool and its order untouched', () => {
    const pool = [...RELIC_CATALOGUE];
    const before = idsOf(pool);

    drawRelicOffers({ pool, count: 5, streams: benchStreams() });

    expect(idsOf(pool)).toEqual(before);
    expect(pool).toHaveLength(RELIC_CATALOGUE.length);
  });

  it('draws over the frozen catalogue itself without writing to it', () => {
    const before = idsOf(RELIC_CATALOGUE);

    drawRelicOffers({
      pool: RELIC_CATALOGUE,
      count: RELIC_CATALOGUE.length,
      streams: benchStreams(),
    });

    expect(idsOf(RELIC_CATALOGUE)).toEqual(before);
  });

  it('leaves the owned array untouched', () => {
    const owned = ['twin-seed', 'frostbind'];

    drawRelicOffers({
      pool: RELIC_CATALOGUE,
      ownedIds: owned,
      streams: benchStreams(),
    });

    expect(owned).toEqual(['twin-seed', 'frostbind']);
  });

  it('leaves the owned Set untouched', () => {
    const owned = new Set(['twin-seed', 'frostbind']);

    drawRelicOffers({
      pool: RELIC_CATALOGUE,
      ownedIds: owned,
      streams: benchStreams(),
    });

    expect([...owned]).toEqual(['twin-seed', 'frostbind']);
  });

  it('returns the catalogue s own relic objects, unmodified', () => {
    const offers = drawRelicOffers({
      pool: RELIC_CATALOGUE,
      streams: benchStreams(),
    });

    for (const offered of offers) {
      const source = RELIC_CATALOGUE.find(
        (candidate) => candidate.id === offered.id,
      );

      expect(offered).toBe(source);
    }
  });
});

/* ==========================================================================
 * 6. The catalogue the reward screen draws from
 * ========================================================================== */

describe('the catalogue', () => {
  it('holds sixteen relics, four to a family', () => {
    expect(RELIC_CATALOGUE).toHaveLength(16);
    expect(RELIC_FAMILIES).toHaveLength(4);

    for (const family of RELIC_FAMILIES) {
      expect(family.relics, family.name).toHaveLength(4);
    }
  });

  it('carries no repeated identifier', () => {
    const ids = idsOf(RELIC_CATALOGUE);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('flattens its families in family order, then declaration order', () => {
    const flattened = RELIC_FAMILIES.flatMap((family) => [...family.relics]);

    // The order a recorded seed's drawn index resolves against, so it is part
    // of the determinism contract rather than a presentation detail.
    expect(idsOf(RELIC_CATALOGUE)).toEqual(idsOf(flattened));
  });

  it('seats one relic of each tier in every family', () => {
    for (const family of RELIC_FAMILIES) {
      expect(
        family.relics.map((relic) => relic.rarity),
        family.name,
      ).toEqual([...RARITIES]);
    }
  });
});
