// Unit suite over src/rng/seeded-rng.ts, the seeded generator every random
// draw in the product originates from.
//
// It pins the three members of that module's contract the rest of the
// product is built on: `createSeededRng`, the `SeededRng` shape it returns,
// and `deriveStreamSeed`. R10 places the suite in scope. It is the
// unit-level half of validation gate V2, seeded reproducibility; the
// end-to-end half is the separately stored and separately configured seeded
// gate, which owns every committed baseline. This file writes none.
//
// Contract 6, which the suite pins: one seed per run, derived into named
// substreams, with each substream's consumed-draw count persisted so a
// resumed run continues its own sequence instead of restarting it.
//
// Provenance of the randomness contract, from the deleted vanilla sources:
//   js/game_manager.js L71  the spawn value, a 0.9 / 0.1 split over 2 and 4
//   js/grid.js L41          the spawn position, an index into the available
//                           cells
// Those two call sites are the closed set the seeded generator replaces.
// Each drew from the platform generator, whose half-open [0, 1) interval
// section 3 asserts of `next()`. The platform generator itself is named
// nowhere in this file; the suite that guards it against being patched owns
// that name.
//
// The substream fan-out `deriveStreamSeed` feeds is drawn as Figure 7,
// "Seeded Determinism: One Run Seed Fanned into Named RNG Substreams", in
// docs/architecture/data-flow.md. No diagram is repeated here.
//
// Every assertion below is relational: a sequence is compared against
// another sequence drawn from this same module, against a slice of a longer
// sequence from the same seed, or against the half-open interval. No
// generator output is written into an expectation, and no member outside
// the three named above is read.
//
// Every seed is a string literal. The suite reads no clock, no environment
// variable and no ambient randomness. It touches no DOM, no document and no
// storage, registers no setup or teardown of its own, writes no snapshot
// artifact and emits no log. Repeat runs produce identical results.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import { describe, expect, it } from 'vitest';

import {
  createSeededRng,
  deriveStreamSeed,
} from '../../../src/rng/seeded-rng';
import type { SeededRng } from '../../../src/rng/seeded-rng';

/* ===== 1. Seeds, lengths and labels ===== */

/** Run seed most cases draw from. */
const RUN_SEED = 'run-seed-2048';

/** A second, different run seed, for the cases that need two. */
const ALTERNATE_RUN_SEED = 'run-seed-4096';

/** Draws compared whenever two whole sequences are put side by side. */
const SEQUENCE_LENGTH = 20;

/** Draws the interval assertions in section 3 walk. */
const RANGE_SAMPLE_LENGTH = 512;

/** The two draw counts the cursor is read at after a run of `next()`. */
const CURSOR_DRAW_COUNTS: readonly number[] = [5, 17];

/** Draws taken one at a time while the cursor is read after each. */
const CURSOR_WALK_LENGTH = 24;

/** Length of the reference sequence every resume offset slices. */
const REFERENCE_LENGTH = 40;

/**
 * Resume positions the fast-forward is tested at: none, the first draw, a
 * mid position and a late one. The largest plus `RESUME_DRAW_COUNT` stays
 * inside `REFERENCE_LENGTH`, so every slice is a full-length comparison.
 */
const RESUME_OFFSETS: readonly number[] = [0, 1, 7, 23];

/** Draws taken from each resumed generator. */
const RESUME_DRAW_COUNT = 12;

/** Draws consumed before a generator's cursor is used to restore it. */
const DRAIN_LENGTH = 13;

/** Draws the original and the restored generator then take together. */
const LOCKSTEP_LENGTH = 9;

/**
 * The four substream labels Contract 6 names, as literals.
 *
 * The tuple that declares them belongs to the substream layer, and that
 * layer's own suite asserts the tuple's identity.
 */
const SUBSTREAM_LABELS: readonly string[] = [
  'spawn-value',
  'spawn-position',
  'relic-draw',
  'rarity-weight',
];

/* ===== 2. Sequence collection ===== */

/**
 * Consumes `count` draws from `rng` and returns them in draw order.
 *
 * The only member it reads is `next()`, so a sequence collected here is
 * reproducible from the constructor and that one call.
 *
 * @param rng Generator to draw from.
 * @param count Number of draws to consume.
 * @returns The consumed draws, oldest first.
 */
function draw(rng: SeededRng, count: number): number[] {
  const values: number[] = [];

  for (let index = 0; index < count; index += 1) {
    values.push(rng.next());
  }

  return values;
}

/* ===== 3. createSeededRng ===== */

