// Guard suite for the invariant that the product never patches Math.random.
//
// Validation gate V2 requires this assertion. The invariant is the dotted edge
// of Figure 7, "Seeded Determinism: One Run Seed Fanned into Named RNG
// Substreams", in docs/architecture/data-flow.md.
//
// Provenance — Contract 6 replaced exactly two randomness call sites, the only
// two the repository ever held:
//   js/game_manager.js L71  var value = Math.random() < 0.9 ? 2 : 4;
//   js/grid.js L41          cells[Math.floor(Math.random() * cells.length)]
//
// Math.random is read here and never written. Nothing below assigns to it,
// wraps it, spies on it, stubs it, mocks it or restores it, and no expectation
// names a particular drawn value: every one is reference identity, whole-
// sequence equality, whole-sequence inequality, or a shape property of the
// built-in.
//
// Within tests/unit/rng this is the only file that calls Math.random; the two
// sibling suites take the invariant checked here as given.
//
// Every seed below is a string literal. This file reads no clock, no
// environment variable and no platform entropy source other than Math.random
// itself; it writes no snapshot artifact and prints nothing.
//
// Collected by the `unit:dom-free` project of vitest.config.ts, in the `node`
// environment, and exercised by `npm run test` alone — no server, no network,
// no browser, no WebGL.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import { afterAll, describe, expect, it } from 'vitest';

import { createSeededRng, deriveStreamSeed } from '../../../src/rng/seeded-rng';
import {
  RNG_STREAM_NAMES,
  createRngStreams,
  type StreamName,
} from '../../../src/rng/rng-streams';

/* ===== 1. The captured reference ===== */

// V2: Math.random is never patched. Captured at module scope, before this file
// constructs a generator or a substream, and compared against by section 4 and
// by the final guard in section 8.
const originalMathRandom = Math.random;

/* ===== 2. Fixtures ===== */

/** Seed the construction and draw cases of section 4 are built from. */
const GUARD_SEED = 'guard-seed-1';

/** Seed the ambient comparisons of section 5 are taken around. */
const AMBIENT_SEED = 'guard-seed-3';

/** Seed the isolation cases of section 6 rebuild from. */
const ISOLATION_SEED = 'guard-seed-2';

/** Prefix of the distinct literal seeds the repeat loop of section 4 builds. */
const REPEAT_SEED_PREFIX = 'guard-seed-repeat-';

/** Number of generators and substream sets the repeat loop constructs. */
const CONSTRUCTION_REPEATS = 48;

/** Draw count the fast-forward case of section 4 constructs against. */
const START_CURSOR = 12;

/** Recorded substream cursor the restore case of section 4 resumes from. */
const RESTORED_CURSOR = 4;

/** Substream the derivation case of section 4 names. */
const DERIVED_STREAM: StreamName = 'spawn-value';

/** Substream the isolation case of section 6 draws from. */
const ISOLATION_STREAM: StreamName = 'spawn-position';

/** Length of every seeded sequence collected in sections 4, 5 and 6. */
const SEQUENCE_LENGTH = 16;

/** Length of every ambient sequence collected in sections 5 and 6. */
const AMBIENT_SEQUENCE_LENGTH = 12;

/** Ambient draws consumed between the two collections of section 6. */
const AMBIENT_INTERFERENCE_DRAWS = 300;

/** Candidates the selecting primitives of section 4 choose from. */
const SAMPLE_ITEMS: readonly number[] = [2, 4, 8, 16];

/** Weights of `SAMPLE_ITEMS`, in the same index order. */
const SAMPLE_WEIGHTS: readonly number[] = [0.7, 0.2, 0.05, 0.05];

/** Exclusive upper bound the index primitive of section 4 is called with. */
const NEXT_INT_BOUND = 4;

/** Draws one pass over the four primitives of section 4 consumes. */
const DRAWS_PER_PRIMITIVE_PASS = 4;

/** The empty candidate list the declining cases of section 4 pass. */
const NO_ITEMS: readonly number[] = [];

