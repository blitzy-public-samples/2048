// Contract suite for the focus ring's contrast, AAP R9 and the design-system
// gap inventory: the repository's palette is deliberately low-contrast, so the
// focus vocabulary added on top of it is the one place a contrast floor has to
// be measured rather than assumed.
//
// This suite reads no DOM, no storage and no clock, consumes no randomness,
// installs no mock library and writes no snapshot.

import { describe, expect, it } from 'vitest';

import type { Theme } from '../../../src/theme/themes';
import {
  colorblindSafeTheme,
  defaultTheme,
  highContrastTheme,
} from '../../../src/theme/themes';
import { computeTileTheme, rampValue } from '../../../src/theme/tile-ramp';
import {
  derivedColors,
  geometryScales,
  minTileNumeralSize,
  pageBackground,
  tileFontSize,
  tileNumeralCellRatio,
  tileNumeralSize,
} from '../../../src/theme/tokens';
import { MAX_BOARD_SIZE } from '../../../src/config/default-config';
import { resolveBoardGeometry } from '../../../src/render/tile-mesh-factory';

/** The WCAG 2.1 AA minimum for a non-text boundary such as a focus ring. */
const NON_TEXT_MINIMUM = 3;

/** Channel maximum of an 8-bit sRGB component. */
const CHANNEL_MAX = 255;

/** Threshold of the piecewise sRGB-to-linear transfer function. */
const TRANSFER_THRESHOLD = 0.03928;

/** Offset the contrast formula adds to both luminances. */
const CONTRAST_OFFSET = 0.05;

/**
 * Linearises one sRGB channel, WCAG 2.1 relative-luminance step 1.
 *
 * @param channel Channel on the 0-255 scale.
 * @returns The linear value, 0 to 1.
 */
function linearise(channel: number): number {
  const scaled = channel / CHANNEL_MAX;

  return scaled <= TRANSFER_THRESHOLD
    ? scaled / 12.92
    : ((scaled + 0.055) / 1.055) ** 2.4;
}

/** One colour's channels, on the 0-255 scale, with an alpha share. */
interface Channels {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/**
 * Reads a `#rrggbb`, `rgb(r, g, b)` or `rgba(r, g, b, a)` declaration.
 *
 * @param declared Declaration to read.
 * @returns Its channels.
 */
function readColor(declared: string): Channels {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(declared);

  if (hex !== null) {
    return {
      r: Number.parseInt(hex[1], 16),
      g: Number.parseInt(hex[2], 16),
      b: Number.parseInt(hex[3], 16),
      a: 1,
    };
  }

  const parts = /^rgba?\(([^)]+)\)$/i.exec(declared);

  expect(parts, `unreadable colour: ${declared}`).not.toBeNull();

  const numbers = (parts?.[1] ?? '')
    .split(/[,/\s]+/)
    .filter((entry) => entry.length > 0)
    .map(Number);

  return {
    r: numbers[0],
    g: numbers[1],
    b: numbers[2],
    a: numbers[3] ?? 1,
  };
}

/**
 * Composites a translucent colour over an opaque one.
 *
 * @param front Colour in front, whose alpha decides the share.
 * @param back Opaque colour behind it.
 * @returns The resulting opaque channels.
 */
function composite(front: Channels, back: Channels): Channels {
  const share = front.a;

  return {
    r: front.r * share + back.r * (1 - share),
    g: front.g * share + back.g * (1 - share),
    b: front.b * share + back.b * (1 - share),
    a: 1,
  };
}

/**
 * Relative luminance of an opaque colour, WCAG 2.1.
 *
 * @param color Channels to measure.
 * @returns The luminance, 0 to 1.
 */
function luminance(color: Channels): number {
  return (
    0.2126 * linearise(color.r) +
    0.7152 * linearise(color.g) +
    0.0722 * linearise(color.b)
  );
}

/**
 * Contrast ratio between two colour declarations, each composited over the
 * page background where it is translucent.
 *
 * @param left First declaration.
 * @param right Second declaration.
 * @param behind Opaque colour a translucent declaration is composited over.
 * @returns The ratio, 1 to 21.
 */
function contrast(left: string, right: string, behind: string): number {
  const base = readColor(behind);
  const first = luminance(composite(readColor(left), base));
  const second = luminance(composite(readColor(right), base));
  const high = Math.max(first, second);
  const low = Math.min(first, second);

  return (high + CONTRAST_OFFSET) / (low + CONTRAST_OFFSET);
}

/**
 * The surfaces a focusable control sits on under one theme, keyed by a label.
 *
 * @param theme Theme to read.
 * @returns The surfaces.
 */
function surfacesOf(theme: Theme): Record<string, string> {
  const palette = theme.palette;
  const surfaces: Record<string, string> = {
    'page background': palette.pageBackground,
    'board field': palette.boardField,
    'empty cell': palette.cell,
    'score surface': palette.scoreSurface,
    'button surface': palette.buttonSurface,

    // The two surfaces this feature's own screens draw controls on, which the
    // ring has to be discernible against as well. Decision DL-THEME-08.
    'control surface': palette.controlSurface,
    'readout surface': palette.readoutSurface,
    'overlay loss': palette.overlayLoss,
    'overlay win': palette.overlayWin,
    'diagnostics surface': palette.diagnosticsSurface,
  };

  for (let exponent = 1; exponent <= 11; exponent += 1) {
    const value = rampValue(exponent);

    surfaces[`ramp ${value}`] = computeTileTheme(
      value,
      theme.rampPalette,
    ).colorHex;
  }

  surfaces['above the ramp'] = computeTileTheme(
    rampValue(12),
    theme.rampPalette,
  ).colorHex;

  return surfaces;
}

