// Contract suite for the composition root's board-renderer selection, AAP R7,
// R9 and implicit requirement I6.
//
// The selection is decided by TWO independent inputs that must not be
// conflated.
//
// Both are covered here, in both directions, plus the third case the probe
// cannot predict: a context reported available that then fails to be acquired.
//
// Decisions: DL-MAIN-04 (docs/DECISION_LOG.md).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONTEXT_RESTORE_GRACE_MS, start } from '../../../src/main';
import type { Application } from '../../../src/main';
import { resetWebGLSupportProbe } from '../../../src/render/webgl-support';
import { applyTheme } from '../../../src/theme/themes';
import { RUN_STATE_KEY } from '../../../src/storage/storage-keys';
import { createMockWebGLContext } from '../../fixtures/webgl';
import { startWithRun } from '../../fixtures/application';

/**
 * The board region of index.html, with the four elements the root looks up.
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

/**
 * The run this suite resumes: a fixed seed, stage 0 and a two-tile board.
 *
 * A load that resumed nothing HOLDS THE RUN-START SCREEN and opens no board at
 * all, so every case here would be measuring an empty renderer. Resuming is
 * what puts a board on screen without this suite having to drive the screen
 * flow, and the two tiles are the count `startTiles` opens a fresh board with,
 * so the per-cell assertions below read the same lattice they always did.
 */
