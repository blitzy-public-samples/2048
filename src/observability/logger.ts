// Structured logging for the observability layer: the run correlation
// identifier, error serialisation, field sanitisation, the log record, the
// level filter, the sink registry, the bounded recent-record buffer, the
// JSON-lines export, and the three adapters that satisfy the reporter
// contracts src/engine, src/input and src/storage each declare for themselves.
//
// Two properties of the emission path, both load-bearing:
//   a throwable is identified by the ARGUMENT POSITION it arrives in, or by
//   its presence on a `LogFailure`, never by its type, so a thrown plain
//   object reaches the record as a throwable rather than as fields;
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
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
// this module's area enumerated:
//   TR-LOG-01  js/local_storage_manager.js  the discarded-error `catch`, whose
//              L37-L39                      target is `serializeError`
//   TR-LOG-02  js/local_storage_manager.js  the unguarded `setItem`, reported
//              L47-L49                      through `createStorageReporter`
//   TR-LOG-03  js/local_storage_manager.js  the unguarded `JSON.parse`,
//              L54                          reported through the same adapter
//   TR-LOG-04  target-only row              `deriveCorrelationId` and its
//                                           two-hash rendering
//   TR-LOG-05  target-only row              the log record, its level filter
//                                           and the sink registry
//   TR-LOG-06  target-only row              the bounded recent-record buffer
//                                           and `Logger.recent`
//   TR-LOG-07  target-only row              the JSON-lines export
//   TR-LOG-08  target-only row              the three reporter adapters for
//                                           src/engine, src/input and
//                                           src/storage
//
// Decisions: DL-LOG-01, DL-LOG-02, DL-LOG-03, DL-LOG-04, DL-LOG-05,
// DL-LOG-06, DL-LOG-07 (docs/DECISION_LOG.md).

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

/** Separates the keyed hash pair from the third, XOR-derived segment. */
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
 * TWO DERIVERS, ONE ALGORITHM. `runCorrelationId` of src/run/run-state.ts is a
 * separate implementation of this same derivation, held byte-equal to this one
 * by tests/unit/run/run-state.test.ts. src/run/ reaches no observability
 * module, so neither can import the other; src/main.ts calls this one.
 *
 * TWO FORMS, and the RUN-INSTANCE form is the one the composition root uses.
 * Passing `runId` derives every segment of the identifier from the run instance
 * AND the seed together, so no part of the returned value is a function of the
 * seed alone. The SEED-ONLY form, derived when `runId` is absent or empty,
 * groups every run of one seed under one identifier.
 *
 * KEYED, NOT UNSALTED. The instance form's key is `runId`, which
 * `createRunToken` of src/main.ts originates from `crypto.getRandomValues`, and
 * which is carried in NO report: the identifier travels, the key does not. A
 * party holding an export therefore cannot hash candidate seeds and match them
 * against it. Decision DL-LOG-09.
 *
 * THE SEED-ONLY FORM IS RECOVERABLE. It is unsalted and deterministic, so
 * anyone can compute it, and it must not be attached to a logger whose records
 * leave the machine; it is for a caller that deliberately wants one identifier
 * per seed — a fixture, a replay harness. The seed TEXT is carried in neither
 * form.
 *
 * A seed is PUBLIC either way: the run summary shows it and copies it, and a
 * replay is the point of it. Nothing in the product may put personal data in
 * one, and the run-start field says so where a seed is entered.
 *
 * Neither form is unique by construction — each concatenates 32-bit hashes —
 * so distinct inputs can collide, and a consumer that needs an exact identity
 * compares the seed and `runId` themselves.
 *
 * Reads no clock and no randomness in either form, so a record's identifier is
 * reproducible from a persisted run: `runId` is persisted beside the seed, so a
 * resumed run keeps the identifier it was recording under.
 *
 * A caller holding an identifier already derived supplies it as
 * `LoggerOptions.correlationId`, which is carried verbatim and takes precedence
 * over `runSeed`.
 *
 * @param runSeed Seed of the run. Re-coerced with `String` before hashing, so
 *   no input throws.
 * @param runId Run instance identifier, and the key of the instance form. Omit
 *   it, or pass an empty value, for the seed-only form.
 * @returns An 18-character identifier for the seed-only form and a
 *   26-character one for the run-instance form, non-empty for every input, the
 *   empty string included.
 */
