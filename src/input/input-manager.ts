// The input manager: the publish/subscribe surface the engine subscribes to,
// and the keyboard and gesture paths that publish into it.
//
// Ported from js/keyboard_input_manager.js, which is deleted: the event
// registry, the constructor-time `listen()` call, `on()` appending to the array
// for its event name, `emit()` walking that array in registration order, the
// single document `keydown` listener, the modifier guard, the recognised-key
// test, `preventDefault()` immediately before the move is published, the
// separate `R` test routed through `restart`, the swipe path, `restart()` and
// `keepPlaying()`.
//
// Moved out of this module: the numeric-code table and the numeric `82` test
// are bindings in src/input/keymap.ts, matched against `event.key` and
// `event.code`; the three gesture handlers are src/input/touch-input.ts; and
// the control bindings are src/input/on-screen-controls.ts, which invokes the
// `restart`, `keepPlaying` and `emitMove` members declared below.
//
// This module reads no clock, consumes no randomness and touches no storage.
//
// No report this module raises carries a character a keypress produced.
// `event.key` and `event.code` are read for binding resolution and for the
// binding lookup only; what reaches the injected reporter for a keydown that
// resolved to no action is the context, the key modality
// `classifyKeyModality` derives, whether a modifier was held and whether any
// binding claims the key — never the key or the code itself.
//

import type {
  Direction,
  InputAction,
  InputContext,
  InputEventName,
  InputEventPayload,
  InputReportFields,
  InputReporter,
  InputSpan,
  Keymap,
} from './keymap';
import {
  DEFAULT_KEY_BINDINGS,
  NOOP_REPORTER,
  createSafeInputReporter,
  directionForAction,
  findBindingConflict,
  hasMoveModifier,
  resolveInput,
} from './keymap';
import type { DetachTouchInput, PointerEventFamily } from './touch-input';
import { attachTouchInput, detectPointerEventFamily } from './touch-input';

const EMIT_METRIC = 'input.emit';

const DISPATCH_SPAN = 'input.dispatch';

/** Counter name for one listener that threw during a publication. */
const LISTENER_ERROR_METRIC = 'input.listener.error';

/** Counter raised once per published move, carrying its modality. */
const MOVE_METRIC = 'input.move';

const RESOLVED_METRIC = 'input.key.resolved';

const MODIFIER_METRIC = 'input.key.modifier.rejected';

const UNRECOGNISED_METRIC = 'input.key.unrecognised';

const SUSPENDED_METRIC = 'input.key.suspended';

const POINTER_FAMILY_METRIC = 'input.pointer.family';

const LISTEN_METRIC = 'input.listen';

const LISTEN_REPEAT_METRIC = 'input.listen.repeat';

const DESTROY_METRIC = 'input.destroy';

const NO_DOCUMENT_METRIC = 'input.document.missing';

const CONTEXT_METRIC = 'input.context.changed';

const ENABLEMENT_METRIC = 'input.enablement.changed';

const KEYMAP_METRIC = 'input.keymap.replaced';

/** How a published move reached this module. */
export type InputModality =
  | 'arrow'
  | 'vim'
  | 'wasd'
  | 'key'
  | 'swipe'
  | 'onScreen';

/** Removes one listener. Calling it more than once is harmless. */
export type InputSubscription = () => void;

/** A listener bound to one input event. */
export type InputListener<K extends InputEventName> = (
  payload: InputEventPayload[K],
) => void;

/**
 * The publish/subscribe surface, ported from js/keyboard_input_manager.js
 * L18-L32. `src/input/on-screen-controls.ts` binds against this type.
 */
export interface InputEmitter {
  /**
   * Registers a callback. Callbacks of one event are appended and invoked in
   * registration order; a later registration replaces no earlier one.
   */
  on<K extends InputEventName>(
    event: K,
    callback: InputListener<K>,
  ): InputSubscription;

  emit<K extends InputEventName>(
    event: K,
    payload: InputEventPayload[K],
  ): number;
}

/** Construction parameters. Every member is optional. */
export interface InputManagerOptions {
  readonly keymap?: Keymap;
  readonly reporter?: InputReporter;

  /**
   * Document the keydown listener binds to. Defaults to the ambient
   * `document`, and is `null` outside a browser.
   */
  readonly ownerDocument?: Document;
  readonly gestureHost?: Element | string;

