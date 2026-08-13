// Camera punch and shake: the merge impulse and the jolt, both suppressed when
// motion is to be reduced.
//
// The punch takes the `pop` overshoot as its impulse shape: it leaves rest at
// the 0% keyframe, peaks at the offset the overshoot sits on, and is back at
// rest at 100%.
//
// The punch is drawn on the camera's PROJECTION — a transient widening of the
// frustum through `zoom` — wherever the camera carries one, and on a view-axis
// displacement only where it does not. src/render/scene.ts builds an
// `OrthographicCamera`, whose projection has no perspective divide, so a
// displacement along that camera's own view axis leaves the projected image
// identical and reached the screen as nothing at all. Decision DL-CAMERA-04.
//
// Punch magnitude is linear in the tile-ramp exponent — the normalisation the
// stylesheet interpolates the tile fill along, which src/theme/tile-ramp.ts
// computes as `goldPercent`. A 2048 merge displaces the camera further than a
// 4, and every value above the ramp's last one resolves to the same ceiling.
//
// src/render/three-renderer.ts forwards here.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
// this module's area enumerated:
//   TR-CAMERA-01  style/main.scss `pop` keyframes  the overshoot shape, ported
//                                                  as the punch impulse
//   TR-CAMERA-02  target-only row                  `createCameraEffects()` and
//                                                  the punch
//   TR-CAMERA-03  target-only row                  the shake, clamped to the
//                                                  terminal overlay's delay
//   TR-CAMERA-04  target-only row                  the reduced-motion gate
//   TR-CAMERA-05  target-only row                  `mergeIntensity()`, linear
//                                                  in the tile-ramp exponent
//
// Decisions: DL-CAMERA-01, DL-CAMERA-02, DL-CAMERA-03, DL-CAMERA-05
// (docs/DECISION_LOG.md).

import type {
  Camera,
  Quaternion,
  QuaternionLike,
  Vector3Like,
} from 'three';
import { Vector3 } from 'three';

import { rampExponent, tileRampConstants } from '../theme/tile-ramp';

// CHANGED: a type import beside the value imports, for the board geometry the
// punch's zoom share is measured against. DL-CAMERA-05.
import type { GeometryScale } from '../theme/tokens';
import { depthScale, fieldWidth, motion } from '../theme/tokens';
import type { Tween, TweenInterpolator, TweenStop } from './animations';
import { createTween, easingFor, mix } from './animations';
import type { RenderDetail, RenderReporter } from './webgl-support';
import {
  NOOP_RENDER_REPORTER,
  createGuardedRenderReporter,
  queryReducedMotion,
  subscribeReducedMotion,
} from './webgl-support';

/**
 * The part of a frame this module reads.
 *
 * `FrameContext` of src/render/render-loop.ts satisfies it: its `delta` is the
 * frame delta after that loop's `maxDelta` clamp, which is the value every
 * step here is driven by.
 */
export interface CameraFrameContext {
  readonly delta: number;
}

/** The two effects this module runs. */
export type CameraEffectKind = 'punch' | 'shake';

const DIAGNOSTIC_SOURCE = 'render/camera-effects';

const PUNCH_METRIC = 'render.camera.punch';

const SHAKE_METRIC = 'render.camera.shake';

const SUPPRESSED_METRIC = 'render.camera.effect.suppressed';

const INTENSITY_CLAMPED_METRIC = 'render.camera.intensity.clamped';

const DURATION_CLAMPED_METRIC = 'render.camera.duration.clamped';

const EVICTED_METRIC = 'render.camera.effect.evicted';

const OFFSET_CLAMPED_METRIC = 'render.camera.offset.clamped';

const INVALID_DELTA_METRIC = 'render.camera.delta.invalid';

const INVALID_OPTION_METRIC = 'render.camera.option.invalid';

const PREFERENCE_CLEARED_METRIC = 'render.camera.preference.cleared';

const ZOOM_CLAMPED_METRIC = 'render.camera.zoom.clamped';

