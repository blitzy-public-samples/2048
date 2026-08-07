// Integration suite for the observability wiring at the composition root,
// Rule 3.
//
// Two defects are covered, and both were composition defects rather than module
// defects — the logger, the metrics registry and every reporter adapter were
// already built and tested:
//
//   the root constructed NEITHER the logger nor the registry. It wrote
//     diagnostics straight to `console` and discarded every count and every
//     timing, so nothing carried a correlation identifier, no counter ever
//     moved, and the diagnostics host stayed empty for the life of the page;
//   and the correlation identifier was derived from the seed alone, so every
//     replay of one seed shared it and two runs could not be told apart in a
//     stream — which is the one thing a correlation identifier is for.
//
// These cases therefore drive the REAL `start(document)` and assert on what
// actually reached the sinks, not that a constructor was called.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from '../../../src/main';
import type { Application } from '../../../src/main';
import { resetWebGLSupportProbe } from '../../../src/render/webgl-support';
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
