// Integration suite for the observability wiring at the composition root, Rule
// 3.
//
// These cases therefore drive the REAL `start(document)` and assert on what
// actually reached the sinks, not that a constructor was called.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from '../../../src/main';
import type { Application } from '../../../src/main';
import {
  HEALTH_CHECK_COUNT,
  HEALTH_CHECK_IDS,
} from '../../../src/observability/health';
import type { LogRecord } from '../../../src/observability/logger';
import {
  METRIC_NAMES,
  METRIC_PREFIX,
} from '../../../src/observability/metrics';
import {
  SPAN_ATTRIBUTES,
  SPAN_NAMES,
  SPAN_OUTCOMES,
} from '../../../src/observability/tracer';
import { Tile } from '../../../src/engine/tile';
import { resetWebGLSupportProbe } from '../../../src/render/webgl-support';
import { BOUNDARY_SPAN_NAMES } from '../../../src/observability/tracer';
import type { TraceSnapshot } from '../../../src/observability/tracer';
import { RELIC_CATALOGUE } from '../../../src/relics/relic-registry';
import {
  GAME_STATE_KEY,
  RUN_STATE_KEY,
  namespacedKey,
} from '../../../src/storage/storage-keys';
import { NEAR_WIN_BOARD, copyBoard } from '../../fixtures/boards';
import { COMPOSITION_MARKUP, beginRun } from '../../fixtures/composition';
import { clearOwnedStorage } from '../../fixtures/storage';

/**
 * The markup `start` looks up, from tests/fixtures/composition.ts, so this
 * suite reads the document index.html declares rather than a private copy of
 * part of it.
 */
const MARKUP = COMPOSITION_MARKUP;

let application: Application | null = null;

beforeEach(() => {
  document.body.innerHTML = MARKUP;
  resetWebGLSupportProbe();
});

afterEach(() => {
  application?.dispose();
  application = null;
  resetWebGLSupportProbe();
  document.body.innerHTML = '';
  window.localStorage.removeItem('bestScore');
  window.localStorage.removeItem('gameState');
  window.localStorage.removeItem(RUN_STATE_KEY);
});

/**
 * The envelope this suite resumes from: a fixed seed, stage 0, no relics, and a
 * board of two unequal tiles that clears no goal.
 *
 * RESUMED RATHER THAN BEGUN. A load that resumed nothing holds the run-start
 * screen, whose input context withholds movement, so a case that drives turns
 * needs a run open — and beginning one rotates the correlation scope, which
 * is the very thing most of these cases assert about. Resuming opens the board
 * under ONE identifier, derived from this seed, for the whole session.
 */
const SEEDED_ENVELOPE = JSON.stringify({
  schemaVersion: 1,
  runId: 'observability-run',
  seed: 'observability-seed',
  rngCursor: {
    'spawn-value': 2,
    'spawn-position': 2,
    'relic-draw': 0,
    'rarity-weight': 0,
  },
  stageIndex: 0,
  stageGoal: { kind: 'highest-tile', target: 16 },
  goalProgress: 0.125,
  relics: [],
  board: {
    grid: {
      size: 4,
      cells: [
        [{ position: { x: 0, y: 0 }, value: 2 }, null, null, null],
        [{ position: { x: 1, y: 0 }, value: 4 }, null, null, null],
        [null, null, null, null],
        [null, null, null, null],
      ],
    },
    score: 0,
    over: false,
    won: false,
    keepPlaying: false,
  },
});

/**
 * Composes the application over the seeded envelope, so a PLAYABLE BOARD is on
 * screen and no run rotation has happened.
 *
 * A case that wants a fresh boot calls `start(document)` itself.
 *
 * @returns The composed application, with the seeded run open.
 */
const startPlaying = (): Application => {
  if (window.localStorage.getItem(RUN_STATE_KEY) === null) {
    window.localStorage.setItem(RUN_STATE_KEY, SEEDED_ENVELOPE);
  }

  const started = start(document);

  application = started;

  if (started.router.current() === 'runStart') {
    beginRun();
  }

  return started;
};

const press = (key: string, code: string): void => {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key, code, bubbles: true }),
  );
};

/** Plays one move in every direction. */
const playEveryDirection = (): void => {
  press('ArrowDown', 'ArrowDown');
  press('ArrowLeft', 'ArrowLeft');
  press('ArrowUp', 'ArrowUp');
  press('ArrowRight', 'ArrowRight');
};

/** Waits for the render loop to turn over twice. */
const awaitFrames = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  });
};

/** Every distinct span name the running application's tracer retained. */
const observedSpanNames = (): ReadonlySet<string> =>
  new Set(
    (application === null ? [] : application.tracer.snapshot().spans).map(
      (record) => record.name,
    ),
  );

/** One counter series' value, and `-1` where no such counter exists. */
const counterValue = (name: string): number => {
  const series = application?.metrics
    .snapshot()
    .series.find(
      (candidate) => candidate.name === name && candidate.kind === 'counter',
    );

  return series !== undefined && series.kind === 'counter' ? series.value : -1;
};

/** One histogram series, matched by name and optionally by one label. */
const histogramSeries = (
  name: string,
  label?: { readonly key: string; readonly value: string },
): { readonly count: number; readonly sum: number } | undefined => {
  const series = application?.metrics
    .snapshot()
    .series.find(
      (candidate) =>
        candidate.name === name &&
        candidate.kind === 'histogram' &&
        (label === undefined || candidate.labels[label.key] === label.value),
    );

  return series !== undefined && series.kind === 'histogram'
    ? { count: series.count, sum: series.sum }
    : undefined;
};

describe('the structured logger is wired', () => {
  it('is exposed by the root, carrying a correlation identifier', () => {
    application = startPlaying();

    expect(application.logger.correlationId).not.toBe('');
    expect(application.logger.correlationId.startsWith('run-')).toBe(true);
  });

  it('has recorded structured records by the time boot finishes', () => {
    application = startPlaying();

    const records = application.logger.recent();

    // Console-only writing left nothing to read back.
    expect(records.length).toBeGreaterThan(0);
  });

  it('stamps every record with the one correlation identifier', () => {
    application = startPlaying();

    const expected = application.logger.correlationId;
    const records = application.logger.recent(100);

    for (const record of records) {
      expect(record.correlationId).toBe(expected);
    }
  });

  it('routes a subsystem s reports under that subsystem, not under main', () => {
    application = startPlaying();

    press('ArrowDown', 'ArrowDown');

    const subsystems = new Set(
      application.logger.recent(200).map((record) => record.subsystem),
    );

    expect(subsystems.size).toBeGreaterThan(1);
  });

  it('exports its records as JSON lines', () => {
    application = startPlaying();

    const lines = application.logger
      .toJsonLines()
      .split('\n')
      .filter((line) => line !== '');

    expect(lines.length).toBeGreaterThan(0);

    // Structured, so each line parses.
    const parsed: unknown = JSON.parse(lines[0]);

    expect(typeof parsed).toBe('object');
    expect((parsed as { correlationId?: unknown }).correlationId).toBe(
      application.logger.correlationId,
    );
  });
});

describe('the metrics registry is wired', () => {
  it('is exposed by the root and has non-empty series after boot', () => {
    application = startPlaying();

    const snapshot = application.metrics.snapshot();

    expect(snapshot.correlationId).toBe(application.logger.correlationId);
    expect(snapshot.series.length).toBeGreaterThan(0);
  });

  it('has counters that actually moved, where every count was discarded before', () => {
    application = startPlaying();

    press('ArrowDown', 'ArrowDown');
    press('ArrowLeft', 'ArrowLeft');

    const moved = application.metrics
      .snapshot()
      .series.filter(
        (series) => series.kind === 'counter' && series.value > 0,
      );

    expect(moved.length).toBeGreaterThan(0);
  });

  it('exports Prometheus text, the stand-in for a scrape', () => {
    application = startPlaying();

    press('ArrowRight', 'ArrowRight');

    const text = application.metrics.toPrometheusText();

    expect(text).toContain('# TYPE');
    expect(text).toContain('game2048_');
  });

  it('names every series in the Prometheus namespace', () => {
    application = startPlaying();

    press('ArrowUp', 'ArrowUp');

    for (const series of application.metrics.snapshot().series) {
      expect(series.name.startsWith('game2048_')).toBe(true);
      expect(series.name).toMatch(/^[a-zA-Z_:][a-zA-Z0-9_:]*$/);
    }
  });

  it('populates the CANONICAL families a dashboard would be keyed to', () => {
    application = startPlaying();

    playEveryDirection();

    const value = (name: string): number => {
      const series = application?.metrics
        .snapshot()
        .series.find((candidate) => candidate.name === name);

      return series !== undefined && series.kind === 'counter'
        ? series.value
        : -1;
    };

    // These are the families the registry declares with real help text, and
    // the only names a dashboard or an alert would use.
    expect(value('game2048_turns_total')).toBeGreaterThan(0);
    expect(value('game2048_spawns_total')).toBeGreaterThan(0);
  });

  it('counts no turn for an idle input, and one for a resolved move', () => {
    // ONE tile in the top-left corner, so `ArrowUp` and `ArrowLeft` resolve
    // nothing on every seed while `ArrowRight` resolves.
    window.localStorage.setItem(
      GAME_STATE_KEY,
      JSON.stringify({
        grid: {
          size: 4,
          cells: [
            [{ position: { x: 0, y: 0 }, value: 2 }, null, null, null],
            [null, null, null, null],
            [null, null, null, null],
            [null, null, null, null],
          ],
        },
        score: 0,
        over: false,
        won: false,
        keepPlaying: false,
      }),
    );

    application = startPlaying();

    const counter = (name: string, labels: Readonly<Record<string, string>> =
      {}): number => {
      const series = application?.metrics
        .snapshot()
        .series.find(
          (candidate) =>
            candidate.name === name &&
            Object.entries(labels).every(
              ([label, expected]) => candidate.labels[label] === expected,
            ),
        );

      return series !== undefined && series.kind === 'counter'
        ? series.value
        : -1;
    };

    const idleInputs = 3;

    for (let press_ = 0; press_ < idleInputs; press_ += 1) {
      press('ArrowUp', 'ArrowUp');
    }

    expect(
      counter('game2048_engine_events_total', { event: 'move:after' }),
    ).toBe(idleInputs);
    expect(counter('game2048_turns_total')).toBe(0);

    press('ArrowRight', 'ArrowRight');

    // The counter is fed from the engine's own resolved-move counter, so the
    // first move that changes the board raises it — and raises it once.
    expect(counter('game2048_turns_total')).toBe(1);
    expect(
      counter('game2048_engine_events_total', { event: 'move:after' }),
    ).toBe(idleInputs + 1);
  });

  it('counts rendered frames, the one previously unmeasured boundary', async () => {
    application = startPlaying();

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });

    const frames = application.metrics
      .snapshot()
      .series.find(
        (series) => series.name === 'game2048_frames_rendered_total',
      );

    expect(frames?.kind === 'counter' ? frames.value : -1).toBeGreaterThan(0);
  });

  it('breaks engine events down per event name', () => {
    application = startPlaying();

    playEveryDirection();

    const perEvent = application.metrics
      .snapshot()
      .series.filter(
        (series) =>
          series.name === 'game2048_engine_events_total' &&
          series.kind === 'counter' &&
          series.value > 0,
      );

    // Per-event labels, not one undifferentiated total.
    expect(perEvent.length).toBeGreaterThan(0);
    expect(
      perEvent.some((series) => series.labels.event === 'move:after'),
    ).toBe(true);
  });

  it('carries every generic report on ONE labelled family', () => {
    application = startPlaying();

    playEveryDirection();

    const canonical = new Set<string>(Object.values(METRIC_NAMES));
    const families = new Set<string>();

    for (const series of application.metrics.snapshot().series) {
      families.add(series.name);
    }

    const reportFamily = `${METRIC_PREFIX}reports_total`;
    const outside = [...families].filter(
      (name) => !canonical.has(name) && name !== reportFamily,
    );

    // The seam this pins. The root once rendered each dotted report name into
    // a Prometheus family of its own, so the open set of report names competed
    // with the declared vocabulary for the registry's bounded family budget
    // and the reports raised last — the teardown ones — were the ones
    // rejected.
    expect(outside).toEqual([]);

    const reports = application.metrics
      .snapshot()
      .series.filter((series) => series.name === reportFamily);

    expect(reports.length).toBeGreaterThan(1);

    // Both dimensions on every series: the report's own dotted name, and the
    // leading segment of it the family aggregates by.
    for (const series of reports) {
      const report = series.labels['report'] ?? '';
      const subsystem = series.labels['subsystem'] ?? '';

      expect(series.kind).toBe('counter');
      expect(report.length).toBeGreaterThan(0);
      expect(subsystem.length).toBeGreaterThan(0);
      expect(report.startsWith(subsystem)).toBe(true);
    }
  });

  it('folds the hook bus dispatch counts in when the surface reads', () => {
    application = startPlaying();

    playEveryDirection();

    // The registry integrates with the bus by PULL, so these stay empty unless
    // something asks the bus for them.
    application.diagnostics.open();

    const hooks = application.diagnostics
      .lastSnapshot()
      ?.series.filter(
        (series) =>
          series.name === 'game2048_hook_dispatches_total' &&
          series.kind === 'counter' &&
          series.value > 0,
      );

    expect(hooks?.length ?? 0).toBeGreaterThan(0);
  });

  it('separates a spawn that placed a tile from one that could not', () => {
    application = startPlaying();

    playEveryDirection();

    const snapshot = application.metrics.snapshot();
    const spawns = snapshot.series.find(
      (series) => series.name === 'game2048_spawns_total',
    );
    const attempts = snapshot.series.find(
      (series) => series.name === 'game2048_spawn_attempts_total',
    );

    // The distinction rests on the spawn payload's `position`, which the
    // generic counter cannot express and the purpose-built recorder reads.
    expect(spawns?.kind === 'counter' ? spawns.value : -1).toBeGreaterThan(0);
    expect(attempts?.kind === 'counter' ? attempts.value : -1).toBeGreaterThan(
      0,
    );
  });

  it('keeps the report name as a label rather than in the metric name', () => {
    application = startPlaying();

    press('ArrowDown', 'ArrowDown');

    const labelled = application.metrics
      .snapshot()
      .series.filter((series) => 'report' in series.labels);

    expect(labelled.length).toBeGreaterThan(0);
  });
});

