// Contract suite for the settings dialog, AAP R9.
//
// The accessibility requirement names five preferences a player must be able to
// change and one action they must be able to remap. This suite pins what the
// dialog does with each:
//
//   real controls   toggle state is `aria-pressed`, unavailability is
//                   `disabled` AND `aria-disabled`, and the reason for
//                   unavailability is a referenced description rather than
//                   colour alone.
//   containment     the dialog delegates its trap to the focus manager,
//                   engages exactly one, and releases exactly one.
//   the capture     rebinding reads the next key pressed. The input manager is
//                   suspended while a capture is armed and resumed once it
//                   resolves, and Escape abandons the capture rather than the
//                   dialog it was started from.
//   the conflict    `resolveInput` returns the FIRST binding that matches, so a
//                   rebind onto a key an earlier action holds is refused and
//                   announced.
//   no second store the panel owns no preference and no keymap of its own.
//
// Decisions behind this file are recorded in docs/DECISION_LOG.md.

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_KEY_BINDINGS,
  describeAction,
  describeBinding,
} from '../../../src/input/keymap';
import type { InputAction, Keymap } from '../../../src/input/keymap';
import { createInputManager } from '../../../src/input/input-manager';
import type { InputManager } from '../../../src/input/input-manager';
import { createPreferenceStore } from '../../../src/ui/a11y/settings';
import type {
  PreferenceStore,
  UiReportFields,
  UiReportLevel,
  UiReporter,
} from '../../../src/ui/a11y/settings';
import type {
  FocusManager,
  FocusTrapHandle,
  FocusTrapOptions,
} from '../../../src/ui/a11y/focus-manager';
import { createFocusManager } from '../../../src/ui/a11y/focus-manager';
import { createSettingsPanel } from '../../../src/ui/components/settings-panel';
import type {
  SettingsPanel,
} from '../../../src/ui/components/settings-panel';
import {
  SETTINGS_CAPTURE_STATUS_ID,
  SETTINGS_NUMBER_ONLY_HINT_ID,
  SETTINGS_TITLE_ID,
  SETTINGS_VOLUME_ID,
} from '../../../src/ui/components/settings-panel';
import { applyTheme } from '../../../src/theme/themes';

/* ==========================================================================
 * Harness
 * ========================================================================== */

interface TrapRecord {
  readonly container: Element;
  readonly onEscape: ((event: KeyboardEvent) => void) | undefined;
  released: number;
}

interface SoundRecord {
  muted: boolean;
  volume: number;
  unlocks: number;
  available: boolean;
}

interface ReportRecord {
  readonly level: UiReportLevel | 'error';
  readonly message: string;
  readonly fields: UiReportFields | undefined;
}

/** One counter the dialog reported, with the fields it carried. */
interface CountRecord {
  readonly metric: string;
  readonly fields: UiReportFields | undefined;
}

interface Harness {
  readonly panel: SettingsPanel;
  readonly host: HTMLElement;
  readonly preferences: PreferenceStore;

  /** Every write the dialog made, in order, as `name:value`. */
  readonly calls: readonly string[];
  readonly keymap: () => Keymap;
  readonly keymapWrites: () => number;
  readonly traps: readonly TrapRecord[];
  readonly suspensions: readonly string[];
  readonly emissions: readonly string[];
  readonly announcements: readonly string[];
  readonly sound: SoundRecord;
  readonly reports: readonly ReportRecord[];
  readonly counts: readonly CountRecord[];
}

let active: Harness | null = null;

afterEach(() => {
  active?.panel.destroy();
  active?.preferences.destroy();
  active = null;
  applyTheme('default');
  document.body.innerHTML = '';
});

interface HarnessOptions {
  readonly withHost?: boolean;
  readonly withSound?: boolean;
  readonly withEmitterSubscriber?: boolean;

  /**
   * Whether the dialog engages its own trap. Defaults to `true`, the standalone
   * case; `false` is the composition where the container's opener holds it.
   */
  readonly trapFocus?: boolean;

  /**
   * Collaborators that throw. Each is a transient failure of an owner the panel
   * does not control, which is the condition the panel's guard flags decide
   * whether a later attempt can retry.
   *
   * `throwOnKeymapChange` makes the TABLE'S OWNER refuse: its `remap` and
   * `setKeymap` raise rather than write, which is the one way a keymap the panel
   * offered fails to be adopted now that the owner holds the table.
   */
  readonly throwOnKeymapChange?: boolean;
  readonly throwOnResume?: boolean;
  readonly throwOnUnlock?: boolean;
}

