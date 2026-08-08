// Unit suite over src/rng/rng-streams.ts, the named-substream layer.
//
// The contracts asserted here: one run seed fanned into four named substreams
// that advance independently, and that a substream restored from a recorded
// cursor continues the same sequence. `RngCursorMap` is the shape the run state
// persists as its `rngCursor` field.
//
// The two audited randomness call sites of the deleted vanilla sources, both
// pinned by this suite: the spawn value draw, `< 0.9 ? 2 : 4` on a strict
// less-than, now `RngStream.pickWeighted` over the spawn distribution of the
// rules config; and the spawn position draw, `cells[Math.floor(u *
// cells.length)]`, now `RngStream.nextInt`, with `RngStream.pick` over the same
// array. `randomAvailableCell()` guarded on `cells.length` and carried no else
// branch, so a full board yielded `undefined`; `availableCells()` collected
// `{x, y}` through `eachCell`, x-outer and y-inner.
//
// Every expectation below is either relational — identical seeds give identical
// sequences, a restored substream continues in lockstep, one substream's draws
// leave the others untouched — or a range or shape check. The derived helpers
// are cross-checked against `next()` on paired same-seed substreams. No
// generator output appears as a literal anywhere in this file. Every seed is a
// literal declared here, and this suite reads no clock, no environment and no
// document.
//
// Decisions of docs/DECISION_LOG.md this suite is the evidence for, one apiece:
// DL-RNG-04, DL-RNG-05.
// Rows of docs/TRACEABILITY_MATRIX.md it covers, one apiece: TR-RNG-06,
// TR-RNG-07, TR-RNG-08, TR-RNG-09.

import { describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import {
  MAX_RNG_CURSOR,
  MAX_RUN_SEED_LENGTH,
  RNG_STREAM_NAMES,
  createRngStreams,
  isAcceptableRunSeed,
  type RngCursorMap,
  type RngRejection,
  type RngReporter,
  type RngStream,
  type RngStreams,
  type StreamName,
} from '../../../src/rng/rng-streams';
import { MAX_RNG_SEED_LENGTH } from '../../../src/rng/seeded-rng';

const RUN_SEED = 'blitzy-2048-run-alpha';

const OTHER_RUN_SEED = 'blitzy-2048-run-beta';

const SPAWN_VALUE = 'spawn-value';
const SPAWN_POSITION = 'spawn-position';
const RELIC_DRAW = 'relic-draw';
const RARITY_WEIGHT = 'rarity-weight';

const SEQUENCE_LENGTH = 12;

const CONTINUATION_LENGTH = 8;

const INDEPENDENCE_LENGTH = 20;

const SAMPLE_SIZE = 300;

const CROSS_CHECK_SIZE = 500;

const DISTRIBUTION_SIZE = 1000;

const BOARD_CELL_COUNT = 16;

const BOARD_SIZE = 4;

const DISTINCT_DRAW_COUNTS: RngCursorMap = {
  'spawn-value': 3,
  'spawn-position': 5,
  'relic-draw': 2,
  'rarity-weight': 7,
};

const PARTIAL_RESTORE_CURSOR = 5;

interface Cell {
  x: number;
  y: number;
}

/**
 * Candidates for the weighted walk, distinct from the spawn distribution. Three
 * of them, so the walk's middle branch is reached.
 */
const UNEVEN_CANDIDATES: readonly string[] = ['common', 'rare', 'legendary'];

/**
 * Weights of `UNEVEN_CANDIDATES`. They total 8, so a selection that read the raw
 * draw without scaling it by the total would not match.
 */
const UNEVEN_WEIGHTS: readonly number[] = [5, 2, 1];

/**
 * Resolves one raw draw to a candidate through the walk
 * src/rng/rng-streams.ts performs: scale the draw by the total weight, then
 * take the first index whose running total passes it, falling back to the last
 * candidate.
 *
 * @param raw Draw in [0, 1), as `next()` returns it.
 * @param items Candidates, in index order.
 * @param weights Weight of each candidate, in the same order.
 * @returns The candidate that draw selects.
 */
function candidateForDraw(
  raw: number,
  items: readonly string[],
  weights: readonly number[]
): string {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const target = raw * total;
  let running = 0;

  for (let index = 0; index < weights.length; index += 1) {
    running += weights[index];

    if (running > target) {
      return items[index];
    }
  }

  return items[items.length - 1];
}

/* ===== 2. Local helpers ===== */

/**
 * Takes `count` draws from `stream` and returns them in draw order.
 *
 * @param stream Substream to draw from.
 * @param count Number of draws to take.
 * @returns The draws, in order.
 */
function draw(stream: RngStream, count: number): number[] {
  const drawn: number[] = [];

  for (let taken = 0; taken < count; taken += 1) {
    drawn.push(stream.next());
  }

  return drawn;
}

function drawFrom(
  streams: RngStreams,
  name: StreamName,
  count: number
): number[] {
  return draw(streams.stream(name), count);
}

function reference(
  name: StreamName,
  count: number,
  seed: string = RUN_SEED
): number[] {
  return drawFrom(createRngStreams(seed), name, count);
}

function selected<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('A selection was expected but none was returned.');
  }

  return value;
}

function availableCells(size: number): Cell[] {
  const cells: Cell[] = [];

  for (let x = 0; x < size; x += 1) {
    for (let y = 0; y < size; y += 1) {
      cells.push({ x, y });
    }
  }

  return cells;
}

function applyDrawCounts(streams: RngStreams, counts: RngCursorMap): void {
  for (const name of RNG_STREAM_NAMES) {
    draw(streams.stream(name), counts[name]);
  }
}

