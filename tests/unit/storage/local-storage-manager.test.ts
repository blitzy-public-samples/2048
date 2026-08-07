// Unit suite for src/storage/local-storage-manager.ts, covering its
// non-best-score surface: the guarded snapshot parse, the boolean-returning
// writes and their structured failure reports, the once-at-construction
// writability probe, and the generic namespaced API the run-state envelope
// rides on.
//
// Provenance of every construct exercised here, from the deleted vanilla
// source:
//   js/local_storage_manager.js L1-L19    window.fakeStorage, the in-memory
//                                         fallback store
//   js/local_storage_manager.js L21-L27   LocalStorageManager, with the store
//                                         chosen once at L25-L26
//   js/local_storage_manager.js L29-L40   localStorageSupported, whose
//                                         `catch (error) { return false; }` at
//                                         L37-L39 discarded its error
//   js/local_storage_manager.js L34-L35   the probe's setItem then removeItem
//   js/local_storage_manager.js L43-L45   getBestScore
//   js/local_storage_manager.js L47-L49   setBestScore, setItem at L48 with no
//                                         handler
//   js/local_storage_manager.js L52-L55   getGameState, JSON.parse unguarded at
//                                         L54
//   js/local_storage_manager.js L57-L59   setGameState, setItem at L58 with no
//                                         handler
//   js/local_storage_manager.js L61-L63   clearGameState, removeItem at L62
//   js/application.js L3                  the constructor-injection seam
//   js/game_manager.js L36                getGameState() called from setup()
//   js/game_manager.js L85-L89            clearGameState() on loss only
//   js/game_manager.js L102-L110          serialize(), the persisted shape
//
// Scope split across tests/unit/storage/: the frozen best-score contract of
// L43-L49 is asserted in ./best-score.test.ts, and run-state schema
// versioning, migration and board-size reconciliation in tests/unit/run/.
// Nothing here imports from src/run/ or src/observability/.
//
// Every construction injects a store, so no assertion below depends on the
// ambient Web Storage of the vitest environment. Sections 1 to 6 hold the
// in-suite harness; the assertions begin at section 7. Storage keys come from
// src/storage/storage-keys.ts and board snapshots from
// tests/fixtures/boards.ts; this file declares neither a key literal nor a
// board literal of its own.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LocalStorageManager,
  probeWebStorage,
} from '../../../src/storage/local-storage-manager';
import type {
  LocalStorageManagerOptions,
  StorageErrorInfo,
  StorageFailure,
  StorageProbeResult,
  StorageReporter,
  StorageStrategy,
  StorageWriteInfo,
} from '../../../src/storage/local-storage-manager';
import {
  BEST_SCORE_KEY,
  GAME_STATE_KEY,
  namespacedKey,
  OWNED_STORAGE_KEYS,
  RUN_STATE_KEY,
  STORAGE_PROBE_KEY,
} from '../../../src/storage/storage-keys';
import type { OwnedStorageKey } from '../../../src/storage/storage-keys';
import { MemoryStorage } from '../../../src/storage/memory-storage';
import type { StorageLike } from '../../../src/storage/memory-storage';
import {
  createBlockedBoard,
  createEmptyBoard,
} from '../../fixtures/boards';

/* ===== 1. Constants ===== */

/** The three members of `StorageStrategy`, as the adapter declares them. */
const STORAGE_STRATEGIES: readonly StorageStrategy[] = [
  'localStorage',
  'memory',
  'injected',
];

/**
 * Bytes the adapter charges per UTF-16 code unit when it reports
 * `StorageWriteInfo.byteLength`.
 */
const BYTES_PER_UTF16_UNIT = 2;

/** Namespaced key the raw round-trip assertions write under. */
const SCRATCH_KEY = namespacedKey('unitStorageScratch');

/** Every key this suite may leave behind, swept before and after each test. */
const SWEPT_KEYS: readonly OwnedStorageKey[] = [
  ...OWNED_STORAGE_KEYS,
  STORAGE_PROBE_KEY,
  SCRATCH_KEY,
];

/** Best score seeded before construction by the key-isolation assertions. */
const SEEDED_BEST_SCORE = '4096';

/** Snapshot text that is not valid JSON. Four distinct corruption shapes. */
const CORRUPT_TEXTS: readonly { label: string; text: string }[] = [
  { label: 'an unquoted object body', text: '{not json' },
  { label: 'the bare word undefined', text: 'undefined' },
  { label: 'a truncated object', text: '{"grid":{"size":4,"cells":[' },
  { label: 'a truncated array', text: '[2,4,' },
];

/** Valid JSON that is not a board snapshot, with the value it parses to. */
const NON_BOARD_TEXTS: readonly {
  label: string;
  text: string;
  parsed: unknown;
}[] = [
  { label: 'a number', text: '42', parsed: 42 },
  { label: 'a string', text: '"text"', parsed: 'text' },
  { label: 'the JSON null literal', text: 'null', parsed: null },
];

/* ===== 2. Report collector ===== */

/**
 * A `StorageReporter` that keeps every report it is handed. A plain object:
 * this suite uses no spy library, no module mock and no third-party storage
 * mock, and the adapter takes its reporter by injection.
 */
interface ReportCollector extends StorageReporter {
  readonly probes: StorageProbeResult[];

  readonly failures: StorageFailure[];

  readonly writes: StorageWriteInfo[];
}

/**
 * Builds a fresh collector.
 *
 * @returns A collector whose three arrays start empty.
 */
function createReportCollector(): ReportCollector {
  const probes: StorageProbeResult[] = [];
  const failures: StorageFailure[] = [];
  const writes: StorageWriteInfo[] = [];

  return {
    probes,
    failures,
    writes,
    onProbe: (result: StorageProbeResult): void => {
      probes.push(result);
    },
    onFailure: (failure: StorageFailure): void => {
      failures.push(failure);
    },
    onWrite: (info: StorageWriteInfo): void => {
      writes.push(info);
    },
  };
}

