// Contract suite for the document's Content Security Policy.
//
// index.html declares the policy as a `<meta http-equiv>` element, so the
// policy is a property of a tracked source file and is read from that file
// here. Nothing else in the tree verifies it: the type check does not read
// index.html's meta elements, and the suites that load the markup load it for
// its mount points.
//
// Four classes of fact are held:
//
//   the declaration       exactly one policy element, in `<head>`, ahead of
//                         every element it governs.
//   the directive set     every directive name and every source token, pinned
//                         exactly, so a widening is a diff in this file too.
//   the allowances        the three keywords that are not `'self'` or
//                         `'none'`, each asserted alongside the code or the
//                         build setting that requires it.
//   the absences          the directives a meta element silently ignores are
//                         not stated here but in README.md, and the markup
//                         and the sources carry nothing the policy blocks.
//
// The last class is what a policy regresses through: a policy stays correct
// while the code around it grows an inline handler, an `eval` or a Worker, and
// the failure surfaces only in a browser. Those three are read from the tree.
//
// Runs in the jsdom project, so the markup is parsed by a real `DOMParser`
// rather than matched with expressions. It reads the tree through `node:fs`,
// so it is type-checked under tsconfig.node.json like the two sibling gates.
//
// Decisions behind this file are recorded in docs/DECISION_LOG.md,
// DL-BUILD-15.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/* ==========================================================================
 * 1. What the suite reads
 * ========================================================================== */

/** Repository root, resolved from this file rather than from the cwd. */
const ROOT = resolve(import.meta.dirname, '..', '..', '..');

/** Reads one tracked file as UTF-8. */
const read = (relativePath: string): string =>
  readFileSync(resolve(ROOT, relativePath), 'utf8');

/** The markup the policy is declared in. */
const MARKUP = read('index.html');

/** The parsed document, parsed once for the whole file. */
const PARSED = new DOMParser().parseFromString(MARKUP, 'text/html');

/** Every policy element the document declares. */
const POLICY_ELEMENTS = PARSED.querySelectorAll(
  'meta[http-equiv="Content-Security-Policy"]',
);

/**
 * Splits a policy into its directives.
 *
 * Empty clauses are dropped, so a trailing `;` parses the same as none.
 *
 * @param policy Serialised policy string.
 * @returns Directive name to its source list, in declaration order.
 */
function parsePolicy(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();

  for (const clause of policy.split(';')) {
    const tokens = clause
      .trim()
      .split(/\s+/u)
      .filter((token) => token.length > 0);

    if (tokens.length === 0) {
      continue;
    }

    const [name, ...sources] = tokens;

    directives.set(name.toLowerCase(), sources);
  }

  return directives;
}

/** The declared policy, parsed. */
const POLICY = parsePolicy(
  POLICY_ELEMENTS[0]?.getAttribute('content') ?? '',
);

/**
 * Every `.ts` file under `src/`, read once.
 *
 * The three absence checks below scan the application sources, so they read
 * the tree the build compiles rather than the bundle it emits.
 */
const SOURCES: ReadonlyArray<readonly [string, string]> = ((): Array<
  [string, string]
> => {
  const collected: Array<[string, string]> = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(resolve(ROOT, directory)).sort()) {
      const relativePath = join(directory, entry);

      if (statSync(resolve(ROOT, relativePath)).isDirectory()) {
        walk(relativePath);
      } else if (entry.endsWith('.ts')) {
        collected.push([relativePath, read(relativePath)]);
      }
    }
  };

  walk('src');

  return collected;
})();

/* ==========================================================================
 * 2. The declaration
 * ========================================================================== */

