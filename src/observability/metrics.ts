// The in-page metrics registry: counter, gauge and histogram primitives, the
// series registry, the canonical metric-name contract, the pull integration
// with the hook bus's dispatch counts, the Prometheus text exposition and the
// client-side snapshot download.
//
// This module is a pure addition. No counter, no histogram, no `performance.*`
// call and no `console.*` call existed in the retired sources: a search for
// them across all ten files of js/ matched nothing. It therefore carries no
// ported construct and no source row of its own; it is a target row alone in
// docs/TRACEABILITY_MATRIX.md.
//
// Provenance of the turn-boundary counters, which are the only members whose
// boundaries come from the retired control flow:
//   turnsTotal    js/game_manager.js L130      move() entry
//                 js/game_manager.js L91-L97   actuation push
//   mergesTotal   js/game_manager.js L156-L170 merge branch, entered once per
//                                              merge inside the traversal, so
//                                              a move resolving two merges
//                                              enters it twice
//   spawnsTotal   js/game_manager.js L69-L76   addRandomTile()
//
// Provenance of the default duration buckets, each boundary taken from a
// timing the product already holds:
//   16 ms    js/animframe_polyfill.js L13, `Math.max(0, 16 - elapsed)`
//   100 ms   style/_tokens.scss L43, `transition-speed`
//   200 ms   style/main.scss L630 `appear` and L650 `pop`
//   600 ms   style/main.scss L127 `move-up`
//   800 ms   style/main.scss L401 `fade-in`
//   1200 ms  style/main.scss L401, `$transition-speed * 12`, the fade's delay
//
// Decisions surfaced for docs/DECISION_LOG.md, which is the single source of
// truth for why each was taken:
//   1. the `DEFAULT_DURATION_BUCKETS` boundaries;
//   2. the pull-snapshot model for the hook bus's dispatch counts, over a
//      push model;
//   3. label-dimension series over name concatenation for the per-hook and
//      per-event families;
//   4. the substitution of this in-page registry, its Prometheus text export
//      and its file download for a network-served metrics endpoint.
//
// Invariants of this module. It names no package: its four imports are
// relative paths into src/, and three of the four are erased at build time.
// No exported member throws, for any input. Memory is bounded: a histogram
// holds bucket counts, a sum and a count and retains no observation, and the
// registry caps the families and the series per family it will hold. The one
// member that reaches a document is `download`, which feature-detects every
// global it uses; `performance` and the wall clock are read through guarded
// helpers, so the module is importable and usable with no DOM.

import type { EngineEventName } from '../engine/engine-events';
import { ENGINE_EVENT_NAMES } from '../engine/engine-events';
import type {
  HookBusMetrics,
  HookCounters,
  HookHandlerCounters,
  HookSkipReason,
} from '../engine/hook-bus';
import type { HookName } from '../engine/hooks';
import { HOOK_NAMES } from '../engine/hooks';
import type { LogFields, Logger } from './logger';

/* --------------------------------------------------------------------------
 * Metric primitives
 * ----------------------------------------------------------------------- */

/**
 * The label bag one series carries.
 *
 * Flat text to text. The exposition format has no nested label value, and
 * none is accepted here.
 */
export type LabelSet = Readonly<Record<string, string>>;

/** The three kinds of metric this registry holds. */
export type MetricKind = 'counter' | 'gauge' | 'histogram';

/**
 * A monotonically rising count.
 *
 * `inc` accepts a finite delta at or above zero. A negative delta, a
 * non-finite delta and a delta that is not a number are each ignored and
 * reported through the logger; none of them throws and none changes `value`.
 */
export interface Counter {
  /** Family name of the series. */
  readonly name: string;

  /** Labels that identify the series within its family. */
  readonly labels: LabelSet;

  /** The count now. */
  readonly value: number;

  /**
   * Adds to the count.
   *
   * @param delta Amount to add. Defaults to `1`.
   */
  inc(delta?: number): void;
}

/**
 * A value that rises and falls.
 *
 * `set`, `inc` and `dec` each accept a finite number; a non-finite value and
 * a value that is not a number are ignored and reported, and neither throws
 * nor changes `value`.
 */
export interface Gauge {
  /** Family name of the series. */
  readonly name: string;

  /** Labels that identify the series within its family. */
  readonly labels: LabelSet;

  /** The value now. */
  readonly value: number;

  /**
   * Replaces the value.
   *
   * @param value Value to hold.
   */
  set(value: number): void;

  /**
   * Adds to the value.
   *
   * @param delta Amount to add. Defaults to `1`.
   */
  inc(delta?: number): void;

  /**
   * Subtracts from the value.
   *
   * @param delta Amount to subtract. Defaults to `1`.
   */
  dec(delta?: number): void;
}

/**
 * A bucketed distribution.
 *
 * An observation is counted into the first bucket whose upper bound it does
 * not exceed, and into the overflow slot when it exceeds every bound. The
 * observation itself is not retained, so a histogram's footprint is fixed by
 * its bucket count and does not grow with the number of observations.
 *
 * `observe` accepts a finite number; a non-finite value and a value that is
 * not a number are ignored and reported, and neither throws nor changes any
 * member.
 */
export interface Histogram {
  /** Family name of the series. */
  readonly name: string;

  /** Labels that identify the series within its family. */
  readonly labels: LabelSet;

  /** Observations recorded. */
  readonly count: number;

  /** Sum of the observations recorded. */
  readonly sum: number;

  /** The inclusive upper bounds, ascending. */
  readonly buckets: readonly number[];

  /**
   * CUMULATIVE counts aligned to `buckets`: element `i` counts every
   * observation at or below `buckets[i]`. Built fresh on each read. The
   * overflow slot is not an element here; it equals `count`.
   */
  readonly bucketCounts: readonly number[];

  /**
   * Records one observation.
   *
   * @param value Value to record.
   */
  observe(value: number): void;

  /**
   * Estimates a quantile from the bucket counts.
   *
   * BUCKET-APPROXIMATED, not exact. The observations are not retained; the
   * result is interpolated linearly within the bucket the rank falls in, and
   * its accuracy is bounded by the bucket widths. A rank that falls in the
   * overflow slot resolves to the highest bound.
   *
   * @param q Quantile to estimate, from 0 to 1 inclusive.
   * @returns The estimate, or `NaN` when nothing has been observed or `q` is
   *   outside [0, 1].
   */
  quantile(q: number): number;
}

/* --------------------------------------------------------------------------
 * Default bucket layout
 * ----------------------------------------------------------------------- */

/**
 * Inclusive upper bounds, in milliseconds, of the duration histograms.
 *
 * Ascending and deduplicated. Boundaries below 16 give sub-frame resolution,
 * 16 is the frame budget, 32 and 64 are two and four budgets, and the rest
 * are the animation timings the product already holds, out past the 1200 ms
 * overlay delay. Each is cited in this file's header.
 *
 * Decision surfaced for docs/DECISION_LOG.md.
 */
export const DEFAULT_DURATION_BUCKETS: readonly number[] = Object.freeze([
  1, 2, 4, 8, 16, 32, 64, 100, 200, 400, 600, 800, 1200, 2000,
]);

/* --------------------------------------------------------------------------
 * Name grammar
 * ----------------------------------------------------------------------- */

/** Metric names the exposition format accepts. */
const METRIC_NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

/** Label names the exposition format accepts. */
const LABEL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Prefix the exposition format reserves for its own label names. */
const RESERVED_LABEL_PREFIX = '__';

/** Label name a histogram family reserves for its bucket bounds. */
const BUCKET_LABEL = 'le';

/** Suffix the cumulative bucket series of a histogram family carries. */
const BUCKET_SUFFIX = '_bucket';

/** Suffix the sum series of a histogram family carries. */
const SUM_SUFFIX = '_sum';

/** Suffix the count series of a histogram family carries. */
const COUNT_SUFFIX = '_count';

/** Bound the overflow bucket is labelled with. */
const POSITIVE_INFINITY_LABEL = '+Inf';

/**
 * Tests a metric family name against the exposition format's grammar.
 *
 * @param name Name to test.
 * @returns `true` when the name is usable as a metric name.
 */
export function isValidMetricName(name: string): boolean {
  return typeof name === 'string' && METRIC_NAME_PATTERN.test(name);
}

/**
 * Tests a label name against the exposition format's grammar. The reserved
 * `__` prefix is rejected.
 *
 * @param name Name to test.
 * @returns `true` when the name is usable as a label name.
 */
export function isValidLabelName(name: string): boolean {
  return (
    typeof name === 'string' &&
    LABEL_NAME_PATTERN.test(name) &&
    !name.startsWith(RESERVED_LABEL_PREFIX)
  );
}

/* --------------------------------------------------------------------------
 * Canonical names
 * ----------------------------------------------------------------------- */

/** Prefix every canonical metric name carries. */
export const METRIC_PREFIX = 'game2048_';

/**
 * Every canonical metric family name.
 *
 * Frozen, and the single declaration of each name: no other module writes
 * one of its own. Counters carry `_total` and duration histograms carry
 * `_milliseconds`.
 */