/**
 * Builds a reporter whose every member throws `fault`.
 *
 * @param fault Value each member throws.
 * @returns The reporter.
 */
function createThrowingReporter(fault: unknown): StorageReporter {
  const raise = (): never => {
    throw fault;
  };

  return { onProbe: raise, onFailure: raise, onWrite: raise };
}

/* ===== 3. Storage stand-ins ===== */

/**
 * Members of `InstrumentedStorage` that throw, each carrying the value it
 * throws.
 */
interface StorageFaults {
  readonly getItem?: unknown;

  readonly setItem?: unknown;

  readonly removeItem?: unknown;
}

/**
 * A `StorageLike` store that records the operations it receives and can be
 * configured to throw from any of them. Backed by a `Map`, as
 * src/storage/memory-storage.ts is.
 *
 * It declares no `length` and no `key()`, so it is not the enumerable surface
 * the suite-wide teardown in tests/fixtures/storage.ts sweeps.
 */
class InstrumentedStorage implements StorageLike {
  /** Every operation received, as `member:key`, in call order. */
  readonly operations: string[] = [];

  private readonly entries = new Map<string, string>();

  private readonly faults: StorageFaults;

  constructor(faults: StorageFaults = {}) {
    this.faults = faults;
  }

  getItem(key: string): string | undefined {
    this.operations.push(`getItem:${key}`);
    this.raise(this.faults.getItem);

    return this.entries.get(key);
  }

  setItem(key: string, value: string): void {
    this.operations.push(`setItem:${key}`);
    this.raise(this.faults.setItem);
    this.entries.set(key, String(value));
  }

  removeItem(key: string): void {
    this.operations.push(`removeItem:${key}`);
    this.raise(this.faults.removeItem);
    this.entries.delete(key);
  }

  clear(): void {
    this.operations.push('clear');
    this.entries.clear();
  }

  /**
   * Throws `fault` when one was configured for the calling member.
   *
   * @param fault Configured fault, or `undefined` when the member behaves.
   */
  private raise(fault: unknown): void {
    if (fault !== undefined) {
      throw fault;
    }
  }
}

/**
 * Builds the quota error a browser raises once Web Storage is full: the shape
 * `StorageErrorInfo.quota` reports on, which L37-L39 discarded.
 *
 * @returns A `QuotaExceededError`, legacy exception code 22.
 */
function createQuotaError(): DOMException {
  return new DOMException('The quota has been exceeded.', 'QuotaExceededError');
}

/**
 * Builds the error a browser raises where storage access is denied.
 *
 * @returns A `SecurityError`.
 */
function createAccessError(): DOMException {
  return new DOMException('Access to storage is denied.', 'SecurityError');
}

/* ===== 4. Ambient Web Storage ===== */

/** Property `probeWebStorage()` reads the global store from. */
const WEB_STORAGE_PROPERTY = 'localStorage';

/** Descriptor of the environment's own store, held while one stands in. */
let originalWebStorage: PropertyDescriptor | undefined;

/** Whether `originalWebStorage` holds a descriptor to put back. */
let webStorageReplaced = false;

/**
 * Reports whether `value` offers the `StorageLike` members the adapter calls.
 *
 * @param value Value to test, typically the global store.
 * @returns `true` when every member is present as a function.
 */
function isStorageLikeValue(value: unknown): value is StorageLike {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  return (
    'getItem' in value &&
    typeof value.getItem === 'function' &&
    'setItem' in value &&
    typeof value.setItem === 'function' &&
    'removeItem' in value &&
    typeof value.removeItem === 'function' &&
    'clear' in value &&
    typeof value.clear === 'function'
  );
}

/**
 * The environment's Web Storage, when it offers a usable one.
 *
 * @returns The global store, or `undefined` outside a DOM environment.
 */
function ambientStorage(): StorageLike | undefined {
  let candidate: unknown;

  try {
    candidate = globalThis.localStorage;
  } catch {
    return undefined;
  }

  return isStorageLikeValue(candidate) ? candidate : undefined;
}

/**
 * Puts `replacement` in place of the environment's Web Storage for the rest of
 * the current test. The first call of a test records the descriptor
 * `restoreWebStorage()` puts back.
 *
 * @param replacement Store to install, or `undefined` to leave the property
 *   holding no store at all.
 */
function replaceWebStorage(replacement: StorageLike | undefined): void {
  if (!webStorageReplaced) {
    originalWebStorage = Object.getOwnPropertyDescriptor(
      globalThis,
      WEB_STORAGE_PROPERTY
    );
    webStorageReplaced = true;
  }

  Object.defineProperty(globalThis, WEB_STORAGE_PROPERTY, {
    value: replacement,
    configurable: true,
    enumerable: true,
    writable: true,
  });
}

/**
 * Puts the environment's own Web Storage back. Idempotent: it returns without
 * doing anything when nothing stands in.
 */
function restoreWebStorage(): void {
  if (!webStorageReplaced) {
    return;
  }

  if (originalWebStorage === undefined) {
    Reflect.deleteProperty(globalThis, WEB_STORAGE_PROPERTY);
  } else {
    Object.defineProperty(
      globalThis,
      WEB_STORAGE_PROPERTY,
      originalWebStorage
    );
  }

  originalWebStorage = undefined;
  webStorageReplaced = false;
}

/**
 * Removes every key this suite writes from `store`.
 *
 * Idempotent: removing a key that was never written is a no-op, and the
 * suite-wide setup file sweeps the same keys again. The list opens with
 * `OWNED_STORAGE_KEYS`, so `BEST_SCORE_KEY` is removed explicitly — L61-L63
 * removed the snapshot and never the best score.
 *
 * @param store Store to sweep, or `undefined` to sweep nothing.
 */
