// Unit suite for src/config/stage-config.ts: the stage-goal layer.
//
// What this suite pins, and where each pinned behaviour is defined:
//   run-state envelope `stageGoal`     src/config/stage-config.ts L24-L47
//   run-state envelope `goalProgress`  src/config/stage-config.ts L63-L81
//   working assumption A3, a config-driven target of kind 'highest-tile' or
//   'score-threshold' evaluated at onAfterMove and resolved at onStageEnd
//                                      src/config/stage-config.ts L180-L318
//
// Provenance of the board vocabulary section 10's derived metric reads, from
// the deleted vanilla sources:
//   js/grid.js L102-L117  grid -> { size, cells }
//   js/grid.js L109       an empty cell serialises as `null`
//   js/grid.js L58-L64    cell order is x-outer, y-inner
//   js/tile.js L19-L27    tile -> { position: { x, y }, value }
//
// The comparison pinned in section 6 is src/config/stage-config.ts L224, not
// js/game_manager.js L170's strict equality: a stage goal has no vanilla
// analogue.
//
// This file imports six helpers from vitest, four values and five types from
// the module under test, and one copy helper plus two board constants from
// tests/fixtures/boards.ts. It reads no DOM and no storage, performs no I/O,
// consumes no randomness, reads no clock and writes no log.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  createDefaultStageConfig,
  DEFAULT_STAGE_CONFIG,
  evaluateStageGoal,
  stageGoalForIndex,
} from '../../../src/config/stage-config';
import type {
  StageConfig,
  StageGoal,
  StageGoalKind,
  StageGoalProgress,
  StageProgressInput,
} from '../../../src/config/stage-config';
import {
  copyBoard,
  EMPTY_BOARD,
  NEAR_WIN_BOARD,
} from '../../fixtures/boards';

/* ===== 1. Sweep bounds, expected values and helpers ===== */

/** Highest stage index every sweep below walks, from index 0. */
const SWEEP_LAST_INDEX = 10;

/** Index of the default curve's last explicit ladder entry. */
const LAST_LADDER_INDEX = 7;

/** Stage index far beyond the default ladder, used as the large-index case. */
const LARGE_STAGE_INDEX = 50;

/** Upper bound the default curve's extended targets saturate at. */
const DEFAULT_MAX_TARGET = 2 ** 52;

/** Every member of `StageGoalKind`, for the runtime membership check. */
const GOAL_KINDS: readonly StageGoalKind[] = [
  'highest-tile',
  'score-threshold',
];

/**
 * The default curve's goals at stage indices 0 through `SWEEP_LAST_INDEX`, in
 * stage order: the eight explicit ladder entries of
 * src/config/stage-config.ts L329-L331 followed by three stages derived by
 * L310-L317 from `baseTarget` 4096 and `growthFactor` 2 at L336-L342.
 */
const EXPECTED_DEFAULT_GOALS: readonly StageGoal[] = [
  { kind: 'highest-tile', target: 16 },
  { kind: 'highest-tile', target: 32 },
  { kind: 'highest-tile', target: 64 },
  { kind: 'highest-tile', target: 128 },
  { kind: 'highest-tile', target: 256 },
  { kind: 'highest-tile', target: 512 },
  { kind: 'highest-tile', target: 1024 },
  { kind: 'highest-tile', target: 2048 },
  { kind: 'highest-tile', target: 4096 },
  { kind: 'highest-tile', target: 8192 },
  { kind: 'highest-tile', target: 16384 },
];

/** A board as tests/fixtures/boards.ts hands it out. */
type FixtureBoard = ReturnType<typeof copyBoard>;

/**
 * Highest tile value present on a board, and 0 for a board holding no tiles,
 * which is the quantity `StageProgressInput.highestTileValue` carries.
 *
 * @param board Board to scan, read as `cells[x][y]` per js/grid.js L58-L64,
 *   where an empty cell is `null` per js/grid.js L109.
 * @returns The greatest `value` among the board's tiles, or 0 if it has none.
 */
function highestTileValueOf(board: FixtureBoard): number {
  let highest = 0;

  for (const column of board.grid.cells) {
    for (const cell of column) {
      if (cell !== null && cell.value > highest) {
        highest = cell.value;
      }
    }
  }

  return highest;
}

