// @vitest-environment node

// Read-only formatting gate over the tracked text sources.
//
// This file ASSERTS and never rewrites: it opens each file for reading, reports
// every offending path and line, and changes nothing on disk.
//
// The five rules below are the mechanical whitespace invariants the retired
// `.jshintrc` carried. AAP 0.3.3 carries its two-space indentation, 80-column
// and camelCase conventions forward into the TypeScript sources, and AAP 0.8.5
// replaces the repository's single human-review quality gate with executable
// ones. Column width and naming are held by the TypeScript compiler and by
// review; whitespace is held here.
//
// The `node` environment is declared per file, which vitest.config.ts documents
// as the override for a suite in the jsdom project. This gate reads the
// filesystem and needs no document.
//
// EXCLUSIONS:
//   style/fonts/**  nine Clear Sans binaries and their `.svg` form. These DO
//                   contain trailing whitespace and AAP 0.2.1.3 retains them
//                   unchanged.
//   node_modules,   dependency, build and artifact directories .gitignore
//   dist, coverage,   already covers.
//   test-results,
//   playwright-report,
//   blitzy*/
//
// Snapshot files ARE covered: they are committed, so trailing whitespace in one
// is trailing whitespace in the tree.
//
// Decisions behind this file are recorded in docs/DECISION_LOG.md.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/* ==========================================================================
 * 1. Which files the gate reads
 * ========================================================================== */

/** Directories walked in full. */
const ROOTS: readonly string[] = ['src', 'tests', 'style'];

/** Individual files outside those roots that the gate also holds. */
const EXTRA_FILES: readonly string[] = [
  'index.html',
  'vite.config.ts',
  'vitest.config.ts',
  'vitest.snapshot.config.ts',
  'playwright.config.ts',
];

/**
 * Directory names never descended into.
 *
 * `fonts` is the third-party binary set AAP 0.2.1.3 retains unchanged; the rest
 * are dependency, build and artifact directories .gitignore covers.
 */
const SKIP_DIRECTORIES: ReadonlySet<string> = new Set([
  'fonts',
  'node_modules',
  'dist',
  'coverage',
  'test-results',
  'playwright-report',
]);

/** Extensions the gate reads. Anything else is treated as a binary asset. */
const TEXT_EXTENSIONS: readonly string[] = [
  '.ts',
  '.scss',
  '.css',
  '.html',
  '.json',
  '.snap',
  '.md',
  '.yml',
];

/**
 * Reports whether `name` ends in an extension the gate reads.
 *
 * @param name File name to test.
 * @returns `true` when the file is one of the text kinds.
 */
function isTextFile(name: string): boolean {
  return TEXT_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/**
 * Collects every text file under `directory`, depth first.
 *
 * Paths are returned with `/` separators regardless of platform, so a failure
 * message reads the same everywhere.
 *
 * @param directory Directory to walk, relative to the repository root.
 * @returns Every text file found, in directory-entry order.
 */
function walk(directory: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) {
        continue;
      }

      found.push(...walk(join(directory, entry.name)));

      continue;
    }

    if (entry.isFile() && isTextFile(entry.name)) {
      found.push(join(directory, entry.name).split(sep).join('/'));
    }
  }

  return found;
}

/** Every file the gate holds, resolved once. */
const TRACKED_FILES: readonly string[] = Object.freeze([
  ...ROOTS.flatMap((root) => walk(root)),
  ...EXTRA_FILES.filter((file) => {
    try {
      return statSync(file).isFile();
    } catch {
      return false;
    }
  }),
]);

/** One file's bytes and its decoded text. */
interface SourceFile {
  readonly path: string;
  readonly bytes: Buffer;
  readonly text: string;
}

/** Every tracked file, read once for every rule below. */
const SOURCES: readonly SourceFile[] = Object.freeze(
  TRACKED_FILES.map((path) => {
    const bytes = readFileSync(path);

    return Object.freeze({ path, bytes, text: bytes.toString('utf8') });
  }),
);

/**
 * Collects the offences one rule finds across every tracked file.
 *
 * @param offends Reports the offending locations within one file, as strings
 *   already carrying the file path.
 * @returns Every offence found, across every file.
 */
function offences(offends: (file: SourceFile) => readonly string[]): string[] {
  return SOURCES.flatMap((file) =>
    file.bytes.length === 0 ? [] : offends(file),
  );
}

/* ==========================================================================
 * 2. The gate reads what it claims to
 * ========================================================================== */

