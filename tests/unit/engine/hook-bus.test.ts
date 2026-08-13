// Contract suite for src/engine/hook-bus.ts: the hook execution protocol,
// together with the six-name hook vocabulary of src/engine/hooks.ts.
//
// Not pinned here: the emitter's own `on`, `emit` and `off` semantics, which
// belong to tests/unit/engine/engine-events.test.ts.
//
// Every subscriber below is hand-built and every handler is a vi.fn spy. This
// suite reads no DOM and no storage, imports no module under
// src/observability, src/relics, src/render, src/run or src/ui, installs no
// mock library and writes no snapshot.

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_BOARD_SIZE,
  createDefaultRulesConfig,
} from '../../../src/config/default-config';
import type { RulesConfig } from '../../../src/config/rules-config';
import { STAGE_GOAL_KINDS } from '../../../src/config/stage-config';
import {
  createHookBus,
} from '../../../src/engine/hook-bus';
import type {
  ChargeConsumption,
  HookBus,
  HookBusMetrics,
  HookCounters,
  HookDispatchResult,
  HookSkipReason,
  HookSubscriber,
  HookSubscriberMetrics,
} from '../../../src/engine/hook-bus';
import { Grid } from '../../../src/engine/grid';
import { HOOK_NAMES } from '../../../src/engine/hooks';
import type {
  AfterMoveDispatchPayload,
  AfterMovePayload,
  BeforeMoveDispatchPayload,
  BeforeMovePayload,
  HookContext,
  HookDispatchPayloadMap,
  MergeDispatchPayload,
  HookEnvironment,
  HookHandler,
  HookHandlerTable,
  HookName,
  HookPayloadMap,
  HookSubscription,
  MergePayload,
  SpawnPayload,
  StageEndPayload,
  StageStartPayload,
} from '../../../src/engine/hooks';
import { Tile } from '../../../src/engine/tile';
import {
  DIRECTION_RIGHT,
  DIRECTION_UP,
  NOOP_ENGINE_REPORTER,
} from '../../../src/engine/types';
import type {
  EngineCountReport,
  EngineHookErrorReport,
  EngineReporter,
} from '../../../src/engine/types';
import { createRngStreams } from '../../../src/rng/rng-streams';
import { createMergePairBoard } from '../../fixtures/boards';

const EXPECTED_HOOK_NAMES: readonly string[] = [
  'onStageStart',
  'onBeforeMove',
  'onMerge',
  'onSpawn',
  'onAfterMove',
  'onStageEnd',
];

const EXPECTED_HOOK_NAME_COUNT = 6;

/** Correlation identifier every bus below is constructed with. */
const CORRELATION_ID = 'run-hook-bus-0001';

const RUN_SEED = 'hook-bus-suite-seed';

const BOARD_SIZE = DEFAULT_BOARD_SIZE;

const PAIR_X = 0;

const PAIR_NEXT_X = 1;

const PAIR_Y = 0;

const PAIR_VALUE = 2;

const MERGED_VALUE = 4;

const MERGE_SCORE_DELTA = 4;

const STAGE_INDEX = 2;

const STAGE_SCORE = 132;

const SPAWN_VALUE = 2;

const RELIC_CATALOGUE_SIZE = 16;

/** The substream js/game_manager.js L71's draw was moved onto. */
const SPAWN_VALUE_STREAM = 'spawn-value';

/** A board edge no view below may be talked into. */
const HUGE_BOARD_SIZE = 1_000_000;

/**
 * An edge length a `resizeBoard` command is actually accepted at, which
 * `HUGE_BOARD_SIZE` deliberately is not: src/engine/board-effects.ts bounds a
 * resize, so a case proving the channel WRITES has to ask for a size inside
 * those bounds.
 */
const EFFECT_BOARD_EDGE = 3;

/** A goal target a handler replaces the dispatched one with. */
const REPLACED_GOAL_TARGET = 512;

type Exact<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;

function createBoard(): Grid {
  const board = createMergePairBoard(BOARD_SIZE);

  return new Grid(board.grid.size, board.grid.cells);
}

function createEnvironment(): HookEnvironment {
  const config: RulesConfig = createDefaultRulesConfig();

  return {
    config,
    rng: createRngStreams(RUN_SEED),
    grid: createBoard(),
  };
}

function createStageStartPayload(): StageStartPayload {
  const goal: StageStartPayload['goal'] = {
    kind: 'highest-tile',
    target: 128,
  };

  return {
    stageIndex: STAGE_INDEX,
    goal,
    seed: RUN_SEED,
    boardSize: BOARD_SIZE,
  };
}

function createBeforeMovePayload(board: Grid): BeforeMoveDispatchPayload {
  return { direction: DIRECTION_UP, board, cancelled: false };
}

function createMergePayload(): MergeDispatchPayload {
  const source = new Tile({ x: PAIR_NEXT_X, y: PAIR_Y }, PAIR_VALUE);
  const target = new Tile({ x: PAIR_X, y: PAIR_Y }, PAIR_VALUE);

  source.savePosition();
  target.savePosition();
  source.updatePosition({ x: PAIR_X, y: PAIR_Y });

  return {
    source,
    target,
    resultValue: MERGED_VALUE,
    scoreDelta: MERGE_SCORE_DELTA,
  };
}

function createSpawnPayload(): SpawnPayload {
  return { position: { x: PAIR_NEXT_X, y: PAIR_NEXT_X }, value: SPAWN_VALUE };
}

function createAfterMovePayload(board: Grid): AfterMoveDispatchPayload {
  return {
    moved: true,
    board,
    score: STAGE_SCORE,
    over: false,
    won: false,
    terminated: false,
  };
}

function createStageEndPayload(): StageEndPayload {
  return {
    stageIndex: STAGE_INDEX,
    cleared: true,
    score: STAGE_SCORE,
  };
}

function createPayloadsByHook(board: Grid): HookDispatchPayloadMap {
  return {
    onStageStart: createStageStartPayload(),
    onBeforeMove: createBeforeMovePayload(board),
    onMerge: createMergePayload(),
    onSpawn: createSpawnPayload(),
    onAfterMove: createAfterMovePayload(board),
    onStageEnd: createStageEndPayload(),
  };
}

function createForeignGridView(): BeforeMovePayload['board'] {
  const foreign = createBoard();

  return Object.freeze({
    size: foreign.size,
    withinBounds: (position: { x: number; y: number }): boolean =>
      foreign.withinBounds(position),
    cellAvailable: (cell: { x: number; y: number }): boolean =>
      foreign.cellAvailable(cell),
    cellOccupied: (cell: { x: number; y: number }): boolean =>
      !foreign.cellAvailable(cell),
    cellValue: (cell: { x: number; y: number }): number | null =>
      foreign.cellContent(cell)?.value ?? null,
    availableCells: () => foreign.availableCells(),
    cellsAvailable: (): boolean => foreign.cellsAvailable(),
    serialize: () => foreign.serialize(),
  });
}

interface RecordingReporter {
  readonly reporter: EngineReporter;
  readonly errors: EngineHookErrorReport[];
  readonly counts: EngineCountReport[];
}

function createRecordingReporter(): RecordingReporter {
  const errors: EngineHookErrorReport[] = [];
  const counts: EngineCountReport[] = [];

  return {
    reporter: {
      onHookError: (report: EngineHookErrorReport): void => {
        errors.push(report);
      },
      onCount: (report: EngineCountReport): void => {
        counts.push(report);
      },
    },
    errors,
    counts,
  };
}

type SubscriberExtras = Partial<
  Pick<HookSubscriber, 'charges' | 'state' | 'pickupOrder'>
>;

function createSubscriber(
  id: string,
  hooks: HookHandlerTable,
  extras: SubscriberExtras = {},
): HookSubscriber {
  return {
    id,
    hooks,
    charges: extras.charges,
    state: extras.state,
    pickupOrder: extras.pickupOrder,
  };
}

function createStageEndRecorder(
  id: string,
  order: string[],
  extras: SubscriberExtras = {},
): HookSubscriber {
  const handler: HookHandler<'onStageEnd'> = vi.fn((): void => {
    order.push(id);
  });

  return createSubscriber(id, { onStageEnd: handler }, extras);
}

function register(bus: HookBus, subscriber: HookSubscriber): void {
  expect(bus.register(subscriber)).toBe(true);
}

/**
 * Runs a dispatch and asserts that nothing escaped it, then hands back its
 * outcome, so both halves of a no-throw guarantee are asserted from one call.
 *
 * @param dispatch Dispatch under test.
 * @returns What the dispatch produced.
 */
function expectNoDispatchThrow(
  dispatch: () => HookDispatchResult<'onStageEnd'>,
): HookDispatchResult<'onStageEnd'> {
  const outcomes: HookDispatchResult<'onStageEnd'>[] = [];

  expect(() => {
    outcomes.push(dispatch());
  }).not.toThrow();
  expect(outcomes).toHaveLength(1);

  return outcomes[0];
}

/**
 * Runs a charge consumption and asserts that nothing escaped it, then hands
 * back what it reported.
 *
 * @param consume Consumption under test.
 * @returns What the consumption reported.
 */
function expectConsumption(
  consume: () => ChargeConsumption,
): ChargeConsumption {
  const outcomes: ChargeConsumption[] = [];

  expect(() => {
    outcomes.push(consume());
  }).not.toThrow();
  expect(outcomes).toHaveLength(1);

  return outcomes[0];
}

/**
 * Dispatches `onStageEnd`, the hook whose payload carries no live board.
 *
 * @param bus Bus to dispatch on.
 * @param payload Payload the first handler receives.
 * @returns The dispatch's outcome.
 */
function dispatchStageEnd(
  bus: HookBus,
  payload: StageEndPayload = createStageEndPayload(),
): HookDispatchResult<'onStageEnd'> {
  return bus.dispatch('onStageEnd', payload, createEnvironment());
}

describe('HOOK_NAMES declares exactly six hooks (AAP Contract 2)', () => {
  it('declares exactly the six names, in turn order', () => {
    expect([...HOOK_NAMES]).toEqual(EXPECTED_HOOK_NAMES);
  });

  it('declares six names and no seventh', () => {
    expect(HOOK_NAMES).toHaveLength(EXPECTED_HOOK_NAME_COUNT);
    expect(new Set(HOOK_NAMES).size).toBe(EXPECTED_HOOK_NAME_COUNT);
  });

  it('orders the names as one turn reaches them', () => {
    expect(HOOK_NAMES[0]).toBe('onStageStart');
    expect(HOOK_NAMES[1]).toBe('onBeforeMove');
    expect(HOOK_NAMES[2]).toBe('onMerge');
    expect(HOOK_NAMES[3]).toBe('onSpawn');
    expect(HOOK_NAMES[4]).toBe('onAfterMove');
    expect(HOOK_NAMES[5]).toBe('onStageEnd');
  });

  it('declares the six names once, as a readonly tuple', () => {
    const namesAreExactTuple: Exact<
      typeof HOOK_NAMES,
      readonly [
        'onStageStart',
        'onBeforeMove',
        'onMerge',
        'onSpawn',
        'onAfterMove',
        'onStageEnd',
      ]
    > = true;

    expect(namesAreExactTuple).toBe(true);
  });

  it('derives HookName from the tuple', () => {
    const names: readonly HookName[] = HOOK_NAMES;
    const nameIsUnion: Exact<
      HookName,
      | 'onStageStart'
      | 'onBeforeMove'
      | 'onMerge'
      | 'onSpawn'
      | 'onAfterMove'
      | 'onStageEnd'
    > = true;

    expect(names).toEqual(EXPECTED_HOOK_NAMES);
    expect(nameIsUnion).toBe(true);
  });

  it('freezes the tuple, so no seventh name can be appended', () => {
    expect(Object.isFrozen(HOOK_NAMES)).toBe(true);
  });

  it('admits no name outside the six', () => {
    const rejectsAnUnknownName: Exact<
      Extract<HookName, 'onRelicPicked'>,
      never
    > = true;

    expect(rejectsAnUnknownName).toBe(true);
    expect(EXPECTED_HOOK_NAMES).not.toContain('onRelicPicked');
  });
});

describe('dispatch accepts every one of the six names (AAP Contract 2)', () => {
  it('dispatches each of the six and returns its own payload', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const board = createBoard();
    const payloads = createPayloadsByHook(board);
    const environment = createEnvironment();

    for (const hook of HOOK_NAMES) {
      const result = bus.dispatch(hook, payloads[hook], environment);

      // A dispatch with no subscriber returns the caller's payload member for
      // member, for all six: nothing is substituted between the caller and the
      // handler, which is the contract AAP 0.6.1.1 states.
      expect(Object.keys(result.payload as object).sort()).toEqual(
        Object.keys(payloads[hook] as object).sort(),
      );
      expect(result.invoked).toBe(0);
    }

    expect(bus.metrics().totals.dispatched).toBe(EXPECTED_HOOK_NAME_COUNT);
  });

  it('reaches a handler bound to each of the six names', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const board = createBoard();
    const payloads = createPayloadsByHook(board);
    const reached: string[] = [];
    const tables: readonly HookHandlerTable[] = [
      {
        onStageStart: (): void => {
          reached.push('onStageStart');
        },
      },
      {
        onBeforeMove: (): void => {
          reached.push('onBeforeMove');
        },
      },
      {
        onMerge: (): void => {
          reached.push('onMerge');
        },
      },
      {
        onSpawn: (): void => {
          reached.push('onSpawn');
        },
      },
      {
        onAfterMove: (): void => {
          reached.push('onAfterMove');
        },
      },
      {
        onStageEnd: (): void => {
          reached.push('onStageEnd');
        },
      },
    ];

    tables.forEach((hooks, index): void => {
      register(bus, createSubscriber(`bound-${index}`, hooks));
    });

    for (const hook of HOOK_NAMES) {
      bus.dispatch(hook, payloads[hook], createEnvironment());
    }

    expect(reached).toEqual([...EXPECTED_HOOK_NAMES]);
  });

  it('types each name to its own payload', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const environment = createEnvironment();

    // @ts-expect-error onMerge does not carry an onSpawn payload.
    bus.dispatch('onMerge', createSpawnPayload(), environment);

    // @ts-expect-error onSpawn does not carry an onStageEnd payload.
    bus.dispatch('onSpawn', createStageEndPayload(), environment);

    // @ts-expect-error onRelicPicked is not one of the six names.
    bus.dispatch('onRelicPicked', createStageEndPayload(), environment);

    expect(bus.metrics().totals.dispatched).toBe(3);
  });
});

describe('createHookBus (js/keyboard_input_manager.js L1-L16)', () => {
  it('constructs with no argument at all', () => {
    const bus = createHookBus();

    expect(bus.subscribers()).toEqual([]);
    expect(bus.degraded()).toEqual([]);
    expect(dispatchStageEnd(bus).invoked).toBe(0);
  });

  it('defaults the correlation identifier to the empty string', () => {
    expect(createHookBus().metrics().correlationId).toBe('');
  });

  it('carries the correlation identifier it was constructed with', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });

    expect(bus.metrics().correlationId).toBe(CORRELATION_ID);
  });

  it('reads an injected reader per report, so a run rotation reaches it', () => {
    let current = 'run-first';
    const reports: string[] = [];
    const bus = createHookBus({
      correlationId: (): string => current,
      reporter: {
        onCount(report): void {
          reports.push(report.correlationId);
        },
      },
    });

    expect(bus.metrics().correlationId).toBe('run-first');

    // A second run of one page load. A bus that captured the identifier at
    // construction kept reporting the ended run's.
    current = 'run-second';
    register(
      bus,
      createSubscriber('reader', { onStageEnd: (): void => undefined }),
    );
    dispatchStageEnd(bus);

    expect(bus.metrics().correlationId).toBe('run-second');
    expect(reports.length).toBeGreaterThan(0);
    expect(reports[reports.length - 1]).toBe('run-second');
  });

  it('reports the empty string where an injected reader raises', () => {
    const bus = createHookBus({
      correlationId: (): string => {
        throw new Error('correlation unavailable');
      },
    });

    // Total, as every read of an injected collaborator is here: a reader that
    // raises must not take a metrics snapshot down with it.
    expect(bus.metrics().correlationId).toBe('');
  });

  it('starts every counter at zero, as L2 started an empty table', () => {
    const metrics: HookBusMetrics = createHookBus({
      correlationId: CORRELATION_ID,
    }).metrics();

    expect(metrics.registered).toBe(0);
    expect(metrics.acceptedRegistrations).toBe(0);
    expect(metrics.rejectedRegistrations).toBe(0);
    expect(metrics.removedSubscribers).toBe(0);
    expect(metrics.chargesConsumed).toBe(0);
    expect(metrics.reporterFaults).toBe(0);
    expect(metrics.lastReporterFault).toBeUndefined();
    expect(metrics.subscribers).toEqual([]);
    expect(metrics.totals.dispatched).toBe(0);
  });

  it('freezes the bus, so its surface is the eight members', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });

    expect(Object.isFrozen(bus)).toBe(true);
    expect(typeof bus.register).toBe('function');
    expect(typeof bus.unregister).toBe('function');
    expect(typeof bus.dispatch).toBe('function');
    expect(typeof bus.consumeCharge).toBe('function');
    expect(typeof bus.degraded).toBe('function');
    expect(typeof bus.subscriptions).toBe('function');
    expect(typeof bus.subscribers).toBe('function');
    expect(typeof bus.metrics).toBe('function');
  });

  it('hands PROJECTIONS of the live rules and the live board to a handler, and ' +
    'a per-handler randomness fork', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const environment = createEnvironment();
    const seen: HookContext[] = [];

    register(
      bus,
      createSubscriber('reads-environment', {
        onStageEnd: (_payload, context): void => {
          seen.push(context);
        },
      }),
    );

    bus.dispatch('onStageEnd', createStageEndPayload(), environment);

    const context = seen[0];

    expect(seen).toHaveLength(1);

    // AAP 0.6.1.2. The collaborators are READ through frozen facades and
    // WRITTEN through the command queue, so a handler that mutates and then
    // throws has nothing left behind to roll back.
    expect(context.config).not.toBe(environment.config);
    expect(Object.isFrozen(context.config)).toBe(true);
    expect(context.config.boardSize).toBe(environment.config.boardSize);
    expect(context.config.winValue).toBe(environment.config.winValue);

    expect(context.grid).not.toBe(environment.grid);
    expect(Object.isFrozen(context.grid)).toBe(true);
    expect(context.grid.size).toBe(environment.grid.size);
    expect(context.grid.cellValue({ x: PAIR_X, y: PAIR_Y })).toBe(
      environment.grid.cellContent({ x: PAIR_X, y: PAIR_Y })?.value ?? null,
    );

    // The write channel, on the same context.
    expect(typeof context.effects.removeTile).toBe('function');

    // Randomness stays transactional, so it is NOT the live table.
    expect(context.rng).not.toBe(environment.rng);
    expect(Object.isFrozen(context.rng)).toBe(true);
    expect(context.rng.seed).toBe(environment.rng.seed);

    // A fork standing where the substream stands, so the draws a handler takes
    // are the handler's own until they are committed.
    const fork = context.rng.stream(SPAWN_VALUE_STREAM);

    expect(fork).not.toBe(environment.rng.stream(SPAWN_VALUE_STREAM));
    expect(fork).toBe(context.rng.stream(SPAWN_VALUE_STREAM));
    expect(fork.name).toBe(SPAWN_VALUE_STREAM);
    expect(fork.cursor).toBe(
      environment.rng.stream(SPAWN_VALUE_STREAM).cursor,
    );
  });

  it('lets a handler write the rules and the lattice, which is the relic ' +
    'mutation channel AAP 0.8.6 requires', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const environment = createEnvironment();

    register(
      bus,
      createSubscriber('writes-through', {
        onStageEnd: (_payload, context): void => {
          // Through the command queue, which is the one write channel.
          context.effects.resizeBoard(EFFECT_BOARD_EDGE);
          context.effects.removeTile({ x: PAIR_X, y: PAIR_Y });
        },
      }),
    );

    const result = bus.dispatch(
      'onStageEnd',
      createStageEndPayload(),
      environment,
    );

    expect(environment.config.boardSize).toBe(EFFECT_BOARD_EDGE);
    expect(environment.grid.size).toBe(EFFECT_BOARD_EDGE);
    expect(environment.grid.cellContent({ x: PAIR_X, y: PAIR_Y })).toBeNull();
    expect(result.effectsApplied).toBe(2);
    expect(result.invoked).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('exposes the whole READING board surface, and no writer', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const seen: HookContext['grid'][] = [];

    register(
      bus,
      createSubscriber('reads-board', {
        onStageEnd: (_payload, context): void => {
          seen.push(context.grid);
        },
      }),
    );

    dispatchStageEnd(bus);

    const board = seen[0] as unknown as Record<string, unknown>;

    // Every reader of `ReadonlyGridView`...
    expect(typeof board.withinBounds).toBe('function');
    expect(typeof board.cellAvailable).toBe('function');
    expect(typeof board.cellOccupied).toBe('function');
    expect(typeof board.cellValue).toBe('function');
    expect(typeof board.availableCells).toBe('function');
    expect(typeof board.cellsAvailable).toBe('function');
    expect(typeof board.serialize).toBe('function');

    // and not one writer, nor the lattice itself: a write goes through
    // `context.effects`, which is transactional.
    expect(board.insertTile).toBeUndefined();
    expect(board.removeTile).toBeUndefined();
    expect(board.cellContent).toBeUndefined();
    expect(board.cells).toBeUndefined();
  });

  it('identifies the dispatch on the context it builds', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const seen: HookContext[] = [];

    register(
      bus,
      createSubscriber(
        'identified',
        {
          onStageEnd: (_payload, context): void => {
            seen.push(context);
          },
        },
        { pickupOrder: 7, charges: 4, state: { visits: 0 } },
      ),
    );

    dispatchStageEnd(bus);

    const context = seen[0];

    expect(context.correlationId).toBe(CORRELATION_ID);
    expect(context.hook).toBe('onStageEnd');
    expect(context.subscriberId).toBe('identified');
    expect(context.pickupOrder).toBe(7);
    expect(context.charges).toBe(4);
    expect(context.state).toEqual({ visits: 0 });
  });

  it('carries the context state slot from one dispatch to the next, in ' +
    'the state the bus owns', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const subscriber = createSubscriber(
      'accumulates',
      {
        onStageEnd: (_payload, context): void => {
          const visits = typeof context.state === 'number'
            ? context.state
            : 0;

          context.state = visits + 1;
        },
      },
      { state: 0 },
    );

    register(bus, subscriber);
    dispatchStageEnd(bus);

    expect(bus.subscriptions('onStageEnd')[0].state).toBe(1);

    dispatchStageEnd(bus);

    expect(bus.subscriptions('onStageEnd')[0].state).toBe(2);

    // The bus took the slot over at registration, so the caller's own object
    // is not written through.
    expect(subscriber.state).toBe(0);
  });

  it('keeps a state slot the handler wrote before it threw out of the ' +
    'registration', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });

    register(
      bus,
      createSubscriber(
        'writes-then-throws',
        {
          onStageEnd: (_payload, context): StageEndPayload => {
            context.state = 'written-before-the-throw';
            throw new Error('relic handler failed');
          },
        },
        { state: 'initial' },
      ),
    );

    const result = dispatchStageEnd(bus);

    expect(result.failed).toBe(1);
    expect(bus.subscriptions('onStageEnd')[0].state).toBe('initial');
  });

  it('isolates one subscriber state slot from another', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const seen: unknown[] = [];

    register(
      bus,
      createSubscriber(
        'writes-its-own',
        {
          onStageEnd: (_payload, context): void => {
            context.state = 'mine';
          },
        },
        { pickupOrder: 0, state: 'a' },
      ),
    );
    register(
      bus,
      createSubscriber(
        'reads-its-own',
        {
          onStageEnd: (_payload, context): void => {
            seen.push(context.state);
          },
        },
        { pickupOrder: 1, state: 'b' },
      ),
    );

    dispatchStageEnd(bus);

    expect(seen).toEqual(['b']);
    expect(bus.subscriptions('onStageEnd')[0].state).toBe('mine');
    expect(bus.subscriptions('onStageEnd')[1].state).toBe('b');
  });

  it('freezes every subscription and subscriber snapshot it returns', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });

    register(
      bus,
      createSubscriber(
        'snapshotted',
        { onStageEnd: (): void => undefined },
        { charges: 2, state: { visits: 0 } },
      ),
    );

    const subscription = bus.subscriptions('onStageEnd')[0];
    const snapshot = bus.subscribers()[0];

    expect(Object.isFrozen(subscription)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.hooks)).toBe(true);
  });
});