function sweepKeys(store: StorageLike | undefined): void {
  if (store === undefined) {
    return;
  }

  for (const key of SWEPT_KEYS) {
    store.removeItem(key);
  }
}

/* ===== 5. Assertion helpers ===== */

/**
 * Runs `operation` and asserts that nothing escaped it, then hands back what it
 * returned, so both halves of a no-throw guarantee are asserted from one call.
 *
 * @param operation Call under test.
 * @returns The value `operation` returned.
 */
function expectNoThrow<T>(operation: () => T): T {
  const outcomes: T[] = [];

  expect(() => {
    outcomes.push(operation());
  }).not.toThrow();
  expect(outcomes).toHaveLength(1);

  return outcomes[0];
}

/**
 * Reads `key` straight out of `store`, normalising an absent value to `null`.
 *
 * @param store Store to read.
 * @param key Key to read.
 * @returns The stored string, or `null` when the key is absent.
 */
function readEntry(store: StorageLike, key: OwnedStorageKey): string | null {
  return store.getItem(key) ?? null;
}

/* ===== 6. Snapshot narrowing ===== */

/** The persisted board shape, taken from the fixture module's own return. */
type PersistedBoard = ReturnType<typeof createEmptyBoard>;

/** The grid member of a persisted board. */
type PersistedGrid = PersistedBoard['grid'];

/**
 * Reports whether `value` is a `{ x, y }` position, as js/tile.js L19-L27
 * serialised one.
 *
 * @param value Value to test.
 * @returns `true` when both coordinates are numbers.
 */
function isPosition(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  if (!('x' in value) || !('y' in value)) {
    return false;
  }

  return typeof value.x === 'number' && typeof value.y === 'number';
}

/**
 * Reports whether `value` is a serialised cell: a tile, or the `null`
 * js/grid.js L109 wrote for an empty one.
 *
 * @param value Value to test.
 * @returns `true` when the cell is `null` or a well-formed tile.
 */
function isCell(value: unknown): boolean {
  if (value === null) {
    return true;
  }

  if (typeof value !== 'object') {
    return false;
  }

  if (!('position' in value) || !('value' in value)) {
    return false;
  }

  return typeof value.value === 'number' && isPosition(value.position);
}

/**
 * Reports whether `value` is a column of serialised cells.
 *
 * @param value Value to test.
 * @returns `true` when every member is a serialised cell.
 */
function isColumn(value: unknown): boolean {
  return Array.isArray(value) && value.every(isCell);
}

/**
 * Reports whether `value` is a serialised grid, as js/grid.js L102-L117
 * produced one.
 *
 * @param value Value to test.
 * @returns `true` when `size` is a number and `cells` a matrix of cells.
 */
function isGrid(value: unknown): value is PersistedGrid {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  if (!('size' in value) || !('cells' in value)) {
    return false;
  }

  return (
    typeof value.size === 'number' &&
    Array.isArray(value.cells) &&
    value.cells.every(isColumn)
  );
}

/**
 * Reports whether `value` is a persisted board snapshot, as
 * js/game_manager.js L102-L110 produced one. Narrows the `unknown` that
 * `getGameState()` returns without a cast.
 *
 * @param value Value to test.
 * @returns `true` when every persisted member is present with its own type.
 */
function isPersistedBoard(value: unknown): value is PersistedBoard {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  if (
    !('grid' in value) ||
    !('score' in value) ||
    !('over' in value) ||
    !('won' in value) ||
    !('keepPlaying' in value)
  ) {
    return false;
  }

  return (
    typeof value.score === 'number' &&
    typeof value.over === 'boolean' &&
    typeof value.won === 'boolean' &&
    typeof value.keepPlaying === 'boolean' &&
    isGrid(value.grid)
  );
}

/**
 * Narrows a value the adapter returned as `unknown` to a persisted board,
 * failing the test when it is not one.
 *
 * @param value Value `getGameState()` or `readJson()` returned.
 * @returns The same value, typed.
 */
function expectPersistedBoard(value: unknown): PersistedBoard {
  expect(isPersistedBoard(value)).toBe(true);

  if (!isPersistedBoard(value)) {
    throw new TypeError('Value is not a persisted board snapshot.');
  }

  return value;
}

/**
 * Counts the empty cells of a board, which js/grid.js L109 serialised as
 * `null`.
 *
 * @param board Board to walk.
 * @returns How many cells are `null`.
 */
function countEmptyCells(board: PersistedBoard): number {
  let empty = 0;

  for (const column of board.grid.cells) {
    for (const cell of column) {
      if (cell === null) {
        empty += 1;
      }
    }
  }

  return empty;
}

beforeEach(() => {
  restoreWebStorage();
  sweepKeys(ambientStorage());
});

afterEach(() => {
  restoreWebStorage();
  sweepKeys(ambientStorage());
});

/* ===== 7. Construction and storage strategy ===== */

