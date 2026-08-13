// Integrity suite for the two identifier namespaces that join the code to its
// documentation.
//
// `CONTRIBUTING.md` states the convention in its own terms: `DL-<AREA>-<NN>`
// names one decision in docs/DECISION_LOG.md, `<NN>` is unique within its area
// and never reused, a new decision takes the next free ordinal in its area, and
// a new area is registered in that document's table in the same change that
// first uses it. Every part of that is checkable, and none of it was checked.
//
// It was also untrue. A review of the run-flow composition enumerated the tree
// and found twenty-one identifiers cited by source files that resolved to no row
// in the log — six `DL-CARD` ordinals, nine `DL-GAMEOVER` ordinals and the six
// minted by the composition change — with `CARD` and `GAMEOVER` absent from the
// area registry as well, so fifteen of them resolved neither to a row nor to an
// owner. Two identifiers, `DL-REWARD-06` and `DL-REWARD-11`, each carried two
// full rows, which is two authoritative statements of one decision. Each of
// those is a mechanical property of text files, so each is asserted here rather
// than left to the next reviewer to re-enumerate by hand.
//
// This suite reads the tree. It imports no module under src/ and needs no DOM.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/** Repository root, resolved from this file rather than from the cwd. */
const ROOT = resolve(import.meta.dirname, '..', '..', '..');

/** The log every `DL-*` identifier resolves into. */
const LOG_PATH = 'docs/DECISION_LOG.md';

/** The document whose table is the complete registry of areas. */
const REGISTRY_PATH = 'CONTRIBUTING.md';

/**
 * Directories never descended into.
 *
 * CHANGED: the sweep is stated as an EXCLUSION list over the whole repository.
 * Three inclusion lists — two roots plus a hand-kept file list and a hand-kept
 * sibling-document list — left real citation sites out: `tsconfig.node.json`
 * cites `DL-BUILD-14` and the two `docs/dashboards/` artifacts cite twenty-one
 * identifiers between them, and none was swept by either decision-log gate. An
 * exclusion list inverts the failure mode, so a citing file added tomorrow is
 * swept by default. DL-TEST-13.
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
 * The documents REQUIRED to cite at least one identifier, asserted one by one.
 *
 * That is a different property from "its citations resolve": a document that
 * stopped explaining itself would pass the resolution sweep trivially. The
 * whole-repository sweep above covers resolution for these and for every other
 * file, so this list carries only the obligation to explain.
 *
 * Two documents are deliberately absent. `README.md` is build-and-run
 * instructions for a reader who has not opened the log, and `blitzy-deck/`'s
 * deck addresses non-technical leadership; neither is a place a decision
 * identifier belongs, and neither carries one. Asserting the whole list rather
 * than a count of more than five is what surfaced that — the threshold was met
 * while both explained nothing. DL-TEST-13.
 */
const SIBLING_DOCUMENTS: readonly string[] = [
  'CONTRIBUTING.md',
  'docs/CONFIGURATION.md',
  'docs/OBSERVABILITY.md',
  'docs/RELICS.md',
  'docs/TRACEABILITY_MATRIX.md',
  'docs/architecture/ARCHITECTURE.md',
  'docs/architecture/component-interaction.md',
  'docs/architecture/data-flow.md',
  'docs/architecture/hook-dispatch-sequence.md',
  'docs/dashboards/dashboard.html',
  'docs/dashboards/dashboard.json',
];

/** Files the citation sweep reads, by extension. */
const CITING_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.scss',
  '.css',
  '.html',

  // ADDED: the two forms the previously unswept citation sites use — the
  // dashboard template and the tooling configs are JSON, and every document
  // that explains itself is Markdown. DL-TEST-13.
  '.json',
  '.md',
  '.yml',
  '.yaml',
]);

/**
 * The one file excluded from the identifier sweep.
 *
 * The log records each area's next free ordinal in prose, so it deliberately
 * names rows that do not exist yet. Everything else is read, including
 * `.github/workflows/ci.yml`, which cites the decisions behind the pipeline it
 * declares: a citation that resolves to no row is the failure this suite exists
 * to catch wherever the citation is written.
 */
const EXCLUDED_FILES: ReadonlySet<string> = new Set([LOG_PATH]);

