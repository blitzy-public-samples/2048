// Unit suite over src/observability/logger.ts: the run correlation identifier,
// the log record, the level filter, the sink registry, the bounded
// recent-record buffer, error serialisation, and the three reporter adapters.
//
// Source construct this suite is the executable evidence for, carried as a
// source row in docs/TRACEABILITY_MATRIX.md: the discarded-error `catch` at
// js/local_storage_manager.js L37-L39, which bound `error` and returned
// `false` without reporting it. The `serializeError` describe block below is
// its coverage, and the storage-adapter block covers the two silent-failure
// sites in that same file at L47-L49 and L54.
//
// Validation gate: AAP 0.8.8 V8, first bullet — structured logs carry the run
// correlation identifier.
//
// Collected by the unit:dom project in vitest.config.ts, which supplies a
// document. No test below reads or writes storage. tests/fixtures/storage.ts is
// loaded as a setup file for every unit suite and removes every owned key after
// each test.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_LOG_BUFFER_CAPACITY,
  LOG_LEVELS,
  LOG_LEVEL_SEVERITY,
  createEngineReporter,
  createInputReporter,
  createLogger,
  createStorageReporter,
  deriveCorrelationId,
  isLogLevel,
  serializeError,
} from '../../../src/observability/logger';
import type {
  LogFields,
  LogLevel,
  LogRecord,
  LogSink,
  Logger,
  LoggerOptions,
} from '../../../src/observability/logger';

import { NOOP_ENGINE_REPORTER } from '../../../src/engine/types';
import type {
  EngineCountReport,
  EngineHookErrorReport,
  EngineReporter,
} from '../../../src/engine/types';

import {
  NOOP_REPORTER,
  createSafeInputReporter,
} from '../../../src/input/keymap';
import type { InputReporter } from '../../../src/input/keymap';

import type {
  StorageErrorInfo,
  StorageFailure,
  StorageProbeResult,
  StorageReporter,
  StorageWriteInfo,
} from '../../../src/storage/local-storage-manager';
import {
  BEST_SCORE_KEY,
  GAME_STATE_KEY,
  RUN_STATE_KEY,
} from '../../../src/storage/storage-keys';

/* --------------------------------------------------------------------------
 * Fixtures and helpers
 * ----------------------------------------------------------------------- */

/**
 * Shape `deriveCorrelationId` renders: the `run-` prefix followed by two
 * fixed-width base36 hashes of the seed.
 */
const CORRELATION_ID_PATTERN = /^run-[0-9a-z]{14}$/;

/** Characters a derived correlation identifier occupies. */
const CORRELATION_ID_LENGTH = 18;

/** Run seed the suite's loggers use unless a test overrides it. */
const SUITE_SEED = 'run-seed-2048';

/** Subsystem tag the suite's own loggers carry. */
const SUITE_SUBSYSTEM = 'suite';

/**
 * `Math.random` as it stood when this suite's module graph finished loading.
 * Read by the assertion that no module under test replaces it.
 */
const PRISTINE_MATH_RANDOM = Math.random;

/** A logger paired with the records its subscribed sink has captured. */
interface CapturedLogger {
  /** The logger under test. */
  readonly logger: Logger;

  /** Records the sink has received, in the order they were emitted. */
  readonly records: LogRecord[];
}

/**
 * Builds a logger with a sink already subscribed.
 *
 * The suite defaults are the run seed `SUITE_SEED`, the subsystem tag
 * `SUITE_SUBSYSTEM`, the level `'debug'` and console output off. Each is
 * overridden by the matching member of `options`.
 *
 * @param options Settings merged over the suite defaults.
 * @returns The logger and the array its sink appends to.
 */
function createCapturingLogger(options: LoggerOptions = {}): CapturedLogger {
  const records: LogRecord[] = [];
  const logger = createLogger({
    runSeed: SUITE_SEED,
    subsystem: SUITE_SUBSYSTEM,
    level: 'debug',
    consoleOutput: false,
    ...options,
  });

  logger.subscribe((record: LogRecord): void => {
    records.push(record);
  });

  return { logger, records };
}

/** One record a level-coverage test emits. */
interface EmittedRecord {
  /** Level the record is emitted at. */
  readonly level: LogLevel;

  /** Message the record carries. */
  readonly message: string;
}

/**
 * Splits JSON Lines text into its non-empty lines.
 *
 * @param text JSON Lines text, as `Logger.toJsonLines` returns it.
 * @returns One entry per line, empty entries removed.
 */
function splitJsonLines(text: string): readonly string[] {
  return text.split('\n').filter((line: string): boolean => line.length > 0);
}

/**
 * Resolves the host's UUID source when the environment exposes one.
 *
 * @returns The source, or `null` when there is none to spy on.
 */
function resolveUuidSource(): Crypto | null {
  const host: unknown = globalThis.crypto;

  if (typeof host !== 'object' || host === null) {
    return null;
  }

  const source = host as Crypto;

  return typeof source.randomUUID === 'function' ? source : null;
}

/** One thrown value the `serializeError` enumeration covers. */
interface ThrowableCase {
  /** Name the case is reported under when an assertion fails. */
  readonly label: string;

  /** The value, typed as it reaches `serializeError`. */
  readonly thrown: unknown;
}

/**
 * Builds an object whose `toString` throws.
 *
 * @returns The object, typed as it reaches `serializeError`.
 */
function createThrowingToString(): unknown {
  return {
    code: 7,
    toString(): string {
      throw new Error('toString refused');
    },
  };
}

/**
 * Builds an object whose `message` accessor throws.
 *
 * @returns The object, typed as it reaches `serializeError`.
 */
function createThrowingMessageAccessor(): unknown {
  return {
    get message(): string {
      throw new Error('message accessor refused');
    },
  };
}

/** A thrown object that holds a reference to itself. */
interface CircularThrowable {
  /** Name the serialiser reads off the object. */
  name: string;

