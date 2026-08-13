// @vitest-environment node

// Read-only comment-policy gate over the tracked text sources.
//
// AAP 0.9.6 conflict C1 fixes what a comment in this repository may carry: the
// minimal-change clause requires every change to an existing file to be
// documented with a clear comment, and Rule 1 forbids rationale in code, so a
// comment carries WHAT changed, the contract or invariant it states, mechanical
// provenance and a decision-log pointer — while every why, alternative and risk
// lives in docs/DECISION_LOG.md. This gate holds the four properties of that
// division that a machine can check. Decision DL-TEST-17.
//
// The four rules, each with the reason it is checkable rather than a matter of
// taste:
//   a SITUATIONAL LABEL — one of the `SITUATIONAL_LABELS` words below, in
//   capitals and followed by a colon — dates a comment to one edit, so it reads
//   as a changelog entry rather than as a statement about the code;
//   a DECAPITATED SENTENCE is a comment paragraph opening on the tail of a
//   sentence an edit removed the head of;
//   an UNANCHORED LINE CITATION names a line of a file that still changes, so
//   it drifts silently and misdirects the next reader;
//   an UNRESOLVED IDENTIFIER is a `DL-` or `TR-` citation whose shape is wrong,
//   which the two bidirectional gates cannot resolve and therefore cannot see.
//
// COMMENT LINES ONLY. Every rule reads lines a comment marker opens, so a
// string literal that happens to hold one of these words — the runtime messages
// of src/render/particles.ts among them — is outside the gate.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/** Directories walked in full. */
const ROOTS: readonly string[] = ['src', 'tests', 'style'];

/** Individual files outside those roots that the gate also holds. */
const EXTRA_FILES: readonly string[] = [
  'index.html',
  'vite.config.ts',
  'vitest.config.ts',
  'vitest.snapshot.config.ts',
  'playwright.config.ts',
  'tsconfig.json',
  'tsconfig.node.json',
  '.github/workflows/ci.yml',
  'docs/dashboards/dashboard.html',
  'blitzy-deck/executive-summary.html',
];

/** Directory names never descended into. */
const SKIP_DIRECTORIES: ReadonlySet<string> = new Set([
  'fonts',
  'node_modules',
  'dist',
  'coverage',
  'test-results',
  'playwright-report',
  '__snapshots__',
]);

