// Unit suite for src/storage/memory-storage.ts: the `StorageLike` contract and
// the `MemoryStorage` in-memory store that satisfies it.
//
// Every test constructs the instance it reads. No instance, key or value
// crosses an `it` boundary, and this file registers no `beforeEach`.
//
// This file imports the subject and the vitest test API and nothing else: no
// mocking library, no spy, no storage package. It reads no DOM, no storage
// global and no clock, consumes no randomness and installs nothing. It runs
// unchanged in a DOM-free environment.
//
// Decisions: DL-STORE-05 (docs/DECISION_LOG.md).

import { describe, expect, it } from 'vitest';

import { MemoryStorage } from '../../../src/storage/memory-storage';
import type { StorageLike } from '../../../src/storage/memory-storage';

const BEST_SCORE_KEY = 'bestScore';

const GAME_STATE_KEY = 'gameState';

const UNWRITTEN_KEY = 'neverWritten';

const PROTOTYPE_NAMED_KEYS: readonly string[] = [
  '__proto__',
  'constructor',
  'hasOwnProperty',
];

interface UntypedWriter {
  setItem(key: string, value: unknown): void;
}

function untypedWriter(storage: MemoryStorage): UntypedWriter {
  return storage;
}

describe('MemoryStorage.setItem — String() coercion (vanilla L4-L6)', () => {
  it('setItem (L4-L6) stores the number 1234 as the string "1234"', () => {
    const storage = new MemoryStorage();

    untypedWriter(storage).setItem(BEST_SCORE_KEY, 1234);

    const stored = storage.getItem(BEST_SCORE_KEY);

    expect(stored).toBe('1234');
    expect(typeof stored).toBe('string');
  });

  it('setItem (L4-L6) round-trips a string value unchanged', () => {
    const storage = new MemoryStorage();
    const snapshot = '{"grid":{"size":4},"score":128}';

    storage.setItem(GAME_STATE_KEY, snapshot);

    expect(storage.getItem(GAME_STATE_KEY)).toBe(snapshot);
  });

  it('setItem (L4-L6) stores the number 0 as the truthy string "0"', () => {
    const storage = new MemoryStorage();

    untypedWriter(storage).setItem(BEST_SCORE_KEY, 0);

    const stored = storage.getItem(BEST_SCORE_KEY);

    expect(stored).toBe('0');
    expect(typeof stored).toBe('string');
    expect(Boolean(stored)).toBe(true);
  });

  it('setItem (L4-L6) stores the boolean true as the string "true"', () => {
    const storage = new MemoryStorage();

    untypedWriter(storage).setItem(BEST_SCORE_KEY, true);

    const stored = storage.getItem(BEST_SCORE_KEY);

    expect(stored).toBe('true');
    expect(typeof stored).toBe('string');
  });

  it('setItem (L4-L6) stores a plain object as "[object Object]"', () => {
    const storage = new MemoryStorage();

    untypedWriter(storage).setItem(GAME_STATE_KEY, { score: 128 });

    const stored = storage.getItem(GAME_STATE_KEY);

    expect(stored).toBe('[object Object]');
    expect(typeof stored).toBe('string');
  });

  it('setItem (L4-L6) replaces the value of a key already written', () => {
    const storage = new MemoryStorage();

    storage.setItem(BEST_SCORE_KEY, '1024');
    storage.setItem(BEST_SCORE_KEY, '2048');

    expect(storage.getItem(BEST_SCORE_KEY)).toBe('2048');
  });
});

describe('MemoryStorage.getItem — presence test (vanilla L8-L10)', () => {
  it('getItem (L8-L10) yields undefined, not null, for an absent key', () => {
    const storage = new MemoryStorage();

    const missing = storage.getItem(UNWRITTEN_KEY);

    expect(missing).toBeUndefined();
    expect(missing).not.toBeNull();
  });

  it('getItem (L8-L10) yields the empty string for a key written empty', () => {
    const storage = new MemoryStorage();

    storage.setItem(GAME_STATE_KEY, '');

    const stored = storage.getItem(GAME_STATE_KEY);

    expect(stored).toBe('');
    expect(stored).not.toBeUndefined();
    expect(Boolean(stored)).toBe(false);
  });

  it('getItem (L8-L10) treats a prototype-named key as any other', () => {
    const storage = new MemoryStorage();

    for (const key of PROTOTYPE_NAMED_KEYS) {
      expect(storage.getItem(key)).toBeUndefined();
    }

    for (const key of PROTOTYPE_NAMED_KEYS) {
      storage.setItem(key, `value for ${key}`);
    }

    for (const key of PROTOTYPE_NAMED_KEYS) {
      expect(storage.getItem(key)).toBe(`value for ${key}`);
    }
  });
});

describe('MemoryStorage.removeItem (vanilla L12-L14)', () => {
  it('removeItem (L12-L14) leaves the key absent for getItem', () => {
    const storage = new MemoryStorage();

    storage.setItem(BEST_SCORE_KEY, '2048');
    storage.removeItem(BEST_SCORE_KEY);

    const removed = storage.getItem(BEST_SCORE_KEY);

    expect(removed).toBeUndefined();
    expect(removed).not.toBeNull();
  });

  it('removeItem (L12-L14) does not throw for a key never written', () => {
    const storage = new MemoryStorage();

    expect(() => {
      storage.removeItem(UNWRITTEN_KEY);
    }).not.toThrow();

    expect(storage.getItem(UNWRITTEN_KEY)).toBeUndefined();
  });

  it('removeItem (L12-L14) leaves every other key in place', () => {
    const storage = new MemoryStorage();

    storage.setItem(BEST_SCORE_KEY, '2048');
    storage.setItem(GAME_STATE_KEY, '{"score":128}');

    storage.removeItem(GAME_STATE_KEY);

    expect(storage.getItem(GAME_STATE_KEY)).toBeUndefined();
    expect(storage.getItem(BEST_SCORE_KEY)).toBe('2048');
  });
});

