// Per-value tile materials, plus the board field and empty-cell plate
// materials, for the WebGL board.
//
// The empty-cell plate is declared in the stylesheet as the tile colour at 35%
// alpha. It is pre-composited over the board field and delivered as an opaque
// material; the `emptyCellCompositing` option delivers it as a transparent
// material instead.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
// this module's area enumerated:
//   TR-MATERIAL-01  style/main.scss L334-L402  the generated tile fill, read
//                                              through src/theme/tile-ramp.ts
//                                              and transferred by
//                                              `resolveTileFill()`
//   TR-MATERIAL-02  style/main.scss L334-L402  the bright-text threshold, as
//                                              `resolveTileNumeralColor()`
//   TR-MATERIAL-03  style/main.scss L360-L370  the outer halo shadow, as the
//                                              emissive colour and intensity
//   TR-MATERIAL-04  style/main.scss L360-L370  the inset white ring, as the
//                                              roughness reduction scaled by
//                                              `insetAlpha`
//   TR-MATERIAL-05  style/main.scss L339-L349  the accent overlay's suppressed
//                                              shadow, as the flat material
//                                              `glowSuppressed` gates
//   TR-MATERIAL-06  style/main.scss `.grid-cell`  the empty-cell plate at 35%
//                                              alpha, as the pre-composited or
//                                              transparent plate material
//   TR-MATERIAL-07  target-only row             `createTileMaterialCache()`,
//                                              one material per distinct value
//   TR-MATERIAL-08  target-only row             the colour conversions
//                                              `readThemeColor()`,
//                                              `compositeOver()`,
//                                              `toThreeColor()`,
//                                              `fromThreeColor()` and
//                                              `formatThreeColor()`
//
// Decisions: DL-MATERIAL-01, DL-MATERIAL-02, DL-MATERIAL-03, DL-RAMP-02,
// DL-RAMP-04 (docs/DECISION_LOG.md).

import { Color, MeshStandardMaterial, SRGBColorSpace } from 'three';

import type { RampColor, TileTheme } from '../theme/tile-ramp';
import {
  formatHexColor,
  parseHexColor,
  rampValue,
  tileRampConstants,
} from '../theme/tile-ramp';
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
import type { RenderDetail, RenderReporter } from './webgl-support';
import {
  NOOP_RENDER_REPORTER,
  createGuardedRenderReporter,
  describeRenderError,
} from './webgl-support';

const MODULE_SOURCE = 'render.tile-materials';

const MATERIAL_CREATED_METRIC = 'render.material.created';

const CACHE_MISS_METRIC = 'render.material.cache.miss';

const SURFACE_CREATED_METRIC = 'render.material.surface.created';

const DISPOSED_METRIC = 'render.material.disposed';

const THEME_REBUILD_METRIC = 'render.material.theme.rebuild';

const INVALID_VALUE_METRIC = 'render.material.value.invalid';

const INVALID_OPTION_METRIC = 'render.material.option.invalid';

const COLOR_FALLBACK_METRIC = 'render.material.color.fallback';

const THEME_LISTENER_METRIC = 'render.material.theme.listener.failed';

const CHANNEL_MAX = 255;

const ALPHA_OPAQUE = 1;

const ALPHA_CLEAR = 0;

const PERCENT_SCALE = 100;

const RGB_CHANNEL_COUNT = 3;

const RGBA_ARGUMENT_COUNT = 4;

const RGB_SEPARATORS = /[\s,/]+/;

const CHANNEL_PRECISION = 6;

function confineAlpha(alpha: number): number {
  if (!Number.isFinite(alpha)) {
    return ALPHA_OPAQUE;
  }
  return Math.min(ALPHA_OPAQUE, Math.max(ALPHA_CLEAR, alpha));
}

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
 * @returns Frozen colour. Its alpha is the composite of both alphas, so an
 *   opaque backdrop yields an opaque result.
 * @throws RangeError when a channel of either operand is not a finite
 *   number.
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

