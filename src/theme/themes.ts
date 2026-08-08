/**
 * The theme catalogue: the default palette that carries the existing visual
 * identity, plus the two additive accessibility palettes, plus the activation
 * contract that switches between them at runtime.
 *
 * MIRROR CONTRACT: style/_themes.scss owns the CSS half of this contract and
 * MUST agree with this module. It selects on the `THEME_ATTRIBUTE` name and the
 * `themeAttributeValues` strings declared below, its `$theme-names` list is
 * `themeIds`, and each of its palette maps is the palette of the same name
 * here. A difference in either direction makes a theme a no-op or splits the 2D
 * and 3D presentations apart.
 *
 * No palette carries a per-value tile colour: a themed ramp is new INPUT to
 * `computeTileTheme` of src/theme/tile-ramp.ts, which stays the one generative
 * implementation, so all three themes share the ramp's shape and differ only in
 * hue. `resolveTileTheme` is the resolver a renderer calls.
 *
 * `applyTheme` is the only DOM access in src/theme and it is guarded, so this
 * module stays importable by the DOM-free unit and snapshot suites. The module
 * reads no storage, queries no media feature, emits no log and performs no work
 * at import time beyond freezing its own declarations.
 *
 * One traceability row of docs/TRACEABILITY_MATRIX.md apiece. THEME is one area
 * across both halves of the mirror, so these ordinals are unique across this
 * module and style/_themes.scss:
 *   TR-THEME-01  style/main.scss L4-L22   the existing palette, carried as the
 *                                         default theme
 *   TR-THEME-02  target-only row          the additive high-contrast palette
 *   TR-THEME-03  target-only row          the additive colourblind-safe palette
 *   TR-THEME-04  target-only row          `THEME_ATTRIBUTE`,
 *                                         `themeAttributeValues` and
 *                                         `applyTheme`
 *   TR-THEME-05  target-only row          `resolveTileTheme`, the per-theme
 *                                         resolver a renderer calls
 *   TR-THEME-06  target-only row          `subscribeToThemeChange` and
 *                                         `getActiveTheme`
 *   TR-THEME-11  target-only row          `ThemePalette.neutralLight`, the
 *                                         lighting white point each palette
 *                                         states; decision DL-TOKEN-07
 *
 * Decisions behind this file, argued in docs/DECISION_LOG.md and named here
 * only so the construct can be found from the log:
 *   DL-THEME-01  the high-contrast palette
 *   DL-THEME-02  the colourblind-safe palette
 *   DL-THEME-03  the attribute the activation contract is carried on
 *   DL-THEME-04  a themed ramp supplied as input to `computeTileTheme`, which
 *                stays the one generative implementation
 */

import {
  brightTextColor,
  derivedColors,
  gameContainerBackground,
  pageBackground,
  ruleColor,
  textColor,
  tileColor,
  tileGoldColor,
  tileGoldGlowColor,
} from './tokens';
import {
  computeTileTheme,
  defaultTileRampPalette,
  formatHexColor,
  parseHexColor,
  rampValue,
  sassMix,
  tileRampConstants,
  tileSpecialColors,
} from './tile-ramp';
import type {
  RampColor,
  TileRampPalette,
  TileSpecialColor,
  TileTheme,
} from './tile-ramp';

/**
 * The three palettes the catalogue carries, spelled as `$theme-names` of
 * style/_themes.scss spells them. A string-literal union whose members are the
 * activation attribute values verbatim, so no translation step stands between
 * the two.
 */
export type ThemeId = 'default' | 'high-contrast' | 'colorblind-safe';

/**
 * Attribute that activates a palette, set on the root element.
 *
 * `$theme-attribute` of style/_themes.scss, which emits one
 * `[data-theme="<name>"]` block per additive palette.
 */
export const THEME_ATTRIBUTE = 'data-theme';

/**
 * The attribute value each id is activated by, keyed by id.
 *
 * The value is the id verbatim. The default is listed for completeness and is
 * inert by construction: style/_themes.scss keys `$themes` on the two additive
 * palettes only, so `[data-theme="default"]` selects no scoped rule and its
 * unscoped cascade applies.
 */
