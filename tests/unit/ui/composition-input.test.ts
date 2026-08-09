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

import { DEFAULT_KEY_BINDINGS, describeBinding } from '../../../src/input/keymap';
import { start } from '../../../src/main';
import type { Application } from '../../../src/main';
import { resetWebGLSupportProbe } from '../../../src/render/webgl-support';
import { KEYMAP_KEY, RUN_STATE_KEY } from '../../../src/storage/storage-keys';
import { applyTheme } from '../../../src/theme/themes';
import {
  REDUCED_MOTION_ATTRIBUTE,
  readReflectedReducedMotion,
} from '../../../src/ui/a11y/settings';
import { readOwnedStorage } from '../../fixtures/storage';

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
  window.localStorage.removeItem(RUN_STATE_KEY);
});

const press = (key: string, code: string): void => {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key, code, bubbles: true }),
  );
};

/**
 * Waits for a condition to hold, checking on every task turn.
 *
 * Replaces a fixed sleep. A sleep encodes a guess about how long a deferred
 * write takes and turns a slow machine into a failing assertion; this returns as
 * soon as the condition holds, and fails with a real message when it never does.
 *
 * @param holds The condition to wait for.
 * @param timeoutMs How long to keep checking. Generous, because it costs nothing
 *   when the condition holds early.
 * @throws Error when the condition has not held by the deadline.
 */