describe('RNG_STREAM_NAMES', () => {
  it('lists the four substream names in order', () => {
    expect(RNG_STREAM_NAMES).toEqual([
      'spawn-value',
      'spawn-position',
      'relic-draw',
      'rarity-weight',
    ]);
  });

  it('lists exactly four names, none of them repeated', () => {
    expect(RNG_STREAM_NAMES).toHaveLength(4);
    expect(new Set(RNG_STREAM_NAMES).size).toBe(4);
  });

  it('is frozen at run time, not only readonly at compile time', () => {
    expect(Object.isFrozen(RNG_STREAM_NAMES)).toBe(true);
  });

  it('refuses a runtime write to an entry and keeps its contents exact', () => {
    // The cast is how a caller reaching the tuple through a widened type
    // would arrive at it; compile-time readonly does not stop that caller.
    const mutable = RNG_STREAM_NAMES as unknown as string[];

    expect(() => {
      mutable[0] = 'tampered';
    }).toThrow(TypeError);
    expect(() => {
      mutable[RNG_STREAM_NAMES.length] = 'fifth';
    }).toThrow(TypeError);
    expect([...RNG_STREAM_NAMES]).toEqual([
      'spawn-value',
      'spawn-position',
      'relic-draw',
      'rarity-weight',
    ]);
  });

  it('refuses a runtime push, pop, splice, sort, reverse and length ' +
    'change', () => {
    const mutable = RNG_STREAM_NAMES as unknown as string[];

    expect(() => {
      mutable.push('fifth');
    }).toThrow(TypeError);
    expect(() => {
      mutable.pop();
    }).toThrow(TypeError);
    expect(() => {
      mutable.splice(0, 1);
    }).toThrow(TypeError);
    expect(() => {
      mutable.sort();
    }).toThrow(TypeError);
    expect(() => {
      mutable.reverse();
    }).toThrow(TypeError);
    expect(() => {
      mutable.length = 0;
    }).toThrow(TypeError);
    expect(RNG_STREAM_NAMES).toHaveLength(4);
    expect([...RNG_STREAM_NAMES]).toEqual([
      'spawn-value',
      'spawn-position',
      'relic-draw',
      'rarity-weight',
    ]);
  });

  it('keeps deriving the same four substreams after a refused mutation ' +
    'attempt', () => {
    const mutable = RNG_STREAM_NAMES as unknown as string[];
    const reference = createRngStreams(RUN_SEED);
    const expected = reference.stream(SPAWN_VALUE).next();

    try {
      mutable[0] = 'tampered';
    } catch {
      // Refused, which is the point; the derivation below is what it
      // protects.
    }

    expect(createRngStreams(RUN_SEED).stream(SPAWN_VALUE).next()).toBe(
      expected,
    );
    expect(
      Object.keys(createRngStreams(RUN_SEED).snapshotCursors()).sort(),
    ).toEqual(['rarity-weight', 'relic-draw', 'spawn-position', 'spawn-value']);
  });

  it('addresses the names this suite draws through', () => {
    const addressed: StreamName[] = [
      SPAWN_VALUE,
      SPAWN_POSITION,
      RELIC_DRAW,
      RARITY_WEIGHT,
    ];

    expect(addressed).toEqual([...RNG_STREAM_NAMES]);
  });

  it('resolves a substream reporting its own name for every entry', () => {
    const streams = createRngStreams(RUN_SEED);

    for (const name of RNG_STREAM_NAMES) {
      const stream = streams.stream(name);

      expect(stream).toBeDefined();
      expect(stream.name).toBe(name);
    }
  });
});

describe('createRngStreams — shape and substream identity', () => {
  it('echoes the run seed it was created from', () => {
    expect(createRngStreams(RUN_SEED).seed).toBe(RUN_SEED);
    expect(createRngStreams(OTHER_RUN_SEED).seed).toBe(OTHER_RUN_SEED);
  });

  it('returns one stable instance per name on repeated lookups', () => {
    const streams = createRngStreams(RUN_SEED);

    for (const name of RNG_STREAM_NAMES) {
      expect(streams.stream(name)).toBe(streams.stream(name));
    }
  });

  it('continues the sequence across separate stream() lookups', () => {
    const streams = createRngStreams(RUN_SEED);
    const perLookup = [
      streams.stream(SPAWN_VALUE).next(),
      streams.stream(SPAWN_VALUE).next(),
      streams.stream(SPAWN_VALUE).next(),
    ];
    const untouched = reference(SPAWN_VALUE, perLookup.length);

    // Whole-sequence equality is the contract: three draws taken through three
    // separate lookups are the first three draws of the substream. Whether two
    // neighbouring draws happen to differ is not something the generator
    // promises, so nothing here asserts it.
    expect(perLookup).toEqual(untouched);
    expect(perLookup).toHaveLength(3);
    expect(streams.stream(SPAWN_VALUE).cursor).toBe(perLookup.length);
  });

  it('reports an advance made through one reference on every other', () => {
    const streams = createRngStreams(RUN_SEED);
    const held = streams.stream(SPAWN_POSITION);

    expect(held.cursor).toBe(0);

    streams.stream(SPAWN_POSITION).next();

    expect(held.cursor).toBe(1);
    expect(streams.stream(SPAWN_POSITION).cursor).toBe(1);
  });
});

describe('per-substream determinism', () => {
  it('repeats every substream sequence for the same run seed', () => {
    const first = createRngStreams(RUN_SEED);
    const second = createRngStreams(RUN_SEED);

    for (const name of RNG_STREAM_NAMES) {
      expect(drawFrom(first, name, SEQUENCE_LENGTH)).toEqual(
        drawFrom(second, name, SEQUENCE_LENGTH)
      );
    }
  });

  it('gives each of the four substreams a distinct sequence', () => {
    const streams = createRngStreams(RUN_SEED);
    const sequences = RNG_STREAM_NAMES.map((name) =>
      drawFrom(streams, name, SEQUENCE_LENGTH)
    );

    for (let left = 0; left < sequences.length; left += 1) {
      for (let right = left + 1; right < sequences.length; right += 1) {
        expect(sequences[left]).not.toEqual(sequences[right]);
      }
    }
  });

  it('gives two run seeds different sequences in every substream', () => {
    for (const name of RNG_STREAM_NAMES) {
      expect(reference(name, SEQUENCE_LENGTH, RUN_SEED)).not.toEqual(
        reference(name, SEQUENCE_LENGTH, OTHER_RUN_SEED)
      );
    }
  });

  it('starts every substream at cursor 0 and counts one per draw', () => {
    const streams = createRngStreams(RUN_SEED);

    for (const name of RNG_STREAM_NAMES) {
      const stream = streams.stream(name);

      expect(stream.cursor).toBe(0);
      draw(stream, SEQUENCE_LENGTH);
      expect(stream.cursor).toBe(SEQUENCE_LENGTH);
    }
  });

  it('draws inside the half-open unit interval', () => {
    const stream = createRngStreams(RUN_SEED).stream(SPAWN_VALUE);

    for (const observed of draw(stream, DISTRIBUTION_SIZE)) {
      expect(observed).toBeGreaterThanOrEqual(0);
      expect(observed).toBeLessThan(1);
    }
  });
});

