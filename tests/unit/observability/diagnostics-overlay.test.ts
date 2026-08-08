// Contract suite for the diagnostics surface, Rule 3.
//
// Rule 3 requires a metrics endpoint, health checks and a dashboard, all
// "verified working in the local development environment", because a capability
// that cannot be exercised locally is not delivered. A static bundle has no
// server, so AAP 0.7.2.4 substitutes an in-page surface plus an exportable
// Prometheus snapshot. This suite is the verification of that substitute.
//
// The defect it closes: the registry was write-only. Counters moved and nothing
// could read one, so no count, timing or health result was observable anywhere.
//
// The registry is real throughout, never a mock: a stub would prove the overlay
// renders whatever it is handed rather than that it renders what was recorded.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HookBusMetrics } from '../../../src/engine/hook-bus';
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
  TracerView,
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
  SpanRecord,
  TraceSnapshot,
} from '../../../src/observability/tracer';
import {
  SPAN_NAMES,
  TRACE_SNAPSHOT_SCHEMA_VERSION,
} from '../../../src/observability/tracer';
import { monospaceStack, zIndex } from '../../../src/theme/tokens';
import { METRIC_PREFIX, createMetricsRegistry } from '../../../src/observability/metrics';
import type { MetricsRegistry } from '../../../src/observability/metrics';
import { createLogger, deriveCorrelationId } from '../../../src/observability/logger';
import type { LogRecord, Logger } from '../../../src/observability/logger';

/** Selector the control row's buttons are read back by. */
const CONTROL_QUERY = '.diagnostics-controls button';

const HOST_MARKUP =
  '<div class="diagnostics-overlay" id="diagnostics-overlay" hidden></div>';

let overlay: DiagnosticsOverlay | null = null;

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

/* ==========================================================================
 * 1. Availability and lifecycle
 * ========================================================================== */

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

    // Every member stays a safe no-op rather than throwing on a missing host.
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
});

/* ==========================================================================
 * 2. It reports what was actually recorded
 * ========================================================================== */

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

    // A registry declares many families up front; showing every zero would bury
    // the handful that moved.
    expect(hidden).not.toContain('silent_total');
    expect(loud.text()).toContain('silent_total');
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

/* ==========================================================================
 * 3. Health
 * ========================================================================== */

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

/* ==========================================================================
 * 4. The scrape substitute
 * ========================================================================== */

