// Move, spawn, merge, score-delta and overlay tweens: the timing budget of
// style/main.scss, evaluated in JavaScript.
//
// Every duration, delay, easing keyword and keyframe shape is read from
// src/theme/tokens.ts, which mirrors style/_tokens.scss. The five timings this
// module reproduces, and where the stylesheet declares each of them:
//   move     100ms ease-in-out            style/main.scss L329, with L330-L332
//                                         narrowing the transition to
//                                         `transform`; $transition-speed L22
//   appear   200ms ease after 100ms,      style/main.scss L417-L427 keyframes,
//            opacity 0 + scale 0 to       applied L429-L432 with
//            opacity 1 + scale 1          animation-fill-mode: backwards
//   pop      200ms ease after 100ms,      style/main.scss L434-L446 keyframes
//            scale 0 to 1.2 to 1          at 0%, 50% and 100%, applied
//                                         L448-L452 with the same fill mode
//   move-up  600ms ease-in, top 25px      style/main.scss L50-L60 keyframes,
//            + opacity 1 to top -50px     applied L104-L105
//            + opacity 0
//   fade-in  800ms ease after             style/main.scss L148-L156 keyframes,
//            $transition-speed * 12,      applied L234-L235
//            which is 1200ms,
//            opacity 0 to opacity 1
//
// A delay holds the animation's 0% keyframe, which is what
// `animation-fill-mode: backwards` at style/main.scss L431 and L451 specifies:
// a tween inside its delay yields the 0% value and not the natural one, so a
// spawning tile is at scale 0 and opacity 0 for those 100ms.
//
// CSS applies a timing function between each pair of adjacent keyframes, so the
// three-stop `pop` of style/main.scss L434-L446 eases twice — once across 0% to
// 50% and once across 50% to 100% — and its 50% stop is reached exactly.
//
// Supersedes the animation mechanics of js/html_actuator.js, which is deleted:
//   js/html_actuator.js L54, L67-L72  previousPosition and position, the two
//                                     endpoints of a move tween
//   js/html_actuator.js L73-L80       the .tile-merged class carrying `pop`
//   js/html_actuator.js L82           the .tile-new class carrying `appear`
//   js/html_actuator.js L114-L120     the .score-addition element carrying
//                                     `move-up`
// The endpoint pair those lines read comes from js/tile.js L10-L17, where
// savePosition() snapshots the coordinates and updatePosition() leaves
// previousPosition untouched.
//
// Invariants: this module holds no mesh, element or engine reference, touches
// no DOM, reads no clock — every step is driven by a caller-supplied delta —
// consumes no randomness and performs no I/O. It interpolates numbers, and
// src/render/three-renderer.ts applies them.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import type { Position } from '../engine/types';
import type { MotionEasing } from '../theme/tokens';
import { motion } from '../theme/tokens';
import type { RenderDetail, RenderReporter } from './webgl-support';
import {
  NOOP_RENDER_REPORTER,
  createGuardedRenderReporter,
  queryReducedMotion,
} from './webgl-support';

/* ==========================================================================
 * 1. Easing — the CSS keywords, evaluated as cubic Bézier curves
 * ========================================================================== */

/**
 * Progress through one keyframe interval mapped to the eased progress the
 * interval's timing function produces.
 *
 * @param progress Linear progress, 0 to 1. A value at or below 0 and `NaN`
 *   resolve to 0, and a value at or above 1 resolves to 1.
 * @returns The eased progress: exactly `0` at `0` and exactly `1` at `1`.
 */
export type EasingFunction = (progress: number) => number;

/**
 * The two inner control points of a cubic Bézier easing curve. The outer two
 * are fixed at (0, 0) and (1, 1).
 */
export interface CubicBezierCurve {
  /** First control point's x, 0 to 1. */
  readonly x1: number;

  /** First control point's y. */
  readonly y1: number;

  /** Second control point's x, 0 to 1. */
  readonly x2: number;

  /** Second control point's y. */
  readonly y2: number;
}

/**
 * Control points the three CSS easing keywords of `MotionEasing` are defined
 * as: `ease` is `cubic-bezier(0.25, 0.1, 0.25, 1)`, `ease-in` is
 * `cubic-bezier(0.42, 0, 1, 1)` and `ease-in-out` is
 * `cubic-bezier(0.42, 0, 0.58, 1)`, from CSS Easing Functions Level 1.
 *
 * style/main.scss L104, L234, L329, L430 and L450 name the keywords; these are
 * the curves those names carry.
 */
export const CSS_EASING_CURVES: Readonly<
  Record<MotionEasing, CubicBezierCurve>
> = Object.freeze({
  ease: Object.freeze({ x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 }),
  'ease-in': Object.freeze({ x1: 0.42, y1: 0, x2: 1, y2: 1 }),
  'ease-in-out': Object.freeze({ x1: 0.42, y1: 0, x2: 0.58, y2: 1 }),
});

/**
 * Coefficient of the two inner terms of a cubic Bézier's expansion, from
 * `B(t) = 3(1-t)^2 t p1 + 3(1-t) t^2 p2 + t^3`, with the outer control points
 * at 0 and 1.
 */
const CUBIC_INNER_COEFFICIENT = 3;

/** Coefficient of the middle term of that expansion's first derivative. */
const CUBIC_DERIVATIVE_COEFFICIENT = 2;

