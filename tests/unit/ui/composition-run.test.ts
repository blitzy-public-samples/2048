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
    <div class="screen" id="screen-reward" data-screen="reward" role="dialog"
         aria-modal="true" aria-label="Choose a relic" hidden></div>
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

/**
 * A legacy board snapshot carrying the given tiles.
 *
 * `cells` is column-major — `cells[x][y]` — the shape js/grid.js serialised and
 * this build preserves verbatim. Written to storage BEFORE `start()`, because
 * the engine reads the snapshot once during setup.
 */
const boardWithTiles = (
  tiles: readonly { x: number; y: number; value: number }[],
  size = 4,
): unknown => ({
  grid: {
    size,
    cells: Array.from({ length: size }, (_column, x) =>
      Array.from({ length: size }, (_cell, y) => {
        const tile = tiles.find((entry) => entry.x === x && entry.y === y);

        return tile === undefined ? null : { position: { x, y }, value: tile.value };
      }),
    ),
  },
  score: 0,
  over: false,
  won: false,
  keepPlaying: false,
});

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
        // REAL CATALOGUE IDENTIFIERS. The relic registry is composed into the
        // root and is authoritative over the envelope's `relics` member: it
        // restores what the catalogue carries and the next write projects what
        // it restored, so an invented identifier is dropped rather than kept
        // forever as data nothing can dispatch. Both of these are bound to
        // hooks that no-op on an open board, so neither changes the score this
        // stage's goal is measured against.
        relics: [{ id: 'temporal-anchor', charges: 2 }, { id: 'tumbler' }],
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

  it('opens the engine on the ENVELOPE board when only the envelope survives', () => {
    // The two keys are written and cleared together, so this is reachable only
    // by something outside the product removing one of them.
    //
    // THE ENVELOPE'S BOARD IS THE AUTHORITY. `RunController.board()` reports the
    // reconciled board of the envelope it adopted, and the root hands that to
    // `Engine.setup()`, so the engine opens on the board the run saved and reads
    // no storage of its own. The absence of the legacy `gameState` key is
    // therefore irrelevant here, which is the point: the run's board is the run's
    // board whether or not a second copy of it happens to exist.
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
        // A real catalogue identifier, bound to `onMerge` alone, so it survives
        // the registry's restore and fires on nothing the board seeding does.
        relics: [{ id: 'echo-chamber' }],
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
    expect(application.run.relicContext()).toEqual([{ id: 'echo-chamber' }]);

    // The board the envelope carried, restored tile for tile.
    expect(application.engine.serialize().grid).toEqual({
      size: 4,
      cells: [
        [{ position: { x: 0, y: 0 }, value: 2 }, null, null, null],
        [null, null, null, null],
        [null, null, null, null],
        [null, null, null, null],
      ],
    });

    // A restored board seeds no opening tile, so both spawn substreams stand
    // exactly where the envelope left them. Under the superseded dual-authority
    // boot the engine re-read the absent legacy key, found nothing, and dealt two
    // fresh tiles over the board the run had saved.
    expect(application.streams.snapshotCursors()['spawn-value']).toBe(17);
    expect(application.streams.snapshotCursors()['spawn-position']).toBe(23);
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

    // A board that MERGES on the first move, so the score is certainly above
    // zero and `bestScore` is certainly promoted. Without it the case is a bet
    // on the run's seed: four moves over two tiles of unequal value score
    // nothing, no promotion is written, and the key the assertion below expects
    // is legitimately absent.
    window.localStorage.setItem(
      GAME_STATE_KEY,
      JSON.stringify(
        boardWithTiles([
          { x: 0, y: 0, value: 8 },
          { x: 1, y: 0, value: 8 },
        ]),
      ),
    );

    application = start(document);
    press('ArrowLeft', 'ArrowLeft');

    expect(application.engine.score).toBeGreaterThan(0);

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
 * 5. The relic registry and the reward transaction
 * ========================================================================== */

/** One row of a board snapshot, padded to four cells. */
const row = (
  ...tiles: (number | null)[]
): ({ position: { x: number; y: number }; value: number } | null)[] =>
  [0, 1, 2, 3].map((y) => {
    const value = tiles[y];

    return value === undefined || value === null
      ? null
      : { position: { x: 0, y }, value };
  });

/**
 * Stores a board and a run envelope whose stage-0 goal one merge clears.
 *
 * `cells` is indexed `[x][y]`, so a single populated first row puts every tile
 * in column 0. Two eights there merge into the sixteen the default ladder's
 * first goal targets.
 */
const storeNearlyClearedStage = (): void => {
  const board = {
    grid: { size: 4, cells: [row(8, 8), row(), row(), row()] },
    score: 0,
    over: false,
    won: false,
    keepPlaying: false,
  };

  window.localStorage.setItem(GAME_STATE_KEY, JSON.stringify(board));
  window.localStorage.setItem(
    RUN_STATE_KEY,
    JSON.stringify({
      schemaVersion: 1,
      runId: 'reward-run',
      seed: 'reward-seed',
      rngCursor: {
        'spawn-value': 0,
        'spawn-position': 0,
        'relic-draw': 0,
        'rarity-weight': 0,
      },
      stageIndex: 0,
      stageGoal: { kind: 'highest-tile', target: 16 },
      goalProgress: 0.5,
      relics: [],
      board,
    }),
  );
};

/** The reward screen's cards, in the order it drew them. */
const rewardCards = (): { id: string; name: string }[] =>
  [...document.querySelectorAll('#screen-reward .relic-card')].map(
    (card): { id: string; name: string } => ({
      id: card.getAttribute('data-relic-id') ?? '',
      name: card.querySelector('.relic-card-name')?.textContent ?? '',
    }),
  );

describe('the relic registry', () => {
  it('is composed, so the catalogue reaches the hook bus', () => {
    application = start(document);

    // The registry registers with the bus the engine dispatches on, which is
    // what makes a held relic fire. Nothing is held yet, so the assertion is
    // that the seam exists rather than that it has been used.
    expect(application.run.relicContext()).toEqual([]);
    expect(storedRun()?.relics).toEqual([]);
  });

  it('refuses a stored relic the catalogue does not know', () => {
    window.localStorage.setItem(
      RUN_STATE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        runId: 'tampered-run',
        seed: 'tampered-seed',
        rngCursor: {
          'spawn-value': 0,
          'spawn-position': 0,
          'relic-draw': 0,
          'rarity-weight': 0,
        },
        stageIndex: 1,
        stageGoal: { kind: 'highest-tile', target: 32 },
        goalProgress: 0,

        // One real identifier and two the catalogue has never carried.
        relics: [
          { id: 'twin-seed' },
          { id: 'not-a-relic' },
          { id: 'also-invented', charges: 99 },
        ],
        board: {
          grid: { size: 4, cells: [row(2), row(), row(), row()] },
          score: 0,
          over: false,
          won: false,
          keepPlaying: false,
        },
      }),
    );

    application = start(document);

    // Hydration is VALIDATED: an identifier with no catalogue entry can bind no
    // handler, so carrying it would leave the run reporting a relic that does
    // nothing and the draw excluding an identifier that is not held.
    expect(application.run.relicContext()).toEqual([{ id: 'twin-seed' }]);

    // And the normalised set is what is persisted, so the refusal is permanent
    // rather than repeated on every load.
    expect(storedRun()?.relics).toEqual([{ id: 'twin-seed' }]);
  });
});

