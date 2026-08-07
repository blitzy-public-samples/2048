// Pins the Web Storage key registry src/storage/storage-keys.ts declares: the
// two frozen unprefixed literals ported from js/local_storage_manager.js L22
// and L23, the namespace and the keys minted from it, and the membership,
// order and freezing of OWNED_STORAGE_KEYS.
//
// The unit under test imports nothing and touches no storage. This suite reads
// no `window`, no `document` and no `localStorage`, declares no mock and no
// spy, and holds no state between tests. It passes in the `unit:dom` project
// vitest.config.ts collects it into and under a DOM-free environment alike.
//
// Every it() title names the construct it pins and, for a ported construct,
// the js/local_storage_manager.js line that declared it.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import { describe, expect, it } from 'vitest';

import {
  BEST_SCORE_KEY,
  GAME_STATE_KEY,
  isOwnedStorageKey,
  namespacedKey,
  OWNED_STORAGE_KEYS,
  RUN_STATE_KEY,
  STORAGE_NAMESPACE,
  STORAGE_PROBE_KEY,
} from '../../../src/storage/storage-keys';
import type {
  NamespacedStorageKey,
  OwnedStorageKey,
} from '../../../src/storage/storage-keys';

/* ===== 1. Fixtures ===== */

/**
 * The delimiter `namespacedKey()` places between the namespace and the name.
 * src/storage/storage-keys.ts holds it privately; it is restated here.
 */
const NAMESPACE_DELIMITER = ':';

/** `STORAGE_NAMESPACE` and the delimiter, as one string. */
const NAMESPACE_PREFIX = `${STORAGE_NAMESPACE}${NAMESPACE_DELIMITER}`;

/**
 * Unqualified name passed to `namespacedKey()` on its own. It names no key the
 * product persists.
 */
const SAMPLE_KEY_NAME = 'sample';

/** Unqualified names `namespacedKey()` rejects. */
const REJECTED_KEY_NAMES: readonly string[] = [
  '',
  'run State',
  `run${NAMESPACE_DELIMITER}State`,
];

/**
 * The two keys `namespacedKey()` minted, typed as that function returns them.
 * NamespacedStorageKey admits only a key carrying the namespace: the
 * annotation is checked at compile time.
 */
const MINTED_KEYS: readonly NamespacedStorageKey[] = [
  RUN_STATE_KEY,
  STORAGE_PROBE_KEY,
];

/**
 * The members of OWNED_STORAGE_KEYS, in the order that list declares them.
 */
const EXPECTED_OWNED_KEYS: readonly OwnedStorageKey[] = [
  BEST_SCORE_KEY,
  GAME_STATE_KEY,
  RUN_STATE_KEY,
];

/**
 * Every key src/storage/storage-keys.ts declares: the OWNED_STORAGE_KEYS
 * members, and STORAGE_PROBE_KEY, which that list omits.
 */
const DECLARED_KEYS: readonly OwnedStorageKey[] = [
  ...EXPECTED_OWNED_KEYS,
  STORAGE_PROBE_KEY,
];

/* ===== 2. Frozen legacy keys ===== */

