/**
 * Seeded pseudo-random number generator.
 *
 * Every generator this module hands out is a LOCAL INSTANCE. Nothing here
 * assigns to `Math.random`, wraps it, captures it or reads it, so the
 * platform's own randomness keeps its stock behaviour for the lifetime of the
 * process.
 *
 * Decisions: DL-RNG-01, DL-RNG-02, DL-RNG-03 (docs/DECISION_LOG.md).
 */

import seedrandom from 'seedrandom';

/**
 * Separator placed between a run seed and a substream label by
 * `deriveStreamSeed`.
 */
const STREAM_SEED_DELIMITER = '::' as const;

/**
 * The generator this module builds: the underlying ARC4 generator with its
 * internal state exportable, which is the one capability `SeededRng.fork`
 * needs and the only reason the `state` option is used.
 */
type StatefulGenerator = seedrandom.StatefulPRNG<seedrandom.State.Arc4>;

/** Longest seed, in characters, a generator is built from. */
export const MAX_RNG_SEED_LENGTH = 256;

/** Highest resume cursor a generator is fast-forwarded to. */
export const MAX_RNG_CURSOR = 100_000;

/**
 * The same ceiling under the name the run-state loader reads it by. One value,
 * two names: every fast-forwarding caller shares one policy, so the bound
 * cannot drift between the generator and the loader that validates a persisted
 * cursor before it reaches `createSeededRng`.
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
 * empty object is a complete implementation.
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
  // A faulty sink is contained here and is not reported back through itself.
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
 * primitive. `next` is the only source of randomness in this module; every
 * higher-level helper is defined in src/rng/rng-streams.ts in terms of it.
 */
export interface SeededRng {
  readonly seed: string;

  /**
   * Number of draws consumed from this instance, counting any draws discarded
   * by a fast-forward at construction. Starts at 0 for a fresh instance and
   * rises by exactly 1 per `next` call.
   */
  readonly cursor: number;
  next(): number;

  /**
   * Creates a DETACHED generator standing exactly where this one stands: the
   * same seed, the same cursor, and the same next draw. Draws taken from the
   * fork advance the fork alone, and draws taken from this instance advance
   * this instance alone.
   */
  fork(): SeededRng;
}

/**
 * Reduces a caller-supplied start cursor to a usable draw count, refusing
 * anything the fast-forward cannot absorb in bounded time. NEVER THROWS.
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
 * @throws {RangeError} If `seed` is longer than `MAX_RNG_SEED_LENGTH`.
 *   `isAcceptableRngSeed` answers the same question without throwing.
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
  // exportable, which is what `fork` copies.
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
