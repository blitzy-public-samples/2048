// @vitest-environment jsdom
//
// Suite for src/ui/screens/game-over.ts: the module both terminal states are
// served by, and the retained `.game-message` overlay it writes.
//
// WHAT THIS FILE PINS
//   verbatim verdict   the two classes js/html_actuator.js L128 computed and
//                      the two strings L129 computed reach both surfaces as
//                      they were computed there.
//   loss before win    `resolveTerminalState` tests `over` FIRST, so a turn
//                      carrying both flags reads as a loss — the inversion a
//                      board-mutating relic can produce.
//   declared actions   a state offers exactly the edges `TRANSITIONS` declares
//                      for it, a control with no callback is not built, and a
//                      control the state does not offer is not in the document.
//   one placement      focus lands on the marked control of the state entered,
//                      and a refresh carrying the other verdict re-places it.
//   one announcement   the verdict is announced once while the state stands,
//                      and again after `leave` released it.
//   restores what it   `clear` and `destroy` leave the retained markup and the
//   changed            container's own name exactly as they were found.

import { afterEach, describe, expect, it } from 'vitest';

import { motion } from '../../../src/theme/tokens';
import { FOCUS_INITIAL_ATTRIBUTE } from '../../../src/ui/a11y/focus-manager';
import type { UiReportFields, UiReporter } from '../../../src/ui/a11y/settings';
import {
  OVERLAY_CADENCE,
  SCREEN_MOUNTS,
  TERMINAL_OVERLAY_SELECTOR,
  TRANSITIONS,
  createScreenRouter,
} from '../../../src/ui/screen-router';
import type {
  ScreenContext,
  TerminalScreenContext,
  TerminalScreenName,
} from '../../../src/ui/screen-router';
import {
  GAME_OVER_ACTION_ATTRIBUTE,
  GAME_OVER_CADENCE,
  GAME_OVER_CLASSES,
  GAME_OVER_OVERLAY_SELECTOR,
  GAME_OVER_VERDICT_SELECTOR,
  TERMINAL_ACTIONS_BY_STATE,
  TERMINAL_FLAGS_BY_STATE,
  TERMINAL_STATES,
  TERMINAL_STATE_CLASSES,
  TERMINAL_STATE_MESSAGES,
  TERMINAL_VERDICTS,
  createGameOverScreen,
  gameOverCopy,
  isTerminalScreenName,
  resolveTerminalState,
} from '../../../src/ui/screens/game-over';
import type {
  GameOverScreen,
  GameOverScreenOptions,
} from '../../../src/ui/screens/game-over';

/* ==========================================================================
 * Harness
 * ========================================================================== */

interface Report {
  readonly kind: 'log' | 'count' | 'error';
  readonly name: string;
  readonly fields?: UiReportFields | undefined;
}

interface Sink extends UiReporter {
  readonly reports: Report[];
  counts(metric: string): Report[];
  errors(): Report[];
}

function sink(): Sink {
  const reports: Report[] = [];

  return {
    reports,
    log(level, message, fields): void {
      reports.push({ kind: 'log', name: `${level}:${message}`, fields });
    },
    count(metric, fields): void {
      reports.push({ kind: 'count', name: metric, fields });
    },
    error(message, _error, fields): void {
      reports.push({ kind: 'error', name: message, fields });
    },
    counts(metric): Report[] {
      return reports.filter(
        (entry) => entry.kind === 'count' && entry.name === metric,
      );
    },
    errors(): Report[] {
      return reports.filter((entry) => entry.kind === 'error');
    },
  };
}

interface Spoken {
  readonly lines: unknown[];
  announce(input: unknown): void;
}

function announcer(): Spoken {
  const lines: unknown[] = [];

  return {
    lines,
    announce(input): void {
      lines.push(input);
    },
  };
}

