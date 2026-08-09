// The in-page metrics registry: counter, gauge and histogram primitives, the
// series registry, the canonical metric-name contract, the pull integration
// with the hook bus's dispatch counts, the Prometheus text exposition and the
// client-side snapshot download.
//
// This module is a pure addition. No counter, no histogram, no `performance.*`
// call and no `console.*` call existed in the retired sources, so it carries no
// ported construct.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
// this module's area enumerated, all target-only because the retired sources
// carried no counter, gauge or histogram:
//   TR-METRIC-01  the counter, gauge and histogram primitives
//   TR-METRIC-02  the series registry and the canonical metric-name contract
//   TR-METRIC-03  the emission-fed turn-boundary counters `mergesTotal` and
//                 `spawnsTotal`
//   TR-METRIC-04  the counter-fed families `turnsTotal`, `spawnAttemptsTotal`
//                 and `spawnSuppressedTotal`
//   TR-METRIC-05  the pull integration with the hook bus's dispatch counts
//   TR-METRIC-06  the Prometheus text exposition and the snapshot `download`
//
// Boundaries the turn-boundary counters come from in the retired control flow:
// `turnsTotal` from the actuation push of js/game_manager.js L182-L190, which
// sat INSIDE that method's `if (moved)` block, so a vanilla move that changed
// nothing spawned nothing, actuated nothing and closed no turn; `mergesTotal`
// from the merge branch, which is entered once per merge inside the traversal
// so a move resolving two merges enters it twice; and `spawnsTotal` from
// `addRandomTile()`.
//
// WHICH FEED EACH FAMILY HAS. An engine EVENT feeds `engineEventsTotal`,
// `mergesTotal` and `spawnsTotal`, through `recordEngineEvent` or
// `recordEngineEventCount`; an engine COUNTER feeds `turnsTotal`,
// `spawnAttemptsTotal` and `spawnSuppressedTotal`, through
// `recordTurnResolved`, `recordSpawnAttempt` and `recordSpawnSuppressed`. The
// two are not interchangeable, for the same reason in both directions.
//
// The engine returns before emitting `tile:spawn` on a full board — the
// boundary that keeps a full board free of draws — so an emission count
// measures resolved spawns and attempts are only observable at the engine's own
// `engine.spawn.attempt` counter, raised on entry to the spawn. Feeding an
// attempt family from an emission under-reports it by exactly the full-board
// attempts.
//
// `move:after`, symmetrically, is the completion signal of EVERY turn that
// reached the walk and carries `moved: false` for one that moved nothing, so an
// emission count measures turns ATTEMPTED. A turn that resolved is observable
// at the engine's own `engine.move.resolved` counter, raised once per move that
// changed the board. Feeding the turn family from the emission OVER-reports it
// by exactly the idle inputs — pressing into a wall, repeating a direction on a
// settled board — which skews every rate derived from it, and that is the
// substitution this module refuses to make in either direction.
//
// Emission counts do not vary with observers. The emitter counts an emission
// before it looks a listener up, so an event with no subscriber is counted
// like one with three and `engineEventsTotal` measures the engine rather than
// the run's subscriptions. An emission is reported on the `event` dimension
// of `EngineCountReport` and a hook dispatch on its `hook` dimension; the two
// are disjoint, and `recordEngineEventCount` refuses a report that names an
// event in the hook dimension rather than folding it under that hook.
//
// Decisions behind this file, argued in docs/DECISION_LOG.md and named here
// only so the construct can be found from the log:
//   DL-METRIC-01  the `DEFAULT_DURATION_BUCKETS` boundaries
//   DL-METRIC-02  the attempt and the insertion spawn families both counted
//   DL-METRIC-03  the pull-snapshot model for the hook bus's dispatch counts
//   DL-METRIC-04  series carried on label dimensions
//   DL-METRIC-05  this in-page registry, its Prometheus text and its snapshot
//                 download as the delivered form of a metrics endpoint
//   DL-METRIC-06  a hook-dispatch snapshot folded only when its correlation
//                 identifier is present and agrees with this registry's
//
// The default duration buckets take each boundary from a timing the product
// already holds: 16 ms is the frame budget of js/animframe_polyfill.js, and
// 100, 200, 600, 800 and 1200 ms are the transition speed and the `appear`,
// `pop`, `move-up` and `fade-in` timings of the stylesheet, the last being the
// fade's delay.
//
// Invariants of this module. It names no package: its four imports are relative
// paths into src/, and three of the four are erased at build time. Exported
// members report rather than throw. Memory is bounded: a histogram holds bucket
// counts, a sum and a count and retains no observation, and the registry caps
// the families and the series per family it will hold. The one member that
// reaches a document is `download`, which feature-detects every global it uses;
// `performance` and the wall clock are read through guarded helpers, so the
// module is importable and usable with no DOM.

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
import type { CorrelationId } from '../engine/types';
import { RNG_STREAM_NAMES } from '../rng/rng-streams';
import type { LogFields, Logger } from './logger';

/**
 * The label bag one series carries.
 *
 * Flat text to text. The exposition format has no nested label value, and none
 * is accepted here.
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
  readonly name: string;
  readonly labels: LabelSet;
  readonly value: number;
  inc(delta?: number): void;
}

/**
 * A value that rises and falls.
 *
 * `set`, `inc` and `dec` each accept a finite number; a non-finite value and a
 * value that is not a number are ignored and reported, and neither throws nor
 * changes `value`.
 */
export interface Gauge {
  readonly name: string;
  readonly labels: LabelSet;
  readonly value: number;
  set(value: number): void;
  inc(delta?: number): void;
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
  readonly name: string;
  readonly labels: LabelSet;
  readonly count: number;
  readonly sum: number;
  readonly buckets: readonly number[];

  /**
   * CUMULATIVE counts aligned to `buckets`: element `i` counts every
   * observation at or below `buckets[i]`. Built fresh on each read. The
   * overflow slot is not an element here; it equals `count`.
   */
  readonly bucketCounts: readonly number[];
  observe(value: number): void;

  /**
   * Estimates a quantile from the bucket counts.
   *
   * BUCKET-APPROXIMATED, not exact. The observations are not retained; the
   * result is interpolated linearly within the bucket the rank falls in, and
   * its accuracy is bounded by the bucket widths. A rank that falls in the
   * overflow slot resolves to the highest bound.
   *
   * An EMPTY BUCKET IS NEVER SELECTED: it holds no observation, so no rank
   * falls inside it. The lower edge of the first bucket, which the bounds
   * leave unbounded below, is the smallest observation recorded, so an
   * estimate never falls outside the observed range — including for a layout
   * whose first bound is negative.
   *
   * @param q Quantile to estimate, from 0 to 1 inclusive.
   * @returns The estimate, or `NaN` when nothing has been observed or `q` is
   *   outside [0, 1].
   */
  quantile(q: number): number;
}

/**
 * Inclusive upper bounds, in milliseconds, of the duration histograms.
 *
 * Ascending and deduplicated. Boundaries below 16 give sub-frame resolution,
 * 16 is the frame budget, 32 and 64 are two and four budgets, and the rest are
 * the animation timings the product already holds, out past the 1200 ms
 * overlay delay.
 *
 * Decision DL-METRIC-01.
 */
