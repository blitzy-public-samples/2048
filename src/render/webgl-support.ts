/**
 * WebGL capability probe, context-loss handling, and the two injection
 * contracts shared across src/render/.
 *
 * PROVENANCE
 *   The probe follows the capability check at
 *   js/animframe_polyfill.js L3-L10: that file walked the
 *   `['webkit', 'moz']` vendor list looking for a prefixed
 *   `requestAnimationFrame` (L4-L8), then tested
 *   `!window.requestAnimationFrame` (L10) to decide whether to install
 *   its own fallback. `probeWebGLSupport()` keeps that detect-then-fall-
 *   back shape. The capability tested is a WebGL rendering context
 *   rather than a frame callback, and the outcome is returned as data
 *   instead of being written onto the global object.
 *
 *   That polyfill was one of five capability checks the retired sources
 *   performed and reported nowhere. The other four were
 *   `Function.prototype.bind` (js/bind_polyfill.js), `Element.classList`
 *   (js/classlist_polyfill.js), the pointer event family
 *   (js/keyboard_input_manager.js L4-L13) and Web Storage writability
 *   (js/local_storage_manager.js L29-L40). `WebGLSupportResult` is the
 *   sixth check and the first that is reported;
 *   src/observability/health.ts reads it directly.
 *
 *   The try/catch envelope around the probe follows the writability
 *   probe at js/local_storage_manager.js L29-L40, whose catch at
 *   L37-L39 discarded its error value. `RenderErrorInfo` carries that
 *   value instead of discarding it.
 *
 *   Every DOM read here is guarded. js/html_actuator.js L2-L5 used four
 *   `document.querySelector` results unchecked; no lookup in this
 *   folder repeats that.
 *
 * CONTENTS
 *   This module imports nothing, and it is the leaf of the src/render/
 *   import graph. It mutates no document: the probe canvas is created,
 *   read, released and discarded, and is never appended.
 *
 *   `RenderReporter` and `NOOP_RENDER_REPORTER` are declared here. No
 *   module under src/render/ imports src/observability/.
 *
 *   The reduced-motion surface self-detects through `matchMedia` and
 *   accepts an explicit override. src/ui/a11y/settings.ts drives that
 *   override; this module does not import it.
 *
 * The rationale, alternatives and risks behind the choices above are
 * recorded in docs/DECISION_LOG.md; this file carries provenance only.
 */

/* ==========================================================================
 * 1. Reporter contract — how src/render/ reports
 * ========================================================================== */

/**
 * Serialisable payload attached to a report.
 *
 * Values are limited to the JSON scalars. src/observability/ serialises
 * a report with no replacer function.
 */
export type RenderDetail = Readonly<
  Record<string, string | number | boolean | null>
>;

/** Severity carried by a `RenderDiagnostic`. */
export type RenderDiagnosticLevel = 'debug' | 'info' | 'warning' | 'error';

/**
 * A caught value reduced to serialisable fields.
 *
 * Supersedes the discarded catch parameter at
 * js/local_storage_manager.js L37-L39.
 */
export interface RenderErrorInfo {
  /** The value's `name`, or `'RenderError'` when it carries none. */
  readonly name: string;

  /**
   * The value's `message`, or a printable form of the thrown value when
   * it carries none.
   */
  readonly message: string;
}

/** One diagnostic record: a message, and the error that caused it. */
export interface RenderDiagnostic {
  /** Severity of the record. */
  readonly level: RenderDiagnosticLevel;

  /** Module that emitted it, as `'render/webgl-support'`. */
  readonly source: string;

  /** Human-readable summary. */
  readonly message: string;

  /** Structured fields belonging to the record. */
  readonly detail?: RenderDetail;

  /** The caught value, present only on records that report one. */
  readonly error?: RenderErrorInfo;
}

/** One increment of a named counter. */
export interface RenderCount {
  /** Counter name, as `'render.webgl.probe'`. */
  readonly name: string;

  /** Amount to add. */
  readonly value: number;

  /** Structured fields belonging to the increment. */
  readonly detail?: RenderDetail;
}

/** One duration measurement against a named timer. */
export interface RenderTiming {
  /** Timer name, as `'render.webgl.probe'`. */
  readonly name: string;

  /** Elapsed time in milliseconds. */
  readonly durationMs: number;

  /** Structured fields belonging to the measurement. */
  readonly detail?: RenderDetail;
}

/**
 * Sink every module under src/render/ reports through.
 *
 * Three channels: `onDiagnostic` carries messages and caught errors,
 * `onCount` carries counter increments, and `onTiming` carries
 * durations — src/render/render-loop.ts reports frame timings through
 * the third.
 *
 * Handlers run synchronously on the calling path, and a handler that
 * throws propagates to its caller. Every render module accepts a
 * reporter as an optional parameter defaulting to
 * `NOOP_RENDER_REPORTER`, so every one of them is constructible with no
 * sink and no mocking library.
 *
 * @example
 * ```ts
 * const reporter = createRenderReporter({
 *   onDiagnostic: (diagnostic) => { records.push(diagnostic); },
 * });
 * const support = probeWebGLSupport(reporter);
 * ```
 */
