// Contract suite for the two stylesheet properties nothing else verifies.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { compile } from 'sass';

import { defaultTheme } from '../../../src/theme/themes';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');

/** Reads one tracked file as UTF-8. */
const read = (relativePath: string): string =>
  readFileSync(resolve(ROOT, relativePath), 'utf8');

/** The compiled stylesheet, compiled once for the whole file. */
const compiled = ((): string => compile(resolve(ROOT, 'style/main.scss')).css)();

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
  /**
   * Reads one `--theme-*` declaration out of the compiled sheet and renders it
   * as a browser would: `rgb()` channels stated as percentages are rounded to
   * the nearest 8-bit value, which is what the pixel ends up being.
   *
   * @param property Custom property to read, without its leading dashes.
   * @returns The colour as 6-digit lowercase hex.
   */
  const compiledColor = (property: string): string => {
    const declaration = new RegExp(
      `--${property}:\\s*([^;]+);`,
      'u',
    ).exec(compiled)?.[1];

    if (declaration === undefined) {
      throw new Error(`the compiled sheet declares no --${property}`);
    }

    const text = declaration.trim();

    if (text.startsWith('#')) {
      return text.toLowerCase();
    }

    const channels = /rgb\(([^)]*)\)/u.exec(text)?.[1] ?? '';
    const rendered = channels
      .split(',')
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
    expect(compiled).toMatch(/\.settings-slider:hover:not\(:focus-visible\)/u);
    expect(compiled).toMatch(/\.settings-slider:active:not\(:focus-visible\)/u);
    expect(compiled).toMatch(
      /\.settings-slider:disabled[^{]*\{[^}]*pointer-events: none/u,
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
