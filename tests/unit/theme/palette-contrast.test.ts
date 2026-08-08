// Contract suite for the contrast of the four text/surface pairs a code review
// measured below WCAG 2.1 AA, across all three palettes.
//
// EXTERNAL CONSTRAINT — THE DEFAULT PALETTE IS FROZEN AND IS NOT RAISED HERE
//
// AAP 0.5.5 records the palette as low-contrast by design and rules that the
// high-contrast and colourblind palettes are additional themes and never
// replacements of the default; AAP 0.5.6 requires the frozen palette, ramp and
// motion vocabulary be preserved as the default theme. Decision DL-THEME-05.
//
// All four pairs resolve entirely through the fourteen frozen tokens of AAP
// 0.5.2, whose values that section requires be kept:
//
//   button label   $bright-text-color on darken($game-container-background, 20%)
//   score label    $tile-color        on $game-container-background
//   score value    white              on $game-container-background
//   tile-8 numeral $bright-text-color on the generated ramp fill for value 8
//
// The last of those is additionally constrained: AAP 0.5.3 forbids
// hand-authoring the ramp and requires the TypeScript ramp to reproduce the
// stylesheet's generative function exactly, so tile-8's fill is not moved here.
// Decision DL-RAMP-01.
//
// WHAT THIS SUITE ASSERTS
//   1  the default palette's measured ratios, recorded as facts;
//   2  that both additive palettes clear AA on all four pairs.
//
// Reachability of those palettes is asserted against the settings surface, in
// tests/unit/ui/settings-panel.test.ts and tests/unit/ui/composition-input.test.ts.
// The ratio is computed here from WCAG 2.1's own formula and is not imported.
//
// This suite reads no DOM, no storage and no clock, consumes no randomness,
// installs no mock library and writes no snapshot.

import { describe, expect, it } from 'vitest';

import type { Theme } from '../../../src/theme/themes';
import {
  colorblindSafeTheme,
  defaultTheme,
  highContrastTheme,
  resolveTileTheme,
} from '../../../src/theme/themes';

/** The WCAG 2.1 AA minimum for normal-size text. */
const TEXT_MINIMUM = 4.5;

/**
 * The WCAG 2.1 AA minimum for large text.
 *
 * The tile numeral qualifies: AAP 0.5.2 records the desktop tile numerals
 * stepping 55 / 45 / 35 / 30px by digit count, every step of which is at or
 * above the 24px large-text threshold.
 */
const LARGE_TEXT_MINIMUM = 3;

/** The tile value whose numeral the review measured. */
const MEASURED_TILE = 8;

/** Channel maximum of an 8-bit sRGB component. */
const CHANNEL_MAX = 255;

/** Threshold of the piecewise sRGB-to-linear transfer function. */
const TRANSFER_THRESHOLD = 0.03928;

/** Offset the contrast formula adds to both luminances. */
const CONTRAST_OFFSET = 0.05;

/** Radix of a hexadecimal colour component. */
const HEX_RADIX = 16;

/** Length of a shorthand hexadecimal colour, without its hash. */
const SHORTHAND_LENGTH = 3;

const RED_COEFFICIENT = 0.2126;

const GREEN_COEFFICIENT = 0.7152;

const BLUE_COEFFICIENT = 0.0722;

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
    : Math.pow((scaled + 0.055) / 1.055, 2.4);
}

/**
 * Reads a hexadecimal colour into its three channels.
 *
 * Shorthand and longhand both, because the palettes state some anchors in three
 * digits and some in six.
 *
 * @param declared Colour as the palette declares it.
 * @returns The three channels, 0 to 255.
 */
function readColor(declared: string): readonly [number, number, number] {
  const digits = declared.trim().replace('#', '');
  const full =
    digits.length === SHORTHAND_LENGTH
      ? digits
          .split('')
          .map((digit) => `${digit}${digit}`)
          .join('')
      : digits;

  return [
    Number.parseInt(full.slice(0, 2), HEX_RADIX),
    Number.parseInt(full.slice(2, 4), HEX_RADIX),
    Number.parseInt(full.slice(4, 6), HEX_RADIX),
  ];
}

/**
 * Relative luminance of a colour, WCAG 2.1.
 *
 * @param declared Colour to measure.
 * @returns The luminance, 0 to 1.
 */
function luminance(declared: string): number {
  const [red, green, blue] = readColor(declared);

  return (
    RED_COEFFICIENT * linearise(red) +
    GREEN_COEFFICIENT * linearise(green) +
    BLUE_COEFFICIENT * linearise(blue)
  );
}

/**
 * Contrast ratio between two opaque colours, WCAG 2.1.
 *
 * @param front Foreground colour.
 * @param back Background colour.
 * @returns The ratio, 1 to 21.
 */
function contrast(front: string, back: string): number {
  const first = luminance(front);
  const second = luminance(back);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);

  return (lighter + CONTRAST_OFFSET) / (darker + CONTRAST_OFFSET);
}

