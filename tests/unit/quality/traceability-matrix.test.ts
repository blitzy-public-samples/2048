// @vitest-environment node

// Read-only structural gate over docs/TRACEABILITY_MATRIX.md and the `TR-*`
// declarations that point into it.
//
// This file ASSERTS and never rewrites: it opens the matrix and the sources for
// reading, reports every offending identifier, row and file, and changes
// nothing on disk.
//
// WHY THIS GATE EXISTS
//   Rule 1 requires a bidirectional traceability matrix at 100% coverage with no
//   gaps, and §6 of the matrix states the two properties that make it so: every
//   identifier cited by the tree has a row, and every row is declared by the
//   module that owns it. Neither was checkable. A commit removed the per-file
//   declaration blocks from 63 modules, which left 428 rows claiming an owner
//   that no longer named them and two identifiers cited by code with no row at
//   all, and the matrix went on asserting completeness arithmetically while the
//   arithmetic had stopped being true. Nothing failed, because nothing looked.
//
//   The two `grep` pipelines §6 documents are the manual form of this gate. This
//   file is the mechanical form, so the same regression cannot land unobserved.
//
// WHAT IS ASSERTED
//   1. Every Direction B row identifier is unique, so no row has two owners.
//   2. Every subsection heading's declared counts match the rows beneath it.
//   3. Every row is cited by the file the heading names — the §6 property, and
//      the one the removal broke.
//   4. Every `TR-*` identifier cited anywhere in the tree has a Direction B row.
//   5. Every Direction A row has a Direction B row, and Direction A carries
//      exactly the rows Direction B does not mark target-only.
//   6. Ordinals are contiguous from `01` within each area, across every file
//      that shares the area.
//   7. The totals §5 states equal the totals parsed here, so the coverage claim
//      cannot drift from the document it describes.
//
// The gate reads the matrix and walks `src/`, `style/`, `tests/` and the root
// tooling configs. It writes nothing and needs no document, so the `node`
// environment is declared per file exactly as the other quality gates declare
// it.
//
// Decisions behind this file are recorded in docs/DECISION_LOG.md.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/* ==========================================================================
 * 1. Reading the matrix
 * ========================================================================== */

/** The matrix, relative to the repository root the test runner starts in. */
const MATRIX_PATH = 'docs/TRACEABILITY_MATRIX.md';

/** Trees walked for declarations. */
const DECLARING_ROOTS: readonly string[] = Object.freeze([
  'src',
  'style',
  'tests',
]);

/** Root files that declare rows of their own. */
const DECLARING_FILES: readonly string[] = Object.freeze([
  'playwright.config.ts',
  'vite.config.ts',
  'vitest.config.ts',
  'vitest.snapshot.config.ts',
]);

/** Extensions a declaration may appear in. */
const DECLARING_EXTENSIONS: readonly string[] = Object.freeze(['.ts', '.scss']);

/** Any `TR-<AREA>-<NN>` occurrence. */
const IDENTIFIER_PATTERN = /TR-[A-Z0-9]+-\d\d/g;

/** An identifier split into its area and ordinal. */
const IDENTIFIER_PARTS = /^TR-([A-Z0-9]+)-(\d\d)$/;

/** A table row: the identifier is the first cell, in backticks. */
const ROW_PATTERN = /^\|\s*`(TR-[A-Z0-9]+-\d\d)`\s*\|/;

/** A Direction B heading: `### \`path\` — N rows, M target-only`. */
const DIRECTION_B_HEADING = /^### `([^`]+)` — (\d+) rows?, (\d+) target-only$/;

/** A Direction A heading, whose subject is a retired or updated artifact. */
const DIRECTION_A_HEADING = /^### (.+?) — /;

/** The phrase a row carries when it has no pre-migration construct. */
const TARGET_ONLY = 'target-only';

/** One parsed row. */
interface MatrixRow {
  readonly id: string;
  readonly targetOnly: boolean;
  /** One-based line number, so a failure names the line to open. */
  readonly line: number;
}

