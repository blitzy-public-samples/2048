/**
 * The tile colour ramp: a functional port of the tile-theme `@while` loop in
 * style/main.scss, which generates every tile fill, every glow alpha and every
 * numeral size for the eleven ramp values 2 through 2048, plus the super-tile
 * rule that sits above them. That loop remains the normative authority for
 * every value here.
 *
 * The generative function is ported; the twelve compiled rows are not restated
 * as a table in this module, and are the expected values of the
 * ramp-comparison test instead.
 *
 * Every fill is emitted in two forms. `color` carries the unquantised float
 * channels, which reproduce the pinned Dart Sass output to full precision.
 * `colorHex` floors the interpolated base before the accent overlay and floors
 * the result again, which reproduces the twelve historically shipped hex values
 * byte for byte. Both come from one code path, parameterised by
 * `quantiseIntermediate`.
 *
 * The two forms are NOT interchangeable: on the four accented values 8, 16, 32
 * and 64 the pinned compiler's unquantised channel and the historically shipped
 * channel differ by one.
 *
 * The two glow alphas are emitted without a glow colour: the halo and inset
 * colours are palette entries, published as `--theme-tile-glow` and
 * `--theme-tile-glow-inset` by style/_themes.scss.
 *
 * Renderer-agnostic and free of module-scope side effects: this module reads no
 * DOM, imports no renderer, creates no GPU object and emits no log, so the unit
 * suite and the separately stored seeded snapshot suite import it with no DOM,
 * no WebGL and no observability stack.
 *
 * One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
 * this module's area enumerated:
 *   TR-RAMP-01  style/main.scss L334-L402  the `@while` generation loop, ported
 *                                          as `computeTileTheme`
 *   TR-RAMP-02  style/main.scss L336-L337  the `$gold-percent` interpolation,
 *                                          ported as `goldPercent` and
 *                                          `sassMix`
 *   TR-RAMP-03  style/main.scss L339-L349  the `$special-colors` accent list,
 *                                          ported as `tileSpecialColors`
 *   TR-RAMP-04  style/main.scss L351-L356  the bright-text threshold, ported as
 *                                          `TileTheme.brightText`
 *   TR-RAMP-05  style/main.scss L358-L370  the `$glow-opacity` term and its
 *                                          two-part shadow, ported as
 *                                          `haloAlpha`, `insetAlpha` and
 *                                          `glowSuppressed`
 *   TR-RAMP-06  style/main.scss L372-L380  the `tile-super` band above the
 *                                          ramp's last value
 *   TR-RAMP-07  target-only row            `parseHexColor`, `quantiseColor` and
 *                                          `formatHexColor`
 *   TR-RAMP-08  target-only row            `rampValue`, `rampExponent` and
 *                                          `tileRampConstants`
 *
 * Decisions behind this file, argued in docs/DECISION_LOG.md and named here
 * only so the construct can be found from the log:
 *   DL-RAMP-01  the ramp implemented as the same generative function the
 *               stylesheet runs, never as a copied table
 *   DL-RAMP-02  the unquantised `color` channel as the fill source
 *   DL-RAMP-03  the palette supplied as input, so a theme changes hue and not
 *               the ramp's shape
 *   DL-RAMP-04  the `colorHex` form retained, reproducing the fills the
 *               pre-migration generated stylesheet shipped
 */

import {
  brightTextColor,
  textColor,
  tileColor,
  tileFontSize,
  tileFontSizeThresholds,
  tileGoldColor,
} from './tokens';

/* ===== 1. Colour primitives ===== */

/**
 * A colour with floating-point channels, the form every mix in this module
 * carries.
 *
 * `r`, `g` and `b` are 0-255 and are never rounded by a mix; `a` is 0-1.
 */
export interface RampColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

const CHANNEL_MAX = 255;

const HEX_RADIX = 16;

const HEX_CHANNEL_WIDTH = 2;

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(
      `tile-ramp: ${name} must be a finite number, received ` +
        `${String(value)}`,
    );
  }
}

function assertColor(name: string, color: RampColor): void {
  assertFinite(`${name}.r`, color.r);
  assertFinite(`${name}.g`, color.g);
  assertFinite(`${name}.b`, color.b);
  assertFinite(`${name}.a`, color.a);
}

