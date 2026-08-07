// Per-value tile materials, plus the board field and empty-cell plate
// materials, for the WebGL board.
//
// Every colour is computed by src/theme/tile-ramp.ts and read through the
// per-theme resolver of src/theme/themes.ts. No fill, numeral colour or glow
// alpha is restated here as a table or a constant, so the 2D layer that
// style/main.scss compiles and the 2.5D layer this module dresses resolve
// through one generative implementation.
//
// Source construct to implementation, one row per rule:
//
// | Source              | Rule                          | Implemented by |
// |---------------------|-------------------------------|----------------|
// | main.scss L560-L561 | base fill to material colour  | section 6      |
// | main.scss L568-L570 | accent overlay, the flat band | section 6      |
// | main.scss L572-L574 | numeral colour                | section 7      |
// | main.scss L578      | glow strength                 | section 6      |
// | main.scss L580      | shadow suppression            | section 6      |
// | main.scss L581      | outer halo to emissive        | section 6      |
// | main.scss L582      | inset ring to roughness       | section 6      |
// | main.scss L605-L607 | the super tile                | section 6      |
// | main.scss L459-L470 | empty-cell plate              | section 7      |
// | main.scss L358      | board field                   | section 7      |
// | html_actuator.js L58| one material per tile value   | section 8      |
// | html_actuator.js L60| super threshold, strict `>`   | section 6      |
//
// The two shadows of style/main.scss L581-L582 map onto two material terms.
// The outer halo, which L581 draws in `$tile-gold-glow-color` at the glow
// opacity over 1.8, becomes the emissive colour and the emissive intensity:
// the colour is the palette's halo entry and the intensity is the same alpha,
// which src/theme/tile-ramp.ts publishes as `haloAlpha`. The inset ring, which
// L582 draws in white at the glow opacity over 3, becomes a reduction in
// roughness scaled by `insetAlpha`. Decision DL-MATERIAL-01.
//
// L580 reads `@if not $special-background`, so a value that took an accent
// overlay is emitted with no shadow at all. src/theme/tile-ramp.ts publishes
// that condition as `glowSuppressed` and it gates the emissive term here: a
// suppressed value takes a flat material whose emissive is left at the Three.js
// default. A value that is not suppressed takes the halo colour even where its
// alpha is zero, which is the state values 2 and 4 are emitted in.
//
// Fills are transferred from the ramp's unquantised channels, which
// src/theme/tile-ramp.ts publishes as `color`. Quantised, those are the twelve
// fills the pinned compiler emits from style/main.scss for the default palette.
// Its `colorHex` form, which reproduces the fills the deleted `style/main.css`
// shipped and differs from `color` by one unit on the four accented values, is
// reachable through the `fillPrecision` option. Decisions DL-RAMP-02 and
// DL-RAMP-04 own that pair.
//
// The plate of style/main.scss L468 is declared `rgba($tile-color, .35)`. It is
// pre-composited over the board field of L358 and delivered as an opaque
// material; the `emptyCellCompositing` option delivers it as a transparent
// material instead. Decision DL-MATERIAL-02.
//
// Invariants of this module: it holds no scene, mesh, geometry or engine
// reference and takes a tile value rather than a tile; it touches no DOM,
// reads no clock, consumes no randomness and performs no I/O; it imports no
// stylesheet and nothing from src/engine or src/observability. Reporting is
// injected and defaults to the no-op sink. One material is created per distinct
// tile value and shared across every mesh that carries it, and every material
// this module creates is released by `dispose()`.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md, the
// DL-MATERIAL decisions.

import { Color, MeshStandardMaterial, SRGBColorSpace } from 'three';

import type { RampColor, TileTheme } from '../theme/tile-ramp';
import { formatHexColor, parseHexColor } from '../theme/tile-ramp';
import type { Theme, ThemeId, ThemePalette } from '../theme/themes';
import {
  getActiveTheme,
  getTheme,
  resolveTileTheme,
  subscribeToThemeChange,
} from '../theme/themes';
import {
  brightTextColor,
  derivedColors,
  gameContainerBackground,
  textColor,
  tileGoldGlowColor,
} from '../theme/tokens';
import type {
  RenderDetail,
  RenderErrorInfo,
  RenderReporter,
} from './webgl-support';
import {
  NOOP_RENDER_REPORTER,
  createGuardedRenderReporter,
} from './webgl-support';

/* ==========================================================================
 * 1. Module identity and the metrics it reports
 * ========================================================================== */

/** `source` every diagnostic from this module carries. */
const MODULE_SOURCE = 'render.tile-materials';

/** A tile material was constructed. */
const MATERIAL_CREATED_METRIC = 'render.material.created';

/** A tile value was asked for that no material was cached against. */
const CACHE_MISS_METRIC = 'render.material.cache.miss';

/** A board field or empty-cell plate material was constructed. */
const SURFACE_CREATED_METRIC = 'render.material.surface.created';

/** Materials were released. */
const DISPOSED_METRIC = 'render.material.disposed';

/** The cache rebuilt against a new theme. */
const THEME_REBUILD_METRIC = 'render.material.theme.rebuild';

/** A tile value was asked for that the ramp does not resolve. */
const INVALID_VALUE_METRIC = 'render.material.value.invalid';

/** A construction option was replaced by its default. */
const INVALID_OPTION_METRIC = 'render.material.option.invalid';

/** A palette colour was unreadable and its token default was used. */
const COLOR_FALLBACK_METRIC = 'render.material.color.fallback';

/** A theme-change notification was contained. */
const THEME_LISTENER_METRIC = 'render.material.theme.listener.failed';

/* ==========================================================================
 * 2. Colour reading and the colour-space transfer
 * ========================================================================== */

/** Highest 8-bit channel value, the scale `RampColor` states channels on. */
const CHANNEL_MAX = 255;

/** Fully opaque alpha. */
const ALPHA_OPAQUE = 1;

/** Fully transparent alpha. */
const ALPHA_CLEAR = 0;

/** Divisor a channel or an alpha written as a percentage is scaled by. */
const PERCENT_SCALE = 100;

/** Channel count `rgb()` states before its optional alpha. */
const RGB_CHANNEL_COUNT = 3;

