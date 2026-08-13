// Contract suite for the screen router and the settings dialog, AAP R8 and R9.

import { afterEach, describe, expect, it } from 'vitest';

import { Grid } from '../../../src/engine/grid';
import { createEngineEvents } from '../../../src/engine/engine-events';
import type { StateCommitEvent } from '../../../src/engine/engine-events';
import {
  EMPTY_RELIC_CONTEXT,
  EMPTY_STAGE_CONTEXT,
} from '../../../src/engine/types';
import { createInputManager } from '../../../src/input/input-manager';
import { resolveDocumentContext } from '../../../src/input/input-manager';
import {
  LEGACY_CONTROL_BINDINGS,
  mountOnScreenControls,
} from '../../../src/input/on-screen-controls';
import { DEFAULT_KEY_BINDINGS } from '../../../src/input/keymap';
import { createLiveRegionAnnouncer } from '../../../src/ui/a11y/live-region';
import { createScreenRouter } from '../../../src/ui/screen-router';
import type {
  RewardCard,
  ScreenContext,
  ScreenModule,
  ScreenRouter,
} from '../../../src/ui/screen-router';

const MARKUP = `
  <main id="game-main">
    <button type="button" class="restart-button">New Game</button>
    <button type="button" class="settings-button" id="settings-button"
            aria-haspopup="dialog" aria-controls="settings-panel">Settings</button>
    <div class="game-container">
      <div class="game-message">
        <p></p>
        <div class="lower">
          <button type="button" class="keep-playing-button">Keep going</button>
          <button type="button" class="retry-button">Try again</button>
        </div>
      </div>
    </div>
    <div class="on-screen-controls" id="on-screen-controls"></div>
  </main>
  <div class="screen-layer" id="screen-layer">
    <div class="screen" id="screen-reward" data-screen="reward" role="dialog"
         aria-modal="true" hidden><button type="button">Take</button></div>
    <div class="settings-panel" id="settings-panel" role="dialog"
         aria-modal="true" aria-label="Settings" hidden></div>
  </div>
`;

const commitOf = (
  overrides: {
    readonly over?: boolean;
    readonly won?: boolean;
    readonly terminated?: boolean;
  } = {},
): StateCommitEvent => ({
  turn: 1,
  degraded: false,
  board: new Grid(4),
  score: 0,
  bestScore: 0,
  over: overrides.over ?? false,
  won: overrides.won ?? false,
  terminated: overrides.terminated ?? false,
  stage: EMPTY_STAGE_CONTEXT,
  relics: EMPTY_RELIC_CONTEXT,
});

let router: ScreenRouter | null = null;

const setup = (): void => {
  document.body.innerHTML = MARKUP;
};

afterEach(() => {
  router?.destroy();
  router = null;
  document.body.innerHTML = '';
});

/** Puts one focusable control in the dialog. */
const renderCloseControl = (host: Element): void => {
  if (host.querySelector('button') !== null) {
    return;
  }

  const control = document.createElement('button');

  control.type = 'button';
  control.textContent = 'Close';
  host.appendChild(control);
};

const panel = (): HTMLElement => {
  const found = document.querySelector<HTMLElement>('#settings-panel');

  if (found === null) {
    throw new Error('the fixture lost its settings panel');
  }

  return found;
};

const message = (): HTMLElement => {
  const found = document.querySelector<HTMLElement>('.game-message');

  if (found === null) {
    throw new Error('the fixture lost its terminal overlay');
  }

  return found;
};

describe('the document context rule', () => {
  it('reports the terminal overlay as an overlay, not as the game', () => {
    setup();

    expect(resolveDocumentContext(document)).toBe('game');

    // js/html_actuator.js L124-L127 showed the overlay by adding this class,
    // and `.game-message` is NOT inside `.screen-layer`.
    message().classList.add('game-won');

    expect(resolveDocumentContext(document)).toBe('overlay');

    message().classList.replace('game-won', 'game-over');

    expect(resolveDocumentContext(document)).toBe('overlay');

    message().classList.remove('game-over');

    expect(resolveDocumentContext(document)).toBe('game');
  });

  it('still reports a shown dialog in the screen layer', () => {
    setup();

    const reward = document.querySelector<HTMLElement>('#screen-reward');

    if (reward !== null) {
      reward.hidden = false;
    }

    expect(resolveDocumentContext(document)).toBe('overlay');
  });
});

describe('one effective context', () => {
  it('composes the document rule with the router s own state', () => {
    setup();
    router = createScreenRouter({ document, onSettingsOpen: renderCloseControl });

    expect(router.context()).toBe('game');
    expect(router.screen()).toBe('game');

    router.openSettings();

    expect(router.context()).toBe('overlay');
    expect(router.screen()).toBe('settings');

    router.closeSettings();

    expect(router.context()).toBe('game');
    expect(router.screen()).toBe('game');
  });

  it('reports overlay for a terminal turn, and game once play continues', () => {
    setup();
    router = createScreenRouter({ document });

    const events = createEngineEvents();
    const stop = router.subscribe(events);

    events.emit('state:commit', commitOf({ won: true, terminated: true }));

    expect(router.context()).toBe('overlay');
    expect(router.screen()).toBe('won');

    // Keep Going: the engine clears `terminated` and the board is playable
    // again, so the context has to come back on its own.
    events.emit('state:commit', commitOf({ won: true, terminated: false }));

    expect(router.context()).toBe('game');
    expect(router.screen()).toBe('game');

    events.emit('state:commit', commitOf({ over: true, terminated: true }));

    expect(router.screen()).toBe('gameOver');

    stop();
  });

  it('lets a focused text field outrank every screen', () => {
    setup();

    const field = document.createElement('input');

    field.type = 'text';
    document.body.appendChild(field);

    router = createScreenRouter({ document });
    router.openSettings();
    field.focus();

    expect(router.context()).toBe('textEntry');
  });

  it('is the context the keyboard resolves against', () => {
    setup();
    router = createScreenRouter({ document });

    const input = createInputManager({
      ownerDocument: document,
      context: router.context,
    });

    let moves = 0;
    let continued = 0;

    input.on('move', (): void => {
      moves += 1;
    });
    input.on('keepPlaying', (): void => {
      continued += 1;
    });

    // In `'game'`: a movement key resolves and C does not.
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown' }),
    );
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'c', code: 'KeyC' }),
    );

    expect(moves).toBe(1);
    expect(continued).toBe(0);

    // In `'overlay'`: the reverse, without the manager being told anything.
    message().classList.add('game-won');
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown' }),
    );
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'c', code: 'KeyC' }),
    );

    expect(moves).toBe(1);
    expect(continued).toBe(1);

    input.detach();
  });

  it('is the context the generated controls resolve against', () => {
    setup();
    router = createScreenRouter({ document });

    const input = createInputManager({
      ownerDocument: document,
      context: router.context,
    });
    const controls = mountOnScreenControls({
      host: input,
      ownerDocument: document,
      context: router.context,
    });

    router.attach({ input, controls });

    const keepPlaying = document.querySelector<HTMLElement>(
      '.keep-playing-button',
    );
    const moveUp = document.querySelector<HTMLElement>(
      '[data-action="moveUp"]',
    );

    // In `'game'` the continue control is unavailable and movement is
    // available.
    expect(keepPlaying?.hidden).toBe(true);
    expect(moveUp?.hidden).toBe(false);

    message().classList.add('game-won');
    router.refresh();

    expect(keepPlaying?.hidden).toBe(false);
    expect(keepPlaying?.getAttribute('tabindex')).not.toBe('-1');
    expect(moveUp?.hidden).toBe(true);

    controls.unmount();
    input.detach();
  });

  it('refreshes the controls from a commit, with no caller in between', () => {
    setup();
    router = createScreenRouter({ document });

    const input = createInputManager({
      ownerDocument: document,
      context: router.context,
    });
    const controls = mountOnScreenControls({
      host: input,
      ownerDocument: document,
      context: router.context,
    });

    router.attach({ input, controls });

    const events = createEngineEvents();
    const stop = router.subscribe(events);
    const keepPlaying = document.querySelector<HTMLElement>(
      '.keep-playing-button',
    );

    expect(keepPlaying?.hidden).toBe(true);

    events.emit('state:commit', commitOf({ won: true, terminated: true }));

    expect(keepPlaying?.hidden).toBe(false);

    stop();
    controls.unmount();
    input.detach();
  });
});