  /**
   * The context keydown events are interpreted in. A context pins the manager
   * to that context until `setContext()` replaces it; a function is consulted
   * once per keydown. Omitted, the context is read from the document:
   * `'textEntry'` while a text field holds focus, `'overlay'` while a dialog
   * in `.screen-layer` is shown, and `'game'` otherwise.
   */
  readonly context?: InputContext | (() => InputContext);
  readonly pointerFamily?: PointerEventFamily;
}

const ARROW_KEYS: ReadonlySet<string> = new Set([
  'arrowup',
  'arrowright',
  'arrowdown',
  'arrowleft',
]);

const ARROW_CODES: ReadonlySet<string> = new Set([
  'ArrowUp',
  'ArrowRight',
  'ArrowDown',
  'ArrowLeft',
]);

const VIM_KEYS: ReadonlySet<string> = new Set(['h', 'j', 'k', 'l']);

const VIM_CODES: ReadonlySet<string> = new Set([
  'KeyH',
  'KeyJ',
  'KeyK',
  'KeyL',
]);

const WASD_KEYS: ReadonlySet<string> = new Set(['w', 'a', 's', 'd']);

const WASD_CODES: ReadonlySet<string> = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
]);

function asEventString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function classifyKeyModality(key: string, code: string): InputModality {
  if (ARROW_KEYS.has(key) || ARROW_CODES.has(code)) {
    return 'arrow';
  }

  if (VIM_KEYS.has(key) || VIM_CODES.has(code)) {
    return 'vim';
  }

  if (WASD_KEYS.has(key) || WASD_CODES.has(code)) {
    return 'wasd';
  }

  return 'key';
}

const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'search',
  'email',
  'number',
  'password',
  'tel',
  'url',
]);

const SHOWN_DIALOG_SELECTOR = '.screen-layer [aria-modal="true"]:not([hidden])';

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

function resolveDocumentContext(owner: Document): InputContext {
  const active = owner.activeElement;

  if (active !== null && isTextEntry(active)) {
    return 'textEntry';
  }

  return owner.querySelector(SHOWN_DIALOG_SELECTOR) === null
    ? 'game'
    : 'overlay';
}

function readAmbientDocument(): Document | null {
  return typeof document === 'undefined' ? null : document;
}

/* --------------------------------------------------------------------------
 * Payload helpers
 * ----------------------------------------------------------------------- */

/** The payload index published when no slot names one. */
const DEFAULT_PAYLOAD_INDEX = 0;

/**
 * Projects a caught value onto a report field.
 *
 * @param error Value that was thrown.
 * @returns Its message where it is an `Error`, else its string form.
 */
function describeListenerError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function describePointerFamily(
  family: PointerEventFamily,
): InputReportFields {
  return {
    msPointerEnabled: family.msPointerEnabled,
    touchstart: family.touchstart,
    touchmove: family.touchmove,
    touchend: family.touchend,
  };
}

const NOOP_SPAN: InputSpan = Object.freeze({
  end(): void {
    return;
  },
});

/**
 * The event-emitting input adapter: the publish/subscribe registry, the
 * keyboard path, and composition of the gesture path.
 *
 * Listeners are installed during construction, which is what
 * js/keyboard_input_manager.js L15 did. `listen()` re-installs them after
 * `destroy()`. Both are idempotent: neither can double-bind.
 *
 * This class binds no control elements. `restart`, `keepPlaying`, `emitMove`
 * and `publishAction` are the members src/input/on-screen-controls.ts invokes,
 * which is what js/keyboard_input_manager.js L72-L74 handed to
 * `bindButtonPress`.
 */
export class InputManager implements InputEmitter {
  /**
   * One array per event name, appended to in registration order. Ported from
   * the object at js/keyboard_input_manager.js L2.
   */
  private readonly listeners = new Map<
    InputEventName,
    InputListener<InputEventName>[]
  >();

  private readonly teardown: (() => void)[] = [];

  private suspended = false;

  /** Whether `listen()` has bound and `destroy()` has not yet unbound. */
  private listening = false;

  /** Handle `attachTouchInput` returned, or `null` while unbound. */
  private detachTouch: DetachTouchInput | null = null;

  /** Sink every report leaves through, contained once at construction. */
  private readonly reporter: InputReporter;

  /** Document the keydown listener binds to, or `null`. */
  private readonly ownerDocument: Document | null;

  private readonly gestureHost: Element | string | undefined;

  private readonly pointerFamily: PointerEventFamily;

  private readonly contextResolver: (() => InputContext) | null;

