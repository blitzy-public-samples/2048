// Contract suite over tests/fixtures/storage.ts, the storage fixtures and the
// persistence teardown vitest.config.ts loads as a setup file for both unit
// projects.
//
// Collected by the unit:dom project in vitest.config.ts, which runs under
// jsdom and supplies Web Storage.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearOwnedStorage,
  getWebStorage,
  readOwnedStorage,
  seedOwnedStorage,
  seedThenConstruct,
  serializeGameState,
} from '../../fixtures/storage';
import type {
  EnumerableStorage,
  StorageSeed,
} from '../../fixtures/storage';
import {
  BEST_SCORE_KEY,
  GAME_STATE_KEY,
  OWNED_STORAGE_KEYS,
  RUN_STATE_KEY,
  STORAGE_PROBE_KEY,
} from '../../../src/storage/storage-keys';
import { createMergePairBoard } from '../../fixtures/boards';

/** Property the subject reads the host store from. */
const HOST_STORAGE_PROPERTY = 'localStorage';

/** Best score seeded by the cases that write one. */
const SEEDED_BEST_SCORE = '13570';

/** Snapshot text seeded under the board-snapshot key. */
const SEEDED_GAME_STATE = '{"seeded":true}';

/** A key belonging to another application on this origin. */
const FOREIGN_KEY = 'analytics:sessionId';

/** Value stored under `FOREIGN_KEY`, which must survive every sweep. */
const FOREIGN_VALUE = 'untouched';

/** A key the product does not own, offered to `seedOwnedStorage`. */
const UNOWNED_SEED_KEY = 'theme';

/** Members of the recording store configured to throw. */
interface StorageFaults {
  /** Keys whose removal throws, each mapped to the value it throws. */
  readonly removeItem?: Readonly<Record<string, unknown>>;

  /** Keys whose write throws, each mapped to the value it throws. */
  readonly setItem?: Readonly<Record<string, unknown>>;
}

/**
 * An enumerable `EnumerableStorage` that records every operation it receives.
 */
class RecordingStorage implements EnumerableStorage {
  /** Every operation received, as `member` or `member:key`, in call order. */
  readonly operations: string[] = [];

  private readonly entries = new Map<string, string>();

  private readonly faults: StorageFaults;

  constructor(faults: StorageFaults = {}) {
    this.faults = faults;
  }

  get length(): number {
    this.operations.push('length');

    return this.entries.size;
  }

  key(index: number): string | null {
    this.operations.push(`key:${String(index)}`);

    return [...this.entries.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    this.operations.push(`getItem:${key}`);

    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.operations.push(`setItem:${key}`);

    const fault = this.faults.setItem?.[key];

    if (fault !== undefined) {
      throw fault;
    }

    this.entries.set(key, String(value));
  }

  removeItem(key: string): void {
    this.operations.push(`removeItem:${key}`);

    const fault = this.faults.removeItem?.[key];

    if (fault !== undefined) {
      throw fault;
    }

    this.entries.delete(key);
  }

  /** The keys currently held, in insertion order, recording nothing. */
  heldKeys(): string[] {
    return [...this.entries.keys()];
  }

  /** Reads a value without recording an operation. */
  peek(key: string): string | undefined {
    return this.entries.get(key);
  }

  /** Writes a value without recording an operation. */
  plant(key: string, value: string): void {
    this.entries.set(key, value);
  }

  /** Drops the recorded operations, keeping the entries. */
  forgetOperations(): void {
    this.operations.length = 0;
  }
}

/**
 * Installs `store` as the host Web Storage for the current test.
 *
 * @param store Store the subject is to read and write.
 * @returns The same store, for chaining.
 */
function installStore(store: RecordingStorage): RecordingStorage {
  vi.stubGlobal(HOST_STORAGE_PROPERTY, store);

  return store;
}

/** Property descriptor saved before a host replacement, and restored after. */
let savedStorageDescriptor: PropertyDescriptor | undefined;

/** Whether a descriptor replacement is outstanding. */
let storageDescriptorReplaced = false;

/**
 * Replaces the host store's property descriptor for the current test.
 *
 * @param descriptor Descriptor to install, always configurable.
 */
function replaceStorageDescriptor(descriptor: PropertyDescriptor): void {
  savedStorageDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    HOST_STORAGE_PROPERTY,
  );
  storageDescriptorReplaced = true;

