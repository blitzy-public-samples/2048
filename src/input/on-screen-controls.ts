// One focusable, tappable control per bindable action, and the only module in
// src/input/ that binds an element to an action.
//
// Ported from js/keyboard_input_manager.js, which is deleted: the three control
// bindings — `.retry-button` and `.restart-button` to `restart`,
// `.keep-playing-button` to `keepPlaying`, in that order — and
// `bindButtonPress`, its selector lookup, its `'click'` listener and its
// resolved touch-end listener.
//
// traceability row of docs/TRACEABILITY_MATRIX.md:
//   TR-CONTROL-01  L71-L74    the three control bindings — `.retry-button`
//   TR-CONTROL-02  L140-L144  `bindButtonPress` — the selector lookup at
// TR-CONTROL-03.
//
// Retained from that port: `bindButtonPress` binds BOTH `'click'` and the
// resolved touch-end event to one handler, so a tap can dispatch twice. Noted,
// not fixed.
//
// Changed against that port:
//   - the lookup is null-checked, reported and skipped
//
// Changed against that port, decisions DL-CONTROL-01 through DL-CONTROL-04
//   - a control the markup leaves unfocusable or unnamed is promoted, and the
//     promotion is reported
//   - `fn.bind(this)` becomes a lexically scoped handler; js/bind_polyfill.js
//     is deleted
//   - every action of `INPUT_ACTIONS` also gets a generated `<button>`, so the
//     eleven actions the markup declares no control for are reachable too
//   - the three L72-L74 controls carry `InputContext` availability like every
//     generated one: unavailable, each leaves the accessibility tree and the
//     tab order and publishes nothing. `MarkupControlBinding.contexts` is what
//     a markup control declares when the markup places it somewhere its
//     action's key is not bound, as `.retry-button` sits inside the terminal
//     overlay
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
import {
  REDUCED_MOTION_ATTRIBUTE,
  readReflectedReducedMotion,
} from '../ui/a11y/settings';
import type { PointerEventFamily } from './touch-input';
import { detectPointerEventFamily } from './touch-input';
import type { InputEmitter, InputModality } from './input-manager';

const MOUNTED_METRIC = 'input.onScreen.mounted';

const UNMOUNTED_METRIC = 'input.onScreen.unmounted';

const HOST_MISSING_METRIC = 'input.onScreen.host.missing';

const CONTROL_MISSING_METRIC = 'input.onScreen.control.missing';

const SELECTOR_INVALID_METRIC = 'input.onScreen.selector.invalid';

const REMEDIATED_METRIC = 'input.onScreen.control.remediated';

const ACTION_METRIC = 'input.onScreen.action';

const UNAVAILABLE_METRIC = 'input.onScreen.rejected.unavailable';

const HANDLER_ERROR_METRIC = 'input.onScreen.handler.error';

const CONTEXT_METRIC = 'input.onScreen.context.changed';

const KEYMAP_METRIC = 'input.onScreen.keymap.applied';

const REDUCED_MOTION_METRIC = 'input.onScreen.reducedMotion';

const INDEX_REJECTED_METRIC = 'input.onScreen.index.rejected';

const BIND_FAILED_METRIC = 'input.onScreen.bind.failed';

const ACTIVATE_SPAN = 'input.onScreen.activate';

const MOUNT_SPAN = 'input.onScreen.mount';

/* ==========================================================================
 * 2. Contract
 * ========================================================================== */

/** Removes the listeners one `bindButtonPress` call added. */
export type UnbindControl = () => void;

/** Removes every listener and every element one mount added. */
export type UnmountOnScreenControls = () => void;

/** What `bindButtonPress` binds, and what it reports through. */
export interface BindButtonPressOptions {
  readonly root?: ParentNode;
  readonly ownerDocument?: Document;
  readonly reporter?: InputReporter;
  readonly family?: PointerEventFamily;
  readonly action?: string;

  /**
   * Name reported for the target in place of the derived one. A caller that
   * resolved the element itself passes the selector it resolved it by, so a
   * report still names that selector.
   */
  readonly reportedAs?: string;
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
  restart(event?: Event): void;
  keepPlaying(event?: Event): void;
  emitMove(direction: Direction, modality?: InputModality): number;
  getKeymap?(): Keymap;
  context?(): InputContext;
}

