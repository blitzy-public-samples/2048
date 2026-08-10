// Move, spawn, merge, score-delta and overlay tweens: the timing budget of
// style/main.scss, evaluated in JavaScript.
//
// A delay HOLDS THE 0% KEYFRAME, which is what `animation-fill-mode:
// backwards` specifies in the stylesheet: a tween inside its delay yields the
// 0% value and not the natural one, so a spawning tile is at scale 0 and
// opacity 0 for those 100ms.
//
// CSS applies a timing function between each pair of adjacent keyframes, so
// the three-stop `pop` eases twice — once across 0% to 50% and once across 50%
// to 100% — and its 50% stop is reached exactly.
//
// Supersedes the animation mechanics of js/html_actuator.js, which is deleted:
// the `previousPosition`/`position` pair that were the two endpoints of a move
// tween, the `.tile-merged` class carrying `pop`, the `.tile-new` class
// carrying `appear`, and the `.score-addition` element carrying `move-up`.
//
// This module holds no mesh, element or engine reference, touches no DOM,
// reads no clock — every step is driven by a caller-supplied delta — consumes
// no randomness and performs no I/O. It interpolates numbers, and the renderer
// applies them.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
// this module's area enumerated:
//   TR-ANIM-01  js/html_actuator.js L54, L67-L72  the `previousPosition` and
//                                                 `position` pair, ported as
//                                                 `createMoveTween`
//   TR-ANIM-02  js/html_actuator.js L73-L80       the `.tile-merged` class
//                                                 carrying `pop`, ported as
//                                                 `createMergeTween`
//   TR-ANIM-03  js/html_actuator.js L82           the `.tile-new` class
//                                                 carrying `appear`, ported as
//                                                 `createSpawnTween`
//   TR-ANIM-04  js/html_actuator.js L114-L120     the `.score-addition` element
//                                                 carrying `move-up`, ported as
//                                                 `createScoreDeltaTween`
//   TR-ANIM-05  style/main.scss `.game-message`   the terminal overlay's
//                with `&.game-won`, `&.game-over` `fade-in`, ported as
//                                                 `createOverlayFadeTween`
//   TR-ANIM-06  target-only row                   `createTween`, `TweenStop`
//                                                 and the delay that yields the
//                                                 0% keyframe
//   TR-ANIM-07  target-only row                   `CSS_EASING_CURVES`,
//                                                 `createCubicBezierEasing`
//                                                 and `easingFor`
//
// Decisions: DL-ANIM-01, DL-ANIM-02, DL-ANIM-03 (docs/DECISION_LOG.md).

import type { Position } from '../engine/types';
import type { MotionEasing } from '../theme/tokens';
import { motion } from '../theme/tokens';
import type { RenderDetail, RenderReporter } from './webgl-support';
import {
  NOOP_RENDER_REPORTER,
  createGuardedRenderReporter,
  queryReducedMotion,
  subscribeReducedMotion,
} from './webgl-support';

/**
 * Progress through one keyframe interval mapped to the eased progress the
 * interval's timing function produces.
 */
export type EasingFunction = (progress: number) => number;

/**
 * The two inner control points of a cubic Bézier easing curve. The outer two
 * are fixed at (0, 0) and (1, 1).
 */