/** Extensions the gate reads. */
const TEXT_EXTENSIONS: readonly string[] = [
  '.ts',
  '.scss',
  '.html',
  '.json',
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

/** One file's path and its lines. */
interface SourceFile {
  readonly path: string;
  readonly lines: readonly string[];
}

/** Every tracked file, read once for every rule below. */
const SOURCES: readonly SourceFile[] = Object.freeze(
  TRACKED_FILES.map((path) =>
    Object.freeze({
      path,
      lines: Object.freeze(readFileSync(path, 'utf8').split('\n')),
    }),
  ),
);

/** Openers a comment line may begin with, across the five file kinds. */
const COMMENT_OPENERS: readonly string[] = ['//', '*', '/*', '<!--', '#'];

/**
 * Reports whether a line is a comment line.
 *
 * `#` counts only in YAML, where it is the comment marker; in SCSS it opens an
 * interpolation and in TypeScript a private member.
 *
 * @param line Line to classify.
 * @param path File the line belongs to.
 * @returns `true` when the line's first non-space characters open a comment.
 */
function isCommentLine(line: string, path: string): boolean {
  const trimmed = line.trim();

  if (trimmed.length === 0) {
    return false;
  }

  return COMMENT_OPENERS.some((opener) => {
    if (opener === '#') {
      return path.endsWith('.yml') && trimmed.startsWith('#');
    }

    return trimmed.startsWith(opener);
  });
}

/**
 * Every comment line of one file, with its one-based number.
 *
 * @param file File to read.
 * @returns The comment lines, in file order.
 */
function commentLines(
  file: SourceFile,
): readonly { readonly number: number; readonly text: string }[] {
  const found: { number: number; text: string }[] = [];

  file.lines.forEach((text, index) => {
    if (isCommentLine(text, file.path)) {
      found.push({ number: index + 1, text });
    }
  });

  return found;
}

/**
 * Collects the offences one rule finds across every tracked file.
 *
 * @param offends Reports the offending locations within one file, as strings
 *   already carrying the file path.
 * @returns Every offence found, across every file.
 */
function offences(offends: (file: SourceFile) => readonly string[]): string[] {
  return SOURCES.flatMap((file) => offends(file));
}

describe('the gate covers the tree it claims to', () => {
  it('reads the source, test, style and document trees', () => {
    // A gate that resolved no files would pass every rule below, so the corpus
    // is asserted before anything is asserted about it.
    expect(SOURCES.length).toBeGreaterThan(100);

    for (const path of [
      'src/main.ts',
      'tests/unit/quality/comment-policy.test.ts',
      'style/main.scss',
      'index.html',
      'docs/dashboards/dashboard.html',
    ]) {
      expect(SOURCES.some((file) => file.path === path)).toBe(true);
    }
  });

  it('finds comment lines in every file kind it reads', () => {
    for (const extension of TEXT_EXTENSIONS) {
      const withComments = SOURCES.filter(
        (file) =>
          file.path.endsWith(extension) && commentLines(file).length > 0,
      );

      expect(withComments.length).toBeGreaterThan(0);
    }
  });
});

/**
 * Words that turn a comment into a changelog entry when a colon follows.
 *
 * `SUPERSEDED` is absent from this list as a bare word: it is one of the four
 * provenance verbs docs/TRACEABILITY_MATRIX.md defines, so a row may state that
 * one construct superseded another. Its label forms — that word followed by a
 * colon, and that word followed by BY — are refused separately below.
 */
const SITUATIONAL_LABELS: readonly string[] = [
  'ADDED',
  'CHANGED',
  'REMOVED',
  'RENAMED',
  'REPLACED',
  'DELETED',
  'RETAINED',
  'KEPT',
  'MOVED',
  'MEASURED',
  'FIXED',
  'UPDATED',
  'TODO',
  'FIXME',
  'XXX',
  'HACK',
];

/** A situational label: one of those words, in capitals, then a colon. */
const LABEL_PATTERN = new RegExp(
  `(?<![A-Za-z])(?:${SITUATIONAL_LABELS.join('|')})\\s*:`,
  'u',
);

/** The two label forms of `SUPERSEDED`, which the provenance verb is not. */
const SUPERSEDED_LABEL = /\bSUPERSEDED\s*(?::|BY\b)/u;

describe('no comment is dated to one edit', () => {
  it('carries no situational label', () => {
    const found = offences((file) =>
      commentLines(file)
        .filter((line) => LABEL_PATTERN.test(line.text))
        .map(
          (line) =>
            `${file.path}:${line.number} carries a situational label: ` +
            `${line.text.trim()}`,
        ),
    );

    expect(found).toEqual([]);
  });

  it('uses SUPERSEDED as a provenance verb and never as a label', () => {
    const found = offences((file) =>
      commentLines(file)
        .filter((line) => SUPERSEDED_LABEL.test(line.text))
        .map(
          (line) =>
            `${file.path}:${line.number} labels rather than states: ` +
            `${line.text.trim()}`,
        ),
    );

    expect(found).toEqual([]);
  });
});

/** The comment markers a line's text is read from behind. */
const MARKERS: readonly string[] = ['<!--', '/**', '/*', '//', '*', '#'];

/**
 * The text of a comment line, with its marker taken off.
 *
 * @param line Line to read.
 * @returns The comment's own text, trimmed.
 */
function commentBody(line: string): string {
  const trimmed = line.trim();
  const marker = MARKERS.find((candidate) => trimmed.startsWith(candidate));

  return marker === undefined
    ? trimmed
    : trimmed.slice(marker.length).trim();
}

/**
 * A decapitated sentence: one to three all-letter lower-case words and then a
 * full stop, at the very start of a comment paragraph.
 *
 * Both halves are load-bearing. The SHAPE excludes everything a paragraph
 * legitimately opens lower-case with — a file path, a code sample, a table cell,
 * a continued list item — because each of those carries a dot, a slash, a
 * backtick, a colon or a digit inside its first words. The POSITION is what
 * makes it a fragment rather than a wrapped line: mid-paragraph, those same
 * words are the ordinary end of a sentence that began on the line above.
 */
const DECAPITATED = /^[a-z]+(?: [a-z]+){0,2}\.(?:\s|$)/u;

/**
 * Reports whether the line at `index` opens a comment paragraph.
 *
 * A paragraph opens after a non-comment line or after an empty comment line,
 * which is how every block in this repository separates one from the next.
 *
 * @param file File the line belongs to.
 * @param index Zero-based index of the line.
 * @returns `true` when the line begins a paragraph.
 */
function opensParagraph(file: SourceFile, index: number): boolean {
  if (index === 0) {
    return true;
  }

  const previous = file.lines[index - 1] ?? '';

  return (
    !isCommentLine(previous, file.path) || commentBody(previous).length === 0
  );
}

describe('no comment paragraph opens on the tail of a removed sentence', () => {
  it('recognises the shape it exists to refuse', () => {
    // The rule reports nothing on a clean tree, so the matcher is exercised
    // against the form directly: a fragment, and the four lower-case paragraph
    // openings that are not one.
    expect(DECAPITATED.test('any kind. One traceability row of')).toBe(true);
    expect(DECAPITATED.test('js/grid.js L109 wrote `null`.')).toBe(false);
    expect(DECAPITATED.test('style/main.scss declares the transition.')).toBe(
      false,
    );
    expect(DECAPITATED.test('the score a restore reinstates alongside')).toBe(
      false,
    );
    expect(DECAPITATED.test('stop();')).toBe(false);
  });

  it('leaves no decapitated sentence behind', () => {
    const found = offences((file) => {
      const reported: string[] = [];

      file.lines.forEach((text, index) => {
        if (!isCommentLine(text, file.path)) {
          return;
        }

        if (!DECAPITATED.test(commentBody(text))) {
          return;
        }

        if (!opensParagraph(file, index)) {
          return;
        }

        reported.push(
          `${file.path}:${index + 1} opens on a sentence tail: ` +
            `${text.trim()}`,
        );
      });

      return reported;
    });

    expect(found).toEqual([]);
  });
});

/**
 * Files whose line numbers cannot drift, because the files no longer exist.
 *
 * A citation into one of these resolves against the base commit
 * docs/TRACEABILITY_MATRIX.md names, and there is nothing left to move.
 */
const FROZEN_PATH = /^(?:js\/[\w.]+\.js|style\/main\.css|Rakefile|\.jshintrc)$/u;

/** A `<path> L<number>` citation, whatever the path. */
const CITATION = /([\w./-]+\.(?:ts|js|scss|css|html|json|md|yml))\s+L\d+/gu;

/**
 * The anchor that makes a citation into a LIVE file resolvable.
 *
 * A block naming the source branch states which tree its spans resolve
 * against, so the span is as stable as one into a deleted file. The two rows of
 * vite.config.ts that cite the retired script tags carry it.
 */
const BRANCH_ANCHOR = '(source branch)';

/** Comment lines either side of a citation that the anchor may sit on. */
const ANCHOR_RADIUS = 3;

describe('every line citation names something that cannot drift', () => {
  it('cites a live file by construct rather than by line', () => {
    const found = offences((file) => {
      const reported: string[] = [];

      for (const line of commentLines(file)) {
        for (const match of line.text.matchAll(CITATION)) {
          const cited = match[1] ?? '';

          if (FROZEN_PATH.test(cited)) {
            continue;
          }

          const near = file.lines
            .slice(
              Math.max(0, line.number - 1 - ANCHOR_RADIUS),
              line.number + ANCHOR_RADIUS,
            )
            .join('\n');

          if (near.includes(BRANCH_ANCHOR)) {
            continue;
          }

          reported.push(
            `${file.path}:${line.number} cites a line of a live file: ` +
              `${match[0]}`,
          );
        }
      }

      return reported;
    });

    expect(found).toEqual([]);
  });
});

/** A well-formed decision or traceability identifier. */
const WELL_FORMED = /^(?:DL|TR)-[A-Z0-9]+-\d{2}$/u;

/**
 * Anything shaped like one, including the malformed spellings.
 *
 * One digit, three digits and a lower-case area all match here and fail
 * `WELL_FORMED`, which is what makes a malformed citation visible: the two
 * bidirectional gates collect on the strict shape, so a citation written any
 * other way resolves against nothing and reports green.
 */
const IDENTIFIER_SHAPED = /\b(?:DL|TR)-[A-Za-z0-9]+-\d{1,3}\b/gu;

describe('every identifier citation is shaped so the other gates see it', () => {
  it('writes a two-digit ordinal and an upper-case area', () => {
    const found = offences((file) => {
      const reported: string[] = [];

      for (const line of commentLines(file)) {
        for (const match of line.text.matchAll(IDENTIFIER_SHAPED)) {
          const cited = match[0];

          if (!WELL_FORMED.test(cited)) {
            reported.push(
              `${file.path}:${line.number} cites a malformed identifier: ` +
                `${cited}`,
            );
          }
        }
      }

      return reported;
    });

    expect(found).toEqual([]);
  });

  it('finds the identifier citations it exists to shape-check', () => {
    // The rule above passes trivially on a corpus holding no citation at all,
    // so the corpus is asserted to hold them.
    const citing = SOURCES.filter((file) =>
      commentLines(file).some((line) => IDENTIFIER_SHAPED.test(line.text)),
    );

    expect(citing.length).toBeGreaterThan(20);
  });
});
