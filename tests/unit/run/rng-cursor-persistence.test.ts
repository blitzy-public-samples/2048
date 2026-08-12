// End-to-end RNG cursor resume: the draw counts of all four substreams taken
// through src/run/run-state-store.ts and back into a recreated
// src/rng/rng-streams.ts, proving a resumed run continues the sequence it was
// on rather than restarting it.
//
// The `Math.random` identity assertions in section 9 are the descendant of
// .jshintrc L5 `freeze: true`, the retired prohibition on writing to a native.
//
// Figure this suite is the mechanical proof of: Figure 7 (Seeded Determinism)
// of docs/architecture/data-flow.md, whose four substream cursors converge on
// the envelope's `rngCursor` map.
//
// Decisions behind this file: docs/DECISION_LOG.md.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import type { SerializedGameState } from '../../../src/engine/types';
import {
  MAX_RNG_CURSOR,
  RNG_STREAM_NAMES,
  createRngStreams,
} from '../../../src/rng/rng-streams';
import type {
  RngCursorMap,
  RngRejection,
  RngReporter,
  RngStream,
  RngStreams,
  StreamName,
} from '../../../src/rng/rng-streams';
import {
  createSeededRng,
  deriveStreamSeed,
} from '../../../src/rng/seeded-rng';
import { drawRelicOffers } from '../../../src/relics/relic-draw';
import { RELIC_CATALOGUE } from '../../../src/relics/relic-registry';
import { createFreshRunState } from '../../../src/run/run-state';
import type { RunReporter, RunState } from '../../../src/run/run-state';
import { RunStateStore } from '../../../src/run/run-state-store';
import type {
  PersistedStageGoal,
  RunStateLoadResult,
} from '../../../src/run/run-state-store';
import {
  LocalStorageManager,
} from '../../../src/storage/local-storage-manager';
import { MemoryStorage } from '../../../src/storage/memory-storage';
import {
  BEST_SCORE_KEY,
  OWNED_STORAGE_KEYS,
  RUN_STATE_KEY,
} from '../../../src/storage/storage-keys';
import { MERGE_PAIR_BOARD, copyBoard } from '../../fixtures/boards';

/**
 * The `Math.random` this file was loaded beside, read at module scope and so
 * before any generator, substream or store in this file exists.
 */
const PLATFORM_MATH_RANDOM: () => number = Math.random;

/**
 * Own property names `globalThis` carried before this file constructed
 * anything, read at module scope alongside the reference above.
 */
const PLATFORM_GLOBAL_KEYS: readonly string[] = Object.freeze(
  Object.getOwnPropertyNames(globalThis)
);

const RUN_SEED = 'cursor-resume-seed';

/** A second run seed, for the assertions that two seeds must differ. */
const OTHER_RUN_SEED = 'run-seed-2048';

const RUN_ID = 'run-cursor-0001';

const CORRELATION_ID = 'run-correlation-cursor';

const STAGE_GOAL: PersistedStageGoal = {
  kind: 'highest-tile',
  target: 16,
};

/** Draws taken from each substream before the run is persisted. */
const DRAWS_BEFORE_SAVE: Readonly<Record<StreamName, number>> = Object.freeze({
  'spawn-value': 5,
  'spawn-position': 3,
  'relic-draw': 7,
  'rarity-weight': 2,
});

/** Draws compared after the resume, per substream. */
const DRAWS_AFTER_RESUME = 6;


/** Weighted draws taken when the spawn-value distribution is measured. */
const WEIGHTED_DRAW_COUNT = 1000;

/**
 * The counts `WEIGHTED_DRAW_COUNT` weighted draws from `RUN_SEED`'s
 * spawn-value substream resolve to, against the distribution
 * `createDefaultRulesConfig` declares.
 */
const WEIGHTED_DRAW_TALLY: Readonly<Record<number, number>> = Object.freeze({
  2: 883,
  4: 117,
});

/** Every backing store a test built, emptied by the teardown below. */
const trackedStorages: MemoryStorage[] = [];

/** A reporter that keeps every RNG refusal it is handed. */
interface CapturedRngReports extends RngReporter {
  readonly rejections: RngRejection[];
}

function createRngReportSink(): CapturedRngReports {
  const rejections: RngRejection[] = [];

  return {
    rejections,
    onRejected: (rejection: RngRejection): void => {
      rejections.push(rejection);
    },
  };
}

/**
 * A run reporter that keeps every report the store makes, named by member, for
 * the assertions that a clean round trip reports no corruption, no migration
 * and no failed write.
 */
interface CapturedRunReports extends RunReporter {
  readonly records: string[];
}

function createRunReportSink(): CapturedRunReports {
  const records: string[] = [];

  return {
    records,
    onLoadCorrupted: (report): void => {
      records.push(`load-corrupted:${report.verdict}`);
    },
    onVersionMigrated: (report): void => {
      records.push(`version-migrated:${report.toVersion}`);
    },
    onBoardSizeReconciled: (report): void => {
      records.push(`board-size-reconciled:${report.appliedSize}`);
    },
    onWriteFailed: (report): void => {
      records.push(`write-failed:${report.key}`);
    },
  };
}

