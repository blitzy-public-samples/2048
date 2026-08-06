/**
 * Stage goal definitions and the stage progression curve.
 *
 * Serialisation contract: `StageGoal` and `StageConfig` are plain JSON data —
 * string and number members only, no functions, class instances or `undefined`
 * members — so a goal is persisted verbatim as the run-state envelope's
 * `stageGoal` field. A value whose numbers are all finite round-trips through
 * `JSON.parse(JSON.stringify(value))` deep-equal; the structural types also
 * admit `NaN` and `Infinity`, which JSON does not preserve, so a caller that
 * builds a config by hand keeps its numbers finite. Every value the factories
 * below produce satisfies that.
 *
 * Type declarations, frozen constants and pure functions only: this module
 * imports nothing, reads no DOM, consumes no randomness and performs no I/O.
 */

/* ===== 1. Stage goals, the persisted data ===== */

/**
 * The measurable quantities a stage goal can target: `'highest-tile'` measures
 * the highest tile value on the board, `'score-threshold'` the run score. These
 * exact strings are what a persisted `StageGoal.kind` holds.
 */
export type StageGoalKind = 'highest-tile' | 'score-threshold';

/**
 * A stage cleared once the highest tile value on the board reaches `target`.
 */
interface HighestTileStageGoal {
  readonly kind: 'highest-tile';
  readonly target: number;
}

/** A stage cleared once the run score reaches `target`. */
interface ScoreThresholdStageGoal {
  readonly kind: 'score-threshold';
  readonly target: number;
}

/**
 * One stage's clear condition. A discriminated union over `kind`, so
 * `switch (goal.kind)` narrows to one member and a kind added later raises a
 * compile error at every exhaustive consumer. Persisted verbatim as the
 * run-state envelope's `stageGoal` field and carried verbatim as the `goal`
 * member of the `stage:start` payload.
 */
export type StageGoal = HighestTileStageGoal | ScoreThresholdStageGoal;

/* ===== 2. Progress evaluation types ===== */

/** The engine facts a stage goal is evaluated against. */
export interface StageProgressInput {
  /** The run score. */
  readonly score: number;
  /**
   * The highest tile value present on the board, and 0 for a board holding no
   * tiles.
   */
  readonly highestTileValue: number;
}

/** The result of evaluating one stage goal against one board state. */
export interface StageGoalProgress {
  /**
   * The measured quantity: the highest tile value for a `'highest-tile'` goal,
   * the run score for a `'score-threshold'` goal. A HUD renders it against
   * `StageGoal.target` without re-deriving either number.
   */
  readonly achieved: number;
  /**
   * `achieved / target`, clamped to the closed interval [0, 1] and always
   * finite. Persisted as the run-state envelope's `goalProgress` field; its unit
   * is a fraction of the target, not a count and not a percentage.
   */
  readonly progress: number;
  /**
   * Whether the goal is met, computed as `achieved >= target` from the two
   * quantities directly and never from `progress`.
   */
  readonly cleared: boolean;
}

/* ===== 3. Guards and construction ===== */

/**
 * Hard ceiling applied to every derived stage target, in tile-value or score
 * units. `Number.MAX_SAFE_INTEGER`.
 */
const ABSOLUTE_TARGET_CEILING = Number.MAX_SAFE_INTEGER;

/**
 * Rejects an argument that is not a finite number.
 *
 * @param name the argument name quoted in the message.
 * @param value the argument to check.
 * @throws RangeError when `value` is `NaN`, `Infinity` or `-Infinity`.
 */
function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(
      `stage-config: ${name} must be a finite number, received ` +
        `${String(value)}`,
    );
  }
}

/**
 * Rejects a stage index outside the domain of `stageGoalForIndex()`.
 *
 * @param stageIndex the zero-based index to check.
 * @throws RangeError when `stageIndex` is not a non-negative integer.
 */
function assertStageIndex(stageIndex: number): void {
  if (!Number.isInteger(stageIndex) || stageIndex < 0) {
    throw new RangeError(
      `stage-config: stageIndex must be a non-negative integer, ` +
        `received ${String(stageIndex)}`,
    );
  }
}

/**
 * Maps a number into the closed interval [0, 1]: 0 for `NaN`, `-Infinity` and
 * anything at or below 0, 1 for `Infinity` and anything at or above 1, the
 * value itself otherwise. The result is always finite.
 */
function clampUnitInterval(value: number): number {
  if (!(value > 0)) {
    return 0;
  }
  if (!(value < 1)) {
    return 1;
  }
  return value;
}

/**
 * Bounds a computed target to a finite, non-negative integer.
 *
 * @param raw the computed, possibly non-finite target.
 * @param maxTarget the configured upper bound, itself clamped into
 *   [0, `ABSOLUTE_TARGET_CEILING`]; a non-finite bound resolves to the ceiling.
 * @returns a finite integer in [0, min(`maxTarget`, `ABSOLUTE_TARGET_CEILING`)].
 */
function boundedTarget(raw: number, maxTarget: number): number {
  const ceiling = Number.isFinite(maxTarget)
    ? Math.min(Math.max(0, maxTarget), ABSOLUTE_TARGET_CEILING)
    : ABSOLUTE_TARGET_CEILING;
  const bounded = Number.isFinite(raw) ? Math.min(raw, ceiling) : ceiling;
  return Math.round(Math.max(0, bounded));
}

