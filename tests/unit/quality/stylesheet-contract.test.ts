// Contract suite for the two stylesheet properties nothing else verifies.
//
// The read-only gates at this commit are `npm run typecheck`, the unit and
// snapshot suites, and `npx sass style/main.scss`. The Sass gate proves the
// sheet COMPILES; it proves nothing about what compiled out of it, and no test
// read the SCSS sources at all beyond the whitespace sweep in
// formatting.test.ts. Two review findings sat in exactly that gap:
//
//   a function declared twice   `@function quantised` stood twice in
//                               style/_tokens.scss with identical bodies. Sass
//                               takes the last declaration, so the two could
//                               drift with nothing reporting it and a reader had
//                               no way to tell which was authoritative.
//   a control outside the       `.settings-slider` declared `accent-color` and
//   shared treatment           nothing else, so the one range control in the
//                               settings dialog carried neither the focus ring
//                               nor the hover, activation and disabled states
//                               every other control there carries.
//
// Both are read from the sources and from the compiled output rather than
// asserted about the DOM, because both are stylesheet-layer facts.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { compile } from 'sass';

/** Repository root, resolved from this file rather than from the cwd. */
const ROOT = resolve(import.meta.dirname, '..', '..', '..');

/** Reads one tracked file as UTF-8. */
const read = (relativePath: string): string =>
  readFileSync(resolve(ROOT, relativePath), 'utf8');

/**
 * The compiled stylesheet, compiled once for the whole file.
 *
 * The same entry point `npx sass style/main.scss` and vite.config.ts both
 * compile, so what is asserted here is what ships.
 */
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
    expect(rule).toContain('accent-color: var(--theme-button-surface');
    expect(rule).not.toContain('appearance');
  });
});
