// The screen state machine, and the ONE owner of the effective input context.
//
// The state machine below implements AAP Figure 6. The single public entry
// point of src/ui/: src/main.ts names this module and no other sibling.
//
// PROVENANCE of each ported construct — what it is, and where it came from:
//   js/html_actuator.js L127-L133  `message(won)`: the `game-won`/`game-over`
//                                  class and the `You win!`/`Game over!` copy,
//                                  carried verbatim by
//                                  `TERMINAL_OVERLAY_CLASSES` and
//                                  `TERMINAL_OVERLAY_COPY`
//   js/html_actuator.js L135-L139  `clearMessage()`: two separate class
//                                  removals, kept separate
//   js/html_actuator.js L38-L41    `continueGame()`, reached from the one path
//                                  that serves both js/game_manager.js L19
//                                  (`restart`) and L26 (`keepPlaying`)
//   js/html_actuator.js L2-L5      four unguarded `querySelector` lookups,
//                                  replaced by the guarded `resolveMount` and
//                                  `resolveMounts` of ./a11y/settings (I12)
//   js/game_manager.js L9-L11      three fixed input subscriptions,
//                                  generalised into the input context every
//                                  modality resolves against
//   js/game_manager.js L30-L32     `isGameTerminated()`:
//                                  `over || (won && !keepPlaying)`, read off
//                                  the commit's own `terminated`
//   js/game_manager.js L91-L97     the actuation payload, arriving as
//                                  `state:commit`
//   js/keyboard_input_manager.js L18-L32
//                                  append-only `on` and synchronous in-order
//                                  `emit`; every subscription here relies on
//                                  the append
//   style/main.scss L234-L235      the overlay cadence, read from
//                                  `motion.fadeIn` of ../theme/tokens
//   style/main.scss L103, L205     the z-index ceiling of 100, extended
//                                  through `zIndex` of ../theme/tokens
//   style/_screens.scss            the `hidden` attribute as the whole
//                                  active-and-inactive mechanism
//
// Traceability rows in docs/TRACEABILITY_MATRIX.md:
//   TR-ROUTER-01 .. TR-ROUTER-12
// Decision rows in docs/DECISION_LOG.md:
//   DL-ROUTER-01 .. DL-ROUTER-09
//
// This module reads no storage, consumes no randomness and draws no board.

import type { StageGoal, StageGoalProgress } from '../config/stage-config';
import { evaluateStageGoal } from '../config/stage-config';
import type {
  EngineEventSubscription,
  EngineEvents,
  MoveAfterEvent,
  StageEndEvent,
  StageStartEvent,
  StateCommitEvent,
  TileMergeEvent,
  TileSpawnEvent,
} from '../engine/engine-events';
import type { BestScoreValue, RelicCommitContext } from '../engine/types';
import { resolveDocumentContext } from '../input/input-manager';
import type { InputContext, Keymap } from '../input/keymap';
import type { Relic } from '../relics/relic-types';
import type {
  PersistedRelic,
  RunOutcome,
  RunSummary,
} from '../run/run-state';
import { motion, zIndex } from '../theme/tokens';
import { createFocusManager } from './a11y/focus-manager';
import type {
  FocusManager,
  FocusTrapHandle,
  ScreenName as FocusScreenName,
} from './a11y/focus-manager';
import type {
  Announcement,
  AnnouncementPolarity,
  TerminalVerdict,
} from './a11y/live-region';
import type { MissingMount, UiReporter } from './a11y/settings';
import {
  NOOP_UI_REPORTER,
  createSafeUiReporter,
  formatMissingMounts,
  resolveMount,
  resolveMounts,
} from './a11y/settings';

/* ==========================================================================
 * 1. Names carried into reports
 * ========================================================================== */

/** Context label attached to every report this module raises. */
const REPORT_CONTEXT = 'screen-router';

const SETTINGS_OPEN_METRIC = 'ui.router.settings.open';
const SETTINGS_CLOSE_METRIC = 'ui.router.settings.close';
const SETTINGS_REFUSED_METRIC = 'ui.router.settings.refused';
const SCREEN_METRIC = 'ui.router.screen';
const REFRESH_METRIC = 'ui.router.refresh';
const AFTER_DESTROY_METRIC = 'ui.router.after_destroy';
const REWARD_OPEN_METRIC = 'ui.router.reward.open';
const REWARD_CLOSE_METRIC = 'ui.router.reward.close';
const REWARD_REFUSED_METRIC = 'ui.router.reward.refused';
const REWARD_SELECT_METRIC = 'ui.router.reward.select';

/** Counter raised for each applied state-machine transition. */
const TRANSITION_METRIC = 'ui.router.transition';

/** Counter raised for each trigger the table declares no edge for. */
const TRANSITION_REFUSED_METRIC = 'ui.router.transition.refused';

/** Counter raised for each screen mount point the document did not supply. */
const MOUNT_MISSING_METRIC = 'ui.router.mount.missing';

/** Counter raised for each screen-module lifecycle call that raised. */
const SCREEN_MODULE_ERROR_METRIC = 'ui.router.screen.error';

/** Counter raised for each state-listener call that raised. */
const LISTENER_ERROR_METRIC = 'ui.router.listener.error';

/** Counter raised for each run-port call that raised or was unavailable. */
const RUN_PORT_METRIC = 'ui.router.run.unavailable';

/** Counter raised when the machine is driven before `start()`. */
const NOT_STARTED_METRIC = 'ui.router.not_started';

/** Counter raised for each terminal-overlay write and clear. */
const OVERLAY_METRIC = 'ui.router.overlay';

/* ==========================================================================
 * 2. The state machine — AAP Figure 6
 * ========================================================================== */

/**
 * The seven screen states, in the order a run visits them.
 *
 * An ordered tuple, so the union below is derived from the list rather than
 * restated beside it. `satisfies readonly FocusScreenName[]` is the
 * compile-time agreement with the `ScreenName` of ./a11y/focus-manager, whose
 * `focusInitial` is called with these values; `SCREEN_MOUNTS` closes the
 * agreement in the other direction.
 */
export const SCREEN_NAMES = Object.freeze([
  'runStart',
  'stage',
  'stageClear',
  'reward',
  'won',
  'gameOver',
  'runSummary',
] as const satisfies readonly FocusScreenName[]);

/** Union of the names in `SCREEN_NAMES`. */
export type ScreenName = (typeof SCREEN_NAMES)[number];

/** The state a cold load lands in, the target of the `initial` trigger. */
export const INITIAL_SCREEN: ScreenName = 'runStart';

/**
 * Narrows a value to a screen name.
 *
 * @param value Candidate name.
 * @returns Whether `value` is one of `SCREEN_NAMES`.
 */
export function isScreenName(value: unknown): value is ScreenName {
  return SCREEN_NAMES.some((name): boolean => name === value);
}

/**
 * Every transition trigger, in the order the flow uses them.
 *
 * `initial` is the cold-load trigger and is applied by `start()`; the twelve
 * that follow are the state-keyed edges of `TRANSITIONS`.
 */
export const ROUTER_TRIGGERS = Object.freeze([
  'initial',
  'beginRun',
  'move',
  'restart',
  'stageGoalMet',
  'stageEnd',
  'rewardSelected',
  'winReached',
  'keepPlaying',
  'endRun',
  'noMovesAvailable',
  'acknowledge',
  'newRun',
] as const);

/** Union of the names in `ROUTER_TRIGGERS`. */
export type RouterEventName = (typeof ROUTER_TRIGGERS)[number];

/**
 * Narrows a value to a trigger name.
 *
 * @param value Candidate trigger.
 * @returns Whether `value` is one of `ROUTER_TRIGGERS`.
 */
export function isRouterTrigger(value: unknown): value is RouterEventName {
  return ROUTER_TRIGGERS.some((name): boolean => name === value);
}

/** One state's outgoing edges, keyed by the trigger that takes them. */
export type ScreenTransitions = Readonly<
  Partial<Record<RouterEventName, ScreenName>>
>;

/**
 * The transition table: the twelve state-keyed edges of AAP Figure 6, keyed by
 * state and then by trigger. The thirteenth edge is the cold load, whose
 * `initial` trigger resolves to `INITIAL_SCREEN`.
 *
 * A trigger absent from the state in force takes no edge: it is reported and
 * the state stands.
 */
export const TRANSITIONS: Readonly<Record<ScreenName, ScreenTransitions>> =
  Object.freeze({
    runStart: Object.freeze({ beginRun: 'stage' }),
    stage: Object.freeze({
      move: 'stage',
      restart: 'stage',
      stageGoalMet: 'stageClear',
      winReached: 'won',
      noMovesAvailable: 'gameOver',
    }),
    stageClear: Object.freeze({ stageEnd: 'reward' }),
    reward: Object.freeze({ rewardSelected: 'stage' }),
    won: Object.freeze({ keepPlaying: 'stage', endRun: 'runSummary' }),
    gameOver: Object.freeze({ acknowledge: 'runSummary' }),
    runSummary: Object.freeze({ newRun: 'runStart' }),
  } satisfies Readonly<Record<ScreenName, ScreenTransitions>>);

/**
 * The container each state mounts into, as the selector index.html declares.
 *
 * index.html is the authority for every one of these; none is invented here.
 * `won` and `gameOver` share `#screen-game-over`, which is the one overlay
 * that renders both terminal verdicts, exactly as the single `.game-message`
 * overlay did.
 *
 * The `satisfies` closes the name agreement with ./a11y/focus-manager: a name
 * that module declares and this one does not would leave a required key
 * missing here.
 */
export const SCREEN_MOUNTS = Object.freeze({
  runStart: '#screen-run-start',
  stage: '#screen-hud',
  stageClear: '#screen-stage-progress',
  reward: '#screen-reward',
  won: '#screen-game-over',
  gameOver: '#screen-game-over',
  runSummary: '#screen-run-summary',
} satisfies Readonly<Record<FocusScreenName, string>>);

/** Selector each state's container is found at. */
export type ScreenMountSpec = typeof SCREEN_MOUNTS;

/**
 * The module under src/ui/screens/ that renders each state, one apiece.
 *
 * Recorded as data rather than as imports: a screen arrives through the
 * `screens` option, so this module's import list names no screen module and
 * the flow is exercisable with none of them present.
 */
export const SCREEN_MODULES = Object.freeze({
  runStart: 'screens/run-start',
  stage: 'screens/hud',
  stageClear: 'screens/stage-progress',
  reward: 'screens/reward',
  won: 'screens/game-over',
  gameOver: 'screens/game-over',
  runSummary: 'screens/run-summary',
} satisfies Readonly<Record<ScreenName, string>>);

/**
 * The input context each state is interpreted in. `stage` is the only state
 * movement resolves in; every other state is an overlay.
 */
export const SCREEN_INPUT_CONTEXTS = Object.freeze({
  runStart: 'overlay',
  stage: 'game',
  stageClear: 'overlay',
  reward: 'overlay',
  won: 'overlay',
  gameOver: 'overlay',
  runSummary: 'overlay',
} satisfies Readonly<Record<ScreenName, InputContext>>);

/**
 * The states whose entry suspends the input manager, and whose exit resumes
 * it. `reward` is the state that holds a choice the run cannot proceed past.
 */
export const SCREEN_SUSPENDS_INPUT = Object.freeze({
  runStart: false,
  stage: false,
  stageClear: false,
  reward: true,
  won: false,
  gameOver: false,
  runSummary: false,
} satisfies Readonly<Record<ScreenName, boolean>>);

