// Structured logging for the observability layer: the run correlation
// identifier, error serialisation, field sanitisation, the log record, the
// level filter, the sink registry, the bounded recent-record buffer, the
// JSON-lines export, and the three adapters that satisfy the reporter
// contracts src/engine, src/input and src/storage each declare for
// themselves.
//
// Two properties of the emission path, both load-bearing:
//   a throwable is identified by the ARGUMENT POSITION it arrives in, or by
//   its presence on a `LogFailure`, never by its type — the type test that
//   used to choose between two positions read a thrown plain object as
//   fields and dropped it from the record;
//   a field bag is DEEP-SANITISED rather than shallow-copied, so nothing a
//   caller retains a reference to can change a buffered record, and no
//   record carries a value that `JSON.stringify` would alter.
//
// `serializeError` is the target of the discarded-error `catch` in
// js/local_storage_manager.js, which bound `error` and returned `false` without
// reporting it. Two further silent-failure sites in that same file — an
// unguarded `setItem` and an unguarded `JSON.parse` — report through
// `createStorageReporter`.
//
// docs/TRACEABILITY_MATRIX.md:
//   TR-LOG-01  js/local_storage_manager.js L37-L39  the discarded-error
//   TR-LOG-02  js/local_storage_manager.js L47-L49  the unguarded `setItem`
//   TR-LOG-03  js/local_storage_manager.js L54      the unguarded
// Everything else in this module is a target-only row, TR-LOG-04 through
// TR-LOG-08: the correlation identifier, the log record, the level filter,
//
// The module's only imports are the three reporter contracts, imported as types
// and therefore erased at build time. It names no package, no sibling
// observability module and no DOM node: `console` and `performance` are reached
// through `globalThis`, and every access to them is guarded. Exported members
// report rather than throw.
//
// Decisions behind this file: DL-LOG-01, the correlation identifier being a
// deterministic hash of the run seed and run identifier; DL-LOG-02, the
// two-hash rendering of that identifier; DL-LOG-03, the bounded
// backend; and DL-LOG-04, the three reporter adapters living in this

import type {
  CorrelationId,
  EngineCountReport,
  EngineHookErrorReport,
  EngineListenerErrorReport,
  EngineReporter,
} from '../engine/types';
import type {
  InputReportFields,
  InputReportLevel,
  InputReporter,
  InputSpan,
} from '../input/keymap';
import type {
  StorageFailure,
  StorageProbeResult,
  StorageReporter,
  StorageWriteInfo,
} from '../storage/local-storage-manager';

const CORRELATION_ID_PREFIX = 'run-';

/**
 * Separates the seed-derived prefix from the run-instance segment.
 *
 * A hyphen, so the seed-grouping prefix of an instance identifier is readable
 * at a glance and a log stream can be grouped by seed with a prefix match while
 * still distinguishing the runs within it.
 */
const CORRELATION_ID_INSTANCE_SEPARATOR = '-';

const FNV_OFFSET_BASIS = 0x811c9dc5;

const FNV_PRIME = 0x01000193;

const DJB2_BASIS = 5381;

const DJB2_MULTIPLIER = 33;

const HASH_RADIX = 36;

const HASH_WIDTH = 7;

function fnv1a32(text: string): number {
  let hash = FNV_OFFSET_BASIS;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }

  return hash >>> 0;
}

function djb2Hash32(text: string): number {
  let hash = DJB2_BASIS;

  for (let index = 0; index < text.length; index += 1) {
    hash = (Math.imul(hash, DJB2_MULTIPLIER) + text.charCodeAt(index)) | 0;
  }

  return hash >>> 0;
}

function renderHash(hash: number): string {
  return (hash >>> 0).toString(HASH_RADIX).padStart(HASH_WIDTH, '0');
}

/**
 * Derives the correlation identifier every log record carries.
 *
 * THE SINGLE AUTHORITY. This is the only function in src/ that derives a
 * `CorrelationId`. src/engine/, src/run/, src/input/, src/render/ and
 * src/audio/ each receive the identifier by injection and derive none of
 * their own, which is what keeps one run's records, hook reports, run
 * reports and metric snapshots under one identifier. src/main.ts calls it
 * once per run and injects the result.
 *
 * TWO IDENTIFIERS, ONE DERIVATION. What the identifier identifies depends on
 * whether a run instance is named:
 *
 * - `deriveCorrelationId(seed)` groups a SEED. Every run replaying that seed
 *   receives the same identifier, which is what correlates a replay's records
 *   with the original's. It is `run-` followed by two fixed-width base36
 *   hashes of the seed, FNV-1a then djb2.
 * - `deriveCorrelationId(seed, runId)` identifies a RUN INSTANCE. It appends a
 *   third hyphen-separated hash over the run instance, so two runs of one seed
 *   are distinguishable while the seed-derived prefix still groups them. This
 *   is the form src/main.ts uses.
 *
 * The second form exists because a correlation identifier's job is to let one
 * session's records be followed end to end. Seed-grouping alone cannot do that:
 * a seed replayed — which this product invites, since the seed is displayed and
 * copyable — puts two runs' records under one identifier with nothing in the
 * stream to separate them. `runId` is therefore the UNIQUENESS component, and
 * the seed is retained in the derivation only so the grouping property survives
 * beside the instance identity. Determinism of gameplay depends on the seed and
 * is untouched by either form: no engine behaviour reads this value.
 *
 * PSEUDONYMOUS, NOT ANONYMOUS. The identifier is not a secret, and it is what
 * a report carries in place of the seed, but it must not be described as
 * anonymising the seed. The derivation is unsalted and deterministic, so it can
 * be computed by anyone: a party holding a list of candidate seeds can hash
 * each one and match it against an identifier, which recovers a low-entropy or
 * guessable seed — a word, a date, a short phrase — by dictionary search. What
 * the derivation does guarantee is that the seed TEXT is not carried in the
 * record and cannot be read back out of the identifier by inversion; it does
 * not guarantee the seed cannot be identified by search.
 *
 * A SEED IS THEREFORE TREATED AS DATA THAT MAY BE PUBLISHED. Nothing in the
 * product may put personal data in a run seed, and no caller may treat this
 * identifier as a way to carry a sensitive seed into a log or an export
 * safely.
 *
 * It identifies a SEED, not a run instance. Every run replaying one seed
 * receives the same identifier, so records from different runs of one seed are
 * LINKABLE to each other: the identifier groups replays of a seed rather than
 * distinguishing runs, which is what makes it useful for comparing a replay
 * against the original. A consumer that has to tell two runs of one seed apart
 * reads `RunState.runId`, which src/run/run-state.ts persists with the envelope
 * and a report carries as an ordinary field beside this identifier; `runId` is
 * the per-instance identity, and this value is never a substitute for it.
 *
 * The derivation reads no clock and no randomness in either form: the same
 * inputs yield the same identifier, in this process and in any later one, which
 * is what makes a record's identifier reproducible from a persisted run.
 *
 * The identifier is not a secret and not reversible, and it is what a report
 * carries in place of the seed: a player-entered seed can hold personal data,
 * this value cannot be read back into one. The same applies to `runId`.
 *
 * Neither form is unique by construction — each concatenates 32-bit hashes — so
 * distinct inputs can collide, and a consumer that needs an exact identity
 * compares the seed and `runId` themselves.
 *
 * A caller holding an identifier already derived supplies it as
 * `LoggerOptions.correlationId`, which is carried verbatim and takes
 * precedence over `runSeed`.
 *
 * @param runSeed Seed of the run. Coerced with `String`, so any value is
 *   accepted and none throws.
 * @param runId Run instance identifier. Omit it, or pass an empty value, for
 *   the seed-grouping form.
 * @returns An 18-character identifier for the seed-grouping form and a
 *   26-character one for the run-instance form, non-empty for every input, the
 *   empty string included.
 */
export function deriveCorrelationId(
  runSeed: string,
  runId?: string,
): CorrelationId {
  const seed = String(runSeed);
  const grouped =
    CORRELATION_ID_PREFIX +
    renderHash(fnv1a32(seed)) +
    renderHash(djb2Hash32(seed));

  if (runId === undefined || String(runId) === '') {
    return grouped;
  }

  // Hashed over the run instance AND the seed rather than the run instance
  // alone, so the segment cannot be read back as a bare hash of `runId` and
  // two seeds sharing a run identifier still differ here.
  const instance = `${String(runId)}\u0000${seed}`;

  return `${grouped}${CORRELATION_ID_INSTANCE_SEPARATOR}${renderHash(
    fnv1a32(instance) ^ djb2Hash32(instance),
  )}`;
}

