/**
 * Seeded pseudo-random number generator.
 *
 * Every random draw in the product originates here: tile spawns, relic draws
 * and rarity weighting all reach their randomness through this module. It owns
 * the generator itself; the named substreams that fan one run seed out to
 * those consumers live in src/rng/rng-streams.ts and are expressed entirely in
 * terms of `next()`.
 *
 * NOT CRYPTOGRAPHICALLY SECURE. A sequence produced here is fully determined
 * by its seed, is reproducible by anyone holding that seed, and the seed is
 * surfaced to the player. The run generator must never be reused for
 * passwords, tokens, session identifiers or any other value that has to be
 * unguessable.
 *
 * Every generator this module hands out is a LOCAL INSTANCE. Nothing here
 * assigns to `Math.random`, wraps it, captures it or reads it, so the
 * platform's own randomness keeps its stock behaviour for the lifetime of the
 * process.
 *
 * lifetime of the process. Decision DL-RNG-01.
 * Decisions behind this file: DL-RNG-01, the generator always a local
 * instance and never installed onto `Math.random`; DL-RNG-02, the
 * replaceable; and DL-RNG-03, the bounded seed length and resume cursor.
 * All three are in docs/DECISION_LOG.md. Traceability rows: TR-RNG-01,
 * js/game_manager.js L71's `Math.random()`, and TR-RNG-02, js/grid.js
 * TR-RNG-03 through TR-RNG-05.
 *
 * Both inputs are bounded. A seed longer than `MAX_RNG_SEED_LENGTH` and a
 * resume cursor outside `[0, MAX_RNG_CURSOR]` are rejected before a generator
 * is built and before a single draw is discarded, so neither a persisted
 * payload nor a player-entered seed can make construction cost unbounded work.
 * `isAcceptableRngSeed()` and `isAcceptableRngCursor()` are the same limits as
 * predicates, for a caller that validates before constructing.
 */

import seedrandom from 'seedrandom';

/**
 * Separator placed between a run seed and a substream label by
 * `deriveStreamSeed()`. None of the substream labels declared in
 * src/rng/rng-streams.ts contains this sequence, so a derived seed always
 * splits back into exactly one run seed and one label.
 */
const STREAM_SEED_DELIMITER = '::' as const;

/**
 * The generator this module builds: the underlying ARC4 generator with its
 * internal state exportable, which is the one capability `SeededRng.fork()`
 * needs and the only reason the `state` option is used.
 */
type StatefulGenerator = seedrandom.StatefulPRNG<seedrandom.State.Arc4>;

/**
 * Longest seed, in characters, a generator is built from. The underlying
 * generator hashes the whole string, so anything longer is rejected rather
 * than hashed. src/rng/rng-streams.ts derives its own, smaller run-seed limit
 * from this one, leaving room for the substream label it appends.
 */
export const MAX_RNG_SEED_LENGTH = 256;

/**
 * Highest resume cursor a generator is fast-forwarded to.
 *
 * A restore discards one draw at a time, so the cost of resuming is linear in
 * this value and the bound is what makes it finite. Measured on the pinned
 * runtime, 100,000 discarded draws take roughly 11ms, and all four substreams
 * together roughly 45ms. A turn consumes at most one spawn-value draw and one
 * spawn-position draw, so the bound sits beyond any reachable run length.
 */
export const MAX_RNG_CURSOR = 100_000;

/**
 * The same ceiling under the name the run-state loader reads it by. One value,
 * two names: every fast-forwarding caller shares one policy, so the bound
 * cannot drift between the generator and the loader that validates a persisted
 * cursor before it reaches `createSeededRng()`.
 */
export const MAX_RESUMABLE_CURSOR = MAX_RNG_CURSOR;

export type RngRejectionKind =
  | 'seed-too-long'
  | 'cursor-unusable'
  | 'cursor-out-of-range';

/**
 * One refused seed or cursor, as a report carries it. Carries measurements
 * only: no seed text and no cursor map reaches a sink through this shape.
 */
export interface RngRejection {
  readonly kind: RngRejectionKind;

  /**
   * Substream the value belonged to, absent when the value was not
   * substream-scoped.
   */
  readonly stream?: string;

  /**
   * The measurement that broke the limit: a seed's length in characters, or a
   * cursor's value. `Number.NaN` where the offending value was not a number at
   * all.
   */
  readonly observed: number;
  readonly maximum: number;
}

/**
 * Sink for refused seeds and cursors. The single member is optional, so an
 * empty object is a complete implementation. Every invocation is contained: a
 * member that throws neither reaches the caller nor is reported again.
 */
export interface RngReporter {
  readonly onRejected?: (rejection: RngRejection) => void;
}

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
 * Reports whether `seed` is at most `MAX_RNG_SEED_LENGTH` characters long, and
 * so short enough to build a generator from. Pure and total, for a caller that
 * must not handle an exception.
 */
export function isAcceptableRngSeed(seed: string): boolean {
  return seed.length <= MAX_RNG_SEED_LENGTH;
}

export function isAcceptableRngCursor(cursor: unknown): boolean {
  return (
    typeof cursor === 'number' &&
    Number.isSafeInteger(cursor) &&
    cursor >= 0 &&
    cursor <= MAX_RNG_CURSOR
  );
}

