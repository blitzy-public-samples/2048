// Unit suite for src/storage/local-storage-manager.ts, covering its
// non-best-score surface: the guarded snapshot parse, the boolean-returning
// writes and their structured failure reports, the once-at-construction
// writability probe, and the generic namespaced API the run-state envelope
// rides on.
//
// Scope split across tests/unit/storage/: the frozen best-score contract is
// asserted in ./best-score.test.ts. Nothing here imports from src/run/ or
// src/observability/.
//
// Decisions: DL-STORE-01, DL-STORE-02, DL-STORE-03, DL-STORE-04
// (docs/DECISION_LOG.md).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LocalStorageManager,
  PARSE_ERROR_NAME,
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

const STORAGE_STRATEGIES: readonly StorageStrategy[] = [
  'localStorage',
  'memory',
  'injected',
];

const BYTES_PER_UTF16_UNIT = 2;

const SCRATCH_KEY = namespacedKey('unitStorageScratch');

const SWEPT_KEYS: readonly OwnedStorageKey[] = [
  ...OWNED_STORAGE_KEYS,
  STORAGE_PROBE_KEY,
  SCRATCH_KEY,
];

const SEEDED_BEST_SCORE = '4096';

const CORRUPT_TEXTS: readonly { label: string; text: string }[] = [
  { label: 'an unquoted object body', text: '{not json' },
  { label: 'the bare word undefined', text: 'undefined' },
  { label: 'a truncated object', text: '{"grid":{"size":4,"cells":[' },
  { label: 'a truncated array', text: '[2,4,' },
];

const NON_BOARD_TEXTS: readonly {
  label: string;
  text: string;
  parsed: unknown;
}[] = [
  { label: 'a number', text: '42', parsed: 42 },
  { label: 'a string', text: '"text"', parsed: 'text' },
  { label: 'the JSON null literal', text: 'null', parsed: null },
];

/**
 * Name the adapter reports a refused key under, in place of an error it never
 * constructs.
 */
const REJECTED_KEY_ERROR_NAME = 'StorageKeyError';

/** Characters of a refused key the adapter reports before truncating. */
const MAX_REPORTED_KEY_LENGTH = 64;

/** The ellipsis a truncated key is reported with. */
const KEY_TRUNCATION_SUFFIX = '…';

/**
 * Keys the product does not own, each with the label its test title quotes.
 */
const UNOWNED_KEYS: readonly { label: string; key: string }[] = [
  { label: "another application's key", key: 'theme' },
  { label: 'a foreign key carrying a delimiter', key: 'user:token' },
  { label: 'the best-score literal in lower case', key: 'bestscore' },
  { label: 'the best-score literal with a trailing space', key: 'bestScore ' },
  { label: 'the snapshot literal pluralised', key: 'gameStates' },
  { label: 'a misspelled namespace', key: 'roguelike2049:runState' },
  { label: 'the namespace with an empty name', key: 'roguelike2048:' },
  { label: 'a doubled delimiter', key: 'roguelike2048::runState' },
  { label: 'a name holding a space', key: 'roguelike2048:run State' },
  { label: 'the empty string', key: '' },
];

/** A refused key longer than the adapter reports in full. */
const OVERLONG_UNOWNED_KEY = `unowned-${'k'.repeat(120)}`;

/**
 * Values `JSON.stringify` cannot reduce to text, each with the label its test
 * title quotes and the name of the error the adapter reports.
 */
