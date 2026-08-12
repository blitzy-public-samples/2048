// The recorded-gameplay proof: requirement R11 and validation gate V9.
//
// The only browser-level suite in this repository. It drives the built bundle
// against a real WebGL context and asserts the three things the gate requires
// the recording to show: the 2.5D board, a tile merge with its animation, and a
// reward-screen relic selection. The second case is the Rule 3 observability
// exercise; the diagnostics surface it opens paints at
// `zIndex.diagnosticsOverlay`, above every game layer, and no case but that one
// opens it.
//
// The root playwright.config.ts is the authority for retention, the software-GL
// launch arguments, the viewport, the output directory, the base origin and the
// web server. Nothing here restates or overrides any of them.
// Decisions: DL-PW-01, DL-PW-02, DL-PW-03 (docs/DECISION_LOG.md).
//
// Provenance of the constants below:
//   style/main.scss L22, L104, L234, L329, L430-L431, L450-L451
//                                     the timing budget and the overlay delay
//   index.html                        every selector and mount id
//   src/ui/screen-router.ts           the seven states and the `hidden`
//                                     attribute as the whole active-screen
//                                     contract
//   src/ui/screens/game-over.ts       `data-action` on the terminal controls
//   src/ui/screens/reward.ts          `EXPECTED_OFFER_COUNT`
//   src/ui/components/relic-card.ts   the card and tray class and attribute
//                                     vocabulary
//   src/ui/a11y/focus-manager.ts      the parallel board's cell wording
//   src/ui/a11y/live-region.ts        the merge wording
//   src/storage/storage-keys.ts       the storage key literals
//   src/observability/health.ts       the six check ids and the three statuses
//   src/observability/tracer.ts       the span names
//   src/observability/metrics.ts      the series names and their prefix
//   src/observability/diagnostics-overlay.ts
//                                     the `diagnostics` flag, the control
//                                     labels and the export filename
//   js/keyboard_input_manager.js L54-L55  a modifier discards a move, so every
//                                     press here is a bare arrow key
//   js/html_actuator.js L127-L133     the verdict copy and its two classes

import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

/* ==========================================================================
 * 1. The scenario
 * ========================================================================== */

/**
 * Value typed into the run-start field, which `normalizeEnteredSeed` reduces
 * before the run opens.
 *
 * The field is filled before the run begins, so `originateRunSeed()` of
 * src/run/run-controller.ts, the product's only unseeded randomness, is not
 * reached.
 */
const RUN_SEED = 'blitzy-r11-proof';

/**
 * The four movement keys, pressed bare and in this order.
 *
 * src/input/keymap.ts binds `ArrowUp`, `ArrowRight`, `ArrowDown` and
 * `ArrowLeft`; js/keyboard_input_manager.js L54-L55 discarded any press
 * carrying a modifier and the ported manager keeps that, so no modifier is
 * held here.
 */
const MOVE_KEYS = Object.freeze([
  'ArrowUp',
  'ArrowRight',
  'ArrowDown',
  'ArrowLeft',
] as const);

/** One of `MOVE_KEYS`. */
type MoveKey = (typeof MOVE_KEYS)[number];

/**
 * Upper bound on the moves the loop plays before the first stage clear.
 *
 * The first stage goal is `stageGoalForIndex(0)` of src/config/stage-config.ts,
 * highest tile 16, which consumes no randomness. Under `RUN_SEED` the goal is
 * met on move 15; the bound is the loop's guarantee of termination and not an
 * expectation.
 */
const STAGE_CLEAR_MOVE_CAP = 140;

/** Moves played after the relic is taken, to film the stage it opened. */
const POST_REWARD_MOVES = 6;

/** Iteration bound on the loop that plays until a merge is announced. */
const MERGE_MOVE_CAP = 40;

/**
 * Iteration bound on the loop that clears whatever screen stands over the
 * board. One stage clear costs two steps, the interstitial and the reward,
 * and a relic taken can carry the board past the next goal at once, so the
 * bound admits several in a row.
 */
const OVERLAY_RESOLUTION_CAP = 12;

/* ==========================================================================
 * 2. The timing budget
 * ========================================================================== */

/** `style/main.scss` L22 `$transition-speed`, in milliseconds. */
const TRANSITION_SPEED_MS = 100;

/** `style/main.scss` L329: the move transition. */
const MOVE_TRANSITION_MS = TRANSITION_SPEED_MS;

/** `style/main.scss` L430-L431: `appear` 200ms after a 100ms delay. */
const SPAWN_ANIMATION_MS = 300;

/** `style/main.scss` L450-L451: `pop` 200ms after a 100ms delay. */
const MERGE_POP_MS = 300;

/** `style/main.scss` L104: `move-up` on the `+N` score delta. */
const SCORE_DELTA_MS = 600;

/**
 * `style/main.scss` L234: `fade-in 800ms ease $transition-speed * 12`, so a
 * terminal overlay resolves 1200ms + 800ms after the verdict is written.
 */
const TERMINAL_OVERLAY_MS = TRANSITION_SPEED_MS * 12 + 800;

/** Settle after an ordinary move: the transition plus the merge pop. */
const MOVE_SETTLE_MS = MOVE_TRANSITION_MS + MERGE_POP_MS;

/** Settle after a move whose animation is being filmed. */
const FILMED_MOVE_SETTLE_MS = MOVE_TRANSITION_MS + SCORE_DELTA_MS;

/** Settle after the board first paints, and before it is sampled. */
const BOARD_PAINT_SETTLE_MS = SPAWN_ANIMATION_MS + SCORE_DELTA_MS;

/** Settle either side of a screen transition being filmed. */
const SCREEN_SETTLE_MS = MERGE_POP_MS + SCORE_DELTA_MS;

/** Ceiling on a web-first wait for a state this spec drives itself. */
const STATE_TIMEOUT_MS = 30_000;

/* ==========================================================================
 * 3. The DOM contract
 * ========================================================================== */

/**
 * The overlay root each screen state mounts into, as index.html declares them
 * and `SCREEN_MOUNTS` of src/ui/screen-router.ts routes them.
 *
 * `won` and `gameOver` share `#screen-game-over`, and `stage` has no overlay
 * root: it is the state in force while every one of these is hidden.
 */
const OVERLAY_SCREEN_IDS = Object.freeze([
  Object.freeze({ id: 'screen-run-start', screen: 'runStart' }),
  Object.freeze({ id: 'screen-stage-progress', screen: 'stageClear' }),
  Object.freeze({ id: 'screen-reward', screen: 'reward' }),
  Object.freeze({ id: 'screen-game-over', screen: 'terminal' }),
  Object.freeze({ id: 'screen-run-summary', screen: 'runSummary' }),
] as const);

/** The in-flow HUD, unhidden for every state inside a run. */
const HUD_ID = 'screen-hud';

/** Selectors index.html declares, resolved from this spec alone. */
const SELECTORS = Object.freeze({
  seedInput: '#run-start-seed',
  beginRun: '#run-start-begin',
  boardHost: '#board-host',
  boardCanvas: '#board-host canvas',
  parallelBoard: '#board-a11y',
  boardCell: '#board-a11y [role="gridcell"]',
  liveRegion: '#live-region',
  score: '.score-container',
  best: '.best-container',
  scoreDelta: '.score-container .score-addition',
  terminalOverlay: '.game-message',
  hudStage: '#hud-stage',
  relicTray: '#relic-tray',
  trayRelic: '#relic-tray [data-relic-id]',
  continueStage: '.stage-progress-continue',
  rewardCard: '#screen-reward button.relic-card',
  diagnostics: '#diagnostics-overlay',
  diagnosticsControl: '#diagnostics-overlay button',
});

/** The screen states this spec reads back, plus its two fallbacks. */
type ReadableScreen =
  | 'runStart'
  | 'stage'
  | 'stageClear'
  | 'reward'
  | 'won'
  | 'gameOver'
  | 'runSummary'
  | 'unknown';

/**
 * The merge wording `describeMerges` of src/ui/a11y/live-region.ts composes:
 * `Merged into 4.` for one merge and `2 merges: 4, 8.` for several.
 */
const MERGE_ANNOUNCEMENT = /Merged into \d+\.|\d+ merges: /u;

/**
 * The result value the same wording reports: the single-merge form names it
 * after `Merged into`, the several-merge form first in the list.
 */
const MERGE_RESULT_VALUE = /Merged into (\d+)\.|merges: (\d+)/u;

/**
 * The `+N` the score delta node carries, as js/html_actuator.js L114-L120
 * wrote it.
 */