/** One measured pair: what it is, the two colours, and the floor it must clear. */
interface Pair {
  readonly name: string;
  readonly front: string;
  readonly back: string;
  readonly minimum: number;
}

/**
 * The four pairs the review measured, resolved against one theme.
 *
 * The tile pair is resolved through `resolveTileTheme` rather than written down,
 * so it reads the theme's own generated ramp and cannot drift from it.
 *
 * @param theme Theme to resolve against.
 * @returns The four pairs.
 */
function measuredPairs(theme: Theme): readonly Pair[] {
  const palette = theme.palette;
  const tile = resolveTileTheme(MEASURED_TILE, theme);

  return [
    {
      name: 'button label on button surface',
      front: palette.buttonLabel,
      back: palette.buttonSurface,
      minimum: TEXT_MINIMUM,
    },
    {
      name: 'score label on score surface',
      front: palette.scoreLabel,
      back: palette.scoreSurface,
      minimum: TEXT_MINIMUM,
    },
    {
      name: 'score value on score surface',
      front: palette.scoreValue,
      back: palette.scoreSurface,
      minimum: TEXT_MINIMUM,
    },
    {
      name: `tile-${MEASURED_TILE} numeral on its fill`,
      front: tile.numeralColor,
      back: tile.colorHex,
      minimum: LARGE_TEXT_MINIMUM,
    },
  ];
}

/* ==========================================================================
 * 1. The formula itself
 * ========================================================================== */

describe('the contrast formula', () => {
  it('measures the two extremes WCAG 2.1 fixes', () => {
    // Black on white is 21:1 and a colour on itself is 1:1. Without these the
    // rest of the suite could agree with a wrong implementation.
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#bbada0', '#bbada0')).toBeCloseTo(1, 5);
  });

  it('reads shorthand and longhand alike', () => {
    expect(contrast('#fff', '#000000')).toBeCloseTo(21, 5);
  });

  it('is symmetric in its arguments', () => {
    expect(contrast('#f9f6f2', '#8f7a66')).toBeCloseTo(
      contrast('#8f7a66', '#f9f6f2'),
      10,
    );
  });
});

/* ==========================================================================
 * 2. The default palette: the shortfall, recorded
 * ========================================================================== */

describe('the default palette carries the frozen identity, not AA', () => {
  it('measures the four pairs at the ratios the review reported', () => {
    const measured = new Map(
      measuredPairs(defaultTheme).map((pair) => [
        pair.name,
        contrast(pair.front, pair.back),
      ]),
    );

    // Recorded to two decimals as FACTS about the shipped default, so the
    // shortfall lives in the codebase rather than only in a review that will be
    // archived. A change to any frozen token fails this and has to be argued
    // for, which is the protection the freeze actually needs.
    expect(measured.get('button label on button surface')).toBeCloseTo(3.79, 2);
    expect(measured.get('score label on score surface')).toBeCloseTo(1.74, 2);
    expect(measured.get('score value on score surface')).toBeCloseTo(2.19, 2);
    expect(measured.get('tile-8 numeral on its fill')).toBeCloseTo(1.72, 2);
  });

  it('keeps the exact token values AAP 0.5.2 froze', () => {
    const palette = defaultTheme.palette;

    // The four pairs resolve entirely through these, which is why raising them
    // is a palette replacement rather than a contrast fix.
    expect(palette.buttonLabel).toBe('#f9f6f2');
    expect(palette.buttonSurface).toBe('#8f7a66');
    expect(palette.scoreSurface).toBe('#bbada0');
    expect(palette.scoreLabel).toBe('#eee4da');
    expect(resolveTileTheme(MEASURED_TILE, defaultTheme).colorHex).toBe(
      '#f2b179',
    );
  });
});

/* ==========================================================================
 * 3. The alternative palettes: AA, and it must stay that way
 * ========================================================================== */

describe.each([
  ['high contrast', highContrastTheme],
  ['colourblind safe', colorblindSafeTheme],
])('the %s palette clears AA where the default does not', (_name, theme) => {
  it.each(measuredPairs(theme).map((pair) => [pair.name, pair]))(
    'clears its floor for %s',
    (_pairName, pair) => {
      // The whole accessibility position rests on these passing. If an
      // alternative palette regressed below AA the product would offer a user
      // no compliant option at all, and the default's frozen shortfall would
      // stop being a documented trade-off and become a plain barrier.
      expect(contrast(pair.front, pair.back)).toBeGreaterThanOrEqual(
        pair.minimum,
      );
    },
  );

  it('is a different palette from the default, not a relabelling of it', () => {
    expect(theme.palette.scoreSurface).not.toBe(
      defaultTheme.palette.scoreSurface,
    );
    expect(theme.id).not.toBe(defaultTheme.id);
  });
});

/* ==========================================================================
 * 4. Additive, never a replacement
 * ========================================================================== */