  Object.defineProperty(globalThis, HOST_STORAGE_PROPERTY, {
    configurable: true,
    ...descriptor,
  });
}

/**
 * Removes the host store for the current test, as a DOM-free host has none.
 */
function removeHostStorage(): void {
  replaceStorageDescriptor({ value: undefined, writable: true });
}

/** Makes reading the host store throw, as a blocked origin does. */
function denyHostStorage(fault: Error): void {
  replaceStorageDescriptor({
    get(): never {
      throw fault;
    },
  });
}

/** Puts the host store back exactly as it was found. */
function restoreHostStorage(): void {
  vi.unstubAllGlobals();

  if (!storageDescriptorReplaced) {
    return;
  }

  storageDescriptorReplaced = false;

  if (savedStorageDescriptor === undefined) {
    Reflect.deleteProperty(globalThis, HOST_STORAGE_PROPERTY);

    return;
  }

  Object.defineProperty(
    globalThis,
    HOST_STORAGE_PROPERTY,
    savedStorageDescriptor,
  );
  savedStorageDescriptor = undefined;
}

afterEach(restoreHostStorage);

/**
 * Filters recorded operations down to one member.
 *
 * @param store Store to read the record from.
 * @param member Member name to keep.
 * @returns The matching operations, in call order.
 */
function operationsOn(store: RecordingStorage, member: string): string[] {
  return store.operations.filter((operation) =>
    operation.startsWith(`${member}:`),
  );
}

/**
 * The recorded operations that address an entry, in call order.
 *
 * @param store Store to read the record from.
 * @returns Every `getItem`, `setItem` and `removeItem` call, in call order.
 */
function entryOperations(store: RecordingStorage): string[] {
  return store.operations.filter(
    (operation) =>
      operation.startsWith('getItem:') ||
      operation.startsWith('setItem:') ||
      operation.startsWith('removeItem:'),
  );
}

describe('getWebStorage', () => {
  it('returns the host store when the environment offers one', () => {
    const store = installStore(new RecordingStorage());

    expect(getWebStorage()).toBe(store);
  });

  it('returns the jsdom store this project supplies by default', () => {
    const ambient = getWebStorage();

    expect(ambient).not.toBeNull();
    expect(typeof ambient?.setItem).toBe('function');
    expect(typeof ambient?.key).toBe('function');
    expect(typeof ambient?.length).toBe('number');
  });

  it('returns null when the environment offers no store', () => {
    removeHostStorage();

    expect(getWebStorage()).toBeNull();
  });

  it('returns null when reading the store throws', () => {
    denyHostStorage(new Error('Access to storage is denied.'));

    expect(getWebStorage()).toBeNull();
  });

  it('returns null for a store missing an enumeration member', () => {
    const incomplete = {
      getItem: (): string | null => null,
      setItem: (): void => undefined,
      removeItem: (): void => undefined,
      length: 0,
    };

    vi.stubGlobal(HOST_STORAGE_PROPERTY, incomplete);

    expect(getWebStorage()).toBeNull();
  });

  it('returns null for a value that is not an object', () => {
    vi.stubGlobal(HOST_STORAGE_PROPERTY, 'not a store');

    expect(getWebStorage()).toBeNull();
  });
});

describe('serializeGameState', () => {
  it('produces exactly the text setGameState() persisted', () => {
    const board = createMergePairBoard();

    expect(serializeGameState(board)).toBe(JSON.stringify(board));
  });

  it('round-trips a board snapshot through JSON unchanged', () => {
    const board = createMergePairBoard();
    const restored: unknown = JSON.parse(serializeGameState(board));

    expect(restored).toStrictEqual(board);
  });
});

