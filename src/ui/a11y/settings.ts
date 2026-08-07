/**
 * Preference detection for the accessibility surface, plus the two contracts
 * every other module under src/ui/ consumes from here: the injected report
 * sink and the guarded mount resolver.
 *
 * The leaf of the src/ui/ import graph. It imports one module outside its own
 * folder — src/theme/themes.ts, for the theme vocabulary and the activation
 * call — and nothing from src/render/, src/observability/, src/storage/,
 * src/audio/, or any sibling module under src/ui/.
 *
 * Origin, one row per construct group. Nothing here ports a construct from
 * js/: the retired sources carry no accessibility code, no null-checked
 * lookup and no report sink, so every row is target-only in
 * docs/TRACEABILITY_MATRIX.md.
 *
 * | Construct group                   | Origin                             |
 * |-----------------------------------|------------------------------------|
 * | `UiReporter`, `NOOP_UI_REPORTER`  | Rule 3, sibling of `InputReporter` |
 * | `resolveMount`, `resolveMounts`   | I12                                |
 * | Reduced motion                    | R9                                 |
 * | Theme selection                   | R9                                 |
 * | Number-only mode                  | R9 and I6                          |
 * | Mute and volume                   | R9                                 |
 *
 * The eight unguarded lookups the resolver closes: js/html_actuator.js L2-L5,
 * reading `.tile-container`, `.score-container`, `.best-container` and
 * `.game-message`; js/keyboard_input_manager.js L78, reading
 * `.game-container`; and its L141, reached from L72-L74 for `.retry-button`,
 * `.restart-button` and `.keep-playing-button`. None of the eight was
 * null-checked, and each result was dereferenced immediately.
 *
 * Subscription semantics are those of js/keyboard_input_manager.js L18-L32 —
 * an appended callback list iterated synchronously — with per-listener error
 * isolation added.
 *
 * No exported function throws. A missing document, an absent `matchMedia`, a
 * malformed selector, an unrecognised theme id, an out-of-range volume and a
 * throwing listener are each reported through the injected sink and the call
 * continues.
 *
 * Preferences are held in memory for the session: this module reads and
 * writes no storage and declares no storage key.
 *
 * Rationale for the decisions behind this file — the locally declared report
 * sink, the guarded resolver in place of non-null assertions, the additive
 * treatment of the two accessibility palettes, and the session-scoped
 * preferences — is in docs/DECISION_LOG.md.
 */

import type { ThemeId } from '../../theme/themes';
import {
  DEFAULT_THEME_ID,
  isThemeId,
  setActiveTheme,
} from '../../theme/themes';

/* --------------------------------------------------------------------------
 * 1. Report sink
 * ----------------------------------------------------------------------- */

/** Severity of a report. */
export type UiReportLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured fields attached to a report. */
export type UiReportFields = Record<string, string | number | boolean>;

/**
 * Sink every module under src/ui/ reports through.
 *
 * Injected, never imported: this module names no observability module, so
 * src/main.ts adapts a logger onto this shape from the outside and a test
 * substitutes a recording fake. `error` carries the caught value unchanged.
 *
 * Every function and factory in this module that accepts a reporter defaults
 * it to `NOOP_UI_REPORTER`, so each is usable with no sink and no mocking
 * library.
 */
export interface UiReporter {
  /**
   * Records a structured message.
   *
   * @param level Severity.
   * @param message Human-readable message.
   * @param fields Optional structured fields.
   */
  log(level: UiReportLevel, message: string, fields?: UiReportFields): void;

  /**
   * Increments a counter.
   *
   * @param metric Counter name.
   * @param fields Optional structured fields.
   */
  count(metric: string, fields?: UiReportFields): void;

  /**
   * Records a caught value together with its context.
   *
   * @param message Human-readable message.
   * @param error The caught value, exactly as it was thrown.
   * @param fields Optional structured fields.
   */
  error(message: string, error: unknown, fields?: UiReportFields): void;
}

/**
 * A fully implemented `UiReporter` that discards every report. The default
 * parameter value wherever this module accepts a reporter.
 */
export const NOOP_UI_REPORTER: UiReporter = Object.freeze({
  log(): void {
    return;
  },
  count(): void {
    return;
  },
  error(): void {
    return;
  },
});

/**
 * Wraps a reporter so no member of it can throw into its caller.
 *
 * A `log`, `count` or `error` that throws is contained at this boundary: the
 * throw reaches neither the resolver, nor a setter, nor a media-query
 * listener, and it is not reported back through the sink that produced it. A
 * reporter that is missing a member is contained on the same path.
 *
 * Every entry point in this module wraps its reporter here once before using
 * it.
 *
 * @param reporter Reporter to contain.
 * @returns A reporter delegating to `reporter` and throwing for nothing.
 */
export function createSafeUiReporter(reporter: UiReporter): UiReporter {
  return Object.freeze({
    log(
      level: UiReportLevel,
      message: string,
      fields?: UiReportFields,
    ): void {
      try {
        reporter.log(level, message, fields);
      } catch {
        return;
      }
    },

    count(metric: string, fields?: UiReportFields): void {
      try {
        reporter.count(metric, fields);
      } catch {
        return;
      }
    },

    error(message: string, error: unknown, fields?: UiReportFields): void {
      try {
        reporter.error(message, error, fields);
      } catch {
        return;
      }
    },
  });
}

/* --------------------------------------------------------------------------
 * 2. Guarded mount resolution
 * ----------------------------------------------------------------------- */

/**
 * The minimum a value must implement to be searched for a mount.
 *
 * `Document`, `Element` and `DocumentFragment` all satisfy it, and so does a
 * hand-built stand-in in a test.
 */
export interface MountRoot {
  /**
   * Returns the first descendant matching `selectors`, or `null`.
   *
   * @param selectors CSS selector list.
   */
  querySelector<E extends Element = Element>(selectors: string): E | null;
}

/** One mount a resolution asked for and did not obtain. */
export interface MissingMount {
  /** Logical name the caller asked for. */
  readonly name: string;

  /** Selector that matched nothing, or that could not be evaluated. */
  readonly selector: string;

  /** Label naming the caller, carried into the report. */
  readonly context: string;