describe('the reward transaction', () => {
  it('draws three distinct offers onto the reward screen when a stage clears', () => {
    storeNearlyClearedStage();
    application = start(document);

    press('ArrowUp', 'ArrowUp');

    const cards = rewardCards();

    expect(document.getElementById('screen-reward')?.hidden).toBe(false);
    expect(cards).toHaveLength(3);

    // AAP V6: a set of three NEVER holds a duplicate, because the draw samples
    // without replacement.
    expect(new Set(cards.map((card) => card.id)).size).toBe(3);

    // Every card is a real catalogue relic, drawn rather than invented, and
    // carries the name the catalogue gave it.
    for (const card of cards) {
      expect(card.name.length).toBeGreaterThan(0);
    }
  });

  it('is deterministic: one seed draws one offer sequence', () => {
    storeNearlyClearedStage();
    application = start(document);
    press('ArrowUp', 'ArrowUp');

    const first = rewardCards().map((card) => card.id);

    application.dispose();
    application = null;
    document.body.innerHTML = MARKUP;
    resetWebGLSupportProbe();
    clearOwnedStorage();

    storeNearlyClearedStage();
    application = start(document);
    press('ArrowUp', 'ArrowUp');

    expect(rewardCards().map((card) => card.id)).toEqual(first);
    expect(first).toHaveLength(3);
  });

  it('takes the chosen relic on, advances the stage and closes the screen', () => {
    storeNearlyClearedStage();
    application = start(document);
    press('ArrowUp', 'ArrowUp');

    const chosen = rewardCards()[0];

    expect(chosen).toBeDefined();

    const card = document.querySelector<HTMLElement>(
      `#screen-reward .relic-card[data-relic-id="${chosen?.id ?? ''}"]`,
    );

    card?.click();

    // The screen is down, the relic is held, and the run stands on the next
    // stage — one transaction, not three separate effects.
    expect(document.getElementById('screen-reward')?.hidden).toBe(true);
    expect(
      application.run.relicContext().map((relic) => relic.id),
    ).toEqual([chosen?.id]);
    expect(application.run.state().stageIndex).toBe(1);
    expect(storedRun()?.relics.map((relic) => relic.id)).toEqual([chosen?.id]);
  });

  it('accepts the digit binding for the same choice', () => {
    storeNearlyClearedStage();
    application = start(document);
    press('ArrowUp', 'ArrowUp');

    const second = rewardCards()[1];

    // `2` is the second offer's binding in src/input/keymap.ts, and the reward
    // screen holds the input context at `overlay` where that binding is live.
    press('2', 'Digit2');

    expect(
      application.run.relicContext().map((relic) => relic.id),
    ).toEqual([second?.id]);
    expect(document.getElementById('screen-reward')?.hidden).toBe(true);
  });

  it('never offers a relic the run already holds', () => {
    storeNearlyClearedStage();
    application = start(document);
    press('ArrowUp', 'ArrowUp');

    const held = rewardCards()[0]?.id ?? '';

    document
      .querySelector<HTMLElement>(
        `#screen-reward .relic-card[data-relic-id="${held}"]`,
      )
      ?.click();

    // The next stage's own goal is higher, so this drives the board until it
    // clears or the run ends, and asserts on the offer only if one is drawn.
    for (let turn = 0; turn < 60; turn += 1) {
      playEveryDirection();

      const next = rewardCards();

      if (next.length > 0) {
        expect(next.map((card) => card.id)).not.toContain(held);

        return;
      }
    }
  });

  it('gates the next stage behind the choice', () => {
    storeNearlyClearedStage();
    application = start(document);
    press('ArrowUp', 'ArrowUp');

    // The run still stands on the stage that cleared: the choice IS the
    // transition, so the HUD reports stage 0 while the player is being asked to
    // choose a relic for it rather than reporting a stage that has not started.
    expect(application.run.state().stageIndex).toBe(0);
    expect(application.run.isRewardPending()).toBe(true);

    // Moves keep resolving while the offer stands, and the stage does NOT
    // advance until a relic is taken.
    playEveryDirection();

    expect(application.run.state().stageIndex).toBe(0);
    expect(document.getElementById('screen-reward')?.hidden).toBe(false);
  });
});