/**
 * The states rendered as a trapped modal dialog.
 *
 * `won` and `gameOver` are `false`. Those two states present across two
 * disjoint subtrees — the container inside `.screen-layer`, and the retained
 * `.game-message` inside `<main>` carrying the controls of
 * js/html_actuator.js L127-L139 — and a trap engaged on either one excludes
 * the other, so both are focus-placed rather than trapped. The vanilla
 * terminal overlay trapped nothing.
 */
export const SCREEN_TRAPS_FOCUS = Object.freeze({
  runStart: true,
  stage: false,
  stageClear: false,
  reward: true,
  won: false,
  gameOver: false,
  runSummary: true,
} satisfies Readonly<Record<ScreenName, boolean>>);

/**
 * The states rendered as one of the mutually exclusive overlay roots, of which
 * index.html unhides exactly one at a time.
 *
 * `stage` is `false`: its container is `#screen-hud`, which index.html declares
 * IN FLOW inside `<main>` rather than inside `.screen-layer`, so it is not one
 * of the five overlay roots and is not re-hidden when an overlay goes up over
 * it.
 */
export const SCREEN_IS_OVERLAY = Object.freeze({
  runStart: true,
  stage: false,
  stageClear: true,
  reward: true,
  won: true,
  gameOver: true,
  runSummary: true,
} satisfies Readonly<Record<ScreenName, boolean>>);

/**
 * The states the in-run HUD is shown in.
 *
 * `runStart` and `runSummary` are the two states outside a run, so the stage
 * indicator and the active-relic tray are down for both. The five in-run states
 * keep it up, including the four that put an overlay over it.
 */
export const SCREEN_SHOWS_HUD = Object.freeze({
  runStart: false,
  stage: true,
  stageClear: true,
  reward: true,
  won: true,
  gameOver: true,
  runSummary: false,
} satisfies Readonly<Record<ScreenName, boolean>>);

/**
 * The states whose trap marks the game region inert.
 *
 * `won` and `gameOver` are `false`: the terminal overlay `.game-message` those
 * two states write is a descendant of that region, so marking it inert would
 * make the controls inside it inert while they are on screen. Only a trapping
 * state reads this, and neither of those two traps.
 */
export const SCREEN_INERTS_BACKGROUND = Object.freeze({
  runStart: true,
  stage: false,
  stageClear: false,
  reward: true,
  won: false,
  gameOver: false,
  runSummary: true,
} satisfies Readonly<Record<ScreenName, boolean>>);

/* ==========================================================================
 * 3. The terminal overlay, subsumed
 * ========================================================================== */

/** Selector the terminal overlay is found at, as index.html declares it. */
export const TERMINAL_OVERLAY_SELECTOR = '.game-message';

/** Selector the overlay's verdict paragraph is found at, inside the overlay. */
export const TERMINAL_OVERLAY_TEXT_SELECTOR = 'p';

/**
 * The two classes js/html_actuator.js L128 computed, verbatim.
 *
 * style/main.scss L237 and L246 select on both, and the recorded-gameplay gate
 * asserts on the rendered overlay.
 */
export const TERMINAL_OVERLAY_CLASSES = Object.freeze({
  won: 'game-won',
  gameOver: 'game-over',
} as const);

/** The two strings js/html_actuator.js L129 computed, verbatim. */
export const TERMINAL_OVERLAY_COPY = Object.freeze({
  won: 'You win!',
  gameOver: 'Game over!',
} as const);

/** The two terminal states, as `TERMINAL_OVERLAY_CLASSES` keys them. */
export type TerminalScreenName = keyof typeof TERMINAL_OVERLAY_CLASSES;

/**
 * The overlay cadence, read from `motion.fadeIn` of ../theme/tokens and never
 * restated as a literal here.
 *
 * `motion.fadeIn.delay` is `transitionSpeed * 12`, the `$transition-speed * 12`
 * of style/main.scss L234, and `duration` is that rule's 800. `total` is the
 * interval an assertion on the overlay has to clear.
 */
export const OVERLAY_CADENCE = Object.freeze({
  delay: motion.fadeIn.delay,
  duration: motion.fadeIn.duration,
  total: motion.fadeIn.delay + motion.fadeIn.duration,
} as const);

/**
 * The three slots of the ladder this module may occupy, read from `zIndex` of
 * ../theme/tokens.
 *
 * The diagnostics slot is deliberately absent: it sits above all three and
 * creates its own host, so no screen here may reach or shadow it.
 */
export const SCREEN_LAYERS = Object.freeze({
  hud: zIndex.hud,
  screenOverlay: zIndex.screenOverlay,
  modal: zIndex.modal,
} as const);

/** The verdict each terminal state announces, as ./a11y/live-region
 * names it. */
export const TERMINAL_VERDICTS_BY_SCREEN = Object.freeze({
  won: 'win',
  gameOver: 'loss',
} satisfies Readonly<Record<TerminalScreenName, TerminalVerdict>>);

/** The line announced on entering each state. */
export const SCREEN_ANNOUNCEMENTS = Object.freeze({
  runStart: 'Run start. Begin a run, or enter a seed.',
  stage: 'Stage. The board is playable.',
  stageClear: 'Stage cleared.',
  reward: 'Choose a relic.',
  won: TERMINAL_OVERLAY_COPY.won,
  gameOver: TERMINAL_OVERLAY_COPY.gameOver,
  runSummary: 'Run summary.',
} satisfies Readonly<Record<ScreenName, string>>);

/* ==========================================================================
 * 4. The screen lifecycle
 * ========================================================================== */

/**
 * The lifecycle every module under src/ui/screens/ implements, so the seven
 * states are driven through one shape.
 *
 * `mount` and `unmount` bracket a screen's whole life and run once each;
 * `enter` and `leave` bracket one visit; `update` is the in-state refresh path,
 * so a commit arriving while the state stands refreshes the screen rather than
 * tearing it down and rebuilding it.
 *
 * Each call is invoked defensively: a member a screen omits is skipped, and a
 * member that raises is reported and the transition continues.
 */
export interface Screen {
  /** Receives the resolved container. Called once, before the first `enter`. */
  mount(host: Element): void;

  /** Called on every entry to the state, after `mount`. */
  enter(context: ScreenContext): void;

  /** Called for each refresh while the state stands. */
  update(context: ScreenContext): void;

  /** Called on every exit from the state. */
  leave(): void;

  /** Called once, when the router is destroyed. */
  unmount(): void;
}

/**
 * A screen as the `screens` option carries it: any subset of the lifecycle, so
 * a screen that needs only `update` declares only `update`.
 */
export type ScreenModule = Partial<Screen>;

/** The screen modules, keyed by the state each renders. */
export type ScreenRegistry = Readonly<
  Partial<Record<ScreenName, ScreenModule>>
>;

/* ==========================================================================
 * 5. Per-screen context
 * ========================================================================== */

/** The members every screen context carries. */
export interface ScreenContextBase {
  /** State this context describes. */
  readonly screen: ScreenName;

  /** Trigger that produced it. `initial` on the cold load. */
  readonly trigger: RouterEventName;

  /** Whether motion is reduced, read at the moment of the transition. */
  readonly reducedMotion: boolean;

  /** Container resolved for the state, and `null` where none was. */
  readonly host: Element | null;

  /** Whether this context is an in-state refresh rather than an entry. */
  readonly refresh: boolean;
}

/** Context for `runStart`. */
export interface RunStartScreenContext extends ScreenContextBase {
  readonly screen: 'runStart';

  /** The seed in force, verbatim, and `null` where the port supplied none. */
  readonly seed: string | null;

  /** The run identifier, and `null` where the port supplied none. */
  readonly runId: string | null;

  /** The summary of the run that just ended, on a return from `runSummary`. */
  readonly previous: RunSummary | null;
}

/** Context for `stage`, the in-run board and HUD. */
export interface StageScreenContext extends ScreenContextBase {
  readonly screen: 'stage';

  /** Accumulated score, from js/game_manager.js L92. */
  readonly score: number;

  /**
   * Persisted best score, carried exactly as the commit did and never coerced:
   * the raw stored string when a value is present and the number `0` when it is
   * absent.
   */
  readonly bestScore: BestScoreValue;

  /** Zero-based stage index. */
  readonly stageIndex: number;

  /** The goal in force, and `null` before a stage has declared one. */
  readonly goal: StageGoal | null;

  /** Measured progress against `goal`, and `null` where it was unmeasurable. */
  readonly goalProgress: StageGoalProgress | null;

  /** The active relics IN PICKUP ORDER, forwarded in the order supplied. */
  readonly relics: RelicCommitContext;

  /**
   * The live board dimension, read from the commit or the stage start on every
   * context and never cached, so a board-mutating relic is observed.
   */
  readonly boardSize: number | null;

  /** Whether the commit reported its terminal or stage status unestablished. */
  readonly degraded: boolean;
}

/** Context for `stageClear`. */
export interface StageClearScreenContext extends ScreenContextBase {
  readonly screen: 'stageClear';

  /** Zero-based index of the stage that ended. */
  readonly stageIndex: number;

  /** Whether the goal was met. */
  readonly cleared: boolean;
  readonly score: number;

  /** The goal that was measured, and `null` where none was in force. */
  readonly goal: StageGoal | null;
}

/** Context for `reward`, the one-of-three choice. */
export interface RewardScreenContext extends ScreenContextBase {
  readonly screen: 'reward';

  /** The offer on screen, in the order it was drawn. */
  readonly offers: readonly RewardCard[];

  /** The drawn relics, where the caller supplied them, in draw order. */
  readonly drawn: readonly Relic[];
  readonly stageIndex: number;
}

/** Context for `won` and `gameOver`, the two terminal verdicts. */
export interface TerminalScreenContext extends ScreenContextBase {
  readonly screen: TerminalScreenName;

  /** The verdict, as ./a11y/live-region names it. */
  readonly verdict: TerminalVerdict;

  /** The overlay copy, from js/html_actuator.js L129. */
  readonly message: string;

  /** The overlay class, from js/html_actuator.js L128. */
  readonly overlayClass: string;
  readonly score: number;
  readonly bestScore: BestScoreValue;

  /** The frozen cadence, from `OVERLAY_CADENCE`. */
  readonly cadence: typeof OVERLAY_CADENCE;
}

/** Context for `runSummary`. */
export interface RunSummaryScreenContext extends ScreenContextBase {
  readonly screen: 'runSummary';

  /** The finished run, and `null` where the port supplied none. */
  readonly summary: RunSummary | null;

  /** How the run ended, and `null` where it was not recorded. */
  readonly outcome: RunOutcome | null;

  /** The run seed, verbatim, for a screen to display and offer for copying. */
  readonly seed: string | null;
}

/** Everything a screen's lifecycle receives. */
export type ScreenContext =
  | RunStartScreenContext
  | StageScreenContext
  | StageClearScreenContext
  | RewardScreenContext
  | TerminalScreenContext
  | RunSummaryScreenContext;

/** One applied transition, as a state listener receives it. */
export interface RouterTransition {
  readonly from: ScreenName;
  readonly to: ScreenName;
  readonly trigger: RouterEventName;

  /** The context the entered state's lifecycle received. */
  readonly context: ScreenContext;
}

/** A listener called after each applied transition. */
export type RouterListener = (transition: RouterTransition) => void;

/** Removes a registration. */
export type RouterSubscription = () => void;

/** Everything `send` accepts alongside a trigger. Every member is optional. */
export interface RouterTriggerPayload {
  /** Seed entered on the run-start screen, carried into `beginRun`. */
  readonly seed?: string;

  /** Relic chosen on the reward screen, carried into `rewardSelected`. */
  readonly relicId?: string;

  /** The offer to present, carried into `stageEnd`. */
  readonly offers?: readonly RewardCard[];

