// Health and readiness for the observability layer: the six capability checks,
// the report roll-up, the two readiness verdicts, the per-check logger record
// and the per-check status gauge.
//
// Five checks are reused from the vanilla sources and one is added. Where each
// came from, and where it is performed now.
//
// js/bind_polyfill.js, js/classlist_polyfill.js and js/animframe_polyfill.js
// are deleted with no code replacement, and their three probe constructs are
// traced to this module.
//
// Decisions: DL-HEALTH-01, DL-HEALTH-02, DL-HEALTH-03, DL-HEALTH-04,
// DL-HEALTH-05, DL-HEALTH-06 (docs/DECISION_LOG.md).

import { createLogger, serializeError } from './logger';
import type {
  LogFieldValue,
  LogFields,
  Logger,
  SerializedError,
} from './logger';
import { METRIC_LABELS, METRIC_NAMES, createMetricsRegistry } from './metrics';
import type { MetricsRegistry } from './metrics';
import { detectPointerEventFamily } from '../input/touch-input';
import { probeWebStorage } from '../storage/local-storage-manager';
import { probeWebGLSupport } from '../render/webgl-support';

/**
 * The six checks, in report order: the three reused probes performed here, the
 * two reused probes imported from the modules that own them, then the added
 * one.
 *
 * Frozen, and the single declaration of the names. The same strings are the
 * `check` label of the status gauge and the probe names the diagnostics health
 * panel renders.
 */
export const HEALTH_CHECK_IDS = Object.freeze([
  'functionBind',
  'classList',
  'requestAnimationFrame',
  'pointerEvents',
  'storage',
  'webgl',
] as const);

/** One of the six checks. Six, no more and no fewer. */
export type HealthCheckId = (typeof HEALTH_CHECK_IDS)[number];

/** How many checks a report carries. */
export const HEALTH_CHECK_COUNT = HEALTH_CHECK_IDS.length;

/** Outcome of one check. */
export type HealthStatus = 'pass' | 'fail' | 'not-applicable';

/** Value the status gauge carries for each status. */
export const HEALTH_GAUGE_VALUES: Readonly<Record<HealthStatus, number>> =
  Object.freeze({
    pass: 1,
    fail: 0,
    'not-applicable': -1,
  });

/**
 * Reports whether `value` is one of the six check ids.
 *
 * @param value Value to test.
 * @returns `true` for a member of `HEALTH_CHECK_IDS`.
 */
export function isHealthCheckId(value: unknown): value is HealthCheckId {
  return (
    typeof value === 'string' &&
    (HEALTH_CHECK_IDS as readonly string[]).includes(value)
  );
}

/** Whether a check was reused from the vanilla sources or added. */
export type HealthCheckDisposition = 'reused' | 'added';

/** Where one check came from and where it is performed now. */
export interface HealthCheckSource {
  /**
   * Path and line span of the vanilla probe this check reuses, and `null` for
   * the added check, which has no vanilla origin.
   */
  readonly origin: string | null;

  /** Module that performs the probe now. */
  readonly owner: string;

  /**
   * Symbol the owning module exports for the probe, and `null` where the probe
   * is performed inline in the owner.
   */
  readonly performedBy: string | null;

  readonly disposition: HealthCheckDisposition;
}

/** Module path this file is reached by, as a `HealthCheckSource.owner`. */
const THIS_MODULE = 'src/observability/health.ts';

/**
 * Provenance of every check. Frozen, and the single declaration of each
 * citation.
 */
export const HEALTH_CHECK_SOURCES: Readonly<
  Record<HealthCheckId, HealthCheckSource>
> = Object.freeze({
  functionBind: Object.freeze({
    origin: 'js/bind_polyfill.js L1',
    owner: THIS_MODULE,
    performedBy: null,
    disposition: 'reused',
  }),
  classList: Object.freeze({
    origin: 'js/classlist_polyfill.js L2-L5',
    owner: THIS_MODULE,
    performedBy: null,
    disposition: 'reused',
  }),
  requestAnimationFrame: Object.freeze({
    origin: 'js/animframe_polyfill.js L3-L10 and L23',
    owner: THIS_MODULE,
    performedBy: null,
    disposition: 'reused',
  }),
  pointerEvents: Object.freeze({
    origin: 'js/keyboard_input_manager.js L4-L13',
    owner: 'src/input/touch-input.ts',
    performedBy: 'detectPointerEventFamily',
    disposition: 'reused',
  }),
  storage: Object.freeze({
    origin: 'js/local_storage_manager.js L29-L40',
    owner: 'src/storage/local-storage-manager.ts',
    performedBy: 'probeWebStorage',
    disposition: 'reused',
  }),
  webgl: Object.freeze({
    origin: null,
    owner: 'src/render/webgl-support.ts',
    performedBy: 'probeWebGLSupport',
    disposition: 'added',
  }),
});

/**
 * The structured detail one check result carries: the resolved pointer event
 * names, the live storage strategy, the WebGL level, and the presence flags
 * each probe read.
 *
 * Typed as log field values, so a result's own bag reaches the logger without
 * conversion, and every value survives `JSON.stringify` unchanged.
 */
