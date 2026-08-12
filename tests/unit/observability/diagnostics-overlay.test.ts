// Contract suite for the diagnostics surface, Rule 3.
//
// The defect it closes: the registry was write-only. Counters moved and
// nothing could read one, so no count, timing or health result was observable
// anywhere.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ENGINE_EVENT_NAMES } from '../../../src/engine/engine-events';
import type { HookBusMetrics } from '../../../src/engine/hook-bus';
import { HOOK_NAMES } from '../../../src/engine/hooks';
import { RNG_STREAM_NAMES } from '../../../src/rng/rng-streams';
import {
  DIAGNOSTICS_FLAG,
  DIAGNOSTICS_SNAPSHOT_SCHEMA_VERSION,
  createDiagnosticsOverlay,
  isDiagnosticsRequested,
} from '../../../src/observability/diagnostics-overlay';
import type {
  DiagnosticsOverlay,
  DiagnosticsSnapshot,
  HealthSurfaceView,
} from '../../../src/observability/diagnostics-overlay';
import {
  HEALTH_CHECK_IDS,
  HEALTH_CHECK_SOURCES,
} from '../../../src/observability/health';
import type {
  HealthCheckResult as HealthSurfaceCheckResult,
  HealthReport,
  HealthStatus,
  ReadinessReport,
} from '../../../src/observability/health';
import type {
  SpanName,
  SpanRecord,
  Tracer,
  TraceSnapshot,
} from '../../../src/observability/tracer';
import {
  SPAN_NAMES,
  createBoundaryTracing,
  createTracer,
} from '../../../src/observability/tracer';
import {
  brightTextColor,
  derivedColors,
  fieldWidth,
  gridSpacing,
  monospaceStack,
  tileBorderRadius,
  zIndex,
} from '../../../src/theme/tokens';
import {
  METRIC_NAMES,
  METRIC_PREFIX,
  createMetricsRegistry,
} from '../../../src/observability/metrics';
import type { MetricsRegistry } from '../../../src/observability/metrics';
import { createLogger, deriveCorrelationId } from '../../../src/observability/logger';
import type { Logger } from '../../../src/observability/logger';

/** Selector the control row's buttons are read back by. */
const CONTROL_QUERY = '.diagnostics-controls button';

const HOST_MARKUP =
  '<div class="diagnostics-overlay" id="diagnostics-overlay" hidden></div>';

let overlay: DiagnosticsOverlay | null = null;

/**
 * The rendered text of the fixture host, whitespace collapsed.
 *
 * @returns The text, empty where the host is absent.
 */
const hostText = (): string => {
  const host = document.querySelector<HTMLElement>('#diagnostics-overlay');

  return (host?.textContent ?? '').replace(/\s+/g, ' ').trim();
};

/**
 * The rendered rows of the metrics panel, one string per row.
 *
 * A metric row is the only row whose first cell is a metric name, so the rows
 * are read whole and matched by prefix rather than by panel position.
 *
 * @param host Host the surface rendered into.
 * @returns One entry per rendered row, cells separated by a space.
 */
const renderedSeries = (host: HTMLElement): readonly string[] =>
  Array.from(host.querySelectorAll('tr'))
    .map((row: Element): string =>
      Array.from(row.querySelectorAll('td'))
        .map((cell: Element): string => (cell.textContent ?? '').trim())
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((row: string): boolean => row.startsWith(METRIC_PREFIX));

/**
 * The heading text of every panel the surface rendered.
 *
 * @param host Host the surface rendered into.
 * @returns One entry per panel heading.
 */
const panelHeadings = (host: HTMLElement): readonly string[] =>
  Array.from(host.querySelectorAll('h2')).map((heading: Element): string =>
    (heading.textContent ?? '').replace(/\s+/g, ' ').trim(),
  );

beforeEach(() => {
  document.body.innerHTML = HOST_MARKUP;
});

afterEach(() => {
  overlay?.destroy();
  overlay = null;
  document.body.innerHTML = '';
});

interface Harness {
  readonly overlay: DiagnosticsOverlay;
  readonly metrics: MetricsRegistry;
  readonly logger: Logger;
  readonly host: HTMLElement;

  /** The surface's rendered text, whitespace collapsed. */
  text(): string;
}

const setup = (
  options: {
    health?: () => readonly {
      name: string;
      healthy: boolean;
      detail?: string;
    }[];
    hideEmpty?: boolean;
  } = {},
): Harness => {
  const host = document.querySelector<HTMLElement>('#diagnostics-overlay');

  if (host === null) {
    throw new Error('the fixture lost the host');
  }

  const logger = createLogger({
    correlationId: deriveCorrelationId('diagnostics-seed', 'diagnostics-run'),
    subsystem: 'test',
    consoleOutput: false,
  });
  const metrics = createMetricsRegistry({ logger });
  const built = createDiagnosticsOverlay({
    metrics,
    logger,
    document,
    ...(options.health === undefined ? {} : { health: options.health }),
    ...(options.hideEmpty === undefined ? {} : { hideEmpty: options.hideEmpty }),
  });

  overlay = built;

  return {
    overlay: built,
    metrics,
    logger,
    host,
    text: (): string => (host.textContent ?? '').replace(/\s+/g, ' ').trim(),
  };
};

describe('the surface lifecycle', () => {
  it('resolves its host and starts closed', () => {
    const harness = setup();

    expect(harness.overlay.available).toBe(true);
    expect(harness.overlay.isOpen()).toBe(false);
    expect(harness.host.hidden).toBe(true);
  });

  it('renders nothing until it is opened', () => {
    const harness = setup();

    // An overlay nobody opens costs a lookup and no snapshot.
    expect(harness.overlay.lastSnapshot()).toBeNull();
    expect(harness.text()).toBe('');
  });

  it('opens, closes and toggles', () => {
    const harness = setup();

    harness.overlay.open();

    expect(harness.overlay.isOpen()).toBe(true);
    expect(harness.host.hidden).toBe(false);

    harness.overlay.close();

    expect(harness.overlay.isOpen()).toBe(false);
    expect(harness.host.hidden).toBe(true);

    expect(harness.overlay.toggle()).toBe(true);
    expect(harness.overlay.toggle()).toBe(false);
  });

  it('reports itself unavailable where no host resolves', () => {
    document.body.innerHTML = '';

    const metrics = createMetricsRegistry();
    const built = createDiagnosticsOverlay({ metrics, document });

    overlay = built;

    expect(built.available).toBe(false);

    expect(() => {
      built.open();
      built.refresh();
      built.close();
      built.toggle();
    }).not.toThrow();
    expect(built.isOpen()).toBe(false);
  });

  it('is inert and empty after destroy, more than once over', () => {
    const harness = setup();

    harness.overlay.open();
    harness.overlay.destroy();

    expect(harness.overlay.available).toBe(false);
    expect(harness.host.hidden).toBe(true);
    expect(harness.text()).toBe('');
    expect(harness.overlay.lastSnapshot()).toBeNull();

    expect(() => {
      harness.overlay.destroy();
      harness.overlay.open();
    }).not.toThrow();
  });

  it('leaves EVERY read and export member inert after destroy', () => {
    // The whole retained surface, not just the ones that touch the host.
    const reads = {
      health: 0,
      hooks: 0,
      tracer: 0,
    };
    const metrics = createMetricsRegistry();
    const logger = createLogger({ consoleOutput: false });
    const chain = traceOneChain();
    const built = createDiagnosticsOverlay({
      metrics,
      logger,
      document,

      health: (): readonly { name: string; healthy: boolean }[] => {
        reads.health += 1;

        return [{ name: 'webgl', healthy: true }];
      },

      hookCounts: () => {
        reads.hooks += 1;

        return fabricatedHookCounts();
      },

      tracer: {
        snapshot: (limit?: number) => {
          reads.tracer += 1;

          return chain.tracer.snapshot(limit);
        },
      },
    });

    overlay = built;
    built.mount();
    built.open();

    expect(reads.health).toBeGreaterThan(0);
    expect(reads.hooks).toBeGreaterThan(0);
    expect(reads.tracer).toBeGreaterThan(0);

    const seriesBefore = metrics.snapshot().series.length;

    built.destroy();

    const after = { ...reads };
    const clicks: string[] = [];
    const created: string[] = [];
    const revoked: string[] = [];

    // Any download would go through these three, so counting them is how a
    // blob created after disposal is caught.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
      function click(this: HTMLAnchorElement): void {
        clicks.push(this.download);
      },
    );
    vi.spyOn(URL, 'createObjectURL').mockImplementation((): string => {
      created.push('url');

      return 'blob:diagnostics-after-destroy';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string): void => {
      revoked.push(url);
    });

    const prometheus = built.toPrometheusText();
    const snapshot = built.snapshot();
    const json = built.snapshotJson();

    expect(prometheus).toBe('');

    // The documented inert values, which are not a serialisation of the inert
    // envelope: the exporter yields the empty string so a caller cannot
    // mistake a disposed overlay's reading for a real one, while `snapshot`
    // yields the frozen empty envelope so a caller reading fields is not
    // handed `null`.
    expect(json).toBe('');
    expect(built.exportPrometheusText()).toBe(false);
    expect(built.exportSnapshotJson()).toBe(false);

    // Documented inert values: an empty envelope with every source absent.
    expect(DIAGNOSTICS_SNAPSHOT_SCHEMA_VERSION).toBeGreaterThan(0);
    expect(snapshot.schemaVersion).toBe(0);
    expect(snapshot.correlationId).toBe('');
    expect(snapshot.health.status).toBeNull();
    expect(snapshot.health.checks).toHaveLength(0);
    expect(snapshot.health.report).toBeNull();
    expect(snapshot.health.readiness).toBeNull();
    expect(snapshot.traces).toBeNull();
    expect(snapshot.hooks).toHaveLength(0);
    expect(snapshot.logs).toHaveLength(0);
    expect(snapshot.metrics.series).toHaveLength(0);

    // Zero provider reads, zero folds into the registry, zero object URLs and
    // zero clicks.
    expect(reads).toEqual(after);
    expect(metrics.snapshot().series.length).toBe(seriesBefore);
    expect(created).toHaveLength(0);
    expect(revoked).toHaveLength(0);
    expect(clicks).toHaveLength(0);
    expect(document.body.querySelector('a')).toBeNull();
    expect(built.lastSnapshot()).toBeNull();
  });
});

