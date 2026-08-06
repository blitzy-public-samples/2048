/**
 * Named seeded random substreams for one run.
 *
 * A run carries a single seed. This module fans that seed out into
 * four named substreams — spawn-value, spawn-position, relic-draw and
 * rarity-weight — each of which advances independently of the others
 * and reports how far it has advanced as its cursor. Tile spawns, the
 * relic draw and rarity weighting take their randomness from these
 * substreams; the generator behind each one is built by
 * src/rng/seeded-rng.ts and reached only through its `next()` draw.
 *
 * NOT CRYPTOGRAPHICALLY SECURE. Every sequence here is fully
 * determined by the run seed, that seed is surfaced to the player, and
 * anyone holding it can reproduce every draw. These substreams must
 * never be reused for passwords, tokens, session identifiers or any
 * other value that has to be unguessable.
 *
 * Provenance: this module replaces the two `Math.random()` call sites
 * of the vanilla game, which were the only two in that codebase — the
 * spawn-value draw at js/game_manager.js L71 and the spawn-position
 * draw at js/grid.js L41. It introduces no third source: a seed
 * reaches this module only as an argument, and nothing here reads,
 * wraps or assigns to `Math.random`.
 *
 * The fan-out is drawn as Figure 7, "Seeded Determinism: One Run Seed
 * Fanned into Named RNG Substreams", in docs/architecture/data-flow.md.
 *
 * Rationale for the decisions made here is recorded in
 * docs/DECISION_LOG.md.
 */

import {
  createSeededRng,
  deriveStreamSeed,
  type SeededRng,
} from './seeded-rng';

/**
 * The four substream names, in the order every iteration in this
 * module walks them.
 *
 * ORDER IS PART OF THE CONTRACT
 *   Eager stream construction, cursor snapshotting and cursor restore
 *   all iterate this tuple. No code path in this module takes an order
 *   from `Object.keys`, `for...in`, a `Set` or a `Map`.
 *
 * The entries are consumed as literal types by `StreamName` and as
 * property keys by `RngCursorMap`, which the run state persists, so
 * each name is also a stored value.
 */
export const RNG_STREAM_NAMES = [
  // Replaces the spawn-value draw of js/game_manager.js L71.
  'spawn-value',
  // Replaces the spawn-position draw of js/grid.js L41.
  'spawn-position',
  'relic-draw',
  'rarity-weight',
] as const;

/**
 * Name of one substream.
 *
 * Derived from `RNG_STREAM_NAMES` so the tuple stays the single
 * declaration of the four names.
 */
export type StreamName = (typeof RNG_STREAM_NAMES)[number];

/**
 * Draw count of every substream, keyed by name.
 *
 * Total: all four keys are always present. This is the shape the run
 * state persists as its `rngCursor` field and the shape
 * `createRngStreams()` accepts, in `Partial` form, to resume from.
 */
export type RngCursorMap = Record<StreamName, number>;

/**
 * One named substream: a seeded sequence plus the selection helpers
 * expressed on top of it.
 *
 * DRAW ACCOUNTING
 *   Every method that draws consumes exactly one value from the
 *   underlying generator, so `cursor` equals the number of draws taken
 *   from this substream and nothing else. The methods that decline to
 *   act — `nextInt` outside its domain, `pick` and `pickWeighted` on
 *   input they cannot select from — consume nothing and leave `cursor`
 *   where it was.
 *
 * ARRAY HANDLING
 *   The array-taking methods read their arguments in the given index
 *   order and never sort, filter, re-key or otherwise mutate them.
 *   js/grid.js builds its available-cell list through `eachCell`
 *   (js/grid.js L58-L64), whose loops are x-outer and y-inner, and the
 *   same draw maps to a different element if that order changes.
 */
export interface RngStream {
  /** Name this substream was created under. */
  readonly name: StreamName;

  /**
   * Number of draws consumed from this substream, counting the draws
   * a restore fast-forwarded past.
   *
   * Rises by exactly 1 per drawing call. Read by
   * `RngStreams.snapshotCursors()` for persistence, and sampled as a
   * counter by src/observability/metrics.ts.
   */
  readonly cursor: number;

  /**
   * Consumes one draw and returns it.
   *
   * @returns A float in the half-open interval `[0, 1)`.
   */
  next(): number;

  /**
   * Consumes one draw and reduces it to an integer index.
   *
   * The arithmetic is `Math.floor(next() * maxExclusive)`, ported from
   * js/grid.js L41 (`cells[Math.floor(Math.random() * cells.length)]`)
   * so a given draw selects the same index it selected there.
   *
   * @param maxExclusive Exclusive upper bound of the returned index.
   * @returns An integer in `[0, maxExclusive)`; `0` when
   *   `maxExclusive` is not a finite number greater than 0, in which
   *   case no draw is consumed.
   */
  nextInt(maxExclusive: number): number;