describe('substream independence', () => {
  it.each([1, 3, 17])(
    'leaves the spawn substreams untouched by %i relic-side draws',
    (perturbation) => {
      const baselinePosition = reference(
        SPAWN_POSITION,
        INDEPENDENCE_LENGTH
      );
      const baselineValue = reference(SPAWN_VALUE, INDEPENDENCE_LENGTH);

      const perturbed = createRngStreams(RUN_SEED);
      draw(perturbed.stream(RELIC_DRAW), perturbation);
      draw(perturbed.stream(RARITY_WEIGHT), perturbation);
      expect(perturbed.stream(SPAWN_POSITION).cursor).toBe(0);
      expect(perturbed.stream(SPAWN_VALUE).cursor).toBe(0);
      expect(
        drawFrom(perturbed, SPAWN_POSITION, INDEPENDENCE_LENGTH)
      ).toEqual(baselinePosition);
      expect(drawFrom(perturbed, SPAWN_VALUE, INDEPENDENCE_LENGTH)).toEqual(
        baselineValue
      );
    }
  );

  it.each([1, 3, 17])(
    'leaves the relic substreams untouched by %i spawn-side draws',
    (perturbation) => {
      const baselineRelic = reference(RELIC_DRAW, INDEPENDENCE_LENGTH);
      const baselineRarity = reference(RARITY_WEIGHT, INDEPENDENCE_LENGTH);

      const perturbed = createRngStreams(RUN_SEED);
      draw(perturbed.stream(SPAWN_POSITION), perturbation);
      draw(perturbed.stream(SPAWN_VALUE), perturbation);
      expect(perturbed.stream(RELIC_DRAW).cursor).toBe(0);
      expect(perturbed.stream(RARITY_WEIGHT).cursor).toBe(0);
      expect(drawFrom(perturbed, RELIC_DRAW, INDEPENDENCE_LENGTH)).toEqual(
        baselineRelic
      );
      expect(
        drawFrom(perturbed, RARITY_WEIGHT, INDEPENDENCE_LENGTH)
      ).toEqual(baselineRarity);
    }
  );

  it('holds when the relic substream is consumed through nextInt', () => {
    const baseline = reference(SPAWN_POSITION, INDEPENDENCE_LENGTH);
    const perturbed = createRngStreams(RUN_SEED);
    const relic = perturbed.stream(RELIC_DRAW);

    for (let taken = 0; taken < INDEPENDENCE_LENGTH; taken += 1) {
      relic.nextInt(BOARD_CELL_COUNT);
    }

    expect(relic.cursor).toBe(INDEPENDENCE_LENGTH);
    expect(perturbed.stream(SPAWN_POSITION).cursor).toBe(0);
    expect(drawFrom(perturbed, SPAWN_POSITION, INDEPENDENCE_LENGTH)).toEqual(
      baseline
    );
  });

  it('holds when the relic substream is consumed through pick', () => {
    const baseline = reference(SPAWN_POSITION, INDEPENDENCE_LENGTH);
    const perturbed = createRngStreams(RUN_SEED);
    const relic = perturbed.stream(RELIC_DRAW);
    const cells = availableCells(BOARD_SIZE);

    for (let taken = 0; taken < INDEPENDENCE_LENGTH; taken += 1) {
      relic.pick(cells);
    }

    expect(relic.cursor).toBe(INDEPENDENCE_LENGTH);
    expect(perturbed.stream(SPAWN_POSITION).cursor).toBe(0);
    expect(drawFrom(perturbed, SPAWN_POSITION, INDEPENDENCE_LENGTH)).toEqual(
      baseline
    );
  });

  it('holds when the relic substream is consumed through pickWeighted', () => {
    const baseline = reference(SPAWN_POSITION, INDEPENDENCE_LENGTH);
    const { spawn } = createDefaultRulesConfig();
    const perturbed = createRngStreams(RUN_SEED);
    const relic = perturbed.stream(RELIC_DRAW);

    for (let taken = 0; taken < INDEPENDENCE_LENGTH; taken += 1) {
      relic.pickWeighted(spawn.values, spawn.weights);
    }

    expect(relic.cursor).toBe(INDEPENDENCE_LENGTH);
    expect(perturbed.stream(SPAWN_POSITION).cursor).toBe(0);
    expect(drawFrom(perturbed, SPAWN_POSITION, INDEPENDENCE_LENGTH)).toEqual(
      baseline
    );
  });
});

describe('snapshotCursors', () => {
  it('carries every substream name, at 0, before any draw', () => {
    const snapshot = createRngStreams(RUN_SEED).snapshotCursors();
    const keys: string[] = Object.keys(snapshot);
    const names: string[] = [...RNG_STREAM_NAMES];

    expect(keys.slice().sort()).toEqual(names.slice().sort());

    for (const name of RNG_STREAM_NAMES) {
      expect(snapshot[name]).toBe(0);
    }
  });

  it('reports the draw count each substream actually took', () => {
    const streams = createRngStreams(RUN_SEED);

    applyDrawCounts(streams, DISTINCT_DRAW_COUNTS);
    expect(streams.snapshotCursors()).toEqual(DISTINCT_DRAW_COUNTS);
  });

  it('returns a value rather than a live view of the cursors', () => {
    const streams = createRngStreams(RUN_SEED);
    const captured = streams.snapshotCursors();

    applyDrawCounts(streams, DISTINCT_DRAW_COUNTS);

    for (const name of RNG_STREAM_NAMES) {
      expect(captured[name]).toBe(0);
    }

    expect(streams.snapshotCursors()).toEqual(DISTINCT_DRAW_COUNTS);
  });

  it('is unaffected by a caller mutating an earlier snapshot', () => {
    const streams = createRngStreams(RUN_SEED);
    const mutated = streams.snapshotCursors();

    mutated[SPAWN_VALUE] = DISTRIBUTION_SIZE;
    mutated[RELIC_DRAW] = DISTRIBUTION_SIZE;

    const taken = streams.snapshotCursors();

    for (const name of RNG_STREAM_NAMES) {
      expect(taken[name]).toBe(0);
    }
  });

  it('consumes no draw of its own', () => {
    const streams = createRngStreams(RUN_SEED);
    const stream = streams.stream(SPAWN_POSITION);
    const observed: number[] = [];

    for (let taken = 0; taken < SEQUENCE_LENGTH; taken += 1) {
      streams.snapshotCursors();
      observed.push(stream.next());
      streams.snapshotCursors();
    }

    expect(observed).toEqual(reference(SPAWN_POSITION, SEQUENCE_LENGTH));
    expect(stream.cursor).toBe(SEQUENCE_LENGTH);
  });
});

