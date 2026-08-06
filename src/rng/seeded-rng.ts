/**
 * Seeded pseudo-random number generator.
 *
 * Every random draw in the product originates here: tile spawns, relic
 * draws and rarity weighting all reach their randomness through this
 * module. It owns the generator itself. The named substreams that fan
 * one run seed out to those individual consumers live in
 * src/rng/rng-streams.ts and are expressed entirely in terms of
 * `next()`.
 *
 * NOT CRYPTOGRAPHICALLY SECURE. A sequence produced here is fully
 * determined by its seed and is reproducible by anyone holding that
 * seed, and the seed is surfaced to the player. The run generator must
 * therefore never be reused for passwords, tokens, session identifiers
 * or any other value that has to be unguessable.
 *
 * Every generator this module hands out is a local instance. Nothing
 * here assigns to `Math.random`, wraps it, captures it or reads it, so
 * the platform's own randomness keeps its stock behaviour for the
 * lifetime of the process.
 *
 * Both inputs are bounded. A seed longer than `MAX_RNG_SEED_LENGTH` and
 * a resume cursor outside `[0, MAX_RNG_CURSOR]` are rejected before a
 * generator is built and before a single draw is discarded, so neither
 * a persisted payload nor a player-entered seed can make construction
 * cost unbounded work. `isAcceptableRngSeed()` and
 * `isAcceptableRngCursor()` are the same limits as predicates, for a
 * caller that validates before constructing.
 *
 * The substream fan-out this module feeds is drawn as Figure 7,
 * "Seeded Determinism: One Run Seed Fanned into Named RNG Substreams",
 * in docs/architecture/data-flow.md.
 */

import seedrandom from 'seedrandom';

/**
 * Separator placed between a run seed and a substream label by
 * `deriveStreamSeed()`.
 *
 * The substream labels are the fixed kebab-case names declared in
 * src/rng/rng-streams.ts, and none of them contains this sequence, so
 * a derived seed always splits back into exactly one run seed and one
 * label.
 */
const STREAM_SEED_DELIMITER = '::' as const;

/**
 * Longest seed, in characters, a generator is built from.
 *
 * A seed reaches this module from the composition root, from a
 * player-entered value on the run-start screen, or from a persisted run
 * state, and the underlying generator hashes the whole string. Anything
 * longer than this is rejected rather than hashed.
 *
 * src/rng/rng-streams.ts derives its own, smaller run-seed limit from
 * this one, leaving room for the substream label it appends.
 */
export const MAX_RNG_SEED_LENGTH = 256;

/**
 * Highest resume cursor a generator is fast-forwarded to.
 *
 * A restore discards one draw at a time, so the cost of resuming is
 * linear in this value; the bound is what makes it finite. Measured on
 * the pinned runtime, 100,000 discarded draws take roughly 11ms, and all
 * four substreams together roughly 45ms.
 *
 * The bound sits far above real play: a turn consumes at most one
 * spawn-value draw and one spawn-position draw, so this is beyond any
 * reachable run length.
 */
export const MAX_RNG_CURSOR = 100_000;

/**
 * The same ceiling under the name the run-state loader reads it by. One value,
 * two names: every fast-forwarding caller shares one policy, so the bound
 * cannot drift between the generator and the loader that validates a persisted
 * cursor before it reaches `createSeededRng()`.
 */
export const MAX_RESUMABLE_CURSOR = MAX_RNG_CURSOR;

/** Why a seed or a cursor was refused. */
export type RngRejectionKind =
  | 'seed-too-long'
  | 'cursor-unusable'
  | 'cursor-out-of-range';

/**
 * One refused seed or cursor, as a report carries it.
 *
 * Carries measurements only: the offending length or value, and the
 * limit it broke. No seed text and no cursor map reaches a sink through
 * this shape.
 */
export interface RngRejection {
  /** Which limit was broken. */
  readonly kind: RngRejectionKind;

  /**
   * Substream the value belonged to, absent when the value was not
   * substream-scoped.
   */
  readonly stream?: string;

  /**
   * The measurement that broke the limit: a seed's length in
   * characters, or a cursor's value. `Number.NaN` where the offending
   * value was not a number at all.
   */
  readonly observed: number;