  /**
   * Selects one element of `items` uniformly, consuming one draw.
   *
   * Ported from js/grid.js L37-L43, `randomAvailableCell`, including
   * its boundary: the `if (cells.length)` guard there has no else
   * branch, so a full board yields no cell. An empty array yields
   * `undefined` here and consumes no draw.
   *
   * @param items Candidates, read in the given index order.
   * @returns The selected element, or `undefined` when `items` is
   *   empty.
   */
  pick<T>(items: readonly T[]): T | undefined;

  /**
   * Selects one element of `items` in proportion to `weights`,
   * consuming one draw.
   *
   * SELECTION
   *   One draw `r` is taken and scaled by the total of the weights.
   *   The weights are then walked in index order accumulating a
   *   running total, and the first index whose running total is
   *   greater than the scaled draw selects the element. One draw per
   *   call, never one per candidate. When the accumulated total does
   *   not exceed the scaled draw — reachable only through
   *   floating-point summation — the final element is selected.
   *
   *   With `items` `[2, 4]` and `weights` `[0.9, 0.1]` the total is
   *   exactly 1, so the walk yields 2 when `r` is less than 0.9 and 4
   *   otherwise: js/game_manager.js L71
   *   (`var value = Math.random() < 0.9 ? 2 : 4;`) exactly.
   *
   * @param items Candidates, read in the given index order.
   * @param weights Relative weight of each entry of `items`, in the
   *   same index order. Need not sum to 1.
   * @returns The selected element, or `undefined` — consuming no draw
   *   — when `items` is empty, when the two arrays differ in length,
   *   when a weight is negative or not finite, or when the weights do
   *   not total more than 0.
   */
  pickWeighted<T>(
    items: readonly T[],
    weights: readonly number[]
  ): T | undefined;
}

/**
 * The four substreams of one run, addressed by name.
 *
 * INSTANCE STABILITY
 *   `stream()` returns the same object for a given name on every call,
 *   so a cursor advanced through one reference is visible through
 *   every other.
 */
export interface RngStreams {
  /**
   * Seed of the run these substreams were derived from, exactly as
   * supplied.
   *
   * Read by src/observability/logger.ts, which derives the per-run
   * correlation identifier from the run seed.
   */
  readonly seed: string;

  /**
   * Returns the substream registered under `name`.
   *
   * @param name Substream to address.
   * @returns The stable substream instance for that name.
   */
  stream(name: StreamName): RngStream;

  /**
   * Reads the current draw count of every substream.
   *
   * Cheap and callable at any point: it reads four cursors and
   * consumes no draw. Returns a fresh object each call, built by
   * walking `RNG_STREAM_NAMES`, so a caller can neither mutate
   * internal state through the result nor observe a later advance in
   * an already-returned snapshot.
   *
   * @returns A total cursor map, suitable for persistence as the run
   *   state's `rngCursor` field and for replay through
   *   `createRngStreams()`.
   */
  snapshotCursors(): RngCursorMap;
}

/**
 * Builds a value for every substream name and collects the results
 * into a total map.
 *
 * Walks `RNG_STREAM_NAMES` in tuple order and calls `produce` once per
 * name, so both the eager stream table and every cursor snapshot are
 * assembled from the same ordered source.
 *
 * @param produce Called once per substream name, in tuple order.
 * @returns A map carrying one entry per substream name.
 */
function mapStreamNames<T>(
  produce: (name: StreamName) => T
): Record<StreamName, T> {
  const built: Partial<Record<StreamName, T>> = {};

  for (const name of RNG_STREAM_NAMES) {
    built[name] = produce(name);
  }

  // Total by construction: the loop above assigns every entry of
  // RNG_STREAM_NAMES, which is the complete key set of the result.
  return built as Record<StreamName, T>;
}

/**
 * Reduces one recorded cursor entry to a usable draw count.
 *
 * The value reaching here has normally come back out of Web Storage
 * through the guarded run-state loader, so it may be absent, or may
 * have been written by an older or a corrupted payload. Anything that
 * is not a non-negative safe integer is treated as no recorded
 * position and reported as 0. This function never throws.
 *
 * An absent entry is rejected first. `Number.isSafeInteger` then
 * rejects `NaN`, `Infinity`, `-Infinity`, every fractional value,
 * every magnitude beyond the exactly representable integer range, and
 * any value that is not a number at all. The final comparison
 * collapses negatives and `-0` to `+0`.
 *
 * @param recorded Draw count read from a caller's cursor map.
 * @returns A non-negative safe integer; 0 when `recorded` carries no
 *   usable position.
 */