/** Divisor that halves a bracketing interval during bisection. */
const BISECTION_DIVISOR = 2;

/** Newton-Raphson iterations attempted before bisection takes over. */
const NEWTON_ITERATIONS = 8;

/** Bisection iterations run when Newton-Raphson has not converged. */
const BISECTION_ITERATIONS = 64;

/** Convergence tolerance on the curve's x, unitless. */
const SOLVE_TOLERANCE = 1e-9;

/** Smallest slope Newton-Raphson will divide by. */
const MIN_NEWTON_SLOPE = 1e-9;

/** The polynomial form of one axis of a cubic Bézier curve. */
interface AxisPolynomial {
  /** Coefficient of t³. */
  readonly a: number;

  /** Coefficient of t². */
  readonly b: number;

  /** Coefficient of t. */
  readonly c: number;
}

/**
 * Expands one axis of a curve into the polynomial coefficients of
 * `c·t + b·t² + a·t³`.
 *
 * @param p1 First control point's coordinate on this axis.
 * @param p2 Second control point's coordinate on this axis.
 * @returns The three coefficients.
 */
function axisPolynomial(p1: number, p2: number): AxisPolynomial {
  const c = CUBIC_INNER_COEFFICIENT * p1;
  const b = CUBIC_INNER_COEFFICIENT * (p2 - p1) - c;

  return { a: 1 - c - b, b, c };
}

/**
 * Evaluates one axis at a curve parameter.
 *
 * @param axis Polynomial of the axis.
 * @param t Curve parameter, 0 to 1.
 * @returns The axis value at `t`.
 */
function sampleAxis(axis: AxisPolynomial, t: number): number {
  return ((axis.a * t + axis.b) * t + axis.c) * t;
}

/**
 * Evaluates one axis' first derivative at a curve parameter.
 *
 * @param axis Polynomial of the axis.
 * @param t Curve parameter, 0 to 1.
 * @returns The slope at `t`.
 */
function sampleAxisSlope(axis: AxisPolynomial, t: number): number {
  return (
    (CUBIC_INNER_COEFFICIENT * axis.a * t +
      CUBIC_DERIVATIVE_COEFFICIENT * axis.b) *
      t +
    axis.c
  );
}

/**
 * Finds the curve parameter whose x equals a progress value, by
 * Newton-Raphson with a bisection fallback.
 *
 * @param axis Polynomial of the x axis.
 * @param x Progress to solve for, strictly between 0 and 1.
 * @returns The curve parameter, within `SOLVE_TOLERANCE` of the solution.
 */
function solveCurveParameter(axis: AxisPolynomial, x: number): number {
  let t = x;

  for (let iteration = 0; iteration < NEWTON_ITERATIONS; iteration += 1) {
    const error = sampleAxis(axis, t) - x;

    if (Math.abs(error) < SOLVE_TOLERANCE) {
      return t;
    }

    const slope = sampleAxisSlope(axis, t);

    if (Math.abs(slope) < MIN_NEWTON_SLOPE) {
      break;
    }

    t -= error / slope;
  }

  let low = 0;
  let high = 1;

  t = x;

  for (let iteration = 0; iteration < BISECTION_ITERATIONS; iteration += 1) {
    const sampled = sampleAxis(axis, t);

    if (Math.abs(sampled - x) < SOLVE_TOLERANCE) {
      return t;
    }

    if (sampled < x) {
      low = t;
    } else {
      high = t;
    }

    t = low + (high - low) / BISECTION_DIVISOR;
  }

  return t;
}

/**
 * Builds the easing function of a cubic Bézier curve.
 *
 * @param curve The curve's two inner control points.
 * @returns An easing function returning exactly `0` at `0` and exactly `1` at
 *   `1`, and the curve's y at every progress between them.
 */
export function createCubicBezierEasing(
  curve: CubicBezierCurve,
): EasingFunction {
  const xAxis = axisPolynomial(curve.x1, curve.x2);
  const yAxis = axisPolynomial(curve.y1, curve.y2);

  return (progress: number): number => {
    // `NaN` and every value at or below 0 resolve to 0, every value at or
    // above 1 resolves to 1, and the sampled branch therefore receives a
    // finite value strictly between them.
    if (Number.isNaN(progress) || progress <= 0) {
      return 0;
    }

    if (progress >= 1) {
      return 1;
    }

    return sampleAxis(yAxis, solveCurveParameter(xAxis, progress));
  };
}

/** The CSS `ease` keyword. style/main.scss L234, L430 and L450 name it. */
export const ease: EasingFunction = /* @__PURE__ */ createCubicBezierEasing(
  CSS_EASING_CURVES.ease,
);

/** The CSS `ease-in` keyword. style/main.scss L104 names it. */
export const easeIn: EasingFunction = /* @__PURE__ */ createCubicBezierEasing(
  CSS_EASING_CURVES['ease-in'],
);

/** The CSS `ease-in-out` keyword. style/main.scss L329 names it. */
export const easeInOut: EasingFunction =
  /* @__PURE__ */ createCubicBezierEasing(CSS_EASING_CURVES['ease-in-out']);

