// Charge and trigger-disjointness suite for the `board-manipulation` family,
// AAP R3 and Contract 2.
//
// What each of the four handlers DOES is covered by
// tests/unit/relics/relic-effects.test.ts. Two family-level properties had no
// test, and both are conditions under which a relic must do nothing at all.
//
// Every case dispatches through a real `HookBus` against a real `Grid`, so the
// guard, the ordering and the board-effect transaction are the production
// ones.

import { describe, expect, it } from 'vitest';

import {
  afterMovePayload,
  beforeMovePayload,
  cursorOf,
  dispatchOn,
  expectConsistentLattice,
  fill,
  occupants,
  place,
  relicBench,
  relicById,
  resultOn,
  stateOf,
} from '../../fixtures/relics';
import type { RelicBench } from '../../fixtures/relics';

/** The four relics of the family, in declaration order. */
const FAMILY = [
  'temporal-anchor',
  'tumbler',
  'culling-blade',
  'scouring-wind',
] as const;

/** The hook each one binds its acting handler to. */
const ACTING_HOOK: Readonly<Record<string, 'onBeforeMove' | 'onAfterMove'>> = {
  'temporal-anchor': 'onBeforeMove',
  tumbler: 'onBeforeMove',
  'culling-blade': 'onBeforeMove',
  'scouring-wind': 'onAfterMove',
};

/** Places `count` tiles of `value`, in the grid's own scan order. */
function placeCount(target: RelicBench, count: number, value = 2): void {
  let placed = 0;

  for (let x = 0; x < 4 && placed < count; x += 1) {
    for (let y = 0; y < 4 && placed < count; y += 1) {
      place(target.grid, x, y, value);
      placed += 1;
    }
  }
}

describe('a charge budget spent to zero', () => {
  it('is declared by every relic of the family', () => {
    for (const id of FAMILY) {
      const declared = relicById(id).charges;

      expect(declared, id).toBeTypeOf('number');
      expect(declared ?? 0, id).toBeGreaterThan(0);
    }
  });

  for (const id of FAMILY) {
    it(`skips ${id} at zero charges, without throwing`, () => {
      const target = relicBench([{ id, charges: 0 }]);

      // A full board, which arms the widest set of triggers this family has.
      fill(target.grid, 2);

      const before = occupants(target.grid);
      const hook = ACTING_HOOK[id];
      const outcome =
        hook === 'onBeforeMove'
          ? resultOn(target, 'onBeforeMove', beforeMovePayload(target.grid))
          : resultOn(target, 'onAfterMove', afterMovePayload(target.grid, 40));

      // Refused at the guard, not invoked and refused inside.
      expect(outcome.invoked, id).toBe(0);
      expect(outcome.skipped, id).toBe(1);
      expect(outcome.failed, id).toBe(0);

      // The board is untouched and still coherent.
      expect(occupants(target.grid), id).toEqual(before);
      expectConsistentLattice(target.grid);

      // And no randomness was spent on a handler that never ran.
      expect(cursorOf(target, 'relic-draw'), id).toBe(0);
    });
  }

  it('withdraws no move for an exhausted temporal-anchor', () => {
    const target = relicBench([{ id: 'temporal-anchor', charges: 0 }]);

    // An anchor is recorded first, so the only thing left stopping the rewind
    // is the spent budget.
    place(target.grid, 0, 0, 2);
    dispatchOn(target, 'onAfterMove', afterMovePayload(target.grid, 8));
    fill(target.grid, 4);

    const resolved = dispatchOn(
      target,
      'onBeforeMove',
      beforeMovePayload(target.grid),
    );

    // The turn still resolves: a relic that cannot fire must not veto.
    expect(resolved.cancelled).toBe(false);
    expect(occupants(target.grid)).toHaveLength(16);
  });

  it('leaves an exhausted relic s own state exactly as it shipped', () => {
    const target = relicBench([{ id: 'temporal-anchor', charges: 0 }]);

    place(target.grid, 1, 1, 8);
    dispatchOn(target, 'onAfterMove', afterMovePayload(target.grid, 8));

    // `recordAnchor` never ran, so no anchor was taken — and the slot is still
    // the plain, serialisable one the definition declared.
    const held = stateOf(target, 'temporal-anchor');

    expect(() => JSON.stringify(held)).not.toThrow();
    expect(JSON.parse(JSON.stringify(held ?? null))).toEqual(
      JSON.parse(JSON.stringify(relicById('temporal-anchor').state ?? null)),
    );
  });

  it('spends the budget only through the bus, whichever path asked for it',
    () => {
    const target = relicBench(['scouring-wind']);

    // A board with no full column: the wind finds nothing to clear, so the
    // invocation asks for nothing and the declared budget stands.
    place(target.grid, 0, 0, 2);
    dispatchOn(target, 'onAfterMove', afterMovePayload(target.grid, 40));

    const beforeSweep = target.bus
      .subscribers()
      .find((subscriber) => subscriber.id === 'scouring-wind');

    expect(beforeSweep?.charges).toBe(relicById('scouring-wind').charges);

    // A full board gives it a column to clear, and THAT invocation asks.
    fill(target.grid, 2);
    dispatchOn(target, 'onAfterMove', afterMovePayload(target.grid, 40));

    const afterSweep = target.bus
      .subscribers()
      .find((subscriber) => subscriber.id === 'scouring-wind');

    expect(afterSweep?.charges).toBe(0);

    const spent = target.bus.consumeCharge('scouring-wind', 1);

    expect(spent.consumed).toBe(0);
    expect(spent.remaining).toBe(0);

    // And now it is skipped.
    const after = resultOn(
      target,
      'onAfterMove',
      afterMovePayload(target.grid, 40),
    );

    expect(after.invoked).toBe(0);
    expect(after.skipped).toBe(1);
  });

  it('keeps an unexhausted relic firing beside an exhausted one', () => {
    const target = relicBench([
      { id: 'temporal-anchor', charges: 0 },
      'culling-blade',
    ]);

    placeCount(target, 8, 2);

    const outcome = resultOn(
      target,
      'onBeforeMove',
      beforeMovePayload(target.grid),
    );

    expect(outcome.invoked).toBe(1);
    expect(outcome.skipped).toBe(1);
    expect(occupants(target.grid)).toHaveLength(7);
    expectConsistentLattice(target.grid);
  });
});

