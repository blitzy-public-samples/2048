// Unit suite for src/config/stage-config.ts: the stage-goal layer. It pins the
// run-state envelope's `stageGoal` and `goalProgress` shapes, and a
// config-driven target of kind 'highest-tile' or 'score-threshold' evaluated
// after a move and resolved at stage end.
//
// Provenance of the board vocabulary the derived metrics read, from the deleted
// vanilla sources: grid serialised to `{ size, cells }`, an empty cell
// serialised as `null`, cell order x-outer and y-inner, and tile serialised to
// `{ position: { x, y }, value }`.
//
// A stage goal has NO vanilla analogue, so the goal comparison pinned below is
// the stage layer's own and not the win check's strict equality.
//
// This file imports four helpers from vitest, four values and five types from
// the module under test, and one copy helper plus two board constants from
// tests/fixtures/boards.ts. It reads no DOM and no storage, performs no I/O,
// consumes no randomness, reads no clock and writes no log.

import { describe, expect, expectTypeOf, it } from 'vitest';

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

const SWEEP_LAST_INDEX = 10;

const LAST_LADDER_INDEX = 7;

const LARGE_STAGE_INDEX = 50;

const DEFAULT_MAX_TARGET = 2 ** 52;

const GOAL_KINDS: readonly StageGoalKind[] = [
  'highest-tile',
  'score-threshold',
];

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

type FixtureBoard = ReturnType<typeof copyBoard>;

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

function isTileLadderValue(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= 2 &&
    Number.isInteger(Math.log2(value))
  );
}

function tileInput(highestTileValue: number): StageProgressInput {
  return { score: 0, highestTileValue };
}

function scoreInput(score: number): StageProgressInput {
  return { score, highestTileValue: 0 };
}

function sweepGoals(stageConfig: StageConfig): StageGoal[] {
  const goals: StageGoal[] = [];

  for (let index = 0; index <= SWEEP_LAST_INDEX; index += 1) {
    goals.push(stageGoalForIndex(index, stageConfig));
  }

  return goals;
}

const FIRST_STAGE_GOAL: StageGoal = stageGoalForIndex(0, DEFAULT_STAGE_CONFIG);

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

interface ClearedCase {
  readonly target: number;
  readonly metric: number;
  readonly cleared: boolean;
}

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

  it('answers the whole sweep identically on a second pass', () => {
    // A layer reading randomness, a clock or any other ambient source could
    // not reproduce a whole sweep, so agreement across passes is the static
    // evidence that it reads none.
    const readSweep = (): unknown =>
      Array.from({ length: SWEEP_LAST_INDEX + 1 }, (_unused, index) => {
        const goal = stageGoalForIndex(index, DEFAULT_STAGE_CONFIG);

        return [
          goal,
          evaluateStageGoal(goal, tileInput(goal.target)),
          evaluateStageGoal(goal, tileInput(0)),
          evaluateStageGoal(goal, scoreInput(goal.target)),
        ];
      });

    const first = readSweep();

    expect(readSweep()).toEqual(first);
    expect(readSweep()).toEqual(first);
    expect(
      stageGoalForIndex(LARGE_STAGE_INDEX, createDefaultStageConfig())
    ).toEqual(stageGoalForIndex(LARGE_STAGE_INDEX, DEFAULT_STAGE_CONFIG));
  });
});

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

/* ===== 11. stageGoalForIndex over a curve other than the default ===== */

// Every case above reads DEFAULT_STAGE_CONFIG, whose ladder and extension are
// `highest-tile` throughout. That leaves the kind discriminant, the
// score-threshold branch, an extension of a different kind, an empty ladder and
// the target bounds unmeasured on this function: a regression that hard-coded
// `'highest-tile'`, read the ladder kind for an extended stage, or dropped the
// bounding would pass. The curves below are built here for that reason, and
// A3 requires the goal to be config-driven rather than default-driven.

/** Ceiling src/config/stage-config.ts applies to every derived target. */
const ABSOLUTE_TARGET_CEILING = Number.MAX_SAFE_INTEGER;

/**
 * A curve of the other kind: a score-threshold ladder carrying one
 * `highest-tile` entry and one fractional target, extended by score thresholds
 * that grow by half again per stage and saturate at 20000.
 */