function floorChannel(channel: number): number {
  return Math.min(CHANNEL_MAX, Math.max(0, Math.floor(channel)));
}

/**
 * Reads a hex colour into floating-point channels. The 3-digit form is
 * expanded by doubling each digit, as CSS expands it.
 *
 * @returns Frozen opaque colour whose channels are integers in 0-255.
 * @throws RangeError when `hex` is not a 3- or 6-digit hex colour.
 */
export function parseHexColor(hex: string): RampColor {
  if (typeof hex !== 'string' || !HEX_COLOR_PATTERN.test(hex)) {
    throw new RangeError(
      'tile-ramp: expected a 3- or 6-digit hex colour, received ' +
        `${String(hex)}`,
    );
  }
  const digits = hex.slice(1);
  const wide =
    digits.length === 3
      ? digits.replace(/./g, (digit) => digit + digit)
      : digits;
  return Object.freeze({
    r: Number.parseInt(wide.slice(0, 2), HEX_RADIX),
    g: Number.parseInt(wide.slice(2, 4), HEX_RADIX),
    b: Number.parseInt(wide.slice(4, 6), HEX_RADIX),
    a: 1,
  });
}

/**
 * Floors every channel of a colour into the 8-bit range, the quantisation Sass
 * applies when it serialises the result of a mix. Alpha is carried through
 * unchanged.
 *
 * @returns Frozen colour whose channels are integers in 0-255.
 * @throws RangeError when any channel of `color` is not finite.
 */
export function quantiseColor(color: RampColor): RampColor {
  assertColor('color', color);
  return Object.freeze({
    r: floorChannel(color.r),
    g: floorChannel(color.g),
    b: floorChannel(color.b),
    a: color.a,
  });
}

/**
 * Formats a colour as a 6-digit hex string, flooring each channel into the
 * 8-bit range. Alpha is not serialised: the stylesheet carries a tile fill as
 * an opaque colour and its two glow alphas separately.
 *
 * @throws RangeError when any channel of `color` is not finite.
 */
export function formatHexColor(color: RampColor): string {
  assertColor('color', color);
  const channels = [color.r, color.g, color.b]
    .map((channel) =>
      floorChannel(channel)
        .toString(HEX_RADIX)
        .padStart(HEX_CHANNEL_WIDTH, '0'),
    )
    .join('');
  return `#${channels}`;
}

/**
 * Sass's legacy `mix()`: a linear interpolation in plain sRGB over 0-255
 * channels, with the weight applied to the FIRST colour and adjusted for the
 * difference in alpha between the two operands. Channels are returned
 * unrounded; quantise with `quantiseColor` or `formatHexColor` where an 8-bit
 * result is required.
 *
 * For two opaque operands the alpha difference is zero and the adjusted weight
 * equals `weight`; the adjustment is what a translucent operand resolves
 * through.
 *
 * @returns Frozen colour with unrounded channels.
 * @throws RangeError when a channel is not finite, or when `weight` is not a
 *   finite number in 0-1.
 */
export function sassMix(
  colorA: RampColor,
  colorB: RampColor,
  weight: number,
): RampColor {
  assertColor('colorA', colorA);
  assertColor('colorB', colorB);
  assertFinite('weight', weight);
  if (weight < 0 || weight > 1) {
    throw new RangeError(
      `tile-ramp: weight must be a fraction in 0-1, received ${weight}`,
    );
  }
  const scaled = weight * 2 - 1;
  const alphaDelta = colorA.a - colorB.a;
  const combined = scaled * alphaDelta;
  const adjusted =
    combined === -1 ? scaled : (scaled + alphaDelta) / (1 + combined);
  const weightA = (adjusted + 1) / 2;
  const weightB = 1 - weightA;
  return Object.freeze({
    r: colorA.r * weightA + colorB.r * weightB,
    g: colorA.g * weightA + colorB.g * weightB,
    b: colorA.b * weightA + colorB.b * weightB,
    a: colorA.a * weight + colorB.a * (1 - weight),
  });
}

/* ===== 2. Ramp constants ===== */

