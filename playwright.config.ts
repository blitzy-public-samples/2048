// Playwright configuration for the recorded-gameplay proof (AAP R11 / V9).
//
// One project, `gameplay-recording`, drives the specs under tests/e2e/ in
// headless Chromium against the built static bundle and records a WebM of
// every test. tests/e2e/gameplay-recording.spec.ts is the spec it runs: run
// start, at least one stage clear, one reward-screen relic selection, then
// stage end or game over.
//
// CONFIGURED HERE
//   scope      testDir tests/e2e, *.spec.ts only. The unit suite
//              (tests/unit/**/*.test.ts) and the seeded snapshot gate
//              (tests/snapshot/**/*.spec.ts) run under vitest.config.ts and
//              vitest.snapshot.config.ts respectively; both of those configs
//              exclude tests/e2e/, and both of their subtrees are ignored
//              here.
//   video      mode 'on' — recorded for every test, passing or failing.
//              `size` repeats the viewport, so the frame is not scaled into
//              Playwright's default 800x800 box. Playwright writes each WebM
//              when the browser context closes, and the built-in `page`
//              fixture owns that context and closes it after the test.
//   viewport   1280x960. style/main.scss sets $field-width to 500px and
//              $mobile-threshold to 520px, so this records the desktop
//              layout, at its native size, with the board unscaled.
//   graphics   ANGLE with the SwiftShader backend, which makes WebGL 2.0
//              available to headless Chromium with no GPU present, plus the
//              two flags a containerised root browser needs.
//   motion     reducedMotion 'no-preference'. The relic-card entrance
//              animation in style/_reward.scss is declared only under that
//              value, and REDUCED_MOTION_QUERY in
//              src/render/webgl-support.ts gates the camera and particle
//              effects.
//   evidence   video, an end-of-test screenshot and a trace, all retained
//              on passing runs as well as failing ones. preserveOutput
//              'always' keeps the output directory of a passing test.
//   artifacts  outputDir test-results/ and HTML report playwright-report/.
//              Both are .gitignore entries, and both are the paths
//              .github/workflows/ci.yml uploads; the WebM is retained as a
//              build artifact rather than committed.
//   server     `npm run build` then `npm run preview` on vite.config.ts's
//              preview port, so the run exercises dist/ — the static bundle
//              R12 ships. PREVIEW_PORT overrides the port and BASE_URL the
//              whole origin; a server already answering on that URL is
//              reused outside CI.
//   pacing     one worker, no parallelism, no retries. The timeouts clear
//              the slowest cadence in style/main.scss — the terminal
//              overlay's 1200ms delay followed by its 800ms fade — many
//              times over.
//
// NOT CONFIGURED HERE
//   - firefox and webkit projects. Chromium is the only browser launched,
//     and it is the browser `npm run e2e:install` fetches.
//   - retry-scoped artifact modes ('on-first-retry', 'retain-on-failure').
//     No artifact here is conditioned on a failure or on a retry.
//   - globalSetup, globalTeardown and custom fixtures. Nothing here creates
//     a browser context, so nothing here can leave one unclosed and
//     unwritten.
//   - toHaveScreenshot thresholds and a snapshot directory. This project
//     stores no image baselines; its assertions read live page state,
//     including the canvas pixels.
//   - any CI-only condition on running the project. `npm run test:e2e`
//     produces the same recording on a workstation as it does in CI.
//   - test paths outside tests/e2e/. blitzy-deck/ and docs/ are not
//     reachable from this project.
//
// Rationale for every decision embodied here: docs/DECISION_LOG.md.
import { defineConfig, devices } from '@playwright/test';

// Port `npm run preview` is started on and polled at. vite.config.ts
// declares the same value as its `preview.port` default.
const DEFAULT_PREVIEW_PORT = 4173;
const PORT =
  Number.parseInt(process.env.PREVIEW_PORT ?? '', 10) || DEFAULT_PREVIEW_PORT;

