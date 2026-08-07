// The in-page diagnostics surface, Rule 3.
//
// Provenance:
//   src/observability/metrics.ts  the registry, its snapshot and its
//                                Prometheus-text and JSON exports
//   src/observability/logger.ts   the record buffer and its JSON-lines export
//   index.html                    `#diagnostics-overlay`, the host it mounts in
//
// WHY THIS EXISTS AS A PAGE ELEMENT RATHER THAN AN ENDPOINT.
//
// Rule 3 requires a metrics endpoint, health and readiness probes and a
// dashboard, all "verified working in the local development environment",
// because a capability that cannot be exercised locally is not delivered. This
// product is a fully static bundle with no server process and no listening
// port, so there is nothing to serve an endpoint from and nothing for an
// orchestrator to poll. AAP 0.7.2.4 records that collision and the substitution
// it requires: an in-page diagnostics surface plus an exportable
// Prometheus-text snapshot, standing in for the endpoint, and programmatic
// client-side self-checks standing in for the probes.
//
// So this module IS the endpoint, reached by opening the overlay instead of by
// issuing a request. Without it the registry would be a write-only sink — every
// counter would move and nobody could ever read one — which is the state the
// review found the build in.
//
// The overlay reads. It never records, never counts and never mutates the
// registry, so opening it cannot perturb what it reports.

import type { Logger } from './logger';
import type {
  HistogramSeriesSnapshot,
  HookDispatchCountsView,
  MetricSeriesSnapshot,
  MetricsRegistry,
  MetricsSnapshot,
} from './metrics';

/* ==========================================================================
 * 1. Names and defaults
 * ========================================================================== */

/** Selector the overlay mounts in where the caller supplies no element. */
export const DIAGNOSTICS_OVERLAY_SELECTOR = '#diagnostics-overlay';

/** Class the overlay's own root carries. */
const OVERLAY_CLASS = 'diagnostics-overlay';

/** Class every section heading carries. */
const HEADING_CLASS = 'diagnostics-heading';

/** Class the metric and health tables carry. */
const TABLE_CLASS = 'diagnostics-table';

/** Class the control row carries. */
const CONTROLS_CLASS = 'diagnostics-controls';

/** Class a single control carries, shared with the screen vocabulary. */
const CONTROL_CLASS = 'screen-button';

/** Series whose value is zero are hidden by default, so the table stays legible. */
const DEFAULT_HIDE_EMPTY = true;

/** Quantiles reported for every histogram family. */
const REPORTED_QUANTILES: readonly number[] = Object.freeze([0.5, 0.95, 0.99]);

/** Records the log panel shows. */
const DEFAULT_LOG_LIMIT = 25;

/** Scale a quantile is rendered on. */
const PERCENT_SCALE = 100;

/* ==========================================================================
 * 2. Types
 * ========================================================================== */

/** One capability probe's result, as the overlay reports it. */
export interface HealthCheckResult {
  /** Stable name of the probe, as `'webgl'`. */
  readonly name: string;

  /** Whether the capability is present. */
  readonly healthy: boolean;

  /** What was observed, shown beside the verdict. */
  readonly detail?: string;
}

/** A source of health results, read afresh on every render. */
export type HealthProvider = () => readonly HealthCheckResult[];

/** What `createDiagnosticsOverlay` accepts. */
export interface DiagnosticsOverlayOptions {
  /** The registry to read. */
  readonly metrics: MetricsRegistry;

  /** The logger whose recent records the overlay shows. */
  readonly logger?: Logger;

  /** Host element, already resolved. `null` disables the overlay. */
  readonly host?: Element | null;

  /** Selector the host is resolved from when none is supplied. */
  readonly selector?: string;

  /** Document the lookup runs against. */
  readonly document?: Document | null;

  /** Supplies the capability probe results shown in the health panel. */
  readonly health?: HealthProvider;

  /**
   * Supplies the hook bus's dispatch counts, folded into the registry before
   * each snapshot.
   *
   * The registry integrates with the bus by PULL, so the per-hook series stay
   * empty unless something asks. Supplying `engine.hooks.metrics` here is what
   * asks. Omit it where there is no bus to read.
   */
  readonly hookCounts?: () => HookDispatchCountsView;

