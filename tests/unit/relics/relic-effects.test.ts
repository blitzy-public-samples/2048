// Behavioural suite for the nine relic handlers that write the board or the
// rules, dispatched through a real `HookBus` against a real `Grid` and a real
// `RulesConfig`.
//
// This suite reads no DOM and no storage, and installs no mock library.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BOARD_SIZE,
  createDefaultRulesConfig,
  defaultCanMerge,
} from '../../../src/config/default-config';
import type { RulesConfig } from '../../../src/config/rules-config';
import { createHookBus } from '../../../src/engine/hook-bus';
import type { HookBus } from '../../../src/engine/hook-bus';
import { Grid } from '../../../src/engine/grid';
import { createReadonlyGridView } from '../../../src/engine/hook-bus';
import type {
  HookEnvironment,
  HookName,
  HookPayloadMap,
  HookDispatchPayloadMap,
} from '../../../src/engine/hooks';
import { Tile } from '../../../src/engine/tile';
import { DIRECTION_LEFT } from '../../../src/engine/types';
import type { Position } from '../../../src/engine/types';
import { createRngStreams } from '../../../src/rng/rng-streams';
import type { RngStreams } from '../../../src/rng/rng-streams';
import { findRelicById } from '../../../src/relics/relic-registry';
import type { Relic } from '../../../src/relics/relic-types';

const SEED = 'relic-effects-suite';

interface Bench {
  readonly grid: Grid;
  readonly config: RulesConfig;
  readonly streams: RngStreams;
  readonly bus: HookBus;
  readonly environment: HookEnvironment;
}

/** Resolves one relic out of the real catalogue, or fails the case. */
function relic(id: string): Relic {
  const found = findRelicById(id);

  expect(found, `relic ${id} is in the catalogue`).toBeDefined();

  return found as Relic;
}

/** Builds a bench holding the named relic, at the given board size. */
function bench(id: string, size = DEFAULT_BOARD_SIZE): Bench {
  const grid = new Grid(size);
  const config = createDefaultRulesConfig();

  config.boardSize = size;

  const streams = createRngStreams(SEED);
  const bus = createHookBus({ correlationId: 'run-relic-effects' });
  const definition = relic(id);

  expect(
    bus.register({
      id: definition.id,
      hooks: definition.hooks,
      charges: definition.charges,
      state: definition.state,
    }),
  ).toBe(true);

  return {
    grid,
    config,
    streams,
    bus,
    environment: { config, rng: streams, grid },
  };
}

/** Dispatches one hook against a bench and hands back the resolved payload. */
function dispatch<K extends HookName>(
  target: Bench,
  hook: K,
  payload: HookDispatchPayloadMap[K],
): HookPayloadMap[K] {
  return target.bus.dispatch(hook, payload, target.environment).payload;
}

function place(grid: Grid, x: number, y: number, value: number): void {
  grid.insertTile(new Tile({ x, y }, value));
}

/** Fills every cell of a board with `value`. */
function fill(grid: Grid, value = 2): void {
  for (let x = 0; x < grid.size; x += 1) {
    for (let y = 0; y < grid.size; y += 1) {
      place(grid, x, y, value);
    }
  }
}

function occupants(grid: Grid): { x: number; y: number; value: number }[] {
  const found: { x: number; y: number; value: number }[] = [];

  grid.eachCell((_x, _y, tile): void => {
    if (tile !== null) {
      found.push({ x: tile.x, y: tile.y, value: tile.value });
    }
  });

  return found;
}

function values(grid: Grid): number[] {
  return occupants(grid)
    .map((cell) => cell.value)
    .sort((left, right) => left - right);
}

function expectConsistentLattice(grid: Grid): void {
  expect(grid.cells).toHaveLength(grid.size);

  for (let x = 0; x < grid.size; x += 1) {
    const column = grid.cells[x];

    expect(column).toHaveLength(grid.size);

    for (let y = 0; y < grid.size; y += 1) {
      const slot = column[y];

      expect(slot === null || slot instanceof Tile).toBe(true);

      if (slot !== null) {
        expect(slot.x).toBe(x);
        expect(slot.y).toBe(y);
      }
    }
  }

  expect(grid.cellContent({ x: grid.size, y: 0 })).toBeNull();
  expect(grid.cellContent({ x: 0, y: grid.size })).toBeNull();
}

