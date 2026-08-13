// Unit suite over src/observability/logger.ts: the run correlation identifier,
// the log record, the level filter, the sink registry, the bounded
// recent-record buffer, error serialisation, and the three reporter adapters.
//
// `deriveCorrelationId` is one of the tree's two implementations of one
// derivation; `runCorrelationId` of src/run/run-state.ts is the other, and
// tests/unit/run/run-state.test.ts holds the two byte-equal. The final describe
// block is the end-to-end identity evidence: the logger, the engine reporter
// adapter, the hook bus and the run layer all carry one identical value for
// one run.
//
// Collected by the unit:dom project in vitest.config.ts, which supplies a
// document. No test below reads or writes storage. tests/fixtures/storage.ts
// is loaded as a setup file for every unit suite and removes every owned key
// after each test.

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
  logRecordBounds,
  serializeError,
} from '../../../src/observability/logger';
import type {
  LogFieldValue,
  LogFields,
  LogLevel,
  LogRecord,
  LogSink,
  Logger,
  LoggerOptions,
} from '../../../src/observability/logger';

import {
  DEFAULT_BOARD_SIZE,
  createDefaultRulesConfig,
} from '../../../src/config/default-config';
import { createEngineEvents } from '../../../src/engine/engine-events';
import { Grid } from '../../../src/engine/grid';
import { createHookBus } from '../../../src/engine/hook-bus';
import type { HookContext, StageEndPayload } from '../../../src/engine/hooks';
import { NOOP_ENGINE_REPORTER } from '../../../src/engine/types';
import type {
  EngineCountReport,
  EngineHookErrorReport,
  EngineListenerErrorReport,
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
  LocalStorageManager,
} from '../../../src/storage/local-storage-manager';
import { MemoryStorage } from '../../../src/storage/memory-storage';
import type { StorageLike } from '../../../src/storage/memory-storage';
import { createRngStreams } from '../../../src/rng/rng-streams';
import * as runStateModule from '../../../src/run/run-state';
import { runCorrelationId } from '../../../src/run/run-state';
import {
  BEST_SCORE_KEY,
  GAME_STATE_KEY,
  RUN_STATE_KEY,
} from '../../../src/storage/storage-keys';

const CORRELATION_ID_PATTERN = /^run-[0-9a-z]{14}$/;

const CORRELATION_ID_LENGTH = 18;

const SUITE_SEED = 'run-seed-2048';

/** The identifier the canonical derivation renders for the suite's pair. */
const SUITE_CORRELATION_ID = deriveCorrelationId(SUITE_SEED);

/** Subsystem tag the suite's own loggers carry. */
const SUITE_SUBSYSTEM = 'suite';

/**
 * A source location in any of the three forms a stack frame writes one: a URL,
 * a Windows absolute path, or a POSIX absolute path of two segments or more.
 */
const SOURCE_LOCATION_PATTERN =
  /[a-z][a-z0-9+.-]*:\/\/|[a-z]:\\|(?:\/[\w.@~+-]+){2,}/i;

/** Identifier `deriveCorrelationId` returns for each of these seeds. */
const CORRELATION_ID_GOLDEN: ReadonlyArray<readonly [string, string]> = [
  ['', 'run-0ztntfp000045h'],
  ['run-seed-2048', 'run-1davmkd1yax7kz'],
  ['forbidden-source-seed', 'run-1x9wnx61hzlegu'],
];

/**
 * `Math.random` as it stood when this suite's module graph finished loading.
 */
const PRISTINE_MATH_RANDOM = Math.random;

/** `Date.now` as it stood when this suite's module graph finished loading. */
const PRISTINE_DATE_NOW = Date.now;

/** A logger paired with the records its subscribed sink has captured. */
interface CapturedLogger {
  readonly logger: Logger;
  readonly records: LogRecord[];
}

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

interface EmittedRecord {
  readonly level: LogLevel;
  readonly message: string;
}

function splitJsonLines(text: string): readonly string[] {
  return text.split('\n').filter((line: string): boolean => line.length > 0);
}

function resolveUuidSource(): Crypto | null {
  const host: unknown = globalThis.crypto;

  if (typeof host !== 'object' || host === null) {
    return null;
  }

  const source = host as Crypto;

  return typeof source.randomUUID === 'function' ? source : null;
}

interface ThrowableCase {
  readonly label: string;
  readonly thrown: unknown;
}

function createThrowingToString(): unknown {
  return {
    code: 7,
    toString(): string {
      throw new Error('toString refused');
    },
  };
}

function createThrowingMessageAccessor(): unknown {
  return {
    get message(): string {
      throw new Error('message accessor refused');
    },
  };
}

interface CircularThrowable {
  name: string;
  self?: CircularThrowable;
}

function createCircularThrowable(): unknown {
  const circular: CircularThrowable = { name: 'CircularError' };

  circular.self = circular;

  return circular;
}

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

const QUOTA_ERROR_INFO: StorageErrorInfo = {
  name: 'QuotaExceededError',
  message: 'The storage quota has been exceeded.',
  quota: true,
  parse: false,
};

const PARSE_ERROR_INFO: StorageErrorInfo = {
  name: 'SyntaxError',
  message: 'Unexpected end of JSON input',
  quota: false,

  // The stored text is what failed here, which is what the adapter tags at its
  // parse and what the composition root tiers its report on.
  parse: true,
};

/** The value the platform threw for the quota failure below. */
const QUOTA_THROWN = new DOMException(
  'The storage quota has been exceeded.',
  'QuotaExceededError',
);

/** The value thrown for the parse failure: an `Error` with a cause chain. */
const PARSE_THROWN = new SyntaxError('Unexpected end of JSON input', {
  cause: new Error('the stored value was truncated'),
});

const QUOTA_FAILURE: StorageFailure = {
  operation: 'write',
  key: RUN_STATE_KEY,
  strategy: 'localStorage',
  error: QUOTA_ERROR_INFO,
  thrown: QUOTA_THROWN,
};

const PARSE_FAILURE: StorageFailure = {
  operation: 'read',
  key: GAME_STATE_KEY,
  strategy: 'memory',
  error: PARSE_ERROR_INFO,
  thrown: PARSE_THROWN,
};