/** One control the markup declares, and the action it publishes. */
export interface MarkupControlBinding {
  readonly selector: string;
  readonly action: InputAction;

  /**
   * Contexts this control is available in. Defaults to the contexts the
   * action's binding lists, so a markup control carries the availability of
   * the action it publishes unless the markup places it somewhere the key is
   * not bound: `.retry-button` sits inside the terminal overlay and is
   * declared for `'overlay'` as well as `'game'` below, while the `r` key
   * remains bound in `'game'` alone.
   */
  readonly contexts?: readonly InputContext[];
}

/** One control this layer owns, generated or promoted. */
export interface OnScreenControl {
  readonly action: InputAction;
  readonly index: number;
  readonly element: Element;
  readonly generated: boolean;
}

/** Construction parameters. Only `host` is required. */
export interface OnScreenControlsOptions {
  readonly host: OnScreenControlHost;
  readonly mount?: Element | string;
  readonly ownerDocument?: Document;
  readonly reporter?: InputReporter;
  readonly family?: PointerEventFamily;
  readonly keymap?: Keymap | (() => Keymap);
  readonly context?: InputContext | (() => InputContext);
  readonly view?: Window;

  /**
   * Element the effective reduced-motion value is read from, in the attribute
   * `src/ui/a11y/settings.ts` reflects it into.
   *
   * Consulted ahead of the media query, so an explicit `'reduce'` or `'allow'`
   * setting reaches these controls and not only the operating system's answer.
   * Defaults to the owner document's `documentElement`.
   */
  readonly motionRoot?: Element | null;

  /**
   * Effective reduced-motion value to hold regardless of the reflected
   * attribute or the media query.
   *
   * Supplied where the caller already owns the preference; `setReducedMotion()`
   * replaces it later. Absent, the resolution order is the reflected attribute
   * and then the media query.
   */
  readonly reducedMotion?: boolean;

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
   * `.settings-button` of index.html, say — passes an extended list here
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
  readonly remediated: number;

  /**
   * Replaces the context control availability is derived from, and reapplies
   * it. A control whose action is inactive in the new context leaves both the
   * accessibility tree and the tab order.
   */
  setContext(context: InputContext): void;
  setKeymap(keymap: Keymap): void;

  /**
   * Holds an effective reduced-motion value, overriding both the reflected
   * attribute and the media query, and reapplies it.
   *
   * @param reduced The effective value, or `null` to resolve it from the
   *   reflected attribute and then the media query again.
   */
  setReducedMotion(reduced: boolean | null): void;

  /** The effective reduced-motion value now in force. */
  isReducedMotion(): boolean;

  /**
   * Re-reads the keymap, the context and the reduced-motion preference from
   * their configured sources and reapplies all three.
   */
  refresh(): void;
  readonly unmount: UnmountOnScreenControls;
}

/** Selector the generated controls are appended inside by default. */
export const DEFAULT_ON_SCREEN_HOST_SELECTOR = '#on-screen-controls';

/**
 * The three controls index.html declares, and the action each publishes.
 *
 * Ported from js/keyboard_input_manager.js L72-L74, in the order those three
 * lines bound them: `.retry-button` and `.restart-button` both publish
 * `restart`, and `.keep-playing-button` publishes `keepPlaying`.
 *
 * `.retry-button` declares its own contexts because index.html L52 places it
 * inside `.game-message`, the terminal overlay, whereas the `restart` binding
 * of src/input/keymap.ts lists `'game'` alone. `.restart-button` at
 * index.html L36 sits above the board and takes the binding's contexts, and
 * `.keep-playing-button` at index.html L51 takes `keepPlaying`'s `'overlay'`.
 */
export const LEGACY_CONTROL_BINDINGS: readonly MarkupControlBinding[] =
  Object.freeze([
    Object.freeze({
      selector: '.retry-button',
      action: 'restart' as const,
      contexts: Object.freeze<InputContext[]>(['game', 'overlay']),
    }),
    Object.freeze({ selector: '.restart-button', action: 'restart' as const }),
    Object.freeze({
      selector: '.keep-playing-button',
      action: 'keepPlaying' as const,
    }),
  ]);