/** The three keywords, by the name `src/theme/tokens.ts` carries. */
const EASING_FUNCTIONS: Readonly<Record<MotionEasing, EasingFunction>> =
  Object.freeze({
    ease,
    'ease-in': easeIn,
    'ease-in-out': easeInOut,
  });

/**
 * Resolves an easing keyword to its function.
 *
 * @param keyword Keyword a `motion` entry of src/theme/tokens.ts carries.
 * @returns The easing function of that keyword.
 */
export function easingFor(keyword: MotionEasing): EasingFunction {
  return EASING_FUNCTIONS[keyword];
}

/* ==========================================================================
 * 2. Reporting and the tween contract
 * ========================================================================== */

/** Source field carried by every diagnostic this module emits. */
const DIAGNOSTIC_SOURCE = 'render/animations';

/** Counter incremented for each tween a group takes. */
const TWEEN_ADDED_METRIC = 'render.animations.tween.added';

/** Counter incremented for each tween that reaches its end in a group. */
const TWEEN_COMPLETED_METRIC = 'render.animations.tween.completed';

/** Counter incremented for each tween a caller takes back out of a group. */
const TWEEN_REMOVED_METRIC = 'render.animations.tween.removed';

/** Counter incremented for each rejected step delta. */
const INVALID_DELTA_METRIC = 'render.animations.delta.invalid';

/** Counter incremented for each rejected construction parameter. */
const INVALID_OPTION_METRIC = 'render.animations.option.invalid';

/**
 * One keyframe of a tween: an offset through the animated interval, and the
 * value at that offset.
 */
export interface TweenStop<TValue> {
  /** Position through the animated interval, 0 to 1. */
  readonly offset: number;

  /** The value the tween yields at `offset`. */
  readonly value: TValue;
}

/**
 * Produces the value between two adjacent keyframes.
 *
 * @param from Value at the earlier keyframe.
 * @param to Value at the later keyframe.
 * @param ratio Eased progress between them, 0 to 1. `0` yields `from` and `1`
 *   yields `to`, both exactly.
 * @returns The interpolated value.
 */
export type TweenInterpolator<TValue> = (
  from: TValue,
  to: TValue,
  ratio: number,
) => TValue;

/**
 * The part of a tween that carries no value type, so tweens over different
 * value shapes are held together and stepped together.
 */
export interface TweenBase {
  /**
   * Name of the timing this tween reproduces, as the stylesheet names it:
   * `'move'`, `'appear'`, `'pop'`, `'move-up'` or `'fade-in'`.
   */
  readonly name: string;

  /** Length of the animated interval, in ms. */
  readonly duration: number;

  /** Delay the 0% keyframe is held across, in ms. */
  readonly delay: number;

  /** `delay` plus `duration`, in ms. */
  readonly totalDuration: number;

  /**
   * Whether this tween was built with motion reduced, in which case it was
   * complete from construction.
   */
  readonly reducedMotion: boolean;

  /** @returns Milliseconds stepped so far, never above `totalDuration`. */
  readonly elapsed: () => number;

  /**
   * @returns Progress through the animated interval, 0 to 1. `0` for every
   * step inside `delay`, and `1` once the tween is complete.
   */
  readonly progress: () => number;

  /** @returns Whether the tween has reached the end of its interval. */
  readonly isComplete: () => boolean;

  /**
   * Steps the tween.
   *
   * @param deltaMs Milliseconds since the previous step. A value that is not a
   *   finite number of at least zero is reported and treated as zero.
   */
  readonly advance: (deltaMs: number) => void;

  /** Steps the tween straight to the end of its interval. */
  readonly complete: () => void;

  /**
   * Returns the tween to its first step, and leaves a tween built with motion
   * reduced complete.
   */
  readonly reset: () => void;
}

/** A tween over one value shape. */
export interface Tween<TValue> extends TweenBase {
  /** @returns The value at the current step. */
  readonly value: () => TValue;

  /**
   * Steps the tween and reads the value it reaches.
   *
   * @param deltaMs Milliseconds since the previous step. A value that is not a
   *   finite number of at least zero is reported and treated as zero.
   * @returns The value at the step reached.
   */
  readonly advance: (deltaMs: number) => TValue;

  /**
   * Steps the tween straight to the end of its interval.
   *
   * @returns The value at the last keyframe.
   */
  readonly complete: () => TValue;
}

/** Construction parameters every tween factory accepts. All are optional. */
export interface TweenOptions {
  /**
   * Whether to build the tween complete, at its last keyframe. Omitted, the
   * effective preference is read through `queryReducedMotion()` of
   * src/render/webgl-support.ts.
   */
  readonly reducedMotion?: boolean;

  /**
   * Sink for rejected parameters and rejected step deltas. Defaults to
   * `NOOP_RENDER_REPORTER`.
   */
  readonly reporter?: RenderReporter;
}

/** Everything a tween needs that is not a construction option. */
export interface TweenDefinition<TValue> {
  /** Name the tween carries. */
  readonly name: string;

  /** Length of the animated interval, in ms. */
  readonly duration: number;

  /** Delay the first keyframe is held across, in ms. */
  readonly delay: number;

  /** Timing function applied within each pair of adjacent keyframes. */
  readonly easing: EasingFunction;

  /**
   * The keyframes, one or more. Offsets outside 0 to 1 are clamped and the
   * keyframes are ordered by offset.
   */
  readonly stops: readonly TweenStop<TValue>[];

