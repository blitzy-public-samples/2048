// Merge particle burst: the spray of motes that accompanies a merging tile,
// and the second of the two effects suppressed when motion is to be reduced.
//
// Schedule, easing and travel shape are read from src/theme/tokens.ts through
// src/render/animations.ts, so a burst runs on the cadence the stylesheet gives
// a merging tile:
//   style/main.scss L434-L446  the `pop` keyframes: 0% scale(0), 50%
//                              scale(1.2), 100% scale(1)
//   style/main.scss L448-L452  `.tile-merged .tile-inner` applying them as
//                              `pop 200ms ease $transition-speed` under
//                              `animation-fill-mode: backwards`, so the delay
//                              holds the 0% keyframe and the burst is clear
//                              across it
//   style/main.scss L22        `$transition-speed: 100ms`, that delay
// Travel is that same curve scaled by `spread` and `lift`: the spray reaches
// the overshoot at the 50% keyframe and settles at 100%, and its alpha peaks at
// the overshoot's own offset.
//
// The tint is the merged tile's ramp fill, read through `resolveTileFill` of
// src/render/tile-materials.ts and blended toward `tileGoldGlowColor` of
// src/theme/tokens.ts, the halo colour the merge glow is drawn in:
//   style/main.scss L377       `$glow-opacity: max($exponent - 4, 0) /
//                              ($limit - 4)`
//   style/main.scss L380       `rgba($tile-gold-glow-color, $glow-opacity /
//                              1.8)`, whose divisor is carried below as
//                              `HALO_ATTENUATION`
// No fill and no halo colour is restated here as a literal or a table.
//
// The merge that triggers a burst is the branch at js/html_actuator.js L73-L80,
// which pushed the `.tile-merged` class and recursed over the merged pair, and
// which js/game_manager.js L156-L170 reached once per merge inside the
// traversal — one move carrying two merges reaches it twice. That file is
// deleted; the merge now arrives as an engine event that
// src/render/three-renderer.ts forwards here, so two bursts can be requested on
// one frame and each runs its own tween.
//
// Invariants of this module: the buffer geometry, its two attribute arrays, the
// emission-direction table, the alpha mask and one tween per burst record are
// all allocated at construction and never again, so a burst writes into
// buffers and allocates neither geometry nor an attribute array; it holds no
// scene, mesh or engine reference and takes its parent as a parameter of
// `attachTo`; it touches no DOM, reads no clock — every step is driven by the
// caller's clamped frame delta — consumes no randomness, and performs no I/O.
// Emission directions are a pure function of a mote's slot, so one burst
// replays identically. Reporting leaves through the injected reporter and
// nothing here imports src/observability/.
//
// The per-frame JavaScript this loop introduces is the architectural delta
// recorded in docs/DECISION_LOG.md, and the rationale for the decisions behind
// this file is there too.

import type { Object3D, Vector3Like } from 'three';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  DynamicDrawUsage,
  LinearFilter,
  Points,
  PointsMaterial,
  RGBAFormat,
  UnsignedByteType,
} from 'three';

import { depthScale, motion, tileGoldGlowColor } from '../theme/tokens';
import type { Tween, TweenInterpolator, TweenStop } from './animations';
import { createTween, easingFor, mix } from './animations';
import {
  compositeOver,
  readThemeColor,
  resolveTileFill,
  toThreeColor,
} from './tile-materials';
import type { RenderDetail, RenderReporter } from './webgl-support';
import {
  NOOP_RENDER_REPORTER,
  createGuardedRenderReporter,
  queryReducedMotion,
  subscribeReducedMotion,
} from './webgl-support';

/* ==========================================================================
 * 1. The frame contract, the colour shape, and the reporting names
 * ========================================================================== */

/**
 * The part of a frame this module reads.
 *
 * `FrameContext` of src/render/render-loop.ts satisfies it: its `delta` is the
 * frame delta after that loop's `maxDelta` clamp, and every step here is driven
 * by that clamped value.
 */
export interface ParticleFrameContext {
  /** Milliseconds since the previous frame, clamped by the caller. */
  readonly delta: number;
}

/**
 * A colour on the channel scale src/render/tile-materials.ts reads and returns.
 *
 * Structurally the `RampColor` of src/theme/tile-ramp.ts, which
 * src/render/tile-materials.ts consumes and does not re-export; declared here
 * so this module names the shape without importing that module.
 */
export interface BurstColor {
  /** Red channel, 0-255, unrounded. */
  readonly r: number;

  /** Green channel, 0-255, unrounded. */
  readonly g: number;

  /** Blue channel, 0-255, unrounded. */
  readonly b: number;

  /** Alpha, 0-1. */
  readonly a: number;
}

/** Source field carried by every diagnostic this module emits. */
const DIAGNOSTIC_SOURCE = 'render/particles';

/** Counter incremented for each burst that starts. */
const BURST_METRIC = 'render.particles.burst';

/** Counter incremented for each burst refused while motion is reduced. */
const SUPPRESSED_METRIC = 'render.particles.burst.suppressed';

/** Counter incremented for each burst retired early to admit a newer one. */
const BUDGET_EXHAUSTED_METRIC = 'render.particles.budget.exhausted';

/** Counter incremented for each tile value the ramp does not resolve. */
const INVALID_VALUE_METRIC = 'render.particles.value.invalid';

/** Counter incremented for each rejected emission origin. */
const INVALID_ORIGIN_METRIC = 'render.particles.origin.invalid';

/** Counter incremented for each rejected frame delta. */
const INVALID_DELTA_METRIC = 'render.particles.delta.invalid';

/** Counter incremented for each rejected construction parameter. */
const INVALID_OPTION_METRIC = 'render.particles.option.invalid';