export const METRIC_NAMES = Object.freeze({
  /** Turns resolved. Boundary: js/game_manager.js L130 to L91-L97. */
  turnsTotal: `${METRIC_PREFIX}turns_total`,

  /** Merges resolved. Boundary: js/game_manager.js L156-L170. */
  mergesTotal: `${METRIC_PREFIX}merges_total`,

  /** Tiles spawned. Boundary: js/game_manager.js L69-L76. */
  spawnsTotal: `${METRIC_PREFIX}spawns_total`,

  /** Engine events emitted, one series per `ENGINE_EVENT_NAMES` member. */
  engineEventsTotal: `${METRIC_PREFIX}engine_events_total`,

  /** Hook dispatches, one series per `HOOK_NAMES` member. */
  hookDispatchesTotal: `${METRIC_PREFIX}hook_dispatches_total`,

  /** Hook handler invocations, one series per `HOOK_NAMES` member. */
  hookHandlerInvocationsTotal:
    `${METRIC_PREFIX}hook_handler_invocations_total`,

  /** Hook handlers the bus skipped, by hook and by skip reason. */
  hookHandlerSkippedTotal: `${METRIC_PREFIX}hook_handler_skipped_total`,

  /** Handler returns the bus discarded as non-payloads, by hook. */
  hookPayloadRejectionsTotal:
    `${METRIC_PREFIX}hook_payload_rejections_total`,

  /** Relic handler throws the bus isolated, by hook. */
  relicHandlerErrorsTotal: `${METRIC_PREFIX}relic_handler_errors_total`,

  /** Frames the render loop composited. */
  framesRenderedTotal: `${METRIC_PREFIX}frames_rendered_total`,

  /** Draws consumed, one series per named RNG substream. */
  rngDrawsTotal: `${METRIC_PREFIX}rng_draws_total`,

  /** Calls this registry rejected and reported. */
  metricsRejectedTotal: `${METRIC_PREFIX}metrics_rejected_total`,

  /** Result of one health check: 1 healthy, 0 unhealthy. */
  healthCheckStatus: `${METRIC_PREFIX}health_check_status`,

  /** Frame durations. */
  frameTimeMilliseconds: `${METRIC_PREFIX}frame_time_milliseconds`,

  /** Turn latencies, input dispatch through commit. */
  turnLatencyMilliseconds: `${METRIC_PREFIX}turn_latency_milliseconds`,

  /** Span durations, one series per span name. */
  spanDurationMilliseconds: `${METRIC_PREFIX}span_duration_milliseconds`,
} as const);

/**
 * Every canonical label name.
 *
 * Frozen. The per-hook, per-event, per-reason, per-stream, per-check and
 * per-span families are label dimensions on one family each, not
 * concatenated names.
 *
 * Decision surfaced for docs/DECISION_LOG.md.
 */
export const METRIC_LABELS = Object.freeze({
  /** Carries a member of `HOOK_NAMES`. */
  hook: 'hook',

  /** Carries a member of `ENGINE_EVENT_NAMES`. */
  event: 'event',

  /** Carries a `HookSkipReason`. */
  reason: 'reason',

  /** Carries a named RNG substream. */
  stream: 'stream',

  /** Carries a health check name. */
  check: 'check',

  /** Carries a trace span name. */
  span: 'span',
} as const);

/**
 * Help text of each canonical family, as the `# HELP` line reports it.
 *
 * Keyed by the same keys as `METRIC_NAMES`; a name added there without a
 * help text here does not compile.
 */
const METRIC_HELP: Readonly<Record<keyof typeof METRIC_NAMES, string>> =
  Object.freeze({
    turnsTotal: 'Turns resolved, one per move:after emission.',
    mergesTotal: 'Tile merges resolved, one per tile:merge emission.',
    spawnsTotal: 'Tiles spawned, one per tile:spawn emission.',
    engineEventsTotal: 'Engine events emitted, by event name.',
    hookDispatchesTotal: 'Hook dispatches, by hook name.',
    hookHandlerInvocationsTotal:
      'Hook handlers invoked, by hook name.',
    hookHandlerSkippedTotal:
      'Hook handlers skipped before invocation, by hook and reason.',
    hookPayloadRejectionsTotal:
      'Handler returns discarded as non-payloads, by hook name.',
    relicHandlerErrorsTotal:
      'Relic handler throws contained by the hook bus, by hook name.',
    framesRenderedTotal: 'Frames composited by the render loop.',
    rngDrawsTotal: 'Draws consumed, by named RNG substream.',
    metricsRejectedTotal:
      'Metric calls this registry rejected and reported.',
    healthCheckStatus: 'Health check result: 1 healthy, 0 unhealthy.',
    frameTimeMilliseconds: 'Frame duration in milliseconds.',
    turnLatencyMilliseconds:
      'Turn latency in milliseconds, input dispatch through commit.',
    spanDurationMilliseconds:
      'Span duration in milliseconds, by span name.',
  });

/**
 * Kind of each canonical family, keyed as `METRIC_NAMES` is.
 */
const METRIC_KINDS: Readonly<Record<keyof typeof METRIC_NAMES, MetricKind>> =
  Object.freeze({
    turnsTotal: 'counter',
    mergesTotal: 'counter',
    spawnsTotal: 'counter',
    engineEventsTotal: 'counter',
    hookDispatchesTotal: 'counter',
    hookHandlerInvocationsTotal: 'counter',
    hookHandlerSkippedTotal: 'counter',
    hookPayloadRejectionsTotal: 'counter',
    relicHandlerErrorsTotal: 'counter',
    framesRenderedTotal: 'counter',
    rngDrawsTotal: 'counter',
    metricsRejectedTotal: 'counter',
    healthCheckStatus: 'gauge',
    frameTimeMilliseconds: 'histogram',
    turnLatencyMilliseconds: 'histogram',
    spanDurationMilliseconds: 'histogram',
  });

/* --------------------------------------------------------------------------
 * Hook-bus view
 * ----------------------------------------------------------------------- */

/**
 * The slice of `HookBusMetrics` this module reads.
 *
 * Derived from that type by `Pick`, and optional. The member name is
 * written once, here. A `HookBusMetrics` value satisfies it as it stands;
 * a fabricated or partial value is validated at runtime.
 */
export type HookDispatchCountsView = Partial<Pick<HookBusMetrics, 'hooks'>>;

/** Every skip reason, exhaustive over `HookSkipReason` by construction. */
const HOOK_SKIP_REASONS: Readonly<Record<HookSkipReason, HookSkipReason>> =
  Object.freeze({
    exhausted: 'exhausted',
    degraded: 'degraded',
    detached: 'detached',
  });

/**
 * The `HookHandlerCounters` member each skip reason is counted in.
 *
 * Keyed by `HookSkipReason` and valued by `keyof HookHandlerCounters`. A
 * reason added to that union, or a member renamed in it, breaks compilation
 * here.
 */
const SKIP_REASON_MEMBER: Readonly<
  Record<HookSkipReason, keyof HookHandlerCounters>
> = Object.freeze({
  exhausted: 'skippedExhausted',
  degraded: 'skippedDegraded',
  detached: 'skippedDetached',
});

/** `HookCounters` member the per-hook dispatch counter reads. */
const DISPATCHED_MEMBER: keyof HookCounters = 'dispatched';

/** `HookHandlerCounters` member the per-hook invocation counter reads. */
const INVOKED_MEMBER: keyof HookHandlerCounters = 'invoked';

/** `HookHandlerCounters` member the per-hook error counter reads. */
const FAILED_MEMBER: keyof HookHandlerCounters = 'failed';

/** `HookHandlerCounters` member the per-hook rejection counter reads. */
const REJECTED_MEMBER: keyof HookHandlerCounters = 'rejected';

/* --------------------------------------------------------------------------
 * Snapshot contract
 * ----------------------------------------------------------------------- */

/** Version the snapshot envelope carries. */
export const METRICS_SNAPSHOT_SCHEMA_VERSION = 1;

/** Members every series snapshot carries, whatever its kind. */
interface SeriesSnapshotBase {
  /** Family name. */
  readonly name: string;

  /** Help text of the family. */
  readonly help: string;

  /** Labels that identify the series within its family. */
  readonly labels: LabelSet;
}

/** One counter series. */
export interface CounterSeriesSnapshot extends SeriesSnapshotBase {
  /** Discriminant. */
  readonly kind: 'counter';

  /** The count. */
  readonly value: number;
}

/** One gauge series. */
export interface GaugeSeriesSnapshot extends SeriesSnapshotBase {
  /** Discriminant. */
  readonly kind: 'gauge';

  /** The value. */
  readonly value: number;
}

/** One histogram series. */
export interface HistogramSeriesSnapshot extends SeriesSnapshotBase {
  /** Discriminant. */
  readonly kind: 'histogram';

  /** Observations recorded. */
  readonly count: number;

  /** Sum of the observations recorded. */
  readonly sum: number;