const UNSERIALISABLE_VALUES: readonly {
  label: string;
  build: () => unknown;
  errorName: string;
}[] = [
  {
    label: 'a circular object',
    build: (): unknown => {
      const circular: Record<string, unknown> = { id: 'run' };

      circular['self'] = circular;

      return circular;
    },
    errorName: 'TypeError',
  },
  {
    label: 'a circular array',
    build: (): unknown => {
      const cells: unknown[] = [];

      cells.push(cells);

      return { grid: { size: 1, cells } };
    },
    errorName: 'TypeError',
  },
  {
    label: 'a BigInt',
    build: (): unknown => BigInt(2048),
    errorName: 'TypeError',
  },
  {
    label: 'an object holding a BigInt',
    build: (): unknown => ({ score: BigInt(2048) }),
    errorName: 'TypeError',
  },
  {
    label: 'undefined',
    build: (): unknown => undefined,
    errorName: 'TypeError',
  },
  {
    label: 'a function',
    build: (): unknown => (): number => 2048,
    errorName: 'TypeError',
  },
  {
    label: 'a symbol',
    build: (): unknown => Symbol('run'),
    errorName: 'TypeError',
  },
];

/** A `StorageReporter` that keeps every report it is handed. */
interface ReportCollector extends StorageReporter {
  readonly probes: StorageProbeResult[];
  readonly failures: StorageFailure[];
  readonly writes: StorageWriteInfo[];
}

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

function createThrowingReporter(fault: unknown): StorageReporter {
  const raise = (): never => {
    throw fault;
  };

  return { onProbe: raise, onFailure: raise, onWrite: raise };
}

interface StorageFaults {
  readonly getItem?: unknown;
  readonly setItem?: unknown;
  readonly removeItem?: unknown;
}

class InstrumentedStorage implements StorageLike {
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

  private raise(fault: unknown): void {
    if (fault !== undefined) {
      throw fault;
    }
  }
}

function createQuotaError(): DOMException {
  return new DOMException('The quota has been exceeded.', 'QuotaExceededError');
}

function createAccessError(): DOMException {
  return new DOMException('Access to storage is denied.', 'SecurityError');
}

const WEB_STORAGE_PROPERTY = 'localStorage';

let originalWebStorage: PropertyDescriptor | undefined;

let webStorageReplaced = false;

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

function ambientStorage(): StorageLike | undefined {
  let candidate: unknown;

  try {
    candidate = globalThis.localStorage;
  } catch {
    return undefined;
  }

  return isStorageLikeValue(candidate) ? candidate : undefined;
}

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

function sweepKeys(store: StorageLike | undefined): void {
  if (store === undefined) {
    return;
  }

  for (const key of SWEPT_KEYS) {
    store.removeItem(key);
  }
}

function expectNoThrow<T>(operation: () => T): T {
  const outcomes: T[] = [];

  expect(() => {
    outcomes.push(operation());
  }).not.toThrow();
  expect(outcomes).toHaveLength(1);

  return outcomes[0];
}

function readEntry(store: StorageLike, key: OwnedStorageKey): string | null {
  return store.getItem(key) ?? null;
}

type PersistedBoard = ReturnType<typeof createEmptyBoard>;

type PersistedGrid = PersistedBoard['grid'];

function isPosition(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  if (!('x' in value) || !('y' in value)) {
    return false;
  }

  return typeof value.x === 'number' && typeof value.y === 'number';
}

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

function isColumn(value: unknown): boolean {
  return Array.isArray(value) && value.every(isCell);
}

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