/** Counter incremented for each preference change that cleared the pool. */
const PREFERENCE_CLEARED_METRIC = 'render.particles.preference.cleared';

/* ==========================================================================
 * 2. Named magnitudes and the construction defaults
 * ========================================================================== */

/** Name the burst tween carries in a report. */
const BURST_TWEEN_NAME = 'merge-burst';

/** Offset of a first keyframe, the `0%` of a `@keyframes` block. */
const FIRST_KEYFRAME_OFFSET = 0;

/** Offset of a last keyframe, the `100%` of a `@keyframes` block. */
const LAST_KEYFRAME_OFFSET = 1;

/** Fully transparent alpha, at which a mote contributes nothing. */
const ALPHA_CLEAR = 0;

/** Fully opaque alpha. */
const ALPHA_OPAQUE = 1;

/**
 * Highest 8-bit channel value, and the scale a mote's falloff is quantised
 * onto. The mask is greyscale and carries no colour: every channel of a texel
 * holds that texel's falloff, and the tint arrives through the colour
 * attribute instead.
 */
const CHANNEL_MAX = 255;

/** Length of a unit emission direction, and the span a share covers. */
const UNIT_LENGTH = 1;

/** Components a position and a direction each occupy: x, y and z. */
const VECTOR_COMPONENTS = 3;

/** Components a colour occupies: r, g, b and a. */
const COLOR_COMPONENTS = 4;

/** Offset of the x component within a vector. */
const X_COMPONENT = 0;

/** Offset of the y component within a vector. */
const Y_COMPONENT = 1;

/** Offset of the z component within a vector. */
const Z_COMPONENT = 2;

/** Offset of the red component within a colour. */
const RED_COMPONENT = 0;

/** Offset of the green component within a colour. */
const GREEN_COMPONENT = 1;

/** Offset of the blue component within a colour. */
const BLUE_COMPONENT = 2;

/** Offset of the alpha component within a colour. */
const ALPHA_COMPONENT = 3;

/** Delta a rejected step is treated as. */
const NO_DELTA = 0;

/** Lowest count an option expressed in whole units accepts. */
const MIN_COUNT = 1;

/**
 * Divisor style/main.scss L380 attenuates the outer halo's alpha by. Its
 * reciprocal is the share the halo colour is blended into a burst tint at.
 */
const HALO_ATTENUATION = 1.8;

/**
 * The golden angle in radians, `pi (3 - sqrt 5)`: the azimuth step that spreads
 * consecutive motes around the emission point without repeating a direction.
 */
const GOLDEN_ANGLE_RADIANS = Math.PI * (3 - Math.sqrt(5));

/** Offset that centres one mote's sample within its elevation band. */
const BAND_CENTRE = 0.5;

/**
 * Construction values with no counterpart in the token layer.
 *
 * style/main.scss declares flat fills, box-shadows and a scale curve, and no
 * particle vocabulary of any kind, so a mote count, a concurrency limit and the
 * mask's two parameters have no token to resolve against and are stated here.
 * The four lengths beside them are token-derived. Every entry is overridable
 * through `ParticleSystemOptions`.
 */
export const particleDefaults = Object.freeze({
  /** Motes one burst emits. */
  particlesPerBurst: 12,

  /**
   * Bursts that may run at once. The mote budget is this multiplied by
   * `particlesPerBurst`.
   */
  maxConcurrentBursts: 6,

  /** Peak travel across the board plane, in px. One tile extrusion depth. */
  spread: depthScale.tile,

  /**
   * Peak travel along the board's face normal, in px. One board extrusion
   * depth.
   */
  lift: depthScale.board,

  /** Diameter of one mote, in px. One board extrusion depth. */
  size: depthScale.board,

  /**
   * Share of the halo colour in a burst tint, the reciprocal of the halo
   * attenuation style/main.scss L380 divides the glow alpha by.
   */
  glowBlend: ALPHA_OPAQUE / HALO_ATTENUATION,

  /** Edge of the square alpha mask, in texels. */
  maskResolution: 32,

  /** Exponent the mask's radial falloff is raised to. */
  maskFalloffExponent: 2,
} as const);

/* ==========================================================================
 * 3. The construction and reading contracts
 * ========================================================================== */

/**
 * Construction parameters. All are optional, and every length defaults to a
 * value derived from `depthScale` of src/theme/tokens.ts.
 *
 * A parameter that is not a finite number in range is replaced by its default
 * and reported; construction never throws for one.
 */
export interface ParticleSystemOptions {
  /**
   * Motes one burst emits. Rounded down to a whole count. Defaults to
   * `particleDefaults.particlesPerBurst`.
   */
  readonly particlesPerBurst?: number;

  /**
   * Bursts that may run at once. Requesting one beyond this retires the oldest
   * early. Rounded down to a whole count. Defaults to
   * `particleDefaults.maxConcurrentBursts`.
   */
  readonly maxConcurrentBursts?: number;

  /**
   * Peak travel across the board plane, in px, at the `pop` overshoot.
   * Defaults to `particleDefaults.spread`.
   */
  readonly spread?: number;

  /**
   * Peak travel along the board's face normal, in px, at the `pop` overshoot.
   * Defaults to `particleDefaults.lift`.
   */
  readonly lift?: number;

  /** Diameter of one mote, in px. Defaults to `particleDefaults.size`. */
  readonly size?: number;

  /**
   * Share of the halo colour in a burst tint, 0 to 1. `0` tints a burst with
   * the merged tile's ramp fill alone and `1` with the halo colour alone.
   * Defaults to `particleDefaults.glowBlend`.
   */
  readonly glowBlend?: number;

  /**
   * Edge of the square alpha mask, in texels. Defaults to
   * `particleDefaults.maskResolution`.
   */
  readonly maskResolution?: number;

