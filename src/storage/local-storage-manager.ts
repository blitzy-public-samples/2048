/**
 * Web Storage persistence adapter.
 *
 * Ported from js/local_storage_manager.js L21-L63. Source construct to
 * target, in source order:
 *
 * - `LocalStorageManager` (L21-L27) -> class `LocalStorageManager`
 * - the `storage` strategy field (L26) -> the private `storage` field,
 *   with the selected store named by the public `strategy` field
 * - `localStorageSupported` (L29-L40) -> `probeWebStorage()`, whose
 *   result is also held on the instance as `probe`; the error value
 *   the catch at L37-L39 discarded becomes `StorageErrorInfo`
 * - `getBestScore` (L43-L45) -> `getBestScore()`
 * - `setBestScore` (L47-L49) -> `setBestScore()`
 * - `getGameState` (L52-L55) -> `getGameState()`
 * - `setGameState` (L57-L59) -> `setGameState()`
 * - `clearGameState` (L61-L63) -> `clearGameState()`
 *
 * The `bestScoreKey` (L22) and `gameStateKey` (L23) literals live in
 * ./storage-keys; the in-memory fallback store of L1-L19 lives in
 * ./memory-storage.
 *
 * Test hygiene, mandatory for any suite that touches this adapter:
 * delete the best-score key in teardown — nothing in the application
 * ever deletes it, and a surviving value carries the highest score
 * into every later test; and seed the best-score key BEFORE
 * constructing a manager — the probe and the first legacy read both
 * happen at construction. `OWNED_STORAGE_KEYS` in ./storage-keys lists
 * every key such a teardown removes.
 *
 * Rationale for the decisions behind this file, including the
 * preserved `string | 0` return of `getBestScore()`, is recorded in
 * docs/DECISION_LOG.md.
 */

import {
  BEST_SCORE_KEY,
  GAME_STATE_KEY,
  STORAGE_PROBE_KEY,
} from './storage-keys';
import { MemoryStorage, type StorageLike } from './memory-storage';

export type { StorageLike } from './memory-storage';

/**
 * Which store a manager reads and writes.
 *
 * `'localStorage'` and `'memory'` are the two outcomes of the strategy
 * selection ported from L26. `'injected'` belongs to a store supplied
 * through `LocalStorageManagerOptions.storage` and is never returned
 * by `probeWebStorage()`.
 */
export type StorageStrategy = 'localStorage' | 'memory' | 'injected';

/** The storage operation a `StorageFailure` describes. */
export type StorageOperation = 'probe' | 'read' | 'write' | 'remove';

/**
 * A caught storage error reduced to serialisable fields, superseding
 * the error value the catch at L37-L39 discarded.
 */
export interface StorageErrorInfo {
  /** The error's `name`, or `'StorageError'` when it carries none. */
  readonly name: string;

  /**
   * The error's `message`, or a printable form of the thrown value
   * when it carries none.
   */
  readonly message: string;

  /**
   * Whether the error reports exhausted storage rather than denied
   * access: `QuotaExceededError`, `NS_ERROR_DOM_QUOTA_REACHED`, or the
   * legacy exception code 22.
   */
  readonly quota: boolean;
}

/** The outcome of the writability probe ported from L29-L40. */
export interface StorageProbeResult {
  /** Whether the probe wrote and removed its key successfully. */
  readonly supported: boolean;

  /**
   * The store this outcome selects: `'localStorage'` when supported,
   * `'memory'` otherwise. Never `'injected'`.
   */
  readonly strategy: StorageStrategy;

  /**
   * The error that made the probe fail. Absent when the probe
   * succeeds, and absent when no global store exists at all.
   */
  readonly error?: StorageErrorInfo;
}

/** A single failed storage operation. */
export interface StorageFailure {
  /** Which operation failed. */
  readonly operation: StorageOperation;

  /** The key the operation targeted. */
  readonly key: string;

  /** The store in use when it failed. */
  readonly strategy: StorageStrategy;

  /** The caught error. */
  readonly error: StorageErrorInfo;
}

/** A completed write attempt, successful or not. */
export interface StorageWriteInfo {
  /** The key written. */
  readonly key: string;

  /**
   * The value's size in bytes as Web Storage charges it: two per
   * UTF-16 code unit. `0` when serialisation failed before any value
   * existed.
   */
  readonly byteLength: number;

  /** Whether the write succeeded. */
  readonly ok: boolean;
}

/**
 * Sink for probe results, failures and write attempts. Every member is
 * optional, so an adapter built without a reporter, or with a partial
 * one, reports only what the sink accepts.
 */
export interface StorageReporter {
  /** Receives the construction-time probe result. */
  readonly onProbe?: (result: StorageProbeResult) => void;

  /** Receives every failed probe, read, write and removal. */
  readonly onFailure?: (failure: StorageFailure) => void;