  /** The inclusive upper bounds, ascending. */
  readonly buckets: readonly number[];

  /** CUMULATIVE counts aligned to `buckets`. */
  readonly bucketCounts: readonly number[];

  /** The overflow bucket, equal to `count`. */
  readonly infCount: number;
}

/** One series, discriminated by `kind`. */
export type MetricSeriesSnapshot =
  | CounterSeriesSnapshot
  | GaugeSeriesSnapshot
  | HistogramSeriesSnapshot;

/**
 * The registry's whole state, as `snapshot()` reports it.
 *
 * Plain JSON data throughout: the object round-trips through
 * `JSON.parse(JSON.stringify(snapshot))` unchanged, which is what
 * docs/dashboards/dashboard.html consumes so it need not parse the text form.
 * Every series in it also appears in `toPrometheusText()`, and no series
 * appears in one and not the other.
 */
export interface MetricsSnapshot {
  /** `METRICS_SNAPSHOT_SCHEMA_VERSION` at the time of the export. */
  readonly schemaVersion: number;

  /**
   * Correlation identifier of the run, taken from the injected logger. Empty
   * when the registry was built without one.
   */
  readonly correlationId: string;

  /** Wall-clock time of the export, ISO 8601. Empty when unreadable. */
  readonly generatedAt: string;

  /**
   * Monotonic reading of `performance.now()` at the export, in milliseconds.
   * `0` when no such clock is available.
   */
  readonly elapsedMs: number;

  /** Calls this registry rejected and reported over its lifetime. */
  readonly rejected: number;

  /** Logger calls that threw and were contained over that lifetime. */
  readonly reporterFaults: number;

  /** Every series, family by family in registration order. */
  readonly series: readonly MetricSeriesSnapshot[];
}

/* --------------------------------------------------------------------------
 * Construction parameters
 * ----------------------------------------------------------------------- */

/** Families the registry will hold before it rejects a new one. */
const MAX_FAMILIES = 128;

/** Series one family will hold before it rejects a new one. */
const MAX_SERIES_PER_FAMILY = 256;

/** Buckets one histogram family will accept. */
const MAX_BUCKETS = 64;

/** Subsystem tag the registry's logger is tagged with. */
const LOGGER_SUBSYSTEM = 'metrics';

/** Filename `download` uses when the caller supplies none. */
export const DEFAULT_METRICS_FILENAME = 'game2048-metrics.prom';

/** Extension that selects the JSON snapshot over the Prometheus text. */
const JSON_EXTENSION = '.json';

/** Media type of the Prometheus text download. */
const TEXT_MEDIA_TYPE = 'text/plain;charset=utf-8';

/** Media type of the JSON snapshot download. */
const JSON_MEDIA_TYPE = 'application/json;charset=utf-8';

/** Settings `MetricsRegistry` accepts. */
export interface MetricsRegistryOptions {
  /**
   * Logger every rejection is reported through, and the source of the
   * correlation identifier the snapshot carries. The registry tags a child of
   * it with `'metrics'`. Omitted, nothing is reported and the correlation
   * identifier is empty.
   */
  readonly logger?: Logger;

  /**
   * Bounds of the frame-duration histogram. Defaults to
   * `DEFAULT_DURATION_BUCKETS`. Supplied by the composition root so the
   * render loop's own bounds drive the family without this module importing
   * that module.
   */
  readonly frameTimeBuckets?: readonly number[];

  /** Bounds of the turn-latency histogram. */
  readonly turnLatencyBuckets?: readonly number[];

  /** Bounds of the span-duration histogram. */
  readonly spanDurationBuckets?: readonly number[];
}

/* --------------------------------------------------------------------------
 * Guarded platform access
 * ----------------------------------------------------------------------- */

/**
 * Reads `performance.now()` without throwing.
 *
 * @returns The reading in milliseconds, or `0` when no usable clock is
 *   present.
 */
function readElapsedMs(): number {
  try {
    const clock: unknown = globalThis.performance;

    if (typeof clock !== 'object' || clock === null) {
      return 0;
    }

    const now: unknown = (clock as { now?: unknown }).now;

    if (typeof now !== 'function') {
      return 0;
    }

    const reading: unknown = (now as () => unknown).call(clock);

    return typeof reading === 'number' && Number.isFinite(reading)
      ? reading
      : 0;
  } catch {
    return 0;
  }
}

/**
 * Reads the wall clock without throwing.
 *
 * @returns The time as ISO 8601, or the empty string when unreadable.
 */
function readTimestamp(): string {
  try {
    return new Date().toISOString();
  } catch {
    return '';
  }
}

/* --------------------------------------------------------------------------
 * Value guards
 * ----------------------------------------------------------------------- */

/**
 * Narrows an arbitrary value to a finite number.
 *
 * @param value Value to test.
 * @returns `true` when `value` is a number that is neither `NaN` nor an
 *   infinity.
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Normalises a bucket-bound list: finite bounds only, ascending, with
 * duplicates removed and the length capped.
 *
 * @param bounds Bounds to normalise.
 * @returns A frozen array. Falls back to `DEFAULT_DURATION_BUCKETS` when the
 *   input yields no usable bound.
 */
function normaliseBuckets(bounds: readonly number[] | undefined): number[] {
  if (!Array.isArray(bounds)) {
    return [...DEFAULT_DURATION_BUCKETS];
  }

  const unique: number[] = [];

  for (const bound of bounds) {
    if (isFiniteNumber(bound) && !unique.includes(bound)) {
      unique.push(bound);
    }
  }

  if (unique.length === 0) {
    return [...DEFAULT_DURATION_BUCKETS];
  }

  unique.sort((left, right) => left - right);

  return unique.slice(0, MAX_BUCKETS);
}

/**
 * Compares two bound lists element by element.
 *
 * @param left First list.
 * @param right Second list.
 * @returns `true` when both hold the same bounds in the same order.
 */
function sameBounds(
  left: readonly number[],
  right: readonly number[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

/**
 * Builds the key that identifies one series within its family.
 *
 * Label names are sorted, so `{a: '1', b: '2'}` and `{b: '2', a: '1'}` yield
 * one key and therefore resolve to one series.
 *
 * @param labels Labels to key.
 * @returns The key, `'[]'` for an empty label set.
 */
function buildSeriesKey(labels: LabelSet): string {
  const names = Object.keys(labels).sort();
  const pairs: [string, string][] = [];

  for (const name of names) {
    pairs.push([name, labels[name] ?? '']);
  }

  return JSON.stringify(pairs);
}

/* --------------------------------------------------------------------------
 * Exposition escaping
 * ----------------------------------------------------------------------- */

/**
 * Escapes a label value for the exposition format: backslash, double quote
 * and newline take their defined escapes, and any remaining control character
 * becomes a space. No emitted line carries a raw control character.
 *
 * @param value Value to escape.
 * @returns The escaped value.
 */
function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/[\u0000-\u001f\u007f]/g, ' ');
}

/**
 * Escapes help text for the exposition format. A double quote needs no escape
 * on a `# HELP` line and is left as it stands.
 *
 * @param help Text to escape.
 * @returns The escaped text.
 */
function escapeHelp(help: string): string {
  return help
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/[\u0000-\u001f\u007f]/g, ' ');
}

/**
 * Renders a number as the exposition format writes it.
 *
 * @param value Number to render.
 * @returns The rendering, using the format's `NaN`, `+Inf` and `-Inf`
 *   spellings for the three non-finite values.
 */
function formatMetricValue(value: number): string {
  if (Number.isNaN(value)) {
    return 'NaN';
  }

  if (value === Number.POSITIVE_INFINITY) {
    return POSITIVE_INFINITY_LABEL;
  }

  if (value === Number.NEGATIVE_INFINITY) {
    return '-Inf';
  }

  return String(value);
}

/**
 * Renders a label set as the exposition format's brace list, with an optional
 * trailing pair appended after the sorted labels.
 *
 * @param labels Labels to render, emitted in sorted name order.
 * @param extraName Name of the trailing pair, omitted when absent.
 * @param extraValue Value of the trailing pair.
 * @returns The brace list, or the empty string when there is nothing to
 *   render.
 */
function formatLabels(
  labels: LabelSet,
  extraName?: string,
  extraValue?: string,
): string {
  const parts: string[] = [];

  for (const name of Object.keys(labels).sort()) {
    parts.push(`${name}="${escapeLabelValue(labels[name] ?? '')}"`);
  }

  if (extraName !== undefined) {
    parts.push(`${extraName}="${escapeLabelValue(extraValue ?? '')}"`);
  }

  return parts.length === 0 ? '' : `{${parts.join(',')}}`;
}

/* --------------------------------------------------------------------------
 * Series implementation
 * ----------------------------------------------------------------------- */

/** How a series reports a rejected call. */
type SeriesReporter = (message: string, fields: LogFields) => void;

/** A reporter that does nothing, held by a detached series. */
const NOOP_SERIES_REPORTER: SeriesReporter = () => undefined;

