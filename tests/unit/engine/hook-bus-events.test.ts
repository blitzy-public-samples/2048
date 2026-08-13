// Contract suite for the hook bus's SHARED ENGINE-EVENT CHANNEL, AAP R2.
//
// ONE CHANNEL, NOT TWO AAP Figure 2 and Figure 3 declare a single channel: the
// engine's emitter fans out to the hook bus, and relics, renderer, UI and
// observability are peers on it. Were the six hooks dispatched to relics alone,
// every non-relic peer — the renderer, the HUD, the announcer, the sound
// engine, the screen router and the engine-event metrics — would subscribe to
// the emitter directly and sit on a second, parallel channel.
//
// WHAT THIS SUITE PINS
//   That `attachEvents` relays all seven names, that a payload crosses the relay
//   by reference and unwrapped, that a throwing peer is contained and reported
//   while its siblings still receive the event, that the relay counts no second
//   emission, that a repeated attach registers no second listener set, and that
//   the returned handle removes exactly the listeners its own call registered.
//
// Nothing here reads a document, a clock, `Math.random` or a timer.

import { describe, expect, it } from 'vitest';

import { ENGINE_EVENT_NAMES, createEngineEvents } from '../../../src/engine/engine-events';
import type {
  EngineEventName,
  MoveAfterEvent,
  StateCommitEvent,
} from '../../../src/engine/engine-events';
import { createHookBus } from '../../../src/engine/hook-bus';
import { Grid } from '../../../src/engine/grid';
import {
  EMPTY_RELIC_CONTEXT,
  EMPTY_STAGE_CONTEXT,
} from '../../../src/engine/types';
import type {
  EngineCountReport,
  EngineListenerErrorReport,
  EngineReporter,
} from '../../../src/engine/types';

/** A commit payload carrying a live board, as the engine emits one. */
function createCommit(score: number): StateCommitEvent {
  return {
    turn: 1,
    board: new Grid(4),
    score,
    bestScore: 0,
    over: false,
    won: false,
    terminated: false,
    degraded: false,
    stage: EMPTY_STAGE_CONTEXT,
    relics: EMPTY_RELIC_CONTEXT,
  } as StateCommitEvent;
}

/** A reporter that records the two channels the relay writes to. */
function createRecordingReporter(): {
  readonly reporter: EngineReporter;
  readonly counts: EngineCountReport[];
  readonly listenerErrors: EngineListenerErrorReport[];
} {
  const counts: EngineCountReport[] = [];
  const listenerErrors: EngineListenerErrorReport[] = [];

  return {
    counts,
    listenerErrors,
    reporter: {
      onCount: (report): void => {
        counts.push(report);
      },
      onListenerError: (report): void => {
        listenerErrors.push(report);
      },
    },
  };
}

