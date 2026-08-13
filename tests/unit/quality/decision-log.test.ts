// @vitest-environment node

// Read-only structural gate over docs/DECISION_LOG.md and the citations that
// point into it.
//
// This file ASSERTS and never rewrites: it opens the log and the sources for
// reading, reports every offending identifier, row and line, and changes nothing
// on disk.
//
// WHY THIS GATE EXISTS
//   Rule 1 makes the decision log the single source of truth for *why* this
//   repository looks the way it does, and it fixes the shape of that truth: four
//   content columns per row, an identifier that resolves to exactly one row, and
//   no unexplained deviation. None of that was checkable. A review reported three
//   rows as carrying the wrong number of columns, and the report was WRONG — the
//   three rows each carry exactly five cells and had already escaped their
//   literal pipes as `\|`, which a naive split on `|` counts as extra columns.
//   The review was right about the underlying exposure, though: nothing
//   mechanically distinguished a row that is malformed from a row that merely
//   contains a pipe, and nothing caught the two identifiers that genuinely did
//   resolve to two rows apiece.
//
//   So the escape-aware parse below is the gate, and its first duty is to be the
//   parser a reader should have used: a `|` preceded by a backslash is content,
//   not a delimiter.
//
// WHAT IS ASSERTED
//   1. Every table row carries five cells (`ID` plus Rule 1's four content
//      columns) or three (the conflict register of §12, whose header declares
//      three).
//   2. No content cell is empty, which the log's own preamble promises.
//   3. Every `DL-<AREA>-<NN>` identifier defines exactly one row.
//   4. Ordinals are contiguous from `01` within each area, which the log's
//      namespace rules state as binding.
//   5. Every identifier cited from `src/` or `tests/` resolves to a row.
//   6. Every area cited is registered in `CONTRIBUTING.md`.
//
// The gate reads `docs/DECISION_LOG.md` and `CONTRIBUTING.md` and walks `src/`
// and `tests/`. It writes nothing and needs no document, so the `node`
// environment is declared per file exactly as the formatting gate declares it.
//
// Decisions behind this file are recorded in docs/DECISION_LOG.md.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/* ==========================================================================
 * 1. Reading the log
 * ========================================================================== */

/** The log, relative to the repository root the test runner starts in. */
const LOG_PATH = 'docs/DECISION_LOG.md';

/** The area registry Rule 1 makes authoritative. */
const REGISTRY_PATH = 'CONTRIBUTING.md';

/**
 * Directories never walked for citations.
 *
 * The sweep is now stated as an EXCLUSION list over the whole
 * repository rather than an inclusion list of two roots. `['src', 'tests']`
 * over `['.ts']` alone left real citation sites unswept — `tsconfig.node.json`
 * cites `DL-BUILD-14`, both `docs/dashboards/` artifacts cite twenty-one
 * identifiers between them, `index.html` and every `style/*.scss` file cite
 * their own — so an identifier could be cited from one of those and resolve to
 * no row without this gate noticing. Inverting the list inverts the failure
 * mode: a newly added citing file is swept by default, and only a deliberate
 * entry below escapes. DL-TEST-13.
 */
const EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  'test-results',
  'playwright-report',

  // The superseded vanilla sources, kept for reference and citing nothing.
  'js',
]);

/**
 * Files excluded from the citation sweep, with the reason each is excluded.
 *
 * The log is the ONE file whose identifiers need not resolve: it records the
 * next free ordinal of every area in prose, and those deliberately name rows
 * that do not exist yet.
 */
const EXCLUDED_FILES: ReadonlySet<string> = new Set([LOG_PATH]);

/** Extensions a citation may appear in: every tracked text form. */
const CITING_EXTENSIONS: readonly string[] = Object.freeze([
  '.ts',
  '.scss',
  '.css',
  '.html',
  '.json',
  '.md',
  '.yml',
  '.yaml',
]);

/** Cell counts a row may carry: five for a decision, three for a conflict. */
const DECISION_CELLS = 5;

