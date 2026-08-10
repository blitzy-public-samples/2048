/**
 * Frame scheduling for src/render/, and the frame-callback seam.
 *
 * A registered callback receives the frame's timestamp, delta, elapsed time
 * and index, and the scheduled frame is cancellable. `requestAnimationFrame`
 * and `cancelAnimationFrame` are read through guards and are never assumed
 * present; nothing here writes to the global object.
 *
 * One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
 * this module's area enumerated:
 *   TR-LOOP-01  js/html_actuator.js L11-L35   the outer
 *                                             `requestAnimationFrame`, ported
 *                                             as `createRenderLoop()` and its
 *                                             scheduled frame
 *   TR-LOOP-02  js/html_actuator.js L66-L69   the nested
 *                                             `requestAnimationFrame`, ported
 *                                             as the two-phase paint a
 *                                             `FrameCallback` requests
 *   TR-LOOP-03  js/animframe_polyfill.js      the shim's presence assumption,
 *                                             replaced by
 *                                             `isFrameSchedulingAvailable()`
 *                                             and the guarded reads
 *   TR-LOOP-04  target-only row               `FrameContext` and
 *                                             `FrameSubscription`
 *   TR-LOOP-05  target-only row               `onFrameBegin` and `onFrameEnd`,
 *                                             the frame-callback seam a tracer
 *                                             spans
 *   TR-LOOP-06  target-only row               `FrameStats`,
 *                                             `FrameDurationBucket` and
 *                                             `getFrameStats()`
 *   TR-LOOP-07  target-only row               `FrameScheduler`, the injected
 *                                             scheduler and clock
 *
 * Decisions: DL-LOOP-01, DL-LOOP-02, DL-LOOP-03, DL-LOOP-04
 * (docs/DECISION_LOG.md).
 */

import {
  NOOP_RENDER_REPORTER,
  createGuardedRenderReporter,
  describeRenderError,
  type RenderReporter,
} from './webgl-support';

/** State of one frame, as that frame's callbacks and hooks see it. */
export interface FrameContext {
  /**
   * Timestamp the frame callback was invoked with, in milliseconds, exactly as
   * supplied and never adjusted.
   */
  readonly timestamp: number;

  /**
   * Milliseconds since the previous frame, clamped to the loop's `maxDelta`.
   * Never negative, and `0` on the first frame after the loop becomes active.
   */
  readonly delta: number;

  /**
   * Milliseconds since the previous frame before clamping. Equal to `delta` on
   * every frame whose `deltaClamped` is `false`.
   */
  readonly rawDelta: number;

  /** Whether `rawDelta` exceeded `maxDelta`, so `delta` was clamped. */
  readonly deltaClamped: boolean;

  /**
   * Milliseconds since the first frame of the current activation. `start`
   * following `stop` restarts it at `0`; an idle park and a later resume do
   * not.
   */
  readonly elapsed: number;

  /**
   * Index of this frame, counting from `1` and rising by exactly one per frame
   * for the lifetime of the loop. `start`, `stop` and `resetFrameStats` leave
   * it untouched.
   */
  readonly frame: number;
}

/**
 * Work performed once per frame.
 *
 * Returning `true` declares that work is still outstanding and a further frame
 * is wanted; any other return value, including none, declares this callback
 * idle for the frame. The declaration is read only by a loop constructed with
 * `autoStopWhenIdle`.
 *
 * A callback that throws is caught and reported, and the remaining callbacks
 * of the frame still run. Whether a further frame follows is then decided as
 * usual, so a loop with `autoStopWhenIdle` still parks once no callback has
 * declared outstanding work.
 */
export type FrameCallback = (context: FrameContext) => boolean | void;

/** Registration handle `addFrameCallback` returns. */
export interface FrameSubscription {
  /**
   * Identifier of this registration, unique within one loop and rising by one
   * per registration.
   */
  readonly id: number;

  /**
   * Removes the callback. Safe to call from inside a frame, in which case the
   * callback runs no further frames.
   *
   * @returns `true` from the call that removed the callback, and `false`
   *   from every later call.
   */
  readonly remove: () => boolean;
}

/**
 * The two scheduling operations a loop needs, injectable in place of the
 * platform pair.
 */
export interface FrameScheduler {
  /**
   * Schedules one callback.
   *
   * The callback may be invoked either after `request` returns, as
   * `requestAnimationFrame` does, or before it returns, which is what a
   * deterministic test double does when it calls the callback inline. Both are
   * supported.
   *
   * @param callback Invoked with the frame timestamp in milliseconds.
   * @returns Handle that `cancel` accepts. A handle returned by an inline
   *   implementation is already spent and is not retained.
   */
  readonly request: (callback: (timestamp: number) => void) => number;

  /**
   * Cancels a callback that has been scheduled and not yet run.
   *
   * @param handle Handle a `request` call returned.
   */
  readonly cancel: (handle: number) => void;
}

/**
 * How frame durations reach `RenderReporter.onTiming`. Defaults to
 * `'aggregate'`.
 */
export type FrameTimingMode = 'none' | 'aggregate' | 'frame';

