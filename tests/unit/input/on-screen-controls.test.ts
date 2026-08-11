// Context-availability suite of src/input/on-screen-controls.ts.
//
// The host is a hand-written double: no mocking library, no spy on a global,
// and no storage. This suite is collected by the `unit:dom` project of
// vitest.config.ts, whose environment is 'jsdom'.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_KEY_BINDINGS,
  MOVE_ACTIONS,
  RELIC_SLOT_COUNT,
  REWARD_SLOT_COUNT,
  describeAction,
  describeMoveDirection,
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

/** What the host recorded, so a publication is observable. */
interface HostLog {
  readonly published: string[];
  readonly moves: Direction[];
}

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

describe('LEGACY_CONTROL_BINDINGS declares the three markup controls', () => {
  it('gives none of the three contexts of its own', () => {
    const [retry, restart, keepPlaying] = LEGACY_CONTROL_BINDINGS;

    // Each follows the contexts its action carries in the keymap, so a control
    // is live exactly where its action is. DL-CONTROL-08.
    expect(retry.selector).toBe('.retry-button');
    expect(retry.action).toBe('restart');
    expect(retry.contexts).toBeUndefined();

    expect(restart.selector).toBe('.restart-button');
    expect(restart.contexts).toBeUndefined();

    expect(keepPlaying.selector).toBe('.keep-playing-button');
    expect(keepPlaying.contexts).toBeUndefined();
  });

  it('reads restart in game and keepPlaying in the overlay', () => {
    // The two contexts every one of the three resolves against.
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

  it('suppresses both restart controls in the overlay context', () => {
    seedMarkup();
    mount(createHost(), 'overlay');

    // `restart` is a game-context action, so both controls that publish it are
    // withdrawn together; the terminal states offer their own controls instead.
    expect(isSuppressed('.restart-button')).toBe(true);
    expect(isSuppressed('.retry-button')).toBe(true);
    expect(isSuppressed('.keep-playing-button')).toBe(false);
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
    expect(isSuppressed('.retry-button')).toBe(true);

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

    expect(isSuppressed('.restart-button')).toBe(false);

    handle.setKeymap({
      ...DEFAULT_KEY_BINDINGS,
      restart: { ...DEFAULT_KEY_BINDINGS.restart, contexts: ['overlay'] },
    });

    expect(isSuppressed('.restart-button')).toBe(true);

    // `.retry-button` declares no contexts either, so the remap moves both
    // controls that publish `restart` together.
    expect(isSuppressed('.retry-button')).toBe(true);
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

    // And the retained retry control alongside it: `restart` belongs to the
    // board's context, so neither control publishes from an overlay.
    control('.retry-button').dispatchEvent(new Event('click'));

    expect(host.log.published).toEqual([]);
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

// The module's entry point is a factory, so nothing stopped a second call over
// the same host from appending a second pad and a second action group: the
// host then carried two of every generated control — two tab stops per action,
// two accessible names, and two click listeners publishing the same action
// twice from one press.

describe('mounting twice over one host leaves one set of controls', () => {
  it('replaces the generated groups rather than appending to them', () => {
    seedMarkup();

    const root = control('#on-screen-controls');

    mount(createHost());

    const afterFirst = root.querySelectorAll('button').length;
    const groupsAfterFirst = root.querySelectorAll(
      '.on-screen-controls-group',
    ).length;

    expect(groupsAfterFirst).toBe(2);
    expect(afterFirst).toBeGreaterThan(0);

    mount(createHost());

    // EXACTLY the same counts, not double them.
    expect(root.querySelectorAll('.on-screen-controls-group')).toHaveLength(2);
    expect(root.querySelectorAll('button')).toHaveLength(afterFirst);
  });

  it('publishes one action per press after a remount', () => {
    seedMarkup();

    const first = createHost();

    mount(first);

    const second = createHost();

    mount(second);

    const root = control('#on-screen-controls');
    const up = root.querySelector<HTMLButtonElement>(
      '[data-action="moveUp"]',
    );

    expect(up).not.toBeNull();
    up?.click();

    // The surviving set publishes to the host that created it, once.
    expect(second.log.moves).toHaveLength(1);
    expect(first.log.moves).toHaveLength(0);
  });

  it('leaves the host clean after the surviving handle unmounts', () => {
    seedMarkup();

    const root = control('#on-screen-controls');

    mount(createHost());

    const handle = mount(createHost());

    handle.unmount();

    expect(root.querySelectorAll('.on-screen-controls-group')).toHaveLength(0);
    expect(root.querySelectorAll('button')).toHaveLength(0);
  });
});

/* ==========================================================================
 * 6. Availability narrowed beyond the context, and one control per slot
 * ========================================================================== */

// The three contexts are coarse and several actions share one of them, so a
// caller that knows which screen is showing and which slot is filled narrows
// each control through the `available` predicate. `indexes` is what generates
// one control per slot rather than one per action, and the two are read
// together: a slot with no control cannot be reached by a pointer or by a
// screen reader however many keys are bound to it.
describe('availability narrows by the caller as well as the context', () => {
  it('withdraws a control the predicate refuses, in an active context', () => {
    seedMarkup();

    const handle = mountOnScreenControls({
      host: createHost(),
      context: 'game',
      keymap: DEFAULT_KEY_BINDINGS,
      available: (action): boolean => action !== 'restart',
    });

    mounted.push(handle);

    // `restart` is active in `'game'` by its binding, so only the predicate can
    // have withdrawn it.
    expect(isSuppressed('.restart-button')).toBe(true);
    expect(isSuppressed('.retry-button')).toBe(true);
  });

  it('reapplies the predicate on refresh, so a screen change lands', () => {
    seedMarkup();

    let allowed = false;

    const handle = mountOnScreenControls({
      host: createHost(),
      context: 'game',
      keymap: DEFAULT_KEY_BINDINGS,
      available: (): boolean => allowed,
    });

    mounted.push(handle);

    expect(isSuppressed('.restart-button')).toBe(true);

    allowed = true;
    handle.refresh();

    expect(isSuppressed('.restart-button')).toBe(false);
  });

  it('keeps every control where a predicate raises, and does not throw', () => {
    seedMarkup();

    const handle = mountOnScreenControls({
      host: createHost(),
      context: 'game',
      keymap: DEFAULT_KEY_BINDINGS,
      available: (): boolean => {
        throw new Error('the predicate is hostile');
      },
    });

    mounted.push(handle);

    expect(isSuppressed('.restart-button')).toBe(false);
    expect(() => {
      handle.refresh();
    }).not.toThrow();
  });

  it('generates one control per relic slot the keymap binds a key for', () => {
    seedMarkup();

    const slots = Array.from(
      { length: RELIC_SLOT_COUNT },
      (_unused, slot): number => slot,
    );

    const handle = mountOnScreenControls({
      host: createHost(),
      context: 'game',
      keymap: DEFAULT_KEY_BINDINGS,
      indexes: { activateRelic: slots },
    });

    mounted.push(handle);

    // ONE PER SLOT, the last one included: a cap below `RELIC_SLOT_COUNT` left
    // the ninth relic with a key binding and no control at all.
    const generated = handle.controls.filter(
      (entry) => entry.action === 'activateRelic',
    );

    expect(generated).toHaveLength(RELIC_SLOT_COUNT);
    expect(generated.map((entry) => entry.index)).toEqual(slots);
  });

  it('generates one control per reward slot as well', () => {
    seedMarkup();

    const slots = Array.from(
      { length: REWARD_SLOT_COUNT },
      (_unused, slot): number => slot,
    );

    const handle = mountOnScreenControls({
      host: createHost(),
      context: 'overlay',
      keymap: DEFAULT_KEY_BINDINGS,
      indexes: { selectReward: slots },
    });

    mounted.push(handle);

    const generated = handle.controls.filter(
      (entry) => entry.action === 'selectReward',
    );

    expect(generated).toHaveLength(REWARD_SLOT_COUNT);
    expect(generated.map((entry) => entry.index)).toEqual(slots);
  });

  it('withdraws the slots the predicate refuses and keeps the rest', () => {
    seedMarkup();

    const handle = mountOnScreenControls({
      host: createHost(),
      context: 'overlay',
      keymap: DEFAULT_KEY_BINDINGS,
      indexes: { selectReward: [0, 1, 2] },

      // Two offers stand, so the third slot is refused.
      available: (action, index): boolean =>
        action !== 'selectReward' || index < 2,
    });

    mounted.push(handle);

    const shown = handle.controls
      .filter((entry) => entry.action === 'selectReward')
      .map((entry) => ({
        index: entry.index,
        suppressed: entry.element.getAttribute('aria-hidden') === 'true',
      }));

    expect(shown).toEqual([
      { index: 0, suppressed: false },
      { index: 1, suppressed: false },
      { index: 2, suppressed: true },
    ]);
  });
});

describe('the movement controls paint the direction word alone', () => {
  /** The generated control for one movement action. */
  const padControl = (
    handle: OnScreenControlsHandle,
    action: 'moveUp' | 'moveRight' | 'moveDown' | 'moveLeft',
  ): Element => {
    const entry = handle.controls.find(
      (candidate) =>
        candidate.action === action &&
        candidate.element.classList.contains('on-screen-control'),
    );

    if (entry === undefined) {
      throw new Error(`no generated control for ${action}`);
    }

    return entry.element;
  };

  it('paints the word and keeps the verbose accessible name', () => {
    seedMarkup();

    const handle = mount(createHost());

    for (const action of MOVE_ACTIONS) {
      const element = padControl(handle, action);
      const painted = element.textContent ?? '';
      const name = element.getAttribute('aria-label') ?? '';

      // The pad's position states the direction, so repeating "Move" four times
      // is what forced the group to wrap. DL-CONTROL-09.
      expect(painted).toBe(describeMoveDirection(action));
      expect(name).toContain(describeAction(action));
      expect(name.length).toBeGreaterThan(painted.length);
    }
  });

  it('keeps the painted text inside the accessible name', () => {
    seedMarkup();

    const handle = mount(createHost());

    // WCAG 2.5.3 label-in-name, asserted on the rendered attributes rather than
    // on the vocabulary that produced them.
    for (const action of MOVE_ACTIONS) {
      const element = padControl(handle, action);

      expect(
        (element.getAttribute('aria-label') ?? '').toLowerCase(),
      ).toContain((element.textContent ?? '').toLowerCase());
    }
  });

  it('leaves every other generated control painting its full label', () => {
    seedMarkup();

    const handle = mount(createHost());
    const restart = handle.controls.find(
      (candidate) =>
        candidate.action === 'restart' &&
        candidate.element.classList.contains('on-screen-control'),
    );

    expect(restart?.element.textContent).toBe(describeAction('restart'));
  });

  it('carries the direction attribute the pad layout places it by', () => {
    seedMarkup();

    const handle = mount(createHost());
    const placed = MOVE_ACTIONS.map((action) =>
      padControl(handle, action).getAttribute('data-direction'),
    );

    // 0 up, 1 right, 2 down, 3 left — the encoding style/main.scss keys the
    // three-column pad on.
    expect(placed).toEqual(['0', '1', '2', '3']);
  });

  it('paints a slotted control with its own label, never a direction word', () => {
    seedMarkup();

    const handle = mount(createHost());
    const slotted = handle.controls.filter(
      (candidate) => candidate.action === 'selectReward',
    );

    expect(slotted.length).toBeGreaterThan(0);

    // Only a movement control's painted text is shortened. Every other control
    // paints its own label, which for a slotted control is that label optionally
    // followed by a slot number — never a bare direction word.
    for (const entry of slotted) {
      const painted = entry.element.textContent ?? '';

      expect(painted.startsWith(describeAction('selectReward'))).toBe(true);
      expect(painted).toMatch(
        new RegExp(`^${describeAction('selectReward')}( \\d+)?$`, 'u'),
      );
    }
  });
});

describe('the mount log distinguishes the host from the whole layer', () => {
  it('states the generated count and the adopted count separately', () => {
    seedMarkup();

    const logged: { message: string; fields?: Record<string, unknown> }[] = [];
    const handle = mountOnScreenControls({
      host: createHost(),
      context: 'game',
      reporter: {
        log(_level: string, message: string, fields?: unknown): void {
          logged.push({
            message,
            fields: fields as Record<string, unknown> | undefined,
          });
        },

        count(): void {
          return;
        },
      },
    });

    mounted.push(handle);

    const entry = logged.find(
      (candidate) =>
        candidate.message === 'The on-screen controls are mounted.',
    );

    // A reader of that sentence counts the buttons in the host, and the single
    // figure counted the adopted markup controls too. DL-CONTROL-10.
    const inHost = entry?.fields?.['inHost'];
    const adopted = entry?.fields?.['adopted'];
    const controls = entry?.fields?.['controls'];

    expect(typeof inHost).toBe('number');
    expect(typeof adopted).toBe('number');
    expect(adopted).toBe(LEGACY_CONTROL_BINDINGS.length);
    expect((inHost as number) + (adopted as number)).toBe(controls);
  });

  it('counts exactly the controls rendered into the host', () => {
    seedMarkup();

    const logged: Record<string, unknown>[] = [];
    const handle = mountOnScreenControls({
      host: createHost(),
      context: 'game',
      reporter: {
        log(_level: string, message: string, fields?: unknown): void {
          if (message === 'The on-screen controls are mounted.') {
            logged.push((fields ?? {}) as Record<string, unknown>);
          }
        },

        count(): void {
          return;
        },
      },
    });

    mounted.push(handle);

    const rendered = document.querySelectorAll(
      '#on-screen-controls button',
    ).length;

    expect(logged[0]?.['inHost']).toBe(rendered);
  });
});