const CIRCULAR_PLACEHOLDER = '[circular]';

const FUNCTION_PLACEHOLDER = '[function]';

const UNREADABLE_VALUE = '[unreadable value]';

const UNSERIALISABLE_FIELDS = '[unserialisable fields]';

/** Substituted for a value a limit stopped the normalisation short of. */
const TRUNCATED_VALUE = '[truncated]';

/** Member name a normalised object carries its dropped-member marker under. */
const TRUNCATED_FIELD_KEY = '__truncated__';

/**
 * Member names a normalised object never carries.
 *
 * `__proto__` on an ordinary object literal reassigns that object's prototype
 * rather than adding a member, and `constructor` and `prototype` reach the
 * prototype chain of whatever rebuilds the bag from the record.
 */
const FORBIDDEN_FIELD_KEYS: ReadonlySet<string> = new Set<string>([
  '__proto__',
  'constructor',
  'prototype',
]);

/** Substituted for a subtree deeper than `MAX_FIELD_DEPTH`. */
const DEPTH_PLACEHOLDER = '[depth limit]';

/** Deepest nesting a normalised field structure carries. */
const MAX_FIELD_DEPTH = 4;

/**
 * Most members one normalised object, or elements one normalised array,
 * carries. It bounds the top-level bag as well as every structure inside it.
 */
const MAX_FIELD_BREADTH = 32;

/** Most values one normalised field bag carries in total, at every depth. */
const MAX_FIELD_NODES = 256;

/** Longest string one normalised field carries, in characters. */
const MAX_FIELD_STRING_LENGTH = 512;

/** Longest member name one normalised object carries, in characters. */
const MAX_FIELD_KEY_LENGTH = 120;

/**
 * Longest record this module emits, measured in characters of its JSON form.
 *
 * A record over the limit is reduced in three steps — its fields are
 * replaced with a marker, then the stack of its error is dropped, then its
 * message is clamped — so a record's size is bounded whatever a caller
 * passed and whatever was thrown.
 */
const MAX_RECORD_LENGTH = 8192;

/** A shared allowance one field normalisation spends as it descends. */
interface FieldBudget {
  /** Values the normalisation may still visit. */
  remaining: number;
}

/** Longest description `describeValue` returns before truncating. */
const MAX_DESCRIPTION_LENGTH = 240;

const TRUNCATION_SUFFIX = '…';

function createReplacer(
  seen: WeakSet<object>
): (key: string, value: unknown) => unknown {
  return (_key: string, value: unknown): unknown => {
    if (typeof value === 'bigint') {
      return `${value.toString()}n`;
    }

    if (typeof value === 'function') {
      return FUNCTION_PLACEHOLDER;
    }

    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return CIRCULAR_PLACEHOLDER;
      }

      seen.add(value);
    }

    return value;
  };
}

function safeStringify(value: unknown): string | null {
  try {
    const text = JSON.stringify(value, createReplacer(new WeakSet<object>()));

    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_DESCRIPTION_LENGTH) {
    return text;
  }

  return text.slice(0, MAX_DESCRIPTION_LENGTH) + TRUNCATION_SUFFIX;
}

function describeValue(value: unknown): string {
  try {
    if (typeof value === 'string') {
      return truncate(value);
    }

    if (typeof value === 'bigint') {
      return truncate(`${value.toString()}n`);
    }

    if (typeof value === 'object' && value !== null) {
      return truncate(safeStringify(value) ?? UNREADABLE_VALUE);
    }

    return truncate(String(value));
  } catch {
    return UNREADABLE_VALUE;
  }
}

const UNKNOWN_ERROR_NAME = 'UnknownError';

const MAX_CAUSE_DEPTH = 4;

/** Longest error name a serialised error carries, in characters. */
const MAX_ERROR_NAME_LENGTH = 120;

/** Longest error message a serialised error carries, in characters. */
const MAX_ERROR_MESSAGE_LENGTH = 512;

/** Longest stack text a serialised error carries, in characters. */
const MAX_ERROR_STACK_LENGTH = 2048;

/** Substituted for each source location a redacted stack carried. */
const REDACTED_LOCATION = '[redacted]';

/** A URL, in any scheme, as a stack frame writes one. */
const URL_LOCATION_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s)'"]+/gi;

/** A Windows absolute path, as a stack frame writes one. */
const WINDOWS_LOCATION_PATTERN = /\b[a-z]:\\[^\s)'"]+/gi;

/**
 * A POSIX absolute path of at least two segments, optionally followed by a
 * line and column, as a stack frame writes one.
 */
const POSIX_LOCATION_PATTERN =
  /(?:\/[\w.@~+-]+){2,}(?::\d+(?::\d+)?)?/g;

/**
 * How much of a stack a record carries.
 *
 * `'redacted'` replaces every source location in the stack text with
 * `REDACTED_LOCATION`, leaving the frame names and the shape of the stack.
 * `'full'` carries the stack text as it was thrown, for a private
 * development sink; the export surfaces redact regardless, so a downloaded
 * or snapshotted record never carries a location.
 */
export type StackDetail = 'redacted' | 'full';

/** How much of a stack a logger built without an opinion carries. */
export const DEFAULT_STACK_DETAIL: StackDetail = 'redacted';

/**
 * Replaces every source location in `text` with `REDACTED_LOCATION`.
 *
 * URLs, Windows absolute paths and POSIX absolute paths of two segments or
 * more are all replaced, with any trailing line and column of a POSIX path
 * replaced along with it. Deterministic and total: it reads no clock, no
 * randomness and no platform state, and it never throws.
 *
 * @param text Text to redact.
 * @returns The text with every matched location replaced.
 */
function redactLocations(text: string): string {
  return text
    .replace(URL_LOCATION_PATTERN, REDACTED_LOCATION)
    .replace(WINDOWS_LOCATION_PATTERN, REDACTED_LOCATION)
    .replace(POSIX_LOCATION_PATTERN, REDACTED_LOCATION);
}

/**
 * Shortens `text` to `limit` characters.
 *
 * @param text Text to shorten.
 * @param limit Longest text returned before the suffix is appended.
 * @returns `text` unchanged when it is short enough, otherwise its prefix
 *   with `TRUNCATION_SUFFIX` appended.
 */
function clamp(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  return text.slice(0, limit) + TRUNCATION_SUFFIX;
}

/**
 * Every bound a record this module emits is held to, and the two markers a
 * bounded record carries.
 *
 * Exported so a caller reads the contract rather than inferring it, and so a
 * test asserts against the value in force rather than a copy of it. Frozen.
 */
export const logRecordBounds = Object.freeze({
  /** Longest `SerializedError.name`, in characters. */
  errorName: MAX_ERROR_NAME_LENGTH,

  /** Longest `SerializedError.message`, in characters. */
  errorMessage: MAX_ERROR_MESSAGE_LENGTH,

  /** Longest `SerializedError.stack`, in characters. */
  errorStack: MAX_ERROR_STACK_LENGTH,

  /** Deepest `cause` chain a serialised error carries. */
  causeDepth: MAX_CAUSE_DEPTH,

  /** Deepest nesting a normalised field structure carries. */
  fieldDepth: MAX_FIELD_DEPTH,

  /** Most members one normalised object or array carries. */
  fieldBreadth: MAX_FIELD_BREADTH,

  /** Most values one normalised field bag carries in total. */
  fieldNodes: MAX_FIELD_NODES,

  /** Longest string one normalised field carries, in characters. */
  fieldString: MAX_FIELD_STRING_LENGTH,

  /** Longest record, in characters of its JSON form. */
  record: MAX_RECORD_LENGTH,

  /** Appended to any text a bound shortened. */
  truncationSuffix: TRUNCATION_SUFFIX,

  /** Substituted for each source location a redacted stack carried. */
  redactedLocation: REDACTED_LOCATION,

  /** Substituted for a value a limit stopped the normalisation short of. */
  truncatedValue: TRUNCATED_VALUE,
});

/**
 * A thrown value reduced to JSON-serialisable fields. Every log record that
 * reports a failure carries one.
 *
 * Every member is bounded: `name` to `MAX_ERROR_NAME_LENGTH`, `message` to
 * `MAX_ERROR_MESSAGE_LENGTH`, `stack` to `MAX_ERROR_STACK_LENGTH` and the
 * `cause` chain to `MAX_CAUSE_DEPTH` links, so one caught value cannot grow
 * a record without limit however large the value that was thrown.
 */
export interface SerializedError {
  readonly name: string;
  readonly message: string;