/** Every construction parameter of a loop. All are optional. */
export interface RenderLoopOptions {
  /**
   * Sink for frame timings, counters and contained throws. Defaults to
   * `NOOP_RENDER_REPORTER`.
   */
  readonly reporter?: RenderReporter;

  /**
   * Upper bound applied to `FrameContext.delta`, in milliseconds. Defaults to
   * `DEFAULT_MAX_DELTA`.
   */
  readonly maxDelta?: number;

  /**
   * Whether the loop parks itself once no callback reports outstanding work.
   * Defaults to `false`, in which case `start` schedules frames until `stop`.
   */
  readonly autoStopWhenIdle?: boolean;

  /**
   * Consecutive frames with no outstanding work that precede a park. Defaults
   * to `DEFAULT_IDLE_FRAMES`.
   */
  readonly idleFrames?: number;

  /**
   * Called once per frame, before that frame's callbacks. A throw is reported
   * and contained.
   */
  readonly onFrameBegin?: (context: FrameContext) => void;

  /**
   * Called once per frame, after that frame's callbacks, with the milliseconds
   * those callbacks and `onFrameBegin` together occupied. The value is never
   * negative.
   */
  readonly onFrameEnd?: (context: FrameContext, durationMs: number) => void;

  /**
   * Scheduling pair to use in place of the platform pair. Defaults to
   * `requestAnimationFrame` and `cancelAnimationFrame`, each read at the
   * moment it is needed.
   */
  readonly scheduler?: FrameScheduler;

  /** Monotonic clock used to measure frame duration, in milliseconds. */
  readonly now?: () => number;

  /** How frame durations are reported. Defaults to `'aggregate'`. */
  readonly timingMode?: FrameTimingMode;

  /**
   * Inclusive upper bounds of the frame-duration histogram, in milliseconds.
   * Defaults to `DEFAULT_FRAME_DURATION_BOUNDS`.
   */
  readonly durationBounds?: readonly number[];
}

/** One cumulative bucket of the frame-duration histogram. */
export interface FrameDurationBucket {
  /** Inclusive upper bound of the bucket, in milliseconds. */
  readonly le: number;

  /** Frames whose duration was at most `le`. */
  readonly count: number;
}

/**
 * Frame measurements, read synchronously and returned as plain data: booleans,
 * numbers and arrays of objects of numbers, with no class instance, scheduling
 * handle, callback or live reference, so `JSON.stringify` round-trips the
 * snapshot and later frames do not mutate it.
 */
export interface FrameStats {
  /** Whether the loop is scheduling frames continuously. */
  readonly running: boolean;

  /** Whether the loop parked itself on an idle frame. */
  readonly parked: boolean;

  /** Whether a scheduled frame has yet to run. */
  readonly framePending: boolean;

  /**
   * Whether the scheduling pair this loop uses is available. `false` reports
   * that `start` and `requestFrame` can schedule nothing.
   */
  readonly schedulingAvailable: boolean;

  /** Callbacks currently registered. */
  readonly callbacks: number;

  /** Frames run over the lifetime of the loop. */
  readonly frames: number;

  /** Frames covered by the sampled fields of this snapshot. */
  readonly sampledFrames: number;

  /** Duration of the most recent frame, or `0` before the first. */
  readonly lastFrameDuration: number;

  /** Mean sampled frame duration, or `0` with no sampled frame. */
  readonly meanFrameDuration: number;

  /** Shortest sampled frame duration, or `0` with no sampled frame. */
  readonly minFrameDuration: number;

  /** Longest sampled frame duration, or `0` with no sampled frame. */
  readonly maxFrameDuration: number;

  /** Sum of the sampled frame durations. */
  readonly totalFrameDuration: number;

  /** Clamped delta of the most recent frame. */
  readonly lastDelta: number;

  /** Mean sampled clamped delta, or `0` with no sampled frame. */
  readonly meanDelta: number;

  /** Largest sampled clamped delta. */
  readonly maxDelta: number;

  /** Clamp this loop applies to a delta, from `maxDelta`. */
  readonly deltaClampLimit: number;

  /** Sampled frames whose raw delta exceeded `deltaClampLimit`. */
  readonly clampedDeltas: number;

  /** Sampled frame callbacks that threw and were contained. */
  readonly callbackErrors: number;

  /** Sampled `onFrameBegin` and `onFrameEnd` calls that threw. */
  readonly hookErrors: number;

  /** Times the loop parked itself on an idle frame. */
  readonly idleParks: number;

  /** `FrameContext.elapsed` of the most recent frame. */
  readonly elapsed: number;

  /** Cumulative frame-duration histogram, bounds ascending. */
  readonly durationBuckets: readonly FrameDurationBucket[];

  /**
   * Sampled frames whose duration exceeded the highest bucket bound. The
   * overflow bucket of `durationBuckets`.
   */
  readonly framesOverBounds: number;
}

/**
 * A frame loop: the scheduler of every per-frame callback in src/render/, and
 * the seam those frames are measured across.
 */
export interface RenderLoop {
  /** Begins scheduling frames continuously, and resumes a parked loop. */
  readonly start: () => void;

  /** Stops scheduling and cancels the pending frame, if any. */
  readonly stop: () => void;

  /**
   * @returns Whether the loop is scheduling frames continuously.
   */
  readonly isRunning: () => boolean;