/**
 * The retained overlay of index.html and the container this state mounts into.
 *
 * The overlay is OUTSIDE `.screen-layer`, exactly as index.html has it, so a
 * case cannot pass by finding it in the wrong place.
 */
function page(): { readonly host: HTMLElement; readonly overlay: HTMLElement } {
  document.body.innerHTML =
    `<main id="game-main">` +
    `<div class="game-container"><div class="game-message"><p></p>` +
    `<div class="lower">` +
    `<button type="button" class="keep-playing-button">Keep going</button>` +
    `<button type="button" class="retry-button">Try again</button>` +
    `</div></div></div></main>` +
    `<div class="screen-layer" id="screen-layer">` +
    `<div class="screen" id="screen-game-over" data-screen="game-over"` +
    ` role="dialog" aria-modal="true" aria-label="Game over"></div>` +
    `</div>`;

  const host = document.querySelector<HTMLElement>(SCREEN_MOUNTS.gameOver);
  const overlay = document.querySelector<HTMLElement>(
    GAME_OVER_OVERLAY_SELECTOR,
  );

  if (host === null || overlay === null) {
    throw new Error('fixture markup missing');
  }

  return { host, overlay };
}

function context(
  overrides: Partial<TerminalScreenContext> = {},
): ScreenContext {
  const screen: TerminalScreenName = overrides.screen ?? 'gameOver';

  return {
    screen,
    trigger: screen === 'won' ? 'winReached' : 'noMovesAvailable',
    reducedMotion: false,
    host: document.querySelector(SCREEN_MOUNTS.gameOver),
    refresh: false,
    verdict: TERMINAL_VERDICTS[screen],
    message: TERMINAL_STATE_MESSAGES[screen],
    overlayClass: TERMINAL_STATE_CLASSES[screen],
    score: 512,
    bestScore: '4096',
    cadence: OVERLAY_CADENCE,
    ...overrides,
  };
}

interface Harness {
  readonly screen: GameOverScreen;
  readonly reporter: Sink;
  readonly voice: Spoken;
  readonly host: HTMLElement;
  readonly overlay: HTMLElement;
}

/** A mounted screen with all three callbacks attached. */
function mounted(options: Partial<GameOverScreenOptions> = {}): Harness {
  const { host, overlay } = page();
  const reporter = sink();
  const voice = announcer();
  const screen = createGameOverScreen({
    reporter,
    announcer: voice,
    onKeepPlaying: (): void => undefined,
    onEndRun: (): void => undefined,
    onAcknowledge: (): void => undefined,
    ...options,
  });

  screen.mount(host);

  return { screen, reporter, voice, host, overlay };
}

/** One control the panel rendered, addressed by its action. */
const action = (
  host: HTMLElement,
  name: string,
): HTMLButtonElement | null =>
  host.querySelector<HTMLButtonElement>(
    `.${GAME_OVER_CLASSES.button}[${GAME_OVER_ACTION_ATTRIBUTE}="${name}"]`,
  );

afterEach(() => {
  document.body.innerHTML = '';
});

/* ==========================================================================
 * 1. The verbatim contract
 * ========================================================================== */

