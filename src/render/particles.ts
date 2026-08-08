// Merge particle burst: the spray of motes that accompanies a merging tile,
// and the second of the two effects suppressed when motion is to be reduced.
//
// Schedule, easing and travel shape are read from src/theme/tokens.ts through
// src/render/animations.ts, so a burst runs on the cadence the stylesheet gives
// a merging tile: the `pop` keyframes (0% scale(0), 50% scale(1.2), 100%
// scale(1)) applied as `pop 200ms ease $transition-speed` under
// `animation-fill-mode: backwards`, so the 100ms delay holds the 0% keyframe
// and the burst is clear across it.
//
// Travel is that same curve scaled by `spread` and `lift`: the spray reaches
// the overshoot at the 50% keyframe and settles at 100%, and its alpha peaks at
// the overshoot's own offset.
//
// The tint is the merged tile's ramp fill, read through `resolveTileFill` of
// src/render/tile-materials.ts and blended toward `tileGoldGlowColor` of
// src/theme/tokens.ts, the halo colour the merge glow is drawn in. The halo's
// own divisor is carried below as `HALO_ATTENUATION`. No fill and no halo
// colour is restated here as a literal or a table.
//
// A merge arrives as an engine event, once per merge, so a move carrying two
// merges requests two bursts on one frame and each runs its own tween.
//
// The buffer geometry, its two attribute arrays, the emission-direction table,
// the alpha mask and one tween per burst record are all allocated at
// construction and never again, so a burst writes into buffers and allocates
// neither geometry nor an attribute array; this module holds no scene, mesh or
// engine reference and takes its parent as a parameter of `attachTo`; it
// touches no DOM, reads no clock — every step is driven by the caller's clamped
// frame delta — consumes no randomness, and performs no I/O. Emission
// directions are a pure function of a mote's slot, so one burst replays
// identically. Reporting leaves through the injected reporter and nothing here
// imports src/observability/.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
// this module's area enumerated, all target-only because the deleted actuator
// drew no particle:
//   TR-PARTICLE-01  the fixed-capacity mote pool and its buffer geometry
//   TR-PARTICLE-02  `createParticleSystem()` and one burst per merge
//   TR-PARTICLE-03  `readBurstTint()`, the tint taken from the ramp fill
//   TR-PARTICLE-04  the reduced-motion gate that suppresses a burst
//
// Decisions behind this file, argued in docs/DECISION_LOG.md and named here
// only so the construct can be found from the log:
//   DL-PARTICLE-01  the fixed-capacity mote pool allocated once
//   DL-PARTICLE-02  additive blending with depth writing off and frustum
//                   culling off
//   DL-PARTICLE-03  emission directions as a pure function of a mote's slot
//   DL-PARTICLE-04  an option above a ceiling confined and reported, never
//                   refused
//   DL-PARTICLE-05  the four values with no token counterpart stated in
//                   `particleDefaults` and overridable per construction

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

import type { Theme, ThemeId } from '../theme/themes';
import { getActiveTheme, getTheme } from '../theme/themes';
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

/**
 * The part of a frame this module reads.
 *
 * `FrameContext` of src/render/render-loop.ts satisfies it: its `delta` is the
 * frame delta after that loop's `maxDelta` clamp, and every step here is
 * driven by that clamped value.
 */
export interface ParticleFrameContext {
  readonly delta: number;
}

/**
 * A colour on the channel scale src/render/tile-materials.ts reads and
 * returns.
 *
 * Structurally the `RampColor` of src/theme/tile-ramp.ts, which
 * src/render/tile-materials.ts consumes and does not re-export; declared here
 * so this module names the shape without importing that module.
 */
export interface BurstColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const DIAGNOSTIC_SOURCE = 'render/particles';

const BURST_METRIC = 'render.particles.burst';

const SUPPRESSED_METRIC = 'render.particles.burst.suppressed';

const BUDGET_EXHAUSTED_METRIC = 'render.particles.budget.exhausted';

const INVALID_VALUE_METRIC = 'render.particles.value.invalid';

const INVALID_ORIGIN_METRIC = 'render.particles.origin.invalid';

