import { defineConfig } from 'vitest/config';

// Seeded snapshot regression gate (AAP R10 / V2), stored and configured SEPARATELY
// from the unit project so it can be run on its own: `npm run test:snapshot`.
//
// A fixed seed plus a fixed move list must reproduce an exact board state and an
// exact relic-offer sequence. The suite is DOM-free, so it runs in the `node`
// environment; snapshots live next to the specs in tests/snapshot/__snapshots__/.
export default defineConfig({
  test: {
    name: 'snapshot',
    environment: 'node',
    include: ['tests/snapshot/**/*.spec.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'tests/unit/**',
      'tests/e2e/**',
    ],
    globals: false,
    // A seeded gate must never silently rewrite its own expectations in CI.
    // Vitest resolves `updateSnapshot: 'none'` whenever CI is detected (and no
    // explicit `--update` is passed), so an obsolete or mismatched snapshot FAILS
    // the gate instead of being regenerated. Locally, `vitest run -u` is opt-in.
    reporters: ['default'],
  },
});