/**
 * The constants the ramp is generated from, and the threshold above which a
 * tile leaves the ramp.
 *
 * `base`, `exponentStart` and `limit` are `$base`, the initial `$exponent` and
 * `$limit` of style/main.scss. `glowFrom` is the `4` subtracted from the
 * exponent in the glow expression, and the two divisors are the `1.8` and `3`
 * applied to the resulting opacity.
 */
export const tileRampConstants = {
  base: 2,

  /**
   * First exponent of the ramp. `pow()` of style/helpers.scss returns the base
   * itself at this exponent, so the ramp's first value is `base`, not 1, and
   * the accent band at values 8 through 64 sits at exponents 3 through 6.
   */
  exponentStart: 1,
  limit: 11,
  glowFrom: 4,
  glowHaloDivisor: 1.8,
  glowInsetDivisor: 3,
  superThreshold: tileFontSizeThresholds.super,
} as const;

/**
 * The tile value one exponent stands for: the `pow()` of style/helpers.scss,
 * restricted to the positive-exponent branch the ramp uses.
 *
 * @throws RangeError when `exponent` is not a finite integer at
 *   `tileRampConstants.exponentStart` or above.
 */
export function rampValue(exponent: number): number {
  assertFinite('exponent', exponent);
  if (
    !Number.isInteger(exponent) ||
    exponent < tileRampConstants.exponentStart
  ) {
    throw new RangeError(
      'tile-ramp: exponent must be an integer at ' +
        `${tileRampConstants.exponentStart} or above, received ${exponent}`,
    );
  }
  return tileRampConstants.base ** exponent;
}

/**
 * The exponent one tile value stands at, the inverse of `rampValue`. Values
 * above the ramp's last one resolve to an exponent above
 * `tileRampConstants.limit`.
 *
 * @throws RangeError when `value` is not such a power.
 */
export function rampExponent(value: number): number {
  assertFinite('value', value);
  const exponent = Math.log2(value);
  if (
    !Number.isInteger(exponent) ||
    exponent < tileRampConstants.exponentStart ||
    rampValue(exponent) !== value
  ) {
    throw new RangeError(
      `tile-ramp: value must be a power of ${tileRampConstants.base} at ` +
        `exponent ${tileRampConstants.exponentStart} or above, received ` +
        `${value}`,
    );
  }
  return exponent;
}

/* ===== 3. The accent and bright-numeral source list ===== */

/**
 * One entry of the ramp's accent and bright-numeral list: the pair
 * style/main.scss states per exponent, with the exponent and the tile value it
 * stands for carried alongside.
 */
export interface TileSpecialColor {
  readonly exponent: number;
  readonly value: number;

  /**
   * Accent mixed over the interpolated base, or `null` where the entry states
   * `false` and no accent applies.
   */
  readonly accent: string | null;
  readonly bright: boolean;
}

type SpecialColorSource = readonly [accent: string | null, bright: boolean];

const SPECIAL_COLOR_SOURCE: readonly SpecialColorSource[] = [
  [null, false], //       2
  [null, false], //       4
  ['#f78e48', true], //   8
  ['#fc5e2e', true], //  16
  ['#ff3333', true], //  32
  ['#ff0000', true], //  64
  [null, true], //      128
  [null, true], //      256
  [null, true], //      512
  [null, true], //     1024
  [null, true], //     2048
];

/**
 * The accent and bright-numeral list of style/main.scss, keyed by exponent.
 *
 * Sass reads that list with `nth()`, which indexes from 1, so the entry for
 * exponent 1 sits at array index 0 and the conversion below is `index +
 * exponentStart`. Each entry carries its own `exponent`, which
 * `specialColorAt` re-checks against the requested one on every lookup.
 */
export const tileSpecialColors: readonly TileSpecialColor[] = Object.freeze(
  SPECIAL_COLOR_SOURCE.map((source, index) => {
    const exponent = index + tileRampConstants.exponentStart;
    return Object.freeze({
      exponent,
      value: rampValue(exponent),
      accent: source[0],
      bright: source[1],
    });
  }),
);

/* ===== 4. The ramp's colour inputs ===== */

/**
 * The colours and weights one ramp is generated from.
 *
 * The default palette below carries the values style/main.scss states.
 * style/_themes.scss generates its own ramps from the same key set —
 * `tile-low`, `tile-high`, `tile-accents`, `tile-accent-weight`, `text`,
 * `bright-text` and its own super tint and weight — and a themed
 * palette resolves through this interface.
 */
