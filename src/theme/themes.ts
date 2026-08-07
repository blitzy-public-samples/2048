/**
 * The theme catalogue: the default palette that carries the existing visual
 * identity, plus the two additive accessibility palettes, plus the activation
 * contract that switches between them at runtime.
 *
 * style/_themes.scss is this module's mirror and MUST match it. That file owns
 * the CSS half of the same contract — the `data-theme` attribute of its L219,
 * the three names of its L220, and the palette maps of its L81-L215 — and this
 * one owns the TypeScript half. `THEME_ATTRIBUTE` and `themeAttributeValues`
 * below are the exact strings its L545-L550 selects on; a palette entry here is
 * the same colour its corresponding map key carries. A difference in either
 * direction makes every theme a no-op or splits the 2D and 3D presentations
 * apart.
 *
 * Source construct to implementation, one row per palette:
 *
 * | Source                        | Palette          | Implemented by |
 * |-------------------------------|------------------|----------------|
 * | main.scss L4-L22, via tokens  | default          | section 4      |
 * | main.scss L334-L412, via ramp | default ramp     | section 4      |
 * | _themes.scss L128-L169        | high-contrast    | section 5      |
 * | _themes.scss L174-L215        | colorblind-safe  | section 6      |
 * | _themes.scss L275-L283        | rarity accents   | section 10     |
 * | _tokens.scss L155-L168        | rarity ladder    | section 10     |
 *
 * The default palette resolves every colour through src/theme/tokens.ts or
 * src/theme/tile-ramp.ts and states three values of its own, each cited at its
 * declaration. The two additive palettes are new and have no source construct;
 * they are target-only rows of the traceability matrix.
 *
 * The twelve compiled tile fills are not restated as a table in this module and
 * no palette carries a per-value colour: a themed ramp is new INPUT to
 * `computeTileTheme` of src/theme/tile-ramp.ts, which is the one generative
 * implementation, so all three themes share the ramp's shape and differ only in
 * hue. Section 9 is the resolver the renderer calls.
 *
 * `applyTheme` of section 11 is the only DOM access in src/theme, and it is
 * guarded so this module stays importable by the DOM-free unit and snapshot
 * suites. The module reads no storage, queries no media feature, emits no log
 * and performs no work at import time beyond freezing its own declarations.
 *
 * Rationale for the decisions behind this file — the two additive palettes, the
 * attribute chosen for the activation contract, the derivation the rarity
 * accents are sampled by, and the additive treatment of the default palette:
 * docs/DECISION_LOG.md, the DL-THEME decisions.
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

/* ===== 1. Theme identity and the activation contract ===== */

/**
 * The three palettes the catalogue carries, spelled as style/_themes.scss
 * `$theme-names` L220 spells them. A string-literal union whose members are the
 * attribute values verbatim, so no translation step stands between the two.
 *
 * The two rendering preferences that are NOT palettes are absent by
 * construction: reduced motion is detected and stored by src/ui/a11y and gates
 * src/render/camera-effects.ts and src/render/particles.ts, and number-only is
 * a rendering mode implemented by src/render/number-only-renderer.ts.
 */
export type ThemeId = 'default' | 'high-contrast' | 'colorblind-safe';

/**
 * Attribute that activates a palette, set on the root element.
 *
 * `$theme-attribute` of style/_themes.scss L219, whose L545-L550 emits one
 * `[data-theme="<name>"]` block per additive palette.
 */
export const THEME_ATTRIBUTE = 'data-theme';

/**
 * The attribute value each id is activated by, keyed by id.
 *
 * The value is the id verbatim. The default is listed for completeness and is
 * inert by construction: style/_themes.scss L224-L227 keys `$themes` on the two
 * additive palettes only, so `[data-theme="default"]` selects no scoped rule
 * and the unscoped cascade of its L527-L529 applies — the state its L15-L18
 * describes as the attribute being absent.
 */
export const themeAttributeValues = {
  default: 'default',
  'high-contrast': 'high-contrast',
  'colorblind-safe': 'colorblind-safe',
} as const satisfies Record<ThemeId, string>;

/** The id in force before anything is applied, and after a reset. */
export const DEFAULT_THEME_ID: ThemeId = 'default';

/**
 * Every id, in catalogue order, with the default first.
 *
 * The order `$theme-names` of style/_themes.scss L220 lists, and the order the
 * accessibility settings surface presents the options in.
 */
export const themeIds: readonly ThemeId[] = Object.freeze([
  'default',
  'high-contrast',
  'colorblind-safe',
] as const satisfies readonly ThemeId[]);

