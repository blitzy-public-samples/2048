// Contract suite for the executive deck's security premises.
//
// blitzy-deck/executive-summary.html loads three pinned libraries from a CDN and
// draws five Mermaid figures. `DL-DOC-09` keeps the pinned Mermaid release the
// executive-presentation rule states, records that the release sits inside
// published advisory ranges, and rests its exception on premises that are all
// properties of the FILE:
//
//   authored source     every `pre.mermaid` host carries diagram source written
//                       inline in a slide of this deck.
//   no source at run    the deck fetches nothing, imports nothing dynamically,
//                       and evaluates no text, so no diagram source can arrive
//                       from anywhere else.
//   verified bytes      every jsdelivr resource carries a `sha384` integrity
//                       hash with `crossorigin="anonymous"`.
//   stated posture      Mermaid is initialised with `startOnLoad: false`,
//                       `securityLevel: 'strict'` and `htmlLabels: false`.
//   honest inventory    the counts and versions `DL-DOC-09` states in prose are
//                       the deck's own.
//
// The last class is why this file exists. The row claimed FOUR authored sources
// while the deck had five, and nothing in the repository could tell: the
// exception's own premise was misstated in the document that grants it. Holding
// the prose against the file makes the inventory self-correcting.
//
// Read-only: the deck and the decision log are opened through `node:fs` and
// nothing is written. The markup is parsed with `DOMParser`, so the hosts are
// counted as a browser sees them rather than matched with an expression; the
// script text is read as text, because what is asserted of it is the ABSENCE of
// constructs, which a parser cannot report.
//
// Decisions behind this file are recorded in docs/DECISION_LOG.md, DL-TEST-18.
// The premises it holds are DL-DOC-09's.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/* ==========================================================================
 * 1. What the suite reads
 * ========================================================================== */

/** Repository root, resolved from this file rather than from the cwd. */
const ROOT = resolve(import.meta.dirname, '..', '..', '..');

const DECK_PATH = 'blitzy-deck/executive-summary.html';

const LOG_PATH = 'docs/DECISION_LOG.md';

const deck = readFileSync(resolve(ROOT, DECK_PATH), 'utf8');

const log = readFileSync(resolve(ROOT, LOG_PATH), 'utf8');

/** The deck's markup, parsed as a browser parses it. */
const document_ = new DOMParser().parseFromString(deck, 'text/html');

/** Every Mermaid figure host, in document order. */
const hosts = [...document_.querySelectorAll('pre.mermaid')];

/** Every resource the deck loads from the pinned CDN. */
const cdnElements = [...document_.querySelectorAll('script[src], link[href]')]
  .filter((node): boolean => {
    const url =
      node.getAttribute('src') ?? node.getAttribute('href') ?? '';

    return url.includes('cdn.jsdelivr.net');
  });

/** The row `DL-DOC-09` occupies, whole. */
const exceptionRow = ((): string => {
  const row = log
    .split('\n')
    .find((line): boolean => line.startsWith('| `DL-DOC-09` |'));

  if (row === undefined) {
    throw new Error('DL-DOC-09 defines no row');
  }

  return row;
})();

/**
 * The English words for the counts this suite states in prose.
 *
 * The row is written for a reader, so it says "five sources" rather than "5",
 * and the gate holds the word. Nine is the ceiling because a deck with ten
 * figures would exceed the rule's slide budget long before it reached one.
 */
const NUMBER_WORDS: readonly string[] = Object.freeze([
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
]);

/**
 * The English word for a count.
 *
 * @param count Count to name.
 * @returns The word.
 */
const wordFor = (count: number): string => {
  const word = NUMBER_WORDS[count];

  if (word === undefined) {
    throw new Error(`no word for ${String(count)}`);
  }

  return word;
};

/**
 * The version a pinned jsdelivr URL names.
 *
 * @param url URL to read.
 * @returns The version, or `null` where the URL carries none.
 */
const versionOf = (url: string): string | null =>
  /\/npm\/[^@/]+@([^/]+)\//u.exec(url)?.[1] ?? null;

/**
 * One pinned package's version, read off the deck's own tag.
 *
 * @param packageName Package to find.
 * @returns The pinned version.
 */
const pinnedVersion = (packageName: string): string => {
  for (const element of cdnElements) {
    const url = element.getAttribute('src') ?? element.getAttribute('href') ?? '';

    if (url.includes(`/npm/${packageName}@`)) {
      const version = versionOf(url);

      if (version !== null) {
        return version;
      }
    }
  }

  throw new Error(`the deck pins no ${packageName}`);
};

