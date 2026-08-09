// The terminal-verdict screen. ONE module, TWO router states: `won` and
// `gameOver`. src/ui/screen-router.ts maps both to `screens/game-over` and both
// to the single container `#screen-game-over`, so this module receives `mount`
// once and is entered twice.
//
// THE BOUNDARY, stated as fact.
//   src/ui/screen-router.ts is the STATE authority: it selects `won` or
//   `gameOver` from its `TRANSITIONS` table, resolves the container and injects
//   it with the `ScreenContext`.
//   This module is the DOM authority: it is the writer of the verdict panel
//   inside `#screen-game-over`, of the two state classes on the retained
//   `.game-message`, of that overlay's verdict paragraph, and of the visibility
//   of the controls it creates itself.
//   Both surfaces are written idempotently and the same values are written on
//   every path, so a class or a verdict another actor has already applied is
//   observed as already applied rather than as a conflict.
//
// PROVENANCE of each ported construct — what it is, and where it came from:
//   js/html_actuator.js L127-L133  `message(won)`: the `game-won`/`game-over`
//                                  class and the `You win!`/`Game over!` copy,
//                                  carried by `TERMINAL_STATE_CLASSES` and
//                                  `TERMINAL_STATE_MESSAGES`
//   js/html_actuator.js L131       `classList.add(type)`
//   js/html_actuator.js L132       `getElementsByTagName("p")[0]`, resolved
//                                  here through the guarded `resolveMount` of
//                                  ../a11y/settings (I12)
//   js/html_actuator.js L135-L139  `clearMessage()`: two separate class
//                                  removals, kept separate
//   js/html_actuator.js L27-L33    the terminal branch of `actuate()`: `over`
//                                  tested FIRST, the win verdict reached only
//                                  through `else if (metadata.won)`, carried by
//                                  `resolveTerminalState`
//   js/html_actuator.js L38-L41    `continueGame()`, the one path serving both
//                                  js/game_manager.js L19 `restart` and L26
//                                  `keepPlaying`, carried by `clear()`
//   js/game_manager.js L30-L32     `isGameTerminated()`:
//                                  `over || (won && !keepPlaying)`, imported
//                                  from ../../engine/terminal-state rather than
//                                  re-derived
//   js/game_manager.js L24-L27     the flag that shadowed its own prototype
//                                  method; the input event name and the
//                                  persisted property stay `keepPlaying`, and
//                                  the engine's in-class flag is
//                                  `continuedPlay`
//   index.html L53-L59             `.game-message`, its `<p>` and the `.lower`
//                                  control row, retained
//   index.html L100               `#screen-game-over`, its `role="dialog"`,
//                                  `aria-modal` and `aria-label`
//   style/main.scss L229, L241     `.keep-playing-button` hidden in the base
//                                  overlay and restored inside `&.game-won`, so
//                                  the state class is what reveals it
//   style/main.scss L234-L235      the overlay cadence, read from
//                                  `OVERLAY_CADENCE` of ../screen-router, which
//                                  reads `motion.fadeIn` of ../../theme/tokens
//   style/_screens.scss            `.screen-panel`, `.screen-verdict`,
//                                  `.screen-text`, `.screen-actions` and
//                                  `.screen-button`, the class vocabulary this
//                                  module composes its panel from
//   .jshintrc L1-L18               two-space indentation, 80-column lines and
//                                  camelCase, followed by authoring discipline
//
// Traceability rows in docs/TRACEABILITY_MATRIX.md:
//   TR-GAMEOVER-01  js/html_actuator.js L127-L133  `message(won)`, its class
//                                                  and its copy
//   TR-GAMEOVER-02  js/html_actuator.js L132       the verdict paragraph, now
//                                                  guarded
//   TR-GAMEOVER-03  js/html_actuator.js L135-L139  `clearMessage()`, both
//                                                  removals kept separate
//   TR-GAMEOVER-04  js/html_actuator.js L27-L33    the loss-before-win ordering
//   TR-GAMEOVER-05  js/html_actuator.js L38-L41    `continueGame()`, serving
//                                                  restart and keep-playing
//   TR-GAMEOVER-06  js/game_manager.js L30-L32     the terminal predicate
//   TR-GAMEOVER-07  target-only row                `createGameOverScreen()` and
//                                                  the five-member lifecycle
//   TR-GAMEOVER-08  target-only row                the rendered verdict panel
//                                                  inside `#screen-game-over`
//   TR-GAMEOVER-09  target-only row                the once-per-entry terminal
//                                                  announcement
//   TR-GAMEOVER-10  target-only row                `reconcile()` and the
//                                                  attachment-based visibility
//                                                  of the per-state controls
//
// Decisions behind this file, argued in docs/DECISION_LOG.md and named here
// only so the construct can be found from the log:
//   DL-GAMEOVER-01  one module serving both terminal states
//   DL-GAMEOVER-02  the verdict panel rendered into `#screen-game-over` beside
//                   the retained `.game-message`
//   DL-GAMEOVER-03  the contract constants re-exported from ../screen-router
//                   rather than restated
//   DL-GAMEOVER-04  an action rendered only where its callback was supplied
//   DL-GAMEOVER-05  the host's accessible name tracked to the verdict and
//                   restored on unmount
//   DL-GAMEOVER-06  the announcement deduplicated per entry rather than per
//                   context
//   DL-GAMEOVER-07  per-state control visibility carried by attachment rather
//                   than by the `hidden` attribute
//   DL-GAMEOVER-08  the opposite verdict's class retired on every overlay write
//   DL-GAMEOVER-09  focus replaced only where a refresh changes the verdict
//
// This module reads no storage, consumes no randomness, draws no board, holds
// no engine reference and imports no observability module: every report it
// raises leaves through the injected `UiReporter` of ../a11y/settings.

import { isGameTerminated } from '../../engine/terminal-state';
import type { BestScoreValue } from '../../engine/types';
import type { Announcement, TerminalVerdict } from '../a11y/live-region';
import type { UiReportFields, UiReporter } from '../a11y/settings';
import {
  NOOP_UI_REPORTER,
  createSafeUiReporter,
  resolveMount,
} from '../a11y/settings';
import { FOCUS_INITIAL_ATTRIBUTE, focusInitial } from '../a11y/focus-manager';
import type {
  Screen,
  ScreenContext,
  TerminalScreenName,
} from '../screen-router';
import {
  OVERLAY_CADENCE,
  TERMINAL_OVERLAY_CLASSES,
  TERMINAL_OVERLAY_COPY,
  TERMINAL_OVERLAY_SELECTOR,
  TERMINAL_OVERLAY_TEXT_SELECTOR,
  TERMINAL_VERDICTS_BY_SCREEN,
} from '../screen-router';

