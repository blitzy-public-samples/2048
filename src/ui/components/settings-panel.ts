// The settings dialog's contents: the surface every accessibility preference is
// reachable from.
//
// AAP R9. The product had no settings surface of any kind, and index.html's
// `#settings-button` had `aria-haspopup="dialog"` and `aria-controls` pointing
// at a dialog that nothing ever opened and that nothing would have put content
// into. Every preference the accessibility requirement names — remappable keys,
// colourblind-safe and high-contrast palettes, number-only rendering, reduced
// motion, mute and volume — was settable only from code.
//
// WHY THE PANEL, NOT THE ROUTER, RENDERS THIS
//   src/ui/screen-router.ts owns WHEN the dialog is shown, its focus trap and
//   the inertness of the board behind it. This module owns WHAT is inside it and
//   what each control does. The split is what lets the dialog's lifecycle be
//   tested without the preference wiring and the preference wiring without the
//   trap.
//
// KEYBOARD REMAPPING
//   Every one of the fourteen actions gets a row: its name, the keys bound to it
//   now, and a control that rebinds it. Rebinding is a CAPTURE: the next key
//   pressed becomes the binding. While a capture is armed the input manager is
//   suspended, so the key being captured cannot also move the board, and Escape
//   abandons the capture rather than closing the dialog — a capture has to be
//   cancellable without losing the dialog it was started from.
//
// EVERY CONTROL IS A REAL CONTROL
//   `button` and `input`, never a div with a handler: the dialog is reached by
//   keyboard and read by a screen reader, and both need real roles, real names
//   and real states. Toggle state is carried by `aria-pressed`, the unavailable
//   state by `disabled` AND `aria-disabled`, and the reason a control is
//   unavailable by `aria-describedby` — never by colour alone.
//
// This module reads no storage: `PreferenceStore` holds the values.

import {
  DEFAULT_KEY_BINDINGS,
  INPUT_ACTIONS,
  describeAction,
  describeBinding,
  findBindingConflict,
  remapAction,
} from '../../input/keymap';
import type { InputAction, Keymap } from '../../input/keymap';
import { themeIds } from '../../theme/themes';
import type { ThemeId } from '../../theme/themes';
import { MAX_VOLUME, MIN_VOLUME } from '../../audio/sound-map';
import { MOTION_SETTINGS, NOOP_UI_REPORTER, createSafeUiReporter } from '../a11y/settings';
import type {
  MotionSetting,
  PreferenceStore,
  UiReporter,
} from '../a11y/settings';

/* ==========================================================================
 * 1. Copy and names
 * ========================================================================== */

/** Every string this panel writes. Each is caller-overridable. */
export interface SettingsPanelCopy {
  readonly title: string;
  readonly appearanceLegend: string;
  readonly motionLegend: string;
  readonly soundLegend: string;
  readonly keysLegend: string;
  readonly numberOnlyLabel: string;
  readonly numberOnlyForcedHint: string;
  readonly mutedLabel: string;
  readonly volumeLabel: string;
  readonly closeLabel: string;

  /** Name of the control that rebinds one action. */
  readonly rebindLabel: (action: string) => string;

  /** Prompt shown while a capture is armed. */
  readonly capturePrompt: (action: string) => string;

  /** Announced when a captured key already belongs to another action. */
  readonly captureConflict: (key: string, occupant: string) => string;
  readonly themeLabel: (id: ThemeId) => string;
  readonly motionLabel: (setting: MotionSetting) => string;
}

const THEME_LABELS: Readonly<Record<ThemeId, string>> = Object.freeze({
  default: 'Original',
  'high-contrast': 'High contrast',
  'colorblind-safe': 'Colourblind safe',
});

const MOTION_LABELS: Readonly<Record<MotionSetting, string>> = Object.freeze({
  system: 'Follow system',
  reduce: 'Reduce motion',
  allow: 'Allow motion',
});

