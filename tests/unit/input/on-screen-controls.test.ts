// Context-availability suite of src/input/on-screen-controls.ts.
//
// The contract under test is the one `OnScreenControlsHandle.setContext`
// states: "A control whose action is inactive in the new context leaves both
// the accessibility tree and the tab order." It holds for every control the
// layer owns, the three index.html declares included — `.retry-button`
// (index.html L52), `.restart-button` (L36) and `.keep-playing-button` (L51),
// the ports of js/keyboard_input_manager.js L72-L74.
//
// Sections:
//   1  the markup controls' availability across the three contexts
//   2  the attribute state an unavailable control carries
//   3  publication suppression
//   4  accessible names under a remapped keymap
//   5  unmount, which leaves index.html's own markup behind
//
// `.retry-button` declares `['game', 'overlay']` in `LEGACY_CONTROL_BINDINGS`
// because the markup places it inside the terminal overlay while the
// `restart` binding of src/input/keymap.ts lists `'game'` alone; both facts
// are asserted below rather than assumed.
//
// The host is a hand-written double: no mocking library, no spy on a global,
// and no storage. This suite is collected by the `unit:dom` project of
// vitest.config.ts, whose environment is 'jsdom'.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_KEY_BINDINGS,
  type Direction,
  type InputContext,
  type Keymap,
} from '../../../src/input/keymap';
import {
  LEGACY_CONTROL_BINDINGS,
  mountOnScreenControls,
} from '../../../src/input/on-screen-controls';
import type {
  OnScreenControlHost,
  OnScreenControlsHandle,
} from '../../../src/input/on-screen-controls';
import type { InputSubscription } from '../../../src/input/input-manager';

/* ===== Doubles and fixtures ===== */

/** What the host recorded, so a publication is observable. */
interface HostLog {
  readonly published: string[];
  readonly moves: Direction[];
}

/** A host that records rather than driving an engine. */
function createHost(): OnScreenControlHost & { readonly log: HostLog } {
  const log: HostLog = { published: [], moves: [] };

  return {
    log,

    restart(): void {
      log.published.push('restart');
    },

    keepPlaying(): void {
      log.published.push('keepPlaying');
    },

    emitMove(direction: Direction): number {
      log.moves.push(direction);

      return 1;
    },

    on(): InputSubscription {
      return (): void => {
        return;
      };
    },

    emit(event: string): number {
      log.published.push(event);

      return 1;
    },
  } as OnScreenControlHost & { readonly log: HostLog };
}

/** The three controls index.html declares, plus the generated-control host. */
function seedMarkup(): void {
  document.body.innerHTML = [
    '<button type="button" class="restart-button">New Game</button>',
    '<div class="game-message">',
    '<button type="button" class="keep-playing-button">Keep going</button>',
    '<button type="button" class="retry-button">Try again</button>',
    '</div>',
    '<div id="on-screen-controls"></div>',
  ].join('');
}

/** Every mounted handle, unmounted after each test. */
const mounted: OnScreenControlsHandle[] = [];

/**
 * Mounts the layer over the seeded markup.
 *
 * @param host Host the controls publish through.
 * @param context Context to start in.
 * @param keymap Table names are derived from.
 * @returns The handle.
 */
function mount(
  host: OnScreenControlHost,
  context: InputContext = 'game',
  keymap: Keymap = DEFAULT_KEY_BINDINGS,
): OnScreenControlsHandle {
  const handle = mountOnScreenControls({ host, context, keymap });

  mounted.push(handle);

  return handle;
}

/**
 * The element one markup selector resolves to.
 *
 * @param selector Selector to resolve.
 * @returns The element.
 */
function control(selector: string): Element {
  const element = document.querySelector(selector);

  if (element === null) {
    throw new Error(`the fixture declares no ${selector}`);
  }

  return element;
}

/** Whether a control is out of the accessibility tree and the tab order. */
function isSuppressed(selector: string): boolean {
  const element = control(selector);

  return (
    element.hasAttribute('hidden') &&
    element.getAttribute('aria-hidden') === 'true' &&
    element.hasAttribute('disabled') &&
    element.getAttribute('tabindex') === '-1'
  );
}

afterEach(() => {
  for (const handle of mounted.splice(0, mounted.length)) {
    handle.unmount();
  }

  document.body.innerHTML = '';
});

/* ===== 1. Availability across the three contexts ===== */

describe('LEGACY_CONTROL_BINDINGS declares the overlay control', () => {
  it('gives .retry-button both contexts and the rest none of their own', () => {
    const [retry, restart, keepPlaying] = LEGACY_CONTROL_BINDINGS;

    expect(retry.selector).toBe('.retry-button');
    expect(retry.action).toBe('restart');
    expect(retry.contexts).toEqual(['game', 'overlay']);

    expect(restart.selector).toBe('.restart-button');
    expect(restart.contexts).toBeUndefined();

    expect(keepPlaying.selector).toBe('.keep-playing-button');
    expect(keepPlaying.contexts).toBeUndefined();
  });

  it('leaves the restart key bound in game alone', () => {
    // The control is reachable from the overlay; the key is not, so a keypress
    // during a dialog still restarts nothing.
    expect(DEFAULT_KEY_BINDINGS.restart.contexts).toEqual(['game']);
    expect(DEFAULT_KEY_BINDINGS.keepPlaying.contexts).toEqual(['overlay']);
  });
});