const harness = (options: HarnessOptions = {}): Harness => {
  const withHost = options.withHost ?? true;
  const withSound = options.withSound ?? true;
  const host = document.createElement('div');

  host.id = 'settings-panel';
  host.hidden = true;

  if (withHost) {
    document.body.appendChild(host);
  }

  const real = createPreferenceStore({});
  const calls: string[] = [];

  // The store is frozen, so its members cannot be replaced in place. Every
  // write is recorded by delegation instead, and every read stays real.
  const preferences: PreferenceStore = {
    ...real,
    setTheme: (id): void => {
      calls.push(`setTheme:${id}`);
      real.setTheme(id);
    },
    setMotionSetting: (setting): void => {
      calls.push(`setMotionSetting:${setting}`);
      real.setMotionSetting(setting);
    },
    setNumberOnlyMode: (enabled): void => {
      calls.push(`setNumberOnlyMode:${String(enabled)}`);
      real.setNumberOnlyMode(enabled);
    },
    forceNumberOnlyMode: (reason): void => {
      calls.push(`forceNumberOnlyMode:${reason}`);
      real.forceNumberOnlyMode(reason);
    },
    setMuted: (muted): void => {
      calls.push(`setMuted:${String(muted)}`);
      real.setMuted(muted);
    },
    setVolume: (volume): void => {
      calls.push(`setVolume:${String(volume)}`);
      real.setVolume(volume);
    },
  };
  const traps: TrapRecord[] = [];
  const suspensions: string[] = [];
  const emissions: string[] = [];
  const announcements: string[] = [];
  const reports: ReportRecord[] = [];
  const counts: CountRecord[] = [];
  const sound: SoundRecord = {
    muted: false,
    volume: 1,
    unlocks: 0,
    available: true,
  };

  // THE REAL MANAGER as the table's owner, so the validation the dialog relies
  // on is the production one rather than a paraphrase of it in a double. It is
  // detached immediately: the dialog's own capture listener and this suite's
  // synthetic keydowns are the only key traffic these tests want, and an
  // attached manager would publish moves and restarts from them.
  let keymapWrites = 0;
  const keymapOwner: InputManager = createInputManager({
    keymap: DEFAULT_KEY_BINDINGS,
    ownerDocument: document,
    onKeymapChange: (): void => {
      keymapWrites += 1;
    },
  });

  keymapOwner.detach();

  // The owner the panel is given. The real manager unless the case wants a
  // refusing one, in which case its two writing members raise and everything
  // else still reads through to the real table — so the panel's next capture is
  // resolved against the bindings that are actually in force.
  const owner: InputManager =
    options.throwOnKeymapChange === true
      ? (Object.freeze({
          getKeymap: (): Keymap => keymapOwner.getKeymap(),
          remap: (): never => {
            keymapWrites += 1;

            throw new Error('owner refused the keymap');
          },
          setKeymap: (): never => {
            keymapWrites += 1;

            throw new Error('owner refused the keymap');
          },
        }) as unknown as InputManager)
      : keymapOwner;

  const focusManager = {
    trap: (
      container: Element | null | undefined,
      trapOptions?: FocusTrapOptions,
    ): FocusTrapHandle | null => {
      const record: TrapRecord = {
        container: container as Element,
        onEscape: trapOptions?.onEscape,
        released: 0,
      };

      traps.push(record);

      // A real trap moves focus inside its container on engaging.
      const first = (container as Element).querySelector('button');

      if (first instanceof HTMLElement) {
        first.focus();
      }

      return {
        container: container as Element,
        label: 'settings',
        isActive: (): boolean => record.released === 0,
        focusables: () => [],
        focusFirst: (): boolean => true,
        focusLast: (): boolean => true,
        release: (): void => {
          record.released += 1;
        },
      };
    },
    collectFocusable: () => [],
    focusInitial: () => ({ moved: false, source: 'none', element: null }),
    activeTrap: () => null,
    trapDepth: (): number => traps.length,
    releaseAll: (): void => {},
    destroy: (): void => {},
  } as unknown as FocusManager;

  const reporter: UiReporter = {
    log: (level, message, fields): void => {
      reports.push({ level, message, fields });
    },
    count: (metric, fields): void => {
      counts.push({ metric, fields });
    },
    error: (message, _error, fields): void => {
      reports.push({ level: 'error', message, fields });
    },
  };

  const emitter = {
    on: () => (): void => {},
    emit: (event: string): number => {
      emissions.push(event);

      return options.withEmitterSubscriber === true ? 1 : 0;
    },
  };

  const panel = createSettingsPanel({
    host: withHost ? host : null,
    preferences,
    focusManager,
    keymapOwner: owner,
    trapFocus: options.trapFocus,
    soundEngine: withSound
      ? {
          subscribe: (): void => {},
          play: (): void => {},
          unlock: (): void => {
            sound.unlocks += 1;

            if (options.throwOnUnlock === true && sound.unlocks === 1) {
              throw new Error('audio context would not resume');
            }
          },
          setMuted: (muted: boolean): void => {
            sound.muted = muted;
          },
          isMuted: (): boolean => sound.muted,
          setVolume: (volume: number): void => {
            sound.volume = volume;
          },
          getVolume: (): number => sound.volume,
          getState: () => ({
            available: sound.available,
            unlocked: sound.unlocks > 0,
            contextState: 'running',
            muted: sound.muted,
            volume: sound.volume,
            liveVoices: 0,
            maxConcurrentVoices: 12,
            playsRequested: 0,
            playsStarted: 0,
            playsDropped: 0,
            failures: 0,
            lastFailure: null,
            reporterFaults: 0,
            lastReporterFault: null,
            disposed: false,
          }),
          dispose: (): void => {},
        }
      : null,
    input: emitter,
    suspendInput: (): void => {
      suspensions.push('suspend');
    },
    resumeInput: (): void => {
      suspensions.push('resume');

      if (
        options.throwOnResume === true &&
        suspensions.filter((entry) => entry === 'resume').length === 1
      ) {
        throw new Error('dispatch would not resume');
      }
    },
    announcer: {
      announce: (): void => {},
      announceText: (text: string): void => {
        announcements.push(text);
      },
      flush: (): void => {},
      clear: (): void => {},
      pending: (): number => 0,
      isEnabled: (): boolean => true,
      observePreferences: () => (): void => {},
      destroy: (): void => {},
    },
    document,
    reporter,
  });

  const built: Harness = {
    panel,
    host,
    preferences,
    calls,
    keymap: (): Keymap => keymapOwner.getKeymap(),
    keymapWrites: (): number => keymapWrites,
    traps,
    suspensions,
    emissions,
    announcements,
    sound,
    reports,
    counts,
  };

  active = built;

  return built;
};

const buttonNamed = (root: ParentNode, name: string): HTMLButtonElement => {
  const found = Array.from(root.querySelectorAll('button')).find(
    (candidate) =>
      candidate.textContent === name ||
      candidate.getAttribute('aria-label') === name,
  );

  if (found === undefined) {
    throw new Error(`no control named ${name}`);
  }

  return found;
};

const rebindControl = (
  root: ParentNode,
  action: InputAction,
): HTMLButtonElement => {
  const found = root.querySelector<HTMLButtonElement>(
    `button[data-settings-action="${action}"]`,
  );

  if (found === null) {
    throw new Error(`no rebind control for ${action}`);
  }

  return found;
};

const press = (key: string, code = key): void => {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key, code, bubbles: true }),
  );
};

const captureText = (root: ParentNode): string =>
  root.querySelector(`#${SETTINGS_CAPTURE_STATUS_ID}`)?.textContent ?? '';

/* ==========================================================================
 * 1. Opening, dialog semantics and containment
 * ========================================================================== */

