// Unit suite over src/observability/health.ts: the six capability checks, the
// three-state check status, the report roll-up and the two readiness verdicts.
//
// The storage strategy is fixed once, at construction:
// js/local_storage_manager.js L26, `this.storage = supported ?
// window.localStorage: window.fakeStorage`.
//
// Subject: src/observability/health.ts.
// src/observability/diagnostics-overlay.ts is not exercised here.
//
// Decisions: DL-HEALTH-06, DL-HEALTH-07 (docs/DECISION_LOG.md).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HEALTH_CHECK_COUNT,
  HEALTH_CHECK_IDS,
  HEALTH_CHECK_SOURCES,
  HEALTH_GAUGE_VALUES,
  HealthSurface,
  createHealthSurface,
  isHealthCheckId,
} from '../../../src/observability/health';
import type {
  HealthCheckId,
  HealthCheckResult,
  HealthReport,
  HealthStatus,
  PointerFamilyView,
  ReadinessReport,
  StorageProbeView,
  StorageStateView,
  WebGLProbeView,
} from '../../../src/observability/health';
import {
  createDiagnosticsOverlay,
} from '../../../src/observability/diagnostics-overlay';
import type {
  DiagnosticsOverlay,
  HealthCheckResult as HealthCheckResultView,
  HealthSource,
} from '../../../src/observability/diagnostics-overlay';
import { createLogger } from '../../../src/observability/logger';
import type { Logger, LogRecord } from '../../../src/observability/logger';
import {
  METRIC_LABELS,
  METRIC_NAMES,
  createMetricsRegistry,
} from '../../../src/observability/metrics';
import type { MetricsRegistry } from '../../../src/observability/metrics';
import * as storageModule from '../../../src/storage/local-storage-manager';
import {
  LocalStorageManager,
} from '../../../src/storage/local-storage-manager';
import { MemoryStorage } from '../../../src/storage/memory-storage';
import type { StorageLike } from '../../../src/storage/memory-storage';
import {
  BEST_SCORE_KEY,
  GAME_STATE_KEY,
  OWNED_STORAGE_KEYS,
  STORAGE_PROBE_KEY,
} from '../../../src/storage/storage-keys';
import * as touchInputModule from '../../../src/input/touch-input';
import * as webglModule from '../../../src/render/webgl-support';
import { resetWebGLSupportProbe } from '../../../src/render/webgl-support';

// Status and identity constants, named through the imported unions

// Typed through the imported union: a renamed member is a compile error here.
const PASS: HealthStatus = 'pass';
const FAIL: HealthStatus = 'fail';
const NOT_APPLICABLE: HealthStatus = 'not-applicable';

const FUNCTION_BIND: HealthCheckId = 'functionBind';
const CLASS_LIST: HealthCheckId = 'classList';
const REQUEST_ANIMATION_FRAME: HealthCheckId = 'requestAnimationFrame';
const POINTER_EVENTS: HealthCheckId = 'pointerEvents';
const STORAGE: HealthCheckId = 'storage';
const WEBGL: HealthCheckId = 'webgl';

/** Correlation identifier the injected logger carries in every test. */
const CORRELATION_ID = 'health-suite-correlation';

/** Message src/observability/health.ts records every check under. */
const CHECK_RECORD_MESSAGE = 'capability probe reported';

// Local doubles, built without a mocking library

/**
 * A WebGL probe reporting no context, so a surface built with it creates no
 * probe canvas. jsdom implements no `getContext`, and every real probe there
 * writes one virtual-console line.
 */
const NO_CONTEXT_PROBE = (): WebGLProbeView => ({
  supported: false,
  level: 'none',
  failure: 'no-context',
  reason: 'The probe was answered by a double.',
});

/**
 * A `StorageLike` whose `setItem` throws the quota rejection a full store
 * raises.
 *
 * @returns The store. Every other member is a no-op.
 */
function createQuotaExhaustedStorage(): StorageLike {
  return {
    getItem: (): string | null => null,

    setItem: (): void => {
      const error = new Error('The quota has been exceeded.');

      error.name = 'QuotaExceededError';

      throw error;
    },

    removeItem: (): void => undefined,
    clear: (): void => undefined,
  };
}

/**
 * A `Logger` whose every emitting member throws, and whose `child` returns
 * itself so the surface's own child is faulty too.
 *
 * @returns The logger. The non-emitting members delegate to a real logger,
 *   so the correlation identifier and the level behave normally.
 */
function createThrowingLogger(): Logger {
  const base = createLogger({
    correlationId: CORRELATION_ID,
    consoleOutput: false,
  });

  const refuse = (): never => {
    throw new Error('The logger threw.');
  };

  const faulty: Logger = {
    correlationId: base.correlationId,
    subsystem: base.subsystem,
    debug: refuse,
    info: refuse,
    warn: refuse,
    error: refuse,
    failure: refuse,
    child: (): Logger => faulty,

    // Delegated with the rest of the non-emitting members: this double refuses
    // to EMIT, and behaves normally everywhere else.
    setCorrelationId: (correlationId): void => {
      base.setCorrelationId(correlationId);
    },

    setLevel: (level): void => {
      base.setLevel(level);
    },

    getLevel: () => base.getLevel(),
    subscribe: (sink) => base.subscribe(sink),
    recent: (limit) => base.recent(limit),
    toJsonLines: (limit) => base.toJsonLines(limit),
    snapshot: (limit) => base.snapshot(limit),

    clear: (): void => {
      base.clear();
    },
  };

  return faulty;
}

/** A canvas whose `getContext` answers with a context, and its call log. */
interface ContextCanvas {
  readonly element: HTMLCanvasElement;
  readonly requests: readonly string[];
}

/**
 * Builds a canvas stand-in whose `getContext` answers at one level, so the
 * real probe in src/render/webgl-support.ts reaches its supported branch.
 *
 * @param level Context type answered; every other request yields `null`.
 * @returns The element and the `contextType` of every request made of it.
 */
function createContextCanvas(level: string): ContextCanvas {
  const requests: string[] = [];
  const context = {
    getExtension: (name: string): unknown =>
      name === 'WEBGL_lose_context'
        ? { loseContext: (): void => undefined }
        : null,
  };

  const element = {
    getContext: (contextType: string): unknown => {
      requests.push(contextType);

      return contextType === level ? context : null;
    },
  } as unknown as HTMLCanvasElement;

  return { element, requests };
}

/**
 * Reads the status gauge series the surface wrote, keyed by check id.
 *
 * @param metrics Registry to read.
 * @returns Gauge value per check id, for the health status family only.
 */
function readHealthGauges(
  metrics: MetricsRegistry,
): Map<string, number> {
  const values = new Map<string, number>();

  for (const series of metrics.snapshot().series) {
    if (series.name !== METRIC_NAMES.healthCheckStatus) {
      continue;
    }

    if (series.kind !== 'gauge') {
      continue;
    }

    const check: unknown = series.labels[METRIC_LABELS.check];

    if (typeof check === 'string') {
      values.set(check, series.value);
    }
  }

  return values;
}

/**
 * The per-check records one logger buffered, keyed by check id.
 *
 * @param logger Logger to read.
 * @returns Every record carrying `CHECK_RECORD_MESSAGE`, by `fields.check`.
 */
function readCheckRecords(logger: Logger): Map<string, LogRecord> {
  const records = new Map<string, LogRecord>();

  for (const record of logger.recent()) {
    if (record.message !== CHECK_RECORD_MESSAGE) {
      continue;
    }

    const check: unknown = record.fields?.check;

    if (typeof check === 'string') {
      records.set(check, record);
    }
  }

  return records;
}

/**
 * @param report Report to read.
 * @param id Check to find.
 * @returns The result.
 * @throws {Error} When the report carries no result for `id`, which is the
 *   six-check contract being broken rather than an assertion failing.
 */
function requireCheck(
  report: HealthReport,
  id: HealthCheckId,
): HealthCheckResult {
  const result = report.checks.find((candidate) => candidate.id === id);

  if (result === undefined) {
    throw new Error(`The report carries no "${id}" check.`);
  }

  return result;
}

/**
 * Reads one member off a result's structured data bag.
 *
 * @param result Result to read.
 * @param key Member to read.
 * @returns The value, or `undefined` when the bag carries no such member.
 */
function readData(result: HealthCheckResult, key: string): unknown {
  return result.data[key];
}

// Captured originals and per-test wiring

// Captured once, before any test runs, and compared for identity after
// probing: the vanilla probes were installers, the ported ones are readers.
const ORIGINAL_BIND = Function.prototype.bind;
const ORIGINAL_REQUEST_ANIMATION_FRAME = window.requestAnimationFrame;
const ORIGINAL_CANCEL_ANIMATION_FRAME = window.cancelAnimationFrame;
const ORIGINAL_ELEMENT = window.Element;
const ORIGINAL_MS_POINTER_ENABLED = (
  window.navigator as Navigator & { msPointerEnabled?: boolean }
).msPointerEnabled;

let logger: Logger;
let metrics: MetricsRegistry;
let surface: HealthSurface;

/** Removes every storage key the product owns, plus the probe key. */
function clearProductStorage(): void {
  const store: unknown = globalThis.localStorage;

  if (typeof store !== 'object' || store === null) {
    return;
  }

  const writable = store as StorageLike;

  for (const key of [...OWNED_STORAGE_KEYS, STORAGE_PROBE_KEY]) {
    try {
      writable.removeItem(key);
    } catch {
      // A store that refuses removal is a case under test; the sweep continues
      // to the remaining keys.
    }
  }
}

beforeEach(() => {
  clearProductStorage();
  resetWebGLSupportProbe();

  logger = createLogger({
    correlationId: CORRELATION_ID,
    consoleOutput: false,
  });
  metrics = createMetricsRegistry({ logger });
  surface = createHealthSurface({ logger, metrics });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  resetWebGLSupportProbe();
  clearProductStorage();
});

// All six checks are reported — validation gate V8 bullet 4