/** Formats a `THREE.Color` as a 6-digit hex string on the ramp's terms. */
export function formatThreeColor(color: Color): string {
  const transferred = fromThreeColor(color);
  return formatHexColor({
    r: roundTransferredChannel(transferred.r),
    g: roundTransferredChannel(transferred.g),
    b: roundTransferredChannel(transferred.b),
    a: transferred.a,
  });
}

function roundTransferredChannel(channel: number): number {
  if (!Number.isFinite(channel)) {
    return channel;
  }
  return Number(channel.toFixed(CHANNEL_PRECISION));
}

/**
 * Which of the ramp's two fill forms a material colour is transferred from.
 *
 * `exact` takes `color`, the unquantised channels. Quantised, these are the
 * twelve fills the pinned Dart Sass compiler emits from style/main.scss for
 * the default palette, so the 2D layer that stylesheet compiles and the
 * material built here carry the same fill on every ramp value.
 */
export type TileFillPrecision = 'exact' | 'legacy';

/**
 * How the alpha of the empty-cell plate declared in style/main.scss is
 * delivered.
 *
 * `pre-composited` resolves the plate against the board field and delivers an
 * opaque material. `transparent` delivers the declared colour on a transparent
 * material at that alpha.
 */
export type EmptyCellCompositing = 'pre-composited' | 'transparent';

/**
 * The surface response every material takes, and the multiplier applied to the
 * emissive term.
 *
 * style/main.scss declares flat fills and box-shadows and no material
 * vocabulary of any kind, so these four have no token to resolve against and
 * are stated here. Each is overridable through `TileMaterialCacheOptions`.
 */
export const tileMaterialDefaults = Object.freeze({
  roughness: 0.62,
  minRoughness: 0.34,
  metalness: 0,
  emissiveScale: 1,
} as const);

const MIN_OPTION_VALUE = 0;

const MAX_UNIT_OPTION = 1;

const SUPER_MATERIAL_KEY = 0;

/** Counter name for a value the ramp refused and the fallback covered. */
const VALUE_FALLBACK_METRIC = 'render.material.value.fallback';

const AFTER_DESTROY_METRIC = 'render.material.after_destroy';

/**
 * The ramp value a tile value off the ramp is dressed as.
 *
 * @param value Tile value to place on the ramp.
 * @returns A ramp value `computeTileTheme` resolves.
 */
function rampValueFor(value: number): number {
  const first = rampValue(tileRampConstants.exponentStart);

  if (!Number.isFinite(value) || value <= first) {
    return first;
  }

  if (value > tileRampConstants.superThreshold) {
    // One exponent above the ramp's last, which is the first value
    // `computeTileTheme` reports as a super tile.
    return rampValue(tileRampConstants.limit + 1);
  }

  return rampValue(Math.floor(Math.log2(value)));
}

/** Construction options for `createTileMaterialCache`. */
export interface TileMaterialCacheOptions {
  readonly theme?: Theme | ThemeId;
  readonly followActiveTheme?: boolean;
  readonly fillPrecision?: TileFillPrecision;
  readonly emptyCellCompositing?: EmptyCellCompositing;
  readonly roughness?: number;
  readonly minRoughness?: number;
  readonly metalness?: number;

  /**
   * Multiplier applied to the halo alpha to obtain emissive intensity. Any
   * finite value of at least zero.
   */
  readonly emissiveScale?: number;

  /**
   * Sink this cache reports through. Defaults to `NOOP_RENDER_REPORTER`, and
   * is wrapped so no channel of it can throw into a caller.
   */
  readonly reporter?: RenderReporter;
}

/** What one cache has done and where it stands. */
export interface TileMaterialStats {
  readonly themeId: ThemeId;
  readonly cachedTileMaterials: number;
  readonly tileMaterialsCreated: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly surfaceMaterialsCreated: number;
  readonly materialsDisposed: number;
  readonly themeRebuilds: number;

  /** Requests for a value the ramp does not resolve. */
  readonly invalidValues: number;
  readonly colorFallbacks: number;
  readonly invalidOptions: number;
  readonly destroyed: boolean;
}

