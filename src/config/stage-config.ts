/**
 * Stage goal definitions and the stage progression curve.
 *
 * Type declarations, frozen constants and pure functions only: this module
 * imports nothing, reads no DOM, consumes no randomness and performs no I/O.
 *
 * traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of this
 * module's area enumerated:
 *   TR-STAGE-01  `StageGoalKind`, `StageGoal` and the two goal variants
 *   TR-STAGE-02  `evaluateStageGoal` and `StageGoalProgress`
 *   TR-STAGE-03  `StageConfig` and `stageGoalForIndex`
 *   TR-STAGE-04  `createDefaultStageConfig` and `DEFAULT_STAGE_CONFIG`
 *   TR-STAGE-05  `STAGE_GOAL_KINDS` and `isStageGoalKind`
 *   TR-STAGE-06  `MAX_STAGE_INDEX` and `isStageIndex`, the stage-index domain
 *                this module publishes
 *
 * Decisions: DL-STAGE-01, DL-STAGE-02, DL-STAGE-03, DL-STAGE-04, DL-STAGE-05
 * (docs/DECISION_LOG.md).
 */

/**
 * The measurable quantities a stage goal can target: `'highest-tile'` measures
 * the highest tile value on the board, `'score-threshold'` the run score.
 */
export type StageGoalKind = 'highest-tile' | 'score-threshold';

interface HighestTileStageGoal {
  readonly kind: 'highest-tile';
  readonly target: number;
}

interface ScoreThresholdStageGoal {
  readonly kind: 'score-threshold';
  readonly target: number;
}

/**
 * One stage's clear condition. A discriminated union over `kind`, so `switch
 * (goal.kind)` narrows to one member and a kind added later raises a compile
 * error at every exhaustive consumer.
 */
export type StageGoal = HighestTileStageGoal | ScoreThresholdStageGoal;

/**
 * ADDED: every `StageGoalKind`, as data. `StageGoalKind` is erased at compile
 * time, so a validator handed a goal at runtime — src/engine/hook-bus.ts weighs
 * the goal an `onStageStart` handler returns — had no list to measure `kind`
 * against and admitted any string. Declared here beside the type, and
 * `satisfies` keeps the two in step: a kind added to the union without being
 * added here fails to compile. DL-STAGE-04.
 */
export const STAGE_GOAL_KINDS = Object.freeze([
  'highest-tile',
  'score-threshold',
] as const) satisfies readonly StageGoalKind[];

/**
 * ADDED: reports whether `value` is one of the declared goal kinds.
 * DL-STAGE-04.
 *
 * @param value Candidate kind.
 * @returns `true` for exactly the members of `STAGE_GOAL_KINDS`.
 */
export function isStageGoalKind(value: unknown): value is StageGoalKind {
  return (
    typeof value === 'string' &&
    (STAGE_GOAL_KINDS as readonly string[]).includes(value)
  );
}

export interface StageProgressInput {
  readonly score: number;
  /**
   * The highest tile value present on the board, and 0 for a board holding no
   * tiles.
   */
  readonly highestTileValue: number;
}

export interface StageGoalProgress {
  /**
   * The measured quantity: the highest tile value for a `'highest-tile'` goal,
   * the run score for a `'score-threshold'` goal, so a consumer renders it
   * against `StageGoal.target` without re-deriving either number.
   */
  readonly achieved: number;
  /**
   * `achieved / target`, clamped to the closed interval [0, 1] and always
   * finite. Persisted as the run-state envelope's `goalProgress` field; its
   * unit is a fraction of the target, not a count and not a percentage.
   */
  readonly progress: number;
  /**
   * Whether the goal is met, computed as `achieved >= target` from the two
   * quantities directly and never from `progress`.
   */
  readonly cleared: boolean;
}

/**
 * Hard ceiling applied to every derived stage target, in tile-value or score
 * units.
 */
const ABSOLUTE_TARGET_CEILING = Number.MAX_SAFE_INTEGER;