export interface CubicBezierCurve {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/**
 * Control points the three CSS easing keywords of `MotionEasing` are defined
 * as: `ease` is `cubic-bezier(0.25, 0.1, 0.25, 1)`, `ease-in` is
 * `cubic-bezier(0.42, 0, 1, 1)` and `ease-in-out` is `cubic-bezier(0.42, 0,
 * 0.58, 1)`, from CSS Easing Functions Level 1.
 *
 * style/main.scss names the keywords; these are the curves those names carry.
 */
export const CSS_EASING_CURVES: Readonly<
  Record<MotionEasing, CubicBezierCurve>
> = Object.freeze({
  ease: Object.freeze({ x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 }),
  'ease-in': Object.freeze({ x1: 0.42, y1: 0, x2: 1, y2: 1 }),
  'ease-in-out': Object.freeze({ x1: 0.42, y1: 0, x2: 0.58, y2: 1 }),
});

const CUBIC_INNER_COEFFICIENT = 3;

const CUBIC_DERIVATIVE_COEFFICIENT = 2;

const BISECTION_DIVISOR = 2;

const NEWTON_ITERATIONS = 8;

const BISECTION_ITERATIONS = 64;

const SOLVE_TOLERANCE = 1e-9;

const MIN_NEWTON_SLOPE = 1e-9;

interface AxisPolynomial {
  readonly a: number;
  readonly b: number;
  readonly c: number;
}

function axisPolynomial(p1: number, p2: number): AxisPolynomial {
  const c = CUBIC_INNER_COEFFICIENT * p1;
  const b = CUBIC_INNER_COEFFICIENT * (p2 - p1) - c;

  return { a: 1 - c - b, b, c };
}

function sampleAxis(axis: AxisPolynomial, t: number): number {
  return ((axis.a * t + axis.b) * t + axis.c) * t;
}

function sampleAxisSlope(axis: AxisPolynomial, t: number): number {
  return (
    (CUBIC_INNER_COEFFICIENT * axis.a * t +
      CUBIC_DERIVATIVE_COEFFICIENT * axis.b) *
      t +
    axis.c
  );
}

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

/** Builds the easing function of a cubic Bézier curve. */
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

/** The CSS `ease` keyword, as style/main.scss names it. */
export const ease: EasingFunction = /* @__PURE__ */ createCubicBezierEasing(
  CSS_EASING_CURVES.ease,
);

/** The CSS `ease-in` keyword. style/main.scss names it. */
export const easeIn: EasingFunction = /* @__PURE__ */ createCubicBezierEasing(
  CSS_EASING_CURVES['ease-in'],
);

/** The CSS `ease-in-out` keyword. style/main.scss names it. */
export const easeInOut: EasingFunction =
  /* @__PURE__ */ createCubicBezierEasing(CSS_EASING_CURVES['ease-in-out']);

const EASING_FUNCTIONS: Readonly<Record<MotionEasing, EasingFunction>> =
  Object.freeze({
    ease,
    'ease-in': easeIn,
    'ease-in-out': easeInOut,
  });

/** Resolves an easing keyword to its function. */
export function easingFor(keyword: MotionEasing): EasingFunction {
  return EASING_FUNCTIONS[keyword];
}

const DIAGNOSTIC_SOURCE = 'render/animations';

const TWEEN_ADDED_METRIC = 'render.animations.tween.added';

const TWEEN_COMPLETED_METRIC = 'render.animations.tween.completed';

const TWEEN_REMOVED_METRIC = 'render.animations.tween.removed';

const TWEEN_REDUCED_METRIC = 'render.animations.tween.reduced';

/** Counter incremented for each rejected step delta. */
const INVALID_DELTA_METRIC = 'render.animations.delta.invalid';

const INVALID_OPTION_METRIC = 'render.animations.option.invalid';

/**
 * One keyframe of a tween: an offset through the animated interval, and the
 * value at that offset.
 */
export interface TweenStop<TValue> {
  readonly offset: number;
  readonly value: TValue;
}

/** Produces the value between two adjacent keyframes. */
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
  readonly name: string;

  /** Length of the animated interval, in ms. */
  readonly duration: number;

  /** Delay the 0% keyframe is held across, in ms. */
  readonly delay: number;

  /** `delay` plus `duration`, in ms. */
  readonly totalDuration: number;
  readonly reducedMotion: boolean;
  readonly elapsed: () => number;
  readonly progress: () => number;
  readonly isComplete: () => boolean;
  readonly advance: (deltaMs: number) => void;
  readonly complete: () => void;
  readonly reset: () => void;
}

/** A tween over one value shape. */
export interface Tween<TValue> extends TweenBase {
  readonly value: () => TValue;
  readonly advance: (deltaMs: number) => TValue;
  readonly complete: () => TValue;
}

/** Construction parameters every tween factory accepts. All are optional. */
export interface TweenOptions {
  readonly reducedMotion?: boolean;
  readonly reporter?: RenderReporter;
}

/** Everything a tween needs that is not a construction option. */
export interface TweenDefinition<TValue> {
  readonly name: string;

