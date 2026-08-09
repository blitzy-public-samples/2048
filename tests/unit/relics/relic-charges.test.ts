// Charge consumption at the relic and registry level: which of the five
// charge-carrying relics spends a charge, WHEN, and how a player's manual
// activation spends one.
//
// And the prompt's zero-charge edge case at the relic level: each of the five,
// invoked with no charges remaining, throws nothing, writes no board and
// leaves the run state as it stands.

import { describe, expect, it } from 'vitest';

import { createHookBus, type HookBus } from '../../../src/engine/hook-bus';
import type { StageGoal } from '../../../src/config/stage-config';
import type {
  AfterMoveDispatchPayload,
  AfterMovePayload,
  BeforeMoveDispatchPayload,
  MergeDispatchPayload,
} from '../../../src/engine/hooks';
import { DIRECTION_LEFT } from '../../../src/engine/types';
import {
  RELIC_CATALOGUE,
  RelicRegistry,
  findRelicById,
} from '../../../src/relics/relic-registry';
import type { Relic } from '../../../src/relics/relic-types';
import {
  createRelicHarness,
  tileAt,
  type BoardLayout,
} from '../../fixtures/relics';

const GOAL: StageGoal = { kind: 'highest-tile', target: 512 };

type Harness = ReturnType<typeof createRelicHarness>;

/** The five relics the catalogue declares a budget for. */
const CHARGED: readonly Relic[] = RELIC_CATALOGUE.filter(
  (relic) => relic.charges !== undefined,
);

function relic(id: string): Relic {
  const found = findRelicById(id);

  if (found === undefined) {
    throw new Error(`the catalogue declares no relic "${id}"`);
  }

  return found;
}

/** Four cells empty: inside the scarcity band a shuffle acts within. */
const SCARCE_BOARD: BoardLayout = [
  [2, 4, 8, 16],
  [4, 8, 16, 32],
  [8, 16, 32, 64],
  [null, null, null, null],
];

/** Eight cells empty and eight lowest-value tiles: an armed culling board. */
const CULLABLE_BOARD: BoardLayout = [
  [2, 2, 2, 2],
  [2, 2, 2, 2],
  [null, null, null, null],
  [null, null, null, null],
];

/**
 * Row y = 1 fully occupied. A `BoardLayout` is written row-major — `layout[y][x]`
 * — so one inner array is one row.
 */
const ONE_FULL_ROW: BoardLayout = [
  [null, null, 8, null],
  [2, 4, 8, 16],
  [null, null, null, null],
  [null, null, null, null],
];

/** A board no relic here acts on: wide open, no full row, few tiles. */
const OPEN_BOARD: BoardLayout = [
  [2, 4, null, null],
  [null, null, null, null],
  [null, null, null, null],
  [null, null, null, null],
];

// The DISPATCH payloads: a caller hands the bus the LIVE board and the live
// tiles, and the bus projects a read-only view of each for every handler.
function beforeMove(harness: Harness): BeforeMoveDispatchPayload {
  return {
    direction: DIRECTION_LEFT,
    board: harness.grid,
    cancelled: false,
  };
}

function afterMove(
  harness: Harness,
  overrides: Partial<Omit<AfterMovePayload, 'board'>> = {},
): AfterMoveDispatchPayload {
  return {
    moved: true,
    board: harness.grid,
    score: 0,
    over: false,
    won: false,
    terminated: false,
    ...overrides,
  };
}

function mergePayload(value = 2): MergeDispatchPayload {
  return {
    source: tileAt(0, 0, value),
    target: tileAt(1, 0, value),
    resultValue: value * 2,
    scoreDelta: value * 2,
  };
}

/** Fills the last row, which is what turns a scarce board into a jam. */
function fillLastRow(harness: Harness): void {
  for (let x = 0; x < harness.grid.size; x += 1) {
    if (harness.grid.cellContent({ x, y: 3 }) === null) {
      harness.grid.insertTile(tileAt(x, 3, 2));
    }
  }
}

describe('the charge-carrying relics', () => {
  it('are exactly five, and each declares a positive whole budget', () => {
    expect(CHARGED.map((entry) => entry.id).sort()).toEqual([
      'culling-blade',
      'frostbind',
      'scouring-wind',
      'temporal-anchor',
      'tumbler',
    ]);

    for (const entry of CHARGED) {
      expect(Number.isSafeInteger(entry.charges)).toBe(true);
      expect(entry.charges).toBeGreaterThan(0);
    }
  });

  it('leave every other relic unlimited', () => {
    expect(RELIC_CATALOGUE).toHaveLength(16);
    expect(RELIC_CATALOGUE.length - CHARGED.length).toBe(11);
  });
});

