/**
 * Design tokens for the TypeScript layer.
 *
 * PROVENANCE
 *   The fourteen tokens in section 1 were transposed from
 *   style/main.scss L4-L22 with their names and values unchanged; the
 *   SCSS names are kebab-case and these are their camelCase
 *   equivalents. Every other export names its own origin file and
 *   line. Numeric tokens are unitless numbers, px for lengths and ms
 *   for durations, with the unit named in each comment.
 *
 *   Where style/main.scss expresses a value as a Sass colour function,
 *   this file carries the compiled result recorded in style/main.css,
 *   the generated stylesheet this change deletes. See
 *   docs/DECISION_LOG.md for the frozen-compiled-hex decision.
 *
 * MIRROR
 *   style/_tokens.scss declares the same tokens for the stylesheet.
 *   See docs/DECISION_LOG.md for the authoritative-side decision.
 *
 * CONTENTS
 *   Declarations and pure functions only. This module imports nothing
 *   and reads no DOM. Its three module-scope calls are annotated pure
 *   for the bundler.
 *
 * The rationale, alternatives and risks behind every choice above are
 * recorded in docs/DECISION_LOG.md; this file carries provenance only.
 */

/* ==========================================================================
 * 1. Core tokens — style/main.scss L4-L22
 * ========================================================================== */

/**
 * Board edge and container width, in px.
 *
 * `$field-width`, style/main.scss L4.
 */
export const fieldWidth = 500;

/**
 * Board padding and the gap between adjacent cells, in px.
 *
 * `$grid-spacing`, style/main.scss L5.
 */
export const gridSpacing = 15;

/**
 * Cells per board row that the stylesheet lays out.
 *
 * `$grid-row-cells`, style/main.scss L6. Presentational mirror only.
 * The game rule is `boardSize` in src/config/default-config.ts and
 * engine code reads the board dimension from there, not from here.
 */
export const gridRowCells = 4;

/**
 * Rejects an argument that is not a finite number.
 *
 * Module-private guard shared by the exported pure functions below.
 */
function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(
      `tokens: ${name} must be a finite number, received ${String(value)}`,
    );
  }
}

/**
 * Tile footprint for one scale, in px.
 *
 * Reproduces the `$tile-size` expression at style/main.scss L7, which
 * the mobile block re-evaluates with its own values at L480.
 *
 * @throws RangeError when an argument is not finite, or when
 *   `rowCells` is not a positive integer.
 */
export function computeTileSize(
  scaleFieldWidth: number,
  scaleGridSpacing: number,
  rowCells: number,
): number {
  assertFinite('fieldWidth', scaleFieldWidth);
  assertFinite('gridSpacing', scaleGridSpacing);
  assertFinite('rowCells', rowCells);
  if (!Number.isInteger(rowCells) || rowCells < 1) {
    throw new RangeError(
      `tokens: rowCells must be a positive integer, received ${rowCells}`,
    );
  }
  return (
    (scaleFieldWidth - scaleGridSpacing * (rowCells + 1)) / rowCells
  );
}

/**
 * Tile footprint at the desktop scale, in px. Resolves to 106.25.
 *
 * `$tile-size`, style/main.scss L7.
 */
export const tileSize = /* @__PURE__ */ computeTileSize(
  fieldWidth,
  gridSpacing,
  gridRowCells,
);

/**
 * Corner radius of a tile, a cell, a score box and a button, in px.
 *
 * `$tile-border-radius`, style/main.scss L8.
 */
export const tileBorderRadius = 3;

/**
 * The single breakpoint, in px. Resolves to 520.
 *
 * `$mobile-threshold`, style/main.scss L10. Applied as
 * `max-width: 520px` by the `smaller()` mixin at style/main.scss L475.
 */
export const mobileThreshold = fieldWidth + 20;

/**
 * Names of the two scales the stylesheet defines: the default scale,
 * and the scale that applies at or below `mobileThreshold`.
 *
 * style/main.scss declares exactly one breakpoint, at L475.
 */
export type ScaleName = 'desktop' | 'mobile';

/**
 * Body text, links and the numerals on low-value tiles.
 *
 * `$text-color`, style/main.scss L12. Spelling follows the source,
 * which writes the hex digits in upper case here and nowhere else.
 */
export const textColor = '#776E65';