const SCORE_DELTA_TEXT = /^\+\d+$/u;

/**
 * A populated cell of the parallel board, as `cellLabel` of
 * src/ui/a11y/focus-manager.ts writes it: `Row r, column c, value`, one-based
 * on both axes, with `EMPTY_CELL_LABEL` in place of a value for an empty cell.
 */
const POPULATED_CELL = /^Row (\d+), column (\d+), (\d+)$/u;

/** Offers one reward presents: `EXPECTED_OFFER_COUNT` of reward.ts. */
const EXPECTED_OFFER_COUNT = 3;

/* ==========================================================================
 * 4. The storage keys
 * ========================================================================== */

/**
 * The two unprefixed legacy keys, verbatim from src/storage/storage-keys.ts,
 * which is their single authority. This suite runs in the browser and imports
 * nothing from src/, so the literals are restated here.
 */
const BEST_SCORE_KEY = 'bestScore';
const GAME_STATE_KEY = 'gameState';

/**
 * `STORAGE_NAMESPACE` and its delimiter, from the same module. Every key this
 * application owns beyond the two legacy ones carries this prefix —
 * `roguelike2048:runState`, `:keymap`, `:preferences` and `:probe` — so the
 * prefix is cleared as a set rather than one name at a time.
 */
const STORAGE_NAMESPACE_PREFIX = 'roguelike2048:';

/** The run-state key, named so a failure reports it by name. */
const RUN_STATE_KEY = `${STORAGE_NAMESPACE_PREFIX}runState`;

/* ==========================================================================
 * 5. The canvas-content verdict
 * ========================================================================== */

/** Edge of the square the canvas is resampled into before it is measured. */
const PIXEL_SAMPLE_EDGE = 140;

/** Distinct colours a rendered board carries. A cleared buffer carries one. */
const MIN_DISTINCT_COLOURS = 8;

/** Mean of the sampled luminance, on the 0-255 scale. */
const MIN_MEAN_LUMINANCE = 24;

/** Peak sampled luminance, on the same scale. */
const MIN_PEAK_LUMINANCE = 64;

/** Widest per-channel range across the sample. */
const MIN_CHANNEL_SPREAD = 16;

/** Bits dropped per channel before colours are counted as distinct. */
const COLOUR_QUANTISATION_BITS = 3;

/** What one sample of the board canvas measured. */
interface CanvasVerdict {
  /** Quantised colours present in the sample. */
  readonly distinctColours: number;

  /** Mean luminance over the sample, 0-255. */
  readonly meanLuminance: number;

  /** Highest luminance in the sample, 0-255. */
  readonly peakLuminance: number;

  /** Lowest luminance in the sample, 0-255. */
  readonly floorLuminance: number;

  /** Widest per-channel range in the sample, 0-255. */
  readonly channelSpread: number;

  /** Pixels measured, so an empty sample is distinguishable from a dark one. */
  readonly pixelsSampled: number;
}

/** What the live-context probe read off a throwaway canvas. */
interface WebGLReading {
  /**
   * `'webgl2'`, `'webgl'` or `'none'`, as src/render/webgl-support.ts names
   * the levels.
   */
  readonly level: 'webgl2' | 'webgl' | 'none';

  /** `gl.VERSION`, or the empty string where no context was obtained. */
  readonly version: string;

  /** `UNMASKED_RENDERER_WEBGL`, or the empty string where unexposed. */
  readonly renderer: string;

  /** `UNMASKED_VENDOR_WEBGL`, or the empty string where unexposed. */
  readonly vendor: string;

  /** Whether `WEBGL_debug_renderer_info` was exposed at all. */
  readonly debugInfoExposed: boolean;
}

/* ==========================================================================
 * 6. The observability contract
 * ========================================================================== */

/** Name src/main.ts publishes the running application under. */
const APPLICATION_GLOBAL = '__blitzy2048';

/** `HEALTH_CHECK_IDS` of src/observability/health.ts, in report order. */
const HEALTH_CHECK_IDS = Object.freeze([
  'functionBind',
  'classList',
  'requestAnimationFrame',
  'pointerEvents',
  'storage',
  'webgl',
] as const);

/** `SPAN_NAMES` of src/observability/tracer.ts, for the boundaries V8 names. */
const TURN_SPAN_NAMES = Object.freeze([
  'input.dispatch',
  'engine.turn',
  'hook.dispatch',
  'render.commit',
] as const);

/** The frame-callback seam `instrumentFrameCallback` measures. */
const FRAME_SPAN_NAME = 'render.frame';

/** `METRIC_PREFIX` of src/observability/metrics.ts. */
const METRIC_PREFIX = 'game2048_';

/** The per-hook dispatch family, one series per hook. */
const HOOK_DISPATCH_METRIC = `${METRIC_PREFIX}hook_dispatches_total`;

/** The per-event emission family, one series per engine event. */
const ENGINE_EVENT_METRIC = `${METRIC_PREFIX}engine_events_total`;

/** `HOOK_NAMES` of src/engine/hooks.ts, in dispatch order. */
const HOOK_NAMES = Object.freeze([
  'onStageStart',
  'onBeforeMove',
  'onMerge',
  'onSpawn',
  'onAfterMove',
  'onStageEnd',
] as const);

/**
 * The hooks a stage that has resolved a merge must have dispatched.
 * `onStageEnd` is excluded: it is dispatched when a stage ends, and this
 * reading is taken mid-stage.
 */
const HOOKS_DISPATCHED_MID_STAGE = Object.freeze([
  'onStageStart',
  'onBeforeMove',
  'onMerge',
  'onSpawn',
  'onAfterMove',
] as const);

/**
 * The engine events a stage that has resolved a merge must have emitted, from
 * `ENGINE_EVENT_NAMES` of src/engine/engine-events.ts. `stage:end` is excluded
 * for the same reason `onStageEnd` is.
 */
const EVENTS_EMITTED_MID_STAGE = Object.freeze([
  'stage:start',
  'move:before',
  'tile:merge',
  'tile:spawn',
  'move:after',
  'state:commit',
] as const);

/** The `diagnostics` flag `isDiagnosticsRequested()` reads off the URL. */
const DIAGNOSTICS_QUERY = '/?diagnostics';

/** `DEFAULT_DIAGNOSTICS_SNAPSHOT_FILENAME` of the diagnostics surface. */
const DIAGNOSTICS_EXPORT_FILENAME = 'game2048-diagnostics.json';

/** The control labels the diagnostics surface renders, in row order. */
const DIAGNOSTICS_CONTROL_LABELS = Object.freeze([
  'Refresh',
  'Export metrics',
  'Export snapshot',
  'Collapse diagnostics',
  'Close diagnostics',
] as const);

/** The panel headings the diagnostics surface renders. */
const DIAGNOSTICS_PANEL_HEADINGS = Object.freeze([
  'Run',
  'Health',
  'Traces',
  'Hooks',
  'Recent records',
] as const);


/* ==========================================================================
 * 7. Reading the page
 * ========================================================================== */

/** One reading of everything this spec asserts against. */
interface BoardSurface {
  /** The state in force, resolved from the `hidden` attribute alone. */
  readonly screen: ReadableScreen;

  /** Every overlay root found unhidden, so a double-open reports both. */
  readonly openOverlays: readonly string[];

  /** The parallel board's `aria-label` per cell, in DOM order. */
  readonly cellLabels: readonly string[];

  /** Whatever the announcer region holds at this instant. */
  readonly announcement: string;

  /** The score outlet's text, label span included. */
  readonly scoreText: string;

  /** The best-score outlet's text, label span included. */
  readonly bestText: string;

  /** The transient `+N` delta node's text, or the empty string. */
  readonly scoreDeltaText: string;

  /** The HUD's stage, goal and board readout, concatenated. */
  readonly stageText: string;

  /** `data-relic-id` of each reward card on offer, in offer order. */
  readonly offerIds: readonly string[];

  /** `data-relic-id` of each tray row, in pickup order. */
  readonly trayRelicIds: readonly string[];

  /** Classes on the retained terminal overlay. */
  readonly terminalOverlayClasses: readonly string[];

  /** Whether a canvas is present inside the declared board host. */
  readonly canvasPresent: boolean;

  /** The canvas's `aria-hidden`, which the renderer owns. */
  readonly canvasAriaHidden: string | null;

  /** Whether the number-only host is hidden, as a mounted 2.5D board does. */
  readonly numberOnlyHidden: boolean;
}

