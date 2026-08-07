// One focusable, tappable control per bindable action, and the only module in
// src/input/ that binds an element to an action.
//
// Ported from js/keyboard_input_manager.js, which is deleted:
//   L71-L74    the three control bindings — `.retry-button` and
//              `.restart-button` to `restart`, `.keep-playing-button` to
//              `keepPlaying`, in that order
//   L140-L144  `bindButtonPress` — the selector lookup at L141, the `'click'`
//              listener at L142 and the resolved touch-end listener at L143
//
// Retained from that port: `bindButtonPress` binds BOTH `'click'` and the
// resolved touch-end event to one handler, so a tap can dispatch twice
// (L142-L143). Noted, not fixed.
//
// Changed against that port, each recorded in docs/DECISION_LOG.md:
//   - the L141 lookup is null-checked, reported and skipped
//   - a control the markup leaves unfocusable or unnamed is promoted, and the
//     promotion is reported
//   - `fn.bind(this)` at L142-L143 is a lexically scoped handler;
//     js/bind_polyfill.js is deleted
//   - every action of `INPUT_ACTIONS` also gets a generated `<button>`, so the
//     eleven actions the markup declares no control for are reachable too
//
// Imports are limited to ./keymap, ./touch-input and ./input-manager. This
// module reads no storage and declares no visual value: every colour, length,
// radius and duration it relies on is declared in style/_tokens.scss,
// style/_a11y.scss and style/_screens.scss and reached through the class names
// emitted below.

import type {
  Direction,
  InputAction,
  InputBinding,
  InputContext,
  InputReportFields,
  InputReporter,
  InputSpan,
  Keymap,
} from './keymap';
import {
  DEFAULT_KEY_BINDINGS,
  MOVE_ACTION_DIRECTIONS,
  NOOP_REPORTER,
  createSafeInputReporter,
  describeAction,
  describeBinding,
  directionForAction,
  isMoveAction,
  listBindings,
} from './keymap';
import type { PointerEventFamily } from './touch-input';
import { detectPointerEventFamily } from './touch-input';
import type { InputEmitter, InputModality } from './input-manager';

/* ==========================================================================
 * 1. Report names
 * ========================================================================== */

/** Counter raised once per completed mount, carrying the control count. */
const MOUNTED_METRIC = 'input.onScreen.mounted';

/** Counter raised once per unmount. */
const UNMOUNTED_METRIC = 'input.onScreen.unmounted';

/** Counter raised when the mount host cannot be resolved. */
const HOST_MISSING_METRIC = 'input.onScreen.host.missing';

/** Counter raised when a control's selector resolves to nothing. */
const CONTROL_MISSING_METRIC = 'input.onScreen.control.missing';

/** Counter raised when a selector is not one the engine can parse. */
const SELECTOR_INVALID_METRIC = 'input.onScreen.selector.invalid';

/** Counter raised once per control whose semantics had to be repaired. */
const REMEDIATED_METRIC = 'input.onScreen.control.remediated';

/** Counter raised once per action published from this layer. */
const ACTION_METRIC = 'input.onScreen.action';

/** Counter raised when an unavailable control was nonetheless activated. */
const UNAVAILABLE_METRIC = 'input.onScreen.rejected.unavailable';

/** Counter raised when an activation handler threw. */
const HANDLER_ERROR_METRIC = 'input.onScreen.handler.error';

/** Counter raised once per context change applied to the controls. */
const CONTEXT_METRIC = 'input.onScreen.context.changed';

/** Counter raised once per keymap change applied to the controls. */
const KEYMAP_METRIC = 'input.onScreen.keymap.applied';

/** Counter carrying the resolved reduced-motion preference. */
const REDUCED_MOTION_METRIC = 'input.onScreen.reducedMotion';

/** Counter raised when an `indexes` entry names an unsupported action. */
const INDEX_REJECTED_METRIC = 'input.onScreen.index.rejected';

/** Counter raised when a listener could not be bound. */
const BIND_FAILED_METRIC = 'input.onScreen.bind.failed';

/** Span covering one activation, from the event to the published action. */
const ACTIVATE_SPAN = 'input.onScreen.activate';

/** Span covering one mount. */
const MOUNT_SPAN = 'input.onScreen.mount';

/** `errorName` reported for a caught value that carries none. */
const UNKNOWN_ERROR_NAME = 'OnScreenControlsError';

/** `errorMessage` reported for a caught value that carries none. */
const UNKNOWN_ERROR_MESSAGE = 'Unknown on-screen control error.';

/* ==========================================================================
 * 2. Contract
 * ========================================================================== */

/** Removes the listeners one `bindButtonPress` call added. */
export type UnbindControl = () => void;

/** Removes every listener and every element one mount added. */
export type UnmountOnScreenControls = () => void;

/** What `bindButtonPress` binds, and what it reports through. */
export interface BindButtonPressOptions {
  /**
   * Node a selector is resolved against. Defaults to `ownerDocument`, and
   * then to the ambient `document`.
   */
  readonly root?: ParentNode;

  /**
   * Document a selector is resolved against when no `root` is given.
   * Defaults to the ambient `document`.
   */
  readonly ownerDocument?: Document;

  /** Sink for the counters and logs raised. Defaults to `NOOP_REPORTER`. */
  readonly reporter?: InputReporter;

  /**
   * Pointer event family whose touch-end name is bound. Defaults to the
   * result of `detectPointerEventFamily()`.
   */
  readonly family?: PointerEventFamily;

  /**
   * Action the binding serves. Reported alongside the selector, so a failed
   * lookup names both.
   */
  readonly action?: string;

  /**
   * Name reported for the target in place of the derived one. A caller that
   * resolved the element itself passes the selector it resolved it by, so a
   * report still names that selector.
   */
  readonly reportedAs?: string;

  /**
   * Whether the resolved touch-end event is bound alongside `'click'`.
   * Defaults to `true`, which is the pair js/keyboard_input_manager.js
   * L142-L143 bound.
   */
  readonly bindTouchEnd?: boolean;
}

/**
 * The members of src/input/input-manager.ts this layer invokes.
 *
 * `InputManager` satisfies it. The three members js/keyboard_input_manager.js
 * L72-L74 handed to `bindButtonPress` are `restart` and `keepPlaying`; a
 * direction control publishes through `emitMove`, and every remaining action
 * through `emit`, so the cancel-then-publish ordering ported from L130-L138
 * stays in one place.
 */
export interface OnScreenControlHost extends InputEmitter {
  /**
   * Publishes `'restart'`, cancelling the event's default action first.
   *
   * @param event Event to cancel the default action of.
   */
  restart(event?: Event): void;