describe('the surface reports the registry', () => {
  it('shows a counter that was incremented', () => {
    const harness = setup();

    harness.metrics.counter(`${METRIC_PREFIX}probe_total`).inc(3);
    harness.overlay.open();

    const text = harness.text();

    // The whole defect was that this was unobservable.
    expect(text).toContain('probe_total');
    expect(text).toContain('3');
  });

  it('carries the correlation identifier, so a surface is attributable', () => {
    const harness = setup();

    harness.overlay.open();

    expect(harness.text()).toContain(harness.logger.correlationId);
    expect(harness.overlay.lastSnapshot()?.correlationId).toBe(
      harness.logger.correlationId,
    );
  });

  it('summarises a histogram by count and sum', () => {
    const harness = setup();

    harness.metrics.recordSpanDuration('turn', 4);
    harness.metrics.recordSpanDuration('turn', 6);
    harness.overlay.open();

    const text = harness.text();

    expect(text).toContain('n=2');
    expect(text).toContain('sum=10');
  });

  it('hides empty series by default and shows them on request', () => {
    const quiet = setup();

    quiet.metrics.counter(`${METRIC_PREFIX}silent_total`);
    quiet.overlay.open();

    const hidden = quiet.text();

    quiet.overlay.destroy();
    document.body.innerHTML = HOST_MARKUP;

    const loud = setup({ hideEmpty: false });

    loud.metrics.counter(`${METRIC_PREFIX}silent_total`);
    loud.overlay.open();

    // A registry declares many families up front; showing every zero would
    // bury the handful that moved.
    expect(hidden).not.toContain('silent_total');
    expect(loud.text()).toContain('silent_total');
  });

  it('shows the core counters before anything has happened', () => {
    const harness = setup();

    harness.overlay.open();

    const text = harness.text();

    // The defect: every one of these read zero at rest and the filter hid
    // them, so the panel omitted the skeleton a reader checks a reading
    // against. DL-DIAG-12.
    for (const name of [
      METRIC_NAMES.turnsTotal,
      METRIC_NAMES.mergesTotal,
      METRIC_NAMES.spawnsTotal,
      METRIC_NAMES.spawnAttemptsTotal,
      METRIC_NAMES.spawnSuppressedTotal,
      METRIC_NAMES.framesRenderedTotal,
      METRIC_NAMES.metricsRejectedTotal,
    ]) {
      expect(text).toContain(name);
    }
  });

  it('shows every engine-event and hook-dispatch series at zero', () => {
    const harness = setup();

    harness.overlay.open();

    const rendered = renderedSeries(harness.host);
    const events = rendered.filter((row: string): boolean =>
      row.startsWith(METRIC_NAMES.engineEventsTotal),
    );
    const hooks = rendered.filter((row: string): boolean =>
      row.startsWith(METRIC_NAMES.hookDispatchesTotal),
    );

    // One row per canonical dimension member, whatever it reads: after a move
    // four of the six hook rows still read zero, and their absence read as
    // "not dispatched" being unobservable rather than as zero.
    expect(events).toHaveLength(ENGINE_EVENT_NAMES.length);
    expect(hooks).toHaveLength(HOOK_NAMES.length);

    for (const hook of HOOK_NAMES) {
      expect(hooks.some((row: string): boolean => row.includes(hook))).toBe(
        true,
      );
    }
  });

  it('shows every RNG substream counter at zero', () => {
    const harness = setup();

    // A fresh run has folded its cursors once, at zero, so all four series
    // exist and all four read zero.
    harness.metrics.recordRngCursors({
      'spawn-value': 0,
      'spawn-position': 0,
      'relic-draw': 0,
      'rarity-weight': 0,
    });
    harness.overlay.open();

    const streams = renderedSeries(harness.host).filter((row: string): boolean =>
      row.startsWith(METRIC_NAMES.rngDrawsTotal),
    );

    // Determinism is the product's headline property, and two of the four
    // substreams read zero until a reward is drawn. DL-DIAG-12.
    expect(streams).toHaveLength(RNG_STREAM_NAMES.length);

    for (const stream of RNG_STREAM_NAMES) {
      expect(streams.some((row: string): boolean => row.includes(stream))).toBe(
        true,
      );
    }
  });

  it('shows a gauge reading zero, because zero is a reading', () => {
    const harness = setup({
      health: () => [
        { name: 'storage', healthy: false, detail: 'writes refused' },
      ],
    });

    harness.overlay.open();

    const storage = renderedSeries(harness.host).find(
      (row: string): boolean =>
        row.startsWith(METRIC_NAMES.healthCheckStatus) &&
        row.includes('check="storage"'),
    );

    // `health_check_status` at zero means UNHEALTHY, so the old filter hid
    // precisely the check an operator opened the surface to see.
    expect(storage).toBeDefined();
    expect(storage).toContain(' 0');
  });

  it('states how many series it is not showing, and where they are', () => {
    const harness = setup();

    harness.metrics.counter(`${METRIC_PREFIX}quiet_a_total`);
    harness.metrics.counter(`${METRIC_PREFIX}quiet_b_total`);
    harness.overlay.open();

    const heading = panelHeadings(harness.host).find((text: string): boolean =>
      text.startsWith('Metrics ('),
    );

    // A bare "60 of 120 series" left a reader to guess what the other sixty
    // were and whether they had been lost. DL-DIAG-12.
    expect(heading).toMatch(
      /^Metrics \(\d+ of \d+ series, \d+ at zero hidden here and exported\)$/,
    );

    const shown = Number(/\((\d+) of/.exec(heading ?? '')?.[1] ?? '0');
    const total = Number(/of (\d+) series/.exec(heading ?? '')?.[1] ?? '0');
    const hiddenCount = Number(
      /series, (\d+) at zero/.exec(heading ?? '')?.[1] ?? '0',
    );

    expect(total - shown).toBe(hiddenCount);
    expect(total).toBe(harness.metrics.snapshot().series.length);
  });

  it('drops the qualifier when it is hiding nothing', () => {
    const harness = setup({ hideEmpty: false });

    harness.overlay.open();

    const heading = panelHeadings(harness.host).find((text: string): boolean =>
      text.startsWith('Metrics ('),
    );

    expect(heading).toMatch(/^Metrics \(\d+ series\)$/);
  });

  it('shows recent log records', () => {
    const harness = setup();

    harness.logger.info('a recorded line');
    harness.overlay.open();

    expect(harness.text()).toContain('a recorded line');
  });

  it('re-reads on refresh, and not while closed', () => {
    const harness = setup();

    harness.overlay.open();
    harness.metrics.counter(`${METRIC_PREFIX}later_total`).inc(7);

    // Closed: no re-read, so the rendered surface is whatever the last open
    // produced.
    harness.overlay.close();
    harness.overlay.refresh();

    expect(harness.text()).not.toContain('later_total');

    harness.overlay.open();

    expect(harness.text()).toContain('later_total');
  });

  it('describes one instant, not a moving registry', () => {
    const harness = setup();

    harness.metrics.counter(`${METRIC_PREFIX}instant_total`).inc(1);
    harness.overlay.open();

    const captured = harness.overlay.lastSnapshot();

    harness.metrics.counter(`${METRIC_PREFIX}instant_total`).inc(1);

    // The retained snapshot is the one the render read, so a panel and the
    // snapshot it came from cannot disagree.
    const series = captured?.series.find((candidate) =>
      candidate.name.includes('instant_total'),
    );

    expect(series?.kind === 'counter' ? series.value : -1).toBe(1);
  });
});

describe('the health panel', () => {
  it('reports each probe and its verdict', () => {
    const harness = setup({
      health: () => [
        { name: 'webgl', healthy: false, detail: 'level none' },
        { name: 'storage', healthy: true, detail: 'strategy local' },
      ],
    });

    harness.overlay.open();

    const text = harness.text();

    expect(text).toContain('webgl');
    expect(text).toContain('UNHEALTHY');
    expect(text).toContain('level none');
    expect(text).toContain('storage');
    expect(text).toContain('healthy');
  });

  it('records the verdicts into the registry as well as on screen', () => {
    const recorded: string[] = [];
    const harness = setup({
      health: () => {
        recorded.push('read');

        return [{ name: 'webgl', healthy: true }];
      },
    });

    harness.overlay.open();

    // The same six answers belong in the snapshot, not only in the DOM, so a
    // scrape substitute carries them too.
    const series = harness.overlay
      .lastSnapshot()
      ?.series.filter((candidate) => candidate.name.includes('health_check'));

    expect(recorded).toHaveLength(1);
    expect(series?.length ?? 0).toBeGreaterThan(0);
  });

  it('re-reads the probes on every render, so a later failure shows', () => {
    let healthy = true;
    const harness = setup({
      health: () => [{ name: 'webgl', healthy }],
    });

    harness.overlay.open();

    expect(harness.text()).not.toContain('UNHEALTHY');

    healthy = false;
    harness.overlay.refresh();

    expect(harness.text()).toContain('UNHEALTHY');
  });

  it('reports a throwing provider as a failed probe rather than falling over', () => {
    const harness = setup({
      health: () => {
        throw new Error('probe exploded');
      },
    });

    expect(() => {
      harness.overlay.open();
    }).not.toThrow();

    // The surface still renders, and says the probe is the thing that failed.
    expect(harness.text()).toContain('UNHEALTHY');
    expect(harness.text()).toContain('the provider threw');
    expect(harness.overlay.isOpen()).toBe(true);
  });
});

describe('the exported snapshot', () => {
  it('exports Prometheus text carrying a recorded counter', () => {
    const harness = setup();

    harness.metrics.counter(`${METRIC_PREFIX}exported_total`).inc(5);

    const text = harness.overlay.toPrometheusText();

    expect(text).toContain('exported_total');
    expect(text).toContain('# TYPE');
  });

  it('exports without the surface ever being opened', () => {
    const harness = setup();

    harness.metrics.counter(`${METRIC_PREFIX}unopened_total`).inc(2);

    // The endpoint substitute must not require a human to open a panel first.
    expect(harness.overlay.isOpen()).toBe(false);
    expect(harness.overlay.toPrometheusText()).toContain('unopened_total');
  });
});

describe('the surface controls', () => {
  it('offers refresh, export, collapse and close as real buttons', () => {
    const harness = setup();

    harness.overlay.open();

    const controls = Array.from(
      harness.host.querySelectorAll<HTMLButtonElement>(
        '.diagnostics-controls button',
      ),
    );

    // The snapshot export sits beside the Prometheus one: the combined JSON is
    // what docs/dashboards/dashboard.html renders against. The collapse control
    // sits before the one that closes the surface outright, because it is the
    // lesser of the two recoveries from a panel that covers the page it floats
    // over. DL-DIAG-11.
    expect(controls.map((control) => control.textContent)).toEqual([
      'Refresh',
      'Export metrics',
      'Export snapshot',
      'Collapse diagnostics',
      'Close diagnostics',
    ]);

    for (const control of controls) {
      expect(control.type).toBe('button');
      expect(control.disabled).toBe(false);
    }
  });

  it('re-renders from its own refresh control', () => {
    const harness = setup();

    harness.overlay.open();
    harness.metrics.counter(`${METRIC_PREFIX}clicked_total`).inc(4);

    const refresh = Array.from(
      harness.host.querySelectorAll<HTMLButtonElement>('button'),
    ).find((control) => control.textContent === 'Refresh');

    refresh?.click();

    expect(harness.text()).toContain('clicked_total');
  });

  it('closes from its own close control', () => {
    const harness = setup();

    harness.overlay.open();

    const close = Array.from(
      harness.host.querySelectorAll<HTMLButtonElement>('button'),
    ).find((control) => control.textContent === 'Close diagnostics');

    close?.click();

    expect(harness.overlay.isOpen()).toBe(false);
    expect(harness.host.hidden).toBe(true);
  });
});

describe('the activation gate', () => {
  it('defaults to off with no flag anywhere', () => {
    expect(isDiagnosticsRequested({})).toBe(false);
    expect(isDiagnosticsRequested({ search: '', hash: '' })).toBe(false);
    expect(isDiagnosticsRequested({ search: '?other=1', hash: '#board' })).toBe(
      false,
    );

    // The recorded-gameplay run sets nothing, so this is the case that keeps
    // an overlay at z-index 500 out of the video.
    expect(isDiagnosticsRequested(null)).toBe(false);
  });

  it('defaults to off for the running document, which sets no flag', () => {
    expect(isDiagnosticsRequested()).toBe(false);
  });

  it('opts in on a bare query flag, a value and a fragment', () => {
    expect(isDiagnosticsRequested({ search: `?${DIAGNOSTICS_FLAG}` })).toBe(
      true,
    );
    expect(isDiagnosticsRequested({ search: `?${DIAGNOSTICS_FLAG}=1` })).toBe(
      true,
    );
    expect(
      isDiagnosticsRequested({ search: `?seed=abc&${DIAGNOSTICS_FLAG}=on` }),
    ).toBe(true);
    expect(isDiagnosticsRequested({ hash: `#${DIAGNOSTICS_FLAG}` })).toBe(true);
    expect(
      isDiagnosticsRequested({ hash: `#screen=hud&${DIAGNOSTICS_FLAG}=true` }),
    ).toBe(true);
  });

  it('declines an explicitly negative value', () => {
    for (const value of ['0', 'false', 'off', 'no', 'FALSE', ' Off ']) {
      expect(
        isDiagnosticsRequested({ search: `?${DIAGNOSTICS_FLAG}=${value}` }),
      ).toBe(false);
    }
  });

  it('decodes a percent-encoded flag name', () => {
    expect(isDiagnosticsRequested({ search: '?%64iagnostics=1' })).toBe(true);
  });

  it('reads the flag NAME case-insensitively, as it reads the value', () => {
    // The trap this closes: the value was already case-insensitive and trimmed,
    // so `?diagnostics=OFF` was understood while `?DIAGNOSTICS` was not read as
    // a flag at all and the surface silently stayed off. DL-DIAG-13.
    for (const name of [
      'DIAGNOSTICS',
      'Diagnostics',
      'dIaGnOsTiCs',
      ' diagnostics',
      'diagnostics ',
    ]) {
      expect(isDiagnosticsRequested({ search: `?${name}` })).toBe(true);
      expect(isDiagnosticsRequested({ search: `?${name}=1` })).toBe(true);
      expect(isDiagnosticsRequested({ hash: `#${name}` })).toBe(true);
    }

    // A name that merely contains the flag is still not the flag.
    expect(isDiagnosticsRequested({ search: '?diagnosticsx=1' })).toBe(false);
    expect(isDiagnosticsRequested({ search: '?xdiagnostics=1' })).toBe(false);

    // Case-insensitive on BOTH halves at once.
    expect(isDiagnosticsRequested({ search: '?DIAGNOSTICS=OFF' })).toBe(false);
  });

  it('answers false rather than throwing for a hostile source', () => {
    const hostile = {
      get search(): string {
        throw new Error('the location exploded');
      },
    };

    expect(isDiagnosticsRequested(hostile)).toBe(false);
  });
});

describe('mounting', () => {
  it('creates its own host where the markup declares none', () => {
    document.body.innerHTML = '';

    const overlay = createDiagnosticsOverlay({
      metrics: createMetricsRegistry(),
      document,
    });

    try {
      expect(overlay.available).toBe(false);
      expect(overlay.mount()).toBe(true);
      expect(overlay.available).toBe(true);

      const hosts = document.querySelectorAll('.diagnostics-overlay');
      const host = hosts[0];

      expect(hosts).toHaveLength(1);
      expect(host?.id).toBe('diagnostics-overlay');
      expect(host?.getAttribute('role')).toBe('region');
      expect(host?.getAttribute('aria-label')).toBe('Diagnostics');

      // A developer surface is outside the game's announcement path.
      expect(host?.hasAttribute('aria-live')).toBe(false);
      expect(host instanceof HTMLElement ? host.hidden : false).toBe(true);
    } finally {
      overlay.destroy();
    }
  });

  it('is idempotent: a second mount creates no second host', () => {
    document.body.innerHTML = '';

    const overlay = createDiagnosticsOverlay({
      metrics: createMetricsRegistry(),
      document,
    });

    try {
      expect(overlay.mount()).toBe(true);
      expect(overlay.mount()).toBe(true);
      expect(document.querySelectorAll('.diagnostics-overlay')).toHaveLength(1);
    } finally {
      overlay.destroy();
    }
  });

  it('adopts the declared host instead of building a second one', () => {
    const harness = setup();

    expect(harness.overlay.mount()).toBe(true);
    expect(document.querySelectorAll('.diagnostics-overlay')).toHaveLength(1);
    expect(document.querySelector('.diagnostics-overlay')).toBe(harness.host);
  });

  it('creates nothing where the caller disabled the host explicitly', () => {
    document.body.innerHTML = '';

    const overlay = createDiagnosticsOverlay({
      metrics: createMetricsRegistry(),
      document,
      host: null,
    });

    try {
      expect(overlay.mount()).toBe(false);
      expect(overlay.available).toBe(false);
      expect(document.querySelectorAll('.diagnostics-overlay')).toHaveLength(0);
    } finally {
      overlay.destroy();
    }
  });

  it('removes a host it created and empties one it adopted', () => {
    document.body.innerHTML = '';

    const created = createDiagnosticsOverlay({
      metrics: createMetricsRegistry(),
      document,
    });

    created.mount();
    created.open();
    created.destroy();

    expect(document.querySelectorAll('.diagnostics-overlay')).toHaveLength(0);

    document.body.innerHTML = HOST_MARKUP;

    const adopted = setup();

    adopted.overlay.open();
    adopted.overlay.destroy();

    // The declared element belongs to the markup, so it stays and is emptied.
    expect(document.querySelectorAll('#diagnostics-overlay')).toHaveLength(1);
    expect(adopted.host.textContent).toBe('');
    expect(adopted.host.classList.contains('diagnostics-overlay')).toBe(false);
  });

  it('mounts cleanly again through a fresh overlay after a destroy', () => {
    document.body.innerHTML = '';

    const first = createDiagnosticsOverlay({
      metrics: createMetricsRegistry(),
      document,
    });

    first.mount();
    first.destroy();

    const second = createDiagnosticsOverlay({
      metrics: createMetricsRegistry(),
      document,
    });

    try {
      expect(second.mount()).toBe(true);
      expect(document.querySelectorAll('.diagnostics-overlay')).toHaveLength(1);
    } finally {
      second.destroy();
    }
  });
});

describe('the surface styling', () => {
  it('carries the diagnostics slot of the z-index ladder', () => {
    const harness = setup();

    harness.overlay.mount();

    const style = harness.host.style;

    expect(style.getPropertyValue('z-index')).toBe(
      String(zIndex.diagnosticsOverlay),
    );

    // Above the HUD, the screen overlays and the modal-and-reward layer.
    expect(Number(style.getPropertyValue('z-index'))).toBeGreaterThan(
      zIndex.modal,
    );
    expect(Number(style.getPropertyValue('z-index'))).toBeGreaterThan(
      zIndex.screenOverlay,
    );
    expect(Number(style.getPropertyValue('z-index'))).toBeGreaterThan(
      zIndex.hud,
    );
  });

  it('uses the monospace stack the tokens declare, loading no font', () => {
    const harness = setup();

    harness.overlay.mount();

    expect(harness.host.style.getPropertyValue('font-family')).toBe(
      monospaceStack,
    );
    expect(document.querySelectorAll('link[rel="stylesheet"]')).toHaveLength(0);
    expect(document.querySelectorAll('style')).toHaveLength(0);
  });

  it('never lets its inline display outrank the hidden state', () => {
    const harness = setup();

    harness.overlay.mount();

    expect(harness.host.style.getPropertyValue('display')).toBe('none');

    harness.overlay.open();

    expect(harness.host.style.getPropertyValue('display')).toBe('flex');

    harness.overlay.close();

    expect(harness.host.style.getPropertyValue('display')).toBe('none');
  });

  // DL-DIAG-08. The width the module INLINES is what the surface actually gets,
  // because an inline declaration outranks the stylesheet — so this is the half
  // that decides the rendered width, and it is asserted here as a number rather
  // than as a mirror (the mirror itself is pinned in
  // tests/unit/quality/stylesheet-contract.test.ts).
  it('inlines four fifths of the reading measure as its width', () => {
    const harness = setup();

    harness.overlay.mount();

    expect(harness.host.style.getPropertyValue('inline-size')).toBe(
      `${String((fieldWidth * 4) / 5)}px`,
    );
    expect(harness.host.style.getPropertyValue('inline-size')).toBe('400px');

    // Still bounded against the viewport, so the wider surface cannot escape a
    // screen narrower than it.
    expect(harness.host.style.getPropertyValue('max-inline-size')).toContain(
      '100%',
    );
  });

  // DL-DIAG-08. `anywhere` broke a string at whatever character reached the
  // cell edge, which rendered a health detail as "Function .protoy pe.bind is
  // present." — so the readout wrapped mid-word by declaration, not by width.
  it('wraps a cell at its words rather than at any character', () => {
    const harness = setup();

    harness.overlay.mount();
    harness.overlay.open();

    const cells = Array.from(harness.host.querySelectorAll('td'));

    expect(cells.length).toBeGreaterThan(0);

    for (const cell of cells) {
      expect(cell.style.getPropertyValue('overflow-wrap')).toBe('break-word');
      expect(cell.style.getPropertyValue('overflow-wrap')).not.toBe('anywhere');
    }
  });

  // The even split gave the column holding one short status word the same room
  // as the column holding a sentence. Stating the first two hands the whole
  // remainder to the third, which is the one carrying prose.
  it('states the first two column widths and leaves the third the remainder', () => {
    const harness = setup();

    harness.overlay.mount();
    harness.overlay.open();

    const rows = Array.from(harness.host.querySelectorAll('tr')).filter(
      (row) => row.querySelectorAll('td').length >= 3,
    );

    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td'));

      expect(cells[0]?.style.getPropertyValue('inline-size')).toBe('34%');
      expect(cells[1]?.style.getPropertyValue('inline-size')).toBe('20%');

      // Unstated, so it takes what the first two left rather than an even share.
      expect(cells[2]?.style.getPropertyValue('inline-size')).toBe('');

      // The two stated widths must leave the majority to the prose column.
      expect(34 + 20).toBeLessThan(100 - 34);
    }

    // `table-layout: fixed` is what makes a stated width govern at all, and is
    // also why reducing the min-content contribution was never needed.
    const table = harness.host.querySelector('table');

    expect(table?.style.getPropertyValue('table-layout')).toBe('fixed');
  });

  // DL-DIAG-10. `td:not(:first-child)` justified itself on figures and then
  // right-aligned the Health panel's third column too, which is a sentence in
  // every row — so a detail was set ragged-left and read from its end.
  it('aligns a cell holding a sentence to its start, and only those', () => {
    const harness = setup();

    harness.overlay.mount();
    harness.overlay.open();

    const prose = Array.from(
      harness.host.querySelectorAll<HTMLTableCellElement>(
        'td.diagnostics-prose',
      ),
    );

    expect(prose.length).toBeGreaterThan(0);

    for (const cell of prose) {
      expect(cell.style.getPropertyValue('text-align')).toBe('start');
    }

    // Every OTHER cell states no alignment of its own, so the sheet's
    // end-alignment of the figure columns still governs them.
    const figures = Array.from(
      harness.host.querySelectorAll<HTMLTableCellElement>(
        'td:not(.diagnostics-prose)',
      ),
    );

    expect(figures.length).toBeGreaterThan(0);

    for (const cell of figures) {
      expect(cell.style.getPropertyValue('text-align')).toBe('');
    }
  });

  // DL-DIAG-10, the panel the review measured: the Health rows are the ones
  // whose third column is a sentence.
  it('marks the health detail column as prose, detail text and all', () => {
    const harness = setup({
      health: () => [
        { name: 'webgl', healthy: true, detail: 'WebGL is available at webgl2.' },
        { name: 'storage', healthy: true, detail: 'Web Storage is writable.' },
      ],
    });

    harness.overlay.mount();
    harness.overlay.open();

    const prose = Array.from(
      harness.host.querySelectorAll<HTMLTableCellElement>(
        'td.diagnostics-prose',
      ),
    ).map((cell) => cell.textContent);

    expect(prose).toContain('WebGL is available at webgl2.');
    expect(prose).toContain('Web Storage is writable.');

    // The roll-up sentence beneath the per-check rows is prose too.
    expect(prose.some((text) => (text ?? '').includes('checks: healthy'))).toBe(
      true,
    );
  });
});