/** What `readBoardSurface` hands the page. */
interface SurfaceQuery {
  readonly overlays: readonly {
    readonly id: string;
    readonly screen:
      | 'runStart'
      | 'stageClear'
      | 'reward'
      | 'terminal'
      | 'runSummary';
  }[];
  readonly hudId: string;
  readonly selectors: typeof SELECTORS;
}

/** The query, built once. */
const SURFACE_QUERY: SurfaceQuery = Object.freeze({
  overlays: OVERLAY_SCREEN_IDS,
  hudId: HUD_ID,
  selectors: SELECTORS,
});

/**
 * Reads the page in one round trip.
 *
 * @param page Page to read.
 * @returns Everything the assertions below are made against.
 */
async function readBoardSurface(page: Page): Promise<BoardSurface> {
  return await page.evaluate((query: SurfaceQuery): BoardSurface => {
    const shown = (element: Element | null): boolean =>
      element !== null && !element.hasAttribute('hidden');

    const textOf = (selector: string): string => {
      const node = document.querySelector(selector);

      return node === null ? '' : (node.textContent ?? '');
    };

    const attributesOf = (selector: string, name: string): string[] =>
      Array.from(document.querySelectorAll(selector)).map(
        (node): string => node.getAttribute(name) ?? '',
      );

    const openOverlays = query.overlays
      .filter((entry): boolean => shown(document.getElementById(entry.id)))
      .map((entry) => entry.screen);

    const first = openOverlays[0];
    let screen: ReadableScreen = 'unknown';

    if (first === 'terminal') {
      // src/ui/screens/game-over.ts renders `acknowledge` for `gameOver` and
      // `keepPlaying`/`endRun` for `won`, over one shared container.
      screen =
        document.querySelector(
          '#screen-game-over [data-action="acknowledge"]',
        ) === null
          ? 'won'
          : 'gameOver';
    } else if (first !== undefined) {
      screen = first;
    } else if (shown(document.getElementById(query.hudId))) {
      screen = 'stage';
    }

    const canvas = document.querySelector(query.selectors.boardCanvas);
    const numberOnly = document.getElementById('board-number-only');
    const overlay = document.querySelector(query.selectors.terminalOverlay);

    return {
      screen,
      openOverlays,
      cellLabels: attributesOf(query.selectors.boardCell, 'aria-label'),
      announcement: textOf(query.selectors.liveRegion),
      scoreText: textOf(query.selectors.score),
      bestText: textOf(query.selectors.best),
      scoreDeltaText: textOf(query.selectors.scoreDelta),
      stageText: textOf(query.selectors.hudStage),
      offerIds: attributesOf(query.selectors.rewardCard, 'data-relic-id'),
      trayRelicIds: attributesOf(query.selectors.trayRelic, 'data-relic-id'),
      terminalOverlayClasses:
        overlay === null ? [] : Array.from(overlay.classList),
      canvasPresent: canvas !== null,
      canvasAriaHidden:
        canvas === null ? null : canvas.getAttribute('aria-hidden'),
      numberOnlyHidden:
        numberOnly !== null && numberOnly.hasAttribute('hidden'),
    };
  }, SURFACE_QUERY);
}

/**
 * The tile values a set of cell labels reports, empties dropped.
 *
 * @param cellLabels Labels as `readBoardSurface` read them.
 * @returns Every populated cell's value, in DOM order.
 */
function tileValuesOf(cellLabels: readonly string[]): number[] {
  const values: number[] = [];

  for (const label of cellLabels) {
    const parsed = POPULATED_CELL.exec(label);
    const value = parsed === null ? Number.NaN : Number(parsed[3]);

    if (Number.isFinite(value)) {
      values.push(value);
    }
  }

  return values;
}

/**
 * The highest tile a set of cell labels reports.
 *
 * @param cellLabels Labels as `readBoardSurface` read them.
 * @returns The highest value present, and 0 for a board holding no tiles.
 */
function highestTileOf(cellLabels: readonly string[]): number {
  return tileValuesOf(cellLabels).reduce(
    (highest, value): number => Math.max(highest, value),
    0,
  );
}

/**
 * Waits for one screen state to be the state in force.
 *
 * @param page Page to read.
 * @param screen State awaited.
 * @param context Short label naming the step, carried into the failure.
 */
async function expectScreen(
  page: Page,
  screen: ReadableScreen,
  context: string,
): Promise<void> {
  await expect
    .poll(
      async (): Promise<ReadableScreen> =>
        (await readBoardSurface(page)).screen,
      {
        message:
          `${context}: the screen state never became "${screen}". The ` +
          'state is read from the `hidden` attribute of the overlay roots ' +
          'index.html declares.',
        timeout: STATE_TIMEOUT_MS,
      },
    )
    .toBe(screen);
}

/**
 * Waits for one screen state to no longer be the state in force.
 *
 * @param page Page to read.
 * @param screen State awaited on its way out.
 * @param context Short label naming the step, carried into the failure.
 */
async function expectScreenLeft(
  page: Page,
  screen: ReadableScreen,
  context: string,
): Promise<void> {
  await expect
    .poll(
      async (): Promise<ReadableScreen> =>
        (await readBoardSurface(page)).screen,
      {
        message: `${context}: the screen state never left "${screen}"`,
        timeout: STATE_TIMEOUT_MS,
      },
    )
    .not.toBe(screen);
}

/**
 * Presses one bare arrow key and lets the turn settle.
 *
 * @param page Page to drive.
 * @param key Movement key to press.
 * @param settleMs Milliseconds held after the press.
 */
async function pressMove(
  page: Page,
  key: MoveKey,
  settleMs: number,
): Promise<void> {
  await page.keyboard.press(key);
  await page.waitForTimeout(settleMs);
}

/**
 * Clears whatever screen stands over the board, so the caller is left in the
 * `stage` state.
 *
 * A stage cleared during play raises the interstitial and then the reward
 * round, and both are resolved here: `Continue` publishes `continueStage` and a
 * card publishes `selectReward`. Every offer resolved this way is asserted to
 * hold `EXPECTED_OFFER_COUNT` distinct relics, and the relic taken is appended
 * to `taken` in the order it was picked up.
 *
 * @param page Page to drive.
 * @param taken Relic identifiers taken so far, appended to in pickup order.
 * @param context Short label naming the step, carried into any failure.
 */
async function resolveOverlaysToStage(
  page: Page,
  taken: string[],
  context: string,
): Promise<void> {
  for (let step = 0; step < OVERLAY_RESOLUTION_CAP; step += 1) {
    const surface = await readBoardSurface(page);

    if (surface.screen === 'stage') {
      return;
    }

    if (surface.screen === 'stageClear') {
      await page.waitForTimeout(SCREEN_SETTLE_MS);
      await page.getByRole('button', { name: 'Continue' }).click();
      await expectScreen(page, 'reward', `${context}: past the stage clear`);

      continue;
    }

    if (surface.screen === 'reward') {
      await page.waitForTimeout(SCREEN_SETTLE_MS);

      expect(
        surface.offerIds.length,
        `${context}: the reward round presented ` +
          `${surface.offerIds.length} offers`,
      ).toBe(EXPECTED_OFFER_COUNT);
      expect(
        new Set(surface.offerIds).size,
        `${context}: one offer presented the same relic twice: ` +
          surface.offerIds.join(', '),
      ).toBe(EXPECTED_OFFER_COUNT);

      await page.locator(SELECTORS.rewardCard).first().click();

      // The successor is not always `stage`: a board that already satisfies the
      // goal of the stage the relic opened clears it at once, which raises the
      // interstitial again. The loop re-reads instead of naming a successor.
      await expectScreenLeft(page, 'reward', `${context}: taking the relic`);
      taken.push(surface.offerIds[0]);

      continue;
    }

    throw new Error(
      `${context}: the run reached "${surface.screen}", which this step does ` +
        `not resolve (open overlays: ${surface.openOverlays.join(', ')})`,
    );
  }

  throw new Error(
    `${context}: the board was still behind an overlay after ` +
      `${OVERLAY_RESOLUTION_CAP} resolution steps`,
  );
}

/* ==========================================================================
 * 8. Measuring what was drawn
 * ========================================================================== */

/** The base64 form of the byte buffer `page.screenshot()` answers with. */
interface EncodableBuffer {
  toString(encoding: 'base64'): string;
}

/** What `sampleBoardCanvas` hands the page. */
interface SampleRequest {
  readonly encoded: string;
  readonly edge: number;
  readonly quantisationBits: number;
}

