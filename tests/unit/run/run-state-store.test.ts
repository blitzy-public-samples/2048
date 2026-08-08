// Store suite of src/run/run-state-store.ts: the guarded loader, the version
// migration path, the corruption-tolerance policy and the namespaced-key
// isolation. AAP Contract 5 (0.6.1.5), AAP 0.4.1.3, requirement R6, and the
// guarded-loader half of implicit requirement I5. The write-failure path
// discharges implicit requirement I13.
//
// Superseded constructs this suite is the named verification target for, in
// docs/TRACEABILITY_MATRIX.md order:
//   LocalStorageManager.prototype.getGameState
//                                    js/local_storage_manager.js L52-L55, the
//                                    unguarded JSON.parse at L54
//   LocalStorageManager.prototype.setGameState        L57-L59
//   LocalStorageManager.prototype.clearGameState      L61-L63
//   bestScoreKey / gameStateKey                       L22-L23
//   localStorageSupported, run once at construction   L25-L26
//   the catch that discarded its error object         L37
//   fakeStorage                                       L1-L19
//   Grid.prototype.fromState, read as state[x][y]     js/grid.js L21-L34
//   Tile.prototype.serialize                          js/tile.js L19-L27
//   GameManager.prototype.setup, one snapshot read from the constructor
//                                    js/game_manager.js L13, L36
//
// Collected by the unit:dom-free project of vitest.config.ts, environment
// 'node'. Nothing here reads a document, a Web Storage global, a clock or
// randomness; nothing installs a mock, replaces a global or writes a snapshot
// artifact. Every store under test is injected.
//
// Figure this suite is the mechanical proof of: Figure 4 (Turn Data Flow) of
// docs/architecture/data-flow.md, whose COMMIT to PERSIST edge is labelled
// "Run state written under namespaced key".
//
// Coverage boundaries this suite stays inside: the reconciliation policy
// arithmetic is tests/unit/run/board-size-reconciliation.test.ts, end-to-end
// cursor resume is tests/unit/run/rng-cursor-persistence.test.ts, the schema
// itself is tests/unit/run/run-state.test.ts, the deep copy is
// tests/unit/run/run-state-cloning.test.ts, and the frozen best-score
// accessor contract is tests/unit/storage/best-score.test.ts.
//
// Decisions behind this file: docs/DECISION_LOG.md.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import type { RulesConfig } from '../../../src/config/rules-config';
import type { SerializedGameState } from '../../../src/engine/types';
import { RNG_STREAM_NAMES } from '../../../src/rng/rng-streams';
import type { StreamName } from '../../../src/rng/rng-streams';
import {
  RUN_STATE_SCHEMA_VERSION,
  RUN_STATE_SCHEMA_VERSION_HISTORY,
  classifyRunStateVersion,
  createFreshRunState,
  isRunStateShape,
} from '../../../src/run/run-state';
import type {
  BoardSizeReconciliationReport,
  RunReporter,
  RunState,
  RunStateCorruptionReport,
  RunStateMigrationReport,
  RunStateVersionVerdict,
  RunStateWriteFailureReport,
} from '../../../src/run/run-state';
import {
  RunStateStore,
  migrateRunState,
} from '../../../src/run/run-state-store';
import type {
  PersistedStageGoal,
  RunStateLoadResult,
  RunStatePersistencePort,
} from '../../../src/run/run-state-store';
import {
  LocalStorageManager,
} from '../../../src/storage/local-storage-manager';
import type {
  StorageFailure,
  StorageReporter,
  StorageWriteInfo,
} from '../../../src/storage/local-storage-manager';
import { MemoryStorage } from '../../../src/storage/memory-storage';
import type { StorageLike } from '../../../src/storage/memory-storage';
import {
  BEST_SCORE_KEY,
  GAME_STATE_KEY,
  OWNED_STORAGE_KEYS,
  RUN_STATE_KEY,
  STORAGE_NAMESPACE,
  namespacedKey,
} from '../../../src/storage/storage-keys';
import { MERGE_PAIR_BOARD, copyBoard } from '../../fixtures/boards';

/* ===== 1. The capturing report sink ===== */

/**
 * One captured report, tagged with the channel it arrived on. The four run
 * channels are `RunReporter`'s in src/run/run-state.ts and the two storage
 * channels are `StorageReporter`'s in src/storage/local-storage-manager.ts. The
 * two interfaces share no member name, so one object satisfies both and one
 * list holds every report either declares.
 */
type CapturedReport =
  | {
      readonly channel: 'onLoadCorrupted';
      readonly report: RunStateCorruptionReport;
    }
  | {
      readonly channel: 'onVersionMigrated';
      readonly report: RunStateMigrationReport;
    }
  | {
      readonly channel: 'onBoardSizeReconciled';
      readonly report: BoardSizeReconciliationReport;
    }
  | {
      readonly channel: 'onWriteFailed';
      readonly report: RunStateWriteFailureReport;
    }
  | { readonly channel: 'onFailure'; readonly report: StorageFailure }
  | { readonly channel: 'onWrite'; readonly report: StorageWriteInfo };

type CapturedChannel = CapturedReport['channel'];

/** The report one channel carries, read off the union rather than restated. */
type ReportOn<C extends CapturedChannel> = Extract<
  CapturedReport,
  { channel: C }
>['report'];

/**
 * The three channels that carry a failure. `onWrite` is not one of them: it
 * reports every write, the successful ones included. The sink declares no
 * `onProbe` channel, so the writability probe that every
 * `LocalStorageManager` construction runs adds no record to the list.
 */
const FAILURE_CHANNELS: readonly CapturedChannel[] = [
  'onLoadCorrupted',
  'onWriteFailed',
  'onFailure',
];

/** A sink that satisfies both report contracts, plus the list it appends to. */
interface CapturingSink {
  readonly reporter: RunReporter;
  readonly storageReporter: StorageReporter;
  readonly records: CapturedReport[];
}

function createCapturingSink(): CapturingSink {
  const records: CapturedReport[] = [];

  const reporter: RunReporter = {
    onLoadCorrupted: (report) => {
      records.push({ channel: 'onLoadCorrupted', report });
    },
    onVersionMigrated: (report) => {
      records.push({ channel: 'onVersionMigrated', report });
    },
    onBoardSizeReconciled: (report) => {
      records.push({ channel: 'onBoardSizeReconciled', report });
    },
    onWriteFailed: (report) => {
      records.push({ channel: 'onWriteFailed', report });
    },
  };

  const storageReporter: StorageReporter = {
    onFailure: (report) => {
      records.push({ channel: 'onFailure', report });
    },
    onWrite: (report) => {
      records.push({ channel: 'onWrite', report });
    },
  };

  return { reporter, storageReporter, records };
}

/**
 * Every report captured on one channel, in arrival order.
 *
 * @param records List the sink appended to.
 * @param channel Channel to select.
 * @returns The reports that arrived on `channel`.
 */
function recordsOn<C extends CapturedChannel>(
  records: readonly CapturedReport[],
  channel: C
): ReportOn<C>[] {
  const found: ReportOn<C>[] = [];

  for (const entry of records) {
    if (entry.channel === channel) {
      found.push(entry.report as ReportOn<C>);
    }
  }

  return found;
}

/** Every failure captured, whichever of the three channels carried it. */
function failures(records: readonly CapturedReport[]): CapturedReport[] {
  return records.filter((entry) => FAILURE_CHANNELS.includes(entry.channel));
}

/**
 * Reduces a caught value to text an assertion can measure: `name: message` for
 * an `Error`, the value itself for a string, and the empty string for anything
 * else. Mirrors nothing in the product.
 */
function errorText(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }

  return typeof value === 'string' ? value : '';
}

/* ===== 2. The recording store, and the injected world ===== */

type StorageOperationName = 'get' | 'set' | 'remove' | 'clear';

/** One operation a store received, as the operation and the key it named. */
interface StorageTouch {
  readonly operation: StorageOperationName;
  readonly key: string;
}

/** A `StorageLike` that records every key it is asked about. */
interface RecordingStorage {
  readonly storage: StorageLike;
  readonly touches: StorageTouch[];
}

/**
 * Wraps a store so every `getItem`, `setItem`, `removeItem` and `clear` is
 * logged and then forwarded to `inner`. Every result is `inner`'s own,
 * including the `undefined` it yields for an absent key, ported from
 * js/local_storage_manager.js L8-L10.
 *
 * @param inner Store every call is forwarded to.
 * @returns The wrapper and its running log.
 */