describe('dispatch walks subscribers in pickup order (AAP Contract 2)', () => {
  it('fires three handlers on one hook in pickup order', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const order: string[] = [];

    register(bus, createStageEndRecorder('first', order, { pickupOrder: 0 }));
    register(bus, createStageEndRecorder('second', order, { pickupOrder: 1 }));
    register(bus, createStageEndRecorder('third', order, { pickupOrder: 2 }));

    const result = dispatchStageEnd(bus);

    expect(order).toEqual(['first', 'second', 'third']);
    expect(result.invoked).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('appends a subscriber that declares no pickup order', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const order: string[] = [];

    register(bus, createStageEndRecorder('picked-first', order));
    register(bus, createStageEndRecorder('picked-second', order));
    register(bus, createStageEndRecorder('picked-third', order));
    dispatchStageEnd(bus);
    expect(order).toEqual([
      'picked-first',
      'picked-second',
      'picked-third',
    ]);
    expect(
      bus.subscriptions('onStageEnd').map(
        (subscription): number => subscription.pickupOrder,
      ),
    ).toEqual([0, 1, 2]);
  });

  it('reports pickup order on the subscriptions bound to a hook', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const order: string[] = [];

    register(bus, createStageEndRecorder('alpha', order, { pickupOrder: 4 }));
    register(bus, createStageEndRecorder('beta', order, { pickupOrder: 9 }));

    const subscriptions: readonly HookSubscription<'onStageEnd'>[] =
      bus.subscriptions('onStageEnd');

    expect(
      subscriptions.map(
        (subscription): string => subscription.subscriberId,
      ),
    ).toEqual(['alpha', 'beta']);
    expect(
      subscriptions.map(
        (subscription): number => subscription.pickupOrder,
      ),
    ).toEqual([4, 9]);
    expect(Object.isFrozen(subscriptions)).toBe(true);
  });

  it('reads subscribers in pickup order, not in array position', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const order: string[] = [];

    register(bus, createStageEndRecorder('late', order, { pickupOrder: 5 }));
    register(bus, createStageEndRecorder('early', order, { pickupOrder: 1 }));
    expect(
      bus.subscribers().map((subscriber): string => subscriber.id),
    ).toEqual(['early', 'late']);
    expect(Object.isFrozen(bus.subscribers())).toBe(true);
  });

  it('breaks a shared pickup index by registration sequence', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const order: string[] = [];

    register(bus, createStageEndRecorder('tied-a', order, { pickupOrder: 3 }));
    register(bus, createStageEndRecorder('tied-b', order, { pickupOrder: 3 }));
    register(bus, createStageEndRecorder('tied-c', order, { pickupOrder: 3 }));
    dispatchStageEnd(bus);
    expect(order).toEqual(['tied-a', 'tied-b', 'tied-c']);
  });
});

describe(
  'pickup order overrides registration order, which the vanilla bus ' +
    'could not do (js/keyboard_input_manager.js L18-L23, L25-L32)',
  () => {
    it('fires in pickup order when registered in the reverse of it', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const order: string[] = [];

      register(bus, createStageEndRecorder('third', order, { pickupOrder: 2 }));
      register(bus, createStageEndRecorder('second', order, {
        pickupOrder: 1,
      }));
      register(bus, createStageEndRecorder('first', order, { pickupOrder: 0 }));
      dispatchStageEnd(bus);
      expect(order).toEqual(['first', 'second', 'third']);
    });

    it('fires in pickup order when registered in no order at all', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const order: string[] = [];

      register(bus, createStageEndRecorder('c', order, { pickupOrder: 20 }));
      register(bus, createStageEndRecorder('a', order, { pickupOrder: 5 }));
      register(bus, createStageEndRecorder('d', order, { pickupOrder: 31 }));
      register(bus, createStageEndRecorder('b', order, { pickupOrder: 12 }));
      dispatchStageEnd(bus);
      expect(order).toEqual(['a', 'b', 'c', 'd']);
    });

    it('holds a subscriber ahead of one registered before it', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const order: string[] = [];

      register(bus, createStageEndRecorder('registered-first', order, {
        pickupOrder: 100,
      }));
      register(bus, createStageEndRecorder('registered-second', order, {
        pickupOrder: 1,
      }));

      dispatchStageEnd(bus);
      expect(order).toEqual(['registered-second', 'registered-first']);
    });
  },
);

describe(
  'dispatch order is stable, so RNG consumption order is reproducible ' +
    '(AAP Contract 2, validation gate V2)',
  () => {
    it('repeats the same order across four dispatches', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const order: string[] = [];

      register(bus, createStageEndRecorder('one', order, { pickupOrder: 0 }));
      register(bus, createStageEndRecorder('two', order, { pickupOrder: 1 }));
      register(bus, createStageEndRecorder('three', order, { pickupOrder: 2 }));
      dispatchStageEnd(bus);
      dispatchStageEnd(bus);
      dispatchStageEnd(bus);
      dispatchStageEnd(bus);
      expect(order).toEqual([
        'one', 'two', 'three',
        'one', 'two', 'three',
        'one', 'two', 'three',
        'one', 'two', 'three',
      ]);
    });

    it('keeps the order after an unrelated subscriber is removed', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const order: string[] = [];

      register(bus, createStageEndRecorder('one', order, { pickupOrder: 0 }));
      register(
        bus,
        createSubscriber(
          'unrelated',
          {
            onSpawn: (): void => {
              order.push('unrelated');
            },
          },
          { pickupOrder: 1 },
        ),
      );
      register(bus, createStageEndRecorder('two', order, { pickupOrder: 2 }));
      register(bus, createStageEndRecorder('three', order, { pickupOrder: 3 }));
      dispatchStageEnd(bus);
      expect(order).toEqual(['one', 'two', 'three']);
      expect(bus.unregister('unrelated')).toBe(true);

      order.length = 0;
      dispatchStageEnd(bus);
      expect(order).toEqual(['one', 'two', 'three']);
    });

    it('draws from a substream in pickup order, so draws reproduce', () => {
      const draws: number[] = [];
      const drawer = (label: number): HookSubscriber =>
        createSubscriber(
          `drawer-${label}`,
          {
            onStageEnd: (_payload, context): void => {
              draws.push(context.rng.stream('relic-draw').next());
            },
          },
          { pickupOrder: label },
        );

      const runOnce = (): number[] => {
        const bus = createHookBus({ correlationId: CORRELATION_ID });

        register(bus, drawer(2));
        register(bus, drawer(0));
        register(bus, drawer(1));
        dispatchStageEnd(bus);

        return draws.splice(0, draws.length);
      };

      const first = runOnce();
      const second = runOnce();

      expect(first).toHaveLength(3);
      expect(second).toEqual(first);
    });
  },
);

describe('the charge guard skips a spent subscriber (AAP Contract 2)', () => {
  it('never invokes a handler whose charges are zero', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const handler = vi.fn<HookHandler<'onStageEnd'>>((): void => undefined);

    register(
      bus,
      createSubscriber('spent', { onStageEnd: handler }, { charges: 0 }),
    );

    const payload = createStageEndPayload();
    const result = dispatchStageEnd(bus, payload);

    expect(handler).not.toHaveBeenCalled();
    expect(result.invoked).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.payload).toBe(payload);
  });

  it('never invokes a handler whose charges are negative', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const handler = vi.fn<HookHandler<'onStageEnd'>>((): void => undefined);

    register(
      bus,
      createSubscriber('overdrawn', { onStageEnd: handler }, { charges: -3 }),
    );

    const result = dispatchStageEnd(bus);

    expect(handler).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it('never invokes a handler whose charges are not a number at all', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const handler = vi.fn<HookHandler<'onStageEnd'>>((): void => undefined);

    register(
      bus,
      createSubscriber(
        'unreadable',
        { onStageEnd: handler },
        { charges: Number.NaN },
      ),
    );

    expect(dispatchStageEnd(bus).skipped).toBe(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it('invokes a handler whose charges are above zero', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const order: string[] = [];

    register(bus, createStageEndRecorder('funded', order, { charges: 1 }));
    expect(dispatchStageEnd(bus).invoked).toBe(1);
    expect(order).toEqual(['funded']);
  });

  it('treats absent charges as unlimited and always fires', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const order: string[] = [];

    register(bus, createStageEndRecorder('unlimited', order));
    dispatchStageEnd(bus);
    dispatchStageEnd(bus);
    dispatchStageEnd(bus);
    expect(order).toEqual(['unlimited', 'unlimited', 'unlimited']);
    expect(bus.metrics().totals.skippedExhausted).toBe(0);
  });

  it('throws nothing when every subscriber is spent', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });

    register(
      bus,
      createSubscriber(
        'spent-a',
        {
          onStageEnd: (): void => {
            throw new Error('a spent handler must never be reached');
          },
        },
        { charges: 0, pickupOrder: 0 },
      ),
    );
    register(
      bus,
      createSubscriber(
        'spent-b',
        {
          onStageEnd: (): void => {
            throw new Error('a spent handler must never be reached');
          },
        },
        { charges: 0, pickupOrder: 1 },
      ),
    );

    const payload = createStageEndPayload();

    expect((): HookDispatchResult<'onStageEnd'> =>
      dispatchStageEnd(bus, payload),
    ).not.toThrow();

    const result = dispatchStageEnd(bus, payload);

    expect(result.payload).toBe(payload);
    expect(result.invoked).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(2);
    expect(bus.degraded()).toEqual([]);
  });

  it('leaves a spent subscriber state slot untouched', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const original = { pristine: true };
    const subscriber = createSubscriber(
      'spent-state',
      {
        onStageEnd: (_payload, context): void => {
          context.state = { pristine: false };
        },
      },
      { charges: 0, state: original },
    );

    register(bus, subscriber);
    dispatchStageEnd(bus);
    expect(subscriber.state).toBe(original);
    expect(subscriber.charges).toBe(0);
  });

  it('lets the subscribers around a spent one fire normally', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const order: string[] = [];

    register(bus, createStageEndRecorder('before', order, { pickupOrder: 0 }));
    register(
      bus,
      createSubscriber(
        'spent',
        {
          onStageEnd: (): void => {
            order.push('spent');
          },
        },
        { charges: 0, pickupOrder: 1 },
      ),
    );
    register(bus, createStageEndRecorder('after', order, { pickupOrder: 2 }));

    const result = dispatchStageEnd(bus);

    expect(order).toEqual(['before', 'after']);
    expect(result.invoked).toBe(2);
    expect(result.skipped).toBe(1);
  });

  it('skips every hook of a spent subscriber, not just one', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const board = createBoard();
    const payloads = createPayloadsByHook(board);
    const reached: string[] = [];

    register(
      bus,
      createSubscriber(
        'spent-on-both',
        {
          onMerge: (): void => {
            reached.push('onMerge');
          },
          onSpawn: (): void => {
            reached.push('onSpawn');
          },
        },
        { charges: 0 },
      ),
    );

    bus.dispatch('onMerge', payloads.onMerge, createEnvironment());
    bus.dispatch('onSpawn', payloads.onSpawn, createEnvironment());

    expect(reached).toEqual([]);
    expect(bus.metrics().totals.skippedExhausted).toBe(2);
  });

  it('withholds all six hooks from a spent subscriber, none exempt', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const board = createBoard();
    const payloads = createPayloadsByHook(board);
    const reached: HookName[] = [];
    const handlers: Record<string, HookHandler<HookName>> = {};

    for (const hook of HOOK_NAMES) {
      handlers[hook] = (): void => {
        reached.push(hook);
      };
    }

    register(
      bus,
      createSubscriber('spent-on-all', handlers as HookHandlerTable, {
        charges: 0,
      }),
    );

    // No hook is exempt, stage preparation included: an exhausted relic must
    // stop firing outright (AAP R3, V6). DL-HOOKBUS-07.
    for (const hook of HOOK_NAMES) {
      const resolved = bus.dispatch(hook, payloads[hook], createEnvironment());

      expect(resolved.invoked, `${hook} invoked`).toBe(0);
      expect(resolved.skipped, `${hook} skipped`).toBe(1);
      expect(resolved.failed, `${hook} failed`).toBe(0);
      expect(resolved.chargesConsumed, `${hook} charges`).toBe(0);
      expect(
        bus.metrics().hooks[hook].skippedExhausted,
        `${hook} exhausted counter`,
      ).toBe(1);
    }

    expect(reached).toEqual([]);
    expect(bus.metrics().totals.skippedExhausted).toBe(HOOK_NAMES.length);
    expect(bus.subscribers()[0]?.charges).toBe(0);
  });

  it('records a skipped handler as exhausted, not as failed', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });

    register(
      bus,
      createSubscriber(
        'spent',
        { onStageEnd: (): void => undefined },
        { charges: 0 },
      ),
    );

    dispatchStageEnd(bus);

    const counters: HookCounters = bus.metrics().hooks.onStageEnd;

    expect(counters.skippedExhausted).toBe(1);
    expect(counters.skippedDegraded).toBe(0);
    expect(counters.skippedDetached).toBe(0);
    expect(counters.failed).toBe(0);
    expect(counters.invoked).toBe(0);
    expect(counters.dispatched).toBe(1);
  });
});

describe(
  'one guard in the bus satisfies the zero-charge case for all sixteen ' +
    'relics, so no handler carries its own guard (AAP Contract 2)',
  () => {
    it('skips sixteen spent subscribers without invoking one', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const handlers: HookHandler<'onStageEnd'>[] = [];

      for (let index = 0; index < RELIC_CATALOGUE_SIZE; index += 1) {
        const handler = vi.fn<HookHandler<'onStageEnd'>>(
          (): void => undefined,
        );

        handlers.push(handler);
        register(
          bus,
          createSubscriber(
            `relic-${index}`,
            { onStageEnd: handler },
            { charges: 0, pickupOrder: index },
          ),
        );
      }

      const payload = createStageEndPayload();
      const result = dispatchStageEnd(bus, payload);

      for (const handler of handlers) {
        expect(handler).not.toHaveBeenCalled();
      }

      expect(handlers).toHaveLength(RELIC_CATALOGUE_SIZE);
      expect(result.invoked).toBe(0);
      expect(result.skipped).toBe(RELIC_CATALOGUE_SIZE);
      expect(result.failed).toBe(0);
      expect(result.payload).toBe(payload);
      expect(bus.degraded()).toEqual([]);
    });

    it('guards a handler that never reads charges at all', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const handler = vi.fn<HookHandler<'onStageEnd'>>(
        (payload): StageEndPayload => ({
          ...payload,
          score: payload.score + 1,
        }),
      );
      const subscriber = createSubscriber(
        'charge-blind',
        { onStageEnd: handler },
        { charges: 1 },
      );

      register(bus, subscriber);

      const first = dispatchStageEnd(bus);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(first.payload.score).toBe(STAGE_SCORE + 1);
      expect(bus.consumeCharge('charge-blind').remaining).toBe(0);

      const second = dispatchStageEnd(bus);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(second.payload.score).toBe(STAGE_SCORE);
      expect(second.skipped).toBe(1);
    });
  },
);

describe('consumeCharge is the only path that writes charges ' +
  '(AAP Contract 2)', () => {
  it('leaves charges untouched across a dispatch that invoked a handler',
    () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const subscriber = createSubscriber(
        'holds-two',
        { onStageEnd: (): void => undefined },
        { charges: 2 },
      );

      register(bus, subscriber);
      dispatchStageEnd(bus);
      dispatchStageEnd(bus);
      expect(subscriber.charges).toBe(2);
      expect(bus.metrics().chargesConsumed).toBe(0);
    });

  it('deducts one charge by default', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const subscriber = createSubscriber(
      'holds-three',
      { onStageEnd: (): void => undefined },
      { charges: 3 },
    );

    register(bus, subscriber);

    const consumption: ChargeConsumption = bus.consumeCharge('holds-three');

    expect(consumption.held).toBe(true);
    expect(consumption.limited).toBe(true);
    expect(consumption.consumed).toBe(1);
    expect(consumption.remaining).toBe(2);
    expect(Object.isFrozen(consumption)).toBe(true);

    // The bus owns the budget: it reports the deduction on its own snapshot
    // and leaves the caller's object as it was registered.
    expect(bus.subscriptions('onStageEnd')[0].charges).toBe(2);
    expect(subscriber.charges).toBe(3);
  });

  it('stops firing after exactly the charges it held are consumed', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const order: string[] = [];
    const budget = 3;

    register(bus, createStageEndRecorder('budgeted', order, {
      charges: budget,
    }));

    for (let turn = 0; turn < budget; turn += 1) {
      dispatchStageEnd(bus);
      bus.consumeCharge('budgeted');
    }

    expect(order).toEqual(['budgeted', 'budgeted', 'budgeted']);
    dispatchStageEnd(bus);
    expect(order).toHaveLength(budget);
    expect(bus.metrics().hooks.onStageEnd.skippedExhausted).toBe(1);
  });

  it('never lets a budget fall below zero', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const subscriber = createSubscriber(
      'holds-two',
      { onStageEnd: (): void => undefined },
      { charges: 2 },
    );

    register(bus, subscriber);

    const overdraw = bus.consumeCharge('holds-two', 5);

    expect(overdraw.consumed).toBe(2);
    expect(overdraw.remaining).toBe(0);
    expect(bus.subscriptions('onStageEnd')[0].charges).toBe(2 - 2);
    expect(subscriber.charges).toBe(2);
  });

  it('deducts nothing from a budget already spent', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });

    register(
      bus,
      createSubscriber(
        'spent',
        { onStageEnd: (): void => undefined },
        { charges: 0 },
      ),
    );

    const consumption = bus.consumeCharge('spent');

    expect(consumption.held).toBe(true);
    expect(consumption.limited).toBe(true);
    expect(consumption.consumed).toBe(0);
    expect(consumption.remaining).toBe(0);
  });

  it('reports a subscriber carrying no budget as unlimited', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const subscriber = createSubscriber('unlimited', {
      onStageEnd: (): void => undefined,
    });

    register(bus, subscriber);

    const consumption = bus.consumeCharge('unlimited');

    expect(consumption.held).toBe(true);
    expect(consumption.limited).toBe(false);
    expect(consumption.consumed).toBe(0);
    expect(consumption.remaining).toBeUndefined();
    expect(subscriber.charges).toBeUndefined();
  });

  it('reports an identifier that is not registered as unheld', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const consumption = bus.consumeCharge('never-registered');

    expect(consumption.held).toBe(false);
    expect(consumption.limited).toBe(false);
    expect(consumption.consumed).toBe(0);
    expect(consumption.remaining).toBeUndefined();
  });

  it('normalises a budget that is not a whole number as it writes it', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const subscriber = createSubscriber(
      'fractional',
      { onStageEnd: (): void => undefined },
      { charges: 2.7 },
    );

    register(bus, subscriber);

    const consumption = bus.consumeCharge('fractional');

    expect(consumption.consumed).toBe(1);
    expect(consumption.remaining).toBe(1);
    expect(bus.subscriptions('onStageEnd')[0].charges).toBe(1);
    expect(subscriber.charges).toBe(2.7);
  });

  it('reports every deduction on the snapshot', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });

    register(
      bus,
      createSubscriber(
        'metered',
        { onStageEnd: (): void => undefined },
        { charges: 4 },
      ),
    );

    bus.consumeCharge('metered');
    bus.consumeCharge('metered', 2);

    const metrics = bus.metrics();
    const row = metrics.subscribers[0];

    expect(metrics.chargesConsumed).toBe(3);
    expect(row.chargesConsumed).toBe(3);
    expect(row.charges).toBe(1);
  });
});