function expectPersistedBoard(value: unknown): PersistedBoard {
  expect(isPersistedBoard(value)).toBe(true);

  if (!isPersistedBoard(value)) {
    throw new TypeError('Value is not a persisted board snapshot.');
  }

  return value;
}

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
    expect(error?.quota).toBe(true);

    // The public message is authored by the module, not carried from the
    // caught value: it is a field an export publishes.
    expect(error?.message).not.toBe(quota.message);
    expect(error?.message).toBe('Storage is full; the operation was refused.');

    // The value that was thrown travels beside the description, unconverted,
    // so its stack and its subclass survive for a logger.
    expect(result.thrown).toBe(quota);
  });

  it('flags denied access as non-quota, a distinction L38 lost', () => {
    const denied = createAccessError();

    replaceWebStorage(new InstrumentedStorage({ setItem: denied }));

    const result = probeWebStorage();

    expect(result.supported).toBe(false);
    expect(result.error?.name).toBe(denied.name);
    expect(result.error?.quota).toBe(false);
    expect(result.error?.message).not.toBe(denied.message);
    expect(result.error?.message).toBe('Storage refused the operation.');
    expect(result.thrown).toBe(denied);
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
      error: {
        name: quota.name,
        message: 'Storage is full; the operation was refused.',
        quota: true,
        parse: false,
      },

      // The failure channel carries the original alongside the description, so
      // the logger adapter records the thrown value and not a summary of it.
      thrown: quota,
    });
  });
});

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

    // DL-STORE-09. The name is now reported rather than flattened: a value
    // that did not parse is the one storage fault a corrupted origin actually
    // produces, and "StorageError: Unknown storage error." named neither its
    // cause nor its consequence.
    expect(failure.error.name).toBe(PARSE_ERROR_NAME);
    expect(failure.error.name).toBe('SyntaxError');
    expect(failure.error.message).toBe(
      'The stored value is not valid JSON; it was ignored.'
    );

    // Unchanged and the reason the description is a substitution at all: the
    // parser's own text can quote the stored value, so the bounded message
    // stands in for it. Reporting the name does not relax this.
    expect(failure.error.message).not.toContain(corrupt.text);
    expect(failure.error.quota).toBe(false);

    // The parse error itself is still delivered, so the logger records what
    // was thrown.
    expect(failure.thrown).toBeInstanceOf(SyntaxError);
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
    expect(failure.error.message).toBe(
      'Storage is full; the operation was refused.',
    );
    expect(failure.error.quota).toBe(true);
    expect(failure.thrown).toBe(quota);
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
      error: {
        name: quota.name,
        message: 'Storage is full; the operation was refused.',
        quota: true,
        parse: false,
      },
      thrown: quota,
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
      error: {
        name: denied.name,
        message: 'Storage refused the operation.',
        quota: false,
        parse: false,
      },
      thrown: denied,
    });
  });
});

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
    // DL-STORE-09: the parse failure keeps its own name here too.
    expect(collector.failures[0].error.name).toBe(PARSE_ERROR_NAME);
    expect(collector.failures[0].error.message).not.toContain(corrupt.text);
    expect(collector.failures[0].thrown).toBeInstanceOf(SyntaxError);
    expect(readEntry(store, RUN_STATE_KEY)).toBe(corrupt.text);
  });

  // DL-STORE-09. The parse memo is keyed on the raw text, and a failure is now
  // memoised against it rather than dropped — so two consumers reading one
  // unreadable key file one report between them instead of one report each.
  // QA saw the boot's own two reads of the run-state key produce the message
  // twice; this is that behaviour at the module that owns the memo.
  it('reports one failure however often an unreadable value is read', () => {
    const store = new MemoryStorage();
    const corrupt = CORRUPT_TEXTS[2];

    store.setItem(RUN_STATE_KEY, corrupt.text);

    const collector = createReportCollector();
    const manager = new LocalStorageManager({
      storage: store,
      reporter: collector,
    });

    expect(manager.readJson(RUN_STATE_KEY)).toBeNull();
    expect(manager.readJson(RUN_STATE_KEY)).toBeNull();
    expect(manager.readJson(RUN_STATE_KEY)).toBeNull();

    expect(collector.failures).toHaveLength(1);
    expect(collector.failures[0].error.name).toBe(PARSE_ERROR_NAME);

    // A different unreadable value is a different failure: the memo must not
    // silence the next corruption, only repeat readings of the same one.
    store.setItem(RUN_STATE_KEY, CORRUPT_TEXTS[0].text);

    expect(manager.readJson(RUN_STATE_KEY)).toBeNull();
    expect(collector.failures).toHaveLength(2);
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
      error: {
        name: quota.name,
        message: 'Storage is full; the operation was refused.',
        quota: true,
        parse: false,
      },
      thrown: quota,
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
      error: {
        name: denied.name,
        message: 'Storage refused the operation.',
        quota: false,
        parse: false,
      },
      thrown: denied,
    });
  });
});

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
    // A contained reporter fault is described by the same allowlist: a plain
    // `Error` is not one of the names this module reports, and the sink's own
    // text is not carried into a field an export publishes.
    expect(manager.lastReporterFault).toStrictEqual({
      name: 'StorageError',
      message: 'Unknown storage error.',
      quota: false,
      parse: false,
    });
    expect(manager.lastReporterFault?.message).not.toBe(fault.message);
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
    expect(manager.lastReporterFault?.name).toBe('StorageError');
    expect(manager.lastReporterFault?.message).not.toBe(fault.message);
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