/** Argument count `rgba()` states. */
const RGBA_ARGUMENT_COUNT = 4;

/** Separators CSS accepts between the arguments of `rgb()` and `rgba()`. */
const RGB_SEPARATORS = /[\s,/]+/;

/**
 * Decimal places a channel is rounded to after a transfer through Three.js's
 * working colour space and back.
 *
 * That transfer is a pair of inverse transfer functions evaluated in floating
 * point, and returns a channel offset from the one it was given by up to
 * 2e-3 above and 7e-11 below. Rounding at this precision removes that offset,
 * leaving a later `Math.floor` on the result equal to a `Math.floor` on the
 * channel that was given.
 */
const CHANNEL_PRECISION = 6;

/**
 * Confines an alpha into 0-1, replacing a value that is not a finite number
 * with fully opaque.
 *
 * @param alpha Candidate alpha.
 * @returns Finite alpha in 0-1.
 */
function confineAlpha(alpha: number): number {
  if (!Number.isFinite(alpha)) {
    return ALPHA_OPAQUE;
  }
  return Math.min(ALPHA_OPAQUE, Math.max(ALPHA_CLEAR, alpha));
}

/**
 * Reads one channel of an `rgb()` or `rgba()` argument list, accepting both the
 * 0-255 and the percentage form the pinned Sass compiler emits.
 *
 * @param argument One argument, already trimmed of surrounding whitespace.
 * @returns Channel on the 0-255 scale, or `null` where the argument is not a
 *   number.
 */
function readRgbChannel(argument: string): number | null {
  const isPercentage = argument.endsWith('%');
  const magnitude = Number.parseFloat(
    isPercentage ? argument.slice(0, -1) : argument,
  );
  if (!Number.isFinite(magnitude)) {
    return null;
  }
  return isPercentage ? (magnitude / PERCENT_SCALE) * CHANNEL_MAX : magnitude;
}

/**
 * Reads the alpha argument of an `rgba()` list, accepting both the 0-1 and the
 * percentage form.
 *
 * @param argument The alpha argument, already trimmed.
 * @returns Alpha in 0-1, or `null` where the argument is not a number.
 */
function readRgbAlpha(argument: string): number | null {
  const isPercentage = argument.endsWith('%');
  const magnitude = Number.parseFloat(
    isPercentage ? argument.slice(0, -1) : argument,
  );
  if (!Number.isFinite(magnitude)) {
    return null;
  }
  return confineAlpha(isPercentage ? magnitude / PERCENT_SCALE : magnitude);
}

/**
 * Reads an `rgb()` or `rgba()` colour, in either the comma-separated or the
 * space-separated form, with channels stated on the 0-255 scale or as
 * percentages.
 *
 * The five translucent surfaces a palette of src/theme/themes.ts may declare
 * arrive in this form, and `parseHexColor` of src/theme/tile-ramp.ts reads the
 * hex form only.
 *
 * @param value Candidate colour string, already trimmed.
 * @returns Colour with channels on the 0-255 scale, or `null` where `value` is
 *   not an `rgb()` or `rgba()` colour.
 */
function readRgbFunction(value: string): RampColor | null {
  const open = value.indexOf('(');
  if (open < 0 || !value.endsWith(')')) {
    return null;
  }
  const name = value.slice(0, open).trim().toLowerCase();
  if (name !== 'rgb' && name !== 'rgba') {
    return null;
  }
  const args = value
    .slice(open + 1, -1)
    .split(RGB_SEPARATORS)
    .filter((argument) => argument.length > 0);
  if (args.length < RGB_CHANNEL_COUNT || args.length > RGBA_ARGUMENT_COUNT) {
    return null;
  }
  const channels: number[] = [];
  for (let index = 0; index < RGB_CHANNEL_COUNT; index += 1) {
    const channel = readRgbChannel(args[index] as string);
    if (channel === null) {
      return null;
    }
    channels.push(channel);
  }
  let alpha = ALPHA_OPAQUE;
  if (args.length === RGBA_ARGUMENT_COUNT) {
    const read = readRgbAlpha(args[RGB_CHANNEL_COUNT] as string);
    if (read === null) {
      return null;
    }
    alpha = read;
  }
  return Object.freeze({
    r: channels[0] as number,
    g: channels[1] as number,
    b: channels[2] as number,
    a: alpha,
  });
}

/**
 * Reads a colour a theme palette declares, in any of the forms a palette
 * carries: a 3- or 6-digit hex colour, or an `rgb()` or `rgba()` colour.
 *
 * @param value Colour string from a `ThemePalette` field.
 * @returns Colour with channels on the 0-255 scale, or `null` where `value` is
 *   not a form this module reads.
 */
function tryReadThemeColor(value: string): RampColor | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.startsWith('#')) {
    try {
      return parseHexColor(trimmed);
    } catch {
      return null;
    }
  }
  return readRgbFunction(trimmed);
}

/**
 * Reads a colour a theme palette declares.
 *
 * @param value Colour string from a `ThemePalette` field, as a 3- or 6-digit
 *   hex colour or an `rgb()` or `rgba()` colour.
 * @returns Frozen colour with channels on the 0-255 scale and alpha in 0-1.
 * @throws RangeError when `value` is not a form this module reads.
 */
export function readThemeColor(value: string): RampColor {
  const color = tryReadThemeColor(value);
  if (color === null) {
    throw new RangeError(
      'tile-materials: expected a hex, rgb() or rgba() colour, received ' +
        `${String(value)}`,
    );
  }
  return color;
}

/**
 * Composites one colour over another with the source-over operator, the
 * operator a browser paints a translucent background with.
 *
 * @param source Colour in front, whose alpha drives the blend.
 * @param backdrop Colour behind.
 * @returns Frozen colour. Its alpha is the composite of both alphas, so an
 *   opaque backdrop yields an opaque result.
 * @throws RangeError when a channel of either operand is not a finite number.
 */