/**
 * ADDED: the highest stage index this module derives a goal for, and therefore
 * the highest index a run may occupy.
 *
 * THE ONE AUTHORITATIVE STAGE DOMAIN. The domain was declared twice and the two
 * declarations disagreed: this module admitted every non-negative integer while
 * src/run/run-state.ts refused a persisted `stageIndex` above a fixed 1024, so a
 * run that advanced past 1024 produced an envelope its own store rejected and
 * the reward transaction that produced it rolled back. `MAX_PERSISTED_STAGE_INDEX`
 * of src/run/run-state.ts is now this number, and `RunController.advanceStage()`
 * of src/run/run-controller.ts refuses to leave it, on the pattern
 * `MAX_SUPPORTED_BOARD_SIZE` already follows for the board edge length.
 *
 * `Number.MAX_SAFE_INTEGER` is the bound because a stage index is reached by
 * repeated increment and is carried through `JSON.stringify`: above it neither
 * operation is exact. `stageGoalForIndex` is total over the whole domain — the
 * default curve's targets saturate at their own ceiling roughly forty stages
 * past the ladder, and every index beyond that resolves to the saturated goal.
 *
 * DL-STAGE-05, DL-RUN-07.
 */
export const MAX_STAGE_INDEX = Number.MAX_SAFE_INTEGER;

/**
 * Whether `value` is a stage index: a non-negative safe integer no greater than
 * `MAX_STAGE_INDEX`.
 *
 * Total and non-throwing for every input, so the persistence guards of
 * src/run/run-state.ts can delegate to it without their own no-throw guarantee
 * resting on anything else.
 *
 * @param value Value to test.
 * @returns `true` when `value` is a stage index this build accepts.
 */
export function isStageIndex(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_STAGE_INDEX
  );
}

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(
      `stage-config: ${name} must be a finite number, received ` +
        `${String(value)}`,
    );
  }
}

// CHANGED: the check is `isStageIndex`, which reads the published domain, where
// it was `Number.isInteger(stageIndex) && stageIndex >= 0` — a test that
// admitted an index above `MAX_STAGE_INDEX` that no increment reaches and no
// envelope carries. DL-STAGE-05.
function assertStageIndex(stageIndex: number): void {
  if (!isStageIndex(stageIndex)) {
    throw new RangeError(
      `stage-config: stageIndex must be a non-negative integer no greater ` +
        `than ${String(MAX_STAGE_INDEX)}, received ${String(stageIndex)}`,
    );
  }
}

function clampUnitInterval(value: number): number {
  if (!(value > 0)) {
    return 0;
  }
  if (!(value < 1)) {
    return 1;
  }
  return value;
}

function boundedTarget(raw: number, maxTarget: number): number {
  const ceiling = Number.isFinite(maxTarget)
    ? Math.min(Math.max(0, maxTarget), ABSOLUTE_TARGET_CEILING)
    : ABSOLUTE_TARGET_CEILING;
  const bounded = Number.isFinite(raw) ? Math.min(raw, ceiling) : ceiling;
  return Math.round(Math.max(0, bounded));
}

function createStageGoal(kind: StageGoalKind, target: number): StageGoal {
  switch (kind) {
    case 'highest-tile':
      return { kind: 'highest-tile', target };
    case 'score-threshold':
      return { kind: 'score-threshold', target };
    default: {
      const unhandledKind: never = kind;
      throw new RangeError(
        `stage-config: unknown stage goal kind ` +
          `${JSON.stringify(unhandledKind)}`,
      );
    }
  }
}

/**
 * Evaluates one stage goal against one board state. Pure: identical arguments
 * always produce a deep-equal result.
 *
 * @throws RangeError when `goal.target`, `input.score` or
 *   `input.highestTileValue` is not a finite number, or when `goal` carries a
 *   `kind` outside `StageGoalKind`.
 */
export function evaluateStageGoal(
  goal: StageGoal,
  input: StageProgressInput,
): StageGoalProgress {
  assertFinite('goal.target', goal.target);
  assertFinite('input.score', input.score);
  assertFinite('input.highestTileValue', input.highestTileValue);

  let achieved: number;

  switch (goal.kind) {
    case 'highest-tile':
      achieved = input.highestTileValue;
      break;
    case 'score-threshold':
      achieved = input.score;
      break;
    default: {
      const unhandledGoal: never = goal;
      throw new RangeError(
        `stage-config: unknown stage goal ` +
          `${JSON.stringify(unhandledGoal)}`,
      );
    }
  }

  const target = goal.target;
  const cleared = achieved >= target;

  let progress: number;
  if (target > 0) {
    progress = clampUnitInterval(achieved / target);
  } else {
    progress = cleared ? 1 : 0;
  }

  return { achieved, progress, cleared };
}