describe('the six-check contract', () => {
  it('declares six check ids, each one distinct', () => {
    expect(HEALTH_CHECK_IDS).toHaveLength(6);
    expect(HEALTH_CHECK_COUNT).toBe(HEALTH_CHECK_IDS.length);
    expect(new Set(HEALTH_CHECK_IDS).size).toBe(HEALTH_CHECK_IDS.length);
  });

  it('reports one result for every HealthCheckId, with no extras', () => {
    const report = surface.check();
    const reported = report.checks.map((result) => result.id);

    for (const id of HEALTH_CHECK_IDS) {
      expect(reported, `no result reported for "${id}"`).toContain(id);
    }

    expect(reported).toHaveLength(HEALTH_CHECK_COUNT);
    expect(new Set(reported).size).toBe(HEALTH_CHECK_COUNT);
    expect(reported).toStrictEqual([...HEALTH_CHECK_IDS]);
  });

  it('accounts every reported result to a declared check id', () => {
    const report = surface.check();

    for (const result of report.checks) {
      expect(isHealthCheckId(result.id)).toBe(true);
    }

    expect(isHealthCheckId('functionBindings')).toBe(false);
    expect(isHealthCheckId(undefined)).toBe(false);
  });

  it('counts the reported statuses to the number of results', () => {
    const report = surface.check();
    const counted =
      report.counts[PASS] + report.counts[FAIL] + report.counts[NOT_APPLICABLE];

    expect(counted).toBe(HEALTH_CHECK_COUNT);

    for (const status of [PASS, FAIL, NOT_APPLICABLE]) {
      const observed = report.checks.filter(
        (result) => result.status === status,
      ).length;

      expect(report.counts[status]).toBe(observed);
    }
  });

  it('carries a detail, a provenance reference and a duration', () => {
    const report = surface.check();

    for (const result of report.checks) {
      expect(
        result.detail.length,
        `${result.id} has no detail`,
      ).toBeGreaterThan(0);
      expect(result.source).toBe(HEALTH_CHECK_SOURCES[result.id]);
      expect(result.source.owner.length).toBeGreaterThan(0);
      expect(Number.isFinite(result.durationMs)).toBe(true);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('declares five reused probes and one added probe', () => {
    const reused = HEALTH_CHECK_IDS.filter(
      (id) => HEALTH_CHECK_SOURCES[id].disposition === 'reused',
    );
    const added = HEALTH_CHECK_IDS.filter(
      (id) => HEALTH_CHECK_SOURCES[id].disposition === 'added',
    );

    expect(reused).toStrictEqual([
      FUNCTION_BIND,
      CLASS_LIST,
      REQUEST_ANIMATION_FRAME,
      POINTER_EVENTS,
      STORAGE,
    ]);
    expect(added).toStrictEqual([WEBGL]);

    for (const id of reused) {
      expect(HEALTH_CHECK_SOURCES[id].origin).not.toBeNull();
    }

    expect(HEALTH_CHECK_SOURCES[WEBGL].origin).toBeNull();
  });

  it('cites the vanilla source line of every reused probe', () => {
    expect(HEALTH_CHECK_SOURCES[FUNCTION_BIND].origin).toBe(
      'js/bind_polyfill.js L1',
    );
    expect(HEALTH_CHECK_SOURCES[CLASS_LIST].origin).toBe(
      'js/classlist_polyfill.js L2-L5',
    );
    expect(HEALTH_CHECK_SOURCES[REQUEST_ANIMATION_FRAME].origin).toBe(
      'js/animframe_polyfill.js L3-L10 and L23',
    );
    expect(HEALTH_CHECK_SOURCES[POINTER_EVENTS].origin).toBe(
      'js/keyboard_input_manager.js L4-L13',
    );
    expect(HEALTH_CHECK_SOURCES[STORAGE].origin).toBe(
      'js/local_storage_manager.js L29-L40',
    );
  });

  it('returns a frozen report and frozen results', () => {
    const report = surface.check();

    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.checks)).toBe(true);

    for (const result of report.checks) {
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.data)).toBe(true);
    }
  });
});

// One block per HealthCheckId, in HEALTH_CHECK_IDS order

describe('functionBind', () => {
  // js/bind_polyfill.js L1
  it('reports pass where Function.prototype.bind is present', () => {
    const result = requireCheck(surface.check(), FUNCTION_BIND);

    expect(typeof Function.prototype.bind).toBe('function');
    expect(result.status).toBe(PASS);
    expect(readData(result, 'present')).toBe(true);
  });

  it('is probed inside health.ts, naming no other owner', () => {
    const result = surface.checkOne(FUNCTION_BIND);

    expect(result.source.owner).toBe('src/observability/health.ts');
    expect(result.source.performedBy).toBeNull();
  });
});

describe('classList', () => {
  // js/classlist_polyfill.js L2-L5
  it('reports pass where classList is present on the root element', () => {
    expect(typeof window.Element).not.toBe('undefined');
    expect('classList' in document.documentElement).toBe(true);

    const result = requireCheck(surface.check(), CLASS_LIST);

    expect(result.status).toBe(PASS);
    expect(readData(result, 'element')).toBe(true);
    expect(readData(result, 'classList')).toBe(true);
  });

  it('reports not-applicable, not fail, without window.Element', () => {
    vi.stubGlobal('Element', undefined);

    expect(typeof Element).toBe('undefined');

    const result = surface.checkOne(CLASS_LIST);

    expect(result.status).toBe(NOT_APPLICABLE);
    expect(readData(result, 'window')).toBe(true);
    expect(readData(result, 'element')).toBe(false);
  });

  it('is probed inside health.ts, naming no other owner', () => {
    const result = surface.checkOne(CLASS_LIST);

    expect(result.source.owner).toBe('src/observability/health.ts');
    expect(result.source.performedBy).toBeNull();
  });
});

describe('requestAnimationFrame', () => {
  // js/animframe_polyfill.js L3-L10 and L23
  it('reports pass with both halves of the pair present', () => {
    expect(typeof window.requestAnimationFrame).toBe('function');
    expect(typeof window.cancelAnimationFrame).toBe('function');

    const result = requireCheck(surface.check(), REQUEST_ANIMATION_FRAME);

    expect(result.status).toBe(PASS);
    expect(readData(result, 'requestAnimationFrame')).toBe(true);
    expect(readData(result, 'cancelAnimationFrame')).toBe(true);
  });

  it('reports fail where only the cancel half is missing', () => {
    vi.stubGlobal('cancelAnimationFrame', undefined);

    const result = surface.checkOne(REQUEST_ANIMATION_FRAME);

    expect(result.status).toBe(FAIL);
    expect(readData(result, 'requestAnimationFrame')).toBe(true);
    expect(readData(result, 'cancelAnimationFrame')).toBe(false);
  });

  it('is probed inside health.ts, naming no other owner', () => {
    const result = surface.checkOne(REQUEST_ANIMATION_FRAME);

    expect(result.source.owner).toBe('src/observability/health.ts');
    expect(result.source.performedBy).toBeNull();
  });
});

describe('pointerEvents', () => {
  // js/keyboard_input_manager.js L4-L13
  it('reports pass with the resolved family in structured data', () => {
    const result = requireCheck(surface.check(), POINTER_EVENTS);

    expect(result.status).toBe(PASS);
    expect(readData(result, 'resolved')).toBe(true);

    expect(readData(result, 'touchstart')).toBe('touchstart');
    expect(readData(result, 'touchmove')).toBe('touchmove');
    expect(readData(result, 'touchend')).toBe('touchend');
  });

  it('treats an absent msPointerEnabled as standard, not a fault', () => {
    expect(ORIGINAL_MS_POINTER_ENABLED).toBeUndefined();

    const result = requireCheck(surface.check(), POINTER_EVENTS);

    expect(result.status).toBe(PASS);
    expect(readData(result, 'msPointerEnabled')).toBe(false);
  });

  it('reports the MSPointer family the flag selects', () => {
    const withFlag = createHealthSurface({
      logger,
      metrics,
      pointerProbe: () =>
        touchInputModule.detectPointerEventFamily({ msPointerEnabled: true }),
    });
    const result = withFlag.checkOne(POINTER_EVENTS);

    expect(result.status).toBe(PASS);
    expect(readData(result, 'msPointerEnabled')).toBe(true);
    expect(readData(result, 'touchstart')).toBe('MSPointerDown');
    expect(readData(result, 'touchmove')).toBe('MSPointerMove');
    expect(readData(result, 'touchend')).toBe('MSPointerUp');
  });

  it('reports fail where the probe resolves no usable family', () => {
    const unusable = createHealthSurface({
      logger,
      metrics,
      pointerProbe: () => ({}) as unknown as PointerFamilyView,
    });
    const result = unusable.checkOne(POINTER_EVENTS);

    expect(result.status).toBe(FAIL);
    expect(readData(result, 'resolved')).toBe(false);
  });

  it('names src/input/touch-input.ts as the probe owner', () => {
    const result = surface.checkOne(POINTER_EVENTS);

    expect(result.source.owner).toBe('src/input/touch-input.ts');
    expect(result.source.performedBy).toBe('detectPointerEventFamily');
  });
});