function recordingStorage(inner: StorageLike): RecordingStorage {
  const touches: StorageTouch[] = [];

  const storage: StorageLike = {
    getItem: (key) => {
      touches.push({ operation: 'get', key });

      return inner.getItem(key);
    },
    setItem: (key, value) => {
      touches.push({ operation: 'set', key });
      inner.setItem(key, value);
    },
    removeItem: (key) => {
      touches.push({ operation: 'remove', key });
      inner.removeItem(key);
    },
    clear: () => {
      touches.push({ operation: 'clear', key: '' });
      inner.clear();
    },
  };

  return { storage, touches };
}

/** Every distinct key a recorded log names, in first-touch order. */
function touchedKeys(touches: readonly StorageTouch[]): string[] {
  const seen: string[] = [];

  for (const touch of touches) {
    if (!seen.includes(touch.key)) {
      seen.push(touch.key);
    }
  }

  return seen;
}

/** Keys a recorded log names for one operation. */
function keysTouchedBy(
  touches: readonly StorageTouch[],
  operation: StorageOperationName
): string[] {
  return touchedKeys(touches.filter((touch) => touch.operation === operation));
}

/** Raw values to seed into the store before the subject is constructed. */
type StorageSeed = Readonly<Record<string, string>>;

interface WorldOptions {
  /** Raw values written before `LocalStorageManager` is constructed. */
  readonly seed?: StorageSeed;

  /** Rules configuration the store reads `boardSize` from. */
  readonly config?: RulesConfig;

  /** Correlation identifier every report from the store carries. */
  readonly correlationId?: string;
}

/**
 * One test's world: the backing store, the recorded log, the captured reports
 * and the subject.
 */
interface World {
  readonly storage: MemoryStorage;
  readonly touches: StorageTouch[];
  readonly records: CapturedReport[];
  readonly port: LocalStorageManager;
  readonly store: RunStateStore;
}

const CORRELATION_ID = 'run-correlation-0001';

/**
 * Every backing store a test built, read by the teardown below and emptied by
 * it.
 */
const trackedStorages: MemoryStorage[] = [];

/**
 * Builds a world in the mandatory order: allocate the store, WRITE THE FIXTURE,
 * then construct `LocalStorageManager` and `RunStateStore`.
 *
 * js/local_storage_manager.js L25-L26 ran the writability probe once in the
 * constructor and fixed the store for the session, and js/game_manager.js L13
 * reached L36's single snapshot read from the constructor as well. Every test
 * in this file seeds before it constructs.
 *
 * @param options Fixture, configuration and correlation identifier.
 * @returns The world, with the subject already constructed.
 */
function createWorld(options: WorldOptions = {}): World {
  const storage = new MemoryStorage();

  trackedStorages.push(storage);

  for (const [key, value] of Object.entries(options.seed ?? {})) {
    storage.setItem(key, value);
  }

  const recording = recordingStorage(storage);
  const sink = createCapturingSink();

  const port = new LocalStorageManager({
    storage: recording.storage,
    reporter: sink.storageReporter,
  });

  const store = new RunStateStore({
    storage: port,
    reporter: sink.reporter,
    config: options.config,
    correlationId: options.correlationId ?? CORRELATION_ID,
  });

  return {
    storage,
    touches: recording.touches,
    records: sink.records,
    port,
    store,
  };
}

/**
 * Builds a store around a hand-written port, for the failure paths a
 * `LocalStorageManager` absorbs before the store can see them.
 *
 * @param port Port the store persists through.
 * @returns The store and the reports its sink captured.
 */
function createStoreOnPort(port: RunStatePersistencePort): {
  readonly store: RunStateStore;
  readonly records: CapturedReport[];
} {
  const sink = createCapturingSink();

  const store = new RunStateStore({
    storage: port,
    reporter: sink.reporter,
    correlationId: CORRELATION_ID,
  });

  return { store, records: sink.records };
}

/* ===== 3. Fixtures ===== */

const FIXTURE_RUN_ID = 'run-0001';

const FIXTURE_SEED = 'seed-42';

const FIXTURE_STAGE_INDEX = 0;

const FIXTURE_STAGE_GOAL: PersistedStageGoal = {
  kind: 'highest-tile',
  target: 16,
};

/** Values seeded under the two frozen legacy keys by the isolation tests. */
const BEST_SCORE_SENTINEL = '31337';

const GAME_STATE_SENTINEL =
  '{"grid":{"size":4,"cells":[]},"score":7,"over":false,' +
  '"won":false,"keepPlaying":false}';

/** Every verdict `RunStateVersionVerdict` declares. */
const VERSION_VERDICTS: readonly RunStateVersionVerdict[] = [
  'current',
  'older',
  'unknown',
  'absent',
  'malformed',
];

/**
 * The wrapped board snapshot, in js/game_manager.js L102-L110's key order.
 * `copyBoard()` returns a fresh unfrozen copy, sharing no cell with the frozen
 * fixture or with another call.
 */
function buildBoard(): SerializedGameState {
  return copyBoard(MERGE_PAIR_BOARD);
}

/** A valid envelope at the current schema version. */
function buildEnvelope(): RunState {
  return createFreshRunState({
    runId: FIXTURE_RUN_ID,
    seed: FIXTURE_SEED,
    rngCursor: {},
    stageIndex: FIXTURE_STAGE_INDEX,
    stageGoal: FIXTURE_STAGE_GOAL,
    board: buildBoard(),
  });
}

/**
 * A JSON projection of a valid envelope, typed loosely so a member can be
 * deleted or replaced to build a hostile payload.
 */
function loosenEnvelope(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(buildEnvelope())) as Record<
    string,
    unknown
  >;
}

/** The raw JSON text of a valid envelope. */
function envelopeJson(): string {
  return JSON.stringify(buildEnvelope());
}

/** Reads the raw string stored under the run key, or `null` when absent. */
function readRunStateRaw(storage: MemoryStorage): string | null {
  return storage.getItem(RUN_STATE_KEY) ?? null;
}

/* ===== 4. Teardown hygiene ===== */

/**
 * Best score observed at the start of the current test, read from the store the
 * hygiene section shares. `'unread'` until the first `beforeEach` runs.
 */
let bestScoreAtEntry: string | null | undefined = 'unread';

/**
 * The one store shared across tests. Section 15 seeds a best score into it in
 * one test and reads `bestScoreAtEntry` in a later one.
 */
const HYGIENE_STORAGE = new MemoryStorage();

/**
 * Removes every key the product owns, then the best-score key by name, using
 * the exported constants and no string literal.
 *
 * js/local_storage_manager.js L61-L63 removed the board snapshot and never
 * L22's best score, which is why both are named here. Idempotent:
 * `MemoryStorage.removeItem` of an absent key is a no-op, and the setup file
 * vitest.config.ts names registers an `afterEach` of its own over the real Web
 * Storage global.
 *
 * @param storage Store to clear.
 */
function clearOwnedKeysOf(storage: MemoryStorage): void {
  for (const key of OWNED_STORAGE_KEYS) {
    storage.removeItem(key);
  }

  storage.removeItem(BEST_SCORE_KEY);
}

beforeEach(() => {
  bestScoreAtEntry = HYGIENE_STORAGE.getItem(BEST_SCORE_KEY);
});

afterEach(() => {
  clearOwnedKeysOf(HYGIENE_STORAGE);

  for (const storage of trackedStorages) {
    clearOwnedKeysOf(storage);
  }

  trackedStorages.length = 0;
});

/* ===== 5. A namespaced run key beside two frozen unprefixed ones ===== */

describe('the run key is namespaced and the legacy keys are not', () => {
  it('is exactly the namespaced runState key', () => {
    expect(RUN_STATE_KEY).toBe('roguelike2048:runState');
  });

  it('is composed from the namespace by namespacedKey', () => {
    expect(RUN_STATE_KEY).toBe(namespacedKey('runState'));
    expect(RUN_STATE_KEY.startsWith(`${STORAGE_NAMESPACE}:`)).toBe(true);
  });

  // js/local_storage_manager.js L22-L23.
  it('leaves the best-score key as the frozen unprefixed literal', () => {
    expect(BEST_SCORE_KEY).toBe('bestScore');
    expect(BEST_SCORE_KEY.startsWith(`${STORAGE_NAMESPACE}:`)).toBe(false);
  });

  it('leaves the game-state key as the frozen unprefixed literal', () => {
    expect(GAME_STATE_KEY).toBe('gameState');
    expect(GAME_STATE_KEY.startsWith(`${STORAGE_NAMESPACE}:`)).toBe(false);
  });

  it('registers all three owned keys, the run key among them', () => {
    expect(OWNED_STORAGE_KEYS).toContain(BEST_SCORE_KEY);
    expect(OWNED_STORAGE_KEYS).toContain(GAME_STATE_KEY);
    expect(OWNED_STORAGE_KEYS).toContain(RUN_STATE_KEY);
  });
});

