// Integration suite for the COMPLETE screen registry, AAP R8 and Rule 3.
//
// WHAT WAS WRONG
//   Six screen modules shipped complete and fully unit tested — run start,
//   stage progress, reward, run summary and the shared game-over verdict — and
//   the composition root built exactly one of them. `createScreenRouter` was
//   called with no `screens` option at all, so `screens` defaulted to `{}` and
//   every routed state showed an empty container: the run-start screen the cold
//   load lands on, the interstitial a cleared stage passes through, the summary
//   a finished run ends on and the verdict panel a loss or a win renders. Each
//   of those modules also carries its own reporter, so the whole of their
//   logging, counting and degradation reporting was unreachable from the
//   running application.
//
//   The reward state was worse than absent. The router carries a reward surface
//   of its own that predates src/ui/screens/, and it stamps the same
//   `data-relic-id` on its own buttons as the relic-card component does.
//   Registering the module without retiring that surface would have rendered
//   `#screen-reward` twice, engaged two focus traps over one dialog and given a
//   single card press two selection paths.
//
// WHAT THIS SUITE PINS
//   That every overlay state of AAP Figure 6 has a registered module and a
//   resolved container, that each renders its own subtree into its own
//   container, that the reward container carries exactly ONE panel and ONE
//   selection path, and that the screens' controls reach the run through the
//   same single owners the keyboard does.
//
// The markup below is index.html's, screen layer included — which is what the
// sibling composition suites deliberately omit, and why they could not see any
// of this.
//
// The board is drawn by the number-only renderer here, because jsdom implements
// no WebGL context. Nothing in this suite depends on which renderer draws.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from '../../../src/main';
import type { Application } from '../../../src/main';
import { resetWebGLSupportProbe } from '../../../src/render/webgl-support';
import { RUN_STATE_KEY } from '../../../src/storage/storage-keys';
import { RUN_START_IDS } from '../../../src/ui/screens/run-start';
import { continueToReward } from '../../fixtures/composition';
import { clearOwnedStorage } from '../../fixtures/storage';

/** index.html's markup, including the five overlay screen roots. */
const MARKUP = `
  <main id="game-main">
    <div class="score-container"><span class="visually-hidden">Score</span>0</div>
    <div class="best-container"><span class="visually-hidden">Best score</span>0</div>
    <button type="button" class="restart-button">New Game</button>
    <button type="button" class="settings-button" id="settings-button"
            aria-haspopup="dialog" aria-controls="settings-panel">Settings</button>
    <div class="hud" id="screen-hud" data-screen="hud" role="group"
         aria-label="Run status" hidden>
      <div class="hud-stage" id="hud-stage"></div>
      <ul class="relic-tray" id="relic-tray" role="list"
          aria-label="Active relics, in pickup order"></ul>
    </div>
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
    <div class="screen" id="screen-run-start" data-screen="run-start"
         role="dialog" aria-modal="true" aria-label="Start a run" hidden></div>
    <div class="screen" id="screen-stage-progress" data-screen="stage-progress"
         role="dialog" aria-modal="true" aria-label="Stage progress" hidden></div>
    <div class="screen" id="screen-reward" data-screen="reward" role="dialog"
         aria-modal="true" aria-label="Choose a relic" hidden></div>
    <div class="screen" id="screen-game-over" data-screen="game-over"
         role="dialog" aria-modal="true" aria-label="Game over" hidden></div>
    <div class="screen" id="screen-run-summary" data-screen="run-summary"
         role="dialog" aria-modal="true" aria-label="Run summary" hidden></div>
    <div class="settings-panel" id="settings-panel" role="dialog"
         aria-modal="true" aria-label="Settings" hidden></div>
  </div>
  <div class="diagnostics-overlay" id="diagnostics-overlay" hidden></div>
  <div class="visually-hidden live-region" id="live-region" role="status"
       aria-live="polite" aria-atomic="true"></div>
`;

/**
 * One column of the persisted matrix, in the `cells[x][y]` order js/grid.js
 * L58-L64 fixed.
 *
 * @param tiles Values down the column, `null` for an empty cell.
 * @returns The column.
 */
