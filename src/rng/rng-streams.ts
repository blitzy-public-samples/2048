/**
 * Named seeded random substreams for one run.
 *
 * A run carries a single seed. This module fans that seed out into four named
 * substreams — spawn-value, spawn-position, relic-draw and rarity-weight — each
 * of which advances independently of the others and reports how far it has
 * advanced as its cursor. The generator behind each one is built by
 * src/rng/seeded-rng.ts and reached only through its `next()` draw.
 *
 * NOT CRYPTOGRAPHICALLY SECURE. Every sequence here is fully determined by the
 * run seed, that seed is surfaced to the player, and anyone holding it can
 * reproduce every draw. These substreams must never be reused for passwords,
 * tokens, session identifiers or any other value that has to be unguessable.
 *
 * Both inputs are bounded. A run seed longer than `MAX_RUN_SEED_LENGTH` is
 * refused before any substream is built, and every recorded cursor is checked
 * against `MAX_RNG_CURSOR` before a single draw is discarded, so a restore
 * performs bounded work for any payload. `isAcceptableRunSeed()` is the seed
 * limit as a predicate, for a caller that must not handle an exception.
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
 * Decisions behind this file, argued in docs/DECISION_LOG.md and named here
 * only so the construct can be found from the log:
 *   DL-RNG-04  the run seed fanned into four named substreams
 *   DL-RNG-05  each substream reporting its own cursor, so a resumed run
 *              continues the sequence it interrupted
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
 * ORDER IS PART OF THE CONTRACT: eager stream construction, cursor
 * snapshotting and cursor restore all iterate this tuple, as do run-state
 * normalisation in src/run/run-state.ts and per-substream metric registration
 * in src/observability/metrics.ts. No code path in this module takes an order
 * from `Object.keys`, `for...in`, a `Set` or a `Map`.
 *
 * FROZEN AT RUNTIME as well as readonly at compile time, matching `HOOK_NAMES`
 * of src/engine/hooks.ts and `ENGINE_EVENT_NAMES` of
 * src/engine/engine-events.ts. Compile-time readonly alone left the tuple
 * writable to any caller reaching it through a widened type, and every
 * consumer above treats it as a closed enumeration: a reordered or extended
 * tuple would change which seed a substream is derived from, and so the
 * sequence a seeded run reproduces.
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
 * must not handle the exception `createRngStreams()` raises.
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
 * Draw count of every substream, keyed by name. Total: all four keys are always
 * present. This is the shape the run state persists as its `rngCursor` field
 * and the shape `createRngStreams()` accepts, in `Partial` form, to resume
 * from.
 */
export type RngCursorMap = Record<StreamName, number>;

/**
 * One named substream: a seeded sequence plus the selection helpers expressed
 * on top of it.
 *
 * DRAW ACCOUNTING
 *   Every method that draws consumes exactly one value from the underlying
 *   generator, so `cursor` equals the number of draws taken from this
 *   substream and nothing else. The methods that decline to act — `nextInt`
 *   outside its domain, `pick` and `pickWeighted` on input they cannot select
 *   from — consume nothing and leave `cursor` where it was.
 *
 * ARRAY HANDLING
 *   The array-taking methods read their arguments in the given index order and
 *   never sort, filter, re-key or otherwise mutate them. The caller's order is
 *   part of the determinism contract: the available-cell list is built x-outer
 *   and y-inner, and the same draw maps to a different element if that order
 *   changes.
 */
export interface RngStream {
  readonly name: StreamName;

  /**
   * Number of draws consumed from this substream, counting the draws a restore
   * fast-forwarded past. Rises by exactly 1 per drawing call, and is read by
   * `RngStreams.snapshotCursors()` for persistence.
   */
  readonly cursor: number;
  next(): number;