  /** Interpolator between two adjacent keyframes. */
  readonly interpolate: TweenInterpolator<TValue>;
}

/* ==========================================================================
 * 3. Tween construction
 * ========================================================================== */

/**
 * Reports one rejected construction parameter.
 *
 * @param reporter Sink the rejection is reported to.
 * @param tween Name of the tween the parameter belongs to.
 * @param option Parameter name, as `'duration'`.
 * @param fallback Value used in its place.
 */
function reportInvalidOption(
  reporter: RenderReporter,
  tween: string,
  option: string,
  fallback: number,
): void {
  const detail: RenderDetail = Object.freeze({ tween, option, fallback });

  reporter.onCount({ name: INVALID_OPTION_METRIC, value: 1, detail });
  reporter.onDiagnostic({
    level: 'warning',
    source: DIAGNOSTIC_SOURCE,
    message: `The ${option} of the ${tween} tween was rejected; ` +
      'zero was used.',
    detail,
  });
}

/**
 * Validates a duration or a delay.
 *
 * @param value Supplied milliseconds.
 * @param tween Name of the tween the parameter belongs to.
 * @param option Parameter name, as `'delay'`.
 * @param reporter Sink a rejection is reported to.
 * @returns The value where it is a finite number of at least zero, and `0`
 *   otherwise.
 */
function resolveTiming(
  value: number,
  tween: string,
  option: string,
  reporter: RenderReporter,
): number {
  if (Number.isFinite(value) && value >= 0) {
    return value;
  }

  reportInvalidOption(reporter, tween, option, 0);

  return 0;
}

/**
 * Orders the keyframes by offset and clamps every offset into 0 to 1.
 *
 * @param stops Supplied keyframes, one or more.
 * @param tween Name of the tween they belong to.
 * @param reporter Sink a rejected offset is reported to.
 * @returns A frozen ascending copy.
 * @throws RangeError when `stops` is empty, which leaves no value to yield.
 */
function normaliseStops<TValue>(
  stops: readonly TweenStop<TValue>[],
  tween: string,
  reporter: RenderReporter,
): readonly TweenStop<TValue>[] {
  if (stops.length === 0) {
    throw new RangeError(
      `animations: the ${tween} tween needs at least one keyframe`,
    );
  }

  const normalised = stops.map((stop): TweenStop<TValue> => {
    if (Number.isFinite(stop.offset) && stop.offset >= 0 && stop.offset <= 1) {
      return stop;
    }

    const clamped = Number.isFinite(stop.offset)
      ? Math.min(Math.max(stop.offset, 0), 1)
      : 0;

    reportInvalidOption(reporter, tween, 'stop offset', clamped);

    return { offset: clamped, value: stop.value };
  });

  normalised.sort((left, right): number => left.offset - right.offset);

  return Object.freeze(normalised);
}

/** A validator of step deltas, counting what it rejects. */
interface DeltaGuard {
  /**
   * Validates one step delta.
   *
   * @param deltaMs Supplied milliseconds since the previous step.
   * @returns The delta where it is a finite number of at least zero, and `0`
   *   otherwise, in which case the rejection is counted and the first such
   *   rejection is reported.
   */
  readonly resolve: (deltaMs: number) => number;

  /** @returns Rejections counted since construction or the last reset. */
  readonly rejections: () => number;

  /** Clears the rejection count and arms the diagnostic again. */
  readonly reset: () => void;
}

/**
 * Builds a step-delta guard.
 *
 * Every rejection is counted on `INVALID_DELTA_METRIC`, and the first one of
 * each armed period is also reported as a diagnostic, so a clock that reports
 * an unusable delta on every frame produces a single diagnostic for that
 * period.
 *
 * @param reporter Sink rejections are reported to.
 * @param subject Name of the tween or group the delta was handed to.
 * @returns The guard.
 */
function createDeltaGuard(
  reporter: RenderReporter,
  subject: string,
): DeltaGuard {
  let rejections = 0;
  let reported = false;

  return {
    resolve: (deltaMs: number): number => {
      if (Number.isFinite(deltaMs) && deltaMs >= 0) {
        return deltaMs;
      }

      rejections += 1;

      const detail: RenderDetail = Object.freeze({
        subject,
        delta: Number.isFinite(deltaMs) ? deltaMs : null,
      });

      reporter.onCount({ name: INVALID_DELTA_METRIC, value: 1, detail });

      if (!reported) {
        reported = true;
        reporter.onDiagnostic({
          level: 'warning',
          source: DIAGNOSTIC_SOURCE,
          message: `A step of ${subject} was rejected; zero was used.`,
          detail,
        });
      }

      return 0;
    },

    rejections: (): number => rejections,

    reset: (): void => {
      rejections = 0;
      reported = false;
    },
  };
}

/**
 * Interpolates one number, exactly at both ends.
 *
 * @param from Value at ratio zero.
 * @param to Value at ratio one.
 * @param ratio Eased progress between them.
 * @returns `from` at or below zero, `to` at or above one, and the linear blend
 *   between them elsewhere.
 */
export function mix(from: number, to: number, ratio: number): number {
  if (ratio <= 0) {
    return from;
  }

  if (ratio >= 1) {
    return to;
  }

  return from + (to - from) * ratio;
}