/* ==========================================================================
 * 6. The new-run path
 * ========================================================================== */

describe('starting a new run', () => {
  it('replaces the seed, the run identifier and the substreams together', () => {
    application = start(document);

    const before = {
      seed: application.run.seed(),
      runId: application.run.runId(),
      correlationId: application.logger.correlationId,
    };

    // Advance the substreams past zero, so a fresh run inheriting them would be
    // observable rather than coincidentally identical.
    playEveryDirection();
    playEveryDirection();

    expect(
      application.streams.snapshotCursors()['spawn-value'],
    ).toBeGreaterThan(0);

    application.startNewRun();

    // EVERY piece of run identity is replaced, not just the board.
    expect(application.run.seed()).not.toBe(before.seed);
    expect(application.run.runId()).not.toBe(before.runId);
    expect(application.run.state().stageIndex).toBe(0);
    expect(application.run.relicContext()).toEqual([]);

    // The substreams were rebuilt at cursor zero from the new seed and then
    // advanced only by the two opening tiles the fresh board took.
    expect(application.streams.seed).toBe(application.run.seed());
    expect(application.streams.snapshotCursors()['spawn-value']).toBe(2);
    expect(application.streams.snapshotCursors()['spawn-position']).toBe(2);
    expect(application.streams.snapshotCursors()['relic-draw']).toBe(0);

    // And the correlation identifier follows the run, so later records are not
    // attributed to the run the page loaded with.
    expect(application.logger.correlationId).not.toBe(before.correlationId);
  });

  it('plays a supplied seed, deterministically', () => {
    application = start(document);
    application.startNewRun('shared-seed');

    const first = application.engine.serialize();

    expect(application.run.seed()).toBe('shared-seed');

    application.startNewRun('shared-seed');

    // One seed, one opening board: the substreams restart at zero rather than
    // continuing, which is what AAP V2 requires of a replay.
    expect(application.engine.serialize()).toEqual(first);
  });

  it('is what the restart control does', () => {
    application = start(document);

    const before = application.run.runId();

    document
      .querySelector<HTMLElement>('.restart-button')
      ?.click();

    // "New Game" ends the run rather than reseeding its board: a run carries a
    // seed, a stage and a relic set, and leaving those in place would make the
    // control continue the run it claims to end.
    expect(application.run.runId()).not.toBe(before);
    expect(application.run.state().stageIndex).toBe(0);
  });

  it('discards the ended run\'s relics and stored envelope', () => {
    storeNearlyClearedStage();
    application = start(document);
    press('ArrowUp', 'ArrowUp');

    document
      .querySelector<HTMLElement>('#screen-reward .relic-card')
      ?.click();

    expect(application.run.relicContext().length).toBe(1);

    application.startNewRun();

    expect(application.run.relicContext()).toEqual([]);
    expect(storedRun()?.relics).toEqual([]);

    // The reward screen cannot be left standing over a run that no longer
    // exists.
    expect(document.getElementById('screen-reward')?.hidden).toBe(true);
    expect(application.run.isRewardPending()).toBe(false);
  });

  it('resumes rather than replaces on a cold load', () => {
    application = start(document);

    const seed = application.run.seed();
    const runId = application.run.runId();

    playEveryDirection();
    application.dispose();
    application = null;
    document.body.innerHTML = MARKUP;
    resetWebGLSupportProbe();

    // A cold load RESUMES: `start()` and `startNewRun()` are separate calls, and
    // only the second one replaces.
    application = start(document);

    expect(application.run.seed()).toBe(seed);
    expect(application.run.runId()).toBe(runId);
  });
});