  /** Receives every write attempt, successful or not. */
  readonly onWrite?: (info: StorageWriteInfo) => void;
}

/** Collaborators a `LocalStorageManager` accepts. */
export interface LocalStorageManagerOptions {
  /**
   * Store to use in place of the probed global one. Supplying it sets
   * `strategy` to `'injected'`.
   */
  readonly storage?: StorageLike;

  /** Sink for probe, failure and write reports. */
  readonly reporter?: StorageReporter;
}

/** Value the probe writes before removing it. Ported from L34. */
const PROBE_VALUE = '1';

/** Name reported when a caught value carries none. */
const UNKNOWN_ERROR_NAME = 'StorageError';

/** Message reported when a caught object carries none. */
const UNKNOWN_ERROR_MESSAGE = 'Unknown storage error.';

/** Error names browsers use to report exhausted storage. */
const QUOTA_ERROR_NAMES: readonly string[] = Object.freeze([
  'QuotaExceededError',
  'NS_ERROR_DOM_QUOTA_REACHED',
]);

/** Legacy exception code for exhausted storage. */
const LEGACY_QUOTA_EXCEEDED_CODE = 22;

/** Bytes Web Storage charges per UTF-16 code unit. */
const BYTES_PER_UTF16_UNIT = 2;

/** Reporter used when the caller supplies none. */
const EMPTY_REPORTER: StorageReporter = Object.freeze({});

/**
 * Narrows a value to `StorageLike` by probing for the four operations
 * that interface declares. Applied to the global store, which the type
 * system declares as always present although it is absent outside a
 * browser.
 *
 * @param value Value to test.
 * @returns Whether `value` carries all four storage operations.
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
 * Reads the global Web Storage instance.
 *
 * Ported from the strategy selection at L26, which is reached only
 * after the probe has already proved the access works.
 *
 * @returns The global store, or `undefined` where it is absent or does
 *   not carry the storage operations.
 */
function readGlobalStorage(): StorageLike | undefined {
  const candidate: unknown = globalThis.localStorage;

  return isStorageLike(candidate) ? candidate : undefined;
}

/**
 * Reads a caught value's `name`.
 *
 * @param error Caught value, of any type.
 * @returns The reported name, or `'StorageError'`.
 */
function errorName(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) {
    return error.name;
  }

  if (typeof error === 'object' && error !== null && 'name' in error) {
    const candidate: unknown = error.name;

    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }

  return UNKNOWN_ERROR_NAME;
}

/**
 * Reads a caught value's `message`.
 *
 * @param error Caught value, of any type.
 * @returns The reported message, the printed form of a thrown
 *   primitive, or `'Unknown storage error.'`.
 */
function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  if (typeof error === 'object' && error !== null && 'message' in error) {
    const candidate: unknown = error.message;

    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }

  if (typeof error === 'object' || typeof error === 'function') {
    return UNKNOWN_ERROR_MESSAGE;
  }

  return String(error);
}

/**
 * Whether a caught value reports exhausted storage. Checks the error
 * names browsers use, then the legacy exception code, which is read
 * only where the exception constructor exists.
 *
 * @param error Caught value, of any type.
 * @param name The name already read from `error`.
 * @returns Whether the value reports exhausted storage.
 */
function isQuotaError(error: unknown, name: string): boolean {
  if (QUOTA_ERROR_NAMES.includes(name)) {
    return true;
  }

  if (typeof DOMException === 'undefined') {
    return false;
  }

  return (
    error instanceof DOMException &&
    error.code === LEGACY_QUOTA_EXCEEDED_CODE
  );
}

/**
 * Reduces a caught value to `StorageErrorInfo`. Total: it accepts any
 * thrown value, including values that are not errors, and never
 * throws.
 *
 * @param error Caught value, of any type.
 * @returns The reportable description of `error`.
 */
function describeStorageError(error: unknown): StorageErrorInfo {
  const name = errorName(error);

  return {
    name,
    message: errorMessage(error),
    quota: isQuotaError(error, name),
  };
}

/**
 * Probes Web Storage writability.
 *
 * Ported from `localStorageSupported`, L29-L40: the global store is
 * read inside the `try`, as L33 does — the property access itself
 * throws where storage is blocked; a probe key is written (L34) and
 * immediately removed (L35); success is reported (L36). Where L37-L39
 * discarded the caught error, this returns it.
 *
 * Callable without constructing a manager. A manager runs this same
 * probe at construction and holds its result as `probe`.
 *
 * @returns `{ supported: true, strategy: 'localStorage' }` when both
 *   the write and the removal succeed. Otherwise `supported` is
 *   `false` with `strategy` `'memory'`, carrying `error` only when
 *   something threw; a global store that is absent altogether, as
 *   outside a browser, yields no error.
 *
 * @example
 * const result = probeWebStorage();
 * if (!result.supported && result.error !== undefined) {
 *   result.error.quota; // true when storage is full, not blocked
 * }
 */