/**
 * Reads the value at a progress, easing within the keyframe interval that
 * progress falls in.
 *
 * @param stops Ascending keyframes, one or more.
 * @param interpolate Interpolator between two adjacent keyframes.
 * @param easing Timing function applied within the interval.
 * @param progress Progress through the animated interval, 0 to 1.
 * @returns The value at `progress`.
 */
function resolveStopValue<TValue>(
  stops: readonly TweenStop<TValue>[],
  interpolate: TweenInterpolator<TValue>,
  easing: EasingFunction,
  progress: number,
): TValue {
  const first = stops[0];
  const last = stops[stops.length - 1];

  if (progress <= first.offset) {
    return first.value;
  }

  if (progress >= last.offset) {
    return last.value;
  }

  for (let index = 1; index < stops.length; index += 1) {
    const to = stops[index];

    if (progress > to.offset) {
      continue;
    }

    const from = stops[index - 1];
    const span = to.offset - from.offset;
    const ratio = span > 0 ? (progress - from.offset) / span : 1;

    return interpolate(from.value, to.value, easing(ratio));
  }

  return last.value;
}

/**
 * Builds a tween from its keyframes and its timing.
 *
 * The tween holds its first keyframe for the whole of `delay` and then eases
 * across the keyframes over `duration`, which is what
 * `animation-fill-mode: backwards` produces for the delayed animations of
 * style/main.scss L431 and L451. Built with motion reduced, it is complete from
 * construction and yields its last keyframe from the first read.
 *
 * @param definition Keyframes, timing and interpolator.
 * @param options Reduced-motion resolution and the reporter.
 * @returns A frozen tween.
 * @throws RangeError when the definition carries no keyframe.
 */
export function createTween<TValue>(
  definition: TweenDefinition<TValue>,
  options: TweenOptions = {},
): Tween<TValue> {
  const reporter = createGuardedRenderReporter(
    options.reporter ?? NOOP_RENDER_REPORTER,
  );
  const name = definition.name;
  const duration = resolveTiming(
    definition.duration,
    name,
    'duration',
    reporter,
  );
  const delay = resolveTiming(definition.delay, name, 'delay', reporter);
  const stops = normaliseStops(definition.stops, name, reporter);
  const totalDuration = delay + duration;
  const reducedMotion = options.reducedMotion ?? queryReducedMotion();
  const deltaGuard = createDeltaGuard(reporter, `the ${name} tween`);

  let stepped = reducedMotion ? totalDuration : 0;

  const progress = (): number => {
    if (duration <= 0) {
      return stepped >= delay ? 1 : 0;
    }

    return Math.min(Math.max((stepped - delay) / duration, 0), 1);
  };

  const value = (): TValue =>
    resolveStopValue(
      stops,
      definition.interpolate,
      definition.easing,
      progress(),
    );

  const isComplete = (): boolean => stepped >= totalDuration;

  return Object.freeze({
    name,
    duration,
    delay,
    totalDuration,
    reducedMotion,
    elapsed: (): number => stepped,
    progress,
    isComplete,
    value,

    advance: (deltaMs: number): TValue => {
      stepped = Math.min(
        stepped + deltaGuard.resolve(deltaMs),
        totalDuration,
      );

      return value();
    },

    complete: (): TValue => {
      stepped = totalDuration;

      return value();
    },

    reset: (): void => {
      stepped = reducedMotion ? totalDuration : 0;
    },
  });
}

/* ==========================================================================
 * 4. The five tweens of style/main.scss
 * ========================================================================== */

/** Offset of a first keyframe, the `0%` of a `@keyframes` block. */
const FIRST_STOP_OFFSET = 0;

/** Offset of a last keyframe, the `100%` of a `@keyframes` block. */
const LAST_STOP_OFFSET = 1;

/** Name of the movement transition. style/main.scss L328-L332 declares it. */
const MOVE_TWEEN_NAME = 'move';

/** Keyframe name at style/main.scss L417, applied L429-L432. */
const APPEAR_TWEEN_NAME = 'appear';

/** Keyframe name at style/main.scss L434, applied L448-L452. */
const POP_TWEEN_NAME = 'pop';

/** Keyframe name at style/main.scss L50, applied L104-L105. */
const MOVE_UP_TWEEN_NAME = 'move-up';

/** Keyframe name at style/main.scss L148, applied L234-L235. */
const FADE_IN_TWEEN_NAME = 'fade-in';

/** A board position, as the move tween interpolates it. */
export interface MoveTweenValue {
  /** Column coordinate, in cells. */
  readonly x: number;

  /** Row coordinate, in cells. */
  readonly y: number;
}

/** The `appear` keyframe pair of style/main.scss L417-L427. */
export interface SpawnTweenValue {
  /** Scale multiplier, unitless. */
  readonly scale: number;

  /** Opacity, 0 to 1. */
  readonly opacity: number;
}

/** The `pop` keyframe triple of style/main.scss L434-L446. */
export interface MergeTweenValue {
  /** Scale multiplier, unitless. */
  readonly scale: number;
}

/** The `move-up` keyframe pair of style/main.scss L50-L60. */
export interface ScoreDeltaTweenValue {
  /** Offset from the top of the score box, in px. */
  readonly top: number;