  /**
   * @returns Whether the loop parked itself on an idle frame.
   */
  readonly isParked: () => boolean;

  /**
   * @returns Whether a scheduled frame has yet to run.
   */
  readonly isFramePending: () => boolean;

  /** Schedules a single frame without starting continuous scheduling. */
  readonly requestFrame: () => void;

  /** Declares outstanding work and ensures a frame runs. */
  readonly invalidate: () => void;

  /**
   * Registers a callback, which runs on every frame from the next one onwards.
   * Registration order is dispatch order, and a callback registered from
   * inside a frame first runs on the following frame.
   *
   * @param callback Work to perform once per frame.
   * @returns A handle carrying the registration's identifier and its removal
   *   operation.
   */
  readonly addFrameCallback: (callback: FrameCallback) => FrameSubscription;

  /**
   * Removes a registered callback by identity. Where one callback was
   * registered more than once, the earliest registration still present is
   * removed.
   *
   * @param callback Callback to remove.
   * @returns Whether a registration was removed.
   */
  readonly removeFrameCallback: (callback: FrameCallback) => boolean;

  /**
   * @returns A snapshot of the frame measurements, as plain data.
   */
  readonly getFrameStats: () => FrameStats;

  /**
   * Clears the sampled measurements, having first reported anything an
   * aggregate measurement still owed. The lifetime frame index, the registered
   * callbacks and the running state are untouched.
   */
  readonly resetFrameStats: () => void;
}

/** Source field carried by every diagnostic this module emits. */
const DIAGNOSTIC_SOURCE = 'render/render-loop';

/** Timer name for a single frame's duration. */
const FRAME_TIMING_METRIC = 'render.frame';

/** Timer name for the summed duration of a batch of frames. */
const FRAME_BATCH_TIMING_METRIC = 'render.frame.batch';

/** Counter name for frames run. */
const FRAME_COUNT_METRIC = 'render.frame.count';

/** Counter name for a frame callback that threw. */
const CALLBACK_ERROR_METRIC = 'render.frame.callback.error';

/** Counter name for a frame hook that threw. */
const HOOK_ERROR_METRIC = 'render.frame.hook.error';

/** Counter name for a delta that was clamped. */
const DELTA_CLAMPED_METRIC = 'render.frame.delta.clamped';

/** Counter name for the loop starting. */
const LOOP_START_METRIC = 'render.loop.start';

/** Counter name for the loop stopping. */
const LOOP_STOP_METRIC = 'render.loop.stop';

/** Counter name for the loop parking itself on an idle frame. */
const LOOP_PARK_METRIC = 'render.loop.park';

/** Counter name for a parked loop resuming. */
const LOOP_RESUME_METRIC = 'render.loop.resume';

/** Counter name for an absent scheduling pair. */
const SCHEDULER_UNAVAILABLE_METRIC = 'render.loop.scheduler.unavailable';

/** Counter name for a scheduling operation that threw. */
const SCHEDULER_ERROR_METRIC = 'render.loop.scheduler.error';

/** Counter for a synchronous frame chain that reached its limit. */
const SCHEDULER_CHAIN_METRIC = 'render.loop.scheduler.chain.bounded';

/** Counter name for a rejected construction parameter. */
const INVALID_OPTION_METRIC = 'render.loop.option.invalid';

/** Counter name for a rejected callback registration. */
const INVALID_CALLBACK_METRIC = 'render.loop.callback.invalid';

/** Nominal interval between frames of a 60 Hz display, in milliseconds. */
const NOMINAL_FRAME_INTERVAL = 1000 / 60;

/** Nominal frames of time that `DEFAULT_MAX_DELTA` spans. */
const DEFAULT_MAX_DELTA_FRAMES = 4;

/**
 * Default upper bound on `FrameContext.delta`, in milliseconds: four nominal
 * 60 Hz frames.
 */
export const DEFAULT_MAX_DELTA =
  NOMINAL_FRAME_INTERVAL * DEFAULT_MAX_DELTA_FRAMES;

/**
 * Default number of consecutive frames without outstanding work that precede
 * an idle park.
 */
export const DEFAULT_IDLE_FRAMES = 1;

/**
 * Default inclusive upper bounds of the frame-duration histogram, in
 * milliseconds. src/observability/metrics.ts labels its buckets with these
 * values.
 */
export const DEFAULT_FRAME_DURATION_BOUNDS: readonly number[] =
  Object.freeze([1, 2, 4, 8, 16, 33, 50, 100]);

/**
 * Most frames one entry into scheduling will drive from a scheduler that
 * invokes the frame callback inline, before the loop stops chaining and
 * reports.
 *
 * The platform pair is unaffected: `requestAnimationFrame` returns before its
 * callback runs, so a chain it drives is one frame deep and never counts past
 * one.
 */
export const DEFAULT_MAX_SYNCHRONOUS_CHAIN = 1024;

/**
 * Reads a monotonic clock where one exists, falling back to the wall clock.
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
 * @param callback Invoked with the frame timestamp in milliseconds.
 * @returns The scheduling handle, or `undefined` where the platform supplies
 *   no `requestAnimationFrame`.
 */
