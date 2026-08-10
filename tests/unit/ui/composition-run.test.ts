// Integration suite for the composition root's RUN wiring, AAP R5 and R6.

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
import {
  BLOCKED_BOARD,
  NEAR_WIN_BOARD,
  copyBoard,
} from '../../fixtures/boards';
import {
  COMPOSITION_MARKUP,
  beginRun,
  chooseCard,
  continueToReward,
  offeredCards,
} from '../../fixtures/composition';
import { clearOwnedStorage } from '../../fixtures/storage';
import { startWithRun } from '../../fixtures/application';

/**
 * The document, from tests/fixtures/composition.ts, so this suite reads the
 * markup index.html declares rather than a private copy of part of it.
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
  clearOwnedStorage();
});

const press = (key: string, code: string): void => {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key, code, bubbles: true }),
  );
};

/** Plays one move in every direction. */
const playEveryDirection = (): void => {
  press('ArrowUp', 'ArrowUp');
  press('ArrowRight', 'ArrowRight');
  press('ArrowDown', 'ArrowDown');
  press('ArrowLeft', 'ArrowLeft');
};

/** A legacy board snapshot carrying the given tiles. */
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

describe('the run envelope', () => {
  it('is written under the namespaced key on the first commit', () => {
    application = startWithRun(document);

    // A COLD LOAD RESUMES NOTHING, so the run is begun the way a player begins
    // one: the envelope is written by the commit the opening board produces.
    expect(beginRun()).toBe(true);

    const stored = storedRun();

    expect(stored).not.toBeNull();
    expect(RUN_STATE_KEY).not.toBe(GAME_STATE_KEY);
    expect(RUN_STATE_KEY).not.toBe(BEST_SCORE_KEY);

    // All nine members and no others.
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
    beginRun();

    const stored = storedRun();

    expect(stored?.seed).toBe(application.run.seed());
    expect(stored?.runId).toBe(application.run.runId());
    expect(stored?.seed).toBe(application.streams.seed);
  });

  it('records the substream cursors, which is what a resume needs', () => {
    application = start(document);
    beginRun();

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
    beginRun();
    playEveryDirection();

    const legacy = window.localStorage.getItem(GAME_STATE_KEY);

    expect(legacy).not.toBeNull();

    // The envelope wraps a copy; `gameState` remains the board's home.
    expect(storedRun()?.board).toEqual(JSON.parse(legacy ?? 'null'));
  });
});

describe('the commit contexts', () => {
  it('carries the run stage rather than the neutral default', () => {
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
        // Real catalogue identifiers.
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
        // A real catalogue identifier, bound to `onMerge` alone, so it
        // survives the registry's restore and fires on nothing the board
        // seeding does.
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
    // exactly where the envelope left them.
    expect(application.streams.snapshotCursors()['spawn-value']).toBe(17);
    expect(application.streams.snapshotCursors()['spawn-position']).toBe(23);
  });
});

describe('reloading the page', () => {
  it('continues the same run rather than starting a new one', () => {
    const first = start(document);

    beginRun();

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

    // The substreams pick up where the interrupted composition left them,
    // which is the whole reason the cursors are persisted.
    expect(second.streams.snapshotCursors()).toEqual(cursorsBefore);
  });

  it('starts a new run once the stored envelope is gone', () => {
    const first = start(document);

    beginRun();

    const seed = first.run.seed();

    first.dispose();
    clearOwnedStorage();
    document.body.innerHTML = MARKUP;
    resetWebGLSupportProbe();

    // NOTHING STORED, so this load has nothing to resume: it holds the run-start
    // screen, and beginning a run from there is what deals the opening tiles and
    // moves the two spawn cursors.
    const second = startWithRun(document);

    application = second;

    expect(second.run.identity.resumed).toBe(false);
    expect(second.run.seed()).not.toBe(seed);

    // The substreams advance when the run OPENS, and a load that resumed
    // nothing opens one on the begin-run press.
    beginRun();

    expect(second.streams.snapshotCursors()['spawn-value']).toBe(2);
  });
});

