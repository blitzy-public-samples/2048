// Pins the Web Storage key registry src/storage/storage-keys.ts declares: the
// two frozen unprefixed literals ported from js/local_storage_manager.js, the
// namespace and the keys minted from it, and the membership, order and
// freezing of OWNED_STORAGE_KEYS.
//
// The unit under test imports nothing and touches no storage. This suite reads
// no `window`, no `document` and no `localStorage`, declares no mock and no
// spy, and holds no state between tests. It passes in the `unit:dom` project
// vitest.config.ts collects it into and under a DOM-free environment alike.
//
// Decisions: DL-STORE-01 (docs/DECISION_LOG.md).

import { describe, expect, it } from 'vitest';

import {
  BEST_SCORE_KEY,
  GAME_STATE_KEY,
  isOwnedStorageKey,
  KEYMAP_KEY,
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

const NAMESPACE_DELIMITER = ':';

const NAMESPACE_PREFIX = `${STORAGE_NAMESPACE}${NAMESPACE_DELIMITER}`;

const SAMPLE_KEY_NAME = 'sample';

const REJECTED_KEY_NAMES: readonly string[] = [
  '',
  'run State',
  `run${NAMESPACE_DELIMITER}State`,
];

/**
 * Unqualified names `namespacedKey` accepts, each non-empty and carrying
 * neither whitespace nor the delimiter.
 */
const ACCEPTED_KEY_NAMES: readonly string[] = [
  'a',
  '0',
  'runState',
  '__proto__',
  'constructor',
  'état',
  'run-state_2',
  'x'.repeat(200),
];

/** One rejected name paired with the exact message it is rejected with. */
interface RejectedName {
  /** Name handed to `namespacedKey`. */
  readonly name: string;

  /** Label quoted in the test title, since a raw name may be invisible. */
  readonly label: string;

  /** The exact `TypeError` message the rejection carries. */
  readonly message: string;
}

/**
 * The empty, whitespace-bearing and delimiter-bearing names, each with the
 * message `namespacedKey` rejects it with.
 */
const REJECTED_NAME_REPORTS: readonly RejectedName[] = [
  {
    name: '',
    label: 'an empty name',
    message: 'Storage key name must not be empty.',
  },
  {
    name: 'run State',
    label: 'a name holding a space',
    message: 'Storage key name must not contain whitespace: "run State".',
  },
  {
    name: 'run\tState',
    label: 'a name holding a tab',
    message: 'Storage key name must not contain whitespace: "run\tState".',
  },
  {
    name: 'run\nState',
    label: 'a name holding a newline',
    message: 'Storage key name must not contain whitespace: "run\nState".',
  },
  {
    name: 'run\u00a0State',
    label: 'a name holding a no-break space',
    message:
      'Storage key name must not contain whitespace: "run\u00a0State".',
  },
  {
    name: ' runState',
    label: 'a name with a leading space',
    message: 'Storage key name must not contain whitespace: " runState".',
  },
  {
    name: 'runState ',
    label: 'a name with a trailing space',
    message: 'Storage key name must not contain whitespace: "runState ".',
  },
  {
    name: `run${NAMESPACE_DELIMITER}State`,
    label: 'a name holding the delimiter',
    message:
      `Storage key name must not contain the "${NAMESPACE_DELIMITER}" ` +
      `delimiter: "run${NAMESPACE_DELIMITER}State".`,
  },
  {
    name: NAMESPACE_DELIMITER,
    label: 'a name that is only the delimiter',
    message:
      `Storage key name must not contain the "${NAMESPACE_DELIMITER}" ` +
      `delimiter: "${NAMESPACE_DELIMITER}".`,
  },
  {
    name: `a${NAMESPACE_DELIMITER}b${NAMESPACE_DELIMITER}c`,
    label: 'a name holding two delimiters',
    message:
      `Storage key name must not contain the "${NAMESPACE_DELIMITER}" ` +
      `delimiter: "a${NAMESPACE_DELIMITER}b${NAMESPACE_DELIMITER}c".`,
  },
  {
    name: `run ${NAMESPACE_DELIMITER}State`,
    label: 'a name holding both a space and the delimiter',
    message:
      `Storage key name must not contain whitespace: "run ` +
      `${NAMESPACE_DELIMITER}State".`,
  },
];

/**
 * Keys the product does not own, each with the label its test title quotes.
 */
const UNOWNED_KEYS: readonly { key: string; label: string }[] = [
  { key: '', label: 'the empty string' },
  { key: 'theme', label: "another application's key" },
  { key: 'analytics.sessionId', label: 'a dotted foreign key' },
  { key: 'user:token', label: 'a foreign key carrying a delimiter' },
  { key: '2048', label: 'a bare numeric key' },
  { key: 'bestscore', label: 'the best-score literal in lower case' },
  { key: 'BestScore', label: 'the best-score literal in title case' },
  { key: 'bestScore2', label: 'the best-score literal with a suffix' },
  { key: 'bestScore ', label: 'the best-score literal with a trailing space' },
  { key: ' bestScore', label: 'the best-score literal with a leading space' },
  { key: 'gamestate', label: 'the snapshot literal in lower case' },
  { key: 'gameStates', label: 'the snapshot literal pluralised' },
  { key: 'roguelike2049:runState', label: 'a misspelled namespace' },
  { key: 'Roguelike2048:runState', label: 'the namespace in title case' },
  { key: 'roguelike2048x:runState', label: 'the namespace with a suffix' },
  { key: 'roguelike204:8runState', label: 'the namespace cut short' },
  { key: 'xroguelike2048:runState', label: 'the namespace with a prefix' },
  { key: ' roguelike2048:runState', label: 'a space before the namespace' },
  { key: 'roguelike2048 :runState', label: 'a space before the delimiter' },
  { key: 'roguelike2048:', label: 'the namespace with an empty name' },
  { key: 'roguelike2048::runState', label: 'a doubled delimiter' },
  { key: 'roguelike2048:run:State', label: 'a name holding a delimiter' },
  { key: 'roguelike2048:runState:', label: 'a trailing delimiter' },
  { key: 'roguelike2048:run State', label: 'a name holding a space' },
  { key: 'roguelike2048:run\tState', label: 'a name holding a tab' },
  { key: 'roguelike2048:run\nState', label: 'a name holding a newline' },
  { key: 'roguelike2048:runState ', label: 'a name with a trailing space' },
  { key: 'roguelike2048: runState', label: 'a name with a leading space' },
  { key: 'roguelike2048:run\u00a0State', label: 'a no-break space' },
];

/**
 * The two keys `namespacedKey` minted, typed as that function returns them.
 */
const MINTED_KEYS: readonly NamespacedStorageKey[] = [
  RUN_STATE_KEY,
  STORAGE_PROBE_KEY,
];

const EXPECTED_OWNED_KEYS: readonly OwnedStorageKey[] = [
  BEST_SCORE_KEY,
  GAME_STATE_KEY,
  RUN_STATE_KEY,
  KEYMAP_KEY,
];

const DECLARED_KEYS: readonly OwnedStorageKey[] = [
  ...EXPECTED_OWNED_KEYS,
  STORAGE_PROBE_KEY,
];

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
      'whitespace and a name holding the delimiter',
    () => {
      expect(REJECTED_KEY_NAMES.length).toBeGreaterThan(0);

      for (const name of REJECTED_KEY_NAMES) {
        expect(() => namespacedKey(name)).toThrow(TypeError);
      }
    }
  );
});