  /** The object itself. */
  self?: CircularThrowable;
}

/**
 * Builds a thrown object that holds a reference to itself.
 *
 * @returns The object, typed as it reaches `serializeError`.
 */
function createCircularThrowable(): unknown {
  const circular: CircularThrowable = { name: 'CircularError' };

  circular.self = circular;

  return circular;
}

/**
 * Enumerates every throwable the suite covers, `Error` instances and the
 * non-`Error` values a `catch` may equally bind.
 *
 * @returns The cases, each labelled.
 */
function enumerateThrowables(): readonly ThrowableCase[] {
  return [
    { label: 'Error', thrown: new Error('boom') },
    { label: 'TypeError', thrown: new TypeError('bad type') },
    { label: 'string', thrown: 'a thrown string' },
    { label: 'number', thrown: 42 },
    { label: 'zero', thrown: 0 },
    { label: 'null', thrown: null },
    { label: 'undefined', thrown: undefined },
    { label: 'boolean', thrown: false },
    { label: 'plain object', thrown: { code: 22, detail: 'quota' } },
    { label: 'message-bearing object', thrown: { message: 'no room left' } },
    { label: 'throwing toString', thrown: createThrowingToString() },
    { label: 'throwing accessor', thrown: createThrowingMessageAccessor() },
    { label: 'circular structure', thrown: createCircularThrowable() },
  ];
}

/** A quota rejection as the storage layer reduces one. */
const QUOTA_ERROR_INFO: StorageErrorInfo = {
  name: 'QuotaExceededError',
  message: 'The storage quota has been exceeded.',
  quota: true,
};

/** A parse failure as the storage layer reduces one. */
const PARSE_ERROR_INFO: StorageErrorInfo = {
  name: 'SyntaxError',
  message: 'Unexpected end of JSON input',
  quota: false,
};

/** A failed write under the namespaced run-state key, quota exhausted. */
const QUOTA_FAILURE: StorageFailure = {
  operation: 'write',
  key: RUN_STATE_KEY,
  strategy: 'localStorage',
  error: QUOTA_ERROR_INFO,
};

