// Store suite of src/run/run-state-store.ts: the guarded loader, the version
// migration path, the corruption-tolerance policy and the namespaced-key
// isolation. AAP Contract 5 (0.6.1.5), AAP 0.4.1.3, requirement R6, and the
// guarded-loader half of implicit requirement I5.
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
  RUN_STATE_VERSION_POLICY,
  classifyRunStateVersion,
  createFreshRunState,
  isRunStateShape,
  projectCurrentRunState,
  resolveRunStateVersionPolicy,
} from '../../../src/run/run-state';
import type {
  BoardSizeReconciliationReport,
  RunReporter,
  RunState,
  RunStateCorruptionReport,
  RunStateMigrationReport,
  RunStateVersionPolicy,
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

/** One captured report, tagged with the channel it arrived on. */
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

type ReportOn<C extends CapturedChannel> = Extract<
  CapturedReport,
  { channel: C }
>['report'];

/** The three channels that carry a failure. */
const FAILURE_CHANNELS: readonly CapturedChannel[] = [
  'onLoadCorrupted',
  'onWriteFailed',
  'onFailure',
];

/**
 * A sink that satisfies both report contracts, plus the list it appends to.
 */
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

/** Reduces a caught value to text an assertion can measure. */
function errorText(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }

  return typeof value === 'string' ? value : '';
}

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
 * logged and then forwarded to `inner`.
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

  /**
   * Version set the store classifies and re-stamps against. Omitted for the
   * shipped policy, supplied by the migration section below so a genuine prior
   * version is reachable.
   */
  readonly versionPolicy?: RunStateVersionPolicy;
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
 * Builds a world in the mandatory order: allocate the store, write the
 * fixture, then construct `LocalStorageManager` and `RunStateStore`.
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
    versionPolicy: options.versionPolicy,
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

/** The wrapped board snapshot, in js/game_manager.js L102-L110's key order. */
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

/**
 * Best score observed at the start of the current test, read from the store
 * the hygiene section shares.
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

/* ==========================================================================
 * An unresolved reward round is carried through the load
 *
 * The candidate assembly names every member it carries LITERALLY, so a member it
 * does not name is dropped however valid it is in storage. `pendingReward` was
 * therefore written by the controller, read back as absent, and the round the
 * player was choosing from was lost on every reload.
 * ========================================================================== */

describe('an unresolved reward round in a stored envelope', () => {
  /** A valid envelope carrying a round of three offered identifiers. */
  function envelopeWithPendingReward(
    offeredRelicIds: readonly string[] = ['alpha', 'beta', 'gamma'],
  ): string {
    return JSON.stringify({
      ...loosenEnvelope(),
      pendingReward: { stageIndex: FIXTURE_STAGE_INDEX, offeredRelicIds },
    });
  }

  it('is carried through the load, in presentation order', () => {
    const world = createWorld({
      seed: { [RUN_STATE_KEY]: envelopeWithPendingReward(['one', 'two']) },
      config: createDefaultRulesConfig(),
    });
    const result = world.store.load();

    expect(result.outcome).toBe('loaded');
    expect(result.state?.pendingReward?.stageIndex).toBe(FIXTURE_STAGE_INDEX);
    expect(result.state?.pendingReward?.offeredRelicIds).toEqual([
      'one',
      'two',
    ]);
    expect(failures(world.records)).toEqual([]);
  });

  it('survives a save and load through the store unchanged', () => {
    const world = createWorld({ config: createDefaultRulesConfig() });
    const saved: RunState = {
      ...buildEnvelope(),
      pendingReward: {
        stageIndex: FIXTURE_STAGE_INDEX,
        offeredRelicIds: ['alpha', 'beta', 'gamma'],
      },
    };

    expect(world.store.save(saved)).toBe(true);
    expect(world.store.load().state).toEqual(saved);
  });

  it('leaves an envelope without one at exactly nine members', () => {
    const world = createWorld({
      seed: { [RUN_STATE_KEY]: envelopeJson() },
      config: createDefaultRulesConfig(),
    });
    const result = world.store.load();

    // ADDITIVE: a save written before the member existed loads exactly as it did,
    // with no `pendingReward` key invented for it.
    expect(result.state?.pendingReward).toBeUndefined();
    expect(Object.keys(result.state ?? {})).not.toContain('pendingReward');
  });

  it('refuses and reports a malformed round rather than half-loading it', () => {
    const world = createWorld({
      seed: {
        [RUN_STATE_KEY]: JSON.stringify({
          ...loosenEnvelope(),
          pendingReward: { stageIndex: -1, offeredRelicIds: [] },
        }),
      },
      config: createDefaultRulesConfig(),
    });
    const result = world.store.load();

    // Validated like every other member: the payload is refused, the run falls
    // back to fresh, and the diagnosis reaches the sink rather than being
    // swallowed.
    expect(result.state).toBeNull();
    expect(failures(world.records).length).toBeGreaterThan(0);
  });
});