describe('the verbatim contract', () => {
  it('carries the two classes and the two strings unchanged', () => {
    expect(TERMINAL_STATES).toEqual(['won', 'gameOver']);
    expect(TERMINAL_STATE_CLASSES).toEqual({
      won: 'game-won',
      gameOver: 'game-over',
    });
    expect(TERMINAL_STATE_MESSAGES).toEqual({
      won: 'You win!',
      gameOver: 'Game over!',
    });
    expect(gameOverCopy.wonVerdict).toBe(TERMINAL_STATE_MESSAGES.won);
    expect(gameOverCopy.lossVerdict).toBe(TERMINAL_STATE_MESSAGES.gameOver);
  });

  it('reads its two selectors and its cadence from the router', () => {
    expect(GAME_OVER_OVERLAY_SELECTOR).toBe(TERMINAL_OVERLAY_SELECTOR);
    expect(GAME_OVER_CADENCE).toBe(OVERLAY_CADENCE);

    // The interval the recorded-gameplay gate's waits are calibrated to: the
    // 800 ms fade after the 1200 ms delay, from the token layer.
    expect(GAME_OVER_CADENCE.delay).toBe(motion.fadeIn.delay);
    expect(GAME_OVER_CADENCE.duration).toBe(motion.fadeIn.duration);
    expect(GAME_OVER_CADENCE.total).toBe(
      motion.fadeIn.delay + motion.fadeIn.duration,
    );
  });

  it('offers exactly the edges the transition table declares', () => {
    expect(TERMINAL_ACTIONS_BY_STATE.won).toEqual(['keepPlaying', 'endRun']);
    expect(TERMINAL_ACTIONS_BY_STATE.gameOver).toEqual(['acknowledge']);

    for (const state of TERMINAL_STATES) {
      expect(Object.keys(TRANSITIONS[state])).toEqual([
        ...TERMINAL_ACTIONS_BY_STATE[state],
      ]);
    }
  });

  it('narrows a terminal state name', () => {
    expect(isTerminalScreenName('won')).toBe(true);
    expect(isTerminalScreenName('gameOver')).toBe(true);
    expect(isTerminalScreenName('stage')).toBe(false);
    expect(isTerminalScreenName(null)).toBe(false);
  });
});

describe('the verdict resolution', () => {
  it('tests the loss first, so both flags read as a loss', () => {
    expect(
      resolveTerminalState({ over: true, won: true, terminated: true }),
    ).toBe('gameOver');
    expect(
      resolveTerminalState({ over: true, won: false, terminated: true }),
    ).toBe('gameOver');
    expect(
      resolveTerminalState({ over: false, won: true, terminated: true }),
    ).toBe('won');
  });

  it('resolves a turn still in play to no state at all', () => {
    expect(
      resolveTerminalState({ over: false, won: false, terminated: false }),
    ).toBeNull();

    // A win played past is not terminal, which is the renamed engine flag doing
    // the work the shadowed `keepPlaying` used to.
    expect(
      resolveTerminalState({ over: false, won: true, continuedPlay: true }),
    ).toBeNull();
    expect(
      resolveTerminalState({ over: false, won: true, continuedPlay: false }),
    ).toBe('won');
  });

  it('states each state as the two flags the actuator branched on', () => {
    for (const state of TERMINAL_STATES) {
      expect(resolveTerminalState(TERMINAL_FLAGS_BY_STATE[state])).toBe(state);
    }
  });
});

/* ==========================================================================
 * 2. What one write puts on screen
 * ========================================================================== */