describe('storage', () => {
  // js/local_storage_manager.js L29-L40
  it('reports pass where Web Storage is writable', () => {
    const result = requireCheck(surface.check(), STORAGE);

    expect(result.status).toBe(PASS);
    expect(readData(result, 'supported')).toBe(true);
    expect(readData(result, 'strategy')).toBe('localStorage');
  });

  it('reports fail where the store refuses a write', () => {
    vi.stubGlobal('localStorage', createQuotaExhaustedStorage());

    const failing = createHealthSurface({ logger, metrics });
    const result = failing.checkOne(STORAGE);

    expect(result.status).toBe(FAIL);
    expect(readData(result, 'supported')).toBe(false);
    expect(readData(result, 'errorName')).toBe('QuotaExceededError');
    expect(readData(result, 'quotaExceeded')).toBe(true);
  });

  it('reports not-applicable where the host offers no store at all', () => {
    vi.stubGlobal('localStorage', undefined);

    const absent = createHealthSurface({ logger, metrics });
    const result = absent.checkOne(STORAGE);

    expect(result.status).toBe(NOT_APPLICABLE);
    expect(readData(result, 'supported')).toBe(false);
    expect(readData(result, 'errorName')).toBeUndefined();
  });

  it('names src/storage/local-storage-manager.ts as the probe owner', () => {
    const result = surface.checkOne(STORAGE);

    expect(result.source.owner).toBe('src/storage/local-storage-manager.ts');
    expect(result.source.performedBy).toBe('probeWebStorage');
  });

  // The observability review's INFO finding on this check: the probe result is a
  // construction-time reading by design, so after a real quota exhaustion the
  // row still read `pass` / "Web Storage is writable." while the run had already
  // stopped being saved and the HUD said so. The live verdict is the second,
  // write-free source of truth. DL-HEALTH-08.
  describe('the live verdict', () => {
    it('fails the check while writes are being refused now', () => {
      const live = createHealthSurface({
        logger,
        metrics,
        storageLiveFailure: (): string =>
          'the run is no longer being saved and continues in memory only',
      });
      const result = live.checkOne(STORAGE);

      expect(result.status).toBe(FAIL);
      expect(result.detail).toContain('refusing writes');
      expect(result.detail).toContain('no longer being saved');
      expect(readData(result, 'live')).toBe(true);
      expect(typeof readData(result, 'liveFailure')).toBe('string');

      // The probe's own account of the store is kept beside it rather than
      // overwritten, so a reader can still see WHAT store is in use.
      expect(readData(result, 'strategy')).toBe('localStorage');
      expect(readData(result, 'supported')).toBe(true);
    });

    it('carries the failure into readiness, which reports ephemeral', () => {
      const live = createHealthSurface({
        logger,
        metrics,
        storageLiveFailure: (): string => 'writes are refused',
      });
      const verdicts = live.readiness();

      expect(verdicts.storageStatus).toBe(FAIL);
      expect(verdicts.storage).toBe('ephemeral');

      // The STRATEGY is still the truth about which store is in use: the run is
      // not being saved to it, and it never fell back to memory.
      expect(verdicts.storageStrategy).toBe('localStorage');
      expect(verdicts.ready).toBe(false);
    });

    it('recovers on the next check when the refusals stop', () => {
      let refusing = true;
      const live = createHealthSurface({
        logger,
        metrics,
        storageLiveFailure: (): string | null =>
          refusing ? 'writes are refused' : null,
      });

      expect(live.checkOne(STORAGE).status).toBe(FAIL);

      refusing = false;

      // Read at check time and never cached, so nothing has to be invalidated.
      expect(live.checkOne(STORAGE).status).toBe(PASS);
      expect(live.checkOne(STORAGE).detail).toContain('writable');
    });

    it('performs no storage write of its own, however often it is checked', () => {
      // The composition hands over the LIVE manager, so the surface reads its
      // construction-time probe result and never probes for itself — which is
      // the property `DL-HEALTH-02` exists for and the one the live verdict must
      // not cost. Ten checks, `refresh` included, and not one write.
      const writes: string[] = [];

      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(
        (key: string): void => {
          writes.push(key);
        },
      );

      const state: StorageStateView = {
        probe: { supported: true, strategy: 'localStorage' },
        strategy: 'localStorage',
      };
      const live = createHealthSurface({
        logger,
        metrics,
        storage: state,
        storageLiveFailure: (): string => 'writes are refused',
      });

      for (let index = 0; index < 10; index += 1) {
        expect(requireCheck(live.check({ refresh: true }), STORAGE).status).toBe(
          FAIL,
        );
      }

      expect(writes).toEqual([]);
    });

    it('reads the probe result alone where the reader raises', () => {
      const live = createHealthSurface({
        logger,
        metrics,
        storageLiveFailure: (): string => {
          throw new Error('the reader exploded');
        },
      });
      const result = live.checkOne(STORAGE);

      // Contained: a reader that raises is a reader that answered nothing, not a
      // storage failure of its own.
      expect(result.status).toBe(PASS);
      expect(readData(result, 'live')).toBeUndefined();
      expect(live.reporterFaults).toBeGreaterThan(0);
    });

    it('answers from the probe alone where no reader was supplied', () => {
      const result = surface.checkOne(STORAGE);

      expect(result.status).toBe(PASS);
      expect(readData(result, 'live')).toBeUndefined();
      expect(readData(result, 'liveFailure')).toBeUndefined();
    });
  });
});

describe('webgl', () => {
  it('reports fail with a reason where no context can be obtained', () => {
    const result = requireCheck(surface.check(), WEBGL);

    expect(result.status).toBe(FAIL);
    expect(readData(result, 'supported')).toBe(false);
    expect(readData(result, 'level')).toBe('none');
    expect(typeof readData(result, 'reason')).toBe('string');
  });

  it('names webgl-support.ts as owner, and is the added check', () => {
    const result = surface.checkOne(WEBGL);

    expect(result.source.owner).toBe('src/render/webgl-support.ts');
    expect(result.source.performedBy).toBe('probeWebGLSupport');
    expect(result.source.disposition).toBe('added');
    expect(result.source.origin).toBeNull();
  });
});


describe('reuse of the probes their owners perform', () => {
  it('routes the storage check through probeWebStorage', () => {
    const spy = vi.spyOn(storageModule, 'probeWebStorage');

    // Constructed after the spy: the surface resolves its default probes at
    // construction.
    const spied = createHealthSurface({ logger, metrics });

    spied.checkOne(STORAGE);

    expect(spy).toHaveBeenCalled();
  });

  it('routes the pointer check through detectPointerEventFamily', () => {
    const spy = vi.spyOn(touchInputModule, 'detectPointerEventFamily');
    const spied = createHealthSurface({ logger, metrics });

    spied.checkOne(POINTER_EVENTS);

    expect(spy).toHaveBeenCalled();
  });

  it('routes the webgl check through probeWebGLSupport', () => {
    const spy = vi.spyOn(webglModule, 'probeWebGLSupport');
    const spied = createHealthSurface({ logger, metrics });

    spied.checkOne(WEBGL);

    expect(spy).toHaveBeenCalled();
  });

  it('reaches every reuse module exactly once across one whole report', () => {
    const storageSpy = vi.spyOn(storageModule, 'probeWebStorage');
    const pointerSpy = vi.spyOn(touchInputModule, 'detectPointerEventFamily');
    const webglSpy = vi.spyOn(webglModule, 'probeWebGLSupport');
    const spied = createHealthSurface({ logger, metrics });

    spied.check();

    expect(storageSpy).toHaveBeenCalledTimes(1);
    expect(pointerSpy).toHaveBeenCalledTimes(1);
    expect(webglSpy).toHaveBeenCalledTimes(1);
  });

  it('probes the three local checks without reaching a reuse module', () => {
    const storageSpy = vi.spyOn(storageModule, 'probeWebStorage');
    const pointerSpy = vi.spyOn(touchInputModule, 'detectPointerEventFamily');
    const webglSpy = vi.spyOn(webglModule, 'probeWebGLSupport');
    const spied = createHealthSurface({ logger, metrics });

    for (const id of [FUNCTION_BIND, CLASS_LIST, REQUEST_ANIMATION_FRAME]) {
      expect(spied.checkOne(id).status).toBe(PASS);
    }

    expect(storageSpy).not.toHaveBeenCalled();
    expect(pointerSpy).not.toHaveBeenCalled();
    expect(webglSpy).not.toHaveBeenCalled();
  });

  it('holds the storage result rather than repeating the round trip', () => {
    const spy = vi.spyOn(storageModule, 'probeWebStorage');
    const spied = createHealthSurface({ logger, metrics });

    spied.check();
    spied.check();

    expect(spy).toHaveBeenCalledTimes(1);

    spied.check({ refresh: true });

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('reads a live manager rather than probing when one is supplied', () => {
    const manager = new LocalStorageManager();
    const spy = vi.spyOn(storageModule, 'probeWebStorage');
    const injected = createHealthSurface({ logger, metrics, storage: manager });
    const result = injected.checkOne(STORAGE);

    // The manager probed once at construction, which is before the spy; the
    // surface reads what it holds and adds no round trip of its own.
    expect(spy).not.toHaveBeenCalled();
    expect(result.status).toBe(PASS);
    expect(readData(result, 'strategy')).toBe(manager.strategy);
  });
});

describe('probing reads a capability and installs none', () => {
  it('leaves Function.prototype.bind at its original reference', () => {
    const before = Function.prototype.bind;

    expect(before).toBe(ORIGINAL_BIND);

    surface.check();

    expect(Function.prototype.bind).toBe(before);
    expect(Function.prototype.bind).toBe(ORIGINAL_BIND);
  });

  it('leaves the animation-frame pair at its original references', () => {
    surface.check();

    expect(window.requestAnimationFrame).toBe(ORIGINAL_REQUEST_ANIMATION_FRAME);
    expect(window.cancelAnimationFrame).toBe(ORIGINAL_CANCEL_ANIMATION_FRAME);
  });

  it('leaves window.Element at its original reference', () => {
    surface.check();

    expect(window.Element).toBe(ORIGINAL_ELEMENT);
  });

  it('installs no msPointerEnabled flag on the navigator', () => {
    surface.check();

    const view = window.navigator as Navigator & {
      msPointerEnabled?: boolean;
    };

    expect(view.msPointerEnabled).toBe(ORIGINAL_MS_POINTER_ENABLED);
  });

  it('leaves no probe-key residue in storage', () => {
    // The reused probe writes STORAGE_PROBE_KEY and removes it again, so the
    // key is absent once the check has run.
    surface.check();

    expect(window.localStorage.getItem(STORAGE_PROBE_KEY)).toBeNull();
  });

  it('writes none of the durable keys the product owns', () => {
    surface.check();

    for (const key of OWNED_STORAGE_KEYS) {
      expect(window.localStorage.getItem(key), `${key} was written`).toBeNull();
    }

    expect(window.localStorage.getItem(BEST_SCORE_KEY)).toBeNull();
    expect(window.localStorage.getItem(GAME_STATE_KEY)).toBeNull();
  });
});


// HealthStatus has three states, and the report roll-up over them

describe('the three-state check status', () => {
  it('names three distinct states', () => {
    expect(new Set([PASS, FAIL, NOT_APPLICABLE]).size).toBe(3);
    expect(HEALTH_GAUGE_VALUES[PASS]).toBe(1);
    expect(HEALTH_GAUGE_VALUES[FAIL]).toBe(0);
    expect(HEALTH_GAUGE_VALUES[NOT_APPLICABLE]).toBe(-1);
  });

  it('observes pass, fail and not-applicable within one report', () => {
    // js/classlist_polyfill.js L2-L3 is one `if` whose two conditions mean
    // opposite things: an absent Element is the no-DOM bail-out, and a refused
    // write is a genuine failure.
    vi.stubGlobal('Element', undefined);
    vi.stubGlobal('localStorage', createQuotaExhaustedStorage());

    const mixed = createHealthSurface({
      logger,
      metrics,
      webglProbe: (): WebGLProbeView => ({
        supported: false,
        level: 'none',
        failure: 'no-document',
        reason: 'No document is available to create a probe canvas.',
      }),
    });
    const report = mixed.check();

    expect(requireCheck(report, FUNCTION_BIND).status).toBe(PASS);
    expect(requireCheck(report, CLASS_LIST).status).toBe(NOT_APPLICABLE);
    expect(requireCheck(report, REQUEST_ANIMATION_FRAME).status).toBe(PASS);
    expect(requireCheck(report, POINTER_EVENTS).status).toBe(PASS);
    expect(requireCheck(report, STORAGE).status).toBe(FAIL);
    expect(requireCheck(report, WEBGL).status).toBe(NOT_APPLICABLE);

    expect(report.counts[PASS]).toBe(3);
    expect(report.counts[FAIL]).toBe(1);
    expect(report.counts[NOT_APPLICABLE]).toBe(2);
  });
});

describe('the report roll-up', () => {
  it('rolls up to fail where at least one check failed', () => {
    const report = surface.check();

    expect(report.counts[FAIL]).toBeGreaterThan(0);
    expect(report.status).toBe(FAIL);
  });

  it('does not let a not-applicable result drag the roll-up to fail', () => {
    vi.stubGlobal('Element', undefined);

    const inapplicable = createHealthSurface({
      logger,
      metrics,
      webglProbe: (): WebGLProbeView => ({
        supported: false,
        level: 'none',
        failure: 'no-document',
        reason: 'No document is available to create a probe canvas.',
      }),
    });
    const report = inapplicable.check();

    expect(report.counts[NOT_APPLICABLE]).toBeGreaterThan(0);
    expect(report.counts[FAIL]).toBe(0);
    expect(report.status).toBe(PASS);
  });

  it('keeps the roll-up at fail where both coexist', () => {
    vi.stubGlobal('Element', undefined);

    const both = createHealthSurface({ logger, metrics });
    const report = both.check();

    expect(report.counts[NOT_APPLICABLE]).toBeGreaterThan(0);
    expect(report.counts[FAIL]).toBeGreaterThan(0);
    expect(report.status).toBe(FAIL);
  });

  it('follows one rule across every reachable combination of counts', () => {
    const cases: HealthSurface[] = [
      // Five passes and the environment's failing WebGL check.
      createHealthSurface({ logger, metrics }),

      // No failure at all: the WebGL check reports inapplicable instead.
      createHealthSurface({
        logger,
        metrics,
        webglProbe: (): WebGLProbeView => ({
          supported: false,
          level: 'none',
          failure: 'no-document',
        }),
      }),

      createHealthSurface({
        logger,
        metrics,
        webglProbe: (): WebGLProbeView => ({
          supported: true,
          level: 'webgl',
        }),
      }),

      createHealthSurface({
        logger,
        metrics,
        storageProbe: (): StorageProbeView => ({
          supported: false,
          strategy: 'memory',
          error: {
            name: 'SecurityError',
            message: 'Storage refused the operation.',
            quota: false,
          },
        }),
      }),
    ];

    for (const candidate of cases) {
      const report = candidate.check();
      const expected: HealthStatus =
        report.counts[FAIL] > 0
          ? FAIL
          : report.counts[PASS] > 0
            ? PASS
            : NOT_APPLICABLE;

      expect(report.status).toBe(expected);
    }
  });

  it('rotates with the logger when a second run starts', () => {
    surface.check();

    logger.setCorrelationId('health-second-run');

    const report = surface.check();

    expect(surface.correlationId).toBe('health-second-run');
    expect(report.correlationId).toBe('health-second-run');
    expect(surface.readiness().correlationId).toBe('health-second-run');
  });

  it('reports the empty identifier when the logger refuses the read', () => {
    // The surface logs through a CHILD of the injected logger, so the child is
    // where the correlation read has to be made hostile.
    const hostileChild = Object.create(logger.child('health')) as Logger;

    Object.defineProperty(hostileChild, 'correlationId', {
      get: (): never => {
        throw new Error('the correlation scope is unreadable');
      },
    });

    const hostile = Object.create(logger) as Logger;

    Object.defineProperty(hostile, 'child', {
      value: (): Logger => hostileChild,
    });

    const guarded = createHealthSurface({ logger: hostile, metrics });

    // Every member of the surface is total, so the refused read yields the
    // empty string and neither the getter nor the two reports raise through
    // it.
    expect(() => guarded.correlationId).not.toThrow();
    expect(guarded.correlationId).toBe('');
    expect(guarded.check().correlationId).toBe('');
    expect(guarded.readiness().correlationId).toBe('');
  });

  it('carries the injected correlation identifier and a timestamp', () => {
    const report = surface.check();

    expect(surface.correlationId).toBe(logger.correlationId);
    expect(report.correlationId).toBe(CORRELATION_ID);
    expect(report.timestamp.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(report.timestamp))).toBe(false);
    expect(Number.isFinite(report.durationMs)).toBe(true);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.checks).toHaveLength(HEALTH_CHECK_COUNT);
  });
});

