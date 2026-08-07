// Contract suite for src/engine/engine-events.ts, AAP Contract 1: the typed
// engine event contract and its emitter. Figure 1, As-Is Architecture, records
// the controller pushing to the actuator; Figure 2, To-Be Architecture, records
// the engine emitting and holding no view reference. The assertions below are
// the executable evidence that the second replaced the first.
//
// Constructs pinned, with the vanilla line range of each:
//   js/keyboard_input_manager.js L2      the listener table
//   js/keyboard_input_manager.js L18-L23 on()
//   js/keyboard_input_manager.js L25-L32 emit()
//   js/game_manager.js L35-L59           setup(), now stage:start
//   js/game_manager.js L130-L143         move() entry, now move:before
//   js/game_manager.js L156-L170         merge branch, now tile:merge
//   js/game_manager.js L69-L76           addRandomTile(), now tile:spawn
//   js/grid.js L37-L43                   randomAvailableCell(), the absent
//                                        spawn position
//   js/game_manager.js L185-L189         post-move branch, now move:after
//   js/game_manager.js L91-L97           actuate(), now state:commit
//   AAP Contract 1                       ENGINE_EVENT_NAMES, no vanilla
//                                        analogue
//   AAP Contract 1                       EngineEventPayloadMap, no vanilla
//                                        analogue
//   AAP Contract 1                       stage:end, no vanilla analogue
//   AAP Contract 1                       off(), no vanilla analogue
//
// Consumers the assertions below hold those constructs to:
//   js/html_actuator.js L10             actuate(grid, metadata)
//   js/html_actuator.js L16-L22         grid.cells walked by reference
//   js/html_actuator.js L54, L58        previousPosition, value
//   js/html_actuator.js L67-L80         previousPosition, mergedFrom
//   js/local_storage_manager.js L43-L45 bestScore as a string or 0
//   js/game_manager.js L80-L82          the relational bestScore comparison
//
// Not pinned here, and pinned by the sibling suite named:
//   pickup order, charge guard, error isolation, payload compounding
//     -> tests/unit/engine/hook-bus.test.ts
//   which events one turn emits, and in what order
//     -> tests/unit/engine/engine.test.ts
//   js/tile.js L1-L27  -> tests/unit/engine/tile.test.ts
//   js/grid.js L1-L117 -> tests/unit/engine/grid.test.ts
//
// This suite reads no DOM, no storage and no clock, consumes no randomness,
// installs no mock library and writes no snapshot.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

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

/* ===== 1. Names, values and cells the assertions use ===== */

/**
 * Every event name AAP Contract 1 declares, in the order one turn reaches
 * them, written out independently of the tuple under test.
 */
const EXPECTED_EVENT_NAMES: readonly string[] = [
  'stage:start',
  'move:before',
  'tile:merge',
  'tile:spawn',
  'move:after',
  'stage:end',
  'state:commit',
];

/** How many event names AAP Contract 1 declares. */
const EXPECTED_EVENT_NAME_COUNT = 7;

/** The three members `EngineEvents` exposes. */
const EMITTER_MEMBERS: readonly string[] = ['emit', 'off', 'on'];

/** Run seed `stage:start` carries. */
const RUN_SEED = 'engine-events-seed';

/** Edge length in cells of the boards these assertions build. */
const BOARD_SIZE = 4;

/** Zero-based index of the stage these assertions run in. */
const STAGE_INDEX = 2;

/** Score `state:commit` and `move:after` carry. */
const COMMIT_SCORE = 128;

/**
 * Best score `state:commit` carries. js/local_storage_manager.js L43-L45
 * returns the raw stored string, and js/game_manager.js L95 placed it here
 * unconverted.
 */
const STORED_BEST_SCORE = '4096';

/** Column index of the first merge-pair fixture tile. */
const PAIR_X = 0;

/** Column index of the second merge-pair fixture tile. */
const PAIR_NEXT_X = 1;

/** Row index of both merge-pair fixture tiles. */
const PAIR_Y = 0;