const INVALID_DELTA_METRIC = 'render.particles.delta.invalid';

const INVALID_OPTION_METRIC = 'render.particles.option.invalid';

const PREFERENCE_CLEARED_METRIC = 'render.particles.preference.cleared';

const BURST_TWEEN_NAME = 'merge-burst';

const FIRST_KEYFRAME_OFFSET = 0;

const LAST_KEYFRAME_OFFSET = 1;

const ALPHA_CLEAR = 0;

const ALPHA_OPAQUE = 1;

const CHANNEL_MAX = 255;

const UNIT_LENGTH = 1;

const VECTOR_COMPONENTS = 3;

const COLOR_COMPONENTS = 4;

const X_COMPONENT = 0;

const Y_COMPONENT = 1;

const Z_COMPONENT = 2;

const RED_COMPONENT = 0;

const GREEN_COMPONENT = 1;

const BLUE_COMPONENT = 2;

const ALPHA_COMPONENT = 3;

const NO_DELTA = 0;

const MIN_COUNT = 1;

const HALO_ATTENUATION = 1.8;

const GOLDEN_ANGLE_RADIANS = Math.PI * (3 - Math.sqrt(5));

const BAND_CENTRE = 0.5;

/**
 * Construction values with no counterpart in the token layer.
 *
 * style/main.scss declares flat fills, box-shadows and a scale curve and no
 * particle vocabulary of any kind, so the mote count, the concurrency limit and
 * the mask's two parameters are stated here; the four lengths beside them are
 * token-derived. Every entry is overridable through `ParticleSystemOptions`.
 * Decision DL-PARTICLE-05.
 */
export const particleDefaults = Object.freeze({
  particlesPerBurst: 12,
  maxConcurrentBursts: 6,
  spread: depthScale.tile,
  lift: depthScale.board,
  size: depthScale.board,
  glowBlend: ALPHA_OPAQUE / HALO_ATTENUATION,
  maskResolution: 32,
  maskFalloffExponent: 2,
} as const);

/**
 * The ceilings the two count parameters and the mask edge are confined to.
 *
 * Every buffer this module allocates is sized from `particlesPerBurst` times
 * `maxConcurrentBursts`, and the alpha mask from `maskResolution` squared. A
 * request above a ceiling is confined to it and reported, never refused.
 * Decision DL-PARTICLE-04.
 */
export const particleLimits = Object.freeze({
  /** Motes one burst may emit. */
  maxParticlesPerBurst: 256,

  /** Bursts that may run at once. */
  maxConcurrentBursts: 64,

  /**
   * Motes the whole system may hold. Below the product of the two ceilings
   * above, so a request at both is confined by this one as well.
   */
  maxBudget: 4096,

  /**
   * Smallest square alpha mask. Below two the falloff's centre resolves to
   * zero, every offset divides by it, and the mask comes out fully
   * transparent.
   */
  minMaskResolution: 2,

  /** Largest square alpha mask, in texels a side. */
  maxMaskResolution: 512,
} as const);

/**
 * Construction parameters. All are optional, and every length defaults to a
 * value derived from `depthScale` of src/theme/tokens.ts.
 *
 * A parameter that is not a finite number in range is replaced by its default
 * and reported; construction never throws for one.
 */
export interface ParticleSystemOptions {
  readonly particlesPerBurst?: number;
  readonly maxConcurrentBursts?: number;
  readonly spread?: number;
  readonly lift?: number;
  readonly size?: number;
  readonly glowBlend?: number;
  readonly maskResolution?: number;
  readonly maskFalloffExponent?: number;
  readonly sizeAttenuation?: boolean;

  /**
   * Forces the reduced-motion decision and holds it for the lifetime of the
   * instance. Omitted, the effective preference is read live through
   * `queryReducedMotion()` of src/render/webgl-support.ts on every request and
   * followed through `subscribeReducedMotion()`, so an explicit
   * `setReducedMotionOverride()` and an operating-system setting toggled
   * mid-run both take effect without a reload and without reconstruction.
   */
  readonly reducedMotion?: boolean;
  readonly reporter?: RenderReporter;
}