const SCORE_CURVE: StageConfig = {
  ladder: [
    { kind: 'score-threshold', target: 1000 },
    { kind: 'highest-tile', target: 64 },
    { kind: 'score-threshold', target: 2500.4 },
  ],
  extension: {
    kind: 'score-threshold',
    baseTarget: 5000,
    growthFactor: 1.5,
    maxTarget: 20000,
  },
};

/** The goals `SCORE_CURVE` resolves to at indices 0 through 8, in order. */
const EXPECTED_SCORE_GOALS: readonly StageGoal[] = [
  { kind: 'score-threshold', target: 1000 },
  { kind: 'highest-tile', target: 64 },
  { kind: 'score-threshold', target: 2500 },
  { kind: 'score-threshold', target: 5000 },
  { kind: 'score-threshold', target: 7500 },
  { kind: 'score-threshold', target: 11250 },
  { kind: 'score-threshold', target: 16875 },
  { kind: 'score-threshold', target: 20000 },
  { kind: 'score-threshold', target: 20000 },
];

/** A curve with no explicit ladder at all, so index 0 comes from the
 * extension. */
const LADDERLESS_CURVE: StageConfig = {
  ladder: [],
  extension: {
    kind: 'score-threshold',
    baseTarget: 300,
    growthFactor: 2,
    maxTarget: 5000,
  },
};

/** The goals `LADDERLESS_CURVE` resolves to at indices 0 through 5. */
const EXPECTED_LADDERLESS_GOALS: readonly StageGoal[] = [
  { kind: 'score-threshold', target: 300 },
  { kind: 'score-threshold', target: 600 },
  { kind: 'score-threshold', target: 1200 },
  { kind: 'score-threshold', target: 2400 },
  { kind: 'score-threshold', target: 4800 },
  { kind: 'score-threshold', target: 5000 },
];

/**
 * Builds a curve with one explicit ladder entry and an extension the caller
 * shapes, so the target bounds can be driven one parameter at a time.
 *
 * @param extension Extension parameters to apply.
 * @param ladderTarget Target of the single ladder entry. Defaults to 10.
 * @returns The curve.
 */
function buildCurve(
  extension: {
    kind: StageGoalKind;
    baseTarget: number;
    growthFactor: number;
    maxTarget: number;
  },
  ladderTarget = 10,
): StageConfig {
  return {
    ladder: [{ kind: 'highest-tile', target: ladderTarget }],
    extension,
  };
}

describe('stageGoalForIndex over a score-threshold curve', () => {
  it('resolves every index of the curve, ladder and extension alike', () => {
    for (const [index, expected] of EXPECTED_SCORE_GOALS.entries()) {
      expect(stageGoalForIndex(index, SCORE_CURVE)).toStrictEqual(expected);
    }
  });

  it('carries the kind of the ladder entry, not a fixed one', () => {
    expect(stageGoalForIndex(0, SCORE_CURVE).kind).toBe('score-threshold');
    expect(stageGoalForIndex(1, SCORE_CURVE).kind).toBe('highest-tile');
    expect(stageGoalForIndex(2, SCORE_CURVE).kind).toBe('score-threshold');
  });

  it('carries the extension kind for every index past the ladder', () => {
    for (let index = SCORE_CURVE.ladder.length; index <= 12; index += 1) {
      expect(stageGoalForIndex(index, SCORE_CURVE).kind).toBe(
        SCORE_CURVE.extension.kind,
      );
    }
  });

  it('rounds a fractional ladder target to an integer', () => {
    const goal = stageGoalForIndex(2, SCORE_CURVE);

    expect(goal.target).toBe(2500);
    expect(Number.isInteger(goal.target)).toBe(true);
  });

  it('grows the extension by its factor and then saturates', () => {
    const first = stageGoalForIndex(3, SCORE_CURVE).target;
    const second = stageGoalForIndex(4, SCORE_CURVE).target;
    const saturated = stageGoalForIndex(20, SCORE_CURVE).target;

    expect(first).toBe(SCORE_CURVE.extension.baseTarget);
    expect(second).toBe(
      Math.round(first * SCORE_CURVE.extension.growthFactor),
    );
    expect(saturated).toBe(SCORE_CURVE.extension.maxTarget);
  });

  it('never lowers the target as the index rises', () => {
    let previous = 0;

    for (let index = 0; index <= 20; index += 1) {
      const goal = stageGoalForIndex(index, SCORE_CURVE);

      if (goal.kind === 'score-threshold') {
        expect(goal.target).toBeGreaterThanOrEqual(previous);
        previous = goal.target;
      }
    }
  });

  it('reads the curve it is handed and leaves it unchanged', () => {
    const before = JSON.stringify(SCORE_CURVE);

    for (let index = 0; index <= 12; index += 1) {
      stageGoalForIndex(index, SCORE_CURVE);
    }

    expect(JSON.stringify(SCORE_CURVE)).toBe(before);
  });

  it('returns a fresh goal rather than a ladder entry of the curve', () => {
    const goal = stageGoalForIndex(0, SCORE_CURVE);

    expect(goal).not.toBe(SCORE_CURVE.ladder[0]);
    expect(goal).toStrictEqual(SCORE_CURVE.ladder[0]);
  });
});

