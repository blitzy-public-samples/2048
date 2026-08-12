// Integration suite for the composition root's input wiring, AAP R8 and R9.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_KEY_BINDINGS, describeBinding } from '../../../src/input/keymap';
import { start } from '../../../src/main';
import type { Application } from '../../../src/main';
import { resetWebGLSupportProbe } from '../../../src/render/webgl-support';
import { normalizeEnteredSeed } from '../../../src/run/run-controller';
import { KEYMAP_KEY, RUN_STATE_KEY } from '../../../src/storage/storage-keys';
import { applyTheme } from '../../../src/theme/themes';
import {
  REDUCED_MOTION_ATTRIBUTE,
  readReflectedReducedMotion,
} from '../../../src/ui/a11y/settings';
import { COMPOSITION_MARKUP, beginRun } from '../../fixtures/composition';
import { SCREEN_MOUNTS, TRANSITIONS } from '../../../src/ui/screen-router';
import { readOwnedStorage } from '../../fixtures/storage';

/**
 * The document, from tests/fixtures/composition.ts, so this suite reads the
 * markup index.html declares rather than a private copy of part of it.
 *
 * `.container` is the page shell a modal screen makes inert, `.game-message` is
 * the terminal overlay — OUTSIDE `.screen-layer`, exactly as index.html has
 * it — and `#settings-panel` is the dialog.
 */
const MARKUP = COMPOSITION_MARKUP;

/**
 * A board one move from the configured win value.
 *
 * Written to storage BEFORE `start()`, because the engine reads the snapshot
 * once during setup. Two 1024 tiles side by side in the top row: one move left
 * merges them into 2048, which is `winValue`.
 */