export type HealthCheckData = Readonly<Record<string, LogFieldValue>>;

/** One check's outcome. Plain JSON data throughout. */
export interface HealthCheckResult {
  readonly id: HealthCheckId;
  readonly status: HealthStatus;

  /** One short sentence describing what was observed. */
  readonly detail: string;

  /** What the probe read, keyed by name. */
  readonly data: HealthCheckData;

  /** Where the probe came from and where it is performed now. */
  readonly source: HealthCheckSource;

  /** Milliseconds the probe took, never negative. */
  readonly durationMs: number;

  /**
   * The value the probe threw, serialised. Present only on a `'fail'` a throw
   * produced; a probe that answered `'fail'` without throwing carries none.
   */
  readonly error?: SerializedError;
}

/**
 * A whole health report. Plain JSON data throughout: the object round-trips
 * through `JSON.parse(JSON.stringify(report))` unchanged.
 */
export interface HealthReport {
  /** The roll-up over `checks`. */
  readonly status: HealthStatus;

  /** Every check, one per `HEALTH_CHECK_IDS` member, in that order. */
  readonly checks: readonly HealthCheckResult[];

  /** How many results carry each status. */
  readonly counts: Readonly<Record<HealthStatus, number>>;

  /** Correlation identifier of the run, carried by every record too. */
  readonly correlationId: string;

  /** Wall-clock time the report was completed, ISO 8601. */
  readonly timestamp: string;

  /** Milliseconds every probe took together, never negative. */
  readonly durationMs: number;
}

/**
 * Which board renderer the WebGL verdict permits: the Three.js renderer, or
 * the number-only renderer, which is also the non-WebGL fallback.
 */
export type RendererReadiness = 'webgl' | 'number-only';

/**
 * Whether the live store survives a reload. `'persistent'` is real Web
 * Storage.
 */
export type StorageReadiness = 'persistent' | 'ephemeral';

/**
 * The consequential half of the surface: what a consumer acts on, derived from
 * the latest check results.
 *
 * Health is what an operator inspects; readiness is what src/main.ts reads to
 * decide which renderer to mount and what to expect of persistence.
 */
export interface ReadinessReport {
  /**
   * Whether every readiness-critical capability is present: the renderer
   * verdict is `'webgl'` and the storage verdict is `'persistent'`. A build is
   * playable when this is `false` — the fallbacks are the product's own — so
   * it is a readiness statement and not a liveness one.
   */
  readonly ready: boolean;

  /** Renderer the WebGL check permits. */
  readonly renderer: RendererReadiness;

  /** Whether the Three.js renderer may be mounted. */
  readonly mayMountWebGLRenderer: boolean;

  /** Whether the number-only renderer is required instead. */
  readonly requiresNumberOnlyFallback: boolean;

  /** Context level obtained: `'webgl2'`, `'webgl'` or `'none'`. */
  readonly webglLevel: string;

  /** What prevented a context from being obtained, absent when one was. */
  readonly webglFailure?: string;

  /**
   * Whether the live store survives a reload. `'persistent'` requires BOTH
   * that the strategy names Web Storage and that the storage check passed.
   */
  readonly storage: StorageReadiness;

  /** The live strategy, as the storage layer names it. */
  readonly storageStrategy: string;

  /** Status of the two checks the verdicts are derived from. */
  readonly webglStatus: HealthStatus;
  readonly storageStatus: HealthStatus;

  /** Roll-up of the report the verdicts were derived from. */
  readonly healthStatus: HealthStatus;

  readonly correlationId: string;

  /** Wall-clock time the verdicts were derived, ISO 8601. */
  readonly timestamp: string;
}

/** The members this module reads off a resolved pointer event family. */
export interface PointerFamilyView {
  /**
   * Which branch the owner took, as it reports it on the resolved family. Read
   * from that result.
   */
  readonly msPointerEnabled: boolean;

  readonly touchstart: string;
  readonly touchmove: string;
  readonly touchend: string;
}

/**
 * The pointer-family probe. Defaults to `detectPointerEventFamily` from
 * src/input/touch-input.ts, which is the reused probe itself and not a
 * reimplementation of it.
 */
export type PointerFamilyProbe = () => PointerFamilyView;

/** The members this module reads off a storage error description. */
export interface StorageErrorView {
  readonly name: string;
  readonly message: string;
  readonly quota: boolean;
}

/**
 * The members this module reads off a Web Storage probe result. A
 * `StorageProbeResult` satisfies it as it stands.
 */
export interface StorageProbeView {
  readonly supported: boolean;

  /** `'localStorage'`, `'memory'` or `'injected'`. */
  readonly strategy: string;

  /** Present only where the probe caught a throw. */
  readonly error?: StorageErrorView;
}

/**
 * The Web Storage probe. Defaults to `probeWebStorage` from
 * src/storage/local-storage-manager.ts, which owns the write-and-remove round
 * trip and the `STORAGE_PROBE_KEY` it writes.
 */
export type StorageProbe = () => StorageProbeView;

