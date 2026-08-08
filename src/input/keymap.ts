// Keyboard binding table and the shared contracts of the input layer: the event
// names and their payloads, the bindable actions, the input contexts, the
// binding table, its serialised form and the reporter interface.
//
// The direction encoding 0 up / 1 right / 2 down / 3 left is the encoding the
// engine's direction-vector map reads, and the event names are the ones the
// engine subscribes by.
//
// This module is the root of the src/input import graph: it imports nothing,
// reads no DOM and touches no storage. Its functions are pure, except that the
// deserialising helpers call into the injected `InputReporter`.
//
// The persisted-keymap limits are declared here as well: the byte limit the
// persistence layer applies before parsing, and the property-count,
// entries-per-list and string-length limits `deserializeKeymap` applies to a
// parsed payload. `createSafeInputReporter` is the containment boundary every
// report in src/input/ leaves through.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
// this module's area enumerated:
//   TR-KEYMAP-01  js/keyboard_input_manager.js  the `event.which` code map,
//                 L37-L50                       ported as the default binding
//                                               table keyed on
//                                               `KeyboardEvent.key` and
//                                               `KeyboardEvent.code`
//   TR-KEYMAP-02  js/keyboard_input_manager.js  the three event names, ported
//                 L9-L11, L54-L70               as `INPUT_EVENT_NAMES` and
//                                               `InputEventPayload`
//   TR-KEYMAP-03  js/game_manager.js L104-L116  the direction encoding
//                                               0 up / 1 right / 2 down /
//                                               3 left, declared here as
//                                               `Direction`
//   TR-KEYMAP-04  target-only row               `INPUT_ACTIONS`, `MoveAction`
//                                               and `directionForAction`
//   TR-KEYMAP-05  target-only row               `INPUT_CONTEXTS` and the
//                                               per-context binding resolution
//   TR-KEYMAP-06  target-only row               the remapping surface and the
//                                               serialised keymap with its
//                                               parse limits
//   TR-KEYMAP-07  target-only row               `InputReporter` and
//                                               `createSafeInputReporter`
//
// Decisions behind this file, argued in docs/DECISION_LOG.md and named here
// only so the construct can be found from the log:
//   DL-KEYMAP-01  bindings keyed on `KeyboardEvent.key` and
//                 `KeyboardEvent.code`, with no numeric code read
//   DL-KEYMAP-02  the direction encoding kept as the bare number the engine
//                 consumes
//   DL-KEYMAP-03  the parse limits applied to a persisted keymap before and
//                 after parsing
//   DL-KEYMAP-04  the input layer's contracts declared in this leaf module, so
//                 src/input/ imports nothing outside itself for them

/* --------------------------------------------------------------------------
 * Directions
 * ----------------------------------------------------------------------- */

/** A board direction, carried as the bare number the engine consumes. */
export type Direction = 0 | 1 | 2 | 3;

/** Upward move. */
export const DIRECTION_UP = 0;

/** Rightward move. */
export const DIRECTION_RIGHT = 1;

/** Downward move. */
export const DIRECTION_DOWN = 2;

/** Leftward move. */
export const DIRECTION_LEFT = 3;

/* --------------------------------------------------------------------------
 * Emitted event names and payloads
 * ----------------------------------------------------------------------- */

/** Every event name the input layer emits, in declaration order. */
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

/** The payload each emitted event carries. */
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

/** Direction each movement action resolves to. */
export const MOVE_ACTION_DIRECTIONS: Readonly<Record<MoveAction, Direction>> =
  Object.freeze({
    moveUp: DIRECTION_UP,
    moveRight: DIRECTION_RIGHT,
    moveDown: DIRECTION_DOWN,
    moveLeft: DIRECTION_LEFT,
  });

/** The four movement actions, in the order the direction encoding numbers them. */
export const MOVE_ACTIONS: readonly MoveAction[] = Object.freeze([
  'moveUp',
  'moveRight',
  'moveDown',
  'moveLeft',
] as const satisfies readonly MoveAction[]);

/** Lookup set backing `isMoveAction`. */
const MOVE_ACTION_SET: ReadonlySet<string> = new Set<string>(MOVE_ACTIONS);

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
 */
export function directionForAction(action: InputAction): Direction | null {
  return isMoveAction(action) ? MOVE_ACTION_DIRECTIONS[action] : null;
}

/* --------------------------------------------------------------------------
 * Binding contexts
 * ----------------------------------------------------------------------- */

/** Every context a binding can be active in. */
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
export interface InputBindingSlot {
  /**
   * Zero-based payload index this slot publishes.
   *
   * Carried on the slot rather than derived from `keys` or `codes`, so an
   * action whose payload addresses one of several targets keeps addressing the
   * right one after a remap to keys that carry no ordinal at all.
   */
  readonly index: number;

  /**
   * `KeyboardEvent.key` values that select this slot. Matched
   * case-insensitively, as `InputBinding.keys` is.
   */
  readonly keys: readonly string[];