describe(
  'a throwing handler is contained, where the vanilla bus let a throw ' +
    'escape (js/keyboard_input_manager.js L25-L32)',
  () => {
    it('does not propagate a handler throw out of dispatch', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });

      register(
        bus,
        createSubscriber('thrower', {
          onStageEnd: (): StageEndPayload => {
            throw new Error('relic handler failed');
          },
        }),
      );

      expect((): HookDispatchResult<'onStageEnd'> =>
        dispatchStageEnd(bus),
      ).not.toThrow();
    });

    it('completes the turn, returning a payload and its counts', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const payload = createStageEndPayload();

      register(
        bus,
        createSubscriber('thrower', {
          onStageEnd: (): StageEndPayload => {
            throw new Error('relic handler failed');
          },
        }),
      );

      const result = dispatchStageEnd(bus, payload);

      expect(result.payload).toBe(payload);
      expect(result.invoked).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.rejected).toBe(0);
    });

    it('marks the throwing subscriber degraded', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });

      register(bus, createSubscriber('healthy', {
        onStageEnd: (): void => undefined,
      }));
      register(
        bus,
        createSubscriber('thrower', {
          onStageEnd: (): StageEndPayload => {
            throw new Error('relic handler failed');
          },
        }),
      );

      expect(bus.degraded()).toEqual([]);
      dispatchStageEnd(bus);
      expect(bus.degraded()).toEqual(['thrower']);
      expect(Object.isFrozen(bus.degraded())).toBe(true);
    });

    it('reports degraded identifiers in pickup order', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const thrower = (id: string, pickupOrder: number): HookSubscriber =>
        createSubscriber(
          id,
          {
            onStageEnd: (): StageEndPayload => {
              throw new Error(`${id} failed`);
            },
          },
          { pickupOrder },
        );

      register(bus, thrower('late-thrower', 8));
      register(bus, thrower('early-thrower', 1));
      dispatchStageEnd(bus);
      expect(bus.degraded()).toEqual(['early-thrower', 'late-thrower']);
    });

    it('keeps the last good payload when a later handler throws', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const transformed: StageEndPayload = {
        stageIndex: STAGE_INDEX,
        cleared: false,
        score: STAGE_SCORE * 2,
      };

      register(
        bus,
        createSubscriber(
          'transforms',
          { onStageEnd: (): StageEndPayload => transformed },
          { pickupOrder: 0 },
        ),
      );
      register(
        bus,
        createSubscriber(
          'thrower',
          {
            onStageEnd: (): StageEndPayload => {
              throw new Error('relic handler failed');
            },
          },
          { pickupOrder: 1 },
        ),
      );

      const original = createStageEndPayload();
      const result = dispatchStageEnd(bus, original);

      expect(result.payload).toEqual(transformed);
      expect(result.payload).not.toEqual(original);
      expect(result.payload).not.toBeUndefined();
      expect(result.failed).toBe(1);
    });

    it('fires the subscribers after a thrower, in pickup order, on the ' +
      'last good payload', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const order: string[] = [];
      const seen: StageEndPayload[] = [];
      const transformed: StageEndPayload = {
        stageIndex: STAGE_INDEX,
        cleared: true,
        score: 1,
      };

      register(
        bus,
        createSubscriber(
          'transforms',
          {
            onStageEnd: (): StageEndPayload => {
              order.push('transforms');

              return transformed;
            },
          },
          { pickupOrder: 0 },
        ),
      );
      register(
        bus,
        createSubscriber(
          'thrower',
          {
            onStageEnd: (): StageEndPayload => {
              order.push('thrower');
              throw new Error('relic handler failed');
            },
          },
          { pickupOrder: 1 },
        ),
      );
      register(
        bus,
        createSubscriber(
          'after-a',
          {
            onStageEnd: (payload): void => {
              order.push('after-a');
              seen.push(payload);
            },
          },
          { pickupOrder: 2 },
        ),
      );
      register(
        bus,
        createSubscriber(
          'after-b',
          {
            onStageEnd: (payload): void => {
              order.push('after-b');
              seen.push(payload);
            },
          },
          { pickupOrder: 3 },
        ),
      );

      const result = dispatchStageEnd(bus);

      expect(order).toEqual([
        'transforms',
        'thrower',
        'after-a',
        'after-b',
      ]);
      expect(seen).toEqual([transformed, transformed]);
      expect(result.invoked).toBe(4);
      expect(result.failed).toBe(1);
      expect(result.payload).toEqual(transformed);
    });

    it('skips a degraded subscriber on every later dispatch', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const handler = vi.fn<HookHandler<'onStageEnd'>>(
        (): StageEndPayload => {
          throw new Error('relic handler failed');
        },
      );

      register(bus, createSubscriber('thrower', { onStageEnd: handler }));

      const first = dispatchStageEnd(bus);
      const second = dispatchStageEnd(bus);
      const third = dispatchStageEnd(bus);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(first.invoked).toBe(1);
      expect(first.failed).toBe(1);
      expect(second.invoked).toBe(0);
      expect(second.skipped).toBe(1);
      expect(second.failed).toBe(0);
      expect(third.skipped).toBe(1);
      expect(bus.metrics().hooks.onStageEnd.skippedDegraded).toBe(2);
    });

    it('degrades the subscriber across every hook it bound', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const board = createBoard();
      const payloads = createPayloadsByHook(board);
      const spawn = vi.fn<HookHandler<'onSpawn'>>((): void => undefined);

      register(
        bus,
        createSubscriber('thrower', {
          onMerge: (): MergePayload => {
            throw new Error('relic handler failed');
          },
          onSpawn: spawn,
        }),
      );

      bus.dispatch('onMerge', payloads.onMerge, createEnvironment());
      bus.dispatch('onSpawn', payloads.onSpawn, createEnvironment());

      expect(spawn).not.toHaveBeenCalled();
      expect(bus.metrics().hooks.onSpawn.skippedDegraded).toBe(1);
    });

    it('still lists a degraded registration among its hook subscriptions',
      () => {
        const bus = createHookBus({ correlationId: CORRELATION_ID });

        register(
          bus,
          createSubscriber('thrower', {
            onStageEnd: (): StageEndPayload => {
              throw new Error('relic handler failed');
            },
          }),
        );

        dispatchStageEnd(bus);
        expect(
          bus.subscriptions('onStageEnd').map(
            (subscription): string => subscription.subscriberId,
          ),
        ).toEqual(['thrower']);
        expect(bus.degraded()).toEqual(['thrower']);
      });

    it('contains a thrown value that is not an Error', () => {
      const recording = createRecordingReporter();
      const bus = createHookBus({
        correlationId: CORRELATION_ID,
        reporter: recording.reporter,
      });

      register(
        bus,
        createSubscriber('throws-a-string', {
          onStageEnd: (): StageEndPayload => {
            throw 'a bare string';
          },
        }),
      );

      expect((): HookDispatchResult<'onStageEnd'> =>
        dispatchStageEnd(bus),
      ).not.toThrow();
      expect(recording.errors).toHaveLength(1);
      expect(recording.errors[0].error).toBe('a bare string');
    });

    it('works with no reporter injected at all', () => {
      const bus = createHookBus();

      register(
        bus,
        createSubscriber('thrower', {
          onStageEnd: (): StageEndPayload => {
            throw new Error('relic handler failed');
          },
        }),
      );

      expect((): HookDispatchResult<'onStageEnd'> =>
        dispatchStageEnd(bus),
      ).not.toThrow();
      expect(bus.degraded()).toEqual(['thrower']);
      expect(bus.metrics().reporterFaults).toBe(0);
    });

    it('absorbs the report into NOOP_ENGINE_REPORTER without throwing',
      () => {
        const bus = createHookBus({
          correlationId: CORRELATION_ID,
          reporter: NOOP_ENGINE_REPORTER,
        });

        register(
          bus,
          createSubscriber('thrower', {
            onStageEnd: (): StageEndPayload => {
              throw new Error('relic handler failed');
            },
          }),
        );

        expect((): HookDispatchResult<'onStageEnd'> =>
          dispatchStageEnd(bus),
        ).not.toThrow();
        expect(bus.metrics().reporterFaults).toBe(0);
        expect(bus.metrics().lastReporterFault).toBeUndefined();
        expect(bus.metrics().hooks.onStageEnd.failed).toBe(1);
      });

    it('contains a reporter that throws while receiving the report', () => {
      const bus = createHookBus({
        correlationId: CORRELATION_ID,
        reporter: {
          onHookError: (): void => {
            throw new Error('the sink itself failed');
          },
        },
      });

      register(
        bus,
        createSubscriber('thrower', {
          onStageEnd: (): StageEndPayload => {
            throw new Error('relic handler failed');
          },
        }),
      );

      expect((): HookDispatchResult<'onStageEnd'> =>
        dispatchStageEnd(bus),
      ).not.toThrow();

      const metrics = bus.metrics();

      expect(metrics.reporterFaults).toBe(1);
      expect(metrics.lastReporterFault).toBe('the sink itself failed');
      expect(bus.degraded()).toEqual(['thrower']);
    });
  },
);

describe(
  'the caught error is reported through the injected reporter and carries ' +
    'the run correlation identifier, where js/local_storage_manager.js ' +
    'L32-L39 discarded its error object (AAP §0.9.3)',
  () => {
    it('hands the caught error to the injected reporter', () => {
      const recording = createRecordingReporter();
      const bus = createHookBus({
        correlationId: CORRELATION_ID,
        reporter: recording.reporter,
      });
      const thrown = new Error('relic handler failed');

      register(
        bus,
        createSubscriber('thrower', {
          onStageEnd: (): StageEndPayload => {
            throw thrown;
          },
        }),
      );

      dispatchStageEnd(bus);
      expect(recording.errors).toHaveLength(1);

      const report: EngineHookErrorReport = recording.errors[0];

      expect(report.error).toBe(thrown);
    });

    it('carries the run correlation identifier on the report', () => {
      const recording = createRecordingReporter();
      const bus = createHookBus({
        correlationId: CORRELATION_ID,
        reporter: recording.reporter,
      });

      register(
        bus,
        createSubscriber('thrower', {
          onStageEnd: (): StageEndPayload => {
            throw new Error('relic handler failed');
          },
        }),
      );

      dispatchStageEnd(bus);

      expect(recording.errors[0].correlationId).toBe(CORRELATION_ID);
    });

    it('carries the correlation identifier of the bus that caught it', () => {
      const firstRecording = createRecordingReporter();
      const secondRecording = createRecordingReporter();
      const secondCorrelationId = 'run-hook-bus-0002';
      const thrower: HookHandlerTable = {
        onStageEnd: (): StageEndPayload => {
          throw new Error('relic handler failed');
        },
      };

      const firstBus = createHookBus({
        correlationId: CORRELATION_ID,
        reporter: firstRecording.reporter,
      });
      const secondBus = createHookBus({
        correlationId: secondCorrelationId,
        reporter: secondRecording.reporter,
      });

      register(firstBus, createSubscriber('thrower', thrower));
      register(secondBus, createSubscriber('thrower', thrower));
      dispatchStageEnd(firstBus);
      dispatchStageEnd(secondBus);

      expect(firstRecording.errors[0].correlationId).toBe(CORRELATION_ID);
      expect(secondRecording.errors[0].correlationId).toBe(secondCorrelationId);
      expect(firstRecording.errors[0].correlationId).not.toBe(
        secondRecording.errors[0].correlationId,
      );
    });

    it('names the hook and the subscriber the error came from', () => {
      const recording = createRecordingReporter();
      const bus = createHookBus({
        correlationId: CORRELATION_ID,
        reporter: recording.reporter,
      });
      const board = createBoard();
      const payloads = createPayloadsByHook(board);

      register(
        bus,
        createSubscriber('merge-thrower', {
          onMerge: (): MergePayload => {
            throw new Error('relic handler failed');
          },
        }),
      );

      bus.dispatch('onMerge', payloads.onMerge, createEnvironment());

      const report = recording.errors[0];

      expect(report.hook).toBe('onMerge');
      expect(report.subscriberId).toBe('merge-thrower');
      expect(report.correlationId).toBe(CORRELATION_ID);
    });

    it('reports one error per throw, in pickup order', () => {
      const recording = createRecordingReporter();
      const bus = createHookBus({
        correlationId: CORRELATION_ID,
        reporter: recording.reporter,
      });
      const thrower = (id: string, pickupOrder: number): HookSubscriber =>
        createSubscriber(
          id,
          {
            onStageEnd: (): StageEndPayload => {
              throw new Error(`${id} failed`);
            },
          },
          { pickupOrder },
        );

      register(bus, thrower('second-thrower', 1));
      register(bus, thrower('first-thrower', 0));
      dispatchStageEnd(bus);
      expect(
        recording.errors.map((report): string => report.subscriberId),
      ).toEqual(['first-thrower', 'second-thrower']);
      expect(
        recording.errors.every(
          (report): boolean => report.correlationId === CORRELATION_ID,
        ),
      ).toBe(true);
    });

    it('reports nothing while every handler returns normally', () => {
      const recording = createRecordingReporter();
      const bus = createHookBus({
        correlationId: CORRELATION_ID,
        reporter: recording.reporter,
      });
      const order: string[] = [];

      register(bus, createStageEndRecorder('healthy', order));
      dispatchStageEnd(bus);
      expect(recording.errors).toEqual([]);
      expect(order).toEqual(['healthy']);
    });
  },
);

describe(
  'each handler receives the payload the handler before it returned ' +
    '(AAP Contract 2)',
  () => {
    it('hands the second subscriber what the first returned', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const seen: StageEndPayload[] = [];
      const transformed: StageEndPayload = {
        stageIndex: STAGE_INDEX,
        cleared: false,
        score: 999,
      };

      register(
        bus,
        createSubscriber(
          'transforms',
          { onStageEnd: (): StageEndPayload => transformed },
          { pickupOrder: 0 },
        ),
      );
      register(
        bus,
        createSubscriber(
          'observes',
          {
            onStageEnd: (payload): void => {
              seen.push(payload);
            },
          },
          { pickupOrder: 1 },
        ),
      );

      const original = createStageEndPayload();

      bus.dispatch('onStageEnd', original, createEnvironment());

      expect(seen).toEqual([transformed]);
      expect(seen[0]).not.toBe(original);
    });

    it('compounds two onMerge subscribers in pickup order ' +
      '(js/game_manager.js L156-L170)', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const bonus = 4;
      const factor = 10;

      register(
        bus,
        createSubscriber(
          'adds-a-bonus',
          {
            onMerge: (payload): MergePayload => ({
              ...payload,
              resultValue: payload.resultValue + bonus,
            }),
          },
          { pickupOrder: 0 },
        ),
      );
      register(
        bus,
        createSubscriber(
          'multiplies',
          {
            onMerge: (payload): MergePayload => ({
              ...payload,
              resultValue: payload.resultValue * factor,
            }),
          },
          { pickupOrder: 1 },
        ),
      );

      const result = bus.dispatch(
        'onMerge',
        createMergePayload(),
        createEnvironment(),
      );

      expect(result.payload.resultValue).toBe((MERGED_VALUE + bonus) * factor);
      expect(result.invoked).toBe(2);
      expect(result.rejected).toBe(0);
    });

    it('compounds in the reverse of pickup order when picked in reverse',
      () => {
        const bus = createHookBus({ correlationId: CORRELATION_ID });
        const bonus = 4;
        const factor = 10;

        register(
          bus,
          createSubscriber(
            'multiplies',
            {
              onMerge: (payload): MergePayload => ({
                ...payload,
                resultValue: payload.resultValue * factor,
              }),
            },
            { pickupOrder: 0 },
          ),
        );
        register(
          bus,
          createSubscriber(
            'adds-a-bonus',
            {
              onMerge: (payload): MergePayload => ({
                ...payload,
                resultValue: payload.resultValue + bonus,
              }),
            },
            { pickupOrder: 1 },
          ),
        );

        const result = bus.dispatch(
          'onMerge',
          createMergePayload(),
          createEnvironment(),
        );

        expect(result.payload.resultValue).toBe(
          MERGED_VALUE * factor + bonus,
        );
      });

    it('compounds the score delta independently of the result value ' +
      '(js/game_manager.js L157, L167)', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });

      register(
        bus,
        createSubscriber(
          'doubles-the-score',
          {
            onMerge: (payload): MergePayload => ({
              ...payload,
              scoreDelta: payload.scoreDelta * 2,
            }),
          },
          { pickupOrder: 0 },
        ),
      );
      register(
        bus,
        createSubscriber(
          'doubles-it-again',
          {
            onMerge: (payload): MergePayload => ({
              ...payload,
              scoreDelta: payload.scoreDelta * 2,
            }),
          },
          { pickupOrder: 1 },
        ),
      );

      const result = bus.dispatch(
        'onMerge',
        createMergePayload(),
        createEnvironment(),
      );

      expect(result.payload.scoreDelta).toBe(MERGE_SCORE_DELTA * 4);
      expect(result.payload.resultValue).toBe(MERGED_VALUE);
    });

    it('returns the accumulated payload to the caller', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const transformed: StageEndPayload = {
        stageIndex: STAGE_INDEX,
        cleared: false,
        score: 7,
      };

      register(
        bus,
        createSubscriber('transforms', {
          onStageEnd: (): StageEndPayload => transformed,
        }),
      );

      expect(dispatchStageEnd(bus).payload).toBe(transformed);
    });

    it('leaves the payload unchanged where a handler returns nothing', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const observed: StageEndPayload[] = [];

      register(
        bus,
        createSubscriber(
          'returns-void',
          { onStageEnd: (): void => undefined },
          { pickupOrder: 0 },
        ),
      );
      register(
        bus,
        createSubscriber(
          'reads-after',
          {
            onStageEnd: (payload): void => {
              observed.push(payload);
            },
          },
          { pickupOrder: 1 },
        ),
      );

      const original = createStageEndPayload();
      const result = bus.dispatch('onStageEnd', original, createEnvironment());

      // Each handler is handed a copy, so the values carry through while the
      // caller's own object is never the object a handler held.
      expect(result.payload).toEqual(original);
      expect(observed[0]).toEqual(original);
      expect(observed[0]).not.toBe(original);
      expect(result.payload).not.toBe(original);
      expect(result.rejected).toBe(0);
      expect(result.invoked).toBe(2);
    });

    it('does not blank the payload where every handler only observes', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const order: string[] = [];

      register(bus, createStageEndRecorder('observer-a', order, {
        pickupOrder: 0,
      }));
      register(bus, createStageEndRecorder('observer-b', order, {
        pickupOrder: 1,
      }));

      const original = createStageEndPayload();
      const result = bus.dispatch('onStageEnd', original, createEnvironment());

      expect(result.payload).toEqual(original);
      expect(result.payload).not.toBeUndefined();
      expect(order).toEqual(['observer-a', 'observer-b']);
    });

    it('carries a payload mutated in place through to the caller and ' +
      'leaves the caller\'s own payload untouched', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const board = createBoard();

      register(
        bus,
        createSubscriber('mutates-in-place', {
          onBeforeMove: (payload): void => {
            payload.cancelled = true;
          },
        }),
      );

      const original = createBeforeMovePayload(board);
      const result = bus.dispatch(
        'onBeforeMove',
        original,
        createEnvironment(),
      );

      // The in-place assignment is honoured, and it reached the copy the bus
      // handed the handler: the payload the caller passed still reads as it
      // was dispatched.
      expect(result.payload.cancelled).toBe(true);
      expect(result.payload).not.toBe(original);
      expect(original.cancelled).toBe(false);

      // The board is the FACADE over the live board, carried by reference
      // through the copy: it reads what the live lattice holds, and the
      // channel a board-manipulation relic WRITES through is
      // `context.effects`.
      expect(result.payload.board).not.toBe(board);
      expect(result.payload.board.size).toBe(board.size);
      expect(result.payload.board.cellValue({ x: PAIR_X, y: PAIR_Y })).toBe(
        board.cellContent({ x: PAIR_X, y: PAIR_Y })?.value ?? null,
      );
    });

    it('carries a freshly returned object through to the caller', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const board = createBoard();

      register(
        bus,
        createSubscriber('returns-a-new-object', {
          onBeforeMove: (payload): BeforeMovePayload => ({
            ...payload,
            cancelled: true,
          }),
        }),
      );

      const original = createBeforeMovePayload(board);
      const result = bus.dispatch(
        'onBeforeMove',
        original,
        createEnvironment(),
      );

      expect(result.payload).not.toBe(original);
      expect(result.payload.cancelled).toBe(true);
      expect(original.cancelled).toBe(false);
      expect(result.payload.board.size).toBe(board.size);
      expect(result.payload.direction).toBe(DIRECTION_UP);
    });

    it('discards a return that is not a payload and keeps the payload',
      () => {
        const bus = createHookBus({ correlationId: CORRELATION_ID });
        const observed: StageEndPayload[] = [];

        register(
          bus,
          createSubscriber(
            'returns-a-number',
            {
              onStageEnd: (): StageEndPayload =>
                42 as unknown as StageEndPayload,
            },
            { pickupOrder: 0 },
          ),
        );
        register(
          bus,
          createSubscriber(
            'reads-after',
            {
              onStageEnd: (payload): void => {
                observed.push(payload);
              },
            },
            { pickupOrder: 1 },
          ),
        );

        const original = createStageEndPayload();
        const result = bus.dispatch(
          'onStageEnd',
          original,
          createEnvironment(),
        );

        expect(result.payload).toEqual(original);
        expect(observed[0]).toEqual(original);
        expect(result.rejected).toBe(1);
        expect(result.failed).toBe(0);
      });

    it('discards an array return and keeps the payload', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });

      register(
        bus,
        createSubscriber('returns-an-array', {
          onStageEnd: (): StageEndPayload => [] as unknown as StageEndPayload,
        }),
      );

      const original = createStageEndPayload();
      const result = bus.dispatch('onStageEnd', original, createEnvironment());

      expect(result.payload).toBe(original);
      expect(result.rejected).toBe(1);
      expect(bus.metrics().hooks.onStageEnd.rejected).toBe(1);
    });

    it('discards an empty object return and keeps the payload', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const observed: StageEndPayload[] = [];

      register(
        bus,
        createSubscriber(
          'returns-an-empty-object',
          {
            onStageEnd: (): StageEndPayload => ({}) as StageEndPayload,
          },
          { pickupOrder: 0 },
        ),
      );
      register(
        bus,
        createSubscriber(
          'reads-after-empty-object',
          {
            onStageEnd: (payload): void => {
              observed.push(payload);
            },
          },
          { pickupOrder: 1 },
        ),
      );

      const original = createStageEndPayload();
      const result = bus.dispatch('onStageEnd', original, createEnvironment());

      // The empty object is discarded, so every member the caller dispatched
      // still reads as it was dispatched.
      expect(result.payload).toEqual(original);
      expect(observed[0]).toEqual(original);
      expect(result.rejected).toBe(1);
      expect(result.failed).toBe(0);
      expect(bus.metrics().hooks.onStageEnd.rejected).toBe(1);
    });

    it('discards a return missing a required member', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const partial = {
        stageIndex: STAGE_INDEX,
        cleared: true,
      } as unknown as StageEndPayload;

      register(
        bus,
        createSubscriber('drops-the-score-member', {
          onStageEnd: (): StageEndPayload => partial,
        }),
      );

      const original = createStageEndPayload();
      const result = bus.dispatch('onStageEnd', original, createEnvironment());

      expect(result.payload).toBe(original);
      expect(result.payload).not.toBe(partial);
      expect(result.rejected).toBe(1);
    });

    it('discards a return whose required member is the wrong type', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const board = createBoard();
      const mistyped = {
        moved: true,
        board,
        score: 'not a number',
        over: false,
        won: false,
        terminated: false,
      } as unknown as AfterMovePayload;

      register(
        bus,
        createSubscriber('returns-a-string-score', {
          onAfterMove: (): AfterMovePayload => mistyped,
        }),
      );

      const original = createAfterMovePayload(board);
      const result = bus.dispatch('onAfterMove', original, createEnvironment());

      expect(result.payload.moved).toBe(original.moved);
      expect(result.payload.score).toBe(STAGE_SCORE);
      expect(result.rejected).toBe(1);
    });

    it('discards a foreign payload returned on onMerge', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const foreign = createStageEndPayload() as unknown as MergePayload;
      const observed: MergePayload[] = [];

      register(
        bus,
        createSubscriber(
          'returns-a-stage-end-payload',
          {
            onMerge: (): MergePayload => foreign,
          },
          { pickupOrder: 0 },
        ),
      );
      register(
        bus,
        createSubscriber(
          'reads-after-foreign-payload',
          {
            onMerge: (payload): void => {
              observed.push(payload);
            },
          },
          { pickupOrder: 1 },
        ),
      );

      const original = createMergePayload();
      const result = bus.dispatch('onMerge', original, createEnvironment());

      // The stage-end payload is discarded, so the merge payload's own members
      // survive the foreign return.
      expect(result.payload.resultValue).toBe(MERGED_VALUE);
      expect(result.payload.scoreDelta).toBe(MERGE_SCORE_DELTA);
      expect(result.payload.source.value).toBe(original.source.value);
      expect(result.payload.target.value).toBe(original.target.value);
      expect(observed[0]).toEqual(result.payload);
      expect(result.rejected).toBe(1);
    });

    it('discards a foreign payload returned on onSpawn', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const foreign = createMergePayload() as unknown as SpawnPayload;

      register(
        bus,
        createSubscriber('returns-a-merge-payload', {
          onSpawn: (): SpawnPayload => foreign,
        }),
      );

      const original = createSpawnPayload();
      const result = bus.dispatch('onSpawn', original, createEnvironment());

      expect(result.payload).toBe(original);
      expect(result.payload.value).toBe(SPAWN_VALUE);
      expect(result.rejected).toBe(1);
      expect(bus.metrics().hooks.onSpawn.rejected).toBe(1);
    });

    it('does not leak a transformation from one hook into another', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const board = createBoard();
      const payloads = createPayloadsByHook(board);
      const biasedValue = 64;

      register(
        bus,
        createSubscriber('touches-both-hooks', {
          onMerge: (payload): MergePayload => ({
            ...payload,
            resultValue: payload.resultValue * 100,
          }),
          onSpawn: (payload): SpawnPayload => ({
            ...payload,
            value: biasedValue,
          }),
        }),
      );

      const merge = bus.dispatch(
        'onMerge',
        payloads.onMerge,
        createEnvironment(),
      );
      const spawn = bus.dispatch(
        'onSpawn',
        payloads.onSpawn,
        createEnvironment(),
      );

      expect(merge.payload.resultValue).toBe(MERGED_VALUE * 100);
      expect(spawn.payload.value).toBe(biasedValue);
      expect(spawn.payload.position).toEqual(
        payloads.onSpawn.position,
      );
      expect(spawn.payload).not.toHaveProperty('resultValue');
    });

    it('starts each dispatch from the payload it was handed', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });

      register(
        bus,
        createSubscriber('adds-one', {
          onStageEnd: (payload): StageEndPayload => ({
            ...payload,
            score: payload.score + 1,
          }),
        }),
      );

      const first = dispatchStageEnd(bus);
      const second = dispatchStageEnd(bus);

      expect(first.payload.score).toBe(STAGE_SCORE + 1);
      expect(second.payload.score).toBe(STAGE_SCORE + 1);
    });
  },
);