describe('frozen legacy keys ported from js/local_storage_manager.js', () => {
  it(
    'BEST_SCORE_KEY is the unprefixed literal declared at ' +
      'js/local_storage_manager.js L22',
    () => {
      expect(BEST_SCORE_KEY).toBe('bestScore');
    }
  );

  it(
    'GAME_STATE_KEY is the unprefixed literal declared at ' +
      'js/local_storage_manager.js L23',
    () => {
      expect(GAME_STATE_KEY).toBe('gameState');
    }
  );

  it(
    'BEST_SCORE_KEY carries neither STORAGE_NAMESPACE nor the delimiter ' +
      '(L22)',
    () => {
      expect(BEST_SCORE_KEY.includes(STORAGE_NAMESPACE)).toBe(false);
      expect(BEST_SCORE_KEY.includes(NAMESPACE_DELIMITER)).toBe(false);
      expect(BEST_SCORE_KEY.startsWith(NAMESPACE_PREFIX)).toBe(false);
    }
  );

  it(
    'GAME_STATE_KEY carries neither STORAGE_NAMESPACE nor the delimiter ' +
      '(L23)',
    () => {
      expect(GAME_STATE_KEY.includes(STORAGE_NAMESPACE)).toBe(false);
      expect(GAME_STATE_KEY.includes(NAMESPACE_DELIMITER)).toBe(false);
      expect(GAME_STATE_KEY.startsWith(NAMESPACE_PREFIX)).toBe(false);
    }
  );

  it(
    'BEST_SCORE_KEY and GAME_STATE_KEY are non-empty strings and are ' +
      'distinct (L22, L23)',
    () => {
      expect(typeof BEST_SCORE_KEY).toBe('string');
      expect(typeof GAME_STATE_KEY).toBe('string');
      expect(BEST_SCORE_KEY.length).toBeGreaterThan(0);
      expect(GAME_STATE_KEY.length).toBeGreaterThan(0);
      expect(BEST_SCORE_KEY).not.toBe(GAME_STATE_KEY);
    }
  );
});

/* ===== 3. Namespace and key minting ===== */

describe('namespace and key minting', () => {
  it('STORAGE_NAMESPACE is the prefix every minted key carries', () => {
    expect(STORAGE_NAMESPACE).toBe('roguelike2048');
    expect(typeof STORAGE_NAMESPACE).toBe('string');
    expect(STORAGE_NAMESPACE.includes(NAMESPACE_DELIMITER)).toBe(false);
  });

  it(
    'namespacedKey() composes STORAGE_NAMESPACE, the delimiter and the ' +
      'supplied name',
    () => {
      const minted = namespacedKey(SAMPLE_KEY_NAME);

      expect(minted).toBe('roguelike2048:sample');
      expect(minted).toBe(`${NAMESPACE_PREFIX}${SAMPLE_KEY_NAME}`);
      expect(minted.startsWith(NAMESPACE_PREFIX)).toBe(true);
      expect(minted.slice(NAMESPACE_PREFIX.length)).toBe(SAMPLE_KEY_NAME);
    }
  );

  it('namespacedKey() returns the same key for a repeated name', () => {
    const first = namespacedKey(SAMPLE_KEY_NAME);
    const second = namespacedKey(SAMPLE_KEY_NAME);

    expect(second).toBe(first);
  });

  it(
    'RUN_STATE_KEY is namespacedKey() applied to the run-state name and ' +
      'carries STORAGE_NAMESPACE',
    () => {
      expect(RUN_STATE_KEY).toBe('roguelike2048:runState');
      expect(RUN_STATE_KEY).toBe(namespacedKey('runState'));
      expect(RUN_STATE_KEY.startsWith(NAMESPACE_PREFIX)).toBe(true);
    }
  );

  it(
    'STORAGE_PROBE_KEY is namespacedKey() applied to the probe name and ' +
      'carries STORAGE_NAMESPACE',
    () => {
      expect(STORAGE_PROBE_KEY).toBe('roguelike2048:probe');
      expect(STORAGE_PROBE_KEY).toBe(namespacedKey('probe'));
      expect(STORAGE_PROBE_KEY.startsWith(NAMESPACE_PREFIX)).toBe(true);
    }
  );

  it(
    'RUN_STATE_KEY and STORAGE_PROBE_KEY inhabit NamespacedStorageKey and ' +
      'each split into one namespace and one non-empty name',
    () => {
      expect(MINTED_KEYS.length).toBeGreaterThan(0);

      for (const key of MINTED_KEYS) {
        const unqualifiedName = key.slice(NAMESPACE_PREFIX.length);

        expect(key.startsWith(NAMESPACE_PREFIX)).toBe(true);
        expect(unqualifiedName.length).toBeGreaterThan(0);
        expect(unqualifiedName.includes(NAMESPACE_DELIMITER)).toBe(false);
        expect(isOwnedStorageKey(key)).toBe(true);
      }
    }
  );

  it(
    'RUN_STATE_KEY and STORAGE_PROBE_KEY are distinct and collide with ' +
      'neither frozen key',
    () => {
      expect(RUN_STATE_KEY).not.toBe(STORAGE_PROBE_KEY);
      expect(RUN_STATE_KEY).not.toBe(BEST_SCORE_KEY);
      expect(RUN_STATE_KEY).not.toBe(GAME_STATE_KEY);
      expect(STORAGE_PROBE_KEY).not.toBe(BEST_SCORE_KEY);
      expect(STORAGE_PROBE_KEY).not.toBe(GAME_STATE_KEY);
    }
  );

  it(
    'namespacedKey() throws a TypeError for an empty name, a name with ' +
      'whitespace and a name holding the delimiter (DL-STORE-01)',
    () => {
      expect(REJECTED_KEY_NAMES.length).toBeGreaterThan(0);

      for (const name of REJECTED_KEY_NAMES) {
        expect(() => namespacedKey(name)).toThrow(TypeError);
      }
    }
  );
});

