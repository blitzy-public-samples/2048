// Camera punch and shake: the merge impulse and the jolt, both suppressed
// when motion is to be reduced.
//
// Timing, easing, delay and the impulse shape are read from
// src/theme/tokens.ts through src/render/animations.ts, so a punch runs on the
// cadence the stylesheet gives a merging tile:
//   style/main.scss L434-L446  the `pop` keyframes: 0% scale(0), 50%
//                              scale(1.2), 100% scale(1)
//   style/main.scss L448-L452  `.tile-merged .tile-inner` applying them as
//                              `pop 200ms ease $transition-speed` under
//                              `animation-fill-mode: backwards`, so the delay
//                              holds the 0% keyframe
//   style/main.scss L22        `$transition-speed: 100ms`, that delay
//   style/main.scss L234-L235  `fade-in 800ms ease $transition-speed * 12`,
//                              the terminal overlay's 1200ms delay, which is
//                              the ceiling a shake duration is clamped to
// The punch takes the `pop` overshoot as its impulse shape: it leaves rest at
// the 0% keyframe, peaks at the offset the overshoot sits on, and is back at
// rest at 100%.
//
// The merge that triggers it is the branch at js/html_actuator.js L73-L80,
// which pushed the `.tile-merged` class and recursed over the merged pair.
// That file is deleted; the merge now arrives as an engine event that
// src/render/three-renderer.ts forwards here.
//
// Punch magnitude is linear in the tile-ramp exponent — the normalisation
// style/main.scss L357 interpolates the tile fill along, which
// src/theme/tile-ramp.ts computes as `goldPercent`. A 2048 merge displaces
// the camera further than a 4, and every value above the ramp's last one
// resolves to the same ceiling.
//
// Invariants of this module: it holds no scene, mesh or engine reference and
// takes its camera as a construction parameter; it touches no DOM, reads no
// clock — every step is driven by the caller's clamped frame delta —
// consumes no randomness, and performs no I/O. The transform is only ever
// written as `rest + sum(active offsets)`; no effect reads the live camera and
// adds to it. Every effect's last keyframe is a displacement of zero.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import type {
  Camera,
  Quaternion,
  QuaternionLike,
  Vector3Like,
} from 'three';
import { Vector3 } from 'three';

import { rampExponent, tileRampConstants } from '../theme/tile-ramp';
import { depthScale, motion } from '../theme/tokens';
import type { Tween, TweenInterpolator, TweenStop } from './animations';
import { createTween, easingFor, mix } from './animations';
import type { RenderDetail, RenderReporter } from './webgl-support';
import {
  NOOP_RENDER_REPORTER,
  createGuardedRenderReporter,
  queryReducedMotion,
  subscribeReducedMotion,
} from './webgl-support';

/* ==========================================================================
 * 1. The frame contract
 * ========================================================================== */

/**
 * The part of a frame this module reads.
 *
 * `FrameContext` of src/render/render-loop.ts satisfies it: its `delta` is the
 * frame delta after that loop's `maxDelta` clamp, which is the value every
 * step here is driven by.
 */
export interface CameraFrameContext {
  /** Milliseconds since the previous frame, clamped by the caller. */
  readonly delta: number;
}

/** The two effects this module runs. */
export type CameraEffectKind = 'punch' | 'shake';

/* --------------------------------------------------------------------------
 * Reporting names
 * ----------------------------------------------------------------------- */

/** Source field carried by every diagnostic this module emits. */
const DIAGNOSTIC_SOURCE = 'render/camera-effects';

/** Counter incremented for each punch that starts. */
const PUNCH_METRIC = 'render.camera.punch';

/** Counter incremented for each shake that starts. */
const SHAKE_METRIC = 'render.camera.shake';

/** Counter incremented for each effect refused while motion is reduced. */
const SUPPRESSED_METRIC = 'render.camera.effect.suppressed';

/** Counter incremented for each intensity that arrived outside its range. */
const INTENSITY_CLAMPED_METRIC = 'render.camera.intensity.clamped';

/** Counter incremented for each shake duration that was clamped. */
const DURATION_CLAMPED_METRIC = 'render.camera.duration.clamped';

/** Counter incremented for each effect retired early at the limit. */
const EVICTED_METRIC = 'render.camera.effect.evicted';

/** Counter incremented for each frame whose composed offset was clamped. */
const OFFSET_CLAMPED_METRIC = 'render.camera.offset.clamped';

/** Counter incremented for each rejected frame delta. */
const INVALID_DELTA_METRIC = 'render.camera.delta.invalid';

/** Counter incremented for each rejected construction parameter. */
const INVALID_OPTION_METRIC = 'render.camera.option.invalid';

