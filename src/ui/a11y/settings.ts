/**
 * Preference detection for the accessibility surface, plus the two contracts
 * every other module under src/ui/ consumes from here: the injected report
 * sink and the guarded mount resolver.
 *
 * Subscription semantics are those of js/keyboard_input_manager.js — an
 * appended callback list iterated synchronously — with per-listener error
 * isolation added.
 *
 * Preferences are held in memory for the session: this module reads and writes
 * no storage and declares no storage key.
 *
 * Decisions: DL-SETTINGS-01, DL-SETTINGS-02, DL-SETTINGS-03, DL-SETTINGS-04,
 * DL-SETTINGS-05, DL-THEME-01, DL-THEME-02 (docs/DECISION_LOG.md).
 */

import {
  DEFAULT_MUTED,
  DEFAULT_VOLUME,
  MAX_VOLUME,
  MIN_VOLUME,
} from '../../config/audio-bounds';
import type { ThemeId } from '../../theme/themes';
import {
  DEFAULT_THEME_ID,
  isThemeId,
  setActiveTheme,
} from '../../theme/themes';

/** Severity of a report. */
export type UiReportLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured fields attached to a report. */
export type UiReportFields = Record<string, string | number | boolean>;

/**
 * Sink every module under src/ui/ reports through.
 *
 * Injected, never imported: this module names no observability module, so a
 * caller adapts a logger onto this shape from the outside and a test
 * substitutes a recording fake. `error` carries the caught value unchanged.
 *
 * Every function and factory in this module that accepts a reporter defaults
 * it to `NOOP_UI_REPORTER`, so each is usable with no sink and no mocking
 * library.
 */
export interface UiReporter {
  log(level: UiReportLevel, message: string, fields?: UiReportFields): void;
  count(metric: string, fields?: UiReportFields): void;
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

/**
 * The minimum a value must implement to be searched for a mount.
 *
 * `Document`, `Element` and `DocumentFragment` all satisfy it, and so does a
 * hand-built stand-in in a test.
 */
export interface MountRoot {
  /** Returns the first descendant matching `selectors`, or `null`. */
  querySelector<E extends Element = Element>(selectors: string): E | null;
}

/** One mount a resolution asked for and did not obtain. */
export interface MissingMount {
  readonly name: string;

  /** Selector that matched nothing, or that could not be evaluated. */
  readonly selector: string;
  readonly context: string;
  readonly cause: MissingMountCause;
}

/** Why a mount was not obtained. */
export type MissingMountCause = 'no-match' | 'no-root' | 'query-failed';

/** Options shared by both resolvers. */
export interface ResolveMountOptions {
  readonly root?: MountRoot | null;
  readonly reporter?: UiReporter;
  readonly context?: string;
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
  readonly complete: boolean;
}

/** A resolution in which every name resolved. */
export type CompleteMountResolution<
  S extends MountSpec,
  E extends Element = HTMLElement,
> = MountResolution<S, E> & {
  readonly elements: { readonly [K in keyof S]: E };
};

const DEFAULT_MOUNT_CONTEXT = 'ui';

function isMountRoot(value: unknown): value is MountRoot {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const candidate: { readonly querySelector?: unknown } = value;

  return typeof candidate.querySelector === 'function';
}

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
 * Selectors are supplied by the caller. This module declares none of its own,
 * and index.html is the authority for every one of them.
 *
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
 * Resolves a whole mount set in one pass, collecting the misses as data, so a
 * caller can resolve once and inject the elements downward rather than have
 * every consumer perform a lookup of its own.
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

/** Narrows a resolution to one whose every entry is present. */
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

/**
 * Media query the operating-system preference is read from.
 *
 * No stylesheet in the retired sources referenced it. style/_a11y.scss carries
 * the CSS layer keyed on the same feature, and src/render/ queries the same
 * feature independently for the effects it gates; neither module imports the
 * other.
 */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** State of the reduced-motion query. */
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
  readonly matches: boolean;
  readonly addEventListener?: (
    type: 'change',
    handler: MotionQueryChangeHandler,
  ) => void;

  readonly removeEventListener?: (
    type: 'change',
    handler: MotionQueryChangeHandler,
  ) => void;

  readonly addListener?: (handler: MotionQueryChangeHandler) => void;
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
  readonly matchMedia: (query: string) => unknown;
}

/** The reduced-motion query's answer, and whether it could be read. */
export interface ReducedMotionQuery {
  readonly reduced: boolean;
  readonly supported: boolean;

  /** Available, absent, or present and failing. */
  readonly status: MotionQueryStatus;
}