/** Face value of both merge-pair fixture tiles. */
const PAIR_VALUE = 2;

/** Value js/game_manager.js L157 produces from two PAIR_VALUE tiles. */
const PAIR_MERGED_VALUE = 4;

/** Face value of the second pair these assertions merge. */
const SECOND_PAIR_VALUE = 8;

/** Value js/game_manager.js L157 produces from two SECOND_PAIR_VALUE tiles. */
const SECOND_PAIR_MERGED_VALUE = 16;

/** Cell a spawned tile occupies. */
const SPAWN_CELL: Position = { x: 3, y: 2 };

/** Face value js/game_manager.js L71 spawns nine times in ten. */
const SPAWN_VALUE = 2;

/** Goal `stage:start` and the stage slice carry. */
const STAGE_GOAL: StageGoal = {
  kind: 'score-threshold',
  target: 500,
};

/** How many listeners the append-only assertions register on one event. */
const APPEND_LISTENER_COUNT = 3;

/* ===== 2. Type-level assertion helper ===== */

/**
 * Resolves to `true` where `Left` and `Right` are mutually assignable, and to
 * `false` otherwise. Assigning `true` to a binding of this type compiles only
 * where the two types match, so the assignment itself is the assertion.
 */
type Exact<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;

/* ===== 3. Board and tile builders ===== */

/**
 * Builds a live board from the merge-pair fixture.
 *
 * @returns A grid holding the fixture's two equal tiles in row 0.
 */
function createBoard(): Grid {
  const board = createMergePairBoard(BOARD_SIZE);

  return new Grid(board.grid.size, board.grid.cells);
}

/**
 * Builds a tile at a cell.
 *
 * @param x Zero-based column index.
 * @param y Zero-based row index.
 * @param value Face value.
 * @returns A tile carrying no animation state.
 */
function createTile(x: number, y: number, value: number): Tile {
  return new Tile({ x, y }, value);
}

/**
 * Builds the merged pair js/game_manager.js L156-L158 recorded as
 * `mergedFrom = [tile, next]`, with both tiles out of the lattice as
 * js/game_manager.js L160-L161 left them.
 *
 * @param value Face value of both source tiles.
 * @returns The source tile, the target tile and the tile they produce.
 */
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

/* ===== 4. Payload builders ===== */

/**
 * Builds a `stage:start` payload.
 *
 * @param overrides Members to replace on the default payload.
 * @returns A complete payload.
 */
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

/**
 * Builds a `move:before` payload, whose `cancelled` member is mutable.
 *
 * @param overrides Members to replace on the default payload.
 * @returns A complete payload dispatched with `cancelled` false.
 */
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

/**
 * Builds a `tile:merge` payload.
 *
 * @param value Face value of both tiles the merge consumes.
 * @returns A complete payload whose tiles are the live pair.
 */
function createTileMerge(value: number = PAIR_VALUE): TileMergeEvent {
  const { source, target, merged } = createMergedTriple(value);

  return {
    source,
    target,
    resultValue: merged.value,
    scoreDelta: merged.value,
  };
}

/**
 * Builds a `tile:spawn` payload.
 *
 * @param overrides Members to replace on the default payload.
 * @returns A complete payload.
 */
function createTileSpawn(
  overrides: Partial<TileSpawnEvent> = {},
): TileSpawnEvent {
  return {
    position: SPAWN_CELL,
    value: SPAWN_VALUE,
    ...overrides,
  };
}

/**
 * Builds a `move:after` payload.
 *
 * @param overrides Members to replace on the default payload.
 * @returns A complete payload.
 */
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

/**
 * Builds a `stage:end` payload.
 *
 * @param overrides Members to replace on the default payload.
 * @returns A complete payload.
 */
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

/**
 * Builds a `state:commit` payload, the successor to the payload
 * js/game_manager.js L91-L97 pushed.
 *
 * @param overrides Members to replace on the default payload.
 * @returns A complete payload carrying the neutral stage and relic slices.
 */
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

/* ===== 5. Emission recorders ===== */

