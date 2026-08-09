// Unit suite for the rules schema declared by src/config/rules-config.ts. It
// pins that schema's shape: the members each exported type declares, the type
// of every member, the call signatures of the two merge functions, and the
// structural operand type those functions read.
//
// Decisions: DL-CONFIG-01, DL-CONFIG-02 (docs/DECISION_LOG.md).

import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  MergePredicate,
  MergeProducer,
  MergeRules,
  MergeTileView,
  RulesConfig,
  SpawnDistribution,
} from '../../../src/config/rules-config';

interface VanillaTileShape {
  x: number;
  y: number;
  value: number;
  previousPosition: { x: number; y: number } | null;
  mergedFrom: VanillaTileShape[] | null;
}

type MutableMergeTileView = {
  -readonly [K in keyof MergeTileView]: MergeTileView[K];
};

type MappedRulesConfig = {
  [K in keyof RulesConfig]: RulesConfig[K];
};

type ReadonlyRulesConfig = {
  readonly [K in keyof RulesConfig]: RulesConfig[K];
};

function makeVanillaTile(
  value: number,
  mergedFrom: VanillaTileShape[] | null
): VanillaTileShape {
  return {
    x: 0,
    y: 0,
    value,
    previousPosition: null,
    mergedFrom,
  };
}

function makeSpawnDistribution(): SpawnDistribution {
  return {
    values: [2, 4, 8],
    weights: [0.7, 0.2, 0.1],
  };
}

function makeMergeRules(): MergeRules {
  const canMerge: MergePredicate = (moving, target) =>
    moving.value === target.value;

  const produce: MergeProducer = (moving, target) =>
    moving.value + target.value;

  return { canMerge, produce };
}

function makeRulesConfig(): RulesConfig {
  return {
    boardSize: 5,
    winValue: 4096,
    startTiles: 3,
    spawn: makeSpawnDistribution(),
    merge: makeMergeRules(),
  };
}

