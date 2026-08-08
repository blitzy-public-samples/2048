// Unit suite over src/rng/seeded-rng.ts, the seeded generator every random draw
// in the product originates from. It pins the three members of that module's
// contract the rest of the product is built on: `createSeededRng`, the
// `SeededRng` shape it returns, and `deriveStreamSeed`.
//
// The randomness contract it stands for: one seed per run, derived into named
// substreams, with each substream's consumed-draw count persisted so a resumed
// run continues its own sequence instead of restarting it. The two vanilla call
// sites the generator replaces are the spawn value in js/game_manager.js and
// the spawn position in js/grid.js; each drew from the platform generator,
// whose half-open [0, 1) interval is asserted of `next()` below.
//
// Every assertion is relational: a sequence is compared against another
// sequence from this same module, against a slice of a longer sequence from the
// same seed, or against the half-open interval. No generator output is written
// into an expectation. Every seed is a string literal, and the suite reads no
// clock, no environment variable and no ambient randomness. It touches no DOM
// and no storage, writes no snapshot artifact and emits no log.
//
// Decisions of docs/DECISION_LOG.md this suite is the evidence for, one apiece:
// DL-RNG-01, DL-RNG-02, DL-RNG-03.
// Rows of docs/TRACEABILITY_MATRIX.md it covers, one apiece: TR-RNG-01,
// TR-RNG-02, TR-RNG-03, TR-RNG-04, TR-RNG-05.

import { describe, expect, it } from 'vitest';

import {
  MAX_RESUMABLE_CURSOR,
  MAX_RNG_CURSOR,
  MAX_RNG_SEED_LENGTH,
  createSeededRng,
  deriveStreamSeed,
  isAcceptableRngCursor,
  isAcceptableRngSeed,
  normaliseStartCursor,
} from '../../../src/rng/seeded-rng';
import type {
  RngRejection,
  RngReporter,
  SeededRng,
} from '../../../src/rng/seeded-rng';

const RUN_SEED = 'run-seed-2048';

const ALTERNATE_RUN_SEED = 'run-seed-4096';

const SEQUENCE_LENGTH = 20;

const RANGE_SAMPLE_LENGTH = 512;

const CURSOR_DRAW_COUNTS: readonly number[] = [5, 17];

const CURSOR_WALK_LENGTH = 24;

const REFERENCE_LENGTH = 40;

const RESUME_OFFSETS: readonly number[] = [0, 1, 7, 23];

const RESUME_DRAW_COUNT = 12;

const DRAIN_LENGTH = 13;

/**
 * Seed the anchored draw in section 6 is taken from. AAP §0.2.3.1 recorded the
 * underlying generator's first draw for this exact seed.
 */
const ANCHOR_SEED = 'seed-42';

/**
 * The first draw of `ANCHOR_SEED`, as AAP §0.2.3.1 recorded it. The one literal
 * generator output in this file: it pins the sequence to this generator, so a
 * seed a player copies out of one build still reproduces in the next.
 */
const ANCHOR_FIRST_DRAW = 0.6978250726799878;

/** Draws the original and the restored generator then take together. */
const LOCKSTEP_LENGTH = 9;

const SUBSTREAM_LABELS: readonly string[] = [
  'spawn-value',
  'spawn-position',
  'relic-draw',
  'rarity-weight',
];

function draw(rng: SeededRng, count: number): number[] {
  const values: number[] = [];

  for (let index = 0; index < count; index += 1) {
    values.push(rng.next());
  }

  return values;
}

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

/* ===== 5. Bounds, predicates and refusal reports ===== */

/** A recorded rejection, and the sink that collected it. */
interface RecordingRngReporter {
  /** The sink to hand to the module under test. */
  readonly reporter: RngReporter;

  /** Every rejection received, in arrival order. */
  readonly rejections: RngRejection[];
}

/**
 * Builds a reporter that records every rejection it is handed.
 *
 * @returns The sink and the array it appends to.
 */