// The WebGL negative branch and the number-only fallback (I6)

describe('webgl support in a host that offers no context', () => {
  it('reports no context, and a reason rather than a bare false', () => {
    const support = webglModule.probeWebGLSupport();

    expect(support.supported).toBe(false);
    expect(support.level).toBe('none');
    expect(typeof support.reason).toBe('string');
    expect(support.reason ?? '').not.toBe('');
    expect(typeof support.failure).toBe('string');
  });

  it('reflects the negative outcome in the check result data', () => {
    const result = requireCheck(surface.check(), WEBGL);
    const level = readData(result, 'level');

    expect(result.status).toBe(FAIL);
    expect(level).not.toBe('webgl2');
    expect(level).not.toBe('webgl');
    expect(level).toBe('none');
    expect(readData(result, 'supported')).toBe(false);
    expect(typeof readData(result, 'reason')).toBe('string');
    expect(typeof readData(result, 'failure')).toBe('string');
  });

  it('selects the number-only renderer in the readiness verdict', () => {
    const verdicts = surface.readiness();

    expect(verdicts.mayMountWebGLRenderer).toBe(false);
    expect(verdicts.requiresNumberOnlyFallback).toBe(true);
    expect(verdicts.renderer).toBe('number-only');
    expect(verdicts.webglStatus).toBe(FAIL);
    expect(verdicts.webglLevel).toBe('none');
    expect(typeof verdicts.webglFailure).toBe('string');
  });

  it('carries both consequential verdicts, not one', () => {
    const verdicts: ReadinessReport = surface.readiness();

    expect(verdicts.renderer).toBe('number-only');

    expect(verdicts.storage).toBe('persistent');
    expect(verdicts.storageStrategy).toBe('localStorage');

    expect(verdicts.correlationId).toBe(CORRELATION_ID);
    expect(verdicts.timestamp.length).toBeGreaterThan(0);
    expect(verdicts.healthStatus).toBe(FAIL);
    expect(Object.isFrozen(verdicts)).toBe(true);
  });

  it('still demands the fallback where the probe reports no document', () => {
    const headless = createHealthSurface({
      logger,
      metrics,
      webglProbe: (): WebGLProbeView => ({
        supported: false,
        level: 'none',
        failure: 'no-document',
        reason: 'No document is available to create a probe canvas.',
      }),
    });
    const verdicts = headless.readiness();

    expect(verdicts.webglStatus).toBe(NOT_APPLICABLE);
    expect(verdicts.mayMountWebGLRenderer).toBe(false);
    expect(verdicts.requiresNumberOnlyFallback).toBe(true);
    expect(verdicts.renderer).toBe('number-only');
    expect(verdicts.ready).toBe(false);
  });

  it('permits mounting where an injected probe reports a live context', () => {
    const live = createHealthSurface({
      logger,
      metrics,
      webglProbe: (): WebGLProbeView => ({
        supported: true,
        level: 'webgl2',
        contextRelease: 'released',
      }),
    });
    const verdicts = live.readiness();

    expect(verdicts.webglStatus).toBe(PASS);
    expect(verdicts.mayMountWebGLRenderer).toBe(true);
    expect(verdicts.requiresNumberOnlyFallback).toBe(false);
    expect(verdicts.renderer).toBe('webgl');
    expect(verdicts.webglLevel).toBe('webgl2');
    expect(verdicts.webglFailure).toBeUndefined();
    expect(verdicts.ready).toBe(true);
  });

  it('permits mounting where the owner obtains a context after a reset', () => {
    resetWebGLSupportProbe();

    const canvas = createContextCanvas('webgl2');

    vi.spyOn(document, 'createElement').mockImplementation(
      (tag: string): HTMLElement =>
        tag === 'canvas' ? canvas.element : ({} as unknown as HTMLElement),
    );

    const support = webglModule.probeWebGLSupport();

    expect(support.supported).toBe(true);
    expect(support.level).toBe('webgl2');
    expect(canvas.requests).toContain('webgl2');

    const verdicts = createHealthSurface({ logger, metrics }).readiness();

    expect(verdicts.webglStatus).toBe(PASS);
    expect(verdicts.mayMountWebGLRenderer).toBe(true);
    expect(verdicts.requiresNumberOnlyFallback).toBe(false);
    expect(verdicts.renderer).toBe('webgl');
  });

  it('answers a later caller from the held result, not a new probe', () => {
    resetWebGLSupportProbe();

    const canvas = createContextCanvas('webgl2');
    const created = vi
      .spyOn(document, 'createElement')
      .mockImplementation((tag: string): HTMLElement =>
        tag === 'canvas' ? canvas.element : ({} as unknown as HTMLElement),
      );
    const first = webglModule.probeWebGLSupport();
    const second = webglModule.probeWebGLSupport();

    expect(second).toBe(first);
    expect(created).toHaveBeenCalledTimes(1);
    expect(canvas.requests).toHaveLength(1);
  });

  it('reports the negative outcome again once the result is discarded', () => {
    // The reset in `afterEach` is what keeps a stubbed positive from leaking
    // into a later test; this asserts that it holds.
    const support = webglModule.probeWebGLSupport();

    expect(support.supported).toBe(false);
    expect(surface.checkOne(WEBGL).status).toBe(FAIL);
  });
});


// The storage strategy in the readiness verdict, both branches