  /**
   * `KeyboardEvent.code` values that select this slot. Matched exactly, as
   * `InputBinding.codes` is.
   */
  readonly codes: readonly string[];
}

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
   * `KeyboardEvent.code` values that trigger the action. Matched exactly, and
   * independently of `keys`.
   */
  readonly codes: readonly string[];

  /** Contexts the binding is active in. */
  readonly contexts: readonly InputContext[];

  /**
   * Whether the caller cancels the event's default action once the binding
   * resolves.
   */
  readonly preventDefault: boolean;

  /**
   * Whether a held Alt, Control, Meta or Shift key suppresses the binding.
   */
  readonly modifierSuppressed?: boolean;

  /**
   * Per-slot payload indices, for an action whose payload is an index.
   *
   * `selectReward` and `activateRelic` publish a zero-based index naming which
   * offer or relic the press addresses. A slot states that index explicitly
   * alongside the keys that select it, so the index survives a remap onto keys
   * that carry no digit. Absent, or matching no slot, the action publishes
   * index 0.
   */
  readonly slots?: readonly InputBindingSlot[];
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

  /**
   * Value of `InputBinding.slots`, always explicit. An action that addresses
   * no index carries an empty list.
   */
  readonly slots: readonly InputBindingSlot[];
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

/** Sink for the input layer's logs, counters, failures and timings. */
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
   * Records a caught value, carried UNCONVERTED.
   *
   * The channel that exists so no module under src/input/ has to reduce a
   * caught value to text of its own. `thrown` is `unknown` and is passed
   * through verbatim, so whatever the sink is — the logger-backed adapter,
   * a test double, a console — decides how much of the value to keep, and
   * an `Error`'s `stack`, its `cause` chain and a non-`Error` throwable's
   * own structure all survive the boundary instead of being flattened to a
   * name and a message here.
   *
   * Optional, so a sink written before this channel existed still
   * satisfies the contract; `createSafeInputReporter` fills it in and
   * every caller reaches it through that wrapper.
   *
   * @param level Severity.
   * @param message Human-readable message.
   * @param thrown The caught value, exactly as it was caught. `null` and
   *   `undefined` are values a throw can carry and are passed on as such.
   * @param fields Optional structured fields describing where it was
   *   caught. Categorical values only; no keystroke and no free text.
   */
  failure?(
    level: InputReportLevel,
    message: string,
    thrown: unknown,
    fields?: InputReportFields
  ): void;

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
 */
export const NOOP_REPORTER: InputReporter = Object.freeze({
  log(): void {
    return;
  },
  count(): void {
    return;
  },
  failure(): void {
    return;
  },
  startSpan(): InputSpan {
    return NOOP_SPAN;
  },
});

/** `errorName` reported for a caught value that carries no usable name. */
const UNKNOWN_THROWN_NAME = 'InputError';

/** `errorMessage` reported for a caught value that carries none. */
const UNKNOWN_THROWN_MESSAGE = 'Unknown input error.';

/** Characters either described field of a caught value keeps. */
const MAX_THROWN_TEXT_LENGTH = 200;

/**
 * Reads one string property off a value without trusting the value.
 *
 * Total: the membership test and the read are both contained, because a
 * `Proxy` can throw from its `has` or `get` trap and an accessor — including
 * an `Error` subclass's own `name` or `message` — can throw from its getter.
 * Either throw is read as an absent property.
 *
 * @param source Value to read from.
 * @param field Property name to read.
 * @returns The property value, capped in length, or `undefined` where it is
 *   absent, unreadable, not a string or empty.
 */
function readThrownString(
  source: object,
  field: string
): string | undefined {
  let candidate: unknown;

  try {
    if (!(field in source)) {
      return undefined;
    }

    candidate = Reflect.get(source, field);
  } catch {
    return undefined;
  }

  return typeof candidate === 'string' && candidate.length > 0
    ? candidate.slice(0, MAX_THROWN_TEXT_LENGTH)
    : undefined;
}

/**
 * Reduces a caught value to two report fields, for the one path that needs
 * text: a sink that implements no `failure` channel.
 *
 * THE INPUT LAYER'S ONLY SUCH REDUCTION. It is total — it accepts any value,
 * including a `Proxy` whose traps throw, an object whose `toString` throws
 * and a symbol, returns on every path and throws on none — and both fields
 * are capped. Every other path carries the caught value unconverted through
 * `InputReporter.failure`, so nothing else in src/input/ converts one.
 *
 * @param thrown The caught value, of any type.
 * @returns `errorName` and `errorMessage`, both populated.
 */
function describeThrownForFields(thrown: unknown): InputReportFields {
  if (typeof thrown === 'object' && thrown !== null) {
    return {
      errorName: readThrownString(thrown, 'name') ?? UNKNOWN_THROWN_NAME,
      errorMessage:
        readThrownString(thrown, 'message') ?? UNKNOWN_THROWN_MESSAGE,
    };
  }

  if (
    typeof thrown === 'string' ||
    typeof thrown === 'number' ||
    typeof thrown === 'boolean'
  ) {
    return {
      errorName: UNKNOWN_THROWN_NAME,
      errorMessage: String(thrown).slice(0, MAX_THROWN_TEXT_LENGTH),
    };
  }

  return {
    errorName: UNKNOWN_THROWN_NAME,
    errorMessage: UNKNOWN_THROWN_MESSAGE,
  };
}

