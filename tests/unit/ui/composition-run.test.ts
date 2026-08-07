// Integration suite for the composition root's RUN wiring, AAP R5 and R6.
//
// It sits beside tests/unit/ui/composition-input.test.ts because both drive the
// real `start(document)` in jsdom rather than a module in isolation, and the
// defect this one closes was a composition defect of exactly the same kind: the
// versioned nine-member envelope, its guarded store and the engine's two
// context provider seams all shipped complete, and nothing joined them. The
// runtime persisted the legacy board snapshot alone, handed the engine the
// neutral stage and relic contexts, and rebuilt its substreams from zero on
// every load — so a reload silently restarted the deterministic sequence that
// R5 exists to guarantee.
//
// tests/unit/run/run-controller.test.ts pins the controller itself, over an
// injected store, in both test environments. This suite pins only that the root
// composes it: that the envelope reaches real Web Storage, that the engine reads
// its contexts, that the substreams are resumed from it, and that the two frozen
// keys are untouched by any of it.
//
// The board is drawn by the number-only renderer here, because jsdom implements
// no WebGL context. Nothing in this suite depends on which renderer draws.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from '../../../src/main';
import type { Application } from '../../../src/main';
import { resetWebGLSupportProbe } from '../../../src/render/webgl-support';
import type { RunState } from '../../../src/run/run-state';
import {
  BEST_SCORE_KEY,
  GAME_STATE_KEY,
  RUN_STATE_KEY,
} from '../../../src/storage/storage-keys';
import { clearOwnedStorage } from '../../fixtures/storage';

/** The markup src/main.ts looks up, in the nesting index.html declares it in. */
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
        <div class="lower">
          <button type="button" class="keep-playing-button">Keep going</button>
          <button type="button" class="retry-button">Try again</button>
        </div>
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
  <div class="visually-hidden live-region" id="live-region" role="status"
       aria-live="polite" aria-atomic="true"></div>
  <div class="diagnostics-overlay" id="diagnostics-overlay" hidden></div>
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
  clearOwnedStorage();
});

const press = (key: string, code: string): void => {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key, code, bubbles: true }),
  );
};

/**
 * Plays one move in every direction.
 *
 * A single direction is a bet on the seed: the engine returns before committing
 * when a move changes nothing, and whether any one direction changes a freshly
 * seeded two-tile board depends on where that seed put the two tiles. Two tiles
 * on a 4x4 board cannot be blocked on all four sides, so at least one of these
 * resolves a real turn.
 */
const playEveryDirection = (): void => {
  press('ArrowUp', 'ArrowUp');
  press('ArrowRight', 'ArrowRight');
  press('ArrowDown', 'ArrowDown');
  press('ArrowLeft', 'ArrowLeft');
};

/** The stored envelope, parsed, or `null` when none is stored. */
const storedRun = (): RunState | null => {
  const raw = window.localStorage.getItem(RUN_STATE_KEY);

  return raw === null ? null : (JSON.parse(raw) as RunState);
};

/* ==========================================================================
 * 1. The envelope reaches storage
 * ========================================================================== */

describe('the run envelope', () => {
  it('is written under the namespaced key on the first commit', () => {
    application = start(document);

    const stored = storedRun();

    expect(stored).not.toBeNull();
    expect(RUN_STATE_KEY).not.toBe(GAME_STATE_KEY);
    expect(RUN_STATE_KEY).not.toBe(BEST_SCORE_KEY);

    // All nine members and no others. A tenth would not survive the store's own
    // validation on the way back in.
    expect(Object.keys(stored ?? {}).sort()).toEqual([
      'board',
      'goalProgress',
      'relics',
      'rngCursor',
      'runId',
      'schemaVersion',
      'seed',
      'stageGoal',
      'stageIndex',
    ]);
  });

  it('carries the seed and run identifier the application is playing', () => {
    application = start(document);

    const stored = storedRun();

    expect(stored?.seed).toBe(application.run.seed());
    expect(stored?.runId).toBe(application.run.runId());
    expect(stored?.seed).toBe(application.streams.seed);
  });

  it('records the substream cursors, which is what a resume needs', () => {
    application = start(document);

    // Two starting tiles, so both spawn substreams have already advanced.
    expect(storedRun()?.rngCursor['spawn-value']).toBe(2);
    expect(storedRun()?.rngCursor['spawn-position']).toBe(2);

    playEveryDirection();

    const after = storedRun()?.rngCursor;

    expect(after?.['spawn-value'] ?? 0).toBeGreaterThan(2);
    expect(after).toEqual(application.streams.snapshotCursors());
  });

  it('wraps the same board the engine persisted under gameState', () => {
    application = start(document);
    playEveryDirection();

    const legacy = window.localStorage.getItem(GAME_STATE_KEY);

    expect(legacy).not.toBeNull();

    // The envelope wraps a copy; `gameState` remains the board's home.
    expect(storedRun()?.board).toEqual(JSON.parse(legacy ?? 'null'));
  });
});