/* ==========================================================================
 * 1. Names carried into reports
 * ========================================================================== */

/** Context label attached to every report this module raises. */
export const GAME_OVER_CONTEXT = 'screen-game-over';

/** Counter raised once when the panel is built. */
const MOUNTED_METRIC = 'ui.gameOver.mounted';

/** Counter raised for each verdict written. */
const VERDICT_METRIC = 'ui.gameOver.verdict';

/** Counter raised for each overlay clear. */
const CLEARED_METRIC = 'ui.gameOver.cleared';

/** Counter raised for each announcement handed to the announcer. */
const ANNOUNCE_METRIC = 'ui.gameOver.announce';

/** Counter raised for each focus placement requested. */
const FOCUS_METRIC = 'ui.gameOver.focus';

/** Counter raised for each action press forwarded to a callback. */
const ACTION_METRIC = 'ui.gameOver.action';

/** Counter raised for each action the state declares and no callback serves. */
const ACTION_UNAVAILABLE_METRIC = 'ui.gameOver.action.unavailable';

/** Counter raised for each lifecycle call carrying a context it cannot use. */
const CONTEXT_REJECTED_METRIC = 'ui.gameOver.context.rejected';

/** Counter raised where the injected cadence differs from the token cadence. */
const CADENCE_DRIFT_METRIC = 'ui.gameOver.cadence.drift';

/** Counter raised for each call made after `destroy()`. */
const AFTER_DESTROY_METRIC = 'ui.gameOver.after_destroy';

/** Counter raised where an injected port member raised. */
const PORT_ERROR_METRIC = 'ui.gameOver.port.error';

/* ==========================================================================
 * 2. The verbatim contract
 * ========================================================================== */

/**
 * The two terminal states, in the order `TERMINAL_OVERLAY_CLASSES` keys them.
 *
 * Both are served by this one module, which is what the screen-flow figure of
 * docs/architecture/ documents as its seven-states-to-six-modules mapping.
 */
export const TERMINAL_STATES = Object.freeze([
  'won',
  'gameOver',
] as const satisfies readonly TerminalScreenName[]);

/**
 * The two classes js/html_actuator.js L128 computed, and the two strings L129
 * computed, pinned as types.
 *
 * The annotation is the enforcement: the VALUES come from ../screen-router, so
 * the router, the HUD and this module cannot drift from one another, and the
 * literals below are the compile-time assertion that what arrives from there is
 * still exactly what the retired actuator wrote. A change to either shared
 * constant fails this file rather than reaching a screen.
 */
type PinnedOverlayClasses = {
  readonly won: 'game-won';
  readonly gameOver: 'game-over';
};

type PinnedOverlayCopy = {
  readonly won: 'You win!';
  readonly gameOver: 'Game over!';
};

/** The two classes js/html_actuator.js L128 computed, verbatim. */
export const TERMINAL_STATE_CLASSES: PinnedOverlayClasses =
  TERMINAL_OVERLAY_CLASSES;

/** The two strings js/html_actuator.js L129 computed, verbatim. */
export const TERMINAL_STATE_MESSAGES: PinnedOverlayCopy = TERMINAL_OVERLAY_COPY;

/** Selector the retained overlay is found at, as index.html L53 declares it. */
export const GAME_OVER_OVERLAY_SELECTOR = TERMINAL_OVERLAY_SELECTOR;

/**
 * Selector the overlay's verdict paragraph is found at, inside the overlay.
 *
 * Evaluated against the overlay, so it resolves the first `<p>` descendant in
 * document order — the element js/html_actuator.js L132 reached as
 * `getElementsByTagName("p")[0]`.
 */
export const GAME_OVER_VERDICT_SELECTOR = TERMINAL_OVERLAY_TEXT_SELECTOR;

/**
 * The frozen overlay cadence of style/main.scss L234-L235: a `fade-in` whose
 * duration and delay both come from `motion.fadeIn` of ../../theme/tokens,
 * where the delay is `transitionSpeed * 12`.
 *
 * Read through `OVERLAY_CADENCE` of ../screen-router. NEITHER VALUE IS RESTATED
 * IN THIS FILE, as a numeral or otherwise, and neither is retimed. `total` is
 * the interval an assertion on the overlay has to clear, which is what the
 * recorded-gameplay gate's waits are calibrated to.
 */
export const GAME_OVER_CADENCE = OVERLAY_CADENCE;

/** The verdict each state announces, as ../a11y/live-region names it. */
export const TERMINAL_VERDICTS = TERMINAL_VERDICTS_BY_SCREEN;

/**
 * The two flags js/html_actuator.js L27-L33 branched on, per terminal state.
 *
 * Present so a lifecycle call carrying only the router's state name resolves
 * through the same `resolveTerminalState` a commit's own flags resolve through,
 * and the loss-before-win ordering is therefore applied on every path rather
 * than on one of them.
 */
export const TERMINAL_FLAGS_BY_STATE = Object.freeze({
  won: Object.freeze({ over: false, won: true, terminated: true }),
  gameOver: Object.freeze({ over: true, won: false, terminated: true }),
} as const satisfies Readonly<Record<TerminalScreenName, TerminalFlags>>);

/**
 * The actions each terminal state offers, as the `TRANSITIONS` table of
 * ../screen-router declares its outgoing edges: `won` takes `keepPlaying` and
 * `endRun`, `gameOver` takes `acknowledge`.
 *
 * No action is invented: a state offers exactly the edges the table declares.
 */
export const TERMINAL_ACTIONS_BY_STATE = Object.freeze({
  won: Object.freeze(['keepPlaying', 'endRun'] as const),
  gameOver: Object.freeze(['acknowledge'] as const),
} as const satisfies Readonly<Record<TerminalScreenName, readonly string[]>>);

/** One action a terminal state offers. */
export type GameOverAction =
  (typeof TERMINAL_ACTIONS_BY_STATE)[TerminalScreenName][number];

/** Attribute each rendered control carries its action in. */
export const GAME_OVER_ACTION_ATTRIBUTE = 'data-action';

/* ==========================================================================
 * 3. Class names this module writes
 * ========================================================================== */

/**
 * The panel classes, every one declared by style/_screens.scss. None is
 * invented here and none carries a value of its own: geometry, colour, radius
 * and duration all resolve in the stylesheet, from ../../theme/tokens.
 */