  /**
   * Publishes `'keepPlaying'`, cancelling the event's default action first.
   *
   * @param event Event to cancel the default action of.
   */
  keepPlaying(event?: Event): void;

  /**
   * Publishes `'move'` carrying the bare numeric direction.
   *
   * @param direction Direction to publish.
   * @param modality How the move arrived.
   * @returns How many callbacks were invoked.
   */
  emitMove(direction: Direction, modality?: InputModality): number;

  /**
   * The table accessible names are derived from, when the caller names none.
   *
   * @returns The active table.
   */
  getKeymap?(): Keymap;

  /**
   * The context control availability is derived from, when the caller names
   * none.
   *
   * @returns The active context.
   */
  context?(): InputContext;
}

/** One control the markup declares, and the action it publishes. */
export interface MarkupControlBinding {
  /** Selector the control is looked up by. */
  readonly selector: string;

  /** Action a pointer activation on it publishes. */
  readonly action: InputAction;
}

/** One control this layer owns, generated or promoted. */
export interface OnScreenControl {
  /** Action the control publishes. */
  readonly action: InputAction;

  /** Index the action's payload carries. `0` for a payload-free action. */
  readonly index: number;

  /** The bound element. */
  readonly element: Element;

  /** Whether the element was created here rather than declared in markup. */
  readonly generated: boolean;
}

/** Construction parameters. Only `host` is required. */
export interface OnScreenControlsOptions {
  /** Manager the controls publish through. */
  readonly host: OnScreenControlHost;

  /**
   * Element the generated controls are appended to, or a selector to look one
   * up by. Defaults to `DEFAULT_ON_SCREEN_HOST_SELECTOR`.
   */
  readonly mount?: Element | string;

  /**
   * Document every selector is resolved against, and every generated element
   * created by. Defaults to the mount element's own document, and then to the
   * ambient `document`.
   */
  readonly ownerDocument?: Document;

  /**
   * Sink for the counters, logs and spans raised. Defaults to
   * `NOOP_REPORTER`.
   */
  readonly reporter?: InputReporter;

  /**
   * Pointer event family the ported binding uses. Defaults to the result of
   * `detectPointerEventFamily()`.
   */
  readonly family?: PointerEventFamily;

  /**
   * Table accessible names are derived from. A function is consulted on every
   * refresh. Omitted, the table is read from `host.getKeymap()`, and then from
   * `DEFAULT_KEY_BINDINGS`.
   */
  readonly keymap?: Keymap | (() => Keymap);

  /**
   * Context control availability is derived from. A function is consulted on
   * every refresh. Omitted, the context is read from `host.context()`, and
   * then defaults to `'game'`.
   */
  readonly context?: InputContext | (() => InputContext);

  /**
   * Window the reduced-motion preference is read from. Defaults to the
   * document's own view, and then to the ambient `window`.
   */
  readonly view?: Window;

  /**
   * Payload indices to generate a control for, per action. Honoured for the
   * two actions whose payload carries an index, `'selectReward'` and
   * `'activateRelic'`; an entry for any other action is reported and ignored.
   * Defaults to one control carrying index `0`.
   */
  readonly indexes?: Readonly<Partial<Record<InputAction, readonly number[]>>>;

  /**
   * Controls the markup declares, bound before the generated ones and each
   * promoted where the markup leaves it unfocusable or unnamed. Defaults to
   * `LEGACY_CONTROL_BINDINGS`, the three of js/keyboard_input_manager.js
   * L72-L74. A caller that declares a further control in markup — the
   * `.settings-button` of index.html L37, say — passes an extended list here
   * rather than binding the element itself.
   */
  readonly markupControls?: readonly MarkupControlBinding[];
}

/** What one mount returns. */
export interface OnScreenControlsHandle {
  /** The element the generated controls were appended to, or `null`. */
  readonly root: Element | null;

  /** Every control bound, generated and promoted, in creation order. */
  readonly controls: readonly OnScreenControl[];

  /** How many controls had their semantics repaired. */
  readonly remediated: number;

  /**
   * Replaces the context control availability is derived from, and reapplies
   * it. A control whose action is inactive in the new context leaves both the
   * accessibility tree and the tab order.
   *
   * @param context Context to derive availability from.
   */
  setContext(context: InputContext): void;

  /**
   * Replaces the table accessible names are derived from, and reapplies them,
   * so a name states the key currently bound rather than the default.
   *
   * @param keymap Table to derive names from.
   */
  setKeymap(keymap: Keymap): void;

  /**
   * Re-reads the keymap, the context and the reduced-motion preference from
   * their configured sources and reapplies all three.
   */
  refresh(): void;

  /** Removes every listener and every generated element. */
  readonly unmount: UnmountOnScreenControls;
}

/* ==========================================================================
 * 3. Markup vocabulary
 * ========================================================================== */

/** Selector the generated controls are appended inside by default. */
export const DEFAULT_ON_SCREEN_HOST_SELECTOR = '#on-screen-controls';

/**
 * The three controls index.html declares, and the action each publishes.
 *
 * Ported from js/keyboard_input_manager.js L72-L74, in the order those three
 * lines bound them: `.retry-button` and `.restart-button` both publish
 * `restart`, and `.keep-playing-button` publishes `keepPlaying`.
 */
export const LEGACY_CONTROL_BINDINGS: readonly MarkupControlBinding[] =
  Object.freeze([
    Object.freeze({ selector: '.retry-button', action: 'restart' as const }),
    Object.freeze({ selector: '.restart-button', action: 'restart' as const }),
    Object.freeze({
      selector: '.keep-playing-button',
      action: 'keepPlaying' as const,
    }),
  ]);

/**
 * The two actions whose payload carries an index, and which therefore accept
 * more than one control.
 */
const INDEXED_ACTIONS: ReadonlySet<InputAction> = new Set<InputAction>([
  'selectReward',
  'activateRelic',
]);

/** Largest number of controls one action may be given. */
const MAX_CONTROLS_PER_ACTION = 8;

/** Index generated for an action the caller named no index for. */
const DEFAULT_CONTROL_INDEX = 0;

/**
 * Class every control carries, generated or promoted. The style layer owns its
 * declarations; no length, colour or duration is written here.
 */
const CONTROL_CLASS = 'on-screen-control';

/**
 * The established button vocabulary, declared by `@mixin screen-control` in
 * style/_screens.scss over the tokens of style/_tokens.scss. Carried alongside
 * `CONTROL_CLASS` so a generated control is presented as every other control
 * in the interface is.
 */
const CONTROL_VOCABULARY_CLASS = 'screen-button';

/** Class each generated group carries. */
const GROUP_CLASS = 'on-screen-controls-group';