describe('LocalStorageManager construction (L21-L27, L25-L26)', () => {
  it('constructs with no arguments, keeping the L21-L27 ctor seam', () => {
    const manager = expectNoThrow(() => new LocalStorageManager());

    expect(manager).toBeInstanceOf(LocalStorageManager);
    expect(STORAGE_STRATEGIES).toContain(manager.strategy);
    expect(typeof manager.probe.supported).toBe('boolean');
  });

  it('reads and writes the injected store alone, fixed at L26', () => {
    const store = new MemoryStorage();
    const options: LocalStorageManagerOptions = { storage: store };
    const manager = new LocalStorageManager(options);

    expect(manager.setGameState(createEmptyBoard())).toBe(true);

    expect(readEntry(store, GAME_STATE_KEY)).not.toBeNull();
    expect(readEntry(store, BEST_SCORE_KEY)).toBeNull();
    expect(readEntry(store, RUN_STATE_KEY)).toBeNull();

    const ambient = ambientStorage();

    expect(ambient).toBeDefined();
    expect(ambient === undefined ? null : readEntry(ambient, GAME_STATE_KEY))
      .toBeNull();
  });

  it("reports strategy 'injected', the L26 choice made explicit", () => {
    const manager = new LocalStorageManager({ storage: new MemoryStorage() });

    expect(STORAGE_STRATEGIES).toContain(manager.strategy);
    expect(manager.strategy).toBe('injected');
  });

  it('fixes strategy and probe once at construction, per L25-L26', () => {
    const store = new MemoryStorage();
    const manager = new LocalStorageManager({ storage: store });
    const strategy = manager.strategy;
    const probe = manager.probe;

    const global = new InstrumentedStorage({ setItem: createQuotaError() });

    replaceWebStorage(global);

    expect(manager.setGameState(createEmptyBoard())).toBe(true);
    expect(manager.getGameState()).not.toBeNull();
    expect(manager.setBestScore(0)).toBe(true);
    expect(manager.clearGameState()).toBe(true);

    expect(manager.strategy).toBe(strategy);
    expect(manager.probe).toBe(probe);
    expect(global.operations).toStrictEqual([]);
  });

  it("falls back to 'memory' when Web Storage throws, as L26 did", () => {
    replaceWebStorage(new InstrumentedStorage({ setItem: createQuotaError() }));

    const manager = expectNoThrow(() => new LocalStorageManager());

    expect(manager.strategy).toBe('memory');
    expect(manager.probe.supported).toBe(false);

    const board = createEmptyBoard();

    expect(manager.setGameState(board)).toBe(true);
    expect(expectPersistedBoard(manager.getGameState())).toStrictEqual(board);
  });

  it("falls back to 'memory' with no store, unreached by L33", () => {
    replaceWebStorage(undefined);

    const manager = expectNoThrow(() => new LocalStorageManager());

    expect(manager.strategy).toBe('memory');
    expect(manager.probe.supported).toBe(false);
    expect(manager.probe.error).toBeUndefined();
    expect(manager.setBestScore(1)).toBe(true);
  });

  it('stays usable when the injected store throws at L48 and L58', () => {
    const store = new InstrumentedStorage({
      getItem: createAccessError(),
      setItem: createQuotaError(),
      removeItem: createAccessError(),
    });
    const manager = expectNoThrow(
      () => new LocalStorageManager({ storage: store })
    );

    expect(expectNoThrow(() => manager.setGameState(createEmptyBoard())))
      .toBe(false);
    expect(expectNoThrow(() => manager.getGameState())).toBeNull();
    expect(expectNoThrow(() => manager.clearGameState())).toBe(false);
    expect(expectNoThrow(() => manager.setBestScore(8))).toBe(false);
  });
});

/* ===== 8. The reused capability probe ===== */

describe('probeWebStorage() — the reused capability probe (L29-L40)', () => {
  it('returns a structured result where L36 and L38 returned a bool', () => {
    const result = expectNoThrow(() => probeWebStorage());

    expect(typeof result.supported).toBe('boolean');
    expect(STORAGE_STRATEGIES).toContain(result.strategy);
    expect(result.supported).toBe(true);
    expect(result.strategy).toBe('localStorage');
    expect(result.error).toBeUndefined();
  });

  it('writes then removes the probe key, mirroring L34-L35', () => {
    const global = new InstrumentedStorage();

    replaceWebStorage(global);

    const result = probeWebStorage();

    expect(result.supported).toBe(true);
    expect(global.operations).toStrictEqual([
      `setItem:${STORAGE_PROBE_KEY}`,
      `removeItem:${STORAGE_PROBE_KEY}`,
    ]);
    expect(global.getItem(STORAGE_PROBE_KEY)).toBeUndefined();
  });

  it('leaves the ambient store free of the probe key, as L35 did', () => {
    const ambient = ambientStorage();

    expect(ambient).toBeDefined();
    expect(probeWebStorage().supported).toBe(true);
    expect(ambient === undefined ? null : readEntry(ambient, STORAGE_PROBE_KEY))
      .toBeNull();
  });

  it('preserves the caught error, closing the catch at L37-L39', () => {
    const quota = createQuotaError();

    replaceWebStorage(new InstrumentedStorage({ setItem: quota }));

    const result = expectNoThrow(() => probeWebStorage());

    expect(result.supported).toBe(false);
    expect(result.strategy).toBe('memory');

    const error: StorageErrorInfo | undefined = result.error;

    expect(error).toBeDefined();
    expect(error?.name).toBe(quota.name);
    expect(error?.message).toBe(quota.message);
    expect(error?.quota).toBe(true);
  });

  it('flags denied access as non-quota, a distinction L38 lost', () => {
    const denied = createAccessError();

    replaceWebStorage(new InstrumentedStorage({ setItem: denied }));

    const result = probeWebStorage();

    expect(result.supported).toBe(false);
    expect(result.error?.name).toBe(denied.name);
    expect(result.error?.message).toBe(denied.message);
    expect(result.error?.quota).toBe(false);
  });

  it('carries no error when no store exists, unlike L33', () => {
    replaceWebStorage(undefined);

    const result = expectNoThrow(() => probeWebStorage());

    expect(result).toStrictEqual({ supported: false, strategy: 'memory' });
  });

  it('exposes the L25 probe result on probe and probes once', () => {
    const global = new InstrumentedStorage();

    replaceWebStorage(global);

    const manager = new LocalStorageManager({ storage: new MemoryStorage() });

    expect(manager.probe.supported).toBe(true);
    expect(manager.probe.strategy).toBe('localStorage');
    expect(manager.probe).toBe(manager.probe);
    expect(global.operations).toStrictEqual([
      `setItem:${STORAGE_PROBE_KEY}`,
      `removeItem:${STORAGE_PROBE_KEY}`,
    ]);
  });

  it('reports a successful probe, which L29-L40 reported nowhere', () => {
    const collector = createReportCollector();

    const manager = new LocalStorageManager({
      storage: new MemoryStorage(),
      reporter: collector,
    });

    expect(collector.probes).toStrictEqual([manager.probe]);
    expect(collector.failures).toStrictEqual([]);
  });

  it('reports a failed probe on both channels, unlike L37-L39', () => {
    const quota = createQuotaError();

    replaceWebStorage(new InstrumentedStorage({ setItem: quota }));

    const collector = createReportCollector();
    const manager = expectNoThrow(
      () => new LocalStorageManager({ reporter: collector })
    );

    expect(collector.probes).toStrictEqual([manager.probe]);
    expect(collector.failures).toHaveLength(1);
    expect(collector.failures[0]).toStrictEqual({
      operation: 'probe',
      key: STORAGE_PROBE_KEY,
      strategy: 'memory',
      error: { name: quota.name, message: quota.message, quota: true },
    });
  });
});