  /**
   * The value's own `stack`, absent when it carries none. Every source
   * location in it is replaced with `REDACTED_LOCATION` unless the record
   * was built by a logger carrying `stackDetail: 'full'`, and the export
   * surfaces redact in either case.
   */
  readonly stack?: string;

  /**
   * The value's own `cause`, serialised the same way. Absent when the value
   * carries none, when the cause is `null` or `undefined`, and beyond
   * `MAX_CAUSE_DEPTH` links.
   */
  readonly cause?: SerializedError;
}

const FALLBACK_SERIALIZED_ERROR: SerializedError = Object.freeze({
  name: UNKNOWN_ERROR_NAME,
  message: UNREADABLE_VALUE,
});


/**
 * Shortens text to a byte-bounded length.
 *
 * A thrown value carries text of any size — a message built from a whole
 * payload, a stack from a deep recursion — and a record is buffered, so
 * both are bounded here rather than retained whole.
 *
 * @param text Text to bound.
 * @param limit Characters to keep.
 * @returns `text` when it is within the limit, otherwise its prefix with
 *   `TRUNCATION_SUFFIX` appended.
 */
/**
 * Reads one string-valued member off an object, without throwing.
 *
 * @param holder Object to read from.
 * @param key Member to read.
 * @param limit Characters of the value to keep.
 * @returns The string value, bounded, or `undefined` when the member is
 *   absent, is not a string, or its accessor throws.
 */
