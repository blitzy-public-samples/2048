// End-to-end RNG cursor resume: the draw counts of all four substreams taken
// through src/run/run-state-store.ts and back into a recreated
// src/rng/rng-streams.ts, proving a resumed run continues the sequence it was
// on rather than restarting it.
//
// This is the file tests/unit/run/run-state.test.ts and
// tests/unit/run/run-state-store.test.ts both name as the owner of this
// coverage. Those two suites verify the schema and the store in isolation;
// neither reconstructs an `RngStreams` from what was persisted, so neither can
// show that the persisted number is the number a resume actually needs.
//
// What is at stake: validation gate V2 (0.8.2) requires the same seed and the
// same move list to yield an identical board AND identical relic offers across
// repeated runs AND ACROSS A RELOAD. `RunState.rngCursor` is the entire
// mechanism for the reload half — AAP Contract 5 (0.6.1.5) and Contract 6
// (0.6.1.6) — and nothing else in the product recovers it. A cursor that is
// persisted but not resumable would satisfy every existing assertion in this
// folder and still break the guarantee.
//
// Superseded constructs this suite is a verification target for:
//   Math.random() spawn value          js/game_manager.js L71
//   Math.random() spawn position       js/grid.js         L37-L43
//   available-cell order               js/grid.js         L45-L64
//   the absence of any persisted draw position at all
//                                      js/local_storage_manager.js L52-L59
//
// The first two rows above are the whole set of superseded randomness: a grep
// of the tree finds exactly two `Math.random()` calls and no third, so the
// substitution the substreams make is closed and enumerable. The order the
// position draw indexes into is fixed by `Grid.prototype.availableCells` and
// `Grid.prototype.eachCell` at js/grid.js L45-L64, x-outer and y-inner, so no
// expectation below assumes another traversal.
//
// The `Math.random` identity assertions in section 9 are the descendant of
// .jshintrc L5 `freeze: true`, the retired prohibition on writing to a native.
//
// Collected by the unit:dom-free project of vitest.config.ts, environment
// 'node'. Nothing here reads a document, a Web Storage global or a clock;
// randomness is consumed only through the seeded substreams under test, and the
// Math.random invariant is asserted rather than relied on.
//
// Figure this suite is the mechanical proof of: Figure 7 (Seeded Determinism)
// of docs/architecture/data-flow.md, whose four substream cursors converge on
// the envelope's `rngCursor` map.
//
// Coverage boundaries this suite stays inside. What it owns is the draw
// accounting the persisted cursor map is assembled from and the resume that map
// feeds; every neighbouring concern has its own owner:
//   substream derivation arithmetic    tests/unit/rng/rng-streams.test.ts
//   the ambient Math.random guard      tests/unit/rng/math-random-guard.test.ts
//   the schema, and `normalizeRngCursor`'s degenerate input matrix
//                                      tests/unit/run/run-state.test.ts
//   store verdicts and failure paths   tests/unit/run/run-state-store.test.ts
//   relic offer content: rarity weighting, sampling without replacement
//                                      tests/unit/relics/relic-draw.test.ts
//   board-size reconciliation          tests/unit/run/run-relic-board-size
//                                        .test.ts
//   the frozen best-score contract     tests/unit/storage/best-score.test.ts
//
// Determinism is achieved by construction here: every value is drawn from a
// seeded substream, no clock, network or ambient randomness is read for test
// data, and no snapshot artifact is written — the seeded snapshot gate under
// tests/snapshot/ is configured and stored separately, and this suite compares
// captured sequences in file instead.
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

/* ===== 1. Fixtures and the injected world ===== */

/**
 * The `Math.random` this file was loaded beside, read at module scope and so
 * before any generator, substream or store in this file exists. Section 9
 * compares against this reference by identity.
 */
const PLATFORM_MATH_RANDOM: () => number = Math.random;

/**
 * Own property names `globalThis` carried before this file constructed
 * anything, read at module scope alongside the reference above. Section 9
 * compares the set against it.
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

/**
 * Draws taken from each substream before the run is persisted. No two counts
 * are equal, which makes a resume that reads one substream's cursor for
 * another distinguishable from a correct one. The counts themselves are
 * argued in docs/DECISION_LOG.md.
 */
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
 * The counts `WEIGHTED_DRAW_COUNT` weighted draws from `RUN_SEED`'s spawn-value
 * substream resolve to, against the distribution `createDefaultRulesConfig()`
 * declares. Exact counts, not a tolerance; the substream is seeded, so the
 * tally is fixed. Argued in docs/DECISION_LOG.md.
 */
const WEIGHTED_DRAW_TALLY: Readonly<Record<number, number>> = Object.freeze({
  2: 883,
  4: 117,
});

/** Every backing store a test built, emptied by the teardown below. */
const trackedStorages: MemoryStorage[] = [];

/**
 * A reporter that keeps every RNG refusal it is handed. Section 8 reads
 * `rejections` to assert what a repaired cursor map reported; a sink that
 * discarded its argument would leave the restore path unobserved.
 */
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
 * The one sequence the requirement is about. Every assertion below reads its
 * result rather than repeating the steps, so a step that stops being exercised
 * cannot go unnoticed in one test while others still pass.
 *
 * @param counts Draws to take before persisting.
 * @returns The advanced streams, the persisted cursor, the load result and the
 *   streams recreated from what was loaded.
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
 * @returns The uninterrupted streams, standing where the resume should stand.
 */
function reference(
  counts: Readonly<Record<StreamName, number>> = DRAWS_BEFORE_SAVE
): RngStreams {
  const streams = createRngStreams(RUN_SEED);

  advance(streams, counts);

  return streams;
}