/** One Direction B subsection. */
interface Subsection {
  readonly owner: string;
  readonly declaredRows: number;
  readonly declaredTargetOnly: number;
  readonly rows: readonly MatrixRow[];
  readonly line: number;
}

const matrixLines: readonly string[] = readFileSync(
  MATRIX_PATH,
  'utf8',
).split('\n');

/**
 * Finds the line index a top-level section starts on.
 *
 * @param prefix Heading text the section starts with.
 * @returns Zero-based index of that line.
 * @throws Error when the matrix carries no such section, which is itself a
 *   structural failure worth reporting by name.
 */
function sectionStart(prefix: string): number {
  const index = matrixLines.findIndex((line) => line.startsWith(prefix));

  if (index === -1) {
    throw new Error(`${MATRIX_PATH} carries no section "${prefix}".`);
  }

  return index;
}

const DIRECTION_A_START = sectionStart('## 2. Direction A');

const DIRECTION_B_START = sectionStart('## 3. Direction B');

const LEDGER_START = sectionStart('## 4.');

/**
 * Reads every row of a line range.
 *
 * @param from Zero-based first line.
 * @param to Zero-based line after the last.
 * @returns The rows, in document order.
 */
function rowsWithin(from: number, to: number): MatrixRow[] {
  const rows: MatrixRow[] = [];

  for (let index = from; index < to; index += 1) {
    const line = matrixLines[index] ?? '';
    const matched = ROW_PATTERN.exec(line);

    if (matched?.[1] !== undefined) {
      rows.push({
        id: matched[1],
        targetOnly: line.includes(TARGET_ONLY),
        line: index + 1,
      });
    }
  }

  return rows;
}

/** Direction B, as one entry per owning module. */
function readSubsections(): Subsection[] {
  const found: Subsection[] = [];
  let open: {
    owner: string;
    declaredRows: number;
    declaredTargetOnly: number;
    line: number;
    from: number;
  } | null = null;

  const close = (to: number): void => {
    if (open === null) {
      return;
    }

    found.push({
      owner: open.owner,
      declaredRows: open.declaredRows,
      declaredTargetOnly: open.declaredTargetOnly,
      rows: rowsWithin(open.from, to),
      line: open.line,
    });
  };

  for (let index = DIRECTION_B_START; index < LEDGER_START; index += 1) {
    const line = matrixLines[index] ?? '';

    if (!line.startsWith('### ')) {
      continue;
    }

    close(index);

    const matched = DIRECTION_B_HEADING.exec(line);

    open =
      matched === null
        ? null
        : {
            owner: matched[1] ?? '',
            declaredRows: Number(matched[2]),
            declaredTargetOnly: Number(matched[3]),
            line: index + 1,
            from: index + 1,
          };
  }

  close(LEDGER_START);

  return found;
}

const subsections: readonly Subsection[] = Object.freeze(readSubsections());

const directionBRows: readonly MatrixRow[] = Object.freeze(
  subsections.flatMap((subsection) => subsection.rows),
);

const directionARows: readonly MatrixRow[] = Object.freeze(
  rowsWithin(DIRECTION_A_START, DIRECTION_B_START),
);

/** id -> the file its Direction B heading names. */
const ownerOf: ReadonlyMap<string, string> = new Map(
  subsections.flatMap((subsection) =>
    subsection.rows.map((row): [string, string] => [row.id, subsection.owner]),
  ),
);

/* ==========================================================================
 * 2. Reading the declarations in the tree
 * ========================================================================== */

/**
 * Every file under a root that may carry a declaration.
 *
 * @param root Directory to walk.
 * @returns Paths in a stable order, so a failure reads the same twice.
 */
function walk(root: string): string[] {
  const found: string[] = [];

  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);

      if (statSync(path).isDirectory()) {
        visit(path);
        continue;
      }

      if (DECLARING_EXTENSIONS.some((suffix) => entry.endsWith(suffix))) {
        found.push(path.split('\\').join('/'));
      }
    }
  };

  visit(root);

  return found;
}

