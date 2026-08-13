// Contract suite for the BOOT DEFERRAL, the successor of js/application.js
// L1-L4.
//
// `bootstrap` takes its document, its scheduler and its composer as options,
// so the deferral is observable without waiting on a real frame and without
// building the real application more than once.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PREFERENCE_WRITE_COALESCE_MS,
  bootstrap,
  start,
} from '../../../src/main';
import type { Application } from '../../../src/main';
import { resetWebGLSupportProbe } from '../../../src/render/webgl-support';
import {
  clearOwnedStorage,
  readOwnedStorage,
  seedOwnedStorage,
} from '../../fixtures/storage';

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

describe('the persisted best score on the first screen', () => {
  /**
   * `MARKUP` plus a run-start container.
   *
   * Without one `router.hostFor('runStart')` is `null`, which is the documented
   * degradation of DL-MAIN-19: the boot opens the board at once and the flow
   * never holds `runStart`. The state this finding is about is reachable only
   * where the container the player would begin the run from exists.
   */
  const MARKUP_WITH_RUN_START = `${MARKUP}
    <div class="screen-layer" id="screen-layer">
      <div class="screen" id="screen-run-start" data-screen="run-start"
           role="dialog" aria-modal="true" aria-label="Start a run" hidden></div>
    </div>
  `;

  beforeEach(() => {
    document.body.innerHTML = MARKUP_WITH_RUN_START;
    resetWebGLSupportProbe();
  });

  afterEach(() => {
    Reflect.deleteProperty(
      globalThis as unknown as Record<string, unknown>,
      '__blitzy2048',
    );
  });

  /** Composes the real application synchronously and hands it back. */
  const compose = (): Application => {
    const scheduled: (() => void)[] = [];

    bootstrap({
      ownerDocument: document,
      schedule: (callback): void => {
        scheduled.push(callback);
      },
    });

    scheduled[0]?.();

    return (globalThis as unknown as Record<string, Application>)[
      '__blitzy2048'
    ] as Application;
  };

  /** Text of the best-score outlet, with its accessible label removed. */
  const bestOutletReading = (): string => {
    const outlet = document.querySelector<HTMLElement>('.best-container');
    const label = outlet?.querySelector('.visually-hidden')?.textContent ?? '';

    return (outlet?.textContent ?? '').replace(label, '').trim();
  };

  it('is painted before the run-start screen is presented', () => {
    seedOwnedStorage({ bestScore: '13572' });

    application = compose();

    // The outlets are visible on every screen but the HUD writes them only on a
    // commit or a context refresh, and run start precedes both — so a returning
    // player was shown `BEST 0` over a best score that was on disk. DL-MAIN-32.
    expect(application.router.current()).toBe('runStart');
    expect(bestOutletReading()).toBe('13572');
  });

  it('reads the stored string without reinterpreting it', () => {
    // `getBestScore()` answers the RAW STORED STRING when a value is present,
    // and the promotion comparison in the engine depends on that shape. The
    // paint hands the value over as it is answered, so a value the vanilla game
    // wrote reaches the outlet unconverted — a leading zero survives, which
    // `Number()` would have eaten.
    seedOwnedStorage({ bestScore: '00042' });

    application = compose();

    expect(bestOutletReading()).toBe('00042');
  });

  it('writes nothing to storage to do it', () => {
    seedOwnedStorage({ bestScore: '8' });

    application = compose();

    // A read-only paint: the frozen key keeps the exact value it held, so the
    // paint cannot promote, truncate or renumber a best score.
    expect(readOwnedStorage('bestScore')).toBe('8');
  });

  it('leaves the outlet at its seeded reading when nothing is stored', () => {
    // `getBestScore()` answers the NUMBER `0` when no value is present, which is
    // the reading index.html already declares, so a first-time player sees no
    // change and no flicker.
    application = compose();

    expect(readOwnedStorage('bestScore')).toBeNull();
    expect(bestOutletReading()).toBe('0');
  });

  it('does not paint the score outlet, so no delta is computed', () => {
    seedOwnedStorage({ bestScore: '900' });

    application = compose();

    // `updateBestScore` is used rather than a full `update`, which would write
    // the score too and compute a delta against it — a `+900` floating over a
    // board that has not been played.
    const score = document.querySelector<HTMLElement>('.score-container');

    expect(score?.querySelector('.score-addition')).toBeNull();
  });
});