/**
 * Tags a child of the supplied logger, containing a throw from a logger
 * double that does not honour the module's no-throw contract.
 *
 * @param logger Logger to tag, or `undefined`.
 * @returns The tagged child, the logger itself when tagging failed, or
 *   `undefined` when none was supplied.
 */
function tagLogger(logger: Logger | undefined): Logger | undefined {
  if (logger === undefined) {
    return undefined;
  }

  try {
    const child = logger.child(LOGGER_SUBSYSTEM);

    return typeof child === 'object' && child !== null ? child : logger;
  } catch {
    return logger;
  }
}

/**
 * Reads a logger's correlation identifier, containing a throwing accessor.
 *
 * @param logger Logger to read, or `undefined`.
 * @returns The identifier, or the empty string when it cannot be read.
 */
function readCorrelationId(logger: Logger | undefined): string {
  if (logger === undefined) {
    return '';
  }

  try {
    const id: unknown = logger.correlationId;

    return typeof id === 'string' ? id : '';
  } catch {
    return '';
  }
}

/**
 * Reads one numeric member off a value of unknown shape.
 *
 * @param source Value to read from.
 * @param member Member to read.
 * @returns The value when it is a finite number at or above zero, otherwise
 *   `null`.
 */
function readCount(source: unknown, member: string): number | null {
  if (typeof source !== 'object' || source === null) {
    return null;
  }

  const value: unknown = (source as Record<string, unknown>)[member];

  return isFiniteNumber(value) && value >= 0 ? value : null;
}

/**
 * One series.
 *
 * Implements all three primitive contracts behind one recorded kind, so a
 * family requested under a second kind can hand back the instance it already
 * holds with no cast. A mutation that does not belong to the recorded kind is
 * reported and ignored: `set` and `dec` on a counter, `inc` on a histogram,
 * and `observe` on anything but a histogram.
 *
 * A detached instance — one this registry rejected and therefore never
 * stored — accepts every mutation silently and is exported by nothing.
 */
class MetricSeries implements Counter, Gauge, Histogram {
  /** Family name. */
  readonly name: string;

  /** Labels that identify the series within its family. */
  readonly labels: LabelSet;

  /** The kind the family was registered under. */
  readonly kind: MetricKind;

  /** Inclusive upper bounds, ascending. Empty for a non-histogram. */
  readonly buckets: readonly number[];

  /** Whether the registry declined to store this instance. */
  readonly detached: boolean;

  /** Sink for a rejected call. */
  private readonly report: SeriesReporter;

  /** Counter and gauge accumulator. */
  private scalar = 0;

  /** Observations recorded. */
  private observations = 0;

  /** Sum of the observations recorded. */
  private total = 0;

  /**
   * Per-bucket counts, NOT cumulative. Length is `buckets.length + 1`; the
   * final element is the overflow slot for an observation above every bound.
   */
  private readonly counts: number[];

  /**
   * @param name Family name.
   * @param labels Labels of the series.
   * @param kind Kind the family was registered under.
   * @param buckets Bounds, used only by a histogram.
   * @param report Sink for a rejected call.
   * @param detached Whether the registry declined to store the instance.
   */
  constructor(
    name: string,
    labels: LabelSet,
    kind: MetricKind,
    buckets: readonly number[],
    report: SeriesReporter,
    detached = false,
  ) {
    this.name = name;
    this.labels = labels;
    this.kind = kind;
    this.buckets = kind === 'histogram' ? buckets : [];
    this.report = report;
    this.detached = detached;
    this.counts = new Array<number>(this.buckets.length + 1).fill(0);
  }

  /** The scalar for a counter or a gauge, the count for a histogram. */
  get value(): number {
    return this.kind === 'histogram' ? this.observations : this.scalar;
  }

  /** Observations recorded. */
  get count(): number {
    return this.observations;
  }

  /** Sum of the observations recorded. */
  get sum(): number {
    return this.total;
  }

  /** CUMULATIVE counts aligned to `buckets`, built fresh on each read. */
  get bucketCounts(): readonly number[] {
    const cumulative: number[] = [];
    let running = 0;

    for (let index = 0; index < this.buckets.length; index += 1) {
      running += this.counts[index] ?? 0;
      cumulative.push(running);
    }

    return cumulative;
  }

  /**
   * Adds to a counter or a gauge.
   *
   * @param delta Amount to add, defaulting to `1`. A counter rejects a
   *   negative delta; a gauge accepts one.
   */
  inc(delta: number = 1): void {
    if (this.detached) {
      return;
    }

    if (this.kind === 'histogram') {
      this.reject('inc', { kind: this.kind });

      return;
    }

    if (!isFiniteNumber(delta)) {
      this.reject('inc', { reason: 'notFinite' });

      return;
    }

    if (this.kind === 'counter' && delta < 0) {
      this.reject('inc', { reason: 'negativeDelta', delta });

      return;
    }

    this.scalar += delta;
  }

  /**
   * Subtracts from a gauge.
   *
   * @param delta Amount to subtract, defaulting to `1`.
   */
  dec(delta: number = 1): void {
    if (this.detached) {
      return;
    }

    if (this.kind !== 'gauge') {
      this.reject('dec', { kind: this.kind });

      return;
    }

    if (!isFiniteNumber(delta)) {
      this.reject('dec', { reason: 'notFinite' });

      return;
    }

    this.scalar -= delta;
  }

  /**
   * Replaces a gauge's value.
   *
   * @param value Value to hold.
   */
  set(value: number): void {
    if (this.detached) {
      return;
    }

    if (this.kind !== 'gauge') {
      this.reject('set', { kind: this.kind });

      return;
    }

    if (!isFiniteNumber(value)) {
      this.reject('set', { reason: 'notFinite' });

      return;
    }

    this.scalar = value;
  }

  /**
   * Records one observation into the first bucket whose bound it does not
   * exceed, or into the overflow slot.
   *
   * @param value Value to record.
   */
  observe(value: number): void {
    if (this.detached) {
      return;
    }

    if (this.kind !== 'histogram') {
      this.reject('observe', { kind: this.kind });

      return;
    }

    if (!isFiniteNumber(value)) {
      this.reject('observe', { reason: 'notFinite' });

      return;
    }

    this.observations += 1;
    this.total += value;

    const slot = this.resolveSlot(value);

    this.counts[slot] = (this.counts[slot] ?? 0) + 1;
  }

  /**
   * Estimates a quantile by linear interpolation inside the bucket the rank
   * falls in.
   *
   * @param q Quantile from 0 to 1 inclusive.
   * @returns The estimate, or `NaN` when it is undefined.
   */
  quantile(q: number): number {
    if (this.kind !== 'histogram' || this.observations === 0) {
      return Number.NaN;
    }

    if (!isFiniteNumber(q) || q < 0 || q > 1) {
      if (!this.detached) {
        this.reject('quantile', { reason: 'outOfRange' });
      }

      return Number.NaN;
    }

    const rank = q * this.observations;
    let lowerBound = 0;
    let cumulativeBelow = 0;

    for (let index = 0; index < this.buckets.length; index += 1) {
      const inBucket = this.counts[index] ?? 0;
      const cumulative = cumulativeBelow + inBucket;
      const upperBound = this.buckets[index] ?? lowerBound;

      if (cumulative >= rank) {
        if (inBucket === 0) {
          return upperBound;
        }

        const share = (rank - cumulativeBelow) / inBucket;

        return lowerBound + (upperBound - lowerBound) * share;
      }

      cumulativeBelow = cumulative;
      lowerBound = upperBound;
    }

    return this.buckets[this.buckets.length - 1] ?? Number.NaN;
  }

  /** Zeroes every value. The kind, labels and bounds are unchanged. */
  reset(): void {
    this.scalar = 0;
    this.observations = 0;
    this.total = 0;
    this.counts.fill(0);
  }

  /**
   * Adds to the accumulator without the public guards, for the registry's own
   * bookkeeping.
   *
   * @param delta Amount to add. A non-finite or negative delta adds nothing.
   */
  addInternal(delta: number): void {
    if (this.detached || this.kind === 'histogram') {
      return;
    }

    if (!isFiniteNumber(delta) || delta < 0) {
      return;
    }

    this.scalar += delta;
  }

  /**
   * Projects the series as plain JSON data.
   *
   * @param help Help text of the family.
   * @returns The snapshot, discriminated by the recorded kind.
   */
  toSnapshot(help: string): MetricSeriesSnapshot {
    if (this.kind === 'histogram') {
      const histogram: HistogramSeriesSnapshot = {
        kind: 'histogram',
        name: this.name,
        help,
        labels: this.labels,
        count: this.observations,
        sum: this.total,
        buckets: Object.freeze([...this.buckets]),
        bucketCounts: Object.freeze([...this.bucketCounts]),
        infCount: this.observations,
      };

      return Object.freeze(histogram);
    }

    if (this.kind === 'gauge') {
      const gauge: GaugeSeriesSnapshot = {
        kind: 'gauge',
        name: this.name,
        help,
        labels: this.labels,
        value: this.scalar,
      };

      return Object.freeze(gauge);
    }

    const counter: CounterSeriesSnapshot = {
      kind: 'counter',
      name: this.name,
      help,
      labels: this.labels,
      value: this.scalar,
    };

    return Object.freeze(counter);
  }

