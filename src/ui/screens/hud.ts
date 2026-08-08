// The in-run HUD: the ONE actuator that writes the score, the best score and
// the terminal overlay, wired to the engine's events and independent of which
// renderer draws the board.
//
// SOLE OWNERSHIP OF THE THREE OUTLETS
//   `.score-container`, `.best-container` and `.game-message` are written here
//   and nowhere else. src/render/number-only-renderer.ts is board-only and
//   holds no score cache, so the HUD and the terminal overlay update on every
//   commit whichever renderer draws the board. Decision DL-HUD-01.
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
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece. HUD is one area
// across the TypeScript and stylesheet halves, so these ordinals are unique
// across this module and style/_hud.scss:
//   TR-HUD-01  js/html_actuator.js L20-L27    `actuate()`'s score, best score
//                                             and message order
//   TR-HUD-02  js/html_actuator.js L124-L127  `message(won)` and its two state
//                                             classes
//   TR-HUD-03  js/html_actuator.js L129       the two verdict strings, verbatim
//   TR-HUD-04  js/html_actuator.js L136-L138  `clearMessage()`, both classes
//                                             removed
//   TR-HUD-05  target-only row                `createHud()`, `HudSnapshot` and
//                                             the guarded lookups
//   TR-HUD-06  target-only row                the stage index, goal progress
//                                             and relic tray slices a commit
//                                             carries
//
// Decisions behind this file, argued in docs/DECISION_LOG.md and named here
// only so the construct can be found from the log:
//   DL-HUD-01  the HUD as the sole writer of the score, best-score and terminal
//              overlay outlets, outside every renderer
//   DL-HUD-02  every value arriving on a `state:commit`, with no engine state
//              read here
//   DL-HUD-03  the two verdict strings carried verbatim from the retired
//              actuator

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
import type {
  RelicCommitContext,
  StageCommitContext,
} from '../../engine/types';
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

/** Selector of the in-run status group, hidden until a run is under way. */
const HUD_SELECTOR = '#screen-hud';

/** Selector of the stage indicator. */
const STAGE_SELECTOR = '#hud-stage';

/** Selector of the active-relic tray. */
const RELIC_TRAY_SELECTOR = '#relic-tray';

/** Logical names of the three run-status mounts. */
const HUD_MOUNT = 'hud';
const STAGE_MOUNT = 'stage';
const RELIC_TRAY_MOUNT = 'relicTray';

/**
 * The custom property style/_hud.scss reads for the goal track's fill, clamped
 * to the closed interval [0, 1].
 */
const GOAL_FRACTION_PROPERTY = '--hud-goal-fraction';

/** Label naming this module in every report. */
const REPORT_CONTEXT = 'hud';

/**
 * The two verdicts, ported verbatim from js/html_actuator.js L129, and
 * overridable so a caller can localise them without editing this module.
 */