  /**
   * Consumes one draw and reduces it to an integer index in
   * `[0, maxExclusive)`. The arithmetic is `Math.floor(next() * maxExclusive)`,
   * so a given draw selects the same index the vanilla position draw selected.
   * Yields `0` and consumes NO draw when `maxExclusive` is not a finite number
   * greater than 0.
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
   * SELECTION
   *   One draw `r` is taken and scaled by the total of the weights. The
   *   weights are then walked in index order accumulating a running total, and
   *   the first index whose running total is greater than the scaled draw
   *   selects the element. One draw per call, never one per candidate. When
   *   the accumulated total does not exceed the scaled draw — reachable only
   *   through floating-point summation — the final element is selected.
   *
   *   With `items` `[2, 4]` and `weights` `[0.9, 0.1]` the total is exactly 1,
   *   so the walk yields 2 when `r` is less than 0.9 and 4 otherwise — the
   *   vanilla spawn distribution exactly.
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
   * The checkpoint primitive of the substream layer, wrapping
   * `SeededRng.fork()`. A caller that must be able to abandon the draws it
   * takes draws from a fork, then either discards it — leaving this substream
   * untouched — or advances this substream by the fork's own consumption to
   * adopt them, which reproduces the values the fork produced because both
   * share a seed and a position. src/engine/hook-bus.ts uses it to keep a hook
   * handler that throws from consuming randomness.
   *
   * Constant cost, whatever this substream's cursor.
   */
  fork(): RngStream;
}

/**
 * The four substreams of one run, addressed by name.
 *
 * INSTANCE STABILITY: `stream()` returns the same object for a given name on
 * every call, so a cursor advanced through one reference is visible through
 * every other.
 */
export interface RngStreams {
  readonly seed: string;
  stream(name: StreamName): RngStream;

  /**
   * Reads the current draw count of every substream. Cheap and callable at any
   * point: it reads four cursors and consumes no draw. Returns a fresh object
   * each call, built by walking `RNG_STREAM_NAMES`, so a caller can neither
   * mutate internal state through the result nor observe a later advance in an
   * already-returned snapshot.
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
 * outside the bound the fast-forward can absorb. NEVER THROWS.
 *
 * The value reaching here has normally come back out of Web Storage through
 * the guarded run-state loader, so it may be absent, or may have been written
 * by an older or a corrupted payload. Anything that is not a non-negative safe
 * integer, and anything above `MAX_RNG_CURSOR`, is treated as no recorded
 * position, reported with the substream it belonged to, and reduced to 0.
 *
 * An absent entry is rejected first, and silently: a cursor map that predates a
 * substream is a normal older payload, not a refusal. `Number.isSafeInteger`
 * then rejects `NaN`, `Infinity`, `-Infinity`, every fractional value, every
 * magnitude beyond the exactly representable integer range, and any value that
 * is not a number at all. The bound rejects the rest of the representable
 * range. The final comparison collapses `-0` to `+0`.
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
 * Totals a weight list, rejecting the shapes no selection can be made from:
 * no candidates, counts that disagree, a negative or non-finite weight, or a
 * total not greater than 0. Reads `weights` in the given index order and
 * consumes no draw, so a rejected call leaves the calling substream's cursor
 * untouched.
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

/**
 * Wraps one seeded generator as a named substream. The returned object holds no
 * draw state of its own: `cursor` reads through to the generator, and every
 * helper draws through the same `next()`. The helpers are closures over that
 * generator and read no `this`, so a destructured helper still draws from this
 * substream.
 */
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

    // The fork carries the same name and the same helpers, so a caller
    // drawing through it takes the draws it would have taken here.
    fork: (): RngStream => createStream(name, rng.fork()),
  };
}

/**
 * Creates the four substreams of one run.
 *
 * All four are constructed eagerly, by walking `RNG_STREAM_NAMES`, so
 * `snapshotCursors()` is total from the first call and the cursor accounting
 * does not depend on which substreams a run happens to touch. Each substream is
 * seeded with `deriveStreamSeed(seed, name)`, so two runs sharing a seed
 * produce identical sequences in every substream, and a draw taken from one
 * substream does not move any other.
 *
 * RESUMING
 *   A supplied `cursors` map fast-forwards each substream past the draws it
 *   records, leaving it exactly where the instance that produced the map
 *   stood. Restore is tolerant and never throws: a missing entry starts that
 *   substream at 0, an entry that is not a non-negative safe integer starts at
 *   0, an entry above `MAX_RNG_CURSOR` starts at 0, and a key that is not a
 *   substream name is ignored. Every refused entry is reported with the
 *   substream it belonged to, so the work a restore performs is bounded by
 *   `MAX_RNG_CURSOR` per substream however the payload was written.
 *
 *   Restore fast-forwards; it does not replay. The opening spawns are taken
 *   only on a fresh start, so a resumed run continues its sequence instead of
 *   taking those draws again.
 *
 * @throws {RangeError} If `seed` is longer than `MAX_RUN_SEED_LENGTH`.
 *   `isAcceptableRunSeed()` answers the same question without throwing.
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