export const GAME_OVER_CLASSES = Object.freeze({
  panel: 'screen-panel',
  verdict: 'screen-verdict',
  text: 'screen-text',
  actions: 'screen-actions',
  button: 'screen-button',
} as const);

/* ==========================================================================
 * 4. Copy
 * ========================================================================== */

/**
 * Everything this screen writes as prose.
 *
 * `wonVerdict` and `lossVerdict` are the two strings js/html_actuator.js L129
 * wrote, taken from `TERMINAL_STATE_MESSAGES` so the panel heading and the
 * retained overlay's paragraph cannot say different things. The remainder has
 * no vanilla source: the vanilla overlay showed a verdict and two controls and
 * no score.
 */
export const gameOverCopy = Object.freeze({
  wonVerdict: TERMINAL_STATE_MESSAGES.won,
  lossVerdict: TERMINAL_STATE_MESSAGES.gameOver,

  /** Accessible name the host carries in each state. */
  wonLabel: 'You win',
  lossLabel: 'Game over',

  /** Score readout, composed with the two values a commit carried. */
  score: (score: number, bestScore: string): string =>
    `Score ${String(score)}. Best ${bestScore}.`,

  /** Labels of the three actions the `TRANSITIONS` table declares. */
  keepPlaying: 'Keep going',
  endRun: 'End run',
  acknowledge: 'See run summary',
} as const);

/** The prose this screen writes. Every member may be replaced. */
export type GameOverCopy = typeof gameOverCopy;

/**
 * Merges caller overrides over the defaults.
 *
 * @param overrides Members to replace, or `undefined` for none.
 * @returns The effective copy, frozen.
 */
function mergeCopy(overrides: Partial<GameOverCopy> | undefined): GameOverCopy {
  if (overrides === undefined) {
    return gameOverCopy;
  }

  return Object.freeze({
    wonVerdict: overrides.wonVerdict ?? gameOverCopy.wonVerdict,
    lossVerdict: overrides.lossVerdict ?? gameOverCopy.lossVerdict,
    wonLabel: overrides.wonLabel ?? gameOverCopy.wonLabel,
    lossLabel: overrides.lossLabel ?? gameOverCopy.lossLabel,
    score: overrides.score ?? gameOverCopy.score,
    keepPlaying: overrides.keepPlaying ?? gameOverCopy.keepPlaying,
    endRun: overrides.endRun ?? gameOverCopy.endRun,
    acknowledge: overrides.acknowledge ?? gameOverCopy.acknowledge,
  });
}

/* ==========================================================================
 * 5. The terminal resolution
 * ========================================================================== */

/**
 * The flags a verdict is resolved from, as js/game_manager.js L91-L97 placed
 * them in the actuation payload and ../../engine/engine-events carries them on
 * a `state:commit`.
 *
 * `terminated` is optional: supplied, it is used as given, which is what
 * js/html_actuator.js L27 read; absent, it is computed by the imported
 * `isGameTerminated`, whose `continuedPlay` is the engine's in-class name for
 * the flag js/game_manager.js L24-L27 held as `keepPlaying`.
 */
export interface TerminalFlags {
  /** Whether the game is lost. js/game_manager.js L93. */
  readonly over: boolean;

  /** Whether the win value has been reached. L94. */
  readonly won: boolean;

  /** Whether play is blocked pending acknowledgement. L96. */
  readonly terminated?: boolean | undefined;

  /** Whether play continued past the win. The engine's renamed flag. */
  readonly continuedPlay?: boolean | undefined;
}

/**
 * Narrows a value to one of the two terminal state names.
 *
 * @param value Candidate name.
 * @returns Whether `value` is one of `TERMINAL_STATES`.
 */
export function isTerminalScreenName(
  value: unknown,
): value is TerminalScreenName {
  return TERMINAL_STATES.some((name): boolean => name === value);
}

/**
 * Resolves which terminal verdict a set of flags produces.
 *
 * js/html_actuator.js L27-L33, ordering preserved exactly: the branch is
 * entered only where the turn is terminal, `over` is tested FIRST, and the win
 * verdict is reached only through `else if (metadata.won)`. A resolution that
 * tested `won` first would invert the verdict on every turn where both flags
 * are set, which a board-mutating relic can produce.
 *
 * @param flags The commit's own terminal flags.
 * @returns The terminal state, or `null` where the run is still in play.
 *
 * @example
 * ```ts
 * resolveTerminalState({ over: true, won: true, terminated: true });
 * // -> 'gameOver', because a loss takes precedence over a win.
 * ```
 */
export function resolveTerminalState(
  flags: TerminalFlags,
): TerminalScreenName | null {
  const terminated =
    flags.terminated ??
    isGameTerminated({
      over: flags.over,
      won: flags.won,
      continuedPlay: flags.continuedPlay ?? false,
    });

  if (!terminated) {
    return null;
  }

  // js/html_actuator.js L28-L32: `over` first, `won` only through the else.
  if (flags.over) {
    return 'gameOver';
  }

  if (flags.won) {
    return 'won';
  }

  return null;
}

/* ==========================================================================
 * 6. What a write produced
 * ========================================================================== */

/** Everything one verdict write put on screen. */
export interface GameOverSnapshot {
  /** The terminal state written. */
  readonly state: TerminalScreenName;

  /** The verdict as ../a11y/live-region names it. */
  readonly verdict: TerminalVerdict;

  /** The class added to the retained overlay. */
  readonly overlayClass: string;

  /** The string written into the overlay's paragraph and the panel heading. */
  readonly message: string;

  /** The score readout written, and the empty string where none was. */
  readonly score: string;

  /** The actions rendered, in the order the state declares them. */
  readonly actions: readonly GameOverAction[];

  /** The cadence in force for this write. */
  readonly cadence: typeof GAME_OVER_CADENCE;
}

/* ==========================================================================
 * 7. Injected ports
 * ========================================================================== */

/**
 * The announcer this screen speaks through. Both members are optional, and the
 * `LiveRegionAnnouncer` of ../a11y/live-region satisfies it as it stands.
 */
export interface GameOverAnnouncerPort {
  announce?(input: Announcement): void;
}

/**
 * The preference source read where a context carries no motion value. The
 * `PreferenceStore` of ../a11y/settings satisfies it as it stands.
 */
export interface GameOverPreferencePort {
  isReducedMotion?(): boolean;
}

