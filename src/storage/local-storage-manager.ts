/**
 * Web Storage persistence adapter.
 *
 * Decisions: DL-STORE-01, DL-STORE-02, DL-STORE-03, DL-STORE-04
 * (docs/DECISION_LOG.md).
 */

import {
  BEST_SCORE_KEY,
  GAME_STATE_KEY,
  STORAGE_PROBE_KEY,
  isOwnedStorageKey,
  type OwnedStorageKey,
} from './storage-keys';
import { MemoryStorage, type StorageLike } from './memory-storage';

export type { StorageLike } from './memory-storage';

/**
 * Which store a manager reads and writes. `'injected'` belongs to a store
 * supplied through `LocalStorageManagerOptions.storage` and is never returned
 * by `probeWebStorage`.
 */
export type StorageStrategy = 'localStorage' | 'memory' | 'injected';

/**
 * The storage operation a `StorageFailure` describes.
 *
 * Every member is emitted. A probe that fails with an error reports one
 * failure under `STORAGE_PROBE_KEY` in addition to the complete probe result;
 * a probe that finds no global store at all catches nothing and so reports no
 * failure.
 */
export type StorageOperation = 'probe' | 'read' | 'write' | 'remove';

const REJECTED_KEY_ERROR_NAME = 'StorageKeyError';

/**
 * Name reported for a read refused because the stored text is larger than the
 * key's declared ceiling.
 */
const OVERSIZE_ERROR_NAME = 'StorageSizeError';

/**
 * Longest rejected key text a report carries. A rejected key comes from outside
 * the module and is truncated to this many characters, with an ellipsis
 * appended, before it reaches a reporter.
 */
const MAX_REPORTED_KEY_LENGTH = 64;

/** A caught storage error reduced to serialisable fields. */
export interface StorageErrorInfo {
  readonly name: string;

  /**
   * A description of what failed, chosen from this module's own vocabulary by
   * `describeStorageError`. Bounded, and free of source-provided text and of
   * any excerpt of a stored value.
   */
  readonly message: string;

  /**
   * Whether the error reports exhausted storage rather than denied access:
   * `QuotaExceededError`, `NS_ERROR_DOM_QUOTA_REACHED`, or the legacy
   * exception code 22.
   */
  readonly quota: boolean;
}

/** The outcome of the writability probe. */
export interface StorageProbeResult {
  readonly supported: boolean;

  /** The store this outcome selects: Never `'injected'`. */
  readonly strategy: StorageStrategy;

  /**
   * The bounded, exportable description of the error that made the probe fail.
   * Absent when the probe succeeds, and absent when no global store exists at
   * all.
   */
  readonly error?: StorageErrorInfo;

  /** The value that was thrown, exactly as it was caught and unconverted. */
  readonly thrown?: unknown;
}

/** A single failed storage operation. */
export interface StorageFailure {
  readonly operation: StorageOperation;

  readonly key: string;

  readonly strategy: StorageStrategy;

  /** The bounded, exportable description of what failed. */
  readonly error: StorageErrorInfo;

  /**
   * The value that was thrown, exactly as it was caught and unconverted, on
   * the same terms as `StorageProbeResult.thrown`.
   *
   * Absent on a failure no value was thrown for — a key this product does not
   * own, which is refused before any store is touched and so throws nothing.
   */
  readonly thrown?: unknown;
}

/** A completed write attempt, successful or not. */
export interface StorageWriteInfo {
  readonly key: string;

  /**
   * The adapter's own estimate of the serialised size, at two bytes per UTF-16
   * code unit. What a browser charges against its quota is
   * implementation-defined and may differ.
   */
  readonly byteLength: number;

  readonly ok: boolean;
}

/**
 * Sink for probe results, failures and write attempts. Every member is
 * optional, so an adapter built without a reporter, or with a partial one,
 * reports only what the sink accepts.
 */
export interface StorageReporter {
  readonly onProbe?: (result: StorageProbeResult) => void;

