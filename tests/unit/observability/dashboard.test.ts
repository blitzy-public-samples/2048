// Delivery gate for the two dashboard templates of AAP 0.6.2.7 and Rule 3:
// docs/dashboards/dashboard.html and docs/dashboards/dashboard.json.
//
// WHY THIS GATE EXISTS
//   Rule 3 admits a capability only where it can be EXERCISED locally, and
//   validation gate V8 states the dashboard template must render against an
//   exported snapshot. Both files existed and both were consistent with the
//   registry when read by eye — and nothing executed either of them. A rename
//   of one metric family, one label or one health check id would have left the
//   templates parsing perfectly and reading nothing, and every gate in the
//   repository would still have passed. That is the exposure this file closes.
//
// WHAT IS ASSERTED
//   1. The static page's own parser and renderer, executed: the real inline
//      script of docs/dashboards/dashboard.html is run in this document, fed
//      the three export forms the diagnostics overlay writes, and read back
//      panel by panel. The readings asserted are the values the registry
//      exported, derived from the same snapshot rather than restated by hand.
//   2. Its refusal paths: an empty payload, JSON that is not a snapshot, and
//      text carrying no sample are each refused with a reason and leave the
//      page renderable.
//   3. The vocabularies the page restates in ES5 — family names, label names,
//      hook names, engine event names, RNG substreams, span names, health check
//      ids, the gauge mapping and the bucket set — equal the constants the
//      application exports. A restatement that drifts fails here.
//   4. Every Grafana expression in docs/dashboards/dashboard.json resolves to a
//      canonical family, uses only canonical label names and label values, and
//      covers every family the registry declares.
//
// HOW THE EXPORTS ARE OBTAINED
//   By composing the real application and playing it: `start()` builds the real
//   logger, registry, tracer, health surface, hook bus and diagnostics overlay,
//   a fixed seed and a fixed key sequence drive real turns through them, and the
//   frames are driven through the tracer's own frame lifecycle hooks — the pair
//   src/render/render-loop.ts calls. Nothing here fabricates a series, a health
//   result or a span record.
//
// The two templates are read through Vite's `?raw` query rather than `node:fs`,
// as tests/unit/audio/sound-engine.test.ts reads a module's own text: this suite
// imports src/main.ts, and reading the files through Node would move the whole
// application into the tooling type project, where `types: ["node"]` would put
// Node globals in reach of every src/ module tsconfig.node.json exists to keep
// them out of. Decision DL-TEST-16.
//
// Decisions behind this file are recorded in docs/DECISION_LOG.md.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import dashboardMarkup from '../../../docs/dashboards/dashboard.html?raw';
import dashboardTemplateText from '../../../docs/dashboards/dashboard.json?raw';
import hookBusSource from '../../../src/engine/hook-bus.ts?raw';
import { ENGINE_EVENT_NAMES } from '../../../src/engine/engine-events';
import { HOOK_NAMES } from '../../../src/engine/hooks';
import { start } from '../../../src/main';
import type { DiagnosticsSnapshot } from '../../../src/observability/diagnostics-overlay';
import {
  HEALTH_CHECK_IDS,
  HEALTH_GAUGE_VALUES,
} from '../../../src/observability/health';
import type {
  HistogramSeriesSnapshot,
  MetricSeriesSnapshot,
} from '../../../src/observability/metrics';
import {
  DEFAULT_DURATION_BUCKETS,
  METRIC_LABELS,
  METRIC_NAMES,
  METRIC_PREFIX,
} from '../../../src/observability/metrics';
import {
  DEFAULT_FRAME_BUDGET_MS,
  SPAN_NAMES,
} from '../../../src/observability/tracer';
import { resetWebGLSupportProbe } from '../../../src/render/webgl-support';
import { RNG_STREAM_NAMES } from '../../../src/rng/rng-streams';
import { COMPOSITION_MARKUP, beginRun } from '../../fixtures/composition';
import { clearOwnedStorage } from '../../fixtures/storage';

/* ==========================================================================
 * 1. The real exports
 * ========================================================================== */

/** Seed the run is begun with, so the readings below are reproducible. */
const GATE_SEED = 'dashboard-delivery-gate';

/** Frame durations driven through the tracer's lifecycle hooks, in ms. */
const FRAME_DURATIONS: readonly number[] = Object.freeze([8, 12, 24]);

/** Movement keys pressed, in order. Four cycles of the four directions. */
const MOVES: readonly string[] = Object.freeze([
  'ArrowLeft',
  'ArrowUp',
  'ArrowRight',
  'ArrowDown',
  'ArrowLeft',
  'ArrowUp',
  'ArrowRight',
  'ArrowDown',
  'ArrowLeft',
  'ArrowUp',
  'ArrowRight',
  'ArrowDown',
  'ArrowLeft',
  'ArrowUp',
  'ArrowRight',
  'ArrowDown',
]);

/** What one composed, played session exported. */
interface CapturedExports {
  /** `toPrometheusText()` of the diagnostics surface. */
  readonly prometheusText: string;

  /** `snapshotJson()`: the combined health/traces/metrics/logs envelope. */
  readonly combinedJson: string;

  /** The metrics section alone, as a metrics-snapshot payload. */
  readonly metricsJson: string;

  /** The same reading as data, so expectations are derived and not restated. */
  readonly snapshot: DiagnosticsSnapshot;
}

let captured: CapturedExports | null = null;

/** Presses one key on the document, as a player does. */
const press = (key: string): void => {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key, code: key, bubbles: true }),
  );
};

/**
 * Composes the application, plays it, and captures what it exports.
 *
 * @returns The three export forms and the snapshot they were read from.
 */
