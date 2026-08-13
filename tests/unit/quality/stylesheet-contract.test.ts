// Contract suite for the two stylesheet properties nothing else verifies.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { compile } from 'sass';

import { fieldWidth } from '../../../src/theme/tokens';
import {
  defaultTheme,
  rarityCardLift,
  rarityCardLiftStep,
  rarityTiers,
} from '../../../src/theme/themes';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');

/** Reads one tracked file as UTF-8. */
const read = (relativePath: string): string =>
  readFileSync(resolve(ROOT, relativePath), 'utf8');

/** One warning Dart Sass raised while compiling, as the gate reports it. */
interface CompileWarning {
  readonly message: string;
  readonly deprecation: boolean;
  readonly kind: string;
}

/**
 * Every warning the compile raised, in order.
 *
 * The compile took `.css` and discarded everything else, so Dart Sass
 * deprecation warnings were invisible to the suite AND to `npm test`. V8 of the
 * AAP requires the Sass build to be free of deprecation warnings once the nine
 * division sites are migrated, and nothing held that: the migration could
 * regress — a `@import` reintroduced, a slash division added — and every gate
 * would still report green while the stylesheet moved onto a path Dart Sass has
 * announced it will remove. DL-TEST-13.
 */
const compileWarnings: CompileWarning[] = [];

/** The compiled stylesheet, compiled once for the whole file. */
const compiled = ((): string =>
  compile(resolve(ROOT, 'style/main.scss'), {
    logger: {
      warn: (message: string, options): void => {
        const raw: unknown = options;
        const carried =
          typeof raw === 'object' && raw !== null
            ? (raw as {
                deprecation?: unknown;
                deprecationType?: { id?: unknown };
              })
            : {};

        compileWarnings.push({
          message: String(message),
          deprecation: carried.deprecation === true,
          kind: String(carried.deprecationType?.id ?? 'warning'),
        });
      },
    },
  }).css)();

/**
 * Reads one `--theme-*` declaration out of the compiled sheet and renders it
 * as a browser would: `rgb()` channels stated as percentages are rounded to
 * the nearest 8-bit value, which is what the pixel ends up being.
 *
 * MOVED to module scope, from the describe below, so the rarity-plate group
 * reads the same renderer rather than a second copy of it.
 *
 * @param property Custom property to read, without its leading dashes.
 * @param from Text to read it out of. Defaults to the whole sheet, which finds
 *   the first — that is, the default palette's — declaration.
 * @returns The colour as 6-digit lowercase hex.
 */
const compiledColor = (property: string, from: string = compiled): string => {
  const declaration = new RegExp(`--${property}:\\s*([^;]+);`, 'u').exec(
    from,
  )?.[1];

  if (declaration === undefined) {
    throw new Error(`the compiled sheet declares no --${property}`);
  }

  const text = declaration.trim();

  if (text.startsWith('#')) {
    return text.length === 4
      ? `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`.toLowerCase()
      : text.toLowerCase();
  }

  const channels = /rgba?\(([^)]*)\)/u.exec(text)?.[1] ?? '';
  const rendered = channels
    .split(',')
    .slice(0, 3)
    .map((channel): number => {
      const value = channel.trim();

      return value.endsWith('%')
        ? (Number.parseFloat(value) / 100) * 255
        : Number.parseFloat(value);
    })
    .map((value): string => Math.round(value).toString(16).padStart(2, '0'))
    .join('');

  return `#${rendered}`;
};

describe('the Sass build raises no deprecation warning', () => {
  it('compiles style/main.scss with no deprecation at all', () => {
    // FAIL-CLOSED. V8 of the AAP requires the migrated stylesheet to compile
    // clean, and this is the only place that holds it: the nine `math.div()`
    // sites and the two `@use` conversions can all regress silently otherwise.
    // The message is carried into the failure so the offending construct and its
    // line are named rather than merely counted.
    const deprecations = compileWarnings
      .filter((warning): boolean => warning.deprecation)
      .map((warning): string => `${warning.kind}: ${warning.message}`);

    expect(deprecations).toEqual([]);
  });

  it('compiles style/main.scss with no warning of any kind', () => {
    // A Sass `@warn` is not a deprecation, and none is expected either: the
    // stylesheet raises no advisory of its own.
    const raised = compileWarnings.map(
      (warning): string => `${warning.kind}: ${warning.message}`,
    );

    expect(raised).toEqual([]);
  });

  it('produced a stylesheet, so the two assertions above are not vacuous', () => {
    // A compile that emitted nothing would raise no warning either.
    expect(compiled.length).toBeGreaterThan(0);
  });
});