describe('a markup control follows the active context', () => {
  it('suppresses keep-playing in the game context', () => {
    seedMarkup();
    mount(createHost(), 'game');

    expect(isSuppressed('.keep-playing-button')).toBe(true);
    expect(isSuppressed('.retry-button')).toBe(false);
    expect(isSuppressed('.restart-button')).toBe(false);
  });

  it('suppresses restart but not retry in the overlay context', () => {
    seedMarkup();
    mount(createHost(), 'overlay');

    expect(isSuppressed('.restart-button')).toBe(true);
    expect(isSuppressed('.keep-playing-button')).toBe(false);
    expect(isSuppressed('.retry-button')).toBe(false);
  });

  it('suppresses all three during text entry', () => {
    seedMarkup();
    mount(createHost(), 'textEntry');

    expect(isSuppressed('.restart-button')).toBe(true);
    expect(isSuppressed('.retry-button')).toBe(true);
    expect(isSuppressed('.keep-playing-button')).toBe(true);
  });

  it('reapplies availability when setContext is called', () => {
    seedMarkup();

    const handle = mount(createHost(), 'game');

    expect(isSuppressed('.keep-playing-button')).toBe(true);

    handle.setContext('overlay');

    expect(isSuppressed('.keep-playing-button')).toBe(false);
    expect(isSuppressed('.restart-button')).toBe(true);
    expect(isSuppressed('.retry-button')).toBe(false);

    handle.setContext('game');

    expect(isSuppressed('.keep-playing-button')).toBe(true);
    expect(isSuppressed('.restart-button')).toBe(false);
  });

  it('reapplies availability when refresh reads the host context', () => {
    seedMarkup();

    let context: InputContext = 'game';
    const host = createHost();
    const handle = mountOnScreenControls({
      host,
      context: (): InputContext => context,
    });

    mounted.push(handle);

    expect(isSuppressed('.keep-playing-button')).toBe(true);

    context = 'overlay';
    handle.refresh();

    expect(isSuppressed('.keep-playing-button')).toBe(false);
  });

  it('re-derives a markup control from a remapped binding', () => {
    seedMarkup();

    const handle = mount(createHost(), 'game');

    // `.restart-button` declares no contexts of its own, so it follows the
    // table in force rather than the one it was mounted with.
    expect(isSuppressed('.restart-button')).toBe(false);

    handle.setKeymap({
      ...DEFAULT_KEY_BINDINGS,
      restart: { ...DEFAULT_KEY_BINDINGS.restart, contexts: ['overlay'] },
    });

    expect(isSuppressed('.restart-button')).toBe(true);

    // `.retry-button` declares its own, so a remapped binding does not move
    // it out of the overlay it lives in.
    expect(isSuppressed('.retry-button')).toBe(false);
  });

  it('reports the markup controls beside the generated ones', () => {
    seedMarkup();

    const handle = mount(createHost(), 'game');
    const markup = handle.controls.filter((entry) => !entry.generated);

    expect(markup.map((entry) => entry.action)).toEqual([
      'restart',
      'restart',
      'keepPlaying',
    ]);
    expect(handle.controls.length).toBeGreaterThan(markup.length);
  });
});

/* ===== 2. The attribute state an unavailable control carries ===== */

describe('an unavailable markup control carries every suppressor', () => {
  it('writes hidden, aria-hidden, disabled and tabindex', () => {
    seedMarkup();
    mount(createHost(), 'game');

    const element = control('.keep-playing-button');

    expect(element.getAttribute('hidden')).toBe('');
    expect(element.getAttribute('aria-hidden')).toBe('true');
    expect(element.getAttribute('disabled')).toBe('');
    expect(element.getAttribute('tabindex')).toBe('-1');
  });

  it('restores the markup state when the control becomes available', () => {
    seedMarkup();

    const handle = mount(createHost(), 'game');

    handle.setContext('overlay');

    const element = control('.keep-playing-button');

    expect(element.hasAttribute('hidden')).toBe(false);
    expect(element.hasAttribute('aria-hidden')).toBe(false);
    expect(element.hasAttribute('disabled')).toBe(false);
    expect(element.hasAttribute('tabindex')).toBe(false);
  });

  it('preserves an attribute the markup declared itself', () => {
    seedMarkup();
    control('.keep-playing-button').setAttribute('tabindex', '3');
    control('.restart-button').setAttribute('aria-hidden', 'false');

    const handle = mount(createHost(), 'game');

    // Suppressed in this context, then restored to what the markup declared.
    expect(control('.keep-playing-button').getAttribute('tabindex')).toBe('-1');

    handle.setContext('overlay');

    expect(control('.keep-playing-button').getAttribute('tabindex')).toBe('3');
    expect(control('.restart-button').getAttribute('aria-hidden')).toBe('true');

    handle.setContext('game');

    expect(control('.restart-button').getAttribute('aria-hidden')).toBe(
      'false',
    );
  });

  it('never writes the visible label of a markup control', () => {
    seedMarkup();

    const handle = mount(createHost(), 'game');

    handle.setContext('overlay');
    handle.setKeymap(DEFAULT_KEY_BINDINGS);

    expect(control('.retry-button').textContent).toBe('Try again');
    expect(control('.keep-playing-button').textContent).toBe('Keep going');
    expect(control('.restart-button').textContent).toBe('New Game');
  });
});