  /** Length of the animated interval, in ms. */
  readonly duration: number;

  /** Delay the first keyframe is held across, in ms. */
  readonly delay: number;
  readonly easing: EasingFunction;
  readonly stops: readonly TweenStop<TValue>[];
  readonly interpolate: TweenInterpolator<TValue>;
}

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

interface DeltaGuard {
  readonly resolve: (deltaMs: number) => number;
  readonly rejections: () => number;
  readonly reset: () => void;
}

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
 * @returns `from` at or below zero, `to` at or above one, and the linear
 *   blend between them elsewhere.
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

const FIRST_STOP_OFFSET = 0;

const LAST_STOP_OFFSET = 1;

const MOVE_TWEEN_NAME = 'move';

const APPEAR_TWEEN_NAME = 'appear';

const POP_TWEEN_NAME = 'pop';

const MOVE_UP_TWEEN_NAME = 'move-up';

const FADE_IN_TWEEN_NAME = 'fade-in';

/** A board position, as the move tween interpolates it. */
export interface MoveTweenValue {
  readonly x: number;
  readonly y: number;
}

/** The `appear` keyframe pair of style/main.scss. */
export interface SpawnTweenValue {
  readonly scale: number;
  readonly opacity: number;
}

/** The `pop` keyframe triple of style/main.scss. */
export interface MergeTweenValue {
  readonly scale: number;
}

/** The `move-up` keyframe pair of style/main.scss. */
export interface ScoreDeltaTweenValue {
  readonly top: number;
  readonly opacity: number;
}

/** The `fade-in` keyframe pair of style/main.scss. */
export interface OverlayFadeTweenValue {
  readonly opacity: number;
}

const interpolateMove: TweenInterpolator<MoveTweenValue> = (
  from,
  to,
  ratio,
): MoveTweenValue => ({
  x: mix(from.x, to.x, ratio),
  y: mix(from.y, to.y, ratio),
});

const interpolateSpawn: TweenInterpolator<SpawnTweenValue> = (
  from,
  to,
  ratio,
): SpawnTweenValue => ({
  scale: mix(from.scale, to.scale, ratio),
  opacity: mix(from.opacity, to.opacity, ratio),
});

const interpolateMerge: TweenInterpolator<MergeTweenValue> = (
  from,
  to,
  ratio,
): MergeTweenValue => ({
  scale: mix(from.scale, to.scale, ratio),
});

const interpolateScoreDelta: TweenInterpolator<ScoreDeltaTweenValue> = (
  from,
  to,
  ratio,
): ScoreDeltaTweenValue => ({
  top: mix(from.top, to.top, ratio),
  opacity: mix(from.opacity, to.opacity, ratio),
});

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
  readonly to: Position;
}

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

/** Reports whether a tile needs a move tween at all. */
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
 * style/main.scss, over the position pair js/html_actuator.js L54 and L67-L72
 * read. style/main.scss narrows the transition to `transform`, which
 * `motion.movement.property` carries, so the renderer applies the interpolated
 * position as a transform and never as a layout change.
 *
 * A tween built with no `from` has an empty animated interval: it is complete
 * from construction and yields `to`. `requiresMoveTween` reports that case
 * ahead of construction.
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

      // style/main.scss declares the transition with no delay.
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
 * Builds the spawn tween: the `appear` keyframes of style/main.scss over the
 * timing that file applies them with, `200ms ease` after `$transition-speed`,
 * held at `opacity 0` and `scale(0)` for that delay by `animation-fill-mode:
 * backwards`. js/html_actuator.js L82 applied it through the `.tile-new`
 * class.
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
 * Builds the merge tween: the `pop` keyframes of style/main.scss over the
 * timing that file applies them with, `200ms ease` after `$transition-speed`,
 * held at `scale(0)` for that delay by `animation-fill-mode: backwards`. The
 * middle keyframe carries the overshoot of `motion.pop.keyframes.mid` at its
 * offset, and the timing function is applied across each of the two intervals,
 * so the overshoot is reached exactly. js/html_actuator.js L73-L80 applied it
 * through the `.tile-merged` class.
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
 * over the `600ms ease-in` that file applies them with, and no delay.
 * js/html_actuator.js L114-L120 applied it to the `.score-addition` element it
 * created for a positive score difference.
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
 * Builds the terminal-overlay tween: the `fade-in` keyframes of
 * style/main.scss over the `800ms ease` that file applies them with, after the
 * delay it writes as `$transition-speed * 12`. The overlay is at opacity 0 for
 * the whole of that delay. js/html_actuator.js L127-L133 applied it by adding
 * the `game-won` or `game-over` class to `.game-message`.
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

