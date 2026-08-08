// Contract suite for the composition root's board-renderer selection, AAP R7,
// R9 and implicit requirement I6.
//
// The selection is decided by TWO independent inputs that must not be conflated:
//
//   the capability  WebGL is a hard runtime prerequisite the product has never
//                   had, so a machine without a context has to be served the
//                   number-only board. The probe is consulted once, before any
//                   renderer is built, and the result is pushed into the
//                   preference store as a FORCE — which is what makes the
//                   settings surface able to refuse turning the mode off on a
//                   machine that cannot draw without it.
//   the preference  number-only rendering is also a first-class accessible mode
//                   a player may choose with a context available, and choosing
//                   it has to take effect without a reload. That is what makes
//                   it a mode rather than a build-time decision.
//
// Both are covered here, in both directions, plus the third case the probe
// cannot predict: a context reported available that then fails to be acquired.
//
// THE MARKUP IS BUILT BY THIS SUITE
//   `start()` looks up eight elements and guards every lookup, so it runs
//   against an empty document. The fixture below carries the four the board
//   needs, in the nesting index.html declares, so the assertions read the
//   surfaces a player sees and not the guarded-miss path. Decision DL-MAIN-04.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONTEXT_RESTORE_GRACE_MS, start } from '../../../src/main';
import type { Application } from '../../../src/main';
import { resetWebGLSupportProbe } from '../../../src/render/webgl-support';
import { applyTheme } from '../../../src/theme/themes';
import { createMockWebGLContext } from '../../fixtures/webgl';

/**
 * The board region of index.html, with the four elements the root looks up.
 *
 * `#board-canvas` carries `aria-hidden` and `#board-number-only` ships hidden,
 * exactly as index.html declares them.
 */
const BOARD_MARKUP = `
  <div class="score-container"><span class="visually-hidden">Score</span>0</div>
  <div class="best-container"><span class="visually-hidden">Best score</span>0</div>
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
      <div class="board-a11y" id="board-a11y" role="grid" aria-label="Game board" aria-busy="true"></div>
    </div>
  </div>
  <div class="on-screen-controls" id="on-screen-controls"></div>
  <div class="visually-hidden live-region" id="live-region" role="status"
       aria-live="polite" aria-atomic="true"></div>
`;

const nativeGetContext = HTMLCanvasElement.prototype.getContext;

let application: Application | null = null;

/**
 * Makes every canvas in the document answer with a mocked WebGL 2 context.
 *
 * The probe creates a canvas of its own, so the stand-in is installed on the
 * prototype rather than on one element. A 2D request is refused, which is what
 * jsdom does and what the mesh factory already reports.
 */
const installWebGL = (): void => {
  const mock = createMockWebGLContext();

  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    writable: true,
    value: (contextType: string): unknown =>
      contextType === 'webgl2' || contextType === 'webgl' ? mock.gl : null,
  });
};

const restoreWebGL = (): void => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    writable: true,
    value: nativeGetContext,
  });
};

/** Measures the canvas, which jsdom reports as zero, so the scene can frame. */
const measureCanvas = (): void => {
  const canvas = document.querySelector('#board-canvas');

  if (canvas === null) {
    return;
  }

  for (const property of ['clientWidth', 'clientHeight'] as const) {
    Object.defineProperty(canvas, property, {
      configurable: true,
      get: (): number => 500,
    });
  }
};

beforeEach(() => {
  document.body.innerHTML = BOARD_MARKUP;
  resetWebGLSupportProbe();
  measureCanvas();
});

afterEach(() => {
  application?.dispose();
  application = null;
  restoreWebGL();
  resetWebGLSupportProbe();
  applyTheme('default');
  document.body.innerHTML = '';
  window.localStorage.removeItem('bestScore');
  window.localStorage.removeItem('gameState');
});

/**
 * Yields until the frame loop has drawn.
 *
 * `start()` schedules the renderer's work on `requestAnimationFrame` rather than
 * painting inside the commit, which is what keeps the engine's turn free of
 * layout and drawing. A caller asserting on what is on screen therefore has to
 * let those frames run; three are awaited, which covers the paint and the two
 * frames a spawn tween needs to reach its last keyframe.
 */
const settleFrames = async (count = 3): Promise<void> => {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => {
        resolve();
      });
    });
  }
};

const gridCells = (): number =>
  document.querySelectorAll('#board-a11y [role="gridcell"]').length;

const numberOnlyTiles = (): number =>
  document.querySelectorAll('#board-number-only .tile').length;