export function deriveCorrelationId(
  runSeed: string,
  runId?: string,
): CorrelationId {
  const seed = String(runSeed);

  if (runId === undefined || String(runId) === '') {
    return (
      CORRELATION_ID_PREFIX +
      renderHash(fnv1a32(seed)) +
      renderHash(djb2Hash32(seed))
    );
  }

  // The key first, so the two hashes below are keyed hashes of the seed rather
  // than hashes of the seed with a key appended.
  const instance = `${String(runId)}\u0000${seed}`;

  return (
    CORRELATION_ID_PREFIX +
    renderHash(fnv1a32(instance)) +
    renderHash(djb2Hash32(instance)) +
    CORRELATION_ID_INSTANCE_SEPARATOR +
    renderHash(fnv1a32(instance) ^ djb2Hash32(instance))
  );
}

const CIRCULAR_PLACEHOLDER = '[circular]';

const FUNCTION_PLACEHOLDER = '[function]';

const UNREADABLE_VALUE = '[unreadable value]';

const UNSERIALISABLE_FIELDS = '[unserialisable fields]';

/** Substituted for a value a limit stopped the normalisation short of. */
const TRUNCATED_VALUE = '[truncated]';

/** Member name a normalised object carries its dropped-member marker under. */
const TRUNCATED_FIELD_KEY = '__truncated__';

/** Member names a normalised object never carries. */
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
 * carries.
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
 * How much of a caught value a record carries — of its STACK and of its
 * MESSAGE alike, and of every cause behind it.
 *
 * `'redacted'` replaces the locations of the three forms `redactLocations`
 * matches and the further forms `redactMessage` matches, leaving the frame
 * names, the shape of the stack and the wording of the message. `'full'`
 * carries both as they were thrown, for a private development sink; the export
 * surfaces redact regardless.
 *
 * Named for the caught value rather than for the stack because it governs the
 * message too: a mode called after the stack alone invited a caller to select
 * `'full'` for a stack trace and receive raw message text with it. Decision
 * DL-LOG-10.
 */
export type ErrorDetail = 'redacted' | 'full';

/** How much of a caught value a logger built without an opinion carries. */
export const DEFAULT_ERROR_DETAIL: ErrorDetail = 'redacted';

/**
 * Replaces the source locations of three enumerated forms in `text` with
 * `REDACTED_LOCATION`: an absolute URL, a Windows absolute path, and a POSIX
 * path of at least two segments, each optionally followed by line and column.
 *
 * What it is NOT is a general guarantee that no location survives. A bare file
 * name and a single-segment path match none of the three and are copied as they
 * stand, and a location a caller puts in a FIELD is untouched. A location in a
 * MESSAGE is covered, through `redactMessage` below, which applies this and
 * three further forms. Decisions DL-LOG-08, DL-LOG-10.
 *
 * @param text Text to redact.
 * @returns The text with every location of those three forms replaced.
 */
function redactLocations(text: string): string {
  return text
    .replace(URL_LOCATION_PATTERN, REDACTED_LOCATION)
    .replace(WINDOWS_LOCATION_PATTERN, REDACTED_LOCATION)
    .replace(POSIX_LOCATION_PATTERN, REDACTED_LOCATION);
}

/**
 * Substituted for each further sensitive form a redacted message carried.
 *
 * The same marker `REDACTED_LOCATION` uses, so a reader sees one word whatever
 * was replaced and `logRecordBounds.redactedLocation` names it for both.
 */
const REDACTED_VALUE = REDACTED_LOCATION;

/**
 * A `data:` URI, which carries its payload inline and matches no scheme pattern
 * above because it has no authority component.
 */