  /** The drawn relics, carried into `stageEnd`. */
  readonly drawn?: readonly Relic[];

  /** How the run ended, carried into `endRun` and `acknowledge`. */
  readonly outcome?: RunOutcome;

  /** Whether the stage goal was met, carried into `stageGoalMet`. */
  readonly cleared?: boolean;
}


/* ==========================================================================
 * 6. The input-context view of the screen
 * ========================================================================== */

/**
 * The screen as the input context sees it.
 *
 * `'won'` and `'gameOver'` are the two states js/html_actuator.js L128
 * expressed as the classes `game-won` and `game-over`; `'settings'` is the
 * modal dialog, which is not a board state and takes precedence over both
 * while it is open.
 */
export type RouterScreen =
  | 'game'
  | 'won'
  | 'gameOver'
  | 'reward'
  | 'settings';

/**
 * One relic as a reward card presents it: plain data, no handler.
 *
 * Structurally the `RewardOffer` of ../run/run-controller; declared here so
 * this module names no run type and the two can be exercised apart.
 */
export interface RewardCard {
  readonly id: string;
  readonly name: string;
  readonly rarity: string;
  readonly description: string;

  /** Hook names the relic binds, rendered as badges. */
  readonly hooks: readonly string[];

  /** Charge budget the relic starts with, where it carries one. */
  readonly charges?: number;
}

/** The part of the input manager this router drives and listens to. */
export interface RouterInputSurface {
  /** Registers a listener for one of the router's three dialog actions. */
  on(
    event: 'openSettings' | 'closeSettings' | 'cancel',
    listener: () => void,
  ): () => void;

  /**
   * Registers a listener for the reward digits, whose payload is the zero-based
   * index of the offer the press addresses.
   */
  on(event: 'selectReward', listener: (index: number) => void): () => void;

  /** The keymap in force, where the surface exposes one. */
  getKeymap?(): Keymap;

  /**
   * Adopts the context of the state in force. Present on the input manager;
   * absent on a bare emitter, in which case the context is read through
   * `context()` instead of pushed.
   */
  setContext?(context: InputContext): void;

  /** Stops resolving bindings while a state holds an unavoidable choice. */
  suspend?(): void;

  /** Resumes resolving bindings. */
  resume?(): void;

  /** Whether bindings are currently suspended. */
  isSuspended?(): boolean;
}

/** The part of the on-screen control layer this router drives. */
export interface RouterControlSurface {
  /** Re-reads the keymap, the context and the motion preference. */
  refresh(): void;
}

/** The surfaces `attach` binds this router to. Either may be absent. */
export interface ScreenRouterSurfaces {
  /** Emitter the three dialog actions are subscribed on. */
  readonly input?: RouterInputSurface | null;

  /** Control layer the effective context is pushed into. */
  readonly controls?: RouterControlSurface | null;
}

/* ==========================================================================
 * 7. Injected ports
 * ========================================================================== */

/**
 * The run lifecycle this router reads and drives. Every member is optional: a
 * member the port omits yields a neutral value and is counted, so the flow runs
 * with no run controller attached at all.
 *
 * `startRun` takes no argument here. The `RunController.startRun(engine)` of
 * ../run/run-controller is adapted to this shape by the composition root, which
 * is what holds the engine.
 */
export interface RouterRunPort {
  /** The run seed, verbatim. */
  seed?(): string;
  runId?(): string;

  /** Zero-based index of the stage in force. */
  stageIndex?(): number;
  stageGoal?(): StageGoal;

  /** Fraction of the goal reached, within the closed interval [0, 1]. */
  goalProgress?(): number;

  /** The held relics IN PICKUP ORDER. */
  relics?(): readonly PersistedRelic[];
  summary?(): RunSummary;

  /** Begins a run. Adapted by the composition root, which holds the engine. */
  startRun?(): unknown;

  /** Advances to the next stage and yields its goal. */
  advanceStage?(): unknown;

  /** Applies one chosen relic. */
  resolveReward?(relicId: string): unknown;

  /** Closes the run out. */
  endRun?(outcome: RunOutcome): unknown;
}

/**
 * The announcer this router speaks through. Both members are optional, and the
 * `LiveRegionAnnouncer` of ./a11y/live-region satisfies it as it stands.
 */
export interface RouterAnnouncerPort {
  announce?(input: Announcement): void;
  announceText?(text: string, polarity?: AnnouncementPolarity): void;
}

/**
 * The preferences read before an entrance transition. The `PreferenceStore` of
 * ./a11y/settings satisfies it as it stands.
 */
export interface RouterPreferencePort {
  isReducedMotion?(): boolean;
}

/* ==========================================================================
 * 8. Construction parameters
 * ========================================================================== */

/** Every construction parameter. All are optional. */
export interface ScreenRouterOptions {
  /** Document elements are resolved against. Defaults to the ambient one. */
  readonly document?: Document | null;

  /** Sink every failure and count leaves through. */
  readonly reporter?: UiReporter;

  /**
   * The settings dialog, as an element or a selector. Defaults to
   * `SETTINGS_PANEL_SELECTOR`.
   */
  readonly settingsPanel?: Element | string | null;

  /**
   * The control that opens the dialog, as an element or a selector. Focus
   * returns to it on close. Defaults to `SETTINGS_TRIGGER_SELECTOR`.
   */
  readonly settingsTrigger?: Element | string | null;

  /**
   * The region made inert while the dialog is open, so a screen reader's
   * virtual cursor cannot leave the dialog. Defaults to `GAME_REGION_SELECTOR`.
   */
  readonly gameRegion?: Element | string | null;

  /**
   * Focus manager the dialog's trap is engaged through. One is built where
   * the caller supplies none.
   */
  readonly focus?: FocusManager;

  /** Called after the dialog is shown, so its body is rendered or synced. */
  readonly onSettingsOpen?: (panel: Element) => void;

  /** Called after the dialog is hidden. */
  readonly onSettingsClose?: (panel: Element) => void;

  /**
   * The reward screen, as an element or a selector. Defaults to
   * `REWARD_SCREEN_SELECTOR`.
   */
  readonly rewardScreen?: Element | string | null;

  /**
   * Called with the identifier of the card the player chose. The router neither
   * validates nor applies the choice: ../run/run-controller owns the reward
   * transaction, and this reports the choice into it.
   */
  readonly onRewardSelect?: (relicId: string) => void;

  /** Copy the reward screen renders. Defaults to `DEFAULT_REWARD_COPY`. */
  readonly rewardCopy?: RewardCopy;

  /**
   * Resolves where focus returns to when the reward screen closes.
   *
   * A FUNCTION, not an element. The board's parallel accessibility layer uses a
   * roving tab stop, so the element that can take focus is whichever cell
   * currently carries `tabindex="0"`. Called once per open, just before the
   * trap engages.
   *
   * Absent — or returning `null` — leaves the trap's own fallback in charge,
   * which restores to whatever held focus before the screen opened.
   */
  readonly rewardRestoreFocusTo?: () => Element | null;

  /**
   * The screen modules, keyed by the state each renders. A state with no entry
   * shows its container and receives no lifecycle call.
   */
  readonly screens?: ScreenRegistry;

  /**
   * Containers for the seven states, overriding the `SCREEN_MOUNTS` lookup per
   * state. An entry of `null` marks a container the caller looked for and did
   * not find.
   */
  readonly screenHosts?: Readonly<Partial<Record<ScreenName, Element | null>>>;

  /** The run lifecycle. Absent members yield neutral values. */
  readonly run?: RouterRunPort;

  /** The announcer every transition is announced through. */
  readonly announcer?: RouterAnnouncerPort;

  /**
   * Whether the granular gameplay events are forwarded to the announcer as
   * well as the transitions.
   *
   * Defaults to `false`: ./a11y/engine-announcer subscribes to the same seven
   * events and owns the move, merge, spawn, stage-clear and terminal
   * announcements. `true` is for a composition that attaches no engine
   * announcer.
   */
  readonly announceGameplay?: boolean;

  /** The preference source read before an entrance transition. */
  readonly preferences?: RouterPreferencePort;

  /**
   * The terminal overlay, as an element or a selector. Defaults to
   * `TERMINAL_OVERLAY_SELECTOR`; `null` opts the router out of writing it.
   */
  readonly terminalOverlay?: Element | string | null;

  /** State this router starts in. Defaults to `INITIAL_SCREEN`. */
  readonly initialScreen?: ScreenName;
}

/** The reward screen's prose. */
export interface RewardCopy {
  readonly heading: string;
  readonly hint: string;

  /** Renders a rarity id as the chip's label. */
  readonly rarity: (rarity: string) => string;

  /** Renders a charge budget as the card's charge label. */
  readonly charges: (charges: number) => string;
}


/* ==========================================================================
 * 9. The mounted router
 * ========================================================================== */

/** The mounted router. */
export interface ScreenRouter {
  /**
   * The effective input context.
   *
   * Handed to `createInputManager` and `mountOnScreenControls` as their
   * `context` option, so the keyboard, the gesture path and the generated
   * controls all read this one function.
   */
  readonly context: () => InputContext;

  /* ---- The state machine ---- */

  /**
   * Applies the `initial` trigger, mounts every screen whose container
   * resolved, and enters `INITIAL_SCREEN`.
   *
   * Until it is called the machine holds its initial state and shows no
   * container: an engine event updates the terminal and reward state the input
   * context reads and takes no edge.
   *
   * @returns The state entered, and the state in force where it had already
   *   started or the router has been destroyed.
   */
  start(): ScreenName;

  /** The state in force. */
  current(): ScreenName;

  /** Whether `start()` has been called. */
  isStarted(): boolean;

  /**
   * Takes the edge `TRANSITIONS` declares for a trigger in the state in force.
   *
   * An edge the table does not declare is reported and refused: the state
   * stands and nothing is torn down.
   *
   * @param trigger Trigger to apply.
   * @param payload Data the entered state's context carries.
   * @returns Whether an edge was taken.
   */
  send(trigger: RouterEventName, payload?: RouterTriggerPayload): boolean;

  /** `send`, under the name a state machine conventionally exposes. */
  go(trigger: RouterEventName, payload?: RouterTriggerPayload): boolean;

  /** Whether `TRANSITIONS` declares an edge for a trigger right now. */
  can(trigger: RouterEventName): boolean;

  /** The container resolved for a state, and `null` where none was. */
  hostFor(screen: ScreenName): Element | null;

  /** Every screen mount point the document did not supply. */
  missingMounts(): readonly MissingMount[];

  /* ---- The input-context view ---- */

  /** The screen in force, as the input context sees it. */
  screen(): RouterScreen;

  /** Whether the settings dialog is open. */
  isSettingsOpen(): boolean;

  /**
   * Shows the reward screen carrying exactly the cards supplied, in the order
   * supplied, and traps focus on the first of them.
   *
   * The cards are rendered from scratch on every call, so the screen shows the
   * offer that was drawn rather than one left over from an earlier stage.
   *
   * @param cards The offer to present.
   * @returns Whether the screen opened. An absent host and an empty offer each
   *   return `false`.
   */
  showReward(cards: readonly RewardCard[]): boolean;

  /**
   * Hides the reward screen and releases its focus trap.
   *
   * @returns Whether the screen was open.
   */
  hideReward(): boolean;

  /** Whether the reward screen is showing. */
  isRewardOpen(): boolean;

  /**
   * Shows the settings dialog, traps focus inside it and makes the board inert.
   *
   * @returns Whether the dialog opened. An absent panel, a panel holding
   *   nothing focusable, and a dialog already open each return `false`.
   */
  openSettings(): boolean;

