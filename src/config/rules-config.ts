/**
 * Rules schema for the configuration-driven game rules. Type declarations only:
 * this module imports nothing, declares no runtime binding and contributes
 * nothing to the bundle. The vanilla-equivalent values that populate a
 * `RulesConfig` live in src/config/default-config.ts, and stage goals in
 * src/config/stage-config.ts.
 */

/**
 * Structural view of a tile as the merge rules see it. A tile declaring
 * `value: number` and `mergedFrom: Tile[] | null` satisfies it structurally and
 * needs no adapter. Both members are readonly: a predicate and a producer read
 * their operands and mutate neither.
 */
export interface MergeTileView {
  /** Face value of the tile. */
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
 * mutates neither tile.
 *
 * @param moving Tile being moved into the target's cell.
 * @param target Tile already occupying the destination cell. Non-nullable.
 * @returns `true` when the pair merges, `false` when the moving tile stops
 *   short of the target.
 */
export type MergePredicate = (
  moving: MergeTileView,
  target: MergeTileView
) => boolean;

/**
 * Produces the face value of the tile a merge yields. The engine constructs the
 * resulting tile; an implementation constructs nothing and mutates neither
 * operand. The schema carries no separate score rule, so a replaced producer
 * changes scoring with it; a score adjustment independent of the produced value
 * is made through the `scoreDelta` field of the `onMerge` hook payload.
 *
 * @param moving Tile being moved into the target's cell.
 * @param target Tile already occupying the destination cell.
 * @returns Face value of the tile the merge yields. Called only for a pair a
 *   `MergePredicate` has already accepted.
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
  /** Whether a given pair of tiles merges. */
  canMerge: MergePredicate;

  /** Face value the merge of a given pair yields. */
  produce: MergeProducer;
}

/**
 * The effective rules of a run: the single object the base game and every relic
 * read their rules from.
 *
 * Every member is mutable and is read afresh at each use — a consumer neither
 * hoists a member into a module-scope constant nor captures one in a closure
 * that outlives the call. `boardSize` in particular is reconciled against a
 * persisted board size and any active board-mutating relic, so it changes
 * during a run.
 */
export interface RulesConfig {
  /** Edge length of the square board, in cells. A positive integer. */
  boardSize: number;

  /**
   * Tile value that wins the game. A positive integer. How a tile value is
   * compared against it belongs to src/engine/terminal-state.ts, and the visual
   * band above it to src/theme/tile-ramp.ts.
   */
  winValue: number;

  /** How many tiles are inserted when a stage begins. A non-negative integer. */
  startTiles: number;

  /** Distribution a newly spawned tile's value is drawn from. */
  spawn: SpawnDistribution;

  /** Rule deciding which tiles merge and what value the merge yields. */
  merge: MergeRules;
}