describe('frostbind spends a charge per frosted cell', () => {
  it('spends one on a merge', () => {
    const harness = createRelicHarness({ relics: [relic('frostbind')] });

    harness.dispatch('onMerge', mergePayload());

    expect(harness.chargesOf('frostbind')).toBe(
      (relic('frostbind').charges ?? 0) - 1,
    );
  });

  it('spends nothing at stage start, which installs the rule rather than using it', () => {
    const harness = createRelicHarness({ relics: [relic('frostbind')] });

    harness.dispatch('onStageStart', {
      stageIndex: 0,
      goal: GOAL,
      seed: harness.rng.seed,
      boardSize: harness.grid.size,
    });

    expect(harness.chargesOf('frostbind')).toBe(relic('frostbind').charges);
  });

  it('stops frosting once the budget is spent', () => {
    const declared = relic('frostbind').charges ?? 0;
    const harness = createRelicHarness({ relics: [relic('frostbind')] });

    harness.dispatch('onStageStart', {
      stageIndex: 0,
      goal: GOAL,
      seed: harness.rng.seed,
      boardSize: harness.grid.size,
    });

    for (let merge = 0; merge < declared; merge += 1) {
      expect(
        harness.dispatch('onMerge', mergePayload(2 ** (merge + 1)))
          .invoked,
      ).toBe(1);
    }

    expect(harness.chargesOf('frostbind')).toBe(0);

    const spent = harness.dispatch('onMerge', mergePayload());

    expect(spent.invoked).toBe(0);
    expect(spent.skipped).toBe(1);
    expect(spent.failed).toBe(0);
  });
});

describe('temporal-anchor spends a charge per rewind', () => {
  it('spends nothing for anchoring a move', () => {
    const harness = createRelicHarness({
      relics: [relic('temporal-anchor')],
      layout: SCARCE_BOARD,
    });

    harness.dispatch('onBeforeMove', beforeMove(harness));

    expect(harness.chargesOf('temporal-anchor')).toBe(
      relic('temporal-anchor').charges,
    );
  });

  it('spends nothing for a turn that left the board open', () => {
    const harness = createRelicHarness({
      relics: [relic('temporal-anchor')],
      layout: SCARCE_BOARD,
    });

    harness.dispatch('onBeforeMove', beforeMove(harness));
    harness.dispatch('onAfterMove', afterMove(harness, { score: 100 }));

    expect(harness.chargesOf('temporal-anchor')).toBe(
      relic('temporal-anchor').charges,
    );
  });

  it('spends one for a rewind', () => {
    const harness = createRelicHarness({
      relics: [relic('temporal-anchor')],
      layout: SCARCE_BOARD,
    });

    // The order the two hooks act in. `recordAnchor` takes the anchor on
    // `onAfterMove`, while the settled board still has room; the board then
    // jams; and the NEXT `onBeforeMove` is where `holdAnchor` rewinds to it
    // and withdraws the move.
    harness.dispatch('onAfterMove', afterMove(harness, { score: 100 }));
    fillLastRow(harness);

    const opened = harness.dispatch('onBeforeMove', beforeMove(harness));

    expect(opened.payload.cancelled).toBe(true);
    expect(harness.chargesOf('temporal-anchor')).toBe(
      (relic('temporal-anchor').charges ?? 0) - 1,
    );

    // The rewind reached the board: the row the jam filled stands empty again.
    expect(harness.grid.cellContent({ x: 0, y: 3 })).toBeNull();
  });

  it('stops anchoring as well as stops rewinding once the budget is gone', () => {
    const harness = createRelicHarness({ relics: [], layout: SCARCE_BOARD });
    const anchor = relic('temporal-anchor');

    harness.bus.register({
      id: anchor.id,
      hooks: anchor.hooks,
      charges: 1,
      state: anchor.state,
    });

    harness.dispatch('onAfterMove', afterMove(harness, { score: 100 }));
    fillLastRow(harness);
    harness.dispatch('onBeforeMove', beforeMove(harness));

    expect(harness.chargesOf('temporal-anchor')).toBe(0);

    // ONE POOL: the budget the rewind spent is the budget the anchoring hook
    // drew on, so both hooks are now skipped.
    const opened = harness.dispatch('onBeforeMove', beforeMove(harness));

    expect(opened.invoked).toBe(0);
    expect(opened.skipped).toBe(1);
  });
});

