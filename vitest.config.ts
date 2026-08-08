// Unit test project. `npm test` runs it as `vitest run --config
// vitest.config.ts`.
//
// It collects tests/unit/ and nothing else. The seeded snapshot suite under
// tests/snapshot/ is configured separately by vitest.snapshot.config.ts and run
// separately by `npm run test:snapshot`, and the Playwright specs under
// tests/e2e/ are driven by playwright.config.ts. Both trees are excluded below,
// and vitest.snapshot.config.ts excludes tests/unit/ in turn.
//
// The suite is split into two projects by the environment a test needs:
//
//   unit:dom-free  environment 'node'    tests/unit/{engine,config,rng,relics,
//                                        run}
//   unit:dom       environment 'jsdom'   every other tests/unit directory
//
// The second project's `include` is the whole unit tree with the first
// project's globs subtracted, so the two partition tests/unit/ between them and
// a directory named in neither list is collected by unit:dom rather than
// skipped. Decision DL-TEST-01.
//
// A single file inside unit:dom-free that needs a document declares
// `// @vitest-environment jsdom` on its first line, which overrides the
// project's environment for that file alone.
//
// Both projects load tests/fixtures/storage.ts as a setup file. That module
// registers the `afterEach` that removes every storage key the product owns —
// js/local_storage_manager.js L61-L63 removed the board snapshot and never the
// best score — and exports the helpers that seed a fixture before the subject
// under test is constructed, which is the order js/local_storage_manager.js
// L25-L26's construction-time probe and js/game_manager.js L36's single
// snapshot read require. Decisions DL-FIXTURE-03 and DL-FIXTURE-04.
//
// Nothing here installs fake timers, and no option below replaces or removes a
// global. A suite that needs either calls `vi.useFakeTimers()` or
// `vi.stubGlobal()` for itself and owns the matching restore, which leaves the
// assertion that `Math.random` is never patched measuring the product rather
// than this configuration. Decision DL-TEST-02.
//
// `resolve.alias` is absent, matching vite.config.ts, so a test resolves a
// module by the same relative specifier the application uses. Decision
// DL-TEST-03.
//
// This file carries no ported construct: the repository held no test suite of
// any kind. One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every
// row of this file's area enumerated, all target-only:
//   TR-TEST-01  the two environment-split projects and their partitioning globs
//   TR-TEST-02  the shared setup file and the persistence teardown it registers
//   TR-TEST-03  the exclusions that keep the snapshot and Playwright trees out
//
// Decisions behind this file, argued in docs/DECISION_LOG.md and named here
// only so the construct can be found from the log:
//   DL-TEST-01  the unit tree partitioned by environment, with an unlisted
//               directory collected by unit:dom
//   DL-TEST-02  no fake timer installed and no global replaced by this
//               configuration
//   DL-TEST-03  `resolve.alias` absent, matching vite.config.ts

import { defineConfig } from 'vitest/config';

/**
 * Setup file both projects load before collecting a test file. It registers the
 * persistence teardown and exports the storage-fixture helpers.
 */
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

/**
 * Suites that run with no document. The engine is DOM-free as a requirement;
 * a test of it that reaches for a document fails in this project instead of
 * passing unnoticed. The configuration, RNG, relic and run layers are data and
 * algorithms carrying the same property: src/run/* reaches persistence through
 * an injected port and names no Web Storage global, so its suites belong here
 * and not in the catch-all jsdom project, where a module reaching for
 * `localStorage`, `window` or `document` would pass unnoticed.
 */
const DOM_FREE_INCLUDE: string[] = [
  'tests/unit/engine/**/*.test.ts',
  'tests/unit/config/**/*.test.ts',
  'tests/unit/rng/**/*.test.ts',
  'tests/unit/relics/**/*.test.ts',
  'tests/unit/run/**/*.test.ts',
];

/** Every unit suite, whatever environment it needs. */
const UNIT_INCLUDE: string[] = ['tests/unit/**/*.test.ts'];

/**
 * Options both projects share.
 *
 * The two mock options are restorative: each undoes what a test did to a spy,
 * and neither installs anything of its own. `unstubGlobals` and `unstubEnvs`
 * are left unset: a global a suite replaces in `beforeAll` survives to the
 * tests that read it, and the suite performs its own restore.
 */
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
    // separate scripts: `test` runs `vitest run`, which completes and exits,
    // and `test:watch` runs `vitest`.
  },
});