describe('the shared engine-event channel', () => {
  it('exposes a channel that emits nothing before a source is attached', () => {
    const bus = createHookBus();
    const seen: EngineEventName[] = [];

    for (const name of ENGINE_EVENT_NAMES) {
      bus.events.on(name, (): void => {
        seen.push(name);
      });
    }

    expect(seen).toEqual([]);
  });

  it('relays every one of the seven names', () => {
    const bus = createHookBus();
    const source = createEngineEvents();
    const seen: EngineEventName[] = [];

    for (const name of ENGINE_EVENT_NAMES) {
      bus.events.on(name, (): void => {
        seen.push(name);
      });
    }

    bus.attachEvents(source);

    for (const name of ENGINE_EVENT_NAMES) {
      // The payload shape differs per name and the relay reads none of it, so
      // one placeholder serves for all seven.
      source.emit(name, createCommit(0) as never);
    }

    expect(seen).toEqual([...ENGINE_EVENT_NAMES]);
  });

  it('hands the peer the very object the source emitted', () => {
    const bus = createHookBus();
    const source = createEngineEvents();

    bus.attachEvents(source);

    const received: StateCommitEvent[] = [];

    bus.events.on('state:commit', (commit): void => {
      received.push(commit);
    });

    const emitted = createCommit(312);

    source.emit('state:commit', emitted);

    // BY REFERENCE and unwrapped: the live grid a renderer reconciles from is
    // the grid the engine committed, not a copy of it.
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(emitted);
    expect(received[0]?.board).toBe(emitted.board);
  });

  it('delivers to peers in registration order', () => {
    const bus = createHookBus();
    const source = createEngineEvents();
    const order: string[] = [];

    bus.attachEvents(source);
    bus.events.on('state:commit', (): void => {
      order.push('renderer');
    });
    bus.events.on('state:commit', (): void => {
      order.push('hud');
    });
    bus.events.on('state:commit', (): void => {
      order.push('router');
    });

    source.emit('state:commit', createCommit(0));

    expect(order).toEqual(['renderer', 'hud', 'router']);
  });

  it('contains a throwing peer, reports it, and delivers to the rest', () => {
    const recording = createRecordingReporter();
    const bus = createHookBus({ reporter: recording.reporter });
    const source = createEngineEvents();
    const reached: string[] = [];

    bus.attachEvents(source);
    bus.events.on('move:after', (): void => {
      reached.push('first');
    });
    bus.events.on('move:after', (): void => {
      throw new Error('peer failed');
    });
    bus.events.on('move:after', (): void => {
      reached.push('third');
    });

    expect(() => {
      source.emit('move:after', createCommit(0) as unknown as MoveAfterEvent);
    }).not.toThrow();

    expect(reached).toEqual(['first', 'third']);
    expect(recording.listenerErrors).toHaveLength(1);
    expect(recording.listenerErrors[0]?.event).toBe('move:after');
  });

  it('counts the attach and no second emission per relayed event', () => {
    const recording = createRecordingReporter();
    const bus = createHookBus({ reporter: recording.reporter });
    const source = createEngineEvents();

    bus.attachEvents(source);

    const attached = recording.counts.filter(
      (report) => report.metric === 'engine.hook.events.attached',
    );

    expect(attached).toHaveLength(1);
    expect(attached[0]?.value).toBe(ENGINE_EVENT_NAMES.length);

    recording.counts.length = 0;
    source.emit('state:commit', createCommit(0));

    // The emitting emitter counts its own emission; the relay adds none, so the
    // engine's emission counters cannot be doubled by the fan-out.
    expect(recording.counts).toEqual([]);
  });

  it('registers no second listener set for a source already relayed', () => {
    const bus = createHookBus();
    const source = createEngineEvents();
    let received = 0;

    bus.events.on('tile:spawn', (): void => {
      received += 1;
    });

    const first = bus.attachEvents(source);
    const second = bus.attachEvents(source);

    source.emit('tile:spawn', createCommit(0) as never);

    expect(received).toBe(1);

    // The second handle removes nothing, so the relay the first call registered
    // is still in place.
    second();
    source.emit('tile:spawn', createCommit(0) as never);

    expect(received).toBe(2);

    first();
    source.emit('tile:spawn', createCommit(0) as never);

    expect(received).toBe(2);
  });

  it('relays a second, independent source', () => {
    const bus = createHookBus();
    const first = createEngineEvents();
    const second = createEngineEvents();
    let received = 0;

    bus.events.on('stage:start', (): void => {
      received += 1;
    });

    const stopFirst = bus.attachEvents(first);

    bus.attachEvents(second);

    first.emit('stage:start', createCommit(0) as never);
    second.emit('stage:start', createCommit(0) as never);

    expect(received).toBe(2);

    stopFirst();
    first.emit('stage:start', createCommit(0) as never);
    second.emit('stage:start', createCommit(0) as never);

    // Only the emitter whose handle was called stops arriving.
    expect(received).toBe(3);
  });

  it('registers no listener at all when a source refuses one part-way, and ' +
    'relays it in full on a retry', () => {
    // A part-way attach must leave no listener registered without a handle to
    // release it, and must leave the source unmarked, so the relay stays both
    // releasable and attachable.
    const source = createEngineEvents();
    const registered: EngineEventName[] = [];
    const released: EngineEventName[] = [];
    let refuseFrom: number | null = 2;

    // A source whose `on` refuses the third registration, and answers normally
    // once `refuseFrom` is cleared.
    const faulting = {
      ...source,
      on: <K extends EngineEventName>(
        name: K,
        listener: Parameters<typeof source.on<K>>[1],
      ): (() => void) => {
        if (refuseFrom !== null && registered.length >= refuseFrom) {
          throw new Error(`the source refuses "${name}"`);
        }

        registered.push(name);

        const release = source.on(name, listener);

        return (): void => {
          released.push(name);
          release();
        };
      },
    } as unknown as typeof source;

    const bus = createHookBus();
    let received = 0;

    bus.events.on('state:commit', (): void => {
      received += 1;
    });

    expect(() => bus.attachEvents(faulting)).toThrow(/refuses/u);

    // Every listener taken before the throw was released, in the order taken,
    // and the source is relaying nothing.
    expect(released).toEqual(registered.slice(0, 2));

    source.emit('state:commit', createCommit(0));

    expect(received).toBe(0);

    // The marker was rolled back with the listeners, so a retry registers the
    // whole set rather than handing back an already-relayed no-op.
    refuseFrom = null;
    registered.length = 0;
    released.length = 0;

    const stop = bus.attachEvents(faulting);

    expect(registered).toEqual([...ENGINE_EVENT_NAMES]);

    source.emit('state:commit', createCommit(0));

    expect(received).toBe(1);

    stop();
    source.emit('state:commit', createCommit(0));

    expect(received).toBe(1);
  });

  it('is idempotent on a handle called more than once', () => {
    const bus = createHookBus();
    const source = createEngineEvents();
    let received = 0;

    bus.events.on('state:commit', (): void => {
      received += 1;
    });

    const stop = bus.attachEvents(source);

    stop();
    stop();

    source.emit('state:commit', createCommit(0));

    expect(received).toBe(0);

    // A source released this way can be relayed again.
    bus.attachEvents(source);
    source.emit('state:commit', createCommit(0));

    expect(received).toBe(1);
  });
});