  /** Opacity, 0 to 1. */
  readonly opacity: number;
}

/** The `fade-in` keyframe pair of style/main.scss L148-L156. */
export interface OverlayFadeTweenValue {
  /** Opacity, 0 to 1. */
  readonly opacity: number;
}

/** Interpolates a board position. */
const interpolateMove: TweenInterpolator<MoveTweenValue> = (
  from,
  to,
  ratio,
): MoveTweenValue => ({
  x: mix(from.x, to.x, ratio),
  y: mix(from.y, to.y, ratio),
});

/** Interpolates a scale and an opacity together. */
const interpolateSpawn: TweenInterpolator<SpawnTweenValue> = (
  from,
  to,
  ratio,
): SpawnTweenValue => ({
  scale: mix(from.scale, to.scale, ratio),
  opacity: mix(from.opacity, to.opacity, ratio),
});

/** Interpolates a scale. */
const interpolateMerge: TweenInterpolator<MergeTweenValue> = (
  from,
  to,
  ratio,
): MergeTweenValue => ({
  scale: mix(from.scale, to.scale, ratio),
});

/** Interpolates a top offset and an opacity together. */
const interpolateScoreDelta: TweenInterpolator<ScoreDeltaTweenValue> = (
  from,
  to,
  ratio,
): ScoreDeltaTweenValue => ({
  top: mix(from.top, to.top, ratio),
  opacity: mix(from.opacity, to.opacity, ratio),
});

/** Interpolates an opacity. */
const interpolateOverlayFade: TweenInterpolator<OverlayFadeTweenValue> = (
  from,
  to,
  ratio,
): OverlayFadeTweenValue => ({
  opacity: mix(from.opacity, to.opacity, ratio),
});

/** Construction parameters of a move tween. */
export interface MoveTweenOptions extends TweenOptions {
  /**
   * The tile's `previousPosition`, from js/tile.js L10-L12. `null` or absent
   * for a tile that carries none, which js/html_actuator.js L67 treats as not
   * moving.
   */
  readonly from: Position | null | undefined;

  /** The tile's current position. */
  readonly to: Position;
}

/**
 * Validates one board coordinate.
 *
 * @param value Supplied coordinate, in cells.
 * @param option Parameter name, as `'to.x'`.
 * @param reporter Sink a rejection is reported to.
 * @returns The coordinate where it is a finite number, and `0` otherwise.
 */
function resolveCoordinate(
  value: number,
  option: string,
  reporter: RenderReporter,
): number {
  if (Number.isFinite(value)) {
    return value;
  }

  reportInvalidOption(reporter, MOVE_TWEEN_NAME, option, 0);

  return 0;
}

/**
 * Reports whether a tile needs a move tween at all.
 *
 * @param from The tile's `previousPosition`, or `null` where it carries none.
 * @param to The tile's current position.
 * @returns Whether the tile is moving: `false` for a tile with no previous
 *   position, and `false` where the two positions are the same cell.
 */
export function requiresMoveTween(
  from: Position | null | undefined,
  to: Position,
): boolean {
  if (from === null || from === undefined) {
    return false;
  }

  return from.x !== to.x || from.y !== to.y;
}

/**
 * Builds the movement tween: `$transition-speed` of `ease-in-out`, from
 * style/main.scss L329, over the position pair js/html_actuator.js L54 and
 * L67-L72 read. style/main.scss L330-L332 narrows the transition to
 * `transform`, which `motion.movement.property` carries, so the renderer
 * applies the interpolated position as a transform and never as a layout
 * change.
 *
 * A tween built with no `from` has an empty animated interval: it is complete
 * from construction and yields `to`. `requiresMoveTween()` reports that case
 * ahead of construction.
 *
 * @param options The position pair, and the shared tween options.
 * @returns A tween from `from` to `to`.
 */
export function createMoveTween(
  options: MoveTweenOptions,
): Tween<MoveTweenValue> {
  const reporter = createGuardedRenderReporter(
    options.reporter ?? NOOP_RENDER_REPORTER,
  );
  const to: MoveTweenValue = {
    x: resolveCoordinate(options.to.x, 'to.x', reporter),
    y: resolveCoordinate(options.to.y, 'to.y', reporter),
  };
  const source = options.from;
  const moving = source !== null && source !== undefined;
  const from: MoveTweenValue = moving
    ? {
        x: resolveCoordinate(source.x, 'from.x', reporter),
        y: resolveCoordinate(source.y, 'from.y', reporter),
      }
    : to;

  return createTween<MoveTweenValue>(
    {
      name: MOVE_TWEEN_NAME,
      duration: moving ? motion.movement.duration : 0,

      // style/main.scss L329 declares the transition with no delay.
      delay: 0,
      easing: easingFor(motion.movement.easing),
      stops: [
        { offset: FIRST_STOP_OFFSET, value: from },
        { offset: LAST_STOP_OFFSET, value: to },
      ],
      interpolate: interpolateMove,
    },
    { reducedMotion: options.reducedMotion, reporter },
  );
}

/**
 * Builds the spawn tween: the `appear` keyframes of style/main.scss L417-L427
 * over the timing of L429-L431, which is `200ms ease` after
 * `$transition-speed`, held at `opacity 0` and `scale(0)` for that delay by
 * `animation-fill-mode: backwards`. js/html_actuator.js L82 applied it through
 * the `.tile-new` class.
 *
 * @param options The shared tween options.
 * @returns A tween from opacity 0 and scale 0 to opacity 1 and scale 1.
 */