/** Class the four direction controls' group carries. */
const PAD_GROUP_CLASS = 'on-screen-controls-pad';

/** Class the remaining controls' group carries. */
const ACTION_GROUP_CLASS = 'on-screen-controls-actions';

/**
 * Class the mount root carries only while motion is permitted. It is the sole
 * carrier of this layer's transitions, so under
 * `(prefers-reduced-motion: reduce)` the layer triggers none.
 */
const MOTION_CLASS = 'on-screen-controls-animated';

/** Attribute the mount root carries the resolved motion preference in. */
const REDUCED_MOTION_ATTRIBUTE = 'data-reduced-motion';

/** Attribute a control carries its action in. */
const ACTION_ATTRIBUTE = 'data-action';

/** Attribute a control carries its payload index in. */
const INDEX_ATTRIBUTE = 'data-index';

/** Attribute a direction control carries its bare numeric direction in. */
const DIRECTION_ATTRIBUTE = 'data-direction';

/** Media query the reduced-motion preference is read from. */
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Accessible name of the group holding the four direction controls. */
const PAD_GROUP_LABEL = 'Move tiles';

/** Accessible name of the group holding every remaining control. */
const ACTION_GROUP_LABEL = 'Game actions';

/** Modality every activation from this layer is counted under. */
const ON_SCREEN_MODALITY: InputModality = 'onScreen';

/** Tag names that are focusable and activation-capable without repair. */
const NATIVE_CONTROL_TAGS: ReadonlySet<string> = new Set([
  'BUTTON',
  'INPUT',
  'SELECT',
  'TEXTAREA',
]);

/** `KeyboardEvent.key` values that activate a promoted control. */
const ACTIVATION_KEYS: ReadonlySet<string> = new Set([
  'Enter',
  ' ',
  'Spacebar',
]);

/** The unbind handle a failed bind returns. It removes nothing. */
const NOOP_UNBIND: UnbindControl = () => {
  return;
};

/* ==========================================================================
 * 4. Reporting helpers
 * ========================================================================== */

/**
 * Reduces a caught value to two reportable fields.
 *
 * @param caught Value that was thrown.
 * @returns `errorName` and `errorMessage`, always populated.
 */
function describeError(caught: unknown): InputReportFields {
  if (caught instanceof Error) {
    return { errorName: caught.name, errorMessage: caught.message };
  }

  const printable =
    typeof caught === 'string' ||
    typeof caught === 'number' ||
    typeof caught === 'boolean'
      ? String(caught)
      : UNKNOWN_ERROR_MESSAGE;

  return { errorName: UNKNOWN_ERROR_NAME, errorMessage: printable };
}

/** The span returned when the injected sink opens none. */
const NOOP_SPAN: InputSpan = Object.freeze({
  end(): void {
    return;
  },
});

/**
 * Opens a span through a sink that may implement none.
 *
 * @param reporter Sink to open the span through. It is already contained by
 *   `createSafeInputReporter`, so neither `startSpan` nor the returned span's
 *   `end` can throw into the caller.
 * @param name Span name.
 * @returns The open span, or a span whose `end` does nothing.
 */
function openSpan(reporter: InputReporter, name: string): InputSpan {
  const open = reporter.startSpan;

  return open === undefined ? NOOP_SPAN : open.call(reporter, name);
}

/* ==========================================================================
 * 5. DOM resolution
 * ========================================================================== */

/**
 * Reads the ambient `document`.
 *
 * @returns The document, or `null` outside a browser.
 */
function readAmbientDocument(): Document | null {
  return typeof document === 'undefined' ? null : document;
}

/**
 * Reads the ambient `window`.
 *
 * @returns The window, or `null` outside a browser.
 */
function readAmbientWindow(): Window | null {
  return typeof window === 'undefined' ? null : window;
}

/**
 * Resolves the node a selector is looked up against.
 *
 * @param options Options passed to `bindButtonPress`.
 * @returns The root, or `null` when there is none to resolve.
 */
function resolveLookupRoot(options: BindButtonPressOptions): ParentNode | null {
  return options.root ?? options.ownerDocument ?? readAmbientDocument();
}

/**
 * Resolves an element from an element or a selector.
 *
 * This is the guarded form of the lookup at js/keyboard_input_manager.js
 * L141, which dereferenced its result at L142 without checking it.
 *
 * @param target Element to use as given, or a selector to look one up by.
 * @param root Node a selector is resolved against.
 * @param reporter Sink for a selector the engine cannot parse.
 * @returns The element, or `null` when the selector matches nothing, the root
 *   is absent, or the selector is not a valid one.
 */
function resolveElement(
  target: Element | string,
  root: ParentNode | null,
  reporter: InputReporter,
): Element | null {
  if (typeof target !== 'string') {
    return target;
  }

  if (root === null) {
    return null;
  }

  try {
    return root.querySelector(target);
  } catch (caught: unknown) {
    // An invalid selector makes `querySelector` throw rather than return null.
    // The throw is reported here and reduced to `null`; the caller reports the
    // absence of the control it was resolving.
    const fields: InputReportFields = {
      selector: target,
      ...describeError(caught),
    };

    reporter.log(
      'error',
      'An on-screen control selector is not valid.',
      fields,
    );
    reporter.count(SELECTOR_INVALID_METRIC, fields);

    return null;
  }
}

/**
 * Names a target for a report.
 *
 * @param target Element or selector that was resolved.
 * @returns The selector as given, or the element's tag name in lower case.
 */
function describeTarget(target: Element | string): string {
  return typeof target === 'string' ? target : target.tagName.toLowerCase();
}

/**
 * Names a generated control for a report, as the selector that addresses it.
 *
 * @param action Action the control publishes.
 * @param index Payload index the control carries.
 * @returns A selector naming exactly that control.
 */
function describeGenerated(action: InputAction, index: number): string {
  return (
    `.${CONTROL_CLASS}[${ACTION_ATTRIBUTE}="${action}"]` +
    `[${INDEX_ATTRIBUTE}="${index}"]`
  );
}

/* ==========================================================================
 * 6. Accessible names and focusability
 * ========================================================================== */

/**
 * Trims a value that may be absent.
 *
 * @param value Value read off an element.
 * @returns The trimmed text, or the empty string.
 */
function trimmed(value: string | null): string {
  return value === null ? '' : value.trim();
}

/**
 * Resolves the text an `aria-labelledby` list refers to.
 *
 * @param element Element carrying the attribute.
 * @returns The referenced text, or the empty string when the attribute is
 *   absent or refers to nothing that carries text.
 */