function spawnPayload(
  position: Position | undefined,
  value: number,
): HookDispatchPayloadMap['onSpawn'] {
  return position === undefined ? { value } : { position, value };
}

function beforeMovePayload(
  grid: Grid,
): HookDispatchPayloadMap['onBeforeMove'] {
  return { direction: DIRECTION_LEFT, board: grid, cancelled: false };
}

function afterMovePayload(
  grid: Grid,
  score = 0,
): HookDispatchPayloadMap['onAfterMove'] {
  return {
    moved: true,
    board: grid,
    score,
    over: false,
    won: false,
    terminated: false,
  };
}

function stageStartPayload(
  boardSize: number,
): HookDispatchPayloadMap['onStageStart'] {
  return {
    stageIndex: 0,
    goal: { kind: 'highest-tile', target: 128 },
    seed: SEED,
    boardSize,
  };
}

/**
 * A merge dispatch payload built over real tiles, which is what
 * src/engine/move-resolver.ts dispatches: the bus projects each of them into
 * the frozen view a handler reads.
 */
function mergePayload(
  source: Position,
  target: Position,
  sourceValue: number,
  targetValue: number,
  resultValue: number,
  scoreDelta: number,
): HookDispatchPayloadMap['onMerge'] {
  return {
    source: new Tile(source, sourceValue),
    target: new Tile(target, targetValue),
    resultValue,
    scoreDelta,
  };
}

function stageEndPayload(
  cleared: boolean,
  score = 100,
): HookDispatchPayloadMap['onStageEnd'] {
  return { stageIndex: 0, cleared, score };
}

describe('fertile-ground (spawn-control)', () => {
  it('inserts a second tile and leaves the spawn payload untouched', () => {
    const target = bench('fertile-ground');

    place(target.grid, 1, 1, 4);

    const payload = dispatch(
      target,
      'onSpawn',
      spawnPayload({ x: 3, y: 3 }, 2),
    );

    expect(payload.position).toEqual({ x: 3, y: 3 });
    expect(payload.value).toBe(2);
    expect(occupants(target.grid)).toHaveLength(2);
    expectConsistentLattice(target.grid);
  });

  it('sprouts the extra tile beside an occupied cell, not on the spawn', () => {
    const target = bench('fertile-ground');

    place(target.grid, 1, 1, 4);
    dispatch(target, 'onSpawn', spawnPayload({ x: 3, y: 3 }, 2));

    const sprouted = occupants(target.grid).filter(
      (cell) => !(cell.x === 1 && cell.y === 1),
    );

    expect(sprouted).toHaveLength(1);
    expect(sprouted[0].value).toBe(2);
    expect(sprouted[0]).not.toEqual({ x: 3, y: 3, value: 2 });
  });

  it('renders the extra tile as appearing rather than moving', () => {
    const target = bench('fertile-ground');

    place(target.grid, 1, 1, 4);
    dispatch(target, 'onSpawn', spawnPayload({ x: 3, y: 3 }, 2));

    for (const cell of occupants(target.grid)) {
      expect(
        target.grid.cellContent({ x: cell.x, y: cell.y })?.previousPosition,
      ).toBeNull();
    }
  });

  it('sprouts nothing when the payload carries no cell', () => {
    const target = bench('fertile-ground');

    place(target.grid, 1, 1, 4);
    dispatch(target, 'onSpawn', spawnPayload(undefined, 2));

    expect(occupants(target.grid)).toHaveLength(1);
  });

  it('sprouts nothing on a board with no cell beside a tile', () => {
    const target = bench('fertile-ground');

    dispatch(target, 'onSpawn', spawnPayload({ x: 0, y: 0 }, 2));

    expect(occupants(target.grid)).toHaveLength(0);
  });

  it('is deterministic under a fixed seed', () => {
    const first = bench('fertile-ground');
    const second = bench('fertile-ground');

    place(first.grid, 1, 1, 4);
    place(second.grid, 1, 1, 4);
    dispatch(first, 'onSpawn', spawnPayload({ x: 3, y: 3 }, 2));
    dispatch(second, 'onSpawn', spawnPayload({ x: 3, y: 3 }, 2));

    expect(occupants(first.grid)).toEqual(occupants(second.grid));
  });
});