/**
 * Samples the board canvas and reduces it to a numeric verdict.
 *
 * Path taken: `page.screenshot({ clip })` over the canvas box, decoded in page
 * context through a `data:` URL and reduced to a numeric summary there. The
 * three mechanical constraints that path is shaped by:
 *   src/render/three-renderer.ts  constructs `WebGLRenderer` with no
 *                                 `preserveDrawingBuffer`, so an in-page
 *                                 `drawImage` of the canvas reads a cleared
 *                                 buffer: measured at one distinct colour and
 *                                 zero luminance.
 *   index.html                    `img-src 'self' data:` admits the decode.
 *   tsconfig.json                 `types: ["vite/client"]` alone, so no Node
 *                                 module resolves in this project.
 *
 * @param page Page holding the board.
 * @returns The verdict over a `PIXEL_SAMPLE_EDGE` square resample.
 */
async function sampleBoardCanvas(page: Page): Promise<CanvasVerdict> {
  const canvas = page.locator(SELECTORS.boardCanvas);

  await expect(
    canvas,
    'the board canvas index.html declares inside `#board-host` was not found',
  ).toBeAttached({ timeout: STATE_TIMEOUT_MS });

  const box = await canvas.boundingBox();

  expect(
    box,
    'the board canvas reported no bounding box, so it occupies no space',
  ).not.toBeNull();

  if (box === null) {
    throw new Error('the board canvas reported no bounding box');
  }

  expect(box.width, 'the board canvas has no width').toBeGreaterThan(0);
  expect(box.height, 'the board canvas has no height').toBeGreaterThan(0);

  const png: EncodableBuffer = await page.screenshot({
    clip: box,
    type: 'png',
  });

  return await page.evaluate(
    async (request: SampleRequest): Promise<CanvasVerdict> => {
      const image = new Image();

      await new Promise<void>((resolve, reject): void => {
        image.addEventListener('load', (): void => {
          resolve();
        });
        image.addEventListener('error', (): void => {
          reject(new Error('the captured board image could not be decoded'));
        });
        image.src = `data:image/png;base64,${request.encoded}`;
      });

      const surface = document.createElement('canvas');

      surface.width = request.edge;
      surface.height = request.edge;

      const context = surface.getContext('2d', { willReadFrequently: true });

      if (context === null) {
        throw new Error('no 2d context was available to measure the capture');
      }

      context.drawImage(image, 0, 0, request.edge, request.edge);

      const pixels = context.getImageData(
        0,
        0,
        request.edge,
        request.edge,
      ).data;
      const colours = new Set<number>();
      const bits = request.quantisationBits;
      const channelLow = [255, 255, 255];
      const channelHigh = [0, 0, 0];
      let luminanceSum = 0;
      let peak = 0;
      let floor = 255;
      let sampled = 0;

      for (let offset = 0; offset + 3 < pixels.length; offset += 4) {
        const red = pixels[offset];
        const green = pixels[offset + 1];
        const blue = pixels[offset + 2];
        const channels = [red, green, blue];

        for (let channel = 0; channel < channels.length; channel += 1) {
          const level = channels[channel];

          channelLow[channel] = Math.min(channelLow[channel], level);
          channelHigh[channel] = Math.max(channelHigh[channel], level);
        }

        colours.add(
          ((red >> bits) << 16) | ((green >> bits) << 8) | (blue >> bits),
        );

        const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;

        luminanceSum += luminance;
        peak = Math.max(peak, luminance);
        floor = Math.min(floor, luminance);
        sampled += 1;
      }

      let spread = 0;

      for (let channel = 0; channel < channelHigh.length; channel += 1) {
        spread = Math.max(spread, channelHigh[channel] - channelLow[channel]);
      }

      return {
        distinctColours: colours.size,
        meanLuminance: sampled === 0 ? 0 : luminanceSum / sampled,
        peakLuminance: sampled === 0 ? 0 : peak,
        floorLuminance: sampled === 0 ? 0 : floor,
        channelSpread: spread,
        pixelsSampled: sampled,
      };
    },
    {
      encoded: png.toString('base64'),
      edge: PIXEL_SAMPLE_EDGE,
      quantisationBits: COLOUR_QUANTISATION_BITS,
    },
  );
}

/**
 * Asserts that a sample of the board is a rendered board and not a cleared
 * buffer.
 *
 * @param verdict Verdict from `sampleBoardCanvas`.
 * @param context Short label naming the moment the sample was taken.
 */
function expectRenderedBoard(verdict: CanvasVerdict, context: string): void {
  expect(
    verdict.pixelsSampled,
    `${context}: the capture yielded no pixels`,
  ).toBe(PIXEL_SAMPLE_EDGE * PIXEL_SAMPLE_EDGE);

  expect(
    verdict.distinctColours,
    `${context}: the board sampled as ${verdict.distinctColours} distinct ` +
      'colours, which is a flat fill rather than a rendered board',
  ).toBeGreaterThanOrEqual(MIN_DISTINCT_COLOURS);

  expect(
    verdict.meanLuminance,
    `${context}: the board sampled at mean luminance ` +
      `${verdict.meanLuminance.toFixed(2)}, which is a near-black capture`,
  ).toBeGreaterThanOrEqual(MIN_MEAN_LUMINANCE);

  expect(
    verdict.peakLuminance,
    `${context}: the brightest sampled pixel was ` +
      `${verdict.peakLuminance.toFixed(2)}`,
  ).toBeGreaterThanOrEqual(MIN_PEAK_LUMINANCE);

  expect(
    verdict.channelSpread,
    `${context}: the widest per-channel range was ${verdict.channelSpread}`,
  ).toBeGreaterThanOrEqual(MIN_CHANNEL_SPREAD);
}

/**
 * Reads a live WebGL context off a throwaway canvas.
 *
 * @param page Page to probe.
 * @returns The level obtained and the strings the debug extension exposes.
 */
async function probeWebGLContext(page: Page): Promise<WebGLReading> {
  return await page.evaluate((): WebGLReading => {
    const probe = document.createElement('canvas');
    const two = probe.getContext('webgl2');
    const one = two === null ? probe.getContext('webgl') : null;
    const context: WebGL2RenderingContext | WebGLRenderingContext | null =
      two ?? one;

    if (context === null) {
      return {
        level: 'none',
        version: '',
        renderer: '',
        vendor: '',
        debugInfoExposed: false,
      };
    }

    const debugInfo = context.getExtension('WEBGL_debug_renderer_info');
    const read = (parameter: number): string => {
      const value: unknown = context.getParameter(parameter);

      return typeof value === 'string' ? value : '';
    };

    return {
      level: two === null ? 'webgl' : 'webgl2',
      version: read(context.VERSION),
      renderer:
        debugInfo === null ? '' : read(debugInfo.UNMASKED_RENDERER_WEBGL),
      vendor: debugInfo === null ? '' : read(debugInfo.UNMASKED_VENDOR_WEBGL),
      debugInfoExposed: debugInfo !== null,
    };
  });
}

/* ==========================================================================
 * 9. Reading the artifact
 * ========================================================================== */

/**
 * The byte length of a file on this machine, read through the browser.
 *
 * A second context is opened for the read and is given no `recordVideo`, so it
 * captures nothing of its own. `setInputFiles` raises where the path names no
 * file, which is the existence half of the assertion.
 *
 * @param browser Browser the reader context is opened on.
 * @param filePath Absolute path of the file to measure.
 * @returns The file's size in bytes.
 */
async function fileByteSize(
  browser: Browser,
  filePath: string,
): Promise<number> {
  const reader = await browser.newContext();

  try {
    const readerPage = await reader.newPage();

    await readerPage.setContent('<input id="artifact" type="file">');
    await readerPage.setInputFiles('#artifact', filePath);

    return await readerPage.evaluate((): number => {
      const input = document.getElementById('artifact');
      const file =
        input instanceof HTMLInputElement ? input.files?.item(0) : null;

      return file === null || file === undefined ? -1 : file.size;
    });
  } finally {
    await reader.close();
  }
}

/* ==========================================================================
 * 10. Storage hygiene
 * ========================================================================== */

/** What the storage scripts are handed. */
interface StorageKeys {
  readonly bestScore: string;
  readonly gameState: string;
  readonly namespacePrefix: string;
}

/** The keys, built once. */
const STORAGE_KEYS: StorageKeys = Object.freeze({
  bestScore: BEST_SCORE_KEY,
  gameState: GAME_STATE_KEY,
  namespacePrefix: STORAGE_NAMESPACE_PREFIX,
});