describe('OWNED_STORAGE_KEYS registry completeness', () => {
  it(
    'OWNED_STORAGE_KEYS names the durable keys test teardown iterates, in ' +
      'declaration order',
    () => {
      expect([...OWNED_STORAGE_KEYS]).toStrictEqual([...EXPECTED_OWNED_KEYS]);
      expect(OWNED_STORAGE_KEYS).toContain(BEST_SCORE_KEY);
      expect(OWNED_STORAGE_KEYS).toContain(GAME_STATE_KEY);
      expect(OWNED_STORAGE_KEYS).toContain(RUN_STATE_KEY);

      // The remapped bindings, which a rebind persists through the input
      // manager's own single api.
      expect(OWNED_STORAGE_KEYS).toContain(KEYMAP_KEY);
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

// src/storage/local-storage-manager.ts admits a key only when
// isOwnedStorageKey accepts it, so every entry rejected here is a key the
// adapter refuses to read, write or remove.
describe('isOwnedStorageKey() rejects every key outside the product', () => {
  it.each(UNOWNED_KEYS)('rejects $label', ({ key }: { key: string }) => {
    expect(isOwnedStorageKey(key)).toBe(false);
  });

  it('rejects every unowned key without throwing for any of them', () => {
    expect(UNOWNED_KEYS.length).toBeGreaterThan(0);

    for (const { key } of UNOWNED_KEYS) {
      expect(() => isOwnedStorageKey(key)).not.toThrow();
      expect(isOwnedStorageKey(key)).toBe(false);
    }
  });

  it('accepts the two frozen literals only as their exact spellings', () => {
    expect(isOwnedStorageKey(BEST_SCORE_KEY)).toBe(true);
    expect(isOwnedStorageKey(GAME_STATE_KEY)).toBe(true);

    for (const key of [BEST_SCORE_KEY, GAME_STATE_KEY]) {
      expect(isOwnedStorageKey(key.toUpperCase())).toBe(false);
      expect(isOwnedStorageKey(key.toLowerCase())).toBe(
        key === key.toLowerCase()
      );
      expect(isOwnedStorageKey(`${key}${NAMESPACE_DELIMITER}`)).toBe(false);
      expect(isOwnedStorageKey(`${NAMESPACE_PREFIX}${key}`)).toBe(true);
    }
  });

  it('accepts a namespaced key for every name namespacedKey() admits', () => {
    for (const name of ACCEPTED_KEY_NAMES) {
      const minted = namespacedKey(name);

      expect(minted).toBe(`${NAMESPACE_PREFIX}${name}`);
      expect(isOwnedStorageKey(minted)).toBe(true);
    }
  });

  it('rejects the same name it accepts once whitespace is added', () => {
    for (const name of ACCEPTED_KEY_NAMES) {
      expect(isOwnedStorageKey(`${NAMESPACE_PREFIX}${name}`)).toBe(true);
      expect(isOwnedStorageKey(`${NAMESPACE_PREFIX}${name} `)).toBe(false);
      expect(isOwnedStorageKey(`${NAMESPACE_PREFIX} ${name}`)).toBe(false);
      expect(
        isOwnedStorageKey(
          `${NAMESPACE_PREFIX}${name}${NAMESPACE_DELIMITER}x`
        )
      ).toBe(false);
    }
  });
});

// The predicate and the minting function enforce the same three conditions, so
// a name one rejects is a name the other cannot produce a key for.
describe('namespacedKey() refuses exactly the names the predicate does', () => {
  it.each(REJECTED_NAME_REPORTS)(
    'throws TypeError for $label',
    ({ name }: RejectedName) => {
      expect(() => namespacedKey(name)).toThrow(TypeError);
    }
  );

  it.each(REJECTED_NAME_REPORTS)(
    'reports $label with the reason it was refused for',
    ({ name, message }: RejectedName) => {
      expect(() => namespacedKey(name)).toThrow(message);
    }
  );

  it('would mint a key the predicate rejects, were the guard not there', () => {
    for (const { name } of REJECTED_NAME_REPORTS) {
      expect(isOwnedStorageKey(`${NAMESPACE_PREFIX}${name}`)).toBe(false);
    }
  });

  it('accepts every name in the accepted table without throwing', () => {
    for (const name of ACCEPTED_KEY_NAMES) {
      expect(() => namespacedKey(name)).not.toThrow();
    }
  });
});
