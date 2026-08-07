// The engine-to-announcer translation, and the single-region guarantee.
//
// The defect this covers was not a broken translation — it was the total
// absence of one. `createLiveRegionAnnouncer` shipped complete and tested and
// was never constructed, so `#live-region` stayed empty for the whole life of a
// run: a screen-reader user was told nothing about a move, a merge, a spawn or a
// verdict. These cases therefore assert that announcements REACH THE REGION,
// not merely that a function was called.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createEngineEvents } from '../../../src/engine/engine-events';
import type {
  EngineEvents,
  MoveAfterEvent,
  StateCommitEvent,
} from '../../../src/engine/engine-events';
import { Grid } from '../../../src/engine/grid';
import { Tile } from '../../../src/engine/tile';
import { createEngineAnnouncer } from '../../../src/ui/a11y/engine-announcer';
import type { EngineAnnouncer } from '../../../src/ui/a11y/engine-announcer';
import { createLiveRegionAnnouncer } from '../../../src/ui/a11y/live-region';
import type { LiveRegionAnnouncer } from '../../../src/ui/a11y/live-region';
import { EMPTY_RELIC_CONTEXT, EMPTY_STAGE_CONTEXT } from '../../../src/engine/types';

const REGION_MARKUP =
  '<div class="visually-hidden live-region" id="live-region" ' +
  'role="status" aria-live="polite" aria-atomic="true"></div>';

let announcer: LiveRegionAnnouncer | null = null;
let translator: EngineAnnouncer | null = null;

beforeEach(() => {
  document.body.innerHTML = REGION_MARKUP;
});

afterEach(() => {
  translator?.destroy();
  announcer?.destroy();
  translator = null;
  announcer = null;
  document.body.innerHTML = '';
});

interface Harness {
  readonly events: EngineEvents;
  readonly region: HTMLElement;
  readonly translator: EngineAnnouncer;

  /** Text the region currently holds, with whitespace collapsed. */
  read(): string;
}