function createRecordingReporter(): RecordingRngReporter {
  const rejections: RngRejection[] = [];

  return {
    reporter: {
      onRejected: (rejection: RngRejection): void => {
        rejections.push(rejection);
      },
    },
    rejections,
  };
}

/** A sink whose only member throws, for the containment assertions. */
const THROWING_REPORTER: RngReporter = {
  onRejected: (): never => {
    throw new Error('the rejection sink itself failed');
  },
};

/** A seed of exactly the greatest permitted length. */
const LONGEST_ACCEPTED_SEED = 's'.repeat(MAX_RNG_SEED_LENGTH);

/** A seed one character past the greatest permitted length. */
const OVERLONG_SEED = 's'.repeat(MAX_RNG_SEED_LENGTH + 1);

/** Start cursors reduced to 0 because they are not a usable position. */
const UNUSABLE_CURSORS: readonly { label: string; value: number }[] = [
  { label: 'a negative integer', value: -1 },
  { label: 'a large negative integer', value: -100_000 },
  { label: 'a fractional value', value: 1.5 },
  { label: 'a fractional value below one', value: 0.5 },
  { label: 'NaN', value: Number.NaN },
  { label: 'Infinity', value: Number.POSITIVE_INFINITY },
  { label: '-Infinity', value: Number.NEGATIVE_INFINITY },
  { label: 'a magnitude past the safe integer range', value: 2 ** 53 },
];

/** Start cursors reduced to 0 because they exceed the fast-forward bound. */
const OUT_OF_RANGE_CURSORS: readonly { label: string; value: number }[] = [
  { label: 'one draw past the bound', value: MAX_RNG_CURSOR + 1 },
  { label: 'ten times the bound', value: MAX_RNG_CURSOR * 10 },
  { label: 'the greatest safe integer', value: Number.MAX_SAFE_INTEGER },
];

describe('the seed and cursor bounds', () => {
  it('declares one cursor ceiling under both of its names', () => {
    expect(MAX_RESUMABLE_CURSOR).toBe(MAX_RNG_CURSOR);
    expect(Number.isSafeInteger(MAX_RNG_CURSOR)).toBe(true);
    expect(MAX_RNG_CURSOR).toBeGreaterThan(0);
  });

  it('declares a seed length bound that is a positive whole number', () => {
    expect(Number.isSafeInteger(MAX_RNG_SEED_LENGTH)).toBe(true);
    expect(MAX_RNG_SEED_LENGTH).toBeGreaterThan(0);
  });
});

describe('isAcceptableRngSeed', () => {
  it('accepts a seed at the bound and refuses one past it', () => {
    expect(LONGEST_ACCEPTED_SEED).toHaveLength(MAX_RNG_SEED_LENGTH);
    expect(OVERLONG_SEED).toHaveLength(MAX_RNG_SEED_LENGTH + 1);
    expect(isAcceptableRngSeed(LONGEST_ACCEPTED_SEED)).toBe(true);
    expect(isAcceptableRngSeed(OVERLONG_SEED)).toBe(false);
  });

  it('accepts the empty seed and every seed this suite draws from', () => {
    expect(isAcceptableRngSeed('')).toBe(true);
    expect(isAcceptableRngSeed(RUN_SEED)).toBe(true);
    expect(isAcceptableRngSeed(ALTERNATE_RUN_SEED)).toBe(true);
  });

  it('answers the same question createSeededRng throws on', () => {
    expect(() => createSeededRng(LONGEST_ACCEPTED_SEED)).not.toThrow();
    expect(() => createSeededRng(OVERLONG_SEED)).toThrow(RangeError);
  });
});