export interface RenderReporter {
  /** Receives every diagnostic record. */
  readonly onDiagnostic: (diagnostic: RenderDiagnostic) => void;

  /** Receives every counter increment. */
  readonly onCount: (count: RenderCount) => void;

  /** Receives every duration measurement. */
  readonly onTiming: (timing: RenderTiming) => void;
}

/**
 * Reporter whose three channels accept a report and return without
 * doing anything with it. Used as the default parameter value wherever
 * a render module accepts a reporter.
 */
export const NOOP_RENDER_REPORTER: RenderReporter = Object.freeze({
  onDiagnostic: (): void => {},
  onCount: (): void => {},
  onTiming: (): void => {},
});

/**
 * Completes a partial sink into a `RenderReporter`, filling each absent
 * channel with the matching no-op channel of `NOOP_RENDER_REPORTER`.
 *
 * @param partial Channels the caller supplies. Any subset is accepted,
 *   including an empty object.
 * @returns A frozen reporter carrying all three channels.
 */
export function createRenderReporter(
  partial: Partial<RenderReporter>,
): RenderReporter {
  const reporter: RenderReporter = {
    onDiagnostic: partial.onDiagnostic ?? NOOP_RENDER_REPORTER.onDiagnostic,
    onCount: partial.onCount ?? NOOP_RENDER_REPORTER.onCount,
    onTiming: partial.onTiming ?? NOOP_RENDER_REPORTER.onTiming,
  };

  return Object.freeze(reporter);
}

/** Source field carried by every diagnostic this module emits. */
const DIAGNOSTIC_SOURCE = 'render/webgl-support';

/** Counter and timer name for the capability probe. */
const PROBE_METRIC = 'render.webgl.probe';

/** Counter name for an observed context loss. */
const CONTEXT_LOST_METRIC = 'render.webgl.context.lost';

/** Counter name for an observed context restoration. */
const CONTEXT_RESTORED_METRIC = 'render.webgl.context.restored';

/** Counter name for a caller-supplied handler that threw. */
const HANDLER_ERROR_METRIC = 'render.webgl.handler.error';

/** Counter name for a reduced-motion listener that threw. */
const MOTION_LISTENER_ERROR_METRIC = 'render.motion.listener.error';

/** Name reported when a caught value carries none. */
const UNKNOWN_ERROR_NAME = 'RenderError';

/** Message reported when a caught value carries none. */
const UNKNOWN_ERROR_MESSAGE = 'Unknown render error.';

/**
 * Reads a non-empty string property from an object of unknown shape.
 *
 * @param source Object to read from.
 * @param field Property name to read.
 * @returns The property value, or `undefined` where it is absent, not a
 *   string, or empty.
 */
function readStringField(source: object, field: string): string | undefined {
  if (!(field in source)) {
    return undefined;
  }

  const candidate: unknown = Reflect.get(source, field);

  return typeof candidate === 'string' && candidate.length > 0
    ? candidate
    : undefined;
}

/**
 * Reduces a caught value of any type to serialisable fields, so a
 * report carries it rather than discarding it.
 *
 * @param error Caught value, of any type, including `null` and
 *   `undefined`.
 * @returns Frozen name and message fields.
 */
function describeError(error: unknown): RenderErrorInfo {
  if (error instanceof Error) {
    const info: RenderErrorInfo = {
      name: error.name.length > 0 ? error.name : UNKNOWN_ERROR_NAME,
      message:
        error.message.length > 0 ? error.message : UNKNOWN_ERROR_MESSAGE,
    };

    return Object.freeze(info);
  }

  if (typeof error === 'object' && error !== null) {
    const info: RenderErrorInfo = {
      name: readStringField(error, 'name') ?? UNKNOWN_ERROR_NAME,
      message: readStringField(error, 'message') ?? UNKNOWN_ERROR_MESSAGE,
    };

    return Object.freeze(info);
  }

  const info: RenderErrorInfo = {
    name: UNKNOWN_ERROR_NAME,
    message:
      typeof error === 'function' ? UNKNOWN_ERROR_MESSAGE : String(error),
  };

  return Object.freeze(info);
}

/* ==========================================================================
 * 2. WebGL capability probe — the sixth capability check
 * ========================================================================== */

/** Context level a probe obtained, or `'none'` when it obtained none. */
export type WebGLContextLevel = 'webgl2' | 'webgl' | 'none';

/** Levels the probe requests, in request order. */
type ProbeLevel = 'webgl2' | 'webgl';

/** Failure raised before any context is requested. */
type CanvasFailure = 'no-document' | 'no-canvas-element';