/**
 * The two cached members this module reads off a live storage manager. A
 * `LocalStorageManager` satisfies it as it stands.
 *
 * Supplying one is what keeps the probe from being repeated: the manager ran
 * it once at construction and holds the result.
 */
export interface StorageStateView {
  /** The manager's construction-time probe result. */
  readonly probe: StorageProbeView;

  /** The store actually in use, which may be `'injected'`. */
  readonly strategy: string;
}

/**
 * The members this module reads off a WebGL support probe result. A
 * `WebGLSupportResult` satisfies it as it stands.
 */
export interface WebGLProbeView {
  readonly supported: boolean;

  /** `'webgl2'`, `'webgl'` or `'none'`. */
  readonly level: string;

  /** What prevented a context from being obtained. */
  readonly failure?: string;

  /** Human-readable form of `failure`. */
  readonly reason?: string;

  /** How the probe context was or was not released. */
  readonly contextRelease?: string;
}

/**
 * The WebGL probe. Defaults to `probeWebGLSupport` from
 * src/render/webgl-support.ts, which owns the context request, the release and
 * the held result.
 */
export type WebGLProbe = () => WebGLProbeView;

const WEBGL_NO_DOCUMENT = 'no-document';

/** `StorageProbeView.strategy` of a store supplied by the caller. */
const INJECTED_STRATEGY = 'injected';

/** `StorageProbeView.strategy` of real Web Storage. */
const WEB_STORAGE_STRATEGY = 'localStorage';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPointerFamilyView(value: unknown): value is PointerFamilyView {
  return (
    isRecord(value) &&
    typeof value.msPointerEnabled === 'boolean' &&
    isNonEmptyString(value.touchstart) &&
    isNonEmptyString(value.touchmove) &&
    isNonEmptyString(value.touchend)
  );
}

function isStorageProbeView(value: unknown): value is StorageProbeView {
  return (
    isRecord(value) &&
    typeof value.supported === 'boolean' &&
    typeof value.strategy === 'string'
  );
}

function isStorageStateView(value: unknown): value is StorageStateView {
  return (
    isRecord(value) &&
    typeof value.strategy === 'string' &&
    isStorageProbeView(value.probe)
  );
}

function isWebGLProbeView(value: unknown): value is WebGLProbeView {
  return (
    isRecord(value) &&
    typeof value.supported === 'boolean' &&
    typeof value.level === 'string'
  );
}

/**
 * Reduces a settings bag to one this module can read from.
 *
 * @param options The supplied bag, whatever it is.
 * @returns The bag, or an empty one.
 */
function settingsOf<T extends object>(options: T): T {
  return isRecord(options) ? options : ({} as T);
}

/**
 * Reads the one member `HealthCheckOptions` carries.
 *
 * @param options The supplied bag, whatever it is.
 * @returns Whether the held Web Storage result is to be discarded.
 */
function refreshRequested(options: HealthCheckOptions): boolean {
  if (!isRecord(options)) {
    return false;
  }

  try {
    return options.refresh === true;
  } catch {
    return false;
  }
}

/**
 * Reads a monotonic clock, matching the guarded idiom
 * src/observability/metrics.ts uses.
 *
 * @returns `performance.now` where it is readable, otherwise `Date.now`, and
 *   `0` where neither can be read.
 */
function monotonicNow(): number {
  try {
    const clock: unknown = globalThis.performance;

    if (isRecord(clock)) {
      const now: unknown = clock.now;

      if (typeof now === 'function') {
        const reading: unknown = (now as () => unknown).call(clock);

        if (typeof reading === 'number' && Number.isFinite(reading)) {
          return reading;
        }
      }
    }

    const fallback = Date.now();

    return Number.isFinite(fallback) ? fallback : 0;
  } catch {
    return 0;
  }
}

/**
 * @param startedAt Reading `monotonicNow` returned before the work.
 * @returns Milliseconds elapsed, clamped at zero so a clock that went
 *   backwards or could not be read never yields a negative duration.
 */
function elapsedSince(startedAt: number): number {
  const elapsed = monotonicNow() - startedAt;

  return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
}

/**
 * @returns The wall clock as ISO 8601, or the empty string where it could
 *   not be read.
 */
function readTimestamp(): string {
  try {
    return new Date().toISOString();
  } catch {
    return '';
  }
}

/**
 * Ends a fragment with a single full stop.
 *
 * @param text Fragment to close.
 * @returns `text` with one trailing full stop and no doubled one.
 */
function asSentence(text: string): string {
  return text.endsWith('.') ? text : `${text}.`;
}

/** What one probe observed, before timing and provenance are attached. */
interface ProbeOutcome {
  readonly status: HealthStatus;
  readonly detail: string;
  readonly data: HealthCheckData;
}

function outcome(
  status: HealthStatus,
  detail: string,
  data: HealthCheckData,
): ProbeOutcome {
  return { status, detail, data };
}

/**
 * Check 1, `functionBind`.
 *
 * @returns `'pass'` when the method is present, `'fail'` when it is not.
 *   Never `'not-applicable'`.
 */