/* ===== 9. The guarded snapshot parse ===== */

describe('getGameState() — guarded parse (L52-L55)', () => {
  it('returns null for an absent snapshot, as L54 branched', () => {
    const manager = new LocalStorageManager({ storage: new MemoryStorage() });

    expect(expectNoThrow(() => manager.getGameState())).toBeNull();
  });

  for (const corrupt of CORRUPT_TEXTS) {
    it(`returns null for ${corrupt.label}; L54 threw into setup() L36`, () => {
      const store = new MemoryStorage();

      store.setItem(GAME_STATE_KEY, corrupt.text);

      const manager = new LocalStorageManager({ storage: store });

      expect(expectNoThrow(() => manager.getGameState())).toBeNull();
      expect(readEntry(store, GAME_STATE_KEY)).toBe(corrupt.text);
    });
  }

  it('returns null for an empty string, preserving the L54 check', () => {
    const store = new MemoryStorage();

    store.setItem(GAME_STATE_KEY, '');

    const manager = new LocalStorageManager({ storage: store });

    expect(expectNoThrow(() => manager.getGameState())).toBeNull();
  });

  for (const valid of NON_BOARD_TEXTS) {
    it(`returns ${valid.label} parsed, as JSON.parse at L54 did`, () => {
      const store = new MemoryStorage();

      store.setItem(GAME_STATE_KEY, valid.text);

      const manager = new LocalStorageManager({ storage: store });

      expect(expectNoThrow(() => manager.getGameState())).toStrictEqual(
        valid.parsed
      );
    });
  }

  it('reports a corrupt parse, a channel L52-L55 lacked', () => {
    const store = new MemoryStorage();
    const corrupt = CORRUPT_TEXTS[0];

    store.setItem(GAME_STATE_KEY, corrupt.text);

    const collector = createReportCollector();
    const manager = new LocalStorageManager({
      storage: store,
      reporter: collector,
    });

    expect(expectNoThrow(() => manager.getGameState())).toBeNull();
    expect(collector.failures).toHaveLength(1);

    const failure = collector.failures[0];

    expect(failure.operation).toBe('read');
    expect(failure.key).toBe(GAME_STATE_KEY);
    expect(failure.strategy).toBe('injected');
    expect(failure.error.name).toBe('SyntaxError');
    expect(failure.error.message.length).toBeGreaterThan(0);
    expect(failure.error.quota).toBe(false);
  });

  it('reports nothing for an absent snapshot, unparsed at L54', () => {
    const collector = createReportCollector();
    const manager = new LocalStorageManager({
      storage: new MemoryStorage(),
      reporter: collector,
    });

    expect(manager.getGameState()).toBeNull();
    expect(collector.failures).toStrictEqual([]);
  });

  it('round-trips an empty board through L57-L59 and L52-L55', () => {
    const board = createEmptyBoard();
    const manager = new LocalStorageManager({ storage: new MemoryStorage() });

    expect(manager.setGameState(board)).toBe(true);

    const restored = expectPersistedBoard(manager.getGameState());

    expect(restored).toStrictEqual(board);
    expect(restored.grid.size).toBe(board.grid.size);
    expect(restored.grid.cells).toStrictEqual(board.grid.cells);
    expect(restored.score).toBe(board.score);
    expect(restored.over).toBe(board.over);
    expect(restored.won).toBe(board.won);
    expect(restored.keepPlaying).toBe(board.keepPlaying);
    expect(countEmptyCells(restored)).toBe(board.grid.size * board.grid.size);
  });

  it('round-trips a populated board, keeping js/grid.js L109 nulls', () => {
    const board = createBlockedBoard();
    const manager = new LocalStorageManager({ storage: new MemoryStorage() });

    expect(manager.setGameState(board)).toBe(true);

    const restored = expectPersistedBoard(manager.getGameState());

    expect(restored).toStrictEqual(board);
    expect(restored.grid.size).toBe(board.grid.size);
    expect(restored.grid.cells).toStrictEqual(board.grid.cells);
    expect(restored.score).toBe(board.score);
    expect(restored.over).toBe(board.over);
    expect(restored.won).toBe(board.won);
    expect(restored.keepPlaying).toBe(board.keepPlaying);
    expect(restored.grid.cells[0][0]).toStrictEqual(board.grid.cells[0][0]);
    expect(restored.grid.cells[1][0]).toBeNull();

    const cellCount = board.grid.size * board.grid.size;

    expect(countEmptyCells(restored)).toBe(cellCount - board.grid.size);
    expect(countEmptyCells(restored)).toBe(countEmptyCells(board));
  });
});