describe('the exported snapshot', () => {
  it('exports Prometheus text carrying a recorded counter', () => {
    const harness = setup();

    harness.metrics.counter(`${METRIC_PREFIX}exported_total`).inc(5);

    const text = harness.overlay.toPrometheusText();

    // This is what stands in for a scrape response body.
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

/* ==========================================================================
 * 5. Controls
 * ========================================================================== */

describe('the surface controls', () => {
  it('offers refresh, export and close as real buttons', () => {
    const harness = setup();

    harness.overlay.open();

    const controls = Array.from(
      harness.host.querySelectorAll<HTMLButtonElement>(
        '.diagnostics-controls button',
      ),
    );

    // The snapshot export sits beside the Prometheus one: the combined JSON is
    // what docs/dashboards/dashboard.html renders against.
    expect(controls.map((control) => control.textContent)).toEqual([
      'Refresh',
      'Export metrics',
      'Export snapshot',
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

/* ==========================================================================
 * 6. The activation gate
 *
 * Rule 3 requires the surface to be exercisable locally, and requirement R11's
 * recorded run requires it to stay out of the way. `isDiagnosticsRequested` is
 * the runtime opt-in that satisfies both: default off, readable in production,
 * and not a build-time constant a bundler could remove.
 * ========================================================================== */

describe('the activation gate', () => {
  it('defaults to off with no flag anywhere', () => {
    expect(isDiagnosticsRequested({})).toBe(false);
    expect(isDiagnosticsRequested({ search: '', hash: '' })).toBe(false);
    expect(isDiagnosticsRequested({ search: '?other=1', hash: '#board' })).toBe(
      false,
    );

    // The recorded-gameplay run sets nothing, so this is the case that keeps an
    // overlay at z-index 500 out of the video.
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

  it('answers false rather than throwing for a hostile source', () => {
    const hostile = {
      get search(): string {
        throw new Error('the location exploded');
      },
    };

    expect(isDiagnosticsRequested(hostile)).toBe(false);
  });
});

/* ==========================================================================
 * 7. Self-mounting
 *
 * index.html's mount contract names no diagnostics container, so the surface
 * must be able to build its own host. It adopts a declared one where the markup
 * has it, which is what keeps this module free of any markup edit.
 * ========================================================================== */

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

/* ==========================================================================
 * 8. Token compliance and layering
 *
 * The operative design system is the repository's own token layer, so every
 * value the surface paints itself with resolves to src/theme/tokens.ts.
 * ========================================================================== */

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
});

/* ==========================================================================
 * 9. The health panel, all six checks and three states
 *
 * Validation gate V8 requires health to report all six checks. This is where a
 * developer sees that, and `not-applicable` is rendered as itself rather than
 * collapsed into a failure.
 * ========================================================================== */

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
});

/* ==========================================================================
 * 10. The hook-dispatch panel
 *
 * The counts are PULLED from the bus. Nothing is pushed into this module, which
 * is the property that keeps src/engine free of an observability import.
 * ========================================================================== */

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

/* ==========================================================================
 * 11. The trace panel
 *
 * Validation gate V8 requires the trace chain to be visible, frame-callback
 * seam included. The 16 ms reference is the budget js/animframe_polyfill.js L13
 * held and the tracer carries forward.
 * ========================================================================== */

/**
 * Builds one fabricated span record.
 *
 * @param name Span name.
 * @param id Span identifier.
 * @param parentId Parent identifier, or `undefined` for a root span.
 * @param durationMs Duration in milliseconds.
 * @returns The record.
 */
const spanRecord = (
  name: SpanRecord['name'],
  id: string,
  parentId: string | undefined,
  durationMs: number,
): SpanRecord => ({
  name,
  id,
  parentId,
  startTime: 0,
  durationMs,
  attributes: {},
  events: [],
  correlationId: 'run-traced',
  droppedAttributes: 0,
  droppedEvents: 0,
});

/** A fabricated tracer snapshot spanning input through renderer. */
const fabricatedTraces = (): TraceSnapshot => ({
  schemaVersion: TRACE_SNAPSHOT_SCHEMA_VERSION,
  correlationId: 'run-traced',
  enabled: true,
  capacity: 200,
  started: 6,
  ended: 6,
  open: 0,
  dropped: 0,
  faults: 0,
  anomalies: 0,
  doubleEnds: 0,
  outOfOrderEnds: 0,
  frames: {
    frames: 10,
    overBudgetFrames: 3,
    budgetMs: 16,
    lastFrameMs: 12.5,
    maxFrameMs: 41.25,
    totalFrameMs: 150,
  },
  spans: [
    spanRecord(SPAN_NAMES.inputDispatch, 'input001', undefined, 1),
    spanRecord(SPAN_NAMES.engineTurn, 'turn0001', 'input001', 4),
    spanRecord(SPAN_NAMES.hookDispatch, 'hook0001', 'turn0001', 2),
    spanRecord(SPAN_NAMES.relicHandler, 'relic001', 'hook0001', 1),
    spanRecord(SPAN_NAMES.renderCommit, 'commit01', 'turn0001', 3),
    spanRecord(SPAN_NAMES.frameCallback, 'frame001', undefined, 18),
  ],
});

/** A tracer over the fabricated snapshot. */
const fabricatedTracer = (): TracerView => ({
  snapshot: (): TraceSnapshot => fabricatedTraces(),
});

describe('the trace panel', () => {
  it('summarises the frame budget and its exceedances', () => {
    const built = createDiagnosticsOverlay({
      metrics: createMetricsRegistry(),
      document,
      tracer: fabricatedTracer(),
    });

    overlay = built;
    built.open();

    const host = document.querySelector<HTMLElement>('#diagnostics-overlay');
    const text = (host?.textContent ?? '').replace(/\s+/g, ' ');

    expect(text).toContain('frame budget');
    expect(text).toContain('16 ms');
    expect(text).toContain('over budget 3 of 10');
    expect(text).toContain('last 12.500 ms');
  });

  it('shows the whole chain with its parent linkage', () => {
    const built = createDiagnosticsOverlay({
      metrics: createMetricsRegistry(),
      document,
      tracer: fabricatedTracer(),
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

    // The linkage is what makes the chain readable as a chain.
    expect(text).toContain('parent input001');
    expect(text).toContain('parent turn0001');
    expect(text).toContain('parent hook0001');
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

/* ==========================================================================
 * 12. The log panel
 * ========================================================================== */

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
});

/* ==========================================================================
 * 13. The combined snapshot, the dashboard template's input
 * ========================================================================== */

describe('the combined snapshot', () => {
  it('carries the health, trace, metrics and log sections', () => {
    const logger = createLogger({
      correlationId: deriveCorrelationId('snapshot-seed', 'snapshot-run'),
      subsystem: 'test',
      consoleOutput: false,
    });

    // Wired as src/main.ts wires them, so one correlation identifier covers the
    // registry, the records and the envelope built from both.
    const metrics = createMetricsRegistry({ logger });
    const built = createDiagnosticsOverlay({
      metrics,
      logger,
      document,
      health: fabricatedSurface(),
      tracer: fabricatedTracer(),
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

/* ==========================================================================
 * 14. Cost while shown and while hidden
 *
 * The renderer this surface sits over is the product's first per-frame work, so
 * the schedule is throttled and a hidden overlay performs none of it.
 * ========================================================================== */

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
    expect(buttons).toHaveLength(4);
  });
});

/* ==========================================================================
 * 15. It never throws
 *
 * A diagnostics surface that can take the game down with it is worse than none.
 * Every source is made to throw in turn.
 * ========================================================================== */

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

    Object.defineProperty(brittle, 'recent', {
      value: (): readonly LogRecord[] => {
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

    // The failure reaches the logger rather than the caller.
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

/* ==========================================================================
 * 16. Accessibility and the frozen storage contract
 * ========================================================================== */

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

/* ==========================================================================
 * 17. The keyboard focus survives a render
 *
 * A render replaces the control nodes. Runtime validation in Chrome showed that
 * without the two behaviours below the scheduled refresh ejected the focus to
 * `body` every cadence, which made unaided Tab traversal of the controls
 * impossible.
 * ========================================================================== */

describe('the focus across a render', () => {
  it('restores the focused control after an explicit refresh', () => {
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

    // A new node at the same position, holding the focus its predecessor had.
    expect(after).not.toBe(before);
    expect(document.activeElement).toBe(after);
    expect(document.activeElement?.textContent).toBe('Export snapshot');
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
        // The tab step, plus a cadence's worth of scheduled ticks between each.
        control.focus();
        vi.advanceTimersByTime(1200);
        labels.push(document.activeElement?.textContent ?? 'lost');
      }

      expect(labels).toEqual([
        'Refresh',
        'Export metrics',
        'Export snapshot',
        'Close diagnostics',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