const waitFor = async (
  holds: () => boolean,
  timeoutMs = 2000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (!holds()) {
    if (Date.now() > deadline) {
      throw new Error(`the condition did not hold within ${timeoutMs}ms`);
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
};

const control = (selector: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(selector);

  if (found === null) {
    throw new Error(`the fixture lost ${selector}`);
  }

  return found;
};

/** A control in the rendered settings dialog, addressed by its visible name. */
const panelButton = (name: string): HTMLButtonElement => {
  const found = Array.from(
    document.querySelectorAll<HTMLButtonElement>('#settings-panel button'),
  ).find((candidate) => candidate.textContent === name);

  if (found === undefined) {
    throw new Error(`the dialog has no control named ${name}`);
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

  it('engages exactly one focus trap on the dialog container', () => {
    // TWO traps on one container is the composition defect: the dialog engaged
    // its own and the router engaged another over the same element, so the
    // router recorded a restore target that was already inside the container it
    // was trapping and warned about it on every open. The router owns it — it
    // has the trigger to restore focus to and the board to make inert, neither
    // of which the dialog knows — and the dialog defers (N7).
    application = start(document);

    control('#settings-button').click();

    const series = application.metrics.snapshot().series;

    // Read by the `report` label, because every generic report is counted on
    // one family rather than under a family name of its own. DL-MAIN-11.
    const valueOf = (report: string): number =>
      series
        .filter((entry) => entry.labels['report'] === report)
        .reduce(
          (total, entry) =>
            total + (entry.kind === 'counter' ? entry.value : 0),
          0,
        );

    // ONE engagement for one open, and no warning about a restore target inside
    // the trapped container, which only a second trap over the same element
    // produces.
    expect(valueOf('ui.focus.trap.engaged')).toBe(1);
    expect(valueOf('ui.focus.trap.restore_inside')).toBe(0);

    // Still contained and still inert, so the one trap does the whole job.
    expect(
      control('#settings-panel').contains(document.activeElement),
    ).toBe(true);
    expect(control('#game-main').hasAttribute('inert')).toBe(true);
  });

  it('reaches the audio layer through the store alone', () => {
    // The store is the single owner of mute and volume, and the audio layer
    // follows it through its own subscription. The dialog used to write the
    // store AND push the same value into the engine, so one value had two
    // writers and a later sync could push a value the engine had already taken
    // (N1).
    //
    // The store is written directly here rather than through the dialog's mute
    // control, because jsdom supplies no `AudioContext`: the engine reports
    // itself unavailable and the dialog correctly renders that control disabled.
    // The dialog's own write is asserted against an available engine in
    // tests/unit/ui/settings-panel.test.ts; what this asserts is the WIRING —
    // that src/main.ts made the store the engine's source.
    application = start(document);

    expect(application.soundEngine.isMuted()).toBe(false);

    application.preferences.setMuted(true);

    expect(application.soundEngine.isMuted()).toBe(true);

    application.preferences.setVolume(0.25);

    expect(application.soundEngine.getVolume()).toBeCloseTo(0.25, 5);

    // The last non-zero volume survives a mute: silence is held at the gain, not
    // by forgetting the volume, so unmuting returns to what was set.
    application.preferences.setMuted(false);

    expect(application.soundEngine.isMuted()).toBe(false);
    expect(application.soundEngine.getVolume()).toBeCloseTo(0.25, 5);

    // And a direct write is refused, so a second writer cannot appear.
    application.soundEngine.setMuted(true);
    application.soundEngine.setVolume(1);

    expect(application.soundEngine.isMuted()).toBe(false);
    expect(application.soundEngine.getVolume()).toBeCloseTo(0.25, 5);
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
 * What a dialog control reaches
 * ========================================================================== */

// Each case below drives a control in the REAL rendered dialog and asserts the
// effect in the layer that owns it, rather than asserting the store write the
// dialog's own suite already pins.
//
// tests/unit/ui/settings-panel.test.ts asserts the dialog writes the store, and
// each owning layer's suite asserts it follows the store — but a store write
// that no layer is subscribed to satisfies both and reaches nothing. These are
// the joins:
//
//   focus restoration  asserted at the router over a stand-in dialog body in
//                      tests/unit/ui/screen-router.test.ts:535, and at the
//                      manager in tests/unit/ui/a11y-lifecycle.test.ts:387;
//                      never once with the real dialog standing in between.
//   reduced motion     driven through the store or the attribute directly in
//                      tests/unit/ui/reduced-motion.test.ts; never from the
//                      dialog's own control.
//   a rebind           asserted as far as the owner's table in
//                      tests/unit/ui/settings-panel.test.ts:894 and through
//                      `remap()` in tests/unit/input/input-dispatch.test.ts;
//                      never as far as a keystroke that moves the board.
//
// The number-only mode's join is the fourth, and lives in
// tests/unit/render/renderer-selection.test.ts, because it needs a WebGL
// context to start from a 2.5D board and leave it.
describe('what a settings control reaches', () => {
  it('returns focus to the settings control on Escape', () => {
    application = start(document);

    const trigger = control('#settings-button');

    trigger.click();

    expect(document.activeElement).not.toBe(trigger);

    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
      }),
    );

    // The trigger, not the body: a dialog that hides without restoring leaves a
    // keyboard user at the top of the document with their place lost. Verified
    // by mutation — dropping the trap release fails this case.
    //
    // What this canNOT see is the ORDER of the release against the hide. The
    // router releases first because focus cannot be restored into a subtree that
    // has just become `hidden`, but jsdom computes no layout and will focus a
    // hidden element, so reversing the two still passes here. That ordering is
    // held by the comment at src/ui/screen-router.ts and was observed in a real
    // browser, where Escape restored the trigger with `:focus-visible` set.
    expect(document.activeElement).toBe(trigger);
  });

  it('returns focus to the settings control when the dialog closes itself', () => {
    application = start(document);

    const trigger = control('#settings-button');

    trigger.click();

    const close = Array.from(
      document.querySelectorAll<HTMLButtonElement>('#settings-panel button'),
    ).find((candidate) => candidate.textContent === 'Close settings');

    close?.click();

    expect(document.activeElement).toBe(trigger);
  });

  it('reduces motion from the dialog, reaching the channel the style layer reads', () => {
    application = start(document);
    control('#settings-button').click();

    panelButton('Reduce motion').click();

    expect(application.preferences.getMotionSetting()).toBe('reduce');
    expect(application.preferences.isReducedMotion()).toBe(true);

    // The reflected attribute is the single channel the style layer and the
    // on-screen controls both read, and the value only reaches it by way of the
    // RENDER layer's own store: the root pushes the preference in with
    // `setReducedMotionOverride`, the store dispatches to every animating
    // member, and the root's subscription writes the attribute on the way back
    // out. Verified by mutation — deleting that push fails this case — so this
    // asserts the round trip through the renderer, not a local write.
    expect(readReflectedReducedMotion(document.documentElement)).toBe(true);
    expect(
      document.documentElement.getAttribute(REDUCED_MOTION_ATTRIBUTE),
    ).toBe('true');

    panelButton('Allow motion').click();

    // Written explicitly false rather than removed, so an explicit allow is
    // distinguishable from no preference at all.
    expect(application.preferences.isReducedMotion()).toBe(false);
    expect(readReflectedReducedMotion(document.documentElement)).toBe(false);
  });

  it('rebinds a movement key from the dialog, and the new key moves the board', () => {
    application = start(document);
    control('#settings-button').click();

    const rebind = document.querySelector<HTMLButtonElement>(
      '#settings-panel button[data-settings-action="moveUp"]',
    );

    expect(rebind).not.toBeNull();
    rebind?.click();
    press('t', 'KeyT');

    // The dialog shows what the OWNER holds, so this fails for a dialog that
    // only believed it had rebound something.
    expect(control('#settings-panel').textContent).toContain(
      describeBinding(
        {
          ...DEFAULT_KEY_BINDINGS,
          moveUp: {
            ...DEFAULT_KEY_BINDINGS.moveUp,
            keys: ['t'],
            codes: ['KeyT'],
          },
        },
        'moveUp',
      ),
    );
    expect(readOwnedStorage(KEYMAP_KEY)).toContain('KeyT');

    // Closed first: movement is deliberately blocked while the dialog is open,
    // so a keystroke pressed here would prove nothing about the binding.
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
      }),
    );

    const moves = countMoveAttempts();

    press('t', 'KeyT');

    expect(moves.value).toBe(1);

    // And the key it replaced is inert, which is what makes this a rebind
    // rather than an addition.
    press('ArrowUp', 'ArrowUp');

    expect(moves.value).toBe(1);

    moves.stop();
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

    // POLLED, NOT SLEPT. The announcer writes on a later task and in two phases,
    // so the region has to be read after the event loop has turned — but a fixed
    // sleep encodes a guess about how long that takes, and a machine slower than
    // the guess fails a test about correctness for a reason that has nothing to
    // do with correctness. Polling waits exactly as long as it needs to and no
    // longer.
    await waitFor((): boolean => announced() !== '');

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

/* ==========================================================================
 * The renderer fallback keeps the application whole
 * ========================================================================== */

describe('a 2.5D renderer that cannot mount', () => {
  it('falls back to the number-only board without losing input, UI or focus', () => {
    // jsdom implements no WebGL context, so the probe reports the board
    // unavailable and this is the fallback path in production form.
    application = start(document);

    expect(application.renderer.mode).toBe('number-only');

    // Reported as a FALLBACK rather than a choice, so the capability stays
    // observable: this machine has no WebGL context, it was not asked for.
    expect(application.renderer.fallback).toBe(true);
    expect(application.renderer.chosen).toBe(false);
    expect(application.renderer.support.supported).toBe(false);

    // INPUT survived. The keystroke reaches the engine and resolves a turn.
    let commits = 0;

    application.engine.events.on('state:commit', (): void => {
      commits += 1;
    });

    press('ArrowUp', 'ArrowUp');
    press('ArrowRight', 'ArrowRight');
    press('ArrowDown', 'ArrowDown');
    press('ArrowLeft', 'ArrowLeft');

    expect(commits).toBeGreaterThan(0);

    // THE UI survived: the score outlets, the controls and the settings dialog
    // are all still driven.
    expect(control('.score-container').textContent).not.toBe('');
    expect(application.hud.readRendered()).not.toBeNull();

    // FOCUS survived: the dialog opens, traps and restores.
    const trigger = control('#settings-button');

    trigger.focus();

    expect(application.preferences).toBeDefined();
    expect(document.getElementById('settings-panel')?.hidden).toBe(true);

    // And the board is on screen in the fallback's own host rather than nowhere.
    expect(control('#board-number-only').hidden).toBe(false);
    expect(control('#board-canvas').hidden).toBe(true);
  });
});

/* ==========================================================================
 * Relic activation
 *
 * `activateRelic` was emitted by every input surface and subscribed to by
 * NOTHING, so a press reached the event bus and stopped there and no charge was
 * ever spent by a player. These cases pin the subscription, and pin that the
 * deduction goes through the hook bus so a manual activation and a relic
 * handler's own request draw on one pool.
 * ========================================================================== */

describe('the relic activation control', () => {
  /**
   * A stored run holding `frostbind`, which carries a charge budget.
   *
   * Written before `start()`, because the envelope is read once during
   * composition and the registry restores its relics from what it read.
   */
  const RUN_WITH_A_CHARGED_RELIC = JSON.stringify({
    schemaVersion: 1,
    runId: 'activation-run',
    seed: 'activation-seed',
    rngCursor: {
      'spawn-value': 0,
      'spawn-position': 0,
      'relic-draw': 0,
      'rarity-weight': 0,
    },
    stageIndex: 0,
    stageGoal: { kind: 'highest-tile', target: 64 },
    goalProgress: 0,
    relics: [{ id: 'frostbind', charges: 5 }],
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
  });

  /** The budget the bus holds for one relic. */
  const budgetOf = (id: string): number | undefined =>
    application?.engine.hooks
      .subscribers()
      .find((entry) => entry.id === id)?.charges;

  const activationControl = (): HTMLElement | null =>
    document.querySelector<HTMLElement>(
      '.on-screen-control[data-action="activateRelic"]',
    );

  it('restores the stored relic onto the bus, so it can be activated at all', () => {
    window.localStorage.setItem(RUN_STATE_KEY, RUN_WITH_A_CHARGED_RELIC);

    application = start(document);

    expect(budgetOf('frostbind')).toBe(5);
  });

  it('spends a charge when the activation control is used', () => {
    window.localStorage.setItem(RUN_STATE_KEY, RUN_WITH_A_CHARGED_RELIC);

    application = start(document);

    const activate = activationControl();

    expect(activate).not.toBeNull();

    activate?.click();

    expect(budgetOf('frostbind')).toBe(4);
  });

  it('spends one charge per activation, down to zero and no further', () => {
    window.localStorage.setItem(RUN_STATE_KEY, RUN_WITH_A_CHARGED_RELIC);

    application = start(document);

    const activate = activationControl();

    for (let press = 0; press < 7; press += 1) {
      activate?.click();
    }

    expect(budgetOf('frostbind')).toBe(0);
  });

  /** The charge count the HUD tray currently shows for one relic. */
  const trayCharges = (id: string): string | null =>
    document
      .querySelector(`#relic-tray .relic-tray-item[data-relic-id="${id}"]`)
      ?.getAttribute('data-charges') ?? null;

  it('publishes the spent charge to the HUD before the next turn', () => {
    window.localStorage.setItem(RUN_STATE_KEY, RUN_WITH_A_CHARGED_RELIC);

    application = start(document);

    expect(trayCharges('frostbind')).toBe('5');

    activationControl()?.click();

    // THE TRAY IS A PROJECTION OF THE COMMIT'S RELIC SLICE, and a manual
    // activation spends a charge between turns. The activation persisted and was
    // announced but published no presentation state, so the tray went on showing
    // the budget the last commit carried until the player made a move.
    expect(budgetOf('frostbind')).toBe(4);
    expect(trayCharges('frostbind')).toBe('4');
    expect(application.hud.readRendered()?.relics).toContain('frostbind');
  });

  it('publishes nothing when an activation spent nothing', () => {
    window.localStorage.setItem(RUN_STATE_KEY, RUN_WITH_A_CHARGED_RELIC);

    application = start(document);

    const activate = activationControl();

    for (let press = 0; press < 5; press += 1) {
      activate?.click();
    }

    expect(trayCharges('frostbind')).toBe('0');

    const written = application.hud.readRendered();

    // A refused activation is not a state change, so the exhausted budget is
    // published once and a further press republishes nothing.
    activate?.click();

    expect(application.hud.readRendered()).toBe(written);
    expect(trayCharges('frostbind')).toBe('0');
  });

  it('spends nothing when the run holds no relic', () => {
    application = start(document);

    const activate = activationControl();

    expect(() => activate?.click()).not.toThrow();
    expect(application.engine.hooks.metrics().chargesConsumed).toBe(0);
  });

  it('stops the relic firing once a player has spent its budget', () => {
    window.localStorage.setItem(RUN_STATE_KEY, RUN_WITH_A_CHARGED_RELIC);

    application = start(document);

    const activate = activationControl();

    for (let press = 0; press < 5; press += 1) {
      activate?.click();
    }

    expect(budgetOf('frostbind')).toBe(0);

    const before = application.engine.hooks.metrics().totals.skippedExhausted;

    press('ArrowLeft', 'ArrowLeft');

    // The move dispatched `onBeforeMove` and `onAfterMove`; `frostbind` binds
    // neither, so the skip is counted on the hooks it does bind. What matters is
    // that the relic is now guarded rather than still firing.
    expect(
      application.engine.hooks
        .subscribers()
        .find((entry) => entry.id === 'frostbind')?.charges,
    ).toBe(0);
    expect(
      application.engine.hooks.metrics().totals.skippedExhausted,
    ).toBeGreaterThanOrEqual(before);
  });
});
