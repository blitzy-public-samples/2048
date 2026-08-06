/**
 * The tile colour ramp: a functional port of the `@while` loop of
 * style/main.scss, which generates every tile fill, every glow alpha and every
 * numeral size for the eleven ramp values 2 through 2048, plus the super-tile
 * rule that sits above them. Ported from style/main.scss L334-L412 as that file
 * stood before the Dart Sass migration; the same loop now stands at L524-L600
 * of the migrated file, which remains the normative authority for every value
 * here.
 *
 * The generative function is ported; the twelve compiled rows are not restated
 * as a table in this module, and are the expected values of the ramp-comparison
 * test instead. Decision DL-RAMP-01.
 *
 * Source construct to implementation, one row per rule:
 *
 * | Source                    | Rule                       | Implemented by |
 * |---------------------------|----------------------------|----------------|
 * | main.scss L334-L336       | ramp constants             | section 2      |
 * | helpers.scss L1-L21       | `pow()`, 1-based exponent  | section 2      |
 * | main.scss L339-L349       | accent and bright list     | section 3      |
 * | main.scss L357-L358       | base interpolation         | section 6      |
 * | main.scss L365-L367       | accent overlay             | section 6      |
 * | main.scss L369-L371       | bright-numeral threshold   | section 6      |
 * | main.scss L377-L382       | progressive glow           | section 6      |
 * | main.scss L385-L398, L325 | numeral sizing             | section 6      |
 * | main.scss L405-L412       | the super tile             | section 6      |
 * | html_actuator.js L60      | super threshold, strict >  | section 2      |
 *
 * Every fill is emitted in two forms. `color` carries the unquantised float
 * channels, which reproduce the pinned Dart Sass output to full precision.
 * `colorHex` floors the interpolated base before the accent overlay and floors
 * the result again, which reproduces the twelve historically shipped hex values
 * byte for byte. Both come from one code path, parameterised by
 * `quantiseIntermediate`. Decision DL-RAMP-02.
 *
 * The two forms are not interchangeable: on the four accented values 8, 16, 32
 * and 64 the pinned compiler's unquantised channel and the historically shipped
 * channel differ by one. Deviation DL-RAMP-04.
 *
 * The two glow alphas are emitted without a glow colour: the halo and inset
 * colours are palette entries, published as `--theme-tile-glow` and
 * `--theme-tile-glow-inset` by style/_themes.scss.
 *
 * Renderer-agnostic and free of module-scope side effects: this module reads no
 * DOM, imports no renderer, creates no GPU object and emits no log, so the unit
 * suite and the separately stored seeded snapshot suite import it with no DOM,
 * no WebGL and no observability stack. Its only import is src/theme/tokens.ts.
 *
 * Rationale for the decisions behind this file: docs/DECISION_LOG.md, decisions
 * DL-RAMP-01 through DL-RAMP-04.
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
  /** Red channel, 0-255, unrounded. */
  readonly r: number;
  /** Green channel, 0-255, unrounded. */
  readonly g: number;
  /** Blue channel, 0-255, unrounded. */
  readonly b: number;
  /** Alpha, 0-1. */
  readonly a: number;
}

/** A 3- or 6-digit hex colour, the two forms the token layer declares. */
const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Highest 8-bit channel value. */
const CHANNEL_MAX = 255;

/** Radix of a hex channel pair. */
const HEX_RADIX = 16;

/** Digits one hex channel occupies in the 6-digit form. */
const HEX_CHANNEL_WIDTH = 2;

/**
 * Rejects a value that is not a finite number.
 *
 * @param name Name reported in the error message.
 * @param value Value under test.
 * @throws RangeError when `value` is not finite.
 */
function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(
      `tile-ramp: ${name} must be a finite number, received ` +
        `${String(value)}`,
    );
  }
}

/**
 * Rejects a colour carrying a channel that is not a finite number.
 *
 * @param name Name reported in the error message.
 * @param color Colour under test.
 * @throws RangeError when any channel of `color` is not finite.
 */
function assertColor(name: string, color: RampColor): void {
  assertFinite(`${name}.r`, color.r);
  assertFinite(`${name}.g`, color.g);
  assertFinite(`${name}.b`, color.b);
  assertFinite(`${name}.a`, color.a);
}

/**
 * Floors one channel into the 8-bit range.
 *
 * @param channel Unrounded channel, 0-255.
 * @returns Integer in 0-255.
 */