// Origin the specs resolve their relative paths against, and the URL the web
// server is polled on.
const BASE_URL = process.env.BASE_URL ?? `http://127.0.0.1:${PORT}`;

// Viewport of the recording, reused verbatim as the video frame size.
const VIEWPORT = { width: 1280, height: 960 };

// Timing budget, in milliseconds. The longest wait a spec makes is the
// terminal overlay's 1200ms delay plus its 800ms fade; a full run is many
// moves, each with a 100ms transition and a 200ms spawn or merge animation
// that follows a 100ms delay, under a software renderer.
const TEST_TIMEOUT = 300_000;
const GLOBAL_TIMEOUT = 900_000;
const EXPECT_TIMEOUT = 20_000;
const ACTION_TIMEOUT = 30_000;
const NAVIGATION_TIMEOUT = 60_000;
const WEB_SERVER_TIMEOUT = 240_000;
const WEB_SERVER_SHUTDOWN_TIMEOUT = 10_000;

export default defineConfig({
  // Playwright's half of the three-way split with the two Vitest projects.
  // `testMatch` leaves the unit convention (*.test.ts) uncollected even for a
  // file placed under tests/e2e/, and `testIgnore` names the two Vitest
  // subtrees outright.
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  testIgnore: ['**/tests/unit/**', '**/tests/snapshot/**'],

  // Videos, screenshots and traces land here, one directory per test.
  outputDir: 'test-results',
  preserveOutput: 'always',

  timeout: TEST_TIMEOUT,
  globalTimeout: GLOBAL_TIMEOUT,
  expect: { timeout: EXPECT_TIMEOUT },

  // Serial execution: one worker, one recording being captured at a time.
  fullyParallel: false,
  workers: 1,
  retries: 0,

  // A stray `test.only` fails the run in CI rather than silently reducing it
  // to one test. Local runs keep `test.only` usable.
  forbidOnly: !!process.env.CI,

  // `open: 'never'` keeps the reporter from launching a browser of its own
  // when a run finishes.
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],

  use: {
    baseURL: BASE_URL,
    browserName: 'chromium',

    actionTimeout: ACTION_TIMEOUT,
    navigationTimeout: NAVIGATION_TIMEOUT,

    // The animation, camera and particle surfaces read this preference. It
    // reaches the browser context through `contextOptions`, which is where
    // Playwright exposes it to a config.
    contextOptions: {
      reducedMotion: 'no-preference',
    },

    // An end-of-test screenshot for every test. The trace carries the action
    // log, DOM snapshots and sources, and no screencast frames.
    screenshot: 'on',
    trace: {
      mode: 'on',
      screenshots: false,
      snapshots: true,
      sources: true,
    },

    launchOptions: {
      args: [
        // Software WebGL: ANGLE over SwiftShader, with the unsafe-swiftshader
        // switch that permits it for WebGL contexts.
        '--enable-unsafe-swiftshader',
        '--use-gl=angle',
        '--use-angle=swiftshader',

        // Container requirements: no user namespace for the sandbox, and
        // /dev/shm too small for Chromium's default shared-memory use.
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    },
  },

  projects: [
    {
      name: 'gameplay-recording',
      use: {
        // Desktop Chrome supplies deviceScaleFactor 1, so one CSS pixel is
        // one recorded pixel.
        ...devices['Desktop Chrome'],
        viewport: VIEWPORT,
        video: { mode: 'on', size: VIEWPORT },
      },
    },
  ],

  // `--strictPort` fails the step when the port is taken rather than moving
  // the server to another one.
  webServer: {
    name: 'vite preview',
    command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: WEB_SERVER_TIMEOUT,
    stdout: 'pipe',
    stderr: 'pipe',
    gracefulShutdown: {
      signal: 'SIGTERM',
      timeout: WEB_SERVER_SHUTDOWN_TIMEOUT,
    },
  },
});