function buildBoard(): SerializedGameState {
  return copyBoard(MERGE_PAIR_BOARD);
}

/**
 * One test's world: the store under test and the backing storage it writes to.
 */
interface World {
  readonly store: RunStateStore;
  readonly storage: MemoryStorage;

  /** Everything the store reported, in report order. */
  readonly reports: CapturedRunReports;
}

/**
 * Builds a store over a fresh `MemoryStorage`, in the mandatory order:
 * allocate, seed, then construct. js/local_storage_manager.js L25-L26 ran its
 * writability probe once in the constructor, so nothing is written to a port
 * after it exists.
 *
 * @param seed Raw values written before the port is constructed.
 * @returns The store and its backing storage.
 */
function createWorld(seed: Readonly<Record<string, string>> = {}): World {
  const storage = new MemoryStorage();

  trackedStorages.push(storage);

  for (const [key, value] of Object.entries(seed)) {
    storage.setItem(key, value);
  }

  const port = new LocalStorageManager({ storage });
  const reports = createRunReportSink();

  return {
    storage,
    reports,
    store: new RunStateStore({
      storage: port,
      config: createDefaultRulesConfig(),
      correlationId: CORRELATION_ID,
      reporter: reports,
    }),
  };
}

/**
 * Advances every substream by `counts`, in `RNG_STREAM_NAMES` order.
 *
 * @param streams Substreams to advance.
 * @param counts Draws to take per substream.
 * @returns The values drawn, per substream, in draw order.
 */
function advance(
  streams: RngStreams,
  counts: Readonly<Record<StreamName, number>>
): Record<StreamName, number[]> {
  const drawn: Partial<Record<StreamName, number[]>> = {};

  for (const name of RNG_STREAM_NAMES) {
    const values: number[] = [];
    const stream = streams.stream(name);

    for (let index = 0; index < counts[name]; index += 1) {
      values.push(stream.next());
    }

    drawn[name] = values;
  }

  return drawn as Record<StreamName, number[]>;
}

/**
 * Takes `count` draws from each substream without advancing anything else.
 *
 * @param streams Substreams to read.
 * @param count Draws to take per substream.
 * @returns The values drawn, per substream, in draw order.
 */
function drawEach(
  streams: RngStreams,
  count: number
): Record<StreamName, number[]> {
  const counts: Partial<Record<StreamName, number>> = {};

  for (const name of RNG_STREAM_NAMES) {
    counts[name] = count;
  }

  return advance(streams, counts as Record<StreamName, number>);
}

/** A total cursor map with every substream at zero. */
function zeroCursor(): RngCursorMap {
  const cursor: Partial<Record<StreamName, number>> = {};

  for (const name of RNG_STREAM_NAMES) {
    cursor[name] = 0;
  }

  return cursor as RngCursorMap;
}

/**
 * Builds the envelope a run persists at the point `cursor` describes.
 *
 * @param cursor Draw counts to persist.
 * @returns A valid envelope at the current schema version.
 */
function envelopeAt(cursor: RngCursorMap): RunState {
  return createFreshRunState({
    runId: RUN_ID,
    seed: RUN_SEED,
    rngCursor: cursor,
    stageIndex: 0,
    stageGoal: STAGE_GOAL,
    board: buildBoard(),
  });
}

/**
 * Runs the whole round trip: advance, persist, reload, recreate.
 *
 * @param counts Draws to take before persisting.
 * @returns The advanced streams, the persisted cursor, the load result and
 *   the streams recreated from what was loaded.
 */
function roundTrip(
  counts: Readonly<Record<StreamName, number>> = DRAWS_BEFORE_SAVE
): {
  readonly before: RngStreams;
  readonly savedCursor: RngCursorMap;
  readonly loaded: RunStateLoadResult;
  readonly resumed: RngStreams;
  readonly world: World;
} {
  const before = createRngStreams(RUN_SEED);

  advance(before, counts);

  const savedCursor = before.snapshotCursors();
  const world = createWorld();

  expect(world.store.save(envelopeAt(savedCursor))).toBe(true);

  const loaded = world.store.load();

  expect(loaded.state).not.toBeNull();

  const state = loaded.state as RunState;
  const resumed = createRngStreams(state.seed, state.rngCursor);

  return { before, savedCursor, loaded, resumed, world };
}

/**
 * A reference run that took the same draws and was never interrupted.
 *
 * @param counts Draws to take first.
 * @returns The uninterrupted streams, standing where the resume should
 *   stand.
 */
function reference(
  counts: Readonly<Record<StreamName, number>> = DRAWS_BEFORE_SAVE
): RngStreams {
  const streams = createRngStreams(RUN_SEED);

  advance(streams, counts);

  return streams;
}

/** Every key this suite may have written, as one list with no repeat. */
const CLEARED_STORAGE_KEYS: readonly string[] = Object.freeze([
  ...new Set<string>([...OWNED_STORAGE_KEYS, BEST_SCORE_KEY]),
]);

/** Empties and forgets every backing store a test built. */
function clearTrackedStorages(): void {
  for (const storage of trackedStorages) {
    for (const key of CLEARED_STORAGE_KEYS) {
      storage.removeItem(key);
    }
  }

  trackedStorages.length = 0;
}