describe('the gesture path', () => {
  it('publishes no move while the context resolves no movement', () => {
    setup();
    router = createScreenRouter({ document, onSettingsOpen: renderCloseControl });

    const input = createInputManager({
      ownerDocument: document,
      context: router.context,
    });

    let moves = 0;

    input.on('move', (): void => {
      moves += 1;
    });

    // Dispatched on the gesture host, which is `.game-container` by default:
    // js/keyboard_input_manager.js L76 bound the three listeners to that
    // element and src/input/touch-input.ts keeps them there.
    const host = document.querySelector('.game-container');

    const swipe = (): void => {
      if (host === null) {
        throw new Error('the fixture lost its gesture host');
      }

      const start = new Event('touchstart', { bubbles: true });

      Object.defineProperty(start, 'touches', {
        value: [{ clientX: 200, clientY: 40 }],
      });
      Object.defineProperty(start, 'targetTouches', {
        value: [{ clientX: 200, clientY: 40 }],
      });
      host.dispatchEvent(start);

      const end = new Event('touchend', { bubbles: true });

      Object.defineProperty(end, 'changedTouches', {
        value: [{ clientX: 200, clientY: 240 }],
      });
      host.dispatchEvent(end);
    };

    swipe();

    expect(moves).toBe(1);

    router.openSettings();
    swipe();

    expect(moves).toBe(1);

    router.closeSettings();
    swipe();

    expect(moves).toBe(2);

    input.detach();
  });
});