const DATA_URI_PATTERN =
  /\bdata:[a-z0-9!#$&^_.+-]*(?:;[a-z0-9-]+=?[^\s,]*)*,[^\s)'"]*/gi;

/** The seven key words a credential-like assignment is recognised by. */
const CREDENTIAL_KEY_WORDS = 'token|key|secret|password|passwd|auth|session';

/**
 * A token-like query or assignment value: one of the key words above, then `=`
 * or `:`, then the value up to the next separator.
 */
const CREDENTIAL_ASSIGNMENT_PATTERN = new RegExp(
  `\\b(${CREDENTIAL_KEY_WORDS})\\b(\\s*[=:]\\s*)` +
    `(?:"[^"]*"|'[^']*'|[^\\s,;&)]+)`,
  'gi',
);

/**
 * Longest double-quoted run a redacted message keeps, in characters.
 *
 * A parse failure quotes the text it was given: `JSON.parse` embeds a fragment
 * of the payload in its message, and this product's payloads carry the run seed
 * the player typed. Short quoted runs — a key name, a state name — are kept,
 * because they are what makes a message readable.
 */
const MAX_QUOTED_RUN_LENGTH = 24;

/** A double-quoted run longer than `MAX_QUOTED_RUN_LENGTH`. */
const LONG_QUOTED_RUN_PATTERN = new RegExp(
  `"[^"]{${String(MAX_QUOTED_RUN_LENGTH + 1)},}"`,
  'g',
);

/**
 * Replaces in `text` every location `redactLocations` covers, plus three
 * further enumerated forms: a `data:` URI, a credential-like assignment of one
 * of seven key words, and a double-quoted run longer than
 * `MAX_QUOTED_RUN_LENGTH` — which is how a parse failure carries a fragment of
 * the payload it was given, and how a run seed reaches a message.
 *
 * What it is NOT is a general guarantee that nothing sensitive survives: a
 * message is arbitrary text written by whatever threw, and only the enumerated
 * forms are matched. It is applied to the message of a caught value and of
 * every cause behind it, on the emission path unless the logger carries
 * `'full'`, and on every export surface regardless. Decision DL-LOG-10.
 *
 * @param text Message text to redact.
 * @returns The text with every matched form replaced.
 */
function redactMessage(text: string): string {
  return redactLocations(text)
    .replace(DATA_URI_PATTERN, REDACTED_VALUE)
    .replace(
      CREDENTIAL_ASSIGNMENT_PATTERN,
      (_match, key: string, separator: string): string =>
        `${key}${separator}${REDACTED_VALUE}`,
    )
    .replace(LONG_QUOTED_RUN_PATTERN, `"${REDACTED_VALUE}"`);
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
 * `cause` chain to `MAX_CAUSE_DEPTH` links, so one caught value cannot grow a
 * record without limit however large the value that was thrown.
 */
export interface SerializedError {
  readonly name: string;
  readonly message: string;

  /**
   * The value's own `stack`, absent when it carries none. Every location of
   * the three forms `redactLocations` matches is replaced with
   * `REDACTED_LOCATION` unless the record was built by a logger carrying
   * `errorDetail: 'full'`, and the export surfaces redact in either case. The
   * `message` above is redacted on the same mode, by `redactMessage`.
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
 * Reads one string-valued member off an object, without throwing.
 *
 * The value is returned UNCHANGED: this reader applies no bound of its own,
 * so a caller that needs one applies it to the result.
 *
 * @param holder Object to read from.
 * @param key Member to read.
 * @returns The string value, unmodified, or `undefined` when the member is
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
  errorDetail: ErrorDetail
): SerializedError | undefined {
  if (depth >= MAX_CAUSE_DEPTH) {
    return undefined;
  }

  try {
    const cause: unknown = (holder as { cause?: unknown }).cause;

    if (cause === undefined || cause === null) {
      return undefined;
    }

    return serializeThrown(cause, depth + 1, errorDetail);
  } catch {
    return undefined;
  }
}


function buildSerializedError(
  name: string,
  message: string,
  stack: string | undefined,
  cause: SerializedError | undefined,
  errorDetail: ErrorDetail
): SerializedError {
  // THE MESSAGE IS REDACTED TOO, and on the same mode as the stack. A stack was
  // redacted while the message beside it carried the location, the payload
  // fragment or the credential-like value that made redacting the stack worth
  // doing — and the message is the part a console line shows first. Redacted
  // before it is clamped, so the limit measures the text the record actually
  // carries. DL-LOG-10.
  const resolvedMessage =
    errorDetail === 'full' ? message : redactMessage(message);

  const record: {
    name: string;
    message: string;
    stack?: string;
    cause?: SerializedError;
  } = {
    name: clamp(name, MAX_ERROR_NAME_LENGTH),
    message: clamp(resolvedMessage, MAX_ERROR_MESSAGE_LENGTH),
  };

  if (stack !== undefined) {
    const resolved =
      errorDetail === 'full' ? stack : redactLocations(stack);

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
 * @param errorDetail How much of each message and stack in the chain to carry.
 * @returns The serialised value.
 */
function serializeThrown(
  thrown: unknown,
  depth: number,
  errorDetail: ErrorDetail
): SerializedError {
  try {
    if (typeof thrown === 'object' && thrown !== null) {
      return buildSerializedError(
        readStringMember(thrown, 'name') ?? UNKNOWN_ERROR_NAME,
        readStringMember(thrown, 'message') ?? describeValue(thrown),
        readStringMember(thrown, 'stack'),
        readCause(thrown, depth, errorDetail),
        errorDetail
      );
    }

    return buildSerializedError(
      UNKNOWN_ERROR_NAME,
      describeValue(thrown),
      undefined,
      undefined,
      errorDetail
    );
  } catch {
    return FALLBACK_SERIALIZED_ERROR;
  }
}

/**
 * Reduces any thrown value to `SerializedError`.
 *
 * Target of the discarded-error `catch` in js/local_storage_manager.js.
 */
export function serializeError(
  thrown: unknown,
  errorDetail: ErrorDetail = DEFAULT_ERROR_DETAIL
): SerializedError {
  return serializeThrown(thrown, 0, errorDetail);
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

/** The structured field bag a record carries. */
export interface LogFields {
  readonly [key: string]: LogFieldValue | undefined;
}

/**
 * One emitted log record. Every member is plain data: a record round-trips
 * through `JSON.parse(JSON.stringify(record))` unchanged.
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
   * to bounded JSON data: the record shares no object with the caller's bag at
   * any depth, and `logRecordBounds` states the depth, breadth, node and
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

/** The resolved clock reader, or `null` where the host exposes none. */
let cachedClockReader: ClockReader | null | undefined;

let cachedClockHost: unknown;

/**
 * The host clock reader, resolved once and reused.
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
   * Run seed the seed-only correlation identifier is derived from. Defaults to
   * the empty string, which derives a stable identifier of its own.
   */
  readonly runSeed?: string;

  /**
   * Correlation identifier carried verbatim, as `deriveCorrelationId` returned
   * it. Takes precedence over `runSeed` when it is a non-empty string.
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
   * How much of a caught value the records this logger emits carry — its
   * message as well as its stack. Defaults to `DEFAULT_ERROR_DETAIL`, which is
   * `'redacted'`; only the exact value `'full'` selects the unredacted form,
   * and it is for a private development sink. `toJsonLines()` and `snapshot()`
   * redact in either case, to the extent `redactLocations` and `redactMessage`
   * cover.
   */
  readonly errorDetail?: ErrorDetail;
}

/** A logger's state and its buffered records, as `snapshot` reports them. */
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

/** Structured logger. */
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
   * neither position is inferred from the value passed. Supplying the third
   * argument at all — including as `undefined` — records a `LogRecord.error`;
   * omit it when there is no throwable.
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
   * neither position is inferred from the value passed. Supplying the third
   * argument at all — including as `undefined` — records a `LogRecord.error`;
   * omit it when there is no throwable.
   *
   * @param message Message to record.
   * @param fields Optional structured fields.
   * @param thrown Thrown value, serialised onto `LogRecord.error`.
   */
  error(message: string, fields?: LogFields, thrown?: unknown): void;

  /**
   * Emits a record for a caught value at a level chosen by the caller.
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
   * Replaces the correlation identifier every later record carries, on this
   * logger and on every logger sharing its state.
   *
   * The one deriver of the value is still `deriveCorrelationId`; this only
   * carries a value that function produced. A blank or non-string value leaves
   * the current identifier unchanged.
   *
   * @param correlationId The identifier later records carry.
   */
  setCorrelationId(correlationId: CorrelationId): void;

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
  /**
   * Rotated by `setCorrelationId` when a second run starts in one page load,
   * so every logger sharing this state carries the identifier of the run in
   * force.
   */
  correlationId: CorrelationId;
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
  readonly errorDetail: ErrorDetail;
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
 * The thrown value's POSITION is what identifies it, never its type, so a
 * thrown plain object is carried as a throwable rather than read as fields.
 * Decision DL-LOG-05.
 *
 * @param fields Second argument of the call.
 * @param rest Remaining arguments; the first of them, if any, is the thrown
 *   value. Its length is what records the throwable's presence, so an
 *   explicitly passed `undefined` is a throwable and an omitted argument is
 *   not.
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
 * Every value is normalised through `normalizeFieldValue`, so a record cannot
 * carry a structure the caller keeps a reference into, one that grows without
 * limit, or one `JSON.stringify` cannot render. Decision DL-LOG-06.
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
    record.error = serializeError(args.thrown, state.errorDetail);
  }

  enforceRecordBudget(record);

  return Object.freeze(record);
}

/**
 * Reduces a record until its JSON form fits `MAX_RECORD_LENGTH`.
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
 *   record cannot be serialised at all, so an unserialisable record is reduced
 *   rather than passed through.
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
 * Rebuilds a serialised error with every form `redactLocations` covers replaced
 * in its stack and every form `redactMessage` covers replaced in its message,
 * and the same in every cause behind it.
 *
 * @param error Error to redact.
 * @returns The error itself where it carries nothing to replace, and a frozen
 *   rebuilt error otherwise.
 */
function redactSerializedError(error: SerializedError): SerializedError {
  const cause =
    error.cause === undefined
      ? undefined
      : redactSerializedError(error.cause);
  const stack =
    error.stack === undefined ? undefined : redactLocations(error.stack);
  const message = redactMessage(error.message);

  if (
    stack === error.stack &&
    cause === error.cause &&
    message === error.message
  ) {
    return error;
  }

  const rebuilt: {
    name: string;
    message: string;
    stack?: string;
    cause?: SerializedError;
  } = { name: error.name, message };

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
 * `errorDetail` is, so an export carries no location of the three forms
 * `redactLocations` covers and no form `redactMessage` covers, even where the
 * sinks were given the value as it was thrown. A form outside those is not
 * removed here either.
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

  // The export surface redacts whatever the logger's `errorDetail` is.
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
    // The export surface redacts whatever the logger's `errorDetail` is.
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
    // A GETTER, not a captured value: `setCorrelationId` rotates the
    // identifier when a second run starts in one page load, and a captured
    // value would go on reporting the identifier this logger was built with.
    get correlationId(): CorrelationId {
      return state.correlationId;
    },

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

    setCorrelationId(correlationId: CorrelationId): void {
      if (typeof correlationId !== 'string' || correlationId.length === 0) {
        return;
      }

      state.correlationId = correlationId;
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
    errorDetail:
      options.errorDetail === 'full' ? 'full' : DEFAULT_ERROR_DETAIL,
  };

  return createBoundLogger(state, toSubsystem(options.subsystem));
}

// src/engine/types.ts, src/input/keymap.ts and src/storage/
// local-storage-manager.ts each declare their own reporter contract and import
// nothing from this folder.

const ENGINE_SUBSYSTEM = 'engine';

const INPUT_SUBSYSTEM = 'input';

const STORAGE_SUBSYSTEM = 'storage';

/**
 * Input field names this adapter never copies into a record: a DENYLIST over
 * the exact, case-sensitive names below — the verbatim members of a keyboard
 * event and the free-text members of an editable field.
 *
 * It is not a general guarantee. A field reported under any other name is
 * copied, so the standing rule is the one src/input/input-manager.ts already
 * follows — report a bounded category, never a keystroke — and this list only
 * enforces it for the names it lists.
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
 * Copies an input report's fields under this adapter's own bounds: a denied
 * name is dropped, every string value is truncated to `MAX_INPUT_FIELD_LENGTH`
 * characters, and the member count is capped at `MAX_INPUT_FIELDS` so one
 * report cannot fill a record.
 *
 * Truncation BOUNDS free text rather than removing it — a longer value reaches
 * the record as its leading characters — so a caller must still not report free
 * text.
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
 * are implemented, `onListenerError` included, so an error the emitter contains
 * is reported rather than swallowed.
 *
 * Every record carries TWO correlation fields and NO `runId`:
 * `reportedCorrelationId`, which is the identifier the engine was injected
 * with, and the record's own `correlationId` from `LogRecord`, so a mismatch
 * between the two is visible in the log stream rather than silent. `runId` is
 * the key of the run-instance derivation and reaches no record.
 *
 * @returns A frozen reporter tagged `'engine'`.
 */
export function createEngineReporter(logger: Logger): EngineReporter {
  const scoped = logger.child(ENGINE_SUBSYSTEM);

  const reporter: EngineReporter = Object.freeze({
    onHookError(report: EngineHookErrorReport): void {
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
      // most one, so BOTH are recorded and the absent one is `null`.
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

/** The span handed back when the level a span records at is filtered out. */
const DISCARDED_SPAN: InputSpan = Object.freeze({
  end(): void {
  },
});

/**
 * Builds one timing span that records its own duration when it closes.
 *
 * @param logger Logger the span records through.
 * @param name Span name.
 * @returns A frozen span. A second `end` records nothing further.
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
 * Every field a report carries passes through `copyInputFields`, which drops
 * the raw-keystroke names of `REJECTED_INPUT_FIELDS` and bounds what remains,
 * so no record carries a character a player typed.
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
      // whenever that level is filtered out.
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

      // The caught value arrives unconverted, so `serializeError` keeps its
      // name, message, stack and cause chain. Decision DL-LOG-05.
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
        // storage layer raises no failure for it.
        scoped.warn(message, fields);

        return;
      }

      // A probe that caught something is also delivered to `onFailure`, which
      // records it at warning level with the thrown value.
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
      // the thrown value, so raising this one would duplicate it.
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

        // The bounded description the storage layer authored.
        publicMessage: failure.error.message,
        errorName: failure.error.name,
      };

      // The ORIGINAL caught value, not the reduction of it: a `StorageFailure`
      // carries both, and the reduction is already in the fields above.
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