/* ===== 6. Run-state operations touch the run key and nothing else ===== */

describe('run-state operations never touch the two legacy keys', () => {
  /**
   * Seeds both legacy keys before construction, then walks the store's whole
   * surface. Figure 4's COMMIT to PERSIST edge is the property under test.
   */
  function walkTheStore(): World {
    const world = createWorld({
      seed: {
        [BEST_SCORE_KEY]: BEST_SCORE_SENTINEL,
        [GAME_STATE_KEY]: GAME_STATE_SENTINEL,
      },
    });

    world.store.save(buildEnvelope());
    world.store.load();
    world.store.exists();
    world.store.clear();

    return world;
  }

  it('names only the run key across save, load, exists and clear', () => {
    const world = walkTheStore();

    expect(touchedKeys(world.touches)).toEqual([RUN_STATE_KEY]);
  });

  it('never reads the best-score key', () => {
    const world = walkTheStore();

    expect(touchedKeys(world.touches)).not.toContain(BEST_SCORE_KEY);
  });

  it('never reads the game-state key', () => {
    const world = walkTheStore();

    expect(touchedKeys(world.touches)).not.toContain(GAME_STATE_KEY);
  });

  it('writes and removes the run key alone', () => {
    const world = walkTheStore();

    expect(keysTouchedBy(world.touches, 'set')).toEqual([RUN_STATE_KEY]);
    expect(keysTouchedBy(world.touches, 'remove')).toEqual([RUN_STATE_KEY]);
  });

  it('never clears the whole store', () => {
    const world = walkTheStore();

    expect(keysTouchedBy(world.touches, 'clear')).toEqual([]);
  });

  it('leaves the seeded best score byte-identical', () => {
    const world = walkTheStore();

    expect(world.storage.getItem(BEST_SCORE_KEY)).toBe(BEST_SCORE_SENTINEL);
  });

  it('leaves the seeded game state byte-identical', () => {
    const world = walkTheStore();

    expect(world.storage.getItem(GAME_STATE_KEY)).toBe(GAME_STATE_SENTINEL);
  });

  it('writes valid JSON that parses back to the saved envelope', () => {
    const world = createWorld();
    const saved = buildEnvelope();

    expect(world.store.save(saved)).toBe(true);

    const raw = readRunStateRaw(world.storage);

    expect(typeof raw).toBe('string');

    const parsed: unknown = JSON.parse(raw ?? '');

    expect(parsed).toEqual(saved);
    expect(isRunStateShape(parsed)).toBe(true);
  });

  it('round-trips a saved cursor map as data', () => {
    const cursor: Record<StreamName, number> = {
      'spawn-value': 11,
      'spawn-position': 12,
      'relic-draw': 13,
      'rarity-weight': 14,
    };
    const world = createWorld();

    expect(world.store.save({ ...buildEnvelope(), rngCursor: cursor })).toBe(
      true
    );

    expect(world.store.load().state?.rngCursor).toEqual(cursor);
  });
});

/* ===== 7. The guarded loader never throws: the five verdicts ===== */

describe("a current envelope loads and reports the 'loaded' outcome", () => {
  function loadCurrent(): { world: World; result: RunStateLoadResult } {
    const world = createWorld({
      seed: { [RUN_STATE_KEY]: envelopeJson() },
      config: createDefaultRulesConfig(),
    });

    return { world, result: world.store.load() };
  }

  it('does not throw', () => {
    const world = createWorld({
      seed: { [RUN_STATE_KEY]: envelopeJson() },
      config: createDefaultRulesConfig(),
    });

    expect(() => world.store.load()).not.toThrow();
  });

  it("classifies the payload as 'current'", () => {
    expect(loadCurrent().result.verdict).toBe('current');
  });

  it("reports the 'loaded' outcome", () => {
    expect(loadCurrent().result.outcome).toBe('loaded');
  });

  it('returns a state deep-equal to the one that was saved', () => {
    expect(loadCurrent().result.state).toEqual(buildEnvelope());
  });

  it('returns a structurally complete envelope at the current version', () => {
    const { result } = loadCurrent();

    expect(isRunStateShape(result.state)).toBe(true);
    expect(result.state?.schemaVersion).toBe(RUN_STATE_SCHEMA_VERSION);
  });

  it('reports no failure on any channel', () => {
    expect(failures(loadCurrent().world.records)).toEqual([]);
  });

  it('hands back a copy the store no longer shares', () => {
    const { world, result } = loadCurrent();
    const second = world.store.load();

    expect(result.state).not.toBe(second.state);
    expect(result.state).toEqual(second.state);
  });
});

describe('an unversioned envelope migrates to the current version', () => {
  /**
   * A payload written under the run key before the `schemaVersion` member
   * existed. `classifyRunStateVersion()` reduces it to `'absent'`, which is the
   * migration path this build reaches from storage: the history holds exactly
   * one version, so no stored integer classifies as `'older'`.
   */
  function seedUnversioned(): World {
    const payload = loosenEnvelope();

    delete payload.schemaVersion;

    return createWorld({
      seed: { [RUN_STATE_KEY]: JSON.stringify(payload) },
      config: createDefaultRulesConfig(),
    });
  }

  it('does not throw', () => {
    const world = seedUnversioned();

    expect(() => world.store.load()).not.toThrow();
  });

  it("classifies a payload carrying no version as 'absent'", () => {
    const payload = loosenEnvelope();

    delete payload.schemaVersion;

    expect(classifyRunStateVersion(payload)).toBe('absent');
  });

  it("reports the 'migrated' outcome", () => {
    expect(seedUnversioned().store.load().outcome).toBe('migrated');
  });

  it('stamps the returned state with the current schema version', () => {
    const state = seedUnversioned().store.load().state;

    expect(state?.schemaVersion).toBe(RUN_STATE_SCHEMA_VERSION);
  });

  it('returns a state that passes isRunStateShape', () => {
    expect(isRunStateShape(seedUnversioned().store.load().state)).toBe(true);
  });

  it('preserves the wrapped board snapshot verbatim', () => {
    expect(seedUnversioned().store.load().state?.board).toEqual(buildBoard());
  });

  it('preserves every other envelope member verbatim', () => {
    const state = seedUnversioned().store.load().state;

    expect(state?.runId).toBe(FIXTURE_RUN_ID);
    expect(state?.seed).toBe(FIXTURE_SEED);
    expect(state?.stageIndex).toBe(FIXTURE_STAGE_INDEX);
    expect(state?.stageGoal).toEqual(FIXTURE_STAGE_GOAL);
    expect(state?.relics).toEqual([]);
  });

  it('reports the migration with the version it arrived at', () => {
    const world = seedUnversioned();

    world.store.load();

    const reports = recordsOn(world.records, 'onVersionMigrated');

    expect(reports).toHaveLength(1);
    expect(reports[0]?.toVersion).toBe(RUN_STATE_SCHEMA_VERSION);
    expect(reports[0]?.fromVersion).toBeUndefined();
    expect(reports[0]?.correlationId).toBe(CORRELATION_ID);
  });

  it('reports no failure, a migration being a success', () => {
    const world = seedUnversioned();

    world.store.load();

    expect(failures(world.records)).toEqual([]);
  });
});

describe('the version history decides which payload migrates', () => {
  /**
   * Stamps a valid envelope at `version` and reads it back. Every caller drives
   * it from `RUN_STATE_SCHEMA_VERSION_HISTORY`, so a version added to that list
   * is covered with no edit here.
   */
  function loadStampedAt(version: number): RunStateLoadResult {
    const payload = loosenEnvelope();

    payload.schemaVersion = version;

    const world = createWorld({
      seed: { [RUN_STATE_KEY]: JSON.stringify(payload) },
      config: createDefaultRulesConfig(),
    });

    return world.store.load();
  }

  it('lists the current version', () => {
    expect(RUN_STATE_SCHEMA_VERSION_HISTORY).toContain(
      RUN_STATE_SCHEMA_VERSION
    );
  });

  it('lists integers in ascending order', () => {
    const history = [...RUN_STATE_SCHEMA_VERSION_HISTORY];

    for (const version of history) {
      expect(Number.isInteger(version)).toBe(true);
    }

    expect(history).toEqual([...history].sort((left, right) => left - right));
  });

  it('reads every listed version without throwing', () => {
    for (const version of RUN_STATE_SCHEMA_VERSION_HISTORY) {
      expect(() => loadStampedAt(version)).not.toThrow();
    }
  });

  it('returns every listed version at the current version', () => {
    for (const version of RUN_STATE_SCHEMA_VERSION_HISTORY) {
      const result = loadStampedAt(version);

      expect(result.state?.schemaVersion).toBe(RUN_STATE_SCHEMA_VERSION);
      expect(isRunStateShape(result.state)).toBe(true);
    }
  });

  it('preserves the board snapshot verbatim at every listed version', () => {
    for (const version of RUN_STATE_SCHEMA_VERSION_HISTORY) {
      expect(loadStampedAt(version).state?.board).toEqual(buildBoard());
    }
  });

  it("classifies the current version 'current' and the rest 'older'", () => {
    for (const version of RUN_STATE_SCHEMA_VERSION_HISTORY) {
      const expected =
        version === RUN_STATE_SCHEMA_VERSION ? 'current' : 'older';

      expect(loadStampedAt(version).verdict).toBe(expected);
    }
  });

  it("reports 'migrated' for a listed version below the current one", () => {
    for (const version of RUN_STATE_SCHEMA_VERSION_HISTORY) {
      if (version === RUN_STATE_SCHEMA_VERSION) {
        continue;
      }

      expect(loadStampedAt(version).outcome).toBe('migrated');
    }
  });

  it("reports 'loaded' for the current version", () => {
    expect(loadStampedAt(RUN_STATE_SCHEMA_VERSION).outcome).toBe('loaded');
  });

  it('refuses a version the history does not list', () => {
    const unlisted = Math.max(...RUN_STATE_SCHEMA_VERSION_HISTORY) + 1;
    const result = loadStampedAt(unlisted);

    expect(result.verdict).toBe('unknown');
    expect(result.outcome).toBe('fresh-fallback');
  });
});