/**
 * Whether a value is 2 raised to a positive integer power, the form every
 * tile value on a 2048 board takes.
 *
 * @param value Value to test.
 * @returns `true` for 2, 4, 8 and every further power of two.
 */
function isTileLadderValue(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= 2 &&
    Number.isInteger(Math.log2(value))
  );
}

/**
 * A progress input measuring a highest tile value, at score 0.
 *
 * @param highestTileValue Highest tile value on the board.
 * @returns The input a `'highest-tile'` goal is evaluated against.
 */
function tileInput(highestTileValue: number): StageProgressInput {
  return { score: 0, highestTileValue };
}

/**
 * A progress input measuring a run score, on a board holding no tiles.
 *
 * @param score Run score.
 * @returns The input a `'score-threshold'` goal is evaluated against.
 */
function scoreInput(score: number): StageProgressInput {
  return { score, highestTileValue: 0 };
}

/**
 * Every goal a curve yields at indices 0 through `SWEEP_LAST_INDEX`.
 *
 * @param stageConfig Progression curve to read.
 * @returns The goals, in stage order.
 */
function sweepGoals(stageConfig: StageConfig): StageGoal[] {
  const goals: StageGoal[] = [];

  for (let index = 0; index <= SWEEP_LAST_INDEX; index += 1) {
    goals.push(stageGoalForIndex(index, stageConfig));
  }

  return goals;
}

/**
 * The default curve's first stage goal, the subject of sections 5 through 7
 * and 10, each of which reads `target` from the goal itself. Section 3 pins
 * the curve that produces it.
 */
const FIRST_STAGE_GOAL: StageGoal = stageGoalForIndex(0, DEFAULT_STAGE_CONFIG);

/** Restores a spy this suite installed on a global. */
afterEach(() => {
  vi.restoreAllMocks();
});

/* ===== 2. The persisted stageGoal field ===== */

describe('StageGoal, the run-state envelope stageGoal field', () => {
  it('exposes exactly the members kind and target', () => {
    const goals = sweepGoals(DEFAULT_STAGE_CONFIG);

    expect(goals).toHaveLength(SWEEP_LAST_INDEX + 1);

    for (const goal of goals) {
      expect(Object.keys(goal).sort()).toEqual(['kind', 'target']);
    }
  });

  it('round-trips through JSON unchanged', () => {
    for (const goal of sweepGoals(DEFAULT_STAGE_CONFIG)) {
      const restored: unknown = JSON.parse(JSON.stringify(goal));

      expect(restored).toEqual(goal);
    }
  });

  it('holds no function-valued member', () => {
    for (const goal of sweepGoals(DEFAULT_STAGE_CONFIG)) {
      const members: unknown[] = Object.values(goal);

      expect(members).toHaveLength(2);

      for (const member of members) {
        expect(typeof member).not.toBe('function');
      }
    }
  });

  it('carries one of exactly two goal kinds', () => {
    expectTypeOf<StageGoal['kind']>().toEqualTypeOf<
      'highest-tile' | 'score-threshold'
    >();
    expectTypeOf<StageGoalKind>().toEqualTypeOf<
      'highest-tile' | 'score-threshold'
    >();

    expect(GOAL_KINDS).toHaveLength(2);

    for (const goal of sweepGoals(DEFAULT_STAGE_CONFIG)) {
      expect(GOAL_KINDS).toContain(goal.kind);
    }
  });

  it('carries a finite target above zero', () => {
    for (const goal of sweepGoals(DEFAULT_STAGE_CONFIG)) {
      expect(Number.isFinite(goal.target)).toBe(true);
      expect(goal.target).toBeGreaterThan(0);
    }
  });

  it('round-trips the whole default curve through JSON unchanged', () => {
    const restored: unknown = JSON.parse(
      JSON.stringify(DEFAULT_STAGE_CONFIG),
    );

    expect(restored).toEqual(DEFAULT_STAGE_CONFIG);
    expect(Object.keys(DEFAULT_STAGE_CONFIG).sort()).toEqual([
      'extension',
      'ladder',
    ]);
  });
});

/* ===== 3. The A3 progression curve ===== */