const declaringPaths: readonly string[] = Object.freeze([
  ...DECLARING_ROOTS.flatMap(walk),
  ...DECLARING_FILES,
]);

/** path -> the identifiers that file cites. */
const citationsByFile: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  declaringPaths.map((path): [string, ReadonlySet<string>] => [
    path,
    new Set(readFileSync(path, 'utf8').match(IDENTIFIER_PATTERN) ?? []),
  ]),
);

const citedIdentifiers: ReadonlySet<string> = new Set(
  [...citationsByFile.values()].flatMap((identifiers) => [...identifiers]),
);

/* ==========================================================================
 * 3. The gate
 * ========================================================================== */

describe('the matrix is structurally sound', () => {
  it('gives every row exactly one owning module', () => {
    const seen = new Map<string, string>();
    const duplicated: string[] = [];

    for (const row of directionBRows) {
      const previous = seen.get(row.id);

      if (previous === undefined) {
        seen.set(row.id, `${ownerOf.get(row.id) ?? ''} (line ${row.line})`);
        continue;
      }

      duplicated.push(`${row.id}: ${previous} and line ${row.line}`);
    }

    expect(duplicated).toEqual([]);
    expect(seen.size).toBe(directionBRows.length);
  });

  it('reads a subsection for every declaring module', () => {
    expect(subsections.length).toBeGreaterThan(70);

    const empty = subsections
      .filter((subsection) => subsection.rows.length === 0)
      .map((subsection) => `${subsection.owner} (line ${subsection.line})`);

    expect(empty).toEqual([]);
  });

  it('states counts in each heading that match the rows beneath it', () => {
    const wrong: string[] = [];

    for (const subsection of subsections) {
      const targetOnly = subsection.rows.filter((row) => row.targetOnly).length;

      if (subsection.declaredRows !== subsection.rows.length) {
        wrong.push(
          `${subsection.owner}: heading says ${subsection.declaredRows} rows, ` +
            `${subsection.rows.length} present (line ${subsection.line})`,
        );
      }

      if (subsection.declaredTargetOnly !== targetOnly) {
        wrong.push(
          `${subsection.owner}: heading says ${subsection.declaredTargetOnly} ` +
            `target-only, ${targetOnly} present (line ${subsection.line})`,
        );
      }
    }

    expect(wrong).toEqual([]);
  });

  it('numbers each area contiguously from 01', () => {
    const ordinals = new Map<string, number[]>();

    for (const row of directionBRows) {
      const parts = IDENTIFIER_PARTS.exec(row.id);
      const area = parts?.[1] ?? '';
      const ordinal = Number(parts?.[2] ?? '0');
      ordinals.set(area, [...(ordinals.get(area) ?? []), ordinal]);
    }

    const broken: string[] = [];

    for (const [area, seen] of [...ordinals].sort()) {
      const sorted = [...seen].sort((left, right) => left - right);
      const expected = sorted.map((_, index) => index + 1);

      if (sorted.join(',') !== expected.join(',')) {
        broken.push(`TR-${area}: ${sorted.join(', ')}`);
      }
    }

    expect(broken).toEqual([]);
  });
});

describe('coverage is bidirectional and complete', () => {
  it('has every row declared by the file its heading names', () => {
    const undeclared: string[] = [];

    for (const [id, owner] of [...ownerOf].sort()) {
      const cited = citationsByFile.get(owner);

      if (cited === undefined) {
        undeclared.push(`${id}: owner ${owner} is not a file this gate reads`);
        continue;
      }

      if (!cited.has(id)) {
        undeclared.push(`${id}: not declared by ${owner}`);
      }
    }

    expect(undeclared).toEqual([]);
  });

  it('has a row for every identifier the tree cites', () => {
    const orphaned: string[] = [];

    for (const id of [...citedIdentifiers].sort()) {
      if (ownerOf.has(id)) {
        continue;
      }

      const where = [...citationsByFile]
        .filter(([, identifiers]) => identifiers.has(id))
        .map(([path]) => path);

      orphaned.push(`${id}: cited by ${where.join(', ')} with no row`);
    }

    expect(orphaned).toEqual([]);
  });

  it('carries the same identifier set in the tree and in the matrix', () => {
    const inMatrix = [...ownerOf.keys()].sort();
    const inTree = [...citedIdentifiers].sort();

    expect(inTree).toEqual(inMatrix);
  });

  it('gives every Direction A row a Direction B row', () => {
    const missing = directionARows
      .map((row) => row.id)
      .filter((id) => !ownerOf.has(id))
      .sort();

    expect(missing).toEqual([]);
  });

  it('carries in Direction A exactly the rows not marked target-only', () => {
    const sourced = directionBRows.filter((row) => !row.targetOnly).length;
    const uniqueDirectionA = new Set(directionARows.map((row) => row.id));

    expect(uniqueDirectionA.size).toBe(directionARows.length);
    expect(uniqueDirectionA.size).toBe(sourced);
  });
});