describe('frostbind (merge-magic)', () => {
  it('installs a merge predicate on stage start', () => {
    const target = bench('frostbind');
    const before = target.config.merge.canMerge;

    dispatch(target, 'onStageStart', stageStartPayload(target.grid.size));

    expect(target.config.merge.canMerge).not.toBe(before);
  });

  it('leaves an unfrozen merge accepted', () => {
    const target = bench('frostbind');

    dispatch(target, 'onStageStart', stageStartPayload(target.grid.size));

    const moving = new Tile({ x: 1, y: 0 }, 2);
    const stationary = new Tile({ x: 0, y: 0 }, 2);

    expect(target.config.merge.canMerge(moving, stationary)).toBe(true);
  });

  it('refuses a merge onto a frozen cell and accepts it once thawed', () => {
    const target = bench('frostbind');

    dispatch(target, 'onStageStart', stageStartPayload(target.grid.size));

    const moving = new Tile({ x: 1, y: 0 }, 2);
    const stationary = new Tile({ x: 0, y: 0 }, 2);
    dispatch(
      target,
      'onMerge',
      mergePayload({ x: 1, y: 0 }, { x: 0, y: 0 }, 2, 2, 4, 4),
    );

    expect(target.config.merge.canMerge(moving, stationary)).toBe(false);

    dispatch(
      target,
      'onMerge',
      mergePayload({ x: 1, y: 0 }, { x: 0, y: 0 }, 2, 2, 4, 4),
    );

    expect(target.config.merge.canMerge(moving, stationary)).toBe(true);
  });

  it('leaves a neighbour probe, carrying no cell, to the base rule', () => {
    const target = bench('frostbind');

    dispatch(target, 'onStageStart', stageStartPayload(target.grid.size));
    dispatch(
      target,
      'onMerge',
      mergePayload({ x: 1, y: 0 }, { x: 0, y: 0 }, 2, 2, 4, 4),
    );

    const probe = { value: 2, mergedFrom: null };

    expect(target.config.merge.canMerge(probe, probe)).toBe(true);
  });

  it('installs exactly one wrapper however many stages begin', () => {
    const target = bench('frostbind');

    dispatch(target, 'onStageStart', stageStartPayload(target.grid.size));

    const first = target.config.merge.canMerge;

    dispatch(target, 'onStageStart', stageStartPayload(target.grid.size));
    dispatch(target, 'onStageStart', stageStartPayload(target.grid.size));

    const third = target.config.merge.canMerge;
    const moving = new Tile({ x: 1, y: 0 }, 2);
    const stationary = new Tile({ x: 0, y: 0 }, 2);

    expect(third).not.toBe(first);
    expect(third(moving, stationary)).toBe(true);

    // One wrapper: unwrapping once reaches the untagged default.
    const held: unknown = (third as unknown as Record<string, unknown>)[
      '__frostbindFrozenCells'
    ];

    expect(held).toBe(defaultCanMerge);
  });

  it('reinstalls after a reload, where the configuration arrives fresh', () => {
    const target = bench('frostbind');

    dispatch(target, 'onStageStart', stageStartPayload(target.grid.size));

    const reloaded = createDefaultRulesConfig();
    const reloadedBench: Bench = {
      ...target,
      config: reloaded,
      environment: {
        config: reloaded,
        rng: target.streams,
        grid: target.grid,
      },
    };
    const before = reloaded.merge.canMerge;

    dispatch(
      reloadedBench,
      'onStageStart',
      stageStartPayload(target.grid.size),
    );

    expect(reloaded.merge.canMerge).not.toBe(before);
  });

  it('drops a frozen cell that a shrunk board no longer holds', () => {
    const target = bench('frostbind');

    dispatch(target, 'onStageStart', stageStartPayload(4));
    dispatch(
      target,
      'onMerge',
      mergePayload({ x: 3, y: 3 }, { x: 3, y: 3 }, 2, 2, 4, 4),
    );

    const stationary = new Tile({ x: 3, y: 3 }, 2);
    const moving = new Tile({ x: 2, y: 3 }, 2);

    expect(target.config.merge.canMerge(moving, stationary)).toBe(false);

    // The board shrinks and the stage begins again, where (3,3) is gone.
    target.grid.size = 3;
    target.grid.cells = target.grid.empty();
    target.config.boardSize = 3;
    dispatch(target, 'onStageStart', stageStartPayload(3));

    expect(target.config.merge.canMerge(moving, stationary)).toBe(true);
  });

  it('keeps its state JSON-serialisable', () => {
    const target = bench('frostbind');

    dispatch(target, 'onStageStart', stageStartPayload(target.grid.size));
    dispatch(
      target,
      'onMerge',
      mergePayload({ x: 1, y: 0 }, { x: 0, y: 0 }, 2, 2, 4, 4),
    );

    const held = target.bus
      .subscribers()
      .find((subscriber) => subscriber.id === 'frostbind');

    expect(JSON.parse(JSON.stringify(held?.state))).toEqual({
      frozen: [{ x: 0, y: 0 }],
    });
  });
});

