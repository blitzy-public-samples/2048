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
// Traceability rows in docs/TRACEABILITY_MATRIX.md, one per construct:
//   TR-ROUTER-01  js/html_actuator.js L127-L133  the verdict class and copy,
//                                                carried by
//                                                `TERMINAL_OVERLAY_CLASSES`
//                                                and `TERMINAL_OVERLAY_COPY`
//   TR-ROUTER-02  js/html_actuator.js L135-L139  `clearMessage()`, both class
//                                                removals kept separate
//   TR-ROUTER-03  js/html_actuator.js L38-L41    `continueGame()`, reached
//                                                from the one path serving
//                                                restart and keep-playing
//   TR-ROUTER-04  js/html_actuator.js L2-L5      the four unguarded
//                                                `querySelector` lookups, now
//                                                guarded resolutions
//   TR-ROUTER-05  js/game_manager.js L9-L11      the three fixed input
//                                                subscriptions, generalised
//                                                into the input context
//   TR-ROUTER-06  js/game_manager.js L30-L32     `isGameTerminated()`, read
//                                                off the commit's own
//                                                `terminated`
//   TR-ROUTER-07  js/game_manager.js L91-L97     the actuation payload,
//                                                arriving as `state:commit`
//   TR-ROUTER-08  js/keyboard_input_manager.js L18-L32
//                                                append-only `on` and
//                                                synchronous in-order `emit`,
//                                                relied on by every
//                                                subscription here
//   TR-ROUTER-09  style/main.scss L234-L235      the overlay cadence, read
//                                                from `OVERLAY_CADENCE`
//   TR-ROUTER-10  style/main.scss L103, L205     the z-index ceiling of 100,
//                                                extended by `SCREEN_LAYERS`
//   TR-ROUTER-11  target-only row                the seven-state machine:
//                                                `SCREEN_NAMES`,
//                                                `TRANSITIONS` and the
//                                                per-state tables
//   TR-ROUTER-12  target-only row                the screen lifecycle, the
//                                                per-state `ScreenContext`
//                                                union and the focus, trap,
//                                                inerting and announcement
//                                                ownership
// Decision rows in docs/DECISION_LOG.md:
//   DL-ROUTER-01 .. DL-ROUTER-38
//
// This module reads no storage, consumes no randomness and draws no board.
// It renders no reward card either: `SCREEN_MODULES` names the module that
// renders each state, and this module drives that module's lifecycle.
//
// Decisions: DL-ROUTER-01, DL-ROUTER-02, DL-ROUTER-03 (docs/DECISION_LOG.md).

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
import {
  FOCUS_INITIAL_SELECTOR,
  SCREEN_INITIAL_FOCUS,
  createFocusManager,
} from './a11y/focus-manager';
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

/**
 * Counter raised for each `stage:end` whose goal was NOT met.
 *
 * Its own series rather than a detail on the transition counter, because the
 * event takes no transition: an uncleared stage end used to reach the reward
 * screen anyway, and the series is what makes the corrected refusal visible.
 */
const STAGE_UNCLEARED_METRIC = 'ui.router.stage.uncleared';

/**
 * Counter raised for each entry that adopted a trap a screen module had already
 * engaged over the state's container, rather than stacking a second one.
 *
 * Its own series because the two arrangements are indistinguishable from the
 * outside until one of them fails: a stacked pair contains focus perfectly well
 * and only misbehaves when the inner trap releases, so this is what shows that
 * one container carries one trap.
 */
const TRAP_ADOPTED_METRIC = 'ui.router.trap.adopted';

/** Counter raised for each applied state-machine transition. */
const TRANSITION_METRIC = 'ui.router.transition';

/** Counter raised for each trigger the table declares no edge for. */
const TRANSITION_REFUSED_METRIC = 'ui.router.transition.refused';

/** Counter raised for each screen mount point the document did not supply. */
const MOUNT_MISSING_METRIC = 'ui.router.mount.missing';

/** Counter raised for each screen-module lifecycle call that raised. */
const SCREEN_MODULE_ERROR_METRIC = 'ui.router.screen.error';

/** Counter raised at construction for each state carrying no screen module. */
const SCREEN_MODULE_MISSING_METRIC = 'ui.router.screen.missing';

/** Counter raised for each state-listener call that raised. */
const LISTENER_ERROR_METRIC = 'ui.router.listener.error';

/** Counter raised for each injected option callback that raised. */
const CALLBACK_ERROR_METRIC = 'ui.router.callback.error';

/**
 * Counter raised for each `attach()` or `subscribe()` call that named the
 * source already attached, and for each one that replaced a different source.
 */
const ATTACHMENT_METRIC = 'ui.router.attachment';

/** Counter raised for each run-port call that raised or was unavailable. */
const RUN_PORT_METRIC = 'ui.router.run.unavailable';

/** Counter raised when the machine is driven before `start`. */
const NOT_STARTED_METRIC = 'ui.router.not_started';

/** Counter raised for each action the screen in force does not authorize. */
const ACTION_REFUSED_METRIC = 'ui.router.action.refused';

/** Counter raised for each terminal-overlay write and clear. */
const OVERLAY_METRIC = 'ui.router.overlay';

/** The seven screen states, in the order a run visits them. */
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
 * `initial` is the cold-load trigger and is applied by `start`; the twelve
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
 * The state a trigger's edge leads to, and `undefined` where the state in force
 * declares none.
 *
 * READS OWN PROPERTIES ONLY. Each entry of `TRANSITIONS` is an ordinary object
 * literal and therefore inherits from `Object.prototype`, so a plain index
 * read answered `Object.prototype.toString` — a function, and therefore truthy —
 * for `edgeFor(screen, 'toString')`, and the caller then transitioned to a
 * function as though it were a state name. Every edge lookup in this module goes
 * through here, so no reader can reintroduce that. DL-ROUTER-19.
 *
 * @param screen State whose edges are read.
 * @param trigger Trigger to resolve, which need not be a declared one.
 * @returns The target state, or `undefined`.
 */
export function edgeFor(
  screen: ScreenName,
  trigger: RouterEventName,
): ScreenName | undefined {
  const edges: ScreenTransitions = TRANSITIONS[screen];

  if (!Object.prototype.hasOwnProperty.call(edges, trigger)) {
    return undefined;
  }

  const target: unknown = edges[trigger];

  // Narrowed rather than trusted: an own property whose value is not a screen
  // name is no more usable than an inherited one.
  return isScreenName(target) ? target : undefined;
}

/**
 * The transition table: the twelve state-keyed edges of AAP Figure 6, keyed by
 * state and then by trigger. The thirteenth edge is the cold load, whose
 * `initial` trigger resolves to `INITIAL_SCREEN`.
 *
 * A trigger absent from the state in force takes no edge: it is reported and
 * the state stands. This table is the whole edge set; there is no imperative
 * state setter. Decision DL-ROUTER-04.
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
 * the flow is exercisable with none of them present. Decision DL-ROUTER-05.
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
 * movement resolves in; every other state is an overlay. One of the per-state
 * tables keyed by every declared state. Decision DL-ROUTER-06.
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
 * Every state index.html declares `role="dialog" aria-modal="true"` on is
 * trapped here, and every state trapped here is inerted by
 * `SCREEN_INERTS_BACKGROUND` — the two tables carry the same five states, so
 * a state cannot announce itself modal and leave the background reachable.
 * `stage` is the one in-flow state and traps nothing. Decision DL-ROUTER-25.
 *
 * The retained `.game-message` of js/html_actuator.js L127-L139 lies inside the
 * inerted background for the two terminal states, so its controls are not a
 * second operable surface: the container inside `.screen-layer` carries the
 * actions.
 */
export const SCREEN_TRAPS_FOCUS = Object.freeze({
  runStart: true,
  stage: false,
  stageClear: true,
  reward: true,
  won: true,
  gameOver: true,
  runSummary: true,
} satisfies Readonly<Record<ScreenName, boolean>>);

/**
 * The states rendered as one of the mutually exclusive overlay roots, of which
 * index.html unhides exactly one at a time.
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
 * indicator and the active-relic tray are down for both. The five in-run
 * states keep it up, including the four that put an overlay over it.
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
 * The states whose trap marks the background inert.
 *
 * The background is whatever the caller supplies as `backgroundRegions` — the
 * whole page shell rather than the game region alone, so a screen reader's
 * virtual cursor cannot reach the heading, the board or the footer behind a
 * modal state. Only a trapping state reads this, and the two tables carry the
 * same five states. Decision DL-ROUTER-25.
 */
export const SCREEN_INERTS_BACKGROUND = Object.freeze({
  runStart: true,
  stage: false,
  stageClear: true,
  reward: true,
  won: true,
  gameOver: true,
  runSummary: true,
} satisfies Readonly<Record<ScreenName, boolean>>);

/* --------------------------------------------------------------------------
 * 2.1 Action authorization — the one decision every modality resolves against
 * ----------------------------------------------------------------------- */

/**
 * Every action this router authorizes, in the order the flow reaches them.
 *
 * These are the `InputAction` names of ../input/keymap that mutate the board,
 * the run or the dialog. `InputContext` has three members and six of the seven
 * screens resolve to `'overlay'`, so the context alone cannot say WHICH overlay
 * a press belongs to; this vocabulary plus `ACTION_SCREENS` below is the exact
 * answer, and `authorizes()` is the single place it is decided. Decision
 * DL-ROUTER-18.
 */
export const AUTHORIZED_ACTIONS = Object.freeze([
  'move',
  'restart',
  'keepPlaying',
  'startRun',
  'selectReward',
  'activateRelic',
  'continueStage',
  'endRun',
  'openSettings',
  'closeSettings',
] as const);

