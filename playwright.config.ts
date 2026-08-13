// Playwright configuration for the recorded-gameplay proof.
//
// any kind. One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every
// row of this file's area enumerated, all target-only:
//   TR-PW-01  the two tag-filtered projects and their shared `testMatch`
//   TR-PW-02  the recording settings and the software-GL launch arguments
//   TR-PW-03  the preview web server and its loopback-origin assertion
//   TR-PW-04  the three browser-variant projects, their mobile viewport and
//             the shared variant spec glob
//
// Decisions: DL-PW-01, DL-PW-02, DL-PW-04, DL-PW-05, DL-PW-06, DL-PW-07
// (docs/DECISION_LOG.md).

import { defineConfig, devices } from '@playwright/test';

// Port `npm run preview` is started on and polled at. vite.config.ts declares
// the same value as its `preview.port` default.
const PORT = 4173;

// Inclusive bounds of a TCP port number.
const MIN_PORT = 1;
const MAX_PORT = 65_535;

/**
 * Environment variable that makes the web server PREVIEW-ONLY.
 *
 * Set by the one caller that has already produced `dist/` in the same job.
 * DL-PW-06.
 */
const PREVIEW_ONLY_VARIABLE = 'PLAYWRIGHT_PREVIEW_ONLY';

/** Values of that variable which mean "not set". DL-PW-06. */
const NEGATIVE_FLAG_VALUES: readonly string[] = ['', '0', 'false', 'no', 'off'];

/**
 * Tags the two projects select on, declared by the cases of
 * tests/e2e/gameplay-recording.spec.ts. DL-PW-07.
 */
const GAMEPLAY_TAG = '@gameplay';
const DIAGNOSTICS_TAG = '@diagnostics';

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

/**
 * Whether the caller has already built `dist/` and wants preview alone.
 *
 * @returns Whether the flag is set to anything other than a negative value.
 */
function previewOnlyRequested(): boolean {
  const value: unknown = process.env[PREVIEW_ONLY_VARIABLE];

  if (typeof value !== 'string') {
    return false;
  }

  return !NEGATIVE_FLAG_VALUES.includes(value.trim().toLowerCase());
}

assertPreviewPort(PORT);

// Origin the spec resolves its relative paths against, and the URL the web
// server is polled on.
const BASE_URL = assertLoopbackOrigin(`http://127.0.0.1:${PORT}`);

// Viewport of the recording, reused verbatim as the video frame size.
const VIEWPORT = { width: 1280, height: 960 };

// Viewport for the mobile browser variant. 400px sits below the 520px
// `$mobile-threshold` of style/_tokens.scss L110, so the one breakpoint the
// stylesheet declares is in force and the board resolves to the 280px
// `$mobile-field-width` rather than the 500px `$field-width`. DL-PW-04.
const MOBILE_VIEWPORT = { width: 400, height: 780 };

// The spec the three variant projects collect. Declared once so the three
// projects cannot drift apart from one another.
const VARIANT_SPEC = '**/tests/e2e/browser-variants.spec.ts';

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

    // CHANGED from `on` for both: a screenshot and a trace are DEBUGGING
    // artifacts, where the video is the positive proof requirement R11 asks
    // for, so they are retained for a failure and discarded for a pass. The
    // trace still carries the action log, DOM snapshots and sources with no
    // screencast frames. DL-PW-07.
    screenshot: 'only-on-failure',
    trace: {
      mode: 'retain-on-failure',
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

  // FIVE PROJECTS OVER TWO FILES. The first two run one case each of the
  // recording spec, selected by the tag that case declares: the recording is the
  // gate's positive proof and belongs to the run that IS the proof, while the
  // diagnostics case is the Rule 3 observability exercise and needs no video of
  // its own, which is one encode and one retained artifact per green run saved.
  // Both share the viewport, so what the diagnostics case asserts is asserted at
  // the recorded layout. DL-PW-05. The last three run the browser variants.
  // DL-PW-04.
  projects: [
    {
      name: 'gameplay-recording',
      grep: new RegExp(GAMEPLAY_TAG, 'u'),
      use: {
        // Desktop Chrome supplies deviceScaleFactor 1, so one CSS pixel is one
        // recorded pixel.
        ...devices['Desktop Chrome'],
        viewport: VIEWPORT,
        video: { mode: 'on', size: VIEWPORT },
      },
    },

    {
      name: 'diagnostics-surface',
      grep: new RegExp(DIAGNOSTICS_TAG, 'u'),
      use: {
        ...devices['Desktop Chrome'],
        viewport: VIEWPORT,
        video: 'off',
      },
    },

    // The three browser variants of tests/e2e/browser-variants.spec.ts. Each
    // declares its own `testMatch`, which overrides the top-level one for that
    // project, so the recording project above keeps collecting only its own
    // spec. `grep` selects the one case whose environment the project builds;
    // none of them records video, because the R11 artifact is the recording
    // project's alone. DL-PW-04.
    {
      name: 'variant-webgl-unavailable',
      testMatch: VARIANT_SPEC,
      grep: /@webgl-unavailable/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: VIEWPORT,
      },
    },
    {
      name: 'variant-reduced-motion',
      testMatch: VARIANT_SPEC,
      grep: /@reduced-motion/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: VIEWPORT,

        // Replaces the inherited `contextOptions` wholesale. That object
        // carries `reducedMotion` and nothing else, so nothing is lost.
        contextOptions: {
          reducedMotion: 'reduce',
        },
      },
    },
    {
      name: 'variant-mobile',
      testMatch: VARIANT_SPEC,
      grep: /@mobile/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: MOBILE_VIEWPORT,
      },
    },
  ],

  webServer: {
    name: 'vite preview',

    // BUILDS BY DEFAULT, so `npm run test:e2e` on a workstation is one command
    // that needs nothing built beforehand. A caller that has already produced
    // `dist/` in the same job sets `PLAYWRIGHT_PREVIEW_ONLY` and the build is
    // not repeated — which is what the CI workflow does, since its own static
    // build is the deployment-parity gate. DL-PW-06.
    command: previewOnlyRequested()
      ? `npm run preview -- --port ${PORT} --strictPort`
      : `npm run build && npm run preview -- --port ${PORT} --strictPort`,
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