/**
 * Every key this suite may have written, as one list with no repeat.
 * `BEST_SCORE_KEY` is named beside `OWNED_STORAGE_KEYS` although the latter
 * already contains it, so the frozen key is removed even were the owned list to
 * stop carrying it. js/local_storage_manager.js L61-L63 removed the board
 * snapshot and never the best score.
 */
const CLEARED_STORAGE_KEYS: readonly string[] = Object.freeze([
  ...new Set<string>([...OWNED_STORAGE_KEYS, BEST_SCORE_KEY]),
]);

/**
 * Empties and forgets every backing store a test built. Idempotent and total:
 * removing an absent key is a no-op on `MemoryStorage`, so this composes with
 * the teardown the shared setup file of vitest.config.ts registers and runs
 * safely twice.
 */
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

/* ===== 2. The four substreams and the shape of the persisted map ===== */

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

/* ===== 3. What the persisted count counts ===== */

/**
 * Takes `WEIGHTED_DRAW_COUNT` weighted selections from `stream` against the
 * configured spawn distribution, tallying what was selected.
 *
 * Replaces js/game_manager.js L71, `Math.random() < 0.9 ? 2 : 4`. The values
 * and weights are read from `createDefaultRulesConfig()` rather than restated.
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

    // Replaces js/grid.js L41, `cells[Math.floor(Math.random() *
    // cells.length)]`. The list is written in the x-outer, y-inner order
    // `Grid.prototype.eachCell` built it in at js/grid.js L45-L64.
    const cells = ['0,0', '0,1', '0,2', '0,3'];
    const chosen = stream.pick(cells);

    expect(cells).toContain(chosen);
    expect(stream.cursor).toBe(1);
  });

  it('does not rise for a selection from an empty list', () => {
    const stream = createRngStreams(RUN_SEED).stream('spawn-position');

    // js/grid.js L37-L43: `randomAvailableCell` fell through and returned
    // undefined on a full board, the `if (cells.length)` guard at L40 having no
    // else branch.
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

/* ===== 4. The cursor survives the store ===== */

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

/* ===== 5. A recreated run continues the sequence ===== */

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

    // Were the persisted cursor dropped, these would be equal and the reload
    // would replay the run's opening draws.
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

/** Draws read from the ambient generator when its behaviour is measured. */
const AMBIENT_DRAW_COUNT = 8;

/**
 * Reads `AMBIENT_DRAW_COUNT` draws from the ambient `Math.random`. Used only by
 * section 9, on the generator itself rather than for any expected value: no
 * assertion in this file derives test data from it.
 *
 * @returns The values read, in draw order.
 */
function ambientDraws(): number[] {
  const drawn: number[] = [];

  for (let index = 0; index < AMBIENT_DRAW_COUNT; index += 1) {
    drawn.push(Math.random());
  }

  return drawn;
}

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

/* ===== 6. Every substream resumes independently ===== */

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

/* ===== 7. The relic-draw stream: identical offers across a reload ===== */

describe('relic offers reproduce across a reload', () => {
  /**
   * Draws three distinct entries without replacement, the way a reward offer is
   * assembled: one draw per selection from the relic-draw substream.
   *
   * @param streams Substreams to draw from.
   * @param pool Candidates to select from.
   * @returns The three selected identifiers, in selection order.
   */
  function offerThree(streams: RngStreams, pool: readonly string[]): string[] {
    const remaining = [...pool];
    const offered: string[] = [];
    const stream = streams.stream('relic-draw');

    for (let index = 0; index < 3; index += 1) {
      const chosen = stream.nextInt(remaining.length);

      offered.push(remaining[chosen]);
      remaining.splice(chosen, 1);
    }

    return offered;
  }

  const POOL: readonly string[] = Object.freeze([
    'relic-a',
    'relic-b',
    'relic-c',
    'relic-d',
    'relic-e',
    'relic-f',
    'relic-g',
    'relic-h',
  ]);

  it('offers the same three relics a resumed run would have offered', () => {
    const { resumed } = roundTrip();

    expect(offerThree(resumed, POOL)).toEqual(offerThree(reference(), POOL));
  });

  it('offers a different set after the reload than at the run start', () => {
    const { resumed } = roundTrip();

    expect(offerThree(resumed, POOL)).not.toEqual(
      offerThree(createRngStreams(RUN_SEED), POOL)
    );
  });

  it('leaves the spawn substreams unmoved by a reward draw', () => {
    const { resumed } = roundTrip();

    offerThree(resumed, POOL);

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

/* ===== 8. A partial or absent cursor map still resumes ===== */

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

/* ===== 9. The invariants the resume must not break ===== */

describe('the resume leaves the run RNG contract intact', () => {
  it('never patches Math.random, across the whole resume cycle', () => {
    const straight = createSeededRng(RUN_SEED);

    straight.next();

    const { resumed } = roundTrip();

    drawEach(resumed, DRAWS_AFTER_RESUME);

    // The invariant Figure 7 (Seeded Determinism) of
    // docs/architecture/data-flow.md publishes as a guard node. Compared by
    // identity against the reference read at module scope: a generator
    // installed over the built-in would still answer `typeof 'function'`.
    expect(Math.random).toBe(PLATFORM_MATH_RANDOM);
  });

  it('leaves Math.random unseeded after a seeded run is built', () => {
    const before = ambientDraws();

    createSeededRng(RUN_SEED);
    createRngStreams(RUN_SEED);
    roundTrip();

    const after = ambientDraws();

    expect(new Set(before).size).toBeGreaterThan(1);
    expect(after).not.toEqual(before);
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
