import { defineConfig, devices } from '@playwright/test';

// Recorded gameplay proof (AAP R11 / V9).
//
// Three configuration facts decide whether the gate can pass at all:
//   1. `video: 'on'` — NOT 'retain-on-failure'. The video is POSITIVE proof, so it
//      must be produced on a green run.
//   2. The viewport (and therefore the video frame) is sized deliberately. Playwright
//      scales the viewport to fit an 800x800 frame by default, which would shrink the
//      2.5D board below legibility.
//   3. Headless Chromium needs explicit software-GL flags or the WebGL canvas records
//      as a black rectangle — satisfying "non-zero duration" while failing every
//      visual criterion.
const VIEWPORT = { width: 1280, height: 960 };

const PORT = Number(process.env.PREVIEW_PORT ?? 4173);
const BASE_URL = process.env.BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  // Fewer parallel workers keeps the captured frame rate steady.
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: BASE_URL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: {
      args: [
        // Verified working software-GL stack for headless WebGL 2.0 in a container.
        '--enable-unsafe-swiftshader',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        // Required when running as root inside a container.
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    },
  },
  projects: [
    {
      name: 'gameplay-recording',
      use: {
        ...devices['Desktop Chrome'],
        viewport: VIEWPORT,
        video: { mode: 'on', size: VIEWPORT },
      },
    },
  ],
  // The gate runs against the STATIC PRODUCTION BUNDLE, which is what R12 ships.
  webServer: {
    command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
