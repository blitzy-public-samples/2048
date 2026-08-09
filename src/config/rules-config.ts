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
 * Decisions: DL-CONFIG-01, DL-CONFIG-02, DL-CONFIG-03 (docs/DECISION_LOG.md).
 */

/**
 * Structural view of a tile as the merge rules see it. A tile declaring
 * `value: number` and `mergedFrom: Tile[] | null` satisfies it structurally and
 * needs no adapter.
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
 * Discrete distribution a newly spawned tile's value is drawn from: two
 * parallel arrays indexed in lockstep, where `weights[i]` is the RELATIVE
 * weight of `values[i]` — a share of the weights' own total, not a
 * probability.
 *
 * Invariants, as `RngStream.pickWeighted` of src/rng/rng-streams.ts enforces
 * them: both arrays non-empty and of EQUAL LENGTH, every value a positive
 * integer, every weight finite and at least 0, and their TOTAL above 0.
 * The total need not be 1: `[9, 1]` and `[0.9, 0.1]` select identically. A
 * shape outside those bounds selects nothing, consumes no draw and leaves the
 * spawn to its fallback value.
 *
 * Selection takes exactly one draw from the spawn-value substream, scales it by
 * the weight total, then walks the weights in index order accumulating a
 * running total; the first index whose running total exceeds the scaled draw
 * selects the value. One draw per spawn, never one per candidate.
 */
export interface SpawnDistribution {
  /**
   * Tile values that can be spawned, in the index order the selection
   * convention walks.
   */
  values: number[];

  /**
   * Relative weight of each entry of `values`, in the same index order. Finite
   * and at least 0 apiece, with a total greater than 0.
   */
  weights: number[];
}

/**
 * Decides whether a moving tile merges into the tile it has run into. An
 * implementation is pure with respect to its operands: it returns a verdict
 * and mutates neither tile.
 */
export type MergePredicate = (
  moving: MergeTileView,
  target: MergeTileView
) => boolean;

/**
 * Produces the face value of the tile a merge yields, and is called only for a
 * pair a `MergePredicate` has already accepted. The engine constructs the
 * resulting tile; an implementation constructs nothing and mutates neither
 * operand.
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
 * The effective rules of a run: the single object the base game and every
 * relic read their rules from.
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
