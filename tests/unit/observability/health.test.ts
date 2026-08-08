// Unit suite over src/observability/health.ts: the six capability checks, the
// three-state check status, the report roll-up and the two readiness verdicts.
//
// Validation gate V8 bullet 4 — "Health reports all six checks: the five
// capability probes the product already performs but never reports, plus the
// new WebGL probe" — is measured here. Implicit requirement I6's non-WebGL
// fallback path is exercised here and nowhere else automatically.
//
// Provenance of the five reused probes, from the deleted vanilla sources, in
// HEALTH_CHECK_IDS order:
//   functionBind           js/bind_polyfill.js L1
//   classList              js/classlist_polyfill.js L2-L5
//   requestAnimationFrame  js/animframe_polyfill.js L3-L10 and L23
//   pointerEvents          js/keyboard_input_manager.js L4-L13
//   storage                js/local_storage_manager.js L29-L40
// The sixth check, webgl, has no vanilla origin.
//
// The storage strategy is fixed once, at construction:
// js/local_storage_manager.js L26,
// `this.storage = supported ? window.localStorage : window.fakeStorage`.
//
// docs/TRACEABILITY_MATRIX.md rows this suite is the executable evidence for:
// TR-HEALTH-01 through TR-HEALTH-06. Each `describe` below is named after the
// HealthCheckId it covers, so a matrix reader locates the proof by id.
//
// Decisions behind this file: DL-HEALTH-TEST-01, the WebGL probe's negative
// branch as the fixture over a mocked positive one; DL-HEALTH-TEST-02, the
// unit boundary of this suite. Both are in docs/DECISION_LOG.md.
//
// Subject: src/observability/health.ts.
// src/observability/diagnostics-overlay.ts is not exercised here.
//
// Imports are `vitest` and the modules under test. No DOM library is named:
// vitest.config.ts selects the environment, and every assertion below reads a
// capability rather than an implementation. `three` is not imported, matching
// src/render/webgl-support.ts, which imports nothing.

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

/* ==========================================================================
 * 1. Status and identity constants, named through the imported unions
 * ========================================================================== */

// Typed through the imported union: a renamed member is a compile error here.
// Every status assertion below names one of these three and negates none.
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

/* ==========================================================================
 * 2. Local doubles, built without a mocking library
 * ========================================================================== */

/**
 * A `StorageLike` whose `setItem` throws the quota rejection a full store
 * raises. Drives the supported-but-write-failed branch of the reused
 * writability probe.
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
 * A `Logger` whose every emitting member throws, and whose `child()` returns
 * itself so the surface's own child is faulty too.
 *
 * Built as an object literal rather than by spying, because `createLogger`
 * returns a logger whose members are not redefinable.
 *
 * @returns The logger. The non-emitting members delegate to a real logger, so
 *   the correlation identifier and the level behave normally.
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
 * Read from the snapshot rather than through `MetricsRegistry.gauge()`,
 * because that accessor creates a series it does not find and would
 * therefore report every id as present.
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
 * Typed `unknown` so every assertion against it states the type it expects.
 *
 * @param result Result to read.
 * @param key Member to read.
 * @returns The value, or `undefined` when the bag carries no such member.
 */
function readData(result: HealthCheckResult, key: string): unknown {
  return result.data[key];
}

/* ==========================================================================
 * 3. Captured originals and per-test wiring
 * ========================================================================== */

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

/**
 * Removes every storage key the product owns, plus the probe key.
 *
 * `OWNED_STORAGE_KEYS` carries the durable keys; `STORAGE_PROBE_KEY` is
 * absent from that list because the probe removes its own key, and is swept
 * here so a probe interrupted mid-round-trip leaves nothing behind. No
 * literal key name appears at this call site.
 */
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
      // A store that refuses removal is a case under test; the sweep
      // continues to the remaining keys.
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

/* ==========================================================================
 * 4. All six checks are reported — validation gate V8 bullet 4
 * ========================================================================== */