/** Union of the names in `AUTHORIZED_ACTIONS`. */
export type AuthorizedAction = (typeof AUTHORIZED_ACTIONS)[number];

/**
 * Narrows a value to an authorized action name.
 *
 * @param value Candidate action.
 * @returns Whether `value` is one of `AUTHORIZED_ACTIONS`.
 */
export function isAuthorizedAction(value: unknown): value is AuthorizedAction {
  return AUTHORIZED_ACTIONS.some((action): boolean => action === value);
}

/**
 * The screen an authorization decision is made against: the state machine's own
 * name for it, plus `'settings'` for the dialog that opens over any of them.
 *
 * `'settings'` is a screen HERE and not in `SCREEN_NAMES` because the dialog is
 * not a state of AAP Figure 6 — it has no edge in `TRANSITIONS` — yet it is the
 * topmost modal while it is open, and a modal that does not own an action must
 * refuse it.
 */
export type AuthorizationScreen = ScreenName | 'settings';

/**
 * The exact screens each action is authorized in.
 *
 * Every entry but three mirrors `TRANSITIONS`: an action that drives a trigger
 * is authorized exactly where that trigger has an outgoing edge — `move` and
 * `restart` from `stage`, `startRun` from `runStart`, `continueStage` from
 * `stageClear`, `selectReward` from `reward`, `keepPlaying` and `endRun` from
 * `won`. The three that do not:
 *
 *   `restart`        widened beyond its `stage` edge to `runStart`, `won`,
 *                    `gameOver` and `runSummary`, because
 *                    `LEGACY_CONTROL_BINDINGS` of ../input/on-screen-controls
 *                    declares `.retry-button` in the `'overlay'` context on
 *                    purpose — that is the control js/html_actuator.js L51
 *                    offered on a terminal turn. It is absent from `reward`:
 *                    the stage is cleared and a relic must be taken.
 *   `activateRelic`  drives no trigger; the relic tray is part of the board, so
 *                    it is authorized in `stage` alone.
 *   `openSettings`   drives no trigger and is reachable from every state, which
 *                    is what `contexts: ['game', 'overlay']` in
 *                    ../input/keymap declares. It is absent from `'settings'`,
 *                    which is the `'already-open'` refusal stated as data.
 *
 * `'settings'` appears for `closeSettings` and for nothing else, so while the
 * dialog is topmost EVERY other action is refused by table lookup rather than
 * by a special case.
 */
export const ACTION_SCREENS = Object.freeze({
  move: Object.freeze<AuthorizationScreen[]>(['stage']),
  restart: Object.freeze<AuthorizationScreen[]>([
    'runStart',
    'stage',
    'won',
    'gameOver',
    'runSummary',
  ]),
  keepPlaying: Object.freeze<AuthorizationScreen[]>(['won']),
  startRun: Object.freeze<AuthorizationScreen[]>(['runStart']),
  selectReward: Object.freeze<AuthorizationScreen[]>(['reward']),
  activateRelic: Object.freeze<AuthorizationScreen[]>(['stage']),
  continueStage: Object.freeze<AuthorizationScreen[]>(['stageClear']),
  endRun: Object.freeze<AuthorizationScreen[]>(['won']),
  openSettings: Object.freeze<AuthorizationScreen[]>([
    'runStart',
    'stage',
    'stageClear',
    'reward',
    'won',
    'gameOver',
    'runSummary',
  ]),
  closeSettings: Object.freeze<AuthorizationScreen[]>(['settings']),
} satisfies Readonly<Record<AuthorizedAction, readonly AuthorizationScreen[]>>);

/**
 * The trigger each action drives, for the actions that drive one.
 *
 * Declared so `ACTION_SCREENS` can be checked against `TRANSITIONS` rather than
 * merely resembling it: for every entry here, the action's authorized screens
 * are the screens whose outgoing edges include the trigger, except where the
 * comment on `ACTION_SCREENS` states a widening.
 */
export const ACTION_TRIGGERS = Object.freeze({
  move: 'move',
  restart: 'restart',
  startRun: 'beginRun',
  selectReward: 'rewardSelected',
  continueStage: 'stageEnd',
  keepPlaying: 'keepPlaying',
  endRun: 'endRun',
} satisfies Readonly<Partial<Record<AuthorizedAction, RouterEventName>>>);

/* ==========================================================================
 * 3. The terminal overlay, subsumed
 * ========================================================================== */

/** Selector the terminal overlay is found at, as index.html declares it. */
export const TERMINAL_OVERLAY_SELECTOR = '.game-message';

/**
 * Selector the overlay's verdict paragraph is found at, inside the overlay.
 */
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
 * `motion.fadeIn.delay` is `transitionSpeed * 12`, the `$transition-speed *
 * 12` of style/main.scss L234, and `duration` is that rule's 800. `total` is
 * the interval an assertion on the overlay has to clear.
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
 * The diagnostics slot is absent from this table: it sits above all three and
 * creates its own host, and no screen here reaches or shadows it.
 */
export const SCREEN_LAYERS = Object.freeze({
  hud: zIndex.hud,
  screenOverlay: zIndex.screenOverlay,
  modal: zIndex.modal,
} as const);

/**
 * The verdict each terminal state announces, as ./a11y/live-region names it.
 */
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

/**
 * The lifecycle every module under src/ui/screens/ implements, so the seven
 * states are driven through one shape.
 *
 * Each call is invoked defensively: a member a screen omits is skipped, and a
 * member that raises is reported and the transition continues.
 */
export interface Screen {
  /**
   * Receives the resolved container. Called once, before the first `enter`.
   */
  mount(host: Element): void;

  /** Called on every entry to the state, after `mount`. */
  enter(context: ScreenContext): void;

  /** Called for each refresh while the state stands. */
  update(context: ScreenContext): void;

  /** Called on every exit from the state. */
  leave(): void;

  /** Called once, when the router is destroyed. */
  unmount(): void;

  /**
   * The line this screen wants read on entry, or `null` to be announced under
   * `SCREEN_ANNOUNCEMENTS`.
   *
   * THE ROUTER IS THE ONE SPEAKER of an entry announcement, so a screen with
   * something richer to say — the offer it is presenting, the run it is
   * summarising — supplies the words here and announces nothing itself.
   * Consulted on entry only, never on a refresh. Decision DL-ROUTER-26.
   *
   * @param context The context this entry carries.
   * @returns The line to read, or `null`.
   */
  announcement?(context: ScreenContext): string | null;
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
   * the raw stored string when a value is present and the number `0` when it
   * is absent.
   */
  readonly bestScore: BestScoreValue;

  /** Zero-based stage index. */
  readonly stageIndex: number;

  /** The goal in force, and `null` before a stage has declared one. */
  readonly goal: StageGoal | null;

  /**
   * Measured progress against `goal`, and `null` where it was unmeasurable.
   */
  readonly goalProgress: StageGoalProgress | null;

  /** The active relics in pickup order, forwarded in the order supplied. */
  readonly relics: RelicCommitContext;

  /**
   * The live board dimension, read from the commit or the stage start on every
   * context and never cached, so a board-mutating relic is observed.
   */
  readonly boardSize: number | null;

  /**
   * Whether the commit reported its terminal or stage status unestablished.
   */
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

/**
 * Everything a screen's lifecycle receives: the per-state shapes as one union,
 * discriminated by `screen`, built fresh per entry. Decision DL-ROUTER-07.
 */
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
   * Registers a listener for the reward digits, whose payload is the
   * zero-based index of the offer the press addresses.
   */
  on(event: 'selectReward', listener: (index: number) => void): () => void;

  /** The keymap in force, where the surface exposes one. */
  getKeymap?(): Keymap;

  /** Adopts the context of the state in force. */
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

/**
 * The run lifecycle this router reads and drives. Every member is optional: a
 * member the port omits yields a neutral value and is counted, so the flow
 * runs with no run controller attached at all.
 *
 * `startRun` takes no argument here. The `RunController.startRun(engine)` of
 * ../run/run-controller is adapted to this shape by the composition root,
 * which is what holds the engine.
 */
export interface RouterRunPort {
  /** The run seed, verbatim. */
  seed?(): string;
  runId?(): string;

  /**
   * Whether a run is OPEN: one the player started, or one resumed from storage.
   *
   * Read before the `runStart -> stage` edge is taken from an engine event. A
   * cold load with no run to resume opens no board, so a `stage:start` reaching
   * `runStart` while this reports `false` is refused and the flow waits for the
   * begin-run action. Absent, a run is assumed open, which is the behaviour of
   * a composition that opens its board itself. Decision DL-ROUTER-12.
   */
  isRunActive?(): boolean;

  /**
   * The offer standing, as the reward screen shows it. Read when the `reward`
   * state is entered without one on the trigger's payload.
   */
  offers?(): readonly RewardCard[];

  /** Zero-based index of the stage in force. */
  stageIndex?(): number;
  stageGoal?(): StageGoal;

  /** Fraction of the goal reached, within the closed interval [0, 1]. */
  goalProgress?(): number;

  /** The held relics in pickup order. */
  relics?(): readonly PersistedRelic[];

  /**
   * The run in progress, projected as a summary. LIVE, so it describes whatever
   * run the port is attached to right now — which after `endRun` is the fresh
   * run that replaced the finished one, not the finished one.
   */
  summary?(): RunSummary;

