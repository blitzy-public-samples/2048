// Integration suite for the observability wiring at the composition root,
// Rule 3.
//
// Four composition defects are covered. Every one was a composition defect
// rather than a module defect — the logger, the metrics registry, the tracer,
// the health surface and every reporter adapter were already built and tested:
//
//   the root constructed NEITHER the logger nor the registry. It wrote
//     diagnostics straight to `console` and discarded every count and every
//     timing, so nothing carried a correlation identifier, no counter ever
//     moved, and the diagnostics host stayed empty for the life of the page;
//   the correlation identifier was derived from the seed alone, so every
//     replay of one seed shared it and two runs could not be told apart in a
//     stream — which is the one thing a correlation identifier is for;
//   the tracer had no runtime caller at all, so no span of the input ->
//     engine -> hook bus -> relic handler -> render -> frame chain was ever
//     opened and the diagnostics trace panel had nothing to show;
//   and the health surface was bypassed by a set of booleans assembled at the
//     root, which substituted `input.isListening()` for the pointer-family
//     probe and carried neither the three-state verdict nor the two readiness
//     decisions.
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
import {
  SPAN_ATTRIBUTES,
  SPAN_NAMES,
  SPAN_OUTCOMES,
} from '../../../src/observability/tracer';
import { resetWebGLSupportProbe } from '../../../src/render/webgl-support';
import { BOUNDARY_SPAN_NAMES } from '../../../src/observability/tracer';
import type { TraceSnapshot } from '../../../src/observability/tracer';
import { RELIC_CATALOGUE } from '../../../src/relics/relic-registry';
import { GAME_STATE_KEY } from '../../../src/storage/storage-keys';
import { clearOwnedStorage } from '../../fixtures/storage';

/** The markup `start` looks up, matching index.html's nesting. */
const MARKUP = `
  <main id="game-main">
    <div class="score-container"><span class="visually-hidden">Score</span>0</div>
    <div class="best-container"><span class="visually-hidden">Best score</span>0</div>
    <button type="button" class="restart-button">New Game</button>
    <button type="button" class="settings-button" id="settings-button"
            aria-haspopup="dialog" aria-controls="settings-panel">Settings</button>
    <div class="game-container">
      <div class="game-message">
        <p></p>
        <button type="button" class="keep-playing-button">Keep going</button>
        <button type="button" class="retry-button">Try again</button>
      </div>
      <div class="board-host" id="board-host">
        <canvas class="board-canvas" id="board-canvas" aria-hidden="true"></canvas>
        <div class="board-number-only" id="board-number-only" hidden></div>
        <div class="board-a11y" id="board-a11y" role="grid" aria-busy="true"></div>
      </div>
    </div>
    <div class="on-screen-controls" id="on-screen-controls"></div>
  </main>
  <div class="screen-layer" id="screen-layer">
    <div class="settings-panel" id="settings-panel" role="dialog"
         aria-modal="true" aria-label="Settings" hidden></div>
  </div>
  <div class="diagnostics-overlay" id="diagnostics-overlay" hidden></div>
  <div class="visually-hidden live-region" id="live-region" role="status"
       aria-live="polite" aria-atomic="true"></div>
`;

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
});

const press = (key: string, code: string): void => {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key, code, bubbles: true }),
  );
};

/**
 * Plays one move in every direction.
 *
 * All four, deliberately. The engine returns before emitting `move:after` when a
 * move changed nothing, so a single direction is a bet on where the run's seed
 * happened to place the two starting tiles. Two tiles cannot be blocked on all
 * four sides of a 4x4 board, so playing every direction guarantees at least one
 * real turn, a spawn and a commit — which is what these cases measure.
 */
const playEveryDirection = (): void => {
  press('ArrowDown', 'ArrowDown');
  press('ArrowLeft', 'ArrowLeft');
  press('ArrowUp', 'ArrowUp');
  press('ArrowRight', 'ArrowRight');
};

/**
 * Waits for the render loop to turn over twice.
 *
 * The frame callback runs on `requestAnimationFrame`, the system's only
 * asynchronous boundary, so the frame span and the frame metric cannot be
 * asserted synchronously.
 */
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

/* ==========================================================================
 * The logger is real, and everything reports through it
 * ========================================================================== */