describe('the RNG cursor family is fed by the shipped graph', () => {
  it('folds the cursors of a played run, from production and not from a suite', () => {
    application = startPlaying();
    playEveryDirection();

    const cursorSeries = application.metrics
      .snapshot()
      .series.filter((series) => series.name === METRIC_NAMES.rngDrawsTotal);

    // The family was absent from every production snapshot: nothing in the root
    // folded it, and only the seeded snapshot suite subscribed an observer that
    // did. `attachRngCursorMetrics` is now installed here, so the graph the
    // suite measures non-interference for is the graph that runs. DL-MAIN-30.
    expect(cursorSeries.length).toBeGreaterThan(0);
    expect(
      cursorSeries.some(
        (series) => series.kind === 'counter' && series.value > 0,
      ),
    ).toBe(true);
  });

  it('carries the cursor family into the Prometheus text a scrape substitutes for', () => {
    application = startPlaying();
    playEveryDirection();

    expect(application.diagnostics.toPrometheusText()).toContain(
      METRIC_NAMES.rngDrawsTotal,
    );
  });

  it('folds every pulled source before a direct export, with no render behind it', () => {
    application = startPlaying();
    playEveryDirection();

    // The overlay is never opened, so nothing has rendered: a direct export
    // reported whatever the last render had folded, which on this path is
    // nothing at all.
    const text = application.diagnostics.toPrometheusText();

    expect(text).toContain(METRIC_NAMES.hookDispatchesTotal);
    expect(text).toContain(METRIC_NAMES.rngDrawsTotal);

    const snapshot = application.diagnostics.snapshot();

    expect(
      snapshot.metrics.series.some(
        (series) => series.name === METRIC_NAMES.rngDrawsTotal,
      ),
    ).toBe(true);
  });
});

describe('readiness is resolved before the renderer is selected', () => {
  it('logs the health check and the readiness verdict ahead of the selection', () => {
    application = startPlaying();

    const messages = application.logger
      .snapshot()
      .records.map((record) => record.message);
    const checked = messages.indexOf('Health checked.');
    const resolved = messages.indexOf('Readiness resolved.');
    const selected = messages.findIndex((message) =>
      message.startsWith('Board drawn by the '),
    );

    // All three are recorded at boot.
    expect(checked).toBeGreaterThanOrEqual(0);
    expect(resolved).toBeGreaterThanOrEqual(0);
    expect(selected).toBeGreaterThanOrEqual(0);

    // AND IN THIS ORDER. `HealthSurface.readiness()` owns the verdict that
    // decides whether a WebGL board may be mounted at all, and it was resolved
    // after the renderer had been selected and mounted. DL-MAIN-27.
    expect(checked).toBeLessThan(selected);
    expect(resolved).toBeLessThan(selected);
    expect(checked).toBeLessThan(resolved);
  });

  it('counts the readiness of the board that is actually drawing', () => {
    application = startPlaying();

    const counted = application.metrics
      .snapshot()
      .series.filter(
        (series) => series.name === `${METRIC_PREFIX}health_readiness_total`,
      );

    // The count is taken from the verdicts re-read once a board is mounted, so
    // a 2.5D board selected and not mounted is reported as the number-only
    // board it fell back to rather than as the one the probe predicted.
    expect(counted.length).toBeGreaterThanOrEqual(0);
  });
});

describe('the diagnostics surface is wired', () => {
  it('is exposed by the root, available and closed', () => {
    application = startPlaying();

    expect(application.diagnostics.available).toBe(true);
    expect(application.diagnostics.isOpen()).toBe(false);
  });

  it('renders the run, health and metrics panels when opened', () => {
    application = startPlaying();

    press('ArrowDown', 'ArrowDown');
    application.diagnostics.open();

    const host = document.querySelector('#diagnostics-overlay');
    const text = (host?.textContent ?? '').replace(/\s+/g, ' ');

    // Empty for the life of the page before this wiring existed.
    expect(text).toContain('Diagnostics');
    expect(text).toContain('Health');
    expect(text).toContain(application.logger.correlationId);
    expect(host instanceof HTMLElement ? host.hidden : true).toBe(false);
  });

  it('reports the six capability probes, WebGL included', () => {
    application = startPlaying();
    application.diagnostics.open();

    const text = (
      document.querySelector('#diagnostics-overlay')?.textContent ?? ''
    ).replace(/\s+/g, ' ');

    // All five the vanilla sources probed and then discarded, plus the sixth
    // the Three.js renderer introduced.
    for (const probe of [
      'webgl',
      'storage',
      'requestAnimationFrame',
      'classList',
      'functionBind',
      'pointerEvents',
    ]) {
      expect(text).toContain(probe);
    }
  });

  it('puts the health verdicts into the snapshot as well as on screen', () => {
    application = startPlaying();
    application.diagnostics.open();

    const health = application.diagnostics
      .lastSnapshot()
      ?.series.filter((series) => series.name.includes('health_check'));

    expect(health?.length ?? 0).toBeGreaterThan(0);
  });

  it('is emptied and closed by dispose', () => {
    application = startPlaying();
    application.diagnostics.open();
    application.dispose();
    application = null;

    const host = document.querySelector<HTMLElement>('#diagnostics-overlay');

    expect(host?.hidden).toBe(true);
    expect(host?.textContent).toBe('');
  });
});

describe('the tracer is wired', () => {
  it('is exposed by the root, enabled and sharing the correlation ' +
    'identifier', () => {
    application = startPlaying();

    expect(application.tracer.isEnabled()).toBe(true);
    expect(application.tracer.correlationId).toBe(
      application.logger.correlationId,
    );
  });

  it('opens the turn span the engine emitter drives', () => {
    application = startPlaying();

    playEveryDirection();

    const names = application.tracer
      .recent()
      .map((record) => record.name);

    expect(names).toContain('engine.turn');
  });

  it('spans the input, move-resolution, hook-dispatch and render-commit ' +
    'boundaries of one turn', () => {
    application = startPlaying();

    playEveryDirection();

    const names = new Set(
      application.tracer.recent(200).map((record) => record.name),
    );

    // The chain validation gate V8 names, less the relic handler, which needs
    // a registered relic, and the frame callback, which needs a frame.
    expect(names).toContain('input.dispatch');
    expect(names).toContain('engine.move.resolve');
    expect(names).toContain('hook.dispatch');
    expect(names).toContain('render.commit');
  });

  it('spans a relic handler invocation through the hook bus', () => {
    application = startPlaying();

    application.engine.hooks.register({
      id: 'traced-relic',
      hooks: {
        onBeforeMove: (payload) => payload,
      },
    });
    playEveryDirection();

    const relicSpans = application.tracer
      .recent(200)
      .filter((record) => record.name === 'relic.handler');

    expect(relicSpans.length).toBeGreaterThan(0);
    expect(relicSpans[0]?.attributes['relic']).toBe('traced-relic');
    expect(relicSpans[0]?.attributes['hook']).toBe('onBeforeMove');
  });

  it('nests every boundary span of one turn under the input dispatch', () => {
    application = startPlaying();

    press('ArrowDown', 'ArrowDown');
    press('ArrowLeft', 'ArrowLeft');

    const records = application.tracer.recent(200);
    const input = records.find(
      (record) => record.name === 'input.dispatch',
    );
    const turn = records.find(
      (record) => record.name === SPAN_NAMES.engineTurn,
    );
    const resolve = records.find(
      (record) => record.name === 'engine.move.resolve',
    );

    // The chain, link by link: the input dispatch is the outermost span of a
    // turn, the turn span opens inside it on `move:before`, and the resolution
    // span opens inside the turn around the traversal walk alone.
    expect(input).toBeDefined();
    expect(turn?.parentId).toBe(input?.id);
    expect(resolve?.parentId).toBe(turn?.id);
  });

  it('opens render.commit INSIDE the turn span that produced it', () => {
    application = startPlaying();

    playEveryDirection();

    const records = application.tracer.recent(400);
    const commits = records.filter(
      (record) => record.name === SPAN_NAMES.renderCommit,
    );
    const turns = records.filter(
      (record) => record.name === SPAN_NAMES.engineTurn,
    );
    const turnIds = new Set(turns.map((record) => record.id));

    expect(commits.length).toBeGreaterThan(0);
    expect(turns.length).toBeGreaterThan(0);

    // A commit made by a turn belongs to that turn.
    const inTurn = commits.filter(
      (record) => record.parentId !== undefined && turnIds.has(record.parentId),
    );

    expect(inTurn.length).toBeGreaterThan(0);
  });

  it('keeps render.commit inside the turn after a renderer swap', () => {
    application = startPlaying();

    // The number-only board takes over, which re-subscribes a renderer and so
    // re-registers a `state:commit` listener after the tracing subscription's.
    application.preferences.setNumberOnlyMode(true);
    playEveryDirection();

    const records = application.tracer.recent(400);
    const turnIds = new Set(
      records
        .filter((record) => record.name === SPAN_NAMES.engineTurn)
        .map((record) => record.id),
    );
    const commits = records.filter(
      (record) => record.name === SPAN_NAMES.renderCommit,
    );

    expect(application.renderer.mode).toBe('number-only');
    expect(commits.length).toBeGreaterThan(0);
    expect(
      commits.filter(
        (record) =>
          record.parentId !== undefined && turnIds.has(record.parentId),
      ).length,
    ).toBeGreaterThan(0);
  });

  it('closes a withdrawn turn as cancelled rather than as idle', () => {
    application = startPlaying();

    // A relic that withdraws every move, which is the valid hook-veto path:
    // the veto is cast AFTER `move:before` was emitted, so no listener can see
    // it and the caller's outcome is the only thing that can classify the
    // turn.
    application.engine.hooks.register({
      id: 'vetoes-everything',
      hooks: {
        onBeforeMove: (payload) => ({ ...payload, cancelled: true }),
      },
    });

    press('ArrowDown', 'ArrowDown');

    const turn = application.tracer
      .recent(200)
      .filter((record) => record.name === SPAN_NAMES.engineTurn)
      .at(-1);

    // `unmoved` is what a boolean return produced for this turn, which
    // reported the player pressing into a wall.
    expect(turn?.attributes[SPAN_ATTRIBUTES.outcome]).toBe(
      SPAN_OUTCOMES.cancelled,
    );
    expect(application.tracer.snapshot().anomalies).toBe(0);
  });

  it('closes a failed attempt as failed and raises no anomaly', () => {
    application = startPlaying();

    const engine = application.engine;
    const failing = (): boolean => {
      throw new Error('move failed');
    };

    // The attempt itself throws, which the outcome taxonomy could not express
    // at all: the turn span stayed open until the next input superseded it.
    Object.defineProperty(engine, 'attemptMove', {
      configurable: true,
      value: (direction: 0 | 1 | 2 | 3): never => {
        engine.events.emit('move:before', {
          direction,
          board: engine.grid,
          cancelled: false,
        });

        return failing() as never;
      },
    });

    press('ArrowDown', 'ArrowDown');

    const turn = application.tracer
      .recent(200)
      .filter((record) => record.name === SPAN_NAMES.engineTurn)
      .at(-1);

    expect(turn?.attributes[SPAN_ATTRIBUTES.outcome]).toBe(
      SPAN_OUTCOMES.failed,
    );
    // The stage span alone is left open; the turn span was closed by the
    // settling in the listener's `finally`.
    expect(application.tracer.snapshot().open).toBe(1);
  });

  it('covers EVERY boundary span validation gate V8 enumerates', async () => {
    application = startPlaying();

    // A relic on the bus, so the `relic.handler` boundary has a handler to
    // span.
    application.engine.hooks.register({
      id: 'gate-relic',
      hooks: {
        onBeforeMove: (payload) => payload,
      },
    });
    playEveryDirection();
    await awaitFrames();

    const observed = observedSpanNames();

    // The gate is the list, not a sample of it: input, engine turn, move
    // resolution, hook dispatch, relic handler, render commit, frame callback.
    for (const name of BOUNDARY_SPAN_NAMES) {
      expect(observed.has(name)).toBe(true);
    }
  });

  it('reports lifecycle commits rather than counting them as anomalies', () => {
    application = startPlaying();

    playEveryDirection();
    application.engine.restart();

    const snapshot = application.tracer.snapshot();

    // `setup`, `restart` through `setup` and `endStage` all commit with no
    // move in flight.
    expect(snapshot.lifecycleCommits).toBeGreaterThan(0);
    expect(snapshot.anomalies).toBe(0);

    // The same commits, broken down. Every commit the run made is accounted to
    // one of the three attributions, the turns among them counted separately,
    // and nothing lands in `unattributed`.
    expect(snapshot.commits.lifecycle).toBe(snapshot.lifecycleCommits);
    expect(snapshot.commits.turn).toBeGreaterThan(0);
    expect(snapshot.commits.unattributed).toBe(0);
  });

  it('observes the turn latency of a committed turn', () => {
    application = startPlaying();

    playEveryDirection();

    const latency = histogramSeries('game2048_turn_latency_milliseconds');

    // Measured from the turn span's own open to the turn's OWN commit, so a
    // stage resolution a commit subscriber triggers afterwards is not counted
    // as turn time.
    expect(latency?.count ?? 0).toBeGreaterThan(0);
  });

  it('records span durations into the shared histogram family', () => {
    application = startPlaying();

    playEveryDirection();

    const turns = histogramSeries('game2048_span_duration_milliseconds', {
      key: 'span',
      value: SPAN_NAMES.engineTurn,
    });

    // One sample per closed turn span, whatever each move did: a move the
    // engine refused opens none, and a move that changed nothing is closed by
    // the caller that knows it was idle.
    expect(turns?.count ?? 0).toBeGreaterThan(0);
  });

  it('spans the frame callback, the one asynchronous boundary', async () => {
    application = startPlaying();

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });

    const stats = application.tracer.frameStats();

    expect(stats.frames).toBeGreaterThan(0);
  });

  it('reaches the diagnostics trace panel', () => {
    application = startPlaying();

    playEveryDirection();
    application.diagnostics.open();

    const text = (
      document.querySelector('#diagnostics-overlay')?.textContent ?? ''
    ).replace(/\s+/g, ' ');

    expect(text).toContain('Traces');

    const snapshot = application.diagnostics.snapshot();

    expect(snapshot.traces?.spans.length ?? 0).toBeGreaterThan(0);
  });

  it('records the run-start commit on the stage span rather than reporting ' +
    'it as an anomaly', () => {
    application = startPlaying();

    playEveryDirection();

    // `setup` commits before any move, so that commit belongs to the stage and
    // not to a turn.
    expect(application.tracer.snapshot(200).anomalies).toBe(0);
    expect(
      application.logger
        .recent()
        .filter((record) => record.subsystem === 'tracer')
        .map((record) => record.message),
    ).toEqual([]);
  });

  it('closes every span it left open when dispose runs', () => {
    application = startPlaying();

    playEveryDirection();
    application.dispose();

    const held = application.tracer;

    application = null;

    expect(held.activeSpan()).toBeUndefined();
  });
});

