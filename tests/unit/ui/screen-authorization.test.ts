// Contract suite for action authorization, AAP R8 and R9.
//
// WHAT WAS WRONG
//   `InputContext` has three members and `SCREEN_INPUT_CONTEXTS` maps six of the
//   seven screens onto one of them, `'overlay'`, so the context could say that
//   SOME overlay was up and never which one. Authorization was then decided once
//   per modality and once per action: the keyboard and the gestures read the
//   context, the reward digits read `rewardOpen` alone, and `keepPlaying` and
//   `startRun` read nothing at all. The consequences were concrete — the default
//   `C` continued a won game from behind the settings dialog, mutating and
//   persisting board state the player could not see; a reward digit or a pointer
//   press selected a relic from behind that same dialog, because the reward
//   container is a SIBLING of the panel inside `.screen-layer` and so was not
//   covered by the game region the dialog marks inert; and the `.retry-button`
//   discarded the board of whatever run was in force from any state that showed
//   it.
//
// WHAT THIS SUITE PINS
//   `ACTION_SCREENS` agrees with `TRANSITIONS` rather than merely resembling it;
//   `authorizes()` is the one decision and it resolves against the EXACT screen
//   and the topmost modal; and nothing at all executes from behind the settings
//   dialog through any modality — key, generated control, markup control or
//   pointer — while everything still executes the moment the dialog closes.
//
// The board is drawn by the number-only renderer here, because jsdom implements
// no WebGL context. Nothing in this suite depends on which renderer draws.
//
// This suite is the designated evidence for two decisions in
// docs/DECISION_LOG.md: `DL-ROUTER-18`, the router's single authorization
// decision, and `DL-MAIN-17`, the composition root routing every mutating
// action through it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { INPUT_ACTIONS } from '../../../src/input/keymap';
import { start } from '../../../src/main';
import type { Application } from '../../../src/main';
import { resetWebGLSupportProbe } from '../../../src/render/webgl-support';
import {
  ACTION_SCREENS,
  ACTION_TRIGGERS,
  AUTHORIZED_ACTIONS,
  SCREEN_NAMES,
  SCREEN_SUSPENDS_INPUT,
  TRANSITIONS,
  createScreenRouter,
  isAuthorizedAction,
} from '../../../src/ui/screen-router';
import type {
  AuthorizationScreen,
  AuthorizedAction,
  ScreenName,
  ScreenRouter,
} from '../../../src/ui/screen-router';
import { GAME_STATE_KEY, RUN_STATE_KEY } from '../../../src/storage/storage-keys';
import { clearOwnedStorage } from '../../fixtures/storage';