/** What prevented a probe from obtaining a rendering context. */
export type WebGLProbeFailure =
  | CanvasFailure
  | 'context-creation-failed'
  | 'context-creation-threw'
  | 'probe-threw';

/**
 * Outcome of `probeWebGLSupport()`.
 *
 * A frozen plain object of JSON scalars: no class instance, no live
 * context handle, no closure. `JSON.stringify()` round-trips it.
 * src/observability/health.ts reports it as a health check and
 * src/observability/metrics.ts exports it in a snapshot.
 *
 * It carries no timestamp. Probe duration is reported through
 * `RenderReporter.onTiming`. Two probes of one environment therefore
 * produce equal values.
 */
export interface WebGLSupportResult {
  /** Whether a rendering context was obtained. */
  readonly supported: boolean;

  /** Level obtained: `'webgl2'`, `'webgl'`, or `'none'`. */
  readonly level: WebGLContextLevel;

  /**
   * What prevented a context from being obtained. Absent when
   * `supported` is `true`.
   */
  readonly failure?: WebGLProbeFailure;

  /**
   * Human-readable form of `failure`, carrying the thrown value's text
   * where the probe caught one. Absent when `supported` is `true`.
   */
  readonly reason?: string;

  /**
   * Unmasked renderer string. Absent where `WEBGL_debug_renderer_info`
   * is unavailable, which is the case in privacy configurations that
   * strip the extension.
   */
  readonly renderer?: string;

  /** Unmasked vendor string. Absent on the same terms as `renderer`. */
  readonly vendor?: string;

  /**
   * Whether `WEBGL_debug_renderer_info` was present. Distinguishes a
   * stripped extension from an extension that reported nothing.
   */
  readonly debugRendererInfo: boolean;

  /**
   * Whether the probe context was released through
   * `WEBGL_lose_context`. `false` where the extension is unavailable, in
   * which case the context is dropped with the canvas.
   */
  readonly contextReleased: boolean;
}

/** Mutable form of `WebGLSupportResult`, frozen before it is returned. */
interface WebGLSupportDraft {
  supported: boolean;
  level: WebGLContextLevel;
  failure?: WebGLProbeFailure;
  reason?: string;
  renderer?: string;
  vendor?: string;
  debugRendererInfo: boolean;
  contextReleased: boolean;
}

/** One `getContext` attempt, and the value it threw if it threw. */
interface ContextAttempt {
  readonly context: WebGLRenderingContext | WebGL2RenderingContext | null;
  readonly error?: RenderErrorInfo;
}

/** What `WEBGL_debug_renderer_info` reported, if it was present. */
interface DebugRendererInfo {
  readonly available: boolean;
  readonly renderer?: string;
  readonly vendor?: string;
}

/** Outcome of creating the throwaway probe canvas. */
interface ProbeCanvas {
  readonly element?: HTMLCanvasElement;
  readonly failure?: CanvasFailure;
}

/** Levels requested, highest first. Ported order: WebGL 2, then WebGL 1. */
const PROBE_LEVELS: readonly ProbeLevel[] = Object.freeze([
  'webgl2',
  'webgl',
]);

/** Default `reason` text for each failure code. */
const FAILURE_REASONS: Readonly<Record<WebGLProbeFailure, string>> =
  Object.freeze({
    'no-document': 'No document is available to create a probe canvas.',
    'no-canvas-element':
      'createElement("canvas") produced no element carrying getContext.',
    'context-creation-failed':
      'getContext returned no context for webgl2 or for webgl.',
    'context-creation-threw': 'getContext threw while creating a context.',
    'probe-threw': 'The probe threw before it could complete.',
  });

/**
 * Result of the one probe this module performs per page, held so the
 * probe creates a single canvas and a single context however many
 * callers ask. Cleared by `resetWebGLSupportProbe()`.
 */
let cachedSupport: WebGLSupportResult | undefined;

/**
 * Whether a value carries the canvas operation the probe needs.
 *
 * @param value Value to test, typically a `createElement` result.
 * @returns Whether `value` is an object exposing `getContext`.
 */
function isCanvasLike(value: unknown): value is HTMLCanvasElement {
  return (
    typeof value === 'object' &&
    value !== null &&
    'getContext' in value &&
    typeof value.getContext === 'function'
  );
}

/**
 * Whether a value carries both listener operations.
 *
 * @param value Value to test, typically an element looked up in the
 *   document.
 * @returns Whether `value` exposes `addEventListener` and
 *   `removeEventListener`.
 */
function isListenerTarget(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'addEventListener' in value &&
    typeof value.addEventListener === 'function' &&
    'removeEventListener' in value &&
    typeof value.removeEventListener === 'function'
  );
}

/**
 * Reads a monotonic clock where one exists, falling back to the
 * wall clock. Used for probe duration only, which is reported and never
 * returned.
 *
 * @returns Milliseconds from an unspecified origin.
 */