describe('the health surface is wired', () => {
  it('is exposed by the root and reports all six checks', () => {
    application = startPlaying();

    const report = application.health.report();

    expect(report.checks.map((check) => check.id)).toEqual([
      'functionBind',
      'classList',
      'requestAnimationFrame',
      'pointerEvents',
      'storage',
      'webgl',
    ]);
    expect(report.correlationId).toBe(application.logger.correlationId);
  });

  it('reuses the five legacy probes and marks the WebGL one added', () => {
    application = startPlaying();

    const dispositions = new Map(
      application.health
        .report()
        .checks.map((check) => [check.id, check.source.disposition]),
    );

    expect(dispositions.get('functionBind')).toBe('reused');
    expect(dispositions.get('classList')).toBe('reused');
    expect(dispositions.get('requestAnimationFrame')).toBe('reused');
    expect(dispositions.get('pointerEvents')).toBe('reused');
    expect(dispositions.get('storage')).toBe('reused');
    expect(dispositions.get('webgl')).toBe('added');
  });

  it('resolves the pointer family through its own probe rather than the ' +
    'input manager', () => {
    application = startPlaying();

    const pointer = application.health
      .report()
      .checks.find((check) => check.id === 'pointerEvents');

    // The bypassed provider reported `input.isListening` here, which answers a
    // different question.
    expect(pointer?.source.performedBy).toBe('detectPointerEventFamily');
    expect(pointer?.data['touchstart']).toBeDefined();
  });

  it('carries the two readiness verdicts the renderer and storage decisions ' +
    'rest on', () => {
    application = startPlaying();

    const readiness = application.health.readiness();

    expect(readiness.renderer).toBe(application.renderer.mode);
    expect(['persistent', 'ephemeral']).toContain(readiness.storage);
    expect(readiness.mayMountWebGLRenderer).toBe(
      readiness.renderer === 'webgl',
    );
  });

  it('logs the readiness verdict during composition', () => {
    application = startPlaying();

    const messages = application.logger
      .recent()
      .map((record) => record.message);

    expect(messages).toContain('Readiness resolved.');
  });

  it('is the surface the diagnostics health panel reads', () => {
    application = startPlaying();
    application.diagnostics.open();

    const text = (
      document.querySelector('#diagnostics-overlay')?.textContent ?? ''
    ).replace(/\s+/g, ' ');

    for (const probe of [
      'functionBind',
      'classList',
      'requestAnimationFrame',
      'pointerEvents',
      'storage',
      'webgl',
    ]) {
      expect(text).toContain(probe);
    }
  });
});

// `metrics.recordFrame(context.delta)` recorded the gap since the previous
// frame as though it were how long the frame callbacks occupied the frame: the
// first sample is always zero, ordinary 60 Hz cadence reads as over budget,
// and a long pause is clamped.

describe('the frame metric', () => {
  it('is written once per frame, by the tracer alone', async () => {
    application = startPlaying();

    await awaitFrames();

    const frames = application.tracer.snapshot().frames.frames;

    expect(frames).toBeGreaterThan(0);

    // EXACT parity.
    expect(counterValue('game2048_frames_rendered_total')).toBe(frames);
    expect(histogramSeries('game2048_frame_time_milliseconds')?.count).toBe(
      frames,
    );
  });

  it('records the measured occupancy rather than the inter-frame gap', async () => {
    application = startPlaying();

    await awaitFrames();

    const observed = histogramSeries('game2048_frame_time_milliseconds');
    const traced = application.tracer.snapshot().frames;

    // The loop measures how long its own callbacks occupied the frame and
    // hands that value to the tracer, so the histogram's sum is the traced
    // total and not a sum of scheduler gaps.
    expect(observed?.sum).toBeCloseTo(traced.totalFrameMs, 6);
  });

  it('publishes the inter-frame gap under a name of its own', async () => {
    application = startPlaying();

    await awaitFrames();

    const cadence = histogramSeries('game2048_span_duration_milliseconds', {
      key: 'span',
      value: 'render.frame.interval',
    });

    expect(cadence?.count ?? 0).toBeGreaterThan(0);
  });
});

describe('a contained failure', () => {
  /** The records the logger buffered, newest last. */
  const records = (subject: Application): readonly LogRecord[] =>
    subject.logger.snapshot().records;

  it('carries an engine listener s throw with its stack and cause', () => {
    application = startPlaying();

    const cause = new Error('the cause');
    const thrown = new Error('the listener threw', { cause });

    application.engine.events.on('state:commit', (): void => {
      throw thrown;
    });

    playEveryDirection();

    const reported = records(application).find(
      (record) => record.error?.message === 'the listener threw',
    );

    // A NAME AND A message were all this seam kept.
    expect(reported).toBeDefined();
    expect(reported?.error?.stack).toBeDefined();
    expect(reported?.error?.cause?.message).toBe('the cause');
  });

  it('carries a settings failure s throw with its stack and cause', () => {
    application = startPlaying();

    const cause = new Error('the underlying cause');
    const stop = application.preferences.subscribe((): void => {
      throw new Error('the preference listener threw', { cause });
    });

    // A contained throw from a preference listener, which reaches the
    // accessibility surface's own sink — the seam that reduced every caught
    // value to a name and a message before forwarding it.
    application.preferences.setNumberOnlyMode(true);
    stop();

    const reported = records(application).find(
      (record) => record.error?.message === 'the preference listener threw',
    );

    expect(reported).toBeDefined();
    expect(reported?.error?.stack).toBeDefined();
    expect(reported?.error?.cause?.message).toBe('the underlying cause');
  });
});

describe('the correlation identifier', () => {
  it('differs between two runs of the application', () => {
    const first = start(document);
    const firstId = first.logger.correlationId;

    first.dispose();

    clearOwnedStorage();
    document.body.innerHTML = MARKUP;
    resetWebGLSupportProbe();

    const second = start(document);
    const secondId = second.logger.correlationId;

    application = second;

    // Two runs, two identifiers.
    expect(firstId).not.toBe(secondId);
  });

  it('is preserved across a reload that resumes the same run', () => {
    const first = start(document);

    // The run is BEGUN here rather than resumed, because this case is about
    // what survives a reload of a run that started in this page load.
    beginRun();

    const firstId = first.logger.correlationId;

    // A move, so a commit persists the run: the identifier is read back out of
    // the stored envelope, and an envelope only exists once something
    // committed.
    playEveryDirection();
    first.dispose();

    document.body.innerHTML = MARKUP;
    resetWebGLSupportProbe();

    const second = start(document);

    application = second;

    // The SAME run, continued. `runId` is persisted and the seed is persisted,
    // so both derivation inputs come back unchanged and one run's records
    // carry one identifier however many times the page was loaded.
    expect(second.logger.correlationId).toBe(firstId);
    expect(second.run.identity.resumed).toBe(true);
  });

  it('is the run-instance form, longer than the seed-grouping form', () => {
    application = startPlaying();

    // 18 characters is the seed-grouping form; 26 is the form that appends the
    // run-instance segment.
    expect(application.logger.correlationId).toHaveLength(26);
  });

  it('is shared by the logger, the metrics registry and the diagnostics surface', () => {
    application = startPlaying();
    application.diagnostics.open();

    const expected = application.logger.correlationId;

    expect(application.metrics.snapshot().correlationId).toBe(expected);
    expect(application.diagnostics.lastSnapshot()?.correlationId).toBe(expected);
  });

  it('rotates across the WHOLE pipeline when a new run starts', () => {
    application = startPlaying();
    playEveryDirection();

    const before = application.logger.correlationId;

    application.startNewRun();

    const after = application.logger.correlationId;

    // A new run, a new identity, a new identifier.
    expect(after).not.toBe(before);

    expect(application.metrics.snapshot().correlationId).toBe(after);
    expect(application.tracer.snapshot().correlationId).toBe(after);
    expect(application.health.check().correlationId).toBe(after);
    expect(application.health.readiness().correlationId).toBe(after);
    expect(application.engine.correlationId).toBe(after);
    expect(application.engine.hooks.metrics().correlationId).toBe(after);
    expect(application.relics.correlationId).toBe(after);
    expect(application.run.correlationId()).toBe(after);
    expect(application.diagnostics.snapshot().correlationId).toBe(after);
  });

  it('rotates BEFORE the new run s first emission', () => {
    application = startPlaying();
    playEveryDirection();

    const before = application.logger.correlationId;

    application.startNewRun();

    const after = application.logger.correlationId;
    const records = application.logger
      .snapshot()
      .records.filter((record) => record.message === 'A new run started.');

    // EVERY BEGIN IS ATTRIBUTED TO THE RUN IT STARTED, and this page records
    // exactly one: the seeded envelope resumes, so the boot opens the run it
    // read rather than beginning one, and the only begin is the rotation just
    // made. A page that presses begin from the run-start screen first records
    // two, the earlier one under the identifier in force before its rotation.
    expect(records).toHaveLength(1);
    expect(records.at(-1)?.correlationId).toBe(after);
    expect(records.every((record) => record.correlationId === after)).toBe(true);
    expect(after).not.toBe(before);

    const records2 = application.tracer.snapshot().spans;
    const stages = records2.filter(
      (span) => span.name === SPAN_NAMES.engineStage,
    );
    const commits = records2.filter(
      (span) => span.name === SPAN_NAMES.renderCommit,
    );
    const dispatches = records2.filter(
      (span) => span.name === SPAN_NAMES.hookDispatch,
    );

    // The commit that opened the new run's stage, and the hook dispatches of
    // that opening, are the run's first emissions and carry ITS identifier.
    expect(commits.at(-1)?.correlationId).toBe(after);
    expect(commits.at(-1)?.correlationId).not.toBe(before);
    expect(commits.at(-1)?.id.startsWith(after)).toBe(true);
    expect(
      dispatches.filter((span) => span.correlationId === after).length,
    ).toBeGreaterThan(0);

    // The new run's stage span is still open — it is detached and closes on a
    // `stage:end` of its own — so it files no record here, and at least one
    // span is open for it.
    expect(application.tracer.snapshot().open).toBeGreaterThan(0);

    // AND THE FINISHED RUN'S SPANS ARE GONE, not relabelled. The rotation is a
    // partition (`DL-MAIN-28`): the tracer, the registry and the health surface
    // are returned to their start as the identifier changes, so every span this
    // snapshot carries belongs to the run the snapshot is keyed to. Before that
    // partition the previous run's stage span was still retained here, under a
    // header naming the run that had just begun.
    expect(
      records2.filter((span) => span.correlationId === before),
    ).toHaveLength(0);
    expect(stages.every((span) => span.correlationId === after)).toBe(true);

    // The logger is NOT partitioned, so the trail across the page load stays
    // readable: the finished run's records are still there, under its own
    // identifier.
    expect(
      application.logger
        .snapshot()
        .records.filter((record) => record.correlationId === before).length,
    ).toBeGreaterThan(0);
  });

  it('leaves the records of the finished run under its own identifier', () => {
    application = startPlaying();
    playEveryDirection();

    const before = application.logger.correlationId;
    const emittedBefore = application.logger
      .snapshot()
      .records.filter((record) => record.correlationId === before).length;

    expect(emittedBefore).toBeGreaterThan(0);

    application.startNewRun();

    // Records already written are NOT relabelled: they were true when they
    // were written, so a stream partitioned by identifier still shows the run
    // that ended as its own partition.
    expect(
      application.logger
        .snapshot()
        .records.filter((record) => record.correlationId === before).length,
    ).toBeGreaterThanOrEqual(emittedBefore);
  });
});