  private keymap: Keymap;
  private activeContext: InputContext;
  private contextPinned: boolean;

  constructor(options: InputManagerOptions = {}) {
    this.reporter = createSafeInputReporter(
      options.reporter ?? NOOP_REPORTER,
    );
    this.keymap = options.keymap ?? DEFAULT_KEY_BINDINGS;
    this.ownerDocument = options.ownerDocument ?? readAmbientDocument();
    this.gestureHost = options.gestureHost;

    const context = options.context;

    if (typeof context === 'function') {
      this.contextResolver = context;
      this.activeContext = 'game';
      this.contextPinned = false;
    } else {
      this.contextResolver = null;
      this.activeContext = context ?? 'game';
      this.contextPinned = context !== undefined;
    }

    // The probe at js/keyboard_input_manager.js L4-L13, now
    // src/input/touch-input.ts's, resolved once and reported here.
    this.pointerFamily = options.pointerFamily ?? detectPointerEventFamily();

    const familyFields = describePointerFamily(this.pointerFamily);

    this.reporter.log(
      'info',
      'Input manager resolved the pointer event family.',
      familyFields,
    );
    this.reporter.count(POINTER_FAMILY_METRIC, familyFields);

    // L15.
    this.listen();
  }

  on<K extends InputEventName>(
    event: K,
    callback: InputListener<K>,
  ): InputSubscription {
    const bound = callback as InputListener<InputEventName>;
    const held = this.listeners.get(event);

    if (held === undefined) {
      this.listeners.set(event, [bound]);
    } else {
      held.push(bound);
    }

    let removed = false;

    return (): void => {
      if (removed) {
        return;
      }

      removed = true;
      this.removeListener(event, bound);
    };
  }

  off<K extends InputEventName>(
    event: K,
    callback: InputListener<K>,
  ): boolean {
    return this.removeListener(
      event,
      callback as InputListener<InputEventName>,
    );
  }

  /**
   * Publishes one event.
   *
   * Ported from js/keyboard_input_manager.js L25-L32: the array is looked up
   * at L26, the publication ends when there is none at L27, and each callback
   * is invoked synchronously in registration order at L28-L30 with the payload
   * as its single argument.
   */
  emit<K extends InputEventName>(
    event: K,
    payload: InputEventPayload[K],
  ): number {
    this.reporter.count(EMIT_METRIC, { event });

    const callbacks = this.listeners.get(event);

    if (callbacks === undefined) {
      return 0;
    }

    // Snapshotted, not read live: `on()` pushes onto this exact array and
    // `removeListener` splices it, so a registration made from inside a
    // callback would otherwise be reached by the walk that is running, and a
    // removal would shift the index of a callback not yet invoked.
    const walking = callbacks.slice() as readonly InputListener<K>[];
    const span = this.openSpan(`${DISPATCH_SPAN}.${event}`);

    let invoked = 0;

    try {
      for (let index = 0; index < walking.length; index += 1) {
        const callback = walking[index];

        if (callback === undefined) {
          continue;
        }

        invoked += 1;

        try {
          callback(payload);
        } catch (error: unknown) {
          this.reportListenerError(event, index, error);
        }
      }
    } finally {
      span.end();
    }

    return invoked;
  }

  /**
   * Reports one callback that threw.
   *
   * Contained itself, so a sink that throws while reporting cannot do what the
   * containment above exists to prevent.
   *
   * @param event Event being published.
   * @param index Position of the callback in the snapshot.
   * @param error The caught value.
   */
  private reportListenerError(
    event: InputEventName,
    index: number,
    error: unknown,
  ): void {
    try {
      this.reporter.count(LISTENER_ERROR_METRIC, { event, listener: index });
      this.reporter.log(
        'error',
        'An input listener threw; the remaining listeners still ran.',
        {
          event,
          listener: index,
          error: describeListenerError(error),
        },
      );
    } catch {
      // A throwing sink is contained here for the same reason the callback
      // above is: neither may abort a publication.
    }
  }

  /**
   * Publishes a move, counted under the modality it arrived through.
   *
   * @param direction Direction to publish. `0` up, `1` right, `2` down and
   *   `3` left, which is the encoding of the table at
   *   js/keyboard_input_manager.js L37-L50.
   * @param modality How the move arrived. Defaults to `'onScreen'`, which
   *   is how src/input/on-screen-controls.ts publishes one.
   * @returns How many callbacks were invoked.
   */
  readonly emitMove = (
    direction: Direction,
    modality: InputModality = 'onScreen',
  ): number => {
    this.reporter.count(MOVE_METRIC, { modality, direction });

    return this.emit('move', direction);
  };