/** The markup src/main.ts looks up, in the nesting index.html declares it in. */
const MARKUP = `
  <div class="container">
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
  </div>
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
let router: ScreenRouter | null = null;

beforeEach(() => {
  document.body.innerHTML = MARKUP;
  resetWebGLSupportProbe();
});

afterEach(() => {
  application?.dispose();
  application = null;
  router?.destroy();
  router = null;
  resetWebGLSupportProbe();
  document.body.innerHTML = '';
  clearOwnedStorage();
});

const press = (key: string, code: string): void => {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key, code, bubbles: true }),
  );
};

const control = (selector: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(selector);

  if (found === null) {
    throw new Error(`the fixture lost ${selector}`);
  }

  return found;
};

/**
 * A legacy board snapshot carrying the tiles given.
 *
 * `cells` is column-major — `cells[x][y]` — the shape js/grid.js serialised and
 * this build preserves verbatim, and each tile's own `position` is derived from
 * the cell it occupies so the two agree.
 */
const boardWithTiles = (
  tiles: readonly { x: number; y: number; value: number }[],
  score = 0,
): unknown => ({
  grid: {
    size: 4,
    cells: Array.from({ length: 4 }, (_column, x) =>
      Array.from({ length: 4 }, (_cell, y) => {
        const tile = tiles.find(
          (entry): boolean => entry.x === x && entry.y === y,
        );

        return tile === undefined
          ? null
          : { position: { x, y }, value: tile.value };
      }),
    ),
  },
  score,
  over: false,
  won: false,
  keepPlaying: false,
});

/**
 * Renders one focusable control inside the dialog under test.
 *
 * A dialog holding nothing focusable is refused by the router's own guard, so
 * every router-level test here renders this much.
 */
const renderCloseControl = (host: Element): void => {
  if (host.querySelector('button') !== null) {
    return;
  }

  const close = document.createElement('button');

  close.type = 'button';
  close.textContent = 'Close';
  host.appendChild(close);
};

/**
 * A board one move from clearing the opening stage, under a fixed seed.
 *
 * The default curve's first goal is `highest-tile: 16`, so two 8s side by side
 * clear it in one move. Written before `start()`, because the envelope and the
 * snapshot are both read once during composition.
 */
const storeNearlyClearedStage = (): void => {
  const board = boardWithTiles([
    { x: 0, y: 0, value: 8 },
    { x: 1, y: 0, value: 8 },
  ]);

  window.localStorage.setItem(GAME_STATE_KEY, JSON.stringify(board));
  window.localStorage.setItem(
    RUN_STATE_KEY,
    JSON.stringify({
      schemaVersion: 1,
      runId: 'authorization-run',
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
 * A board one move from the configured win value: two 1024 tiles side by side.
 */
const storeNearlyWonBoard = (): void => {
  const board = boardWithTiles(
    [
      { x: 0, y: 0, value: 1024 },
      { x: 1, y: 0, value: 1024 },
    ],
    20_000,
  );

  window.localStorage.setItem(GAME_STATE_KEY, JSON.stringify(board));

  // A goal the winning move does NOT meet, so the turn resolves as a win and
  // nothing else. Left at the default curve's opening goal, a board already
  // holding 1024 clears the stage on its first commit and the reward screen —
  // not the win overlay — is what takes the screen.
  window.localStorage.setItem(
    RUN_STATE_KEY,
    JSON.stringify({
      schemaVersion: 1,
      runId: 'near-won-run',
      seed: 'near-won-seed',
      rngCursor: {
        'spawn-value': 0,
        'spawn-position': 0,
        'relic-draw': 0,
        'rarity-weight': 0,
      },
      stageIndex: 8,
      stageGoal: { kind: 'score-threshold', target: 1_000_000 },
      goalProgress: 0,
      relics: [],
      board,
    }),
  );
};

/** The reward offer on screen, in the order it is presented. */
const rewardCards = (): string[] =>
  [...document.querySelectorAll('#screen-reward .relic-card')].map(
    (card): string => card.getAttribute('data-relic-id') ?? '',
  );

/** Opens the settings dialog the way a player does. */
const openSettings = (): void => {
  control('#settings-button').click();
};

/**
 * Takes the second edge of `stage -> stageClear -> reward`, which is the
 * player's own continue press. DL-ROUTER-31.
 */
const continueToReward = (): void => {
  control('#screen-stage-progress .stage-progress-continue').click();
};

/* ==========================================================================
 * 1. The table agrees with the state machine
 * ========================================================================== */

describe('the authorization table', () => {
  it('names only events the input layer publishes', () => {
    // A vocabulary that drifted from the input layer would authorize something
    // no modality can publish, or leave a publishable action unauthorized by
    // omission. `move` is the one name here that is an EVENT rather than an
    // action: the four directional actions all publish it, which is exactly why
    // gating it once gates every modality and every direction.
    for (const action of AUTHORIZED_ACTIONS) {
      expect(action === 'move' || INPUT_ACTIONS.includes(action)).toBe(true);
      expect(isAuthorizedAction(action)).toBe(true);
    }

    for (const directional of ['moveUp', 'moveRight', 'moveDown', 'moveLeft']) {
      expect(INPUT_ACTIONS).toContain(directional);
      expect(isAuthorizedAction(directional)).toBe(false);
    }

    expect(isAuthorizedAction('cancel')).toBe(false);
    expect(isAuthorizedAction(null)).toBe(false);
  });

  it('covers every action with at least one screen', () => {
    for (const action of AUTHORIZED_ACTIONS) {
      expect(ACTION_SCREENS[action].length).toBeGreaterThan(0);
    }
  });

  it('authorizes a trigger-backed action wherever its edge is declared', () => {
    // The agreement that makes `ACTION_SCREENS` a projection of `TRANSITIONS`
    // rather than a second, independent opinion of it.
    for (const [action, trigger] of Object.entries(ACTION_TRIGGERS)) {
      const declared = SCREEN_NAMES.filter(
        (name): boolean => TRANSITIONS[name][trigger] !== undefined,
      );

      expect(declared.length).toBeGreaterThan(0);

      for (const name of declared) {
        expect(ACTION_SCREENS[action as AuthorizedAction]).toContain(name);
      }
    }
  });

  it('widens no trigger-backed action beyond its declared edges', () => {
    // `restart` is the board's own action and `stage --restart--> stage` is the
    // one edge AAP Figure 6 declares for it, so the authorized set is that one
    // state: the subscriber discards the board inside the run in force, which no
    // other state has. DL-ROUTER-39.
    expect([...ACTION_SCREENS.restart]).toEqual(['stage']);

    for (const action of AUTHORIZED_ACTIONS) {
      const trigger = (
        ACTION_TRIGGERS as Partial<Record<AuthorizedAction, string>>
      )[action];

      if (trigger === undefined) {
        continue;
      }

      const declared: readonly AuthorizationScreen[] = SCREEN_NAMES.filter(
        (name): boolean =>
          TRANSITIONS[name][trigger as keyof (typeof TRANSITIONS)['stage']] !==
          undefined,
      );

      expect([...ACTION_SCREENS[action]]).toEqual([...declared]);
    }
  });

  it('gives the dialog exactly one action, so it authorizes nothing else', () => {
    const behindSettings = AUTHORIZED_ACTIONS.filter((action): boolean =>
      ACTION_SCREENS[action].includes('settings'),
    );

    expect([...behindSettings]).toEqual(['closeSettings']);
    expect(ACTION_SCREENS.openSettings).not.toContain('settings');
  });
});

/* ==========================================================================
 * 2. One decision, resolved against the exact screen
 * ========================================================================== */

describe('the router authorization decision', () => {
  /** A started router over the fixture, with a focusable dialog body. */
  const startRouter = (initialScreen?: ScreenName): ScreenRouter => {
    const built = createScreenRouter({
      document,
      initialScreen,
      onSettingsOpen: renderCloseControl,
    });

    built.start();
    router = built;

    return built;
  };

  it('answers the exact screen where the context can only say overlay', () => {
    const subject = startRouter('stageClear');

    // `context()` collapses every non-`stage` state onto one value; the
    // authorization screen does not, and that difference is the whole fix.
    expect(subject.context()).toBe('overlay');
    expect(subject.authorizationScreen()).toBe('stageClear');
    expect(subject.authorizes('continueStage')).toBe(true);
    expect(subject.authorizes('move')).toBe(false);
    expect(subject.authorizes('selectReward')).toBe(false);
    expect(subject.authorizes('keepPlaying')).toBe(false);
    expect(subject.authorizes('startRun')).toBe(false);
  });

  it('authorizes each action from its own screen and nowhere else', () => {
    for (const action of AUTHORIZED_ACTIONS) {
      if (action === 'closeSettings') {
        continue;
      }

      for (const name of SCREEN_NAMES) {
        const subject = startRouter(name);
        const expected = ACTION_SCREENS[action].includes(name);

        expect(subject.authorizes(action)).toBe(expected);

        subject.destroy();
        router = null;
      }
    }
  });

  it('refuses every action but closing while the dialog is topmost', () => {
    const subject = startRouter('stage');

    expect(subject.authorizes('move')).toBe(true);
    expect(subject.openSettings()).toBe(true);
    expect(subject.authorizationScreen()).toBe('settings');

    for (const action of AUTHORIZED_ACTIONS) {
      expect(subject.authorizes(action)).toBe(action === 'closeSettings');
    }

    // And released the moment it closes, so the block is the dialog's rather
    // than a permanent one.
    expect(subject.closeSettings()).toBe(true);
    expect(subject.authorizationScreen()).toBe('stage');
    expect(subject.authorizes('move')).toBe(true);
    expect(subject.authorizes('closeSettings')).toBe(false);
  });

  it('refuses a declared edge while the dialog is topmost', () => {
    const subject = startRouter('stage');

    subject.openSettings();

    // The edge is declared — `can()` still says so — and is refused anyway,
    // because a screen behind an unrelated modal is inert to every modality.
    expect(subject.can('restart')).toBe(true);
    expect(subject.send('restart')).toBe(false);
    expect(subject.current()).toBe('stage');

    subject.closeSettings();

    expect(subject.send('restart')).toBe(true);
  });

  it('reports the suspension the reward state declares', () => {
    const subject = startRouter('stage');

    expect(SCREEN_SUSPENDS_INPUT.reward).toBe(true);
    expect(subject.isInputSuspended()).toBe(false);

    expect(
      subject.showReward([
        {
          id: 'temporal-anchor',
          name: 'Temporal Anchor',
          rarity: 'rare',
          description: 'Rewinds one turn.',
          hooks: ['onAfterMove'],
          charges: 2,
        },
      ]),
    ).toBe(true);

    // The composition withholds the manager's own suspension members on
    // purpose, so this is where the declaration becomes observable.
    expect(subject.current()).toBe('reward');
    expect(subject.isInputSuspended()).toBe(true);
    expect(subject.authorizes('selectReward')).toBe(true);
    expect(subject.authorizes('move')).toBe(false);
  });

  it('answers stage for a machine state whose container is not shown', () => {
    // `DL-ROUTER-03` leaves a screen's contents to its own module and nothing
    // guarantees a routed state has a container, so the machine can hold an
    // overlay state that is not on screen. The player is on the board then, and
    // authorizing against a screen they cannot see would make it unplayable.
    document.getElementById('screen-stage-progress')?.remove();

    const subject = startRouter('stageClear');

    expect(subject.current()).toBe('stageClear');
    expect(subject.authorizationScreen()).toBe('stage');
    expect(subject.authorizes('move')).toBe(true);
    expect(subject.authorizes('selectReward')).toBe(false);
  });

  it('refuses everything once destroyed', () => {
    const subject = startRouter('stage');

    subject.destroy();
    router = null;

    for (const action of AUTHORIZED_ACTIONS) {
      expect(subject.authorizes(action)).toBe(false);
    }
  });
});

/* ==========================================================================
 * 3. Nothing executes from behind the dialog, through any modality
 * ========================================================================== */

describe('the composed application behind the settings dialog', () => {
  it('does not continue a won game from the default key', () => {
    storeNearlyWonBoard();
    application = start(document);

    press('ArrowLeft', 'ArrowLeft');

    expect(application.engine.isGameTerminated()).toBe(true);

    const board = application.engine.serialize();

    openSettings();
    press('c', 'KeyC');

    // Still terminated, and the board is byte-for-byte the board the win left:
    // the press mutated nothing and therefore persisted nothing.
    expect(application.engine.isGameTerminated()).toBe(true);
    expect(application.engine.serialize()).toEqual(board);
    expect(control('.game-message').classList.contains('game-won')).toBe(true);

    // Released once the dialog closes, so the same key still works.
    press('Escape', 'Escape');
    press('c', 'KeyC');

    expect(application.engine.isGameTerminated()).toBe(false);
  });

  it('does not restart the board from the retry control', () => {
    application = start(document);

    // The control lives in the page shell, which is inert behind the run-start
    // screen, so the run is begun first — and `restart` is declared for the
    // board's own states.
    control('#run-start-begin').click();

    const runId = application.run.runId();
    const tiles = (): number =>
      application?.engine
        .serialize()
        .grid.cells.flat()
        .filter((cell): boolean => cell !== null).length ?? 0;

    // Played until the board is past its opening, so a discarded board is
    // observable as a board back at `startTiles`.
    press('ArrowUp', 'ArrowUp');
    press('ArrowRight', 'ArrowRight');
    press('ArrowDown', 'ArrowDown');
    press('ArrowLeft', 'ArrowLeft');

    const played = tiles();

    expect(played).toBeGreaterThan(application.config.startTiles);

    openSettings();

    // Two guards refuse this press, and either alone is enough: the control
    // follows its action's `['game']` contexts so the availability layer has
    // withdrawn it while the dialog holds the screen, and the gate refuses
    // `restart` outside `stage`. DL-CONTROL-08, DL-ROUTER-39.
    control('.retry-button').click();

    expect(tiles()).toBe(played);

    press('Escape', 'Escape');
    control('.retry-button').click();

    // The board is discarded and reopened; the run it belongs to is not.
    // DL-MAIN-22.
    expect(tiles()).toBe(application.config.startTiles);
    expect(application.run.runId()).toBe(runId);
  });

  it('does not move the board from a movement key', () => {
    application = start(document);

    openSettings();

    const board = application.engine.serialize();

    press('ArrowUp', 'ArrowUp');
    press('ArrowRight', 'ArrowRight');
    press('ArrowDown', 'ArrowDown');
    press('ArrowLeft', 'ArrowLeft');

    expect(application.engine.serialize()).toEqual(board);
  });

  it('does not select a relic from a reward digit', () => {
    storeNearlyClearedStage();
    application = start(document);

    press('ArrowLeft', 'ArrowLeft');
    continueToReward();

    const offer = rewardCards();

    expect(offer).toHaveLength(3);

    openSettings();
    press('2', 'Digit2');

    // No relic taken, the offer still standing, and the run still on stage 0.
    expect(application.run.relicContext()).toEqual([]);
    expect(rewardCards()).toEqual(offer);
    expect(document.getElementById('screen-reward')?.hidden).toBe(false);
    expect(application.run.state().stageIndex).toBe(0);

    press('Escape', 'Escape');
    press('2', 'Digit2');

    expect(
      application.run.relicContext().map((relic): string => relic.id),
    ).toEqual([offer[1]]);
  });

  it('does not select a relic from a pointer press on its card', () => {
    storeNearlyClearedStage();
    application = start(document);

    press('ArrowLeft', 'ArrowLeft');
    continueToReward();

    const offer = rewardCards();

    expect(offer).toHaveLength(3);

    openSettings();

    // The reward container is a SIBLING of `#settings-panel` inside
    // `.screen-layer`, so it is not covered by the game region the dialog marks
    // inert; the click genuinely lands and the gate is what refuses it.
    control(`#screen-reward .relic-card[data-relic-id="${offer[0] ?? ''}"]`)
      .click();

    expect(application.run.relicContext()).toEqual([]);
    expect(document.getElementById('screen-reward')?.hidden).toBe(false);

    press('Escape', 'Escape');
    control(`#screen-reward .relic-card[data-relic-id="${offer[0] ?? ''}"]`)
      .click();

    expect(
      application.run.relicContext().map((relic): string => relic.id),
    ).toEqual([offer[0]]);
  });

  it('marks the shown reward container inert while the dialog is open', () => {
    storeNearlyClearedStage();
    application = start(document);

    press('ArrowLeft', 'ArrowLeft');
    continueToReward();

    const reward = control('#screen-reward');

    expect(reward.hasAttribute('inert')).toBe(false);

    openSettings();

    // The accessibility half of the same fix: `aria-modal="true"` on the dialog
    // is only true if what is behind it has left the accessibility tree, and the
    // page shell alone does not cover the overlay roots, which are its siblings.
    // The shell is the region the composition supplies, and `inert` inherits, so
    // the board inside it is out of the tree with it.
    expect(reward.hasAttribute('inert')).toBe(true);
    expect(control('.container').hasAttribute('inert')).toBe(true);
    expect(control('.container').contains(control('#game-main'))).toBe(true);

    press('Escape', 'Escape');

    // The dialog lifted the inertness IT applied, and only that: the reward state
    // is still the state in force, its own trap still holds the shell inert, and
    // the container focus is trapped inside is never inert.
    expect(reward.hasAttribute('inert')).toBe(false);
    expect(control('.container').hasAttribute('inert')).toBe(true);
  });
});
