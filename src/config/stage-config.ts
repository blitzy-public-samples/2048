/**
 * Stage goal definitions and the stage progression curve.
 *
 * PROVENANCE
 *   This module has no vanilla analogue. Neither js/game_manager.js
 *   nor js/grid.js declares a stage, a goal or a progression, so no
 *   target value here is ported from either file. Two vanilla facts
 *   the goal kinds measure against are cited at their point of use:
 *   the score delta `self.score += merged.value;` at
 *   js/game_manager.js L167, and the eleven-value tile ladder the
 *   stylesheet generates from `$base: 2`, `$exponent: 1`,
 *   `$limit: 11` at style/main.scss L334-L336, whose top value is
 *   2048 and above which js/html_actuator.js L60 applies the
 *   `tile-super` band.
 *
 * SERIALISATION CONTRACT
 *   `StageGoal` and `StageConfig` are plain JSON data: string and
 *   number members only. No functions, no methods, no getters, no
 *   class instances, no `Symbol`, no `Map`, no `Set`, and no member
 *   whose value is `undefined`. Every `StageGoal` variant, and every
 *   `StageConfig`, is deep-equal to its own
 *   `JSON.parse(JSON.stringify(value))` round trip.
 *   src/run/run-state-store.ts relies on that: a `StageGoal` is
 *   persisted verbatim as the run-state envelope's `stageGoal` field.
 *   All behaviour lives in the exported pure functions below, each of
 *   which takes a `StageGoal` as a parameter and switches on its
 *   `kind` discriminant.
 *
 *   src/config/rules-config.ts carries the opposite contract: its
 *   `merge` member holds functions and is never persisted.
 *
 * CONTENTS
 *   Type declarations, frozen constants and pure functions only. This
 *   module imports nothing, reads no DOM, consumes no randomness,
 *   reads no clock, logs nothing and performs no I/O. Its only
 *   module-scope work freezes the default target list, then builds
 *   and freezes the default curve.
 *
 * The rationale, alternatives and risks behind the choices above —
 * including AAP working assumption A3, which this module implements —
 * are recorded in docs/DECISION_LOG.md. This file carries provenance
 * and invariants only.
 */

/* ==========================================================================
 * 1. Stage goals — the persisted data
 * ========================================================================== */

/**
 * The measurable quantities a stage goal can target.
 *
 * `'highest-tile'` measures the highest tile value present on the
 * board. `'score-threshold'` measures the run score.
 *
 * A union of string literals: these exact strings are what a
 * persisted `StageGoal.kind` contains.
 */
export type StageGoalKind = 'highest-tile' | 'score-threshold';

/**
 * A stage cleared once the highest tile value on the board reaches
 * `target`.
 */
interface HighestTileStageGoal {
  readonly kind: 'highest-tile';
  readonly target: number;
}

/**
 * A stage cleared once the run score reaches `target`.
 */
interface ScoreThresholdStageGoal {
  readonly kind: 'score-threshold';
  readonly target: number;
}

/**
 * One stage's clear condition.
 *
 * A discriminated union over `kind`: `switch (goal.kind)` narrows to
 * exactly one member, and a member added to `StageGoalKind` later
 * raises a compile error at every exhaustive consumer instead of
 * falling through.
 *
 * Persisted verbatim as the run-state envelope's `stageGoal` field,
 * and carried verbatim as the `goal` member of the `stage:start`
 * event payload. Every member is a primitive; see the serialisation
 * contract in the module header.
 */
export type StageGoal = HighestTileStageGoal | ScoreThresholdStageGoal;

/* ==========================================================================
 * 2. Evaluation input and result
 * ========================================================================== */

/**
 * The engine facts a stage goal is evaluated against.
 *
 * Declared in this module, which imports nothing and names no engine
 * type.
 */
export interface StageProgressInput {
  /**
   * The run score. Grows by the produced merge value per merge in
   * the vanilla rules — js/game_manager.js L167 — and by whatever a
   * merge-magic relic produces once relics are active.
   */
  readonly score: number;
  /**
   * The highest tile value present on the board, and 0 for a board
   * holding no tiles.
   */
  readonly highestTileValue: number;
}

/**
 * The result of evaluating one stage goal against one board state.
 *
 * Plain data, like the goal it was derived from.
 */