function labelledByText(element: Element): string {
  const ids = trimmed(element.getAttribute('aria-labelledby'));

  if (ids.length === 0) {
    return '';
  }

  const owner = element.ownerDocument;

  if (owner === null) {
    return '';
  }

  const parts: string[] = [];

  for (const id of ids.split(/\s+/)) {
    if (id.length === 0) {
      continue;
    }

    const referenced = owner.getElementById(id);
    const text = referenced === null ? '' : trimmed(referenced.textContent);

    if (text.length > 0) {
      parts.push(text);
    }
  }

  return parts.join(' ');
}

/**
 * Computes the accessible name of a control, in the order the accessible-name
 * computation resolves one: `aria-labelledby`, then `aria-label`, then the
 * element's own text, then `title`.
 *
 * @param element Element to name.
 * @returns The name, or the empty string when the element carries none.
 */
export function accessibleNameOf(element: Element): string {
  const referenced = labelledByText(element);

  if (referenced.length > 0) {
    return referenced;
  }

  const label = trimmed(element.getAttribute('aria-label'));

  if (label.length > 0) {
    return label;
  }

  const text = trimmed(element.textContent);

  if (text.length > 0) {
    return text;
  }

  return trimmed(element.getAttribute('title'));
}

/**
 * Reports whether an element is already in the tab order.
 *
 * @param element Element to test.
 * @returns `true` when the element is reachable by Tab as it stands.
 */
function isInTabOrder(element: Element): boolean {
  const declared = element.getAttribute('tabindex');

  if (declared !== null) {
    const parsed = Number.parseInt(declared, 10);

    return Number.isFinite(parsed) && parsed >= 0;
  }

  if (NATIVE_CONTROL_TAGS.has(element.tagName)) {
    return true;
  }

  // The defect being repaired: index.html declared all three controls as bare
  // `<a>` elements with no `href`, which no engine puts in the tab order.
  return element.tagName === 'A' && element.hasAttribute('href');
}

/**
 * Reports whether an element already activates on Enter and Space without a
 * listener of this layer's own.
 *
 * @param element Element to test.
 * @returns `true` when the engine synthesises a click from both keys.
 */
function activatesFromKeyboard(element: Element): boolean {
  if (NATIVE_CONTROL_TAGS.has(element.tagName)) {
    return true;
  }

  return element.tagName === 'A' && element.hasAttribute('href');
}

/**
 * Reports whether an element carries a role that names it a control.
 *
 * @param element Element to test.
 * @returns `true` when a role is unnecessary or already correct.
 */
function hasControlRole(element: Element): boolean {
  if (NATIVE_CONTROL_TAGS.has(element.tagName)) {
    return true;
  }

  const role = trimmed(element.getAttribute('role'));

  return role.length > 0;
}

/* ==========================================================================
 * 7. The ported binding
 * ========================================================================== */

/**
 * Binds one handler to a control's pointer activation.
 *
 * Ported from js/keyboard_input_manager.js L140-L144. The lookup at L141 is
 * null-checked here; `'click'` at L142 and the resolved touch-end name at L143
 * are both bound, so a tap can dispatch the handler twice.
 *
 * @param target Element to bind, or a selector to look one up by.
 * @param handler Called with the dispatched event.
 * @param options Lookup root, document, sink, pointer family, reported action
 *   name, and whether the touch-end name is bound.
 * @returns A handle removing every listener added. An unresolved target is
 *   reported and yields a handle that removes nothing; nothing throws, and a
 *   second call of the handle is harmless.
 *
 * @example
 * ```ts
 * const unbind = bindButtonPress('.restart-button', (event) => {
 *   manager.restart(event);
 * });
 * ```
 */
export function bindButtonPress(
  target: Element | string,
  handler: (event: Event) => void,
  options: BindButtonPressOptions = {},
): UnbindControl {
  const reporter = createSafeInputReporter(
    options.reporter ?? NOOP_REPORTER,
  );
  const selector = options.reportedAs ?? describeTarget(target);
  const action = options.action ?? '';
  const element = resolveElement(
    target,
    resolveLookupRoot(options),
    reporter,
  );

  if (element === null) {
    const fields: InputReportFields = { selector, action };

    reporter.log('warn', 'An on-screen control is absent.', fields);
    reporter.count(CONTROL_MISSING_METRIC, fields);

    return NOOP_UNBIND;
  }

  const family = options.family ?? detectPointerEventFamily();
  const bindTouchEnd = options.bindTouchEnd !== false;

  // A throwing handler is reported and contained: an activation cannot leave
  // an exception in the dispatch of the event that carried it.
  const guarded = (event: Event): void => {
    try {
      handler(event);
    } catch (caught: unknown) {
      const fields: InputReportFields = {
        selector,
        action,
        eventType: event.type,
        ...describeError(caught),
      };

      reporter.log('error', 'An on-screen control handler threw.', fields);
      reporter.count(HANDLER_ERROR_METRIC, fields);
    }
  };

  const bound: string[] = [];

  // L142, then L143. Both names carry the same handler.
  const names = bindTouchEnd ? ['click', family.touchend] : ['click'];

  for (const name of names) {
    try {
      element.addEventListener(name, guarded);
      bound.push(name);
    } catch (caught: unknown) {
      const fields: InputReportFields = {
        selector,
        action,
        eventName: name,
        ...describeError(caught),
      };

      reporter.log('error', 'An on-screen control could not be bound.', fields);
      reporter.count(BIND_FAILED_METRIC, fields);
    }
  }

  let removed = false;

  return (): void => {
    if (removed) {
      return;
    }

    removed = true;

    for (const name of bound) {
      element.removeEventListener(name, guarded);
    }
  };
}

/* ==========================================================================
 * 8. Publishing an action
 * ========================================================================== */

/**
 * Publishes the event one action resolves to.
 *
 * A movement action publishes `'move'` carrying the bare numeric direction,
 * which is the encoding of the table at js/keyboard_input_manager.js L37-L50,
 * so a control, a keypress and a swipe carry identical payloads. `restart` and
 * `keepPlaying` go through the manager's own members, which is what L72-L74
 * handed to `bindButtonPress`.
 *
 * @param host Manager to publish through.
 * @param action Action the activated control carries.
 * @param index Payload index the control carries.
 * @param event Event that activated the control.
 */