describe('the live storage strategy in the readiness verdict', () => {
  it('reports the persistent strategy of a Web Storage manager', () => {
    // js/local_storage_manager.js L26: the strategy is fixed once, at
    // construction.
    const manager = new LocalStorageManager();

    expect(manager.strategy).toBe('localStorage');
    expect(manager.probe.supported).toBe(true);

    const verdicts = createHealthSurface({
      logger,
      metrics,
      storage: manager,
    }).readiness();

    expect(verdicts.storageStatus).toBe(PASS);
    expect(verdicts.storage).toBe('persistent');
    expect(verdicts.storageStrategy).toBe(manager.strategy);
  });

  it('reports the ephemeral strategy where writes are refused', () => {
    vi.stubGlobal('localStorage', createQuotaExhaustedStorage());

    const manager = new LocalStorageManager();

    expect(manager.strategy).toBe('memory');
    expect(manager.probe.supported).toBe(false);

    const verdicts = createHealthSurface({
      logger,
      metrics,
      storage: manager,
    }).readiness();

    expect(verdicts.storageStatus).toBe(FAIL);
    expect(verdicts.storage).toBe('ephemeral');
    expect(verdicts.storageStrategy).toBe(manager.strategy);
    expect(verdicts.ready).toBe(false);
  });

  it('reports the injected strategy of a manager given a MemoryStorage', () => {
    const manager = new LocalStorageManager({ storage: new MemoryStorage() });

    expect(manager.strategy).toBe('injected');

    const verdicts = createHealthSurface({
      logger,
      metrics,
      storage: manager,
    }).readiness();

    expect(verdicts.storageStatus).toBe(PASS);
    expect(verdicts.storage).toBe('ephemeral');
    expect(verdicts.storageStrategy).toBe(manager.strategy);
  });

  it('reports the strategy of the live manager, not a re-probe', () => {
    // Web Storage is writable here, so a re-probe would answer
    // `'localStorage'`; the verdict must instead follow the injected view.
    const state: StorageStateView = {
      probe: { supported: false, strategy: 'memory' },
      strategy: 'memory',
    };
    const verdicts = createHealthSurface({
      logger,
      metrics,
      storage: state,
    }).readiness();

    expect(webglModule.probeWebGLSupport).toBeTypeOf('function');
    expect(storageModule.probeWebStorage().supported).toBe(true);
    expect(verdicts.storageStrategy).toBe('memory');
    expect(verdicts.storage).toBe('ephemeral');
  });

  it('distinguishes an absent store from one that refused a write', () => {
    const absent: StorageProbeView = { supported: false, strategy: 'memory' };
    const refused: StorageProbeView = {
      supported: false,
      strategy: 'memory',
      error: {
        name: 'QuotaExceededError',
        message: 'Storage is full; the operation was refused.',
        quota: true,
      },
    };

    const absentResult = createHealthSurface({
      logger,
      metrics,
      storageProbe: (): StorageProbeView => absent,
    }).checkOne(STORAGE);
    const refusedResult = createHealthSurface({
      logger,
      metrics,
      storageProbe: (): StorageProbeView => refused,
    }).checkOne(STORAGE);

    // Same `supported: false`, two different verdicts: quota exhaustion is a
    // failure, an absent store is not applicable.
    expect(absentResult.status).toBe(NOT_APPLICABLE);
    expect(readData(absentResult, 'errorName')).toBeUndefined();
    expect(readData(absentResult, 'quotaExceeded')).toBeUndefined();

    expect(refusedResult.status).toBe(FAIL);
    expect(readData(refusedResult, 'errorName')).toBe('QuotaExceededError');
    expect(readData(refusedResult, 'quotaExceeded')).toBe(true);
  });

  it('reports a non-quota refusal without flattening it to quota', () => {
    const denied: StorageProbeView = {
      supported: false,
      strategy: 'memory',
      error: {
        name: 'SecurityError',
        message: 'Storage refused the operation.',
        quota: false,
      },
    };
    const result = createHealthSurface({
      logger,
      metrics,
      storageProbe: (): StorageProbeView => denied,
    }).checkOne(STORAGE);

    expect(result.status).toBe(FAIL);
    expect(readData(result, 'errorName')).toBe('SecurityError');
    expect(readData(result, 'quotaExceeded')).toBe(false);
  });

  it('reports fail where the probe returns nothing usable', () => {
    const result = createHealthSurface({
      logger,
      metrics,
      storageProbe: () => undefined as unknown as StorageProbeView,
    }).checkOne(STORAGE);

    expect(result.status).toBe(FAIL);
    expect(readData(result, 'supported')).toBe(false);
  });

  it('refuses persistence where the strategy names a failed store', () => {
    // The contradiction boundary. `StorageStateView` is injected, so a view
    // naming `'localStorage'` beside a probe result that did not pass is
    // type-valid — and deriving persistence from the NAME alone reported that
    // state as persistent and ready.
    const contradictory: StorageStateView = {
      probe: {
        supported: false,
        strategy: 'localStorage',
        error: {
          name: 'QuotaExceededError',
          message: 'Storage is full; the operation was refused.',
          quota: true,
        },
      },
      strategy: 'localStorage',
    };
    const verdicts = createHealthSurface({
      logger,
      metrics,
      storage: contradictory,
    }).readiness();

    expect(verdicts.storageStrategy).toBe('localStorage');
    expect(verdicts.storageStatus).toBe(FAIL);
    expect(verdicts.storage).toBe('ephemeral');
    expect(verdicts.ready).toBe(false);
  });

  it('refuses persistence for a not-applicable Web Storage strategy', () => {
    // The third status is not a pass either: a host offering no store at all
    // yields `'not-applicable'`, which must not read as persistent.
    const inapplicable: StorageStateView = {
      probe: { supported: false, strategy: 'localStorage' },
      strategy: 'localStorage',
    };
    const verdicts = createHealthSurface({
      logger,
      metrics,
      storage: inapplicable,
    }).readiness();

    expect(verdicts.storageStatus).toBe(NOT_APPLICABLE);
    expect(verdicts.storage).toBe('ephemeral');
    expect(verdicts.ready).toBe(false);
  });
});

// The report lifecycle

describe('checkOne', () => {
  it('returns only the named check, for every declared id', () => {
    for (const id of HEALTH_CHECK_IDS) {
      const result = surface.checkOne(id);

      expect(result.id).toBe(id);
      expect(result.source).toBe(HEALTH_CHECK_SOURCES[id]);
      expect(Object.isFrozen(result)).toBe(true);
    }
  });

  it('fails an unrecognised id rather than throwing', () => {
    const unknownId = 'notAProbe' as unknown as HealthCheckId;

    expect(isHealthCheckId(unknownId)).toBe(false);

    const result = surface.checkOne(unknownId);

    expect(result.status).toBe(FAIL);
    expect(result.id).toBe(unknownId);
    expect(readData(result, 'recognised')).toBe(false);
    expect(result.source.origin).toBeNull();
  });

  it('leaves the held report alone and notifies no subscriber', () => {
    const delivered: HealthReport[] = [];

    surface.subscribe((report) => delivered.push(report));
    surface.checkOne(FUNCTION_BIND);

    expect(surface.lastReport()).toBeNull();
    expect(delivered).toHaveLength(0);
  });
});

describe('the held report', () => {
  it('is absent before the first check', () => {
    expect(surface.lastReport()).toBeNull();
  });

  it('is the most recent report, replaced rather than appended', () => {
    const first = surface.check();

    expect(surface.lastReport()).toBe(first);

    const second = surface.check();

    expect(second).not.toBe(first);
    expect(surface.lastReport()).toBe(second);
    expect(surface.lastReport()?.checks).toHaveLength(HEALTH_CHECK_COUNT);
  });

  it('is returned by report(), and refresh forces a new one', () => {
    const first = surface.check();

    expect(surface.report()).toBe(first);

    const refreshed = surface.report({ refresh: true });

    expect(refreshed).not.toBe(first);
    expect(surface.lastReport()).toBe(refreshed);
  });

  it('is produced by report() when none has been taken yet', () => {
    expect(surface.lastReport()).toBeNull();

    const produced = surface.report();

    expect(produced.checks).toHaveLength(HEALTH_CHECK_COUNT);
    expect(surface.lastReport()).toBe(produced);
  });
});

describe('subscribers', () => {
  it('all receive every completed report', () => {
    const first: HealthReport[] = [];
    const second: HealthReport[] = [];

    surface.subscribe((report) => first.push(report));
    surface.subscribe((report) => second.push(report));

    const report = surface.check();

    expect(first).toStrictEqual([report]);
    expect(second).toStrictEqual([report]);
  });

  it('stop receiving once the returned handle is called', () => {
    const delivered: HealthReport[] = [];
    const unsubscribe = surface.subscribe((report) => delivered.push(report));

    surface.check();

    expect(delivered).toHaveLength(1);

    unsubscribe();
    surface.check();

    expect(delivered).toHaveLength(1);

    expect(() => unsubscribe()).not.toThrow();
  });

  it('are isolated from one another when one throws', () => {
    const delivered: HealthReport[] = [];

    surface.subscribe(() => {
      throw new Error('A subscriber threw.');
    });
    surface.subscribe((report) => delivered.push(report));

    expect(() => surface.check()).not.toThrow();
    expect(delivered).toHaveLength(1);
    expect(surface.reporterFaults).toBeGreaterThan(0);
  });

  it('count no fault where every collaborator behaves', () => {
    surface.subscribe(() => undefined);
    surface.check();

    expect(surface.reporterFaults).toBe(0);
  });
});