describe('the alternatives are additive', () => {
  it('leaves the default palette reachable and unchanged alongside them', () => {
    // AAP 0.5.5: additional themes, never replacements. A build that shipped
    // only compliant palettes would satisfy WCAG and violate the plan.
    expect(defaultTheme.id).toBe('default');
    expect(defaultTheme.palette.scoreSurface).toBe('#bbada0');
    expect(highContrastTheme.id).toBe('high-contrast');
    expect(colorblindSafeTheme.id).toBe('colorblind-safe');
  });
});

/* ==========================================================================
 * 5. The settings surface, measured in the browser
 * ==========================================================================
 *
 * A later review reported the settings panel rendering `#776e65` on `#faf8ef` at
 * approximately 4.04:1, below the 4.5 floor. The pair is real — the panel's
 * reading surface is `pageBackground` and its body text is `text` — but the
 * ratio is not: measured in a real browser over the composited ancestor stack,
 * and re-derived by the formula at the top of this file, it is 4.6966:1, which
 * CLEARS the floor. The ~4.0 figure is what `#776e65` measures against the
 * scrim colour `#eee4da` with its 0.5 alpha ignored, and that scrim is painted
 * BEHIND the panel's opaque surface, so it never composites into any text
 * background.
 *
 * What the same measurement did find, across all 25 controls in the dialog, is
 * `#f9f6f2` on `#8f7a66` at 3.7896:1 — the button pair section 2 already
 * records, reaching the dialog because AAP 0.5.4 maps a new primary action
 * button onto exactly those two frozen tokens. It stays in the default theme for
 * the reason the rest of this suite states, and the two alternative palettes are
 * where it clears AA.
 *
 * These cases lock both halves down: the pair that passes cannot be regressed by
 * darkening the panel or lightening its text, and the pair that does not cannot
 * be quietly re-tinted in the default while remaining unfixed in the palettes a
 * user can actually reach.
 */

/** The panel body pair: what the review named, and what it really measures. */
function panelBodyPair(theme: Theme): Pair {
  return {
    name: 'settings body text on the panel reading surface',
    front: theme.palette.text,
    back: theme.palette.pageBackground,
    minimum: TEXT_MINIMUM,
  };
}

describe('the settings surface', () => {
  it('measures the reviewed pair at the ratio it actually renders', () => {
    const pair = panelBodyPair(defaultTheme);

    // Case-insensitively: the token layer spells this one in upper case.
    expect(pair.front.toLowerCase()).toBe('#776e65');
    expect(pair.back.toLowerCase()).toBe('#faf8ef');

    // 4.6966, not 4.04. Recorded to four decimals because the claim it corrects
    // is a numeric one.
    expect(contrast(pair.front, pair.back)).toBeCloseTo(4.6966, 4);
    expect(contrast(pair.front, pair.back)).toBeGreaterThanOrEqual(
      TEXT_MINIMUM,
    );
  });

  it('records where the ~4.0 figure comes from, and that it is not rendered', () => {
    // The scrim colour with its alpha dropped. Kept as a fact so the correction
    // above is checkable rather than asserted.
    expect(contrast('#776e65', '#eee4da')).toBeCloseTo(3.9844, 4);

    // The scrim as it is actually painted, composited over the page background,
    // which is also not what any text sits on because the panel surface is
    // opaque and in front of it.
    expect(contrast('#776e65', '#f4eee4')).toBeCloseTo(4.3298, 4);
  });

  it.each([
    ['default', defaultTheme],
    ['high contrast', highContrastTheme],
    ['colourblind safe', colorblindSafeTheme],
  ])('clears AA for body text in the %s palette', (_name, theme) => {
    const pair = panelBodyPair(theme);

    expect(contrast(pair.front, pair.back)).toBeGreaterThanOrEqual(
      TEXT_MINIMUM,
    );
  });

  it('carries the frozen button pair into the dialog, as AAP 0.5.4 maps it', () => {
    // Every control in the dialog is the button vocabulary, so the pair section
    // 2 records is the pair the dialog's 25 labels render. Measured in the
    // browser at 3.7896 on all of them, and 18px bold is not large text, so 4.5
    // is the floor that applies.
    const palette = defaultTheme.palette;

    expect(contrast(palette.buttonLabel, palette.buttonSurface)).toBeCloseTo(
      3.7896,
      4,
    );
    expect(
      contrast(palette.buttonLabel, palette.buttonSurface),
    ).toBeLessThan(TEXT_MINIMUM);

    // And the reachable compliant path: both alternatives clear it by a margin,
    // and both are reachable from this very dialog.
    expect(
      contrast(
        highContrastTheme.palette.buttonLabel,
        highContrastTheme.palette.buttonSurface,
      ),
    ).toBeGreaterThanOrEqual(TEXT_MINIMUM);
    expect(
      contrast(
        colorblindSafeTheme.palette.buttonLabel,
        colorblindSafeTheme.palette.buttonSurface,
      ),
    ).toBeGreaterThanOrEqual(TEXT_MINIMUM);
  });
});