describe('an unversioned envelope migrates to the current version', () => {
  /**
   * A payload written under the run key before the `schemaVersion` member
   * existed. `classifyRunStateVersion` reduces it to `'absent'`, which is the
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

  it('reads a correlation READER per report, so a run rotation reaches it', () => {
    const storage = new MemoryStorage();

    trackedStorages.push(storage);

    const payload = loosenEnvelope();

    delete payload.schemaVersion;

    storage.setItem(RUN_STATE_KEY, JSON.stringify(payload));

    const sink = createCapturingSink();
    let current = 'run-first';
    const store = new RunStateStore({
      storage: new LocalStorageManager({ storage }),
      reporter: sink.reporter,
      correlationId: (): string => current,
    });

    // A second run of one page load: the store outlives the run it was
    // constructed under, and a captured identifier attributed every later
    // report to the run that ended.
    current = 'run-second';
    store.load();

    const reports = recordsOn(sink.records, 'onVersionMigrated');

    expect(reports).toHaveLength(1);
    expect(reports[0]?.correlationId).toBe('run-second');
  });
});

describe('the version history decides which payload migrates', () => {
  /**
   * Stamps a valid envelope at `version` and reads it back. Every caller
   * drives it from `RUN_STATE_SCHEMA_VERSION_HISTORY`, so a version added to
   * that list is covered with no edit here.
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

  it("lists no version below the current one, so none reports 'migrated'",
    () => {
      const listedOlder = RUN_STATE_SCHEMA_VERSION_HISTORY.filter(
        (version) => version !== RUN_STATE_SCHEMA_VERSION
      );

      expect(listedOlder).toEqual([]);

      for (const version of listedOlder) {
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

/**
 * A raw string that cannot parse at all. The direct successor of the defect at
 * js/local_storage_manager.js L54, where the stored text reached `JSON.parse`
 * with no guard and threw during startup.
 */
const UNPARSABLE_RAW = '{not json';

/** Raw strings that parse to something other than an object. */
const PRIMITIVE_RAW: readonly string[] = ['42', '"text"', 'true', 'null'];

/** Envelopes that parse to an object and still fail `isRunStateShape`. */
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

    // The version here is the CURRENT one, which the shipped history lists:
    // the claim is that the 'older' verdict admits any listed version, not
    // that the payload predates this build.
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

/** The error every member of the throwing port below raises. */
const PORT_FAILURE_TEXT = 'the persistence port failed';

/**
 * A port whose every member throws. `RunStatePersistencePort` is structural,
 * so this four-method object needs no mocking library.
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

/**
 * A port that reads a stored value and refuses every write by return value.
 */
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

/**
 * Coverage boundary: the reconciliation POLICY — the precedence order, the
 * shrink and grow directions and the `tilesDropped` accounting, is asserted by
 * tests/unit/run/board-size-reconciliation.test.ts.
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

/* ==========================================================================
 * A MALFORMED CELL MATRIX IS NEITHER WRITTEN NOR LOADED
 *
 * `isWritable` gates every save on `isRunStateShape`, and the validator now
 * requires the matrix to be the SQUARE the declared size names and every tile's
 * `position` to name the cell it sits in. These cases prove the store acts on
 * that, in both directions: a malformed envelope handed to `save` never reaches
 * storage, and one already stored is refused by `load` rather than rehydrated
 * into a lattice that disagrees with itself. DL-RUN-08.
 * ========================================================================== */

/**
 * An envelope whose grid carries `cells` and declares `size`.
 *
 * Built by mutating a JSON projection, because a malformed matrix cannot be
 * produced through `Grid.serialize()` — which is the point: the only way one
 * reaches storage is a hand-edited or truncated payload.
 *
 * @param cells The matrix to carry.
 * @param size The size to declare.
 * @returns The envelope, typed as one so it can be handed to `save`.
 */
function envelopeWithGrid(cells: unknown, size: number): RunState {
  const loose = JSON.parse(JSON.stringify(buildEnvelope())) as {
    board: { grid: Record<string, unknown> };
  };

  loose.board.grid.cells = cells;
  loose.board.grid.size = size;

  return loose as unknown as RunState;
}

/** A square matrix of empty cells. */
function emptyCells(size: number): (SerializedGameState['grid']['cells'][number][number])[][] {
  return Array.from({ length: size }, () =>
    Array.from({ length: size }, () => null)
  );
}

describe('a malformed cell matrix is neither written nor loaded', () => {
  it('writes a square matrix that matches its declared size', () => {
    const world = createWorld();

    expect(world.store.save(envelopeWithGrid(emptyCells(4), 4))).toBe(true);
    expect(readRunStateRaw(world.storage)).not.toBeNull();
  });

  it('refuses to write a matrix with fewer columns than declared', () => {
    const world = createWorld();

    expect(world.store.save(envelopeWithGrid(emptyCells(3), 4))).toBe(false);

    // NOTHING REACHED STORAGE, so a run whose board went malformed keeps the
    // last envelope that was actually coherent.
    expect(readRunStateRaw(world.storage)).toBeNull();
  });

  it('refuses to write a jagged matrix', () => {
    const world = createWorld();
    const cells = emptyCells(4);

    cells[1] = [null, null];

    expect(world.store.save(envelopeWithGrid(cells, 4))).toBe(false);
    expect(readRunStateRaw(world.storage)).toBeNull();
  });

  it('refuses to write a tile whose position names a different cell', () => {
    const world = createWorld();
    const cells = emptyCells(4);

    cells[0] = [{ position: { x: 2, y: 2 }, value: 8 }, null, null, null];

    expect(world.store.save(envelopeWithGrid(cells, 4))).toBe(false);
    expect(readRunStateRaw(world.storage)).toBeNull();
  });

  it('leaves an already-stored envelope untouched by a refused write', () => {
    const world = createWorld();
    const sound = buildEnvelope();

    expect(world.store.save(sound)).toBe(true);

    const stored = readRunStateRaw(world.storage);

    expect(world.store.save(envelopeWithGrid(emptyCells(2), 4))).toBe(false);
    expect(readRunStateRaw(world.storage)).toBe(stored);
    expect(world.store.load().state).toEqual(sound);
  });

  it('refuses to load a stored matrix that is not square', () => {
    const world = createWorld({
      seed: {
        [RUN_STATE_KEY]: JSON.stringify(envelopeWithGrid(emptyCells(3), 4)),
      },
    });
    const loaded = world.store.load();

    expect(loaded.state).toBeNull();
    expect(loaded.outcome).toBe('fresh-fallback');
    expect((loaded.problems ?? []).join(' | ')).toContain('board.grid.cells');
  });

  it('refuses to load a stored tile that names a different cell', () => {
    const cells = emptyCells(4);

    cells[3] = [null, null, null, { position: { x: 0, y: 0 }, value: 2 }];

    const world = createWorld({
      seed: {
        [RUN_STATE_KEY]: JSON.stringify(envelopeWithGrid(cells, 4)),
      },
    });
    const loaded = world.store.load();

    expect(loaded.state).toBeNull();
    expect(loaded.outcome).toBe('fresh-fallback');
    expect((loaded.problems ?? []).join(' | ')).toContain(
      'board.grid.cells[3][3] carries the position (0, 0)'
    );
  });

  it('reports the refusal rather than throwing', () => {
    const world = createWorld({
      seed: {
        [RUN_STATE_KEY]: JSON.stringify(envelopeWithGrid(emptyCells(5), 4)),
      },
    });

    expect(() => world.store.load()).not.toThrow();
    expect(
      world.records.some(
        (record) => record.channel === 'onLoadCorrupted'
      )
    ).toBe(true);
  });
});

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

describe('the teardown removes the best score the game never did', () => {
  // js/local_storage_manager.js L61-L63 removed the snapshot key.
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

describe('a relic slot that declares a board size is applied on load', () => {
  /**
   * An envelope whose board was saved at the configured edge length and whose
   * relic slot declares a smaller one.
   *
   * The convention is the member name alone: any relic slot carrying a usable
   * `boardSize` declares one, and the store names no relic and no identifier.
   *
   * @param declared Edge length the relic slot declares.
   * @returns The envelope.
   */
  const envelopeDeclaring = (declared: number): RunState => ({
    ...buildEnvelope(),
    relics: [{ id: 'collapsing-vault', state: { boardSize: declared } }],
  });

  it('reconciles the board to the declared size, keeping in-bounds tiles', () => {
    const declared = 3;
    const world = createWorld({
      seed: {
        [RUN_STATE_KEY]: JSON.stringify(envelopeDeclaring(declared)),
      },
    });

    const saved = buildBoard().grid;
    const result = world.store.load({ boardSize: saved.size });
    const grid = result.state?.board.grid;

    expect(result.outcome).toBe('reconciled');
    expect(grid?.size).toBe(declared);
    expect(grid?.cells).toHaveLength(declared);
    expect(grid?.cells[0]).toHaveLength(declared);

    // Every tile inside the declared bounds kept its exact cell, and every
    // recorded position matches the cell it occupies, so no position is
    // corrupted by the shrink.
    for (let x = 0; x < declared; x += 1) {
      for (let y = 0; y < declared; y += 1) {
        const before = saved.cells[x]?.[y] ?? null;
        const after = grid?.cells[x]?.[y] ?? null;

        expect(after?.value ?? null).toBe(before?.value ?? null);

        if (after !== null) {
          expect(after.position).toEqual({ x, y });
        }
      }
    }
  });

  it('takes the smallest declaration when several relics declare one', () => {
    const world = createWorld({
      seed: {
        [RUN_STATE_KEY]: JSON.stringify({
          ...buildEnvelope(),
          relics: [
            { id: 'a', state: { boardSize: 3 } },
            { id: 'b', state: { boardSize: 2 } },
          ],
        }),
      },
    });

    expect(world.store.load({ boardSize: 4 }).state?.board.grid.size).toBe(2);
  });

  it('ignores a slot whose declaration is not a usable edge length', () => {
    for (const declared of [0, -1, 1.5, 4096, 'three', null]) {
      const world = createWorld({
        seed: {
          [RUN_STATE_KEY]: JSON.stringify({
            ...buildEnvelope(),
            relics: [{ id: 'a', state: { boardSize: declared } }],
          }),
        },
      });

      expect(world.store.load({ boardSize: 4 }).state?.board.grid.size).toBe(4);
    }
  });

  it('lets the caller override the declaration the envelope carries', () => {
    const world = createWorld({
      seed: {
        [RUN_STATE_KEY]: JSON.stringify(envelopeDeclaring(2)),
      },
    });

    expect(
      world.store.load({ boardSize: 4, relicBoardSize: 3 }).state?.board.grid
        .size,
    ).toBe(3);
  });
});

const PRIOR_STORED_VERSION = RUN_STATE_SCHEMA_VERSION;

// The version the injected policy calls current, so `PRIOR_STORED_VERSION`
// classifies 'older' and the migration path is entered for real.
const NEXT_CURRENT_VERSION = RUN_STATE_SCHEMA_VERSION + 1;

const TWO_VERSION_POLICY: RunStateVersionPolicy = Object.freeze({
  current: NEXT_CURRENT_VERSION,
  history: Object.freeze([PRIOR_STORED_VERSION, NEXT_CURRENT_VERSION]),
});

/**
 * Builds a world whose stored payload is at `PRIOR_STORED_VERSION` and whose
 * store reads under `TWO_VERSION_POLICY`.
 *
 * @param stored Payload to write, defaulting to the loosened fixture
 *   envelope stamped at the prior version.
 * @returns The world, fixture already written.
 */
function priorVersionWorld(stored?: Record<string, unknown>): World {
  const payload = stored ?? loosenEnvelope();

  payload.schemaVersion = PRIOR_STORED_VERSION;

  return createWorld({
    seed: { [RUN_STATE_KEY]: JSON.stringify(payload) },
    config: createDefaultRulesConfig(),
    versionPolicy: TWO_VERSION_POLICY,
  });
}

describe('the injected policy makes a prior version genuinely older', () => {
  it('exercises a NON-EMPTY set of versions below the current one', () => {
    const resolved = resolveRunStateVersionPolicy(TWO_VERSION_POLICY);
    const older = resolved.history.filter(
      (version) => version < resolved.current
    );

    // Guards every loop below. Under the shipped policy this set is empty and
    // an assertion inside such a loop proves nothing.
    expect(older).not.toHaveLength(0);
    expect(older).toContain(PRIOR_STORED_VERSION);
  });

  it("is classified 'older' rather than 'current'", () => {
    const stored = { schemaVersion: PRIOR_STORED_VERSION };

    expect(classifyRunStateVersion(stored)).toBe('current');
    expect(classifyRunStateVersion(stored, TWO_VERSION_POLICY)).toBe('older');
  });

  it("reports the load verdict 'older' and the outcome 'migrated'", () => {
    const result = priorVersionWorld().store.load();

    expect(result.verdict).toBe('older');
    expect(result.outcome).toBe('migrated');
    expect(result.state).not.toBeNull();
  });

  it('re-stamps the loaded envelope at the policy current version', () => {
    const result = priorVersionWorld().store.load();

    expect(result.state?.schemaVersion).toBe(NEXT_CURRENT_VERSION);
    expect(isRunStateShape(result.state)).toBe(true);
  });

  it('reports the migration with both real versions', () => {
    const world = priorVersionWorld();

    world.store.load();

    const migrations = recordsOn(world.records, 'onVersionMigrated');

    expect(migrations).toHaveLength(1);
    expect(migrations[0].fromVersion).toBe(PRIOR_STORED_VERSION);
    expect(migrations[0].toVersion).toBe(NEXT_CURRENT_VERSION);
    expect(migrations[0].fromVersion).not.toBe(migrations[0].toVersion);
    expect(migrations[0].correlationId).toBe(CORRELATION_ID);
  });

  it('reports no corruption and no failure for a real migration', () => {
    const world = priorVersionWorld();

    world.store.load();

    expect(failures(world.records)).toHaveLength(0);
  });

  it('carries the board through the migration verbatim', () => {
    const result = priorVersionWorld().store.load();

    expect(result.state?.board).toEqual(buildBoard());
  });

  it('carries the run identity and the cursor through unchanged', () => {
    const result = priorVersionWorld().store.load();

    expect(result.state?.runId).toBe(FIXTURE_RUN_ID);
    expect(result.state?.seed).toBe(FIXTURE_SEED);
    expect(result.state?.stageIndex).toBe(FIXTURE_STAGE_INDEX);

    for (const name of RNG_STREAM_NAMES) {
      expect(result.state?.rngCursor[name]).toBe(
        buildEnvelope().rngCursor[name]
      );
    }
  });

  it('completes a cursor map an older payload never carried', () => {
    const stored = loosenEnvelope();

    stored.rngCursor = { 'spawn-value': 11 };

    const result = priorVersionWorld(stored).store.load();

    expect(result.outcome).toBe('migrated');
    expect(result.state?.rngCursor['spawn-value']).toBe(11);

    for (const name of RNG_STREAM_NAMES.filter((n) => n !== 'spawn-value')) {
      expect(result.state?.rngCursor[name]).toBe(0);
    }
  });

  it('writes back what it just migrated, rather than refusing it', () => {
    // The seam has to be coherent in both directions: a store reading under a
    // policy must accept the version it itself produced.
    const world = priorVersionWorld();
    const loaded = world.store.load();

    expect(loaded.state).not.toBeNull();
    expect(world.store.save(loaded.state as RunState)).toBe(true);

    const written = JSON.parse(
      readRunStateRaw(world.storage) ?? 'null'
    ) as RunState;

    expect(written.schemaVersion).toBe(NEXT_CURRENT_VERSION);
    expect(recordsOn(world.records, 'onWriteFailed')).toHaveLength(0);
  });

  it('reloads what it wrote as current, not as older again', () => {
    const world = priorVersionWorld();
    const loaded = world.store.load();

    world.store.save(loaded.state as RunState);

    const second = world.store.load();

    expect(second.verdict).toBe('current');
    expect(second.outcome).toBe('loaded');
  });

  it("still refuses a version above the policy's current one", () => {
    const stored = loosenEnvelope();

    stored.schemaVersion = NEXT_CURRENT_VERSION + 1;

    const world = createWorld({
      seed: { [RUN_STATE_KEY]: JSON.stringify(stored) },
      config: createDefaultRulesConfig(),
      versionPolicy: TWO_VERSION_POLICY,
    });
    const result = world.store.load();

    expect(result.verdict).toBe('unknown');
    expect(result.outcome).toBe('fresh-fallback');
    expect(result.state).toBeNull();
  });

  it('still refuses a lower version the policy history omits', () => {
    const stored = loosenEnvelope();

    stored.schemaVersion = PRIOR_STORED_VERSION - 1;

    const world = createWorld({
      seed: { [RUN_STATE_KEY]: JSON.stringify(stored) },
      config: createDefaultRulesConfig(),
      versionPolicy: TWO_VERSION_POLICY,
    });

    expect(world.store.load().verdict).toBe('unknown');
  });

  it('behaves exactly as before when the shipped policy is supplied', () => {
    const payload = loosenEnvelope();
    const world = createWorld({
      seed: { [RUN_STATE_KEY]: JSON.stringify(payload) },
      config: createDefaultRulesConfig(),
      versionPolicy: RUN_STATE_VERSION_POLICY,
    });
    const result = world.store.load();

    expect(result.verdict).toBe('current');
    expect(result.outcome).toBe('loaded');
    expect(result.state?.schemaVersion).toBe(RUN_STATE_SCHEMA_VERSION);
  });

  it('never throws under a hostile policy, and reads as the shipped one',
    () => {
      const hostile = {
        get current(): number {
          throw new Error('policy refused');
        },
        get history(): readonly number[] {
          throw new Error('policy refused');
        },
      } as RunStateVersionPolicy;
      const world = createWorld({
        seed: { [RUN_STATE_KEY]: envelopeJson() },
        config: createDefaultRulesConfig(),
        versionPolicy: hostile,
      });

      expect(() => world.store.load()).not.toThrow();
      expect(world.store.load().verdict).toBe('current');
    });
});

describe('migrateRunState reaches its older branch under a policy', () => {
  it("migrates a genuine prior version for 'older'", () => {
    const stored = loosenEnvelope();

    stored.schemaVersion = PRIOR_STORED_VERSION;

    const migrated = migrateRunState(
      stored,
      'older',
      undefined,
      TWO_VERSION_POLICY
    );

    expect(migrated).not.toBeNull();
    expect(migrated?.schemaVersion).toBe(NEXT_CURRENT_VERSION);
    expect(migrated?.board).toEqual(buildBoard());
  });

  it("refuses 'older' at a version the supplied history omits", () => {
    const stored = loosenEnvelope();

    stored.schemaVersion = PRIOR_STORED_VERSION - 1;

    expect(
      migrateRunState(stored, 'older', undefined, TWO_VERSION_POLICY)
    ).toBeNull();
  });

  it("stamps the policy current version for 'current' too", () => {
    const stored = loosenEnvelope();

    stored.schemaVersion = NEXT_CURRENT_VERSION;

    expect(
      migrateRunState(stored, 'current', undefined, TWO_VERSION_POLICY)
        ?.schemaVersion
    ).toBe(NEXT_CURRENT_VERSION);
  });

  it("stamps the policy current version for an 'absent' wrap", () => {
    const wrapped = migrateRunState(
      buildBoard() as unknown,
      'absent',
      MIGRATION_IDENTITY,
      TWO_VERSION_POLICY
    );

    expect(wrapped?.schemaVersion).toBe(NEXT_CURRENT_VERSION);
    expect(wrapped?.board).toEqual(buildBoard());
  });

  it('falls back to the module constant with no policy supplied', () => {
    expect(
      migrateRunState(loosenEnvelope(), 'current')?.schemaVersion
    ).toBe(RUN_STATE_SCHEMA_VERSION);
  });

  it('never throws for a hostile policy on any verdict', () => {
    const hostile = {
      get current(): number {
        throw new Error('refused');
      },
      get history(): readonly number[] {
        throw new Error('refused');
      },
    } as RunStateVersionPolicy;

    for (const verdict of VERSION_VERDICTS) {
      expect(() =>
        migrateRunState(loosenEnvelope(), verdict, MIGRATION_IDENTITY, hostile)
      ).not.toThrow();
    }
  });

  it('leaves the projection at the module constant by default', () => {
    expect(projectCurrentRunState(buildEnvelope()).schemaVersion).toBe(
      RUN_STATE_SCHEMA_VERSION
    );
  });
});

const SINK_FAILURE_TEXT = 'the report sink refused';

/**
 * A `RunReporter` whose every member throws, plus a per-channel count of the
 * calls that reached it.
 */
interface ThrowingSink {
  readonly reporter: RunReporter;
  readonly calls: Record<string, number>;
}

function createThrowingSink(): ThrowingSink {
  const calls: Record<string, number> = {
    onLoadCorrupted: 0,
    onVersionMigrated: 0,
    onBoardSizeReconciled: 0,
    onWriteFailed: 0,
  };

  const refuse = (channel: string): never => {
    calls[channel] += 1;

    throw new Error(`${SINK_FAILURE_TEXT}: ${channel}`);
  };

  const reporter: RunReporter = {
    onLoadCorrupted: () => refuse('onLoadCorrupted'),
    onVersionMigrated: () => refuse('onVersionMigrated'),
    onBoardSizeReconciled: () => refuse('onBoardSizeReconciled'),
    onWriteFailed: () => refuse('onWriteFailed'),
  };

  return { reporter, calls };
}

/**
 * Builds a store whose sink throws on every channel.
 *
 * @param options Fixture, configuration and version policy.
 * @returns The store, the backing storage and the sink's call counts.
 */
function createThrowingSinkWorld(options: WorldOptions = {}): {
  readonly store: RunStateStore;
  readonly storage: MemoryStorage;
  readonly calls: Record<string, number>;
} {
  const storage = new MemoryStorage();

  trackedStorages.push(storage);

  for (const [key, value] of Object.entries(options.seed ?? {})) {
    storage.setItem(key, value);
  }

  const sink = createThrowingSink();
  const port = new LocalStorageManager({ storage });

  const store = new RunStateStore({
    storage: port,
    reporter: sink.reporter,
    config: options.config,
    correlationId: options.correlationId ?? CORRELATION_ID,
    versionPolicy: options.versionPolicy,
  });

  return { store, storage, calls: sink.calls };
}

describe('a throwing report sink is contained by load', () => {
  it('returns the fresh fallback for an unparsable payload', () => {
    const world = createThrowingSinkWorld({
      seed: { [RUN_STATE_KEY]: UNPARSABLE_RAW },
      config: createDefaultRulesConfig(),
    });
    let result: RunStateLoadResult | undefined;

    expect(() => {
      result = world.store.load();
    }).not.toThrow();

    expect(result?.state).toBeNull();
    expect(result?.outcome).toBe('fresh-fallback');
    expect(world.calls.onLoadCorrupted).toBe(1);
  });

  it('returns the fresh fallback for a structurally wrong payload', () => {
    for (const payload of structurallyWrongPayloads()) {
      const world = createThrowingSinkWorld({
        seed: { [RUN_STATE_KEY]: JSON.stringify(payload) },
        config: createDefaultRulesConfig(),
      });

      expect(() => world.store.load()).not.toThrow();
      expect(world.store.load().outcome).toBe('fresh-fallback');
    }
  });

  it('returns the fresh fallback for a primitive payload', () => {
    for (const raw of PRIMITIVE_RAW) {
      const world = createThrowingSinkWorld({
        seed: { [RUN_STATE_KEY]: raw },
        config: createDefaultRulesConfig(),
      });

      expect(() => world.store.load()).not.toThrow();
      expect(world.store.load().state).toBeNull();
    }
  });

  it('still loads and still reports migrated when the sink refuses', () => {
    const payload = loosenEnvelope();

    payload.schemaVersion = PRIOR_STORED_VERSION;

    const world = createThrowingSinkWorld({
      seed: { [RUN_STATE_KEY]: JSON.stringify(payload) },
      config: createDefaultRulesConfig(),
      versionPolicy: TWO_VERSION_POLICY,
    });
    let result: RunStateLoadResult | undefined;

    expect(() => {
      result = world.store.load();
    }).not.toThrow();

    // The migration report was refused; the migration itself still happened.
    expect(world.calls.onVersionMigrated).toBe(1);
    expect(result?.outcome).toBe('migrated');
    expect(result?.state?.schemaVersion).toBe(NEXT_CURRENT_VERSION);
  });

  it('still reconciles a board size when the sink refuses', () => {
    const payload = loosenEnvelope();
    const config: RulesConfig = {
      ...createDefaultRulesConfig(),
      boardSize: 5,
    };
    const world = createThrowingSinkWorld({
      seed: { [RUN_STATE_KEY]: JSON.stringify(payload) },
      config,
    });
    let result: RunStateLoadResult | undefined;

    expect(() => {
      result = world.store.load();
    }).not.toThrow();

    expect(world.calls.onBoardSizeReconciled).toBe(1);
    expect(result?.outcome).toBe('reconciled');
    expect(result?.state?.board.grid.size).toBe(5);
  });

  it('returns the absent result with no report attempted', () => {
    const world = createThrowingSinkWorld({
      config: createDefaultRulesConfig(),
    });

    expect(() => world.store.load()).not.toThrow();
    expect(world.store.load().outcome).toBe('absent');
    expect(world.calls.onLoadCorrupted).toBe(0);
  });
});

describe('a throwing report sink is contained by save and clear', () => {
  it('returns false for a malformed envelope', () => {
    const world = createThrowingSinkWorld({
      config: createDefaultRulesConfig(),
    });
    let saved: boolean | undefined;

    expect(() => {
      saved = world.store.save({} as RunState);
    }).not.toThrow();

    expect(saved).toBe(false);
    expect(world.calls.onWriteFailed).toBe(1);
  });

  it('returns true for a good envelope and attempts no report', () => {
    const world = createThrowingSinkWorld({
      config: createDefaultRulesConfig(),
    });

    expect(world.store.save(buildEnvelope())).toBe(true);
    expect(world.calls.onWriteFailed).toBe(0);
    expect(readRunStateRaw(world.storage)).not.toBeNull();
  });

  it('returns false when the port refuses the write', () => {
    const sink = createThrowingSink();
    const store = new RunStateStore({
      storage: REFUSING_PORT,
      reporter: sink.reporter,
      correlationId: CORRELATION_ID,
    });
    let saved: boolean | undefined;

    expect(() => {
      saved = store.save(buildEnvelope());
    }).not.toThrow();

    expect(saved).toBe(false);
    expect(sink.calls.onWriteFailed).toBe(1);
  });

  it('returns false when the port throws on write', () => {
    const sink = createThrowingSink();
    const store = new RunStateStore({
      storage: THROWING_PORT,
      reporter: sink.reporter,
      correlationId: CORRELATION_ID,
    });

    expect(() => store.save(buildEnvelope())).not.toThrow();
    expect(store.save(buildEnvelope())).toBe(false);
    expect(sink.calls.onWriteFailed).toBe(2);
  });

  it('returns false when the port refuses the removal', () => {
    const sink = createThrowingSink();
    const store = new RunStateStore({
      storage: REFUSING_PORT,
      reporter: sink.reporter,
      correlationId: CORRELATION_ID,
    });
    let cleared: boolean | undefined;

    expect(() => {
      cleared = store.clear();
    }).not.toThrow();

    expect(cleared).toBe(false);
    expect(sink.calls.onWriteFailed).toBe(1);
  });

  it('returns false when the port throws on removal', () => {
    const sink = createThrowingSink();
    const store = new RunStateStore({
      storage: THROWING_PORT,
      reporter: sink.reporter,
      correlationId: CORRELATION_ID,
    });

    expect(() => store.clear()).not.toThrow();
    expect(store.clear()).toBe(false);
  });

  it('returns true for a real removal and attempts no report', () => {
    const world = createThrowingSinkWorld({
      seed: { [RUN_STATE_KEY]: envelopeJson() },
      config: createDefaultRulesConfig(),
    });

    expect(world.store.clear()).toBe(true);
    expect(world.calls.onWriteFailed).toBe(0);
    expect(readRunStateRaw(world.storage)).toBeNull();
  });
});

describe('a throwing report sink is contained by exists', () => {
  it('answers for a stored envelope and for none', () => {
    const seeded = createThrowingSinkWorld({
      seed: { [RUN_STATE_KEY]: envelopeJson() },
      config: createDefaultRulesConfig(),
    });
    const empty = createThrowingSinkWorld({
      config: createDefaultRulesConfig(),
    });

    expect(() => seeded.store.exists()).not.toThrow();
    expect(seeded.store.exists()).toBe(true);
    expect(() => empty.store.exists()).not.toThrow();
    expect(empty.store.exists()).toBe(false);
  });

  it('answers false against a port that throws', () => {
    const sink = createThrowingSink();
    const store = new RunStateStore({
      storage: THROWING_PORT,
      reporter: sink.reporter,
      correlationId: CORRELATION_ID,
    });
    let exists: boolean | undefined;

    expect(() => {
      exists = store.exists();
    }).not.toThrow();

    expect(exists).toBe(false);
  });
});

describe('a throwing report sink leaves the frozen keys alone', () => {
  it('touches neither bestScore nor gameState across every operation', () => {
    const world = createThrowingSinkWorld({
      seed: {
        [RUN_STATE_KEY]: UNPARSABLE_RAW,
        [BEST_SCORE_KEY]: BEST_SCORE_SENTINEL,
        [GAME_STATE_KEY]: GAME_STATE_SENTINEL,
      },
      config: createDefaultRulesConfig(),
    });

    expect(() => {
      world.store.load();
      world.store.save({} as RunState);
      world.store.save(buildEnvelope());
      world.store.exists();
      world.store.clear();
    }).not.toThrow();

    expect(world.storage.getItem(BEST_SCORE_KEY)).toBe(BEST_SCORE_SENTINEL);
    expect(world.storage.getItem(GAME_STATE_KEY)).toBe(GAME_STATE_SENTINEL);
  });
});