/**
 * Counter raised per zoom share re-measured against a new board geometry,
 * carrying the share it moved to. DL-CAMERA-05.
 */
const GEOMETRY_METRIC = 'render.camera.geometry';

/**
 * Counter raised where a geometry is offered to an instance whose zoom share a
 * caller pinned, so the refusal is visible rather than silent. DL-CAMERA-05.
 */
const GEOMETRY_PINNED_METRIC = 'render.camera.geometry.pinned';

const PUNCH_TWEEN_NAME = 'camera-punch';

const SHAKE_TWEEN_NAME = 'camera-shake';

const FIRST_KEYFRAME_OFFSET = 0;

const LAST_KEYFRAME_OFFSET = 1;

const MIN_INTENSITY = 0;

const MAX_INTENSITY = 1;

const NO_DISPLACEMENT = 0;

const SHAKE_DELAY = 0;

const NO_DELTA = 0;

const FULL_TURN_RADIANS = Math.PI * 2;

const QUARTER_TURN_RADIANS = FULL_TURN_RADIANS / 4;

const DEFAULT_SHAKE_OSCILLATIONS = 3;

const SHAKE_CROSS_AXIS_RATIO = 1.5;

const DEFAULT_MAX_CONCURRENT_EFFECTS = 8;

const DEFAULT_MAX_OFFSET_FACTOR = 4;

/**
 * Peak share of the rest zoom a full-intensity punch adds to the frustum, as
 * arithmetic on the geometry and depth tokens of src/theme/tokens.ts: the
 * board's own extrusion depth over the board measure.
 *
 * src/render/scene.ts frames the drawn board with `sceneOptics.margin` of
 * clearance and the field mesh it draws is `fieldWidth` across, so widening the
 * frustum by this share reveals more of the same field and narrowing it by any
 * perceptible share would crop the outer tile row. The punch therefore widens.
 *
 * The DESKTOP measure, and the fallback alone: `punchZoomFor` derives the share
 * from the field in force, so the punch stays the same share of the board the
 * player is looking at. DL-CAMERA-05.
 */
const DEFAULT_PUNCH_ZOOM = depthScale.board / fieldWidth;

/** Multiple of the punch's own peak the composed zoom share is confined to. */
const DEFAULT_MAX_ZOOM_FACTOR = 2;


const NO_ZOOM_SHARE = 0;

/** The rest zoom assumed for a camera whose projection carries none. */
const UNIT_ZOOM = 1;

const LOCAL_RIGHT: Vector3Like = Object.freeze({ x: 1, y: 0, z: 0 });

const LOCAL_UP: Vector3Like = Object.freeze({ x: 0, y: 1, z: 0 });

const LOCAL_FORWARD: Vector3Like = Object.freeze({ x: 0, y: 0, z: -1 });

/**
 * The punch's peak zoom share for one board geometry: the board's extrusion
 * depth over THAT geometry's field measure.
 *
 * `punchDistance` and `shakeDistance` have no counterpart here on purpose. Both
 * are expressions on `depthScale`, which src/render/tile-mesh-factory.ts
 * extrudes every block by at both scales, so neither changes with the scale. The
 * zoom share is the one magnitude measured against a PLANAR length, and the
 * planar lengths are exactly what a scale changes: the mobile field is 280px
 * against the desktop 500px, so a share fixed to the desktop measure resolves to
 * 0.56 of the punch the same board deserves. DL-CAMERA-05.
 *
 * @param geometry The scale and board size in force.
 * @returns The share, or the desktop default where the scale states no usable
 *   field measure.
 */
export function punchZoomFor(geometry: GeometryScale): number {
  const share = depthScale.board / geometry.fieldWidth;

  return Number.isFinite(share) && share > NO_ZOOM_SHARE
    ? share
    : DEFAULT_PUNCH_ZOOM;
}

interface CameraOffsetValue {
  readonly displacement: number;
}