describe('a legacy board snapshot is wrapped rather than refused', () => {
  /** js/local_storage_manager.js L57-L59 wrote exactly this shape. */
  function seedLegacyBoard(): World {
    return createWorld({
      seed: { [RUN_STATE_KEY]: JSON.stringify(buildBoard()) },
      config: createDefaultRulesConfig(),
    });
  }

  it('does not throw with an identity supplied', () => {
    const world = seedLegacyBoard();

    expect(() =>
      world.store.load({
        runId: FIXTURE_RUN_ID,
        seed: FIXTURE_SEED,
        stageGoal: FIXTURE_STAGE_GOAL,
      })
    ).not.toThrow();
  });

  it("reports the 'migrated' outcome and wraps the board verbatim", () => {
    const result = seedLegacyBoard().store.load({
      runId: FIXTURE_RUN_ID,
      seed: FIXTURE_SEED,
      stageGoal: FIXTURE_STAGE_GOAL,
    });

    expect(result.outcome).toBe('migrated');
    expect(result.state?.board).toEqual(buildBoard());
    expect(result.state?.schemaVersion).toBe(RUN_STATE_SCHEMA_VERSION);
  });

  it('falls back to a fresh run when no identity is supplied', () => {
    const world = seedLegacyBoard();

    expect(() => world.store.load()).not.toThrow();

    const result = world.store.load();

    expect(result.outcome).toBe('fresh-fallback');
    expect(result.state).toBeNull();
    expect(result.problems?.length).toBeGreaterThan(0);
  });
});

describe('a future schema version is tolerated without throwing', () => {
  const FUTURE_VERSION = RUN_STATE_SCHEMA_VERSION + 98;

  function seedFuture(): World {
    return createWorld({
      seed: {
        [RUN_STATE_KEY]: JSON.stringify({
          ...loosenEnvelope(),
          schemaVersion: FUTURE_VERSION,
        }),
      },
      config: createDefaultRulesConfig(),
    });
  }

  it('does not throw', () => {
    const world = seedFuture();

    expect(() => world.store.load()).not.toThrow();
  });

  it("classifies a version the history does not list as 'unknown'", () => {
    expect(RUN_STATE_SCHEMA_VERSION_HISTORY).not.toContain(FUTURE_VERSION);
    expect(seedFuture().store.load().verdict).toBe('unknown');
  });

  it("falls back to a fresh run rather than half-loading it", () => {
    const result = seedFuture().store.load();

    expect(result.outcome).toBe('fresh-fallback');
    expect(result.state).toBeNull();
  });

  it('carries a problem list, empty for a version-only refusal', () => {
    const result = seedFuture().store.load();

    expect(Array.isArray(result.problems)).toBe(true);
  });

  it('reports the refusal with the key and the verdict', () => {
    const world = seedFuture();

    world.store.load();

    const reports = recordsOn(world.records, 'onLoadCorrupted');

    expect(reports).toHaveLength(1);
    expect(reports[0]?.key).toBe(RUN_STATE_KEY);
    expect(reports[0]?.verdict).toBe('unknown');
    expect(reports[0]?.correlationId).toBe(CORRELATION_ID);
  });
});

describe('an absent run key is not a failure', () => {
  it('does not throw', () => {
    const world = createWorld();

    expect(() => world.store.load()).not.toThrow();
  });

  it("reports the 'absent' outcome with a null state", () => {
    const result = createWorld().store.load();

    expect(result.outcome).toBe('absent');
    expect(result.verdict).toBe('absent');
    expect(result.state).toBeNull();
  });

  it('attaches no reconciliation record', () => {
    expect(createWorld().store.load().reconciliation).toBeUndefined();
  });

  it('answers exists with false', () => {
    expect(createWorld().store.exists()).toBe(false);
  });

  it('reports nothing on any failure channel', () => {
    const world = createWorld();

    world.store.load();
    world.store.exists();

    expect(failures(world.records)).toEqual([]);
  });

  // js/local_storage_manager.js L54 treated a stored empty string as falsy.
  it("reads a stored empty string as absent", () => {
    const world = createWorld({ seed: { [RUN_STATE_KEY]: '' } });

    expect(() => world.store.load()).not.toThrow();
    expect(world.store.load().outcome).toBe('absent');
    expect(world.store.exists()).toBe(false);
    expect(failures(world.records)).toEqual([]);
  });
});

/* ===== 8. Three corruption classes, none of them throwing ===== */

/**
 * A raw string that cannot parse at all. The direct successor of the defect at
 * js/local_storage_manager.js L54, where the stored text reached `JSON.parse`
 * with no guard and threw during startup.
 */
const UNPARSABLE_RAW = '{not json';

/**
 * Raw strings that parse to something other than an object. `MemoryStorage`
 * preserves the `String(value)` coercion of js/local_storage_manager.js L4-L6,
 * so any of these can end up stored.
 */
const PRIMITIVE_RAW: readonly string[] = ['42', '"text"', 'true', 'null'];

/**
 * Envelopes that parse to an object and still fail `isRunStateShape`.
 *
 * `rngCursor` is deliberately absent from this set: a cursor member that is not
 * a map passes through `normalizeRngCursor()` and is completed rather than
 * refused, which the section below asserts as its own behaviour.
 */
function structurallyWrongPayloads(): readonly Record<string, unknown>[] {
  const withoutBoard = loosenEnvelope();

  delete withoutBoard.board;

  const relicsNotArray = loosenEnvelope();

  relicsNotArray.relics = 'none';

  const stageGoalIsString = loosenEnvelope();

  stageGoalIsString.stageGoal = 'highest-tile';

  const cellsNotArray = loosenEnvelope();

  cellsNotArray.board = { ...buildBoard(), grid: { size: 4, cells: 'rows' } };

  const holeInMatrix = loosenEnvelope();
  const holed = buildBoard();

  // js/grid.js L109 wrote null for an empty cell, never a string.
  holed.grid.cells[0] = ['tile', null, null, null] as never;
  holeInMatrix.board = holed;

  return [
    withoutBoard,
    relicsNotArray,
    stageGoalIsString,
    cellsNotArray,
    holeInMatrix,
  ];
}

describe('a stored value that cannot be parsed falls back to fresh', () => {
  function seedUnparsable(): World {
    return createWorld({ seed: { [RUN_STATE_KEY]: UNPARSABLE_RAW } });
  }

  it('does not throw where js/local_storage_manager.js L54 did', () => {
    const world = seedUnparsable();

    expect(() => world.store.load()).not.toThrow();
  });

  it("reports the 'fresh-fallback' outcome with a null state", () => {
    const result = seedUnparsable().store.load();

    expect(result.outcome).toBe('fresh-fallback');
    expect(result.state).toBeNull();
  });

  it('diagnoses the refusal', () => {
    const result = seedUnparsable().store.load();

    expect(result.problems?.length).toBeGreaterThan(0);
  });

  it('reports the refusal on the run channel with the failing key', () => {
    const world = seedUnparsable();

    world.store.load();

    const reports = recordsOn(world.records, 'onLoadCorrupted');

    expect(reports).toHaveLength(1);
    expect(reports[0]?.key).toBe(RUN_STATE_KEY);
    expect(reports[0]?.problems.length).toBeGreaterThan(0);
    expect(reports[0]?.correlationId).toBe(CORRELATION_ID);
  });

  it('carries the caught parse error, which L37 discarded', () => {
    const world = seedUnparsable();

    world.store.load();

    const reports = recordsOn(world.records, 'onFailure');
    const parseFailure = reports.find((entry) => entry.operation === 'read');

    expect(parseFailure).toBeDefined();
    expect(parseFailure?.key).toBe(RUN_STATE_KEY);
    expect(errorText(parseFailure?.thrown)).toContain('SyntaxError');
    expect(parseFailure?.error.name.length).toBeGreaterThan(0);
    expect(parseFailure?.error.message.length).toBeGreaterThan(0);
  });

  it('leaves the unreadable value in place and tolerates a second read', () => {
    const world = seedUnparsable();
    const first = world.store.load();

    expect(readRunStateRaw(world.storage)).toBe(UNPARSABLE_RAW);
    expect(() => world.store.load()).not.toThrow();

    const second = world.store.load();

    expect(second.outcome).toBe(first.outcome);
    expect(second.verdict).toBe(first.verdict);
    expect(second.problems).toEqual(first.problems);
  });
});