describe('the gate covers the tree it claims to', () => {
  it('reads the source, test and style trees', () => {
    // A gate that silently resolved no files would pass every rule below, so
    // the corpus is asserted before anything is asserted about it.
    expect(SOURCES.length).toBeGreaterThan(100);

    for (const prefix of ['src/', 'tests/', 'style/']) {
      expect(
        SOURCES.some((file) => file.path.startsWith(prefix)),
      ).toBe(true);
    }

    expect(SOURCES.some((file) => file.path === 'index.html')).toBe(true);
    expect(SOURCES.some((file) => file.path.endsWith('.snap'))).toBe(true);
  });

  it('reads no third-party font asset', () => {
    // Named explicitly rather than left to the skip list: these files DO carry
    // trailing whitespace, and AAP 0.2.1.3 retains them unchanged, so a gate
    // that reached them would have to be weakened to pass.
    expect(
      SOURCES.filter((file) => file.path.startsWith('style/fonts/')),
    ).toEqual([]);
  });
});

/* ==========================================================================
 * 3. The rules
 * ========================================================================== */

describe('no tracked file carries loose whitespace', () => {
  it('ends no line with a space or a tab', () => {
    expect(
      offences((file) =>
        file.text
          .split('\n')
          .map((line, index) =>
            line === line.replace(/[ \t]+$/u, '')
              ? null
              : `${file.path}:${String(index + 1)}`,
          )
          .filter((entry): entry is string => entry !== null),
      ),
    ).toEqual([]);
  });

  it('ends every file with exactly one newline', () => {
    // A missing final newline and a blank final line are both flagged. The
    // second is what N9 of the review reported as trailing whitespace: seven
    // files ended `\n\n`, among them the three the finding cited, and a blank
    // last line is what a formatter and `git diff` both render as trailing.
    expect(
      offences((file) => {
        if (!file.text.endsWith('\n')) {
          return [`${file.path}: no final newline`];
        }

        return file.text.endsWith('\n\n')
          ? [`${file.path}: blank line at end of file`]
          : [];
      }),
    ).toEqual([]);
  });

  it('indents with spaces, never a tab', () => {
    expect(
      offences((file) =>
        file.text
          .split('\n')
          .map((line, index) =>
            line.startsWith('\t') ? `${file.path}:${String(index + 1)}` : null,
          )
          .filter((entry): entry is string => entry !== null),
      ),
    ).toEqual([]);
  });

  it('uses one line ending, and it is not CRLF', () => {
    expect(
      offences((file) =>
        file.text.includes('\r') ? [`${file.path}: carriage return`] : [],
      ),
    ).toEqual([]);
  });

  it('carries no byte-order mark', () => {
    expect(
      offences((file) =>
        file.bytes.length >= 3 &&
        file.bytes[0] === 0xef &&
        file.bytes[1] === 0xbb &&
        file.bytes[2] === 0xbf
          ? [`${file.path}: UTF-8 byte-order mark`]
          : [],
      ),
    ).toEqual([]);
  });
});

/* ==========================================================================
 * 4. One declaration per Sass function
 * ========================================================================== */

describe('no stylesheet declares one function twice', () => {
  /** Every `@function` name declared in a file, in source order. */
  const declaredFunctions = (text: string): string[] => {
    const found: string[] = [];
    const pattern = /^\s*@function\s+([\w-]+)\s*\(/gmu;
    let match = pattern.exec(text);

    while (match !== null) {
      found.push(match[1] ?? '');
      match = pattern.exec(text);
    }

    return found;
  };

  it('declares each @function exactly once per stylesheet', () => {
    // A second declaration under one name silently supersedes the first: Sass
    // resolves the last one and reports nothing, so the earlier block — and the
    // documentation and provenance on it — is dead code that reads as live.
    expect(
      offences((file) => {
        if (!file.path.endsWith('.scss')) {
          return [];
        }

        const seen = new Map<string, number>();
        const repeated: string[] = [];

        for (const name of declaredFunctions(file.text)) {
          const count = (seen.get(name) ?? 0) + 1;

          seen.set(name, count);

          if (count === 2) {
            repeated.push(`${file.path}: @function ${name} declared twice`);
          }
        }

        return repeated;
      }),
    ).toEqual([]);
  });

  it('reads the token layer, where the duplication was', () => {
    // The corpus assertion for this rule: a gate that resolved no stylesheet
    // would pass it silently.
    const tokens = SOURCES.find((file) => file.path === 'style/_tokens.scss');

    expect(tokens).toBeDefined();
    expect(declaredFunctions(tokens?.text ?? '')).toContain('quantised');
  });
});