/**
 * Numerals from tile value 8 upward, and button labels.
 *
 * `$bright-text-color`, style/main.scss L13.
 */
export const brightTextColor = '#f9f6f2';

/**
 * The value-2 tile, and the base of every mixed tile colour.
 *
 * `$tile-color`, style/main.scss L15.
 */
export const tileColor = '#eee4da';

/**
 * The value-2048 tile, and the far end of the colour ramp.
 *
 * `$tile-gold-color`, style/main.scss L16.
 */
export const tileGoldColor = '#edc22e';

/**
 * Halo colour of the merge glow.
 *
 * `$tile-gold-glow-color`, style/main.scss L17, declared there as
 * `lighten($tile-gold-color, 15%)` and in style/_tokens.scss as
 * `color.adjust($tile-gold-color, $lightness: 15%)`. Compiled result
 * `rgb(243, 215, 116)`, recorded at style/main.css L352. The only
 * derived token inside the style/main.scss L4-L22 block.
 */
export const tileGoldGlowColor = '#f3d774';

/**
 * Offset between the board and the content above it, in px.
 *
 * `$game-container-margin-top`, style/main.scss L19.
 */
export const gameContainerMarginTop = 40;

/**
 * The board field, and the score and best-score boxes.
 *
 * `$game-container-background`, style/main.scss L20.
 */
export const gameContainerBackground = '#bbada0';

/**
 * Tile movement duration, and the unit the animation delays are
 * expressed in, in ms.
 *
 * `$transition-speed`, style/main.scss L22.
 */
export const transitionSpeed = 100;

/* ==========================================================================
 * 2. Literals declared outside the style/main.scss L4-L22 block
 * ========================================================================== */

/**
 * Page background behind the board.
 *
 * `background` on `html, body`, style/main.scss L28.
 */
export const pageBackground = '#faf8ef';

/**
 * Horizontal-rule colour.
 *
 * `border-bottom` on `hr`, style/main.scss L138, declared there as
 * `lighten($text-color, 40%)`. Compiled result recorded at
 * style/main.css L114.
 */
export const ruleColor = '#d8d4d0';

/* ==========================================================================
 * 3. Colours style/main.scss derives through a Sass function, carried
 *    in the compiled form recorded in style/main.css
 * ========================================================================== */

/**
 * Colours the stylesheet computes from a section 1 token.
 *
 * Each member states its own SCSS expression and the style/main.css
 * line the compiled value was read from.
 */
export const derivedColors = {
  /**
   * Primary action buttons.
   *
   * `darken($game-container-background, 20%)` in the `button` mixin,
   * style/main.scss L161. Compiled at style/main.css L186.
   */
  buttonBackground: '#8f7a66',

  /**
   * Empty board cells.
   *
   * `rgba($tile-color, .35)`, style/main.scss L279. Compiled at
   * style/main.css L223.
   */
  gridCellBackground: 'rgba(238, 228, 218, 0.35)',

  /**
   * The terminal overlay in its loss state.
   *
   * `rgba($tile-color, .5)`, style/main.scss L204. Compiled at
   * style/main.css L166.
   */
  overlayLossBackground: 'rgba(238, 228, 218, 0.5)',

  /**
   * The terminal overlay in its win state.
   *
   * `rgba($tile-gold-color, .5)`, style/main.scss L238. Compiled at
   * style/main.css L197.
   */
  overlayWinBackground: 'rgba(237, 194, 46, 0.5)',

  /**
   * The score-delta numeral that rises off the score box.
   *
   * `rgba($text-color, .9)`, style/main.scss L102, which supersedes
   * the `color: red` declaration four lines above it at L98. Compiled
   * at style/main.css L83.
   */
  scoreAdditionColor: 'rgba(119, 110, 101, 0.9)',

  /**
   * The uppercase SCORE and BEST labels.
   *
   * `color: $tile-color` on the `:after` label, style/main.scss L92.
   */
  scoreLabelColor: tileColor,
} as const;

/**
 * Corner radius of the board itself, in px. Resolves to 6.
 *
 * `$tile-border-radius * 2`, style/main.scss L189. Compiled at
 * style/main.css L153.
 */
export const boardBorderRadius = tileBorderRadius * 2;

/* ==========================================================================
 * 4. Typography — style/main.scss and style/fonts/clear-sans.css
 * ========================================================================== */