  /**
   * Resolves the slot an observation is counted in.
   *
   * @param value Observation to place.
   * @returns The index into `counts`, `buckets.length` for the overflow slot.
   */
  private resolveSlot(value: number): number {
    let low = 0;
    let high = this.buckets.length;

    while (low < high) {
      const middle = (low + high) >>> 1;
      const bound = this.buckets[middle];

      if (bound !== undefined && value <= bound) {
        high = middle;
      } else {
        low = middle + 1;
      }
    }

    return low;
  }

  /**
   * Reports a rejected call.
   *
   * @param operation Member the call was made through.
   * @param fields Structured fields describing the rejection.
   */
  private reject(operation: string, fields: LogFields): void {
    this.report('metric call rejected', {
      ...fields,
      metric: this.name,
      operation,
    });
  }
}

/* --------------------------------------------------------------------------
 * Family
 * ----------------------------------------------------------------------- */

/** One metric family: the unit `# HELP` and `# TYPE` are emitted for. */
interface MetricFamily {
  /** Family name. */
  readonly name: string;

  /** Kind the family was first registered under. */
  readonly kind: MetricKind;

  /** Bucket bounds shared by every series of a histogram family. */
  readonly buckets: readonly number[];

  /** Help text, empty until `describe` supplies one. */
  help: string;

  /** The family's series, keyed by `buildSeriesKey`. */
  readonly series: Map<string, MetricSeries>;
}

/* --------------------------------------------------------------------------
 * Registry
 * ----------------------------------------------------------------------- */

/**
 * The in-page metrics registry.
 *
 * Holds every series and exports them three ways: `snapshot()` as JSON,
 * `toPrometheusText()` as text exposition, and `download()` as a file. Those
 * three members are what stands in for a network-served metrics endpoint here.
 * The substitution carries its own entry in docs/DECISION_LOG.md.
 *
 * Every member is safe to call from inside an engine-event listener: none of
 * them throws for any input, and a rejected call is reported through the
 * injected logger, counted, and otherwise ignored.
 */
export class MetricsRegistry {
  /** Correlation identifier of the run, taken from the injected logger. */
  readonly correlationId: string;

  /** The families, in registration order. */
  private readonly families = new Map<string, MetricFamily>();

  /**
   * Absolute values the last fold read, keyed per series, so a repeated fold
   * of the same snapshot adds nothing.
   */
  private readonly foldedAbsolutes = new Map<string, number>();

  /** Per-event emission counters, keyed by event name. */
  private readonly eventCounters = new Map<string, MetricSeries>();

  /** Per-hook dispatch counters, keyed by hook name. */
  private readonly hookDispatchCounters = new Map<string, MetricSeries>();

  /** Per-hook handler-invocation counters, keyed by hook name. */
  private readonly hookInvocationCounters = new Map<string, MetricSeries>();

  /** Per-hook contained-throw counters, keyed by hook name. */
  private readonly hookErrorCounters = new Map<string, MetricSeries>();

  /** Per-hook payload-rejection counters, keyed by hook name. */
  private readonly hookRejectionCounters = new Map<string, MetricSeries>();

  /** Per-hook skip counters, keyed by `hook + '|' + reason`. */
  private readonly hookSkipCounters = new Map<string, MetricSeries>();

  /** Calls rejected over the registry's lifetime. */
  private rejectedCalls = 0;

  /** Logger calls that threw and were contained. */
  private reporterFaults = 0;

  /** Sink every rejection is reported and counted through. */
  private readonly reportRejection: SeriesReporter = (message, fields) => {
    this.rejectedCalls += 1;

    const counter = this.rejectedCounter;

    if (counter !== undefined) {
      counter.addInternal(1);
    }

    const logger = this.logger;

    if (logger === undefined) {
      return;
    }

    try {
      logger.warn(message, fields);
    } catch {
      this.reporterFaults += 1;
    }
  };

  /** The tagged logger, absent when none was supplied. */
  private readonly logger: Logger | undefined;

  /** Cached series for the counter every rejection is counted in. */
  private readonly rejectedCounter: MetricSeries;

  /** Cached series for the resolved-turn counter. */
  private readonly turnsCounter: MetricSeries;

  /** Cached series for the resolved-merge counter. */
  private readonly mergesCounter: MetricSeries;

  /** Cached series for the tile-spawn counter. */
  private readonly spawnsCounter: MetricSeries;

  /** Cached series for the composited-frame counter. */
  private readonly framesCounter: MetricSeries;

  /** Cached series for the frame-duration histogram. */
  private readonly frameTimeHistogram: MetricSeries;

  /** Cached series for the turn-latency histogram. */
  private readonly turnLatencyHistogram: MetricSeries;

  /**
   * @param options Logger and the three histogram bucket layouts. Every
   *   member is optional, so the registry is constructible with no argument.
   */
  constructor(options: MetricsRegistryOptions = {}) {
    this.logger = tagLogger(options.logger);
    this.correlationId = readCorrelationId(this.logger);

    // Registered first. Rejections raised by the registrations below are
    // counted in it.
    this.rejectedCounter = this.declareSeries('metricsRejectedTotal', {});

    this.turnsCounter = this.declareSeries('turnsTotal', {});
    this.mergesCounter = this.declareSeries('mergesTotal', {});
    this.spawnsCounter = this.declareSeries('spawnsTotal', {});
    this.framesCounter = this.declareSeries('framesRenderedTotal', {});

    for (const event of ENGINE_EVENT_NAMES) {
      this.eventCounters.set(
        event,
        this.declareSeries('engineEventsTotal', {
          [METRIC_LABELS.event]: event,
        }),
      );
    }

    for (const hook of HOOK_NAMES) {
      const labels: LabelSet = { [METRIC_LABELS.hook]: hook };

      this.hookDispatchCounters.set(
        hook,
        this.declareSeries('hookDispatchesTotal', labels),
      );
      this.hookInvocationCounters.set(
        hook,
        this.declareSeries('hookHandlerInvocationsTotal', labels),
      );
      this.hookErrorCounters.set(
        hook,
        this.declareSeries('relicHandlerErrorsTotal', labels),
      );
      this.hookRejectionCounters.set(
        hook,
        this.declareSeries('hookPayloadRejectionsTotal', labels),
      );

      for (const reason of Object.values(HOOK_SKIP_REASONS)) {
        this.hookSkipCounters.set(
          `${hook}|${reason}`,
          this.declareSeries('hookHandlerSkippedTotal', {
            [METRIC_LABELS.hook]: hook,
            [METRIC_LABELS.reason]: reason,
          }),
        );
      }
    }

    this.frameTimeHistogram = this.declareSeries(
      'frameTimeMilliseconds',
      {},
      options.frameTimeBuckets,
    );
    this.turnLatencyHistogram = this.declareSeries(
      'turnLatencyMilliseconds',
      {},
      options.turnLatencyBuckets,
    );

    // Families whose label values are only known at the call site, so the
    // metadata is registered here and each series on first use.
    this.declareFamily('rngDrawsTotal', undefined);
    this.declareFamily('healthCheckStatus', undefined);
    this.declareFamily(
      'spanDurationMilliseconds',
      options.spanDurationBuckets,
    );
  }

  /* ----------------------------------------------------------------------
   * Public accessors
   * ------------------------------------------------------------------- */

  /**
   * Resolves a counter series, creating it on first request.
   *
   * IDEMPOTENT: the same name and the same labels always return the same
   * instance, whatever order the label names were written in.
   *
   * @param name Family name, which must match the exposition format's metric
   *   name grammar.
   * @param labels Labels of the series. Defaults to none.
   * @returns The series. A rejected request returns a detached instance that
   *   accepts calls and is exported by nothing.
   */
  counter(name: string, labels: LabelSet = {}): Counter {
    try {
      return this.resolveSeries(name, labels, 'counter', undefined);
    } catch {
      return this.detachedSeries(name, 'counter');
    }
  }

  /**
   * Resolves a gauge series, creating it on first request.
   *
   * @param name Family name.
   * @param labels Labels of the series. Defaults to none.
   * @returns The series, or a detached instance for a rejected request.
   */
  gauge(name: string, labels: LabelSet = {}): Gauge {
    try {
      return this.resolveSeries(name, labels, 'gauge', undefined);
    } catch {
      return this.detachedSeries(name, 'gauge');
    }
  }