/* ==========================================================================
 * The capability decides first
 * ========================================================================== */

describe('without a WebGL context', () => {
  it('serves the number-only board and records it as a fallback', () => {
    // jsdom implements no rendering context, so the probe fails for real here
    // rather than being told to.
    application = start(document);

    expect(application.renderer.mode).toBe('number-only');
    expect(application.renderer.fallback).toBe(true);
    expect(application.renderer.chosen).toBe(false);
    expect(application.renderer.support.supported).toBe(false);
    expect(application.preferences.isNumberOnlyForced()).toBe(true);
  });

  it('draws the number-only lattice and takes the parallel board down', async () => {
    application = start(document);
    await settleFrames();

    const host = document.querySelector<HTMLElement>('#board-number-only');
    const parallel = document.querySelector<HTMLElement>('#board-a11y');

    expect(host?.hidden).toBe(false);
    expect(numberOnlyTiles()).toBeGreaterThan(0);

    // Exactly one semantic grid: the number-only lattice carries `role="grid"`
    // itself, so the parallel one is hidden rather than announced twice.
    expect(parallel?.hidden).toBe(true);
    expect(parallel?.getAttribute('aria-hidden')).toBe('true');
  });

  it('refuses to leave number-only mode while the force stands', () => {
    application = start(document);
    application.preferences.setNumberOnlyMode(false);

    expect(application.preferences.isNumberOnlyMode()).toBe(true);
    expect(application.renderer.mode).toBe('number-only');
  });
});

/* ==========================================================================
 * With a context, the 2.5D board is the default
 * ========================================================================== */

describe('with a WebGL context', () => {
  beforeEach(() => {
    installWebGL();
    resetWebGLSupportProbe();
  });

  it('draws the 2.5D board and records no fallback', () => {
    application = start(document);

    expect(application.renderer.support.supported).toBe(true);
    expect(application.renderer.mode).toBe('three');
    expect(application.renderer.fallback).toBe(false);
    expect(application.renderer.chosen).toBe(false);
    expect(application.preferences.isNumberOnlyForced()).toBe(false);
  });

  it('exposes the parallel board, because the canvas carries no semantics', async () => {
    application = start(document);
    await settleFrames();

    const canvas = document.querySelector<HTMLElement>('#board-canvas');
    const parallel = document.querySelector<HTMLElement>('#board-a11y');
    const numberOnly = document.querySelector<HTMLElement>(
      '#board-number-only',
    );

    expect(canvas?.getAttribute('aria-hidden')).toBe('true');
    expect(canvas?.hidden).toBe(false);
    expect(numberOnly?.hidden).toBe(true);
    expect(numberOnlyTiles()).toBe(0);

    // The board a screen reader reads: sixteen labelled, focusable cells beside
    // an `aria-hidden` canvas.
    expect(parallel?.hidden).toBe(false);
    expect(parallel?.getAttribute('aria-hidden')).toBeNull();
    expect(gridCells()).toBe(16);
  });

  it('names the two starting tiles on the parallel board', async () => {
    application = start(document);
    await settleFrames();

    const labels = Array.from(
      document.querySelectorAll<HTMLElement>('#board-a11y [role="gridcell"]'),
    ).map((cell) => cell.getAttribute('aria-label') ?? '');

    expect(labels).toHaveLength(16);
    expect(
      labels.filter((label) => !label.toLowerCase().includes('empty')),
    ).toHaveLength(2);
  });
});

/* ==========================================================================
 * The preference switches modes without a reload
 * ========================================================================== */

