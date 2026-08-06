/**
 * Swipe gesture path, and the pointer-event-family capability probe.
 *
 * The pointer family is selected once, from `msPointerEnabled`, into a
 * `PointerEventFamily`, and the three handlers branch on that value. The probe
 * result is exported as `POINTER_EVENT_FAMILY` and read by the health surface.
 *
 * The only import is ./keymap: this module reads no storage and emits no event
 * name. A resolved swipe leaves through the `onSwipe` callback, and every
 * counter, log and span leaves through the injected `InputReporter`, contained
 * by `createSafeInputReporter`, so a sink that throws breaks neither the attach
 * path nor any gesture handler. Module scope performs one guarded read of
 * `window.navigator` and touches no document, so the module imports cleanly
 * outside a browser. The module boundaries are drawn as Figure 3, "Component
 * Interaction: Input, Engine, Hook Bus, Relics, Renderer, Persistence", in
 * docs/architecture/component-interaction.md.
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

/* ==========================================================================
 * 1. Legacy pointer shim
 * ========================================================================== */

/** The one non-standard `Navigator` member this module reads. */
export interface MsPointerNavigatorLike {
  /** IE10's pointer-family flag. Absent from a standard `Navigator`. */
  readonly msPointerEnabled?: boolean;
}

/** The ambient `Navigator`, viewed through `MsPointerNavigatorLike`. */
interface MsPointerNavigator extends Navigator, MsPointerNavigatorLike {}

/** One entry of a touch list: the two coordinates the port reads. */
interface TouchPointLike {
  readonly clientX: number;

  readonly clientY: number;
}

/** The subset of `TouchList` the three handlers read. */
interface TouchListLike {
  readonly length: number;

  /** Entry at `index`. Absent entries read as `null` or `undefined`. */
  readonly [index: number]: TouchPointLike | null | undefined;
}

/** The shape the three handlers read off their event. */
interface GestureEventLike extends Event {
  /** Every active touch. */
  readonly touches?: TouchListLike;

  /** Touches on the event target. */
  readonly targetTouches?: TouchListLike;

  /** Touches that changed. */
  readonly changedTouches?: TouchListLike;

  /** Document-relative x. */
  readonly pageX?: number;

  /** Document-relative y. */
  readonly pageY?: number;
}

/* ==========================================================================
 * 2. Pointer-family probe
 * ========================================================================== */

/** The three pointer event names, and the flag that selected them. */
export interface PointerEventFamily {
  /** The `msPointerEnabled` value the selection was made on. */
  readonly msPointerEnabled: boolean;

  /** Gesture-start event name: `MSPointerDown` or `touchstart`. */
  readonly touchstart: string;

  /** Gesture-move event name: `MSPointerMove` or `touchmove`. */
  readonly touchmove: string;

  /** Gesture-end event name: `MSPointerUp` or `touchend`. */
  readonly touchend: string;
}

/** Family selected when `msPointerEnabled` is truthy. */
const MS_POINTER_FAMILY: PointerEventFamily = Object.freeze({
  msPointerEnabled: true,

  //Internet Explorer 10 style
  touchstart: 'MSPointerDown',
  touchmove: 'MSPointerMove',
  touchend: 'MSPointerUp',
});

/** Family selected otherwise. */
const TOUCH_EVENT_FAMILY: PointerEventFamily = Object.freeze({
  msPointerEnabled: false,
  touchstart: 'touchstart',
  touchmove: 'touchmove',
  touchend: 'touchend',
});

/**
 * Reads `msPointerEnabled` off the ambient navigator.
 *
 * @returns The flag coerced to a boolean, or `false` when there is no navigator
 * to read.
 */
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
 * @param navigatorLike Navigator view to read. Omitted or `null` reads the
 * ambient `window.navigator`.
 * @returns The frozen family. A truthy `msPointerEnabled` selects
 * `MSPointerDown` / `MSPointerMove` / `MSPointerUp`; anything else selects
 * `touchstart` / `touchmove` / `touchend`.
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

/* ==========================================================================
 * 3. Report names and helpers
 * ========================================================================== */

/** Counter raised once per attach, carrying the resolved family. */
const PROBE_METRIC = 'input.touch.probe';

/** Counter raised once per successful attach. */
const ATTACHED_METRIC = 'input.touch.attached';

/** Counter raised once per detach. */
const DETACHED_METRIC = 'input.touch.detached';

/** Counter raised when the host element cannot be resolved. */
const HOST_MISSING_METRIC = 'input.touch.attach.hostMissing';

/** Counter raised when a listener cannot be bound. */
const ATTACH_FAILED_METRIC = 'input.touch.attach.failed';

/** Counter raised once per emitted swipe. */
const SWIPE_METRIC = 'input.touch.swipe';

const MULTI_TOUCH_METRIC = 'input.touch.rejected.multiTouch';

const STILL_TOUCHING_METRIC = 'input.touch.rejected.stillTouching';