export const themeAttributeValues = {
  default: 'default',
  'high-contrast': 'high-contrast',
  'colorblind-safe': 'colorblind-safe',
} as const satisfies Record<ThemeId, string>;

/** The id in force before anything is applied, and after a reset. */
export const DEFAULT_THEME_ID: ThemeId = 'default';

/**
 * Every id, in catalogue order, with the default first — the order
 * `$theme-names` of style/_themes.scss lists.
 */
export const themeIds: readonly ThemeId[] = Object.freeze([
  'default',
  'high-contrast',
  'colorblind-safe',
] as const satisfies readonly ThemeId[]);

/** Narrows an unknown value to a `ThemeId`. */
export function isThemeId(value: unknown): value is ThemeId {
  return (
    typeof value === 'string' &&
    (themeIds as readonly string[]).includes(value)
  );
}

/**
 * Every colour one palette states, and the ramp inputs it generates its tile
 * fills from.
 *
 * The key set mirrors each Sass palette map of style/_themes.scss one key at a
 * time, less its `name` key, which is carried by `Theme.id`. Every field is
 * required, so a palette is a total override and no theme falls back to another
 * theme's colour for any surface.
 *
 * Colours are CSS colour strings. A field the ramp consumes — `tileLow`,
 * `tileHigh`, `tileAccents`, `text`, `brightText` and `tileSuperTint` — must be
 * a 3- or 6-digit hex colour, the form `parseHexColor` of
 * src/theme/tile-ramp.ts reads. Every other field may carry any CSS colour, and
 * the five translucent surfaces carry `rgba()`.
 */
export interface ThemePalette {
  readonly pageBackground: string;
  readonly text: string;
  readonly brightText: string;
  readonly rule: string;
  readonly boardField: string;
  readonly cell: string;
  readonly tileLow: string;
  readonly tileHigh: string;

  /**
   * One accent per ramp exponent, in exponent order, `null` where the exponent
   * takes none. Its length MUST equal `tileRampConstants.limit`, the guard
   * style/_themes.scss applies to its accent list.
   */
  readonly tileAccents: readonly (string | null)[];
  readonly tileAccentWeight: number;
  readonly tileGlow: string;
  readonly tileGlowInset: string;

  /**
   * The neutral white point of the 2.5D lighting rig, read by
   * src/render/scene.ts for the key light's origin and the fill light's sky
   * half. Every palette states `#ffffff`, so a palette becomes able to state a
   * warmer or cooler light without the renderer naming a colour of its own.
   */
  readonly neutralLight: string;

  /**
   * Tint mixed over the high anchor for a tile above the ramp. With
   * `tileSuperWeight` it replaces the resolved `tile-super` key of
   * style/_themes.scss: the fill is derived by `resolveTileTheme` rather than
   * stated, so it cannot disagree with the ramp that produces every other fill.
   */
  readonly tileSuperTint: string;
  readonly tileSuperWeight: number;
  readonly scoreSurface: string;
  readonly scoreLabel: string;
  readonly scoreValue: string;
  readonly scoreAddition: string;
  readonly buttonSurface: string;
  readonly buttonLabel: string;
  readonly overlayLoss: string;
  readonly overlayLossText: string;
  readonly overlayWin: string;
  readonly overlayWinText: string;

  /**
   * The focus ring. Read as `--theme-focus-ring` by style/_a11y.scss, which
   * owns the focus rules themselves.
   */
  readonly focusRing: string;
  readonly focusRingContrast: string;
  readonly diagnosticsSurface: string;
  readonly diagnosticsText: string;
  readonly diagnosticsAccent: string;
}

/**
 * CSS `white`, the keyword style/main.scss applies to the score numerals and to
 * the tile glow's inset highlight, in its hex spelling.
 */
const WHITE = '#ffffff';

const BLACK = '#000000';

/**
 * Alpha both additive palettes state on their two terminal overlays, where the
 * default palette states 0.5.
 */