/**
 * Tween measurements, read synchronously and returned as plain data: numbers
 * only, with no tween reference, callback or live handle, so `JSON.stringify`
 * round-trips the snapshot and later steps do not mutate it.
 *
 * `active` is live at the moment of the read. Every other field is sampled
 * since the group was created or since `resetTweenStats` was last called.
 */
export interface TweenStats {
  readonly active: number;
  readonly maxActive: number;
  readonly added: number;
  readonly completed: number;
  readonly completedOnAdd: number;
  readonly removed: number;
  readonly advances: number;
  readonly advancedMs: number;
  readonly invalidDeltas: number;
}

/** Every construction parameter of a group. All are optional. */
export interface TweenGroupOptions {
  readonly reporter?: RenderReporter;

  /**
   * Whether the group follows the reduced-motion preference for the whole time
   * it is alive. Defaults to `true`.
   */
  readonly followReducedMotion?: boolean;
}

/**
 * A set of tweens stepped together.
 *
 * `advance` returns whether work is still outstanding, which is the value a
 * `FrameCallback` of src/render/render-loop.ts returns to keep a loop
 * constructed with `autoStopWhenIdle` scheduling frames.
 */
export interface TweenGroup {
  /**
   * Takes a tween into the group. A tween that is already complete — which is
   * every tween built with motion reduced — is counted and not retained.
   */
  readonly add: <TTween extends TweenBase>(tween: TTween) => TTween;

  /** Takes a tween back out, complete or not. */
  readonly remove: (tween: TweenBase) => boolean;

  readonly clear: () => number;
  readonly advance: (deltaMs: number) => boolean;
  readonly hasOutstandingWork: () => boolean;
  readonly size: () => number;
  readonly getTweenStats: () => TweenStats;
  readonly resetTweenStats: () => void;

  /**
   * Releases the reduced-motion subscription and clears the group.
   *
   * Calling it more than once is harmless. A group that is not disposed keeps
   * a live subscription in the render layer's store for as long as the store
   * lives.
   */

  readonly dispose: () => void;
}

/**
 * Builds a tween group.
 *
 * A released tween keeps the value it ended on, so a caller that holds its own
 * reference reads that value after the group has let it go.
 *
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
  let disposed = false;
  let stopMotion: (() => void) | null = null;

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

  /**
   * Steps every held tween to its final value and releases it.
   *
   * @param metric Counter the release is recorded under.
   * @returns How many tweens were released.
   */
  const completeAll = (metric: string): number => {
    const held = active.size;

    for (const tween of active) {
      // Completed BEFORE the release, so the value a caller holding its own
      // reference reads afterwards is the end state and not a part-way one.
      tween.complete();
      countTween(metric, tween, 1);
    }

    active.clear();

    return held;
  };

  const hasOutstandingWork = (): boolean => {
    for (const tween of active) {
      if (!tween.isComplete()) {
        return true;
      }
    }

    return false;
  };

  if (options.followReducedMotion !== false) {
    stopMotion = subscribeReducedMotion((reduced: boolean): void => {
      if (!reduced || disposed) {
        return;
      }

      const held = completeAll(TWEEN_COMPLETED_METRIC);

      completed += held;

      reporter.onCount({
        name: TWEEN_REDUCED_METRIC,
        value: held,
        detail: Object.freeze({ reduced }),
      });
    }, reporter);
  }

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
      const held = completeAll(TWEEN_REMOVED_METRIC);

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

    dispose: (): void => {
      if (disposed) {
        return;
      }

      disposed = true;

      const releaseMotion = stopMotion;

      stopMotion = null;
      releaseMotion?.();

      removed += completeAll(TWEEN_REMOVED_METRIC);
    },
  });
}
