/**
 * Named seeded random substreams for one run.
 *
 * This module introduces no source of randomness of its own: a seed reaches it
 * only as an argument, and nothing here reads, wraps or assigns to
 * `Math.random`.
 *
 * One traceability row of docs/TRACEABILITY_MATRIX.md apiece, all target-only
 * because no vanilla construct fanned a seed out:
 *   TR-RNG-06  `STREAM_NAMES` and the four named substreams
 *   TR-RNG-07  `createRngStreams` and the per-substream seed derivation
 *   TR-RNG-08  `snapshotCursors` and the cursor restore walk
 *   TR-RNG-09  `forkStreams`, the per-handler transaction's substream forks
 *
 * Decisions: DL-RNG-04, DL-RNG-05 (docs/DECISION_LOG.md).
 */

import {
  MAX_RNG_CURSOR,
  MAX_RNG_SEED_LENGTH,
  createSeededRng,
  deriveStreamSeed,
  type RngRejection,
  type RngReporter,
  type SeededRng,
} from './seeded-rng';

export type { RngRejection, RngReporter } from './seeded-rng';
export { MAX_RNG_CURSOR } from './seeded-rng';

/**
 * The four substream names, in the order every iteration in this module walks
 * them.
 *
 * The entries are consumed as literal types by `StreamName` and as property
 * keys by `RngCursorMap`, which the run state persists, so each name is also a
 * stored value.
 */
export const RNG_STREAM_NAMES = Object.freeze([
  'spawn-value',
  'spawn-position',
  'relic-draw',
  'rarity-weight',
] as const);

export type StreamName = (typeof RNG_STREAM_NAMES)[number];

const LONGEST_STREAM_SUFFIX_LENGTH = RNG_STREAM_NAMES.reduce(
  (longest, name) => Math.max(longest, deriveStreamSeed('', name).length),
  0
);

/**
 * Longest run seed, in characters, that substreams can be derived from.
 * `MAX_RNG_SEED_LENGTH` bounds the seed each substream generator is built
 * from, and each of those is a run seed plus a derived suffix, so the run seed
 * itself is bounded by the difference.
 */
export const MAX_RUN_SEED_LENGTH =
  MAX_RNG_SEED_LENGTH - LONGEST_STREAM_SUFFIX_LENGTH;

/**
 * Reports whether `seed` is at most `MAX_RUN_SEED_LENGTH` characters long, and
 * so short enough to derive substreams from. Pure and total, for a caller that
 * must not handle the exception `createRngStreams` raises.
 */
export function isAcceptableRunSeed(seed: string): boolean {
  return seed.length <= MAX_RUN_SEED_LENGTH;
}

function reportStreamRejection(
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
  }
}

/**
 * Draw count of every substream, keyed by name. Total: all four keys are
 * always present.
 */
export type RngCursorMap = Record<StreamName, number>;

/**
 * One named substream: a seeded sequence plus the selection helpers expressed
 * on top of it.
 */
export interface RngStream {
  readonly name: StreamName;

  /**
   * Number of draws consumed from this substream, counting the draws a restore
   * fast-forwarded past. Rises by exactly 1 per drawing call, and is read by
   * `RngStreams.snapshotCursors` for persistence.
   */
  readonly cursor: number;
  next(): number;

  /**
   * Consumes one draw and reduces it to an integer index in `[0,
   * maxExclusive)`. The arithmetic is `Math.floor(next * maxExclusive)`, so a
   * given draw selects the same index the vanilla position draw selected.
   */
  nextInt(maxExclusive: number): number;

  /**
   * Selects one element of `items` uniformly, consuming one draw. The vanilla
   * boundary is preserved: an empty array yields `undefined` and consumes no
   * draw, as a full board yielded no cell.
   */
  pick<T>(items: readonly T[]): T | undefined;

  /**
   * Selects one element of `items` in proportion to `weights`, consuming one
   * draw. `weights` is read in the same index order as `items` and need not
   * sum to 1.
   *
   * @returns The selected element, or `undefined` — consuming no draw — when
   *   `items` is empty, when the two arrays differ in length, when a weight is
   *   negative or not finite, or when the weights do not total more than 0.
   */
  pickWeighted<T>(
    items: readonly T[],
    weights: readonly number[]
  ): T | undefined;

  /**
   * Creates a DETACHED substream of the same name standing exactly where this
   * one stands: the same seed, the same cursor, and the same next draw. Draws
   * taken from the fork advance the fork alone.
   *
   * Constant cost, whatever this substream's cursor.
   */
  fork(): RngStream;
}

/**
 * The four substreams of one run, addressed by name.
 *
 * Instance stability: `stream` returns the same object for a given name on
 * every call, so a cursor advanced through one reference is visible through
 * every other.
 */