function monotonicNow(): number {
  if (
    typeof globalThis.performance === 'undefined' ||
    typeof globalThis.performance.now !== 'function'
  ) {
    return Date.now();
  }

  return globalThis.performance.now();
}

/**
 * Creates the throwaway canvas the probe requests its context from. The
 * element is never appended to the document and holds no reference
 * after the probe returns.
 *
 * @returns The element, or the failure code that stopped its creation.
 */
function createProbeCanvas(): ProbeCanvas {
  if (
    typeof globalThis.document === 'undefined' ||
    typeof globalThis.document.createElement !== 'function'
  ) {
    return { failure: 'no-document' };
  }

  const created: unknown = globalThis.document.createElement('canvas');

  if (!isCanvasLike(created)) {
    return { failure: 'no-canvas-element' };
  }

  return { element: created };
}

/**
 * Requests one context level, containing anything `getContext` throws.
 *
 * @param canvas Canvas to request the context from.
 * @param level Level to request.
 * @returns The context, or `null` with the thrown value described.
 */
function requestContext(
  canvas: HTMLCanvasElement,
  level: ProbeLevel,
): ContextAttempt {
  try {
    const context =
      level === 'webgl2'
        ? canvas.getContext('webgl2')
        : canvas.getContext('webgl');

    return { context };
  } catch (error: unknown) {
    return { context: null, error: describeError(error) };
  }
}

/**
 * Reads one string-valued context parameter.
 *
 * @param context Context to read from.
 * @param parameter Parameter enum to read.
 * @returns The reported string, or `undefined` where the read failed or
 *   reported a non-string.
 */