function platformRequestFrame(
  callback: (timestamp: number) => void,
): number | undefined {
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    return undefined;
  }

  return globalThis.requestAnimationFrame(callback);
}

/**
 * Cancels one frame through the platform pair.
 *
 * @param handle Handle a `platformRequestFrame` call returned.
 */
function platformCancelFrame(handle: number): void {
  if (typeof globalThis.cancelAnimationFrame !== 'function') {
    return;
  }

  globalThis.cancelAnimationFrame(handle);
}

/**
 * Reports whether frames can be scheduled at all.
 *
 * @param scheduler Injected pair to test. Omitted, the platform pair
 *   `requestAnimationFrame` and `cancelAnimationFrame` is tested.
 * @returns Whether both scheduling operations are available.
 */
export function isFrameSchedulingAvailable(
  scheduler?: FrameScheduler,
): boolean {
  if (scheduler !== undefined) {
    return (
      typeof scheduler.request === 'function' &&
      typeof scheduler.cancel === 'function'
    );
  }

  return (
    typeof globalThis.requestAnimationFrame === 'function' &&
    typeof globalThis.cancelAnimationFrame === 'function'
  );
}

/**
 * Reports one rejected construction parameter.
 *
 * @param reporter Sink the rejection is reported to.
 * @param option Parameter name, as `'maxDelta'`.
 * @param fallback Value used in its place.
 */
function reportInvalidOption(
  reporter: RenderReporter,
  option: string,
  fallback: number,
): void {
  reporter.onCount({
    name: INVALID_OPTION_METRIC,
    value: 1,
    detail: Object.freeze({ option }),
  });
  reporter.onDiagnostic({
    level: 'warning',
    source: DIAGNOSTIC_SOURCE,
    message: `The ${option} option was rejected; the default was used.`,
    detail: Object.freeze({ option, fallback }),
  });
}

/**
 * Validates the delta clamp.
 *
 * @param value Supplied clamp, in milliseconds, or `undefined`.
 * @param reporter Sink a rejection is reported to.
 * @returns The supplied clamp where it is a finite number above zero, and
 *   `DEFAULT_MAX_DELTA` otherwise.
 */
function resolveMaxDelta(
  value: number | undefined,
  reporter: RenderReporter,
): number {
  if (value === undefined) {
    return DEFAULT_MAX_DELTA;
  }

  if (Number.isFinite(value) && value > 0) {
    return value;
  }

  reportInvalidOption(reporter, 'maxDelta', DEFAULT_MAX_DELTA);

  return DEFAULT_MAX_DELTA;
}

/**
 * Validates the idle-frame threshold.
 *
 * @param value Supplied threshold, in frames, or `undefined`.
 * @param reporter Sink a rejection is reported to.
 * @returns The supplied threshold where it is an integer of at least one,
 *   and `DEFAULT_IDLE_FRAMES` otherwise.
 */
function resolveIdleFrames(
  value: number | undefined,
  reporter: RenderReporter,
): number {
  if (value === undefined) {
    return DEFAULT_IDLE_FRAMES;
  }

  if (Number.isInteger(value) && value >= 1) {
    return value;
  }

  reportInvalidOption(reporter, 'idleFrames', DEFAULT_IDLE_FRAMES);

  return DEFAULT_IDLE_FRAMES;
}

/**
 * Validates the histogram bounds, dropping unusable values and normalising
 * what remains.
 *
 * @param value Supplied bounds, in milliseconds, or `undefined`.
 * @param reporter Sink a rejection is reported to.
 * @returns Frozen ascending bounds with no duplicate, and
 *   `DEFAULT_FRAME_DURATION_BOUNDS` where the argument leaves none.
 */
function resolveDurationBounds(
  value: readonly number[] | undefined,
  reporter: RenderReporter,
): readonly number[] {
  if (value === undefined) {
    return DEFAULT_FRAME_DURATION_BOUNDS;
  }

  const usable = value.filter(
    (bound): boolean => Number.isFinite(bound) && bound > 0,
  );

  if (usable.length === 0) {
    reportInvalidOption(
      reporter,
      'durationBounds',
      DEFAULT_FRAME_DURATION_BOUNDS.length,
    );

    return DEFAULT_FRAME_DURATION_BOUNDS;
  }

  const ascending = [...new Set(usable)].sort(
    (left, right): number => left - right,
  );

  return Object.freeze(ascending);
}

/** One callback registration, held in dispatch order. */
interface FrameEntry {
  /** Identifier reported alongside a contained throw. */
  readonly id: number;

  /** The registered callback. */
  readonly callback: FrameCallback;

  /**
   * Whether the registration still runs. A removal clears it, and during a
   * frame defers the splice until that frame's dispatch has finished.
   */
  active: boolean;
}

/** Writable form of `FrameContext`, reused across the frames of a loop. */
interface MutableFrameContext {
  timestamp: number;
  delta: number;
  rawDelta: number;
  deltaClamped: boolean;
  elapsed: number;
  frame: number;
}

/** Which hook a contained throw came from. */
type FrameHookName = 'frame-begin' | 'frame-end';

/** Which scheduling operation a contained throw came from. */
type SchedulerOperation = 'request' | 'cancel';