const SEEDED_ENVELOPE = JSON.stringify({
  schemaVersion: 1,
  runId: 'renderer-run',
  seed: 'renderer-seed',
  rngCursor: {
    'spawn-value': 2,
    'spawn-position': 2,
    'relic-draw': 0,
    'rarity-weight': 0,
  },
  stageIndex: 0,
  stageGoal: { kind: 'highest-tile', target: 16 },
  goalProgress: 0.125,
  relics: [],
  board: {
    grid: {
      size: 4,
      cells: [
        [{ position: { x: 0, y: 0 }, value: 2 }, null, null, null],
        [{ position: { x: 1, y: 0 }, value: 4 }, null, null, null],
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

const nativeGetContext = HTMLCanvasElement.prototype.getContext;

let application: Application | null = null;

/** Makes every canvas in the document answer with a mocked WebGL 2 context. */
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

/**
 * Measures the canvas, which jsdom reports as zero, so the scene can frame.
 */
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
  window.localStorage.setItem(RUN_STATE_KEY, SEEDED_ENVELOPE);
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
  window.localStorage.removeItem(RUN_STATE_KEY);
});

/** Yields until the frame loop has drawn. */
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

describe('without a WebGL context', () => {
  it('serves the number-only board and records it as a fallback', () => {
    application = start(document);

    expect(application.renderer.mode).toBe('number-only');
    expect(application.renderer.fallback).toBe(true);
    expect(application.renderer.chosen).toBe(false);
    expect(application.renderer.support.supported).toBe(false);
    expect(application.preferences.isNumberOnlyForced()).toBe(true);
  });

  it('draws the number-only lattice and takes the parallel board down', async () => {
    application = startWithRun(document);
    await settleFrames();

    const host = document.querySelector<HTMLElement>('#board-number-only');
    const parallel = document.querySelector<HTMLElement>('#board-a11y');

    expect(host?.hidden).toBe(false);
    expect(numberOnlyTiles()).toBeGreaterThan(0);

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

    // The board a screen reader reads: sixteen labelled, focusable cells
    // beside an `aria-hidden` canvas.
    expect(parallel?.hidden).toBe(false);
    expect(parallel?.getAttribute('aria-hidden')).toBeNull();
    expect(gridCells()).toBe(16);
  });

  it('names the two starting tiles on the parallel board', async () => {
    application = startWithRun(document);
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

describe('switching modes from the preference', () => {
  beforeEach(() => {
    installWebGL();
    resetWebGLSupportProbe();
  });

  it('moves to the number-only board when the mode is chosen', async () => {
    application = startWithRun(document);

    expect(application.renderer.mode).toBe('three');

    application.preferences.setNumberOnlyMode(true);
    await settleFrames();

    expect(application.renderer.mode).toBe('number-only');
    expect(application.renderer.chosen).toBe(true);
    expect(application.renderer.fallback).toBe(false);

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

    const parallel = document.querySelector<HTMLElement>('#board-a11y');

    expect(parallel?.hidden).toBe(false);
    expect(gridCells()).toBe(16);
  });

  it('keeps the READING position across a round trip through the 2.5D board', async () => {
    application = startWithRun(document);
    application.preferences.setNumberOnlyMode(true);
    await settleFrames();

    const cells = (): HTMLElement[] =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          '#board-number-only [role="gridcell"]',
        ),
      );
    const tabStop = (): number =>
      cells().findIndex((cell) => cell.getAttribute('tabindex') === '0');

    // Row 3, column 3 of a four-wide board: an interior cell, so a reset to the
    // corner cannot pass for a carry.
    cells().at(2 * 4 + 2)?.focus();

    expect(tabStop()).toBe(10);

    // FOCUS LEAVES THE BOARD FIRST, which is the real case: the only control that
    // changes this preference lives inside the settings dialog, so focus is never
    // on the board when the swap is made.
    const elsewhere = document.createElement('button');

    elsewhere.type = 'button';
    document.body.appendChild(elsewhere);
    elsewhere.focus();

    application.preferences.setNumberOnlyMode(false);
    await settleFrames();

    expect(application.renderer.mode).toBe('three');

    application.preferences.setNumberOnlyMode(true);
    await settleFrames();

    // BACK ON THE CELL THE PLAYER LEFT. A swap destroys the outgoing renderer,
    // and with focus elsewhere there is no live handoff to carry the coordinate,
    // so the root records the cell before the teardown and hands it to the
    // renderer taking over. DL-MAIN-24, DL-NUMBER-08.
    expect(tabStop()).toBe(10);
    expect(cells().at(10)?.getAttribute('aria-label')).toContain(
      'Row 3, column 3',
    );

    // And no focus was moved for it: the swap was made from a preference, not
    // from the board.
    expect(document.activeElement).toBe(elsewhere);
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
    application = startWithRun(document);
    application.preferences.setNumberOnlyMode(true);

    expect(() => {
      application?.engine.move(0);
      application?.engine.move(1);
    }).not.toThrow();

    await settleFrames();

    expect(numberOnlyTiles()).toBeGreaterThan(0);
  });
});

// Every case above drives `preferences.setNumberOnlyMode` directly, which pins
// the store-to-renderer half of the chain.
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

    application = startWithRun(document);
    await settleFrames();

    expect(application.renderer.mode).toBe('three');

    openSettings();

    const toggle = panelButton('Numbers only');

    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.disabled).toBe(false);

    toggle.click();
    await settleFrames();

    // A chosen mode, not a fallback: the machine can draw, and the player
    // asked for numbers anyway.
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
    // mode.
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

    application = startWithRun(document);
    await settleFrames();

    expect(application.renderer.support.supported).toBe(true);
    expect(application.renderer.mode).toBe('number-only');
    expect(application.renderer.fallback).toBe(true);
    expect(application.preferences.isNumberOnlyForced()).toBe(true);
    expect(numberOnlyTiles()).toBeGreaterThan(0);
  });
});

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
    application = startWithRun(document);
    await settleFrames();

    // A turn first, so there is a commit to replay into the board that takes
    // over.
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

    // The defect this closes: the renderer suspends drawing on a loss and
    // waits for a restoration that may never come, so the board simply froze
    // for the rest of the session.
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

    // The queue coalesces, then clears and writes on separate zero-delay
    // tasks, so several turns of the event loop are awaited before the region
    // is read.
    for (let turn = 0; turn < 6; turn += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }

    const announced = Array.from(document.querySelectorAll('[aria-live]'))
      .map((region) => region.textContent ?? '')
      .join(' ')
      .toLowerCase();

    expect(announced).toContain('number board');
    expect(
      document.querySelector('[aria-live="assertive"]'),
    ).not.toBeNull();
  });

  it('serves the number-only board when the rebuild cannot be completed',
    async () => {
      application = startWithRun(document);
      await settleFrames();

      expect(application.renderer.mode).toBe('three');

      fireContextEvent('webglcontextlost');

      // The context comes back and the renderer's rebuild of it fails, which
      // is what a driver refusing the new context does.
      Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
        configurable: true,
        writable: true,
        value: (): null => null,
      });

      fireContextEvent('webglcontextrestored');
      await settleFrames();

      // Without waiting out the grace.
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

    const held = application.health.lastReport();
    const webgl = held?.checks.find((check) => check.id === 'webgl');

    expect(webgl?.status).toBe('fail');

    // STILL the forced-fallback verdict, and for a reason worth stating: the
    // reclaim listener releases a context-loss force the moment the context is
    // reported back, so the board is remounted — and here the remount fails,
    // because this case is one where no context can be obtained at all. The
    // force in place at the end therefore names the REMOUNT rather than the
    // context, so the generic verdict is the accurate one. The lost-context
    // verdict is asserted by the takeover case below, which is the one the
    // review measured. DL-MAIN-35.
    expect(application.preferences.getNumberOnlyForce().reason).toContain(
      'remounted',
    );
    expect(webgl?.data.failure).toBe('number-only-forced');
    expect(application.health.readiness().requiresNumberOnlyFallback).toBe(
      true,
    );
    expect(application.health.readiness().renderer).toBe('number-only');
  });

  // The observability review's INFO finding on the health surface: after the
  // automatic takeover the HELD report read `number-only-forced` rather than the
  // root cause, which was left in the log record alone. DL-MAIN-35.
  it('keeps naming the lost context after the number-only board takes over',
    async () => {
      application = start(document);
      await settleFrames();

      fireContextEvent('webglcontextlost');
      await waitOutGrace();
      await settleFrames();

      expect(application.renderer.mode).toBe('number-only');
      expect(application.renderer.fallback).toBe(true);

      const webgl = application.health
        .report({ refresh: true })
        .checks.find((check) => check.id === 'webgl');

      expect(webgl?.status).toBe('fail');
      expect(webgl?.data.failure).toBe('context-lost');
      expect(webgl?.detail ?? '').toContain('context-lost');
      expect(application.health.readiness().webglFailure).toBe('context-lost');
    });

  // The other half of the same distinction: a number-only board forced for a
  // reason that is NOT a lost context still reports the mode, because for those
  // the mode is the whole finding.
  it('still reports a forced fallback as forced when no context was lost',
    async () => {
      application = start(document);
      await settleFrames();

      expect(application.renderer.mode).toBe('three');

      application.preferences.forceNumberOnlyMode(
        'the renderer could not be constructed',
      );
      await settleFrames();

      expect(application.renderer.mode).toBe('number-only');
      expect(application.renderer.fallback).toBe(true);

      const webgl = application.health
        .report({ refresh: true })
        .checks.find((check) => check.id === 'webgl');

      expect(webgl?.status).toBe('fail');
      expect(webgl?.data.failure).toBe('number-only-forced');
    });

  it('recomputes the held health report when the rebuild succeeds',
    async () => {
      application = start(document);
      await settleFrames();

      fireContextEvent('webglcontextlost');

      const parked = application.health
        .lastReport()
        ?.checks.find((check) => check.id === 'webgl');

      // The loss alone refreshes the held report, so the panel reports the
      // board as it stands during the wait as well as after it.
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

    // Nothing to assert on the application, which is gone; the property is
    // that the timer fired into a disposed composition without throwing, which
    // an unhandled rejection or a listener error would surface as a failure
    // here.
    expect(document.querySelector('#board-canvas')).not.toBeNull();
  });
});