describe('one verdict write', () => {
  it('writes the loss to the overlay and to the panel', () => {
    const harness = mounted();
    const snapshot = harness.screen.render(
      TERMINAL_FLAGS_BY_STATE.gameOver,
      { score: 512, bestScore: '4096' },
    );

    expect(snapshot?.state).toBe('gameOver');
    expect(snapshot?.overlayClass).toBe('game-over');
    expect(snapshot?.message).toBe('Game over!');
    expect(snapshot?.verdict).toBe(TERMINAL_VERDICTS.gameOver);
    expect(harness.overlay.classList.contains('game-over')).toBe(true);
    expect(
      harness.overlay.querySelector(GAME_OVER_VERDICT_SELECTOR)?.textContent,
    ).toBe('Game over!');
    expect(harness.host.querySelector('h2')?.textContent).toBe('Game over!');
    expect(snapshot?.score).toBe(gameOverCopy.score(512, '4096'));
    expect(harness.host.textContent).toContain('Score 512. Best 4096.');
    expect(harness.screen.isShowing('gameOver')).toBe(true);
    expect(harness.reporter.errors()).toEqual([]);
  });

  it('writes the win, and replaces the class rather than adding to it', () => {
    const harness = mounted();

    harness.screen.render(TERMINAL_FLAGS_BY_STATE.gameOver);
    harness.screen.render(TERMINAL_FLAGS_BY_STATE.won);

    expect(harness.overlay.classList.contains('game-won')).toBe(true);
    expect(harness.overlay.classList.contains('game-over')).toBe(false);
    expect(harness.screen.isShowing('won')).toBe(true);
    expect(harness.host.querySelector('h2')?.textContent).toBe('You win!');
  });

  it('is idempotent: a second identical write appends nothing', () => {
    const harness = mounted();

    harness.screen.render(TERMINAL_FLAGS_BY_STATE.won, { score: 8 });

    const children = harness.host.querySelectorAll('*').length;
    const overlayText = harness.overlay.textContent;

    harness.screen.render(TERMINAL_FLAGS_BY_STATE.won, { score: 8 });

    expect(harness.host.querySelectorAll('*')).toHaveLength(children);
    expect(harness.overlay.textContent).toBe(overlayText);
    expect(harness.host.querySelectorAll('h2')).toHaveLength(1);
  });

  it('clears everything for a commit that is not terminal', () => {
    const harness = mounted();

    harness.screen.render(TERMINAL_FLAGS_BY_STATE.won);

    expect(
      harness.screen.render({ over: false, won: false, terminated: false }),
    ).toBeNull();
    expect(harness.overlay.classList.contains('game-won')).toBe(false);
    expect(harness.screen.readRendered()).toBeNull();
    expect(harness.reporter.counts('ui.gameOver.cleared')).toHaveLength(1);
  });

  it('names the container for the state, and restores what it found', () => {
    const harness = mounted();

    expect(harness.host.getAttribute('aria-label')).toBe('Game over');

    harness.screen.render(TERMINAL_FLAGS_BY_STATE.won);

    expect(harness.host.getAttribute('aria-label')).toBe(
      gameOverCopy.wonLabel,
    );

    harness.screen.clear();

    // RESTORED, not blanked: the name index.html declared is what comes back.
    expect(harness.host.getAttribute('aria-label')).toBe('Game over');
  });

  it('writes the overlay class even where the paragraph is absent', () => {
    document.body.innerHTML =
      `<main id="game-main"><div class="game-container">` +
      `<div class="game-message"></div></div></main>` +
      `<div class="screen-layer"><div id="screen-game-over"></div></div>`;

    const reporter = sink();
    const screen = createGameOverScreen({ reporter });
    const host = document.querySelector<HTMLElement>(SCREEN_MOUNTS.gameOver);

    screen.mount(host as Element);

    const snapshot = screen.render(TERMINAL_FLAGS_BY_STATE.gameOver);

    // The class is what the stylesheet fades in and what reveals the retained
    // controls, so it is applied whether or not the paragraph resolved.
    expect(
      document
        .querySelector(GAME_OVER_OVERLAY_SELECTOR)
        ?.classList.contains('game-over'),
    ).toBe(true);
    expect(snapshot?.message).toBe('Game over!');
    expect(screen.hasOverlay()).toBe(true);
  });

  it('works with no overlay at all, panel only', () => {
    const { host } = page();
    const reporter = sink();
    const screen = createGameOverScreen({ reporter, overlay: null });

    screen.mount(host);

    expect(screen.hasOverlay()).toBe(false);
    expect(screen.render(TERMINAL_FLAGS_BY_STATE.won)?.state).toBe('won');
    expect(host.querySelector('h2')?.textContent).toBe('You win!');
    expect(reporter.errors()).toEqual([]);
  });
});

/* ==========================================================================
 * 3. The controls each state offers
 * ========================================================================== */