describe('switching modes from the preference', () => {
  beforeEach(() => {
    installWebGL();
    resetWebGLSupportProbe();
  });

  it('moves to the number-only board when the mode is chosen', async () => {
    application = start(document);

    expect(application.renderer.mode).toBe('three');

    application.preferences.setNumberOnlyMode(true);
    await settleFrames();

    expect(application.renderer.mode).toBe('number-only');
    expect(application.renderer.chosen).toBe(true);
    expect(application.renderer.fallback).toBe(false);

    // The lattice is drawn at once, from the commit the root retained, rather
    // than standing empty until the next turn.
    expect(numberOnlyTiles()).toBeGreaterThan(0);

    const parallel = document.querySelector<HTMLElement>('#board-a11y');

    expect(parallel?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('#board-canvas')?.hidden).toBe(
      true,
    );
  });

  it('moves back to the 2.5D board when the mode is turned off', async () => {
    application = start(document);
    application.preferences.setNumberOnlyMode(true);
    application.preferences.setNumberOnlyMode(false);
    await settleFrames();

    expect(application.renderer.mode).toBe('three');
    expect(numberOnlyTiles()).toBe(0);
    expect(document.querySelector<HTMLElement>('#board-canvas')?.hidden).toBe(
      false,
    );

    // The semantic board came back with it, populated rather than empty.
    const parallel = document.querySelector<HTMLElement>('#board-a11y');

    expect(parallel?.hidden).toBe(false);
    expect(gridCells()).toBe(16);
  });

  it('keeps the score and the board across a switch', () => {
    application = start(document);

    const before = application.engine.serialize();

    application.preferences.setNumberOnlyMode(true);

    const after = application.engine.serialize();

    // The switch replaces a view, not the game: nothing in the engine moved.
    expect(after.score).toBe(before.score);
    expect(after.grid.size).toBe(before.grid.size);
  });

  it('leaves the mode alone when an unrelated preference changes', () => {
    application = start(document);
    application.preferences.setTheme('high-contrast');
    application.preferences.setVolume(0.5);

    expect(application.renderer.mode).toBe('three');
  });

  it('survives a move made after a switch', async () => {
    application = start(document);
    application.preferences.setNumberOnlyMode(true);

    expect(() => {
      application?.engine.move(0);
      application?.engine.move(1);
    }).not.toThrow();

    await settleFrames();

    expect(numberOnlyTiles()).toBeGreaterThan(0);
  });
});

/* ==========================================================================
 * The settings dialog is what a player reaches the mode through
 * ========================================================================== */

// Every case above drives `preferences.setNumberOnlyMode()` directly, which
// pins the store-to-renderer half of the chain. A player never calls that: they
// press a control in the settings dialog. The dialog's own suite asserts the
// press writes the store, and the cases above assert the store moves the
// renderer — but a control wired to nothing, or a dialog the root never built,
// satisfies both and still leaves the mode unreachable. These close that join.
//
// The dialog markup is appended in this block alone, so the fixture the rest of
// the file starts from is unchanged.
describe('reaching the mode through the settings dialog', () => {
  beforeEach(() => {
    document.body.insertAdjacentHTML(
      'beforeend',
      `<main id="game-main"></main>
       <button type="button" class="settings-button" id="settings-button"
               aria-haspopup="dialog" aria-controls="settings-panel">Settings</button>
       <div class="screen-layer" id="screen-layer">
         <div class="settings-panel" id="settings-panel" role="dialog"
              aria-modal="true" aria-label="Settings" hidden></div>
       </div>
       <div class="visually-hidden live-region" id="live-region" role="status"
            aria-live="polite" aria-atomic="true"></div>`,
    );
  });

  /** A control in the rendered dialog, addressed by its visible name. */
  const panelButton = (name: string): HTMLButtonElement => {
    const found = Array.from(
      document.querySelectorAll<HTMLButtonElement>('#settings-panel button'),
    ).find((candidate) => candidate.textContent === name);

    if (found === undefined) {
      throw new Error(`the dialog has no control named ${name}`);
    }

    return found;
  };

  const openSettings = (): void => {
    document.querySelector<HTMLElement>('#settings-button')?.click();
  };

  it('moves to the number-only board from the dialog s own control', async () => {
    installWebGL();
    resetWebGLSupportProbe();

    application = start(document);
    await settleFrames();

    expect(application.renderer.mode).toBe('three');

    openSettings();

    const toggle = panelButton('Numbers only');

    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.disabled).toBe(false);

    toggle.click();
    await settleFrames();

    // A chosen mode, not a fallback: the machine can draw, and the player asked
    // for numbers anyway.
    expect(application.preferences.isNumberOnlyMode()).toBe(true);
    expect(application.renderer.mode).toBe('number-only');
    expect(application.renderer.chosen).toBe(true);
    expect(application.renderer.fallback).toBe(false);
    expect(numberOnlyTiles()).toBeGreaterThan(0);
    expect(
      document.querySelector<HTMLElement>('#board-canvas')?.hidden,
    ).toBe(true);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
  });

  it('moves back to the 2.5D board from the same control', async () => {
    installWebGL();
    resetWebGLSupportProbe();

    application = start(document);
    openSettings();
    panelButton('Numbers only').click();
    await settleFrames();

    expect(application.renderer.mode).toBe('number-only');

    panelButton('Numbers only').click();
    await settleFrames();

    expect(application.renderer.mode).toBe('three');
    expect(numberOnlyTiles()).toBe(0);
    expect(
      document.querySelector<HTMLElement>('#board-canvas')?.hidden,
    ).toBe(false);
    expect(gridCells()).toBe(16);
  });

  it('offers the control disabled, with the reason, when the machine cannot draw', () => {
    // No WebGL installed, so the probe fails for real and the root forces the
    // mode. The dialog has to refuse turning it off AND say why, which is the
    // whole purpose of forcing rather than comparing at each use.
    application = start(document);
    openSettings();

    const toggle = panelButton('Numbers only');

    expect(application.renderer.fallback).toBe(true);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-disabled')).toBe('true');

    const hintId = toggle.getAttribute('aria-describedby') ?? '';
    const hint = document.querySelector<HTMLElement>(
      `#settings-panel #${hintId.split(/\s+/u).filter(Boolean).at(-1) ?? 'none'}`,
    );

    expect(hint?.hidden).toBe(false);
    expect(hint?.textContent).toContain('no WebGL context is available');

    toggle.click();

    expect(application.renderer.mode).toBe('number-only');
  });
});