beforeEach(clearTrackedStorages);

afterEach(clearTrackedStorages);

describe('the substreams a run persists a cursor for', () => {
  it('names the four substreams in the order the map is keyed by', () => {
    expect([...RNG_STREAM_NAMES]).toEqual([
      'spawn-value',
      'spawn-position',
      'relic-draw',
      'rarity-weight',
    ]);
  });

  it('resolves a substream reporting its own name, for all four', () => {
    const streams = createRngStreams(RUN_SEED);

    for (const name of RNG_STREAM_NAMES) {
      expect(streams.stream(name).name).toBe(name);
    }
  });

  it('opens every substream at cursor zero', () => {
    const streams = createRngStreams(RUN_SEED);

    for (const name of RNG_STREAM_NAMES) {
      expect(streams.stream(name).cursor).toBe(0);
    }
  });
});

describe('the cursor map a run hands the envelope', () => {
  it('is keyed by exactly the four substream names, in their order', () => {
    const cursor = createRngStreams(RUN_SEED).snapshotCursors();

    expect(Object.keys(cursor)).toEqual([...RNG_STREAM_NAMES]);
  });

  it('carries a finite whole count of no less than zero per name', () => {
    const streams = createRngStreams(RUN_SEED);

    advance(streams, DRAWS_BEFORE_SAVE);

    const cursor = streams.snapshotCursors();

    for (const name of RNG_STREAM_NAMES) {
      expect(Number.isSafeInteger(cursor[name])).toBe(true);
      expect(cursor[name]).toBeGreaterThanOrEqual(0);
    }
  });

  it('survives a JSON round trip unchanged, member for member', () => {
    const streams = createRngStreams(RUN_SEED);

    advance(streams, DRAWS_BEFORE_SAVE);

    const cursor = streams.snapshotCursors();
    const revived = JSON.parse(JSON.stringify(cursor)) as RngCursorMap;

    expect(revived).toEqual(cursor);
  });

  it('is detached: mutating it moves no substream', () => {
    const streams = createRngStreams(RUN_SEED);

    advance(streams, DRAWS_BEFORE_SAVE);

    const taken = streams.snapshotCursors();

    for (const name of RNG_STREAM_NAMES) {
      taken[name] = 9999;
    }

    streams.stream('spawn-value').next();

    const fresh = streams.snapshotCursors();

    expect(fresh['spawn-value']).toBe(DRAWS_BEFORE_SAVE['spawn-value'] + 1);
    expect(fresh['spawn-position']).toBe(DRAWS_BEFORE_SAVE['spawn-position']);
    expect(fresh['relic-draw']).toBe(DRAWS_BEFORE_SAVE['relic-draw']);
    expect(fresh['rarity-weight']).toBe(DRAWS_BEFORE_SAVE['rarity-weight']);
  });
});

/**
 * Takes `WEIGHTED_DRAW_COUNT` weighted selections from `stream` against the
 * configured spawn distribution, tallying what was selected.
 *
 * @param stream Substream to draw from.
 * @returns How many times each value was selected.
 */
function tallyWeightedDraws(stream: RngStream): Record<number, number> {
  const { spawn } = createDefaultRulesConfig();
  const tally: Record<number, number> = {};

  for (let index = 0; index < WEIGHTED_DRAW_COUNT; index += 1) {
    const value = stream.pickWeighted(spawn.values, spawn.weights);

    expect(value).not.toBeUndefined();

    const selected = value as number;

    tally[selected] = (tally[selected] ?? 0) + 1;
  }

  return tally;
}