  /**
   * `'no-match'` where the selector evaluated and matched nothing,
   * `'no-root'` where no searchable root was available, and `'query-failed'`
   * where evaluating the selector threw.
   */
  readonly cause: MissingMountCause;
}

/** Why a mount was not obtained. */
export type MissingMountCause = 'no-match' | 'no-root' | 'query-failed';

/** Options shared by both resolvers. */
export interface ResolveMountOptions {
  /**
   * Node the search runs against. Defaults to the ambient `document`, and
   * resolves to no root at all where no document exists.
   */
  readonly root?: MountRoot | null;

  /** Sink the misses are reported through. */
  readonly reporter?: UiReporter;

  /** Short label naming the caller, carried into every report. */
  readonly context?: string;

  /** Logical name of the mount. Defaults to the selector itself. */
  readonly name?: string;
}

/**
 * Options accepted by `resolveMounts`. `name` is absent: each entry's key in
 * the spec is its name.
 */
export type ResolveMountsOptions = Omit<ResolveMountOptions, 'name'>;

/** A record of logical mount name to the selector that resolves it. */
export type MountSpec = Readonly<Record<string, string>>;

/**
 * The outcome of a batch resolution: one entry per name in the spec, plus the
 * misses collected as data.
 */
export interface MountResolution<
  S extends MountSpec,
  E extends Element = HTMLElement,
> {
  /** The element found for each name in the spec, or `null`. */
  readonly elements: { readonly [K in keyof S]: E | null };

  /** Every mount the spec asked for and the document did not supply. */
  readonly missing: readonly MissingMount[];

  /** Whether every name in the spec resolved. */
  readonly complete: boolean;
}

/** A resolution in which every name resolved. */
export type CompleteMountResolution<
  S extends MountSpec,
  E extends Element = HTMLElement,
> = MountResolution<S, E> & {
  readonly elements: { readonly [K in keyof S]: E };
};

/** Label used where a caller supplies no context. */
const DEFAULT_MOUNT_CONTEXT = 'ui';

/**
 * Narrows a value to a searchable root.
 *
 * @param value Candidate root.
 * @returns Whether `value` carries a callable `querySelector`.
 */
function isMountRoot(value: unknown): value is MountRoot {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const candidate: { readonly querySelector?: unknown } = value;

  return typeof candidate.querySelector === 'function';
}

/**
 * Resolves the root a search runs against.
 *
 * @param root Root the caller supplied, if any.
 * @returns The supplied root, the ambient document, or `null` where neither
 *   is searchable.
 */
function resolveMountRoot(
  root: MountRoot | null | undefined,
): MountRoot | null {
  if (root !== undefined && root !== null) {
    return isMountRoot(root) ? root : null;
  }

  if (typeof document === 'undefined') {
    return null;
  }

  return isMountRoot(document) ? document : null;
}

/**
 * Finds one element without throwing, reporting whichever way it failed.
 *
 * @param selector Selector to evaluate.
 * @param name Logical name of the mount.
 * @param context Label naming the caller.
 * @param root Searchable root, or `null` where none was available.
 * @param reporter Contained sink.
 * @returns The element, or the miss describing why there is none.
 */
function findMount<E extends Element>(
  selector: string,
  name: string,
  context: string,
  root: MountRoot | null,
  reporter: UiReporter,
): { readonly element: E } | { readonly missing: MissingMount } {
  if (root === null) {
    reporter.log('warn', 'ui mount root unavailable', {
      mount: name,
      selector,
      context,
    });
    reporter.count('ui.mount.no_root', { mount: name, context });

    return {
      missing: { name, selector, context, cause: 'no-root' },
    };
  }

  let found: E | null;

  try {
    found = root.querySelector<E>(selector);
  } catch (error: unknown) {
    reporter.error('ui mount selector could not be evaluated', error, {
      mount: name,
      selector,
      context,
    });
    reporter.count('ui.mount.query_failed', { mount: name, context });

    return {
      missing: { name, selector, context, cause: 'query-failed' },
    };
  }

  if (found === null) {
    reporter.log('warn', 'ui mount not found', {
      mount: name,
      selector,
      context,
    });
    reporter.count('ui.mount.missing', { mount: name, context });

    return {
      missing: { name, selector, context, cause: 'no-match' },
    };
  }

  return { element: found };
}

/**
 * Resolves one mount, returning `null` rather than asserting or throwing.
 *
 * The guarded form of the lookups at js/html_actuator.js L2-L5 and
 * js/keyboard_input_manager.js L78 and L141 (I12). A miss returns `null` and
 * is reported with the selector and the caller's context attached. Nothing is
 * cached: every call performs the lookup, so an element that has since been
 * mounted or unmounted is observed as it currently is.
 *
 * Selectors are supplied by the caller. This module declares none of its own,
 * and index.html is the authority for every one of them.
 *
 * @param selector Selector to resolve. Comes from the caller.
 * @param options Root, sink, context label and logical name.
 * @returns The element, or `null` where the selector matched nothing, could
 *   not be evaluated, or there was no searchable root.
 */
export function resolveMount<E extends Element = HTMLElement>(
  selector: string,
  options: ResolveMountOptions = {},
): E | null {
  const reporter = createSafeUiReporter(options.reporter ?? NOOP_UI_REPORTER);
  const context = options.context ?? DEFAULT_MOUNT_CONTEXT;
  const name = options.name ?? selector;
  const root = resolveMountRoot(options.root);
  const outcome = findMount<E>(selector, name, context, root, reporter);

  return 'element' in outcome ? outcome.element : null;
}

/**
 * Resolves a whole mount set in one pass, collecting the misses as data.
 *
 * The form src/ui/screen-router.ts calls once at boot, which then injects the
 * resolved elements downward so no screen or component performs a lookup of
 * its own.
 *
 * @param spec Logical mount name to selector.
 * @param options Root, sink and context label.
 * @returns One entry per name, the misses, and whether the set is complete.
 */
export function resolveMounts<
  S extends MountSpec,
  E extends Element = HTMLElement,