describe(
  'dispatch adopts a return only where it is the hook\'s payload exactly ' +
    '(AAP Contract 2)',
  () => {
    it('rejects a return that omits a declared member', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });

      register(
        bus,
        createSubscriber('drops-cleared', {
          onStageEnd: (payload): StageEndPayload =>
            ({
              stageIndex: payload.stageIndex,
              score: payload.score,
            }) as unknown as StageEndPayload,
        }),
      );

      const original = createStageEndPayload();
      const result = bus.dispatch('onStageEnd', original, createEnvironment());

      expect(result.rejected).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.payload).toEqual(original);
    });

    it('rejects a return that carries a member the payload does not ' +
      'declare', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });

      register(
        bus,
        createSubscriber('widens-the-payload', {
          onStageEnd: (payload): StageEndPayload =>
            ({ ...payload, smuggled: true }) as unknown as StageEndPayload,
        }),
      );

      const original = createStageEndPayload();
      const result = bus.dispatch('onStageEnd', original, createEnvironment());

      expect(result.rejected).toBe(1);
      expect(result.payload).toEqual(original);
    });

    it('rejects a return whose members are out of range or not finite',
      () => {
        const cases: readonly [string, HookHandlerTable][] = [
          [
            'not-a-number-score',
            {
              onStageEnd: (payload): StageEndPayload => ({
                ...payload,
                score: Number.NaN,
              }),
            },
          ],
          [
            'negative-stage-index',
            {
              onStageEnd: (payload): StageEndPayload => ({
                ...payload,
                stageIndex: -1,
              }),
            },
          ],
          [
            'not-a-boolean-cleared',
            {
              onStageEnd: (payload): StageEndPayload => ({
                ...payload,
                cleared: 'yes' as unknown as boolean,
              }),
            },
          ],
        ];

        for (const [id, hooks] of cases) {
          const bus = createHookBus({ correlationId: CORRELATION_ID });

          register(bus, createSubscriber(id, hooks));

          const original = createStageEndPayload();
          const result = bus.dispatch(
            'onStageEnd',
            original,
            createEnvironment(),
          );

          expect(result.rejected, id).toBe(1);
          expect(result.payload, id).toEqual(original);
        }
      });

    it('rejects a spawn position outside the live board and a value that ' +
      'is not positive', () => {
      const outside = createHookBus({ correlationId: CORRELATION_ID });

      register(
        outside,
        createSubscriber('spawns-off-board', {
          onSpawn: (payload): SpawnPayload => ({
            ...payload,
            position: { x: BOARD_SIZE, y: 0 },
          }),
        }),
      );

      const offBoard = outside.dispatch(
        'onSpawn',
        createSpawnPayload(),
        createEnvironment(),
      );

      expect(offBoard.rejected).toBe(1);
      expect(offBoard.payload.position).toEqual({
        x: PAIR_NEXT_X,
        y: PAIR_NEXT_X,
      });

      const zeroValue = createHookBus({ correlationId: CORRELATION_ID });

      register(
        zeroValue,
        createSubscriber('spawns-nothing', {
          onSpawn: (payload): SpawnPayload => ({ ...payload, value: 0 }),
        }),
      );

      const spawned = zeroValue.dispatch(
        'onSpawn',
        createSpawnPayload(),
        createEnvironment(),
      );

      expect(spawned.rejected).toBe(1);
      expect(spawned.payload.value).toBe(SPAWN_VALUE);
    });

    it('accepts a spawn that suppresses itself by dropping the position',
      () => {
        const bus = createHookBus({ correlationId: CORRELATION_ID });

        register(
          bus,
          createSubscriber('suppresses-the-spawn', {
            onSpawn: (payload): SpawnPayload => ({ value: payload.value }),
          }),
        );

        const result = bus.dispatch(
          'onSpawn',
          createSpawnPayload(),
          createEnvironment(),
        );

        expect(result.rejected).toBe(0);
        expect(result.payload.position).toBeUndefined();
        expect(result.payload.value).toBe(SPAWN_VALUE);
      });

    it('rejects a substituted board on onBeforeMove and onAfterMove', () => {
      const board = createBoard();
      const foreign = createForeignGridView();

      const before = createHookBus({ correlationId: CORRELATION_ID });
      const beforeSeen: { board: BeforeMovePayload['board'] | null } = {
        board: null,
      };

      register(
        before,
        createSubscriber('swaps-the-board', {
          onBeforeMove: (payload): BeforeMovePayload => {
            beforeSeen.board = payload.board;

            return { ...payload, board: foreign };
          },
        }),
      );

      const beforePayload = createBeforeMovePayload(board);
      const beforeResult = before.dispatch(
        'onBeforeMove',
        beforePayload,
        createEnvironment(),
      );

      expect(beforeResult.rejected).toBe(1);
      expect(beforeResult.payload.board).not.toBe(foreign);
      expect(beforeResult.payload.board).toBe(beforeSeen.board);

      const after = createHookBus({ correlationId: CORRELATION_ID });
      const afterSeen: { board: AfterMovePayload['board'] | null } = {
        board: null,
      };

      register(
        after,
        createSubscriber('swaps-the-board', {
          onAfterMove: (payload): AfterMovePayload => {
            afterSeen.board = payload.board;

            return { ...payload, board: foreign };
          },
        }),
      );

      const afterPayload = createAfterMovePayload(board);
      const afterResult = after.dispatch(
        'onAfterMove',
        afterPayload,
        createEnvironment(),
      );

      expect(afterResult.rejected).toBe(1);
      expect(afterResult.payload.board).not.toBe(foreign);
      expect(afterResult.payload.board).toBe(afterSeen.board);
    });

    it('rejects a substituted tile on onMerge', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const foreign = new Tile({ x: PAIR_X, y: PAIR_Y }, PAIR_VALUE);
      const original = createMergePayload();
      const seen: { payload: MergePayload | null } = { payload: null };

      register(
        bus,
        createSubscriber('swaps-the-source', {
          onMerge: (payload): MergePayload => {
            seen.payload = payload;

            return { ...payload, source: foreign };
          },
        }),
      );

      const result = bus.dispatch('onMerge', original, createEnvironment());

      expect(result.rejected).toBe(1);
      expect(seen.payload).not.toBeNull();
      expect(result.payload.source).toBe(seen.payload?.source);
      expect(result.payload.target).toBe(seen.payload?.target);
    });

    it('hands handlers facades that read the live board and the live merged ' +
      'tiles', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const board = createBoard();
      const original = createMergePayload();
      const seen: {
        merge: MergePayload | null;
        board: BeforeMovePayload['board'] | null;
      } = { merge: null, board: null };

      register(
        bus,
        createSubscriber('reads-only', {
          onMerge: (payload): void => {
            seen.merge = payload;
          },
          onBeforeMove: (payload): void => {
            seen.board = payload.board;
          },
        }),
      );

      const environment: HookEnvironment = {
        config: createDefaultRulesConfig(),
        rng: createRngStreams(RUN_SEED),
        grid: board,
      };

      bus.dispatch('onMerge', original, createEnvironment());
      bus.dispatch('onBeforeMove', createBeforeMovePayload(board), environment);

      const merge = seen.merge;

      // AAP Contract 1, as the adopted projection expresses it: the facades
      // read the live tiles, member for member, and carry no writer.
      expect(merge?.source).not.toBe(original.source);
      expect(merge?.target).not.toBe(original.target);
      expect(merge?.source.x).toBe(PAIR_X);
      expect(merge?.source.y).toBe(PAIR_Y);
      expect(merge?.source.value).toBe(PAIR_VALUE);
      expect(merge?.source.previousPosition).toEqual({
        x: PAIR_NEXT_X,
        y: PAIR_Y,
      });
      const carried = seen.board as unknown as Record<string, unknown>;

      expect(carried).not.toBe(board);
      expect(Object.isFrozen(carried)).toBe(true);
      expect(carried['insertTile']).toBeUndefined();
      expect(carried['removeTile']).toBeUndefined();
      expect(carried['cells']).toBeUndefined();
      expect(seen.board?.cellValue({ x: PAIR_X, y: PAIR_Y })).toBe(PAIR_VALUE);

      board.removeTile(new Tile({ x: PAIR_X, y: PAIR_Y }, PAIR_VALUE));

      expect(seen.board?.cellValue({ x: PAIR_X, y: PAIR_Y })).toBeNull();
    });

    it('rejects a stage start that misreports the board it began on', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });

      register(
        bus,
        createSubscriber('misreports-the-size', {
          onStageStart: (payload): StageStartPayload => ({
            ...payload,
            boardSize: HUGE_BOARD_SIZE,
          }),
        }),
      );

      const original = createStageStartPayload();
      const result = bus.dispatch(
        'onStageStart',
        original,
        createEnvironment(),
      );

      expect(result.rejected).toBe(1);
      expect(result.payload.boardSize).toBe(BOARD_SIZE);
    });

    it('rejects a stage goal whose kind is not one the ladder declares', () => {
      // `evaluateStageGoal` narrows on `kind` and raises on one it cannot, so a
      // kind admitted here throws later — on a stage that has already started.
      const bus = createHookBus({ correlationId: CORRELATION_ID });

      register(
        bus,
        createSubscriber('invents-a-kind', {
          onStageStart: (payload): StageStartPayload => ({
            ...payload,
            goal: { kind: 'tiles-cleared', target: 4 } as unknown as
              StageStartPayload['goal'],
          }),
        }),
      );

      const original = createStageStartPayload();
      const result = bus.dispatch(
        'onStageStart',
        original,
        createEnvironment(),
      );

      expect(result.rejected).toBe(1);
      expect(result.payload.goal).toEqual(original.goal);
    });

    it('accepts every kind the ladder does declare', () => {
      for (const kind of STAGE_GOAL_KINDS) {
        const bus = createHookBus({ correlationId: CORRELATION_ID });

        register(
          bus,
          createSubscriber(`adopts-${kind}`, {
            onStageStart: (payload): StageStartPayload => ({
              ...payload,
              goal: { kind, target: REPLACED_GOAL_TARGET },
            }),
          }),
        );

        const result = bus.dispatch(
          'onStageStart',
          createStageStartPayload(),
          createEnvironment(),
        );

        expect(result.rejected).toBe(0);
        expect(result.payload.goal).toEqual({
          kind,
          target: REPLACED_GOAL_TARGET,
        });
      }
    });

    it('rejects a stage start that renumbers the stage, and the next handler ' +
      'reads the index the engine opened', () => {
      // `stageIndex` is invariant on `onStageStart`: `goal` alone is
      // transformable. A renumbered index used to be adopted, so the stage the
      // engine reported starting was not the stage it was on.
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const seen: number[] = [];

      register(
        bus,
        createSubscriber(
          'renumbers-the-stage',
          {
            onStageStart: (payload): StageStartPayload => ({
              ...payload,
              stageIndex: payload.stageIndex + 1,
            }),
          },
          { pickupOrder: 0 },
        ),
      );
      register(
        bus,
        createSubscriber(
          'reads-the-stage',
          {
            onStageStart: (payload): void => {
              seen.push(payload.stageIndex);
            },
          },
          { pickupOrder: 1 },
        ),
      );

      const result = bus.dispatch(
        'onStageStart',
        createStageStartPayload(),
        createEnvironment(),
      );

      expect(result.rejected).toBe(1);
      expect(result.payload.stageIndex).toBe(STAGE_INDEX);
      expect(seen).toEqual([STAGE_INDEX]);
    });

    it('rejects a stage end that renumbers the stage, and the next handler ' +
      'reads the index the engine resolved', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const seen: number[] = [];

      register(
        bus,
        createSubscriber(
          'renumbers-the-end',
          {
            onStageEnd: (payload): StageEndPayload => ({
              ...payload,
              stageIndex: payload.stageIndex + 2,
              cleared: false,
            }),
          },
          { pickupOrder: 0 },
        ),
      );
      register(
        bus,
        createSubscriber(
          'reads-the-end',
          {
            onStageEnd: (payload): void => {
              seen.push(payload.stageIndex);
            },
          },
          { pickupOrder: 1 },
        ),
      );

      const original = createStageEndPayload();
      const result = bus.dispatch('onStageEnd', original, createEnvironment());

      // The whole return is refused, so the transformable `cleared` it carried
      // is refused with the invariant it broke.
      expect(result.rejected).toBe(1);
      expect(result.payload.stageIndex).toBe(STAGE_INDEX);
      expect(result.payload.cleared).toBe(original.cleared);
      expect(seen).toEqual([STAGE_INDEX]);
    });

    it('rejects an after-move return that writes the terminated flag, and the ' +
      'next handler reads the truthful one', () => {
      // The engine DERIVES `terminated` after this dispatch, so a handler that
      // wrote it changed nothing the engine used while every later handler read
      // the untruthful value.
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const board = createBoard();
      const seen: boolean[] = [];

      register(
        bus,
        createSubscriber(
          'writes-terminated',
          {
            onAfterMove: (payload): AfterMovePayload => ({
              ...payload,
              terminated: true,
              score: payload.score + 1,
            }),
          },
          { pickupOrder: 0 },
        ),
      );
      register(
        bus,
        createSubscriber(
          'reads-terminated',
          {
            onAfterMove: (payload): void => {
              seen.push(payload.terminated);
            },
          },
          { pickupOrder: 1 },
        ),
      );

      const original = createAfterMovePayload(board);
      const result = bus.dispatch('onAfterMove', original, createEnvironment());

      expect(result.rejected).toBe(1);
      expect(result.payload.terminated).toBe(false);
      expect(result.payload.score).toBe(original.score);
      expect(seen).toEqual([false]);
    });

    it('still adopts the after-move members that are transformable', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const board = createBoard();

      register(
        bus,
        createSubscriber('rescores', {
          onAfterMove: (payload): AfterMovePayload => ({
            ...payload,
            score: payload.score + REPLACED_GOAL_TARGET,
            over: true,
            won: true,
          }),
        }),
      );

      const original = createAfterMovePayload(board);
      const result = bus.dispatch('onAfterMove', original, createEnvironment());

      expect(result.rejected).toBe(0);
      expect(result.payload.score).toBe(original.score + REPLACED_GOAL_TARGET);
      expect(result.payload.over).toBe(true);
      expect(result.payload.won).toBe(true);
      expect(result.payload.terminated).toBe(original.terminated);
    });

    it('rolls back an in-place mutation made by a handler that then throws',
      () => {
        const bus = createHookBus({ correlationId: CORRELATION_ID });
        const board = createBoard();
        const seen: boolean[] = [];

        register(
          bus,
          createSubscriber(
            'vetoes-then-throws',
            {
              onBeforeMove: (payload): BeforeMovePayload => {
                payload.cancelled = true;
                throw new Error('relic handler failed');
              },
            },
            { pickupOrder: 0 },
          ),
        );
        register(
          bus,
          createSubscriber(
            'reads-after',
            {
              onBeforeMove: (payload): void => {
                seen.push(payload.cancelled);
              },
            },
            { pickupOrder: 1 },
          ),
        );

        const original = createBeforeMovePayload(board);
        const result = bus.dispatch(
          'onBeforeMove',
          original,
          createEnvironment(),
        );

        expect(result.failed).toBe(1);
        expect(seen).toEqual([false]);
        expect(result.payload.cancelled).toBe(false);
        expect(original.cancelled).toBe(false);
      });

    it('leaves no board mutation behind when a handler records a command and ' +
      'then throws', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const board = createBoard();
      register(
        bus,
        createSubscriber('mutates-the-board-then-throws', {
          onBeforeMove: (_payload, context): BeforeMovePayload => {
            context.effects.removeTile({ x: PAIR_X, y: PAIR_Y });

            throw new Error('relic handler failed after writing');
          },
        }),
      );

      const result = bus.dispatch(
        'onBeforeMove',
        createBeforeMovePayload(board),
        createEnvironment(),
      );

      // Nothing recorded reached the board. The commands are held per handler
      // and written only once that handler's return has been accepted, so a
      // handler that records and then throws leaves the lattice exactly as it
      // stood — and is marked degraded, so it is never dispatched to again.
      expect(result.failed).toBe(1);
      expect(result.effectsApplied).toBe(0);
      expect(board.cellContent({ x: PAIR_X, y: PAIR_Y })).not.toBeNull();
      expect(bus.degraded()).toContain('mutates-the-board-then-throws');
    });

    it('leaves no tile mutation behind when a handler writes at the merge ' +
      'payload and then throws', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const original = createMergePayload();
      const sourceValue = original.source.value;
      const targetX = original.target.x;

      register(
        bus,
        createSubscriber('mutates-a-tile-then-throws', {
          onMerge: (payload): MergePayload => {
            const reachable = payload.source as unknown as Record<
              string,
              unknown
            >;

            reachable.value = sourceValue * 4;
            (payload.target as unknown as Record<string, unknown>).x =
              targetX + 1;

            throw new Error('relic handler failed after writing');
          },
        }),
      );

      const result = bus.dispatch('onMerge', original, createEnvironment());

      expect(result.failed).toBe(1);

      expect(original.source.value).toBe(sourceValue);
      expect(original.target.x).toBe(targetX);
      expect(bus.degraded()).toContain('mutates-a-tile-then-throws');
    });

    it('adopts a successful in-place mutation, compounds it and still ' +
      'leaves the caller\'s payload untouched', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const board = createBoard();
      const seen: boolean[] = [];

      register(
        bus,
        createSubscriber(
          'vetoes',
          {
            onBeforeMove: (payload): void => {
              payload.cancelled = true;
            },
          },
          { pickupOrder: 0 },
        ),
      );
      register(
        bus,
        createSubscriber(
          'reads-after',
          {
            onBeforeMove: (payload): void => {
              seen.push(payload.cancelled);
            },
          },
          { pickupOrder: 1 },
        ),
      );

      const original = createBeforeMovePayload(board);
      const result = bus.dispatch(
        'onBeforeMove',
        original,
        createEnvironment(),
      );

      // The mutation is adopted and compounds into the next handler's payload,
      // while the payload the caller built still reads as it was dispatched.
      expect(seen).toEqual([true]);
      expect(result.payload.cancelled).toBe(true);
      expect(original.cancelled).toBe(false);
    });
  },
);