  readonly onFailure?: (failure: StorageFailure) => void;

  readonly onWrite?: (info: StorageWriteInfo) => void;
}

/** Collaborators a `LocalStorageManager` accepts. */
export interface LocalStorageManagerOptions {
  /**
   * Store to use in place of the probed global one. Supplying it sets
   * `strategy` to `'injected'`.
   */
  readonly storage?: StorageLike;

  readonly reporter?: StorageReporter;
}

const PROBE_VALUE = '1';

const UNKNOWN_ERROR_NAME = 'StorageError';

const UNKNOWN_ERROR_MESSAGE = 'Unknown storage error.';

/** Public message for an operation that ran out of room. */
const QUOTA_ERROR_MESSAGE = 'Storage is full; the operation was refused.';

/**
 * Public message for an operation refused for a recognised reason other than
 * exhausted storage, which in practice is denied access.
 */
const DENIED_ERROR_MESSAGE = 'Storage refused the operation.';

const QUOTA_ERROR_NAMES: readonly string[] = Object.freeze([
  'QuotaExceededError',
  'NS_ERROR_DOM_QUOTA_REACHED',
]);

/** Every error name this module will put in a report. */
const REPORTABLE_ERROR_NAMES: readonly string[] = Object.freeze([
  ...QUOTA_ERROR_NAMES,
  'SecurityError',
  'InvalidStateError',
  'TypeError',
  REJECTED_KEY_ERROR_NAME,
  OVERSIZE_ERROR_NAME,
]);

const LEGACY_QUOTA_EXCEEDED_CODE = 22;

const BYTES_PER_UTF16_UNIT = 2;

/* --------------------------------------------------------------------------
 * Pre-parse size ceilings
 * ----------------------------------------------------------------------- */

/**
 * Largest stored text, in bytes, that `readJson()` will hand to `JSON.parse`
 * for a key this table names.
 *
 * WHY A PRE-PARSE GATE AT ALL. Web Storage is synchronous and shared by the
 * whole origin: anything running on this host can write megabytes under one of
 * the product's keys, and `JSON.parse` on that text blocks the main thread and
 * materialises the whole graph BEFORE any schema guard can look at it. A bound
 * applied after parsing is a bound applied too late, so the reading is taken off
 * the raw string and the parse never happens above it.
 *
 * The ceilings are generous against the real payloads — a full board serialises
 * to under 1 kB and a fully remapped keymap to a few — and are measured the way
 * `writeRaw` already accounts for a write, at two bytes per UTF-16 code unit, so
 * a value this adapter refuses to read is a value it would have refused to
 * write.
 *
 * Keyed by the unqualified spellings so no import from ./storage-keys beyond the
 * two frozen literals is needed; `DEFAULT_MAX_STORED_JSON_BYTES` covers every
 * other owned key, so a key minted later is bounded on the day it is minted
 * rather than on the day someone remembers to add it here.
 */
export const MAX_STORED_JSON_BYTES: Readonly<Record<string, number>> =
  Object.freeze({
    [GAME_STATE_KEY]: 65_536,
    'roguelike2048:runState': 131_072,
    'roguelike2048:keymap': 32_768,
  });

/** Ceiling applied to an owned key `MAX_STORED_JSON_BYTES` does not name. */
export const DEFAULT_MAX_STORED_JSON_BYTES = 65_536;

/**
 * The ceiling in force for a key.
 *
 * @param key Owned key about to be read.
 * @returns The key's declared ceiling, or the default.
 */
export function maxStoredJsonBytes(key: string): number {
  return MAX_STORED_JSON_BYTES[key] ?? DEFAULT_MAX_STORED_JSON_BYTES;
}

/**
 * Measures stored text the way Web Storage charges for it.
 *
 * @param text Stored text, before parsing.
 * @returns Size of `text` in bytes.
 */
