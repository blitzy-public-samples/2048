// Storage fixtures and the persistence teardown for the unit suite.
//
// vitest.config.ts names this module in `setupFiles` for both unit projects,
// so the `afterEach` registered in section 5 runs for every unit test file
// without a test opting in. The seeding helpers are exported from the same
// module, so a suite imports what it needs from here.
//
// Provenance of the behaviour this module compensates for, from the deleted
// vanilla sources:
//   js/local_storage_manager.js L25-L26  the writability probe runs once, at
//                                       construction, and fixes the store for
//                                       the session
//   js/game_manager.js L36               setup() reads the snapshot once
//   js/local_storage_manager.js L61-L63  clearGameState() removes the
//                                       snapshot; no member of the vanilla
//                                       manager removes the best score
//   js/local_storage_manager.js L43-L45  getBestScore() yields the stored
//                                       string when a value is set and the
//                                       number 0 when none is
//   js/local_storage_manager.js L57-L59  setGameState() persists
//                                       JSON.stringify(state)
//
// A seeded best score is written and read back as the exact stored string. No
// member of this module converts it to a number.
//
// Only the keys src/storage/storage-keys.ts reports as owned are read, written
// or removed here, which is the boundary
// src/storage/local-storage-manager.ts enforces on the product itself. This
// module holds no state between tests.
//
// Decisions behind this file: DL-FIXTURE-03, the teardown removing the best
// DL-FIXTURE-04, fixtures written to the store before the subject is

import { afterEach } from 'vitest';

import { isOwnedStorageKey } from '../../src/storage/storage-keys';
import type { OwnedStorageKey } from '../../src/storage/storage-keys';
import type { SerializedGameState } from '../../src/engine/types';

/* ===== 1. Web Storage access ===== */

/**
 * The Web Storage surface this module uses: the four `StorageLike` operations
 * `src/storage/memory-storage.ts` declares, plus the two enumeration members
 * the owned-key sweep in section 5 reads.
 */
export interface EnumerableStorage {
  /** Number of keys currently held. */
  readonly length: number;

  /** The key at `index`, or `null` once `index` reaches `length`. */
  key(index: number): string | null;

  getItem(key: string): string | null;

  setItem(key: string, value: string): void;

  removeItem(key: string): void;
}

/**
 * Reports whether `value` offers every `EnumerableStorage` member.
 *
 * @param value Value to test, typically `globalThis.localStorage`.
 * @returns `true` when every member is present with the expected type.
 */
function isEnumerableStorage(value: unknown): value is EnumerableStorage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  return (
    'length' in value &&
    typeof value.length === 'number' &&
    'key' in value &&
    typeof value.key === 'function' &&
    'getItem' in value &&
    typeof value.getItem === 'function' &&
    'setItem' in value &&
    typeof value.setItem === 'function' &&
    'removeItem' in value &&
    typeof value.removeItem === 'function'
  );
}

/**
 * The environment's Web Storage, when it offers one.
 *
 * The `unit:dom-free` project runs in the `node` environment, which exposes no
 * `localStorage`, so this returns `null` there and every member below is
 * written against that outcome.
 *
 * @returns The global store, or `null` when the environment offers none or
 *   reading it threw.
 */
export function getWebStorage(): EnumerableStorage | null {
  let candidate: unknown;

  try {
    candidate = globalThis.localStorage;
  } catch {
    return null;
  }

  return isEnumerableStorage(candidate) ? candidate : null;
}

/**
 * The Web Storage of a DOM environment, or a thrown error in a DOM-free one.
 *
 * @returns The global store.
 * @throws {Error} When the environment offers no Web Storage.
 */
function requireWebStorage(): EnumerableStorage {
  const storage = getWebStorage();

  if (storage === null) {
    throw new Error(
      'This environment offers no Web Storage, so a storage fixture cannot ' +
        'be seeded. Run the suite in the unit:dom project, or add the ' +
        '"@vitest-environment jsdom" docblock to the file.'
    );
  }

  return storage;
}

/* ===== 2. Seed shape ===== */

/**
 * Keys to seed, each mapped to the exact string the product would have
 * persisted under it.
 *
 * Values are the exact strings a store holds. `serializeGameState()` produces
 * the string form of a board snapshot.
 */
export type StorageSeed = Readonly<Partial<Record<OwnedStorageKey, string>>>;

