// Structured logging for the observability layer: the run correlation
// identifier, error serialisation, the log record, the level filter, the sink
// registry, the bounded recent-record buffer, the JSON-lines export, and the
// three adapters that satisfy the reporter contracts src/engine, src/input and
// src/storage each declare for themselves.
//
// Source construct, carried as a target row in docs/TRACEABILITY_MATRIX.md:
// the discarded-error `catch` at js/local_storage_manager.js L37-L39, which
// bound `error` and returned `false` without reporting it. `serializeError`
// below is its target. Two further silent-failure sites in that same file
// report through `createStorageReporter`: the unguarded `setItem` at
// L47-L49 and the unguarded `JSON.parse` at L54.
//
// Decision surfaced for docs/DECISION_LOG.md: the correlation identifier is a
// deterministic hash of the run seed rather than a random identifier.
//
// The module's only imports are the three reporter contracts, imported as
// types and therefore erased at build time. It names no package, no sibling
// observability module and no DOM node: `console` and `performance` are
// reached through `globalThis`, and every access to them is guarded. No
// exported member of this module throws.

import type {
  EngineCountReport,
  EngineHookErrorReport,
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

/* --------------------------------------------------------------------------
 * Correlation identifier
 * ----------------------------------------------------------------------- */

/** Prefix every derived correlation identifier carries. */
const CORRELATION_ID_PREFIX = 'run-';

/** FNV-1a 32-bit offset basis. */
const FNV_OFFSET_BASIS = 0x811c9dc5;

/** FNV-1a 32-bit prime. */
const FNV_PRIME = 0x01000193;

/** djb2 initial accumulator. */
const DJB2_BASIS = 5381;

/** djb2 multiplier. */
const DJB2_MULTIPLIER = 33;

/** Radix each hash is rendered in. */
const HASH_RADIX = 36;

/** Character width each rendered hash is padded to. */
const HASH_WIDTH = 7;

/**
 * FNV-1a 32-bit hash over the UTF-16 code units of `text`.
 *
 * @param text Text to hash.
 * @returns The hash as an unsigned 32-bit integer.
 */
function fnv1a32(text: string): number {
  let hash = FNV_OFFSET_BASIS;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }

  return hash >>> 0;
}

/**
 * djb2 32-bit hash over the UTF-16 code units of `text`.
 *
 * @param text Text to hash.
 * @returns The hash as an unsigned 32-bit integer.
 */
function djb2Hash32(text: string): number {
  let hash = DJB2_BASIS;

  for (let index = 0; index < text.length; index += 1) {
    hash = (Math.imul(hash, DJB2_MULTIPLIER) + text.charCodeAt(index)) | 0;
  }

  return hash >>> 0;
}

/**
 * Renders a 32-bit hash as fixed-width base36 text.
 *
 * @param hash Hash to render.
 * @returns Exactly `HASH_WIDTH` characters, zero-padded on the left.
 */
function renderHash(hash: number): string {
  return (hash >>> 0).toString(HASH_RADIX).padStart(HASH_WIDTH, '0');
}

/**
 * Derives the run correlation identifier that every log record carries.
 *
 * The identifier is `run-` followed by two fixed-width base36 hashes of the
 * seed, FNV-1a then djb2. The derivation reads no clock and no randomness: one
 * seed yields one identifier, in this process and in any later one.
 *
 * @param runSeed Run seed, exactly as the run was seeded with.
 * @returns An 18-character identifier, non-empty for every input, the empty
 *   string included.
 */
export function deriveCorrelationId(runSeed: string): string {
  const seed = String(runSeed);

  return (
    CORRELATION_ID_PREFIX +
    renderHash(fnv1a32(seed)) +
    renderHash(djb2Hash32(seed))
  );
}

/* --------------------------------------------------------------------------
 * JSON serialisation
 * ----------------------------------------------------------------------- */

/** Substituted for the second and any later occurrence of one object. */
const CIRCULAR_PLACEHOLDER = '[circular]';

/** Substituted for a function reached by the serialiser. */
const FUNCTION_PLACEHOLDER = '[function]';

