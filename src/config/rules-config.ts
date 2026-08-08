/**
 * Rules schema for the configuration-driven game rules.
 *
 * Type declarations only. This module imports nothing, declares no runtime
 * binding, performs no work at load, and touches no DOM or Web Storage. It
 * contributes nothing to the emitted bundle; consumers reference it with
 * `import type`.
 *
 * The vanilla-equivalent values that populate a `RulesConfig` are declared in
 * src/config/default-config.ts, and stage goals and the progression curve in
 * src/config/stage-config.ts. The engine and the relics read the same
 * `RulesConfig` instance; members are mutable and are read at each use.
 *
 * One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
 * this module's area enumerated:
 *   TR-CONFIG-01  js/application.js L3          the board-size literal, as
 *                                               `boardSize`
 *   TR-CONFIG-02  js/game_manager.js L170       `2048`, as `winValue`
 *   TR-CONFIG-03  js/game_manager.js L7         `2`, as `startTiles`
 *   TR-CONFIG-04  js/game_manager.js L71        `Math.random() < 0.9 ? 2 : 4`,
 *                                               as `spawn` and
 *                                               `SpawnDistribution`
 *   TR-CONFIG-05  js/game_manager.js L156-L157  the merge condition and the
 *                                               doubled value, as
 *                                               `MergePredicate` and
 *                                               `MergeProducer`
 *   TR-CONFIG-06  target-only row               `MergeTileView`, the structural
 *                                               operand both merge members read
 *
 * Decisions behind this file, argued in docs/DECISION_LOG.md and named here
 * only so the construct can be found from the log:
 *   DL-CONFIG-01  the merge rule expressed as a replaceable predicate and
 *                 producer pair
 *   DL-CONFIG-02  every member declared mutable and read at each use
 */

/**
 * Structural view of a tile as the merge rules see it. A tile declaring
 * `value: number` and `mergedFrom: Tile[] | null` satisfies it structurally and
 * needs no adapter. Both members are readonly: a predicate and a producer read
 * their operands and mutate neither.
 */
export interface MergeTileView {
  readonly value: number;

  /**
   * The pair of tiles this tile was produced by, or `null` when it was not
   * produced by a merge this turn. Read for presence only.
   */
  readonly mergedFrom: readonly unknown[] | null;
}

/**
 * Discrete distribution a newly spawned tile's value is drawn from: two parallel
 * arrays indexed in lockstep, where `weights[i]` is the selection probability of
 * `values[i]`.
 *
 * Invariants: the arrays are non-empty and of equal length, every value is a
 * positive integer, every weight is at least 0, and the weights sum to 1.
 *
 * Selection takes exactly one draw `r` in [0, 1) from the spawn-value stream and
 * walks the weights in index order, accumulating a running total; the first
 * index whose total exceeds `r` selects the value. One draw per spawn.
 */
export interface SpawnDistribution {
  /**
   * Tile values that can be spawned, in the index order the selection
   * convention walks.
   */
  values: number[];

  /**
   * Selection probability of each entry of `values`, in the same index order.
   */
  weights: number[];
}

/**
 * Decides whether a moving tile merges into the tile it has run into. An
 * implementation is pure with respect to its operands: it returns a verdict and
 * mutates neither tile. `target` is non-nullable — its presence is established
 * by the move resolver.
 */
export type MergePredicate = (
  moving: MergeTileView,
  target: MergeTileView
) => boolean;

/**
 * Produces the face value of the tile a merge yields, and is called only for a
 * pair a `MergePredicate` has already accepted. The engine constructs the
 * resulting tile; an implementation constructs nothing and mutates neither
 * operand. The schema carries no separate score rule, so a replaced producer
 * changes scoring with it; a score adjustment independent of the produced value
 * is made through the `scoreDelta` field of the `onMerge` hook payload.
 */
export type MergeProducer = (
  moving: MergeTileView,
  target: MergeTileView
) => number;

/**
 * The pair of functions that constitute the merge rule. Either member can be
 * replaced or wrapped, so the effective merge rule of a run is readable
 * directly from this object.
 */
export interface MergeRules {
  canMerge: MergePredicate;
  produce: MergeProducer;
}

/**
 * The effective rules of a run: the single object the base game and every relic
 * read their rules from.
 *
 * Every member is mutable and is READ AFRESH AT EACH USE — a consumer neither
 * hoists a member into a module-scope constant nor captures one in a closure
 * that outlives the call. `boardSize` in particular is reconciled against a
 * persisted board size and any active board-mutating relic, so it changes
 * during a run.
 *
 * Numeric domains the types do not express: `boardSize` and `winValue` are
 * positive integers and `startTiles` is a non-negative integer.
 */
export interface RulesConfig {
  boardSize: number;
  winValue: number;
  startTiles: number;
  spawn: SpawnDistribution;
  merge: MergeRules;
}