function floorChannel(channel: number): number {
  return Math.min(CHANNEL_MAX, Math.max(0, Math.floor(channel)));
}

/**
 * Reads a hex colour into floating-point channels. The 3-digit form is
 * expanded by doubling each digit, as CSS expands it.
 *
 * @param hex A 3- or 6-digit hex colour, with the leading `#`, in either
 *   case.
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
 * @param color Colour with unrounded channels.
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
 * @param color Colour to serialise.
 * @returns Lowercase 6-digit hex string with a leading `#`.
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
 * @param colorA First operand, the colour `weight` applies to.
 * @param colorB Second operand.
 * @param weight Share of `colorA` in the result, as a 0-1 fraction. Sass states
 *   this weight as a percentage, so a percentage is divided by 100 at the call
 *   site.
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
 * `$limit` of style/main.scss L334-L336. `glowFrom` is the `4` subtracted from
 * the exponent at L377, and the two divisors are the `1.8` and `3` applied to
 * the resulting opacity at L380-L381.
 */
export const tileRampConstants = {
  /** Base the ramp raises to each exponent. */
  base: 2,

  /**
   * First exponent of the ramp. `pow()` of style/helpers.scss L1-L21 returns
   * the base itself at this exponent, so the ramp's first value is `base`, not
   * 1, and the accent band at values 8 through 64 sits at exponents 3 through
   * 6.
   */
  exponentStart: 1,

  /** Last exponent of the ramp. Resolves the ramp's last value to 2048. */
  limit: 11,

  /** Exponent at which the glow becomes visible. */
  glowFrom: 4,

  /** Divisor applied to the glow opacity for the outer halo. */
  glowHaloDivisor: 1.8,

  /** Divisor applied to the glow opacity for the inset ring. */
  glowInsetDivisor: 3,

  /**
   * Highest tile value the ramp covers. A tile is a super tile when its value
   * is STRICTLY GREATER than this, so 2048 takes the ramp's last entry and 4096
   * is the first super tile — the comparison of js/html_actuator.js L60,
   * carried here through `tileFontSizeThresholds.super` of
   * src/theme/tokens.ts.
   */
  superThreshold: tileFontSizeThresholds.super,
} as const;

/**
 * The tile value one exponent stands for: the `pow()` of style/helpers.scss
 * L1-L21, restricted to the positive-exponent branch the ramp uses.
 *
 * @param exponent Integer at `tileRampConstants.exponentStart` or above.
 * @returns `tileRampConstants.base` raised to `exponent`.
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
 * @param value Tile value; a power of `tileRampConstants.base` at
 *   `tileRampConstants.exponentStart` or above.
 * @returns Integer exponent such that `rampValue(exponent) === value`.
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
 * style/main.scss L339-L349 states per exponent, with the exponent and the tile
 * value it stands for carried alongside.
 */
export interface TileSpecialColor {
  /** Exponent this entry applies to, from `exponentStart` through `limit`. */
  readonly exponent: number;

  /** Tile value that exponent stands for, from `rampValue`. */
  readonly value: number;

  /**
   * Accent mixed over the interpolated base, or `null` where the entry states
   * `false` and no accent applies.
   */
  readonly accent: string | null;

  /** Whether the numeral takes the bright text colour. */
  readonly bright: boolean;
}

/** One `(colour, bright)` pair of style/main.scss L339-L349, in its order. */
type SpecialColorSource = readonly [accent: string | null, bright: boolean];

/**
 * The eleven pairs of style/main.scss L339-L349, in source order, with the Sass
 * `false` of the accent slot carried as `null`. This list is input to the ramp
 * rather than output from it, and is ported as data. The four accent colours
 * and the exponents they sit on are read straight from those source lines.
 */
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
 * The accent and bright-numeral list of style/main.scss L339-L349, keyed by
 * exponent.
 *
 * Sass reads that list with `nth()`, which indexes from 1, so the entry for
 * exponent 1 sits at array index 0 and the conversion below is
 * `index + exponentStart`. Each entry carries its own `exponent`, which
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
 * `bright-text` and the super tint and weight of its L69-L72 — and a themed
 * palette resolves through this interface.
 */
export interface TileRampPalette {
  /** Low anchor of the interpolation: `$tile-color`, the value-2 fill. */
  readonly lowColor: string;