/** A per-value tile material cache, and the two board surface materials. */
export interface TileMaterialCache {

  getTileMaterial(value: number): MeshStandardMaterial;

  /**
   * The numeral colour for one tile value, as the CSS colour string the theme
   * states it in.
   *
   * The value style/main.scss emits as a `color` declaration, which
   * src/render/tile-mesh-factory.ts labels a block with and the number-only
   * path writes onto an element.
   *
   * @throws RangeError when the ramp does not resolve `value`.
   */
  getNumeralColor(value: number): string;
  getNumeralThreeColor(value: number, target?: Color): Color;
  getBoardFieldMaterial(): MeshStandardMaterial;
  getEmptyCellMaterial(): MeshStandardMaterial;
  getTheme(): Theme;

  setTheme(theme: Theme | ThemeId): Theme;

  /** Releases every cached material and leaves the cache ready to rebuild. */
  dispose(): void;

  destroy(): void;
  readStats(): TileMaterialStats;
  resetStats(): void;
}

/** Characters a described value is capped at. */
const MAX_THROWN_TEXT_LENGTH = 200;

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

interface OptionContext {
  readonly reporter: RenderReporter;
  readonly onRejected: () => void;
}

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

const FILL_PRECISIONS: readonly TileFillPrecision[] = Object.freeze([
  'exact',
  'legacy',
]);

const EMPTY_CELL_COMPOSITINGS: readonly EmptyCellCompositing[] = Object.freeze([
  'pre-composited',
  'transparent',
]);

function resolveThemeArgument(theme?: Theme | ThemeId): Theme {
  if (theme === undefined) {
    return getActiveTheme();
  }
  return typeof theme === 'string' ? getTheme(theme) : theme;
}

interface SurfaceResponse {
  readonly roughness: number;
  readonly minRoughness: number;
  readonly metalness: number;
  readonly emissiveScale: number;
}

type PaletteReader = (
  declared: string,
  fallback: string,
  field: string,
) => RampColor;

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
 * @throws RangeError when the ramp does not resolve `value`.
 */
export function resolveTileNumeralColor(
  value: number,
  theme?: Theme | ThemeId,
): string {
  return resolveTileTheme(value, theme).numeralColor;
}

/**
 * Whether this value's glow is withheld: because the ramp withholds it for the
 * value, or because the palette withholds it for every value.
 *
 * @param tileTheme Resolved tile theme.
 * @param palette Palette it was resolved against.
 * @returns Whether both glow terms are to be left off.
 */
function isGlowWithheld(
  tileTheme: TileTheme,
  palette: ThemePalette,
): boolean {
  return tileTheme.glowSuppressed || palette.tileGlowSuppressed;
}

function readTileRoughness(
  tileTheme: TileTheme,
  palette: ThemePalette,
  response: SurfaceResponse,
): number {
  const inset = isGlowWithheld(tileTheme, palette)
    ? ALPHA_CLEAR
    : confineAlpha(tileTheme.insetAlpha);
  const span = response.roughness - response.minRoughness;
  return response.roughness - span * inset;
}

/**
 * Builds the material for one tile value.
 *
 * @param material Material to dress.
 * @param tileTheme Resolved tile theme.
 * @param palette Palette of the theme it was resolved against.
 * @param precision Which of the ramp's two fill forms to take.
 * @param response The cache's surface response.
 * @param readPalette Reader the halo entry is resolved through.
 * @returns `material`.
 */
function applyTileMaterial(
  material: MeshStandardMaterial,
  tileTheme: TileTheme,
  palette: ThemePalette,
  precision: TileFillPrecision,
  response: SurfaceResponse,
  readPalette: PaletteReader,
): MeshStandardMaterial {
  toThreeColor(readTileFill(tileTheme, precision), material.color);
  material.roughness = readTileRoughness(tileTheme, palette, response);
  material.metalness = response.metalness;

  if (isGlowWithheld(tileTheme, palette)) {
    material.emissive.setRGB(ALPHA_CLEAR, ALPHA_CLEAR, ALPHA_CLEAR);
    material.emissiveIntensity = ALPHA_CLEAR;
    material.needsUpdate = true;

    return material;
  }

  toThreeColor(
    readPalette(palette.tileGlow, tileGoldGlowColor, 'tileGlow'),
    material.emissive,
  );
  material.emissiveIntensity =
    confineAlpha(tileTheme.haloAlpha) * response.emissiveScale;
  material.needsUpdate = true;

  return material;
}

