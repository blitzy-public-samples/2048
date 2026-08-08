// Seeded reward snapshots: the draw sequence a reward offer is made from.
//
// WHAT THIS FILE RECORDS, AND WHAT IT DOES NOT
//   AAP V2's second half requires that one seed yield IDENTICAL RELIC OFFERS,
//   not merely an identical board. The offer is produced by a rarity-weighted
//   draw without replacement over the relic pool, taken from the `relic-draw`
//   and `rarity-weight` substreams.
//
//   Recorded here are the substreams themselves and the rarity table and tier
//   order of src/relics/relic-types.ts. NO RELIC IDENTIFIER APPEARS IN ANY
//   SNAPSHOT BELOW, and that is deliberate rather than provisional: the relic
//   catalogue and src/relics/relic-draw.ts have landed, and this file still
//   records the draw sequence alone so that adding, removing or reordering a
//   relic cannot invalidate a recorded run. This file does not stand in for
//   that module and does not simulate it.
//
//   What it does instead is pin the sequence of draws a rarity-weighted 1-of-3
//   selection without replacement consumes, at exactly the call sites such a
//   selection makes: one weighted tier draw per offered slot, then one index
//   draw per slot against a pool shrinking 16, 15, 14. When the draw module
//   lands, its offers are a pure function of these recorded values and the
//   catalogue order — so a change to the PRNG, to the substream derivation, to
//   `pickWeighted`'s walk or to the tier weights breaks a snapshot here and is
//   caught before it can silently make every recorded run's offers different.
//
// WHY THE TWO RELIC SUBSTREAMS ARE SEPARATE FROM THE TWO SPAWN SUBSTREAMS
//   Because a reward draw must not be able to move the board's sequence. That
//   is what lets tests/snapshot/seeded-boards.spec.ts keep its recorded boards
//   when the relic system arrives, and it is asserted here from the draw side as
//   well as there from the board side.

import { describe, expect, it } from 'vitest';

import {
  RNG_STREAM_NAMES,
  createRngStreams,
  type RngStreams,
  type StreamName,
} from '../../src/rng/rng-streams';
import {
  DEFAULT_RARITY_WEIGHTS,
  RARITIES,
  RELIC_FAMILY_NAMES,
  type Rarity,
} from '../../src/relics/relic-types';
import {
  formatCursors,
  formatDraws,
  formatPicks,
} from '../fixtures/snapshot-format';
import { PLATFORM_MATH_RANDOM } from '../fixtures/math-random-reference';

/* ==========================================================================
 * Harness
 * ========================================================================== */

/** Slots one reward offer holds, per AAP R8: choose 1 of 3. */
const OFFER_SLOTS = 3;

/** Relics the pool holds, per AAP A1: exactly sixteen, four per family. */
const POOL_SIZE = 16;

/** Seeds every case below is recorded at. */
const SEEDS: readonly string[] = [
  'reward-seed-alpha',
  'reward-seed-bravo',
  'reward-seed-charlie',
];

/** The rarity weights in tier order, as `pickWeighted` takes them. */
const RARITY_WEIGHTS: readonly number[] = RARITIES.map(
  (rarity) => DEFAULT_RARITY_WEIGHTS[rarity],
);

/** Draws `count` raw values from one named substream. */
function drawRaw(
  streams: RngStreams,
  name: StreamName,
  count: number,
): number[] {
  const stream = streams.stream(name);
  const drawn: number[] = [];

  for (let index = 0; index < count; index += 1) {
    drawn.push(stream.next());
  }

  return drawn;
}

/**
 * Draws the rarity tier of each of the three offered slots.
 *
 * `pickWeighted` is the shipped selection: one draw per call, scaled by the
 * total of the weights, then the weights walked in index order until the running
 * total exceeds it. The weights are the shipped table, halving per tier.
 */