const BELOW_THRESHOLD_METRIC = 'input.touch.rejected.belowThreshold';

/** Counter raised when the enablement predicate suspended a handler. */
const SUSPENDED_METRIC = 'input.touch.rejected.suspended';

/** Counter raised when a gesture ended with no start point captured. */
const MISSING_START_METRIC = 'input.touch.rejected.missingStart';

/** Counter raised when an event carried no readable coordinate pair. */
const MISSING_POINT_METRIC = 'input.touch.rejected.missingPoint';

/** Counter raised when an injected callback or span operation threw. */
const HANDLER_ERROR_METRIC = 'input.touch.handler.error';

/** Span covering one gesture, from its start event to its end event. */
const GESTURE_SPAN = 'input.touch.gesture';

/** `name` reported for a caught value that carries none. */
const UNKNOWN_ERROR_NAME = 'TouchInputError';

/** `message` reported for a caught value that carries none. */
const UNKNOWN_ERROR_MESSAGE = 'Unknown touch input error.';

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

/**
 * Joins a family's three event names for a report field.
 *
 * @param family Family being bound or unbound.
 * @returns The three names, comma separated.
 */
function describeFamilyEvents(family: PointerEventFamily): string {
  return `${family.touchstart}, ${family.touchmove}, ${family.touchend}`;
}

/**
 * Builds the report fields that describe a family.
 *
 * @param family Family to describe.
 * @returns One field per member of `PointerEventFamily`.
 */
function describeFamily(family: PointerEventFamily): InputReportFields {
  return {
    msPointerEnabled: family.msPointerEnabled,
    touchstart: family.touchstart,
    touchmove: family.touchmove,
    touchend: family.touchend,
  };
}

/* ==========================================================================
 * 4. Gesture geometry
 * ========================================================================== */

/**
 * Minimum travel, in pixels, that the dominant axis must exceed before a
 * gesture resolves.
 */
export const SWIPE_THRESHOLD_PX = 10;

/** One captured gesture endpoint. */
interface GesturePoint {
  /** Horizontal coordinate, from `clientX` or `pageX`. */
  readonly x: number;

  /** Vertical coordinate, from `clientY` or `pageY`. */
  readonly y: number;
}

/** The outcome of measuring one gesture. */
interface SwipeMeasurement {
  /** Resolved direction, or `null` when the threshold was not exceeded. */
  readonly direction: Direction | null;

  readonly absDx: number;

  readonly absDy: number;
}

/**
 * Reads the length of one of the three touch lists.
 *
 * @param list List to measure, when the event carried one.
 * @returns The length, or `0` when there is nothing usable to read.
 */
function readTouchListLength(list: TouchListLike | undefined): number {
  if (list === undefined || list === null) {
    return 0;
  }

  const length: unknown = list.length;

  return typeof length === 'number' && Number.isFinite(length) && length > 0
    ? length
    : 0;
}

/**
 * Reads the first entry of a touch list as a gesture point.
 *
 * @param list List to read, when the event carried one.
 * @returns The point, or `null` when there is none to read.
 */
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

/**
 * Reads the `pageX`/`pageY` pair an `MSPointer*` event carries.
 *
 * @param event Event to read.
 * @returns The point, or `null` when either coordinate is unusable.
 */
function readPagePoint(event: GestureEventLike): GesturePoint | null {
  return toGesturePoint(event.pageX, event.pageY);
}

/**
 * Builds a gesture point from two candidate coordinates.
 *
 * @param x Candidate horizontal coordinate.
 * @param y Candidate vertical coordinate.
 * @returns The point, or `null` when either value is not a finite number.
 */
function toGesturePoint(x: unknown, y: unknown): GesturePoint | null {
  if (typeof x !== 'number' || !Number.isFinite(x)) {
    return null;
  }

  if (typeof y !== 'number' || !Number.isFinite(y)) {
    return null;
  }

  return { x, y };
}

/**
 * Measures a gesture and resolves the direction it travelled. The dominant axis
 * wins, and an exact tie between the two absolute deltas resolves on the
 * vertical axis.
 *
 * @param start Point captured by the gesture-start handler.
 * @param end Point captured by the gesture-end handler.
 * @returns The resolved direction with both absolute deltas. `direction` is
 * `null` when neither axis exceeded `SWIPE_THRESHOLD_PX`.
 */