describe('the settings dialog', () => {
  it('opens from the input action, and closes on cancel', () => {
    setup();
    router = createScreenRouter({ document });

    const input = createInputManager({
      ownerDocument: document,
      context: router.context,
    });

    router.attach({ input });

    expect(panel().hidden).toBe(true);

    const close = document.createElement('button');

    close.type = 'button';
    close.textContent = 'Close';
    panel().appendChild(close);

    input.emit('openSettings', undefined);

    expect(router.isSettingsOpen()).toBe(true);
    expect(panel().hidden).toBe(false);

    input.emit('cancel', undefined);

    expect(router.isSettingsOpen()).toBe(false);
    expect(panel().hidden).toBe(true);

    input.detach();
  });

  it('refuses to open a dialog holding nothing focusable', () => {
    setup();
    router = createScreenRouter({ document });

    expect(router.openSettings()).toBe(false);

    expect(panel().hidden).toBe(true);
    expect(router.isSettingsOpen()).toBe(false);
    expect(router.context()).toBe('game');
  });

  it('renders its body through the open hook, before the trap engages', () => {
    setup();

    const order: string[] = [];

    router = createScreenRouter({
      document,
      onSettingsOpen: (host): void => {
        order.push('open-hook');

        const close = document.createElement('button');

        close.type = 'button';
        close.textContent = 'Close';
        host.appendChild(close);
      },
      onSettingsClose: (): void => {
        order.push('close-hook');
      },
    });

    expect(router.openSettings()).toBe(true);
    expect(order).toEqual(['open-hook']);
    expect(document.activeElement?.textContent).toBe('Close');

    router.closeSettings();

    expect(order).toEqual(['open-hook', 'close-hook']);
  });

  it('traps focus inside the dialog and makes the board inert', () => {
    setup();
    router = createScreenRouter({
      document,
      onSettingsOpen: (host): void => {
        for (const label of ['First', 'Last']) {
          const control = document.createElement('button');

          control.type = 'button';
          control.textContent = label;
          host.appendChild(control);
        }
      },
    });

    router.openSettings();

    const region = document.querySelector('#game-main');

    expect(region?.hasAttribute('inert')).toBe(true);
    expect(document.activeElement?.textContent).toBe('First');

    router.closeSettings();

    expect(region?.hasAttribute('inert')).toBe(false);
  });

  it('returns focus to the control that opened it', () => {
    setup();

    const trigger = document.querySelector<HTMLElement>('#settings-button');

    trigger?.focus();

    router = createScreenRouter({
      document,
      onSettingsOpen: (host): void => {
        const control = document.createElement('button');

        control.type = 'button';
        control.textContent = 'Close';
        host.appendChild(control);
      },
    });

    router.openSettings();

    expect(document.activeElement).not.toBe(trigger);

    router.closeSettings();

    expect(document.activeElement).toBe(trigger);
  });

  // ADDED: the ordering the restore above depends on. The control layer
  // withholds every control inside an inert host, and the trigger is one, so a
  // refresh taken before the release leaves it withheld and the restore is
  // aimed at a control that cannot take focus. DL-ROUTER-41, DL-FOCUS-08.
  it('re-presents the control layer after the lift and before the restore', () => {
    setup();

    const trigger = document.querySelector<HTMLElement>('#settings-button');

    trigger?.focus();

    const region = document.querySelector('#game-main');
    const refreshes: { inert: boolean; active: string | null }[] = [];

    router = createScreenRouter({
      document,
      onSettingsOpen: renderCloseControl,
    });

    router.attach({
      controls: {
        refresh: (): void => {
          refreshes.push({
            inert: region?.hasAttribute('inert') ?? false,
            active: document.activeElement?.textContent ?? null,
          });
        },
      },
    });

    router.openSettings();

    // The open pushed the dialog's context with the region already inert and
    // focus already inside the dialog.
    expect(refreshes.at(-1)).toEqual({ inert: true, active: 'Close' });

    const opened = refreshes.length;

    router.closeSettings();

    // The FIRST refresh of the close is the one the release runs: the inertness
    // is already lifted, and focus has not moved off the dialog's own control
    // yet — so the trigger is re-presented before it is aimed at.
    expect(refreshes[opened]).toEqual({ inert: false, active: 'Close' });

    // Which is what makes this land rather than falling to the body.
    expect(document.activeElement).toBe(trigger);
  });

  // A performance review found the close refreshing the control layer twice: once
  // from inside the trap release, where it must be, and once more from
  // `settle()`. DL-ROUTER-45.
  it('refreshes the control layer once per settings close', () => {
    setup();

    const trigger = document.querySelector<HTMLElement>('#settings-button');

    trigger?.focus();

    let refreshes = 0;

    router = createScreenRouter({
      document,
      onSettingsOpen: renderCloseControl,
    });

    router.attach({
      controls: {
        refresh: (): void => {
          refreshes += 1;
        },
      },
    });

    router.openSettings();

    const opened = refreshes;

    router.closeSettings();

    expect(refreshes - opened).toBe(1);

    // And the screen change is still reported, which is `settle()`'s other half.
    expect(router.current()).not.toBe('settings');
  });

  it('tells the trigger whether the dialog it controls is open', () => {
    setup();

    const trigger = document.querySelector<HTMLElement>('#settings-button');

    router = createScreenRouter({
      document,
      onSettingsOpen: renderCloseControl,
    });

    // Present and truthful from construction, not only after the first open.
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');

    router.openSettings();

    expect(trigger?.getAttribute('aria-expanded')).toBe('true');

    router.closeSettings();

    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
  });

  it('leaves the trigger unexpanded when the open is refused', () => {
    setup();

    const trigger = document.querySelector<HTMLElement>('#settings-button');

    // No open hook, so the dialog holds nothing focusable and the open is
    // refused.
    router = createScreenRouter({ document });

    expect(router.openSettings()).toBe(false);
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on Escape pressed inside the dialog', () => {
    setup();
    router = createScreenRouter({
      document,
      onSettingsOpen: (host): void => {
        const control = document.createElement('button');

        control.type = 'button';
        control.textContent = 'Close';
        host.appendChild(control);
      },
    });

    router.openSettings();

    expect(router.isSettingsOpen()).toBe(true);

    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
      }),
    );

    expect(router.isSettingsOpen()).toBe(false);
  });

  it('closes a standing dialog on destroy, past its own authorization', () => {
    // `destroy()` raises `tearingDown` and THEN closed the dialog, and
    // `authorizes()` refuses every action while that flag is up — so the close
    // did nothing: the dialog stayed visible, its focus trap was never
    // released, the board it had made inert stayed inert, and
    // `onSettingsClose` never fired. A destroyed router left the page trapped
    // in a dialog belonging to a router that no longer existed. DL-ROUTER-43.
    setup();

    const closes: Element[] = [];

    router = createScreenRouter({
      document,
      onSettingsOpen: (host): void => {
        for (const label of ['First', 'Last']) {
          const control = document.createElement('button');

          control.type = 'button';
          control.textContent = label;
          host.appendChild(control);
        }
      },
      onSettingsClose: (host): void => {
        closes.push(host);
      },
    });

    expect(router.openSettings()).toBe(true);
    expect(router.isSettingsOpen()).toBe(true);

    const region = document.querySelector('#game-main');
    const dialog = panel();
    const trigger = document.querySelector('#settings-button');

    expect(region?.hasAttribute('inert')).toBe(true);
    expect(dialog.hidden).toBe(false);
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');

    router.destroy();

    // THE DIALOG IS DOWN and the router no longer believes it is open.
    expect(router.isSettingsOpen()).toBe(false);
    expect(dialog.hidden).toBe(true);
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');

    // THE TRAP IS RELEASED, so the rest of the page is reachable again.
    expect(region?.hasAttribute('inert')).toBe(false);

    // AND THE CLOSE WAS REPORTED, so a host that renders into the dialog is
    // told to tear its own contents down.
    expect(closes).toHaveLength(1);
    expect(closes[0]).toBe(dialog);
  });

  it('reports exactly one close for one dialog, whichever path closes it',
    () => {
      // The teardown close is not a second close: a dialog closed normally and
      // then destroyed reports once, not twice.
      setup();

      const closes: Element[] = [];

      router = createScreenRouter({
        document,
        onSettingsOpen: renderCloseControl,
        onSettingsClose: (host): void => {
          closes.push(host);
        },
      });

      expect(router.openSettings()).toBe(true);
      expect(router.closeSettings()).toBe(true);
      expect(closes).toHaveLength(1);

      router.destroy();

      expect(closes).toHaveLength(1);
    });

  it('destroys cleanly with no dialog standing', () => {
    setup();

    const closes: Element[] = [];

    router = createScreenRouter({
      document,
      onSettingsOpen: renderCloseControl,
      onSettingsClose: (host): void => {
        closes.push(host);
      },
    });

    expect(router.isSettingsOpen()).toBe(false);
    expect(() => {
      router?.destroy();
    }).not.toThrow();
    expect(closes).toEqual([]);
    expect(panel().hidden).toBe(true);
  });

  it('is idempotent across repeated open, close and destroy', () => {
    setup();
    router = createScreenRouter({
      document,
      onSettingsOpen: (host): void => {
        if (host.querySelector('button') === null) {
          const control = document.createElement('button');

          control.type = 'button';
          control.textContent = 'Close';
          host.appendChild(control);
        }
      },
    });

    expect(router.openSettings()).toBe(true);
    expect(router.openSettings()).toBe(false);
    expect(router.closeSettings()).toBe(true);
    expect(router.closeSettings()).toBe(false);

    router.destroy();
    router.destroy();

    expect(router.openSettings()).toBe(false);
  });
});

/* ==========================================================================
 * AN ATTACHMENT GROUP THAT CANNOT BE COMPLETED
 *
 * Both groups the router registers — the input surface's four actions and the
 * engine emitter's seven events — were built as array literals, so a refusal
 * from a later `on()` discarded the half-built array and left every
 * registration before it attached to the source with no reference to it
 * anywhere: the router went on acting on a surface it had reported it was not
 * attached to, unreachable by `destroy()` or by the handle. DL-ROUTER-44.
 * ========================================================================== */

/** The four input actions `attach()` registers, in order. */
const ATTACHED_INPUT_ACTIONS: readonly string[] = Object.freeze([
  'openSettings',
  'closeSettings',
  'cancel',
  'selectReward',
]);

/** The seven engine events `subscribe()` registers, in order. */
const SUBSCRIBED_ENGINE_EVENTS: readonly string[] = Object.freeze([
  'state:commit',
  'stage:start',
  'move:after',
  'stage:end',
  'move:before',
  'tile:merge',
  'tile:spawn',
]);

/**
 * An input surface whose `on` refuses the `ordinal`-th registration.
 *
 * @param ordinal Zero-based index of the registration that raises.
 * @returns The surface, and a reader over what stays attached.
 */
const refusingInput = (
  ordinal: number,
): {
  readonly surface: Parameters<ScreenRouter['attach']>[0]['input'];
  readonly attached: () => readonly string[];
  readonly admit: () => void;
} => {
  const held: string[] = [];
  const contexts: string[] = [];
  let refuse = true;
  let seen = 0;

  const surface = {
    on: (name: string, listener: () => void): (() => void) => {
      const index = seen;

      seen += 1;

      if (refuse && index === ordinal) {
        throw new Error(`the surface refused ${name}`);
      }

      void listener;
      held.push(name);

      return (): void => {
        const at = held.indexOf(name);

        if (at >= 0) {
          held.splice(at, 1);
        }
      };
    },
    setContext: (context: string): void => {
      contexts.push(context);
    },
  };

  return {
    surface: surface as unknown as Parameters<
      ScreenRouter['attach']
    >[0]['input'],
    attached: (): readonly string[] => [...held],
    admit: (): void => {
      refuse = false;
      seen = 0;
    },
  };
};

