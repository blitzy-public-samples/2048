// The input manager: the publish/subscribe surface the engine subscribes to,
// and the keyboard and gesture paths that publish into it.
//
// Ported from js/keyboard_input_manager.js, which is deleted:
//   L1-L2      the event registry, held below as `listeners`
//   L15        the constructor-time `listen()` call
//   L18-L23    `on()`, which appends to the array for its event name
//   L25-L32    `emit()`, which walks that array in registration order
//   L34, L53   the single `keydown` listener, bound to the document
//   L54-L55    the modifier guard
//   L56        the recognised-key test
//   L60-L61    `preventDefault()` immediately before the move is published
//   L66-L67    the separate `R` test, routed through `restart`
//   L76-L127   the swipe path, by way of src/input/touch-input.ts
//   L130-L133  `restart()`
//   L135-L138  `keepPlaying()`
//
// Moved out of this module: the numeric-code table at L37-L50 and the numeric
// `82` test at L66 are bindings in src/input/keymap.ts, matched against
// `event.key` and `event.code`; the three gesture handlers at L80-L127 are
// src/input/touch-input.ts; and the control bindings at L72-L74 and L140-L144
// are src/input/on-screen-controls.ts, which invokes the `restart`,
// `keepPlaying` and `emitMove` members declared below.
//
// This module reads no clock, consumes no randomness and touches no storage.
// Decisions behind it are recorded in docs/DECISION_LOG.md.

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

/* --------------------------------------------------------------------------
 * Report names
 * ----------------------------------------------------------------------- */

/** Counter raised once per published event. */
const EMIT_METRIC = 'input.emit';

/** Span opened around one publication's listener walk. */
const DISPATCH_SPAN = 'input.dispatch';

/** Counter raised once per published move, carrying its modality. */
const MOVE_METRIC = 'input.move';

/** Counter raised once per keydown that resolved to an action. */
const RESOLVED_METRIC = 'input.key.resolved';

/** Counter raised once per keydown suppressed by a held modifier. */
const MODIFIER_METRIC = 'input.key.modifier.rejected';

/** Counter raised once per keydown that no binding claimed. */
const UNRECOGNISED_METRIC = 'input.key.unrecognised';

/** Counter raised once per keydown dropped while suspended. */
const SUSPENDED_METRIC = 'input.key.suspended';

/** Counter carrying the resolved pointer-family probe. */
const POINTER_FAMILY_METRIC = 'input.pointer.family';

/** Counter raised once per completed `listen()`. */
const LISTEN_METRIC = 'input.listen';

/** Counter raised once per `listen()` that found itself already bound. */
const LISTEN_REPEAT_METRIC = 'input.listen.repeat';

/** Counter raised once per completed `destroy()`. */
const DESTROY_METRIC = 'input.destroy';

/** Counter raised when no document could be resolved to bind to. */
const NO_DOCUMENT_METRIC = 'input.document.missing';

/** Counter raised once per `setContext()`. */
const CONTEXT_METRIC = 'input.context.changed';

/** Counter raised once per `suspend()` or `resume()`. */
const ENABLEMENT_METRIC = 'input.enablement.changed';

/** Counter raised once per `setKeymap()`. */
const KEYMAP_METRIC = 'input.keymap.replaced';

/* --------------------------------------------------------------------------
 * Contract
 * ----------------------------------------------------------------------- */

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

/**
 * A listener bound to one input event.
 *
 * @param payload The event's payload: a `Direction` for `'move'`, an index
 *   for `'selectReward'` and `'activateRelic'`, an optional seed for
 *   `'startRun'`, and `undefined` for every other event.
 */
export type InputListener<K extends InputEventName> = (
  payload: InputEventPayload[K],
) => void;

/**
 * The publish/subscribe surface, ported from js/keyboard_input_manager.js
 * L18-L32. `src/input/on-screen-controls.ts` binds against this type.
 */
export interface InputEmitter {
  /**
   * Registers a callback. Callbacks of one event are appended and invoked
   * in registration order; a later registration replaces no earlier one.
   *
   * @param event Event to listen for.
   * @param callback Called with the event's payload.
   * @returns A handle that removes this callback.
   */
  on<K extends InputEventName>(
    event: K,
    callback: InputListener<K>,
  ): InputSubscription;