/**
 * Narrows an unknown value to a `ThemeId`.
 *
 * The guard a persisted or user-supplied preference is read through, so an
 * unrecognised value is rejected rather than applied.
 *
 * @param value Candidate id.
 * @returns Whether `value` is one of the three ids.
 */
export function isThemeId(value: unknown): value is ThemeId {
  return (
    typeof value === 'string' &&
    (themeIds as readonly string[]).includes(value)
  );
}

/* ===== 2. The palette shape ===== */

/**
 * Every colour one palette states, and the ramp inputs it generates its tile
 * fills from.
 *
 * The key set mirrors the three Sass maps of style/_themes.scss L81-L215 one
 * key at a time, less its `name` key, which is carried by `Theme.id`. Every
 * field is required, so a palette is a total override and no theme falls back
 * to another theme's colour for any surface.
 *
 * Colours are CSS colour strings. A field the ramp consumes — `tileLow`,
 * `tileHigh`, `tileAccents`, `text`, `brightText` and `tileSuperTint` — must be
 * a 3- or 6-digit hex colour, the form `parseHexColor` of
 * src/theme/tile-ramp.ts reads. Every other field may carry any CSS colour, and
 * the five translucent surfaces carry `rgba()`.
 */
export interface ThemePalette {
  /** Page background behind the board. `page-background`. */
  readonly pageBackground: string;

  /** Body text, links, and the numerals below the bright threshold. `text`. */
  readonly text: string;

  /** Numerals at and above the bright threshold, and button labels. */
  readonly brightText: string;

  /** Horizontal-rule colour. `rule`. */
  readonly rule: string;

  /** The board field the tiles sit on. `board-field`. */
  readonly boardField: string;

  /** An empty board cell. `cell`. */
  readonly cell: string;

  /** Low anchor of the tile interpolation, the value-2 fill. `tile-low`. */
  readonly tileLow: string;

  /** High anchor, the fill of the ramp's last value. `tile-high`. */
  readonly tileHigh: string;

  /**
   * One accent per ramp exponent, in exponent order, `null` where the exponent
   * takes none. Its length must equal `tileRampConstants.limit`, the guard
   * style/_themes.scss L288-L291 applies to `tile-accents`.
   */
  readonly tileAccents: readonly (string | null)[];

  /** Share of an accent in the overlay mix, as a 0-1 fraction. */
  readonly tileAccentWeight: number;

  /** Halo colour of the merge glow. `tile-glow`. */
  readonly tileGlow: string;

  /** Inset highlight of the merge glow. `tile-glow-inset`. */
  readonly tileGlowInset: string;

  /**
   * Tint mixed over the high anchor for a tile above the ramp. With
   * `tileSuperTint` it replaces the resolved `tile-super` key of
   * style/_themes.scss: the fill is derived by section 9 rather than stated,
   * so it cannot disagree with the ramp that produces every other fill.
   */
  readonly tileSuperTint: string;

  /** Share of `tileSuperTint` in that mix, as a 0-1 fraction. */
  readonly tileSuperWeight: number;

  /** The score and best-score boxes. `score-surface`. */
  readonly scoreSurface: string;

  /** The uppercase SCORE and BEST labels. `score-label`. */
  readonly scoreLabel: string;

  /** The score and best-score numerals. `score-value`. */
  readonly scoreValue: string;

  /** The score-delta numeral that rises off the score box. */
  readonly scoreAddition: string;

  /** Primary action buttons. `button-surface`. */
  readonly buttonSurface: string;

  /** Labels on primary action buttons. `button-label`. */
  readonly buttonLabel: string;

  /** The terminal overlay in its loss state. `overlay-loss`. */
  readonly overlayLoss: string;

  /** Text on the loss overlay. `overlay-loss-text`. */
  readonly overlayLossText: string;

  /** The terminal overlay in its win state. `overlay-win`. */
  readonly overlayWin: string;

  /** Text on the win overlay. `overlay-win-text`. */
  readonly overlayWinText: string;

  /**
   * The focus ring. Read as `--theme-focus-ring` by style/_a11y.scss, which
   * owns the focus rules themselves.
   */
  readonly focusRing: string;

  /** The contrasting inner edge of the focus ring, for a dark surface. */
  readonly focusRingContrast: string;

  /** Surface of the diagnostics overlay. `diagnostics-surface`. */
  readonly diagnosticsSurface: string;

