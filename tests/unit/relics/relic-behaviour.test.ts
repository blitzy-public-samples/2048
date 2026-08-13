// Contract suite for the sixteen relics: the catalogue's shape, the effect
// each relic actually has on board state, charge exhaustion end to end, and
// the determinism every one of them has to keep.
//
// This suite reads no DOM, installs no mock library and writes no snapshot.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BOARD_SIZE,
  createDefaultRulesConfig,
} from '../../../src/config/default-config';
import type { RulesConfig } from '../../../src/config/rules-config';
import { createDefaultStageConfig } from '../../../src/config/stage-config';
import { Engine } from '../../../src/engine/engine';
import { createHookBus } from '../../../src/engine/hook-bus';
import type { HookBus } from '../../../src/engine/hook-bus';
import { HOOK_NAMES } from '../../../src/engine/hooks';
import { Tile } from '../../../src/engine/tile';
import { DIRECTION_LEFT, DIRECTION_UP } from '../../../src/engine/types';
import type {
  SerializedGameState,
  SerializedTile,
  StageCommitContext,
} from '../../../src/engine/types';
import {
  RELIC_CATALOGUE,
  RelicRegistry,
} from '../../../src/relics/relic-registry';
import {
  RARITIES,
  RELIC_FAMILY_NAMES,
} from '../../../src/relics/relic-types';
import { BOARD_MANIPULATION_FAMILY } from '../../../src/relics/families/board-manipulation';
import { MERGE_MAGIC_FAMILY } from '../../../src/relics/families/merge-magic';
import { RISK_REWARD_CURSED_FAMILY } from '../../../src/relics/families/risk-reward-cursed';
import { SPAWN_CONTROL_FAMILY } from '../../../src/relics/families/spawn-control';
import { createRngStreams } from '../../../src/rng/rng-streams';
import type { RngStreams } from '../../../src/rng/rng-streams';

/** Run seed every deterministic case below is built from. */
const RUN_SEED = 'relic-behaviour-seed-1';

/** How many relics the catalogue declares (AAP A1). */
const CATALOGUE_SIZE = 16;

/** How many relics each family declares. */
const FAMILY_SIZE = 4;

/** The seven members `Relic` declares and no others (AAP Contract 3). */
const RELIC_REQUIRED_MEMBERS = ['description', 'hooks', 'id', 'name', 'rarity'];

/** Every member a relic declaration may carry. */
const RELIC_ALLOWED_MEMBERS = new Set([
  ...RELIC_REQUIRED_MEMBERS,
  'charges',
  'state',
]);

/**
 * Builds a lattice from a row-major table of face values.
 *
 * @param rows Face values by row, `0` standing for an empty cell.
 * @returns The snapshot.
 */
function boardFrom(rows: ReadonlyArray<readonly number[]>): SerializedGameState {
  const size = rows.length;
  const cells: (SerializedTile | null)[][] = [];

  for (let x = 0; x < size; x += 1) {
    const column: (SerializedTile | null)[] = [];

    for (let y = 0; y < size; y += 1) {
      const value = rows[y]?.[x] ?? 0;

      column.push(value > 0 ? { position: { x, y }, value } : null);
    }

    cells.push(column);
  }

  return {
    grid: { size, cells },
    score: 0,
    over: false,
    won: false,
    keepPlaying: false,
  };
}