function publishControlAction(
  host: OnScreenControlHost,
  action: InputAction,
  index: number,
  event: Event,
): void {
  if (isMoveAction(action)) {
    host.emitMove(MOVE_ACTION_DIRECTIONS[action], ON_SCREEN_MODALITY);

    return;
  }

  switch (action) {
    // L72-L74.
    case 'restart':
      host.restart(event);

      return;
    case 'keepPlaying':
      host.keepPlaying(event);

      return;
    case 'startRun':
      host.emit('startRun', undefined);

      return;
    case 'selectReward':
      host.emit('selectReward', index);

      return;
    case 'activateRelic':
      host.emit('activateRelic', index);

      return;
    case 'continueStage':
      host.emit('continueStage', undefined);

      return;
    case 'endRun':
      host.emit('endRun', undefined);

      return;
    case 'openSettings':
      host.emit('openSettings', undefined);

      return;
    case 'closeSettings':
      host.emit('closeSettings', undefined);

      return;
    case 'cancel':
      host.emit('cancel', undefined);

      return;
  }
}

/* ==========================================================================
 * 9. Control records
 * ========================================================================== */

/** One bound control and the state the layer keeps for it. */
interface ControlRecord {
  /** Action the control publishes. */
  readonly action: InputAction;

  /** Payload index the control carries. */
  readonly index: number;

  /**
   * Position of this control among those of the same action, one-based, or `0`
   * when the action has a single control. Appended to the label when nonzero.
   */
  readonly ordinal: number;

  /** The bound element. */
  readonly element: Element;

  /** Whether this layer created the element. */
  readonly generated: boolean;

  /** Whether the action is active in the context last applied. */
  available: boolean;
}

/**
 * Projects a record onto the public shape.
 *
 * @param record Record to project.
 * @returns The frozen projection.
 */
function projectControl(record: ControlRecord): OnScreenControl {
  return Object.freeze({
    action: record.action,
    index: record.index,
    element: record.element,
    generated: record.generated,
  });
}

/**
 * Reports whether a binding is active in a context.
 *
 * @param binding Binding to test.
 * @param context Context to test against.
 * @returns `true` when the binding lists the context.
 */
function isActiveIn(binding: InputBinding, context: InputContext): boolean {
  for (const candidate of binding.contexts) {
    if (candidate === context) {
      return true;
    }
  }

  return false;
}

/**
 * Reports whether an action has any key bound.
 *
 * @param binding Binding to test.
 * @returns `true` when either list carries an entry.
 */
function hasKey(binding: InputBinding): boolean {
  return binding.keys.length > 0 || binding.codes.length > 0;
}

/**
 * Builds the visible label of a control.
 *
 * @param action Action the control publishes.
 * @param ordinal One-based position among the action's controls, or `0`.
 * @returns The label, with the ordinal appended when there is one.
 */
function labelFor(action: InputAction, ordinal: number): string {
  const label = describeAction(action);

  return ordinal > 0 ? `${label} ${ordinal}` : label;
}

/**
 * Builds the accessible name of a control from the table in force, so a
 * remapped key is announced rather than the default it replaced.
 *
 * @param keymap Table to read the bound keys from.
 * @param action Action the control publishes.
 * @param ordinal One-based position among the action's controls, or `0`.
 * @returns The name. The key phrase is appended only for an action that has a
 *   key bound; an action reached from its control alone is named by its label.
 */
function nameFor(
  keymap: Keymap,
  action: InputAction,
  ordinal: number,
): string {
  const label = labelFor(action, ordinal);

  return hasKey(keymap[action])
    ? `${label}, ${describeBinding(keymap, action)}`
    : label;
}

/* ==========================================================================
 * 10. Element construction and state
 * ========================================================================== */

/** The one member the promoted-control activation handler reads. */
interface ActivationKeyEventLike extends Event {
  /** `KeyboardEvent.key`. Absent from an event that carries none. */
  readonly key?: string;
}

/**
 * Writes the label, the accessible name and the shortcut tooltip of a
 * generated control.
 *
 * @param element Element to write to.
 * @param keymap Table names are derived from.
 * @param action Action the control publishes.
 * @param ordinal One-based position among the action's controls, or `0`.
 */
function applyGeneratedName(
  element: Element,
  keymap: Keymap,
  action: InputAction,
  ordinal: number,
): void {
  element.textContent = labelFor(action, ordinal);
  element.setAttribute('aria-label', nameFor(keymap, action, ordinal));

  if (hasKey(keymap[action])) {
    element.setAttribute('title', describeBinding(keymap, action));

    return;
  }

  element.removeAttribute('title');
}

/**
 * Creates one control.
 *
 * The element is a native `<button>`, so it is in the tab order and activates
 * on Enter and Space without a listener of this layer's own. Only class names
 * and data attributes are written: every colour, length, radius and duration
 * is declared in the stylesheet partials.
 *
 * @param ownerDocument Document the element is created by.
 * @param keymap Table the accessible name is derived from.
 * @param action Action the control publishes.
 * @param index Payload index the control carries.
 * @param ordinal One-based position among the action's controls, or `0`.
 * @returns The created control.
 */
function createControl(
  ownerDocument: Document,
  keymap: Keymap,
  action: InputAction,
  index: number,
  ordinal: number,
): HTMLButtonElement {
  const element = ownerDocument.createElement('button');

  element.type = 'button';
  element.classList.add(CONTROL_CLASS, CONTROL_VOCABULARY_CLASS);
  element.setAttribute(ACTION_ATTRIBUTE, action);
  element.setAttribute(INDEX_ATTRIBUTE, String(index));

  const direction = directionForAction(action);

  if (direction !== null) {
    element.setAttribute(DIRECTION_ATTRIBUTE, String(direction));
  }

  applyGeneratedName(element, keymap, action, ordinal);

  return element;
}

/**
 * Creates one control group.
 *
 * @param ownerDocument Document the element is created by.
 * @param variantClass Class naming which group this is.
 * @param label Accessible name of the group.
 * @returns The created group.
 */
function createGroup(
  ownerDocument: Document,
  variantClass: string,
  label: string,
): HTMLDivElement {
  const group = ownerDocument.createElement('div');

  group.classList.add(GROUP_CLASS, variantClass);
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', label);

  return group;
}

/**
 * Applies availability to one generated control.
 *
 * An unavailable control leaves the accessibility tree through `hidden` and
 * `aria-hidden`, and leaves the tab order through `tabindex` and `disabled`,
 * so it is neither announced nor reachable rather than merely invisible.
 *
 * @param element Element to apply to.
 * @param available Whether the action is active in the current context.
 */
function applyAvailability(element: Element, available: boolean): void {
  if (available) {
    element.removeAttribute('hidden');
    element.removeAttribute('aria-hidden');
    element.removeAttribute('disabled');
    element.setAttribute('tabindex', '0');

    return;
  }

  element.setAttribute('hidden', '');
  element.setAttribute('aria-hidden', 'true');
  element.setAttribute('disabled', '');
  element.setAttribute('tabindex', '-1');
}

/**
 * Applies availability to one group, so a group whose every control is
 * unavailable is itself out of the accessibility tree.
 *
 * @param group Group to apply to, or `null` when none was created.
 * @param available Whether any control of the group is available.
 */