describe('tumbler spends a charge per shuffle', () => {
  it('spends one when it shuffles', () => {
    const harness = createRelicHarness({
      relics: [relic('tumbler')],
      layout: SCARCE_BOARD,
      seed: 'tumbler-charge',
    });

    harness.dispatch('onBeforeMove', beforeMove(harness));

    expect(harness.chargesOf('tumbler')).toBe((relic('tumbler').charges ?? 0) - 1);
  });

  it('spends nothing on an open board it declines to act on', () => {
    const harness = createRelicHarness({
      relics: [relic('tumbler')],
      layout: OPEN_BOARD,
    });

    const result = harness.dispatch('onBeforeMove', beforeMove(harness));

    expect(result.invoked).toBe(1);
    expect(harness.chargesOf('tumbler')).toBe(relic('tumbler').charges);
  });

  it('spends nothing on a board with no empty cell', () => {
    const harness = createRelicHarness({
      relics: [relic('tumbler')],
      layout: [
        [2, 4, 8, 16],
        [4, 8, 16, 32],
        [8, 16, 32, 64],
        [16, 32, 64, 128],
      ],
    });

    harness.dispatch('onBeforeMove', beforeMove(harness));

    expect(harness.chargesOf('tumbler')).toBe(relic('tumbler').charges);
  });

  it('stops shuffling once the budget is spent', () => {
    const declared = relic('tumbler').charges ?? 0;
    const harness = createRelicHarness({
      relics: [relic('tumbler')],
      layout: SCARCE_BOARD,
      seed: 'tumbler-exhaust',
    });

    for (let move = 0; move < declared; move += 1) {
      expect(harness.dispatch('onBeforeMove', beforeMove(harness)).invoked).toBe(
        1,
      );
    }

    const before = harness.layout();
    const spent = harness.dispatch('onBeforeMove', beforeMove(harness));

    expect(spent.invoked).toBe(0);
    expect(spent.skipped).toBe(1);
    expect(harness.layout()).toEqual(before);
  });
});

describe('culling-blade spends a charge per cut', () => {
  it('spends one when it cuts', () => {
    const harness = createRelicHarness({
      relics: [relic('culling-blade')],
      layout: CULLABLE_BOARD,
    });

    harness.dispatch('onBeforeMove', beforeMove(harness));

    expect(harness.chargesOf('culling-blade')).toBe(
      (relic('culling-blade').charges ?? 0) - 1,
    );
  });

  it('spends nothing until the small tiles have piled up', () => {
    const harness = createRelicHarness({
      relics: [relic('culling-blade')],
      layout: OPEN_BOARD,
    });

    const result = harness.dispatch('onBeforeMove', beforeMove(harness));

    expect(result.invoked).toBe(1);
    expect(harness.chargesOf('culling-blade')).toBe(
      relic('culling-blade').charges,
    );
  });

  it('stops cutting once the budget is spent', () => {
    const declared = relic('culling-blade').charges ?? 0;
    const harness = createRelicHarness({
      relics: [relic('culling-blade')],
      layout: CULLABLE_BOARD,
    });

    for (let move = 0; move < declared; move += 1) {
      harness.dispatch('onBeforeMove', beforeMove(harness));
    }

    const remaining = harness.occupied().length;
    const spent = harness.dispatch('onBeforeMove', beforeMove(harness));

    expect(spent.invoked).toBe(0);
    expect(harness.occupied()).toHaveLength(remaining);
  });
});

describe('scouring-wind spends a charge per sweep', () => {
  it('spends its single charge on the sweep', () => {
    const harness = createRelicHarness({
      relics: [relic('scouring-wind')],
      layout: ONE_FULL_ROW,
    });

    harness.dispatch('onAfterMove', afterMove(harness));

    expect(harness.chargesOf('scouring-wind')).toBe(0);
  });

  it('spends nothing when no row is full', () => {
    const harness = createRelicHarness({
      relics: [relic('scouring-wind')],
      layout: OPEN_BOARD,
    });

    const result = harness.dispatch('onAfterMove', afterMove(harness));

    expect(result.invoked).toBe(1);
    expect(harness.chargesOf('scouring-wind')).toBe(
      relic('scouring-wind').charges,
    );
  });

  it('sweeps exactly once in a run, then never again', () => {
    const harness = createRelicHarness({
      relics: [relic('scouring-wind')],
      layout: ONE_FULL_ROW,
    });

    harness.dispatch('onAfterMove', afterMove(harness));

    // Refill the row and settle another move.
    for (let x = 0; x < 4; x += 1) {
      harness.grid.insertTile(tileAt(x, 1, 2));
    }

    const second = harness.dispatch('onAfterMove', afterMove(harness));

    expect(second.invoked).toBe(0);
    expect(second.skipped).toBe(1);
    expect(harness.grid.cellContent({ x: 0, y: 1 })?.value).toBe(2);
  });
});