/**
 * An engine emitter whose `on` refuses the `ordinal`-th registration.
 *
 * @param ordinal Zero-based index of the registration that raises.
 * @returns The emitter, and a reader over what stays attached.
 */
const refusingEngine = (
  ordinal: number,
): {
  readonly events: ReturnType<typeof createEngineEvents>;
  readonly attached: () => readonly string[];
  readonly admit: () => void;
} => {
  const inner = createEngineEvents();
  const held: string[] = [];
  let refuse = true;
  let seen = 0;

  const events = {
    ...inner,
    on: ((name: string, listener: never): (() => void) => {
      const index = seen;

      seen += 1;

      if (refuse && index === ordinal) {
        throw new Error(`the emitter refused ${name}`);
      }

      const release = (
        inner.on as unknown as (
          eventName: string,
          handler: never,
        ) => () => void
      )(name, listener);

      held.push(name);

      return (): void => {
        const at = held.indexOf(name);

        if (at >= 0) {
          held.splice(at, 1);
        }

        release();
      };
    }) as ReturnType<typeof createEngineEvents>['on'],
  } as ReturnType<typeof createEngineEvents>;

  return {
    events,
    attached: (): readonly string[] => [...held],
    admit: (): void => {
      refuse = false;
      seen = 0;
    },
  };
};

describe('an attachment group that cannot be completed', () => {
  for (
    let ordinal = 0;
    ordinal < ATTACHED_INPUT_ACTIONS.length;
    ordinal += 1
  ) {
    const failing = ATTACHED_INPUT_ACTIONS[ordinal] ?? '';

    it(`rolls back the input registrations taken before ${failing}`, () => {
      setup();
      router = createScreenRouter({ document });

      const source = refusingInput(ordinal);

      expect(() => router?.attach({ input: source.surface })).toThrow(
        /refused/,
      );

      // NOTHING IS LEFT ATTACHED to the surface.
      expect(source.attached()).toEqual([]);
    });
  }

  it('attaches the input surface cleanly on a retry', () => {
    setup();
    router = createScreenRouter({ document });

    const source = refusingInput(2);

    expect(() => router?.attach({ input: source.surface })).toThrow(/refused/);
    expect(source.attached()).toEqual([]);

    source.admit();
    router.attach({ input: source.surface });

    expect(source.attached()).toEqual(ATTACHED_INPUT_ACTIONS);

    router.destroy();

    expect(source.attached()).toEqual([]);
  });

  for (
    let ordinal = 0;
    ordinal < SUBSCRIBED_ENGINE_EVENTS.length;
    ordinal += 1
  ) {
    const failing = SUBSCRIBED_ENGINE_EVENTS[ordinal] ?? '';

    it(`rolls back the engine registrations taken before ${failing}`, () => {
      setup();
      router = createScreenRouter({ document });

      const source = refusingEngine(ordinal);

      expect(() => router?.subscribe(source.events)).toThrow(/refused/);
      expect(source.attached()).toEqual([]);

      // AND NOTHING READS THE COMMIT for the half-subscription: the router
      // stays on the screen it was on.
      source.events.emit('state:commit', commitOf({ won: true }));

      expect(router.screen()).toBe('game');
    });
  }

  it('subscribes to the engine cleanly on a retry', () => {
    setup();
    router = createScreenRouter({ document });

    const source = refusingEngine(4);

    expect(() => router?.subscribe(source.events)).toThrow(/refused/);
    expect(source.attached()).toEqual([]);

    source.admit();

    const stop = router.subscribe(source.events);

    expect(source.attached()).toEqual(SUBSCRIBED_ENGINE_EVENTS);

    source.events.emit('state:commit', commitOf({ won: true, terminated: true }));

    expect(router.screen()).toBe('won');

    stop();

    expect(source.attached()).toEqual([]);
  });

  it('releases every engine registration even where one release refuses',
    () => {
      setup();
      router = createScreenRouter({ document });

      const inner = createEngineEvents();
      const held: string[] = [];
      let refusals = 0;
      const events = {
        ...inner,
        on: ((name: string, listener: never): (() => void) => {
          const release = (
            inner.on as unknown as (
              eventName: string,
              handler: never,
            ) => () => void
          )(name, listener);

          held.push(name);

          const detach = (): void => {
            const at = held.indexOf(name);

            if (at >= 0) {
              held.splice(at, 1);
            }

            release();
          };

          if (name !== 'move:after') {
            return detach;
          }

          return (): void => {
            refusals += 1;
            detach();

            throw new Error('this release refuses');
          };
        }) as ReturnType<typeof createEngineEvents>['on'],
      } as ReturnType<typeof createEngineEvents>;

      const stop = router.subscribe(events);

      expect(held).toEqual(SUBSCRIBED_ENGINE_EVENTS);
      expect(() => {
        stop();
      }).toThrow(/refuses/);

      // EVERY ONE CAME OFF despite the refusal, so the router reads nothing.
      expect(held).toEqual([]);
      expect(refusals).toBe(1);

      events.emit('state:commit', commitOf({ won: true, terminated: true }));

      expect(router.screen()).toBe('game');

      // And teardown does not call the released listeners a second time.
      router.destroy();

      expect(refusals).toBe(1);
    });
});

describe('one binding owner per markup control', () => {
  it('publishes exactly once per activation of a legacy control', () => {
    setup();

    const input = createInputManager({ ownerDocument: document });
    const controls = mountOnScreenControls({
      host: input,
      ownerDocument: document,
      markupControls: LEGACY_CONTROL_BINDINGS,
    });

    let restarts = 0;

    input.on('restart', (): void => {
      restarts += 1;
    });

    document.querySelector<HTMLElement>('.restart-button')?.click();

    // Two owners binding this element published twice per click.
    expect(restarts).toBe(1);

    controls.unmount();
    input.detach();
  });

  it('binds the settings control through the same owner', () => {
    setup();
    router = createScreenRouter({ document });

    const input = createInputManager({
      ownerDocument: document,
      context: router.context,
    });
    const controls = mountOnScreenControls({
      host: input,
      ownerDocument: document,
      context: router.context,
      markupControls: [
        ...LEGACY_CONTROL_BINDINGS,
        { selector: '#settings-button', action: 'openSettings' as const },
      ],
    });

    router.attach({ input, controls });

    let opened = 0;

    input.on('openSettings', (): void => {
      opened += 1;
    });

    document.querySelector<HTMLElement>('#settings-button')?.click();

    expect(opened).toBe(1);

    controls.unmount();
    input.detach();
  });
});