/** Matches one decision identifier anywhere in a file. */
const CITATION_PATTERN = /DL-[A-Z0-9]+-\d+/gu;

/**
 * The shape every identifier must have: exactly two digits, nothing after.
 *
 * ADDED: `CITATION_PATTERN` and `ROW_PATTERN` both accept any number of digits,
 * so a row written with one digit DEFINED that identifier and every citation of
 * it resolved — the malformed shape passed the gate end to end. `ordinalOf`
 * parses it too, so it could even satisfy the contiguity assertion in place of
 * the two-digit form it was meant to be. DL-TEST-13.
 *
 * No malformed identifier is written literally in this file: the sweep reads its
 * own source, so an example would be collected as a citation.
 */
const WELL_FORMED = /^DL-[A-Z0-9]+-\d\d$/u;

/**
 * Matches a table row that DEFINES an identifier: a leading pipe, the
 * identifier in backticks, then the next cell. A prose mention never matches,
 * because prose does not begin a line with a pipe.
 */
const ROW_PATTERN = /^\|\s*`(DL-[A-Z0-9]+-\d+)`\s*\|/gmu;

/** Matches one area row of the registry table: `| \`AREA\` | owner |`. */
const AREA_PATTERN = /^\s*\|\s*`([A-Z0-9]+)`\s*\|\s*`/gmu;

/** Reads one tracked file as UTF-8. */
const read = (relativePath: string): string =>
  readFileSync(resolve(ROOT, relativePath), 'utf8');

/** Every file under one directory, recursively, excluded names skipped. */
const walk = (relativeDirectory: string): string[] => {
  const absolute = resolve(ROOT, relativeDirectory);
  const collected: string[] = [];

  for (const entry of readdirSync(absolute)) {
    if (EXCLUDED_DIRECTORIES.has(entry)) {
      continue;
    }

    const relative =
      relativeDirectory === '.' ? entry : join(relativeDirectory, entry);

    if (statSync(resolve(ROOT, relative)).isDirectory()) {
      collected.push(...walk(relative));

      continue;
    }

    if (EXCLUDED_FILES.has(relative)) {
      continue;
    }

    collected.push(relative);
  }

  return collected;
};

/** Every identifier cited by the sources and their tests, to the files citing it. */
const citations = ((): Map<string, string[]> => {
  const found = new Map<string, string[]>();
  const paths = walk('.').filter((path) =>
    CITING_EXTENSIONS.has(extname(path)),
  );

  for (const path of paths) {
    for (const identifier of read(path).match(CITATION_PATTERN) ?? []) {
      const citing = found.get(identifier);

      if (citing === undefined) {
        found.set(identifier, [path]);

        continue;
      }

      if (!citing.includes(path)) {
        citing.push(path);
      }
    }
  }

  return found;
})();

/** Every identifier the log defines, in the order its rows stand. */
const definitions = ((): string[] =>
  [...read(LOG_PATH).matchAll(ROW_PATTERN)].map((match) => match[1] ?? ''))();

/** Every area the registry declares. */
const registeredAreas = ((): Set<string> =>
  new Set(
    [...read(REGISTRY_PATH).matchAll(AREA_PATTERN)].map(
      (match) => match[1] ?? '',
    ),
  ))();

/** The area part of one identifier. */
const areaOf = (identifier: string): string =>
  identifier.slice('DL-'.length, identifier.lastIndexOf('-'));

/** The ordinal part of one identifier. */
const ordinalOf = (identifier: string): number =>
  Number.parseInt(identifier.slice(identifier.lastIndexOf('-') + 1), 10);

describe('every cited decision identifier resolves to a row', () => {
  it('leaves no citation undefined', () => {
    const defined = new Set(definitions);
    const unresolved = [...citations.keys()]
      .filter((identifier) => !defined.has(identifier))
      .sort()
      .map((identifier) => `${identifier} (${citations.get(identifier)?.[0]})`);

    // The message carries the citing file, because the fix is either a row in
    // the log or a corrected citation and the file decides which.
    expect(unresolved).toEqual([]);
  });

  it('found citations to sweep, so an empty sweep cannot pass', () => {
    expect(citations.size).toBeGreaterThan(300);
    expect(definitions.length).toBeGreaterThan(300);
  });
});

describe('every identifier a sibling document cites resolves to a row', () => {
  it('leaves no citation in the documentation undefined', () => {
    const defined = new Set(definitions);
    const unresolved: string[] = [];

    for (const path of SIBLING_DOCUMENTS) {
      for (const identifier of new Set(read(path).match(CITATION_PATTERN))) {
        if (!defined.has(identifier)) {
          unresolved.push(`${identifier} (${path})`);
        }
      }
    }

    // The failure this catches is a prose range whose upper end overshoots the
    // highest ordinal its area actually reaches: the end of the range names no
    // row. The message carries the citing document, because the fix is either a
    // row in the log or a corrected citation and the document decides which.
    expect(unresolved.sort()).toEqual([]);
  });

  it('leaves no listed document without a citation', () => {
    // CHANGED: EVERY listed document must carry one, rather than more than five
    // of them. A threshold could be met while a named document explained none
    // of itself, which is the property the list exists to hold — and it is a
    // different property from resolution, since a document that stopped citing
    // anything passes the sweep above trivially. DL-TEST-13.
    const silent = SIBLING_DOCUMENTS.filter(
      (path) => (read(path).match(CITATION_PATTERN) ?? []).length === 0,
    );

    expect(silent).toEqual([]);
    expect(SIBLING_DOCUMENTS.length).toBeGreaterThan(5);
  });
});

describe('every identifier is written with exactly two digits', () => {
  it('accepts no malformed ordinal in any citation', () => {
    const malformed: string[] = [];

    for (const [identifier, paths] of citations) {
      if (!WELL_FORMED.test(identifier)) {
        malformed.push(`${identifier} (${paths.join(', ')})`);
      }
    }

    expect(malformed.sort()).toEqual([]);
  });

  it('accepts no malformed ordinal in any row the log defines', () => {
    const malformed = definitions.filter(
      (identifier): boolean => !WELL_FORMED.test(identifier),
    );

    // A malformed ROW is the worse half: it defines the identifier, so every
    // citation of it resolves and nothing else in this file objects.
    expect(malformed.sort()).toEqual([]);
  });

  it('collected identifiers to judge, so neither check is vacuous', () => {
    expect(citations.size).toBeGreaterThan(0);
    expect(definitions.length).toBeGreaterThan(0);
  });
});

describe('the log defines each identifier exactly once', () => {
  it('carries no duplicate row', () => {
    const seen = new Map<string, number>();

    for (const identifier of definitions) {
      seen.set(identifier, (seen.get(identifier) ?? 0) + 1);
    }

    const duplicated = [...seen.entries()]
      .filter(([, count]) => count > 1)
      .map(([identifier, count]) => `${identifier} x${count}`)
      .sort();

    // A deviation's authoritative row stands in the deviations section and the
    // area section points at it, so an identifier appearing twice means two
    // authoritative statements of one decision.
    expect(duplicated).toEqual([]);
  });
});

describe('ordinals are contiguous from 01 within each area', () => {
  it('skips no ordinal and reuses none', () => {
    const byArea = new Map<string, number[]>();

    for (const identifier of definitions) {
      const area = areaOf(identifier);
      const ordinals = byArea.get(area) ?? [];

      ordinals.push(ordinalOf(identifier));
      byArea.set(area, ordinals);
    }

    const broken = [...byArea.entries()]
      .filter(([, ordinals]) => {
        const sorted = [...ordinals].sort((left, right) => left - right);

        return sorted.some((ordinal, index) => ordinal !== index + 1);
      })
      .map(
        ([area, ordinals]) =>
          `${area}: ${[...ordinals].sort((left, right) => left - right).join(',')}`,
      )
      .sort();

    expect(broken).toEqual([]);
  });
});

describe('every cited area is registered', () => {
  it('names each area in the CONTRIBUTING.md registry', () => {
    const areas = [...new Set([...citations.keys()].map(areaOf))].sort();
    const unregistered = areas.filter((area) => !registeredAreas.has(area));

    // The registry is described as the complete set, and a new area is to be
    // added in the same change that first uses it.
    expect(unregistered).toEqual([]);
  });

  it('read a registry that actually parsed', () => {
    expect(registeredAreas.size).toBeGreaterThan(60);
  });
});
