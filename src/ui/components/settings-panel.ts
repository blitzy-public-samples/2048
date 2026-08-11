// The accessibility and preferences surface: the focus-managed modal dialog
// every preference named by AAP R9 is reachable from.
//
// Origin: requirement R9, AAP section 0.6.2.6 Group 6, and working assumption
// A5 for the mute and volume controls.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
// this module's area enumerated:
//   TR-PANEL-01  js/keyboard_input_manager.js L37-L50  the `event.which` code
//                                                      map, presented as the
//                                                      remappable bindings read
//                                                      from
//                                                      `KeyboardEvent.key` and
//                                                      `KeyboardEvent.code`
//   TR-PANEL-02  index.html L31, L38, L39              the three hrefless `<a>`
//                                                      controls, superseded by
//                                                      real `<button>` and
//                                                      `<input>` elements
//   TR-PANEL-03  style/main.scss L159-L168             the button mixin,
//                                                      applied through
//                                                      `.screen-button`
//   TR-PANEL-04  style/main.scss L109-L115             the `:after`
//                                                      pseudo-content captions,
//                                                      replaced by real text
//                                                      nodes and the
//                                                      `.visually-hidden`
//                                                      utility
//   TR-PANEL-05  js/html_actuator.js L3-L4,            the unchecked host
//                js/keyboard_input_manager.js L141     lookups, replaced by
//                                                      `resolveMount`
//   TR-PANEL-06  js/local_storage_manager.js L37       the discarded caught
//                                                      value, replaced by a
//                                                      report that always
//                                                      carries its error object
//   TR-PANEL-07  target-only row                       `createSettingsPanel()`
//                                                      and the focus-managed
//                                                      dialog
//   TR-PANEL-08  target-only row                       `settingsPanelCopy` and
//                                                      the section vocabulary
//
// Decisions: DL-PANEL-01, DL-PANEL-02, DL-PANEL-03, DL-PANEL-04, DL-PANEL-05,
// DL-PANEL-06, DL-PANEL-07 (docs/DECISION_LOG.md).

import type { FocusManager, FocusTrapHandle } from '../a11y/focus-manager';
import type { LiveRegionAnnouncer } from '../a11y/live-region';
import type {
  MotionSetting,
  PreferenceKey,
  PreferenceStore,
  UiPreferences,
  UiReporter,
} from '../a11y/settings';
import {
  MAX_VOLUME,
  MIN_VOLUME,
  MOTION_SETTINGS,
  NOOP_UI_REPORTER,
  createSafeUiReporter,
  resolveMount,
} from '../a11y/settings';
import type {
  InputAction,
  InputBinding,
  InputBindingOverride,
  InputContext,
  Keymap,
} from '../../input/keymap';
import {
  createKeymap,
  describeAction,
  describeBinding,
  findBindingConflict,
  listBindings,
} from '../../input/keymap';
import type { InputEmitter, RemapResult } from '../../input/input-manager';
import type { SoundEngine } from '../../audio/sound-engine';
import type { ThemeId } from '../../theme/themes';
import { getTheme, themeIds } from '../../theme/themes';

// The string values below are the same selectors style/_a11y.scss,
// style/_reward.scss, style/_screens.scss and the suites match on.

/** Context label carried into every report this module raises. */
export const SETTINGS_PANEL_CONTEXT = 'settings-panel';

/** Selector index.html declares the dialog at. */
export const SETTINGS_PANEL_SELECTOR = '#settings-panel';

/** The single `<form>` the dialog's body is. */
export const SETTINGS_BODY_CLASS = 'settings-body';

/** One `<fieldset>` per concern. */
export const SETTINGS_GROUP_CLASS = 'settings-group';

/** One setting: its name, its value and the control that changes it. */
export const SETTINGS_ROW_CLASS = 'settings-row';

/** The keys bound to one action, as spoken text. */
export const SETTINGS_BINDING_CLASS = 'settings-binding';

/**
 * ADDED: carried by a key-binding row in ADDITION to `SETTINGS_ROW_CLASS`, so
 * style/_screens.scss lays those rows out as aligned columns without reaching
 * the theme, motion, sound and capture-action rows that share the base class.
 * DL-PANEL-05.
 */
export const SETTINGS_BINDING_ROW_CLASS = 'settings-row-binding';

/** Explanatory text a control references through `aria-describedby`. */
export const SETTINGS_STATUS_CLASS = 'settings-status';

/** The control vocabulary of style/_screens.scss. */
export const SETTINGS_CONTROL_CLASS = 'screen-button';

/** The control-row layout of style/_screens.scss. */
export const SETTINGS_FIELD_CLASS = 'screen-field';

/** The label treatment of style/_screens.scss. */
export const SETTINGS_LABEL_CLASS = 'screen-label';

/** The volume slider, so style/_screens.scss needs no id selector. */
export const SETTINGS_SLIDER_CLASS = 'settings-slider';

/** The visually-hidden utility of style/_a11y.scss. */
export const SETTINGS_VISUALLY_HIDDEN_CLASS = 'visually-hidden';

/** Heading the dialog takes its accessible name from. */
export const SETTINGS_TITLE_ID = 'settings-title';

/** The four-modality help text. */
export const SETTINGS_HELP_ID = 'settings-help';

/** The text naming what imposed number-only rendering. */
export const SETTINGS_NUMBER_ONLY_HINT_ID = 'settings-number-only-hint';

/** Whether an audio context is available. */
export const SETTINGS_SOUND_STATUS_ID = 'settings-sound-status';

/** The effective reduced-motion value. */
export const SETTINGS_MOTION_STATUS_ID = 'settings-motion-status';

/** The armed-capture prompt, and the outcome of the last capture. */
export const SETTINGS_CAPTURE_STATUS_ID = 'settings-capture-status';

/** The swipe modality, which carries no key binding. */
export const SETTINGS_SWIPE_NOTE_ID = 'settings-swipe-note';

/** The volume slider, referenced by its `<label for>`. */
export const SETTINGS_VOLUME_ID = 'settings-volume';