/** Counter incremented for each preference change that cleared the camera. */
const PREFERENCE_CLEARED_METRIC = 'render.camera.preference.cleared';

/* --------------------------------------------------------------------------
 * Named magnitudes and shapes
 * ----------------------------------------------------------------------- */

/** Name the punch tween carries in a report. */
const PUNCH_TWEEN_NAME = 'camera-punch';

/** Name the shake tween carries in a report. */
const SHAKE_TWEEN_NAME = 'camera-shake';

/** Offset of a first keyframe, the `0%` of a `@keyframes` block. */
const FIRST_KEYFRAME_OFFSET = 0;

/** Offset of a last keyframe, the `100%` of a `@keyframes` block. */
const LAST_KEYFRAME_OFFSET = 1;

/** Lowest intensity an effect runs at, at which it displaces nothing. */
const MIN_INTENSITY = 0;

/** Highest intensity an effect runs at. */
const MAX_INTENSITY = 1;

/** Displacement a keyframe carries where the camera sits at rest. */
const NO_DISPLACEMENT = 0;

/** Delay a shake holds its first keyframe across: it starts on request. */
const SHAKE_DELAY = 0;

/** Delta a rejected step is treated as. */
const NO_DELTA = 0;

/** One full oscillation, in radians. */
const FULL_TURN_RADIANS = Math.PI * 2;

/** A quarter of one oscillation, in radians. */
const QUARTER_TURN_RADIANS = FULL_TURN_RADIANS / 4;

/**
 * Full oscillations a shake completes across one `motion.pop` duration.
 * Overridable through `CameraEffectsOptions.shakeOscillations`.
 */
const DEFAULT_SHAKE_OSCILLATIONS = 3;

/**
 * Frequency of a shake's second axis as a multiple of its first. The two axes
 * run at different frequencies and a quarter oscillation apart, and their sum
 * traces a figure rather than a single diagonal.
 */
const SHAKE_CROSS_AXIS_RATIO = 1.5;

/**
 * Effects that may run at once. Admitting one beyond this retires the oldest
 * early. Overridable through `CameraEffectsOptions.maxConcurrentEffects`.
 */
const DEFAULT_MAX_CONCURRENT_EFFECTS = 8;

/**
 * Ceiling on the composed displacement, as a multiple of the resolved
 * `punchDistance`. Overridable through
 * `CameraEffectsOptions.maxOffsetDistance`.
 */
const DEFAULT_MAX_OFFSET_FACTOR = 4;

/** The camera's local right, `+X`. */
const LOCAL_RIGHT: Vector3Like = Object.freeze({ x: 1, y: 0, z: 0 });

/** The camera's local up, `+Y`. */
const LOCAL_UP: Vector3Like = Object.freeze({ x: 0, y: 1, z: 0 });

/** The camera's local view axis, `-Z`: a three.js camera looks down it. */
const LOCAL_FORWARD: Vector3Like = Object.freeze({ x: 0, y: 0, z: -1 });

/* ==========================================================================
 * 2. Intensity from merge magnitude
 * ========================================================================== */

/** The one number an effect's tween carries: a displacement in px. */
interface CameraOffsetValue {
  /** Displacement along the effect's axis or axes, in px. */
  readonly displacement: number;
}

/** Interpolates a displacement. */
const interpolateDisplacement: TweenInterpolator<CameraOffsetValue> = (
  from,
  to,
  ratio,
): CameraOffsetValue => ({
  displacement: mix(from.displacement, to.displacement, ratio),
});

/**
 * Confines an intensity to the range an effect runs over.
 *
 * @param intensity Requested intensity.
 * @returns The intensity where it lies in range, `MIN_INTENSITY` for a value
 *   below it or one that is not a finite number, and `MAX_INTENSITY` above.
 */
function clampIntensity(intensity: number): number {
  if (!Number.isFinite(intensity)) {
    return MIN_INTENSITY;
  }

  return Math.min(Math.max(intensity, MIN_INTENSITY), MAX_INTENSITY);
}

/**
 * The exponent a tile value stands at, for a value the ramp does not cover as
 * well as one it does.
 *
 * `rampExponent` of src/theme/tile-ramp.ts is the authority for a power of
 * `tileRampConstants.base` and rejects anything else, so it is consulted only
 * once the value is known to be one; a value a merge relic produced off the
 * ramp resolves to its fractional exponent instead.
 *
 * @param value Merged tile value.
 * @returns The exponent, never below `tileRampConstants.exponentStart`.
 */
