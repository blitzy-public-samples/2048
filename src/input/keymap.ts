// Keyboard binding table and the shared contracts of the input layer.
//
// Ported from js/keyboard_input_manager.js. That file is deleted.
// Provenance for every construct ported here:
//   L37-L50   numeric-code-to-direction map  -> DEFAULT_KEY_BINDINGS
//   L54-L55   modifier predicate             -> hasMoveModifier
//   L56       numeric code lookup            -> resolveInput
//   L66       numeric code 82 test           -> the `restart` binding
//   L60       move preventDefault            -> InputBinding.preventDefault
//   L131      restart preventDefault         -> InputBinding.preventDefault
//   L136      keepPlaying preventDefault     -> InputBinding.preventDefault
//
// The direction encoding 0 up / 1 right / 2 down / 3 left is the encoding the
// vector map at js/game_manager.js L196-L201 reads. The event names 'move',
// 'restart' and 'keepPlaying' are the three names js/game_manager.js L9-L11
// subscribes by.
//
// This module is the root of the src/input import graph: it imports nothing,
// reads no DOM, and touches no storage. Every function below is pure.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

/* --------------------------------------------------------------------------
 * Directions
 * ----------------------------------------------------------------------- */

/**
 * A board direction, carried as the bare number the engine consumes.
 *
 * The four members are the four keys of the vector map at
 * js/game_manager.js L196-L201.
 */
export type Direction = 0 | 1 | 2 | 3;

/** Upward move. Ported from the `0` values at L38, L42 and L46. */
export const DIRECTION_UP = 0;

/** Rightward move. Ported from the `1` values at L39, L43 and L47. */
export const DIRECTION_RIGHT = 1;

/** Downward move. Ported from the `2` values at L40, L44 and L48. */
export const DIRECTION_DOWN = 2;

/** Leftward move. Ported from the `3` values at L41, L45 and L49. */
export const DIRECTION_LEFT = 3;

/* --------------------------------------------------------------------------
 * Emitted event names and payloads
 * ----------------------------------------------------------------------- */

/**
 * Every event name the input layer emits, in declaration order.
 *
 * The first three are ported verbatim from the subscription calls at
 * js/game_manager.js L9-L11 and are frozen: the engine subscribes by these
 * literal strings. The remaining eight are additive and address the screen
 * containers `index.html` declares, relic activation, and the settings
 * surface.
 */
export const INPUT_EVENT_NAMES = [
  'move',
  'restart',
  'keepPlaying',
  'startRun',
  'selectReward',
  'continueStage',
  'endRun',
  'activateRelic',
  'openSettings',
  'closeSettings',
  'cancel',
] as const;

/** Union of the names in `INPUT_EVENT_NAMES`. */
export type InputEventName = (typeof INPUT_EVENT_NAMES)[number];

/**
 * The payload each emitted event carries.
 *
 * `'move'` carries the bare `Direction`, exactly as the single `data`
 * argument at js/keyboard_input_manager.js L61 and L125 does.
 * `'selectReward'` carries a zero-based offer index, `'activateRelic'` a
 * zero-based relic slot index, and `'startRun'` an optional seed string.
 * Every other event carries no payload.
 */
export type InputEventPayload = {
  readonly [K in InputEventName]: K extends 'move'
    ? Direction
    : K extends 'selectReward' | 'activateRelic'
      ? number
      : K extends 'startRun'
        ? string | undefined
        : undefined;
};

/* --------------------------------------------------------------------------
 * Bindable actions
 * ----------------------------------------------------------------------- */

/**
 * Every bindable action, in the order the settings panel and the on-screen
 * controls present them, and the order `resolveInput` scans them in.
 *
 * An action is what a key binds to; an event is what the input manager
 * emits. The four movement actions all emit the single `'move'` event with
 * different `Direction` payloads.
 */
export const INPUT_ACTIONS = [
  'moveUp',
  'moveRight',
  'moveDown',
  'moveLeft',
  'restart',
  'keepPlaying',
  'startRun',
  'selectReward',
  'continueStage',
  'endRun',
  'activateRelic',
  'openSettings',
  'closeSettings',
  'cancel',
] as const;

/** Union of the names in `INPUT_ACTIONS`. */
export type InputAction = (typeof INPUT_ACTIONS)[number];

/** The four actions that resolve to a `Direction`. */
export type MoveAction = Extract<
  InputAction,
  'moveUp' | 'moveRight' | 'moveDown' | 'moveLeft'
>;

/**
 * Direction each movement action resolves to.
 *
 * Ported from the value column of the map at
 * js/keyboard_input_manager.js L37-L50: the three numeric codes that
 * shared a value there share an action here.
 */
export const MOVE_ACTION_DIRECTIONS: Readonly<Record<MoveAction, Direction>> =
  Object.freeze({
    moveUp: DIRECTION_UP,
    moveRight: DIRECTION_RIGHT,
    moveDown: DIRECTION_DOWN,
    moveLeft: DIRECTION_LEFT,
  });