/** Every construction parameter. All are optional. */
export interface GameOverScreenOptions {
  /**
   * The retained terminal overlay, as an element or a selector. A selector is
   * resolved against the document; `null` marks an outlet the caller looked for
   * and did not find, and opts this screen out of writing it. Defaults to
   * `GAME_OVER_OVERLAY_SELECTOR`.
   */
  readonly overlay?: Element | string | null;

  /** Document a lookup runs against. Defaults to the ambient document. */
  readonly document?: Document | null;

  /** Sink every miss, every write and every skipped write reports through. */
  readonly reporter?: UiReporter;

  /** The announcer the verdict is announced through. */
  readonly announcer?: GameOverAnnouncerPort;

  /** The preference source read where a context carries no motion value. */
  readonly preferences?: GameOverPreferencePort;

  /** Copy overrides. Any member may be replaced. */
  readonly copy?: Partial<GameOverCopy>;

  /**
   * Whether this screen places focus on entry. Defaults to `true`. `false` is
   * for a composition whose router places focus itself.
   */
  readonly placeFocus?: boolean;

  /**
   * Whether this screen announces the verdict. Defaults to `true`. `false` is
   * for a composition that attaches ../a11y/engine-announcer, which announces
   * the same verdict from the commit.
   */
  readonly announce?: boolean;

  /**
   * Called when the win state's keep-playing control is activated. Absent, the
   * control is not rendered, so nothing offers an action that goes nowhere.
   */
  readonly onKeepPlaying?: () => void;

  /** Called when the win state's end-run control is activated. */
  readonly onEndRun?: () => void;

  /** Called when the loss state's acknowledge control is activated. */
  readonly onAcknowledge?: () => void;
}

/**
 * The mounted screen. Every member is safe to call at any time, before `mount`
 * and after `destroy` included.
 */
export interface GameOverScreen extends Screen {
  /**
   * Writes one verdict, resolved from a commit's own flags through
   * `resolveTerminalState`.
   *
   * @param flags The commit's terminal flags.
   * @param detail The score and best score the readout shows.
   * @returns What was written, or `null` where the flags are not terminal.
   */
  render(
    flags: TerminalFlags,
    detail?: GameOverDetail,
  ): GameOverSnapshot | null;

  /**
   * js/html_actuator.js L38-L41 `continueGame()`: clears the overlay for both
   * the restart and the keep-playing path.
   */
  clear(): void;

  /** What the last write put on screen, or `null` before the first. */
  readRendered(): GameOverSnapshot | null;

  /** Whether the retained overlay resolved. */
  hasOverlay(): boolean;

  /** Whether the panel was built into a host. */
  hasPanel(): boolean;

  /** Whether the state on screen is the one given. */
  isShowing(state: TerminalScreenName): boolean;

  /**
   * Removes what this screen added, restores what it changed, drops every
   * listener it attached and releases its references. Every later call is a
   * reported no-op, and calling it more than once is harmless.
   */
  destroy(): void;
}

/** The two values the score readout shows. */
export interface GameOverDetail {
  readonly score?: number | undefined;
  readonly bestScore?: BestScoreValue | undefined;
}

/* ==========================================================================
 * 8. Small helpers
 * ========================================================================== */

function readAmbientDocument(): Document | null {
  return typeof document === 'undefined' ? null : document;
}

/**
 * Narrows an element to the HTML element whose `classList`, `hidden` and
 * attributes this module writes.
 *
 * @param element Element to narrow, or `null`.
 * @returns The element, or `null` where it carries no `classList` to write.
 */
function asHtmlElement(element: Element | null): HTMLElement | null {
  if (element === null) {
    return null;
  }

  return 'classList' in element ? (element as HTMLElement) : null;
}

/**
 * Renders a best score for display without coercing the stored value.
 *
 * `BestScoreValue` is the port's own return type: the raw stored STRING when a
 * value is present and the number `0` when it is absent, which is what
 * js/local_storage_manager.js L43-L45 returned. The value is stringified for
 * display only and is never compared, widened or written back from here.
 *
 * A value that is neither a string nor a finite number renders as the empty
 * string, so nothing puts `null` or `undefined` on screen as text.
 *
 * @param bestScore The value a commit carried.
 * @returns The text to display.
 */
function formatBestScore(bestScore: BestScoreValue | undefined): string {
  if (typeof bestScore === 'string') {
    return bestScore;
  }

  if (typeof bestScore === 'number' && Number.isFinite(bestScore)) {
    return String(bestScore);
  }

  return '';
}

/**
 * Renders a score for display, defaulting to nothing rather than to `NaN`.
 *
 * @param score The value a commit carried.
 * @returns The number to display, or `null` where none is usable.
 */
function usableScore(score: number | undefined): number | null {
  return typeof score === 'number' && Number.isFinite(score) ? score : null;
}

/**
 * Narrows a lifecycle context to one of the two terminal contexts.
 *
 * @param context Context a lifecycle member received.
 * @returns The terminal state it describes, or `null`.
 */
function terminalStateOf(context: ScreenContext): TerminalScreenName | null {
  return isTerminalScreenName(context.screen) ? context.screen : null;
}

/**
 * Reads the score and best score a terminal context carries.
 *
 * @param context Context a lifecycle member received.
 * @returns The two values, each absent where the context carries none.
 */
function detailOf(context: ScreenContext): GameOverDetail {
  if ('score' in context && 'bestScore' in context) {
    return { score: context.score, bestScore: context.bestScore };
  }

  return {};
}

/* ==========================================================================
 * 9. Construction
 * ========================================================================== */

/**
 * Mounts the terminal-verdict screen for both `won` and `gameOver`.
 *
 * Nothing is read or written at import time: the overlay lookup, the panel
 * build and every report happen inside the lifecycle. An absent outlet is
 * reported and its writes are skipped; the outlet that did resolve keeps
 * working, so a missing panel host does not stop the retained overlay being
 * written and a missing overlay does not stop the panel being rendered.
 *
 * @param options Outlets, document, ports, copy and action callbacks.
 * @returns The screen, whether or not every outlet resolved.
 *
 * @example
 * ```ts
 * const gameOver = createGameOverScreen({
 *   onKeepPlaying: () => router.send('keepPlaying'),
 *   onEndRun: () => router.send('endRun'),
 *   onAcknowledge: () => router.send('acknowledge'),
 * });
 *
 * const router = createScreenRouter({
 *   screens: { won: gameOver, gameOver },
 * });
 * ```
 */
