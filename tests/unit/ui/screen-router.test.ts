// Contract suite for the screen router and the settings dialog, AAP R8 and R9.
//
// Four properties are pinned here, and each of the four was a live defect that
// no type could have caught:
//
//   one context      the keyboard, the gesture path and the generated controls
//                    each read a context. Left to themselves they disagreed, and
//                    a swipe moved the board behind a modal dialog. `context()`
//                    is the one function all three read, and it has to answer
//                    for the dialog this router owns AND for the terminal
//                    overlay, which is NOT inside `.screen-layer`.
//   reachability     `.keep-playing-button`'s only context is `'overlay'`, and
//                    nothing ever put the page into it, so the control that
//                    continues a won game was hidden, disabled and out of the
//                    tab order for the whole life of the page.
//   modal semantics  index.html declares `#settings-panel` with
//                    `aria-modal="true"`. Announcing that while focus can leave
//                    the dialog, and while the board behind it is still in the
//                    accessibility tree, is a false statement to a screen
//                    reader.
//   no double bind   two owners binding one element publish twice per
//                    activation, which is a double restart.

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
import { createScreenRouter } from '../../../src/ui/screen-router';
import type { ScreenRouter } from '../../../src/ui/screen-router';

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

/**
 * Puts one focusable control in the dialog.
 *
 * A dialog holding nothing focusable is refused, which is the router's own
 * guard; every test that only needs the dialog OPEN renders this much.
 */
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

/* ==========================================================================
 * The document rule
 * ========================================================================== */

describe('the document context rule', () => {
  it('reports the terminal overlay as an overlay, not as the game', () => {
    setup();

    expect(resolveDocumentContext(document)).toBe('game');

    // js/html_actuator.js L124-L127 showed the overlay by adding this class, and
    // `.game-message` is NOT inside `.screen-layer`.
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

/* ==========================================================================
 * One effective context
 * ========================================================================== */

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

    // In `'game'` the continue control is unavailable and movement is available.
    expect(keepPlaying?.hidden).toBe(true);
    expect(moveUp?.hidden).toBe(false);

    message().classList.add('game-won');
    router.refresh();

    // In `'overlay'` they swap — which is the whole point: the control was
    // unreachable for the life of the page before anything refreshed it.
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

/* ==========================================================================
 * The gesture path
 * ========================================================================== */

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
    // js/keyboard_input_manager.js L76 bound the three listeners to that element
    // and src/input/touch-input.ts keeps them there.
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

    // Behind the dialog a swipe used to move the board, because the gesture path
    // read only its own listening and suspension flags.
    router.openSettings();
    swipe();

    expect(moves).toBe(1);

    router.closeSettings();
    swipe();

    expect(moves).toBe(2);

    input.detach();
  });
});

/* ==========================================================================
 * The settings dialog
 * ========================================================================== */

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

    // Rendered content, because a dialog holding nothing focusable is refused.
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

    // Taken back down rather than left announcing itself modal with no focus.
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

  it('tells the trigger whether the dialog it controls is open', () => {
    setup();

    const trigger = document.querySelector<HTMLElement>('#settings-button');

    router = createScreenRouter({
      document,
      onSettingsOpen: renderCloseControl,
    });

    // Present and truthful from construction, not only after the first open:
    // `aria-haspopup` says a dialog exists and `aria-controls` names it, but
    // neither says whether it is up right now.
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
    // refused. The trigger must not be left claiming an open dialog.
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
 * One binding owner
 * ========================================================================== */

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

/* ==========================================================================
 * The Keep Going key
 * ========================================================================== */

describe('the Keep Going binding', () => {
  it('has a key, in the overlay context, and collides with nothing', () => {
    const binding = DEFAULT_KEY_BINDINGS.keepPlaying;

    // js/keyboard_input_manager.js bound no key at all: the control was the only
    // way to reach the action.
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