export function compositeOver(
  source: RampColor,
  backdrop: RampColor,
): RampColor {
  assertReadableColor('source', source);
  assertReadableColor('backdrop', backdrop);
  const sourceAlpha = confineAlpha(source.a);
  const carried = confineAlpha(backdrop.a) * (ALPHA_OPAQUE - sourceAlpha);
  const alpha = sourceAlpha + carried;
  if (alpha <= ALPHA_CLEAR) {
    return Object.freeze({
      r: source.r,
      g: source.g,
      b: source.b,
      a: ALPHA_CLEAR,
    });
  }
  const blend = (front: number, behind: number): number =>
    (front * sourceAlpha + behind * carried) / alpha;
  return Object.freeze({
    r: blend(source.r, backdrop.r),
    g: blend(source.g, backdrop.g),
    b: blend(source.b, backdrop.b),
    a: alpha,
  });
}

/**
 * Rejects a colour carrying a channel that is not a finite number.
 *
 * @param name Name reported in the error message.
 * @param color Colour under test.
 * @throws RangeError when any channel of `color` is not finite.
 */
function assertReadableColor(name: string, color: RampColor): void {
  const finite =
    Number.isFinite(color.r) &&
    Number.isFinite(color.g) &&
    Number.isFinite(color.b);
  if (!finite) {
    throw new RangeError(
      `tile-materials: ${name} must carry finite channels, received ` +
        `${String(color.r)}, ${String(color.g)}, ${String(color.b)}`,
    );
  }
}

/**
 * Transfers a colour into a `THREE.Color`, declaring the source colour space
 * explicitly.
 *
 * Channels arrive on the 0-255 sRGB scale, which is the scale every token and
 * every ramp fill is stated on, and are handed to `setRGB` as sRGB so Three.js
 * converts them into its working colour space rather than adopting them as
 * already-converted values. Alpha is not transferred: a `THREE.Color` carries
 * none, and the two materials that need one carry it as `opacity`.
 *
 * @param color Colour with channels on the 0-255 scale.
 * @param target Colour to write into. A new one is allocated when omitted.
 * @returns `target`, or the newly allocated colour.
 * @throws RangeError when any channel of `color` is not finite.
 */
export function toThreeColor(color: RampColor, target?: Color): Color {
  assertReadableColor('color', color);
  const output = target ?? new Color();
  return output.setRGB(
    color.r / CHANNEL_MAX,
    color.g / CHANNEL_MAX,
    color.b / CHANNEL_MAX,
    SRGBColorSpace,
  );
}

/**
 * Reads a `THREE.Color` back onto the 0-255 sRGB scale, declaring the target
 * colour space explicitly.
 *
 * The inverse of `toThreeColor`, and the form a caller compares a material
 * colour against a ramp fill in.
 *
 * @param color Colour to read.
 * @returns Frozen opaque colour with channels on the 0-255 scale, unrounded.
 */
export function fromThreeColor(color: Color): RampColor {
  const channels = { r: ALPHA_CLEAR, g: ALPHA_CLEAR, b: ALPHA_CLEAR };
  color.getRGB(channels, SRGBColorSpace);
  return Object.freeze({
    r: channels.r * CHANNEL_MAX,
    g: channels.g * CHANNEL_MAX,
    b: channels.b * CHANNEL_MAX,
    a: ALPHA_OPAQUE,
  });
}

/**
 * Formats a `THREE.Color` as a 6-digit hex string on the ramp's terms.
 *
 * Reads the colour back as sRGB, rounds each channel at `CHANNEL_PRECISION` to
 * absorb the transfer residue, then floors it — the quantisation
 * `formatHexColor` of src/theme/tile-ramp.ts applies. Three.js's own
 * `getHexString` rounds to the nearest 8-bit step instead, so the two disagree
 * on a fill whose channels are not integers.
 *
 * @param color Colour to serialise.
 * @returns Lowercase 6-digit hex string with a leading `#`.
 */
export function formatThreeColor(color: Color): string {
  const transferred = fromThreeColor(color);
  return formatHexColor({
    r: roundTransferredChannel(transferred.r),
    g: roundTransferredChannel(transferred.g),
    b: roundTransferredChannel(transferred.b),
    a: transferred.a,
  });
}

/**
 * Rounds a channel that has been transferred through the working colour space
 * and back, at `CHANNEL_PRECISION`.
 *
 * @param channel Channel on the 0-255 scale, carrying transfer residue.
 * @returns The channel with that residue removed.
 */
function roundTransferredChannel(channel: number): number {
  if (!Number.isFinite(channel)) {
    return channel;
  }
  return Number(channel.toFixed(CHANNEL_PRECISION));
}

/* ==========================================================================
 * 3. The surface response, and the two forms a fill is transferred in
 * ========================================================================== */

/**
 * Which of the ramp's two fill forms a material colour is transferred from.
 *
 * `exact` takes `color`, the unquantised channels. Quantised, these are the
 * twelve fills the pinned Dart Sass compiler emits from style/main.scss for the
 * default palette, so the 2D layer that stylesheet compiles and the material
 * built here carry the same fill on every ramp value.
 *
 * `legacy` takes `colorHex`, which reproduces the twelve fills the deleted
 * `style/main.css` shipped. It differs from `exact` by one unit on the four
 * accented values, where the pinned compiler and the historically shipped
 * artifact disagree. Decisions DL-RAMP-02 and DL-RAMP-04 own that pair.
 */
export type TileFillPrecision = 'exact' | 'legacy';

/**
 * How the alpha of the empty-cell plate declared at style/main.scss L468 is
 * delivered.
 *
 * `pre-composited` resolves the plate against the board field of L358 and
 * delivers an opaque material. `transparent` delivers the declared colour on a
 * transparent material at that alpha. Decision DL-MATERIAL-02.
 */
export type EmptyCellCompositing = 'pre-composited' | 'transparent';

/**
 * The surface response every material takes, and the multiplier applied to the
 * emissive term.
 *
 * style/main.scss declares flat fills and box-shadows and no material
 * vocabulary of any kind, so these four have no token to resolve against and
 * are stated here. Each is overridable through `TileMaterialCacheOptions`.
 * Decision DL-MATERIAL-03.
 */
export const tileMaterialDefaults = Object.freeze({
  /** Roughness a tile takes where the inset ring contributes nothing. */
  roughness: 0.62,

  /** Roughness a tile approaches as the inset ring reaches full strength. */
  minRoughness: 0.34,

  /** Metalness every material this module creates takes. */
  metalness: 0,

  /** Multiplier applied to the halo alpha to obtain emissive intensity. */
  emissiveScale: 1,
} as const);

