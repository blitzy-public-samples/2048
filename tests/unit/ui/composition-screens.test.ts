// Integration suite for the composition root's SCREEN FLOW, AAP R8.
//
// WHAT WAS WRONG
//   All six screen modules shipped complete and unit tested, and the composition
//   root built exactly one of them. `src/main.ts` constructed `createHud` and
//   passed no `screens` registry at all, so `createScreenRouter` fell back to an
//   empty one: the five overlay roots index.html declares stayed empty for the
//   whole life of the page, and `createRunStartScreen`,
//   `createStageProgressScreen`, `createRewardScreen`, `createGameOverScreen` and
//   `createRunSummaryScreen` were unreachable from the entry point. The boot also
//   started the machine and opened the board in the same synchronous task, so a
//   fresh load left `runStart` for `stage` before anything could be painted, and
//   a second reward renderer inside the router competed with the dedicated screen
//   for the same container.
//
// WHAT THIS SUITE PINS
//   The user-visible flow of AAP Figure 6, driven through the real
//   `start(document)` over the markup index.html declares: a cold load holds the
//   run-start screen with a populated panel and no board; the begin-run control
//   starts the run and opens the stage; a cleared stage holds the stage-progress
//   interstitial until its Continue control is pressed; the reward screen then
//   renders the offer the controller drew, and exactly one surface renders it; a
//   choice returns the flow to the stage; a loss reaches the terminal screen and
//   its acknowledge control reaches the run summary, which exposes the seed; and
//   the summary's new-run control returns to run start.
//
// tests/unit/ui/screen-router.test.ts pins the machine over screen doubles and
// each tests/unit/ui/*.test.ts pins a screen in isolation. This suite pins only
// that the root joins them: that every mount is POPULATED and every state is
// REACHABLE from the entry point.
//
// The board is drawn by the number-only renderer here, because jsdom implements
// no WebGL context. Nothing in this suite depends on which renderer draws.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from '../../../src/main';
import type { Application } from '../../../src/main';
import { resetWebGLSupportProbe } from '../../../src/render/webgl-support';
import {
  GAME_STATE_KEY,
  RUN_STATE_KEY,
} from '../../../src/storage/storage-keys';
import { clearOwnedStorage } from '../../fixtures/storage';
import {
  DEFAULT_STAGE_CONFIG,
  stageGoalForIndex,
} from '../../../src/config/stage-config';
import { runSummaryClasses } from '../../../src/ui/screens/run-summary';

/**
 * The markup index.html declares, in the nesting it declares it in.
 *
 * Every screen root is present, because the property under test is that each one
 * is populated. The two suites beside this one deliberately declare fewer, which
 * is how the degradation paths are covered.
 */
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

  // The application never deletes `bestScore`, so a suite that ignores it leaks
  // the highest score into every later test.
  window.localStorage.removeItem('bestScore');
  clearOwnedStorage();
});

/** Presses one key on the document, as the input manager listens for it. */
const press = (key: string, code: string): void => {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key, code, bubbles: true }),
  );
};

/** One element, or a thrown failure naming the selector that resolved none. */
const el = (selector: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(selector);

  if (found === null) {
    throw new Error(`the fixture resolved no ${selector}`);
  }

  return found;
};

/**
 * Whether a screen root is hidden.
 *
 * `hidden` widened to `boolean | 'until-found'` in the DOM lib, so the read is
 * reduced to a boolean here.
 */
const hidden = (id: string): boolean =>
  document.querySelector<HTMLElement>(`#${id}`)?.hidden !== false;

/** The screen root that is showing, or `null` where none is. */
const showing = (): string | null => {
  for (const root of document.querySelectorAll<HTMLElement>(
    '.screen-layer .screen',
  )) {
    if (root.hidden === false) {
      return root.id;
    }
  }

  return null;
};

/** The relic identifiers the reward screen has on screen, in draw order. */
const offeredIds = (): string[] =>
  [...document.querySelectorAll('#screen-reward .relic-card')].map(
    (card): string => card.getAttribute('data-relic-id') ?? '',
  );

/**
 * A board one move from clearing the opening stage, and the run it belongs to.
 *
 * The default curve's first goal is `highest-tile: 16`, so two 8s side by side in
 * the top row clear it in one move up. `cells` is column-major — `cells[x][y]` —
 * the shape js/grid.js serialised and this build preserves verbatim. Both keys
 * are written BEFORE `start()`, because the load reads them once.
 */