/* ==========================================================================
 * Issue 15 of the QA report: none of the five accessibility and presentation
 * preferences survived a reload, and no `roguelike2048:preferences` key was
 * ever written. The composition root owns both ends of that persistence.
 * DL-MAIN-34, DL-KEYS-04, DL-SETTINGS-06.
 * ========================================================================== */

describe('the persisted preferences the root restores and records', () => {
  afterEach(() => {
    Reflect.deleteProperty(
      globalThis as unknown as Record<string, unknown>,
      '__blitzy2048',
    );
    document.documentElement.removeAttribute('data-theme');
  });

  /** Composes the real application synchronously and hands it back. */
  const compose = (): Application => {
    const scheduled: (() => void)[] = [];

    bootstrap({
      ownerDocument: document,
      schedule: (callback): void => {
        scheduled.push(callback);
      },
    });

    scheduled[0]?.();

    return (globalThis as unknown as Record<string, Application>)[
      '__blitzy2048'
    ] as Application;
  };

  /** The stored envelope, parsed, or `null` where none was written. */
  const stored = (): Record<string, unknown> | null => {
    const raw = readOwnedStorage('roguelike2048:preferences');

    return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
  };

  it('writes nothing until a preference actually changes', () => {
    application = compose();

    // A first-time visitor leaves no envelope behind, exactly as the keymap
    // does not.
    expect(stored()).toBeNull();
  });

  it('records every preference the player changes', () => {
    application = compose();

    application.preferences.setTheme('high-contrast');
    application.preferences.setMotionSetting('reduce');
    application.preferences.setMuted(true);
    application.preferences.setVolume(0.5);

    const envelope = stored();

    expect(envelope).not.toBeNull();
    expect(envelope?.['schemaVersion']).toBe(1);
    expect(envelope?.['theme']).toBe('high-contrast');
    expect(envelope?.['motionSetting']).toBe('reduce');
    expect(envelope?.['muted']).toBe(true);
    expect(envelope?.['volume']).toBe(0.5);
  });

  it('restores them on the next boot, palette included', () => {
    seedOwnedStorage({
      'roguelike2048:preferences': JSON.stringify({
        schemaVersion: 1,
        theme: 'colorblind-safe',
        motionSetting: 'reduce',
        numberOnlyMode: true,
        muted: true,
        volume: 0.25,
      }),
    });

    application = compose();

    expect(application.preferences.getTheme()).toBe('colorblind-safe');
    expect(application.preferences.getMotionSetting()).toBe('reduce');
    expect(application.preferences.isNumberOnlyMode()).toBe(true);
    expect(application.preferences.isMuted()).toBe(true);
    expect(application.preferences.getVolume()).toBe(0.25);

    // The palette is ACTIVATED, not merely held: the store writes no attribute
    // at construction, so without the root's own call the document would carry
    // the default palette while the dialog reported the restored one.
    expect(document.documentElement.getAttribute('data-theme')).toBe(
      'colorblind-safe',
    );

    // And the reduced-motion reflection follows the restored setting.
    expect(document.documentElement.getAttribute('data-reduced-motion')).toBe(
      'true',
    );
  });

  it('opens on the defaults for an unreadable envelope, without throwing', () => {
    for (const hostile of ['{', 'null', '[]', '"colorblind"', '{"theme":7}']) {
      clearOwnedStorage();
      seedOwnedStorage({ 'roguelike2048:preferences': hostile });

      expect(() => {
        application = compose();
      }).not.toThrow();

      expect(application?.preferences.getTheme()).toBe('default');
      expect(application?.preferences.isMuted()).toBe(false);

      application?.dispose();
      application = null;
      Reflect.deleteProperty(
        globalThis as unknown as Record<string, unknown>,
        '__blitzy2048',
      );
      document.body.innerHTML = MARKUP;
      resetWebGLSupportProbe();
    }
  });

  it('leaves the frozen keys and the run state untouched', () => {
    seedOwnedStorage({ bestScore: '4242' });

    application = compose();

    // This markup declares no run-start container, so the boot opens the board
    // at once (DL-MAIN-19) and a run is already persisted. Captured here so the
    // preference write can be shown not to disturb it.
    const runBefore = readOwnedStorage('roguelike2048:runState');
    const boardBefore = readOwnedStorage('gameState');

    application.preferences.setTheme('high-contrast');

    // The best-score contract is frozen: same key, same stored string.
    expect(readOwnedStorage('bestScore')).toBe('4242');

    // The preference write is additive — it touches its own key and no other.
    expect(stored()?.['theme']).toBe('high-contrast');
    expect(readOwnedStorage('roguelike2048:runState')).toBe(runBefore);
    expect(readOwnedStorage('gameState')).toBe(boardBefore);
  });
});