export function createGameOverScreen(
  options: GameOverScreenOptions = {},
): GameOverScreen {
  const reporter = createSafeUiReporter(options.reporter ?? NOOP_UI_REPORTER);
  const copy = mergeCopy(options.copy);
  const owner = options.document ?? readAmbientDocument();
  const shouldPlaceFocus = options.placeFocus ?? true;
  const shouldAnnounce = options.announce ?? true;

  /** Callbacks keyed by the action each serves, absent where none was given. */
  const handlers: Readonly<
    Partial<Record<GameOverAction, () => void>>
  > = Object.freeze({
    ...(options.onKeepPlaying === undefined
      ? {}
      : { keepPlaying: options.onKeepPlaying }),
    ...(options.onEndRun === undefined ? {} : { endRun: options.onEndRun }),
    ...(options.onAcknowledge === undefined
      ? {}
      : { acknowledge: options.onAcknowledge }),
  });

  /**
   * The retained `.game-message`, resolved once.
   *
   * The guarded form of js/html_actuator.js L5, which read
   * `document.querySelector(".game-message")` with no check and then wrote
   * through the result unconditionally at L131 and L137.
   */
  const overlay: HTMLElement | null = ((): HTMLElement | null => {
    const supplied = options.overlay;

    if (supplied === null) {
      reporter.log('info', 'the terminal overlay was supplied as absent', {
        context: GAME_OVER_CONTEXT,
      });

      return null;
    }

    if (supplied !== undefined && typeof supplied !== 'string') {
      return asHtmlElement(supplied);
    }

    return asHtmlElement(
      resolveMount<HTMLElement>(supplied ?? GAME_OVER_OVERLAY_SELECTOR, {
        root: owner,
        reporter,
        context: GAME_OVER_CONTEXT,
        name: 'terminal-overlay',
      }),
    );
  })();

  let host: HTMLElement | null = null;
  let panel: HTMLElement | null = null;
  let verdictNode: HTMLElement | null = null;
  let scoreNode: HTMLElement | null = null;
  let actionRow: HTMLElement | null = null;
  let hostLabel: string | null = null;
  let hostLabelWritten = false;
  let rendered: GameOverSnapshot | null = null;
  let announced: TerminalScreenName | null = null;
  let destroyed = false;

  /** The controls built, keyed by the action each invokes. */
  const controls = new Map<GameOverAction, HTMLButtonElement>();

  /** Removers for every listener attached, drained by `destroy()`. */
  const listeners: Array<() => void> = [];

  /**
   * Calls an injected port member without letting its throw reach the router.
   *
   * ../screen-router already contains a lifecycle throw, so this is the second
   * boundary rather than the only one: a port that raises leaves the DOM writes
   * this screen has already made intact.
   *
   * @param member Name carried into the report.
   * @param call The call to attempt.
   */
  const guard = (member: string, call: () => void): void => {
    try {
      call();
    } catch (error) {
      reporter.count(PORT_ERROR_METRIC, { member });
      reporter.error('a game-over port call raised', error, {
        context: GAME_OVER_CONTEXT,
        member,
      });
    }
  };

  /**
   * Reports a call made after `destroy()` and answers whether to proceed.
   *
   * @param member Name carried into the report.
   * @returns Whether this screen has been destroyed.
   */
  const isDestroyed = (member: string): boolean => {
    if (destroyed) {
      reporter.count(AFTER_DESTROY_METRIC, { member });
    }

    return destroyed;
  };

  /* ------------------------------------------------------------------------
   * The panel
   * ---------------------------------------------------------------------- */

  /**
   * Builds one control for an action, and nothing where no callback serves it.
   *
   * A real `<button type="button">`, never an anchor: `.screen-button` of
   * style/_screens.scss draws it and supplies the focus ring, and Enter and
   * Space both activate a button natively, so no key handling is added here.
   *
   * @param action The action the control invokes.
   * @param label The control's visible and accessible text.
   * @returns The control, or `null` where the action has no callback.
   */
  const buildControl = (
    action: GameOverAction,
    label: string,
  ): HTMLButtonElement | null => {
    const handler = handlers[action];

    if (handler === undefined || owner === null) {
      reporter.count(ACTION_UNAVAILABLE_METRIC, { action });

      return null;
    }

    const control = owner.createElement('button');

    control.type = 'button';
    control.classList.add(GAME_OVER_CLASSES.button);
    control.setAttribute(GAME_OVER_ACTION_ATTRIBUTE, action);
    control.textContent = label;

    const press = (): void => {
      if (isDestroyed('action')) {
        return;
      }

      reporter.count(ACTION_METRIC, { action });
      guard(action, handler);
    };

    control.addEventListener('click', press);
    listeners.push((): void => {
      control.removeEventListener('click', press);
    });

    return control;
  };

  /**
   * Builds the verdict panel into the injected host, once.
   *
   * Every class is one style/_screens.scss declares for
   * `.screen[data-screen="game-over"]`; this module writes no colour, spacing,
   * radius, duration or stacking value of its own, and the fade cadence stays
   * with the stylesheet.
   */
  const buildPanel = (): void => {
    if (host === null || owner === null || panel !== null) {
      return;
    }

    const built = owner.createElement('div');

    built.classList.add(GAME_OVER_CLASSES.panel);

    const heading = owner.createElement('h2');

    heading.classList.add(GAME_OVER_CLASSES.verdict);

    const readout = owner.createElement('p');

    readout.classList.add(GAME_OVER_CLASSES.text);

    const row = owner.createElement('div');

    row.classList.add(GAME_OVER_CLASSES.actions);

    const labels: Readonly<Record<GameOverAction, string>> = Object.freeze({
      keepPlaying: copy.keepPlaying,
      endRun: copy.endRun,
      acknowledge: copy.acknowledge,
    });

    // Built once and held DETACHED. A state's own controls are attached by
    // `showActionsFor`, so a control the state does not offer is not in the
    // document at all.
    for (const state of TERMINAL_STATES) {
      for (const action of TERMINAL_ACTIONS_BY_STATE[state]) {
        if (controls.has(action)) {
          continue;
        }

        const control = buildControl(action, labels[action]);

        if (control !== null) {
          controls.set(action, control);
        }
      }
    }

    built.append(heading);
    host.append(built);

    panel = built;
    verdictNode = heading;
    scoreNode = readout;
    actionRow = row;

    reporter.count(MOUNTED_METRIC, {
      panel: true,
      overlay: overlay !== null,
      controls: controls.size,
    });
  };

  /* ------------------------------------------------------------------------
   * The retained overlay
   * ---------------------------------------------------------------------- */

  /**
   * js/html_actuator.js L127-L133 `message(won)`, with the paragraph lookup
   * guarded: the source read `getElementsByTagName("p")[0]` and wrote through
   * the result with no check.
   *
   * The class is added whether or not the paragraph resolves, because the class
   * is what style/main.scss L232-L248 fades in and what reveals
   * `.keep-playing-button` inside `&.game-won`. Adding a class already present
   * is the no-op `classList.add` defines it to be, which is what makes this
   * safe to run after another actor has written the same value.
   *
   * The OPPOSITE verdict's class is retired first, so exactly one state class
   * is ever attached. Decision DL-GAMEOVER-08. js/html_actuator.js L131 only
   * added: the vanilla actuator reached one terminal state from the other only
   * with `clearMessage()` L135-L139 in between, and the in-state refresh path
   * here reaches it without. `&.game-won` at style/main.scss L241 is the one
   * rule that reveals `.keep-playing-button`.
   *
   * @param state The terminal state whose class and copy are written.
   * @param message The verdict string to write.
   * @returns Whether the paragraph resolved.
   */
  const writeOverlay = (
    state: TerminalScreenName,
    message: string,
  ): boolean => {
    if (overlay === null) {
      return false;
    }

    overlay.classList.remove(
      TERMINAL_STATE_CLASSES[state === 'won' ? 'gameOver' : 'won'],
    );
    overlay.classList.add(TERMINAL_STATE_CLASSES[state]);

    const paragraph = resolveMount<HTMLElement>(GAME_OVER_VERDICT_SELECTOR, {
      root: overlay,
      reporter,
      context: GAME_OVER_CONTEXT,
      name: 'terminal-verdict',
    });

    if (paragraph === null) {
      reporter.log('warn', 'the terminal overlay holds no verdict paragraph', {
        context: GAME_OVER_CONTEXT,
        selector: GAME_OVER_VERDICT_SELECTOR,
        screen: state,
      });

      return false;
    }

    paragraph.textContent = message;

    return true;
  };

  /**
   * js/html_actuator.js L135-L139 `clearMessage()`.
   *
   * Both classes are removed, and as TWO separate calls: L136 records that IE
   * only takes one value to remove at a time.
   */
  const clearOverlay = (): void => {
    if (overlay === null) {
      return;
    }

    // IE only takes one value to remove at a time.
    overlay.classList.remove(TERMINAL_STATE_CLASSES.won);
    overlay.classList.remove(TERMINAL_STATE_CLASSES.gameOver);
  };

  /* ------------------------------------------------------------------------
   * Host semantics
   * ---------------------------------------------------------------------- */

  /**
   * Tracks the host's accessible name to the verdict on screen.
   *
   * index.html L100 declares `#screen-game-over` with `role="dialog"`,
   * `aria-modal="true"` and a fixed `aria-label`; that one container serves
   * both verdicts, so the name is written per state and the declared value is
   * restored by `destroy()`. No role and no other ARIA attribute is added.
   *
   * @param state The terminal state on screen.
   */
  const writeHostLabel = (state: TerminalScreenName): void => {
    if (host === null) {
      return;
    }

    if (!hostLabelWritten) {
      hostLabel = host.getAttribute('aria-label');
      hostLabelWritten = true;
    }

    if (hostLabel === null) {
      return;
    }

    host.setAttribute(
      'aria-label',
      state === 'won' ? copy.wonLabel : copy.lossLabel,
    );
  };

  /** Restores the accessible name index.html declared. */
  const restoreHostLabel = (): void => {
    if (host === null || !hostLabelWritten || hostLabel === null) {
      return;
    }

    host.setAttribute('aria-label', hostLabel);
  };

  /* ------------------------------------------------------------------------
   * The panel's per-state content
   * ---------------------------------------------------------------------- */

  /**
   * Reconciles a container's children against the list wanted, in order.
   *
   * ATTACHMENT IS THE MECHANISM, NOT THE `hidden` ATTRIBUTE. Decision
   * DL-GAMEOVER-07. The cascade facts it rests on:
   * style/main.scss L237-L245 is the hidden half of the attribute protocol and
   * enumerates the elements it covers, and `.screen-button` is not among them;
   * `@mixin screen-control` of style/_screens.scss declares
   * `display: inline-block` on `.screen-button`, and `@mixin screen-content`
   * declares it again for a `button` inside
   * `.screen[data-screen="game-over"]`; both are author origin and outrank the
   * user-agent `[hidden]` rule, which is the outcome that same block records in
   * terms. A detached control is absent from the rendering, from the tab order
   * and from the accessibility tree.
   *
   * A container already holding exactly `wanted`, in order, is left untouched,
   * so an in-state refresh moves no focus and mutates no node.
   *
   * @param container Container to reconcile.
   * @param wanted The children it is to hold, in order.
   * @returns Whether the document was changed.
   */
  const reconcile = (
    container: HTMLElement,
    wanted: readonly HTMLElement[],
  ): boolean => {
    const current = Array.from(container.children);
    const settled =
      current.length === wanted.length &&
      wanted.every((node, index): boolean => current[index] === node);

    if (settled) {
      return false;
    }

    for (const node of current) {
      node.remove();
    }

    for (const node of wanted) {
      container.append(node);
    }

    return true;
  };

  /**
   * Attaches the controls the state declares, in declaration order, and
   * detaches every other one.
   *
   * `.keep-playing-button` inside the retained overlay is NOT touched here: its
   * visibility belongs to `&.game-won` at style/main.scss L241, which the state
   * class has already applied. This module writes nothing on that element.
   *
   * @param state The terminal state on screen.
   * @returns The actions attached, in declaration order.
   */
  const showActionsFor = (
    state: TerminalScreenName,
  ): readonly GameOverAction[] => {
    const shown: GameOverAction[] = [];
    const wanted: HTMLButtonElement[] = [];

    for (const action of TERMINAL_ACTIONS_BY_STATE[state]) {
      const control = controls.get(action);

      if (control !== undefined) {
        shown.push(action);
        wanted.push(control);
      }
    }

    if (actionRow !== null) {
      reconcile(actionRow, wanted);
    }

    for (const control of controls.values()) {
      control.removeAttribute(FOCUS_INITIAL_ATTRIBUTE);
    }

    // The first control the state declares is the placement target, so a
    // router-driven placement that passes no explicit target lands on the same
    // element this screen would have chosen.
    wanted[0]?.setAttribute(FOCUS_INITIAL_ATTRIBUTE, '');

    if (shown.length === 0) {
      reporter.log('warn', 'the terminal state offers no action', {
        context: GAME_OVER_CONTEXT,
        screen: state,
      });
    }

    return Object.freeze(shown);
  };

  /**
   * Writes the panel's heading and score readout, and settles its child order.
   *
   * The heading is always attached. The readout is attached only where a score
   * arrived and the action row only where the state attached a control, so the
   * panel never carries an empty element and never spends a gap on one.
   *
   * @param state The terminal state on screen.
   * @param message The verdict string.
   * @param detail The two values the readout shows.
   * @returns The readout text written, and the empty string where none was.
   */
  const writePanel = (
    state: TerminalScreenName,
    message: string,
    detail: GameOverDetail,
  ): string => {
    if (panel === null || verdictNode === null || scoreNode === null) {
      reporter.log('warn', 'the game-over panel was not built', {
        context: GAME_OVER_CONTEXT,
        screen: state,
      });

      return '';
    }

    verdictNode.textContent = message;

    const score = usableScore(detail.score);
    const best = formatBestScore(detail.bestScore);
    const readout = score === null ? '' : copy.score(score, best);

    scoreNode.textContent = readout;

    const parts: HTMLElement[] = [verdictNode];

    if (readout !== '') {
      parts.push(scoreNode);
    }

    if (actionRow !== null && actionRow.children.length > 0) {
      parts.push(actionRow);
    }

    reconcile(panel, parts);

    return readout;
  };

  /* ------------------------------------------------------------------------
   * Focus and the announcement
   * ---------------------------------------------------------------------- */

  /**
   * Reads the reduced-motion value in force for a call.
   *
   * A context's own value is used where one arrived, because the router reads
   * it at the moment of the transition; otherwise the injected preference
   * source is asked, and where neither supplies one, motion is allowed and
   * style/_a11y.scss's `prefers-reduced-motion` layer remains the visual
   * authority either way.
   *
   * @param supplied A context's value, where one arrived.
   * @returns Whether motion is to be reduced.
   */
  const readReducedMotion = (supplied?: boolean): boolean => {
    if (typeof supplied === 'boolean') {
      return supplied;
    }

    let reduced = false;

    guard('isReducedMotion', (): void => {
      reduced = options.preferences?.isReducedMotion?.() ?? false;
    });

    return reduced;
  };

  /**
   * Places focus for the state just entered.
   *
   * The explicit target is the first control the state declares, which takes
   * precedence over every step of the chain in ../a11y/focus-manager; the same
   * element also carries the marker attribute, so a placement made by the
   * router resolves to it too.
   *
   * @param state The terminal state entered.
   * @param actions The actions shown.
   * @param reducedMotion Whether motion is to be reduced.
   */
  const placeFocus = (
    state: TerminalScreenName,
    actions: readonly GameOverAction[],
    reducedMotion: boolean,
  ): void => {
    if (!shouldPlaceFocus || host === null) {
      return;
    }

    const first = actions[0];
    const target = first === undefined ? null : (controls.get(first) ?? null);
    const placement = focusInitial(state, host, {
      reporter,
      context: GAME_OVER_CONTEXT,
      reducedMotion,
      initialFocus: target,
    });

    reporter.count(FOCUS_METRIC, {
      screen: state,
      source: placement.source,
      focused: placement.focused,
    });
  };

  /**
   * Announces the verdict, once per entry into a state.
   *
   * The `terminal` announcement of ../a11y/live-region carries primitive fields
   * only and is written with that module's assertive polarity. The last state
   * announced is held, so a refresh arriving while the same state stands
   * announces nothing; `leave()` releases it, so a later entry into the same
   * state announces again.
   *
   * @param state The terminal state entered or refreshed.
   * @param detail The score the announcement carries.
   */
  const announce = (
    state: TerminalScreenName,
    detail: GameOverDetail,
  ): void => {
    if (!shouldAnnounce || announced === state) {
      return;
    }

    announced = state;

    const port = options.announcer;

    if (port?.announce === undefined) {
      return;
    }

    const score = usableScore(detail.score);
    const verdict: TerminalVerdict = TERMINAL_VERDICTS[state];

    guard('announce', (): void => {
      port.announce?.({
        kind: 'terminal',
        verdict,
        ...(score === null ? {} : { score }),
      });
    });

    reporter.count(ANNOUNCE_METRIC, { screen: state, verdict });
  };

  /* ------------------------------------------------------------------------
   * The one write path
   * ---------------------------------------------------------------------- */

  /**
   * Writes one verdict to both surfaces.
   *
   * Idempotent by construction: `classList.add` of a class already present, an
   * identical `textContent` assignment and an identical `hidden` assignment are
   * all no-ops, so re-applying the state on screen changes nothing and appends
   * nothing. The announcement is gated separately, by the state last announced.
   *
   * @param state The terminal state to write.
   * @param detail The two values the readout shows.
   * @returns What was written.
   */
  const apply = (
    state: TerminalScreenName,
    detail: GameOverDetail,
  ): GameOverSnapshot => {
    const message = state === 'won' ? copy.wonVerdict : copy.lossVerdict;

    writeHostLabel(state);

    const actions = showActionsFor(state);
    const score = writePanel(state, message, detail);
    const paragraph = writeOverlay(state, message);

    reporter.count(VERDICT_METRIC, {
      screen: state,
      paragraph,
      actions: actions.length,
    });

    const snapshot: GameOverSnapshot = Object.freeze({
      state,
      verdict: TERMINAL_VERDICTS[state],
      overlayClass: TERMINAL_STATE_CLASSES[state],
      message,
      score,
      actions,
      cadence: GAME_OVER_CADENCE,
    });

    rendered = snapshot;

    return snapshot;
  };

  /**
   * Reports a cadence carried by a context that differs from the token one.
   *
   * The recorded-gameplay gate's waits are calibrated to
   * `GAME_OVER_CADENCE.total`, so a divergence between the router's cadence and
   * ../../theme/tokens is surfaced rather than absorbed.
   *
   * @param context Context a lifecycle member received.
   */
  const checkCadence = (context: ScreenContext): void => {
    if (!('cadence' in context)) {
      return;
    }

    const carried = context.cadence;

    if (
      carried.delay === GAME_OVER_CADENCE.delay &&
      carried.duration === GAME_OVER_CADENCE.duration
    ) {
      return;
    }

    reporter.count(CADENCE_DRIFT_METRIC, {
      delay: carried.delay,
      duration: carried.duration,
    });
    reporter.log('warn', 'the injected overlay cadence is not the token one', {
      context: GAME_OVER_CONTEXT,
      expectedDelay: GAME_OVER_CADENCE.delay,
      expectedDuration: GAME_OVER_CADENCE.duration,
    });
  };

  /**
   * Rejects a lifecycle context this screen cannot serve.
   *
   * @param member Name carried into the report.
   * @param context Context the member received.
   * @returns The terminal state, or `null` where the context is not terminal.
   */
  const acceptContext = (
    member: string,
    context: ScreenContext,
  ): TerminalScreenName | null => {
    const named = terminalStateOf(context);

    if (named === null) {
      const fields: UiReportFields = {
        context: GAME_OVER_CONTEXT,
        member,
        screen: String(context.screen),
      };

      reporter.count(CONTEXT_REJECTED_METRIC, { member });
      reporter.log('warn', 'a non-terminal context reached game over', fields);

      return null;
    }

    checkCadence(context);

    // The router's state name is expressed as the two flags
    // js/html_actuator.js L27-L33 branched on and resolved through the same
    // function a commit's own flags take, so the loss-before-win ordering is
    // applied on every path into this screen rather than on one of them.
    return resolveTerminalState(TERMINAL_FLAGS_BY_STATE[named]);
  };

  /**
   * Detaches every control this screen owns and drops the placement marker.
   *
   * `.keep-playing-button` and `.retry-button` are NOT reached: those two are
   * bound by src/input/on-screen-controls.ts and revealed by `&.game-won` at
   * style/main.scss L241, so clearing the state class is the whole of what puts
   * them down.
   */
  const retractControls = (): void => {
    for (const control of controls.values()) {
      control.remove();
      control.removeAttribute(FOCUS_INITIAL_ATTRIBUTE);
    }

    actionRow?.remove();
    scoreNode?.remove();
  };

  /**
   * js/html_actuator.js L38-L41 `continueGame()`: the one clear path,
   * reached by both js/game_manager.js L19 `restart` and L26 `keepPlaying`.
   *
   * @param member Name carried into the report.
   */
  const clearAll = (member: string): void => {
    clearOverlay();
    restoreHostLabel();
    retractControls();

    if (scoreNode !== null) {
      scoreNode.textContent = '';
    }

    if (verdictNode !== null) {
      verdictNode.textContent = '';
    }

    rendered = null;
    announced = null;
    reporter.count(CLEARED_METRIC, { member });
  };

  /**
   * Removes what this screen added and restores what it changed.
   *
   * Declared as a closure rather than reached through `this`, so a member that
   * has been destructured off the returned object still tears down correctly.
   */
  const teardown = (): void => {
    if (destroyed) {
      return;
    }

    destroyed = true;

    clearOverlay();
    restoreHostLabel();

    for (const remove of listeners) {
      remove();
    }

    listeners.length = 0;
    controls.clear();

    // Only what this module appended is removed; the retained markup of
    // index.html L53-L59 and L100 is left as it was found.
    panel?.remove();

    panel = null;
    verdictNode = null;
    scoreNode = null;
    actionRow = null;
    host = null;
    hostLabel = null;
    hostLabelWritten = false;
    rendered = null;
    announced = null;
  };

  /* ------------------------------------------------------------------------
   * The lifecycle
   * ---------------------------------------------------------------------- */

  return Object.freeze({
    mount(injected: Element): void {
      if (isDestroyed('mount') || panel !== null) {
        return;
      }

      const resolved = asHtmlElement(injected);

      if (resolved === null) {
        reporter.log('warn', 'the injected game-over host is not writable', {
          context: GAME_OVER_CONTEXT,
        });
        reporter.count(MOUNTED_METRIC, {
          panel: false,
          overlay: overlay !== null,
          controls: 0,
        });

        return;
      }

      host = resolved;
      buildPanel();
    },

    enter(context: ScreenContext): void {
      if (isDestroyed('enter')) {
        return;
      }

      const state = acceptContext('enter', context);

      if (state === null) {
        return;
      }

      const detail = detailOf(context);
      const snapshot = apply(state, detail);
      const reducedMotion = readReducedMotion(context.reducedMotion);

      placeFocus(state, snapshot.actions, reducedMotion);
      announce(state, detail);
    },

    update(context: ScreenContext): void {
      if (isDestroyed('update')) {
        return;
      }

      const state = acceptContext('update', context);

      if (state === null) {
        return;
      }

      const detail = detailOf(context);
      const previous = rendered === null ? null : rendered.state;
      const snapshot = apply(state, detail);

      // The in-state refresh path: re-applying the verdict on screen is a
      // no-op and moves no focus. A refresh carrying the OTHER verdict is a
      // state change, and the control that held focus has been detached by the
      // time this runs, so focus is placed again. Decision DL-GAMEOVER-09.
      if (previous !== null && previous !== state) {
        placeFocus(
          state,
          snapshot.actions,
          readReducedMotion(context.reducedMotion),
        );
      }

      announce(state, detail);
    },

    leave(): void {
      if (isDestroyed('leave')) {
        return;
      }

      // The overlay is cleared on the way out of BOTH terminal states, so the
      // keep-playing exit and the restart exit leave the same clean surface —
      // which is the single behaviour js/html_actuator.js L38-L41 gave them.
      // The last verdict announced is released here, so a later entry into the
      // same state is news again.
      clearOverlay();
      restoreHostLabel();
      retractControls();

      announced = null;
      reporter.count(CLEARED_METRIC, { member: 'leave' });
    },

    unmount(): void {
      teardown();
    },

    render(
      flags: TerminalFlags,
      detail: GameOverDetail = {},
    ): GameOverSnapshot | null {
      if (isDestroyed('render')) {
        return null;
      }

      const state = resolveTerminalState(flags);

      if (state === null) {
        // Not terminal: js/html_actuator.js L27 entered its branch only where
        // the payload said so, and the clear path is what a non-terminal commit
        // reached through `continueGame()`.
        clearAll('render');

        return null;
      }

      return apply(state, detail);
    },

    clear(): void {
      if (isDestroyed('clear')) {
        return;
      }

      clearAll('clear');
    },

    readRendered(): GameOverSnapshot | null {
      return rendered;
    },

    hasOverlay(): boolean {
      return overlay !== null;
    },

    hasPanel(): boolean {
      return panel !== null;
    },

    isShowing(state: TerminalScreenName): boolean {
      return rendered !== null && rendered.state === state;
    },

    destroy(): void {
      teardown();
    },
  } satisfies GameOverScreen);
}