  /**
   * Publishes the event an action resolves to.
   *
   * The four movement actions all publish `'move'`, carrying their own
   * direction, which is what the shared numeric values of the table at
   * js/keyboard_input_manager.js L37-L50 expressed.
   */
  readonly publishAction = (
    action: InputAction,
    event?: KeyboardEvent,
    payloadIndex: number = DEFAULT_PAYLOAD_INDEX,
  ): void => {
    const direction = directionForAction(action);

    if (direction !== null) {
      this.emitMove(direction, this.modalityOf(event));

      return;
    }

    switch (action) {
      case 'restart':
        this.restart(event);

        return;
      case 'keepPlaying':
        this.keepPlaying(event);

        return;
      case 'startRun':
        this.emit('startRun', undefined);

        return;
      case 'selectReward':
        this.emit('selectReward', payloadIndex);

        return;
      case 'activateRelic':
        this.emit('activateRelic', payloadIndex);

        return;
      case 'continueStage':
        this.emit('continueStage', undefined);

        return;
      case 'endRun':
        this.emit('endRun', undefined);

        return;
      case 'openSettings':
        this.emit('openSettings', undefined);

        return;
      case 'closeSettings':
        this.emit('closeSettings', undefined);

        return;
      default:
        this.emit('cancel', undefined);

        return;
    }
  };

  readonly restart = (event?: Event): void => {
    if (event !== undefined) {
      event.preventDefault();
    }

    this.emit('restart', undefined);
  };

  readonly keepPlaying = (event?: Event): void => {
    if (event !== undefined) {
      event.preventDefault();
    }

    this.emit('keepPlaying', undefined);
  };

  /**
   * Installs the keydown listener and the gesture path.
   *
   * Calling it while already listening binds nothing further: a second call
   * cannot double-bind.
   */
  listen(): void {
    if (this.listening) {
      this.reporter.count(LISTEN_REPEAT_METRIC);
      this.reporter.log('debug', 'Input manager is already listening.');

      return;
    }

    this.listening = true;

    const owner = this.ownerDocument;

    if (owner === null) {
      this.reporter.count(NO_DOCUMENT_METRIC);
      this.reporter.log(
        'error',
        'Input manager found no document to bind keydown to.',
        { target: 'document', event: 'keydown' },
      );
    } else {
      // js/keyboard_input_manager.js L53: one listener, on the document,
      // for `keydown` alone.
      owner.addEventListener('keydown', this.handleKeyDown);
      this.teardown.push((): void => {
        owner.removeEventListener('keydown', this.handleKeyDown);
      });
    }

    // js/keyboard_input_manager.js L76-L127, by way of
    // src/input/touch-input.ts. A resolved swipe publishes `'move'`, which
    // is what L125 did.
    this.detachTouch = attachTouchInput({
      onSwipe: (direction: Direction): void => {
        this.emitMove(direction, 'swipe');
      },
      host: this.gestureHost,
      ownerDocument: owner ?? undefined,
      reporter: this.reporter,
      family: this.pointerFamily,
      isEnabled: (): boolean => this.listening && !this.suspended,
    });

    this.reporter.count(LISTEN_METRIC);
  }

  readonly start = (): void => {
    this.listen();
  };

  /**
   * Removes the keydown listener and invokes the gesture detach handle.
   *
   * Calling it while not listening removes nothing. The event registry is left
   * intact: a detached manager can still be published to, and `listen()`
   * re-installs everything this removed.
   */
  destroy(): void {
    if (!this.listening) {
      return;
    }

    this.listening = false;

    for (const remove of this.teardown) {
      remove();
    }

    this.teardown.length = 0;

    const detach = this.detachTouch;

    if (detach !== null) {
      this.detachTouch = null;
      detach();
    }

    this.reporter.count(DESTROY_METRIC);
  }

  readonly detach = (): void => {
    this.destroy();
  };

  isListening(): boolean {
    return this.listening;
  }

  /**
   * Pins the context keydown events are interpreted in, from this call
   * onwards. A caller sets `'overlay'` while a screen holds focus and `'game'`
   * once it returns.
   */
  setContext(context: InputContext): void {
    const from = this.activeContext;

    this.activeContext = context;
    this.contextPinned = true;

    this.reporter.count(CONTEXT_METRIC, { from, to: context });
  }