function measureStoredBytes(text: string): number {
  return text.length * BYTES_PER_UTF16_UNIT;
}

/**
 * Describes a read refused for size as a `StorageErrorInfo`, without
 * constructing or throwing an error.
 *
 * The message carries the two measurements and no key and no excerpt of the
 * value, on the same terms as `describeRejectedKey()`: the key travels on
 * `StorageFailure.key`, and nothing a source outside the product wrote reaches
 * an exportable record.
 *
 * @param bytes Size of the stored text.
 * @param limit Ceiling it broke.
 * @returns The reportable description of the refusal.
 */
function describeOversizeRead(bytes: number, limit: number): StorageErrorInfo {
  return {
    name: OVERSIZE_ERROR_NAME,
    message:
      `The stored value is ${String(bytes)} bytes, above the ` +
      `${String(limit)}-byte ceiling for this key; the read was refused ` +
      'and nothing was parsed.',
    quota: false,
  };
}

/**
 * Describes a read the reading module's own payload limit refused.
 *
 * The adapter does not know that module's ceiling, so the description carries the
 * measurement it does know and names the limit's owner rather than inventing a
 * number. No key and no excerpt of the value is carried.
 *
 * @param bytes Size of the stored text.
 * @returns The reportable description of the refusal.
 */
function describeRefusedByCaller(bytes: number): StorageErrorInfo {
  return {
    name: OVERSIZE_ERROR_NAME,
    message:
      `The stored value is ${String(bytes)} bytes and was refused by the ` +
      'reading module\'s own payload limit; nothing was parsed.',
    quota: false,
  };
}

/**
 * Nodes one memoised parse result may be frozen through.
 *
 * The freeze is what lets several consumers share one parse safely, and it walks
 * the graph, so it is bounded rather than open-ended. A graph larger than this —
 * reachable only from a payload just under the byte ceiling — is handed back
 * partly frozen, which costs the sharing guarantee for that one value and
 * nothing else.
 */
const MAX_FROZEN_NODES = 50_000;

/**
 * Freezes a parsed JSON graph, iteratively and within a node budget.
 *
 * ITERATIVE ON PURPOSE. A recursive walk over deeply nested JSON — which a
 * hostile same-origin writer can produce inside the byte ceiling — overflows the
 * stack, so the pending nodes are held in an explicit list instead.
 *
 * @param root Parsed value to freeze.
 * @returns `root`, frozen as deeply as the budget allowed.
 */
function freezeParsed(root: unknown): unknown {
  const pending: unknown[] = [root];
  let visited = 0;

  while (pending.length > 0 && visited < MAX_FROZEN_NODES) {
    const node = pending.pop();

    if (typeof node !== 'object' || node === null || Object.isFrozen(node)) {
      continue;
    }

    visited += 1;
    Object.freeze(node);

    for (const value of Object.values(node)) {
      if (typeof value === 'object' && value !== null) {
        pending.push(value);
      }
    }
  }

  return root;
}

/** One key's most recent parse, held so the same text is parsed once. */
interface ParsedEntry {
  /** The exact stored text the result was parsed from. */
  readonly raw: string;

  /** The frozen parse result. */
  readonly parsed: unknown;
}

const EMPTY_REPORTER: StorageReporter = Object.freeze({});

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

function readGlobalStorage(): StorageLike | undefined {
  const candidate: unknown = globalThis.localStorage;

  return isStorageLike(candidate) ? candidate : undefined;
}

/**
 * Reads one string property off a caught value without trusting the value.
 *
 * @param error Caught value to read from.
 * @param field Property name to read.
 * @returns The non-empty string value, or `undefined`.
 */
function readErrorText(error: unknown, field: string): string | undefined {
  if (typeof error !== 'object' && typeof error !== 'function') {
    return undefined;
  }

  if (error === null) {
    return undefined;
  }

  let candidate: unknown;

  try {
    if (!(field in error)) {
      return undefined;
    }

    candidate = Reflect.get(error, field);
  } catch {
    return undefined;
  }

  return typeof candidate === 'string' && candidate.length > 0
    ? candidate
    : undefined;
}