  /**
  currentOffer?(): readonly RewardCard[];

  /**
   * The projection the controller retained when a run ENDED, where it has one.
   *
   * Read before the live `summary()`, because a controller that has closed a run
   * out describes its replacement from that point on. DL-ROUTER-37.
   */
  lastSummary?(): RunSummary | null;

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
   * returns to it on close.
   */
  readonly settingsTrigger?: Element | string | null;

  /**
   * The game region, as an element or a selector. Focus for the `stage` state
   * is placed inside it. Defaults to `GAME_REGION_SELECTOR`.
   */
  readonly gameRegion?: Element | string | null;

  /**
   * The containers made inert while a modal state or the settings dialog holds
   * focus, as elements or selectors.
   *
   * THE WHOLE BACKGROUND, not the game region alone: everything the page shows
   * behind the dialog belongs here, and the screen containers and the live
   * region must be left out of it. Defaults to `[gameRegion]`, which is what a
   * caller supplying nothing gets. Decision DL-ROUTER-25.
   */
  readonly backgroundRegions?: readonly (Element | string | null)[];

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
   * Called with the identifier of the card the player chose, and REPORTS BACK
   * whether the choice was accepted.
   *
   * The router neither validates nor applies a choice: ../run/run-controller
   * owns the reward transaction. `false` means the transaction refused it, and
   * the `rewardSelected` edge is not taken, so the offer stays on screen. A
   * handler returning nothing is read as acceptance. Decision DL-ROUTER-13.
   */
  readonly onRewardSelect?: (relicId: string) => boolean | void;

  /**
   * Resolves where focus returns to when the reward screen closes.
   *
   * A FUNCTION, not an element. The board's parallel accessibility layer uses
   * a roving tab stop, so the element that can take focus is whichever cell
   * currently carries `tabindex="0"`. Called once per open, just before the
   * trap engages.
   *
   * Absent — or returning `null` — leaves the trap's own fallback in
   * charge, which restores to whatever held focus before the screen opened.
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
   * `TERMINAL_OVERLAY_SELECTOR`.
   */
  readonly terminalOverlay?: Element | string | null;

  /** State this router starts in. Defaults to `INITIAL_SCREEN`. */
  readonly initialScreen?: ScreenName;
}

/**
 * The reward screen's own prose: the two strings that name the offer.
 *
 * THE PANEL'S CHROME, AND NOTHING ON A CARD. A rarity renderer and a charge
 * renderer used to sit here too, for the cards this router built itself; the
 * cards are drawn by ../ui/components/relic-card.ts now and `defaultRelicCardCopy`
 * of that module declares both, so keeping a second pair here left two
 * declarations of one string with only one of them reachable. DL-ROUTER-13.
 */
export interface RewardCopy {
  /** The offer's heading, which also names the reward dialog. */
  readonly heading: string;

  /** The line under the heading. */
  readonly hint: string;
}

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

  /** Whether `start` has been called. */
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

  /**
   * Every state the `screens` registry carries no module for, in `SCREEN_NAMES`
   * order.
   *
   * A production composition registers all seven and this answers empty; an
   * isolated test registers the one it exercises and this names the rest. It is
   * the assertion a composition root makes about itself, because a state with
   * no module shows an empty container and no type notices. DL-ROUTER-08.
   */
  missingScreens(): readonly ScreenName[];

  /* ---- The input-context view ---- */

  /** The screen in force, as the input context sees it. */
  screen(): RouterScreen;

  /**
   * The exact screen an authorization decision is made against: the topmost
   * modal, then the terminal verdict, then the state machine's own name for the
   * state in force.
   */
  authorizationScreen(): AuthorizationScreen;

  /**
   * Whether the screen in force authorizes an action.
   *
   * THE ONE AUTHORIZATION API. Every modality — keyboard, gesture, generated
   * control, markup control and the reward screen's own pointer handler — asks
   * this before any board, run or dialog mutation, so an action cannot execute
   * from behind a screen that does not own it. `ACTION_SCREENS` is the rule and
   * `AUTHORIZED_ACTIONS` the closed vocabulary.
   *
   * @param action Action about to be performed.
   * @returns Whether the caller may proceed.
   */
  authorizes(action: AuthorizedAction): boolean;

  /**
   * Whether input is effectively suspended: either the state in force is one
   * `SCREEN_SUSPENDS_INPUT` marks as holding an unavoidable choice, or the
   * attached input surface reports itself suspended.
   *
   * Exported so a composition that withholds the optional `suspend`/`resume`
   * members of `RouterInputSurface` — because suspending the manager drops every
   * key, including the ones the suspending screen itself needs — can still read
   * the suspension the router declares, rather than that declaration being
   * unobservable. `authorizes()` is what enforces it.
   */
  isInputSuspended(): boolean;

  /** Whether the settings dialog is open. */
  isSettingsOpen(): boolean;

  /**
   * Records a standing offer and brings the flow to the gate in front of it.
   *
   * @param cards The offer to present.
   * @returns Whether the screen opened. An absent host and an empty offer
   *   each return `false`.
   */
  showReward(cards: readonly RewardCard[]): boolean;

  /**
   * Leaves the reward state and drops the recorded offer.
   *
   * @returns Whether the state was left.
   */
  hideReward(): boolean;

  /**
   * Reports one chosen relic into the reward transaction, and takes the
   * `rewardSelected` edge only where the transaction accepted it.
   *
   * THE ONE SELECTION PATH. The reward screen's card press, the digit bindings
   * and a caller's own surface all arrive here, so the validation, the
   * reporting and the state change cannot differ between them.
   *
   * @param relicId Identifier chosen.
   * @param source Modality the choice arrived through, carried into the report.
   * @returns Whether the transaction accepted the choice.
   */
  selectReward(relicId: string, source?: string): boolean;

  /** Whether the reward screen is showing. */
  isRewardOpen(): boolean;

  /**
   * Takes one of the standing offers, and is the ONE path a selection travels
   * on: a card press from the reward screen module, a `Digit1`-`Digit3` press
   * and a caller's own call all arrive here, so the count, the edge out of
   * `reward` and the `onRewardSelect` callback cannot differ between them.
   *
   * @param relicId Identifier of the chosen relic.
   * @returns Whether the identifier named a standing offer. A refusal is
   *   counted and changes nothing.
   */
  selectReward(relicId: string): boolean;

  /**
   * Shows the settings dialog, traps focus inside it and makes the board
   * inert.
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

/**
 * The reward screen's default prose, declared here and rendered by
 * `SCREEN_MODULES.reward`, which reads `heading` and `hint` from it. This module
 * writes none of it: it drives the screen's lifecycle and the screen owns its
 * own copy.
 */
export const DEFAULT_REWARD_COPY: RewardCopy = Object.freeze({
  heading: 'Choose a relic',
  hint: 'One of these three joins your run for the rest of it.',
});

/**
 * The relic slice yielded where neither a commit nor the port supplied one.
 */
const EMPTY_RELICS: RelicCommitContext = Object.freeze([]);

/** The offer yielded where neither a trigger nor the port supplied one. */
const EMPTY_OFFER: readonly RewardCard[] = Object.freeze([]);

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

/**
 * Mounts the router.
 *
 * Nothing is read at import time: every lookup and every report happens inside
 * this call, and an absent element is reported and skipped rather than raised
 * — the guarded form of the eight unguarded selector lookups of the vanilla
 * sources (I12). A container that did not resolve degrades that one screen;
 * the remaining six and the whole input-context path are unaffected.
 *
 * @param options Document, hosts, screens, ports, focus manager and sink.
 *   All are optional, so the router is constructible with no collaborator at
 *   all.
 * @returns The router, holding no listener until `attach` or `subscribe`.
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

  /**
   * The containers a modal state and the settings dialog make inert.
   *
   * The caller's list, resolved element by element, with every miss dropped;
   * `[gameRegion]` where the caller supplied none. Handed to the focus manager
   * as given: it refuses a container that holds the trapped one, so a list
   * naming an ancestor of a screen is reported rather than applied.
   * DL-ROUTER-25.
   */
  const backgroundRegions: readonly Element[] = Object.freeze(
    (options.backgroundRegions === undefined
      ? [gameRegion]
      : options.backgroundRegions.map((region): Element | null =>
          typeof region === 'string'
            ? resolveElement(region, region, owner)
            : (region ?? null),
        )
    ).filter((region): region is Element => region !== null),
  );
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
  // performs a lookup of its own.
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

  /**
   * The states carrying no screen module, in `SCREEN_NAMES` order. Computed
   * once: the registry is read at construction and never written afterwards.
   */
  const missingScreens: readonly ScreenName[] = Object.freeze(
    SCREEN_NAMES.filter((name): boolean => screens[name] === undefined),
  );

  // Reported at construction rather than left to the first transition. A state
  // with no module shows an empty container, and the composed application
  // checks this rather than trusting the type — `screens` stays optional so a
  // suite can register the one screen it exercises. DL-ROUTER-08.
  if (missingScreens.length > 0) {
    reporter.log('warn', 'screen modules are absent', {
      context: REPORT_CONTEXT,
      screens: missingScreens.join(', '),
      registered: SCREEN_NAMES.length - missingScreens.length,
    });

    for (const name of missingScreens) {
      reporter.count(SCREEN_MODULE_MISSING_METRIC, {
        context: REPORT_CONTEXT,
        screen: name,
        module: SCREEN_MODULES[name],
      });
    }
  }

  // Built here where the caller supplied none, and destroyed with this router.
  const ownedFocus = options.focus === undefined;
  const focus =
    options.focus ??
    createFocusManager({ reporter, context: REPORT_CONTEXT });