describe('every charge relic invoked with no charges remaining', () => {
  const layouts: Readonly<Record<string, BoardLayout>> = {
    frostbind: SCARCE_BOARD,
    'temporal-anchor': SCARCE_BOARD,
    tumbler: SCARCE_BOARD,
    'culling-blade': CULLABLE_BOARD,
    'scouring-wind': ONE_FULL_ROW,
  };

  for (const entry of CHARGED) {
    it(`${entry.id} throws nothing, writes no board and keeps its state`, () => {
      const harness = createRelicHarness({
        relics: [],
        layout: layouts[entry.id] ?? SCARCE_BOARD,
      });

      harness.bus.register({
        id: entry.id,
        hooks: entry.hooks,
        charges: 0,
        state: entry.state,
      });

      const before = harness.layout();
      let failed = 0;
      let invoked = 0;
      let spent = 0;

      // STAGE PREPARATION IS DISPATCHED SEPARATELY. `STANDING_HOOK_NAMES` of
      // src/engine/hooks.ts exempts `onStageStart` from the charge guard, so a
      // relic that binds it reinstates the standing rules its own persisted slot
      // records however little budget is left. What it must not do is act: no
      // board write, no charge, no throw.
      const stage = harness.dispatch('onStageStart', {
        stageIndex: 0,
        goal: GOAL,
        seed: harness.rng.seed,
        boardSize: harness.grid.size,
      });

      // The five EFFECT hooks, dispatched with a spent budget. Each must be
      // refused at the guard.
      const opened = harness.dispatch('onBeforeMove', beforeMove(harness));
      const merged = harness.dispatch('onMerge', mergePayload());
      const settled = harness.dispatch('onAfterMove', afterMove(harness));
      const ended = harness.dispatch('onStageEnd', {
        stageIndex: 0,
        cleared: true,
        score: 100,
      });

      for (const result of [opened, merged, settled, ended]) {
        failed += result.failed;
        invoked += result.invoked;
        spent += result.chargesConsumed;
      }

      expect(failed).toBe(0);
      expect(invoked).toBe(0);
      expect(spent).toBe(0);

      expect(stage.failed).toBe(0);
      expect(stage.chargesConsumed).toBe(0);

      expect(harness.layout()).toEqual(before);
      expect(harness.stateOf(entry.id)).toEqual(entry.state);
      expect(harness.chargesOf(entry.id)).toBe(0);
    });
  }
});