const captureExports = (): CapturedExports => {
  document.body.innerHTML = COMPOSITION_MARKUP;
  resetWebGLSupportProbe();

  const application = start(document);

  try {
    expect(beginRun(GATE_SEED)).toBe(true);

    for (const key of MOVES) {
      press(key);
    }

    // The frame pair src/render/render-loop.ts calls, driven here so the frame
    // histogram carries real samples: one of the three is over the budget.
    const frames = application.tracer.frameLifecycleHooks();
    const context = { frame: 0 };

    for (const duration of FRAME_DURATIONS) {
      frames.onFrameBegin(context);
      frames.onFrameEnd(context, duration);
    }

    const snapshot = application.diagnostics.snapshot();

    return {
      prometheusText: application.diagnostics.toPrometheusText(),
      combinedJson: application.diagnostics.snapshotJson(),
      metricsJson: JSON.stringify(snapshot.metrics),
      snapshot,
    };
  } finally {
    application.dispose();
    document.body.innerHTML = '';
    clearOwnedStorage();
    resetWebGLSupportProbe();
  }
};

/** The captured session, or a failure if the capture did not run. */
const exports_ = (): CapturedExports => {
  if (captured === null) {
    throw new Error('the export capture did not run');
  }

  return captured;
};

beforeAll(() => {
  captured = captureExports();
});

/* ==========================================================================
 * 2. Readings derived from that snapshot
 * ========================================================================== */

/** Every series of one family, in snapshot order. */
const family = (name: string): readonly MetricSeriesSnapshot[] =>
  exports_().snapshot.metrics.series.filter((series) => series.name === name);

/** The unlabelled series of a family, as the page's `scalarOf` reads it. */
const scalar = (name: string): number | null => {
  for (const series of family(name)) {
    if (Object.keys(series.labels).length === 0 && series.kind !== 'histogram') {
      return series.value;
    }
  }

  return null;
};

/** Every series of a family summed, as the page's `totalOf` reads it. */
const total = (name: string): number | null => {
  let sum: number | null = null;

  for (const series of family(name)) {
    if (series.kind === 'histogram') {
      continue;
    }

    sum = (sum ?? 0) + series.value;
  }

  return sum;
};

/** One labelled series' value. */
const labelled = (name: string, label: string, value: string): number | null => {
  for (const series of family(name)) {
    if (series.kind !== 'histogram' && series.labels[label] === value) {
      return series.value;
    }
  }

  return null;
};

/** The one histogram series of a family. */
const histogram = (name: string): HistogramSeriesSnapshot | null => {
  for (const series of family(name)) {
    if (series.kind === 'histogram') {
      return series;
    }
  }

  return null;
};

/** `formatCount` of the page, so a rendered readout is compared as written. */
const formatCount = (value: number | null): string =>
  value === null ? 'not carried' : String(Math.round(value * 1000) / 1000);

/** `formatMilliseconds` of the page. */
const formatMilliseconds = (value: number | null): string =>
  value === null
    ? 'not carried'
    : `${(Math.round(value * 100) / 100).toFixed(2)} ms`;

/** Cumulative samples beyond one bucket bound, as `beyondBoundary` reads it. */
const beyondBoundary = (
  series: HistogramSeriesSnapshot,
  boundary: number,
): number => {
  const index = series.buckets.indexOf(boundary);

  return index === -1
    ? series.count
    : series.count - (series.bucketCounts[index] ?? 0);
};

/* ==========================================================================
 * 3. The page, executed
 * ========================================================================== */

const BODY_PATTERN = /<body[^>]*>([\s\S]*)<\/body>/u;
const SCRIPT_PATTERN = /<script>([\s\S]*?)<\/script>/u;

/** Body markup of the template, its inline script removed. */
const pageBody = ((): string => {
  const body = BODY_PATTERN.exec(dashboardMarkup);

  if (body === null) {
    throw new Error('docs/dashboards/dashboard.html carries no body');
  }

  return body[1]?.replace(SCRIPT_PATTERN, '') ?? '';
})();

/** The page's own inline script, verbatim. */
const pageScript = ((): string => {
  const script = SCRIPT_PATTERN.exec(dashboardMarkup);

  if (script === null || script[1] === undefined) {
    throw new Error('docs/dashboards/dashboard.html carries no inline script');
  }

  return script[1];
})();

/** What one loaded page answers. */
interface DashboardPage {
  /** Pastes a payload into the box and presses the render control. */
  load(text: string): void;

  /** The status line: its level attribute and its message. */
  status(): { readonly level: string | null; readonly message: string };

  /** One panel by the id it is built with, or `null` where it is absent. */
  panel(id: string): HTMLElement | null;

  /** One prominent readout of a panel, by its label. */
  readout(panelId: string, label: string): string | null;

  /** One table row of a panel, by its row header, as its cell texts. */
  row(panelId: string, header: string): readonly string[] | null;

  /** The status attribute of the status cell of one table row. */
  rowStatus(panelId: string, header: string): string | null;

  /** One bar reading of a panel, by its key. */
  bar(panelId: string, key: string): string | null;

  /** The provenance strip, label to value. */
  provenance(): Readonly<Record<string, string>>;

  /** Every panel id rendered, in document order. */
  panelIds(): readonly string[];

  /**
   * One vocabulary the page's script declares, as plain data.
   *
   * The document executes a script in ITS OWN context, so the declarations at
   * the top of the page's script are not properties of the runner's global and
   * cannot be read from here directly. They are published instead by a second
   * script this harness appends, which serialises each name from inside that
   * context into a node the two share. `null` where the page declares no such
   * name.
   */
  global(name: string): unknown;
}

/** Node the vocabulary publisher writes into. */
const VOCABULARY_ID = 'dashboard-vocabulary-probe';

/**
 * The names the publisher reads out of the page's scope. Each is a top-level
 * declaration of docs/dashboards/dashboard.html restating a constant of the
 * application, and each is held against that constant below.
 */
const PAGE_VOCABULARIES: readonly string[] = Object.freeze([
  'PREFIX',
  'NAMES',
  'LABELS',
  'REPORT_LABELS',
  'HOOK_NAMES',
  'ENGINE_EVENT_NAMES',
  'SKIP_REASONS',
  'RNG_STREAMS',
  'SPAN_NAMES',
  'HEALTH_CHECK_IDS',
  'HEALTH_CHECK_SOURCES',
  'GAUGE_TO_STATUS',
  'STATUS_LABELS',
  'DEFAULT_DURATION_BUCKETS',
  'FRAME_BUDGET_MS',
]);

