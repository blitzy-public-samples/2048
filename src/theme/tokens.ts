/**
 * Design tokens for the TypeScript layer, mirroring style/_tokens.scss: the
 * two files carry the same token names and the same values, so the stylesheet
 * and the Three.js materials cannot drift. Colours the stylesheet computes
 * with a Sass function are carried here in their compiled form.
 *
 * Section 9 emits `sassTokenProjection` as a Sass map; vite.config.ts passes
 * it to Dart Sass as `$blitzy-token-projection`, and style/_tokens.scss
 * resolves each of its tokens through it and raises a Sass `@error` where a
 * projected value and that file's own fallback disagree.
 *
 * One traceability row of docs/TRACEABILITY_MATRIX.md apiece. TOKEN is one area
 * across both halves of the mirror, so these ordinals continue the ones
 * style/_tokens.scss carries:
 *   TR-TOKEN-02  style/main.scss     the fourteen-token block, mirrored here
 *                token block         name for name and value for value
 *   TR-TOKEN-03  style/main.scss     `$grid-row-cells` and `$tile-size`,
 *                $grid-row-cells     mirrored as `gridRowCells` and the
 *                                    geometry scales, with the board size read
 *                                    from src/config/default-config.ts
 *   TR-TOKEN-04  style/main.scss     the mobile scale, mirrored as the second
 *                mobile block        `GeometryScale`
 *   TR-TOKEN-05  style/main.scss     the tile numeral sizes, mirrored as
 *                numeral rules       `tileNumeralSize`
 *   TR-TOKEN-06  style/helpers.scss  the Sass colour derivations, carried here
 *                                    in their compiled form as `derivedColors`
 *   TR-TOKEN-07  target-only row     `depthScale`, the extrusion depths
 *                                    expressed as arithmetic on `gridSpacing`
 *   TR-TOKEN-08  target-only row     `sassTokenProjection`, the map
 *                                    vite.config.ts passes to Dart Sass
 *   TR-TOKEN-12  target-only row     `neutralLightColor`, the neutral white
 *                                    point of the 2.5D lighting rig, the one
 *                                    token the stylesheet has no counterpart
 *                                    for
 *
 * Decisions: DL-TOKEN-02, DL-TOKEN-03, DL-TOKEN-04, DL-TOKEN-07
 * (docs/DECISION_LOG.md).
 */

import { DEFAULT_BOARD_SIZE } from '../config/default-config.ts';

/** Board edge and container width, in px. */
export const fieldWidth = 500;

/** Board padding and the gap between adjacent cells, in px. */
export const gridSpacing = 15;

/**
 * Cells per board row that the stylesheet lays out.
 *
 * Presentation of the board dimension, read from `DEFAULT_BOARD_SIZE` in
 * src/config/default-config.ts. Engine code reads the dimension from
 * `boardSize` on its `RulesConfig`; the projection in section 9 carries the
 * same value back into the stylesheet.
 */
export const gridRowCells = DEFAULT_BOARD_SIZE;

/** Rejects an argument that is not a finite number. */
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
 * @throws RangeError when an argument is not finite, or when `rowCells` is
 *   not a positive integer.
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

/** Tile footprint at the desktop scale, in px. Resolves to 106.25. */
export const tileSize = /* @__PURE__ */ computeTileSize(
  fieldWidth,
  gridSpacing,
  gridRowCells,
);

/** Corner radius of a tile, a cell, a score box and a button, in px. */
export const tileBorderRadius = 3;

/** The single breakpoint, in px. Resolves to 520. */
export const mobileThreshold = fieldWidth + 20;

/**
 * Names of the two scales the stylesheet defines: the default scale, and the
 * scale that applies at or below `mobileThreshold`, the single breakpoint.
 */
export type ScaleName = 'desktop' | 'mobile';

/** Body text, links and the numerals on low-value tiles. */
export const textColor = '#776E65';

/** Numerals from tile value 8 upward, and button labels. */
export const brightTextColor = '#f9f6f2';

/** The value-2 tile, and the base of every mixed tile colour. */
export const tileColor = '#eee4da';

/** The value-2048 tile, and the far end of the colour ramp. */
export const tileGoldColor = '#edc22e';

/** Halo colour of the merge glow. */
export const tileGoldGlowColor = '#f3d774';

/**
 * The neutral white point of the 2.5D lighting rig: the colour the key light
 * departs from before it warms toward a palette's halo, and the colour of the
 * fill light's sky half.
 *
 * The one token whose consumer is the renderer alone, and the one absent from
 * `sassTokenProjection`: the stylesheet declares no light, so this token has no
 * counterpart on the Sass side of the cross-check. It is the hex spelling of
 * the unit channel Three's own `new Color()` produces, so the lighting
 * arithmetic is unchanged by reading it from here. A palette
 * states its own value through `ThemePalette.neutralLight`, and
 * src/render/scene.ts holds this token as the fallback for an entry it cannot
 * parse. Decision DL-TOKEN-07.
 */