function applyGroupAvailability(
  group: Element | null,
  available: boolean,
): void {
  if (group === null) {
    return;
  }

  if (available) {
    group.removeAttribute('hidden');
    group.removeAttribute('aria-hidden');

    return;
  }

  group.setAttribute('hidden', '');
  group.setAttribute('aria-hidden', 'true');
}

/**
 * Resolves the media query the reduced-motion preference is read from.
 *
 * @param view Window to read from, or `null` outside a browser.
 * @param reporter Sink for a failed probe.
 * @returns The query, or `null` when the view implements none.
 */
function resolveMotionQuery(
  view: Window | null,
  reporter: InputReporter,
): MediaQueryList | null {
  if (view === null || typeof view.matchMedia !== 'function') {
    return null;
  }

  try {
    return view.matchMedia(REDUCED_MOTION_QUERY);
  } catch (caught: unknown) {
    reporter.log(
      'warn',
      'The reduced-motion preference could not be read.',
      { query: REDUCED_MOTION_QUERY, ...describeError(caught) },
    );

    return null;
  }
}

/**
 * Reflects the reduced-motion preference onto the mount root.
 *
 * `MOTION_CLASS` is the only carrier of this layer's transitions, and it is
 * absent while the preference is `reduce`, so no transition this layer
 * triggers survives the preference.
 *
 * @param root Mount root, or `null` when none was resolved.
 * @param reduce Whether the user asked for reduced motion.
 */
function applyMotionPreference(root: Element | null, reduce: boolean): void {
  if (root === null) {
    return;
  }

  root.setAttribute(REDUCED_MOTION_ATTRIBUTE, reduce ? 'true' : 'false');

  if (reduce) {
    root.classList.remove(MOTION_CLASS);

    return;
  }

  root.classList.add(MOTION_CLASS);
}

/**
 * Resolves the payload indices one action gets a control for.
 *
 * @param action Action being generated.
 * @param requested Indices the caller asked for, where it asked.
 * @param reporter Sink for a rejected request.
 * @returns The indices, always at least one, each a non-negative integer, in
 *   the order requested and without repetition.
 */
function resolveIndices(
  action: InputAction,
  requested: readonly number[] | undefined,
  reporter: InputReporter,
): readonly number[] {
  if (requested === undefined) {
    return [DEFAULT_CONTROL_INDEX];
  }

  if (!INDEXED_ACTIONS.has(action)) {
    const fields: InputReportFields = {
      action,
      reason: 'payloadCarriesNoIndex',
    };

    reporter.log('warn', 'An index request names an unindexed action.', fields);
    reporter.count(INDEX_REJECTED_METRIC, fields);

    return [DEFAULT_CONTROL_INDEX];
  }

  const accepted: number[] = [];

  for (const candidate of requested) {
    const valid =
      Number.isSafeInteger(candidate) &&
      candidate >= 0 &&
      !accepted.includes(candidate);

    if (!valid) {
      const fields: InputReportFields = {
        action,
        index: String(candidate),
        reason: 'notANonNegativeIntegerOrRepeated',
      };

      reporter.log('warn', 'An index request was rejected.', fields);
      reporter.count(INDEX_REJECTED_METRIC, fields);

      continue;
    }

    if (accepted.length === MAX_CONTROLS_PER_ACTION) {
      const fields: InputReportFields = {
        action,
        index: String(candidate),
        reason: 'controlLimitReached',
        limit: MAX_CONTROLS_PER_ACTION,
      };

      reporter.log('warn', 'An index request was rejected.', fields);
      reporter.count(INDEX_REJECTED_METRIC, fields);

      continue;
    }

    accepted.push(candidate);
  }

  return accepted.length > 0 ? accepted : [DEFAULT_CONTROL_INDEX];
}

/* ==========================================================================
 * 11. Promoting a control the markup declares
 * ========================================================================== */

/** What one promotion repaired, and how to undo it. */
interface Promotion {
  /** Whether anything had to be repaired. */
  readonly remediated: boolean;

  /** Undoes every repair, leaving the element as the markup declared it. */
  readonly revert: () => void;
}

/** A promotion that repaired nothing. */
const NO_PROMOTION: Promotion = Object.freeze({
  remediated: false,
  revert: (): void => {
    return;
  },
});

/**
 * Makes a control the markup declares a real focusable control with an
 * accessible name, repairing only what is missing.
 *
 * index.html is the authority and declares all three controls as native
 * `<button>` elements, for which this repairs nothing. It repaired four things
 * for the bare `<a>` elements with no `href` that index.html L31, L38 and L39
 * declared before this feature: a control role, a tab stop, activation from
 * Enter and Space, and an accessible name.
 *
 * The visible label is never written and never removed: it is the accessible
 * name whenever the markup carries one.
 *
 * @param element Element to promote.
 * @param action Action the control publishes.
 * @param selector Selector it was resolved by, for reporting.
 * @param keymap Table a substituted accessible name is derived from.
 * @param handler Called by the keyboard activation this may install.
 * @param reporter Sink for the repairs performed.
 * @returns What was repaired, and how to undo it.
 */
function promoteControl(
  element: Element,
  action: InputAction,
  selector: string,
  keymap: Keymap,
  handler: (event: Event) => void,
  reporter: InputReporter,
): Promotion {
  const repairs: string[] = [];
  const steps: (() => void)[] = [];

  if (!hasControlRole(element)) {
    element.setAttribute('role', 'button');
    repairs.push('role');
    steps.push((): void => {
      element.removeAttribute('role');
    });
  }

  if (!isInTabOrder(element)) {
    const declared = element.getAttribute('tabindex');

    element.setAttribute('tabindex', '0');
    repairs.push('tabStop');
    steps.push((): void => {
      if (declared === null) {
        element.removeAttribute('tabindex');

        return;
      }

      element.setAttribute('tabindex', declared);
    });
  }

  // Installed only where the engine synthesises no click from a keypress, so a
  // native control is never activated twice by one key.
  if (!activatesFromKeyboard(element)) {
    const onKeyDown = (event: Event): void => {
      const keyEvent: ActivationKeyEventLike = event;
      const key = typeof keyEvent.key === 'string' ? keyEvent.key : '';

      if (!ACTIVATION_KEYS.has(key)) {
        return;
      }

      // Space would otherwise scroll the page.
      event.preventDefault();
      handler(event);
    };

    element.addEventListener('keydown', onKeyDown);
    repairs.push('keyboardActivation');
    steps.push((): void => {
      element.removeEventListener('keydown', onKeyDown);
    });
  }

  if (accessibleNameOf(element).length === 0) {
    element.setAttribute('aria-label', nameFor(keymap, action, 0));
    repairs.push('accessibleName');
    steps.push((): void => {
      element.removeAttribute('aria-label');
    });
  }

  if (repairs.length === 0) {
    return NO_PROMOTION;
  }

  const fields: InputReportFields = {
    selector,
    action,
    repairs: repairs.join(', '),
  };

  reporter.log('info', 'An on-screen control was promoted.', fields);
  reporter.count(REMEDIATED_METRIC, fields);

  return Object.freeze({
    remediated: true,
    revert: (): void => {
      for (const step of steps) {
        step();
      }
    },
  });
}