/** The empty weight list the declining cases of section 4 pass. */
const NO_WEIGHTS: readonly number[] = [];

/** Marker a host-provided function carries in its source text. */
const NATIVE_CODE_MARKER = 'native code';

/* ===== 3. Draw collection ===== */

/** The one draw primitive `SeededRng` and `RngStream` both expose. */
interface DrawSource {
  /** Consumes exactly one draw and returns it. */
  next(): number;
}

/**
 * Collects consecutive draws from a seeded source.
 *
 * @param source Seeded generator or substream to draw from.
 * @param count Number of draws to take.
 * @returns The drawn values, in draw order.
 */
function drawSequence(source: DrawSource, count: number): number[] {
  const drawn: number[] = [];

  for (let index = 0; index < count; index += 1) {
    drawn.push(source.next());
  }

  return drawn;
}

/**
 * Collects consecutive values from the platform's own generator.
 *
 * Reads Math.random and never writes it.
 *
 * @param count Number of values to take.
 * @returns The collected values, in draw order.
 */
function ambientSequence(count: number): number[] {
  const collected: number[] = [];

  for (let index = 0; index < count; index += 1) {
    collected.push(Math.random());
  }

  return collected;
}

/**
 * Advances the platform's own generator, discarding what it yields.
 *
 * Reads Math.random and never writes it.
 *
 * @param count Number of values to consume.
 */
function consumeAmbientDraws(count: number): void {
  for (let index = 0; index < count; index += 1) {
    Math.random();
  }
}

/**
 * Asserts that Math.random is the exact function section 1 captured.
 */
function expectMathRandomUnpatched(): void {
  expect(Math.random).toBe(originalMathRandom);
}

/* ===== 4. Reference identity ===== */

describe('the seeded RNG leaves Math.random untouched', () => {
  it('leaves Math.random identical after constructing a generator', () => {
    createSeededRng(GUARD_SEED);

    expectMathRandomUnpatched();
  });

  it('leaves Math.random identical after fast-forwarding a generator', () => {
    createSeededRng(GUARD_SEED, START_CURSOR);

    expectMathRandomUnpatched();
  });

  it('leaves Math.random identical after deriving a substream seed', () => {
    deriveStreamSeed(GUARD_SEED, DERIVED_STREAM);

    expectMathRandomUnpatched();
  });

  it('leaves Math.random identical after constructing the substreams', () => {
    createRngStreams(GUARD_SEED);

    expectMathRandomUnpatched();
  });

  it('leaves Math.random identical after restoring recorded cursors', () => {
    createRngStreams(GUARD_SEED, { 'relic-draw': RESTORED_CURSOR });

    expectMathRandomUnpatched();
  });

  it('leaves Math.random identical after many repeated constructions', () => {
    for (let index = 0; index < CONSTRUCTION_REPEATS; index += 1) {
      const seed = `${REPEAT_SEED_PREFIX}${String(index)}`;

      createSeededRng(seed);
      createSeededRng(seed, index);
      createRngStreams(seed);
      createRngStreams(seed, { 'spawn-value': index });
    }

    expectMathRandomUnpatched();
  });

  it('leaves Math.random identical after repeated generator draws', () => {
    const rng = createSeededRng(GUARD_SEED);
    const drawn = drawSequence(rng, SEQUENCE_LENGTH);

    expect(drawn).toHaveLength(SEQUENCE_LENGTH);
    expect(rng.cursor).toBe(SEQUENCE_LENGTH);

    expectMathRandomUnpatched();
  });

  it('leaves Math.random identical after every substream primitive', () => {
    const streams = createRngStreams(GUARD_SEED);

    for (const name of RNG_STREAM_NAMES) {
      const stream = streams.stream(name);

      stream.next();
      stream.nextInt(NEXT_INT_BOUND);

      const picked = stream.pick(SAMPLE_ITEMS);
      const weighted = stream.pickWeighted(SAMPLE_ITEMS, SAMPLE_WEIGHTS);

      // Four drawing calls, one draw each.
      expect(stream.cursor).toBe(DRAWS_PER_PRIMITIVE_PASS);
      expect(picked).toBeDefined();
      expect(weighted).toBeDefined();

      if (picked !== undefined) {
        expect(SAMPLE_ITEMS).toContain(picked);
      }

      if (weighted !== undefined) {
        expect(SAMPLE_ITEMS).toContain(weighted);
      }

      expectMathRandomUnpatched();
    }

    expectMathRandomUnpatched();
  });

  it('leaves Math.random identical after primitives decline to select', () => {
    const streams = createRngStreams(GUARD_SEED);

    for (const name of RNG_STREAM_NAMES) {
      const stream = streams.stream(name);

      expect(stream.pick(NO_ITEMS)).toBeUndefined();
      expect(stream.pickWeighted(NO_ITEMS, NO_WEIGHTS)).toBeUndefined();

      // Neither call consumes a draw.
      expect(stream.cursor).toBe(0);

      expectMathRandomUnpatched();
    }

    expectMathRandomUnpatched();
  });
});