/**
 * Script that publishes those names from inside the page's own scope.
 *
 * `typeof` guards every read, so a name the page does not declare is published
 * as `null` and reported by the assertion rather than thrown as a reference
 * error the document would swallow.
 */
const vocabularyPublisher = ((): string => {
  const entries = PAGE_VOCABULARIES.map(
    (name) =>
      `${JSON.stringify(name)}: typeof ${name} === "undefined" ? null : ${name}`,
  ).join(',');

  return (
    `document.getElementById(${JSON.stringify(VOCABULARY_ID)})` +
    `.textContent = JSON.stringify({${entries}});`
  );
})();

const text = (node: Element | null | undefined): string =>
  (node?.textContent ?? '').trim();

/**
 * Loads docs/dashboards/dashboard.html into this document and runs its script.
 *
 * The markup and the script are the file's own: the body is injected without
 * its `<script>` element, which browsers do not execute when assigned through
 * `innerHTML`, and the script is then appended as a real element so the
 * document executes it exactly as the browser does on open.
 *
 * @returns Readers over the loaded page.
 */
const openDashboard = (): DashboardPage => {
  document.body.innerHTML = pageBody;

  const probe = document.createElement('pre');

  probe.id = VOCABULARY_ID;
  probe.hidden = true;
  document.body.appendChild(probe);

  const element = document.createElement('script');

  element.textContent = pageScript;
  document.body.appendChild(element);

  const publisher = document.createElement('script');

  publisher.textContent = vocabularyPublisher;
  document.body.appendChild(publisher);

  const vocabularies = ((): Readonly<Record<string, unknown>> => {
    const published = probe.textContent ?? '';

    if (published.length === 0) {
      throw new Error('the page published no vocabulary');
    }

    return JSON.parse(published) as Readonly<Record<string, unknown>>;
  })();

  const panelOf = (id: string): HTMLElement | null =>
    document.querySelector<HTMLElement>(`[aria-labelledby="panel-${id}"]`);

  const rowOf = (panelId: string, header: string): HTMLElement | null => {
    const host = panelOf(panelId);

    if (host === null) {
      return null;
    }

    for (const candidate of host.querySelectorAll<HTMLElement>('tbody tr')) {
      if (text(candidate.querySelector('th')) === header) {
        return candidate;
      }
    }

    return null;
  };

  return {
    load: (payload: string): void => {
      const box = document.querySelector<HTMLTextAreaElement>('#snapshot-text');
      const control = document.querySelector<HTMLElement>('#render-pasted');

      if (box === null || control === null) {
        throw new Error('the page carries no paste box or render control');
      }

      box.value = payload;
      control.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    },

    status: (): { readonly level: string | null; readonly message: string } => {
      const host = document.querySelector<HTMLElement>('#status');

      return {
        level: host?.getAttribute('data-level') ?? null,
        message: text(host),
      };
    },

    panel: panelOf,

    readout: (panelId: string, label: string): string | null => {
      const host = panelOf(panelId);

      if (host === null) {
        return null;
      }

      for (const entry of host.querySelectorAll<HTMLElement>('.readout')) {
        if (text(entry.querySelector('dt')) === label) {
          return text(entry.querySelector('dd'));
        }
      }

      return null;
    },

    row: (panelId: string, header: string): readonly string[] | null => {
      const found = rowOf(panelId, header);

      return found === null
        ? null
        : [...found.children].map((cell): string => text(cell));
    },

    rowStatus: (panelId: string, header: string): string | null => {
      const found = rowOf(panelId, header);

      return (
        found?.querySelector('[data-status]')?.getAttribute('data-status') ??
        null
      );
    },

    bar: (panelId: string, key: string): string | null => {
      const host = panelOf(panelId);
      const list = host?.querySelector('dl.histogram');

      if (list === null || list === undefined) {
        return null;
      }

      const nodes = [...list.children];

      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];

        if (node?.tagName === 'DT' && text(node) === key) {
          return text(nodes[index + 2]);
        }
      }

      return null;
    },

    provenance: (): Readonly<Record<string, string>> => {
      const host = document.querySelector<HTMLElement>('#provenance');
      const read: Record<string, string> = {};

      for (const entry of host?.children ?? []) {
        read[text(entry.querySelector('dt'))] = text(entry.querySelector('dd'));
      }

      return read;
    },

    panelIds: (): readonly string[] =>
      [...document.querySelectorAll('[aria-labelledby^="panel-"]')].map(
        (node): string =>
          (node.getAttribute('aria-labelledby') ?? '').slice('panel-'.length),
      ),

    global: (name: string): unknown => vocabularies[name] ?? null,
  };
};

let page: DashboardPage | null = null;

const dashboard = (): DashboardPage => {
  if (page === null) {
    throw new Error('the dashboard page was not opened');
  }

  return page;
};

beforeEach(() => {
  page = openDashboard();
});

afterEach(() => {
  page = null;
  document.body.innerHTML = '';
});

/* ==========================================================================
 * 4. The Prometheus text export, rendered
 * ========================================================================== */