/**
 * Font stack for the whole user interface.
 *
 * `font-family` on `html, body`, style/main.scss L30. The Clear Sans
 * faces are declared in style/fonts/clear-sans.css.
 */
export const fontFamily =
  '"Clear Sans", "Helvetica Neue", Arial, sans-serif';

/**
 * Monospace stack for the diagnostics overlay.
 *
 * Mirrors `$diagnostics-font-family`, style/_tokens.scss. System faces
 * only; no web font and no binary asset is added for it.
 */
export const monospaceStack =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, ' +
  '"Liberation Mono", monospace';

/**
 * The three weights the shipped Clear Sans faces serve.
 *
 * style/fonts/clear-sans.css declares exactly three `@font-face`
 * blocks: Light at L1-L9, Regular at L11-L19 and Bold at L21-L29.
 * `regular` carries the `normal` keyword exactly as
 * style/fonts/clear-sans.css L17 writes it.
 */
export const fontWeights = {
  /** `font-weight: 200`, style/fonts/clear-sans.css L7. */
  light: 200,

  /** `font-weight: normal`, style/fonts/clear-sans.css L17. */
  regular: 'normal',

  /** `font-weight: 700`, style/fonts/clear-sans.css L27. */
  bold: 700,
} as const;

/**
 * A value that the stylesheet states once per scale, in px.
 *
 * style/main.scss declares its default value at the top level and its
 * mobile value inside the `smaller($mobile-threshold)` block at
 * L475-L549.
 */
export interface ScaledFontSize {
  /** Value above `mobileThreshold`. */
  readonly desktop: number;
  /** Value at or below `mobileThreshold`. */
  readonly mobile: number;
}

/**
 * Font sizes for the user interface, in px, at both scales.
 *
 * The mobile column comes from the `smaller($mobile-threshold)` block
 * at style/main.scss L475-L549.
 */
export const fontSizes = {
  /**
   * Root font size.
   *
   * `html, body`, style/main.scss L31 and L485.
   */
  base: { desktop: 18, mobile: 15 },

  /**
   * The 2048 wordmark.
   *
   * `h1.title`, style/main.scss L43 and L494.
   */
  title: { desktop: 80, mobile: 27 },

  /**
   * Score and best-score numerals. The mobile block does not restate
   * them, so both scales carry the desktop value.
   *
   * `$height` at style/main.scss L68, applied at L74.
   */
  scoreValue: { desktop: 25, mobile: 25 },

  /**
   * The uppercase SCORE and BEST labels. The mobile block does not
   * restate them, so both scales carry the desktop value.
   *
   * `:after` on the score boxes, style/main.scss L89-L90.
   */
  scoreLabel: { desktop: 13, mobile: 13 },

  /**
   * The You win / Game over verdict on the terminal overlay.
   *
   * `.game-message p`, style/main.scss L210-L213 and L539-L541.
   */
  overlayVerdict: { desktop: 60, mobile: 30 },
} as const satisfies Record<string, ScaledFontSize>;

/**
 * Paragraph line height, unitless.
 *
 * `line-height` on `p`, style/main.scss L120.
 */
export const paragraphLineHeight = 1.65;

/**
 * Tile numeral sizes, in px, at both scales.
 *
 * The stylesheet steps the numeral down as the value gains digits.
 * `default` is the base declaration every tile receives; the three
 * remaining steps override it. Declared across the ramp block at
 * style/main.scss L314-L415 and its mobile counterparts at L533-L535.
 */
export const tileFontSizes = {
  /**
   * Tile values below `tileFontSizeThresholds.threeDigit`.
   *
   * `.tile .tile-inner`, style/main.scss L325 and L534.
   */
  default: { desktop: 55, mobile: 35 },

  /**
   * Tile values the ramp tests as `>= 100 and < 1000` at
   * style/main.scss L385.
   *
   * style/main.scss L386 and L390.
   */
  threeDigit: { desktop: 45, mobile: 25 },

  /**
   * Tile values the ramp tests as `>= 1000` at style/main.scss L392,
   * up to and including the last generated ramp step.
   *
   * style/main.scss L393 and L396.
   */
  fourOrMoreDigit: { desktop: 35, mobile: 15 },

  /**
   * Tile values above the last generated ramp step, which the
   * stylesheet reaches through `.tile-super` at style/main.scss L405.
   *
   * style/main.scss L409 and L412.
   */
  super: { desktop: 30, mobile: 10 },
} as const satisfies Record<string, ScaledFontSize>;