const NEAR_CLEAR_BOARD = {
  grid: {
    size: 4,
    cells: [
      [{ position: { x: 0, y: 0 }, value: 8 }, null, null, null],
      [{ position: { x: 1, y: 0 }, value: 8 }, null, null, null],
      [null, null, null, null],
      [null, null, null, null],
    ],
  },
  score: 0,
  over: false,
  won: false,
  keepPlaying: false,
};

/**
 * A board the run was already lost on.
 *
 * `over` is part of the snapshot js/game_manager.js L108 wrote and `setup()`
 * restores, so a run resumed from this one is over on its opening commit — which
 * is the state the terminal screen exists for. Every neighbouring pair differs,
 * so the verdict cannot be argued with either.
 */
const BLOCKED_BOARD = {
  grid: {
    size: 4,
    cells: [
      [
        { position: { x: 0, y: 0 }, value: 2 },
        { position: { x: 0, y: 1 }, value: 4 },
        { position: { x: 0, y: 2 }, value: 2 },
        { position: { x: 0, y: 3 }, value: 4 },
      ],
      [
        { position: { x: 1, y: 0 }, value: 4 },
        { position: { x: 1, y: 1 }, value: 2 },
        { position: { x: 1, y: 2 }, value: 4 },
        { position: { x: 1, y: 3 }, value: 2 },
      ],
      [
        { position: { x: 2, y: 0 }, value: 2 },
        { position: { x: 2, y: 1 }, value: 4 },
        { position: { x: 2, y: 2 }, value: 2 },
        { position: { x: 2, y: 3 }, value: 4 },
      ],
      [
        { position: { x: 3, y: 0 }, value: 4 },
        { position: { x: 3, y: 1 }, value: 2 },
        { position: { x: 3, y: 2 }, value: 4 },
        { position: { x: 3, y: 3 }, value: 2 },
      ],
    ],
  },
  score: 4_096,
  over: true,
  won: false,
  keepPlaying: false,
};

/**
 * Stores a resumable run wrapping `board`.
 *
 * @param board The board snapshot the envelope wraps.
 * @param stageIndex Zero-based stage the run stands on.
 * @param target Target of the goal that stage is measured against.
 */
const storeRun = (
  board: unknown,
  stageIndex = 0,
  target = 16,
): void => {
  window.localStorage.setItem(GAME_STATE_KEY, JSON.stringify(board));
  window.localStorage.setItem(
    RUN_STATE_KEY,
    JSON.stringify({
      schemaVersion: 1,
      runId: 'flow-run',
      seed: 'flow-seed',
      rngCursor: {
        'spawn-value': 0,
        'spawn-position': 0,
        'relic-draw': 0,
        'rarity-weight': 0,
      },
      stageIndex,
      stageGoal: { kind: 'highest-tile', target },
      goalProgress: 0.5,
      relics: [],
      board,
    }),
  );
};

/* ==========================================================================
 * 1. Every mount is populated
 * ========================================================================== */