describe('the control vocabulary', () => {
  // MINOR finding of the observability review: the controls carry the
  // `screen-button` class, so the sheet was already theming them from
  // `--theme-control-surface` and `--theme-control-label` — and an INLINE
  // declaration outranked it, which left both additive palettes dead on this
  // surface and on no other. DL-DIAG-09.
  it('resolves the themed control pair rather than painting two literals', () => {
    const harness = setup();

    harness.overlay.open();

    const controls = Array.from(
      harness.host.querySelectorAll<HTMLButtonElement>(CONTROL_QUERY),
    );

    expect(controls).toHaveLength(5);

    for (const control of controls) {
      const background = control.style.getPropertyValue('background');
      const color = control.style.getPropertyValue('color');

      expect(background).toContain('var(--theme-control-surface');
      expect(color).toContain('var(--theme-control-label');

      // The token literals survive as the FALLBACK, so the surface still reads
      // correctly with no stylesheet loaded at all.
      expect(background).toContain(derivedColors.controlSurfaceBackground);
      expect(color).toContain(brightTextColor);

      // And the frozen 3.79:1 pair of AAP 0.5.2 is no longer the value.
      expect(background).not.toBe(derivedColors.buttonBackground);
    }
  });

  // DL-DIAG-09. The control pair measures between 1.40:1 and 2.35:1 against the
  // diagnostics panel, so a borderless control has no discernible boundary on
  // it; the edge resolves the panel's own text colour, which measures at least
  // 11:1 against the panel.
  it('draws a hairline edge in the surface text colour rather than none', () => {
    const harness = setup();

    harness.overlay.open();

    for (const control of Array.from(
      harness.host.querySelectorAll<HTMLButtonElement>(CONTROL_QUERY),
    )) {
      const border = control.style.getPropertyValue('border');

      expect(border).toContain(`${String(tileBorderRadius / 3)}px`);
      expect(border).toContain('solid');
      expect(border).toContain('var(--theme-diagnostics-text');
      expect(border).not.toBe('none');
    }
  });

  // DL-DIAG-09. 40px clears WCAG 2.5.8 and falls 4px short of the 44px 2.5.5
  // target size; three grid-spacing units is 45px and states it as a minimum,
  // so the sheet's own 40px stays the used value on every other control.
  it('states a minimum block size that clears the 44px target', () => {
    const harness = setup();

    harness.overlay.open();

    for (const control of Array.from(
      harness.host.querySelectorAll<HTMLButtonElement>(CONTROL_QUERY),
    )) {
      const minimum = control.style.getPropertyValue('min-block-size');

      expect(minimum).toBe(`${String(gridSpacing * 3)}px`);
      expect(gridSpacing * 3).toBeGreaterThanOrEqual(44);
    }
  });
});

