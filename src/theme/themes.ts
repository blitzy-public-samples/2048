/**
 * The theme catalogue: the default palette that carries the existing visual
 * identity, plus the two additive accessibility palettes, plus the activation
 * contract that switches between them at runtime.
 *
 * No palette carries a per-value tile colour: a themed ramp is new INPUT to
 * `computeTileTheme` of src/theme/tile-ramp.ts, which stays the one generative
 * implementation, so all three themes share the ramp's shape and differ only
 * in hue. `resolveTileTheme` is the resolver a renderer calls.
 *
 * `applyTheme` is the only DOM access in src/theme and it is guarded, so this
 * module stays importable by the DOM-free unit and snapshot suites. The module
 * reads no storage, queries no media feature, emits no log and performs no
 * work at import time beyond freezing its own declarations.
 *
 * One traceability row of docs/TRACEABILITY_MATRIX.md apiece. THEME is one area
 * across both halves of the mirror, so these ordinals are unique across this
 * module and style/_themes.scss:
 *   TR-THEME-01  style/main.scss  the existing palette, carried as the default
 *                token block      theme
 *   TR-THEME-02  target-only row  the additive high-contrast palette
 *   TR-THEME-03  target-only row  the additive colourblind-safe palette
 *   TR-THEME-04  target-only row  `THEME_ATTRIBUTE`, `themeAttributeValues` and
 *                                 `applyTheme`
 *   TR-THEME-05  target-only row  `resolveTileTheme`, the per-theme resolver a
 *                                 renderer calls
 *   TR-THEME-06  target-only row  `subscribeToThemeChange` and `getActiveTheme`
 *   TR-THEME-11  target-only row  `ThemePalette.neutralLight`, the lighting
 *                                 white point each palette states; decision
 *                                 DL-TOKEN-07
 *
 * Decisions: DL-TOKEN-07, DL-THEME-01, DL-THEME-02, DL-THEME-03, DL-THEME-04,
 * DL-THEME-11 (docs/DECISION_LOG.md).
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
  quantiseColor,
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
 * required, so a palette is a total override and no theme falls back to
 * another theme's colour for any surface.
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
   * Whether the glow this palette states is withheld from the 2.5D materials
   * for EVERY tile value, rather than only for the values the ramp's own
   * `glowSuppressed` withholds it from.
   *
   * The glow is an ADDITIVE term over the tile's fill, so a palette whose fills
   * were chosen to carry a numeral at a stated contrast ratio has that ratio
   * lightened away by it. A palette that states its contrast states this too.
   * Read by src/render/tile-materials.ts; the flat surfaces read the fill
   * alone and are unaffected either way. Decision DL-THEME-09.
   */
  readonly tileGlowSuppressed: boolean;

  /**
   * The neutral white point of the 2.5D lighting rig, read by
   * src/render/scene.ts for the key light's origin and the fill light's sky
   * half. Every palette states `#ffffff`, so a palette becomes able to state a
   * warmer or cooler light without the renderer naming a colour of its own.
   */
  readonly neutralLight: string;

  /** Tint mixed over the high anchor for a tile above the ramp. */
  readonly tileSuperTint: string;
  readonly tileSuperWeight: number;
  readonly scoreSurface: string;
  readonly scoreLabel: string;
  readonly scoreValue: string;
  readonly scoreAddition: string;
  readonly buttonSurface: string;
  readonly buttonLabel: string;

  /**
   * Surface and label of the controls THIS FEATURE's screens render — the
   * run-start, reward, summary and game-over actions and the settings slider —
   * as distinct from `buttonSurface` and `buttonLabel`, which the retained
   * restart, retry and keep-playing buttons keep. Every palette states a pair
   * clearing 4.5:1, the default one included. Decision DL-THEME-08.
   */
  readonly controlSurface: string;
  readonly controlLabel: string;

  /**
   * Surface, caption and numeral of the readouts THIS FEATURE's screens render,
   * as distinct from `scoreSurface`, `scoreLabel` and `scoreValue`, which the
   * retained score and best-score boxes keep. Every palette states a caption
   * and a numeral clearing 4.5:1 against the surface, the default one included,
   * with the caption dimmer than the numeral. Decision DL-THEME-08.
   */
  readonly readoutSurface: string;
  readonly readoutLabel: string;
  readonly readoutValue: string;
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
 * CSS `white`, the keyword style/main.scss applies to the score numerals and
 * to the tile glow's inset highlight, in its hex spelling.
 */
const WHITE = '#ffffff';

const BLACK = '#000000';

/**
 * Alpha both additive palettes state on their two terminal overlays, where the
 * default palette states 0.5.
 */
const ADDITIVE_OVERLAY_ALPHA = 0.94;