  /** High anchor: `$tile-gold-color`, the value-2048 fill. */
  readonly highColor: string;

  /** Numeral colour below the bright threshold: `$text-color`. */
  readonly textColor: string;

  /** Numeral colour at and above it: `$bright-text-color`. */
  readonly brightTextColor: string;

  /**
   * One entry per exponent, in exponent order. Its length must equal
   * `tileRampConstants.limit`.
   */
  readonly specialColors: readonly TileSpecialColor[];

  /**
   * Share of the accent in the overlay mix, as a 0-1 fraction. The `55%` of
   * style/main.scss L366.
   */
  readonly accentWeight: number;

  /**
   * Tint mixed over the high anchor for a super tile. The `#333` of
   * style/main.scss L407.
   */
  readonly superTint: string;

  /**
   * Share of `superTint` in that mix, as a 0-1 fraction. The `95%` of
   * style/main.scss L407.
   */
  readonly superWeight: number;
}

/** Percentage scale Sass states a mix weight on. */
const FULL_PERCENT = 100;

/**
 * The palette style/main.scss generates its ramp from. Every colour resolves
 * through src/theme/tokens.ts except the accents carried by `tileSpecialColors`
 * and the super tint, which are the loop's own input at L339-L349 and L407.
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
  /** Tile value this entry was resolved for. */
  readonly value: number;

  /**
   * Exponent the value stands at, above `tileRampConstants.limit` for a super
   * tile.
   */
  readonly exponent: number;

  /** Whether the value is strictly above `tileRampConstants.superThreshold`. */
  readonly isSuper: boolean;

  /**
   * Share of the high anchor in the base interpolation, as a percentage. Linear
   * in the exponent and not in the value, so it steps `0, 10, 20 … 100` across
   * the ramp; `100` for a super tile, whose base is the high anchor itself.
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

  /**
   * The fill with unquantised channels, which reproduce the pinned Dart Sass
   * output to full precision.
   */
  readonly color: RampColor;

  /**
   * The fill as 6-digit hex, floored at the intermediate mix and again at the
   * end, which reproduces the historically shipped fill byte for byte.
   */
  readonly colorHex: string;

  /**
   * Whether the numeral takes the bright text colour. The stylesheet emits a
   * `color` declaration only where this holds and lets the numeral inherit
   * otherwise.
   */
  readonly isBright: boolean;

  /**
   * Numeral colour: the palette's bright colour where `isBright` holds, and its
   * text colour otherwise.
   */
  readonly numeralColor: string;

  /**
   * Glow strength, 0-1. Computed for every ramp exponent, as style/main.scss
   * computes it outside the branch that emits the shadow, so it is non-zero on
   * two accented entries whose shadow is never emitted. Zero for a super tile,
   * whose rule sits outside the loop.
   */
  readonly glowOpacity: number;

  /** Alpha of the outer halo: `glowOpacity` over the halo divisor. */
  readonly haloAlpha: number;

  /** Alpha of the inset ring: `glowOpacity` over the inset divisor. */
  readonly insetAlpha: number;

  /**
   * Whether the stylesheet emits no shadow at all for this value, which holds
   * for every value that took an overlay. Distinct from a zero alpha: values 2
   * and 4 do emit both shadows, at alpha 0, so this is `false` for them.
   */
  readonly glowSuppressed: boolean;

  /** Numeral size above the mobile breakpoint, in px. */
  readonly fontSize: number;

  /** Numeral size at or below the mobile breakpoint, in px. */
  readonly fontSizeMobile: number;
}

/* ===== 6. The generative ramp ===== */

/** The colour mixed over an interpolated base, and its share of the result. */
interface RampOverlay {
  /** Overlay colour, or `null` where the value takes none. */
  readonly color: string | null;
  /** Share of the overlay in the result, as a 0-1 fraction. */
  readonly weight: number;
}

/**
 * Reads the entry for one exponent out of a palette's list, the `nth()` lookups
 * of style/main.scss L360-L363.
 *
 * Sass indexes from 1, so the array index is `exponent - exponentStart`. The
 * entry's own `exponent` is re-checked against the requested one, and the
 * list's length against `tileRampConstants.limit`, the guard
 * style/_themes.scss L288 applies to its own accent list.
 *
 * @param palette Palette whose list is read.
 * @param exponent Exponent from `exponentStart` through `limit`.
 * @returns The entry declared for that exponent.
 * @throws RangeError when the list is not `limit` entries long, when the
 *   exponent falls outside the ramp, or when the entry found carries a
 *   different exponent.
 */
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