/**
 * Reduces a caught value's `name` to one this module recognises.
 *
 * @param error Caught value to classify.
 * @returns A recognised name, or `UNKNOWN_ERROR_NAME`.
 */
function errorName(error: unknown): string {
  const carried = readErrorText(error, 'name');

  if (carried === undefined) {
    return UNKNOWN_ERROR_NAME;
  }

  return REPORTABLE_ERROR_NAMES.includes(carried)
    ? carried
    : UNKNOWN_ERROR_NAME;
}

/**
 * Chooses the public message for a caught value.
 *
 * @param name The allowlisted name.
 * @param quota Whether the error reports exhausted storage.
 * @returns One of this module's own descriptions.
 */
function errorMessage(name: string, quota: boolean): string {
  if (quota) {
    return QUOTA_ERROR_MESSAGE;
  }

  return name === UNKNOWN_ERROR_NAME
    ? UNKNOWN_ERROR_MESSAGE
    : DENIED_ERROR_MESSAGE;
}

function isQuotaError(error: unknown, name: string): boolean {
  if (QUOTA_ERROR_NAMES.includes(name)) {
    return true;
  }

  if (typeof DOMException === 'undefined') {
    return false;
  }

  if (!(error instanceof DOMException)) {
    return false;
  }

  try {
    return error.code === LEGACY_QUOTA_EXCEEDED_CODE;
  } catch {
    return false;
  }
}

/**
 * Reduces any thrown value, error or not, to the bounded public
 * `StorageErrorInfo`.
 *
 * @param error Caught value, of any type.
 * @returns The exportable description.
 */
function describeStorageError(error: unknown): StorageErrorInfo {
  const name = errorName(error);
  const quota = isQuotaError(error, readErrorText(error, 'name') ?? name);

  return {
    name,
    message: errorMessage(name, quota),
    quota,
  };
}

/**
 * Shortens a key for reporting. Applied to a rejected key, whose length and
 * content come from outside the module.
 *
 * @param key Key to shorten.
 * @returns `key` when it is within the reporting limit, otherwise its first
 *   `MAX_REPORTED_KEY_LENGTH` characters followed by an ellipsis.
 */
function truncateKey(key: string): string {
  return key.length <= MAX_REPORTED_KEY_LENGTH
    ? key
    : `${key.slice(0, MAX_REPORTED_KEY_LENGTH)}…`;
}

/**
 * Describes a refused operation as a `StorageErrorInfo`, without constructing
 * or throwing an error.
 *
 * @returns The reportable description of the refusal.
 */
function describeRejectedKey(): StorageErrorInfo {
  return {
    name: REJECTED_KEY_ERROR_NAME,
    message:
      'The key is not owned by this product; the operation was refused ' +
      'and no storage was touched.',
    quota: false,
  };
}

/**
 * Probes Web Storage writability: the global store is read inside the `try`,
 * because the property access itself throws where storage is blocked, then a
 * probe key is written and immediately removed. Callable without constructing
 * a manager, which also runs it once at construction.
 *
 * @returns `{ supported: true, strategy: 'localStorage' }` when both the
 *   write and the removal succeed.
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

      thrown: error,
    };
  }
}

/**
 * Reads and writes the product's persisted state.
 *
 * Construction runs the writability probe once and fixes the store for the
 * session, in that order, and performs no read of its own; constructing with
 * no arguments is supported.
 *
 * Every key is checked against `isOwnedStorageKey` before the store is
 * touched, so the two frozen legacy keys and the product's namespaced keys are
 * the only keys this adapter can reach. A refused operation reports and
 * returns its failure value, and touches no storage.
 */
export class LocalStorageManager {
  /** The construction-time probe result. */
  readonly probe: StorageProbeResult;

