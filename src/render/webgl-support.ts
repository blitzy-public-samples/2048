/**
 * WebGL capability probe, context-loss handling, and the two injection contracts
 * shared across src/render/.
 *
 * The probe detects a rendering context and returns the outcome as frozen,
 * serialisable data rather than writing anything onto the global object, so the
 * health surface can report it and a caller can fall back to the number-only
 * renderer. It is the sixth capability check in the product and the first that
 * is reported; src/observability/health.ts reads it directly. Its result is held
 * after the first call; `resetWebGLSupportProbe()` discards it. Every DOM read
 * is guarded, and the probe canvas is created, read, released and discarded
 * without ever being appended.
 *
 * The probe requests no extension that carries an identifier — only
 * `WEBGL_lose_context`, to release its own context — so no renderer or vendor
 * string enters `WebGLSupportResult` or any report.
 *
 * `RenderReporter`, `NOOP_RENDER_REPORTER` and the containment boundary
 * `createGuardedRenderReporter` are declared here, and no module under
 * src/render/ imports src/observability/: reports leave through the injected
 * reporter, and a reporter that throws is contained at the point of delivery.
 * This module imports nothing and is the leaf of the src/render/ import graph.
 * The module boundaries are drawn as Figure 2, "To-Be Architecture:
 * Event-Driven Engine with Subscribed Renderer and Hook Bus", in
 * docs/architecture/ARCHITECTURE.md.
 *
 * The reduced-motion surface self-detects through `matchMedia` and accepts an
 * explicit override; consumers gate the camera and particle effects on it.
 * src/ui/a11y/settings.ts drives that override; this module does not import it.
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

/** A caught value reduced to serialisable fields. */
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
 * throws is contained: every entry point in src/render/ passes its
 * reporter through `createGuardedRenderReporter()` before using it, so a
 * throw reaches neither the probe, nor a reduced-motion listener, nor a
 * context-loss listener, nor a frame, and is not reported back through
 * the sink that produced it. Every render module accepts a reporter as
 * an optional parameter defaulting to `NOOP_RENDER_REPORTER`, so every
 * one of them is constructible with no sink and no mocking library.
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

  return createGuardedRenderReporter(reporter);
}

/**
 * Number of reporter invocations contained across this module because
 * the sink threw.
 */
let containedReporterThrows = 0;

/**
 * Wraps a reporter so no channel of it can throw into its caller.
 *
 * A channel that throws is counted on `readContainedReporterThrows()`
 * and goes no further: the throw does not reach the probe, the
 * preference dispatch, a context-loss listener or a frame, and it is not
 * reported back through the sink that produced it.
 *
 * Every entry point that accepts a reporter wraps it here once. Wrapping
 * an already-wrapped reporter is harmless.
 *
 * @param reporter Reporter to contain.
 * @returns A frozen reporter delegating to `reporter` and throwing for
 *   nothing.
 */
export function createGuardedRenderReporter(
  reporter: RenderReporter,
): RenderReporter {
  return Object.freeze({
    onDiagnostic: (diagnostic: RenderDiagnostic): void => {
      try {
        reporter.onDiagnostic(diagnostic);
      } catch {
        containedReporterThrows += 1;
      }
    },

    onCount: (count: RenderCount): void => {
      try {
        reporter.onCount(count);
      } catch {
        containedReporterThrows += 1;
      }
    },

    onTiming: (timing: RenderTiming): void => {
      try {
        reporter.onTiming(timing);
      } catch {
        containedReporterThrows += 1;
      }
    },
  });
}

/**
 * Reads how many reporter invocations have been contained because the
 * sink threw.
 *
 * `0` for a sink that never throws. A non-zero value means reports have
 * been lost and the sink is faulty; it is read out of band, because a
 * contained throw is deliberately not reported through the sink that
 * produced it. src/observability/diagnostics-overlay.ts renders it.
 *
 * @returns The count, across every guarded reporter in this process.
 */
export function readContainedReporterThrows(): number {
  return containedReporterThrows;
}

/**
 * Resets the contained-throw count. Present for suites that assert on it.
 */