export const hudCopy = Object.freeze({
  wonMessage: 'You win!',
  overMessage: 'Game over!',

  /** Label above the stage number. */
  stageLabel: 'Stage',

  /** Label above the goal readout. */
  goalLabel: 'Goal',

  /** Renders the stage number a zero-based index names. */
  stageValue: (stageIndex: number): string => String(stageIndex + 1),

  /** Renders the goal readout from its kind, target and measured progress. */
  goalValue: (kind: string, target: number, measured: number): string =>
    kind === 'score-threshold'
      ? `${measured} / ${target} score`
      : `${measured} / ${target} tile`,

  /** Label naming the tray for assistive technology. */
  relicTrayLabel: 'Active relics, in pickup order',

  /** Rendered in place of the tray while a run holds no relic. */
  relicTrayEmpty: 'No relics yet',

  /** Renders a relic's remaining charge budget. */
  relicCharges: (charges: number): string => `${charges} left`,
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

/** Counter raised once per stage transition the indicator wrote. */
const STAGE_METRIC = 'ui.hud.stage';

/** Counter raised once per relic-tray rebuild. */
const RELIC_TRAY_METRIC = 'ui.hud.relic_tray';

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

  /**
   * One-based stage number shown, and `null` where no indicator resolved.
   *
   * One-based because it is player-facing copy; the engine's own index stays
   * zero-based everywhere else.
   */
  readonly stage: number | null;

  /** Relic identifiers shown in the tray, in pickup order. */
  readonly relics: readonly string[];
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

  /**
   * The in-run status group, whose `hidden` this HUD releases on the first
   * commit. A selector is resolved against `document`; `null` marks an outlet
   * the caller looked for and did not find. Defaults to `HUD_SELECTOR`.
   */
  readonly hudContainer?: Element | string | null;

  /** The stage indicator. Defaults to `STAGE_SELECTOR`. */
  readonly stageContainer?: Element | string | null;

  /** The active-relic tray. Defaults to `RELIC_TRAY_SELECTOR`. */
  readonly relicTrayContainer?: Element | string | null;

  /**
   * Called with a relic identifier when its tray control is activated. Absent,
   * the control is rendered as a plain readout rather than a button, so nothing
   * offers an action that goes nowhere.
   */
  readonly onRelicActivate?: (relicId: string) => void;

  /**
   * Resolves a relic identifier to the name the tray shows.
   *
   * WHY IT IS INJECTED. A commit's relic slice carries an identifier and a charge
   * count and nothing else, deliberately — the engine holds no relic definition,
   * so it has nothing else to carry. The catalogue is the only place a display
   * name exists, and it lives in src/relics, which this module does not import.
   * Without a resolver the tray shows the raw identifier, which is the same relic
   * under a different name from the one the reward card and the announcement both
   * used.
   *
   * Absent, or returning a blank string, falls back to the identifier.
   */
  readonly relicName?: (relicId: string) => string;

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

  /** Whether the stage indicator resolved. */
  hasStageIndicator(): boolean;

  /** Whether the relic tray resolved. */
  hasRelicTray(): boolean;

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
    stageLabel: overrides.stageLabel ?? hudCopy.stageLabel,
    goalLabel: overrides.goalLabel ?? hudCopy.goalLabel,
    stageValue: overrides.stageValue ?? hudCopy.stageValue,
    goalValue: overrides.goalValue ?? hudCopy.goalValue,
    relicTrayLabel: overrides.relicTrayLabel ?? hudCopy.relicTrayLabel,
    relicTrayEmpty: overrides.relicTrayEmpty ?? hudCopy.relicTrayEmpty,
    relicCharges: overrides.relicCharges ?? hudCopy.relicCharges,
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

  /**
   * Resolves one optional run-status outlet.
   *
   * The same three-way shape the overlay uses above: a supplied element is taken
   * as given, a string is resolved, and nothing falls back to this module's own
   * selector. A miss is COUNTED and skipped rather than raised, because the HUD
   * has to keep writing the score when the run-status markup is absent — which
   * is what every unit fixture that carries only the legacy outlets is.
   */
  const resolveOutlet = (
    supplied: Element | string | null | undefined,
    fallback: string,
    mount: string,
  ): HTMLElement | null => {
    const resolved =
      supplied === null || supplied === undefined
        ? resolveMount<HTMLElement>(fallback, {
            name: mount,
            ...(owner === null ? {} : { root: owner }),
            reporter,
            context: REPORT_CONTEXT,
          })
        : typeof supplied === 'string'
          ? resolveMount<HTMLElement>(supplied, {
              name: mount,
              ...(owner === null ? {} : { root: owner }),
              reporter,
              context: REPORT_CONTEXT,
            })
          : asHtmlElement(supplied);

    if (resolved === null) {
      reporter.count(MOUNT_MISSING_METRIC, { mount });
    }

    return resolved;
  };

  const hudGroup = resolveOutlet(
    options.hudContainer,
    HUD_SELECTOR,
    HUD_MOUNT,
  );
  const stageOutlet = resolveOutlet(
    options.stageContainer,
    STAGE_SELECTOR,
    STAGE_MOUNT,
  );
  const relicTray = resolveOutlet(
    options.relicTrayContainer,
    RELIC_TRAY_SELECTOR,
    RELIC_TRAY_MOUNT,
  );

  const subscriptions: EngineEventSubscription[] = [];

  let destroyed = false;
  let rendered: HudSnapshot | null = null;

  /**
   * The stage slice last written, so an unchanged stage rebuilds nothing.
   *
   * A commit arrives on every turn and the indicator changes on a stage
   * transition alone, so comparing first keeps the HUD from replacing three
   * elements sixty times a minute.
   */
  let lastStage: string | null = null;

  /** The relic slice last written, compared the same way and for the same reason. */
  let lastRelics: string | null = null;

  /** Releases the run-status group's `hidden`, once, on the first commit. */
  const revealGroup = (): void => {
    if (hudGroup !== null && hudGroup.hidden) {
      hudGroup.hidden = false;
    }
  };

  /**
   * Builds one labelled readout: a label above a value, which is the pattern
   * style/_hud.scss styles as `.hud-label` and `.hud-value`.
   */
  const buildReadout = (
    doc: Document,
    className: string,
    label: string,
    value: string,
  ): HTMLElement => {
    const group = doc.createElement('div');

    group.className = className;

    const labelNode = doc.createElement('span');

    labelNode.className = 'hud-label';
    labelNode.textContent = label;

    const valueNode = doc.createElement('span');

    valueNode.className = 'hud-value';
    valueNode.textContent = value;

    group.append(labelNode, valueNode);

    return group;
  };

  /**
   * Writes the stage indicator: the stage number, the goal readout, and the
   * track whose fill the goal fraction drives.
   *
   * The measured quantity is derived from the target and the reported fraction
   * rather than read from the board, so the indicator carries exactly the
   * progress the run reported and cannot disagree with it.
   *
   * @param stage The commit's stage slice.
   * @returns The one-based stage number written, or `null` when no outlet
   *   resolved.
   */
  const renderStage = (stage: StageCommitContext): number | null => {
    if (stageOutlet === null) {
      return null;
    }

    const doc = stageOutlet.ownerDocument ?? owner;

    if (doc === null) {
      return null;
    }

    // Clamped here rather than in the stylesheet, so the text and the track are
    // driven by one value: a provider reporting a fraction outside [0, 1] cannot
    // produce a readout above its own target.
    const fraction = Number.isFinite(stage.goalProgress)
      ? Math.min(Math.max(stage.goalProgress, 0), 1)
      : 0;
    const measured = Math.round(fraction * stage.goal.target);
    const signature = `${stage.stageIndex}|${stage.goal.kind}|${stage.goal.target}|${measured}`;

    revealGroup();

    if (signature === lastStage) {
      return stage.stageIndex + 1;
    }

    lastStage = signature;

    const index = buildReadout(
      doc,
      'hud-stage-index',
      copy.stageLabel,
      copy.stageValue(stage.stageIndex),
    );
    const goal = buildReadout(
      doc,
      'hud-goal',
      copy.goalLabel,
      copy.goalValue(stage.goal.kind, stage.goal.target, measured),
    );

    const meter = doc.createElement('div');

    // Not a `role="progressbar"`: the same quantity is already in
    // `.hud-value` as text, and a second announcement of it would have a screen
    // reader read the progress twice on every stage change.
    meter.className = 'hud-goal-meter';
    meter.setAttribute('aria-hidden', 'true');

    const fill = doc.createElement('div');

    fill.className = 'hud-goal-meter-fill';
    fill.style.setProperty(GOAL_FRACTION_PROPERTY, String(fraction));
    meter.append(fill);
    goal.append(meter);

    stageOutlet.replaceChildren(index, goal);

    reporter.count(STAGE_METRIC, {
      stageIndex: stage.stageIndex,
      goalKind: stage.goal.kind,
      goalTarget: stage.goal.target,
    });

    return stage.stageIndex + 1;
  };

  /**
   * Writes the active-relic tray, IN PICKUP ORDER.
   *
   * Pickup order is the order src/engine/hook-bus.ts dispatches in, so it is
   * what decides how two relics on one hook compound. Showing it is what lets a
   * player predict the compounding rather than discover it, which is why the
   * order is the tray's own document order and the slot number comes from a CSS
   * counter over that order rather than from an index written into the markup.
   *
   * @param relics The commit's relic slice, already in pickup order.
   * @returns The identifiers written.
   */
  const renderRelics = (
    relics: RelicCommitContext,
  ): readonly string[] => {
    if (relicTray === null) {
      return [];
    }

    const doc = relicTray.ownerDocument ?? owner;

    if (doc === null) {
      return [];
    }

    const ids = relics.map((relic): string => relic.id);
    const signature = relics
      .map((relic): string => `${relic.id}:${relic.charges ?? ''}`)
      .join(',');

    revealGroup();

    if (signature === lastRelics) {
      return Object.freeze(ids);
    }

    lastRelics = signature;

    // Restated on every rebuild rather than trusted from the markup, so a tray
    // supplied by a caller carries the same accessible name as the one
    // index.html declares.
    relicTray.setAttribute('aria-label', copy.relicTrayLabel);

    if (relics.length === 0) {
      const empty = doc.createElement('li');

      // A REAL list item, carrying no role of its own so the implicit
      // `listitem` of an `<li>` inside a `<ul>` stands. `role="none"` was tried
      // here to keep the announced item count equal to the number of relics
      // held; it removes the only child role a `role="list"` permits, which
      // leaves the list ARIA-invalid and announced as empty. "List, 1 item, no
      // relics yet" is unambiguous, so the valid structure is kept.
      empty.className = 'relic-tray-item';
      empty.setAttribute('data-relic-empty', 'true');
      empty.textContent = copy.relicTrayEmpty;

      relicTray.replaceChildren(empty);
      reporter.count(RELIC_TRAY_METRIC, { relics: 0 });

      return Object.freeze(ids);
    }

    const items: HTMLElement[] = [];

    for (const relic of relics) {
      const item = doc.createElement('li');

      item.className = 'relic-tray-item';
      item.setAttribute('data-relic-id', relic.id);

      // The stylesheet dims an exhausted relic off this attribute, and it is
      // written even at zero so the dimming is reachable.
      if (relic.charges !== undefined) {
        item.setAttribute('data-charges', String(relic.charges));
      }

      // A BUTTON ONLY WHERE THERE IS SOMETHING TO ACTIVATE. Without a handler the
      // control is a readout, because a focusable button that does nothing is
      // worse for a keyboard user than no button at all.
      const control = doc.createElement(
        options.onRelicActivate === undefined ? 'span' : 'button',
      );

      control.className = 'relic-tray-control';

      if (options.onRelicActivate !== undefined) {
        (control as HTMLButtonElement).type = 'button';
        control.setAttribute('data-relic-id', relic.id);
      }

      const name = doc.createElement('span');
      const resolved = options.relicName?.(relic.id);

      name.className = 'relic-tray-name';
      name.textContent =
        typeof resolved === 'string' && resolved.length > 0
          ? resolved
          : relic.id;

      // The full name is on the element regardless, so a name the stylesheet
      // truncates to an ellipsis is still readable on hover and is still
      // announced in full.
      name.title = name.textContent;
      control.append(name);

      if (relic.charges !== undefined) {
        const charges = doc.createElement('span');

        charges.className = 'relic-tray-charges';
        charges.textContent = copy.relicCharges(relic.charges);
        control.append(charges);
      }

      item.append(control);
      items.push(item);
    }

    relicTray.replaceChildren(...items);

    reporter.count(RELIC_TRAY_METRIC, { relics: relics.length });

    return Object.freeze(ids);
  };

  /** Resolves a tray activation to the relic it addresses. */
  const readTrayPress = (event: Event): void => {
    const activate = options.onRelicActivate;

    if (activate === undefined) {
      return;
    }

    const target = event.target;

    if (target === null || typeof target !== 'object') {
      return;
    }

    const closest = (target as { closest?: (s: string) => Element | null })
      .closest;

    if (typeof closest !== 'function') {
      return;
    }

    const control = closest.call(target as Element, '.relic-tray-control');
    const relicId = control?.getAttribute('data-relic-id');

    if (relicId === null || relicId === undefined || relicId.length === 0) {
      return;
    }

    activate(relicId);
  };

  if (relicTray !== null && options.onRelicActivate !== undefined) {
    relicTray.addEventListener('click', readTrayPress);
  }

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
          stage: null,
          relics: [],
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

    // The run-status half. Written AFTER the score and the overlay, so the two
    // outlets js/html_actuator.js owned keep their original write order and this
    // addition cannot delay them.
    const stage = renderStage(commit.stage);
    const relics = renderRelics(commit.relics);

    rendered = Object.freeze({
      score: commit.score,
      bestScore: commit.bestScore,
      terminal,
      verdict,
      stage,
      relics,
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

    hasStageIndicator: (): boolean => stageOutlet !== null,

    hasRelicTray: (): boolean => relicTray !== null,

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

      if (relicTray !== null) {
        relicTray.removeEventListener('click', readTrayPress);
      }

      reporter.count(DESTROYED_METRIC);
    },
  });
}