describe(
  'a subscriber vetoes a move on the onBeforeMove payload ' +
    '(js/game_manager.js L134)',
  () => {
    it('dispatches onBeforeMove with the veto unset', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const board = createBoard();
      const seen: BeforeMovePayload[] = [];

      register(
        bus,
        createSubscriber('reads-the-veto', {
          onBeforeMove: (payload): void => {
            seen.push(payload);
          },
        }),
      );

      bus.dispatch(
        'onBeforeMove',
        createBeforeMovePayload(board),
        createEnvironment(),
      );

      expect(seen[0].cancelled).toBe(false);
    });

    it('shows a veto set in place on the payload dispatch returns', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const board = createBoard();

      register(
        bus,
        createSubscriber('vetoes', {
          onBeforeMove: (payload): void => {
            payload.cancelled = true;
          },
        }),
      );

      const result = bus.dispatch(
        'onBeforeMove',
        createBeforeMovePayload(board),
        createEnvironment(),
      );

      expect(result.payload.cancelled).toBe(true);
    });

    it('shows a veto returned on a fresh payload dispatch returns', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const board = createBoard();

      register(
        bus,
        createSubscriber('vetoes', {
          onBeforeMove: (payload): BeforeMovePayload => ({
            ...payload,
            cancelled: true,
          }),
        }),
      );

      const original = createBeforeMovePayload(board);
      const result = bus.dispatch(
        'onBeforeMove',
        original,
        createEnvironment(),
      );

      expect(result.payload.cancelled).toBe(true);
      expect(result.payload.direction).toBe(DIRECTION_UP);

      expect(result.payload.board).not.toBe(board);
      expect(result.payload.board.size).toBe(BOARD_SIZE);
      expect(Object.isFrozen(result.payload.board)).toBe(true);
    });

    it('keeps a veto set by an early subscriber past later ones that do ' +
      'not clear it', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const board = createBoard();
      const seen: boolean[] = [];

      register(
        bus,
        createSubscriber(
          'vetoes',
          {
            onBeforeMove: (payload): void => {
              payload.cancelled = true;
            },
          },
          { pickupOrder: 0 },
        ),
      );
      register(
        bus,
        createSubscriber(
          'observes',
          {
            onBeforeMove: (payload): void => {
              seen.push(payload.cancelled);
            },
          },
          { pickupOrder: 1 },
        ),
      );
      register(
        bus,
        createSubscriber(
          'transforms-another-member',
          {
            onBeforeMove: (payload): BeforeMovePayload => ({
              ...payload,
              direction: DIRECTION_RIGHT,
            }),
          },
          { pickupOrder: 2 },
        ),
      );

      const result = bus.dispatch(
        'onBeforeMove',
        createBeforeMovePayload(board),
        createEnvironment(),
      );

      expect(seen).toEqual([true]);
      expect(result.payload.cancelled).toBe(true);
      expect(result.payload.direction).toBe(DIRECTION_RIGHT);
    });

    it('lets a later subscriber clear a veto, since the bus ranks no ' +
      'subscriber above another', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const board = createBoard();

      register(
        bus,
        createSubscriber(
          'vetoes',
          {
            onBeforeMove: (payload): BeforeMovePayload => ({
              ...payload,
              cancelled: true,
            }),
          },
          { pickupOrder: 0 },
        ),
      );
      register(
        bus,
        createSubscriber(
          'clears-the-veto',
          {
            onBeforeMove: (payload): BeforeMovePayload => ({
              ...payload,
              cancelled: false,
            }),
          },
          { pickupOrder: 1 },
        ),
      );

      const result = bus.dispatch(
        'onBeforeMove',
        createBeforeMovePayload(board),
        createEnvironment(),
      );

      expect(result.payload.cancelled).toBe(false);
    });

    it('keeps a veto that a throwing later subscriber never cleared', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const board = createBoard();

      register(
        bus,
        createSubscriber(
          'vetoes',
          {
            onBeforeMove: (payload): void => {
              payload.cancelled = true;
            },
          },
          { pickupOrder: 0 },
        ),
      );
      register(
        bus,
        createSubscriber(
          'thrower',
          {
            onBeforeMove: (): BeforeMovePayload => {
              throw new Error('relic handler failed');
            },
          },
          { pickupOrder: 1 },
        ),
      );

      const result = bus.dispatch(
        'onBeforeMove',
        createBeforeMovePayload(board),
        createEnvironment(),
      );

      expect(result.payload.cancelled).toBe(true);
      expect(result.failed).toBe(1);
      expect(bus.degraded()).toEqual(['thrower']);
    });

    it('leaves the veto unset where no subscriber sets it', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const board = createBoard();
      const order: string[] = [];

      register(
        bus,
        createSubscriber('observes', {
          onBeforeMove: (): void => {
            order.push('observes');
          },
        }),
      );

      const result = bus.dispatch(
        'onBeforeMove',
        createBeforeMovePayload(board),
        createEnvironment(),
      );

      expect(result.payload.cancelled).toBe(false);
      expect(order).toEqual(['observes']);
    });

    it('never reaches a spent subscriber that would have vetoed', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const board = createBoard();

      register(
        bus,
        createSubscriber(
          'spent-vetoer',
          {
            onBeforeMove: (payload): void => {
              payload.cancelled = true;
            },
          },
          { charges: 0 },
        ),
      );

      const result = bus.dispatch(
        'onBeforeMove',
        createBeforeMovePayload(board),
        createEnvironment(),
      );

      expect(result.payload.cancelled).toBe(false);
      expect(result.skipped).toBe(1);
    });
  },
);

describe(
  'metrics reports dispatch counts per hook and per subscriber as plain ' +
    'data, reachable without any observability import (AAP §0.9.3)',
  () => {
    it('carries a row for each of the six names, dispatched or not', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });

      dispatchStageEnd(bus);

      const metrics = bus.metrics();

      expect(Object.keys(metrics.hooks)).toEqual([...EXPECTED_HOOK_NAMES]);
      expect(metrics.hooks.onStageEnd.dispatched).toBe(1);
      expect(metrics.hooks.onMerge.dispatched).toBe(0);
      expect(metrics.hooks.onSpawn.dispatched).toBe(0);
    });

    it('counts one dispatch per hook, per call', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const board = createBoard();
      const payloads = createPayloadsByHook(board);

      bus.dispatch('onMerge', payloads.onMerge, createEnvironment());
      bus.dispatch('onMerge', payloads.onMerge, createEnvironment());
      bus.dispatch('onSpawn', payloads.onSpawn, createEnvironment());

      const metrics = bus.metrics();

      expect(metrics.hooks.onMerge.dispatched).toBe(2);
      expect(metrics.hooks.onSpawn.dispatched).toBe(1);
      expect(metrics.totals.dispatched).toBe(3);
    });

    it('counts one invocation per handler that ran', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const order: string[] = [];

      register(bus, createStageEndRecorder('one', order, { pickupOrder: 0 }));
      register(bus, createStageEndRecorder('two', order, { pickupOrder: 1 }));
      dispatchStageEnd(bus);
      dispatchStageEnd(bus);

      const metrics = bus.metrics();

      expect(metrics.hooks.onStageEnd.invoked).toBe(4);
      expect(metrics.totals.invoked).toBe(4);
      expect(metrics.subscribers[0].invoked).toBe(2);
      expect(metrics.subscribers[1].invoked).toBe(2);
    });

    it('separates a skipped dispatch from a failed one', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });

      register(
        bus,
        createSubscriber(
          'spent',
          { onStageEnd: (): void => undefined },
          { charges: 0, pickupOrder: 0 },
        ),
      );
      register(
        bus,
        createSubscriber(
          'thrower',
          {
            onStageEnd: (): StageEndPayload => {
              throw new Error('relic handler failed');
            },
          },
          { pickupOrder: 1 },
        ),
      );

      dispatchStageEnd(bus);

      const counters = bus.metrics().hooks.onStageEnd;

      expect(counters.skippedExhausted).toBe(1);
      expect(counters.failed).toBe(1);
      expect(counters.invoked).toBe(1);
      expect(counters.skippedDegraded).toBe(0);
      expect(counters.skippedDetached).toBe(0);
      dispatchStageEnd(bus);

      const later = bus.metrics().hooks.onStageEnd;

      expect(later.skippedExhausted).toBe(2);
      expect(later.skippedDegraded).toBe(1);
      expect(later.failed).toBe(1);
      expect(later.invoked).toBe(1);
    });

    it('counts a handler that threw as both invoked and failed', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });

      register(
        bus,
        createSubscriber('thrower', {
          onStageEnd: (): StageEndPayload => {
            throw new Error('relic handler failed');
          },
        }),
      );

      dispatchStageEnd(bus);

      const row: HookSubscriberMetrics = bus.metrics().subscribers[0];

      expect(row.invoked).toBe(1);
      expect(row.failed).toBe(1);
      expect(row.degraded).toBe(true);
      expect(row.registered).toBe(true);
    });

    it('attributes each count to the subscriber it belongs to', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const order: string[] = [];

      register(bus, createStageEndRecorder('healthy', order, {
        pickupOrder: 0,
      }));
      register(
        bus,
        createSubscriber(
          'thrower',
          {
            onStageEnd: (): StageEndPayload => {
              throw new Error('relic handler failed');
            },
          },
          { pickupOrder: 1 },
        ),
      );
      register(
        bus,
        createSubscriber(
          'spent',
          { onStageEnd: (): void => undefined },
          { charges: 0, pickupOrder: 2 },
        ),
      );

      dispatchStageEnd(bus);

      const rows = bus.metrics().subscribers;

      expect(rows.map((row): string => row.id)).toEqual([
        'healthy',
        'thrower',
        'spent',
      ]);
      expect(rows[0].invoked).toBe(1);
      expect(rows[0].failed).toBe(0);
      expect(rows[1].failed).toBe(1);
      expect(rows[1].skippedExhausted).toBe(0);
      expect(rows[2].skippedExhausted).toBe(1);
      expect(rows[2].invoked).toBe(0);
    });

    it('orders the subscriber rows by pickup order', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const order: string[] = [];

      register(bus, createStageEndRecorder('late', order, {
        pickupOrder: 40,
      }));
      register(bus, createStageEndRecorder('early', order, {
        pickupOrder: 2,
      }));

      expect(
        bus.metrics().subscribers.map((row): string => row.id),
      ).toEqual(['early', 'late']);
      expect(
        bus.metrics().subscribers.map((row): number => row.pickupOrder),
      ).toEqual([2, 40]);
    });

    it('counts nothing against a subscriber not bound to the hook', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const board = createBoard();
      const payloads = createPayloadsByHook(board);

      register(
        bus,
        createSubscriber('merge-only', {
          onMerge: (): void => undefined,
        }),
      );

      bus.dispatch('onSpawn', payloads.onSpawn, createEnvironment());

      const metrics = bus.metrics();

      expect(metrics.hooks.onSpawn.dispatched).toBe(1);
      expect(metrics.hooks.onSpawn.invoked).toBe(0);
      expect(metrics.hooks.onSpawn.skippedExhausted).toBe(0);
      expect(metrics.hooks.onSpawn.skippedDetached).toBe(0);
      expect(metrics.subscribers[0].invoked).toBe(0);
    });

    it('keeps a row after its subscriber is removed', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const order: string[] = [];

      register(bus, createStageEndRecorder('transient', order));
      dispatchStageEnd(bus);
      expect(bus.unregister('transient')).toBe(true);

      const row = bus.metrics().subscribers[0];

      expect(row.id).toBe('transient');
      expect(row.registered).toBe(false);
      expect(row.invoked).toBe(1);
      expect(row.charges).toBeUndefined();
    });

    it('reports registration and removal counts', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const order: string[] = [];

      register(bus, createStageEndRecorder('kept', order));
      register(bus, createStageEndRecorder('removed', order));
      expect(bus.register(createStageEndRecorder('kept', order))).toBe(false);
      expect(bus.unregister('removed')).toBe(true);

      const metrics = bus.metrics();

      expect(metrics.registered).toBe(1);
      expect(metrics.acceptedRegistrations).toBe(2);
      expect(metrics.rejectedRegistrations).toBe(1);
      expect(metrics.removedSubscribers).toBe(1);
    });

    it('is plain frozen data, built fresh on each call', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const order: string[] = [];

      register(bus, createStageEndRecorder('counted', order));
      dispatchStageEnd(bus);

      const first = bus.metrics();

      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.hooks)).toBe(true);
      expect(Object.isFrozen(first.totals)).toBe(true);
      expect(Object.isFrozen(first.subscribers)).toBe(true);
      expect(Object.isFrozen(first.degraded)).toBe(true);
      expect(JSON.parse(JSON.stringify(first))).toBeTruthy();
      dispatchStageEnd(bus);

      const second = bus.metrics();

      expect(second).not.toBe(first);
      expect(first.totals.dispatched).toBe(1);
      expect(second.totals.dispatched).toBe(2);
    });

    it('lists the degraded identifiers on the snapshot', () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });

      register(
        bus,
        createSubscriber('thrower', {
          onStageEnd: (): StageEndPayload => {
            throw new Error('relic handler failed');
          },
        }),
      );

      dispatchStageEnd(bus);
      expect(bus.metrics().degraded).toEqual(['thrower']);
    });

    it('reports every count through the injected reporter as well', () => {
      const recording = createRecordingReporter();
      const bus = createHookBus({
        correlationId: CORRELATION_ID,
        reporter: recording.reporter,
      });
      const order: string[] = [];

      register(bus, createStageEndRecorder('counted', order, { charges: 2 }));
      dispatchStageEnd(bus);
      bus.consumeCharge('counted', 2);
      dispatchStageEnd(bus);

      const names = recording.counts.map(
        (report: EngineCountReport): string => report.metric,
      );

      expect(names).toContain('engine.hook.dispatch');
      expect(names).toContain('engine.hook.handler');
      expect(names).toContain('engine.hook.exhausted');
      expect(names).toContain('engine.hook.charge.consumed');
      expect(
        recording.counts.every(
          (report): boolean => report.correlationId === CORRELATION_ID,
        ),
      ).toBe(true);
      expect(
        recording.counts.find(
          (report): boolean => report.metric === 'engine.hook.dispatch',
        )?.hook,
      ).toBe('onStageEnd');
    });

    it('names the three skip reasons the counters separate', () => {
      const reasons: readonly HookSkipReason[] = [
        'exhausted',
        'degraded',
        'detached',
      ];
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const counters = bus.metrics().hooks.onStageEnd;

      expect(reasons).toHaveLength(3);
      expect(counters.skippedExhausted).toBe(0);
      expect(counters.skippedDegraded).toBe(0);
      expect(counters.skippedDetached).toBe(0);
    });
  },
);

