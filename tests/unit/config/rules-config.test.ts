// Unit suite for the rules schema declared by src/config/rules-config.ts, the
// schema AAP Contract 4 specifies. It pins that schema's shape: the members
// each exported type declares, the type of every member, the call signatures
// of the two merge functions, and the structural operand type those functions
// read.
//
// It pins no values. The vanilla-equivalent values that populate a
// `RulesConfig`, and the behaviour of the two default merge functions, are
// pinned by tests/unit/config/default-config.test.ts, and stage goals by
// tests/unit/config/stage-config.test.ts. Neither module is imported here, and
// the values the builders in section 2 use are not the vanilla ones.
//
// The module under test declares no runtime binding, and every identifier it
// exports is imported below with `import type`. The type-level assertions are
// enforced by `npm run typecheck` — `tsc --noEmit`, whose file set covers
// tests/**/*.ts — rather than by the runner. Every test below also carries at
// least one runtime assertion.
//
// Vanilla constructs this suite is the executable witness for, from the
// deleted sources:
//   js/application.js L3     the board dimension, passed as a literal
//   js/game_manager.js L7    the starting tile count
//   js/game_manager.js L71   one spawn value and its probability, collapsed
//                            into a single expression
//   js/game_manager.js L156  the merge condition, less the neighbour
//                            existence guard, which belongs to
//                            src/engine/move-resolver.ts
//   js/game_manager.js L157  the face value a merge yields
//   js/game_manager.js L158  merged.mergedFrom = [tile, next]
//   js/game_manager.js L170  the winning tile value
//   js/tile.js L7            mergedFrom initialised to null
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  MergePredicate,
  MergeProducer,
  MergeRules,
  MergeTileView,
  RulesConfig,
  SpawnDistribution,
} from '../../../src/config/rules-config';

/* ===== 1. Local shapes ===== */

/**
 * Shape of a tile as the deleted vanilla constructor built one: the two
 * members `MergeTileView` declares, plus the three it does not.
 *
 * js/tile.js L1-L8.
 */
interface VanillaTileShape {
  x: number;
  y: number;
  value: number;
  previousPosition: { x: number; y: number } | null;
  mergedFrom: VanillaTileShape[] | null;
}

/** `MergeTileView` with both of its readonly modifiers stripped. */
type MutableMergeTileView = {
  -readonly [K in keyof MergeTileView]: MergeTileView[K];
};

/** `RulesConfig` mapped member by member, modifiers preserved. */
type MappedRulesConfig = {
  [K in keyof RulesConfig]: RulesConfig[K];
};

/** `RulesConfig` with a readonly modifier added to every member. */
type ReadonlyRulesConfig = {
  readonly [K in keyof RulesConfig]: RulesConfig[K];
};

/* ===== 2. Builders ===== */

/**
 * Builds a fresh vanilla-shaped tile.
 *
 * @param value Face value.
 * @param mergedFrom Pair the tile was produced by, or `null`.
 * @returns A tile carrying every member js/tile.js gives one.
 */
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

/**
 * Builds a fresh `SpawnDistribution`: three entries, and weights that sum to
 * 1 in exact arithmetic and to 0.9999999999999999 under IEEE-754 double
 * addition.
 *
 * @returns A distribution satisfying the schema's stated invariants.
 */
function makeSpawnDistribution(): SpawnDistribution {
  return {
    values: [2, 4, 8],
    weights: [0.7, 0.2, 0.1],
  };
}

/**
 * Builds a fresh `MergeRules` from a predicate accepting equal face values and
 * a producer summing the pair's face values.
 *
 * @returns A rule pair assembled from two locally declared functions.
 */
function makeMergeRules(): MergeRules {
  const canMerge: MergePredicate = (moving, target) =>
    moving.value === target.value;

  const produce: MergeProducer = (moving, target) =>
    moving.value + target.value;

  return { canMerge, produce };
}

/**
 * Builds a fresh, minimally valid `RulesConfig`. Every call returns a new
 * object graph sharing nothing with the previous one.
 *
 * @returns A configuration carrying the schema's five members.
 */
function makeRulesConfig(): RulesConfig {
  return {
    boardSize: 5,
    winValue: 4096,
    startTiles: 3,
    spawn: makeSpawnDistribution(),
    merge: makeMergeRules(),
  };
}

/* ===== 3. Suite ===== */

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

      // js/application.js L3
      expectTypeOf<RulesConfig['boardSize']>().toBeNumber();
      // js/game_manager.js L170
      expectTypeOf<RulesConfig['winValue']>().toBeNumber();
      // js/game_manager.js L7
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
      // js/game_manager.js L71 collapses one spawn value and its probability
      // into a single expression; the schema holds them as two arrays.
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
      // js/game_manager.js L156, less the neighbour existence guard.
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
      // js/game_manager.js L157
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
      // js/tile.js L1-L8: a vanilla tile also carries x, y and
      // previousPosition, none of which this type declares.
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
      // js/tile.js L7
      const view: MergeTileView = makeVanillaTile(2, null);

      expectTypeOf<MergeTileView['mergedFrom']>().toEqualTypeOf<
        readonly unknown[] | null
      >();

      expect(view.mergedFrom).toBeNull();
    });

    it('admits a populated mergedFrom pair after a merge', () => {
      // js/game_manager.js L158  merged.mergedFrom = [tile, next]
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