const CONFLICT_CELLS = 3;

/** One parsed table row. */
interface Row {
  /** One-based line number, so a failure names the line to open. */
  readonly line: number;
  readonly cells: readonly string[];
}

/**
 * Splits a table row into cells, treating an ESCAPED pipe as content.
 *
 * This is the whole point of the gate. `docs/DECISION_LOG.md` quotes code that
 * contains `|` — a bitwise or, a union type, a shell pipe — and escapes each as
 * `\|` so Markdown renders it inside the cell. A split on every `|` therefore
 * reports a well-formed five-column row as carrying eight or thirteen columns,
 * which is exactly the false reading this gate exists to replace.
 *
 * @param line The raw line, which must open and close with a pipe.
 * @returns The trimmed cells between the delimiters.
 */
function splitRow(line: string): readonly string[] {
  const body = line.trim();
  const inner = body.slice(1, -1);

  return inner.split(/(?<!\\)\|/u).map((cell): string => cell.trim());
}

/** Whether a line is a table row: it opens and closes with a pipe. */
function isTableRow(line: string): boolean {
  const trimmed = line.trim();

  return (
    trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 1
  );
}

/** Whether a row is the `|---|---|` separator beneath a header. */
function isSeparator(cells: readonly string[]): boolean {
  return cells.every((cell): boolean => /^:?-{3,}:?$/u.test(cell));
}

const logLines: readonly string[] = readFileSync(LOG_PATH, 'utf8').split('\n');

const rows: readonly Row[] = logLines
  .map((line, index): Row | null =>
    isTableRow(line) ? { line: index + 1, cells: splitRow(line) } : null,
  )
  .filter((row): row is Row => row !== null && !isSeparator(row.cells));

/** A row whose first cell is a decision identifier. */
const ID_CELL = /^`(DL-([A-Z0-9]+)-(\d{2}))`$/u;

interface Definition {
  readonly id: string;
  readonly area: string;
  readonly ordinal: number;
  readonly row: Row;
}

const definitions: readonly Definition[] = rows
  .map((row): Definition | null => {
    const match = ID_CELL.exec(row.cells[0] ?? '');

    return match === null
      ? null
      : {
          id: match[1] as string,
          area: match[2] as string,
          ordinal: Number(match[3]),
          row,
        };
  })
  .filter((entry): entry is Definition => entry !== null);

/* ==========================================================================
 * 2. Reading the citations
 * ========================================================================== */

/** Every `DL-*` identifier appearing in a source or test file, with its path. */
function collectCitations(): ReadonlyMap<string, readonly string[]> {
  const found = new Map<string, string[]>();

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      if (EXCLUDED_DIRECTORIES.has(entry)) {
        continue;
      }

      const path = directory === '.' ? entry : join(directory, entry);

      if (statSync(path).isDirectory()) {
        walk(path);

        continue;
      }

      if (EXCLUDED_FILES.has(path)) {
        continue;
      }

      if (!CITING_EXTENSIONS.some((suffix): boolean => path.endsWith(suffix))) {
        continue;
      }

      for (const match of readFileSync(path, 'utf8').matchAll(
        /\bDL-[A-Z0-9]+-\d+\b/gu,
      )) {
        const id = match[0];
        const paths = found.get(id) ?? [];

        if (!paths.includes(path)) {
          paths.push(path);
        }

        found.set(id, paths);
      }
    }
  };

  walk('.');

  return found;
}

const citations = collectCitations();

/* ==========================================================================
 * 3. The shape of every row
 * ========================================================================== */