describe('stageGoalForIndex over a curve with no ladder', () => {
  it('resolves index 0 from the extension base target', () => {
    expect(stageGoalForIndex(0, LADDERLESS_CURVE)).toStrictEqual(
      EXPECTED_LADDERLESS_GOALS[0],
    );
  });

  it('resolves every index of the ladderless curve', () => {
    for (const [index, expected] of EXPECTED_LADDERLESS_GOALS.entries()) {
      expect(stageGoalForIndex(index, LADDERLESS_CURVE)).toStrictEqual(
        expected,
      );
    }
  });

  it('rejects a negative or fractional index on this curve too', () => {
    expect(() => stageGoalForIndex(-1, LADDERLESS_CURVE)).toThrow(RangeError);
    expect(() => stageGoalForIndex(1.5, LADDERLESS_CURVE)).toThrow(RangeError);
    expect(() => stageGoalForIndex(Number.NaN, LADDERLESS_CURVE)).toThrow(
      RangeError,
    );
  });
});

describe('stageGoalForIndex bounds every target it derives', () => {
  it('yields 0 for a maximum target of 0', () => {
    const curve = buildCurve({
      kind: 'score-threshold',
      baseTarget: 500,
      growthFactor: 2,
      maxTarget: 0,
    });

    expect(stageGoalForIndex(1, curve).target).toBe(0);
    expect(stageGoalForIndex(9, curve).target).toBe(0);
  });

  it('yields 0 for a negative maximum target', () => {
    const curve = buildCurve({
      kind: 'score-threshold',
      baseTarget: 500,
      growthFactor: 2,
      maxTarget: -1000,
    });

    expect(stageGoalForIndex(1, curve).target).toBe(0);
  });

  it('falls back to the absolute ceiling for a non-finite maximum', () => {
    for (const maxTarget of [
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NaN,
    ]) {
      const curve = buildCurve({
        kind: 'score-threshold',
        baseTarget: 2 ** 60,
        growthFactor: 1,
        maxTarget,
      });

      expect(stageGoalForIndex(1, curve).target).toBe(
        ABSOLUTE_TARGET_CEILING,
      );
    }
  });

  it('saturates a product that overflows to Infinity', () => {
    const curve = buildCurve({
      kind: 'score-threshold',
      baseTarget: Number.MAX_VALUE,
      growthFactor: 10,
      maxTarget: 1_000_000,
    });

    expect(stageGoalForIndex(2, curve).target).toBe(1_000_000);
  });

  it('caps the absolute ceiling even when the maximum exceeds it', () => {
    const curve = buildCurve({
      kind: 'score-threshold',
      baseTarget: Number.MAX_SAFE_INTEGER,
      growthFactor: 4,
      maxTarget: Number.MAX_VALUE,
    });

    expect(stageGoalForIndex(3, curve).target).toBe(ABSOLUTE_TARGET_CEILING);
  });

  it('yields 0 for a non-finite growth factor at the base stage', () => {
    const curve = buildCurve({
      kind: 'score-threshold',
      baseTarget: 500,
      growthFactor: Number.NaN,
      maxTarget: 2000,
    });

    // At the first extended stage the exponent is 0, so NaN ** 0 is 1 and the
    // base target survives; at every later stage the product is NaN and the
    // bound resolves to the configured maximum.
    expect(stageGoalForIndex(1, curve).target).toBe(500);
    expect(stageGoalForIndex(2, curve).target).toBe(2000);
  });

  it('bounds a ladder target above the absolute ceiling', () => {
    const curve: StageConfig = {
      ladder: [{ kind: 'highest-tile', target: Number.MAX_VALUE }],
      extension: {
        kind: 'highest-tile',
        baseTarget: 4,
        growthFactor: 2,
        maxTarget: 8,
      },
    };

    expect(stageGoalForIndex(0, curve).target).toBe(ABSOLUTE_TARGET_CEILING);
  });

  it('raises a negative ladder target to 0', () => {
    const curve: StageConfig = {
      ladder: [
        { kind: 'score-threshold', target: -50 },
        { kind: 'score-threshold', target: -0.4 },
      ],
      extension: {
        kind: 'score-threshold',
        baseTarget: 100,
        growthFactor: 2,
        maxTarget: 400,
      },
    };

    expect(stageGoalForIndex(0, curve).target).toBe(0);
    expect(stageGoalForIndex(1, curve).target).toBe(0);
  });

  it('bounds a non-finite ladder target to the absolute ceiling', () => {
    const curve: StageConfig = {
      ladder: [{ kind: 'score-threshold', target: Number.NaN }],
      extension: {
        kind: 'score-threshold',
        baseTarget: 100,
        growthFactor: 2,
        maxTarget: 400,
      },
    };

    expect(stageGoalForIndex(0, curve).target).toBe(ABSOLUTE_TARGET_CEILING);
  });

  it('produces a finite non-negative integer at every index of every curve',
    () => {
      const curves: readonly StageConfig[] = [
        SCORE_CURVE,
        LADDERLESS_CURVE,
        buildCurve({
          kind: 'score-threshold',
          baseTarget: Number.MAX_VALUE,
          growthFactor: 3,
          maxTarget: Number.POSITIVE_INFINITY,
        }),
      ];

      for (const curve of curves) {
        for (let index = 0; index <= 15; index += 1) {
          const target = stageGoalForIndex(index, curve).target;

          expect(Number.isSafeInteger(target)).toBe(true);
          expect(target).toBeGreaterThanOrEqual(0);
          expect(target).toBeLessThanOrEqual(ABSOLUTE_TARGET_CEILING);
        }
      }
    });
});