>(spec: S, options: ResolveMountsOptions = {}): MountResolution<S, E> {
  const reporter = createSafeUiReporter(options.reporter ?? NOOP_UI_REPORTER);
  const context = options.context ?? DEFAULT_MOUNT_CONTEXT;
  const root = resolveMountRoot(options.root);
  const resolved: Record<string, E | null> = {};
  const missing: MissingMount[] = [];
  const entries =
    spec !== null && typeof spec === 'object' ? Object.entries(spec) : [];

  if (entries.length === 0 && (spec === null || typeof spec !== 'object')) {
    reporter.log('warn', 'ui mount spec is not a record', { context });
    reporter.count('ui.mount.spec_rejected', { context });
  }

  for (const [name, selector] of entries) {
    const outcome = findMount<E>(selector, name, context, root, reporter);

    if ('element' in outcome) {
      resolved[name] = outcome.element;
    } else {
      resolved[name] = null;
      missing.push(outcome.missing);
    }
  }

  // The accumulator carries one entry per key of `spec` and each value is
  // already `E | null`; the assertion restates the key set, not the null.
  const elements = Object.freeze(resolved) as {
    readonly [K in keyof S]: E | null;
  };

  return Object.freeze({
    elements,
    missing: Object.freeze(missing),
    complete: missing.length === 0,
  });
}

/**
 * Narrows a resolution to one whose every entry is present.
 *
 * @param resolution Resolution to test.
 * @returns Whether every name in the spec resolved.
 */
export function isMountComplete<
  S extends MountSpec,
  E extends Element = HTMLElement,
>(
  resolution: MountResolution<S, E>,
): resolution is CompleteMountResolution<S, E> {
  return (
    resolution !== null &&
    typeof resolution === 'object' &&
    resolution.complete === true
  );
}

/**
 * Renders a miss list as one line, for a report field.
 *
 * @param missing Misses to describe.
 * @returns `name=selector (cause)` per miss, comma-separated, or an empty
 *   string where there are none.
 */
export function formatMissingMounts(
  missing: readonly MissingMount[],
): string {
  if (!Array.isArray(missing)) {
    return '';
  }

  return missing
    .map((miss) => `${miss.name}=${miss.selector} (${miss.cause})`)
    .join(', ');
}

/* --------------------------------------------------------------------------
 * 3. Reduced motion
 * ----------------------------------------------------------------------- */

/**
 * Media query the operating-system preference is read from.
 *
 * No stylesheet in the retired sources referenced it. style/_a11y.scss L251
 * carries the CSS layer keyed on the same feature, and src/render/ queries the
 * same feature independently for the effects it gates; neither module imports
 * the other.
 */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * State of the reduced-motion query.
 *
 * `'absent'` is a platform offering no `matchMedia` at all, which expresses no
 * preference. `'failed'` is a `matchMedia` that threw, or a result carrying no
 * boolean `matches`; that is an unknown preference rather than an absent one,
 * and it resolves to reduced motion.
 */
export type MotionQueryStatus = 'available' | 'absent' | 'failed';

/** A `change` handler as this module registers it. */
export type MotionQueryChangeHandler = () => void;

/**
 * The part of a media-query list this module uses.
 *
 * Obtained only through `isMotionQueryList`, so a real `MediaQueryList`, a
 * partial implementation and a test stand-in are all handled on one path.
 * Every optional member is checked before it is called.
 */
export interface MotionQueryList {
  /** Whether the query currently matches. */
  readonly matches: boolean;

  /** Modern subscription. */
  readonly addEventListener?: (
    type: 'change',
    handler: MotionQueryChangeHandler,
  ) => void;

  /** Modern teardown. */
  readonly removeEventListener?: (
    type: 'change',
    handler: MotionQueryChangeHandler,
  ) => void;

  /** Deprecated subscription, present on older surfaces. */
  readonly addListener?: (handler: MotionQueryChangeHandler) => void;

  /** Deprecated teardown, present on older surfaces. */
  readonly removeListener?: (handler: MotionQueryChangeHandler) => void;
}

/**
 * The part of a window this module uses to evaluate the query.
 *
 * `matchMedia` is declared as returning `unknown`. The ambient `globalThis`, a
 * `Window` and a test stand-in all satisfy it, and every result passes through
 * `isMotionQueryList` before it is read.
 */
export interface MotionQuerySource {
  /**
   * Evaluates a media query.
   *
   * @param query Media query string.
   */
  readonly matchMedia: (query: string) => unknown;
}

/** The reduced-motion query's answer, and whether it could be read. */
export interface ReducedMotionQuery {
  /** Whether motion is to be reduced according to the platform alone. */
  readonly reduced: boolean;

  /** Whether the query produced a usable result. */
  readonly supported: boolean;

  /** Available, absent, or present and failing. */
  readonly status: MotionQueryStatus;
}

/**
 * How the reduced-motion preference is decided.
 *
 * `'system'` follows the media query, `'reduce'` forces motion reduction on
 * and `'allow'` forces it off. A two-state control cannot express following
 * the operating system, which is the default.
 */
export type MotionSetting = 'system' | 'reduce' | 'allow';

/** Every motion setting, in the order the settings surface presents them. */
export const MOTION_SETTINGS: readonly MotionSetting[] = Object.freeze([
  'system',
  'reduce',
  'allow',
] as const satisfies readonly MotionSetting[]);

/** The setting in force before anything is chosen. */
export const DEFAULT_MOTION_SETTING: MotionSetting = 'system';

/**
 * Narrows an unknown value to a `MotionSetting`.
 *
 * @param value Candidate setting.
 * @returns Whether `value` is one of the three settings.
 */
export function isMotionSetting(value: unknown): value is MotionSetting {
  return (
    typeof value === 'string' &&
    (MOTION_SETTINGS as readonly string[]).includes(value)
  );
}

/**
 * Narrows a `matchMedia` result to a readable query list.
 *
 * @param value Candidate query list.
 * @returns Whether `value` carries a boolean `matches`.
 */
function isMotionQueryList(value: unknown): value is MotionQueryList {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const candidate: { readonly matches?: unknown } = value;

  return typeof candidate.matches === 'boolean';
}

/**
 * Narrows a value to something that can evaluate a media query.
 *
 * @param value Candidate source.
 * @returns Whether `value` carries a callable `matchMedia`.
 */
function isMotionQuerySource(value: unknown): value is MotionQuerySource {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const candidate: { readonly matchMedia?: unknown } = value;

  return typeof candidate.matchMedia === 'function';
}

/**
 * Resolves the source the query is evaluated against.
 *
 * @param source Source the caller supplied, if any.
 * @returns The supplied source, the ambient global, or `null` where neither
 *   can evaluate a media query.
 */