const NEAR_WIN_BOARD = {
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

const NEAR_WIN_STATE = JSON.stringify(NEAR_WIN_BOARD);

/**
 * The run this board belongs to: STAGE 7, whose goal is `highest-tile: 2048`.
 *
 * The stage matters, and it is one the win does NOT clear. Every goal below
 * stage 8 on the default curve is at or under 2048, so a run resumed at stage 0
 * on this board has already cleared its stage: the controller draws the payout,
 * the flow stops at stage clear, movement is withheld and the winning move
 * never happens. Stage 8 targets 4096, so the merge to 2048 is a WIN and
 * nothing else, which is what these cases are about. The stage that the win
 * outranks is pinned in tests/unit/run/run-controller.test.ts.
 */
const NEAR_WIN_ENVELOPE = JSON.stringify({
  schemaVersion: 1,
  runId: 'near-win-run',
  seed: 'near-win-seed',
  rngCursor: {
    'spawn-value': 0,
    'spawn-position': 0,
    'relic-draw': 0,
    'rarity-weight': 0,
  },
  stageIndex: 8,
  stageGoal: { kind: 'highest-tile', target: 4096 },
  goalProgress: 0.25,
  relics: [],
  board: NEAR_WIN_BOARD,
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
 * Composes the application and leaves a PLAYABLE BOARD on screen.
 *
 * A load that resumed nothing holds the run-start screen, whose input context
 * withholds movement, so a case about a keystroke reaching the board begins a
 * run first — otherwise it would pass while proving nothing. A load that DID
 * resume one is already on the board, and beginning another would replace the
 * very board the case seeded, so the press is made only from the run-start
 * state.
 *
 * @returns The composed application, with a run open.
 */
const startPlaying = (): Application => {
  const started = start(document);

  application = started;

  if (started.router.current() === 'runStart') {
    beginRun();
  }

  return started;
};

/**
 * Waits for a condition to hold, checking on every task turn.
 *
 * @param holds The condition to wait for.
 * @param timeoutMs How long to keep checking.
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

/**
 * Presses one control the way a real pointer or key press does: focus first,
 * then the activation.
 *
 * `HTMLElement.click()` alone dispatches the event WITHOUT moving focus, which
 * no real press does — and focus is what a dialog records as its restore
 * target, so a case about restoring focus has to move it.
 *
 * @param selector Selector of the control to press.
 */
const pressControl = (selector: string): void => {
  const element = control(selector);

  element.focus();
  element.click();
};

const control = (selector: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(selector);

  if (found === null) {
    throw new Error(`the fixture lost ${selector}`);
  }

  return found;
};

/**
 * A control in the rendered settings dialog, addressed by its visible name.
 */
const panelButton = (name: string): HTMLButtonElement => {
  const found = Array.from(
    document.querySelectorAll<HTMLButtonElement>('#settings-panel button'),
  ).find((candidate) => candidate.textContent === name);

  if (found === undefined) {
    throw new Error(`the dialog has no control named ${name}`);
  }

  return found;
};

/** Counts the move attempts that reach the engine. */
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

describe('one binding owner per markup control', () => {
  it('publishes one restart per click of the New Game control', () => {
    application = startPlaying();

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
    application = startPlaying();

    let commits = 0;
    const stop = application.engine.events.on('state:commit', (): void => {
      commits += 1;
    });

    control('.retry-button').click();

    expect(commits).toBe(1);

    stop();
  });

  it('withdraws only the control whose action the context refuses', () => {
    application = startPlaying();

    const keepPlaying = control('.keep-playing-button');
    const retry = control('.retry-button');

    expect(keepPlaying.hidden).toBe(true);
    expect(keepPlaying.getAttribute('aria-hidden')).toBe('true');

    // `restart` is legal during ordinary play, so "Try again" is never
    // withdrawn and never carries the unavailability attributes.
    expect(retry.hidden).toBe(false);
    expect(retry.getAttribute('aria-hidden')).toBeNull();
    expect(retry.getAttribute('tabindex')).toBeNull();
  });
});

describe('the settings dialog', () => {
  it('opens from the settings control, with its body rendered', () => {
    application = startPlaying();

    const panel = control('#settings-panel');

    expect(panel.hidden).toBe(true);

    pressControl('#settings-button');

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

  it('inerts the screen it opened over, and lifts only that on close', () => {
    // A load that resumed nothing HOLDS run start, so the dialog opens from
    // inside a trapped screen — the one case where a dialog stacks over an
    // overlay root rather than over the board.
    application = start(document);

    expect(application.router.current()).toBe('runStart');

    const screen = control('#screen-run-start');
    const shell = control('.container');

    expect(screen.hasAttribute('inert')).toBe(false);
    expect(shell.hasAttribute('inert')).toBe(true);

    pressControl('#run-start-settings');

    expect(control('#settings-panel').hidden).toBe(false);

    // The screen behind the dialog leaves the accessibility tree with the rest
    // of the background: it lives inside the screen layer, which the shell's
    // inertness does not cover.
    expect(screen.hasAttribute('inert')).toBe(true);

    document
      .querySelector<HTMLButtonElement>('#settings-panel button')
      ?.blur();

    const close = Array.from(
      document.querySelectorAll<HTMLButtonElement>('#settings-panel button'),
    ).find((candidate) => candidate.textContent === 'Close settings');

    close?.focus();
    close?.click();

    expect(control('#settings-panel').hidden).toBe(true);

    // Only what the dialog applied is lifted: the shell stays inert because the
    // run-start screen is still up and still trapping.
    expect(screen.hasAttribute('inert')).toBe(false);
    expect(shell.hasAttribute('inert')).toBe(true);
    expect(control('#screen-run-start').contains(document.activeElement)).toBe(
      true,
    );
  });

  it('holds focus inside the dialog and makes the board inert', () => {
    application = startPlaying();
    pressControl('#settings-button');

    // THE WHOLE PAGE SHELL, not the game region alone: the heading and the
    // footer are behind the dialog too, and `#game-main` is inside `.container`
    // and therefore inert with it.
    expect(control('.container').hasAttribute('inert')).toBe(true);
    expect(
      control('#settings-panel').contains(document.activeElement),
    ).toBe(true);
  });

  it('blocks a movement key while the dialog is open', () => {
    application = startPlaying();

    const moves = countMoveAttempts();

    pressControl('#settings-button');
    press('ArrowDown', 'ArrowDown');

    expect(moves.value).toBe(0);

    moves.stop();
  });

  it('closes on Escape, and movement resumes', () => {
    application = startPlaying();
    pressControl('#settings-button');

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
    application = startPlaying();
    pressControl('#settings-button');

    const close = Array.from(
      document.querySelectorAll<HTMLButtonElement>('#settings-panel button'),
    ).find((candidate) => candidate.textContent === 'Close settings');

    expect(close).toBeDefined();
    close?.click();

    expect(control('#settings-panel').hidden).toBe(true);
  });

  // ADDED: the close hands focus back to the control that opened the dialog.
  // The control layer withholds `#settings-button` for TWO reasons while the
  // dialog is up — `openSettings` is unauthorized in `'settings'`, and the
  // shell the button sits in is inert — and the second is only answerable once
  // the release has lifted the inertness, so the refresh runs from inside the
  // release rather than before it. DL-ROUTER-41, DL-FOCUS-08.
  it('hands focus back to the trigger, re-presenting it first', () => {
    application = startPlaying();

    const trigger = control('#settings-button');

    pressControl('#settings-button');

    // Withheld on both counts while the dialog holds focus.
    expect(control('.container').hasAttribute('inert')).toBe(true);
    expect(trigger.hasAttribute('disabled')).toBe(true);
    expect(trigger.getAttribute('tabindex')).toBe('-1');
    expect(control('#settings-panel').contains(document.activeElement)).toBe(
      true,
    );

    // Sampled AT THE INSTANT focus lands rather than afterwards, because
    // `settle()` refreshes the layer a second time and would make a later
    // reading true either way. This document cannot fail on the ORDERING on its
    // own — it allows focus on a disabled control that still carries
    // `tabindex="-1"`, where a browser refuses it and drops focus to the body —
    // so the ordering is pinned in tests/unit/ui/screen-router.test.ts against
    // the lifted inertness, and this case holds the composed outcome.
    const atRestore: { disabled: boolean; inert: boolean }[] = [];

    trigger.addEventListener('focus', (): void => {
      atRestore.push({
        disabled: trigger.hasAttribute('disabled'),
        inert: control('.container').hasAttribute('inert'),
      });
    });

    const close = Array.from(
      document.querySelectorAll<HTMLButtonElement>('#settings-panel button'),
    ).find((candidate) => candidate.textContent === 'Close settings');

    close?.focus();
    close?.click();

    // Focus landed on the trigger, and it was already interactive when it did.
    expect(document.activeElement).toBe(trigger);
    expect(document.activeElement).not.toBe(document.body);
    expect(atRestore).toEqual([{ disabled: false, inert: false }]);

    // And it stays presented afterwards.
    expect(control('.container').hasAttribute('inert')).toBe(false);
    expect(trigger.hasAttribute('disabled')).toBe(false);
    expect(trigger.getAttribute('tabindex')).toBeNull();
  });

  it('engages exactly one focus trap on the dialog container', () => {
    // TWO traps on one container is the composition defect: the dialog engaged
    // its own and the router engaged another over the same element, so the
    // router recorded a restore target that was already inside the container it
    // was trapping and warned about it on every open. The router owns it — it
    // has the trigger to restore focus to and the board to make inert, neither
    // of which the dialog knows — and the dialog defers (N7).
    const subject = startPlaying();

    // Read by the `report` label, because every generic report is counted on
    // one family rather than under a family name of its own. DL-MAIN-11.
    const valueOf = (report: string): number =>
      subject.metrics
        .snapshot()
        .series.filter((entry) => entry.labels['report'] === report)
        .reduce(
          (total, entry) =>
            total + (entry.kind === 'counter' ? entry.value : 0),
          0,
        );

    // MEASURED AS A DELTA. Every trapping screen state engages one of its own
    // — the run-start screen this case begins its run from is one — so what
    // the dialog costs is the difference the open makes, not the total.
    const engagedBefore = valueOf('ui.focus.trap.engaged');

    pressControl('#settings-button');

    // ONE engagement for one open, and no warning about a restore target inside
    // the trapped container, which only a second trap over the same element
    // produces.
    expect(valueOf('ui.focus.trap.engaged') - engagedBefore).toBe(1);
    expect(valueOf('ui.focus.trap.restore_inside')).toBe(0);

    // Still contained and still inert, so the one trap does the whole job.
    expect(
      control('#settings-panel').contains(document.activeElement),
    ).toBe(true);
    // THE WHOLE PAGE SHELL, not the game region alone: the heading and the
    // footer are behind the dialog too, and `#game-main` is inside `.container`
    // and therefore inert with it.
    expect(control('.container').hasAttribute('inert')).toBe(true);
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
    application = startPlaying();

    expect(application.soundEngine.isMuted()).toBe(false);

    application.preferences.setMuted(true);

    expect(application.soundEngine.isMuted()).toBe(true);

    application.preferences.setVolume(0.25);

    expect(application.soundEngine.getVolume()).toBeCloseTo(0.25, 5);

    // The last non-zero volume survives a mute: silence is held at the gain,
    // not by forgetting the volume, so unmuting returns to what was set.
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
    application = startPlaying();
    pressControl('#settings-button');

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

describe('what a settings control reaches', () => {
  it('returns focus to the settings control on Escape', () => {
    application = startPlaying();

    const trigger = control('#settings-button');

    // Focus first: a real press moves focus to the control, and focus is what
    // the trap records as its restore target.
    trigger.focus();
    trigger.click();

    expect(document.activeElement).not.toBe(trigger);

    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
      }),
    );

    // The trigger, not the body: a dialog that hides without restoring leaves
    // a keyboard user at the top of the document with their place lost.
    expect(document.activeElement).toBe(trigger);
  });

  it('returns focus to the settings control when the dialog closes itself', () => {
    application = startPlaying();

    const trigger = control('#settings-button');

    // Focus first, for the reason the Escape case states: focus is the restore
    // target the trap records.
    trigger.focus();
    trigger.click();

    const close = Array.from(
      document.querySelectorAll<HTMLButtonElement>('#settings-panel button'),
    ).find((candidate) => candidate.textContent === 'Close settings');

    close?.click();

    expect(document.activeElement).toBe(trigger);
  });

  it('reduces motion from the dialog, reaching the channel the style layer reads', () => {
    application = startPlaying();
    pressControl('#settings-button');

    panelButton('Reduce motion').click();

    expect(application.preferences.getMotionSetting()).toBe('reduce');
    expect(application.preferences.isReducedMotion()).toBe(true);

    // The reflected attribute is the single channel the style layer and the
    // on-screen controls both read, and the value only reaches it by way of
    // the RENDER layer's own store: the root pushes the preference in with
    // `setReducedMotionOverride`, the store dispatches to every animating
    // member, and the root's subscription writes the attribute on the way back
    // out.
    expect(readReflectedReducedMotion(document.documentElement)).toBe(true);
    expect(
      document.documentElement.getAttribute(REDUCED_MOTION_ATTRIBUTE),
    ).toBe('true');

    panelButton('Allow motion').click();

    expect(application.preferences.isReducedMotion()).toBe(false);
    expect(readReflectedReducedMotion(document.documentElement)).toBe(false);
  });

  it('rebinds a movement key from the dialog, and the new key moves the board', () => {
    application = startPlaying();
    pressControl('#settings-button');

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

    press('ArrowUp', 'ArrowUp');

    expect(moves.value).toBe(1);

    moves.stop();
  });
});

describe('the live region', () => {
  /** Text of every live region in the document, whitespace collapsed. */
  const announced = (): string =>
    Array.from(document.querySelectorAll('[aria-live]'))
      .map((live) => live.textContent ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

  it('is fed by the root, so a move is actually announced', async () => {
    application = startPlaying();

    expect(announced()).toBe('');

    press('ArrowDown', 'ArrowDown');
    press('ArrowLeft', 'ArrowLeft');

    // Polled, not slept. The announcer writes on a later task and in two
    // phases, so the region has to be read after the event loop has turned —
    // but a fixed sleep encodes a guess about how long that takes, and a
    // machine slower than the guess fails a test about correctness for a
    // reason that has nothing to do with correctness.
    await waitFor((): boolean => announced() !== '');

    // Empty for the entire life of a run before the root constructed and fed
    // an announcer.
    expect(announced()).not.toBe('');
  });

  it('is the only live region: the score outlets are labelled values', () => {
    application = startPlaying();

    const score = control('.score-container');
    const best = control('.best-container');

    // Not live regions. Three regions announcing at once race and suppress one
    // another, so narration belongs to the announcer alone.
    expect(score.getAttribute('role')).toBeNull();
    expect(score.getAttribute('aria-live')).toBeNull();
    expect(best.getAttribute('role')).toBeNull();
    expect(best.getAttribute('aria-live')).toBeNull();

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

describe('the win overlay', () => {
  beforeEach(() => {
    window.localStorage.setItem('gameState', NEAR_WIN_STATE);
    window.localStorage.setItem(RUN_STATE_KEY, NEAR_WIN_ENVELOPE);
  });

  it('makes Keep Going reachable, and continues play from the key', () => {
    application = startPlaying();

    const keepPlaying = control('.keep-playing-button');
    const overlay = control('.game-message');

    // Before the win: unreachable, which is correct — and was the ONLY state
    // it ever had.
    expect(keepPlaying.hidden).toBe(true);

    // One move left merges the two 1024 tiles into the configured win value.
    press('ArrowLeft', 'ArrowLeft');

    expect(overlay.classList.contains('game-won')).toBe(true);
    expect(application.engine.isGameTerminated()).toBe(true);

    // CHANGED: the RETAINED control stays withdrawn, because the `won` state
    // marks the page shell it sits in `inert` and the control layer no longer
    // presents a control its host has put out of reach. The operable control is
    // the one the state renders inside its own trapped container, which is what
    // `SCREEN_TRAPS_FOCUS` of ../screen-router already said was carrying the
    // actions. DL-CONTROL-11.
    expect(control('.container').hasAttribute('inert')).toBe(true);
    expect(keepPlaying.hidden).toBe(true);

    const offered = control('#screen-game-over [data-action="keepPlaying"]');

    expect(offered.hidden).toBe(false);
    expect(offered.getAttribute('aria-hidden')).not.toBe('true');
    expect(offered.getAttribute('tabindex')).not.toBe('-1');

    // And the key reaches the action, which nothing did before: it had no key
    // at all and its only context was one the page never entered.
    press('c', 'KeyC');

    expect(application.engine.isGameTerminated()).toBe(false);
    expect(overlay.classList.contains('game-won')).toBe(false);

    // The shell is reachable again — and the retained control stays withdrawn
    // for its ORIGINAL reason, the one the reachability term did not replace:
    // `keepPlaying` is declared for the `'overlay'` context alone, and the board
    // is back in the `'game'` one.
    expect(control('.container').hasAttribute('inert')).toBe(false);
    expect(application.router.current()).toBe('stage');
    expect(keepPlaying.hidden).toBe(true);
  });

  it('continues play from the control as well as the key', () => {
    application = startPlaying();

    press('ArrowLeft', 'ArrowLeft');

    expect(application.engine.isGameTerminated()).toBe(true);

    // CHANGED: the state's own control, inside the container the trap holds,
    // rather than the retained one behind the inert shell. DL-CONTROL-11.
    pressControl('#screen-game-over [data-action="keepPlaying"]');

    expect(application.engine.isGameTerminated()).toBe(false);
  });

  it('takes the movement controls out of reach while it is shown', () => {
    application = startPlaying();

    const moveUp = document.querySelector<HTMLElement>(
      '[data-action="moveUp"]',
    );

    expect(moveUp?.hidden).toBe(false);

    press('ArrowLeft', 'ArrowLeft');

    expect(moveUp?.hidden).toBe(true);

    pressControl('#screen-game-over [data-action="keepPlaying"]');

    expect(moveUp?.hidden).toBe(false);
  });

  it('blocks a movement key while the overlay is shown', () => {
    application = startPlaying();

    press('ArrowLeft', 'ArrowLeft');

    const moves = countMoveAttempts();

    press('ArrowDown', 'ArrowDown');

    expect(moves.value).toBe(0);

    // And released once the overlay is dismissed, so the block is the
    // overlay's and not a permanent one.
    pressControl('#screen-game-over [data-action="keepPlaying"]');
    press('ArrowDown', 'ArrowDown');

    expect(moves.value).toBe(1);

    moves.stop();
  });

  it('carries no verdict once the run has ended and the summary shows', () => {
    application = startPlaying();

    const overlay = control('.game-message');

    press('ArrowLeft', 'ArrowLeft');

    expect(overlay.classList.contains('game-won')).toBe(true);

    // The run ENDS here rather than continuing, so no further commit arrives
    // to clear the retained overlay: the flow reaching a screen that renders
    // its own verdict is what clears it.
    pressControl('#screen-game-over [data-action="endRun"]');

    expect(application.router.current()).toBe('runSummary');
    expect(overlay.classList.contains('game-won')).toBe(false);
    expect(overlay.classList.contains('game-over')).toBe(false);

    // And it stays clear through the edge that opens a fresh run.
    pressControl('#screen-run-summary [data-action="newRun"]');

    expect(application.router.current()).toBe('runStart');
    expect(overlay.classList.contains('game-won')).toBe(false);
  });
});

describe('a 2.5D renderer that cannot mount', () => {
  it('falls back to the number-only board without losing input, UI or focus', () => {
    // jsdom implements no WebGL context, so the probe reports the board
    // unavailable and this is the fallback path in production form.
    application = startPlaying();

    expect(application.renderer.mode).toBe('number-only');

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

    expect(control('#board-number-only').hidden).toBe(false);
    expect(control('#board-canvas').hidden).toBe(true);
  });
});

/* ==========================================================================
 * Relic inspection
 *
 * `activateRelic` was emitted by every input surface and subscribed to by
 * NOTHING, so a press reached the event bus and stopped there. The subscription
 * written for it then DEBITED A CHARGE BUDGET AND PRODUCED NO EFFECT: every
 * charge-limited relic in the catalogue is automatic — Temporal Anchor, Tumbler,
 * Culling Blade and Scouring Wind each fire on a hook they bound, and Frostbind
 * on the merge it freezes — and each asks for its charge on that one dispatch.
 * There is no manual effect for a press to invoke, so a press that spent a
 * charge bought nothing with it and made the relic fire fewer times than its
 * budget declares.
 *
 * The press is now an INSPECTION: it reads the live budget and the relic's
 * description out to the live region and spends nothing. These cases pin the
 * subscription, pin that the press costs nothing however often it is made, and
 * pin that the budget still falls — on the dispatch the relic acted on, which is
 * the only place it may. DL-RUNCTL-18.
 * ========================================================================== */

describe('the relic inspection control', () => {
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

  /**
   * The same stored run, holding `frostbind` on its LAST charge, over a board
   * carrying two mergeable pairs on two different rows.
   *
   * Pressing Left resolves both pairs in one move, so `onMerge` is dispatched
   * twice: the first dispatch spends the last charge and the second finds the
   * budget exhausted. That is the whole life of a charge budget — spent by the
   * effect that used it, then guarded — in a single keystroke.
   */
  const RUN_WITH_ONE_CHARGE_LEFT = JSON.stringify({
    schemaVersion: 1,
    runId: 'inspection-run',
    seed: 'inspection-seed',
    rngCursor: {
      'spawn-value': 0,
      'spawn-position': 0,
      'relic-draw': 0,
      'rarity-weight': 0,
    },
    stageIndex: 0,
    stageGoal: { kind: 'highest-tile', target: 64 },
    goalProgress: 0,
    relics: [{ id: 'frostbind', charges: 1 }],
    board: {
      grid: {
        size: 4,
        cells: [
          [
            { position: { x: 0, y: 0 }, value: 2 },
            { position: { x: 0, y: 1 }, value: 4 },
            null,
            null,
          ],
          [
            { position: { x: 1, y: 0 }, value: 2 },
            { position: { x: 1, y: 1 }, value: 4 },
            null,
            null,
          ],
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

  const activationControl = (): HTMLElement | null =>
    document.querySelector<HTMLElement>(
      '.on-screen-control[data-action="activateRelic"]',
    );

  /** Text of every live region in the document, whitespace collapsed. */
  const announcedText = (): string =>
    Array.from(document.querySelectorAll('[aria-live]'))
      .map((live) => live.textContent ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

  it('restores the stored relic onto the bus, so its budget is live at all', () => {
    window.localStorage.setItem(RUN_STATE_KEY, RUN_WITH_A_CHARGED_RELIC);

    application = startPlaying();

    expect(budgetOf('frostbind')).toBe(5);
  });

  it('reads the live budget out and spends nothing', async () => {
    window.localStorage.setItem(RUN_STATE_KEY, RUN_WITH_A_CHARGED_RELIC);

    application = startPlaying();

    const activate = activationControl();

    expect(activate).not.toBeNull();

    activate?.click();

    // THE PRESS COSTS NOTHING. It debited one charge here, which bought no
    // board effect: the relic's effect is its `onMerge` toggle and the press
    // does not reach it.
    expect(budgetOf('frostbind')).toBe(5);

    // The boot's own announcement is already standing in the region, so the wait
    // is for THIS press's reading rather than for any text at all.
    await waitFor((): boolean => announcedText().includes('Slot 1'));

    // What the press IS: the slot, the relic's name and the budget still
    // standing, read from the live registry rather than the catalogue.
    const spoken = announcedText();

    expect(spoken).toContain('Slot 1');
    expect(spoken).toContain('Frostbind');
    expect(spoken).toContain('5 charges remaining');
  });

  it('spends nothing however many times the control is pressed', () => {
    window.localStorage.setItem(RUN_STATE_KEY, RUN_WITH_A_CHARGED_RELIC);

    application = startPlaying();

    const activate = activationControl();

    for (let press = 0; press < 7; press += 1) {
      activate?.click();
    }

    // Seven presses drained the budget to zero and the relic then stopped
    // firing for the rest of the run, having acted twice.
    expect(budgetOf('frostbind')).toBe(5);
    expect(application.engine.hooks.metrics().chargesConsumed).toBe(0);
  });

  it('spends a charge on the dispatch the relic acted on, and only there', () => {
    window.localStorage.setItem(RUN_STATE_KEY, RUN_WITH_ONE_CHARGE_LEFT);

    application = startPlaying();

    expect(budgetOf('frostbind')).toBe(1);

    const skippedBefore =
      application.engine.hooks.metrics().totals.skippedExhausted;

    press('ArrowLeft', 'ArrowLeft');

    // The merge is where the toggle happened, so the merge is where the charge
    // went — and the second merge of the same move found the budget exhausted
    // and was skipped rather than acting for free.
    expect(budgetOf('frostbind')).toBe(0);
    expect(application.engine.hooks.metrics().chargesConsumed).toBe(1);
    expect(
      application.engine.hooks.metrics().totals.skippedExhausted,
    ).toBeGreaterThan(skippedBefore);
  });

  /** The charge count the HUD tray currently shows for one relic. */
  const trayCharges = (id: string): string | null =>
    document
      .querySelector(`#relic-tray .relic-tray-item[data-relic-id="${id}"]`)
      ?.getAttribute('data-charges') ?? null;

  it('publishes no presentation state, because an inspection is not one', () => {
    window.localStorage.setItem(RUN_STATE_KEY, RUN_WITH_A_CHARGED_RELIC);

    application = startPlaying();

    expect(trayCharges('frostbind')).toBe('5');

    const written = application.hud.readRendered();

    activationControl()?.click();

    // THE TRAY IS A PROJECTION OF THE COMMIT'S RELIC SLICE. A press changes no
    // charge and no board, so there is nothing for it to publish and the tray
    // rightly goes on showing what the last commit carried.
    expect(application.hud.readRendered()).toBe(written);
    expect(trayCharges('frostbind')).toBe('5');
    expect(application.hud.readRendered()?.relics).toContain('frostbind');
  });

  it('shows the tray the charge an effect spent, on the next commit', () => {
    window.localStorage.setItem(RUN_STATE_KEY, RUN_WITH_ONE_CHARGE_LEFT);

    application = startPlaying();

    expect(trayCharges('frostbind')).toBe('1');

    press('ArrowLeft', 'ArrowLeft');

    // The merge that spent it also committed, and the tray is a projection of
    // that commit, so the budget the player sees is the budget the bus holds.
    expect(budgetOf('frostbind')).toBe(0);
    expect(trayCharges('frostbind')).toBe('0');
  });

  it('spends nothing when the run holds no relic', () => {
    application = startPlaying();

    const activate = activationControl();

    expect(() => activate?.click()).not.toThrow();
    expect(application.engine.hooks.metrics().chargesConsumed).toBe(0);
  });

  it('stops the relic firing once its own effect has spent the budget', () => {
    window.localStorage.setItem(RUN_STATE_KEY, RUN_WITH_ONE_CHARGE_LEFT);

    application = startPlaying();

    press('ArrowLeft', 'ArrowLeft');

    expect(budgetOf('frostbind')).toBe(0);

    const before = application.engine.hooks.metrics().totals.skippedExhausted;

    press('ArrowUp', 'ArrowUp');
    press('ArrowLeft', 'ArrowLeft');

    // Exhausted and therefore guarded: whatever merges the later moves resolve,
    // the relic no longer acts on them.
    expect(budgetOf('frostbind')).toBe(0);
    expect(
      application.engine.hooks.metrics().totals.skippedExhausted,
    ).toBeGreaterThanOrEqual(before);
  });
});

/* ==========================================================================
 * The three screen-flow actions
 *
 * `startRun`, `continueStage` and `endRun` are the three actions
 * src/input/keymap.ts declares for a screen's own control, and src/main.ts
 * L2963-2989 subscribes each one at the root: `startRun` starts a run through
 * `startNewRun` with the payload forwarded, and the other two send a trigger to
 * the router rather than acting on the run themselves.
 *
 * The five screen containers index.html declares are appended here, because the
 * shared fixture above carries only the HUD and the dialog and the router
 * resolves the rest by the selectors of `SCREEN_MOUNTS`. Appended BEFORE
 * `start()`, since the router resolves every container while it is starting.
 * ========================================================================== */

describe('the three screen-flow actions', () => {
  /** The five containers the router shows and hides, keyed by state. */
  const FLOW_MOUNTS = Object.freeze([
    SCREEN_MOUNTS.runStart,
    SCREEN_MOUNTS.stageClear,
    SCREEN_MOUNTS.reward,
    SCREEN_MOUNTS.won,
    SCREEN_MOUNTS.runSummary,
  ]);

  beforeEach(() => {
    const layer = control('#screen-layer');

    for (const selector of new Set(FLOW_MOUNTS)) {
      const host = document.createElement('div');

      host.className = 'screen';
      host.id = selector.slice(1);
      host.hidden = true;
      layer.prepend(host);
    }
  });

  /** Every flow container currently on screen, by selector. */
  const shownScreens = (): readonly string[] =>
    Array.from(new Set(FLOW_MOUNTS)).filter(
      (selector) =>
        document.querySelector<HTMLElement>(selector)?.hidden === false,
    );

  /** The generated on-screen control for one action. */
  const generated = (action: string): HTMLButtonElement => {
    const found = document.querySelector<HTMLButtonElement>(
      `.on-screen-control[data-action="${action}"]`,
    );

    if (found === null) {
      throw new Error(`no control was generated for ${action}`);
    }

    return found;
  };

  /** A board whose highest tile is 8, under stage 0's goal of tile 16. */
  const OPEN_STATE = JSON.stringify({
    grid: {
      size: 4,
      cells: [
        [{ position: { x: 0, y: 0 }, value: 8 }, null, null, null],
        [{ position: { x: 1, y: 0 }, value: 2 }, null, null, null],
        [null, null, null, null],
        [null, null, null, null],
      ],
    },
    score: 8,
    over: false,
    won: false,
    keepPlaying: false,
  });

  /**
   * A run one move from the win value under a goal it cannot meet.
   *
   * The seed is what makes the envelope adoptable: `resolveRunIdentity` reads
   * the stored envelope's identity, so the composed run plays `won-seed` rather
   * than originating one, and the unreachable `score-threshold` goal is what
   * keeps `stage:end` from taking the board to the reward offer before the win
   * is reached.
   */
  const NEAR_WIN_RUN = JSON.stringify({
    schemaVersion: 1,
    runId: 'flow-run',
    seed: 'won-seed',
    rngCursor: {
      'spawn-value': 0,
      'spawn-position': 0,
      'relic-draw': 0,
      'rarity-weight': 0,
    },
    stageIndex: 0,
    stageGoal: { kind: 'score-threshold', target: 9_000_000 },
    goalProgress: 0,
    relics: [],
    board: {
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
    },
  });

  /** Every router report the log holds that carries a trigger. */
  const routerRecords = (): readonly Readonly<Record<string, unknown>>[] => {
    const app = application;

    if (app === null) {
      throw new Error('start() has not run');
    }

    return app.logger
      .snapshot()
      .records.filter(
        (entry) => entry.fields?.context === 'screen-router',
      )
      .map((entry) => ({ message: entry.message, ...entry.fields }));
  };

  it('binds no key to any of them and offers all three as controls', () => {
    application = start(document);

    // NO KEY, BY DECLARATION. Each is activated by a screen's own control, so
    // the generated control is the only surface that publishes it, which is why
    // the context gating below is the whole of their availability.
    for (const action of ['startRun', 'continueStage', 'endRun'] as const) {
      expect(DEFAULT_KEY_BINDINGS[action].keys).toEqual([]);
      expect(DEFAULT_KEY_BINDINGS[action].codes).toEqual([]);
      expect(DEFAULT_KEY_BINDINGS[action].contexts).toEqual(['overlay']);
      expect(generated(action).getAttribute('data-action')).toBe(action);
    }
  });

  it('withdraws all three while the board is in play, so each is inert', () => {
    window.localStorage.setItem('gameState', OPEN_STATE);

    application = start(document);

    const seed = application.run.seed();
    const runId = application.run.runId();

    // The board is in play: the goal is tile 16 and the highest tile is 8, so
    // no stage ended and the router holds `stage`.
    expect(shownScreens()).toEqual([]);
    expect(control(SCREEN_MOUNTS.stage).hidden).toBe(false);

    for (const action of ['startRun', 'continueStage', 'endRun'] as const) {
      const element = generated(action);

      expect(element.hidden).toBe(true);
      expect(element.disabled).toBe(true);
      expect(element.getAttribute('aria-hidden')).toBe('true');
      expect(element.getAttribute('tabindex')).toBe('-1');

      element.click();
    }

    // AND NOTHING HAPPENED. All three are declared for `'overlay'` alone, so a
    // press during play publishes nothing: the run is the one that was playing
    // and the router is still on the board.
    expect(application.run.seed()).toBe(seed);
    expect(application.run.runId()).toBe(runId);
    expect(shownScreens()).toEqual([]);
    expect(control(SCREEN_MOUNTS.stage).hidden).toBe(false);
  });

  it('takes the win state to the run summary from the endRun control', () => {
    window.localStorage.setItem(RUN_STATE_KEY, NEAR_WIN_RUN);

    application = start(document);

    // The stored identity was adopted, so the run below is the run the envelope
    // describes rather than a fresh one.
    expect(application.run.seed()).toBe('won-seed');
    expect(application.run.stageGoal()).toEqual({
      kind: 'score-threshold',
      target: 9_000_000,
    });

    press('ArrowLeft', 'ArrowLeft');

    // `stage --winReached--> won`, whose container is the terminal one.
    expect(application.engine.isGameTerminated()).toBe(true);
    expect(shownScreens()).toEqual([SCREEN_MOUNTS.won]);

    // CHANGED: the generated control is WITHHELD here, and the state's own
    // control is the surface that publishes the action. The `won` state marks
    // the page shell `inert`, and the control layer no longer presents a control
    // whose host has put it out of reach — every liveness signal read live while
    // a real press did nothing at all. DL-CONTROL-11.
    const endRun = generated('endRun');

    expect(control('.container').hasAttribute('inert')).toBe(true);
    expect(endRun.hidden).toBe(true);
    expect(endRun.disabled).toBe(true);
    expect(endRun.getAttribute('tabindex')).toBe('-1');

    endRun.click();

    // The withheld control published nothing: the state is unchanged.
    expect(shownScreens()).toEqual([SCREEN_MOUNTS.won]);

    control(SCREEN_MOUNTS.won)
      .querySelector<HTMLElement>('[data-action="endRun"]')
      ?.click();

    // THE REAL EDGE, and the only one this state declares for the trigger.
    expect(TRANSITIONS.won.endRun).toBe('runSummary');
    expect(shownScreens()).toEqual([SCREEN_MOUNTS.runSummary]);
    expect(control(SCREEN_MOUNTS.won).hidden).toBe(true);
    expect(
      routerRecords().some(
        (record) =>
          record.from === 'won' &&
          record.to === 'runSummary' &&
          record.trigger === 'endRun',
      ),
    ).toBe(true);
  });

  it('starts a fresh run from the begin control, back on the board', () => {
    window.localStorage.setItem(RUN_STATE_KEY, NEAR_WIN_RUN);

    application = start(document);

    press('ArrowLeft', 'ArrowLeft');

    // The state's own control, for the reason the test above states.
    control(SCREEN_MOUNTS.won)
      .querySelector<HTMLElement>('[data-action="endRun"]')
      ?.click();

    expect(shownScreens()).toEqual([SCREEN_MOUNTS.runSummary]);

    // THE SUMMARY'S OWN EDGE COMES FIRST. A seed is entered on `runStart` and
    // nowhere else, so the summary's New Run control sends the `newRun` trigger
    // and the screen it lands on is the one that begins the run.
    expect(TRANSITIONS.runSummary.newRun).toBe('runStart');

    control(SCREEN_MOUNTS.runSummary)
      .querySelector<HTMLElement>('[data-action="newRun"]')
      ?.click();

    expect(shownScreens()).toEqual([SCREEN_MOUNTS.runStart]);

    // AND THE GENERATED CONTROL IS NOT THE SURFACE HERE, for two reasons now.
    // All three flow actions are declared for the `'overlay'` context alone, and
    // the screen's trap puts focus in the seed field — a text field holding
    // focus resolves the context to `'textEntry'`, which outranks every screen.
    // The second reason is sufficient on its own: `runStart` marks the page
    // shell `inert`, so the layer withholds every control inside it. The screen
    // renders its own begin control instead. DL-ROUTER-06, DL-RUNSTART-02,
    // DL-CONTROL-11.
    expect(application.router.context()).toBe('textEntry');
    expect(control('.container').hasAttribute('inert')).toBe(true);
    expect(generated('startRun').hidden).toBe(true);

    // The begin control, which is the composed surface that publishes `startRun`.
    expect(beginRun()).toBe(true);

    // A NEW RUN, not a reseeded board: the seed and the run identifier are both
    // replaced, and the seed is an originated token rather than the one the
    // envelope carried.
    expect(application.run.seed()).not.toBe('won-seed');
    expect(application.run.runId()).not.toBe('flow-run');
    expect(application.run.seed()).toHaveLength(32);

    // And the board is playable again, with the flow back on the HUD.
    expect(application.engine.isGameTerminated()).toBe(false);
    expect(shownScreens()).toEqual([]);
    expect(control(SCREEN_MOUNTS.stage).hidden).toBe(false);

    const moves = countMoveAttempts();

    press('ArrowDown', 'ArrowDown');

    expect(moves.value).toBe(1);

    moves.stop();
  });

  it('sends the stage-end trigger from the continueStage control', () => {
    // The restored board's highest tile is already past stage 0's goal, so the
    // stage ends as the board opens — and the flow STOPS at the interstitial:
    // `readStageEnd` takes `stage -> stageClear` and no further, so the second
    // edge is the player's. Decision DL-ROUTER-31.
    window.localStorage.setItem('gameState', NEAR_WIN_STATE);

    application = start(document);

    expect(shownScreens()).toEqual([SCREEN_MOUNTS.stageClear]);

    // CHANGED: withheld for the same reason as `endRun` above — `stageClear`
    // marks the shell inert — and the interstitial's own continue control is the
    // surface that publishes the action. DL-CONTROL-11.
    const continueStage = generated('continueStage');

    expect(control('.container').hasAttribute('inert')).toBe(true);
    expect(continueStage.hidden).toBe(true);

    continueStage.click();

    expect(shownScreens()).toEqual([SCREEN_MOUNTS.stageClear]);

    control(SCREEN_MOUNTS.stageClear)
      .querySelector<HTMLElement>('.stage-progress-continue')
      ?.click();

    // THE EDGE THE ROOT'S TRIGGER TAKES, declared by the state machine and taken
    // by that very trigger — which is what makes the subscription observable
    // from here rather than only its effect.
    expect(TRANSITIONS.stageClear.stageEnd).toBe('reward');
    expect(
      routerRecords().some(
        (record) =>
          record.from === 'stageClear' &&
          record.to === 'reward' &&
          record.trigger === 'stageEnd',
      ),
    ).toBe(true);
    expect(shownScreens()).toEqual([SCREEN_MOUNTS.reward]);

    // And the interstitial's own control goes with the state that offered it.
    expect(control(SCREEN_MOUNTS.stageClear).hidden).toBe(true);
    expect(generated('continueStage').hidden).toBe(true);
  });

  it('plays the seed a startRun payload carries, reduced only', () => {
    application = start(document);

    // `startNewRun` is what the root hands the forwarded payload to, and it
    // applies the run-start screen's own reduction and nothing else. The screen
    // side of the same chain — that the control emits the reduced seed as the
    // payload — is pinned in tests/unit/ui/run-start.test.ts.
    const played = application.startNewRun('  Seeded Run  ');

    expect(played).toBe(normalizeEnteredSeed('  Seeded Run  '));
    expect(played).toBe('Seeded Run');
    expect(application.run.seed()).toBe(played);

    // AND NO PAYLOAD ORIGINATES ONE, which is the other half of the forwarded
    // `string | undefined`.
    const originated = application.startNewRun();

    expect(originated).not.toBe(played);
    expect(originated).toHaveLength(32);
    expect(application.run.seed()).toBe(originated);

    // A seed that trims to nothing is not played as an empty string: the
    // reduction originates a token for it, so the field's whitespace never
    // reaches the substreams.
    const blank = application.startNewRun('   ');

    expect(blank).not.toBe('');
    expect(blank.trim()).toBe(blank);
    expect(blank).toHaveLength(32);
    expect(application.run.seed()).toBe(blank);
    expect(normalizeEnteredSeed('   ')).toHaveLength(32);
  });
});
