// Contract suite for the settings dialog's contents, AAP R9.
//
// The accessibility requirement names five things a player must be able to
// change and one thing they must be able to remap. Every one of them was
// settable only from code: the store existed, the palettes existed, the keymap
// was remappable, and nothing in the product exposed any of it. This suite pins
// what the surface does, and three properties that are easy to get wrong:
//
//   real controls   a screen reader needs a role, a name and a state. Toggle
//                   state is `aria-pressed`, unavailability is `disabled` AND
//                   `aria-disabled`, and the REASON for unavailability is a
//                   referenced description — never colour alone.
//   the capture     rebinding reads the next key pressed. While it is armed the
//                   input manager must be suspended, or the key being bound also
//                   plays the game; and Escape must abandon the capture rather
//                   than the dialog it was started from.
//   the conflict    `resolveInput` returns the FIRST binding that matches, so a
//                   rebind onto a key an earlier action holds is silently
//                   shadowed. Written, and then not what happens.

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_KEY_BINDINGS,
  INPUT_ACTIONS,
  describeBinding,
} from '../../../src/input/keymap';
import type { Keymap } from '../../../src/input/keymap';
import { createPreferenceStore } from '../../../src/ui/a11y/settings';
import type { PreferenceStore } from '../../../src/ui/a11y/settings';
import { createSettingsPanel } from '../../../src/ui/components/settings-panel';
import type { SettingsPanel } from '../../../src/ui/components/settings-panel';
import { applyTheme } from '../../../src/theme/themes';

interface Harness {
  readonly panel: SettingsPanel;
  readonly host: HTMLElement;
  readonly preferences: PreferenceStore;
  readonly keymap: () => Keymap;
  readonly suspensions: readonly string[];
  readonly refreshes: () => number;
  readonly closes: () => number;
}

let active: Harness | null = null;

afterEach(() => {
  active?.panel.destroy();
  active?.preferences.destroy();
  active = null;
  applyTheme('default');
  document.body.innerHTML = '';
});

const harness = (): Harness => {
  const host = document.createElement('div');

  host.id = 'settings-panel';
  document.body.appendChild(host);

  const preferences = createPreferenceStore({});
  const suspensions: string[] = [];

  let keymap: Keymap = DEFAULT_KEY_BINDINGS;
  let refreshes = 0;
  let closes = 0;

  const panel = createSettingsPanel({
    panel: host,
    preferences,
    document,
    input: {
      getKeymap: (): Keymap => keymap,
      setKeymap: (next): void => {
        keymap = next;
      },
      suspend: (): void => {
        suspensions.push('suspend');
      },
      resume: (): void => {
        suspensions.push('resume');
      },
    },
    controls: {
      setKeymap: (): void => {},
      refresh: (): void => {
        refreshes += 1;
      },
    },
    onClose: (): void => {
      closes += 1;
    },
  });

  const built: Harness = {
    panel,
    host,
    preferences,
    keymap: (): Keymap => keymap,
    suspensions,
    refreshes: (): number => refreshes,
    closes: (): number => closes,
  };

  active = built;

  return built;
};

const buttonNamed = (host: HTMLElement, name: string): HTMLButtonElement => {
  const found = Array.from(host.querySelectorAll('button')).find(
    (candidate) =>
      candidate.textContent === name ||
      candidate.getAttribute('aria-label') === name,
  );

  if (found === undefined) {
    throw new Error(`no control named ${name}`);
  }

  return found;
};

const rowFor = (host: HTMLElement, action: string): HTMLElement => {
  const control = buttonNamed(host, `Change key for ${action}`);
  const row = control.closest('.settings-row');

  if (row === null) {
    throw new Error(`no row for ${action}`);
  }

  return row as HTMLElement;
};

const press = (key: string, code: string): void => {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key, code, bubbles: true }),
  );
};

/* ==========================================================================
 * Rendering
 * ========================================================================== */