/**
 * Creates a frame loop.
 *
 * @param options Construction parameters. Defaults are described on
 *   `RenderLoopOptions`.
 * @returns A frozen loop.
 */
export function createRenderLoop(
  options: RenderLoopOptions = {},
): RenderLoop {
  // Contained once here, so no report emitted from a frame, a scheduler call,
  // a hook or a park can be turned into a loop failure by a sink that throws.
  const reporter = createGuardedRenderReporter(
    options.reporter ?? NOOP_RENDER_REPORTER,
  );
  const scheduler = options.scheduler;
  const clock = options.now ?? monotonicNow;
  const hookBegin = options.onFrameBegin;
  const hookEnd = options.onFrameEnd;
  const timingMode: FrameTimingMode = options.timingMode ?? 'aggregate';
  const autoStopWhenIdle = options.autoStopWhenIdle === true;
  const maxDelta = resolveMaxDelta(options.maxDelta, reporter);
  const idleFrames = resolveIdleFrames(options.idleFrames, reporter);
  const bounds = resolveDurationBounds(options.durationBounds, reporter);

  /** Registrations, in dispatch order. */
  const entries: FrameEntry[] = [];

  /** Non-cumulative bucket counters, one per bound. */
  const bucketCounts: number[] = bounds.map((): number => 0);

  /** The one context instance every frame of this loop reuses. */
  const context: MutableFrameContext = {
    timestamp: 0,
    delta: 0,
    rawDelta: 0,
    deltaClamped: false,
    elapsed: 0,
    frame: 0,
  };

  let lastSubscriptionId = 0;
  let pendingHandle: number | null = null;
  let framePending = false;
  let running = false;
  let parked = false;
  let dispatching = false;
  let stopRequested = false;
  let frameRequested = false;
  let workPending = false;
  let idleStreak = 0;
  let removalPending = false;

  /**
   * Whether a `scheduleFrame` call is on the stack. A scheduler that invokes
   * the frame callback inline completes a whole frame inside `request`, and
   * the end of that frame settles the next one, so scheduling re-enters
   * itself.
   */
  let scheduling = false;

  /**
   * Whether a re-entrant `scheduleFrame` asked for another frame while the
   * outermost call held the slot. Read and cleared by that call.
   */
  let chainRequested = false;

  let frameIndex = 0;
  let origin: number | undefined;
  let previousTimestamp: number | undefined;

  let sampledFrames = 0;
  let lastFrameDuration = 0;
  let totalFrameDuration = 0;
  let minFrameDuration = 0;
  let maxFrameDuration = 0;
  let lastDelta = 0;
  let totalDelta = 0;
  let maxObservedDelta = 0;
  let clampedDeltas = 0;
  let callbackErrors = 0;
  let hookErrors = 0;
  let idleParks = 0;
  let framesOverBounds = 0;
  let unreportedFrames = 0;
  let unreportedDuration = 0;

  /**
   * Reports a frame callback that threw, and counts it.
   *
   * @param id Identifier of the registration that threw.
   * @param error Thrown value.
   */
  const reportCallbackThrow = (id: number, error: unknown): void => {
    callbackErrors += 1;

    const detail = Object.freeze({ callbackId: id, frame: frameIndex });

    reporter.onCount({ name: CALLBACK_ERROR_METRIC, value: 1, detail });
    reporter.onDiagnostic({
      level: 'error',
      source: DIAGNOSTIC_SOURCE,
      message: 'A frame callback threw and was contained.',
      detail,
      error: describeRenderError(error),
      thrown: error,
    });
  };

  /**
   * Reports a frame hook that threw, and counts it.
   *
   * @param hook Hook that threw.
   * @param error Thrown value.
   */
  const reportHookThrow = (hook: FrameHookName, error: unknown): void => {
    hookErrors += 1;

    const detail = Object.freeze({ hook, frame: frameIndex });

    reporter.onCount({ name: HOOK_ERROR_METRIC, value: 1, detail });
    reporter.onDiagnostic({
      level: 'error',
      source: DIAGNOSTIC_SOURCE,
      message: `The ${hook} hook threw and was contained.`,
      detail,
      error: describeRenderError(error),
      thrown: error,
    });
  };

  /**
   * Reports a scheduling operation that threw.
   *
   * @param operation Operation that threw.
   * @param error Thrown value.
   */
  const reportSchedulerThrow = (
    operation: SchedulerOperation,
    error: unknown,
  ): void => {
    const detail = Object.freeze({ operation, frame: frameIndex });

    reporter.onCount({ name: SCHEDULER_ERROR_METRIC, value: 1, detail });
    reporter.onDiagnostic({
      level: 'error',
      source: DIAGNOSTIC_SOURCE,
      message: `The frame ${operation} operation threw.`,
      detail,
      error: describeRenderError(error),
      thrown: error,
    });
  };

  /**
   * Reports a synchronous frame chain that reached its limit, and so was not
   * continued.
   *
   * @param frames Inline frames the chain drove before stopping.
   */
  const reportChainBound = (frames: number): void => {
    const detail = Object.freeze({
      frames,
      limit: DEFAULT_MAX_SYNCHRONOUS_CHAIN,
      frame: frameIndex,
    });

    reporter.onCount({ name: SCHEDULER_CHAIN_METRIC, value: 1, detail });
    reporter.onDiagnostic({
      level: 'warning',
      source: DIAGNOSTIC_SOURCE,
      message:
        'A synchronous frame scheduler drove the chain to its limit; ' +
        'scheduling stopped. The scheduler invokes the frame callback ' +
        'before returning, so it never yields, and this loop has no ' +
        'self-terminating condition: enable autoStopWhenIdle, stop ' +
        'reporting work outstanding, or supply a scheduler that defers.',
      detail,
    });
  };

  /** Reports that no frame could be scheduled. */
  const reportSchedulingUnavailable = (): void => {
    reporter.onCount({ name: SCHEDULER_UNAVAILABLE_METRIC, value: 1 });
    reporter.onDiagnostic({
      level: 'error',
      source: DIAGNOSTIC_SOURCE,
      message:
        'No frame scheduling is available; no frame was scheduled. ' +
        'A non-WebGL rendering path has to drive the board instead.',
    });
  };

  /**
   * Reports one clamped delta.
   *
   * @param rawDelta Delta measured before the clamp was applied.
   */
  const reportClampedDelta = (rawDelta: number): void => {
    reporter.onCount({
      name: DELTA_CLAMPED_METRIC,
      value: 1,
      detail: Object.freeze({
        frame: frameIndex,
        rawDelta,
        delta: maxDelta,
      }),
    });
  };

  /**
   * Reports the frames measured since the previous report, where the loop is
   * reporting in aggregate and at least one frame is owed.
   */
  const flushBatchTiming = (): void => {
    if (timingMode !== 'aggregate' || unreportedFrames === 0) {
      return;
    }

    const frames = unreportedFrames;
    const duration = unreportedDuration;

    unreportedFrames = 0;
    unreportedDuration = 0;

    reporter.onCount({ name: FRAME_COUNT_METRIC, value: frames });
    reporter.onTiming({
      name: FRAME_BATCH_TIMING_METRIC,
      durationMs: duration,
      detail: Object.freeze({
        frames,
        meanMs: duration / frames,
        maxMs: maxFrameDuration,
        clampedDeltas,
      }),
    });
  };

  /** Cancels the pending frame, if one is pending. */
  const cancelPendingFrame = (): void => {
    const handle = pendingHandle;

    pendingHandle = null;
    framePending = false;

    if (handle === null) {
      return;
    }

    try {
      if (scheduler === undefined) {
        platformCancelFrame(handle);
      } else {
        scheduler.cancel(handle);
      }
    } catch (error: unknown) {
      reportSchedulerThrow('cancel', error);
    }
  };

  /**
   * Issues one request to the scheduler.
   *
   * @returns `'pending'` where the frame is scheduled and has not run,
   *   `'ran'` where the scheduler invoked the callback before returning, and
   *   `'failed'` where no frame could be scheduled at all.
   */
  const requestOneFrame = (): 'pending' | 'ran' | 'failed' => {
    const ticket = frameIndex;
    let handle: number | undefined;

    try {
      handle =
        scheduler === undefined
          ? platformRequestFrame(runFrame)
          : scheduler.request(runFrame);
    } catch (error: unknown) {
      reportSchedulerThrow('request', error);

      return 'failed';
    }

    if (handle === undefined) {
      reportSchedulingUnavailable();

      return 'failed';
    }

    // The frame index advances once per frame, so an index that moved while
    // `request` was on the stack is the signal that the scheduler invoked the
    // callback inline.
    if (frameIndex !== ticket) {
      return 'ran';
    }

    framePending = true;
    pendingHandle = handle;

    return 'pending';
  };

  /**
   * Schedules one frame, unless one is already pending.
   *
   * @returns Whether a frame was scheduled or run. `false` only where the
   *   scheduler could schedule nothing, which is the signal callers use to
   *   undo a state change they had made in anticipation.
   */
  const scheduleFrame = (): boolean => {
    if (framePending) {
      return true;
    }

    // Re-entered from inside a frame an inline scheduler is running.
    if (scheduling) {
      chainRequested = true;

      return true;
    }

    scheduling = true;

    try {
      let inlineFrames = 0;

      for (;;) {
        chainRequested = false;

        const outcome = requestOneFrame();

        if (outcome === 'failed') {
          // A chain that already ran frames succeeded at what it was asked to
          // do; only a first request that schedules nothing is reported as a
          // failure to the caller.
          return inlineFrames > 0;
        }

        if (outcome === 'pending') {
          return true;
        }

        inlineFrames += 1;

        // The frame ran inline.
        if (framePending || !chainRequested) {
          return true;
        }

        if (inlineFrames >= DEFAULT_MAX_SYNCHRONOUS_CHAIN) {
          chainRequested = false;
          reportChainBound(inlineFrames);

          return true;
        }
      }
    } finally {
      scheduling = false;
      chainRequested = false;
    }
  };

  /**
   * Records one frame's measurements.
   *
   * @param duration Milliseconds the frame's callbacks and hooks occupied.
   * @param delta Clamped delta the frame carried.
   */
  const recordFrame = (duration: number, delta: number): void => {
    sampledFrames += 1;
    lastFrameDuration = duration;
    totalFrameDuration += duration;
    unreportedFrames += 1;
    unreportedDuration += duration;

    if (sampledFrames === 1 || duration < minFrameDuration) {
      minFrameDuration = duration;
    }

    if (duration > maxFrameDuration) {
      maxFrameDuration = duration;
    }

    lastDelta = delta;
    totalDelta += delta;

    if (delta > maxObservedDelta) {
      maxObservedDelta = delta;
    }

    for (let index = 0; index < bounds.length; index += 1) {
      if (duration <= bounds[index]) {
        bucketCounts[index] += 1;

        return;
      }
    }

    framesOverBounds += 1;
  };

  /** Removes the registrations a frame deferred. */
  const compactEntries = (): void => {
    removalPending = false;

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (!entries[index].active) {
        entries.splice(index, 1);
      }
    }
  };

  /** Parks a running loop, which `invalidate` resumes. */
  const park = (): void => {
    running = false;
    parked = true;
    idleStreak = 0;
    idleParks += 1;
    previousTimestamp = undefined;

    reporter.onCount({ name: LOOP_PARK_METRIC, value: 1 });
    flushBatchTiming();
  };

  /**
   * Settles what happens after a frame: another frame, a park, or an idle
   * loop.
   *
   * @param outstanding Whether any callback of the frame declared work still
   *   outstanding.
   */
  const concludeFrame = (outstanding: boolean): void => {
    const requested = workPending || frameRequested;

    frameRequested = false;

    if (stopRequested) {
      stopRequested = false;
      flushBatchTiming();

      return;
    }

    if (running) {
      if (autoStopWhenIdle) {
        if (outstanding || requested) {
          idleStreak = 0;
        } else {
          idleStreak += 1;

          if (idleStreak >= idleFrames) {
            park();

            return;
          }
        }
      }

      scheduleFrame();

      return;
    }

    if (outstanding || requested) {
      scheduleFrame();

      return;
    }

    flushBatchTiming();
  };

  /**
   * Runs one frame. Handed to the scheduler, and the only function the
   * scheduler ever calls.
   *
   * @param timestamp Frame timestamp in milliseconds, as supplied.
   */
  const runFrame = (timestamp: number): void => {
    pendingHandle = null;
    framePending = false;

    if (origin === undefined) {
      origin = timestamp;
    }

    const previous = previousTimestamp;

    previousTimestamp = timestamp;

    const rawDelta =
      previous === undefined || timestamp <= previous
        ? 0
        : timestamp - previous;
    const deltaClamped = rawDelta > maxDelta;

    frameIndex += 1;
    context.timestamp = timestamp;
    context.rawDelta = rawDelta;
    context.delta = deltaClamped ? maxDelta : rawDelta;
    context.deltaClamped = deltaClamped;
    context.elapsed = timestamp > origin ? timestamp - origin : 0;
    context.frame = frameIndex;

    if (deltaClamped) {
      clampedDeltas += 1;
      reportClampedDelta(rawDelta);
    }

    let outstanding = false;

    workPending = false;
    dispatching = true;

    const startedAt = clock();

    if (hookBegin !== undefined) {
      try {
        hookBegin(context);
      } catch (error: unknown) {
        reportHookThrow('frame-begin', error);
      }
    }

    const dispatchCount = entries.length;

    for (let index = 0; index < dispatchCount; index += 1) {
      const entry = entries[index];

      if (!entry.active) {
        continue;
      }

      try {
        if (entry.callback(context) === true) {
          outstanding = true;
        }
      } catch (error: unknown) {
        reportCallbackThrow(entry.id, error);
      }
    }

    const duration = Math.max(0, clock() - startedAt);

    if (hookEnd !== undefined) {
      try {
        hookEnd(context, duration);
      } catch (error: unknown) {
        reportHookThrow('frame-end', error);
      }
    }

    recordFrame(duration, context.delta);

    if (timingMode === 'frame') {
      reporter.onTiming({ name: FRAME_TIMING_METRIC, durationMs: duration });
    }

    if (removalPending) {
      compactEntries();
    }

    dispatching = false;

    concludeFrame(outstanding);
  };

  /** Begins continuous scheduling, and resumes a parked loop. */
  const start = (): void => {
    if (running) {
      return;
    }

    const resuming = parked;

    running = true;
    parked = false;
    stopRequested = false;
    idleStreak = 0;

    if (!resuming) {
      origin = undefined;
      previousTimestamp = undefined;
    }

    if (!scheduleFrame()) {
      running = false;
      parked = resuming;

      return;
    }

    reporter.onCount({
      name: resuming ? LOOP_RESUME_METRIC : LOOP_START_METRIC,
      value: 1,
    });
  };

  /** Stops scheduling and cancels the pending frame. */
  const stop = (): void => {
    const wasActive = running || parked || framePending || dispatching;

    running = false;
    parked = false;
    frameRequested = false;
    workPending = false;
    idleStreak = 0;
    origin = undefined;
    previousTimestamp = undefined;

    if (dispatching) {
      stopRequested = true;
    }

    cancelPendingFrame();

    if (!wasActive) {
      return;
    }

    reporter.onCount({ name: LOOP_STOP_METRIC, value: 1 });

    if (!dispatching) {
      flushBatchTiming();
    }
  };

  /** Schedules a single frame without starting continuous scheduling. */
  const requestFrame = (): void => {
    stopRequested = false;

    if (dispatching) {
      frameRequested = true;

      return;
    }

    scheduleFrame();
  };

  /** Declares outstanding work and ensures a frame runs. */
  const invalidate = (): void => {
    workPending = true;
    idleStreak = 0;
    stopRequested = false;

    const resuming = parked;

    if (resuming) {
      parked = false;
      running = true;

      reporter.onCount({ name: LOOP_RESUME_METRIC, value: 1 });
    }

    if (dispatching) {
      frameRequested = true;

      return;
    }

    if (!scheduleFrame() && resuming) {
      running = false;
      parked = true;
    }
  };

  /**
   * Registers a callback.
   *
   * @param callback Work to perform once per frame.
   * @returns The registration handle.
   */
  const addFrameCallback = (callback: FrameCallback): FrameSubscription => {
    if (typeof callback !== 'function') {
      reporter.onCount({ name: INVALID_CALLBACK_METRIC, value: 1 });
      reporter.onDiagnostic({
        level: 'warning',
        source: DIAGNOSTIC_SOURCE,
        message: 'A frame callback that is not callable was rejected.',
      });

      return Object.freeze({ id: 0, remove: (): boolean => false });
    }

    lastSubscriptionId += 1;

    const id = lastSubscriptionId;

    entries.push({ id, callback, active: true });

    return Object.freeze({ id, remove: (): boolean => removeById(id) });
  };

  /**
   * Retires one registration, deferring the splice during a frame.
   *
   * @param index Position of the registration in dispatch order.
   */
  const deactivate = (index: number): void => {
    entries[index].active = false;

    if (dispatching) {
      removalPending = true;

      return;
    }

    entries.splice(index, 1);
  };

  /**
   * Removes a registration by identifier.
   *
   * @param id Identifier carried by the registration handle.
   * @returns Whether a registration was removed.
   */
  const removeById = (id: number): boolean => {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];

      if (entry.id === id && entry.active) {
        deactivate(index);

        return true;
      }
    }

    return false;
  };

  /**
   * Removes a registration by callback identity.
   *
   * @param callback Callback to remove.
   * @returns Whether a registration was removed.
   */
  const removeFrameCallback = (callback: FrameCallback): boolean => {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];

      if (entry.callback === callback && entry.active) {
        deactivate(index);

        return true;
      }
    }

    return false;
  };

  /**
   * @returns Registrations that still run.
   */
  const countActive = (): number => {
    let total = 0;

    for (let index = 0; index < entries.length; index += 1) {
      if (entries[index].active) {
        total += 1;
      }
    }

    return total;
  };

  /**
   * @returns A snapshot of the frame measurements, as plain data.
   */
  const getFrameStats = (): FrameStats => {
    const buckets: FrameDurationBucket[] = [];
    let cumulative = 0;

    for (let index = 0; index < bounds.length; index += 1) {
      cumulative += bucketCounts[index];
      buckets.push(Object.freeze({ le: bounds[index], count: cumulative }));
    }

    return Object.freeze({
      running,
      parked,
      framePending,
      schedulingAvailable: isFrameSchedulingAvailable(scheduler),
      callbacks: countActive(),
      frames: frameIndex,
      sampledFrames,
      lastFrameDuration,
      meanFrameDuration:
        sampledFrames === 0 ? 0 : totalFrameDuration / sampledFrames,
      minFrameDuration,
      maxFrameDuration,
      totalFrameDuration,
      lastDelta,
      meanDelta: sampledFrames === 0 ? 0 : totalDelta / sampledFrames,
      maxDelta: maxObservedDelta,
      deltaClampLimit: maxDelta,
      clampedDeltas,
      callbackErrors,
      hookErrors,
      idleParks,
      elapsed: context.elapsed,
      durationBuckets: Object.freeze(buckets),
      framesOverBounds,
    });
  };

  /** Clears the sampled measurements, reporting anything still owed. */
  const resetFrameStats = (): void => {
    flushBatchTiming();

    sampledFrames = 0;
    lastFrameDuration = 0;
    totalFrameDuration = 0;
    minFrameDuration = 0;
    maxFrameDuration = 0;
    lastDelta = 0;
    totalDelta = 0;
    maxObservedDelta = 0;
    clampedDeltas = 0;
    callbackErrors = 0;
    hookErrors = 0;
    idleParks = 0;
    framesOverBounds = 0;
    unreportedFrames = 0;
    unreportedDuration = 0;

    for (let index = 0; index < bucketCounts.length; index += 1) {
      bucketCounts[index] = 0;
    }
  };

  const loop: RenderLoop = {
    start,
    stop,
    isRunning: (): boolean => running,
    isParked: (): boolean => parked,
    isFramePending: (): boolean => framePending,
    requestFrame,
    invalidate,
    addFrameCallback,
    removeFrameCallback,
    getFrameStats,
    resetFrameStats,
  };

  return Object.freeze(loop);
}
