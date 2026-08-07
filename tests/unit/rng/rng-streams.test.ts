// Unit suite over src/rng/rng-streams.ts, the named-substream layer.
//
// The contracts asserted here are Contract 6 — one run seed fanned into
// four named substreams that advance independently — and the reload
// half of validation gate V2, that a substream restored from a recorded
// cursor continues the same sequence. `RngCursorMap` is the shape
// Contract 5 persists as the run state's `rngCursor` field.
//
// The fan-out this suite covers is drawn as Figure 7, "Seeded
// Determinism: One Run Seed Fanned into Named RNG Substreams", in
// docs/architecture/data-flow.md.
//
// PROVENANCE. The two audited randomness call sites of the deleted
// vanilla sources, both pinned by this suite:
//   js/game_manager.js L71  the spawn value draw, `< 0.9 ? 2 : 4` on a
//                           strict less-than. Now
//                           `RngStream.pickWeighted` over the spawn
//                           distribution of the rules config.
//   js/grid.js L41          the spawn position draw,
//                           `cells[Math.floor(u * cells.length)]` for a
//                           draw `u`. Now `RngStream.nextInt`, and
//                           `RngStream.pick` over the same array.
//   js/grid.js L37-L43      `randomAvailableCell()` guards on
//                           `cells.length` and carries no else branch,
//                           so a full board yields `undefined`.
//   js/grid.js L45-L60      `availableCells()` collects `{x, y}`
//                           through `eachCell`, x-outer and y-inner.
//
// Every expectation below is either relational — identical seeds give
// identical sequences, a restored substream continues in lockstep, one
// substream's draws leave the others untouched — or a range or shape
// check. The derived helpers are cross-checked against `next()` on
// paired same-seed substreams. No generator output appears as a literal
// anywhere in this file. Every seed is a literal declared here, and
// this suite reads no clock, no environment and no document.
//
// Decisions behind this file: docs/DECISION_LOG.md.

import { describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import {
  RNG_STREAM_NAMES,
  createRngStreams,
  type RngCursorMap,
  type RngStream,
  type RngStreams,
  type StreamName,
} from '../../../src/rng/rng-streams';

/* ===== 1. Fixed inputs ===== */

/** Run seed every scenario that needs only one seed draws from. */
const RUN_SEED = 'blitzy-2048-run-alpha';

/** Second run seed, for the scenarios that compare two runs. */
const OTHER_RUN_SEED = 'blitzy-2048-run-beta';

// The four names, bound once each. No scenario below addresses a
// substream through a bare string, and the canonical spelling and order
// of these four are asserted against `RNG_STREAM_NAMES` in section 3.
const SPAWN_VALUE = 'spawn-value';
const SPAWN_POSITION = 'spawn-position';
const RELIC_DRAW = 'relic-draw';
const RARITY_WEIGHT = 'rarity-weight';

/** Draws compared when two sequences are checked for equality. */
const SEQUENCE_LENGTH = 12;

/** Draws compared either side of a cursor restore. */
const CONTINUATION_LENGTH = 8;

/** Draws compared in the substream-independence baseline. */
const INDEPENDENCE_LENGTH = 20;

/** Draws taken when a property is checked across a sample. */
const SAMPLE_SIZE = 300;

/** Draws taken when a selection is cross-checked against `next()`. */
const CROSS_CHECK_SIZE = 500;

/** Draws taken when the weighted distribution is counted. */
const DISTRIBUTION_SIZE = 1000;

/** Cell count of the classic board, and a `nextInt` bound. */
const BOARD_CELL_COUNT = 16;

/** Board edge length, for building an available-cell list. */
const BOARD_SIZE = 4;

/**
 * Draw counts written into every substream where a snapshot is checked.
 * Four different counts, so a snapshot that transposed two entries
 * would not match.
 */
const DISTINCT_DRAW_COUNTS: RngCursorMap = {
  'spawn-value': 3,
  'spawn-position': 5,
  'relic-draw': 2,
  'rarity-weight': 7,
};

/** Recorded position the partial-restore scenario resumes from. */
const PARTIAL_RESTORE_CURSOR = 5;

/** One cell of an available-cell list. */
interface Cell {
  x: number;
  y: number;
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

/**
 * Takes `count` draws from the named substream of `streams`.
 *
 * @param streams Substreams of one run.
 * @param name Substream to draw from.
 * @param count Number of draws to take.
 * @returns The draws, in order.
 */
function drawFrom(
  streams: RngStreams,
  name: StreamName,
  count: number
): number[] {
  return draw(streams.stream(name), count);
}

/**
 * Takes `count` draws from a fresh run and returns them, so a scenario
 * can compare against an untouched sequence.
 *
 * @param name Substream to draw from.
 * @param count Number of draws to take.
 * @param seed Run seed. Defaults to `RUN_SEED`.
 * @returns The draws, in order.
 */
function reference(
  name: StreamName,
  count: number,
  seed: string = RUN_SEED
): number[] {
  return drawFrom(createRngStreams(seed), name, count);
}

/**
 * Reduces one selection result to a definite value.
 *
 * @param value Result of `pick` or `pickWeighted`.
 * @returns `value` when something was selected.
 * @throws {Error} When nothing was selected.
 */
function selected<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('A selection was expected but none was returned.');
  }

  return value;
}