  /**
   * Hides the dialog, releases the trap and returns focus to its trigger.
   *
   * @returns Whether the dialog closed.
   */
  closeSettings(): boolean;

  /**
   * Attaches the surfaces this router drives, and subscribes to the input
   * events that open and close the dialog.
   *
   * @param surfaces Input emitter and control layer. Either may be absent.
   */
  attach(surfaces: ScreenRouterSurfaces): void;

  /**
   * Subscribes to the engine's seven events, which are where the terminal
   * screens and every in-state refresh come from.
   *
   * @returns A handle that removes every subscription this call registered.
   */
  subscribe(events: EngineEvents): EngineEventSubscription;

  /**
   * Registers a listener called after each applied transition.
   *
   * @returns A handle that removes this listener.
   */
  subscribe(listener: RouterListener): RouterSubscription;

  /**
   * Re-applies the effective context to the attached control layer, and hands
   * the state in force a fresh context through `update`.
   */
  refresh(): void;

  /**
   * Closes the dialog, releases every listener and the focus manager it built,
   * and unmounts every screen. Every later call is a reported no-op.
   */
  destroy(): void;
}

/** Selector the settings dialog is found at by default. */
export const SETTINGS_PANEL_SELECTOR = '#settings-panel';

/** Selector the control that opens the dialog is found at by default. */
export const SETTINGS_TRIGGER_SELECTOR = '#settings-button';

/** Selector the region made inert while the dialog is open. */
export const GAME_REGION_SELECTOR = '#game-main';

/** Selector the reward screen is found at by default. */
export const REWARD_SCREEN_SELECTOR = '#screen-reward';

/** The reward screen's default prose. */
export const DEFAULT_REWARD_COPY: RewardCopy = Object.freeze({
  heading: 'Choose a relic',
  hint: 'One of these three joins your run for the rest of it.',
  rarity: (rarity: string): string => rarity.replace(/-/g, ' '),
  charges: (charges: number): string =>
    `${charges} ${charges === 1 ? 'charge' : 'charges'}`,
});

/* ==========================================================================
 * 10. Element resolution
 * ========================================================================== */

/** The relic slice yielded where neither a commit nor the port supplied one. */
const EMPTY_RELICS: RelicCommitContext = Object.freeze([]);

function readAmbientDocument(): Document | null {
  return typeof document === 'undefined' ? null : document;
}

/**
 * Resolves an element or selector against a document.
 *
 * @param candidate Element, selector, or nothing.
 * @param fallback Selector used when `candidate` is nullish.
 * @param owner Document a selector is resolved against.
 * @returns The element, or `null`.
 */
function resolveElement(
  candidate: Element | string | null | undefined,
  fallback: string,
  owner: Document | null,
): Element | null {
  if (candidate !== null && candidate !== undefined) {
    if (typeof candidate !== 'string') {
      return candidate;
    }

    return owner === null ? null : owner.querySelector(candidate);
  }

  return owner === null ? null : owner.querySelector(fallback);
}

/**
 * Narrows an element to the HTML element whose `hidden` this module writes.
 *
 * `instanceof` is avoided so an element from another realm is accepted.
 */
function asHtmlElement(element: Element | null): HTMLElement | null {
  if (element === null) {
    return null;
  }

  return typeof (element as { hidden?: unknown }).hidden === 'boolean'
    ? (element as HTMLElement)
    : null;
}

/**
 * Writes an element's shown state through the `hidden` attribute, which
 * style/_screens.scss makes the whole active-and-inactive mechanism.
 *
 * @param element Container to write, or `null` for one that did not resolve.
 * @param hidden Whether the container is hidden.
 */
function setHidden(element: Element | null, hidden: boolean): void {
  if (element === null) {
    return;
  }

  const html = asHtmlElement(element);

  if (html !== null) {
    html.hidden = hidden;

    return;
  }

  if (hidden) {
    element.setAttribute('hidden', '');
  } else {
    element.removeAttribute('hidden');
  }
}

/**
 * Reads the highest tile value on a board, and 0 for a board holding none.
 *
 * Read-only: the board travels by reference on every payload and is never
 * cloned and never mutated here. The member names are the ones
 * js/html_actuator.js L16-L22 read off the same objects.
 *
 * @param board Board carried by a commit.
 * @returns The highest value present, or 0.
 */
function readHighestTileValue(board: {
  readonly cells: readonly (readonly ({ readonly value: number } | null)[])[];
}): number {
  let highest = 0;

  for (const column of board.cells) {
    for (const cell of column) {
      if (cell !== null && cell.value > highest) {
        highest = cell.value;
      }
    }
  }

  return highest;
}


/* ==========================================================================
 * 11. Construction
 * ========================================================================== */

/**
 * Mounts the router.
 *
 * Nothing is read at import time: every lookup and every report happens inside
 * this call, and an absent element is reported and skipped rather than raised —
 * the guarded form of the eight unguarded selector lookups of the vanilla
 * sources (I12). A container that did not resolve degrades that one screen; the
 * remaining six and the whole input-context path are unaffected.
 *
 * The state machine holds `INITIAL_SCREEN` and shows nothing until `start()`.
 *
 * @param options Document, hosts, screens, ports, focus manager and sink. All
 *   are optional, so the router is constructible with no collaborator at all.
 * @returns The router, holding no listener until `attach` or `subscribe`.
 *
 * @example
 * ```ts
 * const router = createScreenRouter({ document });
 * const input = createInputManager({ context: router.context });
 * const controls = mountOnScreenControls({
 *   host: input,
 *   context: router.context,
 * });
 *
 * router.attach({ input, controls });
 * const stop = router.subscribe(engine.events);
 *
 * router.start();
 * router.send('beginRun', { seed: 'run-seed-2048' });
 * ```
 */