/* ==========================================================================
 * 7. Disposal
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

/* ==========================================================================
 * 6. One board-load authority
 *
 * `Engine.setup()` called with no argument reads the legacy `gameState` key
 * through its own storage port. Doing that ALONGSIDE the run load is two loads
 * of two different values, and the reconciled board — the one whose edge length
 * was weighed against the configured size and against any board-shrinking relic
 * — loses. These cases pin which load decides, in each of the three states
 * `RunController.board()` distinguishes.
 * ========================================================================== */

describe('the board-load authority', () => {
  /** A one-tile board at the stated size, in the persisted vocabulary. */
  const boardWith = (
    size: number,
    tiles: readonly { x: number; y: number; value: number }[],
  ): unknown => ({
    grid: {
      size,
      cells: Array.from({ length: size }, (_column, x) =>
        Array.from({ length: size }, (_cell, y) => {
          const tile = tiles.find((entry) => entry.x === x && entry.y === y);

          return tile === undefined
            ? null
            : { position: { x, y }, value: tile.value };
        }),
      ),
    },
    score: 0,
    over: false,
    won: false,
    keepPlaying: false,
  });

  const envelopeWith = (board: unknown, relics: unknown[] = []): string =>
    JSON.stringify({
      schemaVersion: 1,
      runId: 'authority-run',
      seed: 'authority-seed',
      rngCursor: {
        'spawn-value': 4,
        'spawn-position': 4,
        'relic-draw': 0,
        'rarity-weight': 0,
      },
      stageIndex: 0,
      stageGoal: { kind: 'highest-tile', target: 64 },
      goalProgress: 0,
      relics,
      board,
    });

  it('opens on the envelope board, not the legacy snapshot, when both exist', () => {
    window.localStorage.setItem(
      RUN_STATE_KEY,
      envelopeWith(boardWith(4, [{ x: 0, y: 0, value: 8 }])),
    );

    // A legacy snapshot that DISAGREES with the envelope, so which load decided
    // is readable from the board itself.
    window.localStorage.setItem(
      GAME_STATE_KEY,
      JSON.stringify(boardWith(4, [{ x: 3, y: 3, value: 1024 }])),
    );

    application = start(document);

    expect(application.run.board()).not.toBeUndefined();
    expect(application.engine.grid.cellContent({ x: 0, y: 0 })?.value).toBe(8);
    expect(application.engine.grid.cellContent({ x: 3, y: 3 })).toBeNull();
  });

  it('reports the reconciled board rather than the stored one', () => {
    // Saved at 4, and a relic declaring the board collapsed to 3. The
    // reconciliation applies the relic size, so the board the engine opens on is
    // 3x3 — and the tile outside it is dropped rather than written past the
    // lattice.
    window.localStorage.setItem(
      RUN_STATE_KEY,
      envelopeWith(
        boardWith(4, [
          { x: 1, y: 1, value: 4 },
          { x: 3, y: 3, value: 16 },
        ]),
        [{ id: 'collapsing-vault', state: { boardSize: 3 } }],
      ),
    );

    application = start(document);

    expect(application.run.board()?.grid.size).toBe(3);
    expect(application.engine.grid.size).toBe(3);
    expect(application.engine.grid.cellContent({ x: 1, y: 1 })?.value).toBe(4);
    expect(application.engine.grid.withinBounds({ x: 3, y: 3 })).toBe(false);
  });

  it('LOADS A LEGACY SAVE when no envelope exists at all', () => {
    // A `gameState` written by the vanilla game, before any run envelope
    // existed. `board()` reports `undefined` — no run-level board — so the
    // engine's own port read is the remaining authority and the save loads.
    window.localStorage.setItem(
      GAME_STATE_KEY,
      JSON.stringify(boardWith(4, [{ x: 2, y: 1, value: 64 }])),
    );

    application = start(document);

    expect(application.run.board()).toBeUndefined();
    expect(application.engine.grid.cellContent({ x: 2, y: 1 })?.value).toBe(64);
  });

  it('opens an empty board when nothing is stored', () => {
    application = start(document);

    expect(application.run.board()).toBeUndefined();

    // Two opening tiles, which is `startTiles` under the default rules.
    let occupied = 0;

    application.engine.grid.eachCell((_x, _y, tile): void => {
      if (tile !== null) {
        occupied += 1;
      }
    });

    expect(occupied).toBe(2);
  });

  it('reports null for a run the controller started fresh, so no save is inherited', () => {
    window.localStorage.setItem(
      GAME_STATE_KEY,
      JSON.stringify(boardWith(4, [{ x: 2, y: 1, value: 64 }])),
    );

    application = start(document);

    application.run.startRun(application.engine, { seed: 'brand-new' });

    expect(application.run.board()).toBeNull();
    expect(application.engine.grid.cellContent({ x: 2, y: 1 })?.value).not.toBe(
      64,
    );
  });
});