describe('a cursor counts draws taken and nothing else', () => {
  it('rises by exactly the number of raw draws taken, per substream', () => {
    const streams = createRngStreams(RUN_SEED);

    advance(streams, DRAWS_BEFORE_SAVE);

    for (const name of RNG_STREAM_NAMES) {
      expect(streams.stream(name).cursor).toBe(DRAWS_BEFORE_SAVE[name]);
    }
  });

  it('rises by one per bounded index draw, whatever the bound', () => {
    const stream = createRngStreams(RUN_SEED).stream('spawn-position');

    for (const bound of [1, 4, 16]) {
      const before = stream.cursor;
      const index = stream.nextInt(bound);

      expect(stream.cursor).toBe(before + 1);
      expect(Number.isInteger(index)).toBe(true);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(bound);
    }
  });

  it('rises by one per selection from a list of cells', () => {
    const stream = createRngStreams(RUN_SEED).stream('spawn-position');

    // Replaces js/grid.js L41, `cells[Math.floor(Math.random *
    // cells.length)]`.
    const cells = ['0,0', '0,1', '0,2', '0,3'];
    const chosen = stream.pick(cells);

    expect(cells).toContain(chosen);
    expect(stream.cursor).toBe(1);
  });

  it('does not rise for a selection from an empty list', () => {
    const stream = createRngStreams(RUN_SEED).stream('spawn-position');

    // js/grid.js L37-L43: `randomAvailableCell` fell through and returned
    // undefined on a full board, the `if (cells.length)` guard at L40 having
    // no else branch.
    expect(stream.pick([])).toBeUndefined();
    expect(stream.cursor).toBe(0);
  });

  it('persists no draw for a full-board selection that declined', () => {
    const streams = createRngStreams(RUN_SEED);
    const position = streams.stream('spawn-position');

    position.next();
    position.pick([]);
    position.pick([]);

    expect(streams.snapshotCursors()['spawn-position']).toBe(1);

    const resumed = createRngStreams(RUN_SEED, streams.snapshotCursors());

    expect(resumed.stream('spawn-position').next()).toBe(position.next());
  });

  it('rises by one per weighted selection, not one per candidate', () => {
    const stream = createRngStreams(RUN_SEED).stream('spawn-value');

    tallyWeightedDraws(stream);

    expect(stream.cursor).toBe(WEIGHTED_DRAW_COUNT);
  });

  it('selects only values the configured distribution offers', () => {
    const tally = tallyWeightedDraws(
      createRngStreams(RUN_SEED).stream('spawn-value')
    );
    const { spawn } = createDefaultRulesConfig();

    for (const selected of Object.keys(tally)) {
      expect(spawn.values).toContain(Number(selected));
    }
  });

  it('resolves the configured distribution to a fixed tally for a seed',
    () => {
      const tally = tallyWeightedDraws(
        createRngStreams(RUN_SEED).stream('spawn-value')
      );

      expect(tally).toEqual(WEIGHTED_DRAW_TALLY);
    });

  it('resolves the same tally again from the same seed', () => {
    const first = tallyWeightedDraws(
      createRngStreams(RUN_SEED).stream('spawn-value')
    );
    const second = tallyWeightedDraws(
      createRngStreams(RUN_SEED).stream('spawn-value')
    );

    expect(second).toEqual(first);
  });
});

describe('the persisted cursor records where every substream stood', () => {
  it('carries a distinct count for each of the four substreams', () => {
    const { savedCursor } = roundTrip();

    for (const name of RNG_STREAM_NAMES) {
      expect(savedCursor[name], `${name} persisted count`).toBe(
        DRAWS_BEFORE_SAVE[name]
      );
    }
  });

  it('names exactly the four substreams and no fifth', () => {
    const { loaded } = roundTrip();
    const names = Object.keys(loaded.state?.rngCursor ?? {});

    expect(names.slice().sort()).toEqual(RNG_STREAM_NAMES.slice().sort());
    expect(names).toHaveLength(RNG_STREAM_NAMES.length);
  });

  it('returns every count through the store unchanged', () => {
    const { savedCursor, loaded } = roundTrip();

    expect(loaded.state?.rngCursor).toEqual(savedCursor);
  });

  it('returns the seed through the store unchanged', () => {
    const { loaded } = roundTrip();

    expect(loaded.state?.seed).toBe(RUN_SEED);
    expect(loaded.state?.runId).toBe(RUN_ID);
  });

  it('survives the raw JSON the store actually wrote', () => {
    const { savedCursor, world } = roundTrip();
    const raw = world.storage.getItem(RUN_STATE_KEY);

    expect(raw).not.toBeNull();

    const parsed = JSON.parse(raw ?? 'null') as RunState;

    expect(parsed.rngCursor).toEqual(savedCursor);
  });
});