function readContextString(
  context: WebGLRenderingContext | WebGL2RenderingContext,
  parameter: number,
): string | undefined {
  try {
    const value: unknown = context.getParameter(parameter);

    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads the unmasked renderer and vendor strings where
 * `WEBGL_debug_renderer_info` is present. The extension is frequently
 * absent, and is stripped entirely in some privacy configurations; the
 * `getExtension` result is checked before it is read.
 *
 * @param context Context to read from.
 * @returns Whether the extension was present, and what it reported.
 */
function readDebugRendererInfo(
  context: WebGLRenderingContext | WebGL2RenderingContext,
): DebugRendererInfo {
  let extension: WEBGL_debug_renderer_info | null = null;

  try {
    extension = context.getExtension('WEBGL_debug_renderer_info');
  } catch {
    return { available: false };
  }

  if (extension === null) {
    return { available: false };
  }

  const renderer = readContextString(
    context,
    extension.UNMASKED_RENDERER_WEBGL,
  );
  const vendor = readContextString(context, extension.UNMASKED_VENDOR_WEBGL);
  const info: DebugRendererInfo = {
    available: true,
    ...(renderer === undefined ? {} : { renderer }),
    ...(vendor === undefined ? {} : { vendor }),
  };

  return info;
}

/**
 * Releases the probe context through `WEBGL_lose_context` where that
 * extension is present. Browsers cap simultaneous contexts, and the
 * probe holds one until it is released.
 *
 * @param context Context to release.
 * @returns Whether `loseContext()` was called.
 */
function releaseContext(
  context: WebGLRenderingContext | WebGL2RenderingContext,
): boolean {
  try {
    const extension = context.getExtension('WEBGL_lose_context');

    if (extension === null || typeof extension.loseContext !== 'function') {
      return false;
    }

    extension.loseContext();

    return true;
  } catch {
    return false;
  }
}

/**
 * Builds the frozen result for a probe that obtained a context, reading
 * the renderer strings and then releasing the context.
 *
 * @param level Level that was obtained.
 * @param context Context that was obtained.
 * @returns The frozen supported result.
 */
function supportedResult(
  level: ProbeLevel,
  context: WebGLRenderingContext | WebGL2RenderingContext,
): WebGLSupportResult {
  const info = readDebugRendererInfo(context);
  const draft: WebGLSupportDraft = {
    supported: true,
    level,
    debugRendererInfo: info.available,
    contextReleased: releaseContext(context),
  };

  if (info.renderer !== undefined) {
    draft.renderer = info.renderer;
  }

  if (info.vendor !== undefined) {
    draft.vendor = info.vendor;
  }

  return Object.freeze(draft);
}

/**
 * Builds the frozen result for a probe that obtained no context.
 *
 * @param failure Failure code to report.
 * @param reason Text to report in place of the code's default text.
 * @returns The frozen unsupported result.
 */
function failedResult(
  failure: WebGLProbeFailure,
  reason?: string,
): WebGLSupportResult {
  const draft: WebGLSupportDraft = {
    supported: false,
    level: 'none',
    failure,
    reason: reason ?? FAILURE_REASONS[failure],
    debugRendererInfo: false,
    contextReleased: false,
  };

  return Object.freeze(draft);
}

/**
 * Runs the probe once: creates the canvas, requests `'webgl2'` then
 * `'webgl'`, and reduces whichever outcome occurred to a frozen result.
 * Returns a result on every path and throws on none.
 *
 * @returns The frozen probe result.
 */
function runProbe(): WebGLSupportResult {
  try {
    const canvas = createProbeCanvas();

    if (canvas.element === undefined) {
      return failedResult(canvas.failure ?? 'no-canvas-element');
    }

    let firstError: RenderErrorInfo | undefined;

    for (const level of PROBE_LEVELS) {
      const attempt = requestContext(canvas.element, level);

      if (attempt.error !== undefined && firstError === undefined) {
        firstError = attempt.error;
      }

      if (attempt.context !== null) {
        return supportedResult(level, attempt.context);
      }
    }

    if (firstError !== undefined) {
      return failedResult(
        'context-creation-threw',
        `${firstError.name}: ${firstError.message}`,
      );
    }

    return failedResult('context-creation-failed');
  } catch (error: unknown) {
    const info = describeError(error);

    return failedResult('probe-threw', `${info.name}: ${info.message}`);
  }
}

/**
 * Builds the diagnostic that reports a probe result.
 *
 * @param result Result to describe.
 * @returns The diagnostic record.
 */
function describeSupport(result: WebGLSupportResult): RenderDiagnostic {
  const detail: Record<string, string | number | boolean | null> = {
    supported: result.supported,
    level: result.level,
    debugRendererInfo: result.debugRendererInfo,
    contextReleased: result.contextReleased,
    failure: result.failure ?? null,
    renderer: result.renderer ?? null,
    vendor: result.vendor ?? null,
  };

  const reason = result.reason ?? FAILURE_REASONS['context-creation-failed'];
  const diagnostic: RenderDiagnostic = {
    level: result.supported ? 'info' : 'warning',
    source: DIAGNOSTIC_SOURCE,
    message: result.supported
      ? `WebGL is available at ${result.level}.`
      : `WebGL is unavailable: ${reason}`,
    detail: Object.freeze(detail),
  };

  return diagnostic;
}

/**
 * Probes for a WebGL rendering context, and reports what it found.
 *
 * The probe creates a throwaway canvas, requests `'webgl2'` and then
 * `'webgl'`, reads the unmasked renderer strings where
 * `WEBGL_debug_renderer_info` allows it, releases the context through
 * `WEBGL_lose_context` where that extension is present, and discards
 * the canvas. It touches no element in the document and throws on no
 * path, including where there is no document at all.
 *
 * The result is held after the first call and returned unchanged to
 * every later caller. src/main.ts, src/observability/health.ts and
 * src/observability/diagnostics-overlay.ts therefore share the single
 * canvas and single context of that first call. Reports are emitted on
 * the call that performs the probe; a call answered from the held result
 * emits none.
 *
 * @param reporter Sink for the probe's timing, counter and diagnostic
 *   reports. Defaults to `NOOP_RENDER_REPORTER`.
 * @returns The frozen, serialisable probe result.
 *
 * @example
 * ```ts
 * const support = probeWebGLSupport();
 * if (support.supported) {
 *   mountThreeRenderer();
 * } else {
 *   mountNumberOnlyRenderer();
 * }
 * ```
 */
export function probeWebGLSupport(
  reporter: RenderReporter = NOOP_RENDER_REPORTER,
): WebGLSupportResult {
  const held = cachedSupport;

  if (held !== undefined) {
    return held;
  }

  const startedAt = monotonicNow();
  const result = runProbe();
  const durationMs = monotonicNow() - startedAt;

  cachedSupport = result;

  const detail: RenderDetail = Object.freeze({
    supported: result.supported,
    level: result.level,
  });

  reporter.onTiming({ name: PROBE_METRIC, durationMs, detail });
  reporter.onCount({ name: PROBE_METRIC, value: 1, detail });
  reporter.onDiagnostic(describeSupport(result));

  return result;
}

/**
 * Discards the held probe result, so the next `probeWebGLSupport()`
 * call probes again. Present for suites that exercise both the
 * supported and the unsupported branch in one process.
 */
export function resetWebGLSupportProbe(): void {
  cachedSupport = undefined;
}


/* ==========================================================================
 * 3. Reduced-motion preference
 * ========================================================================== */

/**
 * Media query the preference is read from. No stylesheet in the retired
 * sources referenced it; style/_a11y.scss carries the matching CSS
 * layer.
 */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Where an effective reduced-motion value came from. */
export type MotionPreferenceSource = 'override' | 'media-query' | 'default';

/**
 * The effective reduced-motion preference, and how it was determined.
 *
 * A frozen plain object of JSON scalars, on the same terms as
 * `WebGLSupportResult`. src/observability/ reports and exports it.
 */
export interface MotionPreference {
  /**
   * Whether motion is to be reduced. Consumers gate camera punch and
   * shake, the merge particle burst and every non-essential transition
   * on this value.
   */
  readonly reduced: boolean;

  /**
   * `'override'` where an override is set, `'media-query'` where the
   * query answered, and `'default'` where neither applied.
   */
  readonly source: MotionPreferenceSource;

  /** Whether `matchMedia` produced a usable query list. */
  readonly mediaQuerySupported: boolean;

  /** The override in force, or `null` where the query governs. */
  readonly override: boolean | null;
}

/** Receives the effective value whenever it changes. */
export type ReducedMotionListener = (reduced: boolean) => void;

/** One subscription: its listener, and the sink its throws report to. */
interface MotionSubscription {
  readonly listener: ReducedMotionListener;
  readonly reporter: RenderReporter;
}

/**
 * Override in force, or `null` while the media query governs. Set
 * through `setReducedMotionOverride()`, which src/ui/a11y/settings.ts
 * calls; this module imports nothing from that surface.
 */
let motionOverride: boolean | null = null;

/** Live subscriptions, held in subscription order. */
const motionSubscriptions = new Set<MotionSubscription>();

/** Query list held after the first successful `matchMedia` call. */
let motionQueryList: MediaQueryList | undefined;

/** Removes the change listener from `motionQueryList`, once attached. */
let detachMotionQueryListener: (() => void) | undefined;

/** Last value dispatched to listeners, so an unchanged value is not. */
let lastDispatchedReduced: boolean | undefined;

/**
 * Whether a value carries the query-list member the preference reads.
 *
 * @param value Value to test, typically a `matchMedia` result.
 * @returns Whether `value` is an object with a boolean `matches`.
 */
function isMediaQueryList(value: unknown): value is MediaQueryList {
  return (
    typeof value === 'object' &&
    value !== null &&
    'matches' in value &&
    typeof value.matches === 'boolean'
  );
}

/**
 * Resolves the reduced-motion query list, holding it after the first
 * successful call. `matchMedia` is absent under a non-DOM test
 * environment and on older surfaces, and is treated as no preference
 * expressed rather than as an error.
 *
 * @returns The query list, or `undefined` where none is obtainable.
 */
function resolveMotionQueryList(): MediaQueryList | undefined {
  if (motionQueryList !== undefined) {
    return motionQueryList;
  }

  if (typeof globalThis.matchMedia !== 'function') {
    return undefined;
  }

  try {
    const created: unknown = globalThis.matchMedia(REDUCED_MOTION_QUERY);

    if (!isMediaQueryList(created)) {
      return undefined;
    }

    motionQueryList = created;

    return created;
  } catch {
    return undefined;
  }
}

/**
 * Subscribes to query-list changes, preferring `addEventListener` and
 * falling back to the deprecated `addListener` where only that exists.
 *
 * @param list Query list to observe.
 * @param handler Called on every change.
 * @returns A detach function, or `undefined` where the list carries
 *   neither subscription mechanism.
 */
function attachMotionQueryListener(
  list: MediaQueryList,
  handler: () => void,
): (() => void) | undefined {
  if (typeof list.addEventListener === 'function') {
    list.addEventListener('change', handler);

    return (): void => {
      if (typeof list.removeEventListener === 'function') {
        list.removeEventListener('change', handler);
      }
    };
  }

  if (typeof list.addListener === 'function') {
    list.addListener(handler);

    return (): void => {
      if (typeof list.removeListener === 'function') {
        list.removeListener(handler);
      }
    };
  }

  return undefined;
}

/**
 * Reads the effective preference and how it was determined, without
 * throwing on any path.
 *
 * @returns The frozen, serialisable preference.
 */
export function readMotionPreference(): MotionPreference {
  const list = resolveMotionQueryList();
  const override = motionOverride;

  if (override !== null) {
    const preference: MotionPreference = {
      reduced: override,
      source: 'override',
      mediaQuerySupported: list !== undefined,
      override,
    };

    return Object.freeze(preference);
  }

  if (list !== undefined) {
    const preference: MotionPreference = {
      reduced: list.matches,
      source: 'media-query',
      mediaQuerySupported: true,
      override,
    };

    return Object.freeze(preference);
  }

  const preference: MotionPreference = {
    reduced: false,
    source: 'default',
    mediaQuerySupported: false,
    override,
  };

  return Object.freeze(preference);
}

/**
 * Reads the effective reduced-motion preference.
 *
 * Returns the override where one is set, the media query's answer where
 * the query is available, and `false` where neither is — an absent
 * `matchMedia` is no preference expressed, never a thrown error.
 *
 * @returns Whether motion is to be reduced.
 *
 * @example
 * ```ts
 * if (!queryReducedMotion()) {
 *   playCameraPunch();
 * }
 * ```
 */
export function queryReducedMotion(): boolean {
  return readMotionPreference().reduced;
}

/**
 * Dispatches the effective value to every live subscription when it
 * differs from the last dispatched value. A listener that throws is
 * reported through that subscription's own reporter and does not stop
 * the remaining listeners.
 */
function dispatchMotionPreference(): void {
  const reduced = readMotionPreference().reduced;

  if (reduced === lastDispatchedReduced) {
    return;
  }

  lastDispatchedReduced = reduced;

  const detail: RenderDetail = Object.freeze({ reduced });

  for (const subscription of Array.from(motionSubscriptions)) {
    try {
      subscription.listener(reduced);
    } catch (error: unknown) {
      subscription.reporter.onCount({
        name: MOTION_LISTENER_ERROR_METRIC,
        value: 1,
        detail,
      });
      subscription.reporter.onDiagnostic({
        level: 'error',
        source: DIAGNOSTIC_SOURCE,
        message: 'A reduced-motion listener threw and was isolated.',
        detail,
        error: describeError(error),
      });
    }
  }
}

/** Attaches the single query-list change listener, if not yet attached. */
function ensureMotionQueryListener(): void {
  if (detachMotionQueryListener !== undefined) {
    return;
  }

  const list = resolveMotionQueryList();

  if (list === undefined) {
    return;
  }

  detachMotionQueryListener = attachMotionQueryListener(list, (): void => {
    dispatchMotionPreference();
  });
}

/** Removes the query-list change listener, if attached. */
function releaseMotionQueryListener(): void {
  const detach = detachMotionQueryListener;

  detachMotionQueryListener = undefined;

  if (detach !== undefined) {
    detach();
  }
}

/**
 * Forces the reduced-motion preference on or off regardless of the
 * operating-system setting, or restores following it.
 *
 * src/ui/a11y/settings.ts calls this from the accessibility surface.
 * Live subscriptions are notified when the effective value changes.
 *
 * @param reduced `true` or `false` to force the value; `null` to follow
 *   the media query again.
 */
export function setReducedMotionOverride(reduced: boolean | null): void {
  if (motionOverride === reduced) {
    return;
  }

  motionOverride = reduced;

  dispatchMotionPreference();
}

/**
 * Subscribes to reduced-motion changes, from the operating-system
 * setting and from `setReducedMotionOverride()` alike, so a preference
 * toggled mid-run takes effect without a reload.
 *
 * The listener is called only when the effective value changes, never
 * on subscription. One change listener is attached to the query list
 * for all subscribers, and it is removed when the last subscription is
 * released.
 *
 * @param listener Receives the effective value on every change.
 * @param reporter Sink for a listener that throws. Defaults to
 *   `NOOP_RENDER_REPORTER`.
 * @returns An unsubscribe function. Calling it more than once is
 *   harmless.
 *
 * @example
 * ```ts
 * const unsubscribe = subscribeReducedMotion((reduced) => {
 *   particles.setEnabled(!reduced);
 * });
 * ```
 */
export function subscribeReducedMotion(
  listener: ReducedMotionListener,
  reporter: RenderReporter = NOOP_RENDER_REPORTER,
): () => void {
  const subscription: MotionSubscription = { listener, reporter };

  motionSubscriptions.add(subscription);
  lastDispatchedReduced = readMotionPreference().reduced;
  ensureMotionQueryListener();

  let released = false;

  return (): void => {
    if (released) {
      return;
    }

    released = true;
    motionSubscriptions.delete(subscription);

    if (motionSubscriptions.size === 0) {
      releaseMotionQueryListener();
    }
  };
}

/**
 * Clears the override, releases every subscription and discards the
 * held query list, returning the preference to its initial state.
 * Present for suites that stub `matchMedia`, and for teardown.
 */
export function resetMotionPreference(): void {
  releaseMotionQueryListener();
  motionSubscriptions.clear();
  motionOverride = null;
  motionQueryList = undefined;
  lastDispatchedReduced = undefined;
}


/* ==========================================================================
 * 4. Context-loss handling
 * ========================================================================== */

/** Event name a browser dispatches when a context is lost. */
const CONTEXT_LOST_EVENT = 'webglcontextlost';

/** Event name a browser dispatches when a context is restored. */
const CONTEXT_RESTORED_EVENT = 'webglcontextrestored';

/** Which caller-supplied handler an isolated throw came from. */
type ContextLossHandlerName = 'context-lost' | 'context-restored';

/** What the browser reported alongside a context loss. */
export interface WebGLContextLossInfo {
  /**
   * The event's `statusMessage`, where the event carried a non-empty
   * one. `WebGLContextEvent` is not uniformly available; the property is
   * read defensively and is absent whenever it is not a non-empty
   * string.
   */
  readonly statusMessage?: string;
}

/** Callbacks `attachContextLossHandlers()` invokes. Both are optional. */
export interface ContextLossHandlers {
  /**
   * Called after the loss has been reported and restoration requested.
   * Implementations stop their frame loop and drop every GPU resource
   * held against the lost context.
   */
  readonly onContextLost?: (info: WebGLContextLossInfo) => void;

  /**
   * Called when the browser restores the context. Implementations
   * rebuild their GPU resources and resume their frame loop.
   */
  readonly onContextRestored?: () => void;
}

/**
 * Reads a context event's `statusMessage` without weakening the event
 * type.
 *
 * @param event Event dispatched by the browser.
 * @returns The frozen loss info, carrying `statusMessage` only where the
 *   event supplied a non-empty string.
 */
function readContextLossInfo(event: Event): WebGLContextLossInfo {
  const draft: { statusMessage?: string } = {};

  if ('statusMessage' in event) {
    const candidate: unknown = event.statusMessage;

    if (typeof candidate === 'string' && candidate.length > 0) {
      draft.statusMessage = candidate;
    }
  }

  return Object.freeze(draft);
}

/**
 * Runs one caller-supplied handler, containing a throw so the listener
 * completes and the browser's event dispatch is never given an error.
 *
 * @param reporter Sink the throw is reported to.
 * @param handler Which handler is running.
 * @param run Invocation to contain.
 */
function invokeLossHandler(
  reporter: RenderReporter,
  handler: ContextLossHandlerName,
  run: () => void,
): void {
  try {
    run();
  } catch (error: unknown) {
    const detail: RenderDetail = Object.freeze({ handler });

    reporter.onCount({ name: HANDLER_ERROR_METRIC, value: 1, detail });
    reporter.onDiagnostic({
      level: 'error',
      source: DIAGNOSTIC_SOURCE,
      message: `The ${handler} handler threw and was isolated.`,
      detail,
      error: describeError(error),
    });
  }
}

/**
 * Subscribes to a canvas's context-loss and context-restoration events,
 * and reports both transitions.
 *
 * The loss listener calls `preventDefault()` on the event. Without that
 * call a browser makes no restoration attempt and never dispatches
 * `webglcontextrestored`, so the listener performs it before anything
 * else and before either caller-supplied handler runs.
 *
 * Both transitions are reported through `reporter`;
 * src/observability/diagnostics-overlay.ts renders them. A
 * caller-supplied handler that throws is reported and contained; the
 * other handler and the listeners themselves are unaffected.
 *
 * @param canvas Canvas whose context is observed. A value carrying
 *   neither listener operation is reported and attaches nothing.
 * @param handlers Callbacks for the two transitions. Either may be
 *   omitted, and the whole argument may be omitted.
 * @param reporter Sink for both transitions and for a handler that
 *   throws. Defaults to `NOOP_RENDER_REPORTER`.
 * @returns A detach function removing both listeners. Calling it more
 *   than once is harmless.
 *
 * @example
 * ```ts
 * const detach = attachContextLossHandlers(canvas, {
 *   onContextLost: () => { renderLoop.stop(); },
 *   onContextRestored: () => { scene.rebuild(); renderLoop.start(); },
 * });
 * ```
 */
export function attachContextLossHandlers(
  canvas: HTMLCanvasElement,
  handlers: ContextLossHandlers = {},
  reporter: RenderReporter = NOOP_RENDER_REPORTER,
): () => void {
  if (!isListenerTarget(canvas)) {
    reporter.onDiagnostic({
      level: 'error',
      source: DIAGNOSTIC_SOURCE,
      message:
        'No canvas carrying listener operations was supplied; no ' +
        'context-loss listener was attached.',
    });

    return (): void => undefined;
  }

  const onContextLost = (event: Event): void => {
    event.preventDefault();

    const info = readContextLossInfo(event);

    reporter.onCount({ name: CONTEXT_LOST_METRIC, value: 1 });
    reporter.onDiagnostic({
      level: 'warning',
      source: DIAGNOSTIC_SOURCE,
      message: 'The WebGL context was lost; restoration was requested.',
      detail: Object.freeze({
        statusMessage: info.statusMessage ?? null,
        restorationRequested: event.defaultPrevented,
      }),
    });

    invokeLossHandler(reporter, 'context-lost', (): void => {
      handlers.onContextLost?.(info);
    });
  };

  const onContextRestored = (): void => {
    reporter.onCount({ name: CONTEXT_RESTORED_METRIC, value: 1 });
    reporter.onDiagnostic({
      level: 'info',
      source: DIAGNOSTIC_SOURCE,
      message: 'The WebGL context was restored.',
    });

    invokeLossHandler(reporter, 'context-restored', (): void => {
      handlers.onContextRestored?.();
    });
  };

  canvas.addEventListener(CONTEXT_LOST_EVENT, onContextLost);
  canvas.addEventListener(CONTEXT_RESTORED_EVENT, onContextRestored);

  let released = false;

  return (): void => {
    if (released) {
      return;
    }

    released = true;
    canvas.removeEventListener(CONTEXT_LOST_EVENT, onContextLost);
    canvas.removeEventListener(CONTEXT_RESTORED_EVENT, onContextRestored);
  };
}

