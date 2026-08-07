// The frozen best-score contract, pinned assertion by assertion.
//
// Provenance of every behaviour asserted below, from the deleted vanilla
// sources: the frozen unprefixed best-score key literal; the writability probe
// running once at construction and fixing the store for the session;
// `getBestScore()` returning `getItem(bestScoreKey) || 0`; `setBestScore()`
// returning nothing and writing `setItem(bestScoreKey, score)`; the store
// coercing with `String(val)`; an absent key reading back as `undefined`;
// `setGameState()` persisting `JSON.stringify(state)`; `clearGameState()`
// removing the snapshot key alone, no vanilla member removing the best score;
// the promotion guard being a RELATIONAL comparison against the stored value;
// the best score being re-read from storage after the possible write; and the
// value reaching the DOM through `textContent`.
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
// Decisions this suite is the evidence for: DL-STORE-02 in
// docs/DECISION_LOG.md. Traceability rows: TR-STORE-01 and TR-STORE-04
// through TR-STORE-05 of docs/TRACEABILITY_MATRIX.md.

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
import {
  clearOwnedStorage,
  readOwnedStorage,
} from '../../fixtures/storage';

const trackedStores: StorageLike[] = [];

function createStore(): MemoryStorage {
  const store = new MemoryStorage();

  trackedStores.push(store);

  return store;
}

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

function ambientStore(): StorageLike | null {
  let candidate: unknown;

  try {
    candidate = globalThis.localStorage;
  } catch {
    return null;
  }

  return isStorageLike(candidate) ? candidate : null;
}

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

function clearOwnedKeys(store: StorageLike): void {
  for (const key of OWNED_STORAGE_KEYS) {
    store.removeItem(key);
  }

  store.removeItem(STORAGE_PROBE_KEY);
}

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

function isStoredBelow(stored: string | 0, score: number): boolean {
  return (stored as number) < score;
}

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

describe('teardown hygiene (js/local_storage_manager.js calls removeItem ' +
  'at L35 and L62 only, never for the best score)', () => {
  it(
    'writes a best score to the ambient store and removes it again through ' +
      'the shared teardown helper, which no member of ' +
      'js/local_storage_manager.js ever did — L48 wrote it, and L35 and L62 ' +
      'removed only the snapshot',
    () => {
      const storage = requireAmbientStore();
      const manager = new LocalStorageManager({ storage });

      expect(manager.setBestScore(9876)).toBe(true);
      expect(storage.getItem(BEST_SCORE_KEY)).toBe('9876');
      expect(manager.getBestScore()).toBe('9876');

      // The exported helper tests/fixtures/storage.ts registers as the
      // suite-wide `afterEach`, called here directly so this case stands
      // alone rather than reading what a predecessor left behind.
      clearOwnedStorage();

      const afterTeardown = manager.getBestScore();

      expect(storage.getItem(BEST_SCORE_KEY)).toBeNull();
      expect(readOwnedStorage(BEST_SCORE_KEY)).toBeNull();
      expect(typeof afterTeardown).toBe('number');
      expect(afterTeardown).toBe(0);
    },
  );

  it(
    'removes every owned key from the ambient store and no other, so a best ' +
      'score cannot survive into a later test and a foreign key cannot be ' +
      'destroyed by the sweep',
    () => {
      const storage = requireAmbientStore();
      const manager = new LocalStorageManager({ storage });
      const foreignKey = 'analytics:sessionId';

      storage.setItem(foreignKey, 'untouched');

      expect(manager.setBestScore(4321)).toBe(true);
      expect(manager.setGameState(createMergePairBoard())).toBe(true);

      clearOwnedStorage();

      for (const key of OWNED_STORAGE_KEYS) {
        expect(storage.getItem(key)).toBeNull();
      }

      expect(storage.getItem(foreignKey)).toBe('untouched');
      expect(manager.getBestScore()).toBe(0);
      expect(manager.getGameState()).toBeNull();

      storage.removeItem(foreignKey);
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