describe('seedOwnedStorage', () => {
  it('writes every entry verbatim under the key it names', () => {
    const store = installStore(new RecordingStorage());

    seedOwnedStorage({
      [BEST_SCORE_KEY]: SEEDED_BEST_SCORE,
      [GAME_STATE_KEY]: SEEDED_GAME_STATE,
    });

    expect(store.peek(BEST_SCORE_KEY)).toBe(SEEDED_BEST_SCORE);
    expect(store.peek(GAME_STATE_KEY)).toBe(SEEDED_GAME_STATE);
    expect(operationsOn(store, 'setItem')).toStrictEqual([
      `setItem:${BEST_SCORE_KEY}`,
      `setItem:${GAME_STATE_KEY}`,
    ]);
  });

  it('seeds a namespaced key as readily as a frozen literal', () => {
    const store = installStore(new RecordingStorage());

    seedOwnedStorage({ [RUN_STATE_KEY]: '{"schemaVersion":1}' });

    expect(store.peek(RUN_STATE_KEY)).toBe('{"schemaVersion":1}');
  });

  it('skips an entry whose value is undefined', () => {
    const store = installStore(new RecordingStorage());
    const seed = {
      [BEST_SCORE_KEY]: SEEDED_BEST_SCORE,
      [GAME_STATE_KEY]: undefined,
    } as StorageSeed;

    seedOwnedStorage(seed);

    expect(store.heldKeys()).toStrictEqual([BEST_SCORE_KEY]);
    expect(operationsOn(store, 'setItem')).toStrictEqual([
      `setItem:${BEST_SCORE_KEY}`,
    ]);
  });

  it('writes nothing for an empty seed', () => {
    const store = installStore(new RecordingStorage());

    seedOwnedStorage({});

    expect(store.heldKeys()).toStrictEqual([]);
    expect(entryOperations(store)).toStrictEqual([]);
  });

  it('throws TypeError for a key the product does not own', () => {
    const store = installStore(new RecordingStorage());
    const seed = { [UNOWNED_SEED_KEY]: 'dark' } as unknown as StorageSeed;

    expect(() => seedOwnedStorage(seed)).toThrow(TypeError);
    expect(store.heldKeys()).toStrictEqual([]);
  });

  it('names the refused key in the error it throws', () => {
    installStore(new RecordingStorage());

    const seed = { [UNOWNED_SEED_KEY]: 'dark' } as unknown as StorageSeed;

    expect(() => seedOwnedStorage(seed)).toThrow(
      `"${UNOWNED_SEED_KEY}" is not a storage key the product owns`,
    );
  });

  it('throws when the environment offers no Web Storage', () => {
    removeHostStorage();

    expect(() =>
      seedOwnedStorage({ [BEST_SCORE_KEY]: SEEDED_BEST_SCORE }),
    ).toThrow(/offers no Web Storage/);
  });

  it('leaves a foreign key untouched', () => {
    const store = installStore(new RecordingStorage());

    store.plant(FOREIGN_KEY, FOREIGN_VALUE);
    seedOwnedStorage({ [BEST_SCORE_KEY]: SEEDED_BEST_SCORE });

    expect(store.peek(FOREIGN_KEY)).toBe(FOREIGN_VALUE);
  });
});

describe('seedThenConstruct', () => {
  it('seeds before the subject is constructed', () => {
    const store = installStore(new RecordingStorage());
    const observed = seedThenConstruct(
      { [BEST_SCORE_KEY]: SEEDED_BEST_SCORE },
      () => store.getItem(BEST_SCORE_KEY),
    );

    expect(observed).toBe(SEEDED_BEST_SCORE);
    expect(entryOperations(store)).toStrictEqual([
      `setItem:${BEST_SCORE_KEY}`,
      `getItem:${BEST_SCORE_KEY}`,
    ]);
  });

  it('passes the constructed subject back unchanged', () => {
    installStore(new RecordingStorage());

    const subject = { id: 'manager' };
    const returned = seedThenConstruct({}, () => subject);

    expect(returned).toBe(subject);
  });

  it('runs the constructor exactly once', () => {
    installStore(new RecordingStorage());

    const construct = vi.fn((): number => 1);

    seedThenConstruct({ [GAME_STATE_KEY]: SEEDED_GAME_STATE }, construct);

    expect(construct).toHaveBeenCalledTimes(1);
  });

  it('does not construct when the seed is refused', () => {
    installStore(new RecordingStorage());

    const construct = vi.fn((): number => 1);
    const seed = { [UNOWNED_SEED_KEY]: 'dark' } as unknown as StorageSeed;

    expect(() => seedThenConstruct(seed, construct)).toThrow(TypeError);
    expect(construct).not.toHaveBeenCalled();
  });

  it('does not construct when the environment offers no store', () => {
    removeHostStorage();

    const construct = vi.fn((): number => 1);

    expect(() =>
      seedThenConstruct({ [BEST_SCORE_KEY]: SEEDED_BEST_SCORE }, construct),
    ).toThrow(/offers no Web Storage/);
    expect(construct).not.toHaveBeenCalled();
  });
});