describe('a stored JSON primitive falls back to a fresh run', () => {
  for (const raw of PRIMITIVE_RAW) {
    it(`does not throw for ${raw}`, () => {
      const world = createWorld({ seed: { [RUN_STATE_KEY]: raw } });

      expect(() => world.store.load()).not.toThrow();
    });

    it(`reports the 'fresh-fallback' outcome for ${raw}`, () => {
      const world = createWorld({ seed: { [RUN_STATE_KEY]: raw } });
      const result = world.store.load();

      expect(result.outcome).toBe('fresh-fallback');
      expect(result.state).toBeNull();
      expect(result.problems?.length).toBeGreaterThan(0);
    });

    it(`reports the refusal with usable detail for ${raw}`, () => {
      const world = createWorld({ seed: { [RUN_STATE_KEY]: raw } });

      world.store.load();

      const reports = recordsOn(world.records, 'onLoadCorrupted');

      expect(reports).toHaveLength(1);
      expect(reports[0]?.key).toBe(RUN_STATE_KEY);
      expect(reports[0]?.problems.length).toBeGreaterThan(0);
    });

    it(`leaves ${raw} in place and stays idempotent`, () => {
      const world = createWorld({ seed: { [RUN_STATE_KEY]: raw } });
      const first = world.store.load();

      expect(readRunStateRaw(world.storage)).toBe(raw);

      const second = world.store.load();

      expect(second.outcome).toBe(first.outcome);
      expect(second.verdict).toBe(first.verdict);
    });
  }

  it('classifies a non-object payload as malformed or absent', () => {
    for (const raw of PRIMITIVE_RAW) {
      const parsed: unknown = JSON.parse(raw);
      const verdict = classifyRunStateVersion(parsed);

      expect(['malformed', 'absent']).toContain(verdict);
    }
  });
});

describe('a structurally wrong object falls back to a fresh run', () => {
  it('does not throw for any of the five malformations', () => {
    for (const payload of structurallyWrongPayloads()) {
      const world = createWorld({
        seed: { [RUN_STATE_KEY]: JSON.stringify(payload) },
      });

      expect(() => world.store.load()).not.toThrow();
    }
  });

  it("reports the 'fresh-fallback' outcome for each", () => {
    for (const payload of structurallyWrongPayloads()) {
      const world = createWorld({
        seed: { [RUN_STATE_KEY]: JSON.stringify(payload) },
      });
      const result = world.store.load();

      expect(result.outcome).toBe('fresh-fallback');
      expect(result.state).toBeNull();
    }
  });

  it('names the failing member in the diagnosis for each', () => {
    for (const payload of structurallyWrongPayloads()) {
      const world = createWorld({
        seed: { [RUN_STATE_KEY]: JSON.stringify(payload) },
      });
      const result = world.store.load();

      expect(result.problems?.length).toBeGreaterThan(0);
      expect(isRunStateShape(payload)).toBe(false);
    }
  });

  it('reports the refusal with the key and the diagnosis for each', () => {
    for (const payload of structurallyWrongPayloads()) {
      const world = createWorld({
        seed: { [RUN_STATE_KEY]: JSON.stringify(payload) },
      });

      world.store.load();

      const reports = recordsOn(world.records, 'onLoadCorrupted');

      expect(reports).toHaveLength(1);
      expect(reports[0]?.key).toBe(RUN_STATE_KEY);
      expect(reports[0]?.problems.length).toBeGreaterThan(0);
      expect(reports[0]?.problems.join(' ').length).toBeGreaterThan(0);
    }
  });

  it('names board as the failing member when board is missing', () => {
    const payload = loosenEnvelope();

    delete payload.board;

    const world = createWorld({
      seed: { [RUN_STATE_KEY]: JSON.stringify(payload) },
    });
    const result = world.store.load();

    expect(result.problems?.join(' ')).toContain('board');
  });

  it('leaves the refused value in place and stays idempotent', () => {
    const payload = loosenEnvelope();

    delete payload.board;

    const raw = JSON.stringify(payload);
    const world = createWorld({ seed: { [RUN_STATE_KEY]: raw } });
    const first = world.store.load();

    expect(readRunStateRaw(world.storage)).toBe(raw);

    const second = world.store.load();

    expect(second.outcome).toBe(first.outcome);
    expect(second.problems).toEqual(first.problems);
  });
});

describe('an unusable cursor member is completed, not refused', () => {
  /** Cursor members no substream name can be read from. */
  const UNUSABLE_CURSORS: readonly unknown[] = [
    'zero',
    42,
    null,
    [],
    { 'spawn-value': 'seven' },
    { 'ghost-stream': 3 },
  ];

  function seedCursor(cursor: unknown): World {
    const payload = loosenEnvelope();

    payload.rngCursor = cursor;

    return createWorld({
      seed: { [RUN_STATE_KEY]: JSON.stringify(payload) },
    });
  }

  it('loads rather than falling back for every unusable cursor', () => {
    for (const cursor of UNUSABLE_CURSORS) {
      const world = seedCursor(cursor);

      expect(() => world.store.load()).not.toThrow();
      expect(world.store.load().state).not.toBeNull();
    }
  });

  it('completes the map over all four substream names', () => {
    for (const cursor of UNUSABLE_CURSORS) {
      const state = seedCursor(cursor).store.load().state;

      for (const name of RNG_STREAM_NAMES) {
        expect(state?.rngCursor[name]).toBe(0);
      }
    }
  });

  it('carries no substream name this build does not declare', () => {
    const state = seedCursor({ 'ghost-stream': 3 }).store.load().state;

    expect(Object.keys(state?.rngCursor ?? {})).toEqual([
      ...RNG_STREAM_NAMES,
    ]);
  });

  it('reports no failure for a completed cursor', () => {
    const world = seedCursor('zero');

    world.store.load();

    expect(failures(world.records)).toEqual([]);
  });
});

/* ===== 9. migrateRunState as pure policy, driven with no storage ===== */

/** The identity a wrap of an unversioned board snapshot adopts. */
const MIGRATION_IDENTITY = {
  runId: FIXTURE_RUN_ID,
  seed: FIXTURE_SEED,
  stageGoal: FIXTURE_STAGE_GOAL,
} as const;

describe('migrateRunState resolves one verdict at a time', () => {
  it("returns an envelope for 'current'", () => {
    const migrated = migrateRunState(loosenEnvelope(), 'current');

    expect(migrated).not.toBeNull();
    expect(migrated?.schemaVersion).toBe(RUN_STATE_SCHEMA_VERSION);
    expect(isRunStateShape(migrated)).toBe(true);
  });

  it("returns an envelope for 'older' at a version the history lists", () => {
    const stored = loosenEnvelope();

    expect(RUN_STATE_SCHEMA_VERSION_HISTORY).toContain(stored.schemaVersion);

    const migrated = migrateRunState(stored, 'older');

    expect(migrated).not.toBeNull();
    expect(migrated?.schemaVersion).toBe(RUN_STATE_SCHEMA_VERSION);
    expect(isRunStateShape(migrated)).toBe(true);
  });

  it("refuses 'older' at a version the history does not list", () => {
    const stored = loosenEnvelope();

    stored.schemaVersion = RUN_STATE_SCHEMA_VERSION - 1;

    expect(RUN_STATE_SCHEMA_VERSION_HISTORY).not.toContain(
      stored.schemaVersion
    );
    expect(migrateRunState(stored, 'older')).toBeNull();
  });

  it("preserves the board verbatim through an 'older' migration", () => {
    const migrated = migrateRunState(loosenEnvelope(), 'older');

    expect(migrated?.board).toEqual(buildBoard());
  });

  it("refuses 'unknown'", () => {
    expect(migrateRunState(loosenEnvelope(), 'unknown')).toBeNull();
  });

  it("refuses 'malformed'", () => {
    expect(migrateRunState(loosenEnvelope(), 'malformed')).toBeNull();
  });

  it("re-stamps an envelope carrying a board for 'absent'", () => {
    const migrated = migrateRunState(loosenEnvelope(), 'absent');

    expect(migrated?.schemaVersion).toBe(RUN_STATE_SCHEMA_VERSION);
    expect(migrated?.board).toEqual(buildBoard());
  });

  it("wraps a legacy board for 'absent' when given an identity", () => {
    const wrapped = migrateRunState(
      buildBoard() as unknown,
      'absent',
      MIGRATION_IDENTITY
    );

    expect(wrapped).not.toBeNull();
    expect(wrapped?.board).toEqual(buildBoard());
    expect(wrapped?.runId).toBe(FIXTURE_RUN_ID);
    expect(wrapped?.seed).toBe(FIXTURE_SEED);
    expect(wrapped?.stageGoal).toEqual(FIXTURE_STAGE_GOAL);
    expect(wrapped?.stageIndex).toBe(0);
    expect(wrapped?.goalProgress).toBe(0);
    expect(wrapped?.relics).toEqual([]);
  });

  it("refuses a legacy board snapshot for 'absent' with no identity", () => {
    expect(migrateRunState(buildBoard() as unknown, 'absent')).toBeNull();
  });
});