describe('register and unregister (js/keyboard_input_manager.js L18-L23, ' +
  'AAP Contract 2)', () => {
  it('takes on a subscriber and reports it registered', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const order: string[] = [];

    expect(bus.register(createStageEndRecorder('taken-on', order))).toBe(true);
    expect(
      bus.subscribers().map((subscriber): string => subscriber.id),
    ).toEqual(['taken-on']);
    expect(bus.metrics().registered).toBe(1);
  });

  it('removes a subscriber and never invokes it again', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const handler = vi.fn<HookHandler<'onStageEnd'>>((): void => undefined);

    register(bus, createSubscriber('removable', { onStageEnd: handler }));
    dispatchStageEnd(bus);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(bus.unregister('removable')).toBe(true);

    const payload = createStageEndPayload();

    expect((): HookDispatchResult<'onStageEnd'> =>
      dispatchStageEnd(bus, payload),
    ).not.toThrow();

    const result = dispatchStageEnd(bus, payload);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.invoked).toBe(0);
    expect(result.payload).toBe(payload);
    expect(bus.subscribers()).toEqual([]);
    expect(bus.subscriptions('onStageEnd')).toEqual([]);
  });

  it('reports a repeated removal as removing nothing', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const order: string[] = [];

    register(bus, createStageEndRecorder('removable', order));
    expect(bus.unregister('removable')).toBe(true);
    expect(bus.unregister('removable')).toBe(false);
    expect(bus.unregister('never-registered')).toBe(false);
    expect(bus.metrics().removedSubscribers).toBe(1);
  });

  it('rejects a second registration under an identifier already held', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const order: string[] = [];
    const first = createStageEndRecorder('duplicated', order);
    const second = createStageEndRecorder('duplicated', order);

    expect(bus.register(first)).toBe(true);
    expect(bus.register(second)).toBe(false);
    expect(bus.subscribers()).toHaveLength(1);

    // The retained registration is the first one: its handler is the one the
    // snapshot carries, and the second table never reached the bus.
    expect(bus.subscribers()[0].id).toBe('duplicated');
    expect(bus.subscribers()[0].hooks.onStageEnd).toBe(first.hooks.onStageEnd);
    expect(bus.subscribers()[0].hooks.onStageEnd).not.toBe(
      second.hooks.onStageEnd,
    );

    dispatchStageEnd(bus);
    expect(order).toEqual(['duplicated']);
  });

  it('takes the identifier again once it has been removed', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const order: string[] = [];

    register(bus, createStageEndRecorder('recycled', order));
    expect(bus.unregister('recycled')).toBe(true);
    expect(bus.register(createStageEndRecorder('recycled', order))).toBe(true);
    dispatchStageEnd(bus);
    expect(order).toEqual(['recycled']);
  });

  it('clears the degraded mark when the identifier is registered again',
    () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const order: string[] = [];

      register(
        bus,
        createSubscriber('flaky', {
          onStageEnd: (): StageEndPayload => {
            throw new Error('relic handler failed');
          },
        }),
      );
      dispatchStageEnd(bus);
      expect(bus.degraded()).toEqual(['flaky']);
      expect(bus.unregister('flaky')).toBe(true);
      expect(bus.register(createStageEndRecorder('flaky', order))).toBe(true);
      expect(bus.degraded()).toEqual([]);
      dispatchStageEnd(bus);
      expect(order).toEqual(['flaky']);
    });

  it('rejects an identifier that is not a non-empty string', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const order: string[] = [];

    expect(bus.register(createStageEndRecorder('', order))).toBe(false);
    expect(
      bus.register({
        id: 7 as unknown as string,
        hooks: { onStageEnd: (): void => undefined },
      }),
    ).toBe(false);
    expect(bus.subscribers()).toEqual([]);
    expect(bus.metrics().rejectedRegistrations).toBe(2);
  });

  it('rejects a handler table that binds no callable handler', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });

    expect(bus.register({ id: 'empty-table', hooks: {} })).toBe(false);
    expect(
      bus.register({
        id: 'not-a-table',
        hooks: null as unknown as HookHandlerTable,
      }),
    ).toBe(false);
    expect(bus.subscribers()).toEqual([]);
  });

  it('rejects a handler table binding a name to something uncallable',
    () => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });

      expect(
        bus.register({
          id: 'uncallable',
          hooks: {
            onStageEnd: 7 as unknown as HookHandler<'onStageEnd'>,
          },
        }),
      ).toBe(false);
      expect(bus.subscribers()).toEqual([]);
    });

  it('reads no key outside the six hook names', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const order: string[] = [];
    const extras = {
      id: 'carries-an-extra-key',
      hooks: {
        onStageEnd: (): void => {
          order.push('carries-an-extra-key');
        },
        onRelicPicked: 7,
      } as unknown as HookHandlerTable,
    };

    expect(bus.register(extras)).toBe(true);
    dispatchStageEnd(bus);
    expect(order).toEqual(['carries-an-extra-key']);
  });

  it('dispatches a hook with no subscriber as a no-op', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const payload = createStageEndPayload();
    const result = dispatchStageEnd(bus, payload);

    expect(result.payload).toBe(payload);
    expect(result.invoked).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.rejected).toBe(0);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('never invokes a subscriber for a hook it did not bind', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const board = createBoard();
    const payloads = createPayloadsByHook(board);
    const stageEnd = vi.fn<HookHandler<'onStageEnd'>>((): void => undefined);

    register(bus, createSubscriber('stage-end-only', {
      onStageEnd: stageEnd,
    }));

    for (const hook of HOOK_NAMES) {
      if (hook !== 'onStageEnd') {
        bus.dispatch(hook, payloads[hook], createEnvironment());
      }
    }

    expect(stageEnd).not.toHaveBeenCalled();
    expect(bus.subscriptions('onMerge')).toEqual([]);
    expect(bus.subscriptions('onStageEnd')).toHaveLength(1);
    dispatchStageEnd(bus);
    expect(stageEnd).toHaveBeenCalledTimes(1);
  });

  it('skips a subscriber removed while a dispatch was walking', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const order: string[] = [];

    register(
      bus,
      createSubscriber(
        'remover',
        {
          onStageEnd: (): void => {
            bus.unregister('removed-midway');
            order.push('remover');
          },
        },
        { pickupOrder: 0 },
      ),
    );
    register(bus, createStageEndRecorder('removed-midway', order, {
      pickupOrder: 1,
    }));

    const result = dispatchStageEnd(bus);

    expect(order).toEqual(['remover']);
    expect(result.invoked).toBe(1);
    expect(result.skipped).toBe(1);
    expect(bus.metrics().hooks.onStageEnd.skippedDetached).toBe(1);
  });

  it('reaches a subscriber registered mid-walk on the next dispatch', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const order: string[] = [];

    register(
      bus,
      createSubscriber(
        'adder',
        {
          onStageEnd: (): void => {
            order.push('adder');

            if (bus.subscribers().length < 2) {
              bus.register(
                createStageEndRecorder('added', order, { pickupOrder: 1 }),
              );
            }
          },
        },
        { pickupOrder: 0 },
      ),
    );

    dispatchStageEnd(bus);
    expect(order).toEqual(['adder']);
    dispatchStageEnd(bus);
    expect(order).toEqual(['adder', 'adder', 'added']);
  });

  it('owns the charges and the state it was registered with, and ignores ' +
    'a later edit to the registered object', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const replacement: HookHandler<'onStageEnd'> = vi.fn();
    const subscriber = createSubscriber(
      'mutable',
      { onStageEnd: (): void => undefined },
      { charges: 3, state: 'initial' },
    );

    register(bus, subscriber);
    expect(bus.subscriptions('onStageEnd')[0].charges).toBe(3);
    expect(bus.subscriptions('onStageEnd')[0].state).toBe('initial');

    bus.consumeCharge('mutable');

    // Every edit below is made to the object the caller registered, after the
    // bus accepted it.
    const mutable = subscriber as {
      charges?: number;
      state?: unknown;
      hooks: HookHandlerTable;
    };

    mutable.state = 'later';
    mutable.charges = 99;
    mutable.hooks = { onStageEnd: replacement };

    // `consumeCharge` is the one path that changed the budget, the state slot
    // still reads as registered, and the handler the bus dispatches is still
    // the one it accepted.
    expect(bus.subscriptions('onStageEnd')[0].charges).toBe(2);
    expect(bus.subscriptions('onStageEnd')[0].state).toBe('initial');

    dispatchStageEnd(bus);

    expect(replacement).not.toHaveBeenCalled();
  });
});

describe('an edit during a dispatch leaves the walk in progress stable ' +
  '(AAP Contract 2)', () => {
  it('does not invoke a subscriber registered during the dispatch', () => {
    const bus = createHookBus();
    const order: string[] = [];
    const late = createStageEndRecorder('late', order, { pickupOrder: 0 });

    register(
      bus,
      createSubscriber(
        'first',
        {
          onStageEnd: (): void => {
            order.push('first');
            bus.register(late);
          },
        },
        { pickupOrder: 1 },
      ),
    );
    register(bus, createStageEndRecorder('second', order, { pickupOrder: 2 }));

    dispatchStageEnd(bus);

    expect(order).toEqual(['first', 'second']);
  });

  it('holds the subscriber it registered, in pickup order, for the next ' +
    'dispatch', () => {
    const bus = createHookBus();
    const order: string[] = [];
    const late = createStageEndRecorder('late', order, { pickupOrder: 0 });

    register(
      bus,
      createSubscriber(
        'first',
        {
          onStageEnd: (): void => {
            order.push('first');
            bus.register(late);
          },
        },
        { pickupOrder: 1 },
      ),
    );

    dispatchStageEnd(bus);
    order.length = 0;
    dispatchStageEnd(bus);

    // Pickup order 0 places it ahead of the subscriber that registered it, on
    // the dispatch after the one it was registered during.
    expect(order).toEqual(['late', 'first']);
    expect(bus.subscribers().map((held) => held.id)).toEqual(['late', 'first']);
  });

  it('skips a subscriber unregistered during the dispatch as detached', () => {
    const bus = createHookBus();
    const order: string[] = [];

    register(
      bus,
      createSubscriber(
        'first',
        {
          onStageEnd: (): void => {
            order.push('first');
            expect(bus.unregister('second')).toBe(true);
          },
        },
        { pickupOrder: 0 },
      ),
    );
    register(bus, createStageEndRecorder('second', order, { pickupOrder: 1 }));
    register(bus, createStageEndRecorder('third', order, { pickupOrder: 2 }));

    const result = dispatchStageEnd(bus);

    expect(order).toEqual(['first', 'third']);
    expect(result.invoked).toBe(2);
    expect(result.skipped).toBe(1);
    expect(bus.metrics().hooks.onStageEnd.skippedDetached).toBe(1);
  });

  it('has removed the unregistered subscriber once the dispatch returns',
    () => {
      const bus = createHookBus();
      const order: string[] = [];

      register(
        bus,
        createSubscriber('first', {
          onStageEnd: (): void => {
            bus.unregister('second');
          },
        }),
      );
      register(bus, createStageEndRecorder('second', order));

      dispatchStageEnd(bus);

      expect(bus.subscribers().map((held) => held.id)).toEqual(['first']);
      expect(
        bus.subscriptions('onStageEnd').map((held) => held.subscriberId),
      ).toEqual(['first']);
      expect(bus.unregister('second')).toBe(false);
    });

  it('accepts a subscriber re-registered under an identifier unregistered ' +
    'during the same dispatch', () => {
    const bus = createHookBus();
    const order: string[] = [];

    let swapped = false;

    register(
      bus,
      createSubscriber('first', {
        onStageEnd: (): void => {
          if (swapped) {
            return;
          }

          swapped = true;
          expect(bus.unregister('second')).toBe(true);
          expect(bus.register(createStageEndRecorder('second', order))).toBe(
            true,
          );
        },
      }),
    );
    register(bus, createStageEndRecorder('second', order));

    dispatchStageEnd(bus);
    order.length = 0;
    dispatchStageEnd(bus);

    expect(order).toEqual(['second']);
    expect(bus.subscribers().map((held) => held.id)).toEqual([
      'first',
      'second',
    ]);
  });

  it('applies the deferred edits even where a handler threw', () => {
    const bus = createHookBus();
    const order: string[] = [];

    register(
      bus,
      createSubscriber('first', {
        onStageEnd: (): void => {
          bus.unregister('second');

          throw new Error('handler failed');
        },
      }),
    );
    register(bus, createStageEndRecorder('second', order));

    dispatchStageEnd(bus);

    expect(bus.subscribers().map((held) => held.id)).toEqual(['first']);
  });

  it('refuses the same new identifier registered twice during one dispatch',
    () => {
      // The duplicate check reads the registrations HELD, and an insertion
      // deferred behind the walk had not landed yet, so both calls were accepted
      // and the bus went on to dispatch to one subscriber twice.
      const bus = createHookBus();
      const order: string[] = [];
      const accepted: boolean[] = [];

      register(
        bus,
        createSubscriber(
          'first',
          {
            onStageEnd: (): void => {
              order.push('first');
              accepted.push(
                bus.register(createStageEndRecorder('late', order)),
                bus.register(createStageEndRecorder('late', order)),
              );
            },
          },
          { pickupOrder: 0 },
        ),
      );

      dispatchStageEnd(bus);

      expect(accepted).toEqual([true, false]);
      expect(bus.subscribers().map((held) => held.id)).toEqual([
        'first',
        'late',
      ]);

      order.length = 0;
      dispatchStageEnd(bus);

      // One registration, so one invocation.
      expect(order).toEqual(['first', 'late']);
      expect(bus.subscriptions('onStageEnd').map((held) => held.subscriberId))
        .toEqual(['first', 'late']);
    });

  it('refuses a duplicate queued by a nested dispatch, not only by the outer ' +
    'one', () => {
    const bus = createHookBus();
    const order: string[] = [];
    const accepted: boolean[] = [];

    register(
      bus,
      createSubscriber(
        'outer',
        {
          onStageEnd: (): void => {
            order.push('outer');

            if (order.filter((entry) => entry === 'outer').length > 1) {
              // The nested dispatch below re-enters this handler once; the
              // registration is attempted from the inner turn alone.
              accepted.push(bus.register(createStageEndRecorder('nested', order)));

              return;
            }

            accepted.push(bus.register(createStageEndRecorder('nested', order)));
            dispatchStageEnd(bus);
          },
        },
        { pickupOrder: 0 },
      ),
    );

    dispatchStageEnd(bus);

    expect(accepted).toEqual([true, false]);
    expect(bus.subscribers().map((held) => held.id)).toEqual([
      'outer',
      'nested',
    ]);
  });

  it('admits an identifier registered again after it was unregistered inside ' +
    'the same dispatch', () => {
    const bus = createHookBus();
    const order: string[] = [];
    const accepted: boolean[] = [];

    let edited = false;

    register(
      bus,
      createSubscriber(
        'first',
        {
          onStageEnd: (): void => {
            order.push('first');

            // Once: the dance belongs to the first dispatch, and the second
            // dispatch below is what reads what it left.
            if (edited) {
              return;
            }

            edited = true;
            accepted.push(bus.register(createStageEndRecorder('late', order)));
            expect(bus.unregister('late')).toBe(true);
            accepted.push(
              bus.register(
                createStageEndRecorder('late', order, { pickupOrder: 9 }),
              ),
            );
          },
        },
        { pickupOrder: 0 },
      ),
    );

    dispatchStageEnd(bus);

    // Both registrations were accepted, and exactly one record is held: the
    // pickup index of the LATER acceptance.
    expect(accepted).toEqual([true, true]);
    expect(bus.subscribers().map((held) => held.id)).toEqual(['first', 'late']);
    expect(bus.subscribers().filter((held) => held.id === 'late')).toHaveLength(
      1,
    );

    order.length = 0;
    dispatchStageEnd(bus);

    expect(order).toEqual(['first', 'late']);
  });
});

describe('HookPayloadMap types each handler to its own payload ' +
  '(AAP Contract 2)', () => {
  it('maps the six names to the six payload types', () => {
    const mapsEveryName: Exact<keyof HookPayloadMap, HookName> = true;
    const mapsStageStart: Exact<
      HookPayloadMap['onStageStart'],
      StageStartPayload
    > = true;
    const mapsBeforeMove: Exact<
      HookPayloadMap['onBeforeMove'],
      BeforeMovePayload
    > = true;
    const mapsMerge: Exact<HookPayloadMap['onMerge'], MergePayload> = true;
    const mapsSpawn: Exact<HookPayloadMap['onSpawn'], SpawnPayload> = true;
    const mapsAfterMove: Exact<
      HookPayloadMap['onAfterMove'],
      AfterMovePayload
    > = true;
    const mapsStageEnd: Exact<
      HookPayloadMap['onStageEnd'],
      StageEndPayload
    > = true;

    expect([
      mapsEveryName,
      mapsStageStart,
      mapsBeforeMove,
      mapsMerge,
      mapsSpawn,
      mapsAfterMove,
      mapsStageEnd,
    ]).toEqual([true, true, true, true, true, true, true]);
  });

  it('types a handler to the payload of the hook it binds', () => {
    const table: HookHandlerTable = {
      onMerge: (payload): MergePayload => ({
        ...payload,
        resultValue: payload.resultValue * 2,
      }),
      onSpawn: (payload): SpawnPayload => ({
        ...payload,
        value: payload.value * 2,
      }),
    };

    const bus = createHookBus({ correlationId: CORRELATION_ID });

    register(bus, createSubscriber('typed', table));

    const merge = bus.dispatch(
      'onMerge',
      createMergePayload(),
      createEnvironment(),
    );
    const spawn = bus.dispatch(
      'onSpawn',
      createSpawnPayload(),
      createEnvironment(),
    );

    expect(merge.payload.resultValue).toBe(MERGED_VALUE * 2);
    expect(spawn.payload.value).toBe(SPAWN_VALUE * 2);
  });

  it('refuses a handler that reads a member of another hook payload', () => {
    const read: unknown[] = [];
    const table: HookHandlerTable = {
      onSpawn: (payload): void => {
        // @ts-expect-error resultValue belongs to the onMerge payload.
        read.push(payload.resultValue);
      },
    };

    const bus = createHookBus({ correlationId: CORRELATION_ID });

    register(bus, createSubscriber('narrow', table));

    const result = bus.dispatch(
      'onSpawn',
      createSpawnPayload(),
      createEnvironment(),
    );

    expect(result.invoked).toBe(1);
    expect(result.failed).toBe(0);
    expect(read).toEqual([undefined]);
  });

  it('types the dispatch result to the hook that was dispatched', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const result: HookDispatchResult<'onMerge'> = bus.dispatch(
      'onMerge',
      createMergePayload(),
      createEnvironment(),
    );
    const resultIsMergePayload: Exact<
      typeof result.payload,
      MergePayload
    > = true;

    expect(resultIsMergePayload).toBe(true);
    expect(result.payload.resultValue).toBe(MERGED_VALUE);
  });

  it('types a subscription to the hook it was resolved for', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const order: string[] = [];

    register(bus, createStageEndRecorder('typed', order));

    const subscriptions: readonly HookSubscription<'onStageEnd'>[] =
      bus.subscriptions('onStageEnd');
    const handlerIsStageEndHandler: Exact<
      (typeof subscriptions)[number]['handler'],
      HookHandler<'onStageEnd'>
    > = true;

    expect(handlerIsStageEndHandler).toBe(true);
    expect(subscriptions).toHaveLength(1);
  });
});

// `charges` and a `consumeCharge` amount both reach the bus from outside it: a
// relic's declared budget survives in the run-state envelope, so it comes back
// out of JSON, and an amount is whatever a caller passes.

/** A budget the guard treats as spent, so the handler is skipped. */
const SPENT_BUDGETS: readonly { label: string; charges: number }[] = [
  { label: 'zero', charges: 0 },
  { label: 'negative zero', charges: -0 },
  { label: 'one charge in debt', charges: -1 },
  { label: 'a large negative budget', charges: -100 },
  { label: 'NaN', charges: Number.NaN },
  { label: '-Infinity', charges: Number.NEGATIVE_INFINITY },
];

/** A budget above zero, so the handler runs. */
const LIVE_BUDGETS: readonly { label: string; charges: number }[] = [
  { label: 'one charge', charges: 1 },
  { label: 'a fraction above one', charges: 1.7 },
  { label: 'a fraction below one but above zero', charges: 0.4 },
  { label: 'Infinity', charges: Number.POSITIVE_INFINITY },
];

/**
 * A consumption amount that normalises to zero, so nothing is deducted and the
 * budget is left exactly as it stood.
 */
const ZERO_AMOUNTS: readonly { label: string; amount: number }[] = [
  { label: 'zero', amount: 0 },
  { label: 'a negative amount', amount: -1 },
  { label: 'a fraction below one', amount: 0.9 },
  { label: 'NaN', amount: Number.NaN },
  { label: '-Infinity', amount: Number.NEGATIVE_INFINITY },
];

describe('the charge guard reads a budget however it was written', () => {
  it.each(SPENT_BUDGETS)(
    'skips a subscriber whose budget is $label',
    ({ charges }: { charges: number }) => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const order: string[] = [];

      register(bus, createStageEndRecorder('spent', order, { charges }));

      const payload = createStageEndPayload();
      const result = dispatchStageEnd(bus, payload);

      expect(order).toEqual([]);
      expect(result.invoked).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.payload).toBe(payload);
      expect(bus.metrics().hooks.onStageEnd.skippedExhausted).toBe(1);
      expect(bus.degraded()).toEqual([]);
    }
  );

  it.each(LIVE_BUDGETS)(
    'invokes a subscriber whose budget is $label',
    ({ charges }: { charges: number }) => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const order: string[] = [];

      register(bus, createStageEndRecorder('live', order, { charges }));

      const result = dispatchStageEnd(bus);

      expect(order).toEqual(['live']);
      expect(result.invoked).toBe(1);
      expect(result.skipped).toBe(0);
      expect(bus.metrics().hooks.onStageEnd.skippedExhausted).toBe(0);
    }
  );

  it('normalises a non-finite budget to zero on the first consumption, and the guard skips it afterwards', () => {
    // RENAMED. The old title, 'never spends an infinite budget, however often it
    // dispatches', named a contract this body does not prove: the handler never
    // ASKS, so no budget of any size would be spent by the three dispatches, and
    // what the body actually proves is the normalisation below.
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const order: string[] = [];
    const subscriber = createStageEndRecorder('endless', order, {
      charges: Number.POSITIVE_INFINITY,
    });

    register(bus, subscriber);

    for (let dispatched = 0; dispatched < 3; dispatched += 1) {
      dispatchStageEnd(bus);
    }

    expect(order).toEqual(['endless', 'endless', 'endless']);

    // Dispatching a handler that asks for nothing leaves the budget as declared,
    // whatever it holds.
    expect(bus.subscriptions('onStageEnd')[0].charges).toBe(
      Number.POSITIVE_INFINITY,
    );

    // The deduction normalises a non-finite budget to zero, so the first
    // consumption spends the whole of it and the guard skips the handler
    // afterwards.
    const consumption = bus.consumeCharge('endless');

    expect(consumption.limited).toBe(true);
    expect(consumption.consumed).toBe(0);
    expect(consumption.remaining).toBe(0);
    expect(bus.subscriptions('onStageEnd')[0].charges).toBe(0);
    expect(order).toHaveLength(3);

    dispatchStageEnd(bus);

    expect(order).toHaveLength(3);
  });

  it('leaves a spent budget where it stood rather than writing it', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });

    for (const [index, { charges }] of SPENT_BUDGETS.entries()) {
      const subscriber = createSubscriber(
        `spent-${String(index)}`,
        { onStageEnd: (): void => undefined },
        { charges }
      );

      register(bus, subscriber);
      dispatchStageEnd(bus);

      // Dispatch reads the budget and never writes it.
      expect(subscriber.charges).toBe(charges);
      expect(
        bus.subscriptions('onStageEnd')[index].charges
      ).toBe(charges);
    }
  });
});

describe('consumeCharge normalises the amount it is given', () => {
  it.each(ZERO_AMOUNTS)(
    'deducts nothing for $label and leaves the budget untouched',
    ({ amount }: { amount: number }) => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const subscriber = createSubscriber(
        'metered',
        { onStageEnd: (): void => undefined },
        { charges: 3 }
      );

      register(bus, subscriber);

      const consumption = bus.consumeCharge('metered', amount);

      expect(consumption.held).toBe(true);
      expect(consumption.limited).toBe(true);
      expect(consumption.consumed).toBe(0);
      expect(consumption.remaining).toBe(3);
      expect(bus.subscriptions('onStageEnd')[0].charges).toBe(3);
      expect(bus.metrics().chargesConsumed).toBe(0);
      expect(bus.metrics().subscribers[0].chargesConsumed).toBe(0);
    }
  );

  it('spends the whole budget for an infinite amount', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const subscriber = createSubscriber(
      'drained',
      { onStageEnd: (): void => undefined },
      { charges: 3 }
    );

    register(bus, subscriber);

    const consumption = bus.consumeCharge(
      'drained',
      Number.POSITIVE_INFINITY
    );

    expect(consumption.consumed).toBe(0);
    expect(consumption.remaining).toBe(3);
    expect(bus.subscriptions('onStageEnd')[0].charges).toBe(3);
  });

  it('truncates a fractional amount towards zero', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const subscriber = createSubscriber(
      'fractional-amount',
      { onStageEnd: (): void => undefined },
      { charges: 5 }
    );

    register(bus, subscriber);

    const consumption = bus.consumeCharge('fractional-amount', 2.9);

    expect(consumption.consumed).toBe(2);
    expect(consumption.remaining).toBe(3);
    expect(bus.subscriptions('onStageEnd')[0].charges).toBe(3);
    expect(bus.metrics().chargesConsumed).toBe(2);
  });

  it('takes no more than the budget holds', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const subscriber = createSubscriber(
      'overdrawn',
      { onStageEnd: (): void => undefined },
      { charges: 2 }
    );

    register(bus, subscriber);

    const consumption = bus.consumeCharge('overdrawn', 10);

    expect(consumption.consumed).toBe(2);
    expect(consumption.remaining).toBe(0);
    expect(bus.subscriptions('onStageEnd')[0].charges).toBe(0);
    expect(bus.metrics().chargesConsumed).toBe(2);
  });

  it.each(SPENT_BUDGETS)(
    'reports a budget of $label as spent without throwing',
    ({ charges }: { charges: number }) => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const subscriber = createSubscriber(
        'already-spent',
        { onStageEnd: (): void => undefined },
        { charges }
      );

      register(bus, subscriber);

      const consumption = expectConsumption(() =>
        bus.consumeCharge('already-spent')
      );

      expect(consumption.held).toBe(true);
      expect(consumption.limited).toBe(true);
      expect(consumption.consumed).toBe(0);
      expect(consumption.remaining).toBe(0);

      // A non-finite or negative budget is normalised as it is written back,
      // so a later read finds a whole number at or above zero.
      expect(bus.subscriptions('onStageEnd')[0].charges).toBe(0);
      expect(bus.metrics().chargesConsumed).toBe(0);
    }
  );

  it('reports an unheld identifier as unheld for every amount', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });

    for (const { amount } of ZERO_AMOUNTS) {
      const consumption = bus.consumeCharge('never-registered', amount);

      expect(consumption.held).toBe(false);
      expect(consumption.limited).toBe(false);
      expect(consumption.consumed).toBe(0);
      expect(consumption.remaining).toBeUndefined();
    }
  });
});