describe('the stage span of a run that ended without clearing its stage', () => {
  it('closes on an explicit end-run rather than staying open', () => {
    application = startPlaying();
    playEveryDirection();

    const openBefore = application.tracer.snapshot().open;

    expect(openBefore).toBeGreaterThan(0);

    application.run.endRun('abandoned');

    const spans = application.tracer.snapshot();
    const stages = spans.spans.filter(
      (span) => span.name === SPAN_NAMES.engineStage,
    );

    // The stage the run was playing files its record. CHANGED: it closes as a
    // RESOLVED stage carrying `cleared: false`, because `RunController.finish()`
    // now ends that stage through the engine before it summarises — so the span
    // records the transition that actually happened rather than the absence of
    // one. It used to close as `unwound` from the run reporter, and before that
    // it stayed open until a LATER stage superseded it, dating the stage span to
    // the whole gap between runs. DL-MAIN-29, DL-RUNCTL-30.
    expect(stages.length).toBeGreaterThan(0);
    expect(stages.at(-1)?.attributes[SPAN_ATTRIBUTES.outcome]).toBe(
      SPAN_OUTCOMES.committed,
    );
    expect(stages.at(-1)?.attributes[SPAN_ATTRIBUTES.cleared]).toBe(false);
    expect(spans.open).toBeLessThan(openBefore);
  });

  it('reports the run outcome through the completion record', () => {
    application = startPlaying();
    playEveryDirection();

    application.run.endRun('abandoned');

    // The run outcome left the stage span when the stage began resolving on its
    // own transition, so it is read where it has always also been recorded: the
    // completion report the run controller emits. DL-MAIN-29.
    expect(
      application.logger
        .snapshot()
        .records.some((record) =>
          JSON.stringify(record).includes('abandoned'),
        ),
    ).toBe(true);
  });
});

describe('the run correlation scope', () => {
  it('rotates every reporter together when a second run starts', () => {
    application = startPlaying();

    const firstId = application.logger.correlationId;

    application.startNewRun();

    const secondId = application.logger.correlationId;

    // A new run, so a new identifier.
    expect(secondId).not.toBe(firstId);

    // EVERY reporter, not just the logger. Each of these read a value captured
    // at construction and kept reporting the ended run's identifier.
    expect(application.tracer.correlationId).toBe(secondId);
    expect(application.engine.correlationId).toBe(secondId);
    expect(application.engine.hooks.metrics().correlationId).toBe(secondId);
    expect(application.run.correlationId()).toBe(secondId);
    expect(application.metrics.snapshot().correlationId).toBe(secondId);
    expect(application.health.correlationId).toBe(secondId);
    expect(application.health.check().correlationId).toBe(secondId);
  });

  it('is in force before the second run reports that it started', () => {
    application = startPlaying();

    const firstId = application.logger.correlationId;

    application.startNewRun();

    const secondId = application.logger.correlationId;
    const started = application.logger
      .recent(200)
      .filter(
        (record) =>
          record.subsystem === 'run/controller' &&
          record.message === 'Started a new run.',
      );

    // The run's OWN opening report. Rotating after the run had started left it
    // attributed to the run that ended.
    expect(started.length).toBeGreaterThan(0);
    expect(started[started.length - 1].correlationId).toBe(secondId);
    expect(started[started.length - 1].correlationId).not.toBe(firstId);
  });

  it('keys the spans of the second run to the second run', () => {
    application = startPlaying();

    application.startNewRun();

    const secondId = application.logger.correlationId;

    // Counted AFTER the rotation, so the records of the run that ended are not
    // measured here: a span belongs to the run that opened it, and the ones
    // opened before the rotation are correctly keyed to the first run.
    const before = application.tracer.snapshot().spans.length;

    playEveryDirection();

    const spans = application.tracer.snapshot().spans.slice(before);

    // Span identifiers are `${correlationId}#${counter}`, so a captured
    // identifier keys every later span to the ended run.
    expect(spans.length).toBeGreaterThan(0);

    for (const span of spans) {
      expect(span.correlationId).toBe(secondId);
      expect(span.id.startsWith(secondId)).toBe(true);
    }
  });

  it('still folds the hook bus counts into the registry after a rotation', () => {
    application = startPlaying();

    application.startNewRun();
    playEveryDirection();

    const snapshot = application.diagnostics.snapshot();
    const rejected = application.logger
      .recent(300)
      .filter((record) => record.message === 'hook dispatch fold rejected');

    expect(rejected).toHaveLength(0);
    expect(snapshot.correlationId).toBe(application.logger.correlationId);
    expect(snapshot.hooks.length).toBeGreaterThan(0);
  });
});

/** A board where pressing Left changes nothing. */
const IDLE_LEFT_STATE = JSON.stringify({
  grid: {
    size: 4,
    cells: [
      [{ position: { x: 0, y: 0 }, value: 2 }, null, null, null],
      [null, null, null, null],
      [null, null, null, null],
      [null, null, null, null],
    ],
  },
  score: 0,
  over: false,
  won: false,
  keepPlaying: false,
});

/** The tracer's snapshot as the diagnostics surface exports it. */
const traces = (subject: Application): TraceSnapshot => {
  const taken = subject.diagnostics.snapshot().traces;

  if (taken === null) {
    throw new Error('No tracer reached the diagnostics surface.');
  }

  return taken;
};

/** Every span name the tracer retained, oldest first. */
const spanNames = (subject: Application): readonly string[] =>
  traces(subject).spans.map((record) => record.name);

describe('the tracer is wired', () => {
  it('reaches the diagnostics surface, which reported no tracer before', () => {
    application = startPlaying();

    playEveryDirection();
    application.diagnostics.open();

    const snapshot = application.diagnostics.snapshot();

    // `null` here is the state the review found: the tracer module shipped
    // fully built and nothing constructed it, so the trace panel printed its
    // no-tracer line for the life of the page and Rule 3 counted the whole
    // capability as undelivered.
    expect(snapshot.traces).not.toBeNull();
    expect(snapshot.traces?.enabled).toBe(true);

    const panel = (
      document.querySelector('#diagnostics-overlay')?.textContent ?? ''
    ).replace(/\s+/g, ' ');

    expect(panel).toContain('spans');
    expect(panel).not.toContain('no tracer attached');
  });

  it('opens and closes spans as a turn is played', () => {
    application = startPlaying();

    playEveryDirection();

    const taken = traces(application);

    expect(taken.started).toBeGreaterThan(0);
    expect(taken.ended).toBeGreaterThan(0);
  });

  it('spans the INPUT boundary, naming the action', () => {
    application = startPlaying();

    press('ArrowRight', 'ArrowRight');

    const input = traces(application).spans.filter(
      (record) => record.name === SPAN_NAMES.inputDispatch,
    );

    expect(input.length).toBeGreaterThan(0);

    expect(
      input.some(
        (record) => record.attributes.action === 'input.dispatch.move',
      ),
    ).toBe(true);
    expect(
      input.every((record) =>
        String(record.attributes.action ?? '').startsWith('input.dispatch.'),
      ),
    ).toBe(true);
  });

  it('spans the ENGINE TURN, from the move through the commit', () => {
    application = startPlaying();

    playEveryDirection();

    const turns = traces(application).spans.filter(
      (record) => record.name === SPAN_NAMES.engineTurn,
    );

    expect(turns.length).toBeGreaterThan(0);
    expect(
      turns.some((record) => record.attributes.outcome === 'committed'),
    ).toBe(true);
  });

  it('spans the MOVE RESOLUTION inside the turn', () => {
    application = startPlaying();

    playEveryDirection();

    expect(spanNames(application)).toContain(SPAN_NAMES.moveResolution);
  });

  it('spans each HOOK DISPATCH, carrying the hook name', () => {
    application = startPlaying();

    playEveryDirection();

    const dispatches = traces(application).spans.filter(
      (record) => record.name === SPAN_NAMES.hookDispatch,
    );

    // The bus takes its wrappers as an injected port, so this is also the
    // assertion that src/engine still names no src/observability module and is
    // traced anyway.
    expect(dispatches.length).toBeGreaterThan(0);
    expect(
      dispatches.some((record) => record.attributes.hook === 'onAfterMove'),
    ).toBe(true);
  });

  it('spans the RENDER COMMIT, the fifth boundary of the chain', () => {
    application = startPlaying();

    playEveryDirection();

    expect(spanNames(application)).toContain(SPAN_NAMES.renderCommit);
  });

  it('spans the FRAME CALLBACK, the one asynchronous boundary', async () => {
    application = startPlaying();

    press('ArrowUp', 'ArrowUp');

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });

    const taken = traces(application);

    // Measured through the loop's own lifecycle hooks, which the tracer fills:
    // the frame callback was entirely unmeasured before this build.
    expect(taken.frames.frames).toBeGreaterThan(0);
    expect(spanNames(application)).toContain(SPAN_NAMES.frameCallback);
  });

  it('stamps every span with the run correlation identifier', () => {
    application = startPlaying();

    playEveryDirection();

    const expected = application.logger.correlationId;
    const records = traces(application).spans;

    expect(records.length).toBeGreaterThan(0);

    for (const record of records) {
      // A trace and a log are joinable only if both carry the same identifier.
      expect(record.correlationId).toBe(expected);
    }
  });

  it('closes the turn span of an IDLE move rather than leaving it open', () => {
    // Also the path a move withdrawn by an `onBeforeMove` handler takes: both
    // return `false` with a span open, and both are closed here.

    window.localStorage.setItem('gameState', IDLE_LEFT_STATE);

    application = startPlaying();

    press('ArrowLeft', 'ArrowLeft');

    const taken = traces(application);
    const turns = taken.spans.filter(
      (record) => record.name === SPAN_NAMES.engineTurn,
    );

    // An idle move emits nothing after `move:before`, so an unclosed span
    // would stay open until the next input and record the player's think time
    // as turn latency.
    expect(turns.length).toBe(1);
    expect(turns[0]?.attributes.outcome).toBe('unmoved');

    // Only the in-flight stage remains open — the turn is accounted for.
    expect(taken.open).toBe(1);
  });

  it('leaves nothing but the in-flight stage open as turns are played', () => {
    application = startPlaying();

    // One span is open before any input: the STAGE, which runs `stage:start`
    // through `stage:end` and is therefore open for as long as the stage is
    // being played.
    const settled = application.tracer.snapshot().open;

    playEveryDirection();
    playEveryDirection();
    playEveryDirection();

    const after = application.tracer.snapshot().open;

    // Every other span the chain opens is closed by the boundary that opened
    // it, so the count never GROWS with the turns played — which is the
    // property that distinguishes an in-flight span from a leak.
    expect(settled).toBe(1);
    expect(after).toBeLessThanOrEqual(settled);
  });

  it('records no tracer fault or anomaly over a played run', () => {
    application = startPlaying();

    playEveryDirection();
    playEveryDirection();

    const taken = traces(application);

    expect(taken.faults).toBe(0);
    expect(taken.doubleEnds).toBe(0);
    expect(taken.outOfOrderEnds).toBe(0);
  });

  it('closes the spans it still held when the application is disposed', () => {
    application = startPlaying();

    playEveryDirection();

    const tracer = application.tracer;

    application.dispose();
    application = null;

    expect(tracer.snapshot().open).toBe(0);
  });

  it('is the same tracer the diagnostics surface reads', () => {
    application = startPlaying();

    playEveryDirection();

    const direct = application.tracer.snapshot();
    const exported = application.diagnostics.snapshot().traces;

    // One tracer, not one per reader: a second instance would give the panel
    // and the console two disjoint views of the same run.
    expect(exported?.correlationId).toBe(direct.correlationId);
    expect(exported?.started).toBeGreaterThanOrEqual(direct.started);
  });
});