/** Exponent from which a numeral takes the bright text colour. */
const RAMP_BRIGHT_FROM_EXPONENT = 3;

/**
 * Composes the `rgba` form style/_themes.scss produces from `rgba($hex, $a)`,
 * so a translucent palette entry is derived from its opaque colour.
 *
 * @throws RangeError when `hex` is not a hex colour, or when `alpha` is not
 *   a finite number in 0-1.
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

  // The identity palette KEEPS its glow: the emissive term of AAP contract 7 is
  // the 2.5D translation of this palette's own box-shadow, and the deliberately
  // low contrast it carries is a stated property of the design.
  tileGlowSuppressed: false,
  neutralLight: WHITE,
  tileSuperTint: defaultTileRampPalette.superTint,
  tileSuperWeight: defaultTileRampPalette.superWeight,
  scoreSurface: gameContainerBackground,
  scoreLabel: derivedColors.scoreLabelColor,
  scoreValue: WHITE,
  scoreAddition: derivedColors.scoreAdditionColor,
  buttonSurface: derivedColors.buttonBackground,
  buttonLabel: brightTextColor,

  // The accessible component pairs. Same hue as the frozen surfaces above and
  // darker, so a screen of this feature clears WCAG 2.1 AA in this palette and
  // not only under the two additive ones. DL-THEME-08.
  controlSurface: derivedColors.controlSurfaceBackground,
  controlLabel: brightTextColor,
  readoutSurface: derivedColors.readoutSurfaceBackground,
  readoutLabel: derivedColors.scoreLabelColor,
  readoutValue: WHITE,
  overlayLoss: derivedColors.overlayLossBackground,
  overlayLossText: textColor,
  overlayWin: derivedColors.overlayWinBackground,
  overlayWinText: brightTextColor,

  // The outer band is `color.adjust($text-color, $lightness: -22%)`, the same
  // derivation `diagnosticsSurface` below is written from, in place of
  // `$text-color` itself; the inner band is unchanged.
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
 * style/_themes.scss key for key. Its ramp runs from a mid-tone low anchor to
 * a near-black high anchor and declares no accent band, so every step differs
 * from its neighbours in luminance.
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

  // WITHHELD. This palette exists to raise the numeral contrast of every tile,
  // and an additive glow over a dark fill lightens the fill until that contrast
  // is gone: the five highest values fell to 4.12:1, 3.69:1, 3.32:1, 3.00:1 and
  // 2.71:1 in the 2.5D board while reading 9.00:1 to 16.29:1 on the flat one.
  tileGlowSuppressed: true,
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
  controlSurface: '#00308f',
  controlLabel: WHITE,
  readoutSurface: BLACK,
  readoutLabel: WHITE,
  readoutValue: WHITE,
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
 * default ramp accents — 3 through 6, tile values 8, 16, 32 and 64 — and
 * `null` at every other exponent.
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
 * style/_themes.scss key for key. Its page background and board field are the
 * default palette's, carried through the same two tokens.
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

  // WITHHELD, for the reason the high-contrast palette withholds it: this
  // palette's fills carry their numerals at a stated ratio, and an additive
  // glow over them removes it.
  tileGlowSuppressed: true,
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
  controlSurface: '#00355c',
  controlLabel: WHITE,
  readoutSurface: '#3f3a33',
  readoutLabel: WHITE,
  readoutValue: WHITE,
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
 * The palette the game has always rendered, and the derivation source for
 * every 2.5D material. Never superseded by either additive palette.
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
 * @throws RangeError when `value` is not a power of `tileRampConstants.base`
 *   at `tileRampConstants.exponentStart` or above, or when an id is unknown.
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
 * carry the same four names in the same order. Adding a tier means adding it
 * to all three.
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
 * Position of one tier in `rarityTiers`, the guard both exported tier
 * functions validate through.
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
 * The `ramp-rarity` weight of style/_themes.scss and the
 * `reward-rarity-weight` of style/_reward.scss: linear in the tier's ordinal,
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
 * of src/theme/tile-ramp.ts, the same interpolation style/_themes.scss runs,
 * so a rarer relic sits further along the same progression its tiles climb.
 *
 * Rarity is not conveyed by this colour alone: the reward card and the rarity
 * chip also carry the tier as text.
 *
 * @throws RangeError when `tier` is unknown, when an id is unknown, or when
 *   an anchor is not a hex colour.
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

/* --------------------------------------------------------------------------
 * The rarity vocabulary the reward CARD carries.
 *
 * The mirror of `rarity-card-lift` and `ramp-rarity-card` in style/_themes.scss,
 * which is what actually paints. Both halves derive the colour from a ratio
 * rather than declaring it, so a palette edit moves them together.
 *
 * The card's surface is the palette's own tile-super, and its rarity chip renders
 * the tier name in the tier's accent at the 13px label step. Both additive
 * palettes run their ramp down to a near-black high anchor BY DESIGN, so the top
 * tier's accent measured 1.29:1 there: the tier name was unreadable in exactly
 * the two palettes chosen for legibility. Decisions DL-THEME-11, DL-REWARD-17.
 * ------------------------------------------------------------------------ */