  /**
   * Exponent the mask's radial falloff is raised to. A higher exponent
   * concentrates a mote toward its centre. Defaults to
   * `particleDefaults.maskFalloffExponent`.
   */
  readonly maskFalloffExponent?: number;

  /**
   * Whether the emission axes are attenuated by the camera depth, which is the
   * `sizeAttenuation` of the points material. Defaults to `true`.
   */
  readonly sizeAttenuation?: boolean;

  /**
   * Forces the reduced-motion decision and holds it for the lifetime of the
   * instance. Omitted, the effective preference is read live through
   * `queryReducedMotion()` of src/render/webgl-support.ts on every request and
   * followed through `subscribeReducedMotion()`, so the accessibility surface's
   * `setReducedMotionOverride()` and an operating-system setting toggled
   * mid-run both take effect without a reload and without reconstruction.
   */
  readonly reducedMotion?: boolean;

  /**
   * Sink for burst counts, suppressions, budget exhaustion, rejected values and
   * rejected parameters. Defaults to `NOOP_RENDER_REPORTER`.
   */
  readonly reporter?: RenderReporter;
}

/** What one system has done and where it stands. */
export interface ParticleSystemStats {
  /** Whether motion is being reduced, so requests are refused. */
  readonly reducedMotion: boolean;

  /** Motes the pool holds, which is the fixed budget. */
  readonly budget: number;

  /** Motes one burst emits. */
  readonly particlesPerBurst: number;

  /** Bursts running now, one still inside its delay included. */
  readonly activeBursts: number;

  /** Motes belonging to a running burst. */
  readonly activeParticles: number;

  /** Bursts started. */
  readonly bursts: number;

  /** Requests refused while motion is to be reduced, or after `dispose()`. */
  readonly suppressed: number;

  /** Bursts retired early where every record was already running. */
  readonly budgetExhaustions: number;

  /** Requested tile values the ramp did not resolve. */
  readonly invalidValues: number;

  /** Requested emission origins that were rejected. */
  readonly invalidOrigins: number;

  /** Steps whose delta was rejected and treated as zero. */
  readonly invalidDeltas: number;

  /** Construction parameters replaced by their default. */
  readonly invalidOptions: number;

  /** Length of one burst, in ms: the `pop` delay plus its duration. */
  readonly lifetimeMs: number;

  /** Whether `dispose()` has released the pool. */
  readonly disposed: boolean;
}

/**
 * The merge burst over one pooled point cloud.
 *
 * Every member is safe to call at any time, before the first frame and after
 * `dispose()` alike.
 */
export interface ParticleSystem {
  /**
   * Emits one burst at a point in world space, tinted from a tile value.
   *
   * A complete no-op while motion is to be reduced: no mote is emitted, no
   * attribute is written and no frame work is left outstanding.
   *
   * @param worldPosition Point the burst is emitted from, in world space. Read
   *   and not retained; a component that is not a finite number rejects the
   *   request.
   * @param tileValue Face value of the tile the merge yielded, as `tile:merge`
   *   reports it, and the value the tint is resolved from. A value the ramp
   *   does not resolve is counted and tinted with the halo colour alone.
   * @returns Whether a burst was emitted.
   */
  burstAt(worldPosition: Vector3Like, tileValue: number): boolean;

  /**
   * Steps every running burst and writes the mote positions and alphas.
   *
   * Returns without touching an attribute while no burst is running, so a
   * parked frame loop leaves the pool exactly as the last step left it.
   *
   * @param context The frame, read for its clamped delta. A delta that is not a
   *   finite number of at least zero is counted and treated as zero; a delta
   *   beyond one burst's lifetime completes the bursts it is applied to rather
   *   than carrying a mote past its last keyframe.
   */
  advance(context: ParticleFrameContext): void;

  /**
   * Adds the point cloud to a parent, removing it from any earlier one.
   *
   * @param parent Object the cloud is added to, typically the scene
   *   src/render/scene.ts builds.
   */
  attachTo(parent: Object3D): void;

  /**
   * @returns The point cloud, for a caller managing the scene graph itself.
   *   Its geometry, its two attributes and its material are the instances
   *   allocated at construction and are never replaced. The material is
   *   narrowed to the one this module builds, so a caller reads its size and
   *   its mask without narrowing a union of its own.
   */
  getObject(): Points<BufferGeometry, PointsMaterial>;

  /**
   * @returns Whether any burst is running, which is the value
   *   src/render/render-loop.ts reads as outstanding work.
   */
  isActive(): boolean;

  /** @returns Motes belonging to a running burst, read synchronously. */
  activeParticleCount(): number;

  /** @returns Bursts running now, one still inside its delay included. */
  activeBurstCount(): number;

  /** @returns Whether motion is being reduced, so requests are refused. */
  isReducedMotion(): boolean;

  /** Retires every running burst and clears the pool at once. */
  reset(): void;

  /**
   * Retires every running burst, releases the geometry, the material and the
   * alpha mask, removes the cloud from its parent and releases the
   * reduced-motion subscription. Later requests are refused, and calling it
   * more than once is harmless.
   */
  dispose(): void;

  /** @returns What this system has done and where it stands. */
  readStats(): ParticleSystemStats;

  /** Clears every count `readStats()` reports. Present for suites. */
  resetStats(): void;
}


/* ==========================================================================
 * 4. The tint, derived from the ramp and the halo token
 * ========================================================================== */

/**
 * The halo colour, read from `tileGoldGlowColor` of src/theme/tokens.ts once.
 *
 * The colour style/main.scss L380 draws the outer halo of the merge glow in,
 * and the colour a burst tint is blended toward.
 */
const HALO_COLOR: BurstColor = /* @__PURE__ */ readThemeColor(
  tileGoldGlowColor,
);