describe('the screen registry', () => {
  it('populates every mount index.html declares', () => {
    storeRun(NEAR_CLEAR_BOARD);
    application = start(document);

    // The stage is in force on a resumed run, so the in-flow HUD is up and
    // carries both of its outlets.
    expect(hidden('screen-hud')).toBe(false);
    expect(el('#hud-stage').textContent?.length ?? 0).toBeGreaterThan(0);
    // The run stored above holds no relic, so the tray carries EXACTLY the
    // empty-state row — one real `<li>` marked as the empty row — and its own
    // accessible name. `children.length >= 0` stood here, which is true of every
    // element there has ever been and would have passed for a tray that was
    // never populated at all.
    const tray = el('#relic-tray');

    expect(tray.getAttribute('aria-label')).toBe(
      'Active relics, in pickup order',
    );
    expect(tray.children).toHaveLength(1);

    const emptyRow = tray.children[0];

    expect(emptyRow?.tagName).toBe('LI');
    expect(emptyRow?.getAttribute('data-relic-empty')).toBe('true');
    expect(emptyRow?.textContent).toBe('No relics yet');

    // Each overlay root is populated by its own module the first time it is
    // entered, and `start()` mounts every one of them, so each has already
    // received its container.
    press('ArrowLeft', 'ArrowLeft');

    expect(showing()).toBe('screen-stage-progress');
    expect(
      el('#screen-stage-progress').querySelectorAll('.screen-verdict').length,
    ).toBe(1);
    expect(el('.stage-progress-continue').textContent?.length ?? 0)
      .toBeGreaterThan(0);

    el('.stage-progress-continue').click();

    expect(showing()).toBe('screen-reward');
    expect(el('#screen-reward').querySelectorAll('.reward-panel').length).toBe(
      1,
    );
    expect(offeredIds()).toHaveLength(3);
  });

  it('renders the reward offer from exactly one surface', () => {
    storeRun(NEAR_CLEAR_BOARD);
    application = start(document);
    press('ArrowLeft', 'ArrowLeft');
    el('.stage-progress-continue').click();

    // ONE OWNER. The router used to build a second card list into this same
    // container, whose own host-level click delegation would have resolved a
    // pressed card independently and taken the reward twice.
    expect(
      el('#screen-reward').querySelectorAll('.reward-offers').length,
    ).toBe(1);
    expect(el('#screen-reward').querySelectorAll('.reward-panel').length).toBe(
      1,
    );

    const ids = offeredIds();

    expect(new Set(ids).size).toBe(3);

    // And one press takes exactly one relic.
    el(`#screen-reward .relic-card[data-relic-id="${ids[0] ?? ''}"]`).click();

    expect(
      application.run.relicContext().map((relic) => relic.id),
    ).toEqual([ids[0]]);
  });
});

/* ==========================================================================
 * 2. A cold load holds the run-start screen
 * ========================================================================== */

describe('a cold load', () => {
  it('holds run start, with no board opened behind it', () => {
    application = start(document);

    expect(showing()).toBe('screen-run-start');
    expect(el('#run-start-panel').querySelectorAll('button').length)
      .toBeGreaterThan(0);
    expect(el('#run-start-seed')).toBeInstanceOf(HTMLInputElement);

    // AAP Figure 6 enters `RunStart` on a cold load, and the run begins on an
    // explicit action: nothing has been committed, so no envelope has been
    // written and the board is empty.
    expect(window.localStorage.getItem(RUN_STATE_KEY)).toBeNull();
    expect(
      application.engine
        .serialize()
        .grid.cells.flat()
        .filter((cell) => cell !== null),
    ).toEqual([]);

    // The board is not playable behind the dialog either.
    press('ArrowUp', 'ArrowUp');

    expect(showing()).toBe('screen-run-start');
  });

  it('plays the seed the controller reduced, and clears the field behind it', () => {
    application = start(document);

    const field = el('#run-start-seed') as HTMLInputElement;

    // Reduced by `normalizeEnteredSeed`: the surrounding whitespace goes, so
    // the value the run is played under is not the text that was typed.
    field.value = '  padded-seed  ';
    el('#run-start-begin').click();

    // THE READBACK PORT IS COMPOSED. Left uncomposed the screen could not learn
    // what its text was reduced to, so no reduction was ever visible.
    expect(application.run.seed()).toBe('padded-seed');

    // The state machine left run start inside the press, and its departure
    // clears the field: the reduced seed is NOT written back into a screen that
    // is no longer showing, so the next visit opens empty.
    expect(hidden('screen-run-start')).toBe(true);
    expect(field.value).toBe('');
    expect(el('#run-start-seed-status').hidden).toBe(true);

    // The reduction is still REPORTED, which is the observable half of the
    // readback: the screen compared what it emitted with what the run is played
    // under and found them different.
    const adjusted = application.metrics
      .snapshot()
      .series.filter(
        (entry) =>
          entry.labels['report'] === 'ui.runStart.seed.adjusted' &&
          entry.kind === 'counter',
      );

    expect(adjusted.length).toBeGreaterThan(0);
  });

  it('begins the run from the begin-run control, on the entered seed', () => {
    application = start(document);

    const field = el('#run-start-seed') as HTMLInputElement;

    field.value = 'chosen-seed';
    el('#run-start-begin').click();

    expect(application.run.seed()).toBe('chosen-seed');
    expect(showing()).toBeNull();
    expect(hidden('screen-hud')).toBe(false);
    expect(
      application.engine
        .serialize()
        .grid.cells.flat()
        .filter((cell) => cell !== null),
    ).toHaveLength(2);

    // And the board is playable now, which it was not a moment ago.
    const before = application.engine.serialize().score;

    press('ArrowUp', 'ArrowUp');
    press('ArrowRight', 'ArrowRight');
    press('ArrowDown', 'ArrowDown');
    press('ArrowLeft', 'ArrowLeft');

    expect(application.engine.serialize().score).toBeGreaterThanOrEqual(before);
    expect(window.localStorage.getItem(RUN_STATE_KEY)).not.toBeNull();
  });

  it('opens straight into the board for a resumed run', () => {
    storeRun(NEAR_CLEAR_BOARD);
    application = start(document);

    // Only a valid resumed run opens directly into gameplay.
    expect(showing()).toBeNull();
    expect(application.run.seed()).toBe('flow-seed');
    expect(application.run.runId()).toBe('flow-run');
  });
});