/** Lowest value the four numeric options accept. */
const MIN_OPTION_VALUE = 0;

/** Highest value `roughness`, `minRoughness` and `metalness` accept. */
const MAX_UNIT_OPTION = 1;

/**
 * Key every super tile's material is cached against.
 *
 * js/html_actuator.js L60 pushed one `tile-super` class for every value
 * strictly above the threshold, and style/main.scss L605-L607 gives that class
 * a single rule, so every such value resolves to one appearance and shares one
 * material. No ramp value is zero, so the key cannot collide with one.
 */
const SUPER_MATERIAL_KEY = 0;

/* ==========================================================================
 * 4. Construction options and the reported state
 * ========================================================================== */

/** Construction options for `createTileMaterialCache`. */
export interface TileMaterialCacheOptions {
  /**
   * Theme the materials are built against, as a theme or an id. Defaults to
   * the theme in force, which `getActiveTheme` of src/theme/themes.ts reports.
   */
  readonly theme?: Theme | ThemeId;

  /**
   * Whether a theme change rebuilds the materials. Defaults to `true` where
   * `theme` is omitted and to `false` where it is supplied, so a pinned theme
   * stays pinned. Setting it alongside `theme` adopts each new active theme.
   */
  readonly followActiveTheme?: boolean;

  /** Which fill form a material colour is transferred from. */
  readonly fillPrecision?: TileFillPrecision;

  /** How the empty-cell plate's alpha is delivered. */
  readonly emptyCellCompositing?: EmptyCellCompositing;

  /**
   * Roughness where the inset ring contributes nothing, in 0-1. Defaults to
   * `tileMaterialDefaults.roughness`.
   */
  readonly roughness?: number;

  /**
   * Roughness approached as the inset ring reaches full strength, in 0-1.
   * Defaults to `tileMaterialDefaults.minRoughness`.
   */
  readonly minRoughness?: number;

  /** Metalness of every material, in 0-1. */
  readonly metalness?: number;

  /**
   * Multiplier applied to the halo alpha to obtain emissive intensity. Any
   * finite value of at least zero.
   */
  readonly emissiveScale?: number;

  /**
   * Sink this cache reports through. Defaults to `NOOP_RENDER_REPORTER`, and is
   * wrapped so no channel of it can throw into a caller.
   */
  readonly reporter?: RenderReporter;
}

/** What one cache has done and where it stands. */
export interface TileMaterialStats {
  /** Id of the theme the cached materials were built against. */
  readonly themeId: ThemeId;

  /** Tile materials held right now. */
  readonly cachedTileMaterials: number;

  /** Tile materials constructed over this cache's life. */
  readonly tileMaterialsCreated: number;

  /** Requests served from the cache. */
  readonly cacheHits: number;

  /** Requests that had to construct a material. */
  readonly cacheMisses: number;

  /** Board field and empty-cell plate materials constructed. */
  readonly surfaceMaterialsCreated: number;

  /** Materials released, by `dispose()` and by a theme rebuild. */
  readonly materialsDisposed: number;

  /** Rebuilds triggered by a theme change or by `setTheme`. */
  readonly themeRebuilds: number;

  /** Requests for a value the ramp does not resolve. */
  readonly invalidValues: number;

  /** Palette colours that were unreadable and fell back to a token. */
  readonly colorFallbacks: number;

  /** Construction options replaced by their default. */
  readonly invalidOptions: number;

  /** Whether `destroy()` has released the theme subscription. */
  readonly destroyed: boolean;
}

/**
 * A per-value tile material cache, and the two board surface materials.
 *
 * One material is held per distinct tile value and shared across every mesh
 * that carries it, so a caller asking for the same value twice is handed the
 * same instance rather than a second one.
 */
export interface TileMaterialCache {
  /**
   * The material for one tile value, constructing it on first request and
   * returning the same instance on every later one.
   *
   * Every value strictly above the ramp's last one shares a single material,
   * which is the appearance style/main.scss L605-L607 gives them all.
   *
   * @param value Tile value; a power of two at two or above.
   * @returns The shared material for that value. Never disposed by this call.
   * @throws RangeError when the ramp does not resolve `value`.
   */
  getTileMaterial(value: number): MeshStandardMaterial;

  /**
   * The numeral colour for one tile value, as the CSS colour string the theme
   * states it in.
   *
   * The value style/main.scss L572-L574 emits as a `color` declaration, which
   * src/render/tile-mesh-factory.ts labels a block with and the number-only
   * path writes onto an element.
   *
   * @param value Tile value; a power of two at two or above.
   * @returns The theme's numeral colour for that value.
   * @throws RangeError when the ramp does not resolve `value`.
   */
  getNumeralColor(value: number): string;

  /**
   * The numeral colour for one tile value, transferred into a `THREE.Color`.
   *
   * @param value Tile value; a power of two at two or above.
   * @param target Colour to write into. A new one is allocated when omitted,
   *   so a caller on a hot path supplies one and this method allocates
   *   nothing.
   * @returns `target`, or the newly allocated colour.
   * @throws RangeError when the ramp does not resolve `value`.
   */
  getNumeralThreeColor(value: number, target?: Color): Color;

  /**
   * The material of the surface the cells sit on, which style/main.scss L358
   * fills with the theme's board field.
   *
   * @returns The shared board field material.
   */
  getBoardFieldMaterial(): MeshStandardMaterial;

  /**
   * The material of one empty cell of the lattice, which style/main.scss L468
   * fills with the theme's cell colour.
   *
   * @returns The shared empty-cell plate material.
   */
  getEmptyCellMaterial(): MeshStandardMaterial;

  /** @returns The theme the cached materials were built against. */
  getTheme(): Theme;

  /**
   * Adopts a theme, releasing every cached material so the next request
   * rebuilds against the new palette.
   *
   * A call naming the theme already in force releases nothing.
   *
   * @param theme The theme to adopt, as a theme or an id.
   * @returns The theme now in force for this cache.
   * @throws RangeError when an id is not one of the catalogue's ids.
   */
  setTheme(theme: Theme | ThemeId): Theme;

