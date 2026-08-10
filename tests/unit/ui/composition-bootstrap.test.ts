// Contract suite for the BOOT DEFERRAL, the successor of js/application.js
// L1-L4.
//
// `bootstrap` takes its document, its scheduler and its composer as options,
// so the deferral is observable without waiting on a real frame and without
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

interface Composer {
  readonly compose: (ownerDocument: Document) => Application;
  readonly calls: number[];
}

/** A stand-in for `start`. */
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

    // One frame, as js/application.js L2 deferred by one.
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

    // The default scheduler is `requestAnimationFrame`, so one frame is
    // enough.
    expect(composer.calls).toHaveLength(1);
  });
});

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

    // Neither composed NOR scheduled: the composition reads several markup
    // mount points, and a module script can be evaluated while the document
    // loads.
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

describe('a boot cancelled while the document is still parsing', () => {
  /**
   * A document double that is still parsing, recording what subscribes to it and
   * what unsubscribes.
   *
   * @returns The double, the listeners it holds and the removals it saw.
   */
  const parsingDocument = (): {
    ownerDocument: Document;
    listeners: (() => void)[];
    removed: (() => void)[];
  } => {
    const listeners: (() => void)[] = [];
    const removed: (() => void)[] = [];

    const ownerDocument = {
      readyState: 'loading',
      addEventListener: (_event: string, listener: () => void): void => {
        listeners.push(listener);
      },
      removeEventListener: (_event: string, listener: () => void): void => {
        removed.push(listener);
      },
    } as unknown as Document;

    return { ownerDocument, listeners, removed };
  };

  it('composes nothing when the document becomes ready', () => {
    const composer = createComposer();
    const parsing = parsingDocument();
    const scheduled: (() => void)[] = [];

    expect(
      bootstrap({
        ownerDocument: parsing.ownerDocument,
        schedule: (callback): void => {
          scheduled.push(callback);
        },
        compose: composer.compose,
      }),
    ).toBe('awaiting-document');

    // The caller composes while the document is STILL PARSING, which is the case
    // the record has to already exist for.
    application = start(document);

    parsing.listeners[0]?.();

    // Nothing was even scheduled, let alone composed: a second application over
    // one document means two engines, two renderers and two input managers.
    // DL-MAIN-26.
    expect(scheduled).toHaveLength(0);
    expect(composer.calls).toHaveLength(0);
  });

  it('releases the document listener it was waiting on', () => {
    const composer = createComposer();
    const parsing = parsingDocument();

    bootstrap({
      ownerDocument: parsing.ownerDocument,
      schedule: (): void => undefined,
      compose: composer.compose,
    });

    expect(parsing.listeners).toHaveLength(1);
    expect(parsing.removed).toHaveLength(0);

    application = start(document);

    // Cancelled records release their wait, so no inert handler is left attached
    // to the document.
    expect(parsing.removed).toEqual(parsing.listeners);
  });

  it('is cancelled without raising through a document that cannot unsubscribe', () => {
    const composer = createComposer();
    const listeners: (() => void)[] = [];
    const subscribeOnly = {
      readyState: 'loading',
      addEventListener: (_event: string, listener: () => void): void => {
        listeners.push(listener);
      },
    } as unknown as Document;

    bootstrap({
      ownerDocument: subscribeOnly,
      schedule: (): void => undefined,
      compose: composer.compose,
    });

    // `start` must not fail over the release of a boot it is superseding.
    expect(() => {
      application = start(document);
    }).not.toThrow();

    listeners[0]?.();

    expect(composer.calls).toHaveLength(0);
  });
});

describe('the inspection handle', () => {
  /** The published handle, read by name off the global object. */
  const published = (): unknown =>
    (globalThis as unknown as Record<string, unknown>)['__blitzy2048'];

  afterEach(() => {
    Reflect.deleteProperty(
      globalThis as unknown as Record<string, unknown>,
      '__blitzy2048',
    );
  });

  it('is published by the boot and cleared by the disposal', () => {
    const scheduled: (() => void)[] = [];

    bootstrap({
      ownerDocument: document,
      schedule: (callback): void => {
        scheduled.push(callback);
      },
    });

    scheduled[0]?.();

    const composed = published();

    expect(composed).toBeDefined();

    (composed as Application).dispose();

    // The handle held the whole graph — engine, renderer, registry, storage —
    // reachable by name for the life of the page. DL-MAIN-25.
    expect(published()).toBeUndefined();
    expect('__blitzy2048' in globalThis).toBe(false);
  });

  it('leaves a newer application s handle alone', () => {
    const scheduled: (() => void)[] = [];

    bootstrap({
      ownerDocument: document,
      schedule: (callback): void => {
        scheduled.push(callback);
      },
    });

    scheduled[0]?.();

    const first = published() as Application;

    // A second application takes the name, as a console session composing its
    // own would.
    document.body.innerHTML = MARKUP;
    resetWebGLSupportProbe();

    const second: (() => void)[] = [];

    bootstrap({
      ownerDocument: document,
      schedule: (callback): void => {
        second.push(callback);
      },
    });

    second[0]?.();

    const latest = published() as Application;

    expect(latest).not.toBe(first);

    // The LATE disposal of the superseded application must not clear the handle
    // the live one published.
    first.dispose();

    expect(published()).toBe(latest);

    latest.dispose();

    expect(published()).toBeUndefined();
  });
});