// `acceptKey` runs before any store operation, so a key the product does not
// own is refused, reported and never handed to the store.
describe('the ownership guard refuses an unowned key before the store', () => {
  /**
   * Builds a manager over a store that records every operation it receives.
   *
   * @returns The manager, the recording store and the report collector.
   */
  function createGuardedManager(): {
    manager: LocalStorageManager;
    store: InstrumentedStorage;
    collector: ReportCollector;
  } {
    const store = new InstrumentedStorage();
    const collector = createReportCollector();
    const manager = new LocalStorageManager({
      storage: store,
      reporter: collector,
    });

    // Construction touches the global store through the probe, never the
    // injected one, so the record starts empty for the operation under test.
    expect(store.operations).toStrictEqual([]);

    return { manager, store, collector };
  }

  it('records no operation on the injected store during construction', () => {
    const { store, manager } = createGuardedManager();

    expect(manager.strategy).toBe('injected');
    expect(store.operations).toStrictEqual([]);
  });

  it.each(UNOWNED_KEYS)(
    'refuses a readRaw of $label without touching the store',
    ({ key }: { key: string }) => {
      const { manager, store, collector } = createGuardedManager();

      expect(
        expectNoThrow(() => manager.readRaw(key as OwnedStorageKey))
      ).toBeNull();
      expect(store.operations).toStrictEqual([]);
      expect(collector.failures).toHaveLength(1);
      expect(collector.failures[0].operation).toBe('read');
      expect(collector.failures[0].key).toBe(key);
      expect(collector.failures[0].error.name).toBe(REJECTED_KEY_ERROR_NAME);
      expect(collector.failures[0].error.quota).toBe(false);
    }
  );

  it.each(UNOWNED_KEYS)(
    'refuses a writeRaw of $label without touching the store',
    ({ key }: { key: string }) => {
      const { manager, store, collector } = createGuardedManager();

      expect(
        expectNoThrow(() => manager.writeRaw(key as OwnedStorageKey, 'value'))
      ).toBe(false);
      expect(store.operations).toStrictEqual([]);
      expect(collector.failures).toHaveLength(1);
      expect(collector.failures[0].operation).toBe('write');
      expect(collector.failures[0].key).toBe(key);
      expect(collector.failures[0].error.name).toBe(REJECTED_KEY_ERROR_NAME);

      // The write is refused before the value is measured, so no write report
      // is produced for it at all.
      expect(collector.writes).toStrictEqual([]);
    }
  );

  it.each(UNOWNED_KEYS)(
    'refuses a removeRaw of $label without touching the store',
    ({ key }: { key: string }) => {
      const { manager, store, collector } = createGuardedManager();

      expect(
        expectNoThrow(() => manager.removeRaw(key as OwnedStorageKey))
      ).toBe(false);
      expect(store.operations).toStrictEqual([]);
      expect(collector.failures).toHaveLength(1);
      expect(collector.failures[0].operation).toBe('remove');
      expect(collector.failures[0].key).toBe(key);
      expect(collector.failures[0].error.name).toBe(REJECTED_KEY_ERROR_NAME);
    }
  );

  it.each(UNOWNED_KEYS)(
    'refuses a readJson of $label without touching the store',
    ({ key }: { key: string }) => {
      const { manager, store, collector } = createGuardedManager();

      expect(
        expectNoThrow(() => manager.readJson(key as OwnedStorageKey))
      ).toBeNull();
      expect(store.operations).toStrictEqual([]);
      expect(collector.failures).toHaveLength(1);
      expect(collector.failures[0].operation).toBe('read');
      expect(collector.failures[0].error.name).toBe(REJECTED_KEY_ERROR_NAME);
    }
  );

  it.each(UNOWNED_KEYS)(
    'refuses a writeJson of $label and serialises nothing for it',
    ({ key }: { key: string }) => {
      const { manager, store, collector } = createGuardedManager();
      let serialised = false;
      const value = {
        get score(): number {
          serialised = true;

          return 1;
        },
      };

      expect(
        expectNoThrow(() => manager.writeJson(key as OwnedStorageKey, value))
      ).toBe(false);
      expect(serialised).toBe(false);
      expect(store.operations).toStrictEqual([]);
      expect(collector.writes).toStrictEqual([]);
      expect(collector.failures).toHaveLength(1);
      expect(collector.failures[0].operation).toBe('write');
      expect(collector.failures[0].error.name).toBe(REJECTED_KEY_ERROR_NAME);
    }
  );

  it('reports the refusal without naming the refused key in the ' +
    'message', () => {
    const { manager, collector } = createGuardedManager();

    expect(manager.readRaw('theme' as OwnedStorageKey)).toBeNull();

    // The key travels on its own bounded field; interpolating it into the
    // message would publish caller-supplied text twice.
    expect(collector.failures[0].error.message).toBe(
      'The key is not owned by this product; the operation was refused ' +
        'and no storage was touched.'
    );
    expect(collector.failures[0].error.message).not.toContain('theme');
    expect(collector.failures[0].key).toBe('theme');

    // Nothing was thrown, so no original travels with it.
    expect(collector.failures[0].thrown).toBeUndefined();
  });

  it('truncates an overlong refused key to the reporting limit', () => {
    const { manager, store, collector } = createGuardedManager();

    expect(OVERLONG_UNOWNED_KEY.length).toBeGreaterThan(
      MAX_REPORTED_KEY_LENGTH
    );
    expect(
      manager.writeRaw(OVERLONG_UNOWNED_KEY as OwnedStorageKey, 'value')
    ).toBe(false);

    const reported = collector.failures[0].key;

    expect(reported).toBe(
      `${OVERLONG_UNOWNED_KEY.slice(0, MAX_REPORTED_KEY_LENGTH)}` +
        KEY_TRUNCATION_SUFFIX
    );
    expect(reported).toHaveLength(MAX_REPORTED_KEY_LENGTH + 1);
    expect(collector.failures[0].error.message).not.toContain(reported);
    expect(store.operations).toStrictEqual([]);
  });

  it('reports a refused key at exactly the limit in full', () => {
    const { manager, collector } = createGuardedManager();
    const exact = 'u'.repeat(MAX_REPORTED_KEY_LENGTH);

    expect(manager.removeRaw(exact as OwnedStorageKey)).toBe(false);
    expect(collector.failures[0].key).toBe(exact);
    expect(collector.failures[0].key).not.toContain(KEY_TRUNCATION_SUFFIX);
  });

  it('carries the strategy in use on the refusal it reports', () => {
    const { manager, collector } = createGuardedManager();

    expect(manager.removeRaw('theme' as OwnedStorageKey)).toBe(false);
    expect(collector.failures[0].strategy).toBe(manager.strategy);
    expect(collector.failures[0].strategy).toBe('injected');
  });

  it('keeps serving owned keys after a refusal', () => {
    const { manager, store, collector } = createGuardedManager();

    expect(manager.writeRaw('theme' as OwnedStorageKey, 'value')).toBe(false);
    expect(manager.writeRaw(SCRATCH_KEY, SEEDED_BEST_SCORE)).toBe(true);
    expect(manager.readRaw(SCRATCH_KEY)).toBe(SEEDED_BEST_SCORE);
    expect(store.operations).toStrictEqual([
      `setItem:${SCRATCH_KEY}`,
      `getItem:${SCRATCH_KEY}`,
    ]);
    expect(collector.failures).toHaveLength(1);
  });
});