/* ==========================================================================
 * 3. The stage gate
 * ========================================================================== */

describe('a cleared stage', () => {
  it('holds the interstitial until its Continue control is pressed', () => {
    storeRun(NEAR_CLEAR_BOARD);
    application = start(document);

    press('ArrowLeft', 'ArrowLeft');

    // ONE EVENT, ONE EDGE: `stage:end` reaches the interstitial and stops there.
    expect(showing()).toBe('screen-stage-progress');
    expect(hidden('screen-reward')).toBe(true);
    expect(application.run.isRewardPending()).toBe(true);

    // Another move changes nothing: the interstitial is an overlay state, so
    // movement is withheld and the flow does not advance itself.
    press('ArrowUp', 'ArrowUp');
    press('ArrowRight', 'ArrowRight');

    expect(showing()).toBe('screen-stage-progress');

    el('.stage-progress-continue').click();

    expect(showing()).toBe('screen-reward');
    expect(offeredIds()).toHaveLength(3);
  });

  it('returns to the stage on a choice, and advances the run', () => {
    storeRun(NEAR_CLEAR_BOARD);
    application = start(document);
    press('ArrowLeft', 'ArrowLeft');
    el('.stage-progress-continue').click();

    const chosen = offeredIds()[0] ?? '';

    expect(application.run.state().stageIndex).toBe(0);

    el(`#screen-reward .relic-card[data-relic-id="${chosen}"]`).click();

    expect(showing()).toBeNull();
    expect(hidden('screen-hud')).toBe(false);
    expect(application.run.state().stageIndex).toBe(1);
    expect(
      application.run.relicContext().map((relic) => relic.id),
    ).toEqual([chosen]);

    // The tray lists what is held, in pickup order.
    expect(el('#relic-tray').children).toHaveLength(1);
  });

  it('returns focus to the board tab stop the renderer in force holds', () => {
    storeRun(NEAR_CLEAR_BOARD);
    application = start(document);

    const cells = (): HTMLElement[] => [
      ...el('#board-number-only').querySelectorAll<HTMLElement>(
        '[role="gridcell"]',
      ),
    ];

    // The stop is roved off the first cell while the stage is the state in
    // force, as reading the board does, so a restore that resolved the wrong
    // surface cannot pass by landing on cell one.
    cells().at(6)?.focus();

    expect(cells().at(6)?.getAttribute('tabindex')).toBe('0');

    press('ArrowLeft', 'ArrowLeft');
    el('.stage-progress-continue').click();

    expect(showing()).toBe('screen-reward');

    el(`#screen-reward .relic-card[data-relic-id="${offeredIds()[0] ?? ''}"]`)
      .click();

    // BACK ON THE COORDINATE IT LEFT. `#board-a11y` is hidden for the whole of a
    // number-only session, so a restore naming only that host restored to an
    // element that cannot take focus, and the caret was left wherever the
    // dismissed screen had it. DL-FOCUS-04.
    const active = document.activeElement;

    expect(cells().indexOf(active as HTMLElement)).toBe(6);
    expect(active?.getAttribute('tabindex')).toBe('0');
    expect(el('#board-a11y').hidden).toBe(true);
  });

  it('announces the offer on entry and the acquisition once per press', async () => {
    /**
     * Every distinct line the live region held while the queue drained. The
     * region holds ONE line at a time and holds it across several tasks, so a
     * repeated sample of the same text is one line rather than several.
     */
    const collect = async (): Promise<string[]> => {
      const lines: string[] = [];

      for (let turn = 0; turn < 24; turn += 1) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });

        const text = (
          document.querySelector('#live-region')?.textContent ?? ''
        ).toLowerCase();

        if (text.trim() !== '' && text !== lines[lines.length - 1]) {
          lines.push(text);
        }
      }

      return lines;
    };

    storeRun(NEAR_CLEAR_BOARD);
    application = start(document);
    press('ArrowLeft', 'ArrowLeft');
    el('.stage-progress-continue').click();

    const entering = await collect();

    // ONE offer line, read as the reward state was entered rather than on the
    // commit that drew the cards. DL-REWARD-14.
    expect(
      entering.filter((line) => line.includes('choose a relic')),
    ).toHaveLength(1);
    expect(entering.some((line) => line.includes('relic acquired'))).toBe(
      false,
    );

    const chosen = offeredIds()[0] ?? '';

    el(`#screen-reward .relic-card[data-relic-id="${chosen}"]`).click();

    const choosing = await collect();

    // ONE acquisition line for the pointer press: the screen carries no region
    // of its own, so the transaction is the single speaker and a card press and
    // a digit press are announced identically.
    expect(
      choosing.filter((line) => line.includes('relic acquired')),
    ).toHaveLength(1);
  });
});