  /** The limit `observed` was tested against. */
  readonly maximum: number;
}

/**
 * Sink for refused seeds and cursors.
 *
 * The single member is optional, so an empty object is a complete
 * implementation. Every invocation is contained: a member that throws
 * neither reaches the caller nor is reported again.
 */
export interface RngReporter {
  /** Receives every refused seed and cursor. */
  readonly onRejected?: (rejection: RngRejection) => void;
}

/**
 * Hands one rejection to a sink, containing anything the sink throws.
 *
 * @param reporter Sink to report through, or `undefined`.
 * @param rejection Rejection to report.
 */
function reportRejection(
  reporter: RngReporter | undefined,
  rejection: RngRejection
): void {
  const sink = reporter?.onRejected;

  if (sink === undefined) {
    return;
  }

  try {
    sink(rejection);
  } catch {
    // A faulty sink is contained here and is not reported back through
    // itself.
  }
}

/**
 * Reports whether `seed` is short enough to build a generator from.
 *
 * Pure and total. A caller that must not handle an exception — the
 * guarded run-state loader, or the run-start screen validating a
 * player-entered seed — calls this before `createSeededRng()`.
 *
 * @param seed Seed to measure.
 * @returns `true` when `seed` is at most `MAX_RNG_SEED_LENGTH`
 *   characters long.
 */
export function isAcceptableRngSeed(seed: string): boolean {
  return seed.length <= MAX_RNG_SEED_LENGTH;
}

/**
 * Reports whether `cursor` is a resume position a generator can be
 * fast-forwarded to in bounded time.
 *
 * Pure and total, and accepts a value of any type, because the value
 * normally arrives from persisted JSON.
 *
 * @param cursor Value to test.
 * @returns `true` when `cursor` is a non-negative safe integer no
 *   greater than `MAX_RNG_CURSOR`.
 */
export function isAcceptableRngCursor(cursor: unknown): boolean {
  return (
    typeof cursor === 'number' &&
    Number.isSafeInteger(cursor) &&
    cursor >= 0 &&
    cursor <= MAX_RNG_CURSOR
  );
}

/**
 * A seeded generator positioned at a known point in its own sequence.
 *
 * The contract is three members: the seed, the number of draws
 * consumed, and one draw primitive. `next()` is the only source of
 * randomness in this module; every higher-level helper — `nextInt`,
 * `pick`, `pickWeighted` — is defined in src/rng/rng-streams.ts in
 * terms of it.
 */
export interface SeededRng {
  /**
   * Seed this instance was constructed from, exactly as supplied.
   *
   * Read by src/observability/logger.ts, which derives the per-run
   * correlation identifier from the run seed.
   */
  readonly seed: string;

  /**
   * Number of draws consumed from this instance, counting any draws
   * discarded by a fast-forward at construction.
   *
   * Starts at 0 for a fresh instance and rises by exactly 1 per
   * `next()` call. Sampled by src/observability/metrics.ts as a
   * counter, and persisted per substream as the run state's RNG
   * cursor so a resumed run continues the same sequence.
   */
  readonly cursor: number;

  /**
   * Consumes exactly one draw and returns it.
   *
   * @returns A float in the half-open interval `[0, 1)`.
   */
  next(): number;
}

/**
 * Reduces a caller-supplied start cursor to a usable draw count,
 * refusing anything the fast-forward cannot absorb in bounded time.
 *
 * The value reaching here has normally come back out of Web Storage
 * through the guarded run-state loader, so it may be absent, or may
 * have been written by an older or a corrupted payload. A value that is
 * not a non-negative safe integer, and a value above `MAX_RNG_CURSOR`,
 * are both treated as no recorded position at all: each is reported and
 * reduced to 0. This function never throws.
 *
 * `Number.isSafeInteger` rejects `NaN`, `Infinity`, `-Infinity`, every
 * fractional value, and every magnitude beyond the exactly
 * representable integer range. The bound then rejects the remaining
 * range that is representable but too large to walk, so the returned
 * count is always usable as a loop bound with a fixed worst case.
 *
 * @param startCursor Draw count to resume from, or `undefined`.
 * @param reporter Sink for a refusal.
 * @returns A non-negative safe integer no greater than
 *   `MAX_RNG_CURSOR`; 0 when `startCursor` carries no usable position.
 */