describe('pickup order falls back when it is not a finite number', () => {
  it('appends a subscriber whose pickup order is not finite', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const order: string[] = [];

    register(bus, createStageEndRecorder('first', order, { pickupOrder: 0 }));
    register(
      bus,
      createStageEndRecorder('nan', order, { pickupOrder: Number.NaN })
    );
    register(
      bus,
      createStageEndRecorder('infinite', order, {
        pickupOrder: Number.POSITIVE_INFINITY,
      })
    );
    register(
      bus,
      createStageEndRecorder('negative-infinite', order, {
        pickupOrder: Number.NEGATIVE_INFINITY,
      })
    );

    dispatchStageEnd(bus);

    expect(order).toEqual(['first', 'nan', 'infinite', 'negative-infinite']);
    expect(
      bus.metrics().subscribers.map((row: HookSubscriberMetrics): string =>
        row.id
      )
    ).toEqual(['first', 'nan', 'infinite', 'negative-infinite']);
  });

  it('honours a negative pickup order, which is finite', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const order: string[] = [];

    register(bus, createStageEndRecorder('appended', order));
    register(
      bus,
      createStageEndRecorder('early', order, { pickupOrder: -5 })
    );

    dispatchStageEnd(bus);

    expect(order).toEqual(['early', 'appended']);
  });

  it('breaks a tie by registration sequence', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const order: string[] = [];

    register(bus, createStageEndRecorder('tied-a', order, { pickupOrder: 4 }));
    register(bus, createStageEndRecorder('tied-b', order, { pickupOrder: 4 }));
    register(bus, createStageEndRecorder('tied-c', order, { pickupOrder: 4 }));

    dispatchStageEnd(bus);

    expect(order).toEqual(['tied-a', 'tied-b', 'tied-c']);
  });
});

// Every count and every caught handler error is delivered through one wrapper,
// so a reporter that throws must not reach the caller from any of them.

/**
 * Builds a reporter whose `onCount` throws `fault` and whose `onHookError`
 * behaves, so a fault can only have arrived through the counting channel.
 *
 * @param fault Value `onCount` throws.
 * @param errors Array the behaving error sink appends to.
 * @returns The reporter.
 */
function createCountThrowingReporter(
  fault: unknown,
  errors: EngineHookErrorReport[]
): EngineReporter {
  return {
    onCount: (): never => {
      throw fault;
    },
    onHookError: (report: EngineHookErrorReport): void => {
      errors.push(report);
    },
  };
}

/** Message every reporter fault below is raised with. */
const REPORTER_FAULT_MESSAGE = 'the counting sink itself failed';

/**
 * Runs the scenario every case in this section runs, on a bus built with the
 * reporter supplied.
 *
 * @param bus Bus to exercise.
 * @returns What the payload-transforming dispatch produced.
 */
function exerciseEveryCountingPath(
  bus: HookBus
): HookDispatchResult<'onStageEnd'> {
  register(
    bus,
    createSubscriber(
      'counted',
      {
        onStageEnd: (payload): StageEndPayload => ({
          ...payload,
          score: payload.score + 1,
        }),
      },
      { charges: 2 }
    )
  );
  register(
    bus,
    createSubscriber('thrower', {
      onStageEnd: (): StageEndPayload => {
        throw new Error('relic handler failed');
      },
    })
  );
  register(
    bus,
    createSubscriber('spent', { onStageEnd: (): void => undefined }, {
      charges: 0,
    })
  );

  // A registration the bus rejects, which counts on its own metric.
  expect(bus.register({ id: '', hooks: {} })).toBe(false);

  const result = dispatchStageEnd(bus);

  bus.consumeCharge('counted', 1);
  expect(bus.unregister('spent')).toBe(true);

  return result;
}

describe('a reporter that throws while counting is contained', () => {
  it('completes every counting path and reports the fault out of band', () => {
    const errors: EngineHookErrorReport[] = [];
    const fault = new Error(REPORTER_FAULT_MESSAGE);
    const bus = createHookBus({
      correlationId: CORRELATION_ID,
      reporter: createCountThrowingReporter(fault, errors),
    });

    const result = expectNoDispatchThrow(() =>
      exerciseEveryCountingPath(bus)
    );

    // The dispatch itself is unaffected: the surviving handler's payload is
    // carried, the thrower is contained and the spent subscriber is skipped.
    expect(result.payload.score).toBe(STAGE_SCORE + 1);
    expect(result.invoked).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(1);

    // The transforming handler asked for no charge and recorded no command, so
    // the dispatch spent nothing: the spend is effect-coupled.
    expect(result.chargesConsumed).toBe(0);
    expect(errors).toHaveLength(1);
    expect(bus.degraded()).toEqual(['thrower']);

    const metrics = bus.metrics();

    expect(metrics.lastReporterFault).toBe(REPORTER_FAULT_MESSAGE);
    expect(metrics.reporterFaults).toBeGreaterThan(0);
    expect(metrics.acceptedRegistrations).toBe(3);
    expect(metrics.rejectedRegistrations).toBe(1);
    expect(metrics.removedSubscribers).toBe(1);

    // None spent by the dispatch, and one by the explicit
    // `consumeCharge('counted', 1)` the exercise makes afterwards.
    expect(metrics.chargesConsumed).toBe(1);
    expect(metrics.hooks.onStageEnd.dispatched).toBe(1);
    expect(metrics.hooks.onStageEnd.invoked).toBe(2);
    expect(metrics.hooks.onStageEnd.failed).toBe(1);
    expect(metrics.hooks.onStageEnd.skippedExhausted).toBe(1);
  });

  it('counts exactly one fault per report the sink would have received', () => {
    const recording = createRecordingReporter();
    const behaving = createHookBus({
      correlationId: CORRELATION_ID,
      reporter: recording.reporter,
    });

    exerciseEveryCountingPath(behaving);

    const errors: EngineHookErrorReport[] = [];
    const faulty = createHookBus({
      correlationId: CORRELATION_ID,
      reporter: createCountThrowingReporter(
        new Error(REPORTER_FAULT_MESSAGE),
        errors
      ),
    });

    exerciseEveryCountingPath(faulty);

    // Every count the behaving sink received is a count the throwing sink
    // threw from, and each was contained exactly once.
    expect(recording.counts.length).toBeGreaterThan(0);
    expect(faulty.metrics().reporterFaults).toBe(recording.counts.length);
    expect(behaving.metrics().reporterFaults).toBe(0);
    expect(behaving.metrics().lastReporterFault).toBeUndefined();
  });

  it('describes a thrown value that is not an Error', () => {
    const errors: EngineHookErrorReport[] = [];
    const bus = createHookBus({
      correlationId: CORRELATION_ID,
      reporter: createCountThrowingReporter('a bare string', errors),
    });
    const order: string[] = [];

    register(bus, createStageEndRecorder('counted', order));
    dispatchStageEnd(bus);

    expect(order).toEqual(['counted']);
    expect(bus.metrics().lastReporterFault).toBe('a bare string');
  });

  it('contains a reporter whose every member throws', () => {
    const fault = new Error(REPORTER_FAULT_MESSAGE);
    const bus = createHookBus({
      correlationId: CORRELATION_ID,
      reporter: {
        onCount: (): never => {
          throw fault;
        },
        onHookError: (): never => {
          throw fault;
        },
      },
    });

    const result = expectNoDispatchThrow(() =>
      exerciseEveryCountingPath(bus)
    );

    expect(result.payload.score).toBe(STAGE_SCORE + 1);
    expect(result.failed).toBe(1);
    expect(bus.degraded()).toEqual(['thrower']);
    expect(bus.metrics().lastReporterFault).toBe(REPORTER_FAULT_MESSAGE);
  });

  it('keeps its counters exact while the sink is failing', () => {
    const errors: EngineHookErrorReport[] = [];
    const faulty = createHookBus({
      correlationId: CORRELATION_ID,
      reporter: createCountThrowingReporter(
        new Error(REPORTER_FAULT_MESSAGE),
        errors
      ),
    });
    const silent = createHookBus({ correlationId: CORRELATION_ID });

    exerciseEveryCountingPath(faulty);
    exerciseEveryCountingPath(silent);

    const faultyMetrics = faulty.metrics();
    const silentMetrics = silent.metrics();

    expect(faultyMetrics.hooks).toStrictEqual(silentMetrics.hooks);
    expect(faultyMetrics.totals).toStrictEqual(silentMetrics.totals);
    expect(faultyMetrics.chargesConsumed).toBe(silentMetrics.chargesConsumed);
    expect(faultyMetrics.degraded).toStrictEqual(silentMetrics.degraded);
  });
});

describe('a handler that throws leaves no nested state behind', () => {
  /** A state slot with something to write at depth. */
  const nestedState = (): unknown => ({
    counters: { merges: 0 },
    history: ['start'],
  });

  it('rolls back a write into a nested object', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });

    register(
      bus,
      createSubscriber(
        'writes-deep-then-throws',
        {
          onStageEnd: (_payload, context): StageEndPayload => {
            const slot = context.state as { counters: { merges: number } };

            slot.counters.merges = 99;

            throw new Error('relic handler failed');
          },
        },
        { state: nestedState() },
      ),
    );

    const result = dispatchStageEnd(bus);

    expect(result.failed).toBe(1);
    expect(bus.subscriptions('onStageEnd')[0].state).toEqual(nestedState());
  });

  it('rolls back a write into a nested array', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });

    register(
      bus,
      createSubscriber(
        'pushes-then-throws',
        {
          onStageEnd: (): StageEndPayload => {
            throw new Error('relic handler failed');
          },
        },
        { state: nestedState() },
      ),
    );
    register(
      bus,
      createSubscriber(
        'appends-then-throws',
        {
          onStageEnd: (_payload, context): StageEndPayload => {
            const slot = context.state as { history: string[] };

            slot.history.push('written-before-the-throw');

            throw new Error('relic handler failed');
          },
        },
        { state: nestedState() },
      ),
    );

    const result = dispatchStageEnd(bus);

    expect(result.failed).toBe(2);

    for (const subscription of bus.subscriptions('onStageEnd')) {
      expect(subscription.state).toEqual(nestedState());
    }
  });

  it('rolls back a nested write when the return is refused rather than ' +
    'thrown', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });

    register(
      bus,
      createSubscriber(
        'writes-deep-then-returns-rubbish',
        {
          onStageEnd: (_payload, context): StageEndPayload => {
            const slot = context.state as { counters: { merges: number } };

            slot.counters.merges = 99;

            return { stageIndex: -1 } as unknown as StageEndPayload;
          },
        },
        { state: nestedState() },
      ),
    );

    const result = dispatchStageEnd(bus);

    expect(result.rejected).toBe(1);
    expect(bus.subscriptions('onStageEnd')[0].state).toEqual(nestedState());
  });

  it('adopts a nested write the handler returned from normally', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });

    register(
      bus,
      createSubscriber(
        'writes-deep',
        {
          onStageEnd: (_payload, context): void => {
            const slot = context.state as {
              counters: { merges: number };
              history: string[];
            };

            slot.counters.merges += 1;
            slot.history.push('kept');
          },
        },
        { state: nestedState() },
      ),
    );

    dispatchStageEnd(bus);

    expect(bus.subscriptions('onStageEnd')[0].state).toEqual({
      counters: { merges: 1 },
      history: ['start', 'kept'],
    });

    dispatchStageEnd(bus);

    expect(bus.subscriptions('onStageEnd')[0].state).toEqual({
      counters: { merges: 2 },
      history: ['start', 'kept', 'kept'],
    });
  });

  it('does not hand two dispatches the same state object', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const seen: unknown[] = [];

    register(
      bus,
      createSubscriber(
        'keeps-its-reference',
        {
          onStageEnd: (_payload, context): void => {
            seen.push(context.state);
          },
        },
        { state: nestedState() },
      ),
    );

    dispatchStageEnd(bus);
    dispatchStageEnd(bus);

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[0]).toEqual(seen[1]);
  });

  it('does not let a handler write into the run through a reference it ' +
    'kept from an earlier dispatch', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    let kept: { counters: { merges: number } } | null = null;

    register(
      bus,
      createSubscriber(
        'keeps-a-reference',
        {
          onStageEnd: (_payload, context): void => {
            if (kept === null) {
              kept = context.state as { counters: { merges: number } };

              return;
            }

            // The reference from the first dispatch, written to during the
            // second.
            kept.counters.merges = 99;
          },
        },
        { state: nestedState() },
      ),
    );

    dispatchStageEnd(bus);
    dispatchStageEnd(bus);

    expect(bus.subscriptions('onStageEnd')[0].state).toEqual(nestedState());
  });

  it('does not read the caller\'s object after registration, at depth', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const state = nestedState() as { counters: { merges: number } };
    const seen: unknown[] = [];

    register(
      bus,
      createSubscriber(
        'registered-with-an-object',
        {
          onStageEnd: (_payload, context): void => {
            seen.push(context.state);
          },
        },
        { state },
      ),
    );

    // A write into the object the caller registered, after registration.
    state.counters.merges = 99;

    dispatchStageEnd(bus);

    expect(seen[0]).toEqual(nestedState());
  });
});

describe('a handler reads both merged tiles through onMerge', () => {
  it('carries each tile settled, coordinate for coordinate', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const payload = createMergePayload();

    register(
      bus,
      createSubscriber('reads-the-tiles', {
        onMerge: (merge): MergePayload => merge,
      }),
    );

    const result = bus.dispatch('onMerge', payload, createEnvironment());

    // Both tiles are already out of `grid.cells` when `onMerge` dispatches, so
    // their coordinates and values are SETTLED and the projection cannot go
    // stale within the dispatch.
    expect(result.payload.source).not.toBe(payload.source);
    expect(result.payload.source.x).toBe(PAIR_X);
    expect(result.payload.source.y).toBe(PAIR_Y);
    expect(result.payload.source.value).toBe(PAIR_VALUE);
    expect(result.payload.source.previousPosition).toEqual({
      x: PAIR_NEXT_X,
      y: PAIR_Y,
    });
    expect(result.payload.target.value).toBe(PAIR_VALUE);
    expect(result.payload.target.previousPosition).toEqual({
      x: PAIR_X,
      y: PAIR_Y,
    });
  });

  it('freezes each projection, so a handler write reaches neither tile', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const payload = createMergePayload();

    register(
      bus,
      createSubscriber('writes-a-tile', {
        onMerge: (merge): void => {
          const writable = merge.source as unknown as { value: number };

          try {
            writable.value = HUGE_BOARD_SIZE;
          } catch {
            // A frozen target throws under strict mode, which is the refusal
            // this case is asserting.
          }
        },
      }),
    );

    bus.dispatch('onMerge', payload, createEnvironment());

    expect(payload.source.value).toBe(PAIR_VALUE);
  });

  it('exposes exactly the four data members the projection declares', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const members: string[] = [];
    const writers: unknown[] = [];

    register(
      bus,
      createSubscriber('reads-the-tile', {
        onMerge: (merge): void => {
          members.push(...Object.keys(merge.source).sort());

          const surface = merge.source as unknown as Record<string, unknown>;

          writers.push(
            surface['savePosition'],
            surface['updatePosition'],
            surface['mergedFrom'],
          );
        },
      }),
    );

    bus.dispatch('onMerge', createMergePayload(), createEnvironment());

    // The four members a handler is given, and none of the three a live `Tile`
    // would also carry: two writers and the merge chain a relic has no use
    // for.
    expect(members).toEqual(['previousPosition', 'value', 'x', 'y']);
    expect(writers).toEqual([undefined, undefined, undefined]);
  });
});

describe('a handler that throws consumes no randomness', () => {
  /**
   * Builds an environment whose substreams are held, so a test can read their
   * cursors before and after a dispatch.
   *
   * @returns The environment and its substreams.
   */
  function createHeldEnvironment(): {
    readonly environment: HookEnvironment;
    readonly streams: ReturnType<typeof createRngStreams>;
  } {
    const streams = createRngStreams(RUN_SEED);

    return {
      streams,
      environment: {
        config: createDefaultRulesConfig(),
        rng: streams,
        grid: createBoard(),
      },
    };
  }

  it('leaves every substream cursor where it stood', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const { environment, streams } = createHeldEnvironment();

    register(
      bus,
      createSubscriber('draws-then-throws', {
        onStageEnd: (_payload, context): StageEndPayload => {
          context.rng.stream(SPAWN_VALUE_STREAM).next();
          context.rng.stream(SPAWN_VALUE_STREAM).next();
          context.rng.stream('spawn-position').nextInt(4);

          throw new Error('relic handler failed');
        },
      }),
    );

    const before = streams.snapshotCursors();
    const result = bus.dispatch(
      'onStageEnd',
      createStageEndPayload(),
      environment,
    );

    expect(result.failed).toBe(1);
    expect(streams.snapshotCursors()).toEqual(before);
  });

  it('leaves the next value the engine draws unchanged', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const { environment, streams } = createHeldEnvironment();
    const reference = createRngStreams(RUN_SEED);

    register(
      bus,
      createSubscriber('draws-then-throws', {
        onStageEnd: (_payload, context): StageEndPayload => {
          context.rng.stream(SPAWN_VALUE_STREAM).next();

          throw new Error('relic handler failed');
        },
      }),
    );

    bus.dispatch('onStageEnd', createStageEndPayload(), environment);

    expect(streams.stream(SPAWN_VALUE_STREAM).next()).toBe(
      reference.stream(SPAWN_VALUE_STREAM).next(),
    );
  });

  it('leaves the cursors where they stood when the return is refused', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const { environment, streams } = createHeldEnvironment();

    register(
      bus,
      createSubscriber('draws-then-returns-rubbish', {
        onStageEnd: (_payload, context): StageEndPayload => {
          context.rng.stream(SPAWN_VALUE_STREAM).next();

          return { cleared: false } as unknown as StageEndPayload;
        },
      }),
    );

    const before = streams.snapshotCursors();
    const result = bus.dispatch(
      'onStageEnd',
      createStageEndPayload(),
      environment,
    );

    expect(result.rejected).toBe(1);
    expect(streams.snapshotCursors()).toEqual(before);
  });

  it('adopts the draws of a handler that returned normally, exactly once ' +
    'each', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const { environment, streams } = createHeldEnvironment();
    const drawn: number[] = [];

    register(
      bus,
      createSubscriber('draws-three', {
        onStageEnd: (_payload, context): void => {
          const stream = context.rng.stream(SPAWN_VALUE_STREAM);

          drawn.push(stream.next(), stream.next(), stream.next());
        },
      }),
    );

    bus.dispatch('onStageEnd', createStageEndPayload(), environment);

    const reference = createRngStreams(RUN_SEED);
    const referenceStream = reference.stream(SPAWN_VALUE_STREAM);
    const expected = [
      referenceStream.next(),
      referenceStream.next(),
      referenceStream.next(),
    ];

    expect(drawn).toEqual(expected);
    expect(streams.snapshotCursors()[SPAWN_VALUE_STREAM]).toBe(3);
    expect(streams.stream(SPAWN_VALUE_STREAM).next()).toBe(
      referenceStream.next(),
    );
  });

  it('keeps one handler\'s abandoned draws out of the next handler\'s ' +
    'sequence', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const { environment } = createHeldEnvironment();
    const seen: number[] = [];

    register(
      bus,
      createSubscriber(
        'draws-then-throws',
        {
          onStageEnd: (_payload, context): StageEndPayload => {
            context.rng.stream(SPAWN_VALUE_STREAM).next();

            throw new Error('relic handler failed');
          },
        },
        { pickupOrder: 0 },
      ),
    );
    register(
      bus,
      createSubscriber(
        'draws-after',
        {
          onStageEnd: (_payload, context): void => {
            seen.push(context.rng.stream(SPAWN_VALUE_STREAM).next());
          },
        },
        { pickupOrder: 1 },
      ),
    );

    bus.dispatch('onStageEnd', createStageEndPayload(), environment);

    const reference = createRngStreams(RUN_SEED);

    expect(seen).toEqual([reference.stream(SPAWN_VALUE_STREAM).next()]);
  });

  it('reports a handler its own consumption through snapshotCursors', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const { environment } = createHeldEnvironment();
    const seen: number[] = [];

    register(
      bus,
      createSubscriber('reads-its-own-cursor', {
        onStageEnd: (_payload, context): void => {
          seen.push(context.rng.snapshotCursors()[SPAWN_VALUE_STREAM]);
          context.rng.stream(SPAWN_VALUE_STREAM).next();
          seen.push(context.rng.snapshotCursors()[SPAWN_VALUE_STREAM]);
        },
      }),
    );

    bus.dispatch('onStageEnd', createStageEndPayload(), environment);

    expect(seen).toEqual([0, 1]);
  });
});

