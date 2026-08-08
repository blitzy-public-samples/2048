// Contract suite for the BOOT DEFERRAL, the successor of js/application.js
// L1-L4.
//
// WHAT THE VANILLA ENTRY DID, AND WHY IT MATTERS
//   Its whole body was one `window.requestAnimationFrame` callback wrapping the
//   composition. Deferring by exactly ONE FRAME is what let the browser paint
//   the styled, empty board before any of the game's own work ran; composing
//   immediately instead delays that first paint by however long the whole object
//   graph takes to build, which on this build is a Three.js scene, a preference
//   store, an input layer, an audio layer and an observability stack.
//
//   The rewrite had replaced that with a `DOMContentLoaded` listener and an
//   otherwise immediate call, which is a different thing: a module script is
//   deferred by definition, so on a normal load the listener never fires and the
//   composition runs synchronously during evaluation — the exact behaviour the
//   original avoided.
//
// WHAT THIS SUITE PINS
//   That the composition is deferred by exactly one scheduled callback, that the
//   readiness guard defers rather than composes, that the guard is armed once,
//   and that a CALLER composing first supersedes the automatic boot so one
//   document never hosts two applications.
//
// `bootstrap` takes its document, its scheduler and its composer as options, so
// the deferral is observable without waiting on a real frame and without
// building the real application more than once.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bootstrap, start } from '../../../src/main';
import type { Application } from '../../../src/main';
import { resetWebGLSupportProbe } from '../../../src/render/webgl-support';
import { clearOwnedStorage } from '../../fixtures/storage';

/** The board region src/main.ts looks up. Every lookup it makes is guarded. */
const MARKUP = `
  <main id="game-main">
    <div class="score-container"><span class="visually-hidden">Score</span>0</div>
    <div class="best-container"><span class="visually-hidden">Best score</span>0</div>
    <div class="game-container">
      <div class="game-message"><p></p></div>
      <div class="board-host" id="board-host">
        <canvas class="board-canvas" id="board-canvas" aria-hidden="true"></canvas>
        <div class="board-number-only" id="board-number-only" hidden></div>
        <div class="board-a11y" id="board-a11y" role="grid" aria-busy="true"></div>
      </div>
    </div>
  </main>
  <div class="visually-hidden live-region" id="live-region" role="status"
       aria-live="polite" aria-atomic="true"></div>
`;

let application: Application | null = null;

/** A composer that records its calls instead of building anything. */
interface Composer {
  readonly compose: (ownerDocument: Document) => Application;
  readonly calls: number[];
}

/**
 * A stand-in for `start`.
 *
 * It returns an object carrying only the two members `publishForInspection`
 * reads — a logger to report a failed publish through, and a dispose — so the
 * boot path runs in full without a second real application being built over the
 * same markup.
 */
const createComposer = (): Composer => {
  const calls: number[] = [];

  return {
    calls,
    compose: (): Application => {
      calls.push(calls.length);

      return {
        logger: {
          debug: (): void => undefined,
        },
        dispose: (): void => undefined,
      } as unknown as Application;
    },
  };
};

beforeEach(() => {
  document.body.innerHTML = MARKUP;
  resetWebGLSupportProbe();
});

afterEach(() => {
  application?.dispose();
  application = null;
  resetWebGLSupportProbe();
  document.body.innerHTML = '';
  clearOwnedStorage();
});

/* ==========================================================================
 * The deferral
 * ========================================================================== */