describe('createSeededRng', () => {
  describe('determinism across independent instantiations', () => {
    it('yields identical sequences from the same seed', () => {
      const first = draw(createSeededRng(RUN_SEED), SEQUENCE_LENGTH);
      const second = draw(createSeededRng(RUN_SEED), SEQUENCE_LENGTH);

      expect(first).toHaveLength(SEQUENCE_LENGTH);
      expect(second).toEqual(first);
    });

    it('yields that sequence again after earlier generators drain', () => {
      const first = createSeededRng(RUN_SEED);
      const second = createSeededRng(RUN_SEED);
      const firstSequence = draw(first, SEQUENCE_LENGTH);
      const secondSequence = draw(second, SEQUENCE_LENGTH);

      // Constructed only once both earlier generators are exhausted.
      const third = createSeededRng(RUN_SEED);
      const thirdSequence = draw(third, SEQUENCE_LENGTH);

      expect(secondSequence).toEqual(firstSequence);
      expect(thirdSequence).toEqual(firstSequence);
      expect(third.cursor).toBe(SEQUENCE_LENGTH);
    });

    it('yields different sequences from two different seeds', () => {
      const fromRunSeed = draw(createSeededRng(RUN_SEED), SEQUENCE_LENGTH);
      const fromAlternateSeed = draw(
        createSeededRng(ALTERNATE_RUN_SEED),
        SEQUENCE_LENGTH
      );

      expect(fromAlternateSeed).toHaveLength(SEQUENCE_LENGTH);
      expect(fromAlternateSeed).not.toEqual(fromRunSeed);
    });

    it('echoes the seed string it was constructed from', () => {
      const fresh = createSeededRng(RUN_SEED);
      const alternate = createSeededRng(ALTERNATE_RUN_SEED);
      const resumed = createSeededRng(RUN_SEED, DRAIN_LENGTH);

      expect(fresh.seed).toBe(RUN_SEED);
      expect(alternate.seed).toBe(ALTERNATE_RUN_SEED);
      expect(resumed.seed).toBe(RUN_SEED);

      draw(fresh, SEQUENCE_LENGTH);

      expect(fresh.seed).toBe(RUN_SEED);
    });
  });

  describe('output range and shape', () => {
    it('draws a finite number in the half-open interval [0, 1)', () => {
      const rng = createSeededRng(RUN_SEED);

      for (let index = 0; index < RANGE_SAMPLE_LENGTH; index += 1) {
        const value = rng.next();

        expect(typeof value).toBe('number');
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      }

      expect(rng.cursor).toBe(RANGE_SAMPLE_LENGTH);
    });
  });

  describe('cursor semantics', () => {
    it('reports cursor 0 for a fresh generator', () => {
      expect(createSeededRng(RUN_SEED).cursor).toBe(0);
    });

    it('reports cursor 1 after a single next() call', () => {
      const rng = createSeededRng(RUN_SEED);

      rng.next();

      expect(rng.cursor).toBe(1);
    });

    it('reports n as its cursor after n next() calls', () => {
      for (const drawCount of CURSOR_DRAW_COUNTS) {
        const rng = createSeededRng(RUN_SEED);

        expect(draw(rng, drawCount)).toHaveLength(drawCount);
        expect(rng.cursor).toBe(drawCount);
      }
    });

    it('advances the cursor by exactly one per draw', () => {
      const rng = createSeededRng(RUN_SEED);
      const observedCursors: number[] = [];
      const expectedCursors: number[] = [];

      for (let position = 1; position <= CURSOR_WALK_LENGTH; position += 1) {
        rng.next();
        observedCursors.push(rng.cursor);
        expectedCursors.push(position);
      }

      expect(observedCursors).toEqual(expectedCursors);
    });
  });

  describe('startCursor fast-forward', () => {
    it('fast-forwards by discarding draws when supplied', () => {
      const reference = draw(createSeededRng(RUN_SEED), REFERENCE_LENGTH);

      expect(reference).toHaveLength(REFERENCE_LENGTH);

      for (const offset of RESUME_OFFSETS) {
        const resumed = createSeededRng(RUN_SEED, offset);
        const continuation = draw(resumed, RESUME_DRAW_COUNT);

        expect(continuation).toHaveLength(RESUME_DRAW_COUNT);
        expect(continuation).toEqual(
          reference.slice(offset, offset + RESUME_DRAW_COUNT)
        );
      }
    });

    it('reports the fast-forwarded position as its cursor', () => {
      for (const offset of RESUME_OFFSETS) {
        const resumed = createSeededRng(RUN_SEED, offset);

        expect(resumed.cursor).toBe(offset);

        draw(resumed, RESUME_DRAW_COUNT);

        expect(resumed.cursor).toBe(offset + RESUME_DRAW_COUNT);
      }
    });

    it('treats an explicit 0 as equivalent to omitting it', () => {
      const omitted = createSeededRng(RUN_SEED);
      const explicitZero = createSeededRng(RUN_SEED, 0);

      expect(explicitZero.cursor).toBe(omitted.cursor);

      const fromOmitted = draw(omitted, SEQUENCE_LENGTH);
      const fromExplicitZero = draw(explicitZero, SEQUENCE_LENGTH);

      expect(fromExplicitZero).toEqual(fromOmitted);
      expect(explicitZero.cursor).toBe(omitted.cursor);
    });

    it('continues in lockstep with a cursor-restored generator', () => {
      const original = createSeededRng(RUN_SEED);

      draw(original, DRAIN_LENGTH);

      const restored = createSeededRng(RUN_SEED, original.cursor);

      expect(restored.cursor).toBe(DRAIN_LENGTH);

      const fromOriginal = draw(original, LOCKSTEP_LENGTH);
      const fromRestored = draw(restored, LOCKSTEP_LENGTH);

      expect(fromRestored).toHaveLength(LOCKSTEP_LENGTH);
      expect(fromRestored).toEqual(fromOriginal);
      expect(restored.cursor).toBe(original.cursor);
    });
  });

  describe('next() as the sole randomness primitive', () => {
    it('exposes exactly the documented SeededRng shape', () => {
      const rng = createSeededRng(RUN_SEED);

      expect(typeof rng.next).toBe('function');
      expect(typeof rng.seed).toBe('string');
      expect(typeof rng.cursor).toBe('number');
    });

    it('reproduces a sequence from the constructor and next()', () => {
      // Reaches for `createSeededRng` and `next()` only, without the
      // local helper.
      const collected: number[] = [];
      const rng = createSeededRng(RUN_SEED);

      for (let index = 0; index < SEQUENCE_LENGTH; index += 1) {
        collected.push(rng.next());
      }

      const replayed: number[] = [];
      const replay = createSeededRng(RUN_SEED);

      for (let index = 0; index < SEQUENCE_LENGTH; index += 1) {
        replayed.push(replay.next());
      }

      expect(collected).toHaveLength(SEQUENCE_LENGTH);
      expect(replayed).toEqual(collected);
    });
  });
});

