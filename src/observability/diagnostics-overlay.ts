// The in-page diagnostics surface. AAP 0.2.4.7 and AAP 0.7.2.4.
//
// It renders six panels — the run identity, the six capability-probe results,
// the frame-time and turn-latency spans, the per-hook dispatch counts, the
// metric series with per-histogram quantiles, and the recent structured log
// records — and exports the Prometheus text and a combined JSON snapshot.
//
// The module writes to the registry in two places: the idempotent status gauge
// that carries each rendered health verdict into the exported snapshot, and
// the fold of the hook bus's dispatch counts taken ahead of each snapshot.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
// this module's area enumerated:
//   TR-DIAG-01  js/local_storage_manager.js   the construction-time capability
//               L25-L26                       probe, surfaced by the health
//                                             panel
//   TR-DIAG-02  js/html_actuator.js L13, L69  the two `requestAnimationFrame`
//                                             sites, summarised by the trace
//                                             panel
//   TR-DIAG-03  js/keyboard_input_manager.js  the subscriber registry, whose
//               L18-L32                       pull successors are the only
//                                             sources this module reads
//   TR-DIAG-04  style/main.scss L4-L22        the token block every style value
//                                             below resolves to
//   TR-DIAG-05  style/main.scss L217-L245     `.diagnostics-overlay:not([hidden])`,
//                                             restated by the inline
//                                             declarations from the same tokens
//   TR-DIAG-06  style/_themes.scss L552-L562  the three diagnostics custom
//                                             properties, each consumed with a
//                                             token fallback
//   TR-DIAG-07  index.html L105               `#diagnostics-overlay`, adopted
//                                             where the markup declares it
//   TR-DIAG-08  target-only row               the four panels, the Prometheus
//                                             text export and the combined JSON
//                                             snapshot
//
// Decisions: DL-DIAG-01, DL-DIAG-02, DL-DIAG-03, DL-DIAG-04, DL-DIAG-05,
// DL-DIAG-06 (docs/DECISION_LOG.md).

import type { HookBusMetrics, HookCounters } from '../engine/hook-bus';
import {
  boardBorderRadius,
  brightTextColor,
  derivedColors,
  fieldWidth,
  fontSizes,
  fontWeights,
  gameContainerBackground,
  gridSpacing,
  monospaceStack,
  paragraphLineHeight,
  tileBorderRadius,
  tileGoldColor,
  transitionSpeed,
  zIndex,
} from '../theme/tokens';
import type {
  HealthReport,
  HealthStatus,
  ReadinessReport,
} from './health';
import {
  HEALTH_CHECK_COUNT,
  HEALTH_CHECK_IDS,
  HEALTH_GAUGE_VALUES,
} from './health';
import type { LogRecord, Logger } from './logger';
import type {
  HistogramSeriesSnapshot,
  HookDispatchCountsView,
  MetricSeriesSnapshot,
  MetricsRegistry,
  MetricsSnapshot,
} from './metrics';
import { METRIC_LABELS, METRIC_NAMES } from './metrics';
import type { FrameTraceStats, SpanRecord, TraceSnapshot } from './tracer';
import { DEFAULT_FRAME_BUDGET_MS, SPAN_NAMES } from './tracer';

/** Selector a host is adopted from where the caller supplies none. */
export const DIAGNOSTICS_OVERLAY_SELECTOR = '#diagnostics-overlay';

const DIAGNOSTICS_HOST_ID = 'diagnostics-overlay';

/**
 * Query-string and fragment flag `isDiagnosticsRequested` reads. Absent means
 * off.
 */
export const DIAGNOSTICS_FLAG = 'diagnostics';

/** Flag values read as off. An absent value and an empty one read as on. */
const NEGATIVE_FLAG_VALUES: ReadonlySet<string> = new Set<string>([
  '0',
  'false',
  'off',
  'no',
]);