describe('when the context comes back after the fallback committed', () => {
  beforeEach(() => {
    installWebGL();
    resetWebGLSupportProbe();
  });

  /** Loses the context and waits out the grace, so the fallback commits. */
  const commitTheFallback = async (): Promise<void> => {
    fireContextEvent('webglcontextlost');
    await waitOutGrace();
    await settleFrames();
  };

  it('reclaims the 2.5D board', async () => {
    application = startWithRun(document);
    await settleFrames();

    expect(application.renderer.mode).toBe('three');

    await commitTheFallback();

    expect(application.renderer.mode).toBe('number-only');
    expect(application.preferences.isNumberOnlyForced()).toBe(true);

    // The defect this closes: the swap destroyed the renderer AND the
    // `webglcontextrestored` listener it had installed, so a restoration
    // arriving after the wait reached nobody — while the renderer's own parting
    // message promised drawing resumes when the context comes back. The root's
    // listener is on the canvas, which outlives every swap. DL-MAIN-33.
    fireContextEvent('webglcontextrestored');
    await settleFrames();

    expect(application.renderer.mode).toBe('three');
    expect(application.preferences.isNumberOnlyForced()).toBe(false);
    expect(application.renderer.fallback).toBe(false);
  });

  it('replays the last commit into the reclaimed board', async () => {
    application = startWithRun(document);
    await settleFrames();

    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        code: 'ArrowDown',
        bubbles: true,
      }),
    );
    await settleFrames();
    await commitTheFallback();

    expect(numberOnlyTiles()).toBeGreaterThan(0);

    fireContextEvent('webglcontextrestored');
    await settleFrames();

    // The reclaim goes through the preference store, so it takes the same
    // destroy-mount-subscribe-replay path the settings toggle takes: the board
    // comes back populated rather than empty.
    expect(gridCells()).toBeGreaterThan(0);
    expect(numberOnlyTiles()).toBe(0);
  });

  it('reports the WebGL check healthy again', async () => {
    application = start(document);
    await settleFrames();
    await commitTheFallback();

    const during = application.health
      .report({ refresh: true })
      .checks.find((check) => check.id === 'webgl');

    expect(during?.status).toBe('fail');

    fireContextEvent('webglcontextrestored');
    await settleFrames();

    const after = application.health
      .report({ refresh: true })
      .checks.find((check) => check.id === 'webgl');

    // The settings control is unlocked by the same release, so the promise the
    // renderer made and the state the surfaces report now agree.
    expect(after?.status).toBe('pass');
    expect(application.health.readiness().requiresNumberOnlyFallback).toBe(
      false,
    );
    expect(application.preferences.isNumberOnlyForced()).toBe(false);
  });

  it('announces the reclaim through the live region', async () => {
    application = start(document);
    await settleFrames();
    await commitTheFallback();

    fireContextEvent('webglcontextrestored');
    await settleFrames();

    for (let turn = 0; turn < 6; turn += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }

    const announced = Array.from(document.querySelectorAll('[aria-live]'))
      .map((region) => region.textContent ?? '')
      .join(' ')
      .toLowerCase();

    // Assertive for the same reason the takeover was: the board the player is
    // reading has been replaced by a different one.
    expect(announced).toContain('3d board is available again');
  });

  it('leaves a number-only board the PLAYER chose exactly where it is',
    async () => {
      application = start(document);
      await settleFrames();

      application.preferences.setNumberOnlyMode(true);
      await settleFrames();

      expect(application.renderer.mode).toBe('number-only');
      expect(application.preferences.isNumberOnlyForced()).toBe(false);

      fireContextEvent('webglcontextrestored');
      await settleFrames();

      // The reclaim matches on the context-loss reason, so a choice is not a
      // force and nothing here is a force to release. R9's accessible rendering
      // mode is not a capability gap to be recovered from.
      expect(application.renderer.mode).toBe('number-only');
      expect(application.preferences.isNumberOnlyForced()).toBe(false);
    });

  it('leaves a fallback imposed for an unmountable renderer alone', async () => {
    application = start(document);
    await settleFrames();

    // A different force entirely: the reason names the document and the build,
    // and a context returning says nothing about either.
    application.preferences.forceNumberOnlyMode(
      'the WebGL board could not be mounted',
    );
    await settleFrames();

    expect(application.renderer.mode).toBe('number-only');

    fireContextEvent('webglcontextrestored');
    await settleFrames();

    expect(application.renderer.mode).toBe('number-only');
    expect(application.preferences.isNumberOnlyForced()).toBe(true);
  });

  /**
   * Collects the reason of every health recheck from HERE on.
   *
   * A sink rather than the record buffer: a renderer swap emits enough records
   * to evict one from the ring, and the recheck is a debug record so the level
   * is lowered first.
   *
   * @param app Application to observe.
   * @returns The reasons collected so far, newest last.
   */
  const collectRechecks = (app: Application): (() => string[]) => {
    const reasons: string[] = [];

    app.logger.setLevel('debug');
    app.logger.subscribe((record): void => {
      if (record.message === 'Health rechecked.') {
        reasons.push(String(record.fields?.['reason'] ?? ''));
      }
    });

    return (): string[] => [...reasons];
  };

  // A performance review found the reclaim recomputing the health report twice
  // for one restoration: the force release swaps the renderer, and a swap ends
  // with its own recheck. DL-MAIN-41.
  it('recomputes the health report once for a reclaim that swapped', async () => {
    // `start` rather than `startWithRun`: beginning a run rotates the
    // correlation identifier, which returns the health surface to its start, and
    // `refreshHealth` is silent until a report has been produced (DL-MAIN-28).
    application = start(document);
    await settleFrames();
    await commitTheFallback();

    const app = application;
    const reasons = collectRechecks(app);

    fireContextEvent('webglcontextrestored');
    await settleFrames();

    expect(app.renderer.mode).toBe('three');
    expect(reasons()).toHaveLength(1);
    expect(reasons()[0]).toContain('a switch to the three board');
  });

  // The other half of DL-MAIN-41: a release that swaps nothing still refreshes,
  // because the live WebGL verdict has changed even though the board has not.
  it('still recomputes it for a release that swapped nothing', async () => {
    application = start(document);
    await settleFrames();
    await commitTheFallback();

    const app = application;

    // The player's own choice outlives the force, so releasing the force leaves
    // the number-only board exactly where it is.
    app.preferences.setNumberOnlyMode(true);
    await settleFrames();

    const reasons = collectRechecks(app);

    fireContextEvent('webglcontextrestored');
    await settleFrames();

    expect(app.renderer.mode).toBe('number-only');
    expect(reasons()).toEqual([
      'a WebGL context reclaimed after the fallback',
    ]);
  });

  it('reclaims nothing after the application is disposed', async () => {
    application = start(document);
    await settleFrames();
    await commitTheFallback();

    application.dispose();
    application = null;

    // The listener is released with the other root-owned subscriptions, so this
    // reaches nothing and raises nothing.
    expect(() => {
      fireContextEvent('webglcontextrestored');
    }).not.toThrow();
  });
});