function probeFunctionBind(): ProbeOutcome {
  const bound: unknown = Function.prototype.bind;
  const present = typeof bound === 'function';

  return outcome(
    present ? 'pass' : 'fail',
    present
      ? 'Function.prototype.bind is present.'
      : 'Function.prototype.bind is absent.',
    { present },
  );
}

/**
 * Check 2, `classList`.
 *
 * @returns `'pass'` or `'fail'` from the support signal, and
 *   `'not-applicable'` where there is no host object to read it from.
 */
function probeClassList(): ProbeOutcome {
  if (typeof window === 'undefined') {
    return outcome('not-applicable', 'No window is present.', {
      window: false,
    });
  }

  if (typeof Element === 'undefined') {
    return outcome('not-applicable', 'window.Element is undefined.', {
      window: true,
      element: false,
    });
  }

  if (typeof document === 'undefined') {
    return outcome('not-applicable', 'No document is present.', {
      window: true,
      element: true,
      document: false,
    });
  }

  const root: unknown = document.documentElement;

  if (!isRecord(root)) {
    return outcome(
      'not-applicable',
      'document.documentElement is not readable.',
      { window: true, element: true, document: true, documentElement: false },
    );
  }

  const supported = 'classList' in root;

  return outcome(
    supported ? 'pass' : 'fail',
    supported
      ? 'classList is present on document.documentElement.'
      : 'classList is absent from document.documentElement.',
    {
      window: true,
      element: true,
      document: true,
      documentElement: true,
      classList: supported,
    },
  );
}

/**
 * Check 3, `requestAnimationFrame`.
 *
 * @returns `'pass'` when both are callable, `'fail'` when either is missing,
 *   and `'not-applicable'` where there is no window to read.
 */
function probeAnimationFrame(): ProbeOutcome {
  if (typeof window === 'undefined') {
    return outcome('not-applicable', 'No window is present.', {
      window: false,
    });
  }

  const request = typeof window.requestAnimationFrame === 'function';
  const cancel = typeof window.cancelAnimationFrame === 'function';
  const supported = request && cancel;

  return outcome(
    supported ? 'pass' : 'fail',
    supported
      ? 'requestAnimationFrame and cancelAnimationFrame are present.'
      : `requestAnimationFrame is ${request ? 'present' : 'absent'} and ` +
          `cancelAnimationFrame is ${cancel ? 'present' : 'absent'}.`,
    {
      window: true,
      requestAnimationFrame: request,
      cancelAnimationFrame: cancel,
    },
  );
}

/**
 * Check 4, `pointerEvents`.
 *
 * @param probe The owning module's family probe.
 * @returns `'pass'` with the three resolved names, and `'fail'` where the
 *   probe returned no usable family. The absence of a window is not a failure:
 *   the owner resolves the standard touch family there, which is the branch
 *   the original took when the flag was falsy.
 */
function probePointerEvents(probe: PointerFamilyProbe): ProbeOutcome {
  const family: unknown = probe();

  if (!isPointerFamilyView(family)) {
    return outcome(
      'fail',
      'The pointer-family probe resolved no usable family.',
      { resolved: false },
    );
  }

  const detail =
    `Pointer events resolve to ${family.touchstart}, ` +
    `${family.touchmove} and ${family.touchend}.`;

  // Every member below is read off the family the owner returned, the branch
  // flag included.
  return outcome('pass', detail, {
    resolved: true,
    msPointerEnabled: family.msPointerEnabled,
    touchstart: family.touchstart,
    touchmove: family.touchmove,
    touchend: family.touchend,
  });
}

/**
 * Check 5, `storage`.
 *
 * @param view The probe result and the live strategy.
 * @returns `'pass'` where a store is in use, `'fail'` where the probe caught
 *   a throw, and `'not-applicable'` where no global store exists at all, which
 *   the probe reports as an unsupported result carrying no error.
 */
function evaluateStorage(view: StorageStateView): ProbeOutcome {
  const probeResult = view.probe;
  const error = probeResult.error;
  const data: Record<string, LogFieldValue> = {
    supported: probeResult.supported,
    strategy: view.strategy,
    probeStrategy: probeResult.strategy,
  };

  if (isRecord(error)) {
    data.errorName = isNonEmptyString(error.name) ? error.name : '';
    data.quotaExceeded = error.quota === true;
  }

  if (view.strategy === INJECTED_STRATEGY) {
    return outcome(
      'pass',
      'A caller-supplied store is in use.',
      data,
    );
  }

  if (probeResult.supported) {
    return outcome('pass', 'Web Storage is writable.', data);
  }

  if (isRecord(error)) {
    const name = isNonEmptyString(error.name) ? error.name : 'an error';

    return outcome(
      'fail',
      `Web Storage is not writable: ${name}. The in-memory store is in ` +
        'use.',
      data,
    );
  }

  return outcome(
    'not-applicable',
    'No Web Storage is present. The in-memory store is in use.',
    data,
  );
}

/**
 * Check 6, `webgl`. the added check; it has no vanilla origin.
 *
 * @param probe The owning module's support probe.
 * @returns `'pass'` where a context was obtained, `'not-applicable'` where
 *   there was no document to create a probe canvas in, and `'fail'` for every
 *   other outcome, the probe returning nothing usable included.
 */