function resolveMotionSource(
  source: MotionQuerySource | null | undefined,
): MotionQuerySource | null {
  if (source !== undefined && source !== null) {
    return isMotionQuerySource(source) ? source : null;
  }

  return isMotionQuerySource(globalThis) ? globalThis : null;
}

/** The answer where no `matchMedia` exists at all. */
const ABSENT_MOTION_QUERY: ReducedMotionQuery = Object.freeze({
  reduced: false,
  supported: false,
  status: 'absent',
});

/** The answer where the query exists and could not be read. */
const FAILED_MOTION_QUERY: ReducedMotionQuery = Object.freeze({
  reduced: true,
  supported: false,
  status: 'failed',
});

/**
 * Builds the answer for a query that responded.
 *
 * @param reduced What the query reported.
 * @returns The frozen answer.
 */
function availableMotionQuery(reduced: boolean): ReducedMotionQuery {
  return Object.freeze({ reduced, supported: true, status: 'available' });
}

/**
 * Reads a query list's `matches` without trusting the accessor.
 *
 * @param list Query list to read.
 * @param reporter Contained sink.
 * @returns The boolean the list reported, or `null` where the read threw.
 */
function readMotionMatches(
  list: MotionQueryList,
  reporter: UiReporter,
): boolean | null {
  try {
    return list.matches;
  } catch (error: unknown) {
    reporter.error('reduced-motion query could not be read', error, {
      query: REDUCED_MOTION_QUERY,
    });
    reporter.count('ui.motion.read_failed');

    return null;
  }
}

/**
 * Evaluates the query once, keeping the list where one was obtained.
 *
 * The single implementation behind both `queryReducedMotionPreference` and the
 * store's live subscription.
 *
 * @param source Resolved source, or `null` where none can evaluate a query.
 * @param reporter Contained sink.
 * @returns The list, where one was obtained, and the first answer.
 */
function openMotionQuery(
  source: MotionQuerySource | null,
  reporter: UiReporter,
): {
  readonly list: MotionQueryList | null;
  readonly query: ReducedMotionQuery;
} {
  if (source === null) {
    reporter.log('debug', 'reduced-motion query unavailable', {
      query: REDUCED_MOTION_QUERY,
      status: ABSENT_MOTION_QUERY.status,
    });
    reporter.count('ui.motion.query_absent');

    return { list: null, query: ABSENT_MOTION_QUERY };
  }

  let created: unknown;

  try {
    created = source.matchMedia(REDUCED_MOTION_QUERY);
  } catch (error: unknown) {
    reporter.error('reduced-motion query threw', error, {
      query: REDUCED_MOTION_QUERY,
      status: FAILED_MOTION_QUERY.status,
    });
    reporter.count('ui.motion.query_failed');

    return { list: null, query: FAILED_MOTION_QUERY };
  }

  if (!isMotionQueryList(created)) {
    reporter.log('warn', 'reduced-motion query carried no boolean matches', {
      query: REDUCED_MOTION_QUERY,
      status: FAILED_MOTION_QUERY.status,
    });
    reporter.count('ui.motion.query_failed');

    return { list: null, query: FAILED_MOTION_QUERY };
  }

  const matches = readMotionMatches(created, reporter);

  if (matches === null) {
    return { list: null, query: FAILED_MOTION_QUERY };
  }

  return { list: created, query: availableMotionQuery(matches) };
}

/**
 * Subscribes to query-list changes, preferring `addEventListener` and falling
 * back to the deprecated `addListener` where only that exists.
 *
 * @param list Query list to observe.
 * @param handler Called on every change.
 * @param reporter Contained sink.
 * @returns A detach function, or `null` where the list carries neither
 *   mechanism or the subscription threw.
 */
function attachMotionQueryListener(
  list: MotionQueryList,
  handler: MotionQueryChangeHandler,
  reporter: UiReporter,
): (() => void) | null {
  if (typeof list.addEventListener === 'function') {
    try {
      list.addEventListener('change', handler);
    } catch (error: unknown) {
      reporter.error('reduced-motion subscription threw', error, {
        query: REDUCED_MOTION_QUERY,
        mechanism: 'addEventListener',
      });

      return null;
    }

    return (): void => {
      if (typeof list.removeEventListener !== 'function') {
        return;
      }

      try {
        list.removeEventListener('change', handler);
      } catch (error: unknown) {
        reporter.error('reduced-motion teardown threw', error, {
          query: REDUCED_MOTION_QUERY,
          mechanism: 'removeEventListener',
        });
      }
    };
  }

  if (typeof list.addListener === 'function') {
    try {
      list.addListener(handler);
    } catch (error: unknown) {
      reporter.error('reduced-motion subscription threw', error, {
        query: REDUCED_MOTION_QUERY,
        mechanism: 'addListener',
      });

      return null;
    }

    return (): void => {
      if (typeof list.removeListener !== 'function') {
        return;
      }

      try {
        list.removeListener(handler);
      } catch (error: unknown) {
        reporter.error('reduced-motion teardown threw', error, {
          query: REDUCED_MOTION_QUERY,
          mechanism: 'removeListener',
        });
      }
    };
  }

  reporter.log('debug', 'reduced-motion query offers no change mechanism', {
    query: REDUCED_MOTION_QUERY,
  });

  return null;
}

/** Options accepted by `queryReducedMotionPreference`. */
export interface ReducedMotionQueryOptions {
  /** Sink the absent and failed states are reported through. */
  readonly reporter?: UiReporter;

  /**
   * Source the query is evaluated against. Defaults to the ambient global,
   * and resolves to no source at all where that offers no `matchMedia`.
   */
  readonly source?: MotionQuerySource | null;
}

/**
 * Reads the operating-system reduced-motion preference without throwing.
 *
 * An absent `matchMedia` — a Node test environment, or an older surface —
 * yields `supported: false`, `status: 'absent'` and `reduced: false`. A
 * `matchMedia` that throws, or that returns a value carrying no boolean
 * `matches`, yields `status: 'failed'` and `reduced: true`. Both are reported.
 *
 * @param options Sink and query source.
 * @returns The frozen answer and how it was obtained.
 */