const ADDITIVE_OVERLAY_ALPHA = 0.94;

/**
 * Exponent from which a numeral takes the bright text colour.
 *
 * `$ramp-bright-from` of style/_themes.scss. Applied to every palette by
 * `createTileSpecialColors`, and it reproduces the `bright` flag of
 * `tileSpecialColors` of src/theme/tile-ramp.ts exactly, so values 2 and 4 take
 * the text colour and every value from 8 up takes the bright one.
 */
const RAMP_BRIGHT_FROM_EXPONENT = 3;

/**
 * Composes the `rgba()` form style/_themes.scss produces from `rgba($hex, $a)`,
 * so a translucent palette entry is derived from its opaque colour.
 *
 * @throws RangeError when `hex` is not a hex colour, or when `alpha` is not a
 *   finite number in 0-1.
 */
function rgbaLiteral(hex: string, alpha: number): string {
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
    throw new RangeError(
      `themes: alpha must be a fraction in 0-1, received ${String(alpha)}`,
    );
  }
  const { r, g, b } = parseHexColor(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * The accents of the default ramp, read off `tileSpecialColors` of
 * src/theme/tile-ramp.ts rather than restated, so this list and the ported
 * `$special-colors` list of style/main.scss cannot diverge.
 *
 * Resolves to the four accents of exponents 3 through 6 — tile values 8, 16, 32
 * and 64 — and `null` at every other exponent.
 */
const defaultTileAccents: readonly (string | null)[] = Object.freeze(
  tileSpecialColors.map((entry) => entry.accent),
);

/**
 * The palette the stylesheet already compiles, unchanged.
 *
 * `$palette-default` of style/_themes.scss. Every entry resolves to a
 * src/theme/tokens.ts export or to a src/theme/tile-ramp.ts ramp input, except
 * the three cited at their declaration. Frozen so no consumer can mutate the
 * visual identity it carries.
 */
export const defaultThemePalette: ThemePalette = Object.freeze({
  pageBackground,
  text: textColor,
  brightText: brightTextColor,
  rule: ruleColor,
  boardField: gameContainerBackground,
  cell: derivedColors.gridCellBackground,
  tileLow: tileColor,
  tileHigh: tileGoldColor,
  tileAccents: defaultTileAccents,
  tileAccentWeight: defaultTileRampPalette.accentWeight,
  tileGlow: tileGoldGlowColor,
  tileGlowInset: WHITE,
  neutralLight: WHITE,
  tileSuperTint: defaultTileRampPalette.superTint,
  tileSuperWeight: defaultTileRampPalette.superWeight,
  scoreSurface: gameContainerBackground,
  scoreLabel: derivedColors.scoreLabelColor,
  scoreValue: WHITE,
  scoreAddition: derivedColors.scoreAdditionColor,
  buttonSurface: derivedColors.buttonBackground,
  buttonLabel: brightTextColor,
  overlayLoss: derivedColors.overlayLossBackground,
  overlayLossText: textColor,
  overlayWin: derivedColors.overlayWinBackground,
  overlayWinText: brightTextColor,

  // The outer band is `color.adjust($text-color, $lightness: -22%)`, the same
  // derivation `diagnosticsSurface` below is written from, in place of
  // `$text-color` itself; the inner band is unchanged. Against every default
  // surface the ring is drawn on — the page, the board field, an empty cell,
  // a score box, a primary button, both overlay washes, all eleven ramp fills
  // and the band above the ramp — the stronger of the two bands now measures
  // at least 3.7:1, where `$text-color` reached only 2.28:1 on the board field
  // and the score boxes. The rest of the palette is unchanged: these are the
  // only two entries the ring resolves through, and style/_themes.scss
  // L117-L118 states the same pair.
  focusRing: derivedColors.focusRingColor,
  focusRingContrast: brightTextColor,

  // `color.adjust($text-color, $lightness: -22%)` of style/_themes.scss, in
  // its compiled form.
  diagnosticsSurface: '#3a3631',
  diagnosticsText: brightTextColor,
  diagnosticsAccent: tileGoldColor,
});

/**
 * The accent list of the high-contrast ramp: no accent at any exponent, so its
 * fills are the interpolation between its two anchors at every step and its
 * glow is emitted at every step.
 */
const highContrastTileAccents: readonly (string | null)[] = Object.freeze(
  tileSpecialColors.map(() => null),
);

/**
 * The high-contrast palette, mirroring `$palette-high-contrast` of
 * style/_themes.scss key for key. Its ramp runs from a mid-tone low anchor to a
 * near-black high anchor and declares no accent band, so every step differs
 * from its neighbours in luminance.
 *
 * DL-THEME-01.
 */
export const highContrastThemePalette: ThemePalette = Object.freeze({
  pageBackground: WHITE,
  text: BLACK,
  brightText: WHITE,
  rule: '#5e5e5e',
  boardField: '#c8c8c8',
  cell: '#ebebeb',
  tileLow: '#888888',
  tileHigh: '#202020',
  tileAccents: highContrastTileAccents,
  tileAccentWeight: 1,
  tileGlow: '#c8c8c8',
  tileGlowInset: WHITE,
  neutralLight: WHITE,

  // Mixed at full weight, so the tile above the ramp is the tint itself.
  tileSuperTint: BLACK,
  tileSuperWeight: 1,
  scoreSurface: BLACK,
  scoreLabel: WHITE,
  scoreValue: WHITE,
  scoreAddition: '#757575',
  buttonSurface: '#00308f',
  buttonLabel: WHITE,
  overlayLoss: rgbaLiteral('#9e9e9e', ADDITIVE_OVERLAY_ALPHA),
  overlayLossText: BLACK,
  overlayWin: rgbaLiteral('#ffe680', ADDITIVE_OVERLAY_ALPHA),
  overlayWinText: BLACK,
  focusRing: BLACK,
  focusRingContrast: WHITE,
  diagnosticsSurface: BLACK,
  diagnosticsText: WHITE,
  diagnosticsAccent: '#7fd4ff',
});

/**
 * The accent list of the colourblind-safe ramp, at the same four exponents the
 * default ramp accents — 3 through 6, tile values 8, 16, 32 and 64 — and `null`
 * at every other exponent.
 */
const colorblindSafeTileAccents: readonly (string | null)[] = Object.freeze([
  null,
  null,
  '#986904',
  '#a84b04',
  '#a02e6f',
  '#025c53',
  null,
  null,
  null,
  null,
  null,
] as const satisfies readonly (string | null)[]);

/**
 * The colourblind-safe palette, mirroring `$palette-colorblind-safe` of
 * style/_themes.scss key for key. Its anchors and its four accents are drawn
 * from the Okabe-Ito colour set and sit on a monotonic luminance ladder, so the
 * ramp separates by lightness as well as by hue and its axis runs yellow to
 * blue rather than orange to red. Its page background and board field are the
 * default palette's, carried through the same two tokens.
 *
 * DL-THEME-02.
 */
export const colorblindSafeThemePalette: ThemePalette = Object.freeze({
  pageBackground,
  text: BLACK,
  brightText: WHITE,
  rule: '#6f6a5f',
  boardField: gameContainerBackground,
  cell: '#d5cfc2',
  tileLow: '#8c8c3f',
  tileHigh: '#061d4c',
  tileAccents: colorblindSafeTileAccents,
  tileAccentWeight: 1,
  tileGlow: '#8ecae6',
  tileGlowInset: WHITE,
  neutralLight: WHITE,

  // Mixed at full weight, so the tile above the ramp is the tint itself.
  tileSuperTint: BLACK,
  tileSuperWeight: 1,
  scoreSurface: '#3f3a33',
  scoreLabel: WHITE,
  scoreValue: WHITE,
  scoreAddition: '#8e8e8e',
  buttonSurface: '#00355c',
  buttonLabel: WHITE,
  overlayLoss: rgbaLiteral('#9b9384', ADDITIVE_OVERLAY_ALPHA),
  overlayLossText: BLACK,
  overlayWin: rgbaLiteral('#f2d98c', ADDITIVE_OVERLAY_ALPHA),
  overlayWinText: BLACK,
  focusRing: '#00355c',
  focusRingContrast: WHITE,
  diagnosticsSurface: '#08192b',
  diagnosticsText: '#e8f1f8',
  diagnosticsAccent: '#8ecae6',
});

/**
 * Builds the ramp's per-exponent list from a palette's accent list.
 *
 * The `bright` flag is not carried per palette: it comes from the shared
 * threshold of `RAMP_BRIGHT_FROM_EXPONENT`, so every theme has the same
 * bright-numeral threshold.
 *
 * @throws RangeError when `accents` is not `tileRampConstants.limit` entries
 *   long, the guard style/_themes.scss applies.
 */
export function createTileSpecialColors(
  accents: readonly (string | null)[],
): readonly TileSpecialColor[] {
  if (accents.length !== tileRampConstants.limit) {
    throw new RangeError(
      `themes: a palette must declare ${tileRampConstants.limit} accent ` +
        `entries, received ${accents.length}`,
    );
  }
  return Object.freeze(
    accents.map((accent, index) => {
      const exponent = index + tileRampConstants.exponentStart;
      return Object.freeze({
        exponent,
        value: rampValue(exponent),
        accent,
        bright: exponent >= RAMP_BRIGHT_FROM_EXPONENT,
      });
    }),
  );
}

/**
 * Projects a palette onto the `TileRampPalette` interface of
 * src/theme/tile-ramp.ts, which is the seam a themed ramp resolves through.
 *
 * Nothing about the ramp's shape is supplied here — only its colours, its
 * accent weight and its super tint — so a theme changes hues and never the
 * generative function.
 *
 * @throws RangeError when the palette's accent list is the wrong length.
 */
export function createTileRampPalette(
  palette: ThemePalette,
): TileRampPalette {
  return Object.freeze({
    lowColor: palette.tileLow,
    highColor: palette.tileHigh,
    textColor: palette.text,
    brightTextColor: palette.brightText,
    specialColors: createTileSpecialColors(palette.tileAccents),
    accentWeight: palette.tileAccentWeight,
    superTint: palette.tileSuperTint,
    superWeight: palette.tileSuperWeight,
  });
}

/** One entry of the catalogue. */
export interface Theme {
  /** Stable id, and the `data-theme` value that activates the palette. */
  readonly id: ThemeId;

  /** Human-readable name: prose, not an id. */
  readonly name: string;
  readonly description: string;
  readonly attributeValue: string;
  readonly palette: ThemePalette;

  /**
   * The palette's ramp inputs, projected once at declaration.
   * `resolveTileTheme` resolves a tile value against this.
   */
  readonly rampPalette: TileRampPalette;
}

/**
 * Assembles one catalogue entry and freezes it.
 *
 * @throws RangeError when the palette's accent list is the wrong length.
 */
function createTheme(
  id: ThemeId,
  name: string,
  description: string,
  palette: ThemePalette,
): Theme {
  return Object.freeze({
    id,
    name,
    description,
    attributeValue: themeAttributeValues[id],
    palette,
    rampPalette: createTileRampPalette(palette),
  });
}

/**
 * The palette the game has always rendered, and the derivation source for every
 * 2.5D material. Never superseded by either additive palette.
 */
export const defaultTheme: Theme = /* @__PURE__ */ createTheme(
  'default',
  'Classic',
  'The original beige-to-gold board, unchanged.',
  defaultThemePalette,
);

/** The high-contrast palette. */
export const highContrastTheme: Theme = /* @__PURE__ */ createTheme(
  'high-contrast',
  'High contrast',
  'Black-on-white interface with a grey-to-black tile ladder.',
  highContrastThemePalette,
);

/** The colourblind-safe palette. */
export const colorblindSafeTheme: Theme = /* @__PURE__ */ createTheme(
  'colorblind-safe',
  'Colourblind safe',
  'Yellow-to-blue tiles that stay distinct without hue.',
  colorblindSafeThemePalette,
);

/**
 * Every theme, in catalogue order, with the default first. A theme is added by
 * appending to this list, to `themeIds`, and to `$theme-names` of
 * style/_themes.scss.
 */
export const themes: readonly Theme[] = Object.freeze([
  defaultTheme,
  highContrastTheme,
  colorblindSafeTheme,
]);

/** The catalogue keyed by id, the lookup `getTheme` resolves through. */
const themesById: Readonly<Record<ThemeId, Theme>> = Object.freeze({
  default: defaultTheme,
  'high-contrast': highContrastTheme,
  'colorblind-safe': colorblindSafeTheme,
});

/**
 * The theme one id names.
 *
 * @returns The catalogue entry, identical between calls.
 * @throws RangeError when `id` is not one of the three ids.
 */
export function getTheme(id: ThemeId): Theme {
  const theme: Theme | undefined = themesById[id];
  if (theme === undefined) {
    throw new RangeError(
      `themes: unknown theme id \`${String(id)}\`, expected one of ` +
        `${themeIds.join(', ')}`,
    );
  }
  return theme;
}

/**
 * Resolves a theme from either form a caller holds it in: a theme, an id, or
 * `undefined` for the active theme.
 *
 * @throws RangeError when an id is not one of the three ids.
 */
function resolveTheme(theme?: Theme | ThemeId): Theme {
  if (theme === undefined) {
    return getActiveTheme();
  }
  return typeof theme === 'string' ? getTheme(theme) : theme;
}

/**
 * Themes already resolved, keyed by the theme OBJECT and then by tile value.
 *
 * Identity is the key, so a theme assembled outside the catalogue resolves
 * against its own palette even where it reuses a catalogue id, and is collected
 * together with it.
 *
 * Per catalogue theme the map is bounded by the number of distinct values a
 * board reaches and carries no eviction policy — the same bound
 * `defaultThemeCache` of src/theme/tile-ramp.ts carries.
 */
const tileThemeCaches = new WeakMap<Theme, Map<number, TileTheme>>();

/**
 * The appearance of one tile value under one theme.
 *
 * Runs `computeTileTheme` of src/theme/tile-ramp.ts against the theme's ramp
 * inputs, so every theme shares one generative implementation and the whole
 * resolved shape comes back per theme. Under the default theme the result is
 * `getTileTheme` of src/theme/tile-ramp.ts value for value.
 *
 * @returns Frozen tile theme, identical between calls for the same pair.
 * @throws RangeError when `value` is not a power of `tileRampConstants.base` at
 *   `tileRampConstants.exponentStart` or above, or when an id is unknown.
 */
export function resolveTileTheme(
  value: number,
  theme?: Theme | ThemeId,
): TileTheme {
  const resolved = resolveTheme(theme);
  let cache = tileThemeCaches.get(resolved);
  if (cache === undefined) {
    cache = new Map<number, TileTheme>();
    tileThemeCaches.set(resolved, cache);
  }
  const cached = cache.get(value);
  if (cached !== undefined) {
    return cached;
  }
  const tileTheme = computeTileTheme(value, resolved.rampPalette);
  cache.set(value, tileTheme);
  return tileTheme;
}

/**
 * The relic rarity tiers, lowest first.
 *
 * Declared locally and deliberately not imported: `$rarity-tiers` of
 * style/_tokens.scss and the `Rarity` enumeration of src/relics/relic-types.ts
 * carry the same four names in the same order. Adding a tier means adding it to
 * all three.
 */
export type RarityTier = 'common' | 'uncommon' | 'rare' | 'legendary';

/** Every tier, lowest first — the order the ramp is sampled across. */
export const rarityTiers: readonly RarityTier[] = Object.freeze([
  'common',
  'uncommon',
  'rare',
  'legendary',
] as const satisfies readonly RarityTier[]);

/**
 * Prefix of the custom property each tier's accent is published under.
 *
 * The name style/_themes.scss builds, read by the active-relic tray of
 * style/_hud.scss and the reward card and rarity chip of style/_reward.scss.
 */
export const THEME_RARITY_PROPERTY_PREFIX = '--theme-rarity-';

/**
 * Position of one tier in `rarityTiers`, the guard both exported tier functions
 * validate through.
 *
 * @throws RangeError when `tier` is not one of the four tiers.
 */
function rarityTierIndex(tier: RarityTier): number {
  const index = rarityTiers.indexOf(tier);
  if (index < 0) {
    throw new RangeError(
      `themes: unknown rarity tier \`${String(tier)}\`, expected one of ` +
        `${rarityTiers.join(', ')}`,
    );
  }
  return index;
}

/**
 * The 1-based position of one tier on the ladder.
 *
 * @throws RangeError when `tier` is not one of the four tiers.
 */
export function rarityTierOrdinal(tier: RarityTier): number {
  return rarityTierIndex(tier) + 1;
}

/**
 * The custom property one tier's accent is published under,
 * `--theme-rarity-<tier>`.
 *
 * @throws RangeError when `tier` is not one of the four tiers.
 */
export function rarityCustomProperty(tier: RarityTier): string {
  const name = rarityTiers[rarityTierIndex(tier)];
  return `${THEME_RARITY_PROPERTY_PREFIX}${name}`;
}

/**
 * Share of a palette's high anchor in one tier's accent, as a 0-1 fraction.
 *
 * The `ramp-rarity()` weight of style/_themes.scss and the
 * `reward-rarity-weight()` of style/_reward.scss: linear in the tier's ordinal,
 * so the lowest tier is the low anchor itself and the highest is the high
 * anchor itself.
 *
 * @throws RangeError when `tier` is not one of the four tiers, or when the
 *   ladder carries fewer than the two tiers a weight is interpolated across.
 */
export function rarityRampWeight(tier: RarityTier): number {
  if (rarityTiers.length < 2) {
    throw new RangeError(
      'themes: the rarity ladder needs at least two tiers to interpolate ' +
        `between a palette's anchors, received ${rarityTiers.length}`,
    );
  }
  return (rarityTierOrdinal(tier) - 1) / (rarityTiers.length - 1);
}

/** One tier's accent under one theme. */
export interface RarityColor {
  readonly tier: RarityTier;
  readonly ordinal: number;
  readonly weight: number;

  /**
   * The accent with unquantised channels, which reproduce the compiled Sass
   * output to full precision.
   */
  readonly color: RampColor;

  /** The accent as 6-digit hex, with each channel floored. */
  readonly colorHex: string;
}

/**
 * One tier's accent under one theme, sampled off the theme's own tile ramp
 * rather than picked.
 *
 * Interpolates the palette's two tile anchors across the ladder with `sassMix`
 * of src/theme/tile-ramp.ts, the same interpolation style/_themes.scss runs, so
 * a rarer relic sits further along the same progression its tiles climb.
 *
 * Rarity is not conveyed by this colour alone: the reward card and the rarity
 * chip also carry the tier as text.
 *
 * @throws RangeError when `tier` is unknown, when an id is unknown, or when an
 *   anchor is not a hex colour.
 */
export function resolveRarityColor(
  tier: RarityTier,
  theme?: Theme | ThemeId,
): RarityColor {
  const resolved = resolveTheme(theme);
  const weight = rarityRampWeight(tier);
  const color = sassMix(
    parseHexColor(resolved.palette.tileHigh),
    parseHexColor(resolved.palette.tileLow),
    weight,
  );
  return Object.freeze({
    tier,
    ordinal: rarityTierOrdinal(tier),
    weight,
    color,
    colorHex: formatHexColor(color),
  });
}

/**
 * Every tier's accent under one theme, keyed by tier.
 *
 * @throws RangeError when an id is unknown, or when an anchor is not a hex
 *   colour.
 */
export function resolveRarityColors(
  theme?: Theme | ThemeId,
): Readonly<Record<RarityTier, RarityColor>> {
  const resolved = resolveTheme(theme);
  const entries = rarityTiers.map(
    (tier) => [tier, resolveRarityColor(tier, resolved)] as const,
  );
  return Object.freeze(
    Object.fromEntries(entries) as Record<RarityTier, RarityColor>,
  );
}

/**
 * The id in force.
 *
 * Held in memory only: this module reads and writes no storage, so importing it
 * neither reads nor writes anything. A caller that persists a preference calls
 * `applyTheme` with the value it resolved.
 */
let activeThemeId: ThemeId = DEFAULT_THEME_ID;

/** Notified after the active theme changes. */
export type ThemeChangeListener = (
  theme: Theme,
  previousTheme: Theme,
) => void;

/**
 * Registered listeners.
 *
 * A set, so a listener registered twice is notified once and removing one
 * leaves the rest in place.
 */
const themeChangeListeners = new Set<ThemeChangeListener>();

/** The id in force. */
export function getActiveThemeId(): ThemeId {
  return activeThemeId;
}

/** The theme in force. */
export function getActiveTheme(): Theme {
  return getTheme(activeThemeId);
}

/**
 * Registers a listener for theme changes and returns its unsubscribe function.
 *
 * A listener is notified only when the active theme actually changes, so a
 * subscriber that also needs the theme in force at construction reads
 * `getActiveTheme()` once for itself. The returned function is idempotent.
 *
 * @throws TypeError when `listener` is not a function.
 */
export function subscribeToThemeChange(
  listener: ThemeChangeListener,
): () => void {
  if (typeof listener !== 'function') {
    throw new TypeError(
      `themes: a theme-change listener must be a function, received ` +
        `${typeof listener}`,
    );
  }
  themeChangeListeners.add(listener);
  return () => {
    themeChangeListeners.delete(listener);
  };
}

/**
 * Notifies every listener, then reports any that threw.
 *
 * Iterates a snapshot, so a listener that subscribes or unsubscribes while
 * being notified neither is skipped nor is notified twice in the same pass. A
 * listener that throws does not stop the others: every failure is collected and
 * raised together once the pass completes, so no error is discarded and none is
 * logged from here.
 *
 * @throws AggregateError when one or more listeners threw.
 */
function notifyThemeChange(theme: Theme, previousTheme: Theme): void {
  const failures: unknown[] = [];
  for (const listener of Array.from(themeChangeListeners)) {
    try {
      listener(theme, previousTheme);
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `themes: ${failures.length} theme-change listener(s) threw while ` +
        `applying \`${theme.id}\``,
    );
  }
}

/**
 * Writes the activation attribute onto the root element.
 *
 * The only DOM access in src/theme. Both the global and the element are checked
 * before use, so the module is importable where no document exists — the
 * DOM-free unit and snapshot suites — and a document without a root element is
 * a no-op rather than a throw.
 */
function writeThemeAttribute(theme: Theme): void {
  if (typeof document === 'undefined') {
    return;
  }
  const root: Element | null = document.documentElement;
  if (root === null) {
    return;
  }
  root.setAttribute(THEME_ATTRIBUTE, theme.attributeValue);
}

/**
 * Activates a theme: records it as the theme in force, writes the activation
 * attribute, and notifies every listener when the theme actually changed.
 *
 * The attribute is written on every call, including a call that does not change
 * the theme, so a first call at boot establishes it on a document that does not
 * yet carry it. This is the only place in src/theme that writes the attribute.
 *
 * @throws RangeError when `id` is not one of the three ids.
 * @throws AggregateError when one or more listeners threw. The theme is in
 *   force and the attribute is written before any listener runs, so a failing
 *   listener leaves the activation itself applied.
 */
export function applyTheme(id: ThemeId): Theme {
  const theme = getTheme(id);
  const previousTheme = getActiveTheme();
  activeThemeId = theme.id;
  writeThemeAttribute(theme);
  if (theme.id !== previousTheme.id) {
    notifyThemeChange(theme, previousTheme);
  }
  return theme;
}

/** `applyTheme` under the name the settings surface calls it by. */
export const setActiveTheme = applyTheme;