describe('rules-config schema', () => {
  describe('RulesConfig', () => {
    it('carries exactly five members', () => {
      const config = makeRulesConfig();

      expect(Object.keys(config).sort()).toEqual(
        ['boardSize', 'merge', 'spawn', 'startTiles', 'winValue'].sort()
      );

      expectTypeOf<keyof RulesConfig>().toEqualTypeOf<
        'boardSize' | 'winValue' | 'startTiles' | 'spawn' | 'merge'
      >();
    });

    it('admits no sixth member', () => {
      const config: RulesConfig = {
        boardSize: 5,
        winValue: 4096,
        startTiles: 3,
        spawn: makeSpawnDistribution(),
        merge: makeMergeRules(),
        // @ts-expect-error TS2353: RulesConfig declares no such member
        scoreMultiplier: 2,
      };

      expect(Object.keys(config)).toHaveLength(6);
      expect(Object.keys(config)).toContain('scoreMultiplier');
    });

    it('types boardSize, winValue and startTiles as number', () => {
      const config = makeRulesConfig();

      expectTypeOf<RulesConfig['boardSize']>().toBeNumber();
      expectTypeOf<RulesConfig['winValue']>().toBeNumber();
      expectTypeOf<RulesConfig['startTiles']>().toBeNumber();

      expect(typeof config.boardSize).toBe('number');
      expect(typeof config.winValue).toBe('number');
      expect(typeof config.startTiles).toBe('number');
    });

    it('types spawn and merge as the two schema sub-objects', () => {
      const config = makeRulesConfig();

      expectTypeOf<RulesConfig['spawn']>().toEqualTypeOf<SpawnDistribution>();
      expectTypeOf<RulesConfig['merge']>().toEqualTypeOf<MergeRules>();

      expect(Array.isArray(config.spawn.values)).toBe(true);
      expect(typeof config.merge.canMerge).toBe('function');
    });

    it('declares every member mutable', () => {
      const config = makeRulesConfig();
      const rewritten = config.boardSize + 1;

      expectTypeOf<RulesConfig>().toEqualTypeOf<MappedRulesConfig>();
      expectTypeOf<RulesConfig>().not.toEqualTypeOf<ReadonlyRulesConfig>();

      config.boardSize = rewritten;
      config.spawn = makeSpawnDistribution();
      config.merge = makeMergeRules();

      expect(config.boardSize).toBe(rewritten);
    });
  });

  describe('SpawnDistribution', () => {
    it('carries exactly the two members values and weights', () => {
      const members = Object.keys(makeSpawnDistribution()).sort();

      expect(members).toEqual(['values', 'weights'].sort());

      expectTypeOf<keyof SpawnDistribution>().toEqualTypeOf<
        'values' | 'weights'
      >();
    });

    it('is a pair of parallel number arrays', () => {
      const spawn = makeSpawnDistribution();
      const isNumber = (entry: unknown): boolean => typeof entry === 'number';

      expectTypeOf<SpawnDistribution>().toEqualTypeOf<{
        values: number[];
        weights: number[];
      }>();

      expect(Array.isArray(spawn.values)).toBe(true);
      expect(Array.isArray(spawn.weights)).toBe(true);
      expect(spawn.values.every(isNumber)).toBe(true);
      expect(spawn.weights.every(isNumber)).toBe(true);
    });

    it('keeps values and weights index-aligned', () => {
      const spawn = makeSpawnDistribution();

      expect(spawn.values.length).toBeGreaterThan(0);
      expect(spawn.weights).toHaveLength(spawn.values.length);
    });

    it('carries non-negative weights that sum to one', () => {
      const spawn = makeSpawnDistribution();
      const total = spawn.weights.reduce((sum, weight) => sum + weight, 0);

      expect(total).toBeCloseTo(1);
      expect(spawn.weights.every((weight) => weight >= 0)).toBe(true);
    });
  });

  describe('MergeRules', () => {
    it('carries exactly the two members canMerge and produce', () => {
      const members = Object.keys(makeMergeRules()).sort();

      expect(members).toEqual(['canMerge', 'produce'].sort());

      expectTypeOf<keyof MergeRules>().toEqualTypeOf<
        'canMerge' | 'produce'
      >();
    });

    it('types its two members as the merge function types', () => {
      const merge = makeMergeRules();

      expectTypeOf<MergeRules['canMerge']>().toEqualTypeOf<MergePredicate>();
      expectTypeOf<MergeRules['produce']>().toEqualTypeOf<MergeProducer>();

      expect(typeof merge.canMerge).toBe('function');
      expect(typeof merge.produce).toBe('function');
    });

    it('accepts any conforming predicate and producer', () => {
      const moving = makeVanillaTile(8, null);
      const target = makeVanillaTile(8, null);
      const refuse: MergePredicate = () => false;
      const fixed: MergeProducer = () => 32;
      const original = makeMergeRules();
      const replaced: MergeRules = { canMerge: refuse, produce: fixed };

      expect(original.canMerge(moving, target)).toBe(true);
      expect(replaced.canMerge(moving, target)).toBe(false);
      expect(original.produce(moving, target)).toBe(16);
      expect(replaced.produce(moving, target)).toBe(32);
    });
  });

  describe('MergePredicate', () => {
    it('takes two tile views and returns a boolean', () => {
      const merge = makeMergeRules();
      const moving = makeVanillaTile(8, null);
      const target = makeVanillaTile(8, null);

      expectTypeOf<MergePredicate>().toEqualTypeOf<
        (moving: MergeTileView, target: MergeTileView) => boolean
      >();
      expectTypeOf<MergePredicate>().parameters.toEqualTypeOf<
        [MergeTileView, MergeTileView]
      >();
      expectTypeOf<MergePredicate>().returns.toBeBoolean();
      expectTypeOf<MergePredicate>().toBeCallableWith(moving, target);

      expect(merge.canMerge(moving, target)).toBe(true);
    });
  });

  describe('MergeProducer', () => {
    it('takes two tile views and returns a number', () => {
      const merge = makeMergeRules();
      const moving = makeVanillaTile(8, null);
      const target = makeVanillaTile(8, null);

      expectTypeOf<MergeProducer>().toEqualTypeOf<
        (moving: MergeTileView, target: MergeTileView) => number
      >();
      expectTypeOf<MergeProducer>().parameters.toEqualTypeOf<
        [MergeTileView, MergeTileView]
      >();
      expectTypeOf<MergeProducer>().returns.toBeNumber();
      expectTypeOf<MergeProducer>().toBeCallableWith(moving, target);

      expect(merge.produce(moving, target)).toBe(16);
    });
  });

  describe('MergeTileView', () => {
    it('declares the minimal value and mergedFrom pair', () => {
      const view: MergeTileView = makeVanillaTile(4, null);

      expectTypeOf<MergeTileView>().toEqualTypeOf<{
        readonly value: number;
        readonly mergedFrom: readonly unknown[] | null;
      }>();
      expectTypeOf<keyof MergeTileView>().toEqualTypeOf<
        'value' | 'mergedFrom'
      >();

      expect(typeof view.value).toBe('number');
      expect(view.mergedFrom).toBeNull();
    });

    it('declares both of its members readonly', () => {
      const view: MergeTileView = makeVanillaTile(4, null);

      expectTypeOf<MergeTileView>().not.toEqualTypeOf<MutableMergeTileView>();
      expectTypeOf<MutableMergeTileView>().toExtend<MergeTileView>();

      expect(view.value).toBe(4);
    });

    it('is satisfied structurally by a vanilla tile', () => {
      const vanillaTile = makeVanillaTile(16, null);
      const view: MergeTileView = vanillaTile;

      expectTypeOf(vanillaTile).toExtend<MergeTileView>();
      expect(Object.keys(vanillaTile).sort()).toEqual(
        ['mergedFrom', 'previousPosition', 'value', 'x', 'y'].sort()
      );
      expect(view.value).toBe(vanillaTile.value);
      expect(view.mergedFrom).toBe(vanillaTile.mergedFrom);
    });

    it('admits mergedFrom null on construction', () => {
      const view: MergeTileView = makeVanillaTile(2, null);

      expectTypeOf<MergeTileView['mergedFrom']>().toEqualTypeOf<
        readonly unknown[] | null
      >();

      expect(view.mergedFrom).toBeNull();
    });

    it('admits a populated mergedFrom pair after a merge', () => {
      const moving = makeVanillaTile(4, null);
      const target = makeVanillaTile(4, null);
      const view: MergeTileView = makeVanillaTile(8, [moving, target]);
      const pair = view.mergedFrom ?? [];

      expect(pair).toHaveLength(2);
      expect(pair[0]).toBe(moving);
      expect(pair[1]).toBe(target);
    });
  });

  describe('schema purity', () => {
    it('needs nothing beyond plain objects and functions', () => {
      const config = makeRulesConfig();

      expect(Object.getPrototypeOf(config)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(config.spawn)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(config.merge)).toBe(Object.prototype);
      expect(typeof config.boardSize).toBe('number');
      expect(Array.isArray(config.spawn.values)).toBe(true);
      expect(typeof config.merge.canMerge).toBe('function');
    });

    it('yields an independent object graph per construction', () => {
      const first = makeRulesConfig();
      const second = makeRulesConfig();

      expect(first).not.toBe(second);
      expect(first.spawn).not.toBe(second.spawn);
      expect(first.merge).not.toBe(second.merge);
      expect(first.spawn.values).not.toBe(second.spawn.values);

      first.spawn.values.push(16);
      first.boardSize += 1;

      expect(second.spawn.values).not.toContain(16);
      expect(second.boardSize).not.toBe(first.boardSize);
    });
  });
});