describe('readOwnedStorage', () => {
  it('reads a seeded value back as the exact stored string', () => {
    installStore(new RecordingStorage());
    seedOwnedStorage({ [BEST_SCORE_KEY]: SEEDED_BEST_SCORE });

    const read = readOwnedStorage(BEST_SCORE_KEY);

    expect(read).toBe(SEEDED_BEST_SCORE);
    expect(typeof read).toBe('string');
  });

  it('converts nothing: a numeric best score stays a string', () => {
    installStore(new RecordingStorage());
    seedOwnedStorage({ [BEST_SCORE_KEY]: '0' });

    expect(readOwnedStorage(BEST_SCORE_KEY)).toBe('0');
    expect(readOwnedStorage(BEST_SCORE_KEY)).not.toBe(0);
  });

  it('returns null for a key that was never written', () => {
    installStore(new RecordingStorage());

    expect(readOwnedStorage(BEST_SCORE_KEY)).toBeNull();
  });

  it('returns null when the environment offers no store', () => {
    removeHostStorage();

    expect(readOwnedStorage(BEST_SCORE_KEY)).toBeNull();
  });

  it('returns null when reading the store throws', () => {
    denyHostStorage(new Error('Access to storage is denied.'));

    expect(readOwnedStorage(GAME_STATE_KEY)).toBeNull();
  });
});

