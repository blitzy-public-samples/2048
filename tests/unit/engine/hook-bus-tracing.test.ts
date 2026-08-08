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

/* ==========================================================================
 * The wrapped work runs exactly once
 * ========================================================================== */

describe('a wrapper cannot suppress, repeat or substitute the work', () => {
  /** A handler that draws, spends and records, then throws. */
  const failingSubscriber = (
    counter: { invocations: number },
  ): Parameters<ReturnType<typeof createHookBus>['register']>[0] => ({
    id: 'thrower',
    charges: 3,
    hooks: {
      onBeforeMove: (_payload, context): BeforeMovePayload => {
        counter.invocations += 1;
        context.rng.stream('spawn-value').next();
        context.spendCharge();
        context.effects.insertTile({ x: 0, y: 0 }, 4);

        throw new Error('relic fault');
      },
    },
  });

  it('invokes a throwing handler once, not twice, under a wrapper', () => {
    const environment = createEnvironment();
    const counter = { invocations: 0 };
    const bus = createHookBus({ tracing: createRecorder().tracing });

    bus.register(failingSubscriber(counter));

    const result = bus.dispatch(
      'onBeforeMove',
      beforeMove(environment),
      environment,
    );

    // ONE invocation, and its whole transaction rolled back: the retry the
    // wrapper's rethrow used to trigger re-entered the handler inside the
    // transaction that was already open.
    expect(counter.invocations).toBe(1);
    expect(result.invoked).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.effectsApplied).toBe(0);
    expect(bus.metrics().chargesConsumed).toBe(0);
    expect(bus.subscribers()[0]?.charges).toBe(3);
    expect(environment.rng.snapshotCursors()['spawn-value']).toBe(0);
    expect(environment.grid.cellsAvailable()).toBe(true);
    expect(environment.grid.cellContent({ x: 0, y: 0 })).toBeNull();
  });

  it('leaves the identical outcome with tracing and without it', () => {
    const traced = createHookBus({ tracing: createRecorder().tracing });
    const plain = createHookBus();
    const shapes: unknown[] = [];

    for (const bus of [traced, plain]) {
      const environment = createEnvironment();
      const counter = { invocations: 0 };

      bus.register(failingSubscriber(counter));

      const result = bus.dispatch(
        'onBeforeMove',
        beforeMove(environment),
        environment,
      );

      shapes.push({
        invocations: counter.invocations,
        invoked: result.invoked,
        failed: result.failed,
        effectsApplied: result.effectsApplied,
        charges: bus.subscribers()[0]?.charges,
        consumed: bus.metrics().chargesConsumed,
        cursors: environment.rng.snapshotCursors(),
        degraded: bus.metrics().degraded,
      });
    }

    // R5: the observer is non-interfering, on the failing path as well as the
    // succeeding one.
    expect(shapes[0]).toEqual(shapes[1]);
  });

  it('runs the work when a wrapper returns without calling it', () => {
    const environment = createEnvironment();
    let invoked = 0;
    const bus = createHookBus({
      tracing: {
        // A wrapper that measures nothing and calls nothing.
        traceRelicHandler: <T>(): T => undefined as T,
        traceHookDispatch: <T>(_hook: HookName, run: () => T): T => run(),
      },
    });

    bus.register({
      id: 'unwrapped',
      hooks: {
        onBeforeMove: (payload): BeforeMovePayload => {
          invoked += 1;

          return { ...payload, direction: DIRECTION_LEFT };
        },
      },
    });

    const result = bus.dispatch(
      'onBeforeMove',
      beforeMove(environment),
      environment,
    );

    // The handler ran, its return was adopted, and the wrapper's own
    // `undefined` did not stand in for work that never happened.
    expect(invoked).toBe(1);
    expect(result.payload.direction).toBe(DIRECTION_LEFT);
    expect(result.rejected).toBe(0);
    expect(bus.metrics().hooks.onBeforeMove.invoked).toBe(1);
  });

  it('runs the work once when a wrapper calls it twice', () => {
    const environment = createEnvironment();
    let invoked = 0;
    const bus = createHookBus({
      tracing: {
        traceRelicHandler: <T>(
          _hook: HookName,
          _relicId: string,
          run: () => T,
        ): T => {
          run();

          return run();
        },
      },
    });

    bus.register({
      id: 'doubled',
      charges: 2,
      hooks: {
        onBeforeMove: (payload, context): BeforeMovePayload => {
          invoked += 1;
          context.spendCharge();

          return payload;
        },
      },
    });

    bus.dispatch('onBeforeMove', beforeMove(environment), environment);

    // The second call replays the first outcome rather than re-entering the
    // handler, so exactly one charge is spent.
    expect(invoked).toBe(1);
    expect(bus.metrics().chargesConsumed).toBe(1);
    expect(bus.subscribers()[0]?.charges).toBe(1);
  });

  it('replays the held throw when a wrapper calls a failing work twice', () => {
    const environment = createEnvironment();
    let invoked = 0;
    const bus = createHookBus({
      tracing: {
        traceRelicHandler: <T>(
          _hook: HookName,
          _relicId: string,
          run: () => T,
        ): T => {
          try {
            run();
          } catch {
            // Swallowed here, and asked for again, which is the shape that used
            // to re-enter the handler.
          }

          return run();
        },
      },
    });

    bus.register({
      id: 'thrower',
      hooks: {
        onBeforeMove: (): BeforeMovePayload => {
          invoked += 1;

          throw new Error('relic fault');
        },
      },
    });

    const result = bus.dispatch(
      'onBeforeMove',
      beforeMove(environment),
      environment,
    );

    expect(invoked).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('propagates the work s throw when a wrapper swallows it', () => {
    const environment = createEnvironment();
    let invoked = 0;
    const bus = createHookBus({
      tracing: {
        traceRelicHandler: <T>(
          _hook: HookName,
          _relicId: string,
          run: () => T,
        ): T => {
          try {
            return run();
          } catch {
            // A wrapper that reports and returns rather than rethrowing.
            return undefined as T;
          }
        },
      },
    });

    bus.register({
      id: 'thrower',
      charges: 2,
      hooks: {
        onBeforeMove: (_payload, context): BeforeMovePayload => {
          invoked += 1;
          context.spendCharge();

          throw new Error('relic fault');
        },
      },
    });

    const result = bus.dispatch(
      'onBeforeMove',
      beforeMove(environment),
      environment,
    );

    // The bus, not the wrapper, decides what a throw costs: the failure is
    // still counted and the budget is still untouched.
    expect(invoked).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.invoked).toBe(1);
    expect(bus.subscribers()[0]?.charges).toBe(2);
    expect(bus.metrics().degraded).toContain('thrower');
  });

  it('returns the work s value when a wrapper returns another', () => {
    const environment = createEnvironment();
    const bus = createHookBus({
      tracing: {
        traceHookDispatch: <T>(_hook: HookName, run: () => T): T => {
          run();

          return { payload: 'nonsense' } as T;
        },
      },
    });

    bus.register({
      id: 'measured',
      hooks: { onBeforeMove: (payload): BeforeMovePayload => payload },
    });

    const result = bus.dispatch(
      'onBeforeMove',
      beforeMove(environment),
      environment,
    );

    // A wrapper is a measurement and never a transformation, at the dispatch
    // boundary as well as the handler one.
    expect(result.invoked).toBe(1);
    expect(result.payload.direction).toBe(DIRECTION_UP);
    expect(bus.metrics().totals.dispatched).toBe(1);
  });

  it('runs the dispatch when a wrapper throws before calling it', () => {
    const environment = createEnvironment();
    let invoked = 0;
    const bus = createHookBus({
      tracing: {
        traceHookDispatch: <T>(): T => {
          throw new Error('tracing fault');
        },
      },
    });

    bus.register({
      id: 'still-runs',
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

    // The instrumentation's own failure is contained and the walk still
    // happened, exactly once.
    expect(invoked).toBe(1);
    expect(result.invoked).toBe(1);
    expect(bus.metrics().totals.dispatched).toBe(1);
  });
});