describe('createRngStreams — restore from recorded cursors', () => {
  it('continues every substream in lockstep with the run it came from', () => {
    const original = createRngStreams(RUN_SEED);

    applyDrawCounts(original, DISTINCT_DRAW_COUNTS);

    const restored = createRngStreams(RUN_SEED, original.snapshotCursors());

    for (const name of RNG_STREAM_NAMES) {
      expect(drawFrom(restored, name, CONTINUATION_LENGTH)).toEqual(
        drawFrom(original, name, CONTINUATION_LENGTH)
      );
    }
  });

  it('reports the cursor map it was restored from', () => {
    const restored = createRngStreams(RUN_SEED, DISTINCT_DRAW_COUNTS);

    expect(restored.snapshotCursors()).toEqual(DISTINCT_DRAW_COUNTS);
  });

  it('positions only the substreams a partial map records', () => {
    const restored = createRngStreams(RUN_SEED, {
      [RELIC_DRAW]: PARTIAL_RESTORE_CURSOR,
    });
    const cursors = restored.snapshotCursors();

    expect(cursors[RELIC_DRAW]).toBe(PARTIAL_RESTORE_CURSOR);
    expect(cursors[SPAWN_VALUE]).toBe(0);
    expect(cursors[SPAWN_POSITION]).toBe(0);
    expect(cursors[RARITY_WEIGHT]).toBe(0);

    const whole = reference(
      RELIC_DRAW,
      PARTIAL_RESTORE_CURSOR + CONTINUATION_LENGTH
    );

    expect(drawFrom(restored, RELIC_DRAW, CONTINUATION_LENGTH)).toEqual(
      whole.slice(PARTIAL_RESTORE_CURSOR)
    );
  });

  it('starts the substreams a partial map omits from the beginning', () => {
    const restored = createRngStreams(RUN_SEED, {
      [RELIC_DRAW]: PARTIAL_RESTORE_CURSOR,
    });
    const omitted: StreamName[] = [
      SPAWN_VALUE,
      SPAWN_POSITION,
      RARITY_WEIGHT,
    ];

    for (const name of omitted) {
      expect(drawFrom(restored, name, CONTINUATION_LENGTH)).toEqual(
        reference(name, CONTINUATION_LENGTH)
      );
    }
  });

  it('treats an empty cursor map as a fresh start', () => {
    const fromEmpty = createRngStreams(RUN_SEED, {});
    const fromNothing = createRngStreams(RUN_SEED);

    expect(fromEmpty.snapshotCursors()).toEqual(
      fromNothing.snapshotCursors()
    );

    for (const name of RNG_STREAM_NAMES) {
      expect(drawFrom(fromEmpty, name, SEQUENCE_LENGTH)).toEqual(
        drawFrom(fromNothing, name, SEQUENCE_LENGTH)
      );
    }
  });

  it('round-trips a snapshot taken after a restore', () => {
    const original = createRngStreams(RUN_SEED);

    applyDrawCounts(original, DISTINCT_DRAW_COUNTS);

    const once = createRngStreams(RUN_SEED, original.snapshotCursors());
    const twice = createRngStreams(RUN_SEED, once.snapshotCursors());

    expect(twice.snapshotCursors()).toEqual(original.snapshotCursors());

    for (const name of RNG_STREAM_NAMES) {
      expect(drawFrom(twice, name, CONTINUATION_LENGTH)).toEqual(
        drawFrom(original, name, CONTINUATION_LENGTH)
      );
    }
  });
});

describe('RngStream.nextInt — replaces js/grid.js L41', () => {
  it.each([1, 2, BOARD_SIZE, BOARD_CELL_COUNT])(
    'yields an integer in [0, %i) across a deterministic sample',
    (maxExclusive) => {
      const stream = createRngStreams(RUN_SEED).stream(SPAWN_POSITION);

      for (let taken = 0; taken < SAMPLE_SIZE; taken += 1) {
        const index = stream.nextInt(maxExclusive);

        expect(Number.isInteger(index)).toBe(true);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(maxExclusive);
      }
    }
  );

  it('yields 0 for the only index a single-cell bound admits', () => {
    const stream = createRngStreams(RUN_SEED).stream(SPAWN_POSITION);

    for (let taken = 0; taken < SAMPLE_SIZE; taken += 1) {
      expect(stream.nextInt(1)).toBe(0);
    }
  });

  it('repeats its index sequence for the same run seed', () => {
    const first = createRngStreams(RUN_SEED).stream(SPAWN_POSITION);
    const second = createRngStreams(RUN_SEED).stream(SPAWN_POSITION);
    const fromFirst: number[] = [];
    const fromSecond: number[] = [];

    for (let taken = 0; taken < SAMPLE_SIZE; taken += 1) {
      fromFirst.push(first.nextInt(BOARD_CELL_COUNT));
      fromSecond.push(second.nextInt(BOARD_CELL_COUNT));
    }

    expect(fromFirst).toEqual(fromSecond);
  });

  // The arithmetic of js/grid.js L41, asserted draw by draw: every index is
  // the floor of that draw scaled by the bound. A paired substream of the same
  // seed supplies the raw draws, so the whole index list is an exact
  // expectation rather than a property of a sample.
  it('floors each raw draw scaled by the bound, index for index', () => {
    const indexing = createRngStreams(RUN_SEED).stream(SPAWN_POSITION);
    const raw = createRngStreams(RUN_SEED).stream(SPAWN_POSITION);
    const produced: number[] = [];
    const expected: number[] = [];

    for (let taken = 0; taken < CROSS_CHECK_SIZE; taken += 1) {
      produced.push(indexing.nextInt(BOARD_CELL_COUNT));
      expected.push(Math.floor(raw.next() * BOARD_CELL_COUNT));
    }

    expect(produced).toEqual(expected);
    expect(indexing.cursor).toBe(CROSS_CHECK_SIZE);
    expect(raw.cursor).toBe(indexing.cursor);
  });

  it('advances the cursor on a call inside its domain', () => {
    const stream = createRngStreams(RUN_SEED).stream(SPAWN_POSITION);
    const before = stream.cursor;

    stream.nextInt(BOARD_CELL_COUNT);

    expect(stream.cursor).toBeGreaterThan(before);
  });

  it('reaches the same cursor for the same sequence of calls', () => {
    const first = createRngStreams(RUN_SEED).stream(SPAWN_POSITION);
    const second = createRngStreams(RUN_SEED).stream(SPAWN_POSITION);

    for (let taken = 0; taken < SAMPLE_SIZE; taken += 1) {
      first.nextInt(BOARD_CELL_COUNT);
      second.nextInt(BOARD_CELL_COUNT);
    }

    expect(first.cursor).toBe(second.cursor);
  });

  it('yields 0 and consumes nothing for an empty index domain', () => {
    const stream = createRngStreams(RUN_SEED).stream(SPAWN_POSITION);
    const before = stream.cursor;

    expect(() => stream.nextInt(0)).not.toThrow();
    expect(stream.nextInt(0)).toBe(0);
    expect(stream.cursor).toBe(before);
  });

  it('cannot desynchronise a later draw through an empty domain', () => {
    const stream = createRngStreams(RUN_SEED).stream(SPAWN_POSITION);

    for (let attempt = 0; attempt < SEQUENCE_LENGTH; attempt += 1) {
      stream.nextInt(0);
    }

    expect(draw(stream, SEQUENCE_LENGTH)).toEqual(
      reference(SPAWN_POSITION, SEQUENCE_LENGTH)
    );
  });
});