describe('a custom curve drives evaluateStageGoal through its own kind', () => {
  it('measures the score for a score-threshold stage of the curve', () => {
    const goal = stageGoalForIndex(0, SCORE_CURVE);
    const progress = evaluateStageGoal(goal, {
      score: 1000,
      highestTileValue: 2,
    });

    expect(goal.kind).toBe('score-threshold');
    expect(progress.achieved).toBe(1000);
    expect(progress.cleared).toBe(true);
    expect(progress.progress).toBe(1);
  });

  it('measures the highest tile for the curve’s highest-tile stage', () => {
    const goal = stageGoalForIndex(1, SCORE_CURVE);
    const progress = evaluateStageGoal(goal, {
      score: 99_999,
      highestTileValue: 32,
    });

    expect(goal.kind).toBe('highest-tile');
    expect(progress.achieved).toBe(32);
    expect(progress.cleared).toBe(false);
    expect(progress.progress).toBe(0.5);
  });

  it('clears a saturated extension stage only at its bounded target', () => {
    const goal = stageGoalForIndex(20, SCORE_CURVE);

    expect(goal.target).toBe(SCORE_CURVE.extension.maxTarget);
    expect(
      evaluateStageGoal(goal, {
        score: goal.target - 1,
        highestTileValue: 0,
      }).cleared,
    ).toBe(false);
    expect(
      evaluateStageGoal(goal, { score: goal.target, highestTileValue: 0 })
        .cleared,
    ).toBe(true);
  });
});