export interface StageGoalProgress {
  /**
   * The measured quantity: the highest tile value for a
   * `'highest-tile'` goal, the run score for a `'score-threshold'`
   * goal. A HUD renders it against `StageGoal.target` — "128 / 256"
   * — without re-deriving either number.
   */
  readonly achieved: number;
  /**
   * `achieved / target`, clamped to the closed interval [0, 1].
   *
   * Always finite: never `NaN` and never `Infinity`. A value of 1
   * means the target has been reached. This is the number persisted
   * as the run-state envelope's `goalProgress` field; its unit is a
   * fraction of the target, not a raw count and not a percentage.
   */
  readonly progress: number;
  /**
   * Whether the goal is met, computed as `achieved >= target` from
   * the two quantities directly and never from `progress`.
   */
  readonly cleared: boolean;
}

/* ==========================================================================
 * 3. Module-private helpers
 * ========================================================================== */

/**
 * Hard ceiling applied to every derived stage target, in tile-value
 * or score units. `Number.MAX_SAFE_INTEGER`.
 */
const ABSOLUTE_TARGET_CEILING = Number.MAX_SAFE_INTEGER;

/**
 * Rejects an argument that is not a finite number.
 *
 * @param name  the argument name quoted in the message.
 * @param value the argument to check.
 * @throws RangeError when `value` is `NaN`, `Infinity` or
 *   `-Infinity`.
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
 * Maps a number into the closed interval [0, 1].
 *
 * Returns 0 for `NaN`, for `-Infinity` and for every value at or
 * below 0; returns 1 for `Infinity` and for every value at or above
 * 1; returns the value itself otherwise. The result is always
 * finite.
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
 * The upper bound is `maxTarget` clamped into
 * [0, `ABSOLUTE_TARGET_CEILING`]; a `maxTarget` that is not finite
 * bounds to `ABSOLUTE_TARGET_CEILING`. A `raw` value that is `NaN`
 * or infinite — the outcome of an exponential that overflows —
 * resolves to that same upper bound. The result is then rounded to
 * the nearest integer and floored at 0.
 *
 * @param raw       the computed, possibly non-finite target.
 * @param maxTarget the configured upper bound.
 * @returns a finite integer in [0, min(`maxTarget`,
 *   `ABSOLUTE_TARGET_CEILING`)].
 */
function boundedTarget(raw: number, maxTarget: number): number {
  const ceiling = Number.isFinite(maxTarget)
    ? Math.min(Math.max(0, maxTarget), ABSOLUTE_TARGET_CEILING)
    : ABSOLUTE_TARGET_CEILING;
  const bounded = Number.isFinite(raw) ? Math.min(raw, ceiling) : ceiling;
  return Math.round(Math.max(0, bounded));
}

/**
 * Builds a `StageGoal` from a kind and a target.
 *
 * The single construction site for stage goals in this module. The
 * returned object is freshly allocated, unfrozen and plain.
 *
 * @param kind   the quantity the goal measures.
 * @param target the value that quantity must reach.
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

/* ==========================================================================
 * 4. Goal evaluation
 * ========================================================================== */

/**
 * Evaluates one stage goal against one board state.
 *
 * Called at the `onAfterMove` hook to track progress, and at the
 * `onStageEnd` hook to resolve whether the stage was cleared.
 *
 * Pure: mutates neither argument, performs no I/O, consumes no
 * randomness and reads no clock, so identical arguments always
 * produce a deep-equal result.
 *
 * Invariants of the returned value:
 *   - `achieved` is `input.highestTileValue` for a `'highest-tile'`
 *     goal and `input.score` for a `'score-threshold'` goal.
 *   - `cleared` is `achieved >= goal.target`.
 *   - `progress` is finite and within [0, 1].
 *   - a `goal.target` of 0 or below yields a `progress` of 1 when
 *     `cleared` and 0 otherwise.
 *
 * @param goal  the stage's clear condition.
 * @param input the measured engine facts.
 * @returns the measured quantity, the clamped fraction of the target
 *   reached, and whether the goal is met.
 * @throws RangeError when `goal.target`, `input.score` or
 *   `input.highestTileValue` is not a finite number, or when `goal`
 *   carries a `kind` outside `StageGoalKind`.
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

/* ==========================================================================
 * 5. Progression curve
 * ========================================================================== */

