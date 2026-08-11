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

/** Selector the control row's buttons are read back by after a render. */
const CONTROL_SELECTOR = `.${CONTROLS_CLASS} button`;

/** Class a status cell carries, suffixed with the status it reports. */
const STATUS_CLASS = 'diagnostics-status';

/** Class the inline error line of a panel that failed to render carries. */
const PANEL_ERROR_CLASS = 'diagnostics-panel-error';

const LOGGER_SUBSYSTEM = 'diagnostics';

const DEFAULT_HIDE_EMPTY = true;

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

/** Inline declarations a control carries, from `@mixin button`. */
const CONTROL_STYLE: Readonly<Record<string, string>> = Object.freeze({
  background: derivedColors.buttonBackground,
  color: brightTextColor,
  border: 'none',
  'border-radius': `${tileBorderRadius}px`,
  padding: `${HALF_GRID_SPACING}px`,
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
  /** Whether a host is resolved and `destroy` has not been called. */
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

    if (decodeComponent(name) !== flag) {
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

const LOG_PANEL_TITLE = 'Recent records';

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

  /** Listeners this module added, with the node they were added to. */
  const listeners: {
    readonly node: EventTarget;
    readonly handler: EventListener;
  }[] = [];

  let destroyed = false;
  let shown = false;
  let lastMetrics: MetricsSnapshot | null = null;
  let host: Element | null = null;
  let createdHost: Element | null = null;
  let timer: number | null = null;

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
      removeStyle(element, HOST_STYLE);
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
   * @returns The control, or `null` where there is no document.
   */
  const control = (label: string, action: () => void): HTMLElement | null => {
    const node = make('button', CONTROL_CLASS, label);

    if (node === null) {
      return null;
    }

    const button = node as Partial<HTMLButtonElement>;

    if (typeof button.type === 'string') {
      button.type = 'button';
    }

    applyStyle(node, CONTROL_STYLE);

    const handler: EventListener = (): void => {
      try {
        action();
      } catch (thrown) {
        reportFailure(label, thrown);
      }
    };

    try {
      node.addEventListener('click', handler);
      listeners.push({ node, handler });
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
   * Position of the focused control in the control row.
   *
   * @returns The index, or `-1` where no control holds focus.
   */
  const focusedControlIndex = (): number => {
    if (host === null || owner === null) {
      return -1;
    }

    try {
      const active = owner.activeElement;

      if (active === null) {
        return -1;
      }

      const controls = host.querySelectorAll(CONTROL_SELECTOR);

      for (let index = 0; index < controls.length; index += 1) {
        if (controls[index] === active) {
          return index;
        }
      }

      return -1;
    } catch {
      return -1;
    }
  };

  /**
   * Moves focus back to the control at a position, after a render replaced the
   * node that held it.
   *
   * @param index Position recorded before the render, or `-1` for none.
   */
  const restoreControlFocus = (index: number): void => {
    if (index < 0 || host === null) {
      return;
    }

    try {
      const target = host.querySelectorAll(CONTROL_SELECTOR)[index];
      const focusable = target as Partial<HTMLElement> | undefined;

      if (focusable !== undefined && typeof focusable.focus === 'function') {
        focusable.focus();
      }
    } catch (thrown) {
      reportFailure(CONTROLS_LABEL, thrown);
    }
  };

  /** Removes every listener this module added. */
  const releaseListeners = (): void => {
    while (listeners.length > 0) {
      const entry = listeners.pop();

      if (entry === undefined) {
        continue;
      }

      try {
        entry.node.removeEventListener('click', entry.handler);
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
    const rows: Row[] = health.checks.map((check): Row => [
      check.id,
      statusCell(check.status),
      check.detail,
    ]);

    rows.push([
      'overall',
      statusCell(health.status),
      `${HEALTH_CHECK_COUNT} checks: healthy ${health.counts.pass}, ` +
        `unhealthy ${health.counts.fail}, ` +
        `not-applicable ${health.counts['not-applicable']}`,
    ]);

    const readiness = health.readiness;

    if (readiness === null) {
      return rows;
    }

    rows.push(
      [
        'ready',
        String(readiness.ready),
        `roll-up ${readiness.healthStatus}`,
      ],
      [
        'renderer',
        readiness.renderer,
        `webgl ${readiness.webglLevel}${
          readiness.webglFailure === undefined
            ? ''
            : `, ${readiness.webglFailure}`
        }`,
      ],
      [
        'may mount webgl',
        String(readiness.mayMountWebGLRenderer),
        `webgl check ${readiness.webglStatus}`,
      ],
      [
        'number-only fallback',
        String(readiness.requiresNumberOnlyFallback),
        `required ${String(readiness.requiresNumberOnlyFallback)}`,
      ],
      [
        'storage',
        readiness.storage,
        `strategy ${readiness.storageStrategy}, ` +
          `check ${readiness.storageStatus}`,
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
    taken.series.filter((candidate) => !hideEmpty || hasValue(candidate));

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
      record.message,
      record.correlationId,
    ]);

  /** Renders every panel from one reading. */
  const render = (): void => {
    if (destroyed || host === null || owner === null) {
      return;
    }

    // The listeners of the outgoing tree are released before the new one is
    // built, so the array holds exactly the controls now on screen.
    releaseListeners();

    // Position of the control holding the keyboard focus, restored once the
    // new tree is in place: a render replaces the button nodes, and the
    // control at this position is the successor of the one that held focus.
    const focusedControl = focusedControlIndex();
    const target = host;
    const health = readHealth();
    const hookView = foldSources();
    const taken = takeMetrics();

    lastMetrics = taken;

    const traces = readTraces();
    const records = readLogs();
    const fragment = owner.createDocumentFragment();
    const heading = make('h1', HEADING_CLASS, OVERLAY_TITLE);

    if (heading !== null) {
      applyStyle(heading, HEADING_STYLE);
      fragment.appendChild(heading);
    }

    panel(fragment, RUN_PANEL_TITLE, () => runRows(taken));
    panel(fragment, HEALTH_PANEL_TITLE, () => healthRows(health));
    panel(fragment, TRACE_PANEL_TITLE, () => traceRows(traces, taken));
    panel(fragment, HOOK_PANEL_TITLE, () => hookRows(hookView));

    const series = visibleSeries(taken);

    panel(
      fragment,
      `Metrics (${series.length} of ${taken.series.length} series)`,
      () =>
        series.map((candidate): Row => [
          candidate.name,
          renderLabels(candidate.labels),
          renderSeriesValue(candidate),
          candidate.kind === 'histogram' ? renderQuantiles(candidate) : '',
        ]),
    );
    panel(fragment, LOG_PANEL_TITLE, () => logRows(records));

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
        control(CLOSE_CONTROL_LABEL, hide),
      ];

      for (const node of built) {
        if (node !== null) {
          controls.appendChild(node);
        }
      }

      fragment.appendChild(controls);
    }

    clear(target);
    target.appendChild(fragment);
    restoreControlFocus(focusedControl);
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
        // focus, so a traversal of the controls is never interrupted by one.
        if (holdsFocus()) {
          return;
        }

        render();
      }, refreshIntervalMs);
    } catch (thrown) {
      timer = null;
      reportFailure(OVERLAY_TITLE, thrown);
    }
  };

  /** Hides the host and stops the scheduled refresh. */
  const hide = (): void => {
    shown = false;
    stopTimer();

    if (host === null) {
      return;
    }

    setHidden(host, true);
  };

  /** Shows the host, renders it and starts the scheduled refresh. */
  const show = (): void => {
    if (destroyed || host === null) {
      return;
    }

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
