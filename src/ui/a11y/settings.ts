/**
 * Preference detection for the accessibility surface, plus the two contracts
 * every other module under src/ui/ consumes from here: the injected report
 * sink and the guarded mount resolver.
 *
 * Subscription semantics are those of js/keyboard_input_manager.js — an
 * appended callback list iterated synchronously — with per-listener error
 * isolation added.
 *
 * This module reads and writes no storage and declares no storage key. It
 * declares the SHAPE preferences are persisted in — `PreferencesPayload`, with
 * `serializePreferences` and `deserializePreferences` as the pure pair either
 * side of it — and the composition root performs the I/O under the key
 * src/storage/storage-keys.ts mints.
 *
 * One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
 * this module's area enumerated:
 *   TR-SETTINGS-01  js/html_actuator.js L2-L5     the four unguarded lookups,
 *                                                 replaced by `resolveMount`
 *   TR-SETTINGS-02  js/keyboard_input_manager.js  the unguarded host lookups,
 *                   L78, L141                     replaced by `resolveMounts`
 *                                                 and `isMountComplete`
 *   TR-SETTINGS-03  js/keyboard_input_manager.js  the appended callback list
 *                   L18-L32                       iterated synchronously,
 *                                                 ported as `PreferenceStore`
 *                                                 subscription with
 *                                                 per-listener error isolation
 *   TR-SETTINGS-04  js/local_storage_manager.js   the discarded caught value,
 *                   L37                           replaced by the injected
 *                                                 `UiReporter` and
 *                                                 `createSafeUiReporter`
 *   TR-SETTINGS-05  target-only row               the reduced-motion surface:
 *                                                 `REDUCED_MOTION_QUERY`,
 *                                                 `queryReducedMotionPreference`,
 *                                                 `resolveEffectiveReducedMotion`
 *                                                 and the three-state
 *                                                 `MotionSetting`
 *   TR-SETTINGS-06  target-only row               `UiPreferences`,
 *                                                 `PREFERENCE_KEYS` and
 *                                                 `createPreferenceStore`
 *   TR-SETTINGS-07  target-only row               `reflectReducedMotion` and
 *                                                 `readReflectedReducedMotion`
 *   TR-SETTINGS-08  target-only row               `isValidVolume`,
 *                                                 `clampVolume` and
 *                                                 `NumberOnlyForce`
 *   TR-SETTINGS-09  target-only row               `PreferencesPayload`,
 *                                                 `serializePreferences` and
 *                                                 `deserializePreferences`
 *
 * Decisions: DL-SETTINGS-01, DL-SETTINGS-02, DL-SETTINGS-03, DL-SETTINGS-04,
 * DL-SETTINGS-05, DL-SETTINGS-06, DL-SETTINGS-07, DL-SETTINGS-08,
 * DL-SETTINGS-09, DL-THEME-01, DL-THEME-02 (docs/DECISION_LOG.md).
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

  /**
   * Reports a caught value AT A LEVEL THE CALLER CHOOSES.
   *
   * `error` above fixes the severity at `error`, so a RECOVERED failure — a
   * clipboard refusal the selection path carries — had nowhere to send the value
   * it caught and stringified it into an ordinary field instead. Ordinary fields
   * are shape-normalised and never sensitivity-redacted, so arbitrary caught
   * text reached the log buffer and every export of it. This channel carries the
   * value ITSELF, which the adapter hands to the observability layer's failure
   * path where redaction and the record budget apply.
   *
   * Optional so an existing sink stays valid: `createSafeUiReporter` fills the
   * gap for one that implements none, and does so WITHOUT copying the caught
   * value's own text. `InputReporter.failure` of src/input/keymap.ts is the
   * shape this follows. DL-SETTINGS-07.
   *
   * @param level Severity the report is filed at.
   * @param message Message the report carries.
   * @param thrown The caught value, passed through unchanged.
   * @param fields Structured fields, which carry no caught text.
   */
  failure?(
    level: UiReportLevel,
    message: string,
    thrown: unknown,
    fields?: UiReportFields,
  ): void;

  /**
   * Reads the correlation scope this sink is currently filing under.
   *
   * A screen that awaits — the run summary awaits `clipboard.writeText` — can
   * be answered after the player has begun another run, and a run beginning
   * ROTATES the one scope every report is keyed to. A report filed at that
   * point describes the run that made the attempt while being labelled with the
   * run now in force. Reading the scope when the attempt OPENS gives the
   * delayed report something to compare against, so it can name the run it
   * belongs to and withhold a per-run count that would land in the wrong one.
   *
   * Optional so an existing sink stays valid, and `createSafeUiReporter` fills
   * the gap with the empty string — which callers read as "no scope is
   * knowable", never as a scope that differs. DL-SUMMARY-18.
   *
   * @returns The scope identifier, or the empty string where none is knowable.
   */
  scope?(): string;
}