export interface TileRampPalette {
  readonly lowColor: string;
  readonly highColor: string;
  readonly textColor: string;
  readonly brightTextColor: string;

  /**
   * One entry per exponent, in exponent order. Its length must equal
   * `tileRampConstants.limit`.
   */
  readonly specialColors: readonly TileSpecialColor[];
  readonly accentWeight: number;
  readonly superTint: string;
  readonly superWeight: number;
}

const FULL_PERCENT = 100;

/**
 * The palette style/main.scss generates its ramp from. Every colour resolves
 * through src/theme/tokens.ts except the accents carried by
 * `tileSpecialColors` and the super tint, which are the loop's own input.
 */
export const defaultTileRampPalette: TileRampPalette = Object.freeze({
  lowColor: tileColor,
  highColor: tileGoldColor,
  textColor,
  brightTextColor,
  specialColors: tileSpecialColors,
  accentWeight: 55 / FULL_PERCENT,
  superTint: '#333',
  superWeight: 95 / FULL_PERCENT,
});

/* ===== 5. The resolved theme of one tile value ===== */

/** Everything style/main.scss emits for one tile value, resolved. */
export interface TileTheme {
  readonly value: number;
  readonly exponent: number;
  readonly isSuper: boolean;

  /**
   * Share of the high anchor in the base interpolation, as a percentage.
   * Linear in the exponent and not in the value, so it steps `0, 10, 20 … 100`
   * across the ramp; `100` for a super tile, whose base is the high anchor
   * itself.
   */
  readonly goldPercent: number;

  /**
   * The interpolated base before any overlay, with unquantised channels. The
   * `colorHex` path floors this before mixing the overlay over it.
   */
  readonly baseColor: RampColor;

  /**
   * The colour mixed over the base: the exponent's accent on the ramp, the
   * super tint above it, and `null` where neither applies.
   */
  readonly accentColor: string | null;
  readonly color: RampColor;
  readonly colorHex: string;

  /**
   * Whether the numeral takes the bright text colour. The stylesheet emits a
   * `color` declaration only where this holds and lets the numeral inherit
   * otherwise.
   */
  readonly isBright: boolean;
  readonly numeralColor: string;

  /**
   * Glow strength, 0-1. Computed for every ramp exponent, as style/main.scss
   * computes it outside the branch that emits the shadow, so it is non-zero on
   * two accented entries whose shadow is never emitted. Zero for a super tile,
   * whose rule sits outside the loop.
   */
  readonly glowOpacity: number;
  readonly haloAlpha: number;
  readonly insetAlpha: number;

  /**
   * Whether the stylesheet emits no shadow at all for this value, which holds
   * for every value that took an overlay. Distinct from a zero alpha: values 2
   * and 4 do emit both shadows, at alpha 0, so this is `false` for them.
   */
  readonly glowSuppressed: boolean;
  readonly fontSize: number;
  readonly fontSizeMobile: number;
}

/* ===== 6. The generative ramp ===== */

interface RampOverlay {
  /** Overlay colour, or `null` where the value takes none. */
  readonly color: string | null;
  readonly weight: number;
}

function specialColorAt(
  palette: TileRampPalette,
  exponent: number,
): TileSpecialColor {
  if (palette.specialColors.length !== tileRampConstants.limit) {
    throw new RangeError(
      `tile-ramp: palette must declare ${tileRampConstants.limit} ramp ` +
        `entries, received ${palette.specialColors.length}`,
    );
  }
  const index = exponent - tileRampConstants.exponentStart;
  if (index < 0 || index >= palette.specialColors.length) {
    throw new RangeError(
      `tile-ramp: exponent ${exponent} is outside the ramp, which covers ` +
        `${tileRampConstants.exponentStart} through ` +
        `${tileRampConstants.limit}`,
    );
  }
  const entry = palette.specialColors[index];
  if (entry.exponent !== exponent) {
    throw new RangeError(
      `tile-ramp: palette entry at index ${index} declares exponent ` +
        `${entry.exponent}, expected ${exponent}`,
    );
  }
  return entry;
}