describe('a run recreated from the persisted cursor continues', () => {
  it('stands exactly where the uninterrupted run stands', () => {
    const { resumed } = roundTrip();

    expect(resumed.snapshotCursors()).toEqual(reference().snapshotCursors());
  });

  it('draws the same next value as the uninterrupted run, per substream',
    () => {
      const { resumed } = roundTrip();
      const continued = drawEach(resumed, DRAWS_AFTER_RESUME);
      const expected = drawEach(reference(), DRAWS_AFTER_RESUME);

      for (const name of RNG_STREAM_NAMES) {
        expect(continued[name], `${name} continuation`).toEqual(
          expected[name]
        );
      }
    });

  it('continues where a run rebuilt from the pre-save snapshot would', () => {
    const { savedCursor, resumed } = roundTrip();
    const fromSnapshot = createRngStreams(RUN_SEED, savedCursor);
    const expected = drawEach(fromSnapshot, DRAWS_AFTER_RESUME);
    const continued = drawEach(resumed, DRAWS_AFTER_RESUME);

    for (const name of RNG_STREAM_NAMES) {
      expect(continued[name], `${name} continuation`).toEqual(expected[name]);
    }
  });

  it('does not restart: the resumed draws differ from a fresh run', () => {
    const { resumed } = roundTrip();
    const continued = drawEach(resumed, DRAWS_AFTER_RESUME);
    const restarted = drawEach(createRngStreams(RUN_SEED), DRAWS_AFTER_RESUME);

    for (const name of RNG_STREAM_NAMES) {
      expect(continued[name], `${name} restart`).not.toEqual(restarted[name]);
    }
  });

  it('does not replay a value the run already consumed', () => {
    const { before, resumed } = roundTrip();
    const consumed = new Set<number>();

    for (const name of RNG_STREAM_NAMES) {
      // The values the pre-save run drew, recomputed from a twin standing at
      // zero so the live streams are not disturbed.
      const twin = createRngStreams(RUN_SEED).stream(name);

      for (let index = 0; index < DRAWS_BEFORE_SAVE[name]; index += 1) {
        consumed.add(twin.next());
      }
    }

    expect(before.snapshotCursors()).toEqual(reference().snapshotCursors());

    for (const name of RNG_STREAM_NAMES) {
      expect(consumed.has(resumed.stream(name).next())).toBe(false);
    }
  });

  it('advances the cursor by exactly the draws taken after the resume', () => {
    const { resumed } = roundTrip();

    drawEach(resumed, DRAWS_AFTER_RESUME);

    for (const name of RNG_STREAM_NAMES) {
      expect(resumed.stream(name).cursor, `${name} cursor`).toBe(
        DRAWS_BEFORE_SAVE[name] + DRAWS_AFTER_RESUME
      );
    }
  });

  it('resumes identically across two independent reloads', () => {
    const first = roundTrip();
    const second = roundTrip();

    expect(drawEach(first.resumed, DRAWS_AFTER_RESUME)).toEqual(
      drawEach(second.resumed, DRAWS_AFTER_RESUME)
    );
  });

  it('resumes correctly a second time, from the resumed run', () => {
    const { resumed, world } = roundTrip();

    drawEach(resumed, DRAWS_AFTER_RESUME);

    expect(world.store.save(envelopeAt(resumed.snapshotCursors()))).toBe(true);

    const reloaded = world.store.load();
    const twiceResumed = createRngStreams(
      (reloaded.state as RunState).seed,
      (reloaded.state as RunState).rngCursor
    );
    const counts: Partial<Record<StreamName, number>> = {};

    for (const name of RNG_STREAM_NAMES) {
      counts[name] = DRAWS_BEFORE_SAVE[name] + DRAWS_AFTER_RESUME;
    }

    expect(drawEach(twiceResumed, 4)).toEqual(
      drawEach(reference(counts as Record<StreamName, number>), 4)
    );
  });
});

/** Start cursors the fast-forward is verified at, `0` among them. */
const FAST_FORWARD_CURSORS: readonly number[] = Object.freeze([0, 2, 5]);

describe('the fast-forward every resume is built on', () => {
  it('stands at the draw a start cursor of that many discards reaches', () => {
    const straight = createSeededRng(RUN_SEED);
    const sequence: number[] = [];

    for (let index = 0; index < 8; index += 1) {
      sequence.push(straight.next());
    }

    for (const start of FAST_FORWARD_CURSORS) {
      expect(createSeededRng(RUN_SEED, start).next()).toBe(sequence[start]);
    }
  });

  it('reports a start cursor as draws already consumed', () => {
    for (const start of FAST_FORWARD_CURSORS) {
      const rng = createSeededRng(RUN_SEED, start);

      expect(rng.cursor).toBe(start);

      rng.next();

      expect(rng.cursor).toBe(start + 1);
    }
  });

  it('positions each substream through the seed it is derived from', () => {
    const { resumed } = roundTrip();

    for (const name of RNG_STREAM_NAMES) {
      const direct = createSeededRng(
        deriveStreamSeed(RUN_SEED, name),
        DRAWS_BEFORE_SAVE[name]
      );

      expect(resumed.stream(name).next()).toBe(direct.next());
    }
  });
});

describe('one substream advancing cannot shift another resume', () => {
  it('resumes each substream against a counts map advancing only it', () => {
    for (const advanced of RNG_STREAM_NAMES) {
      const counts: Partial<Record<StreamName, number>> = zeroCursor();

      counts[advanced] = 9;

      const { resumed } = roundTrip(counts as Record<StreamName, number>);
      const expected = reference(counts as Record<StreamName, number>);

      for (const name of RNG_STREAM_NAMES) {
        expect(resumed.stream(name).cursor).toBe(
          name === advanced ? 9 : 0
        );
        expect(resumed.stream(name).next()).toBe(expected.stream(name).next());
      }
    }
  });

  it('leaves an untouched substream at its opening draw', () => {
    const counts: Partial<Record<StreamName, number>> = zeroCursor();

    counts['relic-draw'] = 12;

    const { resumed } = roundTrip(counts as Record<StreamName, number>);
    const fresh = createRngStreams(RUN_SEED);

    for (const name of RNG_STREAM_NAMES.filter((n) => n !== 'relic-draw')) {
      expect(resumed.stream(name).next()).toBe(fresh.stream(name).next());
    }
  });

  it('leaves the relic substreams unmoved by a run of spawn draws', () => {
    const streams = createRngStreams(RUN_SEED);
    const fresh = createRngStreams(RUN_SEED);
    const position = streams.stream('spawn-position');

    for (let index = 0; index < 24; index += 1) {
      position.nextInt(16);
      streams.stream('spawn-value').next();
    }

    for (const name of ['relic-draw', 'rarity-weight'] as const) {
      expect(streams.stream(name).cursor, `${name} cursor`).toBe(0);
      expect(streams.stream(name).next(), `${name} draw`).toBe(
        fresh.stream(name).next()
      );
    }
  });

  it('keeps the four substreams distinct after a resume', () => {
    const { resumed } = roundTrip(zeroCursor());
    const opening = RNG_STREAM_NAMES.map((name) =>
      resumed.stream(name).next()
    );

    expect(new Set(opening).size).toBe(RNG_STREAM_NAMES.length);
  });
});