/**
 * The body of both the pre-load script and the teardown call: removes the two
 * legacy keys and every namespaced key, and raises nothing where the store is
 * unavailable.
 *
 * @param keys The keys and the namespace prefix.
 */
function clearOwnedStorage(keys: StorageKeys): void {
  try {
    const store = window.localStorage;

    store.removeItem(keys.bestScore);
    store.removeItem(keys.gameState);

    const namespaced: string[] = [];

    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);

      if (key !== null && key.startsWith(keys.namespacePrefix)) {
        namespaced.push(key);
      }
    }

    for (const key of namespaced) {
      store.removeItem(key);
    }
  } catch {
    // A store that refuses to be read or written is cleared by definition, and
    // a teardown must not be the thing that fails a run.
  }
}

/** What the persisted store holds at one instant. */
interface StoredState {
  /** Whether the namespaced run-state key is present. */
  readonly runStatePresent: boolean;

  /** Whether the persisted envelope carries the seed that was played. */
  readonly runStateHoldsSeed: boolean;

  /** Every key present that carries the application's namespace prefix. */
  readonly namespacedKeys: readonly string[];

  /** Whether the legacy best-score key is present. */
  readonly bestScorePresent: boolean;
}

/**
 * Reads the persisted keys through the page.
 *
 * @param page Page whose origin owns the store.
 * @param seed Seed the run was played under.
 * @returns What the store holds, and an empty reading where it is unavailable.
 */
async function readStoredState(page: Page, seed: string): Promise<StoredState> {
  return await page.evaluate(
    (request: {
      readonly keys: StorageKeys;
      readonly runStateKey: string;
      readonly seed: string;
    }): StoredState => {
      try {
        const store = window.localStorage;
        const namespacedKeys: string[] = [];

        for (let index = 0; index < store.length; index += 1) {
          const key = store.key(index);

          if (key !== null && key.startsWith(request.keys.namespacePrefix)) {
            namespacedKeys.push(key);
          }
        }

        const runState = store.getItem(request.runStateKey);

        return {
          runStatePresent: runState !== null,
          runStateHoldsSeed:
            runState !== null && runState.includes(request.seed),
          namespacedKeys,
          bestScorePresent: store.getItem(request.keys.bestScore) !== null,
        };
      } catch {
        return {
          runStatePresent: false,
          runStateHoldsSeed: false,
          namespacedKeys: [],
          bestScorePresent: false,
        };
      }
    },
    { keys: STORAGE_KEYS, runStateKey: RUN_STATE_KEY, seed },
  );
}


/* ==========================================================================
 * 11. Reading the observability surfaces
 * ========================================================================== */

/**
 * The members this spec calls on the application src/main.ts publishes for
 * local inspection. Declared here because the handle is reached by name from
 * page context and this suite imports no application module.
 */
interface InspectionHandle {
  readonly health: {
    check(): {
      readonly status: string;
      readonly correlationId: string;
      readonly checks: readonly {
        readonly id: string;
        readonly status: string;
        readonly detail: string;
      }[];
    };
    readiness(): {
      readonly ready: boolean;
      readonly renderer: string;
      readonly mayMountWebGLRenderer: boolean;
      readonly requiresNumberOnlyFallback: boolean;
      readonly webglLevel: string;
      readonly webglStatus: string;
      readonly storage: string;
      readonly storageStrategy: string;
    };
  };
  readonly tracer: {
    snapshot(): {
      readonly enabled: boolean;
      readonly correlationId: string;
      readonly frames: { readonly frames: number };
      readonly spans: readonly { readonly name: string }[];
    };
  };
  readonly metrics: {
    toPrometheusText(): string;
  };
  readonly logger: {
    readonly correlationId: string;
    snapshot(): {
      readonly correlationId: string;
      readonly records: readonly {
        readonly message: string;
        readonly correlationId: string;
      }[];
    };
  };
  readonly diagnostics: {
    snapshotJson(): string;
    toPrometheusText(): string;
  };
  readonly run: {
    seed(): string;
  };
}

/** One health check as the report carries it. */
interface HealthCheckReading {
  readonly id: string;
  readonly status: string;
  readonly detail: string;
}

/** One reading of every observability surface, reduced to plain data. */
interface ObservabilityReading {
  /** Whether the inspection handle resolved at all. */
  readonly available: boolean;

  readonly health: {
    readonly status: string;
    readonly correlationId: string;
    readonly ids: readonly string[];
    readonly checks: readonly HealthCheckReading[];
  };

  readonly readiness: {
    readonly ready: boolean;
    readonly renderer: string;
    readonly mayMountWebGLRenderer: boolean;
    readonly requiresNumberOnlyFallback: boolean;
    readonly webglLevel: string;
    readonly webglStatus: string;
    readonly storage: string;
    readonly storageStrategy: string;
  };

  readonly trace: {
    readonly enabled: boolean;
    readonly correlationId: string;
    readonly spanNames: readonly string[];
    readonly frameSpans: number;
    readonly framesMeasured: number;
  };

  readonly metrics: {
    readonly text: string;
  };

  readonly logs: {
    readonly correlationId: string;
    readonly recordCount: number;
    readonly correlatedRecordCount: number;
    readonly sampleMessage: string;
    readonly seed: string;
  };

  readonly surfaceSnapshot: {
    readonly schemaVersion: number;
    readonly correlationId: string;
    readonly sections: readonly string[];
    readonly prometheusLength: number;
  };
}

/** Members `DiagnosticsSnapshot` carries, in the order `Object.keys` sorts. */
const DIAGNOSTICS_SNAPSHOT_KEYS = Object.freeze([
  'correlationId',
  'generatedAt',
  'health',
  'hooks',
  'logs',
  'metrics',
  'schemaVersion',
  'traces',
] as const);

/**
 * Reads every observability surface in one round trip.
 *
 * @param page Page holding the running application.
 * @returns The reduced reading, with `available: false` where no application is
 *   published under `APPLICATION_GLOBAL`.
 */
async function readObservability(page: Page): Promise<ObservabilityReading> {
  return await page.evaluate(
    (request: {
      readonly globalName: string;
      readonly frameSpanName: string;
    }): ObservabilityReading => {
      const empty: ObservabilityReading = {
        available: false,
        health: { status: '', correlationId: '', ids: [], checks: [] },
        readiness: {
          ready: false,
          renderer: '',
          mayMountWebGLRenderer: false,
          requiresNumberOnlyFallback: false,
          webglLevel: '',
          webglStatus: '',
          storage: '',
          storageStrategy: '',
        },
        trace: {
          enabled: false,
          correlationId: '',
          spanNames: [],
          frameSpans: 0,
          framesMeasured: 0,
        },
        metrics: { text: '' },
        logs: {
          correlationId: '',
          recordCount: 0,
          correlatedRecordCount: 0,
          sampleMessage: '',
          seed: '',
        },
        surfaceSnapshot: {
          schemaVersion: -1,
          correlationId: '',
          sections: [],
          prometheusLength: 0,
        },
      };

      const published = (globalThis as unknown as Record<string, unknown>)[
        request.globalName
      ];

      if (published === undefined || published === null) {
        return empty;
      }

      const application = published as InspectionHandle;
      const report = application.health.check();
      const readiness = application.health.readiness();
      const trace = application.tracer.snapshot();
      const logs = application.logger.snapshot();
      const spanNames = Array.from(
        new Set(trace.spans.map((span): string => span.name)),
      );
      const parsed: unknown = JSON.parse(
        application.diagnostics.snapshotJson(),
      );
      const envelope: Record<string, unknown> =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>)
          : {};
      const version = envelope.schemaVersion;
      const envelopeCorrelation = envelope.correlationId;

      return {
        available: true,
        health: {
          status: report.status,
          correlationId: report.correlationId,
          ids: report.checks.map((check): string => check.id),
          checks: report.checks.map(
            (check): HealthCheckReading => ({
              id: check.id,
              status: check.status,
              detail: check.detail,
            }),
          ),
        },
        readiness: {
          ready: readiness.ready,
          renderer: readiness.renderer,
          mayMountWebGLRenderer: readiness.mayMountWebGLRenderer,
          requiresNumberOnlyFallback: readiness.requiresNumberOnlyFallback,
          webglLevel: readiness.webglLevel,
          webglStatus: readiness.webglStatus,
          storage: readiness.storage,
          storageStrategy: readiness.storageStrategy,
        },
        trace: {
          enabled: trace.enabled,
          correlationId: trace.correlationId,
          spanNames,
          frameSpans: trace.spans.filter(
            (span): boolean => span.name === request.frameSpanName,
          ).length,
          framesMeasured: trace.frames.frames,
        },
        metrics: { text: application.metrics.toPrometheusText() },
        logs: {
          correlationId: logs.correlationId,
          recordCount: logs.records.length,
          correlatedRecordCount: logs.records.filter(
            (record): boolean => record.correlationId === logs.correlationId,
          ).length,
          sampleMessage: logs.records[logs.records.length - 1]?.message ?? '',
          seed: application.run.seed(),
        },
        surfaceSnapshot: {
          schemaVersion: typeof version === 'number' ? version : -1,
          correlationId:
            typeof envelopeCorrelation === 'string' ? envelopeCorrelation : '',
          sections: Object.keys(envelope).sort(),
          prometheusLength: application.diagnostics.toPrometheusText().length,
        },
      };
    },
    { globalName: APPLICATION_GLOBAL, frameSpanName: FRAME_SPAN_NAME },
  );
}

