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
//   the absence of any persisted draw position at all
//                                      js/local_storage_manager.js L52-L59
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
// Coverage boundaries this suite stays inside: the substream derivation and the
// draw arithmetic are tests/unit/rng/*.test.ts, the schema is
// tests/unit/run/run-state.test.ts, and the store's verdicts and failure paths
// are tests/unit/run/run-state-store.test.ts.
//
// Decisions behind this file: docs/DECISION_LOG.md.

import { afterEach, describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import type { SerializedGameState } from '../../../src/engine/types';
import {
  MAX_RNG_CURSOR,
  RNG_STREAM_NAMES,
  createRngStreams,
} from '../../../src/rng/rng-streams';
import type {
  RngCursorMap,
  RngStreams,
  StreamName,
} from '../../../src/rng/rng-streams';
import { createFreshRunState } from '../../../src/run/run-state';
import type {
  PersistedStageGoal,
  RunStateLoadResult,
} from '../../../src/run/run-state-store';
import { RunStateStore } from '../../../src/run/run-state-store';
import type { RunState } from '../../../src/run/run-state';
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

const RUN_SEED = 'cursor-resume-seed';

const RUN_ID = 'run-cursor-0001';

const CORRELATION_ID = 'run-correlation-cursor';

const STAGE_GOAL: PersistedStageGoal = {
  kind: 'highest-tile',
  target: 16,
};

/**
 * Draws taken from each substream before the run is persisted. Deliberately
 * unequal, so a resume that reads one substream's cursor for another is caught
 * rather than passing by coincidence.
 */
const DRAWS_BEFORE_SAVE: Readonly<Record<StreamName, number>> = Object.freeze({
  'spawn-value': 5,
  'spawn-position': 3,
  'relic-draw': 7,
  'rarity-weight': 2,
});

/** Draws compared after the resume, per substream. */
const DRAWS_AFTER_RESUME = 6;

/** Every backing store a test built, emptied by the teardown below. */
const trackedStorages: MemoryStorage[] = [];

function buildBoard(): SerializedGameState {
  return copyBoard(MERGE_PAIR_BOARD);
}

/**
 * One test's world: the store under test and the backing storage it writes to.
 */
interface World {
  readonly store: RunStateStore;
  readonly storage: MemoryStorage;
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

  return {
    storage,
    store: new RunStateStore({
      storage: port,
      config: createDefaultRulesConfig(),
      correlationId: CORRELATION_ID,
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

afterEach(() => {
  for (const storage of trackedStorages) {
    for (const key of OWNED_STORAGE_KEYS) {
      storage.removeItem(key);
    }
  }

  trackedStorages.length = 0;
});

/* ===== 2. The cursor survives the store ===== */

describe('the persisted cursor records where every substream stood', () => {
  it('carries a distinct count for each of the four substreams', () => {
    const { savedCursor } = roundTrip();

    for (const name of RNG_STREAM_NAMES) {
      expect(savedCursor[name]).toBe(DRAWS_BEFORE_SAVE[name]);
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

/* ===== 3. A recreated run continues the sequence ===== */

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
        expect(continued[name]).toEqual(expected[name]);
      }
    });

  it('does not restart: the resumed draws differ from a fresh run', () => {
    const { resumed } = roundTrip();
    const continued = drawEach(resumed, DRAWS_AFTER_RESUME);
    const restarted = drawEach(createRngStreams(RUN_SEED), DRAWS_AFTER_RESUME);

    // The whole point of persisting the cursor. Were it dropped, these would
    // be equal and the reload would silently replay the run's opening draws.
    for (const name of RNG_STREAM_NAMES) {
      expect(continued[name]).not.toEqual(restarted[name]);
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
      expect(resumed.stream(name).cursor).toBe(
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

/* ===== 4. Every substream resumes independently ===== */

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

  it('keeps the four substreams distinct after a resume', () => {
    const { resumed } = roundTrip(zeroCursor());
    const opening = RNG_STREAM_NAMES.map((name) =>
      resumed.stream(name).next()
    );

    expect(new Set(opening).size).toBe(RNG_STREAM_NAMES.length);
  });
});

/* ===== 5. The relic-draw stream: identical offers across a reload ===== */

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

  it('offers no duplicate within one set of three', () => {
    const { resumed } = roundTrip();
    const offered = offerThree(resumed, POOL);

    expect(new Set(offered).size).toBe(3);
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

/* ===== 6. A cursor the store had to repair still resumes ===== */

describe('a repaired cursor resumes without throwing', () => {
  /**
   * Writes a raw payload whose `rngCursor` is `cursor`, then loads it.
   *
   * @param cursor Value to store under `rngCursor`, valid or not.
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

  it('zeroes a substream an older payload never carried', () => {
    const { loaded } = loadWithCursor({ 'spawn-value': 4 });
    const state = loaded.state as RunState;

    expect(state.rngCursor['spawn-value']).toBe(4);

    const resumed = createRngStreams(state.seed, state.rngCursor);
    const counts: Partial<Record<StreamName, number>> = zeroCursor();

    counts['spawn-value'] = 4;

    expect(drawEach(resumed, 3)).toEqual(
      drawEach(reference(counts as Record<StreamName, number>), 3)
    );
  });

  it('drops a substream name this build does not know', () => {
    const { loaded } = loadWithCursor({
      'spawn-value': 2,
      'ghost-stream': 99,
    });

    expect(Object.keys(loaded.state?.rngCursor ?? {})).not.toContain(
      'ghost-stream'
    );
  });

  it('zeroes an unusable count rather than refusing the run', () => {
    for (const unusable of [-1, 1.5, Number.NaN, 'seven', null]) {
      const { loaded } = loadWithCursor({
        'spawn-value': unusable,
        'spawn-position': 3,
        'relic-draw': 0,
        'rarity-weight': 0,
      });
      const state = loaded.state as RunState;

      expect(state.rngCursor['spawn-value']).toBe(0);
      expect(state.rngCursor['spawn-position']).toBe(3);
      expect(() => createRngStreams(state.seed, state.rngCursor)).not.toThrow();
    }
  });

  it('zeroes a count above the bound a fast-forward can absorb', () => {
    const { loaded } = loadWithCursor({
      'spawn-value': MAX_RNG_CURSOR + 1,
      'spawn-position': 0,
      'relic-draw': 0,
      'rarity-weight': 0,
    });
    const state = loaded.state as RunState;

    expect(state.rngCursor['spawn-value']).toBe(0);

    const resumed = createRngStreams(state.seed, state.rngCursor);

    expect(resumed.stream('spawn-value').next()).toBe(
      createRngStreams(RUN_SEED).stream('spawn-value').next()
    );
  });

  it('resumes from a cursor member that is absent altogether', () => {
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

/* ===== 7. The invariants the resume must not break ===== */

describe('the resume leaves the run RNG contract intact', () => {
  it('never patches Math.random', () => {
    const original = Math.random;
    const { resumed } = roundTrip();

    drawEach(resumed, DRAWS_AFTER_RESUME);

    expect(Math.random).toBe(original);
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