/** Leading `?` and `#` characters of a query string or fragment. */
const LEADING_DELIMITERS = /^[?#]+/;

const PAIR_SEPARATOR = /[&;]/;

/** `+` as a space, the form encoding a query string may carry. */
const ENCODED_SPACE = /\+/g;

/** Class the overlay's own root carries, styled by style/main.scss L226. */
const OVERLAY_CLASS = 'diagnostics-overlay';

/** Class every panel heading carries, styled by style/_screens.scss L535. */
const HEADING_CLASS = 'diagnostics-heading';

/** Class every panel table carries, styled by style/_screens.scss L541. */
const TABLE_CLASS = 'diagnostics-table';

const CONTROLS_CLASS = 'diagnostics-controls';

/** Class one control carries, shared with the screen-button vocabulary. */
const CONTROL_CLASS = 'screen-button';

// REMOVED: `CONTROL_SELECTOR`, the selector the control row's buttons were read
// back by after a render. Nothing reads them back now — the row and its five
// buttons are held from the one build. DL-DIAG-16.

/** Class a status cell carries, suffixed with the status it reports. */
const STATUS_CLASS = 'diagnostics-status';

/** Class the inline error line of a panel that failed to render carries. */
const PANEL_ERROR_CLASS = 'diagnostics-panel-error';

/**
 * ADDED: class a cell holding a sentence rather than a figure carries, styled
 * by style/_screens.scss.
 *
 * The sheet aligns every column but the first to the end, which is right for a
 * figure and wrong for prose: a health detail is a sentence and read from its
 * start. DL-DIAG-10.
 */
const PROSE_CLASS = 'diagnostics-prose';

const LOGGER_SUBSYSTEM = 'diagnostics';

const DEFAULT_HIDE_EMPTY = true;

/**
 * ADDED: families whose series are shown whatever they read.
 *
 * `hideEmpty` exists so the handful of series that moved are not buried by the
 * many a registry declares up front, and for an incidental family that is
 * right. It is wrong for these: the lifetime counters and the three canonically
 * enumerated dimensions — one series per engine event, one per hook, one per
 * RNG substream — are the skeleton a reader checks a reading AGAINST, and a
 * zero among them is the answer rather than the absence of one. Hiding them
 * left the panel empty of everything a fresh run is expected to show.
 * DL-DIAG-12.
 *
 * Gauges are retained by kind rather than by name: a gauge at zero is a
 * reading, and `health_check_status` at zero means UNHEALTHY, so hiding it hid
 * precisely the check an operator opened the surface to see.
 */
const CORE_METRIC_FAMILIES: ReadonlySet<string> = new Set<string>([
  METRIC_NAMES.turnsTotal,
  METRIC_NAMES.mergesTotal,
  METRIC_NAMES.spawnsTotal,
  METRIC_NAMES.spawnAttemptsTotal,
  METRIC_NAMES.spawnSuppressedTotal,
  METRIC_NAMES.framesRenderedTotal,
  METRIC_NAMES.metricsRejectedTotal,
  METRIC_NAMES.engineEventsTotal,
  METRIC_NAMES.hookDispatchesTotal,
  METRIC_NAMES.rngDrawsTotal,
]);

/** Quantiles reported for every histogram family. */
const REPORTED_QUANTILES: readonly number[] = Object.freeze([0.5, 0.95, 0.99]);

const DEFAULT_LOG_LIMIT = 25;

const DEFAULT_SPAN_LIMIT = 12;

const PERCENT_SCALE = 100;

const SHORT_ID_LENGTH = 8;

/**
 * Separator between the correlation identifier and the counter in a span
 * identifier.
 */
const SPAN_ID_SEPARATOR = '#';

/**
 * Characters of the correlation identifier kept in front of a span's counter.
 */
const SPAN_ID_TAIL_LENGTH = 4;

/** Prefix marking a rendered identifier as having had its head elided. */
const ELISION = '…';

/** Decimal places a fractional millisecond figure is rendered to. */
const MILLISECOND_PRECISION = 3;

const JSON_INDENT = 2;

const JSON_MEDIA_TYPE = 'application/json;charset=utf-8';

/** Rendered in a cell that has no value. */
const MISSING_VALUE = '—';

/** Cadence the scheduled refresh runs at while the overlay is shown, in ms. */
const DEFAULT_REFRESH_INTERVAL_MS = transitionSpeed * 10;

/** Filename the combined snapshot downloads under. */
export const DEFAULT_DIAGNOSTICS_SNAPSHOT_FILENAME =
  'game2048-diagnostics.json';

/** Version the combined snapshot envelope carries. */
export const DIAGNOSTICS_SNAPSHOT_SCHEMA_VERSION = 1;

// Every style value below is a token of src/theme/tokens.ts or a custom
// property style/_themes.scss publishes; none is a literal.

/** Custom property style/_themes.scss L560 publishes for the surface. */
const SURFACE_PROPERTY = '--theme-diagnostics-surface';

/** Custom property style/_themes.scss L561 publishes for the text. */
const TEXT_PROPERTY = '--theme-diagnostics-text';

/** Custom property style/_themes.scss L556 publishes for the accent. */
const ACCENT_PROPERTY = '--theme-diagnostics-accent';

/**
 * ADDED: the two custom properties style/_themes.scss L421-L422 publishes for
 * the accessible control pair, which `@mixin screen-control` of
 * style/_screens.scss L191 and L195 already resolves for every other
 * `.screen-button`.
 *
 * The controls below carry that same class and were nevertheless painted from
 * two literals, because an inline declaration outranks the sheet — so the two
 * additive palettes were dead on this surface alone. DL-DIAG-09.
 */
const CONTROL_SURFACE_PROPERTY = '--theme-control-surface';

const CONTROL_LABEL_PROPERTY = '--theme-control-label';

/**
 * Numerator and denominator of `math.div($field-width * 4, 5)`, the inline
 * size style/main.scss declares for the surface.
 *
 * CHANGED from three fifths, in step with that declaration. This pair is a
 * MIRROR of the stylesheet and the inline style it builds OUTRANKS the sheet,
 * so widening the sheet alone left the surface at its old width and the change
 * entirely dead. tests/unit/quality/stylesheet-contract.test.ts now pins the
 * two halves equal so the mirror cannot drift again. DL-DIAG-08.
 */
const HOST_WIDTH_NUMERATOR = 4;

const HOST_WIDTH_DENOMINATOR = 5;

/**
 * Divisor applied to `$grid-spacing` for the inner gap and control padding.
 */
const SPACING_DIVISOR = 2;

/** Half of `$grid-spacing`, in px. */
const HALF_GRID_SPACING = gridSpacing / SPACING_DIVISOR;

/**
 * Composes a custom-property reference with a token fallback.
 *
 * @param property Custom property style/_themes.scss publishes.
 * @param fallback Token value used where no palette is active.
 * @returns The `var` expression.
 */
function themed(property: string, fallback: string): string {
  return `var(${property}, ${fallback})`;
}

/** Inline declarations the host carries, in kebab-case. */
const HOST_STYLE: Readonly<Record<string, string>> = Object.freeze({
  position: 'fixed',
  'inset-block-end': `${gridSpacing}px`,
  'inset-inline-start': `${gridSpacing}px`,
  'z-index': `${zIndex.diagnosticsOverlay}`,
  'box-sizing': 'border-box',
  'inline-size': `${
    (fieldWidth * HOST_WIDTH_NUMERATOR) / HOST_WIDTH_DENOMINATOR
  }px`,
  'max-inline-size': `calc(100% - ${gridSpacing * SPACING_DIVISOR}px)`,
  'max-block-size': `calc(100% - ${gridSpacing * SPACING_DIVISOR}px)`,
  overflow: 'auto',
  padding: `${gridSpacing}px`,
  'border-radius': `${boardBorderRadius}px`,
  'flex-direction': 'column',
  gap: `${HALF_GRID_SPACING}px`,
  'font-family': monospaceStack,
  'font-size': `${fontSizes.scoreLabel.desktop}px`,
  'line-height': `${paragraphLineHeight}`,
  color: themed(TEXT_PROPERTY, brightTextColor),
  background: themed(SURFACE_PROPERTY, derivedColors.focusRingColor),
});

/** `display` of the shown host. */
const HOST_SHOWN_DISPLAY = 'flex';

/** `display` of the hidden host. */
const HOST_HIDDEN_DISPLAY = 'none';

/**
 * ADDED: the declaration `applyVisibility` writes, as a removal key.
 *
 * It is deliberately NOT a member of `HOST_STYLE`: that table is applied whole,
 * and `display` alternates with the hidden state. Naming it here is what lets
 * the release remove it, which is the property a released host used to keep.
 * Only the key is read; the value stands for the shown state. DL-DIAG-14.
 */
const HOST_VISIBILITY_STYLE: Readonly<Record<string, string>> = Object.freeze({
  display: HOST_SHOWN_DISPLAY,
});

/**
 * Width of the control's edge: `math.div($tile-border-radius, 3)`, the
 * derivation `$a11y-hairline` of style/_a11y.scss L36 is written from.
 */
const CONTROL_BORDER_DIVISOR = 3;

const CONTROL_BORDER_WIDTH = tileBorderRadius / CONTROL_BORDER_DIVISOR;

/**
 * Smallest block size of a control, as a multiple of `$grid-spacing`.
 *
 * Three units is 45px, which clears the 44px pointer-target size WCAG 2.5.5
 * states; the sheet's own `block-size` of 40px is the used value below it, and
 * `min-block-size` raises it without restating that number here. DL-DIAG-09.
 */
const CONTROL_MIN_BLOCK_UNITS = 3;

/**
 * Inline declarations a control carries, from `@mixin screen-control`.
 *
 * CHANGED: the surface and the label resolve the two custom properties every
 * other `.screen-button` resolves, so an additive palette reaches this surface
 * too, and the token literals are the FALLBACKS rather than the values. The two
 * that were declared here — the retained `buttonBackground` and
 * `brightTextColor` — measure 3.79:1 against one another, which is the frozen
 * ratio of AAP 0.5.2 and below WCAG 2.1 AA for 13px bold text; the control pair
 * they are replaced by measures 4.73:1 in the default palette and above 11:1 in
 * both additive ones.
 *
 * CHANGED from `border: none`: the control pair is a fill that sits between
 * 1.40:1 and 2.35:1 against the diagnostics surface, so a borderless control
 * would have no discernible boundary on the panel. The edge resolves the
 * surface's own text colour, which measures at least 11:1 against the panel and
 * at least 4.73:1 against the fill, so the control's shape is identifiable in
 * every palette as WCAG 1.4.11 requires. DL-DIAG-09.
 */
const CONTROL_STYLE: Readonly<Record<string, string>> = Object.freeze({
  background: themed(
    CONTROL_SURFACE_PROPERTY,
    derivedColors.controlSurfaceBackground,
  ),
  color: themed(CONTROL_LABEL_PROPERTY, brightTextColor),
  border: `${CONTROL_BORDER_WIDTH}px solid ${themed(
    TEXT_PROPERTY,
    brightTextColor,
  )}`,
  'border-radius': `${tileBorderRadius}px`,
  padding: `${HALF_GRID_SPACING}px`,
  'min-block-size': `${gridSpacing * CONTROL_MIN_BLOCK_UNITS}px`,
  font: 'inherit',
  'font-weight': `${fontWeights.bold}`,
  cursor: 'pointer',
});

/** Inline declarations the control row carries. */
const CONTROLS_STYLE: Readonly<Record<string, string>> = Object.freeze({
  display: 'flex',
  'flex-wrap': 'wrap',
  gap: `${HALF_GRID_SPACING}px`,
});

/** Inline declarations a panel heading carries. */
const HEADING_STYLE: Readonly<Record<string, string>> = Object.freeze({
  margin: '0',
  color: themed(ACCENT_PROPERTY, tileGoldColor),
  'font-size': 'inherit',
  'font-weight': `${fontWeights.bold}`,
});

/** Inline declarations a panel table carries. */
const TABLE_STYLE: Readonly<Record<string, string>> = Object.freeze({
  'inline-size': '100%',
  'border-collapse': 'collapse',
  'table-layout': 'fixed',
});

/** Inline declarations a table cell carries. */
const CELL_STYLE: Readonly<Record<string, string>> = Object.freeze({
  padding: `0 ${HALF_GRID_SPACING}px 0 0`,
  'vertical-align': 'top',

  // CHANGED from `anywhere`, which broke every string at whatever character
  // reached the cell edge — so a health detail read "Function .protoy pe.bind
  // is present." `break-word` wraps an ordinary word whole at its spaces and
  // breaks only a token longer than its own line. The min-content contribution
  // `anywhere` was reducing is irrelevant under the `table-layout: fixed` this
  // table already sets. DL-DIAG-08.
  'overflow-wrap': 'break-word',
});

/**
 * ADDED: inline size of each stated column, narrowest first.
 *
 * Under `table-layout: fixed` the columns divide the table evenly unless a
 * width is stated, which gave the column holding one short status word the same
 * room as the column holding a sentence. Stating the first two hands the whole
 * remainder to the third: the prose column's usable width goes from roughly
 * 64px to roughly 160px. A column past the end of this list is unstated and
 * takes an equal share of what is left. DL-DIAG-08.
 */
const COLUMN_INLINE_SIZES: readonly string[] = Object.freeze(['34%', '20%']);

/**
 * ADDED: inline declarations a prose cell carries, mirroring the sheet rule
 * `PROSE_CLASS` resolves.
 *
 * Written inline as well as in the sheet for the same reason every other style
 * in this module is: the surface is applied by this module and must read
 * correctly with no stylesheet loaded at all. DL-DIAG-10.
 */
const PROSE_CELL_STYLE: Readonly<Record<string, string>> = Object.freeze({
  'text-align': 'start',
});

/** Inline declarations the inline error line of a failed panel carries. */
const PANEL_ERROR_STYLE: Readonly<Record<string, string>> = Object.freeze({
  margin: '0',
  color: themed(ACCENT_PROPERTY, tileGoldColor),
  'font-weight': `${fontWeights.bold}`,
});

/** How one health status is rendered. */
interface StatusPresentation {
  /** Text of the status cell. */
  readonly label: string;

  /** Inline declarations the status cell carries. */
  readonly style: Readonly<Record<string, string>>;
}

/**
 * The three states of `HealthStatus`, each with its own label, colour, weight
 * and slant.
 */
const STATUS_PRESENTATION: Readonly<Record<HealthStatus, StatusPresentation>> =
  Object.freeze({
    pass: {
      label: 'healthy',
      style: Object.freeze({
        color: themed(TEXT_PROPERTY, brightTextColor),
        'font-weight': `${fontWeights.regular}`,
        'font-style': 'normal',
      }),
    },
    fail: {
      label: 'UNHEALTHY',
      style: Object.freeze({
        color: themed(ACCENT_PROPERTY, tileGoldColor),
        'font-weight': `${fontWeights.bold}`,
        'font-style': 'normal',
      }),
    },
    'not-applicable': {
      label: 'not-applicable',
      style: Object.freeze({
        color: gameContainerBackground,
        'font-weight': `${fontWeights.light}`,
        'font-style': 'italic',
      }),
    },
  });

/**
 * One capability probe's result in the shape the health panel reads: a name, a
 * verdict and a description. `HealthProbeView` of src/observability/health.ts
 * satisfies it.
 */
export interface HealthCheckResult {
  /** Stable name of the probe, as `'webgl'`. */
  readonly name: string;

  /**
   * The three-state status, read in PREFERENCE to `healthy` wherever a
   * provider carries it. `HealthProbeView` of src/observability/health.ts
   * does.
   *
   * Optional, so a provider written against the boolean shape alone still
   * satisfies this contract; such a provider cannot express
   * `'not-applicable'`, and its `healthy` is read instead.
   */
  readonly status?: HealthStatus;

  /** Whether the capability is present. `false` only for a failure. */
  readonly healthy: boolean;

  /** What was observed, shown beside the verdict. */
  readonly detail?: string;
}

/** A source of probe views, read afresh on every render. */
export type HealthProvider = () => readonly HealthCheckResult[];

/**
 * The two members the health panel reads off a health surface. `HealthSurface`
 * of src/observability/health.ts satisfies it.
 */
export interface HealthSurfaceView {
  /** The report carrying one result per `HEALTH_CHECK_IDS` member. */
  report(): HealthReport;

  /** The readiness verdicts derived from that report. */
  readiness(): ReadinessReport;
}

/** Either health source the panel accepts, discriminated at runtime. */
export type HealthSource = HealthProvider | HealthSurfaceView;

/**
 * The one member the trace panel reads off a tracer. `Tracer` of
 * src/observability/tracer.ts satisfies it.
 */
export interface TracerView {
  /** The frame statistics and the retained span records. */
  snapshot(limit?: number): TraceSnapshot;
}

/**
 * A reader of the hook bus's dispatch counts. `HookBus.metrics` of
 * src/engine/hook-bus.ts satisfies it.
 */
export type HookCountsReader = () => HookDispatchCountsView;

/**
 * A reader of the RNG substreams' draw cursors. `snapshotCursors()` of
 * src/rng/rng-streams.ts satisfies it, and takes no draw.
 */
export type RngCursorsReader = () => Readonly<Record<string, number>>;

/** The two members `isDiagnosticsRequested` reads off a location. */
export interface DiagnosticsRequestSource {
  /** Query string, with or without its leading `?`. */
  readonly search?: string | undefined;

  /** Fragment, with or without its leading `#`. */
  readonly hash?: string | undefined;
}

/** One health row, as the panel renders it and the snapshot carries it. */
export interface DiagnosticsHealthRow {
  /** The check id, one of `HEALTH_CHECK_IDS` where the source reported it. */
  readonly id: string;
  readonly status: HealthStatus;
  readonly detail: string;
}

/** One hook's dispatch counts, as the panel renders them. */
export interface DiagnosticsHookRow {
  /** The hook name, one of the six the bus counts. */
  readonly hook: string;
  readonly dispatched: number;
  readonly invoked: number;

  /** Exhausted, degraded and detached skips summed. */
  readonly skipped: number;
  readonly rejected: number;
  readonly failed: number;
}

/** The health section of the combined snapshot. */
export interface DiagnosticsHealthSection {
  /** Roll-up over `checks`, `null` where no health source is attached. */
  readonly status: HealthStatus | null;
  readonly checks: readonly DiagnosticsHealthRow[];

  /** How many rows carry each status. */
  readonly counts: Readonly<Record<HealthStatus, number>>;

  /** The report verbatim, `null` for a probe-view source or no source. */
  readonly report: HealthReport | null;

  /** The readiness verdicts, `null` for a probe-view source or no source. */
  readonly readiness: ReadinessReport | null;
}

/**
 * The combined snapshot the export control writes and
 * docs/dashboards/dashboard.html renders: the four sections named by AAP
 * 0.6.2.7 — health, traces, metrics and logs — plus the hook counts.
 */
export interface DiagnosticsSnapshot {
  readonly schemaVersion: number;
  readonly correlationId: string;

  /** Wall-clock time of the metrics snapshot it was built from, ISO 8601. */
  readonly generatedAt: string;
  readonly health: DiagnosticsHealthSection;

  /** The tracer's snapshot, `null` where no tracer is attached. */
  readonly traces: TraceSnapshot | null;
  readonly hooks: readonly DiagnosticsHookRow[];
  readonly metrics: MetricsSnapshot;
  /**
   * The recent log records, as the logger's `snapshot` export surface reports
   * them: in every stack, the locations of the three forms DL-LOG-08 enumerates
   * are replaced, and in every message the further forms DL-LOG-10 enumerates,
   * whatever the logger's own `errorDetail` is.
   */
  readonly logs: readonly LogRecord[];
}

/** What `createDiagnosticsOverlay` accepts. */
export interface DiagnosticsOverlayOptions {
  /** The registry to read. */
  readonly metrics: MetricsRegistry;

  /**
   * The logger whose recent records the log panel shows, read through its
   * `snapshot` export surface so every record rendered and exported carries
   * redacted stack locations.
   */
  readonly logger?: Logger;

  /**
   * Host element, already resolved. `null` disables the overlay, and `mount`
   * creates nothing for it.
   */
  readonly host?: Element | null;

  /** Selector a host is adopted from where none is supplied. */
  readonly selector?: string;

  /** Document the lookup and the element creation run against. */
  readonly document?: Document | null;

  /** Supplies the health results: a probe reader or a health surface. */
  readonly health?: HealthSource;

  /** Supplies the frame statistics and span records. */
  readonly tracer?: TracerView;

  /**
   * Supplies the hook bus's dispatch counts, folded into the registry before
   * each snapshot and rendered by the hook panel. Pull only: the bus is never
   * asked to push.
   */
  readonly hookCounts?: HookCountsReader;

  /**
   * Supplies the RNG substreams' draw cursors, folded into the registry before
   * every read this surface answers — the combined snapshot and the Prometheus
   * text alike. Pull only, and non-consuming: reading a cursor takes no draw.
   *
   * The composition root also folds the cursors on each committed state, so
   * this reader is what keeps a read taken BETWEEN two commits current rather
   * than the only feed the family has.
   */
  readonly rngCursors?: RngCursorsReader;

  /** Whether zero-valued series are hidden. Defaults to `true`. */
  readonly hideEmpty?: boolean;

  readonly logLimit?: number;

  readonly spanLimit?: number;

  /**
   * Cadence of the scheduled refresh while the overlay is shown, in ms.
   * Defaults to ten times `$transition-speed`.
   */
  readonly refreshIntervalMs?: number;

  readonly snapshotFilename?: string;
}

/** The overlay a caller holds. */
export interface DiagnosticsOverlay {
  /**
   * Whether a host is resolved and `destroy` has not been called.
   *
   * A PROPERTY, and the only member of this interface that is not a method:
   * read it as `overlay.available`, never as `overlay.available()`, which
   * throws because a boolean is not callable. A TypeScript caller is told so by
   * the type; a console session is told so here.
   */
  readonly available: boolean;

  /**
   * Resolves a host and applies the token-derived styles. Where the markup
   * declares none, one is created on `document.body`, or on
   * `document.documentElement` where the document carries no body.
   *
   * @returns Whether a host is available afterwards.
   */
  mount(): boolean;

  isOpen(): boolean;

  /** Shows the overlay, renders it and starts the scheduled refresh. */
  open(): void;

  /** Hides the overlay and stops the scheduled refresh. */
  close(): void;

  /** Shows or hides it, and returns whether it is now shown. */
  toggle(): boolean;

  /** Re-renders from a fresh reading. A no-op while closed. */
  refresh(): void;

  /** The metrics snapshot the last render read, or `null` before the first. */
  lastSnapshot(): MetricsSnapshot | null;

  /**
   * The Prometheus text of the current registry state.
   *
   * @returns The exposition, or the empty string after `destroy`.
   */
  toPrometheusText(): string;

  /**
   * A freshly built combined snapshot. Requires no open overlay.
   *
   * @returns The snapshot. After `destroy`, an empty envelope carrying no
   *   correlation identifier and no source, read from nothing.
   */
  snapshot(): DiagnosticsSnapshot;

  /**
   * The combined snapshot as indented JSON.
   *
   * @returns The JSON of the reading, and the EMPTY STRING after `destroy`.
   */
  snapshotJson(): string;

  /**
   * Downloads the Prometheus text through the registry's own exporter.
   *
   * @returns Whether the download was started. `false` after `destroy`,
   *   which creates no object URL and clicks nothing.
   */
  exportPrometheusText(): boolean;

  /**
   * Downloads the combined snapshot as JSON. Any object URL it creates is
   * revoked before the call returns.
   *
   * @returns Whether the download was started. `false` after `destroy`,
   *   which creates no object URL and clicks nothing.
   */
  exportSnapshotJson(): boolean;

  /**
   * Hides the overlay, stops the scheduled refresh, releases every listener it
   * bound, removes a host this module created, empties one it adopted, drops
   * the held metrics snapshot, and releases every source it was given.
   * Idempotent.
   */
  destroy(): void;
}

/**
 * Decodes one query-string component.
 *
 * @param text Raw component.
 * @returns The decoded component, or `text` where it cannot be decoded.
 */
function decodeComponent(text: string): string {
  try {
    return decodeURIComponent(text.replace(ENCODED_SPACE, ' '));
  } catch {
    return text;
  }
}

/**
 * Reads one flag out of a query string or a fragment.
 *
 * @param text Query string or fragment, with or without its delimiter.
 * @param flag Flag name to find.
 * @returns The flag's value, the empty string for a bare flag, or `null`
 *   where the flag is absent.
 */
function readFlag(text: string, flag: string): string | null {
  const body = text.replace(LEADING_DELIMITERS, '');

  if (body.length === 0) {
    return null;
  }

  for (const pair of body.split(PAIR_SEPARATOR)) {
    if (pair.length === 0) {
      continue;
    }

    const separator = pair.indexOf('=');
    const name = separator === -1 ? pair : pair.slice(0, separator);

    // ADDED: the NAME is matched case-insensitively and untrimmed whitespace
    // is ignored, which is how the VALUE has always been read below. The two
    // halves of one flag disagreeing was a trap: `?DIAGNOSTICS` read as absent
    // while `?diagnostics=OFF` read as off. DL-DIAG-13.
    if (decodeComponent(name).trim().toLowerCase() !== flag.toLowerCase()) {
      continue;
    }

    return separator === -1 ? '' : decodeComponent(pair.slice(separator + 1));
  }

  return null;
}

/**
 * Resolves the location the flag is read from.
 *
 * @param supplied Source the caller supplied. `null` means read nothing.
 * @returns The source, or `null` where there is none.
 */
function resolveRequestSource(
  supplied: DiagnosticsRequestSource | null | undefined,
): DiagnosticsRequestSource | null {
  if (supplied !== undefined) {
    return supplied;
  }

  const candidate: unknown = (globalThis as { location?: unknown }).location;

  if (typeof candidate !== 'object' || candidate === null) {
    return null;
  }

  const view = candidate as { search?: unknown; hash?: unknown };

  return {
    search: typeof view.search === 'string' ? view.search : undefined,
    hash: typeof view.hash === 'string' ? view.hash : undefined,
  };
}

/**
 * Whether the session asked for the diagnostics surface.
 *
 * Reads no storage, mutates nothing and throws for no input.
 *
 * @param source Location to read. Defaults to `globalThis.location`; pass
 *   `null` to read nothing, which always answers `false`.
 * @returns Whether the overlay was requested.
 * @example
 * if (isDiagnosticsRequested()) {
 *   overlay.mount();
 *   overlay.open();
 * }
 */
export function isDiagnosticsRequested(
  source?: DiagnosticsRequestSource | null,
): boolean {
  try {
    const resolved = resolveRequestSource(source);

    if (resolved === null) {
      return false;
    }

    for (const text of [resolved.search, resolved.hash]) {
      if (typeof text !== 'string') {
        continue;
      }

      const value = readFlag(text, DIAGNOSTICS_FLAG);

      if (value === null) {
        continue;
      }

      return !NEGATIVE_FLAG_VALUES.has(value.trim().toLowerCase());
    }

    return false;
  } catch {
    return false;
  }
}

interface Cell {
  readonly text: string;
  readonly className?: string;
  readonly style?: Readonly<Record<string, string>>;
}

type Row = readonly (string | Cell)[];

/** The six hook names, as `HookBusMetrics` declares them. */
type HookDispatchName = keyof HookBusMetrics['hooks'];

/** The six hooks in dispatch order, from src/engine/hooks.ts `HOOK_NAMES`. */
const HOOK_DISPATCH_ORDER: readonly HookDispatchName[] = Object.freeze([
  'onStageStart',
  'onBeforeMove',
  'onMerge',
  'onSpawn',
  'onAfterMove',
  'onStageEnd',
]);

/**
 * Resolves the document a lookup and an element creation run against.
 *
 * @param supplied Document the caller supplied, if any.
 * @returns The document, or `null` where there is none.
 */
function resolveDocument(
  supplied: Document | null | undefined,
): Document | null {
  if (supplied !== undefined && supplied !== null) {
    return supplied;
  }

  const candidate: unknown = (globalThis as { document?: unknown }).document;

  return typeof candidate === 'object' && candidate !== null
    ? (candidate as Document)
    : null;
}

/**
 * Whether a value carries the element surface this module reads.
 *
 * @param value Value to test.
 * @returns Whether the value can be treated as the host element.
 */
function isElementLike(value: unknown): value is Element {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Partial<Element>;

  return (
    typeof candidate.setAttribute === 'function' &&
    typeof candidate.hasAttribute === 'function' &&
    typeof candidate.querySelectorAll === 'function'
  );
}

/**
 * Whether a value is an element with an inline style declaration.
 *
 * @param value Value to test.
 * @returns Whether it carries a `style` object.
 */
function hasInlineStyle(
  value: Element,
): value is Element & ElementCSSInlineStyle {
  const candidate = (value as Partial<ElementCSSInlineStyle>).style;

  return typeof candidate === 'object' && candidate !== null;
}

/**
 * Applies inline declarations to an element.
 *
 * @param element Element to style.
 * @param declarations Kebab-case declarations to apply.
 */
function applyStyle(
  element: Element,
  declarations: Readonly<Record<string, string>>,
): void {
  if (!hasInlineStyle(element)) {
    return;
  }

  const style = element.style;

  for (const property of Object.keys(declarations)) {
    try {
      style.setProperty(property, declarations[property] ?? '');
    } catch {
      // A property the host rejects is left unset.
    }
  }
}

/**
 * Removes inline declarations from an element.
 *
 * @param element Element to unstyle.
 * @param declarations Kebab-case declarations to remove.
 */
function removeStyle(
  element: Element,
  declarations: Readonly<Record<string, string>>,
): void {
  if (!hasInlineStyle(element)) {
    return;
  }

  const style = element.style;

  for (const property of Object.keys(declarations)) {
    try {
      style.removeProperty(property);
    } catch {
      // A property the host rejects is left as it stands.
    }
  }
}

function clear(element: Element): void {
  while (element.firstChild !== null) {
    element.removeChild(element.firstChild);
  }
}

/**
 * ADDED: removes an attribute that has been emptied.
 *
 * `classList.remove` of the last class leaves `class=""` behind, and clearing
 * every declaration leaves `style=""`, so a released host carried two empty
 * attributes it had never carried before the surface adopted it. An attribute
 * that still holds something is left exactly as it stands. DL-DIAG-14.
 *
 * @param element Element to tidy.
 * @param name Attribute to drop when empty.
 */
function dropEmptyAttribute(element: Element, name: string): void {
  try {
    if (element.getAttribute(name) === '') {
      element.removeAttribute(name);
    }
  } catch {
    // A host that refuses the read or the removal keeps the attribute.
  }
}

/**
 * @param element Element to test.
 * @returns Whether it is hidden.
 */
function isHidden(element: Element): boolean {
  const candidate = (element as Partial<HTMLElement>).hidden;

  if (typeof candidate === 'boolean') {
    return candidate;
  }

  // Read only where it is callable. `applyVisibility` reaches this from
  // outside the guard `setHidden` wraps its own writes in, so a node without
  // the attribute reader raised out of `open` from here.
  return typeof element.hasAttribute === 'function'
    ? element.hasAttribute('hidden')
    : false;
}

/**
 * Renders a number without inventing precision it does not have.
 *
 * @param value Value to render.
 * @returns The rendered value.
 */
function renderNumber(value: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return MISSING_VALUE;
  }

  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(MILLISECOND_PRECISION);
}