/**
 * Lower bounds, in tile value, of the three numeral-size overrides.
 *
 * `threeDigit` and `fourOrMoreDigit` are the literals the ramp
 * compares against at style/main.scss L385 and L392. `super` is the
 * last value the ramp generates: `pow($base, $limit)` over `$base: 2`
 * and `$limit: 11`, style/main.scss L334-L336. A tile above it takes
 * the `.tile-super` branch at style/main.scss L405.
 */
export const tileFontSizeThresholds = {
  threeDigit: 100,
  fourOrMoreDigit: 1000,
  super: 2048,
} as const;

/**
 * Numeral size for a tile value at one scale, in px.
 *
 * Applies the same bounds, in the same order, as the ramp at
 * style/main.scss L385 and L392 and the `.tile-super` selector at
 * L405: a value above `tileFontSizeThresholds.super` takes the super
 * size, then `>= 1000` takes `fourOrMoreDigit`, then `>= 100` takes
 * `threeDigit`, and anything below that keeps the base declaration.
 *
 * @throws RangeError when `tileValue` is not a finite positive number.
 */
export function tileFontSize(
  tileValue: number,
  scale: ScaleName,
): number {
  assertFinite('tileValue', tileValue);
  if (tileValue <= 0) {
    throw new RangeError(
      `tokens: tileValue must be positive, received ${tileValue}`,
    );
  }
  if (tileValue > tileFontSizeThresholds.super) {
    return tileFontSizes.super[scale];
  }
  if (tileValue >= tileFontSizeThresholds.fourOrMoreDigit) {
    return tileFontSizes.fourOrMoreDigit[scale];
  }
  if (tileValue >= tileFontSizeThresholds.threeDigit) {
    return tileFontSizes.threeDigit[scale];
  }
  return tileFontSizes.default[scale];
}


/* ==========================================================================
 * 5. Motion — style/main.scss transition, keyframes and animation calls
 * ========================================================================== */

/**
 * The easing keywords style/main.scss uses.
 */
export type MotionEasing = 'ease' | 'ease-in' | 'ease-in-out';

/**
 * The `animation-fill-mode` values style/main.scss applies.
 */
export type MotionFillMode = 'backwards' | 'both';

/**
 * The one transition and the four keyframe animations the stylesheet
 * declares, with their timings in ms and their keyframe shapes.
 *
 * Declared at style/main.scss L50-L60, L148-L156, L329-L332,
 * L417-L427 and L434-L446, with the calls that apply them at L104,
 * L234, L430 and L450. Keyframe shapes are carried as data: `top` is
 * in px, and `opacity` and `scale` are unitless multipliers.
 */
export const motion = {
  /**
   * Tile movement, declared as a CSS transition and narrowed to
   * `transform`. It carries no fill mode.
   *
   * `transition($transition-speed ease-in-out)`, style/main.scss L329,
   * narrowed to `transition-property: transform` at L330-L332.
   */
  movement: {
    duration: transitionSpeed,
    easing: 'ease-in-out' satisfies MotionEasing,
    property: 'transform',
  },

  /**
   * The score-delta numeral rising off the score box.
   *
   * `animation(move-up 600ms ease-in)`, style/main.scss L104, with
   * `animation-fill-mode: both` at L105. Keyframes at L50-L60.
   */
  moveUp: {
    duration: 600,
    easing: 'ease-in' satisfies MotionEasing,
    delay: 0,
    fillMode: 'both' satisfies MotionFillMode,
    keyframes: {
      from: { top: 25, opacity: 1 },
      to: { top: -50, opacity: 0 },
    },
  },

  /**
   * The terminal overlay fading in. The delay is
   * `$transition-speed * 12` and resolves to 1200.
   *
   * `animation(fade-in 800ms ease $transition-speed * 12)`,
   * style/main.scss L234, with `animation-fill-mode: both` at L235.
   * Keyframes at L148-L156.
   */
  fadeIn: {
    duration: 800,
    easing: 'ease' satisfies MotionEasing,
    delay: transitionSpeed * 12,
    fillMode: 'both' satisfies MotionFillMode,
    keyframes: {
      from: { opacity: 0 },
      to: { opacity: 1 },
    },
  },

  /**
   * A newly spawned tile appearing. The `backwards` fill mode holds
   * the tile at the 0% keyframe until the delay elapses.
   *
   * `animation(appear 200ms ease $transition-speed)`,
   * style/main.scss L430, with `animation-fill-mode: backwards` at
   * L431. Keyframes at L417-L427.
   */
  appear: {
    duration: 200,
    easing: 'ease' satisfies MotionEasing,
    delay: transitionSpeed,
    fillMode: 'backwards' satisfies MotionFillMode,
    keyframes: {
      from: { opacity: 0, scale: 0 },
      to: { opacity: 1, scale: 1 },
    },
  },

  /**
   * A merged tile popping. The `backwards` fill mode holds the tile at
   * the 0% keyframe until the delay elapses. `mid` carries the 50%
   * overshoot, at `offset` through the duration.
   *
   * `animation(pop 200ms ease $transition-speed)`, style/main.scss
   * L450, with `animation-fill-mode: backwards` at L451. Keyframes at
   * L434-L446.
   */
  pop: {
    duration: 200,
    easing: 'ease' satisfies MotionEasing,
    delay: transitionSpeed,
    fillMode: 'backwards' satisfies MotionFillMode,
    keyframes: {
      from: { scale: 0 },
      mid: { offset: 0.5, scale: 1.2 },
      to: { scale: 1 },
    },
  },
} as const;