/* ==========================================================================
 * The write cadence of that persistence. A performance review found every
 * notification writing the whole envelope synchronously: a number-only force
 * and an operating-system motion change each wrote a payload whose persisted
 * choice had not moved, and the volume slider wrote once per `input` event.
 * DL-MAIN-40.
 * ========================================================================== */

describe('the cadence of the preference write', () => {
  afterEach(() => {
    Reflect.deleteProperty(
      globalThis as unknown as Record<string, unknown>,
      '__blitzy2048',
    );
    document.documentElement.removeAttribute('data-theme');
    vi.restoreAllMocks();
  });

  /** Composes the real application synchronously and hands it back. */
  const compose = (): Application => {
    const scheduled: (() => void)[] = [];

    bootstrap({
      ownerDocument: document,
      schedule: (callback): void => {
        scheduled.push(callback);
      },
    });

    scheduled[0]?.();

    return (globalThis as unknown as Record<string, Application>)[
      '__blitzy2048'
    ] as Application;
  };

  /** Counts the writes of the preference key alone. */
  const preferenceWrites = (): (() => number) => {
    const spy = vi.spyOn(Storage.prototype, 'setItem');

    return (): number =>
      spy.mock.calls.filter(
        (call): boolean => call[0] === 'roguelike2048:preferences',
      ).length;
  };

  /** The persisted volume, or `null` where no envelope is stored. */
  const storedVolume = (): number | null => {
    const raw = readOwnedStorage('roguelike2048:preferences');

    return raw === null
      ? null
      : ((JSON.parse(raw) as Record<string, unknown>)['volume'] as number);
  };

  it('writes nothing for a change the persisted envelope does not carry', () => {
    application = compose();

    // An envelope on disk to compare against.
    application.preferences.setTheme('high-contrast');

    const writes = preferenceWrites();

    // Both of these are real changes of the EFFECTIVE number-only value and
    // neither touches the persisted CHOICE, which is what `DL-SETTINGS-06`
    // projects.
    application.preferences.forceNumberOnlyMode('a probe imposed it');
    application.preferences.releaseNumberOnlyForce();

    expect(writes()).toBe(0);

    // A change the envelope does carry still writes, once.
    application.preferences.setMuted(true);

    expect(writes()).toBe(1);

    // And the store notifies nothing for a value that is already set, so the
    // count does not move for a repeat either.
    application.preferences.setMuted(true);

    expect(writes()).toBe(1);
  });

  it('folds a run of volume changes into one write per window', () => {
    vi.useFakeTimers();

    try {
      application = compose();

      const app = application;
      const writes = preferenceWrites();

      for (let step = 1; step <= 30; step += 1) {
        app.preferences.setVolume(step / 100);
      }

      // The FIRST of a run is written at once, so a single nudge of the slider
      // is on disk before the next statement reads it.
      expect(writes()).toBe(1);
      expect(storedVolume()).toBe(0.01);

      vi.advanceTimersByTime(PREFERENCE_WRITE_COALESCE_MS);

      // The remaining 29 are one write, carrying the last value.
      expect(writes()).toBe(2);
      expect(storedVolume()).toBe(0.3);

      // The window that closed on a held change opens another, which closes
      // with nothing pending and writes nothing.
      vi.advanceTimersByTime(PREFERENCE_WRITE_COALESCE_MS * 4);

      expect(writes()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes a held volume change on disposal rather than dropping it', () => {
    vi.useFakeTimers();

    try {
      application = compose();

      const app = application;

      app.preferences.setVolume(0.2);
      app.preferences.setVolume(0.9);

      expect(storedVolume()).toBe(0.2);

      app.dispose();
      application = null;

      expect(storedVolume()).toBe(0.9);

      // And the window the root armed writes nothing after the disposal.
      vi.advanceTimersByTime(PREFERENCE_WRITE_COALESCE_MS * 4);

      expect(storedVolume()).toBe(0.9);
    } finally {
      vi.useRealTimers();
    }
  });
});
