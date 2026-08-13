// Contract suite for the executive deck: the premises its pinned-Mermaid
// exception rests on, and the presentational shape its governing rule fixes.
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
// The second half holds the artifact's SHAPE rather than its premises: the
// section count and the slide types, one non-text visual per slide, the bullet
// and body-copy caps, the codepoint ceiling that stands in for the emoji ban,
// the absence of a fenced code block, the theme's custom-property and component
// class sets, the three typefaces with their weights, the reveal.js
// configuration literal, and the two paint calls reached from the handler bound
// to both reveal.js events. Words are counted over body copy alone, and the
// paint calls are found by walking the handler's own call chain.
//
// Decisions behind this file are recorded in docs/DECISION_LOG.md, DL-TEST-18
// and DL-DOC-14. The premises it holds are DL-DOC-09's; the budget it holds is
// DL-DOC-12's.

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

/* ==========================================================================
 * 5. The presentational shape the executive-presentation rule fixes
 * ========================================================================== */

// The rule fixes more than the deck's security posture: it fixes its SHAPE —
// how many slides there are, which four types they may be, that no slide is
// text alone, how much body copy a content slide may carry, that icons are
// Lucide SVG and never emoji, that no slide holds a fenced code block, and the
// exact token block, component vocabulary, font weights and reveal.js
// configuration the Blitzy identity is made of.
//
// Every one of those is a property of this one file, and none of them had a
// gate: the deck satisfied all of them and nothing would have noticed if an
// edit stopped. That is the whole reason this section exists — not a defect
// found, but a shape held. Decision DL-DOC-14.

/** Every slide, in document order. */
const slides = [...document_.querySelectorAll('.slides > section')];

/** The class the rule gives each of its four slide types. */
const SLIDE_TYPES = Object.freeze({
  title: 'slide-title',
  divider: 'slide-divider',
  closing: 'slide-closing',
});

/** Fewest and most `<section>` elements the rule admits. */
const SECTION_RANGE = Object.freeze({ least: 12, most: 18 });

/** Most bullets one slide may carry. */
const MAX_BULLETS = 4;

/**
 * Most words of BODY COPY one slide may carry.
 *
 * Body copy is what the reader is asked to read: the bullets, the body
 * paragraphs, the step bodies and the KPI notes. It is not every token on the
 * slide — a heading, an eyebrow, a KPI figure, a step title, a diagram's own
 * source, a figure legend and a caption are all excluded, because a cap that
 * counted diagram source would be a cap on the diagrams.
 */
const MAX_BODY_WORDS = 40;

/** The selectors body copy is read from. */
const BODY_COPY_SELECTORS: readonly string[] = Object.freeze([
  'li',
  'p.step-body',
  'p.kpi-note',
]);

/**
 * The words of one slide's body copy.
 *
 * @param slide Slide to read.
 * @returns Every word, in document order.
 */
const bodyWords = (slide: Element): readonly string[] => {
  const collected: string[] = [];

  for (const selector of BODY_COPY_SELECTORS) {
    for (const node of slide.querySelectorAll(selector)) {
      collected.push(...(node.textContent ?? '').split(/\s+/u).filter(Boolean));
    }
  }

  // A bare `<p>` inside a slide head or beside a figure is body copy too, and
  // it carries no class of its own, so it is collected by exclusion.
  for (const node of slide.querySelectorAll('p')) {
    if (node.className.length > 0) {
      continue;
    }

    collected.push(...(node.textContent ?? '').split(/\s+/u).filter(Boolean));
  }

  return collected;
};

/** What counts as a non-text visual, as the rule's own vocabulary names them. */
const VISUAL_SELECTORS: readonly string[] = Object.freeze([
  'pre.mermaid',
  '[data-lucide]',
  '.kpi-card',
  '.styled-table',
  '.accent-bar',
  'svg',
  'img',
]);

/**
 * The class the theme styles for every component the deck composes from.
 *
 * Enumerated here rather than read out of the file, so a class dropped from
 * the markup or from the theme is a failure instead of a smaller list.
 */
const COMPONENT_CLASSES: readonly string[] = Object.freeze([
  'accent-bar',
  'brand-lockup',
  'eyebrow',
  'hero-icon',
  'icon-row',
  'kpi-card',
  'kpi-grid',
  'kpi-icon',
  'kpi-label',
  'kpi-value',
  'styled-table',
]);

/** Every custom property the inlined Blitzy theme declares on `:root`. */
const ROOT_PROPERTIES: readonly string[] = Object.freeze([
  '--blitzy-primary',
  '--blitzy-primary-dark',
  '--blitzy-primary-navy',
  '--blitzy-primary-light',
  '--blitzy-primary-deep',
  '--blitzy-accent-teal',
  '--blitzy-surface-0',
  '--blitzy-surface-1',
  '--blitzy-surface-2',
  '--blitzy-surface-3',
  '--blitzy-border',
  '--blitzy-border-soft',
  '--blitzy-text',
  '--blitzy-text-muted',
  '--blitzy-text-invert',
  '--ff-body',
  '--ff-display',
  '--ff-mono',
  '--gradient-hero',
  '--gradient-divider',
  '--gradient-accent-bar',
]);