/* ==========================================================================
 * 6. Z-index ladder — style/main.scss, extended above its ceiling
 * ========================================================================== */

/**
 * The stacking ladder.
 *
 * The first six slots are the ladder style/main.scss already declares
 * and are not renumbered. `tileContainer` stays in the ladder although
 * the WebGL canvas takes over the layers `gridContainer` and
 * `tileContainer` occupy; neither number is reused.
 *
 * The last four slots are new and sit above the existing ceiling of
 * 100. They mirror `$z-index-hud`, `$z-index-screen-overlay`,
 * `$z-index-modal` and `$z-index-diagnostics` in style/_tokens.scss.
 */
export const zIndex = {
  /** `.grid-container`, style/main.scss L254. */
  gridContainer: 1,

  /** `.tile-container`, style/main.scss L288. */
  tileContainer: 2,

  /** `.tile-inner`, style/main.scss L323. */
  tileInner: 10,

  /** `.tile-merged .tile-inner`, style/main.scss L449. */
  tileMergedInner: 20,

  /** `.game-message`, style/main.scss L205. */
  gameMessage: 100,

  /** `.score-addition`, style/main.scss L103. */
  scoreAddition: 100,

  /** `$z-index-hud`, style/_tokens.scss. */
  hud: 200,

  /** `$z-index-screen-overlay`, style/_tokens.scss. */
  screenOverlay: 300,

  /** `$z-index-modal`, style/_tokens.scss. */
  modal: 400,

  /** `$z-index-diagnostics`, style/_tokens.scss. */
  diagnosticsOverlay: 500,
} as const;

/* ==========================================================================
 * 7. Geometry — style/main.scss at both scales
 * ========================================================================== */

/**
 * The lengths one scale resolves to, in px.
 *
 * style/main.scss declares the desktop lengths at L4-L8 and L19, and
 * restates the mobile lengths at L477-L482.
 */
export interface GeometryScale {
  /** Board edge and container width. */
  readonly fieldWidth: number;
  /** Board padding and the gap between adjacent cells. */
  readonly gridSpacing: number;
  /** Cells per board row. */
  readonly gridRowCells: number;
  /** Exact tile footprint. */
  readonly tileSize: number;
  /** Tile footprint rounded up, the value the tile box is laid out at. */
  readonly tileBoxSize: number;
  /** Corner radius of a tile and a cell. */
  readonly tileBorderRadius: number;
  /** Offset between the board and the content above it. */
  readonly gameContainerMarginTop: number;
}

/**
 * The lengths a scale is declared with, before `tileSize` and
 * `tileBoxSize` are derived from them.
 *
 * The five members are the declarations style/main.scss makes at
 * L4-L6, L8 and L19, and restates at L477-L479, L481 and L482.
 */
export interface GeometryScaleInput {
  readonly fieldWidth: number;
  readonly gridSpacing: number;
  readonly gridRowCells: number;
  readonly tileBorderRadius: number;
  readonly gameContainerMarginTop: number;
}