/** Lookup set backing `isMoveAction`. */
const MOVE_ACTION_SET: ReadonlySet<string> = new Set(
  Object.keys(MOVE_ACTION_DIRECTIONS)
);

/**
 * Narrows `action` to one of the four movement actions.
 *
 * @param action Action to test.
 * @returns `true` when `action` resolves to a `Direction`.
 */
export function isMoveAction(action: InputAction): action is MoveAction {
  return MOVE_ACTION_SET.has(action);
}

/**
 * Resolves the `Direction` an action carries.
 *
 * @param action Action to resolve.
 * @returns The direction for a movement action, or `null` for every other
 *   action.
 *
 * @example
 * directionForAction('moveUp');  // 0
 * directionForAction('restart'); // null
 */
export function directionForAction(action: InputAction): Direction | null {
  return isMoveAction(action) ? MOVE_ACTION_DIRECTIONS[action] : null;
}

/* --------------------------------------------------------------------------
 * Binding contexts
 * ----------------------------------------------------------------------- */

/**
 * Every context a binding can be active in.
 *
 * `'game'` carries the bindings ported from
 * js/keyboard_input_manager.js L37-L50 and L66, and nothing else.
 * `'overlay'` is active while a screen or the settings panel holds focus.
 * `'textEntry'` is active while a text field holds focus, where no movement
 * binding resolves.
 */
export const INPUT_CONTEXTS = ['game', 'overlay', 'textEntry'] as const;

/** Union of the names in `INPUT_CONTEXTS`. */
export type InputContext = (typeof INPUT_CONTEXTS)[number];

/**
 * Narrows an arbitrary string to a known context.
 *
 * @param value String to narrow.
 * @returns The matching context, or `null` when the string names none.
 */
function toInputContext(value: string): InputContext | null {
  for (const known of INPUT_CONTEXTS) {
    if (known === value) {
      return known;
    }
  }

  return null;
}

/* --------------------------------------------------------------------------
 * Binding and keymap shapes
 * ----------------------------------------------------------------------- */

/** One action and the keys that trigger it. */
export interface InputBinding {
  /** Action this binding triggers. */
  readonly action: InputAction;

  /**
   * `KeyboardEvent.key` values that trigger the action. Matched
   * case-insensitively, so a value produced with CapsLock engaged still
   * resolves.
   */
  readonly keys: readonly string[];

  /**
   * `KeyboardEvent.code` values that trigger the action. Matched exactly,
   * and independently of `keys`.
   */
  readonly codes: readonly string[];

  /** Contexts the binding is active in. */
  readonly contexts: readonly InputContext[];

  /**
   * Whether the caller cancels the event's default action once the binding
   * resolves. Ported from L60, L131 and L136, the only three
   * `preventDefault()` calls in the superseded file.
   */
  readonly preventDefault: boolean;

  /**
   * Whether a held Alt, Control, Meta or Shift key suppresses the binding.
   * Absent is read as `true`, matching the guard at L54-L55 and L58.
   */
  readonly modifierSuppressed?: boolean;
}

/** A partial binding, as the settings panel supplies one. */
export type InputBindingOverride = Partial<Omit<InputBinding, 'action'>>;

/** The complete binding table: one binding per action. */
export type Keymap = {
  readonly [K in InputAction]: InputBinding;
};

/** Per-action overrides accepted by `createKeymap`. */
export type KeymapOverrides = {
  readonly [K in InputAction]?: InputBindingOverride;
};

/**
 * A binding as `serializeKeymap` emits it. The action is carried by the
 * enclosing key, so it is absent here.
 */
export interface SerializedBinding {
  /** Value of `InputBinding.keys`. */
  readonly keys: readonly string[];

  /** Value of `InputBinding.codes`. */
  readonly codes: readonly string[];

  /** Value of `InputBinding.contexts`. */
  readonly contexts: readonly InputContext[];

  /** Value of `InputBinding.preventDefault`. */
  readonly preventDefault: boolean;

  /** Value of `InputBinding.modifierSuppressed`, always explicit. */
  readonly modifierSuppressed: boolean;
}

/** A keymap as `serializeKeymap` emits it. */
export type SerializedKeymap = {
  readonly [K in InputAction]: SerializedBinding;
};

/* --------------------------------------------------------------------------
 * Report sink
 * ----------------------------------------------------------------------- */

/** Severity of a report. */
export type InputReportLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured fields attached to a report. */
export type InputReportFields = Record<string, string | number | boolean>;

/** A timing span opened by `InputReporter.startSpan`. */
export interface InputSpan {
  /** Closes the span. Calling it more than once is harmless. */
  end(): void;
}

/**
 * Sink for the input layer's logs, counters and boundary timings.
 *
 * Declared in this module; the composition root supplies the
 * implementation. This module imports no observability code.
 */
export interface InputReporter {
  /**
   * Records a structured message.
   *
   * @param level Severity.
   * @param message Human-readable message.
   * @param fields Optional structured fields.
   */
  log(
    level: InputReportLevel,
    message: string,
    fields?: InputReportFields
  ): void;