/**
 * Confines a share to the span it is mixed over.
 *
 * @param share Requested share.
 * @returns The share where it lies in 0 to 1, `0` for a value below it or one
 *   that is not a finite number, and `1` above.
 */
function confineShare(share: number): number {
  if (!Number.isFinite(share)) {
    return ALPHA_CLEAR;
  }

  return Math.min(Math.max(share, ALPHA_CLEAR), UNIT_LENGTH);
}

/**
 * The ramp fill of one tile value.
 *
 * @param tileValue Face value of the merged tile.
 * @returns The fill `resolveTileFill` of src/render/tile-materials.ts resolves
 *   under the theme in force, or `null` for a value the ramp does not cover —
 *   which a merge relic can produce off the powers of two the ramp is defined
 *   over.
 */
function readRampFill(tileValue: number): BurstColor | null {
  try {
    return resolveTileFill(tileValue);
  } catch {
    return null;
  }
}

/**
 * Blends a fill toward the halo colour.
 *
 * @param fill Ramp fill to blend, or `null` to take the halo colour alone.
 * @param share Share of the halo colour in the result, 0 to 1.
 * @returns The blended colour, opaque wherever `fill` is.
 */
function blendTowardHalo(
  fill: BurstColor | null,
  share: number,
): BurstColor {
  if (fill === null) {
    return HALO_COLOR;
  }

  return compositeOver(
    { r: HALO_COLOR.r, g: HALO_COLOR.g, b: HALO_COLOR.b, a: share },
    fill,
  );
}

/**
 * The tint one burst carries: the merged tile's own ramp fill, blended toward
 * the halo colour of the merge glow.
 *
 * Total: a tile value the ramp does not resolve yields the halo colour rather
 * than throwing, so a merge relic producing a value off the ramp still bursts.
 *
 * @param tileValue Face value of the merged tile.
 * @param glowBlend Share of the halo colour in the result, 0 to 1. Values
 *   outside that span are confined. Defaults to
 *   `particleDefaults.glowBlend`.
 * @returns Colour with channels on the 0-255 scale, on the terms
 *   src/render/tile-materials.ts states a fill in.
 *
 * @example
 * ```ts
 * readBurstTint(2048, 0);  // the ramp fill of the 2048 tile, unblended
 * readBurstTint(2048, 1);  // the halo colour alone
 * ```
 */
export function readBurstTint(
  tileValue: number,
  glowBlend: number = particleDefaults.glowBlend,
): BurstColor {
  return blendTowardHalo(readRampFill(tileValue), confineShare(glowBlend));
}

/* ==========================================================================
 * 5. The pool: the direction table and the alpha mask
 * ========================================================================== */

/**
 * Fills the emission-direction table, once, at construction.
 *
 * Each mote takes a direction on the hemisphere standing off the board: its
 * elevation is the centre of its own band of the burst, and its azimuth is its
 * pool index times the golden angle, so consecutive motes of one burst spread
 * around the emission point and two bursts holding different records emit on
 * different azimuths. The direction is a pure function of the index, so one
 * record's burst replays identically.
 *
 * @param directions Table to fill, `VECTOR_COMPONENTS` per mote.
 * @param particlesPerBurst Motes one burst emits, the width of one band set.
 */
function fillDirections(
  directions: Float32Array,
  particlesPerBurst: number,
): void {
  const motes = Math.floor(directions.length / VECTOR_COMPONENTS);

  for (let index = 0; index < motes; index += 1) {
    const withinBurst = index % particlesPerBurst;
    const elevation = (withinBurst + BAND_CENTRE) / particlesPerBurst;
    const planar = Math.sqrt(
      Math.max(0, UNIT_LENGTH - elevation * elevation),
    );
    const azimuth = index * GOLDEN_ANGLE_RADIANS;
    const base = index * VECTOR_COMPONENTS;

    directions[base + X_COMPONENT] = planar * Math.cos(azimuth);
    directions[base + Y_COMPONENT] = planar * Math.sin(azimuth);
    directions[base + Z_COMPONENT] = elevation;
  }
}

/**
 * Builds the greyscale alpha mask one mote is drawn through.
 *
 * A radial falloff, opaque at the centre and clear at the inscribed circle,
 * raised to `falloffExponent`. Generated from arithmetic: no canvas is created,
 * no image is decoded and no binary asset is added.
 *
 * @param resolution Edge of the square mask, in texels.
 * @param falloffExponent Exponent the falloff is raised to.
 * @returns A texture ready to serve as the points material's `alphaMap`.
 */
function createMaskTexture(
  resolution: number,
  falloffExponent: number,
): DataTexture {
  const data = new Uint8Array(resolution * resolution * COLOR_COMPONENTS);
  const centre = (resolution - UNIT_LENGTH) * BAND_CENTRE;

  for (let row = 0; row < resolution; row += 1) {
    for (let column = 0; column < resolution; column += 1) {
      const offsetX = (column - centre) / centre;
      const offsetY = (row - centre) / centre;
      const distance = Math.sqrt(offsetX * offsetX + offsetY * offsetY);
      const falloff =
        distance >= UNIT_LENGTH
          ? ALPHA_CLEAR
          : Math.pow(UNIT_LENGTH - distance, falloffExponent);
      const level = Math.round(falloff * CHANNEL_MAX);
      const base = (row * resolution + column) * COLOR_COMPONENTS;

      data[base + RED_COMPONENT] = level;
      data[base + GREEN_COMPONENT] = level;
      data[base + BLUE_COMPONENT] = level;
      data[base + ALPHA_COMPONENT] = level;
    }
  }

  const texture = new DataTexture(
    data,
    resolution,
    resolution,
    RGBAFormat,
    UnsignedByteType,
  );

  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  return texture;
}