describe('the coverage section states the totals it describes', () => {
  const coverage = matrixLines
    .slice(sectionStart('## 5. Coverage'), sectionStart('## 6.'))
    .join('\n');

  it('states the row total', () => {
    expect(coverage).toContain(`**${directionBRows.length} rows**`);
  });

  it('states the area total', () => {
    const areas = new Set(
      directionBRows.map((row) => IDENTIFIER_PARTS.exec(row.id)?.[1] ?? ''),
    );

    expect(coverage).toContain(`**${areas.size} areas**`);
  });

  it('states the Direction A row total and its artifact count', () => {
    const artifacts = matrixLines
      .slice(DIRECTION_A_START, DIRECTION_B_START)
      .filter((line) => DIRECTION_A_HEADING.test(line)).length;

    expect(coverage).toContain(`**${directionARows.length} rows**`);
    expect(coverage).toContain(`${artifacts} artifacts`);
  });

  it('states the owning-module total', () => {
    expect(coverage).toContain(`${subsections.length} modules`);
  });

  it('states the target-only total', () => {
    const targetOnly = directionBRows.filter((row) => row.targetOnly).length;

    expect(coverage).toContain(`**${targetOnly} rows are target-only.**`);
  });
});

describe('every area is registered in CONTRIBUTING.md', () => {
  /** The document whose table is the complete registry of areas. */
  const REGISTRY_PATH = 'CONTRIBUTING.md';

  /**
   * Matches one registry row and captures its identifier cell. A row names one
   * or more comma-separated codes, because a file may own rows under two of
   * them: `src/engine/board-effects.ts` owns both `EFFECT` and `EFFECTS`.
   */
  const REGISTRY_ROW = /^\s*\|\s*(`[A-Z0-9]+`(?:,\s*`[A-Z0-9]+`)*)\s*\|\s*`/;

  const registered: ReadonlySet<string> = new Set(
    readFileSync(REGISTRY_PATH, 'utf8')
      .split('\n')
      .flatMap((line) => {
        const cell = REGISTRY_ROW.exec(line)?.[1];

        return cell === undefined
          ? []
          : [...cell.matchAll(/`([A-Z0-9]+)`/gu)].map((match) => match[1]);
      }),
  );

  const areaOf = (identifier: string): string =>
    IDENTIFIER_PARTS.exec(identifier)?.[1] ?? identifier;

  it('read a registry that actually parsed', () => {
    // Guards the two assertions below against passing on an empty set.
    expect(registered.size).toBeGreaterThan(60);
  });

  it('names the area of every identifier the tree cites', () => {
    const unregistered = [
      ...new Set([...citedIdentifiers].map(areaOf)),
    ]
      .filter((area) => !registered.has(area))
      .sort();

    // The registry states that it is the complete set of areas and that a new
    // one is added in the same change that first uses it.
    expect(unregistered).toEqual([]);
  });

  it('names the area of every row of the matrix', () => {
    const unregistered = [...new Set([...ownerOf.keys()].map(areaOf))]
      .filter((area) => !registered.has(area))
      .sort();

    expect(unregistered).toEqual([]);
  });
});
