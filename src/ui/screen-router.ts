// The screen state machine: the ONE owner of the effective input context.
//
// AAP R8 and R9. The vanilla game had no navigation model of any kind — one
// screen, seven board states governed by two CSS class toggles, no router, no
// hash handling and no History API usage. This module is the state machine that
// replaces those toggles, and its first job is the one the toggles never had to
// do: decide which context input is interpreted in, and tell every modality
// about it.
//
// THE ONE CONTEXT OWNER
//   Three modalities read the effective context: the keyboard resolves a
//   binding against it on every keydown, the gesture path decides whether a
//   swipe is a move, and the generated on-screen controls decide which of them
//   are focusable. `context()` below is the single function all three read — it
//   is handed to `createInputManager` and to `mountOnScreenControls` as their
//   `context` option, and the gesture path reads it through the input manager.
//   The controls cache the value, so this module calls `refresh()` on them
//   whenever the context can have changed. Decision DL-ROUTER-01.
//
// WHAT DECIDES THE CONTEXT
//   `resolveDocumentContext` of src/input/input-manager.ts is the document rule
//   and stays the document rule; this module COMPOSES on top of it rather than
//   restating it, adding the two pieces of state only a router can know: whether
//   the settings dialog it owns is open, and whether the engine has reported a
//   terminal turn.
//
// WHAT IT OWNS, AND WHAT IT DOES NOT
//   It owns the settings dialog's shown state, its focus trap and the inertness
//   of the board behind it. It does NOT own the dialog's contents — that is
//   src/ui/components/settings-panel.ts — and it does not own the terminal
//   overlay's presentation, which belongs to src/ui/screens/hud.ts. Both of
//   those subscribe to the same events this does, independently.
//
// This module reads no storage, consumes no randomness and draws nothing.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
// this module's area enumerated:
//   TR-ROUTER-01  js/html_actuator.js L124-L138  the two CSS class toggles that
//                                                were the whole navigation
//                                                model, replaced by
//                                                `RouterScreen` and its
//                                                transitions
//   TR-ROUTER-02  js/game_manager.js L9-L11      the three fixed input
//                                                subscriptions, generalised
//                                                into the context every
//                                                modality resolves against
//   TR-ROUTER-03  target-only row                `context()`, the single
//                                                effective-context function
//   TR-ROUTER-04  target-only row                the settings dialog's shown
//                                                state, its focus trap and the
//                                                inertness of the board behind
//                                                it
//   TR-ROUTER-05  target-only row                `createScreenRouter()` and
//                                                `ScreenRouterSurfaces`
//
// Decisions behind this file, argued in docs/DECISION_LOG.md and named here
// only so the construct can be found from the log:
//   DL-ROUTER-01  one effective-context function read by all three modalities,
//                 with the cached on-screen controls refreshed on every change
//   DL-ROUTER-02  `resolveDocumentContext` of src/input/input-manager.ts
//                 composed on rather than restated
//   DL-ROUTER-03  the dialog's contents and the terminal overlay's presentation
//                 left to their own modules, each subscribing independently

import type {
  EngineEventSubscription,
  EngineEvents,
  StateCommitEvent,
} from '../engine/engine-events';
import type { InputContext, Keymap } from '../input/keymap';
import { resolveDocumentContext } from '../input/input-manager';
import { createFocusManager } from './a11y/focus-manager';
import type { FocusManager, FocusTrapHandle } from './a11y/focus-manager';
import type { UiReporter } from './a11y/settings';
import { NOOP_UI_REPORTER, createSafeUiReporter } from './a11y/settings';

/* ==========================================================================
 * 1. Names carried into reports
 * ========================================================================== */

/** Short label naming this module in every report. */
const REPORT_CONTEXT = 'screen-router';

/** Counter raised once per settings dialog opened. */
const SETTINGS_OPEN_METRIC = 'ui.router.settings.open';

/** Counter raised once per settings dialog closed. */
const SETTINGS_CLOSE_METRIC = 'ui.router.settings.close';