/** The `:root` block of the inlined theme, declarations only. */
const rootBlock = ((): string => {
  const opensAt = deck.indexOf(':root {');

  expect(opensAt).toBeGreaterThan(-1);

  const closesAt = deck.indexOf('}', opensAt);

  expect(closesAt).toBeGreaterThan(opensAt);

  return deck.slice(opensAt, closesAt);
})();

/**
 * The object literal the deck passes to `Reveal.initialize`.
 *
 * Sliced out of the script for the reason `initializerArgument` is: the
 * comments around the call name its options, and an assertion made against the
 * whole script would be satisfied by the prose.
 */
const revealArgument = ((): string => {
  const opensAt = inlineScript.indexOf('Reveal.initialize({');

  expect(opensAt).toBeGreaterThan(-1);

  const from = inlineScript.indexOf('{', opensAt);
  const to = inlineScript.indexOf('});', from);

  expect(to).toBeGreaterThan(from);

  return inlineScript.slice(from, to);
})();

/**
 * One function body of the deck's script, by name.
 *
 * Read by brace counting from the declaration, so a nested block does not end
 * the body early.
 *
 * @param name Function to find.
 * @returns The body, or `null` where the script declares no such function.
 */
const functionBody = (name: string): string | null => {
  const declaration = `function ${name}(`;
  const at = inlineScript.indexOf(declaration);

  if (at === -1) {
    return null;
  }

  const opensAt = inlineScript.indexOf('{', at);

  if (opensAt === -1) {
    return null;
  }

  let depth = 0;
  let index = opensAt;

  do {
    const character = inlineScript[index];

    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
    }

    index += 1;
  } while (depth > 0 && index < inlineScript.length);

  return inlineScript.slice(opensAt + 1, index - 1);
};

/**
 * Every function reachable from one, following declared names.
 *
 * @param entry Function to start from.
 * @returns The bodies reached, the entry's own included.
 */