describe('rendering', () => {
  it('renders one form, once, holding a group per concern', () => {
    const fixture = harness();

    expect(fixture.panel.mounted).toBe(false);
    expect(fixture.panel.render()).toBe(true);
    expect(fixture.panel.mounted).toBe(true);

    // A `<form>`: style/_screens.scss resolves `> form` inside a shown
    // `.settings-panel` to the bounded reading surface.
    expect(fixture.host.querySelectorAll('form')).toHaveLength(1);
    expect(
      Array.from(fixture.host.querySelectorAll('legend')).map(
        (legend) => legend.textContent,
      ),
    ).toEqual(['Appearance', 'Motion', 'Sound', 'Keyboard']);

    // A second render is a no-op, not a second body.
    expect(fixture.panel.render()).toBe(true);
    expect(fixture.host.querySelectorAll('form')).toHaveLength(1);
  });

  it('renders a row per action, with its bound keys spoken', () => {
    const fixture = harness();

    fixture.panel.render();

    // Fourteen action rows — every action, so none is unreachable from the
    // surface — plus the number-only row and the volume row.
    expect(fixture.host.querySelectorAll('.settings-row')).toHaveLength(
      INPUT_ACTIONS.length + 2,
    );

    const moveUp = rowFor(fixture.host, 'Move up');

    expect(moveUp.textContent).toContain('Move up');
    expect(moveUp.textContent).toContain(
      describeBinding(DEFAULT_KEY_BINDINGS, 'moveUp'),
    );

    // The Keep Going row now reports a key, where it used to report none.
    expect(rowFor(fixture.host, 'Keep going').textContent).toContain('C');
  });

  it('gives every rebind control a name that names its action', () => {
    const fixture = harness();

    fixture.panel.render();

    const labels = Array.from(
      fixture.host.querySelectorAll('button[aria-label]'),
    ).map((control) => control.getAttribute('aria-label'));

    expect(labels).toContain('Change key for Move up');
    expect(labels).toContain('Change key for Keep going');
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('renders nothing at all without a container', () => {
    const panel = createSettingsPanel({ document });

    expect(panel.render()).toBe(false);
    expect(panel.mounted).toBe(false);
    expect(() => {
      panel.sync();
      panel.destroy();
    }).not.toThrow();
  });
});

/* ==========================================================================
 * Preferences
 * ========================================================================== */

describe('the preference controls', () => {
  it('selects a palette and reports it as pressed', () => {
    const fixture = harness();

    fixture.panel.render();

    const contrast = buttonNamed(fixture.host, 'High contrast');
    const original = buttonNamed(fixture.host, 'Original');

    expect(original.getAttribute('aria-pressed')).toBe('true');
    expect(contrast.getAttribute('aria-pressed')).toBe('false');

    contrast.click();

    expect(fixture.preferences.getTheme()).toBe('high-contrast');
    expect(contrast.getAttribute('aria-pressed')).toBe('true');
    expect(original.getAttribute('aria-pressed')).toBe('false');
    expect(
      document.documentElement.getAttribute('data-theme'),
    ).toBe('high-contrast');
  });

  it('offers all three palettes, so the compliant ones are reachable', () => {
    const fixture = harness();

    fixture.panel.render();

    for (const name of ['Original', 'High contrast', 'Colourblind safe']) {
      expect(() => buttonNamed(fixture.host, name)).not.toThrow();
    }
  });

  it('makes every palette reachable by keyboard, not only by pointer', () => {
    const fixture = harness();

    fixture.panel.render();

    // The default palette is deliberately low-contrast and frozen by the AAP,
    // so the two palettes that DO clear WCAG AA are the whole of the compliant
    // path — and a control a keyboard or screen-reader user cannot reach is not
    // a path at all. Each must be a real enabled button in the tab order.
    for (const name of ['Original', 'High contrast', 'Colourblind safe']) {
      const control = buttonNamed(fixture.host, name);

      expect(control.tagName).toBe('BUTTON');
      expect(control.disabled).toBe(false);
      expect(control.hidden).toBe(false);
      expect(control.getAttribute('tabindex')).not.toBe('-1');
      expect(control.getAttribute('aria-hidden')).not.toBe('true');

      // Pressed state, so a screen reader announces which palette is active
      // rather than only that three buttons exist.
      expect(control.hasAttribute('aria-pressed')).toBe(true);
    }
  });

  it('chooses a motion setting', () => {
    const fixture = harness();

    fixture.panel.render();
    buttonNamed(fixture.host, 'Reduce motion').click();

    expect(fixture.preferences.getMotionSetting()).toBe('reduce');
    expect(fixture.preferences.isReducedMotion()).toBe(true);
    expect(
      buttonNamed(fixture.host, 'Reduce motion').getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('toggles number-only mode', () => {
    const fixture = harness();

    fixture.panel.render();

    const mode = buttonNamed(fixture.host, 'Numbers only');

    expect(mode.getAttribute('aria-pressed')).toBe('false');
    expect(mode.disabled).toBe(false);

    mode.click();

    expect(fixture.preferences.isNumberOnlyMode()).toBe(true);
    expect(mode.getAttribute('aria-pressed')).toBe('true');

    mode.click();

    expect(fixture.preferences.isNumberOnlyMode()).toBe(false);
  });

  it('states the reason number-only mode cannot be turned off', () => {
    const fixture = harness();

    fixture.panel.render();
    fixture.preferences.forceNumberOnlyMode('no WebGL context is available');
    fixture.panel.sync();

    const mode = buttonNamed(fixture.host, 'Numbers only');
    const hintId = mode.getAttribute('aria-describedby');
    const hint =
      hintId === null
        ? null
        : document.getElementById(hintId);

    // Disabled BOTH ways, and the reason is announced with the control.
    expect(mode.disabled).toBe(true);
    expect(mode.getAttribute('aria-disabled')).toBe('true');
    expect(mode.getAttribute('aria-pressed')).toBe('true');
    expect(hint).not.toBeNull();
    expect((hint as HTMLElement).hidden).toBe(false);
    expect(hint?.textContent ?? '').toContain('WebGL');
  });

  it('toggles mute and moves volume', () => {
    const fixture = harness();

    fixture.panel.render();

    const mute = buttonNamed(fixture.host, 'Mute sound');

    mute.click();

    expect(fixture.preferences.isMuted()).toBe(true);
    expect(mute.getAttribute('aria-pressed')).toBe('true');

    const slider = fixture.host.querySelector<HTMLInputElement>(
      'input[type="range"]',
    );

    expect(slider).not.toBeNull();
    expect(slider?.min).toBe('0');
    expect(slider?.max).toBe('1');

    if (slider !== null) {
      slider.value = '0.25';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }

    expect(fixture.preferences.getVolume()).toBeCloseTo(0.25);
  });

  it('labels the volume slider through a real label', () => {
    const fixture = harness();

    fixture.panel.render();

    const slider = fixture.host.querySelector<HTMLInputElement>(
      'input[type="range"]',
    );
    const label = fixture.host.querySelector<HTMLLabelElement>('label');

    expect(label?.htmlFor).toBe(slider?.id);
    expect(label?.textContent).toBe('Volume');
  });

  it('closes through its own control', () => {
    const fixture = harness();

    fixture.panel.render();
    buttonNamed(fixture.host, 'Close settings').click();

    expect(fixture.closes()).toBe(1);
  });
});

/* ==========================================================================
 * Rebinding
 * ========================================================================== */

describe('rebinding a key', () => {
  it('suspends input while a capture is armed, and resumes after', () => {
    const fixture = harness();

    fixture.panel.render();
    buttonNamed(fixture.host, 'Change key for Move up').click();

    expect(fixture.panel.isCapturing()).toBe(true);
    expect(fixture.suspensions).toEqual(['suspend']);

    press('q', 'KeyQ');

    expect(fixture.panel.isCapturing()).toBe(false);
    expect(fixture.suspensions).toEqual(['suspend', 'resume']);
  });

  it('writes the captured key and its code onto the action', () => {
    const fixture = harness();

    fixture.panel.render();
    buttonNamed(fixture.host, 'Change key for Move up').click();
    press('q', 'KeyQ');

    const binding = fixture.keymap().moveUp;

    // Both are recorded: the key is what was pressed, and the code is the
    // physical key, which keeps the binding under another layout.
    expect(binding.keys).toEqual(['q']);
    expect(binding.codes).toEqual(['KeyQ']);

    // Every other field survives, so a remap changes which key reaches the
    // action and nothing else about it.
    expect(binding.contexts).toEqual(DEFAULT_KEY_BINDINGS.moveUp.contexts);
    expect(binding.preventDefault).toBe(true);

    // And the row now reports it.
    expect(rowFor(fixture.host, 'Move up').textContent).toContain('Q');
  });

  it('tells the control layer, so its labels follow the rebind', () => {
    const fixture = harness();

    fixture.panel.render();

    const before = fixture.refreshes();

    buttonNamed(fixture.host, 'Change key for Move up').click();
    press('q', 'KeyQ');

    expect(fixture.refreshes()).toBeGreaterThan(before);
  });

  it('abandons the capture on Escape, changing nothing', () => {
    const fixture = harness();

    fixture.panel.render();
    buttonNamed(fixture.host, 'Change key for Move up').click();
    press('Escape', 'Escape');

    expect(fixture.panel.isCapturing()).toBe(false);
    expect(fixture.keymap().moveUp.keys).toEqual(
      DEFAULT_KEY_BINDINGS.moveUp.keys,
    );
    expect(fixture.suspensions).toEqual(['suspend', 'resume']);
  });

  it('refuses a key another action already holds, and says which', () => {
    const fixture = harness();

    fixture.panel.render();
    buttonNamed(fixture.host, 'Change key for New game').click();

    // R is `restart`; A is `moveLeft`, and both are bound in `'game'`.
    press('a', 'KeyA');

    expect(fixture.keymap().restart.keys).toEqual(
      DEFAULT_KEY_BINDINGS.restart.keys,
    );

    const status = fixture.host.querySelector('[role="status"]');

    expect(status?.textContent ?? '').toContain('Move left');
    expect(fixture.panel.isCapturing()).toBe(false);
  });

  it('accepts a key that is bound only in another context', () => {
    const fixture = harness();

    fixture.panel.render();

    // C is `keepPlaying`, in `'overlay'` alone; `restart` is `'game'` alone, so
    // the two cannot shadow each other.
    buttonNamed(fixture.host, 'Change key for New game').click();
    press('c', 'KeyC');

    expect(fixture.keymap().restart.keys).toEqual(['c']);
  });

  it('replaces one armed capture with the next rather than stacking', () => {
    const fixture = harness();

    fixture.panel.render();
    buttonNamed(fixture.host, 'Change key for Move up').click();
    buttonNamed(fixture.host, 'Change key for Move down').click();
    press('q', 'KeyQ');

    expect(fixture.keymap().moveUp.keys).toEqual(
      DEFAULT_KEY_BINDINGS.moveUp.keys,
    );
    expect(fixture.keymap().moveDown.keys).toEqual(['q']);
  });

  it('announces the capture prompt through a live region', () => {
    const fixture = harness();

    fixture.panel.render();

    const status = fixture.host.querySelector('[role="status"]');

    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.textContent).toBe('');

    buttonNamed(fixture.host, 'Change key for Move up').click();

    expect(status?.textContent ?? '').toContain('Move up');
    expect(
      buttonNamed(fixture.host, 'Change key for Move up').getAttribute(
        'aria-pressed',
      ),
    ).toBe('true');
  });

  it('cancels an armed capture on request, and on destroy', () => {
    const fixture = harness();

    fixture.panel.render();
    buttonNamed(fixture.host, 'Change key for Move up').click();

    expect(fixture.panel.cancelCapture()).toBe(true);
    expect(fixture.panel.cancelCapture()).toBe(false);

    buttonNamed(fixture.host, 'Change key for Move up').click();
    fixture.panel.destroy();

    expect(fixture.panel.isCapturing()).toBe(false);
    expect(fixture.suspensions.filter((entry) => entry === 'resume')).toHaveLength(
      2,
    );
  });

  it('removes its body and every listener on destroy', () => {
    const fixture = harness();

    fixture.panel.render();
    fixture.panel.destroy();

    expect(fixture.host.querySelector('form')).toBeNull();
    expect(fixture.panel.mounted).toBe(false);
    expect(fixture.panel.render()).toBe(false);
  });
});