  /**
   * Releases every cached material and leaves the cache ready to rebuild.
   *
   * The Three.js resources a material holds are not collected for a caller, so
   * this is the call a board teardown makes — including the rebuild a
   * board-mutating relic forces by changing the board's size. The theme
   * subscription is left in place and the cache remains usable: a later request
   * constructs a fresh material.
   */
  dispose(): void;

  /**
   * Releases every cached material and the theme subscription.
   *
   * The cache keeps serving materials against the theme in force, and no longer
   * follows a theme change.
   */
  destroy(): void;

  /** @returns What this cache has done and where it stands. */
  readStats(): TileMaterialStats;

  /** Clears every count `readStats()` reports. Present for suites. */
  resetStats(): void;
}

/* ==========================================================================
 * 5. Option resolution and error description
 * ========================================================================== */

/** `name` carried by a thrown value that has none of its own. */
const THROWN_NAME = 'RenderError';

/** `message` carried by a thrown value that has none of its own. */
const THROWN_MESSAGE = 'a non-Error value was thrown';

/** Characters either field of a described throw is capped at. */
const MAX_THROWN_TEXT_LENGTH = 200;

/**
 * Reads a thrown value down to the two serialisable fields a diagnostic
 * carries, so a contained throw is reported rather than discarded.
 *
 * Total: it accepts any value, including one whose accessors or `toString`
 * throw, returns on every path and throws on none.
 *
 * @param error Thrown value, of any type, `null` and `undefined` included.
 * @returns Name and message fields, each capped in length.
 */
function describeThrown(error: unknown): RenderErrorInfo {
  if (error instanceof Error) {
    return Object.freeze({
      name: capText(error.name) ?? THROWN_NAME,
      message: capText(error.message) ?? THROWN_MESSAGE,
    });
  }
  return Object.freeze({
    name: THROWN_NAME,
    message: capText(error) ?? THROWN_MESSAGE,
  });
}

/**
 * Renders a value as text of at most `MAX_THROWN_TEXT_LENGTH` characters.
 *
 * @param value Value to render.
 * @returns The capped text, or `null` where the value renders to nothing
 *   usable or its own conversion throws.
 */
function capText(value: unknown): string | null {
  let text: string;
  try {
    text = String(value);
  } catch {
    return null;
  }
  if (text.length === 0) {
    return null;
  }
  return text.slice(0, MAX_THROWN_TEXT_LENGTH);
}

/** What an option resolver reports a rejection through. */
interface OptionContext {
  /** Sink the rejection is reported to. */
  readonly reporter: RenderReporter;

  /** Called once per rejection, so the cache can count it. */
  readonly onRejected: () => void;
}

/**
 * Reports one construction option that was replaced by its default.
 *
 * @param context Sink and counter.
 * @param option Option name, as `'roughness'`.
 * @param supplied Value that was rejected.
 * @param fallback Value used in its place.
 */
function reportRejectedOption(
  context: OptionContext,
  option: string,
  supplied: string | number,
  fallback: string | number,
): void {
  context.onRejected();
  const detail: RenderDetail = Object.freeze({
    option,
    supplied,
    fallback,
  });
  context.reporter.onCount({
    name: INVALID_OPTION_METRIC,
    value: 1,
    detail,
  });
  context.reporter.onDiagnostic({
    level: 'warning',
    source: MODULE_SOURCE,
    message:
      `option \`${option}\` was rejected and replaced by ` +
      `\`${String(fallback)}\``,
    detail,
  });
}

/**
 * Resolves a numeric option, confining it to a finite value from
 * `MIN_OPTION_VALUE` to `maximum`.
 *
 * @param supplied Value the caller passed, or `undefined`.
 * @param fallback Value used where `supplied` is absent or rejected.
 * @param option Option name, for the report.
 * @param maximum Highest accepted value.
 * @param context Sink and counter.
 * @returns The accepted value, or `fallback`.
 */
function resolveNumericOption(
  supplied: number | undefined,
  fallback: number,
  option: string,
  maximum: number,
  context: OptionContext,
): number {
  if (supplied === undefined) {
    return fallback;
  }
  const accepted =
    Number.isFinite(supplied) &&
    supplied >= MIN_OPTION_VALUE &&
    supplied <= maximum;
  if (accepted) {
    return supplied;
  }
  reportRejectedOption(context, option, supplied, fallback);
  return fallback;
}

/**
 * Resolves an option whose value is one of a fixed set of names.
 *
 * @param supplied Value the caller passed, or `undefined`.
 * @param allowed Every accepted name.
 * @param fallback Value used where `supplied` is absent or rejected.
 * @param option Option name, for the report.
 * @param context Sink and counter.
 * @returns The accepted name, or `fallback`.
 */
function resolveNamedOption<T extends string>(
  supplied: T | undefined,
  allowed: readonly T[],
  fallback: T,
  option: string,
  context: OptionContext,
): T {
  if (supplied === undefined) {
    return fallback;
  }
  if (allowed.includes(supplied)) {
    return supplied;
  }
  reportRejectedOption(context, option, String(supplied), fallback);
  return fallback;
}

/** Every accepted `fillPrecision`. */
const FILL_PRECISIONS: readonly TileFillPrecision[] = Object.freeze([
  'exact',
  'legacy',
]);

/** Every accepted `emptyCellCompositing`. */
const EMPTY_CELL_COMPOSITINGS: readonly EmptyCellCompositing[] = Object.freeze([
  'pre-composited',
  'transparent',
]);

/**
 * Resolves a theme argument from either form a caller holds it in.
 *
 * @param theme A theme, an id, or `undefined` for the theme in force.
 * @returns The theme.
 * @throws RangeError when an id is not one of the catalogue's ids.
 */
function resolveThemeArgument(theme?: Theme | ThemeId): Theme {
  if (theme === undefined) {
    return getActiveTheme();
  }
  return typeof theme === 'string' ? getTheme(theme) : theme;
}

/* ==========================================================================
 * 6. Tile fill, the surface response, and material construction
 * ========================================================================== */

/** The surface response one cache builds every material with. */
interface SurfaceResponse {
  /** Roughness where the inset ring contributes nothing. */
  readonly roughness: number;

  /** Roughness approached as the inset ring reaches full strength. */
  readonly minRoughness: number;