  /**
   * Publishes one event synchronously, passing the payload as the single
   * argument each callback receives.
   *
   * @param event Event to publish.
   * @param payload The event's payload.
   * @returns How many callbacks were invoked.
   */
  emit<K extends InputEventName>(
    event: K,
    payload: InputEventPayload[K],
  ): number;
}

/** Construction parameters. Every member is optional. */
export interface InputManagerOptions {
  /**
   * Table keydown events are resolved against. Defaults to
   * `DEFAULT_KEY_BINDINGS`.
   */
  readonly keymap?: Keymap;

  /** Sink for logs, counters and spans. Defaults to `NOOP_REPORTER`. */
  readonly reporter?: InputReporter;

  /**
   * Document the keydown listener binds to. Defaults to the ambient
   * `document`, and is `null` outside a browser.
   */
  readonly ownerDocument?: Document;

  /**
   * Element or selector the gesture listeners bind to. Passed through to
   * `attachTouchInput`, which defaults it to `.game-container`.
   */
  readonly gestureHost?: Element | string;

  /**
   * The context keydown events are interpreted in. A context pins the
   * manager to that context until `setContext()` replaces it; a function is
   * consulted once per keydown. Omitted, the context is read from the
   * document: `'textEntry'` while a text field holds focus, `'overlay'`
   * while a dialog in `.screen-layer` is shown, and `'game'` otherwise.
   */
  readonly context?: InputContext | (() => InputContext);

  /**
   * Pointer event family the gesture path binds. Defaults to the result of
   * `detectPointerEventFamily()`.
   */
  readonly pointerFamily?: PointerEventFamily;
}

/* --------------------------------------------------------------------------
 * Modality classification
 * ----------------------------------------------------------------------- */

/** Lower-cased `KeyboardEvent.key` values of the four arrow keys. */
const ARROW_KEYS: ReadonlySet<string> = new Set([
  'arrowup',
  'arrowright',
  'arrowdown',
  'arrowleft',
]);

/** `KeyboardEvent.code` values of the four arrow keys. */
const ARROW_CODES: ReadonlySet<string> = new Set([
  'ArrowUp',
  'ArrowRight',
  'ArrowDown',
  'ArrowLeft',
]);

/** Lower-cased `KeyboardEvent.key` values of the four Vim keys. */
const VIM_KEYS: ReadonlySet<string> = new Set(['h', 'j', 'k', 'l']);

/** `KeyboardEvent.code` values of the four Vim keys. */
const VIM_CODES: ReadonlySet<string> = new Set([
  'KeyH',
  'KeyJ',
  'KeyK',
  'KeyL',
]);

/** Lower-cased `KeyboardEvent.key` values of the four WASD keys. */
const WASD_KEYS: ReadonlySet<string> = new Set(['w', 'a', 's', 'd']);

/** `KeyboardEvent.code` values of the four WASD keys. */
const WASD_CODES: ReadonlySet<string> = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
]);

/**
 * Reads a string property off an event without assuming it is present.
 *
 * @param value Value read from the event.
 * @returns `value` when it is a string, otherwise the empty string.
 */
function asEventString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Names the key family a keydown belongs to.
 *
 * The three families are the three the numeric table at
 * js/keyboard_input_manager.js L37-L50 held: the arrows at L38-L41, the Vim
 * keys at L42-L45 and WASD at L46-L49. A key outside all three resolved
 * through a remapped binding and is reported as `'key'`.
 *
 * @param key `KeyboardEvent.key`, lower-cased.
 * @param code `KeyboardEvent.code`, verbatim.
 * @returns The modality the keydown is counted under.
 */
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

/* --------------------------------------------------------------------------
 * Context resolution
 * ----------------------------------------------------------------------- */

/** Input types that take text, and so resolve to `'textEntry'`. */
const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'search',
  'email',
  'number',
  'password',
  'tel',
  'url',
]);

/** Selector matching a shown dialog in index.html's overlay layer. */
const SHOWN_DIALOG_SELECTOR = '.screen-layer [aria-modal="true"]:not([hidden])';

/**
 * Reports whether an element takes text input.
 *
 * @param element Element to test.
 * @returns `true` for a text-taking input, a textarea, or an element made
 *   editable.
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
 * Reads the context a keydown is interpreted in off the document.
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

/**
 * Reads the ambient `document`.
 *
 * @returns The document, or `null` outside a browser.
 */