describe('stageGoalForIndex, the A3 config-driven stage target', () => {
  it('yields the default curve goals at indices 0 through 10', () => {
    for (let index = 0; index <= SWEEP_LAST_INDEX; index += 1) {
      expect(stageGoalForIndex(index, DEFAULT_STAGE_CONFIG)).toEqual(
        EXPECTED_DEFAULT_GOALS[index],
      );
    }
  });

  it('returns a deep-equal goal on repeated calls at one index', () => {
    for (let index = 0; index <= SWEEP_LAST_INDEX; index += 1) {
      const first = stageGoalForIndex(index, DEFAULT_STAGE_CONFIG);
      const second = stageGoalForIndex(index, DEFAULT_STAGE_CONFIG);

      expect(second).toEqual(first);
      expect(second).not.toBe(first);
    }
  });

  it('leaves the StageConfig it reads byte-identical', () => {
    const stageConfig = createDefaultStageConfig();
    const before = JSON.stringify(stageConfig);

    sweepGoals(stageConfig);
    stageGoalForIndex(LARGE_STAGE_INDEX, stageConfig);

    expect(JSON.stringify(stageConfig)).toBe(before);
  });

  it('never lowers the target as the stage index rises', () => {
    const goals = sweepGoals(DEFAULT_STAGE_CONFIG);
    const kinds = new Set(goals.map((goal) => goal.kind));

    expect(kinds.size).toBe(1);

    for (let index = 1; index < goals.length; index += 1) {
      const previous = goals[index - 1];
      const current = goals[index];

      expect(current.kind).toBe(previous.kind);
      expect(current.target).toBeGreaterThanOrEqual(previous.target);
    }
  });

  it('targets a tile ladder value at every swept index', () => {
    for (const goal of sweepGoals(DEFAULT_STAGE_CONFIG)) {
      expect(goal.kind).toBe('highest-tile');
      expect(isTileLadderValue(goal.target)).toBe(true);
    }
  });

  it('bounds a far stage index to the configured maximum target', () => {
    const goal = stageGoalForIndex(LARGE_STAGE_INDEX, DEFAULT_STAGE_CONFIG);

    expect(Number.isFinite(goal.target)).toBe(true);
    expect(goal.target).toBeGreaterThan(0);
    expect(goal.target).toBe(DEFAULT_MAX_TARGET);
    expect(isTileLadderValue(goal.target)).toBe(true);
    expect(goal.target).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
  });

  it('rejects an index that is not a non-negative integer', () => {
    const rejected = [-1, -0.0001, 1.5, Number.NaN, Number.POSITIVE_INFINITY];

    for (const index of rejected) {
      expect(() =>
        stageGoalForIndex(index, DEFAULT_STAGE_CONFIG),
      ).toThrow(RangeError);
    }

    expect(stageGoalForIndex(-0, DEFAULT_STAGE_CONFIG)).toEqual(
      EXPECTED_DEFAULT_GOALS[0],
    );
  });

  it('reads the frozen constant and the factory result alike', () => {
    const built = createDefaultStageConfig();

    for (let index = 0; index <= SWEEP_LAST_INDEX; index += 1) {
      expect(stageGoalForIndex(index, built)).toEqual(
        stageGoalForIndex(index, DEFAULT_STAGE_CONFIG),
      );
    }

    expect(stageGoalForIndex(LARGE_STAGE_INDEX, built)).toEqual(
      stageGoalForIndex(LARGE_STAGE_INDEX, DEFAULT_STAGE_CONFIG),
    );
  });

  it('returns a fresh goal rather than a ladder entry', () => {
    const goal = stageGoalForIndex(LAST_LADDER_INDEX, DEFAULT_STAGE_CONFIG);
    const entry = DEFAULT_STAGE_CONFIG.ladder[LAST_LADDER_INDEX];

    expect(goal).toEqual(entry);
    expect(goal).not.toBe(entry);
    expect(Object.isFrozen(goal)).toBe(false);
  });
});

/* ===== 4. The default curve, frozen and freshly built ===== */