describe('the compact form of the surface', () => {
  /**
   * The collapse control of the rendered surface.
   *
   * @param harness Surface to read.
   * @returns The control, or `undefined` where none is rendered.
   */
  const toggle = (harness: Harness): HTMLButtonElement | undefined =>
    Array.from(
      harness.host.querySelectorAll<HTMLButtonElement>(CONTROL_QUERY),
    ).find((control) => (control.textContent ?? '').includes('diagnostics') &&
      (control.textContent ?? '') !== 'Close diagnostics');

  // DL-DIAG-11. The surface is a fixed panel at the top of the layering ladder,
  // so at a narrow width it covers the board and the on-screen controls and a
  // pointer click lands on the panel. Collapsing is the recovery that keeps the
  // readings.
  it('opens expanded, with its panels drawn', () => {
    const harness = setup();

    harness.overlay.open();

    // A panel with no row renders its empty line rather than a table, so the
    // count is the panels this harness has readings for rather than all six.
    const drawn = harness.host.querySelectorAll('table').length;

    expect(drawn).toBeGreaterThan(0);
    expect(harness.host.querySelectorAll('h2').length).toBeGreaterThan(0);
    expect(harness.host.getAttribute('data-collapsed')).toBeNull();
    expect(toggle(harness)?.textContent).toBe('Collapse diagnostics');
    expect(toggle(harness)?.getAttribute('aria-expanded')).toBe('true');
  });

  it('collapses to its heading and control row, and expands again', () => {
    const harness = setup();

    harness.overlay.open();

    const expanded = harness.host.querySelectorAll('table').length;

    expect(expanded).toBeGreaterThan(0);

    toggle(harness)?.click();

    expect(harness.host.querySelectorAll('table')).toHaveLength(0);
    expect(harness.host.querySelectorAll('h2')).toHaveLength(0);
    expect(harness.host.getAttribute('data-collapsed')).toBe('true');
    expect(harness.host.querySelectorAll('h1')).toHaveLength(1);
    expect(harness.host.querySelectorAll(CONTROL_QUERY)).toHaveLength(5);
    expect(toggle(harness)?.textContent).toBe('Expand diagnostics');
    expect(toggle(harness)?.getAttribute('aria-expanded')).toBe('false');

    // The surface is still open, and still refreshes.
    expect(harness.overlay.isOpen()).toBe(true);

    toggle(harness)?.click();

    expect(harness.host.querySelectorAll('table')).toHaveLength(expanded);
    expect(harness.host.getAttribute('data-collapsed')).toBeNull();
    expect(toggle(harness)?.textContent).toBe('Collapse diagnostics');
  });

  // Collapsing changes what is DRAWN and nothing about what is read: the fold,
  // the metrics reading and the health check all still run, so an export taken
  // while collapsed carries the same bytes. DL-DIAG-11.
  it('keeps taking every reading while it draws no panel', () => {
    const harness = setup();

    harness.overlay.open();
    toggle(harness)?.click();
    harness.metrics.counter(`${METRIC_PREFIX}collapsed_total`).inc(3);
    harness.overlay.refresh();

    const snapshot = harness.overlay.lastSnapshot();

    expect(
      snapshot?.series.some(
        (series) => series.name === `${METRIC_PREFIX}collapsed_total`,
      ),
    ).toBe(true);
    expect(harness.overlay.toPrometheusText()).toContain('collapsed_total');
    expect(harness.overlay.snapshotJson()).toContain('"health"');

    // And nothing of the panels is on screen while it does that.
    expect(harness.host.querySelectorAll('table')).toHaveLength(0);
  });

  it('leaves no collapsed state on a host it releases', () => {
    const harness = setup();

    harness.overlay.open();
    toggle(harness)?.click();

    expect(harness.host.getAttribute('data-collapsed')).toBe('true');

    harness.overlay.destroy();

    expect(harness.host.getAttribute('data-collapsed')).toBeNull();
  });
});

/**
 * Builds one fabricated check result.
 *
 * @param id Check id.
 * @param status Verdict.
 * @param detail What was observed.
 * @returns The result.
 */
const checkResult = (
  id: (typeof HEALTH_CHECK_IDS)[number],
  status: HealthStatus,
  detail: string,
): HealthSurfaceCheckResult => ({
  id,
  status,
  detail,
  data: {},
  source: HEALTH_CHECK_SOURCES[id],
  durationMs: 0,
});

/** A fabricated report carrying one result per check id. */
const fabricatedReport = (): HealthReport => {
  const statuses: Readonly<Record<string, HealthStatus>> = {
    functionBind: 'pass',
    classList: 'pass',
    requestAnimationFrame: 'pass',
    pointerEvents: 'not-applicable',
    storage: 'pass',
    webgl: 'fail',
  };
  const checks = HEALTH_CHECK_IDS.map((id) =>
    checkResult(id, statuses[id] ?? 'pass', `observed ${id}`),
  );

  return {
    status: 'fail',
    checks,
    counts: { pass: 4, fail: 1, 'not-applicable': 1 },
    correlationId: 'run-fabricated',
    timestamp: '2026-01-01T00:00:00.000Z',
    durationMs: 1,
  };
};

/** A fabricated readiness report. */
const fabricatedReadiness = (): ReadinessReport => ({
  ready: false,
  renderer: 'number-only',
  mayMountWebGLRenderer: false,
  requiresNumberOnlyFallback: true,
  webglLevel: 'none',
  webglFailure: 'no context',
  storage: 'persistent',
  storageStrategy: 'local',
  webglStatus: 'fail',
  storageStatus: 'pass',
  healthStatus: 'fail',
  correlationId: 'run-fabricated',
  timestamp: '2026-01-01T00:00:00.000Z',
});

/** A health surface over the fabricated report. */
const fabricatedSurface = (): HealthSurfaceView => ({
  report: (): HealthReport => fabricatedReport(),
  readiness: (): ReadinessReport => fabricatedReadiness(),
});

describe('the health panel', () => {
  it('renders all six checks, the roll-up and both readiness verdicts', () => {
    const metrics = createMetricsRegistry();
    const built = createDiagnosticsOverlay({
      metrics,
      document,
      health: fabricatedSurface(),
    });

    overlay = built;
    built.open();

    const host = document.querySelector<HTMLElement>('#diagnostics-overlay');
    const text = (host?.textContent ?? '').replace(/\s+/g, ' ');

    for (const id of HEALTH_CHECK_IDS) {
      expect(text).toContain(id);
    }

    expect(text).toContain('overall');
    expect(text).toContain(`${HEALTH_CHECK_IDS.length} checks`);

    // The two verdicts a consumer acts on.
    expect(text).toContain('may mount webgl');
    expect(text).toContain('number-only fallback');
    expect(text).toContain('strategy local');
  });

  it('words every status in the panel vocabulary, in the readiness details too',
    () => {
      const built = createDiagnosticsOverlay({
        metrics: createMetricsRegistry(),
        document,
        health: fabricatedSurface(),
      });

      overlay = built;
      built.open();

      const host = document.querySelector<HTMLElement>('#diagnostics-overlay');
      const heading = [
        ...(host?.querySelectorAll<HTMLElement>('.diagnostics-heading') ?? []),
      ].find((node) => node.textContent === 'Health');
      const table = heading?.nextElementSibling;
      const panelText = (table?.textContent ?? '').replace(/\s+/gu, ' ');

      // The panel the assertion reads is the Health one, resolved the way a
      // reader following docs/OBSERVABILITY.md §7.3 resolves it.
      expect(table?.className).toContain('diagnostics-table');
      expect(panelText).toContain('overall');

      // The documented claim, held: the API's own words reach no cell of this
      // panel, the readiness details included. DL-DIAG-21.
      expect(panelText).not.toContain('pass');
      expect(panelText).not.toContain('fail');

      // Each translated sentence, so a silent revocation of the translation
      // fails here rather than only in the negative assertions above. The
      // fabricated readiness carries a failing roll-up, a failing webgl check
      // and a passing storage check, so both words are exercised.
      const prose = [
        ...(host?.querySelectorAll<HTMLTableCellElement>(
          'td.diagnostics-prose',
        ) ?? []),
      ].map((cell) => cell.textContent);

      expect(prose).toContain('roll-up unhealthy');
      expect(prose).toContain('webgl check unhealthy');
      expect(prose).toContain('strategy local, check healthy');
    });

  it('renders not-applicable distinctly from a failure', () => {
    const built = createDiagnosticsOverlay({
      metrics: createMetricsRegistry(),
      document,
      health: fabricatedSurface(),
    });

    overlay = built;
    built.open();

    const host = document.querySelector<HTMLElement>('#diagnostics-overlay');
    const inapplicable = host?.querySelector<HTMLElement>(
      '.diagnostics-status-not-applicable',
    );
    const failed = host?.querySelector<HTMLElement>('.diagnostics-status-fail');

    expect(inapplicable).not.toBeNull();
    expect(failed).not.toBeNull();

    // Distinct text, distinct colour, distinct weight and distinct slant: a
    // third state and not a second failure.
    expect(inapplicable?.textContent).toBe('not-applicable');
    expect(failed?.textContent).toBe('UNHEALTHY');
    expect(inapplicable?.style.getPropertyValue('color')).not.toBe(
      failed?.style.getPropertyValue('color'),
    );
    expect(inapplicable?.style.getPropertyValue('font-weight')).not.toBe(
      failed?.style.getPropertyValue('font-weight'),
    );
    expect(inapplicable?.style.getPropertyValue('font-style')).toBe('italic');
  });

  it('carries the third gauge value for an inapplicable check', () => {
    const built = createDiagnosticsOverlay({
      metrics: createMetricsRegistry(),
      document,
      health: fabricatedSurface(),
    });

    overlay = built;
    built.open();

    const series = built
      .lastSnapshot()
      ?.series.filter(
        (candidate) =>
          candidate.name.includes('health_check') &&
          candidate.kind === 'gauge',
      );
    const values = (series ?? []).map((candidate) =>
      candidate.kind === 'gauge' ? candidate.value : Number.NaN,
    );

    expect(series).toHaveLength(HEALTH_CHECK_IDS.length);
    expect(values).toContain(1);
    expect(values).toContain(0);

    // `-1` is the encoding that keeps an inapplicable check off the failure
    // series a dashboard would alert on.
    expect(values).toContain(-1);
  });

  it('fills in a check a probe reader did not report', () => {
    const harness = setup({
      health: () => [{ name: 'webgl', healthy: true, detail: 'level webgl2' }],
    });

    harness.overlay.open();

    const text = harness.text();

    // All six are accounted for whichever source is attached.
    for (const id of HEALTH_CHECK_IDS) {
      expect(text).toContain(id);
    }

    expect(text).toContain('not-applicable');
  });

  it('reads the three-state status a probe reader carries rather than its boolean', () => {
    // The boolean cannot express the third state, so a reader collapsing to it
    // presented an inapplicable check as an unqualified pass.
    const metrics = createMetricsRegistry();
    const built = createDiagnosticsOverlay({
      metrics,
      document,
      health: (): readonly {
        name: string;
        status: HealthStatus;
        healthy: boolean;
        detail: string;
      }[] =>
        HEALTH_CHECK_IDS.map((id) => ({
          name: id,
          status:
            id === 'pointerEvents'
              ? 'not-applicable'
              : id === 'webgl'
                ? 'fail'
                : 'pass',
          healthy: id !== 'webgl',
          detail: `observed ${id}`,
        })),
    });

    overlay = built;
    built.open();

    const health = built.snapshot().health;
    const row = health.checks.find((entry) => entry.id === 'pointerEvents');

    expect(row?.status).toBe('not-applicable');
    expect(health.counts['not-applicable']).toBe(1);
    expect(health.counts.fail).toBe(1);
    expect(health.counts.pass).toBe(HEALTH_CHECK_IDS.length - 2);
  });

  it('reconciles every rendered row with the gauge exported for it', () => {
    const metrics = createMetricsRegistry();
    const built = createDiagnosticsOverlay({
      metrics,
      document,

      // One check reported, five unreported: the unreported rows are rendered
      // as inapplicable and each has to carry its own gauge, or the panel and
      // the export disagree about a check nobody reported.
      health: (): readonly { name: string; healthy: boolean }[] => [
        { name: 'webgl', healthy: false },
      ],
    });

    overlay = built;
    built.open();

    const health = built.snapshot().health;
    const gauges = new Map<string, number>();

    for (const series of metrics.snapshot().series) {
      if (series.name.includes('health_check') && series.kind === 'gauge') {
        const check = series.labels.check;

        if (typeof check === 'string') {
          gauges.set(check, series.value);
        }
      }
    }

    expect(health.checks).toHaveLength(HEALTH_CHECK_IDS.length);
    expect(gauges.size).toBe(HEALTH_CHECK_IDS.length);

    const encoded: Readonly<Record<HealthStatus, number>> = {
      pass: 1,
      fail: 0,
      'not-applicable': -1,
    };

    for (const row of health.checks) {
      expect(gauges.get(row.id), `no gauge for "${row.id}"`).toBe(
        encoded[row.status],
      );
    }
  });
});

/** A fabricated dispatch-count view. */
const fabricatedHookCounts = (): Pick<
  HookBusMetrics,
  'hooks' | 'correlationId'