const interpolateDisplacement: TweenInterpolator<CameraOffsetValue> = (
  from,
  to,
  ratio,
): CameraOffsetValue => ({
  displacement: mix(from.displacement, to.displacement, ratio),
});

function clampIntensity(intensity: number): number {
  if (!Number.isFinite(intensity)) {
    return MIN_INTENSITY;
  }

  return Math.min(Math.max(intensity, MIN_INTENSITY), MAX_INTENSITY);
}

/**
 * The projection members a camera exposes where it carries a zoom.
 *
 * `OrthographicCamera` and `PerspectiveCamera` both satisfy it; the `Camera`
 * base class does not.
 */
interface ZoomableProjection {
  zoom: number;
  updateProjectionMatrix(): void;
}

/**
 * Reads a camera's zoom-bearing projection.
 *
 * @param camera Camera to read.
 * @returns The projection, or `null` for a camera carrying no usable zoom.
 */
function readZoomableProjection(camera: Camera): ZoomableProjection | null {
  const candidate = camera as unknown as Partial<ZoomableProjection>;

  return typeof candidate.zoom === 'number' &&
    Number.isFinite(candidate.zoom) &&
    candidate.zoom > NO_ZOOM_SHARE &&
    typeof candidate.updateProjectionMatrix === 'function'
    ? (candidate as ZoomableProjection)
    : null;
}

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

/** The punch intensity a merged tile value reads at. */
export function mergeIntensity(value: number): number {
  if (!Number.isFinite(value)) {
    return MIN_INTENSITY;
  }

  const span = tileRampConstants.limit - tileRampConstants.exponentStart;
  const reach = resolveExponent(value) - tileRampConstants.exponentStart;

  return clampIntensity(reach / span);
}

/**
 * A rest transform to adopt.
 *
 * Either field may be omitted, in which case the camera's live value is taken
 * for that field, less any displacement currently applied to it.
 */
export interface CameraRestInput {
  readonly position?: Vector3Like;
  readonly quaternion?: QuaternionLike;
}

/** The rest transform in force, as copies a caller may keep and mutate. */
export interface CameraRestTransform {
  readonly position: Vector3;
  readonly quaternion: Quaternion;
}

/**
 * Construction parameters. All are optional, and every spatial magnitude
 * defaults to a value derived from `depthScale` of src/theme/tokens.ts.
 */
export interface CameraEffectsOptions {
  /**
   * Displacement a full-intensity punch applies along the camera's view axis,
   * which reaches the image only under a camera carrying no zoom. It also
   * derives the default `maxOffsetDistance` the composed displacement — the
   * shake's included — is confined to.
   */
  readonly punchDistance?: number;

  /**
   * Share of the rest zoom a full-intensity punch adds to the frustum, which is
   * what a punch is drawn with wherever the camera's projection carries a zoom.
   * Defaults to one derived from `geometry` below, and to `DEFAULT_PUNCH_ZOOM`
   * where no geometry is supplied.
   */
  readonly punchZoom?: number;

  /**
   * The board geometry the punch's zoom share is measured against. Supplied,
   * `punchZoom` defaults to `punchZoomFor(geometry)`; `useGeometry` replaces it
   * whenever the renderer reframes for another scale or board size. An explicit
   * `punchZoom` outranks both. DL-CAMERA-05.
   */
  readonly geometry?: GeometryScale;
  readonly shakeDistance?: number;

  /**
   * Length of a shake whose caller states none, in ms. Defaults to the whole
   * `motion.pop` cadence, its delay plus its duration, and is itself confined
   * to `maxShakeDurationMs`.
   */
  readonly shakeDurationMs?: number;

  /**
   * Longest a shake may run, in ms. Defaults to `motion.fadeIn.delay`, the
   * delay style/main.scss holds the terminal overlay across.
   */
  readonly maxShakeDurationMs?: number;
  readonly shakeOscillations?: number;
  readonly maxConcurrentEffects?: number;
  readonly maxOffsetDistance?: number;