const INDEXED_ACTIONS: ReadonlySet<InputAction> = new Set<InputAction>([
  'selectReward',
  'activateRelic',
]);

const MAX_CONTROLS_PER_ACTION = 8;

const DEFAULT_CONTROL_INDEX = 0;

const CONTROL_CLASS = 'on-screen-control';

const CONTROL_VOCABULARY_CLASS = 'screen-button';

const GROUP_CLASS = 'on-screen-controls-group';

const PAD_GROUP_CLASS = 'on-screen-controls-pad';

const ACTION_GROUP_CLASS = 'on-screen-controls-actions';

const MOTION_CLASS = 'on-screen-controls-animated';

/** Attribute a control carries its action in. */
const ACTION_ATTRIBUTE = 'data-action';

const INDEX_ATTRIBUTE = 'data-index';

const DIRECTION_ATTRIBUTE = 'data-direction';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

const PAD_GROUP_LABEL = 'Move tiles';

const ACTION_GROUP_LABEL = 'Game actions';

const ON_SCREEN_MODALITY: InputModality = 'onScreen';

const NATIVE_CONTROL_TAGS: ReadonlySet<string> = new Set([
  'BUTTON',
  'INPUT',
  'SELECT',
  'TEXTAREA',
]);

const ACTIVATION_KEYS: ReadonlySet<string> = new Set([
  'Enter',
  ' ',
  'Spacebar',
]);

const NOOP_UNBIND: UnbindControl = () => {
  return;
};

/* ==========================================================================
 * 4. Reporting helpers
 * ========================================================================== */

/** The span returned when the injected sink opens none. */
const NOOP_SPAN: InputSpan = Object.freeze({
  end(): void {
    return;
  },
});

function openSpan(reporter: InputReporter, name: string): InputSpan {
  const open = reporter.startSpan;

  return open === undefined ? NOOP_SPAN : open.call(reporter, name);
}

function readAmbientDocument(): Document | null {
  return typeof document === 'undefined' ? null : document;
}

function readAmbientWindow(): Window | null {
  return typeof window === 'undefined' ? null : window;
}

function resolveLookupRoot(options: BindButtonPressOptions): ParentNode | null {
  return options.root ?? options.ownerDocument ?? readAmbientDocument();
}

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
    // The caught value is carried unconverted through the reporter's failure
    // channel; the call is reduced to `null` and the caller reports the
    // absence of the control it was resolving.
    const fields: InputReportFields = { selector: target };

    reporter.failure?.(
      'error',
      'An on-screen control selector is not valid.',
      caught,
      fields,
    );
    reporter.count(SELECTOR_INVALID_METRIC, fields);

    return null;
  }
}

function describeTarget(target: Element | string): string {
  return typeof target === 'string' ? target : target.tagName.toLowerCase();
}

function describeGenerated(action: InputAction, index: number): string {
  return (
    `.${CONTROL_CLASS}[${ACTION_ATTRIBUTE}="${action}"]` +
    `[${INDEX_ATTRIBUTE}="${index}"]`
  );
}

function trimmed(value: string | null): string {
  return value === null ? '' : value.trim();
}

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

function activatesFromKeyboard(element: Element): boolean {
  if (NATIVE_CONTROL_TAGS.has(element.tagName)) {
    return true;
  }

  return element.tagName === 'A' && element.hasAttribute('href');
}

function hasControlRole(element: Element): boolean {
  if (NATIVE_CONTROL_TAGS.has(element.tagName)) {
    return true;
  }

  const role = trimmed(element.getAttribute('role'));

  return role.length > 0;
}

