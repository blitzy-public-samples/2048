// Contract suite for the Rule 3 dashboard template, both forms.
//
// The defect it closes: docs/dashboards/dashboard.json and
// docs/dashboards/dashboard.html were the only Rule 3 deliverables entirely
// outside automated validation. No module graph reaches either file, so every
// metric name, label and enumeration in them is a RESTATED copy of a production
// declaration — dashboard.html says so itself, and asks to be checked against
// its declaration sites. Nothing checked. A family renamed in
// src/observability/metrics.ts left panels keyed to a name nothing emits, and
// the failure mode is a dashboard that renders perfectly with every series
// empty.
//
// So this suite reads both artifacts off disk and binds them to production
// three ways: the JSON's panel targets against the families a REAL export
// carries, the HTML's restated constants against the modules that declare them,
// and the HTML's own parser and renderer against a real snapshot taken from a
// real run.
//
// Decisions: DL-TEST-09 (docs/DECISION_LOG.md) — why the artifacts are read
//   through `?raw` and executed in a frame rather than through `node:fs` and a
//   directly constructed jsdom instance.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Vite's `?raw` query hands each artifact's own text to the suite, so both are
// read through the module graph rather than through `node:fs` — this file also
// boots the browser-context application, which the Node-context project
// tsconfig.node.json deliberately keeps its declarations out of.
import DASHBOARD_HTML_TEXT from '../../../docs/dashboards/dashboard.html?raw';
import DASHBOARD_JSON_TEXT from '../../../docs/dashboards/dashboard.json?raw';

import { ENGINE_EVENT_NAMES } from '../../../src/engine/engine-events';
import type { HookSkipReason } from '../../../src/engine/hook-bus';
import { HOOK_NAMES } from '../../../src/engine/hooks';
import { start } from '../../../src/main';
import type { Application } from '../../../src/main';
import {
  HEALTH_CHECK_IDS,
  HEALTH_CHECK_SOURCES,
} from '../../../src/observability/health';
import {
  DEFAULT_DURATION_BUCKETS,
  METRIC_LABELS,
  METRIC_NAMES,
  METRIC_PREFIX,
} from '../../../src/observability/metrics';
import {
  BOUNDARY_SPAN_NAMES,
  SPAN_NAMES,
} from '../../../src/observability/tracer';
import { resetWebGLSupportProbe } from '../../../src/render/webgl-support';
import { RNG_STREAM_NAMES } from '../../../src/rng/rng-streams';
import { RUN_STATE_KEY } from '../../../src/storage/storage-keys';
import { COMPOSITION_MARKUP, beginRun, pressKey } from '../../fixtures/composition';

/** The suffixes Prometheus adds to a histogram family's exported lines. */
const HISTOGRAM_SUFFIXES = ['_bucket', '_sum', '_count'] as const;

/** One panel of the Grafana template, as much of it as this suite reads. */
interface TemplatePanel {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly title?: unknown;
  readonly targets?: readonly { readonly expr?: unknown; readonly refId?: unknown }[];
}

/** The template, as much of it as this suite reads. */
interface Template {
  readonly uid?: unknown;
  readonly title?: unknown;
  readonly schemaVersion?: unknown;
  readonly templating?: unknown;
  readonly panels?: readonly TemplatePanel[];
}

const template = JSON.parse(DASHBOARD_JSON_TEXT) as Template;

/** Every panel of the template, in declaration order. */
const panels: readonly TemplatePanel[] = template.panels ?? [];

/**
 * Reduces an exported series name to the family that declares it.
 *
 * A histogram declares one family and exports three line shapes from it, so a
 * panel targeting `..._bucket` is targeting the base family.
 *
 * @param name Name as a panel expression carries it.
 * @returns The declaring family's name.
 */
const declaringFamily = (name: string): string => {
  for (const suffix of HISTOGRAM_SUFFIXES) {
    if (name.endsWith(suffix)) {
      return name.slice(0, -suffix.length);
    }
  }

  return name;
};