/** The deck's own inline script, which is the only one it declares. */
const inlineScript = ((): string => {
  const scripts = [...document_.querySelectorAll('script')].filter(
    (node): boolean => !node.hasAttribute('src'),
  );

  expect(scripts).toHaveLength(1);

  return scripts[0]?.textContent ?? '';
})();

/**
 * The object literal the deck passes to `mermaid.initialize`.
 *
 * Sliced out of the script rather than matched against the whole of it, because
 * the comments above the call quote every option it sets: an assertion made
 * against the script as a whole is satisfied by the prose and would pass a deck
 * that had stopped setting them. DL-TEST-18.
 */
const initializerArgument = ((): string => {
  const opensAt = inlineScript.indexOf('mermaid.initialize({');

  expect(opensAt).toBeGreaterThan(-1);

  const from = inlineScript.indexOf('{', opensAt);
  const to = inlineScript.indexOf('});', from);

  expect(to).toBeGreaterThan(from);

  return inlineScript.slice(from, to);
})();

/* ==========================================================================
 * 2. Authored diagram source
 * ========================================================================== */

describe('every figure of the executive deck is authored in it', () => {
  it('holds five Mermaid hosts, which is what the exception counts', () => {
    // The count is asserted against the row below rather than against a literal,
    // so this one guards only that the parse found figures at all.
    expect(hosts.length).toBeGreaterThan(0);
  });

  it('carries every diagram source inline, inside a slide', () => {
    const problems: string[] = [];

    for (const [index, host] of hosts.entries()) {
      const source = (host.textContent ?? '').trim();

      if (source.length === 0) {
        problems.push(`figure ${String(index + 1)} carries no source`);
      }

      // A host that names a source elsewhere is the premise's exact negation.
      for (const attribute of ['src', 'data-src', 'data-mermaid-src', 'href']) {
        if (host.hasAttribute(attribute)) {
          problems.push(
            `figure ${String(index + 1)} names a source through ${attribute}`,
          );
        }
      }

      if (host.closest('section') === null) {
        problems.push(`figure ${String(index + 1)} sits outside a slide`);
      }
    }

    expect(problems).toEqual([]);
  });

  it('reaches for nothing at run time', () => {
    // The premise is an ABSENCE, so it is read off the script's text: a parser
    // reports what is there and cannot report what is not.
    const forbidden: readonly { readonly name: string; readonly pattern: RegExp }[] =
      Object.freeze([
        { name: 'fetch', pattern: /\bfetch\s*\(/u },
        { name: 'XMLHttpRequest', pattern: /\bXMLHttpRequest\b/u },
        { name: 'dynamic import', pattern: /\bimport\s*\(/u },
        { name: 'eval', pattern: /\beval\s*\(/u },
        { name: 'new Function', pattern: /\bnew\s+Function\s*\(/u },
        { name: 'document.write', pattern: /\bdocument\s*\.\s*write\b/u },
      ]);

    const found = forbidden
      .filter((entry): boolean => entry.pattern.test(inlineScript))
      .map((entry): string => entry.name);

    expect(found).toEqual([]);
  });

  it('restores a figure only from the source it captured', () => {
    // One capture, one restore, and the restore reads the captured array. A
    // second writer into a host would be a second way source could arrive.
    expect(inlineScript).toContain('function captureFigureSource()');
    expect(inlineScript).toContain('host.innerHTML = source;');
    expect(inlineScript).toContain('source = sourceOf(host);');

    // Two writers reach a host — the authored-figure gate that puts a replaced
    // source back, and the error-recovery path that redraws a figure that failed
    // — and what matters is that BOTH assign the captured source. A write of
    // anything else would be a second way source could arrive.
    const writes = inlineScript.match(/\.innerHTML\s*=[^;]*/gu) ?? [];

    expect(writes.length).toBeGreaterThan(0);
    expect(
      writes.filter((write): boolean => write.trim() !== '.innerHTML = source'),
    ).toEqual([]);
  });
});

/* ==========================================================================
 * 3. Verified bytes and the stated Mermaid posture
 * ========================================================================== */

describe('the executive deck verifies every byte it loads', () => {
  it('carries a sha384 hash and anonymous CORS on every CDN resource', () => {
    const problems: string[] = [];

    expect(cdnElements.length).toBeGreaterThan(0);

    for (const element of cdnElements) {
      const url =
        element.getAttribute('src') ?? element.getAttribute('href') ?? '';
      const integrity = element.getAttribute('integrity') ?? '';

      if (!integrity.startsWith('sha384-')) {
        problems.push(`${url} carries no sha384 integrity hash`);
      }

      if (element.getAttribute('crossorigin') !== 'anonymous') {
        problems.push(`${url} is not requested with anonymous CORS`);
      }

      if (versionOf(url) === null) {
        problems.push(`${url} is not pinned to a version`);
      }
    }

    expect(problems).toEqual([]);
  });

  it('states the Mermaid posture the exception relies on', () => {
    // Read out of the INITIALISER, not out of the script as a whole: the
    // comments above that call name each option too, and an assertion the
    // comments satisfy would pass a deck that had stopped setting them.
    expect(initializerArgument).toMatch(/startOnLoad:\s*false/u);
    expect(initializerArgument).toMatch(/securityLevel:\s*'strict'/u);
    expect(initializerArgument).toMatch(/htmlLabels:\s*false/u);

    // And no comment stands in for the initialiser: what was read is the object
    // the deck passes.
    expect(initializerArgument).not.toContain('//');
  });
});

/* ==========================================================================
 * 4. The exception's inventory, held against the deck
 * ========================================================================== */

describe('DL-DOC-09 states the deck it grants an exception to', () => {
  it('counts the authored sources the deck actually has', () => {
    // THE UNDERCOUNT THIS GATE EXISTS FOR: the row said four sources while the
    // deck had five, and the exception rests on that count.
    expect(exceptionRow).toContain(
      `${wordFor(hosts.length)} sources authored in the file`,
    );
  });

  it('counts the drawn figures the same way DL-DOC-07 does', () => {
    // The same undercount reached a SECOND row: the drawing decision said four
    // figures were drawn this way. One count, held in both places it is stated.
    const drawingRow = log
      .split('\n')
      .find((line): boolean => line.startsWith('| `DL-DOC-07` |'));

    expect(drawingRow).toBeDefined();

    // Compared in lower case: the count opens a sentence in one place and sits
    // mid-sentence in the other, and the assertion is about the NUMBER.
    const stated = (drawingRow ?? '').toLowerCase();

    expect(stated).toContain(
      `${wordFor(hosts.length)} figures are drawn this way`,
    );
    expect(stated).toContain(`the ${wordFor(hosts.length)} hosts are static`);
  });

  it('counts the integrity hashes the deck actually carries', () => {
    const hashes = [...document_.querySelectorAll('[integrity]')].length;

    expect(hashes).toBe(cdnElements.length);
    expect(exceptionRow).toContain(`${wordFor(hashes)} hashes`);
  });

  it('names every pinned version the deck loads', () => {
    expect(exceptionRow).toContain(`reveal.js ${pinnedVersion('reveal.js')}`);
    expect(exceptionRow).toContain(`Mermaid ${pinnedVersion('mermaid')}`);
    expect(exceptionRow).toContain(`Lucide ${pinnedVersion('lucide')}`);
  });

  it('names no Mermaid release above the one the deck pins', () => {
    const pinned = pinnedVersion('mermaid');
    const targets = [...exceptionRow.matchAll(/\b11\.\d+\.\d+\b/gu)].map(
      (match): string => match[0],
    );

    // Read as numbers rather than as text, so `11.16.1` is not judged lower than
    // `11.4.0` by a string comparison — which is how a stale escalation target
    // would slip through unnoticed.
    const rank = (version: string): number => {
      const parts = version.split('.').map((part): number => Number(part));

      return (
        (parts[0] ?? 0) * 1000000 + (parts[1] ?? 0) * 1000 + (parts[2] ?? 0)
      );
    };

    const above = targets.filter(
      (version): boolean => rank(version) > rank(pinned),
    );

    // The deck pins the patched release, so the row has nothing outstanding to
    // point at: a version named above the pin would be an unclosed obligation
    // the register claims is closed. The rule's own ordinal is named, and it
    // sits below the pin, which is the deviation this row exists to record.
    expect(targets).toContain(pinned);
    expect(above).toEqual([]);
    expect(
      targets.filter((version): boolean => rank(version) < rank(pinned)).length,
    ).toBeGreaterThan(0);
  });

  it('states the recompute obligation a moved pin carries', () => {
    // An SRI hash is byte-exact, so a pin moved without its hash recomputed
    // loses every diagram. The row has to say so, because the gate cannot fetch
    // the bytes to check.
    expect(exceptionRow).toContain('recompute');
    expect(exceptionRow).toMatch(/sha384/u);
  });

  it('marks its governance state rather than reading as compliance', () => {
    // The deck states a version its governing rule does not, so the row has to
    // say both that it departs from the rule and where that departure now
    // stands. A row that said neither would read as compliance.
    expect(exceptionRow).toContain('DEVIATION');
    expect(exceptionRow).toContain('RESOLVED');
  });
});