/**
 * Wraps a reporter so no member of it can throw into its caller.
 *
 * A `log`, `count`, `failure`, `startSpan` or span `end` that throws is
 * swallowed at this boundary: the throw does not reach the input path that
 * reported, and it is not reported back through the same sink. A
 * `startSpan` that throws yields the no-op span instead.
 *
 * `failure` is also COMPLETED here: the returned reporter always implements
 * the channel, and a wrapped sink that implements none of its own still
 * receives the report — through its `log` channel, with the caught value's
 * own name and message added as fields by the one total reduction in this
 * module. A module under src/input/ therefore reports a caught value
 * through `failure` and never flattens one itself.
 *
 * Every function in this module that accepts a reporter, and
 * `attachTouchInput` in src/input/touch-input.ts, wraps its reporter here
 * once before using it, so an input event, a keymap load and a gesture are
 * all unaffected by a faulty sink.
 *
 * @param reporter Reporter to contain.
 * @returns A reporter delegating to `reporter` and throwing for nothing.
 */
export function createSafeInputReporter(
  reporter: InputReporter
): InputReporter {
  return Object.freeze({
    log(
      level: InputReportLevel,
      message: string,
      fields?: InputReportFields
    ): void {
      try {
        reporter.log(level, message, fields);
      } catch {
        return;
      }
    },

    count(metric: string, fields?: InputReportFields): void {
      try {
        reporter.count(metric, fields);
      } catch {
        return;
      }
    },

    failure(
      level: InputReportLevel,
      message: string,
      thrown: unknown,
      fields?: InputReportFields
    ): void {
      const report = reporter.failure;

      if (report !== undefined) {
        try {
          report.call(reporter, level, message, thrown, fields);
        } catch {
          return;
        }

        return;
      }

      try {
        reporter.log(level, message, {
          ...(fields ?? {}),
          ...describeThrownForFields(thrown),
        });
      } catch {
        return;
      }
    },

    startSpan(name: string): InputSpan {
      const open = reporter.startSpan;

      if (open === undefined) {
        return NOOP_SPAN;
      }

      let span: InputSpan;

      try {
        span = open.call(reporter, name);
      } catch {
        return NOOP_SPAN;
      }

      return Object.freeze({
        end(): void {
          try {
            span.end();
          } catch {
            return;
          }
        },
      });
    },
  });
}

/* --------------------------------------------------------------------------
 * Table construction
 * ----------------------------------------------------------------------- */

/**
 * Builds one value per action.
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

/** Prefix `KeyboardEvent.code` gives a digit key. */
const DIGIT_CODE_PREFIX = 'Digit';

/** The slot list a binding whose payload addresses no index carries. */
const EMPTY_SLOTS: readonly InputBindingSlot[] = Object.freeze([]);

/** How many reward offers one draw presents. From AAP R8: one of three. */
export const REWARD_SLOT_COUNT = 3;

/** How many relic slots a keyboard press can address. */
export const RELIC_SLOT_COUNT = 9;

/**
 * Builds one indexed slot per digit, from `1` up.
 *
 * The digits are the DEFAULT keys, and each slot states its index alongside
 * them; a remap replaces the keys and keeps the index.
 *
 * @param count How many slots to build.
 * @returns The frozen slot list, index 0 first.
 */
function digitSlots(count: number): readonly InputBindingSlot[] {
  const slots: InputBindingSlot[] = [];

  for (let index = 0; index < count; index += 1) {
    const digit = String(index + 1);

    slots.push(
      Object.freeze({
        index,
        keys: Object.freeze([digit]),
        codes: Object.freeze([`${DIGIT_CODE_PREFIX}${digit}`]),
      }),
    );
  }

  return Object.freeze(slots);
}

/** The three reward offers, addressed by the digits 1 to 3 by default. */
const REWARD_SLOTS = digitSlots(REWARD_SLOT_COUNT);

/** The nine relic slots, unbound by default. */
const RELIC_SLOTS = digitSlots(RELIC_SLOT_COUNT);

/**
 * Returns a deeply frozen copy of `binding`, with `modifierSuppressed` resolved
 * to an explicit boolean and each array copied before freezing.
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
    slots: freezeSlots(binding.slots),
  });
}

/**
 * Returns a deeply frozen copy of a slot list, with each slot's key and code
 * lists copied before freezing.
 *
 * @param slots Slots to copy. Absent yields the shared empty list.
 * @returns The frozen copy.
 */