/* ===== 3. Seeding ===== */

/**
 * The string form `setGameState()` persisted a board snapshot as.
 *
 * @param state Snapshot to serialise, as `tests/fixtures/boards.ts` builds
 *   one.
 * @returns `state` as JSON.
 */
export function serializeGameState(state: SerializedGameState): string {
  return JSON.stringify(state);
}

/**
 * Writes every entry of `seed` to Web Storage.
 *
 * @param seed Keys and their exact stored strings. An entry whose value is
 *   `undefined` is skipped, so an optional field may be left unset.
 * @throws {Error} When the environment offers no Web Storage.
 * @throws {TypeError} When a key is not one the product owns, which
 *   `src/storage/storage-keys.ts` decides.
 */
export function seedOwnedStorage(seed: StorageSeed): void {
  const storage = requireWebStorage();

  for (const [key, value] of Object.entries(seed)) {
    if (value === undefined) {
      continue;
    }

    if (!isOwnedStorageKey(key)) {
      throw new TypeError(
        `"${key}" is not a storage key the product owns, so it must not be ` +
          'seeded.'
      );
    }

    storage.setItem(key, value);
  }
}

/**
 * Seeds storage and then runs `construct`, in that order.
 *
 * The vanilla manager probed Web Storage once at construction and its caller
 * read the snapshot once during setup, so a fixture written after the subject
 * exists is not observed by it. Passing the constructor in keeps the two steps
 * in that order.
 *
 * @param seed Keys and their exact stored strings, written first.
 * @param construct Builds the subject under test, run once the seed is in
 *   place. Its return value is passed through unchanged.
 * @returns Whatever `construct` returned.
 * @throws {Error} When the environment offers no Web Storage.
 * @throws {TypeError} When a key is not one the product owns.
 */
export function seedThenConstruct<T>(
  seed: StorageSeed,
  construct: () => T
): T {
  seedOwnedStorage(seed);

  return construct();
}

/* ===== 4. Reading ===== */

/**
 * Reads a stored value back verbatim.
 *
 * The value is returned as stored, with no conversion: a best score seeded as
 * a string reads back as that string.
 *
 * @param key Key to read. Must be one the product owns.
 * @returns The stored string, or `null` when the key is unset or the
 *   environment offers no Web Storage.
 */
export function readOwnedStorage(key: OwnedStorageKey): string | null {
  return getWebStorage()?.getItem(key) ?? null;
}

/* ===== 5. Teardown ===== */

/**
 * Collects the keys currently held that the product owns.
 *
 * The keys are read before any removal so that removing one cannot shift the
 * index of another.
 *
 * @param storage Store to enumerate.
 * @returns Every held key `isOwnedStorageKey()` accepts, in index order.
 */
function collectOwnedKeys(storage: EnumerableStorage): OwnedStorageKey[] {
  const owned: OwnedStorageKey[] = [];

  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);

    if (key !== null && isOwnedStorageKey(key)) {
      owned.push(key);
    }
  }

  return owned;
}

/**
 * Removes every stored key the product owns.
 *
 * That is the two frozen unprefixed literals `bestScore` and `gameState`, the
 * namespaced run-state key, the writability probe's key, and any further
 * namespaced key: membership is decided by `isOwnedStorageKey()`, and this
 * module keeps no list of its own. No other key of the origin is touched.
 *
 * Total in every environment: it returns without doing anything when there is
 * no Web Storage, which is the case in the `unit:dom-free` project.
 *
 * @throws {AggregateError} When one or more removals threw. Every key is
 *   attempted first, so one failure does not leave the rest behind.
 */
export function clearOwnedStorage(): void {
  const storage = getWebStorage();

  if (storage === null) {
    return;
  }

  const failures: Error[] = [];
  const unremoved: string[] = [];

  for (const key of collectOwnedKeys(storage)) {
    try {
      storage.removeItem(key);
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
      unremoved.push(key);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Test teardown could not remove ${String(failures.length)} storage ` +
        `key(s): ${unremoved.join(', ')}.`
    );
  }
}

// Registered once, when this module is evaluated as a setup file. The vanilla
// manager removed the snapshot but never the best score, so a best score
// written by one test would otherwise be read by every test that follows it.
afterEach(clearOwnedStorage);