/**
 * Binds one handler to a control's pointer activation.
 *
 * Ported from js/keyboard_input_manager.js L140-L144. The lookup at L141 is
 * null-checked here; `'click'` at L142 and the resolved touch-end name at L143
 * are both bound, so a tap can dispatch the handler twice.
 *
 * @returns A handle removing every listener added. An unresolved target is
 *   reported and yields a handle that removes nothing; nothing throws, and a
 *   second call of the handle is harmless.
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
      };

      reporter.failure?.(
        'error',
        'An on-screen control handler threw.',
        caught,
        fields,
      );
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
      const fields: InputReportFields = { selector, action, eventName: name };

      reporter.failure?.(
        'error',
        'An on-screen control could not be bound.',
        caught,
        fields,
      );
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

interface ControlRecord {
  readonly action: InputAction;
  readonly index: number;
  readonly ordinal: number;
  readonly element: Element;
  readonly generated: boolean;

  /**
   * Contexts this control is available in, where they are the control's own
   * rather than its action's. `null` on every generated control and on a
   * markup control whose binding declares none, and those read the contexts of
   * the action's binding in the table currently in force.
   */
  readonly contexts: readonly InputContext[] | null;

  /**
   * Whether this layer supplies the element's accessible name. True for
   * every generated control, and for a markup control whose name this layer
   * had to write because the markup carried none.
   */
  ownsName: boolean;

  /**
   * The availability attributes as the markup declared them, held for a
   * markup control so an available one is restored rather than stripped.
   * `null` for a generated control, whose element this layer created.
   */
  readonly declared: DeclaredAvailability | null;

  /** Whether the action is active in the context last applied. */
  available: boolean;
}

/**
 * The availability attributes of a markup control as they stood before this
 * layer first wrote them, so restoring one leaves the markup's own
 * declarations in place.
 *
 * `tabindex` is captured when the control first becomes unavailable rather
 * than at mount, because `promoteControl` may have written it in between; the
 * value restored is therefore the one the control actually carried while it
 * was available.
 */
interface DeclaredAvailability {
  /** `hidden` as declared, or `null` when it was absent. */
  readonly hidden: string | null;

  /** `aria-hidden` as declared, or `null` when it was absent. */
  readonly ariaHidden: string | null;

  /** `disabled` as declared, or `null` when it was absent. */
  readonly disabled: string | null;