describe('RngStream.pick — replaces js/grid.js L37-L43', () => {
  it('selects a member of the list it was given', () => {
    const stream = createRngStreams(RUN_SEED).stream(SPAWN_POSITION);
    const cells = availableCells(BOARD_SIZE);

    expect(cells).toHaveLength(BOARD_CELL_COUNT);

    for (let taken = 0; taken < SAMPLE_SIZE; taken += 1) {
      expect(cells).toContain(stream.pick(cells));
    }
  });

  it('repeats its selection sequence for the same run seed', () => {
    const cells = availableCells(BOARD_SIZE);
    const first = createRngStreams(RUN_SEED).stream(SPAWN_POSITION);
    const second = createRngStreams(RUN_SEED).stream(SPAWN_POSITION);
    const fromFirst: Cell[] = [];
    const fromSecond: Cell[] = [];

    for (let taken = 0; taken < SAMPLE_SIZE; taken += 1) {
      fromFirst.push(selected(first.pick(cells)));
      fromSecond.push(selected(second.pick(cells)));
    }

    expect(fromFirst).toEqual(fromSecond);
  });

  it('selects by index into the list in the order given', () => {
    const cells = availableCells(BOARD_SIZE);
    const selecting = createRngStreams(RUN_SEED).stream(SPAWN_POSITION);
    const indexing = createRngStreams(RUN_SEED).stream(SPAWN_POSITION);

    for (let taken = 0; taken < CROSS_CHECK_SIZE; taken += 1) {
      const cell = selected(selecting.pick(cells));
      const index = indexing.nextInt(cells.length);

      expect(cell).toBe(cells[index]);
    }
  });

  // The selected cell list is an exact expectation: each entry is the cell the
  // paired substream's raw draw indexes, through the same arithmetic
  // js/grid.js L41 applied.
  it('selects the cell each raw draw indexes, cell for cell', () => {
    const cells = availableCells(BOARD_SIZE);
    const selecting = createRngStreams(RUN_SEED).stream(SPAWN_POSITION);
    const raw = createRngStreams(RUN_SEED).stream(SPAWN_POSITION);
    const chosen: Cell[] = [];
    const expected: Cell[] = [];

    for (let taken = 0; taken < CROSS_CHECK_SIZE; taken += 1) {
      chosen.push(selected(selecting.pick(cells)));
      expected.push(cells[Math.floor(raw.next() * cells.length)]);
    }

    expect(chosen).toEqual(expected);
    expect(selecting.cursor).toBe(CROSS_CHECK_SIZE);
    expect(raw.cursor).toBe(selecting.cursor);
  });

  it('yields nothing and consumes nothing for an empty list', () => {
    const stream = createRngStreams(RUN_SEED).stream(SPAWN_POSITION);
    const before = stream.cursor;

    expect(stream.pick([])).toBeUndefined();
    expect(stream.cursor).toBe(before);
  });

  it('cannot desynchronise a later draw through an empty list', () => {
    const stream = createRngStreams(RUN_SEED).stream(SPAWN_POSITION);

    for (let attempt = 0; attempt < SEQUENCE_LENGTH; attempt += 1) {
      expect(stream.pick([])).toBeUndefined();
    }

    expect(stream.cursor).toBe(0);
    expect(draw(stream, SEQUENCE_LENGTH)).toEqual(
      reference(SPAWN_POSITION, SEQUENCE_LENGTH)
    );
  });
});

const FIRST_CANDIDATE_ONLY: readonly number[] = [1, 0];

const SECOND_CANDIDATE_ONLY: readonly number[] = [0, 1];

const SOLE_CANDIDATE_WEIGHT: readonly number[] = [1];

describe('RngStream.pickWeighted — replaces js/game_manager.js L71', () => {
  it('reads the vanilla spawn distribution from the rules config', () => {
    const { spawn } = createDefaultRulesConfig();

    expect(spawn.values).toEqual([2, 4]);
    expect(spawn.weights).toEqual([0.9, 0.1]);
  });

  it('selects only values the distribution offers', () => {
    const { spawn } = createDefaultRulesConfig();
    const stream = createRngStreams(RUN_SEED).stream(SPAWN_VALUE);

    for (let taken = 0; taken < SAMPLE_SIZE; taken += 1) {
      expect(spawn.values).toContain(
        stream.pickWeighted(spawn.values, spawn.weights)
      );
    }
  });

  it('repeats its selection sequence for the same run seed', () => {
    const { spawn } = createDefaultRulesConfig();
    const first = createRngStreams(RUN_SEED).stream(SPAWN_VALUE);
    const second = createRngStreams(RUN_SEED).stream(SPAWN_VALUE);
    const fromFirst: number[] = [];
    const fromSecond: number[] = [];

    for (let taken = 0; taken < SAMPLE_SIZE; taken += 1) {
      fromFirst.push(selected(first.pickWeighted(spawn.values, spawn.weights)));
      fromSecond.push(
        selected(second.pickWeighted(spawn.values, spawn.weights))
      );
    }

    expect(fromFirst).toEqual(fromSecond);
  });

  it('resolves the strict threshold of js/game_manager.js L71', () => {
    const { spawn } = createDefaultRulesConfig();
    const selecting = createRngStreams(RUN_SEED).stream(SPAWN_VALUE);
    const observing = createRngStreams(RUN_SEED).stream(SPAWN_VALUE);
    const chosen: number[] = [];
    const expected: number[] = [];

    for (let taken = 0; taken < CROSS_CHECK_SIZE; taken += 1) {
      chosen.push(
        selected(selecting.pickWeighted(spawn.values, spawn.weights))
      );

      expected.push(
        observing.next() < spawn.weights[0] ? spawn.values[0] : spawn.values[1]
      );
    }

    expect(chosen).toEqual(expected);
    expect(new Set(expected).size).toBe(spawn.values.length);
  });

  it('never selects a candidate whose weight is zero', () => {
    const { spawn } = createDefaultRulesConfig();
    const stream = createRngStreams(RUN_SEED).stream(SPAWN_VALUE);
    const first = new Set<number>();
    const second = new Set<number>();

    for (let taken = 0; taken < SAMPLE_SIZE; taken += 1) {
      first.add(
        selected(stream.pickWeighted(spawn.values, FIRST_CANDIDATE_ONLY))
      );
    }

    for (let taken = 0; taken < SAMPLE_SIZE; taken += 1) {
      second.add(
        selected(stream.pickWeighted(spawn.values, SECOND_CANDIDATE_ONLY))
      );
    }

    expect([...first]).toEqual([spawn.values[0]]);
    expect([...second]).toEqual([spawn.values[1]]);
  });

  it('selects the sole candidate of a single-entry distribution', () => {
    const { spawn } = createDefaultRulesConfig();
    const stream = createRngStreams(RUN_SEED).stream(SPAWN_VALUE);
    const sole = [spawn.values[0]];
    const observed = new Set<number>();

    for (let taken = 0; taken < SAMPLE_SIZE; taken += 1) {
      observed.add(
        selected(stream.pickWeighted(sole, SOLE_CANDIDATE_WEIGHT))
      );
    }

    expect([...observed]).toEqual(sole);
  });

  // The accumulating walk itself, over weights that neither total 1 nor share a
  // value: one draw is scaled by the total and the first index whose running
  // total passes it is selected. Restating that walk here makes every selection
  // an exact expectation, where counting how often each candidate came up would
  // only describe the sample.
  it('walks the running total of the weights, selection for selection', () => {
    const selecting = createRngStreams(RUN_SEED).stream(RARITY_WEIGHT);
    const raw = createRngStreams(RUN_SEED).stream(RARITY_WEIGHT);
    const chosen: string[] = [];
    const expected: string[] = [];

    for (let taken = 0; taken < DISTRIBUTION_SIZE; taken += 1) {
      chosen.push(
        selected(
          selecting.pickWeighted(UNEVEN_CANDIDATES, UNEVEN_WEIGHTS)
        )
      );
      expected.push(
        candidateForDraw(raw.next(), UNEVEN_CANDIDATES, UNEVEN_WEIGHTS)
      );
    }

    expect(chosen).toEqual(expected);
    expect(selecting.cursor).toBe(DISTRIBUTION_SIZE);
    expect(raw.cursor).toBe(selecting.cursor);

    // The walk is only exercised through all three of its branches when each
    // candidate is reached at least once in the pinned sequence.
    expect(new Set(chosen)).toStrictEqual(new Set(UNEVEN_CANDIDATES));
  });

  it('yields nothing and consumes nothing for an empty distribution', () => {
    const stream = createRngStreams(RUN_SEED).stream(SPAWN_VALUE);
    const before = stream.cursor;

    expect(stream.pickWeighted([], [])).toBeUndefined();
    expect(stream.cursor).toBe(before);
  });

  it('cannot desynchronise a later draw through an empty distribution', () => {
    const stream = createRngStreams(RUN_SEED).stream(SPAWN_VALUE);

    for (let attempt = 0; attempt < SEQUENCE_LENGTH; attempt += 1) {
      expect(stream.pickWeighted([], [])).toBeUndefined();
    }

    expect(stream.cursor).toBe(0);
    expect(draw(stream, SEQUENCE_LENGTH)).toEqual(
      reference(SPAWN_VALUE, SEQUENCE_LENGTH)
    );
  });
});