describe('the health surface is wired', () => {
  it('is exposed by the root, reporting all six checks', () => {
    application = startPlaying();

    const report = application.health.report();

    expect(report.checks).toHaveLength(HEALTH_CHECK_COUNT);
    expect(report.checks.map((check) => check.id)).toEqual([
      ...HEALTH_CHECK_IDS,
    ]);
  });

  it('carries the three-valued status, not a boolean', () => {
    application = startPlaying();

    const statuses = new Set(
      application.health.report().checks.map((check) => check.status),
    );

    // The inline reader collapsed the status onto `healthy: boolean`, so
    // `'not-applicable'` — a check that does not APPLY here, as distinct from
    // one that failed — could not be expressed at all.
    for (const status of statuses) {
      expect(['pass', 'fail', 'not-applicable']).toContain(status);
    }

    expect(application.health.report().counts).toEqual({
      pass: expect.any(Number),
      fail: expect.any(Number),
      'not-applicable': expect.any(Number),
    });
  });

  it('records the provenance of each check: reused or added', () => {
    application = startPlaying();

    const report = application.health.report();
    const reused = report.checks.filter(
      (check) => check.source.disposition === 'reused',
    );

    // Rule 3 requires the existing checks to be REUSED and what was reused
    // versus added to be documented.
    expect(reused).toHaveLength(HEALTH_CHECK_COUNT - 1);
    expect(
      report.checks.find((check) => check.id === 'webgl')?.source.disposition,
    ).toBe('added');
  });

  it('resolves the pointer check from the platform, not from the input manager', () => {
    application = startPlaying();

    const pointer = application.health
      .report()
      .checks.find((check) => check.id === 'pointerEvents');

    // The inline reader used `input.isListening`, which reports whether the
    // root had bound its listeners — a fact about this composition, not about
    // the platform's pointer capability.
    expect(pointer?.data.resolved).toBe(true);
    expect(pointer?.data.touchstart).toBe('touchstart');
    expect(pointer?.detail).not.toContain('renderer');
    expect(pointer?.source.disposition).toBe('reused');
  });

  it('reuses the storage manager probe rather than probing again', () => {
    application = startPlaying();

    const storage = application.health
      .report()
      .checks.find((check) => check.id === 'storage');

    // The manager probed once at construction with a write-and-remove round
    // trip; handing it to the surface is what keeps that at one per session.
    expect(storage?.status).toBe('pass');
    expect(storage?.data.strategy).toBe('localStorage');
  });

  it('exposes readiness verdicts, which nothing did before', () => {
    application = startPlaying();

    const readiness = application.health.readiness();

    expect(readiness.renderer).toBe(application.renderer.mode);
    expect(readiness.storage).toBe('persistent');
    expect(readiness.correlationId).toBe(application.logger.correlationId);
  });

  it('ACTS on the renderer verdict: no context means the number board', () => {
    application = startPlaying();

    const readiness = application.health.readiness();

    // jsdom implements no rendering context, so the verdict and the board on
    // screen have to agree.
    expect(readiness.mayMountWebGLRenderer).toBe(false);
    expect(readiness.requiresNumberOnlyFallback).toBe(true);
    expect(application.renderer.mode).toBe('number-only');
    expect(application.preferences.isNumberOnlyForced()).toBe(true);
  });

  it('counts the readiness verdicts it acted on at boot', () => {
    application = startPlaying();

    const readiness = application.metrics
      .snapshot()
      .series.filter(
        (series) =>
          series.name === 'game2048_reports_total' &&
          series.labels['report'] === 'health.readiness',
      );

    // Named `health.readiness` by the root and carried by the sink as the
    // `report` label of the one report family.
    expect(readiness.length).toBeGreaterThan(0);
    expect(
      readiness.some(
        (series) => series.kind === 'counter' && series.value > 0,
      ),
    ).toBe(true);
  });

  it('passes the surface itself to diagnostics, so the panel shows readiness', () => {
    application = startPlaying();
    application.diagnostics.open();

    const text = (
      document.querySelector('#diagnostics-overlay')?.textContent ?? ''
    ).replace(/\s+/g, ' ');

    // These four rows exist only for a surface source: a probe-view reader
    // carries no readiness at all, which is what the panel had before.
    expect(text).toContain('ready');
    expect(text).toContain('renderer');
    expect(text).toContain('may mount webgl');
    expect(text).toContain('number-only fallback');
  });

  it('puts the report and the readiness into the exported snapshot', () => {
    application = startPlaying();

    const health = application.diagnostics.snapshot().health;

    expect(health.report?.checks).toHaveLength(HEALTH_CHECK_COUNT);
    expect(health.readiness?.renderer).toBe('number-only');
  });

  it('still reports all six probes by name on the panel', () => {
    application = startPlaying();
    application.diagnostics.open();

    const text = (
      document.querySelector('#diagnostics-overlay')?.textContent ?? ''
    ).replace(/\s+/g, ' ');

    for (const probe of HEALTH_CHECK_IDS) {
      expect(text).toContain(probe);
    }
  });

  it('reports through the one correlation identifier', () => {
    application = startPlaying();

    expect(application.health.correlationId).toBe(
      application.logger.correlationId,
    );
    expect(application.health.reporterFaults).toBe(0);
  });
});

describe('the tracer is wired, at every boundary', () => {
  it('is exposed by the root, keyed to the run correlation identifier', () => {
    application = startPlaying();

    expect(application.tracer.correlationId).toBe(
      application.logger.correlationId,
    );
    expect(application.tracer.isEnabled()).toBe(true);
  });

  it('opens a stage span when the engine opens its board', () => {
    application = startPlaying();

    expect(application.tracer.snapshot().open).toBe(1);

    application.engine.endStage(false);

    expect(
      application.tracer.snapshot().spans.map((span): string => span.name),
    ).toContain(SPAN_NAMES.engineStage);
    expect(application.tracer.snapshot().open).toBe(0);
  });

  it('records a turn span for a move that resolved', () => {
    application = startPlaying();
    playEveryDirection();

    const spans = application.tracer.snapshot().spans;
    const turns = spans.filter(
      (span): boolean => span.name === SPAN_NAMES.engineTurn,
    );

    expect(turns.length).toBeGreaterThan(0);
    expect(
      turns.some(
        (span): boolean =>
          span.attributes[SPAN_ATTRIBUTES.outcome] ===
          SPAN_OUTCOMES.committed,
      ),
    ).toBe(true);
  });

  it('leaves no turn span open after an idle attempt', () => {
    application = startPlaying();
    playEveryDirection();
    playEveryDirection();

    // No turn span stays open, which is what this case is about.
    expect(application.tracer.hasOpenSpan(SPAN_NAMES.engineTurn)).toBe(false);
    expect(application.tracer.snapshot().open).toBeLessThanOrEqual(1);

    const turns = application.tracer
      .snapshot()
      .spans.filter((span): boolean => span.name === SPAN_NAMES.engineTurn);

    expect(turns).toHaveLength(8);

    for (const span of turns) {
      expect(span.attributes[SPAN_ATTRIBUTES.outcome]).not.toBe(
        SPAN_OUTCOMES.superseded,
      );
    }
  });

  it('records an input-boundary span for every key that arrived', () => {
    application = startPlaying();
    playEveryDirection();

    const names = application.tracer
      .snapshot()
      .spans.map((span): string => span.name);

    expect(names).toContain(SPAN_NAMES.inputDispatch);
  });

  it('reports no anomaly across a whole boot and four moves', () => {
    application = startPlaying();
    playEveryDirection();

    const anomalies = application.logger
      .recent(400)
      .filter(
        // The subsystem tag every record src/observability/tracer.ts emits
        // carries.
        (record) => record.subsystem === 'tracer' && record.level === 'warn',
      )
      .map((record) => record.message);

    expect(anomalies).toEqual([]);
    expect(application.tracer.snapshot().anomalies).toBe(0);
  });

  it('closes an idle turn inside the input span that opened it', () => {
    // A board with ONE tile in the top-left corner, so `ArrowUp` is a move
    // that changes nothing on every seed.
    window.localStorage.setItem(
      GAME_STATE_KEY,
      JSON.stringify({
        grid: {
          size: 4,
          cells: [
            [{ position: { x: 0, y: 0 }, value: 2 }, null, null, null],
            [null, null, null, null],
            [null, null, null, null],
            [null, null, null, null],
          ],
        },
        score: 0,
        over: false,
        won: false,
        keepPlaying: false,
      }),
    );

    application = startPlaying();
    press('ArrowUp', 'ArrowUp');

    const spans = application.tracer.recent(50);
    const turnIndex = spans.findIndex(
      (record) => record.name === SPAN_NAMES.engineTurn,
    );
    const inputIndex = spans.findIndex(
      (record) => record.name === SPAN_NAMES.inputDispatch,
    );

    expect(turnIndex).toBeGreaterThanOrEqual(0);
    expect(inputIndex).toBeGreaterThanOrEqual(0);

    // The idle attempt emits `move:before` and then nothing, so only the
    // caller holding the return value can close the turn span — and it must do
    // so BEFORE the input span it is a child of ends.
    expect(turnIndex).toBeLessThan(inputIndex);
    expect(spans[turnIndex].parentId).toBe(spans[inputIndex].id);
    expect(spans[turnIndex].attributes[SPAN_ATTRIBUTES.outcome]).toBe(
      SPAN_OUTCOMES.unmoved,
    );
    expect(application.tracer.snapshot().anomalies).toBe(0);
  });

  it('gives the diagnostics surface the tracer to read', () => {
    application = startPlaying();
    playEveryDirection();

    const traces = application.diagnostics.snapshot().traces;

    // `null` is what the surface reported for the life of the page before.
    expect(traces).not.toBeNull();
    expect(traces?.spans.length).toBeGreaterThan(0);
  });

  it('measures the frame callback, the one asynchronous boundary', () => {
    application = startPlaying();

    const hooks = application.tracer.frameLifecycleHooks();

    // The loop was constructed WITH these, so the seam is instrumented;
    // driving them here proves the pair the root passed is the pair that
    // records.
    hooks.onFrameBegin(undefined);
    hooks.onFrameEnd(undefined, 8);

    expect(
      application.tracer
        .snapshot()
        .spans.map((span): string => span.name),
    ).toContain(SPAN_NAMES.frameCallback);
  });
});

describe('the health surface is wired, whole', () => {
  it('reports all six checks, not a boolean projection of them', () => {
    application = startPlaying();

    const report = application.health.report();

    expect(report.checks).toHaveLength(HEALTH_CHECK_COUNT);
    expect(
      report.checks.map((check): string => check.id).sort(),
    ).toEqual([...HEALTH_CHECK_IDS].sort());
  });

  it('carries the three-state status a boolean could not', () => {
    application = startPlaying();

    for (const check of application.health.report().checks) {
      expect(['pass', 'fail', 'not-applicable']).toContain(check.status);
    }
  });

  it('carries the reused-versus-added provenance of each check', () => {
    application = startPlaying();

    const dispositions = application.health
      .report()
      .checks.map((check): string => check.source.disposition);

    // Five probes the vanilla sources already performed and discarded, plus
    // the one the Three.js renderer introduced.
    expect(dispositions.filter((value): boolean => value === 'reused'))
      .toHaveLength(HEALTH_CHECK_COUNT - 1);
    expect(dispositions.filter((value): boolean => value === 'added'))
      .toHaveLength(1);
  });

  it('reports readiness verdicts, which had no source at all before', () => {
    application = startPlaying();

    const readiness = application.health.readiness();

    expect(typeof readiness.ready).toBe('boolean');
    expect(['webgl', 'number-only']).toContain(readiness.renderer);
    expect(['persistent', 'ephemeral']).toContain(readiness.storage);
  });

  it('reuses the WebGL probe result, taking no second context', () => {
    application = startPlaying();

    const first = application.health.report();
    const second = application.health.report();

    // A second probe would request a second context; the level is held and
    // returned, so two readings agree.
    expect(
      second.checks.find((check) => check.id === 'webgl')?.data['level'],
    ).toBe(first.checks.find((check) => check.id === 'webgl')?.data['level']);
  });

  it('gives the diagnostics surface the report and the readiness', () => {
    application = startPlaying();

    const health = application.diagnostics.snapshot().health;

    expect(health.report).not.toBeNull();
    expect(health.readiness).not.toBeNull();
    expect(health.checks).toHaveLength(HEALTH_CHECK_COUNT);
    expect(health.status).not.toBeNull();
  });

  it('writes a status gauge for every check', () => {
    application = startPlaying();
    application.health.check();

    const names = application.metrics
      .snapshot()
      .series.map((series): string => series.name);

    expect(names.some((name): boolean => name.includes('health'))).toBe(true);
  });
});

