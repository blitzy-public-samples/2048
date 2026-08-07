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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDiagnosticsOverlay } from '../../../src/observability/diagnostics-overlay';
import type { DiagnosticsOverlay } from '../../../src/observability/diagnostics-overlay';
import { METRIC_PREFIX, createMetricsRegistry } from '../../../src/observability/metrics';
import type { MetricsRegistry } from '../../../src/observability/metrics';
import { createLogger, deriveCorrelationId } from '../../../src/observability/logger';
import type { Logger } from '../../../src/observability/logger';

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

    expect(controls.map((control) => control.textContent)).toEqual([
      'Refresh',
      'Export metrics',
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