/** Regular-expression metacharacters, escaped before a series is matched. */
const PATTERN_METACHARACTERS = /[.*+?^${}()|\[\]\\]/gu;

/**
 * The value one labelled Prometheus series carries.
 *
 * @param exposition The whole exposition, as `toPrometheusText()` renders it.
 * @param name Series name, including its prefix.
 * @param label The single label the family is broken down by.
 * @param value That label's value.
 * @returns The sample's value, or `null` where the series is absent.
 */
function seriesValue(
  exposition: string,
  name: string,
  label: string,
  value: string,
): number | null {
  const escaped = (text: string): string =>
    text.replace(PATTERN_METACHARACTERS, '\\$&');
  const sample = new RegExp(
    `^${escaped(name)}\\{${escaped(label)}="${escaped(value)}"\\} ` +
      '([0-9eE.+]+)$',
    'mu',
  );
  const found = sample.exec(exposition);

  if (found === null) {
    return null;
  }

  const parsed = Number(found[1]);

  return Number.isFinite(parsed) ? parsed : null;
}

/* ==========================================================================
 * 12. Fixed expectations of the opening board
 * ========================================================================== */

/**
 * Cells the parallel board carries at stage one: `DEFAULT_BOARD_SIZE` of
 * src/config/default-config.ts is 4, ported from js/application.js L3.
 */
const EXPECTED_BOARD_CELLS = 16;

/** `startTiles`, ported from js/game_manager.js L7. */
const EXPECTED_START_TILES = 2;

/** The first stage goal: `stageGoalForIndex(0)`, highest tile 16. */
const FIRST_STAGE_TARGET = 16;

/** The heading `stageProgressCopy.clearedHeading(1)` composes. */
const FIRST_STAGE_CLEARED_HEADING = 'Stage 1 cleared';

/**
 * The second stage's goal, as the ladder's second entry renders through
 * `hudCopy.goalValue`. The ladder consumes no randomness.
 */
const SECOND_STAGE_GOAL_TEXT = '/ 32 tile';

/**
 * The score outlet's rendered form: the visually-hidden label span, the value,
 * and the transient `+N` delta node where a turn scored, all flattened into one
 * `textContent`.
 */
const SCORE_TEXT = /^Score\d+(?:\+\d+)?$/u;

/** That outlet's rendered form before any turn has scored. */
const ZERO_SCORE_TEXT = 'Score0';

/**
 * The best-score outlet's rendered form. `getBestScore()` answers with the
 * stored STRING when one is present and the number 0 when it is absent, so the
 * rendered text is asserted and the value is never coerced.
 */
const BEST_SCORE_TEXT = /^Best score\d+$/u;

/* ==========================================================================
 * 13. The gate
 * ========================================================================== */