/** The dialog's concerns, in the order they are presented. */
export const SETTINGS_SECTIONS = [
  'appearance',
  'motion',
  'sound',
  'keyboard',
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

const RENDER_METRIC = 'ui.settings.render';

const OPEN_METRIC = 'ui.settings.open';

const CLOSE_METRIC = 'ui.settings.close';

const SET_METRIC = 'ui.settings.set';

const CAPTURE_METRIC = 'ui.settings.capture';

const CAPTURE_CANCEL_METRIC = 'ui.settings.capture.cancel';

const REBIND_METRIC = 'ui.settings.rebind';

const REBIND_CONFLICT_METRIC = 'ui.settings.rebind.conflict';

const RESTORE_METRIC = 'ui.settings.keymap.restore';

const DEGRADED_METRIC = 'ui.settings.degraded';

const TRAP_METRIC = 'ui.settings.trap';

const EXTERNAL_SYNC_METRIC = 'ui.settings.external_sync';

const AFTER_DESTROY_METRIC = 'ui.settings.after_destroy';

/** Steps the volume slider offers across its range. */
const VOLUME_STEPS = 20;

/** Keys that are modifiers alone and so bind nothing on their own. */
const MODIFIER_KEYS: readonly string[] = Object.freeze([
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'AltGraph',
  'CapsLock',
]);

const CANCEL_CAPTURE_KEY = 'Escape';

/** Every string this dialog writes. Each is caller-overridable. */
export interface SettingsPanelCopy {
  readonly title: string;

  /** Names all four movement modalities. */
  readonly helpText: string;
  readonly swipeNote: string;
  readonly appearanceLegend: string;
  readonly motionLegend: string;
  readonly soundLegend: string;
  readonly keysLegend: string;
  readonly numberOnlyLabel: string;
  readonly numberOnlyForcedHint: (reason: string | null) => string;
  readonly mutedLabel: string;
  readonly volumeLabel: string;
  readonly closeLabel: string;
  readonly restoreDefaultsLabel: string;
  readonly cancelCaptureLabel: string;
  readonly captureIdle: string;
  readonly soundAbsent: string;
  readonly soundContextUnavailable: string;
  readonly soundAvailable: string;

  /**
   * ADDED: shown while the audio layer is available and the player has muted
   * it, so the status does not read as a live claim. DL-PANEL-06.
   */
  readonly soundMuted: string;

  /** Name of the control that rebinds one action. */
  readonly rebindLabel: (action: string) => string;

  /**
   * ADDED: the VISIBLE text of that control, constant across every row.
   *
   * It must be contained in `rebindLabel`'s result case-insensitively, which is
   * what keeps the accessible name a superset of the visible label
   * (WCAG 2.5.3) while the column stays narrow enough for label, binding and
   * control to share one line. DL-PANEL-05.
   */
  readonly rebindShortLabel: string;

  /** Prompt shown while a capture is armed. */
  readonly capturePrompt: (action: string) => string;

  /**
   * Shown when a captured key already belongs to another action.
   *
   * `dimension` names which of the event's two identities collided: `'key'`
   * for the logical `KeyboardEvent.key`, `'code'` for the physical
   * `KeyboardEvent.code`. An override that ignores the third argument still
   * satisfies this type.
   */
  readonly captureConflict: (
    key: string,
    occupant: string,
    dimension: RebindDimension,
  ) => string;
  readonly captureApplied: (action: string, keys: string) => string;
  readonly captureCancelled: (action: string) => string;
  readonly bindingSummary: (action: string, keys: string) => string;
  readonly motionEffective: (reduced: boolean) => string;
  readonly themeLabel: (id: ThemeId) => string;
  readonly themeDescription: (id: ThemeId) => string;
  readonly motionLabel: (setting: MotionSetting) => string;
  readonly themeAnnouncement: (name: string) => string;
  readonly motionAnnouncement: (label: string) => string;
  readonly numberOnlyAnnouncement: (enabled: boolean) => string;
  readonly mutedAnnouncement: (muted: boolean) => string;
  readonly restoreAnnouncement: string;
}

/** Renders one motion setting as spoken text. */
function motionSettingLabel(setting: MotionSetting): string {
  switch (setting) {
    case 'system':
      return 'Follow system';
    case 'reduce':
      return 'Reduce motion';
    case 'allow':
      return 'Allow motion';
    default:
      return unreachableSetting(setting);
  }
}

/** Fails the type check where a `MotionSetting` member is unhandled. */
function unreachableSetting(setting: never): string {
  return String(setting);
}

/** Renders one palette as spoken text, from the catalogue's own name. */
function themeIdLabel(id: ThemeId): string {
  switch (id) {
    case 'default':
    case 'high-contrast':
    case 'colorblind-safe':
      return getTheme(id).name;
    default:
      return unreachableTheme(id);
  }
}

/** Fails the type check where an audio-availability outcome is unhandled. */
function unreachableAvailability(availability: never): string {
  return String(availability);
}

/** Fails the type check where a `ThemeId` member is unhandled. */
function unreachableTheme(id: never): string {
  return String(id);
}

/** The default copy. */
export const settingsPanelCopy: SettingsPanelCopy = Object.freeze({
  title: 'Settings',
  helpText:
    'Move the tiles with the arrow keys, WASD, the Vim keys H, J, K and L, ' +
    'a swipe across the board, or the on-screen controls. Every key below ' +
    'can be remapped.',
  swipeNote:
    'A swipe across the board moves the tiles and carries no key binding, ' +
    'so it is not listed below.',
  appearanceLegend: 'Appearance',
  motionLegend: 'Motion',
  soundLegend: 'Sound',
  keysLegend: 'Keyboard',
  numberOnlyLabel: 'Numbers only',
  mutedLabel: 'Mute sound',
  volumeLabel: 'Volume',
  closeLabel: 'Close settings',
  restoreDefaultsLabel: 'Restore default keys',
  cancelCaptureLabel: 'Cancel key change',
  captureIdle: 'No key change in progress.',
  soundAbsent:
    'Sound is not running, so mute and volume are switched off.',
  soundContextUnavailable:
    'Sound is unavailable on this device, so mute and volume are switched ' +
    'off.',
  soundAvailable: 'Sound plays through this device.',

  // ADDED: the available-but-silent case. The string above reported
  // availability only, so it claimed sound was playing while the player had
  // muted it. DL-PANEL-06.
  soundMuted: 'Sound is available on this device and is muted.',

  numberOnlyForcedHint: (reason: string | null): string =>
    reason === null
      ? 'Numbers only cannot be turned off because 3D rendering is ' +
        'unavailable.'
      : `Numbers only cannot be turned off because 3D rendering is ` +
        `unavailable: ${reason}.`,

  rebindLabel: (action: string): string => `Change key for ${action}`,

  // A prefix of every `rebindLabel` result above, so containment holds for
  // every action without depending on the action's own name. DL-PANEL-05.
  rebindShortLabel: 'Change',

  capturePrompt: (action: string): string =>
    `Press the new key for ${action}, or Escape to cancel.`,

  captureConflict: (
    key: string,
    occupant: string,
    dimension: RebindDimension,
  ): string =>
    dimension === 'code'
      ? `That key position is already used by ${occupant}. Nothing was ` +
        'changed.'
      : `${key} is already used by ${occupant}. Nothing was changed.`,

  captureApplied: (action: string, keys: string): string =>
    `${action} is now ${keys}.`,

  captureCancelled: (action: string): string =>
    `The key change for ${action} was cancelled.`,

  bindingSummary: (action: string, keys: string): string =>
    `${action}: ${keys}`,

  motionEffective: (reduced: boolean): string =>
    reduced
      ? 'Animation is reduced: camera movement and particles are switched ' +
        'off.'
      : 'Animation plays in full.',

  themeLabel: themeIdLabel,
  themeDescription: (id: ThemeId): string => getTheme(id).description,
  motionLabel: motionSettingLabel,

  themeAnnouncement: (name: string): string => `Palette changed to ${name}.`,

  motionAnnouncement: (label: string): string =>
    `Motion preference changed to ${label}.`,

  numberOnlyAnnouncement: (enabled: boolean): string =>
    enabled ? 'Numbers only is on.' : 'Numbers only is off.',

  mutedAnnouncement: (muted: boolean): string =>
    muted ? 'Sound is muted.' : 'Sound is on.',

  restoreAnnouncement: 'Default keys restored.',
});

/** Every construction parameter. Each collaborator arrives by injection. */
/**
 * The binding table's owner, declared by the three members this dialog calls.
 *
 * Structural, so the accessibility layer needs no import from the input
 * manager and the manager needs no knowledge of this dialog: `InputManager` of
 * src/input/input-manager.ts satisfies it as written.
 */
export interface KeymapOwner {
  /** The table in force. */
  getKeymap(): Keymap;

  /**
   * Binds one action, validating, persisting and announcing it once.
   *
   * @param action Action to rebind.
   * @param binding Keys and codes to bind it to.
   * @returns Whether it applied, the table afterwards, and the occupant on a
   *   refusal.
   */
  remap(action: InputAction, binding: InputBindingOverride): RemapResult;

  /**
   * Replaces the whole table, persists it and announces it once.
   *
   * @param keymap Table to hold.
   */
  setKeymap(keymap: Keymap): void;
}

export interface SettingsPanelOptions {
  /**
   * The dialog element the body is rendered into. Where absent, it is resolved
   * from `hostSelector` through `resolveMount`.
   */
  readonly host?: HTMLElement | null;

  /**
   * Selector the host is resolved at. Defaults to `SETTINGS_PANEL_SELECTOR`.
   */
  readonly hostSelector?: string;

  readonly preferences?: PreferenceStore | null;

  /**
   * Manager the dialog's focus trap is requested from. Optional: absent, the
   * dialog opens untrapped and the degradation is reported.
   */
  readonly focusManager?: FocusManager | null;

  /** Whether this dialog engages the focus trap on its own host. */
  readonly trapFocus?: boolean;

  /**
   * The owner of the binding table: the source the rebinding rows read, and
   * the one api a rebind is applied through.
   *
   * Absent, the rebinding rows show the default table and every rebind is
   * refused as degraded.
   */
  readonly keymapOwner?: KeymapOwner | null;

  readonly soundEngine?: SoundEngine | null;

  /** Emitter the dismiss control publishes `closeSettings` on. */
  readonly input?: InputEmitter | null;

  /** Stops key dispatch while a capture is armed. */
  readonly suspendInput?: () => void;

  /** Resumes key dispatch once a capture completes or is abandoned. */
  readonly resumeInput?: () => void;

  readonly announcer?: LiveRegionAnnouncer | null;

  /** Document elements are created in. Defaults to the host's own. */
  readonly document?: Document | null;

  /** Overrides for any subset of the copy. */
  readonly copy?: Partial<SettingsPanelCopy>;

  /** Sink every failure, degradation and count leaves through. */
  readonly reporter?: UiReporter;
}

export interface SettingsPanel {
  /**
   * The dialog element, or `null` where none was resolved. The container the
   * focus trap holds; not a node this module created.
   */
  readonly element: HTMLElement | null;

  /**
   * Renders the body if it is not yet standing, syncs every control, shows the
   * dialog, and requests a focus trap over it where a focus manager is
   * available. A manager that is absent, or that refuses the trap, is reported
   * as degraded and the dialog still opens untrapped.
   *
   * @returns Whether the dialog is open afterwards. An absent host, or a
   *   body that could not be rendered, returns `false` and changes nothing.
   */
  open(): boolean;

  /**
   * Abandons any armed capture, releases the trap and hides the dialog.
   *
   * @returns Whether this call closed an open dialog.
   */
  close(): boolean;

  isOpen(): boolean;

  /** Re-reads every preference and the keymap, and updates every control. */
  refresh(): void;

  /**
   * Releases the trap, unsubscribes from the store, removes the capture
   * listener, removes every node this module created, hides the host and drops
   * the injected collaborators: the preference store, the focus manager, the
   * sound engine, the input emitter and the announcer.
   *
   * `element` keeps the host it resolved, and the reporter and the copy stay
   * in place so a later call can still be reported. Idempotent. Afterwards
   * `open`, `close` and `refresh` are no-ops that report, while `isOpen` —
   * which returns `false` — and a repeated `destroy` are silent.
   */
  destroy(): void;
}

function readAmbientDocument(): Document | null {
  return typeof document === 'undefined' ? null : document;
}

function mergeCopy(
  overrides: Partial<SettingsPanelCopy> | undefined,
): SettingsPanelCopy {
  if (overrides === undefined) {
    return settingsPanelCopy;
  }

  return Object.freeze({ ...settingsPanelCopy, ...overrides });
}

/**
 * Writes a toggle's pressed state and, for the unavailable case, both disabled
 * states.
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

/**
 * Adds an id to a control's `aria-describedby` without dropping the others.
 */
function describeBy(control: Element, id: string): void {
  const present = control.getAttribute('aria-describedby');
  const ids = present === null || present === '' ? [] : present.split(/\s+/u);

  if (!ids.includes(id)) {
    ids.push(id);
  }

  control.setAttribute('aria-describedby', ids.join(' '));
}

/** Drops an id from a control's `aria-describedby`, keeping the others. */
function undescribeBy(control: Element, id: string): void {
  const present = control.getAttribute('aria-describedby');

  if (present === null || present === '') {
    return;
  }

  const kept = present.split(/\s+/u).filter((candidate) => candidate !== id);

  if (kept.length === 0) {
    control.removeAttribute('aria-describedby');

    return;
  }

  control.setAttribute('aria-describedby', kept.join(' '));
}

/** Writes both unavailability states, or clears both. */
function writeAvailability(
  control: HTMLInputElement,
  available: boolean,
): void {
  control.disabled = !available;

  if (available) {
    control.removeAttribute('aria-disabled');
  } else {
    control.setAttribute('aria-disabled', 'true');
  }
}

/**
 * The volume the slider's raw value stands for.
 *
 * @returns The bounded volume, or `null` where the value is not a number.
 */
function readSliderVolume(raw: string): number | null {
  const parsed = Number.parseFloat(raw);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.min(MAX_VOLUME, Math.max(MIN_VOLUME, parsed));
}

/**
 * The contexts a rebind of one action must be free in.
 *
 * @returns The binding's own contexts, or `['game']` where it names none.
 */
function contextsOf(binding: InputBinding): readonly InputContext[] {
  return binding.contexts.length > 0 ? binding.contexts : ['game'];
}

/**
 * Which of a captured event's two dimensions a conflict was found in: the
 * logical `KeyboardEvent.key` or the physical `KeyboardEvent.code`.
 */
export type RebindDimension = 'key' | 'code';

/** One conflict a capture ran into. */
interface RebindConflict {
  readonly binding: InputBinding;
  readonly dimension: RebindDimension;
}

/**
 * Builds the settings dialog.
 *
 * Nothing is rendered, resolved or measured beyond the host lookup: `open`
 * renders the body, shows the dialog and requests a focus trap over it where a
 * focus manager is available. No media query is evaluated here and no
 * preference is read at construction.
 *
 * @param options Host, preference store, keymap and the optional focus
 *   manager, audio, emitter, announcer and sink collaborators.
 * @returns The dialog, closed, with no body rendered yet. An unresolvable
 *   host yields a usable object whose `open` is a reported no-op.
 * @example
 * ```ts
 * // `host` is the element src/ui/screen-router.ts resolved and injected. Where
 * // none is injected, `hostSelector` is resolved through `resolveMount`.
 * const settings = createSettingsPanel({
 *   host,
 *   preferences,
 *   focusManager,
 *   // The input manager satisfies `KeymapOwner`: it owns the table, validates
 *   // a rebind, persists it and announces the outcome.
 *   keymapOwner: input,
 *   soundEngine,
 *   input,
 *   suspendInput: () => input.suspend(),
 *   resumeInput: () => input.resume(),
 *   announcer,
 * });
 * ```
 */
export function createSettingsPanel(
  options: SettingsPanelOptions = {},
): SettingsPanel {
  const reporter = createSafeUiReporter(options.reporter ?? NOOP_UI_REPORTER);
  const copy = mergeCopy(options.copy);
  const hostSelector = options.hostSelector ?? SETTINGS_PANEL_SELECTOR;
  const ownsTrap = options.trapFocus ?? true;
  const suspendInput = options.suspendInput;
  const resumeInput = options.resumeInput;

  // Dropped by `destroy`.
  let preferences: PreferenceStore | null = options.preferences ?? null;
  let focusManager: FocusManager | null = options.focusManager ?? null;
  let soundEngine: SoundEngine | null = options.soundEngine ?? null;
  let emitter: InputEmitter | null = options.input ?? null;
  let announcer: LiveRegionAnnouncer | null = options.announcer ?? null;
  let keymapOwner: KeymapOwner | null = options.keymapOwner ?? null;

  // A CACHE of the owner's table, refreshed by `adoptKeymap` and assigned
  // nowhere else.
  let keymap: Keymap = createKeymap();

  const owner: Document | null =
    options.document ??
    options.host?.ownerDocument ??
    readAmbientDocument();

  const themeButtons = new Map<ThemeId, HTMLButtonElement>();
  const motionButtons = new Map<MotionSetting, HTMLButtonElement>();
  const bindingLabels = new Map<InputAction, HTMLElement>();
  const rebindButtons = new Map<InputAction, HTMLButtonElement>();
  const teardown: (() => void)[] = [];

  let body: HTMLFormElement | null = null;
  let numberOnlyButton: HTMLButtonElement | null = null;
  let numberOnlyHint: HTMLElement | null = null;
  let mutedButton: HTMLButtonElement | null = null;
  let volumeInput: HTMLInputElement | null = null;
  let soundStatus: HTMLElement | null = null;
  let motionStatus: HTMLElement | null = null;
  let captureStatus: HTMLElement | null = null;
  let cancelCaptureButton: HTMLButtonElement | null = null;

  let capturing: InputAction | null = null;
  let detachCapture: (() => void) | null = null;
  let inputSuspended = false;
  let trap: FocusTrapHandle | null = null;
  let unsubscribe: (() => void) | null = null;
  let opened = false;
  let destroyed = false;
  let audioUnlocked = false;
  let soundDegradationReported = false;

  /** Reports and refuses a call made after `destroy`. */
  const refuseAfterDestroy = (call: string): boolean => {
    if (!destroyed) {
      return false;
    }

    reporter.count(AFTER_DESTROY_METRIC, { call });

    return true;
  };

  const reportDegraded = (capability: string, reason: string): void => {
    reporter.log('warn', 'settings collaborator degraded', {
      context: SETTINGS_PANEL_CONTEXT,
      capability,
      reason,
    });
    reporter.count(DEGRADED_METRIC, { capability, reason });
  };

  /** Announces free text. Skipped silently where no announcer was injected. */
  const announce = (text: string): void => {
    const region = announcer;

    if (region === null) {
      return;
    }

    try {
      region.announceText(text);
    } catch (error: unknown) {
      reporter.error('announcement threw', error, {
        context: SETTINGS_PANEL_CONTEXT,
      });
    }
  };

  /** Resolves the dialog element, reporting a miss with its selector. */
  const resolveHost = (): HTMLElement | null => {
    const supplied = options.host;

    if (supplied !== undefined && supplied !== null) {
      return supplied;
    }

    if (owner === null) {
      reporter.log('warn', 'settings dialog has no document to resolve in', {
        context: SETTINGS_PANEL_CONTEXT,
        selector: hostSelector,
      });
      reporter.count(DEGRADED_METRIC, {
        capability: 'host',
        reason: 'no-document',
      });

      return null;
    }

    const found = resolveMount<HTMLElement>(hostSelector, {
      root: owner,
      reporter,
      context: SETTINGS_PANEL_CONTEXT,
      name: 'settingsPanel',
    });

    if (found === null) {
      reporter.log('warn', 'settings dialog host not found', {
        context: SETTINGS_PANEL_CONTEXT,
        selector: hostSelector,
      });
      reporter.count(DEGRADED_METRIC, {
        capability: 'host',
        reason: 'no-match',
      });
    }

    return found;
  };

  const host = resolveHost();

  // Read ONCE, before this module has written either: what index.html declared
  // is what an open dialog carries, so the markup stays the authority on both
  // even though the attributes now come and go with the open state.
  const declaredRole = host?.getAttribute('role') ?? null;
  const declaredModal = host?.getAttribute('aria-modal') ?? null;

  /** Registers a listener and queues its removal. */
  const listen = (
    target: EventTarget,
    type: string,
    handler: EventListener,
  ): void => {
    target.addEventListener(type, handler);
    teardown.push((): void => {
      target.removeEventListener(type, handler);
    });
  };

  const make = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
  ): HTMLElementTagNameMap[K] | null => {
    if (owner === null) {
      return null;
    }

    const element = owner.createElement(tag);

    if (className !== undefined) {
      element.className = className;
    }

    return element;
  };

  /** A real `<button type="button">`, never an anchor and never a `div`. */
  const makeButton = (label: string): HTMLButtonElement | null => {
    const button = make('button', SETTINGS_CONTROL_CLASS);

    if (button === null) {
      return null;
    }

    button.type = 'button';
    button.textContent = label;

    return button;
  };

  /** A `<fieldset>` carrying a real `<legend>`. */
  const makeGroup = (
    section: SettingsSection,
    legendText: string,
  ): HTMLFieldSetElement | null => {
    const group = make('fieldset', SETTINGS_GROUP_CLASS);
    const legend = make('legend');

    if (group === null || legend === null) {
      return null;
    }

    group.dataset.settingsSection = section;
    legend.textContent = legendText;
    group.appendChild(legend);

    return group;
  };

  const makeRow = (): HTMLDivElement | null => make('div', SETTINGS_ROW_CLASS);

  /** A row's leading name, as a real text node. */
  const makeRowLabel = (text: string): HTMLSpanElement | null => {
    const label = make('span', SETTINGS_LABEL_CLASS);

    if (label === null) {
      return null;
    }

    label.textContent = text;

    return label;
  };

  /** Explanatory text a control references through `aria-describedby`. */
  const makeStatus = (
    id: string,
    text: string,
  ): HTMLParagraphElement | null => {
    const status = make('p', SETTINGS_STATUS_CLASS);

    if (status === null) {
      return null;
    }

    status.id = id;
    status.textContent = text;

    return status;
  };

  /**
   * Applies the dialog's semantics for the time it is open, and names it from
   * its own heading.
   */
  const ensureDialogSemantics = (): void => {
    if (host === null) {
      return;
    }

    host.setAttribute('role', declaredRole ?? 'dialog');
    host.setAttribute('aria-modal', declaredModal ?? 'true');
    host.removeAttribute('aria-hidden');
    host.setAttribute('aria-labelledby', SETTINGS_TITLE_ID);
    describeBy(host, SETTINGS_HELP_ID);
  };

  /** Takes the dialog's semantics off for the time it is closed. */
  const clearDialogSemantics = (): void => {
    if (host === null) {
      return;
    }

    host.removeAttribute('role');
    host.removeAttribute('aria-modal');
    host.setAttribute('aria-hidden', 'true');
  };

  const buildAppearance = (): HTMLFieldSetElement | null => {
    const group = makeGroup('appearance', copy.appearanceLegend);
    const paletteRow = makeRow();
    const paletteName = makeRowLabel(copy.appearanceLegend);
    const numberRow = makeRow();

    if (
      group === null ||
      paletteRow === null ||
      paletteName === null ||
      numberRow === null
    ) {
      return null;
    }

    paletteName.classList.add(SETTINGS_VISUALLY_HIDDEN_CLASS);
    paletteRow.appendChild(paletteName);

    // Every palette in the catalogue is offered, the original included.
    for (const id of themeIds) {
      const button = makeButton(copy.themeLabel(id));

      if (button === null) {
        continue;
      }

      const description = makeStatus(
        `${SETTINGS_TITLE_ID}-theme-${id}`,
        copy.themeDescription(id),
      );

      if (description !== null) {
        description.classList.add(SETTINGS_VISUALLY_HIDDEN_CLASS);
        describeBy(button, description.id);
        paletteRow.appendChild(description);
      }

      listen(button, 'click', (): void => {
        chooseTheme(id);
      });
      themeButtons.set(id, button);
      paletteRow.appendChild(button);
    }

    const numberButton = makeButton(copy.numberOnlyLabel);

    // CHANGED: built EMPTY, where it used to be built holding the forced-hint
    // text. The element is hidden until a force applies, but it carried a claim
    // that 3D rendering was unavailable from the moment the dialog was
    // rendered — text no state had asserted, one attribute away from being
    // read. `syncNumberOnly` writes it when a force actually holds.
    // DL-PANEL-07.
    const hint = makeStatus(SETTINGS_NUMBER_ONLY_HINT_ID, '');

    if (numberButton !== null) {
      listen(numberButton, 'click', (): void => {
        toggleNumberOnly();
      });
      numberOnlyButton = numberButton;
      numberRow.appendChild(numberButton);
    }

    if (hint !== null) {
      numberOnlyHint = hint;
      numberRow.appendChild(hint);
    }

    group.appendChild(paletteRow);
    group.appendChild(numberRow);

    return group;
  };

  const buildMotion = (): HTMLFieldSetElement | null => {
    const group = makeGroup('motion', copy.motionLegend);
    const row = makeRow();
    const status = makeStatus(
      SETTINGS_MOTION_STATUS_ID,
      copy.motionEffective(false),
    );

    if (group === null || row === null || status === null) {
      return null;
    }

    // `system` is offered as a real choice, backed by the query
    // src/ui/a11y/settings.ts evaluates.
    for (const setting of MOTION_SETTINGS) {
      const button = makeButton(copy.motionLabel(setting));

      if (button === null) {
        continue;
      }

      describeBy(button, SETTINGS_MOTION_STATUS_ID);
      listen(button, 'click', (): void => {
        chooseMotion(setting);
      });
      motionButtons.set(setting, button);
      row.appendChild(button);
    }

    motionStatus = status;
    group.appendChild(row);
    group.appendChild(status);

    return group;
  };

  const buildSound = (): HTMLFieldSetElement | null => {
    const group = makeGroup('sound', copy.soundLegend);
    const row = makeRow();
    const field = make('div', SETTINGS_FIELD_CLASS);
    const label = make('label', SETTINGS_LABEL_CLASS);
    const slider = make('input', SETTINGS_SLIDER_CLASS);
    const status = makeStatus(SETTINGS_SOUND_STATUS_ID, copy.soundAvailable);

    if (
      group === null ||
      row === null ||
      field === null ||
      label === null ||
      slider === null ||
      status === null
    ) {
      return null;
    }

    const mute = makeButton(copy.mutedLabel);

    if (mute !== null) {
      describeBy(mute, SETTINGS_SOUND_STATUS_ID);
      listen(mute, 'click', (): void => {
        toggleMuted();
      });
      mutedButton = mute;
      row.appendChild(mute);
    }

    // A real range input: reachable by Tab, moved by the arrow keys, Home and
    // End, and carrying an accessible current value.
    slider.type = 'range';
    slider.id = SETTINGS_VOLUME_ID;
    slider.min = String(MIN_VOLUME);
    slider.max = String(MAX_VOLUME);
    slider.step = String((MAX_VOLUME - MIN_VOLUME) / VOLUME_STEPS);
    describeBy(slider, SETTINGS_SOUND_STATUS_ID);

    // A real `<label for>`, not pseudo-content.
    label.htmlFor = SETTINGS_VOLUME_ID;
    label.textContent = copy.volumeLabel;

    listen(slider, 'input', (): void => {
      moveVolume(slider.value);
    });

    volumeInput = slider;
    soundStatus = status;

    field.appendChild(label);
    field.appendChild(slider);
    group.appendChild(row);
    group.appendChild(field);
    group.appendChild(status);

    return group;
  };

  const buildKeyboard = (): HTMLFieldSetElement | null => {
    const group = makeGroup('keyboard', copy.keysLegend);
    const swipeNote = makeStatus(SETTINGS_SWIPE_NOTE_ID, copy.swipeNote);
    const status = makeStatus(SETTINGS_CAPTURE_STATUS_ID, copy.captureIdle);
    const actions = makeRow();

    if (
      group === null ||
      swipeNote === null ||
      status === null ||
      actions === null
    ) {
      return null;
    }

    group.appendChild(swipeNote);

    // One row per binding, in the order src/input/keymap.ts enumerates them.
    for (const binding of listBindings(adoptKeymap())) {
      const action = binding.action;
      const row = makeRow();
      const name = makeRowLabel(describeAction(action));
      const keys = make('span', SETTINGS_BINDING_CLASS);

      // CHANGED: the control paints the short constant and is NAMED by the
      // verbose per-action string, where it used to paint the verbose string.
      // Fourteen rows of "Change key for <action>" could not share a line with
      // their label and binding inside the panel's measure, and each row sized
      // its own columns, so the list read ragged. DL-PANEL-05.
      const rebind = makeButton(copy.rebindShortLabel);

      if (row === null || name === null || keys === null || rebind === null) {
        continue;
      }

      row.classList.add(SETTINGS_BINDING_ROW_CLASS);
      rebind.setAttribute('aria-label', copy.rebindLabel(describeAction(action)));

      keys.id = `${SETTINGS_CAPTURE_STATUS_ID}-${action}`;
      keys.textContent = describeBinding(keymap, action);
      describeBy(rebind, keys.id);
      describeBy(rebind, SETTINGS_CAPTURE_STATUS_ID);
      rebind.dataset.settingsAction = action;

      listen(rebind, 'click', (): void => {
        armCapture(action);
      });

      bindingLabels.set(action, keys);
      rebindButtons.set(action, rebind);

      row.appendChild(name);
      row.appendChild(keys);
      row.appendChild(rebind);
      group.appendChild(row);
    }

    const cancel = makeButton(copy.cancelCaptureLabel);
    const restore = makeButton(copy.restoreDefaultsLabel);

    if (cancel !== null) {
      listen(cancel, 'click', (): void => {
        cancelCapture();
      });
      cancelCaptureButton = cancel;
      actions.appendChild(cancel);
    }

    if (restore !== null) {
      listen(restore, 'click', (): void => {
        restoreDefaults();
      });
      actions.appendChild(restore);
    }

    captureStatus = status;
    group.appendChild(actions);
    group.appendChild(status);

    return group;
  };

  /**
   * Renders the body once.
   *
   * @returns Whether a body stands in the dialog afterwards.
   */
  const render = (): boolean => {
    if (host === null || owner === null) {
      return false;
    }

    if (body !== null) {
      return true;
    }

    const form = make('form', SETTINGS_BODY_CLASS);
    const title = make('h2');
    const help = make('p');
    const actions = make('div', SETTINGS_FIELD_CLASS);

    if (form === null || title === null || help === null || actions === null) {
      return false;
    }

    form.noValidate = true;

    // The dialog holds no submittable action.
    listen(form, 'submit', (event: Event): void => {
      event.preventDefault();
    });

    title.id = SETTINGS_TITLE_ID;
    title.textContent = copy.title;
    help.id = SETTINGS_HELP_ID;
    help.textContent = copy.helpText;

    form.appendChild(title);
    form.appendChild(help);

    for (const group of [
      buildAppearance(),
      buildMotion(),
      buildSound(),
      buildKeyboard(),
    ]) {
      if (group !== null) {
        form.appendChild(group);
      }
    }

    const dismissButton = makeButton(copy.closeLabel);

    if (dismissButton !== null) {
      listen(dismissButton, 'click', (): void => {
        dismiss();
      });
      actions.appendChild(dismissButton);
    }

    form.appendChild(actions);
    host.appendChild(form);
    body = form;

    reporter.count(RENDER_METRIC);

    return true;
  };

  // Every control's state is derived from the store and the keymap.

  const syncThemes = (): void => {
    const store = preferences;
    const active: ThemeId = store === null ? 'default' : store.getTheme();

    for (const [id, button] of themeButtons) {
      writeToggleState(button, id === active);
    }
  };

  const syncNumberOnly = (): void => {
    const store = preferences;
    const button = numberOnlyButton;

    if (button === null) {
      return;
    }

    const enabled = store !== null && store.isNumberOnlyMode();
    const forced = store !== null && store.isNumberOnlyForced();
    const reason =
      store === null ? null : store.getNumberOnlyForce().reason;

    // Forced: shown on, not defeatable, and explained in real text.
    writeToggleState(button, enabled, forced);

    const hint = numberOnlyHint;

    if (hint === null) {
      return;
    }

    if (forced) {
      hint.textContent = copy.numberOnlyForcedHint(reason);
      hint.hidden = false;
      describeBy(button, SETTINGS_NUMBER_ONLY_HINT_ID);
    } else {
      // CHANGED: cleared as well as hidden, so a force that is released leaves
      // no stale claim behind it. DL-PANEL-07.
      hint.textContent = '';
      hint.hidden = true;
      undescribeBy(button, SETTINGS_NUMBER_ONLY_HINT_ID);
    }
  };

  const syncMotion = (): void => {
    const store = preferences;
    const setting: MotionSetting =
      store === null ? 'system' : store.getMotionSetting();

    for (const [candidate, button] of motionButtons) {
      writeToggleState(button, candidate === setting);
    }

    if (motionStatus !== null) {
      motionStatus.textContent = copy.motionEffective(
        store !== null && store.isReducedMotion(),
      );
    }
  };

  /**
   * Whether the audio layer can sound anything, and which cause holds when it
   * cannot. The first observed degradation is reported once; a later cause is
   * returned but not reported again.
   */
  const readSoundAvailability = (): 'available' | 'absent' | 'no-context' => {
    const engine = soundEngine;

    if (engine === null) {
      if (!soundDegradationReported) {
        soundDegradationReported = true;
        reportDegraded('sound-engine', 'absent');
      }

      return 'absent';
    }

    try {
      const state = engine.getState();

      if (state.available) {
        return 'available';
      }

      if (!soundDegradationReported) {
        soundDegradationReported = true;
        reportDegraded('audio-context', 'unavailable');
      }

      return 'no-context';
    } catch (error: unknown) {
      reporter.error('sound engine state threw', error, {
        context: SETTINGS_PANEL_CONTEXT,
      });

      return 'absent';
    }
  };

  /**
   * The text naming the audio layer's state.
   *
   * The `never` branch is unreachable while the three outcomes above are the
   * only ones, and fails the type check when a fourth is added.
   */
  const soundStatusText = (
    availability: 'available' | 'absent' | 'no-context',

    // ADDED: the mute state, so the available branch distinguishes sound that
    // is playing from sound that is merely able to. The two unavailable
    // branches already say mute is switched off and are unaffected by it.
    // DL-PANEL-06.
    muted: boolean,
  ): string => {
    switch (availability) {
      case 'available':
        return muted ? copy.soundMuted : copy.soundAvailable;
      case 'absent':
        return copy.soundAbsent;
      case 'no-context':
        return copy.soundContextUnavailable;
      default:
        return unreachableAvailability(availability);
    }
  };

  /** Brings the audio layer to `'running'`, once, from a user gesture. */
  const unlockAudio = (): void => {
    if (audioUnlocked) {
      return;
    }

    const engine = soundEngine;

    if (engine === null) {
      return;
    }

    try {
      engine.unlock();

      // Set only after the unlock succeeded. Setting it first made a transient
      // failure permanent: the guard above short-circuited every later
      // gesture, so one throw left the audio layer suspended for the life of
      // the page with no way to retry it.
      audioUnlocked = true;
    } catch (error: unknown) {
      reporter.error('sound unlock threw', error, {
        context: SETTINGS_PANEL_CONTEXT,
      });
    }
  };

  const syncSound = (): void => {
    const store = preferences;
    const availability = readSoundAvailability();
    const available = availability === 'available';
    const muted = store !== null && store.isMuted();
    const volume = store === null ? MAX_VOLUME : store.getVolume();

    if (mutedButton !== null) {
      writeToggleState(mutedButton, muted, !available);
    }

    if (volumeInput !== null) {
      volumeInput.value = String(volume);
      volumeInput.setAttribute(
        'aria-valuetext',
        `${String(
          Math.round(
            ((volume - MIN_VOLUME) / (MAX_VOLUME - MIN_VOLUME)) * 100,
          ),
        )}%`,
      );
      writeAvailability(volumeInput, available);
    }

    if (soundStatus !== null) {
      soundStatus.textContent = soundStatusText(availability, muted);
    }

    // Nothing is pushed into the audio layer from here.
  };

  const syncBindings = (): void => {
    // Re-read first: the rows show what the owner holds, not what this dialog
    // last saw.
    const table = adoptKeymap();

    for (const [action, label] of bindingLabels) {
      label.textContent = describeBinding(table, action);
    }
  };

  const syncCaptureControls = (): void => {
    const armed = capturing;

    for (const [action, button] of rebindButtons) {
      button.setAttribute(
        'aria-pressed',
        armed === action ? 'true' : 'false',
      );
    }

    if (cancelCaptureButton !== null) {
      cancelCaptureButton.disabled = armed === null;

      if (armed === null) {
        cancelCaptureButton.setAttribute('aria-disabled', 'true');
      } else {
        cancelCaptureButton.removeAttribute('aria-disabled');
      }
    }
  };

  const writeCaptureStatus = (text: string): void => {
    if (captureStatus !== null) {
      captureStatus.textContent = text;
    }
  };

  const syncAll = (): void => {
    if (body === null) {
      return;
    }

    syncThemes();
    syncNumberOnly();
    syncMotion();
    syncSound();
    syncBindings();
    syncCaptureControls();
  };

  // Every write goes through src/ui/a11y/settings.ts.

  /** Reads the store, reporting its absence. */
  const requireStore = (call: string): PreferenceStore | null => {
    const store = preferences;

    if (store === null) {
      reportDegraded('preferences', `absent-on-${call}`);
    }

    return store;
  };

  const chooseTheme = (id: ThemeId): void => {
    if (refuseAfterDestroy('setTheme')) {
      return;
    }

    const store = requireStore('setTheme');

    if (store === null) {
      return;
    }

    try {
      store.setTheme(id);
    } catch (error: unknown) {
      reporter.error('setTheme threw', error, {
        context: SETTINGS_PANEL_CONTEXT,
        theme: id,
      });

      return;
    }

    reporter.count(SET_METRIC, { preference: 'theme', value: id });
    syncAll();
    announce(copy.themeAnnouncement(copy.themeLabel(id)));
  };

  const chooseMotion = (setting: MotionSetting): void => {
    if (refuseAfterDestroy('setMotionSetting')) {
      return;
    }

    const store = requireStore('setMotionSetting');

    if (store === null) {
      return;
    }

    try {
      store.setMotionSetting(setting);
    } catch (error: unknown) {
      reporter.error('setMotionSetting threw', error, {
        context: SETTINGS_PANEL_CONTEXT,
        setting,
      });

      return;
    }

    reporter.count(SET_METRIC, { preference: 'motion', value: setting });
    syncAll();
    announce(copy.motionAnnouncement(copy.motionLabel(setting)));
  };

  const toggleNumberOnly = (): void => {
    if (refuseAfterDestroy('setNumberOnlyMode')) {
      return;
    }

    const store = requireStore('setNumberOnlyMode');

    if (store === null) {
      return;
    }

    // A forced mode is not defeatable from here, and the force is never
    // established from here either.
    if (store.isNumberOnlyForced()) {
      reporter.count(SET_METRIC, {
        preference: 'numberOnlyMode',
        value: 'refused-forced',
      });
      syncAll();

      return;
    }

    const next = !store.isNumberOnlyMode();

    try {
      store.setNumberOnlyMode(next);
    } catch (error: unknown) {
      reporter.error('setNumberOnlyMode threw', error, {
        context: SETTINGS_PANEL_CONTEXT,
        requested: next,
      });

      return;
    }

    reporter.count(SET_METRIC, { preference: 'numberOnlyMode', value: next });
    syncAll();
    announce(copy.numberOnlyAnnouncement(store.isNumberOnlyMode()));
  };

  const toggleMuted = (): void => {
    if (refuseAfterDestroy('setMuted')) {
      return;
    }

    const store = requireStore('setMuted');

    if (store === null) {
      return;
    }

    // The first audio interaction in this dialog: an AudioContext needs a
    // gesture.
    unlockAudio();

    const next = !store.isMuted();

    try {
      store.setMuted(next);
    } catch (error: unknown) {
      reporter.error('setMuted threw', error, {
        context: SETTINGS_PANEL_CONTEXT,
        requested: next,
      });

      return;
    }

    reporter.count(SET_METRIC, { preference: 'muted', value: next });
    syncAll();
    announce(copy.mutedAnnouncement(next));
  };

  const moveVolume = (raw: string): void => {
    if (refuseAfterDestroy('setVolume')) {
      return;
    }

    const store = requireStore('setVolume');
    const volume = readSliderVolume(raw);

    if (store === null) {
      return;
    }

    if (volume === null) {
      reporter.log('warn', 'volume slider produced no number', {
        context: SETTINGS_PANEL_CONTEXT,
        raw,
      });
      reporter.count(SET_METRIC, {
        preference: 'volume',
        value: 'rejected',
      });

      return;
    }

    unlockAudio();

    try {
      store.setVolume(volume);
    } catch (error: unknown) {
      reporter.error('setVolume threw', error, {
        context: SETTINGS_PANEL_CONTEXT,
        requested: volume,
      });

      return;
    }

    reporter.count(SET_METRIC, { preference: 'volume', value: volume });
    syncAll();
  };

  /**
   * Re-reads the table from its owner into the local cache.
   *
   * @returns The table now cached.
   */
  const adoptKeymap = (): Keymap => {
    const holder = keymapOwner;

    if (holder === null) {
      return keymap;
    }

    try {
      keymap = holder.getKeymap();
    } catch (error: unknown) {
      reporter.error('keymap read threw', error, {
        context: SETTINGS_PANEL_CONTEXT,
      });
    }

    return keymap;
  };

  /**
   * Applies one binding through the table's owner.
   *
   * @param action Action to rebind.
   * @param binding Keys and codes to bind it to.
   * @returns The owner's outcome, or `null` where there is no owner to ask.
   */
  const requestRemap = (
    action: InputAction,
    binding: InputBindingOverride,
  ): RemapResult | null => {
    const holder = keymapOwner;

    if (holder === null) {
      reportDegraded('keymapOwner', 'absent');

      return null;
    }

    try {
      const result = holder.remap(action, binding);

      keymap = result.keymap;

      return result;
    } catch (error: unknown) {
      reporter.error('keymap remap threw', error, {
        context: SETTINGS_PANEL_CONTEXT,
        action,
      });

      return null;
    }
  };

  /**
   * Replaces the whole table through its owner.
   *
   * @param next Table to hold.
   * @returns Whether the owner took it.
   */
  const requestKeymap = (next: Keymap): boolean => {
    const holder = keymapOwner;

    if (holder === null) {
      reportDegraded('keymapOwner', 'absent');

      return false;
    }

    try {
      holder.setKeymap(next);
      adoptKeymap();

      return true;
    } catch (error: unknown) {
      reporter.error('keymap replace threw', error, {
        context: SETTINGS_PANEL_CONTEXT,
      });

      return false;
    }

  };

  const suspendDispatch = (): void => {
    if (inputSuspended) {
      return;
    }

    if (suspendInput === undefined) {
      reportDegraded('suspendInput', 'absent');

      return;
    }

    try {
      suspendInput();
      inputSuspended = true;
    } catch (error: unknown) {
      reporter.error('input suspend threw', error, {
        context: SETTINGS_PANEL_CONTEXT,
      });
    }
  };

  const resumeDispatch = (): void => {
    if (!inputSuspended) {
      return;
    }

    if (resumeInput === undefined) {
      inputSuspended = false;
      reportDegraded('resumeInput', 'absent');

      return;
    }

    try {
      resumeInput();

      // Cleared only after the resume succeeded, which is the order
      // `suspendDispatch` already used.
      inputSuspended = false;
    } catch (error: unknown) {
      reporter.error('input resume threw', error, {
        context: SETTINGS_PANEL_CONTEXT,
      });
    }
  };

  const removeCaptureListener = (): void => {
    const detach = detachCapture;

    detachCapture = null;

    if (detach === null) {
      return;
    }

    try {
      detach();
    } catch (error: unknown) {
      reporter.error('capture listener removal threw', error, {
        context: SETTINGS_PANEL_CONTEXT,
      });
    }
  };

  /**
   * Ends an armed capture.
   *
   * @param announceCancellation Whether the abandonment is surfaced.
   * @returns Whether a capture was armed.
   */
  const disarmCapture = (announceCancellation: boolean): boolean => {
    const action = capturing;

    capturing = null;
    removeCaptureListener();
    resumeDispatch();

    if (action === null) {
      return false;
    }

    if (announceCancellation) {
      const text = copy.captureCancelled(describeAction(action));

      reporter.count(CAPTURE_CANCEL_METRIC, { action });

      if (!destroyed) {
        writeCaptureStatus(text);
        announce(text);
      }
    }

    if (!destroyed) {
      syncCaptureControls();
    }

    return true;
  };

  /**
   * The first conflict one captured event carries, or `null` where it carries
   * none.
   *
   * @param action Action being rebound.
   * @param key `KeyboardEvent.key` captured.
   * @param code `KeyboardEvent.code` captured, empty where the event carried
   *   none.
   * @returns The conflict, or `null`.
   */
  const findCaptureConflict = (
    action: InputAction,
    key: string,
    code: string,
  ): RebindConflict | null => {
    const contexts = contextsOf(keymap[action]);
    const dimensions: readonly { value: string; name: RebindDimension }[] = [
      { value: key, name: 'key' },
      { value: code, name: 'code' },
    ];

    for (const dimension of dimensions) {
      if (dimension.value.length === 0) {
        continue;
      }

      for (const context of contexts) {
        const found = findBindingConflict(keymap, dimension.value, context);

        if (found !== null && found.action !== action) {
          return { binding: found, dimension: dimension.name };
        }
      }
    }

    return null;
  };

  /**
   * Reports the binding an action still holds, for a capture that changed
   * nothing.
   *
   * @param action Action whose binding stands.
   * @returns The summary line.
   */
  const describeStandingBinding = (action: InputAction): string =>
    copy.bindingSummary(describeAction(action), describeBinding(keymap, action));

  /** Applies a captured key, or refuses it and says which action holds it. */
  const applyCapture = (
    action: InputAction,
    key: string,
    code: string,
  ): void => {
    const occupied = findCaptureConflict(action, key, code);

    if (occupied !== null) {
      const text = copy.captureConflict(
        occupied.dimension === 'code' ? code : key,
        describeAction(occupied.binding.action),
        occupied.dimension,
      );

      reporter.count(REBIND_CONFLICT_METRIC, {
        action,
        key,
        code,
        dimension: occupied.dimension,
        occupant: occupied.binding.action,
      });
      disarmCapture(false);
      writeCaptureStatus(text);
      announce(text);

      return;
    }

    const result = requestRemap(action, {
      keys: [key],
      codes: code === '' ? [] : [code],
    });

    // No owner to apply it, or an owner that raised: the capture is abandoned
    // and the status names the binding still in force, so a refused rebind
    // cannot be read as one that happened.
    if (result === null) {
      disarmCapture(false);
      writeCaptureStatus(describeStandingBinding(action));
      syncBindings();
      syncCaptureControls();

      return;
    }

    const ownerConflict = result.conflict;

    if (!result.applied) {
      const ownerDimension: RebindDimension =
        ownerConflict !== null &&
        code.length > 0 &&
        !ownerConflict.keys.some(
          (bound) => bound.toLowerCase() === key.toLowerCase(),
        ) &&
        ownerConflict.codes.includes(code)
          ? 'code'
          : 'key';

      // The owner refused it. Its name for the occupant is the one reported,
      // so the dialog cannot disagree with the table about who holds the key.
      const text =
        ownerConflict === null
          ? describeStandingBinding(action)
          : copy.captureConflict(
              ownerDimension === 'code' ? code : key,
              describeAction(ownerConflict.action),
              ownerDimension,
            );

      reporter.count(REBIND_CONFLICT_METRIC, {
        action,
        key,
        code,
        ...(ownerConflict === null ? {} : { dimension: ownerDimension }),
        occupant: ownerConflict === null ? 'unknown' : ownerConflict.action,
      });
      disarmCapture(false);
      writeCaptureStatus(text);
      announce(text);

      return;
    }

    disarmCapture(false);
    syncBindings();
    syncCaptureControls();

    // Described from the keymap in force — the one the owner returned — and
    // not from the binding that was offered: a refusal returns above, so
    // reaching here is itself the owner's acceptance, and the counter below
    // therefore counts only a rebind that actually happened.
    const text = copy.captureApplied(
      describeAction(action),
      describeBinding(result.keymap, action),
    );

    reporter.count(REBIND_METRIC, { action, key });
    writeCaptureStatus(text);
    announce(text);
  };

  /** Arms a capture for one action. */
  const armCapture = (action: InputAction): void => {
    if (refuseAfterDestroy('armCapture')) {
      return;
    }

    if (owner === null) {
      reportDegraded('document', 'absent-on-capture');

      return;
    }

    disarmCapture(false);
    capturing = action;
    suspendDispatch();

    const listener = (event: KeyboardEvent): void => {
      // The capture phase: the event reaches neither
      // src/input/input-manager.ts nor the focus trap.
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const armed = capturing;

      if (armed === null) {
        return;
      }

      // A modifier alone binds nothing; the capture stays armed.
      if (MODIFIER_KEYS.includes(event.key)) {
        return;
      }

      if (event.key === CANCEL_CAPTURE_KEY) {
        disarmCapture(true);

        return;
      }

      applyCapture(armed, event.key, event.code);
    };

    // The window's capture phase, which precedes the document's.
    const doc = owner;
    const view = doc.defaultView;

    if (view === null) {
      doc.addEventListener('keydown', listener, true);
      detachCapture = (): void => {
        doc.removeEventListener('keydown', listener, true);
      };
    } else {
      view.addEventListener('keydown', listener, true);
      detachCapture = (): void => {
        view.removeEventListener('keydown', listener, true);
      };
    }

    const prompt = copy.capturePrompt(describeAction(action));

    reporter.count(CAPTURE_METRIC, { action });
    syncCaptureControls();
    writeCaptureStatus(prompt);
    announce(prompt);
  };

  const cancelCapture = (): void => {
    if (refuseAfterDestroy('cancelCapture')) {
      return;
    }

    if (!disarmCapture(true)) {
      writeCaptureStatus(copy.captureIdle);
    }
  };

  const restoreDefaults = (): void => {
    if (refuseAfterDestroy('restoreDefaults')) {
      return;
    }

    disarmCapture(false);

    const adopted = requestKeymap(createKeymap());

    syncBindings();
    syncCaptureControls();

    if (!adopted) {
      // Nothing was restored, so neither the count nor the announcement is
      // made: both claimed a restoration the owner had refused.
      writeCaptureStatus(copy.captureIdle);

      return;
    }

    reporter.count(RESTORE_METRIC);
    writeCaptureStatus(copy.restoreAnnouncement);
    announce(copy.restoreAnnouncement);
  };

  /** Releases the trap, once, whether or not one is engaged. */
  const releaseTrap = (): void => {
    const engaged = trap;

    trap = null;

    if (engaged === null) {
      return;
    }

    try {
      engaged.release();
    } catch (error: unknown) {
      reporter.error('focus trap release threw', error, {
        context: SETTINGS_PANEL_CONTEXT,
      });
    }
  };

  /**
   * Engages the trap. Containment, Tab and Shift-Tab, the Escape callback and
   * restore-on-leave all belong to src/ui/a11y/focus-manager.ts.
   */
  const engageTrap = (): void => {
    if (host === null) {
      return;
    }

    // ONE trap per container. Where the container's own opener holds the trap
    // — src/ui/screen-router.ts does, with the trigger to restore focus to and
    // the background to make inert, neither of which this dialog knows —
    // engaging a second trap here would stack two owners on one element: the
    // first moves focus inside, so the second records a restore target that is
    // already inside the container it is trapping, and both then have to be
    // released in the right order.
    if (!ownsTrap) {
      reporter.count(TRAP_METRIC, { owner: 'container' });

      return;
    }

    const manager = focusManager;

    if (manager === null) {
      reportDegraded('focusManager', 'absent');

      return;
    }

    try {
      const engaged = manager.trap(host, {
        label: 'settings',
        context: SETTINGS_PANEL_CONTEXT,
        reporter,
        onEscape: (): void => {
          closePanel();
        },
      });

      if (engaged === null) {
        reportDegraded('focusManager', 'refused');

        return;
      }

      trap = engaged;
      reporter.count(TRAP_METRIC, { owner: 'panel' });
    } catch (error: unknown) {
      reporter.error('focus trap threw', error, {
        context: SETTINGS_PANEL_CONTEXT,
      });
    }
  };

  const openPanel = (): boolean => {
    if (refuseAfterDestroy('open')) {
      return false;
    }

    if (host === null) {
      reporter.log('warn', 'settings dialog cannot open without a host', {
        context: SETTINGS_PANEL_CONTEXT,
        selector: hostSelector,
      });
      reporter.count(DEGRADED_METRIC, {
        capability: 'open',
        reason: 'no-host',
      });

      return false;
    }

    if (!render()) {
      reporter.count(DEGRADED_METRIC, {
        capability: 'open',
        reason: 'no-body',
      });

      return false;
    }

    syncAll();

    // Applied on EVERY open, not once on the first render.
    ensureDialogSemantics();

    // Shown before the trap engages: nothing inside a hidden subtree can take
    // focus.
    host.hidden = false;

    if (opened) {
      return true;
    }

    opened = true;
    engageTrap();
    reporter.count(OPEN_METRIC);

    return true;
  };

  const closePanel = (): boolean => {
    if (refuseAfterDestroy('close')) {
      return false;
    }

    if (!opened) {
      return false;
    }

    opened = false;
    disarmCapture(false);

    // Released before the host is hidden: focus is restored into a subtree
    // that is still visible.
    releaseTrap();

    if (host !== null) {
      host.hidden = true;
      clearDialogSemantics();
    }

    reporter.count(CLOSE_METRIC);

    return true;
  };

  /** The dismiss affordance: publishes the action the router acts on. */
  const dismiss = (): void => {
    if (refuseAfterDestroy('dismiss')) {
      return;
    }

    const bus = emitter;

    if (bus !== null) {
      try {
        if (bus.emit('closeSettings', undefined) > 0) {
          return;
        }
      } catch (error: unknown) {
        reporter.error('closeSettings emit threw', error, {
          context: SETTINGS_PANEL_CONTEXT,
        });
      }
    }

    closePanel();
  };

  const destroy = (): void => {
    if (destroyed) {
      return;
    }

    destroyed = true;

    disarmCapture(false);
    removeCaptureListener();
    releaseTrap();

    const stop = unsubscribe;

    unsubscribe = null;

    if (stop !== null) {
      try {
        stop();
      } catch (error: unknown) {
        reporter.error('preference unsubscribe threw', error, {
          context: SETTINGS_PANEL_CONTEXT,
        });
      }
    }

    for (const undo of teardown.splice(0)) {
      try {
        undo();
      } catch (error: unknown) {
        reporter.error('settings listener removal threw', error, {
          context: SETTINGS_PANEL_CONTEXT,
        });
      }
    }

    if (body !== null) {
      body.remove();
      body = null;
    }

    if (host !== null) {
      host.hidden = true;
      host.removeAttribute('aria-labelledby');
      undescribeBy(host, SETTINGS_HELP_ID);
      clearDialogSemantics();
    }

    themeButtons.clear();
    motionButtons.clear();
    bindingLabels.clear();
    rebindButtons.clear();

    numberOnlyButton = null;
    numberOnlyHint = null;
    mutedButton = null;
    volumeInput = null;
    soundStatus = null;
    motionStatus = null;
    captureStatus = null;
    cancelCaptureButton = null;
    opened = false;

    // Every collaborator handed in is dropped.
    preferences = null;
    focusManager = null;
    soundEngine = null;
    emitter = null;
    announcer = null;
    keymapOwner = null;
  };

  if (host !== null && host.hidden) {
    clearDialogSemantics();
  }

  // One subscription: an external change — a forced number-only mode, an
  // operating-system motion preference toggled mid-session — reaches the
  // controls.
  if (preferences !== null) {
    try {
      unsubscribe = preferences.subscribe(
        (snapshot: UiPreferences, changed: readonly PreferenceKey[]): void => {
          if (destroyed) {
            return;
          }

          reporter.count(EXTERNAL_SYNC_METRIC, {
            changed: changed.length,
            theme: snapshot.theme,
          });
          syncAll();
        },
      );
    } catch (error: unknown) {
      reporter.error('preference subscribe threw', error, {
        context: SETTINGS_PANEL_CONTEXT,
      });
    }
  }

  return Object.freeze({
    element: host,
    open: openPanel,
    close: closePanel,
    isOpen: (): boolean => opened,
    refresh: (): void => {
      if (refuseAfterDestroy('refresh')) {
        return;
      }

      syncAll();
    },
    destroy,
  });
}