export const DEFAULT_DURATION_BUCKETS: readonly number[] = Object.freeze([
  1, 2, 4, 8, 16, 32, 64, 100, 200, 400, 600, 800, 1200, 2000,
]);

const METRIC_NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

const LABEL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const RESERVED_LABEL_PREFIX = '__';

const BUCKET_LABEL = 'le';

const BUCKET_SUFFIX = '_bucket';

const SUM_SUFFIX = '_sum';

const COUNT_SUFFIX = '_count';

const POSITIVE_INFINITY_LABEL = '+Inf';

/**
 * Tests a metric family name against the exposition format's grammar.
 *
 * @returns `true` when the name is usable as a metric name.
 */
export function isValidMetricName(name: string): boolean {
  return typeof name === 'string' && METRIC_NAME_PATTERN.test(name);
}

/**
 * Tests a label name against the exposition format's grammar. The reserved
 * `__` prefix is rejected.
 *
 * @returns `true` when the name is usable as a label name.
 */
export function isValidLabelName(name: string): boolean {
  return (
    typeof name === 'string' &&
    LABEL_NAME_PATTERN.test(name) &&
    !name.startsWith(RESERVED_LABEL_PREFIX)
  );
}

/** Prefix every canonical metric name carries. */
export const METRIC_PREFIX = 'game2048_';

/**
 * Every canonical metric family name.
 *
 * Frozen, and the single declaration of each name: no other module writes one
 * of its own. Counters carry `_total` and duration histograms carry
 * `_milliseconds`.
 */
export const METRIC_NAMES = Object.freeze({
  /**
   * Turns that resolved a move. Boundary: the actuation push of
   * js/game_manager.js L182-L190, which sat inside that method's `if (moved)`
   * block, and which is the engine's `engine.move.resolved` counter. It is NOT
   * the `move:after` event: that event is the completion signal of every turn
   * that reached the walk and carries `moved: false` for a turn that moved
   * nothing, so an emission count measures turns attempted. Fed by
   * `recordTurnResolved` alone.
   *
   * Never above `engine_events_total{event="move:after"}`, and below it by
   * exactly the number of idle inputs.
   */
  turnsTotal: `${METRIC_PREFIX}turns_total`,
  mergesTotal: `${METRIC_PREFIX}merges_total`,

  /**
   * Tiles actually inserted into the lattice. Boundary:
   * js/game_manager.js L69-L76, whose L72-L75 body ran only when
   * js/grid.js L37-L43 returned a cell. Fed by `recordEngineEvent` from the
   * `tile:spawn` emissions that carry a position, which the engine emits
   * only for a spawn that reached the lattice.
   */
  spawnsTotal: `${METRIC_PREFIX}spawns_total`,

  /**
   * Spawn attempts, whether or not a cell was available. Boundary:
   * js/game_manager.js L69-L76 on entry, which is the engine's
   * `engine.spawn.attempt` counter and NOT the `tile:spawn` event: the
   * engine returns before emitting when the board is full, so an emission
   * count measures resolved spawns and would under-report attempts. Fed by
   * `recordSpawnAttempt` alone.
   *
   * Always at least `spawns_total`, and exactly `spawns_total` plus
   * `spawn_suppressed_total`.
   */
  spawnAttemptsTotal: `${METRIC_PREFIX}spawn_attempts_total`,

  /**
   * Spawn attempts that inserted no tile: the board was full, or an
   * `onSpawn` handler returned no usable cell. The engine's
   * `engine.spawn.suppressed` counter, fed by `recordSpawnSuppressed`.
   */
  spawnSuppressedTotal: `${METRIC_PREFIX}spawn_suppressed_total`,

  /** Engine events emitted, one series per `ENGINE_EVENT_NAMES` member. */
  engineEventsTotal: `${METRIC_PREFIX}engine_events_total`,
  hookDispatchesTotal: `${METRIC_PREFIX}hook_dispatches_total`,
  hookHandlerInvocationsTotal:
    `${METRIC_PREFIX}hook_handler_invocations_total`,

  hookHandlerSkippedTotal: `${METRIC_PREFIX}hook_handler_skipped_total`,
  hookPayloadRejectionsTotal:
    `${METRIC_PREFIX}hook_payload_rejections_total`,

  relicHandlerErrorsTotal: `${METRIC_PREFIX}relic_handler_errors_total`,
  framesRenderedTotal: `${METRIC_PREFIX}frames_rendered_total`,
  rngDrawsTotal: `${METRIC_PREFIX}rng_draws_total`,
  metricsRejectedTotal: `${METRIC_PREFIX}metrics_rejected_total`,
  healthCheckStatus: `${METRIC_PREFIX}health_check_status`,
  frameTimeMilliseconds: `${METRIC_PREFIX}frame_time_milliseconds`,
  turnLatencyMilliseconds: `${METRIC_PREFIX}turn_latency_milliseconds`,
  spanDurationMilliseconds: `${METRIC_PREFIX}span_duration_milliseconds`,
} as const);

/**
 * Every canonical label name.
 *
 * Frozen. The per-hook, per-event, per-reason, per-stream, per-check and
 * per-span families are label dimensions on one family each, not concatenated
 * names.
 *
 * Decision DL-METRIC-04.
 */
export const METRIC_LABELS = Object.freeze({
  hook: 'hook',
  event: 'event',
  reason: 'reason',
  stream: 'stream',
  check: 'check',
  span: 'span',
} as const);

const METRIC_HELP: Readonly<Record<keyof typeof METRIC_NAMES, string>> =
  Object.freeze({
    turnsTotal:
      'Turns that resolved a move, one per engine turn that changed the ' +
      'board. Idle turns are not counted.',
    mergesTotal: 'Tile merges resolved, one per tile:merge emission.',
    spawnsTotal:
      'Tiles inserted, one per tile:spawn emission carrying a position.',
    spawnAttemptsTotal:
      'Spawn attempts, one per engine spawn entry whether or not a cell ' +
      'was available.',
    spawnSuppressedTotal:
      'Spawn attempts that inserted no tile, on a full board or after a ' +
      'handler returned no usable cell.',
    engineEventsTotal:
      'Engine events emitted, by event name, counted per emission and not ' +
      'per listener.',
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
    healthCheckStatus:
      'Health check result: 1 healthy, 0 unhealthy, -1 not applicable ' +
      '(the host offers nothing to evaluate).',
    frameTimeMilliseconds: 'Frame duration in milliseconds.',
    turnLatencyMilliseconds:
      'Turn latency in milliseconds, input dispatch through commit.',
    spanDurationMilliseconds:
      'Span duration in milliseconds, by span name.',
  });