/**
 * Renders a label set as a compact suffix.
 *
 * @param labels Labels to render.
 * @returns The suffix, empty where there are none.
 */
function renderLabels(labels: Readonly<Record<string, string>>): string {
  const entries = Object.entries(labels);

  if (entries.length === 0) {
    return '';
  }

  return entries.map(([key, value]) => `${key}="${value}"`).join(' ');
}

/**
 * Whether a series carries anything worth showing.
 *
 * @param series Series to test.
 * @returns Whether it is non-empty.
 */
function hasValue(series: MetricSeriesSnapshot): boolean {
  if (series.kind === 'histogram') {
    return series.count > 0;
  }

  return series.value !== 0;
}

/**
 * ADDED: whether a series is shown whatever it reads.
 *
 * @param series Series to test.
 * @returns Whether the series belongs to the panel's skeleton. DL-DIAG-12.
 */
function isCoreSeries(series: MetricSeriesSnapshot): boolean {
  return series.kind === 'gauge' || CORE_METRIC_FAMILIES.has(series.name);
}

/**
 * Renders the summary line of one series.
 *
 * @param series Series to render.
 * @returns The rendered value.
 */
function renderSeriesValue(series: MetricSeriesSnapshot): string {
  if (series.kind !== 'histogram') {
    return renderNumber(series.value);
  }

  return `n=${renderNumber(series.count)} sum=${renderNumber(series.sum)}`;
}

/**
 * Renders the quantiles of one histogram off the snapshot's own buckets, so
 * the figure and the series it came from describe one instant.
 *
 * @param series Histogram to render.
 * @returns The rendered quantiles, empty for an unobserved histogram.
 */
function renderQuantiles(series: HistogramSeriesSnapshot): string {
  if (series.count <= 0) {
    return '';
  }

  return REPORTED_QUANTILES.map((quantile): string => {
    const label = `p${Math.round(quantile * PERCENT_SCALE)}`;
    const target = quantile * series.count;

    // `bucketCounts` is CUMULATIVE and aligned to `buckets`: element `i`
    // counts every observation at or below `buckets[i]`, so the bucket a rank
    // falls in is the first whose count reaches it.
    for (let index = 0; index < series.buckets.length; index += 1) {
      const cumulative = series.bucketCounts[index] ?? 0;

      if (cumulative >= target) {
        return `${label}<=${renderNumber(series.buckets[index] ?? 0)}`;
      }
    }

    return `${label}=+Inf`;
  }).join(' ');
}

/**
 * Finds one histogram family in a snapshot.
 *
 * @param snapshot Snapshot to search.
 * @param name Family name to find.
 * @returns The first series of that family, or `null` where it holds none.
 */
function findHistogram(
  snapshot: MetricsSnapshot,
  name: string,
): HistogramSeriesSnapshot | null {
  for (const series of snapshot.series) {
    if (series.kind === 'histogram' && series.name === name) {
      return series;
    }
  }

  return null;
}

/**
 * Counts the observations of a histogram above a bound, off its cumulative
 * bucket counts.
 *
 * @param series Histogram to read.
 * @param bound Inclusive upper bound to count above.
 * @returns Observations above `bound`.
 */
function countAbove(series: HistogramSeriesSnapshot, bound: number): number {
  for (let index = 0; index < series.buckets.length; index += 1) {
    if ((series.buckets[index] ?? 0) === bound) {
      return series.count - (series.bucketCounts[index] ?? 0);
    }
  }

  return series.infCount;
}

/**
 * Renders a span identifier short enough for a fixed-layout table while
 * keeping the segment that makes it unique.
 *
 * @param id Identifier to render, or `undefined` for a root span.
 * @returns The shortened identifier, or the missing-value marker.
 */
function shortId(id: string | undefined): string {
  if (typeof id !== 'string' || id.length === 0) {
    return MISSING_VALUE;
  }

  if (id.length <= SHORT_ID_LENGTH) {
    return id;
  }

  const separator = id.lastIndexOf(SPAN_ID_SEPARATOR);

  // No separator: an identifier this module did not shape, truncated from the
  // front as before.
  if (separator <= 0 || separator === id.length - 1) {
    return `${id.slice(0, SHORT_ID_LENGTH)}${ELISION}`;
  }

  const head = id.slice(0, separator);
  const counter = id.slice(separator);
  const tail =
    head.length <= SPAN_ID_TAIL_LENGTH
      ? head
      : `${ELISION}${head.slice(-SPAN_ID_TAIL_LENGTH)}`;

  return `${tail}${counter}`;
}