describe('the three onBeforeMove relics held together', () => {
  /** All three, in declaration order, on one bench. */
  function trio(seed: string): RelicBench {
    return relicBench(['temporal-anchor', 'tumbler', 'culling-blade'], {
      seed,
    });
  }

  it('rewinds and withdraws the turn on a board with no empty cell', () => {
    const target = trio('band-full');

    // An anchor from a board of four tiles, then a full board.
    placeCount(target, 4, 2);
    dispatchOn(target, 'onAfterMove', afterMovePayload(target.grid, 8));
    fill(target.grid, 8);

    const resolved = dispatchOn(
      target,
      'onBeforeMove',
      beforeMovePayload(target.grid),
    );

    // Only the anchor acted: the board is the anchored one and the turn is
    // withdrawn.
    expect(resolved.cancelled).toBe(true);
    expect(occupants(target.grid)).toHaveLength(4);
    expect(occupants(target.grid).every((cell) => cell.value === 2)).toBe(true);
    expectConsistentLattice(target.grid);
  });

  it('tumbles without withdrawing the turn inside the scarcity band', () => {
    const target = trio('band-scarce');

    // Thirteen tiles: three empty cells, inside the band of four.
    placeCount(target, 13, 2);
    dispatchOn(target, 'onAfterMove', afterMovePayload(target.grid, 8));

    const resolved = dispatchOn(
      target,
      'onBeforeMove',
      beforeMovePayload(target.grid),
    );

    expect(resolved.cancelled).toBe(false);
    expect(occupants(target.grid)).toHaveLength(13);
    expectConsistentLattice(target.grid);
  });

  it('culls exactly one tile on an open board, withdrawing nothing', () => {
    const target = trio('band-open');

    // Eight tiles of the lowest spawn value: eight empty cells is above the
    // band, and eight such tiles is above the blade's arming count.
    placeCount(target, 8, 2);
    dispatchOn(target, 'onAfterMove', afterMovePayload(target.grid, 8));

    const resolved = dispatchOn(
      target,
      'onBeforeMove',
      beforeMovePayload(target.grid),
    );

    expect(resolved.cancelled).toBe(false);
    expect(occupants(target.grid)).toHaveLength(7);
    expectConsistentLattice(target.grid);
  });

  it('leaves an open board with too few low tiles entirely alone', () => {
    const target = trio('band-quiet');

    // Five tiles of the lowest value: above the band, below the arming count.
    placeCount(target, 5, 2);
    dispatchOn(target, 'onAfterMove', afterMovePayload(target.grid, 8));

    const before = occupants(target.grid);
    const resolved = dispatchOn(
      target,
      'onBeforeMove',
      beforeMovePayload(target.grid),
    );

    expect(resolved.cancelled).toBe(false);
    expect(occupants(target.grid)).toEqual(before);

    // Nothing acted, so nothing was drawn either.
    expect(cursorOf(target, 'relic-draw')).toBe(0);
  });

  it('invokes all three on every band, so the bands are their own', () => {
    const target = trio('band-invoked');

    placeCount(target, 8, 2);

    const outcome = resultOn(
      target,
      'onBeforeMove',
      beforeMovePayload(target.grid),
    );

    // The bus dispatches to all three every turn — the disjointness is in the
    // arming conditions, not in the dispatch.
    expect(outcome.invoked).toBe(3);
    expect(outcome.skipped).toBe(0);
    expect(outcome.failed).toBe(0);
  });

  it('keeps the value multiset where it neither culls nor rewinds', () => {
    const target = trio('band-multiset');

    place(target.grid, 0, 0, 2);
    place(target.grid, 0, 1, 4);
    place(target.grid, 0, 2, 8);
    place(target.grid, 0, 3, 16);
    place(target.grid, 1, 0, 32);
    place(target.grid, 1, 1, 64);
    place(target.grid, 1, 2, 128);
    place(target.grid, 1, 3, 256);
    place(target.grid, 2, 0, 512);
    place(target.grid, 2, 1, 1024);
    place(target.grid, 2, 2, 2048);
    place(target.grid, 2, 3, 4096);
    place(target.grid, 3, 0, 8192);

    // Three empty cells, so the tumbler acts; and not one tile carries the
    // lowest spawn value in quantity, so the blade does not.
    dispatchOn(target, 'onBeforeMove', beforeMovePayload(target.grid));

    const seen = occupants(target.grid)
      .map((cell) => cell.value)
      .sort((left, right) => left - right);

    expect(seen).toEqual([
      2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192,
    ]);
    expectConsistentLattice(target.grid);
  });

  it('acts on the same board the same way for the same seed', () => {
    const first = trio('band-fixed');
    const second = trio('band-fixed');

    placeCount(first, 13, 2);
    placeCount(second, 13, 2);
    dispatchOn(first, 'onBeforeMove', beforeMovePayload(first.grid));
    dispatchOn(second, 'onBeforeMove', beforeMovePayload(second.grid));

    expect(occupants(first.grid)).toEqual(occupants(second.grid));
    expect(cursorOf(first, 'relic-draw')).toBe(cursorOf(second, 'relic-draw'));
  });
});

