// Contract suite for the composition root's LAST renderer failure mode, AAP R7
// and implicit requirement I6: the 2.5D factory itself raising, before any mount
// is attempted.
//
// The three failure modes are separate, and only two of them were covered:
//
//   no context at all       the probe reports `supported: false` and the
//                           number-only board is selected before a renderer is
//                           built. Covered by renderer-selection.test.ts.
//   a context refused       the probe reports a context, the renderer's own
//                           request is refused, and the mount reports
//                           `mounted: false`, which the fallback acts on. Also
//                           covered there.
//   the FACTORY raising     `createThreeRenderer()` throws before it returns.
//                           `buildRenderer()` contains the throw and hands back
//                           a mounted number-only renderer, so the board draws —
//                           but the selection describing which renderer is
//                           drawing, the preference the settings surface reads,
//                           the live context-loss reader handed to the health
//                           surface and the fallback helper's own guard were all
//                           left describing a 2.5D renderer that does not exist.
//                           That is what this file covers.
//
// WHY THE FACTORY IS MOCKED HERE. Nothing a document can be given makes the real
// factory raise: it resolves its elements through guarded lookups and unwinds a
// failed mount internally, which is exactly why the raising case had no test.
// The mock is confined to this file, and the module is replaced whole, because
// `src/main.ts` imports one value from it and no other module imports it at all.
//
// The hostile thrown value is deliberate. A catch that reduces a caught value
// with `String(value)`, `value.name` or `value.message` can be made to raise
// from inside the containment boundary itself, which would take `start()` down
// along with the input manager, the screens and the focus manager — the very
// outcome the boundary exists to prevent. `describeRenderError()` is the total
// reduction, and this file pins that it is the one used.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const HOSTILE_MESSAGE = 'the 2.5D factory refused to construct';

/**
 * A thrown value whose every conversion path raises.
 *
 * `String(value)` reaches `Symbol.toPrimitive`, then `toString`, then `valueOf`;
 * `value.name` and `value.message` reach their own accessors. All five raise, so
 * any reduction other than a contained one propagates.
 */
const hostileThrow = (): never => {
  const hostile = {
    get name(): string {
      throw new Error('name is hostile');
    },
    get message(): string {
      throw new Error('message is hostile');
    },
    toString(): string {
      throw new Error('toString is hostile');
    },
    valueOf(): never {
      throw new Error('valueOf is hostile');
    },
    [Symbol.toPrimitive](): never {
      throw new Error('toPrimitive is hostile');
    },
  };

  throw hostile;
};

vi.mock('../../../src/render/three-renderer', () => ({
  createThreeRenderer: (): never => hostileThrow(),
}));

const { CONTEXT_RESTORE_GRACE_MS, start } = await import('../../../src/main');
const { resetWebGLSupportProbe } = await import(
  '../../../src/render/webgl-support'
);
const { applyTheme } = await import('../../../src/theme/themes');
const { createMockWebGLContext } = await import('../../fixtures/webgl');

type Application = Awaited<ReturnType<() => ReturnType<typeof start>>>;

/** The board region of index.html, with the four elements the root looks up. */
const BOARD_MARKUP = `
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
        <div class="board-a11y" id="board-a11y" role="grid"
             aria-label="Game board" aria-busy="true"></div>
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

const nativeGetContext = HTMLCanvasElement.prototype.getContext;

let application: Application | null = null;

/**
 * Makes every canvas answer with a mocked WebGL 2 context, so the probe reports
 * a context available and the root selects the 2.5D mode — which is the only
 * path that reaches the factory at all.
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

const numberOnlyTiles = (): number =>
  document.querySelectorAll('#board-number-only .tile').length;

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

beforeEach(() => {
  document.body.innerHTML = BOARD_MARKUP;
  installWebGL();
  resetWebGLSupportProbe();
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

describe('when the 2.5D factory itself raises', () => {
  it('composes the application rather than failing the boot', () => {
    // The containment boundary's whole purpose. A reduction that raises inside
    // the catch propagated out of `start()`, losing the input manager, the
    // screens and the focus manager along with the board.
    expect(() => {
      application = start(document);
    }).not.toThrow();

    expect(application).not.toBeNull();
  });

  it('reports the number-only board as the one drawing', async () => {
    application = start(document);

    await settleFrames();

    // `selection` is what every later reader consults. Left at 'three' it named
    // a renderer that was never constructed.
    expect(application.renderer.support.supported).toBe(true);
    expect(application.renderer.mode).toBe('number-only');
    expect(application.renderer.fallback).toBe(true);
    expect(numberOnlyTiles()).toBeGreaterThan(0);
  });

  it('forces the number-only preference, as a failed mount does', () => {
    application = start(document);

    // The settings surface reads the force to report that the 2.5D choice is no
    // longer available on this machine.
    expect(application.preferences.isNumberOnlyForced()).toBe(true);
    expect(application.preferences.isNumberOnlyMode()).toBe(true);
    expect(application.preferences.getNumberOnlyForce().forced).toBe(true);
  });

  it('names the number-only board in the selection it reports', () => {
    application = start(document);

    const selection = application.logger
      .recent(200)
      .filter((record) => record.message.startsWith('Board drawn by the'));

    // `reportSelection()` reads the same `selection` every other consumer does,
    // so a stale mode is stated on the record a reader would correlate from:
    // 'Board drawn by the three renderer' for a renderer that never existed.
    expect(selection).toHaveLength(1);
    expect(selection[0]?.message).toBe(
      'Board drawn by the number-only renderer.',
    );
    expect(selection[0]?.fields?.mode).toBe('number-only');
    expect(selection[0]?.fields?.webglFallback).toBe(true);
  });

  it('does not park the board on a context-loss event it cannot receive', async () => {
    application = start(document);

    await settleFrames();

    document
      .querySelector('#board-canvas')
      ?.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));

    await new Promise<void>((resolve) => {
      setTimeout(resolve, CONTEXT_RESTORE_GRACE_MS + 60);
    });

    // The number-only board is still the board, and still drawing.
    expect(application.renderer.mode).toBe('number-only');
    expect(numberOnlyTiles()).toBeGreaterThan(0);
  });

  it('records the failure as an error the log can carry whole', () => {
    application = start(document);

    const reported = application.logger
      .recent(200)
      .filter((record) =>
        record.message.startsWith('The 2.5D renderer could not be constructed'),
      );

    expect(reported).toHaveLength(1);
    expect(reported[0]?.level).toBe('error');

    // The two-field summary the total reduction produces for a value that
    // answers nothing: reported rather than raised, and carrying no text read
    // off the hostile object itself.
    const error = reported[0]?.error;

    expect(error).toBeDefined();
    expect(typeof error?.name).toBe('string');
    expect(error?.message).not.toContain(HOSTILE_MESSAGE);
  });
});