  /**
   * Forces the reduced-motion decision and holds it for the lifetime of the
   * instance. Omitted, the effective preference is read live through
   * `queryReducedMotion` of src/render/webgl-support.ts on every request and
   * followed through `subscribeReducedMotion`, so an explicit
   * `setReducedMotionOverride` and an operating-system setting toggled mid-run
   * both take effect without a reload.
   */
  readonly reducedMotion?: boolean;
  readonly reporter?: RenderReporter;
}

/** What the instance has done and where it stands. */
export interface CameraEffectStats {
  readonly reducedMotion: boolean;
  readonly active: number;
  readonly punches: number;
  readonly shakes: number;
  readonly suppressed: number;
  readonly clampedIntensities: number;
  readonly clampedDurations: number;
  readonly evictedEffects: number;
  readonly clampedOffsets: number;

  /** Composed zoom shares that were confined to `maxZoomShare`. */
  readonly clampedZooms: number;

  /** Steps whose delta was rejected and treated as zero. */
  readonly invalidDeltas: number;
  readonly offsetDistance: number;

  /**
   * Share of the rest zoom written into the projection by the last step, and
   * zero for a camera carrying no zoom.
   */
  readonly zoomShare: number;

  /**
   * Peak share a full-intensity punch adds, as measured against the geometry in
   * force or as pinned by a caller. DL-CAMERA-05.
   */
  readonly punchZoom: number;

  /** Whether an explicit `punchZoom` option pinned that share. */
  readonly punchZoomPinned: boolean;
}

/**
 * Camera punch and shake over one camera.
 *
 * Every member is safe to call at any time, before the first frame and after
 * `destroy` alike.
 */
export interface CameraEffects {
  punch(intensity?: number): boolean;
  punchForMerge(value: number): boolean;

  /**
   * Starts a shake: a decaying displacement across the view plane, driven by a
   * deterministic function of the shake's own elapsed time.
   *
   * @returns Whether a shake was started. `false` where motion is to be
   *   reduced, and where the confined intensity displaces nothing.
   */
  shake(intensity?: number, durationMs?: number): boolean;

  /**
   * Steps every running effect and writes the camera transform.
   *
   * Writes nothing while no effect is running, so a parked frame loop leaves
   * the camera exactly as the last step left it.
   */
  advance(context: CameraFrameContext): void;
  isActive(): boolean;
  reset(): void;

  /**
   * Measures the punch's zoom share against a different board geometry, and
   * re-derives the composed ceiling with it.
   *
   * Called by the renderer from every path that rebuilds its board — a
   * configured board size that changed, the breakpoint crossing that swaps the
   * scale, and the rebuild after a restored context — beside
   * `setRestTransform`, which carries the reframed camera's rest pose. Running
   * effects keep the share they were started under; the next punch takes the new
   * one.
   *
   * An instance constructed with an explicit `punchZoom` is PINNED: the request
   * is reported and the stated share stands. DL-CAMERA-05.
   *
   * @param geometry The scale and board size now in force.
   * @returns The peak zoom share in force after the call.
   */
  useGeometry(geometry: GeometryScale): number;

  setRestTransform(input?: CameraRestInput): void;
  readRestTransform(): CameraRestTransform;
  isReducedMotion(): boolean;
  readStats(): CameraEffectStats;
  resetStats(): void;
  destroy(): void;
}

interface ActiveEffect {
  readonly kind: CameraEffectKind;
  readonly tween: Tween<CameraOffsetValue>;
  readonly contribute: (target: Vector3) => void;