describe('chain-catalyst (merge-magic)', () => {
  it('installs a merge predicate that admits a ladder-adjacent pair', () => {
    const target = bench('chain-catalyst');

    dispatch(target, 'onStageStart', stageStartPayload(target.grid.size));

    const two = { value: 2, mergedFrom: null };
    const four = { value: 4, mergedFrom: null };

    expect(target.config.merge.canMerge(two, four)).toBe(true);
    expect(target.config.merge.canMerge(four, two)).toBe(true);
  });

  it('keeps every merge the base rule already accepted', () => {
    const target = bench('chain-catalyst');

    dispatch(target, 'onStageStart', stageStartPayload(target.grid.size));

    const two = { value: 2, mergedFrom: null };

    expect(target.config.merge.canMerge(two, two)).toBe(true);
  });

  it('refuses a pair that is neither equal nor ladder-adjacent', () => {
    const target = bench('chain-catalyst');

    dispatch(target, 'onStageStart', stageStartPayload(target.grid.size));

    const two = { value: 2, mergedFrom: null };
    const sixteen = { value: 16, mergedFrom: null };

    expect(target.config.merge.canMerge(two, sixteen)).toBe(false);
  });

  it('installs exactly one wrapper however many stages begin', () => {
    const target = bench('chain-catalyst');

    dispatch(target, 'onStageStart', stageStartPayload(target.grid.size));
    dispatch(target, 'onStageStart', stageStartPayload(target.grid.size));
    dispatch(target, 'onStageStart', stageStartPayload(target.grid.size));

    const held: unknown = (
      target.config.merge.canMerge as unknown as Record<string, unknown>
    )['__chainCatalystLadder'];

    expect(held).toBe(defaultCanMerge);
  });

  it('resolves a mixed merge from the larger operand and scores it', () => {
    const target = bench('chain-catalyst');
    const payload = dispatch(
      target,
      'onMerge',
      mergePayload({ x: 1, y: 0 }, { x: 0, y: 0 }, 2, 4, 4, 4),
    );

    expect(payload.resultValue).toBe(8);
    expect(payload.scoreDelta).toBe(8);
  });

  it('leaves an equal-valued merge exactly as it arrived', () => {
    const target = bench('chain-catalyst');
    const payload = dispatch(
      target,
      'onMerge',
      mergePayload({ x: 1, y: 0 }, { x: 0, y: 0 }, 2, 2, 4, 4),
    );

    expect(payload.resultValue).toBe(4);
    expect(payload.scoreDelta).toBe(4);
  });
});

describe('temporal-anchor (board-manipulation)', () => {
  it('rewinds the board to the anchor and withdraws the move', () => {
    const target = bench('temporal-anchor');

    place(target.grid, 0, 0, 2);
    place(target.grid, 1, 1, 4);
    dispatch(target, 'onAfterMove', afterMovePayload(target.grid, 40));

    const anchored = occupants(target.grid);

    // The board fills; the anchor is what the next move rewinds to.
    fill(target.grid, 8);

    const payload = dispatch(
      target,
      'onBeforeMove',
      beforeMovePayload(target.grid),
    );

    expect(payload.cancelled).toBe(true);
    expect(occupants(target.grid)).toEqual(anchored);
    expectConsistentLattice(target.grid);
  });

  it('renders every rewound tile as appearing rather than moving', () => {
    const target = bench('temporal-anchor');

    place(target.grid, 0, 0, 2);
    dispatch(target, 'onAfterMove', afterMovePayload(target.grid, 40));
    fill(target.grid, 8);
    dispatch(target, 'onBeforeMove', beforeMovePayload(target.grid));

    expect(
      target.grid.cellContent({ x: 0, y: 0 })?.previousPosition,
    ).toBeNull();
  });

  it('does nothing while the board still holds an empty cell', () => {
    const target = bench('temporal-anchor');

    place(target.grid, 0, 0, 2);
    dispatch(target, 'onAfterMove', afterMovePayload(target.grid, 40));
    place(target.grid, 1, 1, 8);

    const payload = dispatch(
      target,
      'onBeforeMove',
      beforeMovePayload(target.grid),
    );

    expect(payload.cancelled).toBe(false);
    expect(occupants(target.grid)).toHaveLength(2);
  });

  it('does nothing, and throws nothing, with no anchor held', () => {
    const target = bench('temporal-anchor');

    fill(target.grid, 8);

    const before = target.grid.serialize();
    const payload = dispatch(
      target,
      'onBeforeMove',
      beforeMovePayload(target.grid),
    );

    expect(payload.cancelled).toBe(false);
    expect(target.grid.serialize()).toEqual(before);
  });

  it('keeps its anchor JSON-serialisable', () => {
    const target = bench('temporal-anchor');

    place(target.grid, 0, 0, 2);
    dispatch(target, 'onAfterMove', afterMovePayload(target.grid, 40));

    const held = target.bus
      .subscribers()
      .find((subscriber) => subscriber.id === 'temporal-anchor');
    const state = held?.state as { board: unknown; score: number };

    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(state.score).toBe(40);
  });
});