function readStringMember(
  holder: object,
  key: string
): string | undefined {
  try {
    const value: unknown = (holder as Record<string, unknown>)[key];

    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}


function readCause(
  holder: object,
  depth: number,
  stackDetail: StackDetail
): SerializedError | undefined {
  if (depth >= MAX_CAUSE_DEPTH) {
    return undefined;
  }

  try {
    const cause: unknown = (holder as { cause?: unknown }).cause;

    if (cause === undefined || cause === null) {
      return undefined;
    }

    return serializeThrown(cause, depth + 1, stackDetail);
  } catch {
    return undefined;
  }
}


function buildSerializedError(
  name: string,
  message: string,
  stack: string | undefined,
  cause: SerializedError | undefined,
  stackDetail: StackDetail
): SerializedError {
  const record: {
    name: string;
    message: string;
    stack?: string;
    cause?: SerializedError;
  } = {
    name: clamp(name, MAX_ERROR_NAME_LENGTH),
    message: clamp(message, MAX_ERROR_MESSAGE_LENGTH),
  };

  if (stack !== undefined) {
    // Redacted before it is clamped, so the limit measures the text the
    // record actually carries.
    const resolved =
      stackDetail === 'full' ? stack : redactLocations(stack);

    record.stack = clamp(resolved, MAX_ERROR_STACK_LENGTH);
  }

  if (cause !== undefined) {
    record.cause = cause;
  }

  return Object.freeze(record);
}

/**
 * Serialises one thrown value at a known cause depth.
 *
 * @param thrown Value that was thrown.
 * @param depth Number of causes already followed.
 * @param stackDetail How much of each stack in the chain to carry.
 * @returns The serialised value.
 */
function serializeThrown(
  thrown: unknown,
  depth: number,
  stackDetail: StackDetail
): SerializedError {
  try {
    if (typeof thrown === 'object' && thrown !== null) {
      return buildSerializedError(
        readStringMember(thrown, 'name') ?? UNKNOWN_ERROR_NAME,
        readStringMember(thrown, 'message') ?? describeValue(thrown),
        readStringMember(thrown, 'stack'),
        readCause(thrown, depth, stackDetail),
        stackDetail
      );
    }

    return buildSerializedError(
      UNKNOWN_ERROR_NAME,
      describeValue(thrown),
      undefined,
      undefined,
      stackDetail
    );
  } catch {
    return FALLBACK_SERIALIZED_ERROR;
  }
}

/**
 * Reduces any thrown value to `SerializedError`.
 *
 * Accepts an `Error` and every subclass of it, and equally a thrown string,
 * number, boolean, symbol, bigint, plain object, `null` or `undefined`. An
 * accessor that throws, a circular structure and a circular `cause` chain are
 * each contained and reduced to a record rather than raised.
 *
 * Target of the discarded-error `catch` in js/local_storage_manager.js.
 */
export function serializeError(
  thrown: unknown,
  stackDetail: StackDetail = DEFAULT_STACK_DETAIL
): SerializedError {
  return serializeThrown(thrown, 0, stackDetail);
}

/** Severity of a log record. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Every level, in ascending severity order. */
export const LOG_LEVELS: readonly LogLevel[] = Object.freeze([
  'debug',
  'info',
  'warn',
  'error',
]);

/**
 * Numeric severity of each level. A record is emitted when its own severity is
 * at least the severity of the logger's current level.
 */
export const LOG_LEVEL_SEVERITY: Readonly<Record<LogLevel, number>> =
  Object.freeze({
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
  });

const DEFAULT_LOG_LEVEL: LogLevel = 'info';

/**
 * Narrows an arbitrary value to a known level.
 *
 * @returns `true` when `value` is one of the four level names.
 */
export function isLogLevel(value: unknown): value is LogLevel {
  return (
    value === 'debug' ||
    value === 'info' ||
    value === 'warn' ||
    value === 'error'
  );
}

/** A value a structured field may carry. */
export type LogFieldValue =
  | string
  | number
  | boolean
  | null
  | readonly LogFieldValue[]
  | { readonly [key: string]: LogFieldValue };

/**
 * The structured field bag a record carries.
 *
 * A bag a caller supplies is sanitised before it reaches a record: every
 * level is deep-copied onto a frozen null-prototype object, the depth, the
 * member count, the element count and the string length are bounded,
 * `__proto__`, `constructor` and `prototype` are dropped as names, and
 * `undefined`, the non-finite numbers, a bigint, a function, a symbol and a
 * cycle are each replaced by a value that survives `JSON.stringify`
 * unchanged. `LogRecord.fields` is therefore the sanitised tree and never
 * the caller's own object.
 */
export interface LogFields {
  readonly [key: string]: LogFieldValue | undefined;
}

/**
 * One emitted log record. Every member is plain data: a record round-trips
 * through `JSON.parse(JSON.stringify(record))` unchanged. Records are frozen
 * before they reach the buffer, the console or a sink.
 */
export interface LogRecord {
  readonly level: LogLevel;

  /** The message, verbatim. */
  readonly message: string;

  /**
   * Wall-clock time of emission, ISO 8601. Empty when the wall clock could not
   * be read.
   */
  readonly timestamp: string;
  readonly elapsedMs: number;

  /** Correlation identifier of the run. Carried by every record. */
  readonly correlationId: CorrelationId;

  /** Subsystem tag of the logger that emitted the record. */
  readonly subsystem: string;

  /**
   * Structured fields, absent when the caller supplied none. Deep-normalised
   * to bounded JSON data: the record shares no object with the caller's bag
   * at any depth, and `logRecordBounds` states the depth, breadth, node and
   * string limits it was normalised within.
   */
  readonly fields?: LogFields;

  /** The reported failure, absent when the record reports none. */
  readonly error?: SerializedError;
}

/** A subscriber that receives every emitted record. */
export type LogSink = (record: LogRecord) => void;

/**
 * One reported failure: the value that was thrown, and the fields that
 * describe where it was thrown.
 *
 * The presence of `thrown` is what decides whether the record carries a
 * `LogRecord.error`, and presence is read with `in` rather than by
 * comparing the value: `{ thrown: undefined }` reports a thrown
 * `undefined`, which is a value JavaScript permits throwing, while `{}`
 * reports no throwable at all. Nothing about the value is inspected to
 * decide it, so a plain object, an array, `null` and `undefined` are all
 * carried as throwables rather than being mistaken for fields.
 */
export interface LogFailure {
  /**
   * The value that was thrown, exactly as it was caught. Present-but-
   * `undefined` is meaningful; see above.
   */
  readonly thrown?: unknown;

  /** Structured fields describing the failure. */
  readonly fields?: LogFields;
}

/* --------------------------------------------------------------------------
 * Guarded platform access
 * ----------------------------------------------------------------------- */

/** A reader of a millisecond clock. */
type ClockReader = () => number;

type LineWriter = (line: string) => void;

const CONSOLE_METHODS: Readonly<Record<LogLevel, string>> = Object.freeze({
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
});

const CONSOLE_FALLBACK_METHOD = 'log';

function isClockReader(value: unknown): value is ClockReader {
  return typeof value === 'function';
}

function isLineWriter(value: unknown): value is LineWriter {
  return typeof value === 'function';
}

function resolveClock(): ClockReader | null {
  const host: unknown = globalThis.performance;

  if (typeof host !== 'object' || host === null) {
    return null;
  }

  const reader: unknown = (host as Record<string, unknown>)['now'];

  if (!isClockReader(reader)) {
    return null;
  }

  return (): number => reader.call(host);
}

/**
 * The resolved clock reader, or `null` where the host exposes none.
 * `undefined` until the first read resolves it.
 */
let cachedClockReader: ClockReader | null | undefined;

/**
 * The `globalThis.performance` the cached reader was resolved from, so a host
 * whose clock member is replaced is re-probed rather than read through a
 * binding onto the object it replaced.
 */
let cachedClockHost: unknown;

/**
 * The host clock reader, resolved once and reused.
 *
 * Resolution walks `globalThis` and binds a closure, so doing it per read
 * allocated one closure for every record emitted and every span opened and
 * closed. The binding is therefore held, and re-probed only when
 * `globalThis.performance` is no longer the object it was bound to.
 *
 * @returns The reader, or `null` where the host exposes no usable clock.
 */
function clockReader(): ClockReader | null {
  const host: unknown = globalThis.performance;

  if (cachedClockReader === undefined || cachedClockHost !== host) {
    cachedClockReader = resolveClock();
    cachedClockHost = host;
  }

  return cachedClockReader;
}

/**
 * Reads the monotonic clock.
 *
 * @returns Milliseconds from the clock's time origin, or `0` when no clock
 *   answered with a finite number.
 */
function readElapsedMs(): number {
  const clock = clockReader();

  if (clock === null) {
    return 0;
  }

  try {
    const reading = clock();

    return typeof reading === 'number' && Number.isFinite(reading)
      ? reading
      : 0;
  } catch {
    return 0;
  }
}

function readTimestamp(): string {
  try {
    return new Date().toISOString();
  } catch {
    return '';
  }
}

function resolveConsoleWriter(level: LogLevel): LineWriter | null {
  const host: unknown = globalThis.console;

  if (typeof host !== 'object' || host === null) {
    return null;
  }

  const members = host as Record<string, unknown>;
  const preferred: unknown = members[CONSOLE_METHODS[level]];
  const writer: unknown = isLineWriter(preferred)
    ? preferred
    : members[CONSOLE_FALLBACK_METHOD];

  if (!isLineWriter(writer)) {
    return null;
  }

  return (line: string): void => {
    writer.call(host, line);
  };
}

function stringifyRecord(record: LogRecord): string {
  const full = safeStringify(record);

  if (full !== null) {
    return full;
  }

  const reduced = safeStringify({
    level: record.level,
    message: record.message,
    timestamp: record.timestamp,
    elapsedMs: record.elapsedMs,
    correlationId: record.correlationId,
    subsystem: record.subsystem,
    fields: UNSERIALISABLE_FIELDS,
  });

  return reduced ?? `{"message":${JSON.stringify(UNSERIALISABLE_FIELDS)}}`;
}

/** Records the recent-record buffer holds when no capacity is supplied. */
export const DEFAULT_LOG_BUFFER_CAPACITY = 200;

const MIN_LOG_BUFFER_CAPACITY = 1;

const MAX_LOG_BUFFER_CAPACITY = 10000;

const DEFAULT_SUBSYSTEM = 'app';

/** Settings `createLogger` accepts. */
export interface LoggerOptions {
  /**
   * Run seed the seed-grouping correlation identifier is derived from. Defaults
   * to the empty string, which derives a stable identifier of its own.
   */
  readonly runSeed?: string;

  /**
   * Correlation identifier carried verbatim, as `deriveCorrelationId`
   * returned it. Takes precedence over `runSeed` when it is a non-empty
   * string.
   */
  readonly correlationId?: CorrelationId;

  /** Level to start at. Defaults to `'info'`. */
  readonly level?: LogLevel;
  readonly subsystem?: string;
  readonly capacity?: number;

  /**
   * Whether records are also written to the console as JSON. Defaults to
   * `true`; only the exact value `false` turns it off.
   */
  readonly consoleOutput?: boolean;

  /**
   * How much of a stack the records this logger emits carry. Defaults to
   * `DEFAULT_STACK_DETAIL`, which is `'redacted'`; only the exact value
   * `'full'` selects the unredacted form, and it is for a private
   * development sink. `toJsonLines()` and `snapshot()` redact in either
   * case.
   */
  readonly stackDetail?: StackDetail;
}

/** A logger's state and its buffered records, as `snapshot()` reports them. */
export interface LoggerSnapshot {
  /** Correlation identifier every record carries. */
  readonly correlationId: CorrelationId;

  /** Subsystem tag of the logger the snapshot was taken through. */
  readonly subsystem: string;
  readonly level: LogLevel;
  readonly capacity: number;
  readonly stored: number;

  /** Records emitted over the shared state's lifetime. */
  readonly emitted: number;
  readonly dropped: number;
  readonly sinkCount: number;

  /** Sink calls that threw and were contained. */
  readonly sinkFaults: number;

  /** The most recent contained sink throw, absent when none has occurred. */
  readonly lastSinkFault?: SerializedError;
  readonly records: readonly LogRecord[];
}

/**
 * Structured logger.
 *
 * `debug` and `info` take a message and optional fields. `warn` and `error`
 * take the same two arguments and a thrown value in a THIRD, FIXED
 * position; nothing about an argument's type decides which parameter it
 * belongs to. `failure` is the explicit form, which additionally
 * distinguishes a thrown `undefined` from no throwable at all.
 *
 * Every member reports rather than throws: a sink that throws, a console that
 * throws, a field accessor that throws and a circular field structure are all
 * contained.
 */
export interface Logger {
  /** Correlation identifier every record from this logger carries. */
  readonly correlationId: CorrelationId;

  /** Subsystem tag every record from this logger carries. */
  readonly subsystem: string;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;

  /**
   * Emits a record at `'warn'`.
   *
   * The third argument is the thrown value and the second is the fields;
   * neither position is inferred from the value passed. Supplying the
   * third argument at all — including as `undefined` — records a
   * `LogRecord.error`; omit it when there is no throwable.
   *
   * @param message Message to record.
   * @param fields Optional structured fields.
   * @param thrown Thrown value, serialised onto `LogRecord.error`.
   */
  warn(message: string, fields?: LogFields, thrown?: unknown): void;

  /**
   * Emits a record at `'error'`.
   *
   * The third argument is the thrown value and the second is the fields;
   * neither position is inferred from the value passed. Supplying the
   * third argument at all — including as `undefined` — records a
   * `LogRecord.error`; omit it when there is no throwable.
   *
   * @param message Message to record.
   * @param fields Optional structured fields.
   * @param thrown Thrown value, serialised onto `LogRecord.error`.
   */
  error(message: string, fields?: LogFields, thrown?: unknown): void;

  /**
   * Emits a record for a caught value at a level chosen by the caller.
   *
   * The form every reporter adapter uses, because it is the one that
   * carries a caught value whose type is unknown: the throwable travels in
   * `detail.thrown`, its presence is read with `in`, and a plain object,
   * an array, `null` and `undefined` are therefore all serialised onto
   * `LogRecord.error` rather than any of them being read as fields.
   *
   * @param level Severity to record at. A value outside the four names
   *   records at `'info'`.
   * @param message Message to record.
   * @param detail The thrown value and the fields that describe it.
   */
  failure(level: LogLevel, message: string, detail: LogFailure): void;

  /**
   * Returns a logger tagged with another subsystem. The returned logger shares
   * this one's correlation identifier, level, sinks, buffer and counters; a
   * blank tag falls back to `'app'`.
   *
   * @param subsystem Tag the returned logger records under.
   * @returns The tagged logger.
   */
  child(subsystem: string): Logger;

  /**
   * Sets the level below which records are discarded. A value that is not one
   * of the four level names leaves the current level unchanged.
   */
  setLevel(level: LogLevel): void;
  getLevel(): LogLevel;

  /**
   * Subscribes a sink to every record emitted through this logger and through
   * every logger sharing its state. A sink that throws is contained and the
   * remaining sinks still receive the record.
   */
  subscribe(sink: LogSink): () => void;
  recent(limit?: number): readonly LogRecord[];
  toJsonLines(limit?: number): string;
  snapshot(limit?: number): LoggerSnapshot;

  /** Discards the buffered records. The lifetime counters are unchanged. */
  clear(): void;
}

interface SinkRegistration {
  readonly sink: LogSink;
}

interface LoggerState {
  readonly correlationId: CorrelationId;
  level: LogLevel;
  readonly registrations: SinkRegistration[];
  readonly buffer: (LogRecord | undefined)[];
  readonly capacity: number;
  nextIndex: number;
  stored: number;
  dropped: number;
  emitted: number;
  sinkFaults: number;
  lastSinkFault: SerializedError | undefined;
  consoleOutput: boolean;
  readonly stackDetail: StackDetail;
}

/** What one emission carries besides its level, message and subsystem. */
interface EmissionArgs {
  readonly fields: LogFields | undefined;

  /** The thrown value. Meaningless unless `hasThrown` is `true`. */
  readonly thrown: unknown;

  /**
   * Whether a throwable was supplied at all, tracked independently of its
   * value so a thrown `undefined` still records a `LogRecord.error`.
   */
  readonly hasThrown: boolean;
}

type MutableRecord = {
  -readonly [K in keyof LogRecord]: LogRecord[K];
};

type MutableSnapshot = {
  -readonly [K in keyof LoggerSnapshot]: LoggerSnapshot[K];
};

const NOOP_UNSUBSCRIBE = (): void => {
  return;
};

/**
 * Builds the emission arguments of a `warn` or `error` call.
 *
 * The thrown value's POSITION is what identifies it, never its type: the
 * type test that used to decide between the two argument positions read a
 * thrown plain object as fields and dropped it from the record.
 *
 * @param fields Second argument of the call.
 * @param rest Remaining arguments; the first of them, if any, is the
 *   thrown value. Its length is what records the throwable's presence, so
 *   an explicitly passed `undefined` is a throwable and an omitted
 *   argument is not.
 * @returns The emission arguments.
 */
function positionalArgs(
  fields: LogFields | undefined,
  rest: readonly unknown[]
): EmissionArgs {
  return {
    fields,
    thrown: rest.length > 0 ? rest[0] : undefined,
    hasThrown: rest.length > 0,
  };
}

/**
 * Builds the emission arguments of a `failure` call.
 *
 * @param detail The caller's failure descriptor. A value that is not an
 *   object is read as carrying neither a throwable nor fields.
 * @returns The emission arguments, with the throwable's presence read from
 *   the descriptor's own members rather than from its value.
 */
function failureArgs(detail: LogFailure): EmissionArgs {
  if (typeof detail !== 'object' || detail === null) {
    return { fields: undefined, thrown: undefined, hasThrown: false };
  }

  return {
    fields: detail.fields,
    thrown: detail.thrown,
    hasThrown: Object.prototype.hasOwnProperty.call(detail, 'thrown'),
  };
}

function toMessage(message: string): string {
  return typeof message === 'string' ? message : describeValue(message);
}

function toSubsystem(value: string | undefined): string {
  if (typeof value !== 'string') {
    return DEFAULT_SUBSYSTEM;
  }

  const trimmed = value.trim();

  return trimmed.length === 0 ? DEFAULT_SUBSYSTEM : trimmed;
}

/**
 * Normalises one value inside a caller's field bag to bounded JSON data.
 *
 * Structural and recursive, and it shares nothing with its argument at any
 * depth: a string is clamped to `MAX_FIELD_STRING_LENGTH`, a finite number,
 * a boolean and `null` are carried as they are, an array and a plain object
 * are rebuilt entry by entry within `MAX_FIELD_BREADTH`, and every other
 * value — a function, a symbol, a bigint, a class instance, a `Date`, a
 * `Map`, a non-finite number — is reduced to a bounded printable
 * description. A repeated reference resolves to `CIRCULAR_PLACEHOLDER`, and
 * anything beyond `MAX_FIELD_DEPTH` or the shared node allowance resolves to
 * `TRUNCATED_VALUE`.
 *
 * Object members are written with `Object.defineProperty` and a member named
 * `__proto__` is dropped, so a caller's bag cannot reach the copy's
 * prototype. Total and non-throwing: every read is guarded and a member
 * whose accessor throws is carried as `UNREADABLE_VALUE`.
 *
 * @param value Value to normalise.
 * @param depth Enclosing objects and arrays already descended through.
 * @param budget Allowance shared by the whole normalisation.
 * @param seen Objects already visited on this pass.
 * @returns The bounded JSON form of `value`.
 */
function normalizeFieldValue(
  value: unknown,
  depth: number,
  budget: FieldBudget,
  seen: WeakSet<object>
): LogFieldValue {
  if (budget.remaining <= 0) {
    return TRUNCATED_VALUE;
  }

  budget.remaining -= 1;

  if (value === null || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : describeValue(value);
  }

  if (typeof value === 'string') {
    return clamp(value, MAX_FIELD_STRING_LENGTH);
  }

  if (typeof value === 'function') {
    return FUNCTION_PLACEHOLDER;
  }

  if (value === undefined) {
    // Carried as `null` rather than described or dropped, so the value a
    // record holds is the value `JSON.stringify` would render.
    return null;
  }

  if (typeof value !== 'object') {
    // A bigint and a symbol both reach here.
    return clamp(describeValue(value), MAX_FIELD_STRING_LENGTH);
  }

  if (seen.has(value)) {
    return CIRCULAR_PLACEHOLDER;
  }

  if (depth >= MAX_FIELD_DEPTH) {
    return DEPTH_PLACEHOLDER;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    const elements: LogFieldValue[] = [];
    const length = Math.min(value.length, MAX_FIELD_BREADTH);

    for (let index = 0; index < length; index += 1) {
      elements.push(
        normalizeFieldValue(value[index], depth + 1, budget, seen)
      );
    }

    if (value.length > length) {
      elements.push(TRUNCATED_VALUE);
    }

    return Object.freeze(elements);
  }

  const prototype: unknown = Object.getPrototypeOf(value);

  if (prototype !== Object.prototype && prototype !== null) {
    // A `Date`, a `Map`, a `Set` or a class instance is described rather
    // than walked: its own enumerable members are not its contents.
    return clamp(describeValue(value), MAX_FIELD_STRING_LENGTH);
  }

  return normalizeFieldRecord(
    value as Record<string, unknown>,
    depth,
    budget,
    seen
  );
}

/**
 * Normalises one plain object inside a caller's field bag.
 *
 * @param source Object to normalise.
 * @param depth Enclosing objects and arrays already descended through.
 * @param budget Allowance shared by the whole normalisation.
 * @param seen Objects already visited on this pass.
 * @returns A frozen object carrying at most `MAX_FIELD_BREADTH` members.
 */
function normalizeFieldRecord(
  source: Record<string, unknown>,
  depth: number,
  budget: FieldBudget,
  seen: WeakSet<object>
): LogFieldValue {
  const copy = Object.create(null) as Record<string, LogFieldValue>;
  let written = 0;
  let dropped = false;
  let keys: string[] = [];

  try {
    keys = Object.keys(source);
  } catch {
    return UNREADABLE_VALUE;
  }

  for (const key of keys) {
    if (FORBIDDEN_FIELD_KEYS.has(key)) {
      continue;
    }

    if (written >= MAX_FIELD_BREADTH) {
      dropped = true;
      break;
    }

    let member: unknown;

    try {
      member = source[key];
    } catch {
      member = UNREADABLE_VALUE;
    }


    Object.defineProperty(copy, clamp(key, MAX_FIELD_KEY_LENGTH), {
      value: normalizeFieldValue(member, depth + 1, budget, seen),
      writable: true,
      enumerable: true,
      configurable: true,
    });

    written += 1;
  }

  if (dropped) {
    Object.defineProperty(copy, TRUNCATED_FIELD_KEY, {
      value: TRUNCATED_VALUE,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  return Object.freeze(copy);
}

/**
 * Normalises a caller's field bag to bounded JSON data.
 *
 * Replaces the shallow copy the bag used to receive: every value is
 * normalised through `normalizeFieldValue`, so a record cannot carry a
 * structure the caller keeps a reference into, one that grows without limit,
 * or one `JSON.stringify` cannot render.
 *
 * @param fields Bag as supplied.
 * @returns A frozen bounded copy, or `undefined` when there is nothing to
 *   carry.
 */
function copyFields(fields: LogFields | undefined): LogFields | undefined {
  if (fields === undefined || fields === null) {
    return undefined;
  }

  if (typeof fields !== 'object') {
    return undefined;
  }

  const budget: FieldBudget = { remaining: MAX_FIELD_NODES };
  const seen = new WeakSet<object>();

  // The bag itself counts as entered, so a member referring back to it is cut
  // at the first level rather than one level down.
  seen.add(fields);

  const normalised = normalizeFieldRecord(
    fields as Record<string, unknown>,
    0,
    budget,
    seen
  );

  if (typeof normalised !== 'object' || normalised === null) {
    return undefined;
  }

  if (Object.keys(normalised).length === 0) {
    return undefined;
  }

  return normalised as LogFields;
}

function resolveCapacity(capacity: number | undefined): number {
  if (typeof capacity !== 'number' || !Number.isFinite(capacity)) {
    return DEFAULT_LOG_BUFFER_CAPACITY;
  }

  const rounded = Math.floor(capacity);

  if (rounded < MIN_LOG_BUFFER_CAPACITY) {
    return MIN_LOG_BUFFER_CAPACITY;
  }

  if (rounded > MAX_LOG_BUFFER_CAPACITY) {
    return MAX_LOG_BUFFER_CAPACITY;
  }

  return rounded;
}

/**
 * Resolves the correlation identifier a logger carries.
 *
 * @param options Options the logger was built with.
 * @returns `options.correlationId` when it is a non-empty string, otherwise
 *   the identifier derived from `options.runSeed`.
 */
function resolveCorrelationId(options: LoggerOptions): CorrelationId {
  const provided = options.correlationId;

  if (typeof provided === 'string' && provided.length > 0) {
    return provided;
  }

  return deriveCorrelationId(options.runSeed ?? '');
}

function buildRecord(
  state: LoggerState,
  subsystem: string,
  level: LogLevel,
  message: string,
  args: EmissionArgs
): LogRecord {
  const record: MutableRecord = {
    level,
    message: toMessage(message),
    timestamp: readTimestamp(),
    elapsedMs: readElapsedMs(),
    correlationId: state.correlationId,
    subsystem,
  };

  const fields = copyFields(args.fields);

  if (fields !== undefined) {
    record.fields = fields;
  }

  if (args.hasThrown) {
    record.error = serializeError(args.thrown, state.stackDetail);
  }

  enforceRecordBudget(record);

  return Object.freeze(record);
}

/**
 * Reduces a record until its JSON form fits `MAX_RECORD_LENGTH`.
 *
 * Three steps, in order, each measured before the next is taken: the
 * structured fields are replaced with a marker, the stack of the reported
 * error is dropped, and the message is clamped. A record that still does not
 * fit after all three is left as it stands — the remaining members are the
 * six fixed ones, whose combined size is bounded by their own limits.
 *
 * @param record Record to reduce, in place, before it is frozen.
 */
function enforceRecordBudget(record: MutableRecord): void {
  if (measureRecord(record) <= MAX_RECORD_LENGTH) {
    return;
  }

  if (record.fields !== undefined) {
    record.fields = Object.freeze({ [TRUNCATED_FIELD_KEY]: TRUNCATED_VALUE });

    if (measureRecord(record) <= MAX_RECORD_LENGTH) {
      return;
    }
  }

  const error = record.error;

  if (error !== undefined && error.stack !== undefined) {
    record.error = stripStack(error);

    if (measureRecord(record) <= MAX_RECORD_LENGTH) {
      return;
    }
  }

  record.message = clamp(record.message, MAX_ERROR_MESSAGE_LENGTH);
}

/**
 * Measures a record's JSON form.
 *
 * @param record Record to measure.
 * @returns The length in characters, or `MAX_RECORD_LENGTH + 1` where the
 *   record cannot be serialised at all, so an unserialisable record is
 *   reduced rather than passed through.
 */
function measureRecord(record: MutableRecord): number {
  const text = safeStringify(record);

  return text === null ? MAX_RECORD_LENGTH + 1 : text.length;
}

/**
 * Rebuilds a serialised error without its stack, keeping its cause chain.
 *
 * @param error Error to rebuild.
 * @returns A frozen error carrying no `stack`.
 */
function stripStack(error: SerializedError): SerializedError {
  const rebuilt: {
    name: string;
    message: string;
    cause?: SerializedError;
  } = { name: error.name, message: error.message };

  if (error.cause !== undefined) {
    rebuilt.cause = error.cause;
  }

  return Object.freeze(rebuilt);
}

/**
 * Rebuilds a serialised error with every source location in its stack — and
 * in the stack of every cause behind it — replaced.
 *
 * @param error Error to redact.
 * @returns The error itself where it carries no location to replace, and a
 *   frozen rebuilt error otherwise.
 */
function redactSerializedError(error: SerializedError): SerializedError {
  const cause =
    error.cause === undefined
      ? undefined
      : redactSerializedError(error.cause);
  const stack =
    error.stack === undefined ? undefined : redactLocations(error.stack);

  if (stack === error.stack && cause === error.cause) {
    return error;
  }

  const rebuilt: {
    name: string;
    message: string;
    stack?: string;
    cause?: SerializedError;
  } = { name: error.name, message: error.message };

  if (stack !== undefined) {
    rebuilt.stack = stack;
  }

  if (cause !== undefined) {
    rebuilt.cause = cause;
  }

  return Object.freeze(rebuilt);
}

/**
 * Redacts the reported error of one record for an export surface.
 *
 * Applied by `toJsonLines()` and by `snapshot()` whatever the logger's
 * `stackDetail` is, so a downloaded or snapshotted record never carries a
 * source location even where the sinks were given full stacks.
 *
 * @param record Record to redact.
 * @returns The record itself where it carries no location to replace, and a
 *   frozen rebuilt record otherwise.
 */
function redactRecordForExport(record: LogRecord): LogRecord {
  if (record.error === undefined) {
    return record;
  }

  const error = redactSerializedError(record.error);

  if (error === record.error) {
    return record;
  }

  const rebuilt: MutableRecord = { ...record, error };

  return Object.freeze(rebuilt);
}

/**
 * Writes one record into the ring buffer, overwriting the oldest record once
 * the buffer is full.
 *
 * @param state Shared state holding the buffer.
 * @param record Record to store.
 */
function storeRecord(state: LoggerState, record: LogRecord): void {
  if (state.stored === state.capacity) {
    state.dropped += 1;
  } else {
    state.stored += 1;
  }

  state.buffer[state.nextIndex] = record;
  state.nextIndex = (state.nextIndex + 1) % state.capacity;
}

function recentRecords(
  state: LoggerState,
  limit: number | undefined
): LogRecord[] {
  const available = state.stored;
  const requested =
    typeof limit === 'number' && Number.isFinite(limit)
      ? Math.floor(limit)
      : available;
  const take = Math.max(0, Math.min(available, requested));
  const oldest =
    (state.nextIndex - available + state.capacity) % state.capacity;
  const start = oldest + (available - take);
  const records: LogRecord[] = [];

  for (let offset = 0; offset < take; offset += 1) {
    const entry = state.buffer[(start + offset) % state.capacity];

    if (entry !== undefined) {
      records.push(entry);
    }
  }

  return records;
}

function buildJsonLines(
  state: LoggerState,
  limit: number | undefined
): string {
  let text = '';

  // The export surface redacts whatever the logger's `stackDetail` is.
  for (const record of recentRecords(state, limit)) {
    text += `${stringifyRecord(redactRecordForExport(record))}\n`;
  }

  return text;
}

function buildSnapshot(
  state: LoggerState,
  subsystem: string,
  limit: number | undefined
): LoggerSnapshot {
  const snapshot: MutableSnapshot = {
    correlationId: state.correlationId,
    subsystem,
    level: state.level,
    capacity: state.capacity,
    stored: state.stored,
    emitted: state.emitted,
    dropped: state.dropped,
    sinkCount: state.registrations.length,
    sinkFaults: state.sinkFaults,
    // The export surface redacts whatever the logger's `stackDetail` is.
    records: recentRecords(state, limit).map(redactRecordForExport),
  };

  if (state.lastSinkFault !== undefined) {
    snapshot.lastSinkFault = state.lastSinkFault;
  }

  return Object.freeze(snapshot);
}

function clearBuffer(state: LoggerState): void {
  state.buffer.fill(undefined);
  state.nextIndex = 0;
  state.stored = 0;
}

function subscribeSink(state: LoggerState, sink: LogSink): () => void {
  if (typeof sink !== 'function') {
    return NOOP_UNSUBSCRIBE;
  }

  const registration: SinkRegistration = { sink };

  state.registrations.push(registration);

  let active = true;

  return (): void => {
    if (!active) {
      return;
    }

    active = false;

    const index = state.registrations.indexOf(registration);

    if (index >= 0) {
      state.registrations.splice(index, 1);
    }
  };
}

function writeConsoleLine(state: LoggerState, record: LogRecord): void {
  if (!state.consoleOutput) {
    return;
  }

  const writer = resolveConsoleWriter(record.level);

  if (writer === null) {
    return;
  }

  try {
    writer(stringifyRecord(record));
  } catch {
    return;
  }
}

function dispatchRecord(state: LoggerState, record: LogRecord): void {
  for (const registration of state.registrations.slice()) {
    try {
      registration.sink(record);
    } catch (thrown) {
      state.sinkFaults += 1;
      state.lastSinkFault = serializeError(thrown);
    }
  }
}

function emit(
  state: LoggerState,
  subsystem: string,
  level: LogLevel,
  message: string,
  args: EmissionArgs
): void {
  if (LOG_LEVEL_SEVERITY[level] < LOG_LEVEL_SEVERITY[state.level]) {
    return;
  }

  let record: LogRecord;

  try {
    record = buildRecord(state, subsystem, level, message, args);
  } catch {
    return;
  }

  state.emitted += 1;
  storeRecord(state, record);
  writeConsoleLine(state, record);
  dispatchRecord(state, record);
}

function createBoundLogger(state: LoggerState, subsystem: string): Logger {
  const logger: Logger = {
    correlationId: state.correlationId,

    subsystem,

    debug(message: string, fields?: LogFields): void {
      emit(state, subsystem, 'debug', message, {
        fields,
        thrown: undefined,
        hasThrown: false,
      });
    },

    info(message: string, fields?: LogFields): void {
      emit(state, subsystem, 'info', message, {
        fields,
        thrown: undefined,
        hasThrown: false,
      });
    },

    warn(
      message: string,
      fields?: LogFields,
      ...thrown: readonly unknown[]
    ): void {
      emit(state, subsystem, 'warn', message, positionalArgs(fields, thrown));
    },

    error(
      message: string,
      fields?: LogFields,
      ...thrown: readonly unknown[]
    ): void {
      emit(state, subsystem, 'error', message, positionalArgs(fields, thrown));
    },

    failure(level: LogLevel, message: string, detail: LogFailure): void {
      emit(
        state,
        subsystem,
        isLogLevel(level) ? level : DEFAULT_LOG_LEVEL,
        message,
        failureArgs(detail)
      );
    },

    child(nextSubsystem: string): Logger {
      return createBoundLogger(state, toSubsystem(nextSubsystem));
    },

    setLevel(level: LogLevel): void {
      if (isLogLevel(level)) {
        state.level = level;
      }
    },

    getLevel(): LogLevel {
      return state.level;
    },

    subscribe(sink: LogSink): () => void {
      return subscribeSink(state, sink);
    },

    recent(limit?: number): readonly LogRecord[] {
      return recentRecords(state, limit);
    },

    toJsonLines(limit?: number): string {
      return buildJsonLines(state, limit);
    },

    snapshot(limit?: number): LoggerSnapshot {
      return buildSnapshot(state, subsystem, limit);
    },

    clear(): void {
      clearBuffer(state);
    },
  };

  return Object.freeze(logger);
}

/**
 * Builds a logger and the state its children share.
 *
 * @returns The frozen logger.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const capacity = resolveCapacity(options.capacity);

  const state: LoggerState = {
    correlationId: resolveCorrelationId(options),
    level: isLogLevel(options.level) ? options.level : DEFAULT_LOG_LEVEL,
    registrations: [],
    buffer: new Array<LogRecord | undefined>(capacity).fill(undefined),
    capacity,
    nextIndex: 0,
    stored: 0,
    dropped: 0,
    emitted: 0,
    sinkFaults: 0,
    lastSinkFault: undefined,
    consoleOutput: options.consoleOutput !== false,
    stackDetail:
      options.stackDetail === 'full' ? 'full' : DEFAULT_STACK_DETAIL,
  };

  return createBoundLogger(state, toSubsystem(options.subsystem));
}

// src/engine/types.ts, src/input/keymap.ts and src/storage/
// local-storage-manager.ts each declare their own reporter contract and import
// nothing from this folder. The three factories below are the logger-backed
// implementations of those contracts, for a composition root to inject.

const ENGINE_SUBSYSTEM = 'engine';

const INPUT_SUBSYSTEM = 'input';

const STORAGE_SUBSYSTEM = 'storage';

/**
 * Input field names this adapter never copies into a record.
 *
 * `KeyboardEvent.key` and `KeyboardEvent.code` name the character a player
 * pressed. src/input/input-manager.ts no longer reports either — it reports
 * a bounded category instead — and this list is the second guard on the
 * same rule: a member under one of these names is dropped here whatever
 * reports it, so a keystroke cannot reach the log buffer, the console or a
 * sink even if a later input module were to offer one. The names cover the
 * verbatim members of a keyboard event and the free-text members of an
 * editable field.
 */
const REJECTED_INPUT_FIELDS: ReadonlySet<string> = new Set([
  'key',
  'keys',
  'code',
  'codes',
  'char',
  'chars',
  'character',
  'text',
  'value',
  'password',
]);

/** Fields one input report contributes to a record. */
const MAX_INPUT_FIELDS = 16;

/** Characters one input field's string value contributes. */
const MAX_INPUT_FIELD_LENGTH = 64;

/**
 * Copies an input report's fields under this adapter's own bounds.
 *
 * Categorical and bounded: a rejected name is dropped, a string value is
 * capped short enough that no free text survives it, and the member count
 * is capped so one report cannot fill a record.
 *
 * @param fields Fields the input layer reported, if any.
 * @param into Bag the copies are written into.
 */
function copyInputFields(
  fields: InputReportFields | undefined,
  into: Record<string, LogFieldValue>
): void {
  if (fields === undefined || fields === null) {
    return;
  }

  let kept = 0;

  for (const name of Object.keys(fields)) {
    if (REJECTED_INPUT_FIELDS.has(name) || kept >= MAX_INPUT_FIELDS) {
      continue;
    }

    const value: string | number | boolean = fields[name];

    into[name] =
      typeof value === 'string'
        ? value.slice(0, MAX_INPUT_FIELD_LENGTH)
        : value;
    kept += 1;
  }
}

/**
 * Emits through a logger at a level chosen at run time.
 *
 * @param logger Logger to emit through.
 * @param level Severity.
 * @param message Message to record.
 * @param fields Optional structured fields.
 */
function writeAtLevel(
  logger: Logger,
  level: LogLevel,
  message: string,
  fields?: LogFields
): void {
  if (level === 'debug') {
    logger.debug(message, fields);

    return;
  }

  if (level === 'info') {
    logger.info(message, fields);

    return;
  }

  if (level === 'warn') {
    logger.warn(message, fields);

    return;
  }

  logger.error(message, fields);
}

function toLogLevel(level: InputReportLevel): LogLevel {
  return isLogLevel(level) ? level : DEFAULT_LOG_LEVEL;
}

/**
 * Builds the engine's reporter.
 *
 * Records every contained hook-handler throw and every contained event-listener
 * throw at `'error'`, with the thrown value serialised onto `LogRecord.error`,
 * and every engine counter at `'debug'`. ALL THREE members of `EngineReporter`
 * are implemented: `onListenerError` was previously omitted, so every error a
 * listener raised was contained by the emitter and then reported nowhere.
 *
 * `reportedCorrelationId` carries the identifier the engine was injected
 * with, beside the record's own `correlationId`, so a mismatch between the
 * two is visible in the log stream rather than silent.
 *
 * Each record carries both identifiers of its report: `correlationId`, which
 * is the same value `LogRecord.correlationId` holds when the logger was built
 * with the run's canonical identifier, and `runId`, which is the run-instance
 * identifier the two are distinguished by.
 *
 * @returns A frozen reporter tagged `'engine'`.
 */
export function createEngineReporter(logger: Logger): EngineReporter {
  const scoped = logger.child(ENGINE_SUBSYSTEM);

  const reporter: EngineReporter = Object.freeze({
    onHookError(report: EngineHookErrorReport): void {
      // `failure` rather than the positional form: the report's `error` is
      // `unknown`, so a handler that threw a plain object, an array, `null`
      // or `undefined` still reaches `LogRecord.error`.
      scoped.failure('error', 'A hook handler threw and was contained.', {
        thrown: report.error,
        fields: {
          reportedCorrelationId: report.correlationId,
          hook: report.hook,
          subscriberId: report.subscriberId,
        },
      });
    },

    onListenerError(report: EngineListenerErrorReport): void {
      // `failure` for the same reason as `onHookError`: the caught value
      // arrives unconverted, so a listener that threw a non-`Error` — or an
      // `Error` carrying a cause chain — reaches `LogRecord.error` whole.
      // The listener's position in registration order is the only identity an
      // event listener has, so it is the identity recorded.
      scoped.failure(
        'error',
        'An event listener threw and was contained; the emission continued.',
        {
          thrown: report.error,
          fields: {
            reportedCorrelationId: report.correlationId,
            event: report.event,
            listenerIndex: report.listenerIndex,
          },
        },
      );
    },

    onCount(report: EngineCountReport): void {
      // `hook` and `event` are separate dimensions and a report carries at
      // most one, so both are recorded and the absent one is `null`. Event
      // names previously arrived under `hook`; recording only that field
      // would now drop the event name from every event count.
      scoped.debug('Engine counter incremented.', {
        reportedCorrelationId: report.correlationId,
        metric: report.metric,
        value: report.value,
        hook: report.hook ?? null,
        event: report.event ?? null,
      });
    },
  });

  return reporter;
}

/**
 * Reports whether a logger would emit at a level.
 *
 * @param logger Logger to ask.
 * @param level Level a record would be emitted at.
 * @returns Whether a record at `level` would survive the logger's filter.
 */
function emitsAt(logger: Logger, level: LogLevel): boolean {
  return LOG_LEVEL_SEVERITY[level] >= LOG_LEVEL_SEVERITY[logger.getLevel()];
}

/**
 * The span handed back when the level a span records at is filtered out. One
 * frozen instance is shared, since it holds no state and its `end()` has
 * nothing to record.
 */
const DISCARDED_SPAN: InputSpan = Object.freeze({
  end(): void {
    // The record this span would have written is filtered out.
  },
});

/**
 * Builds one timing span that records its own duration when it closes.
 *
 * Spans record at `'debug'`. Where that level is filtered out the shared
 * `DISCARDED_SPAN` is returned instead, so an open-and-close pair on a hot
 * path allocates nothing and reads no clock.
 *
 * @param logger Logger the span records through.
 * @param name Span name.
 * @returns A frozen span. A second `end()` records nothing further.
 */
function createLoggedSpan(logger: Logger, name: string): InputSpan {
  if (!emitsAt(logger, 'debug')) {
    return DISCARDED_SPAN;
  }

  const startedAt = readElapsedMs();
  let closed = false;

  return Object.freeze({
    end(): void {
      if (closed) {
        return;
      }

      closed = true;

      logger.debug('Span closed.', {
        span: name,
        durationMs: Math.max(readElapsedMs() - startedAt, 0),
      });
    },
  });
}

/**
 * Builds the input layer's reporter.
 *
 * Records messages at the level the input layer reports, counters at `'debug'`
 * with the caller's fields merged beneath `metric` and `value`, and spans at
 * `'debug'` with the elapsed `durationMs`. All three members of
 * `InputReporter` are implemented, the optional `startSpan` included.
 *
 * Every field a report carries passes through `copyInputFields`, which
 * drops the raw-keystroke names of `REJECTED_INPUT_FIELDS` and bounds what
 * remains, so no record carries a character a player typed.
 *
 * @param logger Logger the reports are recorded through.
 * @returns A frozen reporter tagged `'input'`.
 */
export function createInputReporter(logger: Logger): InputReporter {
  const scoped = logger.child(INPUT_SUBSYSTEM);

  const reporter: InputReporter = {
    log(
      level: InputReportLevel,
      message: string,
      fields?: InputReportFields
    ): void {
      const bounded: Record<string, LogFieldValue> = {};

      copyInputFields(fields, bounded);
      writeAtLevel(scoped, toLogLevel(level), message, bounded);
    },

    count(metric: string, fields?: InputReportFields): void {
      // Counters record at `'debug'`, so the clone below is wasted work
      // whenever that level is filtered out. Every input event counts at
      // least once, which makes this the hottest path in the module.
      if (!emitsAt(scoped, 'debug')) {
        return;
      }

      const merged: Record<string, LogFieldValue> = {};

      copyInputFields(fields, merged);

      merged['metric'] = metric;
      merged['value'] = 1;

      scoped.debug('Input counter incremented.', merged);
    },

    failure(
      level: InputReportLevel,
      message: string,
      thrown: unknown,
      fields?: InputReportFields
    ): void {
      const bounded: Record<string, LogFieldValue> = {};

      copyInputFields(fields, bounded);

      // The caught value arrives unconverted, so `serializeError` keeps the
      // name, the message, the stack and the cause chain that a name-and-
      // message reduction in src/input/ used to discard.
      scoped.failure(toLogLevel(level), message, {
        thrown,
        fields: bounded,
      });
    },

    startSpan(name: string): InputSpan {
      return createLoggedSpan(scoped, name);
    },
  };

  return Object.freeze(reporter);
}

/**
 * Builds the storage layer's reporter.
 *
 * All three members of `StorageReporter` are implemented, and the three carry
 * DIFFERENT WEIGHTS, because the adapter is where the storage layer's two
 * report channels are deduplicated.
 *
 * ONE FAILURE, ONE ERROR-LEVEL RECORD. The storage layer reports a failed probe
 * on both `onProbe` and `onFailure`, and a failed write on both `onWrite` and
 * `onFailure`, which is deliberate: each channel answers a different
 * question. But reporting both at warning level or above produced two records
 * per failure. `onFailure` is therefore the ONE channel that records a failure
 * at `'warn'` or `'error'`; `onProbe` and `onWrite` are outcome-and-state
 * channels that record at `'debug'` whatever the outcome, except for a probe
 * that failed without anything being thrown, which reaches no failure channel
 * at all and so keeps its own `'warn'`.
 *
 * THE PUBLIC-MESSAGE POLICY. Every message and every field a record leads with
 * comes from this module or from the bounded `StorageErrorInfo` the storage
 * layer authored: neither carries text supplied by the platform, an extension
 * or whatever threw, and neither carries an excerpt of a stored value. The
 * value that WAS thrown reaches `LogRecord.error` through
 * `StorageFailure.thrown`, unconverted, so its stack, its cause chain and its
 * non-`Error` structure survive for diagnosis — which a reduction to a name and
 * a message could not carry.
 *
 * Sink for the two silent-failure sites at js/local_storage_manager.js L47-L49
 * and L54.
 *
 * @returns A frozen reporter tagged `'storage'`.
 */
export function createStorageReporter(logger: Logger): StorageReporter {
  const scoped = logger.child(STORAGE_SUBSYSTEM);

  const reporter: StorageReporter = Object.freeze({
    onProbe(result: StorageProbeResult): void {
      const fields: LogFields = {
        supported: result.supported,
        strategy: result.strategy,
        quota: result.error !== undefined && result.error.quota,
      };

      if (result.supported) {
        scoped.info('Web Storage probe succeeded.', fields);

        return;
      }

      const message = 'Web Storage probe failed; the in-memory store is in use.';

      if (result.error === undefined) {
        // No value was caught — the origin exposes no store at all — so the
        // storage layer raises no failure for it. This is the one probe
        // outcome with no second channel, so it keeps the warning, and no
        // `LogRecord.error` is invented for a value that does not exist.
        scoped.warn(message, fields);

        return;
      }

      // A probe that caught something is also delivered to `onFailure`, which
      // records it at warning level with the thrown value. This record is
      // therefore the outcome and the strategy alone, at `'debug'`.
      scoped.debug(message, fields);
    },

    onWrite(info: StorageWriteInfo): void {
      const fields: LogFields = {
        key: info.key,
        byteLength: info.byteLength,
        ok: info.ok,
      };

      // Both outcomes at `'debug'`: a write that did not complete has already
      // been delivered to `onFailure`, which records it at warning level with
      // the thrown value, so raising this one would duplicate it. `ok` is what
      // distinguishes the two records.
      scoped.debug(
        info.ok
          ? 'A storage write completed.'
          : 'A storage write did not complete.',
        fields,
      );
    },

    onFailure(failure: StorageFailure): void {
      const fields: LogFields = {
        operation: failure.operation,
        key: failure.key,
        strategy: failure.strategy,
        quota: failure.error.quota,

        // The bounded description the storage layer authored. Recorded as a
        // field so a consumer that publishes rather than diagnoses has a
        // scrubbed string without reading `LogRecord.error`.
        publicMessage: failure.error.message,
        errorName: failure.error.name,
      };

      // The ORIGINAL caught value, not the reduction of it: a `StorageFailure`
      // carries both, and the reduction is already in the fields above. A
      // refused key throws nothing, so `thrown` is absent there and the
      // description stands in for it.
      const thrown: unknown =
        'thrown' in failure && failure.thrown !== undefined
          ? failure.thrown
          : failure.error;

      if (failure.error.quota) {
        scoped.failure('error', 'A storage operation exhausted the quota.', {
          thrown,
          fields,
        });

        return;
      }

      scoped.failure('warn', 'A storage operation failed.', {
        thrown,
        fields,
      });
    },
  });

  return reporter;
}