export function queryReducedMotionPreference(
  options: ReducedMotionQueryOptions = {},
): ReducedMotionQuery {
  const reporter = createSafeUiReporter(options.reporter ?? NOOP_UI_REPORTER);

  return openMotionQuery(resolveMotionSource(options.source), reporter).query;
}

/**
 * Derives the effective reduced-motion value from the setting in force and
 * the platform's answer.
 *
 * @param setting The setting in force.
 * @param query The platform's answer, consulted only for `'system'`.
 * @returns Whether motion is to be reduced.
 */
export function resolveEffectiveReducedMotion(
  setting: MotionSetting,
  query: ReducedMotionQuery,
): boolean {
  if (setting === 'reduce') {
    return true;
  }

  if (setting === 'allow') {
    return false;
  }

  if (query === null || typeof query !== 'object') {
    return false;
  }

  return query.reduced === true;
}

/**
 * Maps a setting onto the tri-state override the render layer accepts, where
 * `null` means follow the media query.
 *
 * src/main.ts reads this and pushes the result into the render layer, which
 * this module does not import.
 *
 * @param setting The setting in force.
 * @returns `true` or `false` to force the value, `null` to follow the query.
 */
export function reducedMotionOverrideFor(
  setting: MotionSetting,
): boolean | null {
  if (setting === 'reduce') {
    return true;
  }

  if (setting === 'allow') {
    return false;
  }

  return null;
}

/* --------------------------------------------------------------------------
 * 4. Audio bounds and the number-only force
 * ----------------------------------------------------------------------- */

/** Lowest accepted volume. */
export const MIN_VOLUME = 0;

/** Highest accepted volume. */
export const MAX_VOLUME = 1;

/** The volume in force before anything is chosen. */
export const DEFAULT_VOLUME: number = MAX_VOLUME;

/** Whether the audio layer is muted before anything is chosen. */
export const DEFAULT_MUTED = false;

/** Whether number-only rendering is chosen before anything is chosen. */
export const DEFAULT_NUMBER_ONLY_MODE = false;

/**
 * Whether a value is a volume that can be applied as given.
 *
 * @param value Candidate volume.
 * @returns Whether `value` is a finite number within the bounds.
 */
export function isValidVolume(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= MIN_VOLUME &&
    value <= MAX_VOLUME
  );
}

/**
 * Brings a volume into range.
 *
 * @param value Candidate volume.
 * @returns `value` bounded by `MIN_VOLUME` and `MAX_VOLUME`, or
 *   `DEFAULT_VOLUME` where `value` is not a finite number.
 */
export function clampVolume(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_VOLUME;
  }

  return Math.min(MAX_VOLUME, Math.max(MIN_VOLUME, value));
}

/**
 * The number-only force, distinguishing a mode the player chose from one the
 * platform imposed (I6).
 */
export interface NumberOnlyForce {
  /** Whether the mode is imposed rather than chosen. */
  readonly forced: boolean;

  /** What imposed it, or `null` where nothing has. */
  readonly reason: string | null;
}

/** Reason recorded where a caller forces the mode without supplying one. */
const UNSTATED_FORCE_REASON = 'unstated';

/** Returned in place of a real unsubscribe where a subscription was refused. */
const NOOP_UNSUBSCRIBE = (): void => {
  return;
};


/* --------------------------------------------------------------------------
 * 5. The preference store
 * ----------------------------------------------------------------------- */

/**
 * The five preferences a change is reported against.
 *
 * A change to the raw motion setting is reported under `'reducedMotion'`, and
 * a change to the number-only force under `'numberOnlyMode'`: each is a facet
 * of the preference it is named by rather than a preference of its own.
 */
export type PreferenceKey =
  | 'reducedMotion'
  | 'theme'
  | 'numberOnlyMode'
  | 'muted'
  | 'volume';

/** Every preference key, in the order the settings surface presents them. */
export const PREFERENCE_KEYS: readonly PreferenceKey[] = Object.freeze([
  'reducedMotion',
  'theme',
  'numberOnlyMode',
  'muted',
  'volume',
] as const satisfies readonly PreferenceKey[]);

/**
 * A frozen snapshot of every effective preference, plus the raw motion setting
 * and the number-only force that produced two of them.
 *
 * Handed to every listener and returned by `PreferenceStore.getPreferences`.
 */
export interface UiPreferences {
  /** Effective reduced-motion value, the setting and the query combined. */
  readonly reducedMotion: boolean;

  /** The setting in force, before the query is consulted. */
  readonly motionSetting: MotionSetting;

  /** The palette in force. */
  readonly theme: ThemeId;

  /** Effective number-only value, the choice and the force combined. */
  readonly numberOnlyMode: boolean;

  /** Whether number-only rendering was chosen deliberately. */
  readonly numberOnlyChosen: boolean;

  /** Whether number-only rendering is imposed, and by what. */
  readonly numberOnlyForce: NumberOnlyForce;

  /** Whether the audio layer is muted. */
  readonly muted: boolean;

  /** Volume within `MIN_VOLUME` and `MAX_VOLUME`. */
  readonly volume: number;
}

/**
 * Notified after a preference changes, with the snapshot that now holds and
 * the keys that changed.
 *
 * Called synchronously on the setter's own call stack. Every listener in one
 * pass receives the same snapshot object.
 */
export type PreferenceListener = (
  preferences: UiPreferences,
  changed: readonly PreferenceKey[],
) => void;

/** Starting values a caller may supply. Each is validated before it is held. */
export interface InitialUiPreferences {
  /** Motion setting to start from. Defaults to `DEFAULT_MOTION_SETTING`. */
  readonly motionSetting?: MotionSetting;

  /** Palette to start from. Defaults to `DEFAULT_THEME_ID`. */
  readonly theme?: ThemeId;

  /**
   * Whether number-only rendering starts chosen. Defaults to
   * `DEFAULT_NUMBER_ONLY_MODE`.
   */
  readonly numberOnlyMode?: boolean;

  /** Whether audio starts muted. Defaults to `DEFAULT_MUTED`. */
  readonly muted?: boolean;

  /** Volume to start from. Defaults to `DEFAULT_VOLUME`. */
  readonly volume?: number;
}

/** Options accepted by `createPreferenceStore`. */
export interface PreferenceStoreOptions {
  /** Sink every rejection, clamp and listener failure is reported through. */
  readonly reporter?: UiReporter;