  /**
   * Resolves a histogram series, creating it on first request.
   *
   * The bounds are a property of the family, not of the series: the first
   * request for a name fixes them, and a later request carrying different
   * bounds is reported and served with the family's own layout, which every
   * series of the family shares.
   *
   * @param name Family name.
   * @param labels Labels of the series. Defaults to none.
   * @param buckets Inclusive upper bounds. Normalised to an ascending,
   *   deduplicated list; defaults to `DEFAULT_DURATION_BUCKETS`.
   * @returns The series, or a detached instance for a rejected request.
   */
  histogram(
    name: string,
    labels: LabelSet = {},
    buckets?: readonly number[],
  ): Histogram {
    try {
      return this.resolveSeries(name, labels, 'histogram', buckets);
    } catch {
      return this.detachedSeries(name, 'histogram');
    }
  }

  /**
   * Records the `# HELP` and `# TYPE` metadata of a family, creating the
   * family when it does not exist yet.
   *
   * @param name Family name.
   * @param help Help text. A non-string is reported and ignored.
   * @param kind Kind of the family. A kind that disagrees with a family
   *   already registered is reported, and the registered kind stands.
   */
  describe(name: string, help: string, kind: MetricKind): void {
    try {
      const family = this.ensureFamily(name, kind, undefined);

      if (family === null) {
        return;
      }

      if (typeof help !== 'string') {
        this.reportRejection('metric help rejected', {
          metric: family.name,
          reason: 'notAString',
        });

        return;
      }

      family.help = help;
    } catch {
      this.reporterFaults += 1;
    }
  }

  /* ----------------------------------------------------------------------
   * Recorders
   * ------------------------------------------------------------------- */

  /**
   * Counts one engine-event emission, and the turn, merge or spawn that
   * emission also stands for.
   *
   * `tile:merge` is emitted once per merge — js/game_manager.js L156-L170 was
   * entered once per merge inside the traversal — so a move that resolves two
   * merges calls this twice and the merge counter rises by two. `move:after`
   * closes one turn and `tile:spawn` stands for one spawn.
   *
   * @param event Event that was emitted. A name outside
   *   `ENGINE_EVENT_NAMES` is reported and counted nowhere.
   */
  recordEngineEvent(event: EngineEventName): void {
    try {
      const counter = this.eventCounters.get(event);

      if (counter === undefined) {
        this.reportRejection('engine event rejected', {
          reason: 'unknownEvent',
          event: typeof event === 'string' ? event : '',
        });

        return;
      }

      counter.inc(1);

      if (event === 'move:after') {
        this.turnsCounter.inc(1);
      } else if (event === 'tile:merge') {
        this.mergesCounter.inc(1);
      } else if (event === 'tile:spawn') {
        this.spawnsCounter.inc(1);
      }
    } catch {
      this.reporterFaults += 1;
    }
  }

  /**
   * Counts one composited frame and, when a duration is supplied, records it
   * in the frame-duration histogram.
   *
   * @param frameTimeMs Duration of the frame in milliseconds. Omitted, only
   *   the frame is counted; a negative or non-finite value is reported and
   *   the frame is still counted.
   */
  recordFrame(frameTimeMs?: number): void {
    try {
      this.framesCounter.inc(1);

      if (frameTimeMs === undefined) {
        return;
      }

      if (!isFiniteNumber(frameTimeMs) || frameTimeMs < 0) {
        this.reportRejection('frame duration rejected', {
          metric: this.frameTimeHistogram.name,
          reason: 'notANonNegativeNumber',
        });

        return;
      }

      this.frameTimeHistogram.observe(frameTimeMs);
    } catch {
      this.reporterFaults += 1;
    }
  }

  /**
   * Records one turn latency.
   *
   * The boundary is input dispatch through commit: js/game_manager.js L130,
   * the entry of `move()`, to L91-L97, the actuation push.
   *
   * @param durationMs Latency in milliseconds. A negative or non-finite value
   *   is reported and recorded nowhere.
   */
  recordTurnLatency(durationMs: number): void {
    try {
      if (!isFiniteNumber(durationMs) || durationMs < 0) {
        this.reportRejection('turn latency rejected', {
          metric: this.turnLatencyHistogram.name,
          reason: 'notANonNegativeNumber',
        });

        return;
      }

      this.turnLatencyHistogram.observe(durationMs);
    } catch {
      this.reporterFaults += 1;
    }
  }

  /**
   * Records one span duration under its span name.
   *
   * @param span Span name, carried as the `span` label.
   * @param durationMs Duration in milliseconds. A negative or non-finite
   *   value is reported and recorded nowhere.
   */
  recordSpanDuration(span: string, durationMs: number): void {
    try {
      if (typeof span !== 'string' || span.length === 0) {
        this.reportRejection('span duration rejected', {
          metric: METRIC_NAMES.spanDurationMilliseconds,
          reason: 'emptySpanName',
        });

        return;
      }

      if (!isFiniteNumber(durationMs) || durationMs < 0) {
        this.reportRejection('span duration rejected', {
          metric: METRIC_NAMES.spanDurationMilliseconds,
          reason: 'notANonNegativeNumber',
          span,
        });

        return;
      }

      this.histogram(METRIC_NAMES.spanDurationMilliseconds, {
        [METRIC_LABELS.span]: span,
      }).observe(durationMs);
    } catch {
      this.reporterFaults += 1;
    }
  }

  /**
   * Records the result of one health check as `1` or `0`.
   *
   * @param check Check name, carried as the `check` label.
   * @param healthy Whether the check passed. Only the exact value `true`
   *   records `1`.
   */
  recordHealthCheck(check: string, healthy: boolean): void {
    try {
      if (typeof check !== 'string' || check.length === 0) {
        this.reportRejection('health check rejected', {
          metric: METRIC_NAMES.healthCheckStatus,
          reason: 'emptyCheckName',
        });

        return;
      }

      this.gauge(METRIC_NAMES.healthCheckStatus, {
        [METRIC_LABELS.check]: check,
      }).set(healthy === true ? 1 : 0);
    } catch {
      this.reporterFaults += 1;
    }
  }

  /**
   * Folds the draw cursors of the named RNG substreams into the per-stream
   * draw counter.
   *
   * ABSOLUTE RECONCILIATION, as `foldHookDispatchCounts` uses: each cursor is
   * a lifetime total, so the counter rises by the increase since the previous
   * fold and folding one set of cursors twice adds nothing the second time.
   *
   * @param cursors Draw cursor of each substream, keyed by substream name.
   */
  recordRngCursors(cursors: Readonly<Record<string, number>>): void {
    try {
      if (typeof cursors !== 'object' || cursors === null) {
        this.reportRejection('rng cursors rejected', {
          metric: METRIC_NAMES.rngDrawsTotal,
          reason: 'notAnObject',
        });

        return;
      }

      for (const stream of Object.keys(cursors)) {
        const series = this.counterSeries(METRIC_NAMES.rngDrawsTotal, {
          [METRIC_LABELS.stream]: stream,
        });

        this.foldAbsolute(
          series,
          `${METRIC_NAMES.rngDrawsTotal}|${stream}`,
          readCount(cursors, stream),
        );
      }
    } catch {
      this.reporterFaults += 1;
    }
  }

  /* ----------------------------------------------------------------------
   * Hook-bus integration
   * ------------------------------------------------------------------- */

  /**
   * Folds the hook bus's dispatch counts into the per-hook counter families.
   *
   * PULL, not push: the caller reads `HookBus.metrics()` and hands the result
   * here. src/engine imports nothing from this module. Decision surfaced for
   * docs/DECISION_LOG.md.
   *
   * ABSOLUTE RECONCILIATION: the bus reports lifetime totals, so each counter
   * rises by the increase since the previous fold. Folding one snapshot twice
   * therefore adds nothing the second time, and a total that has fallen below
   * the previous reading — a fresh bus under the same registry — is read as
   * the whole of a new lifetime.
   *
   * @param view The bus's snapshot, or any value carrying its `hooks` member.
   *   A missing or malformed member is reported and folded nowhere.
   */
  foldHookDispatchCounts(view: HookDispatchCountsView): void {
    try {
      if (typeof view !== 'object' || view === null) {
        this.reportRejection('hook dispatch fold rejected', {
          reason: 'notAnObject',
        });

        return;
      }

      const table: unknown = view.hooks;

      if (typeof table !== 'object' || table === null) {
        this.reportRejection('hook dispatch fold rejected', {
          reason: 'noHooksMember',
        });

        return;
      }

      const hooks = table as Record<string, unknown>;

      for (const hook of HOOK_NAMES) {
        this.foldOneHook(hooks, hook);
      }
    } catch {
      this.reporterFaults += 1;
    }
  }

  /* ----------------------------------------------------------------------
   * Export
   * ------------------------------------------------------------------- */

  /**
   * Projects the whole registry as plain JSON data.
   *
   * Every series present here is also present in `toPrometheusText()` under
   * the same name and labels, and no series appears in one and not the other.
   *
   * @returns The snapshot. Family order is registration order and, within a
   *   family, series order is first-request order.
   */
  snapshot(): MetricsSnapshot {
    const series: MetricSeriesSnapshot[] = [];

    try {
      for (const family of this.families.values()) {
        for (const entry of family.series.values()) {
          series.push(entry.toSnapshot(family.help));
        }
      }
    } catch {
      this.reporterFaults += 1;
    }

    const snapshot: MetricsSnapshot = {
      schemaVersion: METRICS_SNAPSHOT_SCHEMA_VERSION,
      correlationId: this.correlationId,
      generatedAt: readTimestamp(),
      elapsedMs: readElapsedMs(),
      rejected: this.rejectedCalls,
      reporterFaults: this.reporterFaults,
      series: Object.freeze(series),
    };

    return Object.freeze(snapshot);
  }