export const neutralLightColor = '#ffffff';

/** Offset between the board and the content above it, in px. */
export const gameContainerMarginTop = 40;

/** The board field, and the score and best-score boxes. */
export const gameContainerBackground = '#bbada0';

/**
 * Tile movement duration, and the unit the animation delays are expressed in,
 * in ms.
 */
export const transitionSpeed = 100;

/** Page background behind the board. */
export const pageBackground = '#faf8ef';

/** Horizontal-rule colour. */
export const ruleColor = '#d8d4d0';

/** Colours the stylesheet computes from a core token, in compiled form. */
export const derivedColors = {
  /** Primary action buttons. */
  buttonBackground: '#8f7a66',

  /**
   * Surface of the controls this feature's own screens render:
   * `color.adjust($game-container-background, $lightness: -26%)`.
   *
   * The retained restart, retry and keep-playing buttons keep
   * `buttonBackground` above, whose ratio against `brightTextColor` is 3.79:1 —
   * the frozen identity of AAP 0.5.2, and below the 4.5:1 floor. This surface
   * is six points darker in the same hue and clears it at 4.73:1, so a screen
   * delivered by this feature meets WCAG 2.1 AA in the DEFAULT theme rather
   * than only under the two additive palettes. Decision DL-THEME-08.
   */
  controlSurfaceBackground: '#7d6b59',

  /**
   * Surface of the readouts this feature's own screens render:
   * `color.adjust($game-container-background, $lightness: -30%)`.
   *
   * The retained score and best-score boxes keep `gameContainerBackground`,
   * against which their label measures 1.74:1 and their numeral 2.19:1. This
   * surface carries the same two foreground colours at 4.79:1 and 6.01:1, which
   * keeps the label dimmer than the numeral — the hierarchy the score boxes
   * have — while both clear the floor. Decision DL-THEME-08.
   */
  readoutSurfaceBackground: '#716051',

  /** Empty board cells. */
  gridCellBackground: 'rgba(238, 228, 218, 0.35)',

  /** The terminal overlay in its loss state. */
  overlayLossBackground: 'rgba(238, 228, 218, 0.5)',

  /** The terminal overlay in its win state. */
  overlayWinBackground: 'rgba(237, 194, 46, 0.5)',

  /** The score-delta numeral that rises off the score box. */
  scoreAdditionColor: 'rgba(119, 110, 101, 0.9)',

  /** The uppercase SCORE and BEST labels. */
  scoreLabelColor: tileColor,

  /**
   * The outer band of the focus ring under the default palette:
   * `color.adjust($text-color, $lightness: -22%)`, the same derivation
   * `$diagnostics-surface` is written from.
   */
  focusRingColor: '#3a3631',
} as const;

/** Corner radius of the board itself, in px. Resolves to 6. */
export const boardBorderRadius = tileBorderRadius * 2;

/**
 * Font stack for the whole user interface.
 *
 * The Clear Sans faces are declared in style/fonts/clear-sans.css.
 */
export const fontFamily =
  '"Clear Sans", "Helvetica Neue", Arial, sans-serif';

/**
 * Monospace stack for the diagnostics overlay.
 *
 * Mirrors `$diagnostics-font-family`, style/_tokens.scss. System faces only;
 * no web font and no binary asset is added for it.
 */
export const monospaceStack =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, ' +
  '"Liberation Mono", monospace';

/** The three weights the shipped Clear Sans faces serve. */
export const fontWeights = {
  light: 200,

  regular: 'normal',

  bold: 700,
} as const;

/** A value that the stylesheet states once per scale, in px. */
export interface ScaledFontSize {
  /** Value above `mobileThreshold`. */
  readonly desktop: number;
  /** Value at or below `mobileThreshold`. */
  readonly mobile: number;
}

/** Font sizes for the user interface, in px, at both scales. */
export const fontSizes = {
  /** Root font size. */
  base: { desktop: 18, mobile: 15 },

  /** The 2048 wordmark. */
  title: { desktop: 80, mobile: 27 },

  /**
   * Score and best-score numerals. The mobile block does not restate them, so
   * both scales carry the desktop value.
   */
  scoreValue: { desktop: 25, mobile: 25 },

  /**
   * The uppercase SCORE and BEST labels. The mobile block does not restate
   * them, so both scales carry the desktop value.
   */
  scoreLabel: { desktop: 13, mobile: 13 },

  /** The You win / Game over verdict on the terminal overlay. */
  overlayVerdict: { desktop: 60, mobile: 30 },
} as const satisfies Record<string, ScaledFontSize>;

