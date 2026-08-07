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
// WHY THE MARKUP IS BUILT HERE
//   `start()` looks up eight elements and guards every lookup, so it runs
//   against an empty document. The fixture below carries the four the board
//   needs, in the nesting index.html declares, so the assertions read the
//   surfaces a player would see rather than the guarded-miss path.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from '../../../src/main';
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
