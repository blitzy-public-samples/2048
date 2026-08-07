// The screen state machine: the ONE owner of the effective input context.
//
// AAP R8 and R9. The vanilla game had no navigation model of any kind — one
// screen, seven board states governed by two CSS class toggles, no router, no
// hash handling and no History API usage. This module is the state machine that
// replaces those toggles, and its first job is the one the toggles never had to
// do: decide which context input is interpreted in, and tell every modality
// about it.
//
// WHY ONE OWNER
//   Three modalities read a context. The keyboard resolves a binding against it
//   on every keydown, the gesture path decides whether a swipe is a move, and
//   the generated on-screen controls decide which of them are focusable at all.
//   Left to themselves the three disagreed: the keyboard read the document, the
//   gesture path read only its own listening and suspension flags, and the
//   controls cached whatever context held at mount and never re-read it. The
//   result was that a swipe moved the board behind a modal dialog, and that the
//   Keep Going control — whose only context is `'overlay'` — was hidden,
//   disabled and out of the tab order for the whole life of the page.
//
//   `context()` below is the single function all three read: it is handed to
//   `createInputManager` and to `mountOnScreenControls` as their `context`
//   option, and the gesture path reads it through the input manager. Because the
//   controls cache the value, this module also calls `refresh()` on them
//   whenever the context can have changed — which is the other half of the fix.
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
export type RouterScreen = 'game' | 'won' | 'gameOver' | 'settings';

/** The part of the input manager this router drives and listens to. */
export interface RouterInputSurface {
  /** Registers a listener for one of the router's three action events. */
  on(
    event: 'openSettings' | 'closeSettings' | 'cancel',
    listener: () => void,
  ): () => void;

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
    if (settingsOpen) {
      return 'settings';
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

    if (settingsOpen || terminal !== null || documentContext === 'overlay') {
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
          input.on('cancel', (): void => {
            closeSettings();
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