export function createScreenRouter(
  options: ScreenRouterOptions = {},
): ScreenRouter {
  const reporter = createSafeUiReporter(options.reporter ?? NOOP_UI_REPORTER);
  const owner = options.document ?? readAmbientDocument();
  const panel = resolveElement(
    options.settingsPanel,
    SETTINGS_PANEL_SELECTOR,
    owner,
  );
  const panelElement = asHtmlElement(panel);
  const trigger = resolveElement(
    options.settingsTrigger,
    SETTINGS_TRIGGER_SELECTOR,
    owner,
  );
  const gameRegion = resolveElement(
    options.gameRegion,
    GAME_REGION_SELECTOR,
    owner,
  );
  const rewardHost = resolveElement(
    options.rewardScreen,
    REWARD_SCREEN_SELECTOR,
    owner,
  );
  const rewardElement = asHtmlElement(rewardHost);
  const rewardCopy = options.rewardCopy ?? DEFAULT_REWARD_COPY;
  const screens: ScreenRegistry = options.screens ?? {};
  const run: RouterRunPort = options.run ?? {};
  const announcer = options.announcer ?? null;
  const preferences = options.preferences ?? null;

  /**
   * The terminal overlay. `undefined` in the options resolves the default
   * selector; an explicit `null` opts this router out of writing it, which is
   * the convention the sibling screen modules use for an outlet a caller
   * looked for and did not find.
   */
  const terminalOverlay =
    options.terminalOverlay === null
      ? null
      : resolveElement(
          options.terminalOverlay,
          TERMINAL_OVERLAY_SELECTOR,
          owner,
        );

  // Resolved ONCE, in one pass, and injected downward: a screen module never
  // performs a lookup of its own. The misses are collected as data rather than
  // raised, so five absent containers leave the sixth working.
  const resolution = resolveMounts<ScreenMountSpec, Element>(SCREEN_MOUNTS, {
    root: owner,
    reporter,
    context: REPORT_CONTEXT,
  });

  const screenHosts: Record<ScreenName, Element | null> = {
    runStart: resolution.elements.runStart,
    stage: resolution.elements.stage,
    stageClear: resolution.elements.stageClear,
    reward: resolution.elements.reward,
    won: resolution.elements.won,
    gameOver: resolution.elements.gameOver,
    runSummary: resolution.elements.runSummary,
  };

  // The reward container the legacy surface resolved wins for the `reward`
  // state, so both paths address one element.
  if (rewardHost !== null) {
    screenHosts.reward = rewardHost;
  }

  const overrides = options.screenHosts;

  if (overrides !== undefined) {
    for (const name of SCREEN_NAMES) {
      const supplied = overrides[name];

      if (supplied !== undefined) {
        screenHosts[name] = supplied;
      }
    }
  }

  const missing: MissingMount[] = resolution.missing.filter(
    (miss): boolean => screenHosts[miss.name as ScreenName] === null,
  );

  if (missing.length > 0) {
    reporter.log('warn', 'screen mount points are absent', {
      context: REPORT_CONTEXT,
      missing: formatMissingMounts(missing),
    });

    for (const miss of missing) {
      reporter.count(MOUNT_MISSING_METRIC, {
        context: REPORT_CONTEXT,
        screen: miss.name,
        selector: miss.selector,
        cause: miss.cause,
      });
    }
  }

  // Built here where the caller supplied none, and destroyed with this router.
  // A supplied manager belongs to its owner and is left alone.
  const ownedFocus = options.focus === undefined;
  const focus =
    options.focus ??
    createFocusManager({ reporter, context: REPORT_CONTEXT });

  const subscriptions: (() => void)[] = [];
  const listeners: RouterListener[] = [];
  const mounted = new Set<ScreenName>();

  let controls: RouterControlSurface | null = null;
  let input: RouterInputSurface | null = null;
  let trap: FocusTrapHandle | null = null;
  let settingsOpen = false;

  /** The offer currently on screen, empty while the screen is down. */
  let rewardCards: readonly RewardCard[] = [];
  let rewardTrap: FocusTrapHandle | null = null;
  let rewardOpen = false;

  /**
   * The terminal state the engine last committed.
   *
   * Held here rather than read back off the overlay's classes. This module and
   * its siblings subscribe to the same event, and the order they were
   * registered in is not a contract.
   */
  let terminal: TerminalScreenName | null = null;
  let lastScreen: RouterScreen = 'game';
  let destroyed = false;

  /* ------------------------------------------------------------------------
   * State-machine state
   * ---------------------------------------------------------------------- */

  let started = false;
  let tearingDown = false;

  /** Raised while an edge is being applied, so a sync cannot re-enter. */
  let transitioning = false;
  let currentScreen: ScreenName = options.initialScreen ?? INITIAL_SCREEN;
  let lastTrigger: RouterEventName = 'initial';
  let screenTrap: FocusTrapHandle | null = null;
  let lastCommit: StateCommitEvent | null = null;
  let lastStageStart: StageStartEvent | null = null;
  let lastStageEnd: StageEndEvent | null = null;
  let lastDrawn: readonly Relic[] = [];
  let lastOutcome: RunOutcome | null = null;
  let lastSummary: RunSummary | null = null;
  let previousSummary: RunSummary | null = null;

  const refuseAfterDestroy = (call: string): boolean => {
    if (!destroyed) {
      return false;
    }

    reporter.count(AFTER_DESTROY_METRIC, { call });

    return true;
  };

  /* ------------------------------------------------------------------------
   * Contained port reads
   * ---------------------------------------------------------------------- */

  /**
   * Calls one member of a port, reporting an absent member and a raise alike
   * and yielding the fallback for both.
   *
   * @param member Name carried into the report.
   * @param call The member, or `undefined` where the port omits it.
   * @param fallback Value yielded where the member is absent or raised.
   * @returns The member's value, or `fallback`.
   */
  const readPort = <T>(
    member: string,
    call: (() => T) | undefined,
    fallback: T,
  ): T => {
    if (call === undefined) {
      return fallback;
    }

    try {
      return call();
    } catch (error) {
      reporter.count(RUN_PORT_METRIC, { member, reason: 'raised' });
      reporter.error('a run-port read raised', error, {
        context: REPORT_CONTEXT,
        member,
      });

      return fallback;
    }
  };

  /**
   * Invokes one member of the run port for its effect.
   *
   * @param member Name carried into the report.
   * @param call The member, or `undefined` where the port omits it.
   * @returns Whether the member was present and returned.
   */
  const driveRun = (
    member: string,
    call: (() => unknown) | undefined,
  ): boolean => {
    if (call === undefined) {
      reporter.count(RUN_PORT_METRIC, { member, reason: 'absent' });

      return false;
    }

    try {
      call();

      return true;
    } catch (error) {
      reporter.count(RUN_PORT_METRIC, { member, reason: 'raised' });
      reporter.error('a run-port call raised', error, {
        context: REPORT_CONTEXT,
        member,
      });

      return false;
    }
  };

  const readReducedMotion = (): boolean =>
    readPort<boolean>(
      'isReducedMotion',
      preferences?.isReducedMotion?.bind(preferences),
      false,
    );

  const readSeed = (): string | null =>
    readPort<string | null>('seed', run.seed?.bind(run), null);

  const readRunId = (): string | null =>
    readPort<string | null>('runId', run.runId?.bind(run), null);

  /**
   * The stage index in force: the run port's answer, then the last commit's,
   * then the last stage start's, then zero.
   */
  const readStageIndex = (): number => {
    const fromPort = readPort<number | null>(
      'stageIndex',
      run.stageIndex?.bind(run),
      null,
    );

    if (fromPort !== null) {
      return fromPort;
    }

    return (
      lastCommit?.stage.stageIndex ?? lastStageStart?.stageIndex ?? 0
    );
  };

  /** The goal in force, from the same chain as the stage index. */
  const readStageGoal = (): StageGoal | null => {
    const fromPort = readPort<StageGoal | null>(
      'stageGoal',
      run.stageGoal?.bind(run),
      null,
    );

    return fromPort ?? lastCommit?.stage.goal ?? lastStageStart?.goal ?? null;
  };

  /**
   * The live board dimension, read at use time and never cached: a
   * board-mutating relic changes it mid-run, and ../run/run-state-store
   * reconciles the saved size against the configured one on load.
   */
  const readBoardSize = (): number | null =>
    lastCommit?.board.size ?? lastStageStart?.boardSize ?? null;

  /**
   * Measures the goal through `evaluateStageGoal` of ../config/stage-config,
   * which is the same evaluation the engine performs.
   *
   * @returns The measurement, or `null` where no goal or no board was in force,
   *   or the evaluation refused its input.
   */
  const readGoalProgress = (): StageGoalProgress | null => {
    const goal = readStageGoal();
    const commit = lastCommit;

    if (goal === null || commit === null) {
      return null;
    }

    try {
      return evaluateStageGoal(goal, {
        score: commit.score,
        highestTileValue: readHighestTileValue(commit.board),
      });
    } catch (error) {
      reporter.count(RUN_PORT_METRIC, {
        member: 'evaluateStageGoal',
        reason: 'raised',
      });
      reporter.error('the stage goal could not be measured', error, {
        context: REPORT_CONTEXT,
      });

      return null;
    }
  };

  const readSummary = (): RunSummary | null => {
    const fromPort = readPort<RunSummary | null>(
      'summary',
      run.summary?.bind(run),
      null,
    );

    return fromPort ?? lastSummary;
  };


  const readRelics = (): RelicCommitContext => {
    if (lastCommit !== null) {
      return lastCommit.relics;
    }

    // Forwarded in the order supplied, which is the pickup order the relic
    // registry keeps and the order one hook's handlers are dispatched in.
    return readPort<readonly PersistedRelic[]>(
      'relics',
      run.relics?.bind(run),
      EMPTY_RELICS,
    );
  };

  /* ------------------------------------------------------------------------
   * The terminal overlay
   * ---------------------------------------------------------------------- */

  /**
   * js/html_actuator.js L127-L133 `message(won)`, with the paragraph lookup
   * guarded: the source read `getElementsByTagName("p")[0]` with no check.
   *
   * @param state The terminal state whose class and copy are written.
   */
  const writeTerminalOverlay = (state: TerminalScreenName): void => {
    if (terminalOverlay === null) {
      return;
    }

    terminalOverlay.classList.add(TERMINAL_OVERLAY_CLASSES[state]);

    const verdict = resolveMount<HTMLElement>(TERMINAL_OVERLAY_TEXT_SELECTOR, {
      root: terminalOverlay,
      reporter,
      context: REPORT_CONTEXT,
      name: 'terminal-verdict',
    });

    if (verdict === null) {
      reporter.log('warn', 'the terminal overlay holds no verdict paragraph', {
        context: REPORT_CONTEXT,
        selector: TERMINAL_OVERLAY_TEXT_SELECTOR,
        screen: state,
      });
      reporter.count(OVERLAY_METRIC, { state, verdict: false });

      return;
    }

    verdict.textContent = TERMINAL_OVERLAY_COPY[state];
    reporter.count(OVERLAY_METRIC, { state, verdict: true });
  };

  /**
   * js/html_actuator.js L135-L139 `clearMessage()`, reached from that file's
   * `continueGame()` L38-L41 — the one path that served both
   * js/game_manager.js L19 `restart` and L26 `keepPlaying`.
   */
  const clearTerminalOverlay = (): void => {
    if (terminalOverlay === null) {
      return;
    }

    // IE only takes one value to remove at a time.
    terminalOverlay.classList.remove(TERMINAL_OVERLAY_CLASSES.won);
    terminalOverlay.classList.remove(TERMINAL_OVERLAY_CLASSES.gameOver);
    reporter.count(OVERLAY_METRIC, { state: 'cleared' });
  };

  /** Writes the overlay for a state, and clears it for every other. */
  const applyTerminalOverlay = (state: ScreenName | null): void => {
    if (state === 'won' || state === 'gameOver') {
      writeTerminalOverlay(state);

      return;
    }

    clearTerminalOverlay();
  };

  /* ------------------------------------------------------------------------
   * Per-screen context
   * ---------------------------------------------------------------------- */

  /**
   * Builds the context the entered or refreshed state's lifecycle receives.
   *
   * Every value is read at call time: the board dimension, the relic order and
   * the best score are never cached between contexts.
   *
   * @param screen State the context describes.
   * @param trigger Trigger that produced it.
   * @param refresh Whether this is an in-state refresh rather than an entry.
   * @param payload Data the trigger carried.
   * @returns The context for `screen`.
   */
  const contextFor = (
    screen: ScreenName,
    trigger: RouterEventName,
    refresh: boolean,
    payload: RouterTriggerPayload,
  ): ScreenContext => {
    const base = {
      trigger,
      reducedMotion: readReducedMotion(),
      host: screenHosts[screen],
      refresh,
    };

    // Carried exactly as the commit did: the raw stored string when a value is
    // present and the number `0` when it is absent. js/game_manager.js L95
    // re-read it from storage after the possible write, so the value here is
    // the persisted one.
    const bestScore: BestScoreValue = lastCommit?.bestScore ?? 0;
    const score = lastCommit?.score ?? 0;

    switch (screen) {
      case 'runStart':
        return {
          ...base,
          screen: 'runStart',
          seed: payload.seed ?? readSeed(),
          runId: readRunId(),
          previous: previousSummary,
        };

      case 'stage':
        return {
          ...base,
          screen: 'stage',
          score,
          bestScore,
          stageIndex: readStageIndex(),
          goal: readStageGoal(),
          goalProgress: readGoalProgress(),
          relics: readRelics(),
          boardSize: readBoardSize(),
          degraded: lastCommit?.degraded ?? false,
        };

      case 'stageClear':
        return {
          ...base,
          screen: 'stageClear',
          stageIndex: lastStageEnd?.stageIndex ?? readStageIndex(),
          cleared: payload.cleared ?? lastStageEnd?.cleared ?? true,
          score: lastStageEnd?.score ?? score,
          goal: readStageGoal(),
        };

      case 'reward':
        return {
          ...base,
          screen: 'reward',
          offers: payload.offers ?? rewardCards,
          drawn: payload.drawn ?? lastDrawn,
          stageIndex: readStageIndex(),
        };

      case 'won':
      case 'gameOver':
        return {
          ...base,
          screen,
          verdict: TERMINAL_VERDICTS_BY_SCREEN[screen],
          message: TERMINAL_OVERLAY_COPY[screen],
          overlayClass: TERMINAL_OVERLAY_CLASSES[screen],
          score,
          bestScore,
          cadence: OVERLAY_CADENCE,
        };

      case 'runSummary':
        return {
          ...base,
          screen: 'runSummary',
          summary: readSummary(),
          outcome: payload.outcome ?? lastOutcome,
          seed: readSeed(),
        };
    }
  };

  /* ------------------------------------------------------------------------
   * Screen-module lifecycle
   * ---------------------------------------------------------------------- */

  /**
   * Invokes one lifecycle member, contained.
   *
   * A raise is reported and counted and the transition continues: a screen that
   * fails to render leaves the machine consistent.
   *
   * @param screen State whose module is invoked.
   * @param member Member name carried into the report.
   * @param apply Invocation, called with the module.
   */
  const invokeScreen = (
    screen: ScreenName,
    member: string,
    apply: (module: ScreenModule) => void,
  ): void => {
    const module = screens[screen];

    if (module === undefined) {
      return;
    }

    try {
      apply(module);
    } catch (error) {
      reporter.count(SCREEN_MODULE_ERROR_METRIC, { screen, member });
      reporter.error('a screen lifecycle call raised', error, {
        context: REPORT_CONTEXT,
        screen,
        member,
        module: SCREEN_MODULES[screen],
      });
    }
  };

  /** Modules already mounted, so a module shared by two states mounts once. */
  const mountedModules = new Set<ScreenModule>();

  /**
   * Hands a screen its resolved container, once.
   *
   * A state whose container did not resolve is skipped and counted: that one
   * screen is degraded and the other six are unaffected.
   *
   * @param screen State to mount.
   */
  const mountScreen = (screen: ScreenName): void => {
    if (mounted.has(screen)) {
      return;
    }

    const host = screenHosts[screen];

    if (host === null) {
      reporter.count(MOUNT_MISSING_METRIC, {
        context: REPORT_CONTEXT,
        screen,
        selector: SCREEN_MOUNTS[screen],
        cause: 'no-match',
      });

      return;
    }

    mounted.add(screen);

    const module = screens[screen];

    if (module === undefined || mountedModules.has(module)) {
      return;
    }

    mountedModules.add(module);
    invokeScreen(screen, 'mount', (target): void => {
      target.mount?.(host);
    });
  };

  /* ------------------------------------------------------------------------
   * Focus, input context and announcements
   * ---------------------------------------------------------------------- */

  /**
   * The container focus is placed inside for a state.
   *
   * `stage` resolves to the game region: the designated target
   * `SCREEN_INITIAL_FOCUS` declares for it — `#board-a11y` — is a descendant of
   * that region and not of `#screen-hud`.
   */
  const focusContainerFor = (screen: ScreenName): Element | null =>
    screen === 'stage'
      ? (gameRegion ?? screenHosts.stage)
      : screenHosts[screen];

  const releaseScreenTrap = (): void => {
    const engaged = screenTrap;

    screenTrap = null;
    engaged?.release();
  };

  /**
   * Moves focus for the state just entered.
   *
   * A trapping state engages a trap; every other state places focus through
   * `focusInitial`. The `reward` state's trap is left to the reward surface
   * where that already holds one, so the container is never trapped twice.
   *
   * @param screen State just entered.
   */
  const placeFocus = (screen: ScreenName): void => {
    const container = focusContainerFor(screen);

    if (container === null) {
      return;
    }

    const reducedMotion = readReducedMotion();

    if (!SCREEN_TRAPS_FOCUS[screen]) {
      focus.focusInitial(screen, container, {
        reporter,
        context: REPORT_CONTEXT,
        reducedMotion,
      });

      return;
    }

    if (screen === 'reward' && rewardTrap !== null) {
      return;
    }

    screenTrap = focus.trap(container, {
      label: screen,
      context: REPORT_CONTEXT,
      reporter,
      reducedMotion,
      inertBackground:
        SCREEN_INERTS_BACKGROUND[screen] && gameRegion !== null
          ? [gameRegion]
          : undefined,
    });
  };

  /**
   * Shows the in-run HUD for the five in-run states and takes it down for the
   * two outside a run.
   *
   * Applied on every entry rather than only on the edges that cross the
   * boundary, so the HUD's shown state always matches the state in force.
   *
   * @param screen State being entered.
   */
  const applyHudVisibility = (screen: ScreenName): void => {
    const host = screenHosts.stage;

    if (host === null) {
      return;
    }

    setHidden(host, !SCREEN_SHOWS_HUD[screen]);
  };

  /** Whether this router is the party that suspended the input manager. */
  let inputSuspendedHere = false;

  /**
   * Adopts the input context of the state in force, and suspends the manager
   * for a state that holds a choice the run cannot proceed past.
   *
   * @param screen State in force.
   */
  const applyInputContext = (screen: ScreenName): void => {
    input?.setContext?.(SCREEN_INPUT_CONTEXTS[screen]);

    if (SCREEN_SUSPENDS_INPUT[screen]) {
      if (!inputSuspendedHere) {
        inputSuspendedHere = true;
        input?.suspend?.();
      }

      return;
    }

    if (inputSuspendedHere) {
      inputSuspendedHere = false;
      input?.resume?.();
    }
  };

  /**
   * Announces the state just entered.
   *
   * Only entries are announced, never a refresh, so a move does not re-read the
   * state it stayed in. The gameplay kinds — move, merge, spawn, stage clear
   * and the terminal verdicts — belong to ./a11y/engine-announcer, which
   * subscribes to the same events; nothing here restates them.
   *
   * @param screen State just entered.
   */
  const announceScreen = (screen: ScreenName): void => {
    if (announcer === null) {
      return;
    }

    const speak = announcer.announceText?.bind(announcer);

    if (speak === undefined) {
      return;
    }

    try {
      speak(SCREEN_ANNOUNCEMENTS[screen]);
    } catch (error) {
      reporter.error('a screen announcement raised', error, {
        context: REPORT_CONTEXT,
        screen,
      });
    }
  };


  /**
   * Forwards one gameplay announcement, where the caller opted in.
   *
   * @param build Builds the announcement, called only when it will be spoken.
   */
  const announceGameplay = (build: () => Announcement): void => {
    if (announcer === null || options.announceGameplay !== true) {
      return;
    }

    const speak = announcer.announce?.bind(announcer);

    if (speak === undefined) {
      return;
    }

    try {
      speak(build());
    } catch (error) {
      reporter.error('a gameplay announcement raised', error, {
        context: REPORT_CONTEXT,
      });
    }
  };

  /* ------------------------------------------------------------------------
   * The input-context view
   * ---------------------------------------------------------------------- */

  const screen = (): RouterScreen => {
    // Settings outranks the reward screen: it is opened from on top of
    // whatever is already showing.
    if (settingsOpen) {
      return 'settings';
    }

    if (rewardOpen) {
      return 'reward';
    }

    return terminal ?? 'game';
  };

  const context = (): InputContext => {
    // The document rule first, and its `'textEntry'` answer is final: a text
    // field holding focus outranks every screen.
    const documentContext =
      owner === null ? 'game' : resolveDocumentContext(owner);

    if (documentContext === 'textEntry') {
      return 'textEntry';
    }

    if (
      settingsOpen ||
      rewardOpen ||
      terminal !== null ||
      documentContext === 'overlay'
    ) {
      return 'overlay';
    }

    return 'game';
  };

  const refreshControls = (): void => {
    const resolved = context();

    reporter.count(REFRESH_METRIC, {
      context: resolved,
      screen: screen(),
      controls: controls !== null,
    });

    controls?.refresh();
  };

  /** Reports a screen change and re-applies the context to the controls. */
  const settle = (): void => {
    const next = screen();

    if (next !== lastScreen) {
      reporter.count(SCREEN_METRIC, { from: lastScreen, to: next });
      reporter.log('debug', 'The screen changed.', {
        from: lastScreen,
        to: next,
        context: context(),
      });
      lastScreen = next;
    }

    refreshControls();
  };

  /* ------------------------------------------------------------------------
   * Transitions
   * ---------------------------------------------------------------------- */

  const notify = (transition: RouterTransition): void => {
    // Copied first, so a listener that unsubscribes during the call does not
    // shorten the list being walked.
    for (const listener of [...listeners]) {
      try {
        listener(transition);
      } catch (error) {
        reporter.count(LISTENER_ERROR_METRIC, {
          from: transition.from,
          to: transition.to,
          trigger: transition.trigger,
        });
        reporter.error('a router state listener raised', error, {
          context: REPORT_CONTEXT,
          trigger: transition.trigger,
        });
      }
    }
  };

  /** Records what a trigger carried, so a later context can read it. */
  const capturePayload = (payload: RouterTriggerPayload): void => {
    if (payload.drawn !== undefined) {
      lastDrawn = payload.drawn;
    }

    if (payload.outcome !== undefined) {
      lastOutcome = payload.outcome;
    }
  };

  /**
   * Drives the run port for a trigger, before the state changes.
   *
   * @param trigger Trigger being applied.
   * @param from State the edge leaves.
   * @param payload Data the trigger carried.
   */
  const driveRunFor = (
    trigger: RouterEventName,
    from: ScreenName,
    payload: RouterTriggerPayload,
  ): void => {
    switch (trigger) {
      case 'beginRun':
        driveRun('startRun', run.startRun?.bind(run));

        return;

      case 'rewardSelected': {
        const relicId = payload.relicId;

        if (relicId !== undefined && run.resolveReward !== undefined) {
          const resolve = run.resolveReward.bind(run);

          driveRun('resolveReward', (): unknown => resolve(relicId));
        }

        driveRun('advanceStage', run.advanceStage?.bind(run));

        return;
      }

      case 'endRun':
      case 'acknowledge': {
        // js/game_manager.js carried no run outcome; the default is the verdict
        // of the state the edge leaves.
        const outcome: RunOutcome =
          payload.outcome ?? (from === 'gameOver' ? 'lost' : 'won');

        lastOutcome = outcome;

        if (run.endRun !== undefined) {
          const end = run.endRun.bind(run);

          driveRun('endRun', (): unknown => end(outcome));
        }

        lastSummary = readSummary();

        return;
      }

      case 'newRun':
        previousSummary = lastSummary;

        return;

      default:
        return;
    }
  };

  /** Hides the container the machine is leaving, where it owns one. */
  const leaveScreen = (from: ScreenName, to: ScreenName): void => {
    releaseScreenTrap();

    if (from === 'reward') {
      hideReward();
    }

    invokeScreen(from, 'leave', (target): void => {
      target.leave?.();
    });

    const fromHost = screenHosts[from];

    // The five overlay roots are mutually exclusive; the in-flow HUD is not one
    // of them and stays as it is. A state sharing a container with the state
    // being entered is not hidden and re-shown.
    if (
      SCREEN_IS_OVERLAY[from] &&
      fromHost !== null &&
      fromHost !== screenHosts[to]
    ) {
      setHidden(fromHost, true);
    }
  };

  /**
   * Shows a state's container, hands its module the context and moves focus.
   *
   * @param to State being entered.
   * @param trigger Trigger that produced the entry.
   * @param payload Data the trigger carried.
   * @returns The context the module received.
   */
  const enterScreen = (
    to: ScreenName,
    trigger: RouterEventName,
    payload: RouterTriggerPayload,
  ): ScreenContext => {
    mountScreen(to);
    setHidden(screenHosts[to], false);
    applyHudVisibility(to);

    // The offer is put on screen before the module is entered, so a module
    // reading the reward container finds the cards already in it.
    if (to === 'reward') {
      const offers = payload.offers ?? rewardCards;

      if (offers.length > 0 && !rewardOpen) {
        showReward(offers);
      }
    }

    const built = contextFor(to, trigger, false, payload);

    invokeScreen(to, 'enter', (target): void => {
      target.enter?.(built);
    });

    applyTerminalOverlay(to);
    applyInputContext(to);
    placeFocus(to);
    announceScreen(to);

    return built;
  };

  /**
   * Applies one edge.
   *
   * A self-transition is the in-state refresh path: the module is updated and
   * nothing is torn down, so focus is not moved and the state is not re-read.
   *
   * @param to State being entered.
   * @param trigger Trigger being applied.
   * @param payload Data the trigger carried.
   * @param flags `adopted` marks a state the imperative surface put on screen
   *   rather than one reached through `TRANSITIONS`; `drive` requests the run
   *   port be driven, which an edge taken in response to an engine event does
   *   not.
   * @returns The context the entered state received.
   */
  const transitionTo = (
    to: ScreenName,
    trigger: RouterEventName,
    payload: RouterTriggerPayload,
    flags: { readonly adopted?: boolean; readonly drive?: boolean } = {},
  ): ScreenContext => {
    const from = currentScreen;
    const adopted = flags.adopted ?? false;

    lastTrigger = trigger;
    capturePayload(payload);

    if (from === to) {
      const built = contextFor(to, trigger, true, payload);

      invokeScreen(to, 'update', (target): void => {
        target.update?.(built);
      });

      reporter.count(TRANSITION_METRIC, { from, to, trigger, refresh: true });
      notify({ from, to, trigger, context: built });
      settle();

      return built;
    }

    const outer = transitioning;

    transitioning = true;

    let built: ScreenContext;

    try {
      if (flags.drive === true) {
        driveRunFor(trigger, from, payload);
      }

      leaveScreen(from, to);
      currentScreen = to;
      built = enterScreen(to, trigger, payload);
    } finally {
      transitioning = outer;
    }

    reporter.count(TRANSITION_METRIC, {
      from,
      to,
      trigger,
      refresh: false,
      adopted,
    });
    reporter.log('debug', 'the screen state changed', {
      context: REPORT_CONTEXT,
      from,
      to,
      trigger,
      adopted,
    });
    notify({ from, to, trigger, context: built });
    settle();

    return built;
  };

  const start = (): ScreenName => {
    if (refuseAfterDestroy('start')) {
      return currentScreen;
    }

    if (started) {
      return currentScreen;
    }

    started = true;

    const target = currentScreen;
    const targetHost = screenHosts[target];

    for (const name of SCREEN_NAMES) {
      mountScreen(name);
    }

    // Every overlay root but the one being entered is taken down, so a cold
    // load cannot leave two of the five showing at once.
    for (const name of SCREEN_NAMES) {
      const host = screenHosts[name];

      if (SCREEN_IS_OVERLAY[name] && host !== null && host !== targetHost) {
        setHidden(host, true);
      }
    }

    lastTrigger = 'initial';

    const built = enterScreen(target, 'initial', {});

    reporter.count(TRANSITION_METRIC, {
      from: target,
      to: target,
      trigger: 'initial',
      refresh: false,
      adopted: false,
    });
    notify({ from: target, to: target, trigger: 'initial', context: built });
    settle();

    return target;
  };

  const send = (
    trigger: RouterEventName,
    payload: RouterTriggerPayload = {},
  ): boolean => {
    if (refuseAfterDestroy('send')) {
      return false;
    }

    if (trigger === 'initial') {
      if (started) {
        reporter.count(TRANSITION_REFUSED_METRIC, {
          from: currentScreen,
          trigger,
          reason: 'already-started',
        });

        return false;
      }

      start();

      return true;
    }

    if (!started) {
      reporter.count(NOT_STARTED_METRIC, { trigger });
      reporter.log('debug', 'a trigger arrived before the router started', {
        context: REPORT_CONTEXT,
        trigger,
      });

      return false;
    }

    const target = TRANSITIONS[currentScreen][trigger];

    if (target === undefined) {
      // Reported and refused. The state stands.
      reporter.count(TRANSITION_REFUSED_METRIC, {
        from: currentScreen,
        trigger,
        reason: 'no-edge',
      });
      reporter.log('debug', 'no edge is declared for this trigger', {
        context: REPORT_CONTEXT,
        from: currentScreen,
        trigger,
      });

      return false;
    }

    transitionTo(target, trigger, payload, { drive: true });

    return true;
  };

  /**
   * Brings the machine to a state the imperative surface put on screen.
   *
   * Walks the declared edges where the table reaches the state, and adopts it
   * directly where it does not. An adoption is counted as such and is not a
   * transition, so `TRANSITIONS` stays the whole edge set.
   *
   * @param to State to bring the machine to.
   * @param trigger Trigger recorded for the entry.
   */
  const syncMachine = (to: ScreenName, trigger: RouterEventName): void => {
    // Refused while an edge is being applied: `leaveScreen` takes the reward
    // screen down on its way out of `reward`, and that must not re-enter here.
    if (!started || tearingDown || transitioning || currentScreen === to) {
      return;
    }

    const direct = TRANSITIONS[currentScreen][trigger];

    if (direct === to) {
      transitionTo(to, trigger, {});

      return;
    }

    for (const step of ROUTER_TRIGGERS) {
      const next = TRANSITIONS[currentScreen][step];

      if (next === undefined) {
        continue;
      }

      if (TRANSITIONS[next][trigger] === to) {
        transitionTo(next, step, {});
        transitionTo(to, trigger, {});

        return;
      }
    }

    transitionTo(to, trigger, {}, { adopted: true });
  };

  /**
   * The trigger whose edge leaves the state in force for a target, and `null`
   * where the table declares none.
   *
   * @param target State to reach.
   * @returns The trigger, in `ROUTER_TRIGGERS` order.
   */
  const triggerTowards = (target: ScreenName): RouterEventName | null => {
    for (const step of ROUTER_TRIGGERS) {
      if (TRANSITIONS[currentScreen][step] === target) {
        return step;
      }
    }

    return null;
  };

  /**
   * Hands the state in force a fresh context through `update`.
   *
   * Applied as a self-transition, so a refresh reaches a state listener on the
   * same path an entry does and every context a screen module receives is a
   * context a listener receives.
   */
  const refreshCurrent = (): void => {
    if (!started || tearingDown) {
      return;
    }

    transitionTo(currentScreen, lastTrigger, {});
  };


  /* ------------------------------------------------------------------------
   * The settings dialog
   * ---------------------------------------------------------------------- */

  /**
   * Reflects the dialog's open state onto its trigger as `aria-expanded`.
   *
   * index.html declares `aria-haspopup="dialog"` and `aria-controls` on the
   * trigger; neither states whether the dialog is open. Written on every
   * transition rather than only on open.
   */
  const reflectTriggerExpansion = (open: boolean): void => {
    trigger?.setAttribute('aria-expanded', open ? 'true' : 'false');
  };

  // Closed at construction, so the attribute is present from the first
  // announcement rather than appearing only after the first open.
  reflectTriggerExpansion(false);

  const closeSettings = (): boolean => {
    if (refuseAfterDestroy('closeSettings')) {
      return false;
    }

    if (!settingsOpen) {
      return false;
    }

    settingsOpen = false;

    // Released BEFORE the panel is hidden: a trap restores focus to the element
    // it recorded, and restoring into a subtree that has just become `hidden`
    // places focus on the body instead.
    const engaged = trap;

    trap = null;
    engaged?.release();

    setHidden(panelElement ?? panel, true);
    reflectTriggerExpansion(false);
    reporter.count(SETTINGS_CLOSE_METRIC);

    if (panel !== null) {
      options.onSettingsClose?.(panel);
    }

    settle();

    return true;
  };

  const openSettings = (): boolean => {
    if (refuseAfterDestroy('openSettings')) {
      return false;
    }

    if (settingsOpen) {
      reporter.count(SETTINGS_REFUSED_METRIC, { reason: 'already-open' });

      return false;
    }

    if (panel === null) {
      reporter.count(SETTINGS_REFUSED_METRIC, { reason: 'absent' });
      reporter.log('warn', 'The settings dialog is absent.', {
        context: REPORT_CONTEXT,
        selector: SETTINGS_PANEL_SELECTOR,
      });

      return false;
    }

    // Shown BEFORE the body is rendered and before the trap engages: the panel
    // is `display: none` while hidden, and nothing inside a `display: none`
    // subtree can take focus.
    setHidden(panelElement ?? panel, false);

    // The body is rendered here, so the trap has something focusable to hold.
    options.onSettingsOpen?.(panel);

    const engaged = focus.trap(panel, {
      label: 'settings',
      context: REPORT_CONTEXT,
      reporter,
      restoreFocusTo: trigger === null ? null : (trigger as HTMLElement),
      onEscape: (): void => {
        closeSettings();
      },

      // The board and the HUD leave the accessibility tree for the dialog's
      // lifetime, which is what `aria-modal="true"` in index.html announces.
      inertBackground: gameRegion === null ? undefined : [gameRegion],
    });

    if (engaged === null) {
      // Nothing focusable inside: the dialog would announce itself modal and
      // then hold no focus, so it is taken back down rather than left open.
      setHidden(panelElement ?? panel, true);
      options.onSettingsClose?.(panel);
      reporter.count(SETTINGS_REFUSED_METRIC, { reason: 'no-focusable' });
      reporter.log('warn', 'The settings dialog held nothing focusable.', {
        context: REPORT_CONTEXT,
      });

      return false;
    }

    trap = engaged;
    settingsOpen = true;

    reflectTriggerExpansion(true);
    reporter.count(SETTINGS_OPEN_METRIC);
    settle();

    return true;
  };

  /* ------------------------------------------------------------------------
   * The reward screen
   * ---------------------------------------------------------------------- */

  /**
   * Builds one relic card.
   *
   * Every class name here is one style/_reward.scss already styles.
   *
   * @param doc Document the nodes are created in.
   * @param card The offer this element presents.
   * @param index Zero-based position, drawn as the digit `selectReward` binds.
   * @returns The list item, with its button already carrying `data-relic-id`.
   */
  const buildRewardCard = (
    doc: Document,
    card: RewardCard,
    index: number,
  ): Element => {
    const item = doc.createElement('li');

    item.className = 'reward-offer';

    const button = doc.createElement('button');

    button.type = 'button';
    button.className = 'relic-card';
    button.setAttribute('data-rarity', card.rarity);
    button.setAttribute('data-relic-id', card.id);
    button.setAttribute('data-offer-index', String(index));

    const header = doc.createElement('span');

    header.className = 'relic-card-header';

    const shortcut = doc.createElement('span');

    // The digit is decoration for the pointer user and a duplicate for the
    // screen-reader user, who already hears the name: `aria-hidden` keeps it
    // out of the announcement while leaving it on screen.
    shortcut.className = 'relic-card-shortcut';
    shortcut.setAttribute('aria-hidden', 'true');
    shortcut.textContent = String(index + 1);

    const name = doc.createElement('span');

    name.className = 'relic-card-name';
    name.textContent = card.name;

    header.append(shortcut, name);

    const meta = doc.createElement('span');

    meta.className = 'relic-card-meta';

    const rarity = doc.createElement('span');

    rarity.className = 'relic-card-rarity';
    rarity.textContent = rewardCopy.rarity(card.rarity);
    meta.append(rarity);

    if (card.charges !== undefined) {
      const charges = doc.createElement('span');

      charges.className = 'relic-card-charges';
      charges.textContent = rewardCopy.charges(card.charges);
      meta.append(charges);
    }

    const description = doc.createElement('span');

    description.className = 'relic-card-description';
    description.textContent = card.description;

    button.append(header, meta, description);

    if (card.hooks.length > 0) {
      const hooks = doc.createElement('span');

      hooks.className = 'relic-card-hooks';

      for (const hook of card.hooks) {
        const badge = doc.createElement('span');

        badge.className = 'relic-hook-badge';
        badge.textContent = hook;
        hooks.append(badge);
      }

      button.append(hooks);
    }

    // The accessible name is the whole card rather than just its heading: the
    // description is inside the button, so no separate label is needed.
    item.append(button);

    return item;
  };

  /** Resolves a pointer press to the card it landed on. */
  const readRewardPress = (event: Event): void => {
    const target = event.target;

    if (target === null || typeof target !== 'object') {
      return;
    }

    const closest = (target as { closest?: (s: string) => Element | null })
      .closest;

    if (typeof closest !== 'function') {
      return;
    }

    const button = closest.call(target as Element, '.relic-card');

    if (button === null) {
      return;
    }

    const relicId = button.getAttribute('data-relic-id');
    const chosen = rewardCards.find((card): boolean => card.id === relicId);

    if (chosen === undefined) {
      return;
    }

    chooseReward(chosen, 'pointer');
  };

  const hideReward = (): boolean => {
    if (!rewardOpen) {
      return false;
    }

    rewardOpen = false;

    // Released before the host is hidden, for the same reason the settings
    // dialog releases first: focus cannot be restored into a hidden subtree.
    const engaged = rewardTrap;

    rewardTrap = null;
    engaged?.release();

    if (rewardHost !== null) {
      rewardHost.removeEventListener('click', readRewardPress);
      setHidden(rewardElement ?? rewardHost, true);

      // Cleared on the way down rather than on the way up, leaving no offer
      // inside a hidden container.
      rewardHost.replaceChildren();
    }

    rewardCards = [];
    reporter.count(REWARD_CLOSE_METRIC);
    settle();

    // The machine follows the screen down where the screen was taken down from
    // outside an edge; a call made from inside one is refused by the guard.
    syncMachine('stage', 'rewardSelected');

    return true;
  };

  const showReward = (cards: readonly RewardCard[]): boolean => {
    if (refuseAfterDestroy('showReward')) {
      return false;
    }

    if (rewardHost === null) {
      reporter.count(REWARD_REFUSED_METRIC, { reason: 'absent' });
      reporter.log('warn', 'The reward screen is absent.', {
        context: REPORT_CONTEXT,
        selector: REWARD_SCREEN_SELECTOR,
      });

      return false;
    }

    if (cards.length === 0) {
      reporter.count(REWARD_REFUSED_METRIC, { reason: 'empty' });

      return false;
    }

    const doc = rewardHost.ownerDocument ?? owner;

    if (doc === null) {
      reporter.count(REWARD_REFUSED_METRIC, { reason: 'no-document' });

      return false;
    }

    // An open screen is taken down first, so a redraw replaces the offer rather
    // than stacking a second one behind the first.
    hideReward();

    const panelBody = doc.createElement('div');

    panelBody.className = 'reward-panel';

    const heading = doc.createElement('h2');

    heading.className = 'reward-heading';
    heading.textContent = rewardCopy.heading;

    const hint = doc.createElement('p');

    hint.className = 'reward-hint';
    hint.textContent = rewardCopy.hint;

    const list = doc.createElement('ul');

    // `list-style: none` removes the list semantics in several engines, so the
    // role is restated: the count of offers is what tells the player how many
    // choices there are.
    list.className = 'reward-offers';
    list.setAttribute('role', 'list');

    let index = 0;

    for (const card of cards) {
      list.append(buildRewardCard(doc, card, index));
      index += 1;
    }

    panelBody.append(heading, hint, list);

    rewardHost.replaceChildren(panelBody);

    // Shown before the trap engages: nothing inside a `display: none` subtree
    // can take focus.
    setHidden(rewardElement ?? rewardHost, false);

    const engaged = focus.trap(rewardHost, {
      label: 'reward',
      context: REPORT_CONTEXT,
      reporter,

      // Focus goes back to the BOARD, not to a trigger: the reward screen is
      // reached by clearing a stage rather than by pressing a control, so there
      // is no trigger to return to.
      restoreFocusTo: asHtmlElement(
        options.rewardRestoreFocusTo?.() ?? null,
      ),
      inertBackground: gameRegion === null ? undefined : [gameRegion],
    });

    if (engaged === null) {
      setHidden(rewardElement ?? rewardHost, true);
      rewardHost.replaceChildren();
      reporter.count(REWARD_REFUSED_METRIC, { reason: 'no-focusable' });

      return false;
    }

    rewardHost.addEventListener('click', readRewardPress);

    rewardTrap = engaged;
    rewardOpen = true;
    rewardCards = Object.freeze([...cards]);

    reporter.count(REWARD_OPEN_METRIC, { offers: rewardCards.length });
    settle();
    syncMachine('reward', 'stageEnd');

    return true;
  };

  /**
   * Reports a choice out and takes the screen down.
   *
   * The screen closes before the callback runs, so a handler that opens the
   * next screen is not fighting a trap still engaged on this one.
   */
  const chooseReward = (card: RewardCard, source: string): void => {
    reporter.count(REWARD_SELECT_METRIC, { relicId: card.id, source });

    if (started && !tearingDown && currentScreen === 'reward') {
      // The one edge out of `reward`, carrying the choice so the run port
      // applies it and the next stage starts.
      send('rewardSelected', { relicId: card.id });
    } else {
      hideReward();
    }

    options.onRewardSelect?.(card.id);
  };


  /* ------------------------------------------------------------------------
   * Engine events
   * ---------------------------------------------------------------------- */

  /** The direction of the move in flight, captured for the announcement. */
  let pendingDirection: 0 | 1 | 2 | 3 | null = null;

  /**
   * The successor to the vanilla actuation payload of js/game_manager.js
   * L91-L97.
   *
   * The board arrives BY REFERENCE and is neither cloned nor mutated here, and
   * `bestScore` is carried through exactly as the commit holds it.
   */
  const readCommit = (commit: StateCommitEvent): void => {
    lastCommit = commit;

    // The two board states of js/html_actuator.js L128, from the flags L91-L97
    // carried. `terminated` is the engine's own answer to whether play is
    // blocked — js/game_manager.js L30-L32 — so a continued win clears this
    // without the router tracking the acknowledgement itself.
    const next: TerminalScreenName | null = !commit.terminated
      ? null
      : commit.over
        ? 'gameOver'
        : commit.won
          ? 'won'
          : null;
    const changed = next !== terminal;

    if (changed) {
      terminal = next;

      // js/html_actuator.js L127-L133 on a terminal turn, and its L135-L139
      // through `continueGame()` L38-L41 on the turn that clears one.
      applyTerminalOverlay(next);
    }

    if (!started || tearingDown) {
      if (changed) {
        settle();
      }

      return;
    }

    if (changed && next !== null) {
      const towards = triggerTowards(next);

      if (towards !== null) {
        transitionTo(next, towards, {});

        return;
      }

      syncMachine(next, next === 'won' ? 'winReached' : 'noMovesAvailable');
      settle();

      return;
    }

    if (changed && currentScreen === 'won') {
      // Keep Going: the engine cleared `terminated`, so the board is playable
      // again and the one edge out of `won` back to `stage` is taken.
      transitionTo('stage', 'keepPlaying', {});

      return;
    }

    // The self-transition a refresh is applied as settles on its own.
    refreshCurrent();
  };

  /** `stage:start`, emitted once as a stage's board is prepared. */
  const readStageStart = (payload: StageStartEvent): void => {
    lastStageStart = payload;

    if (!started || tearingDown) {
      return;
    }

    if (currentScreen === 'stage') {
      transitionTo('stage', 'restart', {});

      return;
    }

    const towards = triggerTowards('stage');

    if (towards === null) {
      syncMachine('stage', 'restart');

      return;
    }

    transitionTo('stage', towards, {});
  };

  /**
   * `move:after`. The turn's terminal decision belongs to the commit that
   * follows it, so this refreshes the state in force and takes no edge of its
   * own beyond the `stage` self-transition.
   */
  const readMoveAfter = (payload: MoveAfterEvent): void => {
    const direction = pendingDirection;

    pendingDirection = null;

    announceGameplay((): Announcement => ({
      kind: 'move',
      direction: direction ?? 0,
      changed: payload.moved,
      score: payload.score,
    }));

    if (!started || tearingDown) {
      return;
    }

    if (currentScreen === 'stage' && payload.moved) {
      transitionTo('stage', 'move', {});

      return;
    }

    refreshCurrent();
  };

  /** `stage:end`, which has no vanilla analogue. */
  const readStageEnd = (payload: StageEndEvent): void => {
    lastStageEnd = payload;

    announceGameplay((): Announcement => ({
      kind: 'stageClear',
      stageIndex: payload.stageIndex,
      cleared: payload.cleared,
    }));

    if (!started || tearingDown) {
      return;
    }

    // stage -> stageClear -> reward, the two edges AAP Figure 6 declares
    // between the goal being met and the offer being presented.
    if (currentScreen === 'stage') {
      transitionTo('stageClear', 'stageGoalMet', { cleared: payload.cleared });
    }

    if (currentScreen === 'stageClear') {
      transitionTo('reward', 'stageEnd', { cleared: payload.cleared });
    }
  };

  /* ------------------------------------------------------------------------
   * The returned router
   * ---------------------------------------------------------------------- */

  return Object.freeze({
    context,
    screen,
    isSettingsOpen: (): boolean => settingsOpen,
    openSettings,
    closeSettings,
    showReward,
    hideReward,
    isRewardOpen: (): boolean => rewardOpen,

    start,
    current: (): ScreenName => currentScreen,
    isStarted: (): boolean => started,
    send,
    go: send,
    can: (candidate: RouterEventName): boolean =>
      candidate === 'initial'
        ? !started
        : started && TRANSITIONS[currentScreen][candidate] !== undefined,
    hostFor: (name: ScreenName): Element | null => screenHosts[name] ?? null,
    missingMounts: (): readonly MissingMount[] => Object.freeze([...missing]),

    attach(surfaces: ScreenRouterSurfaces): void {
      if (refuseAfterDestroy('attach')) {
        return;
      }

      if (surfaces.controls !== undefined) {
        controls = surfaces.controls;
      }

      const attached = surfaces.input ?? null;

      if (attached !== null) {
        input = attached;

        subscriptions.push(
          attached.on('openSettings', (): void => {
            openSettings();
          }),
          attached.on('closeSettings', (): void => {
            closeSettings();
          }),

          // `cancel` is Escape everywhere. The trap's own `onEscape` covers the
          // press that lands inside the dialog; this covers the press the
          // keyboard resolved before focus reached it.
          //
          // The reward screen is deliberately NOT cancellable: the stage is
          // cleared and a relic must be taken, so Escape has nothing to fall
          // back to.
          attached.on('cancel', (): void => {
            closeSettings();
          }),

          // The digit bindings of ../input/keymap publish a zero-based index.
          // An index naming no card is ignored rather than clamped, so a press
          // of `3` against a two-card offer chooses nothing instead of silently
          // choosing the last one.
          attached.on('selectReward', (index: number): void => {
            if (!rewardOpen) {
              return;
            }

            const chosen = rewardCards[index];

            if (chosen === undefined) {
              reporter.count(REWARD_REFUSED_METRIC, {
                reason: 'no-such-offer',
                index,
              });

              return;
            }

            chooseReward(chosen, 'keyboard');
          }),
        );

        // The context in force is pushed as soon as the surface is known, so a
        // manager attached mid-flow is not left interpreting keys in the
        // context of a screen that is no longer showing.
        if (started) {
          applyInputContext(currentScreen);
        }
      }

      // Applied at once, so the controls carry the context in force rather than
      // whichever one held while they were being generated.
      settle();
    },

    subscribe(target: EngineEvents | RouterListener): EngineEventSubscription {
      if (refuseAfterDestroy('subscribe')) {
        return (): void => {
          // Nothing was registered.
        };
      }

      if (typeof target === 'function') {
        listeners.push(target);

        let removed = false;

        return (): void => {
          if (removed) {
            return;
          }

          removed = true;

          const at = listeners.indexOf(target);

          if (at !== -1) {
            listeners.splice(at, 1);
          }
        };
      }

      // Subscribed through the append-only `on` ported from
      // js/keyboard_input_manager.js L18-L32: a registration here displaces no
      // registration already made.
      const releases: (() => void)[] = [
        target.on('state:commit', readCommit),
        target.on('stage:start', readStageStart),
        target.on('move:after', readMoveAfter),
        target.on('stage:end', readStageEnd),

        // Read-only: `cancelled` is never written from here, so no move is
        // vetoed by the screen flow. The direction is carried here; the
        // `move:after` payload holds none.
        target.on('move:before', (payload): void => {
          pendingDirection = payload.direction;
        }),

        target.on('tile:merge', (payload: TileMergeEvent): void => {
          announceGameplay((): Announcement => ({
            kind: 'merge',
            resultValue: payload.resultValue,
            scoreDelta: payload.scoreDelta,
          }));
        }),

        target.on('tile:spawn', (payload: TileSpawnEvent): void => {
          announceGameplay((): Announcement => ({
            kind: 'spawn',
            value: payload.value,
            position:
              payload.position === undefined
                ? undefined
                : { x: payload.position.x, y: payload.position.y },
          }));
        }),
      ];

      for (const release of releases) {
        subscriptions.push(release);
      }

      let released = false;

      return (): void => {
        if (released) {
          return;
        }

        released = true;

        for (const release of releases) {
          release();
        }
      };
    },

    refresh(): void {
      if (refuseAfterDestroy('refresh')) {
        return;
      }

      if (started && !tearingDown) {
        // The self-transition carries the context and settles the controls.
        refreshCurrent();

        return;
      }

      refreshControls();
    },

    destroy(): void {
      if (destroyed) {
        return;
      }

      tearingDown = true;

      closeSettings();
      hideReward();
      releaseScreenTrap();

      if (inputSuspendedHere) {
        inputSuspendedHere = false;
        input?.resume?.();
      }

      destroyed = true;

      for (const release of subscriptions) {
        release();
      }

      subscriptions.length = 0;
      listeners.length = 0;

      for (const module of mountedModules) {
        try {
          module.unmount?.();
        } catch (error) {
          reporter.count(SCREEN_MODULE_ERROR_METRIC, { member: 'unmount' });
          reporter.error('a screen unmount raised', error, {
            context: REPORT_CONTEXT,
          });
        }
      }

      mountedModules.clear();
      mounted.clear();
      controls = null;
      input = null;

      if (ownedFocus) {
        focus.destroy();
      }
    },
  });
}