describe('the Keep Going binding', () => {
  it('has a key, in the overlay context, and collides with nothing', () => {
    const binding = DEFAULT_KEY_BINDINGS.keepPlaying;

    // js/keyboard_input_manager.js bound no key at all: the control was the
    // only way to reach the action.
    expect(binding.keys).toContain('c');
    expect(binding.codes).toContain('KeyC');
    expect(binding.contexts).toContain('overlay');

    // Nothing else holds C anywhere, so the terminal overlay carries no
    // conflict and neither does any other screen.
    for (const [action, candidate] of Object.entries(DEFAULT_KEY_BINDINGS)) {
      if (action === 'keepPlaying') {
        continue;
      }

      expect(candidate.keys).not.toContain('c');
      expect(candidate.codes).not.toContain('KeyC');
    }
  });
});

/**
 * An input surface that records how many listeners are registered on it, so a
 * duplicate registration is observable rather than inferred from a duplicated
 * effect.
 *
 * @returns The surface, an emitter for it and its live listener count.
 */
const createSurface = (): {
  readonly surface: {
    on: (event: string, listener: (index: number) => void) => () => void;
    setContext: () => void;
  };
  readonly emit: (event: string, index?: number) => void;
  readonly count: () => number;
} => {
  const listeners = new Map<string, ((index: number) => void)[]>();

  return {
    surface: {
      on: (event: string, listener: (index: number) => void): (() => void) => {
        const bucket = listeners.get(event) ?? [];

        bucket.push(listener);
        listeners.set(event, bucket);

        return (): void => {
          const at = bucket.indexOf(listener);

          if (at !== -1) {
            bucket.splice(at, 1);
          }
        };
      },
      setContext: (): void => undefined,
    },
    emit: (event: string, index = 0): void => {
      for (const listener of [...(listeners.get(event) ?? [])]) {
        listener(index);
      }
    },
    count: (): number => {
      let total = 0;

      for (const bucket of listeners.values()) {
        total += bucket.length;
      }

      return total;
    },
  };
};

/* ==========================================================================
 * Single-owner attachment
 * ========================================================================== */

/**
 * WHAT WAS WRONG
 *   `attach()` and `subscribe()` merely pushed their releases onto one
 *   append-only list that only `destroy()` drained. Attaching the same input
 *   surface twice therefore installed a second copy of all four dialog
 *   listeners, so one Escape closed the dialog twice and one digit press chose
 *   twice; subscribing a replaced engine left the previous engine's seven
 *   handlers registered for the rest of the session; and the releaser
 *   `subscribe()` returned did not remove its entries from that list, so a
 *   released engine's closures were retained until teardown.
 *
 * WHAT THIS SUITE PINS
 *   That the router owns exactly ONE input attachment and ONE engine
 *   attachment, that a repeat of the same source registers nothing further,
 *   that a different source releases the previous one, and that a release takes
 *   effect at once rather than at destroy.
 */
describe('the router s owned attachments', () => {
  it('registers one set of listeners however often the same surface attaches', () => {
    setup();
    router = createScreenRouter({
      document,
      onSettingsOpen: renderCloseControl,
    });
    router.start();

    const first = createSurface();

    router.attach({ input: first.surface });

    const afterFirst = first.count();

    router.attach({ input: first.surface });
    router.attach({ input: first.surface });

    expect(first.count()).toBe(afterFirst);

    // And one press opens the dialog once: a duplicate registration would have
    // opened it, closed nothing, and counted a refusal for the second call.
    first.emit('openSettings');

    expect(router.isSettingsOpen()).toBe(true);

    first.emit('cancel');

    expect(router.isSettingsOpen()).toBe(false);
  });

  it('releases the previous surface when a different one attaches', () => {
    setup();
    router = createScreenRouter({
      document,
      onSettingsOpen: renderCloseControl,
    });
    router.start();

    const first = createSurface();
    const second = createSurface();

    router.attach({ input: first.surface });
    router.attach({ input: second.surface });

    expect(first.count()).toBe(0);
    expect(second.count()).toBeGreaterThan(0);

    // The released surface drives nothing.
    first.emit('openSettings');

    expect(router.isSettingsOpen()).toBe(false);

    second.emit('openSettings');

    expect(router.isSettingsOpen()).toBe(true);
  });

  it('reads one event once however often the same emitter subscribes', () => {
    setup();
    router = createScreenRouter({ document });
    router.start();

    const events = createEngineEvents();
    const seen: string[] = [];

    router.subscribe((transition): void => {
      seen.push(`${transition.from}->${transition.to}`);
    });

    const release = router.subscribe(events);
    const again = router.subscribe(events);

    events.emit('stage:start', {
      stageIndex: 0,
      goal: { kind: 'highest-tile', target: 64 },
      seed: 'attachment',
      boardSize: 4,
    });

    // ONE edge, not two. A second registration of `readStageStart` would have
    // taken `runStart -> stage` and then self-transitioned `stage -> stage`,
    // which is exactly the double-read this ownership exists to prevent.
    expect(seen).toEqual(['runStart->stage']);

    // The releaser handed back for the repeat releases the one held set, so a
    // caller that subscribed twice and releases once holds nothing.
    again();
    seen.length = 0;
    events.emit('state:commit', commitOf({ over: true, terminated: true }));

    expect(seen).toEqual([]);

    // And releasing again is harmless.
    release();
  });

  it('releases a subscription at once rather than at destroy', () => {
    setup();
    router = createScreenRouter({ document });
    router.start();

    const events = createEngineEvents();
    const seen: string[] = [];

    router.subscribe((transition): void => {
      seen.push(transition.to);
    });

    const release = router.subscribe(events);

    release();
    events.emit('state:commit', commitOf({ over: true, terminated: true }));

    expect(seen).toEqual([]);
  });

  it('releases the previous emitter when a different one subscribes', () => {
    setup();
    router = createScreenRouter({ document });
    router.start();

    const first = createEngineEvents();
    const second = createEngineEvents();
    const seen: string[] = [];

    router.subscribe((transition): void => {
      seen.push(transition.to);
    });

    router.subscribe(first);
    router.subscribe(second);

    // The replaced emitter reaches nothing.
    first.emit('state:commit', commitOf({ over: true, terminated: true }));

    expect(seen).toEqual([]);

    second.emit('state:commit', commitOf({ over: true, terminated: true }));

    // `runStart -> stage` on the way to the terminal state, then the verdict.
    expect(seen).toEqual(['stage', 'gameOver']);
  });
});

/* ==========================================================================
 * The stage-clear gate
 *
 * `stage:end` used to take BOTH declared edges — `stage -> stageClear` and
 * `stageClear -> reward` — inside one event, so `stageClear` was entered and left
 * in a single tick and the stage-progress screen was unreachable however correct
 * the transition table was. It also ignored `payload.cleared`, so a stage that
 * ended WITHOUT its goal met put a reward screen up and offered a relic for a
 * stage the player had not cleared.
 * ========================================================================== */

