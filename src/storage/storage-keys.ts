/**
 * Storage key registry.
 *
 * Declares every Web Storage key the product uses. This module holds
 * string declarations only: it imports nothing, and it reads and
 * writes no storage of any kind. Persistence itself, including the
 * writability probe, lives in
 * src/storage/local-storage-manager.ts.
 *
 * `BEST_SCORE_KEY` and `GAME_STATE_KEY` are ported verbatim from
 * js/local_storage_manager.js L22-L23 and are intentionally left
 * unprefixed. Every key introduced after that port is minted by
 * `namespacedKey()` and carries the `STORAGE_NAMESPACE` prefix.
 *
 * Rationale for the choices made here is recorded in
 * docs/DECISION_LOG.md.
 */

/**
 * Key the player's best score is persisted under.
 *
 * Ported verbatim from `bestScoreKey`,
 * js/local_storage_manager.js L22. Frozen, unprefixed literal.
 */
export const BEST_SCORE_KEY = 'bestScore' as const;

/**
 * Key the board snapshot is persisted under.
 *
 * Ported verbatim from `gameStateKey`,
 * js/local_storage_manager.js L23. Frozen, unprefixed literal.
 */
export const GAME_STATE_KEY = 'gameState' as const;

/**
 * Prefix applied to every key introduced after the port of
 * js/local_storage_manager.js.
 */
export const STORAGE_NAMESPACE = 'roguelike2048' as const;

/**
 * Separator placed between `STORAGE_NAMESPACE` and an unqualified key
 * name. Module-private, and shared by both `namespacedKey()`'s output
 * and its validation.
 */
const NAMESPACE_DELIMITER = ':';

/**
 * Matches any whitespace character. Carries no global flag, and so no
 * `lastIndex` state between calls.
 */
const WHITESPACE_PATTERN = /\s/;

/**
 * Mints a namespaced storage key.
 *
 * This is the single place a namespaced key is constructed. Every new
 * key in the product is minted by calling this function; none is
 * written as a prefixed literal.
 *
 * A returned key therefore always splits into exactly one namespace
 * and one name.
 *
 * @param name Unqualified key name, for example `'runState'`. Must be
 *   a non-empty string containing neither whitespace nor the `':'`
 *   delimiter.
 * @returns `name` prefixed with `STORAGE_NAMESPACE` and the
 *   delimiter.
 * @throws {TypeError} If `name` is empty, contains whitespace, or
 *   contains the delimiter.
 *
 * @example
 * namespacedKey('runState'); // 'roguelike2048:runState'
 */
export function namespacedKey(name: string): string {
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
 * Key the versioned run-state envelope is persisted under.
 *
 * Consumed by src/run/run-state-store.ts.
 */
export const RUN_STATE_KEY = namespacedKey('runState');

/**
 * Key written and then immediately removed by the Web Storage
 * writability probe in src/storage/local-storage-manager.ts.
 *
 * Supersedes the unprefixed `testKey` at
 * js/local_storage_manager.js L30.
 */
export const STORAGE_PROBE_KEY = namespacedKey('probe');

/**
 * Every key the product persists and therefore owns, in declaration
 * order. Callers that clear the product's storage, notably test
 * teardown, iterate this list.
 *
 * `STORAGE_PROBE_KEY` is deliberately absent: the probe removes its
 * own key immediately.
 *
 * Frozen at runtime, so the shared list is not mutable.
 */
export const OWNED_STORAGE_KEYS: readonly string[] = Object.freeze([
  BEST_SCORE_KEY,
  GAME_STATE_KEY,
  RUN_STATE_KEY,
]);