describe('DEFAULT_STAGE_CONFIG and createDefaultStageConfig', () => {
  it('freezes the default curve at every level', () => {
    expect(Object.isFrozen(DEFAULT_STAGE_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_STAGE_CONFIG.ladder)).toBe(true);
    expect(Object.isFrozen(DEFAULT_STAGE_CONFIG.extension)).toBe(true);
    expect(DEFAULT_STAGE_CONFIG.ladder.length).toBeGreaterThan(0);

    for (const entry of DEFAULT_STAGE_CONFIG.ladder) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });

  it('throws TypeError on a write and keeps every value', () => {
    const entry = DEFAULT_STAGE_CONFIG.ladder[LAST_LADDER_INDEX];
    const targetBefore = entry.target;
    const baseTargetBefore = DEFAULT_STAGE_CONFIG.extension.baseTarget;
    const ladderLengthBefore = DEFAULT_STAGE_CONFIG.ladder.length;

    expect(() => {
      (entry as { target: number }).target = 1;
    }).toThrow(TypeError);
    expect(() => {
      (DEFAULT_STAGE_CONFIG.extension as { baseTarget: number }).baseTarget =
        1;
    }).toThrow(TypeError);
    expect(() => {
      (DEFAULT_STAGE_CONFIG.ladder as StageGoal[]).push({
        kind: 'highest-tile',
        target: 2,
      });
    }).toThrow(TypeError);

    expect(entry.target).toBe(targetBefore);
    expect(DEFAULT_STAGE_CONFIG.extension.baseTarget).toBe(baseTargetBefore);
    expect(DEFAULT_STAGE_CONFIG.ladder).toHaveLength(ladderLengthBefore);
  });

  it('returns a fresh, unfrozen curve from every call', () => {
    const first = createDefaultStageConfig();
    const second = createDefaultStageConfig();

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(Object.isFrozen(first)).toBe(false);
    expect(Object.isFrozen(first.ladder)).toBe(false);
    expect(Object.isFrozen(first.extension)).toBe(false);

    for (const entry of first.ladder) {
      expect(Object.isFrozen(entry)).toBe(false);
    }
  });

  it('shares no nested object between two results', () => {
    const first = createDefaultStageConfig();
    const second = createDefaultStageConfig();

    expect(second.ladder).not.toBe(first.ladder);
    expect(second.extension).not.toBe(first.extension);
    expect(first.ladder.length).toBeGreaterThan(0);

    for (let index = 0; index < first.ladder.length; index += 1) {
      expect(second.ladder[index]).toEqual(first.ladder[index]);
      expect(second.ladder[index]).not.toBe(first.ladder[index]);
    }
  });

  it('isolates a mutation of one result from the next call', () => {
    const mutated = createDefaultStageConfig();

    (mutated.ladder as StageGoal[]).push({
      kind: 'score-threshold',
      target: 5,
    });
    (mutated.extension as { baseTarget: number }).baseTarget = 3;

    const fresh = createDefaultStageConfig();

    expect(fresh).toEqual(DEFAULT_STAGE_CONFIG);
    expect(fresh.ladder).toHaveLength(DEFAULT_STAGE_CONFIG.ladder.length);
    expect(fresh.extension.baseTarget).toBe(
      DEFAULT_STAGE_CONFIG.extension.baseTarget,
    );
  });

  it('builds a curve deep-equal to the frozen constant', () => {
    expect(createDefaultStageConfig()).toEqual(DEFAULT_STAGE_CONFIG);
  });
});

/* ===== 5. The persisted goalProgress field ===== */