  const subscriptions: (() => void)[] = [];
  const listeners: RouterListener[] = [];
  const mounted = new Set<ScreenName>();

  /**
   * One registration this router owns on ONE external source.
   *
   * `attach()` and `subscribe()` each own exactly one of these. Before, both
   * merely pushed their releases onto `subscriptions`, which is drained only by
   * `destroy()`: a second `attach()` with the same manager registered a second
   * copy of all four dialog listeners, so one Escape closed the dialog twice and
   * one digit press chose twice; a second `subscribe()` over a replaced engine
   * left the released engine's handlers registered for the rest of the session;
   * and the releaser `subscribe()` returned did not remove its entries from
   * `subscriptions`, so a released engine's closures were retained until
   * teardown. DL-ROUTER-10.
   */
  interface Attachment {
    /** The source the registrations were made on, compared by identity. */
    readonly source: object;

    /** Releases every registration and removes it from `subscriptions`. */
    readonly release: () => void;
  }

  /**
   * Registers a group of releases as one owned attachment.
   *
   * The releases are appended to `subscriptions` so `destroy()` still drains
   * them, AND the returned handle removes them from that list as it releases,
   * so nothing released is held to teardown. Releasing twice is a no-op.
   *
   * @param source Object the registrations were made on.
   * @param releases Releases the registrations returned.
   * @returns The handle.
   */
  const holdAttachment = (
    source: object,
    releases: readonly (() => void)[],
  ): Attachment => {
    for (const release of releases) {
      subscriptions.push(release);
    }

    let released = false;

    return {
      source,
      release: (): void => {
        if (released) {
          return;
        }

        released = true;

        for (const release of releases) {
          const at = subscriptions.indexOf(release);

          if (at !== -1) {
            subscriptions.splice(at, 1);
          }

          release();
        }
      },
    };
  };

  /** The input surface's registrations, or `null` while none is attached. */
  let inputAttachment: Attachment | null = null;

  /** The engine emitter's registrations, or `null` while none is attached. */
  let engineAttachment: Attachment | null = null;

  let controls: RouterControlSurface | null = null;
  let input: RouterInputSurface | null = null;
  let trap: FocusTrapHandle | null = null;
  let settingsOpen = false;

  /** The offer currently on screen, empty while the screen is down. */
  let rewardCards: readonly RewardCard[] = EMPTY_OFFER;
  let rewardOpen = false;

  /** The terminal state the engine last committed. */
  let terminal: TerminalScreenName | null = null;
  let lastScreen: RouterScreen = 'game';
  let destroyed = false;

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

  /**
   * Calls one member of the run port and hands back what it answered.
   *
   * `driveRun` reports whether a call was made; this reports what it produced,
   * which is what an `endRun` whose return value IS the finished run needs.
   *
   * @param member Name carried into the report.
   * @param call The call to make.
   * @returns The value, or `null` where the call raised.
   */
  const driveRunValue = (member: string, call: () => unknown): unknown => {
    try {
      return call();
    } catch (error) {
      reporter.count(RUN_PORT_METRIC, { member, reason: 'raised' });
      reporter.error('a run-port call raised', error, {
        context: REPORT_CONTEXT,
        member,
      });

      return null;
    }
  };

  /**
   * Whether a run is open, as the run port reports it.
   *
   * Absent, a run is assumed open: a composition that opens its own board and
   * supplies no reader keeps the behaviour it had. DL-ROUTER-12.
   *
   * @returns Whether a run is open.
   */
  const readRunActive = (): boolean =>
    readPort<boolean>('isRunActive', run.isRunActive?.bind(run), true);

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
   * @returns The measurement, or `null` where no goal or no board was in
   *   force, or the evaluation refused its input.
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