describe('RelicRegistry.activate', () => {
  function composeRegistry(ids: readonly string[]): {
    registry: RelicRegistry;
    bus: HookBus;
  } {
    const bus = createHookBus();
    const registry = new RelicRegistry({ bus });

    for (const id of ids) {
      registry.pickUp(id);
    }

    return { registry, bus };
  }

  it('addresses the relic at a PICKUP POSITION, not by identifier', () => {
    const { registry } = composeRegistry([
      'echo-chamber',
      'frostbind',
      'tumbler',
    ]);

    expect(registry.activate(0).relicId).toBe('echo-chamber');
    expect(registry.activate(1).relicId).toBe('frostbind');
    expect(registry.activate(2).relicId).toBe('tumbler');
  });

  it('spends one charge through the bus', () => {
    const { registry, bus } = composeRegistry(['frostbind']);
    const declared = relic('frostbind').charges ?? 0;

    const activation = registry.activate(0);

    expect(activation.consumption?.consumed).toBe(1);
    expect(activation.consumption?.remaining).toBe(declared - 1);
    expect(
      bus.subscribers().find((entry) => entry.id === 'frostbind')?.charges,
    ).toBe(declared - 1);
  });

  it('reports the budget it left on the registry as well', () => {
    const { registry } = composeRegistry(['tumbler']);
    const declared = relic('tumbler').charges ?? 0;

    registry.activate(0);

    expect(registry.find('tumbler')?.charges).toBe(declared - 1);
  });

  it('spends the amount it is given', () => {
    const { registry } = composeRegistry(['frostbind']);
    const declared = relic('frostbind').charges ?? 0;

    expect(registry.activate(0, 3).consumption?.remaining).toBe(declared - 3);
  });

  it('drains a budget to zero and then spends nothing more', () => {
    const { registry } = composeRegistry(['scouring-wind']);

    expect(registry.activate(0).consumption?.consumed).toBe(1);
    expect(registry.activate(0).consumption?.consumed).toBe(0);
    expect(registry.activate(0).consumption?.remaining).toBe(0);
  });

  it('shares the pool with the handlers of the relic itself', () => {
    const { registry, bus } = composeRegistry(['scouring-wind']);
    const harness = createRelicHarness({ relics: [], layout: ONE_FULL_ROW });

    // One registry, one bus: the harness is only used for its payloads, so the
    // dispatch below goes to the bus the registry registered with.
    registry.activate(0);

    const result = bus.dispatch(
      'onAfterMove',
      afterMove(harness),
      { config: harness.config, rng: harness.rng, grid: harness.grid },
    );

    expect(result.invoked).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('spends nothing for an index naming no held relic', () => {
    const { registry } = composeRegistry(['frostbind']);

    expect(registry.activate(1).relicId).toBeNull();
    expect(registry.activate(1).consumption).toBeUndefined();
    expect(registry.find('frostbind')?.charges).toBe(
      relic('frostbind').charges,
    );
  });

  it('spends nothing for an index that is not a whole number at or above zero', () => {
    const { registry } = composeRegistry(['frostbind']);

    for (const index of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(registry.activate(index).relicId).toBeNull();
    }

    expect(registry.find('frostbind')?.charges).toBe(
      relic('frostbind').charges,
    );
  });

  it('reports the relic but spends nothing when it carries no budget', () => {
    const { registry } = composeRegistry(['echo-chamber']);
    const activation = registry.activate(0);

    expect(activation.relicId).toBe('echo-chamber');
    expect(activation.consumption?.limited).toBe(false);
    expect(activation.consumption?.consumed).toBe(0);
  });

  it('reports the relic but spends nothing with no bus attached', () => {
    const registry = new RelicRegistry();

    registry.pickUp('frostbind');

    const activation = registry.activate(0);

    expect(activation.relicId).toBe('frostbind');
    expect(activation.consumption).toBeUndefined();
  });

  it('raises nothing on an empty registry', () => {
    const registry = new RelicRegistry({ bus: createHookBus() });

    expect(() => registry.activate(0)).not.toThrow();
    expect(registry.activate(0).relicId).toBeNull();
  });
});

/** Every budget the guard reads as spent and no boundary may republish. */
const UNUSABLE_BUDGETS: readonly { label: string; charges: number }[] =
  Object.freeze([
    { label: 'one charge in debt', charges: -1 },
    { label: 'a large negative budget', charges: -100 },
    { label: 'NaN', charges: Number.NaN },
    { label: '-Infinity', charges: Number.NEGATIVE_INFINITY },
  ]);

describe('a restored budget that is negative or not a number', () => {
  it.each(UNUSABLE_BUDGETS)(
    'is projected and committed as zero for $label',
    ({ charges }: { charges: number }) => {
      const bus = createHookBus({});
      const registry = new RelicRegistry({ bus });
      const charged = CHARGED[0];

      registry.restore([{ id: charged.id, charges }]);

      // The projection and the commit slice, which are what a screen shows and
      // what the run envelope carries.
      expect(registry.serialize()[0]?.charges).toBe(0);
      expect(registry.persistedEntry(charged.id)?.charges).toBe(0);
      expect(registry.relicContext()[0]?.charges).toBe(0);

      expect(registry.has(charged.id)).toBe(true);
    },
  );

  it.each(UNUSABLE_BUDGETS)(
    'never fires the handler for $label, and reports nothing left',
    ({ charges }: { charges: number }) => {
      const bus = createHookBus({});
      const registry = new RelicRegistry({ bus });
      const charged = CHARGED[0];

      registry.restore([{ id: charged.id, charges }]);

      const consumption = registry.activate(charged.id);

      expect(consumption.held).toBe(true);
      expect(consumption.limited).toBe(true);
      expect(consumption.consumed).toBe(0);
      expect(consumption.remaining).toBe(0);

      // The budget never goes further into debt, however often it is asked.
      expect(registry.activate(charged.id, 5).consumed).toBe(0);
      expect(registry.serialize()[0]?.charges).toBe(0);
    },
  );
});
