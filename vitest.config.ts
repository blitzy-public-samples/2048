// Unit test project. `npm test` runs it as `vitest run --config
// vitest.config.ts`.
//
// The suite is split into two projects by the environment a test needs.
//
// unit:dom-free environment 'node' tests/unit/{engine,config,rng,relics, run}
// unit:dom environment 'jsdom' every other tests/unit directory
//
// A single file inside unit:dom-free that needs a document declares `//
// @vitest-environment jsdom` on its first line, which overrides the project's
// environment for that file alone.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
// this file's area enumerated, all target-only:
//   TR-TEST-01  the two environment-split projects and their partitioning globs
//   TR-TEST-02  the shared setup file and the persistence teardown it registers
//   TR-TEST-03  the exclusions that keep the snapshot and Playwright trees out
//
// Decisions: DL-TEST-01, DL-FIXTURE-03, DL-FIXTURE-04, DL-TEST-02, DL-TEST-03
// (docs/DECISION_LOG.md).

import { defineConfig } from 'vitest/config';

/** Setup file both projects load before collecting a test file. */
const SETUP_FILES: string[] = ['./tests/fixtures/storage.ts'];

/**
 * Paths no unit project collects from. Vitest's built-in exclusions are
 * replaced wholesale by this list, so node_modules and the build output are
 * repeated here alongside the two sibling test trees, the artifact directories
 * .gitignore covers, and the two blitzy directories.
 */
const SHARED_EXCLUDE: string[] = [
  '**/node_modules/**',
  '**/dist/**',
  '**/coverage/**',
  '**/test-results/**',
  '**/playwright-report/**',
  'blitzy/**',
  'blitzy-deck/**',
  'tests/snapshot/**',
  'tests/e2e/**',
];

/** Suites that run with no document. */
const DOM_FREE_INCLUDE: string[] = [
  'tests/unit/engine/**/*.test.ts',
  'tests/unit/config/**/*.test.ts',
  'tests/unit/rng/**/*.test.ts',
  'tests/unit/relics/**/*.test.ts',
  'tests/unit/run/**/*.test.ts',
];

/** Every unit suite, whatever environment it needs. */
const UNIT_INCLUDE: string[] = ['tests/unit/**/*.test.ts'];

/** Options both projects share. */
const SHARED_TEST_OPTIONS = {
  globals: false,
  setupFiles: SETUP_FILES,
  clearMocks: true,
  restoreMocks: true,
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...SHARED_TEST_OPTIONS,
          name: 'unit:dom-free',
          environment: 'node',
          include: DOM_FREE_INCLUDE,
          exclude: SHARED_EXCLUDE,
        },
      },
      {
        test: {
          ...SHARED_TEST_OPTIONS,
          name: 'unit:dom',
          environment: 'jsdom',
          include: UNIT_INCLUDE,
          exclude: [...SHARED_EXCLUDE, ...DOM_FREE_INCLUDE],
        },
      },
    ],

    reporters: ['default'],

    coverage: {
      enabled: false,
      reportsDirectory: 'coverage',
    },

    // `watch` is deliberately absent. package.json keeps the two modes as
    // separate scripts.
  },
});
