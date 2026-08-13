// The three browser variants the recorded-gameplay project does not cover.
//
// tests/e2e/gameplay-recording.spec.ts drives ONE environment: a desktop
// viewport, motion unreduced, and a live software WebGL context. Three
// behaviours the product promises are therefore never exercised in a browser by
// that spec, and each is asserted here instead:
//
//   @webgl-unavailable  R9's number-only mode doubling as the I6 WebGL
//                       fallback. The context is refused in the page rather
//                       than by withholding a launch argument, so the refusal
//                       is deterministic instead of depending on what the
//                       renderer negotiates.
//   @reduced-motion     R9's reduced-motion preference, which gates the camera
//                       punch/shake and the particle burst of R7.
//   @mobile             The single 520px breakpoint, the only responsive tier
//                       the stylesheet declares.
//
// One case per project. playwright.config.ts is the authority for each
// project's viewport, its reduced-motion value, the software-GL launch
// arguments, the base origin and the web server; nothing here restates or
// overrides any of them. Decisions: DL-PW-04 (docs/DECISION_LOG.md).
//
// Provenance of the constants below:
//   index.html L89-L92, L96          the board mounts and the controls root
//   style/_tokens.scss L40-L41, L110 $mobile-field-width, $mobile-grid-spacing
//                                    and the 520px $mobile-threshold
//   style/main.scss L181, L818-L819  $field-width and its mobile redefinition
//   src/ui/a11y/settings.ts L735     `data-reduced-motion`
//   src/input/on-screen-controls.ts L347
//                                    `on-screen-controls-animated`
//   src/render/number-only-renderer.ts L190, L203
//                                    `data-tile-value`, `data-board-size`
//   src/ui/screens/run-start.ts L272 the `Begin run` control's label
//   src/main.ts L2266-L2267          a refused probe forces number-only mode

import { expect, test } from '@playwright/test';

/** Board and control mounts index.html declares. */
const SELECTORS = Object.freeze({
  numberOnlyBoard: '#board-number-only',
  boardCanvas: '#board-canvas',
  onScreenControls: '#on-screen-controls',
  gameContainer: '.game-container',

  /** A number-only cell standing in for a tile, carrying that tile's value. */
  valuedCell: '#board-number-only [role="gridcell"][data-tile-value]',

  /** Every number-only cell, valued or empty. */
  cell: '#board-number-only [role="gridcell"]',

  /** The element the number-only renderer writes the visible numeral into. */
  numeral: '#board-number-only .tile-inner',
});

/** `data-reduced-motion` of src/ui/a11y/settings.ts L735. */
const REDUCED_MOTION_ATTRIBUTE = 'data-reduced-motion';

/** The class src/input/on-screen-controls.ts L347 adds only when motion runs. */
const MOTION_CLASS = 'on-screen-controls-animated';

/** `data-board-size` of src/render/number-only-renderer.ts L203. */
const BOARD_SIZE_ATTRIBUTE = 'data-board-size';

/** The configured board size, which the default rules config fixes at 4. */
const BOARD_SIZE = 4;

/** Starting tiles the default rules config spawns, so the floor on values. */
const START_TILES = 2;

/** `$field-width` of style/main.scss L181, in CSS pixels. */
const DESKTOP_FIELD_WIDTH = 500;

/** `$mobile-field-width` of style/_tokens.scss L40, in CSS pixels. */
const MOBILE_FIELD_WIDTH = 280;

/** `$mobile-threshold` of style/_tokens.scss L110, in CSS pixels. */
const MOBILE_THRESHOLD = 520;

/**
 * Settling time after a board-changing interaction, in milliseconds. Covers the
 * 100ms move transition plus the 200ms spawn and merge animations that follow
 * their 100ms delay.
 */
const MOVE_SETTLE_MS = 700;

/** Settling time after the first paint of a screen, in milliseconds. */
const SCREEN_SETTLE_MS = 1200;

/**
 * Refuses every WebGL context the page asks for, before any page script runs.
 *
 * Withholding `--enable-unsafe-swiftshader` instead would leave the outcome to
 * what Chromium negotiates for the platform, which is the failure mode the
 * software-GL launch arguments exist to remove. Refusing the context in the
 * page is exact: `probeWebGLSupport` asks for `webgl2` and then `webgl`, and
 * both answer null.
 *
 * @param page Page to install the refusal on.
 */