export function createSpawnTween(
  options: TweenOptions = {},
): Tween<SpawnTweenValue> {
  return createTween<SpawnTweenValue>(
    {
      name: APPEAR_TWEEN_NAME,
      duration: motion.appear.duration,
      delay: motion.appear.delay,
      easing: easingFor(motion.appear.easing),
      stops: [
        { offset: FIRST_STOP_OFFSET, value: motion.appear.keyframes.from },
        { offset: LAST_STOP_OFFSET, value: motion.appear.keyframes.to },
      ],
      interpolate: interpolateSpawn,
    },
    options,
  );
}

/**
 * Builds the merge tween: the `pop` keyframes of style/main.scss L434-L446 over
 * the timing of L450-L451, which is `200ms ease` after `$transition-speed`,
 * held at `scale(0)` for that delay by `animation-fill-mode: backwards`. The
 * middle keyframe carries the overshoot of `motion.pop.keyframes.mid` at its
 * offset, and the timing function is applied across each of the two intervals,
 * so the overshoot is reached exactly. js/html_actuator.js L73-L80 applied it
 * through the `.tile-merged` class.
 *
 * @param options The shared tween options.
 * @returns A tween from scale 0 through the overshoot to scale 1.
 */
export function createMergeTween(
  options: TweenOptions = {},
): Tween<MergeTweenValue> {
  return createTween<MergeTweenValue>(
    {
      name: POP_TWEEN_NAME,
      duration: motion.pop.duration,
      delay: motion.pop.delay,
      easing: easingFor(motion.pop.easing),
      stops: [
        { offset: FIRST_STOP_OFFSET, value: motion.pop.keyframes.from },
        {
          offset: motion.pop.keyframes.mid.offset,
          value: { scale: motion.pop.keyframes.mid.scale },
        },
        { offset: LAST_STOP_OFFSET, value: motion.pop.keyframes.to },
      ],
      interpolate: interpolateMerge,
    },
    options,
  );
}

/**
 * Builds the score-delta tween: the `move-up` keyframes of style/main.scss
 * L50-L60 over the `600ms ease-in` of L104, with no delay. js/html_actuator.js
 * L114-L120 applied it to the `.score-addition` element it created for a
 * positive score difference.
 *
 * @param options The shared tween options.
 * @returns A tween from the first keyframe's top and opacity to the last.
 */
export function createScoreDeltaTween(
  options: TweenOptions = {},
): Tween<ScoreDeltaTweenValue> {
  return createTween<ScoreDeltaTweenValue>(
    {
      name: MOVE_UP_TWEEN_NAME,
      duration: motion.moveUp.duration,
      delay: motion.moveUp.delay,
      easing: easingFor(motion.moveUp.easing),
      stops: [
        { offset: FIRST_STOP_OFFSET, value: motion.moveUp.keyframes.from },
        { offset: LAST_STOP_OFFSET, value: motion.moveUp.keyframes.to },
      ],
      interpolate: interpolateScoreDelta,
    },
    options,
  );
}

/**
 * Builds the terminal-overlay tween: the `fade-in` keyframes of style/main.scss
 * L148-L156 over the `800ms ease` of L234, after the delay that line writes as
 * `$transition-speed * 12`. The overlay is at opacity 0 for the whole of that
 * delay. js/html_actuator.js L127-L133 applied it by adding the `game-won` or
 * `game-over` class to `.game-message`.
 *
 * @param options The shared tween options.
 * @returns A tween from opacity 0 to opacity 1.
 */
export function createOverlayFadeTween(
  options: TweenOptions = {},
): Tween<OverlayFadeTweenValue> {
  return createTween<OverlayFadeTweenValue>(
    {
      name: FADE_IN_TWEEN_NAME,
      duration: motion.fadeIn.duration,
      delay: motion.fadeIn.delay,
      easing: easingFor(motion.fadeIn.easing),
      stops: [
        { offset: FIRST_STOP_OFFSET, value: motion.fadeIn.keyframes.from },
        { offset: LAST_STOP_OFFSET, value: motion.fadeIn.keyframes.to },
      ],
      interpolate: interpolateOverlayFade,
    },
    options,
  );
}

/* ==========================================================================
 * 5. Tween groups — the set a frame steps
 * ========================================================================== */

/**
 * Tween measurements, read synchronously and returned as plain data: numbers
 * only, with no tween reference, callback or live handle, so
 * `JSON.stringify()` round-trips the snapshot and later steps do not mutate it.
 *
 * `active` is live at the moment of the read. Every other field is sampled
 * since the group was created or since `resetTweenStats()` was last called.
 */
export interface TweenStats {
  /** Tweens the group holds. */
  readonly active: number;

  /** Most tweens the group has held at once. */
  readonly maxActive: number;

  /** Tweens handed to `add()`. */
  readonly added: number;

  /** Tweens that reached the end of their interval while held. */
  readonly completed: number;

  /** Tweens that were already complete when `add()` took them. */
  readonly completedOnAdd: number;

  /** Tweens taken back out by `remove()` or `clear()`. */
  readonly removed: number;

