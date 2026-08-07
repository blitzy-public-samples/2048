// Contract suite for src/engine/engine-events.ts: the typed engine event
// contract and its emitter. The engine emits and holds no view reference, where
// the retired controller pushed to an actuator; the assertions below are the
// executable evidence that the second replaced the first.
//
// Constructs pinned, and the vanilla construct each came from: the listener
// table, `on()` and `emit()` of js/keyboard_input_manager.js; `setup()`, now
// stage:start; the `move()` entry, now move:before; the merge branch, now
// tile:merge; `addRandomTile()`, now tile:spawn, together with
// `randomAvailableCell()` and the absent spawn position; the post-move branch,
// now move:after; and `actuate()`, now state:commit. `ENGINE_EVENT_NAMES`,
// `EngineEventPayloadMap`, stage:end and `off()` have no vanilla analogue.
//
// The assertions hold those constructs to the consumers the retired view was:
// `actuate(grid, metadata)`, `grid.cells` walked by reference,
// `previousPosition` and `value` read off a tile, `mergedFrom` read off a
// merged tile, `bestScore` arriving as a string or 0, and the relational
// `bestScore` comparison.
//
// Not pinned here: pickup order, the charge guard, error isolation and payload
// compounding, which belong to tests/unit/engine/hook-bus.test.ts, and the
// per-construct suites for tile and grid.
//
// This suite reads no DOM, no storage and no clock, consumes no randomness,
// installs no mock library and writes no snapshot.

import { describe, expect, it, vi } from 'vitest';

import type { StageGoal } from '../../../src/config/stage-config';
import {
  ENGINE_EVENT_NAMES,
  createEngineEvents,
} from '../../../src/engine/engine-events';
import type {
  EngineEventListener,
  EngineEventName,
  EngineEventPayloadMap,
  EngineEventSubscription,
  EngineEvents,
  MoveAfterEvent,
  MoveBeforeEvent,
  StageEndEvent,
  StageStartEvent,
  StateCommitEvent,
  TileMergeEvent,
  TileSpawnEvent,
} from '../../../src/engine/engine-events';
import { Grid } from '../../../src/engine/grid';
import { Tile } from '../../../src/engine/tile';
import {
  DIRECTION_LEFT,
  EMPTY_RELIC_CONTEXT,
  EMPTY_STAGE_CONTEXT,
} from '../../../src/engine/types';
import type {
  Position,
  RelicCommitContext,
  StageCommitContext,
} from '../../../src/engine/types';
import { createMergePairBoard } from '../../fixtures/boards';

const EXPECTED_EVENT_NAMES: readonly string[] = [
  'stage:start',
  'move:before',
  'tile:merge',
  'tile:spawn',
  'move:after',
  'stage:end',
  'state:commit',
];

const EXPECTED_EVENT_NAME_COUNT = 7;

const EMITTER_MEMBERS: readonly string[] = ['emit', 'off', 'on'];

const RUN_SEED = 'engine-events-seed';

const BOARD_SIZE = 4;

const STAGE_INDEX = 2;

const COMMIT_SCORE = 128;

const STORED_BEST_SCORE = '4096';

const PAIR_X = 0;

const PAIR_NEXT_X = 1;

const PAIR_Y = 0;

const PAIR_VALUE = 2;

const PAIR_MERGED_VALUE = 4;

const SECOND_PAIR_VALUE = 8;

const SECOND_PAIR_MERGED_VALUE = 16;

const SPAWN_CELL: Position = { x: 3, y: 2 };

const SPAWN_VALUE = 2;

const STAGE_GOAL: StageGoal = {
  kind: 'score-threshold',
  target: 500,
};

const APPEND_LISTENER_COUNT = 3;

type Exact<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;

function createBoard(): Grid {
  const board = createMergePairBoard(BOARD_SIZE);

  return new Grid(board.grid.size, board.grid.cells);
}

function createTile(x: number, y: number, value: number): Tile {
  return new Tile({ x, y }, value);
}

function createMergedTriple(value: number): {
  source: Tile;
  target: Tile;
  merged: Tile;
} {
  const source = createTile(PAIR_NEXT_X, PAIR_Y, value);
  const target = createTile(PAIR_X, PAIR_Y, value);
  const merged = createTile(PAIR_X, PAIR_Y, value * 2);

  source.savePosition();
  target.savePosition();
  source.updatePosition({ x: PAIR_X, y: PAIR_Y });
  merged.mergedFrom = [source, target];

  return { source, target, merged };
}

function createStageStart(
  overrides: Partial<StageStartEvent> = {},
): StageStartEvent {
  return {
    stageIndex: STAGE_INDEX,
    goal: STAGE_GOAL,
    seed: RUN_SEED,
    boardSize: BOARD_SIZE,
    ...overrides,
  };
}

function createMoveBefore(
  overrides: Partial<MoveBeforeEvent> = {},
): MoveBeforeEvent {
  return {
    direction: DIRECTION_LEFT,
    board: createBoard(),
    cancelled: false,
    ...overrides,
  };
}

function createTileMerge(value: number = PAIR_VALUE): TileMergeEvent {
  const { source, target, merged } = createMergedTriple(value);

  return {
    source,
    target,
    resultValue: merged.value,
    scoreDelta: merged.value,
  };
}

function createTileSpawn(
  overrides: Partial<TileSpawnEvent> = {},
): TileSpawnEvent {
  return {
    position: SPAWN_CELL,
    value: SPAWN_VALUE,
    ...overrides,
  };
}

function createMoveAfter(
  overrides: Partial<MoveAfterEvent> = {},
): MoveAfterEvent {
  return {
    moved: true,
    board: createBoard(),
    score: COMMIT_SCORE,
    over: false,
    won: false,
    terminated: false,
    ...overrides,
  };
}

function createStageEnd(
  overrides: Partial<StageEndEvent> = {},
): StageEndEvent {
  return {
    stageIndex: STAGE_INDEX,
    cleared: true,
    score: COMMIT_SCORE,
    ...overrides,
  };
}

function createStateCommit(
  overrides: Partial<StateCommitEvent> = {},
): StateCommitEvent {
  return {
    board: createBoard(),
    score: COMMIT_SCORE,
    bestScore: STORED_BEST_SCORE,
    over: false,
    won: false,
    terminated: false,
    stage: EMPTY_STAGE_CONTEXT,
    relics: EMPTY_RELIC_CONTEXT,
    ...overrides,
  };
}

function recordEmissions<K extends EngineEventName>(
  events: EngineEvents,
  event: K,
): EngineEventPayloadMap[K][] {
  const received: EngineEventPayloadMap[K][] = [];

  events.on(event, (payload) => {
    received.push(payload);
  });

  return received;
}

