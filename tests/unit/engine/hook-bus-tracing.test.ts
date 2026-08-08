// The hook boundary's SPANS: `HookBusTracing`, the structural port the bus
// runs each dispatch and each handler inside.
//
// WHY THIS SUITE EXISTS
//   Rule 3's tracing capability names the chain input -> engine -> hook bus ->
//   relic handlers -> renderer. The two middle links live inside the bus, and
//   the bus may not name a module under src/observability — src/engine imports
//   nothing from there and that separation is load-bearing, because the engine
//   is the DOM-free, dependency-free half of the split (AAP R1). So the
//   wrappers are INJECTED, exactly as `RelicRegistryPort` is injected into the
//   run controller, and this suite pins the port's contract from the bus side:
//   what it is handed, when, in what order, and what happens when it is absent.
//
// The properties pinned here:
//   PRESENT — one dispatch span per dispatch, carrying the hook name, opened
//   whether or not a subscriber runs; one handler span per invoked handler,
//   carrying the hook name and the subscriber's id, in pickup order.
//   ABSENT — with no port the bus behaves exactly as it did before tracing
//   existed: nothing is called, nothing is allocated, every count is the same.
//   TRANSPARENT — the wrapper's return value is the dispatch's and the
//   handler's, so a wrapper is a measurement and never a transformation.
//   NON-INTERFERING — a handler that throws still has its throw contained by
//   the bus rather than by the wrapper, the charge guard still skips a spent
//   subscriber without opening a handler span, and a wrapper that itself
//   throws does not corrupt the walk.

import { describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import { Grid } from '../../../src/engine/grid';
import { createHookBus } from '../../../src/engine/hook-bus';
import { Tile } from '../../../src/engine/tile';
import type { HookBusTracing } from '../../../src/engine/hook-bus';
import type {
  AfterMoveDispatchPayload,
  AfterMovePayload,
  BeforeMoveDispatchPayload,
  BeforeMovePayload,
  HookEnvironment,
  HookName,
} from '../../../src/engine/hooks';
import { DIRECTION_LEFT, DIRECTION_UP } from '../../../src/engine/types';
import { createRngStreams } from '../../../src/rng/rng-streams';

/* ===== Harness ===== */

const RUN_SEED = 'blitzy-hook-tracing';

const BOARD_SIZE = 4;

function createEnvironment(): HookEnvironment {
  return {
    config: createDefaultRulesConfig(),
    rng: createRngStreams(RUN_SEED),
    grid: new Grid(BOARD_SIZE),
  };
}

function beforeMove(
  environment: HookEnvironment,
): BeforeMoveDispatchPayload {
  return { direction: DIRECTION_UP, board: environment.grid, cancelled: false };
}

function afterMove(environment: HookEnvironment): AfterMoveDispatchPayload {
  return {
    moved: true,
    board: environment.grid,
    score: 0,
    over: false,
    won: false,
    terminated: false,
  };
}

/** One recorded wrapper call, in the order the bus made it. */
interface TraceCall {
  readonly kind: 'dispatch' | 'handler';
  readonly hook: HookName;
  readonly relicId?: string;

  /** Whether the wrapped function had already returned when this was logged. */
  readonly completed: boolean;
}

interface TraceRecorder {
  readonly tracing: HookBusTracing;
  readonly calls: readonly TraceCall[];
  readonly names: readonly string[];
}

/**
 * A recorder standing in for `createBoundaryTracing`.
 *
 * Each wrapper runs the function it was handed and returns its value verbatim,
 * which is what a span wrapper does, and records the call around it so the
 * nesting is observable: a dispatch entry is logged before its handlers and its
 * completion after them.
 */
function createRecorder(): TraceRecorder {
  const calls: TraceCall[] = [];
  const names: string[] = [];

  const tracing: HookBusTracing = {
    traceHookDispatch: <T>(hook: HookName, run: () => T): T => {
      names.push(`dispatch:${hook}`);

      const value = run();

      calls.push({ kind: 'dispatch', hook, completed: true });

      return value;
    },

    traceRelicHandler: <T>(
      hook: HookName,
      relicId: string,
      run: () => T,
    ): T => {
      names.push(`handler:${hook}:${relicId}`);

      const value = run();

      calls.push({ kind: 'handler', hook, relicId, completed: true });

      return value;
    },
  };

  return { tracing, calls, names };
}

/* ==========================================================================
 * The dispatch span
 * ========================================================================== */

describe('the dispatch wrapper', () => {
  it('runs one span per dispatch, carrying the hook name', () => {
    const environment = createEnvironment();
    const recorder = createRecorder();
    const bus = createHookBus({ tracing: recorder.tracing });

    bus.dispatch('onBeforeMove', beforeMove(environment), environment);
    bus.dispatch('onAfterMove', afterMove(environment), environment);

    expect(recorder.names).toEqual([
      'dispatch:onBeforeMove',
      'dispatch:onAfterMove',
    ]);
  });

  it('opens even where no subscriber is registered for the hook', () => {
    const environment = createEnvironment();
    const recorder = createRecorder();
    const bus = createHookBus({ tracing: recorder.tracing });

    bus.register({
      id: 'elsewhere',
      hooks: { onAfterMove: (payload): AfterMovePayload => payload },
    });
    bus.dispatch('onBeforeMove', beforeMove(environment), environment);

    // A dispatch that reached nobody still cost the engine a dispatch, and a
    // trace that hid it would make an unsubscribed hook indistinguishable from
    // an unemitted one.
    expect(recorder.names).toEqual(['dispatch:onBeforeMove']);
  });

  it('returns the dispatch result the bus produced, unchanged', () => {
    const environment = createEnvironment();
    const recorder = createRecorder();
    const bus = createHookBus({ tracing: recorder.tracing });

    bus.register({
      id: 'veto',
      hooks: {
        onBeforeMove: (payload): BeforeMovePayload => ({
          ...payload,
          cancelled: true,
        }),
      },
    });

    const result = bus.dispatch(
      'onBeforeMove',
      beforeMove(environment),
      environment,
    );

    // The wrapper is a measurement, never a transformation: the veto still
    // reaches the caller.
    expect(result.payload.cancelled).toBe(true);
    expect(result.invoked).toBe(1);
  });

  it('encloses the handler spans of its own dispatch', () => {
    const environment = createEnvironment();
    const recorder = createRecorder();
    const bus = createHookBus({ tracing: recorder.tracing });

    bus.register({
      id: 'inner',
      hooks: { onBeforeMove: (payload): BeforeMovePayload => payload },
    });
    bus.dispatch('onBeforeMove', beforeMove(environment), environment);

    // Entered dispatch-first and completed dispatch-last, which is what makes
    // a handler span a CHILD of its dispatch rather than a sibling.
    expect(recorder.names).toEqual([
      'dispatch:onBeforeMove',
      'handler:onBeforeMove:inner',
    ]);
    expect(recorder.calls.map((call) => call.kind)).toEqual([
      'handler',
      'dispatch',
    ]);
  });
});

/* ==========================================================================
 * The handler span
 * ========================================================================== */

describe('the handler wrapper', () => {
  it('runs one span per invoked handler, in pickup order', () => {
    const environment = createEnvironment();
    const recorder = createRecorder();
    const bus = createHookBus({ tracing: recorder.tracing });

    bus.register({
      id: 'first',
      hooks: { onMerge: (payload) => payload },
    });
    bus.register({
      id: 'second',
      hooks: { onMerge: (payload) => payload },
    });

    bus.dispatch(
      'onMerge',
      {
        source: new Tile({ x: 0, y: 0 }, 2),
        target: new Tile({ x: 1, y: 0 }, 4),
        resultValue: 4,
        scoreDelta: 4,
      },
      environment,
    );

    expect(recorder.names).toEqual([
      'dispatch:onMerge',
      'handler:onMerge:first',
      'handler:onMerge:second',
    ]);
  });

  it('names the subscriber, so a slow relic is attributable to the relic', () => {
    const environment = createEnvironment();
    const recorder = createRecorder();
    const bus = createHookBus({ tracing: recorder.tracing });

    bus.register({
      id: 'temporal-anchor',
      hooks: { onAfterMove: (payload): AfterMovePayload => payload },
    });
    bus.dispatch('onAfterMove', afterMove(environment), environment);

    const handler = recorder.calls.find((call) => call.kind === 'handler');

    expect(handler?.relicId).toBe('temporal-anchor');
    expect(handler?.hook).toBe('onAfterMove');
  });

  it('opens no span for a subscriber the charge guard skipped', () => {
    const environment = createEnvironment();
    const recorder = createRecorder();
    const bus = createHookBus({ tracing: recorder.tracing });
    let invocations = 0;

    bus.register({
      id: 'spent',
      charges: 0,
      hooks: {
        onAfterMove: (payload): AfterMovePayload => {
          invocations += 1;

          return payload;
        },
      },
    });
    bus.dispatch('onAfterMove', afterMove(environment), environment);

    // The guard runs before the span, so a spent relic costs neither an
    // invocation nor a measurement.
    expect(invocations).toBe(0);
    expect(recorder.names).toEqual(['dispatch:onAfterMove']);
  });

  it('opens no span for a subscriber that bound a different hook', () => {
    const environment = createEnvironment();
    const recorder = createRecorder();
    const bus = createHookBus({ tracing: recorder.tracing });

    bus.register({
      id: 'spawn-only',
      hooks: {
        onSpawn: (payload) => payload,
      },
    });
    bus.dispatch('onBeforeMove', beforeMove(environment), environment);

    expect(recorder.names).toEqual(['dispatch:onBeforeMove']);
  });

  it('still spans a handler whose return the bus refuses', () => {
    const environment = createEnvironment();
    const recorder = createRecorder();
    const bus = createHookBus({ tracing: recorder.tracing });

    bus.register({
      id: 'nonsense',
      hooks: {
        onBeforeMove: (): BeforeMovePayload =>
          'not a payload' as unknown as BeforeMovePayload,
      },
    });

    const result = bus.dispatch(
      'onBeforeMove',
      beforeMove(environment),
      environment,
    );

    // The handler RAN, and how long it ran for is exactly what a trace of a
    // relic returning rubbish should show.
    expect(result.rejected).toBe(1);
    expect(recorder.names).toContain('handler:onBeforeMove:nonsense');
  });

  it('leaves a throwing handler contained by the bus', () => {
    const environment = createEnvironment();
    const recorder = createRecorder();
    const bus = createHookBus({ tracing: recorder.tracing });

    bus.register({
      id: 'thrower',
      hooks: {
        onBeforeMove: (): BeforeMovePayload => {
          throw new Error('relic fault');
        },
      },
    });
    bus.register({
      id: 'after',
      hooks: { onBeforeMove: (payload): BeforeMovePayload => payload },
    });

    const result = bus.dispatch(
      'onBeforeMove',
      beforeMove(environment),
      environment,
    );

    // The wrapper rethrows, the bus catches, the walk continues, and the
    // dispatch span still closes — so a fault is measured and contained.
    expect(result.failed).toBe(1);
    expect(result.invoked).toBe(2);
    expect(recorder.names).toEqual([
      'dispatch:onBeforeMove',
      'handler:onBeforeMove:thrower',
      'handler:onBeforeMove:after',
    ]);
    expect(
      recorder.calls.some(
        (call) => call.kind === 'handler' && call.relicId === 'thrower',
      ),
    ).toBe(false);
  });
});

/* ==========================================================================
 * The port is optional
 * ========================================================================== */

describe('a bus with no tracing port', () => {
  it('dispatches exactly as it did before tracing existed', () => {
    const environment = createEnvironment();
    const bus = createHookBus();
    let invoked = 0;

    bus.register({
      id: 'plain',
      hooks: {
        onBeforeMove: (payload): BeforeMovePayload => {
          invoked += 1;

          return payload;
        },
      },
    });

    const result = bus.dispatch(
      'onBeforeMove',
      beforeMove(environment),
      environment,
    );

    expect(invoked).toBe(1);
    expect(result.invoked).toBe(1);
    expect(result.failed).toBe(0);
    expect(bus.metrics().totals.dispatched).toBe(1);
  });

  it('accepts a port carrying only one of the two wrappers', () => {
    const environment = createEnvironment();
    const seen: string[] = [];
    const bus = createHookBus({
      tracing: {
        traceRelicHandler: <T>(
          hook: HookName,
          relicId: string,
          run: () => T,
        ): T => {
          seen.push(`${hook}:${relicId}`);

          return run();
        },
      },
    });

    bus.register({
      id: 'handler-only',
      hooks: { onBeforeMove: (payload): BeforeMovePayload => payload },
    });
    bus.dispatch('onBeforeMove', beforeMove(environment), environment);

    // Both members are optional, so a caller can measure one boundary without
    // the other and neither absence is an error.
    expect(seen).toEqual(['onBeforeMove:handler-only']);
  });

  it('counts a dispatch the same with the port as without it', () => {
    const environment = createEnvironment();
    const recorder = createRecorder();
    const traced = createHookBus({ tracing: recorder.tracing });
    const plain = createHookBus();

    for (const bus of [traced, plain]) {
      bus.register({
        id: 'same',
        charges: 2,
        hooks: {
          onBeforeMove: (payload, context): BeforeMovePayload => {
            context.spendCharge();

            return { ...payload, direction: DIRECTION_LEFT };
          },
        },
      });
      bus.dispatch('onBeforeMove', beforeMove(environment), environment);
    }

    const shape = (bus: ReturnType<typeof createHookBus>): unknown => {
      const metrics = bus.metrics();

      return {
        dispatched: metrics.totals.dispatched,
        invoked: metrics.totals.invoked,
        charges: metrics.chargesConsumed,
        budget: bus.subscribers()[0]?.charges,
      };
    };

    // Measuring a boundary must not change what crosses it.
    expect(shape(traced)).toEqual(shape(plain));
  });
});
