// Unit test project. `npm test` runs it as `vitest run --config
// vitest.config.ts`, and it is the first automated quality gate the repository
// has: before this configuration existed there was no test runner, no fixture
// and no assertion library in the tree.
//
// It collects tests/unit/ and nothing else. The seeded snapshot suite under
// tests/snapshot/ is configured separately by vitest.snapshot.config.ts and run
// separately by `npm run test:snapshot`, and the Playwright specs under
// tests/e2e/ are driven by playwright.config.ts. Both trees are excluded below,
// and vitest.snapshot.config.ts excludes tests/unit/ in turn.
//
// The suite is split into two projects by the environment a test needs:
//
//   unit:dom-free  environment 'node'    tests/unit/{engine,config,rng,relics}
//   unit:dom       environment 'jsdom'   every other tests/unit directory
//
// The second project's `include` is the whole unit tree with the first
// project's globs subtracted, so the two partition tests/unit/ between them and
// a directory named in neither list is collected by unit:dom rather than
// skipped. A single file inside unit:dom-free that needs a document declares
// `// @vitest-environment jsdom` on its first line, which overrides the
// project's environment for that file alone.
//
// Both projects load tests/fixtures/storage.ts as a setup file. That module
// registers the `afterEach` that removes every storage key the product owns —
// the vanilla manager removed the board snapshot but never the best score —
// and exports the helpers that seed a fixture before the subject under test is
// constructed, which is the order the vanilla manager's construction-time
// probe and single snapshot read require.
//
// Nothing here installs fake timers, and no option below replaces or removes a
// global. A suite that needs either calls `vi.useFakeTimers()` or
// `vi.stubGlobal()` for itself and owns the matching restore, which leaves the
// assertion that `Math.random` is never patched measuring the product rather
// than this configuration.
//
// `resolve.alias` is absent, matching vite.config.ts, so a test resolves a
// module by the same relative specifier the application uses.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

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
 * passing unnoticed. The configuration, RNG and relic layers are data and
 * algorithms carrying the same property.
 */
const DOM_FREE_INCLUDE: string[] = [
  'tests/unit/engine/**/*.test.ts',
  'tests/unit/config/**/*.test.ts',
  'tests/unit/rng/**/*.test.ts',
  'tests/unit/relics/**/*.test.ts',
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
  // Test functions and assertions are imported from 'vitest' explicitly.
  globals: false,
  setupFiles: SETUP_FILES,
  // Call history is dropped, then a spy's original implementation is put back,
  // before each test.
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

    // The built-in reporter. No reporter package is added.
    reporters: ['default'],

    // Coverage is off. Vitest bundles no coverage provider and the dependency
    // set adds none, so `--coverage` reports a missing dependency and exits
    // non-zero until a provider package is installed. The directory named
    // here is the one .gitignore already covers, so a provider added later
    // writes where the repository expects it.
    coverage: {
      enabled: false,
      reportsDirectory: 'coverage',
    },

    // `watch` is deliberately absent. package.json keeps the two modes as
    // separate scripts: `test` runs `vitest run`, which completes and exits,
    // and `test:watch` runs `vitest`.
  },
});