describe('evaluateStageGoal, the run-state goalProgress field', () => {
  it('returns exactly achieved, progress and cleared', () => {
    expectTypeOf<keyof StageGoalProgress>().toEqualTypeOf<
      'achieved' | 'progress' | 'cleared'
    >();
    expectTypeOf<StageGoalProgress['achieved']>().toEqualTypeOf<number>();
    expectTypeOf<StageGoalProgress['progress']>().toEqualTypeOf<number>();
    expectTypeOf<StageGoalProgress['cleared']>().toEqualTypeOf<boolean>();

    const result = evaluateStageGoal(FIRST_STAGE_GOAL, tileInput(8));

    expect(Object.keys(result).sort()).toEqual([
      'achieved',
      'cleared',
      'progress',
    ]);
    expect(typeof result.achieved).toBe('number');
    expect(Number.isFinite(result.achieved)).toBe(true);
    expect(typeof result.progress).toBe('number');
    expect(Number.isFinite(result.progress)).toBe(true);
    expect(typeof result.cleared).toBe('boolean');
  });

  it('reports the measured quantity of the goal kind as achieved', () => {
    const input: StageProgressInput = { score: 7, highestTileValue: 8 };
    const scoreGoal: StageGoal = { kind: 'score-threshold', target: 100 };

    expect(evaluateStageGoal(FIRST_STAGE_GOAL, input).achieved).toBe(8);
    expect(evaluateStageGoal(scoreGoal, input).achieved).toBe(7);
  });

  it('clamps progress into the closed interval 0 to 1', () => {
    const target = FIRST_STAGE_GOAL.target;
    const metrics = [
      -target * 100,
      -1,
      0,
      1,
      target / 4,
      target / 2,
      target - 1,
      target,
      target + 1,
      target * 2,
      target * 100,
    ];

    for (const metric of metrics) {
      const result = evaluateStageGoal(FIRST_STAGE_GOAL, tileInput(metric));

      expect(Number.isNaN(result.progress)).toBe(false);
      expect(Number.isFinite(result.progress)).toBe(true);
      expect(result.progress).toBeGreaterThanOrEqual(0);
      expect(result.progress).toBeLessThanOrEqual(1);
    }
  });

  it('clamps progress to 1 at and above the target', () => {
    const target = FIRST_STAGE_GOAL.target;
    const atTarget = evaluateStageGoal(FIRST_STAGE_GOAL, tileInput(target));
    const above = evaluateStageGoal(FIRST_STAGE_GOAL, tileInput(target + 1));
    const vast = evaluateStageGoal(
      FIRST_STAGE_GOAL,
      tileInput(target * 100),
    );

    expect(atTarget.progress).toBe(1);
    expect(above.progress).toBe(1);
    expect(vast.progress).toBe(1);
    expect(vast.achieved).toBe(target * 100);
  });

  it('clamps progress to 0 at the empty-board floor and below', () => {
    const target = FIRST_STAGE_GOAL.target;
    const floor = evaluateStageGoal(FIRST_STAGE_GOAL, tileInput(0));
    const below = evaluateStageGoal(FIRST_STAGE_GOAL, tileInput(-1));
    const farBelow = evaluateStageGoal(
      FIRST_STAGE_GOAL,
      tileInput(-target * 100),
    );

    expect(floor.progress).toBe(0);
    expect(below.progress).toBe(0);
    expect(farBelow.progress).toBe(0);
    expect(farBelow.achieved).toBe(-target * 100);
  });

  it('reports a fraction of the target between floor and target', () => {
    const target = FIRST_STAGE_GOAL.target;

    expect(
      evaluateStageGoal(FIRST_STAGE_GOAL, tileInput(target / 2)).progress,
    ).toBeCloseTo(0.5);
    expect(
      evaluateStageGoal(FIRST_STAGE_GOAL, tileInput(target / 4)).progress,
    ).toBeCloseTo(0.25);
    expect(
      evaluateStageGoal(FIRST_STAGE_GOAL, tileInput(target - 1)).progress,
    ).toBeCloseTo((target - 1) / target);
  });

  it('clamps a ratio that overflows to Infinity', () => {
    const goal: StageGoal = {
      kind: 'score-threshold',
      target: Number.MIN_VALUE,
    };
    const result = evaluateStageGoal(goal, scoreInput(1e308));

    expect(Number.isNaN(result.progress)).toBe(false);
    expect(result.progress).toBe(1);
    expect(result.cleared).toBe(true);
  });

  it('yields a finite progress for a target of zero', () => {
    const goal: StageGoal = { kind: 'score-threshold', target: 0 };

    expect(evaluateStageGoal(goal, scoreInput(0)).progress).toBe(1);
    expect(evaluateStageGoal(goal, scoreInput(5)).progress).toBe(1);
    expect(evaluateStageGoal(goal, scoreInput(-1)).progress).toBe(0);
  });
});

/* ===== 6. The A3 stage clear condition ===== */

/** One row of the `cleared` truth table of src/config/stage-config.ts L224. */
interface ClearedCase {
  readonly target: number;
  readonly metric: number;
  readonly cleared: boolean;
}

/**
 * The `cleared` truth table: a metric at the target clears the stage, a metric
 * one step below it does not. The last four rows exercise the non-positive
 * target branch of src/config/stage-config.ts L227-L231.
 */