function resolveExponent(value: number): number {
  const exponent = Math.log2(value);

  if (
    Number.isInteger(exponent) &&
    exponent >= tileRampConstants.exponentStart
  ) {
    return rampExponent(value);
  }

  if (!Number.isFinite(exponent)) {
    return tileRampConstants.exponentStart;
  }

  return Math.max(exponent, tileRampConstants.exponentStart);
}

/**
 * The punch intensity a merged tile value reads at.
 *
 * Linear in the exponent and not in the value, which is the normalisation
 * style/main.scss L357 states as
 * `($exponent - 1) / ($limit - 1) * 100` and src/theme/tile-ramp.ts carries as
 * `goldPercent`. The ramp's first exponent resolves to `MIN_INTENSITY` and its
 * last to `MAX_INTENSITY`; every super-tile value resolves to `MAX_INTENSITY`
 * rather than beyond it.
 *
 * @param value Merged tile value.
 * @returns An intensity from `MIN_INTENSITY` to `MAX_INTENSITY` inclusive.
 *
 * @example
 * ```ts
 * mergeIntensity(4);     // 0.1  — the ramp's second exponent
 * mergeIntensity(2048);  // 1    — the ramp's last exponent
 * mergeIntensity(65536); // 1    — clamped above the ramp
 * ```
 */
export function mergeIntensity(value: number): number {
  if (!Number.isFinite(value)) {
    return MIN_INTENSITY;
  }

  const span = tileRampConstants.limit - tileRampConstants.exponentStart;
  const reach = resolveExponent(value) - tileRampConstants.exponentStart;

  return clampIntensity(reach / span);
}

/* ==========================================================================
 * 3. The construction and reading contracts
 * ========================================================================== */

/**
 * A rest transform to adopt.
 *
 * Either field may be omitted, in which case the camera's live value is taken
 * for that field, less any displacement currently applied to it.
 */
export interface CameraRestInput {
  /** Position the camera returns to. */
  readonly position?: Vector3Like;

  /** Orientation the camera returns to. */
  readonly quaternion?: QuaternionLike;
}

/** The rest transform in force, as copies a caller may keep and mutate. */
export interface CameraRestTransform {
  /** Position the camera returns to. */
  readonly position: Vector3;

  /** Orientation the camera returns to. */
  readonly quaternion: Quaternion;
}

/**
 * Construction parameters. All are optional, and every spatial magnitude
 * defaults to a value derived from `depthScale` of src/theme/tokens.ts.
 */
export interface CameraEffectsOptions {
  /**
   * Peak displacement of a punch along the view axis at `MAX_INTENSITY`, in
   * px. Defaults to one tile extrusion depth, `depthScale.tile`.
   */
  readonly punchDistance?: number;

  /**
   * Peak displacement of a shake across the view plane at `MAX_INTENSITY`, in
   * px, per axis. Defaults to one bevel depth, `depthScale.bevel`.
   */
  readonly shakeDistance?: number;

  /**
   * Length of a shake whose caller states none, in ms. Defaults to the whole
   * `motion.pop` cadence, its delay plus its duration, and is itself confined
   * to `maxShakeDurationMs`.
   */
  readonly shakeDurationMs?: number;

  /**
   * Longest a shake may run, in ms. Defaults to `motion.fadeIn.delay`, the
   * delay style/main.scss L234-L235 holds the terminal overlay across.
   */
  readonly maxShakeDurationMs?: number;

  /**
   * Full oscillations a shake completes across one `motion.pop` duration.
   * Defaults to `DEFAULT_SHAKE_OSCILLATIONS`.
   */
  readonly shakeOscillations?: number;

  /**
   * Effects that may run at once. Admitting one beyond this retires the oldest
   * early. Defaults to `DEFAULT_MAX_CONCURRENT_EFFECTS`.
   */
  readonly maxConcurrentEffects?: number;

  /**
   * Ceiling on the composed displacement of every running effect, in px.
   * Defaults to the resolved `punchDistance` times
   * `DEFAULT_MAX_OFFSET_FACTOR`.
   */
  readonly maxOffsetDistance?: number;

  /**
   * Forces the reduced-motion decision and holds it for the lifetime of the
   * instance. Omitted, the effective preference is read live through
   * `queryReducedMotion()` of src/render/webgl-support.ts on every request and
   * followed through `subscribeReducedMotion()`, so the accessibility
   * surface's `setReducedMotionOverride()` and an operating-system setting
   * toggled mid-run both take effect without a reload.
   */
  readonly reducedMotion?: boolean;

  /**
   * Sink for effect counts, suppressions, clamps and rejected parameters.
   * Defaults to `NOOP_RENDER_REPORTER`.
   */
  readonly reporter?: RenderReporter;
}