/** Suffix of the custom property the card variant is published under. */
export const THEME_RARITY_CARD_SUFFIX = '-card';

/** The ratio a chip label must clear: WCAG 2.1 AA for normal-size text. */
export const rarityCardContrastTarget = 4.5;

/** The search grid the lift is taken from, and its upper bound. */
export const rarityCardLiftStep = 0.05;

/** The lift past which no palette is accepted. */
export const rarityCardLiftLimit = 1;

/** Constants of WCAG 2.1's relative-luminance and contrast formulae. */
const WCAG_CHANNEL_MAX = 255;
const WCAG_TRANSFER_THRESHOLD = 0.03928;
const WCAG_TRANSFER_DIVISOR = 12.92;
const WCAG_TRANSFER_OFFSET = 0.055;
const WCAG_TRANSFER_SCALE = 1.055;
const WCAG_TRANSFER_EXPONENT = 2.4;
const WCAG_RED_COEFFICIENT = 0.2126;
const WCAG_GREEN_COEFFICIENT = 0.7152;
const WCAG_BLUE_COEFFICIENT = 0.0722;
const WCAG_CONTRAST_OFFSET = 0.05;

/**
 * One sRGB channel linearised, WCAG 2.1 relative-luminance step 1.
 *
 * @param channel Channel on the 0-255 scale `RampColor` carries.
 * @returns The linear value, 0 to 1.
 */
function lineariseChannel(channel: number): number {
  const scaled = channel / WCAG_CHANNEL_MAX;
  return scaled <= WCAG_TRANSFER_THRESHOLD
    ? scaled / WCAG_TRANSFER_DIVISOR
    : Math.pow(
        (scaled + WCAG_TRANSFER_OFFSET) / WCAG_TRANSFER_SCALE,
        WCAG_TRANSFER_EXPONENT,
      );
}

/**
 * Relative luminance of an opaque colour, WCAG 2.1.
 *
 * @param color Colour to measure.
 * @returns Its luminance, 0 to 1.
 */
export function relativeLuminance(color: RampColor): number {
  return (
    WCAG_RED_COEFFICIENT * lineariseChannel(color.r) +
    WCAG_GREEN_COEFFICIENT * lineariseChannel(color.g) +
    WCAG_BLUE_COEFFICIENT * lineariseChannel(color.b)
  );
}

/**
 * Contrast ratio between two opaque colours, WCAG 2.1. Symmetric in its
 * arguments, as the formula is.
 *
 * @param front Foreground colour.
 * @param back Background colour.
 * @returns The ratio, 1 to 21.
 */
export function contrastRatio(front: RampColor, back: RampColor): number {
  const first = relativeLuminance(front) + WCAG_CONTRAST_OFFSET;
  const second = relativeLuminance(back) + WCAG_CONTRAST_OFFSET;
  return first > second ? first / second : second / first;
}

/**
 * The card surface one palette paints, `--theme-tile-super`: the palette's super
 * tint mixed over its high anchor at the palette's own super weight, which is
 * the `tile-super` entry of style/_themes.scss.
 *
 * @param palette Palette to resolve against.
 * @returns The surface colour.
 * @throws RangeError when an anchor is not a hex colour.
 */
function resolveCardSurface(palette: ThemePalette): RampColor {
  return sassMix(
    parseHexColor(palette.tileSuperTint),
    parseHexColor(palette.tileHigh),
    palette.tileSuperWeight,
  );
}

/**
 * One tier's accent lifted a stated amount toward a palette's bright text.
 *
 * @param tier Tier to resolve.
 * @param palette Palette to resolve against.
 * @param lift Share of the bright text in the result, 0 to 1.
 * @returns The lifted accent.
 * @throws RangeError when the tier is unknown or an anchor is not a hex colour.
 */
function rarityCardAt(
  tier: RarityTier,
  palette: ThemePalette,
  lift: number,
): RampColor {
  const accent = sassMix(
    parseHexColor(palette.tileHigh),
    parseHexColor(palette.tileLow),
    rarityRampWeight(tier),
  );
  return sassMix(parseHexColor(palette.brightText), accent, lift);
}