function drawTiers(streams: RngStreams): (Rarity | undefined)[] {
  const stream = streams.stream('rarity-weight');
  const tiers: (Rarity | undefined)[] = [];

  for (let slot = 0; slot < OFFER_SLOTS; slot += 1) {
    tiers.push(stream.pickWeighted(RARITIES, RARITY_WEIGHTS));
  }

  return tiers;
}

/**
 * Draws the pool index of each of the three offered slots, WITHOUT REPLACEMENT.
 *
 * The pool shrinks by one per slot — 16, 15, 14 — which is the mechanism that
 * makes a duplicate in one offer structurally impossible rather than filtered
 * out afterwards. Indices are recorded rather than relic identifiers, because
 * the catalogue those indices would address has not landed.
 */
function drawPoolIndices(streams: RngStreams): number[] {
  const stream = streams.stream('relic-draw');
  const indices: number[] = [];

  for (let slot = 0; slot < OFFER_SLOTS; slot += 1) {
    indices.push(stream.nextInt(POOL_SIZE - slot));
  }

  return indices;
}

/**
 * Resolves three distinct pool positions from three shrinking-pool indices.
 *
 * The reduction a draw without replacement performs: each index selects from
 * what remains, and the selected entry is removed. Recorded so the mapping from
 * the drawn indices to distinct positions is itself pinned, and so the
 * no-duplicate property is visible in the stored artifact rather than only
 * asserted.
 */
function resolveDistinct(indices: readonly number[]): number[] {
  const remaining: number[] = [];

  for (let position = 0; position < POOL_SIZE; position += 1) {
    remaining.push(position);
  }

  return indices.map((index) => remaining.splice(index, 1)[0] ?? -1);
}

/* ==========================================================================
 * 1. The raw substream sequences
 * ========================================================================== */

describe('the relic substreams', () => {
  it.each(SEEDS)('reproduces its recorded relic-draw sequence for "%s"', (seed) => {
    expect(
      formatDraws(drawRaw(createRngStreams(seed), 'relic-draw', 12)),
    ).toMatchSnapshot();
  });

  it.each(SEEDS)(
    'reproduces its recorded rarity-weight sequence for "%s"',
    (seed) => {
      expect(
        formatDraws(drawRaw(createRngStreams(seed), 'rarity-weight', 12)),
      ).toMatchSnapshot();
    },
  );

  it('gives every substream of one seed a different sequence', () => {
    const streams = createRngStreams('substream-derivation');
    const first: Record<string, number> = {};

    for (const name of RNG_STREAM_NAMES) {
      first[name] = streams.stream(name).next();
    }

    // Each substream is seeded with `deriveStreamSeed(seed, name)`, so four
    // substreams of one seed are four sequences rather than one sequence read
    // four times. Were they equal, a relic draw and a spawn would move together.
    expect(new Set(Object.values(first)).size).toBe(RNG_STREAM_NAMES.length);
  });
});

/* ==========================================================================
 * 2. The offer draw
 * ========================================================================== */