describe('every decision table row is well formed', () => {
  it('parses an escaped pipe as content rather than as a delimiter', () => {
    // The parser's own unit test, because every assertion below rests on it and
    // the review that prompted this gate failed precisely here.
    expect(splitRow('| a | b \\| c | d |')).toEqual(['a', 'b \\| c', 'd']);
    expect(splitRow('| a | b | c |')).toEqual(['a', 'b', 'c']);
  });

  it('reads a decision log that actually holds rows', () => {
    // Guards every assertion below: a parser that matched nothing would make the
    // whole suite pass by finding no fault.
    expect(rows.length).toBeGreaterThan(300);
    expect(definitions.length).toBeGreaterThan(300);
  });

  it('carries five cells for a decision and three for a conflict', () => {
    const offending = rows
      .filter(
        (row): boolean =>
          row.cells.length !== DECISION_CELLS &&
          row.cells.length !== CONFLICT_CELLS,
      )
      .map(
        (row): string =>
          `${LOG_PATH}:${String(row.line)} has ${String(
            row.cells.length,
          )} cells: ${row.cells[0] ?? ''}`,
      );

    expect(offending).toEqual([]);
  });

  it('leaves no content cell empty', () => {
    const offending = definitions
      .filter((entry): boolean =>
        entry.row.cells.slice(1).some((cell): boolean => cell === ''),
      )
      .map(
        (entry): string =>
          `${LOG_PATH}:${String(entry.row.line)} ${entry.id} has an empty cell`,
      );

    expect(offending).toEqual([]);
  });

  it('gives every decision row the four columns Rule 1 requires', () => {
    const offending = definitions
      .filter((entry): boolean => entry.row.cells.length !== DECISION_CELLS)
      .map(
        (entry): string =>
          `${entry.id} carries ${String(entry.row.cells.length - 1)} content columns`,
      );

    expect(offending).toEqual([]);
  });
});

/* ==========================================================================
 * 4. The identifier namespace
 * ========================================================================== */

describe('the identifier namespace holds', () => {
  it('defines each identifier exactly once', () => {
    const counted = new Map<string, number>();

    for (const entry of definitions) {
      counted.set(entry.id, (counted.get(entry.id) ?? 0) + 1);
    }

    const duplicated = [...counted.entries()]
      .filter(([, count]): boolean => count > 1)
      .map(([id, count]): string => `${id} defines ${String(count)} rows`);

    // Two identifiers once resolved to two rows apiece — a deviation stated in
    // its area section AND again in the deviations section — which made a
    // citation ambiguous about which argument it pointed at.
    expect(duplicated).toEqual([]);
  });

  it('numbers ordinals contiguously from 01 within each area', () => {
    const byArea = new Map<string, number[]>();

    for (const entry of definitions) {
      byArea.set(entry.area, [...(byArea.get(entry.area) ?? []), entry.ordinal]);
    }

    const offending: string[] = [];

    for (const [area, ordinals] of byArea) {
      const sorted = [...ordinals].sort((left, right): number => left - right);

      sorted.forEach((ordinal, index): void => {
        if (ordinal !== index + 1) {
          offending.push(
            `DL-${area} jumps to ${String(ordinal)} at position ${String(
              index + 1,
            )}`,
          );
        }
      });
    }

    // The log states this as binding, because it is what makes "the next free
    // ordinal is discoverable by reading the area's table" true.
    expect(offending).toEqual([]);
  });

  it('resolves every identifier cited from any tracked text file', () => {
    const defined = new Set(definitions.map((entry): string => entry.id));
    const dangling = [...citations.entries()]
      .filter(([id]): boolean => !defined.has(id))
      .map(([id, paths]): string => `${id} cited by ${paths.join(', ')}`);

    expect(dangling).toEqual([]);
  });

  it('registers every cited area in the contributing guide', () => {
    const registry = readFileSync(REGISTRY_PATH, 'utf8');
    const areas = new Set(
      [...citations.keys()].map(
        (id): string => (/^DL-([A-Z0-9]+)-/u.exec(id)?.[1] ?? '') as string,
      ),
    );

    const unregistered = [...areas]
      .filter((area): boolean => area !== '' && !registry.includes(area))
      .map((area): string => `area ${area} is cited and not registered`);

    // The log's own rule: a citation to an unregistered area is a broken
    // citation, and the registry is authoritative.
    expect(unregistered).toEqual([]);
  });
});
