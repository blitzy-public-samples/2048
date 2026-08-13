// The engine-to-announcer translation, and the single-region guarantee.

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

  /** Empties every live region, so a later read measures only new text. */
  clear(): void;
}

const setup = (options: { readonly subscribe?: boolean } = {}): Harness => {
  const region = document.querySelector<HTMLElement>('#live-region');

  if (region === null) {
    throw new Error('the fixture lost the region');
  }

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

  if (options.subscribe !== false) {
    bridge.subscribe(emitter);
  }

  return {
    events: emitter,
    region,
    translator: bridge,
    read: (): string => {
      // Composed, then written: `flush` turns the queue into lines and `drain`
      // runs the phased writes those lines scheduled.
      built.flush();
      drain();

      return Array.from(document.querySelectorAll('[aria-live]'))
        .map((live) => live.textContent ?? '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    },
    clear: (): void => {
      built.flush();
      drain();

      for (const live of document.querySelectorAll('[aria-live]')) {
        live.textContent = '';
      }
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
  turn: 1,
  degraded: false,
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
  turn: 1,
  moved,
  board: new Grid(4),
  score,
  over: false,
  won: false,
  terminated: false,
});

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
    // engine will actually resolve in.
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

describe('merges and spawns reach the region', () => {
  it('announces a merge with the value it produced', () => {
    const harness = setup();

    harness.events.emit('tile:merge', {
      turn: 1,
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
      turn: 1,
      source: new Tile({ x: 0, y: 0 }, 4),
      target: new Tile({ x: 1, y: 0 }, 4),
      resultValue: 8,
      scoreDelta: 8,
    });
    harness.events.emit('tile:merge', {
      turn: 1,
      source: new Tile({ x: 0, y: 1 }, 8),
      target: new Tile({ x: 1, y: 1 }, 8),
      resultValue: 16,
      scoreDelta: 16,
    });
    harness.events.emit('move:after', moveAfter(true, 24));

    const text = harness.read();

    // `tile:merge` is emitted once per merge, so a listener counting emissions
    // counts merges.
    expect(text).toContain('2');
    expect(text).toContain('24');
  });

  it('announces a spawn with its cell', () => {
    const harness = setup();

    harness.events.emit('tile:spawn', {
      turn: 1,
      position: { x: 2, y: 1 },
      value: 4,
    });

    const text = harness.read();

    expect(text).toContain('4');

    // One-based in prose, zero-based in the payload.
    expect(text).toContain('3');
    expect(text).toContain('2');
  });

  it('states no cell for a spawn that resolved without one', () => {
    const harness = setup();

    harness.events.emit('tile:spawn', { turn: 1, value: 2 });

    expect(() => harness.read()).not.toThrow();
    expect(harness.read()).not.toContain('undefined');
  });
});

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

    // Every commit carries the terminal flags.
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

describe('an unestablished status reaches the region', () => {
  it('announces the transition into it, and not again', () => {
    const harness = setup();

    harness.events.emit('state:commit', commit(16));

    const settled = harness.read();

    harness.events.emit('state:commit', {
      ...commit(20),
      degraded: true,
    });

    const spoken = harness.read();

    // The flag is spoken. Before this the announcer read only the three
    // ordinary terminal flags, so a commit whose status the engine could not
    // establish sounded exactly like one it could.
    expect(spoken).not.toBe(settled);
    expect(spoken.toLowerCase()).toContain('unconfirmed');

    // Every commit carries the flag, so the state is announced on its
    // transitions alone.
    harness.events.emit('state:commit', {
      ...commit(24),
      degraded: true,
    });

    expect(harness.read()).toBe(spoken);
  });

  it('announces the recovery when a measurement succeeds again', () => {
    const harness = setup();

    harness.events.emit('state:commit', { ...commit(16), degraded: true });
    harness.read();
    harness.events.emit('state:commit', commit(20));

    expect(harness.read().toLowerCase()).toContain('confirmed again');
  });
});

/* ==========================================================================
 * A SUBSCRIPTION GROUP THAT CANNOT BE COMPLETED
 *
 * A refusal from any of the six `on()` calls rolls back the registrations taken
 * before it, so nothing stays attached and the announcer reports the
 * subscription as not held. Were a half-built group discarded instead, every
 * listener before the refusal would remain attached to the emitter with no
 * reference to it anywhere — announcing for a subscription reported as not
 * held, and unreachable by `destroy()` or the returned release. DL-ANNOUNCE-03.
 * ========================================================================== */

/** The six names `EngineAnnouncer.subscribe()` registers, in order. */
const ANNOUNCED_EVENT_NAMES: readonly string[] = Object.freeze([
  'move:before',
  'tile:merge',
  'tile:spawn',
  'move:after',
  'stage:end',
  'state:commit',
]);

/**
 * An emitter that refuses the `ordinal`-th registration.
 *
 * @param inner The real emitter every admitted registration reaches.
 * @param ordinal Zero-based index of the registration that raises.
 * @returns The wrapper, and a reader over what stays attached.
 */
const refusingEmitter = (
  inner: EngineEvents,
  ordinal: number,
): {
  readonly events: EngineEvents;
  readonly attached: () => readonly string[];
  readonly admit: () => void;
} => {
  const held: string[] = [];
  let refuse = true;
  let seen = 0;

  const events = {
    ...inner,
    on: ((name: string, listener: never): (() => void) => {
      const index = seen;

      seen += 1;

      if (refuse && index === ordinal) {
        throw new Error(`the emitter refused ${name}`);
      }

      const release = (
        inner.on as unknown as (
          eventName: string,
          handler: never,
        ) => () => void
      )(name, listener);

      held.push(name);

      return (): void => {
        const at = held.indexOf(name);

        if (at >= 0) {
          held.splice(at, 1);
        }

        release();
      };
    }) as EngineEvents['on'],
  } as EngineEvents;

  return {
    events,
    attached: (): readonly string[] => [...held],
    admit: (): void => {
      refuse = false;
      seen = 0;
    },
  };
};

describe('a subscription group that cannot be completed', () => {
  for (
    let ordinal = 0;
    ordinal < ANNOUNCED_EVENT_NAMES.length;
    ordinal += 1
  ) {
    const failing = ANNOUNCED_EVENT_NAMES[ordinal] ?? '';

    it(`rolls back the listeners taken before ${failing}`, () => {
      const harness = setup({ subscribe: false });
      const source = refusingEmitter(harness.events, ordinal);

      expect(() => harness.translator.subscribe(source.events)).toThrow(
        /refused/,
      );

      // NOTHING IS LEFT ATTACHED, so the emitter is exactly as it was.
      expect(source.attached()).toEqual([]);

      // AND NOTHING IS ANNOUNCED for the half-subscription.
      source.events.emit('tile:spawn', {
        turn: 1,
        position: { x: 0, y: 0 },
        value: 2,
      });
      source.events.emit('state:commit', commit(4));

      expect(harness.read()).toBe('');
    });
  }

  it('subscribes cleanly on a retry once the emitter admits', () => {
    const harness = setup({ subscribe: false });
    const source = refusingEmitter(harness.events, 2);

    expect(() => harness.translator.subscribe(source.events)).toThrow(
      /refused/,
    );
    expect(source.attached()).toEqual([]);

    source.admit();

    const release = harness.translator.subscribe(source.events);

    expect(source.attached()).toEqual(ANNOUNCED_EVENT_NAMES);

    source.events.emit('tile:spawn', {
      turn: 1,
      position: { x: 0, y: 0 },
      value: 2,
    });

    expect(harness.read()).not.toBe('');

    release();

    expect(source.attached()).toEqual([]);
  });

  it('releases every listener even where one release refuses', () => {
    const harness = setup({ subscribe: false });
    const inner = harness.events;
    let refusals = 0;
    const events = {
      ...inner,
      on: ((name: string, listener: never): (() => void) => {
        const release = (
          inner.on as unknown as (
            eventName: string,
            handler: never,
          ) => () => void
        )(name, listener);

        if (name !== 'tile:spawn') {
          return release;
        }

        return (): void => {
          refusals += 1;
          release();

          throw new Error('this release refuses');
        };
      }) as EngineEvents['on'],
    } as EngineEvents;

    const release = harness.translator.subscribe(events);

    harness.clear();

    expect(() => {
      release();
    }).toThrow(/refuses/);
    expect(refusals).toBe(1);

    // Every listener came off despite the refusal, so nothing is announced.
    events.emit('tile:merge', {
      turn: 1,
      source: new Tile({ x: 0, y: 0 }, 2),
      target: new Tile({ x: 0, y: 1 }, 2),
      resultValue: 4,
      scoreDelta: 4,
    });
    events.emit('state:commit', commit(4));

    expect(harness.read()).toBe('');

    // And `destroy()` does not call the released listeners a second time.
    harness.translator.destroy();

    expect(refusals).toBe(1);
  });
});

describe('the translator lifecycle', () => {
  it('stops announcing once its SOLE subscription is released', () => {
    // The subscription released here is the SOLE one, the harness having made
    // none: releasing a second while this one stayed attached would assert
    // that something WAS announced, proving the opposite of this case's name
    // and passing for a release that detached nothing at all.
    const harness = setup({ subscribe: false });
    const release = harness.translator.subscribe(harness.events);

    // Announcing works while it is attached, so the silence below is a release
    // and not a broken fixture.
    harness.events.emit('tile:spawn', {
      turn: 1,
      position: { x: 0, y: 0 },
      value: 2,
    });

    expect(harness.read()).not.toBe('');

    harness.clear();
    release();

    harness.events.emit('tile:spawn', {
      turn: 2,
      position: { x: 1, y: 1 },
      value: 4,
    });
    harness.events.emit('tile:merge', {
      turn: 2,
      source: new Tile({ x: 0, y: 0 }, 2),
      target: new Tile({ x: 0, y: 1 }, 2),
      resultValue: 4,
      scoreDelta: 4,
    });
    harness.events.emit('state:commit', commit(4));

    expect(harness.read()).toBe('');
  });

  it('releases only its own subscription, leaving another attached', () => {
    // The pair to the case above: two subscriptions, one released.
    const harness = setup({ subscribe: false });
    const first = harness.translator.subscribe(harness.events);

    harness.translator.subscribe(harness.events);
    harness.clear();
    first();

    harness.events.emit('tile:spawn', {
      turn: 1,
      position: { x: 0, y: 0 },
      value: 2,
    });

    expect(harness.read()).not.toBe('');
  });

  it('announces nothing after destroy, and does not throw', () => {
    const harness = setup();

    harness.translator.destroy();

    expect(() => {
      harness.events.emit('tile:spawn', {
      turn: 1,
      position: { x: 0, y: 0 },
      value: 2,
    });
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