/** How the reduced-motion preference is decided. */
export type MotionSetting = 'system' | 'reduce' | 'allow';

/** Every motion setting, in the order the settings surface presents them. */
export const MOTION_SETTINGS: readonly MotionSetting[] = Object.freeze([
  'system',
  'reduce',
  'allow',
] as const satisfies readonly MotionSetting[]);

/** The setting in force before anything is chosen. */
export const DEFAULT_MOTION_SETTING: MotionSetting = 'system';

/** Narrows an unknown value to a `MotionSetting`. */
export function isMotionSetting(value: unknown): value is MotionSetting {
  return (
    typeof value === 'string' &&
    (MOTION_SETTINGS as readonly string[]).includes(value)
  );
}

function isMotionQueryList(value: unknown): value is MotionQueryList {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const candidate: { readonly matches?: unknown } = value;

  return typeof candidate.matches === 'boolean';
}

function isMotionQuerySource(value: unknown): value is MotionQuerySource {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const candidate: { readonly matchMedia?: unknown } = value;

  return typeof candidate.matchMedia === 'function';
}

function resolveMotionSource(
  source: MotionQuerySource | null | undefined,
): MotionQuerySource | null {
  if (source !== undefined && source !== null) {
    return isMotionQuerySource(source) ? source : null;
  }

  return isMotionQuerySource(globalThis) ? globalThis : null;
}

const ABSENT_MOTION_QUERY: ReducedMotionQuery = Object.freeze({
  reduced: false,
  supported: false,
  status: 'absent',
});

const FAILED_MOTION_QUERY: ReducedMotionQuery = Object.freeze({
  reduced: true,
  supported: false,
  status: 'failed',
});

function availableMotionQuery(reduced: boolean): ReducedMotionQuery {
  return Object.freeze({ reduced, supported: true, status: 'available' });
}

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
 * @returns The frozen answer and how it was obtained.
 */
export function queryReducedMotionPreference(
  options: ReducedMotionQueryOptions = {},
): ReducedMotionQuery {
  const reporter = createSafeUiReporter(options.reporter ?? NOOP_UI_REPORTER);

  return openMotionQuery(resolveMotionSource(options.source), reporter).query;
}

/**
 * Derives the effective reduced-motion value from the setting in force and the
 * platform's answer.
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
 * A caller reads this and pushes the result into the render layer, which this
 * module does not import.
 *
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

/**
 * Attribute the effective reduced-motion value is reflected onto the document
 * element in.
 *
 * Two consumers read it: `style/_a11y.scss` selects on it, and
 * `src/input/on-screen-controls.ts` reads it when it holds no override of its
 * own.
 */
export const REDUCED_MOTION_ATTRIBUTE = 'data-reduced-motion';

/** Value `REDUCED_MOTION_ATTRIBUTE` carries while motion is reduced. */
export const REDUCED_MOTION_TRUE = 'true';

/** Value `REDUCED_MOTION_ATTRIBUTE` carries while motion is permitted. */
export const REDUCED_MOTION_FALSE = 'false';

/**
 * Reflects an effective reduced-motion value onto an element.
 *
 * Always writes an explicit `'true'` or `'false'`, never removing the
 * attribute: the stylesheet distinguishes an explicit `'false'` — the user
 * asked to keep motion — from an absent attribute, where the operating system
 * still decides.
 *
 * @param target Element to write to, or `null` to do nothing.
 * @param reduced The effective value.
 * @returns Whether the attribute was written.
 */
export function reflectReducedMotion(
  target: Element | null,
  reduced: boolean,
): boolean {
  if (target === null) {
    return false;
  }

  try {
    target.setAttribute(
      REDUCED_MOTION_ATTRIBUTE,
      reduced ? REDUCED_MOTION_TRUE : REDUCED_MOTION_FALSE,
    );

    return true;
  } catch {
    // A target that rejects the write is reported by the caller, which owns a
    // sink; this function has none and never throws.
    return false;
  }
}

/**
 * Reads an effective reduced-motion value back off an element.
 *
 * @param target Element to read from, or `null`.
 * @returns `true` or `false` where the attribute carries one of the two
 *   explicit values, and `null` where it is absent or carries anything else,
 *   which is the caller's signal to fall back to its own source.
 */
export function readReflectedReducedMotion(
  target: Element | null,
): boolean | null {
  if (target === null) {
    return null;
  }

  const value = target.getAttribute(REDUCED_MOTION_ATTRIBUTE);

  if (value === REDUCED_MOTION_TRUE) {
    return true;
  }

  if (value === REDUCED_MOTION_FALSE) {
    return false;
  }

  return null;
}

