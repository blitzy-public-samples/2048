// The in-run HUD: the ONE actuator that writes the score, the best score and
// the terminal overlay, wired to the engine's events and independent of which
// renderer draws the board.
//
// WHY THIS MODULE EXISTS
//   Two components used to own the same three outlets. `ScorePanel` owned
//   `.score-container` and `.best-container`, and `src/render/
//   number-only-renderer.ts` owned the same two plus `.game-message`, each with
//   a previous-score cache of its own. Mounting both cleared the other's
//   accessible-name node and dropped the rising `+N` delta, and because the
//   ownership sat inside a RENDERER, selecting a different renderer stopped the
//   HUD and the terminal overlay updating at all. The renderer is now
//   board-only and this module is the sole writer of the three.
//
// WHAT IT OWNS
//   the score and best-score outlets, through `ScorePanel`;
//   the `.game-message` overlay: the two state classes js/html_actuator.js
//   L124-L137 toggled, and the verdict text L129 wrote;
//   nothing else. It draws no tile, requests no rendering context and reads no
//   engine state of its own — every value arrives on a `state:commit`.
//
// PORTED BEHAVIOUR
//   js/html_actuator.js L20-L27  actuate(): score then best score, in that
//                                order, and the message decided last
//   js/html_actuator.js L124-L127 message(won): 'game-won' or 'game-over'
//   js/html_actuator.js L129      the two verdict strings, verbatim
//   js/html_actuator.js L136-L138 clearMessage(): both classes removed
//
// Every lookup is guarded: none of the eight selectors of the vanilla markup
// was null-checked, so a renamed class was a startup failure.

import type {
  EngineEvents,
  EngineEventSubscription,
  StateCommitEvent,
} from '../../engine/engine-events';
import type { BestScoreValue } from '../../engine/types';
import type { UiReporter } from '../a11y/settings';
import {
  NOOP_UI_REPORTER,
  createSafeUiReporter,
  resolveMount,
} from '../a11y/settings';
import type { ScorePanel } from '../components/score-panel';
import { createScorePanel } from '../components/score-panel';

/* ==========================================================================
 * 1. Selectors, classes and copy
 * ========================================================================== */

/** Selector of the terminal overlay. Read at js/html_actuator.js L6. */
const MESSAGE_SELECTOR = '.game-message';

/** Selector of the verdict paragraph inside the overlay. */
const VERDICT_SELECTOR = '.game-message > p';

/** Class the overlay carries on a win. js/html_actuator.js L125. */
const WON_CLASS = 'game-won';

/** Class the overlay carries on a loss. js/html_actuator.js L125. */
const OVER_CLASS = 'game-over';

/** Logical name of the overlay mount, carried into every report. */
const MESSAGE_MOUNT = 'message';

/** Label naming this module in every report. */
const REPORT_CONTEXT = 'hud';

/**
 * The two verdicts, ported verbatim from js/html_actuator.js L129, and
 * overridable so a caller can localise them without editing this module.
 */
export const hudCopy = Object.freeze({
  wonMessage: 'You win!',
  overMessage: 'Game over!',
});

export type HudCopy = typeof hudCopy;

/* ==========================================================================
 * 2. Report names
 * ========================================================================== */

/** Counter raised once per completed mount. */
const MOUNTED_METRIC = 'ui.hud.mounted';

/** Counter raised once per outlet the document did not supply. */
const MOUNT_MISSING_METRIC = 'ui.hud.mount_missing';

/** Counter raised once per commit this HUD wrote. */
const COMMIT_METRIC = 'ui.hud.commit';

/** Counter raised per terminal overlay shown, carrying the verdict. */
const VERDICT_METRIC = 'ui.hud.verdict';

/** Counter raised per call that reaches a destroyed HUD. */
const WRITE_AFTER_DESTROY_METRIC = 'ui.hud.write_after_destroy';

/** Counter raised once per `destroy`. */
const DESTROYED_METRIC = 'ui.hud.destroyed';

/* ==========================================================================
 * 3. Public API
 * ========================================================================== */

/** Which terminal state the overlay is showing, and `null` for none. */
export type HudTerminalState = 'won' | 'over' | null;

/** What one commit put on screen, as plain data. */
export interface HudSnapshot {
  readonly score: number;
  readonly bestScore: BestScoreValue;

  /** The terminal state in force, and `null` while play continues. */
  readonly terminal: HudTerminalState;