describe('a cleared stage', () => {
  /** Emits one `stage:end` through a router attached to real engine events. */
  const endStage = (
    cleared: boolean,
  ): { readonly router: ScreenRouter } => {
    setup();

    const events = createEngineEvents();
    const built = createScreenRouter({ document });

    built.subscribe(events);
    built.start();
    built.send('beginRun');

    expect(built.current()).toBe('stage');

    events.emit('stage:end', { stageIndex: 0, cleared, score: 32 });

    return { router: built };
  };

  it('stops at the stage-clear screen, one edge per event', () => {
    const { router: built } = endStage(true);

    router = built;

    // ONE EDGE. The reward screen is behind the player's own continue control,
    // which publishes `stageEnd` — the only edge into `reward`.
    expect(built.current()).toBe('stageClear');

    expect(built.send('stageEnd')).toBe(true);
    expect(built.current()).toBe('reward');
  });

  it('takes no edge at all for a stage that did not clear', () => {
    const { router: built } = endStage(false);

    router = built;

    // The state stands: an uncleared stage earns no stage-clear screen and no
    // offer, and the refusal is a counted series of its own.
    expect(built.current()).toBe('stage');
  });
});

/* ==========================================================================
 * Contained injected callbacks
 * ========================================================================== */

/**
 * WHAT WAS WRONG
 *   `onSettingsOpen`, `onSettingsClose` and `onRewardSelect` were called bare.
 *   A raising composition escaped through whichever listener happened to be on
 *   the stack — the DOM event dispatch for a pointer press, the input manager's
 *   listener walk for a keyboard press — so one failure behaved differently by
 *   modality, none of them was reported, and a reward selection left the flow
 *   advanced over a choice that was never applied.
 *
 * WHAT THIS SUITE PINS
 *   That each of the three is contained, that the rollback is deterministic and
 *   identical for both modalities, and that the router's own state never gets
 *   ahead of the composition's.
 */
describe('the injected router callbacks', () => {
  it('rolls the dialog back down when the body fails to render', () => {
    setup();
    router = createScreenRouter({
      document,
      onSettingsOpen: (): never => {
        throw new Error('the panel body could not be built');
      },
    });

    expect(() => router?.openSettings()).not.toThrow();
    expect(router.openSettings()).toBe(false);
    expect(router.isSettingsOpen()).toBe(false);
    expect(panel().hidden).toBe(true);

    // And the dialog is still openable once the composition recovers, because
    // nothing was latched.
    expect(router.context()).toBe('game');
  });

  it('completes the close even when the close callback raises', () => {
    setup();
    router = createScreenRouter({
      document,
      onSettingsOpen: renderCloseControl,
      onSettingsClose: (): never => {
        throw new Error('the panel body could not be torn down');
      },
    });

    expect(router.openSettings()).toBe(true);
    expect(() => router?.closeSettings()).not.toThrow();
    expect(router.isSettingsOpen()).toBe(false);
    expect(panel().hidden).toBe(true);
  });

  it('re-shows the offer when the reward applier raises, from either modality', () => {
    setup();

    const applied: string[] = [];

    router = createScreenRouter({
      document,
      onRewardSelect: (relicId): void => {
        applied.push(relicId);

        throw new Error('the run controller refused');
      },
    });
    router.start();

    const surface = createSurface();

    router.attach({ input: surface.surface });

    const offer = [
      {
        id: 'first',
        name: 'First',
        rarity: 'common',
        description: 'One.',
        hooks: [],
      },
      {
        id: 'second',
        name: 'Second',
        rarity: 'rare',
        description: 'Two.',
        hooks: [],
      },
    ];

    expect(router.showReward(offer)).toBe(true);

    // KEYBOARD: the digit binding the router registered itself.
    expect(() => surface.emit('selectReward', 0)).not.toThrow();
    expect(applied).toEqual(['first']);

    // The offer is back up, so the player can choose again rather than being
    // stranded on a stage the flow already left.
    expect(router.isRewardOpen()).toBe(true);
    expect(router.current()).toBe('reward');

    // POINTER: the SAME rollback for a card press. This router renders no card of
    // its own — `SCREEN_MODULES.reward` names the module that does — so a press
    // arrives here as the `selectReward` call that module's `onSelect` makes, and
    // it goes through the one selection path the digit went through.
    // DL-ROUTER-04, DL-ROUTER-20.
    expect(() => router?.selectReward('second', 'card')).not.toThrow();
    expect(applied).toEqual(['first', 'second']);
    expect(router.isRewardOpen()).toBe(true);
    expect(router.current()).toBe('reward');
  });
});

/* ==========================================================================
 * The state machine
 * ========================================================================== */