describe('the controls', () => {
  it('attaches only the actions the entered state declares', () => {
    const harness = mounted();

    harness.screen.render(TERMINAL_FLAGS_BY_STATE.won);

    expect(harness.screen.readRendered()?.actions).toEqual([
      'keepPlaying',
      'endRun',
    ]);
    expect(action(harness.host, 'keepPlaying')).not.toBeNull();
    expect(action(harness.host, 'endRun')).not.toBeNull();

    // NOT IN THE DOCUMENT, rather than present and dead: the loss action is
    // held detached while the win state stands.
    expect(action(harness.host, 'acknowledge')).toBeNull();

    harness.screen.render(TERMINAL_FLAGS_BY_STATE.gameOver);

    expect(harness.screen.readRendered()?.actions).toEqual(['acknowledge']);
    expect(action(harness.host, 'acknowledge')).not.toBeNull();
    expect(action(harness.host, 'keepPlaying')).toBeNull();
    expect(action(harness.host, 'endRun')).toBeNull();
  });

  it('labels each control with the copy the state declares', () => {
    const harness = mounted();

    harness.screen.render(TERMINAL_FLAGS_BY_STATE.won);

    expect(action(harness.host, 'keepPlaying')?.textContent).toBe(
      gameOverCopy.keepPlaying,
    );
    expect(action(harness.host, 'endRun')?.textContent).toBe(
      gameOverCopy.endRun,
    );

    harness.screen.render(TERMINAL_FLAGS_BY_STATE.gameOver);

    expect(action(harness.host, 'acknowledge')?.textContent).toBe(
      gameOverCopy.acknowledge,
    );
  });

  it('forwards each press to its own callback, once', () => {
    const pressed: string[] = [];
    const harness = mounted({
      onKeepPlaying: (): void => {
        pressed.push('keepPlaying');
      },
      onEndRun: (): void => {
        pressed.push('endRun');
      },
      onAcknowledge: (): void => {
        pressed.push('acknowledge');
      },
    });

    harness.screen.render(TERMINAL_FLAGS_BY_STATE.won);
    action(harness.host, 'keepPlaying')?.click();
    action(harness.host, 'endRun')?.click();

    harness.screen.render(TERMINAL_FLAGS_BY_STATE.gameOver);
    action(harness.host, 'acknowledge')?.click();

    expect(pressed).toEqual(['keepPlaying', 'endRun', 'acknowledge']);
    expect(
      harness.reporter
        .counts('ui.gameOver.action')
        .map((entry) => entry.fields?.action),
    ).toEqual(['keepPlaying', 'endRun', 'acknowledge']);
  });

  it('builds no control for an action nothing would answer', () => {
    const harness = mounted({
      onKeepPlaying: undefined,
      onEndRun: undefined,
      onAcknowledge: undefined,
    });

    harness.screen.render(TERMINAL_FLAGS_BY_STATE.won);

    expect(harness.screen.readRendered()?.actions).toEqual([]);
    expect(
      harness.host.querySelectorAll(`.${GAME_OVER_CLASSES.button}`),
    ).toHaveLength(0);
    expect(
      harness.reporter
        .counts('ui.gameOver.action.unavailable')
        .map((entry) => entry.fields?.action),
    ).toEqual(['keepPlaying', 'endRun', 'acknowledge']);
  });

  it('uses real buttons and reaches neither retained control', () => {
    const harness = mounted();

    harness.screen.render(TERMINAL_FLAGS_BY_STATE.won);

    const control = action(harness.host, 'keepPlaying');

    expect(control?.tagName).toBe('BUTTON');
    expect(control?.type).toBe('button');
    expect(harness.host.querySelectorAll('a')).toHaveLength(0);

    // The retained `.keep-playing-button` and `.retry-button` are bound by
    // src/input/on-screen-controls.ts and revealed by the state class, so this
    // module neither moves nor rewrites them.
    expect(
      document.querySelector('.keep-playing-button')?.textContent,
    ).toBe('Keep going');
    expect(document.querySelector('.retry-button')?.textContent).toBe(
      'Try again',
    );

    harness.screen.clear();

    expect(document.querySelectorAll('.keep-playing-button')).toHaveLength(1);
    expect(document.querySelectorAll('.retry-button')).toHaveLength(1);
  });

  it('contains a callback that raises', () => {
    const harness = mounted({
      onAcknowledge: (): void => {
        throw new Error('the summary is not ready');
      },
    });

    harness.screen.render(TERMINAL_FLAGS_BY_STATE.gameOver);

    expect(() => {
      action(harness.host, 'acknowledge')?.click();
    }).not.toThrow();
    expect(harness.reporter.counts('ui.gameOver.port.error')).toHaveLength(1);
    expect(harness.reporter.errors()[0]?.name).toBe(
      'a game-over port call raised',
    );
  });
});