function evaluateWebGL(probe: WebGLProbe): ProbeOutcome {
  const support: unknown = probe();

  if (!isWebGLProbeView(support)) {
    return outcome('fail', 'The WebGL probe returned no usable result.', {
      supported: false,
      level: 'none',
    });
  }

  const data: Record<string, LogFieldValue> = {
    supported: support.supported,
    level: support.level,
  };

  if (isNonEmptyString(support.failure)) {
    data.failure = support.failure;
  }

  if (isNonEmptyString(support.reason)) {
    data.reason = support.reason;
  }

  if (isNonEmptyString(support.contextRelease)) {
    data.contextRelease = support.contextRelease;
  }

  if (support.supported) {
    return outcome('pass', `WebGL is available at ${support.level}.`, data);
  }

  if (support.failure === WEBGL_NO_DOCUMENT) {
    return outcome(
      'not-applicable',
      'No document is present, so no context could be requested.',
      data,
    );
  }

  const reason = isNonEmptyString(support.reason)
    ? support.reason
    : isNonEmptyString(support.failure)
      ? support.failure
      : 'no context was obtained';

  return outcome(
    'fail',
    asSentence(`WebGL is unavailable: ${reason}`),
    data,
  );
}

/** Subsystem tag every health record carries. */
const HEALTH_SUBSYSTEM = 'health';

/** Message every per-check record carries. */
const CHECK_RECORD_MESSAGE = 'capability probe reported';

/** Message a contained listener throw is recorded under. */
const LISTENER_FAULT_MESSAGE = 'health listener threw and was contained';

/** Detail a probe that threw reports. */
const PROBE_THREW_DETAIL = 'The probe threw and was contained.';

/** Detail an unrecognised check id reports. */
const UNKNOWN_CHECK_DETAIL = 'The check id is not one of the six.';

/** `StorageProbeView.strategy` of the in-memory double. */
const MEMORY_STRATEGY = 'memory';

/** Name a storage probe returning nothing usable is reported under. */
const STORAGE_PROBE_ERROR_NAME = 'StorageProbeError';

/** Settings `check`, `checkOne` and `report` accept. */
export interface HealthCheckOptions {
  /**
   * Whether the held Web Storage result is discarded and the probe performed
   * again. Defaults to `false`.
   *
   * A surface constructed with a `storage` view ignores this: the manager
   * probed once at construction and this module reads what it holds.
   */
  readonly refresh?: boolean;
}

/** Collaborators a `HealthSurface` accepts. Every one is optional. */
export interface HealthSurfaceOptions {
  /**
   * Logger the per-check records are emitted through. A child tagged
   * `'health'` is taken from it, so the records share the supplied logger's
   * correlation identifier, level, sinks and buffer.
   */
  readonly logger?: Logger;

  /**
   * Registry the per-check status gauge is written to. Defaults to a registry
   * of this module's own, wired to the same logger.
   */
  readonly metrics?: MetricsRegistry;

  /**
   * A live storage manager whose construction-time probe result and live
   * strategy are read instead of the probe being run here. Supplying it is
   * what keeps one write-and-remove round trip per session.
   */
  readonly storage?: StorageStateView;

  /**
   * The Web Storage probe. Defaults to `probeWebStorage` from the module that
   * owns it.
   */
  readonly storageProbe?: StorageProbe;

  /**
   * The pointer-family probe. Defaults to `detectPointerEventFamily` from the
   * module that owns it.
   */
  readonly pointerProbe?: PointerFamilyProbe;

  /**
   * The WebGL support probe. Defaults to `probeWebGLSupport` from the module
   * that owns it.
   */
  readonly webglProbe?: WebGLProbe;
}

/** A subscriber notified with every report `check` completes. */
export type HealthListener = (report: HealthReport) => void;

/**
 * One probe's result in the shape a diagnostics health panel reads: a name, a
 * verdict and a description.
 */
export interface HealthProbeView {
  /** The check id. */
  readonly name: string;

  /** The result's own three-state status, carried through UNREDUCED. */
  readonly status: HealthStatus;

  /**
   * `false` only for a `'fail'`. Retained beside `status` for a consumer
   * written against the boolean shape; a `'not-applicable'` result reads as
   * healthy here, matching the report roll-up, and names itself in `detail`.
   */
  readonly healthy: boolean;

  readonly detail: string;
}

/** A reader of the probe views, as a diagnostics surface consumes it. */
export type HealthProbeReader = () => readonly HealthProbeView[];

/** Provenance a result carries when its check id was not recognised. */
const UNKNOWN_CHECK_SOURCE: HealthCheckSource = Object.freeze({
  origin: null,
  owner: THIS_MODULE,
  performedBy: null,
  disposition: 'added',
});

/** One evaluated check, and the value its probe threw if it threw. */
interface EvaluatedCheck {
  readonly result: HealthCheckResult;

  /** Meaningless unless `hasThrown` is `true`. */
  readonly thrown: unknown;

  readonly hasThrown: boolean;
}

/**
 * Rolls a set of counts up into the report status.
 *
 * @param counts How many results carry each status.
 * @returns `'fail'` when at least one check failed; `'pass'` when none
 *   failed and at least one passed.
 */