const column = (
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
 * Two 8s in the first column reach 16, which is the target the envelope
 * carries; the board goes under the frozen key as well, because the engine
 * reads its snapshot once during setup. The seed is fixed, so WHICH three
 * relics are offered is the same every run — the reproducibility of AAP R5.
 */
const storeNearlyClearedStage = (): void => {
  const board = {
    grid: { size: 4, cells: [column(8, 8), column(), column(), column()] },
    score: 0,
    over: false,
    won: false,
    keepPlaying: false,
  };

  window.localStorage.setItem('gameState', JSON.stringify(board));
  window.localStorage.setItem(
    RUN_STATE_KEY,
    JSON.stringify({
      schemaVersion: 1,
      runId: 'composition-screens',
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
 * Stores a run one move from the configured win value, on a stage goal that
 * move does NOT clear.
 *
 * Two 1024 tiles side by side in the top row reach 2048, which is `winValue`,
 * so the run reaches the `won` verdict — the state the shared game-over module
 * renders alongside `gameOver`. The goal is a score threshold far above
 * anything the merge produces, because a goal the board already meets clears
 * the stage during composition and leaves the flow on the reward screen, whose
 * input context withholds movement.
 */
const storeNearWinRun = (): void => {
  const board = {
    grid: {
      size: 4,
      cells: [
        [{ position: { x: 0, y: 0 }, value: 1024 }, null, null, null],
        [{ position: { x: 1, y: 0 }, value: 1024 }, null, null, null],
        [null, null, null, null],
        [null, null, null, null],
      ],
    },
    score: 20_000,
    over: false,
    won: false,
    keepPlaying: false,
  };

  window.localStorage.setItem('gameState', JSON.stringify(board));
  window.localStorage.setItem(
    RUN_STATE_KEY,
    JSON.stringify({
      schemaVersion: 1,
      runId: 'composition-screens-win',
      seed: 'near-win-seed',
      rngCursor: {
        'spawn-value': 0,
        'spawn-position': 0,
        'relic-draw': 0,
        'rarity-weight': 0,
      },
      stageIndex: 0,
      stageGoal: { kind: 'score-threshold', target: 1_000_000 },
      goalProgress: 0,
      relics: [],
      board,
    }),
  );
};

let application: Application | null = null;

beforeEach(() => {
  // Cleared BEFORE a fixture is written: the engine and the controller each
  // read their snapshot once, during composition, so a key a previous test left
  // behind is the one this one would open on.
  clearOwnedStorage();
  document.body.innerHTML = MARKUP;
  resetWebGLSupportProbe();
});

afterEach(() => {
  application?.dispose();
  application = null;
  resetWebGLSupportProbe();
  clearOwnedStorage();
  document.body.innerHTML = '';
});

/**
 * Presses one key on the document, as the input manager listens for it.
 *
 * @param key The `event.key` value.
 * @param code The `event.code` value.
 */
const press = (key: string, code: string): void => {
  document.dispatchEvent(
    new window.KeyboardEvent('keydown', { key, code, bubbles: true }),
  );
};

/** One screen container, or a raise naming the fixture that lost it. */
const screen = (id: string): HTMLElement => {
  const found = document.getElementById(id);

  if (found === null) {
    throw new Error(`the fixture lost #${id}`);
  }

  return found;
};

/* ==========================================================================
 * Every overlay state is composed
 * ========================================================================== */

describe('the screen registry', () => {
  it('resolves a container for every state, so nothing is reported missing', () => {
    application = start(document);

    // Six selectors, five containers — `won` and `gameOver` share one. A state
    // whose container did not resolve is counted and named, and this markup is
    // index.html's, so nothing should be.
    expect(application.screens.missingMounts()).toEqual([]);
  });

  it('renders the run-start screen the cold load lands on', () => {
    application = start(document);

    // The cold load HOLDS `runStart`: the boot opens a board only for a run there
    // is something to resume, so the module is entered and its subtree stays in
    // its own container with the seed field in reach. DL-MAIN-19.
    const host = screen('screen-run-start');

    expect(host.querySelector(`#${RUN_START_IDS.panel}`)).not.toBeNull();
    expect(host.querySelector(`#${RUN_START_IDS.seedInput}`)).not.toBeNull();
    expect(host.querySelector(`#${RUN_START_IDS.begin}`)).not.toBeNull();

    expect(application.screens.current()).toBe('runStart');
    expect(host.hidden).toBe(false);

    // And the board is playable from that screen's own control, which is the one
    // way into the `runStart -> stage` edge on a cold load.
    host.querySelector<HTMLElement>(`#${RUN_START_IDS.begin}`)?.click();

    expect(application.screens.current()).toBe('stage');
  });

  it('starts a run from the run-start screen s own control', () => {
    application = start(document);

    const field = screen('screen-run-start').querySelector<HTMLInputElement>(
      `#${RUN_START_IDS.seedInput}`,
    );
    const begin = screen('screen-run-start').querySelector<HTMLElement>(
      `#${RUN_START_IDS.begin}`,
    );

    expect(field).not.toBeNull();
    expect(begin).not.toBeNull();

    if (field !== null) {
      field.value = 'entered-seed';
    }

    begin?.click();

    // ONE path: the screen publishes `startRun` carrying the reduced seed and
    // the root's `startRun` subscription is what starts the run.
    expect(application.run.seed()).toBe('entered-seed');
  });

  it('renders the stage-clear interstitial and the reward offer in their own containers', () => {
    storeNearlyClearedStage();
    application = start(document);

    press('ArrowUp', 'ArrowUp');

    // `stage -> stageClear -> reward` runs one edge per action, so the offer is
    // reached by the interstitial's own continue control. DL-ROUTER-31.
    expect(application.screens.current()).toBe('stageClear');
    continueToReward();

    const reward = screen('screen-reward');

    // EXACTLY ONE PANEL. The router's own reward surface and this module both
    // render this container, and both stamp `data-relic-id`; a second panel is
    // a second selection path.
    expect(reward.querySelectorAll('.reward-panel')).toHaveLength(1);
    expect(reward.querySelectorAll('.reward-offers')).toHaveLength(1);
    expect(reward.querySelectorAll('.relic-card')).toHaveLength(3);
    expect(reward.hidden).toBe(false);

    // Rendered by the module, which the inline surface never does: the keycap
    // digit and the offer index belong to src/ui/components/relic-card.ts.
    expect(reward.querySelectorAll('[data-offer-index]')).toHaveLength(3);
    expect(
      reward.querySelector('.relic-card-shortcut')?.textContent,
    ).not.toBe('');

    // And the interstitial the flow passed THROUGH rendered in ITS OWN
    // container, which is down now that the flow has left it: the reward
    // container is not where the interstitial rendered, and the interstitial is
    // not where the offer rendered.
    expect(screen('screen-stage-progress').hidden).toBe(true);
    expect(
      screen('screen-stage-progress').querySelectorAll('.relic-card'),
    ).toHaveLength(0);
    expect(reward.querySelectorAll('.screen-verdict')).toHaveLength(0);
  });

  it('passes through the stage-clear state on the way to the reward', () => {
    storeNearlyClearedStage();
    application = start(document);

    const visited: string[] = [];

    application.screens.subscribe((transition): void => {
      visited.push(transition.to);
    });

    press('ArrowUp', 'ArrowUp');
    continueToReward();

    // The whole of AAP Figure 6's cleared-stage path, in order: the engine's own
    // `stage:end` takes the first edge and the player's continue press takes the
    // second, so the interstitial is passed THROUGH rather than skipped.
    expect(visited).toContain('stageClear');
    expect(visited.indexOf('stageClear')).toBeLessThan(
      visited.indexOf('reward'),
    );
    expect(application.screens.current()).toBe('reward');
  });

  it('applies exactly one selection for one card press', () => {
    storeNearlyClearedStage();
    application = start(document);

    press('ArrowUp', 'ArrowUp');
    continueToReward();

    const card = screen('screen-reward').querySelector<HTMLElement>(
      '.relic-card[data-relic-id]',
    );
    const chosen = card?.getAttribute('data-relic-id') ?? '';

    expect(chosen).not.toBe('');

    card?.click();

    // ONE relic held, not two, and the stage advanced exactly once. Two
    // selection paths would have applied the choice, then been refused as
    // `'already-resolved'` on the second application.
    expect(application.run.relicContext().map((relic) => relic.id)).toEqual([
      chosen,
    ]);
    expect(application.run.stageIndex()).toBe(1);
    expect(screen('screen-reward').hidden).toBe(true);
  });

  it('renders the terminal verdict into its own container, leaving the retained overlay to the HUD', () => {
    storeNearWinRun();
    application = start(document);

    press('ArrowLeft', 'ArrowLeft');

    expect(application.engine.isGameTerminated()).toBe(true);

    // The module's panel is in `#screen-game-over`, which `won` and `gameOver`
    // share exactly as they share the container index.html declares.
    const host = screen('screen-game-over');

    expect(host.querySelector('.screen-panel')).not.toBeNull();
    expect(host.hidden).toBe(false);
    expect(host.querySelector('[data-action="keepPlaying"]')).not.toBeNull();
    expect(host.querySelector('[data-action="endRun"]')).not.toBeNull();

    // ...and the retained `.game-message` overlay is still written by the HUD
    // alone, which is the one writer DL-HUD-01 names. The module is composed
    // with `overlay: null` precisely so it does not become a second one.
    const overlay = document.querySelector('.game-message');

    expect(overlay?.classList.contains('game-won')).toBe(true);
  });

  it('reaches the run summary from the terminal verdict, and exposes the seed', () => {
    storeNearWinRun();
    application = start(document);

    press('ArrowLeft', 'ArrowLeft');

    const endRun = screen('screen-game-over').querySelector<HTMLElement>(
      '[data-action="endRun"]',
    );

    expect(endRun).not.toBeNull();

    endRun?.click();

    expect(application.screens.current()).toBe('runSummary');

    const summary = screen('screen-run-summary');

    expect(summary.hidden).toBe(false);
    expect(summary.querySelector('.run-summary')).not.toBeNull();

    // The seed is displayed, which is what makes the replay flow exercisable by
    // a human at all.
    expect(summary.querySelector('.run-summary-seed-value')?.textContent).toBe(
      application.run.seed(),
    );
  });

  it('unmounts every screen when the application is disposed', () => {
    application = start(document);

    const runStart = screen('screen-run-start');

    expect(runStart.querySelector(`#${RUN_START_IDS.panel}`)).not.toBeNull();

    application.dispose();
    application = null;

    // `router.destroy()` unmounts every mounted module, and each takes its own
    // subtree back out of the container index.html declared.
    expect(runStart.querySelector(`#${RUN_START_IDS.panel}`)).toBeNull();
  });
});