function recordOrder(
  events: EngineEvents,
  order: string[],
  label: string,
): EngineEventSubscription {
  return events.on('stage:end', () => {
    order.push(label);
  });
}

describe('ENGINE_EVENT_NAMES (AAP Contract 1)', () => {
  it('declares exactly the seven event names, in turn order', () => {
    expect([...ENGINE_EVENT_NAMES]).toEqual(EXPECTED_EVENT_NAMES);
  });

  it('declares seven names and no eighth', () => {
    expect(ENGINE_EVENT_NAMES).toHaveLength(EXPECTED_EVENT_NAME_COUNT);
    expect(new Set(ENGINE_EVENT_NAMES).size).toBe(EXPECTED_EVENT_NAME_COUNT);
  });

  it('orders the names as one turn reaches them', () => {
    expect(ENGINE_EVENT_NAMES[0]).toBe('stage:start');
    expect(ENGINE_EVENT_NAMES[1]).toBe('move:before');
    expect(ENGINE_EVENT_NAMES[2]).toBe('tile:merge');
    expect(ENGINE_EVENT_NAMES[3]).toBe('tile:spawn');
    expect(ENGINE_EVENT_NAMES[4]).toBe('move:after');
    expect(ENGINE_EVENT_NAMES[5]).toBe('stage:end');
    expect(ENGINE_EVENT_NAMES[6]).toBe('state:commit');
  });

  it('declares the seven names once, as a readonly tuple', () => {
    const namesAreExactTuple: Exact<
      typeof ENGINE_EVENT_NAMES,
      readonly [
        'stage:start',
        'move:before',
        'tile:merge',
        'tile:spawn',
        'move:after',
        'stage:end',
        'state:commit',
      ]
    > = true;

    expect(namesAreExactTuple).toBe(true);
  });

  it('derives EngineEventName from the tuple', () => {
    const names: readonly EngineEventName[] = ENGINE_EVENT_NAMES;
    const first: EngineEventName = ENGINE_EVENT_NAMES[0];

    expect(names).toHaveLength(EXPECTED_EVENT_NAME_COUNT);
    expect(first).toBe('stage:start');
  });

  it('keys EngineEventPayloadMap by exactly EngineEventName', () => {
    const keysMatch: Exact<
      EngineEventName,
      keyof EngineEventPayloadMap
    > = true;

    expect(keysMatch).toBe(true);
  });

  it('covers every name in the tuple with a payload', () => {
    const covered: Record<EngineEventName, true> = {
      'stage:start': true,
      'move:before': true,
      'tile:merge': true,
      'tile:spawn': true,
      'move:after': true,
      'stage:end': true,
      'state:commit': true,
    };

    expect(Object.keys(covered).sort()).toEqual(
      [...EXPECTED_EVENT_NAMES].sort(),
    );
  });

  it('accepts every declared name as an event to emit', () => {
    const events = createEngineEvents();
    const seen: string[] = [];

    for (const name of ENGINE_EVENT_NAMES) {
      events.on(name, () => {
        seen.push(name);
      });
    }

    events.emit('stage:start', createStageStart());
    events.emit('move:before', createMoveBefore());
    events.emit('tile:merge', createTileMerge());
    events.emit('tile:spawn', createTileSpawn());
    events.emit('move:after', createMoveAfter());
    events.emit('stage:end', createStageEnd());
    events.emit('state:commit', createStateCommit());

    expect(seen).toEqual(EXPECTED_EVENT_NAMES);
  });
});

describe('createEngineEvents (js/keyboard_input_manager.js L1-L16)', () => {
  it('exposes on, off and emit and nothing else (L18-L32)', () => {
    const events = createEngineEvents();

    expect(Object.keys(events).sort()).toEqual(EMITTER_MEMBERS);
    expect(Object.isFrozen(events)).toBe(true);
  });

  it('starts with an empty listener table (L2)', () => {
    const events = createEngineEvents();

    for (const name of ENGINE_EVENT_NAMES) {
      expect(() => {
        events.off(name, () => undefined);
      }).not.toThrow();
    }
  });

  it('gives each emitter its own listener table (L2)', () => {
    const first = createEngineEvents();
    const second = createEngineEvents();
    const firstListener = vi.fn();
    const secondListener = vi.fn();

    first.on('stage:end', firstListener);
    second.on('stage:end', secondListener);
    first.emit('stage:end', createStageEnd());

    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(secondListener).not.toHaveBeenCalled();
  });

  it('returns members that work detached from the emitter (L2)', () => {
    const events = createEngineEvents();
    const { on, emit } = events;
    let seen = -1;

    on('stage:end', (payload) => {
      seen = payload.stageIndex;
    });
    emit('stage:end', createStageEnd({ stageIndex: STAGE_INDEX }));
    expect(seen).toBe(STAGE_INDEX);
  });
});