  /** `tabindex` as it stood while available, once one has been captured. */
  tabIndex?: string | null;
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
 * Reports whether a context is one of those listed.
 *
 * Called with a binding's own `contexts` for a generated control and with the
 * resolved `contexts` of a `MarkupControlBinding` for one the markup
 * declares, so both kinds of control are measured by one rule.
 *
 * @param contexts Contexts the control is available in.
 * @param context Context to test against.
 * @returns `true` when the list carries the context.
 */
function isActiveIn(
  contexts: readonly InputContext[],
  context: InputContext,
): boolean {
  for (const candidate of contexts) {
    if (candidate === context) {
      return true;
    }
  }

  return false;
}

function hasKey(binding: InputBinding): boolean {
  return binding.keys.length > 0 || binding.codes.length > 0;
}

function labelFor(action: InputAction, ordinal: number): string {
  const label = describeAction(action);

  return ordinal > 0 ? `${label} ${ordinal}` : label;
}

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

interface ActivationKeyEventLike extends Event {
  /** `KeyboardEvent.key`. Absent from an event that carries none. */
  readonly key?: string;
}

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
 * Reads the availability attributes of a control the markup declares.
 *
 * Read once, before this layer writes any of them, so an available control is
 * restored to what index.html declared instead of having the three
 * attributes stripped from it.
 *
 * @param element Element to read.
 * @returns The declared state.
 */
function captureDeclaredAvailability(element: Element): DeclaredAvailability {
  return {
    hidden: element.getAttribute('hidden'),
    ariaHidden: element.getAttribute('aria-hidden'),
    disabled: element.getAttribute('disabled'),
  };
}

/**
 * Writes one attribute, or removes it where the value is `null`.
 *
 * @param element Element to write to.
 * @param name Attribute to write.
 * @param value Value to write, or `null` to remove the attribute.
 */
function writeAttribute(
  element: Element,
  name: string,
  value: string | null,
): void {
  if (value === null) {
    element.removeAttribute(name);

    return;
  }

  element.setAttribute(name, value);
}

/**
 * Applies availability to one control the markup declares.
 *
 * The same four attributes `applyAvailability` writes, with two differences
 * that follow from index.html owning the element: the visible label is never
 * touched, and an available control is restored to the state the markup
 * declared rather than having the attributes removed. `.game-message` keeps
 * showing and hiding its own two controls through the stylesheet; this is the
 * accessibility-tree and tab-order half of the same state, which the
 * stylesheet cannot express.
 *
 * @param element Element to apply to.
 * @param declared The element's declared availability state.
 * @param available Whether the action is active in the current context.
 */
function applyMarkupAvailability(
  element: Element,
  declared: DeclaredAvailability,
  available: boolean,
): void {
  if (available) {
    writeAttribute(element, 'hidden', declared.hidden);
    writeAttribute(element, 'aria-hidden', declared.ariaHidden);
    writeAttribute(element, 'disabled', declared.disabled);

    if (declared.tabIndex !== undefined) {
      writeAttribute(element, 'tabindex', declared.tabIndex);
      declared.tabIndex = undefined;
    }

    return;
  }

  // Captured on the transition rather than at mount: `promoteControl` may
  // have supplied the tab stop, and that is the value an available control
  // is restored to.
  if (declared.tabIndex === undefined) {
    declared.tabIndex = element.getAttribute('tabindex');
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
    reporter.failure?.(
      'warn',
      'The reduced-motion preference could not be read.',
      caught,
      { query: REDUCED_MOTION_QUERY },
    );

    return null;
  }
}

/**
 * Observes the element carrying the reflected reduced-motion value.
 *
 * The settings surface writes the attribute directly, which fires no
 * media-query event, so the change is only seen by watching the element.
 *
 * @param target Element to observe, or `null`.
 * @param owner Document the observer constructor is taken from.
 * @param onChange Called on every attribute write.
 * @returns The observer, or `null` where none could be created.
 */
function observeMotionRoot(
  target: Element | null,
  owner: Document | null,
  onChange: () => void,
): MutationObserver | null {
  if (target === null) {
    return null;
  }

  const view = owner?.defaultView ?? null;
  const Observer = view?.MutationObserver;

  if (typeof Observer !== 'function') {
    return null;
  }

  try {
    const observer = new Observer((): void => {
      onChange();
    });

    observer.observe(target, {
      attributes: true,
      attributeFilter: [REDUCED_MOTION_ATTRIBUTE],
    });

    return observer;
  } catch {
    // An environment that rejects the observation leaves the media query and
    // any pinned value as the sources, which is the documented fallback.
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

interface Promotion {
  readonly remediated: boolean;

  /**
   * Whether the accessible name was among the repairs, and is therefore this
   * layer's to keep current when the keymap changes.
   */
  readonly named: boolean;

  /** Undoes every repair, leaving the element as the markup declared it. */
  readonly revert: () => void;
}

const NO_PROMOTION: Promotion = Object.freeze({
  remediated: false,
  named: false,
  revert: (): void => {
    return;
  },
});

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

  let named = false;

  if (accessibleNameOf(element).length === 0) {
    element.setAttribute('aria-label', nameFor(keymap, action, 0));
    repairs.push('accessibleName');
    named = true;
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
    named,
    revert: (): void => {
      for (const step of steps) {
        step();
      }
    },
  });
}

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
    reporter.failure?.('error', 'An on-screen control source threw.', caught, {
      source: name,
    });

    return fallback();
  }
}