function rollUpStatus(
  counts: Readonly<Record<HealthStatus, number>>,
): HealthStatus {
  if (counts.fail > 0) {
    return 'fail';
  }

  return counts.pass > 0 ? 'pass' : 'not-applicable';
}

/**
 * Health and readiness over the six capability checks.
 *
 * Every check is performed inside a no-throw boundary, every result is
 * reported twice — once as a structured log record and once as a gauge series
 * labelled with the check id — and no member throws, including where a probe,
 * the logger, the registry or a subscriber does.
 *
 * Construction performs no probe and emits nothing; `check` is the first call
 * that does either.
 */
export class HealthSurface {
  /**
   * Correlation identifier every record and report carries, as it stands now.
   */
  get correlationId(): string {
    try {
      const read: unknown = this.logger.correlationId;

      return typeof read === 'string' ? read : '';
    } catch {
      return '';
    }
  }

  private readonly logger: Logger;

  private readonly metrics: MetricsRegistry;

  /** The injected manager's cached state, when one was supplied. */
  private readonly storageState: StorageStateView | undefined;

  private readonly storageProbe: StorageProbe;

  private readonly pointerProbe: PointerFamilyProbe;

  private readonly webglProbe: WebGLProbe;

  /** Held storage result, when this module probed for itself. */
  private probedStorage: StorageStateView | undefined = undefined;

  private latest: HealthReport | null = null;

  private readonly listeners: HealthListener[] = [];

  /** Logger, registry and listener calls that threw and were contained. */
  private faultCount = 0;

  /**
   * @param options Optional collaborators.
   */
  constructor(options: HealthSurfaceOptions = {}) {
    const supplied = settingsOf(options);
    const base =
      supplied.logger ?? createLogger({ subsystem: HEALTH_SUBSYSTEM });

    this.logger = base.child(HEALTH_SUBSYSTEM);
    this.metrics =
      supplied.metrics ?? createMetricsRegistry({ logger: this.logger });
    this.storageState = isStorageStateView(supplied.storage)
      ? supplied.storage
      : undefined;
    this.storageProbe =
      typeof supplied.storageProbe === 'function'
        ? supplied.storageProbe
        : probeWebStorage;
    this.pointerProbe =
      typeof supplied.pointerProbe === 'function'
        ? supplied.pointerProbe
        : detectPointerEventFamily;
    this.webglProbe =
      typeof supplied.webglProbe === 'function'
        ? supplied.webglProbe
        : probeWebGLSupport;
  }

  /**
   * Reporter calls this surface contained because the logger, the registry or
   * a subscriber threw.
   *
   * `0` for collaborators that behave. A non-zero count means reporting is
   * failing while the checks themselves are not: every probe still ran and
   * every result is still in the returned report.
   */
  get reporterFaults(): number {
    return this.faultCount;
  }

  /**
   * Runs all six checks, reports each one and returns the report.
   *
   * @param options Whether the held Web Storage result is discarded first.
   * @returns The frozen report, always carrying exactly `HEALTH_CHECK_COUNT`
   *   results in `HEALTH_CHECK_IDS` order.
   */
  check(options: HealthCheckOptions = {}): HealthReport {
    const refresh = refreshRequested(options);
    const startedAt = monotonicNow();
    const checks: HealthCheckResult[] = [];
    const counts: Record<HealthStatus, number> = {
      pass: 0,
      fail: 0,
      'not-applicable': 0,
    };

    for (const id of HEALTH_CHECK_IDS) {
      const evaluated = this.evaluate(id, refresh);

      checks.push(evaluated.result);
      counts[evaluated.result.status] += 1;
      this.publish(evaluated);
    }

    const report: HealthReport = {
      status: rollUpStatus(counts),
      checks: Object.freeze(checks),
      counts: Object.freeze({ ...counts }),
      correlationId: this.correlationId,
      timestamp: readTimestamp(),
      durationMs: elapsedSince(startedAt),
    };

    const frozen = Object.freeze(report);

    this.latest = frozen;
    this.notify(frozen);

    return frozen;
  }

  /**
   * Runs one check and reports it. The held report is left alone, and
   * subscribers are not notified: a single check is not a report.
   *
   * @param id Check to run.
   * @param options Whether the held Web Storage result is discarded first.
   * @returns The frozen result.
   */
  checkOne(
    id: HealthCheckId,
    options: HealthCheckOptions = {},
  ): HealthCheckResult {
    const evaluated = this.evaluate(id, refreshRequested(options));

    this.publish(evaluated);

    return evaluated.result;
  }

  /**
   * The latest report, running the checks once when none has been taken yet.
   *
   * @param options Whether the held Web Storage result is discarded, which
   *   also forces the checks to be run.
   * @returns The held report, or a fresh one.
   */
  report(options: HealthCheckOptions = {}): HealthReport {
    const held = this.latest;

    if (held !== null && !refreshRequested(options)) {
      return held;
    }

    return this.check(options);
  }

  /**
   * The held report, without probing.
   *
   * @returns The report `check` last produced, or `null` before the first
   *   call.
   */
  lastReport(): HealthReport | null {
    return this.latest;
  }