describe('the six-check contract', () => {
  it('declares six check ids, each one distinct', () => {
    // Derived from the exported tuple; a seventh probe or a renamed id
    // changes this expectation.
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

    // A reused check cites the vanilla line it came from; the added one has
    // no vanilla origin to cite.
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

/* ==========================================================================
 * 5. One block per HealthCheckId, in HEALTH_CHECK_IDS order
 * ========================================================================== */

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
    // The two preconditions of the expectation below: the host offers
    // Element, and the capability is native.
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
    expect(result.status).not.toBe(FAIL);
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

    // The three selected names travel in the report, not a bare boolean.
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
    // Resolved by the owning module, from a navigator-like carrying the flag.
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
    expect(result.status).not.toBe(FAIL);
    expect(readData(result, 'supported')).toBe(false);
    expect(readData(result, 'errorName')).toBeUndefined();
  });

  it('names src/storage/local-storage-manager.ts as the probe owner', () => {
    const result = surface.checkOne(STORAGE);

    expect(result.source.owner).toBe('src/storage/local-storage-manager.ts');
    expect(result.source.performedBy).toBe('probeWebStorage');
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


/* ==========================================================================
 * 6. The reuse is real, asserted by wiring rather than by outcome
 * ========================================================================== */

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
    // The reused probe writes STORAGE_PROBE_KEY and removes it again, so
    // the key is absent once the check has run.
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


/* ==========================================================================
 * 7. HealthStatus has three states, and the report roll-up over them
 * ========================================================================== */

describe('the three-state check status', () => {
  it('names three distinct states', () => {
    expect(new Set([PASS, FAIL, NOT_APPLICABLE]).size).toBe(3);
    expect(HEALTH_GAUGE_VALUES[PASS]).toBe(1);
    expect(HEALTH_GAUGE_VALUES[FAIL]).toBe(0);
    expect(HEALTH_GAUGE_VALUES[NOT_APPLICABLE]).toBe(-1);
  });

  it('observes pass, fail and not-applicable within one report', () => {
    // js/classlist_polyfill.js L2-L3 is one `if` whose two conditions mean
    // opposite things: an absent Element is the no-DOM bail-out, and a
    // refused write is a genuine failure.
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
    // The documented rule: a failure dominates; otherwise a pass; otherwise
    // every check was inapplicable.
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

      // A live context, so every check passes.
      createHealthSurface({
        logger,
        metrics,
        webglProbe: (): WebGLProbeView => ({
          supported: true,
          level: 'webgl',
        }),
      }),

      // Two failures rather than one.
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

/* ==========================================================================
 * 8. The WebGL negative branch and the number-only fallback (I6)
 * ========================================================================== */

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

    // The renderer decision.
    expect(verdicts.renderer).toBe('number-only');

    // And, in the same report, which store is live.
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


/* ==========================================================================
 * 9. The storage strategy in the readiness verdict, both branches
 * ========================================================================== */

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
});

/* ==========================================================================
 * 10. The report lifecycle
 * ========================================================================== */

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

    // Calling the handle again is a no-op rather than an error.
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

  it('are produced on every call of a bound reader', () => {
    const read = surface.probeReader();

    expect(read()).toHaveLength(HEALTH_CHECK_COUNT);
    expect(read()).toHaveLength(HEALTH_CHECK_COUNT);
    expect(surface.lastReport()).not.toBeNull();
  });
});


/* ==========================================================================
 * 11. Every result is reported: one status gauge and one log record
 * ========================================================================== */

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

    // Three distinct values on one family: the inapplicable case is not
    // written as the failing one.
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

    // One contained throw per check: reporting failed, the checks did not.
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

/* ==========================================================================
 * 12. Construction, and the state a surface holds before it is used
 * ========================================================================== */

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


/* ==========================================================================
 * 13. Leak audit: this suite leaves the host as it found it
 * ========================================================================== */

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
    // No member of js/local_storage_manager.js removed the best score, and
    // no member of the port does either; the teardown above removes it.
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

