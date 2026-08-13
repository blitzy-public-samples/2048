// The input manager: the publish/subscribe surface the engine subscribes to,
// and the keyboard and gesture paths that publish into it.
//
// This module reads no clock, consumes no randomness and touches no storage.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
// this module's area enumerated:
//   TR-INPUT-01  L1-L2      the event registry, held below as `listeners`
//   TR-INPUT-02  L15        the constructor-time `listen()` call
//   TR-INPUT-03  L18-L23    `on()`, appending to the array for its event name
//   TR-INPUT-04  L25-L32    `emit()`, walking that array in registration order
//   TR-INPUT-05  L34, L53   the single `keydown` listener, on the document
//   TR-INPUT-06  L54-L55    the modifier guard
//   TR-INPUT-07  L56        the recognised-key test
//   TR-INPUT-08  L60-L61    `preventDefault()` before the move is published
//   TR-INPUT-09  L66-L67    the separate `R` test, routed through `restart`
//   TR-INPUT-10  L76-L127   the swipe path, by way of src/input/touch-input.ts
//   TR-INPUT-11  L130-L133  `restart()`
//   TR-INPUT-12  L135-L138  `keepPlaying()`
//   TR-INPUT-13  target-only row  `resolveDocumentContext` and the per-context
//                                 binding resolution
//   TR-INPUT-14  target-only row  `classifyKeyModality` and the report that
//                                 carries no key or code
//
// Decisions: DL-INPUT-01, DL-INPUT-02, DL-INPUT-03, DL-INPUT-04, DL-INPUT-05
// (docs/DECISION_LOG.md).

