// Contract suite for charge accounting, AAP R3: "relics with limited charges
// must stop firing once exhausted", and "charge-based relics must handle being
// invoked with ZERO charges remaining without throwing or corrupting run
// state".
//
// A charge is now REQUESTED by the relic's own handler, on the one path where
// its effect takes hold, and deducted by the bus once that handler's return
// has been accepted. This suite pins the four properties that makes true.

import { describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import type { RulesConfig } from '../../../src/config/rules-config';
import { Grid } from '../../../src/engine/grid';
import { createHookBus, type HookBus } from '../../../src/engine/hook-bus';
import type {
  AfterMoveDispatchPayload,
  BeforeMoveDispatchPayload,
  HookEnvironment,
  MergeDispatchPayload,
} from '../../../src/engine/hooks';
import { Tile } from '../../../src/engine/tile';
import {
  DIRECTION_LEFT,
  DIRECTION_UP,
  type Direction,
} from '../../../src/engine/types';
import { createRngStreams } from '../../../src/rng/rng-streams';
import { RelicRegistry } from '../../../src/relics/relic-registry';

const CORRELATION_ID = 'charge-suite';

const SEED = 'charge-seed';

const BOARD_SIZE = 4;

/** Every relic that declares a finite budget, with the budget it declares. */
const CHARGED_RELICS: readonly { readonly id: string; readonly charges: number }[] =
  [
    { id: 'frostbind', charges: 8 },
    { id: 'temporal-anchor', charges: 3 },
    { id: 'tumbler', charges: 3 },
    { id: 'culling-blade', charges: 2 },
    { id: 'scouring-wind', charges: 1 },
  ];

interface Rig {
  readonly bus: HookBus;
  readonly registry: RelicRegistry;
  readonly config: RulesConfig;

  /** The dispatch environment for one board. */
  readonly env: (board: Grid) => HookEnvironment;
}

/** A rig holding one relic, registered live through the registry. */
function rig(relicId: string): Rig {
  const bus = createHookBus({ correlationId: CORRELATION_ID });
  const registry = new RelicRegistry({ bus, correlationId: CORRELATION_ID });
  const config = createDefaultRulesConfig();
  const rng = createRngStreams(SEED);

  registry.pickUp(relicId);

  return {
    bus,
    registry,
    config,
    env: (board: Grid): HookEnvironment => ({ config, rng, grid: board }),
  };
}

/** The charges the bus holds for one subscriber, refreshed. */
function chargesOf(bus: HookBus, id: string): number | undefined {
  return bus.subscribers().find((subscriber) => subscriber.id === id)?.charges;
}

/** A board with every cell occupied, so no move can spawn. */
function fullBoard(size = BOARD_SIZE): Grid {
  const grid = new Grid(size);

  for (let x = 0; x < size; x += 1) {
    for (let y = 0; y < size; y += 1) {
      // Alternating values, so the board is full and no two neighbours merge.
      grid.insertTile(new Tile({ x, y }, (x + y) % 2 === 0 ? 2 : 4));
    }
  }

  return grid;
}

/** A board holding `count` tiles of `value`, filled column by column. */
function boardWith(count: number, value: number, size = BOARD_SIZE): Grid {
  const grid = new Grid(size);
  let placed = 0;

  for (let x = 0; x < size && placed < count; x += 1) {
    for (let y = 0; y < size && placed < count; y += 1) {
      grid.insertTile(new Tile({ x, y }, value));
      placed += 1;
    }
  }

  return grid;
}

/** A board with row zero fully occupied and nothing else. */
function boardWithFullRow(size = BOARD_SIZE): Grid {
  const grid = new Grid(size);

  for (let x = 0; x < size; x += 1) {
    grid.insertTile(new Tile({ x, y: 0 }, 2));
  }

  return grid;
}

function beforeMove(
  board: Grid,
  direction: Direction = DIRECTION_UP,
): BeforeMoveDispatchPayload {
  return { direction, board, cancelled: false };
}

function afterMove(board: Grid): AfterMoveDispatchPayload {
  return {
    moved: true,
    board,
    score: 0,
    over: false,
    won: false,
    terminated: false,
  };
}

function merge(x: number, y: number): MergeDispatchPayload {
  const source = new Tile({ x: x + 1, y }, 2);
  const target = new Tile({ x, y }, 2);

  source.savePosition();
  target.savePosition();
  source.updatePosition({ x, y });

  return { source, target, resultValue: 4, scoreDelta: 4 };
}

describe('the finite charge budgets', () => {
  it.each(CHARGED_RELICS)(
    'seeds $id with its declared $charges charges',
    ({ id, charges }) => {
      const { bus, registry } = rig(id);

      expect(registry.find(id)?.charges).toBe(charges);
      expect(chargesOf(bus, id)).toBe(charges);
    },
  );

  it('is the whole set of charge-carrying relics in the catalogue', () => {
    const declared = new RelicRegistry()
      .catalogue()
      .filter((relic) => relic.charges !== undefined)
      .map((relic) => relic.id);

    expect(new Set(declared)).toEqual(
      new Set(CHARGED_RELICS.map((relic) => relic.id)),
    );
  });
});

describe('frostbind spends one charge per merge it frosts', () => {
  it('spends exactly one charge per merge and stops at zero', () => {
    const { bus, env } = rig('frostbind');
    const board = new Grid(BOARD_SIZE);
    const budget = 8;

    for (let spent = 0; spent < budget; spent += 1) {
      bus.dispatch('onMerge', merge(0, 0), env(board));
      expect(chargesOf(bus, 'frostbind')).toBe(budget - spent - 1);
    }

    expect(chargesOf(bus, 'frostbind')).toBe(0);

    // Exhausted: the handler is not reached again, and the budget does not
    // underflow past zero however many further merges resolve.
    const exhausted = bus.dispatch('onMerge', merge(0, 0), env(board));

    expect(exhausted.invoked).toBe(0);
    expect(exhausted.skipped).toBe(1);
    expect(chargesOf(bus, 'frostbind')).toBe(0);

    for (let extra = 0; extra < 5; extra += 1) {
      bus.dispatch('onMerge', merge(1, 1), env(board));
    }

    expect(chargesOf(bus, 'frostbind')).toBe(0);
  });

  it('keeps carrying its frost into a new stage once exhausted', () => {
    const { bus, env } = rig('frostbind');
    const board = new Grid(BOARD_SIZE);
    const stage = {
      stageIndex: 1,
      goal: { kind: 'score-threshold' as const, target: 1000 },
      seed: SEED,
      boardSize: BOARD_SIZE,
    };

    bus.dispatch('onMerge', merge(0, 0), env(board));

    // The stage binding re-installs the merge rule and touches nothing else:
    // the goal it was handed resolves exactly as it arrived, and the frost
    // standing from the stage before is carried across as the recorded
    // predicate.
    const carried = bus.dispatch('onStageStart', stage, env(board));

    expect(carried.payload.goal.target).toBe(stage.goal.target);
    expect(carried.invoked).toBe(1);
    expect(carried.effectsApplied).toBeGreaterThan(0);
    expect(chargesOf(bus, 'frostbind')).toBe(7);

    // Spend the rest of the budget on merges. The relic then stops FIRING —
    // `onMerge` freezes nothing further — while its stage-start install goes on
    // reinstating the ledger the spent charges built, because
    // `STANDING_HOOK_NAMES` of src/engine/hooks.ts exempts stage preparation
    // from the charge guard. One budget still serves every EFFECT hook.
    for (let spent = 1; spent < 8; spent += 1) {
      bus.dispatch('onMerge', merge(2, 2), env(board));
    }

    expect(chargesOf(bus, 'frostbind')).toBe(0);

    const spentMerge = bus.dispatch('onMerge', merge(3, 3), env(board));

    expect(spentMerge.invoked).toBe(0);
    expect(spentMerge.skipped).toBe(1);

    const exhausted = bus.dispatch('onStageStart', stage, env(board));

    expect(exhausted.payload.goal.target).toBe(stage.goal.target);
    expect(exhausted.invoked).toBe(1);
    expect(exhausted.skipped).toBe(0);
    expect(exhausted.effectsApplied).toBeGreaterThan(0);

    // AND IT IS STILL FREE. The install asks for no charge, so an exhausted
    // budget is not driven below zero by being carried forward.
    expect(exhausted.chargesConsumed).toBe(0);
    expect(chargesOf(bus, 'frostbind')).toBe(0);
  });

  it('reaches the persisted envelope with the budget that is left', () => {
    const { bus, registry, env } = rig('frostbind');
    const board = new Grid(BOARD_SIZE);

    bus.dispatch('onMerge', merge(0, 0), env(board));
    bus.dispatch('onMerge', merge(1, 0), env(board));

    const persisted = registry.serialize();

    expect(persisted[0].id).toBe('frostbind');
    expect(persisted[0].charges).toBe(6);

    const resumed = new RelicRegistry({
      bus: createHookBus({ correlationId: CORRELATION_ID }),
    });

    resumed.restore(persisted);

    expect(resumed.find('frostbind')?.charges).toBe(6);
  });
});

describe('temporal-anchor spends one charge per withdrawn move', () => {
  it('spends nothing while the board still has an empty cell', () => {
    const { bus, env } = rig('temporal-anchor');
    const open = new Grid(BOARD_SIZE);

    open.insertTile(new Tile({ x: 0, y: 0 }, 2));

    bus.dispatch('onAfterMove', afterMove(open), env(open));

    const allowed = bus.dispatch('onBeforeMove', beforeMove(open), env(open));

    expect(allowed.payload.cancelled).toBe(false);
    expect(chargesOf(bus, 'temporal-anchor')).toBe(3);
  });

  it('spends one charge per withdrawal and stops at zero', () => {
    const { bus, env } = rig('temporal-anchor');

    // One anchor per withdrawal. The rewind RESTORES the recorded lattice and
    // consumes the anchor with it, so each withdrawal needs its own preceding
    // settle — which is exactly the sequence a run produces: a move settles,
    // the next move finds the board jammed, and the anchor rewinds it.
    for (let spent = 0; spent < 3; spent += 1) {
      const roomy = boardWith(4, 2);

      bus.dispatch('onAfterMove', afterMove(roomy), env(roomy));

      const full = fullBoard();
      const withdrawn = bus.dispatch(
        'onBeforeMove',
        beforeMove(full),
        env(full),
      );

      expect(withdrawn.payload.cancelled).toBe(true);
      expect(withdrawn.effectsApplied).toBeGreaterThan(0);
      expect(chargesOf(bus, 'temporal-anchor')).toBe(3 - spent - 1);
    }

    // Exhausted: the move resolves again, and no further charge is taken.
    const settled = boardWith(4, 2);

    bus.dispatch('onAfterMove', afterMove(settled), env(settled));

    const jammed = fullBoard();
    const resolved = bus.dispatch(
      'onBeforeMove',
      beforeMove(jammed),
      env(jammed),
    );

    expect(resolved.payload.cancelled).toBe(false);
    expect(resolved.invoked).toBe(0);
    expect(chargesOf(bus, 'temporal-anchor')).toBe(0);
  });

  it('spends nothing on a move another relic already withdrew', () => {
    const { bus, env } = rig('temporal-anchor');
    const roomy = boardWith(4, 2);

    bus.dispatch('onAfterMove', afterMove(roomy), env(roomy));

    const full = fullBoard();
    const already: BeforeMoveDispatchPayload = {
      direction: DIRECTION_UP,
      board: full,
      cancelled: true,
    };
    const result = bus.dispatch('onBeforeMove', already, env(full));

    expect(result.payload.cancelled).toBe(true);
    expect(result.invoked).toBe(1);
    expect(chargesOf(bus, 'temporal-anchor')).toBe(3);
  });
});

describe('tumbler spends one charge per redirected move', () => {
  it('spends only where at least one tile was actually relocated', () => {
    const { bus, env } = rig('tumbler');

    // Inside the scarcity band: at most a quarter of the board empty, and at
    // least one cell free for a tile to be thrown into.
    const scarce = boardWith(13, 2);
    let budget = 3;
    let relocations = 0;

    for (let move = 0; move < 6 && budget > 0; move += 1) {
      const result = bus.dispatch(
        'onBeforeMove',
        beforeMove(scarce, DIRECTION_UP),
        env(scarce),
      );

      // The tumble is A BOARD WRITE, not a redirection: the move the player
      // pressed resolves as pressed, against the tumbled board.
      expect(result.payload.direction).toBe(DIRECTION_UP);
      expect(result.payload.cancelled).toBe(false);

      if (result.effectsApplied > 0) {
        budget -= 1;
        relocations += 1;
      }

      expect(chargesOf(bus, 'tumbler')).toBe(budget);
    }

    expect(relocations).toBeGreaterThan(0);
  });

  it('spends nothing outside the scarcity band', () => {
    const { bus, env } = rig('tumbler');
    const open = boardWith(2, 2);

    bus.dispatch('onBeforeMove', beforeMove(open), env(open));

    expect(chargesOf(bus, 'tumbler')).toBe(3);
  });

  it('stops tumbling once the budget is spent', () => {
    const { bus, env } = rig('tumbler');
    const scarce = boardWith(13, 2);

    for (let move = 0; move < 40; move += 1) {
      bus.dispatch('onBeforeMove', beforeMove(scarce), env(scarce));

      if (chargesOf(bus, 'tumbler') === 0) {
        break;
      }
    }

    expect(chargesOf(bus, 'tumbler')).toBe(0);

    const skipped = bus.dispatch(
      'onBeforeMove',
      beforeMove(scarce),
      env(scarce),
    );

    expect(skipped.invoked).toBe(0);
    expect(skipped.payload.direction).toBe(DIRECTION_UP);
    expect(chargesOf(bus, 'tumbler')).toBe(0);
  });
});

describe('culling-blade spends one charge per excision', () => {
  it('spends one charge when it excises a tile, and stops at zero', () => {
    const { bus, env } = rig('culling-blade');

    // Above the scarcity band, with the lowest spawn value piled up: six twos,
    // which is the arming condition the blade guards on.
    const armed = boardWith(6, 2);
    const before = armed.availableCells().length;
    const excised = bus.dispatch(
      'onBeforeMove',
      beforeMove(armed, DIRECTION_LEFT),
      env(armed),
    );

    // The excision is A REMOVAL, not a turn: the direction the player pressed
    // is untouched and the move resolves against the thinned board.
    expect(excised.payload.direction).toBe(DIRECTION_LEFT);
    expect(excised.effectsApplied).toBe(1);
    expect(armed.availableCells().length).toBe(before + 1);
    expect(chargesOf(bus, 'culling-blade')).toBe(1);

    const rearmed = boardWith(6, 2);

    bus.dispatch(
      'onBeforeMove',
      beforeMove(rearmed, DIRECTION_LEFT),
      env(rearmed),
    );

    expect(chargesOf(bus, 'culling-blade')).toBe(0);

    const exhausted = bus.dispatch(
      'onBeforeMove',
      beforeMove(rearmed, DIRECTION_LEFT),
      env(rearmed),
    );

    expect(exhausted.invoked).toBe(0);
    expect(exhausted.effectsApplied).toBe(0);
    expect(exhausted.payload.direction).toBe(DIRECTION_LEFT);
    expect(chargesOf(bus, 'culling-blade')).toBe(0);
  });

  it('spends nothing when the move already points along the culling axis', () => {
    const { bus, env } = rig('culling-blade');
    const armed = boardWith(6, 2);
    const chosen = bus.dispatch(
      'onBeforeMove',
      beforeMove(armed, DIRECTION_LEFT),
      env(armed),
    ).payload.direction;

    const fresh = rig('culling-blade');
    const unchanged = fresh.bus.dispatch(
      'onBeforeMove',
      beforeMove(armed, chosen),
      fresh.env(armed),
    );

    expect(unchanged.invoked).toBe(1);
    expect(unchanged.payload.direction).toBe(chosen);
    expect(chargesOf(fresh.bus, 'culling-blade')).toBe(2);
  });

  it('spends nothing while too few of the lowest tiles are on the board', () => {
    const { bus, env } = rig('culling-blade');
    const sparse = boardWith(3, 2);

    bus.dispatch('onBeforeMove', beforeMove(sparse), env(sparse));

    expect(chargesOf(bus, 'culling-blade')).toBe(2);
  });
});

/* ==========================================================================
 * 5. scouring-wind: its single charge, spent once
 * ========================================================================== */

describe('scouring-wind spends its single charge on the row it records', () => {
  it('spends nothing on a board with no full row', () => {
    const { bus, registry, env } = rig('scouring-wind');
    const open = boardWith(2, 2);

    bus.dispatch('onAfterMove', afterMove(open), env(open));

    expect(chargesOf(bus, 'scouring-wind')).toBe(1);
    expect(registry.serialize()[0].charges).toBe(1);
  });

  it('spends its charge on the first full row and stops', () => {
    const { bus, registry, env } = rig('scouring-wind');
    const swept = boardWithFullRow();
    const first = bus.dispatch('onAfterMove', afterMove(swept), env(swept));

    expect(first.invoked).toBe(1);
    expect(chargesOf(bus, 'scouring-wind')).toBe(0);
    expect(registry.find('scouring-wind')?.state).toEqual({
      scours: 1,
      row: { y: 0, values: [2, 2, 2, 2] },
    });

    const exhausted = bus.dispatch('onAfterMove', afterMove(swept), env(swept));

    expect(exhausted.invoked).toBe(0);
    expect(exhausted.skipped).toBe(1);
    expect(chargesOf(bus, 'scouring-wind')).toBe(0);

    // The state the one sweep recorded is intact: an exhausted relic is
    // skipped, not reset.
    expect(registry.serialize()[0]).toEqual({
      id: 'scouring-wind',
      charges: 0,
      state: { scours: 1, row: { y: 0, values: [2, 2, 2, 2] } },
    });
  });
});

describe('a relic restored with zero charges', () => {
  it.each(CHARGED_RELICS)(
    'never invokes $id and never throws',
    ({ id }) => {
      const bus = createHookBus({ correlationId: CORRELATION_ID });
      const registry = new RelicRegistry({ bus, correlationId: CORRELATION_ID });
      const config = createDefaultRulesConfig();
      const rng = createRngStreams(SEED);

      // A full board and a board with a full row: between them every effect
      // condition the five relics guard on is met, so the only reason a handler
      // does not act is the budget of zero it was restored with.
      const full = fullBoard();
      const swept = boardWithFullRow();
      const environment: HookEnvironment = { config, rng, grid: full };

      registry.restore([{ id, charges: 0 }]);

      expect(registry.find(id)?.charges).toBe(0);

      const dispatches = (): void => {
        bus.dispatch(
          'onStageStart',
          {
            stageIndex: 0,
            goal: { kind: 'score-threshold', target: 100 },
            seed: SEED,
            boardSize: BOARD_SIZE,
          },
          environment,
        );
        bus.dispatch('onBeforeMove', beforeMove(full), environment);
        bus.dispatch('onMerge', merge(0, 0), environment);
        bus.dispatch(
          'onSpawn',
          { position: { x: 0, y: 0 }, value: 2 },
          environment,
        );
        bus.dispatch('onAfterMove', afterMove(swept), { config, rng, grid: swept });
        bus.dispatch(
          'onStageEnd',
          { stageIndex: 0, cleared: true, score: 100 },
          environment,
        );
      };

      expect(dispatches).not.toThrow();
      expect(chargesOf(bus, id)).toBe(0);

      // Run state is intact and still round-trips: an exhausted relic persists
      // as itself with zero charges.
      const persisted = registry.serialize();

      expect(persisted[0].id).toBe(id);
      expect(persisted[0].charges).toBe(0);
      expect(JSON.parse(JSON.stringify(persisted))).toEqual(persisted);
    },
  );

  it('never lets a budget fall below zero however many hooks dispatch', () => {
    const { bus, env } = rig('scouring-wind');
    const swept = boardWithFullRow();

    for (let move = 0; move < 20; move += 1) {
      bus.dispatch('onAfterMove', afterMove(swept), env(swept));
    }

    expect(chargesOf(bus, 'scouring-wind')).toBe(0);
    expect(bus.metrics().chargesConsumed).toBe(1);
  });
});

describe('a requested charge is spent only with an adopted return', () => {
  it('spends nothing when the handler throws after asking', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });

    bus.register({
      id: 'asks-then-throws',
      charges: 2,
      hooks: {
        onStageEnd: (_payload, context): never => {
          context.spendCharge();

          throw new Error('after asking');
        },
      },
    });

    const result = bus.dispatch(
      'onStageEnd',
      { stageIndex: 0, cleared: true, score: 10 },
      {
        config: createDefaultRulesConfig(),
        rng: createRngStreams(SEED),
        grid: new Grid(BOARD_SIZE),
      },
    );

    expect(result.failed).toBe(1);
    expect(chargesOf(bus, 'asks-then-throws')).toBe(2);
    expect(bus.metrics().chargesConsumed).toBe(0);
  });

  it('spends nothing when the return is refused', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });

    bus.register({
      id: 'asks-then-returns-junk',
      charges: 2,
      hooks: {
        onStageEnd: (_payload, context): never => {
          context.spendCharge();

          // Not this hook's payload, so the bus discards the whole transaction
          // — the charge with it.
          return { nothing: 'like a payload' } as never;
        },
      },
    });

    const result = bus.dispatch(
      'onStageEnd',
      { stageIndex: 0, cleared: true, score: 10 },
      {
        config: createDefaultRulesConfig(),
        rng: createRngStreams(SEED),
        grid: new Grid(BOARD_SIZE),
      },
    );

    expect(result.rejected).toBe(1);
    expect(chargesOf(bus, 'asks-then-returns-junk')).toBe(2);
  });

  it('refuses a request from a relic carrying no budget', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    const answers: boolean[] = [];

    bus.register({
      id: 'unlimited',
      hooks: {
        onStageEnd: (_payload, context): void => {
          answers.push(context.spendCharge());
        },
      },
    });

    bus.dispatch(
      'onStageEnd',
      { stageIndex: 0, cleared: true, score: 10 },
      {
        config: createDefaultRulesConfig(),
        rng: createRngStreams(SEED),
        grid: new Grid(BOARD_SIZE),
      },
    );

    expect(answers).toEqual([false]);
    expect(chargesOf(bus, 'unlimited')).toBeUndefined();
    expect(bus.metrics().chargesConsumed).toBe(0);
  });

  it('refuses a request made after the handler returned', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });
    let stashed: ((amount?: number) => boolean) | null = null;

    bus.register({
      id: 'stashes-the-request',
      charges: 2,
      hooks: {
        onStageEnd: (_payload, context): void => {
          stashed = context.spendCharge;
        },
      },
    });

    const environment: HookEnvironment = {
      config: createDefaultRulesConfig(),
      rng: createRngStreams(SEED),
      grid: new Grid(BOARD_SIZE),
    };

    bus.dispatch(
      'onStageEnd',
      { stageIndex: 0, cleared: true, score: 10 },
      environment,
    );

    expect(chargesOf(bus, 'stashes-the-request')).toBe(2);
    expect(stashed).not.toBeNull();
    expect((stashed as unknown as (amount?: number) => boolean)()).toBe(false);
    expect(chargesOf(bus, 'stashes-the-request')).toBe(2);
  });

  it('never asks for more than the budget holds', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });

    bus.register({
      id: 'greedy',
      charges: 1,
      hooks: {
        onStageEnd: (_payload, context): void => {
          context.spendCharge(5);
          context.spendCharge(Number.MAX_SAFE_INTEGER);
          context.spendCharge(Number.POSITIVE_INFINITY);
          context.spendCharge(-3);
          context.spendCharge(0.4);
        },
      },
    });

    bus.dispatch(
      'onStageEnd',
      { stageIndex: 0, cleared: true, score: 10 },
      {
        config: createDefaultRulesConfig(),
        rng: createRngStreams(SEED),
        grid: new Grid(BOARD_SIZE),
      },
    );

    expect(chargesOf(bus, 'greedy')).toBe(0);
    expect(bus.metrics().chargesConsumed).toBe(1);
  });

  it('counts a spend through the same metric consumeCharge counts', () => {
    const bus = createHookBus({ correlationId: CORRELATION_ID });

    bus.register({
      id: 'metered-spend',
      charges: 3,
      hooks: {
        onStageEnd: (_payload, context): void => {
          context.spendCharge();
        },
      },
    });

    bus.dispatch(
      'onStageEnd',
      { stageIndex: 0, cleared: true, score: 10 },
      {
        config: createDefaultRulesConfig(),
        rng: createRngStreams(SEED),
        grid: new Grid(BOARD_SIZE),
      },
    );
    bus.consumeCharge('metered-spend');

    const metrics = bus.metrics();
    const row = metrics.subscribers.find((entry) => entry.id === 'metered-spend');

    expect(metrics.chargesConsumed).toBe(2);
    expect(row?.chargesConsumed).toBe(2);
    expect(row?.charges).toBe(1);
  });
});
