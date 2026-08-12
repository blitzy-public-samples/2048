/**
 * Swipe gesture path, and the pointer-event-family capability probe.
 *
 * The pointer family is selected once, from `msPointerEnabled`, into a
 * `PointerEventFamily`, and the three handlers branch on that value. The probe
 * result is exported as `POINTER_EVENT_FAMILY`.
 *
 * One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
 * this module's area enumerated:
 *   TR-TOUCH-01  js/keyboard_input_manager.js  the pointer-event-family probe
 *                L4-L13                        and its `msPointerEnabled`
 *                                              branch, ported as
 *                                              `detectPointerEventFamily` and
 *                                              `POINTER_EVENT_FAMILY`
 *   TR-TOUCH-02  js/keyboard_input_manager.js  the touchstart handler, ported as
 *                L80-L95                       the gesture start
 *   TR-TOUCH-03  js/keyboard_input_manager.js  the touchmove handler, ported as
 *                L97-L99                       the default-prevention branch
 *   TR-TOUCH-04  js/keyboard_input_manager.js  the touchend handler and its
 *                L101-L127                     10px threshold, ported as the
 *                                              resolved swipe and
 *                                              `SWIPE_THRESHOLD_PX`
 *   TR-TOUCH-05  target-only row               `attachTouchInput`, its guarded
 *                                              host resolution and its detach
 *                                              handle
 *
 * Decisions: DL-TOUCH-01, DL-TOUCH-02, DL-TOUCH-03 (docs/DECISION_LOG.md).
 */

import {
  DIRECTION_DOWN,
  DIRECTION_LEFT,
  DIRECTION_RIGHT,
  DIRECTION_UP,
  NOOP_REPORTER,
  createSafeInputReporter,
  type Direction,
  type InputReportFields,
  type InputReporter,
  type InputSpan,
} from './keymap';

/** The one non-standard `Navigator` member this module reads. */
export interface MsPointerNavigatorLike {
  /** IE10's pointer-family flag. Absent from a standard `Navigator`. */
  readonly msPointerEnabled?: boolean;
}

interface MsPointerNavigator extends Navigator, MsPointerNavigatorLike {}

interface TouchPointLike {
  readonly clientX: number;
  readonly clientY: number;
}

interface TouchListLike {
  readonly length: number;

  /** Entry at `index`. Absent entries read as `null` or `undefined`. */
  readonly [index: number]: TouchPointLike | null | undefined;
}

interface GestureEventLike extends Event {
  readonly touches?: TouchListLike;
  readonly targetTouches?: TouchListLike;
  readonly changedTouches?: TouchListLike;
  readonly pageX?: number;
  readonly pageY?: number;
}

/** The three pointer event names, and the flag that selected them. */
export interface PointerEventFamily {
  readonly msPointerEnabled: boolean;
  readonly touchstart: string;
  readonly touchmove: string;
  readonly touchend: string;
}

const MS_POINTER_FAMILY: PointerEventFamily = Object.freeze({
  msPointerEnabled: true,

  // Internet Explorer 10 style
  touchstart: 'MSPointerDown',
  touchmove: 'MSPointerMove',
  touchend: 'MSPointerUp',
});

const TOUCH_EVENT_FAMILY: PointerEventFamily = Object.freeze({
  msPointerEnabled: false,
  touchstart: 'touchstart',
  touchmove: 'touchmove',
  touchend: 'touchend',
});

function readAmbientMsPointerEnabled(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const view: MsPointerNavigator | undefined = window.navigator;

  return view === undefined ? false : Boolean(view.msPointerEnabled);
}

/**
 * Selects the pointer event family.
 *
 * @returns The frozen family. A truthy `msPointerEnabled` selects
 *   `MSPointerDown` / `MSPointerMove` / `MSPointerUp`; anything else selects
 *   `touchstart` / `touchmove` / `touchend`.
 */
export function detectPointerEventFamily(
  navigatorLike?: MsPointerNavigatorLike | null
): PointerEventFamily {
  const enabled =
    navigatorLike === undefined || navigatorLike === null
      ? readAmbientMsPointerEnabled()
      : Boolean(navigatorLike.msPointerEnabled);

  return enabled ? MS_POINTER_FAMILY : TOUCH_EVENT_FAMILY;
}

/** The pointer event family, resolved once when this module loads. */
export const POINTER_EVENT_FAMILY: PointerEventFamily =
  detectPointerEventFamily();

const PROBE_METRIC = 'input.touch.probe';

const ATTACHED_METRIC = 'input.touch.attached';