// `serialiseJson` reports and returns null for both failure shapes: a
// `JSON.stringify` that throws, and one that returns no string.
describe('writeJson refuses a value that cannot be serialised', () => {
  it.each(UNSERIALISABLE_VALUES)(
    'returns false for $label and stores nothing',
    ({ build }: { build: () => unknown }) => {
      const store = new InstrumentedStorage();
      const manager = new LocalStorageManager({ storage: store });

      expect(
        expectNoThrow(() => manager.writeJson(RUN_STATE_KEY, build()))
      ).toBe(false);
      expect(store.operations).toStrictEqual([]);
    }
  );

  it.each(UNSERIALISABLE_VALUES)(
    'reports $label as a failed write of zero bytes',
    ({ build, errorName }: { build: () => unknown; errorName: string }) => {
      const collector = createReportCollector();
      const manager = new LocalStorageManager({
        storage: new InstrumentedStorage(),
        reporter: collector,
      });

      expect(manager.writeJson(RUN_STATE_KEY, build())).toBe(false);
      expect(collector.writes).toStrictEqual([
        { key: RUN_STATE_KEY, byteLength: 0, ok: false },
      ]);
      expect(collector.failures).toHaveLength(1);
      expect(collector.failures[0].operation).toBe('write');
      expect(collector.failures[0].key).toBe(RUN_STATE_KEY);
      expect(collector.failures[0].error.name).toBe(errorName);
      expect(collector.failures[0].error.quota).toBe(false);
    }
  );

  it('leaves an earlier value under the key in place', () => {
    const store = new MemoryStorage();
    const manager = new LocalStorageManager({ storage: store });
    const board = createEmptyBoard();

    expect(manager.writeJson(RUN_STATE_KEY, board)).toBe(true);

    const persisted = readEntry(store, RUN_STATE_KEY);

    expect(manager.writeJson(RUN_STATE_KEY, undefined)).toBe(false);
    expect(readEntry(store, RUN_STATE_KEY)).toBe(persisted);
  });

  it('keeps writing after a serialisation failure', () => {
    const store = new MemoryStorage();
    const collector = createReportCollector();
    const manager = new LocalStorageManager({
      storage: store,
      reporter: collector,
    });

    expect(manager.writeJson(RUN_STATE_KEY, Symbol('run'))).toBe(false);
    expect(manager.writeJson(RUN_STATE_KEY, createEmptyBoard())).toBe(true);
    expect(readEntry(store, RUN_STATE_KEY)).not.toBeNull();
    expect(collector.writes).toHaveLength(2);
    expect(collector.writes[0].ok).toBe(false);
    expect(collector.writes[0].byteLength).toBe(0);
    expect(collector.writes[1].ok).toBe(true);
    expect(collector.writes[1].byteLength).toBeGreaterThan(0);
  });

  it('measures a successful write in UTF-16 code units', () => {
    const collector = createReportCollector();
    const manager = new LocalStorageManager({
      storage: new MemoryStorage(),
      reporter: collector,
    });
    const board = createEmptyBoard();

    expect(manager.writeJson(RUN_STATE_KEY, board)).toBe(true);
    expect(collector.writes).toStrictEqual([
      {
        key: RUN_STATE_KEY,
        byteLength: JSON.stringify(board).length * BYTES_PER_UTF16_UNIT,
        ok: true,
      },
    ]);
  });
});