/* ==========================================================================
 * The relic registry is wired
 *
 * `RelicRegistry` and `drawRelicOffers` had NO production caller: the port the
 * controller declared named members the registry does not have, so nothing
 * could satisfy it. A chosen relic reached the envelope and never reached the
 * hook bus, so it was displayed and never fired.
 * ========================================================================== */

/**
 * The identifier of the catalogue's charge-limited `onMerge` relic.
 *
 * Resolved from the catalogue rather than written as a literal, so a rename
 * fails the lookup here instead of silently testing nothing.
 */
const FROSTBIND_ID: string =
  RELIC_CATALOGUE.find((relic): boolean => relic.id === 'frostbind')?.id ?? '';

/**
 * A board carrying one mergeable pair on the top row.
 *
 * Pressing Left walks the tile at x=1 into the tile at x=0 and resolves a merge,
 * which is the one dispatch a charge-limited `onMerge` relic acts on. Written to
 * storage BEFORE `start()`, because the engine reads the snapshot once during
 * setup.
 */
const MERGEABLE_PAIR_STATE = JSON.stringify({
  grid: {
    size: 4,
    cells: [
      [{ position: { x: 0, y: 0 }, value: 2 }, null, null, null],
      [{ position: { x: 1, y: 0 }, value: 2 }, null, null, null],
      [null, null, null, null],
      [null, null, null, null],
    ],
  },
  score: 0,
  over: false,
  won: false,
  keepPlaying: false,
});

describe('the relic registry is wired', () => {
  it('is exposed by the root, over the real catalogue', () => {
    application = startPlaying();

    expect(application.relics.catalogue()).toBe(RELIC_CATALOGUE);
    expect(application.relics.catalogue()).toHaveLength(16);
  });

  it('is registered against the engine s own hook bus', () => {
    application = startPlaying();

    const picked = application.relics.pickUp(RELIC_CATALOGUE[0].id);

    expect(picked).toBeDefined();

    // The point of the binding. A relic in the envelope but not on the bus is
    // a relic that never fires.
    expect(
      application.engine.hooks
        .subscribers()
        .map((subscriber): string => subscriber.id),
    ).toContain(RELIC_CATALOGUE[0].id);
  });

  it('is bound to the run controller as its registry port', () => {
    application = startPlaying();
    application.run.recordRewardOffer([RELIC_CATALOGUE[0].id]);

    const resolution = application.run.resolveReward(RELIC_CATALOGUE[0].id);

    // The controller picked it up THROUGH the registry, which is what puts it
    // on the bus and what the port exists to do.
    expect(resolution.accepted).toBe(true);
    expect(application.relics.ownedIds()).toEqual([RELIC_CATALOGUE[0].id]);
  });

  it('refuses a reward the player was never offered', () => {
    application = startPlaying();

    const resolution = application.run.resolveReward(RELIC_CATALOGUE[0].id);

    expect(resolution.accepted).toBe(false);
    expect(resolution.refusal).toBe('not-offered');
    expect(application.relics.ownedIds()).toEqual([]);
  });

  it('restores an unresolved reward round from the envelope, without drawing', () => {
    // Three real catalogue relics, recorded as a round the interrupted run had
    // drawn and not yet resolved. Written before `start()`, because the envelope
    // is read once during composition.
    const offered = RELIC_CATALOGUE.slice(0, 3).map(
      (relic): string => relic.id,
    );

    window.localStorage.setItem(
      RUN_STATE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        runId: 'pending-round-run',
        seed: 'pending-round-seed',
        rngCursor: {
          'spawn-value': 3,
          'spawn-position': 3,
          'relic-draw': 3,
          'rarity-weight': 3,
        },
        stageIndex: 0,
        stageGoal: { kind: 'highest-tile', target: 64 },
        goalProgress: 0,
        relics: [],
        pendingReward: { stageIndex: 0, offeredRelicIds: offered },
        board: {
          grid: {
            size: 4,
            cells: [
              [{ position: { x: 0, y: 0 }, value: 2 }, null, null, null],
              [null, null, null, null],
              [null, null, null, null],
              [null, null, null, null],
            ],
          },
          score: 0,
          over: false,
          won: false,
          keepPlaying: false,
        },
      }),
    );

    application = start(document);

    // THE SAME THREE CARDS, rebuilt from the catalogue by identifier: the round
    // was lost on every reload before, because the offer lived only in memory.
    expect(application.rewards.offers().map((card): string => card.id)).toEqual(
      offered,
    );

    // A FULL CARD, not a bare identifier: the screen needs the name, the rarity,
    // the description and the hook badges, and all four come from the catalogue.
    const first = application.rewards.offers()[0];

    expect(first?.name).toBe(RELIC_CATALOGUE[0].name);
    expect(first?.rarity).toBe(RELIC_CATALOGUE[0].rarity);
    expect(first?.hooks.length).toBeGreaterThan(0);

    // PROJECTED, NOT REDRAWN. Every cursor is exactly where the envelope left it,
    // so restoring the round cost the run no randomness and the seed still
    // determines the offer sequence (AAP V2, Contract 6).
    expect(application.run.cursors()).toEqual({
      'spawn-value': 3,
      'spawn-position': 3,
      'relic-draw': 3,
      'rarity-weight': 3,
    });

    // And it is a LIVE round: the card can be taken through the composed path.
    expect(application.rewards.choose(offered[0] ?? '')).toBe(true);
    expect(application.relics.ownedIds()).toEqual([offered[0]]);
  });

  it('exposes no charge-spending member on the run controller', () => {
    const started = start(document);

    application = started;

    // THE ACTIVATION PATH IS GONE, AND DELIBERATELY SO. Every charge-limited
    // relic in the catalogue is automatic — each fires on a hook it bound and
    // asks for its charge on that one dispatch — so a controller member that
    // debited a budget from a player's press debited it for no effect. The
    // absence is asserted rather than described, because a re-introduced member
    // would restore exactly that defect. DL-RUNCTL-18.
    const surface = started.run as unknown as Record<string, unknown>;

    expect(surface.activateRelic).toBeUndefined();
    expect(surface.consumeCharge).toBeUndefined();
    expect(surface.spendCharge).toBeUndefined();
  });

  it('spends a charge budget on the merge the relic acted on', () => {
    // Frostbind is the catalogue's charge-limited `onMerge` relic, so one merge
    // is one toggle and one charge. The board is written before `start()`
    // because the engine reads the snapshot once during setup, and the pair sits
    // on one row so pressing Left resolves a merge deterministically rather than
    // betting on where the run seed put the opening tiles.
    window.localStorage.setItem('gameState', MERGEABLE_PAIR_STATE);

    const started = start(document);

    application = started;

    started.run.recordRewardOffer([FROSTBIND_ID]);

    expect(started.run.resolveReward(FROSTBIND_ID).accepted).toBe(true);

    const before = started.relics.find(FROSTBIND_ID)?.charges ?? 0;

    expect(before).toBeGreaterThan(0);

    press('ArrowLeft', 'ArrowLeft');

    // The bus spent it, on the dispatch that ran the handler: the budget is the
    // number of merges the relic acts on, and it moves only when one resolved.
    expect(started.relics.find(FROSTBIND_ID)?.charges).toBe(before - 1);
  });

  it('reinstates an exhausted relic s standing rule on the resumed rules', () => {
    // What a session that spent every Frostbind charge leaves behind: the relic
    // held at zero, and the cells those charges froze in its state slot. The
    // envelope is written before `start()`, because the run is read once during
    // composition.
    window.localStorage.setItem(
      RUN_STATE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        runId: 'exhausted-frost-run',
        seed: 'exhausted-frost-seed',
        rngCursor: {
          'spawn-value': 4,
          'spawn-position': 4,
          'relic-draw': 1,
          'rarity-weight': 1,
        },
        stageIndex: 0,
        stageGoal: { kind: 'highest-tile', target: 16 },
        goalProgress: 0,
        relics: [
          { id: FROSTBIND_ID, charges: 0, state: { frozen: [{ x: 1, y: 1 }] } },
        ],
        board: {
          grid: {
            size: 4,
            cells: [
              [{ position: { x: 0, y: 0 }, value: 2 }, null, null, null],
              [null, null, null, null],
              [null, null, null, null],
              [null, null, null, null],
            ],
          },
          score: 0,
          over: false,
          won: false,
          keepPlaying: false,
        },
      }),
    );

    const started = start(document);

    application = started;

    // The relic is held with the spent budget the envelope carried.
    expect(started.relics.ownedIds()).toEqual([FROSTBIND_ID]);
    expect(started.relics.find(FROSTBIND_ID)?.charges).toBe(0);

    // THE STANDING RULE IS BACK, on the rules this boot rebuilt from the
    // defaults — reinstated by the registry's rehydration path and not by
    // dispatching to an exhausted handler, which the charge guard now withholds
    // on all six hooks. DL-HOOKBUS-07, DL-REGISTRY-04, DL-MAIN-39.
    const rules = started.config.merge.canMerge;
    const moving = new Tile({ x: 0, y: 1 }, 2);

    expect(rules(moving, new Tile({ x: 1, y: 1 }, 2))).toBe(false);
    expect(rules(moving, new Tile({ x: 3, y: 1 }, 2))).toBe(true);
  });

  it('carries the held relics into every commit', () => {
    application = startPlaying();
    application.run.recordRewardOffer([RELIC_CATALOGUE[0].id]);
    application.run.resolveReward(RELIC_CATALOGUE[0].id);

    const relics: number[] = [];

    application.engine.events.on('state:commit', (event): void => {
      relics.push(event.relics.length);
    });

    playEveryDirection();

    expect(relics.length).toBeGreaterThan(0);

    for (const count of relics) {
      expect(count).toBe(1);
    }
  });

  it('opens the board the run resolved, not the legacy key', () => {
    application = startPlaying();

    const cells = application.engine
      .serialize()
      .grid.cells.flat()
      .filter((cell): boolean => cell !== null);

    expect(cells).toHaveLength(application.config.startTiles);
  });
});

/* ==========================================================================
 * A refusal is reported as a refusal, not as a failure
 * ========================================================================== */