const DETACHED_METRIC = 'input.touch.detached';

const HOST_MISSING_METRIC = 'input.touch.attach.hostMissing';

const ATTACH_FAILED_METRIC = 'input.touch.attach.failed';

const SWIPE_METRIC = 'input.touch.swipe';

const MULTI_TOUCH_METRIC = 'input.touch.rejected.multiTouch';

const STILL_TOUCHING_METRIC = 'input.touch.rejected.stillTouching';

const BELOW_THRESHOLD_METRIC = 'input.touch.rejected.belowThreshold';

const SUSPENDED_METRIC = 'input.touch.rejected.suspended';

const MISSING_START_METRIC = 'input.touch.rejected.missingStart';

const MISSING_POINT_METRIC = 'input.touch.rejected.missingPoint';

const HANDLER_ERROR_METRIC = 'input.touch.handler.error';

const GESTURE_SPAN = 'input.touch.gesture';

/**
 * Joins a family's three event names for a report field.
 *
 * @param family Family being bound or unbound.
 * @returns The three names, comma separated.
 */
function describeFamilyEvents(family: PointerEventFamily): string {
  return `${family.touchstart}, ${family.touchmove}, ${family.touchend}`;
}

function describeFamily(family: PointerEventFamily): InputReportFields {
  return {
    msPointerEnabled: family.msPointerEnabled,
    touchstart: family.touchstart,
    touchmove: family.touchmove,
    touchend: family.touchend,
  };
}

/**
 * Minimum travel, in pixels, that the dominant axis must exceed before a
 * gesture resolves.
 */
export const SWIPE_THRESHOLD_PX = 10;

interface GesturePoint {
  readonly x: number;
  readonly y: number;
}

interface SwipeMeasurement {
  /** Resolved direction, or `null` when the threshold was not exceeded. */
  readonly direction: Direction | null;
  readonly absDx: number;
  readonly absDy: number;
}

function readTouchListLength(list: TouchListLike | undefined): number {
  if (list === undefined || list === null) {
    return 0;
  }

  const length: unknown = list.length;

  return typeof length === 'number' && Number.isFinite(length) && length > 0
    ? length
    : 0;
}

function readTouchPoint(
  list: TouchListLike | undefined
): GesturePoint | null {
  if (list === undefined || list === null) {
    return null;
  }

  const point = list[0];

  if (point === undefined || point === null) {
    return null;
  }

  return toGesturePoint(point.clientX, point.clientY);
}

function readPagePoint(event: GestureEventLike): GesturePoint | null {
  return toGesturePoint(event.pageX, event.pageY);
}

function toGesturePoint(x: unknown, y: unknown): GesturePoint | null {
  if (typeof x !== 'number' || !Number.isFinite(x)) {
    return null;
  }

  if (typeof y !== 'number' || !Number.isFinite(y)) {
    return null;
  }

  return { x, y };
}

/** Measures a gesture and resolves the direction it travelled. */
function measureSwipe(
  start: GesturePoint,
  end: GesturePoint
): SwipeMeasurement {
  const dx = end.x - start.x;
  const absDx = Math.abs(dx);

  const dy = end.y - start.y;
  const absDy = Math.abs(dy);

  if (Math.max(absDx, absDy) > SWIPE_THRESHOLD_PX) {
    // (right: left): (down: up)
    const direction: Direction =
      absDx > absDy
        ? dx > 0
          ? DIRECTION_RIGHT
          : DIRECTION_LEFT
        : dy > 0
          ? DIRECTION_DOWN
          : DIRECTION_UP;

    return { direction, absDx, absDy };
  }

  return { direction: null, absDx, absDy };
}

/** Selector the gesture host is looked up by when the caller names none. */
export const DEFAULT_GESTURE_HOST_SELECTOR = '.game-container';

/** Removes every listener one `attachTouchInput` call added. */
export type DetachTouchInput = () => void;

/** What `attachTouchInput` binds, and what it reports through. */
export interface TouchInputOptions {
  onSwipe(direction: Direction): void;
  readonly host?: Element | string;
  readonly ownerDocument?: Document;
  readonly reporter?: InputReporter;
  readonly family?: PointerEventFamily;

  /**
   * Consulted first by each of the three handlers. Returning `false` suspends
   * the gesture path: no coordinate is captured, no default action is
   * cancelled and no swipe is emitted.
   */
  isEnabled?(): boolean;
}

const LISTENER_OPTIONS: AddEventListenerOptions = Object.freeze({
  passive: false,
  capture: false,
});

const NOOP_DETACH: DetachTouchInput = () => {
  return;
};