  /**
   * The summary to show, in the order of authority.
   *
   * THE FINISHED RUN WINS. `run.summary()` is a LIVE projection: `endRun` closes
   * the run out and the controller's projection then describes the run that
   * replaced it, so preferring it — as this did — showed the summary screen a
   * score of zero, an empty relic list and stage one for the run the player had
   * just finished, and the finished projection captured on the way in was never
   * read because the live one is never null.
   *
   * The order is therefore: the controller's own retained projection of the
   * finished run; then the one this router captured as the `endRun` edge was
   * applied; then the live projection, which is all that exists while a run is
   * still in progress. DL-ROUTER-37.
   *
   * @returns The summary, or `null` where no port supplied one.
   */
  const readSummary = (): RunSummary | null => {
    const finished = readPort<RunSummary | null>(
      'lastSummary',
      run.lastSummary?.bind(run),
      null,
    );

    if (finished !== null) {
      return finished;
    }

    if (lastSummary !== null) {
      return lastSummary;
    }

    return readPort<RunSummary | null>(
      'summary',
      run.summary?.bind(run),
      null,
    );
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
   * js/html_actuator.js L135-L139 `clearMessage`, reached from that file's
   * `continueGame` L38-L41 — the one path that served both js/game_manager.js
   * L19 `restart` and L26 `keepPlaying`.
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

      case 'runSummary': {
        const summary = readSummary();

        return {
          ...base,
          screen: 'runSummary',
          summary,

          outcome: payload.outcome ?? lastOutcome,

          // THE FINISHED RUN'S SEED, not the port's: the port describes the run
          // in force, which after a run ends is its replacement. DL-ROUTER-37.
          seed: summary?.seed ?? readSeed(),
        };
      }
    }
  };

  /**
   * Invokes one lifecycle member, contained.
   *
   * A raise is reported and counted and the transition continues: a screen
   * that fails to render leaves the machine consistent.
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

  /**
   * Invokes one INJECTED OPTION CALLBACK, contained, and reports whether it
   * completed.
   *
   * The sibling of `invokeScreen` for the three callbacks a composition hands
   * this router — `onSettingsOpen`, `onSettingsClose` and `onRewardSelect`.
   * Each was previously called bare, so a raising composition escaped through
   * whichever listener happened to be on the stack: a pointer press unwound the
   * DOM event dispatch and a keyboard press unwound the input manager's
   * listener walk, so the same failure behaved differently by modality and
   * nothing was reported. Returning the outcome is what lets each caller apply
   * a deterministic rollback rather than leaving the router's state ahead of
   * the composition's. DL-ROUTER-11.
   *
   * @param member Callback name carried into the report.
   * @param apply Invocation.
   * @returns Whether the callback completed without raising. A callback the
   *   composition did not supply counts as completed: there was nothing to
   *   fail, and no rollback is owed.
   */
  const invokeCallback = (member: string, apply: () => void): boolean => {
    try {
      apply();

      return true;
    } catch (error) {
      reporter.count(CALLBACK_ERROR_METRIC, { context: REPORT_CONTEXT, member });
      reporter.error('an injected router callback raised', error, {
        context: REPORT_CONTEXT,
        member,
      });

      return false;
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

  /**
   * The container focus is placed inside for a state.
   *
   * `stage` resolves to the game region: the designated target
   * `SCREEN_INITIAL_FOCUS` declares for it — `#board-a11y` — is a
   * descendant of that region and not of `#screen-hud`.
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
   * The element a trap opens on: the marker a screen module wrote first, then
   * the per-state selector `SCREEN_INITIAL_FOCUS` declares. Resolved HERE
   * rather than by handing `trap()` a selector; a `null` answer leaves the trap
   * to open on the first focusable element of the container, which is its own
   * documented fallback. Decision DL-ROUTER-18.
   *
   * @param screen State being entered.
   * @param container Container focus is held inside.
   * @returns The element to open on, or `null` for the trap's own fallback.
   */
  const initialFocusFor = (
    screen: ScreenName,
    container: Element,
  ): HTMLElement | null => {
    const marked = asHtmlElement(
      container.querySelector(FOCUS_INITIAL_SELECTOR),
    );

    if (marked !== null) {
      return marked;
    }

    for (const selector of SCREEN_INITIAL_FOCUS[screen]) {
      const declared = asHtmlElement(container.querySelector(selector));

      if (declared !== null) {
        return declared;
      }
    }

    return null;
  };

  /**
   * Moves focus for the state just entered.
   *
   * THE ONE OWNER OF FOCUS PLACEMENT AND OF EVERY SCREEN TRAP. A screen module
   * composed here places no focus of its own; it marks its preferred target
   * with `FOCUS_INITIAL_ATTRIBUTE` and this places focus on it, falling back to
   * the container's first focusable element. A trapping state engages a trap
   * and inerts the background supplied; every other state places focus through
   * `focusInitial`. A trap a module already engaged on the same container is
   * adopted rather than stacked under a second one, because a container holding
   * two traps holds two Tab handlers competing for the same keys. Decisions
   * DL-ROUTER-11, DL-ROUTER-35.
   *
   * @param screen State just entered.
   * @param heldBeforeEntry What held focus before the state was entered, which a
   *   trap releases back to. Read before the state's module rendered, because a
   *   module that places focus of its own would otherwise leave the trap
   *   recording an element inside the container it contains focus within.
   */
  const placeFocus = (
    screen: ScreenName,
    heldBeforeEntry: Element | null,
  ): void => {
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

    // ONE CONTAINER, ONE TRAP. A screen module that renders its own dialog may
    // engage a trap over that container from its `enter` — ../ui/screens/reward.ts
    // is the one that does — and `enter` runs before this, so engaging here as
    // well stacked a second trap on the same element. Two traps meant two
    // `inertBackground` applications of `#game-main`, and only the trap that
    // applied the inertness lifts it: the topmost trap released first, lifted
    // nothing, and then restored focus into a region the other trap still held
    // inert, so the restore could not take and was reported as a failure. The
    // standing trap is adopted instead — not released from here, because the
    // module that engaged it releases it from its own `leave`. DL-ROUTER-07.
    const standing = focus.activeTrap();

    if (standing !== null && standing.container === container) {
      reporter.count(TRAP_ADOPTED_METRIC, {
        screen,
        label: standing.label,
      });

      return;
    }

    // `rewardRestoreFocusTo` is resolved HERE, per engage, and only for `reward`:
    // that screen is reached by clearing a stage rather than by pressing a
    // control, so there is no trigger to return to and focus goes back to the
    // board — whose parallel layer roves its tab stop, which is why the option is
    // a function and is called at the moment the trap engages. It serves the case
    // where no module holds the container: the mounted reward screen is given the
    // same resolver by the composition root, so whichever party owns the trap
    // restores focus to the same place.
    screenTrap = focus.trap(container, {
      label: screen,
      context: REPORT_CONTEXT,
      reporter,
      reducedMotion,

      // The marker a screen module writes, then the per-state selector,
      // resolved above. The trap falls back to the first focusable element on
      // `null`.
      initialFocus: initialFocusFor(screen, container),

      // Focus goes back to the BOARD for the reward state, not to a trigger:
      // that state is reached by clearing a stage rather than by pressing a
      // control, so there is no trigger to return to. Every other state falls
      // back to what held focus BEFORE the state was entered, read before the
      // state's module rendered. DL-ROUTER-35.
      restoreFocusTo:
        (screen === 'reward'
          ? asHtmlElement(options.rewardRestoreFocusTo?.() ?? null)
          : null) ?? asHtmlElement(heldBeforeEntry),
      inertBackground: SCREEN_INERTS_BACKGROUND[screen]
        ? backgroundRegions
        : undefined,
    });
  };

  /**
   * Shows the in-run HUD for the five in-run states and takes it down for the
   * two outside a run.
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
  /**
   * Whether input is effectively suspended.
   *
   * Two independent sources, either of which is enough: the state in force is
   * one `SCREEN_SUSPENDS_INPUT` marks as holding an unavoidable choice, or the
   * attached surface reports itself suspended. A surface that omits
   * `isSuspended` contributes nothing, and a surface whose member raises is
   * contained and read as not suspended, so this member never throws into a
   * caller.
   *
   * @returns Whether bindings should be treated as withheld.
   */
  const isInputSuspended = (): boolean => {
    if (SCREEN_SUSPENDS_INPUT[currentScreen]) {
      return true;
    }

    const read = input?.isSuspended;

    if (read === undefined || input === null) {
      return false;
    }

    try {
      return read.call(input);
    } catch (error) {
      reporter.error('an input suspension read raised', error, {
        context: REPORT_CONTEXT,
      });

      return false;
    }
  };

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
   * THE ONE SPEAKER OF AN ENTRY ANNOUNCEMENT. A screen module composed here
   * announces no entry of its own: it supplies the words through its optional
   * `announcement(context)` and this reads them, falling back to
   * `SCREEN_ANNOUNCEMENTS`. Decision DL-ROUTER-26.
   *
   * Only entries are announced, never a refresh, so a move does not re-read the
   * state it stayed in. The gameplay kinds — move, merge, spawn, stage clear
   * and the terminal verdicts — belong to ./a11y/engine-announcer, which
   * subscribes to the same events; nothing here restates them.
   *
   * @param screen State just entered.
   * @param context The context that entry carried.
   */
  const announceScreen = (screen: ScreenName, context: ScreenContext): void => {
    if (announcer === null) {
      return;
    }

    const speak = announcer.announceText?.bind(announcer);

    if (speak === undefined) {
      return;
    }

    try {
      speak(readScreenAnnouncement(screen, context));
    } catch (error) {
      reporter.error('a screen announcement raised', error, {
        context: REPORT_CONTEXT,
        screen,
      });
    }
  };

  /**
   * The line a state is announced under: the screen module's own, where it
   * supplies one, and `SCREEN_ANNOUNCEMENTS` otherwise.
   *
   * Contained: a module whose provider raises or answers with something other
   * than a non-empty string is reported and the generic line is read instead.
   *
   * @param screen State just entered.
   * @param context The context that entry carried.
   * @returns The line to read.
   */
  const readScreenAnnouncement = (
    screen: ScreenName,
    context: ScreenContext,
  ): string => {
    const module = screens[screen];
    const provide = module?.announcement;

    if (provide === undefined) {
      return SCREEN_ANNOUNCEMENTS[screen];
    }

    try {
      const supplied = provide.call(module, context);

      return typeof supplied === 'string' && supplied.trim() !== ''
        ? supplied
        : SCREEN_ANNOUNCEMENTS[screen];
    } catch (error) {
      reporter.count(SCREEN_MODULE_ERROR_METRIC, {
        screen,
        member: 'announcement',
      });
      reporter.error('a screen announcement provider raised', error, {
        context: REPORT_CONTEXT,
        screen,
      });

      return SCREEN_ANNOUNCEMENTS[screen];
    }
  };


  /**
   * Forwards one gameplay announcement, where the caller opted in.
   *
   * @param build Builds the announcement, called only when it will be
   *   spoken.
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

  /**
   * Whether an offer is standing in front of the player.
   *
   * TWO SIGNALS, EITHER SUFFICIENT: the reward surface being open, and the
   * machine holding the `reward` state. The second is what makes the context
   * correct when a screen module owns the surface — the module renders the
   * cards and this router never opens a surface of its own — and the first is
   * makes it correct for a caller that opened the surface without an edge.
   * DL-ROUTER-06.
   */
  const isRewardShowing = (): boolean =>
    rewardOpen || (started && !tearingDown && currentScreen === 'reward');

  const screen = (): RouterScreen => {
    // Settings outranks the reward screen: it is opened from on top of
    // whatever is already showing.
    if (settingsOpen) {
      return 'settings';
    }

    if (isRewardShowing()) {
      return 'reward';
    }

    return terminal ?? 'game';
  };

  /**
   * The context the STATE MACHINE puts the page in, and `'game'` before it
   * starts.
   *
   * Read from the same `SCREEN_INPUT_CONTEXTS` table `applyInputContext` pushes
   * into the input manager, so the manager, the keyboard, the gesture path and
   * the generated controls cannot disagree about which context is in force —
   * which they did while this function answered for the reward surface alone
   * and the table already declared `runStart`, `stageClear`, `reward`, `won`,
   * `gameOver` and `runSummary` to be overlays. DL-ROUTER-06.
   */
  const machineContext = (): InputContext =>
    started && !tearingDown ? SCREEN_INPUT_CONTEXTS[currentScreen] : 'game';

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
      isRewardShowing() ||
      machineContext() === 'overlay' ||
      terminal !== null ||
      documentContext === 'overlay'
    ) {
      return 'overlay';
    }

    return 'game';
  };

  /* ------------------------------------------------------------------------
   * Action authorization
   * ---------------------------------------------------------------------- */

  /**
   * Whether a state's container is on screen: resolved, and not hidden.
   *
   * `style/_screens.scss` makes the `hidden` attribute the whole
   * active-and-inactive mechanism, so the attribute is the reading.
   *
   * @param name State to test.
   * @returns Whether the player can see that state's container.
   */
  const isScreenShown = (name: ScreenName): boolean => {
    const host = screenHosts[name];

    return host !== null && !host.hasAttribute('hidden');
  };

  /**
   * The screen an authorization decision is made against.
   *
   * The SAME precedence `screen()` above resolves — settings, then reward, then
   * the terminal verdict — with one difference at the bottom: where `screen()`
   * answers the coarse `'game'`, this answers the state machine's EXACT name for
   * it. That is the whole reason this exists: `context()` can only say
   * `'overlay'` and `screen()` can only say `'game'`, and neither distinguishes
   * `runStart` from `stageClear` from `runSummary`.
   *
   * The three states above the machine are read from the router's own flags
   * rather than from `currentScreen`, because those flags are authoritative the
   * moment the screen goes up: a dialog opened, an offer shown or a terminal
   * turn committed before `start()` has been called leaves the machine holding
   * `INITIAL_SCREEN` while the screen is genuinely on top. The terminal verdict
   * is the one of the three that is also bounded by the machine — it answers for
   * the board and for its own screen, and not for the two states the flow
   * reaches from it. DL-ROUTER-38.
   *
   * A machine state whose overlay root is ABSENT OR HIDDEN answers `'stage'`
   * instead of itself. `DL-ROUTER-03` leaves each screen's contents to its own
   * module and nothing guarantees a routed state has a container, so the machine
   * can hold an overlay state that is not on screen — a stage cleared with no
   * reward container to present the offer in, say. The player is looking at the
   * board in that case, and authorizing against a screen they cannot see would
   * make the board unplayable rather than safe.
   */
  const authorizationScreen = (): AuthorizationScreen => {
    if (settingsOpen) {
      return 'settings';
    }

    if (rewardOpen) {
      return 'reward';
    }

    // THE VERDICT OUTRANKS THE STATE ONLY WHILE THE FLOW IS STILL AT THE BOARD
    // OR AT THE TERMINAL SCREEN. `terminal` is a property of the last commit and
    // is cleared by the first commit that is not terminal, and no commit arrives
    // between a terminal turn and the run summary or run start the flow reaches
    // from it — so a verdict read unconditionally here stayed authoritative on
    // those two states and refused every action they offer, `startRun` among
    // them: a won or lost run could reach run start and never begin another. The
    // retained `.game-message` overlay of js/html_actuator.js L127-L139 stands
    // over the BOARD, which is the case this branch exists for, and the fallback
    // below would otherwise authorize board actions from behind it.
    // Decisions DL-ROUTER-18, DL-ROUTER-38.
    if (
      terminal !== null &&
      (currentScreen === terminal || currentScreen === 'stage')
    ) {
      return terminal;
    }

    if (SCREEN_IS_OVERLAY[currentScreen] && !isScreenShown(currentScreen)) {
      return 'stage';
    }

    return currentScreen;
  };

  /**
   * Whether the screen in force authorizes an action. Decision DL-ROUTER-18.
   *
   * THE ONE DECISION every modality resolves against — the keyboard, the
   * gesture path, the generated controls, the markup controls and the reward
   * screen's own pointer handler all reach it, so a press, a tap and a click on
   * the same action are answered identically. `ACTION_SCREENS` is the whole
   * rule; there is no per-action branch here.
   *
   * Refuses after `destroy()` and while tearing down. It does NOT require
   * `start()`: the dialog is not a state of AAP Figure 6 and is usable before
   * the machine is started, and the machine holds `INITIAL_SCREEN` until then,
   * which is the screen a pre-start action genuinely belongs to.
   *
   * @param action Action about to mutate the board, the run or the dialog.
   * @returns Whether the caller may proceed.
   */
  const authorizes = (action: AuthorizedAction): boolean => {
    if (destroyed || tearingDown) {
      reporter.count(ACTION_REFUSED_METRIC, {
        action,
        screen: authorizationScreen(),
        reason: destroyed ? 'destroyed' : 'tearing-down',
      });

      return false;
    }

    const at = authorizationScreen();

    if (ACTION_SCREENS[action].includes(at)) {
      return true;
    }

    reporter.count(ACTION_REFUSED_METRIC, {
      action,
      screen: at,
      reason: at === 'settings' ? 'modal-topmost' : 'wrong-screen',
    });

    return false;
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

  /**
   * Narrows a run-port answer to a run summary.
   *
   * Structural, on the two members a summary screen cannot render without, so a
   * port answering with something else is ignored rather than displayed.
   *
   * @param value Value the port answered with.
   * @returns Whether it is a summary.
   */
  const isRunSummary = (value: unknown): value is RunSummary =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { seed?: unknown }).seed === 'string' &&
    typeof (value as { score?: unknown }).score === 'number';

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

  /**
   * Publishes one applied transition to every registered listener.
   *
   * Each call is contained: a listener that raises is reported and the
   * transition completes. Decision DL-ROUTER-08.
   *
   * @param transition Transition just applied.
   */
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
        // A run beginning has no finished summary of its own yet, and the one
        // the run before it left is the run-start screen's `previous`.
        previousSummary = lastSummary ?? previousSummary;
        lastSummary = null;

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
        // js/game_manager.js carried no run outcome; the default is the
        // verdict of the state the edge leaves.
        const outcome: RunOutcome =
          payload.outcome ?? (from === 'gameOver' ? 'lost' : 'won');

        lastOutcome = outcome;

        if (run.endRun !== undefined) {
          const end = run.endRun.bind(run);

          // THE RETURNED SUMMARY IS THE FINISHED RUN'S. Ending a run replaces
          // the run in force with a fresh one, so re-reading the port after
          // this call describes the REPLACEMENT — stage 0, no relics, another
          // seed. The value the call answered with is held instead. Decision
          // DL-ROUTER-37.
          const finished = driveRunValue('endRun', (): unknown => end(outcome));

          if (isRunSummary(finished)) {
            lastSummary = finished;
          }
        }

        if (lastSummary === null) {
          lastSummary = readSummary();
        }

        return;
      }

      case 'newRun':
        previousSummary = lastSummary ?? previousSummary;

        return;

      default:
        return;
    }
  };

  /** Hides the container the machine is leaving, where it owns one. */
  const leaveScreen = (from: ScreenName, to: ScreenName): void => {
    releaseScreenTrap();

    // The recorded offer goes with the state, so no digit binding can resolve
    // against an offer that is no longer on screen.
    if (from === 'reward') {
      closeRewardState();
    }

    invokeScreen(from, 'leave', (target): void => {
      target.leave?.();
    });

    const fromHost = screenHosts[from];

    // The five overlay roots are mutually exclusive; the in-flow HUD is not
    // one of them and stays as it is.
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
    // Read BEFORE the module renders: a module that places focus of its own
    // would otherwise leave the trap below recording an element inside the
    // container it is about to contain focus within.
    //
    // The body reads as nothing rather than as a target. A document where
    // nothing is focused reports the body as its active element, and the body is
    // not focusable, so carrying it into `restoreFocusTo` asks the release to
    // focus something that cannot take focus. The focus manager already treats a
    // RECORDED body as nothing had focus; this is the same reading applied to
    // the fallback the router supplies. DL-ROUTER-04.
    const active = owner?.activeElement ?? null;
    const heldBeforeEntry = active === owner?.body ? null : active;

    mountScreen(to);

    // The offer is recorded before the context is built, so the context the
    // reward screen receives carries the cards it is to render.
    if (to === 'reward') {
      openRewardState(resolveOffer(payload));
    }

    setHidden(screenHosts[to], false);
    applyHudVisibility(to);

    const built = contextFor(to, trigger, false, payload);

    invokeScreen(to, 'enter', (target): void => {
      target.enter?.(built);
    });

    applyTerminalOverlay(to);
    applyInputContext(to);
    placeFocus(to, heldBeforeEntry);
    announceScreen(to, built);

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
   * @param flags `drive` requests the run port be driven, which an edge taken
   *   in response to an engine event does not. Every state is reached through
   *   `TRANSITIONS`; no caller may put one on screen another way.
   *   Decision DL-ROUTER-12.
   * @returns The context the entered state received.
   */
  const transitionTo = (
    to: ScreenName,
    trigger: RouterEventName,
    payload: RouterTriggerPayload,
    flags: { readonly drive?: boolean } = {},
  ): ScreenContext => {
    const from = currentScreen;

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
    });
    reporter.log('debug', 'the screen state changed', {
      context: REPORT_CONTEXT,
      from,
      to,
      trigger,
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
    // load cannot leave two of the five showing at once. Decision DL-ROUTER-09.
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

    // VALIDATED, NOT TRUSTED. `send` is reached from the input layer, from a
    // screen module and from the application surface, so its arguments cross a
    // boundary and the type annotation is a compile-time claim about them and
    // nothing more (CWE-20). A trigger no state declares is refused here rather
    // than resolved against the table, and a payload that is not an object is
    // replaced by an empty one rather than read member by member.
    if (!isRouterTrigger(trigger)) {
      reporter.count(TRANSITION_REFUSED_METRIC, {
        from: currentScreen,
        trigger: String(trigger),
        reason: 'unknown-trigger',
      });
      reporter.log('warn', 'an unknown trigger was refused', {
        context: REPORT_CONTEXT,
        from: currentScreen,
        trigger: String(trigger),
      });

      return false;
    }

    const carried: RouterTriggerPayload =
      typeof payload === 'object' && payload !== null ? payload : {};

    if (carried !== payload) {
      reporter.count(TRANSITION_REFUSED_METRIC, {
        from: currentScreen,
        trigger,
        reason: 'payload-not-an-object',
      });
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

    // The topmost modal is consulted BEFORE the edge table. The settings dialog
    // owns no trigger of AAP Figure 6, so while it is open no edge of the state
    // underneath it may be taken — a screen behind an unrelated modal is inert
    // to every modality, not merely to focus. Decision DL-ROUTER-18.
    if (settingsOpen) {
      reporter.count(TRANSITION_REFUSED_METRIC, {
        from: currentScreen,
        trigger,
        reason: 'modal-topmost',
      });
      reporter.log('debug', 'a trigger arrived behind an unrelated modal', {
        context: REPORT_CONTEXT,
        from: currentScreen,
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

    transitionTo(target, trigger, carried, { drive: true });

    return true;
  };

  /**
   * The shortest sequence of declared triggers from the state in force to a
   * target, or `null` where `TRANSITIONS` declares no route.
   *
   * Breadth-first over the table, in `ROUTER_TRIGGERS` order, so the route is
   * both shortest and deterministic. `TRANSITIONS` is the WHOLE edge set:
   * nothing here invents an edge, and a target the table cannot reach is
   * reported rather than adopted. Decision DL-ROUTER-12.
   *
   * @param target State to reach.
   * @returns The triggers to apply in order, `[]` where the machine already
   *   holds the target, or `null` where no route exists.
   */
  const routeTo = (target: ScreenName): RouterEventName[] | null => {
    if (currentScreen === target) {
      return [];
    }

    const seen = new Set<ScreenName>([currentScreen]);
    const queue: {
      readonly at: ScreenName;
      readonly path: RouterEventName[];
    }[] = [{ at: currentScreen, path: [] }];

    while (queue.length > 0) {
      const step = queue.shift();

      if (step === undefined) {
        break;
      }

      for (const trigger of ROUTER_TRIGGERS) {
        const next = TRANSITIONS[step.at][trigger];

        if (next === undefined || next === step.at || seen.has(next)) {
          continue;
        }

        const path = [...step.path, trigger];

        if (next === target) {
          return path;
        }

        seen.add(next);
        queue.push({ at: next, path });
      }
    }

    return null;
  };

  /**
   * Walks the declared edges to a state, applying each in order.
   *
   * The one path an engine event or the imperative surface reaches a state by,
   * so every state change the router makes is an edge `TRANSITIONS` declares.
   * The payload is carried on the LAST edge, which is the one that enters the
   * target.
   *
   * @param to State to reach.
   * @param payload Data the entering trigger carries.
   * @returns Whether the target is now the state in force.
   */
  const driveTo = (
    to: ScreenName,
    payload: RouterTriggerPayload,
  ): boolean => {
    if (!started || tearingDown) {
      reporter.count(NOT_STARTED_METRIC, { call: 'driveTo', to });

      return false;
    }

    if (currentScreen === to) {
      return true;
    }

    const route = routeTo(to);

    if (route === null) {
      reporter.count(TRANSITION_REFUSED_METRIC, {
        from: currentScreen,
        to,
        reason: 'no-route',
      });
      reporter.log('warn', 'no declared route reaches the screen', {
        context: REPORT_CONTEXT,
        from: currentScreen,
        to,
      });

      return false;
    }

    const last = route.length - 1;

    for (const [index, trigger] of route.entries()) {
      transitionTo(
        TRANSITIONS[currentScreen][trigger] as ScreenName,
        trigger,
        index === last ? payload : {},
      );
    }

    return currentScreen === to;
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

  /** Reflects the dialog's open state onto its trigger as `aria-expanded`. */
  const reflectTriggerExpansion = (open: boolean): void => {
    trigger?.setAttribute('aria-expanded', open ? 'true' : 'false');
  };

  reflectTriggerExpansion(false);

  /**
   * The subtrees the settings trap marks inert: the game region, plus every
   * overlay root that is showing underneath the dialog.
   *
   * The settings panel is a SIBLING of the five overlay roots inside
   * `.screen-layer` while the game region is `#game-main`, so the region alone
   * leaves a shown overlay — the reward offer above all — reachable by pointer
   * from behind a modal that announces `aria-modal="true"`. The panel itself is
   * never included, and a root is included only while it is unhidden, so a
   * dialog opened over the bare board still marks exactly one subtree.
   *
   * @returns The subtrees to mark inert, in a stable order.
   */

  const closeSettings = (): boolean => {
    if (refuseAfterDestroy('closeSettings')) {
      return false;
    }

    // `ACTION_SCREENS.closeSettings` names `'settings'` and nothing else, so
    // this is the `!settingsOpen` refusal expressed through the one decision
    // every other action resolves against. Decision DL-ROUTER-18.
    if (!authorizes('closeSettings')) {
      return false;
    }

    settingsOpen = false;

    // Released BEFORE the panel is hidden: a trap restores focus to the
    // element it recorded, and restoring into a subtree that has just become
    // `hidden` places focus on the body instead.
    const engaged = trap;

    trap = null;
    engaged?.release();

    setHidden(panelElement ?? panel, true);
    reflectTriggerExpansion(false);
    reporter.count(SETTINGS_CLOSE_METRIC);

    if (panel !== null) {
      // Contained: the dialog is already down and its trap already released, so
      // a raising composition is reported and the close still completes rather
      // than leaving the router believing the dialog is open. DL-ROUTER-11.
      const host = panel;

      invokeCallback('onSettingsClose', (): void => {
        options.onSettingsClose?.(host);
      });
    }

    settle();

    return true;
  };

  /**
   * The regions the settings dialog makes inert: the background the caller
   * supplied, plus the overlay screen root the dialog opened over.
   *
   * An overlay root lives inside the screen layer, which the background list
   * excludes, so a screen standing behind the dialog stays in the
   * accessibility tree unless it is added here. `stage` contributes nothing:
   * its container is in flow inside the background already. DL-ROUTER-34.
   *
   * @param dialog The dialog being trapped, which is never made inert.
   * @returns The regions to make inert, in application order.
   */
  const settingsBackground = (dialog: Element): readonly Element[] => {
    const host = SCREEN_IS_OVERLAY[currentScreen]
      ? screenHosts[currentScreen]
      : null;

    if (host === null || host === dialog || host.contains(dialog)) {
      return backgroundRegions;
    }

    return Object.freeze([...backgroundRegions, host]);
  };

  const openSettings = (): boolean => {
    if (refuseAfterDestroy('openSettings')) {
      return false;
    }

    // `ACTION_SCREENS.openSettings` names every state but `'settings'`, so a
    // dialog already open is refused by the same lookup that refuses every other
    // action while it is topmost. Decision DL-ROUTER-18.
    if (!authorizes('openSettings')) {
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
    // Contained, and a raise ROLLS THE DIALOG BACK DOWN: a panel whose body did
    // not render holds nothing focusable, so opening on it would announce a
    // modal dialog with focus outside it — the same state the no-focusable
    // branch below already refuses. The rollback is identical whichever
    // modality asked, which is what makes the failure deterministic.
    // DL-ROUTER-11.
    const rendered = invokeCallback('onSettingsOpen', (): void => {
      options.onSettingsOpen?.(panel);
    });

    if (!rendered) {
      setHidden(panelElement ?? panel, true);
      reporter.count(SETTINGS_REFUSED_METRIC, { reason: 'render-failed' });

      return false;
    }

    const engaged = focus.trap(panel, {
      label: 'settings',
      context: REPORT_CONTEXT,
      reporter,
      restoreFocusTo: trigger === null ? null : (trigger as HTMLElement),
      onEscape: (): void => {
        closeSettings();
      },

      // The whole background leaves the accessibility tree for the dialog's
      // lifetime, which is what `aria-modal="true"` in index.html announces,
      // and that includes the overlay screen the dialog opened over.
      // DL-ROUTER-19.
      inertBackground: settingsBackground(panel),
    });

    if (engaged === null) {
      setHidden(panelElement ?? panel, true);
      invokeCallback('onSettingsClose', (): void => {
        options.onSettingsClose?.(panel);
      });
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

  /**
   * The offer the `reward` state is entered with.
   *
   * The trigger's payload first, then the run port, then the offer already
   * standing. No card is built here and no list is sampled: ./screens/reward is
   * the one surface that renders an offer, and it reads the same cards off the
   * context this resolves. Decision DL-ROUTER-14.
   *
   * @param payload Data the trigger carried.
   * @returns The offer, in the order it was drawn.
   */
  const resolveOffer = (
    payload: RouterTriggerPayload,
  ): readonly RewardCard[] => {
    const supplied = payload.offers;

    if (supplied !== undefined && supplied.length > 0) {
      return supplied;
    }

    const fromPort = readPort<readonly RewardCard[]>(
      'offers',
      run.offers?.bind(run),
      EMPTY_OFFER,
    );

    return fromPort.length > 0 ? fromPort : rewardCards;
  };

  /**
   * Records the offer the state is showing and unhides its container.
   *
   * Called from `enterScreen`, inside the transition, so the container is
   * showing before the screen module is handed the context and before the trap
   * engages: nothing inside a `display: none` subtree can take focus.
   *
   * @param cards The offer being presented.
   */
  const openRewardState = (cards: readonly RewardCard[]): void => {
    rewardCards = Object.freeze([...cards]);
    rewardOpen = true;

    if (cards.length === 0) {
      reporter.count(REWARD_REFUSED_METRIC, { reason: 'empty' });
    }

    reporter.count(REWARD_OPEN_METRIC, { offers: rewardCards.length });
  };

  /**
   * Clears the offer bookkeeping and hides the container.
   *
   * The trap belongs to `placeFocus`/`releaseScreenTrap` like every other
   * trapping state's, so nothing is released here.
   *
   * @returns Whether an offer was standing.
   */
  const closeRewardState = (): boolean => {
    if (!rewardOpen) {
      return false;
    }

    rewardOpen = false;
    rewardCards = EMPTY_OFFER;

    if (rewardHost !== null) {
      setHidden(rewardElement ?? rewardHost, true);
    }

    reporter.count(REWARD_CLOSE_METRIC);

    return true;
  };

  const hideReward = (): boolean => {
    const wasOpen = closeRewardState();

    settle();

    // The machine follows the screen down where the screen was taken down from
    // outside an edge; a call made from inside one leaves the walk in charge.
    if (
      wasOpen &&
      started &&
      !tearingDown &&
      !transitioning &&
      currentScreen === 'reward'
    ) {
      driveTo('stage', {});
    }

    return wasOpen;
  };

  /**
   * Puts one offer on screen by bringing the machine to the reward state.
   *
   * The cards are recorded first, so the context the entered state builds
   * carries them and the digit bindings resolve an index against the same set
   * the screen renders.
   *
   * @param cards The offer to present, in draw order.
   * @returns Whether the reward state is in force afterwards.
   */
  const showReward = (cards: readonly RewardCard[]): boolean => {
    if (refuseAfterDestroy('showReward')) {
      return false;
    }

    if (cards.length === 0) {
      reporter.count(REWARD_REFUSED_METRIC, { reason: 'empty' });

      return false;
    }

    if (!started || tearingDown) {
      reporter.count(NOT_STARTED_METRIC, { call: 'showReward' });

      return false;
    }

    if (currentScreen === 'reward') {
      // Already showing: the offer is replaced through the refresh path, so a
      // redraw does not leave the state and re-enter it.
      transitionTo('reward', lastTrigger, { offers: cards });

      return true;
    }

    // THROUGH THE TABLE, NEVER ADOPTED. `TRANSITIONS` is the whole edge set,
    // so an offer presented from a state the table cannot reach `reward`
    // from — a standing terminal state, above all — is refused rather than
    // allowed to mask that state. Decision DL-ROUTER-15.
    return driveTo('reward', { offers: cards });
  };

  /**
   * Reports one choice into the reward transaction and takes the edge out of
   * `reward` only where the transaction accepted it.
   *
   * @param relicId Identifier chosen.
   * @param source Modality the choice arrived through, for the report.
   * @returns Whether the choice was accepted.
   */
  const chooseReward = (relicId: string, source: string): boolean => {
    if (refuseAfterDestroy('selectReward')) {
      return false;
    }

    // AUTHORIZED FIRST, for every modality. A card press, a `Digit1`-`Digit3`
    // press and a caller's own call all arrive here, and a reward container
    // that is behind an unrelated modal is not the screen in force: the
    // container is a sibling of the settings dialog, so paint order alone left
    // its cards pointer-live and keyboard-reachable underneath it.
    // DL-ROUTER-18.
    if (!authorizes('selectReward')) {
      reporter.count(REWARD_REFUSED_METRIC, {
        reason: 'unauthorized',
        relicId,
        source,
      });

      return false;
    }

    reporter.count(REWARD_SELECT_METRIC, { relicId, source });

    const report = options.onRewardSelect;
    let accepted = true;

    if (report !== undefined) {
      try {
        // A handler that answers nothing is read as acceptance, so a caller
        // with no transaction to consult keeps the flow moving.
        accepted = report(relicId) !== false;
      } catch (error) {
        accepted = false;
        reporter.error('a reward selection handler raised', error, {
          context: REPORT_CONTEXT,
          relicId,
        });
      }
    }

    if (!accepted) {
      reporter.count(REWARD_REFUSED_METRIC, {
        reason: 'not-accepted',
        relicId,
      });

      return false;
    }

    // The transaction opens the next stage itself, and the `stage:start` that
    // follows takes this edge, so the state may already have moved on.
    if (started && !tearingDown && currentScreen === 'reward') {
      send('rewardSelected', { relicId });
    }

    return true;
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
    // carried.
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
      // through `continueGame` L38-L41 on the turn that clears one.
      applyTerminalOverlay(next);
    }

    if (!started || tearingDown) {
      if (changed) {
        settle();
      }

      return;
    }

    if (changed && next !== null) {
      if (!driveTo(next, {})) {
        settle();
      }

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

    // A COLD LOAD HOLDS `runStart`. The board of a run nobody started is not a
    // reason to leave the run-start screen, so this edge is taken only for a
    // run the player began or one resumed from storage. Decision DL-ROUTER-12.
    if (currentScreen === 'runStart' && !readRunActive()) {
      reporter.count(TRANSITION_REFUSED_METRIC, {
        from: currentScreen,
        to: 'stage',
        reason: 'no-run-open',
      });

      return;
    }

    driveTo('stage', {});
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

  /**
   * `stage:end`, which has no vanilla analogue.
   *
   * ONE EVENT, ONE EDGE. This takes `stage -> stageClear` and stops there. The
   * second edge AAP Figure 6 declares between the goal being met and the offer
   * being presented, `stageClear -> reward`, belongs to the explicit `stageEnd`
   * trigger the stage-progress screen's Continue control sends, so the state the
   * control governs is still in force when the press arrives. DL-ROUTER-05,
   * DL-ROUTER-31.
   *
   * AND ONLY FOR A CLEARED STAGE. `payload.cleared` was ignored, so a stage that
   * ended without its goal met still opened the interstitial and led to a relic
   * offered for a stage the player had not cleared. It is reported and the state
   * in force is refreshed instead. DL-ROUTER-36.
   */
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

    // A STAGE THAT DID NOT CLEAR TAKES NO EDGE. Reported rather than silent, and
    // the state in force is refreshed so its readouts still follow the run.
    // DL-ROUTER-36.
    if (!payload.cleared) {
      reporter.count(STAGE_UNCLEARED_METRIC, {
        from: currentScreen,
        stageIndex: payload.stageIndex,
      });
      refreshCurrent();

      return;
    }

    // STOPS AT STAGE CLEAR. `stage -> stageClear` is the edge a met goal takes;
    // `stageClear -> reward` is the player's, taken by the continue action, so
    // the stage-clear state is dwelt in rather than passed through in one
    // stack. Decisions DL-ROUTER-31, DL-ROUTER-36.
    if (currentScreen !== 'stage') {
      reporter.count(TRANSITION_REFUSED_METRIC, {
        from: currentScreen,
        to: 'stageClear',
        reason: 'not-in-stage',
      });

      return;
    }

    transitionTo('stageClear', 'stageGoalMet', { cleared: true });
  };

  return Object.freeze({
    context,
    screen,
    authorizationScreen,
    authorizes,
    isInputSuspended,
    isSettingsOpen: (): boolean => settingsOpen,
    openSettings,
    closeSettings,
    showReward,
    hideReward,
    selectReward: (relicId: string, source = 'caller'): boolean =>
      chooseReward(relicId, source),
    isRewardOpen: (): boolean => rewardOpen,

    start,
    current: (): ScreenName => currentScreen,
    isStarted: (): boolean => started,
    send,
    go: send,
    can: (candidate: RouterEventName): boolean =>
      candidate === 'initial'
        ? !started
        : started && edgeFor(currentScreen, candidate) !== undefined,
    hostFor: (name: ScreenName): Element | null => screenHosts[name] ?? null,
    missingMounts: (): readonly MissingMount[] => Object.freeze([...missing]),
    missingScreens: (): readonly ScreenName[] => missingScreens,

    attach(surfaces: ScreenRouterSurfaces): void {
      if (refuseAfterDestroy('attach')) {
        return;
      }

      if (surfaces.controls !== undefined) {
        controls = surfaces.controls;
      }

      const attached = surfaces.input ?? null;

      if (attached !== null && attached === inputAttachment?.source) {
        // THE SAME SURFACE, ALREADY ATTACHED. Registering again would install a
        // second copy of all four listeners below, so one Escape would close the
        // dialog twice and one digit press would choose twice. The context in
        // force is still pushed, because that is idempotent and is what a caller
        // re-attaching after a screen change is asking for. DL-ROUTER-10.
        reporter.count(ATTACHMENT_METRIC, {
          context: REPORT_CONTEXT,
          surface: 'input',
          action: 'unchanged',
        });

        if (started) {
          applyInputContext(currentScreen);
        }

        settle();

        return;
      }

      if (attached !== null) {
        // A DIFFERENT SURFACE REPLACES, it does not join: the previous one's
        // registrations are released and leave `subscriptions` at once.
        if (inputAttachment !== null) {
          inputAttachment.release();
          inputAttachment = null;
          reporter.count(ATTACHMENT_METRIC, {
            context: REPORT_CONTEXT,
            surface: 'input',
            action: 'replaced',
          });
        }

        input = attached;

        inputAttachment = holdAttachment(attached, [
          attached.on('openSettings', (): void => {
            openSettings();
          }),
          attached.on('closeSettings', (): void => {
            closeSettings();
          }),

          // `cancel` is Escape everywhere. The trap's own `onEscape` covers
          // the press that lands inside the dialog; this covers the press the
          // keyboard resolved before focus reached it.
          //
          // The reward screen is NOT cancellable: the stage is cleared and a
          // relic must be taken. DL-ROUTER-15.
          attached.on('cancel', (): void => {
            closeSettings();
          }),

          // The digit bindings of ../input/keymap publish a zero-based index.
          attached.on('selectReward', (index: number): void => {
            // `rewardOpen` says a screen is up; `authorizes` says it is the
            // screen in force. The two differ exactly when an unrelated modal
            // is on top of it, which is the press this refuses. Decision
            // DL-ROUTER-18.
            if (!rewardOpen || !authorizes('selectReward')) {
              reporter.count(REWARD_REFUSED_METRIC, {
                reason: 'unauthorized',
                source: 'keyboard',
              });

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

            chooseReward(chosen.id, 'keyboard');
          }),
        ]);

        reporter.count(ATTACHMENT_METRIC, {
          context: REPORT_CONTEXT,
          surface: 'input',
          action: 'attached',
        });

        if (started) {
          applyInputContext(currentScreen);
        }
      }

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

      if (target === engineAttachment?.source) {
        // THE SAME EMITTER, ALREADY SUBSCRIBED. Subscribing again would install
        // a second copy of all seven handlers below, so one commit would be read
        // twice and one merge announced twice. The releaser already held is
        // handed back, so a caller that subscribed twice and releases once still
        // ends up with nothing registered. DL-ROUTER-10.
        const held = engineAttachment;

        reporter.count(ATTACHMENT_METRIC, {
          context: REPORT_CONTEXT,
          surface: 'engine',
          action: 'unchanged',
        });

        return (): void => {
          held.release();

          if (engineAttachment === held) {
            engineAttachment = null;
          }
        };
      }

      // A DIFFERENT EMITTER REPLACES, it does not join: the previous one's
      // handlers are released and leave `subscriptions` at once, rather than
      // being retained until `destroy()` over an engine nothing drives.
      if (engineAttachment !== null) {
        engineAttachment.release();
        engineAttachment = null;
        reporter.count(ATTACHMENT_METRIC, {
          context: REPORT_CONTEXT,
          surface: 'engine',
          action: 'replaced',
        });
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
        // vetoed by the screen flow.
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

      const attachment = holdAttachment(target, releases);

      engineAttachment = attachment;

      reporter.count(ATTACHMENT_METRIC, {
        context: REPORT_CONTEXT,
        surface: 'engine',
        action: 'attached',
      });

      return (): void => {
        attachment.release();

        if (engineAttachment === attachment) {
          engineAttachment = null;
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

      // The two owned handles are dropped BEFORE the list is drained, so the
      // releases they hold run exactly once here rather than once through the
      // handle and once through the list.
      inputAttachment = null;
      engineAttachment = null;

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