interface StageLadderExtension {
  readonly kind: StageGoalKind;
  readonly baseTarget: number;
  readonly growthFactor: number;
  readonly maxTarget: number;
}

/**
 * The stage progression curve. `ladder` holds the explicit goals for stage
 * indices 0 through `ladder.length - 1`, in stage order, and `extension`
 * supplies every index at or beyond that length, so `stageGoalForIndex` is
 * total over every non-negative integer index, for any ladder length including
 * zero.
 */
export interface StageConfig {
  readonly ladder: readonly StageGoal[];
  readonly extension: StageLadderExtension;
}

/**
 * Derives the goal for one stage. `stageIndex` is ZERO-BASED: index 0 is a
 * run's first stage, matching the run-state envelope and the `stage:start`
 * payload.
 *
 * Deterministic: consumes no randomness and reads no clock. Returns a freshly
 * allocated goal on every call, never a reference into `stageConfig`.
 *
 * @throws RangeError when `stageIndex` is not a stage index `isStageIndex`
 *   accepts, or when the resolved entry carries a `kind` outside
 *   `StageGoalKind`.
 */
export function stageGoalForIndex(
  stageIndex: number,
  stageConfig: StageConfig,
): StageGoal {
  assertStageIndex(stageIndex);

  const ladder = stageConfig.ladder;

  if (stageIndex < ladder.length) {
    const entry = ladder[stageIndex];
    if (entry !== undefined) {
      return createStageGoal(
        entry.kind,
        boundedTarget(entry.target, ABSOLUTE_TARGET_CEILING),
      );
    }
  }

  const extension = stageConfig.extension;
  const steps = stageIndex - ladder.length;
  const grown = extension.baseTarget * extension.growthFactor ** steps;

  return createStageGoal(
    extension.kind,
    boundedTarget(grown, extension.maxTarget),
  );
}

const DEFAULT_LADDER_KIND: StageGoalKind = 'highest-tile';

/**
 * The targets of the default ladder, in stage order: eight strictly increasing
 * values of the tile ladder, ending at 2048.
 */
const DEFAULT_LADDER_TARGETS: readonly number[] = Object.freeze([
  16, 32, 64, 128, 256, 512, 1024, 2048,
]);

const DEFAULT_EXTENSION_KIND: StageGoalKind = 'highest-tile';

/**
 * The target of the default curve's first extended stage: the tile ladder's
 * next value above 2048.
 */
const DEFAULT_EXTENSION_BASE_TARGET = 4096;

/**
 * The growth applied per extended stage: one further step of the tile ladder.
 */
const DEFAULT_EXTENSION_GROWTH_FACTOR = 2;

/**
 * The upper bound on a default extended target: 2^52, the largest power of two
 * below `Number.MAX_SAFE_INTEGER`.
 */
const DEFAULT_EXTENSION_MAX_TARGET = 2 ** 52;

/**
 * Freezes a curve at every level: the object, its `ladder`, each ladder entry
 * and its `extension`.
 */
function deepFreezeStageConfig(config: StageConfig): StageConfig {
  for (const goal of config.ladder) {
    Object.freeze(goal);
  }
  Object.freeze(config.ladder);
  Object.freeze(config.extension);
  return Object.freeze(config);
}

/**
 * Builds the default progression curve, freshly allocated and unfrozen on
 * every call, sharing no object with `DEFAULT_STAGE_CONFIG` or an earlier
 * return.
 */
export function createDefaultStageConfig(): StageConfig {
  return {
    ladder: DEFAULT_LADDER_TARGETS.map((target) =>
      createStageGoal(DEFAULT_LADDER_KIND, target),
    ),
    extension: {
      kind: DEFAULT_EXTENSION_KIND,
      baseTarget: DEFAULT_EXTENSION_BASE_TARGET,
      growthFactor: DEFAULT_EXTENSION_GROWTH_FACTOR,
      maxTarget: DEFAULT_EXTENSION_MAX_TARGET,
    },
  };
}

/** The default progression curve, frozen at every level. */
export const DEFAULT_STAGE_CONFIG: StageConfig = deepFreezeStageConfig(
  /* @__PURE__ */ createDefaultStageConfig(),
);