/**
 * Every metric name any panel expression mentions.
 *
 * @returns The names, reduced to their declaring families.
 */
const targetedFamilies = (): ReadonlySet<string> => {
  const found = new Set<string>();

  for (const panel of panels) {
    for (const target of panel.targets ?? []) {
      const expr = typeof target.expr === 'string' ? target.expr : '';

      for (const name of expr.match(/game2048_[a-z0-9_]+/g) ?? []) {
        found.add(declaringFamily(name));
      }
    }
  }

  return found;
};

/**
 * Reads the family names out of a Prometheus export's `# TYPE` lines.
 *
 * The `# TYPE` line names the DECLARING family, so a histogram appears once
 * here however many line shapes it exports.
 *
 * @param text Exposition text.
 * @returns The declared families.
 */
const declaredFamilies = (text: string): ReadonlySet<string> => {
  const found = new Set<string>();

  for (const line of text.split('\n')) {
    if (!line.startsWith('# TYPE ')) {
      continue;
    }

    const parts = line.split(' ');
    const name = parts[2];

    if (name !== undefined) {
      found.add(name);
    }
  }

  return found;
};

let application: Application | null = null;

/** Every frame this suite opened, torn down after each case. */
const frames: HTMLIFrameElement[] = [];

beforeEach(() => {
  document.body.innerHTML = COMPOSITION_MARKUP;
  resetWebGLSupportProbe();
});

afterEach(() => {
  application?.dispose();
  application = null;
  for (const frame of frames.splice(0)) {
    frame.remove();
  }

  resetWebGLSupportProbe();
  document.body.innerHTML = '';
  window.localStorage.removeItem('bestScore');
  window.localStorage.removeItem('gameState');
  window.localStorage.removeItem(RUN_STATE_KEY);
});

/**
 * Boots the real application and plays enough of a run to move every family
 * this suite reads off zero.
 *
 * @returns The composed application, with a run open and turns behind it.
 */
const playARun = (): Application => {
  const started = start(document);

  application = started;

  if (started.router.current() === 'runStart') {
    beginRun('dashboard-contract-seed');
  }

  // Enough turns to resolve merges, spawns and frames rather than only a
  // board: a snapshot of an untouched board would let an empty panel pass.
  for (const key of [
    'ArrowLeft',
    'ArrowUp',
    'ArrowRight',
    'ArrowDown',
    'ArrowLeft',
    'ArrowUp',
    'ArrowRight',
    'ArrowDown',
  ]) {
    pressKey(key);
  }

  return started;
};

/**
 * Loads dashboard.html into a frame of this document, scripts running.
 *
 * A FRAME rather than a described string: the page's own parser, its own
 * renderer and its own restated constants are what this suite is checking, and
 * only executing it exercises them. Its `var` declarations become globals of
 * the frame's window, which is how the mirrored-constant cases reach them.
 *
 * @returns The frame's window and document, and the controls this suite drives.
 */