  /**
   * The two consequential verdicts, derived from the latest results: whether
   * the Three.js renderer may be mounted or the number-only renderer is
   * required, and whether the live store persists.
   *
   * @param options Whether the held Web Storage result is discarded, which
   *   also forces the checks to be run.
   * @returns The frozen verdicts.
   */
  readiness(options: HealthCheckOptions = {}): ReadinessReport {
    const report = this.report(options);
    const webgl = findCheck(report, 'webgl');
    const storage = findCheck(report, 'storage');
    const mayMount = webgl !== undefined && webgl.status === 'pass';
    const strategy = readStringField(storage, 'strategy', MEMORY_STRATEGY);

    // BOTH halves are required. The named strategy alone is not enough: a
    // `StorageStateView` is injected by the caller, so a view naming
    // `'localStorage'` beside a probe result that did not pass is type-valid,
    // and deriving persistence from the name alone reported that contradiction
    // as `ready: true`.
    const persistent =
      strategy === WEB_STORAGE_STRATEGY &&
      storage !== undefined &&
      storage.status === 'pass';
    const level = readStringField(webgl, 'level', 'none');
    const failure = readStringField(webgl, 'failure', '');

    const verdicts: ReadinessReport = {
      ready: mayMount && persistent,
      renderer: mayMount ? 'webgl' : 'number-only',
      mayMountWebGLRenderer: mayMount,
      requiresNumberOnlyFallback: !mayMount,
      webglLevel: level,
      ...(failure === '' ? {} : { webglFailure: failure }),
      storage: persistent ? 'persistent' : 'ephemeral',
      storageStrategy: strategy,
      webglStatus: webgl === undefined ? 'fail' : webgl.status,
      storageStatus: storage === undefined ? 'fail' : storage.status,
      healthStatus: report.status,
      correlationId: this.correlationId,
      timestamp: report.timestamp,
    };

    return Object.freeze(verdicts);
  }

  /**
   * Subscribes a listener to every report `check` completes.
   *
   * A listener that throws is contained, counted on `reporterFaults` and left
   * subscribed; the remaining listeners still receive the report.
   *
   * @param listener Listener to add.
   * @returns A handle that removes it. Calling it more than once, or after
   *   the listener has already been removed, does nothing.
   */
  subscribe(listener: HealthListener): () => void {
    if (typeof listener !== 'function') {
      return (): void => undefined;
    }

    this.listeners.push(listener);

    let attached = true;

    return (): void => {
      if (!attached) {
        return;
      }

      attached = false;

      const at = this.listeners.indexOf(listener);

      if (at >= 0) {
        this.listeners.splice(at, 1);
      }
    };
  }

  /**
   * The held report as probe views, without probing when a report is already
   * held.
   *
   * @returns One view per check, in `HEALTH_CHECK_IDS` order.
   */
  probeViews(): readonly HealthProbeView[] {
    return Object.freeze(this.report().checks.map(toProbeView));
  }

  /**
   * A reader of the probe views, bound to this surface.
   *
   * @param options Whether each read discards the held Web Storage result
   *   and re-probes.
   * @returns A function returning one view per check on every call.
   */
  probeReader(options: HealthCheckOptions = {}): HealthProbeReader {
    return (): readonly HealthProbeView[] =>
      Object.freeze(this.check(options).checks.map(toProbeView));
  }

  /**
   * Runs one probe inside a no-throw boundary and times it.
   *
   * @param id Check to run.
   * @param refresh Whether the held Web Storage result is discarded first.
   * @returns The result, and the value the probe threw if it threw.
   */
  private evaluate(id: HealthCheckId, refresh: boolean): EvaluatedCheck {
    const source = HEALTH_CHECK_SOURCES[id] ?? UNKNOWN_CHECK_SOURCE;
    const startedAt = monotonicNow();

    try {
      const probed = this.runProbe(id, refresh);
      const result: HealthCheckResult = {
        id,
        status: probed.status,
        detail: probed.detail,
        data: Object.freeze({ ...probed.data }),
        source,
        durationMs: elapsedSince(startedAt),
      };

      return {
        result: Object.freeze(result),
        thrown: undefined,
        hasThrown: false,
      };
    } catch (error) {
      const result: HealthCheckResult = {
        id,
        status: 'fail',
        detail: PROBE_THREW_DETAIL,
        data: Object.freeze({ threw: true }),
        source,
        durationMs: elapsedSince(startedAt),
        error: serializeError(error),
      };

      return { result: Object.freeze(result), thrown: error, hasThrown: true };
    }
  }

  /**
   * Dispatches to the probe of one check.
   *
   * @param id Check to run.
   * @param refresh Whether the held Web Storage result is discarded first.
   * @returns What the probe observed.
   */
  private runProbe(id: HealthCheckId, refresh: boolean): ProbeOutcome {
    switch (id) {
      case 'functionBind':
        return probeFunctionBind();
      case 'classList':
        return probeClassList();
      case 'requestAnimationFrame':
        return probeAnimationFrame();
      case 'pointerEvents':
        return probePointerEvents(this.pointerProbe);
      case 'storage':
        return evaluateStorage(this.resolveStorageState(refresh));
      case 'webgl':
        return evaluateWebGL(this.webglProbe);
      default:
        return outcome('fail', UNKNOWN_CHECK_DETAIL, { recognised: false });
    }
  }