/** What the instance has done and where it stands. */
export interface CameraEffectStats {
  /** Whether motion is being reduced, so requests are refused. */
  readonly reducedMotion: boolean;

  /** Effects running now, including one still inside its delay. */
  readonly active: number;

  /** Punches started. */
  readonly punches: number;

  /** Shakes started. */
  readonly shakes: number;

  /** Requests refused while motion is to be reduced. */
  readonly suppressed: number;

  /** Requested intensities that arrived outside their range. */
  readonly clampedIntensities: number;

  /** Requested shake durations that were confined. */
  readonly clampedDurations: number;

  /** Effects retired early to admit a newer one. */
  readonly evictedEffects: number;

  /** Frames whose composed displacement met the ceiling. */
  readonly clampedOffsets: number;

  /** Steps whose delta was rejected and treated as zero. */
  readonly invalidDeltas: number;

  /** Length of the displacement applied to the camera now, in px. */
  readonly offsetDistance: number;
}

/**
 * Camera punch and shake over one camera.
 *
 * Every member is safe to call at any time, before the first frame and after
 * `destroy()` alike.
 */
export interface CameraEffects {
  /**
   * Starts a punch: an impulse along the view axis on the `motion.pop`
   * cadence, out to its peak at the overshoot offset and back to rest.
   *
   * @param intensity Share of `punchDistance` to displace by, from
   *   `MIN_INTENSITY` to `MAX_INTENSITY`. Out-of-range values are confined and
   *   counted. Defaults to `MAX_INTENSITY`.
   * @returns Whether a punch was started. `false` where motion is to be
   *   reduced, and where the confined intensity displaces nothing.
   */
  punch(intensity?: number): boolean;

  /**
   * Starts a punch scaled to a merged tile value.
   *
   * @param value Merged tile value, as `tile:merge` reports it.
   * @returns Whether a punch was started.
   */
  punchForMerge(value: number): boolean;

  /**
   * Starts a shake: a decaying displacement across the view plane, driven by a
   * deterministic function of the shake's own elapsed time.
   *
   * @param intensity Share of `shakeDistance` to displace by per axis, from
   *   `MIN_INTENSITY` to `MAX_INTENSITY`. Defaults to `MAX_INTENSITY`.
   * @param durationMs Length of the shake, in ms. Confined to
   *   `maxShakeDurationMs`, and replaced by the resolved `shakeDurationMs`
   *   where it is not a finite number above zero. Defaults to that same
   *   resolved value.
   * @returns Whether a shake was started. `false` where motion is to be
   *   reduced, and where the confined intensity displaces nothing.
   */
  shake(intensity?: number, durationMs?: number): boolean;

  /**
   * Steps every running effect and writes the camera transform.
   *
   * Writes nothing while no effect is running, so a parked frame loop leaves
   * the camera exactly as the last step left it.
   *
   * @param context The frame, read for its clamped delta. A delta that is not
   *   a finite number of at least zero is counted and treated as zero.
   */
  advance(context: CameraFrameContext): void;

  /**
   * @returns Whether any effect is running, which is the value
   *   src/render/render-loop.ts reads as outstanding work.
   */
  isActive(): boolean;

  /** Drops every running effect and restores the rest transform at once. */
  reset(): void;

  /**
   * Adopts a rest transform, which every later effect is offset from.
   *
   * @param input Position and orientation to adopt. Either field, and the
   *   argument itself, may be omitted: an omitted field is taken from the
   *   camera's live value less the displacement currently applied to it.
   */
  setRestTransform(input?: CameraRestInput): void;

  /** @returns Copies of the rest position and orientation in force. */
  readRestTransform(): CameraRestTransform;

  /** @returns Whether motion is being reduced, so requests are refused. */
  isReducedMotion(): boolean;

  /** @returns What this instance has done and where it stands. */
  readStats(): CameraEffectStats;

  /** Clears every count `readStats()` reports. Present for suites. */
  resetStats(): void;

  /**
   * Drops every running effect, restores the rest transform and releases the
   * reduced-motion subscription. Later requests are refused.
   */
  destroy(): void;
}


/* ==========================================================================
 * 4. Construction
 * ========================================================================== */

/** One running effect: its kind, its tween, and how it displaces. */
interface ActiveEffect {
  /** Which effect this is, as a report names it. */
  readonly kind: CameraEffectKind;

  /** The tween carrying its displacement, and its elapsed time. */
  readonly tween: Tween<CameraOffsetValue>;