/* ===== 4. deriveStreamSeed ===== */

describe('deriveStreamSeed', () => {
  it('returns the same string for the same seed and label', () => {
    for (const label of SUBSTREAM_LABELS) {
      expect(deriveStreamSeed(RUN_SEED, label)).toBe(
        deriveStreamSeed(RUN_SEED, label)
      );
    }
  });

  it('returns a non-empty string', () => {
    for (const label of SUBSTREAM_LABELS) {
      const derived = deriveStreamSeed(RUN_SEED, label);

      expect(typeof derived).toBe('string');
      expect(derived.length).toBeGreaterThan(0);
    }
  });

  it('derives a distinct seed for each substream label', () => {
    const derived = SUBSTREAM_LABELS.map((label) =>
      deriveStreamSeed(RUN_SEED, label)
    );

    expect(SUBSTREAM_LABELS).toHaveLength(4);
    expect(new Set(derived).size).toBe(SUBSTREAM_LABELS.length);
  });

  it('derives a distinct seed per run seed for one label', () => {
    for (const label of SUBSTREAM_LABELS) {
      expect(deriveStreamSeed(ALTERNATE_RUN_SEED, label)).not.toBe(
        deriveStreamSeed(RUN_SEED, label)
      );
    }
  });

  it('does not collapse to the bare run seed', () => {
    for (const label of SUBSTREAM_LABELS) {
      expect(deriveStreamSeed(RUN_SEED, label)).not.toBe(RUN_SEED);
      expect(deriveStreamSeed(ALTERNATE_RUN_SEED, label)).not.toBe(
        ALTERNATE_RUN_SEED
      );
    }
  });

  it('separates the sequences of two derived seeds', () => {
    const sequences = SUBSTREAM_LABELS.map((label) =>
      draw(createSeededRng(deriveStreamSeed(RUN_SEED, label)), SEQUENCE_LENGTH)
    );

    expect(sequences).toHaveLength(SUBSTREAM_LABELS.length);

    for (let first = 0; first < sequences.length; first += 1) {
      expect(sequences[first]).toHaveLength(SEQUENCE_LENGTH);

      for (let second = first + 1; second < sequences.length; second += 1) {
        expect(sequences[second]).not.toEqual(sequences[first]);
      }
    }
  });
});