const CLEARED_TRUTH_TABLE: readonly ClearedCase[] = [
  { target: 16, metric: 0, cleared: false },
  { target: 16, metric: 15, cleared: false },
  { target: 16, metric: 16, cleared: true },
  { target: 16, metric: 17, cleared: true },
  { target: 16, metric: 1600, cleared: true },
  { target: 16, metric: -16, cleared: false },
  { target: 0, metric: -1, cleared: false },
  { target: 0, metric: 0, cleared: true },
  { target: -10, metric: -20, cleared: false },
  { target: -10, metric: -10, cleared: true },
];

describe('evaluateStageGoal, the A3 stage clear condition', () => {
  it('clears a highest-tile goal at its target inclusively', () => {
    const target = FIRST_STAGE_GOAL.target;

    expect(
      evaluateStageGoal(FIRST_STAGE_GOAL, tileInput(target - 1)).cleared,
    ).toBe(false);
    expect(
      evaluateStageGoal(FIRST_STAGE_GOAL, tileInput(target)).cleared,
    ).toBe(true);
    expect(
      evaluateStageGoal(FIRST_STAGE_GOAL, tileInput(target + 1)).cleared,
    ).toBe(true);
  });

  it('clears a score-threshold goal at its target inclusively', () => {
    const goal: StageGoal = { kind: 'score-threshold', target: 100 };

    expect(evaluateStageGoal(goal, scoreInput(99)).cleared).toBe(false);
    expect(evaluateStageGoal(goal, scoreInput(100)).cleared).toBe(true);
    expect(evaluateStageGoal(goal, scoreInput(101)).cleared).toBe(true);
  });

  it('sets cleared exactly when achieved reaches the target', () => {
    expect(CLEARED_TRUTH_TABLE).toHaveLength(10);

    for (const row of CLEARED_TRUTH_TABLE) {
      const goal: StageGoal = {
        kind: 'score-threshold',
        target: row.target,
      };
      const result = evaluateStageGoal(goal, scoreInput(row.metric));

      expect(result.achieved).toBe(row.metric);
      expect(result.cleared).toBe(row.cleared);
      expect(result.cleared).toBe(row.metric >= row.target);
    }
  });

  it('derives cleared from the metric and not from the ratio', () => {
    const goal: StageGoal = { kind: 'score-threshold', target: -10 };
    const metric = -20;
    const result = evaluateStageGoal(goal, scoreInput(metric));

    expect(metric / goal.target).toBeGreaterThanOrEqual(1);
    expect(result.cleared).toBe(false);
    expect(result.progress).toBe(0);
  });
});

/* ===== 7. The goal kind discriminant ===== */

describe('evaluateStageGoal honours the goal kind discriminant', () => {
  it('ignores score when the goal measures the highest tile', () => {
    const baseline = evaluateStageGoal(FIRST_STAGE_GOAL, {
      score: 0,
      highestTileValue: 8,
    });

    for (const score of [-1e6, -1, 1, 15, 16, 1024, 1e6]) {
      expect(
        evaluateStageGoal(FIRST_STAGE_GOAL, { score, highestTileValue: 8 }),
      ).toEqual(baseline);
    }

    expect(baseline.achieved).toBe(8);
  });

  it('ignores the highest tile value when the goal measures score', () => {
    const goal: StageGoal = { kind: 'score-threshold', target: 100 };
    const baseline = evaluateStageGoal(goal, {
      score: 50,
      highestTileValue: 0,
    });

    for (const highestTileValue of [0, 2, 64, 2048, 1e6]) {
      expect(
        evaluateStageGoal(goal, { score: 50, highestTileValue }),
      ).toEqual(baseline);
    }

    expect(baseline.achieved).toBe(50);
  });
});

/* ===== 8. Purity and the absence of randomness ===== */