/**
 * The parameters that extend a ladder past its last explicit entry.
 *
 * Plain JSON data, like every other member of `StageConfig`.
 */
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
 * The stage progression curve.
 *
 * `ladder` holds the explicit goals for stage indices 0 through
 * `ladder.length - 1`, in stage order. `extension` supplies every
 * index at or beyond `ladder.length`. `stageGoalForIndex()` is
 * therefore total over every non-negative integer index, for any
 * `ladder` length including zero.
 *
 * Plain JSON data throughout: a `StageConfig` is deep-equal to its
 * own `JSON.parse(JSON.stringify(config))` round trip, and every
 * member is directly inspectable by a diagnostics surface.
 */
export interface StageConfig {
  readonly ladder: readonly StageGoal[];
  readonly extension: StageLadderExtension;
}

/**
 * Derives the goal for one stage.
 *
 * `stageIndex` is ZERO-BASED: index 0 is a run's first stage. That
 * matches the run-state envelope's `stageIndex` field and the
 * `stage:start` event payload's `stageIndex` member.
 *
 * An index below `stageConfig.ladder.length` resolves to the
 * corresponding explicit ladder entry. Every index at or beyond that
 * length is derived from `stageConfig.extension` as
 * `baseTarget * growthFactor ** (stageIndex - ladder.length)`,
 * rounded to an integer and bounded into
 * [0, min(`extension.maxTarget`, `Number.MAX_SAFE_INTEGER`)]. A
 * product that overflows to `Infinity`, and any non-finite extension
 * parameter, resolve to that upper bound, so the returned `target` is
 * always a finite non-negative integer at every index.
 *
 * Deterministic: consumes no randomness — no seeded substream is read
 * and no random source is called — and reads no clock, so the same
 * index and the same curve always yield the same goal.
 *
 * Returns a freshly allocated goal on every call and never a
 * reference into `stageConfig`, so mutating the result cannot alter
 * the curve and a frozen curve cannot freeze the result.
 *
 * @param stageIndex  the zero-based stage index.
 * @param stageConfig the progression curve to read.
 * @returns the goal for that stage.
 * @throws RangeError when `stageIndex` is not a non-negative integer.
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
      return createStageGoal(entry.kind, entry.target);
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

/* ==========================================================================
 * 6. Default curve
 * ========================================================================== */

/**
 * The kind carried by every explicit entry of the default ladder.
 */
const DEFAULT_LADDER_KIND: StageGoalKind = 'highest-tile';

/**
 * The targets of the default ladder, in stage order.
 *
 * Eight values of the tile ladder the stylesheet generates
 * (style/main.scss L334-L336), ending at its top value, 2048.
 * Strictly increasing.
 */
const DEFAULT_LADDER_TARGETS: readonly number[] = Object.freeze([
  16, 32, 64, 128, 256, 512, 1024, 2048,
]);

/**
 * The kind carried by every extended stage of the default curve.
 */
const DEFAULT_EXTENSION_KIND: StageGoalKind = 'highest-tile';

/**
 * The target of the default curve's first extended stage: the tile
 * ladder's next value above 2048, which js/html_actuator.js L60
 * applies the `tile-super` band to.
 */
const DEFAULT_EXTENSION_BASE_TARGET = 4096;

/**
 * The growth applied per extended stage of the default curve: one
 * further step of the tile ladder.
 */
const DEFAULT_EXTENSION_GROWTH_FACTOR = 2;

/**
 * The upper bound on a default extended target: 2^52, the largest
 * power of two below `Number.MAX_SAFE_INTEGER`.
 */
const DEFAULT_EXTENSION_MAX_TARGET = 2 ** 52;

/**
 * Freezes a curve at every level: the object itself, its `ladder`,
 * each ladder entry and its `extension`.
 *
 * @param config the curve to freeze in place.
 * @returns the same object, frozen.
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
 * Builds the default progression curve.
 *
 * Returns a freshly allocated, unfrozen `StageConfig` on every call,
 * sharing no object — not the curve, not its `ladder`, not a ladder
 * entry, not its `extension` — with `DEFAULT_STAGE_CONFIG` or with
 * any earlier return value.
 *
 * @returns a new default curve.
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
 * The default progression curve, deep-frozen.
 *
 * Eight explicit `'highest-tile'` stages at 16, 32, 64, 128, 256,
 * 512, 1024 and 2048, extended past 2048 by doubling up to 2^52.
 * Every level of the object is frozen, so no consumer can mutate the
 * shared template; `createDefaultStageConfig()` returns a mutable
 * copy of the same curve.
 */
export const DEFAULT_STAGE_CONFIG: StageConfig = deepFreezeStageConfig(
  /* @__PURE__ */ createDefaultStageConfig(),
);