async function refuseWebGL(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    const real = HTMLCanvasElement.prototype.getContext;

    HTMLCanvasElement.prototype.getContext = function patched(
      this: HTMLCanvasElement,
      identifier: string,
      ...rest: readonly unknown[]
    ): unknown {
      if (
        typeof identifier === 'string' &&
        identifier.toLowerCase().includes('webgl')
      ) {
        return null;
      }

      return (real as (...args: readonly unknown[]) => unknown).call(
        this,
        identifier,
        ...rest,
      );
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
}

/**
 * Opens the page and starts a run, so the board holds tiles.
 *
 * The number-only board carries no valued cell until a run is under way: before
 * that the run-start screen is the active screen and the board is empty, which
 * is why every case that asserts on a tile begins here.
 *
 * @param page Page to drive.
 */
async function beginRun(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/', { waitUntil: 'load' });

  const begin = page.getByRole('button', { name: 'Begin run' });

  await expect(begin, 'the run-start screen offers no Begin run control').toBeVisible();
  await begin.click();
  await page.waitForTimeout(SCREEN_SETTLE_MS);
}

test.describe('browser variants', () => {
  test(
    'serves the numbered fallback board when WebGL is unavailable',
    { tag: '@webgl-unavailable' },
    async ({ page }) => {
      await refuseWebGL(page);
      await beginRun(page);

      // The fallback is in force: the number-only board is shown and the canvas
      // that could not be served is taken out of the page.
      const board = page.locator(SELECTORS.numberOnlyBoard);

      await expect(
        board,
        'the number-only board is still hidden, so no fallback was selected',
      ).toBeVisible();
      await expect(
        page.locator(SELECTORS.boardCanvas),
        'the WebGL canvas is still shown alongside the fallback board',
      ).toBeHidden();

      // The board is the configured lattice, not a placeholder.
      await expect(board).toHaveAttribute(
        BOARD_SIZE_ATTRIBUTE,
        String(BOARD_SIZE),
      );
      await expect(
        page.locator(SELECTORS.cell),
        'the fallback board does not carry one cell per configured position',
      ).toHaveCount(BOARD_SIZE * BOARD_SIZE);

      // NUMBERED: every tile present reaches the player as a number, both as
      // rendered text and as the value the cell carries.
      const valued = page.locator(SELECTORS.valuedCell);
      const valuedCount = await valued.count();

      expect(
        valuedCount,
        'the fallback board shows fewer tiles than the run starts with',
      ).toBeGreaterThanOrEqual(START_TILES);

      const values = await valued.evaluateAll((cells) =>
        cells.map((cell) => cell.getAttribute('data-tile-value')),
      );

      for (const value of values) {
        expect(
          value,
          'a fallback cell carries a value that is not a positive integer',
        ).toMatch(/^[1-9][0-9]*$/);
      }

      const numerals = await page
        .locator(SELECTORS.numeral)
        .evaluateAll((nodes) =>
          nodes.map((node) => (node.textContent ?? '').trim()),
        );

      expect(
        numerals.length,
        'no numeral is rendered on the fallback board',
      ).toBeGreaterThanOrEqual(START_TILES);
      expect(
        numerals.every((numeral) => /^[1-9][0-9]*$/.test(numeral)),
        `a rendered numeral is not a number: ${JSON.stringify(numerals)}`,
      ).toBe(true);

      // A move still resolves without a renderer, and the board still reports
      // the result as numbers.
      await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(MOVE_SETTLE_MS);

      expect(
        await valued.count(),
        'the fallback board stopped reporting tiles after a move',
      ).toBeGreaterThanOrEqual(START_TILES);
    },
  );

  test(
    'suppresses motion when the reduced-motion preference is set',
    { tag: '@reduced-motion' },
    async ({ page }) => {
      await beginRun(page);

      // The preference reached the page at all.
      expect(
        await page.evaluate(
          () => matchMedia('(prefers-reduced-motion: reduce)').matches,
        ),
        'the project did not deliver the reduced-motion preference',
      ).toBe(true);

      // The product reflected it: the attribute reads true and the class that
      // runs the control animations is absent.
      const controls = page.locator(SELECTORS.onScreenControls);

      await expect(controls).toHaveAttribute(REDUCED_MOTION_ATTRIBUTE, 'true');
      await expect(
        controls,
        'the animated-controls class survived the reduced-motion preference',
      ).not.toHaveClass(new RegExp(`\\b${MOTION_CLASS}\\b`));

      // The board still plays: suppressing motion suppresses the effects, not
      // the game.
      await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(MOVE_SETTLE_MS);

      await expect(
        controls,
        'the reduced-motion reflection did not survive a move',
      ).toHaveAttribute(REDUCED_MOTION_ATTRIBUTE, 'true');
    },
  );

  test(
    'lays the board out at the mobile scale below the breakpoint',
    { tag: '@mobile' },
    async ({ page }) => {
      await beginRun(page);

      // The one breakpoint the stylesheet declares is in force.
      expect(
        await page.evaluate(
          (threshold) => matchMedia(`(max-width: ${threshold}px)`).matches,
          MOBILE_THRESHOLD,
        ),
        'the project viewport did not put the mobile breakpoint in force',
      ).toBe(true);

      // Rescale, not reflow: the board is the mobile field width rather than
      // the desktop one, which is the whole responsive strategy.
      const field = page.locator(SELECTORS.gameContainer);
      const box = await field.boundingBox();

      expect(box, 'the board field has no box').not.toBeNull();
      expect(
        Math.round(box?.width ?? 0),
        'the board field is not at the mobile field width',
      ).toBe(MOBILE_FIELD_WIDTH);
      expect(
        Math.round(box?.width ?? 0),
        'the board field is still at the desktop field width',
      ).toBeLessThan(DESKTOP_FIELD_WIDTH);

      // The board fits the viewport, so nothing is played off-screen.
      const viewport = page.viewportSize();

      expect(viewport, 'the project declared no viewport').not.toBeNull();
      expect(
        Math.round((box?.x ?? 0) + (box?.width ?? 0)),
        'the board field overflows the mobile viewport',
      ).toBeLessThanOrEqual(viewport?.width ?? 0);

      // And it still plays at that scale.
      await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(MOVE_SETTLE_MS);

      expect(
        Math.round((await field.boundingBox())?.width ?? 0),
        'the board field changed width after a move',
      ).toBe(MOBILE_FIELD_WIDTH);
    },
  );
});