  /** Text of the diagnostics overlay. `diagnostics-text`. */
  readonly diagnosticsText: string;

  /** Accent of the diagnostics overlay. `diagnostics-accent`. */
  readonly diagnosticsAccent: string;
}

/* ===== 3. Values shared across the palettes ===== */

/**
 * CSS `white`, the keyword style/main.scss applies to the score numerals at
 * L103 and to the tile glow's inset highlight at L568, in its hex spelling.
 */
const WHITE = '#ffffff';

/**
 * CSS `black`. New; used by both additive palettes as a text or fill
 * anchor.
 */
const BLACK = '#000000';

/**
 * Alpha both additive palettes state on their two terminal overlays, where the
 * default palette states 0.5. New; additive palette per AAP 0.5.5.
 */
const ADDITIVE_OVERLAY_ALPHA = 0.94;

/**
 * Exponent from which a numeral takes the bright text colour.
 *
 * `$ramp-bright-from` of style/_themes.scss L36. Applied by section 7 to every
 * palette, and it reproduces the `bright` flag of `tileSpecialColors` of
 * src/theme/tile-ramp.ts exactly, so values 2 and 4 take the text colour and
 * every value from 8 up takes the bright one.
 */
const RAMP_BRIGHT_FROM_EXPONENT = 3;

/**
 * Composes the `rgba()` form style/_themes.scss produces from `rgba($hex, $a)`,
 * so a translucent palette entry is derived from its opaque colour.
 *
 * @param hex A 3- or 6-digit hex colour, with the leading `#`.
 * @param alpha Alpha as a 0-1 fraction.
 * @returns The colour as `rgba(r, g, b, a)`, with integer channels.
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

/* ===== 4. The default palette ===== */

/**
 * The accents of the default ramp, read off `tileSpecialColors` of
 * src/theme/tile-ramp.ts rather than restated, so this list and the ported
 * `$special-colors` list of style/main.scss L529-L539 cannot diverge.
 *
 * Resolves to the four accents of exponents 3 through 6 — tile values 8, 16, 32
 * and 64 — and `null` at every other exponent, which is
 * `$ramp-default-accents` of style/_themes.scss L61-L64.
 */
const defaultTileAccents: readonly (string | null)[] = Object.freeze(
  tileSpecialColors.map((entry) => entry.accent),
);

/**
 * The palette the stylesheet already compiles, unchanged.
 *
 * `$palette-default` of style/_themes.scss L81-L123. Every entry resolves to a
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

  // style/main.scss L568, the `white` of the glow's inset ring.
  tileGlowInset: WHITE,

  tileSuperTint: defaultTileRampPalette.superTint,
  tileSuperWeight: defaultTileRampPalette.superWeight,

  scoreSurface: gameContainerBackground,
  scoreLabel: derivedColors.scoreLabelColor,

  // style/main.scss L103, the `white` of the score numerals.
  scoreValue: WHITE,

  scoreAddition: derivedColors.scoreAdditionColor,

  buttonSurface: derivedColors.buttonBackground,
  buttonLabel: brightTextColor,

  overlayLoss: derivedColors.overlayLossBackground,
  overlayLossText: textColor,
  overlayWin: derivedColors.overlayWinBackground,
  overlayWinText: brightTextColor,

  // BLITZY [A11Y]: the two bands of the focus ring that style/_a11y.scss draws
  // resolve to these two frozen text tokens, as style/_themes.scss L117-L118
  // states them. Against the board field, an empty cell, a score box, the win
  // overlay and the two highest ramp fills, the stronger of the two bands
  // reaches only 2.28:1 to 2.94:1, below the WCAG AA 3:1 recommendation for a
  // non-text boundary. Implemented as stated; flagged for designer review.
  focusRing: textColor,
  focusRingContrast: brightTextColor,

  // `color.adjust($text-color, $lightness: -22%)` of style/_themes.scss L120,
  // in its compiled form.
  diagnosticsSurface: '#3a3631',

  diagnosticsText: brightTextColor,
  diagnosticsAccent: tileGoldColor,
});

/* ===== 5. The high-contrast palette ===== */

/**
 * The accent list of the high-contrast ramp: no accent at any exponent, so its
 * fills are the interpolation between its two anchors at every step and its
 * glow is emitted at every step.
 *
 * `tile-accents` of style/_themes.scss L141-L144.
 */
const highContrastTileAccents: readonly (string | null)[] = Object.freeze(
  tileSpecialColors.map(() => null),
);