describe('isAcceptableRngCursor', () => {
  it('accepts 0, one draw and the bound itself', () => {
    expect(isAcceptableRngCursor(0)).toBe(true);
    expect(isAcceptableRngCursor(1)).toBe(true);
    expect(isAcceptableRngCursor(MAX_RNG_CURSOR)).toBe(true);
  });

  it('refuses every cursor the fast-forward cannot absorb', () => {
    for (const { value } of [...UNUSABLE_CURSORS, ...OUT_OF_RANGE_CURSORS]) {
      expect(isAcceptableRngCursor(value)).toBe(false);
    }
  });

  it('refuses a value that is not a number at all', () => {
    expect(isAcceptableRngCursor(undefined)).toBe(false);
    expect(isAcceptableRngCursor(null)).toBe(false);
    expect(isAcceptableRngCursor('7')).toBe(false);
    expect(isAcceptableRngCursor(true)).toBe(false);
    expect(isAcceptableRngCursor({})).toBe(false);
  });

  it('accepts -0 as the same position as 0', () => {
    expect(isAcceptableRngCursor(-0)).toBe(true);
    expect(normaliseStartCursor(-0)).toBe(0);
    expect(Object.is(normaliseStartCursor(-0), -0)).toBe(false);
  });
});

describe('normaliseStartCursor', () => {
  it('returns 0 for an absent cursor and reports nothing', () => {
    const recording = createRecordingReporter();

    expect(normaliseStartCursor(undefined, recording.reporter)).toBe(0);
    expect(recording.rejections).toStrictEqual([]);
  });

  it('returns a usable cursor unchanged and reports nothing', () => {
    const recording = createRecordingReporter();

    for (const value of [0, 1, 7, MAX_RNG_CURSOR]) {
      expect(normaliseStartCursor(value, recording.reporter)).toBe(value);
    }

    expect(recording.rejections).toStrictEqual([]);
  });

  it.each(UNUSABLE_CURSORS)(
    'reduces $label to 0 and reports it as unusable',
    ({ value }: { value: number }) => {
      const recording = createRecordingReporter();

      expect(normaliseStartCursor(value, recording.reporter)).toBe(0);
      expect(recording.rejections).toStrictEqual([
        {
          kind: 'cursor-unusable',
          observed: value,
          maximum: MAX_RNG_CURSOR,
        },
      ]);
    }
  );

  it.each(OUT_OF_RANGE_CURSORS)(
    'reduces $label to 0 and reports it as out of range',
    ({ value }: { value: number }) => {
      const recording = createRecordingReporter();

      expect(normaliseStartCursor(value, recording.reporter)).toBe(0);
      expect(recording.rejections).toStrictEqual([
        {
          kind: 'cursor-out-of-range',
          observed: value,
          maximum: MAX_RNG_CURSOR,
        },
      ]);
    }
  );

  it('carries no substream name on a rejection of its own', () => {
    const recording = createRecordingReporter();

    normaliseStartCursor(-1, recording.reporter);

    expect(recording.rejections[0].stream).toBeUndefined();
    expect('stream' in recording.rejections[0]).toBe(false);
  });

  it('never throws, with a reporter, without one, or with a broken one', () => {
    for (const value of [...UNUSABLE_CURSORS, ...OUT_OF_RANGE_CURSORS]) {
      expect(normaliseStartCursor(value.value)).toBe(0);
      expect(normaliseStartCursor(value.value, {})).toBe(0);
      expect(normaliseStartCursor(value.value, THROWING_REPORTER)).toBe(0);
    }
  });
});