describe('scouring-wind beside the other three', () => {
  it('acts on onAfterMove alone, and the trio on onBeforeMove alone', () => {
    const target = relicBench([...FAMILY], { seed: 'hooks-apart' });

    fill(target.grid, 2);

    const before = resultOn(
      target,
      'onBeforeMove',
      beforeMovePayload(target.grid),
    );

    // Three of the four bind `onBeforeMove`; the wind does not.
    expect(before.invoked).toBe(3);

    // A board the anchor rewound, so the wind has a full row to find.
    fill(target.grid, 2);

    const after = resultOn(
      target,
      'onAfterMove',
      afterMovePayload(target.grid, 40),
    );

    // The anchor records on `onAfterMove` too, so two of the four fire here.
    expect(after.invoked).toBe(2);
    expectConsistentLattice(target.grid);
  });

  it('leaves the score and the flags the move resolved to alone', () => {
    const target = relicBench(['scouring-wind'], { seed: 'wind-flags' });

    fill(target.grid, 2);

    const resolved = dispatchOn(
      target,
      'onAfterMove',
      afterMovePayload(target.grid, 128),
    );

    expect(resolved.score).toBe(128);
    expect(resolved.moved).toBe(true);
    expect(resolved.won).toBe(false);
    expect(cursorOf(target, 'relic-draw')).toBe(0);
  });
});