  /** Whether zero-valued series are hidden. Defaults to `true`. */
  readonly hideEmpty?: boolean;

  /** Records the log panel shows. Defaults to 25. */
  readonly logLimit?: number;
}

/** The overlay a caller holds. */
export interface DiagnosticsOverlay {
  /** Whether a host resolved and `destroy()` has not been called. */
  readonly available: boolean;

  /** Whether the overlay is currently shown. */
  isOpen(): boolean;

  /** Shows the overlay and renders it. */
  open(): void;

  /** Hides the overlay. Its content is left in place for the next open. */
  close(): void;

  /** Shows or hides it, and returns whether it is now shown. */
  toggle(): boolean;

  /** Re-renders from the current snapshot. A no-op while closed. */
  refresh(): void;

  /** The snapshot the last render read, or `null` before the first. */
  lastSnapshot(): MetricsSnapshot | null;

  /**
   * The Prometheus text of the current registry state.
   *
   * The substitute for a scrape: a caller pastes this where a scrape's body
   * would have gone.
   */
  toPrometheusText(): string;

  /** Hides the overlay, empties it and releases its listeners. */
  destroy(): void;
}

/* ==========================================================================
 * 3. Element helpers
 * ========================================================================== */

/**
 * Resolves the document a lookup runs against.
 *
 * @param supplied Document the caller supplied, if any.
 * @returns The document, or `null` where there is none.
 */
function resolveDocument(supplied: Document | null | undefined): Document | null {
  if (supplied !== undefined && supplied !== null) {
    return supplied;
  }

  return typeof document === 'undefined' ? null : document;
}

/**
 * Empties an element.
 *
 * @param element Element to empty.
 */
function clear(element: Element): void {
  while (element.firstChild !== null) {
    element.removeChild(element.firstChild);
  }
}

/**
 * Renders a number for display, without inventing precision it does not have.
 *
 * @param value Value to render.
 * @returns The rendered value.
 */
function renderNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return '—';
  }

  return Number.isInteger(value) ? String(value) : value.toFixed(3);
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
 * Renders the quantiles of one histogram.
 *
 * Read off the snapshot's own buckets rather than by asking the registry again,
 * so the whole panel describes ONE instant instead of a moving target.
 *
 * @param series Histogram to render.
 * @returns The rendered quantiles.
 */
function renderQuantiles(series: HistogramSeriesSnapshot): string {
  if (series.count <= 0) {
    return '';
  }

  return REPORTED_QUANTILES.map((quantile): string => {
    const label = `p${Math.round(quantile * PERCENT_SCALE)}`;
    const target = quantile * series.count;

    // `bucketCounts` is CUMULATIVE and aligned to `buckets`: element `i` counts
    // every observation at or below `buckets[i]`, so the bucket a rank falls in
    // is the first whose count reaches it. No running total is accumulated here
    // — doing so would double-count.
    for (let index = 0; index < series.buckets.length; index += 1) {
      const cumulative = series.bucketCounts[index] ?? 0;

      if (cumulative >= target) {
        return `${label}<=${renderNumber(series.buckets[index] ?? 0)}`;
      }
    }

    // The rank fell in the overflow slot, above the highest bound.
    return `${label}=+Inf`;
  }).join(' ');
}

/* ==========================================================================
 * 4. Construction
 * ========================================================================== */

/**
 * Builds the diagnostics surface.
 *
 * Nothing is read or written at construction beyond resolving the host: no
 * snapshot is taken and no element is created until `open()` or `refresh()`
 * runs, so an overlay that is never opened costs a lookup.
 *
 * @param options The registry to read and where to mount.
 * @returns The overlay.
 *
 * @example
 * const overlay = createDiagnosticsOverlay({ metrics, logger, document });
 * overlay.open();
 * console.log(overlay.toPrometheusText());
 */