/**
 * Narrows an unvalidated member to one of the three health statuses.
 *
 * @param value Member to test, from a provider this module does not own.
 * @returns `true` when it is one of the three.
 */
function isHealthStatus(value: unknown): value is HealthStatus {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(HEALTH_GAUGE_VALUES, value)
  );
}

/**
 * Reads a count off an unvalidated counter member.
 *
 * @param value Member to read.
 * @returns The finite count, or zero.
 */
function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Reads one hook's counters out of a dispatch-count view, which may be
 * fabricated or partial.
 *
 * @param view View to read.
 * @param hook Hook to read.
 * @returns The counters, or `null` where the view carries none.
 */
function readCounters(
  view: HookDispatchCountsView,
  hook: HookDispatchName,
): HookCounters | null {
  const hooks: unknown = view.hooks;

  if (typeof hooks !== 'object' || hooks === null) {
    return null;
  }

  const candidate: unknown = (hooks as Record<string, unknown>)[hook];

  return typeof candidate === 'object' && candidate !== null
    ? (candidate as HookCounters)
    : null;
}

/**
 * Folds a dispatch-count view into one row per hook, all six present whether
 * or not the view carries them.
 *
 * @param view View to fold.
 * @returns The six rows, in dispatch order.
 */
function hookRowsOf(
  view: HookDispatchCountsView,
): readonly DiagnosticsHookRow[] {
  return HOOK_DISPATCH_ORDER.map((hook): DiagnosticsHookRow => {
    const counters = readCounters(view, hook);

    return {
      hook,
      dispatched: countOf(counters?.dispatched),
      invoked: countOf(counters?.invoked),
      skipped:
        countOf(counters?.skippedExhausted) +
        countOf(counters?.skippedDegraded) +
        countOf(counters?.skippedDetached),
      rejected: countOf(counters?.rejected),
      failed: countOf(counters?.failed),
    };
  });
}

const RUN_PANEL_TITLE = 'Run';

const HEALTH_PANEL_TITLE = 'Health';

const TRACE_PANEL_TITLE = 'Traces';

const HOOK_PANEL_TITLE = 'Hooks';

const METRICS_PANEL_TITLE = 'Metrics';

const LOG_PANEL_TITLE = 'Recent records';

/**
 * ADDED: titles the metrics panel, stating what it is not showing.
 *
 * A count alone — "60 of 120 series" — left a reader to guess what the other
 * 60 were and whether they had been lost. The heading now names the reason
 * they are absent and says where they are, so the panel can be read without
 * the export beside it. DL-DIAG-12.
 *
 * @param shown Series the panel renders.
 * @param total Series the reading holds.
 * @returns The panel title.
 */
function metricsPanelTitle(shown: number, total: number): string {
  const hidden = total - shown;

  if (hidden <= 0) {
    return `${METRICS_PANEL_TITLE} (${shown} series)`;
  }

  return (
    `${METRICS_PANEL_TITLE} (${shown} of ${total} series, ` +
    `${hidden} at zero hidden here and exported)`
  );
}

const OVERLAY_TITLE = 'Diagnostics';

const HOST_LABEL = 'Diagnostics';

const CONTROLS_LABEL = 'Diagnostics controls';

const EMPTY_PANEL_TEXT = 'Nothing recorded.';

const PANEL_ERROR_TEXT = 'This panel failed to render.';

const PROVIDER_FAILURE_NAME = 'health';

const PROVIDER_FAILURE_DETAIL = 'the provider threw';

/** Detail a check the source did not report is rendered with. */
const UNREPORTED_CHECK_DETAIL = 'The source reported no result.';

/** Name a probe view carrying no usable name is rendered under. */
const UNNAMED_CHECK = 'unnamed';

const NO_BUS_TEXT = 'not attached';

const NO_TRACER_TEXT = 'not attached';

const REFRESH_CONTROL_LABEL = 'Refresh';

const METRICS_EXPORT_CONTROL_LABEL = 'Export metrics';

const SNAPSHOT_EXPORT_CONTROL_LABEL = 'Export snapshot';

const CLOSE_CONTROL_LABEL = 'Close diagnostics';

/**
 * ADDED: the two labels of the compact-mode control, which renders the surface
 * as its heading and its control row alone.
 *
 * The surface is a fixed panel at the top of the layering ladder AAP 0.6.4
 * states, so at a narrow width it covers the board and the on-screen controls
 * beneath it and a pointer click lands on the panel. Collapsing it is the
 * recovery that keeps the surface open — `CLOSE_CONTROL_LABEL` above is the
 * other, and it takes the readings away with it. A viewport-width rule was the
 * alternative and is not available: the footprint is an inline style, which
 * outranks the sheet, and a second breakpoint is outside the two-scale
 * responsive strategy AAP 0.5.5 fixes. DL-DIAG-11.
 */
const COLLAPSE_CONTROL_LABEL = 'Collapse diagnostics';

const EXPAND_CONTROL_LABEL = 'Expand diagnostics';

/**
 * ADDED: position of the collapse control in the row, counting from the first.
 *
 * The row is built once, so the control is held from that build; the position is
 * read there and nowhere else. DL-DIAG-16.
 */
const COLLAPSE_CONTROL_POSITION = 3;

/** Attribute the host carries while the surface is collapsed. */
const COLLAPSED_ATTRIBUTE = 'data-collapsed';

/**
 * ADDED: attribute the host publishes its refresh state under, `live` while the
 * scheduled render is running and `paused` while the surface holds the keyboard
 * focus and the schedule is standing off.
 *
 * The pause is deliberate and predates this attribute; what was missing was any
 * way to SEE it. A reader watching the figures stop had nothing to distinguish
 * "paused because I am focused here" from "the surface has died", and read the
 * stop as the latter. DL-DIAG-15.
 */
const REFRESH_ATTRIBUTE = 'data-refresh';

/** `REFRESH_ATTRIBUTE` while the scheduled render is running. */
const REFRESH_LIVE = 'live';

/** `REFRESH_ATTRIBUTE` while the schedule is standing off. */
const REFRESH_PAUSED = 'paused';

/**
 * Appended to the surface's own heading while the schedule is paused, so the
 * state is legible on screen and not only in the DOM. DL-DIAG-15.
 */
const PAUSED_TITLE_SUFFIX = ' — paused while focused';

const PANEL_FAILURE_MESSAGE = 'A diagnostics panel failed to render.';

const MOUNT_SKIPPED_MESSAGE = 'The diagnostics surface did not mount.';

const EXPORT_SKIPPED_MESSAGE = 'The diagnostics export was unavailable.';

/** Inline declarations the download anchor carries. */
const ANCHOR_STYLE: Readonly<Record<string, string>> = Object.freeze({
  display: 'none',
});

const EMPTY_HEALTH_ROWS: readonly DiagnosticsHealthRow[] = Object.freeze([]);

const ZERO_STATUS_COUNTS: Readonly<Record<HealthStatus, number>> =
  Object.freeze({
    pass: 0,
    fail: 0,
    'not-applicable': 0,
  });

/**
 * The metrics section of a snapshot taken while the registry was unreadable.
 */
const UNAVAILABLE_METRICS: MetricsSnapshot = Object.freeze({
  schemaVersion: 0,
  correlationId: '',
  generatedAt: '',
  elapsedMs: 0,
  rejected: 0,
  reporterFaults: 0,
  series: Object.freeze([]) as readonly MetricSeriesSnapshot[],
});

/** Hook rows of a snapshot carrying none. */
const EMPTY_HOOK_ROWS: readonly DiagnosticsHookRow[] = Object.freeze([]);

/** Log records of a snapshot carrying none. */
const EMPTY_LOG_RECORDS: readonly LogRecord[] = Object.freeze([]);

/** What a DESTROYED overlay reports from `snapshot`. */
const INERT_DIAGNOSTICS_SNAPSHOT: DiagnosticsSnapshot = Object.freeze({
  schemaVersion: 0,
  correlationId: '',
  generatedAt: '',
  health: Object.freeze({
    status: null,
    checks: EMPTY_HEALTH_ROWS,
    counts: ZERO_STATUS_COUNTS,
    report: null,
    readiness: null,
  }),
  traces: null,
  hooks: EMPTY_HOOK_ROWS,
  metrics: UNAVAILABLE_METRICS,
  logs: EMPTY_LOG_RECORDS,
});

/**
 * Counts the statuses of a row set.
 *
 * @param rows Rows to count.
 * @returns The per-status counts.
 */
function countsOf(
  rows: readonly DiagnosticsHealthRow[],
): Readonly<Record<HealthStatus, number>> {
  const counts: Record<HealthStatus, number> = {
    pass: 0,
    fail: 0,
    'not-applicable': 0,
  };

  for (const row of rows) {
    counts[row.status] += 1;
  }

  return counts;
}

/**
 * Rolls a row set up, by the rule `HealthReport.status` states: a failure
 * anywhere fails, every row inapplicable is inapplicable, and anything else
 * passes.
 *
 * @param rows Rows to roll up.
 * @returns The roll-up, or `null` for an empty set.
 */
function rollUpOf(
  rows: readonly DiagnosticsHealthRow[],
): HealthStatus | null {
  if (rows.length === 0) {
    return null;
  }

  const counts = countsOf(rows);

  if (counts.fail > 0) {
    return 'fail';
  }

  return counts['not-applicable'] === rows.length ? 'not-applicable' : 'pass';
}

/**
 * Resolves a positive integer limit.
 *
 * @param supplied Value the caller supplied.
 * @param fallback Value used where none was.
 * @returns The limit.
 */
function limitOf(supplied: number | undefined, fallback: number): number {
  if (typeof supplied !== 'number' || !Number.isFinite(supplied)) {
    return fallback;
  }

  return supplied < 0 ? 0 : Math.floor(supplied);
}

/**
 * Resolves the scheduled-refresh cadence. A non-finite or negative value
 * leaves the overlay refreshing on demand only.
 *
 * @param supplied Value the caller supplied.
 * @returns The cadence in ms, or zero for no schedule.
 */
function intervalOf(supplied: number | undefined): number {
  if (supplied === undefined) {
    return DEFAULT_REFRESH_INTERVAL_MS;
  }

  if (typeof supplied !== 'number' || !Number.isFinite(supplied)) {
    return 0;
  }

  return supplied <= 0 ? 0 : supplied;
}

/**
 * Builds the diagnostics surface.
 *
 * Construction adopts a host where the markup declares one and reads nothing
 * else: no snapshot is taken and no element is created until `mount`, `open`,
 * `refresh` or one of the export members runs.
 *
 * @param options The registry to read, the sources to read beside it, and
 *   where to mount.
 * @returns The overlay.
 * @example
 * const overlay = createDiagnosticsOverlay({ metrics, logger, tracer });
 *
 * if (isDiagnosticsRequested()) {
 *   overlay.mount();
 *   overlay.open();
 * }
 */