/**
 * Builds the material for one tile value.
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
  return applyTileMaterial(
    new MeshStandardMaterial(),
    tileTheme,
    palette,
    precision,
    response,
    readPalette,
  );
}

/**
 * Builds the material of the surface the cells sit on, which style/main.scss
 * L358 fills with the theme's board field.
 *
 * @param material Material to dress.
 * @param palette Palette in force.
 * @param response The cache's surface response.
 * @param readPalette Reader the board field is resolved through.
 * @returns `material`.
 */
function applyBoardFieldMaterial(
  material: MeshStandardMaterial,
  palette: ThemePalette,
  response: SurfaceResponse,
  readPalette: PaletteReader,
): MeshStandardMaterial {
  toThreeColor(
    readPalette(palette.boardField, gameContainerBackground, 'boardField'),
    material.color,
  );
  material.roughness = response.roughness;
  material.metalness = response.metalness;
  material.transparent = false;
  material.opacity = ALPHA_OPAQUE;
  material.depthWrite = true;
  material.needsUpdate = true;

  return material;
}

/**
 * Builds the material of the surface the cells sit on.
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
  return applyBoardFieldMaterial(
    new MeshStandardMaterial(),
    palette,
    response,
    readPalette,
  );
}

/**
 * Builds the material of one empty cell of the lattice, which style/main.scss
 * L468 declares as `rgba($tile-color, .35)`.
 *
 * @param material Material to dress.
 * @param palette Palette in force.
 * @param response The cache's surface response.
 * @param compositing How the alpha is delivered.
 * @param readPalette Reader both entries are resolved through.
 * @returns `material`.
 */
function applyEmptyCellMaterial(
  material: MeshStandardMaterial,
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

  material.roughness = response.roughness;
  material.metalness = response.metalness;
  material.needsUpdate = true;

  if (compositing === 'transparent') {
    const translucent = cell.a < ALPHA_OPAQUE;

    toThreeColor(cell, material.color);
    material.transparent = translucent;
    material.opacity = cell.a;
    material.depthWrite = !translucent;

    return material;
  }

  const field = readPalette(
    palette.boardField,
    gameContainerBackground,
    'boardField',
  );

  toThreeColor(compositeOver(cell, field), material.color);
  material.transparent = false;
  material.opacity = ALPHA_OPAQUE;
  material.depthWrite = true;

  return material;
}