describe('the static dashboard, fed the Prometheus text export', () => {
  it('opens with no snapshot and says so', () => {
    const dash = dashboard();

    expect(dash.status().level).toBe('empty');
    expect(dash.status().message).toContain('No snapshot loaded.');
    expect(dash.provenance().Snapshot).toBe('none loaded');
  });

  it('loads the export and reports what it read', () => {
    const dash = dashboard();

    dash.load(exports_().prometheusText);

    const status = dash.status();

    expect(status.level).toBe('loaded');
    expect(status.message).toContain('the pasted text');
    expect(status.message).toContain('Prometheus text exposition');

    // CHANGED: the exposition form counts SAMPLE LINES, which is the unit it
    // actually carries — one histogram is one series in the JSON form but
    // seventeen lines here — so the page reports the two forms under different
    // nouns and this reads the one it renders.
    expect(status.message).toMatch(/\d+ sample lines\./u);
    expect(status.message).not.toContain('could not be read');
  });

  it('renders the run totals the registry exported', () => {
    const dash = dashboard();

    dash.load(exports_().prometheusText);

    const turns = scalar(METRIC_NAMES.turnsTotal);

    expect(turns).not.toBeNull();
    expect(turns ?? 0).toBeGreaterThan(0);
    expect(dash.readout('run-totals', 'turns')).toBe(formatCount(turns));
    expect(dash.readout('run-totals', 'merges')).toBe(
      formatCount(total(METRIC_NAMES.mergesTotal)),
    );
    expect(dash.readout('run-totals', 'spawns')).toBe(
      formatCount(total(METRIC_NAMES.spawnsTotal)),
    );
    expect(dash.readout('run-totals', 'frames rendered')).toBe(
      formatCount(total(METRIC_NAMES.framesRenderedTotal)),
    );
  });

  it('renders the three spawn counters as their own rows', () => {
    const dash = dashboard();

    dash.load(exports_().prometheusText);

    expect(dash.row('spawn-outcomes', METRIC_NAMES.spawnAttemptsTotal)).toEqual(
      [
        METRIC_NAMES.spawnAttemptsTotal,
        formatCount(total(METRIC_NAMES.spawnAttemptsTotal)),
      ],
    );
    expect(dash.row('spawn-outcomes', METRIC_NAMES.spawnsTotal)).toEqual([
      METRIC_NAMES.spawnsTotal,
      formatCount(total(METRIC_NAMES.spawnsTotal)),
    ]);
    expect(
      dash.row('spawn-outcomes', METRIC_NAMES.spawnSuppressedTotal),
    ).toEqual([
      METRIC_NAMES.spawnSuppressedTotal,
      formatCount(total(METRIC_NAMES.spawnSuppressedTotal)),
    ]);
  });

  it('renders engine events under the event label', () => {
    const dash = dashboard();

    dash.load(exports_().prometheusText);

    const commits = labelled(
      METRIC_NAMES.engineEventsTotal,
      METRIC_LABELS.event,
      'state:commit',
    );

    expect(commits).not.toBeNull();
    expect(dash.bar('engine-events', 'state:commit')).toBe(
      formatCount(commits),
    );
  });

  it('renders hook dispatch counts under the hook label', () => {
    const dash = dashboard();

    dash.load(exports_().prometheusText);

    const dispatched = labelled(
      METRIC_NAMES.hookDispatchesTotal,
      METRIC_LABELS.hook,
      'onBeforeMove',
    );
    const invoked = labelled(
      METRIC_NAMES.hookHandlerInvocationsTotal,
      METRIC_LABELS.hook,
      'onBeforeMove',
    );

    expect(dispatched).not.toBeNull();
    expect(dash.row('hook-counts', 'onBeforeMove')?.slice(0, 3)).toEqual([
      'onBeforeMove',
      formatCount(dispatched),
      formatCount(invoked),
    ]);
  });

  it('renders the frame histogram against the budget', () => {
    const dash = dashboard();

    dash.load(exports_().prometheusText);

    const frames = histogram(METRIC_NAMES.frameTimeMilliseconds);

    expect(frames).not.toBeNull();

    if (frames === null) {
      return;
    }

    expect(frames.count).toBe(FRAME_DURATIONS.length);
    expect(dash.readout('frame-budget', 'mean')).toBe(
      formatMilliseconds(frames.sum / frames.count),
    );
    expect(dash.readout('frame-budget', `over ${DEFAULT_FRAME_BUDGET_MS} ms`))
      .toBe(formatCount(beyondBoundary(frames, DEFAULT_FRAME_BUDGET_MS)));
  });

  it('renders the turn latency the tracer measured', () => {
    const dash = dashboard();

    dash.load(exports_().prometheusText);

    const turns = histogram(METRIC_NAMES.turnLatencyMilliseconds);

    expect(turns).not.toBeNull();
    expect(turns?.count ?? 0).toBeGreaterThan(0);
    expect(dash.readout('turn-latency', 'mean')).toBe(
      formatMilliseconds(
        turns === null ? null : turns.sum / Math.max(1, turns.count),
      ),
    );
  });

  it('renders all six health checks from the gauge alone', () => {
    const dash = dashboard();

    dash.load(exports_().prometheusText);

    for (const check of exports_().snapshot.health.checks) {
      expect(dash.rowStatus('health', check.id)).toBe(check.status);
      expect(dash.row('health', check.id)?.[2]).toBe(
        'not carried by this form',
      );
    }

    expect(exports_().snapshot.health.checks.map((row) => row.id)).toEqual([
      ...HEALTH_CHECK_IDS,
    ]);
  });

  it('renders the RNG substreams the run drew from', () => {
    const dash = dashboard();

    dash.load(exports_().prometheusText);

    for (const stream of RNG_STREAM_NAMES) {
      const draws = labelled(
        METRIC_NAMES.rngDrawsTotal,
        METRIC_LABELS.stream,
        stream,
      );

      if (draws === null) {
        continue;
      }

      expect(dash.bar('rng-streams', stream)).toBe(formatCount(draws));
    }

    expect(total(METRIC_NAMES.rngDrawsTotal) ?? 0).toBeGreaterThan(0);
  });

  it('carries neither trace nor log panels in this form', () => {
    const dash = dashboard();

    dash.load(exports_().prometheusText);

    expect(dash.panel('traces')).toBeNull();
    expect(dash.panel('logs')).toBeNull();
    expect(dash.panel('readiness')).toBeNull();
  });

  it('names the form, and what the form cannot carry', () => {
    const dash = dashboard();

    dash.load(exports_().prometheusText);

    const provenance = dash.provenance();

    expect(provenance.Form).toBe('Prometheus text exposition');
    expect(provenance['Correlation id']).toBe(
      'not carried by the Prometheus text form',
    );
    expect(provenance['Generated at']).toBe(
      'not carried by the Prometheus text form',
    );
    // CHANGED: `readingLabel` for this form is "Sample lines read"; "Series
    // read" is the JSON form's label, and reading it here asserted on an absent
    // row rather than on the count.
    expect(provenance['Sample lines read']).toMatch(/^\d+$/u);
  });
});