  context(): InputContext {
    return this.readContext();
  }

  suspend(): void {
    if (this.suspended) {
      return;
    }

    this.suspended = true;
    this.reporter.count(ENABLEMENT_METRIC, { suspended: true });
  }

  resume(): void {
    if (!this.suspended) {
      return;
    }

    this.suspended = false;
    this.reporter.count(ENABLEMENT_METRIC, { suspended: false });
  }

  isSuspended(): boolean {
    return this.suspended;
  }

  setKeymap(keymap: Keymap): void {
    this.keymap = keymap;
    this.reporter.count(KEYMAP_METRIC);
  }

  getKeymap(): Keymap {
    return this.keymap;
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (this.suspended) {
      this.reporter.count(SUSPENDED_METRIC);

      return;
    }

    const context = this.readContext();

    // L54-L55's modifier guard and L56's recognised-key test are both
    // applied by `resolveInput`.
    const resolved = resolveInput(event, this.keymap, context);

    if (resolved === null) {
      this.reportUnresolved(event, context);

      return;
    }

    this.reporter.count(RESOLVED_METRIC, {
      action: resolved.action,
      context,
    });

    const direction = directionForAction(resolved.action);

    if (direction !== null) {
      // L60 then L61: the default action is cancelled immediately before
      // the move is published, and for a recognised move alone.
      if (resolved.preventDefault) {
        event.preventDefault();
      }

      this.emitMove(direction, this.modalityOf(event));

      return;
    }

    // L66-L67: the `R` test was a separate `if`, and it routed through
    // `restart`, which cancels the default action itself at L131.
    if (resolved.action === 'restart') {
      this.restart(event);

      return;
    }

    if (resolved.action === 'keepPlaying') {
      this.keepPlaying(event);

      return;
    }

    if (resolved.preventDefault) {
      event.preventDefault();
    }

    this.publishAction(resolved.action, event, resolved.payloadIndex);
  };

  private reportUnresolved(
    event: KeyboardEvent,
    context: InputContext,
  ): void {
    const modifier = hasMoveModifier(event);

    if (context === 'textEntry') {
      this.reporter.count(UNRECOGNISED_METRIC, { context, modifier });

      return;
    }

    const key = asEventString(event.key);
    const code = asEventString(event.code);
    const bound = this.isBound(key, code, context);
    const fields: InputReportFields = {
      context,
      modality: classifyKeyModality(key.toLowerCase(), code),
      modifier,
      bound,
    };

    if (modifier && bound) {
      this.reporter.count(MODIFIER_METRIC, fields);

      return;
    }

    this.reporter.count(UNRECOGNISED_METRIC, fields);
  }

  private isBound(
    key: string,
    code: string,
    context: InputContext,
  ): boolean {
    if (key.length > 0) {
      if (findBindingConflict(this.keymap, key, context) !== null) {
        return true;
      }
    }

    return (
      code.length > 0 &&
      findBindingConflict(this.keymap, code, context) !== null
    );
  }

  private modalityOf(event: KeyboardEvent | undefined): InputModality {
    if (event === undefined) {
      return 'onScreen';
    }

    return classifyKeyModality(
      asEventString(event.key).toLowerCase(),
      asEventString(event.code),
    );
  }

  private readContext(): InputContext {
    const resolver = this.contextResolver;

    if (resolver !== null) {
      return resolver();
    }

    if (this.contextPinned) {
      return this.activeContext;
    }

    const owner = this.ownerDocument;

    return owner === null ? this.activeContext : resolveDocumentContext(owner);
  }

  private removeListener(
    event: InputEventName,
    callback: InputListener<InputEventName>,
  ): boolean {
    const held = this.listeners.get(event);

    if (held === undefined) {
      return false;
    }

    const index = held.indexOf(callback);

    if (index < 0) {
      return false;
    }

    held.splice(index, 1);

    return true;
  }

  private openSpan(name: string): InputSpan {
    const open = this.reporter.startSpan;

    return open === undefined ? NOOP_SPAN : open.call(this.reporter, name);
  }
}

/**
 * Creates an input manager with its listeners installed.
 *
 * @returns The bound manager. A binding whose target is absent is reported and
 *   skipped rather than raised.
 */
export function createInputManager(
  options: InputManagerOptions = {},
): InputManager {
  return new InputManager(options);
}