/**
 * A seeded generator positioned at a known point in its own sequence: the
 * seed, the number of draws consumed, one draw primitive, and one detach
 * primitive. `next()` is the only source of randomness in this module; every
 * higher-level helper is defined in src/rng/rng-streams.ts in terms of it.
 */
export interface SeededRng {
  readonly seed: string;

  /**
   * Number of draws consumed from this instance, counting any draws discarded
   * by a fast-forward at construction. Starts at 0 for a fresh instance and
   * rises by exactly 1 per `next()` call. Persisted per substream as the run
   * state's RNG cursor, so a resumed run continues the same sequence.
   */
  readonly cursor: number;
  next(): number;

  /**
   * Creates a DETACHED generator standing exactly where this one stands: the
   * same seed, the same cursor, and the same next draw. Draws taken from the
   * fork advance the fork alone, and draws taken from this instance advance
   * this instance alone.
   *
   * This is the checkpoint primitive a transactional caller needs. A caller
   * that must be able to abandon the draws it takes — src/engine/hook-bus.ts,
   * around a hook handler that may throw — draws from a fork, and then either
   * discards the fork, leaving this instance where it was, or advances this
   * instance by the fork's own consumption to adopt them. Because both share a
   * seed and a position, replaying that many draws here yields the values the
   * fork already produced, so adoption leaves the sequence exactly where
   * drawing directly would have.
   *
   * CONSTANT COST. The fork copies the generator's internal state rather than
   * replaying the sequence, so forking a generator at cursor 100,000 costs the
   * same as forking a fresh one.
   */
  fork(): SeededRng;
}

/**
 * Reduces a caller-supplied start cursor to a usable draw count, refusing
 * anything the fast-forward cannot absorb in bounded time. NEVER THROWS.
 *
 * The value reaching here has normally come back out of Web Storage through
 * the guarded run-state loader, so it may be absent, or may have been written
 * by an older or a corrupted payload. A value that is not a non-negative safe
 * integer, and a value above `MAX_RNG_CURSOR`, are both treated as no recorded
 * position at all: each is reported and reduced to 0.
 *
 * `Number.isSafeInteger` rejects `NaN`, `Infinity`, `-Infinity`, every
 * fractional value, and every magnitude beyond the exactly representable
 * integer range. The bound then rejects the remaining range that is
 * representable but too large to walk, so the returned count is always usable
 * as a loop bound with a fixed worst case.
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

  return startCursor > 0 ? startCursor : 0;
}

/**
 * Creates a seeded generator.
 *
 * The generator is a local instance built from `seed` alone, and its draw
 * primitive is the underlying generator's default 53-bit call. Two instances
 * constructed from the same seed therefore produce the same sequence, in the
 * same process and across processes.
 *
 * Supplying `startCursor` fast-forwards the new instance by discarding that
 * many draws, so it sits exactly where an instance built from the same seed
 * would sit after that many `next()` calls, and reports that position as its
 * `cursor`. A resumed run therefore continues its sequence instead of
 * restarting it. A `startCursor` that is absent, fractional, negative, not
 * finite, beyond the exactly representable integer range, or above
 * `MAX_RNG_CURSOR` yields a fresh instance at cursor 0 instead of an error,
 * and is reported through `reporter`.
 *
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

  const cursorLimit = normaliseStartCursor(startCursor, reporter);

  // `{ state: true }` asks the generator to keep its internal state
  // exportable, which is what `fork()` copies. It changes no draw: a generator
  // built with it produces the sequence a generator built without it produces,
  // value for value.
  const generator = seedrandom(seed, { state: true });
  let cursor = cursorLimit;

  for (let discarded = 0; discarded < cursor; discarded += 1) {
    generator();
  }

  return buildRng(seed, generator, cursor);
}

/**
 * Wraps one live generator as a `SeededRng` positioned at `startCursor`.
 *
 * Shared by `createSeededRng()` and `fork()`, so a fork carries the same
 * three members and the same accounting as the instance it was taken from.
 *
 * @param seed Seed the generator was built from.
 * @param generator The live generator, built with exportable state.
 * @param startCursor Draws consumed before this wrapper took it over.
 * @returns The wrapper.
 */
function buildRng(
  seed: string,
  generator: StatefulGenerator,
  startCursor: number
): SeededRng {
  let cursor = startCursor;

  return {
    seed,

    get cursor(): number {
      return cursor;
    },

    next(): number {
      const draw = generator();
      cursor += 1;
      return draw;
    },

    fork(): SeededRng {
      // The state copy is what makes the fork constant-cost: the new
      // generator resumes from this one's position instead of replaying the
      // sequence up to it. `state()` returns a fresh object each call, so the
      // fork holds no reference into this generator.
      return buildRng(
        seed,
        seedrandom('', { state: generator.state() }),
        cursor
      );
    },
  };
}

/**
 * Combines a run seed with a substream label into a distinct seed. Pure and
 * stateless: the same pair of arguments always yields the same string, and
 * distinct labels always yield distinct strings. src/rng/rng-streams.ts calls
 * this once per named substream, and each substream then advances
 * independently of the others.
 */
export function deriveStreamSeed(runSeed: string, label: string): string {
  return `${runSeed}${STREAM_SEED_DELIMITER}${label}`;
}
