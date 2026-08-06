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
 * Provenance: this module replaces the two `Math.random()` call sites
 * of the vanilla game, which were the only two in that codebase — the
 * spawn-value draw at js/game_manager.js L71 (inside `addRandomTile`,
 * L69-L76) and the spawn-position draw at js/grid.js L41 (inside
 * `randomAvailableCell`, L37-L43).
 *
 * The substream fan-out this module feeds is drawn as Figure 7,
 * "Seeded Determinism: One Run Seed Fanned into Named RNG Substreams",
 * in docs/architecture/data-flow.md.
 *
 * Rationale for the choices made here is recorded in
 * docs/DECISION_LOG.md.
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
 * Reduces a caller-supplied start cursor to a usable draw count.
 *
 * The value reaching here has normally come back out of Web Storage
 * through the guarded run-state loader, so it may be absent, or may
 * have been written by an older or a corrupted payload. Anything that
 * is not a non-negative safe integer is treated as no recorded
 * position at all and reported as 0. This function never throws.
 *
 * `Number.isSafeInteger` rejects `NaN`, `Infinity`, `-Infinity`, every
 * fractional value, and every magnitude beyond the exactly
 * representable integer range. The final comparison then collapses
 * negative values and `-0` to `+0`, so the returned count is always
 * usable as a loop bound and always compares identical to 0 when no
 * position was recorded.
 *
 * @param startCursor Draw count to resume from, or `undefined`.
 * @returns A non-negative safe integer; 0 when `startCursor` carries
 *   no usable position.
 */
function normaliseStartCursor(startCursor: number | undefined): number {
  if (startCursor === undefined) {
    return 0;
  }

  if (!Number.isSafeInteger(startCursor)) {
    return 0;
  }

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
 * Provenance for the resumed case: the vanilla game called
 * `addStartTiles()` only on a fresh start and skipped it when
 * restoring a saved board (js/game_manager.js L35-L59).
 *
 * A `startCursor` that is absent, fractional, negative, not finite, or
 * beyond the exactly representable integer range yields a fresh
 * instance at cursor 0 instead of an error.
 *
 * @param seed Seed the sequence is derived from. Used verbatim.
 * @param startCursor Number of draws to discard before the first
 *   `next()` call. Defaults to 0.
 * @returns A generator whose `cursor` reports its true position.
 *
 * @example
 * const rng = createSeededRng('run-seed-2048');
 * rng.next();          // first draw of the sequence
 * rng.cursor;          // 1
 *
 * @example
 * // Resuming a persisted run: both generators agree from here on.
 * const resumed = createSeededRng('run-seed-2048', 3);
 * resumed.cursor;      // 3
 * resumed.next();      // the sequence's fourth draw
 */
export function createSeededRng(
  seed: string,
  startCursor?: number
): SeededRng {
  const generator = seedrandom(seed);
  let cursor = normaliseStartCursor(startCursor);

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
 *
 * @example
 * deriveStreamSeed('abc', 'spawn-value');    // 'abc::spawn-value'
 * deriveStreamSeed('abc', 'spawn-position'); // 'abc::spawn-position'
 */
export function deriveStreamSeed(runSeed: string, label: string): string {
  return `${runSeed}${STREAM_SEED_DELIMITER}${label}`;
}