describe('the structured logger is wired', () => {
  it('is exposed by the root, carrying a correlation identifier', () => {
    application = start(document);

    expect(application.logger.correlationId).not.toBe('');
    expect(application.logger.correlationId.startsWith('run-')).toBe(true);
  });

  it('has recorded structured records by the time boot finishes', () => {
    application = start(document);

    const records = application.logger.recent();

    // Console-only writing left nothing to read back. Anything here is the fix.
    expect(records.length).toBeGreaterThan(0);
  });

  it('stamps every record with the one correlation identifier', () => {
    application = start(document);

    const expected = application.logger.correlationId;
    const records = application.logger.recent(100);

    // One identifier for the run: a record that carried its own would make a
    // stream unjoinable, which is the failure mode the single authority exists
    // to prevent.
    for (const record of records) {
      expect(record.correlationId).toBe(expected);
    }
  });

  it('routes a subsystem s reports under that subsystem, not under main', () => {
    application = start(document);

    press('ArrowDown', 'ArrowDown');

    const subsystems = new Set(
      application.logger.recent(200).map((record) => record.subsystem),
    );

    // The sink tags each record with the reporting module's own source, so a
    // stream is filterable by layer rather than being one flat blob.
    expect(subsystems.size).toBeGreaterThan(1);
  });

  it('exports its records as JSON lines', () => {
    application = start(document);

    const lines = application.logger
      .toJsonLines()
      .split('\n')
      .filter((line) => line !== '');

    expect(lines.length).toBeGreaterThan(0);

    // Structured, so each line parses. A console string would not.
    const parsed: unknown = JSON.parse(lines[0]);

    expect(typeof parsed).toBe('object');
    expect((parsed as { correlationId?: unknown }).correlationId).toBe(
      application.logger.correlationId,
    );
  });
});

/* ==========================================================================
 * Counts and timings land in the registry
 * ========================================================================== */