/* ==========================================================================
 * 12. Mounting
 * ========================================================================== */

/**
 * Reads a value that may be supplied directly or produced on demand.
 *
 * @param source Value, or a function producing one.
 * @param fallback Called when the source is absent, and when it throws.
 * @param reporter Sink for a source that throws.
 * @param name Name of the source, for reporting.
 * @returns The resolved value.
 */
function readSource<T>(
  source: T | (() => T) | undefined,
  fallback: () => T,
  reporter: InputReporter,
  name: string,
): T {
  if (source === undefined) {
    return fallback();
  }

  if (typeof source !== 'function') {
    return source;
  }

  // A supplied resolver belongs to the caller: a throw from it is reported and
  // the fallback answers.
  try {
    return (source as () => T)();
  } catch (caught: unknown) {
    reporter.log('error', 'An on-screen control source threw.', {
      source: name,
      ...describeError(caught),
    });

    return fallback();
  }
}

/**
 * Mounts one focusable, tappable control per bindable action, and binds the
 * controls index.html declares.
 *
 * Nothing here throws: an absent mount root, an absent control and a source
 * that throws are each reported and skipped, and the returned handle is always
 * callable. This is the guarded successor of js/keyboard_input_manager.js
 * L71-L74, where an absent element was a startup failure.
 *
 * @param options Manager, mount root, document, sink, pointer family, keymap,
 *   context, window, payload indices and the controls the markup declares.
 * @returns The mounted handle.
 *
 * @example
 * ```ts
 * const manager = createInputManager({ ownerDocument: document });
 * const controls = mountOnScreenControls({ host: manager, reporter });
 *
 * controls.setContext('overlay');
 * controls.unmount();
 * ```
 */