describe('the state machine', () => {
  /** The markup the seven states declare their containers in. */
  const FLOW_MARKUP = `
    <main id="game-main">
      <button type="button" class="restart-button">New Game</button>
      <div class="hud" id="screen-hud" data-screen="hud" hidden></div>
      <div class="game-container">
        <div class="game-message"><p></p></div>
      </div>
    </main>
    <div class="screen-layer" id="screen-layer">
      <div class="screen" id="screen-run-start" data-screen="run-start"
           role="dialog" aria-modal="true" hidden></div>
      <div class="screen" id="screen-stage-progress" data-screen="stage-progress"
           role="dialog" aria-modal="true" hidden></div>
      <div class="screen" id="screen-reward" data-screen="reward" role="dialog"
           aria-modal="true" hidden></div>
      <div class="screen" id="screen-game-over" data-screen="game-over"
           role="dialog" aria-modal="true" hidden></div>
      <div class="screen" id="screen-run-summary" data-screen="run-summary"
           role="dialog" aria-modal="true" hidden></div>
      <div class="settings-panel" id="settings-panel" role="dialog"
           aria-modal="true" aria-label="Settings" hidden></div>
    </div>
  `;

  /** One offer, in the shape the reward state's context carries. */
  const OFFER: readonly RewardCard[] = Object.freeze([
    Object.freeze({
      id: 'first',
      name: 'First',
      rarity: 'common',
      description: 'One.',
      hooks: Object.freeze(['onMerge']),
      charges: 2,
    }),
    Object.freeze({
      id: 'second',
      name: 'Second',
      rarity: 'rare',
      description: 'Two.',
      hooks: Object.freeze(['onSpawn']),
    }),
  ]);

  /**
   * A screen module that renders one focusable control and records every
   * lifecycle call it receives.
   *
   * A trapping state refuses to trap a container holding nothing focusable, so
   * a module that renders nothing would leave the machine unable to enter its
   * own state — which is what makes rendering part of the double.
   */
  interface Recorder {
    readonly module: ScreenModule;
    readonly calls: string[];
    readonly contexts: ScreenContext[];
  }

  const recorder = (label: string): Recorder => {
    const calls: string[] = [];
    const contexts: ScreenContext[] = [];

    let host: Element | null = null;

    const render = (): void => {
      if (host === null) {
        return;
      }

      const control = document.createElement('button');

      control.type = 'button';
      control.className = `${label}-control`;
      control.textContent = label;
      host.replaceChildren(control);
    };

    return {
      calls,
      contexts,
      module: {
        mount(supplied: Element): void {
          host = supplied;
          calls.push('mount');
        },
        enter(context: ScreenContext): void {
          calls.push('enter');
          contexts.push(context);
          render();
        },
        update(context: ScreenContext): void {
          calls.push('update');
          contexts.push(context);
        },
        leave(): void {
          calls.push('leave');
          host?.replaceChildren();
        },
        unmount(): void {
          calls.push('unmount');
        },
      },
    };
  };

  /**
   * Whether a container is hidden.
   *
   * `hidden` widened to `boolean | 'until-found'` in the DOM lib, so the read is
   * reduced to a boolean here rather than compared loosely at each call.
   */
  const hidden = (id: string): boolean =>
    document.querySelector<HTMLElement>(`#${id}`)?.hidden !== false;

  it('lands on the run-start state and shows only its container', () => {
    document.body.innerHTML = FLOW_MARKUP;

    const runStart = recorder('run-start');

    router = createScreenRouter({
      document,
      screens: { runStart: runStart.module },
    });

    expect(router.isStarted()).toBe(false);

    // AAP Figure 6: `[*] --> RunStart : cold load`.
    expect(router.start()).toBe('runStart');
    expect(router.current()).toBe('runStart');
    expect(runStart.calls).toEqual(['mount', 'enter']);
    expect(hidden('screen-run-start')).toBe(false);

    for (const other of [
      'screen-stage-progress',
      'screen-reward',
      'screen-game-over',
      'screen-run-summary',
    ]) {
      expect(hidden(other)).toBe(true);
    }

    // Every state but `stage` is an overlay, so movement is withheld until a
    // run begins.
    expect(router.context()).toBe('overlay');
    expect(router.send('beginRun')).toBe(true);
    expect(router.current()).toBe('stage');
    expect(router.context()).toBe('game');
    expect(hidden('screen-run-start')).toBe(true);
    expect(runStart.calls).toEqual(['mount', 'enter', 'leave']);
  });

  it('holds the stage-clear state until the explicit stageEnd trigger', () => {
    document.body.innerHTML = FLOW_MARKUP;

    const stageClear = recorder('stage-clear');
    const reward = recorder('reward');

    router = createScreenRouter({
      document,
      screens: { stageClear: stageClear.module, reward: reward.module },
    });

    const events = createEngineEvents();
    const stop = router.subscribe(events);

    router.start();
    router.send('beginRun');

    // ONE EVENT, ONE EDGE. The engine's own `stage:end` reaches the
    // interstitial and stops: the Continue control the interstitial renders is
    // what takes the second edge, so it cannot arrive to find the state it
    // governs already left.
    events.emit('stage:end', { stageIndex: 0, cleared: true, score: 120 });

    expect(router.current()).toBe('stageClear');
    expect(hidden('screen-stage-progress')).toBe(false);
    expect(hidden('screen-reward')).toBe(true);

    // `start()` mounts every state whose container resolved, so the reward
    // module holds its container — and has NOT been entered.
    expect(reward.calls).toEqual(['mount']);

    // A second `stage:end` does not carry the flow past the interstitial
    // either.
    events.emit('stage:end', { stageIndex: 0, cleared: true, score: 120 });

    expect(router.current()).toBe('stageClear');

    expect(router.send('stageEnd', { offers: OFFER })).toBe(true);
    expect(router.current()).toBe('reward');
    expect(hidden('screen-reward')).toBe(false);
    expect(hidden('screen-stage-progress')).toBe(true);
    expect(reward.calls).toEqual(['mount', 'enter']);
    expect(stageClear.calls).toEqual(['mount', 'enter', 'leave']);

    stop();
  });

  it('restores focus to the board tab stop the resolver answers with', () => {
    document.body.innerHTML = FLOW_MARKUP;

    // The two board surfaces, as index.html declares them: the number-only
    // lattice roving its stop across its own cells, and the parallel board
    // hidden for as long as that lattice stands.
    const region = document.querySelector('#game-main')!;
    const lattice = document.createElement('div');
    const parallel = document.createElement('div');

    lattice.id = 'board-number-only';
    parallel.id = 'board-a11y';
    parallel.hidden = true;
    parallel.setAttribute('aria-hidden', 'true');

    for (let index = 0; index < 4; index += 1) {
      const cell = document.createElement('div');

      cell.setAttribute('role', 'gridcell');
      cell.setAttribute('tabindex', index === 3 ? '0' : '-1');
      lattice.appendChild(cell);
    }

    region.append(lattice, parallel);

    const reward = recorder('reward');
    const resolved: (Element | null)[] = [];

    router = createScreenRouter({
      document,
      screens: { reward: reward.module },

      // Resolved per engage, as the composition root supplies it: the selector
      // it evaluates names EVERY tab stop the two renderers can hold, in
      // document order, so the surface in force is matched and the hidden one is
      // not.
      rewardRestoreFocusTo: (): Element | null => {
        const target = document.querySelector(
          '#board-number-only [tabindex="0"], #board-a11y[tabindex="0"], ' +
            '#board-a11y [tabindex="0"]',
        );

        resolved.push(target);

        return target;
      },
    });

    router.start();
    router.send('beginRun');
    router.send('stageGoalMet', { cleared: true });

    expect(router.send('stageEnd', { offers: OFFER })).toBe(true);
    expect(router.screen()).toBe('reward');

    // Called once, as the trap engaged, and it answered with the roving cell
    // rather than the hidden parallel host.
    expect(resolved).toEqual([lattice.children[3]]);

    // Inside the trap while the offer stands.
    expect(
      document.querySelector('#screen-reward')?.contains(document.activeElement),
    ).toBe(true);

    expect(router.send('rewardSelected', { relicId: 'first' })).toBe(true);

    // THE BOARD, NOT THE CONTROL THAT LED HERE: reward is reached by clearing a
    // stage, so there is no trigger to go back to, and the stage entry that
    // follows the release resolves the same surface from
    // `SCREEN_INITIAL_FOCUS.stage`. DL-ROUTER-35, DL-FOCUS-04.
    expect(document.activeElement).toBe(lattice.children[3]);

    router.destroy();
    router = null;
  });

  it('hands the offer to the reward module and renders no card itself', () => {
    document.body.innerHTML = FLOW_MARKUP;

    const reward = recorder('reward');
    const chosen: string[] = [];

    router = createScreenRouter({
      document,
      screens: { reward: reward.module },
      onRewardSelect: (relicId): void => {
        chosen.push(relicId);
      },
    });

    router.start();
    router.send('beginRun');
    router.send('stageGoalMet', { cleared: true });

    expect(router.send('stageEnd', { offers: OFFER })).toBe(true);
    expect(router.isRewardOpen()).toBe(true);
    expect(router.screen()).toBe('reward');
    expect(router.context()).toBe('overlay');

    // The offer reached the module's own context, in draw order.
    const entered = reward.contexts[0];

    expect(entered?.screen).toBe('reward');
    expect(
      entered?.screen === 'reward'
        ? entered.offers.map((card) => card.id)
        : [],
    ).toEqual(['first', 'second']);

    // ONE OWNER. The router builds no `.relic-card` and no `.reward-offers`
    // list of its own, so the container holds exactly what the module put in
    // it.
    const host = document.querySelector('#screen-reward');

    expect(host?.querySelectorAll('.relic-card').length).toBe(0);
    expect(host?.querySelectorAll('.reward-offers').length).toBe(0);
    expect(host?.querySelectorAll('.reward-control').length).toBe(1);

    // And the digit binding still resolves an index against the offer the
    // module is showing.
    expect(router.send('rewardSelected', { relicId: 'first' })).toBe(true);
    expect(router.current()).toBe('stage');
    expect(router.isRewardOpen()).toBe(false);
    expect(hidden('screen-reward')).toBe(true);
    expect(chosen).toEqual([]);
  });

  it('resolves a keyboard choice through the one selection path', () => {
    document.body.innerHTML = FLOW_MARKUP;

    const reward = recorder('reward');
    const chosen: string[] = [];

    router = createScreenRouter({
      document,
      screens: { reward: reward.module },
      onRewardSelect: (relicId): void => {
        chosen.push(relicId);
      },
    });

    const input = createInputManager({
      ownerDocument: document,
      context: router.context,
      keymap: DEFAULT_KEY_BINDINGS,
    });

    router.attach({ input });
    router.start();
    router.send('beginRun');
    router.showReward(OFFER);

    expect(router.current()).toBe('reward');

    // The zero-based index the `selectReward` action publishes.
    input.emit('selectReward', 1);

    expect(chosen).toEqual(['second']);
    expect(router.current()).toBe('stage');

    // An index naming no card chooses nothing rather than the last card.
    router.showReward(OFFER);
    input.emit('selectReward', 7);

    expect(chosen).toEqual(['second']);
    expect(router.current()).toBe('reward');

    input.detach();
  });

  it('takes the terminal and summary edges, and returns to run start', () => {
    document.body.innerHTML = FLOW_MARKUP;

    const gameOver = recorder('game-over');
    const summary = recorder('run-summary');

    router = createScreenRouter({
      document,
      screens: { gameOver: gameOver.module, runSummary: summary.module },
      terminalOverlay: null,
    });

    const events = createEngineEvents();
    const stop = router.subscribe(events);

    router.start();
    router.send('beginRun');

    events.emit('state:commit', commitOf({ over: true, terminated: true }));

    expect(router.current()).toBe('gameOver');
    expect(hidden('screen-game-over')).toBe(false);
    expect(router.context()).toBe('overlay');

    expect(router.send('acknowledge')).toBe(true);
    expect(router.current()).toBe('runSummary');
    expect(hidden('screen-run-summary')).toBe(false);
    expect(summary.calls).toEqual(['mount', 'enter']);

    expect(router.send('newRun')).toBe(true);
    expect(router.current()).toBe('runStart');
    expect(hidden('screen-run-summary')).toBe(true);

    stop();
  });

  it('takes the restart edge without leaving the stage', () => {
    document.body.innerHTML = FLOW_MARKUP;

    router = createScreenRouter({ document });

    const events = createEngineEvents();
    const stop = router.subscribe(events);

    router.start();
    router.send('beginRun');

    // AAP Figure 6 declares `stage --restart--> stage`: a fresh board inside the
    // run, not a new run, so the flow stays where it is.
    expect(router.send('restart')).toBe(true);
    expect(router.current()).toBe('stage');
    expect(router.context()).toBe('game');

    events.emit('stage:start', {
      stageIndex: 0,
      goal: { kind: 'highest-tile', target: 16 },
      seed: 'restart-seed',
      boardSize: 4,
    });

    expect(router.current()).toBe('stage');

    stop();
  });
});

