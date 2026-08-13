// The charge DECREMENT: `HookContext.spendCharge`, the bus-owned consumption
// signal a handler requests and the bus fulfils.

import { describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import { Grid } from '../../../src/engine/grid';
import { createHookBus, type HookBus } from '../../../src/engine/hook-bus';
import type {
  AfterMoveDispatchPayload,
  AfterMovePayload,
  BeforeMoveDispatchPayload,
  BeforeMovePayload,
  HookContext,
  HookEnvironment,
} from '../../../src/engine/hooks';
import { DIRECTION_UP } from '../../../src/engine/types';
import { createRngStreams } from '../../../src/rng/rng-streams';

const RUN_SEED = 'blitzy-charge-signal';

const BOARD_SIZE = 4;

function createEnvironment(): HookEnvironment {
  return {
    config: createDefaultRulesConfig(),
    rng: createRngStreams(RUN_SEED),
    grid: new Grid(BOARD_SIZE),
  };
}

// The DISPATCH payloads, which carry the LIVE board a caller hands the bus;
// the bus projects a read-only view of it for each handler.
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

/** A read-only board view over a board the dispatch did not carry. */
function foreignBoardView(): BeforeMovePayload['board'] {
  const foreign = new Grid(BOARD_SIZE);

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

/** The budget one subscriber currently holds, as the bus reports it. */
function budgetOf(bus: HookBus, id: string): number | undefined {
  return bus.subscribers().find((entry) => entry.id === id)?.charges;
}

/** The charges one subscriber has spent, as the bus counts them. */
function spentBy(bus: HookBus, id: string): number {
  return (
    bus.metrics().subscribers.find((entry) => entry.id === id)
      ?.chargesConsumed ?? 0
  );
}

describe('HookContext.spendCharge', () => {
  it('is a function on every dispatch context', () => {
    const environment = createEnvironment();
    const bus = createHookBus();
    let seen: unknown;

    bus.register({
      id: 'reader',
      hooks: {
        onBeforeMove: (payload, context): BeforeMovePayload => {
          seen = context.spendCharge;

          return payload;
        },
      },
    });
    bus.dispatch('onBeforeMove', beforeMove(environment), environment);

    expect(typeof seen).toBe('function');
  });

  it('spends one charge by default when the return is adopted', () => {
    const environment = createEnvironment();
    const bus = createHookBus();

    bus.register({
      id: 'spender',
      charges: 3,
      hooks: {
        onBeforeMove: (payload, context): BeforeMovePayload => {
          context.spendCharge();

          return payload;
        },
      },
    });
    bus.dispatch('onBeforeMove', beforeMove(environment), environment);

    expect(budgetOf(bus, 'spender')).toBe(2);
    expect(spentBy(bus, 'spender')).toBe(1);
  });

  it('spends nothing when the handler does not ask', () => {
    const environment = createEnvironment();
    const bus = createHookBus();

    bus.register({
      id: 'quiet',
      charges: 3,
      hooks: {
        onBeforeMove: (payload): BeforeMovePayload => payload,
      },
    });
    bus.dispatch('onBeforeMove', beforeMove(environment), environment);

    expect(budgetOf(bus, 'quiet')).toBe(3);
    expect(spentBy(bus, 'quiet')).toBe(0);
  });

  it('spends nothing on a handler that returns nothing but changes the payload copy', () => {
    // The handler now WRITES the transformable member the title claims it
    // writes. It returned `undefined` and changed nothing, so the case proved
    // only that a handler doing nothing spends nothing — which the test above
    // it already proves. `cancelled` is transformable on `onBeforeMove`, the
    // copy handed to a handler is the handler's own object, and a void return
    // adopts that copy, so the write below is adopted and the budget is still
    // untouched: a charge is spent for an ASK, never for a change.
    const environment = createEnvironment();
    const bus = createHookBus();

    bus.register({
      id: 'void-quiet',
      charges: 2,
      hooks: {
        onBeforeMove: (payload): void => {
          (payload as { cancelled: boolean }).cancelled = true;
        },
      },
    });

    const result = bus.dispatch(
      'onBeforeMove',
      beforeMove(environment),
      environment,
    );

    // The write reached the resolved payload, so the copy really did change.
    expect(result.payload.cancelled).toBe(true);
    expect(result.invoked).toBe(1);

    expect(budgetOf(bus, 'void-quiet')).toBe(2);
    expect(spentBy(bus, 'void-quiet')).toBe(0);
  });

  it('spends for a void-returning handler that asks', () => {
    const environment = createEnvironment();
    const bus = createHookBus();

    bus.register({
      id: 'void-spender',
      charges: 2,
      hooks: {
        onBeforeMove: (_payload, context): void => {
          context.spendCharge();
        },
      },
    });
    bus.dispatch('onBeforeMove', beforeMove(environment), environment);

    expect(budgetOf(bus, 'void-spender')).toBe(1);
  });

  it('accumulates repeated requests within one dispatch', () => {
    const environment = createEnvironment();
    const bus = createHookBus();

    bus.register({
      id: 'twice',
      charges: 5,
      hooks: {
        onBeforeMove: (payload, context): BeforeMovePayload => {
          context.spendCharge();
          context.spendCharge();

          return payload;
        },
      },
    });
    bus.dispatch('onBeforeMove', beforeMove(environment), environment);

    expect(budgetOf(bus, 'twice')).toBe(3);
  });

  it('spends the amount it is given', () => {
    const environment = createEnvironment();
    const bus = createHookBus();

    bus.register({
      id: 'bulk',
      charges: 6,
      hooks: {
        onBeforeMove: (payload, context): BeforeMovePayload => {
          context.spendCharge(4);

          return payload;
        },
      },
    });
    bus.dispatch('onBeforeMove', beforeMove(environment), environment);

    expect(budgetOf(bus, 'bulk')).toBe(2);
  });

  it('never takes the budget below zero, however much is asked for', () => {
    const environment = createEnvironment();
    const bus = createHookBus();

    bus.register({
      id: 'overdrawn',
      charges: 2,
      hooks: {
        onBeforeMove: (payload, context): BeforeMovePayload => {
          context.spendCharge(99);

          return payload;
        },
      },
    });
    bus.dispatch('onBeforeMove', beforeMove(environment), environment);

    expect(budgetOf(bus, 'overdrawn')).toBe(0);
    expect(spentBy(bus, 'overdrawn')).toBe(2);
  });

  it('spends nothing for an amount that is not a whole number at or above zero', () => {
    for (const amount of [0, -1, -99, Number.NaN, Number.POSITIVE_INFINITY]) {
      const environment = createEnvironment();
      const bus = createHookBus();

      bus.register({
        id: 'odd-amount',
        charges: 4,
        hooks: {
          onBeforeMove: (payload, context): BeforeMovePayload => {
            context.spendCharge(amount);

            return payload;
          },
        },
      });
      bus.dispatch('onBeforeMove', beforeMove(environment), environment);

      expect(budgetOf(bus, 'odd-amount')).toBe(4);
    }
  });

  it('truncates a fractional amount towards zero', () => {
    const environment = createEnvironment();
    const bus = createHookBus();

    bus.register({
      id: 'fractional',
      charges: 4,
      hooks: {
        onBeforeMove: (payload, context): BeforeMovePayload => {
          context.spendCharge(2.9);

          return payload;
        },
      },
    });
    bus.dispatch('onBeforeMove', beforeMove(environment), environment);

    expect(budgetOf(bus, 'fractional')).toBe(2);
  });

  it('spends nothing on a subscriber carrying no budget, and is not an error', () => {
    const environment = createEnvironment();
    const bus = createHookBus();

    bus.register({
      id: 'unlimited',
      hooks: {
        onBeforeMove: (payload, context): BeforeMovePayload => {
          context.spendCharge(3);

          return payload;
        },
      },
    });

    const result = bus.dispatch(
      'onBeforeMove',
      beforeMove(environment),
      environment,
    );

    expect(result.invoked).toBe(1);
    expect(result.failed).toBe(0);
    expect(budgetOf(bus, 'unlimited')).toBeUndefined();
    expect(spentBy(bus, 'unlimited')).toBe(0);
  });
});

describe('a charge is spent with the rest of the transaction', () => {
  it('spends nothing when the handler throws after asking', () => {
    const environment = createEnvironment();
    const bus = createHookBus();

    bus.register({
      id: 'thrower',
      charges: 3,
      hooks: {
        onBeforeMove: (_payload, context): BeforeMovePayload => {
          context.spendCharge();

          throw new Error('after asking');
        },
      },
    });

    const result = bus.dispatch(
      'onBeforeMove',
      beforeMove(environment),
      environment,
    );

    expect(result.failed).toBe(1);
    expect(budgetOf(bus, 'thrower')).toBe(3);
    expect(spentBy(bus, 'thrower')).toBe(0);
  });

  it('spends nothing when the return is refused after asking', () => {
    const environment = createEnvironment();
    const bus = createHookBus();

    bus.register({
      id: 'refused',
      charges: 3,
      hooks: {
        onBeforeMove: (_payload, context): BeforeMovePayload => {
          context.spendCharge();

          // A board that is not the board the dispatch arrived with, which the
          // bus refuses.
          return {
            direction: DIRECTION_UP,
            board: foreignBoardView(),
            cancelled: false,
          };
        },
      },
    });

    const result = bus.dispatch(
      'onBeforeMove',
      beforeMove(environment),
      environment,
    );

    expect(result.rejected).toBe(1);
    expect(budgetOf(bus, 'refused')).toBe(3);
    expect(spentBy(bus, 'refused')).toBe(0);
  });

  it('keeps the state slot and the charge together', () => {
    const environment = createEnvironment();
    const bus = createHookBus();

    bus.register({
      id: 'paired',
      charges: 2,
      state: { fired: 0 },
      hooks: {
        onBeforeMove: (payload, context): BeforeMovePayload => {
          context.state = { fired: 1 };
          context.spendCharge();

          return payload;
        },
      },
    });
    bus.dispatch('onBeforeMove', beforeMove(environment), environment);

    expect(bus.subscribers().find((entry) => entry.id === 'paired')?.state)
      .toEqual({ fired: 1 });
    expect(budgetOf(bus, 'paired')).toBe(1);
  });

  it('rolls the state slot and the charge back together', () => {
    const environment = createEnvironment();
    const bus = createHookBus();

    bus.register({
      id: 'rolled-back',
      charges: 2,
      state: { fired: 0 },
      hooks: {
        onBeforeMove: (_payload, context): BeforeMovePayload => {
          context.state = { fired: 1 };
          context.spendCharge();

          throw new Error('rolled back');
        },
      },
    });
    bus.dispatch('onBeforeMove', beforeMove(environment), environment);

    expect(
      bus.subscribers().find((entry) => entry.id === 'rolled-back')?.state,
    ).toEqual({ fired: 0 });
    expect(budgetOf(bus, 'rolled-back')).toBe(2);
  });
});

describe('one charge pool per subscriber, shared across its hooks', () => {
  function registerTwoHooked(bus: HookBus, charges: number): void {
    bus.register({
      id: 'two-hooked',
      charges,
      hooks: {
        onBeforeMove: (payload, context): BeforeMovePayload => {
          context.spendCharge();

          return payload;
        },
        onAfterMove: (payload, context): AfterMovePayload => {
          context.spendCharge();

          return payload;
        },
      },
    });
  }

  it('drains one budget across two different hooks', () => {
    const environment = createEnvironment();
    const bus = createHookBus();

    registerTwoHooked(bus, 4);

    bus.dispatch('onBeforeMove', beforeMove(environment), environment);

    expect(budgetOf(bus, 'two-hooked')).toBe(3);

    bus.dispatch('onAfterMove', afterMove(environment), environment);

    expect(budgetOf(bus, 'two-hooked')).toBe(2);
    expect(spentBy(bus, 'two-hooked')).toBe(2);
  });

  it('skips EVERY hook of the subscriber once the budget is gone', () => {
    const environment = createEnvironment();
    const bus = createHookBus();

    registerTwoHooked(bus, 1);

    // The one charge goes on the first dispatch.
    expect(
      bus.dispatch('onBeforeMove', beforeMove(environment), environment).invoked,
    ).toBe(1);
    expect(budgetOf(bus, 'two-hooked')).toBe(0);

    // Both hooks are now skipped, and neither raises.
    const after = bus.dispatch(
      'onAfterMove',
      afterMove(environment),
      environment,
    );
    const before = bus.dispatch(
      'onBeforeMove',
      beforeMove(environment),
      environment,
    );

    expect(after.invoked).toBe(0);
    expect(after.skipped).toBe(1);
    expect(after.failed).toBe(0);
    expect(before.invoked).toBe(0);
    expect(before.skipped).toBe(1);
    expect(before.failed).toBe(0);
  });

  it('shares the pool with a manual consumeCharge', () => {
    const environment = createEnvironment();
    const bus = createHookBus();

    registerTwoHooked(bus, 3);

    bus.consumeCharge('two-hooked', 2);

    expect(budgetOf(bus, 'two-hooked')).toBe(1);

    bus.dispatch('onBeforeMove', beforeMove(environment), environment);

    expect(budgetOf(bus, 'two-hooked')).toBe(0);
    expect(spentBy(bus, 'two-hooked')).toBe(3);
  });

  it('counts every spend once, whichever path spent it', () => {
    const environment = createEnvironment();
    const bus = createHookBus();

    registerTwoHooked(bus, 5);
    bus.consumeCharge('two-hooked');
    bus.dispatch('onBeforeMove', beforeMove(environment), environment);

    expect(bus.metrics().chargesConsumed).toBe(2);
    expect(spentBy(bus, 'two-hooked')).toBe(2);
  });

  it('leaves the budget of one subscriber untouched by the spend of another', () => {
    const environment = createEnvironment();
    const bus = createHookBus();

    registerTwoHooked(bus, 3);
    bus.register({
      id: 'bystander',
      charges: 3,
      hooks: {
        onBeforeMove: (payload): BeforeMovePayload => payload,
      },
    });
    bus.dispatch('onBeforeMove', beforeMove(environment), environment);

    expect(budgetOf(bus, 'two-hooked')).toBe(2);
    expect(budgetOf(bus, 'bystander')).toBe(3);
  });
});

describe('HookContext.charges', () => {
  it('reports the budget as it stood when the dispatch opened', () => {
    const environment = createEnvironment();
    const bus = createHookBus();
    const seen: (number | undefined)[] = [];

    bus.register({
      id: 'observer',
      charges: 2,
      hooks: {
        onBeforeMove: (payload, context: HookContext): BeforeMovePayload => {
          seen.push(context.charges);
          context.spendCharge();

          return payload;
        },
      },
    });
    bus.dispatch('onBeforeMove', beforeMove(environment), environment);
    bus.dispatch('onBeforeMove', beforeMove(environment), environment);

    expect(seen).toEqual([2, 1]);
  });

  it('is absent on a subscriber carrying no budget', () => {
    const environment = createEnvironment();
    const bus = createHookBus();
    let seen: number | undefined = 0;

    bus.register({
      id: 'endless',
      hooks: {
        onBeforeMove: (payload, context): BeforeMovePayload => {
          seen = context.charges;

          return payload;
        },
      },
    });
    bus.dispatch('onBeforeMove', beforeMove(environment), environment);

    expect(seen).toBeUndefined();
  });
});