/**
 * The lift one theme's card vocabulary takes: the smallest multiple of
 * `rarityCardLiftStep` at which EVERY tier clears `rarityCardContrastTarget`
 * against that theme's card surface.
 *
 * Uniform across the tiers of one palette rather than minimal per tier, so the
 * ladder keeps its spacing instead of collapsing the passing tiers onto the
 * failing one. The default palette takes 0: it already clears the floor, so its
 * frozen values are published unchanged.
 *
 * @param theme Theme, or its id. Defaults to the active theme.
 * @returns The lift, 0 to `rarityCardLiftLimit`.
 * @throws RangeError when an id is unknown, when an anchor is not a hex colour,
 *   or when no lift within the limit clears the floor for every tier.
 */
export function rarityCardLift(theme?: Theme | ThemeId): number {
  const resolved = resolveTheme(theme);
  const palette = resolved.palette;
  const named = resolved.id;
  const surface = resolveCardSurface(palette);
  const steps = Math.floor(rarityCardLiftLimit / rarityCardLiftStep);

  for (let step = 0; step <= steps; step += 1) {
    const lift = step * rarityCardLiftStep;
    const clears = rarityTiers.every(
      (tier) =>
        contrastRatio(rarityCardAt(tier, palette, lift), surface) >=
        rarityCardContrastTarget,
    );
    if (clears) {
      return lift;
    }
  }

  throw new RangeError(
    `themes: palette \`${named}\` cannot carry a rarity chip at ` +
      `${rarityCardContrastTarget}:1 on its own card surface at any lift up ` +
      `to ${rarityCardLiftLimit}`,
  );
}

/** One tier's card accent under one theme, with the ratio it renders at. */
export interface RarityCardColor extends RarityColor {
  /** The lift applied, shared by every tier of the palette. */
  readonly lift: number;

  /** The surface it is measured against, as 6-digit hex. */
  readonly surfaceHex: string;

  /** Its measured ratio against that surface. */
  readonly contrast: number;
}

/**
 * The custom property one tier's card accent is published under,
 * `--theme-rarity-<tier>-card`.
 *
 * @param tier Tier to name.
 * @returns The property name.
 * @throws RangeError when `tier` is not one of the four tiers.
 */
export function rarityCardCustomProperty(tier: RarityTier): string {
  return `${rarityCustomProperty(tier)}${THEME_RARITY_CARD_SUFFIX}`;
}

/**
 * One tier's accent as the reward card carries it.
 *
 * @param tier Tier to resolve.
 * @param theme Theme, or its id. Defaults to the active theme.
 * @returns The card accent, its lift and the ratio it renders at.
 * @throws RangeError when the tier is unknown, when an id is unknown, when an
 *   anchor is not a hex colour, or when no lift clears the floor.
 */
export function resolveRarityCardColor(
  tier: RarityTier,
  theme?: Theme | ThemeId,
): RarityCardColor {
  const resolved = resolveTheme(theme);
  const palette = resolved.palette;
  const lift = rarityCardLift(resolved);
  const surface = resolveCardSurface(palette);
  const color = rarityCardAt(tier, palette, lift);
  return Object.freeze({
    tier,
    ordinal: rarityTierOrdinal(tier),
    weight: rarityRampWeight(tier),
    color,
    colorHex: formatHexColor(color),
    lift,
    surfaceHex: formatHexColor(surface),
    contrast: contrastRatio(quantiseColor(color), quantiseColor(surface)),
  });
}

/**
 * Every tier's card accent under one theme, keyed by tier.
 *
 * @param theme Theme, or its id. Defaults to the active theme.
 * @returns One entry per tier.
 * @throws RangeError when an id is unknown, when an anchor is not a hex colour,
 *   or when no lift clears the floor.
 */
export function resolveRarityCardColors(
  theme?: Theme | ThemeId,
): Readonly<Record<RarityTier, RarityCardColor>> {
  const resolved = resolveTheme(theme);
  const entries = rarityTiers.map(
    (tier) => [tier, resolveRarityCardColor(tier, resolved)] as const,
  );
  return Object.freeze(
    Object.fromEntries(entries) as Record<RarityTier, RarityCardColor>,
  );
}

/** The id in force. */
let activeThemeId: ThemeId = DEFAULT_THEME_ID;

/** Notified after the active theme changes. */
export type ThemeChangeListener = (
  theme: Theme,
  previousTheme: Theme,
) => void;

/** Registered listeners. */
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
 * `getActiveTheme` once for itself. The returned function is idempotent.
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

/** Writes the activation attribute onto the root element. */
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
 * The attribute is written on every call, including a call that does not
 * change the theme, so a first call at boot establishes it on a document that
 * does not yet carry it. This is the only place in src/theme that writes the
 * attribute.
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