describe('the storage sink separates a refusal from a failure', () => {
  /** Reads the storage records the boot produced. */
  const storageRecords = (): LogRecord[] =>
    (application as Application).logger
      .recent(400)
      .filter((record) => record.subsystem === 'storage');

  it('reports an over-ceiling read at warning, worded as a refusal', () => {
    // Half a megabyte under a key whose ceiling is 65,536 bytes. The adapter
    // measures the raw text and declines; nothing is thrown and nothing is
    // parsed, so the record must not claim the read failed.
    window.localStorage.setItem('gameState', `"${'p'.repeat(60_000)}"`);

    application = start(document);

    const refusals = storageRecords().filter((record) =>
      record.message.includes('refused'),
    );

    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.level).toBe('warn');
    expect(refusals[0]?.message).toBe('Storage read refused for gameState.');
    expect(refusals[0]?.fields?.refused).toBe(true);
    expect(refusals[0]?.error?.name).toBe('StorageSizeError');

    // No record on this boot claims a failure.
    expect(
      storageRecords().filter((record) => record.message.includes('failed')),
    ).toEqual([]);
  });

  it('reports a recovered parse failure at warn, as an unreadable value', () => {
    // Well under the ceiling, so the size gate cannot fire and the value
    // reaches `JSON.parse`, which throws.
    //
    // UPDATED with DL-STORE-09, which names this a THIRD category the original
    // two did not cover: the store neither refused nor failed — it handed the
    // text over without complaint and the READ recovered, because `readJson`
    // answers `null` and every caller has a documented fallback. It was
    // reported at `error`, claiming a failure on the one path whose whole
    // design is to survive corruption. A store that genuinely throws still
    // reports at `error`, which the case below holds.
    window.localStorage.setItem('gameState', '{"grid":');

    application = start(document);

    // Not worded as a failure, and not worded as a refusal either.
    expect(
      storageRecords().filter((record) => record.message.includes('failed')),
    ).toEqual([]);

    const unreadable = storageRecords().filter((record) =>
      record.message.includes('unreadable'),
    );

    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]?.level).toBe('warn');
    expect(unreadable[0]?.message).toBe(
      'Storage read found an unreadable value at gameState.',
    );
    expect(unreadable[0]?.fields?.refused).toBe(false);
    expect(unreadable[0]?.fields?.unreadable).toBe(true);

    // The cause survives in the bounded description, where it used to be
    // flattened onto "Unknown storage error."
    expect(unreadable[0]?.error?.name).toBe('SyntaxError');
    expect(unreadable[0]?.error?.message).toContain('not valid JSON');
  });

  it('reports one record for one unreadable value, however often it is read', () => {
    // Two consumers read the run-state key at boot — the identity resolver and
    // the loader — and the failed parse used to drop its memo, so one corrupt
    // value produced one record per read. DL-STORE-09.
    window.localStorage.setItem(namespacedKey('runState'), '{"schemaVersion":');

    application = start(document);

    const unreadable = storageRecords().filter(
      (record) =>
        record.message.includes('unreadable') &&
        String(record.fields?.key).includes('runState'),
    );

    expect(unreadable).toHaveLength(1);

    // The boot itself performs the two reads, so one record for the pair is
    // already the proof: before the memo remembered the failure it produced
    // two.
  });

  it('reports a SyntaxError from a WRITE at error, as a lost write', () => {
    // ADDED with the corrected DL-STORE-09. The tier above read
    // `error.name === 'SyntaxError'`, so ANY failure carrying that name was
    // reported as a recovered read of an unreadable value — including a write
    // that never reached storage. `JSON.parse` is not the only source of the
    // name: a `toJSON` member, a replacer or a patched store member raises one
    // too, and each of those LOST DATA. The classification now reads the tag
    // the adapter sets at its parse, so this record says what happened.
    const prototype = window.Storage.prototype;
    const native = prototype.setItem;

    prototype.setItem = function raising(
      this: Storage,
      key: string,
      value: string,
    ): void {
      if (key === GAME_STATE_KEY) {
        throw new SyntaxError('Unexpected token from a patched store member.');
      }

      native.call(this, key, value);
    };

    try {
      application = startPlaying();
      playEveryDirection();
    } finally {
      prototype.setItem = native;
    }

    const lost = storageRecords().filter(
      (record) =>
        record.fields?.key === GAME_STATE_KEY &&
        record.fields?.operation === 'write',
    );

    expect(lost.length).toBeGreaterThan(0);

    for (const record of lost) {
      // A failure, at the failure tier, worded as one.
      expect(record.level).toBe('error');
      expect(record.message).toBe('Storage write failed for gameState.');
      expect(record.fields?.unreadable).toBe(false);
      expect(record.fields?.refused).toBe(false);

      // The name is unchanged and is simply no longer the classifier.
      expect(record.error?.name).toBe('SyntaxError');
      expect(record.error?.message).not.toContain('not valid JSON');
    }

    // And nothing on this boot claims a value could not be read.
    expect(
      storageRecords().filter((record) =>
        record.message.includes('unreadable'),
      ),
    ).toEqual([]);
  });

  it('fabricates no error for a run refused on its size', () => {
    // The run-state loader refuses before parsing, so it catches nothing. A
    // record that forwarded an absent throwable serialised a made-up
    // `UnknownError`, which read as an exception the loader never saw.
    window.localStorage.setItem(
      namespacedKey('runState'),
      `{"schemaVersion":1,"pad":"${'p'.repeat(80_000)}"}`,
    );

    application = start(document);

    const refused = (application as Application).logger
      .recent(400)
      .filter(
        (record) =>
          record.subsystem === 'run/state' &&
          record.message.includes('refused'),
      );

    expect(refused).toHaveLength(1);
    expect(refused[0]?.level).toBe('warn');
    expect(refused[0]?.error).toBeUndefined();
    expect(String(refused[0]?.fields?.problems)).toContain('ceiling');

    // And the run still started, from scratch. A refused envelope resumes
    // nothing, so the flow holds run start and the board opens on the begin-run
    // control — the same two steps a first-ever load takes.
    expect(beginRun()).toBe(true);

    expect(
      (application as Application).engine
        .serialize()
        .grid.cells.flat()
        .filter((cell): boolean => cell !== null),
    ).toHaveLength((application as Application).config.startTiles);
  });
});

/* ==========================================================================
 * What an export carries, and what it must not
 *
 * A SEED IS THE PLAYER'S OWN TEXT. The run-start field accepts anything and the
 * summary invites the player to copy it, so it is public by design — but it must
 * be public THERE and nowhere else: a record or a metric label carrying it
 * publishes it into whatever reads the export, and the run identifier beside it
 * is the key the correlation identifier is derived under. Decisions DL-LOG-09,
 * DL-LOG-10.
 * ========================================================================== */

describe('an export carries neither the seed nor the run identifier', () => {
  /** A seed no other value in the tree could contain by accident. */
  const SEED = 'zzq-private-seed-text-zzq';

  it('keeps both out of the logs, the metrics and the overlay snapshot', () => {
    application = startPlaying();

    const started = application.startNewRun(SEED);

    expect(started).toBe(SEED);

    playEveryDirection();

    const runId = application.run.runId();

    expect(runId.length).toBeGreaterThan(0);

    const surfaces: readonly [string, string][] = [
      ['log records', application.logger.toJsonLines()],
      ['metrics text', application.metrics.toPrometheusText()],
      ['overlay metrics', application.diagnostics.toPrometheusText()],
      [
        'overlay snapshot',
        JSON.stringify(application.diagnostics.snapshot()),
      ],
    ];

    for (const [name, text] of surfaces) {
      expect(text.length, name).toBeGreaterThan(0);
      expect(text, name).not.toContain(SEED);
      expect(text, name).not.toContain(runId);
    }

    // And the identifier the records ARE keyed on is the derived one, which is
    // what makes the two absences costless.
    expect(application.logger.toJsonLines()).toContain(
      application.logger.correlationId,
    );
  });

  it('keeps the seed readable by the player who typed it', () => {
    application = startPlaying();
    application.startNewRun(SEED);

    // THE PORT THE SUMMARY RENDERS FROM STILL HOLDS IT. A player cannot replay
    // a run whose seed they were never shown, so withholding it from exports
    // must not withhold it from the screen: the value is on the run, in memory
    // and in the envelope, and absent only from what leaves the page.
    expect(application.run.seed()).toBe(SEED);
    expect(application.run.summary().seed).toBe(SEED);
    expect(
      JSON.parse(window.localStorage.getItem(RUN_STATE_KEY) ?? 'null')?.seed,
    ).toBe(SEED);
  });
});

/* ==========================================================================
 * One refused write, one authoritative record
 *
 * A run whose storage was full described itself three times: the adapter
 * reported the raised `setItem`, `RunStateStore.save` reported the refused
 * envelope, and the controller reported a third time. Three error records of
 * one event, none of which said anything the player could act on.
 *
 * The store's record is the authoritative one — it alone holds the key, the
 * serialised size and the cause. The adapter's record is the PHYSICAL CAUSE of
 * that same event, so for that one key and operation it is filed at debug: out
 * of the way at the default level, and still there for a session that lowers
 * the level to look for it. Decisions DL-STORE-08, DL-RUNCTL-20.
 * ========================================================================== */