/** What one system has done and where it stands. */
export interface ParticleSystemStats {
  readonly reducedMotion: boolean;
  readonly budget: number;
  readonly particlesPerBurst: number;
  readonly activeBursts: number;
  readonly activeParticles: number;
  readonly bursts: number;

  /** Requests refused while motion is to be reduced, or after `dispose()`. */
  readonly suppressed: number;
  readonly budgetExhaustions: number;

  /** Requested tile values the ramp did not resolve. */
  readonly invalidValues: number;
  readonly invalidOrigins: number;

  /** Steps whose delta was rejected and treated as zero. */
  readonly invalidDeltas: number;
  readonly invalidOptions: number;

  /** Length of one burst, in ms: the `pop` delay plus its duration. */
  readonly lifetimeMs: number;
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
   * @returns `true` when a burst was claimed and its first keyframe written.
   *   `false` after `dispose()`, while motion is to be reduced, and for an
   *   origin that is not a finite point; each refusal is reported and nothing
   *   is written.
   */
  burstAt(worldPosition: Vector3Like, tileValue: number): boolean;

  /**
   * Steps every running burst and writes the mote positions and alphas.
   *
   * Returns without touching an attribute while no burst is running, so a
   * parked frame loop leaves the pool exactly as the last step left it.
   */
  advance(context: ParticleFrameContext): void;

  /**
   * Adds the pooled point cloud to `parent`.
   *
   * The caller owns `parent`; this system owns the point cloud and every
   * resource behind it. Adding it to a second parent moves it, as three.js
   * does for any object.
   *
   * @param parent Object the point cloud becomes a child of.
   */
  attachTo(parent: Object3D): void;

  /**
   * The pooled point cloud, the same instance on every call.
   *
   * Handed out so a caller can position or parent it. Its geometry, material
   * and texture belong to `dispose()`: a caller that disposes them itself
   * leaves this system holding released resources.
   *
   * @returns The point cloud.
   */
  getObject(): Points<BufferGeometry, PointsMaterial>;

  /** @returns Whether at least one burst is running. */
  isActive(): boolean;

  /**
   * @returns Motes the running bursts hold — the burst count multiplied by the
   *   configured motes per burst, not a count of visible motes.
   */
  activeParticleCount(): number;

  /** @returns Bursts currently running, from zero to the concurrency budget. */
  activeBurstCount(): number;

  /** @returns The reduced-motion preference in force, read at the call. */
  isReducedMotion(): boolean;

  /**
   * Retires every running burst and clears the mote buffers.
   *
   * Releases nothing: the pool, its buffers and the point cloud stay
   * allocated, so the system remains usable and the next `burstAt()` runs
   * against the buffers it always had. Leaves the cumulative counters alone.
   */
  reset(): void;

  /**
   * Releases every resource this system allocated and detaches the point cloud.
   *
   * Retires running bursts, removes the point cloud from its parent, disposes
   * the geometry, the material and the alpha-mask texture — none of which
   * three.js releases for a caller — and releases the preference
   * subscription. Idempotent, and afterwards `burstAt()` refuses.
   */
  dispose(): void;

  /**
   * @returns A frozen snapshot of the cumulative counters, the pool's budget
   *   and the preference in force. Safe to hold; it tracks nothing.
   */
  readStats(): ParticleSystemStats;

  /**
   * Zeroes the cumulative counters and re-arms the one-shot invalid-delta
   * warning. Running bursts, the pool and the preference are untouched.
   */
  resetStats(): void;
}


/* ==========================================================================
 * 4. The tint, derived from the ramp and the halo token
 * ========================================================================== */

/**
 * The halo colour of the DEFAULT palette, read from `tileGoldGlowColor` of
 * src/theme/tokens.ts once.
 *
 * The colour style/main.scss draws the outer halo of the merge glow in, the
 * `rgba($tile-gold-glow-color, ...)` term of its tile-value `box-shadow`.
 * It is the fallback `readHaloColor` returns where a palette states a glow
 * entry this module cannot read, and is not itself the colour a burst is
 * tinted with: every additive palette states its own glow, so a burst reads
 * the palette in force rather than this token.
 */
const DEFAULT_HALO_COLOR: BurstColor = /* @__PURE__ */ readThemeColor(
  tileGoldGlowColor,
);