describe('migrateRunState fills what an older schema lacked', () => {
  it('completes a cursor map missing three substreams', () => {
    const stored = loosenEnvelope();

    stored.rngCursor = { 'spawn-value': 7 };

    const migrated = migrateRunState(stored, 'older');

    expect(migrated?.rngCursor['spawn-value']).toBe(7);
    expect(migrated?.rngCursor['spawn-position']).toBe(0);
    expect(migrated?.rngCursor['relic-draw']).toBe(0);
    expect(migrated?.rngCursor['rarity-weight']).toBe(0);
  });

  it('completes a cursor map that is absent altogether', () => {
    const stored = loosenEnvelope();

    delete stored.rngCursor;

    const migrated = migrateRunState(stored, 'older');

    expect(migrated).not.toBeNull();

    for (const name of RNG_STREAM_NAMES) {
      expect(migrated?.rngCursor[name]).toBe(0);
    }
  });

  it('populates the cursor over all four substream names and no fifth', () => {
    const migrated = migrateRunState(loosenEnvelope(), 'older');
    const names = Object.keys(migrated?.rngCursor ?? {});

    expect(names.slice().sort()).toEqual(
      RNG_STREAM_NAMES.slice().sort()
    );
    expect(names).toHaveLength(RNG_STREAM_NAMES.length);
  });

  it('drops a cursor entry naming a substream this build does not know', () => {
    const stored = loosenEnvelope();

    stored.rngCursor = { ...(stored.rngCursor as object), 'ghost-stream': 5 };

    const migrated = migrateRunState(stored, 'older');

    expect(Object.keys(migrated?.rngCursor ?? {})).not.toContain(
      'ghost-stream'
    );
  });
});

describe('migrateRunState is pure', () => {
  it('returns equal results for equal inputs', () => {
    for (const verdict of VERSION_VERDICTS) {
      const first = migrateRunState(loosenEnvelope(), verdict);
      const second = migrateRunState(loosenEnvelope(), verdict);

      expect(first).toEqual(second);
    }
  });

  it('does not mutate the value it was given', () => {
    const stored = loosenEnvelope();
    const before = JSON.stringify(stored);

    for (const verdict of VERSION_VERDICTS) {
      migrateRunState(stored, verdict);
    }

    expect(JSON.stringify(stored)).toBe(before);
  });

  it('does not mutate the identity it was given', () => {
    const identity = {
      runId: FIXTURE_RUN_ID,
      seed: FIXTURE_SEED,
      stageGoal: { ...FIXTURE_STAGE_GOAL },
    };
    const before = JSON.stringify(identity);

    migrateRunState(buildBoard() as unknown, 'absent', identity);

    expect(JSON.stringify(identity)).toBe(before);
  });

  it('shares no object with the value it was given', () => {
    const stored = loosenEnvelope();
    const migrated = migrateRunState(stored, 'current');

    expect(migrated?.board).not.toBe(stored.board);
    expect(migrated?.rngCursor).not.toBe(stored.rngCursor);
  });

  it('never throws for any hostile input at any verdict', () => {
    const hostile: readonly unknown[] = [
      null,
      undefined,
      42,
      'text',
      true,
      [],
      {},
      Number.NaN,
      [buildEnvelope()],
      UNPARSABLE_RAW,
    ];

    for (const value of hostile) {
      for (const verdict of VERSION_VERDICTS) {
        expect(() => migrateRunState(value, verdict)).not.toThrow();
        expect(migrateRunState(value, verdict)).toBeNull();
      }
    }
  });

  it('never throws for a structurally wrong object at any verdict', () => {
    for (const payload of structurallyWrongPayloads()) {
      for (const verdict of VERSION_VERDICTS) {
        expect(() => migrateRunState(payload, verdict)).not.toThrow();
        expect(migrateRunState(payload, verdict)).toBeNull();
      }
    }
  });

  it('reaches no storage and reports nothing', () => {
    const world = createWorld({ seed: { [RUN_STATE_KEY]: envelopeJson() } });

    world.touches.length = 0;

    migrateRunState(loosenEnvelope(), 'current');

    expect(world.touches).toEqual([]);
    expect(world.records).toEqual([]);
  });
});

/* ===== 10. save, clear and exists ===== */

describe('save writes the envelope and exists sees it', () => {
  it('returns true and makes the value retrievable', () => {
    const world = createWorld();

    expect(world.store.save(buildEnvelope())).toBe(true);
    expect(readRunStateRaw(world.storage)).not.toBeNull();
  });

  it('turns exists from false to true', () => {
    const world = createWorld();

    expect(world.store.exists()).toBe(false);
    world.store.save(buildEnvelope());
    expect(world.store.exists()).toBe(true);
  });

  it('reports the successful write with its measured size', () => {
    const world = createWorld();

    world.store.save(buildEnvelope());

    const writes = recordsOn(world.records, 'onWrite');

    expect(writes).toHaveLength(1);
    expect(writes[0]?.key).toBe(RUN_STATE_KEY);
    expect(writes[0]?.ok).toBe(true);
    expect(writes[0]?.byteLength).toBeGreaterThan(0);
  });

  it('reports no failure', () => {
    const world = createWorld();

    world.store.save(buildEnvelope());

    expect(failures(world.records)).toEqual([]);
  });

  it('overwrites a previous envelope rather than adding a key', () => {
    const world = createWorld();

    world.store.save(buildEnvelope());
    world.store.save({ ...buildEnvelope(), stageIndex: 3 });

    expect(touchedKeys(world.touches)).toEqual([RUN_STATE_KEY]);
    expect(world.store.load().state?.stageIndex).toBe(3);
  });

  // js/local_storage_manager.js L57-L59 wrote whatever it was handed.
  it('refuses an envelope at a version this build does not write', () => {
    const world = createWorld();
    const future = {
      ...buildEnvelope(),
      schemaVersion: RUN_STATE_SCHEMA_VERSION + 1,
    };

    expect(world.store.save(future)).toBe(false);
    expect(keysTouchedBy(world.touches, 'set')).toEqual([]);
    expect(readRunStateRaw(world.storage)).toBeNull();
  });

  it('reports a refused envelope with the key and a stated reason', () => {
    const world = createWorld();

    world.store.save({
      ...buildEnvelope(),
      schemaVersion: RUN_STATE_SCHEMA_VERSION + 1,
    });

    const reports = recordsOn(world.records, 'onWriteFailed');

    expect(reports).toHaveLength(1);
    expect(reports[0]?.key).toBe(RUN_STATE_KEY);
    expect(reports[0]?.correlationId).toBe(CORRELATION_ID);
    expect(errorText(reports[0]?.error).length).toBeGreaterThan(0);
  });
});