describe('clearOwnedStorage', () => {
  it('removes every durable owned key, the best score included', () => {
    const store = installStore(new RecordingStorage());

    for (const key of OWNED_STORAGE_KEYS) {
      store.plant(key, 'seeded');
    }

    clearOwnedStorage();

    for (const key of OWNED_STORAGE_KEYS) {
      expect(store.peek(key)).toBeUndefined();
    }

    expect(store.heldKeys()).toStrictEqual([]);
  });

  it('removes the best score, which no vanilla member ever removed', () => {
    const store = installStore(new RecordingStorage());

    store.plant(BEST_SCORE_KEY, SEEDED_BEST_SCORE);
    clearOwnedStorage();

    expect(store.peek(BEST_SCORE_KEY)).toBeUndefined();
    expect(operationsOn(store, 'removeItem')).toStrictEqual([
      `removeItem:${BEST_SCORE_KEY}`,
    ]);
  });

  it('removes the probe key and any further namespaced key', () => {
    const store = installStore(new RecordingStorage());

    store.plant(STORAGE_PROBE_KEY, 'seeded');
    store.plant('roguelike2048:scratch', 'seeded');

    clearOwnedStorage();

    expect(store.heldKeys()).toStrictEqual([]);
  });

  it('preserves every key the product does not own', () => {
    const store = installStore(new RecordingStorage());

    store.plant(FOREIGN_KEY, FOREIGN_VALUE);
    store.plant('roguelike2048', 'not a key');
    store.plant('roguelike2048:', 'no name');
    store.plant(BEST_SCORE_KEY, SEEDED_BEST_SCORE);

    clearOwnedStorage();

    expect(store.peek(FOREIGN_KEY)).toBe(FOREIGN_VALUE);
    expect(store.peek('roguelike2048')).toBe('not a key');
    expect(store.peek('roguelike2048:')).toBe('no name');
    expect(store.peek(BEST_SCORE_KEY)).toBeUndefined();
    expect(operationsOn(store, 'removeItem')).toStrictEqual([
      `removeItem:${BEST_SCORE_KEY}`,
    ]);
  });

  it('collects every key before removing one, so no index shifts past', () => {
    const store = installStore(new RecordingStorage());

    store.plant(BEST_SCORE_KEY, 'a');
    store.plant(GAME_STATE_KEY, 'b');
    store.plant(RUN_STATE_KEY, 'c');
    store.plant(FOREIGN_KEY, FOREIGN_VALUE);

    clearOwnedStorage();

    const firstRemoval = store.operations.indexOf(
      `removeItem:${BEST_SCORE_KEY}`,
    );
    const enumerationBeforeRemoval = store.operations
      .slice(0, firstRemoval)
      .filter((operation) => operation.startsWith('key:'));

    expect(enumerationBeforeRemoval).toStrictEqual([
      'key:0',
      'key:1',
      'key:2',
      'key:3',
    ]);
    expect(operationsOn(store, 'removeItem')).toStrictEqual([
      `removeItem:${BEST_SCORE_KEY}`,
      `removeItem:${GAME_STATE_KEY}`,
      `removeItem:${RUN_STATE_KEY}`,
    ]);
    expect(store.heldKeys()).toStrictEqual([FOREIGN_KEY]);
  });

  it('is idempotent over an already emptied store', () => {
    const store = installStore(new RecordingStorage());

    store.plant(BEST_SCORE_KEY, SEEDED_BEST_SCORE);

    clearOwnedStorage();
    store.forgetOperations();

    expect(() => {
      clearOwnedStorage();
    }).not.toThrow();
    expect(operationsOn(store, 'removeItem')).toStrictEqual([]);
  });

  it('returns without doing anything when there is no store', () => {
    removeHostStorage();

    expect(() => {
      clearOwnedStorage();
    }).not.toThrow();
  });

  it('returns without doing anything when reading the store throws', () => {
    denyHostStorage(new Error('Access to storage is denied.'));

    expect(() => {
      clearOwnedStorage();
    }).not.toThrow();
  });

  it('attempts every key before reporting the removals that failed', () => {
    const refusal = new Error('Removal is blocked.');
    const store = installStore(
      new RecordingStorage({
        removeItem: {
          [BEST_SCORE_KEY]: refusal,
          [RUN_STATE_KEY]: refusal,
        },
      }),
    );

    store.plant(BEST_SCORE_KEY, 'a');
    store.plant(GAME_STATE_KEY, 'b');
    store.plant(RUN_STATE_KEY, 'c');

    let thrown: unknown;

    try {
      clearOwnedStorage();
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect(operationsOn(store, 'removeItem')).toStrictEqual([
      `removeItem:${BEST_SCORE_KEY}`,
      `removeItem:${GAME_STATE_KEY}`,
      `removeItem:${RUN_STATE_KEY}`,
    ]);
    expect(store.peek(GAME_STATE_KEY)).toBeUndefined();

    const aggregate = thrown as AggregateError;

    expect(aggregate.errors).toStrictEqual([refusal, refusal]);
    expect(aggregate.message).toBe(
      `Test teardown could not remove 2 storage key(s): ${BEST_SCORE_KEY}, ` +
        `${RUN_STATE_KEY}.`,
    );
  });

  it('wraps a thrown value that is not an Error', () => {
    const store = installStore(
      new RecordingStorage({
        removeItem: { [BEST_SCORE_KEY]: 'refused as a string' },
      }),
    );

    store.plant(BEST_SCORE_KEY, 'a');

    let thrown: unknown;

    try {
      clearOwnedStorage();
    } catch (error: unknown) {
      thrown = error;
    }

    const aggregate = thrown as AggregateError;

    expect(aggregate).toBeInstanceOf(AggregateError);
    expect(aggregate.errors).toHaveLength(1);
    expect(aggregate.errors[0]).toBeInstanceOf(Error);
    expect((aggregate.errors[0] as Error).message).toBe(
      'refused as a string',
    );
    expect(aggregate.message).toBe(
      `Test teardown could not remove 1 storage key(s): ${BEST_SCORE_KEY}.`,
    );
  });
});

describe('the registered persistence teardown', () => {
  it('leaves the host store free of every owned key it seeded', () => {
    seedOwnedStorage({
      [BEST_SCORE_KEY]: SEEDED_BEST_SCORE,
      [GAME_STATE_KEY]: SEEDED_GAME_STATE,
      [RUN_STATE_KEY]: '{"schemaVersion":1}',
    });

    expect(readOwnedStorage(BEST_SCORE_KEY)).toBe(SEEDED_BEST_SCORE);

    // The assertion that this is gone again is the afterAll below: the
    // `afterEach` this module registers when vitest.config.ts loads it as a
    // setup file runs between the two, and nothing in this file removes it.
    getWebStorage()?.setItem(FOREIGN_KEY, FOREIGN_VALUE);
  });

  afterAll(() => {
    const ambient = getWebStorage();

    expect(ambient).not.toBeNull();

    for (const key of OWNED_STORAGE_KEYS) {
      expect(ambient?.getItem(key)).toBeNull();
    }

    expect(ambient?.getItem(FOREIGN_KEY)).toBe(FOREIGN_VALUE);

    ambient?.removeItem(FOREIGN_KEY);
  });
});