/**
 * The halo colour of one theme, read at the moment it is needed.
 *
 * Read per burst rather than captured once, so a palette switched mid-run
 * reaches the next burst: the two additive palettes state their own
 * `tileGlow`, and a burst tinted from the token alone would keep the default
 * palette's gold under either of them.
 *
 * @param theme Theme to read, or omitted for the theme in force.
 * @returns The palette's glow colour, and `DEFAULT_HALO_COLOR` where the
 *   palette states one this module cannot read.
 */
function readHaloColor(theme?: Theme | ThemeId): BurstColor {
  const resolved =
    theme === undefined
      ? getActiveTheme()
      : typeof theme === 'string'
        ? getTheme(theme)
        : theme;
  const palette = resolved.palette;

  try {
    return readThemeColor(palette.tileGlow);
  } catch {
    return DEFAULT_HALO_COLOR;
  }
}

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
function readRampFill(
  tileValue: number,
  theme?: Theme | ThemeId,
): BurstColor | null {
  try {
    return resolveTileFill(tileValue, theme);
  } catch {
    return null;
  }
}

function blendTowardHalo(
  fill: BurstColor | null,
  share: number,
  halo: BurstColor,
): BurstColor {
  if (fill === null) {
    return halo;
  }

  return compositeOver({ r: halo.r, g: halo.g, b: halo.b, a: share }, fill);
}

/**
 * The tint one burst carries: the merged tile's own ramp fill, blended toward
 * the halo colour of the merge glow.
 *
 * Total: a tile value the ramp does not resolve yields the halo colour rather
 * than throwing, so a merge relic producing a value off the ramp still bursts.
 */
export function readBurstTint(
  tileValue: number,
  glowBlend: number = particleDefaults.glowBlend,
  theme?: Theme | ThemeId,
): BurstColor {
  return blendTowardHalo(
    readRampFill(tileValue, theme),
    confineShare(glowBlend),
    readHaloColor(theme),
  );
}

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

interface OptionContext {
  readonly reporter: RenderReporter;
  rejections: number;
}

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
 * Reports one parameter confined to its ceiling.
 *
 * Counted under the same metric as a rejection, with the ceiling in place of a
 * fallback, so an oversized request is as visible as an unusable one.
 *
 * @param context Sink and counter.
 * @param option Parameter name.
 * @param received Value supplied.
 * @param ceiling Ceiling it was confined to.
 */
