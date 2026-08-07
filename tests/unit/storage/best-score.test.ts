// The frozen best-score contract, pinned assertion by assertion. This suite is
// the measurement of validation gate V3.
//
// Provenance of every behaviour asserted below, from the deleted vanilla
// sources:
//   js/local_storage_manager.js L22      this.bestScoreKey, the frozen
//                                       unprefixed key literal
//   js/local_storage_manager.js L25-L26  the writability probe runs once, at
//                                       construction, and fixes the store for
//                                       the session
//   js/local_storage_manager.js L43-L45  getBestScore() returns
//                                       `getItem(bestScoreKey) || 0`
//   js/local_storage_manager.js L47-L49  setBestScore() returns nothing and
//                                       writes `setItem(bestScoreKey, score)`
//   js/local_storage_manager.js L5       the store coerces with String(val)
//   js/local_storage_manager.js L8-L10   an absent key reads back as undefined
//   js/local_storage_manager.js L57-L59  setGameState() persists
//                                       JSON.stringify(state)
//   js/local_storage_manager.js L61-L63  clearGameState() removes the snapshot
//                                       key alone; no member of the vanilla
//                                       manager removes the best score
//   js/game_manager.js L80-L82           the promotion guard, a relational
//                                       comparison against the stored value
//   js/game_manager.js L95               the best score is re-read from storage
//                                       after the possible write
//   js/html_actuator.js L123-L125        the value reached the DOM through
//                                       textContent
//
// The subject is src/storage/local-storage-manager.ts. Every construction here
// injects a store. The key literals are imported from
// src/storage/storage-keys.ts and appear nowhere in this file;
// tests/unit/storage/storage-keys.test.ts pins the literals themselves.
//
// The Web Storage probe, the `probe` and `strategy` members and the reporter
// failure path are covered by
// tests/unit/storage/local-storage-manager.test.ts, not here.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LocalStorageManager,
} from '../../../src/storage/local-storage-manager';
import { MemoryStorage } from '../../../src/storage/memory-storage';
import type { StorageLike } from '../../../src/storage/memory-storage';
import {
  BEST_SCORE_KEY,
  GAME_STATE_KEY,
  OWNED_STORAGE_KEYS,
  RUN_STATE_KEY,
  STORAGE_PROBE_KEY,
} from '../../../src/storage/storage-keys';
import { createMergePairBoard } from '../../fixtures/boards';

/* ===== 1. Stores ===== */

/**
 * Injected doubles built during the test in progress, so teardown can empty
 * the store a test actually used as well as the ambient one.
 */
const trackedStores: StorageLike[] = [];

/**
 * Builds a fresh injected double and registers it for teardown.
 *
 * @returns An empty store, shared with no other test.
 */
function createStore(): MemoryStorage {
  const store = new MemoryStorage();

  trackedStores.push(store);

  return store;
}

/**
 * Reports whether `value` offers the four `StorageLike` operations.
 *
 * @param value Value to test, here always `globalThis.localStorage`.
 * @returns `true` when every operation is present as a function.
 */
