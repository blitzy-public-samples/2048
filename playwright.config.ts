// Playwright configuration for the recorded-gameplay proof.
//
// Decisions: DL-PW-01, DL-PW-02 (docs/DECISION_LOG.md).
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
 * Asserts that `origin` is an HTTP or HTTPS URL on a loopback host, and
 * returns it in parsed form.
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

// Viewport of the recording, reused verbatim as the video frame size.
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
  testDir: 'tests/e2e',
  testMatch: '**/tests/e2e/gameplay-recording.spec.ts',
  testIgnore: ['**/tests/unit/**', '**/tests/snapshot/**'],

  // Videos, screenshots and traces land here, one directory per test.
  outputDir: 'test-results',
  preserveOutput: 'always',

  timeout: TEST_TIMEOUT,
  globalTimeout: GLOBAL_TIMEOUT,
  expect: { timeout: EXPECT_TIMEOUT },

  // Serial execution: one recording is captured at a time.
  fullyParallel: false,
  workers: 1,
  retries: 0,

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

    // The animation, camera and particle surfaces read this preference.
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
      chromiumSandbox: false,

      args: [
        // Software WebGL: ANGLE over SwiftShader, with the unsafe-swiftshader
        // switch that permits it for WebGL contexts.
        '--enable-unsafe-swiftshader',
        '--use-gl=angle',
        '--use-angle=swiftshader',

        // /dev/shm is too small for Chromium's default shared-memory use in a
        // container.
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