describe('createSeededRng refuses what the predicates refuse', () => {
  it('reports an overlong seed before it throws', () => {
    const recording = createRecordingReporter();

    expect(() =>
      createSeededRng(OVERLONG_SEED, 0, recording.reporter)
    ).toThrow(RangeError);
    expect(recording.rejections).toStrictEqual([
      {
        kind: 'seed-too-long',
        observed: OVERLONG_SEED.length,
        maximum: MAX_RNG_SEED_LENGTH,
      },
    ]);
  });

  it('names both lengths in the error it throws', () => {
    expect(() => createSeededRng(OVERLONG_SEED)).toThrow(
      `A seed may be at most ${String(MAX_RNG_SEED_LENGTH)} characters ` +
        `long; this one is ${String(OVERLONG_SEED.length)}.`
    );
  });

  it('still throws for an overlong seed when the sink throws too', () => {
    expect(() =>
      createSeededRng(OVERLONG_SEED, 0, THROWING_REPORTER)
    ).toThrow(RangeError);
  });

  it('builds a generator at the greatest permitted seed length', () => {
    const rng = createSeededRng(LONGEST_ACCEPTED_SEED);

    expect(rng.seed).toBe(LONGEST_ACCEPTED_SEED);
    expect(draw(rng, SEQUENCE_LENGTH)).toEqual(
      draw(createSeededRng(LONGEST_ACCEPTED_SEED), SEQUENCE_LENGTH)
    );
  });

  it.each([...UNUSABLE_CURSORS, ...OUT_OF_RANGE_CURSORS])(
    'starts a fresh sequence for $label rather than throwing',
    ({ value }: { value: number }) => {
      const recording = createRecordingReporter();
      const resumed = createSeededRng(RUN_SEED, value, recording.reporter);

      expect(resumed.cursor).toBe(0);
      expect(draw(resumed, SEQUENCE_LENGTH)).toEqual(
        draw(createSeededRng(RUN_SEED), SEQUENCE_LENGTH)
      );
      expect(recording.rejections).toHaveLength(1);
      expect(recording.rejections[0].observed).toBe(value);
      expect(recording.rejections[0].maximum).toBe(MAX_RNG_CURSOR);
    }
  );

  it('reports a refused cursor with the kind the reduction assigned', () => {
    const unusable = createRecordingReporter();
    const outOfRange = createRecordingReporter();

    createSeededRng(RUN_SEED, -1, unusable.reporter);
    createSeededRng(RUN_SEED, MAX_RNG_CURSOR + 1, outOfRange.reporter);

    expect(unusable.rejections[0].kind).toBe('cursor-unusable');
    expect(outOfRange.rejections[0].kind).toBe('cursor-out-of-range');
  });

  it('contains a sink that throws while receiving a cursor refusal', () => {
    const resumed = createSeededRng(RUN_SEED, -1, THROWING_REPORTER);

    expect(resumed.cursor).toBe(0);
    expect(draw(resumed, SEQUENCE_LENGTH)).toEqual(
      draw(createSeededRng(RUN_SEED), SEQUENCE_LENGTH)
    );
  });

  it('accepts a sink declaring no member at all', () => {
    const resumed = createSeededRng(RUN_SEED, -1, {});

    expect(resumed.cursor).toBe(0);
  });

  it('reports nothing for a cursor it accepted', () => {
    const recording = createRecordingReporter();
    const resumed = createSeededRng(
      RUN_SEED,
      MAX_RNG_CURSOR,
      recording.reporter
    );

    expect(resumed.cursor).toBe(MAX_RNG_CURSOR);
    expect(recording.rejections).toStrictEqual([]);
  });
});

/* ===== 6. The generator behind the interface ===== */

// One literal draw, so the sequence a run seed reproduces is pinned to the
// generator this build ships rather than to whatever generator it ships.
// AAP §0.2.3.1 recorded this value for the seed `seed-42` while selecting the
// PRNG, and it was reproduced across independent instantiations there.
describe('the sequence is anchored, not merely self-consistent', () => {
  it("draws the recorded first value for the seed 'seed-42'", () => {
    expect(createSeededRng(ANCHOR_SEED).next()).toBe(ANCHOR_FIRST_DRAW);
  });

  it('draws it again from a second instance of the same seed', () => {
    expect(createSeededRng(ANCHOR_SEED).next()).toBe(ANCHOR_FIRST_DRAW);
    expect(createSeededRng(ANCHOR_SEED).next()).toBe(ANCHOR_FIRST_DRAW);
  });

  it('draws it again after fast-forwarding another instance', () => {
    createSeededRng(ANCHOR_SEED, DRAIN_LENGTH);

    expect(createSeededRng(ANCHOR_SEED).next()).toBe(ANCHOR_FIRST_DRAW);
  });

  it('does not draw it for a different seed', () => {
    expect(createSeededRng(RUN_SEED).next()).not.toBe(ANCHOR_FIRST_DRAW);
  });

  it('reaches the second value only after the first', () => {
    const rng = createSeededRng(ANCHOR_SEED);
    const first = rng.next();
    const second = rng.next();

    expect(first).toBe(ANCHOR_FIRST_DRAW);
    expect(second).not.toBe(ANCHOR_FIRST_DRAW);
    expect(createSeededRng(ANCHOR_SEED, 1).next()).toBe(second);
  });
});