/* ===== 10. Write failure paths ===== */

describe('write failure paths (L47-L49, L57-L59)', () => {
  it('returns true and stores under GAME_STATE_KEY alone, per L58', () => {
    const store = new MemoryStorage();
    const board = createEmptyBoard();
    const manager = new LocalStorageManager({ storage: store });

    expect(manager.setGameState(board)).toBe(true);

    const stored = readEntry(store, GAME_STATE_KEY);

    expect(stored).not.toBeNull();
    expect(stored === null ? null : JSON.parse(stored)).toStrictEqual(board);
    expect(readEntry(store, BEST_SCORE_KEY)).toBeNull();
    expect(readEntry(store, RUN_STATE_KEY)).toBeNull();
  });

  it('returns false when setGameState hits a full store at L58', () => {
    const store = new InstrumentedStorage({ setItem: createQuotaError() });
    const manager = new LocalStorageManager({ storage: store });

    expect(expectNoThrow(() => manager.setGameState(createEmptyBoard())))
      .toBe(false);
    expect(store.getItem(GAME_STATE_KEY)).toBeUndefined();
  });

  it('returns false when setBestScore hits a full store at L48', () => {
    const store = new InstrumentedStorage({ setItem: createQuotaError() });
    const manager = new LocalStorageManager({ storage: store });

    expect(expectNoThrow(() => manager.setBestScore(2048))).toBe(false);
    expect(store.getItem(BEST_SCORE_KEY)).toBeUndefined();
  });

  it('reports the failed write, closing the lost error of L37-L39', () => {
    const quota = createQuotaError();
    const store = new InstrumentedStorage({ setItem: quota });
    const collector = createReportCollector();
    const manager = new LocalStorageManager({
      storage: store,
      reporter: collector,
    });

    expect(manager.setGameState(createEmptyBoard())).toBe(false);
    expect(collector.failures).toHaveLength(1);

    const failure = collector.failures[0];

    expect(failure.operation).toBe('write');
    expect(failure.key).toBe(GAME_STATE_KEY);
    expect(failure.strategy).toBe('injected');
    expect(failure.error.name).toBe(quota.name);
    expect(failure.error.message).toBe(quota.message);
    expect(failure.error.quota).toBe(true);
  });

  it('reports a failed setBestScore, unreported by L47-L49', () => {
    const quota = createQuotaError();
    const collector = createReportCollector();
    const manager = new LocalStorageManager({
      storage: new InstrumentedStorage({ setItem: quota }),
      reporter: collector,
    });

    expect(manager.setBestScore(16)).toBe(false);
    expect(collector.failures).toHaveLength(1);
    expect(collector.failures[0]).toStrictEqual({
      operation: 'write',
      key: BEST_SCORE_KEY,
      strategy: 'injected',
      error: { name: quota.name, message: quota.message, quota: true },
    });
  });

  it('records the failed attempt with ok false, unlike the void L58', () => {
    const store = new InstrumentedStorage({ setItem: createQuotaError() });
    const collector = createReportCollector();
    const manager = new LocalStorageManager({
      storage: store,
      reporter: collector,
    });
    const board = createEmptyBoard();

    expect(manager.setGameState(board)).toBe(false);
    expect(collector.writes).toHaveLength(1);

    const write = collector.writes[0];

    expect(write.key).toBe(GAME_STATE_KEY);
    expect(write.ok).toBe(false);
    expect(write.byteLength).toBe(
      JSON.stringify(board).length * BYTES_PER_UTF16_UNIT
    );
  });

  it('returns false with no reporter, optional at L47-L49 and L58', () => {
    const store = new InstrumentedStorage({ setItem: createQuotaError() });
    const manager = expectNoThrow(
      () => new LocalStorageManager({ storage: store })
    );

    expect(manager.strategy).toBe('injected');
    expect(expectNoThrow(() => manager.setGameState(createEmptyBoard())))
      .toBe(false);
    expect(expectNoThrow(() => manager.setBestScore(4))).toBe(false);
    expect(manager.reporterFaults).toBe(0);
    expect(manager.lastReporterFault).toBeUndefined();
  });

  it('reports StorageWriteInfo ok true and no failure, past L58', () => {
    const store = new MemoryStorage();
    const collector = createReportCollector();
    const manager = new LocalStorageManager({
      storage: store,
      reporter: collector,
    });

    expect(manager.setGameState(createEmptyBoard())).toBe(true);
    expect(collector.failures).toStrictEqual([]);
    expect(collector.writes).toHaveLength(1);

    const write = collector.writes[0];
    const stored = readEntry(store, GAME_STATE_KEY);

    expect(write.key).toBe(GAME_STATE_KEY);
    expect(write.ok).toBe(true);
    expect(write.byteLength).toBe(
      (stored === null ? 0 : stored.length) * BYTES_PER_UTF16_UNIT
    );
    expect(write.byteLength).toBeGreaterThan(0);
  });
});


/* ===== 11. Clearing the board snapshot ===== */