/**
 * Builds an available-cell list for an empty board.
 *
 * Collection order mirrors `availableCells()` at js/grid.js L45-L60:
 * x-outer and y-inner.
 *
 * @param size Board edge length.
 * @returns The cells, in collection order.
 */
function availableCells(size: number): Cell[] {
  const cells: Cell[] = [];

  for (let x = 0; x < size; x += 1) {
    for (let y = 0; y < size; y += 1) {
      cells.push({ x, y });
    }
  }

  return cells;
}

/**
 * Advances every substream of `streams` by the count `counts` records
 * for it, walking `RNG_STREAM_NAMES`.
 *
 * @param streams Substreams of one run.
 * @param counts Draws to take from each substream.
 */
function applyDrawCounts(streams: RngStreams, counts: RngCursorMap): void {
  for (const name of RNG_STREAM_NAMES) {
    draw(streams.stream(name), counts[name]);
  }
}

/* ===== 3. RNG_STREAM_NAMES ===== */

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

/* ===== 4. RngStreams shape and substream identity ===== */

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

    expect(perLookup).toEqual(untouched);
    expect(perLookup[1]).not.toBe(untouched[0]);
    expect(perLookup[2]).not.toBe(untouched[1]);
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

/* ===== 5. Per-substream determinism and draw shape ===== */

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

/* ===== 6. Substream independence ===== */

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

      // Cursor isolation: relic-side activity moved neither spawn
      // substream off its start.
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

/* ===== 7. snapshotCursors ===== */

describe('snapshotCursors', () => {
  it('carries every substream name, at 0, before any draw', () => {
    const snapshot = createRngStreams(RUN_SEED).snapshotCursors();
    const keys: string[] = Object.keys(snapshot);
    const names: string[] = [...RNG_STREAM_NAMES];

    // Total by name: this is the shape the run state persists as its
    // `rngCursor` field.
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

/* ===== 8. Cursor restore ===== */

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

/* ===== 9. nextInt — the position index draw of js/grid.js L41 ===== */

describe('RngStream.nextInt — replaces js/grid.js L41', () => {
  // 16 is the cell count of the classic 4x4 board, the largest
  // available-cell list the vanilla position draw indexed into.
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

  it('selects more than one index over the classic cell count', () => {
    const stream = createRngStreams(RUN_SEED).stream(SPAWN_POSITION);
    const distinct = new Set<number>();

    for (let taken = 0; taken < SAMPLE_SIZE; taken += 1) {
      distinct.add(stream.nextInt(BOARD_CELL_COUNT));
    }

    expect(distinct.size).toBeGreaterThan(1);
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

  // src/rng/rng-streams.ts declares 0 for a bound that is not a finite
  // number greater than 0, and declares that no draw is consumed.
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

/* ===== 10. pick — the cell selection of js/grid.js L37-L43 ===== */

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

  // `Math.floor(u * cells.length)` over the list in the order the
  // caller supplied it, as at js/grid.js L41. Nothing is sorted or
  // re-keyed on the way in.
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

  it('varies the cell it selects across the classic board', () => {
    const cells = availableCells(BOARD_SIZE);
    const stream = createRngStreams(RUN_SEED).stream(SPAWN_POSITION);
    const distinct = new Set<Cell>();

    for (let taken = 0; taken < SAMPLE_SIZE; taken += 1) {
      distinct.add(selected(stream.pick(cells)));
    }

    expect(distinct.size).toBeGreaterThan(1);
  });

  // js/grid.js L37-L43: randomAvailableCell() guards on cells.length
  // and carries no else branch, so a full board yields undefined.
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

/* ===== 11. pickWeighted — the spawn value draw of
             js/game_manager.js L71 ===== */

/** Weights that give the whole distribution to the first candidate. */
const FIRST_CANDIDATE_ONLY: readonly number[] = [1, 0];

/** Weights that give the whole distribution to the second candidate. */
const SECOND_CANDIDATE_ONLY: readonly number[] = [0, 1];

/** The only weight a single-candidate distribution needs. */
const SOLE_CANDIDATE_WEIGHT: readonly number[] = [1];

describe('RngStream.pickWeighted — replaces js/game_manager.js L71', () => {
  // Pins the distribution the threshold is read from. At
  // js/game_manager.js L71 the value was 2 below 0.9 and 4 at or above
  // it.
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

      // The comparison is `<`, not `<=`: at js/game_manager.js L71 a
      // draw of exactly 0.9 fell to the second candidate.
      expected.push(
        observing.next() < spawn.weights[0] ? spawn.values[0] : spawn.values[1]
      );
    }

    expect(chosen).toEqual(expected);

    // Both candidates occur in the cross-checked sample: neither
    // branch of the threshold is left unexercised.
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

  it('applies the weights it was given across a large sample', () => {
    const { spawn } = createDefaultRulesConfig();
    const stream = createRngStreams(RUN_SEED).stream(SPAWN_VALUE);
    const counts = new Map<number, number>();

    for (let taken = 0; taken < DISTRIBUTION_SIZE; taken += 1) {
      const value = selected(
        stream.pickWeighted(spawn.values, spawn.weights)
      );

      counts.set(value, (counts.get(value) ?? 0) + 1);
    }

    const heavier = counts.get(spawn.values[0]) ?? 0;
    const lighter = counts.get(spawn.values[1]) ?? 0;

    expect(heavier + lighter).toBe(DISTRIBUTION_SIZE);
    expect(heavier).toBeGreaterThan(lighter);
    expect(lighter).toBeGreaterThan(0);
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
