/**
 * Deterministic focus placement, dialog focus trapping, and the parallel
 * focusable board DOM that stands beside the WebGL canvas.
 *
 * Serves R9 and I12, and is the module gate V7 measures: every control
 * reachable by Tab and activatable by Enter or Space, and a visible focus
 * indicator.
 *
 * Nothing here ports a construct from js/: the retired sources carry no focus
 * management, no ARIA and no parallel board. The 1-based grid indices are
 * js/html_actuator.js's, and the cell geometry comes from style/main.scss
 * through ../../theme/tokens.
 *
 * Arrow keys are not read anywhere in this file. The grid host is a single tab
 * stop and its cells are programmatic focus targets, reached through
 * `focusCell` and through screen-reader exploration.
 *
 * Every selector this module resolves against the document comes from
 * index.html. `FOCUSABLE_SELECTORS` is not one of those: it is the generic
 * HTML focusability pattern, evaluated only inside a container the caller
 * supplies.
 *
 * One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
 * this module's area enumerated:
 *   TR-FOCUS-01  index.html L31, L38, L39      the three hrefless `<a>`
 *                                              controls, now `<button>`
 *                                              elements this module orders and
 *                                              contains
 *   TR-FOCUS-02  js/keyboard_input_manager.js  the unguarded control lookups,
 *                L139-L141                     resolved here through the
 *                                              guarded resolver of ./settings
 *   TR-FOCUS-03  target-only row               `collectFocusable`,
 *                                              `FOCUSABLE_SELECTORS` and the
 *                                              focus cycle
 *   TR-FOCUS-04  target-only row               the focus trap and its
 *                                              restoration target
 *   TR-FOCUS-05  target-only row               the parallel board layer, its
 *                                              single tab stop and `focusCell`
 *   TR-FOCUS-06  target-only row               the per-cell counterpart geometry
 *   TR-FOCUS-07  target-only row               `ScreenName`, `SCREEN_NAMES` and
 *                                              `isScreenName`
 *
 * Decisions: DL-FOCUS-01, DL-FOCUS-02, DL-FOCUS-03, DL-FOCUS-07
 * (docs/DECISION_LOG.md).
 */

import {
  DEFAULT_MOTION_SETTING,
  NOOP_UI_REPORTER,
  createSafeUiReporter,
  queryReducedMotionPreference,
  resolveEffectiveReducedMotion,
  resolveMount,
} from './settings';
import type { MotionSetting, UiReportFields, UiReporter } from './settings';
import { isSupportedBoardSize } from '../../config/default-config';
import {
  createGeometryScale,
  geometryScales,
  mobileThreshold,
  tilePositionStep,
} from '../../theme/tokens';
import type { GeometryScale, ScaleName } from '../../theme/tokens';

/** Context label carried into every report raised by the focus surface. */
export const FOCUS_CONTEXT = 'focus-manager';

/** Context label carried into every report raised by the board layer. */
export const BOARD_CONTEXT = 'a11y-board';

/** Counter raised where a container holds nothing focusable. */
const METRIC_NO_FOCUSABLE = 'ui.focus.no_focusable';

/** Counter raised where a focus target is not connected to a document. */
const METRIC_DETACHED_TARGET = 'ui.focus.detached_target';

/** Counter raised where `focus` itself threw. */
const METRIC_FOCUS_FAILED = 'ui.focus.failed';

/** Counter raised where a placement resolved no target at all. */
const METRIC_PLACEMENT_EMPTY = 'ui.focus.placement.empty';

/** Counter raised where a trap was asked to engage on nothing focusable. */
const METRIC_TRAP_EMPTY = 'ui.focus.trap.empty';

/** Counter raised for each trap that engaged. */
const METRIC_TRAP_ENGAGED = 'ui.focus.trap.engaged';

/** Counter raised for each trap that released. */
const METRIC_TRAP_RELEASED = 'ui.focus.trap.released';

/** Counter raised where the recorded restore target had detached. */
const METRIC_RESTORE_DETACHED = 'ui.focus.trap.restore_detached';

/**
 * Counter raised where the recorded restore target lay inside the trapped
 * container, which is not a place focus can be returned to.
 */
const METRIC_RESTORE_INSIDE = 'ui.focus.trap.restore_inside';

/**
 * Counted when nothing held focus as the trap engaged, so the document body
 * was the recorded target and the fallback serves the release instead.
 */
const METRIC_RESTORE_BODY = 'ui.focus.trap.restore_body';

/**
 * Counter raised where a restore target was present and connected but did not
 * take focus — an element inside a `[hidden]` subtree, or one the stylesheet
 * removes from the rendering.
 */
const METRIC_RESTORE_FAILED = 'ui.focus.trap.restore_failed';

/** Counter raised where a trap could not engage on a missing container. */
const METRIC_TRAP_NO_CONTAINER = 'ui.focus.trap.no_container';

/**
 * ADDED: counter raised once per press that left focus outside the trapped
 * container and was pulled back — a press on the backdrop, or on any part of a
 * modal surface that takes no focus of its own. DL-FOCUS-07.
 */
const METRIC_TRAP_RECLAIMED = 'ui.focus.trap.reclaimed';

/** Counter raised where the board host could not be resolved. */
const METRIC_BOARD_NO_HOST = 'ui.a11yBoard.host.missing';

/** Counter raised for each board size the layer refused. */
const METRIC_BOARD_SIZE_REJECTED = 'ui.a11yBoard.size.rejected';

/** Counter raised for each rebuild of the cell counterparts. */
const METRIC_BOARD_REBUILT = 'ui.a11yBoard.rebuilt';

/** Counter raised where a rebuild orphaned the focused node. */
const METRIC_BOARD_FOCUS_ORPHANED = 'ui.a11yBoard.focus.orphaned';

/** Counter raised where a coordinate addressed no cell. */
const METRIC_BOARD_CELL_MISSING = 'ui.a11yBoard.cell.missing';

/** Counter raised for each cell descriptor the layer refused. */
const METRIC_BOARD_CELL_REJECTED = 'ui.a11yBoard.cell.rejected';

/** Counter raised where a call arrived on an unmounted layer. */
const METRIC_BOARD_NOT_MOUNTED = 'ui.a11yBoard.not_mounted';

/**
 * Counter raised where a board dimension could not be resolved to a geometry
 * scale, so the declared scale was used unchanged.
 */
const METRIC_BOARD_SCALE_FALLBACK = 'ui.a11yBoard.scale.fallback';

/**
 * The seven screen states.
 *
 * Declared locally. This module's import list names no sibling under src/ui/.
 * `SCREEN_NAMES` below is the runtime list a caller validates against.
 */
export type ScreenName =
  | 'runStart'
  | 'stage'
  | 'stageClear'
  | 'reward'
  | 'won'
  | 'gameOver'
  | 'runSummary';

/** Every screen name, in the order the run visits them. */
export const SCREEN_NAMES: readonly ScreenName[] = Object.freeze([
  'runStart',
  'stage',
  'stageClear',
  'reward',
  'won',
  'gameOver',
  'runSummary',
] as const);

/**
 * Narrows a value to a screen name.
 *
 * @param value Candidate name.
 * @returns Whether `value` is one of `SCREEN_NAMES`.
 */
export function isScreenName(value: unknown): value is ScreenName {
  return SCREEN_NAMES.some((name) => name === value);
}

/**
 * An element this module may call `focus` on.
 *
 * Both branches implement the `focus`, `blur` and `tabIndex` members, so the
 * union covers a focusable SVG child of a container as well as an HTML one.
 */
export type FocusableElement = HTMLElement | SVGElement;

/** A node a focusable search runs against. */
export type FocusRoot = Element | Document | DocumentFragment;

/**
 * Narrows a value to something focusable.
 *
 * @param value Candidate element.
 * @returns Whether `value` carries a callable `focus`.
 */
function isFocusableElement(value: unknown): value is FocusableElement {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const candidate: {
    readonly focus?: unknown;
    readonly getAttribute?: unknown;
  } = value;

  return (
    typeof candidate.focus === 'function' &&
    typeof candidate.getAttribute === 'function'
  );
}

/**
 * Narrows a value to an element carrying the members this module reads.
 *
 * @param value Candidate element.
 * @returns Whether `value` behaves as an element.
 */
function isElementLike(value: unknown): value is Element {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const candidate: {
    readonly getAttribute?: unknown;
    readonly querySelectorAll?: unknown;
  } = value;

  return (
    typeof candidate.getAttribute === 'function' &&
    typeof candidate.querySelectorAll === 'function'
  );
}

/**
 * Narrows a value to a document.
 *
 * @param value Candidate document.
 * @returns Whether `value` carries a callable `createElement` and
 *   `querySelector`.
 */
function isDocumentLike(value: unknown): value is Document {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const candidate: {
    readonly createElement?: unknown;
    readonly querySelector?: unknown;
  } = value;

  return (
    typeof candidate.createElement === 'function' &&
    typeof candidate.querySelector === 'function'
  );
}

/**
 * Narrows a value to a window.
 *
 * @param value Candidate window.
 * @returns Whether `value` carries a callable `getComputedStyle`.
 */
function isWindowLike(value: unknown): value is Window {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const candidate: { readonly getComputedStyle?: unknown } = value;

  return typeof candidate.getComputedStyle === 'function';
}

/**
 * Resolves the document a node belongs to, without throwing.
 *
 * @param node Node to resolve from.
 * @returns The owning document, the node itself where it is one, or `null`.
 */
function ownerDocumentOf(node: unknown): Document | null {
  if (isDocumentLike(node)) {
    return node;
  }

  if (node === null || typeof node !== 'object') {
    return null;
  }

  const candidate: { readonly ownerDocument?: unknown } = node;
  const owner: unknown = candidate.ownerDocument;

  return isDocumentLike(owner) ? owner : null;
}

/**
 * Resolves the window a node's document belongs to, without throwing.
 *
 * @param node Node to resolve from.
 * @returns The owning window, or `null` where there is none.
 */
function windowOf(node: unknown): Window | null {
  const doc = ownerDocumentOf(node);

  if (doc === null) {
    return null;
  }

  const view: unknown = doc.defaultView;

  return isWindowLike(view) ? view : null;
}