  /** Metalness of every material. */
  readonly metalness: number;

  /** Multiplier applied to the halo alpha. */
  readonly emissiveScale: number;
}

/** Reads a palette field, falling back to its token default. */
type PaletteReader = (
  declared: string,
  fallback: string,
  field: string,
) => RampColor;

/**
 * The fill of one resolved tile theme, in the requested form.
 *
 * @param tileTheme Resolved tile theme.
 * @param precision Which of the ramp's two fill forms to take.
 * @returns Colour with channels on the 0-255 scale.
 */
function readTileFill(
  tileTheme: TileTheme,
  precision: TileFillPrecision,
): RampColor {
  if (precision === 'legacy') {
    return readThemeColor(tileTheme.colorHex);
  }
  return tileTheme.color;
}

/**
 * The fill of one tile value under one theme.
 *
 * @param value Tile value; a power of two at two or above.
 * @param theme A theme, an id, or omitted for the theme in force.
 * @param precision Which of the ramp's two fill forms to take. Defaults to
 *   `'exact'`.
 * @returns Colour with channels on the 0-255 scale.
 * @throws RangeError when the ramp does not resolve `value`.
 */
export function resolveTileFill(
  value: number,
  theme?: Theme | ThemeId,
  precision: TileFillPrecision = 'exact',
): RampColor {
  return readTileFill(resolveTileTheme(value, theme), precision);
}

/**
 * The numeral colour of one tile value under one theme, as the CSS colour
 * string the theme states it in.
 *
 * @param value Tile value; a power of two at two or above.
 * @param theme A theme, an id, or omitted for the theme in force.
 * @returns The theme's numeral colour for that value.
 * @throws RangeError when the ramp does not resolve `value`.
 */
export function resolveTileNumeralColor(
  value: number,
  theme?: Theme | ThemeId,
): string {
  return resolveTileTheme(value, theme).numeralColor;
}

/**
 * The roughness one tile value's material takes.
 *
 * style/main.scss L580 suppresses the whole shadow declaration for a value that
 * took an accent overlay, so both of its shadows are absent and the inset ring
 * of L582 contributes nothing there — including on the two suppressed values
 * whose glow alpha is not zero.
 *
 * @param tileTheme Resolved tile theme.
 * @param response The cache's surface response.
 * @returns Roughness from `response.minRoughness` to `response.roughness`.
 */
function readTileRoughness(
  tileTheme: TileTheme,
  response: SurfaceResponse,
): number {
  const inset = tileTheme.glowSuppressed
    ? ALPHA_CLEAR
    : confineAlpha(tileTheme.insetAlpha);
  const span = response.roughness - response.minRoughness;
  return response.roughness - span * inset;
}

/**
 * Builds the material for one tile value.
 *
 * The fill of style/main.scss L560-L570 becomes the material colour. The outer
 * halo of L581 becomes the emissive colour and the emissive intensity, taken
 * from the palette's halo entry and the ramp's halo alpha. The inset ring of
 * L582 becomes a roughness reduction; the ring is drawn in white and its colour
 * is not transferred separately. Where L580 suppresses the declaration the
 * material is left flat: its emissive stays at the Three.js default and its
 * intensity is set to zero, so the emissive term contributes nothing under
 * either reading. Decision DL-MATERIAL-01.
 *
 * @param tileTheme Resolved tile theme.
 * @param palette Palette of the theme it was resolved against.
 * @param precision Which of the ramp's two fill forms to take.
 * @param response The cache's surface response.
 * @param readPalette Reader the halo entry is resolved through.
 * @returns A new material. The caller owns it and must dispose it.
 */
function buildTileMaterial(
  tileTheme: TileTheme,
  palette: ThemePalette,
  precision: TileFillPrecision,
  response: SurfaceResponse,
  readPalette: PaletteReader,
): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    color: toThreeColor(readTileFill(tileTheme, precision)),
    roughness: readTileRoughness(tileTheme, response),
    metalness: response.metalness,
  });

  if (tileTheme.glowSuppressed) {
    material.emissiveIntensity = ALPHA_CLEAR;
    return material;
  }

  toThreeColor(
    readPalette(palette.tileGlow, tileGoldGlowColor, 'tileGlow'),
    material.emissive,
  );
  material.emissiveIntensity =
    confineAlpha(tileTheme.haloAlpha) * response.emissiveScale;
  return material;
}

/* ==========================================================================
 * 7. The two board surface materials
 * ========================================================================== */

/**
 * Builds the material of the surface the cells sit on, which style/main.scss
 * L358 fills with the theme's board field.
 *
 * @param palette Palette in force.
 * @param response The cache's surface response.
 * @param readPalette Reader the board field is resolved through.
 * @returns A new material. The caller owns it and must dispose it.
 */
function buildBoardFieldMaterial(
  palette: ThemePalette,
  response: SurfaceResponse,
  readPalette: PaletteReader,
): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: toThreeColor(
      readPalette(palette.boardField, gameContainerBackground, 'boardField'),
    ),
    roughness: response.roughness,
    metalness: response.metalness,
  });
}

/**
 * Builds the material of one empty cell of the lattice, which style/main.scss
 * L468 declares as `rgba($tile-color, .35)`.
 *
 * Under `pre-composited` that alpha is resolved against the board field of L358
 * with the source-over operator and the material is delivered opaque, which is
 * the composite a browser paints for a cell sitting on that field. Under
 * `transparent` the declared colour is delivered on a transparent material at
 * its own alpha. A palette stating an opaque cell colour, which both additive
 * palettes do, resolves to the same material either way. Decision
 * DL-MATERIAL-02.
 *
 * @param palette Palette in force.
 * @param response The cache's surface response.
 * @param compositing How the alpha is delivered.
 * @param readPalette Reader both entries are resolved through.
 * @returns A new material. The caller owns it and must dispose it.
 */
