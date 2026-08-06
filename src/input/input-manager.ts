// The input manager: the publish/subscribe surface the engine and the
// interface subscribe to, and the keyboard, pointer and control bindings
// that feed it.
//
// Ported from js/keyboard_input_manager.js, which is deleted:
//   js/keyboard_input_manager.js L2, L18-L32  the event registry
//   js/keyboard_input_manager.js L34-L69      the keydown binding
//   js/keyboard_input_manager.js L72-L74      the three control bindings
//   js/keyboard_input_manager.js L76-L127     the swipe path
//   js/keyboard_input_manager.js L130-L138    restart and keepPlaying
//   js/keyboard_input_manager.js L140-L144    bindButtonPress()
// The numeric-code table at L37-L50 and the numeric `82` test at L66 moved
// to src/input/keymap.ts, and the three gesture handlers moved to
// src/input/touch-input.ts. This module binds them and publishes what
// they resolve to.
//
// THREE CHANGES TO THE PORTED BEHAVIOUR
//   Resolution reads `event.key` and `event.code` through the keymap
//   rather than the deprecated `event.which`, so a remapped binding and a
//   non-US layout both resolve.
//
//   Every element lookup is guarded. L78 handed the result of
//   `getElementsByClassName(...)[0]` straight to `addEventListener` and
//   L141-L142 did the same with `querySelector`, so a renamed class was a
//   startup failure; a missing element is now reported and the remaining
//   bindings still attach.
//
//   A control is bound on `click` alone. L142-L143 bound both `click` and
//   the pointer family's end event, which fires twice on one tap;
//   index.html's three controls are `<button>` elements, whose activation
//   click the user agent synthesises for pointer, touch and keyboard
//   alike, so one binding covers every modality and each activation
//   publishes exactly once.
//
// Invariants of this module: it consumes no randomness, reads no clock
// and touches no storage.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import type {
  Direction,
  InputAction,
  InputContext,
  InputEventName,
  InputEventPayload,
  InputReporter,
  Keymap,
} from './keymap';
import {
  DEFAULT_KEY_BINDINGS,
  NOOP_REPORTER,
  directionForAction,
  resolveInput,
} from './keymap';
import type { DetachTouchInput } from './touch-input';
import { attachTouchInput } from './touch-input';

/* --------------------------------------------------------------------------
 * Counter names
 * ----------------------------------------------------------------------- */

/** Counter name for one published event. */
const EMIT_METRIC = 'input.emit';

/** Counter name for a listener that threw. */
const LISTENER_ERROR_METRIC = 'input.listener.error';

/** Counter name for a keydown that resolved to an action. */
const RESOLVED_METRIC = 'input.key.resolved';

/** Counter name for a control that could not be found. */
const CONTROL_MISSING_METRIC = 'input.control.missing';

/** Counter name for a bound control activation. */
const CONTROL_ACTIVATED_METRIC = 'input.control.activated';

/* --------------------------------------------------------------------------
 * Contract
 * ----------------------------------------------------------------------- */

/** Removes one listener. Calling it more than once is harmless. */
export type InputSubscription = () => void;

/**
 * A listener bound to one input event.
 *
 * @param payload The event's payload: a `Direction` for `'move'`, an
 *   index for `'selectReward'` and `'activateRelic'`, an optional seed
 *   for `'startRun'`, and `undefined` for every other event.
 */
export type InputListener<K extends InputEventName> = (
  payload: InputEventPayload[K],
) => void;

/**
 * One control binding: a selector and the action activating it
 * publishes.
 *
 * Ported from the three `bindButtonPress` calls at
 * js/keyboard_input_manager.js L72-L74.
 */
export interface ControlBinding {
  /** Selector the control is looked up by. */
  readonly selector: string;

  /** Action an activation resolves to. */
  readonly action: InputAction;
}

/**
 * The controls index.html declares, and the action each publishes.
 *
 * `.retry-button` and `.restart-button` both publish `restart`, which is
 * what L72-L73 bound them to, and `.keep-playing-button` publishes
 * `keepPlaying`, from L74. The order is the order those three lines bound
 * them in.
 */