// js/local_storage_manager.js L61-L63 removed the snapshot key alone.
describe('clear removes the run key and nothing else', () => {
  function seededWorld(): World {
    return createWorld({
      seed: {
        [RUN_STATE_KEY]: envelopeJson(),
        [BEST_SCORE_KEY]: BEST_SCORE_SENTINEL,
        [GAME_STATE_KEY]: GAME_STATE_SENTINEL,
      },
    });
  }

  it('returns true', () => {
    expect(seededWorld().store.clear()).toBe(true);
  });

  it('removes the run key', () => {
    const world = seededWorld();

    world.store.clear();

    expect(readRunStateRaw(world.storage)).toBeNull();
  });

  it('leaves both legacy keys untouched', () => {
    const world = seededWorld();

    world.store.clear();

    expect(world.storage.getItem(BEST_SCORE_KEY)).toBe(BEST_SCORE_SENTINEL);
    expect(world.storage.getItem(GAME_STATE_KEY)).toBe(GAME_STATE_SENTINEL);
    expect(keysTouchedBy(world.touches, 'remove')).toEqual([RUN_STATE_KEY]);
  });

  it("leaves exists false and load reporting 'absent'", () => {
    const world = seededWorld();

    world.store.clear();

    expect(world.store.exists()).toBe(false);
    expect(world.store.load().outcome).toBe('absent');
  });

  it('succeeds for a key that was never written', () => {
    const world = createWorld();

    expect(world.store.clear()).toBe(true);
    expect(failures(world.records)).toEqual([]);
  });

  it('is idempotent', () => {
    const world = seededWorld();

    expect(world.store.clear()).toBe(true);
    expect(world.store.clear()).toBe(true);
    expect(world.store.exists()).toBe(false);
  });
});

/* ===== 11. The write and read failure paths ===== */

/**
 * A store whose `setItem` throws the error an exhausted quota raises.
 * js/local_storage_manager.js L57-L59 called `setItem` with no handler, and
 * left this as an exception escaping the commit path.
 *
 * @param inner Store every other operation is forwarded to.
 * @returns The failing wrapper.
 */
function quotaExhaustedStorage(inner: StorageLike): StorageLike {
  return {
    getItem: (key) => inner.getItem(key),
    setItem: () => {
      const error = new Error('The quota has been exceeded.');

      error.name = 'QuotaExceededError';

      throw error;
    },
    removeItem: (key) => {
      inner.removeItem(key);
    },
    clear: () => {
      inner.clear();
    },
  };
}

/** A store whose `getItem` throws, as a blocked store does on access. */
function unreadableStorage(): StorageLike {
  return {
    getItem: () => {
      throw new Error('Access to the store was denied.');
    },
    setItem: () => {
      throw new Error('Access to the store was denied.');
    },
    removeItem: () => {
      throw new Error('Access to the store was denied.');
    },
    clear: () => {
      throw new Error('Access to the store was denied.');
    },
  };
}

/**
 * Builds a store on a `LocalStorageManager` over a hostile `StorageLike`, in
 * the mandatory fixture-then-construct order.
 *
 * @param build Wraps the seeded backing store.
 * @param seed Raw values written before construction.
 * @returns The store and the reports its sink captured.
 */
function createHostileWorld(
  build: (inner: StorageLike) => StorageLike,
  seed: StorageSeed = {}
): { readonly store: RunStateStore; readonly records: CapturedReport[] } {
  const storage = new MemoryStorage();

  trackedStorages.push(storage);

  for (const [key, value] of Object.entries(seed)) {
    storage.setItem(key, value);
  }

  const sink = createCapturingSink();

  const port = new LocalStorageManager({
    storage: build(storage),
    reporter: sink.storageReporter,
  });

  const store = new RunStateStore({
    storage: port,
    reporter: sink.reporter,
    correlationId: CORRELATION_ID,
  });

  return { store, records: sink.records };
}

describe('an exhausted quota is reported rather than thrown', () => {
  it('does not throw', () => {
    const world = createHostileWorld(quotaExhaustedStorage);

    expect(() => world.store.save(buildEnvelope())).not.toThrow();
  });

  it('returns a falsy result', () => {
    const world = createHostileWorld(quotaExhaustedStorage);

    expect(world.store.save(buildEnvelope())).toBe(false);
  });

  it('reports the failing key, the operation and the caught error', () => {
    const world = createHostileWorld(quotaExhaustedStorage);

    world.store.save(buildEnvelope());

    const reports = recordsOn(world.records, 'onFailure');

    expect(reports).toHaveLength(1);
    expect(reports[0]?.operation).toBe('write');
    expect(reports[0]?.key).toBe(RUN_STATE_KEY);
    expect(reports[0]?.error.quota).toBe(true);
    expect(errorText(reports[0]?.thrown)).toContain('QuotaExceededError');
  });

  it('reports the failed write on the run channel with its size', () => {
    const world = createHostileWorld(quotaExhaustedStorage);

    world.store.save(buildEnvelope());

    const reports = recordsOn(world.records, 'onWriteFailed');

    expect(reports).toHaveLength(1);
    expect(reports[0]?.key).toBe(RUN_STATE_KEY);
    expect(reports[0]?.byteLength).toBeGreaterThan(0);
    expect(reports[0]?.correlationId).toBe(CORRELATION_ID);
    expect(errorText(reports[0]?.error).length).toBeGreaterThan(0);
  });

  it('records the attempted write as not ok', () => {
    const world = createHostileWorld(quotaExhaustedStorage);

    world.store.save(buildEnvelope());

    const writes = recordsOn(world.records, 'onWrite');

    expect(writes).toHaveLength(1);
    expect(writes[0]?.ok).toBe(false);
  });
});

describe('a read that throws is reported rather than thrown', () => {
  it('does not throw from load', () => {
    const world = createHostileWorld(unreadableStorage);

    expect(() => world.store.load()).not.toThrow();
  });

  it('does not throw from exists', () => {
    const world = createHostileWorld(unreadableStorage);

    expect(() => world.store.exists()).not.toThrow();
    expect(world.store.exists()).toBe(false);
  });

  it('reports the failing key, the operation and the caught error', () => {
    const world = createHostileWorld(unreadableStorage);

    world.store.load();

    const reports = recordsOn(world.records, 'onFailure');

    expect(reports.length).toBeGreaterThan(0);
    expect(reports[0]?.operation).toBe('read');
    expect(reports[0]?.key).toBe(RUN_STATE_KEY);
    expect(errorText(reports[0]?.thrown)).toContain('denied');
  });

  it('does not throw from clear, and reports the refusal', () => {
    const world = createHostileWorld(unreadableStorage);

    expect(() => world.store.clear()).not.toThrow();
    expect(world.store.clear()).toBe(false);
    expect(recordsOn(world.records, 'onFailure').length).toBeGreaterThan(0);
  });
});

/* ===== 12. Failures raised by the port itself ===== */

/** The error every member of the throwing port below raises. */
const PORT_FAILURE_TEXT = 'the persistence port failed';

/**
 * A port whose every member throws. `RunStatePersistencePort` is structural, so
 * this four-method object needs no mocking library.
 */
const THROWING_PORT: RunStatePersistencePort = {
  readRaw: () => {
    throw new Error(`readRaw: ${PORT_FAILURE_TEXT}`);
  },
  readJson: () => {
    throw new Error(`readJson: ${PORT_FAILURE_TEXT}`);
  },
  writeJson: () => {
    throw new Error(`writeJson: ${PORT_FAILURE_TEXT}`);
  },
  removeRaw: () => {
    throw new Error(`removeRaw: ${PORT_FAILURE_TEXT}`);
  },
};

/** A port that reads a stored value and refuses every write by return value. */
const REFUSING_PORT: RunStatePersistencePort = {
  readRaw: () => envelopeJson(),
  readJson: () => JSON.parse(envelopeJson()) as unknown,
  writeJson: () => false,
  removeRaw: () => false,
};

describe('a port that throws is contained and reported', () => {
  it('does not throw from load, save, clear or exists', () => {
    const world = createStoreOnPort(THROWING_PORT);

    expect(() => world.store.load()).not.toThrow();
    expect(() => world.store.save(buildEnvelope())).not.toThrow();
    expect(() => world.store.clear()).not.toThrow();
    expect(() => world.store.exists()).not.toThrow();
  });

  it('returns the falsy result of every operation', () => {
    const world = createStoreOnPort(THROWING_PORT);

    expect(world.store.load().state).toBeNull();
    expect(world.store.save(buildEnvelope())).toBe(false);
    expect(world.store.clear()).toBe(false);
    expect(world.store.exists()).toBe(false);
  });

  // js/local_storage_manager.js L37 discarded the value it caught.
  it('carries the caught read error to the run channel', () => {
    const world = createStoreOnPort(THROWING_PORT);

    world.store.load();

    const reports = recordsOn(world.records, 'onLoadCorrupted');
    const carried = reports.filter(
      (report) => errorText(report.error).length > 0
    );

    expect(carried.length).toBeGreaterThan(0);
    expect(errorText(carried[0]?.error)).toContain(PORT_FAILURE_TEXT);
    expect(carried[0]?.key).toBe(RUN_STATE_KEY);
    expect(carried[0]?.problems.length).toBeGreaterThan(0);
  });

  it('carries the caught write error to the run channel', () => {
    const world = createStoreOnPort(THROWING_PORT);

    world.store.save(buildEnvelope());

    const reports = recordsOn(world.records, 'onWriteFailed');

    expect(reports).toHaveLength(1);
    expect(errorText(reports[0]?.error)).toContain('writeJson');
    expect(reports[0]?.key).toBe(RUN_STATE_KEY);
  });

  it('carries the caught removal error to the run channel', () => {
    const world = createStoreOnPort(THROWING_PORT);

    world.store.clear();

    const reports = recordsOn(world.records, 'onWriteFailed');

    expect(reports).toHaveLength(1);
    expect(errorText(reports[0]?.error)).toContain('removeRaw');
    expect(reports[0]?.byteLength).toBe(0);
  });

  it('reports a presence check that threw', () => {
    const world = createStoreOnPort(THROWING_PORT);

    expect(world.store.exists()).toBe(false);

    const reports = recordsOn(world.records, 'onLoadCorrupted');

    expect(reports).toHaveLength(1);
    expect(reports[0]?.key).toBe(RUN_STATE_KEY);
    expect(errorText(reports[0]?.error)).toContain('readRaw');
  });
});