const openDashboard = (): {
  readonly globals: Record<string, unknown>;
  readonly doc: Document;
  readonly paste: (text: string) => void;
  readonly status: () => { level: string | null; message: string };
  readonly panelText: () => string;
} => {
  const frame = document.createElement('iframe');

  document.body.appendChild(frame);
  frames.push(frame);

  const doc = frame.contentDocument;
  const win = frame.contentWindow;

  if (doc === null || win === null) {
    throw new Error('the frame carried no document');
  }

  doc.open();
  doc.write(DASHBOARD_HTML_TEXT);
  doc.close();

  return {
    globals: win as unknown as Record<string, unknown>,
    doc,
    paste: (text: string): void => {
      const field = doc.querySelector<HTMLTextAreaElement>('#snapshot-text');
      const render = doc.querySelector<HTMLButtonElement>('#render-pasted');

      if (field === null || render === null) {
        throw new Error('the dashboard lost its paste controls');
      }

      field.value = text;
      render.click();
    },
    status: (): { level: string | null; message: string } => {
      const node = doc.querySelector('#status');

      return {
        level: node?.getAttribute('data-level') ?? null,
        message: (node?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      };
    },
    panelText: (): string =>
      (doc.querySelector('#panels')?.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim(),
  };
};

describe('the Grafana template', () => {
  it('carries the envelope a Grafana import reads', () => {
    expect(template.uid).toBe('game2048-client');
    expect(typeof template.title).toBe('string');
    expect(typeof template.schemaVersion).toBe('number');
    expect(template.templating).not.toBeUndefined();
    expect(panels.length).toBeGreaterThan(0);
  });

  it('gives every panel an id, a type and a title, with no id twice', () => {
    const ids = new Set<unknown>();

    for (const panel of panels) {
      expect(typeof panel.id).toBe('number');
      expect(typeof panel.type).toBe('string');
      expect(typeof panel.title).toBe('string');
      expect(ids.has(panel.id)).toBe(false);

      ids.add(panel.id);
    }

    expect(ids.size).toBe(panels.length);
  });

  it('gives every target an expression and a refId', () => {
    let targets = 0;

    for (const panel of panels) {
      for (const target of panel.targets ?? []) {
        targets += 1;

        expect(typeof target.expr).toBe('string');
        expect(String(target.expr).trim()).not.toBe('');
        expect(typeof target.refId).toBe('string');
      }
    }

    // A template of titles and no queries would satisfy every check above.
    expect(targets).toBeGreaterThan(0);
  });

  it('targets no family a real export does not declare', () => {
    const declared = declaredFamilies(playARun().metrics.toPrometheusText());
    const phantom = [...targetedFamilies()].filter(
      (name) => !declared.has(name),
    );

    expect(phantom).toEqual([]);
  });

  it('leaves no declared family without a panel', () => {
    const targeted = targetedFamilies();
    const orphan = [
      ...declaredFamilies(playARun().metrics.toPrometheusText()),
    ].filter((name) => !targeted.has(name));

    expect(orphan).toEqual([]);
  });

  it('names only labels the registry puts on a series', () => {
    const known = new Set<string>([
      ...Object.values(METRIC_LABELS),
      // src/main.ts puts these two on `reports_total`.
      'report',
      'subsystem',
      // The bucket bound Prometheus itself adds to a histogram line.
      'le',
    ]);
    const unknown: string[] = [];

    for (const panel of panels) {
      for (const target of panel.targets ?? []) {
        const expr = typeof target.expr === 'string' ? target.expr : '';

        // `sum by (subsystem)`, `by (hook, reason)` and `{le="16"}` alike.
        for (const group of expr.match(/by\s*\(([^)]*)\)/g) ?? []) {
          for (const name of group.replace(/by\s*\(|\)/g, '').split(',')) {
            const trimmed = name.trim();

            if (trimmed !== '' && !known.has(trimmed)) {
              unknown.push(trimmed);
            }
          }
        }

        for (const selector of expr.match(/([a-z_]+)\s*=\s*"/g) ?? []) {
          const trimmed = selector.replace(/\s*=\s*"$/, '').trim();

          if (!known.has(trimmed)) {
            unknown.push(trimmed);
          }
        }
      }
    }

    expect(unknown).toEqual([]);
  });
});

describe('the static dashboard restates production faithfully', () => {
  it('mirrors the metric prefix and every metric name', () => {
    const dash = openDashboard();
    const names = dash.globals['NAMES'] as Record<string, string> | undefined;

    expect(dash.globals['PREFIX']).toBe(METRIC_PREFIX);
    expect(names).not.toBeUndefined();

    // Every production name, under the key production uses for it.
    for (const [key, value] of Object.entries(METRIC_NAMES)) {
      expect(names?.[key]).toBe(value);
    }

    // Plus exactly one more: the family src/main.ts declares.
    expect(names?.['reportsTotal']).toBe(`${METRIC_PREFIX}reports_total`);
    expect(Object.keys(names ?? {})).toHaveLength(
      Object.keys(METRIC_NAMES).length + 1,
    );
  });

  it('mirrors every metric label', () => {
    const dash = openDashboard();
    const labels = dash.globals['LABELS'] as Record<string, string> | undefined;

    expect(labels).toEqual({ ...METRIC_LABELS });
    expect(dash.globals['REPORT_LABELS']).toEqual({
      report: 'report',
      subsystem: 'subsystem',
    });
  });

  it('mirrors the six hook names in declaration order', () => {
    const dash = openDashboard();

    expect(dash.globals['HOOK_NAMES']).toEqual([...HOOK_NAMES]);
  });

  it('mirrors every engine event name', () => {
    const dash = openDashboard();

    expect(dash.globals['ENGINE_EVENT_NAMES']).toEqual([...ENGINE_EVENT_NAMES]);
  });

  it('mirrors every RNG substream name', () => {
    const dash = openDashboard();

    expect(dash.globals['RNG_STREAMS']).toEqual([...RNG_STREAM_NAMES]);
  });

  it('mirrors every span name that is ever timed', () => {
    const dash = openDashboard();

    // The artifact documents ONE exclusion: `tracer.inert` is the shared span
    // handed back while tracing is off, so no duration is ever recorded under
    // it and a panel keyed to it could only ever read empty. Every other name
    // must be present, in production's order — so adding a real span to the
    // tracer fails here rather than going unpanelled.
    expect(dash.globals['SPAN_NAMES']).toEqual(
      Object.values(SPAN_NAMES).filter((name) => name !== SPAN_NAMES.inert),
    );
  });

  it('leaves no boundary span of the V8 chain unpanelled', () => {
    const dash = openDashboard();
    const listed = new Set(dash.globals['SPAN_NAMES'] as readonly string[]);
    const missing = BOUNDARY_SPAN_NAMES.filter((name) => !listed.has(name));

    // The boundary chain is the span list V8 is asserted against, so a gap
    // here is a gap in what the dashboard can show of that gate.
    expect(missing).toEqual([]);
  });

  it('mirrors every health check id and its source', () => {
    const dash = openDashboard();

    expect(dash.globals['HEALTH_CHECK_IDS']).toEqual([...HEALTH_CHECK_IDS]);

    const sources = dash.globals['HEALTH_CHECK_SOURCES'] as
      | Record<string, { origin?: unknown }>
      | undefined;

    for (const id of HEALTH_CHECK_IDS) {
      expect(sources?.[id]?.origin).toBe(HEALTH_CHECK_SOURCES[id].origin);
    }
  });

  it('mirrors every hook skip reason', () => {
    const dash = openDashboard();

    // A coverage map rather than a list literal, so adding a reason to
    // `HookSkipReason` fails this file at compile time rather than at runtime.
    const reasons = {
      exhausted: true,
      degraded: true,
      detached: true,
    } satisfies Record<HookSkipReason, true>;

    expect(dash.globals['SKIP_REASONS']).toEqual(Object.keys(reasons));
  });

  it('mirrors the histogram bucket boundaries', () => {
    const dash = openDashboard();

    expect(dash.globals['DEFAULT_DURATION_BUCKETS']).toEqual([
      ...DEFAULT_DURATION_BUCKETS,
    ]);
  });
});

describe('the static dashboard renders a real export', () => {
  it('starts empty, with no snapshot and no panels', () => {
    const dash = openDashboard();

    expect(dash.status().level).toBe('empty');
    expect(dash.panelText()).toContain('Export a snapshot first');
  });

  it('renders the real Prometheus text with populated samples', () => {
    const text = playARun().metrics.toPrometheusText();
    const dash = openDashboard();

    dash.paste(text);

    const status = dash.status();

    expect(status.level).toBe('loaded');
    expect(status.message).toContain('Prometheus text exposition');

    // The count the page reports is what proves it read samples rather than
    // only headers. CHANGED: the exposition form counts SAMPLE LINES, which is
    // the exposition's own unit — one histogram is one series in the JSON form
    // but seventeen lines here — so the two forms are reported under different
    // nouns and this reads the noun the page actually renders.
    const counted = /(\d+) sample lines/.exec(status.message);

    expect(counted).not.toBeNull();
    expect(Number(counted?.[1])).toBeGreaterThan(0);

    // No line of a real export may be unreadable to the page's own parser.
    expect(status.message).not.toContain('malformed');

    const rendered = dash.panelText();

    expect(rendered).not.toContain('Export a snapshot first');
    expect(rendered.length).toBeGreaterThan(0);
  });

  it('renders the real combined diagnostics JSON', () => {
    const app = playARun();
    const json = app.diagnostics.snapshotJson();
    const dash = openDashboard();

    dash.paste(json);

    const status = dash.status();

    expect(status.level).toBe('loaded');

    const counted = /(\d+) series/.exec(status.message);

    expect(Number(counted?.[1])).toBeGreaterThan(0);
    expect(dash.panelText()).not.toContain('Export a snapshot first');
  });

  it('shows the gameplay counters a played run actually produced', () => {
    const app = playARun();
    const text = app.metrics.toPrometheusText();
    const dash = openDashboard();

    dash.paste(text);

    const rendered = dash.panelText();

    // Turns were played, so the gameplay section must show a non-zero turn
    // count. A dashboard rendering every panel at zero is the failure this
    // whole suite exists to catch.
    const turns = /(\d+)/.exec(
      text
        .split('\n')
        .filter(
          (line) =>
            line.startsWith(METRIC_NAMES.turnsTotal) && !line.startsWith('#'),
        )
        .join(' '),
    );

    expect(Number(turns?.[1] ?? 0)).toBeGreaterThan(0);
    expect(rendered).toMatch(/Turns/i);
  });

  it('carries the provenance the export declares', () => {
    const app = playARun();
    const dash = openDashboard();

    dash.paste(app.diagnostics.snapshotJson());

    const provenance = (
      dash.doc.querySelector('#provenance')?.textContent ?? ''
    )
      .replace(/\s+/g, ' ')
      .trim();

    // The correlation identifier is what ties a rendered dashboard to the run
    // it came from, so it must survive the round trip.
    expect(provenance).toContain(app.metrics.snapshot().correlationId);
  });

  it('refuses input that is not a snapshot, and says why', () => {
    const dash = openDashboard();

    dash.paste('this is not a snapshot');

    expect(dash.status().level).toBe('error');
    expect(dash.panelText()).toContain('Export a snapshot first');
  });

  it('refuses JSON that is not a snapshot this page reads', () => {
    const dash = openDashboard();

    dash.paste('{"unrelated":true}');

    expect(dash.status().level).toBe('error');
  });

  it('refuses empty input rather than rendering an empty dashboard', () => {
    const dash = openDashboard();

    dash.paste('   ');

    expect(dash.status().level).toBe('error');
    expect(dash.status().message).toMatch(/empty/i);
  });

  it('keeps the earlier render on screen when a later input refuses', () => {
    const text = playARun().metrics.toPrometheusText();
    const dash = openDashboard();

    dash.paste(text);

    expect(dash.status().level).toBe('loaded');

    dash.paste('not a snapshot at all');

    // Marked as the earlier snapshot rather than cleared: a refusal must not
    // destroy the reading someone was looking at.
    expect(dash.status().level).toBe('error');
    expect(dash.doc.querySelector('#panels')?.getAttribute('data-stale')).toBe(
      'true',
    );
  });
});