describe('a reward offer drawn from a fixed seed', () => {
  it.each(SEEDS)('reproduces its recorded three tiers for "%s"', (seed) => {
    expect(formatPicks(drawTiers(createRngStreams(seed)))).toMatchSnapshot();
  });

  it.each(SEEDS)(
    'reproduces its recorded three pool positions for "%s"',
    (seed) => {
      const indices = drawPoolIndices(createRngStreams(seed));

      expect(
        [
          'drawn indices (pool shrinking 16, 15, 14)',
          formatDraws(indices),
          'resolved pool positions',
          formatDraws(resolveDistinct(indices)),
        ].join('\n'),
      ).toMatchSnapshot();
    },
  );

  it.each(SEEDS)('offers three distinct pool positions for "%s"', (seed) => {
    const positions = resolveDistinct(drawPoolIndices(createRngStreams(seed)));

    // No duplicate in one set of three, and not by filtering afterwards: the
    // pool a slot draws from no longer holds what the previous slot took.
    expect(new Set(positions).size).toBe(OFFER_SLOTS);
    expect(positions.every((position) => position >= 0 && position < POOL_SIZE)).toBe(
      true,
    );
  });

  it('reproduces its recorded offers across many consecutive draws', () => {
    // Twelve consecutive offers from one seed, which is more stages than a run
    // is likely to reach. Recorded as one artifact so a change in the sequence
    // shows up wherever in the run it occurs, not only on the first offer.
    const streams = createRngStreams('reward-sequence-long');
    const rendered: string[] = [];

    for (let offer = 0; offer < 12; offer += 1) {
      const tiers = drawTiers(streams);
      const positions = resolveDistinct(drawPoolIndices(streams));

      rendered.push(
        `offer ${String(offer + 1).padStart(2)}  tiers ${tiers.join(', ')}  ` +
          `positions ${positions.join(', ')}`,
      );
    }

    expect(
      [rendered.join('\n'), 'rngCursor', formatCursors(streams.snapshotCursors())].join(
        '\n',
      ),
    ).toMatchSnapshot();
  });
});

/* ==========================================================================
 * 3. Independence — what protects every other snapshot in this suite
 * ========================================================================== */

describe('drawing rewards', () => {
  it('leaves the two spawn substreams untouched', () => {
    const streams = createRngStreams('reward-independence');

    for (let offer = 0; offer < 8; offer += 1) {
      drawTiers(streams);
      drawPoolIndices(streams);
    }

    const cursors = streams.snapshotCursors();

    // Forty-eight relic draws, and the board's sequence has not moved. This is
    // the property that lets the relic system be added without invalidating a
    // single recorded board in tests/snapshot/seeded-boards.spec.ts.
    expect(cursors['spawn-value']).toBe(0);
    expect(cursors['spawn-position']).toBe(0);
    expect(cursors['rarity-weight']).toBe(24);
    expect(cursors['relic-draw']).toBe(24);
  });

  it('yields the same offers whether or not the board has been played', () => {
    const untouched = createRngStreams('reward-order-independence');
    const played = createRngStreams('reward-order-independence');

    // A board's worth of spawn draws taken first.
    for (let turn = 0; turn < 20; turn += 1) {
      played.stream('spawn-value').next();
      played.stream('spawn-position').next();
    }

    const before = formatPicks(drawTiers(untouched));
    const after = formatPicks(drawTiers(played));

    expect(after).toBe(before);
  });

  it('never replaces Math.random', () => {
    const streams = createRngStreams('reward-math-random-guard');

    drawTiers(streams);
    drawPoolIndices(streams);

    expect(Math.random).toBe(PLATFORM_MATH_RANDOM);
  });
});

/* ==========================================================================
 * 4. The shipped catalogue constants the draw reads
 * ========================================================================== */

describe('the draw tables', () => {
  it('reproduces its recorded rarity tiers and weights', () => {
    // Recorded because an offer is a function of these as much as of the seed: a
    // reordered tier list or a reweighted tier changes every offer ever drawn,
    // and this is the artifact that says so out loud.
    expect(
      RARITIES.map(
        (rarity) => `${rarity.padEnd(12)}${String(DEFAULT_RARITY_WEIGHTS[rarity])}`,
      ).join('\n'),
    ).toMatchSnapshot();
  });

  it('reproduces its recorded family order', () => {
    expect(RELIC_FAMILY_NAMES.join('\n')).toMatchSnapshot();
  });

  it('weights each tier at half the tier before it', () => {
    for (let index = 1; index < RARITIES.length; index += 1) {
      const previous = DEFAULT_RARITY_WEIGHTS[RARITIES[index - 1] as Rarity];
      const current = DEFAULT_RARITY_WEIGHTS[RARITIES[index] as Rarity];

      expect(current * 2).toBe(previous);
    }
  });
});
