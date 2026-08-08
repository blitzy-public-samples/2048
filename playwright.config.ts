// Playwright configuration for the recorded-gameplay proof.
//
// The single project `gameplay-recording` runs in headless Chromium against the
// built static bundle. `testMatch` names one path,
// tests/e2e/gameplay-recording.spec.ts, so no other spec placed under
// tests/e2e/ can be collected into the video gate. The unit suite and the
// seeded snapshot gate run under their own Vitest configs and are ignored here.
//
// EXTERNAL CONSTRAINTS THE RECORDING SETTINGS SATISFY
//   - `video.mode: 'on'` records every test, passing or failing, and
//     `video.size` repeats the viewport; Playwright otherwise scales the frame
//     into an 800x800 box. The 1280x960 viewport records the desktop layout
//     unscaled: style/_tokens.scss declares $field-width as 500px and
//     $mobile-threshold as 520px, and style/main.scss consumes both through
//     @use.
//   - the WebM is written when the browser context closes. Nothing here creates
//     a context of its own; the built-in `page` fixture owns and closes it.
//   - the ANGLE/SwiftShader launch arguments below make WebGL 2.0 available
//     with no GPU present.
//
// This file carries no ported construct: the repository held no automation of
// any kind. One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every
// row of this file's area enumerated, all target-only:
//   TR-PW-01  the `gameplay-recording` project and its single `testMatch`
//   TR-PW-02  the recording settings and the software-GL launch arguments
//   TR-PW-03  the preview web server and its loopback-origin assertion
//
// Decisions behind this file, argued in docs/DECISION_LOG.md and named here
// only so the construct can be found from the log:
//   DL-PW-01  the recording settings that carry the proof
//   DL-PW-02  the loopback-origin assertion evaluated at config load
//
import { defineConfig, devices } from '@playwright/test';

// Port `npm run preview` is started on and polled at. vite.config.ts declares
// the same value as its `preview.port` default.
const PORT = 4173;

// Inclusive bounds of a TCP port number.
const MIN_PORT = 1;
const MAX_PORT = 65_535;

// Hosts that name this machine, and the protocols a recorded origin may use.
const LOOPBACK_HOSTNAMES: readonly string[] = [
  '127.0.0.1',
  '[::1]',
  'localhost',
];
const ALLOWED_PROTOCOLS: readonly string[] = ['http:', 'https:'];

/**
 * Asserts that `port` is a usable TCP port, and returns it unchanged.
 *
 * @param port Port to check.
 * @returns `port`, unchanged.
 * @throws {Error} If `port` is not a whole number in [MIN_PORT, MAX_PORT].
 */
function assertPreviewPort(port: number): number {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(
      `The preview port must be a whole number between ${MIN_PORT} and ` +
        `${MAX_PORT}, but it is ${JSON.stringify(port)}.`,
    );
  }

  return port;
}

/**
 * Asserts that `origin` is an HTTP or HTTPS URL on a loopback host, and returns
 * it in parsed form.
 *
 * Runs when this config is loaded, before any browser is launched and before any
 * server is started. A target that is not this machine's own preview server
 * throws here and no run begins. Decision DL-PW-02.
 *
 * @param origin Origin to check.
 * @returns The parsed form of `origin`.
 * @throws {Error} If `origin` is not a parseable URL, does not use HTTP or
 *   HTTPS, or names a host that is not a loopback host.
 */
function assertLoopbackOrigin(origin: string): string {
  let parsed: URL;

  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(
      `The recorded-gameplay origin must be an absolute URL, but it is ` +
        `${JSON.stringify(origin)}.`,
    );
  }

  if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
    throw new Error(
      `The recorded-gameplay origin must use HTTP or HTTPS; ` +
        `"${parsed.protocol}" is not accepted.`,
    );
  }

  if (!LOOPBACK_HOSTNAMES.includes(parsed.hostname)) {
    throw new Error(
      `The recorded-gameplay origin must be a loopback host; ` +
        `"${parsed.hostname}" is not one.`,
    );
  }

  // The parsed form, so neither surrounding whitespace nor a missing path
  // reaches `use.baseURL` and `webServer.url`.
  return parsed.href;
}

assertPreviewPort(PORT);

// Origin the spec resolves its relative paths against, and the URL the web
// server is polled on.
const BASE_URL = assertLoopbackOrigin(`http://127.0.0.1:${PORT}`);