/* ==========================================================================
 * The trigger is validated, not trusted (CWE-20)
 * ========================================================================== */

describe('send', () => {
  it('refuses a trigger no state declares, however truthy the lookup', () => {
    setup();
    router = createScreenRouter({ document });
    router.start();

    const before = router.current();

    // THE PROTOTYPE READ. Each entry of `TRANSITIONS` is an object literal, so it
    // inherits from `Object.prototype`: an unvalidated index read answered
    // `Object.prototype.toString` — a function, and therefore truthy — and the
    // router then transitioned to a function as though it were a screen name.
    expect(router.send('toString' as never)).toBe(false);
    expect(router.send('constructor' as never)).toBe(false);
    expect(router.send('hasOwnProperty' as never)).toBe(false);
    expect(router.send('__proto__' as never)).toBe(false);
    expect(router.current()).toBe(before);
  });

  it('refuses an unknown trigger name and stands', () => {
    setup();
    router = createScreenRouter({ document });
    router.start();

    expect(router.send('nope' as never)).toBe(false);
    expect(router.send('' as never)).toBe(false);
    expect(router.current()).toBe('runStart');
  });

  it('tolerates a payload that is not an object', () => {
    setup();
    router = createScreenRouter({ document });
    router.start();

    // Replaced by an empty payload rather than read member by member, so a
    // primitive cannot reach a context builder.
    expect(router.send('beginRun', 'seed' as never)).toBe(true);
    expect(router.current()).toBe('stage');
  });
});

/* ==========================================================================
 * ADDED: a terminal verdict cannot outlive the state that raised it, against
 * the REAL announcer and a deferred scheduler (DL-LIVE-06, DL-LIVE-07).
 * ========================================================================== */

describe('the verdict the router withdraws stays withdrawn', () => {
  it('publishes no queued verdict after entering a non-terminal state', () => {
    setup();

    // The region index.html declares, plus the assertive sibling the announcer
    // writes an alert into.
    const layer = document.querySelector<HTMLElement>('#screen-layer');

    layer?.insertAdjacentHTML(
      'beforeend',
      '<div class="visually-hidden live-region" id="live-region" ' +
        'role="status" aria-live="polite" aria-atomic="true"></div>' +
        '<div class="visually-hidden live-region" id="live-region-assertive" ' +
        'role="alert" aria-live="assertive" aria-atomic="true"></div>',
    );

    // Tasks run only when this test releases them, which is what puts the
    // verdict in the queue across the transition.
    const tasks: (() => void)[] = [];
    const announcer = createLiveRegionAnnouncer({
      assertiveSelector: '#live-region-assertive',
      schedule: (callback): { cancel(): void } => {
        const entry = (): void => {
          callback();
        };

        tasks.push(entry);

        return {
          cancel: (): void => {
            const index = tasks.indexOf(entry);

            if (index >= 0) {
              tasks.splice(index, 1);
            }
          },
        };
      },
    });
    const drain = (): void => {
      while (tasks.length > 0) {
        tasks.shift()?.();
      }
    };

    router = createScreenRouter({ document, announcer });
    router.start();
    router.send('beginRun');

    // The run is lost: the engine announcer's verdict is queued, and nothing
    // has flushed it yet.
    announcer.announce({ kind: 'terminal', verdict: 'loss', score: 1234 });
    router.send('noMovesAvailable');

    expect(router.current()).toBe('gameOver');

    // The player acknowledges, and the flow leaves the terminal state. The
    // verdict must not be readable afterwards, however late the queue runs.
    router.send('acknowledge');
    announcer.flush();
    drain();

    expect(router.current()).toBe('runSummary');
    expect(
      document.querySelector('#live-region-assertive')?.textContent,
    ).toBe('');
    expect(announcer.pending()).toBe(0);

    announcer.destroy();
  });
});