> => ({
  correlationId: 'run-hookbus',
  hooks: {
    onStageStart: {
      dispatched: 1,
      invoked: 1,
      skippedExhausted: 0,
      skippedDegraded: 0,
      skippedDetached: 0,
      rejected: 0,
      failed: 0,
    },
    onBeforeMove: {
      dispatched: 7,
      invoked: 6,
      skippedExhausted: 1,
      skippedDegraded: 0,
      skippedDetached: 0,
      rejected: 0,
      failed: 0,
    },
    onMerge: {
      dispatched: 4,
      invoked: 8,
      skippedExhausted: 0,
      skippedDegraded: 1,
      skippedDetached: 0,
      rejected: 2,
      failed: 3,
    },
    onSpawn: {
      dispatched: 7,
      invoked: 7,
      skippedExhausted: 0,
      skippedDegraded: 0,
      skippedDetached: 0,
      rejected: 0,
      failed: 0,
    },
    onAfterMove: {
      dispatched: 7,
      invoked: 7,
      skippedExhausted: 0,
      skippedDegraded: 0,
      skippedDetached: 0,
      rejected: 0,
      failed: 0,
    },
    onStageEnd: {
      dispatched: 0,
      invoked: 0,
      skippedExhausted: 0,
      skippedDegraded: 0,
      skippedDetached: 0,
      rejected: 0,
      failed: 0,
    },
  },
});

describe('the hook panel', () => {
  it('renders all six hooks with their counts', () => {
    const built = createDiagnosticsOverlay({
      metrics: createMetricsRegistry(),
      document,
      hookCounts: fabricatedHookCounts,
    });

    overlay = built;
    built.open();

    const host = document.querySelector<HTMLElement>('#diagnostics-overlay');
    const text = (host?.textContent ?? '').replace(/\s+/g, ' ');

    for (const hook of [
      'onStageStart',
      'onBeforeMove',
      'onMerge',
      'onSpawn',
      'onAfterMove',
      'onStageEnd',
    ]) {
      expect(text).toContain(hook);
    }

    expect(text).toContain('dispatched 7');
    expect(text).toContain('skipped 1');
    expect(text).toContain('rejected 2');
    expect(text).toContain('failed 3');
    expect(text).toContain('run-hookbus');
  });

  it('reads the bus once per render and never asks it to push', () => {
    let reads = 0;
    const built = createDiagnosticsOverlay({
      metrics: createMetricsRegistry(),
      document,
      hookCounts: () => {
        reads += 1;

        return fabricatedHookCounts();
      },
    });

    overlay = built;
    built.open();

    expect(reads).toBe(1);

    built.refresh();

    expect(reads).toBe(2);
  });

  it('renders the six hooks at zero where no bus is attached', () => {
    const harness = setup();

    harness.overlay.open();

    const text = harness.text();

    expect(text).toContain('onStageEnd');
    expect(text).toContain('dispatched 0');
    expect(text).toContain('not attached');
  });

  it('folds the pulled counts into the exported snapshot', () => {
    const built = createDiagnosticsOverlay({
      metrics: createMetricsRegistry(),
      document,
      hookCounts: fabricatedHookCounts,
    });

    overlay = built;
    built.open();

    const series = built
      .lastSnapshot()
      ?.series.filter((candidate) =>
        candidate.name.includes('hook_dispatches_total'),
      );

    expect((series?.length ?? 0) > 0).toBe(true);
  });
});

/** Correlation identifier the traced runs below are keyed under. */
const TRACED_CORRELATION_ID = deriveCorrelationId('trace-panel-seed', 'run-1');

/** What `traceOneChain` built. */
interface TracedChain {
  readonly tracer: Tracer;

  /** The span records it produced, oldest first. */
  readonly records: readonly SpanRecord[];

  /** The identifier of the span of one name, as the tracer issued it. */
  idOf(name: SpanName): string;
}

/**
 * Drives one whole chain through a real tracer: input, turn, hook dispatch,
 * relic handler, render commit and the frame callback.
 *
 * @param frames Frames to measure through the lifecycle hooks.
 * @param frameMs Duration reported for each of them.
 * @returns The tracer and the records it produced.
 */
const traceOneChain = (frames = 1, frameMs = 18): TracedChain => {
  const tracer = createTracer({
    logger: createLogger({
      correlationId: TRACED_CORRELATION_ID,
      consoleOutput: false,
    }),
    metrics: createMetricsRegistry(),
    correlationId: TRACED_CORRELATION_ID,
    frameBudgetMs: 16,
  });
  const boundary = createBoundaryTracing(tracer);

  boundary.traceInput('move', (): void => {
    tracer.withSpan(SPAN_NAMES.engineTurn, (): void => {
      boundary.traceHookDispatch('onSpawn', (): void => {
        boundary.traceRelicHandler(
          'onSpawn',
          'lucky-two',
          (): void => undefined,
        );
      });
      boundary.traceRenderCommit((): void => undefined);
    });
  });

  const hooks = tracer.frameLifecycleHooks();

  for (let frame = 0; frame < frames; frame += 1) {
    hooks.onFrameBegin();
    hooks.onFrameEnd(undefined, frameMs);
  }

  const records = tracer.recent();

  return {
    tracer,
    records,
    idOf: (name): string => {
      const found = records.find((record) => record.name === name);

      expect(found, `no record for "${name}"`).toBeDefined();

      return found?.id ?? '';
    },
  };
};

/**
 * Reads the rendered table cells of the mounted overlay.
 *
 * @returns Every cell's trimmed text, in document order.
 */
const renderedCells = (): readonly string[] =>
  [
    ...(document
      .querySelector('#diagnostics-overlay')
      ?.querySelectorAll('td') ?? []),
  ].map((cell) => (cell.textContent ?? '').trim());

/**
 * Reads the values of the cells carrying one prefix.
 *
 * @param prefix Cell prefix, as `'id '` or `'parent '`.
 * @returns The value after the prefix, for every cell carrying it.
 */
const cellValues = (prefix: string): readonly string[] =>
  renderedCells()
    .filter((cell) => cell.startsWith(prefix))
    .map((cell) => cell.slice(prefix.length));

/**
 * The form the panel is expected to render one real identifier as: a bounded
 * tail of the correlation identifier, then the whole counter.
 *
 * @param id Identifier the tracer issued.
 * @returns The rendered form.
 */
const renderedIdOf = (id: string): string =>
  `…${TRACED_CORRELATION_ID.slice(-4)}${id.slice(id.lastIndexOf('#'))}`;

describe('the trace panel', () => {
  it('summarises the frame budget and its exceedances', () => {
    const chain = traceOneChain(3, 40);
    const built = createDiagnosticsOverlay({
      metrics: createMetricsRegistry(),
      document,
      tracer: chain.tracer,
    });

    overlay = built;
    built.open();

    const host = document.querySelector<HTMLElement>('#diagnostics-overlay');
    const text = (host?.textContent ?? '').replace(/\s+/g, ' ');

    expect(text).toContain('frame budget');
    expect(text).toContain('16 ms');
    expect(text).toContain('over budget 3 of 3');
    expect(text).toContain('last 40 ms');
  });

  it('shows the whole chain with its parent linkage', () => {
    const chain = traceOneChain();
    const built = createDiagnosticsOverlay({
      metrics: createMetricsRegistry(),
      document,
      tracer: chain.tracer,
      spanLimit: chain.records.length,
    });

    overlay = built;
    built.open();

    const host = document.querySelector<HTMLElement>('#diagnostics-overlay');
    const text = (host?.textContent ?? '').replace(/\s+/g, ' ');

    for (const name of [
      SPAN_NAMES.inputDispatch,
      SPAN_NAMES.engineTurn,
      SPAN_NAMES.hookDispatch,
      SPAN_NAMES.relicHandler,
      SPAN_NAMES.renderCommit,
      SPAN_NAMES.frameCallback,
    ]) {
      expect(text).toContain(name);
    }

    // Every identifier of one run shares its head, so the rendered form has to
    // carry the counter or the linkage below cannot be told apart at all.
    const parents = cellValues('parent ');

    for (const name of [
      SPAN_NAMES.inputDispatch,
      SPAN_NAMES.engineTurn,
      SPAN_NAMES.hookDispatch,
    ]) {
      expect(parents).toContain(renderedIdOf(chain.idOf(name)));
    }
  });

  it('renders every real identifier distinguishably rather than as one shared prefix', () => {
    const chain = traceOneChain();
    const built = createDiagnosticsOverlay({
      metrics: createMetricsRegistry(),
      document,
      tracer: chain.tracer,
      spanLimit: chain.records.length,
    });

    overlay = built;
    built.open();

    const rendered = cellValues('id ');

    expect(rendered.length).toBe(chain.records.length);

    // The defect this pins: truncating to the head alone rendered all six as
    // the same string, so no two spans and no parent link could be told apart.
    expect(new Set(rendered).size).toBe(rendered.length);

    for (const record of chain.records) {
      expect(record.id.startsWith(TRACED_CORRELATION_ID)).toBe(true);
      expect(rendered).toContain(renderedIdOf(record.id));
    }
  });

  it('links each rendered parent to a rendered identifier', () => {
    const chain = traceOneChain();
    const built = createDiagnosticsOverlay({
      metrics: createMetricsRegistry(),
      document,
      tracer: chain.tracer,
      spanLimit: chain.records.length,
    });

    overlay = built;
    built.open();

    const ids = new Set(cellValues('id '));
    const parents = cellValues('parent ').filter(
      (parent) => parent !== '—',
    );

    expect(parents.length).toBeGreaterThan(0);

    // A chain is only readable as a chain if each parent resolves to a span
    // the same panel shows.
    for (const parent of parents) {
      expect(ids.has(parent), `parent "${parent}" resolves to no span`).toBe(
        true,
      );
    }
  });

  it('summarises both duration families off the recorded histograms', () => {
    const harness = setup();

    harness.metrics.recordFrame(4);
    harness.metrics.recordFrame(40);
    harness.metrics.recordTurnLatency(9);
    harness.overlay.open();

    const text = harness.text();

    expect(text).toContain(SPAN_NAMES.frameCallback);
    expect(text).toContain(SPAN_NAMES.engineTurn);
    expect(text).toContain('p50');
    expect(text).toContain('p99');

    // One of the two frames exceeded the 16 ms reference, counted off the
    // cumulative buckets with no tracer attached.
    expect(text).toContain('over budget 1 of 2');
    expect(text).toContain('not attached');
  });
});

describe('the log panel', () => {
  it('carries the level, subsystem, message and correlation id', () => {
    const harness = setup();

    harness.logger.child('engine').warn('a boundary was crossed');
    harness.overlay.open();

    const text = harness.text();

    expect(text).toContain('warn');
    expect(text).toContain('engine');
    expect(text).toContain('a boundary was crossed');
    expect(text).toContain(harness.logger.correlationId);
  });

  it('shows the newest record first', () => {
    const harness = setup();

    harness.logger.info('the older line');
    harness.logger.info('the newer line');
    harness.overlay.open();

    const text = harness.text();

    expect(text.indexOf('the newer line')).toBeLessThan(
      text.indexOf('the older line'),
    );
  });

  it('renders markup in a message as literal text', () => {
    const harness = setup();
    const hostile = '<img src=x onerror=alert(1)>';

    harness.logger.info(hostile);
    harness.overlay.open();

    // Assigned through `textContent`, so no element is created and no handler
    // can fire.
    expect(harness.host.querySelector('img')).toBeNull();
    expect(harness.host.textContent).toContain(hostile);
  });

  it('carries no source location out of a full-stack logger', () => {
    // A logger built for a private development sink, which is the one
    // configuration that keeps stack text as it was thrown.
    const logger = createLogger({
      correlationId: deriveCorrelationId('stack-seed', 'stack-run'),
      subsystem: 'test',
      consoleOutput: false,
      errorDetail: 'full',
    });
    const built = createDiagnosticsOverlay({
      metrics: createMetricsRegistry({ logger }),
      logger,
      document,
    });

    overlay = built;

    const posix = '/home/agent/app/src/engine/engine.ts:120:14';
    const windows = 'C:\\Users\\agent\\app\\src\\engine\\engine.ts:120:14';
    const url = 'http://localhost:5173/src/engine/engine.ts:120:14';
    const cause = new Error('the cause');

    cause.stack = `Error: the cause\n    at spawn (${windows})`;

    const thrown = new Error('the failure', { cause });

    thrown.stack =
      `Error: the failure\n    at move (${posix})\n    at commit (${url})`;

    logger.error('a move failed', undefined, thrown);

    const received = logger.recent(1)[0];

    expect(received.error?.stack).toContain(posix);
    expect(received.error?.cause?.stack).toContain(windows);

    built.open();

    const rendered = hostText();
    const exported = built.snapshotJson();
    const record = built.snapshot().logs.at(-1);

    for (const location of [posix, windows, url]) {
      expect(rendered).not.toContain(location);
      expect(exported).not.toContain(location);
    }

    expect(record?.error?.stack).toContain('at move');
    expect(record?.error?.stack).not.toContain('/home/agent');
    expect(record?.error?.cause?.stack).not.toContain('C:\\Users');
    expect(exported).toContain('[redacted]');
    expect(exported).toContain('a move failed');
  });
});