/** Substituted for a value whose own description could not be read. */
const UNREADABLE_VALUE = '[unreadable value]';

/** Emitted in place of a record whose fields could not be serialised. */
const UNSERIALISABLE_FIELDS = '[unserialisable fields]';

/** Longest description `describeValue` returns before truncating. */
const MAX_DESCRIPTION_LENGTH = 240;

/** Appended to a truncated description. */
const TRUNCATION_SUFFIX = '…';

/**
 * `JSON.stringify` replacer: substitutes repeated object references,
 * functions and bigints, all three of which `JSON.stringify` alone either
 * throws on or silently drops.
 *
 * @param seen Objects already visited by this pass.
 * @returns A replacer bound to `seen`.
 */
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

/**
 * Serialises `value` to JSON text without throwing.
 *
 * @param value Value to serialise.
 * @returns The JSON text, or `null` when the value cannot be serialised at
 *   all.
 */
function safeStringify(value: unknown): string | null {
  try {
    const text = JSON.stringify(value, createReplacer(new WeakSet<object>()));

    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/**
 * Truncates `text` to `MAX_DESCRIPTION_LENGTH` characters.
 *
 * @param text Text to shorten.
 * @returns `text` unchanged when it is short enough, otherwise its prefix
 *   with `TRUNCATION_SUFFIX` appended.
 */
function truncate(text: string): string {
  if (text.length <= MAX_DESCRIPTION_LENGTH) {
    return text;
  }

  return text.slice(0, MAX_DESCRIPTION_LENGTH) + TRUNCATION_SUFFIX;
}

/**
 * Describes any value as a single line of text, without throwing.
 *
 * @param value Value to describe.
 * @returns A printable description, truncated to
 *   `MAX_DESCRIPTION_LENGTH` characters.
 */
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

/* --------------------------------------------------------------------------
 * Error serialisation
 * ----------------------------------------------------------------------- */

/** Name reported for a thrown value that carries no string `name`. */
const UNKNOWN_ERROR_NAME = 'UnknownError';

/** Deepest `cause` a serialised error carries. */
const MAX_CAUSE_DEPTH = 4;

/**
 * A thrown value reduced to JSON-serialisable fields. Every log record that
 * reports a failure carries one.
 */
export interface SerializedError {
  /** The value's own `name` when it has one, otherwise `'UnknownError'`. */
  readonly name: string;

  /**
   * The value's own `message` when it has one, otherwise a printable
   * description of the value itself.
   */
  readonly message: string;

  /** The value's own `stack`, absent when it carries none. */
  readonly stack?: string;

  /**
   * The value's own `cause`, serialised the same way. Absent when the value
   * carries none, when the cause is `null` or `undefined`, and beyond
   * `MAX_CAUSE_DEPTH` links.
   */
  readonly cause?: SerializedError;
}

/** Returned when serialisation itself fails. */
const FALLBACK_SERIALIZED_ERROR: SerializedError = Object.freeze({
  name: UNKNOWN_ERROR_NAME,
  message: UNREADABLE_VALUE,
});

/**
 * Reads one string-valued member off an object, without throwing.
 *
 * @param holder Object to read from.
 * @param key Member to read.
 * @returns The string value, or `undefined` when the member is absent, is not
 *   a string, or its accessor throws.
 */
function readStringMember(holder: object, key: string): string | undefined {
  try {
    const value: unknown = (holder as Record<string, unknown>)[key];

    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads and serialises the `cause` of a thrown object, without throwing.
 *
 * @param holder Object to read from.
 * @param depth Number of causes already followed.
 * @returns The serialised cause, or `undefined` when there is none to carry.
 */
function readCause(
  holder: object,
  depth: number
): SerializedError | undefined {
  if (depth >= MAX_CAUSE_DEPTH) {
    return undefined;
  }

  try {
    const cause: unknown = (holder as { cause?: unknown }).cause;

    if (cause === undefined || cause === null) {
      return undefined;
    }

    return serializeThrown(cause, depth + 1);
  } catch {
    return undefined;
  }
}

/**
 * Assembles a frozen `SerializedError`, omitting the optional members that
 * have no value.
 *
 * @param name Error name.
 * @param message Error message.
 * @param stack Stack text, when there is one.
 * @param cause Serialised cause, when there is one.
 * @returns The frozen record.
 */
function buildSerializedError(
  name: string,
  message: string,
  stack: string | undefined,
  cause: SerializedError | undefined
): SerializedError {
  const record: {
    name: string;
    message: string;
    stack?: string;
    cause?: SerializedError;
  } = { name, message };

  if (stack !== undefined) {
    record.stack = stack;
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
 * @returns The serialised value.
 */
function serializeThrown(thrown: unknown, depth: number): SerializedError {
  try {
    if (typeof thrown === 'object' && thrown !== null) {
      return buildSerializedError(
        readStringMember(thrown, 'name') ?? UNKNOWN_ERROR_NAME,
        readStringMember(thrown, 'message') ?? describeValue(thrown),
        readStringMember(thrown, 'stack'),
        readCause(thrown, depth)
      );
    }

    return buildSerializedError(
      UNKNOWN_ERROR_NAME,
      describeValue(thrown),
      undefined,
      undefined
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
 * all handled: this function never throws and always returns a record.
 *
 * Target of the discarded-error `catch` at js/local_storage_manager.js
 * L37-L39.
 *
 * @param thrown Value that was thrown, exactly as it was caught.
 * @returns The serialised value.
 */
export function serializeError(thrown: unknown): SerializedError {
  return serializeThrown(thrown, 0);
}

/* --------------------------------------------------------------------------
 * Levels
 * ----------------------------------------------------------------------- */

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

/** Level a logger built without one starts at. */
const DEFAULT_LOG_LEVEL: LogLevel = 'info';

/**
 * Narrows an arbitrary value to a known level.
 *
 * @param value Value to test.
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

/* --------------------------------------------------------------------------
 * Records and sinks
 * ----------------------------------------------------------------------- */

/** A value a structured field may carry. */
export type LogFieldValue =
  | string
  | number
  | boolean
  | null
  | readonly LogFieldValue[]
  | { readonly [key: string]: LogFieldValue };

/** The structured field bag a record carries. */
export interface LogFields {
  readonly [key: string]: LogFieldValue | undefined;
}

/**
 * One emitted log record. Every member is plain data: a record round-trips
 * through `JSON.parse(JSON.stringify(record))` unchanged. Records are frozen
 * before they reach the buffer, the console or a sink.
 */
export interface LogRecord {
  /** Severity the record was emitted at. */
  readonly level: LogLevel;

  /** The message, verbatim. */
  readonly message: string;

  /**
   * Wall-clock time of emission, ISO 8601. Empty when the wall clock could not
   * be read.
   */
  readonly timestamp: string;

  /**
   * Monotonic reading of `performance.now()` at emission, in milliseconds from
   * that clock's time origin. `0` when no such clock is available.
   */
  readonly elapsedMs: number;

  /** Correlation identifier of the run. Carried by every record. */
  readonly correlationId: string;

  /** Subsystem tag of the logger that emitted the record. */
  readonly subsystem: string;

  /** Structured fields, absent when the caller supplied none. */
  readonly fields?: LogFields;

  /** The reported failure, absent when the record reports none. */
  readonly error?: SerializedError;
}

/** A subscriber that receives every emitted record. */
export type LogSink = (record: LogRecord) => void;

/* --------------------------------------------------------------------------
 * Guarded platform access
 * ----------------------------------------------------------------------- */

/** A reader of a millisecond clock. */
type ClockReader = () => number;

/** A writer of one console line. */
type LineWriter = (line: string) => void;

/** Console member each level is written through. */
const CONSOLE_METHODS: Readonly<Record<LogLevel, string>> = Object.freeze({
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
});

/** Console member written through when a level's own member is missing. */
const CONSOLE_FALLBACK_METHOD = 'log';

/**
 * Narrows an arbitrary value to a clock reader.
 *
 * @param value Value to test.
 * @returns `true` when `value` is callable.
 */
function isClockReader(value: unknown): value is ClockReader {
  return typeof value === 'function';
}

/**
 * Narrows an arbitrary value to a line writer.
 *
 * @param value Value to test.
 * @returns `true` when `value` is callable.
 */
function isLineWriter(value: unknown): value is LineWriter {
  return typeof value === 'function';
}

/**
 * Resolves the monotonic clock through `globalThis`.
 *
 * @returns A reader bound to the host clock, or `null` when the environment
 *   exposes none.
 */
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
 * Reads the monotonic clock.
 *
 * @returns Milliseconds from the clock's time origin, or `0` when no clock
 *   answered with a finite number.
 */
function readElapsedMs(): number {
  const clock = resolveClock();

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

/**
 * Reads the wall clock.
 *
 * @returns The current time in ISO 8601, or the empty string when the clock
 *   could not be read.
 */
function readTimestamp(): string {
  try {
    return new Date().toISOString();
  } catch {
    return '';
  }
}

/**
 * Resolves the console writer for a level through `globalThis`, preferring the
 * member named after the level and falling back to `log`.
 *
 * @param level Level being written.
 * @returns A writer bound to the host console, or `null` when the environment
 *   exposes no member to write through.
 */
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

/**
 * Serialises a record to one line of JSON, retrying without the structured
 * fields when the record as a whole cannot be serialised.
 *
 * @param record Record to serialise.
 * @returns One line of JSON text, always parseable.
 */
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


/* --------------------------------------------------------------------------
 * Logger contract
 * ----------------------------------------------------------------------- */

/** Records the recent-record buffer holds when no capacity is supplied. */
export const DEFAULT_LOG_BUFFER_CAPACITY = 200;

/** Smallest buffer capacity accepted. */
const MIN_LOG_BUFFER_CAPACITY = 1;

/** Largest buffer capacity accepted. */
const MAX_LOG_BUFFER_CAPACITY = 10000;

/** Subsystem tag a logger built without one carries. */
const DEFAULT_SUBSYSTEM = 'app';

/** Settings `createLogger` accepts. */
export interface LoggerOptions {
  /**
   * Run seed the correlation identifier is derived from. Defaults to the empty
   * string, which derives a stable identifier of its own.
   */
  readonly runSeed?: string;

  /**
   * Correlation identifier carried verbatim. Takes precedence over `runSeed`
   * when it is a non-empty string.
   */
  readonly correlationId?: string;

  /** Level to start at. Defaults to `'info'`. */
  readonly level?: LogLevel;

  /** Subsystem tag of the returned logger. Defaults to `'app'`. */
  readonly subsystem?: string;

  /**
   * Records the recent-record buffer holds. Rounded down and clamped to
   * [1, 10000]; defaults to `DEFAULT_LOG_BUFFER_CAPACITY`.
   */
  readonly capacity?: number;

  /**
   * Whether records are also written to the console as JSON. Defaults to
   * `true`; only the exact value `false` turns it off.
   */
  readonly consoleOutput?: boolean;
}

/** A logger's state and its buffered records, as `snapshot()` reports them. */
export interface LoggerSnapshot {
  /** Correlation identifier every record carries. */
  readonly correlationId: string;

  /** Subsystem tag of the logger the snapshot was taken through. */
  readonly subsystem: string;

  /** Current level. */
  readonly level: LogLevel;

  /** Records the buffer holds when full. */
  readonly capacity: number;

  /** Records the buffer holds now. */
  readonly stored: number;

  /** Records emitted over the shared state's lifetime. */
  readonly emitted: number;

  /** Records evicted from the buffer over that lifetime. */
  readonly dropped: number;

  /** Sinks subscribed now. */
  readonly sinkCount: number;

  /** Sink calls that threw and were contained. */
  readonly sinkFaults: number;

  /** The most recent contained sink throw, absent when none has occurred. */
  readonly lastSinkFault?: SerializedError;

  /** The buffered records, oldest first. */
  readonly records: readonly LogRecord[];
}

/**
 * Structured logger.
 *
 * `debug` and `info` take a message and optional fields. `warn` and `error`
 * additionally take a thrown value, in either of the two argument positions: a
 * plain object that is neither an `Error` nor an array is read as fields, and
 * any other value is read as the thrown value.
 *
 * No member throws. A sink that throws, a console that throws, a field
 * accessor that throws and a circular field structure are all contained.
 */
export interface Logger {
  /** Correlation identifier every record from this logger carries. */
  readonly correlationId: string;

  /** Subsystem tag every record from this logger carries. */
  readonly subsystem: string;

  /**
   * Emits a record at `'debug'`.
   *
   * @param message Message to record.
   * @param fields Optional structured fields.
   */
  debug(message: string, fields?: LogFields): void;

  /**
   * Emits a record at `'info'`.
   *
   * @param message Message to record.
   * @param fields Optional structured fields.
   */
  info(message: string, fields?: LogFields): void;

  /**
   * Emits a record at `'warn'`.
   *
   * @param message Message to record.
   * @param fields Optional structured fields.
   * @param thrown Optional thrown value, serialised onto `LogRecord.error`.
   */
  warn(message: string, fields?: LogFields, thrown?: unknown): void;

  /**
   * Emits a record at `'warn'` for a thrown value.
   *
   * @param message Message to record.
   * @param thrown Thrown value, serialised onto `LogRecord.error`.
   * @param fields Optional structured fields.
   */
  warn(message: string, thrown: unknown, fields?: LogFields): void;

  /**
   * Emits a record at `'error'`.
   *
   * @param message Message to record.
   * @param fields Optional structured fields.
   * @param thrown Optional thrown value, serialised onto `LogRecord.error`.
   */
  error(message: string, fields?: LogFields, thrown?: unknown): void;

  /**
   * Emits a record at `'error'` for a thrown value.
   *
   * @param message Message to record.
   * @param thrown Thrown value, serialised onto `LogRecord.error`.
   * @param fields Optional structured fields.
   */
  error(message: string, thrown: unknown, fields?: LogFields): void;

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
   *
   * @param level Level to filter at.
   */
  setLevel(level: LogLevel): void;

  /**
   * Reads the current level.
   *
   * @returns The level records are filtered at.
   */
  getLevel(): LogLevel;

  /**
   * Subscribes a sink to every record emitted through this logger and through
   * every logger sharing its state. A sink that throws is contained and the
   * remaining sinks still receive the record.
   *
   * @param sink Sink to subscribe.
   * @returns The unsubscribe handle. Calling it more than once is harmless.
   */
  subscribe(sink: LogSink): () => void;

  /**
   * Reads the buffered records.
   *
   * @param limit Most recent records to return; every buffered record when
   *   omitted.
   * @returns A fresh array, oldest record first.
   */
  recent(limit?: number): readonly LogRecord[];

  /**
   * Exports the buffered records as JSON Lines: one JSON object per line,
   * oldest first, each line terminated by a newline.
   *
   * @param limit Most recent records to export; every buffered record when
   *   omitted.
   * @returns The JSON Lines text, empty when nothing is buffered.
   */
  toJsonLines(limit?: number): string;

  /**
   * Reads the logger's state together with its buffered records.
   *
   * @param limit Most recent records to include; every buffered record when
   *   omitted.
   * @returns The snapshot.
   */
  snapshot(limit?: number): LoggerSnapshot;

  /** Discards the buffered records. The lifetime counters are unchanged. */
  clear(): void;
}

/* --------------------------------------------------------------------------
 * Logger implementation
 * ----------------------------------------------------------------------- */

/**
 * One subscription, held by identity: an unsubscribe handle removes its own
 * registration only, even when the same function is subscribed twice.
 */
interface SinkRegistration {
  readonly sink: LogSink;
}

/** Mutable state shared by a logger and every logger derived from it. */
interface LoggerState {
  readonly correlationId: string;
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
}

/** Fields and thrown value recovered from a `warn` or `error` argument pair. */
interface EmissionArgs {
  readonly fields: LogFields | undefined;
  readonly thrown: unknown;
}

/** Writable form of a record, assembled before freezing. */
type MutableRecord = {
  -readonly [K in keyof LogRecord]: LogRecord[K];
};

/** Writable form of a snapshot, assembled before freezing. */
type MutableSnapshot = {
  -readonly [K in keyof LoggerSnapshot]: LoggerSnapshot[K];
};

/** Returned by `subscribe` when the offered sink is not callable. */
const NOOP_UNSUBSCRIBE = (): void => {
  return;
};

/**
 * Tests whether a value is a structured field bag rather than a thrown value.
 *
 * @param value Value to test.
 * @returns `true` for a plain object that is neither an `Error` nor an array.
 */
function isFieldsBag(value: unknown): value is LogFields {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Error) &&
    !Array.isArray(value)
  );
}

/**
 * Splits the two optional arguments of `warn` and `error` into fields and a
 * thrown value, in whichever order they were passed.
 *
 * @param first Second argument of the call.
 * @param second Third argument of the call.
 * @returns The recovered pair.
 */
function splitEmissionArgs(first: unknown, second: unknown): EmissionArgs {
  let fields: LogFields | undefined;
  let thrown: unknown;

  for (const candidate of [first, second]) {
    if (candidate === undefined) {
      continue;
    }

    if (fields === undefined && isFieldsBag(candidate)) {
      fields = candidate;
      continue;
    }

    if (thrown === undefined) {
      thrown = candidate;
    }
  }

  return { fields, thrown };
}

/**
 * Reduces a message to text.
 *
 * @param message Message as supplied.
 * @returns The message itself, or a description of a caller-supplied value
 *   that is not a string.
 */
function toMessage(message: string): string {
  return typeof message === 'string' ? message : describeValue(message);
}

/**
 * Reduces a subsystem tag to text.
 *
 * @param value Tag as supplied.
 * @returns The trimmed tag, or `'app'` when it is blank or absent.
 */
function toSubsystem(value: string | undefined): string {
  if (typeof value !== 'string') {
    return DEFAULT_SUBSYSTEM;
  }

  const trimmed = value.trim();

  return trimmed.length === 0 ? DEFAULT_SUBSYSTEM : trimmed;
}

/**
 * Copies a caller's field bag, one member at a time.
 *
 * @param fields Bag as supplied.
 * @returns A frozen shallow copy, or `undefined` when there is nothing to
 *   carry. A member whose accessor throws is copied as
 *   `'[unreadable value]'`.
 */
function copyFields(fields: LogFields | undefined): LogFields | undefined {
  if (fields === undefined || fields === null) {
    return undefined;
  }

  if (typeof fields !== 'object') {
    return undefined;
  }

  const copy: Record<string, LogFieldValue | undefined> = {};

  try {
    for (const key of Object.keys(fields)) {
      try {
        copy[key] = fields[key];
      } catch {
        copy[key] = UNREADABLE_VALUE;
      }
    }
  } catch {
    return undefined;
  }

  if (Object.keys(copy).length === 0) {
    return undefined;
  }

  return Object.freeze(copy);
}

/**
 * Clamps a requested buffer capacity.
 *
 * @param capacity Capacity as supplied.
 * @returns A whole number within [1, 10000].
 */
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
function resolveCorrelationId(options: LoggerOptions): string {
  const provided = options.correlationId;

  if (typeof provided === 'string' && provided.length > 0) {
    return provided;
  }

  return deriveCorrelationId(options.runSeed ?? '');
}

/**
 * Assembles one frozen record.
 *
 * @param state Shared state supplying the correlation identifier.
 * @param subsystem Tag of the emitting logger.
 * @param level Severity.
 * @param message Message to record.
 * @param args Fields and thrown value.
 * @returns The frozen record.
 */
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

  if (args.thrown !== undefined) {
    record.error = serializeError(args.thrown);
  }

  return Object.freeze(record);
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

/**
 * Reads the buffered records in chronological order.
 *
 * @param state Shared state holding the buffer.
 * @param limit Most recent records to read; every stored record when absent or
 *   not a finite number.
 * @returns A fresh array, oldest record first.
 */
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

/**
 * Renders the buffered records as JSON Lines.
 *
 * @param state Shared state holding the buffer.
 * @param limit Most recent records to render.
 * @returns The JSON Lines text, empty when nothing is buffered.
 */
function buildJsonLines(
  state: LoggerState,
  limit: number | undefined
): string {
  let text = '';

  for (const record of recentRecords(state, limit)) {
    text += `${stringifyRecord(record)}\n`;
  }

  return text;
}

/**
 * Assembles one frozen snapshot.
 *
 * @param state Shared state to report.
 * @param subsystem Tag of the logger the snapshot was taken through.
 * @param limit Most recent records to include.
 * @returns The frozen snapshot.
 */
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
    records: recentRecords(state, limit),
  };

  if (state.lastSinkFault !== undefined) {
    snapshot.lastSinkFault = state.lastSinkFault;
  }

  return Object.freeze(snapshot);
}

/**
 * Discards the buffered records.
 *
 * @param state Shared state holding the buffer.
 */
function clearBuffer(state: LoggerState): void {
  state.buffer.fill(undefined);
  state.nextIndex = 0;
  state.stored = 0;
}

/**
 * Registers a sink.
 *
 * @param state Shared state holding the registrations.
 * @param sink Sink to register.
 * @returns The unsubscribe handle, which removes only this registration and
 *   only once.
 */
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

/**
 * Writes one record to the console as a single JSON line.
 *
 * @param state Shared state carrying the console setting.
 * @param record Record to write.
 */
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

/**
 * Hands one record to every subscribed sink, in subscription order, with each
 * call contained: a sink that throws is counted on `sinkFaults` and described
 * by `lastSinkFault`, the record is not retried on it, the sink stays
 * subscribed for later records, and the sinks after it still receive this one.
 * Counterpart of the discarded-error `catch` at js/local_storage_manager.js
 * L37-L39: the caught value is serialised and retained.
 *
 * @param state Shared state holding the registrations.
 * @param record Record to dispatch.
 */
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

/**
 * Applies the level filter and, when the record passes it, stores, writes and
 * dispatches the record.
 *
 * @param state Shared state.
 * @param subsystem Tag of the emitting logger.
 * @param level Severity.
 * @param message Message to record.
 * @param args Fields and thrown value.
 */
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

/**
 * Builds a logger over shared state.
 *
 * @param state State the logger and its children share.
 * @param subsystem Tag this logger records under.
 * @returns The frozen logger.
 */
function createBoundLogger(state: LoggerState, subsystem: string): Logger {
  const logger: Logger = {
    correlationId: state.correlationId,

    subsystem,

    debug(message: string, fields?: LogFields): void {
      emit(state, subsystem, 'debug', message, {
        fields,
        thrown: undefined,
      });
    },

    info(message: string, fields?: LogFields): void {
      emit(state, subsystem, 'info', message, {
        fields,
        thrown: undefined,
      });
    },

    warn(message: string, first?: unknown, second?: unknown): void {
      emit(
        state,
        subsystem,
        'warn',
        message,
        splitEmissionArgs(first, second)
      );
    },

    error(message: string, first?: unknown, second?: unknown): void {
      emit(
        state,
        subsystem,
        'error',
        message,
        splitEmissionArgs(first, second)
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
 * @param options Settings; every member is optional.
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
  };

  return createBoundLogger(state, toSubsystem(options.subsystem));
}


/* --------------------------------------------------------------------------
 * Injected-reporter adapters
 * ----------------------------------------------------------------------- */

// src/engine/types.ts, src/input/keymap.ts and src/storage/
// local-storage-manager.ts each declare their own reporter contract and import
// nothing from this folder. The three factories below are the logger-backed
// implementations of those contracts, and src/main.ts injects them.

/** Subsystem tag records from the engine adapter carry. */
const ENGINE_SUBSYSTEM = 'engine';

/** Subsystem tag records from the input adapter carry. */
const INPUT_SUBSYSTEM = 'input';

/** Subsystem tag records from the storage adapter carry. */
const STORAGE_SUBSYSTEM = 'storage';

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

/**
 * Maps the input layer's report level onto a log level. The two unions carry
 * the same four names.
 *
 * @param level Level as the input layer reports it.
 * @returns The log level, or `'info'` for a value outside the union.
 */
function toLogLevel(level: InputReportLevel): LogLevel {
  return isLogLevel(level) ? level : DEFAULT_LOG_LEVEL;
}

/**
 * Builds the engine's reporter.
 *
 * Records every contained hook-handler throw at `'error'`, with the thrown
 * value serialised onto `LogRecord.error`, and every engine counter at
 * `'debug'`. Both members of `EngineReporter` are implemented.
 *
 * @param logger Logger the reports are recorded through.
 * @returns A frozen reporter tagged `'engine'`.
 */
export function createEngineReporter(logger: Logger): EngineReporter {
  const scoped = logger.child(ENGINE_SUBSYSTEM);

  const reporter: EngineReporter = Object.freeze({
    onHookError(report: EngineHookErrorReport): void {
      scoped.error(
        'A hook handler threw and was contained.',
        {
          runId: report.runId,
          hook: report.hook,
          subscriberId: report.subscriberId,
        },
        report.error
      );
    },

    onCount(report: EngineCountReport): void {
      scoped.debug('Engine counter incremented.', {
        runId: report.runId,
        metric: report.metric,
        value: report.value,
        hook: report.hook ?? null,
      });
    },
  });

  return reporter;
}

/**
 * Builds one timing span that records its own duration when it closes.
 *
 * @param logger Logger the span records through.
 * @param name Span name.
 * @returns A frozen span. A second `end()` records nothing further.
 */
function createLoggedSpan(logger: Logger, name: string): InputSpan {
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
 * Records messages at the level the input layer reports, counters at
 * `'debug'` with the caller's fields merged beneath `metric` and `value`, and
 * spans at `'debug'` with the elapsed `durationMs`. All three members of
 * `InputReporter` are implemented, the optional `startSpan` included.
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
      writeAtLevel(scoped, toLogLevel(level), message, fields);
    },

    count(metric: string, fields?: InputReportFields): void {
      const merged: Record<string, LogFieldValue> = {};

      if (fields !== undefined) {
        for (const key of Object.keys(fields)) {
          merged[key] = fields[key];
        }
      }

      merged['metric'] = metric;
      merged['value'] = 1;

      scoped.debug('Input counter incremented.', merged);
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
 * Records the writability probe at `'info'` when it succeeds and `'warn'` when
 * it does not, a failed operation at `'error'` when the quota is exhausted and
 * `'warn'` otherwise, and a write at `'debug'` when it completed and `'warn'`
 * when it did not. The `StorageErrorInfo` each report carries is serialised
 * onto `LogRecord.error`. All three members of `StorageReporter` are
 * implemented.
 *
 * Sink for the two silent-failure sites at js/local_storage_manager.js
 * L47-L49 and L54.
 *
 * @param logger Logger the reports are recorded through.
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

      scoped.warn(
        'Web Storage probe failed; the in-memory store is in use.',
        fields,
        result.error
      );
    },

    onFailure(failure: StorageFailure): void {
      const fields: LogFields = {
        operation: failure.operation,
        key: failure.key,
        strategy: failure.strategy,
        quota: failure.error.quota,
      };

      if (failure.error.quota) {
        scoped.error(
          'A storage operation exhausted the quota.',
          fields,
          failure.error
        );

        return;
      }

      scoped.warn('A storage operation failed.', fields, failure.error);
    },

    onWrite(info: StorageWriteInfo): void {
      const fields: LogFields = {
        key: info.key,
        byteLength: info.byteLength,
        ok: info.ok,
      };

      if (info.ok) {
        scoped.debug('A storage write completed.', fields);

        return;
      }

      scoped.warn('A storage write did not complete.', fields);
    },
  });

  return reporter;
}