  /**
   * The store actually in use. Equals `probe.strategy` unless a store was
   * injected, in which case it is `'injected'`.
   */
  readonly strategy: StorageStrategy;

  private readonly storage: StorageLike;

  private readonly reporter: StorageReporter;

  /**
   * The most recent parse of each key, held so one stored text is parsed once.
   *
   * A `Map`, for the reason `DL-STORE-06` gives the in-memory double: keys reach
   * this adapter from persisted and parsed data, and a plain object would read
   * back a prototype member for `constructor` or `__proto__` as though it had
   * been stored. The entry records the exact text it was parsed from, so the
   * memo is consulted only when the stored text has not changed.
   */
  private readonly parsed = new Map<string, ParsedEntry>();

  /** Reporter callbacks that threw and were contained. */
  private faultCount = 0;

  /** Description of the most recent contained reporter throw. */
  private faultInfo: StorageErrorInfo | undefined = undefined;

  /**
   * How many reporter callbacks have thrown and been contained.
   *
   * `0` for a reporter that never throws, which is every reporter that
   * behaves. A non-zero count means instrumentation is failing while
   * persistence is not: the storage operations themselves returned their true
   * results.
   */
  get reporterFaults(): number {
    return this.faultCount;
  }

  /**
   * The most recent contained reporter throw, or `undefined` when no reporter
   * callback has thrown.
   *
   * Reduced to the same serialisable shape as a storage error, so the fault is
   * inspectable — by a diagnostics surface, or by a caller checking
   * `reporterFaults` — without being re-delivered to the sink that raised it.
   */
  get lastReporterFault(): StorageErrorInfo | undefined {
    return this.faultInfo;
  }

  /**
   * @param options Optional store and reporter. Omitting both probes for the
   *   global store and falls back to `MemoryStorage`.
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

    this.reportProbe();
  }

  /**
   * Number of reporter invocations this manager contained because the reporter
   * threw, under the name a diagnostics surface reads it by. `0` for a
   * reporter that never throws; a non-zero value means reports have been lost
   * and the sink is faulty.
   */
  get reporterFailures(): number {
    return this.faultCount;
  }

  /**
   * Reads the persisted best score. Frozen contract: the raw stored string
   * when a value is present, and the number `0` when it is absent or empty.
   *
   * @returns The stored string, or the number `0`.
   */
  getBestScore(): string | 0 {
    return this.readRaw(BEST_SCORE_KEY) || 0;
  }

  /**
   * Persists `score` as the best score, written as `String(score)`.
   *
   * @param score Score to persist.
   * @returns `true` when the write succeeded.
   */
  setBestScore(score: number): boolean {
    return this.writeRaw(BEST_SCORE_KEY, String(score));
  }

  /**
   * Reads the persisted board snapshot. The result is `unknown`: shape
   * validation, schema versioning and migration belong to the caller.
   *
   * @returns The parsed snapshot, or `null` when it is absent or its stored
   *   text is not valid JSON.
   */
  getGameState(): unknown {
    return this.readJson(GAME_STATE_KEY);
  }

  /**
   * Persists `state` as the board snapshot.
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
   * @returns `true` when the removal succeeded.
   */
  clearGameState(): boolean {
    return this.removeRaw(GAME_STATE_KEY);
  }