/** Counter raised once per settings request refused. */
const SETTINGS_REFUSED_METRIC = 'ui.router.settings.refused';

/** Counter raised once per effective screen change. */
const SCREEN_METRIC = 'ui.router.screen';

/** Counter raised once per control refresh this router drove. */
const REFRESH_METRIC = 'ui.router.refresh';

/** Counter raised once per call refused after `destroy()`. */
const AFTER_DESTROY_METRIC = 'ui.router.after_destroy';

/** Counted when the reward screen opens. */
const REWARD_OPEN_METRIC = 'ui.router.reward.open';

/** Counted when the reward screen closes. */
const REWARD_CLOSE_METRIC = 'ui.router.reward.close';

/** Counted, with a reason, when an open is refused. */
const REWARD_REFUSED_METRIC = 'ui.router.reward.refused';

/** Counted when a card is chosen, whether by pointer or by digit. */
const REWARD_SELECT_METRIC = 'ui.router.reward.select';

/* ==========================================================================
 * 2. Public API
 * ========================================================================== */

/**
 * The screen in force.
 *
 * `'won'` and `'gameOver'` are the two states js/html_actuator.js L124-L127
 * expressed as the classes `game-won` and `game-over`; `'settings'` is the
 * modal dialog, which is not a board state and therefore takes precedence over
 * both while it is open.
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
 * Structurally the `RewardOffer` of src/run/run-controller.ts; declared here so
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

  /** Focus manager the dialog's trap is engaged through. One is built if absent. */
  readonly focus?: FocusManager;

  /** Called after the dialog is shown, so its body can be rendered or synced. */
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
   * validates nor applies the choice: src/run/run-controller.ts owns the reward
   * transaction, and this reports the choice into it.
   */
  readonly onRewardSelect?: (relicId: string) => void;

  /** Copy the reward screen renders. Defaults to `DEFAULT_REWARD_COPY`. */
  readonly rewardCopy?: RewardCopy;

  /**
   * Resolves where focus returns to when the reward screen closes.
   *
   * A FUNCTION, not an element, because the answer moves: the board's parallel
   * accessibility layer uses a roving tab stop, so the element that can take
   * focus is whichever cell currently carries `tabindex="0"`. Called once per
   * open, just before the trap engages.
   *
   * Absent — or returning `null` — leaves the trap's own fallback in charge,
   * which restores to whatever held focus before the screen opened.
   */
  readonly rewardRestoreFocusTo?: () => Element | null;
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

  /** The screen in force. */
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
   * Subscribes to the engine's `state:commit`, which is where the terminal
   * screens come from.
   *
   * @returns A handle that removes the subscription.
   */
  subscribe(events: EngineEvents): EngineEventSubscription;

  /** Re-applies the effective context to the attached control layer. */
  refresh(): void;

  /**
   * Closes the dialog, releases every listener and the focus manager it built.
   * Every later call is a reported no-op.
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
 * 3. Element resolution
 * ========================================================================== */

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

/* ==========================================================================
 * 4. Construction
 * ========================================================================== */