export function resetContainedReporterThrows(): void {
  containedReporterThrows = 0;
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

/** Longest name or message text a `RenderErrorInfo` carries. */
const MAX_ERROR_TEXT_LENGTH = 200;

/**
 * Shortens reported text to the declared limit.
 *
 * @param text Text to shorten.
 * @returns `text` when it is within the limit, otherwise its first
 *   `MAX_ERROR_TEXT_LENGTH` characters followed by an ellipsis.
 */
function capText(text: string): string {
  return text.length <= MAX_ERROR_TEXT_LENGTH
    ? text
    : `${text.slice(0, MAX_ERROR_TEXT_LENGTH)}…`;
}

/**
 * Reads a non-empty string property from an object of unknown shape.
 *
 * Total: the membership test and the read are both contained, because a
 * `Proxy` can throw from its `has` or `get` trap and an accessor can
 * throw from its getter. Either throw is read as an absent property.
 *
 * @param source Object to read from.
 * @param field Property name to read.
 * @returns The property value, capped in length, or `undefined` where it
 *   is absent, unreadable, not a string, or empty.
 */
function readStringField(source: object, field: string): string | undefined {
  let candidate: unknown;

  try {
    if (!(field in source)) {
      return undefined;
    }

    candidate = Reflect.get(source, field);
  } catch {
    return undefined;
  }

  return typeof candidate === 'string' && candidate.length > 0
    ? capText(candidate)
    : undefined;
}

/**
 * Converts a value to text without trusting its own conversion.
 *
 * `String()` invokes `toString` or `Symbol.toPrimitive`, either of which
 * can throw or return an unbounded string. A throw yields the fixed
 * fallback text, and the result is capped.
 *
 * @param value Value to convert.
 * @returns The converted text, capped, or the fixed fallback text.
 */
function safeText(value: unknown): string {
  try {
    return capText(String(value));
  } catch {
    return UNKNOWN_ERROR_MESSAGE;
  }
}

/**
 * Reduces a caught value of any type to serialisable fields, so a
 * report carries it rather than discarding it.
 *
 * Total: it accepts any value, including a `Proxy` whose traps throw and
 * an object whose `toString` throws, returns on every path, and throws
 * on none. Both fields are capped at `MAX_ERROR_TEXT_LENGTH`.
 *
 * @param error Caught value, of any type, including `null` and
 *   `undefined`.
 * @returns Frozen name and message fields.
 */
function describeError(error: unknown): RenderErrorInfo {
  if (error instanceof Error) {
    // An Error subclass can define `name` and `message` as throwing
    // accessors, so both are read through the contained reader.
    const info: RenderErrorInfo = {
      name: readStringField(error, 'name') ?? UNKNOWN_ERROR_NAME,
      message: readStringField(error, 'message') ?? UNKNOWN_ERROR_MESSAGE,
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
      typeof error === 'function' ? UNKNOWN_ERROR_MESSAGE : safeText(error),
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
   * Whether the probe context was released through
   * `WEBGL_lose_context`. `true` only for `contextRelease` `'released'`.
   */
  readonly contextReleased: boolean;

  /**
   * Why the probe context was or was not released: released, the
   * extension was unavailable, or the release attempt failed. The three
   * cases are distinct, so an unavailable extension is never read as a
   * failed release.
   */
  readonly contextRelease: ContextReleaseOutcome;
}

/** Mutable form of `WebGLSupportResult`, frozen before it is returned. */
interface WebGLSupportDraft {
  supported: boolean;
  level: WebGLContextLevel;
  failure?: WebGLProbeFailure;
  reason?: string;
  contextReleased: boolean;
  contextRelease: ContextReleaseOutcome;
}

/** One `getContext` attempt, and the value it threw if it threw. */
interface ContextAttempt {
  readonly context: WebGLRenderingContext | WebGL2RenderingContext | null;
  readonly error?: RenderErrorInfo;
}

/**
 * Outcome of releasing the probe context.
 *
 * `'extension-unavailable'` and `'release-failed'` are separate values
 * because they are different conditions: the first is a browser that
 * does not offer `WEBGL_lose_context`, the second is a call that threw.
 */
export type ContextReleaseOutcome =
  | 'released'
  | 'extension-unavailable'
  | 'release-failed';

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
 * Releases the probe context through `WEBGL_lose_context` where that
 * extension is present. Browsers cap simultaneous contexts, and the
 * probe holds one until it is released.
 *
 * @param context Context to release.
 * @returns `'released'` when `loseContext()` was called,
 *   `'extension-unavailable'` when the browser offers no such extension,
 *   and `'release-failed'` when obtaining it or calling it threw.
 */
function releaseContext(
  context: WebGLRenderingContext | WebGL2RenderingContext,
): ContextReleaseOutcome {
  let extension: WEBGL_lose_context | null;

  try {
    extension = context.getExtension('WEBGL_lose_context');
  } catch {
    return 'release-failed';
  }

  if (extension === null || typeof extension.loseContext !== 'function') {
    return 'extension-unavailable';
  }

  try {
    extension.loseContext();
  } catch {
    return 'release-failed';
  }

  return 'released';
}

/**
 * Builds the frozen result for a probe that obtained a context, and
 * releases that context.
 *
 * The context's identifying strings are not read. No extension is
 * requested other than `WEBGL_lose_context`, which carries no identity,
 * so nothing describing the machine's graphics stack enters the result
 * or any report derived from it.
 *
 * @param level Level that was obtained.
 * @param context Context that was obtained.
 * @returns The frozen supported result.
 */
function supportedResult(
  level: ProbeLevel,
  context: WebGLRenderingContext | WebGL2RenderingContext,
): WebGLSupportResult {
  const contextRelease = releaseContext(context);
  const draft: WebGLSupportDraft = {
    supported: true,
    level,
    contextReleased: contextRelease === 'released',
    contextRelease,
  };

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
    contextReleased: false,
    contextRelease: 'extension-unavailable',
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
    contextReleased: result.contextReleased,
    contextRelease: result.contextRelease,
    failure: result.failure ?? null,
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
 * `'webgl'`, releases the context through `WEBGL_lose_context` where
 * that extension is present, and discards the canvas. It touches no
 * element in the document and throws on no path, including where there
 * is no document at all.
 *
 * It reads no identifying string from the context and requests no
 * extension that carries one, so the result and every report derived
 * from it describe capability only: whether a context was obtained, at
 * which level, why not, and how the probe context was released.
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
 */
export function probeWebGLSupport(
  reporter: RenderReporter = NOOP_RENDER_REPORTER,
): WebGLSupportResult {
  const held = cachedSupport;

  if (held !== undefined) {
    return held;
  }

  const guarded = createGuardedRenderReporter(reporter);
  const startedAt = monotonicNow();
  const result = runProbe();
  const durationMs = monotonicNow() - startedAt;

  cachedSupport = result;

  const detail: RenderDetail = Object.freeze({
    supported: result.supported,
    level: result.level,
  });

  guarded.onTiming({ name: PROBE_METRIC, durationMs, detail });
  guarded.onCount({ name: PROBE_METRIC, value: 1, detail });
  guarded.onDiagnostic(describeSupport(result));

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
export type MotionPreferenceSource =
  | 'override'
  | 'media-query'
  | 'fail-safe'
  | 'default';

/**
 * State of the reduced-motion media query.
 *
 * `'absent'` is a platform that offers no `matchMedia` at all, which
 * expresses no preference. `'failed'` is a `matchMedia` that exists and
 * threw, or a query list whose `matches` could not be read; that is an
 * unknown preference, not an absent one, and it resolves to reduced
 * motion.
 */
export type MotionQueryStatus = 'available' | 'absent' | 'failed';

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
   * query answered, `'fail-safe'` where the query exists but could not
   * be read, and `'default'` where no query mechanism exists at all.
   */
  readonly source: MotionPreferenceSource;

  /** Whether `matchMedia` produced a usable query list. */
  readonly mediaQuerySupported: boolean;

  /**
   * State of the query: available, absent, or present and failing. This
   * is what distinguishes a platform with no `matchMedia` from a
   * `matchMedia` that threw.
   */
  readonly queryStatus: MotionQueryStatus;

  /** The override in force, or `null` where the query governs. */
  readonly override: boolean | null;

  /**
   * The error the query reported, present only when `queryStatus` is
   * `'failed'`.
   */
  readonly error?: RenderErrorInfo;
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

/**
 * The error a `matchMedia` call or a `matches` read reported, held while
 * the query is failing. `undefined` while the query is available or
 * absent.
 */
let motionQueryError: RenderErrorInfo | undefined;

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
 * successful call.
 *
 * Distinguishes the two ways no query list is obtained. An absent
 * `matchMedia` — a non-DOM test environment, or an older surface — is
 * `'absent'` and expresses no preference. A `matchMedia` that throws, or
 * that returns a value carrying no boolean `matches`, is `'failed'`: the
 * preference is unknown, and `readMotionPreference()` resolves an unknown
 * preference to reduced motion.
 *
 * @returns The query list and its status, with the error the failure
 *   reported where there was one.
 */
function resolveMotionQueryList(): {
  readonly list?: MediaQueryList;
  readonly status: MotionQueryStatus;
  readonly error?: RenderErrorInfo;
} {
  if (motionQueryList !== undefined) {
    return { list: motionQueryList, status: 'available' };
  }

  if (typeof globalThis.matchMedia !== 'function') {
    return { status: 'absent' };
  }

  if (motionQueryError !== undefined) {
    return { status: 'failed', error: motionQueryError };
  }

  try {
    const created: unknown = globalThis.matchMedia(REDUCED_MOTION_QUERY);

    if (!isMediaQueryList(created)) {
      motionQueryError = Object.freeze({
        name: UNKNOWN_ERROR_NAME,
        message:
          'matchMedia returned a value carrying no boolean "matches"; ' +
          'the reduced-motion preference could not be read.',
      });

      return { status: 'failed', error: motionQueryError };
    }

    motionQueryList = created;

    return { list: created, status: 'available' };
  } catch (error: unknown) {
    motionQueryError = describeError(error);

    return { status: 'failed', error: motionQueryError };
  }
}

/**
 * Reads a query list's `matches` without trusting the accessor.
 *
 * @param list Query list to read.
 * @returns The boolean the list reported, or `undefined` where the read
 *   threw. A throw is recorded as a query failure.
 */
function readMotionMatches(list: MediaQueryList): boolean | undefined {
  try {
    return list.matches;
  } catch (error: unknown) {
    motionQueryError = describeError(error);

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
 * Resolution order: an override wins; then the media query's answer;
 * then, where the query exists but could not be read, reduced motion as
 * the fail-safe; and finally, where no query mechanism exists at all, no
 * preference expressed.
 *
 * @returns The frozen, serialisable preference.
 */
export function readMotionPreference(): MotionPreference {
  const resolved = resolveMotionQueryList();
  const override = motionOverride;
  const list = resolved.list;
  const matches = list === undefined ? undefined : readMotionMatches(list);
  const status: MotionQueryStatus =
    list === undefined
      ? resolved.status
      : matches === undefined
        ? 'failed'
        : 'available';
  const error = status === 'failed' ? motionQueryError : undefined;

  if (override !== null) {
    return Object.freeze({
      reduced: override,
      source: 'override' as const,
      mediaQuerySupported: status === 'available',
      queryStatus: status,
      override,
      ...(error === undefined ? {} : { error }),
    });
  }

  if (matches !== undefined) {
    return Object.freeze({
      reduced: matches,
      source: 'media-query' as const,
      mediaQuerySupported: true,
      queryStatus: status,
      override,
    });
  }

  if (status === 'failed') {
    // The preference exists and could not be read. Reducing motion is
    // the safe resolution of an unknown answer.
    return Object.freeze({
      reduced: true,
      source: 'fail-safe' as const,
      mediaQuerySupported: false,
      queryStatus: status,
      override,
      ...(error === undefined ? {} : { error }),
    });
  }

  return Object.freeze({
    reduced: false,
    source: 'default' as const,
    mediaQuerySupported: false,
    queryStatus: status,
    override,
  });
}

/**
 * Reads the effective reduced-motion preference.
 *
 * Returns the override where one is set, the media query's answer where
 * the query is available, `true` where the query exists but could not be
 * read, and `false` where no query mechanism exists at all. An absent
 * `matchMedia` is no preference expressed; a `matchMedia` that throws is
 * an unknown preference and resolves to reduced motion. Neither case
 * throws.
 *
 * @returns Whether motion is to be reduced.
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

  const list = resolveMotionQueryList().list;

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
 */
export function subscribeReducedMotion(
  listener: ReducedMotionListener,
  reporter: RenderReporter = NOOP_RENDER_REPORTER,
): () => void {
  const subscription: MotionSubscription = {
    listener,
    reporter: createGuardedRenderReporter(reporter),
  };

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
  motionQueryError = undefined;
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
 * @param sink Sink for both transitions and for a handler that throws.
 *   Contained before use. Defaults to `NOOP_RENDER_REPORTER`.
 * @returns A detach function removing both listeners. Calling it more
 *   than once is harmless.
 */
export function attachContextLossHandlers(
  canvas: HTMLCanvasElement,
  handlers: ContextLossHandlers = {},
  sink: RenderReporter = NOOP_RENDER_REPORTER,
): () => void {
  // Contained once here, so neither listener below can be broken by a
  // sink that throws while the browser is dispatching to it.
  const reporter = createGuardedRenderReporter(sink);

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

