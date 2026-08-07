// Seeded snapshot project. `npm run test:snapshot` runs it as `vitest run
// --config vitest.snapshot.config.ts`, and it is a gate of its own, separate
// from the unit gate `npm test` drives through vitest.config.ts.
//
// What the three projects collect, and how they stay disjoint:
//
//   this project      tests/snapshot/*.spec.ts   environment 'node'
//   vitest.config.ts  tests/unit/**/*.test.ts    environments 'node' + 'jsdom'
//   playwright        tests/e2e/*.spec.ts        driven by playwright.config.ts
//
// The trees carry different file suffixes — `.spec.ts` here, `.test.ts` there —
// and each project also names the other's directory in `exclude`, so the
// separation holds on directory and on suffix independently.
//
// SNAPSHOT WRITES: `update` is not set below and package.json's `test:snapshot`
// script passes no update flag, so Vitest resolves the mode from those two
// facts — `none` when it detects CI, `new` otherwise. An existing snapshot is
// never rewritten by either invocation, and a mismatched or missing one fails
// the run under CI. Re-recording is the separate opt-in `vitest run --config
// vitest.snapshot.config.ts -u`.
//
// No option below installs, replaces or unstubs a global, and none installs a
// fake clock. `silent` is `false`, so a log record a spec asserts on reaches
// the reporter.
//
// The behaviour the setup file compensates for, from the deleted vanilla
// sources: `clearGameState()` removed the board snapshot and no vanilla member
// removed the best score; the writability probe ran once at construction; and
// `setup()` read the snapshot once.

import { defineConfig } from 'vitest/config';

/* ===== 1. Snapshot file placement ===== */

const SNAPSHOT_DIR_NAME = '__snapshots__';

const SUITE_DIR_NAME = 'snapshot';

const SUITE_PARENT_DIR_NAME = 'tests';

const PATH_SEPARATOR_PATTERN = /[/\\]/;

function resolveSnapshotPath(testPath: string, snapExtension: string): string {
  const separator = testPath.includes('/') ? '/' : '\\';
  const segments = testPath.split(PATH_SEPARATOR_PATTERN);

  // `split` on a file path always yields at least one segment, and the last of
  // them is the file name. The fallback covers an empty input.
  const fileName = segments.pop() ?? testPath;

  // Index of the last `tests/snapshot` pair among the directory segments.
  let suiteDirIndex = -1;

  for (let index = segments.length - 1; index >= 1; index -= 1) {
    if (
      segments[index] === SUITE_DIR_NAME &&
      segments[index - 1] === SUITE_PARENT_DIR_NAME
    ) {
      suiteDirIndex = index;
      break;
    }
  }

  // With no such pair the spec is outside the suite directory, and the
  // directory beside it is used, matching Vitest's own resolution.
  const directorySegments =
    suiteDirIndex === -1 ? segments : segments.slice(0, suiteDirIndex + 1);

  return [
    ...directorySegments,
    SNAPSHOT_DIR_NAME,
    `${fileName}${snapExtension}`,
  ].join(separator);
}

/* ===== 2. Collected and excluded paths ===== */

const SNAPSHOT_INCLUDE: string[] = ['tests/snapshot/*.spec.ts'];

const SNAPSHOT_EXCLUDE: string[] = [
  '**/node_modules/**',
  '**/dist/**',
  '**/coverage/**',
  '**/test-results/**',
  '**/playwright-report/**',
  'blitzy/**',
  'blitzy-deck/**',
  'tests/unit/**',
  'tests/e2e/**',
];

const SNAPSHOT_SETUP_FILES: string[] = ['./tests/fixtures/storage.ts'];

/* ===== 3. Project ===== */

export default defineConfig({
  test: {
    name: 'snapshot',

    // No document is created. A spec needing one overrides this for itself
    // with a `@vitest-environment jsdom` docblock on its first line.
    environment: 'node',
    include: SNAPSHOT_INCLUDE,
    exclude: SNAPSHOT_EXCLUDE,
    setupFiles: SNAPSHOT_SETUP_FILES,

    // Test functions and assertions are imported from 'vitest' explicitly.
    globals: false,

    // Both are restorative: call history is dropped, then a spy's original
    // implementation is put back, before each test. Neither installs a spy.
    clearMocks: true,
    restoreMocks: true,

    resolveSnapshotPath,

    // A snapshot mismatch prints the full diff.
    expandSnapshotDiff: true,

    // Collecting no spec file exits non-zero.
    passWithNoTests: false,

    // The run completes and exits, under `vitest run` and under a bare
    // `vitest --config vitest.snapshot.config.ts` alike.
    watch: false,

    // A failed spec is not re-run.
    retry: 0,

    // Test output reaches the reporter.
    silent: false,

    // One child process at a time, each with its own module registry, files
    // in a stable order, tests and hooks in declaration order, and setup
    // files in the order listed above. No state carries from one spec file to
    // the next, and no ordering decision consumes randomness.
    pool: 'forks',
    isolate: true,
    fileParallelism: false,
    sequence: {
      shuffle: false,
      concurrent: false,
      setupFiles: 'list',
      hooks: 'stack',
    },

    // The built-in reporter. No reporter package is added.
    reporters: ['default'],

    // Coverage is off. Vitest bundles no coverage provider and the dependency
    // set adds none, so `--coverage` reports a missing dependency and exits
    // non-zero until a provider package is installed. The directory named
    // here is the one .gitignore already covers.
    coverage: {
      enabled: false,
      reportsDirectory: 'coverage',
    },
  },
});