  /** Calls to `advance()`. */
  readonly advances: number;

  /** Milliseconds those calls stepped the group by. */
  readonly advancedMs: number;

  /** Step deltas rejected by the group's guard. */
  readonly invalidDeltas: number;
}

/** Every construction parameter of a group. All are optional. */
export interface TweenGroupOptions {
  /**
   * Sink for tween counts and rejected step deltas. Defaults to
   * `NOOP_RENDER_REPORTER`.
   */
  readonly reporter?: RenderReporter;
}

/**
 * A set of tweens stepped together.
 *
 * `advance()` returns whether work is still outstanding, which is the value a
 * `FrameCallback` of src/render/render-loop.ts returns to keep a loop
 * constructed with `autoStopWhenIdle` scheduling frames.
 */
export interface TweenGroup {
  /**
   * Takes a tween into the group. A tween that is already complete — which is
   * every tween built with motion reduced — is counted and not retained.
   *
   * @param tween The tween to hold.
   * @returns The same tween.
   */
  readonly add: <TTween extends TweenBase>(tween: TTween) => TTween;

  /**
   * Takes a tween back out, complete or not.
   *
   * @param tween The tween to release.
   * @returns Whether the group held it.
   */
  readonly remove: (tween: TweenBase) => boolean;

  /**
   * Releases every held tween.
   *
   * @returns How many were released.
   */
  readonly clear: () => number;

  /**
   * Steps every held tween by one frame's delta and releases the ones that
   * reach the end of their interval.
   *
   * @param deltaMs Milliseconds since the previous frame. A value that is not
   *   a finite number of at least zero is reported and treated as zero.
   * @returns Whether any tween is still outstanding.
   */
  readonly advance: (deltaMs: number) => boolean;

  /** @returns Whether any held tween has yet to reach its end. */
  readonly hasOutstandingWork: () => boolean;

  /** @returns Tweens the group holds. */
  readonly size: () => number;

  /** @returns A snapshot of the group's measurements. */
  readonly getTweenStats: () => TweenStats;

  /** Clears the sampled measurements, leaving the held tweens alone. */
  readonly resetTweenStats: () => void;
}

/**
 * Builds a tween group.
 *
 * A released tween keeps the value it ended on, so a caller that holds its own
 * reference reads that value after the group has let it go.
 *
 * @param options The reporter.
 * @returns A frozen group holding no tween.
 */
export function createTweenGroup(
  options: TweenGroupOptions = {},
): TweenGroup {
  const reporter = createGuardedRenderReporter(
    options.reporter ?? NOOP_RENDER_REPORTER,
  );
  const deltaGuard = createDeltaGuard(reporter, 'a tween group');
  const active = new Set<TweenBase>();

  let maxActive = 0;
  let added = 0;
  let completed = 0;
  let completedOnAdd = 0;
  let removed = 0;
  let advances = 0;
  let advancedMs = 0;

  const countTween = (
    metric: string,
    tween: TweenBase,
    value: number,
  ): void => {
    reporter.onCount({
      name: metric,
      value,
      detail: Object.freeze({
        tween: tween.name,
        reducedMotion: tween.reducedMotion,
      }),
    });
  };

  const release = (tween: TweenBase): void => {
    active.delete(tween);
    completed += 1;
    countTween(TWEEN_COMPLETED_METRIC, tween, 1);
  };

  const hasOutstandingWork = (): boolean => {
    for (const tween of active) {
      if (!tween.isComplete()) {
        return true;
      }
    }

    return false;
  };

  return Object.freeze({
    add: <TTween extends TweenBase>(tween: TTween): TTween => {
      added += 1;
      countTween(TWEEN_ADDED_METRIC, tween, 1);

      if (tween.isComplete()) {
        completedOnAdd += 1;
        completed += 1;
        countTween(TWEEN_COMPLETED_METRIC, tween, 1);

        return tween;
      }

      active.add(tween);
      maxActive = Math.max(maxActive, active.size);

      return tween;
    },

    remove: (tween: TweenBase): boolean => {
      if (!active.delete(tween)) {
        return false;
      }

      removed += 1;
      countTween(TWEEN_REMOVED_METRIC, tween, 1);

      return true;
    },

    clear: (): number => {
      const held = active.size;

      for (const tween of active) {
        countTween(TWEEN_REMOVED_METRIC, tween, 1);
      }

      active.clear();
      removed += held;

      return held;
    },

    advance: (deltaMs: number): boolean => {
      const delta = deltaGuard.resolve(deltaMs);

      advances += 1;
      advancedMs += delta;

      for (const tween of active) {
        tween.advance(delta);

        if (tween.isComplete()) {
          release(tween);
        }
      }

      return active.size > 0;
    },

    hasOutstandingWork,

    size: (): number => active.size,

    getTweenStats: (): TweenStats =>
      Object.freeze({
        active: active.size,
        maxActive,
        added,
        completed,
        completedOnAdd,
        removed,
        advances,
        advancedMs,
        invalidDeltas: deltaGuard.rejections(),
      }),

    resetTweenStats: (): void => {
      maxActive = active.size;
      added = 0;
      completed = 0;
      completedOnAdd = 0;
      removed = 0;
      advances = 0;
      advancedMs = 0;
      deltaGuard.reset();
    },
  });
}