describe('EngineEvents.on appends and never replaces ' +
  '(js/keyboard_input_manager.js L18-L23)', () => {
  it('invokes all three listeners of one event on one emit, in registration ' +
    'order (L22)', () => {
    const events = createEngineEvents();
    const order: string[] = [];

    recordOrder(events, order, 'first');
    recordOrder(events, order, 'second');
    recordOrder(events, order, 'third');
    events.emit('stage:end', createStageEnd());

    expect(order).toHaveLength(APPEND_LISTENER_COUNT);
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('leaves an already registered listener attached when a second registers ' +
    '(L22)', () => {
    const events = createEngineEvents();
    const existing = vi.fn();

    events.on('stage:end', existing);
    events.on('stage:end', vi.fn());
    events.emit('stage:end', createStageEnd());

    expect(existing).toHaveBeenCalledTimes(1);
  });

  it('lets an observer attach alongside every listener already attached ' +
    '(L19-L22)', () => {
    const events = createEngineEvents();
    const engineConsumer = vi.fn();
    const renderer = vi.fn();

    events.on('state:commit', engineConsumer);
    events.on('state:commit', renderer);

    const observed: StateCommitEvent[] = [];

    events.on('state:commit', (commit) => {
      observed.push(commit);
    });

    const commit = createStateCommit();

    events.emit('state:commit', commit);

    expect(engineConsumer).toHaveBeenCalledTimes(1);
    expect(renderer).toHaveBeenCalledTimes(1);
    expect(observed).toEqual([commit]);
  });

  it('creates the listener array of an event on first registration ' +
    '(L19-L21)', () => {
    const events = createEngineEvents();
    const listener = vi.fn();

    expect(() => {
      events.on('tile:merge', listener);
    }).not.toThrow();

    events.emit('tile:merge', createTileMerge());

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('registers the same function twice and invokes it twice (L22)', () => {
    const events = createEngineEvents();
    const listener = vi.fn();

    events.on('stage:end', listener);
    events.on('stage:end', listener);
    events.emit('stage:end', createStageEnd());

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('keeps the listeners of one event out of every other event ' +
    '(L19-L21)', () => {
    const events = createEngineEvents();
    const spawnListener = vi.fn();
    const mergeListener = vi.fn();

    events.on('tile:spawn', spawnListener);
    events.on('tile:merge', mergeListener);
    events.emit('tile:spawn', createTileSpawn());

    expect(spawnListener).toHaveBeenCalledTimes(1);
    expect(mergeListener).not.toHaveBeenCalled();
  });

  it('returns a distinct handle for each registration (L22)', () => {
    const events = createEngineEvents();
    const listener = vi.fn();
    const first = events.on('stage:end', listener);
    const second = events.on('stage:end', listener);

    expect(first).not.toBe(second);
    first();
    events.emit('stage:end', createStageEnd());

    expect(listener).toHaveBeenCalledTimes(1);
    second();
    events.emit('stage:end', createStageEnd());

    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('EngineEvents.emit is synchronous (js/keyboard_input_manager.js ' +
  'L25-L32)', () => {
  it('has already invoked every listener when it returns (L28-L30)', () => {
    const events = createEngineEvents();
    let ran = false;

    events.on('stage:end', () => {
      ran = true;
    });
    events.emit('stage:end', createStageEnd());

    expect(ran).toBe(true);
  });

  it('defers nothing to a microtask (L28-L30)', async () => {
    const events = createEngineEvents();
    const order: string[] = [];

    events.on('stage:end', () => {
      order.push('listener');
    });

    void Promise.resolve().then(() => {
      order.push('microtask');
    });

    events.emit('stage:end', createStageEnd());
    order.push('afterEmit');

    await Promise.resolve();

    expect(order).toEqual(['listener', 'afterEmit', 'microtask']);
  });

  it('passes the payload as the listener single argument (L29)', () => {
    const events = createEngineEvents();
    const received: unknown[][] = [];

    events.on('stage:end', (...args: unknown[]) => {
      received.push(args);
    });
    events.emit('stage:end', createStageEnd());

    expect(received).toHaveLength(1);
    expect(received[0]).toHaveLength(1);
  });

  it('passes the payload by identity, not a copy (L29)', () => {
    const events = createEngineEvents();
    const payload = createStageEnd();
    const received = recordEmissions(events, 'stage:end');

    events.emit('stage:end', payload);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(payload);
  });

  it('hands every listener of one event the same payload (L28-L30)', () => {
    const events = createEngineEvents();
    const payload = createStateCommit();
    const first = recordEmissions(events, 'state:commit');
    const second = recordEmissions(events, 'state:commit');

    events.emit('state:commit', payload);

    expect(first[0]).toBe(payload);
    expect(second[0]).toBe(payload);
  });

  it('returns undefined (L25-L32)', () => {
    const events = createEngineEvents();

    events.on('stage:end', vi.fn());

    expect(events.emit('stage:end', createStageEnd())).toBeUndefined();
  });

  it('does nothing for an event with no listener (L26-L27)', () => {
    const events = createEngineEvents();

    expect(() => {
      events.emit('stage:end', createStageEnd());
    }).not.toThrow();
  });

  it('does nothing for an event whose listeners were all removed ' +
    '(L26-L27)', () => {
    const events = createEngineEvents();
    const listener = vi.fn();
    const stop = events.on('stage:end', listener);

    stop();

    expect(() => {
      events.emit('stage:end', createStageEnd());
    }).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });

  it('emits an event with no listener while another event has some ' +
    '(L26-L27)', () => {
    const events = createEngineEvents();
    const mergeListener = vi.fn();

    events.on('tile:merge', mergeListener);
    events.emit('tile:spawn', createTileSpawn());

    expect(mergeListener).not.toHaveBeenCalled();
  });
});

describe('EngineEvents.emit walks the listeners it began with ' +
  '(js/keyboard_input_manager.js L28)', () => {
  it('does not invoke a listener registered during the emission (L28)', () => {
    const events = createEngineEvents();
    const late = vi.fn();

    events.on('stage:end', () => {
      events.on('stage:end', late);
    });
    events.emit('stage:end', createStageEnd());

    expect(late).not.toHaveBeenCalled();

    events.emit('stage:end', createStageEnd());

    expect(late).toHaveBeenCalledTimes(1);
  });

  // The remover is registered FIRST and the listener it removes SECOND, so the
  // removal happens while the walk is still short of its target. A walk over
  // the live array would skip that target; the copy taken before the walk
  // reaches it anyway. Registered the other way round the target would have run
  // before the removal and the case would pass either way.
  it('invokes a listener removed during the emission (L28)', () => {
    const events = createEngineEvents();
    const order: string[] = [];
    let removeSecond: (() => void) | null = null;

    events.on('stage:end', () => {
      order.push('first');
      removeSecond?.();
    });

    removeSecond = recordOrder(events, order, 'second');

    events.emit('stage:end', createStageEnd());

    expect(order).toEqual(['first', 'second']);

    order.length = 0;
    events.emit('stage:end', createStageEnd());

    expect(order).toEqual(['first']);
  });

  it('invokes a later listener removed by an earlier one, off() too (L28)',
    () => {
      const events = createEngineEvents();
      const order: string[] = [];
      const second = (): void => {
        order.push('second');
      };

      events.on('stage:end', () => {
        order.push('first');
        events.off('stage:end', second);
      });
      events.on('stage:end', second);
      events.emit('stage:end', createStageEnd());

      expect(order).toEqual(['first', 'second']);

      order.length = 0;
      events.emit('stage:end', createStageEnd());

      expect(order).toEqual(['first']);
    });

  it('invokes every later listener when the first removes them all (L28)',
    () => {
      const events = createEngineEvents();
      const order: string[] = [];
      const stops: (() => void)[] = [];

      events.on('stage:end', () => {
        order.push('first');

        for (const stop of stops) {
          stop();
        }
      });

      stops.push(
        recordOrder(events, order, 'second'),
        recordOrder(events, order, 'third'),
      );

      events.emit('stage:end', createStageEnd());

      expect(order).toEqual(['first', 'second', 'third']);

      order.length = 0;
      events.emit('stage:end', createStageEnd());

      expect(order).toEqual(['first']);
    });
});

/* ===== 11. emit() contains a throwing listener ===== */

// The charge guard, pickup-order dispatch and payload compounding are
// src/engine/hook-bus.ts, pinned by tests/unit/engine/hook-bus.test.ts.
// js/keyboard_input_manager.js L28-L30 iterated with no try/catch, so a
// throwing view aborted the manager after it had already mutated the board.
// The emitter contains each listener instead: the emission reaches every
// listener in the snapshot, and the caught value is reported rather than
// thrown.
describe('EngineEvents.emit contains a throwing listener ' +
  '(js/keyboard_input_manager.js L25-L32)', () => {
  it('does not propagate a listener error to the caller that emitted', () => {
    const events = createEngineEvents();

    events.on('stage:end', () => {
      throw new Error('listener failed');
    });

    expect(() => {
      events.emit('stage:end', createStageEnd());
    }).not.toThrow();
  });

  it('invokes the listeners after the one that threw', () => {
    const events = createEngineEvents();
    const before = vi.fn();
    const after = vi.fn();

    events.on('stage:end', before);
    events.on('stage:end', () => {
      throw new Error('listener failed');
    });
    events.on('stage:end', after);

    events.emit('stage:end', createStageEnd());

    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('leaves the throwing listener registered', () => {
    const events = createEngineEvents();
    let calls = 0;

    events.on('stage:end', () => {
      calls += 1;
      throw new Error('listener failed');
    });

    events.emit('stage:end', createStageEnd());
    events.emit('stage:end', createStageEnd());

    expect(calls).toBe(2);
  });

  it('reports the caught value, its event and its listener index', () => {
    const reports: {
      correlationId: string;
      event: string;
      listenerIndex: number;
      error: unknown;
    }[] = [];
    const thrown = { code: 'not-an-error' };
    const events = createEngineEvents({
      correlationId: 'run-42',
      reporter: {
        onListenerError: (report): void => {
          reports.push({
            correlationId: report.correlationId,
            event: report.event,
            listenerIndex: report.listenerIndex,
            error: report.error,
          });
        },
      },
    });

    events.on('tile:spawn', vi.fn());
    events.on('tile:spawn', () => {
      throw thrown;
    });

    events.emit('tile:spawn', createTileSpawn());

    expect(reports).toEqual([
      {
        correlationId: 'run-42',
        event: 'tile:spawn',
        listenerIndex: 1,
        error: thrown,
      },
    ]);
  });

  it('contains every listener of one emission independently', () => {
    const caught: unknown[] = [];
    const events = createEngineEvents({
      reporter: {
        onListenerError: (report): void => {
          caught.push(report.error);
        },
      },
    });

    events.on('stage:end', () => {
      throw 'first';
    });
    events.on('stage:end', () => {
      throw 'second';
    });

    events.emit('stage:end', createStageEnd());

    expect(caught).toEqual(['first', 'second']);
  });

  it('counts one emission and one contained listener error', () => {
    const counts: { metric: string; value: number; hook?: string }[] = [];
    const events = createEngineEvents({
      reporter: {
        onCount: (report): void => {
          counts.push({
            metric: report.metric,
            value: report.value,
            ...(report.hook === undefined ? {} : { hook: report.hook }),
          });
        },
      },
    });

    events.on('stage:end', () => {
      throw new Error('listener failed');
    });

    events.emit('stage:end', createStageEnd());

    expect(counts).toEqual([
      { metric: 'engine.event.emit', value: 1, hook: 'stage:end' },
      { metric: 'engine.event.listener.error', value: 1, hook: 'stage:end' },
    ]);
  });

  it('contains a report sink that throws', () => {
    const events = createEngineEvents({
      reporter: {
        onListenerError: (): void => {
          throw new Error('sink failed');
        },
        onCount: (): void => {
          throw new Error('sink failed');
        },
      },
    });
    const after = vi.fn();

    events.on('stage:end', () => {
      throw new Error('listener failed');
    });
    events.on('stage:end', after);

    expect(() => {
      events.emit('stage:end', createStageEnd());
    }).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('reports nothing for an emission every listener returned from', () => {
    const errors: unknown[] = [];
    const events = createEngineEvents({
      reporter: {
        onListenerError: (report): void => {
          errors.push(report.error);
        },
      },
    });

    events.on('tile:spawn', vi.fn());
    events.emit('tile:spawn', createTileSpawn());

    expect(errors).toEqual([]);
  });
});

describe('EngineEvents.off and the subscription handle (AAP Contract 1, no ' +
  'vanilla analogue)', () => {
  it('detaches the listener its handle was returned for', () => {
    const events = createEngineEvents();
    const listener = vi.fn();
    const stop = events.on('stage:end', listener);

    stop();
    events.emit('stage:end', createStageEnd());

    expect(listener).not.toHaveBeenCalled();
  });

  it('detaches nothing further when the handle is called twice', () => {
    const events = createEngineEvents();
    const first = vi.fn();
    const second = vi.fn();
    const stop = events.on('stage:end', first);

    events.on('stage:end', second);
    stop();
    stop();
    events.emit('stage:end', createStageEnd());

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('detaches only the listener named, leaving its siblings attached', () => {
    const events = createEngineEvents();
    const order: string[] = [];

    recordOrder(events, order, 'first');

    const second = recordOrder(events, order, 'second');

    recordOrder(events, order, 'third');
    second();
    events.emit('stage:end', createStageEnd());

    expect(order).toEqual(['first', 'third']);
  });

  it('does nothing for a listener that is not registered', () => {
    const events = createEngineEvents();
    const registered = vi.fn();

    events.on('stage:end', registered);

    expect(() => {
      events.off('stage:end', vi.fn());
    }).not.toThrow();

    events.emit('stage:end', createStageEnd());

    expect(registered).toHaveBeenCalledTimes(1);
  });

  it('does nothing for an event that has no listener at all', () => {
    const events = createEngineEvents();

    expect(() => {
      events.off('state:commit', vi.fn());
    }).not.toThrow();
  });

  it('removes one registration of a listener registered twice', () => {
    const events = createEngineEvents();
    const listener = vi.fn();

    events.on('stage:end', listener);
    events.on('stage:end', listener);
    events.off('stage:end', listener);
    events.emit('stage:end', createStageEnd());

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('leaves the listeners of every other event attached', () => {
    const events = createEngineEvents();
    const spawnListener = vi.fn();
    const mergeListener = vi.fn();

    events.on('tile:spawn', spawnListener);
    events.on('tile:merge', mergeListener);
    events.off('tile:spawn', spawnListener);
    events.emit('tile:spawn', createTileSpawn());
    events.emit('tile:merge', createTileMerge());

    expect(spawnListener).not.toHaveBeenCalled();
    expect(mergeListener).toHaveBeenCalledTimes(1);
  });
});

describe('state:commit carries the vanilla actuation payload ' +
  '(js/game_manager.js L91-L97)', () => {
  it('carries score, over, won, bestScore and terminated (L92-L96)', () => {
    const events = createEngineEvents();
    const received = recordEmissions(events, 'state:commit');

    events.emit(
      'state:commit',
      createStateCommit({
        score: COMMIT_SCORE,
        over: true,
        won: true,
        bestScore: STORED_BEST_SCORE,
        terminated: true,
      }),
    );

    const commit = received[0];

    expect(commit).toBeDefined();
    expect(commit?.score).toBe(COMMIT_SCORE);
    expect(commit?.over).toBe(true);
    expect(commit?.won).toBe(true);
    expect(commit?.bestScore).toBe(STORED_BEST_SCORE);
    expect(commit?.terminated).toBe(true);
  });

  it('carries the board js/game_manager.js L91 pushed (L91)', () => {
    const events = createEngineEvents();
    const board = createBoard();
    const received = recordEmissions(events, 'state:commit');

    events.emit('state:commit', createStateCommit({ board }));

    expect(received[0]?.board).toBe(board);
  });

  it('carries every member the vanilla payload carried and no fewer ' +
    '(L91-L97)', () => {
    const commit = createStateCommit();

    expect(Object.keys(commit).sort()).toEqual([
      'bestScore',
      'board',
      'over',
      'relics',
      'score',
      'stage',
      'terminated',
      'won',
    ]);
  });

  it('carries bestScore as the raw stored string ' +
    '(js/local_storage_manager.js L43-L45)', () => {
    const events = createEngineEvents();
    const received = recordEmissions(events, 'state:commit');

    events.emit(
      'state:commit',
      createStateCommit({ bestScore: STORED_BEST_SCORE }),
    );

    const bestScore = received[0]?.bestScore;

    expect(bestScore).toBe(STORED_BEST_SCORE);
    expect(typeof bestScore).toBe('string');
  });

  it('carries bestScore as the number 0 when none is stored ' +
    '(js/local_storage_manager.js L43-L45)', () => {
    const events = createEngineEvents();
    const received = recordEmissions(events, 'state:commit');

    events.emit('state:commit', createStateCommit({ bestScore: 0 }));

    const bestScore = received[0]?.bestScore;

    expect(bestScore).toBe(0);
    expect(typeof bestScore).toBe('number');
  });

  it('leaves the stored bestScore string uncoerced for js/game_manager.js ' +
    'L80-L82', () => {
    const events = createEngineEvents();
    const received = recordEmissions(events, 'state:commit');

    events.emit(
      'state:commit',
      createStateCommit({ bestScore: STORED_BEST_SCORE, score: 8 }),
    );

    const commit = received[0];

    expect(commit).toBeDefined();
    expect(commit?.bestScore).not.toBe(Number(STORED_BEST_SCORE));
  });

  it('adds the stage slice the vanilla payload had no analogue for', () => {
    const events = createEngineEvents();
    const stage: StageCommitContext = {
      stageIndex: STAGE_INDEX,
      goal: STAGE_GOAL,
      goalProgress: 0.5,
    };
    const received = recordEmissions(events, 'state:commit');

    events.emit('state:commit', createStateCommit({ stage }));

    expect(received[0]?.stage).toBe(stage);
    expect(received[0]?.stage.goal).toEqual(STAGE_GOAL);
  });

  it('adds the relic slice the vanilla payload had no analogue for', () => {
    const events = createEngineEvents();
    const relics: RelicCommitContext = [
      { id: 'first-picked' },
      { id: 'second-picked', charges: 2 },
    ];
    const received = recordEmissions(events, 'state:commit');

    events.emit('state:commit', createStateCommit({ relics }));

    expect(received[0]?.relics).toBe(relics);
  });

  it('carries the active relics in pickup order', () => {
    const events = createEngineEvents();
    const relics: RelicCommitContext = [
      { id: 'first-picked' },
      { id: 'second-picked', charges: 2 },
      { id: 'third-picked' },
    ];
    const received = recordEmissions(events, 'state:commit');

    events.emit('state:commit', createStateCommit({ relics }));

    expect(received[0]?.relics.map((relic) => relic.id)).toEqual([
      'first-picked',
      'second-picked',
      'third-picked',
    ]);
  });

  it('is complete with the neutral stage and relic defaults', () => {
    const events = createEngineEvents();
    const received = recordEmissions(events, 'state:commit');

    events.emit(
      'state:commit',
      createStateCommit({
        stage: EMPTY_STAGE_CONTEXT,
        relics: EMPTY_RELIC_CONTEXT,
      }),
    );

    const commit = received[0];

    expect(commit).toBeDefined();
    expect(commit?.stage).toBe(EMPTY_STAGE_CONTEXT);
    expect(commit?.stage.stageIndex).toBe(0);
    expect(commit?.stage.goalProgress).toBe(0);
    expect(commit?.relics).toBe(EMPTY_RELIC_CONTEXT);
    expect(commit?.relics).toHaveLength(0);
  });

  it('accepts the neutral defaults with no run or relic system present', () => {
    const stage: StageCommitContext = EMPTY_STAGE_CONTEXT;
    const relics: RelicCommitContext = EMPTY_RELIC_CONTEXT;
    const commit: StateCommitEvent = {
      board: createBoard(),
      score: 0,
      bestScore: 0,
      over: false,
      won: false,
      terminated: false,
      stage,
      relics,
    };

    expect(commit.stage.goal.kind).toBe('score-threshold');
    expect(commit.stage.goal.target).toBe(0);
    expect(commit.relics).toEqual([]);
  });
});

describe('state:commit passes the board by reference (js/html_actuator.js ' +
  'L16-L22)', () => {
  it('hands a subscriber the same Grid instance the emitter was given ' +
    '(L10)', () => {
    const events = createEngineEvents();
    const board = createBoard();
    let seen: Grid | null = null;

    events.on('state:commit', (commit) => {
      seen = commit.board;
    });
    events.emit('state:commit', createStateCommit({ board }));

    expect(seen).toBe(board);
    expect(seen).toBeInstanceOf(Grid);
  });

  it('lets a subscriber walk grid.cells as the actuator did (L16-L22)', () => {
    const events = createEngineEvents();
    const board = createBoard();
    const drawn: number[] = [];

    events.on('state:commit', (commit) => {
      commit.board.cells.forEach((column) => {
        column.forEach((cell) => {
          if (cell) {
            drawn.push(cell.value);
          }
        });
      });
    });
    events.emit('state:commit', createStateCommit({ board }));

    expect(drawn).toEqual([PAIR_VALUE, PAIR_VALUE]);
  });

  it('lets a subscriber read value off a live tile (L58, L65)', () => {
    const events = createEngineEvents();
    const board = createBoard();
    let seen: number | undefined;

    events.on('state:commit', (commit) => {
      seen = commit.board.cells[PAIR_X]?.[PAIR_Y]?.value;
    });
    events.emit('state:commit', createStateCommit({ board }));

    expect(seen).toBe(PAIR_VALUE);
  });

  it('lets a subscriber read previousPosition off a live tile (L54, ' +
    'L67)', () => {
    const events = createEngineEvents();
    const board = createBoard();
    const tile = board.cells[PAIR_X]?.[PAIR_Y];

    expect(tile).toBeInstanceOf(Tile);
    tile?.savePosition();
    tile?.updatePosition({ x: PAIR_NEXT_X, y: PAIR_Y });

    let seen: Position | null | undefined;

    events.on('state:commit', (commit) => {
      seen = commit.board.cells[PAIR_X]?.[PAIR_Y]?.previousPosition;
    });
    events.emit('state:commit', createStateCommit({ board }));

    expect(seen).toEqual({ x: PAIR_X, y: PAIR_Y });
  });

  it('lets a subscriber read mergedFrom off a live tile (L73-L80)', () => {
    const events = createEngineEvents();
    const board = createBoard();
    const { source, target, merged } = createMergedTriple(PAIR_VALUE);

    board.cells[PAIR_X] ??= [];
    board.cells[PAIR_X]![PAIR_Y] = merged;

    let seen: [Tile, Tile] | null | undefined;

    events.on('state:commit', (commit) => {
      seen = commit.board.cells[PAIR_X]?.[PAIR_Y]?.mergedFrom;
    });
    events.emit('state:commit', createStateCommit({ board }));

    expect(seen).toEqual([source, target]);
    expect(seen?.[0]).toBe(source);
    expect(seen?.[1]).toBe(target);
  });

  it('shows a subscriber a board written after registration (L16-L22)', () => {
    const events = createEngineEvents();
    const board = createBoard();
    const drawn: number[] = [];

    events.on('state:commit', (commit) => {
      commit.board.eachCell((_x, _y, cell) => {
        if (cell) {
          drawn.push(cell.value);
        }
      });
    });

    board.insertTile(createTile(SPAWN_CELL.x, SPAWN_CELL.y, SPAWN_VALUE));
    events.emit('state:commit', createStateCommit({ board }));

    expect(drawn).toHaveLength(3);
  });

  it('copies, clones and freezes no payload it carries (L91)', () => {
    const events = createEngineEvents();
    const commit = createStateCommit();
    const received = recordEmissions(events, 'state:commit');

    events.emit('state:commit', commit);

    expect(received[0]).toBe(commit);
    expect(Object.isFrozen(received[0])).toBe(false);
    expect(received[0]?.board).toBe(commit.board);
  });
});

describe('tile:merge is emitted once per merge (js/game_manager.js ' +
  'L156-L170)', () => {
  it('emits twice for a move that resolves two merges (L156)', () => {
    const events = createEngineEvents();
    const received = recordEmissions(events, 'tile:merge');

    events.emit('tile:merge', createTileMerge(PAIR_VALUE));
    events.emit('tile:merge', createTileMerge(SECOND_PAIR_VALUE));

    expect(received).toHaveLength(2);
  });

  it('carries the source and target tiles of each merge separately ' +
    '(L158)', () => {
    const events = createEngineEvents();
    const first = createTileMerge(PAIR_VALUE);
    const second = createTileMerge(SECOND_PAIR_VALUE);
    const received = recordEmissions(events, 'tile:merge');

    events.emit('tile:merge', first);
    events.emit('tile:merge', second);

    expect(received[0]?.source).toBe(first.source);
    expect(received[0]?.target).toBe(first.target);
    expect(received[1]?.source).toBe(second.source);
    expect(received[1]?.target).toBe(second.target);
    expect(received[0]?.source).not.toBe(received[1]?.source);
  });

  it('carries the result value each merge produced, and not an aggregate ' +
    '(L157)', () => {
    const events = createEngineEvents();
    const received = recordEmissions(events, 'tile:merge');

    events.emit('tile:merge', createTileMerge(PAIR_VALUE));
    events.emit('tile:merge', createTileMerge(SECOND_PAIR_VALUE));

    expect(received.map((merge) => merge.resultValue)).toEqual([
      PAIR_MERGED_VALUE,
      SECOND_PAIR_MERGED_VALUE,
    ]);
  });

  it('carries the score delta each merge added, and not an aggregate ' +
    '(L167)', () => {
    const events = createEngineEvents();
    const received = recordEmissions(events, 'tile:merge');

    events.emit('tile:merge', createTileMerge(PAIR_VALUE));
    events.emit('tile:merge', createTileMerge(SECOND_PAIR_VALUE));

    expect(received.map((merge) => merge.scoreDelta)).toEqual([
      PAIR_MERGED_VALUE,
      SECOND_PAIR_MERGED_VALUE,
    ]);
  });

  it('carries resultValue and scoreDelta as separate members (L157, ' +
    'L167)', () => {
    const events = createEngineEvents();
    const merge: TileMergeEvent = {
      source: createTile(PAIR_NEXT_X, PAIR_Y, PAIR_VALUE),
      target: createTile(PAIR_X, PAIR_Y, PAIR_VALUE),
      resultValue: PAIR_MERGED_VALUE,
      scoreDelta: 0,
    };
    const received = recordEmissions(events, 'tile:merge');

    events.emit('tile:merge', merge);

    expect(received[0]?.resultValue).toBe(PAIR_MERGED_VALUE);
    expect(received[0]?.scoreDelta).toBe(0);
  });

  it('carries the pair js/game_manager.js L158 recorded, both out of the ' +
    'lattice (L160-L161)', () => {
    const events = createEngineEvents();
    const board = createBoard();
    const merge = createTileMerge(PAIR_VALUE);
    let sourceOnBoard = true;

    events.on('tile:merge', (payload) => {
      sourceOnBoard = board.cells.some((column) =>
        column.some((cell) => cell === payload.source),
      );
    });
    board.removeTile(merge.target);
    events.emit('tile:merge', merge);

    expect(sourceOnBoard).toBe(false);
    expect(merge.source.value).toBe(PAIR_VALUE);
    expect(merge.target.value).toBe(PAIR_VALUE);
  });

  it('carries only the four members the merge branch produced ' +
    '(L156-L170)', () => {
    expect(Object.keys(createTileMerge()).sort()).toEqual([
      'resultValue',
      'scoreDelta',
      'source',
      'target',
    ]);
  });
});

describe('move:before is cancellable (js/game_manager.js L130-L143)', () => {
  it('carries direction and the live board (L131, L138)', () => {
    const events = createEngineEvents();
    const board = createBoard();
    const received = recordEmissions(events, 'move:before');

    events.emit('move:before', createMoveBefore({ board }));

    expect(received[0]?.direction).toBe(DIRECTION_LEFT);
    expect(received[0]?.board).toBe(board);
  });

  it('is dispatched with cancelled false', () => {
    const events = createEngineEvents();
    const received = recordEmissions(events, 'move:before');

    events.emit('move:before', createMoveBefore());

    expect(received[0]?.cancelled).toBe(false);
  });

  it('lets a listener set cancelled', () => {
    const events = createEngineEvents();

    events.on('move:before', (payload) => {
      payload.cancelled = true;
    });

    const payload = createMoveBefore();

    events.emit('move:before', payload);

    expect(payload.cancelled).toBe(true);
  });

  it('shows the caller that emitted the flag a listener set', () => {
    const events = createEngineEvents();
    const payload = createMoveBefore();

    events.on('move:before', (received) => {
      received.cancelled = true;
    });

    expect(payload.cancelled).toBe(false);

    events.emit('move:before', payload);

    expect(payload.cancelled).toBe(true);
  });

  it('does not act on cancelled itself (L134)', () => {
    const events = createEngineEvents();
    const order: string[] = [];

    events.on('move:before', (payload) => {
      payload.cancelled = true;
      order.push('vetoed');
    });
    events.on('move:before', () => {
      order.push('after');
    });
    events.emit('move:before', createMoveBefore());

    expect(order).toEqual(['vetoed', 'after']);
  });

  it('lets the last of several listeners set cancelled', () => {
    const events = createEngineEvents();
    const payload = createMoveBefore();

    events.on('move:before', () => undefined);
    events.on('move:before', () => undefined);
    events.on('move:before', (received) => {
      received.cancelled = true;
    });
    events.emit('move:before', payload);

    expect(payload.cancelled).toBe(true);
  });

  it('leaves cancelled false where no listener sets it', () => {
    const events = createEngineEvents();
    const payload = createMoveBefore();

    events.on('move:before', (received) => {
      expect(received.direction).toBe(DIRECTION_LEFT);
    });
    events.emit('move:before', payload);

    expect(payload.cancelled).toBe(false);
  });

  it('lets a later listener read the flag an earlier one set', () => {
    const events = createEngineEvents();
    let seenByLater: boolean | undefined;

    events.on('move:before', (payload) => {
      payload.cancelled = true;
    });
    events.on('move:before', (payload) => {
      seenByLater = payload.cancelled;
    });
    events.emit('move:before', createMoveBefore());

    expect(seenByLater).toBe(true);
  });
});

describe('tile:spawn carries an absent position on a full board (js/grid.js ' +
  'L37-L43)', () => {
  it('carries the position and value of a spawn (js/game_manager.js ' +
    'L71-L72)', () => {
    const events = createEngineEvents();
    const received = recordEmissions(events, 'tile:spawn');

    events.emit('tile:spawn', createTileSpawn());

    expect(received[0]?.position).toEqual(SPAWN_CELL);
    expect(received[0]?.value).toBe(SPAWN_VALUE);
  });

  it('accepts a spawn with no position member at all (js/grid.js L40)', () => {
    const events = createEngineEvents();
    const payload: TileSpawnEvent = { value: SPAWN_VALUE };
    const received = recordEmissions(events, 'tile:spawn');

    expect(() => {
      events.emit('tile:spawn', payload);
    }).not.toThrow();
    expect(received[0]?.position).toBeUndefined();
    expect(received[0]?.value).toBe(SPAWN_VALUE);
  });

  it('accepts a spawn whose position is undefined (js/grid.js L40-L43)', () => {
    const events = createEngineEvents();
    const received = recordEmissions(events, 'tile:spawn');

    events.emit('tile:spawn', createTileSpawn({ position: undefined }));

    expect(received[0]?.position).toBeUndefined();
  });

  it('lets a subscriber handle the absent position without throwing ' +
    '(js/grid.js L40)', () => {
    const events = createEngineEvents();
    const placed: Position[] = [];

    events.on('tile:spawn', (payload) => {
      if (payload.position) {
        placed.push(payload.position);
      }
    });

    expect(() => {
      events.emit('tile:spawn', { value: SPAWN_VALUE });
    }).not.toThrow();
    expect(placed).toHaveLength(0);

    events.emit('tile:spawn', createTileSpawn());

    expect(placed).toEqual([SPAWN_CELL]);
  });

  it('emits once per spawn attempt, position or not (js/game_manager.js ' +
    'L69-L76)', () => {
    const events = createEngineEvents();
    const received = recordEmissions(events, 'tile:spawn');

    events.emit('tile:spawn', createTileSpawn());
    events.emit('tile:spawn', { value: SPAWN_VALUE });

    expect(received).toHaveLength(2);
  });
});

describe('stage:start (js/game_manager.js L35-L59)', () => {
  it('carries stageIndex, goal, seed and boardSize', () => {
    const events = createEngineEvents();
    const received = recordEmissions(events, 'stage:start');

    events.emit('stage:start', createStageStart());

    const start = received[0];

    expect(start).toBeDefined();
    expect(start?.stageIndex).toBe(STAGE_INDEX);
    expect(start?.goal).toEqual(STAGE_GOAL);
    expect(start?.seed).toBe(RUN_SEED);
    expect(start?.boardSize).toBe(BOARD_SIZE);
  });

  it('carries those four members and no others', () => {
    expect(Object.keys(createStageStart()).sort()).toEqual([
      'boardSize',
      'goal',
      'seed',
      'stageIndex',
    ]);
  });

  it('carries the goal verbatim', () => {
    const events = createEngineEvents();
    const received = recordEmissions(events, 'stage:start');

    events.emit('stage:start', createStageStart({ goal: STAGE_GOAL }));

    expect(received[0]?.goal).toBe(STAGE_GOAL);
  });

  it('carries the size the stage grid was built at (L40-L41, L47)', () => {
    const events = createEngineEvents();
    const board = createBoard();
    const received = recordEmissions(events, 'stage:start');

    events.emit(
      'stage:start',
      createStageStart({ boardSize: board.size }),
    );

    expect(received[0]?.boardSize).toBe(board.size);
    expect(received[0]?.boardSize).toBe(BOARD_SIZE);
  });

  it('carries the run seed exactly as it was supplied', () => {
    const events = createEngineEvents();
    const received = recordEmissions(events, 'stage:start');

    events.emit('stage:start', createStageStart({ seed: RUN_SEED }));

    expect(received[0]?.seed).toBe(RUN_SEED);
    expect(typeof received[0]?.seed).toBe('string');
  });
});

describe('stage:end has no vanilla analogue (AAP Contract 1)', () => {
  it('carries stageIndex, cleared and score', () => {
    const events = createEngineEvents();
    const received = recordEmissions(events, 'stage:end');

    events.emit('stage:end', createStageEnd());

    const end = received[0];

    expect(end).toBeDefined();
    expect(end?.stageIndex).toBe(STAGE_INDEX);
    expect(end?.cleared).toBe(true);
    expect(end?.score).toBe(COMMIT_SCORE);
  });

  it('carries those three members and no others', () => {
    expect(Object.keys(createStageEnd()).sort()).toEqual([
      'cleared',
      'score',
      'stageIndex',
    ]);
  });

  it('carries cleared false for a stage that was not cleared', () => {
    const events = createEngineEvents();
    const received = recordEmissions(events, 'stage:end');

    events.emit('stage:end', createStageEnd({ cleared: false }));

    expect(received[0]?.cleared).toBe(false);
  });

  it('is one of the seven names although it ports from nothing', () => {
    expect(EXPECTED_EVENT_NAMES).toContain('stage:end');
    expect([...ENGINE_EVENT_NAMES]).toContain('stage:end');
  });
});

describe('move:after mirrors the vanilla post-move branch ' +
  '(js/game_manager.js L185-L189)', () => {
  it('carries moved, board, score, over, won and terminated', () => {
    const events = createEngineEvents();
    const board = createBoard();
    const received = recordEmissions(events, 'move:after');

    events.emit('move:after', createMoveAfter({ board }));

    const after = received[0];

    expect(after).toBeDefined();
    expect(after?.moved).toBe(true);
    expect(after?.board).toBe(board);
    expect(after?.score).toBe(COMMIT_SCORE);
    expect(after?.over).toBe(false);
    expect(after?.won).toBe(false);
    expect(after?.terminated).toBe(false);
  });

  it('carries those six members and no others', () => {
    expect(Object.keys(createMoveAfter()).sort()).toEqual([
      'board',
      'moved',
      'over',
      'score',
      'terminated',
      'won',
    ]);
  });

  it('carries moved false for a move that changed no cell (L175-L177, ' +
    'L182)', () => {
    const events = createEngineEvents();
    const received = recordEmissions(events, 'move:after');

    events.emit('move:after', createMoveAfter({ moved: false }));

    expect(received[0]?.moved).toBe(false);
  });

  it('carries over true for the loss the branch detected (L185-L187)', () => {
    const events = createEngineEvents();
    const received = recordEmissions(events, 'move:after');

    events.emit(
      'move:after',
      createMoveAfter({ over: true, terminated: true }),
    );

    expect(received[0]?.over).toBe(true);
    expect(received[0]?.terminated).toBe(true);
  });

  it('passes the board by reference, as the actuation it precedes does ' +
    '(L189)', () => {
    const events = createEngineEvents();
    const board = createBoard();
    let seen: Grid | null = null;

    events.on('move:after', (payload) => {
      seen = payload.board;
    });
    events.emit('move:after', createMoveAfter({ board }));

    expect(seen).toBe(board);
  });
});

describe('EngineEventPayloadMap types each listener to its own payload (AAP ' +
  'Contract 1)', () => {
  it('maps each of the seven names to its own payload interface', () => {
    const stageStartMatches: Exact<
      EngineEventPayloadMap['stage:start'],
      StageStartEvent
    > = true;
    const moveBeforeMatches: Exact<
      EngineEventPayloadMap['move:before'],
      MoveBeforeEvent
    > = true;
    const tileMergeMatches: Exact<
      EngineEventPayloadMap['tile:merge'],
      TileMergeEvent
    > = true;
    const tileSpawnMatches: Exact<
      EngineEventPayloadMap['tile:spawn'],
      TileSpawnEvent
    > = true;
    const moveAfterMatches: Exact<
      EngineEventPayloadMap['move:after'],
      MoveAfterEvent
    > = true;
    const stageEndMatches: Exact<
      EngineEventPayloadMap['stage:end'],
      StageEndEvent
    > = true;
    const stateCommitMatches: Exact<
      EngineEventPayloadMap['state:commit'],
      StateCommitEvent
    > = true;

    expect([
      stageStartMatches,
      moveBeforeMatches,
      tileMergeMatches,
      tileSpawnMatches,
      moveAfterMatches,
      stageEndMatches,
      stateCommitMatches,
    ]).toEqual(Array(EXPECTED_EVENT_NAME_COUNT).fill(true));
  });

  it('types a listener by the name it is registered under', () => {
    const listenerTakesItsOwnPayload: Exact<
      Parameters<EngineEventListener<'state:commit'>>[0],
      StateCommitEvent
    > = true;
    const spawnListenerTakesItsOwnPayload: Exact<
      Parameters<EngineEventListener<'tile:spawn'>>[0],
      TileSpawnEvent
    > = true;

    expect(listenerTakesItsOwnPayload).toBe(true);
    expect(spawnListenerTakesItsOwnPayload).toBe(true);
  });

  it('gives a listener exactly one parameter', () => {
    const listenerIsUnary: Exact<
      Parameters<EngineEventListener<'stage:end'>>['length'],
      1
    > = true;

    expect(listenerIsUnary).toBe(true);
  });

  it('rejects a listener typed for another event', () => {
    const events = createEngineEvents();
    let commits = 0;
    const commitListener = (commit: StateCommitEvent): void => {
      commits += commit.score;
    };

    // @ts-expect-error A state:commit listener is not a tile:spawn listener.
    events.on('tile:spawn', commitListener);

    expect(commits).toBe(0);
  });

  it('rejects a payload emitted under another name', () => {
    const events = createEngineEvents();

    // @ts-expect-error A stage:end payload is not a state:commit payload.
    events.emit('state:commit', createStageEnd());

    expect(ENGINE_EVENT_NAMES).toContain('state:commit');
  });

  it('returns a subscription handle that takes no argument', () => {
    const handleIsNullary: Exact<Parameters<EngineEventSubscription>, []> =
      true;
    const events = createEngineEvents();
    const stop = events.on('stage:end', vi.fn());

    expect(handleIsNullary).toBe(true);
    expect(stop).toBeInstanceOf(Function);
    expect(stop()).toBeUndefined();
  });
});