describe('probe views', () => {
  it('carry one entry per check, in HEALTH_CHECK_IDS order', () => {
    const views = surface.probeViews();

    expect(views.map((view) => view.name)).toStrictEqual([
      ...HEALTH_CHECK_IDS,
    ]);
  });

  it('read healthy as false only for a failure', () => {
    vi.stubGlobal('Element', undefined);

    const mixed = createHealthSurface({ logger, metrics });
    const report = mixed.check();
    const views = mixed.probeViews();

    for (const view of views) {
      const result = requireCheck(report, view.name as HealthCheckId);

      expect(view.healthy).toBe(result.status !== FAIL);
      expect(view.detail.length).toBeGreaterThan(0);
    }

    const inapplicable = views.find((view) => view.name === CLASS_LIST);

    expect(inapplicable?.healthy).toBe(true);
    expect(inapplicable?.detail).toContain('not applicable');
  });

  it('carry the three-state status unreduced beside the boolean', () => {
    vi.stubGlobal('Element', undefined);

    const mixed = createHealthSurface({
      logger,
      metrics,
      webglProbe: NO_CONTEXT_PROBE,
    });
    const report = mixed.check();

    for (const view of mixed.probeViews()) {
      const result = requireCheck(report, view.name as HealthCheckId);

      // The authoritative member. `healthy` cannot express the third state, so
      // a consumer reading it alone presents an inapplicable check as a pass.
      expect(view.status).toBe(result.status);
    }

    const views = mixed.probeViews();

    expect(views.find((view) => view.name === CLASS_LIST)?.status).toBe(
      NOT_APPLICABLE,
    );
    expect(views.find((view) => view.name === FUNCTION_BIND)?.status).toBe(
      PASS,
    );
    expect(views.find((view) => view.name === WEBGL)?.status).toBe(FAIL);
  });

  it('are produced on every call of a bound reader', () => {
    const read = surface.probeReader();

    expect(read()).toHaveLength(HEALTH_CHECK_COUNT);
    expect(read()).toHaveLength(HEALTH_CHECK_COUNT);
    expect(surface.lastReport()).not.toBeNull();
  });
});


// Every result is reported: one status gauge and one log record

describe('the status gauge every check is recorded on', () => {
  it('carries one series per check, labelled with the check id', () => {
    surface.check();

    const gauges = readHealthGauges(metrics);

    expect(gauges.size).toBe(HEALTH_CHECK_COUNT);

    for (const id of HEALTH_CHECK_IDS) {
      expect(gauges.has(id), `no status gauge for "${id}"`).toBe(true);
    }
  });

  it('encodes each status as the value HEALTH_GAUGE_VALUES declares', () => {
    const report = surface.check();
    const gauges = readHealthGauges(metrics);

    for (const result of report.checks) {
      expect(gauges.get(result.id)).toBe(HEALTH_GAUGE_VALUES[result.status]);
    }
  });

  it('distinguishes the third state on the same series', () => {
    vi.stubGlobal('Element', undefined);

    const mixed = createHealthSurface({ logger, metrics });

    mixed.check();

    const gauges = readHealthGauges(metrics);

    expect(gauges.size).toBe(HEALTH_CHECK_COUNT);
    expect(gauges.get(CLASS_LIST)).toBe(HEALTH_GAUGE_VALUES[NOT_APPLICABLE]);
    expect(gauges.get(FUNCTION_BIND)).toBe(HEALTH_GAUGE_VALUES[PASS]);
    expect(gauges.get(WEBGL)).toBe(HEALTH_GAUGE_VALUES[FAIL]);

    expect(
      new Set([
        gauges.get(CLASS_LIST),
        gauges.get(FUNCTION_BIND),
        gauges.get(WEBGL),
      ]).size,
    ).toBe(3);
  });

  it('exports the health family in the Prometheus text snapshot', () => {
    surface.check();

    const text = metrics.toPrometheusText();

    expect(text).toContain(METRIC_NAMES.healthCheckStatus);

    for (const id of HEALTH_CHECK_IDS) {
      expect(text).toContain(`${METRIC_LABELS.check}="${id}"`);
    }
  });

  it('records a single series per check across repeated reports', () => {
    surface.check();
    surface.check();
    surface.check();

    expect(readHealthGauges(metrics).size).toBe(HEALTH_CHECK_COUNT);
  });
});

describe('the log record every check is reported through', () => {
  it('carries one record per check, with the correlation identifier', () => {
    const report = surface.check();
    const records = readCheckRecords(logger);

    expect(records.size).toBe(HEALTH_CHECK_COUNT);

    for (const result of report.checks) {
      const record = records.get(result.id);

      expect(record, `no log record for "${result.id}"`).toBeDefined();
      expect(record?.correlationId).toBe(CORRELATION_ID);
      expect(record?.subsystem).toBe('health');
      expect(record?.fields?.status).toBe(result.status);
      expect(record?.fields?.detail).toBe(result.detail);
    }
  });

  it('carries the reused-versus-added provenance on every record', () => {
    const report = surface.check();
    const records = readCheckRecords(logger);

    for (const result of report.checks) {
      const fields = records.get(result.id)?.fields;

      expect(fields?.disposition).toBe(result.source.disposition);
      expect(fields?.owner).toBe(result.source.owner);
      expect(fields?.origin).toBe(result.source.origin);
    }
  });

  it('records a failing check at warn and a passing one at info', () => {
    surface.check();

    const records = readCheckRecords(logger);

    expect(records.get(FUNCTION_BIND)?.level).toBe('info');
    expect(records.get(WEBGL)?.level).toBe('warn');
  });

  it('records an inapplicable check at info, not at warn', () => {
    vi.stubGlobal('Element', undefined);

    const inapplicable = createHealthSurface({ logger, metrics });

    inapplicable.checkOne(CLASS_LIST);

    expect(readCheckRecords(logger).get(CLASS_LIST)?.level).toBe('info');
  });

  it('contains a probe that throws, reporting it as a failure', () => {
    const thrown = new Error('The probe threw.');
    const throwing = createHealthSurface({
      logger,
      metrics,
      webglProbe: (): WebGLProbeView => {
        throw thrown;
      },
    });

    expect(() => throwing.check()).not.toThrow();

    const result = requireCheck(
      throwing.lastReport() as HealthReport,
      WEBGL,
    );

    expect(result.status).toBe(FAIL);
    expect(readData(result, 'threw')).toBe(true);
    expect(result.error?.message).toBe('The probe threw.');
    expect(readHealthGauges(metrics).get(WEBGL)).toBe(
      HEALTH_GAUGE_VALUES[FAIL],
    );
  });

  it('contains a throwing logger without losing a check result', () => {
    const resilient = createHealthSurface({
      logger: createThrowingLogger(),
      metrics,
    });
    let report: HealthReport | undefined;

    expect(() => {
      report = resilient.check();
    }).not.toThrow();

    expect(report?.checks).toHaveLength(HEALTH_CHECK_COUNT);
    expect(report?.correlationId).toBe(CORRELATION_ID);

    expect(resilient.reporterFaults).toBe(HEALTH_CHECK_COUNT);
    expect(readHealthGauges(metrics).size).toBe(HEALTH_CHECK_COUNT);
  });

  it('shares the correlation identifier across every surface', () => {
    const report = surface.check();
    const verdicts = surface.readiness();

    expect(surface.correlationId).toBe(CORRELATION_ID);
    expect(report.correlationId).toBe(CORRELATION_ID);
    expect(verdicts.correlationId).toBe(CORRELATION_ID);
    expect(metrics.correlationId).toBe(CORRELATION_ID);
  });
});

// Construction, and the state a surface holds before it is used

describe('a probe that throws, driven one check at a time', () => {
  /**
   * Asserts the shape every contained probe throw produces, and that no other
   * check moved.
   *
   * @param report The report the throwing surface produced.
   * @param affected The check whose probe threw.
   * @param message Message the probe threw.
   */
  const expectOnlyOneThrew = (
    report: HealthReport,
    affected: HealthCheckId,
    message: string,
  ): void => {
    // All six still return: a probe that throws costs its own result, not the
    // report.
    expect(report.checks).toHaveLength(HEALTH_CHECK_COUNT);
    expect(report.checks.map((result) => result.id)).toStrictEqual([
      ...HEALTH_CHECK_IDS,
    ]);

    const failed = requireCheck(report, affected);

    expect(failed.status).toBe(FAIL);
    expect(readData(failed, 'threw')).toBe(true);

    // The serialised error details survive into the result.
    expect(failed.error?.message).toBe(message);
    expect(failed.error?.name).toBe('Error');
    expect(typeof failed.error?.stack).toBe('string');

    // Every other check carries no throw marker, and the affected one is the
    // only one whose data bag is the throw bag.
    for (const result of report.checks) {
      if (result.id === affected) {
        continue;
      }

      expect(readData(result, 'threw'), `${result.id} threw`).toBeUndefined();
      expect(result.error, `${result.id} carried an error`).toBeUndefined();
    }
  };

  it('contains a throwing pointer probe, leaving the other five intact', () => {
    const message = 'The pointer probe threw.';
    const throwing = createHealthSurface({
      logger,
      metrics,
      pointerProbe: (): PointerFamilyView => {
        throw new Error(message);
      },
    });
    let report: HealthReport | undefined;

    expect(() => {
      report = throwing.check();
    }).not.toThrow();

    expectOnlyOneThrew(report as HealthReport, POINTER_EVENTS, message);

    // The reused probes that did not throw still reported their own verdicts.
    expect(requireCheck(report as HealthReport, FUNCTION_BIND).status).toBe(
      PASS,
    );
    expect(requireCheck(report as HealthReport, CLASS_LIST).status).toBe(PASS);
    expect(readHealthGauges(metrics).get(POINTER_EVENTS)).toBe(
      HEALTH_GAUGE_VALUES[FAIL],
    );
    expect(readHealthGauges(metrics).size).toBe(HEALTH_CHECK_COUNT);
  });

  it('contains a throwing storage probe, leaving the other five intact', () => {
    const message = 'The storage probe threw.';
    const throwing = createHealthSurface({
      logger,
      metrics,
      storageProbe: (): StorageProbeView => {
        throw new Error(message);
      },
    });
    let report: HealthReport | undefined;

    expect(() => {
      report = throwing.check();
    }).not.toThrow();

    expectOnlyOneThrew(report as HealthReport, STORAGE, message);

    const verdicts = throwing.readiness();

    expect(verdicts.storageStatus).toBe(FAIL);
    expect(verdicts.storage).toBe('ephemeral');
    expect(verdicts.ready).toBe(false);
  });

  it('contains a throwing WebGL probe and leaves the other five intact', () => {
    const message = 'The WebGL probe threw.';
    const throwing = createHealthSurface({
      logger,
      metrics,
      webglProbe: (): WebGLProbeView => {
        throw new Error(message);
      },
    });
    let report: HealthReport | undefined;

    expect(() => {
      report = throwing.check();
    }).not.toThrow();

    expectOnlyOneThrew(report as HealthReport, WEBGL, message);
    expect(throwing.readiness().requiresNumberOnlyFallback).toBe(true);
  });

  it('reports a throwing probe at warn and the passing ones at info', () => {
    const throwing = createHealthSurface({
      logger,
      metrics,
      pointerProbe: (): PointerFamilyView => {
        throw new Error('The pointer probe threw.');
      },
    });

    throwing.check();

    const records = readCheckRecords(logger);

    expect(records.size).toBe(HEALTH_CHECK_COUNT);
    expect(records.get(POINTER_EVENTS)?.level).toBe('warn');
    expect(records.get(FUNCTION_BIND)?.level).toBe('info');
  });
});

