/**
 * Web Storage key registry. String declarations only: this module imports
 * nothing and touches no storage. Persistence, including the writability probe,
 * lives in src/storage/local-storage-manager.ts.
 *
 * `BEST_SCORE_KEY` and `GAME_STATE_KEY` are the frozen unprefixed literals the
 * pre-migration game wrote; every key introduced after them is minted by
 * `namespacedKey()` and carries the `STORAGE_NAMESPACE` prefix. Those three
 * declarations plus `namespacedKey()` define what the product owns.
 * `OwnedStorageKey` is that set as a type and `isOwnedStorageKey()` the same set
 * as a runtime check; src/storage/local-storage-manager.ts accepts a key only
 * when both agree, so no read, write or removal of this origin's other Web
 * Storage keys is reachable through the adapter.
 */

/**
 * Key the player's best score is persisted under. Frozen unprefixed literal, so
 * a value written by the pre-migration game is still read.
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
 * A key carrying the product's namespace prefix, as `namespacedKey()` mints it.
 */
export type NamespacedStorageKey =
  `${typeof STORAGE_NAMESPACE}${typeof NAMESPACE_DELIMITER}${string}`;

/**
 * Every key the product is permitted to read, write or remove: the two frozen
 * unprefixed literals, and any key carrying the product's namespace.
 * src/storage/local-storage-manager.ts accepts this type and nothing wider, so a
 * key belonging to another application on the same origin is not expressible at
 * a call site.
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
 * @throws {TypeError} If `name` is empty, contains whitespace, or contains the
 *   delimiter. This validation and its throwing behaviour are decision
 *   DL-STORE-01.
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
 * Accepts the two frozen unprefixed literals, and a namespaced key whose
 * unqualified name satisfies the same three conditions `namespacedKey()`
 * enforces: non-empty, no whitespace, and no further delimiter. Every other
 * string is rejected, including a bare namespace with no name, a differently
 * spelled namespace, and any key belonging to another application on the same
 * origin.
 *
 * Pure and total: it reads no storage, throws for no input, and accepts a value
 * of any string content.
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

/** Key the Web Storage writability probe writes and immediately removes. */
export const STORAGE_PROBE_KEY = namespacedKey('probe');

/**
 * The durable application-state keys, in declaration order, frozen. Callers
 * that clear the product's storage, notably test teardown, iterate this list.
 * The probe key is absent because the probe removes its own key immediately.
 */
export const OWNED_STORAGE_KEYS: readonly OwnedStorageKey[] = Object.freeze([
  BEST_SCORE_KEY,
  GAME_STATE_KEY,
  RUN_STATE_KEY,
]);