/* ==========================================================================
 * 5. The combined diagnostics export, rendered
 * ========================================================================== */

describe('the static dashboard, fed the combined diagnostics export', () => {
  it('names the combined form and its correlation identifier', () => {
    const dash = dashboard();

    dash.load(exports_().combinedJson);

    const provenance = dash.provenance();

    expect(dash.status().level).toBe('loaded');
    expect(dash.status().message).toContain('combined diagnostics snapshot');
    expect(provenance.Form).toBe('combined diagnostics snapshot');
    expect(provenance['Correlation id']).toBe(exports_().snapshot.correlationId);
    expect(provenance['Schema version']).toBe(
      String(exports_().snapshot.schemaVersion),
    );
  });

  it('renders the health detail the combined form carries', () => {
    const dash = dashboard();

    dash.load(exports_().combinedJson);

    for (const check of exports_().snapshot.health.checks) {
      expect(dash.rowStatus('health', check.id)).toBe(check.status);
      expect(dash.row('health', check.id)?.[2]).toBe(check.detail);
    }
  });

  it('renders the readiness verdicts only this form carries', () => {
    const dash = dashboard();

    dash.load(exports_().combinedJson);

    const readiness = exports_().snapshot.health.readiness;

    expect(readiness).not.toBeNull();

    if (readiness === null) {
      return;
    }

    expect(dash.row('readiness', 'ready')).toEqual([
      'ready',
      String(readiness.ready),
    ]);
    expect(dash.row('readiness', 'renderer')).toEqual([
      'renderer',
      String(readiness.renderer),
    ]);
    expect(dash.row('readiness', 'storage strategy')).toEqual([
      'storage strategy',
      String(readiness.storageStrategy),
    ]);
    expect(dash.row('readiness', 'health status')).toEqual([
      'health status',
      String(readiness.healthStatus),
    ]);
  });

  it('renders the tracer counters the snapshot carries', () => {
    const dash = dashboard();

    dash.load(exports_().combinedJson);

    const traces = exports_().snapshot.traces;

    expect(traces).not.toBeNull();

    if (traces === null) {
      return;
    }

    expect(traces.started).toBeGreaterThan(0);
    expect(dash.row('traces', 'spans started')).toEqual([
      'spans started',
      String(traces.started),
    ]);
    expect(dash.row('traces', 'spans ended')).toEqual([
      'spans ended',
      String(traces.ended),
    ]);
    expect(dash.row('traces', 'frames.frames')).toEqual([
      'frames.frames',
      String(traces.frames.frames),
    ]);
  });

  it('renders the hook counts the bus reported, not only the gauge', () => {
    const dash = dashboard();

    dash.load(exports_().combinedJson);

    const hooks = exports_().snapshot.hooks;

    expect(hooks.map((row) => row.hook)).toEqual([...HOOK_NAMES]);

    for (const row of hooks) {
      expect(dash.row('hook-counts', row.hook)?.slice(0, 4)).toEqual([
        row.hook,
        formatCount(row.dispatched),
        formatCount(row.invoked),
        formatCount(row.skipped),
      ]);
    }
  });

  it('renders the tail of the log ring buffer', () => {
    const dash = dashboard();

    dash.load(exports_().combinedJson);

    const logs = exports_().snapshot.logs;
    const last = logs.at(-1);

    expect(logs.length).toBeGreaterThan(0);
    expect(last).not.toBeUndefined();

    if (last === undefined) {
      return;
    }

    const rendered = dash.panel('logs');

    expect(rendered).not.toBeNull();
    expect(text(rendered)).toContain(last.message);
    expect(text(rendered)).toContain(exports_().snapshot.correlationId);
  });

  it('renders every panel the in-page surface renders', () => {
    const dash = dashboard();

    dash.load(exports_().combinedJson);

    expect(dash.panelIds()).toEqual([
      'run-totals',
      'spawn-outcomes',
      'engine-events',
      'frame-budget',
      'frame-distribution',
      'turn-latency',
      'turn-distribution',
      'span-boundaries',
      'hook-counts',
      'hook-skips',
      'relic-errors',
      'rng-streams',
      'health',
      'readiness',
      'reports',
      'refusals',
      'traces',
      'logs',
    ]);
  });
});

/* ==========================================================================
 * 6. The metrics-only JSON export, rendered
 * ========================================================================== */

describe('the static dashboard, fed the metrics snapshot as JSON', () => {
  it('reads the same totals out of the JSON form as out of the text', () => {
    const dash = dashboard();

    dash.load(exports_().metricsJson);

    expect(dash.status().level).toBe('loaded');
    expect(dash.status().message).toContain('metrics snapshot');
    expect(dash.status().message).not.toContain('combined');
    expect(dash.readout('run-totals', 'turns')).toBe(
      formatCount(scalar(METRIC_NAMES.turnsTotal)),
    );
    expect(dash.readout('run-totals', 'merges')).toBe(
      formatCount(total(METRIC_NAMES.mergesTotal)),
    );
  });

  it('carries the identifiers the metrics section itself carries', () => {
    const dash = dashboard();

    dash.load(exports_().metricsJson);

    expect(dash.provenance()['Correlation id']).toBe(
      exports_().snapshot.metrics.correlationId,
    );
    expect(dash.panel('traces')).toBeNull();
  });
});

/* ==========================================================================
 * 7. The refusal paths
 * ========================================================================== */

describe('the static dashboard, fed something it cannot read', () => {
  it('refuses an empty payload', () => {
    const dash = dashboard();

    dash.load('   ');

    expect(dash.status().level).toBe('error');
    expect(dash.status().message).toContain('empty');
  });

  it('refuses JSON that is not a snapshot, and says what one carries', () => {
    const dash = dashboard();

    dash.load('{"correlationId":"c","series":"not-an-array"}');

    expect(dash.status().level).toBe('error');
    expect(dash.status().message).toContain('series');
  });

  it('refuses text carrying no sample, and names a line that is one', () => {
    const dash = dashboard();

    dash.load('this text carries prose and no sample at all');

    expect(dash.status().level).toBe('error');
    expect(dash.status().message).toContain(METRIC_NAMES.turnsTotal);
  });

  it('keeps the earlier render and marks it as the earlier snapshot', () => {
    const dash = dashboard();

    dash.load(exports_().prometheusText);
    dash.load('{');

    expect(dash.status().level).toBe('error');
    expect(dash.panel('run-totals')).not.toBeNull();
    expect(
      document.querySelector('#panels')?.getAttribute('data-stale'),
    ).toBe('true');
  });
});