/**
 * Mounts the router.
 *
 * Nothing is read at import time: every lookup and every report happens inside
 * this call, and an absent element is reported and skipped rather than raised —
 * which is the discipline the eight unguarded selector lookups of the vanilla
 * sources lacked.
 *
 * @param options Document, panel, trigger, inert region, focus manager and sink.
 * @returns The router, holding no listener until `attach` is called.
 *
 * @example
 * ```ts
 * const router = createScreenRouter({ document });
 * const input = createInputManager({ context: router.context });
 * const controls = mountOnScreenControls({ host: input, context: router.context });
 *
 * router.attach({ input, controls });
 * const stop = router.subscribe(engine.events);
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

  // Built here where the caller supplied none, and destroyed with this router.
  // A supplied manager belongs to its owner and is left alone.
  const ownedFocus = options.focus === undefined;
  const focus =
    options.focus ??
    createFocusManager({ reporter, context: REPORT_CONTEXT });

  const subscriptions: (() => void)[] = [];

  let controls: RouterControlSurface | null = null;
  let trap: FocusTrapHandle | null = null;
  let settingsOpen = false;

  /** The offer currently on screen, empty while the screen is down. */
  let rewardCards: readonly RewardCard[] = [];
  let rewardTrap: FocusTrapHandle | null = null;
  let rewardOpen = false;

  /**
   * Reflects the dialog's open state onto its trigger as `aria-expanded`.
   *
   * index.html declares `aria-haspopup="dialog"` and `aria-controls` on the
   * trigger, which together say a dialog exists and name it, but neither says
   * whether it is open right now. Without `aria-expanded` a screen reader
   * announces the same "Settings, button, has pop-up dialog" whether the dialog
   * is up or not, so the one piece of state the user needs to know before
   * pressing it is the one piece never conveyed.
   *
   * Written on every transition rather than only on open, so the trigger is
   * never left claiming a dialog is open after it has been taken down — which is
   * worse than the attribute being absent.
   */
  const reflectTriggerExpansion = (open: boolean): void => {
    trigger?.setAttribute('aria-expanded', open ? 'true' : 'false');
  };

  // Closed at construction, so the attribute is present and truthful from the
  // first announcement rather than appearing only after the first open.
  reflectTriggerExpansion(false);

  /**
   * The terminal state the engine last committed.
   *
   * Held here rather than read back off the overlay's classes, so this router's
   * decision does not depend on whether the HUD's listener happened to run
   * first: both subscribe to the same event, and the order they were registered
   * in is not a contract.
   */
  let terminal: 'won' | 'gameOver' | null = null;
  let lastScreen: RouterScreen = 'game';
  let destroyed = false;

  const refuseAfterDestroy = (call: string): boolean => {
    if (!destroyed) {
      return false;
    }

    reporter.count(AFTER_DESTROY_METRIC, { call });

    return true;
  };

  const screen = (): RouterScreen => {
    // Settings outranks the reward screen, because settings is opened from on
    // top of whatever is showing and is the thing the player is looking at.
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
    // field holding focus outranks every screen, because the keys belong to the
    // field while it does.
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

  const refresh = (): void => {
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

    refresh();
  };

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

    if (panelElement !== null) {
      panelElement.hidden = true;
    } else if (panel !== null) {
      panel.setAttribute('hidden', '');
    }

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
    if (panelElement !== null) {
      panelElement.hidden = false;
    } else {
      panel.removeAttribute('hidden');
    }

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
      // lifetime, which is what `aria-modal="true"` in index.html announces and
      // what nothing was enforcing.
      inertBackground: gameRegion === null ? undefined : [gameRegion],
    });

    if (engaged === null) {
      // Nothing focusable inside: the dialog would announce itself modal and
      // then hold no focus, so it is taken back down rather than left open.
      if (panelElement !== null) {
        panelElement.hidden = true;
      } else {
        panel.setAttribute('hidden', '');
      }

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
   * Every class name here is one style/_reward.scss already styles, so the
   * screen carries the reward vocabulary the stylesheet defines rather than a
   * second one invented next to it.
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

    // The accessible name is the whole card rather than just its heading, so a
    // screen-reader user hears what the relic does before choosing it — the
    // description is inside the button, so no separate label is needed, and the
    // one thing that would be read twice is suppressed above.
    item.append(button);

    return item;
  };

  /**
   * Reports a choice out and takes the screen down.
   *
   * The screen closes before the callback runs, so a handler that opens the next
   * screen is not fighting a trap that is still engaged on this one.
   */
  const chooseReward = (card: RewardCard, source: string): void => {
    reporter.count(REWARD_SELECT_METRIC, { relicId: card.id, source });
    hideReward();
    options.onRewardSelect?.(card.id);
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
    const chosen = rewardCards.find((card) => card.id === relicId);

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

      if (rewardElement !== null) {
        rewardElement.hidden = true;
      } else {
        rewardHost.setAttribute('hidden', '');
      }

      // Cleared on the way down rather than on the way up, so a screen reader
      // exploring the layer never finds last stage's offer sitting in a hidden
      // container.
      rewardHost.replaceChildren();
    }

    rewardCards = [];
    reporter.count(REWARD_CLOSE_METRIC);
    settle();

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
    if (rewardElement !== null) {
      rewardElement.hidden = false;
    } else {
      rewardHost.removeAttribute('hidden');
    }

    const engaged = focus.trap(rewardHost, {
      label: 'reward',
      context: REPORT_CONTEXT,
      reporter,

      // Focus goes back to the BOARD, not to a trigger: the reward screen is
      // reached by clearing a stage rather than by pressing a control, so there
      // is no trigger to return to, and leaving focus on the document body after
      // the screen closes would strand a keyboard user outside the game.
      restoreFocusTo: asHtmlElement(
        options.rewardRestoreFocusTo?.() ?? null,
      ),
      inertBackground: gameRegion === null ? undefined : [gameRegion],
    });

    if (engaged === null) {
      if (rewardElement !== null) {
        rewardElement.hidden = true;
      } else {
        rewardHost.setAttribute('hidden', '');
      }

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

    return true;
  };

  const readCommit = (commit: StateCommitEvent): void => {
    // The two board states of js/html_actuator.js L124-L127, from the flags
    // js/game_manager.js L91-L97 carried. `terminated` is the engine's own
    // answer to whether play is blocked, so a continued win clears this without
    // the router having to track the acknowledgement itself.
    const next: 'won' | 'gameOver' | null = !commit.terminated
      ? null
      : commit.over
        ? 'gameOver'
        : commit.won
          ? 'won'
          : null;

    if (next === terminal) {
      return;
    }

    terminal = next;
    settle();
  };

  return Object.freeze({
    context,
    screen,
    isSettingsOpen: (): boolean => settingsOpen,
    openSettings,
    closeSettings,
    showReward,
    hideReward,
    isRewardOpen: (): boolean => rewardOpen,

    attach(surfaces: ScreenRouterSurfaces): void {
      if (refuseAfterDestroy('attach')) {
        return;
      }

      if (surfaces.controls !== undefined) {
        controls = surfaces.controls;
      }

      const input = surfaces.input ?? null;

      if (input !== null) {
        subscriptions.push(
          input.on('openSettings', (): void => {
            openSettings();
          }),
          input.on('closeSettings', (): void => {
            closeSettings();
          }),

          // `cancel` is Escape everywhere. The trap's own `onEscape` covers the
          // press that lands inside the dialog; this covers the press the
          // keyboard resolved before focus reached it.
          //
          // The reward screen is deliberately NOT cancellable: the stage is
          // cleared and a relic must be taken, so Escape has nothing to fall
          // back to.
          input.on('cancel', (): void => {
            closeSettings();
          }),

          // The digit bindings of src/input/keymap.ts publish a zero-based
          // index. An index naming no card is ignored rather than clamped, so a
          // press of `3` against a two-card offer chooses nothing instead of
          // silently choosing the last one.
          input.on('selectReward', (index: number): void => {
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
      }

      // Applied at once, so the controls carry the context in force rather than
      // whichever one held while they were being generated.
      settle();
    },

    subscribe(events: EngineEvents): EngineEventSubscription {
      if (refuseAfterDestroy('subscribe')) {
        return (): void => {
          // Nothing was registered.
        };
      }

      const release = events.on('state:commit', readCommit);

      subscriptions.push(release);

      let released = false;

      return (): void => {
        if (released) {
          return;
        }

        released = true;
        release();
      };
    },

    refresh,

    destroy(): void {
      if (destroyed) {
        return;
      }

      closeSettings();
      hideReward();
      destroyed = true;

      for (const release of subscriptions) {
        release();
      }

      subscriptions.length = 0;
      controls = null;

      if (ownedFocus) {
        focus.destroy();
      }
    },
  });
}