/* ==========================================================================
 * A context reported available that cannot be acquired
 * ========================================================================== */

describe('when the context cannot be acquired', () => {
  it('falls back to the number-only board and records the force', async () => {
    // The probe sees a context; the renderer's own request is then refused,
    // which is what a driver that hands out one context per page does.
    let served = 0;

    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      writable: true,
      value: (contextType: string): unknown => {
        if (contextType !== 'webgl2' && contextType !== 'webgl') {
          return null;
        }

        served += 1;

        return served === 1 ? createMockWebGLContext().gl : null;
      },
    });
    resetWebGLSupportProbe();

    application = start(document);
    await settleFrames();

    expect(application.renderer.support.supported).toBe(true);
    expect(application.renderer.mode).toBe('number-only');
    expect(application.renderer.fallback).toBe(true);
    expect(application.preferences.isNumberOnlyForced()).toBe(true);
    expect(numberOnlyTiles()).toBeGreaterThan(0);
  });
});

/* ==========================================================================
 * A context acquired and then taken away
 * ========================================================================== */

/** Fires the browser's own loss or restoration event on the board canvas. */
const fireContextEvent = (type: string): void => {
  document
    .querySelector('#board-canvas')
    ?.dispatchEvent(new Event(type, { cancelable: true }));
};

/** Waits past the bounded restoration window. */
const waitOutGrace = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, CONTEXT_RESTORE_GRACE_MS + 120);
  });
};

