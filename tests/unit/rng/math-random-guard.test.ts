// Guard suite for the invariant that the product never patches Math.random.
//
// Contract 6 replaced exactly two randomness call sites, the only two the
// repository ever held: the spawn value in js/game_manager.js and the spawn
// position in js/grid.js.
//
// Math.random is read here and never written. Nothing below assigns to it,
// wraps it, spies on it, stubs it, mocks it or restores it, and no expectation
// names a particular drawn value: every one is reference identity,
// whole-sequence equality, whole-sequence inequality, or a shape property of
// the built-in. Within tests/unit/rng this is the only file that calls
// Math.random; the two sibling suites take the invariant as given.

import {
  PLATFORM_MATH_RANDOM,
  PLATFORM_MATH_RANDOM_DESCRIPTOR,
} from '../../fixtures/math-random-reference';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { createSeededRng, deriveStreamSeed } from '../../../src/rng/seeded-rng';
import {
  RNG_STREAM_NAMES,
  createRngStreams,
  type StreamName,
} from '../../../src/rng/rng-streams';

/* ===== 1. The captured reference ===== */

// V2: Math.random is never patched. The reference was captured by the fixture
// imported above, whose evaluation precedes that of the two RNG modules, and is
// compared against by section 4 and by the final guard in section 8.
const originalMathRandom = PLATFORM_MATH_RANDOM;

const GUARD_SEED = 'guard-seed-1';

/** Seed the isolation cases of section 6 rebuild from. */
const ISOLATION_SEED = 'guard-seed-2';

const REPEAT_SEED_PREFIX = 'guard-seed-repeat-';

const CONSTRUCTION_REPEATS = 48;

const START_CURSOR = 12;

const RESTORED_CURSOR = 4;

const DERIVED_STREAM: StreamName = 'spawn-value';

const ISOLATION_STREAM: StreamName = 'spawn-position';

/** Length of every seeded sequence collected in sections 4 and 6. */
const SEQUENCE_LENGTH = 16;

/** Ambient draws consumed between the two collections of section 6. */
const AMBIENT_INTERFERENCE_DRAWS = 300;

const SAMPLE_ITEMS: readonly number[] = [2, 4, 8, 16];

const SAMPLE_WEIGHTS: readonly number[] = [0.7, 0.2, 0.05, 0.05];

const NEXT_INT_BOUND = 4;

const DRAWS_PER_PRIMITIVE_PASS = 4;

const NO_ITEMS: readonly number[] = [];

const NO_WEIGHTS: readonly number[] = [];

/* ===== 3. Draw collection ===== */

/** The one draw primitive `SeededRng` and `RngStream` both expose. */
interface DrawSource {
  next(): number;
}

function drawSequence(source: DrawSource, count: number): number[] {
  const drawn: number[] = [];

  for (let index = 0; index < count; index += 1) {
    drawn.push(source.next());
  }

  return drawn;
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

function expectMathRandomUnpatched(): void {
  expect(Math.random).toBe(originalMathRandom);
}

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
      expect(stream.cursor).toBe(0);
      expectMathRandomUnpatched();
    }

    expectMathRandomUnpatched();
  });
});

/* ===== 5. Initialisation of the modules themselves ===== */

// The cases in section 4 exercise modules this file imported statically, so
// they
// measure the reference across construction and drawing but not across
// initialisation. These clear the module registry and import both modules
// again, which runs their bodies afresh, and compare the reference on either
// side of that. The comparison target is the fixture's capture, taken before
// this file's own dependencies were evaluated.
describe('initialising the RNG modules leaves Math.random untouched', () => {
  it('leaves it identical across a fresh generator-module evaluation',
    async () => {
      vi.resetModules();

      const before = Math.random;
      const freshModule = await import('../../../src/rng/seeded-rng');

      expect(Math.random).toBe(before);
      expectMathRandomUnpatched();

      const fresh = freshModule.createSeededRng(GUARD_SEED);

      expect(drawSequence(fresh, SEQUENCE_LENGTH)).toEqual(
        drawSequence(createSeededRng(GUARD_SEED), SEQUENCE_LENGTH)
      );
      expectMathRandomUnpatched();
    });

  it('leaves it identical across a fresh substream-module evaluation',
    async () => {
      vi.resetModules();

      const before = Math.random;
      const freshModule = await import('../../../src/rng/rng-streams');

      expect(Math.random).toBe(before);
      expectMathRandomUnpatched();

      const fresh = freshModule.createRngStreams(GUARD_SEED);

      expect(
        drawSequence(fresh.stream(DERIVED_STREAM), SEQUENCE_LENGTH)
      ).toEqual(
        drawSequence(
          createRngStreams(GUARD_SEED).stream(DERIVED_STREAM),
          SEQUENCE_LENGTH
        )
      );
      expectMathRandomUnpatched();
    });

  it('holds the reference the fixture captured before every import', () => {
    expect(originalMathRandom).toBe(PLATFORM_MATH_RANDOM);
    expect(Math.random).toBe(PLATFORM_MATH_RANDOM);
  });
});

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


describe('Math.random is still the platform built-in', () => {
  it('holds the exact function the property was found carrying', () => {
    const current = Object.getOwnPropertyDescriptor(Math, 'random');

    expect(current?.value).toBe(originalMathRandom);
    expect(Math.random).toBe(originalMathRandom);
  });

  it('keeps the property attributes it was installed under', () => {
    const current = Object.getOwnPropertyDescriptor(Math, 'random');

    expect(PLATFORM_MATH_RANDOM_DESCRIPTOR).toBeDefined();
    expect(current).toStrictEqual(PLATFORM_MATH_RANDOM_DESCRIPTOR);
    expect(current?.get).toBeUndefined();
    expect(current?.set).toBeUndefined();
  });

  it('exposes Math.random as a function declaring no parameters', () => {
    expect(typeof Math.random).toBe('function');
    expect(Math.random.length).toBe(0);
  });


  it('draws a float inside the interval the two call sites assumed', () => {
    const drawn = Math.random();

    expect(Number.isFinite(drawn)).toBe(true);
    expect(drawn).toBeGreaterThanOrEqual(0);
    expect(drawn).toBeLessThan(1);
  });
});

// Registered at file scope: runs once, after every case above.
afterAll(() => {
  expectMathRandomUnpatched();
});