/* ===== 7. The checkpoint primitive (F2) ===== */

// `fork()` is what makes a caller's draws abandonable. The properties below
// are the ones src/engine/hook-bus.ts depends on to keep a hook handler that
// throws from consuming randomness.

describe('SeededRng.fork', () => {
  it('hands back a different instance carrying the same seed and cursor',
    () => {
      const rng = createSeededRng(RUN_SEED);

      rng.next();
      rng.next();

      const fork = rng.fork();

      expect(fork).not.toBe(rng);
      expect(fork.seed).toBe(rng.seed);
      expect(fork.cursor).toBe(rng.cursor);
    });

  it('continues the sequence from where the original stands', () => {
    const rng = createSeededRng(RUN_SEED);
    const reference = createSeededRng(RUN_SEED);

    rng.next();
    reference.next();

    const fork = rng.fork();

    expect([fork.next(), fork.next(), fork.next()]).toEqual([
      reference.next(),
      reference.next(),
      reference.next(),
    ]);
  });

  it('leaves the original where it stood however much the fork draws', () => {
    const rng = createSeededRng(RUN_SEED);
    const fork = rng.fork();

    for (let taken = 0; taken < 10; taken += 1) {
      fork.next();
    }

    expect(rng.cursor).toBe(0);
    expect(fork.cursor).toBe(10);
  });

  it('is unaffected by later draws from the original', () => {
    const rng = createSeededRng(RUN_SEED);
    const fork = rng.fork();
    const first = fork.next();

    rng.next();
    rng.next();

    expect(fork.cursor).toBe(1);
    expect(first).toBe(createSeededRng(RUN_SEED).next());
  });

  it('lets a caller adopt a fork\'s draws by replaying them, landing on the ' +
    'same value a direct draw would have', () => {
    const rng = createSeededRng(RUN_SEED);
    const direct = createSeededRng(RUN_SEED);
    const from = rng.cursor;
    const fork = rng.fork();
    const takenByFork = [fork.next(), fork.next()];
    const taken = fork.cursor - from;

    // The adoption src/engine/hook-bus.ts performs on commit.
    for (let replayed = 0; replayed < taken; replayed += 1) {
      rng.next();
    }

    expect(takenByFork).toEqual([direct.next(), direct.next()]);
    expect(rng.cursor).toBe(2);
    expect(rng.next()).toBe(direct.next());
  });

  it('forks a fork', () => {
    const rng = createSeededRng(RUN_SEED);
    const fork = rng.fork();

    fork.next();

    const nested = fork.fork();

    expect(nested.cursor).toBe(1);
    expect(nested.next()).toBe(createSeededRng(RUN_SEED, 1).next());
    expect(rng.cursor).toBe(0);
  });

  it('forks a resumed generator at its resumed position', () => {
    const rng = createSeededRng(RUN_SEED, 5);
    const fork = rng.fork();

    expect(fork.cursor).toBe(5);
    expect(fork.next()).toBe(createSeededRng(RUN_SEED, 5).next());
  });

  it('produces the same sequence a generator built without forking ' +
    'produces, so forking changes no draw', () => {
    const forked = createSeededRng(RUN_SEED);
    const plain = createSeededRng(RUN_SEED);
    const taken: number[] = [];

    for (let index = 0; index < 8; index += 1) {
      // A fork opened and discarded before every draw.
      forked.fork().next();
      taken.push(forked.next());
    }

    expect(taken).toEqual(
      Array.from({ length: 8 }, (): number => plain.next()),
    );
  });

  it('does not patch Math.random', () => {
    const before = Math.random;
    const rng = createSeededRng(RUN_SEED);

    rng.fork().next();

    expect(Math.random).toBe(before);
  });
});