/* ===== 12. Refused run seeds and refused cursor entries ===== */

/** A recorded rejection, and the sink that collected it. */
interface RecordingRngReporter {
  /** The sink to hand to `createRngStreams`. */
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

/** A run seed of exactly the greatest permitted length. */
const LONGEST_ACCEPTED_RUN_SEED = 'r'.repeat(MAX_RUN_SEED_LENGTH);

/** A run seed one character past the greatest permitted length. */
const OVERLONG_RUN_SEED = 'r'.repeat(MAX_RUN_SEED_LENGTH + 1);

/** Cursor entries reduced to 0 because they are not a usable position. */
const UNUSABLE_CURSOR_ENTRIES: readonly { label: string; value: number }[] = [
  { label: 'a negative integer', value: -1 },
  { label: 'a fractional value', value: 2.5 },
  { label: 'NaN', value: Number.NaN },
  { label: 'Infinity', value: Number.POSITIVE_INFINITY },
  { label: '-Infinity', value: Number.NEGATIVE_INFINITY },
  { label: 'a magnitude past the safe integer range', value: 2 ** 53 },
];

/** Cursor entries reduced to 0 because they exceed the fast-forward bound. */
const OUT_OF_RANGE_CURSOR_ENTRIES: readonly {
  label: string;
  value: number;
}[] = [
  { label: 'one draw past the bound', value: MAX_RNG_CURSOR + 1 },
  { label: 'the greatest safe integer', value: Number.MAX_SAFE_INTEGER },
];

/** Cursor entries that are not numbers, as a corrupted payload carries them. */
const NON_NUMERIC_CURSOR_ENTRIES: readonly { label: string; value: unknown }[] =
  [
    { label: 'a string', value: '7' },
    { label: 'null', value: null },
    { label: 'a boolean', value: true },
    { label: 'an object', value: { cursor: 7 } },
    { label: 'an array', value: [7] },
  ];

describe('MAX_RUN_SEED_LENGTH and isAcceptableRunSeed', () => {
  it('leaves room for the longest substream suffix', () => {
    expect(Number.isSafeInteger(MAX_RUN_SEED_LENGTH)).toBe(true);
    expect(MAX_RUN_SEED_LENGTH).toBeGreaterThan(0);
    expect(MAX_RUN_SEED_LENGTH).toBeLessThan(MAX_RNG_SEED_LENGTH);

    // Every derived seed of an accepted run seed is itself within the
    // generator's own bound, which is what the smaller bound exists for.
    for (const name of RNG_STREAM_NAMES) {
      expect(
        `${LONGEST_ACCEPTED_RUN_SEED}::${name}`.length
      ).toBeLessThanOrEqual(MAX_RNG_SEED_LENGTH);
    }
  });

  it('accepts a run seed at the bound and refuses one past it', () => {
    expect(isAcceptableRunSeed(LONGEST_ACCEPTED_RUN_SEED)).toBe(true);
    expect(isAcceptableRunSeed(OVERLONG_RUN_SEED)).toBe(false);
    expect(isAcceptableRunSeed('')).toBe(true);
    expect(isAcceptableRunSeed(RUN_SEED)).toBe(true);
  });

  it('answers the same question createRngStreams throws on', () => {
    expect(() => createRngStreams(LONGEST_ACCEPTED_RUN_SEED)).not.toThrow();
    expect(() => createRngStreams(OVERLONG_RUN_SEED)).toThrow(RangeError);
  });

  it('reports an overlong run seed before it throws', () => {
    const recording = createRecordingReporter();

    expect(() =>
      createRngStreams(OVERLONG_RUN_SEED, undefined, recording.reporter)
    ).toThrow(RangeError);
    expect(recording.rejections).toStrictEqual([
      {
        kind: 'seed-too-long',
        observed: OVERLONG_RUN_SEED.length,
        maximum: MAX_RUN_SEED_LENGTH,
      },
    ]);
  });

  it('names both lengths in the error it throws', () => {
    expect(() => createRngStreams(OVERLONG_RUN_SEED)).toThrow(
      `A run seed may be at most ${String(MAX_RUN_SEED_LENGTH)} characters ` +
        `long; this one is ${String(OVERLONG_RUN_SEED.length)}.`
    );
  });

  it('still throws when the sink throws while receiving the refusal', () => {
    expect(() =>
      createRngStreams(OVERLONG_RUN_SEED, undefined, THROWING_REPORTER)
    ).toThrow(RangeError);
  });

  it('derives four working substreams from a run seed at the bound', () => {
    const streams = createRngStreams(LONGEST_ACCEPTED_RUN_SEED);

    for (const name of RNG_STREAM_NAMES) {
      expect(drawFrom(streams, name, SEQUENCE_LENGTH)).toEqual(
        reference(name, SEQUENCE_LENGTH, LONGEST_ACCEPTED_RUN_SEED)
      );
    }
  });
});

describe('createRngStreams — refused cursor entries', () => {
  it.each(UNUSABLE_CURSOR_ENTRIES)(
    'starts a substream fresh for $label and reports it as unusable',
    ({ value }: { value: number }) => {
      const recording = createRecordingReporter();
      const streams = createRngStreams(
        RUN_SEED,
        { [SPAWN_POSITION]: value },
        recording.reporter
      );

      expect(streams.snapshotCursors()[SPAWN_POSITION]).toBe(0);
      expect(recording.rejections).toStrictEqual([
        {
          kind: 'cursor-unusable',
          stream: SPAWN_POSITION,
          observed: value,
          maximum: MAX_RNG_CURSOR,
        },
      ]);
      expect(drawFrom(streams, SPAWN_POSITION, SEQUENCE_LENGTH)).toEqual(
        reference(SPAWN_POSITION, SEQUENCE_LENGTH)
      );
    }
  );

  it.each(OUT_OF_RANGE_CURSOR_ENTRIES)(
    'starts a substream fresh for $label and reports it as out of range',
    ({ value }: { value: number }) => {
      const recording = createRecordingReporter();
      const streams = createRngStreams(
        RUN_SEED,
        { [RELIC_DRAW]: value },
        recording.reporter
      );

      expect(streams.snapshotCursors()[RELIC_DRAW]).toBe(0);
      expect(recording.rejections).toStrictEqual([
        {
          kind: 'cursor-out-of-range',
          stream: RELIC_DRAW,
          observed: value,
          maximum: MAX_RNG_CURSOR,
        },
      ]);
      expect(drawFrom(streams, RELIC_DRAW, SEQUENCE_LENGTH)).toEqual(
        reference(RELIC_DRAW, SEQUENCE_LENGTH)
      );
    }
  );

  it.each(NON_NUMERIC_CURSOR_ENTRIES)(
    'reports $label as unusable with no measurement to carry',
    ({ value }: { value: unknown }) => {
      const recording = createRecordingReporter();
      const cursors = {
        [RARITY_WEIGHT]: value,
      } as unknown as Partial<RngCursorMap>;
      const streams = createRngStreams(RUN_SEED, cursors, recording.reporter);

      expect(streams.snapshotCursors()[RARITY_WEIGHT]).toBe(0);
      expect(recording.rejections).toHaveLength(1);
      expect(recording.rejections[0].kind).toBe('cursor-unusable');
      expect(recording.rejections[0].stream).toBe(RARITY_WEIGHT);
      expect(recording.rejections[0].observed).toBeNaN();
      expect(recording.rejections[0].maximum).toBe(MAX_RNG_CURSOR);
    }
  );

  it('reports one refusal per refused entry, naming each substream', () => {
    const recording = createRecordingReporter();
    const cursors = {
      [SPAWN_VALUE]: -1,
      [SPAWN_POSITION]: MAX_RNG_CURSOR + 1,
      [RELIC_DRAW]: PARTIAL_RESTORE_CURSOR,
      [RARITY_WEIGHT]: Number.NaN,
    };
    const streams = createRngStreams(RUN_SEED, cursors, recording.reporter);

    expect(recording.rejections.map((rejection) => rejection.stream)).toEqual([
      SPAWN_VALUE,
      SPAWN_POSITION,
      RARITY_WEIGHT,
    ]);
    expect(recording.rejections.map((rejection) => rejection.kind)).toEqual([
      'cursor-unusable',
      'cursor-out-of-range',
      'cursor-unusable',
    ]);
    expect(streams.snapshotCursors()).toEqual({
      [SPAWN_VALUE]: 0,
      [SPAWN_POSITION]: 0,
      [RELIC_DRAW]: PARTIAL_RESTORE_CURSOR,
      [RARITY_WEIGHT]: 0,
    });
  });

  it('leaves the other substreams unshifted by one refused entry', () => {
    const streams = createRngStreams(RUN_SEED, {
      [SPAWN_VALUE]: -5,
    });

    for (const name of RNG_STREAM_NAMES) {
      expect(drawFrom(streams, name, SEQUENCE_LENGTH)).toEqual(
        reference(name, SEQUENCE_LENGTH)
      );
    }
  });

  it('ignores a key that is not a substream name', () => {
    const recording = createRecordingReporter();
    const cursors = {
      [SPAWN_VALUE]: PARTIAL_RESTORE_CURSOR,
      'spawn-values': 99,
      '': 99,
    } as unknown as Partial<RngCursorMap>;
    const streams = createRngStreams(RUN_SEED, cursors, recording.reporter);

    expect(recording.rejections).toStrictEqual([]);
    expect(streams.snapshotCursors()).toEqual({
      [SPAWN_VALUE]: PARTIAL_RESTORE_CURSOR,
      [SPAWN_POSITION]: 0,
      [RELIC_DRAW]: 0,
      [RARITY_WEIGHT]: 0,
    });
  });

  it('reports nothing for a cursor map it accepted whole', () => {
    const recording = createRecordingReporter();
    const streams = createRngStreams(
      RUN_SEED,
      DISTINCT_DRAW_COUNTS,
      recording.reporter
    );

    expect(recording.rejections).toStrictEqual([]);
    expect(streams.snapshotCursors()).toEqual(DISTINCT_DRAW_COUNTS);
  });

  it('accepts the fast-forward bound itself as a recorded position', () => {
    const recording = createRecordingReporter();
    const streams = createRngStreams(
      RUN_SEED,
      { [RELIC_DRAW]: MAX_RNG_CURSOR },
      recording.reporter
    );

    expect(recording.rejections).toStrictEqual([]);
    expect(streams.snapshotCursors()[RELIC_DRAW]).toBe(MAX_RNG_CURSOR);
  });

  it('contains a sink that throws while receiving a cursor refusal', () => {
    const streams = createRngStreams(
      RUN_SEED,
      { [SPAWN_VALUE]: -1 },
      THROWING_REPORTER
    );

    expect(streams.snapshotCursors()[SPAWN_VALUE]).toBe(0);
    expect(drawFrom(streams, SPAWN_VALUE, SEQUENCE_LENGTH)).toEqual(
      reference(SPAWN_VALUE, SEQUENCE_LENGTH)
    );
  });

  it('accepts a sink declaring no member at all', () => {
    const streams = createRngStreams(RUN_SEED, { [SPAWN_VALUE]: -1 }, {});

    expect(streams.snapshotCursors()[SPAWN_VALUE]).toBe(0);
  });
});

/* ===== 13. Bounds the selecting primitives decline ===== */

/** `nextInt` bounds outside its domain, each yielding 0 and no draw. */
const EMPTY_INDEX_DOMAINS: readonly { label: string; value: number }[] = [
  { label: 'zero', value: 0 },
  { label: 'a negative bound', value: -1 },
  { label: 'a negative fractional bound', value: -0.5 },
  { label: 'NaN', value: Number.NaN },
  { label: 'Infinity', value: Number.POSITIVE_INFINITY },
  { label: '-Infinity', value: Number.NEGATIVE_INFINITY },
];

/** Weight lists no selection can be made from, each yielding no draw. */
const UNUSABLE_WEIGHTS: readonly { label: string; weights: number[] }[] = [
  { label: 'one weight too few', weights: [1] },
  { label: 'one weight too many', weights: [1, 1, 1] },
  { label: 'no weight at all', weights: [] },
  { label: 'a negative weight', weights: [-1, 2] },
  { label: 'a negative weight in second place', weights: [2, -1] },
  { label: 'NaN', weights: [Number.NaN, 1] },
  { label: 'Infinity', weights: [Number.POSITIVE_INFINITY, 1] },
  { label: '-Infinity', weights: [Number.NEGATIVE_INFINITY, 1] },
  { label: 'weights totalling zero', weights: [0, 0] },
  { label: 'a total that overflows to Infinity', weights: [1.5e308, 1.5e308] },
];

describe('RngStream.nextInt declines a bound outside its domain', () => {
  it.each(EMPTY_INDEX_DOMAINS)(
    'yields 0 and consumes nothing for $label',
    ({ value }: { value: number }) => {
      const stream = createRngStreams(RUN_SEED).stream(SPAWN_POSITION);

      expect(stream.nextInt(value)).toBe(0);
      expect(stream.cursor).toBe(0);
    }
  );

  it('cannot shift a later draw through any declined bound', () => {
    const stream = createRngStreams(RUN_SEED).stream(SPAWN_POSITION);

    for (const { value } of EMPTY_INDEX_DOMAINS) {
      expect(stream.nextInt(value)).toBe(0);
    }

    expect(stream.cursor).toBe(0);
    expect(draw(stream, SEQUENCE_LENGTH)).toEqual(
      reference(SPAWN_POSITION, SEQUENCE_LENGTH)
    );
  });

  it('draws for a fractional bound above zero, which is in its domain', () => {
    const stream = createRngStreams(RUN_SEED).stream(SPAWN_POSITION);
    const raw = createRngStreams(RUN_SEED).stream(SPAWN_POSITION);

    expect(stream.nextInt(1.5)).toBe(Math.floor(raw.next() * 1.5));
    expect(stream.cursor).toBe(1);
  });
});

describe('RngStream.pickWeighted declines an unreadable distribution', () => {
  it.each(UNUSABLE_WEIGHTS)(
    'yields nothing and consumes nothing for $label',
    ({ weights }: { weights: number[] }) => {
      const { spawn } = createDefaultRulesConfig();
      const stream = createRngStreams(RUN_SEED).stream(SPAWN_VALUE);

      expect(stream.pickWeighted(spawn.values, weights)).toBeUndefined();
      expect(stream.cursor).toBe(0);
    }
  );

  it('cannot shift a later draw through any declined distribution', () => {
    const { spawn } = createDefaultRulesConfig();
    const stream = createRngStreams(RUN_SEED).stream(SPAWN_VALUE);

    for (const { weights } of UNUSABLE_WEIGHTS) {
      expect(stream.pickWeighted(spawn.values, weights)).toBeUndefined();
    }

    expect(stream.cursor).toBe(0);
    expect(draw(stream, SEQUENCE_LENGTH)).toEqual(
      reference(SPAWN_VALUE, SEQUENCE_LENGTH)
    );
  });

  it('declines an empty candidate list however its weights read', () => {
    const stream = createRngStreams(RUN_SEED).stream(SPAWN_VALUE);

    expect(stream.pickWeighted([], [])).toBeUndefined();
    expect(stream.pickWeighted([], [1])).toBeUndefined();
    expect(stream.cursor).toBe(0);
  });

  it('selects from a distribution whose weights total more than one', () => {
    const stream = createRngStreams(RUN_SEED).stream(RARITY_WEIGHT);

    expect(UNEVEN_CANDIDATES).toContain(
      selected(stream.pickWeighted(UNEVEN_CANDIDATES, UNEVEN_WEIGHTS))
    );
    expect(stream.cursor).toBe(1);
  });

  it('never selects a candidate whose weight is zero in a longer list', () => {
    const stream = createRngStreams(RUN_SEED).stream(RARITY_WEIGHT);
    const observed = new Set<string>();

    for (let taken = 0; taken < SAMPLE_SIZE; taken += 1) {
      observed.add(
        selected(stream.pickWeighted(UNEVEN_CANDIDATES, [1, 0, 0]))
      );
    }

    expect([...observed]).toStrictEqual([UNEVEN_CANDIDATES[0]]);
    expect(stream.cursor).toBe(SAMPLE_SIZE);
  });
});

describe('RngStream.pick declines a list it cannot index', () => {
  it('yields nothing and consumes nothing for an empty list', () => {
    const stream = createRngStreams(RUN_SEED).stream(SPAWN_POSITION);

    expect(stream.pick([])).toBeUndefined();
    expect(stream.pick(availableCells(0))).toBeUndefined();
    expect(stream.cursor).toBe(0);
  });

  it('selects the sole member of a one-entry list, consuming one draw', () => {
    const stream = createRngStreams(RUN_SEED).stream(SPAWN_POSITION);
    const sole = availableCells(1);

    expect(sole).toHaveLength(1);
    expect(stream.pick(sole)).toBe(sole[0]);
    expect(stream.cursor).toBe(1);
  });
});

// The transactional fork: the checkpoint primitive of the substream layer.

// `RngStream.fork()` is what src/engine/hook-bus.ts opens a hook handler's
// randomness transaction over. The substream layer adds one property to
// `SeededRng.fork()`: the fork keeps the name, and therefore the helpers, of
// the substream it came from.

describe('RngStream.fork', () => {
  it('keeps the substream name', () => {
    const streams = createRngStreams(RUN_SEED);

    for (const name of RNG_STREAM_NAMES) {
      expect(streams.stream(name).fork().name).toBe(name);
    }
  });

  it('stands where the substream stands and continues its sequence', () => {
    const streams = createRngStreams(RUN_SEED);
    const reference = createRngStreams(RUN_SEED);
    const stream = streams.stream(SPAWN_POSITION);

    stream.next();
    reference.stream(SPAWN_POSITION).next();

    const fork = stream.fork();

    expect(fork.cursor).toBe(stream.cursor);
    expect(fork.next()).toBe(reference.stream(SPAWN_POSITION).next());
  });

  it('leaves the substream and every other substream untouched', () => {
    const streams = createRngStreams(RUN_SEED);
    const before = streams.snapshotCursors();
    const fork = streams.stream(SPAWN_VALUE).fork();

    fork.nextInt(BOARD_CELL_COUNT);
    fork.pick([1, 2, 3]);
    fork.pickWeighted([2, 4], [0.9, 0.1]);

    expect(streams.snapshotCursors()).toEqual(before);
    expect(fork.cursor).toBe(3);
  });

  it('draws the vanilla spawn distribution through a fork exactly as ' +
    'through the substream', () => {
    const throughFork = createRngStreams(RUN_SEED);
    const throughStream = createRngStreams(RUN_SEED);
    const forked: number[] = [];
    const direct: number[] = [];

    for (let index = 0; index < SEQUENCE_LENGTH; index += 1) {
      const stream = throughFork.stream(SPAWN_VALUE);
      const fork = stream.fork();

      forked.push(fork.pickWeighted([2, 4], [0.9, 0.1]) ?? 0);

      // Adopted by replaying the one draw the fork took.
      stream.next();

      direct.push(
        throughStream.stream(SPAWN_VALUE).pickWeighted([2, 4], [0.9, 0.1]) ?? 0,
      );
    }

    expect(forked).toEqual(direct);
    expect(throughFork.snapshotCursors()).toEqual(
      throughStream.snapshotCursors(),
    );
  });
});