function readAmbientDocument(): Document | null {
  return typeof document === 'undefined' ? null : document;
}

function resolveHost(
  options: TouchInputOptions,
  reporter: InputReporter,
  family: PointerEventFamily
): Element | null {
  const requested = options.host;

  if (typeof requested === 'object' && requested !== null) {
    return requested;
  }

  const selector =
    typeof requested === 'string' && requested.length > 0
      ? requested
      : DEFAULT_GESTURE_HOST_SELECTOR;

  const events = describeFamilyEvents(family);
  const owner = options.ownerDocument ?? readAmbientDocument();

  if (owner === null) {
    reporter.log('error', 'Touch input found no document to search.', {
      selector,
      events,
    });
    reporter.count(HOST_MISSING_METRIC, { selector, reason: 'noDocument' });

    return null;
  }

  let found: Element | null = null;

  try {
    found = owner.querySelector(selector);
  } catch (caught: unknown) {
    reporter.failure?.(
      'error',
      'Touch input host selector is unusable.',
      caught,
      { selector, events },
    );
    reporter.count(HOST_MISSING_METRIC, { selector, reason: 'badSelector' });

    return null;
  }

  if (found === null) {
    reporter.log('error', 'Touch input host element is absent.', {
      selector,
      events,
    });
    reporter.count(HOST_MISSING_METRIC, { selector, reason: 'notFound' });

    return null;
  }

  return found;
}

/**
 * Binds the swipe gesture path and returns the handle that unbinds it.
 *
 * The injected reporter is contained before it is used, so a sink that throws
 * breaks neither the attach path nor any gesture handler.
 *
 * @returns A detach handle that removes every listener this call did bind. A
 *   missing host or an unusable selector binds nothing, so the handle removes
 *   nothing; where some registrations are rejected and others succeed, the
 *   handle removes the ones that succeeded.
 */