describe('the boot deferral', () => {
  it('schedules the composition instead of running it', () => {
    const composer = createComposer();
    const scheduled: (() => void)[] = [];

    const outcome = bootstrap({
      ownerDocument: document,
      schedule: (callback): void => {
        scheduled.push(callback);
      },
      compose: composer.compose,
    });

    // Nothing has been composed yet, which is the whole point: the frame the
    // browser paints comes first.
    expect(outcome).toBe('scheduled');
    expect(composer.calls).toHaveLength(0);
    expect(scheduled).toHaveLength(1);
  });

  it('composes once when the scheduled callback runs', () => {
    const composer = createComposer();
    const scheduled: (() => void)[] = [];

    bootstrap({
      ownerDocument: document,
      schedule: (callback): void => {
        scheduled.push(callback);
      },
      compose: composer.compose,
    });

    scheduled[0]?.();

    expect(composer.calls).toHaveLength(1);
  });

  it('defers by EXACTLY ONE callback, not a loop or a poll', () => {
    const composer = createComposer();
    const scheduled: (() => void)[] = [];

    bootstrap({
      ownerDocument: document,
      schedule: (callback): void => {
        scheduled.push(callback);
      },
      compose: composer.compose,
    });

    scheduled[0]?.();

    // One frame, as js/application.js L2 deferred by one. A second scheduling
    // would be a poll, and a poll would paint late on a slow first frame.
    expect(scheduled).toHaveLength(1);
    expect(composer.calls).toHaveLength(1);
  });

  it('uses the animation frame by default', async () => {
    const composer = createComposer();

    bootstrap({ ownerDocument: document, compose: composer.compose });

    expect(composer.calls).toHaveLength(0);

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        resolve();
      });
    });

    // The default scheduler is `requestAnimationFrame`, so one frame is enough.
    expect(composer.calls).toHaveLength(1);
  });
});

/* ==========================================================================
 * The readiness guard
 * ========================================================================== */

describe('the readiness guard', () => {
  it('waits for the document while it is still parsing', () => {
    const composer = createComposer();
    const scheduled: (() => void)[] = [];
    const listeners: (() => void)[] = [];

    const parsing = {
      readyState: 'loading',
      addEventListener: (_event: string, listener: () => void): void => {
        listeners.push(listener);
      },
    } as unknown as Document;

    const outcome = bootstrap({
      ownerDocument: parsing,
      schedule: (callback): void => {
        scheduled.push(callback);
      },
      compose: composer.compose,
    });

    // Neither composed NOR scheduled: the composition reads several markup mount
    // points, and a module script can be evaluated while the document loads.
    expect(outcome).toBe('awaiting-document');
    expect(scheduled).toHaveLength(0);
    expect(composer.calls).toHaveLength(0);
    expect(listeners).toHaveLength(1);
  });

  it('still defers by one frame after the document is ready', () => {
    const composer = createComposer();
    const scheduled: (() => void)[] = [];
    const listeners: (() => void)[] = [];

    const parsing = {
      readyState: 'loading',
      addEventListener: (_event: string, listener: () => void): void => {
        listeners.push(listener);
      },
    } as unknown as Document;

    bootstrap({
      ownerDocument: parsing,
      schedule: (callback): void => {
        scheduled.push(callback);
      },
      compose: composer.compose,
    });

    listeners[0]?.();

    // The guard defers; it does not compose. The one-frame deferral applies
    // afterwards exactly as it does on a ready document.
    expect(scheduled).toHaveLength(1);
    expect(composer.calls).toHaveLength(0);

    scheduled[0]?.();

    expect(composer.calls).toHaveLength(1);
  });
});

/* ==========================================================================
 * One document, one application
 * ========================================================================== */

describe('a caller that composes first', () => {
  it('supersedes the pending boot', () => {
    const composer = createComposer();
    const scheduled: (() => void)[] = [];

    bootstrap({
      ownerDocument: document,
      schedule: (callback): void => {
        scheduled.push(callback);
      },
      compose: composer.compose,
    });

    // The real composition, by a caller, before the boot's frame arrives.
    application = start(document);

    scheduled[0]?.();

    // The boot stands down rather than binding the same markup a second time:
    // every control would be bound twice and every keystroke handled twice.
    expect(composer.calls).toHaveLength(0);
  });

  it('leaves a later boot free to compose again', () => {
    const composer = createComposer();
    const first: (() => void)[] = [];

    bootstrap({
      ownerDocument: document,
      schedule: (callback): void => {
        first.push(callback);
      },
      compose: composer.compose,
    });

    application = start(document);
    first[0]?.();

    application.dispose();
    application = null;
    document.body.innerHTML = MARKUP;

    const second: (() => void)[] = [];

    bootstrap({
      ownerDocument: document,
      schedule: (callback): void => {
        second.push(callback);
      },
      compose: composer.compose,
    });

    second[0]?.();

    // The cancellation is per boot, not permanent: a page that disposed its
    // application and booted again composes.
    expect(composer.calls).toHaveLength(1);
  });
});
