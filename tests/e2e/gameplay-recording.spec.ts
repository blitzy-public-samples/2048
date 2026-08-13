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
// The encoded artifact is not taken on trust: after the context closes it is
// decoded in a browser and its pixels are measured, because a `.webm` suffix and
// a positive byte count are satisfied by a header-only, truncated, black or
// single-colour file. The run is also played to a real loss, acknowledged
// through the terminal control, and checked against its own summary, and the
// deterministic outcome of the seed is pinned rather than described.
//
// The root playwright.config.ts is the authority for retention, the software-GL
// launch arguments, the viewport, the output directory, the base origin and the
// web server. Nothing here restates or overrides any of them. Each case declares
// the TAG its project selects on — `@gameplay` for the recorded proof and
// `@diagnostics` for the observability exercise — so the video is retained for
// the run that is the proof and for nothing else.
// Decisions: DL-PW-01, DL-PW-02, DL-PW-03, DL-PW-05, DL-PW-07, DL-PW-08,
//   DL-PW-09, DL-PW-10
// (docs/DECISION_LOG.md).
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, continuing this
// area's ordinals from the configuration above, all target-only:
//   TR-PW-05  the seeded scenario, its pinned outcome, the merge window and the
//             stage clear that raises the first reward round
//   TR-PW-06  `readBoardSurface` and the screen state read from `hidden`
//   TR-PW-07  the canvas-content verdict and the live WebGL probe
//   TR-PW-08  `resolveOverlaysToStage`, the drive to a terminal state and the
//             summary
//   TR-PW-09  `fileByteSize` with `probeRecording` and the decoded-artifact gate
//   TR-PW-10  `clearOwnedStorage`, `readRunEnvelope` and the storage teardown
//   TR-PW-11  the observability case read through the diagnostics surface
//
// Provenance of the constants below:
//   style/main.scss                   the `$transition-speed` token, the
//                                     move transition and the `move-up`,
//                                     `fade-in`, `appear` and `pop`
//                                     keyframes: the timing budget and the
//                                     overlay delay
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

/* --------------------------------------------------------------------------
 * The deterministic outcome of `RUN_SEED`.
 *
 * Every value below was MEASURED in this browser against the built bundle and
 * reproduced identically across three runs, two of them with deliberately
 * different per-move settle timings, so each is a function of the seed and the
 * fixed key sequence rather than of how fast the run was driven. Pinning them
 * is what makes the seed load-bearing: a run that ignored the entered seed, or
 * a spawn sequence that drifted, satisfies a move cap but not these.
 *
 * They hold only for `RUN_SEED` played as `MOVE_KEYS` cycled from `ArrowUp`,
 * taking the FIRST offered card at every reward round. Changing the rules, the
 * stage curve, the relic pool or the key order changes them by design, and the
 * failure names the value that moved. DL-PW-05.
 * ----------------------------------------------------------------------- */

/** The two starting tiles, as the parallel board labels them, in DOM order. */
const OPENING_CELL_LABELS = Object.freeze([
  'Row 1, column 4, 2',
  'Row 3, column 2, 2',
] as const);

/** The move that first merges, counted from 1. */
const FIRST_MERGE_MOVE = 2;

/** The value that first merge produces. */
const FIRST_MERGE_PRODUCT = 4;

/** The move that clears the first stage. */
const FIRST_STAGE_CLEAR_MOVE = 15;

/** The first reward round's three offers, in the order they are presented. */
const FIRST_OFFER_IDS = Object.freeze([
  'alloy-forge',
  'echo-chamber',
  'gilded-rot',
] as const);

/** The move the run is lost on. */
const TERMINAL_MOVE = 65;

/** The score the lost run finishes with. */
const TERMINAL_SCORE = 3274;

/** The stage the lost run reaches, as the summary reports it. */
const TERMINAL_STAGE = 8;

/** `schemaVersion` of the persisted envelope. */
const RUN_STATE_SCHEMA_VERSION = 1;

/** The four RNG substreams, and their cursors before any move is played. */
const OPENING_RNG_CURSOR = Object.freeze({
  'spawn-value': 2,
  'spawn-position': 2,
  'relic-draw': 0,
  'rarity-weight': 0,
});

/** The first stage's goal, as the envelope records it. */
const OPENING_STAGE_GOAL = Object.freeze({
  kind: 'highest-tile',
  target: 16,
});

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

/**
 * Interval the in-page recorder samples the frame counter at, in milliseconds:
 * one 60Hz frame.
 */
const RECORDER_SAMPLE_MS = 16;

/* --------------------------------------------------------------------------
 * Probing the encoded artifact.
 * ----------------------------------------------------------------------- */

/**
 * Step between decoded video samples, in seconds.
 *
 * Playwright encodes at 25fps, so 40ms is one frame and this resolves every
 * frame the encoder wrote.
 */
const FRAME_STEP_S = 0.04;

/** Samples taken across the whole recording to characterise it. */
const SWEEP_SAMPLE_COUNT = 24;

/**
 * Distinct frames a sweep of the whole recording must contain.
 *
 * A recording of a played run changes continuously. A static or single-colour
 * encode collapses to one signature however many times it is sampled, which is
 * the case this rejects.
 */
const MIN_DISTINCT_SWEEP_FRAMES = 6;

/**
 * Distinct frames required inside the isolated merge window.
 *
 * The 100ms move transition has finished before this window opens, so the
 * merge pop is the only board motion left in it. A pop that was deleted leaves
 * the window's frames identical.
 */
const MIN_DISTINCT_MERGE_FRAMES = 2;

/**
 * The recorded frame size, which playwright.config.ts sets from its `VIEWPORT`
 * and reuses verbatim as the video size.
 */
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 960;

/** Seconds either side of a recorded milestone that a search will accept. */
const MILESTONE_TOLERANCE_S = 1.5;

/**
 * Step between decoded samples of a milestone bracket, in seconds.
 *
 * Six encoded frames. A held screen state stands for `MILESTONE_HOLD_MS`, so
 * this resolves several samples inside the state however the bracket lands.
 */
const MILESTONE_STEP_S = FRAME_STEP_S * 6;

/** Step between decoded samples of the merge window, in seconds. */
const MERGE_STEP_S = FRAME_STEP_S * 2;

/**
 * Seconds either side of a mapped milestone that its bracket reaches.
 *
 * The recording's own timeline and the wall clock are related by the rate the
 * encoder actually wrote at, which is measured rather than assumed; this is the
 * slack that rate is searched within, and it was measured at 2.5s over the
 * runs this scenario was pinned against.
 */
const MILESTONE_SEARCH_S = 6;

/** Milliseconds a filmed screen state is held before the run moves on. */
const MILESTONE_HOLD_MS = MILESTONE_TOLERANCE_S * 1000 + MOVE_SETTLE_MS;

/**
 * Samples of the merged cell taken where nothing is animating, one every
 * `MERGE_STEP_S` from the frame the settled state was found at.
 */
const SETTLED_SAMPLE_COUNT = 8;

/** Edge of the grayscale grid each measured picture is reduced to. */
const THUMBNAIL_EDGE = 12;

/**
 * Mean per-cell difference, on the 0-255 scale, within which a decoded frame
 * carries the same picture as a clip of the live page.
 *
 * The clip is exact and the frame is VP8, so a match is close rather than
 * equal.
 */
const MATCH_TOLERANCE = 12;

/**
 * Mean per-cell difference, on the same scale, that separates two pictures of
 * DIFFERENT screen states.
 */
const MIN_STATE_CHANGE = 24;

/**
 * Mean per-cell difference, on the same scale, that separates two decoded
 * pictures of one board cell across a merge animation.
 */
const MIN_MERGE_CHANGE = 6;

/**
 * Factor by which the change inside the merge window must exceed the change
 * measured over the same cell while nothing is animating.
 */
const MERGE_CHANGE_MARGIN = 2;

/**
 * The counter `src/observability/metrics.ts` advances once per drawn frame.
 *
 * Read to establish that the render loop was live while an animation played. It
 * advances whether or not a merge is animating, so it is corroboration and not
 * the proof on its own; the discriminating evidence is temporal change in the
 * decoded frames.
 */
const FRAMES_RENDERED_METRIC = 'game2048_frames_rendered_total';

/**
 * The collapsed counter family every reporter count lands in, declared by
 * `REPORT_COUNTER_NAME` of src/main.ts.
 */
const REPORT_COUNTER_FAMILY = 'game2048_reports_total';

/** `MERGE_METRIC` of src/render/three-renderer.ts, as the `report` label. */
const RENDER_MERGE_REPORT = 'render.three.merge';

/** The renderer mode that means the 2.5D WebGL board is the surface drawing. */
const THREE_RENDERER_MODE = 'three';

/**
 * Iteration bound on the loop that plays the run out to its end.
 *
 * Under `RUN_SEED` the run is lost on `TERMINAL_MOVE`; this is the loop's
 * guarantee of termination and not an expectation.
 */
const TERMINAL_MOVE_CAP = 200;

/** The score the terminal screen reports, as `src/ui/screens/game-over.ts` words it. */
const TERMINAL_OVERLAY_SCORE = /Score (\d+)/u;

/** `runSummaryCopy.title('lost')` of src/ui/screens/run-summary.ts. */
const RUN_LOST_TEXT = /Run lost/u;

/** `runSummaryCopy.scoreLabel` of src/ui/screens/run-summary.ts. */
const SUMMARY_SCORE_LABEL = 'Final score';

/** `runSummaryCopy.stageLabel` of src/ui/screens/run-summary.ts. */
const SUMMARY_STAGE_LABEL = 'Stage reached';

/** The `data-outcome` a lost run writes: `RunOutcome` of src/run/run-state.ts. */
const LOST_OUTCOME = 'lost';

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

  /**
   * The reward dialog's own surface, `rewardScreenClasses.panel` of
   * src/ui/screens/reward.ts, inside the container index.html declares.
   */
  rewardPanel: '#screen-reward .reward-panel',
  diagnostics: '#diagnostics-overlay',
  diagnosticsControl: '#diagnostics-overlay button',

  /** The terminal screen's only control, of src/ui/screens/game-over.ts. */
  acknowledgeTerminal: '#screen-game-over [data-action="acknowledge"]',

  /**
   * The run-summary panel, which carries `data-outcome`.
   *
   * The `<section>` the module builds INSIDE the screen container, not the
   * container itself: `runSummaryClasses.panel` is what the attribute lands on.
   */
  runSummary: '#screen-run-summary .run-summary',

  /**
   * The summary's relic list, whose source order IS pickup order.
   *
   * `runSummaryClasses.relicList` is a CLASS on the `<ol>`, not an id: the
   * module carries ids only for the elements it cross-references by `aria-*`.
   */
  summaryRelic: '#screen-run-summary .run-summary-relic-list [data-relic-id]',

  /** The selectable seed the summary surfaces for a replay. */
  summarySeed: '#run-summary-seed-value',

  /** One readout row of the summary: a caption and a value. */
  summaryScore: '#screen-run-summary .run-summary-score',
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