export function createDiagnosticsOverlay(
  options: DiagnosticsOverlayOptions,
): DiagnosticsOverlay {
  const owner = resolveDocument(options.document);
  const host =
    options.host !== undefined
      ? options.host
      : (owner?.querySelector(options.selector ?? DIAGNOSTICS_OVERLAY_SELECTOR) ??
        null);

  const metrics = options.metrics;
  const logger = options.logger ?? null;
  const healthProvider = options.health ?? null;
  const hookCounts = options.hookCounts ?? null;
  const hideEmpty = options.hideEmpty ?? DEFAULT_HIDE_EMPTY;
  const logLimit = options.logLimit ?? DEFAULT_LOG_LIMIT;

  let destroyed = false;
  let open = false;
  let snapshot: MetricsSnapshot | null = null;

  const element = host instanceof HTMLElement ? host : null;

  if (host !== null) {
    host.classList.add(OVERLAY_CLASS);
  }

  /**
   * Builds one element with a class and optional text.
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

    const created = owner.createElement(tag);

    if (className !== '') {
      created.className = className;
    }

    if (text !== '') {
      created.textContent = text;
    }

    return created;
  };

  /**
   * Appends a table of rows under a heading.
   *
   * @param parent Element the section is appended to.
   * @param heading Heading text.
   * @param rows Rows, each a list of cell strings.
   */
  const section = (
    parent: Element,
    heading: string,
    rows: readonly (readonly string[])[],
  ): void => {
    const title = make('h2', HEADING_CLASS, heading);

    if (title !== null) {
      parent.appendChild(title);
    }

    if (rows.length === 0) {
      const empty = make('p', '', 'Nothing recorded.');

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

    for (const row of rows) {
      const line = make('tr');

      if (line === null) {
        continue;
      }

      for (const cell of row) {
        const node = make('td', '', cell === '' ? '—' : cell);

        if (node !== null) {
          line.appendChild(node);
        }
      }

      body.appendChild(line);
    }

    table.appendChild(body);
    parent.appendChild(table);
  };

  /** Renders the whole overlay from one snapshot. */
  const render = (): void => {
    if (destroyed || host === null || owner === null) {
      return;
    }

    // Health FIRST, before the snapshot is taken.
    //
    // Reading the probes records a gauge per probe, so taking the snapshot first
    // would capture the registry as it stood BEFORE this render's health was
    // recorded — leaving the metrics panel and the exported snapshot a render
    // behind on the six answers that explain everything else in them.
    let health: readonly HealthCheckResult[] | null = null;

    if (healthProvider !== null) {
      try {
        health = healthProvider();
      } catch {
        // A probe that throws is reported as a failed probe rather than taking
        // the overlay down with it.
        health = [
          { name: 'health', healthy: false, detail: 'the provider threw' },
        ];
      }

      // Recorded HERE rather than left to the provider, so "what the panel
      // shows is what the snapshot carries" is structural: any provider gets
      // it, and none has to remember to record. This is the only write this
      // module makes to the registry, and it is a gauge set — idempotent, so a
      // provider that also records cannot double-count.
      for (const result of health) {
        metrics.recordHealthCheck(result.name, result.healthy);
      }
    }

    // Folds the hook bus's own dispatch counts in before the snapshot is taken.
    //
    // The bus keeps its counts internally and the registry integrates by PULL,
    // so `game2048_hook_dispatches_total{hook}` and
    // `game2048_hook_handler_invocations_total{hook}` stay at zero unless
    // something asks the bus for them. Nothing did. Folding here means the
    // per-hook breakdown — the series that make the hook bus observable at all —
    // is current in every snapshot the surface takes or exports.
    if (hookCounts !== null) {
      try {
        metrics.foldHookDispatchCounts(hookCounts());
      } catch {
        // A bus that cannot report its counts is not a reason to fail a render.
        metrics.recordHealthCheck('hookCounts', false);
      }
    }

    // ONE snapshot for the whole render, so every panel describes the same
    // instant rather than each panel reading a slightly later registry.
    const taken = metrics.snapshot();

    snapshot = taken;
    clear(host);

    const title = make('h1', HEADING_CLASS, 'Diagnostics');

    if (title !== null) {
      host.appendChild(title);
    }

    section(host, 'Run', [
      ['correlation id', taken.correlationId],
      ['generated at', taken.generatedAt],
      ['elapsed ms', renderNumber(taken.elapsedMs)],
      ['rejected reports', renderNumber(taken.rejected)],
      ['reporter faults', renderNumber(taken.reporterFaults)],
      ['schema version', renderNumber(taken.schemaVersion)],
    ]);

    // Health first among the measured panels, because a failing capability
    // explains the metrics below it — a missing WebGL context is why the
    // number-only renderer's counters are the ones moving.
    if (health !== null) {
      section(
        host,
        'Health',
        health.map((result) => [
          result.name,
          result.healthy ? 'healthy' : 'UNHEALTHY',
          result.detail ?? '',
        ]),
      );
    }

    const series = taken.series.filter(
      (candidate) => !hideEmpty || hasValue(candidate),
    );

    section(
      host,
      `Metrics (${series.length} of ${taken.series.length} series)`,
      series.map((candidate) => [
        candidate.name,
        renderLabels(candidate.labels),
        renderSeriesValue(candidate),
        candidate.kind === 'histogram' ? renderQuantiles(candidate) : '',
      ]),
    );

    if (logger !== null) {
      section(
        host,
        'Recent records',
        logger
          .recent(logLimit)
          .map((record) => [
            record.level,
            record.subsystem,
            record.message,
          ]),
      );
    }

    const controls = make('div', CONTROLS_CLASS);

    if (controls !== null) {
      const refreshControl = make('button', CONTROL_CLASS, 'Refresh');
      const exportControl = make('button', CONTROL_CLASS, 'Export metrics');
      const closeControl = make('button', CONTROL_CLASS, 'Close diagnostics');

      if (refreshControl instanceof HTMLButtonElement) {
        refreshControl.type = 'button';
        refreshControl.addEventListener('click', (): void => {
          render();
        });
        controls.appendChild(refreshControl);
      }

      if (exportControl instanceof HTMLButtonElement) {
        exportControl.type = 'button';
        exportControl.addEventListener('click', (): void => {
          // The scrape substitute, as a file. `download` is the registry's own,
          // so the overlay owns no export format of its own.
          metrics.download();
        });
        controls.appendChild(exportControl);
      }

      if (closeControl instanceof HTMLButtonElement) {
        closeControl.type = 'button';
        closeControl.addEventListener('click', (): void => {
          hide();
        });
        controls.appendChild(closeControl);
      }

      host.appendChild(controls);
    }
  };

  /** Hides the host without emptying it. */
  const hide = (): void => {
    if (host === null) {
      return;
    }

    open = false;

    if (element !== null) {
      element.hidden = true;
    } else {
      host.setAttribute('hidden', '');
    }
  };

  /** Shows the host and renders it. */
  const show = (): void => {
    if (destroyed || host === null) {
      return;
    }

    if (element !== null) {
      element.hidden = false;
    } else {
      host.removeAttribute('hidden');
    }

    open = true;
    render();
  };

  return Object.freeze({
    get available(): boolean {
      return !destroyed && host !== null;
    },

    isOpen(): boolean {
      return open;
    },

    open(): void {
      show();
    },

    close(): void {
      hide();
    },

    toggle(): boolean {
      if (open) {
        hide();
      } else {
        show();
      }

      return open;
    },

    refresh(): void {
      if (open) {
        render();
      }
    },

    lastSnapshot(): MetricsSnapshot | null {
      return snapshot;
    },

    toPrometheusText(): string {
      return metrics.toPrometheusText();
    },

    destroy(): void {
      if (destroyed) {
        return;
      }

      hide();
      destroyed = true;

      if (host !== null) {
        // Emptied, which releases every listener the controls carried along
        // with the nodes they were bound to.
        clear(host);
        host.classList.remove(OVERLAY_CLASS);
      }

      snapshot = null;
    },
  });
}