describe('tumbler (board-manipulation)', () => {
  it('relocates every tile without changing the value multiset', () => {
    const target = bench('tumbler');

    fill(target.grid, 2);
    target.grid.removeTile(
      target.grid.cellContent({ x: 0, y: 0 }) ?? new Tile({ x: 0, y: 0 }),
    );
    place(target.grid, 1, 1, 1024);
    target.grid.removeTile(
      target.grid.cellContent({ x: 1, y: 1 }) ?? new Tile({ x: 1, y: 1 }),
    );
    place(target.grid, 1, 1, 1024);

    const before = values(target.grid);
    const payload = dispatch(
      target,
      'onBeforeMove',
      beforeMovePayload(target.grid),
    );

    expect(payload.cancelled).toBe(false);
    expect(payload.direction).toBe(DIRECTION_LEFT);
    expect(values(target.grid)).toEqual(before);
    expectConsistentLattice(target.grid);
  });

  it('actually moves at least one tile', () => {
    const target = bench('tumbler');

    fill(target.grid, 2);
    target.grid.removeTile(
      target.grid.cellContent({ x: 0, y: 0 }) ?? new Tile({ x: 0, y: 0 }),
    );
    place(target.grid, 2, 2, 512);
    target.grid.removeTile(
      target.grid.cellContent({ x: 2, y: 2 }) ?? new Tile({ x: 2, y: 2 }),
    );
    place(target.grid, 2, 2, 512);
    dispatch(target, 'onBeforeMove', beforeMovePayload(target.grid));

    const moved = occupants(target.grid).filter(
      (cell) =>
        target.grid.cellContent({ x: cell.x, y: cell.y })?.previousPosition !==
        null,
    );

    expect(moved.length).toBeGreaterThan(0);
  });

  it('tweens a relocated tile rather than popping it', () => {
    const target = bench('tumbler');

    fill(target.grid, 2);
    target.grid.removeTile(
      target.grid.cellContent({ x: 0, y: 0 }) ?? new Tile({ x: 0, y: 0 }),
    );
    dispatch(target, 'onBeforeMove', beforeMovePayload(target.grid));

    const tweened = occupants(target.grid).some(
      (cell) =>
        target.grid.cellContent({ x: cell.x, y: cell.y })?.previousPosition !==
        null,
    );

    expect(tweened).toBe(true);
  });

  it('does nothing on a board with room above the scarcity band', () => {
    const target = bench('tumbler');

    place(target.grid, 0, 0, 2);

    const before = target.grid.serialize();

    dispatch(target, 'onBeforeMove', beforeMovePayload(target.grid));

    expect(target.grid.serialize()).toEqual(before);
  });

  it('does nothing on a full board, leaving that to the anchor', () => {
    const target = bench('tumbler');

    fill(target.grid, 2);

    const before = target.grid.serialize();

    dispatch(target, 'onBeforeMove', beforeMovePayload(target.grid));

    expect(target.grid.serialize()).toEqual(before);
  });

  it('is deterministic under a fixed seed', () => {
    const first = bench('tumbler');
    const second = bench('tumbler');

    for (const target of [first, second]) {
      fill(target.grid, 2);
      target.grid.removeTile(
        target.grid.cellContent({ x: 0, y: 0 }) ?? new Tile({ x: 0, y: 0 }),
      );
      place(target.grid, 3, 3, 64);
      target.grid.removeTile(
        target.grid.cellContent({ x: 3, y: 3 }) ?? new Tile({ x: 3, y: 3 }),
      );
      place(target.grid, 3, 3, 64);
      dispatch(target, 'onBeforeMove', beforeMovePayload(target.grid));
    }

    expect(occupants(first.grid)).toEqual(occupants(second.grid));
  });
});