describe('the stage-goal layer is pure and consumes no randomness', () => {
  it('mutates neither the goal nor the input', () => {
    const goal: StageGoal = { kind: 'highest-tile', target: 128 };
    const input: StageProgressInput = { score: 40, highestTileValue: 64 };
    const goalBefore = JSON.stringify(goal);
    const inputBefore = JSON.stringify(input);

    const result = evaluateStageGoal(goal, input);

    expect(result.achieved).toBe(64);
    expect(JSON.stringify(goal)).toBe(goalBefore);
    expect(JSON.stringify(input)).toBe(inputBefore);
  });

  it('returns a deep-equal result on repeated calls', () => {
    const goal: StageGoal = { kind: 'highest-tile', target: 128 };
    const input: StageProgressInput = { score: 40, highestTileValue: 64 };
    const first = evaluateStageGoal(goal, input);
    const second = evaluateStageGoal(goal, input);

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it('never calls Math.random', () => {
    const randomSpy = vi.spyOn(Math, 'random');

    for (let index = 0; index <= SWEEP_LAST_INDEX; index += 1) {
      const goal = stageGoalForIndex(index, DEFAULT_STAGE_CONFIG);

      evaluateStageGoal(goal, tileInput(goal.target));
      evaluateStageGoal(goal, tileInput(0));
      evaluateStageGoal(goal, scoreInput(goal.target));
    }

    stageGoalForIndex(LARGE_STAGE_INDEX, createDefaultStageConfig());

    expect(randomSpy).not.toHaveBeenCalled();
    expect(randomSpy).toHaveBeenCalledTimes(0);
  });
});

/* ===== 9. Non-finite argument guards ===== */

describe('evaluateStageGoal rejects a non-finite quantity', () => {
  it('rejects a non-finite target', () => {
    const nonFinite = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];

    for (const target of nonFinite) {
      const goal: StageGoal = { kind: 'highest-tile', target };

      expect(() => evaluateStageGoal(goal, tileInput(8))).toThrow(RangeError);
    }
  });

  it('rejects a non-finite score or highest tile value', () => {
    const nonFinite = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];

    for (const value of nonFinite) {
      expect(() =>
        evaluateStageGoal(FIRST_STAGE_GOAL, scoreInput(value)),
      ).toThrow(RangeError);
      expect(() =>
        evaluateStageGoal(FIRST_STAGE_GOAL, tileInput(value)),
      ).toThrow(RangeError);
    }
  });
});

/* ===== 10. The fixture-derived highest tile metric ===== */

describe('the fixture-derived highestTileValue', () => {
  it('reads 0 from the empty board and a tile value from near-win', () => {
    const empty = highestTileValueOf(copyBoard(EMPTY_BOARD));
    const nearWin = highestTileValueOf(copyBoard(NEAR_WIN_BOARD));

    expect(empty).toBe(0);
    expect(nearWin).toBeGreaterThan(0);
    expect(isTileLadderValue(nearWin)).toBe(true);
    expect(nearWin).toBeGreaterThan(empty);
  });

  it('evaluates the first stage goal at the empty-board floor', () => {
    const metric = highestTileValueOf(copyBoard(EMPTY_BOARD));
    const result = evaluateStageGoal(FIRST_STAGE_GOAL, tileInput(metric));

    expect(metric).toBe(0);
    expect(result.achieved).toBe(0);
    expect(result.progress).toBe(0);
    expect(result.cleared).toBe(false);
  });

  it('evaluates every ladder stage against the near-win board', () => {
    const metric = highestTileValueOf(copyBoard(NEAR_WIN_BOARD));

    expect(isTileLadderValue(metric)).toBe(true);

    for (let index = 0; index <= LAST_LADDER_INDEX; index += 1) {
      const goal = stageGoalForIndex(index, DEFAULT_STAGE_CONFIG);
      const result = evaluateStageGoal(goal, tileInput(metric));

      expect(result.achieved).toBe(metric);
      expect(result.cleared).toBe(metric >= goal.target);
      expect(result.progress).toBeCloseTo(Math.min(1, metric / goal.target));
    }

    expect(
      evaluateStageGoal(FIRST_STAGE_GOAL, tileInput(metric)).cleared,
    ).toBe(true);
  });

  it('reports half progress against a goal at twice the metric', () => {
    const metric = highestTileValueOf(copyBoard(NEAR_WIN_BOARD));
    const goal: StageGoal = { kind: 'highest-tile', target: metric * 2 };
    const result = evaluateStageGoal(goal, tileInput(metric));

    expect(result.achieved).toBe(metric);
    expect(result.progress).toBeCloseTo(0.5);
    expect(result.cleared).toBe(false);
  });

  it('leaves the shared frozen fixture untouched', () => {
    const before = JSON.stringify(NEAR_WIN_BOARD);

    expect(highestTileValueOf(copyBoard(NEAR_WIN_BOARD))).toBeGreaterThan(0);
    expect(JSON.stringify(NEAR_WIN_BOARD)).toBe(before);
    expect(Object.isFrozen(NEAR_WIN_BOARD)).toBe(true);
  });
});