// Viewport of the recording, reused verbatim as the video frame size. The
// desktop layout is 500px wide with a 520px mobile threshold, so the board
// records unscaled at its native size.
const VIEWPORT = { width: 1280, height: 960 };

// Timing budget, in milliseconds. The longest wait a spec makes is the
// terminal overlay's 1200ms delay plus its 800ms fade, and a full run is many
// moves of 100ms transitions and 200ms animations under a software renderer.
const TEST_TIMEOUT = 300_000;
const GLOBAL_TIMEOUT = 900_000;
const EXPECT_TIMEOUT = 20_000;
const ACTION_TIMEOUT = 30_000;
const NAVIGATION_TIMEOUT = 60_000;
const WEB_SERVER_TIMEOUT = 240_000;
const WEB_SERVER_SHUTDOWN_TIMEOUT = 10_000;

export default defineConfig({
  // Playwright's half of the three-way split with the two Vitest projects.
  // `testMatch` is the path of the one recorded-gameplay spec, so no other
  // file under tests/e2e/ — and nothing following the unit convention
  // (*.test.ts) — is collected into the video gate. `testIgnore` names the
  // two Vitest subtrees outright.
  testDir: 'tests/e2e',
  testMatch: '**/tests/e2e/gameplay-recording.spec.ts',
  testIgnore: ['**/tests/unit/**', '**/tests/snapshot/**'],

  // Videos, screenshots and traces land here, one directory per test.
  // `preserveOutput: 'always'` keeps a passing test's directory.
  outputDir: 'test-results',
  preserveOutput: 'always',

  timeout: TEST_TIMEOUT,
  globalTimeout: GLOBAL_TIMEOUT,
  expect: { timeout: EXPECT_TIMEOUT },

  // Serial execution: one recording is captured at a time.
  fullyParallel: false,
  workers: 1,
  retries: 0,

  // A stray `test.only` fails the run rather than silently reducing the gate to
  // one test, on a workstation exactly as in CI. Unconditional: this file reads
  // no CI variable.
  forbidOnly: true,

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

    // The animation, camera and particle surfaces read this preference;
    // `contextOptions` is where Playwright exposes it to a config.
    contextOptions: {
      reducedMotion: 'no-preference',
    },

    // An end-of-test screenshot for every test, and a trace carrying the
    // action log, DOM snapshots and sources with no screencast frames.
    screenshot: 'on',
    trace: {
      mode: 'on',
      screenshots: false,
      snapshots: true,
      sources: true,
    },

    launchOptions: {
      // The Chromium sandbox is disabled, expressed through Playwright's own
      // option rather than a launch argument, because the CI container runs
      // unprivileged and cannot grant the sandbox the namespaces it needs.
      // Nothing here restricts the origins a spec or a page script may
      // navigate to.
      chromiumSandbox: false,

      args: [
        // Software WebGL: ANGLE over SwiftShader, with the unsafe-swiftshader
        // switch that permits it for WebGL contexts.
        '--enable-unsafe-swiftshader',
        '--use-gl=angle',
        '--use-angle=swiftshader',

        // /dev/shm is too small for Chromium's default shared-memory use in
        // a container.
        '--disable-dev-shm-usage',
      ],
    },
  },

  projects: [
    {
      name: 'gameplay-recording',
      use: {
        // Desktop Chrome supplies deviceScaleFactor 1, so one CSS pixel is one
        // recorded pixel.
        ...devices['Desktop Chrome'],
        viewport: VIEWPORT,
        video: { mode: 'on', size: VIEWPORT },
      },
    },
  ],

  // `--strictPort` fails the step when the port is taken rather than moving the
  // server to another one, and `reuseExistingServer: false` means the recorded
  // bundle is always the one this run built.
  webServer: {
    name: 'vite preview',
    command:
      'npm run build && npm run preview -- ' +
      `--port ${PORT} --strictPort`,
    url: BASE_URL,

    // The proof gate always drives a server it started itself, so the
    // recording can never be made against a stale bundle left running by
    // something else.
    reuseExistingServer: false,
    timeout: WEB_SERVER_TIMEOUT,
    stdout: 'pipe',
    stderr: 'pipe',
    gracefulShutdown: {
      signal: 'SIGTERM',
      timeout: WEB_SERVER_SHUTDOWN_TIMEOUT,
    },
  },
});