describe('culling-blade (board-manipulation)', () => {
  it('excises the single lowest-valued tile and nothing else', () => {
    const target = bench('culling-blade', 6);

    for (let index = 0; index < 6; index += 1) {
      place(target.grid, index, 0, 2);
    }

    place(target.grid, 0, 1, 1024);

    const payload = dispatch(
      target,
      'onBeforeMove',
      beforeMovePayload(target.grid),
    );

    expect(payload.cancelled).toBe(false);
    expect(occupants(target.grid)).toHaveLength(6);
    expect(target.grid.cellContent({ x: 0, y: 0 })).toBeNull();
    expect(target.grid.cellContent({ x: 0, y: 1 })?.value).toBe(1024);
    expectConsistentLattice(target.grid);
  });

  it('breaks a tie by the x-outer, y-inner scan order', () => {
    const target = bench('culling-blade', 6);

    for (let index = 0; index < 6; index += 1) {
      place(target.grid, index, 1, 2);
    }

    dispatch(target, 'onBeforeMove', beforeMovePayload(target.grid));

    expect(target.grid.cellContent({ x: 0, y: 1 })).toBeNull();
    expect(target.grid.cellContent({ x: 1, y: 1 })?.value).toBe(2);
  });

  it('does nothing before the arming threshold is reached', () => {
    const target = bench('culling-blade', 6);

    place(target.grid, 0, 0, 2);

    const before = target.grid.serialize();

    dispatch(target, 'onBeforeMove', beforeMovePayload(target.grid));

    expect(target.grid.serialize()).toEqual(before);
  });

  it('consumes no randomness', () => {
    const target = bench('culling-blade', 6);

    for (let index = 0; index < 6; index += 1) {
      place(target.grid, index, 0, 2);
    }

    const before = target.streams.snapshotCursors();

    dispatch(target, 'onBeforeMove', beforeMovePayload(target.grid));

    expect(target.streams.snapshotCursors()).toEqual(before);
  });
});

describe('scouring-wind (board-manipulation)', () => {
  it('clears every tile of the first fully-occupied row', () => {
    const target = bench('scouring-wind');

    // A ROW is one fixed `y` across every `x`, so row 1 is filled and the tile
    // at (0, 0) stands outside it.
    for (let x = 0; x < target.grid.size; x += 1) {
      place(target.grid, x, 1, 2);
    }

    place(target.grid, 0, 0, 8);

    const payload = dispatch(
      target,
      'onAfterMove',
      afterMovePayload(target.grid, 12),
    );

    expect(payload.score).toBe(12);
    expect(occupants(target.grid)).toEqual([{ x: 0, y: 0, value: 8 }]);
    expectConsistentLattice(target.grid);
  });

  it('clears the first such row and leaves a later one standing', () => {
    const target = bench('scouring-wind');

    for (let x = 0; x < target.grid.size; x += 1) {
      for (let y = 0; y < target.grid.size; y += 1) {
        place(target.grid, x, y, 2);
      }
    }

    dispatch(target, 'onAfterMove', afterMovePayload(target.grid));

    // Row 0 went; row 1 is a later row and stands.
    expect(target.grid.cellContent({ x: 0, y: 0 })).toBeNull();
    expect(target.grid.cellContent({ x: 1, y: 0 })).toBeNull();
    expect(target.grid.cellContent({ x: 0, y: 1 })?.value).toBe(2);
    expect(target.grid.cellContent({ x: 1, y: 1 })?.value).toBe(2);
  });

  it('does nothing when no row is fully occupied', () => {
    const target = bench('scouring-wind');

    place(target.grid, 0, 0, 2);
    place(target.grid, 0, 1, 2);

    const before = target.grid.serialize();

    dispatch(target, 'onAfterMove', afterMovePayload(target.grid));

    expect(target.grid.serialize()).toEqual(before);
  });

  it('consumes no randomness', () => {
    const target = bench('scouring-wind');

    for (let x = 0; x < target.grid.size; x += 1) {
      place(target.grid, x, 0, 2);
    }

    const before = target.streams.snapshotCursors();

    dispatch(target, 'onAfterMove', afterMovePayload(target.grid));

    expect(target.streams.snapshotCursors()).toEqual(before);
  });
});