/* ==========================================================================
 * 4. The lifecycle, focus and the announcement
 * ========================================================================== */

describe('the lifecycle', () => {
  it('writes the state the context names, and focuses its control', () => {
    const harness = mounted();

    harness.screen.enter(context({ screen: 'won' }));

    const control = action(harness.host, 'keepPlaying');

    expect(harness.screen.isShowing('won')).toBe(true);
    expect(control?.hasAttribute(FOCUS_INITIAL_ATTRIBUTE)).toBe(true);
    expect(document.activeElement).toBe(control);
    expect(harness.reporter.counts('ui.gameOver.focus')).toHaveLength(1);
  });

  it('announces the verdict once while the state stands', () => {
    const harness = mounted();

    harness.screen.enter(context({ screen: 'gameOver' }));

    // PRIMITIVES ONLY, and the best score is not among them: the line carries
    // the verdict and the score, and the persisted value stays on screen.
    expect(harness.voice.lines).toEqual([
      {
        kind: 'terminal',
        verdict: TERMINAL_VERDICTS.gameOver,
        score: 512,
      },
    ]);
    expect(harness.reporter.counts('ui.gameOver.announce')).toHaveLength(1);

    harness.screen.update(context({ screen: 'gameOver' }));

    expect(harness.voice.lines).toHaveLength(1);

    // Released by `leave`, so a later entry into the same state is news again.
    harness.screen.leave();
    harness.screen.enter(context({ screen: 'gameOver' }));

    expect(harness.voice.lines).toHaveLength(2);
  });

  it('places focus again where a refresh carries the other verdict', () => {
    const harness = mounted();

    harness.screen.enter(context({ screen: 'won' }));
    harness.screen.update(context({ screen: 'gameOver' }));

    // The control that held focus was detached with the state that offered it,
    // so the placement is repeated rather than left on a removed node.
    expect(document.activeElement).toBe(action(harness.host, 'acknowledge'));
    expect(harness.reporter.counts('ui.gameOver.focus')).toHaveLength(2);
    expect(harness.voice.lines).toHaveLength(2);
  });

  it('clears both surfaces on the way out of either state', () => {
    const harness = mounted();

    harness.screen.enter(context({ screen: 'won' }));
    harness.screen.leave();

    expect(harness.overlay.classList.contains('game-won')).toBe(false);
    expect(harness.host.getAttribute('aria-label')).toBe('Game over');
    expect(
      harness.host.querySelectorAll(`.${GAME_OVER_CLASSES.button}`),
    ).toHaveLength(0);
    expect(
      harness.reporter
        .counts('ui.gameOver.cleared')
        .map((entry) => entry.fields?.member),
    ).toEqual(['leave']);
  });

  it('refuses a context that is not terminal', () => {
    const harness = mounted();

    harness.screen.enter({
      screen: 'stage',
      trigger: 'move',
      reducedMotion: false,
      host: harness.host,
      refresh: false,
      score: 8,
      bestScore: 0,
      stageIndex: 0,
      goal: null,
      goalProgress: null,
      relics: [],
      boardSize: 4,
      degraded: false,
    });

    expect(harness.screen.readRendered()).toBeNull();
    expect(harness.overlay.classList.contains('game-over')).toBe(false);

    const refusals = harness.reporter.counts('ui.gameOver.context.rejected');

    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.fields?.member).toBe('enter');
  });

  it('reports a cadence the context carries that is not the token one', () => {
    const harness = mounted();

    harness.screen.enter(
      context({
        screen: 'won',
        // Deliberately not the token cadence, which is the drift this
        // reports; the context type pins the token values, so the divergence
        // has to be introduced through a cast.
        cadence: { delay: 0, duration: 0, total: 0 } as unknown as
          typeof OVERLAY_CADENCE,
      }),
    );

    expect(
      harness.reporter.counts('ui.gameOver.cadence.drift'),
    ).toHaveLength(1);

    // Reported, not absorbed: the verdict is still written.
    expect(harness.screen.isShowing('won')).toBe(true);
  });

  it('contains an announcer that raises', () => {
    const harness = mounted({
      announcer: {
        announce: (): void => {
          throw new Error('no live region');
        },
      },
    });

    expect(() => {
      harness.screen.enter(context({ screen: 'won' }));
    }).not.toThrow();
    expect(harness.screen.isShowing('won')).toBe(true);
    expect(harness.reporter.counts('ui.gameOver.port.error')).toHaveLength(1);
  });

  it('restores the retained markup on destroy, and reports later calls', () => {
    const harness = mounted();

    harness.screen.enter(context({ screen: 'won' }));
    harness.screen.destroy();

    expect(harness.overlay.classList.contains('game-won')).toBe(false);
    expect(harness.overlay.querySelector('p')).not.toBeNull();
    expect(harness.host.getAttribute('aria-label')).toBe('Game over');
    expect(harness.host.children).toHaveLength(0);
    expect(harness.screen.hasPanel()).toBe(false);
    expect(harness.screen.readRendered()).toBeNull();

    harness.screen.enter(context({ screen: 'won' }));
    harness.screen.update(context({ screen: 'won' }));
    harness.screen.leave();
    harness.screen.render(TERMINAL_FLAGS_BY_STATE.won);
    harness.screen.clear();

    const refused = harness.reporter.counts('ui.gameOver.after_destroy');

    expect(refused.map((entry) => entry.fields?.member)).toEqual([
      'enter',
      'update',
      'leave',
      'render',
      'clear',
    ]);
    expect(harness.host.children).toHaveLength(0);
  });
});