// Re-exported, not redeclared: src/config/audio-bounds.ts holds the one
// declaration of these four values.
export {
  DEFAULT_MUTED,
  DEFAULT_VOLUME,
  MAX_VOLUME,
  MIN_VOLUME,
} from '../../config/audio-bounds';

/** Whether number-only rendering is chosen before anything is chosen. */
export const DEFAULT_NUMBER_ONLY_MODE = false;

/** Whether a value is a volume that can be applied as given. */
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
  readonly forced: boolean;

  /** What imposed it, or `null` where nothing has. */
  readonly reason: string | null;
}

const UNSTATED_FORCE_REASON = 'unstated';

const NOOP_UNSUBSCRIBE = (): void => {
  return;
};

/** The five preferences a change is reported against. */
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
  readonly reducedMotion: boolean;

  /** The setting in force, before the query is consulted. */
  readonly motionSetting: MotionSetting;
  readonly theme: ThemeId;

  /** Effective number-only value, the choice and the force combined. */
  readonly numberOnlyMode: boolean;

  /** Whether number-only rendering was chosen deliberately. */
  readonly numberOnlyChosen: boolean;

  /** Whether number-only rendering is imposed, and by what. */
  readonly numberOnlyForce: NumberOnlyForce;
  readonly muted: boolean;
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

/**
 * Starting values a caller may supply. Each is validated before it is held.
 */
export interface InitialUiPreferences {
  readonly motionSetting?: MotionSetting;
  readonly theme?: ThemeId;

  /**
   * Whether number-only rendering starts chosen. Defaults to
   * `DEFAULT_NUMBER_ONLY_MODE`.
   */
  readonly numberOnlyMode?: boolean;
  readonly muted?: boolean;
  readonly volume?: number;
}

/** Options accepted by `createPreferenceStore`. */
export interface PreferenceStoreOptions {
  /** Sink every rejection, clamp and listener failure is reported through. */
  readonly reporter?: UiReporter;
  readonly motionSource?: MotionQuerySource | null;
  readonly activateTheme?: (id: ThemeId) => void;
  readonly initial?: InitialUiPreferences;
}

/** The readable, settable and subscribable preference surface. */
export interface PreferenceStore {
  /** Every effective value as one frozen snapshot. */
  getPreferences(): UiPreferences;
  getMotionQuery(): ReducedMotionQuery;
  getMotionSetting(): MotionSetting;

  /**
   * Chooses how the reduced-motion preference is decided. An unrecognised
   * setting is reported and ignored.
   */
  setMotionSetting(setting: MotionSetting): void;
  isReducedMotion(): boolean;

  /**
   * The effective value as the tri-state override the render layer accepts,
   * where `null` means follow the media query.
   */
  reducedMotionOverride(): boolean | null;
  getTheme(): ThemeId;

  /**
   * Holds a palette and delegates its activation. An unrecognised id is
   * reported and ignored, so the default palette stays in force.
   */
  setTheme(id: ThemeId): void;

  /**
   * Delegates activation of the palette already in force, without changing it
   * and without notifying. The call to make at boot to establish the
   * activation attribute on a document that does not yet carry it.
   */
  applyCurrentTheme(): void;

  /** The effective number-only value: chosen or forced. */
  isNumberOnlyMode(): boolean;

  /**
   * Chooses number-only rendering. A request to turn it off while it is forced
   * is reported and leaves the effective value on.
   */
  setNumberOnlyMode(enabled: boolean): void;

  /** Whether number-only rendering is imposed rather than chosen. */
  isNumberOnlyForced(): boolean;
  getNumberOnlyForce(): NumberOnlyForce;

  /**
   * Imposes number-only rendering irrespective of the choice, for the case
   * where WebGL is unavailable (I6).
   */
  forceNumberOnlyMode(reason: string): void;
  releaseNumberOnlyForce(): void;
  isMuted(): boolean;
  setMuted(muted: boolean): void;
  getVolume(): number;

  /**
   * Holds a volume. A value outside the bounds is reported and the bounded
   * value is held; a value that is not a finite number is reported and
   * `DEFAULT_VOLUME` is held.
   */
  setVolume(volume: number): void;

  /** Registers a listener and returns its unsubscribe function. */
  subscribe(listener: PreferenceListener): () => void;

  /**
   * Releases the media-query listener and clears every subscriber. Held values
   * stay readable; every setter becomes a reported no-op.
   */
  destroy(): void;
}

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

  function commit(changed: readonly PreferenceKey[]): void {
    cached = null;
    notify(changed);
  }

  /** Reports and refuses a change made after `destroy`. */
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