  /**
   * Source the reduced-motion query is evaluated against. Defaults to the
   * ambient global.
   */
  readonly motionSource?: MotionQuerySource | null;

  /**
   * Activation call a theme change is delegated to. Defaults to
   * `setActiveTheme` of src/theme/themes.ts, which owns the activation
   * attribute and the per-palette values style/_themes.scss selects on.
   */
  readonly activateTheme?: (id: ThemeId) => void;

  /** Starting values. */
  readonly initial?: InitialUiPreferences;
}

/**
 * The readable, settable and subscribable preference surface.
 *
 * src/ui/components/settings-panel.ts drives every setter, src/main.ts reads
 * `reducedMotionOverride()` and `isNumberOnlyMode()` to bridge them into the
 * render layer, and src/ui/a11y/live-region.ts subscribes to announce a
 * change. No member throws.
 */
export interface PreferenceStore {
  /** Every effective value as one frozen snapshot. */
  getPreferences(): UiPreferences;

  /** The platform's last reduced-motion answer, and how it was obtained. */
  getMotionQuery(): ReducedMotionQuery;

  /** The motion setting in force. */
  getMotionSetting(): MotionSetting;

  /**
   * Chooses how the reduced-motion preference is decided. An unrecognised
   * setting is reported and ignored.
   *
   * @param setting Setting to hold.
   */
  setMotionSetting(setting: MotionSetting): void;

  /** The effective reduced-motion value. */
  isReducedMotion(): boolean;

  /**
   * The effective value as the tri-state override the render layer accepts,
   * where `null` means follow the media query.
   */
  reducedMotionOverride(): boolean | null;

  /** The palette in force. */
  getTheme(): ThemeId;

  /**
   * Holds a palette and delegates its activation. An unrecognised id is
   * reported and ignored, so the default palette stays in force.
   *
   * @param id Palette to activate.
   */
  setTheme(id: ThemeId): void;

  /**
   * Delegates activation of the palette already in force, without changing it
   * and without notifying. The call src/main.ts makes at boot to establish the
   * activation attribute on a document that does not yet carry it.
   */
  applyCurrentTheme(): void;

  /** The effective number-only value: chosen or forced. */
  isNumberOnlyMode(): boolean;

  /**
   * Chooses number-only rendering. A request to turn it off while it is
   * forced is reported and leaves the effective value on.
   *
   * @param enabled Whether the mode is chosen.
   */
  setNumberOnlyMode(enabled: boolean): void;

  /** Whether number-only rendering is imposed rather than chosen. */
  isNumberOnlyForced(): boolean;

  /** Whether the mode is imposed, and by what. */
  getNumberOnlyForce(): NumberOnlyForce;

  /**
   * Imposes number-only rendering irrespective of the choice, for the case
   * where WebGL is unavailable (I6).
   *
   * @param reason What imposed it, carried into the report and to the
   *   settings surface.
   */
  forceNumberOnlyMode(reason: string): void;

  /** Lifts the force, leaving the choice in effect. */
  releaseNumberOnlyForce(): void;

  /** Whether the audio layer is muted. */
  isMuted(): boolean;

  /**
   * Holds the mute state.
   *
   * @param muted Whether audio is muted.
   */
  setMuted(muted: boolean): void;

  /** The volume in force. */
  getVolume(): number;

  /**
   * Holds a volume. A value outside the bounds is reported and the bounded
   * value is held; a value that is not a finite number is reported and
   * `DEFAULT_VOLUME` is held.
   *
   * @param volume Volume to hold.
   */
  setVolume(volume: number): void;

  /**
   * Registers a listener and returns its unsubscribe function.
   *
   * Listeners are appended and notified in registration order, the semantics
   * of js/keyboard_input_manager.js L18-L32, with each call isolated so one
   * that throws neither stops the remaining listeners nor reaches the setter.
   * The returned function is idempotent. A listener is never called on
   * registration.
   *
   * @param listener Callback invoked after a change.
   * @returns Function that removes `listener`.
   */
  subscribe(listener: PreferenceListener): () => void;

  /**
   * Releases the media-query listener and clears every subscriber. Held
   * values stay readable; every setter becomes a reported no-op. Calling it
   * more than once is harmless.
   */
  destroy(): void;
}

/**
 * Resolves the starting motion setting, reporting a rejected one.
 *
 * @param value Setting the caller supplied, if any.
 * @param reporter Contained sink.
 * @returns The supplied setting, or `DEFAULT_MOTION_SETTING`.
 */
function resolveInitialMotionSetting(
  value: MotionSetting | undefined,
  reporter: UiReporter,
): MotionSetting {
  if (value === undefined) {
    return DEFAULT_MOTION_SETTING;
  }

  if (isMotionSetting(value)) {
    return value;
  }

  reporter.log('warn', 'unrecognised initial motion setting ignored', {
    fallback: DEFAULT_MOTION_SETTING,
  });
  reporter.count('ui.preferences.motion_setting_rejected', {
    phase: 'initial',
  });

  return DEFAULT_MOTION_SETTING;
}

/**
 * Resolves the starting palette, reporting a rejected one.
 *
 * @param value Palette the caller supplied, if any.
 * @param reporter Contained sink.
 * @returns The supplied id, or `DEFAULT_THEME_ID`.
 */
function resolveInitialTheme(
  value: ThemeId | undefined,
  reporter: UiReporter,
): ThemeId {
  if (value === undefined) {
    return DEFAULT_THEME_ID;
  }

  if (isThemeId(value)) {
    return value;
  }

  reporter.log('warn', 'unrecognised initial theme ignored', {
    fallback: DEFAULT_THEME_ID,
  });
  reporter.count('ui.preferences.theme_rejected', { phase: 'initial' });

  return DEFAULT_THEME_ID;
}

/**
 * Resolves the starting volume, reporting one that had to be bounded.
 *
 * @param value Volume the caller supplied, if any.
 * @param reporter Contained sink.
 * @returns A volume within the bounds.
 */
function resolveInitialVolume(
  value: number | undefined,
  reporter: UiReporter,
): number {
  if (value === undefined) {
    return DEFAULT_VOLUME;
  }

  if (isValidVolume(value)) {
    return value;
  }

  const applied = clampVolume(value);

  reporter.log('warn', 'initial volume brought into range', {
    requested: Number(value),
    applied,
    minimum: MIN_VOLUME,
    maximum: MAX_VOLUME,
  });
  reporter.count('ui.preferences.volume_clamped', { phase: 'initial' });

  return applied;
}