import type {
  Direction,
  InputAction,
  InputBinding,
  InputBindingOverride,
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
  MOVE_ACTIONS,
  NOOP_REPORTER,
  createSafeInputReporter,
  directionForAction,
  findBindingConflict,
  hasMoveModifier,
  resolveInput,
  remapAction,
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

/** Counter raised once per binding this manager applied. */
const KEYMAP_REMAP_METRIC = 'input.keymap.remap';

const KEYMAP_CONFLICT_METRIC = 'input.keymap.remap.conflict';

/** Counter raised once per keymap this manager persisted, or failed to. */
const KEYMAP_PERSIST_METRIC = 'input.keymap.persist';

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

/** Why the binding table in force changed. */
export type KeymapChangeReason = 'remap' | 'replace';

/**
 * The two dimensions a binding occupies, and a remap is validated in.
 *
 * `'key'` is `KeyboardEvent.key`, the character the key produces, compared
 * case-insensitively; `'code'` is `KeyboardEvent.code`, the physical key,
 * compared exactly.
 */
export type RemapDimension = 'key' | 'code';

/** One binding already holding a requested value, and where it collided. */
interface RemapConflict {
  readonly binding: InputBinding;
  readonly dimension: RemapDimension;
}

/** The outcome of one `remap` call. */
export interface RemapResult {
  /** Whether the binding was applied. */
  readonly applied: boolean;

  /** The binding table in force after the call. */
  readonly keymap: Keymap;

  /**
   * The binding already holding one of the requested keys or codes in a
   * context the remapped action is active in, or `null` where none did.
   */
  readonly conflict: InputBinding | null;

  /** WHICH dimension collided: the logical `key` or the physical `code`. */
  readonly conflictDimension?: RemapDimension;
}

/** Construction parameters. Every member is optional. */
export interface InputManagerOptions {
  readonly keymap?: Keymap;
  readonly reporter?: InputReporter;

  /**
   * Called ONCE per accepted change to the binding table, with the table in
   * force afterwards and why it changed.
   *
   * THE SINGLE NOTIFICATION of a rebind: `remap()` is the only path that
   * changes the table, this manager is the only validator of a change to it,
   * and every follower — the generated controls, the persisted copy — hangs off
   * this one callback rather than being told separately. Decisions DL-INPUT-05
   * and DL-PANEL-04.
   *
   * A throw is reported and contained: a follower that fails cannot leave the
   * manager holding a table its own listeners are not using.
   */
  readonly onKeymapChange?: (
    keymap: Keymap,
    reason: KeymapChangeReason,
  ) => void;

  /**
   * Writes the binding table durably, returning whether the write succeeded.
   *
   * Called by `remap` and `setKeymap` before `onKeymapChange`, so a rebind
   * survives a reload without the caller remembering to save it. A throw is
   * reported and contained, and a `false` return is counted: persistence is
   * not allowed to fail a rebind that has already been applied in memory.
   */
  readonly persistKeymap?: (keymap: Keymap) => boolean;

  /**
   * Document the keydown listener binds to. Defaults to the ambient
   * `document`, and is `null` outside a browser.
   */
  readonly ownerDocument?: Document;
  readonly gestureHost?: Element | string;

  /**
   * The context keydown events are interpreted in. A context pins the manager
   * to that context until `setContext` replaces it; a function is consulted
   * once per keydown.
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

/** The terminal overlay of index.html, in its shown state. */
const SHOWN_TERMINAL_OVERLAY_SELECTOR =
  '.game-message.game-won, .game-message.game-over';

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
 * Resolves the input context from the document alone.
 *
 * @param owner Document to read.
 * @returns `'textEntry'` while a text field holds focus, `'overlay'` while a
 *   modal dialog in `.screen-layer` or the terminal overlay is shown, and
 *   `'game'` otherwise.
 */
export function resolveDocumentContext(owner: Document): InputContext {
  const active = owner.activeElement;

  if (active !== null && isTextEntry(active)) {
    return 'textEntry';
  }

  if (owner.querySelector(SHOWN_DIALOG_SELECTOR) !== null) {
    return 'overlay';
  }

  return owner.querySelector(SHOWN_TERMINAL_OVERLAY_SELECTOR) === null
    ? 'game'
    : 'overlay';
}

function readAmbientDocument(): Document | null {
  return typeof document === 'undefined' ? null : document;
}

/** The payload index published when no slot names one. */
const DEFAULT_PAYLOAD_INDEX = 0;

// NO REDUCTION OF A CAUGHT VALUE HAPPENS IN THIS MODULE. Every caught value
// leaves it through `InputReporter.failure` unconverted, and the ONE reduction
// the input layer performs — for a sink that implements no `failure` member —
// is `describeThrownForFields` in src/input/keymap.ts, which is where
// `createSafeInputReporter` applies it.

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
 * js/keyboard_input_manager.js L15 did. `listen` re-installs them after
 * `destroy`. Both are idempotent: neither can double-bind.
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

  /** Whether `listen` has bound and `destroy` has not yet unbound. */
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

  /** The one notification of a change to the table, or `null`. */
  private readonly onKeymapChange:
    | ((keymap: Keymap, reason: KeymapChangeReason) => void)
    | null;

  /** Durable writer for the table, or `null` where nothing persists it. */
  private readonly persistKeymap: ((keymap: Keymap) => boolean) | null;

  constructor(options: InputManagerOptions = {}) {
    this.reporter = createSafeInputReporter(
      options.reporter ?? NOOP_REPORTER,
    );
    this.keymap = options.keymap ?? DEFAULT_KEY_BINDINGS;
    this.onKeymapChange = options.onKeymapChange ?? null;
    this.persistKeymap = options.persistKeymap ?? null;
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

    // Snapshotted, not read live.
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
   * The count is raised first and separately, then the throw is delivered
   * through `InputReporter.failure`, which takes the caught value UNCONVERTED:
   * the name, the message, the stack and the cause chain of an `Error` all
   * survive to the sink, as does the structure of a non-`Error` — a plain
   * object, an array, `null` or `undefined` — that some code throws instead.
   *
   * `failure` is always present here, because `createSafeInputReporter` in
   * src/input/keymap.ts fills it in: for a sink that implements it the value is
   * passed through, and for a sink that does not the wrapper falls back to
   * `log` with `describeThrownForFields`, which that module documents as the
   * input layer's one and only such reduction. The choice therefore belongs to
   * the wrapper, and this method never converts a caught value itself.
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
      this.reporter.failure?.(
        'error',
        'An input listener threw; the remaining listeners still ran.',
        error,
        { event, listener: index },
      );
    } catch {
      // A faulty sink is contained here and is not reported back through
      // itself. `count` and `failure` are the only calls above, so what this
      // swallows is a reporter that throws while being told a listener threw —
      // re-raising it would abort the publish loop over the remaining
      // listeners, which is the containment this method exists to protect, and
      // reporting it would go to the sink that just failed. The caught
      // listener error is not lost by this: the loop continues, and the sink
      // that received the `count` before the `failure` still carries the count.
    }
  }

  /**
   * Publishes a move, counted under the modality it arrived through.
   *
   * @param direction Direction to publish. `0` up, `1` right, `2` down and
   *   `3` left, which is the encoding of the table at
   *   js/keyboard_input_manager.js L37-L50.
   * @param modality How the move arrived. Defaults to `'onScreen'`, which is
   *   how src/input/on-screen-controls.ts publishes one.
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
      // js/keyboard_input_manager.js L53: one listener, on the document, for
      // `keydown` alone.
      owner.addEventListener('keydown', this.handleKeyDown);
      this.teardown.push((): void => {
        owner.removeEventListener('keydown', this.handleKeyDown);
      });
    }

    // js/keyboard_input_manager.js L76-L127, by way of
    // src/input/touch-input.ts.
    this.detachTouch = attachTouchInput({
      onSwipe: (direction: Direction): void => {
        this.emitMove(direction, 'swipe');
      },
      host: this.gestureHost,
      ownerDocument: owner ?? undefined,
      reporter: this.reporter,
      family: this.pointerFamily,
      // The SAME effective context every other modality reads, not merely the
      // listening and suspension flags.
      isEnabled: (): boolean =>
        this.listening && !this.suspended && this.movementResolves(),
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
   * intact: a detached manager can still be published to, and `listen`
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

  /**
   * Replaces the whole binding table, persists it and announces it once.
   *
   * @param keymap Table to hold.
   */
  setKeymap(keymap: Keymap): void {
    this.keymap = keymap;
    this.reporter.count(KEYMAP_METRIC);
    this.saveKeymap(keymap);
    this.announceKeymap(keymap, 'replace');
  }

  getKeymap(): Keymap {
    return this.keymap;
  }

  /**
   * Binds one action to one key, validating, persisting and announcing it.
   *
   * THE SINGLE ENTRY POINT FOR A REBIND, performing all four steps in order so
   * no caller performs any of them itself:
   *
   *   1. VALIDATES. Every requested key AND every requested code is checked
   *      against every context the action is active in, so a key already bound
   *      to another action in a shared context is refused rather than shadowed —
   *      including one that collides only by physical code, which the logical
   *      key cannot see. The occupying binding and the dimension it collided in
   *      are returned so the caller can name both.
   *   2. APPLIES. The table this manager's own keydown listener reads is
   *      replaced, so the new binding is live for the next keystroke with no
   *      second write.
   *   3. PERSISTS, through `persistKeymap`.
   *   4. ANNOUNCES, exactly once, through `onKeymapChange`.
   *
   * A refusal does none of 2, 3 or 4 (N2).
   *
   * @param action Action to rebind.
   * @param binding Keys and codes to bind it to.
   * @returns Whether it was applied, the table in force afterwards, and the
   *   occupying binding on a refusal.
   */
  remap(action: InputAction, binding: InputBindingOverride): RemapResult {
    // The whole override is validated in both dimensions.
    const conflict = this.findRemapConflict(action, binding);

    if (conflict !== null) {
      this.reporter.count(KEYMAP_CONFLICT_METRIC, {
        action,
        occupant: conflict.binding.action,
        dimension: conflict.dimension,
      });

      return Object.freeze({
        applied: false,
        keymap: this.keymap,
        conflict: conflict.binding,
        conflictDimension: conflict.dimension,
      });
    }

    const next = remapAction(this.keymap, action, binding);

    this.keymap = next;
    this.reporter.count(KEYMAP_REMAP_METRIC, { action });
    this.saveKeymap(next);
    this.announceKeymap(next, 'remap');

    return Object.freeze({ applied: true, keymap: next, conflict: null });
  }

  /**
   * Finds the binding already holding any part of the MERGED binding where it
   * would collide, and reports which dimension collided.
   *
   * Only the contexts the rebound action will be active in are searched: two
   * actions may share a key when no context activates both, which is what lets
   * a digit drive a reward choice in an overlay and nothing in the game.
   *
   * @param action Action being rebound, which never conflicts with itself.
   * @param binding The override requested for it.
   * @returns The occupying binding and the dimension it collided in, or
   *   `null` where every value of the merged binding is free.
   */
  private findRemapConflict(
    action: InputAction,
    binding: InputBindingOverride,
  ): RemapConflict | null {
    const current = this.keymap[action];
    const keys = binding.keys ?? current.keys;
    const codes = binding.codes ?? current.codes;
    const declared = binding.contexts ?? current.contexts;

    // A binding that names no context is active in `'game'`, so that is where
    // a key it requests has to be free.
    const contexts: readonly InputContext[] =
      declared.length > 0 ? declared : ['game'];
    const dimensions: readonly {
      readonly values: readonly string[];
      readonly dimension: RemapDimension;
    }[] = [
      { values: keys, dimension: 'key' },
      { values: codes, dimension: 'code' },
    ];

    for (const { values, dimension } of dimensions) {
      for (const value of values) {
        if (value.length === 0) {
          continue;
        }

        for (const context of contexts) {
          const found = findBindingConflict(this.keymap, value, context);

          if (found !== null && found.action !== action) {
            return { binding: found, dimension };
          }
        }
      }
    }

    return null;
  }

  /** Writes the table durably, containing every failure. */
  private saveKeymap(keymap: Keymap): void {
    const persist = this.persistKeymap;

    if (persist === null) {
      return;
    }

    let saved = false;

    try {
      saved = persist(keymap);
    } catch (error: unknown) {
      this.reportKeymapFailure('persistKeymap', error);
    }

    this.reporter.count(KEYMAP_PERSIST_METRIC, { saved });
  }

  /**
   * Reports a throw from one of the two keymap collaborators.
   *
   * Contained the way a throwing listener is: neither the durable writer nor
   * the follower may abort a rebind the manager has already applied.
   *
   * @param member Name of the collaborator that threw.
   * @param error What it threw.
   */
  private reportKeymapFailure(member: string, error: unknown): void {
    try {
      this.reporter.failure?.(
        'error',
        'A keymap collaborator threw; the rebind still stands.',
        error,
        { member },
      );
    } catch {
      // A throwing sink is contained here too.
    }
  }

  /** Announces the table once, containing a follower's failure. */
  private announceKeymap(keymap: Keymap, reason: KeymapChangeReason): void {
    const announce = this.onKeymapChange;

    if (announce === null) {
      return;
    }

    try {
      announce(keymap, reason);
    } catch (error: unknown) {
      this.reportKeymapFailure('onKeymapChange', error);
    }
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (this.suspended) {
      this.reporter.count(SUSPENDED_METRIC);

      return;
    }

    const context = this.readContext();

    // L54-L55's modifier guard and L56's recognised-key test are both applied
    // by `resolveInput`.
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
      // L60 then L61: the default action is cancelled immediately before the
      // move is published, and for a recognised move alone.
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

  /**
   * Counts a keydown that resolved to no action, separating a key a binding
   * does claim but a held modifier suppressed, which is L54-L55's guard, from
   * a key no binding claims, which is L56's test.
   *
   * @param event Event that resolved to nothing.
   * @param context Context it was resolved in.
   */
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

  /**
   * Whether a movement action is bound in the context in force.
   *
   * @returns `true` when at least one of the four movement actions is
   *   active.
   */
  private movementResolves(): boolean {
    const context = this.readContext();

    return MOVE_ACTIONS.some((action) =>
      this.keymap[action].contexts.includes(context),
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
 * @returns The bound manager.
 */
export function createInputManager(
  options: InputManagerOptions = {},
): InputManager {
  return new InputManager(options);
}