export function mountOnScreenControls(
  options: OnScreenControlsOptions,
): OnScreenControlsHandle {
  const reporter = createSafeInputReporter(
    options.reporter ?? NOOP_REPORTER,
  );
  const span = openSpan(reporter, MOUNT_SPAN);
  const host = options.host;
  const family = options.family ?? detectPointerEventFamily();
  const mountTarget = options.mount ?? DEFAULT_ON_SCREEN_HOST_SELECTOR;

  // Resolved before the mount root, so every selector below — the markup
  // controls included — is looked up in the same document the generated
  // elements are created by.
  const ownerDocument =
    options.ownerDocument ??
    (typeof mountTarget === 'string'
      ? readAmbientDocument()
      : mountTarget.ownerDocument);
  const root = resolveElement(mountTarget, ownerDocument, reporter);
  const view =
    options.view ??
    (ownerDocument === null ? null : ownerDocument.defaultView) ??
    readAmbientWindow();
  const markupBindings = options.markupControls ?? LEGACY_CONTROL_BINDINGS;

  const records: ControlRecord[] = [];
  const unbinds: UnbindControl[] = [];
  const reverts: (() => void)[] = [];
  const generatedRoots: Element[] = [];

  let pinnedKeymap: Keymap | null = null;
  let pinnedContext: InputContext | null = null;
  let remediated = 0;
  let unmounted = false;

  /**
   * Reports an attempt to drive the handle after it was unmounted, so the
   * attempt is diagnosable rather than a silent no-op.
   *
   * @param member Handle member that was called.
   * @returns Whether the call is to be abandoned.
   */
  const isUnmounted = (member: string): boolean => {
    if (!unmounted) {
      return false;
    }

    reporter.log('debug', 'An unmounted on-screen control layer was used.', {
      member,
    });

    return true;
  };

  const resolveKeymap = (): Keymap => {
    if (pinnedKeymap !== null) {
      return pinnedKeymap;
    }

    return readSource(
      options.keymap,
      (): Keymap => {
        const read = host.getKeymap;

        return read === undefined
          ? DEFAULT_KEY_BINDINGS
          : readSource(
              (): Keymap => read.call(host),
              (): Keymap => DEFAULT_KEY_BINDINGS,
              reporter,
              'host.getKeymap',
            );
      },
      reporter,
      'options.keymap',
    );
  };

  const resolveContext = (): InputContext => {
    if (pinnedContext !== null) {
      return pinnedContext;
    }

    return readSource(
      options.context,
      (): InputContext => {
        const read = host.context;

        return read === undefined
          ? 'game'
          : readSource(
              (): InputContext => read.call(host),
              (): InputContext => 'game',
              reporter,
              'host.context',
            );
      },
      reporter,
      'options.context',
    );
  };

  let activeKeymap = resolveKeymap();
  let activeContext = resolveContext();

  /**
   * Publishes one control's action, unless the control is unavailable in the
   * context last applied.
   *
   * @param record Control that was activated.
   * @param event Event that activated it.
   */
  const activate = (record: ControlRecord, event: Event): void => {
    if (!record.available) {
      const fields: InputReportFields = {
        action: record.action,
        context: activeContext,
      };

      reporter.log('debug', 'An unavailable control was activated.', fields);
      reporter.count(UNAVAILABLE_METRIC, fields);

      return;
    }

    const activation = openSpan(reporter, ACTIVATE_SPAN);

    try {
      reporter.count(ACTION_METRIC, {
        action: record.action,
        index: record.index,
        modality: ON_SCREEN_MODALITY,
        generated: record.generated,
      });

      publishControlAction(host, record.action, record.index, event);
    } finally {
      activation.end();
    }
  };

  /**
   * Binds one record's element and remembers how to unbind it.
   *
   * @param record Record to bind.
   * @param selector Selector the element was resolved by, for reporting.
   * @param bindTouchEnd Whether the touch-end name is bound alongside
   *   `'click'`.
   * @returns The handler bound, so a promotion can install it on `keydown`.
   */
  const bindRecord = (
    record: ControlRecord,
    selector: string,
    bindTouchEnd: boolean,
  ): ((event: Event) => void) => {
    const handler = (event: Event): void => {
      activate(record, event);
    };

    unbinds.push(
      bindButtonPress(record.element, handler, {
        reporter,
        family,
        action: record.action,
        reportedAs: selector,
        bindTouchEnd,
      }),
    );

    return handler;
  };

  // The three controls index.html declares, in the order
  // js/keyboard_input_manager.js L72-L74 bound them. Each keeps the ported
  // pair of listeners.
  for (const binding of markupBindings) {
    const element = resolveElement(
      binding.selector,
      ownerDocument,
      reporter,
    );

    if (element === null) {
      const fields: InputReportFields = {
        selector: binding.selector,
        action: binding.action,
      };

      reporter.log('warn', 'An on-screen control is absent.', fields);
      reporter.count(CONTROL_MISSING_METRIC, fields);

      continue;
    }

    const record: ControlRecord = {
      action: binding.action,
      index: DEFAULT_CONTROL_INDEX,
      ordinal: 0,
      element,
      generated: false,
      available: true,
    };
    const handler = bindRecord(record, binding.selector, true);
    const promotion = promoteControl(
      element,
      binding.action,
      binding.selector,
      activeKeymap,
      handler,
      reporter,
    );

    if (promotion.remediated) {
      remediated += 1;
      reverts.push(promotion.revert);
    }

    records.push(record);
  }

  // One generated control per action, in `INPUT_ACTIONS` order, which is the
  // order the settings panel presents the same actions in.
  let padGroup: Element | null = null;
  let actionGroup: Element | null = null;

  if (root === null || ownerDocument === null) {
    const fields: InputReportFields = {
      selector: describeTarget(mountTarget),
    };

    reporter.log(
      'warn',
      'The on-screen control host is absent; no control was generated.',
      fields,
    );
    reporter.count(HOST_MISSING_METRIC, fields);
  } else {
    padGroup = createGroup(ownerDocument, PAD_GROUP_CLASS, PAD_GROUP_LABEL);
    actionGroup = createGroup(
      ownerDocument,
      ACTION_GROUP_CLASS,
      ACTION_GROUP_LABEL,
    );

    for (const binding of listBindings(activeKeymap)) {
      const indices = resolveIndices(
        binding.action,
        options.indexes === undefined
          ? undefined
          : options.indexes[binding.action],
        reporter,
      );

      for (const [position, index] of indices.entries()) {
        const ordinal = indices.length > 1 ? position + 1 : 0;
        const element = createControl(
          ownerDocument,
          activeKeymap,
          binding.action,
          index,
          ordinal,
        );
        const record: ControlRecord = {
          action: binding.action,
          index,
          ordinal,
          element,
          generated: true,
          available: isActiveIn(binding, activeContext),
        };

        // A generated control binds `'click'` alone; the pair of listeners at
        // js/keyboard_input_manager.js L142-L143 is not reproduced here.
        // Recorded in docs/DECISION_LOG.md.
        bindRecord(record, describeGenerated(binding.action, index), false);
        applyAvailability(element, record.available);

        if (isMoveAction(binding.action)) {
          padGroup.append(element);
        } else {
          actionGroup.append(element);
        }

        records.push(record);
      }
    }

    root.append(padGroup, actionGroup);
    generatedRoots.push(padGroup, actionGroup);
  }

  /**
   * Applies the resolved keymap and context to every control: names first, so
   * a remapped key is announced, then availability.
   *
   * @param keymap Table to derive names from.
   * @param context Context to derive availability from.
   */
  const apply = (keymap: Keymap, context: InputContext): void => {
    activeKeymap = keymap;
    activeContext = context;

    let padAvailable = false;
    let actionAvailable = false;

    for (const record of records) {
      // A control the markup declares keeps the availability the markup gives
      // it: `.game-message` shows and hides its own two controls, and
      // `.restart-button` is shown throughout.
      if (!record.generated) {
        continue;
      }

      record.available = isActiveIn(keymap[record.action], context);

      applyGeneratedName(
        record.element,
        keymap,
        record.action,
        record.ordinal,
      );
      applyAvailability(record.element, record.available);

      if (!record.available) {
        continue;
      }

      if (isMoveAction(record.action)) {
        padAvailable = true;
      } else {
        actionAvailable = true;
      }
    }

    applyGroupAvailability(padGroup, padAvailable);
    applyGroupAvailability(actionGroup, actionAvailable);
  };

  // Reduced motion, resolved once and then followed. The camera and particle
  // effects inside the canvas carry their own check; this covers the controls.
  const motion = resolveMotionQuery(view, reporter);

  const applyMotion = (): void => {
    const reduce = motion !== null && motion.matches;

    applyMotionPreference(root, reduce);
    reporter.count(REDUCED_MOTION_METRIC, { reduce });
  };

  if (motion !== null && typeof motion.addEventListener === 'function') {
    const onMotionChange = (): void => {
      applyMotion();
    };

    motion.addEventListener('change', onMotionChange);
    reverts.push((): void => {
      motion.removeEventListener('change', onMotionChange);
    });
  }

  apply(activeKeymap, activeContext);
  applyMotion();

  const controls = Object.freeze(records.map(projectControl));

  reporter.log('info', 'The on-screen controls are mounted.', {
    controls: controls.length,
    generated: generatedRoots.length > 0,
    remediated,
    context: activeContext,
  });
  reporter.count(MOUNTED_METRIC, {
    controls: controls.length,
    remediated,
  });
  span.end();

  return Object.freeze({
    root,
    controls,
    remediated,

    setContext(context: InputContext): void {
      if (isUnmounted('setContext')) {
        return;
      }

      const from = activeContext;

      pinnedContext = context;
      apply(activeKeymap, context);
      reporter.count(CONTEXT_METRIC, { from, to: context });
    },

    setKeymap(keymap: Keymap): void {
      if (isUnmounted('setKeymap')) {
        return;
      }

      pinnedKeymap = keymap;
      apply(keymap, activeContext);
      reporter.count(KEYMAP_METRIC);
    },

    refresh(): void {
      if (isUnmounted('refresh')) {
        return;
      }

      apply(resolveKeymap(), resolveContext());
      applyMotion();
    },

    unmount: (): void => {
      if (unmounted) {
        return;
      }

      unmounted = true;

      for (const unbind of unbinds) {
        unbind();
      }

      for (const revert of reverts) {
        revert();
      }

      for (const generated of generatedRoots) {
        generated.remove();
      }

      if (root !== null) {
        root.classList.remove(MOTION_CLASS);
        root.removeAttribute(REDUCED_MOTION_ATTRIBUTE);
      }

      records.length = 0;
      unbinds.length = 0;
      reverts.length = 0;
      generatedRoots.length = 0;

      reporter.count(UNMOUNTED_METRIC);
      reporter.log('info', 'The on-screen controls are unmounted.');
    },
  });
}