  /**
   * Adds this effect's displacement at the current step into an accumulator.
   *
   * @param target Accumulator every running effect adds into.
   */
  readonly contribute: (target: Vector3) => void;
}

/**
 * Reports one rejected construction parameter.
 *
 * @param reporter Sink the rejection is reported to.
 * @param option Parameter name, as `'punchDistance'`.
 * @param received Value supplied.
 * @param fallback Value used in its place.
 */
function reportRejectedOption(
  reporter: RenderReporter,
  option: string,
  received: number,
  fallback: number,
): void {
  const detail: RenderDetail = Object.freeze({
    option,
    received: Number.isFinite(received) ? received : null,
    fallback,
  });

  reporter.onCount({ name: INVALID_OPTION_METRIC, value: 1, detail });
  reporter.onDiagnostic({
    level: 'warning',
    source: DIAGNOSTIC_SOURCE,
    message: `The ${option} option was rejected; ${fallback} was used.`,
    detail,
  });
}

/**
 * Resolves one numeric construction parameter.
 *
 * @param supplied Value supplied, or `undefined` to take the fallback.
 * @param fallback Value to use where none was supplied or the supplied one is
 *   unusable.
 * @param option Parameter name, for the report.
 * @param reporter Sink a rejection is reported to.
 * @returns The supplied value where it is a finite number above zero, and
 *   `fallback` otherwise, in which case the rejection is reported.
 */
function resolveOption(
  supplied: number | undefined,
  fallback: number,
  option: string,
  reporter: RenderReporter,
): number {
  if (supplied === undefined) {
    return fallback;
  }

  if (Number.isFinite(supplied) && supplied > NO_DISPLACEMENT) {
    return supplied;
  }

  reportRejectedOption(reporter, option, supplied, fallback);

  return fallback;
}

/**
 * Creates the camera punch and shake for one camera.
 *
 * The camera's position and orientation are captured as the rest transform at
 * construction, and `setRestTransform()` replaces that capture when
 * src/render/scene.ts reframes the camera for a different board size. This
 * module imports neither that module nor the accessibility settings surface.
 *
 * @param camera Camera to displace. Any camera is accepted: the punch runs
 *   along its view axis rather than through a projection parameter.
 * @param options Magnitudes, limits, the reduced-motion decision and the
 *   reporter.
 * @returns A frozen controller. Constructed with motion reduced, every request
 *   is refused and the camera is never written.
 *
 * @example
 * ```ts
 * const effects = createCameraEffects(camera);
 *
 * events.on('tile:merge', (merge) => {
 *   effects.punchForMerge(merge.resultValue);
 * });
 *
 * loop.addFrameCallback((frame) => {
 *   effects.advance(frame);
 *   return effects.isActive();
 * });
 * ```
 */