function isStorageLike(value: unknown): value is StorageLike {
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
 * The environment's Web Storage, when it offers one. The `unit:dom` project
 * runs under jsdom and supplies it; a DOM-free environment does not, and every
 * caller below is written against that outcome.
 *
 * @returns The global store, or `null` when the environment offers none or
 *   reading it threw.
 */
function ambientStore(): StorageLike | null {
  let candidate: unknown;

  try {
    candidate = globalThis.localStorage;
  } catch {
    return null;
  }

  return isStorageLike(candidate) ? candidate : null;
}

/**
 * The environment's Web Storage, or a thrown error where there is none, for the
 * tests that exercise the ambient store deliberately. Teardown sweeps that
 * store unconditionally, so no registration is needed here.
 *
 * @returns The global store.
 * @throws {Error} When the environment offers no Web Storage.
 */
function requireAmbientStore(): StorageLike {
  const ambient = ambientStore();

  if (ambient === null) {
    throw new Error(
      'This suite needs Web Storage. It is collected by the unit:dom ' +
        'project, which runs under jsdom.',
    );
  }

  return ambient;
}

/* ===== 2. Teardown ===== */

/**
 * Removes every key the product owns from `store`.
 *
 * Idempotent: `OWNED_STORAGE_KEYS` is walked whether or not a key is present,
 * and removing an absent key is a no-op in both `MemoryStorage` and the DOM
 * `Storage` contract. The probe key is swept separately —
 * `OWNED_STORAGE_KEYS` omits it.
 *
 * @param store Store to empty of owned keys.
 */
function clearOwnedKeys(store: StorageLike): void {
  for (const key of OWNED_STORAGE_KEYS) {
    store.removeItem(key);
  }

  store.removeItem(STORAGE_PROBE_KEY);
}

/**
 * Empties every store this file may have written: each injected double built
 * for the test in progress, then the ambient store. Runs before and after every
 * test, and is safe to run any number of times.
 */
function purgeOwnedKeys(): void {
  for (const store of trackedStores) {
    clearOwnedKeys(store);
  }

  trackedStores.length = 0;

  const ambient = ambientStore();

  if (ambient !== null) {
    clearOwnedKeys(ambient);
  }
}

beforeEach(purgeOwnedKeys);
afterEach(purgeOwnedKeys);

/* ===== 3. The vanilla promotion guard ===== */

/**
 * The relational comparison of js/game_manager.js L80, applied to the ported
 * accessor's `string | 0` return type. The narrowing assertion is confined to
 * this one line; every assertion site below reads the union as declared.
 *
 * @param stored Value `getBestScore()` returned.
 * @param score Live score to compare it against.
 * @returns `true` when the stored value is below `score`.
 */
function isStoredBelow(stored: string | 0, score: number): boolean {
  return (stored as number) < score;
}

/**
 * The guarded promotion of js/game_manager.js L80-L82, verbatim: compare, and
 * write only when the stored value is lower.
 *
 * @param manager Manager to promote through.
 * @param score Live score to promote to.
 * @returns `true` when the comparison passed and the write was attempted.
 */
function promoteBestScore(
  manager: LocalStorageManager,
  score: number,
): boolean {
  if (isStoredBelow(manager.getBestScore(), score)) {
    manager.setBestScore(score);

    return true;
  }

  return false;
}

/* ===== 4. A value the vanilla game left behind ===== */

describe("pre-existing vanilla value is honoured (the requirement's " +
  'actual purpose)', () => {
  it(
    'getBestScore() reads a value seeded before construction — ' +
      'js/local_storage_manager.js L25-L26 fixes the store once, L43-L45 ' +
      'reads it',
    () => {
      const storage = createStore();

      storage.setItem(BEST_SCORE_KEY, '1234');

      const manager = new LocalStorageManager({ storage });

      expect(manager.getBestScore()).toBe('1234');
    },
  );

  it(
    'getBestScore() reads a large seeded value with no parsing or ' +
      'truncation — js/local_storage_manager.js L44',
    () => {
      const storage = createStore();

      storage.setItem(BEST_SCORE_KEY, '999999');

      const manager = new LocalStorageManager({ storage });

      expect(manager.getBestScore()).toBe('999999');
    },
  );

  it(
    'getBestScore() leaves the seeded value in the store unrewritten and ' +
      'unnormalised — js/local_storage_manager.js L43-L45 reads only',
    () => {
      const storage = createStore();

      storage.setItem(BEST_SCORE_KEY, '1234');

      const manager = new LocalStorageManager({ storage });

      expect(manager.getBestScore()).toBe('1234');
      expect(storage.getItem(BEST_SCORE_KEY)).toBe('1234');
    },
  );
});

/* ===== 5. What the accessor returns ===== */

describe('getBestScore() return type (js/local_storage_manager.js ' +
  'L43-L45)', () => {
  it(
    'returns the raw stored string, not a number, when a value is set — ' +
      'js/local_storage_manager.js L44',
    () => {
      const storage = createStore();

      storage.setItem(BEST_SCORE_KEY, '1234');

      const manager = new LocalStorageManager({ storage });
      const result = manager.getBestScore();

      expect(typeof result).toBe('string');
      expect(result).toBe('1234');
      expect(result).not.toBe(1234);
    },
  );

  it(
    'returns the number 0, not the string "0", when no value is set — ' +
      'js/local_storage_manager.js L44 `|| 0`',
    () => {
      const storage = createStore();
      const manager = new LocalStorageManager({ storage });
      const result = manager.getBestScore();

      expect(typeof result).toBe('number');
      expect(result).toBe(0);
      expect(result).not.toBe('0');
    },
  );

  it(
    'returns a stored "0" as the string "0", a truthy string the `|| 0` ' +
      'does not reach — js/local_storage_manager.js L44',
    () => {
      const storage = createStore();

      storage.setItem(BEST_SCORE_KEY, '0');

      const manager = new LocalStorageManager({ storage });
      const result = manager.getBestScore();

      expect(typeof result).toBe('string');
      expect(result).toBe('0');
      expect(result).not.toBe(0);
    },
  );

  it(
    'collapses a stored empty string, which is falsy, to the number 0 — ' +
      'js/local_storage_manager.js L44 `|| 0`',
    () => {
      const storage = createStore();

      storage.setItem(BEST_SCORE_KEY, '');

      const manager = new LocalStorageManager({ storage });
      const result = manager.getBestScore();

      expect(typeof result).toBe('number');
      expect(result).toBe(0);
      expect(result).not.toBe('');
    },
  );

  it(
    'collapses the undefined an in-memory store yields for an absent key ' +
      'to the number 0 — js/local_storage_manager.js L8-L10, L44',
    () => {
      const storage = createStore();

      expect(storage.getItem(BEST_SCORE_KEY)).toBeUndefined();

      const manager = new LocalStorageManager({ storage });
      const result = manager.getBestScore();

      expect(typeof result).toBe('number');
      expect(result).toBe(0);
    },
  );

  it(
    'collapses the null a DOM Storage yields for an absent key to the ' +
      'number 0 — js/local_storage_manager.js L44 `|| 0`',
    () => {
      const nullReadingStore: StorageLike = {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined,
        clear: () => undefined,
      };
      const manager = new LocalStorageManager({
        storage: nullReadingStore,
      });
      const result = manager.getBestScore();

      expect(nullReadingStore.getItem(BEST_SCORE_KEY)).toBeNull();
      expect(typeof result).toBe('number');
      expect(result).toBe(0);
    },
  );
});

/* ===== 6. What the setter writes ===== */

describe('setBestScore() write behaviour (js/local_storage_manager.js ' +
  'L47-L49)', () => {
  it(
    'stores the number 1500 as the string "1500", the store coercing it — ' +
      'js/local_storage_manager.js L48 through L5',
    () => {
      const storage = createStore();
      const manager = new LocalStorageManager({ storage });

      manager.setBestScore(1500);

      const stored = storage.getItem(BEST_SCORE_KEY);
      const result = manager.getBestScore();

      expect(stored).toBe('1500');
      expect(typeof result).toBe('string');
      expect(result).toBe('1500');
    },
  );

  it(
    'returns true on a successful write, where ' +
      'js/local_storage_manager.js L47-L49 returned nothing',
    () => {
      const storage = createStore();
      const manager = new LocalStorageManager({ storage });

      expect(manager.setBestScore(1500)).toBe(true);
    },
  );

  it(
    'writes under BEST_SCORE_KEY alone, the other owned keys staying ' +
      'absent — js/local_storage_manager.js L22-L23, L48',
    () => {
      const storage = createStore();
      const manager = new LocalStorageManager({ storage });

      manager.setBestScore(1500);

      expect(storage.getItem(BEST_SCORE_KEY)).toBe('1500');
      expect(storage.getItem(GAME_STATE_KEY)).toBeUndefined();
      expect(storage.getItem(RUN_STATE_KEY)).toBeUndefined();
      expect(storage.getItem(STORAGE_PROBE_KEY)).toBeUndefined();
    },
  );
});

/* ===== 7. The promotion guard ===== */

describe('relational promotion parity with js/game_manager.js ' +
  'L80-L82', () => {
  it(
    'compares a stored "900" as below the score 1000, the string coerced ' +
      'by the operator — js/game_manager.js L80',
    () => {
      const storage = createStore();

      storage.setItem(BEST_SCORE_KEY, '900');

      const manager = new LocalStorageManager({ storage });

      expect(isStoredBelow(manager.getBestScore(), 1000)).toBe(true);
    },
  );

  it(
    'compares a stored "2000" as not below the score 1000, so no ' +
      'promotion follows — js/game_manager.js L80',
    () => {
      const storage = createStore();

      storage.setItem(BEST_SCORE_KEY, '2000');

      const manager = new LocalStorageManager({ storage });

      expect(isStoredBelow(manager.getBestScore(), 1000)).toBe(false);
    },
  );

  it(
    'compares the number 0 of an unset best score as below a first score ' +
      'of 1 — js/game_manager.js L80 over js/local_storage_manager.js L44',
    () => {
      const storage = createStore();
      const manager = new LocalStorageManager({ storage });

      expect(manager.getBestScore()).toBe(0);
      expect(isStoredBelow(manager.getBestScore(), 1)).toBe(true);
    },
  );

  it(
    'drives the promote-then-read cycle over a seeded "900", storing ' +
      '"1000" — js/game_manager.js L80-L82',
    () => {
      const storage = createStore();

      storage.setItem(BEST_SCORE_KEY, '900');

      const manager = new LocalStorageManager({ storage });

      expect(promoteBestScore(manager, 1000)).toBe(true);
      expect(storage.getItem(BEST_SCORE_KEY)).toBe('1000');
      expect(manager.getBestScore()).toBe('1000');
    },
  );

  it(
    'promotes upward only, leaving a seeded "2000" untouched for a score ' +
      'of 1000 — js/game_manager.js L80-L82, the asymmetry that makes ' +
      'teardown of the best score mandatory',
    () => {
      const storage = createStore();

      storage.setItem(BEST_SCORE_KEY, '2000');

      const manager = new LocalStorageManager({ storage });

      expect(promoteBestScore(manager, 1000)).toBe(false);
      expect(storage.getItem(BEST_SCORE_KEY)).toBe('2000');
      expect(manager.getBestScore()).toBe('2000');
    },
  );
});

/* ===== 8. Read-after-write ===== */

describe('read-after-write, never cached (js/game_manager.js L95)', () => {
  it(
    'getBestScore() returns "1500" on a fresh call after ' +
      'setBestScore(1500) — js/game_manager.js L95',
    () => {
      const storage = createStore();
      const manager = new LocalStorageManager({ storage });

      manager.setBestScore(1500);

      const result = manager.getBestScore();

      expect(typeof result).toBe('string');
      expect(result).toBe('1500');
    },
  );

  it(
    'getBestScore() observes the store mutated behind the manager, so no ' +
      'value is memoised — js/game_manager.js L95',
    () => {
      const storage = createStore();
      const manager = new LocalStorageManager({ storage });

      manager.setBestScore(1500);

      expect(manager.getBestScore()).toBe('1500');

      storage.setItem(BEST_SCORE_KEY, '4242');

      expect(manager.getBestScore()).toBe('4242');
    },
  );

  it(
    'a second manager over the same store observes the write made through ' +
      'the first — js/game_manager.js L95',
    () => {
      const storage = createStore();
      const writer = new LocalStorageManager({ storage });

      writer.setBestScore(1500);

      const reader = new LocalStorageManager({ storage });

      expect(reader.getBestScore()).toBe('1500');
    },
  );
});

/* ===== 9. Key isolation ===== */

describe('best-score key isolation (js/local_storage_manager.js ' +
  'L22-L23)', () => {
  it(
    'setBestScore() neither creates, modifies nor removes ' +
      'GAME_STATE_KEY, RUN_STATE_KEY or STORAGE_PROBE_KEY — ' +
      'js/local_storage_manager.js L48',
    () => {
      const storage = createStore();
      const manager = new LocalStorageManager({ storage });

      manager.setGameState(createMergePairBoard());

      const snapshotBefore = storage.getItem(GAME_STATE_KEY);

      manager.setBestScore(1500);

      expect(storage.getItem(GAME_STATE_KEY)).toBe(snapshotBefore);
      expect(storage.getItem(RUN_STATE_KEY)).toBeUndefined();
      expect(storage.getItem(STORAGE_PROBE_KEY)).toBeUndefined();
    },
  );

  it(
    'setGameState() with a board fixture leaves the best score ' +
      'byte-identical — js/local_storage_manager.js L57-L59',
    () => {
      const storage = createStore();

      storage.setItem(BEST_SCORE_KEY, '1234');

      const manager = new LocalStorageManager({ storage });

      expect(manager.setGameState(createMergePairBoard())).toBe(true);
      expect(storage.getItem(BEST_SCORE_KEY)).toBe('1234');
      expect(manager.getBestScore()).toBe('1234');
    },
  );

  it(
    'clearGameState() removes the snapshot and not the best score, the ' +
      'behaviour of js/local_storage_manager.js L61-L63 preserved and the ' +
      'reason teardown must delete the best score explicitly',
    () => {
      const storage = createStore();

      storage.setItem(BEST_SCORE_KEY, '1234');

      const manager = new LocalStorageManager({ storage });

      manager.setGameState(createMergePairBoard());

      expect(manager.clearGameState()).toBe(true);
      expect(storage.getItem(GAME_STATE_KEY)).toBeUndefined();
      expect(storage.getItem(BEST_SCORE_KEY)).toBe('1234');
      expect(manager.getBestScore()).toBe('1234');
    },
  );
});

/* ===== 10. Teardown hygiene ===== */

describe('teardown hygiene (js/local_storage_manager.js calls removeItem ' +
  'at L35 and L62 only, never for the best score)', () => {
  it(
    'writes a best score to the ambient store, which the next test looks ' +
      'for — js/local_storage_manager.js L48',
    () => {
      const storage = requireAmbientStore();
      const manager = new LocalStorageManager({ storage });

      expect(manager.setBestScore(9876)).toBe(true);
      expect(storage.getItem(BEST_SCORE_KEY)).toBe('9876');
      expect(manager.getBestScore()).toBe('9876');
    },
  );

  it(
    'finds no best score in the ambient store, the preceding write having ' +
      'been torn down by the OWNED_STORAGE_KEYS sweep that ' +
      'js/local_storage_manager.js L35 and L62 never performed',
    () => {
      const storage = requireAmbientStore();
      const manager = new LocalStorageManager({ storage });
      const result = manager.getBestScore();

      expect(storage.getItem(BEST_SCORE_KEY)).not.toBe('9876');
      expect(typeof result).toBe('number');
      expect(result).toBe(0);
    },
  );

  it(
    'clears every owned key from a store, and does so idempotently when ' +
      'run again over the emptied store — the OWNED_STORAGE_KEYS sweep ' +
      'standing in for js/local_storage_manager.js L61-L63',
    () => {
      const storage = createStore();

      for (const key of OWNED_STORAGE_KEYS) {
        storage.setItem(key, 'seeded');
      }

      storage.setItem(STORAGE_PROBE_KEY, 'seeded');

      clearOwnedKeys(storage);
      clearOwnedKeys(storage);

      for (const key of OWNED_STORAGE_KEYS) {
        expect(storage.getItem(key)).toBeUndefined();
      }

      expect(storage.getItem(STORAGE_PROBE_KEY)).toBeUndefined();
    },
  );
});