/* ===== 5. Ambient irreproducibility ===== */

describe('Math.random is not reproducible from a fixed seed', () => {
  it('does not replay its sequence when a generator is rebuilt', () => {
    createSeededRng(AMBIENT_SEED);
    const firstAmbient = ambientSequence(AMBIENT_SEQUENCE_LENGTH);

    createSeededRng(AMBIENT_SEED);
    const secondAmbient = ambientSequence(AMBIENT_SEQUENCE_LENGTH);

    expect(firstAmbient).toHaveLength(AMBIENT_SEQUENCE_LENGTH);
    expect(secondAmbient).toHaveLength(AMBIENT_SEQUENCE_LENGTH);
    expect(secondAmbient).not.toEqual(firstAmbient);

    expectMathRandomUnpatched();
  });

  it('does not match the sequence a generator produces for that seed', () => {
    const seeded = drawSequence(
      createSeededRng(AMBIENT_SEED),
      AMBIENT_SEQUENCE_LENGTH
    );
    const ambient = ambientSequence(AMBIENT_SEQUENCE_LENGTH);

    expect(ambient).toHaveLength(seeded.length);
    expect(ambient).not.toEqual(seeded);

    expectMathRandomUnpatched();
  });
});

/* ===== 6. Seeded isolation ===== */

describe('seeded sequences are independent of ambient Math.random', () => {
  it('reproduces a generator sequence after ambient draws', () => {
    const reference = drawSequence(
      createSeededRng(ISOLATION_SEED),
      SEQUENCE_LENGTH
    );

    consumeAmbientDraws(AMBIENT_INTERFERENCE_DRAWS);

    const afterAmbient = drawSequence(
      createSeededRng(ISOLATION_SEED),
      SEQUENCE_LENGTH
    );

    expect(afterAmbient).toEqual(reference);

    expectMathRandomUnpatched();
  });

  it('reproduces a substream sequence after ambient draws', () => {
    const reference = drawSequence(
      createRngStreams(ISOLATION_SEED).stream(ISOLATION_STREAM),
      SEQUENCE_LENGTH
    );

    consumeAmbientDraws(AMBIENT_INTERFERENCE_DRAWS);

    const afterAmbient = drawSequence(
      createRngStreams(ISOLATION_SEED).stream(ISOLATION_STREAM),
      SEQUENCE_LENGTH
    );

    expect(afterAmbient).toEqual(reference);

    expectMathRandomUnpatched();
  });
});

/* ===== 7. The platform built-in ===== */

describe('Math.random is still the platform built-in', () => {
  it('reports native code as the implementation of Math.random', () => {
    const source = Function.prototype.toString.call(Math.random);

    expect(source).toContain(NATIVE_CODE_MARKER);
  });

  it('exposes Math.random as a function declaring no parameters', () => {
    expect(typeof Math.random).toBe('function');
    expect(Math.random.length).toBe(0);
  });
});

/* ===== 8. Final guard ===== */

// Registered at file scope: runs once, after every case above.
afterAll(() => {
  expectMathRandomUnpatched();
});