function readAmbientDocument(): Document | null {
  return typeof document === 'undefined' ? null : document;
}

/* --------------------------------------------------------------------------
 * Payload helpers
 * ----------------------------------------------------------------------- */

/** Matches the digit a `KeyboardEvent.code` carries. */
const DIGIT_CODE_PATTERN = /^(?:Digit)?([1-9])$/;

/** Matches the digit a `KeyboardEvent.key` carries. */
const DIGIT_KEY_PATTERN = /^([1-9])$/;

/**
 * Reads the zero-based index a digit key carries. `selectReward` is bound to
 * the digits 1, 2 and 3, which address the three reward offers, and
 * `activateRelic` reads the same derivation.
 *
 * @param event Event the action resolved from, or `undefined` when the action
 *   was published without one.
 * @returns The zero-based index, or 0 when no digit is available.
 */
function indexFromEvent(event: KeyboardEvent | undefined): number {
  if (event === undefined) {
    return 0;
  }

  const matched =
    DIGIT_CODE_PATTERN.exec(asEventString(event.code)) ??
    DIGIT_KEY_PATTERN.exec(asEventString(event.key));

  if (matched === null) {
    return 0;
  }

  const digit = matched[1];

  return digit === undefined ? 0 : Number(digit) - 1;
}

/**
 * Projects a pointer family onto report fields.
 *
 * @param family Family to describe.
 * @returns The four members of the family, as report fields.
 */
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

/** The span returned when the injected sink opens none. */
const NOOP_SPAN: InputSpan = Object.freeze({
  end(): void {
    return;
  },
});

/* --------------------------------------------------------------------------
 * The manager
 * ----------------------------------------------------------------------- */

/**
 * The event-emitting input adapter: the publish/subscribe registry, the
 * keyboard path, and composition of the gesture path.
 *
 * Listeners are installed during construction, which is what
 * js/keyboard_input_manager.js L15 did. `listen()` re-installs them after
 * `destroy()`. Both are idempotent: neither can double-bind.
 *
 * This class binds no control elements. `restart`, `keepPlaying`,
 * `emitMove` and `publishAction` are the members
 * src/input/on-screen-controls.ts invokes, which is what
 * js/keyboard_input_manager.js L72-L74 handed to `bindButtonPress`.
 *
 * @example
 * ```ts
 * const input = new InputManager({ reporter });
 *
 * input.on('move', (direction) => engine.move(direction));
 * input.on('restart', () => engine.restart());
 * input.on('keepPlaying', () => engine.continuePlaying());
 * ```
 */
export class InputManager implements InputEmitter {
  /**
   * One array per event name, appended to in registration order. Ported
   * from the object at js/keyboard_input_manager.js L2.
   */
  private readonly listeners = new Map<
    InputEventName,
    InputListener<InputEventName>[]
  >();

  /** Removals `destroy()` runs. */
  private readonly teardown: (() => void)[] = [];

  /** Whether the keyboard and gesture paths are suspended. */
  private suspended = false;

  /** Whether `listen()` has bound and `destroy()` has not yet unbound. */
  private listening = false;

  /** Handle `attachTouchInput` returned, or `null` while unbound. */
  private detachTouch: DetachTouchInput | null = null;

  /** Sink every report leaves through, contained once at construction. */
  private readonly reporter: InputReporter;

  /** Document the keydown listener binds to, or `null`. */
  private readonly ownerDocument: Document | null;

  /** Element or selector the gesture listeners bind to. */
  private readonly gestureHost: Element | string | undefined;

  /** Pointer event family the gesture path binds. */
  private readonly pointerFamily: PointerEventFamily;

  /** Consulted once per keydown when the caller supplied a resolver. */
  private readonly contextResolver: (() => InputContext) | null;

  /** Table keydown events resolve against. */
  private keymap: Keymap;

  /** Context used when no resolver was supplied. */
  private activeContext: InputContext;

  /** Whether `activeContext` overrides the document-derived context. */
  private contextPinned: boolean;

  /**
   * @param options Keymap, reporter, document, gesture host, context and
   *   pointer family. Every member is optional.
   */
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

  /* ------------------------------------------------------------------------
   * Publish and subscribe
   * --------------------------------------------------------------------- */