describe('collapsing-vault (risk-reward-cursed)', () => {
  it('shrinks the live board and sets BOTH size fields', () => {
    const target = bench('collapsing-vault');

    place(target.grid, 0, 0, 2);
    dispatch(target, 'onStageEnd', stageEndPayload(true));

    expect(target.grid.size).toBe(3);
    expect(target.config.boardSize).toBe(3);
    expect(target.grid.cells).toHaveLength(3);
    expectConsistentLattice(target.grid);
  });

  it('re-homes an exile instead of dropping it', () => {
    const target = bench('collapsing-vault');

    place(target.grid, 3, 3, 1024);
    place(target.grid, 0, 0, 2);
    dispatch(target, 'onStageEnd', stageEndPayload(true));

    expect(values(target.grid)).toEqual([2, 1024]);
    expect(target.grid.availableCells()).toHaveLength(7);
    expectConsistentLattice(target.grid);
  });

  it('re-homes the highest-valued exile first', () => {
    const target = bench('collapsing-vault', 4);

    // Only one in-range cell is left free, so the higher exile must take it.
    for (let x = 0; x < 3; x += 1) {
      for (let y = 0; y < 3; y += 1) {
        place(target.grid, x, y, 2);
      }
    }

    target.grid.removeTile(
      target.grid.cellContent({ x: 2, y: 2 }) ?? new Tile({ x: 2, y: 2 }),
    );
    place(target.grid, 3, 0, 64);
    place(target.grid, 0, 3, 512);
    dispatch(target, 'onStageEnd', stageEndPayload(true));

    expect(target.grid.cellContent({ x: 2, y: 2 })?.value).toBe(512);
    expect(values(target.grid)).not.toContain(64);
  });

  it('keeps the win value untouched', () => {
    const target = bench('collapsing-vault');
    const winValue = target.config.winValue;

    dispatch(target, 'onStageEnd', stageEndPayload(true));

    expect(target.config.winValue).toBe(winValue);
  });

  it('does nothing when the stage was not cleared', () => {
    const target = bench('collapsing-vault');

    place(target.grid, 3, 3, 1024);

    const before = target.grid.serialize();

    dispatch(target, 'onStageEnd', stageEndPayload(false));

    expect(target.grid.serialize()).toEqual(before);
    expect(target.config.boardSize).toBe(DEFAULT_BOARD_SIZE);
  });

  it('does nothing at the floor, and takes no draw there', () => {
    const target = bench('collapsing-vault', 3);
    const before = target.streams.snapshotCursors();

    place(target.grid, 2, 2, 8);
    dispatch(target, 'onStageEnd', stageEndPayload(true));

    expect(target.grid.size).toBe(3);
    expect(target.config.boardSize).toBe(3);
    expect(target.streams.snapshotCursors()).toEqual(before);
  });

  it('leaves a snapshot that round-trips and rebuilds coherently', () => {
    const target = bench('collapsing-vault');

    place(target.grid, 3, 3, 1024);
    place(target.grid, 0, 0, 2);
    dispatch(target, 'onStageEnd', stageEndPayload(true));

    const snapshot = target.grid.serialize();
    const rebuilt = new Grid(snapshot.size, snapshot.cells);

    expect(rebuilt.serialize()).toEqual(snapshot);
    expectConsistentLattice(rebuilt);
  });

  it('is deterministic under a fixed seed', () => {
    const first = bench('collapsing-vault');
    const second = bench('collapsing-vault');

    for (const target of [first, second]) {
      place(target.grid, 3, 3, 1024);
      place(target.grid, 3, 0, 512);
      place(target.grid, 0, 0, 2);
      dispatch(target, 'onStageEnd', stageEndPayload(true));
    }

    expect(occupants(first.grid)).toEqual(occupants(second.grid));
  });
});