/* ==========================================================================
 * 2. The engine reads its contexts from the run
 * ========================================================================== */

describe('the commit contexts', () => {
  it('carries the run stage rather than the neutral default', () => {
    // A stage-3 run, written before `start()` because the envelope is read once
    // during composition.
    window.localStorage.setItem(
      RUN_STATE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        runId: 'stored-run-instance',
        seed: 'stored-run-seed',
        rngCursor: {
          'spawn-value': 9,
          'spawn-position': 9,
          'relic-draw': 1,
          'rarity-weight': 1,
        },
        stageIndex: 3,
        stageGoal: { kind: 'score-threshold', target: 750 },
        goalProgress: 0.25,
        relics: [{ id: 'first-picked', charges: 2 }, { id: 'second-picked' }],
        board: {
          grid: {
            size: 4,
            cells: [
              [{ position: { x: 0, y: 0 }, value: 4 }, null, null, null],
              [null, null, null, null],
              [null, null, null, null],
              [null, null, null, null],
            ],
          },
          score: 180,
          over: false,
          won: false,
          keepPlaying: false,
        },
      }),
    );

    application = start(document);

    const commits: { stageIndex: number; target: number; relics: number }[] = [];

    application.engine.events.on('state:commit', (event): void => {
      commits.push({
        stageIndex: event.stage.stageIndex,
        target: event.stage.goal.target,
        relics: event.relics.length,
      });
    });

    playEveryDirection();

    // `EMPTY_STAGE_CONTEXT` is stage 0 with a zero target and no relics, which
    // is what every commit carried before the controller was composed.
    expect(commits.length).toBeGreaterThan(0);

    for (const commit of commits) {
      expect(commit).toEqual({ stageIndex: 3, target: 750, relics: 2 });
    }
  });

  it('resumes the substreams from the stored cursors', () => {
    const board = {
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
    };

    // BOTH keys, because they hold different things: `gameState` is the board's
    // home and the envelope wraps a copy of it. A resumed run whose board is
    // restored takes no opening spawns.
    window.localStorage.setItem(GAME_STATE_KEY, JSON.stringify(board));
    window.localStorage.setItem(
      RUN_STATE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        runId: 'stored-run-instance',
        seed: 'stored-run-seed',
        rngCursor: {
          'spawn-value': 17,
          'spawn-position': 23,
          'relic-draw': 3,
          'rarity-weight': 5,
        },
        stageIndex: 0,
        stageGoal: { kind: 'highest-tile', target: 16 },
        goalProgress: 0,
        relics: [],
        board,
      }),
    );

    application = start(document);

    // Fast-forwarded, not replayed: the cursors are exactly where the stored
    // envelope left them, so the next spawn is the next draw of the sequence
    // rather than the first.
    expect(application.streams.snapshotCursors()).toEqual({
      'spawn-value': 17,
      'spawn-position': 23,
      'relic-draw': 3,
      'rarity-weight': 5,
    });
    expect(application.streams.seed).toBe('stored-run-seed');
  });

  it('resumes the run and seeds a fresh board when only the envelope survives', () => {
    // The two keys are written and cleared together, so this is reachable only
    // by something outside the product removing one of them. The behaviour is
    // pinned rather than left to chance: the run continues — its seed, its
    // cursors, its stage and its relics — and the engine seeds a board from the
    // cursor position the run had reached, which keeps the sequence unbroken.
    window.localStorage.setItem(
      RUN_STATE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        runId: 'stored-run-instance',
        seed: 'stored-run-seed',
        rngCursor: {
          'spawn-value': 17,
          'spawn-position': 23,
          'relic-draw': 3,
          'rarity-weight': 5,
        },
        stageIndex: 2,
        stageGoal: { kind: 'highest-tile', target: 64 },
        goalProgress: 0,
        relics: [{ id: 'kept' }],
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

    expect(application.run.identity.resumed).toBe(true);
    expect(application.run.state().stageIndex).toBe(2);
    expect(application.run.relicContext()).toEqual([{ id: 'kept' }]);

    // Two opening tiles were seeded, so both spawn substreams advanced by two
    // FROM the resumed position rather than from zero.
    expect(application.streams.snapshotCursors()['spawn-value']).toBe(19);
    expect(application.streams.snapshotCursors()['spawn-position']).toBe(25);
  });
});