describe('the combined snapshot', () => {
  it('carries the health, trace, metrics and log sections', () => {
    const logger = createLogger({
      correlationId: deriveCorrelationId('snapshot-seed', 'snapshot-run'),
      subsystem: 'test',
      consoleOutput: false,
    });

    // Wired as src/main.ts wires them, so one correlation identifier covers
    // the registry, the records and the envelope built from both.
    const metrics = createMetricsRegistry({ logger });
    const built = createDiagnosticsOverlay({
      metrics,
      logger,
      document,
      health: fabricatedSurface(),

      // A real tracer, driven over three frames of 40 ms so every one of them
      // exceeds the 16 ms budget the snapshot below reads back.
      tracer: traceOneChain(3, 40).tracer,
      hookCounts: fabricatedHookCounts,
    });

    overlay = built;
    logger.info('a recorded line');
    metrics.counter(`${METRIC_PREFIX}snapshot_total`).inc(2);

    const snapshot: DiagnosticsSnapshot = built.snapshot();

    expect(snapshot.schemaVersion).toBe(DIAGNOSTICS_SNAPSHOT_SCHEMA_VERSION);
    expect(snapshot.correlationId).toBe(logger.correlationId);
    expect(snapshot.health.checks).toHaveLength(HEALTH_CHECK_IDS.length);
    expect(snapshot.health.status).toBe('fail');
    expect(snapshot.health.readiness?.requiresNumberOnlyFallback).toBe(true);
    expect(snapshot.traces?.frames.overBudgetFrames).toBe(3);
    expect(snapshot.hooks).toHaveLength(6);
    expect(snapshot.metrics.series.length).toBeGreaterThan(0);
    expect(snapshot.logs.map((record) => record.message)).toContain(
      'a recorded line',
    );
  });

  it('serialises to JSON a dashboard can parse', () => {
    const harness = setup();

    harness.metrics.counter(`${METRIC_PREFIX}serialised_total`).inc(1);

    const parsed: unknown = JSON.parse(harness.overlay.snapshotJson());
    const envelope = parsed as Partial<DiagnosticsSnapshot>;

    expect(typeof envelope.generatedAt).toBe('string');
    expect(envelope.health).not.toBeUndefined();
    expect(envelope.hooks).not.toBeUndefined();
    expect(envelope.metrics).not.toBeUndefined();
    expect(envelope.logs).not.toBeUndefined();

    // `traces` is a declared section even with no tracer attached.
    expect('traces' in envelope).toBe(true);
  });

  it('exports without the surface ever being opened', () => {
    const harness = setup();

    harness.metrics.counter(`${METRIC_PREFIX}unopened_json_total`).inc(1);

    expect(harness.overlay.isOpen()).toBe(false);
    expect(harness.overlay.snapshotJson()).toContain('unopened_json_total');
  });

  it('revokes the object url it created', () => {
    const harness = setup();
    const created: string[] = [];
    const revoked: string[] = [];

    vi.spyOn(globalThis.URL, 'createObjectURL').mockImplementation(() => {
      const url = `blob:diagnostics-${created.length}`;

      created.push(url);

      return url;
    });
    vi.spyOn(globalThis.URL, 'revokeObjectURL').mockImplementation(
      (url: string): void => {
        revoked.push(url);
      },
    );

    expect(harness.overlay.exportSnapshotJson()).toBe(true);
    expect(created).toHaveLength(1);
    expect(revoked).toEqual(created);

    // The anchor is removed again, so the surface leaves no node behind.
    expect(document.querySelectorAll('a[download]')).toHaveLength(0);
  });

  it('downloads the Prometheus text through the registry', () => {
    const harness = setup();

    vi.spyOn(globalThis.URL, 'createObjectURL').mockReturnValue('blob:prom');
    vi.spyOn(globalThis.URL, 'revokeObjectURL').mockImplementation(() => {
      // The registry revokes its own url; nothing to record here.
    });

    harness.metrics.counter(`${METRIC_PREFIX}downloaded_total`).inc(1);

    expect(harness.overlay.exportPrometheusText()).toBe(true);
    expect(harness.overlay.toPrometheusText()).toContain('downloaded_total');
  });

  it('reports rather than throws where the object url api is absent', () => {
    const harness = setup();

    vi.spyOn(globalThis.URL, 'createObjectURL').mockImplementation(() => {
      throw new Error('no object url');
    });

    expect(harness.overlay.exportSnapshotJson()).toBe(false);
  });

  it('exports the snapshot from its own control', () => {
    const harness = setup();

    vi.spyOn(globalThis.URL, 'createObjectURL').mockReturnValue('blob:control');

    const revoke = vi
      .spyOn(globalThis.URL, 'revokeObjectURL')
      .mockImplementation(() => {
        // Recorded by the spy alone.
      });

    harness.overlay.open();

    const button = Array.from(
      harness.host.querySelectorAll<HTMLButtonElement>('button'),
    ).find((candidate) => candidate.textContent === 'Export snapshot');

    button?.click();

    expect(revoke).toHaveBeenCalledWith('blob:control');
  });
});