  /**
   * Reads the raw string stored under `key`.
   *
   * @param key Key to read. A key the product does not own is refused,
   *   reported, and reaches no store.
   * @returns The stored string, or `null` when the key is absent, the read
   *   threw, or the key was refused. The `undefined` an in-memory store yields
   *   for an absent key is normalised to `null`; a stored empty string is
   *   returned as `''`.
   */
  readRaw(key: OwnedStorageKey): string | null {
    if (!this.acceptKey('read', key)) {
      return null;
    }

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
   * @param key Key to write. A key the product does not own is refused,
   *   reported, and reaches no store.
   * @param value Value to store.
   * @returns `true` when the write succeeded.
   */
  writeRaw(key: OwnedStorageKey, value: string): boolean {
    if (!this.acceptKey('write', key)) {
      return false;
    }

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
   * Removes `key`. Removing a key that was never written succeeds.
   *
   * @param key Key to remove. A key the product does not own is refused,
   *   reported, and reaches no store.
   * @returns `true` when the removal succeeded.
   */
  removeRaw(key: OwnedStorageKey): boolean {
    if (!this.acceptKey('remove', key)) {
      return false;
    }

    try {
      this.storage.removeItem(key);
    } catch (error) {
      this.reportFailure('remove', key, error);

      return false;
    }

    return true;
  }

  /**
   * Reads and parses the JSON stored under `key`, bounding and then guarding the
   * parse.
   *
   * THE SIZE GATE RUNS BEFORE THE PARSE. Web Storage is synchronous and shared by
   * the whole origin, so a value written by anything on this host is untrusted
   * text of unbounded length; `maxStoredJsonBytes(key)` is measured against the
   * raw string and an oversized value is reported and refused with nothing
   * parsed. A schema guard applied to the result cannot do this, because by then
   * the parse has already run. Decision DL-STORE-07.
   *
   * THE PARSE IS MEMOISED per key on the exact stored text, so a text several
   * consumers read is parsed once. That is what makes the run-state envelope one
   * parse per boot even though the identity resolution, the relic pre-read and
   * the authoritative load each ask for it. The raw string is re-read every call,
   * so a value changed by another tab is never served stale. The memoised graph
   * is frozen, so one consumer cannot influence another through it — every
   * consumer of an `unknown` here validates and copies, which is the contract
   * the return type already states.
   *
   * @param key Key to read. A key the product does not own is refused by
   *   `readRaw`, reported, and reaches no store.
   * @param acceptText An additional bound on the raw text, applied after the
   *   key's own ceiling and before the parse. A caller that declares its own
   *   payload limit passes the predicate that measures it — the keymap layer's
   *   `isKeymapPayloadWithinLimit` is the one such caller — so the tighter of the
   *   two limits governs.
   * @returns The parsed value, or `null` when the key is absent, holds
   *   an empty string, holds text above a ceiling, holds text that is not valid
   *   JSON, or was refused.
   */
  readJson(
    key: OwnedStorageKey,
    acceptText?: (text: string) => boolean
  ): unknown {
    const raw = this.readRaw(key);

    if (raw === null || raw.length === 0) {
      return null;
    }

    const bytes = measureStoredBytes(raw);
    const limit = maxStoredJsonBytes(key);

    if (bytes > limit) {
      this.refuseRead(key, describeOversizeRead(bytes, limit));

      return null;
    }

    if (acceptText !== undefined && !acceptText(raw)) {
      this.refuseRead(key, describeRefusedByCaller(bytes));

      return null;
    }

    const memo = this.parsed.get(key);

    if (memo !== undefined && memo.raw === raw) {
      return memo.parsed;
    }

    try {
      const parsed: unknown = freezeParsed(JSON.parse(raw));

      this.parsed.set(key, { raw, parsed });

      return parsed;
    } catch (error) {
      this.parsed.delete(key);
      this.reportFailure('read', key, error);

      return null;
    }
  }

  /**
   * Serialises `value` and writes it under `key`.
   *
   * @param key Key to write. A key the product does not own is refused,
   *   reported, and reaches no store; nothing is serialised for it.
   * @param value Value to serialise.
   * @returns `true` when both the serialisation and the write succeeded.
   *   Values that serialise to no JSON text, such as `undefined`, a function
   *   or a symbol, are reported as failures.
   */
  writeJson(key: OwnedStorageKey, value: unknown): boolean {
    if (!this.acceptKey('write', key)) {
      return false;
    }

    const json = this.serialiseJson(key, value);

    if (json === null) {
      return false;
    }

    return this.writeRaw(key, json);
  }

  /**
   * Reports a read refused before the parse, and drops any memo for the key.
   *
   * A refusal is not a failure of the store — nothing was touched beyond the
   * `getItem` that measured the value — so it is delivered on the failure
   * channel with a description and no `thrown`, exactly as a refused key is.
   *
   * @param key Key whose stored text was refused.
   * @param error This module's own description of the refusal.
   */
  private refuseRead(key: OwnedStorageKey, error: StorageErrorInfo): void {
    this.parsed.delete(key);
    this.deliverFailure({
      operation: 'read',
      key,
      strategy: this.strategy,
      error,
    });
  }

  /**
   * Decides whether an operation may proceed with `key`, reporting a refusal.
   *
   * @param operation Operation being attempted.
   * @param key Key it targets.
   * @returns `true` when the key is owned and the operation may run.
   */
  private acceptKey(operation: StorageOperation, key: string): boolean {
    if (isOwnedStorageKey(key)) {
      return true;
    }

    // No value was thrown: the refusal happens before any store is touched, so
    // the failure carries a description and no `thrown`.
    this.deliverFailure({
      operation,
      key: truncateKey(key),
      strategy: this.strategy,
      error: describeRejectedKey(),
    });

    return false;
  }

  /**
   * Serialises `value`, reporting and returning `null` on failure — circular
   * structures and `BigInt` throw, and `undefined`, functions and symbols
   * yield no JSON text.
   *
   * @param key Key the value was destined for, for reporting.
   * @param value Value to serialise.
   * @returns The JSON text, or `null` when it could not be produced.
   */
  private serialiseJson(
    key: OwnedStorageKey,
    value: unknown
  ): string | null {
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
   * Runs one reporter callback inside a no-throw boundary.
   *
   * @param deliver Reporter callback to run.
   * @param payload Report to hand it.
   */
  private contain<T>(deliver: (payload: T) => void, payload: T): void {
    try {
      deliver(payload);
    } catch (error) {
      this.faultCount += 1;
      this.faultInfo = describeStorageError(error);
    }
  }

  /**
   * Hands the construction-time probe result to the reporter, and a failed
   * probe to the failure sink as well.
   *
   * Runs once, at the end of construction, after the strategy is fixed — the
   * strategy the failure carries is therefore the store the manager actually
   * went on to use.
   */
  private reportProbe(): void {
    const onProbe = this.reporter.onProbe;

    if (onProbe !== undefined) {
      this.contain(onProbe, this.probe);
    }

    const error = this.probe.error;

    if (this.probe.supported || error === undefined) {
      return;
    }

    this.deliverFailure({
      operation: 'probe',
      key: STORAGE_PROBE_KEY,
      strategy: this.strategy,
      error,
      thrown: this.probe.thrown,
    });
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
    if (this.reporter.onFailure === undefined) {
      return;
    }

    this.deliverFailure({
      operation,
      key,
      strategy: this.strategy,
      error: describeStorageError(error),

      // The caught value travels unconverted, so the stack, the cause chain
      // and a non-`Error` structure all survive to the logger.
      thrown: error,
    });
  }

  /**
   * Delivers one already-described failure to the reporter, when one accepts
   * it.
   *
   * The single delivery point for `StorageFailure`: the read, write and
   * removal paths reach it through `reportFailure`, and the probe path reaches
   * it directly with the error the probe already reduced.
   *
   * @param failure Failure to deliver.
   */
  private deliverFailure(failure: StorageFailure): void {
    const onFailure = this.reporter.onFailure;

    if (onFailure === undefined) {
      return;
    }

    this.contain(onFailure, failure);
  }

  private reportWrite(
    key: string,
    byteLength: number,
    ok: boolean
  ): void {
    const onWrite = this.reporter.onWrite;

    if (onWrite === undefined) {
      return;
    }

    this.contain(onWrite, { key, byteLength, ok });
  }
}