/* ==========================================================================
 * 8. The vocabularies the page restates
 * ========================================================================== */

describe('the vocabularies docs/dashboards/dashboard.html restates', () => {
  it('restates the metric prefix and every family name', () => {
    const dash = dashboard();

    expect(dash.global('PREFIX')).toBe(METRIC_PREFIX);

    const names = dash.global('NAMES') as Record<string, string>;

    for (const [key, name] of Object.entries(METRIC_NAMES)) {
      expect(names[key]).toBe(name);
    }

    // The one family declared in src/main.ts rather than in metrics.ts, held
    // against what the composed application actually exported.
    expect(names.reportsTotal).toBe(`${METRIC_PREFIX}reports_total`);
    expect(family(`${METRIC_PREFIX}reports_total`).length).toBeGreaterThan(0);
    expect(Object.keys(names)).toEqual([
      ...Object.keys(METRIC_NAMES),
      'reportsTotal',
    ]);
  });

  it('restates the label names', () => {
    expect(dashboard().global('LABELS')).toEqual({ ...METRIC_LABELS });
  });

  it('restates the report labels src/main.ts puts on its family', () => {
    const reportLabels = dashboard().global('REPORT_LABELS') as Record<
      string,
      string
    >;
    const observed = new Set<string>();

    for (const series of family(`${METRIC_PREFIX}reports_total`)) {
      for (const label of Object.keys(series.labels)) {
        observed.add(label);
      }
    }

    expect(observed.has(reportLabels.report ?? '')).toBe(true);
    expect(observed.has(reportLabels.subsystem ?? '')).toBe(true);
  });

  it('restates the hook, event, substream and span vocabularies', () => {
    const dash = dashboard();

    expect(dash.global('HOOK_NAMES')).toEqual([...HOOK_NAMES]);
    expect(dash.global('ENGINE_EVENT_NAMES')).toEqual([...ENGINE_EVENT_NAMES]);
    expect(dash.global('RNG_STREAMS')).toEqual([...RNG_STREAM_NAMES]);

    // Every span name the page lists is a span the tracer opens, and the one
    // name it omits is the inert span, which is never timed.
    const spans = dash.global('SPAN_NAMES') as readonly string[];
    const opened = Object.values(SPAN_NAMES);

    expect(spans).toEqual(opened.filter((name) => name !== SPAN_NAMES.inert));
  });

  it('restates the health check ids and the gauge mapping', () => {
    const dash = dashboard();

    expect(dash.global('HEALTH_CHECK_IDS')).toEqual([...HEALTH_CHECK_IDS]);

    const mapping = dash.global('GAUGE_TO_STATUS') as Record<string, string>;

    for (const [status, value] of Object.entries(HEALTH_GAUGE_VALUES)) {
      expect(mapping[String(value)]).toBe(status);
    }

    expect(Object.keys(mapping)).toHaveLength(
      Object.keys(HEALTH_GAUGE_VALUES).length,
    );
    expect(
      Object.keys(dash.global('HEALTH_CHECK_SOURCES') as object).sort(),
    ).toEqual([...HEALTH_CHECK_IDS].sort());

    // The status column carries a label per status, plus the one the page adds
    // for a check the loaded form did not report.
    expect(Object.keys(dash.global('STATUS_LABELS') as object).sort()).toEqual(
      [...Object.keys(HEALTH_GAUGE_VALUES), 'unknown'].sort(),
    );
  });

  it('restates the bucket set, the frame budget and the skip reasons', () => {
    const dash = dashboard();

    expect(dash.global('DEFAULT_DURATION_BUCKETS')).toEqual([
      ...DEFAULT_DURATION_BUCKETS,
    ]);
    expect(dash.global('FRAME_BUDGET_MS')).toBe(DEFAULT_FRAME_BUDGET_MS);

    // The skip reasons are a union type, so the declaration itself is the
    // vocabulary: there is no runtime constant to read.
    const declaration =
      /export type HookSkipReason =([^;]+);/u.exec(hookBusSource);

    expect(declaration).not.toBeNull();

    const declared = [...(declaration?.[1] ?? '').matchAll(/'([^']+)'/gu)].map(
      (match): string => match[1] ?? '',
    );

    expect(declared.length).toBeGreaterThan(0);
    expect(dash.global('SKIP_REASONS')).toEqual(declared);
  });
});

/* ==========================================================================
 * 9. The Grafana template
 * ========================================================================== */

/** One query of one panel. */
interface TemplateTarget {
  readonly refId?: unknown;
  readonly expr?: unknown;
  readonly legendFormat?: unknown;
  readonly datasource?: unknown;
}

/** One panel, including the row panels that carry no query. */
interface TemplatePanel {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly title?: unknown;
  readonly datasource?: unknown;
  readonly targets?: unknown;
}

/** The template as parsed. */
interface DashboardTemplate {
  readonly title?: unknown;
  readonly uid?: unknown;
  readonly schemaVersion?: unknown;
  readonly panels?: unknown;
  readonly templating?: unknown;
}

const template = JSON.parse(dashboardTemplateText) as DashboardTemplate;

const templatePanels: readonly TemplatePanel[] = Array.isArray(template.panels)
  ? (template.panels as readonly TemplatePanel[])
  : [];

const targetsOf = (panel: TemplatePanel): readonly TemplateTarget[] =>
  Array.isArray(panel.targets)
    ? (panel.targets as readonly TemplateTarget[])
    : [];

/** Every expression in the file, paired with the panel that carries it. */
const templateQueries: readonly { panel: string; expr: string }[] =
  templatePanels.flatMap((panel) =>
    targetsOf(panel).map((target) => ({
      panel: String(panel.title ?? panel.id ?? 'untitled'),
      expr: String(target.expr ?? ''),
    })),
  );