/** Value reported where a caught value offered no usable name. */
const UNKNOWN_THROWN_NAME = 'unknown';

/**
 * The shape a caught value's `name` must already have to be reported.
 *
 * An error class is an identifier — `TypeError`, `NotAllowedError`,
 * `QuotaExceededError` — so a `name` that is not one is not a class and is
 * refused rather than trimmed into something that looks like one. Bounded at 64
 * characters, which is longer than every name the platform defines.
 * DL-SETTINGS-08.
 */
const THROWN_NAME_PATTERN = /^[A-Za-z_$][\w$]{0,63}$/u;

/**
 * Names a caught value in a form that carries no caught text.
 *
 * The name of an `Error` — `NotAllowedError`, `SecurityError`, `TypeError` — is
 * a CLASS, so it says what kind of failure occurred without carrying the
 * message, the stack or any value the failure was about. It is read through a
 * guard because a hostile or exotic throwable can define a `name` accessor that
 * itself throws, and it is accepted only where it ALREADY has the shape of a
 * class name: a `name` is platform-supplied rather than chosen here, and text
 * that is not an identifier is refused whole rather than trimmed into something
 * that reads like one. Anything that is not an object is named by its TYPE alone
 * and never coerced. DL-SETTINGS-08.
 *
 * @param thrown The caught value.
 * @returns A bounded name, never the value's own message.
 */
export function nameThrown(thrown: unknown): string {
  if (typeof thrown !== 'object' || thrown === null) {
    return typeof thrown;
  }

  let read: unknown;

  try {
    read = (thrown as { name?: unknown }).name;
  } catch {
    return UNKNOWN_THROWN_NAME;
  }

  return typeof read === 'string' && THROWN_NAME_PATTERN.test(read)
    ? read
    : UNKNOWN_THROWN_NAME;
}

/** Shape reported for a value that will not answer what it is. */
const UNREADABLE_SHAPE = 'unreadable';

/** Shape reported for a field that is present as an accessor. */
const ACCESSOR_SHAPE = 'accessor';

/**
 * `Array.isArray` under a guard.
 *
 * It is the one predicate in this module that can throw on a value nothing has
 * been invoked on: the check consults a proxy's handler, and a REVOKED proxy
 * has none, so `Array.isArray` on one raises a `TypeError`. Everything else the
 * loader does to an untrusted payload — `typeof`, an identity comparison — is
 * inert. DL-SETTINGS-09.
 *
 * @param value Value of unknown provenance.
 * @returns Whether it is an array, or `null` where the question could not be
 *   answered at all.
 */
function isArrayPayload(value: unknown): boolean | null {
  try {
    return Array.isArray(value);
  } catch {
    return null;
  }
}

/**
 * Names the SHAPE of an untrusted value without coercing it.
 *
 * `typeof` reads a value's kind without invoking anything on it, so a value with
 * a hostile `toString` or `Symbol.toPrimitive` is described rather than executed
 * — and the description carries none of the value's content. `null` and an array
 * are named apart from the plain objects `typeof` groups them with, because a
 * loader rejecting a payload is usually rejecting one of those two.
 * DL-SETTINGS-08.
 *
 * The array test goes through `isArrayPayload`, so a value that will
 * not answer what it is — a revoked proxy — is named `unreadable` rather than
 * raising out of the report being built. DL-SETTINGS-09.
 *
 * @param value Value of unknown provenance.
 * @returns One bounded word naming its shape.
 */
function describeShape(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  const array = isArrayPayload(value);

  if (array === null) {
    return UNREADABLE_SHAPE;
  }

  return array ? 'array' : typeof value;
}