/** A failure no value was thrown for: a key this product does not own. */
const REFUSED_KEY_FAILURE: StorageFailure = {
  operation: 'read',
  key: 'theme',
  strategy: 'memory',
  error: {
    name: 'StorageKeyError',
    message:
      'The key is not owned by this product; the operation was refused ' +
      'and no storage was touched.',
    quota: false,
    parse: false,
  },
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('deriveCorrelationId', () => {
  it('derives the same identifier across independent calls', () => {
    expect(deriveCorrelationId('run-seed-2048')).toBe(
      deriveCorrelationId('run-seed-2048')
    );
    expect(deriveCorrelationId('seed-42')).toBe(
      deriveCorrelationId('seed-42')
    );
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
    const derived = new Set(
      seeds.map((seed: string): string =>
        deriveCorrelationId(seed)
      )
    );

    expect(derived.size).toBe(seeds.length);
  });

  it('derives a non-empty identifier of a stable shape for every seed', () => {
    const seeds = [
      '',
      'run-seed-2048',
      '0',
      'a'.repeat(512),
      '𝟚𝟘𝟜𝟠',
    ];

    for (const seed of seeds) {
      const derived = deriveCorrelationId(seed);

      expect(derived.length).toBeGreaterThan(0);
      expect(derived).toHaveLength(CORRELATION_ID_LENGTH);
      expect(derived).toMatch(CORRELATION_ID_PATTERN);
    }
  });

  it('derives the one recorded identifier for each recorded seed', () => {
    for (const [seed, expected] of CORRELATION_ID_GOLDEN) {
      expect(deriveCorrelationId(seed)).toBe(expected);
    }
  });

  it('derives that identifier again after a logger has emitted', () => {
    const [seed, expected] = CORRELATION_ID_GOLDEN[1];
    const { logger } = createCapturingLogger({ runSeed: seed });

    logger.info('emitted');
    logger.warn('emitted again', { key: 'ArrowUp' });

    expect(deriveCorrelationId(seed)).toBe(expected);
  });

  it('reads no wall clock and no UUID source', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    const uuidSource = resolveUuidSource();
    const uuidSpy =
      uuidSource === null ? null : vi.spyOn(uuidSource, 'randomUUID');

    deriveCorrelationId('forbidden-source-seed');
    deriveCorrelationId('');

    expect(nowSpy).not.toHaveBeenCalled();

    if (uuidSpy !== null) {
      expect(uuidSpy).not.toHaveBeenCalled();
    }
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

  it('groups a replay when it is given the seed alone', () => {
    // The seed-only form.
    const replayed = 'run-seed-replayed';

    expect(deriveCorrelationId(replayed)).toBe(deriveCorrelationId(replayed));
    expect(deriveCorrelationId(replayed)).toHaveLength(18);
  });

  it('distinguishes two runs of one seed when given a run instance', () => {
    const seed = 'run-seed-shared';
    const first = deriveCorrelationId(seed, 'instance-one');
    const second = deriveCorrelationId(seed, 'instance-two');

    expect(first).not.toBe(second);

    expect(deriveCorrelationId(seed, 'instance-one')).toBe(first);
  });

  it('keeps no seed-only segment inside the instance identifier', () => {
    const seed = 'run-seed-prefixed';
    const grouped = deriveCorrelationId(seed);
    const instance = deriveCorrelationId(seed, 'instance');

    // KEYED, NOT PREFIXED. Every segment of the instance form is derived from
    // the run identifier and the seed together, so the form a dictionary CAN
    // recover — the seed-only one — appears nowhere inside it. Were it to
    // appear, as the leading 18 characters, every exported identifier would
    // be a matcher for candidate seeds.
    expect(instance).toHaveLength(26);
    expect(instance.startsWith(grouped)).toBe(false);
    expect(instance).not.toContain(grouped.slice('run-'.length));

    // The shape is unchanged: the prefix, 14 characters, a separator and 7.
    expect(instance).toMatch(/^run-[0-9a-z]{14}-[0-9a-z]{7}$/);
    expect(grouped).toMatch(/^run-[0-9a-z]{14}$/);
  });

  it('changes every segment when the run instance changes', () => {
    const seed = 'run-seed-keyed';
    const first = deriveCorrelationId(seed, 'instance-one');
    const second = deriveCorrelationId(seed, 'instance-two');

    // Both segments move with the key, which is what stops a reader lining two
    // runs of one seed up — and stops a holder of candidate seeds testing them
    // against either segment without the key.
    expect(first.slice(0, 18)).not.toBe(second.slice(0, 18));
    expect(first.slice(-7)).not.toBe(second.slice(-7));
  });

  it('treats an absent and an empty run instance as the grouping form', () => {
    const seed = 'run-seed-empty-instance';

    expect(deriveCorrelationId(seed, '')).toBe(deriveCorrelationId(seed));
    expect(deriveCorrelationId(seed, undefined)).toBe(
      deriveCorrelationId(seed),
    );
  });

  it('separates two seeds sharing one run instance', () => {
    // The instance segment is hashed over the run identifier AND the seed, so
    // it cannot be read back as a bare hash of the run identifier and two
    // seeds sharing one do not collide on that segment.
    const first = deriveCorrelationId('seed-alpha', 'shared-instance');
    const second = deriveCorrelationId('seed-beta', 'shared-instance');

    expect(first).not.toBe(second);
    expect(first.slice(-7)).not.toBe(second.slice(-7));
  });

  it('separates two run instances sharing one seed', () => {
    // The run identifier is the uniqueness component: two runs replaying one
    // seed are one GROUP but two INSTANCES, so the grouped value they share
    // must not be the value either instance carries.
    const seed = 'run-seed-shared-group';
    const grouped = deriveCorrelationId(seed);
    const first = deriveCorrelationId(seed, 'replay-one');
    const second = deriveCorrelationId(seed, 'replay-two');

    expect(first).not.toBe(second);
    expect(first).not.toBe(grouped);
    expect(second).not.toBe(grouped);
    expect(deriveCorrelationId(seed, 'replay-one')).toBe(first);
  });

  it('is the identifier every injected reporter reports under', () => {
    // One derivation, injected into the engine and into the logger, puts the
    // report's identifier and the record's own identifier in agreement.
    const seed = 'run-seed-single-authority';
    const injected = deriveCorrelationId(seed);
    const { logger, records } = createCapturingLogger({ runSeed: seed });
    const reporter: EngineReporter = createEngineReporter(logger);

    reporter.onCount?.({
      correlationId: injected,
      metric: 'hook.dispatch',
      value: 1,
    });

    expect(records).toHaveLength(1);
    expect(records[0].correlationId).toBe(injected);
    expect(records[0].fields?.['reportedCorrelationId']).toBe(injected);
  });
});

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
      expect(record.correlationId).toBe(SUITE_CORRELATION_ID);
      expect(record.subsystem).toBe(SUITE_SUBSYSTEM);
    });
  });

  it('carries the identifier derived from the run seed', () => {
    const { logger, records } = createCapturingLogger({ runSeed: 'seed-42' });

    logger.info('seeded');

    expect(logger.correlationId).toBe(
      deriveCorrelationId('seed-42')
    );
    expect(records[0].correlationId).toBe(
      deriveCorrelationId('seed-42')
    );
  });

  it('carries an explicit correlation id ahead of the derived seed', () => {
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

describe('Logger.setCorrelationId', () => {
  it('carries the new identifier on every later record', () => {
    const { logger, records } = createCapturingLogger();

    logger.info('before the rotation');
    logger.setCorrelationId('run-second-seed-abc');
    logger.info('after the rotation');

    expect(records[0].correlationId).not.toBe('run-second-seed-abc');
    expect(records[1].correlationId).toBe('run-second-seed-abc');

    // Records already emitted are NOT rewritten: they were true when written.
    expect(records[0].correlationId).toBe(records[0].correlationId);
  });

  it('reports the rotated identifier through the accessor and the snapshot', () => {
    const { logger } = createCapturingLogger();

    logger.setCorrelationId('run-rotated-xyz');

    expect(logger.correlationId).toBe('run-rotated-xyz');
    expect(logger.snapshot().correlationId).toBe('run-rotated-xyz');
  });

  it('rotates every logger sharing the state, children included', () => {
    const { logger, records } = createCapturingLogger();
    const child = logger.child('render');
    const nested = child.child('particles');

    logger.setCorrelationId('run-shared-state');

    expect(child.correlationId).toBe('run-shared-state');
    expect(nested.correlationId).toBe('run-shared-state');

    nested.info('from the particle system');

    expect(records[0].correlationId).toBe('run-shared-state');
  });

  it('rotates from a child too, since the state is one object', () => {
    const { logger } = createCapturingLogger();
    const child = logger.child('render');

    child.setCorrelationId('run-from-the-child');

    expect(logger.correlationId).toBe('run-from-the-child');
  });

  it('leaves the identifier unchanged for a blank or non-string value', () => {
    const { logger } = createCapturingLogger();
    const original = logger.correlationId;

    logger.setCorrelationId('');
    expect(logger.correlationId).toBe(original);

    logger.setCorrelationId(undefined as unknown as string);
    expect(logger.correlationId).toBe(original);

    logger.setCorrelationId(7 as unknown as string);
    expect(logger.correlationId).toBe(original);
  });

  it('accepts what deriveCorrelationId produces, which is its only source', () => {
    const { logger } = createCapturingLogger();
    const derived = deriveCorrelationId('second-run-seed', 'second-run-id');

    logger.setCorrelationId(derived);

    expect(logger.correlationId).toBe(derived);
  });
});

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

describe('Logger.subscribe', () => {
  it('returns a handle that stops delivery to the removed sink', () => {
    const logger = createLogger({
      runSeed: SUITE_SEED,
      consoleOutput: false,
    });
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
    const logger = createLogger({
      runSeed: SUITE_SEED,
      consoleOutput: false,
    });
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
    const logger = createLogger({
      runSeed: SUITE_SEED,
      consoleOutput: false,
    });
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
    const logger = createLogger({
      runSeed: SUITE_SEED,
      consoleOutput: false,
    });
    const unsubscribe = logger.subscribe(undefined as unknown as LogSink);

    expect(typeof unsubscribe).toBe('function');
    expect(() => unsubscribe()).not.toThrow();
    expect(logger.snapshot().sinkCount).toBe(0);
    expect(() => logger.info('no sink to reach')).not.toThrow();
  });

  it('contains a throwing sink and delivers to the sinks after it', () => {
    const logger = createLogger({
      runSeed: SUITE_SEED,
      consoleOutput: false,
    });
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
    const logger = createLogger({
      runSeed: SUITE_SEED,
    });

    logger.info('written to the console', { stage: 1 });

    expect(writer).toHaveBeenCalledTimes(1);

    const line: unknown = writer.mock.calls[0]?.[0];

    expect(typeof line).toBe('string');

    const parsed: unknown = JSON.parse(typeof line === 'string' ? line : '');

    expect(parsed).toMatchObject({
      correlationId: SUITE_CORRELATION_ID,
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

describe('serializeError', () => {
  it('carries an Error name and message and a stack with no source ' +
    'location', () => {
    const serialized = serializeError(new Error('boom'));

    expect(serialized.name).toBe('Error');
    expect(serialized.message).toBe('boom');

    // The stack is still reported — the frame names are what make it
    // diagnosable — but no path and no URL survives in it.
    expect(typeof serialized.stack).toBe('string');
    expect(serialized.stack?.length).toBeGreaterThan(0);
    expect(serialized.stack).toContain(logRecordBounds.redactedLocation);
    expect(serialized.stack).not.toMatch(SOURCE_LOCATION_PATTERN);
  });

  it('redacts a location a thrown value carries in any of the three forms',
    () => {
      const stacked = {
        name: 'PlantedError',
        message: 'planted',
        stack: [
          'PlantedError: planted',
          '    at handler (/srv/app/src/engine/hook-bus.ts:1234:9)',
          '    at frame (https://example.test/assets/index-abc123.js:7:1)',
          '    at boot (C:\\\\Users\\\\dev\\\\app\\\\src\\\\main.ts:3:2)',
        ].join('\n'),
      };

      const serialized = serializeError(stacked);

      expect(serialized.stack).not.toMatch(SOURCE_LOCATION_PATTERN);
      expect(serialized.stack).toContain('handler');
      expect(serialized.stack).toContain('frame');
      expect(serialized.stack).toContain('boot');
    });

  it('reserves the unredacted stack for a caller that asks for it', () => {
    const stacked = {
      name: 'PlantedError',
      message: 'planted',
      stack: 'at handler (/srv/app/src/engine/hook-bus.ts:1234:9)',
    };

    const detailed = serializeError(stacked, 'full');

    expect(detailed.stack).toContain('/srv/app/src/engine/hook-bus.ts');
    expect(serializeError(stacked).stack).not.toMatch(
      SOURCE_LOCATION_PATTERN
    );
  });

  it('bounds the name, the message and the stack it carries', () => {
    const oversized = {
      name: 'N'.repeat(4_000),
      message: 'M'.repeat(40_000),
      stack: 'S'.repeat(400_000),
    };

    const serialized = serializeError(oversized);

    expect(serialized.name.length).toBeLessThanOrEqual(
      logRecordBounds.errorName + 1
    );
    expect(serialized.message.length).toBeLessThanOrEqual(
      logRecordBounds.errorMessage + 1
    );
    expect(serialized.stack?.length ?? 0).toBeLessThanOrEqual(
      logRecordBounds.errorStack + 1
    );
    expect(serialized.stack).toContain(logRecordBounds.truncationSuffix);
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

    logger.failure('error', 'a storage write failed', {
      thrown: thrownString,
    });
    logger.error(
      'a storage write failed',
      { key: BEST_SCORE_KEY },
      thrownObject
    );

    expect(records).toHaveLength(2);
    expect(records[0].error).toEqual(serializeError(thrownString));
    expect(records[0].correlationId).toBe(SUITE_CORRELATION_ID);
    expect(records[1].error).toEqual(serializeError(thrownObject));
    expect(records[1].fields).toEqual({ key: BEST_SCORE_KEY });
    expect(records[1].correlationId).toBe(SUITE_CORRELATION_ID);
  });

  it('keeps a record with a circular thrown value JSON-exportable', () => {
    const { logger } = createCapturingLogger({ capacity: 4 });
    const circular: unknown = createCircularThrowable();

    logger.error('reported', { detail: 'circular thrown value' }, circular);

    const text = logger.toJsonLines();

    expect(() => JSON.parse(text.trimEnd())).not.toThrow();
  });

  it('carries a thrown plain object as the error, never as fields', () => {
    const { logger, records } = createCapturingLogger();
    const thrown: unknown = { code: 'QuotaExceededError', bytes: 5_242_880 };

    logger.failure('error', 'a storage write failed', {
      thrown,
      fields: { key: BEST_SCORE_KEY },
    });

    expect(records).toHaveLength(1);
    expect(records[0].error).toEqual(serializeError(thrown));
    expect(records[0].fields).toEqual({ key: BEST_SCORE_KEY });
  });

  it('reports a thrown undefined and a thrown null as failures', () => {
    const { logger, records } = createCapturingLogger();

    logger.failure('error', 'a handler threw undefined', {
      thrown: undefined,
    });
    logger.failure('error', 'a handler threw null', { thrown: null });
    logger.error('an undefined thrown value, positionally', undefined, undefined);

    expect(records).toHaveLength(3);
    expect(records[0].error).toEqual(serializeError(undefined));
    expect(records[1].error).toEqual(serializeError(null));
    expect(records[2].error).toEqual(serializeError(undefined));
  });

  it('records no error when a failure carries no throwable', () => {
    const { logger, records } = createCapturingLogger();

    logger.failure('warn', 'no throwable', { fields: { attempt: 1 } });
    logger.warn('no throwable, positionally', { attempt: 2 });

    expect(records).toHaveLength(2);
    expect(records[0].error).toBeUndefined();
    expect(records[0].fields).toEqual({ attempt: 1 });
    expect(records[1].error).toBeUndefined();
  });

  it('records a failure at the level the caller names', () => {
    const { logger, records } = createCapturingLogger();

    for (const level of LOG_LEVELS) {
      logger.failure(level, `reported at ${level}`, { thrown: level });
    }

    expect(records.map((record: LogRecord): LogLevel => record.level)).toEqual([
      ...LOG_LEVELS,
    ]);
  });
});

describe('field sanitisation', () => {
  it('deep-copies, so a later mutation cannot reach a buffered record', () => {
    const { logger, records } = createCapturingLogger();
    const nested = { depth: 1, tags: ['spawn'] };

    logger.info('emitted', { nested });

    nested.depth = 99;
    nested.tags.push('merge');

    expect(records[0].fields).toEqual({ nested: { depth: 1, tags: ['spawn'] } });
  });

  it('freezes every level of the carried tree', () => {
    const { logger, records } = createCapturingLogger();

    logger.info('emitted', { nested: { inner: { leaf: 'value' } } });

    const fields = records[0].fields;
    const nested = fields?.['nested'] as Record<string, unknown>;
    const inner = nested['inner'] as Record<string, unknown>;

    expect(Object.isFrozen(fields)).toBe(true);
    expect(Object.isFrozen(nested)).toBe(true);
    expect(Object.isFrozen(inner)).toBe(true);
  });

  it('builds field objects with a null prototype', () => {
    const { logger, records } = createCapturingLogger();

    logger.info('emitted', { nested: { leaf: 1 } });

    const fields = records[0].fields as object;

    expect(Object.getPrototypeOf(fields)).toBeNull();
    expect(
      Object.getPrototypeOf(
        (records[0].fields as Record<string, unknown>)['nested'] as object
      )
    ).toBeNull();
  });

  it('rejects __proto__, constructor and prototype as field names', () => {
    const { logger, records } = createCapturingLogger();
    const hostile = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":1,"prototype":2,"ok":3}'
    ) as LogFields;

    logger.info('emitted', hostile);

    const fields = records[0].fields as Record<string, unknown>;

    expect(fields['ok']).toBe(3);
    expect(Object.prototype.hasOwnProperty.call(fields, '__proto__')).toBe(
      false
    );
    expect(Object.prototype.hasOwnProperty.call(fields, 'constructor')).toBe(
      false
    );
    expect(Object.prototype.hasOwnProperty.call(fields, 'prototype')).toBe(
      false
    );
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('round-trips undefined and the non-finite numbers through JSON', () => {
    const { logger, records } = createCapturingLogger();

    logger.info('emitted', {
      absent: undefined,
      notANumber: Number.NaN,
      positive: Number.POSITIVE_INFINITY,
      negative: Number.NEGATIVE_INFINITY,
      finite: 42,
    });

    const record = records[0];

    expect(record.fields).toEqual({
      absent: null,
      notANumber: 'NaN',
      positive: 'Infinity',
      negative: '-Infinity',
      finite: 42,
    });
    expect(JSON.parse(JSON.stringify(record))).toEqual(
      JSON.parse(JSON.stringify(record))
    );
    expect(JSON.parse(JSON.stringify(record)).fields).toEqual(record.fields);
  });

  it('bounds string length, member count, element count and depth', () => {
    const { logger, records } = createCapturingLogger();
    const wide: Record<string, number> = {};

    for (let index = 0; index < 100; index += 1) {
      wide[`key${index}`] = index;
    }

    logger.info('emitted', {
      long: 'x'.repeat(4096),
      wide,
      many: Array.from({ length: 200 }, (_unused, index): number => index),
      deep: { a: { b: { c: { d: { e: 'too deep' } } } } },
    });

    const fields = records[0].fields as Record<string, unknown>;

    expect((fields['long'] as string).length).toBeLessThanOrEqual(513);
    expect(Object.keys(fields['wide'] as object).length).toBeLessThanOrEqual(33);
    expect((fields['many'] as unknown[]).length).toBeLessThanOrEqual(65);

    const a = (fields['deep'] as Record<string, unknown>)['a'] as Record<
      string,
      unknown
    >;
    const b = a['b'] as Record<string, unknown>;

    expect(b['c']).toBe('[depth limit]');
  });

  it('records an accessor that throws rather than dropping the bag', () => {
    const { logger, records } = createCapturingLogger();
    const hostile = {} as LogFields;

    Object.defineProperty(hostile, 'explodes', {
      enumerable: true,
      get(): never {
        throw new Error('accessor refused');
      },
    });
    Object.defineProperty(hostile, 'reads', {
      enumerable: true,
      value: 'fine',
    });

    logger.info('emitted', hostile);

    expect(records[0].fields).toEqual({
      explodes: '[unreadable value]',
      reads: 'fine',
    });
  });

  it('cuts a cycle inside the field bag', () => {
    const { logger, records } = createCapturingLogger();
    const cyclic: Record<string, unknown> = { name: 'stage' };

    cyclic['self'] = cyclic;

    logger.info('emitted', cyclic as LogFields);

    expect(records[0].fields).toEqual({ name: 'stage', self: '[circular]' });
    expect(() => JSON.stringify(records[0])).not.toThrow();
  });

  it('bounds a serialised error message and stack', () => {
    const oversized = new Error('m'.repeat(4096));

    oversized.stack = 's'.repeat(8192);

    const serialized = serializeError(oversized);

    expect(serialized.message.length).toBeLessThanOrEqual(1025);
    expect((serialized.stack ?? '').length).toBeLessThanOrEqual(4097);
  });
});

describe('emitted records are bounded and carry no source location', () => {
  it('redacts the stack a sink receives', () => {
    const { logger, records } = createCapturingLogger();

    logger.error('a handler threw', undefined, new Error('boom'));

    expect(records).toHaveLength(1);
    expect(records[0].error?.stack).not.toMatch(SOURCE_LOCATION_PATTERN);
    expect(records[0].error?.stack).toContain(
      logRecordBounds.redactedLocation
    );
  });

  it('keeps the full stack for a private development sink and redacts the ' +
    'export anyway', () => {
    const records: LogRecord[] = [];
    const logger = createLogger({
      runSeed: SUITE_SEED,
      subsystem: SUITE_SUBSYSTEM,
      consoleOutput: false,
      errorDetail: 'full',
    });

    logger.subscribe((record: LogRecord): void => {
      records.push(record);
    });

    const planted = new Error('planted');

    planted.stack = 'at handler (/srv/app/src/engine/hook-bus.ts:1234:9)';
    logger.error('a handler threw', undefined, planted);

    // The sink sees the location.
    expect(records[0].error?.stack).toContain('/srv/app/src/engine');

    // The two export surfaces do not.
    expect(logger.toJsonLines()).not.toContain('/srv/app/src/engine');
    expect(logger.snapshot().records[0].error?.stack).not.toMatch(
      SOURCE_LOCATION_PATTERN
    );
  });

  it('redacts the MESSAGE a sink receives, and its causes', () => {
    const { logger, records } = createCapturingLogger();
    const cause = new Error(
      'ENOENT: no such file or directory, open ' +
        "'/home/player/Documents/2048/save.json'",
    );
    const thrown = new Error(
      'The module at https://example.test/assets/index-a1b2c3.js failed',
      { cause },
    );

    logger.error('a load failed', undefined, thrown);

    const error = records[0].error;

    // THE MESSAGE IS THE PART A CONSOLE LINE SHOWS FIRST, and it carried the
    // very locations the stack beside it had redacted.
    expect(error?.message).not.toContain('example.test');
    expect(error?.message).toContain(logRecordBounds.redactedLocation);
    expect(error?.cause?.message).not.toContain('/home/player');
    expect(error?.cause?.message).toContain(logRecordBounds.redactedLocation);

    // The wording either side of the location is kept: a redacted message must
    // still say what went wrong.
    expect(error?.cause?.message).toContain('ENOENT');
  });

  it('redacts a payload fragment a parse failure quoted', () => {
    const { logger, records } = createCapturingLogger();

    // What `JSON.parse` reports for a truncated payload: a fragment of the text
    // it was given, which for this product's own keys carries the run seed the
    // player typed.
    logger.error(
      'the stored run could not be read',
      undefined,
      new SyntaxError(
        'Unexpected end of JSON input at ' +
          '"{\\"seed\\":\\"my-private-seed-text-here\\",\\"stageIndex\\":0}"',
      ),
    );

    expect(records[0].error?.message).not.toContain('my-private-seed-text');
    expect(records[0].error?.message).toContain('Unexpected end of JSON input');
  });

  // A `data:` URI carries its payload INLINE, which is the whole reason it is
  // one of the enumerated forms: the value is in the message rather than behind
  // a locator. The forms below are the ones a caught value actually carries —
  // a decode failure, a refused document, a load failure mid-sentence — and the
  // media type with its `type/subtype` slash is what every one of them has.
  // `DL-LOG-10` and `docs/OBSERVABILITY.md` both state that this form is
  // redacted, and these cases are what holds the two documents to it.
  // DL-LOG-11.
  describe('a data: URI in a message', () => {
    /**
     * The message of the one record emitted for a thrown `Error`.
     *
     * @param message Message to throw.
     * @returns The message the record carries.
     */
    const messageFor = (message: string): string => {
      const { logger, records } = createCapturingLogger();

      logger.error('a caught value carried a data URI', undefined, new Error(
        message,
      ));

      expect(records).toHaveLength(1);

      return records[0].error?.message ?? '';
    };

    /** Every conventional form, with the payload each must not keep. */
    const CONVENTIONAL: ReadonlyArray<readonly [string, string, string]> = [
      [
        'a base64 image',
        'failed to decode data:image/png;base64,iVBORw0KGgoAAAA',
        'iVBORw0KGgoAAAA',
      ],
      [
        'an inline document',
        'refused data:text/html,<script>alert(1)</script>',
        'alert(1)',
      ],
      ['plain text', 'read data:text/plain,my-private-seed', 'my-private-seed'],
      [
        'a parameterised media type',
        'parsed data:application/json;charset=utf-8,{seed:abc}',
        '{seed:abc}',
      ],
      [
        'a percent-escaped media type',
        'loaded data:text/vnd%2Dabc;base64,QUJDRA',
        'QUJDRA',
      ],
    ];

    for (const [name, thrown, payload] of CONVENTIONAL) {
      it(`redacts ${name}`, () => {
        const message = messageFor(thrown);

        expect(message).not.toContain(payload);
        expect(message).not.toContain('data:');
        expect(message).toContain(logRecordBounds.redactedLocation);
      });
    }

    it('keeps the wording either side of one it replaces', () => {
      const message = messageFor(
        'failed to load data:image/svg+xml;base64,QUJD then stopped',
      );

      // A redacted message must still say what went wrong, so the URI is
      // replaced in place rather than the message being discarded.
      expect(message).toContain('failed to load');
      expect(message).toContain('then stopped');
      expect(message).not.toContain('QUJD');
    });

    it('redacts the three typeless forms as well', () => {
      for (const thrown of [
        'saw data:,plain-payload',
        'saw data:base64,QUJDRQ',
        'saw data:;base64,QUJDRg',
      ]) {
        const message = messageFor(thrown);

        expect(message).not.toContain('data:');
        expect(message).toContain(logRecordBounds.redactedLocation);
      }
    });

    it('leaves a word merely ENDING in `data:` alone', () => {
      // The pattern opens on a word boundary, so a scheme this is not must not
      // be replaced: over-redaction destroys the diagnostic the record exists
      // for just as surely as under-redaction leaks a payload.
      const message = messageFor('metadata:image/png;base64,AAA was read');

      expect(message).toContain('metadata:image/png;base64,AAA');
      expect(message).not.toContain(logRecordBounds.redactedLocation);
    });

    it('completes on an input built to make the pattern backtrack', () => {
      // Redaction runs on the message BEFORE the record is clamped, so the
      // pattern sees text of arbitrary length. This input is a run of
      // parameter separators with no terminating comma, which is the shape that
      // makes an ambiguous parameter group backtrack: the case passes by
      // COMPLETING inside the suite's own timeout rather than by a measured
      // duration, which is what keeps it a fact about the pattern rather than
      // about the machine. DL-LOG-11.
      const hostile = `data:${';a'.repeat(160)}`;

      const message = messageFor(`load failed for ${hostile}`);

      // No comma, so nothing matched: the message is carried as it was thrown.
      expect(message).toContain('load failed for');
      expect(message).not.toContain(logRecordBounds.redactedLocation);
    });

    it('removes it from the STACK as well, where the header repeats it', () => {
      const { logger, records } = createCapturingLogger();

      // A thrown value's `stack` opens with its own `<name>: <message>` header,
      // so the payload is present twice in one record. Redacting the message
      // alone left the second copy in the ring buffer and in the diagnostics
      // export — the surface built to be downloaded and shared.
      logger.error(
        'a decode failed',
        undefined,
        new Error('failed on data:image/png;base64,UEFZTE9BRA'),
      );

      expect(records[0].error?.message).not.toContain('UEFZTE9BRA');
      expect(records[0].error?.stack).not.toContain('UEFZTE9BRA');
      expect(logger.toJsonLines()).not.toContain('UEFZTE9BRA');
      expect(logger.snapshot().records[0].error?.stack).not.toContain(
        'UEFZTE9BRA',
      );

      // The frame names the stack is read for are still there.
      expect(records[0].error?.stack).toContain(
        logRecordBounds.redactedLocation,
      );
    });

    it('redacts one carried by a cause, and on the export surfaces', () => {
      const { logger } = createCapturingLogger();

      logger.error(
        'a load failed',
        undefined,
        new Error('outer', {
          cause: new Error('inner data:image/png;base64,SEVMTE8'),
        }),
      );

      expect(logger.toJsonLines()).not.toContain('SEVMTE8');
      expect(
        logger.snapshot().records[0].error?.cause?.message,
      ).not.toContain('SEVMTE8');
    });
  });

  it('redacts a credential-like assignment, keeping its key', () => {
    const { logger, records } = createCapturingLogger();

    logger.error(
      'a request was refused',
      undefined,
      new Error('refused: token=abc123def456 session=zzz'),
    );

    const message = records[0].error?.message ?? '';

    expect(message).not.toContain('abc123def456');
    expect(message).not.toContain('zzz');

    // The keys survive, so the record still says WHICH value was withheld.
    expect(message).toContain('token=');
    expect(message).toContain('session=');
  });

  it('keeps the raw message for a private development sink and redacts the ' +
    'export anyway', () => {
    const records: LogRecord[] = [];
    const logger = createLogger({
      runSeed: SUITE_SEED,
      subsystem: SUITE_SUBSYSTEM,
      consoleOutput: false,
      errorDetail: 'full',
    });

    logger.subscribe((record: LogRecord): void => {
      records.push(record);
    });

    logger.error(
      'a load failed',
      undefined,
      new Error('failed to open /srv/app/dist/assets/index.js'),
    );

    // The one mode that opts back in, and it opts in for the sink alone.
    expect(records[0].error?.message).toContain('/srv/app/dist/assets');
    expect(logger.toJsonLines()).not.toContain('/srv/app/dist/assets');
    expect(
      logger.snapshot().records[0].error?.message,
    ).not.toContain('/srv/app/dist/assets');
  });

  it('bounds a record whose fields are wide, deep or huge', () => {
    const { logger, records } = createCapturingLogger();
    const wide: Record<string, number> = {};

    for (let index = 0; index < logRecordBounds.fieldBreadth * 4; index += 1) {
      wide[`k${index}`] = index;
    }

    let deep: unknown = 'bottom';

    for (let index = 0; index < logRecordBounds.fieldDepth * 3; index += 1) {
      deep = { nested: deep };
    }

    logger.info('bounded fields', {
      wide: wide as unknown as LogFieldValue,
      deep: deep as LogFieldValue,
      long: 'x'.repeat(logRecordBounds.fieldString * 4),
    });

    const fields = records[0].fields as Record<string, unknown>;
    const widened = fields.wide as Record<string, unknown>;
    const long = fields.long as string;

    expect(Object.keys(widened).length).toBeLessThanOrEqual(
      logRecordBounds.fieldBreadth + 1
    );
    expect(long.length).toBeLessThanOrEqual(logRecordBounds.fieldString + 1);
    expect(JSON.stringify(records[0].fields)).toContain(
      logRecordBounds.truncatedValue
    );
  });

  it('normalises fields deeply, sharing no object with the caller', () => {
    const { logger, records } = createCapturingLogger();
    const nested = { inner: { count: 1 } };

    logger.info('deep copy', { nested: nested as unknown as LogFieldValue });

    const carried = records[0].fields as unknown as {
      nested: { inner: { count: number } };
    };

    expect(carried.nested).toEqual(nested);
    expect(carried.nested).not.toBe(nested);
    expect(carried.nested.inner).not.toBe(nested.inner);

    nested.inner.count = 99;

    expect(carried.nested.inner.count).toBe(1);
  });

  it('drops a dangerous member name out of a field bag', () => {
    const { logger, records } = createCapturingLogger();
    const hostile = JSON.parse('{"__proto__":{"polluted":1},"safe":2}') as
      unknown as LogFields;

    logger.info('hostile fields', hostile);

    const fields = records[0].fields as Record<string, unknown>;

    // Every level of the carried tree has a null prototype, so no inherited
    // `toJSON`, `toString` or accessor of a caller's prototype chain reaches
    // serialisation and `__proto__` cannot reassign one through it.
    expect(Object.getPrototypeOf(fields)).toBeNull();
    expect(
      Object.prototype.hasOwnProperty.call(fields, '__proto__')
    ).toBe(false);
    expect((fields as { polluted?: unknown }).polluted).toBeUndefined();
    expect(fields.safe).toBe(2);
  });

  it('reduces a record whose JSON form would exceed the record bound', () => {
    const { logger, records } = createCapturingLogger();
    const values: string[] = [];

    for (let index = 0; index < logRecordBounds.fieldBreadth; index += 1) {
      values.push('v'.repeat(logRecordBounds.fieldString));
    }

    logger.info('oversized record', {
      bulk: values as unknown as LogFieldValue,
    });

    const text = JSON.stringify(records[0]);

    expect(text.length).toBeLessThanOrEqual(logRecordBounds.record);
    expect(text).toContain(logRecordBounds.truncatedValue);
  });

  it('describes rather than walks a value JSON cannot render', () => {
    const { logger, records } = createCapturingLogger();

    logger.info('non-json fields', {
      when: new Date(0) as unknown as LogFieldValue,
      count: Number.NaN,
      big: 7n as unknown as LogFieldValue,
      fn: ((): void => undefined) as unknown as LogFieldValue,
    });

    const fields = records[0].fields as Record<string, unknown>;

    expect(typeof fields.when).toBe('string');
    expect(typeof fields.count).toBe('string');
    expect(typeof fields.big).toBe('string');
    expect(typeof fields.fn).toBe('string');
    expect(() => JSON.stringify(records[0])).not.toThrow();
  });
});

describe('createEngineReporter', () => {
  it('satisfies the EngineReporter contract src/engine declares, every ' +
    'member of it', () => {
    const { logger } = createCapturingLogger();
    const reporter: EngineReporter = createEngineReporter(logger);

    const contract: readonly (keyof EngineReporter)[] = [
      'onHookError',
      'onListenerError',
      'onCount',
    ];

    for (const member of contract) {
      expect(typeof reporter[member]).toBe('function');
    }

    expect(Object.keys(reporter).sort()).toEqual([...contract].sort());
  });

  it('records a contained event-listener throw at error', () => {
    const { logger, records } = createCapturingLogger();
    const reporter: EngineReporter = createEngineReporter(logger);
    const report: EngineListenerErrorReport = {
      correlationId: SUITE_CORRELATION_ID,
      event: 'state:commit',
      listenerIndex: 2,
      error: new TypeError('the renderer subscriber threw'),
    };

    reporter.onListenerError?.(report);

    expect(records).toHaveLength(1);

    const record = records[0];

    expect(record.level).toBe('error');
    expect(record.subsystem).toBe('engine');
    expect(record.correlationId).toBe(SUITE_CORRELATION_ID);

    // The event name and the listener's position are the only identity an
    // event listener has, so both have to survive into the record.
    expect(record.fields).toEqual({
      reportedCorrelationId: report.correlationId,
      event: 'state:commit',
      listenerIndex: 2,
    });
    expect(record.error).toEqual(serializeError(report.error));
  });

  it('records a listener throw that is not an Error', () => {
    const { logger, records } = createCapturingLogger();
    const reporter: EngineReporter = createEngineReporter(logger);

    reporter.onListenerError?.({
      correlationId: SUITE_CORRELATION_ID,
      event: 'tile:merge',
      listenerIndex: 0,
      error: { code: 'not-an-error' },
    });

    expect(records).toHaveLength(1);
    expect(records[0].error).toEqual(serializeError({ code: 'not-an-error' }));
  });

  it('reaches the log from the real emitter, end to end', () => {
    const { logger, records } = createCapturingLogger();
    const reporter: EngineReporter = createEngineReporter(logger);
    const events = createEngineEvents({
      correlationId: SUITE_CORRELATION_ID,
      reporter,
    });

    events.on('stage:end', (): void => {
      throw new Error('a stage-end subscriber threw');
    });

    expect(() => {
      events.emit('stage:end', { stageIndex: 0, cleared: true, score: 0 });
    }).not.toThrow();

    const failures = records.filter((record) => record.level === 'error');

    expect(failures).toHaveLength(1);
    expect(failures[0].fields).toEqual({
      reportedCorrelationId: SUITE_CORRELATION_ID,
      event: 'stage:end',
      listenerIndex: 0,
    });
  });

  it('records a contained hook-handler throw at error', () => {
    const { logger, records } = createCapturingLogger();
    const reporter: EngineReporter = createEngineReporter(logger);
    const report: EngineHookErrorReport = {
      correlationId: deriveCorrelationId(SUITE_SEED),
      hook: 'onMerge',
      subscriberId: 'relic:merge-echo',
      error: 'the relic handler threw a string',
    };

    reporter.onHookError?.(report);

    expect(records).toHaveLength(1);

    const record = records[0];

    expect(record.level).toBe('error');
    expect(record.subsystem).toBe('engine');
    expect(record.correlationId).toBe(SUITE_CORRELATION_ID);
    expect(record.fields).toEqual({
      reportedCorrelationId: report.correlationId,
      hook: 'onMerge',
      subscriberId: 'relic:merge-echo',
    });
    expect(record.error).toEqual(serializeError(report.error));
  });

  it('records a contained event-listener throw at error, with the thrown ' +
    'value serialised', () => {
    const { logger, records } = createCapturingLogger();
    const reporter: EngineReporter = createEngineReporter(logger);
    const thrown = new TypeError('Cannot assign to read only property', {
      cause: new Error('the projection is frozen'),
    });
    const report: EngineListenerErrorReport = {
      correlationId: deriveCorrelationId(SUITE_SEED),
      event: 'move:before',
      listenerIndex: 2,
      error: thrown,
    };

    reporter.onListenerError?.(report);

    expect(records).toHaveLength(1);

    const record = records[0];

    expect(record.level).toBe('error');
    expect(record.subsystem).toBe('engine');
    expect(record.correlationId).toBe(SUITE_CORRELATION_ID);
    expect(record.fields).toEqual({
      reportedCorrelationId: report.correlationId,
      event: 'move:before',
      listenerIndex: 2,
    });

    expect(record.error).toEqual(serializeError(thrown));
    expect(record.error?.name).toBe('TypeError');
    expect(record.error?.cause?.message).toBe('the projection is frozen');
    expect(record.error?.stack).toBeDefined();
  });

  it('records a non-Error listener throwable whole', () => {
    const { logger, records } = createCapturingLogger();
    const reporter: EngineReporter = createEngineReporter(logger);

    for (const thrown of [
      'a thrown string',
      { code: 'not-an-error' },
      null,
      undefined,
    ]) {
      reporter.onListenerError?.({
        correlationId: deriveCorrelationId(SUITE_SEED),
        event: 'state:commit',
        listenerIndex: 0,
        error: thrown,
      });
    }

    expect(records).toHaveLength(4);
    expect(records[0].error).toEqual(serializeError('a thrown string'));
    expect(records[1].error).toEqual(serializeError({ code: 'not-an-error' }));
    expect(records[2].error).toEqual(serializeError(null));
    expect(records[3].error).toEqual(serializeError(undefined));
  });

  it('records an engine counter at debug', () => {
    const { logger, records } = createCapturingLogger();
    const reporter: EngineReporter = createEngineReporter(logger);
    const withHook: EngineCountReport = {
      correlationId: deriveCorrelationId(SUITE_SEED),
      metric: 'hook.dispatch',
      value: 1,
      hook: 'onAfterMove',
    };
    const withoutHook: EngineCountReport = {
      correlationId: deriveCorrelationId(SUITE_SEED),
      metric: 'move.committed',
      value: 2,
    };

    reporter.onCount?.(withHook);
    reporter.onCount?.(withoutHook);

    expect(records).toHaveLength(2);
    expect(records[0].level).toBe('debug');
    expect(records[0].subsystem).toBe('engine');
    expect(records[0].fields).toEqual({
      reportedCorrelationId: withHook.correlationId,
      metric: 'hook.dispatch',
      value: 1,
      hook: 'onAfterMove',
      event: null,
    });
    expect(records[1].fields).toEqual({
      reportedCorrelationId: withoutHook.correlationId,
      metric: 'move.committed',
      value: 2,
      hook: null,
      event: null,
    });
  });

  it('records the event dimension of an event count, leaving hook absent ' +
    '', () => {
    const { logger, records } = createCapturingLogger();
    const reporter: EngineReporter = createEngineReporter(logger);
    const report: EngineCountReport = {
      correlationId: deriveCorrelationId(SUITE_SEED),
      metric: 'engine.event.emit',
      value: 1,
      event: 'state:commit',
    };

    reporter.onCount?.(report);

    expect(records).toHaveLength(1);
    expect(records[0].fields).toEqual({
      reportedCorrelationId: report.correlationId,
      metric: 'engine.event.emit',
      value: 1,
      hook: null,
      event: 'state:commit',
    });
  });
});

describe('createInputReporter', () => {
  it('satisfies the InputReporter contract src/input declares', () => {
    const { logger } = createCapturingLogger();
    const reporter: InputReporter = createInputReporter(logger);

    expect(typeof reporter.log).toBe('function');
    expect(typeof reporter.count).toBe('function');
    expect(typeof reporter.failure).toBe('function');
    expect(typeof reporter.startSpan).toBe('function');
  });

  it('records a message at the level the input layer reports', () => {
    const { logger, records } = createCapturingLogger();
    const reporter: InputReporter = createInputReporter(logger);

    for (const level of LOG_LEVELS) {
      reporter.log(level, `reported at ${level}`, { modality: 'arrow' });
    }

    expect(records).toHaveLength(LOG_LEVELS.length);

    records.forEach((record: LogRecord, index: number): void => {
      expect(record.level).toBe(LOG_LEVELS[index]);
      expect(record.subsystem).toBe('input');
      expect(record.message).toBe(`reported at ${LOG_LEVELS[index]}`);
      expect(record.fields).toEqual({ modality: 'arrow' });
      expect(record.correlationId).toBe(deriveCorrelationId(SUITE_SEED));
    });
  });

  it('drops raw keystroke fields from a message and from a counter', () => {
    const { logger, records } = createCapturingLogger();
    const reporter: InputReporter = createInputReporter(logger);

    reporter.log('debug', 'a keydown resolved to nothing', {
      key: 'p',
      code: 'KeyP',
      text: 'a typed password',
      value: 'a typed password',
      context: 'textEntry',
    });
    reporter.count('input.key.unrecognised', {
      key: 'p',
      code: 'KeyP',
      context: 'textEntry',
    });

    expect(records[0].fields).toEqual({ context: 'textEntry' });
    expect(records[1].fields).toEqual({
      context: 'textEntry',
      metric: 'input.key.unrecognised',
      value: 1,
    });
  });

  it('carries a caught Error through the failure channel unconverted',
    () => {
      const { logger, records } = createCapturingLogger();
      const reporter: InputReporter = createInputReporter(logger);
      const thrown = new RangeError('the index is out of range', {
        cause: new Error('the slot list is empty'),
      });

      reporter.failure?.('error', 'An input listener threw.', thrown, {
        event: 'move',
        listener: 1,
      });

      expect(records).toHaveLength(1);
      expect(records[0].level).toBe('error');
      expect(records[0].subsystem).toBe('input');
      expect(records[0].fields).toEqual({ event: 'move', listener: 1 });
      expect(records[0].error).toEqual(serializeError(thrown));
      expect(records[0].error?.name).toBe('RangeError');
      expect(records[0].error?.cause?.message).toBe('the slot list is empty');
      expect(records[0].error?.stack).toBeDefined();
    });

  it('carries a caught non-Error through the failure channel whole',
    () => {
      const { logger, records } = createCapturingLogger();
      const reporter: InputReporter = createInputReporter(logger);

      for (const thrown of [
        'a thrown string',
        { code: 'not-an-error', detail: { nested: true } },
        [1, 2, 3],
        null,
        undefined,
      ]) {
        reporter.failure?.('warn', 'An input listener threw.', thrown);
      }

      expect(records).toHaveLength(5);
      expect(records[0].error).toEqual(serializeError('a thrown string'));
      expect(records[1].error).toEqual(
        serializeError({ code: 'not-an-error', detail: { nested: true } }),
      );
      expect(records[2].error).toEqual(serializeError([1, 2, 3]));
      expect(records[3].error).toEqual(serializeError(null));
      expect(records[4].error).toEqual(serializeError(undefined));
    });

  it('records a failure at the level the input layer reports', () => {
    const { logger, records } = createCapturingLogger();
    const reporter: InputReporter = createInputReporter(logger);

    for (const level of LOG_LEVELS) {
      reporter.failure?.(level, `failed at ${level}`, new Error('boom'));
    }

    expect(records).toHaveLength(LOG_LEVELS.length);
    records.forEach((record: LogRecord, index: number): void => {
      expect(record.level).toBe(LOG_LEVELS[index]);
      expect(record.error?.message).toBe('boom');
    });
  });

  it('drops raw keystroke fields from a failure as it does from a message ' +
    '', () => {
    const { logger, records } = createCapturingLogger();
    const reporter: InputReporter = createInputReporter(logger);

    reporter.failure?.('error', 'An input listener threw.', new Error('boom'), {
      key: 'p',
      code: 'KeyP',
      text: 'a typed password',
      value: 'a typed password',
      context: 'textEntry',
    });

    expect(records[0].fields).toEqual({ context: 'textEntry' });
  });

  it('bounds a string field so no free text survives a report', () => {
    const { logger, records } = createCapturingLogger();
    const reporter: InputReporter = createInputReporter(logger);

    reporter.count('input.selector.invalid', { selector: 'x'.repeat(200) });

    const selector = records[0].fields?.['selector'];

    expect(typeof selector).toBe('string');
    expect((selector as string).length).toBe(64);
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
      expect(record.correlationId).toBe(SUITE_CORRELATION_ID);
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

  it('records the writability probe outcome, without duplicating the ' +
    'failure channel', () => {
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
      thrown: PARSE_THROWN,
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

    // A probe that caught something also reaches `onFailure`, which records it
    // at warning level with the thrown value.
    expect(records[1].level).toBe('debug');
    expect(records[1].fields).toEqual({
      supported: false,
      strategy: 'memory',
      quota: false,
    });
  });

  it('keeps the warning for a probe that caught nothing, which reaches no ' +
    'failure channel', () => {
    const { logger, records } = createCapturingLogger();
    const reporter: StorageReporter = createStorageReporter(logger);

    reporter.onProbe?.({ supported: false, strategy: 'memory' });

    expect(records).toHaveLength(1);
    expect(records[0].level).toBe('warn');
    expect(records[0].error).toBeUndefined();
  });

  it('emits exactly one error-level record per failed probe across both ' +
    'channels', () => {
    const { logger, records } = createCapturingLogger();
    const reporter: StorageReporter = createStorageReporter(logger);
    const refused: StorageProbeResult = {
      supported: false,
      strategy: 'memory',
      error: PARSE_ERROR_INFO,
      thrown: PARSE_THROWN,
    };

    // Both channels, in the order LocalStorageManager delivers them.
    reporter.onProbe?.(refused);
    reporter.onFailure?.({
      operation: 'probe',
      key: GAME_STATE_KEY,
      strategy: 'memory',
      error: PARSE_ERROR_INFO,
      thrown: PARSE_THROWN,
    });

    const raised = records.filter(
      (record: LogRecord): boolean =>
        record.level === 'warn' || record.level === 'error',
    );

    expect(records).toHaveLength(2);
    expect(raised).toHaveLength(1);
    expect(raised[0].error?.name).toBe('SyntaxError');
  });

  it('serialises a quota rejection instead of discarding it', () => {
    const { logger, records } = createCapturingLogger();
    const reporter: StorageReporter = createStorageReporter(logger);

    reporter.onFailure?.(QUOTA_FAILURE);

    expect(records).toHaveLength(1);

    const record = records[0];

    expect(record.level).toBe('error');
    expect(record.subsystem).toBe('storage');
    expect(record.correlationId).toBe(SUITE_CORRELATION_ID);
    expect(record.fields).toEqual({
      operation: 'write',
      key: RUN_STATE_KEY,
      strategy: 'localStorage',
      quota: true,
      publicMessage: QUOTA_ERROR_INFO.message,
      errorName: QUOTA_ERROR_INFO.name,
    });

    expect(record.error).toBeDefined();
    expect(record.error?.name).toBe('QuotaExceededError');
    expect(record.error).toEqual(serializeError(QUOTA_THROWN));
    expect(record.error).not.toEqual(serializeError(QUOTA_ERROR_INFO));
    expect(record.error?.stack).toBeDefined();
  });

  it('carries the original throwable\'s cause chain through to the record ' +
    '', () => {
    const { logger, records } = createCapturingLogger();
    const reporter: StorageReporter = createStorageReporter(logger);

    reporter.onFailure?.(PARSE_FAILURE);

    expect(records[0].error?.name).toBe('SyntaxError');
    expect(records[0].error?.cause).toBeDefined();
    expect(records[0].error?.cause?.message).toBe(
      'the stored value was truncated',
    );
    expect(records[0].error).toEqual(serializeError(PARSE_THROWN));
  });

  it('carries a non-Error throwable\'s structure through to the record ' +
    '', () => {
    const { logger, records } = createCapturingLogger();
    const reporter: StorageReporter = createStorageReporter(logger);
    const thrown = { code: 'not-an-error' };

    reporter.onFailure?.({
      operation: 'write',
      key: RUN_STATE_KEY,
      strategy: 'memory',
      error: PARSE_ERROR_INFO,
      thrown,
    });

    expect(records[0].error).toEqual(serializeError(thrown));
  });

  it('falls back to the bounded description for a failure nothing was ' +
    'thrown for', () => {
    const { logger, records } = createCapturingLogger();
    const reporter: StorageReporter = createStorageReporter(logger);

    reporter.onFailure?.(REFUSED_KEY_FAILURE);

    expect(records).toHaveLength(1);
    expect(records[0].level).toBe('warn');
    expect(records[0].error).toEqual(
      serializeError(REFUSED_KEY_FAILURE.error),
    );
    expect(records[0].fields?.['key']).toBe('theme');
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
      publicMessage: PARSE_ERROR_INFO.message,
      errorName: PARSE_ERROR_INFO.name,
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
    expect(records[1].level).toBe('debug');
    expect(records[1].fields).toEqual({
      key: RUN_STATE_KEY,
      byteLength: 0,
      ok: false,
    });
    expect(records[0].message).not.toBe(records[1].message);
  });

  it('emits exactly one error-level record per failed write across both ' +
    'channels', () => {
    const { logger, records } = createCapturingLogger();
    const reporter: StorageReporter = createStorageReporter(logger);

    // Both channels, in the order LocalStorageManager delivers them.
    reporter.onFailure?.(QUOTA_FAILURE);
    reporter.onWrite?.({ key: RUN_STATE_KEY, byteLength: 0, ok: false });

    const raised = records.filter(
      (record: LogRecord): boolean =>
        record.level === 'warn' || record.level === 'error',
    );

    expect(records).toHaveLength(2);
    expect(raised).toHaveLength(1);
    expect(raised[0].level).toBe('error');
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
        correlationId: deriveCorrelationId(SUITE_SEED),
        hook: 'onSpawn',
        subscriberId: 'relic:cursed-shrink',
        error: new Error('handler threw'),
      });
      NOOP_ENGINE_REPORTER.onListenerError?.({
        correlationId: deriveCorrelationId(SUITE_SEED),
        event: 'state:commit',
        listenerIndex: 0,
        error: new Error('listener threw'),
      });
      NOOP_ENGINE_REPORTER.onCount?.({
        correlationId: deriveCorrelationId(SUITE_SEED),
        metric: 'hook.dispatch',
        value: 1,
      });
    }).not.toThrow();

    expect(typeof NOOP_ENGINE_REPORTER.onListenerError).toBe('function');

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

describe('Logger under a hostile host', () => {
  /** Descriptors saved before a replacement, newest first. */
  const savedDescriptors: {
    target: object;
    property: string;
    descriptor: PropertyDescriptor | undefined;
  }[] = [];

  /**
   * Replaces one property of a host object for the current test.
   *
   * @param target Object holding the property.
   * @param property Property to replace.
   * @param descriptor Descriptor to install, always configurable.
   */
  function replaceMember(
    target: object,
    property: string,
    descriptor: PropertyDescriptor
  ): void {
    savedDescriptors.unshift({
      target,
      property,
      descriptor: Object.getOwnPropertyDescriptor(target, property),
    });

    Object.defineProperty(target, property, {
      configurable: true,
      ...descriptor,
    });
  }

  /**
   * Replaces one property with a value for the current test.
   *
   * @param target Object holding the property.
   * @param property Property to replace.
   * @param value Value to install.
   */
  function replaceValue(
    target: object,
    property: string,
    value: unknown
  ): void {
    replaceMember(target, property, { value, writable: true });
  }

  afterEach(() => {
    for (const saved of savedDescriptors) {
      if (saved.descriptor === undefined) {
        Reflect.deleteProperty(saved.target, saved.property);
        continue;
      }

      Object.defineProperty(saved.target, saved.property, saved.descriptor);
    }

    savedDescriptors.length = 0;
  });

  it('records a zero offset when the host exposes no performance', () => {
    replaceValue(globalThis, 'performance', undefined);

    const { logger, records } = createCapturingLogger();

    logger.info('no clock at all');

    expect(records).toHaveLength(1);
    expect(records[0].elapsedMs).toBe(0);
    expect(logger.snapshot().stored).toBe(1);
  });

  it('records a zero offset when performance carries no now()', () => {
    replaceValue(globalThis, 'performance', {});

    const { logger, records } = createCapturingLogger();

    logger.warn('no clock reader');

    expect(records).toHaveLength(1);
    expect(records[0].elapsedMs).toBe(0);
  });

  it('records a zero offset when reading the clock throws', () => {
    replaceValue(globalThis, 'performance', {
      now: (): number => {
        throw new Error('the clock is unavailable');
      },
    });

    const { logger, records } = createCapturingLogger();

    expect(() => logger.error('the clock threw')).not.toThrow();
    expect(records).toHaveLength(1);
    expect(records[0].elapsedMs).toBe(0);
  });

  it('records a zero offset when the clock answers with no number', () => {
    for (const reading of [Number.NaN, Number.POSITIVE_INFINITY]) {
      replaceValue(globalThis, 'performance', {
        now: (): number => reading,
      });

      const { logger, records } = createCapturingLogger();

      logger.info('the clock answered oddly');

      expect(records[0].elapsedMs).toBe(0);
    }
  });

  it('records a zero offset when now() is not a function at all', () => {
    replaceValue(globalThis, 'performance', { now: 'not callable' });

    const { logger, records } = createCapturingLogger();

    logger.info('the clock reader is not callable');

    expect(records[0].elapsedMs).toBe(0);
  });

  it('keeps every other member of the record while the clock is broken', () => {
    replaceValue(globalThis, 'performance', undefined);

    const { logger, records } = createCapturingLogger();

    logger.error('reported', { stage: 4 }, new TypeError('bad type'));

    const record = records[0];

    expect(record.level).toBe('error');
    expect(record.message).toBe('reported');
    expect(record.correlationId).toBe(deriveCorrelationId(SUITE_SEED));
    expect(record.subsystem).toBe(SUITE_SUBSYSTEM);
    expect(record.fields?.['stage']).toBe(4);
    expect(record.error?.name).toBe('TypeError');
    expect(Number.isNaN(Date.parse(record.timestamp))).toBe(false);
  });

  it('contains a console writer that throws, and still stores', () => {
    const writer = vi.spyOn(console, 'info').mockImplementation((): void => {
      throw new Error('the console is unavailable');
    });
    const records: LogRecord[] = [];
    const logger = createLogger({ runSeed: SUITE_SEED, level: 'debug' });

    logger.subscribe((record: LogRecord): void => {
      records.push(record);
    });

    expect(() => logger.info('written through a broken console')).not.toThrow();
    expect(writer).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(1);
    expect(logger.snapshot().stored).toBe(1);

    // The console is not a sink: a throw there is not counted as a sink fault.
    expect(logger.snapshot().sinkFaults).toBe(0);
  });

  it('contains a throwing console writer at every level', () => {
    const raise = (): void => {
      throw new Error('the console is unavailable');
    };
    const spies = [
      vi.spyOn(console, 'debug').mockImplementation(raise),
      vi.spyOn(console, 'info').mockImplementation(raise),
      vi.spyOn(console, 'warn').mockImplementation(raise),
      vi.spyOn(console, 'error').mockImplementation(raise),
      vi.spyOn(console, 'log').mockImplementation(raise),
    ];
    const logger = createLogger({ runSeed: SUITE_SEED, level: 'debug' });

    expect(() => {
      logger.debug('debug');
      logger.info('info');
      logger.warn('warn');
      logger.error('error');
    }).not.toThrow();

    expect(logger.snapshot().stored).toBe(4);
    expect(spies[0]).toHaveBeenCalledTimes(1);
    expect(spies[1]).toHaveBeenCalledTimes(1);
    expect(spies[2]).toHaveBeenCalledTimes(1);
    expect(spies[3]).toHaveBeenCalledTimes(1);
  });

  it('falls back to console.log when the level member is missing', () => {
    const fallback = vi
      .spyOn(console, 'log')
      .mockImplementation((): void => undefined);

    replaceValue(console, 'info', undefined);

    const logger = createLogger({ runSeed: SUITE_SEED, level: 'debug' });

    logger.info('written through the fallback');

    expect(fallback).toHaveBeenCalledTimes(1);

    const line: unknown = fallback.mock.calls[0]?.[0];
    const parsed: unknown = JSON.parse(typeof line === 'string' ? line : '');

    expect(parsed).toMatchObject({
      level: 'info',
      message: 'written through the fallback',
    });
  });

  it('stores the record when the host exposes no console at all', () => {
    replaceValue(globalThis, 'console', undefined);

    const logger = createLogger({ runSeed: SUITE_SEED, level: 'debug' });

    expect(() => logger.info('no console at all')).not.toThrow();
    expect(logger.snapshot().stored).toBe(1);
  });

  it('carries a field whose accessor throws as the placeholder', () => {
    const { logger, records } = createCapturingLogger();
    const fields = {
      stage: 3,
      get broken(): number {
        throw new Error('this accessor is broken');
      },
      cleared: true,
    } as unknown as LogFields;

    expect(() =>
      logger.info('a field could not be read', fields)
    ).not.toThrow();

    const captured = records[0].fields;

    expect(captured?.['stage']).toBe(3);
    expect(captured?.['broken']).toBe('[unreadable value]');
    expect(captured?.['cleared']).toBe(true);
  });

  it('carries every unreadable field as the placeholder', () => {
    const { logger, records } = createCapturingLogger();
    const fields = {
      get first(): number {
        throw new Error('broken');
      },
      get second(): number {
        throw new Error('broken');
      },
    } as unknown as LogFields;

    logger.warn('two fields could not be read', fields);

    // `toStrictEqual` compares prototypes, and a carried field bag has a null
    // prototype by design, so the expectation is built on one too.
    expect(records[0].fields).toStrictEqual(
      Object.assign(Object.create(null), {
        first: '[unreadable value]',
        second: '[unreadable value]',
      })
    );
  });

  it('serialises a record whose unreadable field is a placeholder', () => {
    const { logger } = createCapturingLogger();
    const fields = {
      get broken(): number {
        throw new Error('broken');
      },
    } as unknown as LogFields;

    logger.info('serialised', fields);

    const parsed: unknown = JSON.parse(logger.toJsonLines().trim());

    expect(parsed).toMatchObject({
      message: 'serialised',
      fields: { broken: '[unreadable value]' },
    });
  });

  it('still reaches its sinks while every host member is broken', () => {
    replaceValue(globalThis, 'performance', undefined);
    vi.spyOn(console, 'info').mockImplementation((): void => {
      throw new Error('the console is unavailable');
    });

    const { logger, records } = createCapturingLogger({
      consoleOutput: true,
    });
    const fields = {
      get broken(): number {
        throw new Error('broken');
      },
    } as unknown as LogFields;

    expect(() =>
      logger.info('every host member is broken', fields)
    ).not.toThrow();
    expect(records).toHaveLength(1);
    expect(records[0].elapsedMs).toBe(0);
    expect(records[0].fields?.['broken']).toBe('[unreadable value]');
    expect(logger.snapshot().stored).toBe(1);
    expect(logger.snapshot().sinkFaults).toBe(0);
  });
});

describe('suite isolation', () => {
  it('leaves the clock this suite spied on at the platform built-in', () => {
    expect(Date.now.toString()).toContain('native code');
  });

  // Self-contained: this case installs the spies whose restoration it asserts.
  it('restores a global this case spied on itself', () => {
    const randomSpy = vi
      .spyOn(Math, 'random')
      .mockImplementation((): number => 0.5);
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation((): number => 0);

    expect(Math.random).toBe(randomSpy);
    expect(Date.now).toBe(nowSpy);
    expect(Math.random()).toBe(0.5);
    expect(Date.now()).toBe(0);

    vi.restoreAllMocks();

    expect(vi.isMockFunction(Math.random)).toBe(false);
    expect(vi.isMockFunction(Date.now)).toBe(false);
    expect(Math.random).toBe(PRISTINE_MATH_RANDOM);
    expect(Date.now).toBe(PRISTINE_DATE_NOW);
  });

  it('leaves the spied globals at their original references', () => {
    expect(Math.random).toBe(PRISTINE_MATH_RANDOM);
    expect(Date.now).toBe(PRISTINE_DATE_NOW);
  });
});

describe('the canonical correlation identifier', () => {
  it('is the value every adapter carries', () => {
    expect(createCapturingLogger().logger.correlationId).toBe(
      SUITE_CORRELATION_ID
    );
    expect(deriveCorrelationId(SUITE_SEED)).toBe(SUITE_CORRELATION_ID);
  });

  it('agrees with the run layer derivation, seed-only form', () => {
    expect(Object.keys(runStateModule)).toContain('runCorrelationId');

    for (const seed of ['', SUITE_SEED, 'another-seed', '\u{1F600}']) {
      expect(runCorrelationId(seed)).toBe(deriveCorrelationId(seed));
    }
  });

  it('agrees with the run layer derivation, run-instance form', () => {
    for (const [seed, runId] of [
      [SUITE_SEED, 'run-1'],
      ['', 'run-2'],
      ['seed-x', ''],
      ['with\u0000nul', 'run-3'],
    ] as readonly (readonly [string, string])[]) {
      expect(runCorrelationId(seed, runId)).toBe(
        deriveCorrelationId(seed, runId)
      );
    }
  });

  it('reaches a log record, an engine report and a dispatch context', () => {
    const { logger, records } = createCapturingLogger();
    const reporter: EngineReporter = createEngineReporter(logger);
    const bus = createHookBus({
      correlationId: SUITE_CORRELATION_ID,
      reporter,
    });
    const seen: HookContext[] = [];

    bus.register({
      id: 'identity-probe',
      hooks: {
        onStageEnd: (payload: StageEndPayload, context): StageEndPayload => {
          seen.push(context);

          return payload;
        },
      },
    });

    bus.dispatch(
      'onStageEnd',
      { stageIndex: 0, cleared: true, score: 0 },
      {
        config: createDefaultRulesConfig(),
        rng: createRngStreams(SUITE_SEED),
        grid: new Grid(DEFAULT_BOARD_SIZE),
      }
    );

    logger.info('a record of the same run');

    expect(seen).toHaveLength(1);
    expect(seen[0].correlationId).toBe(SUITE_CORRELATION_ID);
    expect(bus.metrics().correlationId).toBe(SUITE_CORRELATION_ID);

    const identifiers = new Set(
      records.map((record: LogRecord): string => record.correlationId)
    );

    expect(records.length).toBeGreaterThan(0);
    expect(identifiers).toEqual(new Set([SUITE_CORRELATION_ID]));

    const counters = records.filter(
      (record: LogRecord): boolean => record.subsystem === 'engine'
    );

    expect(counters.length).toBeGreaterThan(0);

    for (const record of counters) {
      // The engine reporter names the injected identifier
      // `reportedCorrelationId` in the fields bag, beside the record's own
      // `correlationId`, so a mismatch between the two is visible.
      expect(record.fields?.reportedCorrelationId).toBe(SUITE_CORRELATION_ID);
      expect(record.correlationId).toBe(SUITE_CORRELATION_ID);
    }
  });

  it('follows the run seed, so a replay of one seed correlates', () => {
    const first = createCapturingLogger({ runSeed: 'replayed-seed' });
    const second = createCapturingLogger({ runSeed: 'replayed-seed' });
    const other = createCapturingLogger({ runSeed: 'a-different-seed' });

    first.logger.info('first replay');
    second.logger.info('second replay');
    other.logger.info('another run');

    expect(first.records[0].correlationId).toBe(
      second.records[0].correlationId
    );
    expect(first.records[0].correlationId).toBe(
      deriveCorrelationId('replayed-seed')
    );
    expect(other.records[0].correlationId).not.toBe(
      first.records[0].correlationId
    );
  });
});

describe('a filtered level costs nothing to report at', () => {
  it('records no counter once the level rises above debug', () => {
    const { logger, records } = createCapturingLogger({ level: 'info' });
    const reporter: InputReporter = createInputReporter(logger);

    reporter.count('input.gesture', { source: 'keyboard' });

    expect(records).toHaveLength(0);
  });

  it('does not clone the caller fields for a filtered counter', () => {
    const { logger } = createCapturingLogger({ level: 'info' });
    const reporter: InputReporter = createInputReporter(logger);

    // Records alone cannot prove this: the logger filters at the sink too, so
    // the count is absent either way.
    let enumerated = 0;

    const watched = new Proxy(
      { source: 'keyboard' },
      {
        ownKeys(target: Record<string, string>): ArrayLike<string | symbol> {
          enumerated += 1;

          return Reflect.ownKeys(target);
        },
      }
    );

    reporter.count('input.gesture', watched);

    expect(enumerated).toBe(0);

    // Lowering the level makes the same call clone, which is what shows the
    // count above is the filter working and not the Proxy failing to observe.
    logger.setLevel('debug');
    reporter.count('input.gesture', watched);

    expect(enumerated).toBe(1);
  });

  it('hands back one shared span while debug is filtered out', () => {
    const { logger, records } = createCapturingLogger({ level: 'info' });
    const reporter: InputReporter = createInputReporter(logger);

    const first = reporter.startSpan?.('input.dispatch');
    const second = reporter.startSpan?.('input.parse');

    // Identity is the observable proof that no per-span object is allocated: a
    // fresh object per call could not be the same reference.
    expect(first).toBeDefined();
    expect(first).toBe(second);

    first?.end();
    second?.end();

    expect(records).toHaveLength(0);
  });

  it('allocates a distinct span once debug is emitted', () => {
    const { logger, records } = createCapturingLogger({ level: 'debug' });
    const reporter: InputReporter = createInputReporter(logger);

    const first = reporter.startSpan?.('input.dispatch');
    const second = reporter.startSpan?.('input.parse');

    expect(first).not.toBe(second);

    first?.end();
    second?.end();

    expect(records).toHaveLength(2);
    expect(records[0].fields?.['span']).toBe('input.dispatch');
    expect(records[1].fields?.['span']).toBe('input.parse');
  });

  it('starts recording again when the level is lowered', () => {
    const { logger, records } = createCapturingLogger({ level: 'info' });
    const reporter: InputReporter = createInputReporter(logger);

    reporter.count('input.gesture');
    expect(records).toHaveLength(0);

    // The filter is read per call, not captured at construction, so a level
    // changed at runtime takes effect.
    logger.setLevel('debug');
    reporter.count('input.gesture');

    expect(records).toHaveLength(1);
    expect(records[0].fields).toEqual({
      metric: 'input.gesture',
      value: 1,
    });

    const span = reporter.startSpan?.('input.dispatch');

    span?.end();

    expect(records).toHaveLength(2);
    expect(records[1].fields?.['span']).toBe('input.dispatch');
  });

  it('stops recording when the level is raised', () => {
    const { logger, records } = createCapturingLogger({ level: 'debug' });
    const reporter: InputReporter = createInputReporter(logger);

    reporter.count('input.gesture');
    expect(records).toHaveLength(1);

    logger.setLevel('warn');
    reporter.count('input.gesture');
    reporter.startSpan?.('input.dispatch').end();

    expect(records).toHaveLength(1);
  });

  it('reads one finite elapsed time per record, however many', () => {
    const { logger, records } = createCapturingLogger();

    for (let index = 0; index < 12; index += 1) {
      logger.debug('emitted');
    }

    expect(records).toHaveLength(12);

    for (const record of records) {
      expect(typeof record.elapsedMs).toBe('number');
      expect(Number.isFinite(record.elapsedMs)).toBe(true);
      expect(record.elapsedMs).toBeGreaterThanOrEqual(0);
    }

    // Monotonic across the run.
    for (let index = 1; index < records.length; index += 1) {
      expect(records[index].elapsedMs).toBeGreaterThanOrEqual(
        records[index - 1].elapsedMs
      );
    }
  });

  it('still times a span that is emitted', () => {
    const { logger, records } = createCapturingLogger();
    const reporter: InputReporter = createInputReporter(logger);
    const span = reporter.startSpan?.('input.dispatch');

    span?.end();

    const duration = records[0].fields?.['durationMs'];

    expect(typeof duration).toBe('number');

    if (typeof duration === 'number') {
      expect(Number.isFinite(duration)).toBe(true);
      expect(duration).toBeGreaterThanOrEqual(0);
    }
  });

  it('is idempotent on the shared span', () => {
    const { logger, records } = createCapturingLogger({ level: 'info' });
    const reporter: InputReporter = createInputReporter(logger);
    const span = reporter.startSpan?.('input.dispatch');

    // The shared instance is closed by many callers; that must stay harmless.
    span?.end();
    span?.end();
    span?.end();

    expect(records).toHaveLength(0);
  });
});

// The two sections above measure the adapter with hand-built reports.

/** A store whose `setItem` always reports an exhausted quota. */
class FullStore implements StorageLike {
  private readonly held = new Map<string, string>();

  getItem(key: string): string | null {
    return this.held.get(key) ?? null;
  }

  setItem(): void {
    throw new DOMException(
      'The quota has been exceeded.',
      'QuotaExceededError',
    );
  }

  removeItem(key: string): void {
    this.held.delete(key);
  }

  clear(): void {
    this.held.clear();
  }
}

describe('LocalStorageManager through createStorageReporter', () => {
  it('emits exactly one error-level record for one failed write', () => {
    const { logger, records } = createCapturingLogger();
    const manager = new LocalStorageManager({
      storage: new FullStore(),
      reporter: createStorageReporter(logger),
    });

    expect(manager.setBestScore(2048)).toBe(false);

    const raised = records.filter(
      (record: LogRecord): boolean =>
        record.level === 'warn' || record.level === 'error',
    );

    // Three records — the construction-time probe, the failure and the write
    // outcome — but ONE of them raised, which is the deduplication.
    expect(records).toHaveLength(3);
    expect(raised).toHaveLength(1);
    expect(raised[0].level).toBe('error');
    expect(raised[0].fields?.['operation']).toBe('write');
    expect(raised[0].fields?.['key']).toBe(BEST_SCORE_KEY);

    // And the raised record carries the original throwable, not a summary.
    expect(raised[0].error?.name).toBe('QuotaExceededError');
    expect(raised[0].error?.stack).toBeDefined();

    // No reporter callback threw, so no report was lost.
    expect(manager.reporterFaults).toBe(0);
  });

  it('emits exactly one error-level record for one refused key', () => {
    const { logger, records } = createCapturingLogger();
    const manager = new LocalStorageManager({
      storage: new MemoryStorage(),
      reporter: createStorageReporter(logger),
    });

    expect(manager.readRaw('theme' as never)).toBeNull();

    const raised = records.filter(
      (record: LogRecord): boolean =>
        record.level === 'warn' || record.level === 'error',
    );

    expect(raised).toHaveLength(1);
    expect(raised[0].fields?.['errorName']).toBe('StorageKeyError');

    // The refused key is a field of its own and is not in the message a record
    // leads with, nor in the scrubbed public description.
    expect(raised[0].fields?.['key']).toBe('theme');
    expect(raised[0].message).not.toContain('theme');
    expect(String(raised[0].fields?.['publicMessage'])).not.toContain('theme');
  });

  it('emits no raised record at all for a write that completed', () => {
    const { logger, records } = createCapturingLogger();
    const manager = new LocalStorageManager({
      storage: new MemoryStorage(),
      reporter: createStorageReporter(logger),
    });

    expect(manager.setBestScore(2048)).toBe(true);

    const raised = records.filter(
      (record: LogRecord): boolean =>
        record.level === 'warn' || record.level === 'error',
    );

    expect(raised).toHaveLength(0);
  });
});