/** The datasource variable every panel references. */
const DATASOURCE_REFERENCE = '${DS}';

/** Suffixes the histogram exposition appends. */
const HISTOGRAM_SUFFIXES: readonly string[] = Object.freeze([
  '_bucket',
  '_sum',
  '_count',
]);

/** PromQL tokens the expressions may name besides a metric family. */
const PROMQL_TOKENS: ReadonlySet<string> = new Set([
  'histogram_quantile',
  'sum',
  'by',
  'le',
]);

/** The one family declared in src/main.ts rather than in metrics.ts. */
const REPORT_FAMILY = `${METRIC_PREFIX}reports_total`;

/** Every family a dashboard expression may name. */
const CANONICAL_FAMILIES: ReadonlySet<string> = new Set([
  ...Object.values(METRIC_NAMES),
  REPORT_FAMILY,
]);

/** Every label name src/observability/metrics.ts declares. */
const CANONICAL_LABELS: ReadonlySet<string> = new Set<string>(
  Object.values(METRIC_LABELS),
);

/** Label values that are fixed vocabularies rather than free text. */
const LABEL_VOCABULARIES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    [METRIC_LABELS.hook]: [...HOOK_NAMES],
    [METRIC_LABELS.event]: [...ENGINE_EVENT_NAMES],
    [METRIC_LABELS.stream]: [...RNG_STREAM_NAMES],
    [METRIC_LABELS.check]: [...HEALTH_CHECK_IDS],
    [METRIC_LABELS.span]: Object.values(SPAN_NAMES),
  });

const MATCHER_BLOCK = /\{([^}]*)\}/gu;
const MATCHER = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:=~|!~|=|!=)\s*"([^"]*)"/gu;
const BY_LIST = /by\s*\(([^)]*)\)/gu;
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/gu;
const INTERPOLATION = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/gu;
const VARIABLE_REFERENCE = /\$([A-Za-z_][A-Za-z0-9_]*)/gu;

/** Base name of a family reference, with any histogram suffix removed. */
const baseFamily = (
  reference: string,
): { readonly name: string; readonly suffix: string | null } => {
  for (const suffix of HISTOGRAM_SUFFIXES) {
    if (reference.endsWith(suffix)) {
      return { name: reference.slice(0, -suffix.length), suffix };
    }
  }

  return { name: reference, suffix: null };
};