describe('MemoryStorage.clear (vanilla L16-L18)', () => {
  it('clear (L16-L18) leaves every written key reading undefined', () => {
    const storage = new MemoryStorage();
    const keys = [BEST_SCORE_KEY, GAME_STATE_KEY, ...PROTOTYPE_NAMED_KEYS];

    for (const key of keys) {
      storage.setItem(key, `stored ${key}`);
    }

    storage.clear();

    for (const key of keys) {
      expect(storage.getItem(key)).toBeUndefined();
    }
  });

  it('clear (L16-L18) leaves the instance usable for a later write', () => {
    const storage = new MemoryStorage();

    storage.setItem(BEST_SCORE_KEY, '1024');
    storage.clear();
    storage.setItem(BEST_SCORE_KEY, '2048');

    expect(storage.getItem(BEST_SCORE_KEY)).toBe('2048');
  });

  it('clear (L16-L18) does not throw on an instance holding no key', () => {
    const storage = new MemoryStorage();

    expect(() => {
      storage.clear();
      storage.clear();
    }).not.toThrow();

    expect(storage.getItem(BEST_SCORE_KEY)).toBeUndefined();
  });
});

describe(
  'MemoryStorage per-instance isolation — vanilla L1-L2 was a global ' +
    'singleton with one shared _data; the port holds one store per instance',
  () => {
    it('setItem (L4-L6) writes are unseen across instances, both ways', () => {
      const first = new MemoryStorage();
      const second = new MemoryStorage();

      first.setItem(BEST_SCORE_KEY, '2048');

      expect(second.getItem(BEST_SCORE_KEY)).toBeUndefined();

      second.setItem(GAME_STATE_KEY, '{"score":128}');

      expect(first.getItem(GAME_STATE_KEY)).toBeUndefined();
      expect(first.getItem(BEST_SCORE_KEY)).toBe('2048');
      expect(second.getItem(GAME_STATE_KEY)).toBe('{"score":128}');
    });

    it('clear (L16-L18) on one instance leaves another whole', () => {
      const cleared = new MemoryStorage();
      const kept = new MemoryStorage();

      cleared.setItem(BEST_SCORE_KEY, '1024');
      kept.setItem(BEST_SCORE_KEY, '2048');

      cleared.clear();

      expect(cleared.getItem(BEST_SCORE_KEY)).toBeUndefined();
      expect(kept.getItem(BEST_SCORE_KEY)).toBe('2048');
    });

    it('removeItem (L12-L14) on one instance leaves another whole', () => {
      const pruned = new MemoryStorage();
      const kept = new MemoryStorage();

      pruned.setItem(GAME_STATE_KEY, '{"score":128}');
      kept.setItem(GAME_STATE_KEY, '{"score":256}');

      pruned.removeItem(GAME_STATE_KEY);

      expect(pruned.getItem(GAME_STATE_KEY)).toBeUndefined();
      expect(kept.getItem(GAME_STATE_KEY)).toBe('{"score":256}');
    });
  }
);

describe('StorageLike structural conformance', () => {
  it('accepts MemoryStorage through all four members (L4-L18)', () => {
    const storage: StorageLike = new MemoryStorage();

    storage.setItem(BEST_SCORE_KEY, '2048');

    expect(storage.getItem(BEST_SCORE_KEY)).toBe('2048');

    storage.removeItem(BEST_SCORE_KEY);

    expect(storage.getItem(BEST_SCORE_KEY)).toBeUndefined();

    storage.setItem(GAME_STATE_KEY, '{"score":128}');
    storage.clear();

    expect(storage.getItem(GAME_STATE_KEY)).toBeUndefined();
  });

  it('accepts a hand-written literal of the four members (L4-L18)', () => {
    const entries = new Map<string, string>();
    const standIn: StorageLike = {
      getItem: (key) => entries.get(key) ?? null,
      setItem: (key, value) => {
        entries.set(key, value);
      },
      removeItem: (key) => {
        entries.delete(key);
      },
      clear: () => {
        entries.clear();
      },
    };

    standIn.setItem(BEST_SCORE_KEY, '2048');

    expect(standIn.getItem(BEST_SCORE_KEY)).toBe('2048');

    standIn.removeItem(BEST_SCORE_KEY);

    expect(standIn.getItem(BEST_SCORE_KEY)).toBeNull();

    standIn.setItem(GAME_STATE_KEY, '{"score":128}');
    standIn.clear();

    expect(standIn.getItem(GAME_STATE_KEY)).toBeNull();
  });

  it('accepts the DOM Storage interface unadapted (L26)', () => {
    const acceptStorage: (storage: Storage) => StorageLike = (storage) =>
      storage;

    const entries = new Map<string, string>();
    const domShaped: Storage = {
      get length() {
        return entries.size;
      },
      key: (index) => Array.from(entries.keys())[index] ?? null,
      getItem: (key) => entries.get(key) ?? null,
      setItem: (key, value) => {
        entries.set(key, String(value));
      },
      removeItem: (key) => {
        entries.delete(key);
      },
      clear: () => {
        entries.clear();
      },
    };

    const storage: StorageLike = acceptStorage(domShaped);

    storage.setItem(BEST_SCORE_KEY, '2048');

    expect(storage.getItem(BEST_SCORE_KEY)).toBe('2048');
    expect(storage.getItem(UNWRITTEN_KEY)).toBeNull();

    storage.removeItem(BEST_SCORE_KEY);
    storage.clear();

    expect(storage.getItem(BEST_SCORE_KEY)).toBeNull();
  });
});