function normaliseCursor(recorded: number | undefined): number {
  if (recorded === undefined) {
    return 0;
  }

  if (!Number.isSafeInteger(recorded)) {
    return 0;
  }

  return recorded > 0 ? recorded : 0;
}

/**
 * Totals a weight list, rejecting the shapes no selection can be made
 * from.
 *
 * Reads `weights` in the given index order and consumes no draw, so a
 * rejected call leaves the calling substream's cursor untouched.
 *
 * @param itemCount Number of candidates the weights describe.
 * @param weights Weight of each candidate, in candidate index order.
 * @returns The total weight, or `undefined` when there are no
 *   candidates, when the counts disagree, when a weight is negative or
 *   not finite, or when the total is not greater than 0.
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
  }

  return total > 0 ? total : undefined;
}

/**
 * Wraps one seeded generator as a named substream.
 *
 * The returned object holds no draw state of its own: `cursor` reads
 * through to the generator, and every helper draws through the same
 * `next()`. The helpers are closures over that generator and read no
 * `this`, so a destructured helper still draws from this substream.
 *
 * @param name Name to report as the substream's own.
 * @param rng Seeded generator this substream draws from.
 * @returns The substream.
 */
function createStream(name: StreamName, rng: SeededRng): RngStream {
  function next(): number {
    return rng.next();
  }

  // Ported from js/grid.js L41,
  // `cells[Math.floor(Math.random() * cells.length)]`.
  function nextInt(maxExclusive: number): number {
    if (!Number.isFinite(maxExclusive) || maxExclusive <= 0) {
      return 0;
    }

    return Math.floor(next() * maxExclusive);
  }

  // Ported from js/grid.js L37-L43, `randomAvailableCell`, whose
  // `if (cells.length)` guard has no else branch.
  function pick<T>(items: readonly T[]): T | undefined {
    if (items.length === 0) {
      return undefined;
    }

    // One draw in total: `nextInt` performs it.
    return items[nextInt(items.length)];
  }

  // Ported from js/game_manager.js L71,
  // `var value = Math.random() < 0.9 ? 2 : 4;`.
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
  };
}

/**
 * Creates the four substreams of one run.
 *
 * All four are constructed eagerly, by walking `RNG_STREAM_NAMES`, so
 * `snapshotCursors()` is total from the first call and the cursor
 * accounting does not depend on which substreams a run happens to
 * touch. Each substream is seeded with `deriveStreamSeed(seed, name)`,
 * so two runs sharing a seed produce identical sequences in every
 * substream, and a draw taken from one substream does not move any
 * other.
 *
 * RESUMING
 *   A supplied `cursors` map fast-forwards each substream past the
 *   draws it records, leaving it exactly where the instance that
 *   produced the map stood. Restore is tolerant and never throws: a
 *   missing entry starts that substream at 0, an entry that is not a
 *   non-negative safe integer starts at 0, and a key that is not a
 *   substream name is ignored — only the names in `RNG_STREAM_NAMES`
 *   are read.
 *
 *   Restore fast-forwards; it does not replay. Provenance for that
 *   behaviour: js/game_manager.js `setup()` (L35-L59) calls
 *   `addStartTiles()` only on a fresh start and skips it when a
 *   previous state is present (L39-L45), and `startTiles` is 2
 *   (js/game_manager.js L7), so a resumed run continues its sequence
 *   and does not take the opening draws again.
 *
 * @param seed Run seed. Used verbatim; this module never originates
 *   one.
 * @param cursors Draw counts to resume each substream from. Defaults
 *   to a fresh start for all four.
 * @returns The run's substreams.
 *
 * @example
 * const streams = createRngStreams('run-seed-2048');
 * const value = streams
 *   .stream('spawn-value')
 *   .pickWeighted([2, 4], [0.9, 0.1]);      // 2 or 4
 * const cell = streams
 *   .stream('spawn-position')
 *   .pick(availableCells);                  // undefined when full
 *
 * @example
 * // Persisting and resuming: the resumed run continues the sequence.
 * const saved = streams.snapshotCursors();
 * const resumed = createRngStreams('run-seed-2048', saved);
 * resumed.stream('spawn-value').cursor === saved['spawn-value'];
 */
export function createRngStreams(
  seed: string,
  cursors?: Partial<RngCursorMap>
): RngStreams {
  const table = mapStreamNames((name) =>
    createStream(
      name,
      createSeededRng(
        deriveStreamSeed(seed, name),
        normaliseCursor(cursors?.[name])
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