/**
 * The high-contrast palette. New; additive palette per AAP 0.5.5, decision
 * DL-THEME-01.
 *
 * `$palette-high-contrast` of style/_themes.scss L128-L169, mirrored key for
 * key. Its ramp runs from a mid-tone low anchor to a near-black high anchor and
 * declares no accent band, so every step differs from its neighbours in
 * luminance.
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

/* ===== 6. The colourblind-safe palette ===== */

/**
 * The accent list of the colourblind-safe ramp, at the same four exponents the
 * default ramp accents — 3 through 6, tile values 8, 16, 32 and 64 — and `null`
 * at every other exponent.
 *
 * `tile-accents` of style/_themes.scss L187-L190.
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
 * The colourblind-safe palette. New; additive palette per AAP 0.5.5, decision
 * DL-THEME-02.
 *
 * `$palette-colorblind-safe` of style/_themes.scss L174-L215, mirrored key for
 * key. Its anchors and its four accents are drawn from the Okabe-Ito colour set
 * and sit on a monotonic luminance ladder, so the ramp separates by
 * lightness as well as by hue and its axis runs yellow to blue rather than
 * orange to red.
 * Its page background and board field are the default palette's, carried
 * through the same two tokens.
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

/* ===== 7. Projection into the ramp's palette interface ===== */

/**
 * Builds the ramp's per-exponent list from a palette's accent list.
 *
 * The `bright` flag is not carried per palette: it comes from the shared
 * threshold of `RAMP_BRIGHT_FROM_EXPONENT`, which is the `ramp-numeral()`
 * comparison of style/_themes.scss L321-L326. Applying it here is what gives
 * every theme the same bright-numeral threshold for free.
 *
 * @param accents One accent per exponent, in exponent order, `null` for none.
 * @returns Frozen list of `tileRampConstants.limit` entries, in exponent order.
 * @throws RangeError when `accents` is not `tileRampConstants.limit` entries
 *   long, the guard style/_themes.scss L288-L291 applies.
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
 * @param palette Palette whose ramp inputs are projected.
 * @returns Frozen ramp palette.
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

/* ===== 8. The catalogue ===== */

/** One entry of the catalogue. */
export interface Theme {
  /** Stable id, and the `data-theme` value that activates the palette. */
  readonly id: ThemeId;

  /**
   * Human-readable name. Rendered as the option label by the accessibility
   * settings surface and spoken by the live-region announcer, so it is prose
   * and not an id.
   */
  readonly name: string;

  /** One-sentence description, rendered beside the option label. */
  readonly description: string;

  /** The value written to `THEME_ATTRIBUTE` when this theme is applied. */
  readonly attributeValue: string;

  /** Every colour the theme states. */
  readonly palette: ThemePalette;

  /**
   * The palette's ramp inputs, projected once at declaration. Section 9
   * resolves a tile value against this.
   */
  readonly rampPalette: TileRampPalette;
}

/**
 * Assembles one catalogue entry and freezes it.
 *
 * @param id Theme id.
 * @param name Human-readable name.
 * @param description One-sentence description.
 * @param palette The theme's colours.
 * @returns Frozen theme.
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
 * Every theme, in the order the settings surface presents them, with the
 * default first.
 *
 * The list is the surface's only source of options, so a theme is added by
 * appending to it and to `themeIds` and to `$theme-names` of
 * style/_themes.scss L220.
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
 * @param id Theme id.
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
 * Resolves a theme from either form a caller holds it in.
 *
 * @param theme A theme, an id, or `undefined` for the active theme.
 * @returns The catalogue entry.
 * @throws RangeError when an id is not one of the three ids.
 */
function resolveTheme(theme?: Theme | ThemeId): Theme {
  if (theme === undefined) {
    return getActiveTheme();
  }
  return typeof theme === 'string' ? getTheme(theme) : theme;
}

/* ===== 9. Per-theme ramp resolution ===== */

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
 * resolved shape — the interpolated base, the accent overlay, the numeral
 * colour, the two glow alphas, the suppression flag and both numeral sizes —
 * comes back per theme. src/render/tile-materials.ts maps that shape onto a
 * material: `color` is the material colour, `glowOpacity` the emissive
 * intensity, `glowSuppressed` the flat non-emissive band, and `isSuper` the
 * fill above the ramp.
 *
 * Under the default theme the result is `getTileTheme` of
 * src/theme/tile-ramp.ts value for value.
 *
 * @param value Tile value; a power of `tileRampConstants.base` at
 *   `tileRampConstants.exponentStart` or above.
 * @param theme A theme, an id, or omitted for the active theme.
 * @returns Frozen tile theme, identical between calls for the same pair.
 * @throws RangeError when `value` is not such a power, or when an id is
 *   unknown.
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