describe('the seed each substream is derived from', () => {
  it('gives one run seed and one label one derived seed, every time', () => {
    for (const name of RNG_STREAM_NAMES) {
      expect(deriveStreamSeed(RUN_SEED, name)).toBe(
        deriveStreamSeed(RUN_SEED, name)
      );
    }
  });

  it('gives the four labels four distinct derived seeds', () => {
    const derived = RNG_STREAM_NAMES.map((name) =>
      deriveStreamSeed(RUN_SEED, name)
    );

    expect(new Set(derived).size).toBe(RNG_STREAM_NAMES.length);
  });

  it('gives the four labels four distinct opening draws', () => {
    const opening = RNG_STREAM_NAMES.map((name) =>
      createSeededRng(deriveStreamSeed(RUN_SEED, name)).next()
    );

    expect(new Set(opening).size).toBe(RNG_STREAM_NAMES.length);
  });

  it('gives two run seeds different sequences on one substream name', () => {
    const mine = createRngStreams(RUN_SEED);
    const other = createRngStreams(OTHER_RUN_SEED);

    for (const name of RNG_STREAM_NAMES) {
      expect(mine.stream(name).next()).not.toBe(other.stream(name).next());
    }
  });

  it('gives two run seeds different resumes from one cursor map', () => {
    const { savedCursor } = roundTrip();
    const mine = createRngStreams(RUN_SEED, savedCursor);
    const other = createRngStreams(OTHER_RUN_SEED, savedCursor);

    for (const name of RNG_STREAM_NAMES) {
      expect(mine.stream(name).next()).not.toBe(other.stream(name).next());
    }
  });
});

/* ===== 7. The reward draw: identical offers across a reload ===== */

describe('relic offers reproduce across a reload', () => {
  /**
   * Offers drawn THROUGH THE PRODUCTION DRAW, from the production catalogue.
   *
   * This section used to assemble offers with a private helper of its own that
   * took one draw per selection from `relic-draw` alone, over a pool of eight
   * invented identifiers. That helper agreed with itself across a reload no
   * matter what `drawRelicOffers` did, and it was wrong about the accounting in
   * the one way that matters here: the production draw is rarity-weighted, so it
   * consumes ONE `rarity-weight` draw AND ONE `relic-draw` draw per offer it
   * RETURNS. A cursor map that resumed `relic-draw` and lost `rarity-weight`
   * would have satisfied every assertion the helper could make, while giving a
   * resumed run a different offer from the run it continued — which is exactly
   * the half of validation gate V2 (0.8.2) this file exists to hold.
   *
   * @param streams Substreams the draw consumes.
   * @param ownedIds Identifiers a run already holds, excluded from the pool.
   * @returns The offered identifiers, in draw order.
   */
  const offer = (
    streams: RngStreams,
    ownedIds: readonly string[] = []
  ): readonly string[] =>
    drawRelicOffers({
      pool: RELIC_CATALOGUE,
      streams,
      count: OFFER_COUNT,
      ownedIds,
    }).map((relic): string => relic.id);

  /** Cards one reward round offers, which AAP 0.6.4 fixes at three. */
  const OFFER_COUNT = 3;

  /**
   * The identifiers `RUN_SEED` offers once the substreams stand at
   * `DRAWS_BEFORE_SAVE`, captured in the file rather than recomputed by a second
   * copy of the algorithm.
   *
   * Written out so a change in the draw arithmetic is caught here as a changed
   * expectation, instead of two sides of the comparison moving together and the
   * suite staying green through it.
   */
  const OFFERED_AFTER_SAVE: readonly string[] = Object.freeze([
    'echo-chamber',
    'gilded-rot',
    'temporal-anchor',
  ]);

  it('offers the same three relics a resumed run would have offered', () => {
    const { resumed } = roundTrip();
    const uninterrupted = reference();

    // ONE ROUND EACH, from the two sides: the resumed streams and a reference
    // that never left. A second round on either side would draw the NEXT set and
    // compare two different rounds.
    expect(offer(resumed)).toEqual(offer(uninterrupted));
  });

  it('offers exactly the three the seed names at that cursor', () => {
    const { resumed } = roundTrip();

    expect(offer(resumed)).toEqual(OFFERED_AFTER_SAVE);
  });

  it('offers three DISTINCT relics, which is sampling without replacement', () => {
    const { resumed } = roundTrip();
    const offered = offer(resumed);

    expect(offered).toHaveLength(OFFER_COUNT);
    expect(new Set(offered).size).toBe(OFFER_COUNT);
  });

  it('advances BOTH reward substreams, one draw each per offer returned', () => {
    const { resumed } = roundTrip();

    offer(resumed);

    // THE ACCOUNTING THE PRIVATE HELPER MISSED. `rarity-weight` picks the tier
    // and `relic-draw` picks within it, so a three-card offer costs three draws
    // on each. A resume that recovered one and not the other would draw a
    // different set from the run it claims to continue.
    expect(resumed.stream('relic-draw').cursor).toBe(
      DRAWS_BEFORE_SAVE['relic-draw'] + OFFER_COUNT
    );
    expect(resumed.stream('rarity-weight').cursor).toBe(
      DRAWS_BEFORE_SAVE['rarity-weight'] + OFFER_COUNT
    );
  });

  it('continues both cursors from the persisted map, not from zero', () => {
    const { resumed, savedCursor } = roundTrip();

    // THE PERSISTED MAP IS THE STARTING POINT, read back through the store
    // rather than assumed: a resume that restarted either stream would stand at
    // `OFFER_COUNT` after one round instead of past the saved cursor.
    expect(resumed.stream('rarity-weight').cursor).toBe(
      savedCursor['rarity-weight']
    );
    expect(resumed.stream('relic-draw').cursor).toBe(savedCursor['relic-draw']);

    offer(resumed);

    expect(resumed.stream('rarity-weight').cursor).toBeGreaterThan(OFFER_COUNT);
    expect(resumed.stream('relic-draw').cursor).toBeGreaterThan(OFFER_COUNT);
  });

  it('leaves the resumed run on the same two reward cursors as the reference', () => {
    const { resumed } = roundTrip();
    const untouched = reference();

    offer(resumed);
    offer(untouched);

    expect(resumed.stream('relic-draw').cursor).toBe(
      untouched.stream('relic-draw').cursor
    );
    expect(resumed.stream('rarity-weight').cursor).toBe(
      untouched.stream('rarity-weight').cursor
    );
  });

  it('offers a different set after the reload than at the run start', () => {
    const { resumed } = roundTrip();

    expect(offer(resumed)).not.toEqual(offer(createRngStreams(RUN_SEED)));
  });

  it('continues the offer sequence rather than repeating it', () => {
    const { resumed } = roundTrip();
    const first = offer(resumed);
    const second = offer(resumed, first);

    // The second round draws from where the first left off, and excludes what
    // the run took, so no identifier can appear in both.
    expect(second).toHaveLength(OFFER_COUNT);
    expect(new Set(second).size).toBe(OFFER_COUNT);

    for (const id of second) {
      expect(first).not.toContain(id);
    }
  });

  it('leaves the spawn substreams unmoved by a reward draw', () => {
    const { resumed } = roundTrip();

    offer(resumed);

    // Substream separation, asserted across the persistence boundary: a relic
    // drawn after a reload cannot shift the spawn sequence.
    expect(resumed.stream('spawn-value').cursor).toBe(
      DRAWS_BEFORE_SAVE['spawn-value']
    );
    expect(resumed.stream('spawn-position').cursor).toBe(
      DRAWS_BEFORE_SAVE['spawn-position']
    );
    expect(resumed.stream('spawn-value').next()).toBe(
      reference().stream('spawn-value').next()
    );
  });
});