/**
 * Whether a node is attached to a document.
 *
 * @param node Node to test.
 * @returns `false` where the node is detached, or reports no connection at
 *   all.
 */
function isConnectedNode(node: unknown): boolean {
  if (node === null || typeof node !== 'object') {
    return false;
  }

  const candidate: { readonly isConnected?: unknown } = node;

  return candidate.isConnected === true;
}

/**
 * Names an element for a report.
 *
 * @param element Element to name.
 * @returns Its id selector, its class selector, or its lower-case tag name.
 */
function describeElement(element: unknown): string {
  if (!isElementLike(element)) {
    return 'unknown';
  }

  const id = element.getAttribute('id');

  if (typeof id === 'string' && id.length > 0) {
    return `#${id}`;
  }

  const className = element.getAttribute('class');
  const tagName =
    typeof element.tagName === 'string'
      ? element.tagName.toLowerCase()
      : 'unknown';

  if (typeof className === 'string' && className.length > 0) {
    const first = className.trim().split(/\s+/)[0];

    if (first !== undefined && first.length > 0) {
      return `${tagName}.${first}`;
    }
  }

  return tagName;
}

/**
 * The generic HTML focusability pattern.
 *
 * Not a product mount point: every selector here is evaluated inside a
 * container the caller supplies, never against the document. index.html
 * remains the sole authority for the mount selectors this module resolves, and
 * each of those goes through the guarded resolver.
 *
 * `[aria-disabled="true"]` is absent from the exclusions the filter below
 * applies. style/_reward.scss withdraws pointer interaction from such a card
 * and keeps it focusable and announceable, so it stays in the cycle.
 */
export const FOCUSABLE_SELECTORS = Object.freeze([
  'a[href]',
  'area[href]',
  'button',
  'input',
  'select',
  'textarea',
  'details > summary',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]',
] as const);

/** `FOCUSABLE_SELECTORS` as one selector list. */
export const FOCUSABLE_SELECTOR: string = FOCUSABLE_SELECTORS.join(', ');

/** Options accepted by `collectFocusable`. */
export interface CollectFocusableOptions {
  /** Sink the failures are reported through. */
  readonly reporter?: UiReporter;

  /** Short label naming the caller, carried into every report. */
  readonly context?: string;

  /**
   * Whether elements carrying a negative `tabindex` are included. Defaults to
   * `false`.
   */
  readonly includeProgrammatic?: boolean;

  /**
   * Whether the rendered-box filter is skipped entirely. Defaults to `false`,
   * which applies the filter only where the environment reports layout at all.
   */
  readonly ignoreVisibility?: boolean;
}

/**
 * Reads an element's `tabindex` as a number.
 *
 * @param element Element to read.
 * @returns The parsed value, or `null` where the attribute is absent or is
 *   not an integer.
 */