function glowOpacityAt(exponent: number): number {
  return (
    Math.max(exponent - tileRampConstants.glowFrom, 0) /
    (tileRampConstants.limit - tileRampConstants.glowFrom)
  );
}

function overlayBackground(
  interpolated: RampColor,
  overlay: RampOverlay,
  quantiseIntermediate: boolean,
): RampColor {
  const base = quantiseIntermediate
    ? quantiseColor(interpolated)
    : interpolated;
  if (overlay.color === null) {
    return base;
  }
  return sassMix(parseHexColor(overlay.color), base, overlay.weight);
}

/**
 * Resolves one tile value against a palette, without consulting the cache.
 *
 * Ports the body of the `@while` loop of style/main.scss for a value on the
 * ramp, and its `&.tile-super` rule for a value strictly above
 * `tileRampConstants.superThreshold`. Both take the same two steps — a base
 * interpolated between the anchors, then an overlay mixed over it — so a super
 * tile resolves as the ramp's last base under a different overlay.
 *
 * @returns Frozen theme for that value.
 * @throws RangeError when `value` is not such a power, or when `palette` is
 *   malformed.
 */
export function computeTileTheme(
  value: number,
  palette: TileRampPalette = defaultTileRampPalette,
): TileTheme {
  const exponent = rampExponent(value);
  const isSuper = value > tileRampConstants.superThreshold;

  const entry = isSuper ? null : specialColorAt(palette, exponent);

  // Linear in the exponent. A super tile takes the whole high anchor, which is
  // what the interpolation resolves to at the ramp's last exponent.
  const goldPercent = isSuper
    ? FULL_PERCENT
    : ((exponent - tileRampConstants.exponentStart) /
        (tileRampConstants.limit - tileRampConstants.exponentStart)) *
      FULL_PERCENT;

  // The weight applies to the high anchor, and Sass states it as a percentage,
  // so it is divided by 100 here.
  const baseColor = sassMix(
    parseHexColor(palette.highColor),
    parseHexColor(palette.lowColor),
    goldPercent / FULL_PERCENT,
  );

  // The accent overlay applies on the ramp; the super tint applies above it.
  const overlay: RampOverlay =
    entry === null
      ? { color: palette.superTint, weight: palette.superWeight }
      : { color: entry.accent, weight: palette.accentWeight };

  // Every super numeral is bright.
  const isBright = entry === null ? true : entry.bright;

  // The super rule emits no shadow and sits outside the loop that computes the
  // opacity.
  const glowOpacity = entry === null ? 0 : glowOpacityAt(exponent);

  return Object.freeze({
    value,
    exponent,
    isSuper,
    goldPercent,
    baseColor,
    accentColor: overlay.color,
    color: overlayBackground(baseColor, overlay, false),
    colorHex: formatHexColor(overlayBackground(baseColor, overlay, true)),
    isBright,
    numeralColor: isBright ? palette.brightTextColor : palette.textColor,
    glowOpacity,

    // The shadow is emitted only where no overlay was applied.
    haloAlpha: glowOpacity / tileRampConstants.glowHaloDivisor,
    insetAlpha: glowOpacity / tileRampConstants.glowInsetDivisor,

    // Suppressed exactly where an overlay was applied.
    glowSuppressed: overlay.color !== null,

    // Resolved by `tileFontSize` of src/theme/tokens.ts, which carries the same
    // thresholds.
    fontSize: tileFontSize(value, 'desktop'),
    fontSizeMobile: tileFontSize(value, 'mobile'),
  });
}

/* ===== 7. The memoised entry point ===== */

const defaultThemeCache = new Map<number, TileTheme>();

/**
 * The theme of one tile value under the default palette, resolved once and
 * returned from the cache thereafter. `computeTileTheme` is the uncached path
 * and the one to call with a palette of its own.
 *
 * @returns Frozen theme for that value, identical between calls.
 * @throws RangeError when `value` is not such a power.
 */
export function getTileTheme(value: number): TileTheme {
  const cached = defaultThemeCache.get(value);
  if (cached !== undefined) {
    return cached;
  }
  const theme = computeTileTheme(value);
  defaultThemeCache.set(value, theme);
  return theme;
}