  /**
   * Registers a callback.
   *
   * Ported from js/keyboard_input_manager.js L18-L23: the array for an
   * unseen event name is created lazily at L19-L21, and the callback is
   * pushed onto it at L22. A later registration is appended to the earlier
   * ones and replaces none.
   *
   * @param event Event to listen for.
   * @param callback Called with the event's payload.
   * @returns A handle that removes this callback. Calling it more than once
   *   is harmless.
   */
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

  /**
   * Removes a callback.
   *
   * @param event Event the callback was registered for.
   * @param callback The exact function that was registered.
   * @returns `true` when a callback was removed.
   */
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
   * Ported from js/keyboard_input_manager.js L25-L32: the array is looked
   * up at L26, the publication ends when there is none at L27, and each
   * callback is invoked synchronously in registration order at L28-L30 with
   * the payload as its single argument.
   *
   * @param event Event to publish.
   * @param payload The event's payload.
   * @returns How many callbacks were invoked.
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

    const walking = callbacks as readonly InputListener<K>[];
    const span = this.openSpan(`${DISPATCH_SPAN}.${event}`);

    let invoked = 0;

    // There is no `catch` here: a callback that throws propagates to its
    // caller, and the span is closed on the way out.
    try {
      for (const callback of walking) {
        invoked += 1;
        callback(payload);
      }
    } finally {
      span.end();
    }

    return invoked;
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
   *
   * @param action Action to publish.
   * @param event Keyboard event the action resolved from, where it resolved
   *   from one.
   */
  readonly publishAction = (
    action: InputAction,
    event?: KeyboardEvent,
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
        this.emit('selectReward', indexFromEvent(event));

        return;
      case 'activateRelic':
        this.emit('activateRelic', indexFromEvent(event));

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

  /**
   * Publishes `'restart'`.
   *
   * Ported from js/keyboard_input_manager.js L130-L133: the event's default
   * action is cancelled at L131 and the event is published at L132. The
   * parameter is optional: L66-L67's `R` path and a programmatic call supply
   * no event, while a control activation supplies one.
   *
   * @param event Event to cancel the default action of, where there is one.
   */
  readonly restart = (event?: Event): void => {
    if (event !== undefined) {
      event.preventDefault();
    }

    this.emit('restart', undefined);
  };

  /**
   * Publishes `'keepPlaying'`.
   *
   * Ported from js/keyboard_input_manager.js L135-L138: the event's default
   * action is cancelled at L136 and the event is published at L137.
   *
   * @param event Event to cancel the default action of, where there is one.
   */
  readonly keepPlaying = (event?: Event): void => {
    if (event !== undefined) {
      event.preventDefault();
    }

    this.emit('keepPlaying', undefined);
  };

  /* ------------------------------------------------------------------------
   * Binding
   * --------------------------------------------------------------------- */

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

  /**
   * Installs the keydown listener and the gesture path. Alias of
   * `listen()`, safe to pass as a value.
   */
  readonly start = (): void => {
    this.listen();
  };

  /**
   * Removes the keydown listener and invokes the gesture detach handle.
   *
   * Calling it while not listening removes nothing. The event registry is
   * left intact: a detached manager can still be published to, and
   * `listen()` re-installs everything this removed.
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

  /**
   * Removes the keydown listener and invokes the gesture detach handle.
   * Alias of `destroy()`, safe to pass as a value.
   */
  readonly detach = (): void => {
    this.destroy();
  };

  /** @returns Whether the keydown and gesture listeners are installed. */
  isListening(): boolean {
    return this.listening;
  }

  /* ------------------------------------------------------------------------
   * Context, enablement and remapping
   * --------------------------------------------------------------------- */

  /**
   * Pins the context keydown events are interpreted in, from this call
   * onwards. src/ui/screen-router.ts sets `'overlay'` while a screen holds
   * focus and `'game'` once it returns.
   *
   * @param context Context to interpret keydown events in.
   */
  setContext(context: InputContext): void {
    const from = this.activeContext;

    this.activeContext = context;
    this.contextPinned = true;

    this.reporter.count(CONTEXT_METRIC, { from, to: context });
  }

  /** @returns The context a keydown would currently be interpreted in. */
  context(): InputContext {
    return this.readContext();
  }

  /**
   * Suspends the keyboard and gesture paths. A suspended manager publishes
   * nothing from either, and can still be published to directly.
   */
  suspend(): void {
    if (this.suspended) {
      return;
    }

    this.suspended = true;
    this.reporter.count(ENABLEMENT_METRIC, { suspended: true });
  }

  /** Resumes the keyboard and gesture paths. */
  resume(): void {
    if (!this.suspended) {
      return;
    }

    this.suspended = false;
    this.reporter.count(ENABLEMENT_METRIC, { suspended: false });
  }

  /** @returns Whether the keyboard and gesture paths are suspended. */
  isSuspended(): boolean {
    return this.suspended;
  }

  /**
   * Replaces the table keydown events resolve against. The next keydown
   * resolves against the new table.
   *
   * @param keymap Table to resolve against.
   */
  setKeymap(keymap: Keymap): void {
    this.keymap = keymap;
    this.reporter.count(KEYMAP_METRIC);
  }

  /** @returns The table keydown events currently resolve against. */
  getKeymap(): Keymap {
    return this.keymap;
  }

  /* ------------------------------------------------------------------------
   * The keyboard path
   * --------------------------------------------------------------------- */

  /**
   * The single keydown handler, ported from js/keyboard_input_manager.js
   * L53-L69.
   *
   * @param event Event the document dispatched.
   */
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

    this.publishAction(resolved.action, event);
  };