/**
 * The outcome of reading one property off an untrusted payload.
 *
 * `ok` says the payload answered. It answers with `undefined` for a property it
 * does not carry, which is the same answer an absent field has always given.
 */
type OwnDataRead =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly cause: typeof ACCESSOR_SHAPE | typeof UNREADABLE_SHAPE;
    };

/** The answer for a property the payload does not carry. */
const OWN_DATA_ABSENT: OwnDataRead = Object.freeze({
  ok: true,
  value: undefined,
});

/**
 * Reads one own DATA property, invoking nothing on the payload.
 *
 * A bracket lookup is not a read but a CALL waiting to happen: it walks the
 * prototype chain, runs an accessor it finds there or on the object itself, and
 * runs a proxy's `get` trap — any of which can throw straight out of a loader
 * that promises never to. A descriptor read invokes none of them. The descriptor
 * a proxy trap returns is normalised by the engine into an ordinary object
 * before it is handed back, so reading `value` off it invokes nothing either;
 * the trap can still refuse, which is what the guard is for.
 *
 * Own properties only. A payload this build wrote carries own data properties,
 * so a value reachable only through a prototype was not written by
 * `serializePreferences` and is not read back as though it had been.
 * DL-SETTINGS-09.
 *
 * @param payload Payload of unknown provenance.
 * @param key Property to read.
 * @returns The value it carries, or why it could not be read.
 */
function readOwnData(payload: object, key: string): OwnDataRead {
  let descriptor: PropertyDescriptor | undefined;

  try {
    descriptor = Object.getOwnPropertyDescriptor(payload, key);
  } catch {
    return Object.freeze({ ok: false, cause: UNREADABLE_SHAPE } as const);
  }

  if (descriptor === undefined) {
    return OWN_DATA_ABSENT;
  }

  // A DATA descriptor carries `value`; an accessor carries `get` or `set` and no
  // `value`. Refused where it stands rather than run to find out what it would
  // have said.
  if (!('value' in descriptor)) {
    return Object.freeze({ ok: false, cause: ACCESSOR_SHAPE } as const);
  }

  return Object.freeze({ ok: true, value: descriptor.value } as const);
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

  // ADDED with the channel above, so the no-op sink implements every member of
  // the contract rather than falling through the wrapper's gap-filler.
  failure(): void {
    return;
  },

  // ADDED with the scope reader above. The empty string is the "no scope is
  // knowable" answer, which a caller compares as equal to itself and therefore
  // never reads as a rotation. DL-SUMMARY-18.
  scope(): string {
    return '';
  },
});

/**
 * Wraps a reporter so no member of it can throw into its caller.
 *
 * A `log`, `count`, `error` or `failure` that throws is contained at this
 * boundary: the throw reaches neither the resolver, nor a setter, nor a
 * media-query listener, and it is not reported back through the sink that
 * produced it. A reporter that is missing a member is contained on the same
 * path.
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

    // The level-preserving failure channel, with the gap-filler for a
    // sink that implements none. The fallback reports the caught value's NAME
    // and nothing else: copying its message here would put arbitrary caught
    // text into an ordinary field, which is the leak this channel exists to
    // close. DL-SETTINGS-07.
    failure(
      level: UiReportLevel,
      message: string,
      thrown: unknown,
      fields?: UiReportFields,
    ): void {
      const report = reporter.failure;

      if (report !== undefined) {
        try {
          report.call(reporter, level, message, thrown, fields);
        } catch {
          return;
        }

        return;
      }

      try {
        reporter.log(level, message, {
          ...(fields ?? {}),
          errorName: nameThrown(thrown),
        });
      } catch {
        return;
      }
    },

    // The scope reader, forwarded through the same guard and NORMALISED.
    // A sink that implements none, one that raises, and one that answers with
    // something other than a string all read as the empty string — the one
    // answer a caller compares as equal to itself, so an unreadable scope can
    // never be mistaken for a rotated one. DL-SUMMARY-18.
    scope(): string {
      const read = reporter.scope;

      if (read === undefined) {
        return '';
      }

      let value: unknown;

      try {
        value = read.call(reporter);
      } catch {
        return '';
      }

      return typeof value === 'string' ? value : '';
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

/**
 * Schema version carried by the persisted preference envelope.
 *
 * Present from the envelope's first version, so a later shape change is
 * DETECTABLE at load instead of inferred — the gap implicit requirement I5
 * names for the board snapshot, closed here on the day this envelope is
 * minted. DL-SETTINGS-06.
 */