const METRIC_KINDS: Readonly<Record<keyof typeof METRIC_NAMES, MetricKind>> =
  Object.freeze({
    turnsTotal: 'counter',
    mergesTotal: 'counter',
    spawnsTotal: 'counter',
    spawnAttemptsTotal: 'counter',
    spawnSuppressedTotal: 'counter',
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

/**
 * The slice of `HookBusMetrics` this module reads: the per-hook counts and
 * the correlation identifier of the bus that counted them.
 *
 * Derived from that type by `Pick`, and optional. The member name is written
 * once, here. A `HookBusMetrics` value satisfies it as it stands; a fabricated
 * or partial value is validated at runtime.
 */
export type HookDispatchCountsView = Partial<
  Pick<HookBusMetrics, 'hooks' | 'correlationId'>
>;

const HOOK_SKIP_REASONS: Readonly<Record<HookSkipReason, HookSkipReason>> =
  Object.freeze({
    exhausted: 'exhausted',
    degraded: 'degraded',
    detached: 'detached',
  });

const SKIP_REASON_MEMBER: Readonly<
  Record<HookSkipReason, keyof HookHandlerCounters>
> = Object.freeze({
  exhausted: 'skippedExhausted',
  degraded: 'skippedDegraded',
  detached: 'skippedDetached',
});

const DISPATCHED_MEMBER: keyof HookCounters = 'dispatched';

const INVOKED_MEMBER: keyof HookHandlerCounters = 'invoked';

const FAILED_MEMBER: keyof HookHandlerCounters = 'failed';

const REJECTED_MEMBER: keyof HookHandlerCounters = 'rejected';

/** Version the snapshot envelope carries. */
export const METRICS_SNAPSHOT_SCHEMA_VERSION = 1;

interface SeriesSnapshotBase {
  readonly name: string;
  readonly help: string;
  readonly labels: LabelSet;
}

/** One counter series. */
export interface CounterSeriesSnapshot extends SeriesSnapshotBase {
  readonly kind: 'counter';
  readonly value: number;
}

/** One gauge series. */
export interface GaugeSeriesSnapshot extends SeriesSnapshotBase {
  readonly kind: 'gauge';
  readonly value: number;
}

/** One histogram series. */
export interface HistogramSeriesSnapshot extends SeriesSnapshotBase {
  readonly kind: 'histogram';
  readonly count: number;
  readonly sum: number;
  readonly buckets: readonly number[];
  readonly bucketCounts: readonly number[];
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
 * `JSON.parse(JSON.stringify(snapshot))` unchanged, so a consumer need not
 * parse the text form. Every series in it also appears in
 * `toPrometheusText()`, and no series appears in one and not the other.
 */
export interface MetricsSnapshot {
  readonly schemaVersion: number;
  readonly correlationId: string;
  readonly generatedAt: string;
  readonly elapsedMs: number;
  readonly rejected: number;

  /** Logger calls that threw and were contained over that lifetime. */
  readonly reporterFaults: number;

  /** Every series, family by family in registration order. */
  readonly series: readonly MetricSeriesSnapshot[];
}

/**
 * The one member of a `tile:spawn` payload `recordEngineEvent` reads.
 *
 * A structural view rather than an import of the event type, so the registry
 * still names no engine payload interface: a `SpawnPayload` from
 * src/engine/hooks.ts and a `TileSpawnEvent` from
 * src/engine/engine-events.ts both satisfy it.
 *
 * `position` present means a tile entered the lattice, and absent — or
 * `undefined` — means the spawn was suppressed and inserted nothing. It is
 * therefore the insertion signal and NOT the attempt signal: a full board
 * emits no `tile:spawn` at all, because the engine returns before the
 * emission, which is what keeps a full board free of draws. Attempts come
 * from `recordSpawnAttempt`.
 */
export interface SpawnDetail {
  /** Cell the tile was inserted in, absent when none was. */
  readonly position?: unknown;
}

/**
 * The dimensions of an engine count report `recordEngineEventCount` reads.
 *
 * A structural view rather than an import, matching `SpawnDetail` above: an
 * `EngineCountReport` from src/engine/types.ts satisfies it as it stands, and
 * a fabricated value is validated at runtime.
 *
 * `hook` is declared here only so it can be REFUSED. The two dimensions are
 * disjoint and a report carries at most one; a report that names an engine
 * event in `hook` is a caller mistaking the hook dimension for the event
 * dimension, and folding it would attribute an emission to a hook.
 */
export interface EngineEventCountView {
  /** Event the count is attributed to, one of `ENGINE_EVENT_NAMES`. */
  readonly event?: unknown;

  /** Hook dimension, which this entry point reads only to reject. */
  readonly hook?: unknown;

  /** Emissions the report stands for. Absent is read as one. */
  readonly value?: unknown;
}

/* --------------------------------------------------------------------------
 * Construction parameters
 * ----------------------------------------------------------------------- */

/** Families the registry will hold before it rejects a new one. */
const MAX_FAMILIES = 128;

const MAX_SERIES_PER_FAMILY = 256;

const MAX_BUCKETS = 64;

/** Labels one series will carry. */
const MAX_LABELS_PER_SERIES = 8;

/** Characters a family name will carry. */
const MAX_METRIC_NAME_LENGTH = 200;

/** Characters a label name will carry. */
const MAX_LABEL_NAME_LENGTH = 64;

/** Characters a label value will carry. */
const MAX_LABEL_VALUE_LENGTH = 120;

/** Characters a family's help text will carry. */
const MAX_HELP_LENGTH = 240;

/**
 * Characters of metadata the registry will retain across every family and
 * every series: family names, help texts, label names and label values.
 *
 * The per-field limits above bound one call; this bounds their sum, so no
 * sequence of accepted calls can grow the registry without limit. The
 * family and series caps alone did not: 128 families times 256 series times
 * eight labels of bounded length still multiplies out, and the exposition
 * text and the JSON snapshot are both built from all of it.
 */
const MAX_METADATA_CHARS = 262144;

/** Subsystem tag the registry's logger is tagged with. */
const LOGGER_SUBSYSTEM = 'metrics';

/** Filename `download` uses when the caller supplies none. */
export const DEFAULT_METRICS_FILENAME = 'game2048-metrics.prom';

const JSON_EXTENSION = '.json';

const TEXT_MEDIA_TYPE = 'text/plain;charset=utf-8';

const JSON_MEDIA_TYPE = 'application/json;charset=utf-8';

/** Settings `MetricsRegistry` accepts. */
export interface MetricsRegistryOptions {
  readonly logger?: Logger;
  readonly frameTimeBuckets?: readonly number[];
  readonly turnLatencyBuckets?: readonly number[];
  readonly spanDurationBuckets?: readonly number[];
}

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

function readTimestamp(): string {
  try {
    return new Date().toISOString();
  } catch {
    return '';
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

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

function buildSeriesKey(labels: LabelSet): string {
  const names = Object.keys(labels).sort();
  const pairs: [string, string][] = [];

  for (const name of names) {
    pairs.push([name, labels[name] ?? '']);
  }

  return JSON.stringify(pairs);
}

/**
 * Names the three series a histogram family generates in the exposition.
 *
 * A histogram family named `x` emits `x_bucket`, `x_sum` and `x_count`. Each
 * of those is a valid metric name in its own right, so a family registered
 * under one of them would collide with the generated series: one name would
 * carry two `# TYPE` declarations and two sets of samples, which a scraper
 * reads as a single malformed family.
 *
 * @param name Histogram family name.
 * @returns The three generated names.
 */
function generatedHistogramNames(name: string): readonly string[] {
  return [
    `${name}${BUCKET_SUFFIX}`,
    `${name}${SUM_SUFFIX}`,
    `${name}${COUNT_SUFFIX}`,
  ];
}

/**
 * Names the histogram family a candidate name would collide with, if any.
 *
 * The reciprocal of `generatedHistogramNames`: `x_bucket` resolves to `x`.
 *
 * @param name Candidate family name.
 * @returns The base name, or `null` when the candidate carries none of the
 *   three suffixes.
 */
function histogramBaseName(name: string): string | null {
  for (const suffix of [BUCKET_SUFFIX, SUM_SUFFIX, COUNT_SUFFIX]) {
    if (name.length > suffix.length && name.endsWith(suffix)) {
      return name.slice(0, name.length - suffix.length);
    }
  }

  return null;
}

/**
 * Derives the help text of a family that was never described.
 *
 * Deterministic and stable, so one registry state always renders one
 * exposition: the exposition format's `# HELP` line is emitted once per
 * family, and a family with no text of its own used to emit `# TYPE` alone.
 *
 * @param name Family name.
 * @param kind Kind the family was registered under.
 * @returns The derived text.
 */
function deriveHelp(name: string, kind: MetricKind): string {
  return `${name} ${kind}; no help text was supplied.`;
}

/**
 * Builds the key one absolute reconciliation is remembered under.
 *
 * The source correlation identifier is part of the key, so a total read
 * from one source is never differenced against a total read from another.
 *
 * @param metric Family name the fold raises.
 * @param source Correlation identifier of the snapshot being folded.
 * @param dimension Label dimension within the family, such as a hook name
 *   or a substream name.
 * @returns The key.
 */
function foldKey(
  metric: string,
  source: CorrelationId,
  dimension: string,
): string {
  return `${metric}|${source}|${dimension}`;
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

function escapeHelp(help: string): string {
  return help
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/[\u0000-\u001f\u007f]/g, ' ');
}

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

type SeriesReporter = (message: string, fields: LogFields) => void;

const NOOP_SERIES_REPORTER: SeriesReporter = () => undefined;

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
 * Reports whether a `tile:spawn` payload placed a tile.
 *
 * `SpawnPayload.position` in src/engine/hooks.ts is optional, and the engine
 * carries it on the event only for a spawn that reached the lattice: a spawn
 * suppressed on a full board is not emitted at all, and one suppressed by a
 * handler is emitted with the member omitted, which is the state
 * js/grid.js L37-L43 signalled by returning `undefined` from
 * `randomAvailableCell()`. A cell is a `{x, y}` pair of finite numbers.
 *
 * @param payload Payload the event carried.
 * @returns `true` when the payload carries a usable cell.
 */
function carriesSpawnPosition(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }

  const position: unknown = (payload as { position?: unknown }).position;

  if (typeof position !== 'object' || position === null) {
    return false;
  }

  const cell = position as { x?: unknown; y?: unknown };

  return isFiniteNumber(cell.x) && isFiniteNumber(cell.y);
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
 * Reduces a value of unknown type to a bounded string fit for a rejection
 * field.
 *
 * Only a string is carried, and only as many characters as a label value
 * holds: a rejection reports what it refused without letting the refused
 * value set the size of the record. Anything else reduces to the empty
 * string rather than being stringified, so a hostile `toString` is never
 * called.
 *
 * @param value Value being reported.
 * @returns The bounded string, or `''`.
 */
function boundedLabel(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value.length > MAX_LABEL_VALUE_LENGTH
    ? value.slice(0, MAX_LABEL_VALUE_LENGTH)
    : value;
}

class MetricSeries implements Counter, Gauge, Histogram {
  readonly name: string;
  readonly labels: LabelSet;
  readonly kind: MetricKind;
  readonly buckets: readonly number[];
  readonly detached: boolean;

  private readonly report: SeriesReporter;

  private scalar = 0;

  private observations = 0;

  private total = 0;

  /**
   * Per-bucket counts, NOT cumulative. Length is `buckets.length + 1`; the
   * final element is the overflow slot for an observation above every bound.
   */
  private readonly counts: number[];

  /**
   * Smallest observation recorded, or `Number.POSITIVE_INFINITY` while none
   * has been.
   *
   * One number, so the histogram still retains no observation. It is the
   * lower edge of the first bucket, which the bucket bounds do not carry:
   * the first bucket holds everything at or below `buckets[0]`, so its lower
   * edge is unbounded below and interpolating from a hard-coded `0` was
   * wrong for any layout whose first bound is negative, and wrong by the
   * whole of the first bucket for one whose observations sit well above `0`.
   */
  private minObservation = Number.POSITIVE_INFINITY;

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

  get value(): number {
    return this.kind === 'histogram' ? this.observations : this.scalar;
  }

  get count(): number {
    return this.observations;
  }

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

    if (value < this.minObservation) {
      this.minObservation = value;
    }

    const slot = this.resolveSlot(value);

    this.counts[slot] = (this.counts[slot] ?? 0) + 1;
  }

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

    // The lower edge of the first bucket, which is unbounded below in the
    // bucket layout and is therefore taken from the observations
    // themselves. Finite here, because `observations` is non-zero.
    let lowerBound = this.minObservation;
    let cumulativeBelow = 0;

    for (let index = 0; index < this.buckets.length; index += 1) {
      const inBucket = this.counts[index] ?? 0;
      const upperBound = this.buckets[index] ?? lowerBound;

      // An EMPTY BUCKET HOLDS NO OBSERVATION, so no rank falls inside it and
      // it is never the answer. `quantile(0)` used to select it, because a
      // cumulative count of zero satisfies `>= 0`, and returned a bound
      // nothing was ever observed at.
      if (inBucket === 0) {
        lowerBound = upperBound;

        continue;
      }

      const cumulative = cumulativeBelow + inBucket;

      if (cumulative >= rank) {
        const share = Math.min(
          Math.max((rank - cumulativeBelow) / inBucket, 0),
          1,
        );

        return lowerBound + (upperBound - lowerBound) * share;
      }

      cumulativeBelow = cumulative;
      lowerBound = upperBound;
    }

    // Every bucket is empty, so every observation is above the last bound.
    return this.buckets[this.buckets.length - 1] ?? Number.NaN;
  }

  /** Zeroes every value. The kind, labels and bounds are unchanged. */
  reset(): void {
    this.scalar = 0;
    this.observations = 0;
    this.total = 0;
    this.minObservation = Number.POSITIVE_INFINITY;
    this.counts.fill(0);
  }

  addInternal(delta: number): void {
    if (this.detached || this.kind === 'histogram') {
      return;
    }

    if (!isFiniteNumber(delta) || delta < 0) {
      return;
    }

    this.scalar += delta;
  }

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

  private reject(operation: string, fields: LogFields): void {
    this.report('metric call rejected', {
      ...fields,
      metric: this.name,
      operation,
    });
  }
}

interface MetricFamily {
  readonly name: string;
  readonly kind: MetricKind;

  /** Bucket bounds shared by every series of a histogram family. */
  readonly buckets: readonly number[];
  help: string;
  readonly series: Map<string, MetricSeries>;
}

/**
 * The in-page metrics registry.
 *
 * Holds every series and exports them three ways: `snapshot()` as JSON,
 * `toPrometheusText()` as text exposition, and `download()` as a file. Those
 * three members are what stands in for a network-served metrics endpoint here.
 //
 * The substitution is decision DL-METRIC-05.
 *
 * Every member is safe to call from inside an engine-event listener: a rejected
 * call is reported through the injected logger, counted, and otherwise ignored
 * rather than raised.
 */
export class MetricsRegistry {
  /**
   * Correlation identifier every snapshot is keyed under and every fold baseline
   * is checked against, as it stands now.
   *
   * A GETTER over the injected logger, not a captured value: one page load can
   * play more than one run, and `Logger.setCorrelationId` rotates the identifier
   * for every logger sharing its state. A captured value would key a second
   * run's snapshot to the first, and would make `resolveFoldSource` refuse the
   * hook bus's own counts as foreign the moment the bus reported under the run
   * that was actually playing. Decision DL-TYPES-04.
   */
  get correlationId(): string {
    return readCorrelationId(this.logger);
  }

  /** The families, in registration order. */
  private readonly families = new Map<string, MetricFamily>();

  /**
   * Absolute values the last fold read, keyed by `foldKey` — family, source
   * correlation identifier and label dimension — so a repeated fold of the
   * same snapshot adds nothing and two sources keep separate baselines.
   */
  private readonly foldedAbsolutes = new Map<string, number>();

  private readonly eventCounters = new Map<string, MetricSeries>();

  private readonly hookDispatchCounters = new Map<string, MetricSeries>();

  private readonly hookInvocationCounters = new Map<string, MetricSeries>();

  /** Per-hook contained-throw counters, keyed by hook name. */
  private readonly hookErrorCounters = new Map<string, MetricSeries>();

  private readonly hookRejectionCounters = new Map<string, MetricSeries>();

  private readonly hookSkipCounters = new Map<string, MetricSeries>();

  /**
   * Sample names the histogram families generate, each mapped to the family
   * that owns it, so a later registration under one of them is refused.
   */
  private readonly reservedNames = new Map<string, string>();

  /** Metadata characters retained across every family and series. */
  private metadataChars = 0;

  /**
   * Per-span duration histograms, keyed by span name.
   *
   * Span, check and stream names are not known at construction the way event
   * and hook names are, so these three caches fill on first use instead of
   * being pre-resolved. Each is bounded by `MAX_SERIES_PER_FAMILY`, the same
   * ceiling a family itself holds, so an unbounded stream of distinct
   * identifiers cannot grow them without limit.
   */
  private readonly spanHistograms = new Map<string, MetricSeries>();

  /** Per-check status gauges, keyed by check name. */
  private readonly healthGauges = new Map<string, MetricSeries>();

  /** Per-substream draw counters, keyed by substream name. */
  private readonly rngStreamCounters = new Map<string, MetricSeries>();

  /** Calls rejected over the registry's lifetime. */
  private rejectedCalls = 0;

  /** Logger calls that threw and were contained. */
  private reporterFaults = 0;

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

  private readonly rejectedCounter: MetricSeries;

  private readonly turnsCounter: MetricSeries;

  private readonly mergesCounter: MetricSeries;

  /** Cached series for the inserted-tile counter. */
  private readonly spawnsCounter: MetricSeries;

  /** Cached series for the spawn-attempt counter. */
  private readonly spawnAttemptsCounter: MetricSeries;

  /** Cached series for the attempts that inserted nothing. */
  private readonly spawnSuppressedCounter: MetricSeries;

  /** Cached series for the composited-frame counter. */
  private readonly framesCounter: MetricSeries;

  private readonly frameTimeHistogram: MetricSeries;

  private readonly turnLatencyHistogram: MetricSeries;

  constructor(options: MetricsRegistryOptions = {}) {
    this.logger = tagLogger(options.logger);

    // Registered first. Rejections raised by the registrations below are
    // counted in it.
    this.rejectedCounter = this.declareSeries('metricsRejectedTotal', {});

    this.turnsCounter = this.declareSeries('turnsTotal', {});
    this.mergesCounter = this.declareSeries('mergesTotal', {});
    this.spawnsCounter = this.declareSeries('spawnsTotal', {});
    this.spawnAttemptsCounter = this.declareSeries('spawnAttemptsTotal', {});
    this.spawnSuppressedCounter = this.declareSeries(
      'spawnSuppressedTotal',
      {},
    );
    this.framesCounter = this.declareSeries('framesRenderedTotal', {});

    // THE THREE CANONICAL TUPLES DRIVE CONSTRUCTION, AND ARE STILL
    // VALIDATED. `ENGINE_EVENT_NAMES`, `HOOK_NAMES` and `RNG_STREAM_NAMES`
    // are each `Object.freeze`d at their declaration, so no consumer can
    // reorder or extend one at runtime and change which series this registry
    // holds. The bounded checks below are kept regardless of that freeze:
    // every name and label goes through `declareSeries`, which validates the
    // name and label pattern, charges the metadata budget, and refuses a
    // family beyond `MAX_FAMILIES` or a series beyond
    // `MAX_SERIES_PER_FAMILY`. The freeze is the source's guarantee; the
    // validation is this module's, and it holds for a fabricated tuple a
    // bundled or test consumer substitutes.
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

  /**
   * Resolves a counter series, creating it on first request.
   *
   * IDEMPOTENT: the same name and the same labels always return the same
   * instance, whatever order the label names were written in.
   *
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

      const bounded =
        help.length > MAX_HELP_LENGTH ? help.slice(0, MAX_HELP_LENGTH) : help;

      if (bounded.length !== help.length) {
        this.reportRejection('metric help truncated', {
          metric: family.name,
          reason: 'helpTooLong',
          limit: MAX_HELP_LENGTH,
        });
      }

      if (!this.chargeMetadata(bounded.length - family.help.length)) {
        this.reportRejection('metric help rejected', {
          metric: family.name,
          reason: 'metadataBudgetReached',
          limit: MAX_METADATA_CHARS,
        });

        return;
      }

      family.help = bounded;
    } catch {
      this.reporterFaults += 1;
    }
  }

  /**
   * Counts one engine-event emission, and the turn, merge or insertion that
   * emission also stands for.
   *
   * ONE CALL PER EMISSION, NOT PER LISTENER. The emitter counts an emission
   * before it looks a listener up, so an event with no subscriber is emitted
   * and counted exactly like one with three, and nothing here varies with how
   * many listeners a run happens to have registered.
   *
   * `tile:merge` is emitted once per merge — js/game_manager.js L156-L170 was
   * entered once per merge inside the traversal — so a move that resolves two
   * merges calls this twice and the merge counter rises by two.
   *
   * `move:after` closes NO turn here and does not touch `turns_total`. It is
   * the completion signal of every turn that reached the walk, emitted with
   * `moved: false` for a turn that moved nothing, so counting emissions
   * over-reports turns by exactly the idle inputs. Turns that resolved arrive
   * through `recordTurnResolved`, from the engine's own
   * `engine.move.resolved` counter.
   *
   * `tile:spawn` stands for one tile INSERTED, and only when its payload
   * carries a position. It is not the spawn-attempt boundary and it does not
   * touch `spawn_attempts_total`: the engine returns before emitting on a full
   * board, so counting emissions would under-report attempts. Attempts arrive
   * through `recordSpawnAttempt` and suppressions through
   * `recordSpawnSuppressed`.
   */
  recordEngineEvent(event: EngineEventName, detail?: SpawnDetail): void {
    try {
      const counter = this.eventCounters.get(event);

      if (counter === undefined) {
        this.reportRejection('engine event rejected', {
          reason: 'unknownEvent',
          event: boundedLabel(event),
        });

        return;
      }

      counter.inc(1);

      if (event === 'tile:merge') {
        this.mergesCounter.inc(1);
      } else if (event === 'tile:spawn' && carriesSpawnPosition(detail)) {
        this.spawnsCounter.inc(1);
      }
    } catch {
      this.reporterFaults += 1;
    }
  }

  /**
   * Counts one engine-event emission from an emitter count report.
   *
   * THE EVENT DIMENSION IS THE ONLY ONE READ. `EngineCountReport` carries a
   * `hook` dimension and an `event` dimension and at most one of them; event
   * names were once reported under `hook`, which made an emission and a hook
   * dispatch indistinguishable to a consumer. So this reads `event`, and a
   * report that carries no `event` but names an engine event in `hook` is
   * refused and reported rather than folded under that hook.
   *
   * Equivalent to `recordEngineEvent` for the per-event and merge families, and
   * the path a wiring layer uses when it is handed reports rather than events.
   * It records no insertion and no turn, because a count report carries no
   * payload and no resolution: insertions arrive with the event through
   * `recordEngineEvent`, and turns that resolved arrive through
   * `recordTurnResolved` from the engine's `engine.move.resolved` counter. A
   * `move:after` report therefore raises the per-event family and nothing else —
   * the report cannot tell a turn that resolved from one that moved nothing.
   *
   * @param report One count report. `value` is the number of emissions it
   *   stands for, read as one when absent.
   */
  recordEngineEventCount(report: EngineEventCountView): void {
    try {
      if (typeof report !== 'object' || report === null) {
        this.reportRejection('engine event count rejected', {
          reason: 'notAnObject',
        });

        return;
      }

      const named: unknown = report.event;

      if (typeof named !== 'string' || named.length === 0) {
        this.reportRejection('engine event count rejected', {
          reason: this.namesAnEventInHookDimension(report)
            ? 'eventNameInHookDimension'
            : 'noEventDimension',
          hook: boundedLabel(report.hook),
        });

        return;
      }

      const counter = this.eventCounters.get(named);

      if (counter === undefined) {
        this.reportRejection('engine event count rejected', {
          reason: 'unknownEvent',
          event: boundedLabel(named),
        });

        return;
      }

      const value: unknown = report.value;
      const emissions = value === undefined ? 1 : value;

      if (
        !isFiniteNumber(emissions) ||
        emissions < 0 ||
        !Number.isInteger(emissions)
      ) {
        this.reportRejection('engine event count rejected', {
          reason: 'notANonNegativeInteger',
          event: boundedLabel(named),
        });

        return;
      }

      if (emissions === 0) {
        return;
      }

      counter.inc(emissions);

      if (named === 'tile:merge') {
        this.mergesCounter.inc(emissions);
      }
    } catch {
      this.reporterFaults += 1;
    }
  }

  /**
   * Counts one turn that resolved a move.
   *
   * THE AUTHORITATIVE TURN BOUNDARY, which is the engine's
   * `engine.move.resolved` counter, raised once per move that changed the board
   * immediately before the commit that ends it — the actuation push of
   * js/game_manager.js L182-L190, which sat inside that method's `if (moved)`
   * block. It is therefore the only feed `turns_total` has.
   *
   * The `move:after` event is NOT that boundary and does not reach this: the
   * engine emits it for every turn that reached the walk, carrying
   * `moved: false` for one that moved nothing, so a turn family fed from the
   * emission counts idle inputs — a press into a wall, a direction repeated on
   * a settled board — as turns and skews every rate derived from it.
   */
  recordTurnResolved(): void {
    try {
      this.turnsCounter.inc(1);
    } catch {
      this.reporterFaults += 1;
    }
  }

  /**
   * Counts one spawn attempt.
   *
   * THE AUTHORITATIVE ATTEMPT BOUNDARY, which is the engine's
   * `engine.spawn.attempt` counter raised on entry to the spawn —
   * js/game_manager.js L69 — and therefore the only feed
   * `spawn_attempts_total` has. Every attempt reaches it, including the
   * full-board one that emits no event.
   */
  recordSpawnAttempt(): void {
    try {
      this.spawnAttemptsCounter.inc(1);
    } catch {
      this.reporterFaults += 1;
    }
  }

  /**
   * Counts one spawn attempt that inserted no tile.
   *
   * The engine's `engine.spawn.suppressed` counter: a full board, or an
   * `onSpawn` handler that returned no usable cell. Attempts minus
   * suppressions is the number of tiles inserted, so this family and
   * `spawns_total` are two readings of one quantity and disagreeing is a
   * wiring fault rather than a game state.
   */
  recordSpawnSuppressed(): void {
    try {
      this.spawnSuppressedCounter.inc(1);
    } catch {
      this.reporterFaults += 1;
    }
  }

  /**
   * Whether a report with no `event` dimension names an engine event in its
   * `hook` dimension, which is the confusion this registry refuses.
   *
   * @param report Report being recorded.
   * @returns True when `hook` holds an `ENGINE_EVENT_NAMES` member.
   */
  private namesAnEventInHookDimension(report: EngineEventCountView): boolean {
    const carried: unknown = report.hook;

    return (
      typeof carried === 'string' && this.eventCounters.has(carried)
    );
  }

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

      this.dynamicSeries(this.spanHistograms, span, () =>
        this.histogramSeries(METRIC_NAMES.spanDurationMilliseconds, {
          [METRIC_LABELS.span]: span,
        }),
      ).observe(durationMs);
    } catch {
      this.reporterFaults += 1;
    }
  }

  /**
   * Writes one health verdict to `game2048_health_check_status`, labelled with
   * the check id.
   *
   * TWO OF THE THREE ENCODINGS THE SERIES CARRIES. This member takes a boolean
   * and so writes `1` or `0`; the third state, `-1` for a check the host offers
   * nothing to evaluate, is set directly on the same series by
   * `HealthSurface`, which owns the three-state verdict. The family's help text
   * declares all three, because a reader of the series sees all three.
   *
   * @param check Check id, carried as the series label. An empty value is
   *   reported and written nowhere.
   * @param healthy Whether the check passed.
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

      this.dynamicSeries(this.healthGauges, check, () =>
        this.gaugeSeries(METRIC_NAMES.healthCheckStatus, {
          [METRIC_LABELS.check]: check,
        }),
      ).set(healthy === true ? 1 : 0);
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
   *   Only the four members of `RNG_STREAM_NAMES` are folded; any other key
   *   is reported and folded nowhere, and an absent member is reported by
   *   the fold itself.
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

      // The CANONICAL TUPLE is iterated, not the caller's keys: the run has
      // exactly the four named substreams, and folding whatever keys a
      // caller happened to pass let an arbitrary name become a `stream`
      // label and a series of its own. The series itself is resolved through
      // the bounded per-stream cache rather than rebuilt on every fold.
      for (const stream of RNG_STREAM_NAMES) {
        const series = this.dynamicSeries(
          this.rngStreamCounters,
          stream,
          () =>
            this.counterSeries(METRIC_NAMES.rngDrawsTotal, {
              [METRIC_LABELS.stream]: stream,
            }),
        );

        this.foldAbsolute(
          series,
          foldKey(METRIC_NAMES.rngDrawsTotal, this.correlationId, stream),
          readCount(cursors, stream),
        );
      }

      for (const offered of Object.keys(cursors)) {
        if (!(RNG_STREAM_NAMES as readonly string[]).includes(offered)) {
          this.reportRejection('rng cursor rejected', {
            metric: METRIC_NAMES.rngDrawsTotal,
            reason: 'unknownStream',
            stream: offered.slice(0, MAX_LABEL_VALUE_LENGTH),
          });
        }
      }
    } catch {
      this.reporterFaults += 1;
    }
  }

  /**
   * Folds the hook bus's dispatch counts into the per-hook counter families.
   *
   * PULL, not push: the caller reads `HookBus.metrics()` and hands the result
   * here. src/engine imports nothing from this module.
   *
   * DL-METRIC-03.
   *
   * ABSOLUTE RECONCILIATION: the bus reports lifetime totals, so each counter
   * rises by the increase since the previous fold. Folding one snapshot twice
   * therefore adds nothing the second time, and a total that has fallen below
   * the previous reading — a fresh bus under the same registry — is read as
   * the whole of a new lifetime.
   *
   * IDENTIFIER RULE: a snapshot must carry a correlation identifier, and where
   * this registry holds one of its own the two must agree. A snapshot carrying
   * none, and a snapshot carrying a foreign one, are each reported and neither
   * is folded, so nothing this registry exports mixes runs. Decision
   * DL-METRIC-06.
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

      const source = this.resolveFoldSource(view);

      if (source === undefined) {
        return;
      }

      const hooks = table as Record<string, unknown>;

      for (const hook of HOOK_NAMES) {
        this.foldOneHook(hooks, hook, source);
      }
    } catch {
      this.reporterFaults += 1;
    }
  }

  /**
   * Projects the whole registry as plain JSON data.
   *
   * Every series present here is also present in `toPrometheusText()` under
   * the same name and labels, and no series appears in one and not the other.
   */
  snapshot(): MetricsSnapshot {
    const series: MetricSeriesSnapshot[] = [];

    try {
      for (const family of this.families.values()) {
        const help = this.helpOf(family);

        for (const entry of family.series.values()) {
          series.push(entry.toSnapshot(help));
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

  get prometheusText(): string {
    return this.toPrometheusText();
  }

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
   * layouts all survive, so the exported contract is unchanged. A fold after a
   * reset counts from the source's current total.
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

    if (name.length > MAX_METRIC_NAME_LENGTH) {
      this.reportRejection('metric name rejected', {
        metric: name.slice(0, MAX_METRIC_NAME_LENGTH),
        reason: 'nameTooLong',
        limit: MAX_METRIC_NAME_LENGTH,
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

    if (!this.reserveFamilyName(name, kind)) {
      return null;
    }

    if (!this.chargeMetadata(name.length)) {
      this.reportRejection('metric family rejected', {
        metric: name,
        reason: 'metadataBudgetReached',
        limit: MAX_METADATA_CHARS,
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

    if (kind === 'histogram') {
      for (const generated of generatedHistogramNames(name)) {
        this.reservedNames.set(generated, name);
      }
    }

    return family;
  }

  /**
   * Tests a new family's name against the sample names the histogram
   * families generate, in both directions.
   *
   * @param name Name being registered.
   * @param kind Kind being registered.
   * @returns `true` when the name is free, `false` when it was rejected and
   *   reported.
   */
  private reserveFamilyName(name: string, kind: MetricKind): boolean {
    // Forward: the name is one a registered histogram already generates.
    const owner = this.reservedNames.get(name);

    if (owner !== undefined) {
      this.reportRejection('metric family rejected', {
        metric: name,
        reason: 'nameGeneratedByHistogram',
        histogram: owner,
      });

      return false;
    }

    if (kind !== 'histogram') {
      // Reciprocal, for a non-histogram: a family named `x_bucket` is
      // free unless a histogram named `x` is registered, which the check
      // below covers for the histogram-first order and this one covers for
      // the reverse.
      const base = histogramBaseName(name);
      const collides = base !== null && this.families.get(base)?.kind;

      if (collides === 'histogram') {
        this.reportRejection('metric family rejected', {
          metric: name,
          reason: 'nameGeneratedByHistogram',
          histogram: base ?? '',
        });

        return false;
      }

      return true;
    }

    // Reciprocal, for a histogram: one of the names it would generate is
    // already a family of its own.
    for (const generated of generatedHistogramNames(name)) {
      if (this.families.has(generated)) {
        this.reportRejection('metric family rejected', {
          metric: name,
          reason: 'generatedNameCollision',
          generated,
        });

        return false;
      }
    }

    return true;
  }

  /**
   * Charges characters against the registry's metadata budget.
   *
   * @param chars Characters the caller wants to retain.
   * @returns `true` when the budget covered them, `false` when it did not.
   *   A refusal charges nothing.
   */
  private chargeMetadata(chars: number): boolean {
    if (this.metadataChars + chars > MAX_METADATA_CHARS) {
      return false;
    }

    this.metadataChars += chars;

    return true;
  }

  /**
   * Reads the help text a family is exported with.
   *
   * @param family Family to read.
   * @returns Its own text, or the deterministic derivation for a family
   *   that was never described.
   */
  private helpOf(family: MetricFamily): string {
    return family.help.length > 0
      ? family.help
      : deriveHelp(family.name, family.kind);
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

  private normaliseLabels(name: string, labels: LabelSet): LabelSet | null {
    const metric = typeof name === 'string' ? name : '';

    if (typeof labels !== 'object' || labels === null) {
      this.reportRejection('metric labels rejected', {
        metric,
        reason: 'notAnObject',
      });

      return null;
    }

    // SORTED, not in the caller's insertion order. The stored object's key
    // order is what `JSON.stringify` renders and what the snapshot carries,
    // so two callers writing the same labels in different orders used to
    // produce byte-different snapshots depending on which one created the
    // series first.
    const names = Object.keys(labels).sort();

    if (names.length > MAX_LABELS_PER_SERIES) {
      this.reportRejection('metric labels rejected', {
        metric,
        reason: 'tooManyLabels',
        limit: MAX_LABELS_PER_SERIES,
        offered: names.length,
      });

      return null;
    }

    const normalised: Record<string, string> = {};
    let chars = 0;

    for (const labelName of names) {
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

      if (labelName.length > MAX_LABEL_NAME_LENGTH) {
        this.reportRejection('metric label rejected', {
          metric,
          label: labelName.slice(0, MAX_LABEL_NAME_LENGTH),
          reason: 'labelNameTooLong',
          limit: MAX_LABEL_NAME_LENGTH,
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

      if (value.length > MAX_LABEL_VALUE_LENGTH) {
        this.reportRejection('metric label rejected', {
          metric,
          label: labelName,
          reason: 'labelValueTooLong',
          limit: MAX_LABEL_VALUE_LENGTH,
        });

        return null;
      }

      chars += labelName.length + value.length;
      normalised[labelName] = value;
    }

    if (!this.chargeMetadata(chars)) {
      this.reportRejection('metric labels rejected', {
        metric,
        reason: 'metadataBudgetReached',
        limit: MAX_METADATA_CHARS,
      });

      return null;
    }

    return Object.freeze(normalised);
  }

  /**
   * Builds an instance the registry does not store, and which every rejected
   * request returns in place of a stored one.
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

  private counterSeries(name: string, labels: LabelSet): MetricSeries {
    try {
      return this.resolveSeries(name, labels, 'counter', undefined);
    } catch {
      return this.detachedSeries(name, 'counter');
    }
  }

  /**
   * Resolves a gauge series as the internal implementation type.
   *
   * `gauge()` answers with the narrow `Gauge` view, which carries neither the
   * `detached` flag a cache decision reads nor an identity a cache can hold.
   *
   * @param name Family name.
   * @param labels Labels of the series.
   * @returns The series, or a detached instance.
   */
  private gaugeSeries(name: string, labels: LabelSet): MetricSeries {
    try {
      return this.resolveSeries(name, labels, 'gauge', undefined);
    } catch {
      return this.detachedSeries(name, 'gauge');
    }
  }

  /**
   * Resolves a histogram series as the internal implementation type.
   *
   * @param name Family name.
   * @param labels Labels of the series.
   * @returns The series, or a detached instance.
   */
  private histogramSeries(name: string, labels: LabelSet): MetricSeries {
    try {
      return this.resolveSeries(name, labels, 'histogram', undefined);
    } catch {
      return this.detachedSeries(name, 'histogram');
    }
  }

  /**
   * Reads a cached series, resolving it through the registry when the cache
   * does not hold it.
   */
  private cachedCounter(
    cache: Map<string, MetricSeries>,
    cacheKey: string,
    name: string,
    labels: LabelSet,
  ): MetricSeries {
    return cache.get(cacheKey) ?? this.counterSeries(name, labels);
  }

  /**
   * Reads a series for a dynamic identifier, resolving it once and holding it.
   *
   * `resolveSeries` validates the labels, copies and freezes them, builds a
   * family, then sorts and stringifies the label set into a lookup key — all
   * of it repeated on every call for a series that already exists. Holding
   * the resolved handle against the identifier itself skips that chain from
   * the second call onward and leaves the caller updating the handle
   * directly.
   *
   * The cache is bounded: once it holds `MAX_SERIES_PER_FAMILY` identifiers a
   * further one still resolves and records, but is not retained. Nothing is
   * cached for a detached series, so a rejected label set does not pin a
   * useless handle.
   *
   * @param cache Cache the handle is held in.
   * @param identifier Dynamic name, used as the cache key.
   * @param resolve Resolves the series on a miss.
   * @returns The series.
   */
  private dynamicSeries(
    cache: Map<string, MetricSeries>,
    identifier: string,
    resolve: () => MetricSeries,
  ): MetricSeries {
    const held = cache.get(identifier);

    if (held !== undefined) {
      return held;
    }

    const series = resolve();

    if (cache.size < MAX_SERIES_PER_FAMILY && !series.detached) {
      cache.set(identifier, series);
    }

    return series;
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
   * Reads the correlation identifier a fold's source carries, deciding
   * whether the snapshot may be folded at all.
   *
   * THE CORRELATION POLICY, in one place. A snapshot passes only when it
   * carries a non-empty identifier and, where this registry holds one of its
   * own, that identifier is the same. Everything else is reported and
   * refused. A registry constructed with no logger holds no identifier of its
   * own and cannot judge foreignness, so it accepts whichever identifier the
   * snapshot carries and namespaces the reconciliation by it.
   *
   * @param view Snapshot being folded.
   * @returns The source identifier, or `undefined` when the snapshot must not
   *   be folded.
   */
  private resolveFoldSource(
    view: HookDispatchCountsView,
  ): CorrelationId | undefined {
    const carried: unknown = view.correlationId;

    if (typeof carried !== 'string' || carried.length === 0) {
      this.reportRejection('hook dispatch fold rejected', {
        reason: 'noCorrelationId',
        registry: this.correlationId,
      });

      return undefined;
    }

    if (this.correlationId.length > 0 && carried !== this.correlationId) {
      this.reportRejection('hook dispatch fold rejected', {
        reason: 'foreignCorrelationId',
        registry: this.correlationId,
        source: boundedLabel(carried),
      });

      return undefined;
    }

    return carried;
  }

  /**
   * Folds one hook's counts out of the bus's `hooks` table.
   *
   * @param table The bus's `hooks` member.
   * @param hook Hook to fold.
   * @param source Correlation identifier of the bus that counted them,
   *   which namespaces every reconciliation key below.
   */
  private foldOneHook(
    table: Record<string, unknown>,
    hook: HookName,
    source: CorrelationId,
  ): void {
    const counters: unknown = table[hook];

    if (typeof counters !== 'object' || counters === null) {
      this.reportRejection('hook dispatch fold rejected', {
        hook,
        reason: 'missingHookCounters',
        source,
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
      foldKey(METRIC_NAMES.hookDispatchesTotal, source, hook),
      readCount(counters, DISPATCHED_MEMBER),
    );

    this.foldAbsolute(
      this.cachedCounter(
        this.hookInvocationCounters,
        hook,
        METRIC_NAMES.hookHandlerInvocationsTotal,
        hookLabels,
      ),
      foldKey(METRIC_NAMES.hookHandlerInvocationsTotal, source, hook),
      readCount(counters, INVOKED_MEMBER),
    );

    this.foldAbsolute(
      this.cachedCounter(
        this.hookErrorCounters,
        hook,
        METRIC_NAMES.relicHandlerErrorsTotal,
        hookLabels,
      ),
      foldKey(METRIC_NAMES.relicHandlerErrorsTotal, source, hook),
      readCount(counters, FAILED_MEMBER),
    );

    this.foldAbsolute(
      this.cachedCounter(
        this.hookRejectionCounters,
        hook,
        METRIC_NAMES.hookPayloadRejectionsTotal,
        hookLabels,
      ),
      foldKey(METRIC_NAMES.hookPayloadRejectionsTotal, source, hook),
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
        foldKey(
          METRIC_NAMES.hookHandlerSkippedTotal,
          source,
          `${hook}|${reason}`,
        ),
        readCount(counters, SKIP_REASON_MEMBER[reason]),
      );
    }
  }

  private writeFamily(family: MetricFamily, lines: string[]): void {
    // ONE HELP LINE PER FAMILY, ALWAYS. A family that was never described
    // used to emit `# TYPE` alone, so the snapshot's `help` and the
    // exposition disagreed for the same series; both now read `helpOf`.
    lines.push(`# HELP ${family.name} ${escapeHelp(this.helpOf(family))}`);
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
 */
export function createMetricsRegistry(
  options: MetricsRegistryOptions = {},
): MetricsRegistry {
  return new MetricsRegistry(options);
}