/**
 * Resolves a starting boolean, reporting one of the wrong type.
 *
 * @param value Value the caller supplied, if any.
 * @param fallback Value held where none was supplied or it was rejected.
 * @param preference Name of the preference, carried into the report.
 * @param reporter Contained sink.
 * @returns The supplied value, or `fallback`.
 */
function resolveInitialBoolean(
  value: boolean | undefined,
  fallback: boolean,
  preference: string,
  reporter: UiReporter,
): boolean {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  reporter.log('warn', 'initial preference of the wrong type ignored', {
    preference,
    expected: 'boolean',
    fallback,
  });
  reporter.count('ui.preferences.initial_rejected', { preference });

  return fallback;
}

/**
 * Builds the preference store.
 *
 * Evaluates the reduced-motion query once and, where the platform supports it,
 * attaches one change listener so an operating-system preference toggled
 * mid-session propagates. Nothing else happens at construction: no storage is
 * read, no activation attribute is written, and no listener is notified.
 *
 * Values are held in memory for the session. This store persists nothing and
 * declares no storage key.
 *
 * @param options Sink, motion source, activation call and starting values.
 * @returns The store. Every member is safe to call with no document.
 */
export function createPreferenceStore(
  options: PreferenceStoreOptions = {},
): PreferenceStore {
  const reporter = createSafeUiReporter(options.reporter ?? NOOP_UI_REPORTER);
  const activateTheme = options.activateTheme ?? setActiveTheme;
  const initial = options.initial ?? {};

  const opened = openMotionQuery(
    resolveMotionSource(options.motionSource),
    reporter,
  );
  const queryList = opened.list;

  let motionQuery: ReducedMotionQuery = opened.query;
  let motionSetting = resolveInitialMotionSetting(
    initial.motionSetting,
    reporter,
  );
  let theme = resolveInitialTheme(initial.theme, reporter);
  let numberOnlyChosen = resolveInitialBoolean(
    initial.numberOnlyMode,
    DEFAULT_NUMBER_ONLY_MODE,
    'numberOnlyMode',
    reporter,
  );
  let forceReason: string | null = null;
  let muted = resolveInitialBoolean(
    initial.muted,
    DEFAULT_MUTED,
    'muted',
    reporter,
  );
  let volume = resolveInitialVolume(initial.volume, reporter);

  const listeners: PreferenceListener[] = [];
  let cached: UiPreferences | null = null;
  let destroyed = false;
  let detachMotionQuery: (() => void) | null = null;

  /**
   * The effective reduced-motion value.
   *
   * @returns Whether motion is to be reduced.
   */
  function effectiveReducedMotion(): boolean {
    return resolveEffectiveReducedMotion(motionSetting, motionQuery);
  }

  /**
   * The effective number-only value.
   *
   * @returns Whether number-only rendering applies.
   */
  function effectiveNumberOnly(): boolean {
    return forceReason !== null || numberOnlyChosen;
  }

  /**
   * The snapshot, built once per change and shared by every reader.
   *
   * @returns The frozen snapshot.
   */
  function readSnapshot(): UiPreferences {
    const held = cached;

    if (held !== null) {
      return held;
    }

    const built: UiPreferences = Object.freeze({
      reducedMotion: effectiveReducedMotion(),
      motionSetting,
      theme,
      numberOnlyMode: effectiveNumberOnly(),
      numberOnlyChosen,
      numberOnlyForce: Object.freeze({
        forced: forceReason !== null,
        reason: forceReason,
      }),
      muted,
      volume,
    });

    cached = built;

    return built;
  }

  /**
   * Notifies every listener, isolating each call.
   *
   * @param changed Keys whose values changed.
   */
  function notify(changed: readonly PreferenceKey[]): void {
    if (changed.length === 0 || listeners.length === 0) {
      return;
    }

    const preferences = readSnapshot();
    const frozenChanged = Object.freeze(changed);

    // Iterated over a copy, so a listener that subscribes or unsubscribes
    // while being notified is neither skipped nor notified twice in this pass.
    for (const listener of listeners.slice()) {
      try {
        listener(preferences, frozenChanged);
      } catch (error: unknown) {
        reporter.error('ui preference listener threw', error, {
          changed: frozenChanged.join(','),
        });
        reporter.count('ui.preferences.listener_failed', {
          changed: frozenChanged.join(','),
        });
      }
    }
  }

  /**
   * Discards the snapshot and notifies.
   *
   * @param changed Keys whose values changed.
   */
  function commit(changed: readonly PreferenceKey[]): void {
    cached = null;
    notify(changed);
  }

  /**
   * Reports and refuses a change made after `destroy`.
   *
   * @param operation Name of the refused call.
   * @returns Whether the call is refused.
   */
  function refuseAfterDestroy(operation: string): boolean {
    if (!destroyed) {
      return false;
    }

    reporter.log('debug', 'ui preference change after destroy ignored', {
      operation,
    });
    reporter.count('ui.preferences.change_after_destroy', { operation });

    return true;
  }

  /**
   * Delegates activation, containing a throw from the activation call or from
   * any theme-change listener it notifies.
   *
   * @param id Palette to activate.
   */
  function delegateActivation(id: ThemeId): void {
    try {
      activateTheme(id);
    } catch (error: unknown) {
      reporter.error('theme activation threw', error, { theme: id });
      reporter.count('ui.preferences.theme_activation_failed', { theme: id });
    }
  }

  /** Re-reads the query after a change event and notifies on a real change. */
  function handleMotionQueryChange(): void {
    if (destroyed || queryList === null) {
      return;
    }

    const previous = effectiveReducedMotion();
    const matches = readMotionMatches(queryList, reporter);

    motionQuery =
      matches === null ? FAILED_MOTION_QUERY : availableMotionQuery(matches);

    reporter.count('ui.motion.query_changed', {
      status: motionQuery.status,
      reduced: motionQuery.reduced,
    });

    // The query itself is not part of the snapshot, so a change the setting
    // overrides notifies nobody.
    if (effectiveReducedMotion() === previous) {
      return;
    }

    commit(['reducedMotion']);
  }

  if (queryList !== null) {
    detachMotionQuery = attachMotionQueryListener(
      queryList,
      handleMotionQueryChange,
      reporter,
    );
  }

  return Object.freeze({
    getPreferences(): UiPreferences {
      return readSnapshot();
    },

    getMotionQuery(): ReducedMotionQuery {
      return motionQuery;
    },

    getMotionSetting(): MotionSetting {
      return motionSetting;
    },

    setMotionSetting(setting: MotionSetting): void {
      if (refuseAfterDestroy('setMotionSetting')) {
        return;
      }

      if (!isMotionSetting(setting)) {
        reporter.log('warn', 'unrecognised motion setting ignored', {
          held: motionSetting,
        });
        reporter.count('ui.preferences.motion_setting_rejected', {
          phase: 'set',
        });

        return;
      }

      if (setting === motionSetting) {
        return;
      }

      motionSetting = setting;

      commit(['reducedMotion']);
    },

    isReducedMotion(): boolean {
      return effectiveReducedMotion();
    },

    reducedMotionOverride(): boolean | null {
      return reducedMotionOverrideFor(motionSetting);
    },

    getTheme(): ThemeId {
      return theme;
    },

    setTheme(id: ThemeId): void {
      if (refuseAfterDestroy('setTheme')) {
        return;
      }

      if (!isThemeId(id)) {
        reporter.log('warn', 'unrecognised theme ignored', { held: theme });
        reporter.count('ui.preferences.theme_rejected', { phase: 'set' });

        return;
      }

      if (id === theme) {
        return;
      }

      theme = id;

      delegateActivation(id);

      commit(['theme']);
    },

    applyCurrentTheme(): void {
      delegateActivation(theme);
    },

    isNumberOnlyMode(): boolean {
      return effectiveNumberOnly();
    },

    setNumberOnlyMode(enabled: boolean): void {
      if (refuseAfterDestroy('setNumberOnlyMode')) {
        return;
      }

      if (typeof enabled !== 'boolean') {
        reporter.log('warn', 'number-only request of the wrong type ignored', {
          expected: 'boolean',
          held: numberOnlyChosen,
        });
        reporter.count('ui.preferences.initial_rejected', {
          preference: 'numberOnlyMode',
        });

        return;
      }

      if (!enabled && forceReason !== null) {
        reporter.log('warn', 'number-only mode stays on while forced', {
          reason: forceReason,
        });
        reporter.count('ui.preferences.number_only_release_refused', {
          reason: forceReason,
        });
      }

      if (enabled === numberOnlyChosen) {
        return;
      }

      numberOnlyChosen = enabled;

      commit(['numberOnlyMode']);
    },

    isNumberOnlyForced(): boolean {
      return forceReason !== null;
    },

    getNumberOnlyForce(): NumberOnlyForce {
      return readSnapshot().numberOnlyForce;
    },

    forceNumberOnlyMode(reason: string): void {
      if (refuseAfterDestroy('forceNumberOnlyMode')) {
        return;
      }

      const recorded =
        typeof reason === 'string' && reason.length > 0
          ? reason
          : UNSTATED_FORCE_REASON;

      if (recorded === forceReason) {
        return;
      }

      forceReason = recorded;

      reporter.log('warn', 'number-only mode forced', {
        reason: recorded,
        chosen: numberOnlyChosen,
      });
      reporter.count('ui.preferences.number_only_forced', {
        reason: recorded,
      });

      commit(['numberOnlyMode']);
    },

    releaseNumberOnlyForce(): void {
      if (refuseAfterDestroy('releaseNumberOnlyForce')) {
        return;
      }

      const released = forceReason;

      if (released === null) {
        return;
      }

      forceReason = null;

      reporter.log('info', 'number-only force released', {
        reason: released,
        chosen: numberOnlyChosen,
      });
      reporter.count('ui.preferences.number_only_force_released', {
        reason: released,
      });

      commit(['numberOnlyMode']);
    },

    isMuted(): boolean {
      return muted;
    },

    setMuted(next: boolean): void {
      if (refuseAfterDestroy('setMuted')) {
        return;
      }

      if (typeof next !== 'boolean') {
        reporter.log('warn', 'mute request of the wrong type ignored', {
          expected: 'boolean',
          held: muted,
        });
        reporter.count('ui.preferences.initial_rejected', {
          preference: 'muted',
        });

        return;
      }

      if (next === muted) {
        return;
      }

      muted = next;

      commit(['muted']);
    },

    getVolume(): number {
      return volume;
    },

    setVolume(next: number): void {
      if (refuseAfterDestroy('setVolume')) {
        return;
      }

      const applied = clampVolume(next);

      if (!isValidVolume(next)) {
        reporter.log('warn', 'volume brought into range', {
          requested: Number(next),
          applied,
          minimum: MIN_VOLUME,
          maximum: MAX_VOLUME,
        });
        reporter.count('ui.preferences.volume_clamped', { phase: 'set' });
      }

      if (applied === volume) {
        return;
      }

      volume = applied;

      commit(['volume']);
    },

    subscribe(listener: PreferenceListener): () => void {
      if (typeof listener !== 'function') {
        reporter.log('warn', 'ui preference listener rejected', {
          expected: 'function',
        });
        reporter.count('ui.preferences.listener_rejected');

        return NOOP_UNSUBSCRIBE;
      }

      if (destroyed) {
        reporter.log('debug', 'ui preference subscription after destroy', {});
        reporter.count('ui.preferences.subscribe_after_destroy');

        return NOOP_UNSUBSCRIBE;
      }

      // Appended, the semantics of js/keyboard_input_manager.js L18-L32.
      listeners.push(listener);

      let released = false;

      return (): void => {
        if (released) {
          return;
        }

        released = true;

        const index = listeners.indexOf(listener);

        if (index >= 0) {
          listeners.splice(index, 1);
        }
      };
    },

    destroy(): void {
      if (destroyed) {
        return;
      }

      destroyed = true;

      const detach = detachMotionQuery;

      detachMotionQuery = null;

      if (detach !== null) {
        detach();
      }

      listeners.length = 0;
      cached = null;

      reporter.log('debug', 'ui preference store destroyed', {});
      reporter.count('ui.preferences.destroyed');
    },
  });
}