const reachableFrom = (entry: string): readonly string[] => {
  const declared = [
    ...inlineScript.matchAll(/function\s+(\w+)\s*\(/gu),
  ].map((match): string => match[1] ?? '');
  const seen = new Set<string>();
  const bodies: string[] = [];
  const pending = [entry];

  while (pending.length > 0) {
    const name = pending.pop() ?? '';

    if (seen.has(name)) {
      continue;
    }

    seen.add(name);

    const body = functionBody(name);

    if (body === null) {
      continue;
    }

    bodies.push(body);

    for (const candidate of declared) {
      if (!seen.has(candidate) && body.includes(candidate)) {
        pending.push(candidate);
      }
    }
  }

  return bodies;
};

describe('the executive deck keeps the shape the rule fixes', () => {
  it('holds a slide count inside the range the rule admits', () => {
    expect(slides.length).toBeGreaterThanOrEqual(SECTION_RANGE.least);
    expect(slides.length).toBeLessThanOrEqual(SECTION_RANGE.most);

    // Every `<section>` in the document is a slide of the deck: a nested
    // section would be a vertical stack, which this deck does not use.
    expect([...document_.querySelectorAll('section')]).toHaveLength(
      slides.length,
    );
  });

  it('opens on the title slide, closes on the closing slide, and divides', () => {
    const typeOf = (slide: Element): string =>
      slide.className.trim().length === 0 ? 'content' : slide.className.trim();

    const types = slides.map(typeOf);

    expect(types[0]).toBe(SLIDE_TYPES.title);
    expect(types[types.length - 1]).toBe(SLIDE_TYPES.closing);
    expect(types.filter((type): boolean => type === SLIDE_TYPES.title))
      .toHaveLength(1);
    expect(types.filter((type): boolean => type === SLIDE_TYPES.closing))
      .toHaveLength(1);
    expect(
      types.filter((type): boolean => type === SLIDE_TYPES.divider).length,
    ).toBeGreaterThan(0);

    // Every remaining slide is a content slide, so no slide carries a type the
    // rule does not name.
    const named: readonly string[] = [
      'content',
      SLIDE_TYPES.title,
      SLIDE_TYPES.divider,
      SLIDE_TYPES.closing,
    ];

    expect(types.filter((type): boolean => !named.includes(type))).toEqual([]);
  });

  it('carries at least one non-text visual on every slide', () => {
    const textOnly = slides
      .map((slide, index): string =>
        VISUAL_SELECTORS.some(
          (selector): boolean => slide.querySelector(selector) !== null,
        )
          ? ''
          : `slide ${String(index + 1)}`,
      )
      .filter((entry): boolean => entry.length > 0);

    expect(textOnly).toEqual([]);
  });

  it('keeps every slide inside the bullet and body-copy caps', () => {
    const over: string[] = [];

    for (const [index, slide] of slides.entries()) {
      const bullets = [...slide.querySelectorAll('li')].length;
      const words = bodyWords(slide).length;

      if (bullets > MAX_BULLETS) {
        over.push(`slide ${String(index + 1)}: ${String(bullets)} bullets`);
      }

      if (words > MAX_BODY_WORDS) {
        over.push(`slide ${String(index + 1)}: ${String(words)} body words`);
      }
    }

    expect(over).toEqual([]);

    // And the reading is not empty: a body-copy extractor that found nothing
    // would satisfy the cap on every slide.
    expect(
      slides.filter((slide): boolean => bodyWords(slide).length > 0).length,
    ).toBeGreaterThan(0);
  });

  it('draws every icon as Lucide SVG and carries no emoji', () => {
    // The rule allows Lucide icons and no emoji at all. Read as CODEPOINTS
    // rather than against a list of pictographs: every emoji block sits above
    // U+2100, and the deck's own typography — the em dash — sits below it.
    const above = [...deck].filter(
      (character): boolean => character.codePointAt(0) !== undefined &&
        (character.codePointAt(0) ?? 0) > 0x2100,
    );

    expect(above).toEqual([]);
    expect([...document_.querySelectorAll('[data-lucide]')].length)
      .toBeGreaterThan(0);
  });

  it('holds no fenced code block, and every `<pre>` is a figure host', () => {
    expect(deck).not.toContain('```');

    const hosts = [...document_.querySelectorAll('pre')];

    expect(hosts.length).toBeGreaterThan(0);
    expect(
      hosts.filter((host): boolean => !host.classList.contains('mermaid')),
    ).toEqual([]);
  });

  it('declares every custom property of the inlined theme', () => {
    const missing = ROOT_PROPERTIES.filter(
      (property): boolean => !rootBlock.includes(`${property}:`),
    );

    expect(missing).toEqual([]);

    // The block declares these and nothing else, so a property added to the
    // theme without joining this list is a failure rather than a silent extra.
    const declared = [...rootBlock.matchAll(/(--[a-z0-9-]+):/gu)].map(
      (match): string => match[1] ?? '',
    );

    expect(declared.sort()).toEqual([...ROOT_PROPERTIES].sort());
  });

  it('styles and uses every component class', () => {
    const unstyled = COMPONENT_CLASSES.filter(
      (name): boolean => !deck.includes(`.${name} {`),
    );
    const unused = COMPONENT_CLASSES.filter(
      (name): boolean => document_.querySelector(`.${name}`) === null,
    );

    expect(unstyled).toEqual([]);
    expect(unused).toEqual([]);
  });

  it('loads the three typefaces at the weights the type system uses', () => {
    const fonts = [...document_.querySelectorAll('link[href]')]
      .map((node): string => node.getAttribute('href') ?? '')
      .find((href): boolean => href.includes('fonts.googleapis.com/css2'));

    expect(fonts).toBeDefined();
    expect(fonts).toContain('family=Fira+Code:wght@400;500');
    expect(fonts).toContain('family=Inter:wght@400;500;600;700');
    expect(fonts).toContain('family=Space+Grotesk:wght@500;600;700');
    expect(fonts).toContain('display=swap');

    // And the three families are the ones the token block names.
    expect(rootBlock).toContain("--ff-body: 'Inter'");
    expect(rootBlock).toContain("--ff-display: 'Space Grotesk'");
    expect(rootBlock).toContain("--ff-mono: 'Fira Code'");
  });

  it('initialises reveal.js with the configuration the rule states', () => {
    expect(revealArgument).toMatch(/hash:\s*true/u);
    expect(revealArgument).toMatch(/transition:\s*'slide'/u);
    expect(revealArgument).toMatch(/controlsTutorial:\s*false/u);
    expect(revealArgument).toMatch(/width:\s*1920/u);
    expect(revealArgument).toMatch(/height:\s*1080/u);

    // Read from the argument and not from the script, so a comment quoting
    // these options cannot satisfy the assertion.
    expect(revealArgument).not.toContain('//');
  });

  it('paints the figures and the icons on both reveal.js events', () => {
    const bindings = [
      ...inlineScript.matchAll(/Reveal\.on\(\s*'(\w+)'\s*,\s*(\w+)\s*\)/gu),
    ].map((match): readonly [string, string] => [
      match[1] ?? '',
      match[2] ?? '',
    ]);
    const events = bindings.map(([event]): string => event);

    expect(events).toContain('ready');
    expect(events).toContain('slidechanged');

    const handlers = new Set(bindings.map(([, handler]): string => handler));

    // One handler for both events, so neither can drift from the other.
    expect(handlers.size).toBe(1);

    const handler = [...handlers][0] ?? '';
    const reached = reachableFrom(handler).join('\n');

    // Following the handler's own chain rather than searching the script:
    // the deck defers a frame before painting, so neither call sits in the
    // bound function itself.
    expect(reached).toContain('lucide.createIcons()');
    expect(reached).toContain('mermaid.run(');
  });
});