  /**
   * Increments a counter.
   *
   * @param metric Counter name.
   * @param fields Optional structured fields.
   */
  count(metric: string, fields?: InputReportFields): void;

  /**
   * Opens a timing span.
   *
   * @param name Span name.
   * @returns The open span.
   */
  startSpan?(name: string): InputSpan;
}

/** The span `NOOP_REPORTER.startSpan` returns. */
const NOOP_SPAN: InputSpan = Object.freeze({
  end(): void {
    return;
  },
});

/**
 * A fully implemented `InputReporter` that discards every report. Every
 * function in this module that accepts a reporter defaults to it.
 *
 * @example
 * const keymap = deserializeKeymap(raw, NOOP_REPORTER);
 */
export const NOOP_REPORTER: InputReporter = Object.freeze({
  log(): void {
    return;
  },
  count(): void {
    return;
  },
  startSpan(): InputSpan {
    return NOOP_SPAN;
  },
});

/* --------------------------------------------------------------------------
 * Table construction
 * ----------------------------------------------------------------------- */

/**
 * Builds one value per action.
 *
 * The fourteen action names appear as object keys here and nowhere else.
 * The compiler rejects any table that omits one.
 *
 * @param build Called once per action, in `INPUT_ACTIONS` order.
 * @returns A record carrying a value for every action.
 */
function mapActions<T>(
  build: (action: InputAction) => T
): Record<InputAction, T> {
  return {
    moveUp: build('moveUp'),
    moveRight: build('moveRight'),
    moveDown: build('moveDown'),
    moveLeft: build('moveLeft'),
    restart: build('restart'),
    keepPlaying: build('keepPlaying'),
    startRun: build('startRun'),
    selectReward: build('selectReward'),
    continueStage: build('continueStage'),
    endRun: build('endRun'),
    activateRelic: build('activateRelic'),
    openSettings: build('openSettings'),
    closeSettings: build('closeSettings'),
    cancel: build('cancel'),
  };
}

/**
 * Returns a deeply frozen copy of `binding`, with `modifierSuppressed`
 * resolved to an explicit boolean and each array copied before freezing.
 *
 * @param binding Binding to copy.
 * @returns The frozen copy.
 */
function freezeBinding(binding: InputBinding): InputBinding {
  return Object.freeze({
    action: binding.action,
    keys: Object.freeze(binding.keys.slice()),
    codes: Object.freeze(binding.codes.slice()),
    contexts: Object.freeze(binding.contexts.slice()),
    preventDefault: binding.preventDefault,
    modifierSuppressed: binding.modifierSuppressed !== false,
  });
}

/**
 * Builds a deeply frozen keymap from a per-action factory.
 *
 * @param build Called once per action.
 * @returns The frozen keymap.
 */
function buildKeymap(build: (action: InputAction) => InputBinding): Keymap {
  return Object.freeze(mapActions((action) => freezeBinding(build(action))));
}

/**
 * Source table `DEFAULT_KEY_BINDINGS` is frozen from.
 *
 * The `'game'` rows carry exactly the thirteen keys the superseded file
 * recognised: the twelve of the map at L37-L50 and the `R` key at L66. Every
 * row added after that port carries an empty key list unless a
 * non-conflicting default is named below.
 */