function tabIndexAttributeOf(element: Element): number | null {
  const raw = element.getAttribute('tabindex');

  if (raw === null) {
    return null;
  }

  const parsed = Number.parseInt(raw.trim(), 10);

  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * Whether an element, or an ancestor of it, carries one of the attributes that
 * removes it from the focus order.
 *
 * @param element Element to test.
 * @param reporter Contained sink.
 * @param context Label naming the caller.
 * @returns Whether the element is excluded by an attribute.
 */
function isAttributeExcluded(
  element: Element,
  reporter: UiReporter,
  context: string,
): boolean {
  const onSelfOnly = (): boolean =>
    element.hasAttribute('disabled') ||
    element.hasAttribute('hidden') ||
    element.hasAttribute('inert');

  if (typeof element.closest !== 'function') {
    return onSelfOnly();
  }

  try {
    return (
      element.closest('[disabled]') !== null ||
      element.closest('[hidden]') !== null ||
      element.closest('[inert]') !== null
    );
  } catch (error: unknown) {
    // `closest` rejects a selector the engine cannot parse.
    reporter.error('focusable ancestor test failed', error, {
      context,
      element: describeElement(element),
    });

    return onSelfOnly();
  }
}

/**
 * Whether an element is removed from the rendering by a computed style.
 *
 * @param element Element to test.
 * @param view Window the style is computed against, or `null`.
 * @param reporter Contained sink.
 * @param context Label naming the caller.
 * @returns Whether the element is not rendered.
 */
function isStyleHidden(
  element: Element,
  view: Window | null,
  reporter: UiReporter,
  context: string,
): boolean {
  if (view === null) {
    return false;
  }

  try {
    const style = view.getComputedStyle(element);

    return (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      style.contentVisibility === 'hidden'
    );
  } catch (error: unknown) {
    // A detached element makes `getComputedStyle` throw on some engines.
    reporter.error('focusable style test failed', error, {
      context,
      element: describeElement(element),
    });

    return false;
  }
}

/**
 * Whether an element reports a box with area.
 *
 * @param element Element to measure.
 * @param reporter Contained sink.
 * @param context Label naming the caller.
 * @returns Whether both of its measured dimensions exceed zero.
 */
function hasRenderedBox(
  element: Element,
  reporter: UiReporter,
  context: string,
): boolean {
  if (typeof element.getBoundingClientRect !== 'function') {
    return false;
  }

  try {
    const rect = element.getBoundingClientRect();

    return rect.width > 0 && rect.height > 0;
  } catch (error: unknown) {
    reporter.error('focusable measurement failed', error, {
      context,
      element: describeElement(element),
    });

    return false;
  }
}

/**
 * Collects the focusable descendants of a root, in DOM order.
 *
 * The rendered-box filter is self-normalizing: it is applied only where at
 * least one surviving candidate reports a box with area. An environment that
 * reports no layout for anything — jsdom, and every other DOM emulator —
 * therefore keeps every candidate instead of yielding an empty set, while a real
 * engine drops the collapsed ones.
 *
 * @param root Container the search runs inside. A nullish root is reported
 *   and yields an empty result.
 * @param options Sink, context label, and the two filter switches.
 * @returns The focusable descendants, frozen and in DOM order.
 */
export function collectFocusable(
  root: FocusRoot | null | undefined,
  options: CollectFocusableOptions = {},
): readonly FocusableElement[] {
  const reporter = createSafeUiReporter(options.reporter ?? NOOP_UI_REPORTER);
  const context = options.context ?? FOCUS_CONTEXT;
  const empty: readonly FocusableElement[] = Object.freeze([]);

  if (root === null || root === undefined) {
    reporter.log('warn', 'focusable search root is absent', { context });
    reporter.count(METRIC_NO_FOCUSABLE, { context, cause: 'no-root' });

    return empty;
  }

  if (typeof root.querySelectorAll !== 'function') {
    reporter.log('warn', 'focusable search root is not searchable', {
      context,
      root: describeElement(root),
    });
    reporter.count(METRIC_NO_FOCUSABLE, { context, cause: 'no-root' });

    return empty;
  }

  let found: ArrayLike<unknown>;

  try {
    found = root.querySelectorAll(FOCUSABLE_SELECTOR);
  } catch (error: unknown) {
    reporter.error('focusable selector could not be evaluated', error, {
      context,
      selector: FOCUSABLE_SELECTOR,
    });
    reporter.count(METRIC_NO_FOCUSABLE, { context, cause: 'query-failed' });

    return empty;
  }

  const view = windowOf(root);
  const includeProgrammatic = options.includeProgrammatic === true;
  const survivors: FocusableElement[] = [];

  for (let index = 0; index < found.length; index += 1) {
    const candidate: unknown = found[index];

    if (!isFocusableElement(candidate) || !isElementLike(candidate)) {
      continue;
    }

    if (isAttributeExcluded(candidate, reporter, context)) {
      continue;
    }

    const tabIndex = tabIndexAttributeOf(candidate);

    if (tabIndex !== null && tabIndex < 0 && !includeProgrammatic) {
      continue;
    }

    if (isStyleHidden(candidate, view, reporter, context)) {
      continue;
    }

    survivors.push(candidate);
  }

  if (options.ignoreVisibility === true || survivors.length === 0) {
    return Object.freeze(survivors.slice());
  }

  const boxes = survivors.map((element) =>
    hasRenderedBox(element, reporter, context),
  );

  if (!boxes.includes(true)) {
    // No candidate reports layout, so the environment measures nothing and the
    // box filter carries no information.
    return Object.freeze(survivors.slice());
  }

  const rendered = survivors.filter((_element, index) => boxes[index] === true);

  return Object.freeze(rendered);
}

/** How a caller supplies the effective reduced-motion value. */
export interface ReducedMotionOptions {
  /**
   * The effective value, supplied directly. Overrides `motionSetting` and the
   * platform query.
   */
  readonly reducedMotion?: boolean;

  /**
   * The motion setting in force, resolved against the platform query. Defaults
   * to `DEFAULT_MOTION_SETTING`, which follows the query.
   */
  readonly motionSetting?: MotionSetting;
}

/**
 * Resolves the effective reduced-motion value.
 *
 * @param options Explicit value, or the setting to resolve.
 * @param reporter Contained sink, passed to the platform query.
 * @returns Whether motion is to be reduced.
 */
function resolveReducedMotion(
  options: ReducedMotionOptions,
  reporter: UiReporter,
): boolean {
  if (typeof options.reducedMotion === 'boolean') {
    return options.reducedMotion;
  }

  return resolveEffectiveReducedMotion(
    options.motionSetting ?? DEFAULT_MOTION_SETTING,
    queryReducedMotionPreference({ reporter }),
  );
}

/**
 * Scroll behaviour for a given reduced-motion value.
 *
 * @param reduced Whether motion is to be reduced.
 * @returns `'auto'` under reduced motion, `'smooth'` otherwise.
 */
function scrollBehaviourFor(reduced: boolean): ScrollBehavior {
  return reduced ? 'auto' : 'smooth';
}

/** Options accepted by `applyFocus`. */
interface ApplyFocusOptions {
  /** Contained sink. */
  readonly reporter: UiReporter;

  /** Short label naming the caller. */
  readonly context: string;

  /** Whether motion is to be reduced. */
  readonly reducedMotion: boolean;

  /** Whether the target is scrolled into view after focusing. */
  readonly scrollIntoView?: boolean;

  /** Field naming what the placement was for, carried into a report. */
  readonly fields?: UiReportFields;
}

/**
 * Focuses an element without throwing, reporting whichever way it failed.
 *
 * @param element Element to focus, or `null`.
 * @param options Sink, context label, motion value and scroll switch.
 * @returns Whether the element now holds focus.
 */
function applyFocus(
  element: FocusableElement | null,
  options: ApplyFocusOptions,
): boolean {
  const { reporter, context, reducedMotion } = options;
  const fields: UiReportFields = { context, ...options.fields };

  if (element === null) {
    return false;
  }

  if (!isConnectedNode(element)) {
    reporter.log('warn', 'focus target is not connected to a document', {
      ...fields,
      target: describeElement(element),
    });
    reporter.count(METRIC_DETACHED_TARGET, fields);

    return false;
  }

  try {
    element.focus({ preventScroll: true });
  } catch (error: unknown) {
    reporter.error('focus call failed', error, {
      ...fields,
      target: describeElement(element),
    });
    reporter.count(METRIC_FOCUS_FAILED, fields);

    return false;
  }

  if (
    options.scrollIntoView !== false &&
    typeof element.scrollIntoView === 'function'
  ) {
    try {
      element.scrollIntoView({
        behavior: scrollBehaviourFor(reducedMotion),
        block: 'nearest',
        inline: 'nearest',
      });
    } catch (error: unknown) {
      // A platform rejecting the options form leaves the element focused but
      // unscrolled.
      reporter.error('focus target could not be scrolled into view', error, {
        ...fields,
        target: describeElement(element),
      });
    }
  }

  const doc = ownerDocumentOf(element);

  return doc === null || doc.activeElement === element;
}

/**
 * Attribute a screen marks its designated initial focus target with.
 *
 * The generic marker pattern, evaluated only inside the container the router
 * injects. A screen that renders its own content sets it on the control focus
 * is to land on; a screen that sets it nowhere falls through to the chain in
 * `focusInitial`.
 */
export const FOCUS_INITIAL_ATTRIBUTE = 'data-focus-initial';

/** `FOCUS_INITIAL_ATTRIBUTE` as an attribute selector. */
export const FOCUS_INITIAL_SELECTOR = `[${FOCUS_INITIAL_ATTRIBUTE}]`;

/**
 * The designated target per screen, tried inside the container in order.
 *
 * `stage` names the board's tab stop under EITHER renderer, most specific
 * first. The number-only renderer of src/render/number-only-renderer.ts roves a
 * tab stop across the cells of its own `#board-number-only` lattice and hides
 * `#board-a11y` while it holds one, so the parallel board's host — which is the
 * single tab stop under the Three renderer — is a hidden element for the whole
 * of a number-only session. Naming it alone therefore placed stage focus on
 * something that cannot take it. Decision DL-FOCUS-04.
 */
export const SCREEN_INITIAL_FOCUS: Readonly<
  Record<ScreenName, readonly string[]>
> = Object.freeze({
  runStart: Object.freeze([]),
  stage: Object.freeze(['#board-number-only [tabindex="0"]', '#board-a11y']),
  stageClear: Object.freeze([]),
  reward: Object.freeze(['.relic-card']),
  won: Object.freeze([]),
  gameOver: Object.freeze([]),
  runSummary: Object.freeze([]),
});

/** Where a placement's target came from. */
export type FocusPlacementSource =
  | 'option'
  | 'marker'
  | 'screen-selector'
  | 'first-focusable'
  | 'container'
  | 'none';

/** The outcome of a placement. */
export interface FocusPlacement {
  /** Screen the placement was made for. */
  readonly screen: ScreenName;

  /** Element that now holds focus, or `null` where none does. */
  readonly element: FocusableElement | null;

  /** Which step of the chain supplied the target. */
  readonly source: FocusPlacementSource;

  /** Whether the element reported holding focus afterwards. */
  readonly focused: boolean;
}

/** Options accepted by `focusInitial`. */
export interface FocusInitialOptions extends ReducedMotionOptions {
  /** Sink the failures are reported through. */
  readonly reporter?: UiReporter;

  /** Short label naming the caller, carried into every report. */
  readonly context?: string;

  /**
   * Target chosen by the caller, as an element or as a selector resolved
   * inside the container. Takes precedence over every other step.
   */
  readonly initialFocus?: FocusableElement | string | null;

  /** Whether the target is scrolled into view. Defaults to `true`. */
  readonly scrollIntoView?: boolean;
}

/**
 * Resolves one selector inside a container, without throwing.
 *
 * @param container Container the selector is evaluated inside.
 * @param selector Selector to evaluate.
 * @param reporter Contained sink.
 * @param context Label naming the caller.
 * @returns The element, or `null`.
 */
function queryInside(
  container: Element,
  selector: string,
  reporter: UiReporter,
  context: string,
): FocusableElement | null {
  const found = resolveMount<Element>(selector, {
    root: container,
    reporter,
    context,
    name: selector,
  });

  return found !== null && isFocusableElement(found) ? found : null;
}

/**
 * Whether the markup made a container itself a focus target.
 *
 * @param container Container to test.
 * @returns Whether it carries a `tabindex`, so focus may land on it.
 */
function isContainerFocusable(container: Element): boolean {
  return tabIndexAttributeOf(container) !== null;
}

/**
 * Places focus deterministically for a screen the router has just activated.
 *
 * Called explicitly by the router on a transition. Nothing in this module
 * observes the document, so no DOM change moves focus on its own.
 *
 * @param screen Screen being activated.
 * @param container Container the router injects for that screen.
 * @param options Sink, context label, chosen target, motion value and scroll
 *   switch.
 * @returns What was focused and which step supplied it.
 */
export function focusInitial(
  screen: ScreenName,
  container: Element | null | undefined,
  options: FocusInitialOptions = {},
): FocusPlacement {
  const reporter = createSafeUiReporter(options.reporter ?? NOOP_UI_REPORTER);
  const context = options.context ?? FOCUS_CONTEXT;
  const reducedMotion = resolveReducedMotion(options, reporter);
  const fields: UiReportFields = { context, screen };
  const nothing: FocusPlacement = Object.freeze({
    screen,
    element: null,
    source: 'none',
    focused: false,
  });

  if (!isScreenName(screen)) {
    reporter.log('warn', 'focus placement asked for an unknown screen', {
      context,
      screen: String(screen),
    });
    reporter.count(METRIC_PLACEMENT_EMPTY, { context, cause: 'bad-screen' });

    return nothing;
  }

  if (container === null || container === undefined) {
    reporter.log('warn', 'focus placement container is absent', fields);
    reporter.count(METRIC_PLACEMENT_EMPTY, {
      ...fields,
      cause: 'no-container',
    });

    return nothing;
  }

  if (!isElementLike(container)) {
    reporter.log('warn', 'focus placement container is not an element', {
      ...fields,
      container: describeElement(container),
    });
    reporter.count(METRIC_PLACEMENT_EMPTY, {
      ...fields,
      cause: 'no-container',
    });

    return nothing;
  }

  const attempts: readonly {
    readonly source: FocusPlacementSource;
    readonly element: FocusableElement | null;
  }[] = [
    {
      source: 'option',
      element:
        typeof options.initialFocus === 'string'
          ? queryInside(container, options.initialFocus, reporter, context)
          : (options.initialFocus ?? null),
    },
    {
      source: 'marker',
      element: queryInside(
        container,
        FOCUS_INITIAL_SELECTOR,
        NOOP_UI_REPORTER,
        context,
      ),
    },
    {
      source: 'screen-selector',
      element: SCREEN_INITIAL_FOCUS[screen].reduce<FocusableElement | null>(
        (carried, selector) =>
          carried ??
          queryInside(container, selector, NOOP_UI_REPORTER, context),
        null,
      ),
    },
    {
      source: 'first-focusable',
      element:
        collectFocusable(container, { reporter: NOOP_UI_REPORTER, context })[
          0
        ] ?? null,
    },
    {
      source: 'container',
      element:
        isContainerFocusable(container) && isFocusableElement(container)
          ? container
          : null,
    },
  ];

  for (const attempt of attempts) {
    if (attempt.element === null) {
      continue;
    }

    const focused = applyFocus(attempt.element, {
      reporter,
      context,
      reducedMotion,
      scrollIntoView: options.scrollIntoView,
      fields: { screen, source: attempt.source },
    });

    if (focused) {
      return Object.freeze({
        screen,
        element: attempt.element,
        source: attempt.source,
        focused: true,
      });
    }
  }

  reporter.log('warn', 'no focusable target for screen', {
    ...fields,
    container: describeElement(container),
  });
  reporter.count(METRIC_NO_FOCUSABLE, { ...fields, cause: 'placement' });
  reporter.count(METRIC_PLACEMENT_EMPTY, { ...fields, cause: 'no-target' });

  return nothing;
}

/** `event.key` of the two keys a trap reads. */
const KEY_TAB = 'Tab';

/** `event.key` of the dismissal key a trap forwards to its callback. */
const KEY_ESCAPE = 'Escape';

/** Attribute form of the inertness a background container receives. */
const INERT_ATTRIBUTE = 'inert';

/** Options accepted by `trap` and by `FocusManager.trap`. */
export interface FocusTrapOptions extends ReducedMotionOptions {
  /** Sink the failures are reported through. */
  readonly reporter?: UiReporter;

  /** Short label naming the caller, carried into every report. */
  readonly context?: string;

  /**
   * Name for the trapped surface, carried into every report. Defaults to a
   * description of the container.
   */
  readonly label?: string;

  /**
   * Element focus moves to on engaging, as an element or as a selector
   * resolved inside the container. Defaults to the first focusable descendant.
   */
  readonly initialFocus?: FocusableElement | string | null;

  /**
   * Element focus falls back to on release where the recorded restore target
   * has detached, as an element or as a selector resolved against the
   * document.
   */
  readonly restoreFocusTo?: FocusableElement | string | null;

  /**
   * Invoked when Escape is pressed while the trap holds focus. No input event
   * is emitted from here: src/input/keymap.ts owns the `cancel` and
   * `closeSettings` vocabulary, and the router decides what the key means for
   * the screen in force.
   */
  readonly onEscape?: (event: KeyboardEvent) => void;

  /**
   * Containers made inert for the trap's lifetime. Applied only to the
   * elements the caller supplies; nothing is inferred by walking the document,
   * and a container that holds the trapped container is refused.
   */
  readonly inertBackground?: readonly (Element | null | undefined)[];

  /** Whether focus targets are scrolled into view. Defaults to `true`. */
  readonly scrollIntoView?: boolean;
}

/** A trap that has engaged. */
export interface FocusTrapHandle {
  /** Container focus is held inside. */
  readonly container: Element;

  /** Name carried into this trap's reports. */
  readonly label: string;

  /** Whether the trap is still engaged. */
  isActive(): boolean;

  /** The focusable descendants, in DOM order, as they are now. */
  focusables(): readonly FocusableElement[];

  /**
   * Moves focus to the first focusable descendant.
   *
   * @returns Whether focus moved.
   */
  focusFirst(): boolean;

  /**
   * Moves focus to the last focusable descendant.
   *
   * @returns Whether focus moved.
   */
  focusLast(): boolean;

  /**
   * Releases the trap, restores focus and lifts every inertness it applied.
   * Calling it more than once is harmless.
   *
   * @param options Whether to restore focus. Omitted, focus is restored.
   */
  release(options?: FocusTrapReleaseOptions): void;
}

/**
 * How one release behaves.
 *
 * ADDED so a caller that places focus itself immediately afterwards can decline
 * the restore. DL-FOCUS-05.
 */
export interface FocusTrapReleaseOptions {
  /**
   * Whether to move focus back to the element the trap recorded, or to the
   * configured fallback. Defaults to `true`.
   *
   * `false` is for the caller that is ABOUT TO place focus itself: a restore it
   * is going to supersede one tick later can only either flicker focus through
   * an element the user never sees, or fail and report a failure that describes
   * nothing wrong.
   */
  readonly restoreFocus?: boolean;

  /**
   * Invoked once during the release, AFTER the inertness this trap applied has
   * been lifted and BEFORE focus is restored.
   *
   * ADDED for the caller that owns whether the restore target is PRESENTED: a
   * trigger inside the background this trap made inert cannot be re-presented
   * until the lift has happened, and has to be re-presented before the restore
   * is attempted rather than after it has already failed. A throwing callback
   * is reported and the release completes. DL-FOCUS-08.
   */
  readonly beforeRestore?: () => void;
}

/** What the enclosing manager supplies to a trap it owns. */
interface TrapHost {
  /** Whether this trap is the top of the manager's stack. */
  readonly isTopmost: () => boolean;

  /** Invoked once, after the trap has released. */
  readonly onReleased: () => void;
}

/**
 * Applies inertness to the background containers a caller supplied.
 *
 * @param containers Containers the caller supplied.
 * @param trapped Container focus is held inside, which is never made inert.
 * @param reporter Contained sink.
 * @param fields Report fields.
 * @returns The containers that were made inert by this call.
 */
function applyInertBackground(
  containers: readonly (Element | null | undefined)[] | undefined,
  trapped: Element,
  reporter: UiReporter,
  fields: UiReportFields,
): readonly Element[] {
  if (containers === undefined) {
    return Object.freeze([]);
  }

  const applied: Element[] = [];

  for (const container of containers) {
    if (container === null || container === undefined) {
      reporter.log('warn', 'inert background container is absent', fields);
      continue;
    }

    if (!isElementLike(container)) {
      continue;
    }

    if (container === trapped || container.contains(trapped)) {
      reporter.log(
        'warn',
        'inert background container holds the trapped container',
        { ...fields, background: describeElement(container) },
      );
      continue;
    }

    if (container.hasAttribute(INERT_ATTRIBUTE)) {
      // Already inert, and not by this trap: leave it to whoever set it.
      continue;
    }

    try {
      container.setAttribute(INERT_ATTRIBUTE, '');

      if (container instanceof HTMLElement) {
        container.inert = true;
      }

      applied.push(container);
    } catch (error: unknown) {
      reporter.error('inert background container could not be set', error, {
        ...fields,
        background: describeElement(container),
      });
    }
  }

  return Object.freeze(applied);
}

/**
 * Lifts the inertness a trap applied, and only that.
 *
 * @param containers Containers this trap made inert.
 * @param reporter Contained sink.
 * @param fields Report fields.
 */
function liftInertBackground(
  containers: readonly Element[],
  reporter: UiReporter,
  fields: UiReportFields,
): void {
  for (const container of containers) {
    try {
      container.removeAttribute(INERT_ATTRIBUTE);

      if (container instanceof HTMLElement) {
        container.inert = false;
      }
    } catch (error: unknown) {
      reporter.error('inert background container could not be lifted', error, {
        ...fields,
        background: describeElement(container),
      });
    }
  }
}

/**
 * Engages a trap, wiring it to the manager that owns it.
 *
 * @param container Container focus is held inside.
 * @param options Caller's options.
 * @param host Predicates and callbacks from the owning manager.
 * @returns The engaged trap, or `null` where it refused to engage.
 */
function engageTrap(
  container: Element | null | undefined,
  options: FocusTrapOptions,
  host: TrapHost,
): FocusTrapHandle | null {
  const reporter = createSafeUiReporter(options.reporter ?? NOOP_UI_REPORTER);
  const context = options.context ?? FOCUS_CONTEXT;

  if (container === null || container === undefined) {
    reporter.log('warn', 'focus trap container is absent', { context });
    reporter.count(METRIC_TRAP_NO_CONTAINER, { context, cause: 'absent' });

    return null;
  }

  if (!isElementLike(container)) {
    reporter.log('warn', 'focus trap container is not an element', {
      context,
      container: describeElement(container),
    });
    reporter.count(METRIC_TRAP_NO_CONTAINER, { context, cause: 'not-element' });

    return null;
  }

  const label = options.label ?? describeElement(container);
  const fields: UiReportFields = { context, trap: label };
  const collectOptions: CollectFocusableOptions = {
    reporter: NOOP_UI_REPORTER,
    context,
  };
  const readFocusables = (): readonly FocusableElement[] =>
    collectFocusable(container, collectOptions);
  const initial = readFocusables();

  if (initial.length === 0) {
    reporter.log(
      'warn',
      'focus trap refused: container holds nothing focusable',
      { ...fields, container: describeElement(container) },
    );
    reporter.count(METRIC_TRAP_EMPTY, fields);
    reporter.count(METRIC_NO_FOCUSABLE, { ...fields, cause: 'trap' });

    return null;
  }

  const doc = ownerDocumentOf(container);
  const reducedMotion = resolveReducedMotion(options, reporter);
  const previous: unknown = doc === null ? null : doc.activeElement;
  const recorded: FocusableElement | null = isFocusableElement(previous)
    ? previous
    : null;

  /** Whether an element is the trapped container or lies inside it. */
  const heldByContainer = (element: Element): boolean =>
    container === element ||
    (typeof container.contains === 'function' && container.contains(element));

  /**
   * Whether the recorded element is the document body.
   *
   * Skipping it hands the release straight to the fallback, which is what
   * should have served it in the first place.
   */
  const isDocumentBody = (element: unknown): boolean =>
    doc !== null && element === doc.body;

  // Rule: a recorded target inside the container is not a restore target.
  const insideContainer =
    recorded !== null && isElementLike(recorded) && heldByContainer(recorded);
  const bodyRecorded = recorded !== null && isDocumentBody(recorded);

  const restoreTarget: FocusableElement | null =
    insideContainer || bodyRecorded ? null : recorded;

  if (insideContainer) {
    reporter.log(
      'warn',
      'focus trap restore target lies inside the trapped container',
      { ...fields, target: describeElement(recorded) },
    );
    reporter.count(METRIC_RESTORE_INSIDE, fields);
  } else if (bodyRecorded) {
    reporter.count(METRIC_RESTORE_BODY, fields);
  }
  const inerted = applyInertBackground(
    options.inertBackground,
    container,
    reporter,
    fields,
  );

  let released = false;

  const focusAt = (element: FocusableElement | null): boolean =>
    applyFocus(element, {
      reporter,
      context,
      reducedMotion,
      scrollIntoView: options.scrollIntoView,
      fields: { trap: label },
    });

  const focusFirst = (): boolean => {
    const focusables = readFocusables();

    return focusAt(focusables[0] ?? null);
  };

  const focusLast = (): boolean => {
    const focusables = readFocusables();

    return focusAt(focusables[focusables.length - 1] ?? null);
  };

  /**
   * Cycles focus for a Tab press. Wraps in both directions, so focus escapes
   * the container neither forwards nor backwards.
   */
  const cycle = (backwards: boolean): void => {
    const focusables = readFocusables();

    if (focusables.length === 0) {
      reporter.log('warn', 'focus trap has nothing left to cycle', fields);
      reporter.count(METRIC_NO_FOCUSABLE, { ...fields, cause: 'cycle' });

      return;
    }

    const active: unknown = doc === null ? null : doc.activeElement;
    const current =
      active === null || !isElementLike(active)
        ? -1
        : focusables.findIndex((element) => element === active);

    if (current === -1) {
      focusAt(backwards ? focusables[focusables.length - 1] : focusables[0]);

      return;
    }

    const next = backwards
      ? (current - 1 + focusables.length) % focusables.length
      : (current + 1) % focusables.length;

    focusAt(focusables[next]);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (released || !host.isTopmost()) {
      return;
    }

    if (event.key === KEY_TAB) {
      event.preventDefault();
      cycle(event.shiftKey === true);

      return;
    }

    if (event.key === KEY_ESCAPE && options.onEscape !== undefined) {
      event.preventDefault();
      event.stopPropagation();

      try {
        options.onEscape(event);
      } catch (error: unknown) {
        reporter.error('focus trap escape handler threw', error, fields);
      }
    }
  };

  /**
   * ADDED: pulls focus back after a press that left it outside the container.
   *
   * A press on the backdrop — or on any part of a modal surface that takes no
   * focus of its own — moves the active element to the document body, and the
   * body is not a focus TARGET, so `onFocusIn` below never sees it: the
   * handler that guards this trap reacts to focus ARRIVING somewhere, and
   * nothing arrives. This reads the active element after the press instead.
   *
   * Bound in the BUBBLE phase, so it runs after the handlers the press is for:
   * a press on a control that transitions the screen releases this trap first,
   * and the release makes this a no-op rather than a fight over focus. And it
   * is the press, not the pointer down, that is listened for, so text
   * selection inside the surface — the copyable seed of the run summary — is
   * untouched. DL-FOCUS-07.
   *
   * @param event The `click` the document received.
   */
  const onClick = (event: Event): void => {
    if (released || !host.isTopmost()) {
      return;
    }

    const active: unknown = doc === null ? null : doc.activeElement;

    // Focus is still inside: the press placed it, or never moved it.
    if (
      active !== null &&
      isElementLike(active) &&
      heldByContainer(active)
    ) {
      return;
    }

    const focusables = readFocusables();

    if (focusables.length === 0) {
      return;
    }

    // The marker a screen module writes, then the first focusable element —
    // the same order the trap engaged on.
    const marked: unknown =
      typeof container.querySelector === 'function'
        ? container.querySelector(FOCUS_INITIAL_SELECTOR)
        : null;

    const preferred: FocusableElement | null = isFocusableElement(marked)
      ? marked
      : (focusables[0] ?? null);

    if (preferred === null || !focusAt(preferred)) {
      return;
    }

    reporter.count(METRIC_TRAP_RECLAIMED, {
      ...fields,
      target: describeElement(event.target),
    });
  };

  /**
   * Pulls focus back when it lands outside the container. Applied only while
   * this trap is the top of the stack, so a nested dialog is not fought.
   */
  const onFocusIn = (event: Event): void => {
    if (released || !host.isTopmost()) {
      return;
    }

    const target: unknown = event.target;

    if (isElementLike(target) && container.contains(target)) {
      return;
    }

    const focusables = readFocusables();

    if (focusables.length === 0) {
      return;
    }

    focusAt(focusables[0]);
  };

  if (doc !== null) {
    doc.addEventListener('keydown', onKeyDown, true);
    doc.addEventListener('focusin', onFocusIn, true);

    // ADDED: in the bubble phase, unlike the two above. DL-FOCUS-07.
    doc.addEventListener('click', onClick);
  } else {
    reporter.log('warn', 'focus trap has no document to listen on', fields);
  }

  const requested =
    typeof options.initialFocus === 'string'
      ? queryInside(container, options.initialFocus, reporter, context)
      : (options.initialFocus ?? null);

  if (!focusAt(requested)) {
    focusFirst();
  }

  reporter.count(METRIC_TRAP_ENGAGED, fields);
  reporter.log('debug', 'focus trap engaged', {
    ...fields,
    focusables: initial.length,
  });

  const restore = (): void => {
    if (restoreTarget !== null) {
      if (!isConnectedNode(restoreTarget)) {
        reporter.log('warn', 'focus trap restore target has detached', {
          ...fields,
          target: describeElement(restoreTarget),
        });
        reporter.count(METRIC_RESTORE_DETACHED, fields);
      } else if (focusAt(restoreTarget)) {
        return;
      } else {
        // Connected, yet it did not take focus: a `[hidden]` ancestor, or a
        // rule that removes it from the rendering.
        reporter.log('warn', 'focus trap restore target did not take focus', {
          ...fields,
          target: describeElement(restoreTarget),
        });
        reporter.count(METRIC_RESTORE_FAILED, { ...fields, stage: 'recorded' });
      }
    }

    const fallback =
      typeof options.restoreFocusTo === 'string'
        ? resolveMount<Element>(options.restoreFocusTo, {
            root: doc,
            reporter,
            context,
            name: options.restoreFocusTo,
          })
        : (options.restoreFocusTo ?? null);

    if (fallback === null || !isFocusableElement(fallback)) {
      return;
    }

    if (!focusAt(fallback)) {
      reporter.log('warn', 'focus trap restore fallback did not take focus', {
        ...fields,
        target: describeElement(fallback),
      });
      reporter.count(METRIC_RESTORE_FAILED, { ...fields, stage: 'fallback' });
    }
  };

  const release = (releaseOptions: FocusTrapReleaseOptions = {}): void => {
    if (released) {
      return;
    }

    released = true;

    if (doc !== null) {
      doc.removeEventListener('keydown', onKeyDown, true);
      doc.removeEventListener('focusin', onFocusIn, true);
      doc.removeEventListener('click', onClick);
    }

    liftInertBackground(inerted, reporter, fields);

    // Between the lift above and the restore below, which is the only window in
    // which a caller can re-present a restore target that its own presentation
    // layer withholds while the background is inert. DL-FOCUS-08.
    if (releaseOptions.beforeRestore !== undefined) {
      try {
        releaseOptions.beforeRestore();
      } catch (error) {
        reporter.error('focus trap release callback threw', error, fields);
      }
    }

    // `restoreFocus: false` is the caller declaring it places focus itself.
    // The restore is skipped outright rather than attempted and forgiven, so
    // no failure is reported for a restore nobody wanted. DL-FOCUS-05.
    if (releaseOptions.restoreFocus !== false) {
      restore();
    }

    reporter.count(METRIC_TRAP_RELEASED, fields);
    host.onReleased();
  };

  return Object.freeze({
    container,
    label,
    isActive: (): boolean => !released,
    focusables: readFocusables,
    focusFirst,
    focusLast,
    release,
  });
}

/** Options accepted by `createFocusManager`. */
export interface FocusManagerOptions extends ReducedMotionOptions {
  /** Sink every failure is reported through. */
  readonly reporter?: UiReporter;

  /** Short label naming the caller, carried into every report. */
  readonly context?: string;

  /**
   * Provider consulted once per placement, so a preference changed mid-run is
   * observed. Overrides `reducedMotion` and `motionSetting`; where it is
   * absent, those two decide, and where none is given the platform query does.
   */
  readonly isReducedMotion?: () => boolean;

  /** Whether focus targets are scrolled into view. Defaults to `true`. */
  readonly scrollIntoView?: boolean;
}

/**
 * The focus surface a caller holds and drives.
 *
 * Traps nest last-in first-out, so a settings dialog opened from the reward
 * screen releases before the reward screen's own trap does, and only the top
 * of the stack contains focus.
 */
export interface FocusManager {
  /**
   * Collects the focusable descendants of a root, in DOM order.
   *
   * @param root Container the search runs inside.
   * @param options Overrides for this call.
   */
  collectFocusable(
    root: FocusRoot | null | undefined,
    options?: CollectFocusableOptions,
  ): readonly FocusableElement[];

  /**
   * Places focus deterministically for a screen the router has activated.
   *
   * @param screen Screen being activated.
   * @param container Container the router injects.
   * @param options Overrides for this call.
   */
  focusInitial(
    screen: ScreenName,
    container: Element | null | undefined,
    options?: FocusInitialOptions,
  ): FocusPlacement;

  /**
   * Engages a trap and pushes it onto the stack.
   *
   * @param container Container focus is held inside.
   * @param options Initial target, Escape callback, inert backgrounds and
   *   restore fallback.
   * @returns The engaged trap, or `null` where it refused to engage — an
   *   absent container, or one holding nothing focusable.
   */
  trap(
    container: Element | null | undefined,
    options?: FocusTrapOptions,
  ): FocusTrapHandle | null;

  /** The trap currently containing focus, or `null`. */
  activeTrap(): FocusTrapHandle | null;

  /** How many traps are stacked. */
  trapDepth(): number;

  /** Releases every trap, innermost first. */
  releaseAll(): void;

  /**
   * Releases every trap, removes every listener and clears the stack. Every
   * method afterwards is a reported no-op except the readers, which report an
   * empty stack.
   */
  destroy(): void;
}

/**
 * Creates the focus manager.
 *
 * @param options Sink, context label, motion source and scroll switch.
 * @returns A manager owning its own trap stack. Nothing is held at module
 *   scope, so two managers in one document — the application's, and a test's —
 *   do not observe each other.
 */
export function createFocusManager(
  options: FocusManagerOptions = {},
): FocusManager {
  const reporter = createSafeUiReporter(options.reporter ?? NOOP_UI_REPORTER);
  const context = options.context ?? FOCUS_CONTEXT;

  /**
   * One stacked trap. The claim is pushed before the trap engages, so a trap
   * already on the stack sees itself displaced while the new one is still
   * moving focus into its own container.
   */
  interface TrapEntry {
    readonly claim: object;
    handle: FocusTrapHandle | null;
  }

  const stack: TrapEntry[] = [];

  let destroyed = false;

  /** Reads the effective motion value for one call. */
  const motionFor = (call: ReducedMotionOptions): boolean => {
    if (typeof call.reducedMotion === 'boolean') {
      return call.reducedMotion;
    }

    if (options.isReducedMotion !== undefined) {
      try {
        return options.isReducedMotion() === true;
      } catch (error: unknown) {
        reporter.error('reduced-motion provider threw', error, { context });
      }
    }

    return resolveReducedMotion(
      {
        reducedMotion: options.reducedMotion,
        motionSetting: call.motionSetting ?? options.motionSetting,
      },
      reporter,
    );
  };

  const topEntry = (): TrapEntry | null =>
    stack.length === 0 ? null : (stack[stack.length - 1] ?? null);

  const activeTrap = (): FocusTrapHandle | null => topEntry()?.handle ?? null;

  const removeClaim = (claim: object): void => {
    const index = stack.findIndex((entry) => entry.claim === claim);

    if (index !== -1) {
      stack.splice(index, 1);
    }
  };

  /** Releases every engaged trap, innermost first. */
  const releaseAll = (): void => {
    // Innermost first, so each trap restores to the target recorded before it
    // engaged and the outermost restores last.
    while (stack.length > 0) {
      const top = stack[stack.length - 1];

      if (top === undefined) {
        stack.pop();
        continue;
      }

      top.handle?.release();

      if (stack[stack.length - 1] === top) {
        // An entry that did not remove itself is dropped, so the loop cannot
        // spin.
        stack.pop();
      }
    }
  };

  return Object.freeze({
    collectFocusable(
      root: FocusRoot | null | undefined,
      callOptions: CollectFocusableOptions = {},
    ): readonly FocusableElement[] {
      return collectFocusable(root, {
        reporter,
        context,
        ...callOptions,
      });
    },

    focusInitial(
      screen: ScreenName,
      container: Element | null | undefined,
      callOptions: FocusInitialOptions = {},
    ): FocusPlacement {
      if (destroyed) {
        reporter.log('warn', 'focus placement on a destroyed manager', {
          context,
          screen: String(screen),
        });

          return Object.freeze({
          screen,
          element: null,
          source: 'none',
          focused: false,
        });
      }

      return focusInitial(screen, container, {
        reporter,
        context,
        scrollIntoView: options.scrollIntoView,
        ...callOptions,
        reducedMotion: motionFor(callOptions),
      });
    },

    trap(
      container: Element | null | undefined,
      callOptions: FocusTrapOptions = {},
    ): FocusTrapHandle | null {
      if (destroyed) {
        reporter.log('warn', 'focus trap requested on a destroyed manager', {
          context,
          container: describeElement(container),
        });
        reporter.count(METRIC_TRAP_NO_CONTAINER, {
          context,
          cause: 'destroyed',
        });

        return null;
      }

      // The claim is pushed first, so an already-stacked trap stops
      // considering itself topmost before this one moves focus into its
      // container.
      const entry: TrapEntry = { claim: {}, handle: null };

      stack.push(entry);

      const handle = engageTrap(
        container,
        {
          reporter,
          context,
          scrollIntoView: options.scrollIntoView,
          ...callOptions,
          reducedMotion: motionFor(callOptions),
        },
        {
          isTopmost: (): boolean => topEntry()?.claim === entry.claim,
          onReleased: (): void => {
            removeClaim(entry.claim);
          },
        },
      );

      if (handle === null) {
        removeClaim(entry.claim);

        return null;
      }

      entry.handle = handle;

      return handle;
    },

    activeTrap,

    trapDepth: (): number => stack.length,

    releaseAll,

    destroy(): void {
      if (destroyed) {
        return;
      }

      releaseAll();
      stack.length = 0;
      destroyed = true;
      reporter.log('debug', 'focus manager destroyed', { context });
    },
  });
}

/**
 * Engages a single trap with no enclosing manager.
 *
 * The standalone form: it owns a private manager whose stack holds only this
 * trap, so it is always its own topmost, and `release` disposes of that
 * manager as well.
 *
 * `createFocusManager` is the form a router that nests dialogs calls: its
 * stack is shared across every trap it owns and releases last-in first-out.
 *
 * @param container Container focus is held inside.
 * @param options Initial target, Escape callback, inert backgrounds and
 *   restore fallback.
 * @returns The engaged trap, or `null` where it refused to engage.
 */
export function trap(
  container: Element | null | undefined,
  options: FocusTrapOptions = {},
): FocusTrapHandle | null {
  const manager = createFocusManager({
    reporter: options.reporter,
    context: options.context,
    reducedMotion: options.reducedMotion,
    motionSetting: options.motionSetting,
    scrollIntoView: options.scrollIntoView,
  });
  const handle = manager.trap(container, options);

  if (handle === null) {
    manager.destroy();

    return null;
  }

  return Object.freeze({
    container: handle.container,
    label: handle.label,
    isActive: (): boolean => handle.isActive(),
    focusables: (): readonly FocusableElement[] => handle.focusables(),
    focusFirst: (): boolean => handle.focusFirst(),
    focusLast: (): boolean => handle.focusLast(),
    release: (): void => {
      handle.release();
      manager.destroy();
    },
  });
}

/** Selector index.html declares the parallel board host at. */
export const PARALLEL_BOARD_HOST_SELECTOR = '#board-a11y';

/**
 * Media query matching the stylesheet's single breakpoint.
 *
 * The same condition `@mixin smaller($width)` emits at style/helpers.scss
 * L71-L75, with the length read from `mobileThreshold`. No further tier and no
 * further breakpoint is introduced.
 */
export const MOBILE_SCALE_QUERY =
  `screen and (max-width: ${mobileThreshold}px)`;

/** Content named for a cell holding no tile. */
export const EMPTY_CELL_LABEL = 'empty';

/** `event.key` values that activate a cell. */
const ACTIVATION_KEYS: readonly string[] = Object.freeze([
  'Enter',
  ' ',
  'Spacebar',
]);

/** Attribute carrying a cell's zero-based column, for addressing and tests. */
const CELL_X_ATTRIBUTE = 'data-cell-x';

/** Attribute carrying a cell's zero-based row. */
const CELL_Y_ATTRIBUTE = 'data-cell-y';

/**
 * One cell of the board, over primitives only.
 *
 * No engine type is imported: the router or a screen reduces the by-reference
 * board to these descriptors before calling `update`, so this module observes
 * no `Tile` and no `Grid`.
 */
export interface ParallelCell {
  /** Zero-based column, as the engine indexes it. */
  readonly x: number;

  /** Zero-based row, as the engine indexes it. */
  readonly y: number;

  /** Tile value, or `null` where the cell holds no tile. */
  readonly value: number | null;
}

/** Options accepted by `createParallelBoardLayer`. */
export interface ParallelBoardLayerOptions extends ReducedMotionOptions {
  /** Sink every failure is reported through. */
  readonly reporter?: UiReporter;

  /** Short label naming the caller, carried into every report. */
  readonly context?: string;

  /**
   * Host the layer builds into, as an element or as a selector. Defaults to
   * `PARALLEL_BOARD_HOST_SELECTOR`, and is overridden by the argument to
   * `mount`.
   */
  readonly host?: Element | string | null;

  /** Document a selector is resolved against. Defaults to the ambient one. */
  readonly document?: Document | null;

  /**
   * Geometry scale the cell boxes are laid out at. `'auto'`, the default,
   * follows `MOBILE_SCALE_QUERY` and re-applies the geometry when it changes.
   */
  readonly scale?: ScaleName | 'auto';

  /**
   * Invoked when Enter or Space is pressed on a focused cell. The keydown
   * listener is registered only where this is supplied, so a layer without it
   * reads no key at all.
   */
  readonly onActivateCell?: (cell: ParallelCell) => void;

  /** Content named for an empty cell. Defaults to `EMPTY_CELL_LABEL`. */
  readonly emptyLabel?: string;
}

/** The parallel board layer. */
export interface ParallelBoardLayer {
  /** Whether the layer holds a resolved host and built cells. */
  isMounted(): boolean;

  /** Cells per row currently built, or `0` while unmounted. */
  boardSize(): number;

  /**
   * Resolves the host and builds the cell counterparts.
   *
   * @param host Host element or selector. A nullish value falls back to the
   *   host given at construction, then to `PARALLEL_BOARD_HOST_SELECTOR`.
   * @param boardSize Cells per row. An integer from 1 through MAX_BOARD_SIZE
   *   of src/config/default-config.ts; any other value is reported and refused
   *   before any element is created.
   * @returns Whether the layer mounted. A miss is reported and leaves every
   *   other method a working no-op.
   */
  mount(host: Element | string | null | undefined, boardSize: number): boolean;

  /**
   * Tears the cell counterparts down and recreates them at a new size.
   *
   * @param boardSize Cells per row, bounded exactly as `mount` bounds it.
   * @returns Whether the rebuild completed.
   */
  rebuild(boardSize: number): boolean;

  /**
   * Applies the board's contents.
   *
   * Runs once per commit, never per frame. Only the cells whose value changed
   * since the last call are written, and no subtree is recreated.
   *
   * @param cells Occupied cells. Any cell absent from the list is named
   *   empty.
   */
  update(cells: readonly ParallelCell[]): void;

  /**
   * The counterpart addressing one board cell.
   *
   * @param x Zero-based column.
   * @param y Zero-based row.
   * @returns The element, or `null` where the coordinate addresses no cell.
   */
  cellAt(x: number, y: number): HTMLElement | null;

  /**
   * Moves focus to one cell counterpart.
   *
   * @param x Zero-based column.
   * @param y Zero-based row.
   * @returns Whether focus moved.
   */
  focusCell(x: number, y: number): boolean;

  /**
   * Removes the cell counterparts and every listener, and restores the
   * attributes the layer added to the host. Calling it more than once is
   * harmless.
   */
  unmount(): void;
}

/** The part of a media-query list this module uses. */
interface ScaleQueryList {
  /** Whether the query currently matches. */
  readonly matches: boolean;

  /** Modern subscription. */
  readonly addEventListener?: (
    type: 'change',
    listener: () => void,
  ) => void;

  /** Modern unsubscription. */
  readonly removeEventListener?: (
    type: 'change',
    listener: () => void,
  ) => void;

  /** Subscription on engines predating the modern form. */
  readonly addListener?: (listener: () => void) => void;

  /** Unsubscription on engines predating the modern form. */
  readonly removeListener?: (listener: () => void) => void;
}

/**
 * Reads `key` off an event without narrowing the listener's parameter.
 *
 * @param event Event to read.
 * @returns The key, or `null` where the event carries none.
 */
function keyOf(event: Event): string | null {
  const source: unknown = event;

  if (source === null || typeof source !== 'object') {
    return null;
  }

  const candidate: { readonly key?: unknown } = source;

  return typeof candidate.key === 'string' ? candidate.key : null;
}

/**
 * Narrows a value to a media-query list.
 *
 * @param value Candidate list.
 * @returns Whether `value` carries a boolean `matches`.
 */
function isScaleQueryList(value: unknown): value is ScaleQueryList {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const candidate: { readonly matches?: unknown } = value;

  return typeof candidate.matches === 'boolean';
}

/**
 * Opens the breakpoint query, without throwing.
 *
 * @param view Window the query is evaluated against, or `null`.
 * @param reporter Contained sink.
 * @param context Label naming the caller.
 * @returns The list, or `null` where the platform offers no `matchMedia`.
 */
function openScaleQuery(
  view: Window | null,
  reporter: UiReporter,
  context: string,
): ScaleQueryList | null {
  if (view === null || typeof view.matchMedia !== 'function') {
    return null;
  }

  try {
    const list: unknown = view.matchMedia(MOBILE_SCALE_QUERY);

    return isScaleQueryList(list) ? list : null;
  } catch (error: unknown) {
    reporter.error('board scale query could not be evaluated', error, {
      context,
      query: MOBILE_SCALE_QUERY,
    });

    return null;
  }
}

/**
 * The geometry scale one name resolves to, for the dimension the stylesheet
 * declares.
 *
 * @param name Scale name.
 * @returns The scale declared in ../../theme/tokens.
 */
function geometryFor(name: ScaleName): GeometryScale {
  return geometryScales[name];
}

/**
 * The geometry scale a board of `boardSize` cells per row occupies, at one
 * scale.
 *
 * @param name Scale name.
 * @param boardSize Cells per row.
 * @param reporter Contained sink.
 * @param context Label naming the caller.
 * @returns The resolved scale, or the declared one where the dimension
 *   yields no usable tile length.
 */
function geometryForBoard(
  name: ScaleName,
  boardSize: number,
  reporter: UiReporter,
  context: string,
): GeometryScale {
  const declared = geometryFor(name);

  if (boardSize === declared.gridRowCells) {
    return declared;
  }

  const fallback = (cause: string): GeometryScale => {
    reporter.log('warn', 'board geometry fell back to the declared scale', {
      context,
      scale: name,
      boardSize,
      cause,
    });
    reporter.count(METRIC_BOARD_SCALE_FALLBACK, { context, cause });

    return declared;
  };

  if (!isBoardSize(boardSize)) {
    return fallback('bad-size');
  }

  try {
    const resolved = createGeometryScale({
      fieldWidth: declared.fieldWidth,
      gridSpacing: declared.gridSpacing,
      gridRowCells: boardSize,
      tileBorderRadius: declared.tileBorderRadius,
      gameContainerMarginTop: declared.gameContainerMarginTop,
    });

    // A dimension large enough to consume the field in gutters alone leaves no
    // room for a cell, and a zero-area counterpart is exactly what this layer
    // exists to avoid.
    return resolved.tileSize > 0 ? resolved : fallback('no-room');
  } catch (error: unknown) {
    reporter.error('board geometry scale could not be resolved', error, {
      context,
      scale: name,
      boardSize,
    });
    reporter.count(METRIC_BOARD_SCALE_FALLBACK, {
      context,
      cause: 'rejected',
    });

    return declared;
  }
}

/**
 * Whether a value is a usable board dimension.
 *
 * @param value Candidate size.
 * @returns Whether it is an integer from 1 through MAX_BOARD_SIZE.
 */
function isBoardSize(value: unknown): value is number {
  return isSupportedBoardSize(value);
}

/**
 * The accessible name of one cell.
 *
 * ROW FIRST, then column. This read `Column x, row y` while
 * `numberOnlyRendererCopy` of ../../render/number-only-renderer.ts read
 * `Row r, column c`, so the two board layers named the same cell in opposite
 * axis order and a user who switched rendering mode had to re-learn the
 * reading. Row-first is the order kept: it is the reading order of the grid,
 * it matches the `role="row"` structure the layer is built from, and it is the
 * order the number-only layer already used. DL-FOCUS-06.
 *
 * @param x Zero-based column.
 * @param y Zero-based row.
 * @param value Tile value, or `null` for an empty cell.
 * @param emptyLabel Content named for an empty cell.
 * @returns The name written to `aria-label`.
 */
function cellLabel(
  x: number,
  y: number,
  value: number | null,
  emptyLabel: string,
): string {
  const content = value === null ? emptyLabel : String(value);

  return `Row ${y + 1}, column ${x + 1}, ${content}`;
}

/**
 * Creates the parallel board layer that stands beside the WebGL canvas.
 *
 * The canvas is one opaque node to assistive technology and carries its own
 * `aria-hidden`; this layer is the semantic counterpart, and nothing here
 * reads or writes any attribute of the canvas.
 *
 * It is not the number-only renderer. That is a rendering mode over its own
 * host, and neither module imports the other.
 *
 * @param options Sink, host, document, scale, activation callback and the
 *   empty-cell wording.
 * @returns A layer that degrades to a working no-op where the host is
 *   absent.
 */
export function createParallelBoardLayer(
  options: ParallelBoardLayerOptions = {},
): ParallelBoardLayer {
  const reporter = createSafeUiReporter(options.reporter ?? NOOP_UI_REPORTER);
  const context = options.context ?? BOARD_CONTEXT;
  const emptyLabel = options.emptyLabel ?? EMPTY_CELL_LABEL;
  const requestedScale = options.scale ?? 'auto';

  /** Host resolved by `mount`, or `null` while unmounted. */
  let host: Element | null = null;

  /** Document the host belongs to. */
  let doc: Document | null = null;

  /** Cells per row currently built. */
  let size = 0;

  /** Cell counterparts in row-major order; index is `y * size + x`. */
  let cells: HTMLElement[] = [];

  /** Value last written to each cell, in the same order. */
  let rendered: (number | null)[] = [];

  /** Scratch array `update` fills, reused so a turn allocates nothing. */
  let pending: (number | null)[] = [];

  /** Breakpoint query, while an automatic scale is in force. */
  let scaleQuery: ScaleQueryList | null = null;

  /** Subscription to `scaleQuery`, so `unmount` can remove exactly it. */
  let scaleListener: (() => void) | null = null;

  /** Delegated activation listener, while one is installed. */
  let activationListener: ((event: Event) => void) | null = null;

  /** Attributes this layer added to the host, so `unmount` restores it. */
  const hostAdded = {
    role: false,
    tabIndex: false,
  };

  /** The scale in force, recomputed whenever the breakpoint changes. */
  const currentScaleName = (): ScaleName => {
    if (requestedScale === 'desktop' || requestedScale === 'mobile') {
      return requestedScale;
    }

    if (scaleQuery !== null) {
      return scaleQuery.matches ? 'mobile' : 'desktop';
    }

    const view = windowOf(host);

    if (view !== null && typeof view.innerWidth === 'number') {
      return view.innerWidth <= mobileThreshold ? 'mobile' : 'desktop';
    }

    return 'desktop';
  };

  /**
   * Writes one cell's explicit box.
   *
   * The only style properties this module sets. Both lengths come from
   * ../../theme/tokens: the box is `tileBoxSize` and the offsets are
   * `tilePositionStep`, the pair style/main.scss lays the visual tiles out
   * with. Logical properties throughout.
   */
  const applyCellGeometry = (
    cell: HTMLElement,
    x: number,
    y: number,
    scale: GeometryScale,
  ): void => {
    try {
      const box = `${scale.tileBoxSize}px`;

      cell.style.position = 'absolute';
      cell.style.inlineSize = box;
      cell.style.blockSize = box;
      cell.style.insetInlineStart = `${tilePositionStep(x, scale)}px`;
      cell.style.insetBlockStart = `${tilePositionStep(y, scale)}px`;
    } catch (error: unknown) {
      // `tilePositionStep` rejects a non-integer or negative index.
      reporter.error('board cell geometry could not be applied', error, {
        context,
        x,
        y,
      });
    }
  };

  /** Re-applies the geometry of every built cell at the scale now in force. */
  const reapplyGeometry = (): void => {
    const scale = geometryForBoard(
      currentScaleName(),
      size,
      reporter,
      context,
    );

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const cell = cells[y * size + x];

        if (cell !== undefined) {
          applyCellGeometry(cell, x, y, scale);
        }
      }
    }
  };

  /** The cell holding focus, or `null` where focus is outside the layer. */
  const focusedCellIndex = (): number => {
    if (host === null || doc === null) {
      return -1;
    }

    const active: unknown = doc.activeElement;

    if (!isElementLike(active) || !host.contains(active)) {
      return -1;
    }

    return cells.findIndex((cell) => cell === active || cell.contains(active));
  };

  /** Reads a cell's coordinates back off its own attributes. */
  const cellDescriptorAt = (index: number): ParallelCell | null => {
    if (size <= 0 || index < 0 || index >= cells.length) {
      return null;
    }

    return {
      x: index % size,
      y: Math.floor(index / size),
      value: rendered[index] ?? null,
    };
  };

  const onActivationKey = (event: Event): void => {
    const handler = options.onActivateCell;

    if (handler === undefined || host === null) {
      return;
    }

    const key = keyOf(event);

    if (key === null || !ACTIVATION_KEYS.includes(key)) {
      return;
    }

    const target: unknown = event.target;

    if (!isElementLike(target)) {
      return;
    }

    const index = cells.findIndex(
      (cell) => cell === target || cell.contains(target),
    );

    if (index === -1) {
      return;
    }

    const descriptor = cellDescriptorAt(index);

    if (descriptor === null) {
      return;
    }

    // Handled only for a cell this module made focusable with `tabindex`.
    event.preventDefault();
    event.stopPropagation();

    try {
      handler(descriptor);
    } catch (error: unknown) {
      reporter.error('board cell activation handler threw', error, {
        context,
        x: descriptor.x,
        y: descriptor.y,
      });
    }
  };

  /** Removes every cell counterpart, leaving the host itself untouched. */
  const clearCells = (): void => {
    for (const cell of cells) {
      const parent = cell.parentNode;

      if (parent !== null) {
        parent.removeChild(cell);
      }
    }

    if (host !== null) {
      while (host.firstChild !== null) {
        host.removeChild(host.firstChild);
      }
    }

    cells = [];
    rendered = [];
    pending = [];
  };

  /**
   * Builds the rows and cells for a size, and returns whether it completed.
   */
  const buildCells = (nextSize: number): boolean => {
    if (host === null || doc === null) {
      return false;
    }

    const scale = geometryForBoard(
      currentScaleName(),
      nextSize,
      reporter,
      context,
    );
    const nextCells: HTMLElement[] = [];

    try {
      for (let y = 0; y < nextSize; y += 1) {
        const row = doc.createElement('div');

        row.setAttribute('role', 'row');
        row.setAttribute('aria-rowindex', String(y + 1));

        for (let x = 0; x < nextSize; x += 1) {
          const cell = doc.createElement('div');

          cell.setAttribute('role', 'gridcell');
          cell.setAttribute('aria-rowindex', String(y + 1));
          cell.setAttribute('aria-colindex', String(x + 1));
          cell.setAttribute('aria-label', cellLabel(x, y, null, emptyLabel));
          cell.setAttribute(CELL_X_ATTRIBUTE, String(x));
          cell.setAttribute(CELL_Y_ATTRIBUTE, String(y));

          // Programmatic focus target, never a tab stop: the host is the
          // single tab stop, so Tab never walks the cells and the arrow keys
          // stay with the movement input.
          cell.setAttribute('tabindex', '-1');
          applyCellGeometry(cell, x, y, scale);
          row.appendChild(cell);
          nextCells.push(cell);
        }

        host.appendChild(row);
      }
    } catch (error: unknown) {
      reporter.error('board cell counterparts could not be built', error, {
        context,
        boardSize: nextSize,
      });

      return false;
    }

    size = nextSize;
    cells = nextCells;
    rendered = new Array<number | null>(nextCells.length).fill(null);
    pending = new Array<number | null>(nextCells.length).fill(null);

    return true;
  };

  /** Marks the host populated, or not, through `aria-busy`. */
  const setBusy = (busy: boolean): void => {
    if (host !== null) {
      host.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
  };

  /** Returns the layer to its unmounted state. */
  const teardown = (): void => {
    const previous = host;

    if (previous !== null && activationListener !== null) {
      previous.removeEventListener('keydown', activationListener);
    }

    activationListener = null;

    if (scaleQuery !== null && scaleListener !== null) {
      if (typeof scaleQuery.removeEventListener === 'function') {
        scaleQuery.removeEventListener('change', scaleListener);
      } else if (typeof scaleQuery.removeListener === 'function') {
        scaleQuery.removeListener(scaleListener);
      }
    }

    scaleQuery = null;
    scaleListener = null;
    clearCells();

    if (previous !== null) {
      setBusy(true);

      // Removed from the element they were added to, and only where THIS layer
      // added them: an attribute the host declared for itself is left alone.
      if (hostAdded.role) {
        previous.removeAttribute('role');
      }

      if (hostAdded.tabIndex) {
        previous.removeAttribute('tabindex');
      }
    }

    // Cleared unconditionally, so a flag set against one host can never be
    // read against the next one.
    hostAdded.role = false;
    hostAdded.tabIndex = false;

    host = null;
    doc = null;
    size = 0;
  };

  const mount = (
    requestedHost: Element | string | null | undefined,
    boardSize: number,
  ): boolean => {
    // The COMPLETE unmount path, before a new host is resolved: clearing the
    // cells alone left the previous host's keydown and media-query listeners
    // attached and carried its attribute-ownership flags onto the next
    // element.
    teardown();

    const candidate = requestedHost ?? options.host ?? null;
    const root = options.document ?? null;

    if (candidate !== null && typeof candidate !== 'string') {
      host = isElementLike(candidate) ? candidate : null;

      if (host === null) {
        reporter.log('warn', 'board host is not an element', {
          context,
          host: describeElement(candidate),
        });
        reporter.count(METRIC_BOARD_NO_HOST, { context, cause: 'not-element' });
      }
    } else {
      const selector = candidate ?? PARALLEL_BOARD_HOST_SELECTOR;

      host = resolveMount<Element>(selector, {
        root,
        reporter,
        context,
        name: 'parallelBoardHost',
      });

      if (host === null) {
        reporter.count(METRIC_BOARD_NO_HOST, { context, cause: 'no-match' });
      }
    }

    if (host === null) {
      teardown();

      return false;
    }

    doc = options.document ?? ownerDocumentOf(host);

    if (doc === null) {
      reporter.log('warn', 'board host belongs to no document', { context });
      reporter.count(METRIC_BOARD_NO_HOST, { context, cause: 'no-document' });
      teardown();

      return false;
    }

    if (!isBoardSize(boardSize)) {
      reporter.log('warn', 'board size refused', {
        context,
        boardSize: String(boardSize),
      });
      reporter.count(METRIC_BOARD_SIZE_REJECTED, { context, cause: 'mount' });
      teardown();

      return false;
    }

    if (host.getAttribute('role') === null) {
      host.setAttribute('role', 'grid');
      hostAdded.role = true;
    }

    if (tabIndexAttributeOf(host) === null) {
      host.setAttribute('tabindex', '0');
      hostAdded.tabIndex = true;
    }

    if (requestedScale === 'auto') {
      scaleQuery = openScaleQuery(windowOf(host), reporter, context);

      if (scaleQuery !== null) {
        const listener = (): void => {
          reapplyGeometry();
        };

        if (typeof scaleQuery.addEventListener === 'function') {
          scaleQuery.addEventListener('change', listener);
          scaleListener = listener;
        } else if (typeof scaleQuery.addListener === 'function') {
          scaleQuery.addListener(listener);
          scaleListener = listener;
        }
      }
    }

    setBusy(true);

    if (!buildCells(boardSize)) {
      teardown();

      return false;
    }

    if (options.onActivateCell !== undefined) {
      activationListener = onActivationKey;
      host.addEventListener('keydown', activationListener);
    }

    setBusy(false);
    reporter.log('debug', 'parallel board layer mounted', {
      context,
      boardSize,
      scale: currentScaleName(),
    });

    return true;
  };

  const rebuild = (boardSize: number): boolean => {
    if (host === null || doc === null) {
      reporter.log('warn', 'board rebuild on an unmounted layer', {
        context,
        boardSize: String(boardSize),
      });
      reporter.count(METRIC_BOARD_NOT_MOUNTED, { context, call: 'rebuild' });

      return false;
    }

    if (!isBoardSize(boardSize)) {
      reporter.log('warn', 'board size refused', {
        context,
        boardSize: String(boardSize),
      });
      reporter.count(METRIC_BOARD_SIZE_REJECTED, { context, cause: 'rebuild' });

      return false;
    }

    const previousIndex = focusedCellIndex();
    const previousSize = size;
    const previous =
      previousIndex === -1
        ? null
        : {
            x: previousIndex % previousSize,
            y: Math.floor(previousIndex / previousSize),
          };

    setBusy(true);
    clearCells();

    if (!buildCells(boardSize)) {
      size = 0;
      setBusy(true);

      return false;
    }

    setBusy(false);
    reporter.count(METRIC_BOARD_REBUILT, { context, boardSize });

    if (previous !== null) {
      // Focus was on a node the rebuild has just discarded.
      const withinBounds = previous.x < boardSize && previous.y < boardSize;
      const targetX = withinBounds ? previous.x : 0;
      const targetY = withinBounds ? previous.y : 0;

      reporter.log('warn', 'board rebuild orphaned the focused cell', {
        context,
        fromX: previous.x,
        fromY: previous.y,
        toX: targetX,
        toY: targetY,
        boardSize,
      });
      reporter.count(METRIC_BOARD_FOCUS_ORPHANED, { context, boardSize });

      if (!focusCell(targetX, targetY) && isFocusableElement(host)) {
        applyFocus(host, {
          reporter,
          context,
          reducedMotion: resolveReducedMotion(options, reporter),
          fields: { call: 'rebuild' },
        });
      }
    }

    return true;
  };

  const cellAt = (x: number, y: number): HTMLElement | null => {
    if (host === null || size <= 0) {
      reporter.count(METRIC_BOARD_NOT_MOUNTED, { context, call: 'cellAt' });

      return null;
    }

    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      y < 0 ||
      x >= size ||
      y >= size
    ) {
      reporter.log('warn', 'board coordinate addresses no cell', {
        context,
        x: String(x),
        y: String(y),
        boardSize: size,
      });
      reporter.count(METRIC_BOARD_CELL_MISSING, { context });

      return null;
    }

    return cells[y * size + x] ?? null;
  };

  function focusCell(x: number, y: number): boolean {
    const cell = cellAt(x, y);

    if (cell === null) {
      return false;
    }

    return applyFocus(cell, {
      reporter,
      context,
      reducedMotion: resolveReducedMotion(options, reporter),
      fields: { x, y },
    });
  }

  const update = (next: readonly ParallelCell[]): void => {
    if (host === null || size <= 0) {
      reporter.count(METRIC_BOARD_NOT_MOUNTED, { context, call: 'update' });

      return;
    }

    if (!Array.isArray(next)) {
      reporter.log('warn', 'board update did not receive a cell list', {
        context,
      });
      reporter.count(METRIC_BOARD_CELL_REJECTED, {
        context,
        cause: 'not-list',
      });

      return;
    }

    pending.fill(null);

    for (const cell of next) {
      if (cell === null || typeof cell !== 'object') {
        reporter.count(METRIC_BOARD_CELL_REJECTED, {
          context,
          cause: 'not-object',
        });
        continue;
      }

      const { x, y, value } = cell;
      const inBounds =
        Number.isInteger(x) &&
        Number.isInteger(y) &&
        x >= 0 &&
        y >= 0 &&
        x < size &&
        y < size;

      if (!inBounds) {
        reporter.log('warn', 'board update cell is out of bounds', {
          context,
          x: String(x),
          y: String(y),
          boardSize: size,
        });
        reporter.count(METRIC_BOARD_CELL_REJECTED, {
          context,
          cause: 'out-of-bounds',
        });
        continue;
      }

      if (value !== null && !Number.isFinite(value)) {
        reporter.log('warn', 'board update cell value is not a number', {
          context,
          x,
          y,
          value: String(value),
        });
        reporter.count(METRIC_BOARD_CELL_REJECTED, {
          context,
          cause: 'bad-value',
        });
        continue;
      }

      pending[y * size + x] = value;
    }

    for (let index = 0; index < cells.length; index += 1) {
      const value = pending[index] ?? null;

      if (rendered[index] === value) {
        continue;
      }

      const cell = cells[index];

      if (cell === undefined) {
        continue;
      }

      cell.setAttribute(
        'aria-label',
        cellLabel(index % size, Math.floor(index / size), value, emptyLabel),
      );
      rendered[index] = value;
    }
  };

  const unmount = (): void => {
    if (host === null) {
      return;
    }

    teardown();
    reporter.log('debug', 'parallel board layer unmounted', { context });
  };

  return Object.freeze({
    isMounted: (): boolean => host !== null && size > 0,
    boardSize: (): number => size,
    mount,
    rebuild,
    update,
    cellAt,
    focusCell,
    unmount,
  });
}