describe('a partial or absent cursor map still resumes', () => {
  /**
   * Writes a raw payload whose `rngCursor` member is `cursor`, then loads it
   * back. The payload is written before the port and the store are built, the
   * order js/local_storage_manager.js L25-L26 and js/game_manager.js L36
   * require: the writability probe and the snapshot read both run once, at
   * construction.
   *
   * @param cursor Value to store under `rngCursor`.
   * @returns The load result and the world it came from.
   */
  function loadWithCursor(cursor: unknown): {
    readonly loaded: RunStateLoadResult;
    readonly world: World;
  } {
    const payload = JSON.parse(
      JSON.stringify(envelopeAt(zeroCursor()))
    ) as Record<string, unknown>;

    payload.rngCursor = cursor;

    const world = createWorld({
      [RUN_STATE_KEY]: JSON.stringify(payload),
    });

    return { loaded: world.store.load(), world };
  }

  it('continues the substreams a partial map records', () => {
    const { loaded } = loadWithCursor({ 'spawn-value': 4 });
    const state = loaded.state as RunState;
    const counts: Partial<Record<StreamName, number>> = zeroCursor();

    counts['spawn-value'] = 4;

    const resumed = createRngStreams(state.seed, state.rngCursor);

    expect(resumed.stream('spawn-value').cursor).toBe(4);
    expect(drawEach(resumed, 3)).toEqual(
      drawEach(reference(counts as Record<StreamName, number>), 3)
    );
  });

  it('starts the substreams a partial map omits from the beginning', () => {
    const { loaded } = loadWithCursor({ 'spawn-value': 4 });
    const state = loaded.state as RunState;
    const resumed = createRngStreams(state.seed, state.rngCursor);
    const fresh = createRngStreams(RUN_SEED);

    for (const name of RNG_STREAM_NAMES) {
      if (name === 'spawn-value') {
        continue;
      }

      expect(resumed.stream(name).cursor).toBe(0);
      expect(resumed.stream(name).next()).toBe(fresh.stream(name).next());
    }
  });

  it('resumes from a payload carrying no cursor member at all', () => {
    const { loaded } = loadWithCursor(undefined);
    const state = loaded.state as RunState;

    for (const name of RNG_STREAM_NAMES) {
      expect(state.rngCursor[name]).toBe(0);
    }

    expect(drawEach(createRngStreams(state.seed, state.rngCursor), 2)).toEqual(
      drawEach(createRngStreams(RUN_SEED), 2)
    );
  });
});