/* ==========================================================================
 * 6. Option resolution
 * ========================================================================== */

/** Sink and counter one construction pass resolves its parameters through. */
interface OptionContext {
  /** Sink a rejection is reported to. */
  readonly reporter: RenderReporter;

  /** Parameters replaced by their default so far. */
  rejections: number;
}

/**
 * Reports one rejected construction parameter.
 *
 * @param context Sink and counter.
 * @param option Parameter name, as `'spread'`.
 * @param received Value supplied.
 * @param fallback Value used in its place.
 */
function reportRejectedOption(
  context: OptionContext,
  option: string,
  received: number,
  fallback: number,
): void {
  const detail: RenderDetail = Object.freeze({
    option,
    received: Number.isFinite(received) ? received : null,
    fallback,
  });

  context.rejections += 1;
  context.reporter.onCount({
    name: INVALID_OPTION_METRIC,
    value: 1,
    detail,
  });
  context.reporter.onDiagnostic({
    level: 'warning',
    source: DIAGNOSTIC_SOURCE,
    message: `The ${option} option was rejected; ${fallback} was used.`,
    detail,
  });
}

/**
 * Resolves one parameter expressed as a magnitude.
 *
 * @param supplied Value supplied, or `undefined` to take the fallback.
 * @param fallback Value used where none was supplied or the supplied one is
 *   unusable.
 * @param option Parameter name, for the report.
 * @param context Sink and counter.
 * @returns The supplied value where it is a finite number of at least zero, and
 *   `fallback` otherwise, in which case the rejection is reported.
 */
function resolveMagnitude(
  supplied: number | undefined,
  fallback: number,
  option: string,
  context: OptionContext,
): number {
  if (supplied === undefined) {
    return fallback;
  }

  if (Number.isFinite(supplied) && supplied >= 0) {
    return supplied;
  }

  reportRejectedOption(context, option, supplied, fallback);

  return fallback;
}

/**
 * Resolves one parameter expressed as a whole count.
 *
 * @param supplied Value supplied, or `undefined` to take the fallback.
 * @param fallback Value used where none was supplied or the supplied one is
 *   unusable.
 * @param option Parameter name, for the report.
 * @param context Sink and counter.
 * @returns The supplied value floored, where flooring leaves it at
 *   `MIN_COUNT` or above, and `fallback` otherwise, in which case the
 *   rejection is reported.
 */
function resolveCount(
  supplied: number | undefined,
  fallback: number,
  option: string,
  context: OptionContext,
): number {
  if (supplied === undefined) {
    return fallback;
  }

  const floored = Number.isFinite(supplied) ? Math.floor(supplied) : supplied;

  if (Number.isFinite(floored) && floored >= MIN_COUNT) {
    return floored;
  }

  reportRejectedOption(context, option, supplied, fallback);

  return fallback;
}

/**
 * Resolves one parameter expressed as a share of a span.
 *
 * @param supplied Value supplied, or `undefined` to take the fallback.
 * @param fallback Value used where none was supplied or the supplied one is
 *   unusable.
 * @param option Parameter name, for the report.
 * @param context Sink and counter.
 * @returns The supplied value where it is a finite number from zero to one, and
 *   `fallback` otherwise, in which case the rejection is reported.
 */
function resolveShare(
  supplied: number | undefined,
  fallback: number,
  option: string,
  context: OptionContext,
): number {
  if (supplied === undefined) {
    return fallback;
  }

  if (
    Number.isFinite(supplied) &&
    supplied >= ALPHA_CLEAR &&
    supplied <= UNIT_LENGTH
  ) {
    return supplied;
  }

  reportRejectedOption(context, option, supplied, fallback);

  return fallback;
}

/**
 * Whether an emission point carries three finite components.
 *
 * @param point Point supplied to `burstAt`, which a caller may hand over
 *   absent or partly computed.
 * @returns Whether every component can be read as a finite number.
 */
function isUsablePoint(point: Vector3Like | null | undefined): boolean {
  return (
    point !== null &&
    point !== undefined &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    Number.isFinite(point.z)
  );
}

/* ==========================================================================
 * 7. The burst frame and the pooled records
 * ========================================================================== */

/**
 * The two numbers one burst's tween carries: the `pop` scale curve of
 * style/main.scss L434-L446, and the alpha peaking at its overshoot.
 */
interface BurstFrame {
  /** The `pop` scale at this step, unitless; travel is scaled by it. */
  readonly scale: number;

  /** Alpha at this step, 0 to 1. */
  readonly alpha: number;
}

/** Interpolates a burst frame. */
const interpolateBurstFrame: TweenInterpolator<BurstFrame> = (
  from,
  to,
  ratio,
): BurstFrame => ({
  scale: mix(from.scale, to.scale, ratio),
  alpha: mix(from.alpha, to.alpha, ratio),
});

/**
 * One pooled burst record: the block of mote slots it owns, the tween those
 * motes travel along, and the point they were emitted from.
 *
 * Records are allocated at construction, one per concurrent burst, and reused:
 * claiming one resets its tween rather than building another.
 */
interface BurstRecord {
  /** Index of the record, and of its slot block within the pool. */
  readonly index: number;

  /** First mote slot of the block this record owns. */
  readonly firstSlot: number;

  /** One past the last mote slot of that block. */
  readonly lastSlot: number;

  /** Tween carrying this burst's travel and alpha. */
  readonly tween: Tween<BurstFrame>;

  /** Whether the record is running a burst. */
  active: boolean;

  /** Order the record was claimed in; the lowest is the oldest. */
  sequence: number;

  /** Emission point, x, in world space. */
  originX: number;

  /** Emission point, y, in world space. */
  originY: number;

  /** Emission point, z, in world space. */
  originZ: number;
}