/* ===== 10. The rarity ladder ===== */

/**
 * The relic rarity tiers, lowest first.
 *
 * Declared locally and deliberately not imported: `$rarity-tiers` of
 * style/_tokens.scss L155-L168 names the same four tiers and records that they
 * are the members of the `Rarity` enumeration of src/relics/relic-types.ts,
 * which is generated after this module. The three declarations carry the same
 * four names in the same order; adding a tier means adding it to all three.
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
 * The name style/_themes.scss L412-L417 builds, read by the two surfaces that
 * present a relic's rarity: the active-relic tray of style/_hud.scss and the
 * reward card and rarity chip of style/_reward.scss.
 */
export const THEME_RARITY_PROPERTY_PREFIX = '--theme-rarity-';

/**
 * Position of one tier in `rarityTiers`.
 *
 * Module-private guard shared by the two exported tier functions below, so a
 * tier is validated in one place.
 *
 * @param tier Rarity tier.
 * @returns Zero-based index into `rarityTiers`.
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
 * @param tier Rarity tier.
 * @returns Position from 1 through `rarityTiers.length`.
 * @throws RangeError when `tier` is not one of the four tiers.
 */
export function rarityTierOrdinal(tier: RarityTier): number {
  return rarityTierIndex(tier) + 1;
}

/**
 * The custom property one tier's accent is published under.
 *
 * @param tier Rarity tier.
 * @returns The property name, `--theme-rarity-<tier>`.
 * @throws RangeError when `tier` is not one of the four tiers.
 */
export function rarityCustomProperty(tier: RarityTier): string {
  const name = rarityTiers[rarityTierIndex(tier)];
  return `${THEME_RARITY_PROPERTY_PREFIX}${name}`;
}

/**
 * Share of a palette's high anchor in one tier's accent, as a 0-1 fraction.
 *
 * The `ramp-rarity()` weight of style/_themes.scss L275-L283 and the
 * `reward-rarity-weight()` of style/_reward.scss L100-L109: linear in the
 * tier's ordinal, so the lowest tier is the low anchor itself and the
 * highest is the high anchor itself.
 *
 * @param tier Rarity tier.
 * @returns Fraction in 0-1.
 * @throws RangeError when `tier` is not one of the four tiers, or when the
 *   ladder carries fewer than the two tiers an interpolation needs.
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
  /** Tier this accent was resolved for. */
  readonly tier: RarityTier;

  /** The tier's 1-based position on the ladder. */
  readonly ordinal: number;

  /** Share of the palette's high anchor, as a 0-1 fraction. */
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
 * of src/theme/tile-ramp.ts, which is the interpolation style/_themes.scss
 * L275-L283 runs, so a rarer relic sits further along the same progression its
 * tiles climb and a themed run gets that theme's own rarity accents.
 *
 * Rarity is not conveyed by this colour alone: the reward card and the rarity
 * chip also carry the tier as text.
 *
 * @param tier Rarity tier.
 * @param theme A theme, an id, or omitted for the active theme.
 * @returns Frozen accent for that pair.
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
 * @param theme A theme, an id, or omitted for the active theme.
 * @returns Frozen record covering every tier on the ladder.
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

/* ===== 11. Activation and change notification ===== */

/**
 * The id in force.
 *
 * Held in memory only. The player's stored preference is read and written by
 * src/storage and src/ui/a11y, which call `applyTheme` with the value they
 * resolved; this module reads no storage of its own, so importing it neither
 * reads nor writes anything.
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
 * src/render/tile-materials.ts subscribes to rebuild its materials against the
 * new palette, and the live region of src/ui/a11y announces the change. A
 * listener is notified only when the active theme actually changes, so a
 * subscriber that also needs the theme in force at construction reads
 * `getActiveTheme()` once for itself.
 *
 * The returned function is idempotent.
 *
 * @param listener Callback invoked with the new theme and the previous one.
 * @returns Function that removes `listener`.
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
 * @param theme The theme now in force.
 * @param previousTheme The theme that was in force.
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
 *
 * @param theme Theme whose attribute value is written.
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
 * yet carry it. This is the call the composition root makes at boot, and it is
 * the only place in src/theme that writes the attribute.
 *
 * @param id Theme id to activate.
 * @returns The theme now in force.
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