export const DEFAULT_CONTROL_BINDINGS: readonly ControlBinding[] =
  Object.freeze([
    Object.freeze({ selector: '.retry-button', action: 'restart' as const }),
    Object.freeze({ selector: '.restart-button', action: 'restart' as const }),
    Object.freeze({
      selector: '.keep-playing-button',
      action: 'keepPlaying' as const,
    }),
  ]);

/** Construction parameters. */
export interface InputManagerOptions {
  /**
   * Table keydown events are resolved against. Defaults to
   * `DEFAULT_KEY_BINDINGS`.
   */
  readonly keymap?: Keymap;

  /**
   * Document the keydown listener binds to and every control is looked
   * up in. Defaults to the ambient `document`.
   */
  readonly ownerDocument?: Document;

  /**
   * Element or selector the gesture listeners bind to. Passed through to
   * `attachTouchInput`, which defaults it to `.game-container`.
   */
  readonly gestureHost?: Element | string;

  /** Controls to bind. Defaults to `DEFAULT_CONTROL_BINDINGS`. */
  readonly controls?: readonly ControlBinding[];

  /** Sink for logs and counters. Defaults to `NOOP_REPORTER`. */
  readonly reporter?: InputReporter;

  /**
   * Resolves the context a keydown is interpreted in. Defaults to a
   * resolver that reads the document: `'textEntry'` while a text field
   * holds focus, `'overlay'` while a dialog in `.screen-layer` is shown,
   * and `'game'` otherwise.
   */
  readonly context?: () => InputContext;
}

/**
 * The manager.
 *
 * Frozen: the five members below are its whole surface.
 */
export interface InputManager {
  /**
   * Registers a listener.
   *
   * Listeners of one event are invoked in registration order, which is
   * the order js/keyboard_input_manager.js L28-L30 invoked its own
   * subscribers in.
   *
   * @param event Event to listen for.
   * @param listener Called with the event's payload.
   * @returns A handle that removes this listener.
   */
  on<K extends InputEventName>(
    event: K,
    listener: InputListener<K>,
  ): InputSubscription;

  /**
   * Removes a listener.
   *
   * @param event Event the listener was registered for.
   * @param listener The exact function that was registered.
   * @returns `true` when a listener was removed.
   */
  off<K extends InputEventName>(
    event: K,
    listener: InputListener<K>,
  ): boolean;

  /**
   * Publishes one event.
   *
   * Ported from js/keyboard_input_manager.js L25-L32, with the listener
   * walk wrapped: one listener that throws is reported and the rest
   * still run.
   *
   * @param event Event to publish.
   * @param payload The event's payload.
   * @returns How many listeners were invoked.
   */
  emit<K extends InputEventName>(
    event: K,
    payload: InputEventPayload[K],
  ): number;

  /**
   * Reads the context a keydown would currently be interpreted in.
   *
   * @returns The active context.
   */
  context(): InputContext;

  /**
   * Removes every listener this manager bound to the document, the
   * gesture host and the controls.
   *
   * Calling it more than once is harmless. The event registry is left
   * intact, so a detached manager can still be published to.
   */
  detach(): void;
}

/* --------------------------------------------------------------------------
 * Context resolution
 * ----------------------------------------------------------------------- */

/** Input types that take text and therefore suppress movement bindings. */
const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'search',
  'email',
  'number',
  'password',
  'tel',
  'url',
]);

/**
 * Reports whether an element takes text input.
 *
 * @param element Element to test.
 * @returns `true` for a text-taking input, a textarea, or any element
 *   made editable.
 */
function isTextEntry(element: Element): boolean {
  const name = element.tagName;

  if (name === 'TEXTAREA') {
    return true;
  }

  if (name === 'INPUT') {
    const type = element.getAttribute('type');

    return type === null || TEXT_INPUT_TYPES.has(type.toLowerCase());
  }

  return element.getAttribute('contenteditable') === 'true';
}

/**
 * Selector matching a shown dialog in the overlay layer.
 *
 * index.html declares six of them inside `.screen-layer`: the five
 * screen-router containers and `#settings-panel`. The router shows one at
 * a time by removing the `hidden` attribute.
 */
const SHOWN_DIALOG_SELECTOR = '.screen-layer [aria-modal="true"]:not([hidden])';

/**
 * Resolves the context a keydown is interpreted in from the document.
 *
 * @param owner Document to read.
 * @returns `'textEntry'`, `'overlay'` or `'game'`.
 */