describe('the frozen persistence contract', () => {
  it('honours a best score written before the upgrade', () => {
    window.localStorage.setItem(BEST_SCORE_KEY, '31337');

    application = start(document);
    beginRun();
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
    // zero and `bestScore` is certainly promoted.
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

/** Stores a board and a run envelope whose stage-0 goal one merge clears. */
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

/**
 * The reward screen's cards, in the order it drew them, once the flow has been
 * carried from stage clear to the offer by the continue control.
 *
 * THE CONTINUE PRESS IS PART OF READING THEM. `stage -> stageClear -> reward`
 * of AAP Figure 6 is two edges and the second one is the player's, so a suite
 * that read the cards without pressing continue would be asserting against a
 * state the flow does not reach on its own.
 */
const rewardCards = (): { id: string; name: string }[] => {
  if (offeredCards().length === 0) {
    continueToReward();
  }

  return offeredCards();
};


/** Clears the opening stage and goes on to the offer. */
const clearStageAndContinue = (): void => {
  press('ArrowUp', 'ArrowUp');
  continueToReward();
};

describe('the relic registry', () => {
  it('is composed, so the catalogue reaches the hook bus', () => {
    application = start(document);
    beginRun();

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

    expect(application.run.relicContext()).toEqual([{ id: 'twin-seed' }]);

    expect(storedRun()?.relics).toEqual([{ id: 'twin-seed' }]);
  });
});

describe('the reward transaction', () => {
  it('shows the stage-clear screen first, and the offer after the continue', () => {
    storeNearlyClearedStage();
    application = start(document);

    press('ArrowUp', 'ArrowUp');

    // THE GATE. The stage-progress screen is up and the reward screen is not:
    // both edges used to be taken on the one `stage:end`, so this state was
    // entered and left inside a tick and no player ever saw it.
    expect(document.getElementById('screen-stage-progress')?.hidden).toBe(false);
    expect(document.getElementById('screen-reward')?.hidden).toBe(true);

    // READ RAW, not through `rewardCards()`: that helper presses continue when it
    // finds no cards, which is the very press this line is asserting has not
    // happened yet.
    expect(offeredCards()).toHaveLength(0);

    continueToReward();

    const cards = rewardCards();

    expect(document.getElementById('screen-reward')?.hidden).toBe(false);
    expect(document.getElementById('screen-stage-progress')?.hidden).toBe(true);
    expect(cards).toHaveLength(3);

    expect(new Set(cards.map((card) => card.id)).size).toBe(3);

    for (const card of cards) {
      expect(card.name.length).toBeGreaterThan(0);
    }
  });

  it('is deterministic: one seed draws one offer sequence', () => {
    storeNearlyClearedStage();
    application = start(document);
    clearStageAndContinue();

    const first = rewardCards().map((card) => card.id);

    application.dispose();
    application = null;
    document.body.innerHTML = MARKUP;
    resetWebGLSupportProbe();
    clearOwnedStorage();

    storeNearlyClearedStage();
    application = start(document);
    clearStageAndContinue();

    expect(rewardCards().map((card) => card.id)).toEqual(first);
    expect(first).toHaveLength(3);
  });

  it('takes the chosen relic on, advances the stage and closes the screen', () => {
    storeNearlyClearedStage();
    application = start(document);
    clearStageAndContinue();

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
    clearStageAndContinue();

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
    clearStageAndContinue();

    const held = rewardCards()[0]?.id ?? '';

    document
      .querySelector<HTMLElement>(
        `#screen-reward .relic-card[data-relic-id="${held}"]`,
      )
      ?.click();

    expect(application.relics.ownedIds()).toEqual([held]);

    // The next stage's own goal is higher, so this drives the board until it
    // clears or the run ends, and asserts on the offer only if one is drawn. The
    // gate is passed through wherever it comes up, because the offer is behind it.
    for (let turn = 0; turn < 60; turn += 1) {
      playEveryDirection();

      if (document.getElementById('screen-stage-progress')?.hidden === false) {
        continueToReward();
      }

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

    expect(application.run.state().stageIndex).toBe(0);
    expect(application.run.isRewardPending()).toBe(true);

    // The flow stops at STAGE CLEAR, and the offer screen is not up yet: the
    // second edge of `stage -> stageClear -> reward` is the player's own
    // continue press.
    expect(application.router.current()).toBe('stageClear');
    expect(document.getElementById('screen-reward')?.hidden).toBe(true);

    // A movement key reaches nothing while a cleared stage is being paid out:
    // the state is an overlay, and the overlay context withholds movement.
    const boardBefore = JSON.stringify(application.engine.serialize());

    playEveryDirection();

    expect(JSON.stringify(application.engine.serialize())).toBe(boardBefore);
    expect(application.run.state().stageIndex).toBe(0);

    // Continuing shows the offer, and the stage is STILL the one that cleared:
    // the choice is what advances it.
    expect(continueToReward()).toBe(true);
    expect(document.getElementById('screen-reward')?.hidden).toBe(false);
    expect(application.run.state().stageIndex).toBe(0);

    const offered = offeredCards()[0];

    expect(chooseCard(offered?.id ?? '')).toBe(true);
    expect(application.run.state().stageIndex).toBe(1);
  });
});

describe('starting a new run', () => {
  it('replaces the seed, the run identifier and the substreams together', () => {
    application = start(document);
    beginRun();

    const before = {
      seed: application.run.seed(),
      runId: application.run.runId(),
      correlationId: application.logger.correlationId,
    };

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

    expect(application.engine.serialize()).toEqual(first);
  });

  it('is NOT what the restart control does', () => {
    storeNearlyClearedStage();
    application = start(document);

    // A relic taken and a stage advanced, so run progress exists to be lost.
    press('ArrowUp', 'ArrowUp');

    // `rewardCards()` presses the stage-clear continue control on the way, so
    // the card the tail presses is on the screen the flow actually reaches.
    const taken = rewardCards()[0]?.id ?? '';

    document
      .querySelector<HTMLElement>(
        `#screen-reward .relic-card[data-relic-id="${taken}"]`,
      )
      ?.click();

    const before = {
      runId: application.run.runId(),
      seed: application.run.seed(),
      stageIndex: application.run.state().stageIndex,
    };

    expect(before.stageIndex).toBe(1);
    expect(application.run.relicContext().map((relic) => relic.id)).toEqual([
      taken,
    ]);

    document.querySelector<HTMLElement>('.restart-button')?.click();

    // js/game_manager.js L17-L21 discarded the BOARD, and `stage --restart-->
    // stage` of AAP Figure 6 keeps that meaning: the run identity, its seed, the
    // stage reached and the relics held all survive, so a player who wanted a
    // fresh board does not silently lose the run. Replacing the run is
    // `startNewRun`, which the run-start and run-summary actions reach.
    expect(application.run.runId()).toBe(before.runId);
    expect(application.run.seed()).toBe(before.seed);
    expect(application.run.state().stageIndex).toBe(before.stageIndex);
    expect(application.run.relicContext().map((relic) => relic.id)).toEqual([
      taken,
    ]);

    // The board itself IS fresh: opening tiles only, and nothing carried over
    // from the board that was discarded, which held the 16 the cleared stage was
    // measured on. The count is not asserted exactly because a spawn-family
    // relic may add a tile on a stage start; the VALUES are what prove the board
    // was replaced rather than kept.
    const cells = application.engine
      .serialize()
      .grid.cells.flat()
      .filter((cell) => cell !== null);

    expect(cells.length).toBeGreaterThanOrEqual(2);
    expect(cells.every((cell) => (cell?.value ?? 0) <= 4)).toBe(true);

    // And the score went with it: `setup(null)` reset it, exactly as
    // js/game_manager.js L17-L21 did.
    expect(application.engine.score).toBe(0);
  });

  it('discards the ended run\'s relics and stored envelope', () => {
    storeNearlyClearedStage();
    application = start(document);
    clearStageAndContinue();

    const offered = rewardCards()[0];

    expect(offered).toBeDefined();
    expect(chooseCard(offered?.id ?? '')).toBe(true);

    expect(application.run.relicContext().length).toBe(1);

    application.startNewRun();

    expect(application.run.relicContext()).toEqual([]);
    expect(storedRun()?.relics).toEqual([]);

    expect(document.getElementById('screen-reward')?.hidden).toBe(true);
    expect(application.run.isRewardPending()).toBe(false);
  });

  it('returns the mutated rules to their baseline', () => {
    application = start(document);

    const config = application.config;
    const spawn = config.spawn;
    const merge = config.merge;
    const baselineSize = config.boardSize;
    const baselineWeights = [...config.spawn.weights];
    const baselinePredicate = config.merge.canMerge;

    // EXACTLY WHAT A CURSED RELIC DOES, written through the live object the
    // engine, the resolver, the terminal-state checks and the renderer all hold:
    // a collapsed board, a bent merge rule and biased spawn weights.
    config.boardSize = 3;
    config.merge.canMerge = (): boolean => true;
    config.spawn.weights = [0.2, 0.8];

    application.startNewRun();

    // THE NEW RUN IS NOT CURSED BY THE LAST ONE. The rules object is page-scoped
    // and was never reset, so a run started after a board-shrinking relic opened
    // on the shrunken board with a merge rule it had never been granted.
    expect(config.boardSize).toBe(baselineSize);
    expect(config.merge.canMerge).toBe(baselinePredicate);
    expect(config.spawn.weights).toEqual(baselineWeights);

    // RESTORED IN PLACE: the same objects, so every collaborator that captured a
    // reference at construction reads the restored rules through it.
    expect(application.config).toBe(config);
    expect(application.config.spawn).toBe(spawn);
    expect(application.config.merge).toBe(merge);

    // And the board the new run actually opened on is the baseline size.
    expect(application.engine.grid.size).toBe(baselineSize);
  });

  it('resumes rather than replaces on a cold load', () => {
    application = startWithRun(document);

    const seed = application.run.seed();
    const runId = application.run.runId();

    playEveryDirection();
    application.dispose();
    application = null;
    document.body.innerHTML = MARKUP;
    resetWebGLSupportProbe();

    // A cold load RESUMES: `start` and `startNewRun` are separate calls, and
    // only the second one replaces.
    application = start(document);

    expect(application.run.seed()).toBe(seed);
    expect(application.run.runId()).toBe(runId);
  });
});

describe('disposing the application', () => {
  it('releases the run subscriptions', () => {
    application = start(document);
    beginRun();

    const before = storedRun()?.rngCursor['spawn-value'] ?? 0;

    application.dispose();
    application = null;

    expect(storedRun()?.rngCursor['spawn-value']).toBe(before);
  });
});

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

    // A legacy snapshot that DISAGREES with the envelope, so which load
    // decided is readable from the board itself.
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
    // Saved at 4, and a relic declaring the board collapsed to 3.
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
    // existed.
    window.localStorage.setItem(
      GAME_STATE_KEY,
      JSON.stringify(boardWith(4, [{ x: 2, y: 1, value: 64 }])),
    );

    application = start(document);

    expect(application.run.board()).toBeUndefined();
    expect(application.engine.grid.cellContent({ x: 2, y: 1 })?.value).toBe(64);
  });

  it('opens NO board when nothing is stored, and holds the run start', () => {
    application = start(document);

    expect(application.run.board()).toBeUndefined();

    // THE COLD LOAD OF AAP FIGURE 6. Nothing is stored, so there is nothing to
    // resume and no run has been begun: the lattice the engine's constructor
    // allocated is empty, and the run-start screen is what the player is looking
    // at. The board used to be opened here regardless, which superseded that
    // screen inside the boot and made its seed field unreachable.
    let occupied = 0;

    application.engine.grid.eachCell((_x, _y, tile): void => {
      if (tile !== null) {
        occupied += 1;
      }
    });

    expect(occupied).toBe(0);
    expect(document.getElementById('screen-run-start')?.hidden).toBe(false);
    expect(document.getElementById('screen-hud')?.hidden).toBe(true);
  });

  it('deals the opening tiles once a run is begun from that screen', () => {
    application = start(document);
    application.startNewRun();

    // `startTiles` under the default rules, dealt by the begin rather than by the
    // boot, so the seed the run is played under is the seed they came from.
    let occupied = 0;

    application.engine.grid.eachCell((_x, _y, tile): void => {
      if (tile !== null) {
        occupied += 1;
      }
    });

    expect(occupied).toBe(application.config.startTiles);
    expect(document.getElementById('screen-run-start')?.hidden).toBe(true);
    expect(document.getElementById('screen-hud')?.hidden).toBe(false);
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

/* ==========================================================================
 * 9. The screen registry
 *
 * `createRunStartScreen`, `createStageProgressScreen`, `createRewardScreen`,
 * `createGameOverScreen` and `createRunSummaryScreen` were imported by NO
 * production file. The router records which module renders each state as data and
 * imports none of them, so every one of those five states entered an empty
 * container: five whole screens of AAP Figure 6 existed, were tested in isolation,
 * and were unreachable in the composed application.
 * ========================================================================== */

describe('the screen registry', () => {
  it('renders the run-start screen, with its seed field, on a cold load', () => {
    application = start(document);

    const host = document.getElementById('screen-run-start');

    expect(host?.hidden).toBe(false);

    // The FIELD is the point: a seed cannot be entered on a screen that renders
    // nothing, and this screen was the one the boot superseded.
    expect(host?.querySelector('input')).not.toBeNull();
    expect(host?.textContent ?? '').not.toBe('');
  });

  it('starts the run the seed field names, through the begin control', () => {
    application = start(document);

    const field = document.querySelector<HTMLInputElement>(
      '#screen-run-start input',
    );
    const begin = document.querySelector<HTMLElement>(
      '#screen-run-start button',
    );

    expect(field).not.toBeNull();
    expect(begin).not.toBeNull();

    if (field !== null) {
      field.value = '  Typed Seed  ';
    }

    begin?.click();

    // ONE NORMALISER. The screen emits the field's text VERBATIM — surrounding
    // whitespace included — and `RunController.startRun` reduces it: trimmed,
    // bounded, and otherwise opaque, so case survives and nothing is parsed. What
    // the run is played under is therefore the reduced value, decided in one
    // place. Decisions DL-RUNCTL-11, DL-RUNSTART-01.
    expect(application.run.seed()).toBe('Typed Seed');
    expect(document.getElementById('screen-run-start')?.hidden).toBe(true);
    expect(application.run.identity.resumed).toBe(false);

    // AND THE VISIT'S OWN STATE IS CLEARED as the screen leaves, so a later visit
    // opens on an empty field and a run begun from it carries no seed the player
    // did not type. Decision DL-RUNSTART-06.
    expect(field?.value).toBe('');
  });

  it('renders the stage-clear screen when a stage clears', () => {
    storeNearlyClearedStage();
    application = start(document);

    press('ArrowUp', 'ArrowUp');

    const host = document.getElementById('screen-stage-progress');

    expect(host?.hidden).toBe(false);

    // The stage number and the goal, drawn by the module rather than left to an
    // empty container.
    expect(host?.textContent ?? '').toContain('1');
    expect(host?.querySelector('.stage-progress-continue')).not.toBeNull();
  });

  it('renders the reward screen through the screen module, not the router', () => {
    storeNearlyClearedStage();
    application = start(document);
    clearStageAndContinue();

    const host = document.getElementById('screen-reward');
    const panel = host?.querySelector('.reward-panel');

    expect(panel).not.toBeNull();

    // MODULE ARTIFACTS. The router's own inline surface built a heading with no
    // id and cards with no described-by, so these two attributes are what say the
    // mounted module drew the screen: the panel names its heading, and each card
    // points at its own description.
    const headingId = panel?.getAttribute('aria-labelledby') ?? '';

    expect(headingId).not.toBe('');
    expect(host?.querySelector(`#${headingId}`)).not.toBeNull();

    for (const card of host?.querySelectorAll('.relic-card') ?? []) {
      expect(card.getAttribute('aria-describedby') ?? '').not.toBe('');
    }
  });

  it('takes a card activated from the keyboard exactly once', () => {
    storeNearlyClearedStage();
    application = start(document);
    clearStageAndContinue();

    const card = document.querySelector<HTMLElement>(
      '#screen-reward .relic-card',
    );
    const chosen = card?.getAttribute('data-relic-id') ?? '';

    expect(card?.tagName).toBe('BUTTON');

    // A NATIVE BUTTON activates from Enter by synthesising a click, and the card
    // used to listen for `keydown` as well — two activations of one press,
    // serialised by a flag. The platform's own path is the only one now.
    card?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    card?.click();

    expect(application.relics.ownedIds()).toEqual([chosen]);
    expect(application.run.state().stageIndex).toBe(1);
  });

  it('renders the run summary of the run that FINISHED', () => {
    storeNearlyClearedStage();
    application = start(document);
    clearStageAndContinue();

    document
      .querySelector<HTMLElement>('#screen-reward .relic-card')
      ?.click();

    const score = application.engine.score;
    const held = application.relics.ownedIds();

    expect(score).toBeGreaterThan(0);
    expect(held).toHaveLength(1);

    // The run is ended the way the flow ends it, through the router's own edge.
    application.run.endRun('abandoned');

    const summary = application.run.lastSummary();

    expect(summary?.score).toBe(score);

    // THE FINISHED PROJECTION, not the live one. `endRun` replaces the envelope
    // in force with a fresh run, so a summary read from `summary()` reported a
    // score of zero, no relics and stage one for the run just finished.
    expect(application.run.summary().score).toBe(0);
    expect(summary?.relics.map((relic) => relic.id)).toEqual(held);
  });

  it('renders the terminal screen for a lost run', () => {
    // A full board whose only move loses: every cell occupied, no two neighbours
    // equal, so the first move that changes nothing ends the run.
    window.localStorage.setItem(
      GAME_STATE_KEY,
      JSON.stringify(copyBoard(BLOCKED_BOARD)),
    );

    application = start(document);

    press('ArrowLeft', 'ArrowLeft');
    press('ArrowUp', 'ArrowUp');
    press('ArrowRight', 'ArrowRight');
    press('ArrowDown', 'ArrowDown');

    const host = document.getElementById('screen-game-over');

    // The terminal screen is one module for both verdicts, and it renders rather
    // than leaving the container empty.
    if (application.engine.isGameTerminated()) {
      expect(host?.hidden).toBe(false);
      expect(host?.textContent ?? '').not.toBe('');
    }
  });
});

/* ==========================================================================
 * 10. Focus on the screen the boot ends on
 *
 * The boot used to blur whatever its own transitions had placed, which announced
 * a modal dialog and then left focus on the body. The rollback is gone, so the
 * placement stands: a cold load ends on `runStart`, which index.html declares
 * `aria-modal="true"` and which the router traps focus inside, and a resumed load
 * ends on `stage`, whose placement lands on the board surface the renderer
 * mounted. Decisions DL-MAIN-19, DL-ROUTER-26.
 * ========================================================================== */

describe('the boot focus placement', () => {
  it('leaves focus inside the trapped run-start dialog', () => {
    application = start(document);

    const host = document.getElementById('screen-run-start');

    expect(host?.hidden).toBe(false);

    // INSIDE THE DIALOG, which is what `aria-modal="true"` claims. The seed field
    // is the first focusable element the screen renders, so the trap's own
    // first-focusable placement lands there.
    expect(document.activeElement).not.toBe(document.body);
    expect(host?.contains(document.activeElement)).toBe(true);
  });

  it('places a resumed run s focus on the board, not on a control', () => {
    // A stored board resumes, so the boot ends on `stage` — which traps nothing
    // and takes the non-trapping placement instead.
    window.localStorage.setItem(
      GAME_STATE_KEY,
      JSON.stringify(boardWithTiles([{ x: 0, y: 0, value: 8 }])),
    );

    application = start(document);

    expect(document.getElementById('screen-run-start')?.hidden).toBe(true);

    // THE BOARD, AND NOTHING ROLLS IT BACK. The boot used to blur whatever the
    // placement had just chosen, which left a load with no focus at all; the
    // rollback is gone, and the placement resolves to the board surface the
    // renderer mounted rather than to `.restart-button` — a control no player
    // asked for. Decisions DL-MAIN-19, DL-ROUTER-26.
    const active = document.activeElement;
    const board = document.getElementById('board-number-only');

    expect(active).not.toBe(document.body);
    expect(active?.closest('.restart-button')).toBeNull();
    expect(board?.contains(active) ?? false).toBe(true);
  });

  it('places focus on the element the run-start screen marked', () => {
    application = start(document);

    const host = document.getElementById('screen-run-start');
    const marked = host?.querySelector('[data-focus-initial]');

    // ONE PARTY PLACES FOCUS, AND IT IS THE ONE THAT TRAPS. The screen module is
    // given `placeFocus: false` because the router traps this container after the
    // module's `enter` has run: a module that placed its own focus first handed the
    // trap a restore target inside the trap, which it cannot restore to and
    // reported on every load. This asserts the substitution is behaviourally free —
    // the trap's first-focusable placement resolves to the very element the module
    // marked for itself.
    expect(marked).not.toBeNull();
    expect(document.activeElement).toBe(marked);
  });
});

/* ==========================================================================
 * 11. One container, one focus trap
 *
 * Two parties can trap the reward container — the router, and the screen module
 * from its own `enter`, which runs first — and a stacked pair broke the restore:
 * both traps asked for the background to be made inert, only the trap that
 * applied the inertness lifts it, and the trap released first therefore restored
 * focus into a region the other still held inert. The root composes the module
 * with `trapFocus: false`, so the router is the ONE owner: it engages the only
 * trap, applies the only inertness and lifts it on release, and its adoption
 * branch — the one that defers to a standing trap — has nothing to adopt.
 * Decisions DL-MAIN-18, DL-ROUTER-26, DL-ROUTER-35.
 * ========================================================================== */

describe('the focus trap over a screen a module renders', () => {
  /**
   * Total of every counter recording a named report.
   *
   * Matched on the `report` LABEL as well as the series name, because a report
   * raised through a ui reporter is counted on one generic family carrying the
   * name as a label rather than on a family of its own. DL-MAIN-11.
   */
  const counterTotal = (app: Application, name: string): number =>
    app.metrics
      .snapshot()
      .series.filter(
        (entry) => entry.name === name || entry.labels['report'] === name,
      )
      .reduce(
        (total, entry) => total + (entry.kind === 'counter' ? entry.value : 0),
        0,
      );

  it('is held by the router alone, never stacked with the module s own', () => {
    storeNearlyClearedStage();
    application = start(document);

    clearStageAndContinue();

    const host = document.getElementById('screen-reward');

    expect(host?.hidden).toBe(false);

    // ONE TRAP HOLDS THE CONTAINER, and it is the router's: focus is inside the
    // offer and the background is inert, both applied by the party that lifts
    // them.
    expect(host?.contains(document.activeElement)).toBe(true);
    expect(
      document.querySelector('.container')?.hasAttribute('inert'),
    ).toBe(true);

    // AND THE MODULE ENGAGED NONE, which is what makes a stacked pair
    // impossible rather than merely unobserved: the root composes the reward
    // screen with `trapFocus: false`, so the module reports neither a trap of
    // its own nor one adopted from the router, and the router's own adoption
    // branch — which defers to a standing trap — never fires.
    expect(counterTotal(application, 'ui.rewardScreen.trapAdopted')).toBe(0);
    expect(counterTotal(application, 'ui.rewardScreen.trapRefused')).toBe(0);
    expect(counterTotal(application, 'ui.router.trap.adopted')).toBe(0);
  });

  it('lifts the inertness of the page shell once the offer is taken', () => {
    storeNearlyClearedStage();
    application = start(document);
    clearStageAndContinue();

    // THE WHOLE PAGE SHELL, not the game region alone: the heading, the board
    // and the footer all leave the accessibility tree behind a modal state,
    // while `.screen-layer` and the live region — which sit outside it — stay
    // reachable. Decision DL-ROUTER-25.
    const region = document.querySelector('.container');

    // Inert while the choice stands, so a screen reader's virtual cursor cannot
    // leave the dialog.
    expect(region?.hasAttribute('inert')).toBe(true);

    const card = document.querySelector<HTMLElement>(
      '#screen-reward .relic-card',
    );

    card?.click();

    // AND LIFTED AFTERWARDS. A stacked pair left it applied, because the trap that
    // released first had not been the one to apply it — which is what made the
    // focus restore fail: the element it restored to was still inside an inert
    // region. One owner applies it and one owner lifts it.
    expect(document.getElementById('screen-reward')?.hidden).toBe(true);
    expect(region?.hasAttribute('inert')).toBe(false);
  });

  it('places focus on the element the run-summary screen marked', () => {
    // A deterministic route to the summary. The board carries two tiles of half
    // the win value side by side on row 0, so one leftward move merges them into
    // the win value; the stored stage goal is set FAR above that highest tile so
    // the stage does not clear on the way and the flow stays on the board until
    // the win. The win takes the `winReached` edge to the terminal screen, whose
    // `End run` control takes the `endRun` edge to the summary.
    const board = copyBoard(NEAR_WIN_BOARD);

    window.localStorage.setItem(GAME_STATE_KEY, JSON.stringify(board));
    window.localStorage.setItem(
      RUN_STATE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        runId: 'summary-focus-run',
        seed: 'summary-focus-seed',
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

    application = start(document);

    press('ArrowLeft', 'ArrowLeft');

    expect(application.engine.won).toBe(true);

    const terminal = document.getElementById('screen-game-over');
    const endRun = [
      ...(terminal?.querySelectorAll<HTMLElement>('button') ?? []),
    ].find((button): boolean => button.textContent === 'End run');

    expect(terminal?.hidden).toBe(false);
    expect(endRun).toBeDefined();

    endRun?.click();

    const host = document.getElementById('screen-run-summary');
    const marked = host?.querySelector('[data-focus-initial]');

    expect(host?.hidden).toBe(false);

    // The same substitution the run-start screen makes: this module is given
    // `placeFocus: false` because the router traps this container after its
    // `enter`, and the marked copy control is the panel's first focusable element,
    // so the trap's own placement resolves to it.
    expect(marked).not.toBeNull();
    expect(document.activeElement).toBe(marked);
  });
});

/* ==========================================================================
 * F-11. Disposal order around the parallel-board handoff
 * ======================================================================== */

describe('disposal leaves no accessibility board behind', () => {
  it('unmounts the board the renderer teardown handed back', () => {
    window.localStorage.setItem(
      GAME_STATE_KEY,
      JSON.stringify(boardWithTiles([{ x: 0, y: 0, value: 8 }])),
    );

    application = start(document);

    const parallel = document.getElementById('board-a11y');

    // jsdom carries no WebGL context, so the number-only renderer draws the
    // board and holds the parallel board hidden for as long as it does.
    expect(parallel?.hidden).toBe(true);
    expect(parallel?.getAttribute('aria-hidden')).toBe('true');

    application.dispose();
    application = null;

    // THE HANDOFF LANDED WHILE ITS OWNER WAS STILL ALIVE. Tearing the renderer
    // down remounts `ParallelBoardLayer` and restores the attributes it hid the
    // board behind, so running that teardown after the focus owners left a
    // rebuilt subtree and its listeners in a disposed page. DL-MAIN-23,
    // DL-NUMBER-07.
    expect(parallel?.querySelectorAll('[role="gridcell"]').length).toBe(0);
    expect(parallel?.children.length).toBe(0);

    // The attributes the renderer changed are still given back, so a page that
    // composes a second application finds the markup it shipped with.
    expect(parallel?.hidden).toBe(false);
    expect(parallel?.hasAttribute('aria-hidden')).toBe(false);
  });
});
