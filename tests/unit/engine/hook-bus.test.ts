// Contract suite for src/engine/hook-bus.ts, AAP Contract 2: the hook
// execution protocol, together with the six-name hook vocabulary of
// src/engine/hooks.ts. This suite is the executable counterpart of
// Figure 5, Hook Dispatch Sequence, in
// docs/architecture/hook-dispatch-sequence.md, and the sections named
// below pin that figure's four obligations.
//
// Constructs pinned, with the vanilla line range of each:
//   js/keyboard_input_manager.js L2      the listener table
//   js/keyboard_input_manager.js L18-L23 on(), now register()
//   js/keyboard_input_manager.js L25-L32 emit(), now dispatch()
//   js/game_manager.js L35-L59           setup(), now onStageStart
//   js/game_manager.js L134              the terminal-state guard, and
//   js/game_manager.js L113-L120         prepareTiles(), now onBeforeMove
//   js/game_manager.js L156-L170         the merge branch, now onMerge
//   js/game_manager.js L69-L76           addRandomTile(), and
//   js/game_manager.js L183              the post-move spawn, now onSpawn
//   js/game_manager.js L185-L189         the loss check and actuation,
//                                        now onAfterMove
//   js/local_storage_manager.js L32-L39  the only catch in the retired
//                                        sources, whose L37 discarded
//                                        its error object
//
// Properties with no vanilla analogue, each citing AAP Contract 2:
//   HOOK_NAMES, the six names
//   pickup-order dispatch
//   the charge guard, and consumeCharge as the one write path
//   error isolation, degraded() and the reported error
//   the compounding payload protocol
//   onStageEnd
//   unregister(), subscriptions() and subscribers()
//   metrics(), the dispatch-count snapshot
//
// The four Figure 5 obligations and the sections that pin them:
//   pickup-order dispatch  sections 8, 9 and 10
//   the charge guard       sections 11, 12 and 13
//   error isolation        sections 14 and 15
//   compounding            section 16
//
// Not pinned here, and pinned by the sibling suite named:
//   the emitter's own on(), emit() and off() semantics
//     -> tests/unit/engine/engine-events.test.ts
//   which hooks one turn dispatches, and whether a veto is honoured
//     -> tests/unit/engine/engine.test.ts
//   catalogue-level relic ordering, the sixteen relics, the seeded draw
//     -> tests/unit/relics
//
// Every subscriber below is hand-built and every handler is a vi.fn()
// spy. This suite reads no DOM and no storage, imports no module under
// src/observability, src/relics, src/render, src/run or src/ui, installs
// no mock library and writes no snapshot.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_BOARD_SIZE,
  createDefaultRulesConfig,
} from '../../../src/config/default-config';
import type { RulesConfig } from '../../../src/config/rules-config';
import { createHookBus } from '../../../src/engine/hook-bus';
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
  AfterMovePayload,
  BeforeMovePayload,
  HookContext,
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

/* ===== 1. Names, seeds and values the assertions use ===== */

/** The six hook names AAP Contract 2 requires, in turn order. */
const EXPECTED_HOOK_NAMES: readonly string[] = [
  'onStageStart',
  'onBeforeMove',
  'onMerge',
  'onSpawn',
  'onAfterMove',
  'onStageEnd',
];

/** How many names that is. */
const EXPECTED_HOOK_NAME_COUNT = 6;

/** Correlation identifier every bus below is constructed with. */
const RUN_ID = 'run-hook-bus-0001';

/** Seed every substream set below is derived from. */
const RUN_SEED = 'hook-bus-suite-seed';

/** Edge length every board below is built at. */
const BOARD_SIZE = DEFAULT_BOARD_SIZE;

/** Column index of the first merge-pair fixture tile. */
const PAIR_X = 0;

/** Column index of the second merge-pair fixture tile. */
const PAIR_NEXT_X = 1;

/** Row index of both merge-pair fixture tiles. */
const PAIR_Y = 0;

/** Face value of both merge-pair fixture tiles. */
const PAIR_VALUE = 2;