  /**
   * This effect's share of the composed zoom widening, omitted by an effect
   * that displaces the camera alone.
   */
  readonly contributeZoom?: () => number;
}

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
 * construction, and `setRestTransform` replaces that capture when a caller
 * reframes the camera for a different board size. This module imports neither
 * the scene nor the accessibility settings surface.
 *
 * @returns A frozen controller. Constructed with motion reduced, every
 *   request is refused and the camera is never written.
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

  /**
   * CHANGED: `let`, seeded from the geometry the caller supplied. An explicit
   * `punchZoom` PINS the share, so a caller that stated a magnitude is never
   * overridden by a reframe. DL-CAMERA-05.
   */
  const punchZoomPinned = options.punchZoom !== undefined;
  let punchZoom = resolveOption(
    options.punchZoom,
    options.geometry === undefined
      ? DEFAULT_PUNCH_ZOOM
      : punchZoomFor(options.geometry),
    'punchZoom',
    reporter,
  );

  // Derived from the peak, so re-measuring the peak re-measures the ceiling with
  // it: a mobile field would otherwise keep a desktop ceiling.
  let maxZoomShare = punchZoom * DEFAULT_MAX_ZOOM_FACTOR;

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

  // The timing function style/main.scss names, resolved once.
  const impulseEasing = easingFor(motion.pop.easing);

  const restPosition = camera.position.clone();
  const restQuaternion = camera.quaternion.clone();

  // The projection the punch is drawn through, and `null` for a camera carrying
  // no zoom, which leaves the punch on the view-axis displacement below.
  const projection = readZoomableProjection(camera);

  const forwardAxis = new Vector3();
  const rightAxis = new Vector3();
  const upAxis = new Vector3();

  // Displacement written into the camera by the last step.
  const appliedOffset = new Vector3();

  const composed = new Vector3();

  let restZoom = projection === null ? UNIT_ZOOM : projection.zoom;

  // Zoom share written into the projection by the last step.
  let appliedZoomShare = NO_ZOOM_SHARE;

  let composedZoomShare = NO_ZOOM_SHARE;

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
  let clampedZooms = 0;
  let invalidDeltas = 0;
  let deltaAnnounced = false;

  const refreshAxes = (): void => {
    forwardAxis.copy(LOCAL_FORWARD).applyQuaternion(restQuaternion);
    rightAxis.copy(LOCAL_RIGHT).applyQuaternion(restQuaternion);
    upAxis.copy(LOCAL_UP).applyQuaternion(restQuaternion);
  };

  /**
   * Writes `restZoom` widened by `composedZoomShare` into the projection, and
   * only where the value it resolves to differs from the one standing.
   *
   * The share WIDENS the frustum: `zoom` divides the frustum's extents, so a
   * share below one enlarges the view and holds the drawn board inside the
   * field src/render/scene.ts frames.
   */
  const writeZoom = (): void => {
    if (projection === null) {
      return;
    }

    const next = restZoom / (UNIT_ZOOM + composedZoomShare);

    appliedZoomShare = composedZoomShare;

    if (projection.zoom === next || !Number.isFinite(next)) {
      return;
    }

    projection.zoom = next;
    projection.updateProjectionMatrix();
  };

  const applyRest = (): void => {
    camera.position.copy(restPosition);
    camera.quaternion.copy(restQuaternion);
    composed.set(NO_DISPLACEMENT, NO_DISPLACEMENT, NO_DISPLACEMENT);
    appliedOffset.set(NO_DISPLACEMENT, NO_DISPLACEMENT, NO_DISPLACEMENT);
    composedZoomShare = NO_ZOOM_SHARE;
    writeZoom();
  };

  /** Writes `rest + composed` onto the camera. */
  const writeTransform = (): void => {
    if (
      composed.x === NO_DISPLACEMENT &&
      composed.y === NO_DISPLACEMENT &&
      composed.z === NO_DISPLACEMENT &&
      composedZoomShare === NO_ZOOM_SHARE
    ) {
      applyRest();

      return;
    }

    camera.position.copy(restPosition).add(composed);
    camera.quaternion.copy(restQuaternion);
    appliedOffset.copy(composed);
    writeZoom();
  };

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

  /** Confines the composed zoom share to `maxZoomShare`. */
  const clampComposedZoom = (): void => {
    if (composedZoomShare <= maxZoomShare) {
      return;
    }

    const requested = composedZoomShare;

    composedZoomShare = maxZoomShare;
    clampedZooms += 1;
    reporter.onCount({
      name: ZOOM_CLAMPED_METRIC,
      value: 1,
      detail: Object.freeze({ requested, applied: maxZoomShare }),
    });
  };

  const applyComposed = (): void => {
    composed.set(NO_DISPLACEMENT, NO_DISPLACEMENT, NO_DISPLACEMENT);
    composedZoomShare = NO_ZOOM_SHARE;

    for (const effect of effects) {
      effect.contribute(composed);
      composedZoomShare += effect.contributeZoom?.() ?? NO_ZOOM_SHARE;
    }

    clampComposed();
    clampComposedZoom();
    writeTransform();
  };

  const isRefusing = (): boolean => destroyed || reducedMotion;

  const reportSuppressed = (kind: CameraEffectKind): void => {
    suppressed += 1;
    reporter.onCount({
      name: SUPPRESSED_METRIC,
      value: 1,
      detail: Object.freeze({ effect: kind, reducedMotion, destroyed }),
    });
  };

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

  const dropEffects = (): void => {
    for (const effect of effects) {
      effect.tween.complete();
    }

    effects.length = 0;
  };

  refreshAxes();

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

    // style/main.scss: three keyframes, the middle one carrying the overshoot
    // at the offset it sits on.
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

    // style/main.scss: `pop 200ms ease $transition-speed`.
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

    // The impulse reaches the image through the PROJECTION where the camera
    // carries a zoom, and through the view axis where it does not. Displacing
    // an orthographic camera along its own view axis moves nothing on screen:
    // that projection has no perspective divide, so the offset leaves the
    // projected image identical. The tween is shared by both paths, so the
    // impulse shape, the intensity scale and the reduced-motion gate are the
    // same either way.
    admit({
      kind: 'punch',
      tween,

      contribute: (target: Vector3): void => {
        if (projection !== null) {
          return;
        }

        target.addScaledVector(forwardAxis, tween.value().displacement);
      },

      contributeZoom:
        projection === null
          ? undefined
          : (): number => (tween.value().displacement / punchDistance) *
              punchZoom,
    });

    punches += 1;
    reporter.onCount({
      name: PUNCH_METRIC,
      value: 1,
      detail: Object.freeze({
        intensity: applied,
        peak,
        peakZoomShare: projection === null ? NO_ZOOM_SHARE : punchZoom * applied,
      }),
    });

    return true;
  };

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
        // different frequencies, a quarter turn apart.
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

    // The rest zoom is re-read the way the rest position is: from the live
    // value, less whatever the last step widened it by. src/render/scene.ts
    // rewrites the frustum on a resize and a reframe, so the value standing
    // here is the one the scene now wants.
    if (projection !== null) {
      restZoom = projection.zoom * (UNIT_ZOOM + appliedZoomShare);
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

    useGeometry: (geometry: GeometryScale): number => {
      if (punchZoomPinned) {
        reporter.onCount({
          name: GEOMETRY_PINNED_METRIC,
          value: 1,
          detail: Object.freeze({ punchZoom, requested: null }),
        });

        return punchZoom;
      }

      const next = punchZoomFor(geometry);

      if (next === punchZoom) {
        return punchZoom;
      }

      const previous = punchZoom;

      punchZoom = next;
      maxZoomShare = punchZoom * DEFAULT_MAX_ZOOM_FACTOR;
      reporter.onCount({
        name: GEOMETRY_METRIC,
        value: 1,
        detail: Object.freeze({
          punchZoom: next,
          previous,
          gridRowCells: geometry.gridRowCells,
        }),
      });

      return punchZoom;
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
        clampedZooms,
        invalidDeltas,
        offsetDistance: appliedOffset.length(),
        zoomShare: appliedZoomShare,
        punchZoom,
        punchZoomPinned,
      }),

    resetStats: (): void => {
      punches = 0;
      shakes = 0;
      suppressed = 0;
      clampedIntensities = 0;
      clampedDurations = 0;
      evictedEffects = 0;
      clampedOffsets = 0;
      clampedZooms = 0;
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