export const PREFERENCES_SCHEMA_VERSION = 1;

/**
 * The persisted shape. `serializePreferences` produces it and
 * `deserializePreferences` reads it; neither touches storage, so this module
 * still declares no storage key and performs no I/O — the composition root
 * owns both. DL-SETTINGS-06.
 */
export interface PreferencesPayload {
  readonly schemaVersion: number;
  readonly motionSetting: MotionSetting;
  readonly theme: ThemeId;

  /**
   * The player's number-only CHOICE, never the effective value. A session that
   * fell back to the number-only board because WebGL was unavailable must not
   * record that fallback as a preference, or a later session with a working
   * context would open in number-only mode with nothing explaining why and no
   * force to release.
   */
  readonly numberOnlyMode: boolean;
  readonly muted: boolean;
  readonly volume: number;
}

/**
 * Projects the live snapshot onto the persisted envelope.
 *
 * @param preferences Snapshot to project, as `getPreferences()` returns it.
 * @returns The frozen envelope to persist.
 */
export function serializePreferences(
  preferences: UiPreferences,
): PreferencesPayload {
  return Object.freeze({
    schemaVersion: PREFERENCES_SCHEMA_VERSION,
    motionSetting: preferences.motionSetting,
    theme: preferences.theme,

    // The CHOICE, not the effective value — see `PreferencesPayload`.
    numberOnlyMode: preferences.numberOnlyChosen,
    muted: preferences.muted,
    volume: preferences.volume,
  });
}

/**
 * Reads a persisted envelope into starting values.
 *
 * Tolerant by construction, in the manner the run-state loader is: a payload
 * of the wrong shape, one carrying a version this build cannot read, or one
 * holding a field of the wrong type yields the defaults for whatever it could
 * not read and NEVER throws. A field that survives is handed to
 * `createPreferenceStore`, which validates and clamps it a second time and
 * reports what it repairs — so this function omits rather than substitutes.
 *
 * The never-throw promise is now TOTAL, where it previously held only
 * for a payload that answered its reads. Every property is read as an own DATA
 * descriptor through `readOwnData` and the array probe goes through
 * `isArrayPayload`, so no accessor, no proxy trap and no prototype member is
 * ever invoked: a value carried by an accessor or refused by a trap is reported
 * and skipped, and an unreadable `schemaVersion` refuses the payload whole.
 * DL-SETTINGS-09.
 *
 * @param payload Parsed value read from storage, of unknown shape.
 * @param reporter Sink every rejection is reported through.
 * @returns Starting values for `createPreferenceStore`, empty where nothing
 *   could be read.
 */