describe('style/_tokens.scss declares each function once', () => {
  it('declares `quantised` exactly once', () => {
    const source = read('style/_tokens.scss');
    const declarations = source.match(/^@function quantised\(/gmu) ?? [];

    // Sass silently takes the last declaration, so a duplicate is invisible at
    // compile time and only a source read can catch it.
    expect(declarations).toHaveLength(1);
  });

  it('declares no other function twice in that file', () => {
    const source = read('style/_tokens.scss');
    const names = (source.match(/^@function\s+([\w-]+)\(/gmu) ?? []).map(
      (declaration) => declaration.replace(/^@function\s+/u, ''),
    );

    expect(new Set(names).size).toBe(names.length);
  });

  it('still emits the quantised ramp fills the compiled sheet carries', () => {
    // The retained declaration is the one that runs: the ramp custom property
    // it serialises is present, so the dedupe removed a duplicate and not the
    // function.
    expect(compiled).toContain('--tile-fill-compiled:');
  });
});

describe('the accessible component surfaces match the token module', () => {
  it('renders the control surface the token module declares', () => {
    // src/theme/tokens.ts states the quantised form of
    // `color.adjust($game-container-background, $lightness: -26%)`; this is the
    // gate that keeps the two from drifting, since the projection mirror covers
    // only the eighteen named tokens. DL-THEME-08.
    expect(compiledColor('theme-control-surface')).toBe(
      defaultTheme.palette.controlSurface,
    );
  });

  it('renders the readout surface the token module declares', () => {
    expect(compiledColor('theme-readout-surface')).toBe(
      defaultTheme.palette.readoutSurface,
    );
  });

  it('publishes both under the default palette and both additive ones', () => {
    // Three palettes, each publishing the pair, so a theme switch cannot land a
    // control on an unstated surface.
    expect(compiled.match(/--theme-control-surface:/gu) ?? []).toHaveLength(3);
    expect(compiled.match(/--theme-readout-surface:/gu) ?? []).toHaveLength(3);
    expect(compiled.match(/--theme-control-label:/gu) ?? []).toHaveLength(3);
    expect(compiled.match(/--theme-readout-label:/gu) ?? []).toHaveLength(3);
    expect(compiled.match(/--theme-readout-value:/gu) ?? []).toHaveLength(3);
  });
});

describe('the settings slider carries the shared control treatment', () => {
  it('takes the tokenized focus ring, in both focus spellings', () => {
    expect(compiled).toMatch(
      /\.settings-slider:focus-visible\s*\{[^}]*--theme-focus-ring/u,
    );
    expect(compiled).toMatch(
      /@supports not selector\(:focus-visible\)\s*\{\s*\.settings-slider:focus/u,
    );
  });

  it('takes the hover, activation and disabled states', () => {
    // Hover still yields to keyboard focus, which is a presentation choice.
    expect(compiled).toMatch(/\.settings-slider:hover:not\(:focus-visible\)/u);

    // ACTIVATION DOES NOT. It was written `:active:not(:focus-visible)` while
    // it and the focus ring both declared `box-shadow`, so a focused control
    // could show only one of the two and press feedback vanished under
    // keyboard focus. The two now occupy separate slots of one composed
    // `box-shadow`, so the guard is gone and both are visible together.
    // DL-A11Y-10.
    expect(compiled).toMatch(/\.settings-slider:active:not\(:disabled\)/u);
    expect(compiled).not.toMatch(
      /\.settings-slider:active:not\(:focus-visible\)/u,
    );

    expect(compiled).toMatch(
      /\.settings-slider:disabled[^{]*\{[^}]*pointer-events: none/u,
    );
  });

  it('composes the focus band and the state ring on one property', () => {
    // The focus rule writes the focus slot and the activation rule the state
    // slot; one declaration lays both down, so neither can erase the other.
    // DL-A11Y-10.
    expect(compiled).toMatch(
      /\.settings-slider:focus-visible\s*\{[^}]*--a11y-focus-shadow:/u,
    );
    expect(compiled).toMatch(
      /\.settings-slider:active:not\(:disabled\)[^{]*\{[^}]*--a11y-state-shadow:\s*inset/u,
    );
    expect(compiled).toMatch(
      /box-shadow:\s*var\(--a11y-state-shadow[^)]*\),\s*var\(--a11y-focus-shadow/u,
    );
  });

  it('keeps its tint and states no colour of its own', () => {
    const rule =
      /\.settings-slider\s*\{([^}]*)\}/u.exec(compiled)?.[1] ?? '';

    // The native range is kept and tinted through the same custom property the
    // other controls resolve, and nothing here hardcodes a colour or replaces
    // the control's appearance.
    expect(rule).toContain('accent-color: var(--theme-control-surface');
    expect(rule).not.toContain('appearance');
  });
});

describe('the relic tray is styled as the reading it is', () => {
  it('declares exactly one rule for the tray item interior', () => {
    const rules = compiled.match(/\.relic-tray-control[^{]*\{/gu) ?? [];

    // src/ui/components/relic-card.ts renders this element as a `<span>`: the
    // tray is a reading of what the run holds, in pickup order, and nothing in it
    // is pressed. DL-CARD-01, DL-KEYMAP-05.
    expect(rules).toEqual(['.relic-tray-control {']);
  });

  it('offers none of the affordances of a control', () => {
    // A row that cannot take focus cannot show a focus ring, and hover, active
    // and disabled treatments on an element that is not interactive are the same
    // false promise in the visual layer as an activation label is in the spoken
    // one.
    expect(compiled).not.toMatch(/\.relic-tray-control:focus/u);
    expect(compiled).not.toMatch(/\.relic-tray-control:hover/u);
    expect(compiled).not.toMatch(/\.relic-tray-control:active/u);
    expect(compiled).not.toMatch(/\.relic-tray-control\[aria-disabled/u);
    expect(compiled).not.toMatch(/\.relic-tray-control:disabled/u);
    expect(compiled).not.toMatch(/button\.relic-tray-control/u);
  });

  it('keeps the user-agent resets the span still needs', () => {
    const rule =
      /\.relic-tray-control\s*\{([^}]*)\}/u.exec(compiled)?.[1] ?? '';

    // The resets neutralise the user-agent styling of whatever element carries
    // the class, which is what lets the markup change without the layout moving.
    expect(rule).toContain('margin: 0');
    expect(rule).toContain('padding: 0');
    expect(rule).toContain('background: transparent');
    expect(rule).toContain('font: inherit');
  });
});

// The two run-failure notices are told apart by more than a border
// style, because one is settled and the other merely unconfirmed. DL-HUD-15.
describe('the run-not-saved notice reads as the more urgent of the two', () => {
  it('carries a caution bar on one edge, from the palette accent', () => {
    const rule = /\.hud-ephemeral\s*\{([^}]*)\}/u.exec(compiled)?.[1] ?? '';

    expect(rule).not.toBe('');

    // The accent is resolved per palette through the published custom property,
    // so the high-contrast and colourblind-safe themes supply their own; the
    // fallback is this stylesheet's own compiled token.
    expect(rule).toMatch(
      /border-inline-start:\s*3px solid var\(--theme-tile-64,\s*#776E65\)/u,
    );

    // The width is the second channel, so the state is never colour alone.
    expect(rule).toContain('border: 1px solid var(--theme-rule');

    // And the copy keeps the page text colour, which clears 4.5:1 where the
    // accent would not.
    expect(rule).toContain('color: var(--theme-text');
  });

  it('leaves the merely-unconfirmed notice as it was', () => {
    const rule = /\.hud-degraded\s*\{([^}]*)\}/u.exec(compiled)?.[1] ?? '';

    // Dashed, no caution bar: a board status that has not been confirmed is not
    // a run that has stopped being saved.
    expect(rule).toContain('border: 1px dashed var(--theme-rule');
    expect(rule).not.toContain('border-inline-start');
  });
});

describe('the retained terminal overlay withdraws for the router', () => {
  /** The withdrawal rule, as the compiler emits it. */
  const withdrawal =
    '[inert] .game-container .game-message.game-won, ' +
    '[inert] .game-container .game-message.game-over';

  /** The promotion the withdrawal has to outrank. */
  const promotion =
    '.game-container .game-message.game-won, ' +
    '.game-container .game-message.game-over';

  it('withdraws the layer wherever an ancestor is inert', () => {
    // AAP §0.4.1.1 subsumes `.game-message` into the router's terminal states,
    // and `SCREEN_INERTS_BACKGROUND` of src/ui/screen-router.ts is where the
    // router says it owns the presentation. Both terminal classes are covered,
    // so the win and the loss each resolve through one treatment. DL-SHEET-07.
    expect(compiled).toMatch(
      new RegExp(
        `${withdrawal.replace(/[[\].]/gu, '\\$&')}\\s*\\{[^}]*display: none`,
        'u',
      ),
    );
  });

  it('withdraws it at the mobile scale too', () => {
    // `game-field` is included twice — once at the desktop measure and once
    // inside the single breakpoint — so a rule that reached only the first
    // emission would leave the duplicate treatment standing under 520px.
    const occurrences = compiled.split(withdrawal).length - 1;

    expect(occurrences).toBe(2);
  });

  it('outranks the promotion it has to beat, in both emissions', () => {
    // Four class-level components against three settles the cascade on
    // specificity; following the promotion in source order settles it again if
    // a future edit ever levels them.
    const promotions = [...compiled.matchAll(
      new RegExp(promotion.replace(/[[\].]/gu, '\\$&'), 'gu'),
    )].map((match) => match.index);
    const withdrawals = [...compiled.matchAll(
      new RegExp(withdrawal.replace(/[[\].]/gu, '\\$&'), 'gu'),
    )].map((match) => match.index);

    // `[inert] ` prefixes BOTH selectors in the withdrawal's list, so the
    // promotion's own text is not a substring of it: the two counts are the two
    // emissions, and each withdrawal follows the promotion it outranks.
    expect(promotions).toHaveLength(2);
    expect(withdrawals).toHaveLength(2);
    expect(withdrawals[0]).toBeGreaterThan(promotions[0] as number);
    expect(withdrawals[1]).toBeGreaterThan(promotions[1] as number);
  });

  it('leaves the layer presenting when nothing is inert', () => {
    // The withdrawal is conditional on the router's own marker, so a document
    // whose screen layer never took over still gets the ported `message()`
    // treatment. Removing the promotion would delete that fallback.
    expect(compiled).toMatch(
      new RegExp(
        `(?<!\\[inert\\] )${promotion.replace(/[[\].]/gu, '\\$&')}\\s*\\{` +
          '[^}]*display: block',
        'u',
      ),
    );
  });

  it('takes the whole layer, not the paragraph and the controls apart', () => {
    // Hiding the ancestor is what removes the two retained buttons from the
    // layout, the accessibility tree and the tab order at once — the treatment
    // the availability layer gives `.retry-button`, applied to both by
    // containment rather than restated per control.
    expect(compiled).not.toMatch(/\[inert\][^{]*\.game-message\s+p\s*\{/u);
    expect(compiled).not.toMatch(/\[inert\][^{]*\.game-message\s+\.lower\s*\{/u);
  });
});

describe('the on-screen controls are a pad that clears the target floor', () => {
  it('lays the four movement controls out on a three-column track', () => {
    expect(compiled).toMatch(
      /\.on-screen-controls-pad\s*\{[^}]*display: grid/u,
    );
    expect(compiled).toMatch(
      /\.on-screen-controls-pad\s*\{[^}]*grid-template-columns: repeat\(3, 1fr\)/u,
    );
  });

  it('places each control where its direction points', () => {
    // 0 up, 1 right, 2 down, 3 left — the `MOVE_ACTION_DIRECTIONS` encoding
    // src/input/on-screen-controls.ts already writes as `data-direction`.
    // DL-CONTROL-09.
    const placements: readonly [string, string][] = [
      ['0', '1/2'],
      ['1', '2/3'],
      ['2', '3/2'],
      ['3', '2/1'],
    ];

    for (const [direction, area] of placements) {
      expect(compiled).toMatch(
        new RegExp(
          `\\.on-screen-controls-pad > \\[data-direction="${direction}"\\]\\s*\\{` +
            `[^}]*grid-area: ${area.replace('/', '\\/')}`,
          'u',
        ),
      );
    }
  });

  it('leaves the sibling action group a wrapping flex row', () => {
    // The grid rule is scoped to the pad; the actions group keeps the layout it
    // had, so this change reaches four controls and no others.
    expect(compiled).toMatch(
      /\.on-screen-controls-group\s*\{[^}]*display: flex/u,
    );
    expect(compiled).not.toMatch(
      /\.on-screen-controls-actions\s*\{[^}]*display: grid/u,
    );
  });

  it('meets the 44px floor in the box on both axes', () => {
    const rule =
      /\.on-screen-control\s*\{([^}]*)\}/u.exec(compiled)?.[1] ?? '';

    // The floor is in the PAINTED box, so it measures 44px by
    // `getBoundingClientRect()` and not only by hit test. `min-block-size`
    // rather than `block-size`, so the 40px `@mixin screen-control` declares is
    // outranked without being restated. DL-A11Y-12.
    expect(rule).toContain('min-inline-size: 44px');
    expect(rule).toContain('min-block-size: 44px');
    expect(rule).not.toContain('block-size: 40px');

    // The label stays centred in whichever height wins.
    expect(rule).toContain('display: inline-flex');
    expect(rule).toContain('align-items: center');

    // The pseudo-element the box replaces is gone, so there is exactly one
    // mechanism holding the floor.
    expect(compiled).not.toMatch(/\.on-screen-control::after/u);
  });

  it('leaves the retained classic controls at their frozen height', () => {
    // Named selectors, so a reader can see the scope: neither the frozen
    // `.restart-button` nor its companion is raised, and neither gains a
    // pseudo-element.
    expect(compiled).not.toMatch(/\.restart-button::after/u);
    expect(compiled).not.toMatch(/\.settings-button::after/u);
    expect(compiled).toMatch(/\.restart-button\s*\{[^}]*height: 40px/u);
    expect(compiled).not.toMatch(
      /\.restart-button\s*\{[^}]*min-block-size/u,
    );

    // And the floor rule is qualified by the element, so it outranks the
    // `display: inline-block` the shared control vocabulary declares later.
    expect(compiled).toMatch(/button\.on-screen-control\s*\{/u);
  });
});


describe('a key-binding row is laid out as aligned columns', () => {
  /** The first column's length, as the compiled sheet states it. */
  const labelColumn = (source: string): string | undefined =>
    /grid-template-columns:\s*([\d.]+)px minmax\(0, 1fr\) max-content/u.exec(
      source,
    )?.[1];

  it('is a three-column grid with a fixed first column', () => {
    // A FIXED length is what puts the binding text at the same x in every row;
    // an `auto` or `max-content` column would be sized per row. DL-SCREEN-05.
    expect(compiled).toMatch(
      /\.settings-row-binding\s*\{[^}]*display: grid/u,
    );

    const rule = /\.settings-row-binding\s*\{([^}]*)\}/u.exec(compiled)?.[1];

    expect(rule).toBeDefined();
    expect(labelColumn(rule ?? '')).toBe('166.6666666667');
    expect(rule).toContain('minmax(0, 1fr) max-content');
    expect(rule).toContain('align-items: center');
  });

  it('places the three children of a row by position', () => {
    for (const [child, column] of [
      ['1', '1'],
      ['2', '2'],
      ['3', '3'],
    ] as const) {
      expect(compiled).toMatch(
        new RegExp(
          `\\.settings-row-binding > :nth-child\\(${child}\\)\\s*\\{` +
            `[^}]*grid-column: ${column}`,
          'u',
        ),
      );
    }
  });

  it('rescales the first column at the mobile measure', () => {
    // 280px / 3, the mobile reading measure, from the same derivation.
    const declaration =
      'grid-template-columns: 93.3333333333px minmax(0, 1fr) max-content;';

    expect(compiled).toContain(declaration);

    // And it is inside the ONE breakpoint this stylesheet declares: the
    // nearest `@media` above it is the 520px query.
    const at = compiled.indexOf(declaration);
    const query = compiled.lastIndexOf('@media', at);

    expect(query).toBeGreaterThan(-1);
    expect(compiled.slice(query, at)).toContain('(max-width: 520px)');

    // The desktop rule is the one outside any query.
    const desktop = compiled.indexOf(
      'grid-template-columns: 166.6666666667px minmax(0, 1fr) max-content;',
    );

    expect(desktop).toBeGreaterThan(-1);
    expect(desktop).toBeLessThan(at);
  });

  it('releases the binding cell so the middle column can shrink', () => {
    // `minmax(0, 1fr)` cannot hold while the item keeps its automatic minimum,
    // which is what pushed the control onto a second line.
    expect(compiled).toMatch(
      /\.settings-binding\s*\{[^}]*min-inline-size: 0/u,
    );
    expect(compiled).toMatch(
      /\.settings-binding\s*\{[^}]*overflow-wrap: break-word/u,
    );
  });

  it('starts the dialog body text at the inline edge, heading excepted', () => {
    expect(compiled).toMatch(
      /\.settings-panel:not\(\[hidden\]\) \.settings-body\s*\{[^}]*text-align: start/u,
    );
    expect(compiled).toMatch(
      /\.settings-panel:not\(\[hidden\]\) \.settings-body > h2\s*\{[^}]*text-align: center/u,
    );

    // The overlay itself still centres, which every other screen depends on.
    expect(compiled).toMatch(/\.screen\s*\{[^}]*text-align: center/u);
  });
});

describe('a rarity reads against the surface it is painted on', () => {
  /** The WCAG 2.1 AA minimum for a non-text graphical distinction. */
  const GRAPHICAL_MINIMUM = 3;

  /** The WCAG 2.1 AA minimum for normal-size text, which the chip label is. */
  const TEXT_MINIMUM = 4.5;

  /**
   * Relative luminance of a 6-digit hex colour, by WCAG 2.1's own formula. The
   * canonical statement of it lives in tests/unit/theme/palette-contrast.test.ts,
   * which reads no filesystem; this file compiles the sheet, so the two cannot
   * share one module without giving that suite a compile step it declares it
   * does not take.
   *
   * @param hex Colour as `#rrggbb`.
   * @returns Its relative luminance.
   */
  const luminance = (hex: string): number => {
    const channels = [1, 3, 5].map(
      (at): number => Number.parseInt(hex.slice(at, at + 2), 16) / 255,
    );

    const linear = channels.map((channel): number =>
      channel <= 0.03928
        ? channel / 12.92
        : Math.pow((channel + 0.055) / 1.055, 2.4),
    );

    return (
      0.2126 * (linear[0] ?? 0) +
      0.7152 * (linear[1] ?? 0) +
      0.0722 * (linear[2] ?? 0)
    );
  };

  /**
   * Contrast ratio between two colours.
   *
   * @param front Foreground as `#rrggbb`.
   * @param back Background as `#rrggbb`.
   * @returns The ratio, at least 1.
   */
  const contrast = (front: string, back: string): number => {
    const a = luminance(front) + 0.05;
    const b = luminance(back) + 0.05;

    return a > b ? a / b : b / a;
  };

  it('computes a ratio the formula endpoints agree with', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#bbada0', '#bbada0')).toBeCloseTo(1, 5);
  });

  /**
   * The declarations of one palette, so a per-palette property can be read
   * rather than only the default palette's first occurrence.
   *
   * @param theme Palette id. `'default'` reads the `:root` block.
   * @returns The block's text.
   */
  const paletteBlock = (theme: string): string => {
    const pattern =
      theme === 'default'
        ? /:root\s*\{([^}]*)\}/u
        : new RegExp(`\\[data-theme=${theme}\\]\\s*\\{([^}]*)\\}`, 'u');
    const block = pattern.exec(compiled)?.[1];

    if (block === undefined) {
      throw new Error(`the compiled sheet declares no ${theme} palette block`);
    }

    return block;
  };

  /** Every palette the sheet publishes, the default one first. */
  const palettes = ['default', 'high-contrast', 'colorblind-safe'] as const;

  it('publishes an accent, a plated variant and a card variant per tier, in every palette', () => {
    // Four tiers across three palettes, for each of the three vocabularies.
    expect(compiled.match(/--theme-rarity-[a-z]+:/gu) ?? []).toHaveLength(12);
    expect(
      compiled.match(/--theme-rarity-[a-z]+-plate:/gu) ?? [],
    ).toHaveLength(12);
    expect(compiled.match(/--theme-rarity-[a-z]+-card:/gu) ?? []).toHaveLength(
      12,
    );

    for (const tier of rarityTiers) {
      expect(compiled).toContain(`--theme-rarity-${tier}:`);
      expect(compiled).toContain(`--theme-rarity-${tier}-plate:`);
      expect(compiled).toContain(`--theme-rarity-${tier}-card:`);
    }
  });

  it('clears the text floor on the card, in every palette', () => {
    // DL-THEME-11. The chip renders the tier NAME in the tier's colour on the
    // card, so the ratio it must clear is the one WCAG 2.1 asks of text. The bare
    // accent cleared it in the default palette only: both additive palettes run
    // their ramp to a near-black high anchor by design, and the top tier measured
    // 1.29:1 on their near-black card.
    for (const theme of palettes) {
      const block = paletteBlock(theme);
      const surface = compiledColor('theme-tile-super', block);

      for (const tier of rarityTiers) {
        const card = compiledColor(`theme-rarity-${tier}-card`, block);

        expect(
          contrast(card, surface),
          `${theme}/${tier} card accent on the card surface`,
        ).toBeGreaterThanOrEqual(TEXT_MINIMUM);
      }
    }
  });

  it('names the tier it fixed, so the premise cannot go stale', () => {
    // The bare accent still fails on the additive card surfaces, which is what
    // the card variant exists for. Asserted so a future palette edit that made
    // the bare accent readable would surface here rather than leaving a lift
    // nothing needs.
    let failures = 0;

    for (const theme of ['high-contrast', 'colorblind-safe'] as const) {
      const block = paletteBlock(theme);
      const surface = compiledColor('theme-tile-super', block);

      for (const tier of rarityTiers) {
        if (
          contrast(compiledColor(`theme-rarity-${tier}`, block), surface) <
          TEXT_MINIMUM
        ) {
          failures += 1;
        }
      }
    }

    // Three of four tiers, in each of the two additive palettes.
    expect(failures).toBe(6);
  });

  it('leaves the frozen default palette card vocabulary untouched', () => {
    // AAP 0.5.6 keeps the established palette as the DEFAULT theme, and it
    // already clears the floor on its own card, so its lift is zero and each card
    // value is the bare accent itself. The additive palettes are where the lift
    // lands, which is what makes this fix additive.
    const block = paletteBlock('default');

    for (const tier of rarityTiers) {
      expect(compiledColor(`theme-rarity-${tier}-card`, block)).toBe(
        compiledColor(`theme-rarity-${tier}`, block),
      );
    }
  });

  it('keeps the card tiers distinguishable from each other, in ladder order', () => {
    // A lift that cleared the floor by collapsing the four tiers onto one another
    // would destroy the distinction the chip exists to carry, so the ladder is
    // asserted as an ordering. One uniform lift per palette is what preserves it.
    for (const theme of palettes) {
      const block = paletteBlock(theme);
      const surface = compiledColor('theme-tile-super', block);
      const ratios = rarityTiers.map((tier): number =>
        contrast(compiledColor(`theme-rarity-${tier}-card`, block), surface),
      );

      expect(new Set(ratios).size, theme).toBe(rarityTiers.length);

      for (let at = 1; at < ratios.length; at += 1) {
        expect(ratios[at], `${theme} tier ${at}`).toBeLessThan(
          ratios[at - 1] ?? 0,
        );
      }
    }
  });

  it('agrees with the TypeScript mirror on the lift each palette takes', () => {
    // src/theme/themes.ts carries the same derivation for the renderer and the
    // diagnostics surface. The lift is compared rather than the hex, because the
    // TypeScript half floors each channel while a browser rounds the percentages
    // the sheet emits — the same one-unit difference the tile ramp already
    // documents. DL-THEME-11.
    for (const theme of palettes) {
      const block = paletteBlock(theme);
      const surface = compiledColor('theme-tile-super', block);
      const lift = rarityCardLift(theme);
      const lowest = rarityTiers[rarityTiers.length - 1] ?? 'legendary';

      // The lift is the SMALLEST passing one, so one step less must fail for at
      // least one tier — which is the property that ties the two halves together
      // without comparing quantised channels.
      expect(
        contrast(compiledColor(`theme-rarity-${lowest}-card`, block), surface),
      ).toBeGreaterThanOrEqual(TEXT_MINIMUM);

      expect(lift).toBeGreaterThanOrEqual(0);
      expect(lift % rarityCardLiftStep).toBeCloseTo(0, 10);
    }

    // And the two additive palettes take a lift where the default takes none.
    expect(rarityCardLift('default')).toBe(0);
    expect(rarityCardLift('high-contrast')).toBeGreaterThan(0);
    expect(rarityCardLift('colorblind-safe')).toBeGreaterThan(0);
  });

  it('clears the graphical floor on the page, which the bare accent did not', () => {
    // DL-THEME-10. The accents are built to read on the dark card surface and
    // measure 6.70:1 to 9.08:1 there. On the page they measured 1.18:1 to
    // 1.60:1 — which is what the review reported against the tray stripe, a
    // surface the page shows through. The plated variant composites each accent
    // over the card anchor so the stripe carries a colour built for where it is
    // actually painted.
    const page = compiledColor('theme-page-background');

    for (const tier of rarityTiers) {
      const accent = compiledColor(`theme-rarity-${tier}`);
      const plate = compiledColor(`theme-rarity-${tier}-plate`);

      // The premise: the bare accent does not clear the floor on the page.
      expect(contrast(accent, page)).toBeLessThan(GRAPHICAL_MINIMUM);

      // The fix: the plated one does.
      expect(contrast(plate, page)).toBeGreaterThanOrEqual(GRAPHICAL_MINIMUM);
    }
  });

  it('keeps the tiers distinguishable from each other, in hue order', () => {
    // A plate that cleared the floor by collapsing the four tiers onto one
    // another would destroy the distinction it exists to carry, so the ladder
    // is asserted as an ordering rather than four independent ratios.
    const page = compiledColor('theme-page-background');
    const ratios = rarityTiers.map((tier): number =>
      contrast(compiledColor(`theme-rarity-${tier}-plate`), page),
    );

    expect(new Set(ratios).size).toBe(rarityTiers.length);

    for (let at = 1; at < ratios.length; at += 1) {
      expect(ratios[at]).toBeGreaterThan(ratios[at - 1] ?? 0);
    }
  });

  it('reads the plated variant on the tray stripe and the card variant on the chip', () => {
    // The two surfaces differ, so they read different properties: the stripe
    // sits on the page and the chip sits on the card.
    //
    // The chip read the BARE accent, which is the colour of neither
    // surface. It now reads the card variant, and the card's block-start edge
    // reads it too so the edge and the chip that names the tier still carry one
    // colour. DL-THEME-11, DL-REWARD-17.
    expect(compiled).toMatch(/--theme-rarity-[^;)]*-plate/u);

    const stripe = /\.relic-tray-item\[data-rarity[^{]*\{[^}]*\}/gu;
    const stripes = compiled.match(stripe) ?? [];

    expect(stripes.length).toBeGreaterThan(0);
    expect(stripes.some((rule) => rule.includes('-plate'))).toBe(true);

    const chip =
      /\.reward-offer \.relic-card\[data-rarity=[a-z]+\] \.relic-card-rarity\s*\{[^}]*\}/gu;
    const chips = compiled.match(chip) ?? [];

    expect(chips).toHaveLength(rarityTiers.length);

    for (const rule of chips) {
      expect(rule).toContain('-card');
      expect(rule).not.toMatch(/--theme-rarity-[a-z]+,/u);
    }

    const edge =
      /\.reward-offer \.relic-card\[data-rarity=[a-z]+\]\s*\{[^}]*\}/gu;
    const edges = compiled.match(edge) ?? [];

    expect(edges).toHaveLength(rarityTiers.length);

    for (const rule of edges) {
      expect(rule).toContain('border-block-start-color');
      expect(rule).toContain('-card');
    }
  });
});

describe('a disabled relic card is dimmed like every other disabled control', () => {
  it('carries the shared disabled alpha rather than a treatment of its own', () => {
    // DL-REWARD-15. The card stated only a dashed edge, so the one control the
    // reward screen disables read as available. `$a11y-disabled-alpha` is the
    // value style/_a11y.scss dims every other disabled control by.
    const rule =
      /\.reward-offer \.relic-card\[disabled\][^{]*\{([^}]*)\}/u.exec(
        compiled,
      )?.[1];

    expect(rule).toBeDefined();
    expect(rule).toContain('opacity: 0.5');

    // And the affordances that were already right are untouched.
    expect(rule).toContain('pointer-events: none');
    expect(rule).toContain('cursor: default');
  });

  it('uses the same alpha the accessibility layer states for a control', () => {
    const shared = /\$a11y-disabled-alpha:\s*([0-9.]+)/u.exec(
      read('style/_a11y.scss'),
    )?.[1];

    expect(shared).toBe('0.5');

    const rule =
      /\.reward-offer \.relic-card\[disabled\][^{]*\{([^}]*)\}/u.exec(
        compiled,
      )?.[1];

    expect(rule).toContain(`opacity: ${String(shared)}`);
  });
});

describe('the diagnostics surface width is one number in two places', () => {
  // DL-DIAG-08. The surface's inline size is declared in style/main.scss AND
  // mirrored in src/observability/diagnostics-overlay.ts, which applies it as an
  // INLINE style — and an inline declaration outranks the stylesheet. Widening
  // the sheet alone therefore left the surface at its old width with the change
  // entirely dead and no test failing. Only a source read can catch that, so
  // this pins the two halves to one another.
  const OVERLAY_WIDTH_DENOMINATOR = 5;
  const OVERLAY_WIDTH_NUMERATOR = 4;

  it('declares the same fraction of the reading measure in the stylesheet', () => {
    expect(read('style/main.scss')).toContain(
      `inline-size: math.div($field-width * ${OVERLAY_WIDTH_NUMERATOR}, ` +
        `${OVERLAY_WIDTH_DENOMINATOR});`,
    );
  });

  it('mirrors that same fraction in the module that inlines it', () => {
    const source = read('src/observability/diagnostics-overlay.ts');

    expect(source).toContain(
      `const HOST_WIDTH_NUMERATOR = ${OVERLAY_WIDTH_NUMERATOR};`,
    );
    expect(source).toContain(
      `const HOST_WIDTH_DENOMINATOR = ${OVERLAY_WIDTH_DENOMINATOR};`,
    );

    // And the module cites the stylesheet's own expression, so a reader of
    // either half is pointed at the other.
    expect(source).toContain(
      `math.div($field-width * ${OVERLAY_WIDTH_NUMERATOR}, ` +
        `${OVERLAY_WIDTH_DENOMINATOR})`,
    );
  });

  it('compiles to the pixel width both halves compute', () => {
    const expected =
      (fieldWidth * OVERLAY_WIDTH_NUMERATOR) / OVERLAY_WIDTH_DENOMINATOR;

    expect(expected).toBe(400);
    expect(compiled).toContain(`inline-size: ${String(expected)}px`);
  });
});
