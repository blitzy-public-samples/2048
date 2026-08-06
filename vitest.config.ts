import { defineConfig } from 'vitest/config';

// Unit test project (AAP R10). Covers the DOM-free engine, config layer, relic
// handlers, stage-goal evaluation, reward drawing, RNG determinism, run-state
// versioning and the frozen best-score contract.
//
// The seeded snapshot suite is deliberately kept OUT of this project so it can run
// as an independent regression gate — see vitest.snapshot.config.ts.
export default defineConfig({
  test: {
    name: 'unit',
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'tests/snapshot/**',
      'tests/e2e/**',
    ],
    globals: false,
    restoreMocks: true,
    clearMocks: true,
    reporters: ['default'],
  },
});