describe('a handler reads the live lattice through a payload', () => {
  it('carries a reading facade over the live board on onBeforeMove', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const board = createBoard();
    const seen: unknown[] = [];

    register(
      bus,
      createSubscriber('reads-the-payload-board', {
        onBeforeMove: (payload): void => {
          seen.push(payload.board);
        },
      }),
    );

    bus.dispatch(
      'onBeforeMove',
      createBeforeMovePayload(board),
      createEnvironment(),
    );

    const carried = seen[0] as Record<string, unknown>;

    // Every READ the board answers, and not one WRITER: the four members below
    // are the whole reading surface, and `insertTile`, `removeTile` and the
    // raw `cells` array are absent by construction.
    expect(carried).not.toBe(board);
    expect(typeof carried['cellValue']).toBe('function');
    expect(typeof carried['cellAvailable']).toBe('function');
    expect(typeof carried['availableCells']).toBe('function');
    expect(typeof carried['serialize']).toBe('function');
    expect(carried['insertTile']).toBeUndefined();
    expect(carried['removeTile']).toBeUndefined();
    expect(carried['cells']).toBeUndefined();
    expect(carried['cellContent']).toBeUndefined();
  });

  it('carries a reading facade over the live board on onAfterMove', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const board = createBoard();
    const seen: AfterMovePayload['board'][] = [];
    const environment: HookEnvironment = {
      config: createDefaultRulesConfig(),
      rng: createRngStreams(RUN_SEED),
      grid: board,
    };

    register(
      bus,
      createSubscriber('reads-the-payload-board', {
        onAfterMove: (payload): void => {
          seen.push(payload.board);
        },
      }),
    );

    bus.dispatch('onAfterMove', createAfterMovePayload(board), environment);

    // Same facade on the post-move hook, over the same live lattice: the read
    // tracks the board, and the write channel stays `context.effects`.
    expect(seen[0]).not.toBe(board);
    expect(seen[0]?.size).toBe(BOARD_SIZE);
    expect(seen[0]?.cellValue({ x: PAIR_X, y: PAIR_Y })).toBe(PAIR_VALUE);

    board.removeTile(new Tile({ x: PAIR_X, y: PAIR_Y }, PAIR_VALUE));

    expect(seen[0]?.cellValue({ x: PAIR_X, y: PAIR_Y })).toBeNull();
  });

  it('reads live, so the board it reports is the board as it stands', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const board = createBoard();
    const seen: (number | null)[] = [];

    register(
      bus,
      createSubscriber('reads-a-cell', {
        onBeforeMove: (payload): void => {
          seen.push(payload.board.cellValue({ x: PAIR_X, y: PAIR_Y }));
        },
      }),
    );

    const payload = createBeforeMovePayload(board);
    const environment: HookEnvironment = {
      config: createDefaultRulesConfig(),
      rng: createRngStreams(RUN_SEED),
      grid: board,
    };

    bus.dispatch('onBeforeMove', payload, environment);
    board.removeTile(new Tile({ x: PAIR_X, y: PAIR_Y }, PAIR_VALUE));
    bus.dispatch('onBeforeMove', payload, environment);

    expect(seen).toEqual([PAIR_VALUE, null]);
  });

  it('discards a lattice write made by a handler that then throws, and ' +
    'marks that handler degraded', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const board = createBoard();
    const environment: HookEnvironment = {
      config: createDefaultRulesConfig(),
      rng: createRngStreams(RUN_SEED),
      grid: board,
    };

    register(
      bus,
      createSubscriber('writes-then-throws', {
        onBeforeMove: (_payload, context): BeforeMovePayload => {
          context.effects.removeTile({ x: PAIR_X, y: PAIR_Y });

          throw new Error('relic handler failed');
        },
      }),
    );

    const result = bus.dispatch(
      'onBeforeMove',
      createBeforeMovePayload(board),
      environment,
    );

    // The command was RECORDED, never applied: the queue commits only after
    // the handler has returned and its payload has validated, so a throw
    // discards the whole plan and the lattice stands exactly as the handler
    // found it.
    expect(result.failed).toBe(1);
    expect(result.effectsApplied).toBe(0);
    expect(board.cellContent({ x: PAIR_X, y: PAIR_Y })).not.toBeNull();
    expect(board.cellContent({ x: PAIR_X, y: PAIR_Y })?.value).toBe(PAIR_VALUE);
    expect(bus.degraded()).toContain('writes-then-throws');
  });
});

describe('the charge spend (AAP Contract 2, gate V6)', () => {
  // The spend is effect-coupled, not turn-coupled.
  it('spends nothing for an invocation that only transformed the payload', () => {
    const bus = createHookBus();

    register(
      bus,
      createSubscriber(
        'spender',
        {
          onStageEnd: (payload): StageEndPayload => ({
            ...payload,
            score: payload.score + 1,
          }),
        },
        { charges: 2 },
      ),
    );

    const first = dispatchStageEnd(bus);

    expect(first.payload.score).toBe(STAGE_SCORE + 1);
    expect(first.chargesConsumed).toBe(0);
    expect(bus.subscribers()[0]?.charges).toBe(2);

    const second = dispatchStageEnd(bus);

    expect(second.chargesConsumed).toBe(0);
    expect(bus.subscribers()[0]?.charges).toBe(2);
  });

  it('stops firing once the budget is exhausted', () => {
    const bus = createHookBus();
    const handler = vi.fn(
      (payload: StageEndPayload, context: HookContext): StageEndPayload => {
        context.spendCharge();

        return { ...payload, score: payload.score + 1 };
      },
    );

    register(
      bus,
      createSubscriber('spender', { onStageEnd: handler }, { charges: 1 }),
    );

    const first = dispatchStageEnd(bus);
    const second = dispatchStageEnd(bus);
    const third = dispatchStageEnd(bus);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(first.invoked).toBe(1);
    expect(first.chargesConsumed).toBe(1);
    expect(second.invoked).toBe(0);
    expect(second.skipped).toBe(1);
    expect(third.skipped).toBe(1);
    expect(second.chargesConsumed).toBe(0);
  });

  it('spends nothing for an invocation that changed nothing', () => {
    const bus = createHookBus();

    register(
      bus,
      createSubscriber(
        'idle',
        {
          // Returns the payload it was handed, which is what a relic whose
          // trigger condition did not hold does.
          onStageEnd: (payload): StageEndPayload => payload,
        },
        { charges: 3 },
      ),
    );

    for (let turn = 0; turn < 5; turn += 1) {
      expect(dispatchStageEnd(bus).chargesConsumed).toBe(0);
    }

    expect(bus.subscribers()[0]?.charges).toBe(3);
  });

  it('spends nothing when the handler throws', () => {
    const bus = createHookBus();

    register(
      bus,
      createSubscriber(
        'thrower',
        {
          onStageEnd: (): StageEndPayload => {
            throw new Error('relic handler failed');
          },
        },
        { charges: 2 },
      ),
    );

    const result = expectNoDispatchThrow(() => dispatchStageEnd(bus));

    expect(result.failed).toBe(1);
    expect(result.chargesConsumed).toBe(0);
    expect(bus.subscribers()[0]?.charges).toBe(2);
  });

  it('spends nothing when the return is refused', () => {
    const bus = createHookBus();

    register(
      bus,
      createSubscriber(
        'liar',
        {
          // A non-finite score is refused by `isValidPayload`, so the whole
          // transaction — payload, state, draws and effects — is rolled back.
          onStageEnd: (payload): StageEndPayload => ({
            ...payload,
            score: Number.NaN,
          }),
        },
        { charges: 2 },
      ),
    );

    const result = dispatchStageEnd(bus);

    expect(result.rejected).toBe(1);
    expect(result.chargesConsumed).toBe(0);
    expect(bus.subscribers()[0]?.charges).toBe(2);
  });

  it('accumulates the spends a handler declared itself', () => {
    const bus = createHookBus();

    register(
      bus,
      createSubscriber(
        'declarer',
        {
          onStageEnd: (payload, context: HookContext): StageEndPayload => {
            context.spendCharge();
            context.spendCharge();

            return payload;
          },
        },
        { charges: 3 },
      ),
    );

    // Twice declared, twice spent: `spendCharge` is a REQUEST for an amount,
    // accumulated across however many times one invocation asks, and the bus
    // fulfils the total once — inside the same transaction that adopts the
    // return, so a handler that then threw would pay nothing.
    expect(dispatchStageEnd(bus).chargesConsumed).toBe(2);
    expect(bus.subscribers()[0]?.charges).toBe(1);
  });

  it('never spends from a subscriber carrying no budget', () => {
    const bus = createHookBus();

    register(
      bus,
      createSubscriber('unlimited', {
        onStageEnd: (payload, context: HookContext): StageEndPayload => {
          context.spendCharge();

          return { ...payload, score: payload.score + 1 };
        },
      }),
    );

    const result = dispatchStageEnd(bus);

    expect(result.chargesConsumed).toBe(0);
    expect(bus.subscribers()[0]?.charges).toBeUndefined();
  });

  it('never invokes a handler that starts at zero charges, and never ' +
    'throws', () => {
    const bus = createHookBus();
    const handler = vi.fn((): void => undefined);

    register(
      bus,
      createSubscriber('spent', { onStageEnd: handler }, { charges: 0 }),
    );

    const result = expectNoDispatchThrow(() => dispatchStageEnd(bus));

    expect(handler).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(result.chargesConsumed).toBe(0);
    expect(bus.subscribers()[0]?.charges).toBe(0);
  });
});

describe('the board-effect channel', () => {
  it('returns the effects an accepted handler requested, in request order', () => {
    const bus = createHookBus();

    register(
      bus,
      createSubscriber('shrinker', {
        onStageEnd: (payload, context: HookContext): StageEndPayload => {
          context.effects.request({ kind: 'resizeBoard', boardSize: 3 });
          context.effects.request({ kind: 'resizeBoard', boardSize: 2 });

          return payload;
        },
      }),
    );

    const result = dispatchStageEnd(bus);

    // Recorded in the CANONICAL form, whichever spelling the descriptor used.
    expect(result.effects).toHaveLength(2);
    expect(result.effects[0]).toEqual({ kind: 'resizeBoard', size: 3 });
    expect(result.effects[1]).toEqual({ kind: 'resizeBoard', size: 2 });
  });

  it('discards the effects of a handler that threw', () => {
    const bus = createHookBus();

    register(
      bus,
      createSubscriber('thrower', {
        onStageEnd: (_payload, context: HookContext): StageEndPayload => {
          context.effects.request({ kind: 'resizeBoard', boardSize: 3 });

          throw new Error('relic handler failed');
        },
      }),
    );

    const result = expectNoDispatchThrow(() => dispatchStageEnd(bus));

    expect(result.failed).toBe(1);
    expect(result.effects).toHaveLength(0);
  });

  it('discards the effects of a handler whose return was refused', () => {
    const bus = createHookBus();

    register(
      bus,
      createSubscriber('liar', {
        onStageEnd: (payload, context: HookContext): StageEndPayload => {
          context.effects.request({ kind: 'resizeBoard', boardSize: 3 });

          return { ...payload, score: Number.NaN };
        },
      }),
    );

    const result = dispatchStageEnd(bus);

    expect(result.rejected).toBe(1);
    expect(result.effects).toHaveLength(0);
  });

  it('refuses an unusable effect and reports the refusal to its requester', () => {
    const bus = createHookBus();
    const accepted: boolean[] = [];

    register(
      bus,
      createSubscriber('bad', {
        onStageEnd: (payload, context: HookContext): StageEndPayload => {
          accepted.push(
            context.effects.request({
              kind: 'nope',
            } as unknown as Parameters<HookContext['effects']['request']>[0]),
          );
          accepted.push(
            context.effects.request({ kind: 'resizeBoard', boardSize: -1 }),
          );

          return payload;
        },
      }),
    );

    const result = dispatchStageEnd(bus);

    expect(accepted).toEqual([false, false]);
    expect(result.effects).toHaveLength(0);
  });

  it('refuses a LATTICE command from the mid-walk hook and accepts a rules ' +
    'one', () => {
    const bus = createHookBus();
    const environment = createEnvironment();
    const accepted: boolean[] = [];

    register(
      bus,
      createSubscriber('mid-walk', {
        onMerge: (payload, context: HookContext) => {
          // `onMerge` is dispatched from INSIDE the move walk, which holds
          // tile references and traversal state, so a lattice command there
          // would invalidate the walk.
          accepted.push(
            context.effects.request({ kind: 'resizeBoard', boardSize: 3 }),
          );
          accepted.push(context.effects.removeTile({ x: PAIR_X, y: PAIR_Y }));

          accepted.push(
            context.effects.setMergePredicate((): boolean => false),
          );

          return payload;
        },
      }),
    );

    const result = bus.dispatch(
      'onMerge',
      createMergePayload(),
      environment,
    );

    expect(accepted).toEqual([false, false, true]);
    expect(result.effects).toEqual([
      { kind: 'setMergePredicate', predicate: expect.any(Function) },
    ]);
    expect(environment.config.merge.canMerge).not.toBe(
      createDefaultRulesConfig().merge.canMerge,
    );
  });

  it('accepts a lattice command from onSpawn, which follows the walk', () => {
    const bus = createHookBus();
    const environment = createEnvironment();
    const accepted: boolean[] = [];

    register(
      bus,
      createSubscriber('sprouts', {
        onSpawn: (payload, context: HookContext) => {
          // `addRandomTile` dispatches this AFTER the walk has resolved, so
          // inserting a second tile is safe — and is how `fertile-ground`
          // sprouts one.
          accepted.push(context.effects.insertTile({ x: 3, y: 3 }, 2));

          return payload;
        },
      }),
    );

    const result = bus.dispatch(
      'onSpawn',
      { position: { x: 0, y: 1 }, value: 2 },
      environment,
    );

    expect(accepted).toEqual([true]);
    expect(result.effectsApplied).toBe(1);
    expect(environment.grid.cellContent({ x: 3, y: 3 })?.value).toBe(2);
  });

  it('reports the effects it requested back to the handler', () => {
    const bus = createHookBus();
    const seen: number[] = [];

    register(
      bus,
      createSubscriber('reader', {
        onStageEnd: (payload, context: HookContext): StageEndPayload => {
          seen.push(context.effects.requested().length);
          context.effects.request({ kind: 'resizeBoard', boardSize: 3 });
          seen.push(context.effects.requested().length);

          return payload;
        },
      }),
    );

    dispatchStageEnd(bus);

    expect(seen).toEqual([0, 1]);
  });
});

describe('a handler writes the board through recorded effects', () => {
  it('carries a queue on the context that starts empty', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const seen: HookContext['effects'][] = [];

    register(
      bus,
      createSubscriber('reads-the-queue', {
        onStageEnd: (_payload, context): void => {
          seen.push(context.effects);
        },
      }),
    );

    bus.dispatch(
      'onStageEnd',
      createStageEndPayload(),
      createEnvironment(),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0].length).toBe(0);
    expect(seen[0].size).toBe(BOARD_SIZE);
    expect(Object.isFrozen(seen[0])).toBe(true);
  });

  it('writes an accepted handler s effects onto the live lattice', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const environment = createEnvironment();
    const board = environment.grid;

    register(
      bus,
      createSubscriber('inserts-a-tile', {
        onStageEnd: (_payload, context): void => {
          expect(context.effects.insertTile({ x: 3, y: 3 }, 8)).toBe(true);
        },
      }),
    );

    bus.dispatch('onStageEnd', createStageEndPayload(), environment);

    expect(board.cellContent({ x: 3, y: 3 })?.value).toBe(8);
  });

  it('keeps a THROWN handler s effects off the lattice entirely', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const environment = createEnvironment();
    const board = environment.grid;
    const before = board.serialize();

    register(
      bus,
      createSubscriber('writes-then-throws', {
        onStageEnd: (_payload, context): void => {
          context.effects.insertTile({ x: 3, y: 3 }, 8);
          context.effects.removeTile({ x: PAIR_X, y: PAIR_Y });
          context.effects.resizeBoard(2);

          throw new Error('relic handler failed');
        },
      }),
    );

    const result = bus.dispatch(
      'onStageEnd',
      createStageEndPayload(),
      environment,
    );

    expect(result.failed).toBe(1);
    expect(board.serialize()).toEqual(before);
    expect(board.size).toBe(BOARD_SIZE);
    expect(environment.config.boardSize).toBe(BOARD_SIZE);
  });

  it('keeps a REFUSED return s effects off the lattice entirely', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const environment = createEnvironment();
    const board = environment.grid;
    const before = board.serialize();

    register(
      bus,
      createSubscriber('writes-then-returns-a-bad-payload', {
        onStageEnd: (payload, context): StageEndPayload => {
          context.effects.insertTile({ x: 3, y: 3 }, 8);

          // `score` must be a finite number, so the bus refuses this return.
          return { ...payload, score: Number.NaN };
        },
      }),
    );

    const result = bus.dispatch(
      'onStageEnd',
      createStageEndPayload(),
      environment,
    );

    expect(result.rejected).toBe(1);
    expect(board.serialize()).toEqual(before);
  });

  it('lets a later handler read what an earlier one wrote', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const environment = createEnvironment();
    const seen: (number | null)[] = [];

    register(
      bus,
      createSubscriber('writes-first', {
        onStageEnd: (_payload, context): void => {
          context.effects.insertTile({ x: 3, y: 3 }, 8);
        },
      }),
    );
    register(
      bus,
      createSubscriber('reads-second', {
        onStageEnd: (_payload, context): void => {
          seen.push(context.grid.cellValue({ x: 3, y: 3 }));
        },
      }),
    );

    bus.dispatch('onStageEnd', createStageEndPayload(), environment);

    expect(seen).toEqual([8]);
  });

  it('projects the rules per handler, so a rules effect compounds', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const environment = createEnvironment();
    const seen: number[] = [];
    const installed = [0.25, 0.75];

    register(
      bus,
      createSubscriber('installs-weights', {
        onStageEnd: (_payload, context): void => {
          expect(context.effects.setSpawnWeights(installed)).toBe(true);
        },
      }),
    );
    register(
      bus,
      createSubscriber('reads-weights', {
        onStageEnd: (_payload, context): void => {
          seen.push(...context.config.spawn.weights);
        },
      }),
    );

    bus.dispatch('onStageEnd', createStageEndPayload(), environment);

    expect(seen).toEqual(installed);
    expect(environment.config.spawn.weights).toEqual(installed);
  });

  it('counts what it wrote and what it dropped', () => {
    const counted: EngineCountReport[] = [];
    const reporter: EngineReporter = {
      onCount: (report): void => {
        counted.push(report);
      },
    };
    const bus = createHookBus({ correlationId: CORRELATION_ID, reporter });
    const environment = createEnvironment();

    register(
      bus,
      createSubscriber('writes-one', {
        onStageEnd: (_payload, context): void => {
          context.effects.insertTile({ x: 3, y: 3 }, 8);
        },
      }),
    );
    register(
      bus,
      createSubscriber('writes-two-then-throws', {
        onStageEnd: (_payload, context): void => {
          context.effects.insertTile({ x: 3, y: 2 }, 8);
          context.effects.insertTile({ x: 3, y: 1 }, 8);

          throw new Error('relic handler failed');
        },
      }),
    );

    bus.dispatch('onStageEnd', createStageEndPayload(), environment);

    const applied = counted.find(
      (report): boolean => report.metric === 'engine.hook.effect.applied',
    );
    const dropped = counted.find(
      (report): boolean => report.metric === 'engine.hook.effect.dropped',
    );

    expect(applied?.value).toBe(1);
    expect(applied?.hook).toBe('onStageEnd');
    expect(dropped?.value).toBe(2);
  });

  it('says nothing at all for a handler that records no effect', () => {
    const counted: EngineCountReport[] = [];
    const reporter: EngineReporter = {
      onCount: (report): void => {
        counted.push(report);
      },
    };
    const bus = createHookBus({ correlationId: CORRELATION_ID, reporter });

    register(
      bus,
      createSubscriber('reads-only', {
        onStageEnd: (): void => undefined,
      }),
    );

    bus.dispatch(
      'onStageEnd',
      createStageEndPayload(),
      createEnvironment(),
    );

    expect(
      counted.filter((report): boolean =>
        report.metric.startsWith('engine.hook.effect.'),
      ),
    ).toEqual([]);
  });

  it('hands an inert queue to a dispatch carrying no usable board', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const recorded: boolean[] = [];
    const environment = {
      config: createDefaultRulesConfig(),
      rng: createRngStreams(RUN_SEED),
      grid: undefined,
    } as unknown as HookEnvironment;

    register(
      bus,
      createSubscriber('tries-to-write', {
        onStageEnd: (_payload, context): void => {
          recorded.push(context.effects.insertTile({ x: 0, y: 0 }, 2));
          recorded.push(context.effects.resizeBoard(2));
        },
      }),
    );

    expect(() => {
      bus.dispatch('onStageEnd', createStageEndPayload(), environment);
    }).not.toThrow();
    expect(recorded).toEqual([false, false]);
  });
});
