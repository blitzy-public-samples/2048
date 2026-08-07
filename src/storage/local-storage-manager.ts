/**
 * Web Storage persistence adapter.
 *
 * Construction runs the writability probe once and fixes the store for the
 * session; it performs no read. Every read, write and removal is guarded, so no
 * member throws on a storage failure, and `getBestScore()` keeps the frozen
 * `string | 0` contract. The two unprefixed legacy keys live in
 * ./storage-keys, and the in-memory fallback store in ./memory-storage.
 *
 * Ported from js/local_storage_manager.js, which is deleted. Each row is one
 * traceability row of docs/TRACEABILITY_MATRIX.md:
 *   TR-STORE-01  L22-L23  the two unprefixed key literals
 *   TR-STORE-02  L25-L26  the construction-time strategy selection
 *   TR-STORE-03  L29-L40  the writability probe
 *   TR-STORE-04  L43-L45  getBestScore(), the frozen `string | 0` contract
 *   TR-STORE-05  L47-L49  setBestScore()
 *   TR-STORE-06  L52-L55  getGameState(), whose unguarded `JSON.parse` is now
 *                         guarded
 *   TR-STORE-07  L57-L59  setGameState()
 *   TR-STORE-08  L61-L63  clearGameState()
 *
 * Decisions behind this file: DL-STORE-02, the best-score accessor keeping
 * the raw stored string so the relational promotion comparison of
 * js/game_manager.js L80-L82 behaves identically; DL-STORE-03, every
 * operation reporting failure by return value through an injected sink; and
 * DL-STORE-04, the probe running once at construction as L25-L26 did. All
 * three are in docs/DECISION_LOG.md, alongside DL-STORE-01 for the
 * key-minting validation.
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
 * by `probeWebStorage()`.
 */
export type StorageStrategy = 'localStorage' | 'memory' | 'injected';

/**
 * The storage operation a `StorageFailure` describes.
 *
 * Every member is emitted. A probe that fails with an error reports one
 * failure under `STORAGE_PROBE_KEY` in addition to the complete probe
 * result; a probe that finds no global store at all catches nothing and
 * so reports no failure.
 */
export type StorageOperation = 'probe' | 'read' | 'write' | 'remove';

/**
 * Name reported for an operation refused because its key is not one the product
 * owns.
 */
const REJECTED_KEY_ERROR_NAME = 'StorageKeyError';

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

/** The outcome of the writability probe. */
export interface StorageProbeResult {
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
  readonly operation: StorageOperation;

  readonly key: string;

  readonly strategy: StorageStrategy;

  readonly error: StorageErrorInfo;
}

/** A completed write attempt, successful or not. */
export interface StorageWriteInfo {
  readonly key: string;

  /**
   * The adapter's own estimate of the serialised size, at two bytes per UTF-16
   * code unit. What a browser charges against its quota is
   * implementation-defined and may differ. `0` when serialisation failed before
   * any value existed.
   */
  readonly byteLength: number;

  readonly ok: boolean;
}