/* ==========================================================================
 * 8. Construction
 * ========================================================================== */

/** Name the point cloud carries in the scene graph. */
const POINTS_OBJECT_NAME = 'merge-burst-particles';

/** Attribute name the position buffer is bound under. */
const POSITION_ATTRIBUTE = 'position';

/** Attribute name the colour buffer is bound under. */
const COLOR_ATTRIBUTE = 'color';

/**
 * Creates the pooled merge burst.
 *
 * The pool is sized once, at `particlesPerBurst * maxConcurrentBursts` motes,
 * and every buffer it needs is allocated here: a burst writes into those
 * buffers and allocates no geometry and no attribute array. Emitted with motion
 * reduced, a request emits nothing and no attribute is written.
 *
 * @param options Counts, lengths, the mask parameters, the reduced-motion
 *   decision and the reporter.
 * @returns A frozen controller over one point cloud.
 *
 * @example
 * ```ts
 * const particles = createParticleSystem();
 *
 * particles.attachTo(scene);
 *
 * events.on('tile:merge', (merge) => {
 *   particles.burstAt(cellToWorld(merge.target), merge.resultValue);
 * });
 *
 * loop.addFrameCallback((frame) => {
 *   particles.advance(frame);
 *   return particles.isActive();
 * });
 * ```
 */