/** Face value js/game_manager.js L157 produced from two PAIR_VALUE tiles. */
const MERGED_VALUE = 4;

/** Amount js/game_manager.js L167 added for that merge. */
const MERGE_SCORE_DELTA = 4;

/** Stage index every stage payload below carries. */
const STAGE_INDEX = 2;

/** Score every stage payload below carries. */
const STAGE_SCORE = 132;

/** Face value js/game_manager.js L71 spawned nine times in ten. */
const SPAWN_VALUE = 2;

/** How many relics AAP §0.1.1.4 A1 fixes the catalogue at. */
const RELIC_CATALOGUE_SIZE = 16;

/* ===== 2. Type-level assertion helper ===== */

/**
 * Resolves to `true` where `Left` and `Right` are mutually assignable, and
 * to `false` otherwise. Assigning `true` to a binding of this type
 * compiles only where the two types match, so the assignment itself is
 * the assertion.
 */
type Exact<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;

/* ===== 3. Environment, board and payload builders ===== */

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
 * Builds the collaborators one dispatch is handed.
 *
 * @returns The rules in force, the run's substreams and a live board.
 */
function createEnvironment(): HookEnvironment {
  const config: RulesConfig = createDefaultRulesConfig();

  return {
    config,
    rng: createRngStreams(RUN_SEED),
    grid: createBoard(),
  };
}

/**
 * Builds an `onStageStart` payload.
 *
 * Ported from js/game_manager.js L35-L59. The goal is typed as
 * `StageStartPayload['goal']`; src/config/stage-config.ts is not imported
 * here.
 *
 * @returns The payload.
 */
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

/**
 * Builds an `onBeforeMove` payload, undispatched, so `cancelled` is
 * `false`.
 *
 * Ported from js/game_manager.js L134 and L113-L120.
 *
 * @param board Live board the move would resolve on.
 * @returns The payload.
 */
function createBeforeMovePayload(board: Grid): BeforeMovePayload {
  return { direction: DIRECTION_UP, board, cancelled: false };
}

/**
 * Builds an `onMerge` payload from two live tiles.
 *
 * Ported from js/game_manager.js L156-L170: `resultValue` is the value
 * L157 produced and `scoreDelta` the amount L167 added.
 *
 * @returns The payload.
 */