/** A failed read of the board snapshot, quota intact. */
const PARSE_FAILURE: StorageFailure = {
  operation: 'read',
  key: GAME_STATE_KEY,
  strategy: 'memory',
  error: PARSE_ERROR_INFO,
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* --------------------------------------------------------------------------
 * Correlation identifier
 * ----------------------------------------------------------------------- */

describe('deriveCorrelationId', () => {
  it('derives the same identifier across independent calls', () => {
    expect(deriveCorrelationId('run-seed-2048')).toBe(
      deriveCorrelationId('run-seed-2048')
    );
    expect(deriveCorrelationId('seed-42')).toBe(deriveCorrelationId('seed-42'));
    expect(deriveCorrelationId('')).toBe(deriveCorrelationId(''));
  });

  it('derives a distinct identifier for each distinct seed', () => {
    const seeds = [
      '',
      'run-seed-2048',
      'seed-42',
      'seed-43',
      'Seed-42',
      'seed-42 ',
      '0',
    ];
    const derived = new Set(seeds.map(deriveCorrelationId));

    expect(derived.size).toBe(seeds.length);
  });

  it('derives a non-empty identifier of a stable shape for every seed', () => {
    for (const seed of ['', 'run-seed-2048', '0', 'a'.repeat(512), '𝟚𝟘𝟜𝟠']) {
      const derived = deriveCorrelationId(seed);

      expect(derived.length).toBeGreaterThan(0);
      expect(derived).toHaveLength(CORRELATION_ID_LENGTH);
      expect(derived).toMatch(CORRELATION_ID_PATTERN);
    }
  });

  it('reads no randomness, no wall clock and no UUID source', () => {
    const randomSpy = vi.spyOn(Math, 'random');
    const nowSpy = vi.spyOn(Date, 'now');
    const uuidSource = resolveUuidSource();
    const uuidSpy =
      uuidSource === null ? null : vi.spyOn(uuidSource, 'randomUUID');

    deriveCorrelationId('forbidden-source-seed');
    deriveCorrelationId('');

    expect(randomSpy).not.toHaveBeenCalled();
    expect(nowSpy).not.toHaveBeenCalled();

    if (uuidSpy !== null) {
      expect(uuidSpy).not.toHaveBeenCalled();
    }
  });

  it('leaves Math.random unpatched', () => {
    expect(Math.random).toBe(PRISTINE_MATH_RANDOM);
    expect(Math.random.toString()).toContain('native code');

    deriveCorrelationId('unpatched-seed');
    createCapturingLogger({ runSeed: 'unpatched-seed' }).logger.info('emitted');

    expect(Math.random).toBe(PRISTINE_MATH_RANDOM);
    expect(Math.random.toString()).toContain('native code');
  });

  it('neither mutates its argument nor depends on call order', () => {
    const first = 'purity-seed-one';
    const second = 'purity-seed-two';
    const firstBaseline = deriveCorrelationId(first);
    const secondBaseline = deriveCorrelationId(second);

    expect(deriveCorrelationId(second)).toBe(secondBaseline);
    expect(deriveCorrelationId(first)).toBe(firstBaseline);
    expect(deriveCorrelationId(second)).toBe(secondBaseline);
    expect(deriveCorrelationId(first)).toBe(firstBaseline);

    expect(first).toBe('purity-seed-one');
    expect(second).toBe('purity-seed-two');
  });
});

/* --------------------------------------------------------------------------
 * Record structure
 * ----------------------------------------------------------------------- */

describe('LogRecord structure', () => {
  it('carries the correlation id, level, subsystem and message', () => {
    const { logger, records } = createCapturingLogger();
    const emitted: readonly EmittedRecord[] = [
      { level: 'debug', message: 'traversal prepared' },
      { level: 'info', message: 'stage started' },
      { level: 'warn', message: 'keymap fell back' },
      { level: 'error', message: 'hook handler threw' },
    ];

    logger.debug(emitted[0].message);
    logger.info(emitted[1].message);
    logger.warn(emitted[2].message);
    logger.error(emitted[3].message);

    expect(records).toHaveLength(LOG_LEVELS.length);

    records.forEach((record: LogRecord, index: number): void => {
      expect(record.level).toBe(emitted[index].level);
      expect(record.message).toBe(emitted[index].message);
      expect(record.correlationId).toBe(deriveCorrelationId(SUITE_SEED));
      expect(record.subsystem).toBe(SUITE_SUBSYSTEM);
    });
  });

  it('carries the correlation identifier derived from the run seed', () => {
    const { logger, records } = createCapturingLogger({ runSeed: 'seed-42' });

    logger.info('seeded');

    expect(logger.correlationId).toBe(deriveCorrelationId('seed-42'));
    expect(records[0].correlationId).toBe(deriveCorrelationId('seed-42'));
  });

  it('carries an explicit correlation id ahead of the seed', () => {
    const { logger, records } = createCapturingLogger({
      correlationId: 'run-supplied-verbatim',
      runSeed: 'seed-42',
    });

    logger.info('explicit');

    expect(logger.correlationId).toBe('run-supplied-verbatim');
    expect(records[0].correlationId).toBe('run-supplied-verbatim');
  });

  it('preserves the structured fields bag as data rather than text', () => {
    const { logger, records } = createCapturingLogger();
    const fields: LogFields = {
      stage: 3,
      cleared: true,
      seed: SUITE_SEED,
      missing: null,
      relics: ['spawn-bias', 'merge-echo'],
      board: { size: 4, cells: [2, 4, null, 8] },
    };

    logger.info('structured', fields);

    const captured = records[0].fields;

    expect(captured).toBeDefined();
    expect(captured).toEqual(fields);
    expect(typeof captured?.['board']).toBe('object');
    expect(Array.isArray(captured?.['relics'])).toBe(true);
    expect(captured?.['stage']).toBe(3);
    expect(captured?.['cleared']).toBe(true);
    expect(captured?.['missing']).toBeNull();
  });

  it('omits the fields member when the caller supplies none', () => {
    const { logger, records } = createCapturingLogger();

    logger.info('no fields');
    logger.info('empty fields', {});

    expect('fields' in records[0]).toBe(false);
    expect('fields' in records[1]).toBe(false);
  });

  it('omits the error member when the caller reports no failure', () => {
    const { logger, records } = createCapturingLogger();

    logger.error('no failure attached');

    expect('error' in records[0]).toBe(false);
  });

  it('carries a parseable timestamp and a finite monotonic offset', () => {
    const { logger, records } = createCapturingLogger();

    logger.info('timed');

    const record = records[0];

    expect(typeof record.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(record.timestamp))).toBe(false);
    expect(typeof record.elapsedMs).toBe('number');
    expect(Number.isFinite(record.elapsedMs)).toBe(true);
    expect(record.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('freezes each record before it reaches a sink', () => {
    const { logger, records } = createCapturingLogger();

    logger.info('frozen', { stage: 1 });

    expect(Object.isFrozen(records[0])).toBe(true);
  });

  it('round-trips a record through JSON unchanged', () => {
    const { logger, records } = createCapturingLogger();

    logger.error('reported', { stage: 2 }, new TypeError('bad type'));

    const record = records[0];
    const parsed: unknown = JSON.parse(JSON.stringify(record));

    expect(parsed).toEqual(record);
  });
});

describe('Logger.child', () => {
  it('tags a child with its subsystem and keeps the correlation id', () => {
    const { logger, records } = createCapturingLogger();
    const child = logger.child('render');

    child.info('from the renderer');

    expect(child.subsystem).toBe('render');
    expect(child.correlationId).toBe(logger.correlationId);
    expect(records[0].subsystem).toBe('render');
    expect(records[0].correlationId).toBe(logger.correlationId);
  });

  it('retains the correlation identifier through a nested child', () => {
    const { logger, records } = createCapturingLogger();
    const nested = logger.child('render').child('particles');

    nested.info('from the particle system');

    expect(nested.subsystem).toBe('particles');
    expect(nested.correlationId).toBe(logger.correlationId);
    expect(records[0].subsystem).toBe('particles');
    expect(records[0].correlationId).toBe(logger.correlationId);
  });

  it('falls back to the default subsystem for a blank tag', () => {
    const { logger, records } = createCapturingLogger();

    logger.child('   ').info('blank tag');

    expect(records[0].subsystem).toBe('app');
  });

  it('delivers a child record to the parent sinks', () => {
    const { logger, records } = createCapturingLogger();

    logger.child('render').info('one');
    logger.info('two');

    const tags = records.map((record: LogRecord): string => record.subsystem);

    expect(tags).toEqual(['render', SUITE_SUBSYSTEM]);
  });
});

/* --------------------------------------------------------------------------
 * Level filter
 * ----------------------------------------------------------------------- */

describe('log levels', () => {
  it('exposes the four levels in ascending severity order', () => {
    expect(LOG_LEVELS).toEqual(['debug', 'info', 'warn', 'error']);

    LOG_LEVELS.forEach((level: LogLevel, index: number): void => {
      if (index === 0) {
        return;
      }

      expect(LOG_LEVEL_SEVERITY[level]).toBeGreaterThan(
        LOG_LEVEL_SEVERITY[LOG_LEVELS[index - 1]]
      );
    });
  });

  it('narrows only the four level names', () => {
    for (const level of LOG_LEVELS) {
      expect(isLogLevel(level)).toBe(true);
    }

    const rejected = ['', 'DEBUG', 'trace', 'fatal', 30, null, undefined];

    for (const candidate of rejected) {
      expect(isLogLevel(candidate)).toBe(false);
    }
  });
});

describe('Logger level filtering', () => {
  it('starts at info so a debug record is discarded', () => {
    const { logger, records } = createCapturingLogger({ level: undefined });

    expect(logger.getLevel()).toBe('info');

    logger.debug('discarded');
    logger.info('kept');

    expect(records.map((record: LogRecord): string => record.message)).toEqual([
      'kept',
    ]);
  });

  it('reports the level set through setLevel', () => {
    const { logger } = createCapturingLogger();

    for (const level of LOG_LEVELS) {
      logger.setLevel(level);

      expect(logger.getLevel()).toBe(level);
    }
  });

  it('leaves the level unchanged for a value outside the four names', () => {
    const { logger } = createCapturingLogger();

    logger.setLevel('warn');
    logger.setLevel('fatal' as unknown as LogLevel);

    expect(logger.getLevel()).toBe('warn');
  });

  it('suppresses debug and info at warn while keeping warn and error', () => {
    const { logger, records } = createCapturingLogger();

    logger.setLevel('warn');
    logger.debug('suppressed debug');
    logger.info('suppressed info');
    logger.warn('kept warn');
    logger.error('kept error');

    expect(records.map((record: LogRecord): LogLevel => record.level)).toEqual([
      'warn',
      'error',
    ]);
  });

  it('discards a suppressed record before sink and buffer', () => {
    const logger = createLogger({
      runSeed: SUITE_SEED,
      level: 'error',
      consoleOutput: false,
    });
    let sinkCalls = 0;

    logger.subscribe((): void => {
      sinkCalls += 1;
    });

    logger.debug('suppressed');
    logger.info('suppressed');
    logger.warn('suppressed');

    expect(sinkCalls).toBe(0);
    expect(logger.recent()).toHaveLength(0);
    expect(logger.snapshot().emitted).toBe(0);
    expect(logger.snapshot().stored).toBe(0);

    logger.error('kept');

    expect(sinkCalls).toBe(1);
    expect(logger.snapshot().emitted).toBe(1);
  });

  it('shares the level with a child logger', () => {
    const { logger, records } = createCapturingLogger();
    const child = logger.child('render');

    logger.setLevel('error');

    expect(child.getLevel()).toBe('error');

    child.info('suppressed');
    child.error('kept');

    expect(records.map((record: LogRecord): string => record.message)).toEqual([
      'kept',
    ]);
  });
});

/* --------------------------------------------------------------------------
 * Recent-record buffer
 * ----------------------------------------------------------------------- */

describe('Logger recent-record buffer', () => {
  it('returns at most the requested number of records, oldest first', () => {
    const { logger } = createCapturingLogger({ capacity: 8 });

    for (let index = 0; index < 5; index += 1) {
      logger.info(`record-${index}`);
    }

    expect(
      logger.recent(2).map((record: LogRecord): string => record.message)
    ).toEqual(['record-3', 'record-4']);
    expect(logger.recent(0)).toHaveLength(0);
    expect(logger.recent(-3)).toHaveLength(0);
    expect(logger.recent(99)).toHaveLength(5);
  });

  it('returns every buffered record when no limit is given', () => {
    const { logger } = createCapturingLogger({ capacity: 8 });

    logger.info('first');
    logger.info('second');

    expect(
      logger.recent().map((record: LogRecord): string => record.message)
    ).toEqual(['first', 'second']);
  });

  it('bounds the buffer at its capacity instead of growing', () => {
    const capacity = 4;
    const emitted = 50;
    const { logger, records } = createCapturingLogger({ capacity });

    for (let index = 0; index < emitted; index += 1) {
      logger.info(`record-${index}`);
    }

    const snapshot = logger.snapshot();

    expect(logger.recent()).toHaveLength(capacity);
    expect(snapshot.stored).toBe(capacity);
    expect(snapshot.capacity).toBe(capacity);
    expect(snapshot.emitted).toBe(emitted);
    expect(snapshot.dropped).toBe(emitted - capacity);
    expect(
      logger.recent().map((record: LogRecord): string => record.message)
    ).toEqual(['record-46', 'record-47', 'record-48', 'record-49']);

    expect(records).toHaveLength(emitted);
  });

  it('clamps a requested capacity into the accepted range', () => {
    expect(
      createLogger({ capacity: 0, consoleOutput: false }).snapshot().capacity
    ).toBe(1);
    expect(
      createLogger({ capacity: -5, consoleOutput: false }).snapshot().capacity
    ).toBe(1);
    expect(
      createLogger({ capacity: 2.9, consoleOutput: false }).snapshot().capacity
    ).toBe(2);
    expect(
      createLogger({ capacity: 1e9, consoleOutput: false }).snapshot().capacity
    ).toBe(10000);
    expect(
      createLogger({
        capacity: Number.NaN,
        consoleOutput: false,
      }).snapshot().capacity
    ).toBe(DEFAULT_LOG_BUFFER_CAPACITY);
  });

  it('defaults the capacity when none is requested', () => {
    expect(createLogger({ consoleOutput: false }).snapshot().capacity).toBe(
      DEFAULT_LOG_BUFFER_CAPACITY
    );
  });

  it('discards buffered records on clear, keeping the counters', () => {
    const { logger } = createCapturingLogger({ capacity: 8 });

    logger.info('first');
    logger.info('second');
    logger.clear();

    const snapshot = logger.snapshot();

    expect(logger.recent()).toHaveLength(0);
    expect(snapshot.stored).toBe(0);
    expect(snapshot.emitted).toBe(2);
  });

  it('exports the records as one parseable JSON object per line', () => {
    const { logger } = createCapturingLogger({ capacity: 8 });

    logger.info('first', { stage: 1 });
    logger.error('second', { stage: 2 }, createCircularThrowable());

    const text = logger.toJsonLines();
    const lines = splitJsonLines(text);

    expect(text.endsWith('\n')).toBe(true);
    expect(lines).toHaveLength(2);

    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    expect(splitJsonLines(logger.toJsonLines(1))).toHaveLength(1);
    expect(createLogger({ consoleOutput: false }).toJsonLines()).toBe('');
  });
});

/* --------------------------------------------------------------------------
 * Sink registry
 * ----------------------------------------------------------------------- */

describe('Logger.subscribe', () => {
  it('returns a handle that stops delivery to the removed sink', () => {
    const logger = createLogger({ runSeed: SUITE_SEED, consoleOutput: false });
    const received: string[] = [];
    const unsubscribe = logger.subscribe((record: LogRecord): void => {
      received.push(record.message);
    });

    expect(typeof unsubscribe).toBe('function');
    expect(logger.snapshot().sinkCount).toBe(1);

    logger.info('delivered');
    unsubscribe();
    logger.info('not delivered');

    expect(received).toEqual(['delivered']);
    expect(logger.snapshot().sinkCount).toBe(0);
    expect(logger.snapshot().emitted).toBe(2);
  });

  it('tolerates an unsubscribe handle invoked more than once', () => {
    const logger = createLogger({ runSeed: SUITE_SEED, consoleOutput: false });
    const unsubscribe = logger.subscribe((): void => {
      return;
    });

    unsubscribe();

    expect(() => {
      unsubscribe();
      unsubscribe();
    }).not.toThrow();
    expect(logger.snapshot().sinkCount).toBe(0);
  });

  it('removes only its own registration for a twice-added sink', () => {
    const logger = createLogger({ runSeed: SUITE_SEED, consoleOutput: false });
    let calls = 0;
    const sink: LogSink = (): void => {
      calls += 1;
    };
    const first = logger.subscribe(sink);

    logger.subscribe(sink);
    logger.info('two registrations');

    expect(calls).toBe(2);

    first();
    logger.info('one registration');

    expect(calls).toBe(3);
    expect(logger.snapshot().sinkCount).toBe(1);
  });

  it('returns a callable handle for a sink that is not callable', () => {
    const logger = createLogger({ runSeed: SUITE_SEED, consoleOutput: false });
    const unsubscribe = logger.subscribe(undefined as unknown as LogSink);

    expect(typeof unsubscribe).toBe('function');
    expect(() => unsubscribe()).not.toThrow();
    expect(logger.snapshot().sinkCount).toBe(0);
    expect(() => logger.info('no sink to reach')).not.toThrow();
  });

  it('contains a throwing sink and delivers to the sinks after it', () => {
    const logger = createLogger({ runSeed: SUITE_SEED, consoleOutput: false });
    let laterSinkCalls = 0;

    logger.subscribe((): void => {
      throw new TypeError('sink refused the record');
    });
    logger.subscribe((): void => {
      laterSinkCalls += 1;
    });

    expect(() => logger.info('dispatched to both sinks')).not.toThrow();

    const snapshot = logger.snapshot();

    expect(laterSinkCalls).toBe(1);
    expect(snapshot.sinkFaults).toBe(1);
    expect(snapshot.lastSinkFault?.name).toBe('TypeError');
    expect(snapshot.lastSinkFault?.message).toBe('sink refused the record');
    expect(snapshot.stored).toBe(1);

    logger.info('a second record still reaches the later sink');

    expect(laterSinkCalls).toBe(2);
    expect(logger.snapshot().sinkFaults).toBe(2);
  });
});

describe('Logger console output', () => {
  it('writes each record to the console as one JSON line by default', () => {
    const writer = vi
      .spyOn(console, 'info')
      .mockImplementation((): void => undefined);
    const logger = createLogger({ runSeed: SUITE_SEED });

    logger.info('written to the console', { stage: 1 });

    expect(writer).toHaveBeenCalledTimes(1);

    const line: unknown = writer.mock.calls[0]?.[0];

    expect(typeof line).toBe('string');

    const parsed: unknown = JSON.parse(typeof line === 'string' ? line : '');

    expect(parsed).toMatchObject({
      correlationId: deriveCorrelationId(SUITE_SEED),
      level: 'info',
      message: 'written to the console',
    });
  });

  it('writes nothing to the console when console output is turned off', () => {
    const writers = [
      vi.spyOn(console, 'debug').mockImplementation((): void => undefined),
      vi.spyOn(console, 'info').mockImplementation((): void => undefined),
      vi.spyOn(console, 'warn').mockImplementation((): void => undefined),
      vi.spyOn(console, 'error').mockImplementation((): void => undefined),
      vi.spyOn(console, 'log').mockImplementation((): void => undefined),
    ];
    const { logger } = createCapturingLogger();

    logger.debug('silent');
    logger.info('silent');
    logger.warn('silent');
    logger.error('silent');

    for (const writer of writers) {
      expect(writer).not.toHaveBeenCalled();
    }
  });
});

/* --------------------------------------------------------------------------
 * Error serialisation
 *
 * Coverage of the discarded-error `catch` at js/local_storage_manager.js
 * L37-L39, which bound `error` and returned `false` without reporting it.
 * ----------------------------------------------------------------------- */

describe('serializeError', () => {
  it('round-trips an Error with its name, message and stack', () => {
    const serialized = serializeError(new Error('boom'));

    expect(serialized.name).toBe('Error');
    expect(serialized.message).toBe('boom');
    expect(typeof serialized.stack).toBe('string');
    expect(serialized.stack?.length).toBeGreaterThan(0);
  });

  it('retains the distinguishing name of an Error subclass', () => {
    expect(serializeError(new TypeError('bad type')).name).toBe('TypeError');
    expect(serializeError(new RangeError('out of range')).name).toBe(
      'RangeError'
    );
    expect(serializeError(new SyntaxError('unparseable')).name).toBe(
      'SyntaxError'
    );

    class QuotaExceededError extends Error {
      public override readonly name: string = 'QuotaExceededError';
    }

    expect(serializeError(new QuotaExceededError('no room')).name).toBe(
      'QuotaExceededError'
    );
  });

  it('serialises a nested cause', () => {
    const serialized = serializeError(
      new Error('outer', { cause: new TypeError('inner') })
    );

    expect(serialized.cause?.name).toBe('TypeError');
    expect(serialized.cause?.message).toBe('inner');
  });

  it('omits the cause member when the thrown value carries none', () => {
    expect('cause' in serializeError(new Error('no cause'))).toBe(false);
  });

  describe('non-Error throwables js/local_storage_manager.js L37 binds', () => {
    it('carries the text of a thrown string', () => {
      const thrown: unknown = 'localStorage is disabled';
      const serialized = serializeError(thrown);

      expect(serialized.message).toBe('localStorage is disabled');
      expect(serialized.name).toBe('UnknownError');
    });

    it('carries the value of a thrown number, zero included', () => {
      const positive: unknown = 22;
      const zero: unknown = 0;

      expect(serializeError(positive).message).toBe('22');
      expect(serializeError(zero).message).toBe('0');
      expect(serializeError(zero).message.length).toBeGreaterThan(0);
    });

    it('represents a thrown null distinguishably without throwing', () => {
      const thrown: unknown = null;

      expect(() => serializeError(thrown)).not.toThrow();
      expect(serializeError(thrown).message).toBe('null');
    });

    it('represents a thrown undefined distinguishably from null', () => {
      const undefinedThrown: unknown = undefined;
      const nullThrown: unknown = null;

      expect(() => serializeError(undefinedThrown)).not.toThrow();
      expect(serializeError(undefinedThrown).message).toBe('undefined');
      expect(serializeError(undefinedThrown).message).not.toBe(
        serializeError(nullThrown).message
      );
    });

    it('carries the value of a thrown boolean', () => {
      const truthy: unknown = true;
      const falsy: unknown = false;

      expect(serializeError(truthy).message).toBe('true');
      expect(serializeError(falsy).message).toBe('false');
    });

    it('carries the own enumerable properties of a thrown plain object', () => {
      const thrown: unknown = { code: 22, detail: 'quota', quota: true };
      const serialized = serializeError(thrown);

      expect(serialized.message).toContain('22');
      expect(serialized.message).toContain('quota');
      expect(serialized.message).toContain('code');
      expect(serialized.message).toContain('detail');
    });

    it('picks up an object message without fabricating a stack', () => {
      const thrown: unknown = { message: 'no room left', quota: true };
      const serialized = serializeError(thrown);

      expect(serialized.message).toBe('no room left');
      expect(serialized.name).toBe('UnknownError');
      expect('stack' in serialized).toBe(false);
      expect(serialized.stack).toBeUndefined();
    });

    it('reads the name off a non-Error object that carries one', () => {
      const thrown: unknown = {
        name: 'NS_ERROR_DOM_QUOTA_REACHED',
        message: 'persistent storage maximum size reached',
      };

      expect(serializeError(thrown).name).toBe('NS_ERROR_DOM_QUOTA_REACHED');
    });

    it('does not throw for an object whose toString throws', () => {
      const thrown: unknown = createThrowingToString();

      expect(() => serializeError(thrown)).not.toThrow();
      expect(typeof serializeError(thrown).message).toBe('string');
      expect(serializeError(thrown).message.length).toBeGreaterThan(0);
    });

    it('does not throw for an object whose message accessor throws', () => {
      const thrown: unknown = createThrowingMessageAccessor();

      expect(() => serializeError(thrown)).not.toThrow();
      expect(typeof serializeError(thrown).message).toBe('string');
      expect(serializeError(thrown).message.length).toBeGreaterThan(0);
    });

    it('does not throw for a circular structure', () => {
      const thrown: unknown = createCircularThrowable();

      expect(() => serializeError(thrown)).not.toThrow();
      expect(serializeError(thrown).name).toBe('CircularError');
      expect(serializeError(thrown).message.length).toBeGreaterThan(0);
    });

    it('does not throw for a self-referencing cause chain', () => {
      const outer = new Error('outer');

      Object.defineProperty(outer, 'cause', { value: outer, writable: true });

      expect(() => serializeError(outer)).not.toThrow();
      expect(serializeError(outer).name).toBe('Error');
    });

    it('returns a JSON-serialisable record for every throwable', () => {
      for (const testCase of enumerateThrowables()) {
        const serialized = serializeError(testCase.thrown);

        expect(
          typeof serialized.name,
          `name for ${testCase.label}`
        ).toBe('string');
        expect(
          typeof serialized.message,
          `message for ${testCase.label}`
        ).toBe('string');
        expect(
          () => JSON.stringify(serialized),
          `JSON.stringify for ${testCase.label}`
        ).not.toThrow();
        expect(
          typeof JSON.stringify(serialized),
          `JSON text for ${testCase.label}`
        ).toBe('string');
      }
    });

    it('returns a frozen record', () => {
      expect(Object.isFrozen(serializeError('frozen'))).toBe(true);
      expect(Object.isFrozen(serializeError(new Error('frozen')))).toBe(true);
    });
  });

  it('reaches LogRecord.error with the correlation id present', () => {
    const { logger, records } = createCapturingLogger();
    const thrownString: unknown = 'localStorage is disabled';
    const thrownObject: unknown = { message: 'no room left', quota: true };

    logger.error('a storage write failed', thrownString);
    logger.error(
      'a storage write failed',
      { key: BEST_SCORE_KEY },
      thrownObject
    );

    expect(records).toHaveLength(2);
    expect(records[0].error).toEqual(serializeError(thrownString));
    expect(records[0].correlationId).toBe(deriveCorrelationId(SUITE_SEED));
    expect(records[1].error).toEqual(serializeError(thrownObject));
    expect(records[1].fields).toEqual({ key: BEST_SCORE_KEY });
    expect(records[1].correlationId).toBe(deriveCorrelationId(SUITE_SEED));
  });

  it('keeps a record with a circular thrown value JSON-exportable', () => {
    const { logger } = createCapturingLogger({ capacity: 4 });
    const circular: unknown = createCircularThrowable();

    logger.error('reported', { detail: 'circular thrown value' }, circular);

    const text = logger.toJsonLines();

    expect(() => JSON.parse(text.trimEnd())).not.toThrow();
  });
});

/* --------------------------------------------------------------------------
 * Reporter adapters
 *
 * src/engine/types.ts, src/input/keymap.ts and
 * src/storage/local-storage-manager.ts each declare their own reporter
 * contract and import nothing from src/observability. Each block below
 * annotates the adapter with the contract type imported from the declaring
 * layer, then drives the adapter through a logger.
 * ----------------------------------------------------------------------- */

describe('createEngineReporter', () => {
  it('satisfies the EngineReporter contract src/engine declares', () => {
    const { logger } = createCapturingLogger();
    const reporter: EngineReporter = createEngineReporter(logger);

    expect(typeof reporter.onHookError).toBe('function');
    expect(typeof reporter.onCount).toBe('function');
  });

  it('records a contained hook-handler throw at error', () => {
    const { logger, records } = createCapturingLogger();
    const reporter: EngineReporter = createEngineReporter(logger);
    const report: EngineHookErrorReport = {
      runId: deriveCorrelationId(SUITE_SEED),
      hook: 'onMerge',
      subscriberId: 'relic:merge-echo',
      error: 'the relic handler threw a string',
    };

    reporter.onHookError?.(report);

    expect(records).toHaveLength(1);

    const record = records[0];

    expect(record.level).toBe('error');
    expect(record.subsystem).toBe('engine');
    expect(record.correlationId).toBe(deriveCorrelationId(SUITE_SEED));
    expect(record.fields).toEqual({
      runId: report.runId,
      hook: 'onMerge',
      subscriberId: 'relic:merge-echo',
    });
    expect(record.error).toEqual(serializeError(report.error));
  });

  it('records an engine counter at debug', () => {
    const { logger, records } = createCapturingLogger();
    const reporter: EngineReporter = createEngineReporter(logger);
    const withHook: EngineCountReport = {
      runId: deriveCorrelationId(SUITE_SEED),
      metric: 'hook.dispatch',
      value: 1,
      hook: 'onAfterMove',
    };
    const withoutHook: EngineCountReport = {
      runId: deriveCorrelationId(SUITE_SEED),
      metric: 'move.committed',
      value: 2,
    };

    reporter.onCount?.(withHook);
    reporter.onCount?.(withoutHook);

    expect(records).toHaveLength(2);
    expect(records[0].level).toBe('debug');
    expect(records[0].subsystem).toBe('engine');
    expect(records[0].fields).toEqual({
      runId: withHook.runId,
      metric: 'hook.dispatch',
      value: 1,
      hook: 'onAfterMove',
    });
    expect(records[1].fields).toEqual({
      runId: withoutHook.runId,
      metric: 'move.committed',
      value: 2,
      hook: null,
    });
  });
});

describe('createInputReporter', () => {
  it('satisfies the InputReporter contract src/input declares', () => {
    const { logger } = createCapturingLogger();
    const reporter: InputReporter = createInputReporter(logger);

    expect(typeof reporter.log).toBe('function');
    expect(typeof reporter.count).toBe('function');
    expect(typeof reporter.startSpan).toBe('function');
  });

  it('records a message at the level the input layer reports', () => {
    const { logger, records } = createCapturingLogger();
    const reporter: InputReporter = createInputReporter(logger);

    for (const level of LOG_LEVELS) {
      reporter.log(level, `reported at ${level}`, { key: 'ArrowUp' });
    }

    expect(records).toHaveLength(LOG_LEVELS.length);

    records.forEach((record: LogRecord, index: number): void => {
      expect(record.level).toBe(LOG_LEVELS[index]);
      expect(record.subsystem).toBe('input');
      expect(record.message).toBe(`reported at ${LOG_LEVELS[index]}`);
      expect(record.fields).toEqual({ key: 'ArrowUp' });
      expect(record.correlationId).toBe(deriveCorrelationId(SUITE_SEED));
    });
  });

  it('records a counter with the metric merged into the caller fields', () => {
    const { logger, records } = createCapturingLogger();
    const reporter: InputReporter = createInputReporter(logger);

    reporter.count('input.remap', { source: 'keyboard' });
    reporter.count('input.gesture');

    expect(records[0].level).toBe('debug');
    expect(records[0].subsystem).toBe('input');
    expect(records[0].fields).toEqual({
      source: 'keyboard',
      metric: 'input.remap',
      value: 1,
    });
    expect(records[1].fields).toEqual({ metric: 'input.gesture', value: 1 });
  });

  it('records a span duration once when the span closes', () => {
    const { logger, records } = createCapturingLogger();
    const reporter: InputReporter = createInputReporter(logger);
    const span = reporter.startSpan?.('input.dispatch');

    expect(span).toBeDefined();
    expect(records).toHaveLength(0);

    span?.end();

    expect(records).toHaveLength(1);
    expect(records[0].level).toBe('debug');
    expect(records[0].subsystem).toBe('input');
    expect(records[0].fields?.['span']).toBe('input.dispatch');

    const duration = records[0].fields?.['durationMs'];

    expect(typeof duration).toBe('number');

    if (typeof duration === 'number') {
      expect(Number.isFinite(duration)).toBe(true);
      expect(duration).toBeGreaterThanOrEqual(0);
    }

    span?.end();

    expect(records).toHaveLength(1);
  });

  it('is accepted by the containment boundary in src/input', () => {
    const { logger, records } = createCapturingLogger();
    const guarded: InputReporter = createSafeInputReporter(
      createInputReporter(logger)
    );

    guarded.log('warn', 'the keymap fell back to its defaults', {
      reason: 'unparseable',
    });
    guarded.count('input.keymap.fallback');
    guarded.startSpan?.('input.parse').end();

    expect(records).toHaveLength(3);

    for (const record of records) {
      expect(record.subsystem).toBe('input');
      expect(record.correlationId).toBe(deriveCorrelationId(SUITE_SEED));
    }
  });
});

describe('createStorageReporter', () => {
  it('satisfies the StorageReporter contract src/storage declares', () => {
    const { logger } = createCapturingLogger();
    const reporter: StorageReporter = createStorageReporter(logger);

    expect(typeof reporter.onProbe).toBe('function');
    expect(typeof reporter.onFailure).toBe('function');
    expect(typeof reporter.onWrite).toBe('function');
  });

  it('records the writability probe outcome', () => {
    const { logger, records } = createCapturingLogger();
    const reporter: StorageReporter = createStorageReporter(logger);
    const supported: StorageProbeResult = {
      supported: true,
      strategy: 'localStorage',
    };
    const refused: StorageProbeResult = {
      supported: false,
      strategy: 'memory',
      error: PARSE_ERROR_INFO,
    };

    reporter.onProbe?.(supported);
    reporter.onProbe?.(refused);

    expect(records[0].level).toBe('info');
    expect(records[0].subsystem).toBe('storage');
    expect(records[0].fields).toEqual({
      supported: true,
      strategy: 'localStorage',
      quota: false,
    });
    expect(records[1].level).toBe('warn');
    expect(records[1].error).toEqual(serializeError(PARSE_ERROR_INFO));
  });

  it('serialises a quota rejection instead of discarding it', () => {
    const { logger, records } = createCapturingLogger();
    const reporter: StorageReporter = createStorageReporter(logger);

    reporter.onFailure?.(QUOTA_FAILURE);

    expect(records).toHaveLength(1);

    const record = records[0];

    expect(record.level).toBe('error');
    expect(record.subsystem).toBe('storage');
    expect(record.correlationId).toBe(deriveCorrelationId(SUITE_SEED));
    expect(record.fields).toEqual({
      operation: 'write',
      key: RUN_STATE_KEY,
      strategy: 'localStorage',
      quota: true,
    });
    expect(record.error).toBeDefined();
    expect(record.error?.name).toBe('QuotaExceededError');
    expect(record.error?.message).toBe(QUOTA_ERROR_INFO.message);
    expect(record.error).toEqual(serializeError(QUOTA_ERROR_INFO));
  });

  it('records a non-quota failure at warn with its error serialised', () => {
    const { logger, records } = createCapturingLogger();
    const reporter: StorageReporter = createStorageReporter(logger);

    reporter.onFailure?.(PARSE_FAILURE);

    expect(records[0].level).toBe('warn');
    expect(records[0].fields).toEqual({
      operation: 'read',
      key: GAME_STATE_KEY,
      strategy: 'memory',
      quota: false,
    });
    expect(records[0].error?.name).toBe('SyntaxError');
  });

  it('records a write attempt at a level matching its outcome', () => {
    const { logger, records } = createCapturingLogger();
    const reporter: StorageReporter = createStorageReporter(logger);
    const completed: StorageWriteInfo = {
      key: BEST_SCORE_KEY,
      byteLength: 12,
      ok: true,
    };
    const refused: StorageWriteInfo = {
      key: RUN_STATE_KEY,
      byteLength: 0,
      ok: false,
    };

    reporter.onWrite?.(completed);
    reporter.onWrite?.(refused);

    expect(records[0].level).toBe('debug');
    expect(records[0].fields).toEqual({
      key: BEST_SCORE_KEY,
      byteLength: 12,
      ok: true,
    });
    expect(records[1].level).toBe('warn');
    expect(records[1].fields).toEqual({
      key: RUN_STATE_KEY,
      byteLength: 0,
      ok: false,
    });
  });
});

describe('no-op reporters', () => {
  it('leaves NOOP_ENGINE_REPORTER callable and silent', () => {
    const { logger, records } = createCapturingLogger();

    logger.subscribe((): void => {
      throw new Error('no record should reach a sink');
    });

    expect(() => {
      NOOP_ENGINE_REPORTER.onHookError?.({
        runId: deriveCorrelationId(SUITE_SEED),
        hook: 'onSpawn',
        subscriberId: 'relic:cursed-shrink',
        error: new Error('handler threw'),
      });
      NOOP_ENGINE_REPORTER.onCount?.({
        runId: deriveCorrelationId(SUITE_SEED),
        metric: 'hook.dispatch',
        value: 1,
      });
    }).not.toThrow();

    expect(records).toHaveLength(0);
  });

  it('leaves NOOP_REPORTER callable and silent', () => {
    const { logger, records } = createCapturingLogger();

    logger.subscribe((): void => {
      throw new Error('no record should reach a sink');
    });

    expect(() => {
      NOOP_REPORTER.log('error', 'discarded', { key: 'ArrowUp' });
      NOOP_REPORTER.count('input.remap');
      NOOP_REPORTER.startSpan?.('input.dispatch').end();
    }).not.toThrow();

    expect(records).toHaveLength(0);
  });
});

/* --------------------------------------------------------------------------
 * Isolation
 * ----------------------------------------------------------------------- */

describe('suite isolation', () => {
  it('leaves the spied globals at their original references', () => {
    expect(Math.random).toBe(PRISTINE_MATH_RANDOM);
    expect(Math.random.toString()).toContain('native code');
    expect(Date.now.toString()).toContain('native code');
  });
});