describe('the refresh schedule', () => {
  it('refreshes on a throttled cadence and never once per frame', () => {
    vi.useFakeTimers();

    try {
      let reads = 0;
      const built = createDiagnosticsOverlay({
        metrics: createMetricsRegistry(),
        document,
        hookCounts: () => {
          reads += 1;

          return {};
        },
      });

      overlay = built;
      built.open();

      expect(reads).toBe(1);

      // One frame at the 16 ms budget must not trigger a render.
      vi.advanceTimersByTime(16);

      expect(reads).toBe(1);

      // Ten times `$transition-speed`, the declared cadence.
      vi.advanceTimersByTime(1000);

      expect(reads).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does no work at all while hidden', () => {
    vi.useFakeTimers();

    try {
      let reads = 0;
      const built = createDiagnosticsOverlay({
        metrics: createMetricsRegistry(),
        document,
        hookCounts: () => {
          reads += 1;

          return {};
        },
      });

      overlay = built;
      built.open();
      built.close();

      const readsWhenHidden = reads;

      vi.advanceTimersByTime(10000);

      expect(reads).toBe(readsWhenHidden);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the schedule on destroy', () => {
    vi.useFakeTimers();

    try {
      let reads = 0;
      const built = createDiagnosticsOverlay({
        metrics: createMetricsRegistry(),
        document,
        hookCounts: () => {
          reads += 1;

          return {};
        },
      });

      built.open();
      built.destroy();

      const readsAtDestroy = reads;

      vi.advanceTimersByTime(10000);

      expect(reads).toBe(readsAtDestroy);
    } finally {
      vi.useRealTimers();
    }
  });

  it('schedules nothing where the caller sets no cadence', () => {
    vi.useFakeTimers();

    try {
      let reads = 0;
      const built = createDiagnosticsOverlay({
        metrics: createMetricsRegistry(),
        document,
        refreshIntervalMs: 0,
        hookCounts: () => {
          reads += 1;

          return {};
        },
      });

      overlay = built;
      built.open();
      vi.advanceTimersByTime(60000);

      expect(reads).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('registers one listener per control however often it renders', () => {
    const harness = setup();

    harness.overlay.open();
    harness.overlay.refresh();
    harness.overlay.refresh();

    const controls = harness.host.querySelectorAll('.diagnostics-controls');
    const buttons = harness.host.querySelectorAll(
      '.diagnostics-controls button',
    );

    expect(controls).toHaveLength(1);
    expect(buttons).toHaveLength(5);
  });
});

describe('a failing source', () => {
  it('degrades the trace panel and leaves the others standing', () => {
    const built = createDiagnosticsOverlay({
      metrics: createMetricsRegistry(),
      document,
      tracer: {
        snapshot: (): TraceSnapshot => {
          throw new Error('the tracer exploded');
        },
      },
    });

    overlay = built;

    expect(() => {
      built.open();
    }).not.toThrow();

    const host = document.querySelector<HTMLElement>('#diagnostics-overlay');
    const text = (host?.textContent ?? '').replace(/\s+/g, ' ');

    expect(text).toContain('Diagnostics');
    expect(text).toContain('Health');
    expect(text).toContain('Hooks');
    expect(built.isOpen()).toBe(true);
  });

  it('degrades the hook panel and leaves the others standing', () => {
    const built = createDiagnosticsOverlay({
      metrics: createMetricsRegistry(),
      document,
      hookCounts: () => {
        throw new Error('the bus exploded');
      },
    });

    overlay = built;

    expect(() => {
      built.open();
    }).not.toThrow();

    const host = document.querySelector<HTMLElement>('#diagnostics-overlay');

    expect((host?.textContent ?? '').includes('Metrics')).toBe(true);
    expect(built.isOpen()).toBe(true);
  });

  it('degrades the health panel where a surface report throws', () => {
    const built = createDiagnosticsOverlay({
      metrics: createMetricsRegistry(),
      document,
      health: {
        report: (): HealthReport => {
          throw new Error('the report exploded');
        },
        readiness: (): ReadinessReport => {
          throw new Error('the readiness exploded');
        },
      },
    });

    overlay = built;

    expect(() => {
      built.open();
    }).not.toThrow();

    const host = document.querySelector<HTMLElement>('#diagnostics-overlay');
    const text = (host?.textContent ?? '').replace(/\s+/g, ' ');

    expect(text).toContain('UNHEALTHY');
    expect(text).toContain('the provider threw');

    // The six ids are still accounted for.
    for (const id of HEALTH_CHECK_IDS) {
      expect(text).toContain(id);
    }
  });

  it('degrades the log panel where the buffer throws, and reports it', () => {
    const logger = createLogger({
      correlationId: deriveCorrelationId('brittle-seed', 'brittle-run'),
      subsystem: 'test',
      consoleOutput: false,
    });
    const reported: string[] = [];

    logger.subscribe((record) => {
      reported.push(record.message);
    });

    const brittle = Object.create(logger) as Logger;

    Object.defineProperty(brittle, 'snapshot', {
      value: (): never => {
        throw new Error('the buffer exploded');
      },
    });

    const built = createDiagnosticsOverlay({
      metrics: createMetricsRegistry(),
      document,
      logger: brittle,
    });

    overlay = built;

    expect(() => {
      built.open();
    }).not.toThrow();

    expect(reported).toContain('A diagnostics panel failed to render.');
  });

  it('degrades every panel where the registry snapshot throws', () => {
    const metrics = createMetricsRegistry();
    const brittle = Object.create(metrics) as MetricsRegistry;

    Object.defineProperty(brittle, 'snapshot', {
      value: (): never => {
        throw new Error('the registry exploded');
      },
    });

    const built = createDiagnosticsOverlay({
      metrics: brittle,
      document,
    });

    overlay = built;

    expect(() => {
      built.open();
      built.refresh();
    }).not.toThrow();

    const host = document.querySelector<HTMLElement>('#diagnostics-overlay');

    expect((host?.textContent ?? '').includes('Diagnostics')).toBe(true);
    expect(built.isOpen()).toBe(true);
  });

  it('no-ops without a document rather than throwing', () => {
    vi.stubGlobal('document', undefined);

    try {
      const built = createDiagnosticsOverlay({
        metrics: createMetricsRegistry(),
      });

      expect(built.available).toBe(false);
      expect(built.mount()).toBe(false);
      expect(() => {
        built.open();
        built.refresh();
        built.close();
        built.toggle();
      }).not.toThrow();
      expect(built.isOpen()).toBe(false);
      expect(built.exportSnapshotJson()).toBe(false);
      expect(typeof built.snapshotJson()).toBe('string');
      expect(() => {
        built.destroy();
      }).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('the surface is operable and leaves storage alone', () => {
  it('offers focusable buttons with accessible names', () => {
    const harness = setup();

    harness.overlay.open();

    const buttons = Array.from(
      harness.host.querySelectorAll<HTMLButtonElement>('button'),
    );

    expect(buttons.length).toBeGreaterThan(0);

    for (const button of buttons) {
      expect(button.tagName).toBe('BUTTON');
      expect(button.type).toBe('button');
      expect((button.textContent ?? '').length).toBeGreaterThan(0);
      expect(button.getAttribute('tabindex')).toBeNull();

      button.focus();

      expect(document.activeElement).toBe(button);
    }

    const group = harness.host.querySelector('.diagnostics-controls');

    expect(group?.getAttribute('role')).toBe('group');
    expect(group?.getAttribute('aria-label')).toBe('Diagnostics controls');
  });

  it('leaves the tab order when hidden', () => {
    const harness = setup();

    harness.overlay.open();
    harness.overlay.close();

    // The hidden attribute takes the whole subtree out of the tab order.
    expect(harness.host.hidden).toBe(true);
    expect(harness.host.style.getPropertyValue('display')).toBe('none');
  });

  it('reads and writes no storage key of its own', () => {
    localStorage.setItem('bestScore', '4096');
    localStorage.setItem('gameState', '{"score":8}');

    const before = localStorage.length;
    const harness = setup({
      health: () => [{ name: 'webgl', healthy: true }],
    });

    vi.spyOn(globalThis.URL, 'createObjectURL').mockReturnValue('blob:storage');
    vi.spyOn(globalThis.URL, 'revokeObjectURL').mockImplementation(() => {
      // Recorded by the spy alone.
    });

    harness.overlay.mount();
    harness.overlay.open();
    harness.overlay.refresh();
    harness.overlay.snapshotJson();
    harness.overlay.exportSnapshotJson();
    harness.overlay.destroy();

    // The frozen best-score contract is untouched, in value and in count.
    expect(localStorage.getItem('bestScore')).toBe('4096');
    expect(localStorage.getItem('gameState')).toBe('{"score":8}');
    expect(localStorage.length).toBe(before);
  });
});

describe('the focus across a render', () => {
  it('keeps the focused control across an explicit refresh, as one node', () => {
    const harness = setup();

    harness.overlay.open();

    const before = Array.from(
      harness.host.querySelectorAll<HTMLButtonElement>(CONTROL_QUERY),
    )[2];

    before?.focus();

    expect(document.activeElement?.textContent).toBe('Export snapshot');

    harness.overlay.refresh();

    const after = Array.from(
      harness.host.querySelectorAll<HTMLButtonElement>(CONTROL_QUERY),
    )[2];

    // The SAME node, still holding the focus. A render used to replace the five
    // buttons and then move focus to whichever node had taken the position, so
    // a handle to a control went stale on every tick and the focus was restored
    // after the fact rather than never disturbed. DL-DIAG-16.
    expect(after).toBe(before);
    expect(document.activeElement).toBe(before);
    expect(document.activeElement?.textContent).toBe('Export snapshot');
  });

  it('keeps every control node identical across a render', () => {
    const harness = setup();

    harness.overlay.open();

    const before = Array.from(
      harness.host.querySelectorAll<HTMLButtonElement>(CONTROL_QUERY),
    );

    harness.overlay.refresh();
    harness.overlay.refresh();

    const after = Array.from(
      harness.host.querySelectorAll<HTMLButtonElement>(CONTROL_QUERY),
    );

    expect(after).toHaveLength(before.length);

    for (const [index, node] of before.entries()) {
      expect(after[index]).toBe(node);
    }
  });

  it('relabels the collapse control in place rather than replacing it', () => {
    const harness = setup();

    harness.overlay.open();

    const collapse = Array.from(
      harness.host.querySelectorAll<HTMLButtonElement>(CONTROL_QUERY),
    )[3];

    expect(collapse?.textContent).toBe('Collapse diagnostics');
    expect(collapse?.getAttribute('aria-expanded')).toBe('true');

    // Focused first: a real pointer press focuses the button it activates, and
    // `click()` alone does not, so the focus has to be placed for the assertion
    // below to describe what a user experiences.
    collapse?.focus();
    collapse?.click();

    const afterCollapse = Array.from(
      harness.host.querySelectorAll<HTMLButtonElement>(CONTROL_QUERY),
    )[3];

    expect(afterCollapse).toBe(collapse);
    expect(collapse?.textContent).toBe('Expand diagnostics');
    expect(collapse?.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(collapse);

    collapse?.click();

    expect(collapse?.textContent).toBe('Collapse diagnostics');
    expect(collapse?.getAttribute('aria-expanded')).toBe('true');
    expect(harness.host.querySelectorAll('h2')).toHaveLength(6);
  });

  it('renders the heading, the panels and the controls in that order', () => {
    const harness = setup();

    harness.overlay.open();
    harness.overlay.refresh();

    const children = Array.from(harness.host.children);
    const first = children[0];
    const last = children[children.length - 1];

    // The furniture persists, so the ORDER has to be asserted: the panels are
    // inserted ahead of the control row rather than appended after it.
    expect(first?.tagName).toBe('H1');
    expect(last?.className).toBe('diagnostics-controls');
    expect(children.filter((node) => node.tagName === 'H2')).toHaveLength(6);
  });

  it('keeps the focus on the refresh control it was activated from', () => {
    const harness = setup();

    harness.overlay.open();

    const refresh = Array.from(
      harness.host.querySelectorAll<HTMLButtonElement>(CONTROL_QUERY),
    )[0];

    refresh?.focus();
    refresh?.click();

    expect(document.activeElement?.textContent).toBe('Refresh');
  });

  it('skips the scheduled render while a control holds the focus', () => {
    vi.useFakeTimers();

    try {
      let reads = 0;
      const built = createDiagnosticsOverlay({
        metrics: createMetricsRegistry(),
        document,
        hookCounts: () => {
          reads += 1;

          return {};
        },
      });

      overlay = built;
      built.open();

      const host = document.querySelector<HTMLElement>('#diagnostics-overlay');
      const control = host?.querySelector<HTMLButtonElement>(CONTROL_QUERY);

      control?.focus();

      const readsWhenFocused = reads;

      vi.advanceTimersByTime(5000);

      // No churn under the keyboard: the tick finds the focus inside the host
      // and renders nothing.
      expect(reads).toBe(readsWhenFocused);
      expect(document.activeElement).toBe(control);

      // The cadence resumes once the focus leaves.
      (document.activeElement as HTMLElement | null)?.blur();
      vi.advanceTimersByTime(1000);

      expect(reads).toBeGreaterThan(readsWhenFocused);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tabs through every control without the focus being ejected', () => {
    vi.useFakeTimers();

    try {
      const harness = setup();

      harness.overlay.open();

      const labels: string[] = [];
      const controls = Array.from(
        harness.host.querySelectorAll<HTMLButtonElement>(CONTROL_QUERY),
      );

      for (const control of controls) {
        // The tab step, plus a cadence's worth of scheduled ticks between
        // each.
        control.focus();
        vi.advanceTimersByTime(1200);
        labels.push(document.activeElement?.textContent ?? 'lost');
      }

      expect(labels).toEqual([
        'Refresh',
        'Export metrics',
        'Export snapshot',
        'Collapse diagnostics',
        'Close diagnostics',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a destroyed overlay', () => {
  it('reports itself unavailable and closed', () => {
    const harness = setup();

    harness.overlay.mount();
    harness.overlay.open();
    harness.overlay.destroy();

    expect(harness.overlay.available).toBe(false);
    expect(harness.overlay.isOpen()).toBe(false);
  });

  it('refuses to open, close or toggle', () => {
    const harness = setup();

    harness.overlay.mount();
    harness.overlay.destroy();

    harness.overlay.open();

    expect(harness.overlay.isOpen()).toBe(false);
    expect(harness.overlay.toggle()).toBe(false);
    expect(harness.overlay.isOpen()).toBe(false);

    harness.overlay.close();

    expect(harness.overlay.isOpen()).toBe(false);
  });

  it('renders nothing on refresh', () => {
    const harness = setup();

    harness.overlay.mount();
    harness.overlay.open();
    harness.overlay.destroy();
    harness.overlay.refresh();

    expect(harness.host.textContent ?? '').toBe('');
  });

  it('reports no last snapshot', () => {
    const harness = setup();

    harness.overlay.mount();
    harness.overlay.open();

    expect(harness.overlay.lastSnapshot()).not.toBeNull();

    harness.overlay.destroy();

    expect(harness.overlay.lastSnapshot()).toBeNull();
  });

  it('exports no Prometheus text', () => {
    const harness = setup();

    harness.metrics.counter(`${METRIC_PREFIX}probe_total`).inc(3);

    expect(harness.overlay.toPrometheusText().length).toBeGreaterThan(0);

    harness.overlay.destroy();

    expect(harness.overlay.toPrometheusText()).toBe('');
    expect(harness.metrics.toPrometheusText().length).toBeGreaterThan(0);
  });

  it('yields an inert snapshot rather than a live reading', () => {
    const harness = setup();

    harness.metrics.counter(`${METRIC_PREFIX}probe_total`).inc(3);

    expect(harness.overlay.snapshot().metrics.series.length)
      .toBeGreaterThan(0);

    harness.overlay.destroy();

    const snapshot = harness.overlay.snapshot();

    // The zero `schemaVersion` is what distinguishes this from a real reading.
    expect(snapshot.schemaVersion).toBe(0);
    expect(snapshot.metrics.series).toEqual([]);
    expect(snapshot.health.status).toBeNull();
    expect(snapshot.traces).toBeNull();
    expect(snapshot.hooks).toEqual([]);
    expect(snapshot.logs).toEqual([]);
  });

  it('yields no snapshot JSON', () => {
    const harness = setup();

    expect(harness.overlay.snapshotJson().length).toBeGreaterThan(0);

    harness.overlay.destroy();

    expect(harness.overlay.snapshotJson()).toBe('');
  });

  it('starts no download from either export', () => {
    const harness = setup();

    harness.overlay.destroy();

    expect(harness.overlay.exportPrometheusText()).toBe(false);
    expect(harness.overlay.exportSnapshotJson()).toBe(false);
  });

  it('reads no health source once destroyed', () => {
    let reads = 0;
    const harness = setup({
      health: () => {
        reads += 1;

        return [{ name: 'storage', healthy: true }];
      },
    });

    harness.overlay.snapshot();

    expect(reads).toBeGreaterThan(0);

    const taken = reads;

    harness.overlay.destroy();
    harness.overlay.snapshot();
    harness.overlay.refresh();
    harness.overlay.snapshotJson();

    // The source is RELEASED, so nothing the overlay does can reach it again.
    expect(reads).toBe(taken);
  });

  it('mounts nothing once destroyed', () => {
    const harness = setup();

    harness.overlay.destroy();

    expect(harness.overlay.mount()).toBe(false);
    expect(harness.overlay.available).toBe(false);
  });

  it('is idempotent: a second destroy changes nothing', () => {
    const harness = setup();

    harness.overlay.mount();
    harness.overlay.destroy();

    expect(() => {
      harness.overlay.destroy();
    }).not.toThrow();
    expect(harness.overlay.available).toBe(false);
  });

  it('leaves an adopted host as it found it', () => {
    const harness = setup();

    harness.overlay.open();
    harness.overlay.close();
    harness.overlay.destroy();

    // A release used to leave `display: none` behind, because `display` is
    // written by the visibility pass and is not a member of the style table the
    // release removes, and to leave `class=""` where the class list had been
    // emptied. DL-DIAG-14.
    expect(harness.host.style.getPropertyValue('display')).toBe('');
    expect(harness.host.style.getPropertyValue('position')).toBe('');
    expect(harness.host.style.getPropertyValue('z-index')).toBe('');
    expect(harness.host.style.getPropertyValue('background')).toBe('');
    expect(harness.host.getAttribute('class')).toBeNull();
    expect(harness.host.getAttribute('role')).toBeNull();
    expect(harness.host.getAttribute('aria-label')).toBeNull();
    expect(harness.host.getAttribute('data-collapsed')).toBeNull();
    expect(harness.host.getAttribute('data-refresh')).toBeNull();
    expect(harness.host.children).toHaveLength(0);

    // The `style` attribute itself is dropped once every declaration is gone,
    // which is the state a real engine reaches. This DOM implementation removes
    // a shorthand without its longhands, so the four `padding` longhands
    // survive here and there is nothing empty to drop; the whole-attribute
    // removal is verified in a browser instead.
    const surviving = Array.from(
      { length: harness.host.style.length },
      (_unused: unknown, index: number): string =>
        harness.host.style.item(index),
    );

    expect(
      surviving.filter((property: string): boolean =>
        !property.startsWith('padding'),
      ),
    ).toEqual([]);
  });

  it('drops a class attribute it emptied, and keeps one it did not', () => {
    document.body.innerHTML =
      '<div id="diagnostics-overlay" class="diagnostics-overlay"></div>' +
      '<div id="second" class="diagnostics-overlay app-panel"></div>';

    const bare = document.querySelector<HTMLElement>('#diagnostics-overlay');
    const shared = document.querySelector<HTMLElement>('#second');
    const first = createDiagnosticsOverlay({
      metrics: createMetricsRegistry(),
      document,
      ...(bare === null ? {} : { host: bare }),
    });

    first.open();
    first.destroy();

    // Emptied by the release, so the attribute goes with it.
    expect(bare?.getAttribute('class')).toBeNull();

    const second = createDiagnosticsOverlay({
      metrics: createMetricsRegistry(),
      document,
      ...(shared === null ? {} : { host: shared }),
    });

    second.open();
    second.destroy();

    // Still carries a class of its own, so the attribute stays and keeps it.
    expect(shared?.getAttribute('class')).toBe('app-panel');
  });
});

describe('the refresh state the surface publishes', () => {
  it('reads live while nothing in it holds the focus', () => {
    const harness = setup();

    harness.overlay.open();

    expect(harness.host.getAttribute('data-refresh')).toBe('live');
    expect(harness.host.querySelector('h1')?.textContent).toBe('Diagnostics');
  });

  it('says so on the host and in the heading while it is paused', () => {
    const harness = setup();

    harness.overlay.open();

    const control = harness.host.querySelector<HTMLButtonElement>(
      CONTROL_QUERY,
    );

    control?.focus();

    // The pause is deliberate — the panels do not change under a reader working
    // through them — and it is now legible, where a reader watching the figures
    // stop had nothing to distinguish it from a dead surface. DL-DIAG-15.
    expect(harness.host.getAttribute('data-refresh')).toBe('paused');
    expect(harness.host.querySelector('h1')?.textContent).toBe(
      'Diagnostics — paused while focused',
    );
  });

  it('comes back to live, and current, the moment the focus leaves', async () => {
    const harness = setup();

    harness.overlay.open();

    const control = harness.host.querySelector<HTMLButtonElement>(
      CONTROL_QUERY,
    );

    control?.focus();
    harness.metrics.counter(`${METRIC_PREFIX}after_focus_total`).inc(3);

    // Paused, so the reading taken while focused is not on screen.
    expect(harness.text()).not.toContain('after_focus_total');

    control?.blur();
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    // Self-healing: leaving renders at once rather than a cadence later.
    expect(harness.host.getAttribute('data-refresh')).toBe('live');
    expect(harness.host.querySelector('h1')?.textContent).toBe('Diagnostics');
    expect(harness.text()).toContain('after_focus_total');
  });

  it('mutates nothing at all while it is paused', () => {
    vi.useFakeTimers();

    try {
      const harness = setup();

      harness.overlay.open();

      const control = harness.host.querySelector<HTMLButtonElement>(
        CONTROL_QUERY,
      );

      control?.focus();

      let mutations = 0;
      const observer = new MutationObserver((records) => {
        mutations += records.length;
      });

      observer.observe(harness.host, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });

      vi.advanceTimersByTime(5000);

      // `takeRecords` is read rather than the callback awaited: an observer
      // delivers on a microtask, which a fake-timer advance does not flush, so
      // an assertion on the callback's tally alone would pass whatever happened.
      mutations += observer.takeRecords().length;
      observer.disconnect();

      // A stand-off that republished the same state every tick still replaced
      // the heading's text node and still recorded an attribute mutation every
      // second — activity, to anything watching the DOM, and a change
      // notification to an assistive technology, for a surface that is
      // deliberately holding still. DL-DIAG-15, DL-DIAG-16.
      expect(mutations).toBe(0);
      expect(harness.host.getAttribute('data-refresh')).toBe('paused');
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes no refresh state at all once closed', () => {
    const harness = setup();

    harness.overlay.open();

    expect(harness.host.getAttribute('data-refresh')).toBe('live');

    const control = harness.host.querySelector<HTMLButtonElement>(
      CONTROL_QUERY,
    );

    control?.focus();

    expect(harness.host.getAttribute('data-refresh')).toBe('paused');

    harness.overlay.close();

    // Neither live nor paused: a closed surface has no schedule to describe, and
    // the value the close froze would have outlived the thing it described. The
    // heading goes back with it, so nothing left on the host still claims a
    // stand-off.
    expect(harness.host.getAttribute('data-refresh')).toBeNull();
    expect(harness.host.querySelector('h1')?.textContent).toBe('Diagnostics');

    // Blurred first: a real engine drops the focus as the host is hidden, and
    // this DOM implementation performs no layout so the control keeps it — a
    // re-open with the focus still inside is correctly paused, not live.
    control?.blur();
    harness.overlay.open();

    expect(harness.host.getAttribute('data-refresh')).toBe('live');
  });

  it('advances on the timer with no frame produced at all', () => {
    vi.useFakeTimers();

    try {
      let reads = 0;
      const built = createDiagnosticsOverlay({
        metrics: createMetricsRegistry(),
        document,
        hookCounts: () => {
          reads += 1;

          return {};
        },
      });

      overlay = built;
      built.open();

      const afterOpen = reads;

      // Nothing composites a frame in this environment and nothing plays: the
      // cadence is `setInterval` and depends on neither. The reported claim it
      // answers — "the self-refresh only ticks when a frame is produced" — is
      // not the mechanism; the one condition that stops it is the focus hold.
      // DL-DIAG-15.
      vi.advanceTimersByTime(5000);

      expect(reads).toBe(afterOpen + 5);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the focus when the surface closes', () => {
  it('returns to the element that had it, from the close control', () => {
    document.body.innerHTML =
      `${HOST_MARKUP}<button id="game-control" type="button">Move up</button>`;

    const host = document.querySelector<HTMLElement>('#diagnostics-overlay');
    const game = document.querySelector<HTMLButtonElement>('#game-control');
    const built = createDiagnosticsOverlay({
      metrics: createMetricsRegistry(),
      document,
      ...(host === null ? {} : { host }),
    });

    overlay = built;
    game?.focus();
    built.open();

    const close = Array.from(
      host?.querySelectorAll<HTMLButtonElement>(CONTROL_QUERY) ?? [],
    )[4];

    close?.focus();
    close?.click();

    // Hiding an element that contains the focus drops it to the body, so a
    // keyboard user who closed the surface from its own control lost their
    // position in the page. DL-DIAG-17.
    expect(built.isOpen()).toBe(false);
    expect(document.activeElement).toBe(game);
  });

  it('returns to the element focused most recently, not at open', () => {
    document.body.innerHTML =
      `${HOST_MARKUP}<button id="first" type="button">First</button>` +
      '<button id="second" type="button">Second</button>';

    const host = document.querySelector<HTMLElement>('#diagnostics-overlay');
    const first = document.querySelector<HTMLButtonElement>('#first');
    const second = document.querySelector<HTMLButtonElement>('#second');
    const built = createDiagnosticsOverlay({
      metrics: createMetricsRegistry(),
      document,
      ...(host === null ? {} : { host }),
    });

    overlay = built;
    first?.focus();
    built.open();

    // The case that matters: the surface was already open — the flag mounts it
    // at boot — and the user moved on before tabbing in.
    second?.focus();

    const close = Array.from(
      host?.querySelectorAll<HTMLButtonElement>(CONTROL_QUERY) ?? [],
    )[4];

    close?.focus();
    close?.click();

    expect(document.activeElement).toBe(second);
  });

  it('takes the focus from nowhere when the surface did not hold it', () => {
    document.body.innerHTML =
      `${HOST_MARKUP}<button id="game-control" type="button">Move up</button>` +
      '<button id="elsewhere" type="button">Elsewhere</button>';

    const host = document.querySelector<HTMLElement>('#diagnostics-overlay');
    const game = document.querySelector<HTMLButtonElement>('#game-control');
    const elsewhere = document.querySelector<HTMLButtonElement>('#elsewhere');
    const built = createDiagnosticsOverlay({
      metrics: createMetricsRegistry(),
      document,
      ...(host === null ? {} : { host }),
    });

    overlay = built;
    game?.focus();
    built.open();
    elsewhere?.focus();

    // Closed programmatically while the focus sits in the page: the surface
    // must not pull it back to where it came from.
    built.close();

    expect(document.activeElement).toBe(elsewhere);
  });

  it('leaves the focus alone where the element it came from has gone', () => {
    document.body.innerHTML =
      `${HOST_MARKUP}<button id="transient" type="button">Transient</button>`;

    const host = document.querySelector<HTMLElement>('#diagnostics-overlay');
    const transient = document.querySelector<HTMLButtonElement>('#transient');
    const built = createDiagnosticsOverlay({
      metrics: createMetricsRegistry(),
      document,
      ...(host === null ? {} : { host }),
    });

    overlay = built;
    transient?.focus();
    built.open();
    transient?.remove();

    const close = Array.from(
      host?.querySelectorAll<HTMLButtonElement>(CONTROL_QUERY) ?? [],
    )[4];

    close?.focus();

    expect(() => {
      close?.click();
    }).not.toThrow();
    expect(built.isOpen()).toBe(false);

    // Wherever the focus ends up, it is somewhere still in the document and
    // never the detached node: a real engine drops it to the body as the host
    // is hidden, and this DOM implementation performs no layout so it stays on
    // the control. Neither is the removed element.
    expect(document.activeElement).not.toBe(transient);
    expect(document.contains(document.activeElement)).toBe(true);
  });
});

describe('a host that is not an element', () => {
  /** Values a caller could supply where `Element | null` is declared. */
  const NON_ELEMENT_HOSTS: readonly unknown[] = Object.freeze([
    'not-an-element',
    42,
    true,
    { nodeType: 1 },
    [],
  ]);

  it('mounts nothing and throws from no member', () => {
    for (const host of NON_ELEMENT_HOSTS) {
      const overlay = createDiagnosticsOverlay({
        metrics: createMetricsRegistry(),
        document,
        host: host as never,
      });

      try {
        // Treated exactly as `null`: the declared way to disable mounting.
        expect(overlay.mount()).toBe(false);
        expect(overlay.available).toBe(false);
        expect(overlay.isOpen()).toBe(false);

        // Every member still answers, which is what `host: null` also does.
        expect(() => {
          overlay.open();
          overlay.refresh();
          overlay.toggle();
          overlay.close();
        }).not.toThrow();

        // And the data model is whole, which is the point of the surface: the
        // export path is the substitute for a scraped metrics endpoint.
        expect(overlay.snapshot().metrics.series.length).toBeGreaterThan(0);
        expect(overlay.toPrometheusText().length).toBeGreaterThan(0);
        expect(JSON.parse(overlay.snapshotJson())).toBeDefined();
      } finally {
        overlay.destroy();
      }

      // The fixture host the suite's `beforeEach` declares is left alone:
      // nothing was created beside it and nothing was rendered into it, which
      // is what a disabled host means.
      expect(document.querySelectorAll('#diagnostics-overlay')).toHaveLength(1);
      expect(hostText()).toBe('');
    }
  });

  it('adopts an element from another realm by its surface', () => {
    // DUCK-TYPED, so a host built in an iframe document or by another DOM
    // implementation is still adopted.
    const host = document.createElement('div');

    document.body.appendChild(host);

    const overlay = createDiagnosticsOverlay({
      metrics: createMetricsRegistry(),
      document,
      host,
    });

    try {
      expect(overlay.mount()).toBe(true);
      expect(overlay.available).toBe(true);

      overlay.open();

      expect(overlay.isOpen()).toBe(true);
    } finally {
      overlay.destroy();
      host.remove();
    }
  });
});

// The two shapes docs/OBSERVABILITY.md §9.1 now states as limits rather than
// defects. Each is guarded here so the statement cannot quietly stop being
// true: a header cell added later would falsify `DL-DIAG-18`, and an empty
// state that stopped rendering would falsify the reachability note beside it.
describe('the documented panel shape', () => {
  it('builds every table from a tbody alone, with no th, caption or role', () => {
    const harness = setup();

    harness.overlay.open();

    const tables = Array.from(harness.host.querySelectorAll('table'));

    expect(tables.length).toBeGreaterThan(0);

    for (const table of tables) {
      // DL-DIAG-18: a row's first cell is that row's label, not a column
      // heading, so there is no header row to mark up.
      expect(table.querySelectorAll('th')).toHaveLength(0);
      expect(table.querySelectorAll('caption')).toHaveLength(0);
      expect(table.getAttribute('role')).toBeNull();
      expect(table.querySelectorAll('tbody')).toHaveLength(1);

      // Every cell the surface writes is a td.
      const cells = table.querySelectorAll('tbody > tr > td');

      expect(cells.length).toBeGreaterThan(0);
      expect(cells.length).toBe(table.querySelectorAll('tbody td').length);
    }
  });

  it('swaps one panel for an unclassed paragraph once its rows are gone', () => {
    const harness = setup();

    // One record, so the panel has a row to lose. A bare harness starts with an
    // empty buffer; in the shipped composition the BOOT fills it, because
    // health writes one record per check as it publishes each result, and no
    // control on the surface clears it.
    harness.logger.info('a record the panel can render');
    harness.overlay.open();

    const withRecords = harness.host.querySelectorAll('table').length;

    expect(withRecords).toBeGreaterThan(0);
    expect(harness.text()).not.toContain('Nothing recorded.');

    // Reachable only programmatically. A refresh does NOT write records — the
    // health panel reads `report()` and `readiness()`, never `check()` — so
    // refreshing after a clear re-renders the emptied buffer rather than
    // refilling it. That is exactly why the state is unreachable through the
    // UI, where nothing clears the buffer in the first place.
    harness.logger.clear();
    harness.overlay.refresh();

    expect(harness.text()).toContain('Nothing recorded.');

    // The table is replaced rather than emptied, so the structural count drops
    // by exactly one and no panel reports a failure.
    expect(harness.host.querySelectorAll('table')).toHaveLength(
      withRecords - 1,
    );
    expect(harness.text()).not.toContain('This panel failed to render.');

    const paragraphs = Array.from(harness.host.querySelectorAll('p')).filter(
      (node: Element): boolean =>
        (node.textContent ?? '').trim() === 'Nothing recorded.',
    );

    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]?.getAttribute('class')).toBeNull();
  });
});