describe('index.html declares one Content Security Policy', () => {
  it('declares the policy element exactly once', () => {
    expect(POLICY_ELEMENTS).toHaveLength(1);
  });

  it('declares it in the document head', () => {
    expect(POLICY_ELEMENTS[0]?.parentElement?.tagName).toBe('HEAD');
  });

  it('declares it ahead of every element it governs', () => {
    const elements = [...PARSED.querySelectorAll('*')];
    const policyAt = elements.indexOf(POLICY_ELEMENTS[0] as Element);
    const governed = [...PARSED.querySelectorAll('script, link')];

    expect(policyAt).toBeGreaterThanOrEqual(0);
    expect(governed.length).toBeGreaterThan(0);

    // A meta policy applies to what is parsed after it, so a `<link>` or
    // `<script>` placed above it would be fetched unpoliced.
    const above = governed
      .filter((element) => elements.indexOf(element) < policyAt)
      .map((element) => element.outerHTML);

    expect(above).toEqual([]);
  });
});

/* ==========================================================================
 * 3. The directive set
 * ========================================================================== */

/** The policy, pinned directive by directive and source by source. */
const EXPECTED: ReadonlyMap<string, readonly string[]> = new Map([
  ['default-src', ["'self'"]],
  ['base-uri', ["'self'"]],
  ['object-src', ["'none'"]],
  ['script-src', ["'self'"]],
  ['style-src', ["'self'", "'unsafe-inline'"]],
  ['img-src', ["'self'", 'data:']],
  ['font-src', ["'self'"]],
  ['connect-src', ["'self'"]],
  ['media-src', ["'none'"]],
  ['worker-src', ["'self'"]],
  ['form-action', ["'none'"]],
]);

describe('the policy declares exactly the intended directives', () => {
  it('declares every expected directive and no other', () => {
    expect([...POLICY.keys()].sort()).toEqual([...EXPECTED.keys()].sort());
  });

  it('declares each directive exactly once', () => {
    const names = MARKUP.includes('Content-Security-Policy')
      ? [...POLICY.keys()]
      : [];

    expect(new Set(names).size).toBe(names.length);
  });

  for (const [name, sources] of EXPECTED) {
    it(`declares \`${name}\` as \`${sources.join(' ')}\``, () => {
      expect(POLICY.get(name)).toEqual([...sources]);
    });
  }
});

/* ==========================================================================
 * 4. What the policy refuses
 * ========================================================================== */

