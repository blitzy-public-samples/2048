// @vitest-environment node

// Read-only formatting gate over the tracked text sources.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/** Directories walked in full. */
const ROOTS: readonly string[] = ['src', 'tests', 'style'];

/**
 * Individual files outside those roots that the gate also holds.
 *
 * The CI workflow is one of them: it is a tracked text file that carries
 * identifier citations of its own, so it is held to the same whitespace rules
 * as every other file a reviewer reads.
 */
const EXTRA_FILES: readonly string[] = [
  'index.html',
  'vite.config.ts',
  'vitest.config.ts',
  'vitest.snapshot.config.ts',
  'playwright.config.ts',
  '.github/workflows/ci.yml',
];

/** Directory names never descended into. */
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
    expect(
      SOURCES.filter((file) => file.path.startsWith('style/fonts/')),
    ).toEqual([]);
  });
});

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
    // A missing final newline and a blank final line are both flagged.
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
          .map((line, index) => {
            // The WHOLE leading-whitespace run is examined, not just
            // its first character. `startsWith('\t')` caught a tab only in
            // column one, so a line indented with spaces and THEN a tab — the
            // shape an editor with a mixed-indent setting actually produces —
            // passed the assertion its own name makes. DL-TEST-10.
            const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
            const at = indent.indexOf('\t');

            return at === -1
              ? null
              : `${file.path}:${String(index + 1)}:${String(at + 1)}`;
          })
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
    // A second declaration under one name silently supersedes the first.
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