/* ===== 4. OWNED_STORAGE_KEYS registry completeness ===== */

describe('OWNED_STORAGE_KEYS registry completeness', () => {
  it(
    'OWNED_STORAGE_KEYS names the durable keys test teardown iterates, in ' +
      'declaration order',
    () => {
      expect([...OWNED_STORAGE_KEYS]).toStrictEqual([...EXPECTED_OWNED_KEYS]);
      expect(OWNED_STORAGE_KEYS).toContain(BEST_SCORE_KEY);
      expect(OWNED_STORAGE_KEYS).toContain(GAME_STATE_KEY);
      expect(OWNED_STORAGE_KEYS).toContain(RUN_STATE_KEY);
      expect(OWNED_STORAGE_KEYS.length).toBe(EXPECTED_OWNED_KEYS.length);
    }
  );

  it('OWNED_STORAGE_KEYS holds no duplicate entry', () => {
    const distinctKeys = new Set(OWNED_STORAGE_KEYS);

    expect(distinctKeys.size).toBe(OWNED_STORAGE_KEYS.length);
  });

  it('OWNED_STORAGE_KEYS holds only non-empty strings', () => {
    expect(OWNED_STORAGE_KEYS.length).toBeGreaterThan(0);

    for (const key of OWNED_STORAGE_KEYS) {
      expect(typeof key).toBe('string');
      expect(key.length).toBeGreaterThan(0);
    }
  });

  it(
    'OWNED_STORAGE_KEYS is a frozen array, matching the readonly type it ' +
      'is declared with',
    () => {
      expect(Array.isArray(OWNED_STORAGE_KEYS)).toBe(true);
      expect(Object.isFrozen(OWNED_STORAGE_KEYS)).toBe(true);
    }
  );

  it(
    'OWNED_STORAGE_KEYS omits STORAGE_PROBE_KEY, which ' +
      'isOwnedStorageKey() accepts',
    () => {
      expect(OWNED_STORAGE_KEYS).not.toContain(STORAGE_PROBE_KEY);
      expect(isOwnedStorageKey(STORAGE_PROBE_KEY)).toBe(true);
    }
  );

  it(
    'isOwnedStorageKey() accepts every key src/storage/storage-keys.ts ' +
      'declares, leaving no product key outside teardown',
    () => {
      expect(DECLARED_KEYS.length).toBe(OWNED_STORAGE_KEYS.length + 1);

      for (const key of DECLARED_KEYS) {
        expect(isOwnedStorageKey(key)).toBe(true);
      }
    }
  );

  it(
    'isOwnedStorageKey() rejects STORAGE_NAMESPACE alone and the bare ' +
      'namespace prefix, neither of which names a key',
    () => {
      expect(isOwnedStorageKey(STORAGE_NAMESPACE)).toBe(false);
      expect(isOwnedStorageKey(NAMESPACE_PREFIX)).toBe(false);
    }
  );
});