export function probeWebStorage(): StorageProbeResult {
  try {
    const candidate: unknown = globalThis.localStorage;

    if (!isStorageLike(candidate)) {
      return { supported: false, strategy: 'memory' };
    }

    candidate.setItem(STORAGE_PROBE_KEY, PROBE_VALUE);
    candidate.removeItem(STORAGE_PROBE_KEY);

    return { supported: true, strategy: 'localStorage' };
  } catch (error) {
    return {
      supported: false,
      strategy: 'memory',
      error: describeStorageError(error),
    };
  }
}

/**
 * Reads and writes the product's persisted state.
 *
 * Ported from `LocalStorageManager`, L21-L27: construction runs the
 * writability probe once and fixes the store for the session, in that
 * order, exactly as L25-L26 do. Constructing with no arguments is
 * supported: the vanilla composition root injected this constructor
 * rather than an instance (js/application.js L3), and
 * js/game_manager.js L4 constructed it with none.
 *
 * Every read, write and removal is guarded: setters report and return
 * `false` rather than throwing, and reads fall back to `null`.
 *
 * @example
 * const storage = new LocalStorageManager();
 * storage.setBestScore(13892);
 * storage.getBestScore(); // '13892'
 *
 * @example
 * const storage = new LocalStorageManager({
 *   storage: new MemoryStorage(),
 *   reporter: { onFailure: (failure) => report(failure) },
 * });
 * storage.strategy; // 'injected'
 */
export class LocalStorageManager {
  /** The construction-time probe result. */
  readonly probe: StorageProbeResult;

  /**
   * The store actually in use. Equals `probe.strategy` unless a store
   * was injected, in which case it is `'injected'`.
   */
  readonly strategy: StorageStrategy;

  /** The selected store. Ported from the `storage` field at L26. */
  private readonly storage: StorageLike;

  /** Sink for probe, failure and write reports. */
  private readonly reporter: StorageReporter;

  /**
   * @param options Optional store and reporter. Omitting both probes
   *   for the global store and falls back to `MemoryStorage`, which is
   *   what L25-L26 did.
   */
  constructor(options: LocalStorageManagerOptions = {}) {
    this.reporter = options.reporter ?? EMPTY_REPORTER;
    this.probe = probeWebStorage();

    const injected = options.storage;

    if (injected !== undefined) {
      this.storage = injected;
      this.strategy = 'injected';
    } else {
      const webStorage = this.probe.supported
        ? readGlobalStorage()
        : undefined;

      if (webStorage === undefined) {
        this.storage = new MemoryStorage();
        this.strategy = 'memory';
      } else {
        this.storage = webStorage;
        this.strategy = 'localStorage';
      }
    }

    this.reporter.onProbe?.(this.probe);
  }

  /**
   * Reads the persisted best score.
   *
   * Ported from L43-L45, preserving L44 exactly: the raw stored string
   * when a value is present, and the number `0` when it is absent or
   * empty. Storage is read on every call, never cached; the vanilla
   * actuation payload re-read this value immediately after writing it
   * (js/game_manager.js L95).
   *
   * The record of this return type is in docs/DECISION_LOG.md.
   *
   * @returns The stored string, or the number `0`.
   */
  getBestScore(): string | 0 {
    return this.readRaw(BEST_SCORE_KEY) || 0;
  }

  /**
   * Persists `score` as the best score.
   *
   * Ported from L47-L49, where L48 passed the number itself and relied
   * on implicit coercion; the value is written as `String(score)`.
   *
   * @param score Score to persist.
   * @returns `true` when the write succeeded.
   */
  setBestScore(score: number): boolean {
    return this.writeRaw(BEST_SCORE_KEY, String(score));
  }

  /**
   * Reads the persisted board snapshot.
   *
   * Ported from L52-L55, keeping L53's falsy check on the raw value
   * and guarding L54's parse. The result is `unknown`: shape
   * validation, schema versioning and migration belong to the caller.
   *
   * @returns The parsed snapshot, or `null` when it is absent or its
   *   stored text is not valid JSON.
   */
  getGameState(): unknown {
    return this.readJson(GAME_STATE_KEY);
  }

  /**
   * Persists `state` as the board snapshot.
   *
   * Ported from L57-L59.
   *
   * @param state Snapshot to persist.
   * @returns `true` when the write succeeded.
   */
  setGameState(state: unknown): boolean {
    return this.writeJson(GAME_STATE_KEY, state);
  }