/**
 * Builds the material of one empty cell of the lattice.
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
  return applyEmptyCellMaterial(
    new MeshStandardMaterial(),
    palette,
    response,
    compositing,
    readPalette,
  );
}

/**
 * Builds a per-value tile material cache for the WebGL board.
 *
 * The cache follows the theme in force unless a theme is pinned through
 * `options.theme`. On a theme change it releases every material it holds, so
 * the next request rebuilds against the new palette and the WebGL board cannot
 * be left on the previous one while the DOM layer moves to the new one.
 *
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
   * Reads a palette field, falling back to the token the default palette
   * states it from where the declared value is not a colour this module reads.
   *
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


  const resolveValue = (value: number): TileTheme => {
    try {
      return resolveTileTheme(value, theme);
    } catch (error: unknown) {
      invalidValues += 1;

      const placed = rampValueFor(value);
      const detail: RenderDetail = Object.freeze({
        themeId: theme.id,
        value: Number.isFinite(value) ? value : String(value),
        dressedAs: placed,
      });

      reporter.onCount({ name: INVALID_VALUE_METRIC, value: 1, detail });
      reporter.onCount({ name: VALUE_FALLBACK_METRIC, value: 1, detail });
      reporter.onDiagnostic({
        level: 'warning',
        source: MODULE_SOURCE,
        message:
          'the ramp is not defined over the requested tile value; it was ' +
          'dressed as the ramp entry at or below it',
        detail,
        error: describeRenderError(error),
        thrown: error,
      });

      return resolveTileTheme(placed, theme);
    }
  };

  const materialKey = (tileTheme: TileTheme): number =>
    tileTheme.isSuper ? SUPER_MATERIAL_KEY : tileTheme.value;

  /**
   * Refuses a call that would allocate or dress a material after `destroy`.
   *
   * @param method Name of the member called, for the report.
   * @throws Error when the cache has been destroyed.
   */
  const refuseAfterDestroy = (method: string): void => {
    if (!destroyed) {
      return;
    }

    const detail: RenderDetail = Object.freeze({
      themeId: theme.id,
      method,
    });

    reporter.onCount({ name: AFTER_DESTROY_METRIC, value: 1, detail });
    reporter.onDiagnostic({
      level: 'error',
      source: MODULE_SOURCE,
      message: `\`${method}\` was called on a destroyed material cache`,
      detail,
    });

    throw new Error(
      `tile-materials: \`${method}\` is unavailable on a destroyed cache; ` +
        'use `dispose()` where the cache is to be reused',
    );
  };

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


  const adoptTheme = (next: Theme): Theme => {
    if (next === theme) {
      return theme;
    }

    const previousId = theme.id;
    theme = next;

    // Re-dressed against the new theme under the key each was cached at, so a
    // super material stays the super material and a ramp material stays its
    // own value's.
    for (const [key, material] of tileMaterials) {
      const value =
        key === SUPER_MATERIAL_KEY
          ? rampValue(tileRampConstants.limit + 1)
          : key;

      applyTileMaterial(
        material,
        resolveValue(value),
        theme.palette,
        fillPrecision,
        response,
        readPalette,
      );
    }

    numeralColors.clear();

    if (boardFieldMaterial !== null) {
      applyBoardFieldMaterial(
        boardFieldMaterial,
        theme.palette,
        response,
        readPalette,
      );
    }

    if (emptyCellMaterial !== null) {
      applyEmptyCellMaterial(
        emptyCellMaterial,
        theme.palette,
        response,
        emptyCellCompositing,
        readPalette,
      );
    }

    themeRebuilds += 1;
    reporter.onCount({
      name: THEME_REBUILD_METRIC,
      value: 1,
      detail: Object.freeze({
        themeId: next.id,
        previousThemeId: previousId,
        redressed: tileMaterials.size,
      }),
    });

    return theme;
  };

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
        error: describeRenderError(error),
        thrown: error,
      });
    }
  };

  let releaseTheme: (() => void) | undefined = followsActiveTheme
    ? subscribeToThemeChange(handleThemeChange)
    : undefined;

  return Object.freeze({
    getTileMaterial: (value: number): MeshStandardMaterial => {
      refuseAfterDestroy('getTileMaterial');

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

    getNumeralColor: (value: number): string => {
      refuseAfterDestroy('getNumeralColor');

      return resolveValue(value).numeralColor;
    },

    getNumeralThreeColor: (value: number, target?: Color): Color => {
      refuseAfterDestroy('getNumeralThreeColor');

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
      refuseAfterDestroy('getBoardFieldMaterial');

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
      refuseAfterDestroy('getEmptyCellMaterial');

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

    setTheme: (next: Theme | ThemeId): Theme => {
      refuseAfterDestroy('setTheme');

      return adoptTheme(resolveThemeArgument(next));
    },

    dispose: (): void => {
      if (destroyed) {
        reporter.onCount({
          name: AFTER_DESTROY_METRIC,
          value: 1,
          detail: Object.freeze({ themeId: theme.id, method: 'dispose' }),
        });

        return;
      }

      releaseMaterials('dispose');
    },

    destroy: (): void => {
      if (destroyed) {
        return;
      }

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