/** Paragraph line height, unitless. */
export const paragraphLineHeight = 1.65;

/**
 * Tile numeral sizes, in px, at both scales.
 *
 * The stylesheet steps the numeral down as the value gains digits. `default`
 * is the base declaration every tile receives; the three remaining steps
 * override it.
 */
export const tileFontSizes = {
  /** Tile values below `tileFontSizeThresholds.threeDigit`. */
  default: { desktop: 55, mobile: 35 },

  threeDigit: { desktop: 45, mobile: 25 },

  fourOrMoreDigit: { desktop: 35, mobile: 15 },

  super: { desktop: 30, mobile: 10 },
} as const satisfies Record<string, ScaledFontSize>;

/** Lower bounds, in tile value, of the three numeral-size overrides. */
export const tileFontSizeThresholds = {
  threeDigit: 100,
  fourOrMoreDigit: 1000,
  super: 2048,
} as const;

/**
 * Numeral size for a tile value at one scale, in px.
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

/**
 * Fraction of a cell's edge a numeral may occupy.
 *
 * The four declared sizes were authored against the FOUR-CELL board and cell
 * size falls as the board grows — a sixteen-cell desktop cell resolves to
 * roughly 15.31px — while the declared sizes do not, so a numeral three times
 * the height of its own cell was drawn at every board size above four.
 */
export const tileNumeralCellRatio = 0.61;

/**
 * Smallest numeral this scale is willing to draw, in px.
 *
 * Below this a numeral is not legible at all, so a board size that would demand
 * it is served this instead: the cell is then smaller than its numeral, which
 * is visible and reportable rather than a numeral a fraction of a pixel high.
 */
export const minTileNumeralSize = 6;

/**
 * Numeral size for a tile value at one scale, CLAMPED to the resolved cell
 * size.
 *
 * `tileFontSize` answers what the stylesheet declares for a value; this
 * answers what fits. The two agree exactly at the four-cell board, where the
 * clamp is never the binding constraint, and diverge as the board grows.
 *
 * @param tileValue Face value the numeral is drawn for.
 * @param scale Which of the two scales to resolve at.
 * @param cellSize Resolved edge length of one cell, in px. A value that is
 *   not a finite number above zero leaves the declared size unclamped, which
 *   is the geometry-unavailable case.
 * @returns The size to draw at, in px, never above the declared size and
 *   never below `minTileNumeralSize` unless the declared size itself is below
 *   it.
 * @throws RangeError when `tileValue` is not a finite positive number.
 */
export function tileNumeralSize(
  tileValue: number,
  scale: ScaleName,
  cellSize: number,
): number {
  const declared = tileFontSize(tileValue, scale);

  if (!Number.isFinite(cellSize) || cellSize <= 0) {
    return declared;
  }

  const fitted = cellSize * tileNumeralCellRatio;

  if (fitted >= declared) {
    return declared;
  }

  return Math.max(Math.min(declared, minTileNumeralSize), fitted);
}

/** The easing keywords style/main.scss uses. */
export type MotionEasing = 'ease' | 'ease-in' | 'ease-in-out';

/** The `animation-fill-mode` values style/main.scss applies. */
export type MotionFillMode = 'backwards' | 'both';

/**
 * The one transition and the four keyframe animations the stylesheet declares,
 * with their timings in ms and their keyframe shapes.
 *
 * Keyframe shapes are carried as data: `top` is in px, and `opacity` and
 * `scale` are unitless multipliers.
 */