export function deserializePreferences(
  payload: unknown,
  reporter: UiReporter = NOOP_UI_REPORTER,
): InitialUiPreferences {
  const sink = createSafeUiReporter(reporter);

  if (typeof payload !== 'object' || payload === null) {
    sink.log('warn', 'stored preferences were not an object; defaults used', {
      received: payload === null ? 'null' : typeof payload,
    });
    sink.count('ui.preferences.payload_rejected', { cause: 'shape' });

    return {};
  }

  // The array probe is guarded and its refusal is a rejection of its
  // own, where `Array.isArray(payload)` used to be called bare. A REVOKED proxy
  // raises from that call, so the loader that promises never to throw threw on a
  // payload it had invoked nothing on. DL-SETTINGS-09.
  const array = isArrayPayload(payload);

  if (array !== false) {
    sink.log(
      'warn',
      array === null
        ? 'stored preferences could not be read; defaults used'
        : 'stored preferences were not an object; defaults used',
      { received: array === null ? UNREADABLE_SHAPE : 'array' },
    );
    sink.count('ui.preferences.payload_rejected', {
      cause: array === null ? UNREADABLE_SHAPE : 'shape',
    });

    return {};
  }

  // Every field below is read as an own DATA descriptor, where each
  // used to be a bracket lookup — a lookup runs an accessor and a proxy `get`
  // trap, either of which carries its own throw out of this function.
  // DL-SETTINGS-09.
  const versionRead = readOwnData(payload, 'schemaVersion');

  // A payload that will not answer for its own version is refused WHOLE, for the
  // reason the unknown-version branch below is: a build this one cannot identify
  // may spell a field the same way and mean something else by it.
  if (!versionRead.ok) {
    sink.log('warn', 'stored preferences could not be read; defaults used', {
      received: versionRead.cause,
    });
    sink.count('ui.preferences.payload_rejected', {
      cause: versionRead.cause,
    });

    return {};
  }

  const version: unknown = versionRead.value;

  // An UNKNOWN version is refused whole rather than read field by field: a
  // payload written by a build this one does not know may spell a field the
  // same way and mean something else by it.
  if (version !== PREFERENCES_SCHEMA_VERSION) {
    // An unrecognised version is reported by its TYPE and never coerced to
    // text. The value comes from storage, so it is untrusted on two counts: its
    // text is content this report has no business disclosing into the log
    // buffer and every export of it, and a coercion would run BEFORE the safe
    // reporter boundary below, where an injected object with a hostile
    // `toString` or `Symbol.toPrimitive` would throw out of a loader that
    // promises never to throw. A number is kept as it is: a version number is
    // bounded, is not content, and is the one form this branch can act on.
    // DL-SETTINGS-08.
    sink.log('warn', 'stored preferences carried an unreadable version', {
      expected: PREFERENCES_SCHEMA_VERSION,
      received: typeof version === 'number' ? version : describeShape(version),
    });
    sink.count('ui.preferences.payload_rejected', { cause: 'version' });

    return {};
  }

  const initial: {
    -readonly [K in keyof InitialUiPreferences]: InitialUiPreferences[K];
  } = {};

  const reject = (preference: string, expected: string): void => {
    sink.log('warn', 'stored preference of the wrong type ignored', {
      preference,
      expected,
    });
    sink.count('ui.preferences.payload_field_rejected', { preference });
  };

  /**
   * Reads one persisted field, reporting one the payload will not answer
   * for.
   *
   * A field that cannot be read is treated as ABSENT rather than as a reason to
   * refuse the whole payload: the version has already been read and matched, so
   * the remaining fields are independent of one another and the store below
   * fills each gap with its own default. DL-SETTINGS-09.
   *
   * @param preference Field to read.
   * @returns Its value, or `undefined` where it is absent or unreadable.
   */
  const readField = (preference: string): unknown => {
    const read = readOwnData(payload, preference);

    if (read.ok) {
      return read.value;
    }

    sink.log('warn', 'stored preference that could not be read ignored', {
      preference,
      received: read.cause,
    });
    sink.count('ui.preferences.payload_field_rejected', {
      preference,
      received: read.cause,
    });

    return undefined;
  };

  const motionSetting: unknown = readField('motionSetting');

  if (motionSetting !== undefined) {
    if (isMotionSetting(motionSetting)) {
      initial.motionSetting = motionSetting;
    } else {
      reject('motionSetting', 'system, reduce or allow');
    }
  }

  const theme: unknown = readField('theme');

  if (theme !== undefined) {
    if (isThemeId(theme)) {
      initial.theme = theme;
    } else {
      reject('theme', 'a theme id');
    }
  }

  const numberOnlyMode: unknown = readField('numberOnlyMode');

  if (numberOnlyMode !== undefined) {
    if (typeof numberOnlyMode === 'boolean') {
      initial.numberOnlyMode = numberOnlyMode;
    } else {
      reject('numberOnlyMode', 'boolean');
    }
  }

  const muted: unknown = readField('muted');

  if (muted !== undefined) {
    if (typeof muted === 'boolean') {
      initial.muted = muted;
    } else {
      reject('muted', 'boolean');
    }
  }

  const volume: unknown = readField('volume');

  if (volume !== undefined) {
    // FINITE, not in-range: an out-of-range figure is handed through so the
    // store's own clamp repairs and reports it, rather than being dropped for
    // the default.
    if (typeof volume === 'number' && Number.isFinite(volume)) {
      initial.volume = volume;
    } else {
      reject('volume', 'a finite number');
    }
  }

  return Object.freeze(initial);
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