/** The default copy. */
export const settingsPanelCopy: SettingsPanelCopy = Object.freeze({
  title: 'Settings',
  appearanceLegend: 'Appearance',
  motionLegend: 'Motion',
  soundLegend: 'Sound',
  keysLegend: 'Keyboard',
  numberOnlyLabel: 'Numbers only',
  numberOnlyForcedHint:
    'Numbers only is required because this device has no WebGL support.',
  mutedLabel: 'Mute sound',
  volumeLabel: 'Volume',
  closeLabel: 'Close settings',
  rebindLabel: (action: string): string => `Change key for ${action}`,
  capturePrompt: (action: string): string =>
    `Press the new key for ${action}, or Escape to cancel.`,

  captureConflict: (key: string, occupant: string): string =>
    `${key} is already used by ${occupant}. Nothing was changed.`,
  themeLabel: (id: ThemeId): string => THEME_LABELS[id],
  motionLabel: (setting: MotionSetting): string => MOTION_LABELS[setting],
});

const REPORT_CONTEXT = 'settings-panel';

/** Counter raised once per panel rendered. */
const RENDER_METRIC = 'ui.settings.render';

/** Counter raised once per preference written from this panel. */
const SET_METRIC = 'ui.settings.set';

/** Counter raised once per capture armed. */
const CAPTURE_METRIC = 'ui.settings.capture';

/** Counter raised once per rebind applied. */
const REBIND_METRIC = 'ui.settings.rebind';

/** Counter raised once per capture abandoned. */
const CAPTURE_CANCEL_METRIC = 'ui.settings.capture.cancel';

/** Counter raised once per rebind refused for a conflict. */
const REBIND_CONFLICT_METRIC = 'ui.settings.rebind.conflict';

/** Counter raised once per call refused after `destroy()`. */
const AFTER_DESTROY_METRIC = 'ui.settings.after_destroy';

const PANEL_CLASS = 'settings-body';

const GROUP_CLASS = 'settings-group';

const ROW_CLASS = 'settings-row';

const CONTROL_CLASS = 'screen-button';

const FIELD_CLASS = 'screen-field';

const BINDING_CLASS = 'settings-binding';

const HINT_ID = 'settings-number-only-hint';

const CAPTURE_STATUS_ID = 'settings-capture-status';

/* ==========================================================================
 * 2. The surfaces the panel drives
 * ========================================================================== */

/** The part of the input manager the panel reads and writes. */
export interface SettingsInputSurface {
  getKeymap(): Keymap;
  setKeymap(keymap: Keymap): void;

  /** Stops the manager acting on keys, so a captured key does not also play. */
  suspend(): void;
  resume(): void;
}

/** The part of the on-screen control layer the panel drives. */
export interface SettingsControlSurface {
  setKeymap?(keymap: Keymap): void;
  refresh(): void;
}

/** Every construction parameter. `panel` and `preferences` carry the work. */
export interface SettingsPanelOptions {
  /** Container the body is rendered into: `#settings-panel`. */
  readonly panel?: Element | null;

  /** The preference store every control reads and writes. */
  readonly preferences?: PreferenceStore | null;

  /** The keymap owner, for the rebinding rows. Absent, no rows are rendered. */
  readonly input?: SettingsInputSurface | null;

  /** Control layer told about a rebind, so its labels follow. */
  readonly controls?: SettingsControlSurface | null;

  /** Document elements are created in. Defaults to the panel's own. */
  readonly document?: Document | null;

  /** Invoked by the close control. */
  readonly onClose?: () => void;
  readonly copy?: Partial<SettingsPanelCopy>;
  readonly reporter?: UiReporter;
}

/** The mounted panel. */
export interface SettingsPanel {
  /** Whether the body was rendered. */
  readonly mounted: boolean;

  /**
   * Renders the body, once, and syncs it.
   *
   * @returns Whether a body stands in the panel afterwards.
   */
  render(): boolean;

  /** Re-reads every preference and the keymap, and updates every control. */
  sync(): void;

  /** Whether a rebinding capture is armed. */
  isCapturing(): boolean;

  /** Abandons an armed capture, resuming input. */
  cancelCapture(): boolean;

  /**
   * Removes the body, releases every listener and abandons any capture. Every
   * later call is a reported no-op.
   */
  destroy(): void;
}

/* ==========================================================================
 * 3. Element helpers
 * ========================================================================== */

function readAmbientDocument(): Document | null {
  return typeof document === 'undefined' ? null : document;
}

function mergeCopy(overrides: Partial<SettingsPanelCopy> | undefined): SettingsPanelCopy {
  if (overrides === undefined) {
    return settingsPanelCopy;
  }

  return Object.freeze({ ...settingsPanelCopy, ...overrides });
}