  /**
   * Removes the persisted board snapshot.
   *
   * Ported from L61-L63. Which of this and `setGameState` runs on a
   * given turn stays with the caller (js/game_manager.js L85-L89).
   *
   * @returns `true` when the removal succeeded.
   */
  clearGameState(): boolean {
    return this.removeRaw(GAME_STATE_KEY);
  }

  /**
   * Reads the raw string stored under `key`.
   *
   * @param key Key to read.
   * @returns The stored string, or `null` when the key is absent or
   *   the read threw. The `undefined` an in-memory store yields for an
   *   absent key is normalised to `null`; a stored empty string is
   *   returned as `''`.
   */
  readRaw(key: string): string | null {
    try {
      return this.storage.getItem(key) ?? null;
    } catch (error) {
      this.reportFailure('read', key, error);

      return null;
    }
  }

  /**
   * Writes `value` under `key`.
   *
   * Supersedes the unguarded writes at L48 and L58: a failure,
   * exhausted quota included, is reported and returned rather than
   * thrown.
   *
   * @param key Key to write.
   * @param value Value to store.
   * @returns `true` when the write succeeded.
   */
  writeRaw(key: string, value: string): boolean {
    const byteLength = value.length * BYTES_PER_UTF16_UNIT;

    try {
      this.storage.setItem(key, value);
    } catch (error) {
      this.reportFailure('write', key, error);
      this.reportWrite(key, byteLength, false);

      return false;
    }

    this.reportWrite(key, byteLength, true);

    return true;
  }

  /**
   * Removes `key`.
   *
   * Supersedes the unguarded removal at L62. Removing a key that was
   * never written succeeds.
   *
   * @param key Key to remove.
   * @returns `true` when the removal succeeded.
   */
  removeRaw(key: string): boolean {
    try {
      this.storage.removeItem(key);
    } catch (error) {
      this.reportFailure('remove', key, error);

      return false;
    }

    return true;
  }

  /**
   * Reads and parses the JSON stored under `key`.
   *
   * Guards the bare parse of L54, which threw during startup on a
   * corrupted value.
   *
   * @param key Key to read.
   * @returns The parsed value, or `null` when the key is absent, holds
   *   an empty string, or holds text that is not valid JSON.
   */
  readJson(key: string): unknown {
    const raw = this.readRaw(key);

    if (raw === null || raw.length === 0) {
      return null;
    }

    try {
      const parsed: unknown = JSON.parse(raw);

      return parsed;
    } catch (error) {
      this.reportFailure('read', key, error);

      return null;
    }
  }

  /**
   * Serialises `value` and writes it under `key`.
   *
   * @param key Key to write.
   * @param value Value to serialise.
   * @returns `true` when both the serialisation and the write
   *   succeeded. Values that serialise to no JSON text, such as
   *   `undefined`, a function or a symbol, are reported as failures.
   */
  writeJson(key: string, value: unknown): boolean {
    const json = this.serialiseJson(key, value);

    if (json === null) {
      return false;
    }

    return this.writeRaw(key, json);
  }

  /**
   * Serialises `value`, reporting and returning `null` on failure.
   *
   * Wraps the serialisation at L58, which throws on circular
   * structures and on `BigInt`, and yields no string for `undefined`,
   * functions and symbols.
   *
   * @param key Key the value was destined for, for reporting.
   * @param value Value to serialise.
   * @returns The JSON text, or `null` when it could not be produced.
   */
  private serialiseJson(key: string, value: unknown): string | null {
    try {
      const json = JSON.stringify(value);

      if (typeof json !== 'string') {
        const error = new TypeError('Value serialised to no JSON text.');

        this.reportFailure('write', key, error);
        this.reportWrite(key, 0, false);

        return null;
      }

      return json;
    } catch (error) {
      this.reportFailure('write', key, error);
      this.reportWrite(key, 0, false);

      return null;
    }
  }

  /**
   * Hands a failed operation to the reporter, when one accepts it.
   *
   * @param operation Operation that failed.
   * @param key Key it targeted.
   * @param error Caught value, of any type.
   */
  private reportFailure(
    operation: StorageOperation,
    key: string,
    error: unknown
  ): void {
    const onFailure = this.reporter.onFailure;

    if (onFailure === undefined) {
      return;
    }

    onFailure({
      operation,
      key,
      strategy: this.strategy,
      error: describeStorageError(error),
    });
  }

  /**
   * Hands a completed write attempt to the reporter, when one accepts
   * it.
   *
   * @param key Key that was written.
   * @param byteLength Size of the value in bytes, or `0` when no value
   *   was produced.
   * @param ok Whether the write succeeded.
   */
  private reportWrite(
    key: string,
    byteLength: number,
    ok: boolean
  ): void {
    const onWrite = this.reporter.onWrite;

    if (onWrite === undefined) {
      return;
    }

    onWrite({ key, byteLength, ok });
  }
}