export interface RngStreams {
  readonly seed: string;
  stream(name: StreamName): RngStream;

  /**
   * Reads the current draw count of every substream. Cheap and callable at any
   * point: it reads four cursors and consumes no draw.
   */
  snapshotCursors(): RngCursorMap;
}

function mapStreamNames<T>(
  produce: (name: StreamName) => T
): Record<StreamName, T> {
  const built: Partial<Record<StreamName, T>> = {};

  for (const name of RNG_STREAM_NAMES) {
    built[name] = produce(name);
  }

  return built as Record<StreamName, T>;
}

/**
 * Reduces one recorded cursor entry to a usable draw count, refusing anything
 * outside the bound the fast-forward can absorb.
 */
function normaliseCursor(
  name: StreamName,
  recorded: number | undefined,
  reporter?: RngReporter
): number {
  if (recorded === undefined) {
    return 0;
  }

  if (!Number.isSafeInteger(recorded) || recorded < 0) {
    reportStreamRejection(reporter, {
      kind: 'cursor-unusable',
      stream: name,
      observed: typeof recorded === 'number' ? recorded : Number.NaN,
      maximum: MAX_RNG_CURSOR,
    });

    return 0;
  }

  if (recorded > MAX_RNG_CURSOR) {
    reportStreamRejection(reporter, {
      kind: 'cursor-out-of-range',
      stream: name,
      observed: recorded,
      maximum: MAX_RNG_CURSOR,
    });

    return 0;
  }

  return recorded > 0 ? recorded : 0;
}

/**
 * Totals a weight list, rejecting the shapes no selection can be made from: no
 * candidates, counts that disagree, a negative or non-finite weight, or a
 * total not greater than 0.
 */
function totalWeightOf(
  itemCount: number,
  weights: readonly number[]
): number | undefined {
  if (itemCount === 0 || itemCount !== weights.length) {
    return undefined;
  }

  let total = 0;

  for (const weight of weights) {
    if (!Number.isFinite(weight) || weight < 0) {
      return undefined;
    }

    total += weight;

    if (!Number.isFinite(total)) {
      return undefined;
    }
  }

  return total > 0 ? total : undefined;
}

/** Wraps one seeded generator as a named substream. */
function createStream(name: StreamName, rng: SeededRng): RngStream {
  function next(): number {
    return rng.next();
  }

  function nextInt(maxExclusive: number): number {
    if (!Number.isFinite(maxExclusive) || maxExclusive <= 0) {
      return 0;
    }

    return Math.floor(next() * maxExclusive);
  }

  // An empty candidate list yields `undefined`, as a full board did.
  function pick<T>(items: readonly T[]): T | undefined {
    if (items.length === 0) {
      return undefined;
    }

    return items[nextInt(items.length)];
  }

  // Resolves `[2, 4]` at `[0.9, 0.1]` to the vanilla spawn distribution.
  function pickWeighted<T>(
    items: readonly T[],
    weights: readonly number[]
  ): T | undefined {
    const total = totalWeightOf(items.length, weights);

    if (total === undefined) {
      return undefined;
    }

    const target = next() * total;
    let running = 0;
    let index = 0;

    for (const weight of weights) {
      running += weight;

      if (running > target) {
        return items[index];
      }

      index += 1;
    }

    return items[items.length - 1];
  }

  return {
    name,

    get cursor(): number {
      return rng.cursor;
    },

    next,
    nextInt,
    pick,
    pickWeighted,

    fork: (): RngStream => createStream(name, rng.fork()),
  };
}

/**
 * Creates the four substreams of one run.
 *
 * @throws {RangeError} If `seed` is longer than `MAX_RUN_SEED_LENGTH`.
 *   `isAcceptableRunSeed` answers the same question without throwing.
 */
export function createRngStreams(
  seed: string,
  cursors?: Partial<RngCursorMap>,
  reporter?: RngReporter
): RngStreams {
  if (!isAcceptableRunSeed(seed)) {
    reportStreamRejection(reporter, {
      kind: 'seed-too-long',
      observed: seed.length,
      maximum: MAX_RUN_SEED_LENGTH,
    });

    throw new RangeError(
      `A run seed may be at most ${MAX_RUN_SEED_LENGTH} characters ` +
        `long; this one is ${seed.length}.`
    );
  }

  const table = mapStreamNames((name) =>
    createStream(
      name,
      createSeededRng(
        deriveStreamSeed(seed, name),
        normaliseCursor(name, cursors?.[name], reporter),
        reporter
      )
    )
  );

  return {
    seed,

    stream(name: StreamName): RngStream {
      return table[name];
    },

    snapshotCursors(): RngCursorMap {
      return mapStreamNames((name) => table[name].cursor);
    },
  };
}