/**
 * Mounts one focusable, tappable control per bindable action, and binds the
 * controls index.html declares.
 *
 * Reports rather than throws: an absent mount root, an absent control and a
 * source that throws are each reported and skipped, and the returned handle is
 * callable in every one of those cases. The guarded successor of
 * js/keyboard_input_manager.js, where an absent element was a startup failure.
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

    const declared = captureDeclaredAvailability(element);
    // Held as `null` where the binding declares none, so a later keymap
    // reaches this control's availability as it reaches a generated one's.
    const contexts = binding.contexts ?? null;
    const record: ControlRecord = {
      action: binding.action,
      index: DEFAULT_CONTROL_INDEX,
      ordinal: 0,
      element,
      generated: false,
      contexts,
      // Replaced below where the promotion had to supply the name.
      ownsName: false,
      declared,
      available: isActiveIn(
        contexts ?? activeKeymap[binding.action].contexts,
        activeContext,
      ),
    };
    const handler = bindRecord(record, binding.selector, true);

    // Registered before the promotion's own revert, so an unmount restores
    // the availability attributes first and the promotion's tab stop and
    // role second, leaving the element as index.html declared it.
    reverts.push((): void => {
      applyMarkupAvailability(element, declared, true);
    });

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

    record.ownsName = promotion.named;
    records.push(record);
  }

  // One generated control per action, in `INPUT_ACTIONS` order, which is the
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
          // A generated control follows its action's own binding, and this
          // layer wrote its name, so both are re-derived from the table on
          // every refresh.
          contexts: null,
          ownsName: true,
          declared: null,
          available: isActiveIn(binding.contexts, activeContext),
        };

        // A generated control binds `'click'` alone; the pair of listeners at
        // js/keyboard_input_manager.js L142-L143 is not reproduced here.
        //
        // Decision DL-CONTROL-02.
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
   * Every record is reapplied, the three index.html declares included. A
   * control unavailable in `context` leaves the accessibility tree and the
   * tab order whether this layer created its element or not, and `activate`
   * publishes nothing for it. A markup control's contexts are its own where
   * its binding declared them and the action's otherwise; its visible label
   * is never written, and its accessible name is rewritten only where this
   * layer supplied it.
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
      const contexts = record.contexts ?? keymap[record.action].contexts;

      record.available = isActiveIn(contexts, context);

      if (record.generated) {
        applyGeneratedName(
          record.element,
          keymap,
          record.action,
          record.ordinal,
        );
        applyAvailability(record.element, record.available);
      } else {
        if (record.ownsName) {
          record.element.setAttribute(
            'aria-label',
            nameFor(keymap, record.action, record.ordinal),
          );
        }

        // `declared` is non-null for every record this branch reaches; the
        // fallback keeps the read total rather than asserting.
        applyMarkupAvailability(
          record.element,
          record.declared ?? captureDeclaredAvailability(record.element),
          record.available,
        );
      }

      // Only a generated control belongs to one of the two groups, so only
      // one of those keeps its group in the accessibility tree; a markup
      // control sits where index.html places it.
      if (!record.available || !record.generated) {
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

  // Reduced motion, resolved from three sources in a fixed order and then
  // followed. The camera and particle effects inside the canvas read the render
  // layer's own store; this covers the controls, and the reflected attribute is
  // what the two agree through.
  const motion = resolveMotionQuery(view, reporter);
  const motionRoot =
    options.motionRoot === undefined
      ? (ownerDocument?.documentElement ?? null)
      : options.motionRoot;

  let pinnedMotion: boolean | null = options.reducedMotion ?? null;
  let activeMotion = false;

  const resolveMotion = (): { reduce: boolean; source: string } => {
    if (pinnedMotion !== null) {
      return { reduce: pinnedMotion, source: 'pinned' };
    }

    const reflected = readReflectedReducedMotion(motionRoot);

    if (reflected !== null) {
      return { reduce: reflected, source: 'reflected' };
    }

    if (motion !== null) {
      return { reduce: motion.matches, source: 'query' };
    }

    return { reduce: false, source: 'default' };
  };

  const applyMotion = (): void => {
    const resolved = resolveMotion();

    activeMotion = resolved.reduce;

    applyMotionPreference(root, resolved.reduce);
    reporter.count(REDUCED_MOTION_METRIC, {
      reduce: resolved.reduce,
      source: resolved.source,
    });
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

  // The reflected attribute changes without a media-query event, because the
  // settings surface writes it, so the element carrying it is observed too.
  const motionObserver = observeMotionRoot(
    motionRoot,
    ownerDocument,
    applyMotion,
  );

  if (motionObserver !== null) {
    reverts.push((): void => {
      motionObserver.disconnect();
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

    setReducedMotion(reduced: boolean | null): void {
      if (isUnmounted('setReducedMotion')) {
        return;
      }

      pinnedMotion = reduced;
      applyMotion();
    },

    isReducedMotion(): boolean {
      return activeMotion;
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
