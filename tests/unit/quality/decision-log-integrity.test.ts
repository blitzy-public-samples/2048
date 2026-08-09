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
 * Directories the citation sweep descends into.
 *
 * The documentation tree is deliberately excluded: a document may reference an
 * identifier in prose — the coverage section names several — and a reference is
 * not a citation from code. What is asserted is that every identifier the
 * SHIPPING SOURCES and their tests cite resolves to a row.
 */
const CITING_ROOTS: readonly string[] = ['src', 'style', 'tests'];

/** Files the citation sweep reads, by extension. */
const CITING_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.scss',
  '.css',
  '.html',
]);

/** Single files at the root that may carry a citation. */
const CITING_FILES: readonly string[] = [
  'index.html',
  'vite.config.ts',
  'vitest.config.ts',
  'vitest.snapshot.config.ts',
  'playwright.config.ts',
];

/** Matches one decision identifier anywhere in a file. */
const CITATION_PATTERN = /DL-[A-Z0-9]+-\d+/gu;

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

/** Every file under one directory, recursively. */
const walk = (relativeDirectory: string): string[] => {
  const absolute = resolve(ROOT, relativeDirectory);
  const collected: string[] = [];

  for (const entry of readdirSync(absolute)) {
    const relative = join(relativeDirectory, entry);

    if (statSync(resolve(ROOT, relative)).isDirectory()) {
      collected.push(...walk(relative));

      continue;
    }

    collected.push(relative);
  }

  return collected;
};

/** Every identifier cited by the sources and their tests, to the files citing it. */
const citations = ((): Map<string, string[]> => {
  const found = new Map<string, string[]>();
  const paths = [
    ...CITING_ROOTS.flatMap((directory) => walk(directory)).filter((path) =>
      CITING_EXTENSIONS.has(extname(path)),
    ),
    ...CITING_FILES,
  ];

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