function reportConfinedOption(
  context: OptionContext,
  option: string,
  received: number,
  ceiling: number,
): void {
  const detail: RenderDetail = Object.freeze({
    option,
    received: Number.isFinite(received) ? received : null,
    ceiling,
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
    message: `The ${option} option was confined to ${ceiling}.`,
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

function resolveCount(
  supplied: number | undefined,
  fallback: number,
  option: string,
  context: OptionContext,
  ceiling: number,
  floor: number = MIN_COUNT,
): number {
  if (supplied === undefined) {
    return fallback < floor ? floor : Math.min(fallback, ceiling);
  }

  const floored = Number.isFinite(supplied) ? Math.floor(supplied) : supplied;

  if (!Number.isFinite(floored) || floored < floor) {
    reportRejectedOption(context, option, supplied, fallback);

    return Math.min(fallback, ceiling);
  }

  if (floored > ceiling) {
    // Confined to the ceiling and reported, never refused. Decision
    // DL-PARTICLE-04.
    reportConfinedOption(context, option, supplied, ceiling);

    return ceiling;
  }

  return floored;
}

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

function isUsablePoint(point: Vector3Like | null | undefined): boolean {
  return (
    point !== null &&
    point !== undefined &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    Number.isFinite(point.z)
  );
}

interface BurstFrame {
  readonly scale: number;
  readonly alpha: number;
}

const interpolateBurstFrame: TweenInterpolator<BurstFrame> = (
  from,
  to,
  ratio,
): BurstFrame => ({
  scale: mix(from.scale, to.scale, ratio),
  alpha: mix(from.alpha, to.alpha, ratio),
});

interface BurstRecord {
  readonly index: number;
  readonly firstSlot: number;
  readonly lastSlot: number;
  readonly tween: Tween<BurstFrame>;
  active: boolean;

  /** Order the record was claimed in; the lowest is the oldest. */
  sequence: number;
  originX: number;
  originY: number;
  originZ: number;
}

const POINTS_OBJECT_NAME = 'merge-burst-particles';

const POSITION_ATTRIBUTE = 'position';

const COLOR_ATTRIBUTE = 'color';

/**
 * Creates the pooled merge burst.
 *
 * The pool is sized once, at `particlesPerBurst * maxConcurrentBursts` motes,
 * and every buffer it needs is allocated here: a burst writes into those
 * buffers and allocates no geometry and no attribute array. Emitted with
 * motion reduced, a request emits nothing and no attribute is written.
 *
 * @returns A frozen controller over one point cloud.
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
    particleLimits.maxParticlesPerBurst,
  );

  const requestedBursts = resolveCount(
    options.maxConcurrentBursts,
    particleDefaults.maxConcurrentBursts,
    'maxConcurrentBursts',
    optionContext,
    particleLimits.maxConcurrentBursts,
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
    particleLimits.maxMaskResolution,
    particleLimits.minMaskResolution,
  );

  const maskFalloffExponent = resolveMagnitude(
    options.maskFalloffExponent,
    particleDefaults.maskFalloffExponent,
    'maskFalloffExponent',
    optionContext,
  );

  // Overflow-safe: the number of concurrent bursts is derived from the budget
  // ceiling and the per-burst count rather than multiplied and checked
  // afterwards, so no product is formed that the buffers below could not be
  // sized for. Both operands are already confined to their own ceilings, so the
  // division cannot be by zero and the result is at least one.
  const affordableBursts = Math.max(
    MIN_COUNT,
    Math.floor(particleLimits.maxBudget / particlesPerBurst),
  );
  const maxConcurrentBursts = Math.min(requestedBursts, affordableBursts);

  if (maxConcurrentBursts < requestedBursts) {
    reportConfinedOption(
      optionContext,
      'maxConcurrentBursts',
      requestedBursts,
      maxConcurrentBursts,
    );
  }

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

  // The colour attribute carries four components, the width three.js reads a
  // per-vertex alpha from; the mask supplies the mote's falloff and the
  // attribute supplies its tint and its alpha. Additive blending is the
  // compositing style/main.scss draws the halo of the merge glow with, and
  // with depth writing off every mote composites whatever the draw order.
  //
  // Decision DL-PARTICLE-02.
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

  // The bounding volume is not recomputed as motes travel, and culling is
  // off. Decision DL-PARTICLE-02.
  points.frustumCulled = false;
  points.visible = false;

  // style/main.scss: three keyframes, the middle one carrying the
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

  // The timing function style/main.scss names, resolved once.
  const burstEasing = easingFor(motion.pop.easing);

  // One burst's whole cadence: the delay of style/main.scss plus its
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

      // style/main.scss: `pop 200ms ease $transition-speed`. Built once
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
   * and otherwise the live answer of `queryReducedMotion()`, which follows
   * both the operating-system setting and the override the accessibility
   * surface sets.
   */
  const readReducedMotion = (): boolean =>
    forcedReducedMotion ?? queryReducedMotion();

  const clearSlots = (record: BurstRecord): void => {
    for (let slot = record.firstSlot; slot < record.lastSlot; slot += 1) {
      colors[slot * COLOR_COMPONENTS + ALPHA_COMPONENT] = ALPHA_CLEAR;
    }
  };

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

  const clearAll = (): void => {
    for (const record of records) {
      retire(record);
    }
  };

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
   * not per frame; `scratchColor` carries it in the working colour space,
   * which is the space a per-vertex colour is read in.
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
   */
  const resolveTint = (tileValue: number): void => {
    // Both halves are read here, inside the burst, so a palette switched
    // between two bursts reaches the second one.
    const fill = readRampFill(tileValue);
    const halo = readHaloColor();

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

    toThreeColor(blendTowardHalo(fill, glowBlend, halo), scratchColor);
  };

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
    // stays there for the whole of the delay style/main.scss holds it
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