/**
 * The static dashboard template, as a file URL.
 *
 * Rule 3's dashboard template is delivered only where an exported snapshot
 * actually renders in it, so this case opens the file itself and feeds it the
 * export the session just produced. Resolved from this module's own URL rather
 * than from a working directory or a `node:` module, because these specs are
 * type-checked as browser-context sources and reach no Node global.
 * Decision DL-TEST-09.
 */
const DASHBOARD_TEMPLATE_URL = new URL(
  '../../docs/dashboards/dashboard.html',
  import.meta.url,
).href;

/** Selectors of the ingest path docs/dashboards/dashboard.html declares. */
const DASHBOARD_SELECTORS = Object.freeze({
  pasteBox: '#snapshot-text',
  render: '#render-pasted',
  clear: '#clear-all',
  status: '#status',
  provenance: '#provenance',
  healthPanel: '[aria-labelledby="panel-health"]',
  runTotalsPanel: '[aria-labelledby="panel-run-totals"]',
  tracePanel: '[aria-labelledby="panel-traces"]',
} as const);


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

  /** Text of the terminal screen, which carries the verdict and the score. */
  readonly terminalText: string;

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
      terminalText: (
        document.getElementById('screen-game-over')?.textContent ?? ''
      ).trim(),
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

/** What the render loop did while one filmed move played. */
interface FilmedMove {
  /** Wall clock at the press, for locating the move inside the recording. */
  readonly pressedAt: number;

  /** Frames the render loop drew across the bracketed `MERGE_POP_MS` window. */
  readonly framesInPopWindow: number;

  /**
   * Samples the bracket holds: those inside the window, plus the one that
   * closes it.
   */
  readonly samplesInPopWindow: number;

  /** Offset of the sample that closed the bracket, in ms from the press. */
  readonly popWindowClosedAtMs: number;

  /** Frames drawn across the whole recorded window. */
  readonly framesDrawn: number;
}

/**
 * Presses one move while an in-page recorder watches the render loop.
 *
 * The merge pop runs for `MERGE_POP_MS` from the press, and NOTHING DRIVEN FROM
 * NODE CAN OBSERVE THAT WINDOW: a `page.screenshot` of the board takes longer
 * than the window is open — measured at over 600ms for the first capture — and
 * reading the WebGL canvas with `drawImage` returns a cleared buffer, because
 * the context is not created with `preserveDrawingBuffer`. So the observation is
 * made INSIDE the page: a loop installed before the press samples the frame
 * counter every `RECORDER_SAMPLE_MS`, and the series is read back afterwards.
 *
 * The loop is driven by a TIMER where it was driven by
 * `requestAnimationFrame`, so how many samples it takes is a property of the
 * clock rather than of the render loop it is measuring. DL-PW-09.
 *
 * The pop window is bracketed rather than filtered, because neither a
 * timer nor a frame callback can be relied on to fire inside a window the
 * thread it shares with the renderer may occupy entirely. DL-PW-10.
 *
 * The recorder replaces the settle rather than adding to it.
 *
 * @param page Page to drive.
 * @param key Movement key to press.
 * @param windowMs Milliseconds to record from the press.
 * @returns What the render loop did.
 */
async function playFilmedMove(
  page: Page,
  key: MoveKey,
  windowMs: number,
): Promise<FilmedMove> {
  const pressedAt = Date.now();

  const [series] = await Promise.all([
    page.evaluate(
      async (request: {
        readonly windowMs: number;
        readonly counter: string;
        readonly sampleMs: number;
      }): Promise<readonly { readonly ms: number; readonly f: number }[]> => {
        const surface = (
          globalThis as unknown as {
            readonly __blitzy2048?: {
              readonly metrics?: {
                readonly snapshot: () => {
                  readonly series: readonly {
                    readonly name: string;
                    readonly value: number;
                  }[];
                };
              };
            };
          }
        ).__blitzy2048;

        const readCounter = (): number => {
          const found = surface?.metrics
            ?.snapshot()
            .series.find((entry): boolean => entry.name === request.counter);

          return found === undefined ? -1 : found.value;
        };

        const started = performance.now();
        const samples: { readonly ms: number; readonly f: number }[] = [];
        const stopAt = started + request.windowMs;

        await new Promise<void>((resolve): void => {
          const step = (): void => {
            samples.push({
              ms: Math.round(performance.now() - started),
              f: readCounter(),
            });

            if (performance.now() < stopAt) {
              window.setTimeout(step, request.sampleMs);

              return;
            }

            resolve();
          };

          step();
        });

        return samples;
      },
      {
        windowMs,
        counter: FRAMES_RENDERED_METRIC,
        sampleMs: RECORDER_SAMPLE_MS,
      },
    ),
    page.keyboard.press(key),
  ]);

  // THE POP WINDOW IS BRACKETED, NOT FILTERED. The sampler and the render loop
  // share the page's one main thread, so a single long task — an engine turn
  // plus a software-rendered WebGL frame — can span the whole window and leave
  // only the synchronous opening sample strictly inside it. Taking every sample
  // up to the window closing PLUS the first one at or after it keeps the frames
  // drawn across the window measurable in that case, and the closing offset is
  // reported so the caller can reject an observation that ran too late to be
  // the merge's own. DL-PW-10.
  const closingIndex = series.findIndex(
    (sample): boolean => sample.ms >= MERGE_POP_MS,
  );
  const inWindow =
    closingIndex === -1 ? series : series.slice(0, closingIndex + 1);
  const span = (
    samples: readonly { readonly ms: number; readonly f: number }[],
  ): number =>
    samples.length === 0
      ? 0
      : samples[samples.length - 1].f - samples[0].f;

  return {
    pressedAt,
    framesInPopWindow: span(inWindow),
    samplesInPopWindow: inWindow.length,
    popWindowClosedAtMs:
      inWindow.length === 0 ? 0 : inWindow[inWindow.length - 1].ms,
    framesDrawn: span(series),
  };
}

/**
 * Name the recorder below collects under. Owned by this spec; the application
 * declares nothing under it.
 */
const TURN_GEOMETRY_GLOBAL = '__blitzyRecordedTurnGeometry';

/** One board cell an engine event named, in engine coordinates. */
interface CellRef {
  /** Column, zero-based, as src/engine/tile.ts holds it. */
  readonly x: number;

  /** Row, zero-based. */
  readonly y: number;

  /** The commit the event belongs to, as its `turn` carried it. */
  readonly turn: number;
}

/** What the recorder collected while the run played. */
interface TurnGeometry {
  /** Whether the engine's emitter was reachable. */
  readonly attached: boolean;

  /**
   * `tile:merge` target cells, in emission order.
   *
   * `target` is the tile that already occupied the destination cell, and
   * src/engine/move-resolver.ts builds the merged tile at that same cell, so
   * this is where the merged tile is.
   */
  readonly merged: readonly CellRef[];

  /** `tile:spawn` cells that carried a position, in emission order. */
  readonly spawned: readonly CellRef[];
}

/** The `tile:merge` and `tile:spawn` fields the recorder reads. */
interface RecordedEvent {
  readonly turn: number;
  readonly target?: { readonly x: number; readonly y: number } | undefined;
  readonly position?: { readonly x: number; readonly y: number } | undefined;
}

/** The subscription surface `Engine.events` offers this recorder. */
interface RecordedEmitter {
  on(name: string, listener: (event: RecordedEvent) => void): unknown;
}

/**
 * Subscribes to the engine's own emitter so the cells one turn merged into and
 * spawned at can be read back afterwards.
 *
 * Installed once; a second call is a no-op that reports the first one's state.
 *
 * @param page Page carrying the running application.
 * @returns Whether the emitter was reached and the recorder is collecting.
 */
async function recordTurnGeometry(page: Page): Promise<boolean> {
  return await page.evaluate(
    (request: {
      readonly application: string;
      readonly sink: string;
    }): boolean => {
      const holder = globalThis as unknown as Record<string, unknown>;

      if (holder[request.sink] !== undefined) {
        return true;
      }

      const application = holder[request.application] as
        | { readonly engine?: { readonly events?: RecordedEmitter } }
        | undefined;
      const events = application?.engine?.events;

      if (events === undefined) {
        return false;
      }

      const sink: {
        readonly merged: { x: number; y: number; turn: number }[];
        readonly spawned: { x: number; y: number; turn: number }[];
      } = { merged: [], spawned: [] };

      holder[request.sink] = sink;

      events.on('tile:merge', (event: RecordedEvent): void => {
        const cell = event.target;

        if (cell !== undefined) {
          sink.merged.push({ x: cell.x, y: cell.y, turn: event.turn });
        }
      });

      events.on('tile:spawn', (event: RecordedEvent): void => {
        const cell = event.position;

        if (cell !== undefined) {
          sink.spawned.push({ x: cell.x, y: cell.y, turn: event.turn });
        }
      });

      return true;
    },
    { application: APPLICATION_GLOBAL, sink: TURN_GEOMETRY_GLOBAL },
  );
}

/**
 * Reads back what `recordTurnGeometry` has collected so far.
 *
 * @param page Page the recorder was installed on.
 * @returns The merge and spawn cells recorded, in emission order.
 */