export function normaliseStartCursor(
  startCursor: number | undefined,
  reporter?: RngReporter
): number {
  if (startCursor === undefined) {
    return 0;
  }

  if (!Number.isSafeInteger(startCursor) || startCursor < 0) {
    reportRejection(reporter, {
      kind: 'cursor-unusable',
      observed: startCursor,
      maximum: MAX_RNG_CURSOR,
    });

    return 0;
  }

  if (startCursor > MAX_RNG_CURSOR) {
    reportRejection(reporter, {
      kind: 'cursor-out-of-range',
      observed: startCursor,
      maximum: MAX_RNG_CURSOR,
    });

    return 0;
  }

  // Collapses `-0` to `+0`, so the returned count always compares
  // identical to 0 when no position was recorded.
  return startCursor > 0 ? startCursor : 0;
}

/**
 * Creates a seeded generator.
 *
 * The generator is a local instance built from `seed` alone, and its
 * draw primitive is the underlying generator's default 53-bit call.
 * Two instances constructed from the same seed therefore produce the
 * same sequence, in the same process and across processes.
 *
 * Supplying `startCursor` fast-forwards the new instance by discarding
 * that many draws, so it sits exactly where an instance built from the
 * same seed would sit after that many `next()` calls, and reports that
 * position as its `cursor`. A resumed run therefore continues its
 * sequence instead of restarting it.
 *
 * A `startCursor` that is absent, fractional, negative, not finite,
 * beyond the exactly representable integer range, or above
 * `MAX_RNG_CURSOR` yields a fresh instance at cursor 0 instead of an
 * error, and is reported through `reporter`.
 *
 * @param seed Seed the sequence is derived from. Used verbatim. Must be
 *   at most `MAX_RNG_SEED_LENGTH` characters long.
 * @param startCursor Number of draws to discard before the first
 *   `next()` call. Defaults to 0.
 * @param reporter Sink for a refused seed or cursor. Optional.
 * @returns A generator whose `cursor` reports its true position.
 * @throws {RangeError} If `seed` is longer than `MAX_RNG_SEED_LENGTH`.
 *   `isAcceptableRngSeed()` answers the same question without throwing.
 */
export function createSeededRng(
  seed: string,
  startCursor?: number,
  reporter?: RngReporter
): SeededRng {
  if (!isAcceptableRngSeed(seed)) {
    reportRejection(reporter, {
      kind: 'seed-too-long',
      observed: seed.length,
      maximum: MAX_RNG_SEED_LENGTH,
    });

    throw new RangeError(
      `A seed may be at most ${MAX_RNG_SEED_LENGTH} characters long; ` +
        `this one is ${seed.length}.`
    );
  }

  // Bounded before anything is built: the cursor is reduced to a value
  // inside the limit, and only then is a draw discarded.
  const cursorLimit = normaliseStartCursor(startCursor, reporter);
  const generator = seedrandom(seed);
  let cursor = cursorLimit;

  // Fast-forward: discard the draws the start cursor reports as
  // already consumed.
  for (let discarded = 0; discarded < cursor; discarded += 1) {
    generator();
  }

  return {
    seed,

    // A getter rather than a data property. The count is not
    // reassignable from outside, and `next()` is the only thing that
    // advances it.
    get cursor(): number {
      return cursor;
    },

    next(): number {
      const draw = generator();
      cursor += 1;
      return draw;
    },
  };
}

/**
 * Combines a run seed with a substream label into a distinct seed.
 *
 * Pure and stateless: the same pair of arguments always yields the
 * same string, and distinct labels always yield distinct strings.
 * src/rng/rng-streams.ts calls this once per named substream, and each
 * substream then advances independently of the others.
 *
 * @param runSeed Seed for the run as a whole.
 * @param label Substream label, such as `'spawn-value'`.
 * @returns `runSeed` and `label` joined by the stream delimiter.
 */
export function deriveStreamSeed(runSeed: string, label: string): string {
  return `${runSeed}${STREAM_SEED_DELIMITER}${label}`;
}