test.describe('recorded gameplay proof', () => {
  test.beforeEach(async ({ page }) => {
    // Before the document loads: the storage probe of
    // src/storage/local-storage-manager.ts runs once at construction and the
    // run-state read happens once, so a value written after load is never seen.
    await page.addInitScript(clearOwnedStorage, STORAGE_KEYS);
  });

  test.afterEach(async ({ page }) => {
    if (page.isClosed()) {
      return;
    }

    await page.evaluate(clearOwnedStorage, STORAGE_KEYS);
  });

  test(
    'records a run that renders the board in 2.5D, plays a merge with ' +
      'its animation and takes a relic from the reward screen',
    async ({ page, browser }) => {
      const video = page.video();

      expect(
        video,
        'no video was attached to the page, so no recording can be resolved ' +
          'for this gate',
      ).not.toBeNull();

      if (video === null) {
        throw new Error('the page carries no video to resolve');
      }

      // Relative, so the root configuration's `baseURL` and `webServer` remain
      // the single source of the origin.
      await page.goto('/');
      await expectScreen(page, 'runStart', 'cold load');

      /* -- The seeded run ------------------------------------------------- */

      const seedField = page.getByRole('textbox', { name: 'Seed (optional)' });
      const beginRun = page.getByRole('button', { name: 'Begin run' });

      await expect(
        seedField,
        'the run-start screen rendered no labelled seed field',
      ).toBeVisible();
      await expect(
        beginRun,
        'the run-start screen rendered no begin control',
      ).toBeEnabled();

      await seedField.fill(RUN_SEED);
      await expect(seedField).toHaveValue(RUN_SEED);

      await beginRun.click();
      await expectScreen(page, 'stage', 'beginning the run');

      // The board's first paint, held long enough to be legible in the frames.
      await page.waitForTimeout(BOARD_PAINT_SETTLE_MS);

      const opening = await readBoardSurface(page);

      expect(
        opening.canvasPresent,
        'no canvas was found inside the declared board host',
      ).toBe(true);
      expect(
        opening.canvasAriaHidden,
        'the board canvas must stay out of the accessibility tree',
      ).toBe('true');
      expect(
        opening.numberOnlyHidden,
        'the number-only host is unhidden, so the board on screen is the ' +
          'fallback rather than the 2.5D renderer',
      ).toBe(true);
      expect(
        opening.cellLabels.length,
        'the parallel board did not carry one cell per board cell',
      ).toBe(EXPECTED_BOARD_CELLS);
      expect(
        tileValuesOf(opening.cellLabels).length,
        'the opening board did not carry the configured start tiles',
      ).toBe(EXPECTED_START_TILES);
      expect(
        opening.scoreText,
        'the score outlet rendered no labelled value',
      ).toMatch(SCORE_TEXT);
      expect(
        opening.bestText,
        'the best-score outlet rendered no labelled value',
      ).toMatch(BEST_SCORE_TEXT);
      expect(
        opening.terminalOverlayClasses,
        'the retained terminal overlay carries a verdict class before any ' +
          'terminal state was reached',
      ).not.toContain('game-over');

      // The diagnostics surface is a runtime opt-in this case does not take,
      // and it paints at `zIndex.diagnosticsOverlay`, above every game layer.
      await expect(
        page.locator(SELECTORS.diagnostics),
        'the diagnostics surface is open over the recorded run',
      ).toBeHidden();

      /* -- Criterion (a): the board renders in 2.5D ----------------------- */

      const context = await probeWebGLContext(page);

      expect(
        context.level,
        'no WebGL context was obtained, so the software-GL launch ' +
          'arguments the root configuration passes did not take effect',
      ).toBe('webgl2');
      expect(
        context.version,
        'the context reported no version string',
      ).not.toBe('');
      expect(
        context.version,
        'the context did not report itself as WebGL',
      ).toContain('WebGL');
      expect(
        context.debugInfoExposed,
        'WEBGL_debug_renderer_info was not exposed, so the renderer string ' +
          'could not be read back',
      ).toBe(true);
      expect(
        `${context.vendor} ${context.renderer}`,
        'the live context does not report the ANGLE over SwiftShader ' +
          'path the root configuration selects',
      ).toContain('ANGLE');
      expect(
        context.renderer,
        'the live context does not report the SwiftShader renderer',
      ).toContain('SwiftShader');

      expectRenderedBoard(await sampleBoardCanvas(page), 'the opening board');

      /* -- Criterion (b): a merge, with its animation --------------------- */

      let moves = 0;
      let mergeAnnouncement = '';
      let mergeDeltaText = '';
      let mergeCellLabels: readonly string[] = [];

      while (mergeAnnouncement === '' && moves < MERGE_MOVE_CAP) {
        const key = MOVE_KEYS[moves % MOVE_KEYS.length];

        await pressMove(page, key, FILMED_MOVE_SETTLE_MS);
        moves += 1;

        const turn = await readBoardSurface(page);

        if (turn.screen !== 'stage') {
          break;
        }

        if (MERGE_ANNOUNCEMENT.test(turn.announcement)) {
          mergeAnnouncement = turn.announcement;
          mergeDeltaText = turn.scoreDeltaText;
          mergeCellLabels = turn.cellLabels;
        }
      }

      expect(
        mergeAnnouncement,
        `no merge was announced within ${MERGE_MOVE_CAP} moves under seed ` +
          `"${RUN_SEED}", so the recording cannot show one`,
      ).toMatch(MERGE_ANNOUNCEMENT);
      expect(
        mergeDeltaText,
        'the merged turn wrote no `+N` score delta beside the score',
      ).toMatch(SCORE_DELTA_TEXT);

      // The pop runs 300ms and the score delta 600ms from the merge.
      await page.waitForTimeout(MERGE_POP_MS + SCORE_DELTA_MS);

      const announced = MERGE_RESULT_VALUE.exec(mergeAnnouncement);
      const mergedValue = Number(
        announced?.[1] ?? announced?.[2] ?? Number.NaN,
      );

      expect(
        Number.isFinite(mergedValue),
        `the merge announcement "${mergeAnnouncement}" reported no result ` +
          'value',
      ).toBe(true);
      expect(
        tileValuesOf(mergeCellLabels),
        `the merged turn announced a ${mergedValue} that the board does not ` +
          'carry',
      ).toContain(mergedValue);
      expect(
        mergedValue,
        'the announced merge product is below the smallest one the rules can ' +
          'produce',
      ).toBeGreaterThanOrEqual(4);

      const merged = await readBoardSurface(page);

      expect(
        highestTileOf(merged.cellLabels),
        'the merged tile left the board while its animation played',
      ).toBeGreaterThanOrEqual(mergedValue);
      expect(
        merged.scoreText,
        'the score outlet stopped rendering a value',
      ).toMatch(SCORE_TEXT);
      expect(
        merged.scoreText,
        'the score never left zero, so no merge scored',
      ).not.toBe(ZERO_SCORE_TEXT);

      /* -- The stage clear, which is the stage end ------------------------ */

      while (moves < STAGE_CLEAR_MOVE_CAP) {
        const before = await readBoardSurface(page);

        if (before.screen !== 'stage') {
          break;
        }

        await pressMove(
          page,
          MOVE_KEYS[moves % MOVE_KEYS.length],
          MOVE_SETTLE_MS,
        );
        moves += 1;
      }

      const cleared = await readBoardSurface(page);

      expect(
        cleared.screen,
        `the stage goal was not met within ${STAGE_CLEAR_MOVE_CAP} moves: ` +
          `the state is "${cleared.screen}", the highest tile is ` +
          `${highestTileOf(cleared.cellLabels)} and the first goal is tile ` +
          `${FIRST_STAGE_TARGET}`,
      ).toBe('stageClear');

      const stageClearPanel = page.locator('#screen-stage-progress');

      await expect(
        stageClearPanel,
        'the stage-clear interstitial did not name the stage it cleared',
      ).toContainText(FIRST_STAGE_CLEARED_HEADING);

      const stageBeforeReward = cleared.stageText;

      // `SCREEN_SETTLE_MS`: the pop plus score-delta window.
      await page.waitForTimeout(SCREEN_SETTLE_MS);

      await page.getByRole('button', { name: 'Continue' }).click();
      await expectScreen(page, 'reward', 'continuing past the stage clear');

      /* -- Criterion (c): the reward-screen relic selection --------------- */

      // The cards carry the `pop` entrance, which runs 300ms from entry.
      await page.waitForTimeout(SCREEN_SETTLE_MS);

      const cards = page.locator(SELECTORS.rewardCard);

      await expect(
        cards,
        `the reward screen did not present ${EXPECTED_OFFER_COUNT} offers`,
      ).toHaveCount(EXPECTED_OFFER_COUNT);

      const offer = await readBoardSurface(page);

      expect(
        offer.offerIds.length,
        'a reward card carried no relic identifier',
      ).toBe(EXPECTED_OFFER_COUNT);
      expect(
        offer.offerIds.filter((id): boolean => id !== '').length,
        'a reward card carried an empty relic identifier',
      ).toBe(EXPECTED_OFFER_COUNT);
      expect(
        new Set(offer.offerIds).size,
        'one offer presented the same relic twice: ' +
          offer.offerIds.join(', '),
      ).toBe(EXPECTED_OFFER_COUNT);

      const firstCard = cards.first();

      await expect(
        firstCard.locator('.relic-card-name'),
        'the reward card rendered no relic name',
      ).toHaveCount(1);
      await expect(
        firstCard.locator('.relic-card-rarity'),
        'the reward card rendered no rarity chip',
      ).toHaveCount(1);
      await expect(
        firstCard.locator('.relic-card-description'),
        'the reward card rendered no description',
      ).toHaveCount(1);
      expect(
        await firstCard.locator('.relic-hook-badge').count(),
        'the reward card rendered no hook badge',
      ).toBeGreaterThan(0);
      await expect(
        firstCard,
        'the reward card is not operable',
      ).toBeEnabled();

      const chosenRelicId = offer.offerIds[0];

      await firstCard.click();
      await expectScreen(page, 'stage', 'taking the relic');

      // `SCREEN_SETTLE_MS` again, after the selection.
      await page.waitForTimeout(SCREEN_SETTLE_MS);

      const taken = await readBoardSurface(page);

      expect(
        taken.trayRelicIds,
        'the relic taken did not appear in the HUD tray',
      ).toEqual([chosenRelicId]);
      expect(
        taken.stageText,
        'the HUD stage readout did not change after the reward was taken',
      ).not.toBe(stageBeforeReward);
      expect(
        taken.stageText,
        'the HUD does not report the second stage goal of the ladder',
      ).toContain(SECOND_STAGE_GOAL_TEXT);

      /* -- The stage the relic opened ------------------------------------- */

      // A relic taken compounds on later merges, and a further stage goal can
      // be met inside this window. Each move is played from the `stage` state,
      // and any screen raised by the previous one is resolved first.
      const heldRelicIds = [chosenRelicId];

      for (let played = 0; played < POST_REWARD_MOVES; played += 1) {
        await resolveOverlaysToStage(
          page,
          heldRelicIds,
          `move ${played + 1} of the stage the relic opened`,
        );
        await pressMove(
          page,
          MOVE_KEYS[(moves + played) % MOVE_KEYS.length],
          MOVE_SETTLE_MS,
        );
      }

      await resolveOverlaysToStage(
        page,
        heldRelicIds,
        'the end of the recorded run',
      );

      const resumed = await readBoardSurface(page);

      expect(
        resumed.screen,
        'the run did not come to rest on a playable board',
      ).toBe('stage');
      expect(
        resumed.trayRelicIds,
        'the HUD tray does not hold every relic taken, in pickup order',
      ).toEqual(heldRelicIds);
      expect(
        resumed.trayRelicIds[0],
        'the first relic taken is no longer first in the tray',
      ).toBe(chosenRelicId);

      expectRenderedBoard(
        await sampleBoardCanvas(page),
        'the board after the relic was taken',
      );

      /* -- The run ended alive, and it persisted under its own key -------- */

      // The verdict classes are written with the commit; the overlay fades over
      // 1200ms + 800ms. `TERMINAL_OVERLAY_MS` clears that whole cadence.
      await page.waitForTimeout(TERMINAL_OVERLAY_MS);

      const settled = await readBoardSurface(page);

      expect(
        settled.terminalOverlayClasses,
        'the retained overlay carries the loss verdict, so the recorded run ' +
          'ended rather than continuing',
      ).not.toContain('game-over');
      expect(
        settled.terminalOverlayClasses,
        'the retained overlay carries the win verdict',
      ).not.toContain('game-won');
      await expect(
        page.locator(SELECTORS.terminalOverlay),
        'the terminal overlay is on screen with no verdict written',
      ).toBeHidden();

      const stored = await readStoredState(page, RUN_SEED);

      expect(
        stored.runStatePresent,
        `the run was not persisted under "${RUN_STATE_KEY}"`,
      ).toBe(true);
      expect(
        stored.runStateHoldsSeed,
        'the persisted run does not carry the seed that was played',
      ).toBe(true);
      expect(
        stored.namespacedKeys.some((key): boolean => key === RUN_STATE_KEY),
        'the run state was written outside the application namespace',
      ).toBe(true);

      /* -- The artifact --------------------------------------------------- */

      // Playwright writes the WebM at context close. The context is closed
      // here and the artifact is resolved afterwards.
      await page.context().close();

      const recordingPath = await video.path();

      expect(
        recordingPath,
        'the recording did not resolve to a WebM path',
      ).toMatch(/\.webm$/u);

      const recordedBytes = await fileByteSize(browser, recordingPath);

      expect(
        recordedBytes,
        `the recording at ${recordingPath} is empty, so it carries no frames`,
      ).toBeGreaterThan(0);
    },
  );

  test(
    'reports the six health checks, the module-boundary spans, the ' +
      'Prometheus exposition and the correlated log records through the ' +
      'diagnostics surface',
    async ({ page }) => {
      // The surface is a runtime opt-in, off by default, and it paints above
      // every game layer. It is opened here and in no other case.
      await page.goto(DIAGNOSTICS_QUERY);
      await expectScreen(page, 'runStart', 'cold load with diagnostics on');

      const overlay = page.locator(SELECTORS.diagnostics);

      await expect(
        overlay,
        'the diagnostics surface did not open for a session carrying ' +
          `"${DIAGNOSTICS_QUERY}"`,
      ).toBeVisible();

      for (const heading of DIAGNOSTICS_PANEL_HEADINGS) {
        await expect(
          overlay,
          `the diagnostics surface rendered no "${heading}" panel`,
        ).toContainText(heading);
      }

      expect(
        await overlay.locator('button').allInnerTexts(),
        'the diagnostics control row is not the row the surface declares',
      ).toEqual([...DIAGNOSTICS_CONTROL_LABELS]);

      /* -- A run with at least one merge behind it ------------------------ */

      await page
        .getByRole('textbox', { name: 'Seed (optional)' })
        .fill(RUN_SEED);
      await page.getByRole('button', { name: 'Begin run' }).click();
      await expectScreen(page, 'stage', 'beginning the observed run');
      await page.waitForTimeout(BOARD_PAINT_SETTLE_MS);

      let observedMoves = 0;
      let merged = false;

      while (!merged && observedMoves < MERGE_MOVE_CAP) {
        await pressMove(
          page,
          MOVE_KEYS[observedMoves % MOVE_KEYS.length],
          MOVE_SETTLE_MS,
        );
        observedMoves += 1;

        const turn = await readBoardSurface(page);

        if (turn.screen !== 'stage') {
          break;
        }

        merged = MERGE_ANNOUNCEMENT.test(turn.announcement);
      }

      expect(
        merged,
        `no merge was announced within ${MERGE_MOVE_CAP} moves, so the ` +
          'merge-bearing counters cannot be asserted',
      ).toBe(true);

      /* -- The reading ---------------------------------------------------- */

      const reading = await readObservability(page);

      expect(
        reading.available,
        `no application was published as "${APPLICATION_GLOBAL}", so the ` +
          'observability surfaces are unreachable',
      ).toBe(true);

      /* -- Health: the five reused probes and the added WebGL one --------- */

      expect(
        reading.health.ids,
        'the health report does not carry the six checks in report order',
      ).toEqual([...HEALTH_CHECK_IDS]);

      for (const check of reading.health.checks) {
        expect(
          check.status,
          `health check "${check.id}" reported "${check.status}": ` +
            check.detail,
        ).toBe('pass');
      }

      expect(
        reading.health.status,
        'the health roll-up is not a pass',
      ).toBe('pass');
      expect(
        reading.health.correlationId,
        'the health report carries no correlation identifier',
      ).not.toBe('');

      /* -- Readiness: the verdict src/main.ts mounts a renderer from ------ */

      expect(
        reading.readiness.renderer,
        'readiness does not report the 2.5D renderer as the one to mount',
      ).toBe('webgl');
      expect(
        reading.readiness.mayMountWebGLRenderer,
        'readiness refuses the WebGL renderer',
      ).toBe(true);
      expect(
        reading.readiness.requiresNumberOnlyFallback,
        'readiness requires the number-only fallback',
      ).toBe(false);
      expect(
        reading.readiness.webglLevel,
        'readiness does not report a WebGL 2 context',
      ).toBe('webgl2');
      expect(
        reading.readiness.webglStatus,
        'the WebGL check behind the readiness verdict did not pass',
      ).toBe('pass');
      expect(
        reading.readiness.storage,
        'readiness does not report a store that survives a reload',
      ).toBe('persistent');
      expect(
        reading.readiness.storageStrategy,
        'readiness names no live storage strategy',
      ).toBe('localStorage');
      expect(
        reading.readiness.ready,
        'readiness is not satisfied with every capability it gates on',
      ).toBe(true);

      /* -- Tracing: the frame seam and the turn chain --------------------- */

      expect(
        reading.trace.enabled,
        'the tracer is not opening spans',
      ).toBe(true);
      expect(
        reading.trace.frameSpans,
        `no "${FRAME_SPAN_NAME}" span was recorded, so the frame callback is ` +
          'unmeasured',
      ).toBeGreaterThan(0);
      expect(
        reading.trace.framesMeasured,
        'the tracer measured no frames',
      ).toBeGreaterThan(0);

      for (const span of TURN_SPAN_NAMES) {
        expect(
          reading.trace.spanNames,
          `no "${span}" span was recorded, so the turn chain is not covered ` +
            'end to end',
        ).toContain(span);
      }

      expect(
        reading.trace.correlationId,
        'the trace snapshot does not share the health correlation identifier',
      ).toBe(reading.health.correlationId);

      /* -- Metrics: the Prometheus exposition ---------------------------- */

      expect(
        reading.metrics.text.length,
        'the metrics registry exported an empty exposition',
      ).toBeGreaterThan(0);
      expect(
        reading.metrics.text,
        'the exposition carries no series under the declared prefix',
      ).toContain(METRIC_PREFIX);

      for (const hook of HOOK_NAMES) {
        expect(
          seriesValue(reading.metrics.text, HOOK_DISPATCH_METRIC, 'hook', hook),
          `the exposition carries no "${hook}" dispatch series`,
        ).not.toBeNull();
      }

      for (const hook of HOOKS_DISPATCHED_MID_STAGE) {
        expect(
          seriesValue(reading.metrics.text, HOOK_DISPATCH_METRIC, 'hook', hook),
          `the "${hook}" hook was never dispatched`,
        ).toBeGreaterThan(0);
      }

      for (const event of EVENTS_EMITTED_MID_STAGE) {
        expect(
          seriesValue(
            reading.metrics.text,
            ENGINE_EVENT_METRIC,
            'event',
            event,
          ),
          `the "${event}" engine event was never emitted`,
        ).toBeGreaterThan(0);
      }

      /* -- Logging: the run correlation identifier ------------------------ */

      expect(
        reading.logs.correlationId,
        'the logger carries no correlation identifier',
      ).toBe(reading.health.correlationId);
      expect(
        reading.logs.recordCount,
        'the logger buffered no records',
      ).toBeGreaterThan(0);
      expect(
        reading.logs.correlatedRecordCount,
        'no buffered record carries the correlation identifier of the run ' +
          'in force',
      ).toBeGreaterThan(0);
      expect(
        reading.logs.sampleMessage,
        'a buffered record carries no message',
      ).not.toBe('');
      expect(
        reading.logs.seed,
        'the run does not report the seed its correlation identifier is ' +
          'derived from',
      ).toBe(RUN_SEED);

      /* -- The surface itself, and its export ---------------------------- */

      expect(
        reading.surfaceSnapshot.schemaVersion,
        'the diagnostics snapshot carries no schema version',
      ).toBeGreaterThan(0);
      expect(
        reading.surfaceSnapshot.correlationId,
        'the diagnostics snapshot does not share the correlation identifier',
      ).toBe(reading.health.correlationId);
      expect(
        reading.surfaceSnapshot.sections,
        'the diagnostics snapshot does not carry every section it declares',
      ).toEqual([...DIAGNOSTICS_SNAPSHOT_KEYS]);
      expect(
        reading.surfaceSnapshot.prometheusLength,
        'the diagnostics surface exported an empty exposition of its own',
      ).toBeGreaterThan(0);

      const exportControl = overlay.getByRole('button', {
        name: 'Export snapshot',
      });

      await expect(
        exportControl,
        'the diagnostics surface offers no snapshot export',
      ).toBeEnabled();

      const download = page.waitForEvent('download');

      await exportControl.click();

      expect(
        (await download).suggestedFilename(),
        'the snapshot export did not offer the file the surface declares',
      ).toBe(DIAGNOSTICS_EXPORT_FILENAME);
    },
  );
});