  /**
   * Counts a keydown that resolved to no action, separating a key a binding
   * does claim but a held modifier suppressed, which is L54-L55's guard,
   * from a key no binding claims, which is L56's test.
   *
   * @param event Event that resolved to nothing.
   * @param context Context it was resolved in.
   */
  private reportUnresolved(
    event: KeyboardEvent,
    context: InputContext,
  ): void {
    const key = asEventString(event.key);
    const code = asEventString(event.code);
    const fields: InputReportFields = { key, code, context };

    if (hasMoveModifier(event) && this.isBound(key, code, context)) {
      this.reporter.count(MODIFIER_METRIC, fields);

      return;
    }

    this.reporter.count(UNRECOGNISED_METRIC, fields);
  }

  /**
   * Reports whether a binding claims a key or a code in a context,
   * independently of any held modifier.
   *
   * @param key `KeyboardEvent.key`, verbatim.
   * @param code `KeyboardEvent.code`, verbatim.
   * @param context Context to search within.
   * @returns `true` when either value is bound.
   */
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

  /**
   * Names the modality a keyboard event's move is counted under.
   *
   * @param event Event the move resolved from, or `undefined` when it
   *   resolved from none.
   * @returns The modality. An absent event is a control activation, which
   *   is counted as `'onScreen'`.
   */
  private modalityOf(event: KeyboardEvent | undefined): InputModality {
    if (event === undefined) {
      return 'onScreen';
    }

    return classifyKeyModality(
      asEventString(event.key).toLowerCase(),
      asEventString(event.code),
    );
  }

  /* ------------------------------------------------------------------------
   * Internals
   * --------------------------------------------------------------------- */

  /**
   * Resolves the context a keydown is interpreted in.
   *
   * @returns The resolver's result when one was supplied, the pinned
   *   context when one was set, and the document-derived context otherwise.
   */
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

  /**
   * Removes one callback from one event's array.
   *
   * @param event Event the callback was registered for.
   * @param callback The exact function that was registered.
   * @returns `true` when a callback was removed.
   */
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

  /**
   * Opens a timing span on the injected sink.
   *
   * @param name Span name.
   * @returns The open span, or a span that measures nothing when the sink
   *   opens none.
   */
  private openSpan(name: string): InputSpan {
    const open = this.reporter.startSpan;

    return open === undefined ? NOOP_SPAN : open.call(this.reporter, name);
  }
}

/* --------------------------------------------------------------------------
 * Construction
 * ----------------------------------------------------------------------- */

/**
 * Creates an input manager with its listeners installed.
 *
 * @param options Keymap, reporter, document, gesture host, context and
 *   pointer family. Every member is optional.
 * @returns The bound manager. A binding whose target is absent is reported
 *   and skipped; construction throws for nothing.
 *
 * @example
 * ```ts
 * const input = createInputManager({ ownerDocument: document });
 *
 * const stopMove = input.on('move', (direction) => engine.move(direction));
 * ```
 */
export function createInputManager(
  options: InputManagerOptions = {},
): InputManager {
  return new InputManager(options);
}