export function createCameraEffects(
  camera: Camera,
  options: CameraEffectsOptions = {},
): CameraEffects {
  const reporter = createGuardedRenderReporter(
    options.reporter ?? NOOP_RENDER_REPORTER,
  );

  const punchDistance = resolveOption(
    options.punchDistance,
    depthScale.tile,
    'punchDistance',
    reporter,
  );

  const shakeDistance = resolveOption(
    options.shakeDistance,
    depthScale.bevel,
    'shakeDistance',
    reporter,
  );

  const maxShakeDuration = resolveOption(
    options.maxShakeDurationMs,
    motion.fadeIn.delay,
    'maxShakeDurationMs',
    reporter,
  );

  const shakeDuration = Math.min(
    resolveOption(
      options.shakeDurationMs,
      motion.pop.delay + motion.pop.duration,
      'shakeDurationMs',
      reporter,
    ),
    maxShakeDuration,
  );

  const shakeOscillations = resolveOption(
    options.shakeOscillations,
    DEFAULT_SHAKE_OSCILLATIONS,
    'shakeOscillations',
    reporter,
  );

  const maxConcurrentEffects = resolveOption(
    options.maxConcurrentEffects,
    DEFAULT_MAX_CONCURRENT_EFFECTS,
    'maxConcurrentEffects',
    reporter,
  );

  const maxOffsetDistance = resolveOption(
    options.maxOffsetDistance,
    punchDistance * DEFAULT_MAX_OFFSET_FACTOR,
    'maxOffsetDistance',
    reporter,
  );

  // Radians per millisecond: `shakeOscillations` full turns across one
  // `motion.pop` duration.
  const shakeAngularSpeed =
    (FULL_TURN_RADIANS * shakeOscillations) / motion.pop.duration;

  // The timing function style/main.scss L450 names, resolved once.
  const impulseEasing = easingFor(motion.pop.easing);

  const restPosition = camera.position.clone();
  const restQuaternion = camera.quaternion.clone();

  // The three axes every displacement is expressed along, derived from the
  // REST orientation rather than the live one.
  const forwardAxis = new Vector3();
  const rightAxis = new Vector3();
  const upAxis = new Vector3();

  // Displacement written into the camera by the last step.
  const appliedOffset = new Vector3();

  // Accumulator every running effect adds into, reused by every step rather
  // than allocated per frame.
  const composed = new Vector3();

  const effects: ActiveEffect[] = [];

  const forcedReducedMotion = options.reducedMotion;

  let reducedMotion = forcedReducedMotion ?? queryReducedMotion();
  let destroyed = false;

  let punches = 0;
  let shakes = 0;
  let suppressed = 0;
  let clampedIntensities = 0;
  let clampedDurations = 0;
  let evictedEffects = 0;
  let clampedOffsets = 0;
  let invalidDeltas = 0;
  let deltaAnnounced = false;

  /** Recomputes the three axes from the rest orientation. */
  const refreshAxes = (): void => {
    forwardAxis.copy(LOCAL_FORWARD).applyQuaternion(restQuaternion);
    rightAxis.copy(LOCAL_RIGHT).applyQuaternion(restQuaternion);
    upAxis.copy(LOCAL_UP).applyQuaternion(restQuaternion);
  };

  /** Writes the rest transform and records that nothing is displaced. */
  const applyRest = (): void => {
    camera.position.copy(restPosition);
    camera.quaternion.copy(restQuaternion);
    composed.set(NO_DISPLACEMENT, NO_DISPLACEMENT, NO_DISPLACEMENT);
    appliedOffset.set(NO_DISPLACEMENT, NO_DISPLACEMENT, NO_DISPLACEMENT);
  };

  /**
   * Writes `rest + composed` onto the camera.
   *
   * A composed displacement of exactly zero writes the rest transform itself
   * rather than adding to it, so the transform a completed effect leaves is
   * the captured one and not a sum that happens to equal it.
   */
  const writeTransform = (): void => {
    if (
      composed.x === NO_DISPLACEMENT &&
      composed.y === NO_DISPLACEMENT &&
      composed.z === NO_DISPLACEMENT
    ) {
      applyRest();

      return;
    }

    camera.position.copy(restPosition).add(composed);
    camera.quaternion.copy(restQuaternion);
    appliedOffset.copy(composed);
  };

  /** Confines the composed displacement to `maxOffsetDistance`. */
  const clampComposed = (): void => {
    const distance = composed.length();

    if (distance <= maxOffsetDistance) {
      return;
    }

    composed.multiplyScalar(maxOffsetDistance / distance);
    clampedOffsets += 1;
    reporter.onCount({
      name: OFFSET_CLAMPED_METRIC,
      value: 1,
      detail: Object.freeze({
        requested: distance,
        applied: maxOffsetDistance,
      }),
    });
  };

  /** Sums every running effect's displacement and writes the transform. */
  const applyComposed = (): void => {
    composed.set(NO_DISPLACEMENT, NO_DISPLACEMENT, NO_DISPLACEMENT);

    for (const effect of effects) {
      effect.contribute(composed);
    }

    clampComposed();
    writeTransform();
  };

  /** @returns Whether requests are being refused. */
  const isRefusing = (): boolean => destroyed || reducedMotion;

  /**
   * Counts and reports one refused request.
   *
   * @param kind Effect that was refused.
   */
  const reportSuppressed = (kind: CameraEffectKind): void => {
    suppressed += 1;
    reporter.onCount({
      name: SUPPRESSED_METRIC,
      value: 1,
      detail: Object.freeze({ effect: kind, reducedMotion, destroyed }),
    });
  };

  /**
   * Confines a requested intensity, counting what it confines.
   *
   * @param kind Effect the intensity belongs to.
   * @param intensity Requested intensity.
   * @returns The confined intensity.
   */
  const resolveIntensity = (
    kind: CameraEffectKind,
    intensity: number,
  ): number => {
    const applied = clampIntensity(intensity);

    if (applied === intensity) {
      return applied;
    }

    clampedIntensities += 1;
    reporter.onCount({
      name: INTENSITY_CLAMPED_METRIC,
      value: 1,
      detail: Object.freeze({
        effect: kind,
        requested: Number.isFinite(intensity) ? intensity : null,
        applied,
      }),
    });

    return applied;
  };

  /**
   * Takes one effect, retiring the oldest early where the limit is reached.
   *
   * @param effect Effect to run.
   */
  const admit = (effect: ActiveEffect): void => {
    while (effects.length >= maxConcurrentEffects) {
      const oldest = effects.shift();

      if (oldest === undefined) {
        break;
      }

      oldest.tween.complete();
      evictedEffects += 1;
      reporter.onCount({
        name: EVICTED_METRIC,
        value: 1,
        detail: Object.freeze({ effect: oldest.kind, limit: effects.length }),
      });
    }

    effects.push(effect);
  };

  /**
   * Validates one frame delta.
   *
   * @param deltaMs Delta the frame reported.
   * @returns The delta where it is a finite number of at least zero, and
   *   `NO_DELTA` otherwise, in which case the rejection is counted and the
   *   first such rejection is also reported.
   */
  const resolveDelta = (deltaMs: number): number => {
    if (Number.isFinite(deltaMs) && deltaMs >= NO_DELTA) {
      return deltaMs;
    }

    invalidDeltas += 1;

    const detail: RenderDetail = Object.freeze({
      delta: Number.isFinite(deltaMs) ? deltaMs : null,
    });

    reporter.onCount({ name: INVALID_DELTA_METRIC, value: 1, detail });

    if (!deltaAnnounced) {
      deltaAnnounced = true;
      reporter.onDiagnostic({
        level: 'warning',
        source: DIAGNOSTIC_SOURCE,
        message: 'A camera-effect step was rejected; zero was used.',
        detail,
      });
    }

    return NO_DELTA;
  };

  /** Drops every running effect, leaving each of them complete. */
  const dropEffects = (): void => {
    for (const effect of effects) {
      effect.tween.complete();
    }

    effects.length = 0;
  };

  refreshAxes();

  /**
   * Follows a preference change: motion becoming reduced drops every running
   * effect and restores the rest transform on the spot.
   *
   * @param reduced The effective preference.
   */
  const handlePreferenceChange = (reduced: boolean): void => {
    reducedMotion = reduced;

    if (!reduced) {
      return;
    }

    const running = effects.length;

    dropEffects();
    applyRest();

    reporter.onCount({
      name: PREFERENCE_CLEARED_METRIC,
      value: 1,
      detail: Object.freeze({ dropped: running }),
    });
  };

  const releasePreference =
    forcedReducedMotion === undefined
      ? subscribeReducedMotion(handlePreferenceChange, reporter)
      : undefined;

  /**
   * Starts a punch.
   *
   * @param intensity Share of `punchDistance` to displace by.
   * @returns Whether a punch was started.
   */
  const punch = (intensity: number = MAX_INTENSITY): boolean => {
    if (isRefusing()) {
      reportSuppressed('punch');

      return false;
    }

    const applied = resolveIntensity('punch', intensity);

    if (applied === MIN_INTENSITY) {
      return false;
    }

    const peak = punchDistance * applied;

    // style/main.scss L434-L446: three keyframes, the middle one carrying the
    // overshoot at the offset it sits on. The first and last carry no
    // displacement, so the impulse leaves rest and returns to it.
    const stops: readonly TweenStop<CameraOffsetValue>[] = [
      {
        offset: FIRST_KEYFRAME_OFFSET,
        value: { displacement: NO_DISPLACEMENT },
      },
      {
        offset: motion.pop.keyframes.mid.offset,
        value: { displacement: peak },
      },
      {
        offset: LAST_KEYFRAME_OFFSET,
        value: { displacement: NO_DISPLACEMENT },
      },
    ];

    // style/main.scss L450: `pop 200ms ease $transition-speed`.
    const tween = createTween<CameraOffsetValue>(
      {
        name: PUNCH_TWEEN_NAME,
        duration: motion.pop.duration,
        delay: motion.pop.delay,
        easing: impulseEasing,
        stops,
        interpolate: interpolateDisplacement,
      },
      { reducedMotion: false, reporter },
    );

    admit({
      kind: 'punch',
      tween,
      contribute: (target: Vector3): void => {
        target.addScaledVector(forwardAxis, tween.value().displacement);
      },
    });

    punches += 1;
    reporter.onCount({
      name: PUNCH_METRIC,
      value: 1,
      detail: Object.freeze({ intensity: applied, peak }),
    });

    return true;
  };

  /**
   * Starts a shake.
   *
   * @param intensity Share of `shakeDistance` to displace by per axis.
   * @param durationMs Length of the shake, in ms.
   * @returns Whether a shake was started.
   */
  const shake = (
    intensity: number = MAX_INTENSITY,
    durationMs: number = shakeDuration,
  ): boolean => {
      if (isRefusing()) {
        reportSuppressed('shake');

        return false;
      }

      const applied = resolveIntensity('shake', intensity);

      if (applied === MIN_INTENSITY) {
        return false;
      }

      const requested = resolveOption(
        durationMs,
        shakeDuration,
        'durationMs',
        reporter,
      );
      const duration = Math.min(requested, maxShakeDuration);

      if (duration !== requested) {
        clampedDurations += 1;
        reporter.onCount({
          name: DURATION_CLAMPED_METRIC,
          value: 1,
          detail: Object.freeze({ requested, applied: duration }),
        });
      }

      const peak = shakeDistance * applied;
      const stops: readonly TweenStop<CameraOffsetValue>[] = [
        { offset: FIRST_KEYFRAME_OFFSET, value: { displacement: peak } },
        {
          offset: LAST_KEYFRAME_OFFSET,
          value: { displacement: NO_DISPLACEMENT },
        },
      ];

      const tween = createTween<CameraOffsetValue>(
        {
          name: SHAKE_TWEEN_NAME,
          duration,
          delay: SHAKE_DELAY,
          easing: impulseEasing,
          stops,
          interpolate: interpolateDisplacement,
        },
        { reducedMotion: false, reporter },
      );

      admit({
        kind: 'shake',
        tween,
        contribute: (target: Vector3): void => {
          const amplitude = tween.value().displacement;

          if (amplitude === NO_DISPLACEMENT) {
            return;
          }

          // Deterministic in the shake's own elapsed time: two sine terms at
          // different frequencies, a quarter turn apart. No clock is read and
          // no randomness is consumed, so one shake replays identically.
          const phase = tween.elapsed() * shakeAngularSpeed;

          target.addScaledVector(rightAxis, amplitude * Math.sin(phase));
          target.addScaledVector(
            upAxis,
            amplitude *
              Math.sin(phase * SHAKE_CROSS_AXIS_RATIO + QUARTER_TURN_RADIANS),
          );
        },
      });

    shakes += 1;
    reporter.onCount({
      name: SHAKE_METRIC,
      value: 1,
      detail: Object.freeze({ intensity: applied, peak, duration }),
    });

    return true;
  };

  /**
   * Steps every running effect and writes the camera transform.
   *
   * @param context The frame, read for its clamped delta.
   */
  const advance = (context: CameraFrameContext): void => {
    if (effects.length === 0) {
      return;
    }

    const deltaMs = resolveDelta(context?.delta);

    for (const effect of effects) {
      effect.tween.advance(deltaMs);
    }

    // Composed over every effect, a completed one included: its last keyframe
    // carries no displacement, so the frame it completes on writes rest.
    applyComposed();

    for (let index = effects.length - 1; index >= 0; index -= 1) {
      if (effects[index].tween.isComplete()) {
        effects.splice(index, 1);
      }
    }
  };

  /**
   * Adopts a rest transform and re-applies the current displacement from it.
   *
   * @param input Position and orientation to adopt. An omitted field is taken
   *   from the camera's live value less the displacement applied to it.
   */
  const setRestTransform = (input: CameraRestInput = {}): void => {
    if (input.position === undefined) {
      restPosition.copy(camera.position).sub(appliedOffset);
    } else {
      restPosition.copy(input.position);
    }

    if (input.quaternion === undefined) {
      restQuaternion.copy(camera.quaternion);
    } else {
      restQuaternion.copy(input.quaternion);
    }

    refreshAxes();
    applyComposed();
  };

  return Object.freeze({
    punch,

    punchForMerge: (value: number): boolean => punch(mergeIntensity(value)),

    shake,

    advance,

    isActive: (): boolean => effects.length > 0,

    reset: (): void => {
      dropEffects();
      applyRest();
    },

    setRestTransform,

    readRestTransform: (): CameraRestTransform =>
      Object.freeze({
        position: restPosition.clone(),
        quaternion: restQuaternion.clone(),
      }),

    isReducedMotion: (): boolean => reducedMotion,

    readStats: (): CameraEffectStats =>
      Object.freeze({
        reducedMotion,
        active: effects.length,
        punches,
        shakes,
        suppressed,
        clampedIntensities,
        clampedDurations,
        evictedEffects,
        clampedOffsets,
        invalidDeltas,
        offsetDistance: appliedOffset.length(),
      }),

    resetStats: (): void => {
      punches = 0;
      shakes = 0;
      suppressed = 0;
      clampedIntensities = 0;
      clampedDurations = 0;
      evictedEffects = 0;
      clampedOffsets = 0;
      invalidDeltas = 0;
      deltaAnnounced = false;
    },

    destroy: (): void => {
      destroyed = true;
      dropEffects();
      applyRest();

      if (releasePreference !== undefined) {
        releasePreference();
      }
    },
  });
}