async function readTurnGeometry(page: Page): Promise<TurnGeometry> {
  return await page.evaluate((sink: string): TurnGeometry => {
    const holder = globalThis as unknown as Record<string, unknown>;
    const recorded = holder[sink] as
      | {
          readonly merged?: readonly CellRef[];
          readonly spawned?: readonly CellRef[];
        }
      | undefined;

    if (recorded === undefined) {
      return { attached: false, merged: [], spawned: [] };
    }

    return {
      attached: true,
      merged: [...(recorded.merged ?? [])],
      spawned: [...(recorded.spawned ?? [])],
    };
  }, TURN_GEOMETRY_GLOBAL);
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

/** What the run summary reports once the terminal state is acknowledged. */
interface RunSummaryReading {
  /** `data-outcome` on the panel. */
  readonly outcome: string;

  /** The panel's heading text. */
  readonly outcomeText: string;

  /** The `Final score` readout, or -1 when absent or unparsed. */
  readonly score: number;

  /** The `Stage reached` readout, or -1 when absent or unparsed. */
  readonly stage: number;

  /** The seed the summary surfaces for a replay. */
  readonly seed: string;

  /** Relic identifiers in list order, which the module documents as pickup order. */
  readonly relicIds: readonly string[];
}

/**
 * Reads the run summary structurally.
 *
 * The readouts are matched by their captions rather than by position, so a
 * reordering of the row does not silently compare the wrong number.
 *
 * @param page Page showing the summary.
 * @returns What the summary reports.
 */
async function readRunSummary(page: Page): Promise<RunSummaryReading> {
  return await page.evaluate(
    (request: {
      readonly panel: string;
      readonly rows: string;
      readonly seed: string;
      readonly relics: string;
      readonly scoreLabel: string;
      readonly stageLabel: string;
    }): RunSummaryReading => {
      const panel = document.querySelector(request.panel);

      const readoutFor = (caption: string): number => {
        for (const row of Array.from(
          document.querySelectorAll(request.rows),
        )) {
          const label = (
            row.querySelector('.run-summary-score-label')?.textContent ?? ''
          ).trim();

          if (label.toLowerCase() === caption.toLowerCase()) {
            const digits = (
              row.querySelector('.run-summary-score-value')?.textContent ?? ''
            ).replace(/[^0-9]/gu, '');

            return digits === '' ? -1 : Number(digits);
          }
        }

        return -1;
      };

      return {
        outcome: panel?.getAttribute('data-outcome') ?? '',
        outcomeText: (
          document.getElementById('run-summary-title')?.textContent ?? ''
        ).trim(),
        score: readoutFor(request.scoreLabel),
        stage: readoutFor(request.stageLabel),
        seed: (
          document.querySelector(request.seed)?.textContent ?? ''
        ).trim(),
        relicIds: Array.from(
          document.querySelectorAll(request.relics),
        ).map((node): string => node.getAttribute('data-relic-id') ?? ''),
      };
    },
    {
      panel: SELECTORS.runSummary,
      rows: SELECTORS.summaryScore,
      seed: SELECTORS.summarySeed,
      relics: SELECTORS.summaryRelic,
      scoreLabel: SUMMARY_SCORE_LABEL,
      stageLabel: SUMMARY_STAGE_LABEL,
    },
  );
}

/**
 * Reads how many merges the RENDERER has taken for its burst and its punch.
 *
 * `render.three.merge` of src/render/three-renderer.ts is raised by the
 * renderer's own merge path, not by the engine, and it collapses into the
 * `game2048_reports_total` family under that report label. It is therefore the
 * one signal available in the page that distinguishes "the engine merged two
 * tiles" from "the renderer was handed that merge to animate".
 *
 * @param page Page holding the composed application.
 * @returns The count, or 0 while the family carries no such series.
 */
async function readRenderMergeCount(page: Page): Promise<number> {
  return await page.evaluate((request: {
    readonly family: string;
    readonly report: string;
  }): number => {
    const surface = (
      globalThis as unknown as {
        readonly __blitzy2048?: {
          readonly metrics?: {
            readonly snapshot: () => {
              readonly series: readonly {
                readonly name: string;
                readonly value: number;
                readonly labels: Readonly<Record<string, string>>;
              }[];
            };
          };
        };
      }
    ).__blitzy2048;

    let total = 0;

    for (const series of surface?.metrics?.snapshot().series ?? []) {
      if (
        series.name === request.family &&
        series.labels.report === request.report
      ) {
        total += series.value;
      }
    }

    return total;
  }, { family: REPORT_COUNTER_FAMILY, report: RENDER_MERGE_REPORT });
}

/** Which board renderer the composition selected, as it reports itself. */
interface RendererMode {
  /** `'three'` for the 2.5D board, `'number-only'` for the accessible one. */
  readonly mode: string;

  /** Whether number-only is standing in for a WebGL board it could not serve. */
  readonly fallback: boolean;
}

/**
 * Reads the renderer the composition selected.
 *
 * @param page Page holding the composed application.
 * @returns The selected mode, or an empty reading when the handle is absent.
 */
async function readRendererMode(page: Page): Promise<RendererMode> {
  return await page.evaluate((): RendererMode => {
    const surface = (
      globalThis as unknown as {
        readonly __blitzy2048?: {
          readonly renderer?: {
            readonly mode?: unknown;
            readonly fallback?: unknown;
          };
        };
      }
    ).__blitzy2048;

    const renderer = surface?.renderer;

    return {
      mode: typeof renderer?.mode === 'string' ? renderer.mode : '',
      fallback: renderer?.fallback === true,
    };
  });
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

/** A rectangle of the recorded frame, in the coordinates the page used. */
interface FrameRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One timestamp of the recording, with the rectangle to sample there. */
interface RegionSample {
  /** Seconds into the recording. */
  readonly at: number;

  /** Rectangle of that frame to measure. */
  readonly region: FrameRegion;
}

/** What one measured picture of a rectangle amounts to. */
interface RegionMeasurement {
  /** The same measurements `sampleBoardCanvas` takes of the live board. */
  readonly verdict: CanvasVerdict;

  /**
   * A stable digest of the sampled pixels. Two pictures carrying the same
   * signature are the same picture, which is how a static encode is caught.
   */
  readonly signature: string;

  /**
   * The picture reduced to a `THUMBNAIL_EDGE` square of mean luminance, one
   * entry per cell in row-major order, on the 0-255 scale.
   */
  readonly thumbnail: readonly number[];
}

/** One decoded frame: where it was taken, what it looked like. */
interface FrameSample extends RegionMeasurement {
  /** The timestamp actually decoded, in seconds. */
  readonly at: number;
}

/**
 * A picture of the LIVE page, handed to the decoder so the recording can be
 * searched for the state it holds.
 */
interface RegionReference {
  /** Short label naming the state, carried into a failure. */
  readonly label: string;

  /** The clip, PNG-encoded and base64-wrapped. */
  readonly encoded: string;
}

/**
 * Rectangle of one cell of the parallel board, in page coordinates.
 *
 * src/ui/a11y/focus-manager.ts writes `data-cell-x` and `data-cell-y` on each
 * `role="gridcell"` counterpart and lays it out at the tile geometry
 * style/main.scss positions the visual tile at, so the counterpart's box is the
 * board cell's box.
 *
 * @param page Page to measure.
 * @param cell Cell to resolve, in engine coordinates.
 * @param context Short label naming the cell, carried into the failure.
 * @returns The cell's rectangle, rounded to whole pixels.
 */
async function cellRegion(
  page: Page,
  cell: CellRef,
  context: string,
): Promise<FrameRegion> {
  const counterpart = page.locator(
    `${SELECTORS.parallelBoard} [data-cell-x="${String(cell.x)}"]` +
      `[data-cell-y="${String(cell.y)}"]`,
  );

  await expect(
    counterpart,
    `${context}: the parallel board carries no cell at ` +
      `(${String(cell.x)}, ${String(cell.y)})`,
  ).toHaveCount(1);

  const box = await counterpart.boundingBox();

  expect(
    box,
    `${context}: the cell at (${String(cell.x)}, ${String(cell.y)}) ` +
      'reported no bounding box',
  ).not.toBeNull();

  if (box === null) {
    throw new Error(`${context}: the cell reported no bounding box`);
  }

  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
}

/**
 * Captures one rectangle of the LIVE page as a reference picture.
 *
 * The clip is taken at `deviceScaleFactor` 1 over the same coordinates a
 * recorded frame carries, and is measured by `probeRecording` through the same
 * pipeline the decoded frames go through, so the two are comparable.
 *
 * @param page Page to capture.
 * @param region Rectangle to clip.
 * @param label Short label naming the state captured.
 * @returns The reference, PNG-encoded and base64-wrapped.
 */
async function captureReference(
  page: Page,
  region: FrameRegion,
  label: string,
): Promise<RegionReference> {
  const png: EncodableBuffer = await page.screenshot({
    clip: region,
    type: 'png',
  });

  return { label, encoded: png.toString('base64') };
}

/**
 * Whether two rectangles share no pixel.
 *
 * @param first First rectangle.
 * @param second Second rectangle.
 * @returns Whether the two do not overlap.
 */
function regionsDisjoint(first: FrameRegion, second: FrameRegion): boolean {
  return (
    first.x + first.width <= second.x ||
    second.x + second.width <= first.x ||
    first.y + first.height <= second.y ||
    second.y + second.height <= first.y
  );
}

/**
 * Mean per-cell difference between two measured pictures, on the 0-255 scale.
 *
 * @param first First picture.
 * @param second Second picture.
 * @returns The mean absolute difference of the two thumbnails.
 */
function frameDistance(
  first: RegionMeasurement,
  second: RegionMeasurement,
): number {
  const cells = Math.min(first.thumbnail.length, second.thumbnail.length);

  if (cells === 0) {
    return 0;
  }

  let total = 0;

  for (let index = 0; index < cells; index += 1) {
    total += Math.abs(first.thumbnail[index] - second.thumbnail[index]);
  }

  return total / cells;
}

/**
 * The widest difference between any two frames of one window.
 *
 * @param frames Frames of the window.
 * @returns The widest distance, and 0 for fewer than two frames.
 */
function widestDistanceWithin(frames: readonly FrameSample[]): number {
  let widest = 0;

  for (let first = 0; first < frames.length; first += 1) {
    for (let second = first + 1; second < frames.length; second += 1) {
      widest = Math.max(widest, frameDistance(frames[first], frames[second]));
    }
  }

  return widest;
}

/**
 * The frame of a window that most closely matches a reference picture.
 *
 * @param frames Frames to search.
 * @param reference Measured reference picture.
 * @returns The closest frame with its distance, or `null` for no frames.
 */
function closestFrameTo(
  frames: readonly FrameSample[],
  reference: RegionMeasurement,
): { readonly frame: FrameSample; readonly distance: number } | null {
  let closest: { frame: FrameSample; distance: number } | null = null;

  for (const frame of frames) {
    const distance = frameDistance(frame, reference);

    if (closest === null || distance < closest.distance) {
      closest = { frame, distance };
    }
  }

  return closest;
}

/**
 * The first frame of a window that matches a reference picture.
 *
 * The FIRST rather than the closest, so a wide bracket cannot resolve to a
 * later occurrence of the same state.
 *
 * @param frames Frames to search, in the order they were sampled.
 * @param reference Measured reference picture.
 * @param tolerance Widest distance that counts as a match.
 * @returns The first matching frame, or `null` where none matches.
 */
function firstFrameMatching(
  frames: readonly FrameSample[],
  reference: RegionMeasurement,
  tolerance: number,
): FrameSample | null {
  for (const frame of frames) {
    if (frameDistance(frame, reference) <= tolerance) {
      return frame;
    }
  }

  return null;
}

/**
 * Whether one sample carries a rendered picture rather than a cleared, black
 * or flat one. The thresholds are the ones `expectRenderedBoard` holds the live
 * board to.
 *
 * @param verdict Verdict of the sample.
 * @returns Whether it clears all four thresholds.
 */
function carriesRenderedContent(verdict: CanvasVerdict): boolean {
  return (
    verdict.distinctColours >= MIN_DISTINCT_COLOURS &&
    verdict.meanLuminance >= MIN_MEAN_LUMINANCE &&
    verdict.peakLuminance >= MIN_PEAK_LUMINANCE &&
    verdict.channelSpread >= MIN_CHANNEL_SPREAD
  );
}

/** What decoding the artifact established. */
interface RecordingProbe {
  /** Whether a browser could decode it at all. */
  readonly loaded: boolean;

  /** The media error, when it could not. */
  readonly error: string;

  /** Duration the container declares, in seconds. */
  readonly duration: number;

  /** Encoded frame size. */
  readonly width: number;
  readonly height: number;

  /** One entry per requested timestamp, in the order requested. */
  readonly frames: readonly FrameSample[];

  /** One entry per reference picture, in the order supplied. */
  readonly references: readonly RegionMeasurement[];
}

/**
 * Decodes the encoded recording and samples it at the given timestamps.
 *
 * The artifact is probed by PLAYING IT rather than by parsing the container:
 * this spec compiles under `tsconfig.json`, which carries the DOM library and
 * no Node types, so it reaches the filesystem the way `fileByteSize` does — by
 * handing the path to a file input. Decoding through a real `<video>` element
 * is also the stronger proof, because it establishes that a browser can play
 * what was written rather than that the bytes resemble a container.
 *
 * Each request carries its OWN rectangle, so one decode answers for windows
 * addressing different parts of the frame.
 *
 * @param browser Browser to open a throwaway context on.
 * @param filePath Path Playwright wrote the recording to.
 * @param samples Timestamps to decode with the rectangle to measure at each,
 *   in the order wanted. An empty list reads the container's metadata alone.
 * @param references Pictures of the live page to measure through the same
 *   pipeline, so a frame can be matched against the state it holds.
 * @returns What decoding established.
 */
async function probeRecording(
  browser: Browser,
  filePath: string,
  samples: readonly RegionSample[],
  references: readonly RegionReference[] = [],
): Promise<RecordingProbe> {
  const reader = await browser.newContext();

  try {
    const readerPage = await reader.newPage();

    await readerPage.setContent(
      '<input id="artifact" type="file">' +
        '<video id="film" muted playsinline></video>',
    );
    await readerPage.setInputFiles('#artifact', filePath);

    return await readerPage.evaluate(
      async (request: {
        readonly samples: readonly RegionSample[];
        readonly references: readonly RegionReference[];
        readonly edge: number;
        readonly thumbnailEdge: number;
        readonly quantisationBits: number;
        readonly loadTimeoutMs: number;
        readonly seekTimeoutMs: number;
        readonly frameStep: number;
      }): Promise<RecordingProbe> => {
        const input = document.getElementById('artifact');
        const film = document.getElementById('film');

        if (
          !(input instanceof HTMLInputElement) ||
          !(film instanceof HTMLVideoElement)
        ) {
          return {
            loaded: false,
            error: 'the probe page did not mount',
            duration: 0,
            width: 0,
            height: 0,
            frames: [],
            references: [],
          };
        }

        const file = input.files?.item(0) ?? null;

        if (file === null) {
          return {
            loaded: false,
            error: 'the recording did not reach the file input',
            duration: 0,
            width: 0,
            height: 0,
            frames: [],
            references: [],
          };
        }

        // Metadata, or the reason there is none. A truncated, empty or
        // otherwise unplayable file resolves here with `loaded: false`.
        const opened = await new Promise<{
          readonly ok: boolean;
          readonly error: string;
        }>((resolve): void => {
          let settled = false;

          const finish = (ok: boolean, error: string): void => {
            if (!settled) {
              settled = true;
              resolve({ ok, error });
            }
          };

          film.addEventListener('loadedmetadata', (): void => {
            finish(true, '');
          });
          film.addEventListener('error', (): void => {
            finish(
              false,
              `media error ${String(film.error?.code ?? 'unknown')}`,
            );
          });
          window.setTimeout((): void => {
            finish(false, 'the recording did not report metadata');
          }, request.loadTimeoutMs);

          film.src = URL.createObjectURL(file);
        });

        if (!opened.ok) {
          return {
            loaded: false,
            error: opened.error,
            duration: 0,
            width: 0,
            height: 0,
            frames: [],
            references: [],
          };
        }

        const surface = document.createElement('canvas');

        surface.width = request.edge;
        surface.height = request.edge;

        const context = surface.getContext('2d', {
          willReadFrequently: true,
        });

        if (context === null) {
          return {
            loaded: false,
            error: 'the probe canvas yielded no 2d context',
            duration: film.duration,
            width: film.videoWidth,
            height: film.videoHeight,
            frames: [],
            references: [],
          };
        }

        // THE ONE MEASUREMENT. Every decoded frame and every reference picture
        // is reduced by this function, so a frame and the live state it is
        // matched against are measured by identical arithmetic.
        const measure = (
          source: HTMLVideoElement | HTMLImageElement,
          area: FrameRegion,
        ): RegionMeasurement => {
          context.drawImage(
            source,
            area.x,
            area.y,
            area.width,
            area.height,
            0,
            0,
            request.edge,
            request.edge,
          );

          const pixels = context.getImageData(
            0,
            0,
            request.edge,
            request.edge,
          ).data;

          const colours = new Set<number>();
          let luminanceTotal = 0;
          let peakLuminance = 0;
          let floorLuminance = 255;
          let digest = 0;
          const low = [255, 255, 255];
          const high = [0, 0, 0];

          // Mean luminance per thumbnail cell, accumulated in the same pass.
          const cells = request.thumbnailEdge * request.thumbnailEdge;
          const cellTotals = new Array<number>(cells).fill(0);
          const cellCounts = new Array<number>(cells).fill(0);

          for (let index = 0; index < pixels.length; index += 4) {
            const red = pixels[index];
            const green = pixels[index + 1];
            const blue = pixels[index + 2];
            const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;

            luminanceTotal += luminance;
            peakLuminance = Math.max(peakLuminance, luminance);
            floorLuminance = Math.min(floorLuminance, luminance);

            const quantised =
              ((red >> request.quantisationBits) << 16) |
              ((green >> request.quantisationBits) << 8) |
              (blue >> request.quantisationBits);

            colours.add(quantised);
            digest = (Math.imul(digest, 31) + quantised) | 0;

            low[0] = Math.min(low[0], red);
            low[1] = Math.min(low[1], green);
            low[2] = Math.min(low[2], blue);
            high[0] = Math.max(high[0], red);
            high[1] = Math.max(high[1], green);
            high[2] = Math.max(high[2], blue);

            const pixel = index / 4;
            const column = Math.min(
              request.thumbnailEdge - 1,
              Math.floor(
                ((pixel % request.edge) * request.thumbnailEdge) / request.edge,
              ),
            );
            const row = Math.min(
              request.thumbnailEdge - 1,
              Math.floor(
                (Math.floor(pixel / request.edge) * request.thumbnailEdge) /
                  request.edge,
              ),
            );
            const cell = row * request.thumbnailEdge + column;

            cellTotals[cell] += luminance;
            cellCounts[cell] += 1;
          }

          const sampled = pixels.length / 4;

          return {
            verdict: {
              distinctColours: colours.size,
              meanLuminance: luminanceTotal / sampled,
              peakLuminance,
              floorLuminance,
              channelSpread: Math.max(
                high[0] - low[0],
                high[1] - low[1],
                high[2] - low[2],
              ),
              pixelsSampled: sampled,
            },
            signature: digest.toString(16),
            thumbnail: cellTotals.map((total, cell): number =>
              cellCounts[cell] === 0 ? 0 : total / cellCounts[cell],
            ),
          };
        };

        const frames: FrameSample[] = [];
        const last = Math.max(0, film.duration - request.frameStep);

        for (const wanted of request.samples) {
          const target = Math.min(Math.max(0, wanted.at), last);

          await new Promise<void>((resolve): void => {
            let settled = false;

            const finish = (): void => {
              if (!settled) {
                settled = true;
                resolve();
              }
            };

            film.addEventListener('seeked', finish, { once: true });
            window.setTimeout(finish, request.seekTimeoutMs);
            film.currentTime = target;
          });

          // The region is in page coordinates and the frame is the viewport at
          // deviceScaleFactor 1, so the two share one coordinate space.
          frames.push({
            at: Number(film.currentTime.toFixed(3)),
            ...measure(film, wanted.region),
          });
        }

        const measured: RegionMeasurement[] = [];

        for (const reference of request.references) {
          const picture = new Image();

          await new Promise<void>((resolve): void => {
            let settled = false;

            const finish = (): void => {
              if (!settled) {
                settled = true;
                resolve();
              }
            };

            picture.addEventListener('load', finish, { once: true });
            picture.addEventListener('error', finish, { once: true });
            window.setTimeout(finish, request.seekTimeoutMs);
            picture.src = `data:image/png;base64,${reference.encoded}`;
          });

          // The clip is already the region, so the whole of it is measured.
          measured.push(
            measure(picture, {
              x: 0,
              y: 0,
              width: picture.naturalWidth,
              height: picture.naturalHeight,
            }),
          );
        }

        return {
          loaded: true,
          error: '',
          duration: film.duration,
          width: film.videoWidth,
          height: film.videoHeight,
          frames,
          references: measured,
        };
      },
      {
        samples,
        references,
        edge: PIXEL_SAMPLE_EDGE,
        thumbnailEdge: THUMBNAIL_EDGE,
        quantisationBits: COLOUR_QUANTISATION_BITS,
        loadTimeoutMs: STATE_TIMEOUT_MS,
        seekTimeoutMs: STATE_TIMEOUT_MS,
        frameStep: FRAME_STEP_S,
      },
    );
  } finally {
    await reader.close();
  }
}

/**
 * Builds a list of timestamps stepping across a window.
 *
 * @param from First timestamp, in seconds.
 * @param to Last timestamp, in seconds.
 * @param step Gap between timestamps, in seconds.
 * @returns The timestamps, ascending.
 */
function timestampsAcross(
  from: number,
  to: number,
  step: number,
): readonly number[] {
  const stamps: number[] = [];

  for (let at = Math.max(0, from); at <= to; at += step) {
    stamps.push(Number(at.toFixed(3)));
  }

  return stamps;
}

/**
 * Pairs each timestamp of a window with the rectangle to sample there.
 *
 * @param region Rectangle every timestamp of this window addresses.
 * @param timestamps Timestamps of the window, in the order wanted.
 * @returns One request per timestamp.
 */
function samplesOver(
  region: FrameRegion,
  timestamps: readonly number[],
): readonly RegionSample[] {
  return timestamps.map((at): RegionSample => ({ at, region }));
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

/** The persisted run envelope, parsed into the fields this spec asserts. */
interface RunEnvelopeReading {
  /** Whether the stored value was present and parsed as an object. */
  readonly parsed: boolean;

  /** Why it did not, when it did not. */
  readonly error: string;

  /** `schemaVersion`, or -1 when absent or not a number. */
  readonly schemaVersion: number;

  /** `seed` exactly as stored, or the empty string when absent. */
  readonly seed: string;

  /** `runId` exactly as stored, or the empty string when absent. */
  readonly runId: string;

  /** `rngCursor` as stored, so it can be compared field by field. */
  readonly rngCursor: Readonly<Record<string, number>>;

  /** `stageIndex`, or -1 when absent or not a number. */
  readonly stageIndex: number;

  /** `stageGoal` as stored. */
  readonly stageGoal: Readonly<Record<string, unknown>>;

  /** Entries in `relics`, or -1 when it is not an array. */
  readonly relicCount: number;

  /** `board.grid.size` of the wrapped snapshot, or -1 when unreachable. */
  readonly boardSize: number;

  /** Every key carrying the application's namespace prefix. */
  readonly namespacedKeys: readonly string[];

  /** Whether the frozen best-score key is present beside the envelope. */
  readonly bestScorePresent: boolean;
}

/**
 * Parses the persisted run envelope and reports its fields.
 *
 * The reading this replaces asked whether the stored TEXT contains the seed. A
 * value carrying the seed anywhere — inside `runId`, or inside the wrapped board
 * — satisfies that without the `seed` field being right, so this reads the
 * envelope as the structure it is and compares each field as itself.
 *
 * @param page Page whose origin owns the store.
 * @returns The parsed envelope, or a reading explaining why there is none.
 */
async function readRunEnvelope(page: Page): Promise<RunEnvelopeReading> {
  return await page.evaluate(
    (request: {
      readonly keys: StorageKeys;
      readonly runStateKey: string;
    }): RunEnvelopeReading => {
      const absent = (error: string): RunEnvelopeReading => ({
        parsed: false,
        error,
        schemaVersion: -1,
        seed: '',
        runId: '',
        rngCursor: {},
        stageIndex: -1,
        stageGoal: {},
        relicCount: -1,
        boardSize: -1,
        namespacedKeys: [],
        bestScorePresent: false,
      });

      let store: Storage;

      try {
        store = window.localStorage;
      } catch {
        return absent('the store is unavailable on this origin');
      }

      const namespacedKeys: string[] = [];

      for (let index = 0; index < store.length; index += 1) {
        const key = store.key(index);

        if (key !== null && key.startsWith(request.keys.namespacePrefix)) {
          namespacedKeys.push(key);
        }
      }

      const bestScorePresent =
        store.getItem(request.keys.bestScore) !== null;
      const raw = store.getItem(request.runStateKey);

      if (raw === null) {
        return {
          ...absent('no value is stored under the run-state key'),
          namespacedKeys,
          bestScorePresent,
        };
      }

      let envelope: unknown;

      try {
        envelope = JSON.parse(raw);
      } catch (error: unknown) {
        return {
          ...absent(
            `the stored value is not JSON: ${
              error instanceof Error ? error.message : 'unknown'
            }`,
          ),
          namespacedKeys,
          bestScorePresent,
        };
      }

      if (typeof envelope !== 'object' || envelope === null) {
        return {
          ...absent('the stored value is not an object'),
          namespacedKeys,
          bestScorePresent,
        };
      }

      const record = envelope as Record<string, unknown>;

      const numberAt = (value: unknown): number =>
        typeof value === 'number' && Number.isFinite(value) ? value : -1;

      const stringAt = (value: unknown): string =>
        typeof value === 'string' ? value : '';

      const cursor: Record<string, number> = {};
      const storedCursor = record.rngCursor;

      if (typeof storedCursor === 'object' && storedCursor !== null) {
        for (const [name, value] of Object.entries(
          storedCursor as Record<string, unknown>,
        )) {
          cursor[name] = numberAt(value);
        }
      }

      const board = record.board;
      const grid =
        typeof board === 'object' && board !== null
          ? (board as Record<string, unknown>).grid
          : null;
      const boardSize =
        typeof grid === 'object' && grid !== null
          ? numberAt((grid as Record<string, unknown>).size)
          : -1;

      const goal: Record<string, unknown> = {};
      const storedGoal = record.stageGoal;

      if (typeof storedGoal === 'object' && storedGoal !== null) {
        Object.assign(goal, storedGoal as Record<string, unknown>);
      }

      return {
        parsed: true,
        error: '',
        schemaVersion: numberAt(record.schemaVersion),
        seed: stringAt(record.seed),
        runId: stringAt(record.runId),
        rngCursor: cursor,
        stageIndex: numberAt(record.stageIndex),
        stageGoal: goal,
        relicCount: Array.isArray(record.relics) ? record.relics.length : -1,
        boardSize,
        namespacedKeys,
        bestScorePresent,
      };
    },
    { keys: STORAGE_KEYS, runStateKey: RUN_STATE_KEY },
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
  'run',
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

/** `boardSize`, ported from js/application.js L3. */
const EXPECTED_BOARD_SIZE = 4;

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
    { tag: '@gameplay' },
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

      // Wall clock the recording's own timeline is measured against. Encoding
      // begins when the context is created, a moment earlier than this, so a
      // timestamp derived from it is approximate and every search that uses one
      // is widened by `MILESTONE_TOLERANCE_S`.
      const recordingEpoch = Date.now();

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

      // THE SEED IS LOAD-BEARING. The opening board is a function of `RUN_SEED`
      // alone, so pinning it is what separates a seeded run from any run: a
      // build that ignored the entered seed satisfies every count above and
      // fails here.
      expect(
        opening.cellLabels.filter((label): boolean =>
          POPULATED_CELL.test(label),
        ),
        `the opening board under seed "${RUN_SEED}" is not the board that ` +
          'seed produces',
      ).toEqual([...OPENING_CELL_LABELS]);

      // Where the board sits on the page. The recorded frame is the viewport at
      // deviceScaleFactor 1, so this rectangle addresses the board inside a
      // decoded frame as well as on the page.
      const boardBox = await page.locator(SELECTORS.boardCanvas).boundingBox();

      expect(
        boardBox,
        'the board canvas reported no bounding box, so no region of the ' +
          'recording can be addressed',
      ).not.toBeNull();

      if (boardBox === null) {
        throw new Error('the board canvas reported no bounding box');
      }

      const boardRegion: FrameRegion = {
        x: Math.round(boardBox.x),
        y: Math.round(boardBox.y),
        width: Math.round(boardBox.width),
        height: Math.round(boardBox.height),
      };

      /* -- The envelope the seeded run persisted --------------------------- */

      // Read here, before a single move: the cursors are still the two start
      // spawns, and the run has not ended, so the envelope is still present.
      // A finished run REMOVES it, which is why this cannot wait until later.
      const openingEnvelope = await readRunEnvelope(page);

      expect(
        openingEnvelope.parsed,
        `the persisted run state under "${RUN_STATE_KEY}" did not parse: ` +
          openingEnvelope.error,
      ).toBe(true);
      expect(
        openingEnvelope.schemaVersion,
        'the envelope carries a schema version this spec does not know',
      ).toBe(RUN_STATE_SCHEMA_VERSION);
      expect(
        openingEnvelope.seed,
        'the envelope `seed` field is not the seed that was entered',
      ).toBe(RUN_SEED);
      expect(
        openingEnvelope.runId,
        'the envelope carries no run identifier',
      ).toMatch(/^[0-9a-f]+$/u);
      expect(
        openingEnvelope.rngCursor,
        'the persisted RNG cursors are not the two opening spawns across the ' +
          'four declared substreams',
      ).toEqual(OPENING_RNG_CURSOR);
      expect(
        openingEnvelope.stageIndex,
        'the envelope did not open on the first stage',
      ).toBe(0);
      expect(
        openingEnvelope.stageGoal,
        'the envelope records a different first-stage goal',
      ).toEqual(OPENING_STAGE_GOAL);
      expect(
        openingEnvelope.relicCount,
        'the envelope holds relics before any reward was offered',
      ).toBe(0);
      expect(
        openingEnvelope.boardSize,
        'the wrapped board snapshot is not the configured lattice',
      ).toBe(EXPECTED_BOARD_SIZE);
      expect(
        openingEnvelope.namespacedKeys,
        'the run state was written outside the application namespace',
      ).toContain(RUN_STATE_KEY);

      // `bestScore` is deliberately NOT asserted here. The legacy key is
      // written only when a score exceeds the stored best, so on a clean store
      // at score zero its absence is correct; it is asserted at the run's end,
      // where the frozen contract is observable.
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

      // Installed before the first press: the cells a turn merges into and
      // spawns at are read off the engine's own `tile:merge` and `tile:spawn`
      // events, which is what makes the merge window addressable in the frames
      // as a rectangle rather than as a moment. DL-PW-08.
      expect(
        await recordTurnGeometry(page),
        'the engine event emitter could not be reached through ' +
          `"${APPLICATION_GLOBAL}", so no turn geometry can be recorded`,
      ).toBe(true);

      let moves = 0;
      let mergeAnnouncement = '';
      let mergeDeltaText = '';
      let mergeCellLabels: readonly string[] = [];

      let mergeFilm: FilmedMove | null = null;
      let mergeMove = 0;

      // No merge has reached the renderer yet, so its burst-and-punch counter
      // carries nothing. The delta across the merged turn is what proves the
      // merge was handed to the renderer to animate.
      const mergesBefore = await readRenderMergeCount(page);

      expect(
        mergesBefore,
        'the renderer had already taken a merge before one was played',
      ).toBe(0);

      while (mergeAnnouncement === '' && moves < MERGE_MOVE_CAP) {
        const key = MOVE_KEYS[moves % MOVE_KEYS.length];

        // The recorder watches the render loop across the press, so the pop
        // window is observed while it is open rather than after it has closed.
        const film = await playFilmedMove(page, key, FILMED_MOVE_SETTLE_MS);

        moves += 1;

        const turn = await readBoardSurface(page);

        if (turn.screen !== 'stage') {
          break;
        }

        if (MERGE_ANNOUNCEMENT.test(turn.announcement)) {
          mergeAnnouncement = turn.announcement;
          mergeDeltaText = turn.scoreDeltaText;
          mergeCellLabels = turn.cellLabels;
          mergeFilm = film;
          mergeMove = moves;
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

      // The seed decides which move merges, so the turn is pinned as well as
      // the fact.
      expect(
        mergeMove,
        `under seed "${RUN_SEED}" the first merge is move ` +
          `${FIRST_MERGE_MOVE}`,
      ).toBe(FIRST_MERGE_MOVE);

      /* -- The merge animation, observed while it was open ---------------- */

      // The 2.5D renderer is the surface that drew it. `src/main.ts` can fall
      // back to the number-only board through five separate routes, so a run
      // that degraded silently would still animate a board and still satisfy
      // every board assertion above. This is the guard against that.
      const board = await readRendererMode(page);

      expect(
        board.mode,
        'the board on screen is not the 2.5D renderer, so the recorded ' +
          'animation is not a 2.5D one',
      ).toBe(THREE_RENDERER_MODE);
      expect(
        board.fallback,
        'the renderer is standing in for a WebGL board it could not serve',
      ).toBe(false);

      expect(
        mergeFilm,
        'the merged turn was not the one the recorder watched',
      ).not.toBeNull();

      if (mergeFilm === null) {
        throw new Error('the merged turn carried no recorder series');
      }

      expect(
        mergeFilm.samplesInPopWindow,
        `the recorder took no bracket around the ${MERGE_POP_MS}ms the pop ` +
          'is open, so nothing was observed while it played',
      ).toBeGreaterThan(1);
      expect(
        mergeFilm.popWindowClosedAtMs,
        `the ${MERGE_POP_MS}ms pop window was observed only as far as ` +
          `${mergeFilm.popWindowClosedAtMs}ms from the press, past the ` +
          `${FILMED_MOVE_SETTLE_MS}ms the merge animates for, so the frames ` +
          'counted across it are not the ones the merge drew',
      ).toBeLessThanOrEqual(FILMED_MOVE_SETTLE_MS);
      expect(
        mergeFilm.framesInPopWindow,
        `the render loop drew no frame across the ${MERGE_POP_MS}ms merge ` +
          'window, so the pop cannot have been drawn',
      ).toBeGreaterThan(0);

      // THE MERGE REACHED THE RENDERER'S ANIMATION PATH. The engine merging two
      // tiles and the renderer animating that merge are separate facts, and only
      // this counter carries the second one: it is raised by the renderer as it
      // records the merge for its burst and its punch.
      expect(
        await readRenderMergeCount(page),
        'the renderer never took the merge for its burst and punch, so the ' +
          'merge was resolved without any animation being started for it',
      ).toBeGreaterThan(mergesBefore);

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
      expect(
        mergedValue,
        `under seed "${RUN_SEED}" the first merge produces ` +
          `${FIRST_MERGE_PRODUCT}`,
      ).toBe(FIRST_MERGE_PRODUCT);

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

      /* -- Where the merge happened, and where the spawn did -------------- */

      // The two cells of the merged turn, read off the engine's own events. The
      // merged tile is built at the target cell and a spawn only takes a cell
      // the board still has free, so the two cells are never the same one; the
      // rectangles are asserted disjoint below rather than assumed so.
      // DL-PW-08.
      const geometry = await readTurnGeometry(page);

      expect(
        geometry.attached,
        'the turn-geometry recorder was not collecting',
      ).toBe(true);
      expect(
        geometry.merged.length,
        'the engine emitted no `tile:merge` for the merged turn',
      ).toBeGreaterThan(0);

      const mergedCell = geometry.merged[geometry.merged.length - 1];
      const mergedTurnSpawns = geometry.spawned.filter(
        (cell): boolean => cell.turn === mergedCell.turn,
      );

      expect(
        mergedTurnSpawns.length,
        `the merged turn ${String(mergedCell.turn)} recorded no spawn, so ` +
          'the tween the merge window has to be isolated from cannot be ' +
          'located',
      ).toBe(1);

      const spawnedCell = mergedTurnSpawns[0];

      expect(
        `${String(spawnedCell.x)},${String(spawnedCell.y)}`,
        'the turn spawned into the cell the merge produced its tile in',
      ).not.toBe(`${String(mergedCell.x)},${String(mergedCell.y)}`);

      const mergedCellRegion = await cellRegion(
        page,
        mergedCell,
        'the cell the merge produced its tile in',
      );
      const spawnedCellRegion = await cellRegion(
        page,
        spawnedCell,
        'the cell the same turn spawned into',
      );

      expect(
        mergedCellRegion.width,
        'the merged cell resolved to no width, so it addresses no region of ' +
          'the recording',
      ).toBeGreaterThan(0);
      expect(
        mergedCellRegion.height,
        'the merged cell resolved to no height',
      ).toBeGreaterThan(0);

      // THE PROOF THAT THE MERGE WINDOW IS THE MERGE'S. The `appear` tween of
      // the tile that spawns on the same turn runs over exactly the window the
      // pop does, so only a rectangle that excludes the spawned cell can carry
      // evidence the spawn cannot account for.
      expect(
        regionsDisjoint(mergedCellRegion, spawnedCellRegion),
        'the merged cell and the cell the same turn spawned into overlap on ' +
          'screen, so no rectangle separates the pop from the `appear` tween',
      ).toBe(true);

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

      // The seed decides the turn the goal is met on, so the turn is pinned.
      expect(
        moves,
        `under seed "${RUN_SEED}" the first stage clears on move ` +
          `${FIRST_STAGE_CLEAR_MOVE}`,
      ).toBe(FIRST_STAGE_CLEAR_MOVE);

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

      // Where the reward dialog sits on the page, and the span it is held for.
      // The window searched in the recording is `MILESTONE_SLACK_S` inside each
      // end of that span, so the frames it resolves to were taken while this
      // screen — and no other — was the screen in force. DL-PW-08.
      const rewardBox = await page.locator(SELECTORS.rewardPanel).boundingBox();

      expect(
        rewardBox,
        'the reward dialog reported no bounding box, so no region of the ' +
          'recording can be addressed',
      ).not.toBeNull();

      if (rewardBox === null) {
        throw new Error('the reward dialog reported no bounding box');
      }

      const rewardRegion: FrameRegion = {
        x: Math.round(rewardBox.x),
        y: Math.round(rewardBox.y),
        width: Math.round(rewardBox.width),
        height: Math.round(rewardBox.height),
      };

      const rewardHeldFrom = Date.now();
      const rewardReference = await captureReference(
        page,
        rewardRegion,
        'the reward dialog',
      );

      await page.waitForTimeout(MILESTONE_HOLD_MS);

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

      // THE DRAW IS SEEDED, AND THIS IS WHERE THAT IS PROVED. The three offers
      // and their order come from the `relic-draw` and `rarity-weight`
      // substreams, so a draw that stopped consuming the run seed would still
      // present three distinct relics and fail only here.
      expect(
        offer.offerIds,
        `under seed "${RUN_SEED}" the first reward round offers these three ` +
          'relics in this order',
      ).toEqual([...FIRST_OFFER_IDS]);

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

      // The stage the selection opened, held over the SAME rectangle the reward
      // dialog occupied. Two windows over one rectangle are what carry the
      // selection into the artifact: the dialog is there in the first and gone
      // in the second. This window doubles as the settled reading of the merged
      // cell that the merge window is measured against. DL-PW-08.
      const selectionHeldFrom = Date.now();
      const selectionReference = await captureReference(
        page,
        rewardRegion,
        'the stage the selection opened',
      );

      await page.waitForTimeout(MILESTONE_HOLD_MS);

      const settled = await readBoardSurface(page);

      expect(
        settled.screen,
        'the board did not stay in play while the stage the relic opened was ' +
          'filmed',
      ).toBe('stage');

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
        // `moves` counts every press, so the key sequence stays strictly
        // increasing across the whole run and the counter remains the true
        // number of moves played. Indexing by `moves` while incrementing it
        // selects the same keys the previous `moves + played` form did.
        await pressMove(
          page,
          MOVE_KEYS[moves % MOVE_KEYS.length],
          MOVE_SETTLE_MS,
        );
        moves += 1;
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

      /* -- The envelope the run kept while it was still running ----------- */

      // Read while the run is STILL RUNNING. Ending a run removes its envelope,
      // so a read taken after the terminal state finds nothing; this is the last
      // point at which the played seed, the advanced cursors and the relics
      // taken are all on disk together.
      const progressEnvelope = await readRunEnvelope(page);

      expect(
        progressEnvelope.parsed,
        `the run was not persisted under "${RUN_STATE_KEY}" while it ran: ` +
          progressEnvelope.error,
      ).toBe(true);
      expect(
        progressEnvelope.seed,
        'the persisted envelope `seed` field is not the seed that was played',
      ).toBe(RUN_SEED);
      expect(
        progressEnvelope.schemaVersion,
        'the envelope schema version changed during the run',
      ).toBe(RUN_STATE_SCHEMA_VERSION);
      expect(
        progressEnvelope.runId,
        'the envelope lost its run identifier',
      ).toBe(openingEnvelope.runId);
      expect(
        progressEnvelope.stageIndex,
        'the envelope did not advance past the first stage',
      ).toBeGreaterThan(openingEnvelope.stageIndex);
      expect(
        progressEnvelope.relicCount,
        'the envelope holds fewer relics than were taken',
      ).toBeGreaterThanOrEqual(heldRelicIds.length);
      expect(
        progressEnvelope.boardSize,
        'the wrapped board snapshot changed lattice',
      ).toBe(EXPECTED_BOARD_SIZE);
      expect(
        progressEnvelope.bestScorePresent,
        'the frozen best-score key was never written, so the legacy contract ' +
          'was not preserved alongside the namespaced run envelope',
      ).toBe(true);
      expect(
        progressEnvelope.namespacedKeys,
        'the run state left the application namespace during the run',
      ).toContain(RUN_STATE_KEY);

      // Every cursor advanced or held; none went backwards. The two spawn
      // streams advance together, one value per position.
      for (const stream of Object.keys(OPENING_RNG_CURSOR)) {
        expect(
          progressEnvelope.rngCursor[stream],
          `the "${stream}" cursor went backwards during the run`,
        ).toBeGreaterThanOrEqual(
          OPENING_RNG_CURSOR[stream as keyof typeof OPENING_RNG_CURSOR],
        );
      }

      expect(
        progressEnvelope.rngCursor['spawn-value'],
        'the spawn-value and spawn-position cursors came apart, so one spawn ' +
          'drew a value without a position or the reverse',
      ).toBe(progressEnvelope.rngCursor['spawn-position']);
      expect(
        progressEnvelope.rngCursor['relic-draw'],
        'no relic draw was recorded although reward rounds were resolved',
      ).toBeGreaterThan(0);

      /* -- The run is played to its own end ------------------------------- */

      // A run that comes to rest on a playable board proves nothing about the
      // terminal flow, so the run is played out. Every move is taken from the
      // `stage` state and every screen raised on the way is resolved, exactly
      // as the earlier stages were, until the board has no move left.
      let terminalMove = moves;

      for (
        let played = 0;
        played < TERMINAL_MOVE_CAP && terminalMove < TERMINAL_MOVE_CAP;
        played += 1
      ) {
        const surface = await readBoardSurface(page);

        if (
          surface.screen === 'gameOver' ||
          surface.screen === 'won' ||
          surface.screen === 'runSummary'
        ) {
          break;
        }

        if (surface.screen !== 'stage') {
          await resolveOverlaysToStage(
            page,
            heldRelicIds,
            'playing the run out to its end',
          );

          continue;
        }

        await pressMove(
          page,
          MOVE_KEYS[terminalMove % MOVE_KEYS.length],
          MOVE_SETTLE_MS,
        );
        terminalMove += 1;
      }

      // The verdict is written with the commit, and the overlay fades over
      // 1200ms + 800ms. `TERMINAL_OVERLAY_MS` clears that whole cadence, so the
      // frames carry the finished verdict rather than a fade in progress.
      await page.waitForTimeout(TERMINAL_OVERLAY_MS);

      const finished = await readBoardSurface(page);

      expect(
        finished.screen,
        `the run did not reach a terminal state within ` +
          `${TERMINAL_MOVE_CAP} moves: the state is "${finished.screen}"`,
      ).toBe('gameOver');
      expect(
        terminalMove,
        `under seed "${RUN_SEED}" the run is lost on move ${TERMINAL_MOVE}`,
      ).toBe(TERMINAL_MOVE);

      /* -- The terminal controls, and the run summary --------------------- */

      // RUN-END HYGIENE. A finished run must not be resumable, so the envelope
      // is gone by the time the terminal state stands while the frozen
      // best-score key survives it.
      const afterEnd = await readRunEnvelope(page);

      expect(
        afterEnd.parsed,
        'the finished run left its envelope on disk, so a reload would resume ' +
          'a run that is already over',
      ).toBe(false);
      expect(
        afterEnd.bestScorePresent,
        'the frozen best-score key did not survive the end of the run',
      ).toBe(true);

      const terminalScore = TERMINAL_OVERLAY_SCORE.exec(finished.terminalText);

      expect(
        terminalScore,
        `the terminal screen did not report a score: ` +
          `"${finished.terminalText}"`,
      ).not.toBeNull();
      expect(
        Number(terminalScore?.[1] ?? Number.NaN),
        `under seed "${RUN_SEED}" the lost run finishes on ${TERMINAL_SCORE}`,
      ).toBe(TERMINAL_SCORE);

      const acknowledge = page.locator(SELECTORS.acknowledgeTerminal);

      await expect(
        acknowledge,
        'the terminal screen offered no control to carry the run forward',
      ).toBeEnabled();
      await acknowledge.click();
      await expectScreen(page, 'runSummary', 'acknowledging the terminal state');

      // The summary is filmed for long enough to be legible in the frames.
      await page.waitForTimeout(SCREEN_SETTLE_MS);

      const summary = await readRunSummary(page);

      expect(
        summary.seed,
        'the run summary does not surface the seed that was played, so the ' +
          'run cannot be replayed from it',
      ).toBe(RUN_SEED);
      expect(
        summary.score,
        `the run summary reports a different final score than the terminal ` +
          `screen did`,
      ).toBe(TERMINAL_SCORE);
      expect(
        summary.stage,
        `under seed "${RUN_SEED}" the lost run reaches stage ` +
          `${TERMINAL_STAGE}`,
      ).toBe(TERMINAL_STAGE);
      expect(
        summary.relicIds,
        'the run summary does not list every relic taken, in pickup order',
      ).toEqual(heldRelicIds);
      expect(
        summary.outcomeText,
        'the run summary does not name the outcome of the run',
      ).toMatch(RUN_LOST_TEXT);
      expect(
        summary.outcome,
        'the run summary does not record the outcome as an inspectable state',
      ).toBe(LOST_OUTCOME);

      /* -- The artifact --------------------------------------------------- */

      // Playwright writes the WebM at context close. The context is closed
      // here and the artifact is resolved afterwards.
      //
      // Wall clock at the moment the close was requested, which is where the
      // recording stops. With `recordingEpoch` it gives the span the wall clock
      // saw, and the declared duration less that span is how much earlier than
      // `recordingEpoch` encoding began. DL-PW-08.
      const closeRequestedAt = Date.now();

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

      /* -- The artifact is decoded, not merely counted -------------------- */

      // A suffix and a byte count are satisfied by a header-only, truncated,
      // black or single-colour encode. The gate's terms are that the video
      // VISIBLY SHOWS the board, a merge with its animation and the reward
      // selection, so the file is played and its pixels are measured.
      //
      // The container is opened first, on its own: the declared duration is
      // what the milestone brackets below are placed against. DL-PW-08.
      const metadata = await probeRecording(browser, recordingPath, []);

      expect(
        metadata.loaded,
        `the recording at ${recordingPath} could not be decoded by a ` +
          `browser: ${metadata.error}`,
      ).toBe(true);
      expect(
        Number.isFinite(metadata.duration),
        `the recording declares a duration of ${String(metadata.duration)}, ` +
          'which is not a finite span: a truncated or still-open container ' +
          'reports exactly this',
      ).toBe(true);
      expect(
        metadata.duration,
        'the recording reports no duration, so it carries no playable span',
      ).toBeGreaterThan(0);
      expect(
        metadata.width,
        'the recording was encoded at no width',
      ).toBe(VIEWPORT_WIDTH);
      expect(
        metadata.height,
        'the recording was encoded at no height',
      ).toBe(VIEWPORT_HEIGHT);

      // THE TWO TIMELINES RUN AT DIFFERENT RATES. The encoder writes a frame
      // when the page produces one, so the recording's own timeline and the
      // wall clock this test read are related by a rate that is MEASURED —
      // the span the container declares over the span the wall clock saw —
      // and never assumed. Each milestone is bracketed with that rate and found
      // inside its bracket BY CONTENT, against a clip of the live page.
      // DL-PW-08.
      const filmedSpanS = (closeRequestedAt - recordingEpoch) / 1000;

      expect(
        filmedSpanS,
        'the wall clock measured no span between the epoch this test took ' +
          'and the close that ended the recording',
      ).toBeGreaterThan(0);

      const encodedRate = metadata.duration / filmedSpanS;

      expect(
        encodedRate,
        `the recording declares ${metadata.duration.toFixed(2)}s against the ` +
          `${filmedSpanS.toFixed(2)}s the wall clock measured, a rate no ` +
          'mapping between the two timelines can be built on',
      ).toBeGreaterThan(0);

      /** Seconds from the epoch to a wall-clock instant. */
      const sinceEpoch = (wallClock: number): number =>
        Math.max(0, (wallClock - recordingEpoch) / 1000);

      /** Recording position of a wall-clock instant, at a given rate. */
      const positionOf = (wallClock: number, rate: number): number =>
        Math.min(metadata.duration, sinceEpoch(wallClock) * rate);

      /** The bracket a held screen state is searched in. */
      const heldBracket = (anchor: number): readonly number[] =>
        timestampsAcross(
          positionOf(anchor, encodedRate) - MILESTONE_SEARCH_S,
          positionOf(anchor + MILESTONE_HOLD_MS, encodedRate) +
            MILESTONE_SEARCH_S,
          MILESTONE_STEP_S,
        );

      const sweepStamps = timestampsAcross(
        0,
        SWEEP_SAMPLE_COUNT * FRAME_STEP_S * 10,
        FRAME_STEP_S * 10,
      );
      const rewardStamps = heldBracket(rewardHeldFrom);
      const selectionStamps = heldBracket(selectionHeldFrom);

      // THE RECORDING HAS TO REACH THE SELECTION. A file truncated before the
      // relic was taken fails here rather than being sampled at its last frame,
      // which is what a clamped seek would otherwise do silently.
      expect(
        metadata.duration,
        'the recording ends before the moment the relic was taken had ' +
          'settled, so the run it records was cut short of the selection',
      ).toBeGreaterThan(
        positionOf(selectionHeldFrom + MILESTONE_HOLD_MS, encodedRate) -
          MILESTONE_STEP_S,
      );

      for (const window of [
        { label: 'the opening sweep', stamps: sweepStamps },
        { label: 'the reward bracket', stamps: rewardStamps },
        { label: 'the post-selection bracket', stamps: selectionStamps },
      ]) {
        expect(
          window.stamps.length,
          `${window.label} resolved to no timestamp`,
        ).toBeGreaterThan(0);
      }

      const probe = await probeRecording(
        browser,
        recordingPath,
        [
          ...samplesOver(boardRegion, sweepStamps),
          ...samplesOver(rewardRegion, rewardStamps),
          ...samplesOver(rewardRegion, selectionStamps),
        ],
        [rewardReference, selectionReference],
      );

      expect(
        probe.loaded,
        `the recording at ${recordingPath} could not be decoded a second ` +
          `time: ${probe.error}`,
      ).toBe(true);
      expect(
        probe.frames.length,
        'no frame of the recording could be sampled',
      ).toBe(
        sweepStamps.length + rewardStamps.length + selectionStamps.length,
      );
      expect(
        probe.references.length,
        'the two pictures of the live page were not measured alongside the ' +
          'frames they are matched against',
      ).toBe(2);

      let sampled = 0;
      const take = (count: number): readonly FrameSample[] => {
        const window = probe.frames.slice(sampled, sampled + count);

        sampled += count;

        return window;
      };

      const sweepFrames = take(sweepStamps.length);
      const rewardFrames = take(rewardStamps.length);
      const selectionFrames = take(selectionStamps.length);
      const rewardShown = probe.references[0];
      const selectionShown = probe.references[1];

      /* Criterion (a), in the artifact: the board is visibly rendered. */

      // Every sampled frame of the board region is measured with the same
      // verdict the live canvas is held to, so a black or flat encode fails
      // here on the same thresholds.
      const litFrames = sweepFrames.filter((frame): boolean =>
        carriesRenderedContent(frame.verdict),
      );

      expect(
        litFrames.length,
        'no sampled frame of the recording carries a rendered board: the ' +
          'brightest sample measured ' +
          `${Math.max(
            ...sweepFrames.map((frame): number => frame.verdict.peakLuminance),
            0,
          ).toFixed(0)} peak luminance over ` +
          `${Math.max(
            ...sweepFrames.map(
              (frame): number => frame.verdict.distinctColours,
            ),
            0,
          )} distinct colours, which is a black or flat encode`,
      ).toBeGreaterThan(0);

      // The strongest single frame is held to the full board verdict.
      const brightest = litFrames.reduce((best, frame) =>
        frame.verdict.peakLuminance > best.verdict.peakLuminance ? frame : best,
      );

      expectRenderedBoard(
        brightest.verdict,
        `the recorded frame at ${brightest.at.toFixed(2)}s`,
      );

      /* The recording is a moving picture, not a still. */

      expect(
        new Set(sweepFrames.map((frame): string => frame.signature)).size,
        'the recording repeats one picture across its whole span, so it is a ' +
          'static encode rather than a played run',
      ).toBeGreaterThanOrEqual(MIN_DISTINCT_SWEEP_FRAMES);

      /* Criterion (c), in the artifact: the reward selection is visible. */

      // Both brackets measure the SAME rectangle, the one the reward dialog
      // occupied, and each is searched for the first frame carrying a clip of
      // the LIVE page taken while that state stood. What is asserted is that
      // the recording holds a picture of the dialog and, after it, a picture of
      // what the selection put in its place.
      expect(
        frameDistance(rewardShown, selectionShown),
        'the clip taken while the reward dialog stood and the clip taken ' +
          'after the relic was chosen are the same picture, so the two ' +
          'states are not distinguishable and no search between them means ' +
          'anything',
      ).toBeGreaterThanOrEqual(MIN_STATE_CHANGE);
      expect(
        carriesRenderedContent(rewardShown.verdict),
        'the clip taken while the reward dialog stood carries no rendered ' +
          'picture',
      ).toBe(true);

      const rewardClosest = closestFrameTo(rewardFrames, rewardShown);

      expect(
        rewardClosest,
        'the reward bracket resolved to no frame',
      ).not.toBeNull();

      if (rewardClosest === null) {
        throw new Error('the reward bracket resolved to no frame');
      }

      expect(
        rewardClosest.distance,
        'no frame of the reward bracket carries the reward dialog: the ' +
          `closest, at ${rewardClosest.frame.at.toFixed(2)}s, is ` +
          `${rewardClosest.distance.toFixed(2)} from the clip taken while ` +
          'the dialog stood on screen',
      ).toBeLessThanOrEqual(MATCH_TOLERANCE);

      const rewardMatch = firstFrameMatching(
        rewardFrames,
        rewardShown,
        MATCH_TOLERANCE,
      );

      expect(
        rewardMatch,
        'the reward dialog matched no frame within tolerance',
      ).not.toBeNull();

      if (rewardMatch === null) {
        throw new Error('the reward dialog matched no frame');
      }

      expect(
        carriesRenderedContent(rewardMatch.verdict),
        `the recorded frame at ${rewardMatch.at.toFixed(2)}s carries no ` +
          'rendered picture where the reward dialog was on screen',
      ).toBe(true);
      expect(
        frameDistance(rewardMatch, selectionShown),
        `the recorded frame at ${rewardMatch.at.toFixed(2)}s is as close to ` +
          'the state that replaced the dialog as to the dialog itself, so it ' +
          'establishes neither',
      ).toBeGreaterThanOrEqual(MIN_STATE_CHANGE);

      // Searched among the frames that FOLLOW the one carrying the dialog, so
      // what is established is a change in that order rather than a difference
      // somewhere in the recording.
      const afterReward = selectionFrames.filter(
        (frame): boolean => frame.at > rewardMatch.at,
      );

      expect(
        afterReward.length,
        'the post-selection bracket resolved to no frame later than the one ' +
          `carrying the dialog at ${rewardMatch.at.toFixed(2)}s`,
      ).toBeGreaterThan(0);

      const selectionClosest = closestFrameTo(afterReward, selectionShown);

      expect(
        selectionClosest,
        'the post-selection bracket resolved to no frame',
      ).not.toBeNull();

      if (selectionClosest === null) {
        throw new Error('the post-selection bracket resolved to no frame');
      }

      expect(
        selectionClosest.distance,
        'no frame after the dialog carries the state the selection opened: ' +
          `the closest, at ${selectionClosest.frame.at.toFixed(2)}s, is ` +
          `${selectionClosest.distance.toFixed(2)} from the clip taken once ` +
          'the relic had been taken',
      ).toBeLessThanOrEqual(MATCH_TOLERANCE);

      const selectionMatch = firstFrameMatching(
        afterReward,
        selectionShown,
        MATCH_TOLERANCE,
      );

      expect(
        selectionMatch,
        'the state the selection opened matched no frame after the dialog',
      ).not.toBeNull();

      if (selectionMatch === null) {
        throw new Error('the state the selection opened matched no frame');
      }

      expect(
        frameDistance(selectionMatch, rewardShown),
        `the recorded frame at ${selectionMatch.at.toFixed(2)}s still reads ` +
          'as the reward dialog, so the recording does not show the ' +
          'selection closing it',
      ).toBeGreaterThanOrEqual(MIN_STATE_CHANGE);

      /* Criterion (b), in the artifact: the merge animation is visible. */

      // The merge window is placed with a rate calibrated between two KNOWN
      // correspondences — the start of the recording, and the frame just
      // found to carry the reward dialog — so it is interpolated inside a
      // measured interval rather than extrapolated from the recording's mean.
      // The settled reading it is measured against is anchored on the frame
      // found to carry the state the selection opened.
      const rewardWallS = sinceEpoch(rewardHeldFrom);

      expect(
        rewardWallS,
        'the reward dialog stood at the epoch itself, so no interval closes ' +
          'between the two',
      ).toBeGreaterThan(0);

      const calibratedRate = rewardMatch.at / rewardWallS;

      expect(
        calibratedRate,
        `the frame carrying the dialog sits at ${rewardMatch.at.toFixed(2)}s ` +
          `against the ${rewardWallS.toFixed(2)}s the wall clock measured to ` +
          'it, a rate no mapping can be built on',
      ).toBeGreaterThan(0);

      const mergeAt = positionOf(mergeFilm.pressedAt, calibratedRate);
      const mergeStamps = timestampsAcross(
        Math.max(0, mergeAt + MOVE_TRANSITION_MS / 1000),
        mergeAt + MOVE_TRANSITION_MS / 1000 + MILESTONE_TOLERANCE_S,
        MERGE_STEP_S,
      );
      // Taken AFTER that frame rather than around it: the first frame to carry
      // the state is the one the transition into it produced, so a window
      // straddling it would measure the transition and not the rest.
      const settledStamps = timestampsAcross(
        selectionMatch.at + MERGE_STEP_S,
        selectionMatch.at + MERGE_STEP_S * SETTLED_SAMPLE_COUNT,
        MERGE_STEP_S,
      );

      const cellProbe = await probeRecording(browser, recordingPath, [
        ...samplesOver(mergedCellRegion, mergeStamps),
        ...samplesOver(mergedCellRegion, settledStamps),
      ]);

      expect(
        cellProbe.loaded,
        `the recording at ${recordingPath} could not be decoded a third ` +
          `time: ${cellProbe.error}`,
      ).toBe(true);
      expect(
        cellProbe.frames.length,
        'the merged cell could not be sampled',
      ).toBe(mergeStamps.length + settledStamps.length);

      const mergeFrames = cellProbe.frames.slice(0, mergeStamps.length);
      const settledCellFrames = cellProbe.frames.slice(mergeStamps.length);

      // Sampled over the merged cell alone, which the assertions above proved
      // disjoint from the cell the same turn spawned into: the `appear` tween
      // runs over the same window as the pop but paints nowhere in this
      // rectangle, so what changes here is the merge being animated.
      expect(
        mergeFrames.length,
        'the merge window fell outside the recording',
      ).toBeGreaterThan(MIN_DISTINCT_MERGE_FRAMES);
      expect(
        settledCellFrames.length,
        'the settled reading of the merged cell resolved to no frame',
      ).toBeGreaterThan(MIN_DISTINCT_MERGE_FRAMES);
      expect(
        new Set(mergeFrames.map((frame): string => frame.signature)).size,
        'the merged cell does not change across the merge window, which ' +
          'opens after the move transition has finished, so nothing was ' +
          'drawn for the merge in the cell it produced its tile in',
      ).toBeGreaterThanOrEqual(MIN_DISTINCT_MERGE_FRAMES);

      // Measured in magnitude and against a reading of the same cell taken
      // where nothing is animating, so an encode that differs only by
      // compression noise cannot stand in for a drawn animation.
      const mergeChange = widestDistanceWithin(mergeFrames);
      const settledCellChange = widestDistanceWithin(settledCellFrames);

      expect(
        mergeChange,
        `the merged cell moved by ${mergeChange.toFixed(2)} across the merge ` +
          'window, which is below the change a drawn pop produces',
      ).toBeGreaterThanOrEqual(MIN_MERGE_CHANGE);
      expect(
        mergeChange,
        `the merged cell moved by ${mergeChange.toFixed(2)} across the merge ` +
          `window and by ${settledCellChange.toFixed(2)} across a window in ` +
          'which nothing is animating, so the two are indistinguishable and ' +
          'the first is compression noise rather than an animation',
      ).toBeGreaterThanOrEqual(settledCellChange * MERGE_CHANGE_MARGIN);
    },
  );

  test(
    'reports the six health checks, the module-boundary spans, the ' +
      'Prometheus exposition and the correlated log records through the ' +
      'diagnostics surface',
    { tag: '@diagnostics' },
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

      /* -- The dashboard template, fed that very export ------------------- */

      // The combined snapshot is read here rather than out of the downloaded
      // file: it is the same text the export writes, and reading it through the
      // page keeps this spec free of any filesystem access.
      const combinedJson = await page.evaluate(
        (globalName: string): string => {
          const published = (globalThis as unknown as Record<string, unknown>)[
            globalName
          ];

          if (published === undefined || published === null) {
            return '';
          }

          return (published as InspectionHandle).diagnostics.snapshotJson();
        },
        APPLICATION_GLOBAL,
      );

      expect(
        combinedJson.length,
        'the diagnostics surface exported an empty combined snapshot',
      ).toBeGreaterThan(0);

      await page.goto(DASHBOARD_TEMPLATE_URL);

      const dashboardStatus = page.locator(DASHBOARD_SELECTORS.status);

      await expect(
        dashboardStatus,
        'the dashboard template did not open in its pre-load state',
      ).toHaveAttribute('data-level', 'empty');

      await page.locator(DASHBOARD_SELECTORS.pasteBox).fill(combinedJson);
      await page.locator(DASHBOARD_SELECTORS.render).click();

      await expect(
        dashboardStatus,
        'the dashboard template refused the combined diagnostics snapshot ' +
          'this session exported',
      ).toHaveAttribute('data-level', 'loaded');
      await expect(
        dashboardStatus,
        'the dashboard template did not name the form it read',
      ).toContainText('combined diagnostics snapshot');
      await expect(
        page.locator(DASHBOARD_SELECTORS.provenance),
        'the dashboard template did not carry the run correlation identifier',
      ).toContainText(reading.health.correlationId);

      for (const check of HEALTH_CHECK_IDS) {
        await expect(
          page.locator(DASHBOARD_SELECTORS.healthPanel),
          `the dashboard template rendered no "${check}" health row`,
        ).toContainText(check);
      }

      await expect(
        page.locator(DASHBOARD_SELECTORS.runTotalsPanel),
        'the dashboard template rendered no turn total',
      ).toContainText('turns');
      await expect(
        page.locator(DASHBOARD_SELECTORS.tracePanel),
        'the dashboard template rendered no trace summary',
      ).toContainText('spans started');

      // And the other export form the surface writes, through the same page.
      await page.locator(DASHBOARD_SELECTORS.clear).click();

      await expect(
        dashboardStatus,
        'the dashboard template did not return to its pre-load state',
      ).toHaveAttribute('data-level', 'empty');

      await page
        .locator(DASHBOARD_SELECTORS.pasteBox)
        .fill(reading.metrics.text);
      await page.locator(DASHBOARD_SELECTORS.render).click();

      await expect(
        dashboardStatus,
        'the dashboard template refused the Prometheus exposition this ' +
          'session exported',
      ).toHaveAttribute('data-level', 'loaded');
      await expect(
        dashboardStatus,
        'the dashboard template did not name the exposition form',
      ).toContainText('Prometheus text exposition');
      await expect(
        page.locator(DASHBOARD_SELECTORS.healthPanel),
        'the dashboard template read no health gauge out of the exposition',
      ).toContainText('healthy');
    },
  );
});