function buildEmptyCellMaterial(
  palette: ThemePalette,
  response: SurfaceResponse,
  compositing: EmptyCellCompositing,
  readPalette: PaletteReader,
): MeshStandardMaterial {
  const cell = readPalette(
    palette.cell,
    derivedColors.gridCellBackground,
    'cell',
  );

  if (compositing === 'transparent') {
    const translucent = cell.a < ALPHA_OPAQUE;
    return new MeshStandardMaterial({
      color: toThreeColor(cell),
      roughness: response.roughness,
      metalness: response.metalness,
      transparent: translucent,
      opacity: cell.a,
      depthWrite: !translucent,
    });
  }

  const field = readPalette(
    palette.boardField,
    gameContainerBackground,
    'boardField',
  );
  return new MeshStandardMaterial({
    color: toThreeColor(compositeOver(cell, field)),
    roughness: response.roughness,
    metalness: response.metalness,
  });
}

/* ==========================================================================
 * 8. The cache
 * ========================================================================== */

/**
 * Builds a per-value tile material cache for the WebGL board.
 *
 * One material is constructed per distinct tile value and shared across every
 * mesh that carries it, and every value above the ramp's last one shares a
 * single material. Nothing is constructed at call time: the theme is resolved
 * and the options are validated, and each material is built on its first
 * request.
 *
 * The cache follows the theme in force unless a theme is pinned through
 * `options.theme`. On a theme change it releases every material it holds, so
 * the next request rebuilds against the new palette and the WebGL board cannot
 * be left on the previous one while the DOM layer moves to the new one.
 *
 * @param options Construction options. Every field is optional, and an option
 *   that is rejected is replaced by its default, counted, and reported.
 * @returns A frozen cache.
 * @throws RangeError when `options.theme` is an id the catalogue does not
 *   carry.
 */
