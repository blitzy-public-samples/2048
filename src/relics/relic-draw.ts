// The seeded reward draw: the offer set a reward screen presents.
//
// PROVENANCE
//   Generalises the two randomness sites of the vanilla game. The weighted
//   two-value choice at js/game_manager.js L71 becomes the rarity-weighted
//   selection of a tier, and the uniform selection at js/grid.js L37-L43
//   becomes the selection of one relic within the tier that won, keeping
//   that site's boundary: nothing to select from yields nothing rather than
//   raising.
//
// SUBSTREAMS CONSUMED
//   `rarity-weight` and `relic-draw`, and no others. Neither spawn substream
//   is reached through the `RngStreams` handed in, so making an offer cannot
//   move the board's own sequence.
//
// CURSOR CONSUMPTION
//   Exactly one `rarity-weight` draw and one `relic-draw` draw per offer
//   RETURNED. No draw is taken once nothing remains selectable, and none at
//   all when no offer is asked for, so the number of draws taken is a
//   function of the number of offers returned alone.
//
// PURITY
//   The candidate pool arrives as an argument, not from a catalogue this
//   module reaches for itself. The module holds no mutable state, reads the
//   caller's array and relics without writing to either, touches no DOM,
//   performs no I/O, reads no clock, and reaches no randomness beyond the two
//   substreams above.
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
// Decisions behind this file, argued in docs/DECISION_LOG.md and named here
// only so the construct can be found from the log:
//   DL-DRAW-01  sampling without replacement
//   DL-DRAW-02  the two substreams consumed being `rarity-weight` and
//               `relic-draw` and no others
//   DL-DRAW-03  exactly one draw from each substream per offer RETURNED

import {
  DEFAULT_RARITY_WEIGHTS,
  RARITIES,
  type Rarity,
  type Relic,
} from './relic-types';
import type { RngStream, RngStreams } from '../rng/rng-streams';

/** Offers a reward screen presents when the caller names no count. */
const DEFAULT_OFFER_COUNT = 3;

/**
 * One reward draw.
 *
 * `pool` is the catalogue to draw from, and is read and never written.
 * `ownedIds` names the relics a run already holds, matched by `id` alone and
 * never by object identity. `count` defaults to `DEFAULT_OFFER_COUNT`.
 * `weights` overrides the draw weight of a tier per key: a tier the override
 * omits keeps its `DEFAULT_RARITY_WEIGHTS` weight.
 */
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
 * The relics of `pool` a draw can offer: those a run does not already hold,
 * in the order `pool` carries them.
 *
 * `id` IS THE IDENTITY. An owned relic is excluded by identifier and never by
 * object identity, and a pool carrying one identifier more than once keeps
 * its first entry alone, so the result can never hold two relics with the
 * same identifier whatever the caller passed.
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

    // Admitting the identifier to the same set suppresses a later repeat of
    // it in `pool`.
    excluded.add(relic.id);
    eligible.push(relic);
  }

  return eligible;
}

/**
 * Reduces a requested offer count to a number of selections that can be
 * attempted. Absent becomes `DEFAULT_OFFER_COUNT`, a fractional request
 * truncates towards zero, and anything that is not a finite number above zero
 * becomes 0. A request larger than the pool is left as it stands: the
 * selection loop stops when the pool is exhausted.
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

/**
 * The draw weight of one tier: the override when it states a finite number,
 * and the `DEFAULT_RARITY_WEIGHTS` weight otherwise. Never yields `NaN`.
 *
 * A finite override is honoured as written, zero and negative values
 * included, and `selectableTiers()` reads those as a tier that cannot be
 * offered. An override that is absent, not a number, or not finite counts as
 * unstated and falls back per key.
 */
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

/**
 * Splits candidates into one list per tier, keyed by rarity.
 *
 * Every tier of `RARITIES` receives a list, empty or not, so a lookup never
 * distinguishes an absent tier from an empty one. Each list keeps the order
 * its candidates arrived in, and a draw resolves an index against that order.
 * A relic whose rarity is not one of the four tiers joins no list and is
 * therefore never offered.
 */
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
 *
 * Walks `RARITIES`, so tier order comes from that tuple and never from the
 * enumeration order of a weight table or of the bucket map. `pickWeighted`
 * refuses a list outright when any weight in it is negative or not finite,
 * so only usable weights reach it.
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
 *
 * Two draws, in this order: one from `tierStream` selecting the tier, then
 * one from `relicStream` selecting the relic within it. A call that yields
 * `undefined` has taken no draw from either.
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

  // Both selection helpers yield `undefined` on input they cannot select
  // from, and consume no draw when they do, so each is narrowed before the
  // next step reads it.
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
 * Each offer is selected in two stages: one weighted draw from the
 * `rarity-weight` substream selects a tier from those still holding a
 * candidate, then one draw from the `relic-draw` substream selects a relic
 * within that tier. The selection leaves the working list before the next
 * offer is drawn, so no relic is offered twice and the identifiers returned
 * are always distinct.
 *
 * LENGTH: the lesser of the clamped `count` and the number of eligible
 * relics sitting in a tier weighted above zero — which, under
 * `DEFAULT_RARITY_WEIGHTS` and any override that weights all four tiers above
 * zero, is the lesser of the clamped `count` and `eligibleRelics()`. Every
 * shortfall returns fewer offers rather than raising: an empty pool, a pool a
 * run already owns outright, and a pool smaller than `count` each yield what
 * they can.
 *
 * DRAWS: one from each of the two substreams per offer returned, and none
 * from any other substream.
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