/**
 * ADDED: parse provenance is CARRIED, not inferred from the error's name.
 *
 * `JSON.parse` is not the only source of a `SyntaxError` this adapter can
 * catch. A `toJSON` member raises one during serialisation, and an injected or
 * hostile store member can raise one during a write, a probe or a removal.
 * Each of those is an operation that FAILED, and describing it as "The stored
 * value is not valid JSON; it was ignored." named an event that never happened
 * and, in the composition root, demoted a lost write to a recovered read.
 *
 * Every case below therefore fixes both halves of the classification: the
 * `parse` tag and the message that follows from it. DL-STORE-09.
 */
describe('SyntaxError provenance — parse tag over error name', () => {
  /** A `SyntaxError` from somewhere that is not the stored-text parse. */
  function createSyntaxFault(): SyntaxError {
    return new SyntaxError('Unexpected token in a hostile store member.');
  }

  it('tags the stored-text parse, the one true parse failure', () => {
    const store = new InstrumentedStorage();

    store.setItem(GAME_STATE_KEY, CORRUPT_TEXTS[0].text);

    const collector = createReportCollector();
    const manager = new LocalStorageManager({
      storage: store,
      reporter: collector,
    });

    expect(manager.getGameState()).toBeNull();
    expect(collector.failures).toHaveLength(1);

    const failure = collector.failures[0];

    expect(failure.operation).toBe('read');
    expect(failure.error.name).toBe(PARSE_ERROR_NAME);

    // The tag, which is what a consumer reads.
    expect(failure.error.parse).toBe(true);
    expect(failure.error.message).toBe(
      'The stored value is not valid JSON; it was ignored.'
    );
  });

  it('does not tag a SyntaxError raised by a store write', () => {
    const fault = createSyntaxFault();
    const collector = createReportCollector();
    const manager = new LocalStorageManager({
      storage: new InstrumentedStorage({ setItem: fault }),
      reporter: collector,
    });

    expect(expectNoThrow(() => manager.setBestScore(2048))).toBe(false);
    expect(collector.failures).toHaveLength(1);

    const failure = collector.failures[0];

    // Nothing was read and nothing was parsed: a write was lost.
    expect(failure.operation).toBe('write');
    expect(failure.error.name).toBe(PARSE_ERROR_NAME);
    expect(failure.error.parse).toBe(false);
    expect(failure.error.message).toBe('Unknown storage error.');
    expect(failure.error.message).not.toBe(
      'The stored value is not valid JSON; it was ignored.'
    );

    // A lost write is not a refusal either, so the caught value still travels.
    expect(failure.thrown).toBe(fault);
  });

  it('does not tag a SyntaxError raised by a store removal', () => {
    const fault = createSyntaxFault();
    const collector = createReportCollector();
    const manager = new LocalStorageManager({
      storage: new InstrumentedStorage({ removeItem: fault }),
      reporter: collector,
    });

    expect(expectNoThrow(() => manager.clearGameState())).toBe(false);
    expect(collector.failures).toHaveLength(1);
    expect(collector.failures[0]).toStrictEqual({
      operation: 'remove',
      key: GAME_STATE_KEY,
      strategy: 'injected',
      error: {
        name: PARSE_ERROR_NAME,
        message: 'Unknown storage error.',
        quota: false,
        parse: false,
      },
      thrown: fault,
    });
  });

  it('does not tag a SyntaxError raised by a store read', () => {
    const fault = createSyntaxFault();
    const collector = createReportCollector();
    const manager = new LocalStorageManager({
      storage: new InstrumentedStorage({ getItem: fault }),
      reporter: collector,
    });

    // A read whose `getItem` threw never reached a parse, so it is a failed
    // operation and not a recovered value — the distinction the name erased.
    expect(expectNoThrow(() => manager.readJson(RUN_STATE_KEY))).toBeNull();
    expect(collector.failures).toHaveLength(1);
    expect(collector.failures[0].operation).toBe('read');
    expect(collector.failures[0].error.name).toBe(PARSE_ERROR_NAME);
    expect(collector.failures[0].error.parse).toBe(false);
    expect(collector.failures[0].error.message).toBe('Unknown storage error.');
  });

  it('does not tag a SyntaxError raised by the construction probe', () => {
    const fault = createSyntaxFault();

    replaceWebStorage(new InstrumentedStorage({ setItem: fault }));

    const collector = createReportCollector();
    const manager = expectNoThrow(
      () => new LocalStorageManager({ reporter: collector })
    );

    expect(manager.strategy).toBe('memory');
    expect(collector.failures).toHaveLength(1);
    expect(collector.failures[0]).toStrictEqual({
      operation: 'probe',
      key: STORAGE_PROBE_KEY,
      strategy: 'memory',
      error: {
        name: PARSE_ERROR_NAME,
        message: 'Unknown storage error.',
        quota: false,
        parse: false,
      },
      thrown: fault,
    });
  });

  it('does not tag a SyntaxError raised during serialisation', () => {
    const fault = createSyntaxFault();
    const collector = createReportCollector();
    const store = new InstrumentedStorage();
    const manager = new LocalStorageManager({
      storage: store,
      reporter: collector,
    });

    // The realistic in-product route: a value whose own `toJSON` throws. The
    // store is never touched, so no stored text exists to have failed a parse.
    const hostile = {
      toJSON: (): never => {
        throw fault;
      },
    };

    expect(expectNoThrow(() => manager.writeJson(RUN_STATE_KEY, hostile)))
      .toBe(false);
    expect(store.operations).toStrictEqual([]);
    expect(collector.failures).toHaveLength(1);
    expect(collector.failures[0].operation).toBe('write');
    expect(collector.failures[0].error.name).toBe(PARSE_ERROR_NAME);
    expect(collector.failures[0].error.parse).toBe(false);
    expect(collector.failures[0].error.message).toBe('Unknown storage error.');
  });

  it('separates two failures the error name cannot tell apart', () => {
    const store = new InstrumentedStorage();

    store.setItem(GAME_STATE_KEY, CORRUPT_TEXTS[0].text);

    const collector = createReportCollector();
    const manager = new LocalStorageManager({
      storage: store,
      reporter: collector,
    });

    expect(manager.getGameState()).toBeNull();
    expect(
      manager.writeJson(RUN_STATE_KEY, {
        toJSON: (): never => {
          throw createSyntaxFault();
        },
      })
    ).toBe(false);
    expect(collector.failures).toHaveLength(2);

    const [parsed, written] = collector.failures;

    // Identical names. The name is therefore not a classifier.
    expect(parsed.error.name).toBe(written.error.name);
    expect(parsed.error.name).toBe(PARSE_ERROR_NAME);

    // Different events, and now distinguishable.
    expect(parsed.error.parse).toBe(true);
    expect(written.error.parse).toBe(false);
    expect(parsed.error.message).not.toBe(written.error.message);
  });

  it('reports parse false on every description this module builds', () => {
    const collector = createReportCollector();
    const manager = new LocalStorageManager({
      storage: new InstrumentedStorage({ setItem: createQuotaError() }),
      reporter: collector,
    });

    // An unowned key, refused before the store: a refusal, never a parse.
    expect(manager.readJson(UNOWNED_KEYS[0].key as OwnedStorageKey)).toBeNull();

    // A quota-exhausted write: a failure, never a parse.
    expect(manager.setGameState(createEmptyBoard())).toBe(false);
    expect(collector.failures.length).toBeGreaterThanOrEqual(2);

    for (const failure of collector.failures) {
      expect(failure.error.parse).toBe(false);
    }
  });
});