describe('the capability branches no probe injection reaches', () => {
  it('reports rAF not-applicable where no window is present', () => {
    // js/animframe_polyfill.js ran against `window`; with none present the
    // question does not arise, so the verdict is the third state, not a fail.
    vi.stubGlobal('window', undefined);

    const result = createHealthSurface({ logger, metrics }).checkOne(
      REQUEST_ANIMATION_FRAME,
    );

    expect(result.status).toBe(NOT_APPLICABLE);
    expect(readData(result, 'window')).toBe(false);
    expect(readData(result, 'requestAnimationFrame')).toBeUndefined();
    expect(readHealthGauges(metrics).get(REQUEST_ANIMATION_FRAME)).toBe(
      HEALTH_GAUGE_VALUES[NOT_APPLICABLE],
    );
  });

  it('reports fail where only the request half is missing', () => {
    // The complement of the cancel-half case: the pair is what the polyfill
    // installed, so either half missing is a failure and the data bag names
    // which.
    vi.stubGlobal('requestAnimationFrame', undefined);

    const result = createHealthSurface({ logger, metrics }).checkOne(
      REQUEST_ANIMATION_FRAME,
    );

    expect(result.status).toBe(FAIL);
    expect(readData(result, 'requestAnimationFrame')).toBe(false);
    expect(readData(result, 'cancelAnimationFrame')).toBe(true);
  });

  it('reports classList fail where Element is present, the API absent', () => {
    const root = document.documentElement;
    const shimmed = Object.create(null) as Record<string, unknown>;

    shimmed.tagName = root.tagName;

    vi.spyOn(document, 'documentElement', 'get').mockReturnValue(
      shimmed as unknown as HTMLElement,
    );

    const result = createHealthSurface({ logger, metrics }).checkOne(
      CLASS_LIST,
    );

    expect(result.status).toBe(FAIL);
    expect(readData(result, 'window')).toBe(true);
    expect(readData(result, 'element')).toBe(true);
    expect(readData(result, 'document')).toBe(true);
    expect(readData(result, 'documentElement')).toBe(true);
    expect(readData(result, 'classList')).toBe(false);
    expect(readHealthGauges(metrics).get(CLASS_LIST)).toBe(
      HEALTH_GAUGE_VALUES[FAIL],
    );
  });

  it('reports classList not-applicable for an unreadable root element', () => {
    vi.spyOn(document, 'documentElement', 'get').mockReturnValue(
      null as unknown as HTMLElement,
    );

    const result = createHealthSurface({ logger, metrics }).checkOne(
      CLASS_LIST,
    );

    expect(result.status).toBe(NOT_APPLICABLE);
    expect(readData(result, 'documentElement')).toBe(false);
  });

  it('changes only the affected check when one capability is withdrawn', () => {
    vi.stubGlobal('cancelAnimationFrame', undefined);

    const report = createHealthSurface({ logger, metrics }).check();

    expect(report.checks).toHaveLength(HEALTH_CHECK_COUNT);
    expect(requireCheck(report, REQUEST_ANIMATION_FRAME).status).toBe(FAIL);
    expect(requireCheck(report, FUNCTION_BIND).status).toBe(PASS);
    expect(requireCheck(report, CLASS_LIST).status).toBe(PASS);
    expect(requireCheck(report, POINTER_EVENTS).status).toBe(PASS);
    expect(requireCheck(report, STORAGE).status).toBe(PASS);
  });
});

describe('a metrics registry whose write paths throw', () => {
  /**
   * A registry whose two health write paths throw and whose every other member
   * delegates to a real one.
   *
   * @returns The registry.
   */
  const createThrowingMetrics = (): MetricsRegistry => {
    const base = createMetricsRegistry({ logger });

    vi.spyOn(base, 'gauge').mockImplementation((): never => {
      throw new Error('The registry refused a gauge.');
    });
    vi.spyOn(base, 'recordHealthCheck').mockImplementation((): never => {
      throw new Error('The registry refused a health check.');
    });

    return base;
  };

  it('returns every check from check() and counts one fault per write', () => {
    const resilient = createHealthSurface({
      logger,
      metrics: createThrowingMetrics(),
    });
    let report: HealthReport | undefined;

    expect(() => {
      report = resilient.check();
    }).not.toThrow();

    expect(report?.checks).toHaveLength(HEALTH_CHECK_COUNT);
    expect(report?.checks.map((result) => result.id)).toStrictEqual([
      ...HEALTH_CHECK_IDS,
    ]);

    // Exactly one contained fault per check: the gauge write failed six times
    // and nothing else did.
    expect(resilient.reporterFaults).toBe(HEALTH_CHECK_COUNT);
  });

  it('keeps the logger records available when the registry refuses', () => {
    const resilient = createHealthSurface({
      logger,
      metrics: createThrowingMetrics(),
    });

    resilient.check();

    const records = readCheckRecords(logger);

    expect(records.size).toBe(HEALTH_CHECK_COUNT);

    for (const id of HEALTH_CHECK_IDS) {
      expect(records.get(id)?.subsystem, id).toBe('health');
    }
  });

  it('returns a result from checkOne and counts exactly one fault', () => {
    const resilient = createHealthSurface({
      logger,
      metrics: createThrowingMetrics(),
    });
    let result: HealthCheckResult | undefined;

    expect(() => {
      result = resilient.checkOne(FUNCTION_BIND);
    }).not.toThrow();

    expect(result?.id).toBe(FUNCTION_BIND);
    expect(result?.status).toBe(PASS);
    expect(resilient.reporterFaults).toBe(1);
  });

  it('counts the third-state write path as well, and still returns', () => {
    vi.stubGlobal('Element', undefined);

    const resilient = createHealthSurface({
      logger,
      metrics: createThrowingMetrics(),
    });
    let result: HealthCheckResult | undefined;

    expect(() => {
      result = resilient.checkOne(CLASS_LIST);
    }).not.toThrow();

    expect(result?.status).toBe(NOT_APPLICABLE);
    expect(resilient.reporterFaults).toBe(1);
  });

  it('leaves readiness derivable when every write refuses', () => {
    const resilient = createHealthSurface({
      logger,
      metrics: createThrowingMetrics(),
    });
    let verdicts: ReadinessReport | undefined;

    expect(() => {
      verdicts = resilient.readiness();
    }).not.toThrow();

    expect(verdicts?.requiresNumberOnlyFallback).toBe(true);
    expect(verdicts?.correlationId).toBe(CORRELATION_ID);
  });
});

describe('construction', () => {
  it('probes nothing and reports nothing', () => {
    const storageSpy = vi.spyOn(storageModule, 'probeWebStorage');
    const pointerSpy = vi.spyOn(touchInputModule, 'detectPointerEventFamily');
    const webglSpy = vi.spyOn(webglModule, 'probeWebGLSupport');
    const fresh = createHealthSurface({ logger, metrics });

    expect(storageSpy).not.toHaveBeenCalled();
    expect(pointerSpy).not.toHaveBeenCalled();
    expect(webglSpy).not.toHaveBeenCalled();
    expect(fresh.lastReport()).toBeNull();
    expect(fresh.reporterFaults).toBe(0);
    expect(readHealthGauges(metrics).size).toBe(0);
    expect(readCheckRecords(logger).size).toBe(0);
  });

  it('is usable with no collaborators supplied', () => {
    // A surface built with no logger writes its records to the console; the
    // five writers it can resolve are stubbed for the duration of this test.
    for (const method of ['debug', 'info', 'warn', 'error', 'log'] as const) {
      vi.spyOn(console, method).mockImplementation((): void => undefined);
    }

    const standalone = new HealthSurface();

    expect(standalone.correlationId.length).toBeGreaterThan(0);
    expect(standalone.check().checks).toHaveLength(HEALTH_CHECK_COUNT);
    expect(standalone.readiness().requiresNumberOnlyFallback).toBe(true);
  });

  it('is produced identically by the class and the factory', () => {
    const constructed = new HealthSurface({ logger, metrics });
    const built = createHealthSurface({ logger, metrics });

    expect(built).toBeInstanceOf(HealthSurface);
    expect(built.correlationId).toBe(constructed.correlationId);
    expect(built.check().checks.map((result) => result.id)).toStrictEqual(
      constructed.check().checks.map((result) => result.id),
    );
  });

  it('ignores a collaborator that is not of the expected shape', () => {
    const tolerant = createHealthSurface({
      logger,
      metrics,
      storage: undefined,
      storageProbe: undefined,
      pointerProbe: undefined,
      webglProbe: undefined,
    });

    expect(tolerant.check().checks).toHaveLength(HEALTH_CHECK_COUNT);
  });
});


// CROSS-MODULE, on purpose. Every case above verifies this surface in
// isolation, and isolation is exactly what let the three-state status be lost
// at the boundary: the compatibility reader collapsed `not-applicable` into a
// boolean, and the panel that consumed the boolean showed a pass.

