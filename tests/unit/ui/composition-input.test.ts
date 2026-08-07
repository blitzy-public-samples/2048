// Integration suite for the composition root's input wiring, AAP R8 and R9.
//
// The units are pinned by tests/unit/ui/screen-router.test.ts and
// tests/unit/ui/settings-panel.test.ts. This suite pins that src/main.ts wires
// them together, because every one of the four defects it closes was a WIRING
// defect rather than a module defect:
//
//   the router existed nowhere, so nothing ever put the page into `'overlay'`;
//   the settings control was bound to nothing at all;
//   the three legacy controls had two binding owners, so each pointer
//     activation published twice;
//   and the generated controls were never refreshed, so their availability was
//     frozen at whatever context held while they were being generated.
//
// The board is drawn by the number-only renderer here, because jsdom implements
// no WebGL context. Nothing in this suite depends on which renderer draws.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from '../../../src/main';
import type { Application } from '../../../src/main';
import { resetWebGLSupportProbe } from '../../../src/render/webgl-support';
import { applyTheme } from '../../../src/theme/themes';

/**
 * The markup src/main.ts looks up, in the nesting index.html declares it in.
 *
 * `#game-main` is the region made inert for the dialog, `.game-message` is the
 * terminal overlay — OUTSIDE `.screen-layer`, exactly as index.html has it —
 * and `#settings-panel` is the dialog.
 */
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
`;

/**
 * A board one move from the configured win value.
 *
 * Written to storage BEFORE `start()`, because the engine reads the snapshot
 * once during setup. Two 1024 tiles side by side in the top row: one move left
 * merges them into 2048, which is `winValue`.
 */
const NEAR_WIN_STATE = JSON.stringify({
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
});

let application: Application | null = null;

beforeEach(() => {
  document.body.innerHTML = MARKUP;
  resetWebGLSupportProbe();
});

afterEach(() => {
  application?.dispose();
  application = null;
  resetWebGLSupportProbe();
  applyTheme('default');
  document.body.innerHTML = '';

  // The application never deletes this, so a suite that ignores it leaks the
  // highest score into every later test.
  window.localStorage.removeItem('bestScore');
  window.localStorage.removeItem('gameState');
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
 * Counts the move attempts that reach the engine.
 *
 * Deliberately NOT a board comparison. A move that changes nothing spawns
 * nothing, and whether `ArrowDown` changes a freshly seeded two-tile board
 * depends on where the run's seed put those two tiles — so a board comparison
 * asserts on the dice, not on the wiring. `move:before` is emitted for every
 * attempt the engine accepts, whether or not the board then changes, which is
 * exactly the boundary these cases are about: did the keystroke get through.
 */
const countMoveAttempts = (): { readonly value: number; stop(): void } => {
  const app = application;

  if (app === null) {
    throw new Error('start() has not run');
  }

  let seen = 0;
  const stop = app.engine.events.on('move:before', (): void => {
    seen += 1;
  });

  return {
    get value(): number {
      return seen;
    },
    stop,
  };
};

/* ==========================================================================
 * One binding owner
 * ========================================================================== */

describe('one binding owner per markup control', () => {
  it('publishes one restart per click of the New Game control', () => {
    application = start(document);

    let commits = 0;
    const stop = application.engine.events.on('state:commit', (): void => {
      commits += 1;
    });

    control('.restart-button').click();

    // A restart emits exactly one commit. Two binding owners emitted two.
    expect(commits).toBe(1);

    stop();
  });

  it('publishes one restart per click of the retry control', () => {
    application = start(document);

    let commits = 0;
    const stop = application.engine.events.on('state:commit', (): void => {
      commits += 1;
    });

    control('.retry-button').click();

    expect(commits).toBe(1);

    stop();
  });

  it('withdraws only the control whose action the context refuses', () => {
    application = start(document);

    const keepPlaying = control('.keep-playing-button');
    const retry = control('.retry-button');

    // Asymmetric ON PURPOSE, and the asymmetry follows the ACTION rather than
    // the element. `keepPlaying` is legal in `'overlay'` alone, so outside the
    // overlay its control is withdrawn — shown but dead would be a lie.
    expect(keepPlaying.hidden).toBe(true);
    expect(keepPlaying.getAttribute('aria-hidden')).toBe('true');

    // `restart` is legal during ordinary play, so "Try again" is never withdrawn
    // and never carries the unavailability attributes. It is unreachable before
    // a terminal turn for a different reason entirely: the overlay that contains
    // it is `display: none`, which takes it out of the tab order without any
    // attribute being involved. Withdrawing it as well would wrongly imply
    // restarting is unavailable mid-game.
    expect(retry.hidden).toBe(false);
    expect(retry.getAttribute('aria-hidden')).toBeNull();
    expect(retry.getAttribute('tabindex')).toBeNull();
  });
});

/* ==========================================================================
 * The settings dialog
 * ========================================================================== */

describe('the settings dialog', () => {
  it('opens from the settings control, with its body rendered', () => {
    application = start(document);

    const panel = control('#settings-panel');

    expect(panel.hidden).toBe(true);

    control('#settings-button').click();

    expect(panel.hidden).toBe(false);
    expect(panel.querySelectorAll('form')).toHaveLength(1);

    // Every preference the accessibility requirement names, reachable.
    const names = Array.from(panel.querySelectorAll('button')).map(
      (candidate) => candidate.textContent,
    );

    expect(names).toContain('High contrast');
    expect(names).toContain('Colourblind safe');
    expect(names).toContain('Reduce motion');
    expect(names).toContain('Numbers only');
    expect(names).toContain('Mute sound');
    expect(panel.querySelector('input[type="range"]')).not.toBeNull();
  });

  it('holds focus inside the dialog and makes the board inert', () => {
    application = start(document);
    control('#settings-button').click();

    expect(control('#game-main').hasAttribute('inert')).toBe(true);
    expect(
      control('#settings-panel').contains(document.activeElement),
    ).toBe(true);
  });

  it('blocks a movement key while the dialog is open', () => {
    application = start(document);

    const moves = countMoveAttempts();

    control('#settings-button').click();
    press('ArrowDown', 'ArrowDown');

    expect(moves.value).toBe(0);

    moves.stop();
  });

  it('closes on Escape, and movement resumes', () => {
    application = start(document);
    control('#settings-button').click();

    expect(control('#settings-panel').hidden).toBe(false);

    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
      }),
    );

    expect(control('#settings-panel').hidden).toBe(true);
    expect(control('#game-main').hasAttribute('inert')).toBe(false);

    const moves = countMoveAttempts();

    press('ArrowDown', 'ArrowDown');

    expect(moves.value).toBe(1);

    moves.stop();
  });

  it('closes through the dialog s own control', () => {
    application = start(document);
    control('#settings-button').click();

    const close = Array.from(
      document.querySelectorAll<HTMLButtonElement>('#settings-panel button'),
    ).find((candidate) => candidate.textContent === 'Close settings');

    expect(close).toBeDefined();
    close?.click();

    expect(control('#settings-panel').hidden).toBe(true);
  });

  it('switches the palette from the dialog', () => {
    application = start(document);
    control('#settings-button').click();

    const contrast = Array.from(
      document.querySelectorAll<HTMLButtonElement>('#settings-panel button'),
    ).find((candidate) => candidate.textContent === 'High contrast');

    contrast?.click();

    expect(application.preferences.getTheme()).toBe('high-contrast');
    expect(document.documentElement.getAttribute('data-theme')).toBe(
      'high-contrast',
    );
  });
});

/* ==========================================================================
 * Announcements
 * ========================================================================== */

describe('the live region', () => {
  /**
   * Text of every live region in the document, whitespace collapsed.
   *
   * Both regions, because a verdict is assertive: the announcer creates an
   * `aria-live="assertive"` sibling on first assertive use, since a polite
   * `role="status"` region does not interrupt.
   */
  const announced = (): string =>
    Array.from(document.querySelectorAll('[aria-live]'))
      .map((live) => live.textContent ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

  it('is fed by the root, so a move is actually announced', async () => {
    application = start(document);

    expect(announced()).toBe('');

    press('ArrowDown', 'ArrowDown');
    press('ArrowLeft', 'ArrowLeft');

    // The announcer writes on a later task, in two phases, so the region is
    // read after the event loop has turned rather than synchronously.
    await new Promise((resolve) => {
      setTimeout(resolve, 40);
    });

    // Empty for the entire life of a run before the root constructed and fed an
    // announcer. Anything at all here is the fix.
    expect(announced()).not.toBe('');
  });

  it('is the only live region: the score outlets are labelled values', () => {
    application = start(document);

    const score = control('.score-container');
    const best = control('.best-container');

    // Not live regions. Three regions announcing at once race and suppress one
    // another, so narration belongs to the announcer alone.
    expect(score.getAttribute('role')).toBeNull();
    expect(score.getAttribute('aria-live')).toBeNull();
    expect(best.getAttribute('role')).toBeNull();
    expect(best.getAttribute('aria-live')).toBeNull();

    // Still named, though — by a real visually-hidden label rather than by an
    // `aria-label` that would mask the value it precedes.
    expect(score.querySelector('.visually-hidden')?.textContent).toBe('Score');
    expect(best.querySelector('.visually-hidden')?.textContent).toBe(
      'Best score',
    );

    // And the label survives a write, ahead of the value.
    press('ArrowDown', 'ArrowDown');

    expect(score.querySelector('.visually-hidden')?.textContent).toBe('Score');
    expect(score.textContent).toContain('Score');
  });
});

/* ==========================================================================
 * The terminal overlay
 * ========================================================================== */

describe('the win overlay', () => {
  beforeEach(() => {
    window.localStorage.setItem('gameState', NEAR_WIN_STATE);
  });

  it('makes Keep Going reachable, and continues play from the key', () => {
    application = start(document);

    const keepPlaying = control('.keep-playing-button');
    const overlay = control('.game-message');

    // Before the win: unreachable, which is correct — and was the ONLY state it
    // ever had.
    expect(keepPlaying.hidden).toBe(true);

    // One move left merges the two 1024 tiles into the configured win value.
    press('ArrowLeft', 'ArrowLeft');

    expect(overlay.classList.contains('game-won')).toBe(true);
    expect(application.engine.isGameTerminated()).toBe(true);

    // Reachable now: shown, enabled and in the tab order.
    expect(keepPlaying.hidden).toBe(false);
    expect(keepPlaying.getAttribute('aria-hidden')).not.toBe('true');
    expect(keepPlaying.getAttribute('tabindex')).not.toBe('-1');

    // And the key reaches it, which nothing did before: the action had no key at
    // all and its only context was one the page never entered.
    press('c', 'KeyC');

    expect(application.engine.isGameTerminated()).toBe(false);
    expect(overlay.classList.contains('game-won')).toBe(false);
  });

  it('continues play from the control as well as the key', () => {
    application = start(document);

    press('ArrowLeft', 'ArrowLeft');

    expect(application.engine.isGameTerminated()).toBe(true);

    control('.keep-playing-button').click();

    expect(application.engine.isGameTerminated()).toBe(false);
  });

  it('takes the movement controls out of reach while it is shown', () => {
    application = start(document);

    const moveUp = document.querySelector<HTMLElement>(
      '[data-action="moveUp"]',
    );

    expect(moveUp?.hidden).toBe(false);

    press('ArrowLeft', 'ArrowLeft');

    // Terminated: the engine refuses a move, so the control that publishes one
    // says so rather than looking available and doing nothing.
    expect(moveUp?.hidden).toBe(true);

    control('.keep-playing-button').click();

    expect(moveUp?.hidden).toBe(false);
  });

  it('blocks a movement key while the overlay is shown', () => {
    application = start(document);

    press('ArrowLeft', 'ArrowLeft');

    const moves = countMoveAttempts();

    press('ArrowDown', 'ArrowDown');

    expect(moves.value).toBe(0);

    // And released once the overlay is dismissed, so the block is the overlay's
    // and not a permanent one.
    control('.keep-playing-button').click();
    press('ArrowDown', 'ArrowDown');

    expect(moves.value).toBe(1);

    moves.stop();
  });
});