/**
 * Sink for probe results, failures and write attempts. Every member is
 * optional, so an adapter built without a reporter, or with a partial
 * one, reports only what the sink accepts.
 *
 * A member that throws is contained: the throw does not escape the
 * adapter, does not reach the caller of the storage operation being
 * reported, and does not change the value that operation returns. Each
 * contained throw is counted on `LocalStorageManager.reporterFaults`
 * and described by `LocalStorageManager.lastReporterFault`, and is
 * never handed back to the sink that raised it. `reporterFailures` is the
 * count under the name a diagnostics surface reads it by.
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

const QUOTA_ERROR_NAMES: readonly string[] = Object.freeze([
  'QuotaExceededError',
  'NS_ERROR_DOM_QUOTA_REACHED',
]);

const LEGACY_QUOTA_EXCEEDED_CODE = 22;

const BYTES_PER_UTF16_UNIT = 2;

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
 * The membership test, the read and the value itself are all contained: a
 * `Proxy` throws from its `has` or `get` trap, and an `Error` subclass can
 * define `name` or `message` as a getter that throws. Either throw is read
 * as an absent property, so describing a storage failure — which happens
 * inside the `catch` that contains it — cannot raise a second one.
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

function errorName(error: unknown): string {
  return readErrorText(error, 'name') ?? UNKNOWN_ERROR_NAME;
}

function errorMessage(error: unknown): string {
  const carried = readErrorText(error, 'message');

  if (carried !== undefined) {
    return carried;
  }

  if (typeof error === 'object' || typeof error === 'function') {
    return UNKNOWN_ERROR_MESSAGE;
  }

  if (typeof error === 'symbol') {
    return UNKNOWN_ERROR_MESSAGE;
  }

  // A primitive's conversion cannot throw, and a symbol is excluded above.
  return String(error);
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

/** Reduces any thrown value, error or not, to `StorageErrorInfo`. Never throws. */
function describeStorageError(error: unknown): StorageErrorInfo {
  const name = errorName(error);

  return {
    name,
    message: errorMessage(error),
    quota: isQuotaError(error, name),
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
 * Describes a refused operation as a `StorageErrorInfo`, without constructing or
 * throwing an error.
 *
 * @param key Key that was refused, already shortened.
 * @returns The reportable description of the refusal.
 */
function describeRejectedKey(key: string): StorageErrorInfo {
  return {
    name: REJECTED_KEY_ERROR_NAME,
    message:
      `Key "${key}" is not owned by this product; the operation was ` +
      'refused and no storage was touched.',
    quota: false,
  };
}

/**
 * Probes Web Storage writability: the global store is read inside the `try`,
 * because the property access itself throws where storage is blocked, then a
 * probe key is written and immediately removed. Callable without constructing a
 * manager, which also runs it once at construction.
 *
 * @returns `{ supported: true, strategy: 'localStorage' }` when both the write
 *   and the removal succeed. Otherwise `supported` is `false` with `strategy`
 *   `'memory'`, carrying `error` only when something threw; a global store that
 *   is absent altogether, as outside a browser, yields no error.
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
 * Construction runs the writability probe once and fixes the store for the
 * session, in that order, and performs no read of its own; constructing with no
 * arguments is supported.
 *
 * Every read, write and removal is guarded: setters report and return `false`
 * rather than throwing, a raw or JSON read falls back to `null`, and
 * `getBestScore()` falls back to the number `0`. Reporting is guarded on the
 * same terms: every reporter callback runs inside a no-throw boundary, so a
 * throwing sink can neither escape construction nor alter the result of the
 * operation it was reporting.
 *
 * Every key is checked against `isOwnedStorageKey()` before the store is
 * touched, so the two frozen legacy keys and the product's namespaced keys are
 * the only keys this adapter can reach. A refused operation reports and returns
 * its failure value, and touches no storage.
 */
export class LocalStorageManager {
  /** The construction-time probe result. */
  readonly probe: StorageProbeResult;

  /**
   * The store actually in use. Equals `probe.strategy` unless a store
   * was injected, in which case it is `'injected'`.
   */
  readonly strategy: StorageStrategy;

  private readonly storage: StorageLike;

  private readonly reporter: StorageReporter;

  /** Reporter callbacks that threw and were contained. */
  private faultCount = 0;

  /** Description of the most recent contained reporter throw. */
  private faultInfo: StorageErrorInfo | undefined = undefined;

  /**
   * How many reporter callbacks have thrown and been contained.
   *
   * `0` for a reporter that never throws, which is every reporter that
   * behaves. A non-zero count means instrumentation is failing while
   * persistence is not: the storage operations themselves returned
   * their true results.
   */
  get reporterFaults(): number {
    return this.faultCount;
  }

  /**
   * The most recent contained reporter throw, or `undefined` when no
   * reporter callback has thrown.
   *
   * Reduced to the same serialisable shape as a storage error, so the
   * fault is inspectable — by a diagnostics surface, or by a caller
   * checking `reporterFaults` — without being re-delivered to the sink
   * that raised it.
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
   * threw, under the name a diagnostics surface reads it by. `0` for a reporter
   * that never throws; a non-zero value means reports have been lost and the
   * sink is faulty. Read out of band, because a contained throw is deliberately
   * not reported back through the sink that produced it.
   */
  get reporterFailures(): number {
    return this.faultCount;
  }

  /**
   * Reads the persisted best score. Frozen contract: the raw stored string when
   * a value is present, and the number `0` when it is absent or empty. Storage
   * is read on every call and never cached.
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
   * @returns The stored string, or `null` when the key is absent, the
   *   read threw, or the key was refused. The `undefined` an in-memory
   *   store yields for an absent key is normalised to `null`; a stored
   *   empty string is returned as `''`.
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
   * Writes `value` under `key`. A failure, exhausted quota included, is reported
   * and returned rather than thrown.
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
   * Reads and parses the JSON stored under `key`, guarding the parse.
   *
   * @param key Key to read. A key the product does not own is refused by
   *   `readRaw`, reported, and reaches no store.
   * @returns The parsed value, or `null` when the key is absent, holds
   *   an empty string, holds text that is not valid JSON, or was
   *   refused.
   */
  readJson(key: OwnedStorageKey): unknown {
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
   * @param key Key to write. A key the product does not own is refused,
   *   reported, and reaches no store; nothing is serialised for it.
   * @param value Value to serialise.
   * @returns `true` when both the serialisation and the write succeeded. Values
   *   that serialise to no JSON text, such as `undefined`, a function or a
   *   symbol, are reported as failures.
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
   * Decides whether an operation may proceed with `key`, reporting a refusal.
   *
   * The check runs before the store is touched, so a refused operation performs
   * no read, no write and no removal. It is a runtime check as well as a
   * type-level one because a key can reach a call site from persisted or parsed
   * data, where the type is not enforced.
   *
   * @param operation Operation being attempted.
   * @param key Key it targets.
   * @returns `true` when the key is owned and the operation may run.
   */
  private acceptKey(operation: StorageOperation, key: string): boolean {
    if (isOwnedStorageKey(key)) {
      return true;
    }

    const reported = truncateKey(key);

    this.deliverFailure({
      operation,
      key: reported,
      strategy: this.strategy,
      error: describeRejectedKey(reported),
    });

    return false;
  }

  /**
   * Serialises `value`, reporting and returning `null` on failure — circular
   * structures and `BigInt` throw, and `undefined`, functions and symbols yield
   * no JSON text.
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
   * Every reporter invocation in this class goes through here, so a
   * throwing sink is contained at the point of delivery: the operation
   * that was being reported keeps its own outcome, and construction
   * completes. A contained throw is counted on `reporterFaults` and
   * described on `lastReporterFault` rather than being re-delivered to
   * the sink that raised it.
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
   * Hands the construction-time probe result to the reporter, and a
   * failed probe to the failure sink as well.
   *
   * `StorageOperation` carries a `'probe'` member and `onFailure`
   * receives every failed operation, so an unsupported probe that
   * caught an error is reported on both channels: the complete result
   * on `onProbe`, then one `StorageFailure` under `STORAGE_PROBE_KEY`.
   * A probe that found no global store at all carries no error and so
   * reports no failure.
   *
   * Runs once, at the end of construction, after the strategy is fixed
   * — the strategy the failure carries is therefore the store the
   * manager actually went on to use.
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
    });
  }

  /**
   * Delivers one already-described failure to the reporter, when one
   * accepts it.
   *
   * The single delivery point for `StorageFailure`: the read, write and
   * removal paths reach it through `reportFailure`, and the probe path
   * reaches it directly with the error the probe already reduced.
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