/* ==========================================================================
 * 4. The terminal states and the run summary
 * ========================================================================== */

describe('a lost run', () => {
  it('restarts no board from a terminal state, and leaves the ended run intact', () => {
    storeRun(BLOCKED_BOARD, 8, 4_096);
    application = start(document);

    expect(showing()).toBe('screen-game-over');

    const before = application.engine.serialize();
    const endedRun = application.run.lastSummary();

    // THE GATE ITSELF, which is what refuses an action however it arrives: a
    // remapped binding, a generated control or a caller's own emission all
    // resolve against this one decision. DL-ROUTER-39.
    expect(application.router.authorizes('restart')).toBe(false);

    // Every modality that reaches `restart`: the key, the header control and the
    // retained overlay control. `restart` discards the board inside the run in
    // force, and this run has ENDED — so all three are refused and the board the
    // player lost on is still the board on screen. DL-ROUTER-39, DL-CONTROL-08.
    press('r', 'KeyR');
    el('.restart-button').click();
    el('.retry-button').click();

    expect(application.engine.serialize()).toEqual(before);
    expect(showing()).toBe('screen-game-over');
    expect(application.run.lastSummary()).toEqual(endedRun);

    // The way out is the screen's own edge, which is what AAP Figure 6 declares.
    el('#screen-game-over [data-action="acknowledge"]').click();

    expect(showing()).toBe('screen-run-summary');
  });

  it('reaches the terminal screen, the summary and back to run start', () => {
    // A board with no move left, at a stage its highest tile does not clear, so
    // the opening commit is a loss and nothing else.
    storeRun(BLOCKED_BOARD, 8, 4_096);
    application = start(document);

    expect(showing()).toBe('screen-game-over');
    expect(el('#screen-game-over').querySelectorAll('.screen-panel').length)
      .toBe(1);

    const acknowledge = el('#screen-game-over [data-action="acknowledge"]');

    acknowledge.click();

    expect(showing()).toBe('screen-run-summary');

    const summary = el('#screen-run-summary');

    expect(summary.querySelectorAll('.run-summary').length).toBe(1);

    // The seed is displayed, which is what makes the replay flow exercisable by
    // a human.
    expect(
      summary.querySelector('.run-summary-seed-value')?.textContent,
    ).toBe('flow-seed');

    const newRun = el('#screen-run-summary [data-action="newRun"]');

    newRun.click();

    expect(showing()).toBe('screen-run-start');
  });
});

/* ==========================================================================
 * 5. Disposal reaches every screen the root constructed
 * ========================================================================== */