describe('the policy refuses what it is meant to refuse', () => {
  it('falls back to the origin for every directive it omits', () => {
    expect(POLICY.get('default-src')).toEqual(["'self'"]);
  });

  it('admits no inline, no eval and no hash bypass for script', () => {
    const sources = POLICY.get('script-src') ?? [];

    expect(sources).toEqual(["'self'"]);
    expect(sources).not.toContain("'unsafe-inline'");
    expect(sources).not.toContain("'unsafe-eval'");
    expect(sources).not.toContain("'unsafe-hashes'");
    expect(sources).not.toContain("'strict-dynamic'");
  });

  it('denies plugin content, media and form submission outright', () => {
    expect(POLICY.get('object-src')).toEqual(["'none'"]);
    expect(POLICY.get('media-src')).toEqual(["'none'"]);
    expect(POLICY.get('form-action')).toEqual(["'none'"]);
  });

  it('admits no wildcard, no remote origin and no bare scheme but data:', () => {
    const permitted = new Set([
      "'self'",
      "'none'",
      "'unsafe-inline'",
      'data:',
    ]);

    const offenders: string[] = [];

    for (const [name, sources] of POLICY) {
      for (const source of sources) {
        if (!permitted.has(source)) {
          offenders.push(`${name} ${source}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

/* ==========================================================================
 * 5. The three allowances, each with the reason it is required
 * ========================================================================== */

describe('the policy allows exactly what the running code needs', () => {
  it('allows inline style, which the parallel board layer writes', () => {
    expect(POLICY.get('style-src')).toContain("'unsafe-inline'");

    // The parallel accessibility board positions each of its cells with an
    // inline style declaration, which `style-src-attr` inherits from
    // `style-src`. Removing the keyword would unposition that layer.
    const parallelBoard = read('src/ui/a11y/focus-manager.ts');

    expect(parallelBoard).toMatch(/\.style\.position = /u);
    expect(parallelBoard).toMatch(/\.style\.insetInlineStart = /u);
  });

  it('allows data: images, which the build inlines small assets as', () => {
    expect(POLICY.get('img-src')).toContain('data:');

    // Vite inlines an asset below `build.assetsInlineLimit` as a data URI.
    // The build sets no limit, so its default threshold applies and any
    // asset that falls under it arrives as a data URI.
    expect(read('vite.config.ts')).not.toMatch(/assetsInlineLimit/u);
  });

  it('allows same-origin connections, which the dev server needs', () => {
    // The development server's hot-module-replacement socket is same-origin,
    // so `'self'` admits it and no `ws:` source is required.
    expect(POLICY.get('connect-src')).toEqual(["'self'"]);
  });
});

/* ==========================================================================
 * 6. What the policy deliberately does not state
 * ========================================================================== */

describe('the policy states no directive a meta element ignores', () => {
  /** Directives a browser discards when they arrive in a meta element. */
  const IGNORED_IN_META: readonly string[] = [
    'frame-ancestors',
    'report-uri',
    'report-to',
    'sandbox',
  ];

  for (const name of IGNORED_IN_META) {
    it(`omits \`${name}\``, () => {
      expect(POLICY.has(name)).toBe(false);
    });
  }

  it('documents the two a host should send as headers instead', () => {
    const readme = read('README.md');

    expect(readme).toContain('frame-ancestors');
    expect(readme).toContain('report-to');
  });
});

/* ==========================================================================
 * 7. Nothing in the tree the policy would block
 * ========================================================================== */

describe('the markup carries nothing `script-src` would block', () => {
  it('carries no inline script body', () => {
    const inline = [...PARSED.querySelectorAll('script')].filter(
      (element) =>
        element.getAttribute('src') === null ||
        element.textContent?.trim() !== '',
    );

    expect(inline.map((element) => element.outerHTML)).toEqual([]);
  });

  it('carries no event-handler attribute', () => {
    const offenders: string[] = [];

    for (const element of PARSED.querySelectorAll('*')) {
      for (const attribute of element.attributes) {
        if (/^on[a-z]+$/u.test(attribute.name)) {
          offenders.push(`${element.tagName} ${attribute.name}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('carries no `javascript:` URL', () => {
    expect(MARKUP.toLowerCase()).not.toContain('javascript:');
  });
});

describe('the sources carry nothing the policy would block', () => {
  it('constructs no Worker, which `worker-src` admits no blob for', () => {
    // `worker-src 'self'` does not admit a `blob:` script, which is how a
    // Worker is normally constructed from generated source. No module
    // constructs one, so the directive bounds nothing the code does.
    const offenders = SOURCES.filter(([, source]) =>
      /new\s+(?:Shared)?Worker\s*\(/u.test(source),
    ).map(([path]) => path);

    expect(offenders).toEqual([]);
  });

  it('calls no `eval` and constructs no `Function`', () => {
    // `script-src 'self'` carries no `'unsafe-eval'`, so either would throw at
    // runtime.
    const offenders = SOURCES.filter(([, source]) =>
      /(?:^|[^.\w])eval\s*\(|new\s+Function\s*\(/u.test(source),
    ).map(([path]) => path);

    expect(offenders).toEqual([]);
  });

  it('fetches nothing from an origin the policy does not admit', () => {
    // Every request the bundle makes is same-origin. A remote URL in a
    // fetch, an import or an asset reference would be refused by
    // `default-src 'self'`.
    const offenders: string[] = [];

    for (const [path, source] of SOURCES) {
      for (const match of source.matchAll(/https?:\/\/[^\s'"`)]+/gu)) {
        // A URL inside a comment is prose, not a request. The sources cite
        // specifications and the upstream repository in their comments.
        const lineStart = source.lastIndexOf('\n', match.index) + 1;
        const line = source.slice(lineStart, source.indexOf('\n', match.index));

        if (!/^\s*(?:\/\/|\*|\/\*)/u.test(line)) {
          offenders.push(`${path}: ${match[0]}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