describe('the health panel rendered from a real surface', () => {
  let host: HTMLElement;
  let overlay: DiagnosticsOverlay | null = null;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    overlay?.destroy();
    overlay = null;
    host.remove();
  });

  /**
   * Builds an overlay over one health source, sharing this suite's registry so
   * the gauges the panel writes are the gauges asserted on.
   *
   * @param health The source: a probe reader or the surface itself.
   * @returns The mounted, opened overlay.
   */
  const openOverlay = (health: HealthSource): DiagnosticsOverlay => {
    const built = createDiagnosticsOverlay({
      metrics,
      logger,
      host,
      document,
      health,

      // Rendered on demand: no scheduled refresh, so nothing races the
      // assertions below.
      refreshIntervalMs: 0,
    });

    overlay = built;
    built.mount();
    built.open();

    return built;
  };

  /** The panel text, whitespace collapsed. */
  const panelText = (): string => (host.textContent ?? '').replace(/\s+/g, ' ');

  it('renders the third state as itself when read through the compatibility reader', () => {
    vi.stubGlobal('Element', undefined);

    const mixed = createHealthSurface({
      logger,
      metrics,
      webglProbe: NO_CONTEXT_PROBE,
    });
    const built = openOverlay(mixed.probeReader());
    const health = built.snapshot().health;
    const row = health.checks.find((entry) => entry.id === CLASS_LIST);

    expect(row?.status).toBe(NOT_APPLICABLE);
    expect(panelText()).toContain(NOT_APPLICABLE);
    expect(health.counts[NOT_APPLICABLE]).toBeGreaterThan(0);

    // And the exported gauge agrees with the rendered row.
    expect(readHealthGauges(metrics).get(CLASS_LIST)).toBe(
      HEALTH_GAUGE_VALUES[NOT_APPLICABLE],
    );
  });

  it('reconciles every rendered row with the gauge exported for it', () => {
    vi.stubGlobal('Element', undefined);

    const mixed = createHealthSurface({
      logger,
      metrics,
      webglProbe: NO_CONTEXT_PROBE,
    });
    const built = openOverlay(mixed.probeReader());
    const health = built.snapshot().health;
    const gauges = readHealthGauges(metrics);

    expect(health.checks).toHaveLength(HEALTH_CHECK_COUNT);

    for (const row of health.checks) {
      expect(gauges.get(row.id), `no gauge for "${row.id}"`).toBe(
        HEALTH_GAUGE_VALUES[row.status],
      );
    }
  });

  it('carries the report and the readiness verdicts when given the surface itself', () => {
    const built = openOverlay(surface);
    const health = built.snapshot().health;

    expect(health.report).not.toBeNull();
    expect(health.readiness).not.toBeNull();
    expect(health.report?.checks).toHaveLength(HEALTH_CHECK_COUNT);
    expect(health.status).toBe(health.report?.status);
    expect(panelText()).toContain('ready');

    const gauges = readHealthGauges(metrics);

    for (const row of health.checks) {
      expect(gauges.get(row.id)).toBe(HEALTH_GAUGE_VALUES[row.status]);
    }
  });

  it('writes a gauge for a check the source did not report at all', () => {
    // A partial source: one row, five checks unreported.
    const built = openOverlay(
      (): readonly HealthCheckResultView[] => [
        { name: WEBGL, status: FAIL, healthy: false, detail: 'no context' },
      ],
    );
    const health = built.snapshot().health;
    const gauges = readHealthGauges(metrics);

    expect(health.checks).toHaveLength(HEALTH_CHECK_COUNT);
    expect(gauges.size).toBe(HEALTH_CHECK_COUNT);
    expect(gauges.get(WEBGL)).toBe(HEALTH_GAUGE_VALUES[FAIL]);

    for (const id of HEALTH_CHECK_IDS) {
      if (id === WEBGL) {
        continue;
      }

      expect(gauges.get(id), `no gauge for unreported "${id}"`).toBe(
        HEALTH_GAUGE_VALUES[NOT_APPLICABLE],
      );
    }
  });

  it('still reads a boolean-only provider, which cannot express the third state', () => {
    const built = openOverlay(
      (): readonly HealthCheckResultView[] =>
        HEALTH_CHECK_IDS.map((id) => ({
          name: id,
          healthy: id !== WEBGL,
          detail: 'legacy provider',
        })),
    );
    const health = built.snapshot().health;

    expect(health.checks.find((row) => row.id === WEBGL)?.status).toBe(FAIL);
    expect(health.checks.find((row) => row.id === FUNCTION_BIND)?.status).toBe(
      PASS,
    );
    expect(health.counts[NOT_APPLICABLE]).toBe(0);
  });
});


// Leak audit: this suite leaves the host as it found it

describe('forget: the correlation boundary of a held report', () => {
  it('drops the held report so the next reader re-probes', () => {
    let probes = 0;
    const surface = createHealthSurface({
      storageProbe: (): StorageProbeView => {
        probes += 1;

        return { supported: true, strategy: 'localStorage' };
      },
    });

    surface.check();

    const held = surface.lastReport();
    const afterFirst = probes;

    expect(held).not.toBeNull();

    // A `report()` before the drop answers from the held reading and probes
    // nothing further.
    surface.report();

    expect(probes).toBe(afterFirst);
    expect(surface.forget()).toBe(true);
    expect(surface.lastReport()).toBeNull();

    // And after it, the next reader takes a fresh reading — which is what stops
    // a report taken under one run being answered under the next run's
    // identifier.
    const refreshed = surface.report();

    expect(probes).toBeGreaterThan(afterFirst);
    expect(refreshed).not.toBe(held);
    expect(refreshed.checks).toHaveLength(HEALTH_CHECK_COUNT);
  });

  it('reports nothing dropped on a surface that has never been checked', () => {
    const surface = createHealthSurface();

    expect(surface.forget()).toBe(false);
    expect(surface.lastReport()).toBeNull();
  });

  it('keeps the probes and the subscribers, so it discards a reading and not a capability', () => {
    const reports: HealthReport[] = [];
    const surface = createHealthSurface({
      storageProbe: (): StorageProbeView => ({
        supported: true,
        strategy: 'localStorage',
      }),
    });

    surface.subscribe((report) => {
      reports.push(report);
    });

    surface.check();
    surface.forget();

    // NOT NOTIFIED by the drop: nothing has been checked to notify of.
    expect(reports).toHaveLength(1);

    surface.check();

    expect(reports).toHaveLength(2);
    expect(reports[1].checks).toHaveLength(HEALTH_CHECK_COUNT);
  });

  it('leaves readiness derivable, from a fresh reading', () => {
    const surface = createHealthSurface({
      storageProbe: (): StorageProbeView => ({
        supported: true,
        strategy: 'localStorage',
      }),
      webglProbe: (): WebGLProbeView => ({ supported: true, level: 'webgl2' }),
    });

    const before: ReadinessReport = surface.readiness();

    expect(before.ready).toBe(true);
    surface.forget();

    const after: ReadinessReport = surface.readiness();

    expect(after.ready).toBe(true);
    expect(after.renderer).toBe('webgl');
  });
});

describe('isolation from the suites that follow', () => {
  it('leaves the five stubbed globals at their original references', () => {
    // The stubs this suite installs are Element, cancelAnimationFrame and
    // localStorage; every one is restored before this test runs.
    expect(Function.prototype.bind).toBe(ORIGINAL_BIND);
    expect(window.requestAnimationFrame).toBe(ORIGINAL_REQUEST_ANIMATION_FRAME);
    expect(window.cancelAnimationFrame).toBe(ORIGINAL_CANCEL_ANIMATION_FRAME);
    expect(window.Element).toBe(ORIGINAL_ELEMENT);

    const view = window.navigator as Navigator & {
      msPointerEnabled?: boolean;
    };

    expect(view.msPointerEnabled).toBe(ORIGINAL_MS_POINTER_ENABLED);
  });

  it('leaves the global store writable and free of the product keys', () => {
    // No member of js/local_storage_manager.js removed the best score, and no
    // member of the port does either; the teardown above removes it.
    expect(storageModule.probeWebStorage().supported).toBe(true);
    expect(window.localStorage.getItem(BEST_SCORE_KEY)).toBeNull();
    expect(window.localStorage.getItem(GAME_STATE_KEY)).toBeNull();
    expect(window.localStorage.getItem(STORAGE_PROBE_KEY)).toBeNull();

    for (const key of OWNED_STORAGE_KEYS) {
      expect(window.localStorage.getItem(key), `${key} leaked`).toBeNull();
    }
  });

  it('leaves the WebGL probe reporting this environment, not a stub', () => {
    const support = webglModule.probeWebGLSupport();

    expect(support.supported).toBe(false);
    expect(support.level).toBe('none');
  });

  it('removes a seeded best score in teardown', () => {
    // Seeded, then swept, within one test: the sweep is the same one
    // `afterEach` runs for every test in this file.
    window.localStorage.setItem(BEST_SCORE_KEY, '4096');
    window.localStorage.setItem(GAME_STATE_KEY, '{}');

    expect(window.localStorage.getItem(BEST_SCORE_KEY)).toBe('4096');

    clearProductStorage();

    expect(window.localStorage.getItem(BEST_SCORE_KEY)).toBeNull();
    expect(window.localStorage.getItem(GAME_STATE_KEY)).toBeNull();
  });
});

describe('a settings argument that is not an object', () => {
  it('constructs from an explicit null as it does from no argument', () => {
    // A default parameter stands in for `undefined` ALONE, so an explicit
    // `null` reached the collaborator reads and raised out of construction.
    const surface = createHealthSurface(null as never);

    expect(surface.check().checks).toHaveLength(HEALTH_CHECK_COUNT);
    expect(new HealthSurface(null as never).report().checks).toHaveLength(
      HEALTH_CHECK_COUNT,
    );
  });

  it('runs every member handed an explicit null', () => {
    const surface = createHealthSurface();

    expect(surface.check(null as never).checks).toHaveLength(
      HEALTH_CHECK_COUNT,
    );
    expect(surface.report(null as never).checks).toHaveLength(
      HEALTH_CHECK_COUNT,
    );
    expect(surface.checkOne('storage', null as never)).toBeDefined();
    expect(surface.readiness(null as never)).toBeDefined();
    expect(surface.probeReader(null as never)()).toHaveLength(
      HEALTH_CHECK_COUNT,
    );
  });

  it('runs every member handed a value of the wrong kind', () => {
    const surface = createHealthSurface();

    for (const bag of ['refresh', 42, true, Symbol('bag')]) {
      expect(surface.check(bag as never).checks).toHaveLength(
        HEALTH_CHECK_COUNT,
      );
      expect(surface.readiness(bag as never)).toBeDefined();
    }
  });

  it('contains a settings bag whose read raises', () => {
    const hostile = new Proxy(
      {},
      {
        get(): never {
          throw new Error('settings read trap');
        },
      },
    );
    const surface = createHealthSurface();

    expect(surface.check(hostile as never).checks).toHaveLength(
      HEALTH_CHECK_COUNT,
    );
    expect(surface.report(hostile as never).status).toBeDefined();
    expect(surface.readiness(hostile as never)).toBeDefined();
  });

  it('still honours a refresh a well-formed bag asks for', () => {
    // The normalisation must not swallow the one setting the type declares.
    let probes = 0;
    const surface = createHealthSurface({
      storageProbe: (): StorageProbeView => {
        probes += 1;

        return { supported: true, strategy: 'localStorage' };
      },
    });

    surface.check();

    const afterFirst = probes;

    surface.check({ refresh: true });

    expect(probes).toBeGreaterThan(afterFirst);
  });
});