function freezeSlots(
  slots: readonly InputBindingSlot[] | undefined,
): readonly InputBindingSlot[] {
  if (slots === undefined || slots.length === 0) {
    return EMPTY_SLOTS;
  }

  return Object.freeze(
    slots.map((slot) =>
      Object.freeze({
        index: slot.index,
        keys: Object.freeze(slot.keys.slice()),
        codes: Object.freeze(slot.codes.slice()),
      }),
    ),
  );
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

/** Source table `DEFAULT_KEY_BINDINGS` is frozen from. */
const DEFAULT_BINDING_TABLE: Keymap = {
  moveUp: {
    action: 'moveUp',
    keys: ['ArrowUp', 'k', 'w'],
    codes: ['ArrowUp', 'KeyK', 'KeyW'],
    contexts: ['game'],
    preventDefault: true,
    modifierSuppressed: true,
  },

  moveRight: {
    action: 'moveRight',
    keys: ['ArrowRight', 'l', 'd'],
    codes: ['ArrowRight', 'KeyL', 'KeyD'],
    contexts: ['game'],
    preventDefault: true,
    modifierSuppressed: true,
  },

  moveDown: {
    action: 'moveDown',
    keys: ['ArrowDown', 'j', 's'],
    codes: ['ArrowDown', 'KeyJ', 'KeyS'],
    contexts: ['game'],
    preventDefault: true,
    modifierSuppressed: true,
  },

  moveLeft: {
    action: 'moveLeft',
    keys: ['ArrowLeft', 'h', 'a'],
    codes: ['ArrowLeft', 'KeyH', 'KeyA'],
    contexts: ['game'],
    preventDefault: true,
    modifierSuppressed: true,
  },

  restart: {
    action: 'restart',
    keys: ['r'],
    codes: ['KeyR'],
    contexts: ['game'],
    preventDefault: true,
    modifierSuppressed: true,
  },

  // `C` for continue. js/keyboard_input_manager.js bound no key to it at all —
  // `.keep-playing-button` at index.html L51 was the only way to reach it — so
  // this is the key the action gains, and it is remappable like every other.
  // Nothing else is bound to C in any context, and `restart`'s `r` is bound in
  // `'game'` alone, so the terminal overlay carries no conflict.
  keepPlaying: {
    action: 'keepPlaying',
    keys: ['c'],
    codes: ['KeyC'],
    contexts: ['overlay'],
    preventDefault: true,
    modifierSuppressed: true,
  },

  // Activated through the run-start screen's own control.
  startRun: {
    action: 'startRun',
    keys: [],
    codes: [],
    contexts: ['overlay'],
    preventDefault: true,
    modifierSuppressed: true,
  },

  // The three digits address the three reward offers, and `slots` states which
  // offer each digit addresses.
  selectReward: {
    action: 'selectReward',
    keys: ['1', '2', '3'],
    codes: ['Digit1', 'Digit2', 'Digit3'],
    contexts: ['overlay'],
    preventDefault: true,
    modifierSuppressed: true,
    slots: REWARD_SLOTS,
  },

  // Activated through the stage progress screen's own control.
  continueStage: {
    action: 'continueStage',
    keys: [],
    codes: [],
    contexts: ['overlay'],
    preventDefault: true,
    modifierSuppressed: true,
  },

  // Activated through the run summary screen's own control.
  endRun: {
    action: 'endRun',
    keys: [],
    codes: [],
    contexts: ['overlay'],
    preventDefault: true,
    modifierSuppressed: true,
  },

  // Activated through the relic tray's own controls, and by a key bound to one
  // of the indexed slots below. No key is bound by default, so the slots carry
  // the indices a remap will address.
  activateRelic: {
    action: 'activateRelic',
    keys: [],
    codes: [],
    contexts: ['game'],
    preventDefault: true,
    modifierSuppressed: true,
    slots: RELIC_SLOTS,
  },

  // Activated through the settings control.
  openSettings: {
    action: 'openSettings',
    keys: [],
    codes: [],
    contexts: ['game', 'overlay'],
    preventDefault: true,
    modifierSuppressed: true,
  },

  // Reached through `cancel` or the settings panel's own control.
  closeSettings: {
    action: 'closeSettings',
    keys: [],
    codes: [],
    contexts: ['overlay'],
    preventDefault: true,
    modifierSuppressed: true,
  },

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
 * The default binding table. Frozen at every level: the table itself, each
 * binding, and each of the three arrays a binding carries.
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

  /**
   * Zero-based payload index the press addresses, read off the matched
   * `InputBindingSlot`.
   *
   * `0` where the binding declares no slots, or where none of them matched, so
   * an action whose payload is not an index always carries `0`.
   */
  readonly payloadIndex: number;
}

/**
 * Reports whether a modifier key is held.
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
 * @param event Event to resolve.
 * @param keymap Table to resolve against.
 * @param context Context currently active.
 * @returns The match, or `null` when no binding applies. `null` is also the
 * result for a recognised key held with a suppressing modifier.
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
      payloadIndex: resolveSlotIndex(binding, lowerCasedKey, code),
    });
  }

  return null;
}

/**
 * Reads the payload index a press addresses off the binding's slots.
 *
 * The index comes off the slot, never off the text of the key: a slot remapped
 * from `1` to `F1` still addresses the offer it always addressed.
 *
 * @param binding Binding that matched.
 * @param lowerCasedKey Lower-cased `KeyboardEvent.key`.
 * @param code `KeyboardEvent.code`.
 * @returns The matched slot's index, or `0` when none matches.
 */
function resolveSlotIndex(
  binding: InputBinding,
  lowerCasedKey: string,
  code: string,
): number {
  const slots = binding.slots;

  if (slots === undefined || slots.length === 0) {
    return 0;
  }

  for (const slot of slots) {
    if (lowerCasedKey.length > 0) {
      for (const bound of slot.keys) {
        if (bound.toLowerCase() === lowerCasedKey) {
          return slot.index;
        }
      }
    }

    if (code.length > 0) {
      for (const bound of slot.codes) {
        if (bound === code) {
          return slot.index;
        }
      }
    }
  }

  return 0;
}

/**
 * Resolves an event to the action it triggers.
 *
 * @param event Event to resolve.
 * @param keymap Table to resolve against.
 * @param context Context currently active.
 * @returns The action, or `null` when no binding applies.
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
    slots: override.slots ?? base.slots,
  });
}

/**
 * Builds a keymap from the defaults and optional per-action overrides.
 *
 * @param overrides Per-action overrides. Omitting the argument returns
 * `DEFAULT_KEY_BINDINGS` itself, already frozen.
 * @returns The frozen keymap.
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
 * @param keymap Table to search.
 * @param key Key or code to look for.
 * @param context Context to search within.
 * @param code `KeyboardEvent.code` of the same keystroke, where the caller has
 *   it. Omitted, only `key` is looked for, which is what every caller that
 *   passes a single string already means.
 * @returns The occupying binding, or `null` when the key is free.
 */
export function findBindingConflict(
  keymap: Keymap,
  key: string,
  context: InputContext,
  code?: string
): InputBinding | null {
  const lowerCasedKey = key.toLowerCase();

  // A PHYSICAL COLLISION `key` ALONE CANNOT SEE. On an alternate layout the
  // character a key produces differs from the character the bound key produced,
  // while `KeyboardEvent.code` is identical — so a capture that reports a free
  // `key` can still land on a key another action already holds by code.
  const physicalCode = code === undefined ? '' : code;

  for (const action of INPUT_ACTIONS) {
    const binding = keymap[action];

    if (!includesContext(binding, context)) {
      continue;
    }

    if (matchesBinding(binding, lowerCasedKey, key)) {
      return binding;
    }

    // Only the code list, and only where the code says something `key` did not:
    // the check above already compared `key` against both lists, so this adds
    // conflicts rather than replacing any.
    if (
      physicalCode !== '' &&
      physicalCode !== key &&
      matchesBinding(binding, '', physicalCode)
    ) {
      return binding;
    }
  }

  return null;
}

/**
 * Enumerates the bindings of a keymap in `INPUT_ACTIONS` order.
 *
 * @param keymap Table to enumerate.
 * @param context When given, only bindings active in that context are returned.
 * @returns A frozen list of bindings.
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
 * @returns The label, for example `'W'` for `'KeyW'` and `'1'` for `'Digit1'`.
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
 * @returns `UNBOUND_LABEL` for an empty list, the single label for one, `'A or
 * B'` for two, and `'A, B, or C'` for three or more.
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
 */
export function describeAction(action: InputAction): string {
  return ACTION_LABELS[action];
}

/**
 * Renders the keys bound to an action as spoken text.
 *
 * @param keymap Table to read from.
 * @param action Action to describe.
 * @returns The phrase, or `'Not bound'` when the action has no key.
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
 * @param keymap Table to project.
 * @returns The plain-data projection.
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
      slots: (binding.slots ?? EMPTY_SLOTS).map((slot) => ({
        index: slot.index,
        keys: slot.keys.slice(),
        codes: slot.codes.slice(),
      })),
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

/* --------------------------------------------------------------------------
 * Payload limits
 * ----------------------------------------------------------------------- */

/**
 * Largest persisted keymap text, in bytes, that may be parsed.
 *
 * Web Storage charges two bytes per UTF-16 code unit, and
 * `measureKeymapPayloadBytes()` measures the same way. A serialised default
 * keymap is roughly 2 KB, so this leaves room for a fully remapped table
 * with several bindings per action.
 *
 * The persistence layer applies this limit to the stored text BEFORE
 * parsing it; `deserializeKeymap()` receives already-parsed data and cannot
 * measure the text it came from.
 */
export const MAX_KEYMAP_PAYLOAD_BYTES = 16_384;

/**
 * Largest number of own properties a persisted keymap may carry.
 *
 * `INPUT_ACTIONS` has fourteen members. The allowance above that absorbs a
 * payload written by a future version carrying actions this one does not
 * know, while bounding the unknown-action scan.
 */
export const MAX_KEYMAP_PROPERTIES = 32;

/**
 * Largest number of entries one binding's `keys`, `codes` or `contexts`
 * list may carry.
 *
 * Every entry of `keys` and `codes` is compared on every keypress that
 * reaches `resolveInput`, so this bounds the per-keypress scan for the
 * lifetime of the loaded table. The widest default binding carries three.
 */
export const MAX_KEYMAP_ENTRIES_PER_LIST = 8;

/**
 * Longest string a persisted `keys`, `codes` or `contexts` entry may
 * carry.
 *
 * The longest value any default binding carries is `'ArrowRight'`, at ten
 * characters; the longest `KeyboardEvent.code` in general use is a little
 * over twenty.
 */
export const MAX_KEYMAP_STRING_LENGTH = 32;

/**
 * Most slots one persisted binding may declare.
 *
 * Bounds the indexed-payload lists the same way
 * `MAX_KEYMAP_ENTRIES_PER_LIST` bounds the key and code lists, and admits the
 * widest binding the defaults declare, `activateRelic` at
 * `RELIC_SLOT_COUNT`.
 */
export const MAX_KEYMAP_SLOTS = 16;

/**
 * Largest number of individual unknown-action reports one payload
 * produces. Past this count the names are no longer reported one by one
 * and a single total is reported instead.
 */
export const MAX_UNKNOWN_ACTION_REPORTS = 4;

/** Bytes charged per UTF-16 code unit, matching Web Storage accounting. */
const BYTES_PER_UTF16_UNIT = 2;

/**
 * Longest text a report carries for a value read out of the payload. A
 * property name comes from outside and is truncated to this many
 * characters, with an ellipsis appended, before it reaches a sink.
 */
const MAX_REPORTED_TEXT_LENGTH = 48;

/**
 * Shortens a value read out of the payload for reporting.
 *
 * @param value Text to shorten.
 * @returns `value` when it is within the reporting limit, otherwise its
 *   first `MAX_REPORTED_TEXT_LENGTH` characters followed by an ellipsis.
 */
function truncateForReport(value: string): string {
  return value.length <= MAX_REPORTED_TEXT_LENGTH
    ? value
    : `${value.slice(0, MAX_REPORTED_TEXT_LENGTH)}…`;
}

/** Which declared limit a payload broke. */
export type KeymapLimitName =
  | 'propertyCount'
  | 'entriesPerList'
  | 'stringLength'
  | 'slotCount';

/**
 * One broken limit, as a report carries it.
 *
 * Carries the limit's name, the measurement that broke it, the limit
 * itself, and — where the violation was inside one binding — the action and
 * field it was found in. No value read out of the payload is carried, so a
 * report of a hostile payload is bounded in size whatever that payload
 * contains.
 */
export interface KeymapLimitViolation {
  /** Which limit was broken. */
  readonly limit: KeymapLimitName;

  /** The measurement that broke it. */
  readonly observed: number;

  /** The limit `observed` was tested against. */
  readonly maximum: number;

  /** Action the violation was found in, where it was inside a binding. */
  readonly action?: string;

  /** Field the violation was found in, where it was inside a binding. */
  readonly field?: string;
}

/** Fields of a persisted binding whose entries are strings. */
const BOUNDED_LIST_FIELDS: readonly string[] = ['keys', 'codes', 'contexts'];

/** Property a persisted binding carries its indexed slots under. */
const SLOTS_FIELD = 'slots';

/** Fields of a persisted slot whose entries are strings. */
const SLOT_LIST_FIELDS: readonly string[] = ['keys', 'codes'];

/**
 * Measures a persisted keymap text the way Web Storage charges for it.
 *
 * @param text Stored text, before parsing.
 * @returns Size of `text` in bytes.
 */
export function measureKeymapPayloadBytes(text: string): number {
  return text.length * BYTES_PER_UTF16_UNIT;
}

/**
 * Reports whether a persisted keymap text is small enough to parse.
 *
 * Pure, total, and cheap: it reads the text's length and nothing else. The
 * persistence layer calls this before `JSON.parse`, so an oversized payload
 * never becomes an object graph.
 *
 * @param text Stored text, before parsing.
 * @returns `true` when the text is within `MAX_KEYMAP_PAYLOAD_BYTES`.
 */
export function isKeymapPayloadWithinLimit(text: string): boolean {
  return measureKeymapPayloadBytes(text) <= MAX_KEYMAP_PAYLOAD_BYTES;
}

/**
 * Finds the first declared limit a parsed payload breaks.
 *
 * Walks the payload's own properties in key order and, for each one that is
 * a record, the three string-list fields in `BOUNDED_LIST_FIELDS`. Returns
 * as soon as a limit is broken, so the walk is bounded by the limits
 * themselves.
 *
 * Reads lengths only: no key, string entry or other payload value is
 * carried in the result.
 *
 * @param raw Already-parsed persisted value.
 * @returns The first violation found, or `null` when the payload is within
 *   every limit.
 */
function findKeymapLimitViolation(
  raw: Record<string, unknown>
): KeymapLimitViolation | null {
  const names = Object.keys(raw);

  if (names.length > MAX_KEYMAP_PROPERTIES) {
    return {
      limit: 'propertyCount',
      observed: names.length,
      maximum: MAX_KEYMAP_PROPERTIES,
    };
  }

  for (const name of names) {
    const entry = raw[name];

    if (!isPlainRecord(entry)) {
      continue;
    }

    for (const field of BOUNDED_LIST_FIELDS) {
      const value = entry[field];

      if (!isUnknownArray(value)) {
        continue;
      }

      if (value.length > MAX_KEYMAP_ENTRIES_PER_LIST) {
        return {
          limit: 'entriesPerList',
          observed: value.length,
          maximum: MAX_KEYMAP_ENTRIES_PER_LIST,
          action: name,
          field,
        };
      }

      for (const item of value) {
        if (
          typeof item === 'string' &&
          item.length > MAX_KEYMAP_STRING_LENGTH
        ) {
          return {
            limit: 'stringLength',
            observed: item.length,
            maximum: MAX_KEYMAP_STRING_LENGTH,
            action: name,
            field,
          };
        }
      }
    }

    const slotViolation = findSlotLimitViolation(entry, name);

    if (slotViolation !== null) {
      return slotViolation;
    }
  }

  return null;
}

/**
 * Measures one persisted binding's `slots` list against the slot, entry and
 * string-length limits.
 *
 * @param entry Persisted binding to measure.
 * @param action Action the binding describes, for reporting.
 * @returns The first violation found, or `null`.
 */
function findSlotLimitViolation(
  entry: Record<string, unknown>,
  action: string,
): KeymapLimitViolation | null {
  const slots = entry[SLOTS_FIELD];

  if (!isUnknownArray(slots)) {
    return null;
  }

  if (slots.length > MAX_KEYMAP_SLOTS) {
    return {
      limit: 'slotCount',
      observed: slots.length,
      maximum: MAX_KEYMAP_SLOTS,
      action,
      field: SLOTS_FIELD,
    };
  }

  for (const slot of slots) {
    if (!isPlainRecord(slot)) {
      continue;
    }

    for (const field of SLOT_LIST_FIELDS) {
      const value = slot[field];

      if (!isUnknownArray(value)) {
        continue;
      }

      if (value.length > MAX_KEYMAP_ENTRIES_PER_LIST) {
        return {
          limit: 'entriesPerList',
          observed: value.length,
          maximum: MAX_KEYMAP_ENTRIES_PER_LIST,
          action,
          field: `${SLOTS_FIELD}.${field}`,
        };
      }

      for (const item of value) {
        if (
          typeof item === 'string' &&
          item.length > MAX_KEYMAP_STRING_LENGTH
        ) {
          return {
            limit: 'stringLength',
            observed: item.length,
            maximum: MAX_KEYMAP_STRING_LENGTH,
            action,
            field: `${SLOTS_FIELD}.${field}`,
          };
        }
      }
    }
  }

  return null;
}

/**
 * Reads an array of non-empty strings off a record.
 *
 * @param source Record to read from.
 * @param field Property name.
 * @param action Action the record describes, for reporting.
 * @param reporter Sink for rejected values.
 * @returns The accepted strings, or `null` when the property is absent or not
 * an array. An explicitly empty array is returned as such.
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
 * @returns The accepted contexts, or `null` when the property is absent, not an
 * array, or names no known context.
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
 * @returns The boolean, or `null` when the property is absent or not a boolean.
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

  const slots = readSlotList(entry, action, reporter);

  return freezeBinding({
    action,
    keys: keys ?? fallback.keys,
    codes: codes ?? fallback.codes,
    contexts: contexts ?? fallback.contexts,
    preventDefault: preventDefault ?? fallback.preventDefault,
    modifierSuppressed: modifierSuppressed ?? fallback.modifierSuppressed,
    slots: slots ?? fallback.slots,
  });
}

/**
 * Reads a persisted binding's indexed slots.
 *
 * A slot is accepted only with a finite, non-negative integer `index` and at
 * least one usable key or code; anything else is reported and dropped, so a
 * malformed slot cannot publish a payload naming a target that does not exist.
 *
 * @param source Persisted binding to read from.
 * @param action Action the binding describes, for reporting.
 * @param reporter Sink for rejected values.
 * @returns The accepted slots, or `null` when the property is absent or not an
 *   array. An explicitly empty array is returned as such.
 */
function readSlotList(
  source: Record<string, unknown>,
  action: InputAction,
  reporter: InputReporter,
): readonly InputBindingSlot[] | null {
  if (!Object.prototype.hasOwnProperty.call(source, SLOTS_FIELD)) {
    return null;
  }

  const raw = source[SLOTS_FIELD];

  if (!isUnknownArray(raw)) {
    reporter.log('warn', 'Keymap slot list is not an array; using default.', {
      action,
      received: describeRawType(raw),
    });
    reporter.count('input.keymap.deserialize.invalidSlots', { action });

    return null;
  }

  const accepted: InputBindingSlot[] = [];
  const seen = new Set<number>();

  let rejected = 0;

  for (const candidate of raw) {
    const slot = readSlot(candidate);

    if (slot === null || seen.has(slot.index)) {
      rejected += 1;

      continue;
    }

    seen.add(slot.index);
    accepted.push(slot);
  }

  if (rejected > 0) {
    reporter.log('warn', 'Keymap slot entries were rejected.', {
      action,
      rejected,
      accepted: accepted.length,
    });
    reporter.count('input.keymap.deserialize.rejectedSlot', {
      action,
      rejected,
    });
  }

  return Object.freeze(accepted);
}

/**
 * Reads one persisted slot.
 *
 * @param candidate Value to read.
 * @returns The slot, or `null` when it is unusable.
 */
function readSlot(candidate: unknown): InputBindingSlot | null {
  if (!isPlainRecord(candidate)) {
    return null;
  }

  const index = candidate['index'];

  if (
    typeof index !== 'number' ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= MAX_KEYMAP_SLOTS
  ) {
    return null;
  }

  const keys = readSlotStrings(candidate['keys']);
  const codes = readSlotStrings(candidate['codes']);

  if (keys.length === 0 && codes.length === 0) {
    return null;
  }

  return Object.freeze({
    index,
    keys: Object.freeze(keys),
    codes: Object.freeze(codes),
  });
}

/**
 * Reads a slot's key or code list, keeping only usable strings.
 *
 * @param value Value to read.
 * @returns The accepted strings, possibly empty.
 */
function readSlotStrings(value: unknown): string[] {
  if (!isUnknownArray(value)) {
    return [];
  }

  const accepted: string[] = [];

  for (const item of value) {
    if (
      typeof item !== 'string' ||
      item.length === 0 ||
      item.length > MAX_KEYMAP_STRING_LENGTH
    ) {
      continue;
    }

    accepted.push(item);
  }

  return accepted;
}

/**
 * Rebuilds a keymap from an already-parsed persisted value.
 *
 * The loader is guarded end to end: `null`, `undefined`, a value of the wrong
 * type, an unknown action name and a missing or malformed field each fall back
 * to the corresponding default and are reported through `reporter`. Every report
 * leaves through a contained reporter, so a sink that throws cannot fail the
 * load. Parsing and storage access belong to the persistence layer; this
 * function reads neither.
 *
 * LIMITS
 *   A payload that breaks `MAX_KEYMAP_PROPERTIES`,
 *   `MAX_KEYMAP_ENTRIES_PER_LIST` or `MAX_KEYMAP_STRING_LENGTH` is rejected
 *   ATOMICALLY: `DEFAULT_KEY_BINDINGS` is returned whole, no field of it is
 *   read into the result, and the report carries the broken limit's name and
 *   measurements rather than any payload content. The byte limit,
 *   `MAX_KEYMAP_PAYLOAD_BYTES`, belongs to the persistence layer and is applied
 *   through `isKeymapPayloadWithinLimit()` before the text is parsed.
 *
 *   Report volume is bounded too: at most `MAX_UNKNOWN_ACTION_REPORTS` unknown
 *   action names are reported individually, and any remainder is reported as one
 *   total.
 *
 * @param raw Already-parsed persisted value, of any shape.
 * @param reporter Sink for fallback reports. Defaults to `NOOP_REPORTER`.
 * @returns A frozen keymap. `DEFAULT_KEY_BINDINGS` is returned whole when `raw`
 *   cannot be read at all or breaks a declared limit.
 */
export function deserializeKeymap(
  raw: unknown,
  reporter: InputReporter = NOOP_REPORTER
): Keymap {
  const safeReporter = createSafeInputReporter(reporter);

  if (!isPlainRecord(raw)) {
    safeReporter.log(
      'warn',
      'Keymap payload is unreadable; using defaults.',
      { received: describeRawType(raw) }
    );
    safeReporter.count('input.keymap.deserialize.rejected', {
      received: describeRawType(raw),
    });

    return DEFAULT_KEY_BINDINGS;
  }

  const violation = findKeymapLimitViolation(raw);

  if (violation !== null) {
    const fields: InputReportFields = {
      limit: violation.limit,
      observed: violation.observed,
      maximum: violation.maximum,
      ...(violation.action === undefined ? {} : { action: violation.action }),
      ...(violation.field === undefined ? {} : { field: violation.field }),
    };

    safeReporter.log(
      'warn',
      'Keymap payload exceeds a declared limit; using defaults.',
      fields
    );
    safeReporter.count('input.keymap.deserialize.overLimit', fields);

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

    const binding = readBinding(action, raw[action], fallback, safeReporter);

    if (binding === null) {
      defaulted += 1;

      return fallback;
    }

    restored += 1;

    return binding;
  });

  let unknown = 0;

  for (const name of Object.keys(raw)) {
    if (INPUT_ACTION_SET.has(name)) {
      continue;
    }

    unknown += 1;

    if (unknown <= MAX_UNKNOWN_ACTION_REPORTS) {
      const reported = truncateForReport(name);

      safeReporter.log('warn', 'Keymap payload names an unknown action.', {
        action: reported,
      });
      safeReporter.count('input.keymap.deserialize.unknownAction', {
        action: reported,
      });
    }
  }

  if (unknown > MAX_UNKNOWN_ACTION_REPORTS) {
    safeReporter.log(
      'warn',
      'Keymap payload names further unknown actions; names not reported.',
      { unknown, reported: MAX_UNKNOWN_ACTION_REPORTS }
    );
    safeReporter.count('input.keymap.deserialize.unknownActionOverflow', {
      unknown,
      reported: MAX_UNKNOWN_ACTION_REPORTS,
    });
  }

  safeReporter.log('info', 'Keymap payload read.', { restored, defaulted });
  safeReporter.count('input.keymap.deserialize.completed', {
    restored,
    defaulted,
  });

  return keymap;
}