/* ==========================================================================
 * 5. Driven by the real router
 * ========================================================================== */

describe('driven by the real router', () => {
  it('serves both terminal states, and takes each declared edge', () => {
    const { host, overlay } = page();

    host.insertAdjacentHTML(
      'afterend',
      `<div class="screen" id="screen-run-summary" hidden></div>` +
        `<div class="hud" id="screen-hud" hidden></div>`,
    );

    const reporter = sink();
    const router = createScreenRouter({ document, reporter });
    const screen = createGameOverScreen({
      reporter,
      onKeepPlaying: (): void => {
        router.send('keepPlaying');
      },
      onEndRun: (): void => {
        router.send('endRun');
      },
      onAcknowledge: (): void => {
        router.send('acknowledge');
      },
    });
    const driven = createScreenRouter({
      document,
      reporter,
      screens: { won: screen, gameOver: screen },
    });

    expect(driven.start()).toBe('runStart');
    expect(driven.send('beginRun')).toBe(true);
    expect(driven.send('winReached')).toBe(true);
    expect(driven.current()).toBe('won');
    expect(screen.isShowing('won')).toBe(true);
    expect(overlay.classList.contains('game-won')).toBe(true);

    // One module, two states: the loss is served by the same instance.
    expect(driven.send('endRun')).toBe(true);
    expect(driven.current()).toBe('runSummary');
    expect(overlay.classList.contains('game-won')).toBe(false);

    driven.destroy();
    router.destroy();
  });
});
