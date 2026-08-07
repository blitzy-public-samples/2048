// Seeded snapshot project. `npm run test:snapshot` runs it as `vitest run
// --config vitest.snapshot.config.ts`, and it is a gate of its own, separate
// from the unit gate `npm test` drives through vitest.config.ts.
//
// What the two projects collect, and how they stay disjoint:
//
//   this project      tests/snapshot/*.spec.ts   environment 'node'
//   vitest.config.ts  tests/unit/**/*.test.ts    environments 'node' + 'jsdom'
//   playwright        tests/e2e/*.spec.ts        driven by playwright.config.ts
//
// The two trees carry different file suffixes — `.spec.ts` here, `.test.ts`
// there — and each project also names the other's directory in `exclude`, so
// the separation holds on directory and on suffix independently.
//
// Snapshot writes: `update` is not set below, and package.json's
// `test:snapshot` script passes no update flag. Vitest resolves the mode from
// those two facts — `none` when it detects CI, `new` otherwise — so a snapshot
// that already exists is never rewritten by either invocation, and a
// mismatched or missing one fails the run under CI. Re-recording is the
// separate opt-in `vitest run --config vitest.snapshot.config.ts -u`.
//
// Globals: no option below installs, replaces or unstubs one, and none
// installs a fake clock. `update`, `fakeTimers`, `unstubGlobals` and
// `unstubEnvs` are absent from the project. `silent` is `false`, so a log
// record a spec asserts on reaches the reporter.
//
// Provenance of the behaviour the setup file compensates for, from the deleted
// vanilla sources:
//   js/local_storage_manager.js L61-L63  clearGameState() removes the board
//                                       snapshot; no member of the vanilla
//                                       manager removes the best score
//   js/local_storage_manager.js L25-L26  the writability probe runs once, at
//                                       construction
//   js/game_manager.js L36               setup() reads the snapshot once
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import { defineConfig } from 'vitest/config';

/* ===== 1. Snapshot file placement ===== */

/** Directory name Vitest writes a `.snap` file into. */
const SNAPSHOT_DIR_NAME = '__snapshots__';

/** Last segment of the directory holding the seeded specs. */
const SUITE_DIR_NAME = 'snapshot';

/** Segment preceding `SUITE_DIR_NAME`, which disambiguates it. */
const SUITE_PARENT_DIR_NAME = 'tests';

/** Matches either path separator, so a split covers POSIX and Windows. */
const PATH_SEPARATOR_PATTERN = /[/\\]/;

/**
 * Places every `.snap` file in `tests/snapshot/__snapshots__/`.
 *
 * Reproduces Vitest's own resolution — the `__snapshots__` directory beside
 * the spec, holding `<spec file name><extension>` — for a spec sitting
 * directly in `tests/snapshot/`, and collapses a spec found in a
 * subdirectory onto the same directory. Built from string operations only: no
 * Node built-in is imported and no Node global is read.
 *
 * @param testPath Absolute path of the spec file being snapshotted.
 * @param snapExtension Extension Vitest appends, including the leading dot.
 * @returns Absolute path of the spec's snapshot file.
 */
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

/**
 * The seeded specs, and nothing else. A single directory level, matching the
 * one directory `resolveSnapshotPath` writes snapshots to.
 */
const SNAPSHOT_INCLUDE: string[] = ['tests/snapshot/*.spec.ts'];

/**
 * Paths this project never collects from. Vitest's built-in exclusions are
 * replaced wholesale by this list, so node_modules and the build output are
 * repeated here alongside the two sibling test trees, the artifact
 * directories .gitignore covers, and the two blitzy directories.
 */
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

/**
 * Setup file loaded before each spec file is collected. It registers the
 * `afterEach` that removes every storage key the product owns, the best score
 * included, and exports the helpers that seed a fixture before the subject
 * under test is constructed. Its teardown is total in a DOM-free environment:
 * it returns without doing anything when the environment offers no Web
 * Storage, which is the case in this project. A spec that seeds storage
 * declares `// @vitest-environment jsdom` on its first line.
 */
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