describe('the metrics registry is wired', () => {
  it('is exposed by the root and has non-empty series after boot', () => {
    application = start(document);

    const snapshot = application.metrics.snapshot();

    expect(snapshot.correlationId).toBe(application.logger.correlationId);
    expect(snapshot.series.length).toBeGreaterThan(0);
  });

  it('has counters that actually moved, where every count was discarded before', () => {
    application = start(document);

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
    application = start(document);

    press('ArrowRight', 'ArrowRight');

    const text = application.metrics.toPrometheusText();

    expect(text).toContain('# TYPE');
    expect(text).toContain('game2048_');
  });

  it('names every series in the Prometheus namespace', () => {
    application = start(document);

    press('ArrowUp', 'ArrowUp');

    for (const series of application.metrics.snapshot().series) {
      // A dotted report name would be rejected by a scrape, so the sink
      // normalises it. Anything unnamespaced here means a bypass.
      expect(series.name.startsWith('game2048_')).toBe(true);
      expect(series.name).toMatch(/^[a-zA-Z_:][a-zA-Z0-9_:]*$/);
    }
  });

  it('populates the CANONICAL families a dashboard would be keyed to', () => {
    application = start(document);

    playEveryDirection();

    const value = (name: string): number => {
      const series = application?.metrics
        .snapshot()
        .series.find((candidate) => candidate.name === name);

      return series !== undefined && series.kind === 'counter'
        ? series.value
        : -1;
    };

    // These are the families the registry declares with real help text, and the
    // only names a dashboard or an alert would use. The generic report counters
    // moved all along while every one of these read a flat zero, because they
    // have purpose-built recorders that nothing was calling — so a dashboard
    // would have shown nothing happening while the game was being played.
    expect(value('game2048_turns_total')).toBeGreaterThan(0);
    expect(value('game2048_spawns_total')).toBeGreaterThan(0);
  });

  it('counts rendered frames, the one previously unmeasured boundary', async () => {
    application = start(document);

    // Awaited rather than asserted synchronously: the frame callback runs on
    // `requestAnimationFrame`, which is the system's only asynchronous boundary
    // and the reason this counter needs a turn of the loop to move.
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
    application = start(document);

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

  it('folds the hook bus dispatch counts in when the surface reads', () => {
    application = start(document);

    playEveryDirection();

    // The registry integrates with the bus by PULL, so these stay empty unless
    // something asks the bus for them. The surface asks, before it snapshots.
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
    application = start(document);

    playEveryDirection();

    const snapshot = application.metrics.snapshot();
    const spawns = snapshot.series.find(
      (series) => series.name === 'game2048_spawns_total',
    );
    const attempts = snapshot.series.find(
      (series) => series.name === 'game2048_spawn_attempts_total',
    );

    // The distinction rests on the spawn payload's `position`, which the generic
    // counter cannot express and the purpose-built recorder reads.
    expect(spawns?.kind === 'counter' ? spawns.value : -1).toBeGreaterThan(0);
    expect(attempts?.kind === 'counter' ? attempts.value : -1).toBeGreaterThan(
      0,
    );
  });

  it('keeps the report name as a label rather than in the metric name', () => {
    application = start(document);

    press('ArrowDown', 'ArrowDown');

    const labelled = application.metrics
      .snapshot()
      .series.filter((series) => 'report' in series.labels);

    // Bounded cardinality: the dotted name is a label, and the unbounded detail
    // stays in the log record rather than minting a series per value.
    expect(labelled.length).toBeGreaterThan(0);
  });
});

/* ==========================================================================
 * The diagnostics surface is reachable
 * ========================================================================== */

describe('the diagnostics surface is wired', () => {
  it('is exposed by the root, available and closed', () => {
    application = start(document);

    expect(application.diagnostics.available).toBe(true);
    expect(application.diagnostics.isOpen()).toBe(false);
  });

  it('renders the run, health and metrics panels when opened', () => {
    application = start(document);

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
    application = start(document);
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
    application = start(document);
    application.diagnostics.open();

    const health = application.diagnostics
      .lastSnapshot()
      ?.series.filter((series) => series.name.includes('health_check'));

    expect(health?.length ?? 0).toBeGreaterThan(0);
  });

  it('is emptied and closed by dispose', () => {
    application = start(document);
    application.diagnostics.open();
    application.dispose();
    application = null;

    const host = document.querySelector<HTMLElement>('#diagnostics-overlay');

    expect(host?.hidden).toBe(true);
    expect(host?.textContent).toBe('');
  });
});

/* ==========================================================================
 * The tracer is real, and every module boundary is spanned
 * ========================================================================== */

describe('the tracer is wired', () => {
  it('is exposed by the root, enabled and sharing the correlation ' +
    'identifier', () => {
    application = start(document);

    expect(application.tracer.isEnabled()).toBe(true);
    expect(application.tracer.correlationId).toBe(
      application.logger.correlationId,
    );
  });

  it('opens the turn span the engine emitter drives', () => {
    application = start(document);

    playEveryDirection();

    const names = application.tracer
      .recent()
      .map((record) => record.name);

    expect(names).toContain('engine.turn');
  });

  it('spans the input, move-resolution, hook-dispatch and render-commit ' +
    'boundaries of one turn', () => {
    application = start(document);

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
    application = start(document);

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
    application = start(document);

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

    // THE CHAIN, LINK BY LINK: the input dispatch is the outermost span of a
    // turn, the turn span opens inside it on `move:before`, and the resolution
    // span opens inside the turn around the traversal walk alone. Asserting the
    // resolution's parent to be the input span directly would only hold with the
    // resolution wrapped around `Engine.move()` from out here, which opens it
    // BEFORE `move:before` is emitted and makes the resolution the parent of the
    // turn it is part of.
    expect(input).toBeDefined();
    expect(turn?.parentId).toBe(input?.id);
    expect(resolve?.parentId).toBe(turn?.id);
  });

  it('covers EVERY boundary span validation gate V8 enumerates', async () => {
    application = start(document);

    // A relic on the bus, so the `relic.handler` boundary has a handler to span.
    application.engine.hooks.register({
      id: 'gate-relic',
      hooks: {
        onBeforeMove: (payload) => payload,
      },
    });
    playEveryDirection();
    await awaitFrames();

    const observed = observedSpanNames();

    // THE GATE IS THE LIST, not a sample of it: input, engine turn, move
    // resolution, hook dispatch, relic handler, render commit, frame callback.
    for (const name of BOUNDARY_SPAN_NAMES) {
      expect(observed.has(name)).toBe(true);
    }
  });

  it('reports lifecycle commits rather than counting them as anomalies', () => {
    application = start(document);

    playEveryDirection();
    application.engine.restart();

    const snapshot = application.tracer.snapshot();

    // `setup()`, `restart()` through `setup()` and `endStage()` all commit with
    // no move in flight. Those are lifecycle commits, and reading them as
    // orphaned turn commits is what raised an anomaly for a healthy boot.
    expect(snapshot.lifecycleCommits).toBeGreaterThan(0);
    expect(snapshot.anomalies).toBe(0);

    // THE SAME COMMITS, BROKEN DOWN. Every commit the run made is accounted to
    // one of the three attributions, the turns among them counted separately,
    // and nothing lands in `unattributed`.
    expect(snapshot.commits.lifecycle).toBe(snapshot.lifecycleCommits);
    expect(snapshot.commits.turn).toBeGreaterThan(0);
    expect(snapshot.commits.unattributed).toBe(0);
  });

  it('observes the turn latency of a committed turn', () => {
    application = start(document);

    playEveryDirection();

    const latency = histogramSeries('game2048_turn_latency_milliseconds');

    // Measured from the turn span's own open to the turn's OWN commit, so a
    // stage resolution a commit subscriber triggers afterwards is not counted as
    // turn time. Zero samples here means the turn span never closed on a commit.
    expect(latency?.count ?? 0).toBeGreaterThan(0);
  });

  it('records span durations into the shared histogram family', () => {
    application = start(document);

    playEveryDirection();

    const turns = histogramSeries('game2048_span_duration_milliseconds', {
      key: 'span',
      value: SPAN_NAMES.engineTurn,
    });

    // One sample per closed turn span, whatever each move did: a move the engine
    // refused opens none, and a move that changed nothing is closed by the
    // caller that knows it was idle.
    expect(turns?.count ?? 0).toBeGreaterThan(0);
  });

  it('spans the frame callback, the one asynchronous boundary', async () => {
    application = start(document);

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
    application = start(document);

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
    application = start(document);

    playEveryDirection();

    // `setup()` commits before any move, so that commit belongs to the stage
    // and not to a turn. It is recorded on the still-open stage span, which is
    // why no anomaly is raised and no warning is logged on a page load.
    expect(application.tracer.snapshot(200).anomalies).toBe(0);
    expect(
      application.logger
        .recent()
        .filter((record) => record.subsystem === 'tracer')
        .map((record) => record.message),
    ).toEqual([]);
  });

  it('closes every span it left open when dispose runs', () => {
    application = start(document);

    playEveryDirection();
    application.dispose();

    const held = application.tracer;

    application = null;

    expect(held.activeSpan()).toBeUndefined();
  });
});

/* ==========================================================================
 * The health surface is real, and it is the one the page reports
 * ========================================================================== */

describe('the health surface is wired', () => {
  it('is exposed by the root and reports all six checks', () => {
    application = start(document);

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
    application = start(document);

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
    application = start(document);

    const pointer = application.health
      .report()
      .checks.find((check) => check.id === 'pointerEvents');

    // The bypassed provider reported `input.isListening()` here, which answers
    // a different question. The owning probe reports the resolved family.
    expect(pointer?.source.performedBy).toBe('detectPointerEventFamily');
    expect(pointer?.data['touchstart']).toBeDefined();
  });

  it('carries the two readiness verdicts the renderer and storage decisions ' +
    'rest on', () => {
    application = start(document);

    const readiness = application.health.readiness();

    expect(readiness.renderer).toBe(application.renderer.mode);
    expect(['persistent', 'ephemeral']).toContain(readiness.storage);
    expect(readiness.mayMountWebGLRenderer).toBe(
      readiness.renderer === 'webgl',
    );
  });

  it('logs the readiness verdict during composition', () => {
    application = start(document);

    const messages = application.logger
      .recent()
      .map((record) => record.message);

    expect(messages).toContain('Readiness resolved.');
  });

  it('is the surface the diagnostics health panel reads', () => {
    application = start(document);
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

/* ==========================================================================
 * The frame metric has exactly one writer
 * ========================================================================== */

// `metrics.recordFrame(context.delta)` recorded the gap since the previous
// frame as though it were how long the frame callbacks occupied the frame: the
// first sample is always zero, ordinary 60 Hz cadence reads as over budget, and
// a long pause is clamped. Wiring the tracer's frame hooks without removing
// that call would have double-counted every frame on top.

describe('the frame metric', () => {
  it('is written once per frame, by the tracer alone', async () => {
    application = start(document);

    await awaitFrames();

    const frames = application.tracer.snapshot().frames.frames;

    expect(frames).toBeGreaterThan(0);

    // EXACT parity. Two writers would leave the counter at twice the tracer's
    // frame count, which is the regression this pins.
    expect(counterValue('game2048_frames_rendered_total')).toBe(frames);
    expect(histogramSeries('game2048_frame_time_milliseconds')?.count).toBe(
      frames,
    );
  });

  it('records the measured occupancy rather than the inter-frame gap', async () => {
    application = start(document);

    await awaitFrames();

    const observed = histogramSeries('game2048_frame_time_milliseconds');
    const traced = application.tracer.snapshot().frames;

    // The loop measures how long its own callbacks occupied the frame and hands
    // that value to the tracer, so the histogram's sum is the traced total and
    // not a sum of scheduler gaps.
    expect(observed?.sum).toBeCloseTo(traced.totalFrameMs, 6);
  });

  it('publishes the inter-frame gap under a name of its own', async () => {
    application = start(document);

    await awaitFrames();

    const cadence = histogramSeries('game2048_span_duration_milliseconds', {
      key: 'span',
      value: 'render.frame.interval',
    });

    // Kept, but separated: cadence is a real measurement and losing it would be
    // a regression of its own. It simply is not frame occupancy.
    expect(cadence?.count ?? 0).toBeGreaterThan(0);
  });
});

/* ==========================================================================
 * The correlation identifier identifies a run, not a seed
 * ========================================================================== */

describe('the correlation identifier', () => {
  it('differs between two runs of the application', () => {
    const first = start(document);
    const firstId = first.logger.correlationId;

    first.dispose();

    // The stored run is discarded, so the second composition starts a NEW run
    // rather than resuming this one. Without this the two are the same run and
    // share an identifier by design — which the case below pins.
    clearOwnedStorage();
    document.body.innerHTML = MARKUP;
    resetWebGLSupportProbe();

    const second = start(document);
    const secondId = second.logger.correlationId;

    application = second;

    // Two runs, two identifiers. A seed-only derivation would still differ here
    // because each run mints a fresh seed, so the case two below is the one that
    // actually pins the correction.
    expect(firstId).not.toBe(secondId);
  });

  it('is preserved across a reload that resumes the same run', () => {
    const first = start(document);
    const firstId = first.logger.correlationId;

    // A move, so a commit persists the run: the identifier is read back out of
    // the stored envelope, and an envelope only exists once something committed.
    playEveryDirection();
    first.dispose();

    document.body.innerHTML = MARKUP;
    resetWebGLSupportProbe();

    const second = start(document);

    application = second;

    // The SAME run, continued. `runId` is persisted and the seed is persisted,
    // so both derivation inputs come back unchanged and one run's records carry
    // one identifier however many times the page was loaded. This is the
    // property that makes the identifier worth correlating on at all.
    expect(second.logger.correlationId).toBe(firstId);
    expect(second.run.identity.resumed).toBe(true);
  });

  it('is the run-instance form, longer than the seed-grouping form', () => {
    application = start(document);

    // 18 characters is the seed-grouping form; 26 is the form that appends the
    // run-instance segment. The root must use the latter, or two replays of one
    // seed collapse onto one identifier.
    expect(application.logger.correlationId).toHaveLength(26);
  });

  it('is shared by the logger, the metrics registry and the diagnostics surface', () => {
    application = start(document);
    application.diagnostics.open();

    const expected = application.logger.correlationId;

    expect(application.metrics.snapshot().correlationId).toBe(expected);
    expect(application.diagnostics.lastSnapshot()?.correlationId).toBe(expected);
  });
});

/* ==========================================================================
 * The tracer is constructed, and every module boundary is spanned
 * ========================================================================== */

/**
 * A board where pressing Left changes nothing.
 *
 * One tile, already against the left wall. `Engine.move()` compares positions,
 * finds none changed, counts the turn as idle and RETURNS `false` — emitting no
 * `move:after`, no `state:commit` and nothing else at all. That silence is why
 * the turn span needs a caller to close it, and this fixture is how the case
 * below reaches it deterministically rather than by betting on where a seed put
 * the opening tiles.
 *
 * Written to storage BEFORE `start()`, because the engine reads the snapshot
 * once during setup.
 */
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

/**
 * The tracer's snapshot as the diagnostics surface exports it.
 *
 * Read through `snapshot()` rather than `lastSnapshot()`: the latter is the
 * metrics snapshot the last render was built from, while the former is the
 * four-section export — health, traces, metrics and logs — that
 * docs/dashboards/dashboard.html renders and that carries the trace section at
 * all.
 */
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
    application = start(document);

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
    application = start(document);

    playEveryDirection();

    const taken = traces(application);

    expect(taken.started).toBeGreaterThan(0);
    expect(taken.ended).toBeGreaterThan(0);
  });

  it('spans the INPUT boundary, naming the action', () => {
    application = start(document);

    press('ArrowRight', 'ArrowRight');

    const input = traces(application).spans.filter(
      (record) => record.name === SPAN_NAMES.inputDispatch,
    );

    expect(input.length).toBeGreaterThan(0);

    // ONE OPENER, and it is the manager's own: it reports the event it is
    // dispatching as `input.dispatch.<event>`, and the tracer's span vocabulary
    // is closed, so the event reaches the span as its `action` attribute rather
    // than as a name of its own. A wrapper out here around each subscription
    // would open a SECOND span per key and double the boundary's count.
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
    application = start(document);

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
    application = start(document);

    playEveryDirection();

    expect(spanNames(application)).toContain(SPAN_NAMES.moveResolution);
  });

  it('spans each HOOK DISPATCH, carrying the hook name', () => {
    application = start(document);

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
    application = start(document);

    playEveryDirection();

    expect(spanNames(application)).toContain(SPAN_NAMES.renderCommit);
  });

  it('spans the FRAME CALLBACK, the one asynchronous boundary', async () => {
    application = start(document);

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
    application = start(document);

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

    application = start(document);

    press('ArrowLeft', 'ArrowLeft');

    const taken = traces(application);
    const turns = taken.spans.filter(
      (record) => record.name === SPAN_NAMES.engineTurn,
    );

    // An idle move emits nothing after `move:before`, so an unclosed span would
    // stay open until the next input and record the player's think time as turn
    // latency. The move subscription closes it, because it holds the `false`.
    //
    // `unmoved` rather than `unwound` is the assertion that matters: an unwound
    // turn is one its parent span closed on the way out, which is what happened
    // while the close was made after the input span had already ended.
    expect(turns.length).toBe(1);
    expect(turns[0]?.attributes.outcome).toBe('unmoved');

    // Only the in-flight stage remains open — the turn is accounted for.
    expect(taken.open).toBe(1);
  });

  it('leaves nothing but the in-flight stage open as turns are played', () => {
    application = start(document);

    // One span is open before any input: the STAGE, which runs `stage:start`
    // through `stage:end` and is therefore open for as long as the stage is
    // being played. That is the whole of what may be open between turns.
    const settled = application.tracer.snapshot().open;

    playEveryDirection();
    playEveryDirection();
    playEveryDirection();

    const after = application.tracer.snapshot().open;

    // Every other span the chain opens is closed by the boundary that opened
    // it, so the count never GROWS with the turns played — which is the property
    // that distinguishes an in-flight span from a leak. It may FALL: a stage
    // whose goal is met during these turns closes its own span, and whether
    // twelve moves clear the opening stage is a property of the run's seed.
    expect(settled).toBe(1);
    expect(after).toBeLessThanOrEqual(settled);
  });

  it('records no tracer fault or anomaly over a played run', () => {
    application = start(document);

    playEveryDirection();
    playEveryDirection();

    const taken = traces(application);

    expect(taken.faults).toBe(0);
    expect(taken.doubleEnds).toBe(0);
    expect(taken.outOfOrderEnds).toBe(0);
  });

  it('closes the spans it still held when the application is disposed', () => {
    application = start(document);

    playEveryDirection();

    const tracer = application.tracer;

    application.dispose();
    application = null;

    // Detaching closes the turn and stage spans rather than abandoning them,
    // which is what keeps a disposed application from holding an open span for
    // the life of the document.
    expect(tracer.snapshot().open).toBe(0);
  });

  it('is the same tracer the diagnostics surface reads', () => {
    application = start(document);

    playEveryDirection();

    const direct = application.tracer.snapshot();
    const exported = application.diagnostics.snapshot().traces;

    // One tracer, not one per reader: a second instance would give the panel
    // and the console two disjoint views of the same run.
    expect(exported?.correlationId).toBe(direct.correlationId);
    expect(exported?.started).toBeGreaterThanOrEqual(direct.started);
  });
});

/* ==========================================================================
 * The health surface is constructed, and its verdicts are acted on
 * ========================================================================== */

describe('the health surface is wired', () => {
  it('is exposed by the root, reporting all six checks', () => {
    application = start(document);

    const report = application.health.report();

    // The root used to carry an inline reader that re-expressed four of these
    // as boolean expressions written into the composition body. The surface
    // owns them, so there is one implementation of each check and one place a
    // seventh would be added.
    expect(report.checks).toHaveLength(HEALTH_CHECK_COUNT);
    expect(report.checks.map((check) => check.id)).toEqual([
      ...HEALTH_CHECK_IDS,
    ]);
  });

  it('carries the three-valued status, not a boolean', () => {
    application = start(document);

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
    application = start(document);

    const report = application.health.report();
    const reused = report.checks.filter(
      (check) => check.source.disposition === 'reused',
    );

    // Rule 3 requires the existing checks to be REUSED and what was reused
    // versus added to be documented. Five of the six already ran in the vanilla
    // sources and reported nowhere; only the WebGL check is new.
    expect(reused).toHaveLength(HEALTH_CHECK_COUNT - 1);
    expect(
      report.checks.find((check) => check.id === 'webgl')?.source.disposition,
    ).toBe('added');
  });

  it('resolves the pointer check from the platform, not from the input manager', () => {
    application = start(document);

    const pointer = application.health
      .report()
      .checks.find((check) => check.id === 'pointerEvents');

    // The inline reader used `input.isListening()`, which reports whether the
    // root had bound its listeners — a fact about this composition, not about
    // the platform's pointer capability. The check now names the event family
    // the owning module resolved, and its detail no longer mentions a renderer.
    expect(pointer?.data.resolved).toBe(true);
    expect(pointer?.data.touchstart).toBe('touchstart');
    expect(pointer?.detail).not.toContain('renderer');
    expect(pointer?.source.disposition).toBe('reused');
  });

  it('reuses the storage manager probe rather than probing again', () => {
    application = start(document);

    const storage = application.health
      .report()
      .checks.find((check) => check.id === 'storage');

    // The manager probed once at construction with a write-and-remove round
    // trip; handing it to the surface is what keeps that at one per session.
    expect(storage?.status).toBe('pass');
    expect(storage?.data.strategy).toBe('localStorage');
  });

  it('exposes readiness verdicts, which nothing did before', () => {
    application = start(document);

    const readiness = application.health.readiness();

    expect(readiness.renderer).toBe(application.renderer.mode);
    expect(readiness.storage).toBe('persistent');
    expect(readiness.correlationId).toBe(application.logger.correlationId);
  });

  it('ACTS on the renderer verdict: no context means the number board', () => {
    application = start(document);

    const readiness = application.health.readiness();

    // jsdom implements no rendering context, so the verdict and the board on
    // screen have to agree. Reporting the verdict without acting on it is the
    // state the review found.
    expect(readiness.mayMountWebGLRenderer).toBe(false);
    expect(readiness.requiresNumberOnlyFallback).toBe(true);
    expect(application.renderer.mode).toBe('number-only');
    expect(application.preferences.isNumberOnlyForced()).toBe(true);
  });

  it('counts the readiness verdicts it acted on at boot', () => {
    application = start(document);

    const readiness = application.metrics
      .snapshot()
      .series.filter(
        (series) => series.name === 'game2048_health_readiness',
      );

    // Named `health.readiness` by the root and normalised to a Prometheus-safe
    // series by the sink. A verdict taken and not counted is a verdict nobody
    // can see was acted on.
    expect(readiness.length).toBeGreaterThan(0);
    expect(
      readiness.some(
        (series) => series.kind === 'counter' && series.value > 0,
      ),
    ).toBe(true);
  });

  it('passes the surface itself to diagnostics, so the panel shows readiness', () => {
    application = start(document);
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
    application = start(document);

    const health = application.diagnostics.snapshot().health;

    expect(health.report?.checks).toHaveLength(HEALTH_CHECK_COUNT);
    expect(health.readiness?.renderer).toBe('number-only');
  });

  it('still reports all six probes by name on the panel', () => {
    application = start(document);
    application.diagnostics.open();

    const text = (
      document.querySelector('#diagnostics-overlay')?.textContent ?? ''
    ).replace(/\s+/g, ' ');

    for (const probe of HEALTH_CHECK_IDS) {
      expect(text).toContain(probe);
    }
  });

  it('reports through the one correlation identifier', () => {
    application = start(document);

    expect(application.health.correlationId).toBe(
      application.logger.correlationId,
    );
    expect(application.health.reporterFaults).toBe(0);
  });
});

/* ==========================================================================
 * The tracer is wired
 *
 * Every span name, the engine attachment, the boundary wrappers and the
 * frame-callback seam were reachable ONLY FROM TESTS: the root constructed no
 * tracer at all, so the whole tracing layer was dead code in production and the
 * diagnostics surface was handed no tracer to read.
 * ========================================================================== */

describe('the tracer is wired, at every boundary', () => {
  it('is exposed by the root, keyed to the run correlation identifier', () => {
    application = start(document);

    expect(application.tracer.correlationId).toBe(
      application.logger.correlationId,
    );
    expect(application.tracer.isEnabled()).toBe(true);
  });

  it('opens a stage span when the engine opens its board', () => {
    application = start(document);

    // A stage span stays OPEN for the length of the stage, so it is the open
    // count rather than the completed records that shows it was started.
    // `snapshot().spans` carries only what has ended.
    expect(application.tracer.snapshot().open).toBe(1);

    application.engine.endStage(false);

    expect(
      application.tracer.snapshot().spans.map((span): string => span.name),
    ).toContain(SPAN_NAMES.engineStage);
    expect(application.tracer.snapshot().open).toBe(0);
  });

  it('records a turn span for a move that resolved', () => {
    application = start(document);
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
    application = start(document);
    playEveryDirection();
    playEveryDirection();

    // ONE span stays open — the stage — and no turn does. At least one of those
    // eight attempts moved nothing, and the engine emits no `move:after` for
    // it; `settleTurn()` at the input boundary is what closes it, and without
    // the call the span stayed open until the next attempt superseded it.
    expect(application.tracer.snapshot().open).toBe(1);

    const turns = application.tracer
      .snapshot()
      .spans.filter((span): boolean => span.name === SPAN_NAMES.engineTurn);

    // EVERY ONE of the eight attempts is accounted for, closed rather than left
    // open — which is the leak `settleTurn()` closes. Whether any of the eight
    // was idle depends on where the seed placed the opening tiles, so the
    // 'unmoved' outcome itself is asserted by the tracer's own unit suite; what
    // is asserted here is that no attempt can leak a span regardless.
    expect(turns).toHaveLength(8);

    for (const span of turns) {
      expect(span.attributes[SPAN_ATTRIBUTES.outcome]).not.toBe(
        SPAN_OUTCOMES.superseded,
      );
    }
  });

  it('records an input-boundary span for every key that arrived', () => {
    application = start(document);
    playEveryDirection();

    const names = application.tracer
      .snapshot()
      .spans.map((span): string => span.name);

    expect(names).toContain(SPAN_NAMES.inputDispatch);
  });

  it('reports no anomaly across a whole boot and four moves', () => {
    application = start(document);
    playEveryDirection();

    // Asserted as the MESSAGES rather than the count alone. A count names
    // nothing, and the wiring produced two distinct anomaly families: the
    // non-turn commits four of the engine's five commit paths emit, and a turn
    // span left open across the end of the input span that opened it, which the
    // tracer reports once as an out-of-order end and then again for every
    // attribute and for the second end arriving on the closed span.
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
    // A board with ONE tile in the top-left corner, so `ArrowUp` is a move that
    // changes nothing on every seed. Written before `start()`, which is when
    // the board is read.
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

    application = start(document);
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

    // The idle attempt emits `move:before` and then nothing, so only the caller
    // holding the return value can close the turn span — and it must do so
    // BEFORE the input span it is a child of ends. Records are stored at end,
    // so the child ending first is the child appearing first.
    expect(turnIndex).toBeLessThan(inputIndex);
    expect(spans[turnIndex].parentId).toBe(spans[inputIndex].id);
    expect(spans[turnIndex].attributes[SPAN_ATTRIBUTES.outcome]).toBe(
      SPAN_OUTCOMES.unmoved,
    );
    expect(application.tracer.snapshot().anomalies).toBe(0);
  });

  it('gives the diagnostics surface the tracer to read', () => {
    application = start(document);
    playEveryDirection();

    const traces = application.diagnostics.snapshot().traces;

    // `null` is what the surface reported for the life of the page before.
    expect(traces).not.toBeNull();
    expect(traces?.spans.length).toBeGreaterThan(0);
  });

  it('measures the frame callback, the one asynchronous boundary', () => {
    application = start(document);

    const hooks = application.tracer.frameLifecycleHooks();

    // The loop was constructed WITH these, so the seam is instrumented; driving
    // them here proves the pair the root passed is the pair that records.
    hooks.onFrameBegin(undefined);
    hooks.onFrameEnd(undefined, 8);

    expect(
      application.tracer
        .snapshot()
        .spans.map((span): string => span.name),
    ).toContain(SPAN_NAMES.frameCallback);
  });
});

/* ==========================================================================
 * The health surface is wired
 *
 * `HealthSurface` was never constructed. The root built a boolean-only
 * `{name, healthy}` list instead, which threw away the three-state status, the
 * reused-versus-added provenance, the per-check gauges and every readiness
 * verdict.
 * ========================================================================== */

describe('the health surface is wired, whole', () => {
  it('reports all six checks, not a boolean projection of them', () => {
    application = start(document);

    const report = application.health.report();

    expect(report.checks).toHaveLength(HEALTH_CHECK_COUNT);
    expect(
      report.checks.map((check): string => check.id).sort(),
    ).toEqual([...HEALTH_CHECK_IDS].sort());
  });

  it('carries the three-state status a boolean could not', () => {
    application = start(document);

    for (const check of application.health.report().checks) {
      expect(['pass', 'fail', 'not-applicable']).toContain(check.status);
    }
  });

  it('carries the reused-versus-added provenance of each check', () => {
    application = start(document);

    const dispositions = application.health
      .report()
      .checks.map((check): string => check.source.disposition);

    // Five probes the vanilla sources already performed and discarded, plus the
    // one the Three.js renderer introduced.
    expect(dispositions.filter((value): boolean => value === 'reused'))
      .toHaveLength(HEALTH_CHECK_COUNT - 1);
    expect(dispositions.filter((value): boolean => value === 'added'))
      .toHaveLength(1);
  });

  it('reports readiness verdicts, which had no source at all before', () => {
    application = start(document);

    const readiness = application.health.readiness();

    expect(typeof readiness.ready).toBe('boolean');
    expect(['webgl', 'number-only']).toContain(readiness.renderer);
    expect(['persistent', 'ephemeral']).toContain(readiness.storage);
  });

  it('reuses the WebGL probe result, taking no second context', () => {
    application = start(document);

    const first = application.health.report();
    const second = application.health.report();

    // A second probe would request a second context; the level is held and
    // returned, so two readings agree.
    expect(
      second.checks.find((check) => check.id === 'webgl')?.data['level'],
    ).toBe(first.checks.find((check) => check.id === 'webgl')?.data['level']);
  });

  it('gives the diagnostics surface the report and the readiness', () => {
    application = start(document);

    const health = application.diagnostics.snapshot().health;

    // Both were `null` for the life of the page before, because a probe-view
    // source carries neither.
    expect(health.report).not.toBeNull();
    expect(health.readiness).not.toBeNull();
    expect(health.checks).toHaveLength(HEALTH_CHECK_COUNT);
    expect(health.status).not.toBeNull();
  });

  it('writes a status gauge for every check', () => {
    application = start(document);
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

describe('the relic registry is wired', () => {
  it('is exposed by the root, over the real catalogue', () => {
    application = start(document);

    expect(application.relics.catalogue()).toBe(RELIC_CATALOGUE);
    expect(application.relics.catalogue()).toHaveLength(16);
  });

  it('is registered against the engine s own hook bus', () => {
    application = start(document);

    const picked = application.relics.pickUp(RELIC_CATALOGUE[0].id);

    expect(picked).toBeDefined();

    // THE POINT OF THE BINDING. A relic in the envelope but not on the bus is a
    // relic that never fires.
    expect(
      application.engine.hooks
        .subscribers()
        .map((subscriber): string => subscriber.id),
    ).toContain(RELIC_CATALOGUE[0].id);
  });

  it('is bound to the run controller as its registry port', () => {
    application = start(document);
    application.run.recordRewardOffer([RELIC_CATALOGUE[0].id]);

    const resolution = application.run.resolveReward(RELIC_CATALOGUE[0].id);

    // The controller picked it up THROUGH the registry, which is what puts it
    // on the bus and what the port exists to do.
    expect(resolution.accepted).toBe(true);
    expect(application.relics.ownedIds()).toEqual([RELIC_CATALOGUE[0].id]);
  });

  it('refuses a reward the player was never offered', () => {
    application = start(document);

    const resolution = application.run.resolveReward(RELIC_CATALOGUE[0].id);

    expect(resolution.accepted).toBe(false);
    expect(resolution.refusal).toBe('not-offered');
    expect(application.relics.ownedIds()).toEqual([]);
  });

  it('spends a charge budget through the activation path', () => {
    const started = start(document);

    application = started;

    const charged = RELIC_CATALOGUE.find(
      (relic): boolean => relic.charges !== undefined,
    );

    expect(charged).toBeDefined();

    const id = charged?.id ?? '';

    started.run.recordRewardOffer([id]);
    started.run.resolveReward(id);

    const before = started.relics.find(id)?.charges;
    const outcome = started.run.activateRelic(
      started.engine,
      () => started.streams.snapshotCursors(),
      id,
    );

    // No production path called `consumeCharge` at all, so a charge-limited
    // relic fired for the whole run on a budget that never fell.
    expect(outcome.consumed).toBe(1);
    expect(started.relics.find(id)?.charges).toBe((before ?? 0) - 1);
  });

  it('carries the held relics into every commit', () => {
    application = start(document);
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
    application = start(document);

    // A fresh run adopts no envelope, so the engine opens fresh and seeds its
    // start tiles; the assertion is that the board is playable, which an empty
    // supplied snapshot would have prevented.
    const cells = application.engine
      .serialize()
      .grid.cells.flat()
      .filter((cell): boolean => cell !== null);

    expect(cells).toHaveLength(application.config.startTiles);
  });
});