export function attachTouchInput(
  options: TouchInputOptions
): DetachTouchInput {
  // Contained once here, so every log, counter and span below — including
  // those emitted from inside a gesture handler — is safe against a sink that
  // throws.
  const reporter = createSafeInputReporter(
    options.reporter ?? NOOP_REPORTER
  );
  const family = options.family ?? POINTER_EVENT_FAMILY;
  const familyFields = describeFamily(family);

  reporter.log('info', 'Pointer event family resolved.', familyFields);
  reporter.count(PROBE_METRIC, familyFields);

  const host = resolveHost(options, reporter, family);

  if (host === null) {
    return NOOP_DETACH;
  }

  // The start point persists until the next gesture start replaces it: a
  // gesture that ends without one captured emits no swipe and clears nothing.
  let start: GesturePoint | null = null;
  let gestureSpan: InputSpan | null = null;
  let detached = false;

  const closeGestureSpan = (): void => {
    const open = gestureSpan;

    if (open === null) {
      return;
    }

    gestureSpan = null;

    try {
      open.end();
    } catch (caught: unknown) {
      reporter.failure?.(
        'warn',
        'Touch input span could not be closed.',
        caught,
      );
      reporter.count(HANDLER_ERROR_METRIC, { stage: 'endSpan' });
    }
  };

  /** Opens a gesture span, closing any span left open before it. */
  const openGestureSpan = (): void => {
    closeGestureSpan();

    if (reporter.startSpan === undefined) {
      return;
    }

    try {
      gestureSpan = reporter.startSpan(GESTURE_SPAN);
    } catch (caught: unknown) {
      gestureSpan = null;
      reporter.failure?.(
        'warn',
        'Touch input span could not be opened.',
        caught,
      );
      reporter.count(HANDLER_ERROR_METRIC, { stage: 'startSpan' });
    }
  };

  /**
   * Reports whether the gesture path is live.
   *
   * @returns The predicate's result, or `true` when none was supplied. A
   *   predicate that throws suspends the path and is reported.
   */
  const isEnabled = (): boolean => {
    if (options.isEnabled === undefined) {
      return true;
    }

    try {
      return options.isEnabled() !== false;
    } catch (caught: unknown) {
      reporter.failure?.(
        'warn',
        'Touch input enablement predicate threw.',
        caught,
      );
      reporter.count(HANDLER_ERROR_METRIC, { stage: 'isEnabled' });

      return false;
    }
  };

  const emitSwipe = (
    measured: SwipeMeasurement,
    direction: Direction
  ): void => {
    reporter.count(SWIPE_METRIC, {
      direction,
      absDx: measured.absDx,
      absDy: measured.absDy,
    });

    try {
      options.onSwipe(direction);
    } catch (caught: unknown) {
      reporter.failure?.('error', 'Touch input swipe callback threw.', caught, {
        direction,
      });
      reporter.count(HANDLER_ERROR_METRIC, { stage: 'onSwipe' });
    }
  };

  const handleTouchStart = (event: Event): void => {
    if (!isEnabled()) {
      reporter.count(SUSPENDED_METRIC, { stage: 'touchstart' });

      return;
    }

    const gesture: GestureEventLike = event;

    if (
      (!family.msPointerEnabled &&
        readTouchListLength(gesture.touches) > 1) ||
      readTouchListLength(gesture.targetTouches) > 1
    ) {
      reporter.count(MULTI_TOUCH_METRIC, { stage: 'touchstart' });

      return; // Ignore if touching with more than 1 finger
    }

    const point = family.msPointerEnabled
      ? readPagePoint(gesture)
      : readTouchPoint(gesture.touches);

    if (point === null) {
      reporter.count(MISSING_POINT_METRIC, { stage: 'touchstart' });

      return;
    }

    start = point;
    openGestureSpan();

    event.preventDefault();
  };

  const handleTouchMove = (event: Event): void => {
    if (!isEnabled()) {
      reporter.count(SUSPENDED_METRIC, { stage: 'touchmove' });

      return;
    }

    event.preventDefault();
  };

  // Retained from the port: gesture end cancels no default action of its own,
  // so a tap can still be followed by a synthesised click.
  const handleTouchEnd = (event: Event): void => {
    if (!isEnabled()) {
      reporter.count(SUSPENDED_METRIC, { stage: 'touchend' });

      return;
    }

    const gesture: GestureEventLike = event;

    if (
      (!family.msPointerEnabled &&
        readTouchListLength(gesture.touches) > 0) ||
      readTouchListLength(gesture.targetTouches) > 0
    ) {
      reporter.count(STILL_TOUCHING_METRIC, { stage: 'touchend' });

      return; // Ignore if still touching with one or more fingers
    }

    closeGestureSpan();

    const end = family.msPointerEnabled
      ? readPagePoint(gesture)
      : readTouchPoint(gesture.changedTouches);

    if (end === null) {
      reporter.count(MISSING_POINT_METRIC, { stage: 'touchend' });

      return;
    }

    const from = start;

    if (from === null) {
      reporter.count(MISSING_START_METRIC, { stage: 'touchend' });

      return;
    }

    const measured = measureSwipe(from, end);

    if (measured.direction === null) {
      reporter.count(BELOW_THRESHOLD_METRIC, {
        absDx: measured.absDx,
        absDy: measured.absDy,
        threshold: SWIPE_THRESHOLD_PX,
      });

      return;
    }

    emitSwipe(measured, measured.direction);
  };

  const events = describeFamilyEvents(family);
  const bound: Array<readonly [string, EventListener]> = [];

  const requested: ReadonlyArray<readonly [string, EventListener]> = [
    [family.touchstart, handleTouchStart],
    [family.touchmove, handleTouchMove],
    [family.touchend, handleTouchEnd],
  ];

  for (const [type, listener] of requested) {
    try {
      host.addEventListener(type, listener, LISTENER_OPTIONS);
      bound.push([type, listener]);
    } catch (caught: unknown) {
      reporter.failure?.(
        'error',
        'Touch input listener could not be bound.',
        caught,
        { event: type, events },
      );
      reporter.count(ATTACH_FAILED_METRIC, { event: type });
    }
  }

  if (bound.length === 0) {
    reporter.log('error', 'Touch input bound no listener.', { events });

    return NOOP_DETACH;
  }

  reporter.log('info', 'Touch input attached.', {
    events,
    bound: bound.length,
  });
  reporter.count(ATTACHED_METRIC, {
    msPointerEnabled: family.msPointerEnabled,
    bound: bound.length,
  });

  return (): void => {
    if (detached) {
      return;
    }

    detached = true;
    closeGestureSpan();

    for (const [type, listener] of bound) {
      try {
        host.removeEventListener(type, listener, LISTENER_OPTIONS);
      } catch (caught: unknown) {
        reporter.failure?.(
          'warn',
          'Touch input listener could not be removed.',
          caught,
          { event: type },
        );
        reporter.count(HANDLER_ERROR_METRIC, { stage: 'detach' });
      }
    }

    reporter.log('info', 'Touch input detached.', {
      events,
      removed: bound.length,
    });
    reporter.count(DETACHED_METRIC, { removed: bound.length });
  };
}