/** A board with exactly one mergeable pair and plenty of room. */
const OPEN_PAIR = (): SerializedGameState =>
  boardFrom([
    [2, 2, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);

/** Reads the occupied face values of a snapshot, x-major. */
function values(state: SerializedGameState): number[] {
  return state.grid.cells
    .flat()
    .filter((cell): cell is SerializedTile => cell !== null)
    .map((cell) => cell.value);
}

/** Reads the face value one cell holds, or `0`. */
function valueAt(state: SerializedGameState, x: number, y: number): number {
  return state.grid.cells[x]?.[y]?.value ?? 0;
}

/** What `compose` built. */
interface Composed {
  readonly engine: Engine;
  readonly bus: HookBus;
  readonly registry: RelicRegistry;
  readonly config: RulesConfig;
  readonly streams: RngStreams;
}

/**
 * Composes an engine, a hook bus and a relic registry, and picks up the relics
 * named — in the order named, which is pickup order.
 *
 * @param relicIds Relics to hold, in pickup order.
 * @param options Seed, stage source, and the board to open on.
 * @returns The composition.
 */
function compose(
  relicIds: readonly string[],
  options: {
    seed?: string;
    board?: SerializedGameState | null;
    stageContext?: () => StageCommitContext;
    setup?: boolean;
  } = {},
): Composed {
  const config = createDefaultRulesConfig();
  const bus = createHookBus();
  const registry = new RelicRegistry({ bus });
  const streams = createRngStreams(options.seed ?? RUN_SEED);

  for (const id of relicIds) {
    expect(registry.pickUp(id)).toBeDefined();
  }

  const engine = new Engine({
    config,
    streams,
    hooks: bus,
    stages: createDefaultStageConfig(),
    stageContext: options.stageContext,
    relicContext: registry.commitContextProvider(),
  });

  if (options.setup !== false) {
    engine.setup(options.board ?? null);
  }

  return { engine, bus, registry, config, streams };
}

describe('the relic catalogue', () => {
  it('declares sixteen relics across four families, four apiece', () => {
    expect(RELIC_CATALOGUE).toHaveLength(CATALOGUE_SIZE);
    expect(SPAWN_CONTROL_FAMILY.relics).toHaveLength(FAMILY_SIZE);
    expect(MERGE_MAGIC_FAMILY.relics).toHaveLength(FAMILY_SIZE);
    expect(BOARD_MANIPULATION_FAMILY.relics).toHaveLength(FAMILY_SIZE);
    expect(RISK_REWARD_CURSED_FAMILY.relics).toHaveLength(FAMILY_SIZE);
    expect([
      SPAWN_CONTROL_FAMILY.name,
      MERGE_MAGIC_FAMILY.name,
      BOARD_MANIPULATION_FAMILY.name,
      RISK_REWARD_CURSED_FAMILY.name,
    ]).toEqual([...RELIC_FAMILY_NAMES]);
  });

  it('gives every relic a unique identifier', () => {
    const ids = RELIC_CATALOGUE.map((relic) => relic.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('carries only the members the relic data shape declares', () => {
    for (const relic of RELIC_CATALOGUE) {
      for (const member of Object.keys(relic)) {
        expect(RELIC_ALLOWED_MEMBERS.has(member)).toBe(true);
      }

      for (const member of RELIC_REQUIRED_MEMBERS) {
        expect(Object.keys(relic)).toContain(member);
      }
    }
  });

  it('binds every handler to one of the six hook names', () => {
    for (const relic of RELIC_CATALOGUE) {
      for (const hook of Object.keys(relic.hooks)) {
        expect(HOOK_NAMES).toContain(hook);
      }

      expect(Object.keys(relic.hooks).length).toBeGreaterThan(0);
    }
  });

  it('freezes every declaration and every handler table', () => {
    expect(Object.isFrozen(RELIC_CATALOGUE)).toBe(true);

    for (const relic of RELIC_CATALOGUE) {
      expect(Object.isFrozen(relic)).toBe(true);
      expect(Object.isFrozen(relic.hooks)).toBe(true);
    }
  });

  it('covers all four rarity tiers in every family', () => {
    for (const family of [
      SPAWN_CONTROL_FAMILY,
      MERGE_MAGIC_FAMILY,
      BOARD_MANIPULATION_FAMILY,
      RISK_REWARD_CURSED_FAMILY,
    ]) {
      expect(family.relics.map((relic) => relic.rarity)).toEqual([
        ...RARITIES,
      ]);
    }
  });
});

describe('charge accounting through the registry and the bus', () => {
  it('spends a charge for every turn a charge relic acted on, and stops', () => {
    // `scouring-wind` carries exactly one charge and clears the first
    // fully-occupied ROW after a move — a row being one fixed `y` across every
    // `x`. CHANGED: this said column. DL-TEST-14.
    const full = boardFrom([
      [2, 4, 8, 16],
      [2, 32, 64, 128],
      [4, 8, 16, 32],
      [64, 128, 256, 512],
    ]);
    const { engine, registry } = compose(['scouring-wind'], { board: full });

    expect(registry.find('scouring-wind')?.charges).toBe(1);

    engine.move(DIRECTION_UP);

    // The charge was spent by the invocation that cleared a column.
    expect(registry.find('scouring-wind')?.charges).toBe(0);

    const afterFirst = values(engine.serialize()).length;

    engine.move(DIRECTION_LEFT);

    expect(registry.find('scouring-wind')?.charges).toBe(0);
    expect(values(engine.serialize()).length).toBeGreaterThanOrEqual(
      afterFirst,
    );
  });

  it('spends nothing on a turn a charge relic did not act on', () => {
    // An open board never arms `temporal-anchor`, whose undo needs a full one.
    const { engine, registry } = compose(['temporal-anchor'], {
      board: OPEN_PAIR(),
    });

    engine.move(DIRECTION_LEFT);
    engine.move(DIRECTION_UP);

    expect(registry.find('temporal-anchor')?.charges).toBe(3);
  });

  it('never throws when a relic is invoked with zero charges left', () => {
    const bus = createHookBus();
    const registry = new RelicRegistry({ bus });

    registry.restore([{ id: 'scouring-wind', charges: 0 }]);

    // CHANGED: this was `expect(registry.restore(...)).toBe(undefined)`, and
    // `restore` returns `void`, so the assertion held for every possible
    // implementation — including one that restored nothing at all. What the
    // restore is FOR is asserted instead: the relic is held at the persisted
    // budget, it is subscribed to the bus so its handlers can be reached, and
    // the projection reports it. DL-TEST-14.
    expect(registry.find('scouring-wind')?.charges).toBe(0);
    expect(registry.ownedIds()).toEqual(['scouring-wind']);
    expect(registry.size()).toBe(1);
    expect(bus.subscribers().map((subscriber) => subscriber.id)).toContain(
      'scouring-wind',
    );
    expect(registry.relicContext()).toEqual([
      { id: 'scouring-wind', charges: 0 },
    ]);

    const config = createDefaultRulesConfig();
    const engine = new Engine({
      config,
      streams: createRngStreams(RUN_SEED),
      hooks: bus,
      relicContext: registry.commitContextProvider(),
    });

    engine.setup(
      boardFrom([
        [2, 4, 8, 16],
        [2, 32, 64, 128],
        [4, 8, 16, 32],
        [64, 128, 256, 512],
      ]),
    );

    expect(() => {
      engine.move(DIRECTION_UP);
    }).not.toThrow();

    expect(registry.find('scouring-wind')?.charges).toBe(0);
    expect(registry.relicContext()[0]).toEqual({
      id: 'scouring-wind',
      charges: 0,
    });
  });

  it('persists the spent budget through the registry projection', () => {
    const full = boardFrom([
      [2, 4, 8, 16],
      [2, 32, 64, 128],
      [4, 8, 16, 32],
      [64, 128, 256, 512],
    ]);
    const { engine, registry } = compose(['scouring-wind'], { board: full });

    engine.move(DIRECTION_UP);

    expect(registry.serialize()).toEqual([
      { id: 'scouring-wind', charges: 0, state: expect.anything() },
    ]);
  });
});

describe('the board-manipulation family', () => {
  it('pulls the board back to the last roomy position (temporal-anchor)', () => {
    // Two empty cells, and a mergeable pair in column x = 0, so the first move
    // resolves and leaves room: that is the position the anchor records.
    const { engine, registry } = compose(['temporal-anchor'], {
      board: boardFrom([
        [2, 4, 8, 16],
        [2, 32, 64, 128],
        [8, 8, 16, 32],
        [0, 128, 256, 0],
      ]),
    });

    engine.move(DIRECTION_UP);

    const anchored = engine.serialize();
    const anchor = registry.find('temporal-anchor')?.state as {
      board: { size: number } | null;
      score: number;
    };

    expect(anchor.board).not.toBeNull();
    expect(anchored.grid.cells.flat().some((cell) => cell === null)).toBe(true);

    // The board is now filled outright, which is the state the undo arms on.
    const full = boardFrom([
      [2, 4, 8, 16],
      [32, 64, 128, 256],
      [512, 1024, 2, 4],
      [8, 16, 32, 64],
    ]);

    engine.setup(full);

    const charges = registry.find('temporal-anchor')?.charges ?? 0;

    expect(charges).toBe(3);
    expect(engine.serialize().grid.cells.flat().every((cell) => cell !== null))
      .toBe(true);

    // The undo arms, restores the anchored lattice and withdraws the move.
    engine.move(DIRECTION_LEFT);

    const undone = engine.serialize();

    expect(undone.grid).not.toEqual(full.grid);
    expect(undone.grid).toEqual(anchored.grid);
    expect(engine.score).toBe(anchor.score);
    expect(registry.find('temporal-anchor')?.charges).toBe(charges - 1);

    // The anchor was consumed with the undo, so a second full board is not
    // undone from a position two turns old.
    expect(
      (registry.find('temporal-anchor')?.state as { board: unknown }).board,
    ).toBeNull();
  });

  it('permutes the whole board deterministically (tumbler)', () => {
    // A board inside the scarcity band: at most a quarter of its cells empty.
    const tight = (): SerializedGameState =>
      boardFrom([
        [2, 4, 8, 16],
        [32, 64, 128, 256],
        [512, 1024, 4, 8],
        [16, 32, 0, 0],
      ]);

    const first = compose(['tumbler'], { board: tight() });
    const beforeArrangement = values(first.engine.serialize());
    const before = beforeArrangement.slice().sort((a, b) => a - b);

    first.engine.move(DIRECTION_LEFT);

    const after = first.engine.serialize();
    const afterArrangement = values(after);
    const sortedAfter = afterArrangement.slice().sort((a, b) => a - b);

    // A permutation neither creates nor destroys material.
    //
    // CHANGED: `before` was computed, sorted and then never compared with
    // anything. The two assertions here were `join(',')` not being the empty
    // string — true of any non-empty board — and `before.length > 0`, so the
    // conservation this case is named for was entirely unproved. DL-TEST-14.
    expect(sortedAfter).toEqual(before);
    expect(afterArrangement).toHaveLength(beforeArrangement.length);
    expect(sortedAfter.reduce((sum, value) => sum + value, 0)).toBe(
      before.reduce((sum, value) => sum + value, 0),
    );

    // No merge resolved, so conservation is exact rather than net of a merge.
    expect(after.score).toBe(0);

    // NON-VACUITY. Conservation is trivially satisfied by doing nothing, so the
    // arrangement must have actually moved — and the same board and the same
    // move WITHOUT the relic must leave it alone, which is what attributes the
    // permutation to the tumbler rather than to the slide.
    expect(afterArrangement).not.toEqual(beforeArrangement);

    const unaided = compose([], { board: tight() });
    const unaidedBefore = values(unaided.engine.serialize());

    unaided.engine.move(DIRECTION_LEFT);

    expect(values(unaided.engine.serialize())).toEqual(unaidedBefore);

    // And it is reproducible: the same seed and the same move yield the same
    // board, which is what keeps a recorded run replayable.
    const second = compose(['tumbler'], { board: tight() });

    second.engine.move(DIRECTION_LEFT);

    expect(second.engine.serialize()).toEqual(after);

    // A charge was spent for the permutation.
    expect(first.registry.find('tumbler')?.charges).toBe(2);
  });

  it('excises the single smallest tile before the move resolves ' +
    '(culling-blade)', () => {
    const { engine, registry } = compose(['culling-blade'], {
      board: boardFrom([
        [4, 2, 2, 2],
        [2, 2, 2, 2],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ]),
    });

    const before = values(engine.serialize()).length;

    engine.move(DIRECTION_UP);

    const after = engine.serialize();

    // ONE tile, not every tile of that value: the blade takes the first lowest
    // cell it finds and no other, so the board still holds the rest of the 2s.
    expect(values(after).length).toBeGreaterThan(1);
    expect(values(after).length).toBeLessThan(before);
    expect(registry.find('culling-blade')?.charges).toBe(1);
  });

  it('clears the first fully-occupied row outright (scouring-wind)', () => {
    const { engine, registry } = compose(['scouring-wind'], {
      board: boardFrom([
        [2, 4, 8, 16],
        [2, 32, 64, 128],
        [8, 8, 16, 32],
        [16, 128, 256, 512],
      ]),
    });

    engine.move(DIRECTION_UP);

    const after = engine.serialize();
    const slot = registry.find('scouring-wind')?.state as
      | { readonly row?: { readonly y: number } }
      | undefined;
    const swept = slot?.row;

    // A ROW, AND THE SLOT NAMES WHICH: one fixed `y` across every `x`, which is
    // one element taken from each sub-array of the x-major `cells`. Counting
    // emptied sub-arrays instead would have measured a column and passed on a
    // relic clearing the wrong axis.
    expect(swept).toBeDefined();

    const y = swept?.y ?? -1;

    for (let x = 0; x < DEFAULT_BOARD_SIZE; x += 1) {
      expect(valueAt(after, x, y)).toBe(0);
    }

    // The spawn is placed before `onAfterMove`, so the sweep clears it too when
    // it landed in the row — which is why the row above is empty outright.
    expect(values(after).length).toBeLessThan(
      DEFAULT_BOARD_SIZE * DEFAULT_BOARD_SIZE,
    );
  });
});

describe('the spawn-control family', () => {
  it('sprouts a second tile with every spawn (fertile-ground)', () => {
    const { engine } = compose(['fertile-ground'], { board: OPEN_PAIR() });
    const spawns: number[] = [];

    engine.events.on('tile:spawn', (event): void => {
      if (event.position !== undefined) {
        spawns.push(event.value);
      }
    });

    const before = values(engine.serialize()).length;

    engine.move(DIRECTION_LEFT);

    // Two spawns, and the board holds one more tile than the merge left it.
    expect(spawns).toHaveLength(2);
    expect(values(engine.serialize()).length).toBe(before - 1 + 2);
  });

  it('stays deterministic under a fixed seed (gate V6)', () => {
    const play = (): string => {
      const { engine } = compose(
        ['fertile-ground', 'twin-seed', 'loaded-dice'],
        { board: OPEN_PAIR() },
      );

      engine.move(DIRECTION_LEFT);
      engine.move(DIRECTION_UP);

      return JSON.stringify(engine.serialize());
    };

    expect(play()).toBe(play());
  });
});

describe('the merge-magic family', () => {
  it('writes the raised value onto the board (alloy-forge)', () => {
    const plain = compose([], { board: OPEN_PAIR() });
    const forged = compose(['alloy-forge'], { board: OPEN_PAIR() });

    plain.engine.move(DIRECTION_LEFT);
    forged.engine.move(DIRECTION_LEFT);

    const plainMerge = valueAt(plain.engine.serialize(), 0, 0);
    const forgedMerge = valueAt(forged.engine.serialize(), 0, 0);

    // The merged tile ITSELF carries the raised value, which is the property a
    // payload transformed after the tile was built could not have.
    expect(plainMerge).toBe(4);
    expect(forgedMerge).toBeGreaterThan(plainMerge);
    expect(forged.engine.score).toBeGreaterThan(plain.engine.score);
  });

  it('raises the score without touching the tile (echo-chamber)', () => {
    const plain = compose([], { board: OPEN_PAIR() });
    const echoed = compose(['echo-chamber'], { board: OPEN_PAIR() });

    plain.engine.move(DIRECTION_LEFT);
    echoed.engine.move(DIRECTION_LEFT);

    expect(valueAt(echoed.engine.serialize(), 0, 0)).toBe(
      valueAt(plain.engine.serialize(), 0, 0),
    );
    expect(echoed.engine.score).toBeGreaterThan(plain.engine.score);
  });

  it('compounds two merge relics in pickup order (gate V6)', () => {
    const single = compose(['alloy-forge'], { board: OPEN_PAIR() });
    const both = compose(['alloy-forge', 'echo-chamber'], {
      board: OPEN_PAIR(),
    });

    single.engine.move(DIRECTION_LEFT);
    both.engine.move(DIRECTION_LEFT);

    // Both fired: the tile carries alloy-forge's raise and the score carries
    // echo-chamber's echo of that raised value on top of it.
    expect(valueAt(both.engine.serialize(), 0, 0)).toBe(
      valueAt(single.engine.serialize(), 0, 0),
    );
    expect(both.engine.score).toBeGreaterThan(single.engine.score);
  });

  it('carries standing frost into the next stage as a merge rule, leaving ' +
    'the goal alone (frostbind)', () => {
    let index = 0;
    const target = 4096;
    const stageContext = (): StageCommitContext =>
      Object.freeze({
        stageIndex: index,
        goal: { kind: 'highest-tile' as const, target },
        goalProgress: 0,
      });

    const { engine, registry } = compose(['frostbind'], {
      board: OPEN_PAIR(),
      stageContext,
    });
    const goals: number[] = [];

    engine.events.on('stage:start', (event): void => {
      goals.push(event.goal.target);
    });

    // One merge frosts one cell.
    engine.move(DIRECTION_LEFT);

    expect(registry.find('frostbind')?.state).toEqual({
      frozen: [{ x: 0, y: 0 }],
    });

    index += 1;
    engine.startStage(engine.serialize());

    // The goal is not the channel. Frost is a merge-family effect: it installs
    // a predicate that refuses a merge into a frosted cell, and the stage's
    // target is carried across exactly as the provider set it.
    expect(goals.at(-1)).toBe(target);

    const frozen = engine.config.merge.canMerge;

    // The predicate reads the operands' cells where they carry them, exactly
    // as src/engine/move-resolver.ts hands it the live tile pair, so the
    // operands here are `Tile`s standing in the frosted cell.
    const frostedPair = new Tile({ x: 0, y: 0 }, 2);

    expect(frozen(frostedPair, frostedPair)).toBe(false);

    // A pair standing anywhere else still merges, so the rule is the frost and
    // not a blanket refusal.
    const thawedPair = new Tile({ x: 2, y: 2 }, 2);

    expect(frozen(thawedPair, thawedPair)).toBe(true);
  });
});

describe('the risk-reward-cursed family', () => {
  it('collapses the live board and keeps every surviving cell (collapsing-vault)', () => {
    const { engine, config, registry } = compose(['collapsing-vault'], {
      board: boardFrom([
        [2, 4, 8, 16],
        [32, 64, 128, 256],
        [512, 2, 4, 8],
        [16, 32, 64, 128],
      ]),
    });

    const before = engine.serialize();

    engine.endStage(true);

    const after = engine.serialize();

    expect(after.grid.size).toBe(DEFAULT_BOARD_SIZE - 1);
    expect(config.boardSize).toBe(DEFAULT_BOARD_SIZE - 1);

    // Every tile inside the new bounds kept its exact cell: no reindexing, no
    // compaction, and every recorded position matches the cell it occupies.
    for (let x = 0; x < after.grid.size; x += 1) {
      for (let y = 0; y < after.grid.size; y += 1) {
        expect(valueAt(after, x, y)).toBe(valueAt(before, x, y));
        expect(after.grid.cells[x]?.[y]?.position ?? { x, y }).toEqual({
          x,
          y,
        });
      }
    }

    // And the declaration is on the relic slot, which is what survives a
    // reload.
    expect(registry.find('collapsing-vault')?.state).toEqual({
      boardSize: DEFAULT_BOARD_SIZE - 1,
    });
  });

  it('leaves the win and loss checks reading the collapsed size', () => {
    const { engine, config } = compose(['collapsing-vault'], {
      board: boardFrom([
        [2, 4, 8, 16],
        [32, 64, 128, 256],
        [512, 2, 4, 8],
        [16, 32, 64, 128],
      ]),
    });

    engine.endStage(true);

    expect(() => {
      engine.move(DIRECTION_LEFT);
    }).not.toThrow();

    expect(engine.serialize().grid.size).toBe(config.boardSize);
    expect(engine.serialize().grid.cells).toHaveLength(config.boardSize);
  });
});

describe('relic state isolation', () => {
  it('gives each registry its own deep copy of a declaration slot', () => {
    const first = new RelicRegistry();
    const second = new RelicRegistry();

    const a = first.pickUp('frostbind');
    const b = second.pickUp('frostbind');

    expect(a?.state).toEqual(b?.state);
    expect(a?.state).not.toBe(b?.state);

    // A nested write on one reaches neither the other nor the declaration.
    (a?.state as { frozen: { x: number; y: number }[] }).frozen.push({
      x: 1,
      y: 1,
    });

    expect((b?.state as { frozen: unknown[] }).frozen).toHaveLength(0);
    expect(
      (a?.definition.state as { frozen: unknown[] }).frozen,
    ).toHaveLength(0);
  });

  it('shares no state between a restored run and its declaration', () => {
    const registry = new RelicRegistry();

    registry.restore([
      { id: 'frostbind', charges: 2, state: { frozen: [{ x: 2, y: 3 }] } },
    ]);

    const held = registry.find('frostbind');

    expect(held?.state).toEqual({ frozen: [{ x: 2, y: 3 }] });
    expect(held?.definition.state).toEqual({ frozen: [] });
  });
});

describe('hydrating a run from a persisted relic set', () => {
  it('reconstructs pickup order from the order the envelope carried', () => {
    const registry = new RelicRegistry({ bus: createHookBus() });

    registry.restore([
      { id: 'scouring-wind' },
      { id: 'twin-seed' },
      { id: 'frostbind' },
    ]);

    // Pickup order is the DISPATCH order, so it has to survive a reload
    // exactly: it decides how effects compound and the order handlers consume
    // randomness.
    expect(registry.active().map((relic) => relic.definition.id)).toEqual([
      'scouring-wind',
      'twin-seed',
      'frostbind',
    ]);
    expect(registry.active().map((relic) => relic.pickupOrder)).toEqual([
      0, 1, 2,
    ]);
  });

  it('carries a spent charge budget back rather than reseeding it', () => {
    const registry = new RelicRegistry({ bus: createHookBus() });
    const declared = RELIC_CATALOGUE.find(
      (relic) => relic.id === 'frostbind',
    )?.charges;

    expect(declared).toBe(8);

    registry.restore([{ id: 'frostbind', charges: 3 }]);

    // A run resumed mid-way must not have its charges refilled: the budget is
    // run state, and the declaration is only its starting value.
    expect(registry.find('frostbind')?.charges).toBe(3);
  });

  it('resolves every identifier against the catalogue and drops the rest', () => {
    const registry = new RelicRegistry({ bus: createHookBus() });

    registry.restore([
      { id: 'twin-seed' },
      { id: 'not-a-relic' },
      { id: '' },
      { id: 'echo-chamber' },
    ]);

    // The catalogue is the authority.
    expect(registry.ownedIds()).toEqual(['twin-seed', 'echo-chamber']);

    expect(registry.active().map((relic) => relic.pickupOrder)).toEqual([0, 1]);
  });

  it('keeps one entry when the envelope carried a duplicate', () => {
    const registry = new RelicRegistry({ bus: createHookBus() });

    registry.restore([
      { id: 'twin-seed', charges: 1 },
      { id: 'twin-seed', charges: 9 },
    ]);

    expect(registry.ownedIds()).toEqual(['twin-seed']);
  });

  it('binds the handlers, so a restored relic fires on the next dispatch', () => {
    const bus = createHookBus();
    const registry = new RelicRegistry({ bus });

    registry.restore([{ id: 'twin-seed' }]);

    const engine = new Engine({
      config: createDefaultRulesConfig(),
      streams: createRngStreams(RUN_SEED),
      hooks: bus,
    });

    let spawns = 0;

    engine.events.on('tile:spawn', (): void => {
      spawns += 1;
    });

    engine.setup(null);

    // Hydration is A SUBSCRIPTION, not a record: the relic is dispatched to
    // from the first dispatch of the engine that shares the bus, without being
    // picked up again.
    expect(registry.active()).toHaveLength(1);
    expect(spawns).toBeGreaterThan(0);
  });

  it('replaces the previous run rather than appending to it', () => {
    const registry = new RelicRegistry({ bus: createHookBus() });

    registry.restore([{ id: 'twin-seed' }, { id: 'frostbind' }]);
    registry.restore([{ id: 'echo-chamber' }]);

    // `restore` clears first, so a second run cannot inherit the first's
    // relics and pickup order restarts at zero.
    expect(registry.ownedIds()).toEqual(['echo-chamber']);
    expect(registry.active()[0]?.pickupOrder).toBe(0);
  });

  it('projects the normalised set back through serialize', () => {
    const registry = new RelicRegistry({ bus: createHookBus() });

    registry.restore([
      { id: 'invented' },
      { id: 'frostbind', charges: 2 },
    ]);

    expect(registry.serialize()).toEqual([
      { id: 'frostbind', charges: 2, state: { frozen: [] } },
    ]);
  });
});