  /**
   * Renders every family in the Prometheus text exposition format.
   *
   * One `# HELP` line — omitted when the family has no help text — and one
   * `# TYPE` line precede a family's series. A histogram family emits
   * CUMULATIVE `_bucket` series with an ascending `le`, a final `le="+Inf"`
   * bucket equal to the observation count, then `_sum` and `_count`. The
   * output ends with a newline.
   *
   * @returns The exposition text, empty when nothing is registered.
   */
  toPrometheusText(): string {
    const lines: string[] = [];

    try {
      for (const family of this.families.values()) {
        this.writeFamily(family, lines);
      }
    } catch {
      this.reporterFaults += 1;
    }

    return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  }

  /** The exposition text, as a readable property. */
  get prometheusText(): string {
    return this.toPrometheusText();
  }

  /**
   * Serialises the snapshot as JSON text.
   *
   * @returns The JSON text, or `'{}'` when it could not be produced.
   */
  toJson(): string {
    try {
      const text = JSON.stringify(this.snapshot());

      return typeof text === 'string' ? text : '{}';
    } catch {
      this.reporterFaults += 1;

      return '{}';
    }
  }

  /**
   * Downloads an export as a file.
   *
   * A filename ending in `.json` downloads the JSON snapshot; every other
   * filename downloads the Prometheus text. The object URL is revoked before
   * the call returns.
   *
   * The one member that reaches a document. `document`, `Blob` and
   * `URL.createObjectURL` are each feature-detected, so the call reports and
   * returns `false` where any of them is absent rather than throwing.
   *
   * @param filename Name to save under. Defaults to
   *   `DEFAULT_METRICS_FILENAME`.
   * @returns `true` when the download was triggered.
   */
  download(filename: string = DEFAULT_METRICS_FILENAME): boolean {
    let objectUrl: string | undefined;
    let revoke: ((url: string) => void) | undefined;

    try {
      const doc: unknown = globalThis.document;

      if (typeof doc !== 'object' || doc === null) {
        this.reportRejection('metrics download unavailable', {
          reason: 'noDocument',
        });

        return false;
      }

      const blobCtor: unknown = globalThis.Blob;
      const urlApi: unknown = globalThis.URL;
      const create: unknown =
        typeof urlApi === 'function'
          ? (urlApi as { createObjectURL?: unknown }).createObjectURL
          : undefined;

      revoke =
        typeof urlApi === 'function'
          ? ((urlApi as { revokeObjectURL?: unknown }).revokeObjectURL as
              | ((url: string) => void)
              | undefined)
          : undefined;

      if (typeof blobCtor !== 'function' || typeof create !== 'function') {
        this.reportRejection('metrics download unavailable', {
          reason: 'noBlobOrObjectUrl',
        });

        return false;
      }

      const name =
        typeof filename === 'string' && filename.length > 0
          ? filename
          : DEFAULT_METRICS_FILENAME;
      const wantsJson = name.toLowerCase().endsWith(JSON_EXTENSION);
      const payload = wantsJson ? this.toJson() : this.toPrometheusText();
      const blob = new globalThis.Blob([payload], {
        type: wantsJson ? JSON_MEDIA_TYPE : TEXT_MEDIA_TYPE,
      });

      objectUrl = globalThis.URL.createObjectURL(blob);

      const anchor = globalThis.document.createElement('a');

      anchor.href = objectUrl;
      anchor.download = name;
      anchor.rel = 'noopener';
      anchor.style.display = 'none';

      const host =
        globalThis.document.body ?? globalThis.document.documentElement;

      if (host !== null && host !== undefined) {
        host.appendChild(anchor);
      }

      anchor.click();

      if (anchor.parentNode !== null) {
        anchor.parentNode.removeChild(anchor);
      }

      return true;
    } catch {
      this.reportRejection('metrics download failed', { reason: 'threw' });

      return false;
    } finally {
      if (objectUrl !== undefined && typeof revoke === 'function') {
        try {
          revoke(objectUrl);
        } catch {
          this.reporterFaults += 1;
        }
      }
    }
  }

  /**
   * Zeroes every value and forgets every folded absolute.
   *
   * The families, their series, their kinds, their help text and their bucket
   * layouts all survive, so the exported contract is unchanged. A fold after
   * a reset counts from the source's current total.
   */
  reset(): void {
    try {
      for (const family of this.families.values()) {
        for (const entry of family.series.values()) {
          entry.reset();
        }
      }

      this.foldedAbsolutes.clear();
      this.rejectedCalls = 0;
      this.reporterFaults = 0;
    } catch {
      this.reporterFaults += 1;
    }
  }

  /* ----------------------------------------------------------------------
   * Registration internals
   * ------------------------------------------------------------------- */

  /**
   * Registers a canonical family's metadata without any series.
   *
   * @param key Key into `METRIC_NAMES`.
   * @param buckets Bounds, used only by a histogram family.
   */
  private declareFamily(
    key: keyof typeof METRIC_NAMES,
    buckets: readonly number[] | undefined,
  ): void {
    const family = this.ensureFamily(
      METRIC_NAMES[key],
      METRIC_KINDS[key],
      buckets,
    );

    if (family !== null) {
      family.help = METRIC_HELP[key];
    }
  }

  /**
   * Registers a canonical family's metadata and resolves one of its series.
   *
   * @param key Key into `METRIC_NAMES`.
   * @param labels Labels of the series.
   * @param buckets Bounds, used only by a histogram family.
   * @returns The series.
   */
  private declareSeries(
    key: keyof typeof METRIC_NAMES,
    labels: LabelSet,
    buckets?: readonly number[],
  ): MetricSeries {
    this.declareFamily(key, buckets);

    return this.resolveSeries(
      METRIC_NAMES[key],
      labels,
      METRIC_KINDS[key],
      buckets,
    );
  }

  /**
   * Resolves a family, creating it on first request.
   *
   * @param name Family name.
   * @param kind Requested kind.
   * @param buckets Requested bounds, used only by a histogram family.
   * @returns The family, or `null` when the request was rejected.
   */
  private ensureFamily(
    name: string,
    kind: MetricKind,
    buckets: readonly number[] | undefined,
  ): MetricFamily | null {
    if (!isValidMetricName(name)) {
      this.reportRejection('metric name rejected', {
        metric: typeof name === 'string' ? name : '',
        reason: 'invalidMetricName',
      });

      return null;
    }

    const existing = this.families.get(name);

    if (existing !== undefined) {
      if (existing.kind !== kind) {
        this.reportRejection('metric kind collision', {
          metric: name,
          registered: existing.kind,
          requested: kind,
        });
      } else if (
        kind === 'histogram' &&
        buckets !== undefined &&
        !sameBounds(existing.buckets, normaliseBuckets(buckets))
      ) {
        this.reportRejection('histogram buckets rejected', {
          metric: name,
          reason: 'familyLayoutAlreadyFixed',
        });
      }

      return existing;
    }

    if (this.families.size >= MAX_FAMILIES) {
      this.reportRejection('metric family rejected', {
        metric: name,
        reason: 'familyLimitReached',
        limit: MAX_FAMILIES,
      });

      return null;
    }

    const family: MetricFamily = {
      name,
      kind,
      buckets:
        kind === 'histogram'
          ? Object.freeze(normaliseBuckets(buckets))
          : Object.freeze<number[]>([]),
      help: '',
      series: new Map<string, MetricSeries>(),
    };

    this.families.set(name, family);

    return family;
  }

  /**
   * Resolves one series of a family, creating it on first request.
   *
   * @param name Family name.
   * @param labels Labels of the series.
   * @param kind Requested kind.
   * @param buckets Requested bounds, used only by a histogram family.
   * @returns The series, or a detached instance for a rejected request.
   */
  private resolveSeries(
    name: string,
    labels: LabelSet,
    kind: MetricKind,
    buckets: readonly number[] | undefined,
  ): MetricSeries {
    const normalised = this.normaliseLabels(name, labels);

    if (normalised === null) {
      return this.detachedSeries(name, kind);
    }

    const family = this.ensureFamily(name, kind, buckets);

    if (family === null) {
      return this.detachedSeries(name, kind);
    }

    const key = buildSeriesKey(normalised);
    const existing = family.series.get(key);

    if (existing !== undefined) {
      return existing;
    }

    if (family.series.size >= MAX_SERIES_PER_FAMILY) {
      this.reportRejection('metric series rejected', {
        metric: family.name,
        reason: 'seriesLimitReached',
        limit: MAX_SERIES_PER_FAMILY,
      });

      return this.detachedSeries(family.name, family.kind);
    }

    const series = new MetricSeries(
      family.name,
      normalised,
      family.kind,
      family.buckets,
      this.reportRejection,
    );

    family.series.set(key, series);

    return series;
  }