/* ==========================================================================
 * 3. Reload continuity
 * ========================================================================== */

describe('reloading the page', () => {
  it('continues the same run rather than starting a new one', () => {
    const first = start(document);
    const seed = first.run.seed();
    const runId = first.run.runId();

    playEveryDirection();

    const cursorsBefore = storedRun()?.rngCursor;

    first.dispose();
    document.body.innerHTML = MARKUP;
    resetWebGLSupportProbe();

    const second = start(document);

    application = second;

    expect(second.run.identity.resumed).toBe(true);
    expect(second.run.seed()).toBe(seed);
    expect(second.run.runId()).toBe(runId);

    // The substreams pick up where the interrupted composition left them, which
    // is the whole reason the cursors are persisted.
    expect(second.streams.snapshotCursors()).toEqual(cursorsBefore);
  });

  it('starts a new run once the stored envelope is gone', () => {
    const first = start(document);
    const seed = first.run.seed();

    first.dispose();
    clearOwnedStorage();
    document.body.innerHTML = MARKUP;
    resetWebGLSupportProbe();

    const second = start(document);

    application = second;

    expect(second.run.identity.resumed).toBe(false);
    expect(second.run.seed()).not.toBe(seed);
    expect(second.streams.snapshotCursors()['spawn-value']).toBe(2);
  });
});

/* ==========================================================================
 * 4. The frozen keys are untouched
 * ========================================================================== */

describe('the frozen persistence contract', () => {
  it('honours a best score written before the upgrade', () => {
    window.localStorage.setItem(BEST_SCORE_KEY, '31337');

    application = start(document);
    playEveryDirection();

    // Still the raw decimal string, still under the unprefixed literal key.
    expect(window.localStorage.getItem(BEST_SCORE_KEY)).toBe('31337');
    expect(document.querySelector('.best-container')?.textContent).toContain(
      '31337',
    );
  });

  it('loads a legacy save that carries a board and no run state', () => {
    window.localStorage.setItem(
      GAME_STATE_KEY,
      JSON.stringify({
        grid: {
          size: 4,
          cells: [
            [{ position: { x: 0, y: 0 }, value: 8 }, null, null, null],
            [{ position: { x: 1, y: 0 }, value: 8 }, null, null, null],
            [null, null, null, null],
            [null, null, null, null],
          ],
        },
        score: 404,
        over: false,
        won: false,
        keepPlaying: false,
      }),
    );

    application = start(document);

    // The board is restored by the engine from `gameState`, exactly as
    // js/game_manager.js restored it, and the run wraps it at stage 0.
    expect(application.engine.serialize().score).toBe(404);
    expect(application.run.state().stageIndex).toBe(0);
    expect(storedRun()?.board.score).toBe(404);
    expect(document.querySelector('.score-container')?.textContent).toContain(
      '404',
    );
  });

  it('leaves no other key of the origin behind', () => {
    window.localStorage.setItem('an-unrelated-key', 'untouched');

    application = start(document);
    playEveryDirection();

    const keys: string[] = [];

    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);

      if (key !== null) {
        keys.push(key);
      }
    }

    expect(keys).toContain('an-unrelated-key');
    expect(window.localStorage.getItem('an-unrelated-key')).toBe('untouched');

    // Exactly the three the product owns, and nothing namespaced beyond them.
    const owned = keys.filter((key) => key !== 'an-unrelated-key').sort();

    expect(owned).toEqual([BEST_SCORE_KEY, GAME_STATE_KEY, RUN_STATE_KEY].sort());

    window.localStorage.removeItem('an-unrelated-key');
  });
});

/* ==========================================================================
 * 5. Disposal
 * ========================================================================== */

describe('disposing the application', () => {
  it('releases the run subscriptions', () => {
    application = start(document);

    const before = storedRun()?.rngCursor['spawn-value'] ?? 0;

    application.dispose();
    application = null;

    // The engine is no longer driven either, so this asserts only that the
    // release itself neither throws nor rewrites the envelope on the way out.
    expect(storedRun()?.rngCursor['spawn-value']).toBe(before);
  });
});