const setup = (): Harness => {
  const region = document.querySelector<HTMLElement>('#live-region');

  if (region === null) {
    throw new Error('the fixture lost the region');
  }

  // The announcer writes in two phases — clear the region, then write on a
  // LATER task, which is what makes assistive technology re-announce a line
  // identical to the one before it. The default scheduler is a zero-delay
  // `setTimeout`, so a synchronous read would see an empty region and prove
  // nothing. Draining the queued tasks by hand makes each read deterministic
  // without a fake clock.
  const queued: (() => void)[] = [];
  const built = createLiveRegionAnnouncer({
    root: document,
    schedule: (callback): { cancel(): void } => {
      queued.push(callback);

      return {
        cancel(): void {
          const index = queued.indexOf(callback);

          if (index >= 0) {
            queued.splice(index, 1);
          }
        },
      };
    },
  });
  const drain = (): void => {
    // Each phase schedules the next, so this runs until the write settles.
    let guard = 0;

    while (queued.length > 0 && guard < 64) {
      const next = queued.shift();

      next?.();
      guard += 1;
    }
  };
  const bridge = createEngineAnnouncer({ announcer: built });
  const emitter = createEngineEvents();

  announcer = built;
  translator = bridge;

  bridge.subscribe(emitter);

  return {
    events: emitter,
    region,
    translator: bridge,
    read: (): string => {
      // Composed, then written: `flush` turns the queue into lines and `drain`
      // runs the phased writes those lines scheduled.
      built.flush();
      drain();

      // BOTH regions, because a verdict is assertive and a polite
      // `role="status"` region does not interrupt — so the announcer creates an
      // `aria-live="assertive"` sibling on first assertive use and writes
      // verdicts there. Reading only the polite region would miss every verdict,
      // which is what the user is most owed.
      return Array.from(document.querySelectorAll('[aria-live]'))
        .map((live) => live.textContent ?? '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    },
  };
};

const commit = (
  score: number,
  flags: {
    over?: boolean;
    won?: boolean;
    terminated?: boolean;
  } = {},
): StateCommitEvent => ({
  board: new Grid(4),
  score,
  bestScore: 0,
  over: flags.over ?? false,
  won: flags.won ?? false,
  terminated: flags.terminated ?? false,
  stage: EMPTY_STAGE_CONTEXT,
  relics: EMPTY_RELIC_CONTEXT,
});

const moveAfter = (moved: boolean, score: number): MoveAfterEvent => ({
  moved,
  board: new Grid(4),
  score,
  over: false,
  won: false,
  terminated: false,
});

/* ==========================================================================
 * A move reaches the region
 * ========================================================================== */

describe('a move reaches the region', () => {
  it('announces the direction the engine resolved, with the score', () => {
    const harness = setup();

    harness.events.emit('move:before', {
      direction: 3,
      board: new Grid(4),
      cancelled: false,
    });
    harness.events.emit('move:after', moveAfter(true, 12));

    const text = harness.read();

    // The region was EMPTY for every move before this wiring existed.
    expect(text).not.toBe('');
    expect(text.toLowerCase()).toContain('left');
    expect(text).toContain('12');
  });

  it('announces the redirected direction, not the requested one', () => {
    const harness = setup();

    // A hook may redirect a move, and `move:before` carries the direction the
    // engine will actually resolve in. Announcing the request would tell the
    // player something that did not happen.
    harness.events.emit('move:before', {
      direction: 1,
      board: new Grid(4),
      cancelled: false,
    });
    harness.events.emit('move:after', moveAfter(true, 4));

    expect(harness.read().toLowerCase()).toContain('right');
  });

  it('says nothing for a move that changed nothing', () => {
    const harness = setup();

    harness.events.emit('move:before', {
      direction: 0,
      board: new Grid(4),
      cancelled: false,
    });
    harness.events.emit('move:after', moveAfter(false, 0));

    // A move against a wall spawns nothing and is worth no announcement.
    expect(harness.read()).toBe('');
  });

  it('says nothing for a cancelled move', () => {
    const harness = setup();

    // A cancelled move emits no `move:after`, so the captured direction is
    // never paired and nothing is announced.
    harness.events.emit('move:before', {
      direction: 2,
      board: new Grid(4),
      cancelled: true,
    });

    expect(harness.read()).toBe('');
  });
});

/* ==========================================================================
 * Merges and spawns
 * ========================================================================== */

describe('merges and spawns reach the region', () => {
  it('announces a merge with the value it produced', () => {
    const harness = setup();

    harness.events.emit('tile:merge', {
      source: new Tile({ x: 0, y: 0 }, 4),
      target: new Tile({ x: 1, y: 0 }, 4),
      resultValue: 8,
      scoreDelta: 8,
    });

    expect(harness.read()).toContain('8');
  });

  it('announces both merges of a two-merge move', () => {
    const harness = setup();

    harness.events.emit('move:before', {
      direction: 3,
      board: new Grid(4),
      cancelled: false,
    });
    harness.events.emit('tile:merge', {
      source: new Tile({ x: 0, y: 0 }, 4),
      target: new Tile({ x: 1, y: 0 }, 4),
      resultValue: 8,
      scoreDelta: 8,
    });
    harness.events.emit('tile:merge', {
      source: new Tile({ x: 0, y: 1 }, 8),
      target: new Tile({ x: 1, y: 1 }, 8),
      resultValue: 16,
      scoreDelta: 16,
    });
    harness.events.emit('move:after', moveAfter(true, 24));

    const text = harness.read();

    // `tile:merge` is emitted once per merge, so a listener counting emissions
    // counts merges. Both must survive into the line.
    expect(text).toContain('2');
    expect(text).toContain('24');
  });

  it('announces a spawn with its cell', () => {
    const harness = setup();

    harness.events.emit('tile:spawn', { position: { x: 2, y: 1 }, value: 4 });

    const text = harness.read();

    expect(text).toContain('4');

    // One-based in prose, zero-based in the payload.
    expect(text).toContain('3');
    expect(text).toContain('2');
  });

  it('states no cell for a spawn that resolved without one', () => {
    const harness = setup();

    harness.events.emit('tile:spawn', { value: 2 });

    expect(() => harness.read()).not.toThrow();
    expect(harness.read()).not.toContain('undefined');
  });
});

/* ==========================================================================
 * Verdicts
 * ========================================================================== */

describe('a verdict reaches the region', () => {
  it('announces a win once, not on every later commit', () => {
    const harness = setup();

    harness.events.emit('state:commit', commit(2048, {
      won: true,
      terminated: true,
    }));

    expect(harness.read()).not.toBe('');
    expect(harness.translator.lastVerdict()).toBe('win');

    const after = harness.read();

    // Every commit carries the terminal flags. Without transition tracking the
    // verdict would be repeated after every subsequent move.
    harness.events.emit('state:commit', commit(2048, {
      won: true,
      terminated: true,
    }));

    expect(harness.read()).toBe(after);
  });

  it('distinguishes a win from a win the player carried on past', () => {
    const harness = setup();

    harness.events.emit('state:commit', commit(2048, {
      won: true,
      terminated: true,
    }));

    expect(harness.translator.lastVerdict()).toBe('win');

    // Keep Going clears `terminated` without clearing `won`.
    harness.events.emit('state:commit', commit(2052, { won: true }));

    expect(harness.translator.lastVerdict()).toBe('continued-win');
  });

  it('announces a loss', () => {
    const harness = setup();

    harness.events.emit('state:commit', commit(300, {
      over: true,
      terminated: true,
    }));

    expect(harness.translator.lastVerdict()).toBe('loss');
    expect(harness.read()).not.toBe('');
  });

  it('holds no verdict while the run is in play', () => {
    const harness = setup();

    harness.events.emit('state:commit', commit(16));

    expect(harness.translator.lastVerdict()).toBeNull();
  });
});

/* ==========================================================================
 * Lifecycle
 * ========================================================================== */

describe('the translator lifecycle', () => {
  it('stops announcing once its subscription is released', () => {
    const harness = setup();
    const release = harness.translator.subscribe(harness.events);

    release();

    // The first subscription from `setup` is still live, so this proves the
    // release is scoped to its own subscription rather than global.
    harness.events.emit('tile:spawn', { position: { x: 0, y: 0 }, value: 2 });

    expect(harness.read()).not.toBe('');
  });

  it('announces nothing after destroy, and does not throw', () => {
    const harness = setup();

    harness.translator.destroy();

    expect(() => {
      harness.events.emit('tile:spawn', { position: { x: 0, y: 0 }, value: 2 });
      harness.events.emit('state:commit', commit(9, {
        over: true,
        terminated: true,
      }));
    }).not.toThrow();

    expect(harness.read()).toBe('');
  });

  it('refuses a subscription after destroy without throwing', () => {
    const harness = setup();

    harness.translator.destroy();

    const release = harness.translator.subscribe(harness.events);

    expect(() => {
      release();
      release();
    }).not.toThrow();
  });

  it('tolerates being destroyed more than once', () => {
    const harness = setup();

    expect(() => {
      harness.translator.destroy();
      harness.translator.destroy();
    }).not.toThrow();
  });
});