describe('clearGameState() (L61-L63)', () => {
  it('removes GAME_STATE_KEY and returns true, replacing L62', () => {
    const store = new MemoryStorage();
    const manager = new LocalStorageManager({ storage: store });

    expect(manager.setGameState(createBlockedBoard())).toBe(true);
    expect(readEntry(store, GAME_STATE_KEY)).not.toBeNull();

    expect(expectNoThrow(() => manager.clearGameState())).toBe(true);

    expect(readEntry(store, GAME_STATE_KEY)).toBeNull();
    expect(manager.getGameState()).toBeNull();
  });

  it('leaves BEST_SCORE_KEY byte-identical, as L61-L63 did', () => {
    const store = new MemoryStorage();

    store.setItem(BEST_SCORE_KEY, SEEDED_BEST_SCORE);

    const manager = new LocalStorageManager({ storage: store });

    expect(manager.setGameState(createEmptyBoard())).toBe(true);
    expect(manager.clearGameState()).toBe(true);

    expect(readEntry(store, GAME_STATE_KEY)).toBeNull();
    expect(readEntry(store, BEST_SCORE_KEY)).toBe(SEEDED_BEST_SCORE);
  });

  it('leaves RUN_STATE_KEY byte-identical across the L62 removal', () => {
    const store = new MemoryStorage();
    const manager = new LocalStorageManager({ storage: store });

    expect(manager.writeJson(RUN_STATE_KEY, createEmptyBoard())).toBe(true);
    expect(manager.setGameState(createBlockedBoard())).toBe(true);

    const runState = readEntry(store, RUN_STATE_KEY);

    expect(runState).not.toBeNull();
    expect(manager.clearGameState()).toBe(true);

    expect(readEntry(store, GAME_STATE_KEY)).toBeNull();
    expect(readEntry(store, RUN_STATE_KEY)).toBe(runState);
  });

  it('returns true with no snapshot, as removeItem at L62 did', () => {
    const store = new MemoryStorage();
    const manager = new LocalStorageManager({ storage: store });

    expect(readEntry(store, GAME_STATE_KEY)).toBeNull();
    expect(expectNoThrow(() => manager.clearGameState())).toBe(true);
    expect(expectNoThrow(() => manager.clearGameState())).toBe(true);
    expect(readEntry(store, GAME_STATE_KEY)).toBeNull();
  });

  it('returns false and reports when removal throws, unlike L62', () => {
    const denied = createAccessError();
    const collector = createReportCollector();
    const manager = new LocalStorageManager({
      storage: new InstrumentedStorage({ removeItem: denied }),
      reporter: collector,
    });

    expect(expectNoThrow(() => manager.clearGameState())).toBe(false);
    expect(collector.failures).toHaveLength(1);
    expect(collector.failures[0]).toStrictEqual({
      operation: 'remove',
      key: GAME_STATE_KEY,
      strategy: 'injected',
      error: { name: denied.name, message: denied.message, quota: false },
    });
  });
});

/* ===== 12. The generic namespaced API ===== */

/**
 * The persistence surface src/run/run-state-store.ts binds to, declared
 * locally. This suite imports nothing from src/run/.
 */
interface RunStatePersistencePort {
  readJson(key: OwnedStorageKey): unknown;

  writeJson(key: OwnedStorageKey, value: unknown): boolean;

  removeRaw(key: OwnedStorageKey): boolean;
}