function measureSwipe(
  start: GesturePoint,
  end: GesturePoint
): SwipeMeasurement {
  const dx = end.x - start.x;
  const absDx = Math.abs(dx);

  const dy = end.y - start.y;
  const absDy = Math.abs(dy);

  if (Math.max(absDx, absDy) > SWIPE_THRESHOLD_PX) {
    // (right : left) : (down : up)
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

/* ==========================================================================
 * 5. Attaching the gesture path
 * ========================================================================== */

/** Selector the gesture host is looked up by when the caller names none. */
export const DEFAULT_GESTURE_HOST_SELECTOR = '.game-container';

/** Removes every listener one `attachTouchInput` call added. */
export type DetachTouchInput = () => void;

/** What `attachTouchInput` binds, and what it reports through. */
export interface TouchInputOptions {
  /**
   * Called once per resolved swipe, with the direction the gesture travelled.
   *
   * @param direction Direction the gesture resolved to.
   */
  onSwipe(direction: Direction): void;

  /**
   * Element the three listeners bind to, or a selector to look one up by.
   * Defaults to `DEFAULT_GESTURE_HOST_SELECTOR`.
   */
  readonly host?: Element | string;

  /**
   * Document a selector is resolved against. Defaults to the ambient
   * `document`.
   */
  readonly ownerDocument?: Document;

  /**
   * Sink for the counters, logs and spans this module raises. Defaults to
   * `NOOP_REPORTER`.
   */
  readonly reporter?: InputReporter;

  /**
   * Family to bind. Defaults to `POINTER_EVENT_FAMILY`, resolved once when this
   * module loaded.
   */
  readonly family?: PointerEventFamily;

  /**
   * Consulted first by each of the three handlers. Returning `false` suspends
   * the gesture path: no coordinate is captured, no default action is cancelled
   * and no swipe is emitted. Absent is read as always enabled.
   *
   * @returns Whether the gesture path is live.
   */
  isEnabled?(): boolean;
}

/** Registration options for all three listeners. */
const LISTENER_OPTIONS: AddEventListenerOptions = Object.freeze({
  passive: false,
  capture: false,
});

/** The detach handle a failed attach returns. It removes nothing. */
const NOOP_DETACH: DetachTouchInput = () => {
  return;
};

/**
 * Reads the ambient `document`.
 *
 * @returns The document, or `null` outside a browser.
 */
function readAmbientDocument(): Document | null {
  return typeof document === 'undefined' ? null : document;
}

/**
 * Resolves the element the gesture listeners bind to.
 *
 * @param options Options passed to `attachTouchInput`.
 * @param reporter Sink for a failed lookup.
 * @param family Family whose names were about to be bound.
 * @returns The host element, or `null` when it cannot be resolved.
 */
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
    reporter.log('error', 'Touch input host selector is unusable.', {
      selector,
      events,
      ...describeError(caught),
    });
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
 * @param options Callback, host, reporter, family and enablement predicate.
 * @returns A detach handle that removes every listener this call did bind. A
 * missing host or an unusable selector binds nothing, so the handle removes
 * nothing; where some registrations are rejected and others succeed, the handle
 * removes the ones that succeeded. Neither case throws.
 */
export function attachTouchInput(
  options: TouchInputOptions
): DetachTouchInput {
  // Contained once here, so every log, counter and span below — including
  // those emitted from inside a gesture handler — is safe against a sink
  // that throws.
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

  /** Closes the open gesture span, if there is one. */
  const closeGestureSpan = (): void => {
    const open = gestureSpan;

    if (open === null) {
      return;
    }

    gestureSpan = null;

    try {
      open.end();
    } catch (caught: unknown) {
      reporter.log('warn', 'Touch input span could not be closed.', {
        ...describeError(caught),
      });
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
      reporter.log('warn', 'Touch input span could not be opened.', {
        ...describeError(caught),
      });
      reporter.count(HANDLER_ERROR_METRIC, { stage: 'startSpan' });
    }
  };

  /**
   * Reports whether the gesture path is live.
   *
   * @returns The predicate's result, or `true` when none was supplied. A
   * predicate that throws suspends the path and is reported.
   */
  const isEnabled = (): boolean => {
    if (options.isEnabled === undefined) {
      return true;
    }

    try {
      return options.isEnabled() !== false;
    } catch (caught: unknown) {
      reporter.log('warn', 'Touch input enablement predicate threw.', {
        ...describeError(caught),
      });
      reporter.count(HANDLER_ERROR_METRIC, { stage: 'isEnabled' });

      return false;
    }
  };

  /**
   * Hands a resolved direction to the callback.
   *
   * @param measured Measurement whose direction resolved.
   * @param direction The resolved direction.
   */
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
      reporter.log('error', 'Touch input swipe callback threw.', {
        direction,
        ...describeError(caught),
      });
      reporter.count(HANDLER_ERROR_METRIC, { stage: 'onSwipe' });
    }
  };

  /** Gesture start. */
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

  /** Gesture move. */
  const handleTouchMove = (event: Event): void => {
    if (!isEnabled()) {
      reporter.count(SUSPENDED_METRIC, { stage: 'touchmove' });

      return;
    }

    event.preventDefault();
  };

  /** Gesture end. Cancels no default action of its own. */
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
      reporter.log('error', 'Touch input listener could not be bound.', {
        event: type,
        events,
        ...describeError(caught),
      });
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
        reporter.log('warn', 'Touch input listener could not be removed.', {
          event: type,
          ...describeError(caught),
        });
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