function createMergePayload(): MergePayload {
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

/**
 * Builds an `onSpawn` payload.
 *
 * Ported from js/game_manager.js L69-L76 and L183.
 *
 * @returns The payload, carrying an available cell.
 */
function createSpawnPayload(): SpawnPayload {
  return { position: { x: PAIR_NEXT_X, y: PAIR_NEXT_X }, value: SPAWN_VALUE };
}

/**
 * Builds an `onAfterMove` payload.
 *
 * Ported from js/game_manager.js L185-L189.
 *
 * @param board Live board as the move left it.
 * @returns The payload.
 */
function createAfterMovePayload(board: Grid): AfterMovePayload {
  return {
    moved: true,
    board,
    score: STAGE_SCORE,
    over: false,
    won: false,
    terminated: false,
  };
}

/**
 * Builds an `onStageEnd` payload.
 *
 * AAP Contract 2: no vanilla analogue.
 *
 * @returns The payload.
 */
function createStageEndPayload(): StageEndPayload {
  return {
    stageIndex: STAGE_INDEX,
    cleared: true,
    score: STAGE_SCORE,
  };
}

/**
 * Builds one payload for each of the six hook names.
 *
 * @param board Live board the two board-carrying payloads reference.
 * @returns The six payloads, keyed by hook name.
 */
function createPayloadsByHook(board: Grid): HookPayloadMap {
  return {
    onStageStart: createStageStartPayload(),
    onBeforeMove: createBeforeMovePayload(board),
    onMerge: createMergePayload(),
    onSpawn: createSpawnPayload(),
    onAfterMove: createAfterMovePayload(board),
    onStageEnd: createStageEndPayload(),
  };
}

/* ===== 4. Report recorders ===== */

/** A reporter paired with the reports it received, in arrival order. */
interface RecordingReporter {
  /** The sink to inject into the bus. */
  readonly reporter: EngineReporter;

  /** Every caught handler error handed to `onHookError`. */
  readonly errors: EngineHookErrorReport[];

  /** Every countable occurrence handed to `onCount`. */
  readonly counts: EngineCountReport[];
}

/**
 * Builds a reporter that records every report it is handed.
 *
 * The injection seam AAP §0.9.3 requires: the bus reaches its report sink
 * through this interface and names no module under src/observability.
 *
 * @returns The sink and the two arrays it appends to.
 */
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

/* ===== 5. Subscriber builders ===== */

/** Charges, state and pickup order a subscriber may carry. */
type SubscriberExtras = Partial<
  Pick<HookSubscriber, 'charges' | 'state' | 'pickupOrder'>
>;

/**
 * Builds a subscriber from a handler table supplied by the caller.
 *
 * @param id Identifier.
 * @param hooks Handler table to bind.
 * @param extras Charges, state and pickup order to carry.
 * @returns The subscriber, ready to register.
 */
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

/**
 * Builds a subscriber whose `onStageEnd` handler appends `id` to `order`
 * when it runs and transforms no payload.
 *
 * @param id Identifier, and the label the handler appends.
 * @param order Array every handler built this way appends to.
 * @param extras Charges, state and pickup order to carry.
 * @returns The subscriber, ready to register.
 */
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

/**
 * Registers a subscriber and fails the test where the bus rejected it.
 *
 * @param bus Bus to register on.
 * @param subscriber Subscriber to register.
 */
function register(bus: HookBus, subscriber: HookSubscriber): void {
  expect(bus.register(subscriber)).toBe(true);
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

/* ===== 6. The six hook names (requirement R2, AAP Contract 2) ===== */

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
    const bus = createHookBus({ runId: RUN_ID });
    const board = createBoard();
    const payloads = createPayloadsByHook(board);
    const environment = createEnvironment();

    for (const hook of HOOK_NAMES) {
      const result = bus.dispatch(hook, payloads[hook], environment);

      expect(result.payload).toBe(payloads[hook]);
      expect(result.invoked).toBe(0);
    }

    expect(bus.metrics().totals.dispatched).toBe(EXPECTED_HOOK_NAME_COUNT);
  });

  it('reaches a handler bound to each of the six names', () => {
    const bus = createHookBus({ runId: RUN_ID });
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
    const bus = createHookBus({ runId: RUN_ID });
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

/* ===== 7. Construction (js/keyboard_input_manager.js L1-L16) ===== */

describe('createHookBus (js/keyboard_input_manager.js L1-L16)', () => {
  it('constructs with no argument at all', () => {
    const bus = createHookBus();

    expect(bus.subscribers()).toEqual([]);
    expect(bus.degraded()).toEqual([]);
    expect(dispatchStageEnd(bus).invoked).toBe(0);
  });

  it('defaults the correlation identifier to the empty string', () => {
    expect(createHookBus().metrics().runId).toBe('');
  });

  it('carries the correlation identifier it was constructed with', () => {
    expect(createHookBus({ runId: RUN_ID }).metrics().runId).toBe(RUN_ID);
  });

  it('starts every counter at zero, as L2 started an empty table', () => {
    const metrics: HookBusMetrics = createHookBus({ runId: RUN_ID }).metrics();

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
    const bus = createHookBus({ runId: RUN_ID });

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

  it('hands the dispatch environment to a handler unchanged', () => {
    const bus = createHookBus({ runId: RUN_ID });
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
    expect(context.config).toBe(environment.config);
    expect(context.rng).toBe(environment.rng);
    expect(context.grid).toBe(environment.grid);
  });

  it('identifies the dispatch on the context it builds', () => {
    const bus = createHookBus({ runId: RUN_ID });
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

    expect(context.runId).toBe(RUN_ID);
    expect(context.hook).toBe('onStageEnd');
    expect(context.subscriberId).toBe('identified');
    expect(context.pickupOrder).toBe(7);
    expect(context.charges).toBe(4);
    expect(context.state).toEqual({ visits: 0 });
  });

  it('writes the context state slot back onto the subscriber', () => {
    const bus = createHookBus({ runId: RUN_ID });
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

    expect(subscriber.state).toBe(1);

    dispatchStageEnd(bus);

    expect(subscriber.state).toBe(2);
  });
});

/* ===== 8. Figure 5 obligation 1: dispatch walks pickup order ===== */

describe('dispatch walks subscribers in pickup order (AAP Contract 2)', () => {
  it('fires three handlers on one hook in pickup order', () => {
    const bus = createHookBus({ runId: RUN_ID });
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
    const bus = createHookBus({ runId: RUN_ID });
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
    const bus = createHookBus({ runId: RUN_ID });
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
    const bus = createHookBus({ runId: RUN_ID });
    const order: string[] = [];

    register(bus, createStageEndRecorder('late', order, { pickupOrder: 5 }));
    register(bus, createStageEndRecorder('early', order, { pickupOrder: 1 }));

    expect(
      bus.subscribers().map((subscriber): string => subscriber.id),
    ).toEqual(['early', 'late']);
    expect(Object.isFrozen(bus.subscribers())).toBe(true);
  });

  it('breaks a shared pickup index by registration sequence', () => {
    const bus = createHookBus({ runId: RUN_ID });
    const order: string[] = [];

    register(bus, createStageEndRecorder('tied-a', order, { pickupOrder: 3 }));
    register(bus, createStageEndRecorder('tied-b', order, { pickupOrder: 3 }));
    register(bus, createStageEndRecorder('tied-c', order, { pickupOrder: 3 }));

    dispatchStageEnd(bus);

    expect(order).toEqual(['tied-a', 'tied-b', 'tied-c']);
  });
});

/* ===== 9. Pickup order is not an artefact of registration order ===== */

describe(
  'pickup order overrides registration order, which the vanilla bus ' +
    'could not do (js/keyboard_input_manager.js L18-L23, L25-L32)',
  () => {
    it('fires in pickup order when registered in the reverse of it', () => {
      const bus = createHookBus({ runId: RUN_ID });
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
      const bus = createHookBus({ runId: RUN_ID });
      const order: string[] = [];

      register(bus, createStageEndRecorder('c', order, { pickupOrder: 20 }));
      register(bus, createStageEndRecorder('a', order, { pickupOrder: 5 }));
      register(bus, createStageEndRecorder('d', order, { pickupOrder: 31 }));
      register(bus, createStageEndRecorder('b', order, { pickupOrder: 12 }));

      dispatchStageEnd(bus);

      expect(order).toEqual(['a', 'b', 'c', 'd']);
    });

    it('holds a subscriber ahead of one registered before it', () => {
      const bus = createHookBus({ runId: RUN_ID });
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

/* ===== 10. Dispatch order is part of the reproducibility contract ===== */

describe(
  'dispatch order is stable, so RNG consumption order is reproducible ' +
    '(AAP Contract 2, validation gate V2)',
  () => {
    it('repeats the same order across four dispatches', () => {
      const bus = createHookBus({ runId: RUN_ID });
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
      const bus = createHookBus({ runId: RUN_ID });
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
        const bus = createHookBus({ runId: RUN_ID });

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

/* ===== 11. Figure 5 obligation 2: the charge guard lives in the bus ===== */

describe('the charge guard skips a spent subscriber (AAP Contract 2)', () => {
  it('never invokes a handler whose charges are zero', () => {
    const bus = createHookBus({ runId: RUN_ID });
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
    const bus = createHookBus({ runId: RUN_ID });
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
    const bus = createHookBus({ runId: RUN_ID });
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
    const bus = createHookBus({ runId: RUN_ID });
    const order: string[] = [];

    register(bus, createStageEndRecorder('funded', order, { charges: 1 }));

    expect(dispatchStageEnd(bus).invoked).toBe(1);
    expect(order).toEqual(['funded']);
  });

  it('treats absent charges as unlimited and always fires', () => {
    const bus = createHookBus({ runId: RUN_ID });
    const order: string[] = [];

    register(bus, createStageEndRecorder('unlimited', order));

    dispatchStageEnd(bus);
    dispatchStageEnd(bus);
    dispatchStageEnd(bus);

    expect(order).toEqual(['unlimited', 'unlimited', 'unlimited']);
    expect(bus.metrics().totals.skippedExhausted).toBe(0);
  });

  it('throws nothing when every subscriber is spent', () => {
    const bus = createHookBus({ runId: RUN_ID });

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
    const bus = createHookBus({ runId: RUN_ID });
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
    const bus = createHookBus({ runId: RUN_ID });
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
    const bus = createHookBus({ runId: RUN_ID });
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

  it('records a skipped handler as exhausted, not as failed', () => {
    const bus = createHookBus({ runId: RUN_ID });

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

/* ===== 12. One guard in the bus covers every charge-bearing relic ===== */

describe(
  'one guard in the bus satisfies the zero-charge case for all sixteen ' +
    'relics, so no handler carries its own guard (AAP Contract 2)',
  () => {
    it('skips sixteen spent subscribers without invoking one', () => {
      const bus = createHookBus({ runId: RUN_ID });
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
      const bus = createHookBus({ runId: RUN_ID });
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

/* ===== 13. consumeCharge is the one path that writes charges ===== */

describe('consumeCharge is the only path that writes charges ' +
  '(AAP Contract 2)', () => {
  it('leaves charges untouched across a dispatch that invoked a handler',
    () => {
      const bus = createHookBus({ runId: RUN_ID });
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
    const bus = createHookBus({ runId: RUN_ID });
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
    expect(subscriber.charges).toBe(2);
    expect(Object.isFrozen(consumption)).toBe(true);
  });

  it('stops firing after exactly the charges it held are consumed', () => {
    const bus = createHookBus({ runId: RUN_ID });
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
    const bus = createHookBus({ runId: RUN_ID });
    const subscriber = createSubscriber(
      'holds-two',
      { onStageEnd: (): void => undefined },
      { charges: 2 },
    );

    register(bus, subscriber);

    const overdraw = bus.consumeCharge('holds-two', 5);

    expect(overdraw.consumed).toBe(2);
    expect(overdraw.remaining).toBe(0);
    expect(subscriber.charges).toBe(2 - 2);
  });

  it('deducts nothing from a budget already spent', () => {
    const bus = createHookBus({ runId: RUN_ID });

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
    const bus = createHookBus({ runId: RUN_ID });
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
    const bus = createHookBus({ runId: RUN_ID });
    const consumption = bus.consumeCharge('never-registered');

    expect(consumption.held).toBe(false);
    expect(consumption.limited).toBe(false);
    expect(consumption.consumed).toBe(0);
    expect(consumption.remaining).toBeUndefined();
  });

  it('normalises a budget that is not a whole number as it writes it', () => {
    const bus = createHookBus({ runId: RUN_ID });
    const subscriber = createSubscriber(
      'fractional',
      { onStageEnd: (): void => undefined },
      { charges: 2.7 },
    );

    register(bus, subscriber);

    const consumption = bus.consumeCharge('fractional');

    expect(consumption.consumed).toBe(1);
    expect(consumption.remaining).toBe(1);
    expect(subscriber.charges).toBe(1);
  });

  it('reports every deduction on the snapshot', () => {
    const bus = createHookBus({ runId: RUN_ID });

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

/* ===== 14. Figure 5 obligation 3: error isolation ===== */

describe(
  'a throwing handler is contained, where the vanilla bus let a throw ' +
    'escape (js/keyboard_input_manager.js L25-L32)',
  () => {
    it('does not propagate a handler throw out of dispatch', () => {
      const bus = createHookBus({ runId: RUN_ID });

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
      const bus = createHookBus({ runId: RUN_ID });
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
      const bus = createHookBus({ runId: RUN_ID });

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
      const bus = createHookBus({ runId: RUN_ID });
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
      const bus = createHookBus({ runId: RUN_ID });
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

      expect(result.payload).toBe(transformed);
      expect(result.payload).not.toBe(original);
      expect(result.payload).not.toBeUndefined();
      expect(result.failed).toBe(1);
    });

    it('fires the subscribers after a thrower, in pickup order, on the ' +
      'last good payload', () => {
      const bus = createHookBus({ runId: RUN_ID });
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
      expect(result.payload).toBe(transformed);
    });

    it('skips a degraded subscriber on every later dispatch', () => {
      const bus = createHookBus({ runId: RUN_ID });
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
      const bus = createHookBus({ runId: RUN_ID });
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
        const bus = createHookBus({ runId: RUN_ID });

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
        runId: RUN_ID,
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
          runId: RUN_ID,
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
        runId: RUN_ID,
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

/* ===== 15. The report carries the run correlation identifier ===== */

describe(
  'the caught error is reported through the injected reporter and carries ' +
    'the run correlation identifier, where js/local_storage_manager.js ' +
    'L32-L39 discarded its error object (AAP §0.9.3)',
  () => {
    it('hands the caught error to the injected reporter', () => {
      const recording = createRecordingReporter();
      const bus = createHookBus({
        runId: RUN_ID,
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
        runId: RUN_ID,
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

      expect(recording.errors[0].runId).toBe(RUN_ID);
    });

    it('carries the correlation identifier of the bus that caught it', () => {
      const firstRecording = createRecordingReporter();
      const secondRecording = createRecordingReporter();
      const secondRunId = 'run-hook-bus-0002';
      const thrower: HookHandlerTable = {
        onStageEnd: (): StageEndPayload => {
          throw new Error('relic handler failed');
        },
      };

      const firstBus = createHookBus({
        runId: RUN_ID,
        reporter: firstRecording.reporter,
      });
      const secondBus = createHookBus({
        runId: secondRunId,
        reporter: secondRecording.reporter,
      });

      register(firstBus, createSubscriber('thrower', thrower));
      register(secondBus, createSubscriber('thrower', thrower));
      dispatchStageEnd(firstBus);
      dispatchStageEnd(secondBus);

      expect(firstRecording.errors[0].runId).toBe(RUN_ID);
      expect(secondRecording.errors[0].runId).toBe(secondRunId);
      expect(firstRecording.errors[0].runId).not.toBe(
        secondRecording.errors[0].runId,
      );
    });

    it('names the hook and the subscriber the error came from', () => {
      const recording = createRecordingReporter();
      const bus = createHookBus({
        runId: RUN_ID,
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
      expect(report.runId).toBe(RUN_ID);
    });

    it('reports one error per throw, in pickup order', () => {
      const recording = createRecordingReporter();
      const bus = createHookBus({
        runId: RUN_ID,
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
        recording.errors.every((report): boolean => report.runId === RUN_ID),
      ).toBe(true);
    });

    it('reports nothing while every handler returns normally', () => {
      const recording = createRecordingReporter();
      const bus = createHookBus({
        runId: RUN_ID,
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

/* ===== 16. Figure 5 obligation 4: the compounding payload protocol ===== */

describe(
  'each handler receives the payload the handler before it returned ' +
    '(AAP Contract 2)',
  () => {
    it('hands the second subscriber what the first returned', () => {
      const bus = createHookBus({ runId: RUN_ID });
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
      const bus = createHookBus({ runId: RUN_ID });
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
        const bus = createHookBus({ runId: RUN_ID });
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
      const bus = createHookBus({ runId: RUN_ID });

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
      const bus = createHookBus({ runId: RUN_ID });
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
      const bus = createHookBus({ runId: RUN_ID });
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

      expect(result.payload).toBe(original);
      expect(observed[0]).toBe(original);
      expect(result.rejected).toBe(0);
      expect(result.invoked).toBe(2);
    });

    it('does not blank the payload where every handler only observes', () => {
      const bus = createHookBus({ runId: RUN_ID });
      const order: string[] = [];

      register(bus, createStageEndRecorder('observer-a', order, {
        pickupOrder: 0,
      }));
      register(bus, createStageEndRecorder('observer-b', order, {
        pickupOrder: 1,
      }));

      const original = createStageEndPayload();
      const result = bus.dispatch('onStageEnd', original, createEnvironment());

      expect(result.payload).toBe(original);
      expect(result.payload).not.toBeUndefined();
      expect(order).toEqual(['observer-a', 'observer-b']);
    });

    it('carries a payload mutated in place through to the caller', () => {
      const bus = createHookBus({ runId: RUN_ID });
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

      expect(result.payload).toBe(original);
      expect(result.payload.cancelled).toBe(true);
    });

    it('carries a freshly returned object through to the caller', () => {
      const bus = createHookBus({ runId: RUN_ID });
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
      expect(result.payload.board).toBe(board);
      expect(result.payload.direction).toBe(DIRECTION_UP);
    });

    it('discards a return that is not a payload and keeps the payload',
      () => {
        const bus = createHookBus({ runId: RUN_ID });
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

        expect(result.payload).toBe(original);
        expect(observed[0]).toBe(original);
        expect(result.rejected).toBe(1);
        expect(result.failed).toBe(0);
      });

    it('discards an array return and keeps the payload', () => {
      const bus = createHookBus({ runId: RUN_ID });

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

    it('does not leak a transformation from one hook into another', () => {
      const bus = createHookBus({ runId: RUN_ID });
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
      const bus = createHookBus({ runId: RUN_ID });

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

/* ===== 17. The cancellable onBeforeMove veto ===== */

describe(
  'a subscriber vetoes a move on the onBeforeMove payload ' +
    '(js/game_manager.js L134)',
  () => {
    it('dispatches onBeforeMove with the veto unset', () => {
      const bus = createHookBus({ runId: RUN_ID });
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
      const bus = createHookBus({ runId: RUN_ID });
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
      const bus = createHookBus({ runId: RUN_ID });
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

      const result = bus.dispatch(
        'onBeforeMove',
        createBeforeMovePayload(board),
        createEnvironment(),
      );

      expect(result.payload.cancelled).toBe(true);
      expect(result.payload.direction).toBe(DIRECTION_UP);
      expect(result.payload.board).toBe(board);
    });

    it('keeps a veto set by an early subscriber past later ones that do ' +
      'not clear it', () => {
      const bus = createHookBus({ runId: RUN_ID });
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
      const bus = createHookBus({ runId: RUN_ID });
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
      const bus = createHookBus({ runId: RUN_ID });
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
      const bus = createHookBus({ runId: RUN_ID });
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
      const bus = createHookBus({ runId: RUN_ID });
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

/* ===== 18. The dispatch-count snapshot (AAP §0.9.3) ===== */

describe(
  'metrics reports dispatch counts per hook and per subscriber as plain ' +
    'data, reachable without any observability import (AAP §0.9.3)',
  () => {
    it('carries a row for each of the six names, dispatched or not', () => {
      const bus = createHookBus({ runId: RUN_ID });

      dispatchStageEnd(bus);

      const metrics = bus.metrics();

      expect(Object.keys(metrics.hooks)).toEqual([...EXPECTED_HOOK_NAMES]);
      expect(metrics.hooks.onStageEnd.dispatched).toBe(1);
      expect(metrics.hooks.onMerge.dispatched).toBe(0);
      expect(metrics.hooks.onSpawn.dispatched).toBe(0);
    });

    it('counts one dispatch per hook, per call', () => {
      const bus = createHookBus({ runId: RUN_ID });
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
      const bus = createHookBus({ runId: RUN_ID });
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
      const bus = createHookBus({ runId: RUN_ID });

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
      const bus = createHookBus({ runId: RUN_ID });

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
      const bus = createHookBus({ runId: RUN_ID });
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
      const bus = createHookBus({ runId: RUN_ID });
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
      const bus = createHookBus({ runId: RUN_ID });
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
      const bus = createHookBus({ runId: RUN_ID });
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
      const bus = createHookBus({ runId: RUN_ID });
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
      const bus = createHookBus({ runId: RUN_ID });
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
      const bus = createHookBus({ runId: RUN_ID });

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
        runId: RUN_ID,
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
          (report): boolean => report.runId === RUN_ID,
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
      const bus = createHookBus({ runId: RUN_ID });
      const counters = bus.metrics().hooks.onStageEnd;

      expect(reasons).toHaveLength(3);
      expect(counters.skippedExhausted).toBe(0);
      expect(counters.skippedDegraded).toBe(0);
      expect(counters.skippedDetached).toBe(0);
    });
  },
);

/* ===== 19. Registration lifecycle ===== */

describe('register and unregister (js/keyboard_input_manager.js L18-L23, ' +
  'AAP Contract 2)', () => {
  it('takes on a subscriber and reports it registered', () => {
    const bus = createHookBus({ runId: RUN_ID });
    const order: string[] = [];

    expect(bus.register(createStageEndRecorder('taken-on', order))).toBe(true);
    expect(
      bus.subscribers().map((subscriber): string => subscriber.id),
    ).toEqual(['taken-on']);
    expect(bus.metrics().registered).toBe(1);
  });

  it('removes a subscriber and never invokes it again', () => {
    const bus = createHookBus({ runId: RUN_ID });
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
    const bus = createHookBus({ runId: RUN_ID });
    const order: string[] = [];

    register(bus, createStageEndRecorder('removable', order));

    expect(bus.unregister('removable')).toBe(true);
    expect(bus.unregister('removable')).toBe(false);
    expect(bus.unregister('never-registered')).toBe(false);
    expect(bus.metrics().removedSubscribers).toBe(1);
  });

  it('rejects a second registration under an identifier already held', () => {
    const bus = createHookBus({ runId: RUN_ID });
    const order: string[] = [];
    const first = createStageEndRecorder('duplicated', order);
    const second = createStageEndRecorder('duplicated', order);

    expect(bus.register(first)).toBe(true);
    expect(bus.register(second)).toBe(false);
    expect(bus.subscribers()).toHaveLength(1);
    expect(bus.subscribers()[0]).toBe(first);

    dispatchStageEnd(bus);

    expect(order).toEqual(['duplicated']);
  });

  it('takes the identifier again once it has been removed', () => {
    const bus = createHookBus({ runId: RUN_ID });
    const order: string[] = [];

    register(bus, createStageEndRecorder('recycled', order));
    expect(bus.unregister('recycled')).toBe(true);
    expect(bus.register(createStageEndRecorder('recycled', order))).toBe(true);

    dispatchStageEnd(bus);

    expect(order).toEqual(['recycled']);
  });

  it('clears the degraded mark when the identifier is registered again',
    () => {
      const bus = createHookBus({ runId: RUN_ID });
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
    const bus = createHookBus({ runId: RUN_ID });
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
    const bus = createHookBus({ runId: RUN_ID });

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
      const bus = createHookBus({ runId: RUN_ID });

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
    const bus = createHookBus({ runId: RUN_ID });
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
    const bus = createHookBus({ runId: RUN_ID });
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
    const bus = createHookBus({ runId: RUN_ID });
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
    const bus = createHookBus({ runId: RUN_ID });
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
    const bus = createHookBus({ runId: RUN_ID });
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

  it('reads charges and state from the subscriber at call time', () => {
    const bus = createHookBus({ runId: RUN_ID });
    const subscriber = createSubscriber(
      'mutable',
      { onStageEnd: (): void => undefined },
      { charges: 3, state: 'initial' },
    );

    register(bus, subscriber);

    expect(bus.subscriptions('onStageEnd')[0].charges).toBe(3);
    expect(bus.subscriptions('onStageEnd')[0].state).toBe('initial');

    bus.consumeCharge('mutable');
    subscriber.state = 'later';

    expect(bus.subscriptions('onStageEnd')[0].charges).toBe(2);
    expect(bus.subscriptions('onStageEnd')[0].state).toBe('later');
  });
});

/* ===== 20. Type-level payload mapping ===== */

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

    const bus = createHookBus({ runId: RUN_ID });

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

    const bus = createHookBus({ runId: RUN_ID });

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
    const bus = createHookBus({ runId: RUN_ID });
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
    const bus = createHookBus({ runId: RUN_ID });
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