  /**
   * Resolves the storage state without probing more than necessary.
   *
   * @param refresh Whether a held result is discarded first.
   * @returns The injected manager's cached state where one was supplied,
   *   otherwise the held result of this module's own probe, probing on the
   *   first call and on a refresh.
   */
  private resolveStorageState(refresh: boolean): StorageStateView {
    const injected = this.storageState;

    if (injected !== undefined) {
      return injected;
    }

    const held = this.probedStorage;

    if (held !== undefined && !refresh) {
      return held;
    }

    const probed: unknown = this.storageProbe();
    const resolved: StorageStateView = isStorageProbeView(probed)
      ? { probe: probed, strategy: probed.strategy }
      : {
          probe: {
            supported: false,
            strategy: MEMORY_STRATEGY,
            error: {
              name: STORAGE_PROBE_ERROR_NAME,
              message: 'The probe returned no usable result.',
              quota: false,
            },
          },
          strategy: MEMORY_STRATEGY,
        };

    this.probedStorage = resolved;

    return resolved;
  }

  /**
   * Reports one result: a structured record through the logger and a value on
   * the status gauge.
   *
   * @param evaluated The result and the value its probe threw.
   */
  private publish(evaluated: EvaluatedCheck): void {
    this.record(evaluated);
    this.gauge(evaluated.result);
  }

  private record(evaluated: EvaluatedCheck): void {
    const result = evaluated.result;
    const fields: LogFields = {
      check: result.id,
      status: result.status,
      detail: result.detail,
      durationMs: result.durationMs,
      disposition: result.source.disposition,
      origin: result.source.origin,
      owner: result.source.owner,
      data: result.data,
    };

    try {
      if (evaluated.hasThrown) {
        this.logger.failure('warn', CHECK_RECORD_MESSAGE, {
          thrown: evaluated.thrown,
          fields,
        });
      } else if (result.status === 'fail') {
        this.logger.warn(CHECK_RECORD_MESSAGE, fields);
      } else {
        this.logger.info(CHECK_RECORD_MESSAGE, fields);
      }
    } catch {
      this.faultCount += 1;
    }
  }

  /**
   * Writes one result to `game2048_health_check_status`, labelled with the
   * check id.
   *
   * @param result Result to record.
   */
  private gauge(result: HealthCheckResult): void {
    try {
      if (result.status === 'not-applicable') {
        this.metrics
          .gauge(METRIC_NAMES.healthCheckStatus, {
            [METRIC_LABELS.check]: result.id,
          })
          .set(HEALTH_GAUGE_VALUES['not-applicable']);

        return;
      }

      this.metrics.recordHealthCheck(result.id, result.status === 'pass');
    } catch {
      this.faultCount += 1;
    }
  }

  private notify(report: HealthReport): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(report);
      } catch (error) {
        this.faultCount += 1;
        this.reportListenerFault(error);
      }
    }
  }

  private reportListenerFault(error: unknown): void {
    try {
      this.logger.failure('warn', LISTENER_FAULT_MESSAGE, { thrown: error });
    } catch {
      this.faultCount += 1;
    }
  }
}

/**
 * @param report Report to read.
 * @param id Check to find.
 * @returns The result, or `undefined` when the report carries none.
 */
function findCheck(
  report: HealthReport,
  id: HealthCheckId,
): HealthCheckResult | undefined {
  return report.checks.find((result) => result.id === id);
}

/**
 * Reads one string off a result's data bag.
 *
 * @param result Result to read, possibly absent.
 * @param key Member to read.
 * @param fallback Value returned when the member is absent or not a
 *   non-empty string.
 * @returns The value, or `fallback`.
 */
function readStringField(
  result: HealthCheckResult | undefined,
  key: string,
  fallback: string,
): string {
  if (result === undefined) {
    return fallback;
  }

  const value: unknown = result.data[key];

  return isNonEmptyString(value) ? value : fallback;
}

/**
 * @param result Result to convert.
 * @returns The probe view of it, carrying the three-state `status` verbatim
 *   and naming the third state in `detail` as well, so a panel reading either
 *   member does not present an inapplicable check as an unqualified pass.
 */
function toProbeView(result: HealthCheckResult): HealthProbeView {
  const detail =
    result.status === 'not-applicable'
      ? `not applicable — ${result.detail}`
      : result.detail;

  return Object.freeze({
    name: result.id,
    status: result.status,
    healthy: result.status !== 'fail',
    detail,
  });
}

/**
 * Builds a health surface, matching the construction idiom of
 * src/observability/logger.ts and src/observability/metrics.ts.
 *
 * @param options Optional collaborators.
 * @returns The surface. Construction probes nothing and emits nothing.
 */
export function createHealthSurface(
  options: HealthSurfaceOptions = {},
): HealthSurface {
  return new HealthSurface(settingsOf(options));
}