export function createParticleSystem(
  options: ParticleSystemOptions = {},
): ParticleSystem {
  const reporter = createGuardedRenderReporter(
    options.reporter ?? NOOP_RENDER_REPORTER,
  );
  const optionContext: OptionContext = { reporter, rejections: 0 };

  const particlesPerBurst = resolveCount(
    options.particlesPerBurst,
    particleDefaults.particlesPerBurst,
    'particlesPerBurst',
    optionContext,
  );

  const maxConcurrentBursts = resolveCount(
    options.maxConcurrentBursts,
    particleDefaults.maxConcurrentBursts,
    'maxConcurrentBursts',
    optionContext,
  );

  const spread = resolveMagnitude(
    options.spread,
    particleDefaults.spread,
    'spread',
    optionContext,
  );

  const lift = resolveMagnitude(
    options.lift,
    particleDefaults.lift,
    'lift',
    optionContext,
  );

  const size = resolveMagnitude(
    options.size,
    particleDefaults.size,
    'size',
    optionContext,
  );

  const glowBlend = resolveShare(
    options.glowBlend,
    particleDefaults.glowBlend,
    'glowBlend',
    optionContext,
  );

  const maskResolution = resolveCount(
    options.maskResolution,
    particleDefaults.maskResolution,
    'maskResolution',
    optionContext,
  );

  const maskFalloffExponent = resolveMagnitude(
    options.maskFalloffExponent,
    particleDefaults.maskFalloffExponent,
    'maskFalloffExponent',
    optionContext,
  );

  const budget = particlesPerBurst * maxConcurrentBursts;

  // Allocated once, here, and written into for the lifetime of the system.
  const positions = new Float32Array(budget * VECTOR_COMPONENTS);
  const colors = new Float32Array(budget * COLOR_COMPONENTS);
  const directions = new Float32Array(budget * VECTOR_COMPONENTS);

  fillDirections(directions, particlesPerBurst);

  const positionAttribute = new BufferAttribute(positions, VECTOR_COMPONENTS);
  const colorAttribute = new BufferAttribute(colors, COLOR_COMPONENTS);

  positionAttribute.setUsage(DynamicDrawUsage);
  colorAttribute.setUsage(DynamicDrawUsage);

  const geometry = new BufferGeometry();

  geometry.setAttribute(POSITION_ATTRIBUTE, positionAttribute);
  geometry.setAttribute(COLOR_ATTRIBUTE, colorAttribute);

  const mask = createMaskTexture(maskResolution, maskFalloffExponent);

  // The colour attribute carries four components, which is the width three.js
  // reads a per-vertex alpha from; the mask supplies the mote's falloff and the
  // attribute supplies its tint and its alpha. Additive blending is the
  // compositing style/main.scss L380 draws the halo of the merge glow with, and
  // with depth writing off every mote composites whatever the draw order.
  const material = new PointsMaterial({
    size,
    sizeAttenuation: options.sizeAttenuation ?? true,
    alphaMap: mask,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });

  const points = new Points(geometry, material);

  points.name = POINTS_OBJECT_NAME;

  // The bounding volume is not recomputed as motes travel, so culling is left
  // off rather than tested against stale bounds.
  points.frustumCulled = false;
  points.visible = false;

  // style/main.scss L434-L446: three keyframes, the middle one carrying the
  // overshoot at the offset it sits on. Travel is the scale curve itself, and
  // alpha rises to the overshoot and returns to clear at the last keyframe.
  const burstStops: readonly TweenStop<BurstFrame>[] = Object.freeze([
    {
      offset: FIRST_KEYFRAME_OFFSET,
      value: {
        scale: motion.pop.keyframes.from.scale,
        alpha: ALPHA_CLEAR,
      },
    },
    {
      offset: motion.pop.keyframes.mid.offset,
      value: {
        scale: motion.pop.keyframes.mid.scale,
        alpha: ALPHA_OPAQUE,
      },
    },
    {
      offset: LAST_KEYFRAME_OFFSET,
      value: {
        scale: motion.pop.keyframes.to.scale,
        alpha: ALPHA_CLEAR,
      },
    },
  ]);

  // The timing function style/main.scss L450 names, resolved once.
  const burstEasing = easingFor(motion.pop.easing);

  // One burst's whole cadence: the delay of style/main.scss L450 plus its
  // duration.
  const lifetimeMs = motion.pop.delay + motion.pop.duration;

  // Reused by every tint transfer rather than allocated per burst.
  const scratchColor = new Color();

  const records: BurstRecord[] = [];

  for (let index = 0; index < maxConcurrentBursts; index += 1) {
    const firstSlot = index * particlesPerBurst;

    records.push({
      index,
      firstSlot,
      lastSlot: firstSlot + particlesPerBurst,

      // style/main.scss L450: `pop 200ms ease $transition-speed`. Built once
      // and reset on reuse. `reducedMotion` is stated rather than read here, so
      // the tween is never built complete; `readReducedMotion()` below is what
      // suppression is decided by.
      tween: createTween<BurstFrame>(
        {
          name: BURST_TWEEN_NAME,
          duration: motion.pop.duration,
          delay: motion.pop.delay,
          easing: burstEasing,
          stops: burstStops,
          interpolate: interpolateBurstFrame,
        },
        { reducedMotion: false, reporter },
      ),
      active: false,
      sequence: 0,
      originX: 0,
      originY: 0,
      originZ: 0,
    });
  }

  const forcedReducedMotion = options.reducedMotion;

  let activeBursts = 0;
  let nextSequence = 1;
  let disposed = false;

  let bursts = 0;
  let suppressed = 0;
  let budgetExhaustions = 0;
  let invalidValues = 0;
  let invalidOrigins = 0;
  let invalidDeltas = 0;
  let invalidOptions = optionContext.rejections;
  let deltaAnnounced = false;

  /**
   * Reads the preference in force: the forced decision where one was supplied,
   * and otherwise the live answer of `queryReducedMotion()`, which follows both
   * the operating-system setting and the override the accessibility surface
   * sets.
   *
   * @returns Whether motion is to be reduced.
   */
  const readReducedMotion = (): boolean =>
    forcedReducedMotion ?? queryReducedMotion();

  /**
   * Clears one record's motes, leaving each of them contributing nothing.
   *
   * @param record Record whose block is cleared.
   */
  const clearSlots = (record: BurstRecord): void => {
    for (let slot = record.firstSlot; slot < record.lastSlot; slot += 1) {
      colors[slot * COLOR_COMPONENTS + ALPHA_COMPONENT] = ALPHA_CLEAR;
    }
  };

  /**
   * Retires one record, clearing its motes.
   *
   * @param record Record to retire. A record that is not running is left alone.
   */
  const retire = (record: BurstRecord): void => {
    if (!record.active) {
      return;
    }

    record.active = false;
    activeBursts -= 1;

    clearSlots(record);
    colorAttribute.needsUpdate = true;

    if (activeBursts === 0) {
      points.visible = false;
    }
  };

  /** Retires every running record. */
  const clearAll = (): void => {
    for (const record of records) {
      retire(record);
    }
  };


  /**
   * Follows a preference change: motion becoming reduced retires every running
   * burst on the spot, so a burst mid-flight when the setting is toggled stops
   * rather than finishing.
   *
   * @param reduced The effective preference.
   */
  const handlePreferenceChange = (reduced: boolean): void => {
    if (!reduced) {
      return;
    }

    const dropped = activeBursts;

    clearAll();

    reporter.onCount({
      name: PREFERENCE_CLEARED_METRIC,
      value: 1,
      detail: Object.freeze({ dropped }),
    });
  };

  const releasePreference =
    forcedReducedMotion === undefined
      ? subscribeReducedMotion(handlePreferenceChange, reporter)
      : undefined;

  /**
   * Counts and reports one refused request.
   *
   * @param tileValue Value the refused request carried.
   */
  const reportSuppressed = (tileValue: number): void => {
    suppressed += 1;
    reporter.onCount({
      name: SUPPRESSED_METRIC,
      value: 1,
      detail: Object.freeze({
        tileValue: Number.isFinite(tileValue) ? tileValue : null,
        reducedMotion: readReducedMotion(),
        disposed,
      }),
    });
  };

  /**
   * Takes one record, retiring the oldest early where every record is running.
   *
   * @returns The record to run the next burst on.
   */
  const claim = (): BurstRecord => {
    for (const record of records) {
      if (!record.active) {
        return record;
      }
    }

    let oldest = records[0];

    for (const record of records) {
      if (record.sequence < oldest.sequence) {
        oldest = record;
      }
    }

    budgetExhaustions += 1;
    reporter.onCount({
      name: BUDGET_EXHAUSTED_METRIC,
      value: 1,
      detail: Object.freeze({
        budget,
        concurrent: maxConcurrentBursts,
        retired: oldest.index,
      }),
    });

    retire(oldest);

    return oldest;
  };

  /**
   * Writes the tint of one record's motes, and clears their alpha.
   *
   * The tint holds for the burst's lifetime, so it is written on emission and
   * not per frame; `scratchColor` carries it in the working colour space, which
   * is the space a per-vertex colour is read in.
   *
   * @param record Record whose block is tinted.
   */
  const writeTint = (record: BurstRecord): void => {
    for (let slot = record.firstSlot; slot < record.lastSlot; slot += 1) {
      const base = slot * COLOR_COMPONENTS;

      colors[base + RED_COMPONENT] = scratchColor.r;
      colors[base + GREEN_COMPONENT] = scratchColor.g;
      colors[base + BLUE_COMPONENT] = scratchColor.b;
      colors[base + ALPHA_COMPONENT] = ALPHA_CLEAR;
    }
  };

  /**
   * Writes one record's motes at the step its tween stands at.
   *
   * A mote sits at its emission point plus its direction scaled by the travel
   * the frame carries: `spread` across the board plane and `lift` along the
   * board's face normal.
   *
   * @param record Record to write.
   * @param frame The step its tween reached.
   */
  const writeBurst = (record: BurstRecord, frame: BurstFrame): void => {
    const planarTravel = spread * frame.scale;
    const normalTravel = lift * frame.scale;

    for (let slot = record.firstSlot; slot < record.lastSlot; slot += 1) {
      const vectorBase = slot * VECTOR_COMPONENTS;

      positions[vectorBase + X_COMPONENT] =
        record.originX + directions[vectorBase + X_COMPONENT] * planarTravel;
      positions[vectorBase + Y_COMPONENT] =
        record.originY + directions[vectorBase + Y_COMPONENT] * planarTravel;
      positions[vectorBase + Z_COMPONENT] =
        record.originZ + directions[vectorBase + Z_COMPONENT] * normalTravel;

      colors[slot * COLOR_COMPONENTS + ALPHA_COMPONENT] = frame.alpha;
    }
  };

  /**
   * Resolves the tint of one burst into `scratchColor`, counting a tile value
   * the ramp does not cover.
   *
   * @param tileValue Face value of the merged tile.
   */
  const resolveTint = (tileValue: number): void => {
    const fill = readRampFill(tileValue);

    if (fill === null) {
      invalidValues += 1;
      reporter.onCount({
        name: INVALID_VALUE_METRIC,
        value: 1,
        detail: Object.freeze({
          tileValue: Number.isFinite(tileValue) ? tileValue : null,
        }),
      });
    }

    toThreeColor(blendTowardHalo(fill, glowBlend), scratchColor);
  };

  /**
   * Counts and reports one rejected emission point.
   *
   * @param tileValue Value the rejected request carried.
   */
  const reportInvalidOrigin = (tileValue: number): void => {
    invalidOrigins += 1;

    const detail: RenderDetail = Object.freeze({
      tileValue: Number.isFinite(tileValue) ? tileValue : null,
    });

    reporter.onCount({ name: INVALID_ORIGIN_METRIC, value: 1, detail });
    reporter.onDiagnostic({
      level: 'warning',
      source: DIAGNOSTIC_SOURCE,
      message: 'A burst was refused: its emission point was unreadable.',
      detail,
    });
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
        message: 'A particle step was rejected; zero was used.',
        detail,
      });
    }

    return NO_DELTA;
  };

  /**
   * Emits one burst.
   *
   * @param worldPosition Point the burst is emitted from.
   * @param tileValue Face value of the merged tile.
   * @returns Whether a burst was emitted.
   */
  const burstAt = (
    worldPosition: Vector3Like,
    tileValue: number,
  ): boolean => {
    if (disposed || readReducedMotion()) {
      reportSuppressed(tileValue);

      return false;
    }

    if (!isUsablePoint(worldPosition)) {
      reportInvalidOrigin(tileValue);

      return false;
    }

    resolveTint(tileValue);

    const record = claim();

    record.originX = worldPosition.x;
    record.originY = worldPosition.y;
    record.originZ = worldPosition.z;
    record.sequence = nextSequence;
    record.active = true;

    nextSequence += 1;
    activeBursts += 1;

    record.tween.reset();
    writeTint(record);

    // The first keyframe: every mote sits at the emission point, clear, and
    // stays there for the whole of the delay style/main.scss L450 holds it
    // across.
    writeBurst(record, record.tween.value());

    positionAttribute.needsUpdate = true;
    colorAttribute.needsUpdate = true;
    points.visible = true;

    bursts += 1;
    reporter.onCount({
      name: BURST_METRIC,
      value: 1,
      detail: Object.freeze({
        tileValue,
        record: record.index,
        particles: particlesPerBurst,
        activeBursts,
      }),
    });

    return true;
  };

  /**
   * Steps every running burst and writes its motes.
   *
   * @param context The frame, read for its clamped delta.
   */
  const advance = (context: ParticleFrameContext): void => {
    if (activeBursts === 0) {
      return;
    }

    const deltaMs = resolveDelta(context?.delta);

    for (const record of records) {
      if (!record.active) {
        continue;
      }

      // A delta beyond the remaining lifetime is absorbed by the tween, which
      // steps no further than its own end, so the record retires on this frame
      // rather than carrying a mote past its last keyframe.
      writeBurst(record, record.tween.advance(deltaMs));

      if (record.tween.isComplete()) {
        retire(record);
      }
    }

    positionAttribute.needsUpdate = true;
    colorAttribute.needsUpdate = true;
  };

  return Object.freeze({
    burstAt,

    advance,

    attachTo: (parent: Object3D): void => {
      parent.add(points);
    },

    getObject: (): Points<BufferGeometry, PointsMaterial> => points,

    isActive: (): boolean => activeBursts > 0,

    activeParticleCount: (): number => activeBursts * particlesPerBurst,

    activeBurstCount: (): number => activeBursts,

    isReducedMotion: readReducedMotion,

    reset: clearAll,

    dispose: (): void => {
      if (disposed) {
        return;
      }

      disposed = true;

      clearAll();
      points.removeFromParent();

      // three.js releases none of these for a caller, and disposing the
      // material does not reach the texture it holds.
      geometry.dispose();
      material.dispose();
      mask.dispose();

      if (releasePreference !== undefined) {
        releasePreference();
      }
    },

    readStats: (): ParticleSystemStats =>
      Object.freeze({
        reducedMotion: readReducedMotion(),
        budget,
        particlesPerBurst,
        activeBursts,
        activeParticles: activeBursts * particlesPerBurst,
        bursts,
        suppressed,
        budgetExhaustions,
        invalidValues,
        invalidOrigins,
        invalidDeltas,
        invalidOptions,
        lifetimeMs,
        disposed,
      }),

    resetStats: (): void => {
      bursts = 0;
      suppressed = 0;
      budgetExhaustions = 0;
      invalidValues = 0;
      invalidOrigins = 0;
      invalidDeltas = 0;
      invalidOptions = 0;
      deltaAnnounced = false;
    },
  });
}