describe('disposal', () => {
  /** Every counter folded by the `report` label, summed. */
  const reports = (app: Application): Map<string, number> => {
    const totals = new Map<string, number>();

    for (const entry of app.metrics.snapshot().series) {
      const report = entry.labels['report'];

      if (typeof report === 'string' && entry.kind === 'counter') {
        totals.set(report, (totals.get(report) ?? 0) + entry.value);
      }
    }

    return totals;
  };

  it('unmounts every screen module exactly once', () => {
    storeRun(NEAR_CLEAR_BOARD);

    const app = start(document);

    // Reached so the reward and stage-clear modules have rendered rather than
    // only mounted: a module that built a subtree is the one whose teardown has
    // something to release.
    press('ArrowLeft', 'ArrowLeft');
    el('.stage-progress-continue').click();

    expect(showing()).toBe('screen-reward');

    app.dispose();

    const counted = reports(app);

    // `ScreenRouter.destroy` drains the modules it mounted, and it is the ONE
    // owner of that teardown: the modules the root constructs are registered
    // with it and released through it.
    expect(counted.get('ui.runStart.unmounted')).toBe(1);
    expect(counted.get('ui.stageProgress.unmounted')).toBe(1);
    expect(counted.get('ui.runSummary.destroyed')).toBe(1);

    // And released ONCE. Every one of these is raised only by a call that
    // arrived after the module was already torn down, so a second owner calling
    // a second teardown would show up here.
    for (const afterTeardown of [
      'ui.runStart.after_unmount',
      'ui.stageProgress.call_after_unmount',
      'ui.rewardScreen.afterUnmount',
      'ui.gameOver.after_destroy',
      'ui.runSummary.after_destroy',
    ]) {
      expect(counted.get(afterTeardown) ?? 0).toBe(0);
    }

    // The reward panel the module built is gone with it, so a disposed
    // application leaves no offer standing on screen.
    expect(document.querySelectorAll('#screen-reward .relic-card').length).toBe(
      0,
    );

    application = null;
  });

  it('leaves no focus trap standing', () => {
    application = start(document);

    // Run start traps focus, so a cold load has one standing.
    expect(showing()).toBe('screen-run-start');

    application.dispose();
    application = null;

    // Tab is no longer contained, and no listener remains to contain it: the
    // trap was released by the same teardown that unmounted the screen.
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true }),
    );

    expect(document.activeElement).toBe(document.body);
  });
});

/* ==========================================================================
 * 6. The summary describes the run that ended
 * ========================================================================== */

/**
 * A board one move away from 2048, on a stage whose goal is out of reach.
 *
 * The move wins and scores, so the run ends carrying a score and a stage a fresh
 * run does not have — which is what makes the two summaries distinguishable.
 */
const NEAR_WIN_BOARD = {
  grid: {
    size: 4,
    cells: [
      [
        { position: { x: 0, y: 0 }, value: 1_024 },
        { position: { x: 0, y: 1 }, value: 1_024 },
        null,
        null,
      ],
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

/**
 * Reads one labelled readout of the run-summary panel.
 *
 * @param label Caption of the readout to read.
 * @returns The value beside that caption, or `null` where it is absent.
 */
const readout = (label: string): string | null => {
  const readouts = document.querySelectorAll<HTMLElement>(
    `#screen-run-summary .${runSummaryClasses.score}`,
  );

  for (const entry of readouts) {
    const caption = entry.querySelector(`.${runSummaryClasses.scoreLabel}`);

    if (caption?.textContent === label) {
      return (
        entry.querySelector(`.${runSummaryClasses.scoreValue}`)?.textContent ??
        null
      );
    }
  }

  return null;
};

describe('the run summary', () => {
  it('summarises the run that ended, not the run that replaced it', () => {
    storeRun(NEAR_WIN_BOARD, 2, 4_096);
    application = start(document);

    press('ArrowUp', 'ArrowUp');

    const scored = application.engine.score;

    expect(scored).toBeGreaterThan(0);

    el('#screen-game-over [data-action="endRun"]').click();

    // `RunController.finish()` holds the run that ended and replaces the run in
    // force with a fresh one, so the run in force reads back at zero. Both are
    // asserted, because the readouts below are only meaningful if the two
    // genuinely differ.
    expect(application.run.lastSummary()?.score).toBe(scored);
    expect(application.run.lastSummary()?.stageIndex).toBe(2);
    expect(application.run.summary().score).toBe(0);
    expect(application.run.summary().stageIndex).toBe(0);

    // The panel describes the run that ended.
    expect(readout('Final score')).toBe(String(scored));
    expect(readout('Stage reached')).toBe('3');

    // A summary carries no goal, so the goal shown is the progression curve's at
    // the stage reached — the stage the panel is showing, not the fresh run's.
    const curveGoal = stageGoalForIndex(2, DEFAULT_STAGE_CONFIG);

    expect(readout('Stage goal')).toBe(`Tile ${String(curveGoal.target)}`);
    expect(readout('Stage goal')).not.toBe(
      `Tile ${String(stageGoalForIndex(0, DEFAULT_STAGE_CONFIG).target)}`,
    );
  });
});