function resolveDocumentContext(owner: Document): InputContext {
  const active = owner.activeElement;

  if (active !== null && isTextEntry(active)) {
    return 'textEntry';
  }

  return owner.querySelector(SHOWN_DIALOG_SELECTOR) === null
    ? 'game'
    : 'overlay';
}

/* --------------------------------------------------------------------------
 * Action projection
 * ----------------------------------------------------------------------- */

/**
 * Reads the zero-based index a digit key carries.
 *
 * `selectReward` is bound to the digits 1, 2 and 3, which address the
 * three reward offers; the same derivation serves `activateRelic`, whose
 * default binding is empty and which is reached through the relic tray's
 * own controls.
 *
 * @param event Event the action resolved from, or `undefined` when the
 *   action was published by a control rather than a key.
 * @returns The zero-based index, or 0 when no digit is available.
 */
function indexFromEvent(event: KeyboardEvent | undefined): number {
  if (event === undefined) {
    return 0;
  }

  const digit =
    /^(?:Digit)?([1-9])$/.exec(event.code) ?? /^([1-9])$/.exec(event.key);

  return digit === null ? 0 : Number(digit[1]) - 1;
}

/* --------------------------------------------------------------------------
 * Construction
 * ----------------------------------------------------------------------- */

/**
 * Reads the ambient `document`.
 *
 * @returns The document, or `null` outside a browser.
 */
function readAmbientDocument(): Document | null {
  return typeof document === 'undefined' ? null : document;
}

/**
 * Creates an input manager and binds it.
 *
 * Binding happens during construction, which is what
 * js/keyboard_input_manager.js L15 did. A binding whose target is absent
 * is reported and skipped; construction never throws.
 *
 * @param options Keymap, document, gesture host, controls, reporter and
 *   context resolver. Every member is optional.
 * @returns A frozen, bound manager.
 *
 * @example
 * ```ts
 * const input = createInputManager({ reporter });
 *
 * input.on('move', (direction) => engine.move(direction));
 * input.on('restart', () => engine.restart());
 * input.on('keepPlaying', () => engine.continuePlaying());
 * ```
 */