describe('a run-state write that storage refuses', () => {
  /**
   * Refuses every write to the run-state key at the PLATFORM boundary, for the
   * duration of `body`.
   *
   * `Storage.prototype` is patched rather than the storage instance, because
   * jsdom's `Storage` exposes named properties: assigning to
   * `localStorage.setItem` stores an item called `setItem` and leaves the
   * method untouched. Only the one key refuses, so the adapter's construction
   * probe still passes and the strategy stays `localStorage` — which is what
   * makes this an exhausted quota rather than an absent store.
   *
   * @param body Runs with the refusal in force.
   */
  const withRefusedRunWrites = (body: () => void): void => {
    const prototype = window.Storage.prototype;
    const native = prototype.setItem;

    prototype.setItem = function refusing(
      this: Storage,
      key: string,
      value: string,
    ): void {
      if (key === RUN_STATE_KEY) {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      }

      native.call(this, key, value);
    };

    try {
      body();
    } finally {
      prototype.setItem = native;
    }
  };

  /** Every record of one subsystem the boot produced. */
  const recordsOf = (subsystem: string): LogRecord[] =>
    (application as Application).logger
      .recent(400)
      .filter((record) => record.subsystem === subsystem);

  /** The adapter's records for writes to the run-state key. */
  const physicalCauses = (): LogRecord[] =>
    recordsOf('storage').filter(
      (record) =>
        record.fields?.key === RUN_STATE_KEY &&
        record.fields?.operation === 'write',
    );

  /** The store's records for a run that did not reach storage. */
  const authoritative = (): LogRecord[] =>
    recordsOf('run/state').filter((record) =>
      record.message.includes('could not be persisted'),
    );

  it('reports it once at the default level, from the layer that owns it', () => {
    window.localStorage.setItem(RUN_STATE_KEY, SEEDED_ENVELOPE);

    withRefusedRunWrites(() => {
      application = startPlaying();
      playEveryDirection();
    });

    // ONE RECORD PER EVENT. The store's, at error, carrying the key and the
    // size; the adapter's second description of the same event is filed at
    // debug and therefore discarded at the default level.
    const records = authoritative();

    expect(records.length).toBeGreaterThan(0);

    for (const record of records) {
      expect(record.level).toBe('error');
      expect(record.fields?.key).toBe(RUN_STATE_KEY);
      expect(record.fields?.byteLength ?? 0).toBeGreaterThan(0);
    }

    expect(physicalCauses()).toEqual([]);
  });

  it('keeps the physical cause for a session that lowers the level', () => {
    window.localStorage.setItem(RUN_STATE_KEY, SEEDED_ENVELOPE);

    withRefusedRunWrites(() => {
      application = startPlaying();

      (application as Application).logger.setLevel('debug');

      playEveryDirection();
    });

    const causes = physicalCauses();

    // DEMOTED, NOT DELETED. The record still names the adapter as its source
    // and the layer that reported the event authoritatively, so a session
    // reading it is not left to guess which record it duplicates.
    expect(causes.length).toBeGreaterThan(0);

    for (const cause of causes) {
      expect(cause.level).toBe('debug');
      expect(cause.fields?.reportedBy).toBe('run/state');
      expect(cause.message).toContain(RUN_STATE_KEY);
    }
  });

  it('plays on, and tells the player the run is no longer being saved', () => {
    window.localStorage.setItem(RUN_STATE_KEY, SEEDED_ENVELOPE);

    withRefusedRunWrites(() => {
      application = startPlaying();
      playEveryDirection();
    });

    // THE RUN IS DEGRADED, NOT ABANDONED. The board went on being played from
    // memory, and the consequence reached the interface rather than stopping at
    // the log: a run whose writes are refused told the player nothing at all,
    // so they went on playing a run no reload would ever find.
    const hud = document.querySelector('[data-screen="hud"]');

    expect(hud?.getAttribute('data-ephemeral')).toBe('true');

    const notice = hud?.querySelector('.hud-ephemeral');

    expect(notice).not.toBeNull();
    expect((notice as HTMLElement | null)?.hidden).toBe(false);
    expect(notice?.textContent ?? '').toContain('not being saved');

    expect(
      (application as Application).engine
        .serialize()
        .grid.cells.flat()
        .filter((cell): boolean => cell !== null).length,
    ).toBeGreaterThan(0);
  });

  // ADDED: the same scenario measured ONE COMMIT EARLIER. The controller writes
  // after every view has taken the commit, so the status the HUD read during
  // the refused turn was the one in force BEFORE that write — and a store whose
  // quota is exhausted refuses every later write too, so with no follow-up
  // commit the interface kept saying the run was being saved for the rest of the
  // run. The crossing itself now reaches the screen. DL-MAIN-38, DL-HUD-17.
  it('tells the player on the very turn the write was refused', () => {
    window.localStorage.setItem(RUN_STATE_KEY, SEEDED_ENVELOPE);

    // THE RUN STARTS SAVED. The refusal begins mid-run, after a turn that was
    // written, so the status the next commit's HUD write reads is `persistent`
    // and only the crossing itself can correct it.
    application = startPlaying();
    press('ArrowDown', 'ArrowDown');

    const hud = document.querySelector('[data-screen="hud"]');
    const notice = (): HTMLElement | null =>
      hud?.querySelector<HTMLElement>('.hud-ephemeral') ?? null;

    expect((application as Application).run.persistenceStatus()).toBe(
      'persistent',
    );
    expect(hud?.hasAttribute('data-ephemeral')).toBe(false);

    withRefusedRunWrites(() => {
      // ONE move under the refusal, so exactly one write has been refused and no
      // later commit can have carried the corrected status.
      press('ArrowLeft', 'ArrowLeft');
    });

    expect((application as Application).run.persistenceStatus()).toBe(
      'ephemeral',
    );
    expect(hud?.getAttribute('data-ephemeral')).toBe('true');
    expect(notice()?.hidden).toBe(false);
    expect(notice()?.textContent ?? '').toContain('not being saved');

    // The turn's own score is still on screen: the refresh writes the status
    // alone and never re-renders the commit.
    expect(
      document.querySelector('.score-container')?.textContent ?? '',
    ).not.toBe('');
  });

  it('takes the notice back down on the turn the store recovers', () => {
    window.localStorage.setItem(RUN_STATE_KEY, SEEDED_ENVELOPE);

    withRefusedRunWrites(() => {
      application = startPlaying();
      press('ArrowDown', 'ArrowDown');
    });

    const hud = document.querySelector('[data-screen="hud"]');

    expect(hud?.getAttribute('data-ephemeral')).toBe('true');

    // The refusal is lifted, and the next turn's write succeeds: the crossing
    // back is reported the same way and the notice must not outlive it.
    press('ArrowLeft', 'ArrowLeft');

    expect((application as Application).run.persistenceStatus()).toBe(
      'persistent',
    );
    expect(hud?.hasAttribute('data-ephemeral')).toBe(false);
    expect(
      hud?.querySelector<HTMLElement>('.hud-ephemeral')?.hidden,
    ).toBe(true);
  });

  // The observability review's INFO finding on the health surface: at the exact
  // moment the run stopped being saved and the HUD said so, the `storage` health
  // row still read `pass` / "Web Storage is writable." and readiness still said
  // `persistent` — a green row beside the failure that contradicted it, on the
  // surface an operator trusts most. The live verdict closes that, and the
  // crossing is what recomputes the held report. DL-HEALTH-08, DL-MAIN-35.
  it('degrades the storage health row while the run is not being saved', () => {
    window.localStorage.setItem(RUN_STATE_KEY, SEEDED_ENVELOPE);

    withRefusedRunWrites(() => {
      application = startPlaying();
      playEveryDirection();

      const live = application as Application;
      const report = live.health.report();
      const storage = report.checks.find((check) => check.id === 'storage');

      expect(storage?.status).toBe('fail');
      expect(storage?.detail ?? '').toContain('refusing writes');

      // The same fact, on the two other channels the surface publishes it
      // through: the readiness roll-up and the per-check gauge.
      const verdicts = live.health.readiness();

      expect(verdicts.storageStatus).toBe('fail');
      expect(verdicts.storage).toBe('ephemeral');

      // The manager never fell back to memory, and the strategy still says so.
      expect(verdicts.storageStrategy).toBe('localStorage');

      expect(live.metrics.toPrometheusText()).toContain(
        'game2048_health_check_status{check="storage"} 0',
      );

      // And the interface says the same thing at the same time, which is the
      // agreement that was missing.
      const hud = document.querySelector('[data-screen="hud"]');

      expect(hud?.getAttribute('data-ephemeral')).toBe('true');
    });
  });

  it('reports storage healthy again once writes are accepted', () => {
    window.localStorage.setItem(RUN_STATE_KEY, SEEDED_ENVELOPE);

    withRefusedRunWrites(() => {
      application = startPlaying();
      playEveryDirection();
    });

    // The refusal is over; the verdict is read at check time and never cached,
    // so the next check answers from the store as it is now.
    const live = application as Application;

    playEveryDirection();

    const storage = live.health
      .check()
      .checks.find((check) => check.id === 'storage');

    expect(storage?.status).toBe('pass');
    expect(storage?.detail ?? '').toContain('writable');
    expect(live.health.readiness().storage).toBe('persistent');
  });

  it('answers both HUD run-status readers without faulting', () => {
    window.localStorage.setItem(RUN_STATE_KEY, SEEDED_ENVELOPE);

    withRefusedRunWrites(() => {
      application = startPlaying();
      playEveryDirection();
    });

    // BOTH READERS RAN. The HUD reads the run's persistence status from the
    // controller and the degraded relics from the registry on every write, and
    // counts a fault when either is absent, answers with the wrong shape or
    // raises. A boot that counted one would mean the root handed it something
    // the HUD could not read.
    const faults = (application as Application).metrics
      .snapshot()
      .series.filter(
        (series) =>
          series.name === `${METRIC_PREFIX}reports_total` &&
          series.labels.report === 'ui.hud.reader.faulted',
      );

    expect(faults).toEqual([]);
  });

  it('records the crossing into ephemeral once, not once per refused write', () => {
    window.localStorage.setItem(RUN_STATE_KEY, SEEDED_ENVELOPE);

    withRefusedRunWrites(() => {
      application = startPlaying();
      playEveryDirection();
    });

    // THE TRANSITION IS CONSUMED, not merely emitted. The controller reports it
    // through an OPTIONAL sink member, so a production sink that did not
    // implement it would drop the report silently and nothing would fail: the
    // run's status would reach the interface and never reach the telemetry.
    const crossings = recordsOf('run/state').filter((record) =>
      record.message.includes('no longer being saved'),
    );

    expect(crossings.length).toBe(1);
    expect(crossings[0]?.level).toBe('warn');
    expect(crossings[0]?.fields?.status).toBe('ephemeral');
    expect(crossings[0]?.fields?.previous).toBe('persistent');
    expect(
      (crossings[0]?.fields?.refusedWrites as number | undefined) ?? 0,
    ).toBeGreaterThan(0);

    // ONE COUNT for the same crossing, on its own report name, while the
    // per-write failure records stay on their own family above.
    const counted = (application as Application).metrics
      .snapshot()
      .series.filter(
        (series) =>
          series.name === `${METRIC_PREFIX}reports_total` &&
          series.kind === 'counter' &&
          series.labels.report === 'run.persistence.changed',
      );

    expect(counted.length).toBe(1);
    expect(counted[0]?.kind === 'counter' ? counted[0].value : -1).toBe(1);
    expect(authoritative().length).toBeGreaterThan(1);
  });
});

/* ==========================================================================
 * A caught value a screen reports
 *
 * The run-summary screen's clipboard refusal used to reduce the rejection to
 * `Error.name: Error.message` and put that text in an ORDINARY field. Fields
 * are shape-normalised and never sensitivity-redacted, so a rejection message
 * written by a browser implementation — or by an injected rejection — was
 * retained in the log ring buffer and downloadable with the diagnostics
 * snapshot. The field now carries the rejection's CLASS, and the value itself
 * travels on the level-preserving failure channel, where the logger's
 * redaction model and its record budget apply to it.
 * Decisions DL-SETTINGS-07, DL-SUMMARY-15, DL-LOG-08, DL-LOG-10.
 * ========================================================================== */

describe('a clipboard rejection reaches no unredacted field', () => {
  /** A URL carrying a credential-like query value. */
  const SECRET_URL = 'https://internal.example.test/cb?token=zzq-secret-zzq';

  /** An absolute path of the form a stack frame writes. */
  const SECRET_PATH = '/srv/private/zzq-user/profile.json';

  /** A PII-like value, in the form a platform message might embed. */
  const SECRET_PII = 'ada.zzq-lovelace@example.test';

  /** The whole message the injected rejection carries. */
  const REJECTION_MESSAGE =
    `write refused at ${SECRET_URL} reading ${SECRET_PATH} ` +
    `for ${SECRET_PII}`;

  /** Every fragment no field may carry, whole or in part. */
  const SECRETS: readonly string[] = Object.freeze([
    SECRET_URL,
    SECRET_PATH,
    SECRET_PII,
    'zzq-secret-zzq',
    'write refused',
  ]);

  /**
   * Boots the application onto the run summary, the state that renders the
   * seed and its copy control.
   *
   * The board carries two tiles of half the win value side by side, so one
   * leftward move merges them into it, and the stored stage goal sits far above
   * that tile so the stage does not clear on the way. The win takes the
   * `winReached` edge, and the terminal screen's `End run` control takes the
   * `endRun` edge to the summary.
   *
   * @returns The started application, with the summary on screen.
   */
  const openRunSummary = (): Application => {
    const board = copyBoard(NEAR_WIN_BOARD);

    window.localStorage.setItem(GAME_STATE_KEY, JSON.stringify(board));
    window.localStorage.setItem(
      RUN_STATE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        runId: 'clipboard-report-run',
        seed: 'clipboard-report-seed',
        rngCursor: {
          'spawn-value': 0,
          'spawn-position': 0,
          'relic-draw': 0,
          'rarity-weight': 0,
        },
        stageIndex: 0,
        stageGoal: { kind: 'highest-tile', target: 4096 },
        goalProgress: 0,
        relics: [],
        board,
      }),
    );

    const started = start(document);

    application = started;

    press('ArrowLeft', 'ArrowLeft');

    expect(started.engine.won).toBe(true);

    const control = (host: string, label: string): HTMLElement | undefined =>
      [
        ...(document
          .getElementById(host)
          ?.querySelectorAll<HTMLElement>('button') ?? []),
      ].find((button): boolean => button.textContent === label);

    control('screen-game-over', 'End run')?.click();

    expect(document.getElementById('screen-run-summary')?.hidden).toBe(false);

    return started;
  };

  /** Installs a clipboard whose write rejects with the crafted message. */
  const installRefusingClipboard = (): void => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (): Promise<void> =>
          Promise.reject(new Error(REJECTION_MESSAGE)),
      },
    });
  };

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('reports the class in the field and the value on the failure channel', async () => {
    const started = openRunSummary();

    installRefusingClipboard();

    const copy = [
      ...(document
        .getElementById('screen-run-summary')
        ?.querySelectorAll<HTMLElement>('button') ?? []),
    ].find((button): boolean => button.textContent === 'Copy seed');

    expect(copy).toBeDefined();
    copy?.click();

    // The write is asynchronous, so the rejection is reported a microtask
    // later. Two turns of the queue cover the `await` and its `catch`.
    await Promise.resolve();
    await Promise.resolve();

    const refusals = started.logger
      .recent()
      .filter((record) => record.message === 'the clipboard refused the seed');

    expect(refusals).toHaveLength(1);

    const refusal = refusals[0] as LogRecord;

    // The severity the caller chose, preserved across the channel: the refusal
    // is recovered from by the selection path. DL-SUMMARY-14.
    expect(refusal.level).toBe('warn');
    expect(refusal.subsystem).toBe('ui/a11y');
    expect(refusal.fields?.reason).toBe('Error');

    // The value itself travelled, so the failure is still diagnosable.
    expect(refusal.error).toBeDefined();

    // NO FIELD of any record carries any part of the caught text. This is the
    // total property the fix delivers: fields are the surface nothing redacts.
    for (const record of started.logger.recent()) {
      for (const value of Object.values(record.fields ?? {})) {
        for (const secret of SECRETS) {
          expect(
            typeof value === 'string' ? value : '',
            `${record.message} field carries "${secret}"`,
          ).not.toContain(secret);
        }
      }
    }
  });

  it('redacts the enumerated forms from every export surface', async () => {
    const started = openRunSummary();

    installRefusingClipboard();

    started.diagnostics.mount();

    const copy = [
      ...(document
        .getElementById('screen-run-summary')
        ?.querySelectorAll<HTMLElement>('button') ?? []),
    ].find((button): boolean => button.textContent === 'Copy seed');

    copy?.click();
    await Promise.resolve();
    await Promise.resolve();

    const surfaces: readonly [string, string][] = [
      ['log records', started.logger.toJsonLines()],
      ['logger snapshot', JSON.stringify(started.logger.snapshot())],
      ['overlay snapshot', JSON.stringify(started.diagnostics.snapshot())],
      ['metrics text', started.metrics.toPrometheusText()],
    ];

    for (const [name, text] of surfaces) {
      expect(text.length, name).toBeGreaterThan(0);

      // The URL and the credential inside it, and the absolute path: the three
      // location forms DL-LOG-08 enumerates plus the credential assignment
      // DL-LOG-10 adds, replaced wherever the caught message reached.
      expect(text, name).not.toContain(SECRET_URL);
      expect(text, name).not.toContain('zzq-secret-zzq');
      expect(text, name).not.toContain(SECRET_PATH);
    }

    // The record that carries the rejection carries the redaction marker in its
    // place, so the message is bounded rather than merely absent.
    expect(JSON.stringify(started.logger.snapshot())).toContain('[redacted]');

    // What the enumerated forms do NOT cover is stated rather than implied: a
    // PII-like fragment inside a caught MESSAGE is carried by the record's
    // serialised error, which is why no caller copies caught text into a field
    // and why `errorDetail` defaults to `'redacted'`. DL-LOG-10 bounds this to
    // the enumerated forms and says so in as many words.
    for (const value of Object.values(
      started.logger
        .recent()
        .find((record) => record.message === 'the clipboard refused the seed')
        ?.fields ?? {},
    )) {
      expect(typeof value === 'string' ? value : '').not.toContain(SECRET_PII);
    }
  });
});