/**
 * Glow strength at one exponent: `max($exponent - 4, 0) / ($limit - 4)` of
 * style/main.scss L377, whose divisor resolves to 7.
 *
 * @param exponent Ramp exponent.
 * @returns Strength in 0-1 across the ramp.
 */
function glowOpacityAt(exponent: number): number {
  return (
    Math.max(exponent - tileRampConstants.glowFrom, 0) /
    (tileRampConstants.limit - tileRampConstants.glowFrom)
  );
}

/**
 * Mixes an overlay over an interpolated base: the accent overlay of
 * style/main.scss L365-L367, and the super tint of L407, which carries the same
 * two-step shape.
 *
 * Under `quantiseIntermediate` the base is floored before the overlay is mixed
 * over it, and the caller floors the result again — the quantisation the
 * compiled style/main.css L337-L348 carries. Decision DL-RAMP-02.
 *
 * @param interpolated The base, with unquantised channels.
 * @param overlay Overlay to mix over it, or one carrying no colour.
 * @param quantiseIntermediate Whether to floor the base first.
 * @returns The resulting fill, with channels left unrounded by this step.
 * @throws RangeError when the overlay carries a colour that is not hex, or a
 *   weight outside 0-1.
 */
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
 * ramp, and the `&.tile-super` rule of L405-L412 for a value strictly above
 * `tileRampConstants.superThreshold`. Both take the same two steps — a base
 * interpolated between the anchors, then an overlay mixed over it — so a super
 * tile resolves as the ramp's last base under a different overlay.
 *
 * @param value Tile value; a power of `tileRampConstants.base` at
 *   `tileRampConstants.exponentStart` or above.
 * @param palette Colour inputs; the default palette when omitted.
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

  // L339-L349 covers the ramp only; a super tile consults no entry.
  const entry = isSuper ? null : specialColorAt(palette, exponent);

  // L357: linear in the exponent. A super tile takes the whole high anchor,
  // which is what the interpolation resolves to at the ramp's last exponent.
  const goldPercent = isSuper
    ? FULL_PERCENT
    : ((exponent - tileRampConstants.exponentStart) /
        (tileRampConstants.limit - tileRampConstants.exponentStart)) *
      FULL_PERCENT;

  // L358: the weight applies to the high anchor, and Sass states it as a
  // percentage, so it is divided by 100 here.
  const baseColor = sassMix(
    parseHexColor(palette.highColor),
    parseHexColor(palette.lowColor),
    goldPercent / FULL_PERCENT,
  );

  // L365-L367 on the ramp, L407 above it.
  const overlay: RampOverlay =
    entry === null
      ? { color: palette.superTint, weight: palette.superWeight }
      : { color: entry.accent, weight: palette.accentWeight };

  // L369-L371 on the ramp; L406 makes every super numeral bright.
  const isBright = entry === null ? true : entry.bright;

  // L377 across the ramp; the super rule of L405-L412 emits no shadow and sits
  // outside the loop that computes the opacity.
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

    // L380-L381.
    haloAlpha: glowOpacity / tileRampConstants.glowHaloDivisor,
    insetAlpha: glowOpacity / tileRampConstants.glowInsetDivisor,

    // L379: the shadow is emitted only where no overlay was applied.
    glowSuppressed: overlay.color !== null,

    // L385-L398 and the L325 default, resolved by `tileFontSize` of
    // src/theme/tokens.ts, which carries the same thresholds.
    fontSize: tileFontSize(value, 'desktop'),
    fontSizeMobile: tileFontSize(value, 'mobile'),
  });
}

/* ===== 7. The memoised entry point ===== */

/**
 * Themes already resolved for the default palette, keyed by tile value.
 *
 * Bounded by the number of distinct values a board reaches, and carries no
 * eviction policy. Decision DL-RAMP-03.
 */
const defaultThemeCache = new Map<number, TileTheme>();

/**
 * The theme of one tile value under the default palette, resolved once and
 * returned from the cache thereafter. `computeTileTheme` is the uncached path
 * and the one to call with a palette of its own.
 *
 * @param value Tile value; a power of `tileRampConstants.base` at
 *   `tileRampConstants.exponentStart` or above.
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