export const motion = {
  /**
   * Tile movement, declared as a CSS transition and narrowed to `transform`.
   * It carries no fill mode.
   */
  movement: {
    duration: transitionSpeed,
    easing: 'ease-in-out' satisfies MotionEasing,
    property: 'transform',
  },

  /** The score-delta numeral rising off the score box. */
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
   * The terminal overlay fading in. The delay is `$transition-speed * 12` and
   * resolves to 1200.
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
   * A newly spawned tile appearing. The `backwards` fill mode holds the tile
   * at the 0% keyframe until the delay elapses.
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
   * A merged tile popping. The `backwards` fill mode holds the tile at the 0%
   * keyframe until the delay elapses.
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

/**
 * The stacking ladder. The first six slots are the established ladder and are
 * not renumbered, even where the WebGL canvas takes over the layers they
 * occupy.
 */
export const zIndex = {
  gridContainer: 1,

  tileContainer: 2,

  tileInner: 10,

  tileMergedInner: 20,

  gameMessage: 100,

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

/** The lengths one scale resolves to, in px. */
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
 * The lengths a scale is declared with, before `tileSize` and `tileBoxSize`
 * are derived from them.
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
 * @throws RangeError when an input is not finite, or when `gridRowCells` is
 *   not a positive integer.
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
 * Resolves `tileSize` to 106.25 and `tileBoxSize` to 107.
 */
export const desktopGeometry = /* @__PURE__ */ createGeometryScale({
  fieldWidth,
  gridSpacing,
  gridRowCells,
  tileBorderRadius,
  gameContainerMarginTop,
});

/** Board edge and container width at the mobile scale, in px. */
export const mobileFieldWidth = 280;

/**
 * Board padding and the gap between adjacent cells at the mobile scale, in px.
 *
 * Projected into `$mobile-grid-spacing` of style/_tokens.scss, read by the
 * `smaller($mobile-threshold)` block of style/main.scss.
 */
export const mobileGridSpacing = 10;

/**
 * Offset between the board and the content above it at the mobile scale, in
 * px.
 *
 * Projected into `$mobile-game-container-margin-top` of style/_tokens.scss,
 * read by the `smaller($mobile-threshold)` block of style/main.scss.
 */
export const mobileGameContainerMarginTop = 17;

/**
 * The scale that applies at or below `mobileThreshold`.
 *
 * Resolves `tileSize` to 57.5 and `tileBoxSize` to 58.
 */
export const mobileGeometry = /* @__PURE__ */ createGeometryScale({
  fieldWidth: mobileFieldWidth,
  gridSpacing: mobileGridSpacing,
  gridRowCells,
  tileBorderRadius,
  gameContainerMarginTop: mobileGameContainerMarginTop,
});

/** Both scales, indexable by scale name; the stylesheet declares these two. */
export const geometryScales = {
  desktop: desktopGeometry,
  mobile: mobileGeometry,
} as const satisfies Record<ScaleName, GeometryScale>;

/**
 * Offset of a cell from the board's leading edge along one axis, in px.
 *
 * `cellIndex` is zero-based, and is not bounded above: a configured board
 * larger than `gridRowCells` resolves.
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

/**
 * Smallest pointer target this interface paints, in px.
 *
 * The 44px floor WCAG 2.5.5 states, held here rather than in the one sheet that
 * consumes it so the length has ONE owner like every other length in this file.
 * `style/_a11y.scss` resolves it through `$minimum-target-size` of
 * style/_tokens.scss and applies it as a minimum on the controls this feature
 * generates; the retained classic controls keep the 40px their own token gives
 * them. Decision DL-A11Y-13.
 */
export const minimumTargetSize = 44;

/**
 * Extrusion depths for the WebGL board, in px, each an arithmetic expression
 * on `gridSpacing`. Lengths only: camera and lighting values live in
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

/*
 * ===== 9. Sass projection — the build-time bridge into style/_tokens.scss
 * =====
 */

/** Name of the Sass variable the projection is delivered as. */
export const SASS_PROJECTION_VARIABLE = '$blitzy-token-projection';

/**
 * Every token style/_tokens.scss resolves through the projection, keyed by the
 * kebab-case name it looks the value up under, valued as the Sass literal that
 * name resolves to.
 *
 * Each value is written with the unit its SCSS counterpart carries: px for
 * lengths, ms for durations, bare for counts and z-index slots, and the hex
 * spelling of the corresponding colour token.
 */
export const sassTokenProjection = {
  'field-width': `${fieldWidth}px`,
  'grid-spacing': `${gridSpacing}px`,
  'grid-row-cells': `${gridRowCells}`,
  'tile-border-radius': `${tileBorderRadius}px`,
  'text-color': textColor,
  'bright-text-color': brightTextColor,
  'tile-color': tileColor,
  'tile-gold-color': tileGoldColor,
  'game-container-margin-top': `${gameContainerMarginTop}px`,
  'game-container-background': gameContainerBackground,
  'transition-speed': `${transitionSpeed}ms`,
  'mobile-field-width': `${mobileFieldWidth}px`,
  'mobile-grid-spacing': `${mobileGridSpacing}px`,
  'mobile-game-container-margin-top':
    `${mobileGameContainerMarginTop}px`,
  'z-index-hud': `${zIndex.hud}`,
  'z-index-screen-overlay': `${zIndex.screenOverlay}`,
  'z-index-modal': `${zIndex.modal}`,
  'z-index-diagnostics': `${zIndex.diagnosticsOverlay}`,
  'minimum-target-size': `${minimumTargetSize}px`,
} as const satisfies Record<string, string>;

/**
 * Renders `sassTokenProjection` as the SCSS source vite.config.ts prepends to
 * every stylesheet it compiles, through
 * `css.preprocessorOptions.scss.additionalData`.
 *
 * @returns SCSS source ending in a newline.
 */
export function emitSassTokenProjection(): string {
  const entries = Object.entries(sassTokenProjection)
    .map(([name, value]) => `  ${name}: ${value},`)
    .join('\n');
  return `${SASS_PROJECTION_VARIABLE}: (\n${entries}\n);\n`;
}