/* ===== 3. Publication suppression ===== */

describe('an unavailable markup control publishes nothing', () => {
  it('drops a click on a control inactive in the context', () => {
    seedMarkup();

    const host = createHost();

    mount(host, 'game');
    control('.keep-playing-button').dispatchEvent(new Event('click'));

    expect(host.log.published).toEqual([]);
  });

  it('publishes once the context makes the control available', () => {
    seedMarkup();

    const host = createHost();
    const handle = mount(host, 'game');

    handle.setContext('overlay');
    control('.keep-playing-button').dispatchEvent(new Event('click'));

    expect(host.log.published).toEqual(['keepPlaying']);
  });

  it('drops a click on restart while an overlay is open', () => {
    seedMarkup();

    const host = createHost();

    mount(host, 'overlay');
    control('.restart-button').dispatchEvent(new Event('click'));

    expect(host.log.published).toEqual([]);

    // The overlay's own retry control is still the way out of it.
    control('.retry-button').dispatchEvent(new Event('click'));

    expect(host.log.published).toEqual(['restart']);
  });

  it('reports the rejection rather than dropping it silently', () => {
    seedMarkup();

    const counted: string[] = [];
    const host = createHost();
    const handle = mountOnScreenControls({
      host,
      context: 'game',
      reporter: {
        log(): void {
          return;
        },

        count(metric: string): void {
          counted.push(metric);
        },
      },
    });

    mounted.push(handle);
    control('.keep-playing-button').dispatchEvent(new Event('click'));

    expect(counted).toContain('input.onScreen.rejected.unavailable');
    expect(counted).not.toContain('input.onScreen.action');
  });
});

/* ===== 4. Accessible names under a remapped keymap ===== */

describe('names track the keymap without overwriting the markup', () => {
  it('leaves a markup-declared accessible name alone', () => {
    seedMarkup();
    control('.restart-button').setAttribute('aria-label', 'Start over');

    const handle = mount(createHost(), 'game');

    handle.setKeymap({
      ...DEFAULT_KEY_BINDINGS,
      restart: {
        ...DEFAULT_KEY_BINDINGS.restart,
        keys: ['n'],
        codes: ['KeyN'],
      },
    });

    expect(control('.restart-button').getAttribute('aria-label')).toBe(
      'Start over',
    );
  });

  it('keeps a name it supplied itself current', () => {
    document.body.innerHTML = [
      '<button type="button" class="restart-button"></button>',
      '<div id="on-screen-controls"></div>',
    ].join('');

    const handle = mountOnScreenControls({
      host: createHost(),
      context: 'game',
      markupControls: [{ selector: '.restart-button', action: 'restart' }],
    });

    mounted.push(handle);

    const before = control('.restart-button').getAttribute('aria-label');

    expect(before).not.toBeNull();
    expect(before).toContain('R');

    handle.setKeymap({
      ...DEFAULT_KEY_BINDINGS,
      restart: {
        ...DEFAULT_KEY_BINDINGS.restart,
        keys: ['n'],
        codes: ['KeyN'],
      },
    });

    const after = control('.restart-button').getAttribute('aria-label');

    expect(after).not.toBe(before);
    expect(after).toContain('N');
  });
});

/* ===== 5. Unmount leaves index.html's markup behind ===== */

describe('unmount restores the markup it was handed', () => {
  it('removes every attribute this layer wrote', () => {
    seedMarkup();

    const handle = mount(createHost(), 'game');
    const element = control('.keep-playing-button');

    expect(element.hasAttribute('hidden')).toBe(true);

    handle.unmount();
    mounted.length = 0;

    expect(element.hasAttribute('hidden')).toBe(false);
    expect(element.hasAttribute('aria-hidden')).toBe(false);
    expect(element.hasAttribute('disabled')).toBe(false);
    expect(element.hasAttribute('tabindex')).toBe(false);
    expect(element.textContent).toBe('Keep going');
  });

  it('publishes nothing after unmount', () => {
    seedMarkup();

    const host = createHost();
    const handle = mount(host, 'overlay');

    handle.unmount();
    mounted.length = 0;
    control('.retry-button').dispatchEvent(new Event('click'));

    expect(host.log.published).toEqual([]);
  });
});