describe('the Grafana template docs/dashboards/dashboard.json declares', () => {
  it('parses, and declares the fields an import needs', () => {
    expect(typeof template.title).toBe('string');
    expect(String(template.title).length).toBeGreaterThan(0);
    expect(typeof template.uid).toBe('string');
    expect(String(template.uid).length).toBeGreaterThan(0);
    expect(typeof template.schemaVersion).toBe('number');
    expect(templatePanels.length).toBeGreaterThan(0);
  });

  it('declares every panel with an identity, a type and a title', () => {
    const problems: string[] = [];
    const seen = new Set<number>();

    for (const panel of templatePanels) {
      const identity = `panel ${String(panel.id)} (${String(panel.title)})`;

      if (typeof panel.id !== 'number') {
        problems.push(`${identity}: no numeric id`);
      } else if (seen.has(panel.id)) {
        problems.push(`${identity}: duplicate id`);
      } else {
        seen.add(panel.id);
      }

      if (typeof panel.type !== 'string' || panel.type.length === 0) {
        problems.push(`${identity}: no type`);
      }

      if (typeof panel.title !== 'string' || panel.title.length === 0) {
        problems.push(`${identity}: no title`);
      }

      const targets = targetsOf(panel);

      if (panel.type !== 'row' && targets.length === 0) {
        problems.push(`${identity}: no query`);
      }

      if (panel.type === 'row' && targets.length > 0) {
        problems.push(`${identity}: a row panel carries a query`);
      }

      const refIds = new Set<string>();

      for (const target of targets) {
        const refId = String(target.refId ?? '');

        if (refId.length === 0) {
          problems.push(`${identity}: a query carries no refId`);
        } else if (refIds.has(refId)) {
          problems.push(`${identity}: duplicate refId ${refId}`);
        } else {
          refIds.add(refId);
        }

        if (String(target.expr ?? '').length === 0) {
          problems.push(`${identity}: query ${refId} carries no expression`);
        }
      }
    }

    expect(problems).toEqual([]);
  });

  it('points every panel and every query at the declared data source', () => {
    const problems: string[] = [];
    const uidOf = (value: unknown): string | null => {
      if (typeof value !== 'object' || value === null) {
        return null;
      }

      const uid = (value as { readonly uid?: unknown }).uid;

      return typeof uid === 'string' ? uid : null;
    };

    for (const panel of templatePanels) {
      const identity = `panel ${String(panel.id)}`;

      if (uidOf(panel.datasource) !== DATASOURCE_REFERENCE) {
        problems.push(`${identity}: datasource is not ${DATASOURCE_REFERENCE}`);
      }

      for (const target of targetsOf(panel)) {
        if (uidOf(target.datasource) !== DATASOURCE_REFERENCE) {
          problems.push(
            `${identity} query ${String(target.refId)}: datasource is not ` +
              DATASOURCE_REFERENCE,
          );
        }
      }
    }

    expect(problems).toEqual([]);
  });

  it('names only canonical families, with a legal histogram suffix', () => {
    const histogramFamilies = new Set<string>(
      exports_()
        .snapshot.metrics.series.filter((series) => series.kind === 'histogram')
        .map((series) => series.name),
    );

    expect(histogramFamilies.size).toBeGreaterThan(0);

    const problems: string[] = [];

    for (const query of templateQueries) {
      // Quoted values, label matchers and grouping lists are each validated by
      // their own assertion above, so what is left here is the operators, the
      // functions and the family references themselves.
      const bare = query.expr
        .replace(/"[^"]*"/gu, '""')
        .replace(MATCHER_BLOCK, '')
        .replace(BY_LIST, 'by');

      for (const identifier of bare.match(IDENTIFIER) ?? []) {
        if (!identifier.startsWith(METRIC_PREFIX)) {
          if (!PROMQL_TOKENS.has(identifier)) {
            problems.push(`${query.panel}: unknown token ${identifier}`);
          }

          continue;
        }

        const read = baseFamily(identifier);

        if (!CANONICAL_FAMILIES.has(read.name)) {
          problems.push(`${query.panel}: unknown family ${identifier}`);

          continue;
        }

        if (read.suffix !== null && !histogramFamilies.has(read.name)) {
          problems.push(
            `${query.panel}: ${read.suffix} on non-histogram ${read.name}`,
          );
        }
      }
    }

    expect(problems).toEqual([]);
  });

  it('reads every family the registry declares', () => {
    const referenced = new Set<string>();

    for (const query of templateQueries) {
      for (const identifier of query.expr.match(IDENTIFIER) ?? []) {
        if (identifier.startsWith(METRIC_PREFIX)) {
          referenced.add(baseFamily(identifier).name);
        }
      }
    }

    const missing = [...CANONICAL_FAMILIES].filter(
      (name) => !referenced.has(name),
    );

    expect(missing).toEqual([]);
  });

  it('matches and groups by canonical label names alone', () => {
    const declared = new Set<string>();

    for (const series of exports_().snapshot.metrics.series) {
      for (const label of Object.keys(series.labels)) {
        declared.add(label);
      }
    }

    const known = new Set<string>([
      ...declared,
      ...Object.values(METRIC_LABELS),
      'le',
    ]);
    const problems: string[] = [];

    for (const query of templateQueries) {
      for (const block of query.expr.match(MATCHER_BLOCK) ?? []) {
        for (const matcher of block.matchAll(MATCHER)) {
          if (!known.has(matcher[1] ?? '')) {
            problems.push(`${query.panel}: unknown label ${String(matcher[1])}`);
          }
        }
      }

      for (const grouping of query.expr.matchAll(BY_LIST)) {
        for (const label of (grouping[1] ?? '').split(',')) {
          const name = label.trim();

          if (name.length > 0 && !known.has(name)) {
            problems.push(`${query.panel}: grouped by unknown label ${name}`);
          }
        }
      }

      for (const interpolation of String(query.expr).matchAll(INTERPOLATION)) {
        if (!known.has(interpolation[1] ?? '')) {
          problems.push(
            `${query.panel}: interpolates unknown label ` +
              String(interpolation[1]),
          );
        }
      }
    }

    expect(problems).toEqual([]);
  });

  it('matches only label values the application can emit', () => {
    const variables = new Set<string>();
    const list = (template.templating as { readonly list?: unknown } | null)
      ?.list;

    for (const variable of Array.isArray(list) ? list : []) {
      const name = (variable as { readonly name?: unknown }).name;

      if (typeof name === 'string') {
        variables.add(name);
      }
    }

    expect(variables.size).toBeGreaterThan(0);

    const problems: string[] = [];

    for (const query of templateQueries) {
      for (const block of query.expr.match(MATCHER_BLOCK) ?? []) {
        for (const matcher of block.matchAll(MATCHER)) {
          const label = matcher[1] ?? '';
          const vocabulary = LABEL_VOCABULARIES[label];

          if (vocabulary === undefined) {
            continue;
          }

          for (const alternative of (matcher[2] ?? '').split('|')) {
            const value = alternative.trim();

            if (value.startsWith('$')) {
              if (!variables.has(value.slice(1))) {
                problems.push(`${query.panel}: undeclared variable ${value}`);
              }

              continue;
            }

            if (!vocabulary.includes(value)) {
              problems.push(`${query.panel}: ${label} cannot be "${value}"`);
            }
          }
        }
      }

      for (const reference of query.expr.matchAll(VARIABLE_REFERENCE)) {
        if (!variables.has(reference[1] ?? '')) {
          problems.push(
            `${query.panel}: undeclared variable $${String(reference[1])}`,
          );
        }
      }
    }

    expect(problems).toEqual([]);
  });

  it('quantiles the bucket family, grouped by le', () => {
    const problems: string[] = [];

    for (const query of templateQueries) {
      if (!query.expr.includes('histogram_quantile(')) {
        continue;
      }

      const quantile = /histogram_quantile\(\s*([0-9.]+)/u.exec(query.expr);
      const read = Number(quantile?.[1] ?? Number.NaN);

      if (!(read > 0 && read < 1)) {
        problems.push(`${query.panel}: quantile ${String(quantile?.[1])}`);
      }

      if (!query.expr.includes('_bucket')) {
        problems.push(`${query.panel}: quantile over a non-bucket family`);
      }

      if (!/by\s*\(\s*le\b/u.test(query.expr)) {
        problems.push(`${query.panel}: quantile not grouped by le`);
      }
    }

    expect(problems).toEqual([]);
  });

  it('resolves its hook variable against a canonical family and label', () => {
    const list = (template.templating as { readonly list?: unknown } | null)
      ?.list;
    const queries: string[] = [];

    for (const variable of Array.isArray(list) ? list : []) {
      const query = (variable as { readonly query?: unknown }).query;

      if (typeof query === 'string') {
        queries.push(query);

        continue;
      }

      const inner = (query as { readonly query?: unknown } | null)?.query;

      if (typeof inner === 'string') {
        queries.push(inner);
      }
    }

    const values = queries.filter((query) => query.startsWith('label_values('));

    expect(values.length).toBeGreaterThan(0);

    const problems: string[] = [];

    for (const query of values) {
      const read = /^label_values\(\s*([^,]+)\s*,\s*([^)]+)\)$/u.exec(query);

      if (read === null) {
        problems.push(`unreadable variable query ${query}`);

        continue;
      }

      const familyName = (read[1] ?? '').trim();
      const label = (read[2] ?? '').trim();

      if (!CANONICAL_FAMILIES.has(familyName)) {
        problems.push(`variable query names unknown family ${familyName}`);
      }

      if (!CANONICAL_LABELS.has(label)) {
        problems.push(`variable query names unknown label ${label}`);
      }
    }

    expect(problems).toEqual([]);
  });
});