export function createTileMaterialCache(
  options: TileMaterialCacheOptions = {},
): TileMaterialCache {
  const reporter = createGuardedRenderReporter(
    options.reporter ?? NOOP_RENDER_REPORTER,
  );

  let invalidOptions = 0;
  const optionContext: OptionContext = {
    reporter,
    onRejected: (): void => {
      invalidOptions += 1;
    },
  };

  const fillPrecision = resolveNamedOption(
    options.fillPrecision,
    FILL_PRECISIONS,
    'exact',
    'fillPrecision',
    optionContext,
  );

  const emptyCellCompositing = resolveNamedOption(
    options.emptyCellCompositing,
    EMPTY_CELL_COMPOSITINGS,
    'pre-composited',
    'emptyCellCompositing',
    optionContext,
  );

  const roughness = resolveNumericOption(
    options.roughness,
    tileMaterialDefaults.roughness,
    'roughness',
    MAX_UNIT_OPTION,
    optionContext,
  );

  // Confined to `roughness`, so the span the inset ring is scaled across is
  // never negative and a reduction never raises roughness.
  const minRoughness = Math.min(
    resolveNumericOption(
      options.minRoughness,
      Math.min(tileMaterialDefaults.minRoughness, roughness),
      'minRoughness',
      MAX_UNIT_OPTION,
      optionContext,
    ),
    roughness,
  );

  const response: SurfaceResponse = Object.freeze({
    roughness,
    minRoughness,
    metalness: resolveNumericOption(
      options.metalness,
      tileMaterialDefaults.metalness,
      'metalness',
      MAX_UNIT_OPTION,
      optionContext,
    ),
    emissiveScale: resolveNumericOption(
      options.emissiveScale,
      tileMaterialDefaults.emissiveScale,
      'emissiveScale',
      Number.MAX_VALUE,
      optionContext,
    ),
  });

  let theme = resolveThemeArgument(options.theme);
  const followsActiveTheme =
    options.followActiveTheme ?? options.theme === undefined;

  const tileMaterials = new Map<number, MeshStandardMaterial>();
  const numeralColors = new Map<number, Color>();
  let boardFieldMaterial: MeshStandardMaterial | null = null;
  let emptyCellMaterial: MeshStandardMaterial | null = null;

  let tileMaterialsCreated = 0;
  let surfaceMaterialsCreated = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let materialsDisposed = 0;
  let themeRebuilds = 0;
  let invalidValues = 0;
  let colorFallbacks = 0;
  let destroyed = false;

  /**
   * Reads a palette field, falling back to the token the default palette states
   * it from where the declared value is not a colour this module reads.
   *
   * @param declared Value the palette carries.
   * @param fallback Token used in its place.
   * @param field Palette field name, for the report.
   * @returns Colour with channels on the 0-255 scale.
   * @throws RangeError when `fallback` is not a colour this module reads.
   */
  const readPalette: PaletteReader = (declared, fallback, field) => {
    const color = tryReadThemeColor(declared);
    if (color !== null) {
      return color;
    }

    colorFallbacks += 1;
    const detail: RenderDetail = Object.freeze({
      themeId: theme.id,
      field,
      declared: capText(declared) ?? '',
    });
    reporter.onCount({ name: COLOR_FALLBACK_METRIC, value: 1, detail });
    reporter.onDiagnostic({
      level: 'warning',
      source: MODULE_SOURCE,
      message:
        `palette field \`${field}\` is not a colour this module reads; ` +
        'its token default was used',
      detail,
    });
    return readThemeColor(fallback);
  };

  /**
   * Resolves one tile value against the theme in force, counting and reporting
   * a value the ramp rejects.
   *
   * @param value Tile value.
   * @returns The resolved tile theme.
   * @throws RangeError when the ramp does not resolve `value`.
   */
  const resolveValue = (value: number): TileTheme => {
    try {
      return resolveTileTheme(value, theme);
    } catch (error: unknown) {
      invalidValues += 1;
      const detail: RenderDetail = Object.freeze({
        themeId: theme.id,
        value: Number.isFinite(value) ? value : String(value),
      });
      reporter.onCount({ name: INVALID_VALUE_METRIC, value: 1, detail });
      reporter.onDiagnostic({
        level: 'error',
        source: MODULE_SOURCE,
        message: 'the ramp does not resolve the requested tile value',
        detail,
        error: describeThrown(error),
      });
      throw error;
    }
  };

  /**
   * The cache key one resolved tile theme's material is held under.
   *
   * @param tileTheme Resolved tile theme.
   * @returns `SUPER_MATERIAL_KEY` for a value above the ramp, and the value
   *   itself otherwise.
   */
  const materialKey = (tileTheme: TileTheme): number =>
    tileTheme.isSuper ? SUPER_MATERIAL_KEY : tileTheme.value;

  /**
   * Releases every material held and clears the caches.
   *
   * @param reason What triggered the release, for the report.
   * @returns How many materials were released.
   */
  const releaseMaterials = (reason: string): number => {
    let released = 0;

    for (const material of tileMaterials.values()) {
      material.dispose();
      released += 1;
    }
    tileMaterials.clear();
    numeralColors.clear();

    if (boardFieldMaterial !== null) {
      boardFieldMaterial.dispose();
      boardFieldMaterial = null;
      released += 1;
    }

    if (emptyCellMaterial !== null) {
      emptyCellMaterial.dispose();
      emptyCellMaterial = null;
      released += 1;
    }

    materialsDisposed += released;

    if (released > 0) {
      reporter.onCount({
        name: DISPOSED_METRIC,
        value: released,
        detail: Object.freeze({ reason, themeId: theme.id }),
      });
    }

    return released;
  };

  /**
   * Adopts a theme and releases every material built against the previous one.
   *
   * @param next Theme to adopt.
   * @returns The theme now in force for this cache.
   */
  const adoptTheme = (next: Theme): Theme => {
    if (next === theme) {
      return theme;
    }

    const previousId = theme.id;
    theme = next;
    const released = releaseMaterials('theme');
    themeRebuilds += 1;
    reporter.onCount({
      name: THEME_REBUILD_METRIC,
      value: 1,
      detail: Object.freeze({
        themeId: next.id,
        previousThemeId: previousId,
        released,
      }),
    });
    return theme;
  };

  /**
   * Follows a theme change.
   *
   * `applyTheme` of src/theme/themes.ts collects a throwing listener into an
   * `AggregateError`, so this one contains its own failures and reports them
   * rather than letting one reach the activation path.
   *
   * @param next Theme now in force.
   */
  const handleThemeChange = (next: Theme): void => {
    try {
      adoptTheme(next);
    } catch (error: unknown) {
      reporter.onCount({
        name: THEME_LISTENER_METRIC,
        value: 1,
        detail: Object.freeze({ themeId: next.id }),
      });
      reporter.onDiagnostic({
        level: 'error',
        source: MODULE_SOURCE,
        message: 'a theme change could not be adopted',
        detail: Object.freeze({ themeId: next.id }),
        error: describeThrown(error),
      });
    }
  };

  let releaseTheme: (() => void) | undefined = followsActiveTheme
    ? subscribeToThemeChange(handleThemeChange)
    : undefined;

  return Object.freeze({
    getTileMaterial: (value: number): MeshStandardMaterial => {
      const tileTheme = resolveValue(value);
      const key = materialKey(tileTheme);
      const cached = tileMaterials.get(key);

      if (cached !== undefined) {
        cacheHits += 1;
        return cached;
      }

      cacheMisses += 1;
      const detail: RenderDetail = Object.freeze({
        themeId: theme.id,
        value: tileTheme.value,
        isSuper: tileTheme.isSuper,
      });
      reporter.onCount({ name: CACHE_MISS_METRIC, value: 1, detail });

      const material = buildTileMaterial(
        tileTheme,
        theme.palette,
        fillPrecision,
        response,
        readPalette,
      );
      tileMaterials.set(key, material);
      tileMaterialsCreated += 1;
      reporter.onCount({ name: MATERIAL_CREATED_METRIC, value: 1, detail });
      return material;
    },

    getNumeralColor: (value: number): string =>
      resolveValue(value).numeralColor,

    getNumeralThreeColor: (value: number, target?: Color): Color => {
      const tileTheme = resolveValue(value);
      const key = materialKey(tileTheme);
      let cached = numeralColors.get(key);

      if (cached === undefined) {
        cached = toThreeColor(
          readPalette(
            tileTheme.numeralColor,
            tileTheme.isBright ? brightTextColor : textColor,
            'numeralColor',
          ),
        );
        numeralColors.set(key, cached);
      }

      return (target ?? new Color()).copy(cached);
    },

    getBoardFieldMaterial: (): MeshStandardMaterial => {
      if (boardFieldMaterial === null) {
        boardFieldMaterial = buildBoardFieldMaterial(
          theme.palette,
          response,
          readPalette,
        );
        surfaceMaterialsCreated += 1;
        reporter.onCount({
          name: SURFACE_CREATED_METRIC,
          value: 1,
          detail: Object.freeze({ surface: 'boardField', themeId: theme.id }),
        });
      }
      return boardFieldMaterial;
    },

    getEmptyCellMaterial: (): MeshStandardMaterial => {
      if (emptyCellMaterial === null) {
        emptyCellMaterial = buildEmptyCellMaterial(
          theme.palette,
          response,
          emptyCellCompositing,
          readPalette,
        );
        surfaceMaterialsCreated += 1;
        reporter.onCount({
          name: SURFACE_CREATED_METRIC,
          value: 1,
          detail: Object.freeze({
            surface: 'emptyCell',
            themeId: theme.id,
            compositing: emptyCellCompositing,
          }),
        });
      }
      return emptyCellMaterial;
    },

    getTheme: (): Theme => theme,

    setTheme: (next: Theme | ThemeId): Theme =>
      adoptTheme(resolveThemeArgument(next)),

    dispose: (): void => {
      releaseMaterials('dispose');
    },

    destroy: (): void => {
      destroyed = true;
      releaseMaterials('destroy');

      if (releaseTheme !== undefined) {
        releaseTheme();
        releaseTheme = undefined;
      }
    },

    readStats: (): TileMaterialStats =>
      Object.freeze({
        themeId: theme.id,
        cachedTileMaterials: tileMaterials.size,
        tileMaterialsCreated,
        cacheHits,
        cacheMisses,
        surfaceMaterialsCreated,
        materialsDisposed,
        themeRebuilds,
        invalidValues,
        colorFallbacks,
        invalidOptions,
        destroyed,
      }),

    resetStats: (): void => {
      tileMaterialsCreated = 0;
      surfaceMaterialsCreated = 0;
      cacheHits = 0;
      cacheMisses = 0;
      materialsDisposed = 0;
      themeRebuilds = 0;
      invalidValues = 0;
      colorFallbacks = 0;
      invalidOptions = 0;
    },
  });
}