describe('when the context is lost after mounting', () => {
  beforeEach(() => {
    installWebGL();
    resetWebGLSupportProbe();
  });

  it('keeps the 2.5D board when the browser restores it inside the window', async () => {
    application = start(document);
    await settleFrames();

    expect(application.renderer.mode).toBe('three');

    fireContextEvent('webglcontextlost');
    fireContextEvent('webglcontextrestored');
    await waitOutGrace();

    // A loss the browser restores is common — a driver reset, a tab returning
    // from the background — and swapping renderers on every one of them would
    // replace a board that recovers in two frames with a different board.
    expect(application.renderer.mode).toBe('three');
    expect(application.preferences.isNumberOnlyForced()).toBe(false);
  });

  it('serves the number-only board when it is never restored', async () => {
    application = start(document);
    await settleFrames();

    // A turn first, so there is a commit to replay into the board that takes
    // over. Without the replay the fallback board stands empty until the next
    // turn is played.
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        code: 'ArrowDown',
        bubbles: true,
      }),
    );
    await settleFrames();

    fireContextEvent('webglcontextlost');
    await waitOutGrace();
    await settleFrames();

    // The defect this closes: the renderer suspends drawing on a loss and waits
    // for a restoration that may never come, so the board simply froze for the
    // rest of the session.
    expect(application.renderer.mode).toBe('number-only');
    expect(application.renderer.fallback).toBe(true);
    expect(application.preferences.isNumberOnlyForced()).toBe(true);

    // Populated, not empty: the last commit was replayed into it.
    expect(numberOnlyTiles()).toBeGreaterThan(0);
    expect(gridCells()).toBe(0);
  });

  it('reports the LIVE WebGL verdict while the context stands lost', async () => {
    application = start(document);
    await settleFrames();

    const before = application.health
      .report({ refresh: true })
      .checks.find((check) => check.id === 'webgl');

    expect(before?.status).toBe('pass');

    fireContextEvent('webglcontextlost');

    const during = application.health
      .report({ refresh: true })
      .checks.find((check) => check.id === 'webgl');

    // `probeWebGLSupport` holds its startup result and hands the same one to
    // every later caller, so a surface reading it alone would report the
    // capability the machine had at boot for the rest of the session.
    expect(during?.status).toBe('fail');
    expect(during?.data.failure).toBe('context-lost');
    expect(application.health.readiness().requiresNumberOnlyFallback).toBe(
      true,
    );
  });

  it('announces the change of board through the live region', async () => {
    application = start(document);
    await settleFrames();

    fireContextEvent('webglcontextlost');
    await waitOutGrace();

    // The queue coalesces, then clears and writes on separate zero-delay tasks,
    // so several turns of the event loop are awaited before the region is read.
    for (let turn = 0; turn < 6; turn += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }

    // Read across BOTH regions: this notice is assertive, and the announcer
    // creates an `role="alert"` region beside the polite one on first assertive
    // use rather than writing an interrupting message into `role="status"`.
    const announced = Array.from(document.querySelectorAll('[aria-live]'))
      .map((region) => region.textContent ?? '')
      .join(' ')
      .toLowerCase();

    // A player who cannot see the board changing renderer is otherwise given no
    // signal that anything happened at all.
    expect(announced).toContain('number board');
    expect(
      document.querySelector('[aria-live="assertive"]'),
    ).not.toBeNull();
  });

  it('serves the number-only board when the rebuild cannot be completed',
    async () => {
      application = start(document);
      await settleFrames();

      expect(application.renderer.mode).toBe('three');

      fireContextEvent('webglcontextlost');

      // The context comes back and the renderer's rebuild of it fails, which is
      // what a driver refusing the new context does.
      Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
        configurable: true,
        writable: true,
        value: (): null => null,
      });

      fireContextEvent('webglcontextrestored');
      await settleFrames();

      // WITHOUT WAITING OUT THE GRACE. The restoration used to cancel the wait
      // on the strength of the event alone, which left the 2.5D board parked and
      // nothing drawing at all; a rebuild that failed is final, so the
      // number-only board takes over at once.
      expect(application.renderer.mode).toBe('number-only');
      expect(application.renderer.fallback).toBe(true);
      expect(application.preferences.isNumberOnlyForced()).toBe(true);
      expect(numberOnlyTiles()).toBeGreaterThan(0);
    });

  it('recomputes the HELD health report when the rebuild fails', async () => {
    application = start(document);
    await settleFrames();

    expect(
      application.health
        .lastReport()
        ?.checks.find((check) => check.id === 'webgl')?.status,
    ).toBe('pass');

    fireContextEvent('webglcontextlost');

    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      writable: true,
      value: (): null => null,
    });

    fireContextEvent('webglcontextrestored');
    await settleFrames();

    // READ WITHOUT `refresh`, which is how the diagnostics panel and every
    // exported snapshot read it: the held report used to be the BOOT report for
    // the rest of the session, so the panel reported a healthy WebGL board while
    // the number-only board was the one drawing.
    const held = application.health.lastReport();
    const webgl = held?.checks.find((check) => check.id === 'webgl');

    expect(webgl?.status).toBe('fail');
    expect(webgl?.data.failure).toBe('number-only-forced');
    expect(application.health.readiness().requiresNumberOnlyFallback).toBe(
      true,
    );
    expect(application.health.readiness().renderer).toBe('number-only');
  });

  it('recomputes the held health report when the rebuild succeeds',
    async () => {
      application = start(document);
      await settleFrames();

      fireContextEvent('webglcontextlost');

      const parked = application.health
        .lastReport()
        ?.checks.find((check) => check.id === 'webgl');

      // The loss alone refreshes the held report, so the panel reports the board
      // as it stands during the wait as well as after it.
      expect(parked?.status).toBe('fail');
      expect(parked?.data.failure).toBe('context-lost');

      fireContextEvent('webglcontextrestored');
      await settleFrames();

      const recovered = application.health
        .lastReport()
        ?.checks.find((check) => check.id === 'webgl');

      expect(application.renderer.mode).toBe('three');
      expect(recovered?.status).toBe('pass');
      expect(application.health.readiness().requiresNumberOnlyFallback).toBe(
        false,
      );
    });

  it('abandons the pending wait when the application is disposed', async () => {
    application = start(document);
    await settleFrames();

    fireContextEvent('webglcontextlost');
    application.dispose();
    application = null;

    await waitOutGrace();

    // Nothing to assert on the application, which is gone; the property is that
    // the timer fired into a disposed composition without throwing, which an
    // unhandled rejection or a listener error would surface as a failure here.
    expect(document.querySelector('#board-canvas')).not.toBeNull();
  });
});