describe('generic namespaced API — the run-state persistence port', () => {
  it('round-trips writeRaw and readRaw under a namespacedKey()', () => {
    const store = new MemoryStorage();
    const manager = new LocalStorageManager({ storage: store });

    expect(manager.writeRaw(SCRATCH_KEY, SEEDED_BEST_SCORE)).toBe(true);
    expect(manager.readRaw(SCRATCH_KEY)).toBe(SEEDED_BEST_SCORE);
    expect(readEntry(store, SCRATCH_KEY)).toBe(SEEDED_BEST_SCORE);
  });

  it('makes a key absent through removeRaw, as L62 did for one', () => {
    const store = new MemoryStorage();
    const manager = new LocalStorageManager({ storage: store });

    expect(manager.writeRaw(SCRATCH_KEY, SEEDED_BEST_SCORE)).toBe(true);
    expect(expectNoThrow(() => manager.removeRaw(SCRATCH_KEY))).toBe(true);

    expect(manager.readRaw(SCRATCH_KEY)).toBeNull();
    expect(readEntry(store, SCRATCH_KEY)).toBeNull();
  });

  it('round-trips writeJson and readJson under RUN_STATE_KEY', () => {
    const board = createBlockedBoard();
    const manager = new LocalStorageManager({ storage: new MemoryStorage() });

    expect(manager.writeJson(RUN_STATE_KEY, board)).toBe(true);

    const restored = expectPersistedBoard(manager.readJson(RUN_STATE_KEY));

    expect(restored).toStrictEqual(board);
    expect(restored.grid.cells).toStrictEqual(board.grid.cells);
    expect(countEmptyCells(restored)).toBe(countEmptyCells(board));
  });

  it('returns null from readJson for corrupt JSON, as at L54', () => {
    const store = new MemoryStorage();
    const corrupt = CORRUPT_TEXTS[2];

    store.setItem(RUN_STATE_KEY, corrupt.text);

    const collector = createReportCollector();
    const manager = new LocalStorageManager({
      storage: store,
      reporter: collector,
    });

    expect(expectNoThrow(() => manager.readJson(RUN_STATE_KEY))).toBeNull();
    expect(collector.failures).toHaveLength(1);
    expect(collector.failures[0].operation).toBe('read');
    expect(collector.failures[0].key).toBe(RUN_STATE_KEY);
    expect(collector.failures[0].error.name).toBe('SyntaxError');
    expect(readEntry(store, RUN_STATE_KEY)).toBe(corrupt.text);
  });

  it('writeJson to RUN_STATE_KEY leaves both frozen keys intact', () => {
    const store = new MemoryStorage();

    store.setItem(BEST_SCORE_KEY, SEEDED_BEST_SCORE);

    const manager = new LocalStorageManager({ storage: store });

    expect(manager.setGameState(createBlockedBoard())).toBe(true);

    const bestScore = readEntry(store, BEST_SCORE_KEY);
    const gameState = readEntry(store, GAME_STATE_KEY);

    expect(bestScore).toBe(SEEDED_BEST_SCORE);
    expect(gameState).not.toBeNull();

    expect(manager.writeJson(RUN_STATE_KEY, createEmptyBoard())).toBe(true);

    expect(readEntry(store, BEST_SCORE_KEY)).toBe(bestScore);
    expect(readEntry(store, GAME_STATE_KEY)).toBe(gameState);
    expect(readEntry(store, RUN_STATE_KEY)).not.toBeNull();
  });

  it('satisfies a minimal readJson/writeJson/removeRaw port', () => {
    const store = new MemoryStorage();
    const board = createEmptyBoard();
    const port: RunStatePersistencePort = new LocalStorageManager({
      storage: store,
    });

    expect(port.writeJson(RUN_STATE_KEY, board)).toBe(true);
    expect(expectPersistedBoard(port.readJson(RUN_STATE_KEY)))
      .toStrictEqual(board);
    expect(port.removeRaw(RUN_STATE_KEY)).toBe(true);
    expect(port.readJson(RUN_STATE_KEY)).toBeNull();
    expect(readEntry(store, RUN_STATE_KEY)).toBeNull();
  });

  it('writeJson returns false for a value serialising to no JSON', () => {
    const store = new MemoryStorage();
    const collector = createReportCollector();
    const manager = new LocalStorageManager({
      storage: store,
      reporter: collector,
    });

    expect(expectNoThrow(() => manager.writeJson(RUN_STATE_KEY, undefined)))
      .toBe(false);

    expect(readEntry(store, RUN_STATE_KEY)).toBeNull();
    expect(collector.failures).toHaveLength(1);
    expect(collector.failures[0].operation).toBe('write');
    expect(collector.failures[0].key).toBe(RUN_STATE_KEY);
    expect(collector.writes).toHaveLength(1);
    expect(collector.writes[0].ok).toBe(false);
    expect(collector.writes[0].byteLength).toBe(0);
  });

  it('routes a writeJson failure as setGameState does at L57-L59', () => {
    const quota = createQuotaError();
    const collector = createReportCollector();
    const manager = new LocalStorageManager({
      storage: new InstrumentedStorage({ setItem: quota }),
      reporter: collector,
    });

    const board = createEmptyBoard();

    expect(expectNoThrow(() => manager.writeJson(RUN_STATE_KEY, board)))
      .toBe(false);
    expect(collector.failures).toHaveLength(1);
    expect(collector.failures[0]).toStrictEqual({
      operation: 'write',
      key: RUN_STATE_KEY,
      strategy: 'injected',
      error: { name: quota.name, message: quota.message, quota: true },
    });
    expect(collector.writes).toHaveLength(1);
    expect(collector.writes[0].ok).toBe(false);
  });

  it('routes a readJson failure as getGameState does at L52-L55', () => {
    const denied = createAccessError();
    const collector = createReportCollector();
    const manager = new LocalStorageManager({
      storage: new InstrumentedStorage({ getItem: denied }),
      reporter: collector,
    });

    expect(expectNoThrow(() => manager.readJson(RUN_STATE_KEY))).toBeNull();
    expect(collector.failures).toHaveLength(1);
    expect(collector.failures[0]).toStrictEqual({
      operation: 'read',
      key: RUN_STATE_KEY,
      strategy: 'injected',
      error: { name: denied.name, message: denied.message, quota: false },
    });
  });
});

/* ===== 13. Reporter fault containment ===== */

describe('reporter fault containment (reporterFaults)', () => {
  it('contains a throwing onProbe sink; construction clears L25', () => {
    const fault = new Error('The probe sink is broken.');
    const store = new MemoryStorage();
    const manager = expectNoThrow(
      () =>
        new LocalStorageManager({
          storage: store,
          reporter: createThrowingReporter(fault),
        })
    );

    expect(manager.strategy).toBe('injected');
    expect(manager.reporterFaults).toBe(1);
    expect(manager.reporterFailures).toBe(1);
    expect(manager.lastReporterFault).toStrictEqual({
      name: fault.name,
      message: fault.message,
      quota: false,
    });
  });

  it('contains a throwing onFailure sink and keeps the L58 false', () => {
    const fault = new Error('The failure sink is broken.');
    const manager = new LocalStorageManager({
      storage: new InstrumentedStorage({ setItem: createQuotaError() }),
      reporter: createThrowingReporter(fault),
    });
    const faultsBefore = manager.reporterFaults;

    expect(expectNoThrow(() => manager.setGameState(createEmptyBoard())))
      .toBe(false);
    expect(manager.reporterFaults).toBeGreaterThan(faultsBefore);
    expect(manager.lastReporterFault?.message).toBe(fault.message);
  });

  it('contains a throwing onWrite sink; the L58 write returns true', () => {
    const fault = new Error('The write sink is broken.');
    const store = new MemoryStorage();
    const manager = new LocalStorageManager({
      storage: store,
      reporter: createThrowingReporter(fault),
    });
    const board = createEmptyBoard();
    const faultsBefore = manager.reporterFaults;

    expect(expectNoThrow(() => manager.setGameState(board))).toBe(true);
    expect(expectPersistedBoard(manager.getGameState())).toStrictEqual(board);
    expect(manager.reporterFaults).toBe(faultsBefore + 1);
    expect(manager.reporterFailures).toBe(manager.reporterFaults);
  });

  it('reports zero reporterFaults for a reporter that behaves', () => {
    const collector = createReportCollector();
    const manager = new LocalStorageManager({
      storage: new MemoryStorage(),
      reporter: collector,
    });

    expect(manager.setGameState(createEmptyBoard())).toBe(true);
    expect(manager.clearGameState()).toBe(true);
    expect(manager.reporterFaults).toBe(0);
    expect(manager.reporterFailures).toBe(0);
    expect(manager.lastReporterFault).toBeUndefined();
  });
});