  /**
   * Validates and copies a label set.
   *
   * The label name `le` is rejected everywhere: a histogram family uses it
   * for its bucket bounds.
   *
   * @param name Family name the labels were requested under, for the report.
   * @param labels Labels to validate.
   * @returns A frozen copy, or `null` when any name or value was rejected.
   */
  private normaliseLabels(name: string, labels: LabelSet): LabelSet | null {
    const metric = typeof name === 'string' ? name : '';

    if (typeof labels !== 'object' || labels === null) {
      this.reportRejection('metric labels rejected', {
        metric,
        reason: 'notAnObject',
      });

      return null;
    }

    const normalised: Record<string, string> = {};

    for (const labelName of Object.keys(labels)) {
      if (labelName === BUCKET_LABEL) {
        this.reportRejection('metric label rejected', {
          metric,
          label: labelName,
          reason: 'reservedLabelName',
        });

        return null;
      }

      if (!isValidLabelName(labelName)) {
        this.reportRejection('metric label rejected', {
          metric,
          label: labelName,
          reason: 'invalidLabelName',
        });

        return null;
      }

      const value: unknown = labels[labelName];

      if (typeof value !== 'string') {
        this.reportRejection('metric label rejected', {
          metric,
          label: labelName,
          reason: 'valueNotAString',
        });

        return null;
      }

      normalised[labelName] = value;
    }

    return Object.freeze(normalised);
  }

  /**
   * Builds an instance the registry does not store, and which every rejected
   * request returns in place of a stored one.
   *
   * @param name Name the request carried.
   * @param kind Kind the request asked for.
   * @returns The detached instance.
   */
  private detachedSeries(name: string, kind: MetricKind): MetricSeries {
    return new MetricSeries(
      typeof name === 'string' ? name : '',
      Object.freeze({}),
      kind,
      kind === 'histogram' ? DEFAULT_DURATION_BUCKETS : [],
      NOOP_SERIES_REPORTER,
      true,
    );
  }

  /**
   * Resolves a counter series as the internal implementation type.
   *
   * @param name Family name.
   * @param labels Labels of the series.
   * @returns The series, or a detached instance.
   */
  private counterSeries(name: string, labels: LabelSet): MetricSeries {
    try {
      return this.resolveSeries(name, labels, 'counter', undefined);
    } catch {
      return this.detachedSeries(name, 'counter');
    }
  }

  /**
   * Reads a cached series, resolving it through the registry when the cache
   * does not hold it.
   *
   * @param cache Cache to read.
   * @param cacheKey Key into the cache.
   * @param name Family name to fall back to.
   * @param labels Labels to fall back to.
   * @returns The series.
   */
  private cachedCounter(
    cache: Map<string, MetricSeries>,
    cacheKey: string,
    name: string,
    labels: LabelSet,
  ): MetricSeries {
    return cache.get(cacheKey) ?? this.counterSeries(name, labels);
  }

  /* ----------------------------------------------------------------------
   * Fold internals
   * ------------------------------------------------------------------- */

  /**
   * Folds one lifetime total into a counter by its increase since the
   * previous fold of the same key.
   *
   * @param series Counter to raise.
   * @param key Fold key the previous absolute is remembered under.
   * @param absolute The total now, or `null` when it could not be read.
   */
  private foldAbsolute(
    series: MetricSeries,
    key: string,
    absolute: number | null,
  ): void {
    if (absolute === null) {
      this.reportRejection('metric fold rejected', {
        metric: series.name,
        key,
        reason: 'notANonNegativeNumber',
      });

      return;
    }

    if (series.detached) {
      return;
    }

    const previous = this.foldedAbsolutes.get(key) ?? 0;
    const delta = absolute >= previous ? absolute - previous : absolute;

    if (delta > 0) {
      series.addInternal(delta);
    }

    this.foldedAbsolutes.set(key, absolute);
  }

  /**
   * Folds one hook's counts out of the bus's `hooks` table.
   *
   * @param table The bus's `hooks` member.
   * @param hook Hook to fold.
   */
  private foldOneHook(table: Record<string, unknown>, hook: HookName): void {
    const counters: unknown = table[hook];

    if (typeof counters !== 'object' || counters === null) {
      this.reportRejection('hook dispatch fold rejected', {
        hook,
        reason: 'missingHookCounters',
      });

      return;
    }

    const hookLabels: LabelSet = { [METRIC_LABELS.hook]: hook };

    this.foldAbsolute(
      this.cachedCounter(
        this.hookDispatchCounters,
        hook,
        METRIC_NAMES.hookDispatchesTotal,
        hookLabels,
      ),
      `${METRIC_NAMES.hookDispatchesTotal}|${hook}`,
      readCount(counters, DISPATCHED_MEMBER),
    );

    this.foldAbsolute(
      this.cachedCounter(
        this.hookInvocationCounters,
        hook,
        METRIC_NAMES.hookHandlerInvocationsTotal,
        hookLabels,
      ),
      `${METRIC_NAMES.hookHandlerInvocationsTotal}|${hook}`,
      readCount(counters, INVOKED_MEMBER),
    );

    this.foldAbsolute(
      this.cachedCounter(
        this.hookErrorCounters,
        hook,
        METRIC_NAMES.relicHandlerErrorsTotal,
        hookLabels,
      ),
      `${METRIC_NAMES.relicHandlerErrorsTotal}|${hook}`,
      readCount(counters, FAILED_MEMBER),
    );

    this.foldAbsolute(
      this.cachedCounter(
        this.hookRejectionCounters,
        hook,
        METRIC_NAMES.hookPayloadRejectionsTotal,
        hookLabels,
      ),
      `${METRIC_NAMES.hookPayloadRejectionsTotal}|${hook}`,
      readCount(counters, REJECTED_MEMBER),
    );

    for (const reason of Object.values(HOOK_SKIP_REASONS)) {
      this.foldAbsolute(
        this.cachedCounter(
          this.hookSkipCounters,
          `${hook}|${reason}`,
          METRIC_NAMES.hookHandlerSkippedTotal,
          {
            [METRIC_LABELS.hook]: hook,
            [METRIC_LABELS.reason]: reason,
          },
        ),
        `${METRIC_NAMES.hookHandlerSkippedTotal}|${hook}|${reason}`,
        readCount(counters, SKIP_REASON_MEMBER[reason]),
      );
    }
  }

  /* ----------------------------------------------------------------------
   * Exposition internals
   * ------------------------------------------------------------------- */

  /**
   * Appends one family's metadata and series to the exposition.
   *
   * @param family Family to render.
   * @param lines Accumulator the lines are pushed onto.
   */
  private writeFamily(family: MetricFamily, lines: string[]): void {
    if (family.help.length > 0) {
      lines.push(`# HELP ${family.name} ${escapeHelp(family.help)}`);
    }

    lines.push(`# TYPE ${family.name} ${family.kind}`);

    for (const series of family.series.values()) {
      if (family.kind === 'histogram') {
        this.writeHistogram(series, lines);
      } else {
        lines.push(
          `${family.name}${formatLabels(series.labels)} ` +
            formatMetricValue(series.value),
        );
      }
    }
  }

  /**
   * Appends one histogram series: the cumulative bucket series in ascending
   * bound order, the `+Inf` bucket, then the sum and the count.
   *
   * @param series Series to render.
   * @param lines Accumulator the lines are pushed onto.
   */
  private writeHistogram(series: MetricSeries, lines: string[]): void {
    const cumulative = series.bucketCounts;

    for (let index = 0; index < series.buckets.length; index += 1) {
      const bound = series.buckets[index] ?? 0;
      const bucketLabels = formatLabels(
        series.labels,
        BUCKET_LABEL,
        formatMetricValue(bound),
      );

      lines.push(
        `${series.name}${BUCKET_SUFFIX}${bucketLabels} ` +
          formatMetricValue(cumulative[index] ?? 0),
      );
    }

    const infLabels = formatLabels(
      series.labels,
      BUCKET_LABEL,
      POSITIVE_INFINITY_LABEL,
    );
    const plainLabels = formatLabels(series.labels);

    lines.push(
      `${series.name}${BUCKET_SUFFIX}${infLabels} ` +
        formatMetricValue(series.count),
    );
    lines.push(
      `${series.name}${SUM_SUFFIX}${plainLabels} ` +
        formatMetricValue(series.sum),
    );
    lines.push(
      `${series.name}${COUNT_SUFFIX}${plainLabels} ` +
        formatMetricValue(series.count),
    );
  }
}

/**
 * Builds a registry, matching the construction idiom of
 * src/observability/logger.ts.
 *
 * @param options Logger and the three histogram bucket layouts.
 * @returns The registry.
 */
export function createMetricsRegistry(
  options: MetricsRegistryOptions = {},
): MetricsRegistry {
  return new MetricsRegistry(options);
}