/**
 * Registers a listener that records every payload it is handed.
 *
 * @param events Emitter to register on.
 * @param event Event to listen for.
 * @returns The array the listener appends to, in emission order.
 */
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

/**
 * Registers a listener that appends `label` to `order` when it runs.
 *
 * @param events Emitter to register on.
 * @param order Array every registered listener appends to.
 * @param label Label this listener appends.
 * @returns The handle that detaches this listener.
 */
function recordOrder(
  events: EngineEvents,
  order: string[],
  label: string,
): EngineEventSubscription {
  return events.on('stage:end', () => {
    order.push(label);
  });
}

/* ===== 6. The seven event names ===== */

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

/* ===== 7. Construction ===== */

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

/* ===== 8. on() appends and never replaces ===== */

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

/* ===== 9. emit() is synchronous with a single argument ===== */

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

/* ===== 10. emit() walks the listeners it began with ===== */

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

  it('invokes a listener removed during the emission (L28)', () => {
    const events = createEngineEvents();
    const order: string[] = [];
    const second = recordOrder(events, order, 'second');

    events.on('stage:end', () => {
      order.push('first');
      second();
    });
    events.emit('stage:end', createStageEnd());

    expect(order).toEqual(['second', 'first']);

    order.length = 0;
    events.emit('stage:end', createStageEnd());

    expect(order).toEqual(['first']);
  });
});

/* ===== 11. emit() does not isolate a throwing listener ===== */

// Error isolation, the charge guard, pickup-order dispatch and payload
// compounding are src/engine/hook-bus.ts, pinned by
// tests/unit/engine/hook-bus.test.ts. js/keyboard_input_manager.js L28-L30
// iterated with no try/catch, and this emitter is that iteration.
describe('EngineEvents.emit does not isolate a throwing listener ' +
  '(js/keyboard_input_manager.js L25-L32)', () => {
  it('propagates a listener error to the caller that emitted (L28-L30)', () => {
    const events = createEngineEvents();
    const failure = new Error('listener failed');

    events.on('stage:end', () => {
      throw failure;
    });

    expect(() => {
      events.emit('stage:end', createStageEnd());
    }).toThrow(failure);
  });

  it('does not invoke the listeners after the one that threw (L28-L30)', () => {
    const events = createEngineEvents();
    const before = vi.fn();
    const after = vi.fn();

    events.on('stage:end', before);
    events.on('stage:end', () => {
      throw new Error('listener failed');
    });
    events.on('stage:end', after);

    expect(() => {
      events.emit('stage:end', createStageEnd());
    }).toThrow();
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).not.toHaveBeenCalled();
  });

  it('leaves the throwing listener registered (L28-L30)', () => {
    const events = createEngineEvents();
    let calls = 0;

    events.on('stage:end', () => {
      calls += 1;
      throw new Error('listener failed');
    });

    expect(() => {
      events.emit('stage:end', createStageEnd());
    }).toThrow();
    expect(() => {
      events.emit('stage:end', createStageEnd());
    }).toThrow();
    expect(calls).toBe(2);
  });

  it('reports nothing and swallows nothing of its own (L25-L32)', () => {
    const events = createEngineEvents();
    const thrown = { code: 'not-an-error' };

    events.on('tile:spawn', () => {
      throw thrown;
    });

    let caught: unknown;

    try {
      events.emit('tile:spawn', createTileSpawn());
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBe(thrown);
  });
});

/* ===== 12. off() and the subscription handle ===== */

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

/* ===== 13. state:commit, successor to the vanilla actuation payload ===== */

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

/* ===== 14. state:commit passes the board by reference ===== */

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

/* ===== 15. tile:merge is emitted once per merge ===== */

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

/* ===== 16. move:before is cancellable ===== */

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

/* ===== 17. tile:spawn carries an absent position ===== */

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

/* ===== 18. stage:start ===== */

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

/* ===== 19. stage:end ===== */

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

/* ===== 20. move:after ===== */

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

/* ===== 21. Type-level payload mapping ===== */

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