const DEFAULT_BINDING_TABLE: Keymap = {
  // Ported from L38 (numeric code 38), L42 (75) and L46 (87).
  moveUp: {
    action: 'moveUp',
    keys: ['ArrowUp', 'k', 'w'],
    codes: ['ArrowUp', 'KeyK', 'KeyW'],
    contexts: ['game'],
    preventDefault: true,
    modifierSuppressed: true,
  },

  // Ported from L39 (numeric code 39), L43 (76) and L47 (68).
  moveRight: {
    action: 'moveRight',
    keys: ['ArrowRight', 'l', 'd'],
    codes: ['ArrowRight', 'KeyL', 'KeyD'],
    contexts: ['game'],
    preventDefault: true,
    modifierSuppressed: true,
  },

  // Ported from L40 (numeric code 40), L44 (74) and L48 (83).
  moveDown: {
    action: 'moveDown',
    keys: ['ArrowDown', 'j', 's'],
    codes: ['ArrowDown', 'KeyJ', 'KeyS'],
    contexts: ['game'],
    preventDefault: true,
    modifierSuppressed: true,
  },

  // Ported from L41 (numeric code 37), L45 (72) and L49 (65).
  moveLeft: {
    action: 'moveLeft',
    keys: ['ArrowLeft', 'h', 'a'],
    codes: ['ArrowLeft', 'KeyH', 'KeyA'],
    contexts: ['game'],
    preventDefault: true,
    modifierSuppressed: true,
  },

  // Ported from L66 (numeric code 82); preventDefault from L131.
  restart: {
    action: 'restart',
    keys: ['r'],
    codes: ['KeyR'],
    contexts: ['game'],
    preventDefault: true,
    modifierSuppressed: true,
  },

  // Bound to no key in the superseded file: L74 bound it to
  // `.keep-playing-button` only. preventDefault from L136.
  keepPlaying: {
    action: 'keepPlaying',
    keys: [],
    codes: [],
    contexts: ['overlay'],
    preventDefault: true,
    modifierSuppressed: true,
  },

  // Added; no analogue in the superseded file. Activated through the
  // run-start screen's own control.
  startRun: {
    action: 'startRun',
    keys: [],
    codes: [],
    contexts: ['overlay'],
    preventDefault: true,
    modifierSuppressed: true,
  },

  // Added; no analogue in the superseded file. The three digits address the
  // three reward offers.
  selectReward: {
    action: 'selectReward',
    keys: ['1', '2', '3'],
    codes: ['Digit1', 'Digit2', 'Digit3'],
    contexts: ['overlay'],
    preventDefault: true,
    modifierSuppressed: true,
  },

  // Added; no analogue in the superseded file. Activated through the stage
  // progress screen's own control.
  continueStage: {
    action: 'continueStage',
    keys: [],
    codes: [],
    contexts: ['overlay'],
    preventDefault: true,
    modifierSuppressed: true,
  },

  // Added; no analogue in the superseded file. Activated through the run
  // summary screen's own control.
  endRun: {
    action: 'endRun',
    keys: [],
    codes: [],
    contexts: ['overlay'],
    preventDefault: true,
    modifierSuppressed: true,
  },

  // Added; no analogue in the superseded file. Activated through the relic
  // tray's own controls.
  activateRelic: {
    action: 'activateRelic',
    keys: [],
    codes: [],
    contexts: ['game'],
    preventDefault: true,
    modifierSuppressed: true,
  },

  // Added; no analogue in the superseded file. Activated through the
  // settings control.
  openSettings: {
    action: 'openSettings',
    keys: [],
    codes: [],
    contexts: ['game', 'overlay'],
    preventDefault: true,
    modifierSuppressed: true,
  },

  // Added; no analogue in the superseded file. Reached through `cancel` or
  // the settings panel's own control.
  closeSettings: {
    action: 'closeSettings',
    keys: [],
    codes: [],
    contexts: ['overlay'],
    preventDefault: true,
    modifierSuppressed: true,
  },

  // Added; no analogue in the superseded file.
  cancel: {
    action: 'cancel',
    keys: ['Escape'],
    codes: ['Escape'],
    contexts: ['overlay', 'textEntry'],
    preventDefault: true,
    modifierSuppressed: true,
  },
};

/**
 * The default binding table. Frozen at every level: the table itself,
 * each binding, and each of the three arrays a binding carries.
 *
 * @example
 * DEFAULT_KEY_BINDINGS.moveUp.keys; // ['ArrowUp', 'k', 'w']
 */
export const DEFAULT_KEY_BINDINGS: Keymap = buildKeymap(
  (action) => DEFAULT_BINDING_TABLE[action]
);


/* --------------------------------------------------------------------------
 * Resolution
 * ----------------------------------------------------------------------- */

/** A binding matched against an event. */
export interface ResolvedInput {
  /** Action the event resolved to. */
  readonly action: InputAction;

  /**
   * Whether the caller cancels the event's default action. Copied from the
   * matched `InputBinding.preventDefault`.
   */
  readonly preventDefault: boolean;
}

/**
 * Reports whether a modifier key is held.
 *
 * Ported from js/keyboard_input_manager.js L54-L55:
 * `event.altKey || event.ctrlKey || event.metaKey || event.shiftKey`. All
 * four flags, no additions and no omissions. The result is coerced to a
 * boolean; the truthiness the port evaluates is unchanged.
 *
 * @param event Event to test.
 * @returns `true` when Alt, Control, Meta or Shift is held.
 */
export function hasMoveModifier(event: KeyboardEvent): boolean {
  return Boolean(
    event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
  );
}

/**
 * Reports whether `binding` is active in `context`.
 *
 * @param binding Binding to test.
 * @param context Context to test against.
 * @returns `true` when the binding lists the context.
 */
function includesContext(
  binding: InputBinding,
  context: InputContext
): boolean {
  for (const candidate of binding.contexts) {
    if (candidate === context) {
      return true;
    }
  }

  return false;
}

/**
 * Reports whether `binding` matches a key or a code.
 *
 * `keys` are compared with both sides lower-cased, so a value produced
 * with CapsLock engaged still resolves; `codes` are compared exactly. An
 * empty comparison value is skipped rather than matched.
 *
 * Supersedes the numeric code lookup at js/keyboard_input_manager.js L56
 * and the numeric code 82 test at L66.
 *
 * @param binding Binding to test.
 * @param lowerCasedKey `KeyboardEvent.key`, lower-cased.
 * @param code `KeyboardEvent.code`, verbatim.
 * @returns `true` when either list matches.
 */