/**
 * Writes `aria-pressed` and, for the unavailable case, both disabled states.
 *
 * @param button Control to write.
 * @param pressed Whether the control's setting is in force.
 * @param disabled Whether the control may be activated.
 */
function writeToggleState(
  button: HTMLButtonElement,
  pressed: boolean,
  disabled = false,
): void {
  button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  button.disabled = disabled;

  if (disabled) {
    button.setAttribute('aria-disabled', 'true');
  } else {
    button.removeAttribute('aria-disabled');
  }
}

/* ==========================================================================
 * 4. Construction
 * ========================================================================== */

/**
 * Builds the settings panel.
 *
 * Nothing is rendered here: `render()` does that, and src/ui/screen-router.ts
 * calls it from its `onSettingsOpen` hook so the body exists before the focus
 * trap looks for something to hold.
 *
 * @param options Panel, preference store, keymap owner, control layer and sink.
 * @returns The panel, with no body rendered yet.
 *
 * @example
 * ```ts
 * const settings = createSettingsPanel({ panel, preferences, input, controls });
 * const router = createScreenRouter({
 *   onSettingsOpen: () => { settings.render(); settings.sync(); },
 * });
 * ```
 */
export function createSettingsPanel(
  options: SettingsPanelOptions = {},
): SettingsPanel {
  const reporter = createSafeUiReporter(options.reporter ?? NOOP_UI_REPORTER);
  const copy = mergeCopy(options.copy);
  const panel = options.panel ?? null;
  const preferences = options.preferences ?? null;
  const input = options.input ?? null;
  const owner =
    options.document ?? panel?.ownerDocument ?? readAmbientDocument();

  /** Every control that reflects a preference, so `sync` can find them again. */
  const themeButtons = new Map<ThemeId, HTMLButtonElement>();
  const motionButtons = new Map<MotionSetting, HTMLButtonElement>();
  const bindingLabels = new Map<InputAction, HTMLElement>();
  const rebindButtons = new Map<InputAction, HTMLButtonElement>();
  const teardown: (() => void)[] = [];

  let numberOnlyButton: HTMLButtonElement | null = null;
  let mutedButton: HTMLButtonElement | null = null;
  let volumeInput: HTMLInputElement | null = null;
  let captureStatus: HTMLElement | null = null;
  let body: HTMLElement | null = null;
  let capturing: InputAction | null = null;
  let releaseCapture: (() => void) | null = null;
  let destroyed = false;

  const refuseAfterDestroy = (call: string): boolean => {
    if (!destroyed) {
      return false;
    }

    reporter.count(AFTER_DESTROY_METRIC, { call });

    return true;
  };

  const element = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
  ): HTMLElementTagNameMap[K] | null => {
    if (owner === null) {
      return null;
    }

    const created = owner.createElement(tag);

    if (className !== undefined) {
      created.className = className;
    }

    return created;
  };

  const button = (label: string): HTMLButtonElement | null => {
    const created = element('button', CONTROL_CLASS);

    if (created === null) {
      return null;
    }

    created.type = 'button';
    created.textContent = label;

    return created;
  };

  /** Binds a click listener and records its removal. */
  const onClick = (target: HTMLElement, handler: () => void): void => {
    const listener = (event: Event): void => {
      event.preventDefault();
      handler();
    };

    target.addEventListener('click', listener);
    teardown.push((): void => {
      target.removeEventListener('click', listener);
    });
  };

  /* ------------------------------------------------------------------
   * Preference writes
   * --------------------------------------------------------------- */

  const write = (key: string, apply: () => void): void => {
    if (preferences === null) {
      return;
    }

    apply();
    reporter.count(SET_METRIC, { key });
    sync();
  };

  /* ------------------------------------------------------------------
   * Key capture
   * --------------------------------------------------------------- */

  /**
   * Ends an armed capture.
   *
   * @param reason Carried into the report.
   * @param clearStatus Whether the prompt is cleared. `false` where the status
   *   holds a message the player still has to read — a refused rebind.
   * @returns Whether a capture was armed.
   */
  const endCapture = (reason: string, clearStatus = true): boolean => {
    const action = capturing;

    if (action === null) {
      return false;
    }

    capturing = null;
    releaseCapture?.();
    releaseCapture = null;
    input?.resume();

    if (clearStatus && captureStatus !== null) {
      captureStatus.textContent = '';
    }

    reporter.count(CAPTURE_CANCEL_METRIC, { action, reason });
    sync();

    return true;
  };

  /**
   * Writes one captured key onto an action.
   *
   * Both `key` and `code` are recorded: `key` is what the player pressed and is
   * matched case-insensitively, and `code` is the physical key, which is what
   * keeps the binding on the same key under another keyboard layout. Every
   * other field of the binding — its contexts, its `preventDefault` and its
   * slots — is left as it was, so a remap changes which key reaches an action
   * and nothing else about it.
   */
  const applyCapture = (action: InputAction, event: KeyboardEvent): boolean => {
    const held = input;

    if (held === null) {
      return false;
    }

    const key = typeof event.key === 'string' ? event.key : '';
    const code = typeof event.code === 'string' ? event.code : '';

    if (key.length === 0 && code.length === 0) {
      return false;
    }

    const keymap = held.getKeymap();

    // REFUSED ON A CONFLICT. `resolveInput` walks the actions in a fixed order
    // and the first binding that matches wins, so a rebind onto a key an earlier
    // action already holds in a shared context is silently shadowed: the player
    // would see the new binding written and the key would do something else.
    // Each of the action's own contexts is checked, because a key is free in one
    // and taken in another.
    for (const context of keymap[action].contexts) {
      for (const candidate of [key, code]) {
        if (candidate.length === 0) {
          continue;
        }

        const occupant = findBindingConflict(keymap, candidate, context);

        if (occupant === null || occupant.action === action) {
          continue;
        }

        reporter.count(REBIND_CONFLICT_METRIC, {
          action,
          key: candidate,
          occupant: occupant.action,
          context,
        });

        if (captureStatus !== null) {
          captureStatus.textContent = copy.captureConflict(
            candidate,
            describeAction(occupant.action),
          );
        }

        return false;
      }
    }

    const next = remapAction(keymap, action, {
      keys: key.length > 0 ? [key] : [],
      codes: code.length > 0 ? [code] : [],
    });

    held.setKeymap(next);
    options.controls?.setKeymap?.(next);
    options.controls?.refresh();

    reporter.count(REBIND_METRIC, { action, key, code });
    reporter.log('info', 'A key was rebound.', { action, key, code });

    return true;
  };

  const beginCapture = (action: InputAction): void => {
    if (owner === null || input === null) {
      return;
    }

    // A second request replaces the first rather than stacking.
    endCapture('replaced');

    capturing = action;

    // Suspended for the capture's lifetime: without this the key being captured
    // also resolves through the keymap it is about to replace.
    input.suspend();

    const listener = (event: KeyboardEvent): void => {
      // Captured on the way down and stopped here, so nothing else in the page
      // sees the key that is being bound.
      event.preventDefault();
      event.stopPropagation();

      const key = typeof event.key === 'string' ? event.key : '';

      if (key === 'Escape') {
        // Escape abandons the CAPTURE, not the dialog: a capture has to be
        // cancellable without losing the dialog it was started from, and the
        // router's own Escape handler never sees this press.
        endCapture('escape');

        return;
      }

      const applied = applyCapture(action, event);

      endCapture(applied ? 'applied' : 'conflict', applied);
    };

    owner.addEventListener('keydown', listener, true);
    releaseCapture = (): void => {
      owner.removeEventListener('keydown', listener, true);
    };

    if (captureStatus !== null) {
      captureStatus.textContent = copy.capturePrompt(describeAction(action));
    }

    reporter.count(CAPTURE_METRIC, { action });
    sync();
  };

  /* ------------------------------------------------------------------
   * Rendering
   * --------------------------------------------------------------- */

  const group = (legend: string): HTMLFieldSetElement | null => {
    const created = element('fieldset', GROUP_CLASS);

    if (created === null) {
      return null;
    }

    const caption = element('legend');

    if (caption !== null) {
      caption.textContent = legend;
      created.appendChild(caption);
    }

    return created;
  };

  const row = (): HTMLDivElement | null => element('div', ROW_CLASS);

  const renderAppearance = (host: HTMLElement): void => {
    const fieldset = group(copy.appearanceLegend);

    if (fieldset === null) {
      return;
    }

    const palettes = element('div', FIELD_CLASS);

    if (palettes !== null) {
      for (const id of themeIds) {
        const control = button(copy.themeLabel(id));

        if (control === null) {
          continue;
        }

        onClick(control, (): void => {
          write('theme', (): void => {
            preferences?.setTheme(id);
          });
        });
        themeButtons.set(id, control);
        palettes.appendChild(control);
      }

      fieldset.appendChild(palettes);
    }

    // Number-only mode, and the reason it can be unavailable. The hint is a
    // permanent element referenced by `aria-describedby`, so the reason is
    // announced with the control rather than only being visible.
    const modeRow = row();
    const mode = button(copy.numberOnlyLabel);
    const hint = element('p');

    if (modeRow !== null && mode !== null && hint !== null) {
      hint.id = HINT_ID;
      hint.textContent = copy.numberOnlyForcedHint;
      hint.hidden = true;
      mode.setAttribute('aria-describedby', HINT_ID);

      onClick(mode, (): void => {
        write('numberOnlyMode', (): void => {
          preferences?.setNumberOnlyMode(!(preferences?.isNumberOnlyMode() ?? false));
        });
      });

      numberOnlyButton = mode;
      modeRow.append(mode, hint);
      fieldset.appendChild(modeRow);
    }

    host.appendChild(fieldset);
  };

  const renderMotion = (host: HTMLElement): void => {
    const fieldset = group(copy.motionLegend);

    if (fieldset === null) {
      return;
    }

    const field = element('div', FIELD_CLASS);

    if (field !== null) {
      for (const setting of MOTION_SETTINGS) {
        const control = button(copy.motionLabel(setting));

        if (control === null) {
          continue;
        }

        onClick(control, (): void => {
          write('reducedMotion', (): void => {
            preferences?.setMotionSetting(setting);
          });
        });
        motionButtons.set(setting, control);
        field.appendChild(control);
      }

      fieldset.appendChild(field);
    }

    host.appendChild(fieldset);
  };

  const renderSound = (host: HTMLElement): void => {
    const fieldset = group(copy.soundLegend);

    if (fieldset === null) {
      return;
    }

    const mute = button(copy.mutedLabel);

    if (mute !== null) {
      onClick(mute, (): void => {
        write('muted', (): void => {
          preferences?.setMuted(!(preferences?.isMuted() ?? false));
        });
      });
      mutedButton = mute;
      fieldset.appendChild(mute);
    }

    const volumeRow = row();
    const label = element('label');
    const slider = element('input');

    if (volumeRow !== null && label !== null && slider !== null) {
      slider.type = 'range';
      slider.min = String(MIN_VOLUME);
      slider.max = String(MAX_VOLUME);
      slider.step = '0.05';
      slider.id = 'settings-volume';
      label.htmlFor = slider.id;
      label.textContent = copy.volumeLabel;

      const listener = (): void => {
        write('volume', (): void => {
          preferences?.setVolume(Number(slider.value));
        });
      };

      slider.addEventListener('input', listener);
      teardown.push((): void => {
        slider.removeEventListener('input', listener);
      });

      volumeInput = slider;
      volumeRow.append(label, slider);
      fieldset.appendChild(volumeRow);
    }

    host.appendChild(fieldset);
  };

  const renderKeys = (host: HTMLElement): void => {
    if (input === null) {
      return;
    }

    const fieldset = group(copy.keysLegend);

    if (fieldset === null) {
      return;
    }

    const status = element('p');

    if (status !== null) {
      status.id = CAPTURE_STATUS_ID;

      // A live region, so the capture prompt is announced when it appears
      // rather than only being on screen.
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      captureStatus = status;
      fieldset.appendChild(status);
    }

    for (const action of INPUT_ACTIONS) {
      const actionRow = row();
      const name = element('span');
      const bound = element('span', BINDING_CLASS);
      const control = button(copy.rebindLabel(describeAction(action)));

      if (
        actionRow === null ||
        name === null ||
        bound === null ||
        control === null
      ) {
        continue;
      }

      name.textContent = describeAction(action);

      // The control's accessible name carries the action, so the fourteen
      // rebind controls are told apart by a screen reader reading them out of
      // context; the visible label stays short.
      control.setAttribute('aria-label', copy.rebindLabel(describeAction(action)));
      control.textContent = 'Change';

      onClick(control, (): void => {
        beginCapture(action);
      });

      bindingLabels.set(action, bound);
      rebindButtons.set(action, control);
      actionRow.append(name, bound, control);
      fieldset.appendChild(actionRow);
    }

    host.appendChild(fieldset);
  };

  const renderClose = (host: HTMLElement): void => {
    const close = button(copy.closeLabel);

    if (close === null) {
      return;
    }

    onClick(close, (): void => {
      endCapture('closed');
      options.onClose?.();
    });

    host.appendChild(close);
  };

  const render = (): boolean => {
    if (refuseAfterDestroy('render')) {
      return false;
    }

    if (body !== null) {
      return true;
    }

    if (panel === null || owner === null) {
      reporter.log('warn', 'The settings panel has no container.', {
        context: REPORT_CONTEXT,
      });

      return false;
    }

    // A `<form>`, because style/_screens.scss resolves `> form` inside a shown
    // `.settings-panel` to the bounded reading surface. Submission is
    // suppressed: every control acts on activation, and there is nothing to
    // send.
    const form = element('form', PANEL_CLASS);

    if (form === null) {
      return false;
    }

    const submit = (event: Event): void => {
      event.preventDefault();
    };

    form.addEventListener('submit', submit);
    teardown.push((): void => {
      form.removeEventListener('submit', submit);
    });

    const heading = element('h2');

    if (heading !== null) {
      heading.textContent = copy.title;
      form.appendChild(heading);
    }

    renderAppearance(form);
    renderMotion(form);
    renderSound(form);
    renderKeys(form);
    renderClose(form);

    panel.appendChild(form);
    body = form;

    reporter.count(RENDER_METRIC, {
      themes: themeButtons.size,
      actions: rebindButtons.size,
    });

    sync();

    return true;
  };

  /* ------------------------------------------------------------------
   * Syncing
   * --------------------------------------------------------------- */

  function sync(): void {
    if (destroyed || body === null) {
      return;
    }

    if (preferences !== null) {
      const activeTheme = preferences.getTheme();

      for (const [id, control] of themeButtons) {
        writeToggleState(control, id === activeTheme);
      }

      const motion = preferences.getMotionSetting();

      for (const [setting, control] of motionButtons) {
        writeToggleState(control, setting === motion);
      }

      if (numberOnlyButton !== null) {
        const forced = preferences.isNumberOnlyForced();

        // Disabled while forced: turning it off is refused by the store, so the
        // control says so rather than accepting an activation that does nothing.
        writeToggleState(
          numberOnlyButton,
          preferences.isNumberOnlyMode(),
          forced,
        );

        const hint = owner?.getElementById(HINT_ID) ?? null;
        const hintElement =
          hint !== null && typeof (hint as { hidden?: unknown }).hidden === 'boolean'
            ? (hint as HTMLElement)
            : null;

        if (hintElement !== null) {
          hintElement.hidden = !forced;
        }
      }

      if (mutedButton !== null) {
        writeToggleState(mutedButton, preferences.isMuted());
      }

      if (volumeInput !== null) {
        volumeInput.value = String(preferences.getVolume());
      }
    }

    if (input !== null) {
      const keymap = input.getKeymap();

      for (const [action, label] of bindingLabels) {
        label.textContent = describeBinding(keymap, action);
      }

      for (const [action, control] of rebindButtons) {
        control.setAttribute(
          'aria-pressed',
          capturing === action ? 'true' : 'false',
        );
      }
    }
  }

  return Object.freeze({
    get mounted(): boolean {
      return body !== null;
    },

    render,
    sync,
    isCapturing: (): boolean => capturing !== null,
    cancelCapture: (): boolean => endCapture('requested'),

    destroy(): void {
      if (destroyed) {
        return;
      }

      endCapture('destroyed');
      destroyed = true;

      for (const remove of teardown) {
        remove();
      }

      teardown.length = 0;
      body?.remove();
      body = null;
      themeButtons.clear();
      motionButtons.clear();
      bindingLabels.clear();
      rebindButtons.clear();
      numberOnlyButton = null;
      mutedButton = null;
      volumeInput = null;
      captureStatus = null;
    },
  });
}

/**
 * The keymap a fresh install starts from, for a caller that offers a reset.
 *
 * Re-exported here so a consumer of this panel does not have to reach into the
 * input layer for the one value a reset needs.
 */
export const defaultKeymap: Keymap = DEFAULT_KEY_BINDINGS;
