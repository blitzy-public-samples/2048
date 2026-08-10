// The seeded reward draw: the offer set a reward screen presents.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
// this module's area enumerated:
//   TR-DRAW-01  js/game_manager.js L71  the weighted two-value choice,
//                                       generalised into the rarity-weighted
//                                       selection of a tier
//   TR-DRAW-02  js/grid.js L37-L43      the uniform selection, generalised
//                                       into the selection of one relic within
//                                       the winning tier, and its
//                                       nothing-to-select boundary
//   TR-DRAW-03  target-only row         `drawRewardOffer`, which samples
//                                       WITHOUT replacement
//
// Decisions: DL-DRAW-01, DL-DRAW-02, DL-DRAW-03 (docs/DECISION_LOG.md).

import {
  DEFAULT_RARITY_WEIGHTS,
  RARITIES,
  type Rarity,
  type Relic,
} from './relic-types';
import type { RngStream, RngStreams } from '../rng/rng-streams';

/** Offers a reward screen presents when the caller names no count. */
const DEFAULT_OFFER_COUNT = 3;

/** One reward draw. */
export interface RelicDrawOptions {
  readonly pool: readonly Relic[];
  readonly ownedIds?: readonly string[] | ReadonlySet<string>;
  readonly count?: number;
  readonly streams: RngStreams;
  readonly weights?: Readonly<Record<Rarity, number>>;
}

/** Tiers a selection can be made from, and their weights in that order. */
interface SelectableTiers {
  readonly tiers: readonly Rarity[];
  readonly weights: readonly number[];
}

/**
 * The relics of `pool` a draw can offer: those a run does not already hold, in
 * the order `pool` carries them.
 *
 * `id` is the identity. An owned relic is excluded by identifier and never by
 * object identity, and a pool carrying one identifier more than once keeps its
 * first entry alone, so the result can never hold two relics with the same
 * identifier whatever the caller passed.
 *
 * Consumes no randomness. Returns a fresh array, and modifies neither `pool`
 * nor `ownedIds`.
 */
export function eligibleRelics(
  pool: readonly Relic[],
  ownedIds?: readonly string[] | ReadonlySet<string>
): readonly Relic[] {
  // One lookup for both accepted shapes, built by copy: the caller's own set
  // is never added to.
  const excluded = new Set<string>(ownedIds ?? []);
  const eligible: Relic[] = [];

  for (const relic of pool) {
    if (excluded.has(relic.id)) {
      continue;
    }

    // Admitting the identifier to the same set suppresses a later repeat of it
    // in `pool`.
    excluded.add(relic.id);
    eligible.push(relic);
  }

  return eligible;
}

/**
 * Reduces a requested offer count to a number of selections that can be
 * attempted.
 */
function clampOfferCount(count: number | undefined): number {
  if (count === undefined) {
    return DEFAULT_OFFER_COUNT;
  }

  if (!Number.isFinite(count) || count <= 0) {
    return 0;
  }

  return Math.floor(count);
}

function weightOf(
  rarity: Rarity,
  weights: Readonly<Record<Rarity, number>> | undefined
): number {
  const stated = weights?.[rarity];

  if (stated !== undefined && Number.isFinite(stated)) {
    return stated;
  }

  return DEFAULT_RARITY_WEIGHTS[rarity];
}

/** Splits candidates into one list per tier, keyed by rarity. */
function bucketByRarity(candidates: readonly Relic[]): Map<Rarity, Relic[]> {
  const buckets = new Map<Rarity, Relic[]>();

  for (const rarity of RARITIES) {
    buckets.set(rarity, []);
  }

  for (const relic of candidates) {
    buckets.get(relic.rarity)?.push(relic);
  }

  return buckets;
}

/**
 * The tiers still holding at least one candidate and weighted above zero,
 * paired with those weights in the same order.
 */
function selectableTiers(
  buckets: ReadonlyMap<Rarity, readonly Relic[]>,
  weights: Readonly<Record<Rarity, number>> | undefined
): SelectableTiers {
  const tiers: Rarity[] = [];
  const tierWeights: number[] = [];

  for (const rarity of RARITIES) {
    const bucket = buckets.get(rarity);
    const weight = weightOf(rarity, weights);

    if (bucket !== undefined && bucket.length > 0 && weight > 0) {
      tiers.push(rarity);
      tierWeights.push(weight);
    }
  }

  return { tiers, weights: tierWeights };
}

/**
 * Selects one relic and removes it from `buckets`, or yields `undefined` when
 * nothing is selectable.
 */
function selectOne(
  buckets: Map<Rarity, Relic[]>,
  weights: Readonly<Record<Rarity, number>> | undefined,
  tierStream: RngStream,
  relicStream: RngStream
): Relic | undefined {
  // Recomputed per call: the previous selection may have emptied its tier.
  const selectable = selectableTiers(buckets, weights);

  if (selectable.tiers.length === 0) {
    return undefined;
  }

  // Both selection helpers yield `undefined` on input they cannot select from,
  // and consume no draw when they do, so each is narrowed before the next step
  // reads it.
  const tier = tierStream.pickWeighted(selectable.tiers, selectable.weights);
  const candidates = tier === undefined ? undefined : buckets.get(tier);

  if (candidates === undefined) {
    return undefined;
  }

  const chosen = relicStream.pick(candidates);

  if (chosen === undefined) {
    return undefined;
  }

  // Removing the selection makes the next one a draw without replacement.
  candidates.splice(candidates.indexOf(chosen), 1);

  return chosen;
}

/**
 * Draws a reward offer set from `pool`, without replacement.
 *
 * DRAWS: one from each of the two substreams per offer returned, and none from
 * any other substream.
 *
 * Returns a fresh array. Neither `pool` nor any relic in it is modified.
 */
export function drawRelicOffers(
  options: RelicDrawOptions
): readonly Relic[] {
  const wanted = clampOfferCount(options.count);
  const offers: Relic[] = [];

  // Returning before either substream is reached keeps a request for no offer
  // from advancing a cursor.
  if (wanted === 0) {
    return offers;
  }

  const buckets = bucketByRarity(
    eligibleRelics(options.pool, options.ownedIds)
  );
  const tierStream = options.streams.stream('rarity-weight');
  const relicStream = options.streams.stream('relic-draw');

  while (offers.length < wanted) {
    const chosen = selectOne(
      buckets,
      options.weights,
      tierStream,
      relicStream
    );

    // The pool is exhausted, or holds nothing a usable weight can reach.
    if (chosen === undefined) {
      break;
    }

    offers.push(chosen);
  }

  return offers;
}