/**
 * Resolves one scale from the lengths it is declared with.
 *
 * `tileSize` follows `$tile-size` at style/main.scss L7. `tileBoxSize`
 * applies the `ceil()` that style/main.scss L293-L295 applies to the
 * tile's width, height and line height alike.
 *
 * @throws RangeError when an input is not finite, or when
 *   `gridRowCells` is not a positive integer.
 */
export function createGeometryScale(
  input: GeometryScaleInput,
): GeometryScale {
  const resolvedTileSize = computeTileSize(
    input.fieldWidth,
    input.gridSpacing,
    input.gridRowCells,
  );
  assertFinite('tileBorderRadius', input.tileBorderRadius);
  assertFinite(
    'gameContainerMarginTop',
    input.gameContainerMarginTop,
  );
  return {
    fieldWidth: input.fieldWidth,
    gridSpacing: input.gridSpacing,
    gridRowCells: input.gridRowCells,
    tileSize: resolvedTileSize,
    tileBoxSize: Math.ceil(resolvedTileSize),
    tileBorderRadius: input.tileBorderRadius,
    gameContainerMarginTop: input.gameContainerMarginTop,
  };
}

/**
 * The scale that applies above `mobileThreshold`.
 *
 * Built from the section 1 tokens, style/main.scss L4-L8 and L19.
 * Resolves `tileSize` to 106.25 and `tileBoxSize` to 107.
 */
export const desktopGeometry = /* @__PURE__ */ createGeometryScale({
  fieldWidth,
  gridSpacing,
  gridRowCells,
  tileBorderRadius,
  gameContainerMarginTop,
});

/**
 * The scale that applies at or below `mobileThreshold`.
 *
 * The `smaller($mobile-threshold)` block restates the lengths at
 * style/main.scss L477-L482. Resolves `tileSize` to 57.5 and
 * `tileBoxSize` to 58.
 */
export const mobileGeometry = /* @__PURE__ */ createGeometryScale({
  fieldWidth: 280,
  gridSpacing: 10,
  gridRowCells: 4,
  tileBorderRadius: 3,
  gameContainerMarginTop: 17,
});

/**
 * Both scales, indexable by scale name.
 *
 * style/main.scss declares exactly these two, separated by the single
 * breakpoint at L475.
 */
export const geometryScales = {
  desktop: desktopGeometry,
  mobile: mobileGeometry,
} as const satisfies Record<ScaleName, GeometryScale>;

/**
 * Offset of a cell from the board's leading edge along one axis, in
 * px.
 *
 * Reproduces the position step at style/main.scss L302-L303,
 * `floor(($tile-size + $grid-spacing) * ($x - 1))`, including its
 * `floor`. `cellIndex` is zero-based, so the stylesheet's one-based
 * `$x` maps to `cellIndex = $x - 1`. The index is not bounded above; a
 * configured board larger than `gridRowCells` resolves.
 *
 * At the desktop scale the first four indices resolve to 0, 121, 242
 * and 363; at the mobile scale to 0, 67, 135 and 202.
 *
 * @throws RangeError when `cellIndex` is not a non-negative integer.
 */
export function tilePositionStep(
  cellIndex: number,
  scale: GeometryScale,
): number {
  assertFinite('cellIndex', cellIndex);
  if (!Number.isInteger(cellIndex) || cellIndex < 0) {
    throw new RangeError(
      'tokens: cellIndex must be a non-negative integer, received ' +
        String(cellIndex),
    );
  }
  return Math.floor((scale.tileSize + scale.gridSpacing) * cellIndex);
}

/* ==========================================================================
 * 8. Depth scale — new, declared as multiples of `gridSpacing`
 * ========================================================================== */

/**
 * Extrusion depths for the WebGL board, in px, each declared as an
 * arithmetic expression on `gridSpacing`.
 *
 * Mirrors `$depth-bevel`, `$depth-board` and `$depth-tile` in
 * style/_tokens.scss. The scale carries lengths only. Camera
 * placement, field of view and light intensity are declared in
 * src/render.
 */
export const depthScale = {
  /** `$depth-bevel`, style/_tokens.scss. Resolves to 3. */
  bevel: gridSpacing / 5,

  /** `$depth-board`, style/_tokens.scss. Resolves to 15. */
  board: gridSpacing * 1,

  /** `$depth-tile`, style/_tokens.scss. Resolves to 30. */
  tile: gridSpacing * 2,
} as const;