describe('brittle-crown (risk-reward-cursed)', () => {
  it('installs a skewed distribution and saves the original', () => {
    const target = bench('brittle-crown');
    const original = [...target.config.spawn.weights];

    dispatch(target, 'onStageStart', stageStartPayload(target.grid.size));

    expect(target.config.spawn.weights).not.toEqual(original);
    expect(target.config.spawn.weights).toHaveLength(
      target.config.spawn.values.length,
    );

    for (const weight of target.config.spawn.weights) {
      expect(Number.isFinite(weight)).toBe(true);
      expect(weight).toBeGreaterThanOrEqual(0);
    }

    const held = target.bus
      .subscribers()
      .find((subscriber) => subscriber.id === 'brittle-crown');

    expect(held?.state).toEqual({ savedWeights: original });
  });

  it('biases the highest configured spawn value', () => {
    const target = bench('brittle-crown');
    const values = target.config.spawn.values;
    const highest = Math.max(...values);
    const before = [...target.config.spawn.weights];

    dispatch(target, 'onStageStart', stageStartPayload(target.grid.size));

    const index = values.indexOf(highest);

    expect(target.config.spawn.weights[index]).toBeGreaterThan(before[index]);
  });

  it('does not skew an already-skewed distribution on a second stage', () => {
    const target = bench('brittle-crown');
    const original = [...target.config.spawn.weights];

    dispatch(target, 'onStageStart', stageStartPayload(target.grid.size));

    const installed = [...target.config.spawn.weights];

    dispatch(target, 'onStageStart', stageStartPayload(target.grid.size));

    expect(target.config.spawn.weights).toEqual(installed);

    const held = target.bus
      .subscribers()
      .find((subscriber) => subscriber.id === 'brittle-crown');

    expect(held?.state).toEqual({ savedWeights: original });
  });

  it('restores the saved distribution and clears the slot on stage end', () => {
    const target = bench('brittle-crown');
    const original = [...target.config.spawn.weights];

    dispatch(target, 'onStageStart', stageStartPayload(target.grid.size));
    dispatch(target, 'onStageEnd', stageEndPayload(true));

    expect(target.config.spawn.weights).toEqual(original);

    const held = target.bus
      .subscribers()
      .find((subscriber) => subscriber.id === 'brittle-crown');

    expect(held?.state).toEqual({});
  });

  it('survives a reload: the fresh configuration is skewed once', () => {
    const target = bench('brittle-crown');
    const original = [...target.config.spawn.weights];

    dispatch(target, 'onStageStart', stageStartPayload(target.grid.size));

    const installed = [...target.config.spawn.weights];
    const reloaded = createDefaultRulesConfig();
    const reloadedBench: Bench = {
      ...target,
      config: reloaded,
      environment: {
        config: reloaded,
        rng: target.streams,
        grid: target.grid,
      },
    };

    dispatch(
      reloadedBench,
      'onStageStart',
      stageStartPayload(target.grid.size),
    );

    expect(reloaded.spawn.weights).toEqual(installed);

    const held = target.bus
      .subscribers()
      .find((subscriber) => subscriber.id === 'brittle-crown');

    expect(held?.state).toEqual({ savedWeights: original });
  });

  it('still pays the clearing bounty', () => {
    const target = bench('brittle-crown');
    const payload = dispatch(target, 'onStageEnd', stageEndPayload(true, 400));

    expect(payload.score).toBe(500);
  });

  it('pays nothing for a stage that was not cleared', () => {
    const target = bench('brittle-crown');
    const payload = dispatch(target, 'onStageEnd', stageEndPayload(false, 400));

    expect(payload.score).toBe(400);
  });

  it('consumes no randomness', () => {
    const target = bench('brittle-crown');
    const before = target.streams.snapshotCursors();

    dispatch(target, 'onStageStart', stageStartPayload(target.grid.size));
    dispatch(target, 'onStageEnd', stageEndPayload(true));

    expect(target.streams.snapshotCursors()).toEqual(before);
  });
});

describe('the write channel does not widen a handler s reach', () => {
  it('still hands onBeforeMove the read-only facade, not the board', () => {
    const target = bench('tumbler');
    const view = createReadonlyGridView(target.grid);

    expect(view).not.toBe(target.grid);
    expect((view as unknown as Record<string, unknown>)['insertTile']).toBe(
      undefined,
    );
    expect((view as unknown as Record<string, unknown>)['cells']).toBe(
      undefined,
    );
  });
});