function matchesBinding(
  binding: InputBinding,
  lowerCasedKey: string,
  code: string
): boolean {
  if (lowerCasedKey.length > 0) {
    for (const bound of binding.keys) {
      if (bound.toLowerCase() === lowerCasedKey) {
        return true;
      }
    }
  }

  if (code.length > 0) {
    for (const bound of binding.codes) {
      if (bound === code) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Reads a string property off an event without assuming it is present.
 *
 * @param value Value read from the event.
 * @returns `value` when it is a string, otherwise the empty string.
 */
function asKeyString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Resolves an event to the action it triggers, together with the caller's
 * `preventDefault` obligation.
 *
 * Actions are scanned in `INPUT_ACTIONS` order, so resolution is
 * deterministic. A binding whose context does not match is skipped; so is a
 * binding suppressed by a held modifier, reproducing the guard at
 * js/keyboard_input_manager.js L54-L55 and L58.
 *
 * @param event Event to resolve.
 * @param keymap Table to resolve against.
 * @param context Context currently active.
 * @returns The match, or `null` when no binding applies. `null` is also the
 *   result for a recognised key held with a suppressing modifier.
 *
 * @example
 * resolveInput(event, DEFAULT_KEY_BINDINGS, 'game');
 * // { action: 'moveUp', preventDefault: true }
 */
export function resolveInput(
  event: KeyboardEvent,
  keymap: Keymap,
  context: InputContext
): ResolvedInput | null {
  const modifiers = hasMoveModifier(event);
  const lowerCasedKey = asKeyString(event.key).toLowerCase();
  const code = asKeyString(event.code);

  for (const action of INPUT_ACTIONS) {
    const binding = keymap[action];

    if (!includesContext(binding, context)) {
      continue;
    }

    if (!matchesBinding(binding, lowerCasedKey, code)) {
      continue;
    }

    if (modifiers && binding.modifierSuppressed !== false) {
      continue;
    }

    return Object.freeze({
      action,
      preventDefault: binding.preventDefault,
    });
  }

  return null;
}

/**
 * Resolves an event to the action it triggers.
 *
 * Thin projection of `resolveInput` for callers that derive their
 * `preventDefault` obligation from the binding themselves.
 *
 * @param event Event to resolve.
 * @param keymap Table to resolve against.
 * @param context Context currently active.
 * @returns The action, or `null` when no binding applies.
 *
 * @example
 * resolveAction(event, DEFAULT_KEY_BINDINGS, 'game'); // 'moveUp'
 */
export function resolveAction(
  event: KeyboardEvent,
  keymap: Keymap,
  context: InputContext
): InputAction | null {
  const resolved = resolveInput(event, keymap, context);

  return resolved === null ? null : resolved.action;
}

/* --------------------------------------------------------------------------
 * Remapping
 * ----------------------------------------------------------------------- */

/**
 * Merges an override onto a binding.
 *
 * @param base Binding to start from.
 * @param override Fields to replace. An absent field keeps the base value.
 * @returns The merged, frozen binding.
 */
function mergeBinding(
  base: InputBinding,
  override?: InputBindingOverride
): InputBinding {
  if (override === undefined) {
    return freezeBinding(base);
  }

  return freezeBinding({
    action: base.action,
    keys: override.keys ?? base.keys,
    codes: override.codes ?? base.codes,
    contexts: override.contexts ?? base.contexts,
    preventDefault: override.preventDefault ?? base.preventDefault,
    modifierSuppressed:
      override.modifierSuppressed ?? base.modifierSuppressed,
  });
}

/**
 * Builds a keymap from the defaults and optional per-action overrides.
 *
 * @param overrides Per-action overrides. Omitting the argument returns
 *   `DEFAULT_KEY_BINDINGS` itself, already frozen.
 * @returns The frozen keymap.
 *
 * @example
 * createKeymap({ moveUp: { keys: ['ArrowUp'], codes: ['ArrowUp'] } });
 */
export function createKeymap(overrides?: KeymapOverrides): Keymap {
  if (overrides === undefined) {
    return DEFAULT_KEY_BINDINGS;
  }

  return buildKeymap((action) =>
    mergeBinding(DEFAULT_KEY_BINDINGS[action], overrides[action])
  );
}

/**
 * Rebinds one action, leaving every other binding untouched.
 *
 * @param keymap Table to start from. It is not mutated.
 * @param action Action to rebind.
 * @param binding Fields to replace on that action's binding.
 * @returns A new frozen keymap.
 *
 * @example
 * remapAction(keymap, 'restart', { keys: ['n'], codes: ['KeyN'] });
 */
export function remapAction(
  keymap: Keymap,
  action: InputAction,
  binding: InputBindingOverride
): Keymap {
  return buildKeymap((candidate) =>
    candidate === action
      ? mergeBinding(keymap[candidate], binding)
      : keymap[candidate]
  );
}

/**
 * Finds the binding a key already occupies in a context.
 *
 * The value is compared against `keys` case-insensitively and against
 * `codes` exactly, so a `KeyboardEvent.key` value and a
 * `KeyboardEvent.code` value are both accepted.
 *
 * @param keymap Table to search.
 * @param key Key or code to look for.
 * @param context Context to search within.
 * @returns The occupying binding, or `null` when the key is free.
 *
 * @example
 * findBindingConflict(DEFAULT_KEY_BINDINGS, 'w', 'game');
 * // the `moveUp` binding
 */
export function findBindingConflict(
  keymap: Keymap,
  key: string,
  context: InputContext
): InputBinding | null {
  const lowerCasedKey = key.toLowerCase();

  for (const action of INPUT_ACTIONS) {
    const binding = keymap[action];

    if (!includesContext(binding, context)) {
      continue;
    }

    if (matchesBinding(binding, lowerCasedKey, key)) {
      return binding;
    }
  }

  return null;
}

/**
 * Enumerates the bindings of a keymap in `INPUT_ACTIONS` order.
 *
 * @param keymap Table to enumerate.
 * @param context When given, only bindings active in that context are
 *   returned.
 * @returns A frozen list of bindings.
 *
 * @example
 * listBindings(DEFAULT_KEY_BINDINGS, 'textEntry').length; // 1
 */
export function listBindings(
  keymap: Keymap,
  context?: InputContext
): readonly InputBinding[] {
  const bindings: InputBinding[] = [];

  for (const action of INPUT_ACTIONS) {
    const binding = keymap[action];

    if (context === undefined || includesContext(binding, context)) {
      bindings.push(binding);
    }
  }

  return Object.freeze(bindings);
}


/* --------------------------------------------------------------------------
 * Human-readable labels
 * ----------------------------------------------------------------------- */

/** Label returned for an action that no key triggers. */
const UNBOUND_LABEL = 'Not bound';

/** Prefix `KeyboardEvent.code` gives a letter key. */
const LETTER_CODE_PREFIX = 'Key';

/** Prefix `KeyboardEvent.code` gives a digit key. */
const DIGIT_CODE_PREFIX = 'Digit';

/**
 * Spoken label for each named key, indexed by its lower-cased
 * `KeyboardEvent.key` value.
 */
const KEY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  arrowup: 'Up arrow',
  arrowright: 'Right arrow',
  arrowdown: 'Down arrow',
  arrowleft: 'Left arrow',
  ' ': 'Spacebar',
  spacebar: 'Spacebar',
  enter: 'Enter',
  escape: 'Escape',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  home: 'Home',
  end: 'End',
  pageup: 'Page Up',
  pagedown: 'Page Down',
});

/** Spoken label for each action. */
const ACTION_LABELS: Readonly<Record<InputAction, string>> = Object.freeze({
  moveUp: 'Move up',
  moveRight: 'Move right',
  moveDown: 'Move down',
  moveLeft: 'Move left',
  restart: 'New game',
  keepPlaying: 'Keep going',
  startRun: 'Start run',
  selectReward: 'Choose relic',
  continueStage: 'Continue',
  endRun: 'End run',
  activateRelic: 'Activate relic',
  openSettings: 'Open settings',
  closeSettings: 'Close settings',
  cancel: 'Cancel',
});

/**
 * Renders a `KeyboardEvent.key` value as spoken text.
 *
 * @param key Key value.
 * @returns The label, for example `'Up arrow'` for `'ArrowUp'` and `'W'` for
 *   `'w'`.
 */
function labelForKey(key: string): string {
  const lowerCased = key.toLowerCase();

  if (Object.prototype.hasOwnProperty.call(KEY_LABELS, lowerCased)) {
    return KEY_LABELS[lowerCased];
  }

  return key.length === 1 ? key.toUpperCase() : key;
}

/**
 * Renders a `KeyboardEvent.code` value as spoken text.
 *
 * @param code Code value.
 * @returns The label, for example `'W'` for `'KeyW'` and `'1'` for
 *   `'Digit1'`.
 */
function labelForCode(code: string): string {
  if (code.startsWith(LETTER_CODE_PREFIX)) {
    return labelForKey(code.slice(LETTER_CODE_PREFIX.length));
  }

  if (code.startsWith(DIGIT_CODE_PREFIX)) {
    return labelForKey(code.slice(DIGIT_CODE_PREFIX.length));
  }

  return labelForKey(code);
}

/**
 * Joins labels into one spoken phrase.
 *
 * @param labels Labels to join, already de-duplicated.
 * @returns `UNBOUND_LABEL` for an empty list, the single label for one, `'A
 *   or B'` for two, and `'A, B, or C'` for three or more.
 */
function joinLabels(labels: readonly string[]): string {
  if (labels.length === 0) {
    return UNBOUND_LABEL;
  }

  if (labels.length === 1) {
    return labels[0];
  }

  if (labels.length === 2) {
    return `${labels[0]} or ${labels[1]}`;
  }

  const head = labels.slice(0, -1).join(', ');

  return `${head}, or ${labels[labels.length - 1]}`;
}

/**
 * Renders an action as spoken text.
 *
 * @param action Action to label.
 * @returns The label, for example `'Move up'`.
 *
 * @example
 * describeAction('restart'); // 'New game'
 */
export function describeAction(action: InputAction): string {
  return ACTION_LABELS[action];
}

/**
 * Renders the keys bound to an action as spoken text.
 *
 * Prefers `keys`, falling back to `codes` when no key is bound, so a binding
 * expressed only by physical position still reads. Duplicate labels are
 * collapsed, so `['w', 'W']` does not read twice.
 *
 * @param keymap Table to read from.
 * @param action Action to describe.
 * @returns The phrase, or `'Not bound'` when the action has no key.
 *
 * @example
 * describeBinding(DEFAULT_KEY_BINDINGS, 'moveUp');
 * // 'Up arrow, K, or W'
 * describeBinding(DEFAULT_KEY_BINDINGS, 'keepPlaying');
 * // 'Not bound'
 */
export function describeBinding(keymap: Keymap, action: InputAction): string {
  const binding = keymap[action];
  const source = binding.keys.length > 0 ? binding.keys : binding.codes;
  const render = binding.keys.length > 0 ? labelForKey : labelForCode;
  const labels: string[] = [];

  for (const value of source) {
    const label = render(value);

    if (!labels.includes(label)) {
      labels.push(label);
    }
  }

  return joinLabels(labels);
}

/* --------------------------------------------------------------------------
 * Serialisation
 * ----------------------------------------------------------------------- */

/**
 * Projects a keymap onto plain data.
 *
 * The result contains strings, booleans and arrays only, so a caller can
 * hand it straight to a persistence layer. This module performs no
 * serialisation of its own and touches no storage.
 *
 * @param keymap Table to project.
 * @returns The plain-data projection.
 *
 * @example
 * serializeKeymap(DEFAULT_KEY_BINDINGS).moveUp.keys;
 * // ['ArrowUp', 'k', 'w']
 */
export function serializeKeymap(keymap: Keymap): SerializedKeymap {
  return mapActions((action) => {
    const binding = keymap[action];

    return {
      keys: binding.keys.slice(),
      codes: binding.codes.slice(),
      contexts: binding.contexts.slice(),
      preventDefault: binding.preventDefault,
      modifierSuppressed: binding.modifierSuppressed !== false,
    };
  });
}

/**
 * Narrows a value to a non-array object.
 *
 * @param value Value to test.
 * @returns `true` when the value can be read by string key.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Narrows a value to an array of unknowns.
 *
 * @param value Value to test.
 * @returns `true` when the value is an array.
 */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * Names the runtime kind of an arbitrary value for reporting.
 *
 * @param value Value to name.
 * @returns `'null'`, `'array'`, or the value's `typeof`.
 */
function describeRawType(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (Array.isArray(value)) {
    return 'array';
  }

  return typeof value;
}

/** Narrows a string to a known action name. */
const INPUT_ACTION_SET: ReadonlySet<string> = new Set(INPUT_ACTIONS);

/**
 * Reads an array of non-empty strings off a record.
 *
 * @param source Record to read from.
 * @param field Property name.
 * @param action Action the record describes, for reporting.
 * @param reporter Sink for rejected values.
 * @returns The accepted strings, or `null` when the property is absent or
 *   not an array. An explicitly empty array is returned as such.
 */
function readStringList(
  source: Record<string, unknown>,
  field: string,
  action: InputAction,
  reporter: InputReporter
): readonly string[] | null {
  if (!Object.prototype.hasOwnProperty.call(source, field)) {
    return null;
  }

  const value = source[field];

  if (!isUnknownArray(value)) {
    reporter.log('warn', 'Keymap field is not an array; using default.', {
      action,
      field,
      received: describeRawType(value),
    });
    reporter.count('input.keymap.deserialize.invalidField', { action, field });

    return null;
  }

  const accepted: string[] = [];
  let rejected = 0;

  for (const item of value) {
    if (typeof item === 'string' && item.length > 0) {
      accepted.push(item);
    } else {
      rejected += 1;
    }
  }

  if (rejected > 0) {
    reporter.log('warn', 'Keymap field dropped unusable entries.', {
      action,
      field,
      rejected,
    });
    reporter.count('input.keymap.deserialize.droppedEntries', {
      action,
      field,
      rejected,
    });
  }

  return accepted;
}

/**
 * Reads a list of known contexts off a record.
 *
 * @param source Record to read from.
 * @param action Action the record describes, for reporting.
 * @param reporter Sink for rejected values.
 * @returns The accepted contexts, or `null` when the property is absent, not
 *   an array, or names no known context.
 */
function readContextList(
  source: Record<string, unknown>,
  action: InputAction,
  reporter: InputReporter
): readonly InputContext[] | null {
  const raw = readStringList(source, 'contexts', action, reporter);

  if (raw === null) {
    return null;
  }

  const accepted: InputContext[] = [];

  for (const value of raw) {
    const context = toInputContext(value);

    if (context === null) {
      reporter.log('warn', 'Keymap names an unknown context; dropping it.', {
        action,
        context: value,
      });
      reporter.count('input.keymap.deserialize.unknownContext', { action });
    } else if (!accepted.includes(context)) {
      accepted.push(context);
    }
  }

  if (accepted.length === 0) {
    reporter.log('warn', 'Keymap left no usable context; using default.', {
      action,
    });
    reporter.count('input.keymap.deserialize.emptyContexts', { action });

    return null;
  }

  return accepted;
}

/**
 * Reads a boolean off a record.
 *
 * @param source Record to read from.
 * @param field Property name.
 * @param action Action the record describes, for reporting.
 * @param reporter Sink for rejected values.
 * @returns The boolean, or `null` when the property is absent or not a
 *   boolean.
 */
function readBoolean(
  source: Record<string, unknown>,
  field: string,
  action: InputAction,
  reporter: InputReporter
): boolean | null {
  if (!Object.prototype.hasOwnProperty.call(source, field)) {
    return null;
  }

  const value = source[field];

  if (typeof value !== 'boolean') {
    reporter.log('warn', 'Keymap field is not a boolean; using default.', {
      action,
      field,
      received: describeRawType(value),
    });
    reporter.count('input.keymap.deserialize.invalidField', { action, field });

    return null;
  }

  return value;
}

/**
 * Reads one binding out of a persisted keymap.
 *
 * @param action Action being read.
 * @param entry Persisted value for that action.
 * @param fallback Binding to draw absent or unusable fields from.
 * @param reporter Sink for rejected values.
 * @returns The binding, or `null` when the entry is unusable in full.
 */
function readBinding(
  action: InputAction,
  entry: unknown,
  fallback: InputBinding,
  reporter: InputReporter
): InputBinding | null {
  if (!isPlainRecord(entry)) {
    reporter.log('warn', 'Keymap entry is not an object; using default.', {
      action,
      received: describeRawType(entry),
    });
    reporter.count('input.keymap.deserialize.invalidEntry', { action });

    return null;
  }

  const keys = readStringList(entry, 'keys', action, reporter);
  const codes = readStringList(entry, 'codes', action, reporter);
  const contexts = readContextList(entry, action, reporter);
  const preventDefault = readBoolean(
    entry,
    'preventDefault',
    action,
    reporter
  );
  const modifierSuppressed = readBoolean(
    entry,
    'modifierSuppressed',
    action,
    reporter
  );

  return freezeBinding({
    action,
    keys: keys ?? fallback.keys,
    codes: codes ?? fallback.codes,
    contexts: contexts ?? fallback.contexts,
    preventDefault: preventDefault ?? fallback.preventDefault,
    modifierSuppressed: modifierSuppressed ?? fallback.modifierSuppressed,
  });
}

/**
 * Rebuilds a keymap from an already-parsed persisted value.
 *
 * The loader is guarded end to end and throws for no input: `null`,
 * `undefined`, a value of the wrong type, an unknown action name, and a
 * missing or malformed field each fall back to the corresponding default and
 * are reported through `reporter`. Every call emits at least one report.
 *
 * This function accepts data the caller has already parsed. It performs no
 * text decoding and reads no storage; both belong to the persistence layer.
 *
 * @param raw Already-parsed persisted value, of any shape.
 * @param reporter Sink for fallback reports. Defaults to `NOOP_REPORTER`.
 * @returns A frozen keymap. `DEFAULT_KEY_BINDINGS` is returned whole when
 *   `raw` cannot be read at all.
 *
 * @example
 * deserializeKeymap(serializeKeymap(DEFAULT_KEY_BINDINGS));
 * deserializeKeymap(null);          // DEFAULT_KEY_BINDINGS
 * deserializeKeymap({ moveUp: 1 }); // defaults, one report emitted
 */
export function deserializeKeymap(
  raw: unknown,
  reporter: InputReporter = NOOP_REPORTER
): Keymap {
  if (!isPlainRecord(raw)) {
    reporter.log('warn', 'Keymap payload is unreadable; using defaults.', {
      received: describeRawType(raw),
    });
    reporter.count('input.keymap.deserialize.rejected', {
      received: describeRawType(raw),
    });

    return DEFAULT_KEY_BINDINGS;
  }

  let restored = 0;
  let defaulted = 0;

  const keymap = buildKeymap((action) => {
    const fallback = DEFAULT_KEY_BINDINGS[action];

    if (!Object.prototype.hasOwnProperty.call(raw, action)) {
      defaulted += 1;

      return fallback;
    }

    const binding = readBinding(action, raw[action], fallback, reporter);

    if (binding === null) {
      defaulted += 1;

      return fallback;
    }

    restored += 1;

    return binding;
  });

  for (const name of Object.keys(raw)) {
    if (!INPUT_ACTION_SET.has(name)) {
      reporter.log('warn', 'Keymap payload names an unknown action.', {
        action: name,
      });
      reporter.count('input.keymap.deserialize.unknownAction', {
        action: name,
      });
    }
  }

  reporter.log('info', 'Keymap payload read.', { restored, defaulted });
  reporter.count('input.keymap.deserialize.completed', {
    restored,
    defaulted,
  });

  return keymap;
}