  /** Verdict text written into the overlay, and `null` where none was. */
  readonly verdict: string | null;
}

/** Everything the factory accepts. Every member is optional. */
export interface HudOptions {
  /**
   * Score outlet, already resolved. Handed straight to `ScorePanel`, which is
   * the only component that writes it.
   */
  readonly scoreContainer?: HTMLElement | null;

  /** Best-score outlet, already resolved. */
  readonly bestContainer?: HTMLElement | null;

  /**
   * Terminal overlay. A selector is resolved against `document`; an element is
   * used as given; `null` marks an outlet the caller looked for and did not
   * find.
   */
  readonly messageContainer?: Element | string | null;

  /** Document a lookup runs against. Defaults to the ambient document. */
  readonly document?: Document;

  /** Verdict overrides. Either string may be replaced. */
  readonly copy?: Partial<HudCopy>;

  /** Sink every miss, every write and every skipped write reports through. */
  readonly reporter?: UiReporter;
}

/** The mounted HUD. Every member is safe to call at any time. */
export interface Hud {
  /**
   * Writes one commit: the score, then the best score, then the overlay —
   * which is the order js/html_actuator.js L24-L27 wrote them in.
   *
   * @param commit The commit to write. Only the score, best score, terminal
   *   flags and win flag are read.
   * @returns What was written.
   */
  render(commit: StateCommitEvent): HudSnapshot;

  /**
   * Subscribes to an emitter's `state:commit`, which is the only event this
   * HUD reads.
   *
   * @param events Emitter to attach to.
   * @returns A handle that removes the subscription.
   */
  subscribe(events: EngineEvents): EngineEventSubscription;

  /** What the last `render` put on screen, or `null` before the first. */
  readRendered(): HudSnapshot | null;

  /**
   * Whether the overlay resolved. The score outlets report separately, through
   * `ScorePanel.isReady()`.
   */
  hasOverlay(): boolean;

  /** The score component this HUD drives, for a caller that reads its state. */
  readonly scorePanel: ScorePanel;

  /**
   * Removes the overlay classes this HUD added, releases the score component
   * and drops every subscription. Every later call is a reported no-op.
   */
  destroy(): void;
}

/* ==========================================================================
 * 4. Construction
 * ========================================================================== */

function readAmbientDocument(): Document | null {
  return typeof document === 'undefined' ? null : document;
}

/**
 * Narrows an element to the HTML element whose `classList` this module writes.
 *
 * @param element Element to narrow.
 * @returns The element, or `null` where it carries no `classList` to write.
 */
function asHtmlElement(element: Element): HTMLElement | null {
  return 'classList' in element ? (element as HTMLElement) : null;
}

function mergeCopy(overrides: Partial<HudCopy> | undefined): HudCopy {
  if (overrides === undefined) {
    return hudCopy;
  }

  return Object.freeze({
    wonMessage: overrides.wonMessage ?? hudCopy.wonMessage,
    overMessage: overrides.overMessage ?? hudCopy.overMessage,
  });
}

/**
 * Mounts the HUD.
 *
 * Nothing is read or written at import time: the overlay lookup, the score
 * component's own two lookups and every report happen inside this call. An
 * absent outlet is reported and its writes are skipped; the outlets that did
 * resolve keep working.
 *
 * @param options Pre-resolved outlets, document, copy and report sink.
 * @returns The mounted HUD, whether or not every outlet resolved.
 *
 * @example
 * ```ts
 * const hud = createHud({
 *   scoreContainer: document.querySelector('.score-container'),
 *   bestContainer: document.querySelector('.best-container'),
 *   messageContainer: '.game-message',
 * });
 *
 * const stop = hud.subscribe(engine.events);
 * ```
 */