export function createInputManager(
  options: InputManagerOptions = {},
): InputManager {
  const keymap = options.keymap ?? DEFAULT_KEY_BINDINGS;
  const reporter = options.reporter ?? NOOP_REPORTER;
  const controls = options.controls ?? DEFAULT_CONTROL_BINDINGS;
  const owner = options.ownerDocument ?? readAmbientDocument();

  // One array per event name, appended to in registration order. Ported
  // from the object at js/keyboard_input_manager.js L2.
  const listeners = new Map<InputEventName, InputListener<InputEventName>[]>();

  /** Removals to run on `detach()`. */
  const teardown: (() => void)[] = [];

  let detached = false;

  const readContext = (): InputContext => {
    if (options.context !== undefined) {
      return options.context();
    }

    return owner === null ? 'game' : resolveDocumentContext(owner);
  };

  const emit = <K extends InputEventName>(
    event: K,
    payload: InputEventPayload[K],
  ): number => {
    reporter.count(EMIT_METRIC, { event });

    const held = listeners.get(event);

    if (held === undefined || held.length === 0) {
      return 0;
    }

    // Snapshotted before the walk, so a listener that subscribes or
    // unsubscribes during the walk does not alter this publication.
    const walking = held.slice() as InputListener<K>[];

    let invoked = 0;

    for (const listener of walking) {
      invoked += 1;

      try {
        listener(payload);
      } catch (caught: unknown) {
        reporter.count(LISTENER_ERROR_METRIC, { event });
        reporter.log('error', 'An input listener threw.', {
          event,
          message: caught instanceof Error ? caught.message : String(caught),
        });
      }
    }

    return invoked;
  };

  /**
   * Publishes the event an action resolves to.
   *
   * The four movement actions all publish `'move'` with their own
   * direction, which is what the shared numeric values of the map at
   * js/keyboard_input_manager.js L37-L50 expressed.
   *
   * @param action Action to publish.
   * @param event Keyboard event the action resolved from, where it
   *   resolved from one.
   */
  const publishAction = (
    action: InputAction,
    event?: KeyboardEvent,
  ): void => {
    const direction: Direction | null = directionForAction(action);

    if (direction !== null) {
      emit('move', direction);

      return;
    }

    switch (action) {
      case 'restart':
        emit('restart', undefined);

        return;
      case 'keepPlaying':
        emit('keepPlaying', undefined);

        return;
      case 'startRun':
        emit('startRun', undefined);

        return;
      case 'selectReward':
        emit('selectReward', indexFromEvent(event));

        return;
      case 'activateRelic':
        emit('activateRelic', indexFromEvent(event));

        return;
      case 'continueStage':
        emit('continueStage', undefined);

        return;
      case 'endRun':
        emit('endRun', undefined);

        return;
      case 'openSettings':
        emit('openSettings', undefined);

        return;
      case 'closeSettings':
        emit('closeSettings', undefined);

        return;
      default:
        emit('cancel', undefined);

        return;
    }
  };

  // The keydown binding, ported from L53-L69. The modifier guard at
  // L54-L55 and the recognised-key test at L56 both live in
  // `resolveInput`; `preventDefault` is called where the matched binding
  // asks for it, which is L60 and L131.
  if (owner !== null) {
    const onKeyDown = (event: KeyboardEvent): void => {
      const resolved = resolveInput(event, keymap, readContext());

      if (resolved === null) {
        return;
      }

      if (resolved.preventDefault) {
        event.preventDefault();
      }

      reporter.count(RESOLVED_METRIC, { action: resolved.action });
      publishAction(resolved.action, event);
    };

    owner.addEventListener('keydown', onKeyDown);
    teardown.push((): void => {
      owner.removeEventListener('keydown', onKeyDown);
    });
  } else {
    reporter.log('error', 'Input manager found no document to bind to.');
  }

  // The three control bindings, ported from L72-L74 and L140-L144.
  if (owner !== null) {
    for (const binding of controls) {
      const element = owner.querySelector(binding.selector);

      if (element === null) {
        reporter.log('error', 'An input control is absent.', {
          selector: binding.selector,
          action: binding.action,
        });
        reporter.count(CONTROL_MISSING_METRIC, {
          selector: binding.selector,
        });

        continue;
      }

      const onActivate = (event: Event): void => {
        // Ported from L131 and L136, which called it on both handlers.
        event.preventDefault();

        reporter.count(CONTROL_ACTIVATED_METRIC, {
          selector: binding.selector,
          action: binding.action,
        });
        publishAction(binding.action);
      };

      element.addEventListener('click', onActivate);
      teardown.push((): void => {
        element.removeEventListener('click', onActivate);
      });
    }
  }

  // The swipe path, ported from L76-L127 by way of
  // src/input/touch-input.ts. A resolved swipe publishes `'move'`, which
  // is what L125 did.
  const detachTouch: DetachTouchInput = attachTouchInput({
    onSwipe: (direction: Direction): void => {
      emit('move', direction);
    },
    host: options.gestureHost,
    ownerDocument: owner ?? undefined,
    reporter,
    isEnabled: (): boolean => !detached,
  });

  teardown.push(detachTouch);

  return Object.freeze({
    on<K extends InputEventName>(
      event: K,
      listener: InputListener<K>,
    ): InputSubscription {
      const bound = listener as InputListener<InputEventName>;
      const held = listeners.get(event);

      if (held === undefined) {
        listeners.set(event, [bound]);
      } else {
        held.push(bound);
      }

      let removed = false;

      return (): void => {
        if (removed) {
          return;
        }

        removed = true;

        const current = listeners.get(event);

        if (current === undefined) {
          return;
        }

        const index = current.indexOf(bound);

        if (index >= 0) {
          current.splice(index, 1);
        }
      };
    },

    off<K extends InputEventName>(
      event: K,
      listener: InputListener<K>,
    ): boolean {
      const held = listeners.get(event);

      if (held === undefined) {
        return false;
      }

      const index = held.indexOf(listener as InputListener<InputEventName>);

      if (index < 0) {
        return false;
      }

      held.splice(index, 1);

      return true;
    },

    emit,

    context: readContext,

    detach(): void {
      if (detached) {
        return;
      }

      detached = true;

      for (const remove of teardown) {
        remove();
      }

      teardown.length = 0;
    },
  });
}