describe('the restore reports the counts it could not use', () => {
  it('reports nothing when every recorded count is usable', () => {
    const sink = createRngReportSink();
    const { savedCursor } = roundTrip();

    createRngStreams(RUN_SEED, savedCursor, sink);

    expect(sink.rejections).toEqual([]);
  });

  it('reports nothing for a partial map, which is an older payload', () => {
    const sink = createRngReportSink();

    createRngStreams(RUN_SEED, { 'spawn-value': 4 }, sink);

    expect(sink.rejections).toEqual([]);
  });

  it('names the substream, the count and the bound it was measured against',
    () => {
      const sink = createRngReportSink();
      const recorded: Partial<RngCursorMap> = {
        ...zeroCursor(),
        'spawn-value': -1,
      };

      createRngStreams(RUN_SEED, recorded, sink);

      expect(sink.rejections).toHaveLength(1);
      expect(sink.rejections[0]).toEqual({
        kind: 'cursor-unusable',
        stream: 'spawn-value',
        observed: -1,
        maximum: MAX_RNG_CURSOR,
      });
    });

  it('resumes the substreams it did accept after refusing one', () => {
    const sink = createRngReportSink();
    const recorded: Partial<RngCursorMap> = {
      ...zeroCursor(),
      'spawn-value': -1,
      'spawn-position': 3,
    };
    const resumed = createRngStreams(RUN_SEED, recorded, sink);

    expect(resumed.stream('spawn-value').cursor).toBe(0);
    expect(resumed.stream('spawn-position').cursor).toBe(3);
    expect(sink.rejections).toHaveLength(1);
  });

  it('reports no corruption, no migration and no failed write for a clean ' +
    'round trip', () => {
    const { world } = roundTrip();

    expect(world.reports.records).toEqual([]);
  });
});

describe('the resume leaves the run RNG contract intact', () => {
  it('never patches Math.random, across the whole resume cycle', () => {
    const straight = createSeededRng(RUN_SEED);

    straight.next();

    const { resumed } = roundTrip();

    drawEach(resumed, DRAWS_AFTER_RESUME);

    // The invariant Figure 7 (Seeded Determinism) of
    // docs/architecture/data-flow.md publishes as a guard node.
    expect(Math.random).toBe(PLATFORM_MATH_RANDOM);

    // And by property descriptor, which is what a `defineProperty` install
    // leaves behind: the member is still the platform's own writable,
    // non-enumerable, configurable value property and carries no accessor.
    const descriptor = Object.getOwnPropertyDescriptor(Math, 'random');

    expect(descriptor?.value).toBe(PLATFORM_MATH_RANDOM);
    expect(descriptor?.get).toBeUndefined();
    expect(descriptor?.set).toBeUndefined();
    expect(descriptor?.writable).toBe(true);
    expect(descriptor?.enumerable).toBe(false);
    expect(descriptor?.configurable).toBe(true);
  });

  it('adds no own property to globalThis', () => {
    const before = Object.getOwnPropertyNames(globalThis);

    createSeededRng(RUN_SEED);
    createRngStreams(RUN_SEED);
    roundTrip();

    expect(Object.getOwnPropertyNames(globalThis)).toEqual(before);
    expect(Object.getOwnPropertyNames(globalThis)).toEqual([
      ...PLATFORM_GLOBAL_KEYS,
    ]);
  });

  it('returns draws inside the unit interval after a resume', () => {
    const { resumed } = roundTrip();

    for (const name of RNG_STREAM_NAMES) {
      for (let index = 0; index < 32; index += 1) {
        const value = resumed.stream(name).next();

        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      }
    }
  });

  it('reads the same substream object for a name after a resume', () => {
    const { resumed } = roundTrip();

    for (const name of RNG_STREAM_NAMES) {
      expect(resumed.stream(name)).toBe(resumed.stream(name));
    }
  });

  it('touches no key but the run key', () => {
    const world = createWorld({ [BEST_SCORE_KEY]: '4096' });
    const streams = createRngStreams(RUN_SEED);

    advance(streams, DRAWS_BEFORE_SAVE);
    world.store.save(envelopeAt(streams.snapshotCursors()));
    world.store.load();

    expect(world.storage.getItem(BEST_SCORE_KEY)).toBe('4096');
  });

  it('resumes a run whose every substream stood at zero', () => {
    const { resumed } = roundTrip(zeroCursor());

    expect(drawEach(resumed, 4)).toEqual(
      drawEach(createRngStreams(RUN_SEED), 4)
    );
  });

  it('resumes after a large but acceptable number of draws', () => {
    const counts: Partial<Record<StreamName, number>> = zeroCursor();

    counts['spawn-value'] = 500;

    const { resumed } = roundTrip(counts as Record<StreamName, number>);

    expect(resumed.stream('spawn-value').cursor).toBe(500);
    expect(resumed.stream('spawn-value').next()).toBe(
      reference(counts as Record<StreamName, number>)
        .stream('spawn-value')
        .next()
    );
  });
});