describe('a port that refuses by return value is reported', () => {
  it('returns false from save and reports the refusal', () => {
    const world = createStoreOnPort(REFUSING_PORT);

    expect(world.store.save(buildEnvelope())).toBe(false);

    const reports = recordsOn(world.records, 'onWriteFailed');

    expect(reports).toHaveLength(1);
    expect(reports[0]?.key).toBe(RUN_STATE_KEY);
    expect(errorText(reports[0]?.error).length).toBeGreaterThan(0);
  });

  it('returns false from clear and reports the refusal', () => {
    const world = createStoreOnPort(REFUSING_PORT);

    expect(world.store.clear()).toBe(false);
    expect(recordsOn(world.records, 'onWriteFailed')).toHaveLength(1);
  });

  it('still loads what the port reads', () => {
    const world = createStoreOnPort(REFUSING_PORT);
    const result = world.store.load();

    expect(result.outcome).toBe('loaded');
    expect(result.state).toEqual(buildEnvelope());
  });
});

/* ===== 13. Persistence reaches the injected port and nothing else ===== */

describe('the store persists only through its injected port', () => {
  it('lands every effect in the injected double', () => {
    const world = createWorld();

    world.store.save(buildEnvelope());

    expect(readRunStateRaw(world.storage)).not.toBeNull();
    expect(touchedKeys(world.touches)).toEqual([RUN_STATE_KEY]);
  });

  it('stores nothing at all when constructed with no port', () => {
    const store = new RunStateStore();

    expect(store.save(buildEnvelope())).toBe(false);
    expect(store.exists()).toBe(false);
    expect(store.load().outcome).toBe('absent');
  });

  it('does not throw when constructed with no port and no reporter', () => {
    const store = new RunStateStore();

    expect(() => store.load()).not.toThrow();
    expect(() => store.save(buildEnvelope())).not.toThrow();
    expect(() => store.clear()).not.toThrow();
    expect(() => store.exists()).not.toThrow();
  });

  it('reads a second store built over the same double', () => {
    const world = createWorld();

    world.store.save(buildEnvelope());

    const second = new RunStateStore({
      storage: new LocalStorageManager({ storage: world.storage }),
    });

    expect(second.load().state).toEqual(buildEnvelope());
  });

  it('sees a fixture written before the port was constructed', () => {
    const world = createWorld({ seed: { [RUN_STATE_KEY]: envelopeJson() } });

    expect(world.store.exists()).toBe(true);
    expect(world.store.load().state).toEqual(buildEnvelope());
  });

  it('records the injected strategy rather than a probed one', () => {
    expect(createWorld().port.strategy).toBe('injected');
  });
});

/* ===== 14. The reconciled discriminant, and no further ===== */

/**
 * Coverage boundary: the reconciliation POLICY — the precedence order, the
 * shrink and grow directions and the `tilesDropped` accounting, is asserted
 * by tests/unit/run/board-size-reconciliation.test.ts. This section asserts
 * only that a load surfaces the discriminant and attaches the record.
 */
const RECONCILIATION_MEMBERS: readonly string[] = [
  'savedSize',
  'configuredSize',
  'relicSize',
  'appliedSize',
  'action',
  'tilesDropped',
  'reportable',
];

describe('a load surfaces the reconciled outcome and its record', () => {
  const OTHER_BOARD_SIZE = 5;

  function loadAgainstAnotherSize(): {
    readonly world: World;
    readonly result: RunStateLoadResult;
  } {
    const world = createWorld({
      seed: { [RUN_STATE_KEY]: envelopeJson() },
      config: createDefaultRulesConfig(),
    });

    return { world, result: world.store.load({ boardSize: OTHER_BOARD_SIZE }) };
  }

  it('does not throw', () => {
    const world = createWorld({
      seed: { [RUN_STATE_KEY]: envelopeJson() },
    });

    expect(() =>
      world.store.load({ boardSize: OTHER_BOARD_SIZE })
    ).not.toThrow();
  });

  it("reports the 'reconciled' outcome", () => {
    expect(loadAgainstAnotherSize().result.outcome).toBe('reconciled');
  });

  it('attaches the reconciliation record', () => {
    const { result } = loadAgainstAnotherSize();

    expect(result.reconciliation).toBeDefined();
    expect(result.reconciliation?.reportable).toBe(true);
  });

  it('attaches a record carrying all seven members', () => {
    const { result } = loadAgainstAnotherSize();
    const members = Object.keys(result.reconciliation ?? {});

    expect(members.slice().sort()).toEqual(
      RECONCILIATION_MEMBERS.slice().sort()
    );
  });

  it('hands the same record to the reporter', () => {
    const { world, result } = loadAgainstAnotherSize();
    const reports = recordsOn(world.records, 'onBoardSizeReconciled');

    expect(reports).toHaveLength(1);
    expect(reports[0]?.correlationId).toBe(CORRELATION_ID);
    expect(reports[0]?.savedSize).toBe(result.reconciliation?.savedSize);
    expect(reports[0]?.configuredSize).toBe(
      result.reconciliation?.configuredSize
    );
    expect(reports[0]?.relicSize).toBe(result.reconciliation?.relicSize);
    expect(reports[0]?.appliedSize).toBe(result.reconciliation?.appliedSize);
  });

  it('keeps the state loadable rather than refusing it', () => {
    const { result } = loadAgainstAnotherSize();

    expect(result.state).not.toBeNull();
    expect(isRunStateShape(result.state)).toBe(true);
  });

  it("reports 'loaded' and a non-reportable record for a matching size", () => {
    const world = createWorld({
      seed: { [RUN_STATE_KEY]: envelopeJson() },
      config: createDefaultRulesConfig(),
    });
    const result = world.store.load();

    expect(result.outcome).toBe('loaded');
    expect(result.reconciliation?.reportable).toBe(false);
    expect(recordsOn(world.records, 'onBoardSizeReconciled')).toEqual([]);
  });
});

/* ===== 15. The teardown this suite depends on, made observable ===== */

describe('the teardown removes the best score the game never did', () => {
  // js/local_storage_manager.js L61-L63 removed the snapshot key; L22's best
  // score was never removed by the application.
  it('accepts a best score written into the shared store', () => {
    HYGIENE_STORAGE.setItem(BEST_SCORE_KEY, BEST_SCORE_SENTINEL);

    expect(HYGIENE_STORAGE.getItem(BEST_SCORE_KEY)).toBe(BEST_SCORE_SENTINEL);
  });

  it('finds the shared store clean at the start of the next test', () => {
    expect(bestScoreAtEntry).toBeUndefined();
    expect(HYGIENE_STORAGE.getItem(BEST_SCORE_KEY)).toBeUndefined();
  });

  it('leaves every owned key absent from the shared store', () => {
    for (const key of OWNED_STORAGE_KEYS) {
      expect(HYGIENE_STORAGE.getItem(key)).toBeUndefined();
    }
  });

  it('clears a store a previous test seeded through createWorld', () => {
    const world = createWorld({
      seed: {
        [RUN_STATE_KEY]: envelopeJson(),
        [BEST_SCORE_KEY]: BEST_SCORE_SENTINEL,
      },
    });

    expect(world.store.exists()).toBe(true);

    clearOwnedKeysOf(world.storage);

    expect(world.store.exists()).toBe(false);
    expect(world.storage.getItem(BEST_SCORE_KEY)).toBeUndefined();
  });

  it('is idempotent over an already-clean store', () => {
    const storage = new MemoryStorage();

    expect(() => {
      clearOwnedKeysOf(storage);
      clearOwnedKeysOf(storage);
    }).not.toThrow();
  });
});