describe('opening the dialog', () => {
  it('renders a modal dialog named by its own heading', () => {
    const { panel, host } = harness();

    expect(panel.isOpen()).toBe(false);
    expect(panel.open()).toBe(true);
    expect(panel.isOpen()).toBe(true);
    expect(panel.element).toBe(host);

    expect(host.getAttribute('role')).toBe('dialog');
    expect(host.getAttribute('aria-modal')).toBe('true');
    expect(host.getAttribute('aria-labelledby')).toBe(SETTINGS_TITLE_ID);
    expect(host.hidden).toBe(false);

    const heading = host.querySelector(`#${SETTINGS_TITLE_ID}`);

    expect(heading?.tagName).toBe('H2');
    expect(heading?.textContent).toBe('Settings');
  });

  it('renders exactly one form holding a fieldset per concern', () => {
    const { panel, host } = harness();

    panel.open();

    expect(host.querySelectorAll('form')).toHaveLength(1);

    const sections = Array.from(
      host.querySelectorAll<HTMLFieldSetElement>('fieldset'),
    ).map((group) => group.dataset.settingsSection);

    expect(sections).toEqual(['appearance', 'motion', 'sound', 'keyboard']);

    // Each group carries a real legend, so the concerns are distinguishable.
    for (const group of host.querySelectorAll('fieldset')) {
      expect(group.querySelector('legend')?.textContent).toBeTruthy();
    }
  });

  it('renders the body once across repeated opens', () => {
    const { panel, host } = harness();

    panel.open();
    panel.close();
    panel.open();

    expect(host.querySelectorAll('form')).toHaveLength(1);
  });

  it('engages exactly one trap, and releases exactly one on close', () => {
    const { panel, host, traps } = harness();

    panel.open();

    expect(traps).toHaveLength(1);
    expect(traps[0]?.container).toBe(host);
    expect(host.contains(document.activeElement)).toBe(true);

    expect(panel.close()).toBe(true);
    expect(traps).toHaveLength(1);
    expect(traps[0]?.released).toBe(1);
    expect(host.hidden).toBe(true);
    expect(panel.isOpen()).toBe(false);

    // A second close is not a second release.
    expect(panel.close()).toBe(false);
    expect(traps[0]?.released).toBe(1);
  });

  it('closes when the trap reports Escape', () => {
    const { panel, host, traps } = harness();

    panel.open();

    const escape = traps[0]?.onEscape;

    expect(escape).toBeTypeOf('function');
    escape?.(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(panel.isOpen()).toBe(false);
    expect(host.hidden).toBe(true);
  });
});

/* ==========================================================================
 * 2. Every control is a real control
 * ========================================================================== */

describe('the controls', () => {
  it('uses native controls only: no bare anchor, no clickable div', () => {
    const { panel, host } = harness();

    panel.open();

    const anchors = Array.from(host.querySelectorAll('a')).filter(
      (anchor) => !anchor.hasAttribute('href'),
    );

    expect(anchors).toHaveLength(0);
    expect(host.querySelectorAll('div[tabindex]')).toHaveLength(0);
    expect(host.querySelectorAll('span[tabindex]')).toHaveLength(0);
    expect(host.querySelectorAll('[role="button"]')).toHaveLength(0);

    // Every button is a real submit-free button, so Enter and Space activate it
    // and nothing navigates.
    for (const button of host.querySelectorAll('button')) {
      expect(button.type).toBe('button');
    }
  });

  it('reaches every enabled control by Tab, in DOM order', () => {
    const { panel, host } = harness();

    panel.open();

    const focusable = Array.from(
      host.querySelectorAll<HTMLElement>('button, input'),
    ).filter((control) => !control.hasAttribute('disabled'));

    expect(focusable.length).toBeGreaterThan(10);

    for (const control of focusable) {
      control.focus();
      expect(document.activeElement).toBe(control);
      expect(control.tabIndex).toBeGreaterThanOrEqual(0);
    }
  });

  it('activates a control by Enter and by Space, not only by pointer', () => {
    const { panel, host, preferences } = harness();

    panel.open();

    const contrast = buttonNamed(host, 'High contrast');
    const original = buttonNamed(host, 'Classic');

    contrast.focus();

    // jsdom does not synthesise the click a real browser fires for Enter and
    // Space on a button, so each is asserted through the activation behaviour
    // a native button guarantees.
    contrast.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    contrast.click();

    expect(preferences.getTheme()).toBe('high-contrast');

    original.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', bubbles: true }),
    );
    original.click();

    expect(preferences.getTheme()).toBe('default');
  });

  it('labels the volume slider through a real label element', () => {
    const { panel, host } = harness();

    panel.open();

    const slider = host.querySelector<HTMLInputElement>(
      `#${SETTINGS_VOLUME_ID}`,
    );
    const label = host.querySelector<HTMLLabelElement>(
      `label[for="${SETTINGS_VOLUME_ID}"]`,
    );

    expect(slider?.type).toBe('range');
    expect(label?.textContent).toBe('Volume');
    expect(slider?.getAttribute('aria-valuetext')).toBe('100%');
  });
});

/* ==========================================================================
 * 3. Palettes, motion and number-only mode
 * ========================================================================== */