/**
 * Builds a `StageGoal` from a kind and a target — the single construction site
 * in this module. The returned object is freshly allocated, unfrozen and plain.
 *
 * @param kind the quantity the goal measures.
 * @param target the value that quantity must reach; carried through unchanged.
 * @returns a new stage goal.
 * @throws RangeError when `kind` is outside `StageGoalKind`.
 */
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

/* ===== 4. Goal evaluation ===== */

/**
 * Evaluates one stage goal against one board state, at the `onAfterMove` hook
 * to track progress and at `onStageEnd` to resolve whether the stage cleared.
 * Pure: identical arguments always produce a deep-equal result.
 *
 * In the returned value, `achieved` is the measured quantity for the goal's
 * kind, `cleared` is `achieved >= goal.target`, and `progress` is finite within
 * [0, 1] — a target of 0 or below yields 1 when cleared and 0 otherwise.
 *
 * @param goal the stage's clear condition.
 * @param input the measured engine facts.
 * @returns the measured quantity, the clamped fraction of the target reached,
 *   and whether the goal is met.
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

/* ===== 5. The progression curve ===== */

/** The parameters that extend a ladder past its last explicit entry. */
interface StageLadderExtension {
  /** The kind every extended stage goal carries. */
  readonly kind: StageGoalKind;
  /** The target of the first extended stage. */
  readonly baseTarget: number;
  /** The factor applied once per extended stage after the first. */
  readonly growthFactor: number;
  /** The upper bound applied to every extended target. */
  readonly maxTarget: number;
}

/**
 * The stage progression curve. `ladder` holds the explicit goals for stage
 * indices 0 through `ladder.length - 1`, in stage order, and `extension`
 * supplies every index at or beyond that length, so `stageGoalForIndex()` is
 * total over every non-negative integer index, for any ladder length including
 * zero. Plain JSON data throughout, on the serialisation contract in the module
 * header.
 */
export interface StageConfig {
  readonly ladder: readonly StageGoal[];
  readonly extension: StageLadderExtension;
}

/**
 * Derives the goal for one stage. `stageIndex` is ZERO-BASED: index 0 is a run's
 * first stage, matching the run-state envelope and the `stage:start` payload.
 *
 * An index below `stageConfig.ladder.length` returns a copy of the corresponding
 * explicit ladder entry, whose `kind` is carried through unchanged and whose
 * `target` is rounded to an integer and bounded into
 * [0, `Number.MAX_SAFE_INTEGER`]. Every index at or beyond that length is
 * derived as `baseTarget * growthFactor ** (stageIndex - ladder.length)`,
 * rounded and bounded into
 * [0, min(`extension.maxTarget`, `Number.MAX_SAFE_INTEGER`)]. Both branches
 * bound their target the same way, so the returned `target` is always a finite
 * non-negative integer at every index and for every ladder — including one that
 * came back out of `JSON.parse`, where the type system no longer guarantees
 * anything about its numbers, and including a product that overflows to
 * `Infinity` or a non-finite extension parameter.
 *
 * Deterministic: consumes no randomness and reads no clock. Returns a freshly
 * allocated goal on every call, never a reference into `stageConfig`.
 *
 * @param stageIndex the zero-based stage index.
 * @param stageConfig the progression curve to read.
 * @returns the goal for that stage.
 * @throws RangeError when `stageIndex` is not a non-negative integer, or when
 *   the resolved entry carries a `kind` outside `StageGoalKind`.
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
      // Explicit entries are bounded on the same terms as derived ones:
      // a `StageConfig` can arrive from JSON, where `target` is only a
      // number, so the produced goal is normalised rather than copied.
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

/* ===== 6. Default curve ===== */

/** The kind carried by every explicit entry of the default ladder. */
const DEFAULT_LADDER_KIND: StageGoalKind = 'highest-tile';

/**
 * The targets of the default ladder, in stage order: eight strictly increasing
 * values of the tile ladder, ending at 2048. Decision DL-STAGE-01.
 */
const DEFAULT_LADDER_TARGETS: readonly number[] = Object.freeze([
  16, 32, 64, 128, 256, 512, 1024, 2048,
]);

/** The kind carried by every extended stage of the default curve. */
const DEFAULT_EXTENSION_KIND: StageGoalKind = 'highest-tile';

const DEFAULT_EXTENSION_BASE_TARGET = 4096; // Decision DL-STAGE-02.

/**
 * The target of the default curve's first extended stage: the tile ladder's next
 * value above 2048.
 */
const DEFAULT_EXTENSION_GROWTH_FACTOR = 2; // Decision DL-STAGE-02.

/** The growth applied per extended stage: one further step of the tile ladder. */
const DEFAULT_EXTENSION_MAX_TARGET = 2 ** 52; // Decision DL-STAGE-02.

/**
 * The upper bound on a default extended target: 2^52, the largest power of two
 * below `Number.MAX_SAFE_INTEGER`.
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
 * Freezes a curve at every level: the object, its `ladder`, each ladder entry
 * and its `extension`.
 *
 * @param config the curve to freeze in place.
 * @returns the same object, frozen.
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

/**
 * Builds the default progression curve, freshly allocated and unfrozen on every
 * call, sharing no object with `DEFAULT_STAGE_CONFIG` or an earlier return.
 *
 * @returns a new default curve.
 */
export const DEFAULT_STAGE_CONFIG: StageConfig = deepFreezeStageConfig(
  /* @__PURE__ */ createDefaultStageConfig(),
);