/**
 * The stronger of the ring's two bands against one surface.
 *
 * @param theme Theme the bands are read from.
 * @param surface Surface behind the ring.
 * @returns The ratio the stronger band measures.
 */
function strongerBand(theme: Theme, surface: string): number {
  const behind = theme.palette.pageBackground;

  return Math.max(
    contrast(theme.palette.focusRing, surface, behind),
    contrast(theme.palette.focusRingContrast, surface, behind),
  );
}

describe.each([
  ['default', defaultTheme],
  ['high-contrast', highContrastTheme],
  ['colorblind-safe', colorblindSafeTheme],
])('the %s focus ring clears 3:1 on every surface', (_id, theme: Theme) => {
  const surfaces = surfacesOf(theme);

  it.each(Object.keys(surfaces))('against the %s', (label) => {
    expect(strongerBand(theme, surfaces[label])).toBeGreaterThanOrEqual(
      NON_TEXT_MINIMUM,
    );
  });

  it('draws two bands that are discernible from each other', () => {
    expect(
      contrast(
        theme.palette.focusRing,
        theme.palette.focusRingContrast,
        theme.palette.pageBackground,
      ),
    ).toBeGreaterThanOrEqual(NON_TEXT_MINIMUM);
  });
});

describe('the default focus ring is derived from the frozen text token', () => {
  it('takes the outer band from the derived focus-ring colour', () => {
    expect(defaultTheme.palette.focusRing).toBe(derivedColors.focusRingColor);
  });

  it('leaves the inner band on the frozen bright text token', () => {
    expect(defaultTheme.palette.focusRingContrast).toBe(
      defaultTheme.palette.brightText,
    );
  });

  it('clears the minimum on the board field, which $text-color did not', () => {
    // 2.28:1 was the measurement recorded against this surface before the
    // outer band was re-derived.
    expect(
      strongerBand(defaultTheme, defaultTheme.palette.boardField),
    ).toBeGreaterThan(NON_TEXT_MINIMUM);
    expect(
      contrast(
        defaultTheme.palette.text,
        defaultTheme.palette.boardField,
        pageBackground,
      ),
    ).toBeLessThan(NON_TEXT_MINIMUM);
  });
});

describe('a tile numeral is clamped to the cell that holds it', () => {
  it('is identical to the declared size at the four-cell board', () => {
    // The four declared sizes were authored against this edge length, so the
    // clamp must never be the binding constraint here.
    for (const scale of ['desktop', 'mobile'] as const) {
      const cell = geometryScales[scale].tileSize;

      for (const value of [2, 4, 128, 1024, 4096]) {
        expect(tileNumeralSize(value, scale, cell)).toBe(
          tileFontSize(value, scale),
        );
      }
    }
  });

  it('never exceeds the cell at any supported board size', () => {
    for (const scale of ['desktop', 'mobile'] as const) {
      for (let size = 1; size <= MAX_BOARD_SIZE; size += 1) {
        const cell = resolveBoardGeometry(size, scale).tileSize;

        for (const value of [2, 128, 1024, 4096]) {
          const numeral = tileNumeralSize(value, scale, cell);

          // At or below the declared size, and at or below the cell it is
          // drawn in — except where the floor is what keeps it legible at all.
          expect(numeral).toBeLessThanOrEqual(tileFontSize(value, scale));
          expect(numeral).toBeLessThanOrEqual(
            Math.max(cell, minTileNumeralSize),
          );
        }
      }
    }
  });

  it('shrinks the sixteen-cell desktop numeral from 55px into its cell', () => {
    const cell = resolveBoardGeometry(MAX_BOARD_SIZE, 'desktop').tileSize;

    // A ~15.31px cell must not carry the 55px base numeral.
    expect(cell).toBeLessThan(16);
    expect(tileFontSize(2, 'desktop')).toBe(55);
    expect(tileNumeralSize(2, 'desktop', cell)).toBeLessThan(cell);
  });

  it('holds the declared size where no geometry is available', () => {
    for (const unusable of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(tileNumeralSize(2, 'desktop', unusable)).toBe(
        tileFontSize(2, 'desktop'),
      );
    }
  });

  it('never draws below the legibility floor for a declared size above it', () => {
    expect(tileNumeralSize(2, 'desktop', 1)).toBe(minTileNumeralSize);
    expect(tileNumeralSize(4096, 'mobile', 1)).toBe(minTileNumeralSize);
  });

  it('mirrors the ratio the stylesheet clamps with', () => {
    // style/_tokens.scss declares $tile-numeral-cell-ratio and
    // $tile-numeral-min-size; both must be these values or the two layers
    // clamp differently.
    expect(tileNumeralCellRatio).toBeCloseTo(0.61, 5);
    expect(minTileNumeralSize).toBe(6);
    expect(tileNumeralCellRatio).toBeGreaterThanOrEqual(
      tileFontSize(2, 'mobile') / geometryScales.mobile.tileSize,
    );
    expect(tileNumeralCellRatio).toBeGreaterThanOrEqual(
      tileFontSize(2, 'desktop') / geometryScales.desktop.tileSize,
    );
  });
});