export function createDiagnosticsOverlay(
  options: DiagnosticsOverlayOptions,
): DiagnosticsOverlay {
  const owner = resolveDocument(options.document);
  // Settled at the boundary. `host` is declared as `Element | null`, and a
  // value that is neither was adopted as the host and then raised out of the
  // first member that read a DOM member off it.
  const explicitHost: Element | null | undefined =
    options.host === undefined
      ? undefined
      : isElementLike(options.host)
        ? options.host
        : null;
  const selector = options.selector ?? DIAGNOSTICS_OVERLAY_SELECTOR;
  const metrics = options.metrics;
  const logger = options.logger ?? null;
  // RELEASABLE, not `const`: `destroy` nulls all three, so a retained handle
  // cannot reach a health probe, a tracer or the hook bus after disposal, even
  // by way of a member that was overlooked.
  let healthSource: HealthSource | null = options.health ?? null;
  let tracer: TracerView | null = options.tracer ?? null;
  let hookCounts: HookCountsReader | null = options.hookCounts ?? null;
  let rngCursors: RngCursorsReader | null = options.rngCursors ?? null;
  const hideEmpty = options.hideEmpty ?? DEFAULT_HIDE_EMPTY;
  const logLimit = limitOf(options.logLimit, DEFAULT_LOG_LIMIT);
  const spanLimit = limitOf(options.spanLimit, DEFAULT_SPAN_LIMIT);
  const refreshIntervalMs = intervalOf(options.refreshIntervalMs);
  const snapshotFilename =
    typeof options.snapshotFilename === 'string' &&
    options.snapshotFilename.length > 0
      ? options.snapshotFilename
      : DEFAULT_DIAGNOSTICS_SNAPSHOT_FILENAME;

  /** Records are emitted through a child tagged `'diagnostics'`. */
  const panelLogger = ((): Logger | null => {
    if (logger === null) {
      return null;
    }

    try {
      return logger.child(LOGGER_SUBSYSTEM);
    } catch {
      return logger;
    }
  })();

  /**
   * Listeners this module added, with the node and the event type they were
   * added for.
   *
   * ADDED: the type travels with the entry. Every listener was a `click` until
   * the focus tracking of DL-DIAG-17 needed two more types, and a release that
   * assumed `click` would have left them attached. DL-DIAG-17.
   */
  const listeners: {
    readonly node: EventTarget;
    readonly type: string;
    readonly handler: EventListener;
  }[] = [];

  let destroyed = false;
  let shown = false;
  let lastMetrics: MetricsSnapshot | null = null;
  let host: Element | null = null;
  let createdHost: Element | null = null;
  let timer: number | null = null;

  /**
   * ADDED: whether the surface is rendering as its heading and control row
   * alone. Starts expanded, so a session that never touches the control sees
   * the surface it saw before. DL-DIAG-11.
   */
  let collapsed = false;

  /**
   * ADDED: the surface's own heading, built once and never replaced, so the
   * refresh state can be written to it without a render. DL-DIAG-15,
   * DL-DIAG-16.
   */
  let headingNode: Element | null = null;

  /**
   * ADDED: the control row, built once and never detached, so a control keeps
   * its identity, its listener and its focus across a render. DL-DIAG-16.
   */
  let controlRow: Element | null = null;

  /** ADDED: the collapse control, relabelled in place. DL-DIAG-16. */
  let collapseControl: HTMLElement | null = null;

  /** ADDED: the panel nodes now on screen, replaced by the next render. */
  let panelNodes: Element[] = [];

  /**
   * ADDED: the element OUTSIDE the host that last held the keyboard focus, and
   * the one focus returns to when the surface closes.
   *
   * Tracked continuously rather than captured at open, because the case that
   * matters is a keyboard user who tabbed in from the game while the surface
   * was already open: their position is where focus was a moment ago, not where
   * it was when the flag mounted the surface. DL-DIAG-17.
   */
  let focusOrigin: Element | null = null;

  /** ADDED: whether the document-level focus listeners are installed. */
  let focusTracked = false;

  /**
   * Records a contained failure.
   *
   * @param panel Panel or operation the failure occurred in.
   * @param thrown The caught value.
   */
  const reportFailure = (panel: string, thrown: unknown): void => {
    if (panelLogger === null) {
      return;
    }

    try {
      panelLogger.failure('error', PANEL_FAILURE_MESSAGE, {
        thrown,
        fields: { panel },
      });
    } catch {
      // A logger that throws is contained here.
    }
  };

  /**
   * Records a step this module declined to take.
   *
   * @param message Message to record.
   * @param reason Machine-readable reason.
   */
  const reportSkipped = (message: string, reason: string): void => {
    if (panelLogger === null) {
      return;
    }

    try {
      panelLogger.debug(message, { reason });
    } catch {
      // A logger that throws is contained here.
    }
  };

  /**
   * Looks the host up. A selector the host rejects resolves to nothing.
   *
   * @returns The element, or `null`.
   */
  const queryHost = (): Element | null => {
    if (owner === null) {
      return null;
    }

    try {
      return owner.querySelector(selector);
    } catch {
      return null;
    }
  };

  /**
   * Sets the host's `display` from its hidden state: `none` while hidden and
   * `flex` while shown.
   *
   * @param element Element to synchronise.
   */
  const applyVisibility = (element: Element): void => {
    applyStyle(element, {
      display: isHidden(element) ? HOST_HIDDEN_DISPLAY : HOST_SHOWN_DISPLAY,
    });
  };

  /**
   * Hides or shows an element by property where it has one and by attribute
   * otherwise.
   *
   * @param element Element to change.
   * @param hidden Whether it is hidden afterwards.
   */
  const setHidden = (element: Element, hidden: boolean): void => {
    const view = element as Partial<HTMLElement>;

    try {
      if (typeof view.hidden === 'boolean') {
        view.hidden = hidden;
      } else if (hidden) {
        element.setAttribute('hidden', '');
      } else {
        element.removeAttribute('hidden');
      }
    } catch (thrown) {
      reportFailure(HOST_LABEL, thrown);
    }

    applyVisibility(element);
  };

  /**
   * Applies the class, the ARIA treatment and the token-derived styles.
   *
   * The host carries no `aria-live`: src/ui/a11y/live-region.ts is the game's
   * only announcement path, and this surface is outside it.
   *
   * @param element Host to prepare.
   */
  const prepareHost = (element: Element): void => {
    try {
      element.classList.add(OVERLAY_CLASS);
      element.setAttribute('role', 'region');
      element.setAttribute('aria-label', HOST_LABEL);
      applyStyle(element, HOST_STYLE);
      applyVisibility(element);
    } catch (thrown) {
      reportFailure(HOST_LABEL, thrown);
    }
  };

  /** Removes the class, the ARIA treatment and the token-derived styles. */
  const releaseHost = (element: Element): void => {
    try {
      clear(element);
      element.classList.remove(OVERLAY_CLASS);
      element.removeAttribute('role');
      element.removeAttribute('aria-label');

      // ADDED: the state attribute a collapsed surface published. DL-DIAG-11.
      element.removeAttribute(COLLAPSED_ATTRIBUTE);

      // ADDED: and the one the refresh state publishes. DL-DIAG-15.
      element.removeAttribute(REFRESH_ATTRIBUTE);
      removeStyle(element, HOST_STYLE);

      // ADDED: `display` is written by `applyVisibility` and is NOT a member of
      // HOST_STYLE, so the removal above left it behind — a released host kept
      // `display: none`, which is inert only because `mount` writes it again.
      // DL-DIAG-14.
      removeStyle(element, HOST_VISIBILITY_STYLE);

      // ADDED: and neither emptied attribute is left on a host that carried
      // neither before. DL-DIAG-14.
      dropEmptyAttribute(element, 'style');
      dropEmptyAttribute(element, 'class');
    } catch (thrown) {
      reportFailure(HOST_LABEL, thrown);
    }
  };

  /**
   * Builds one element. Text is assigned through `textContent`, so a value
   * carrying markup renders as the characters it is made of.
   *
   * @param tag Tag to create.
   * @param className Class to apply, or the empty string for none.
   * @param text Text content, or the empty string for none.
   * @returns The element, or `null` where there is no document.
   */
  const make = (
    tag: string,
    className = '',
    text = '',
  ): HTMLElement | null => {
    if (owner === null) {
      return null;
    }

    try {
      const created = owner.createElement(tag);

      if (className !== '') {
        created.className = className;
      }

      if (text !== '') {
        created.textContent = text;
      }

      return created;
    } catch {
      return null;
    }
  };

  /**
   * Appends one cell to a row.
   *
   * @param line Row the cell is appended to.
   * @param value Cell text, or the cell.
   * @param column Zero-based position of the cell in its row, which selects the
   *   stated inline size. ADDED for DL-DIAG-08.
   */
  const appendCell = (
    line: Node,
    value: string | Cell,
    column: number,
  ): void => {
    const cell: Cell = typeof value === 'string' ? { text: value } : value;
    const node = make('td', cell.className ?? '');

    if (node === null) {
      return;
    }

    node.textContent = cell.text === '' ? MISSING_VALUE : cell.text;
    applyStyle(node, CELL_STYLE);

    // ADDED. Written on every row's cell rather than the first row's alone:
    // under `table-layout: fixed` the first row governs, so the later ones are
    // inert, and a panel whose first row failed to build still states its
    // columns. A cell's own `style` below still overrides this. DL-DIAG-08.
    const stated = COLUMN_INLINE_SIZES[column];

    if (stated !== undefined) {
      applyStyle(node, { 'inline-size': stated });
    }

    if (cell.style !== undefined) {
      applyStyle(node, cell.style);
    }

    line.appendChild(node);
  };

  /**
   * Appends a heading and a table of rows.
   *
   * @param parent Node the section is appended to.
   * @param title Heading text.
   * @param rows Rows, each a list of cells.
   */
  const section = (
    parent: Node,
    title: string,
    rows: readonly Row[],
  ): void => {
    const heading = make('h2', HEADING_CLASS, title);

    if (heading !== null) {
      applyStyle(heading, HEADING_STYLE);
      parent.appendChild(heading);
    }

    if (rows.length === 0) {
      const empty = make('p', '', EMPTY_PANEL_TEXT);

      if (empty !== null) {
        parent.appendChild(empty);
      }

      return;
    }

    const table = make('table', TABLE_CLASS);
    const body = make('tbody');

    if (table === null || body === null) {
      return;
    }

    applyStyle(table, TABLE_STYLE);

    for (const row of rows) {
      const line = make('tr');

      if (line === null) {
        continue;
      }

      for (const [column, value] of row.entries()) {
        appendCell(line, value, column);
      }

      body.appendChild(line);
    }

    table.appendChild(body);
    parent.appendChild(table);
  };

  /**
   * Appends one panel, containing its own failure: a row builder that throws
   * degrades to an error line inside the panel and stops no other panel.
   *
   * @param parent Node the panel is appended to.
   * @param title Heading text.
   * @param build Builds the rows.
   */
  const panel = (
    parent: Node,
    title: string,
    build: () => readonly Row[],
  ): void => {
    let rows: readonly Row[];

    try {
      rows = build();
    } catch (thrown) {
      reportFailure(title, thrown);

      const heading = make('h2', HEADING_CLASS, title);

      if (heading !== null) {
        applyStyle(heading, HEADING_STYLE);
        parent.appendChild(heading);
      }

      const line = make('p', PANEL_ERROR_CLASS, PANEL_ERROR_TEXT);

      if (line !== null) {
        applyStyle(line, PANEL_ERROR_STYLE);
        parent.appendChild(line);
      }

      return;
    }

    section(parent, title, rows);
  };

  /**
   * Builds one control and registers its listener for release.
   *
   * @param label Accessible name and text of the control.
   * @param action What the control does.
   * @param expanded Disclosure state to publish as `aria-expanded`, for a
   *   control that shows and hides content. Omitted for one that does not.
   *   ADDED for DL-DIAG-11.
   * @returns The control, or `null` where there is no document.
   */
  const control = (
    label: string,
    action: () => void,
    expanded?: boolean,
  ): HTMLElement | null => {
    const node = make('button', CONTROL_CLASS, label);

    if (node === null) {
      return null;
    }

    const button = node as Partial<HTMLButtonElement>;

    if (typeof button.type === 'string') {
      button.type = 'button';
    }

    applyStyle(node, CONTROL_STYLE);

    if (expanded !== undefined) {
      try {
        node.setAttribute('aria-expanded', String(expanded));
      } catch (thrown) {
        reportFailure(label, thrown);
      }
    }

    const handler: EventListener = (): void => {
      try {
        action();
      } catch (thrown) {
        reportFailure(label, thrown);
      }
    };

    try {
      node.addEventListener('click', handler);
      listeners.push({ node, type: 'click', handler });
    } catch (thrown) {
      reportFailure(label, thrown);
    }

    return node;
  };

  /**
   * Whether the keyboard focus is inside the host.
   *
   * @returns Whether the host contains the active element.
   */
  const holdsFocus = (): boolean => {
    if (host === null || owner === null) {
      return false;
    }

    try {
      const active = owner.activeElement;

      return active !== null && active !== host && host.contains(active);
    } catch {
      return false;
    }
  };

  /**
   * ADDED: whether an element is outside the host.
   *
   * @param candidate Element to test.
   * @returns Whether the host neither is it nor contains it. DL-DIAG-17.
   */
  const isOutsideHost = (candidate: Element): boolean =>
    host === null || (candidate !== host && !host.contains(candidate));

  /**
   * ADDED: remembers an element outside the host as the place focus returns to.
   *
   * @param candidate The element that took the focus. DL-DIAG-17.
   */
  const rememberFocusOrigin = (candidate: unknown): void => {
    if (!isElementLike(candidate) || !isOutsideHost(candidate)) {
      return;
    }

    // The body is where focus lands when it is dropped rather than moved, so it
    // is not a position worth returning to.
    if (candidate === owner?.body) {
      return;
    }

    focusOrigin = candidate;
  };

  /**
   * ADDED: returns the focus to the element it came from, and reports whether
   * it went.
   *
   * @returns Whether focus was moved. DL-DIAG-17.
   */
  const restoreFocusOrigin = (): boolean => {
    const target = focusOrigin;

    if (target === null || owner === null) {
      return false;
    }

    try {
      // A remembered element that has since left the document is not focused:
      // the surface must not move the focus to a detached node.
      if (!owner.contains(target)) {
        focusOrigin = null;

        return false;
      }

      const focusable = target as Partial<HTMLElement>;

      if (typeof focusable.focus !== 'function') {
        return false;
      }

      focusable.focus();

      return owner.activeElement === target;
    } catch (thrown) {
      reportFailure(HOST_LABEL, thrown);

      return false;
    }
  };

  /**
   * ADDED: installs the document-level focus tracking, once.
   *
   * `focusin` and `focusout` bubble, where `focus` and `blur` do not, so one
   * listener pair on the document sees every move. They are installed on the
   * first `show` rather than at construction, which reads nothing and touches
   * nothing outside the host it adopts. DL-DIAG-15, DL-DIAG-17.
   */
  const trackFocus = (): void => {
    if (focusTracked || owner === null) {
      return;
    }

    const onFocusIn: EventListener = (event: Event): void => {
      rememberFocusOrigin(event.target);

      // The pause the schedule takes while the surface holds the focus is
      // published the moment it begins, not on the render that never comes.
      if (shown && !destroyed) {
        publishRefreshState(holdsFocus());
      }
    };

    const onFocusOut: EventListener = (): void => {
      if (!shown || destroyed) {
        return;
      }

      // Read AFTER the move has settled: a `focusout` fires before the next
      // element takes the focus, so the active element is only reliable a task
      // later. The immediate render is what makes the pause self-healing —
      // leaving the surface brings it current at once rather than up to one
      // cadence later.
      const settle = globalThis.setTimeout;

      if (typeof settle !== 'function') {
        publishRefreshState(holdsFocus());

        return;
      }

      settle((): void => {
        if (!shown || destroyed) {
          return;
        }

        if (holdsFocus()) {
          publishRefreshState(true);

          return;
        }

        render();
      }, 0);
    };

    try {
      owner.addEventListener('focusin', onFocusIn);
      listeners.push({ node: owner, type: 'focusin', handler: onFocusIn });
      owner.addEventListener('focusout', onFocusOut);
      listeners.push({ node: owner, type: 'focusout', handler: onFocusOut });
      focusTracked = true;
    } catch (thrown) {
      reportFailure(HOST_LABEL, thrown);
    }
  };

  // REMOVED: `focusedControlIndex` and `restoreControlFocus`, which recorded
  // the focused control's POSITION before a render and moved focus back to
  // whatever node occupied that position afterwards. Both existed only because
  // a render replaced the control nodes; the control row of DL-DIAG-16 is never
  // detached, so the node that holds the focus still holds it after a render
  // and there is nothing to chase.

  /** Removes every listener this module added. */
  const releaseListeners = (): void => {
    while (listeners.length > 0) {
      const entry = listeners.pop();

      if (entry === undefined) {
        continue;
      }

      try {
        entry.node.removeEventListener(entry.type, entry.handler);
      } catch {
        // A node that refuses the removal is discarded with its subtree.
      }
    }
  };

  // Every source below is read through its own pull accessor; none pushes.

  /**
   * Writes one verdict to the status gauge. `'pass'` and `'fail'` go through
   * the registry's own recorder.
   *
   * @param check Check id the verdict belongs to.
   * @param status The verdict.
   */
  const recordVerdict = (check: string, status: HealthStatus): void => {
    try {
      if (status === 'not-applicable') {
        metrics
          .gauge(METRIC_NAMES.healthCheckStatus, {
            [METRIC_LABELS.check]: check,
          })
          .set(HEALTH_GAUGE_VALUES[status]);

        return;
      }

      metrics.recordHealthCheck(check, status === 'pass');
    } catch (thrown) {
      reportFailure(HEALTH_PANEL_TITLE, thrown);
    }
  };

  /**
   * Appends a row for every check id the source did not report, so all six of
   * `HEALTH_CHECK_IDS` are present whatever the source returned.
   *
   * @param rows Rows to extend.
   * @param reported Ids the source reported.
   */
  const appendUnreported = (
    rows: DiagnosticsHealthRow[],
    reported: ReadonlySet<string>,
  ): void => {
    for (const id of HEALTH_CHECK_IDS) {
      if (reported.has(id)) {
        continue;
      }

      rows.push({
        id,
        status: 'not-applicable',
        detail: UNREPORTED_CHECK_DETAIL,
      });

      // RECORDED like every other rendered row. Appending the row without its
      // gauge left the panel showing a check the export carried no series for,
      // so the two disagreed about a check nobody reported.
      recordVerdict(id, 'not-applicable');
    }
  };

  /**
   * Reads a probe-view source: a boolean verdict per probe.
   *
   * @param provider Source to read.
   * @returns The health section.
   */
  const readProbeViews = (
    provider: HealthProvider,
  ): DiagnosticsHealthSection => {
    let views: readonly HealthCheckResult[];

    try {
      views = provider();
    } catch (thrown) {
      reportFailure(HEALTH_PANEL_TITLE, thrown);
      views = [
        {
          name: PROVIDER_FAILURE_NAME,
          healthy: false,
          detail: PROVIDER_FAILURE_DETAIL,
        },
      ];
    }

    const rows: DiagnosticsHealthRow[] = [];
    const reported = new Set<string>();

    for (const view of Array.isArray(views) ? views : []) {
      if (typeof view !== 'object' || view === null) {
        continue;
      }

      const name =
        typeof view.name === 'string' && view.name.length > 0
          ? view.name
          : UNNAMED_CHECK;

      // The three-state status wins over the boolean.
      const status: HealthStatus = isHealthStatus(view.status)
        ? view.status
        : view.healthy === false
          ? 'fail'
          : 'pass';

      rows.push({
        id: name,
        status,
        detail: typeof view.detail === 'string' ? view.detail : '',
      });
      reported.add(name);
      recordVerdict(name, status);
    }

    appendUnreported(rows, reported);

    return {
      status: rollUpOf(rows),
      checks: rows,
      counts: countsOf(rows),
      report: null,
      readiness: null,
    };
  };

  /**
   * Reads a health surface: the three-state report and the readiness verdicts.
   *
   * @param surface Source to read.
   * @returns The health section.
   */
  const readHealthSurface = (
    surface: HealthSurfaceView,
  ): DiagnosticsHealthSection => {
    let report: HealthReport | null = null;

    try {
      report = surface.report();
    } catch (thrown) {
      reportFailure(HEALTH_PANEL_TITLE, thrown);
    }

    let readiness: ReadinessReport | null = null;

    try {
      readiness = surface.readiness();
    } catch (thrown) {
      reportFailure(HEALTH_PANEL_TITLE, thrown);
    }

    const rows: DiagnosticsHealthRow[] = [];
    const reported = new Set<string>();

    if (report === null) {
      rows.push({
        id: PROVIDER_FAILURE_NAME,
        status: 'fail',
        detail: PROVIDER_FAILURE_DETAIL,
      });
      reported.add(PROVIDER_FAILURE_NAME);
    } else {
      for (const check of Array.isArray(report.checks) ? report.checks : []) {
        if (typeof check !== 'object' || check === null) {
          continue;
        }

        const status: HealthStatus =
          check.status === 'fail'
            ? 'fail'
            : check.status === 'not-applicable'
              ? 'not-applicable'
              : 'pass';

        rows.push({
          id: String(check.id),
          status,
          detail: typeof check.detail === 'string' ? check.detail : '',
        });
        reported.add(String(check.id));
        recordVerdict(String(check.id), status);
      }
    }

    appendUnreported(rows, reported);

    return {
      status: report === null ? rollUpOf(rows) : report.status,
      checks: rows,

      // Counted over the RENDERED rows, which include any unreported check the
      // report itself did not carry.
      counts: countsOf(rows),
      report,
      readiness,
    };
  };

  /**
   * Reads whichever health source is attached.
   *
   * @returns The health section, empty where no source is attached.
   */
  const readHealth = (): DiagnosticsHealthSection => {
    if (healthSource === null) {
      return {
        status: null,
        checks: EMPTY_HEALTH_ROWS,
        counts: ZERO_STATUS_COUNTS,
        report: null,
        readiness: null,
      };
    }

    return typeof healthSource === 'function'
      ? readProbeViews(healthSource)
      : readHealthSurface(healthSource);
  };

  /**
   * Reads the hook bus's dispatch counts, once per render.
   *
   * @returns The view, or `null` where no bus is attached or it threw.
   */
  const readHookView = (): HookDispatchCountsView | null => {
    if (hookCounts === null) {
      return null;
    }

    try {
      return hookCounts();
    } catch (thrown) {
      reportFailure(HOOK_PANEL_TITLE, thrown);

      return null;
    }
  };

  const foldHookView = (view: HookDispatchCountsView): void => {
    try {
      metrics.foldHookDispatchCounts(view);
    } catch (thrown) {
      reportFailure(HOOK_PANEL_TITLE, thrown);
    }
  };

  /**
   * Folds the RNG substream cursors, once per read.
   *
   * @returns Whether a reader was attached and answered.
   */
  const foldRngCursors = (): boolean => {
    if (rngCursors === null) {
      return false;
    }

    try {
      metrics.recordRngCursors(rngCursors());

      return true;
    } catch (thrown) {
      reportFailure(METRICS_EXPORT_CONTROL_LABEL, thrown);

      return false;
    }
  };

  /**
   * Folds EVERY pulled source into the registry.
   *
   * The one place the pull integrations are read, called by each surface that
   * answers from the registry — the combined snapshot and the Prometheus text
   * — so a direct export carries the same values the panel shows. The
   * Prometheus text was taken straight off the registry, so the hook counts and
   * the cursor family in it were whatever the last render had folded, or absent
   * on a surface nothing had rendered.
   *
   * Every fold is ABSOLUTE, not additive: `foldHookDispatchCounts` and
   * `recordRngCursors` both compare the source's total against the value the
   * last fold read, so folding twice for one snapshot adds nothing.
   *
   * @returns The hook view that was read, or `null` where none was.
   */
  const foldSources = (): HookDispatchCountsView | null => {
    const hookView = readHookView();

    if (hookView !== null) {
      foldHookView(hookView);
    }

    foldRngCursors();

    return hookView;
  };

  const takeMetrics = (): MetricsSnapshot => {
    try {
      return metrics.snapshot();
    } catch (thrown) {
      reportFailure('Metrics', thrown);

      return UNAVAILABLE_METRICS;
    }
  };

  /**
   * Reads the tracer's snapshot.
   *
   * @returns The snapshot, or `null` where no tracer is attached or it
   *   threw.
   */
  const readTraces = (): TraceSnapshot | null => {
    if (tracer === null) {
      return null;
    }

    try {
      return tracer.snapshot(spanLimit);
    } catch (thrown) {
      reportFailure(TRACE_PANEL_TITLE, thrown);

      return null;
    }
  };

  /**
   * Reads the logger's ring buffer through its export surface, oldest record
   * first. `snapshot` rather than `recent`: the export surface redacts the
   * locations of the three forms DL-LOG-08 enumerates and the message forms
   * DL-LOG-10 enumerates, whatever the logger's own `errorDetail` is, where
   * `recent` reports the records as the sinks received them.
   *
   * @returns Records carrying no location of those three forms, empty where no
   *   logger is attached or it threw.
   */
  const readLogs = (): readonly LogRecord[] => {
    if (logger === null) {
      return [];
    }

    try {
      const records = logger.snapshot(logLimit).records;

      return Array.isArray(records) ? records : [];
    } catch (thrown) {
      reportFailure(LOG_PANEL_TITLE, thrown);

      return [];
    }
  };

  /**
   * Builds the status cell of one row.
   *
   * @param status Status to render, or `null` where there is none.
   * @returns The cell, carrying the status as a class and as a colour,
   *   weight and slant of its own.
   */
  const statusCell = (status: HealthStatus | null): Cell => {
    if (status === null) {
      return { text: MISSING_VALUE };
    }

    const presentation = STATUS_PRESENTATION[status];

    return {
      text: presentation.label,
      className: `${STATUS_CLASS} ${STATUS_CLASS}-${status}`,
      style: presentation.style,
    };
  };

  /**
   * ADDED: builds a cell holding a sentence rather than a figure.
   *
   * @param text Sentence to render.
   * @returns The cell, aligned to its start rather than to its end.
   */
  const proseCell = (text: string): Cell => ({
    text,
    className: PROSE_CLASS,
    style: PROSE_CELL_STYLE,
  });

  /**
   * Builds the run rows.
   *
   * @param taken Snapshot the render describes.
   * @returns The rows.
   */
  const runRows = (taken: MetricsSnapshot): readonly Row[] => [
    ['correlation id', taken.correlationId],
    ['generated at', taken.generatedAt],
    ['elapsed ms', renderNumber(taken.elapsedMs)],
    ['rejected reports', renderNumber(taken.rejected)],
    ['reporter faults', renderNumber(taken.reporterFaults)],
    ['schema version', renderNumber(taken.schemaVersion)],
  ];

  /**
   * Builds the health rows: one per check, the roll-up, and the readiness
   * verdicts where a health surface supplied them.
   *
   * @param health Health section the render describes.
   * @returns The rows.
   */
  const healthRows = (health: DiagnosticsHealthSection): readonly Row[] => {
    // The third column is a SENTENCE in every row of this panel, so each one
    // is built as a prose cell and reads from its start. DL-DIAG-10.
    const rows: Row[] = health.checks.map((check): Row => [
      check.id,
      statusCell(check.status),
      proseCell(check.detail),
    ]);

    rows.push([
      'overall',
      statusCell(health.status),
      proseCell(
        `${HEALTH_CHECK_COUNT} checks: healthy ${health.counts.pass}, ` +
          `unhealthy ${health.counts.fail}, ` +
          `not-applicable ${health.counts['not-applicable']}`,
      ),
    ]);

    const readiness = health.readiness;

    if (readiness === null) {
      return rows;
    }

    rows.push(
      [
        'ready',
        String(readiness.ready),
        proseCell(`roll-up ${readiness.healthStatus}`),
      ],
      [
        'renderer',
        readiness.renderer,
        proseCell(
          `webgl ${readiness.webglLevel}${
            readiness.webglFailure === undefined
              ? ''
              : `, ${readiness.webglFailure}`
          }`,
        ),
      ],
      [
        'may mount webgl',
        String(readiness.mayMountWebGLRenderer),
        proseCell(`webgl check ${readiness.webglStatus}`),
      ],
      [
        'number-only fallback',
        String(readiness.requiresNumberOnlyFallback),
        proseCell(`required ${String(readiness.requiresNumberOnlyFallback)}`),
      ],
      [
        'storage',
        readiness.storage,
        proseCell(
          `strategy ${readiness.storageStrategy}, ` +
            `check ${readiness.storageStatus}`,
        ),
      ],
    );

    return rows;
  };

  /**
   * Builds one span row: the name, the duration, the identifier and the parent
   * it was opened under.
   *
   * @param record Span to render.
   * @returns The row.
   */
  const spanRow = (record: SpanRecord): Row => [
    record.name,
    `${renderNumber(record.durationMs)} ms`,
    `id ${shortId(record.id)}`,
    `parent ${shortId(record.parentId)}`,
  ];

  /**
   * Builds the trace rows: the two duration families summarised off the
   * snapshot's own buckets, the frame budget and its exceedances, and the most
   * recent spans with their parent linkage.
   *
   * @param traces Tracer snapshot, or `null` where none is attached.
   * @param taken Metrics snapshot the render describes.
   * @returns The rows.
   */
  const traceRows = (
    traces: TraceSnapshot | null,
    taken: MetricsSnapshot,
  ): readonly Row[] => {
    const frameSeries = findHistogram(
      taken,
      METRIC_NAMES.frameTimeMilliseconds,
    );
    const turnSeries = findHistogram(
      taken,
      METRIC_NAMES.turnLatencyMilliseconds,
    );
    const stats: FrameTraceStats | null =
      traces === null ? null : traces.frames;
    const budgetMs = stats === null ? DEFAULT_FRAME_BUDGET_MS : stats.budgetMs;
    const frames =
      stats === null ? (frameSeries?.count ?? 0) : stats.frames;
    const overBudget =
      stats === null
        ? frameSeries === null
          ? 0
          : countAbove(frameSeries, DEFAULT_FRAME_BUDGET_MS)
        : stats.overBudgetFrames;

    const rows: Row[] = [
      [
        SPAN_NAMES.frameCallback,
        frameSeries === null ? MISSING_VALUE : renderSeriesValue(frameSeries),
        frameSeries === null ? '' : renderQuantiles(frameSeries),
      ],
      [
        SPAN_NAMES.engineTurn,
        turnSeries === null ? MISSING_VALUE : renderSeriesValue(turnSeries),
        turnSeries === null ? '' : renderQuantiles(turnSeries),
      ],
      [
        'frame budget',
        `${renderNumber(budgetMs)} ms`,
        `over budget ${renderNumber(overBudget)} of ${renderNumber(frames)}`,
      ],
    ];

    if (traces === null) {
      rows.push(['tracer', NO_TRACER_TEXT, '']);

      return rows;
    }

    rows.push(
      [
        'frame timing',
        `last ${renderNumber(stats?.lastFrameMs ?? 0)} ms`,
        `max ${renderNumber(stats?.maxFrameMs ?? 0)} ms, ` +
          `total ${renderNumber(stats?.totalFrameMs ?? 0)} ms`,
      ],
      [
        'spans',
        `started ${renderNumber(traces.started)}, ` +
          `ended ${renderNumber(traces.ended)}`,
        `open ${renderNumber(traces.open)}, ` +
          `dropped ${renderNumber(traces.dropped)}, ` +
          `faults ${renderNumber(traces.faults)}`,
      ],
    );

    const spans = Array.isArray(traces.spans) ? traces.spans : [];

    for (const record of spans.slice(-spanLimit).reverse()) {
      rows.push(spanRow(record));
    }

    return rows;
  };

  /**
   * Builds the hook rows: all six hooks in dispatch order, whatever the bus
   * reported.
   *
   * @param view Dispatch-count view, or `null` where no bus is attached.
   * @returns The rows.
   */
  const hookRows = (view: HookDispatchCountsView | null): readonly Row[] => {
    const rows: Row[] = hookRowsOf(view ?? {}).map((row): Row => [
      row.hook,
      `dispatched ${renderNumber(row.dispatched)}`,
      `invoked ${renderNumber(row.invoked)}, ` +
        `skipped ${renderNumber(row.skipped)}, ` +
        `rejected ${renderNumber(row.rejected)}, ` +
        `failed ${renderNumber(row.failed)}`,
    ]);

    rows.push([
      'bus',
      view === null ? NO_BUS_TEXT : (view.correlationId ?? MISSING_VALUE),
      '',
    ]);

    return rows;
  };

  /**
   * Selects the series the metrics panel shows, zero-valued ones filtered out
   * by default.
   *
   * @param taken Snapshot the render describes.
   * @returns The series to render.
   */
  const visibleSeries = (
    taken: MetricsSnapshot,
  ): readonly MetricSeriesSnapshot[] =>
    taken.series.filter(
      (candidate) =>
        !hideEmpty ||
        hasValue(candidate) ||

        // ADDED: the skeleton is shown at zero, so a reader inspecting only
        // this panel sees the counters and the enumerated dimensions a reading
        // is checked against. DL-DIAG-12.
        isCoreSeries(candidate),
    );

  /**
   * Builds the log rows, newest record first.
   *
   * @param records Records to render.
   * @returns The rows.
   */
  const logRows = (records: readonly LogRecord[]): readonly Row[] =>
    [...records].reverse().map((record): Row => [
      record.level,
      record.subsystem,

      // A record's message is a sentence, so it reads from its start rather
      // than from the end the figure columns align to. DL-DIAG-10.
      proseCell(record.message),
      record.correlationId,
    ]);

  /**
   * ADDED: builds the heading and the control row, once, and keeps them.
   *
   * They are the surface's FURNITURE: the heading names it and the five
   * controls operate it, and neither is a function of a reading. A render used
   * to rebuild both from scratch every second, which replaced five button
   * nodes a second — so an accessibility handle to a control went stale on the
   * next tick, and the keyboard focus had to be chased by position after the
   * fact. Built once and never detached, a control keeps its identity, its
   * listener and its focus across every render. DL-DIAG-16.
   */
  const ensureFurniture = (): void => {
    if (host === null) {
      return;
    }

    if (headingNode === null) {
      const heading = make('h1', HEADING_CLASS, OVERLAY_TITLE);

      if (heading !== null) {
        applyStyle(heading, HEADING_STYLE);
        headingNode = heading;
      }
    }

    if (headingNode !== null && headingNode.parentNode !== host) {
      try {
        host.insertBefore(headingNode, host.firstChild);
      } catch (thrown) {
        reportFailure(OVERLAY_TITLE, thrown);
      }
    }

    if (controlRow === null) {
      const controls = make('div', CONTROLS_CLASS);

      if (controls !== null) {
        applyStyle(controls, CONTROLS_STYLE);
        controls.setAttribute('role', 'group');
        controls.setAttribute('aria-label', CONTROLS_LABEL);

        const built = [
          control(REFRESH_CONTROL_LABEL, render),
          control(METRICS_EXPORT_CONTROL_LABEL, () => {
            exportPrometheusText();
          }),
          control(SNAPSHOT_EXPORT_CONTROL_LABEL, () => {
            exportSnapshotJson();
          }),

          // Before the control that closes the surface: collapsing is the
          // lesser of the two recoveries and reads in that order. Its label
          // states what the activation DOES, and `aria-expanded` states the
          // disclosure state the panels are in now. DL-DIAG-11.
          control(
            collapsed ? EXPAND_CONTROL_LABEL : COLLAPSE_CONTROL_LABEL,
            toggleCollapsed,
            !collapsed,
          ),
          control(CLOSE_CONTROL_LABEL, hide),
        ];

        for (const node of built) {
          if (node !== null) {
            controls.appendChild(node);
          }
        }

        collapseControl = built[COLLAPSE_CONTROL_POSITION] ?? null;
        controlRow = controls;
      }
    }

    if (controlRow !== null && controlRow.parentNode !== host) {
      try {
        host.appendChild(controlRow);
      } catch (thrown) {
        reportFailure(CONTROLS_LABEL, thrown);
      }
    }
  };

  /**
   * ADDED: writes the collapse control's label and disclosure state.
   *
   * The node is reused, so the state it publishes is UPDATED in place rather
   * than carried by a replacement node. DL-DIAG-16.
   */
  const publishCollapseState = (): void => {
    const node = collapseControl;

    if (node === null) {
      return;
    }

    const label = collapsed ? EXPAND_CONTROL_LABEL : COLLAPSE_CONTROL_LABEL;
    const expanded = String(!collapsed);

    try {
      // Written only where it differs. An unconditional write of the same value
      // still replaces the text node and still records an attribute mutation, so
      // a render a second churned the control that had just been kept — which
      // costs an assistive technology a needless change notification and makes
      // the stand-off of DL-DIAG-15 look like activity to anything watching the
      // DOM. DL-DIAG-16.
      if (node.textContent !== label) {
        node.textContent = label;
      }

      if (node.getAttribute('aria-expanded') !== expanded) {
        node.setAttribute('aria-expanded', expanded);
      }
    } catch (thrown) {
      reportFailure(CONTROLS_LABEL, thrown);
    }
  };

  /**
   * ADDED: writes the refresh state to the host and to the heading.
   *
   * @param paused Whether the scheduled render is standing off. DL-DIAG-15.
   */
  const publishRefreshState = (paused: boolean): void => {
    const state = paused ? REFRESH_PAUSED : REFRESH_LIVE;

    try {
      // Written only where it differs, for the reason `publishCollapseState`
      // gives: a paused surface publishing the same state every second is a
      // surface that mutates every second, which is exactly what the pause
      // exists to avoid. DL-DIAG-15.
      if (host !== null && host.getAttribute(REFRESH_ATTRIBUTE) !== state) {
        host.setAttribute(REFRESH_ATTRIBUTE, state);
      }
    } catch (thrown) {
      reportFailure(OVERLAY_TITLE, thrown);
    }

    if (headingNode === null) {
      return;
    }

    const title = paused
      ? `${OVERLAY_TITLE}${PAUSED_TITLE_SUFFIX}`
      : OVERLAY_TITLE;

    try {
      if (headingNode.textContent !== title) {
        headingNode.textContent = title;
      }
    } catch (thrown) {
      reportFailure(OVERLAY_TITLE, thrown);
    }
  };

  /** Removes the panel nodes the previous render appended. */
  const clearPanels = (): void => {
    while (panelNodes.length > 0) {
      const node = panelNodes.pop();

      if (node === undefined) {
        continue;
      }

      try {
        node.parentNode?.removeChild(node);
      } catch {
        // A node the host refuses to release is left where it stands; the
        // next render appends beside it rather than failing the surface.
      }
    }
  };

  /** Renders every panel from one reading. */
  const render = (): void => {
    if (destroyed || host === null || owner === null) {
      return;
    }

    const target = host;

    // The furniture is in place before the panels are, so the panels are
    // inserted between a heading that already exists and a control row that
    // has never left. DL-DIAG-16.
    ensureFurniture();

    const health = readHealth();
    const hookView = foldSources();
    const taken = takeMetrics();

    lastMetrics = taken;

    const traces = readTraces();
    const records = readLogs();
    const fragment = owner.createDocumentFragment();

    // ADDED: the panels are the collapsible half. Every reading above is still
    // TAKEN while the surface is collapsed — the fold, the metrics snapshot
    // `lastSnapshot()` answers from and the health check all run exactly as
    // they do expanded — so collapsing changes what is DRAWN and nothing about
    // what is recorded or exported. DL-DIAG-11.
    if (!collapsed) {
      panel(fragment, RUN_PANEL_TITLE, () => runRows(taken));
      panel(fragment, HEALTH_PANEL_TITLE, () => healthRows(health));
      panel(fragment, TRACE_PANEL_TITLE, () => traceRows(traces, taken));
      panel(fragment, HOOK_PANEL_TITLE, () => hookRows(hookView));

      const series = visibleSeries(taken);

      panel(
        fragment,
        metricsPanelTitle(series.length, taken.series.length),
        () =>
          series.map((candidate): Row => [
            candidate.name,
            renderLabels(candidate.labels),
            renderSeriesValue(candidate),
            candidate.kind === 'histogram' ? renderQuantiles(candidate) : '',
          ]),
      );
      panel(fragment, LOG_PANEL_TITLE, () => logRows(records));
    }

    // ADDED: the outgoing panels are removed and the incoming ones inserted
    // AHEAD OF THE CONTROL ROW, so the furniture is never detached and the
    // rendered order — heading, panels, controls — is the order it has always
    // been. DL-DIAG-16.
    const built = Array.from(fragment.childNodes).filter(isElementLike);

    clearPanels();

    try {
      target.insertBefore(fragment, controlRow);
      panelNodes = built;
    } catch (thrown) {
      reportFailure(OVERLAY_TITLE, thrown);
    }

    // ADDED: the collapsed state is published on the host as well as on the
    // control, so a stylesheet and a reader of the DOM can both see it.
    // DL-DIAG-11.
    try {
      // ADDED: set only where it differs, so a collapsed surface does not record
      // one attribute mutation per tick for a value that has not changed.
      // `removeAttribute` of an absent attribute already records nothing.
      // DL-DIAG-16.
      if (collapsed) {
        if (target.getAttribute(COLLAPSED_ATTRIBUTE) !== 'true') {
          target.setAttribute(COLLAPSED_ATTRIBUTE, 'true');
        }
      } else {
        target.removeAttribute(COLLAPSED_ATTRIBUTE);
      }
    } catch (thrown) {
      reportFailure(OVERLAY_TITLE, thrown);
    }

    publishCollapseState();
    publishRefreshState(holdsFocus());
  };

  /**
   * ADDED: switches between the full surface and its heading-and-controls
   * form, and redraws.
   *
   * The keyboard focus is on the control that was activated and that control is
   * the same NODE afterwards, relabelled in place, so the focus is never
   * displaced and the state can be switched back without re-finding the
   * control. DL-DIAG-11, DL-DIAG-16.
   */
  const toggleCollapsed = (): void => {
    collapsed = !collapsed;
    render();
  };

  /** Stops the scheduled refresh. */
  const stopTimer = (): void => {
    if (timer === null) {
      return;
    }

    try {
      const cancel = globalThis.clearInterval;

      if (typeof cancel === 'function') {
        cancel(timer);
      }
    } catch {
      // A host that refuses the cancellation leaves the handle unset below.
    }

    timer = null;
  };

  /**
   * Starts the scheduled refresh, at the throttled cadence and never per
   * frame. A hidden or destroyed overlay schedules nothing, and a tick that
   * finds the keyboard focus inside the host renders nothing.
   *
   * THE CADENCE IS A TIMER AND NOTHING ELSE. It is `setInterval` at
   * `refreshIntervalMs`, so it advances whether or not a frame is composited,
   * whether or not the render loop is parked and whether or not the game is
   * being played; a reading taken from an idle page still moves. The one
   * condition that stops it is the focus hold below, which is deliberate and,
   * since DL-DIAG-15, published on the host and in the heading so it cannot be
   * mistaken for the surface having died. DL-DIAG-15.
   */
  const startTimer = (): void => {
    if (timer !== null || destroyed || refreshIntervalMs <= 0) {
      return;
    }

    const schedule = globalThis.setInterval;

    if (typeof schedule !== 'function') {
      return;
    }

    try {
      timer = schedule((): void => {
        if (!shown || destroyed) {
          return;
        }

        // The SCHEDULED render is skipped while the surface holds the keyboard
        // focus, so the panels a reader is working through do not change under
        // them. ADDED: the skip publishes itself, and `focusout` renders
        // immediately, so the stand-off is both visible while it lasts and over
        // the moment the reader leaves. DL-DIAG-15.
        if (holdsFocus()) {
          publishRefreshState(true);

          return;
        }

        render();
      }, refreshIntervalMs);
    } catch (thrown) {
      timer = null;
      reportFailure(OVERLAY_TITLE, thrown);
    }
  };

  /**
   * Hides the host and stops the scheduled refresh.
   *
   * ADDED: where the surface itself held the keyboard focus, the focus goes back
   * to the element outside it that had it last. Hiding an element that contains
   * the focus drops the focus to the body, so a keyboard user who closed the
   * surface from its own control lost their position in the page and had to
   * traverse back to it. The check is made BEFORE the host is hidden, because
   * afterwards the active element is already the body. Focus is never taken from
   * somewhere else: a close called while focus sits in the game leaves it there.
   * DL-DIAG-17.
   */
  const hide = (): void => {
    const returning = shown && holdsFocus();

    shown = false;
    stopTimer();

    if (host === null) {
      return;
    }

    setHidden(host, true);

    // ADDED: a closed surface is neither live nor paused, so it publishes
    // neither. The attribute returns on the render the next `show` performs.
    // Leaving the value the close froze would have reported a stand-off that no
    // longer has a schedule to stand off from. DL-DIAG-15.
    try {
      host.removeAttribute(REFRESH_ATTRIBUTE);

      // The heading goes back to its plain form with it. A closed surface whose
      // heading still read 'paused while focused' described a stand-off it no
      // longer had — invisible while hidden, and wrong the moment anything read
      // the text rather than looked at it.
      if (headingNode !== null && headingNode.textContent !== OVERLAY_TITLE) {
        headingNode.textContent = OVERLAY_TITLE;
      }
    } catch (thrown) {
      reportFailure(OVERLAY_TITLE, thrown);
    }

    if (returning) {
      restoreFocusOrigin();
    }
  };

  /** Shows the host, renders it and starts the scheduled refresh. */
  const show = (): void => {
    if (destroyed || host === null) {
      return;
    }

    // ADDED: the element focused as the surface opens is the first candidate
    // for the return, and the tracking keeps it current from there. DL-DIAG-17.
    if (!shown) {
      rememberFocusOrigin(owner?.activeElement);
    }

    trackFocus();
    setHidden(host, false);
    shown = true;
    render();
    startTimer();
  };

  /**
   * Resolves a host, creating one where the markup declares none.
   *
   * @returns Whether a host is available afterwards.
   */
  const mount = (): boolean => {
    if (destroyed) {
      reportSkipped(MOUNT_SKIPPED_MESSAGE, 'destroyed');

      return false;
    }

    if (host !== null) {
      prepareHost(host);

      return true;
    }

    if (explicitHost !== undefined) {
      reportSkipped(MOUNT_SKIPPED_MESSAGE, 'hostDisabled');

      return false;
    }

    if (owner === null) {
      reportSkipped(MOUNT_SKIPPED_MESSAGE, 'noDocument');

      return false;
    }

    const found = queryHost();

    if (found !== null) {
      host = found;
      prepareHost(found);

      return true;
    }

    const parent: Element | null = owner.body ?? owner.documentElement ?? null;

    if (parent === null) {
      reportSkipped(MOUNT_SKIPPED_MESSAGE, 'noMountParent');

      return false;
    }

    const created = make('div');

    if (created === null) {
      reportSkipped(MOUNT_SKIPPED_MESSAGE, 'noElement');

      return false;
    }

    created.id = DIAGNOSTICS_HOST_ID;
    setHidden(created, true);
    prepareHost(created);

    try {
      parent.appendChild(created);
    } catch (thrown) {
      reportFailure(OVERLAY_TITLE, thrown);

      return false;
    }

    host = created;
    createdHost = created;

    return true;
  };

  // These exports are the substitute for a scrape: the bundle has no server to
  // serve a metrics endpoint from.

  /**
   * Builds the combined snapshot from a fresh reading of every source.
   *
   * @returns The snapshot.
   */
  const buildSnapshot = (): DiagnosticsSnapshot => {
    const health = readHealth();
    const hookView = foldSources();
    const taken = takeMetrics();

    return {
      schemaVersion: DIAGNOSTICS_SNAPSHOT_SCHEMA_VERSION,
      correlationId: taken.correlationId,
      generatedAt: taken.generatedAt,
      health,
      traces: readTraces(),
      hooks: hookRowsOf(hookView ?? {}),
      metrics: taken,
      logs: readLogs(),
    };
  };

  /**
   * Serialises the combined snapshot.
   *
   * @returns The JSON, or an envelope naming the failure.
   */
  const snapshotJson = (): string => {
    try {
      return JSON.stringify(buildSnapshot(), null, JSON_INDENT);
    } catch (thrown) {
      reportFailure(OVERLAY_TITLE, thrown);

      return JSON.stringify(
        {
          schemaVersion: DIAGNOSTICS_SNAPSHOT_SCHEMA_VERSION,
          error: 'The combined snapshot could not be serialised.',
        },
        null,
        JSON_INDENT,
      );
    }
  };

  /**
   * Downloads the Prometheus text through the registry's own exporter, which
   * owns the format and revokes its own object URL.
   *
   * @returns Whether the download was started.
   */
  const exportPrometheusText = (): boolean => {
    try {
      // FOLDED FIRST, as every other read of the registry is: a scrape
      // substitute that reported stale pulled families would be a scrape of the
      // last render rather than of now.
      foldSources();

      return metrics.download();
    } catch (thrown) {
      reportFailure(METRICS_EXPORT_CONTROL_LABEL, thrown);

      return false;
    }
  };

  /**
   * Downloads the combined snapshot as JSON. The object URL is revoked in the
   * `finally` block, whether the click succeeded or not.
   *
   * @returns Whether the download was started.
   */
  const exportSnapshotJson = (): boolean => {
    let objectUrl: string | undefined;
    let revoke: ((url: string) => void) | undefined;

    try {
      if (owner === null) {
        reportSkipped(EXPORT_SKIPPED_MESSAGE, 'noDocument');

        return false;
      }

      const blobCtor = globalThis.Blob;
      const urlApi = globalThis.URL;

      if (
        typeof blobCtor !== 'function' ||
        typeof urlApi !== 'function' ||
        typeof urlApi.createObjectURL !== 'function'
      ) {
        reportSkipped(EXPORT_SKIPPED_MESSAGE, 'noBlobOrObjectUrl');

        return false;
      }

      revoke =
        typeof urlApi.revokeObjectURL === 'function'
          ? (url: string): void => {
              urlApi.revokeObjectURL(url);
            }
          : undefined;

      const blob = new blobCtor([snapshotJson()], { type: JSON_MEDIA_TYPE });

      objectUrl = urlApi.createObjectURL(blob);

      const anchor = owner.createElement('a');

      anchor.href = objectUrl;
      anchor.download = snapshotFilename;
      anchor.rel = 'noopener';
      applyStyle(anchor, ANCHOR_STYLE);

      const parent: Element | null =
        owner.body ?? owner.documentElement ?? null;

      if (parent !== null) {
        parent.appendChild(anchor);
      }

      anchor.click();

      if (anchor.parentNode !== null) {
        anchor.parentNode.removeChild(anchor);
      }

      return true;
    } catch (thrown) {
      reportFailure(SNAPSHOT_EXPORT_CONTROL_LABEL, thrown);

      return false;
    } finally {
      if (objectUrl !== undefined && revoke !== undefined) {
        try {
          revoke(objectUrl);
        } catch {
          // A host that refuses the revocation is contained here.
        }
      }
    }
  };

  // Construction: a host the markup already declares is adopted and prepared;
  // nothing is created and nothing is read until a member runs.
  host = explicitHost !== undefined ? explicitHost : queryHost();

  if (host !== null) {
    prepareHost(host);
  }

  return Object.freeze({
    get available(): boolean {
      return !destroyed && host !== null;
    },

    mount(): boolean {
      return mount();
    },

    isOpen(): boolean {
      return shown;
    },

    open(): void {
      if (destroyed) {
        return;
      }

      show();
    },

    close(): void {
      if (destroyed) {
        return;
      }

      hide();
    },

    toggle(): boolean {
      if (destroyed) {
        return false;
      }

      if (shown) {
        hide();
      } else {
        show();
      }

      return shown;
    },

    refresh(): void {
      if (destroyed || !shown) {
        return;
      }

      render();
    },

    lastSnapshot(): MetricsSnapshot | null {
      return destroyed ? null : lastMetrics;
    },

    // Every read and every export below is gated.
    toPrometheusText(): string {
      if (destroyed) {
        return '';
      }

      try {
        // The pulled families are folded before the text is taken, so this
        // export and `snapshot()` answer from one reading.
        foldSources();

        return metrics.toPrometheusText();
      } catch (thrown) {
        reportFailure(METRICS_EXPORT_CONTROL_LABEL, thrown);

        return '';
      }
    },

    snapshot(): DiagnosticsSnapshot {
      return destroyed ? INERT_DIAGNOSTICS_SNAPSHOT : buildSnapshot();
    },

    // The empty string, not the JSON of the empty envelope: a caller that gets
    // text back writes it to a file or a sink, and an envelope of zeroes is
    // indistinguishable there from a reading of a healthy but idle session.
    snapshotJson(): string {
      return destroyed ? '' : snapshotJson();
    },

    exportPrometheusText(): boolean {
      return destroyed ? false : exportPrometheusText();
    },

    exportSnapshotJson(): boolean {
      return destroyed ? false : exportSnapshotJson();
    },

    destroy(): void {
      if (destroyed) {
        return;
      }

      hide();
      destroyed = true;
      releaseListeners();

      if (createdHost !== null) {
        try {
          const parent = createdHost.parentNode;

          if (parent !== null) {
            parent.removeChild(createdHost);
          }
        } catch (thrown) {
          reportFailure(OVERLAY_TITLE, thrown);
        }
      } else if (host !== null) {
        releaseHost(host);
      }

      host = null;
      createdHost = null;
      lastMetrics = null;

      // ADDED: the furniture and the focus origin are released with the host,
      // so a destroyed overlay retains neither the nodes it built nor a handle
      // to an element of the page it was shown over. DL-DIAG-16, DL-DIAG-17.
      headingNode = null;
      controlRow = null;
      collapseControl = null;
      panelNodes = [];
      focusOrigin = null;
      focusTracked = false;

      // The optional collaborators are released, so a destroyed overlay keeps
      // neither the health surface, the tracer, the hook-count source nor the
      // cursor reader alive, and nothing it was given stays reachable through
      // it.
      healthSource = null;
      tracer = null;
      hookCounts = null;
      rngCursors = null;
    },
  });
}
