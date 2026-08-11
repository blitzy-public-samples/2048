/**
 * Web Storage key registry. String declarations only: this module imports
 * nothing and touches no storage.
 *
 * One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
 * this module's area enumerated:
 *   TR-KEYS-01  js/local_storage_manager.js L22  `bestScore`, the frozen
 *                                                unprefixed literal
 *   TR-KEYS-02  js/local_storage_manager.js L23  `gameState`, the frozen
 *                                                unprefixed literal
 *   TR-KEYS-03  js/local_storage_manager.js L31  the probe's key literal,
 *                                                minted here as
 *                                                `STORAGE_PROBE_KEY`
 *   TR-KEYS-04  target-only row                  `STORAGE_NAMESPACE` and
 *                                                `namespacedKey()`
 *   TR-KEYS-05  target-only row                  `RUN_STATE_KEY`
 *   TR-KEYS-06  target-only row                  `OwnedStorageKey`,
 *                                                `isOwnedStorageKey()` and
 *                                                `OWNED_STORAGE_KEYS`
 *   TR-KEYS-07  target-only row                  `PREFERENCES_KEY`
 *
 * Decisions: DL-KEYS-01, DL-KEYS-02, DL-KEYS-03, DL-KEYS-04
 * (docs/DECISION_LOG.md).
 */

/**
 * Key the player's best score is persisted under. Frozen unprefixed literal,
 * so a value written by the pre-migration game is still read.
 */
export const BEST_SCORE_KEY = 'bestScore' as const;

/**
 * Key the board snapshot is persisted under. Frozen unprefixed literal, so a
 * snapshot written by the pre-migration game is still read.
 */
export const GAME_STATE_KEY = 'gameState' as const;

/** Prefix carried by every key minted after the two frozen literals above. */
export const STORAGE_NAMESPACE = 'roguelike2048' as const;

const NAMESPACE_DELIMITER = ':';

/** `STORAGE_NAMESPACE` and the delimiter, as one string. */
const NAMESPACE_PREFIX = `${STORAGE_NAMESPACE}${NAMESPACE_DELIMITER}`;

/** No global flag, so no `lastIndex` state carries between calls. */
const WHITESPACE_PATTERN = /\s/;

/**
 * A key carrying the product's namespace prefix, as `namespacedKey` mints it.
 */
export type NamespacedStorageKey =
  `${typeof STORAGE_NAMESPACE}${typeof NAMESPACE_DELIMITER}${string}`;

/**
 * Every key the product is permitted to read, write or remove: the two frozen
 * unprefixed literals, and any key carrying the product's namespace.
 * src/storage/local-storage-manager.ts accepts this type and nothing wider, so
 * a key belonging to another application on the same origin is not expressible
 * at a call site.
 */
export type OwnedStorageKey =
  | typeof BEST_SCORE_KEY
  | typeof GAME_STATE_KEY
  | NamespacedStorageKey;

/**
 * Mints a namespaced storage key. This is the only place one is constructed.
 *
 * @param name Unqualified key name, for example `'runState'`. Must be a
 *   non-empty string containing neither whitespace nor the `':'` delimiter, so
 *   the result splits into exactly one namespace and one name.
 * @returns `name` prefixed with `STORAGE_NAMESPACE` and the delimiter.
 * @throws {TypeError} If `name` is empty, contains whitespace, or contains
 *   the delimiter.
 */
export function namespacedKey(name: string): NamespacedStorageKey {
  if (name.length === 0) {
    throw new TypeError('Storage key name must not be empty.');
  }

  if (WHITESPACE_PATTERN.test(name)) {
    throw new TypeError(
      `Storage key name must not contain whitespace: "${name}".`
    );
  }

  if (name.includes(NAMESPACE_DELIMITER)) {
    throw new TypeError(
      'Storage key name must not contain the ' +
        `"${NAMESPACE_DELIMITER}" delimiter: "${name}".`
    );
  }

  return `${STORAGE_NAMESPACE}${NAMESPACE_DELIMITER}${name}`;
}

/**
 * Reports whether `key` is one the product owns.
 *
 * Pure and total: it reads no storage, throws for no input, and accepts a
 * value of any string content.
 *
 * @param key Key to test.
 * @returns `true` when `key` is owned by the product.
 */
export function isOwnedStorageKey(key: string): key is OwnedStorageKey {
  if (key === BEST_SCORE_KEY || key === GAME_STATE_KEY) {
    return true;
  }

  if (!key.startsWith(NAMESPACE_PREFIX)) {
    return false;
  }

  const name = key.slice(NAMESPACE_PREFIX.length);

  return (
    name.length > 0 &&
    !WHITESPACE_PATTERN.test(name) &&
    !name.includes(NAMESPACE_DELIMITER)
  );
}


/** Key the versioned run-state envelope is persisted under. */
export const RUN_STATE_KEY = namespacedKey('runState');

/** Key the serialised keyboard binding table is persisted under. */
export const KEYMAP_KEY = namespacedKey('keymap');

/**
 * ADDED: key the versioned accessibility and presentation preference envelope
 * is persisted under — palette, motion setting, number-only choice, mute and
 * volume.
 *
 * Namespaced like every key minted after the two frozen literals, so the
 * `bestScore` and `gameState` contracts are untouched by its arrival.
 * DL-KEYS-04.
 */
export const PREFERENCES_KEY = namespacedKey('preferences');

/** Key the Web Storage writability probe writes and immediately removes. */
export const STORAGE_PROBE_KEY = namespacedKey('probe');

/**
 * The durable application-state keys, in declaration order, frozen. Callers
 * that clear the product's storage, notably test teardown, iterate this list.
 */
export const OWNED_STORAGE_KEYS: readonly OwnedStorageKey[] = Object.freeze([
  BEST_SCORE_KEY,
  GAME_STATE_KEY,
  RUN_STATE_KEY,
  KEYMAP_KEY,

  // ADDED with `PREFERENCES_KEY`, so test teardown and any consumer that
  // clears the product's storage reach it without a second edit. DL-KEYS-04.
  PREFERENCES_KEY,
]);