export function createHud(options: HudOptions = {}): Hud {
  const reporter = createSafeUiReporter(options.reporter ?? NOOP_UI_REPORTER);
  const owner = options.document ?? readAmbientDocument();
  const copy = mergeCopy(options.copy);

  const scorePanel = createScorePanel({
    scoreContainer: options.scoreContainer ?? null,
    bestContainer: options.bestContainer ?? null,
    ...(owner === null ? {} : { document: owner }),
    reporter,
  });

  // A caller that already holds the element hands it in; a caller that does
  // not lets this one guarded lookup run. `resolveMount` reports a miss rather
  // than returning an unchecked node.
  const supplied = options.messageContainer ?? null;
  const overlay: HTMLElement | null =
    supplied === null
      ? resolveMount<HTMLElement>(MESSAGE_SELECTOR, {
          name: MESSAGE_MOUNT,
          ...(owner === null ? {} : { root: owner }),
          reporter,
          context: REPORT_CONTEXT,
        })
      : typeof supplied === 'string'
        ? resolveMount<HTMLElement>(supplied, {
            name: MESSAGE_MOUNT,
            ...(owner === null ? {} : { root: owner }),
            reporter,
            context: REPORT_CONTEXT,
          })
        : asHtmlElement(supplied);

  if (overlay === null) {
    reporter.count(MOUNT_MISSING_METRIC, { mount: MESSAGE_MOUNT });
  }

  const subscriptions: EngineEventSubscription[] = [];

  let destroyed = false;
  let rendered: HudSnapshot | null = null;

  reporter.count(MOUNTED_METRIC, {
    score: scorePanel.isReady(),
    overlay: overlay !== null,
  });

  /**
   * Shows the terminal overlay.
   *
   * Ported from js/html_actuator.js L124-L131: the state class first, then the
   * verdict into the overlay's own paragraph. An overlay carrying no paragraph
   * is reported and still receives its class, because the class is what the
   * stylesheet fades in.
   *
   * @param won Whether the verdict is the winning one.
   * @returns The verdict written, or the verdict that would have been.
   */
  const showMessage = (won: boolean): string => {
    const verdict = won ? copy.wonMessage : copy.overMessage;

    if (overlay === null) {
      return verdict;
    }

    overlay.classList.add(won ? WON_CLASS : OVER_CLASS);

    const paragraph = overlay.querySelector(':scope > p');

    if (paragraph === null) {
      reporter.log('warn', 'The terminal overlay carries no verdict element.', {
        context: REPORT_CONTEXT,
        selector: VERDICT_SELECTOR,
      });

      return verdict;
    }

    paragraph.textContent = verdict;
    reporter.count(VERDICT_METRIC, { won });

    return verdict;
  };

  /**
   * Clears the terminal overlay.
   *
   * Ported from js/html_actuator.js L136-L138, which the manager reached
   * through `continueGame()` on restart and on keep-playing. Both arrive here
   * as a commit whose `terminated` is `false`.
   */
  const clearMessage = (): void => {
    if (overlay === null) {
      return;
    }

    overlay.classList.remove(WON_CLASS);
    overlay.classList.remove(OVER_CLASS);
  };

  const render = (commit: StateCommitEvent): HudSnapshot => {
    if (destroyed) {
      reporter.count(WRITE_AFTER_DESTROY_METRIC);

      return (
        rendered ?? {
          score: commit.score,
          bestScore: commit.bestScore,
          terminal: null,
          verdict: null,
        }
      );
    }

    // Score first, then best score: the order of js/html_actuator.js L24-L25,
    // and the order the delta depends on, since the delta is computed against
    // the score this component last wrote.
    scorePanel.update({ score: commit.score, bestScore: commit.bestScore });

    let terminal: HudTerminalState = null;
    let verdict: string | null = null;

    // Ported from js/html_actuator.js L26-L27: the overlay is decided from the
    // terminal flags alone, and a loss takes precedence over a win because a
    // board can carry both.
    if (commit.terminated) {
      if (commit.over) {
        terminal = 'over';
        verdict = showMessage(false);
      } else if (commit.won) {
        terminal = 'won';
        verdict = showMessage(true);
      } else {
        clearMessage();
      }
    } else {
      clearMessage();
    }

    rendered = Object.freeze({
      score: commit.score,
      bestScore: commit.bestScore,
      terminal,
      verdict,
    });

    reporter.count(COMMIT_METRIC, {
      score: commit.score,
      terminal: terminal ?? 'none',
    });

    return rendered;
  };

  return Object.freeze({
    scorePanel,

    render,

    subscribe(events: EngineEvents): EngineEventSubscription {
      const release = events.on('state:commit', (commit): void => {
        render(commit);
      });

      subscriptions.push(release);

      return release;
    },

    readRendered: (): HudSnapshot | null => rendered,

    hasOverlay: (): boolean => overlay !== null,

    destroy(): void {
      if (destroyed) {
        reporter.count(WRITE_AFTER_DESTROY_METRIC);

        return;
      }

      destroyed = true;

      for (const release of subscriptions) {
        release();
      }

      subscriptions.length = 0;

      clearMessage();
      scorePanel.destroy();

      reporter.count(DESTROYED_METRIC);
    },
  });
}