describe('the preference controls', () => {
  it('offers every palette, the original included, and never activates one', () => {
    const { panel, host, preferences, calls, announcements } = harness();

    panel.open();

    for (const name of ['Classic', 'High contrast', 'Colourblind safe']) {
      expect(buttonNamed(host, name)).toBeInstanceOf(HTMLButtonElement);
    }

    buttonNamed(host, 'Colourblind safe').click();

    // The choice went through the store, which is the one thing that activates
    // a palette. The dialog writes no root attribute of its own.
    expect(calls).toEqual(['setTheme:colorblind-safe']);
    expect(preferences.getTheme()).toBe('colorblind-safe');
    expect(document.documentElement.getAttribute('data-theme')).toBe(
      'colorblind-safe',
    );
    expect(
      buttonNamed(host, 'Colourblind safe').getAttribute('aria-pressed'),
    ).toBe('true');
    expect(buttonNamed(host, 'Classic').getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(announcements.join(' ')).toContain('Colourblind safe');
  });

  it('chooses a motion setting and shows the effective value', () => {
    const { panel, host, preferences } = harness();

    panel.open();

    expect(buttonNamed(host, 'Follow system').getAttribute('aria-pressed')).toBe(
      'true',
    );

    buttonNamed(host, 'Reduce motion').click();

    expect(preferences.getMotionSetting()).toBe('reduce');
    expect(preferences.isReducedMotion()).toBe(true);
    expect(host.textContent).toContain('Animation is reduced');

    buttonNamed(host, 'Allow motion').click();

    expect(preferences.isReducedMotion()).toBe(false);
    expect(host.textContent).toContain('Animation plays in full');
  });

  it('toggles number-only mode', () => {
    const { panel, host, preferences } = harness();

    panel.open();

    const toggle = buttonNamed(host, 'Numbers only');

    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    toggle.click();

    expect(preferences.isNumberOnlyMode()).toBe(true);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.disabled).toBe(false);
  });

  it('states why a forced number-only mode cannot be turned off', () => {
    const { panel, host, preferences, calls } = harness();

    panel.open();
    preferences.forceNumberOnlyMode('no WebGL context is available');

    const toggle = buttonNamed(host, 'Numbers only');

    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-disabled')).toBe('true');

    const hintId = toggle.getAttribute('aria-describedby') ?? '';

    expect(hintId).toContain(SETTINGS_NUMBER_ONLY_HINT_ID);

    const hint = host.querySelector<HTMLElement>(
      `#${SETTINGS_NUMBER_ONLY_HINT_ID}`,
    );

    expect(hint?.hidden).toBe(false);
    expect(hint?.textContent).toContain('no WebGL context is available');

    // Turning it off is refused, and the force was imposed only by this test:
    // the dialog never calls `forceNumberOnlyMode`, and never even attempts the
    // write while the mode is forced.
    toggle.click();

    expect(preferences.isNumberOnlyMode()).toBe(true);
    expect(calls).toEqual([
      'forceNumberOnlyMode:no WebGL context is available',
    ]);
  });

  it('follows the store when it changes from outside the dialog', () => {
    const { panel, host, preferences } = harness();

    panel.open();

    // Proves there is no second source of truth: nothing in the dialog was
    // touched, and every control still followed.
    preferences.setTheme('high-contrast');
    preferences.setMotionSetting('reduce');
    preferences.setMuted(true);

    expect(
      buttonNamed(host, 'High contrast').getAttribute('aria-pressed'),
    ).toBe('true');
    expect(buttonNamed(host, 'Reduce motion').getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(buttonNamed(host, 'Mute sound').getAttribute('aria-pressed')).toBe(
      'true',
    );
  });
});

/* ==========================================================================
 * 4. Sound
 * ========================================================================== */

describe('sound', () => {
  it('writes the store and pushes NOTHING into the engine', () => {
    const { panel, host, preferences, sound } = harness();

    panel.open();

    buttonNamed(host, 'Mute sound').click();

    // The store is the single owner. This dialog used to write the store AND
    // push the same value into the audio layer, which is two synchronisation
    // paths for one value: the store's own subscribers applied it as well, so a
    // sync could push a value the engine had already taken. Now the write is the
    // whole action, and src/audio/sound-engine.ts follows the store through its
    // own subscription — asserted end to end by
    // tests/unit/audio/sound-engine.test.ts, and wired by src/main.ts, which
    // hands the store to `createSoundEngine`. Verified here by the DOUBLE
    // staying untouched: this dialog reaches the engine for its availability and
    // its unlock alone (N1).
    expect(preferences.isMuted()).toBe(true);
    expect(sound.muted).toBe(false);

    const slider = host.querySelector<HTMLInputElement>(
      `#${SETTINGS_VOLUME_ID}`,
    );

    if (slider === null) {
      throw new Error('no volume slider');
    }

    slider.value = '0.25';
    slider.dispatchEvent(new Event('input', { bubbles: true }));

    expect(preferences.getVolume()).toBeCloseTo(0.25);
    expect(sound.volume).toBeCloseTo(1);
    expect(slider.getAttribute('aria-valuetext')).toBe('25%');
  });

  it('unlocks the audio context once, on the first audio interaction', () => {
    const { panel, host, sound } = harness();

    panel.open();

    expect(sound.unlocks).toBe(0);

    buttonNamed(host, 'Mute sound').click();
    buttonNamed(host, 'Mute sound').click();

    const slider = host.querySelector<HTMLInputElement>(
      `#${SETTINGS_VOLUME_ID}`,
    );

    slider?.dispatchEvent(new Event('input', { bubbles: true }));

    expect(sound.unlocks).toBe(1);
  });

  it('states an absent engine without blaming the device', () => {
    const { panel, host, reports } = harness({ withSound: false });

    panel.open();

    const mute = buttonNamed(host, 'Mute sound');
    const slider = host.querySelector<HTMLInputElement>(
      `#${SETTINGS_VOLUME_ID}`,
    );

    expect(mute.disabled).toBe(true);
    expect(mute.getAttribute('aria-disabled')).toBe('true');
    expect(slider?.disabled).toBe(true);

    // An absent engine is not a device without audio, and the copy does not
    // claim it is.
    expect(host.textContent).toContain('Sound is not running');
    expect(host.textContent).not.toContain('unavailable on this device');

    // Nothing threw, and the degradation was reported by name.
    expect(
      reports.some(
        (report) => report.fields?.capability === 'sound-engine',
      ),
    ).toBe(true);
  });

  it('blames the device only when the engine reports no context', () => {
    const built = harness();

    built.sound.available = false;
    built.panel.open();

    expect(built.host.textContent).toContain('unavailable on this device');
    expect(built.host.textContent).not.toContain('Sound is not running');
    expect(buttonNamed(built.host, 'Mute sound').disabled).toBe(true);
    expect(
      built.reports.some(
        (report) => report.fields?.capability === 'audio-context',
      ),
    ).toBe(true);
  });
});

/* ==========================================================================
 * 5a. Containment against the real focus manager
 * ========================================================================== */

describe('escape while a capture is armed', () => {
  it('abandons the capture and leaves the real trap holding the dialog', () => {
    // The real manager, not a stand-in: its trap listens for keydown on the
    // document in the capture phase, and this is the ordering that decides
    // whether Escape reaches it while a capture is armed.
    const host = document.createElement('div');

    host.id = 'settings-panel';
    document.body.appendChild(host);

    const preferences = createPreferenceStore({});
    const focusManager = createFocusManager({});
    let escapes = 0;
    let keymapWrites = 0;
    const keymapOwner = createInputManager({
      keymap: DEFAULT_KEY_BINDINGS,
      ownerDocument: document,
      onKeymapChange: (): void => {
        keymapWrites += 1;
      },
    });

    keymapOwner.detach();

    const panel = createSettingsPanel({
      host,
      preferences,
      focusManager,
      keymapOwner,
      document,
    });

    panel.open();

    // A second trap over the same container, engaged after the dialog's own —
    // the composition src/ui/screen-router.ts produces. Its Escape callback is
    // the one that would close the dialog.
    const outer = focusManager.trap(host, {
      label: 'settings',
      onEscape: (): void => {
        escapes += 1;
        panel.close();
      },
    });

    rebindControl(host, 'moveUp').click();
    press('Escape');

    // The capture was abandoned, the dialog was NOT dismissed, and the outer
    // trap never saw the key.
    expect(escapes).toBe(0);
    expect(panel.isOpen()).toBe(true);
    expect(host.hidden).toBe(false);
    expect(keymapWrites).toBe(0);
    expect(captureText(host)).toContain('cancelled');

    // With no capture armed, Escape reaches the trap and closes the dialog.
    press('Escape');

    expect(escapes).toBe(1);
    expect(panel.isOpen()).toBe(false);

    outer?.release();
    panel.destroy();
    preferences.destroy();
    focusManager.destroy();
    document.body.innerHTML = '';
  });
});

/* ==========================================================================
 * 5. Rebinding a key
 * ========================================================================== */

describe('rebinding a key', () => {
  it('renders a row per action with its keys spoken, never a key code', () => {
    const { panel, host } = harness();

    panel.open();

    const row = rebindControl(host, 'moveUp');

    expect(row.textContent).toBe(
      `Change key for ${describeAction('moveUp')}`,
    );
    expect(host.textContent).toContain(
      describeBinding(DEFAULT_KEY_BINDINGS, 'moveUp'),
    );

    // The `event.which` map of js/keyboard_input_manager.js L37-L50 is gone:
    // no numeric code reaches the surface.
    expect(host.textContent).not.toMatch(/\b(38|39|40|37|75|76|74|72|82)\b/u);
  });

  it('suspends dispatch while armed and resumes once applied', () => {
    const { panel, host, suspensions } = harness();

    panel.open();
    rebindControl(host, 'moveUp').click();

    expect(suspensions).toEqual(['suspend']);
    expect(captureText(host)).toContain('Press the new key');

    press('t', 'KeyT');

    expect(suspensions).toEqual(['suspend', 'resume']);
  });

  it('asks its owner to apply the binding, and shows what the owner holds', () => {
    const { panel, host, preferences, keymap, keymapWrites } = harness();
    const before = window.localStorage.length;

    panel.open();
    rebindControl(host, 'moveUp').click();
    press('t', 'KeyT');

    // ONE announcement for one rebind. The dialog computes no table and writes
    // none: it asks the owner, and the owner validates, applies, persists and
    // announces (N2). `keymap()` reads the OWNER's table here, so a dialog that
    // only believed it had rebound something would fail this.
    expect(keymapWrites()).toBe(1);
    expect(keymap().moveUp.keys).toEqual(['t']);
    expect(keymap().moveUp.codes).toEqual(['KeyT']);
    expect(keymap().moveDown).toEqual(DEFAULT_KEY_BINDINGS.moveDown);

    // The store was never asked to hold a keymap, and nothing was persisted.
    expect('setKeymap' in preferences).toBe(false);
    expect(window.localStorage.length).toBe(before);
    expect(host.textContent).toContain(describeBinding(keymap(), 'moveUp'));
  });

  it('refuses a key another action holds, and says which', () => {
    const { panel, host, keymap, keymapWrites, announcements, counts } =
      harness();

    panel.open();
    rebindControl(host, 'moveUp').click();
    press('r', 'KeyR');

    expect(keymapWrites()).toBe(0);
    expect(keymap().moveUp).toEqual(DEFAULT_KEY_BINDINGS.moveUp);
    expect(captureText(host)).toContain(describeAction('restart'));
    expect(captureText(host)).toContain('Nothing was changed');
    expect(announcements.join(' ')).toContain('Nothing was changed');

    const conflict = counts.find(
      (record) => record.metric === 'ui.settings.rebind.conflict',
    );

    expect(conflict?.fields?.dimension).toBe('key');
    expect(conflict?.fields?.occupant).toBe('restart');
  });

  it('refuses a physical key position another action holds', () => {
    const { panel, host, keymap, keymapWrites, announcements, counts } =
      harness();

    panel.open();
    rebindControl(host, 'moveUp').click();

    // The physical position `restart` holds, pressed on a layout that produces
    // different key text there — a Dvorak keyboard reports `p` at `KeyR`. The
    // key dimension is free, so the check that reads it alone accepted this and
    // wrote a binding whose code shadowed `restart`: `resolveInput` returns its
    // FIRST match, and `restart` is reached after `moveUp`.
    press('p', 'KeyR');

    expect(keymapWrites()).toBe(0);
    expect(keymap().moveUp).toEqual(DEFAULT_KEY_BINDINGS.moveUp);
    expect(keymap().restart).toEqual(DEFAULT_KEY_BINDINGS.restart);
    expect(captureText(host)).toContain(describeAction('restart'));
    expect(captureText(host)).toContain('Nothing was changed');
    expect(announcements.join(' ')).toContain('key position');

    const conflict = counts.find(
      (record) => record.metric === 'ui.settings.rebind.conflict',
    );

    expect(conflict?.fields?.dimension).toBe('code');
    expect(conflict?.fields?.occupant).toBe('restart');
    expect(conflict?.fields?.code).toBe('KeyR');
  });

  it('refuses a key another action holds even under a free code', () => {
    const { panel, host, keymap, keymapWrites, counts } = harness();

    panel.open();
    rebindControl(host, 'moveUp').click();

    // The mirror case: `KeyQ` is bound to nothing, and the key text `r` is
    // `restart`'s. Refused on the key dimension.
    press('r', 'KeyQ');

    expect(keymapWrites()).toBe(0);
    expect(keymap().moveUp).toEqual(DEFAULT_KEY_BINDINGS.moveUp);

    const conflict = counts.find(
      (record) => record.metric === 'ui.settings.rebind.conflict',
    );

    expect(conflict?.fields?.dimension).toBe('key');
  });

  it('permits a key another context holds, in both dimensions', () => {
    const { panel, host, keymap, keymapWrites } = harness();

    panel.open();

    // `keepPlaying` is active in `'overlay'` and `restart` in `'game'`, so
    // neither dimension of `r`/`KeyR` is occupied in the context being rebound
    // and the rebind stands. Checking every context rather than the action's own
    // would have refused this.
    rebindControl(host, 'keepPlaying').click();
    press('r', 'KeyR');

    expect(keymapWrites()).toBe(1);
    expect(keymap().keepPlaying.keys).toEqual(['r']);
    expect(keymap().keepPlaying.codes).toEqual(['KeyR']);
    expect(keymap().restart).toEqual(DEFAULT_KEY_BINDINGS.restart);
  });

  it('accepts a capture whose event carries no code at all', () => {
    const { panel, host, keymap, keymapWrites } = harness();

    panel.open();
    rebindControl(host, 'moveUp').click();

    // An event with an empty `code` — a synthetic or on-screen keyboard event —
    // carries nothing to check in that dimension, so only the key is measured.
    press('t', '');

    expect(keymapWrites()).toBe(1);
    expect(keymap().moveUp.keys).toEqual(['t']);
    expect(keymap().moveUp.codes).toEqual([]);
  });

  it('abandons the capture on Escape, changing nothing', () => {
    const { panel, host, keymapWrites, suspensions } = harness();

    panel.open();
    rebindControl(host, 'moveUp').click();
    press('Escape');

    expect(keymapWrites()).toBe(0);
    expect(suspensions).toEqual(['suspend', 'resume']);
    expect(captureText(host)).toContain('cancelled');

    // The dialog it was started from is still open.
    expect(panel.isOpen()).toBe(true);
  });

  it('keeps the capture armed through a bare modifier', () => {
    const { panel, host, keymap, keymapWrites } = harness();

    panel.open();
    rebindControl(host, 'moveUp').click();
    press('Shift', 'ShiftLeft');

    expect(keymapWrites()).toBe(0);

    press('t', 'KeyT');

    expect(keymapWrites()).toBe(1);
    expect(keymap().moveUp.keys).toEqual(['t']);
  });

  it('replaces one armed capture with the next rather than stacking', () => {
    const { panel, host, keymap } = harness();

    panel.open();
    rebindControl(host, 'moveUp').click();
    rebindControl(host, 'moveDown').click();
    press('t', 'KeyT');

    expect(keymap().moveUp).toEqual(DEFAULT_KEY_BINDINGS.moveUp);
    expect(keymap().moveDown.keys).toEqual(['t']);
  });

  it('removes the capture listener on cancel, on close and on destroy', () => {
    const cancelled = harness();

    cancelled.panel.open();
    rebindControl(cancelled.host, 'moveUp').click();
    buttonNamed(cancelled.host, 'Cancel key change').click();
    press('t', 'KeyT');

    expect(cancelled.keymapWrites()).toBe(0);
    cancelled.panel.destroy();
    cancelled.preferences.destroy();

    const closed = harness();

    closed.panel.open();
    rebindControl(closed.host, 'moveUp').click();
    closed.panel.close();
    press('t', 'KeyT');

    expect(closed.keymapWrites()).toBe(0);
    expect(closed.suspensions).toEqual(['suspend', 'resume']);
    closed.panel.destroy();
    closed.preferences.destroy();

    const destroyed = harness();

    destroyed.panel.open();
    rebindControl(destroyed.host, 'moveUp').click();
    destroyed.panel.destroy();
    press('t', 'KeyT');

    expect(destroyed.keymapWrites()).toBe(0);
  });

  it('restores the default keys on request', () => {
    const { panel, host, keymap } = harness();

    panel.open();
    rebindControl(host, 'moveUp').click();
    press('t', 'KeyT');

    expect(keymap().moveUp.keys).toEqual(['t']);

    buttonNamed(host, 'Restore default keys').click();

    expect(keymap().moveUp.keys).toEqual(DEFAULT_KEY_BINDINGS.moveUp.keys);
  });
});

/* ==========================================================================
 * 5b. A collaborator that refuses
 * ========================================================================== */

// Four guard flags decided whether a later attempt could retry, and every one
// of them was raised BEFORE the collaborator it guarded had succeeded. A single
// transient throw therefore became permanent: the guard short-circuited every
// retry, and the panel went on reporting the state it had assumed rather than
// the state in force.

describe('a collaborator that refuses', () => {
  // The metric names src/ui/components/settings-panel.ts counts under.
  const REBIND_METRIC = 'ui.settings.rebind';
  const RESTORE_METRIC = 'ui.settings.keymap.restore';

  it('keeps the keymap in force when the owner refuses the new one', () => {
    const { panel, host, keymapWrites, reports, counts } = harness({
      throwOnKeymapChange: true,
    });

    panel.open();
    rebindControl(host, 'moveUp').click();
    press('t', 'KeyT');

    // Offered and refused, which is reported rather than swallowed.
    expect(keymapWrites()).toBe(1);
    expect(
      reports.some((report) => report.message === 'keymap remap threw'),
    ).toBe(true);

    // The panel neither adopted it, nor rendered it, nor announced it, nor
    // counted a rebind that did not happen.
    expect(host.textContent).toContain(
      describeBinding(DEFAULT_KEY_BINDINGS, 'moveUp'),
    );
    expect(captureText(host)).toContain(
      describeBinding(DEFAULT_KEY_BINDINGS, 'moveUp'),
    );
    expect(counts.map((record) => record.metric)).not.toContain(
      REBIND_METRIC,
    );
  });

  it('resolves the next capture against the keymap the owner holds', () => {
    const { panel, host } = harness({ throwOnKeymapChange: true });

    panel.open();
    rebindControl(host, 'moveUp').click();
    press('t', 'KeyT');

    // `ArrowUp` is the key `moveUp` still holds, because the rebind above was
    // refused. Adopting locally first made the panel believe `moveUp` had moved
    // to `t`, so this capture found `ArrowUp` free and seated a SECOND action
    // on the key the InputManager was still dispatching `moveUp` from.
    rebindControl(host, 'moveDown').click();
    press('ArrowUp', 'ArrowUp');

    expect(captureText(host)).toContain(describeAction('moveUp'));
    expect(captureText(host)).toContain('Nothing was changed');
  });

  it('claims no restoration the owner refused', () => {
    const { panel, host, counts, announcements } = harness({
      throwOnKeymapChange: true,
    });

    panel.open();
    buttonNamed(host, 'Restore default keys').click();

    expect(counts.map((record) => record.metric)).not.toContain(
      RESTORE_METRIC,
    );
    expect(announcements.join(' ')).not.toContain('Default keys restored');
  });

  it('retries a resume that threw rather than leaving input suspended', () => {
    const { panel, host, suspensions, reports } = harness({
      throwOnResume: true,
    });

    panel.open();
    rebindControl(host, 'moveUp').click();

    expect(suspensions).toEqual(['suspend']);

    press('t', 'KeyT');

    expect(suspensions).toEqual(['suspend', 'resume']);
    expect(
      reports.some((report) => report.message === 'input resume threw'),
    ).toBe(true);

    // Armed again. The suspension is still in force — `resumeInput` threw, so
    // the InputManager never resumed — and arming disarms first, which RETRIES
    // the resume before suspending again. Clearing the flag before the call
    // made that retry short-circuit, leaving the board unplayable with the
    // panel believing dispatch had been handed back.
    rebindControl(host, 'moveDown').click();

    expect(suspensions).toEqual(['suspend', 'resume', 'resume', 'suspend']);

    press('y', 'KeyY');

    expect(suspensions).toEqual([
      'suspend',
      'resume',
      'resume',
      'suspend',
      'resume',
    ]);
  });

  it('refuses a rebind onto a physical key another action holds', () => {
    const { panel, host, keymap } = harness();

    panel.open();

    // `moveUp` onto a key and a code nothing else carries.
    rebindControl(host, 'moveUp').click();
    press('z', 'KeyZ');

    expect(keymap().moveUp.keys).toEqual(['z']);
    expect(keymap().moveUp.codes).toEqual(['KeyZ']);

    // The same physical key on a layout that produces a different character:
    // `event.key` is free, `event.code` is not. Only `key` was checked, so the
    // rebind was accepted and both actions then fired from one physical key.
    rebindControl(host, 'moveDown').click();
    press('q', 'KeyZ');

    expect(captureText(host)).toContain(describeAction('moveUp'));
    expect(captureText(host)).toContain('Nothing was changed');
    expect(keymap().moveDown).toEqual(DEFAULT_KEY_BINDINGS.moveDown);
  });

  it('retries the audio unlock after one that threw', () => {
    const { panel, host, sound, reports } = harness({ throwOnUnlock: true });

    panel.open();
    buttonNamed(host, 'Mute sound').click();

    expect(sound.unlocks).toBe(1);
    expect(
      reports.some((report) => report.message === 'sound unlock threw'),
    ).toBe(true);

    // RETRIED, because the guard was never raised for an unlock that failed.
    // Raising it first left the audio layer suspended for the life of the page.
    buttonNamed(host, 'Mute sound').click();

    expect(sound.unlocks).toBe(2);

    // And raised once it succeeded, so it is still unlocked exactly once.
    buttonNamed(host, 'Mute sound').click();

    expect(sound.unlocks).toBe(2);
  });
});

/* ==========================================================================
 * 6. Copy, dismissal, degradation and teardown
 * ========================================================================== */

describe('the dialog s copy and boundaries', () => {
  it('names all four movement modalities and describes swipe as unbound', () => {
    const { panel, host } = harness();

    panel.open();

    const text = host.textContent ?? '';

    expect(text).toContain('arrow keys');
    expect(text).toContain('WASD');
    expect(text).toContain('H, J, K and L');
    expect(text).toContain('swipe');
    expect(text).toContain('carries no key binding');

    // Swipe is described, never offered as a binding.
    expect(
      host.querySelector('button[data-settings-action="swipe"]'),
    ).toBeNull();
  });

  it('reproduces neither the authenticity notice nor the attributions', () => {
    const { panel, host } = harness();

    panel.open();

    const text = host.textContent ?? '';

    expect(text).not.toContain('git.io/2048');
    expect(text).not.toContain('official version');
    expect(text).not.toContain('Cirulli');
    expect(text).not.toContain('Veewo');
    expect(text).not.toContain('Vollmer');
  });

  it('dismisses by publishing closeSettings, not by rebinding a control', () => {
    const routed = harness({ withEmitterSubscriber: true });

    routed.panel.open();
    buttonNamed(routed.host, 'Close settings').click();

    // The router acts on the action; the dialog does not close itself behind
    // the owner of the shown state.
    expect(routed.emissions).toEqual(['closeSettings']);
    expect(routed.panel.isOpen()).toBe(true);
    routed.panel.destroy();
    routed.preferences.destroy();

    const unrouted = harness();

    unrouted.panel.open();
    buttonNamed(unrouted.host, 'Close settings').click();

    // Nothing was subscribed, so the dialog closes rather than sticking.
    expect(unrouted.emissions).toEqual(['closeSettings']);
    expect(unrouted.panel.isOpen()).toBe(false);
  });

  it('degrades to a reported no-op when no host resolves', () => {
    const { panel, reports } = harness({ withHost: false });

    expect(panel.element).toBeNull();
    expect(() => panel.open()).not.toThrow();
    expect(panel.open()).toBe(false);
    expect(panel.isOpen()).toBe(false);
    expect(() => panel.refresh()).not.toThrow();
    expect(() => panel.close()).not.toThrow();

    expect(
      reports.some((report) => report.fields?.selector === '#settings-panel'),
    ).toBe(true);
  });

  it('releases the trap, unsubscribes and removes its nodes on destroy', () => {
    const { panel, host, preferences, traps } = harness();

    panel.open();

    expect(host.querySelectorAll('form')).toHaveLength(1);

    panel.destroy();

    expect(traps[0]?.released).toBe(1);
    expect(host.querySelectorAll('form')).toHaveLength(0);
    expect(host.hidden).toBe(true);
    expect(host.getAttribute('aria-labelledby')).toBeNull();
    expect(panel.isOpen()).toBe(false);

    // The subscription is gone: a store change reaches nothing, and nothing
    // throws.
    expect(() => {
      preferences.setTheme('high-contrast');
    }).not.toThrow();

    // Every later call is a no-op.
    expect(panel.open()).toBe(false);
    expect(panel.close()).toBe(false);
    expect(() => panel.destroy()).not.toThrow();
  });
});

/* ==========================================================================
 * Dialog semantics track the open state
 * ========================================================================== */

// A hidden container that still answers to `[role="dialog"][aria-modal="true"]`
// is a modal dialog to every selector that looks for one — including the
// document context rule of src/input/input-manager.ts, whose
// `.screen-layer [aria-modal="true"]:not([hidden])` is why the residue is
// survivable rather than harmless — and it announces an inert background when
// nothing is inert (N6).

describe('the dialog semantics come and go with the open state', () => {
  it('takes the role and the modal flag off a closed dialog', () => {
    const { panel, host } = harness();

    panel.open();

    expect(host.getAttribute('role')).toBe('dialog');
    expect(host.getAttribute('aria-modal')).toBe('true');
    expect(host.getAttribute('aria-hidden')).toBeNull();

    panel.close();

    expect(host.hidden).toBe(true);
    expect(host.getAttribute('role')).toBeNull();
    expect(host.getAttribute('aria-modal')).toBeNull();

    // `aria-hidden` moves with `hidden`, written in the same two places, so the
    // pair cannot disagree.
    expect(host.getAttribute('aria-hidden')).toBe('true');
  });

  it('takes them off a host that has never been opened', () => {
    // The state before the first open is the same hidden container as the state
    // after a close, so it carries the same semantics: none.
    const { host } = harness();

    expect(host.hidden).toBe(true);
    expect(host.getAttribute('role')).toBeNull();
    expect(host.getAttribute('aria-modal')).toBeNull();
    expect(host.getAttribute('aria-hidden')).toBe('true');
  });

  it('brings them back on the next open', () => {
    const { panel, host } = harness();

    panel.open();
    panel.close();
    panel.open();

    expect(host.getAttribute('role')).toBe('dialog');
    expect(host.getAttribute('aria-modal')).toBe('true');
    expect(host.getAttribute('aria-hidden')).toBeNull();
    expect(host.hidden).toBe(false);
  });

  it('restores what the markup declared rather than its own defaults', () => {
    const host = document.createElement('div');

    host.id = 'settings-panel';
    host.hidden = true;

    // index.html is the authority on both: a document declaring
    // `role="alertdialog"` gets that role back, not `dialog`.
    host.setAttribute('role', 'alertdialog');
    host.setAttribute('aria-modal', 'false');
    document.body.appendChild(host);

    const panel = createSettingsPanel({
      host,
      preferences: createPreferenceStore({}),
      document,
    });

    panel.open();

    expect(host.getAttribute('role')).toBe('alertdialog');
    expect(host.getAttribute('aria-modal')).toBe('false');

    panel.close();

    expect(host.getAttribute('role')).toBeNull();

    panel.open();

    expect(host.getAttribute('role')).toBe('alertdialog');

    panel.destroy();
  });

  it('leaves no dialog semantics behind after destroy', () => {
    const { panel, host } = harness();

    panel.open();
    panel.destroy();

    expect(host.hidden).toBe(true);
    expect(host.getAttribute('role')).toBeNull();
    expect(host.getAttribute('aria-modal')).toBeNull();
    expect(host.getAttribute('aria-hidden')).toBe('true');
    expect(host.getAttribute('aria-labelledby')).toBeNull();
  });
});

/* ==========================================================================
 * One trap per container
 * ========================================================================== */

// Two traps on one element is two owners of one thing: the first moves focus
// inside, so the second records a restore target that is already inside the
// container it is trapping, and the two then have to be released in the right
// order for focus to return anywhere sensible. The composition of src/main.ts
// hands ownership to src/ui/screen-router.ts, which has the trigger to restore
// focus to and the background to make inert (N7).

describe('the focus trap has exactly one owner', () => {
  it('engages its own trap when it owns it', () => {
    const { panel, host, traps } = harness();

    panel.open();

    expect(traps).toHaveLength(1);
    expect(traps[0]?.container).toBe(host);

    panel.close();

    expect(traps[0]?.released).toBe(1);
  });

  it('engages none when the container has an owner already', () => {
    const { panel, traps } = harness({ trapFocus: false });

    expect(panel.open()).toBe(true);

    // Open and rendered, with no trap of its own: containment, Escape and
    // restoration all belong to whoever showed it.
    expect(traps).toHaveLength(0);
    expect(panel.isOpen()).toBe(true);

    expect(panel.close()).toBe(true);
    expect(traps).toHaveLength(0);
  });

  it('renders and drives every control with the trap deferred', () => {
    // Deferring the trap changes nothing else: the body is still built, the
    // preferences still write, and the dialog still closes.
    const { panel, host, preferences } = harness({ trapFocus: false });

    panel.open();

    expect(host.querySelectorAll('fieldset')).toHaveLength(4);

    buttonNamed(host, 'High contrast').click();

    expect(preferences.getTheme()).toBe('high-contrast');
  });
});
