/**
 * Rules schema for the configuration-driven game rules.
 *
 * PROVENANCE
 *   Every type here externalises a construct that the superseded
 *   vanilla sources hardcoded. Each declaration cites its own origin
 *   line; the complete set this module supersedes is:
 *
 *     boardSize    js/application.js L3
 *     winValue     js/game_manager.js L170
 *     startTiles   js/game_manager.js L7
 *     spawn        js/game_manager.js L71
 *     merge        js/game_manager.js L156 and L157
 *
 * CONTENTS
 *   Type declarations only. This module imports nothing, declares no
 *   runtime binding, performs no work at load, and touches no DOM or
 *   Web Storage. It contributes nothing to the emitted bundle;
 *   consumers reference it with `import type`.
 *
 *   The vanilla-equivalent values that populate a `RulesConfig` are
 *   declared in src/config/default-config.ts. Stage goals and the
 *   progression curve are declared in src/config/stage-config.ts.
 *   Neither belongs here.
 *
 * CONSUMERS
 *   The engine and the relics read the same `RulesConfig` instance.
 *   Members are mutable and must be read at each use; see the
 *   read-at-use-time note on `RulesConfig`.
 *
 * The rationale, alternatives and risks behind every choice above are
 * recorded in docs/DECISION_LOG.md; this file carries provenance only.
 */

/**
 * Structural view of a tile as the merge rules see it.
 *
 * The operand type of `MergePredicate` and `MergeProducer`, and the
 * only tile-shaped type this module declares. A tile whose own type
 * declares `value: number` and `mergedFrom: Tile[] | null` satisfies
 * this view structurally and needs no adapter: `Tile[]` is assignable
 * to `readonly unknown[]`.
 *
 * Both members are readonly: a predicate and a producer read their
 * operands and must mutate neither.
 *
 * Ported from the two tile fields the vanilla merge branch reads,
 * js/tile.js L4 (`this.value = value || 2;`) and js/tile.js L7
 * (`this.mergedFrom = null;`).
 */
export interface MergeTileView {
  /**
   * Face value of the tile.
   *
   * A positive integer. js/tile.js L4 coerces a falsy constructor
   * argument to 2, so 0 never reaches a merge rule as a tile value.
   */
  readonly value: number;

  /**
   * The pair of tiles this tile was produced by, or `null` when it
   * was not produced by a merge this turn.
   *
   * The merge rules read this member for presence only. Its element
   * type is unconstrained. js/game_manager.js L158 assigns the
   * populated form (`merged.mergedFrom = [tile, next];`) and
   * js/game_manager.js L116 clears it to `null` at the start of every
   * move.
   */
  readonly mergedFrom: readonly unknown[] | null;
}

/**
 * Discrete distribution a newly spawned tile's value is drawn from.
 *
 * Two parallel arrays indexed in lockstep: `weights[i]` is the
 * selection probability of `values[i]`.
 *
 * INVARIANTS
 *   `values.length` equals `weights.length`.
 *   Both arrays are non-empty.
 *   Every member of `values` is a positive integer.
 *   Every member of `weights` is greater than or equal to 0.
 *   The members of `weights` sum to 1.
 *
 * SELECTION CONVENTION
 *   A consumer takes exactly one draw `r` in the half-open interval
 *   [0, 1) from the spawn-value random stream, then walks the weights
 *   in index order accumulating a running total; the first index whose
 *   running total is greater than `r` selects `values` at that index.
 *   One draw per spawn, never two.
 *
 *   With `values` `[2, 4]` and `weights` `[0.9, 0.1]` that convention
 *   yields 2 when `r` is less than 0.9 and 4 otherwise, which is
 *   js/game_manager.js L71 (`var value = Math.random() < 0.9 ? 2 : 4;`)
 *   exactly.
 */
export interface SpawnDistribution {
  /**
   * Tile values that can be spawned, in the index order the selection
   * convention walks.
   *
   * Ported from the two literals of js/game_manager.js L71.
   */
  values: number[];

  /**
   * Selection probability of each entry of `values`, in the same index
   * order.
   *
   * Ported from the `0.9` threshold of js/game_manager.js L71, whose
   * two branches carry probabilities 0.9 and 0.1.
   */
  weights: number[];
}

/**
 * Decides whether a moving tile merges into the tile it has run into.
 *
 * OPERANDS
 *   `moving` is the tile being moved; it is vanilla's `tile`.
 *   `target` is the tile already occupying the destination cell; it is
 *   vanilla's `next`.
 *
 * PRECONDITION
 *   `target` is non-nullable. The existence half of
 *   js/game_manager.js L156, `next &&`, is retained by the caller:
 *   src/engine/move-resolver.ts calls a predicate only once a target
 *   tile is present, so an implementation neither receives nor tests
 *   an absent target.
 *
 * CONTRACT
 *   An implementation is pure with respect to its operands: it returns
 *   a verdict and mutates neither tile.
 *
 * Ported from the two remaining conjuncts of js/game_manager.js L156,
 * `if (next && next.value === tile.value && !next.mergedFrom) {` —
 * equal value, and a target that has not already merged this turn.
 *
 * @param moving Tile being moved into the target's cell.
 * @param target Tile already occupying the destination cell.
 * @returns `true` when the pair merges, `false` when the moving tile
 *   instead stops short of the target.
 */
export type MergePredicate = (
  moving: MergeTileView,
  target: MergeTileView
) => boolean;

/**
 * Produces the face value of the tile a merge yields.
 *
 * Returns a value only. The engine constructs the resulting tile; an
 * implementation constructs nothing and mutates neither operand.
 *
 * Both operands are supplied. js/game_manager.js L157 reads only
 * `moving.value`.
 *
 * SCORE COUPLING
 *   The engine adds the returned value to the score exactly as
 *   js/game_manager.js L167 does (`self.score += merged.value;`).
 *   This schema carries no separate score rule: a replaced producer
 *   changes scoring with it. A score adjustment that is independent of
 *   the produced value is made through the `scoreDelta` field of the
 *   `onMerge` hook payload instead.
 *
 * INVARIANT
 *   The returned value is a positive integer. js/tile.js L4 coerces a
 *   falsy tile value to 2.
 *
 * PRECONDITION
 *   Called only for a pair a `MergePredicate` has already accepted.
 *
 * Ported from js/game_manager.js L157,
 * `var merged = new Tile(positions.next, tile.value * 2);` — the
 * vanilla product is `moving.value` doubled.
 *
 * @param moving Tile being moved into the target's cell.
 * @param target Tile already occupying the destination cell.
 * @returns Face value of the tile the merge yields.
 */
export type MergeProducer = (
  moving: MergeTileView,
  target: MergeTileView
) => number;

/**
 * The pair of functions that constitute the merge rule.
 *
 * Holds two ordinary function references. Either member can be
 * replaced or wrapped, and the effective merge rule of a run is
 * readable directly from this object.
 *
 * Ported from the merge branch of js/game_manager.js L156 and L157.
 */
export interface MergeRules {
  /**
   * Whether a given pair of tiles merges.
   *
   * Ported from js/game_manager.js L156.
   */
  canMerge: MergePredicate;

  /**
   * Face value the merge of a given pair yields.
   *
   * Ported from js/game_manager.js L157.
   */
  produce: MergeProducer;
}

/**
 * The effective rules of a run.
 *
 * The single object the base game and every relic read their rules
 * from. It has exactly five members.
 *
 * READ AT USE TIME
 *   Every member is mutable and is read afresh at each use. A consumer
 *   does not hoist a member into a module-scope constant, and does not
 *   capture one in a closure that outlives the call. `boardSize` in
 *   particular is reconciled against a persisted board size and any
 *   active board-mutating relic, and so changes during a run.
 *
 *   The vanilla sources already held this property: js/game_manager.js
 *   L210 rereads `this.size` on every traversal build and L248 and
 *   L249 reread it on every loss check.
 */
export interface RulesConfig {
  /**
   * Edge length of the square board, in cells.
   *
   * One number governs both axes: js/grid.js derives the whole lattice
   * from a single size in `empty()` L7-L19, in `fromState()` L21-L34
   * and in `withinBounds()` L97-L100.
   *
   * A positive integer. Supersedes the literal `4` of
   * js/application.js L3,
   * `new GameManager(4, KeyboardInputManager, HTMLActuator,
   * LocalStorageManager);`, together with `$grid-row-cells` of
   * style/main.scss L6 and the static cells of index.html L43-L68.
   */
  boardSize: number;

  /**
   * Tile value that wins the game.
   *
   * How a tile value is compared against this one is owned by
   * src/engine/terminal-state.ts, not by this schema. The vanilla
   * comparison is strict equality inside the merge branch:
   * js/game_manager.js L170,
   * `if (merged.value === 2048) self.won = true;`.
   *
   * A positive integer. This is a rule value and is unrelated to the
   * visual band above it, which src/theme/tile-ramp.ts owns.
   */
  winValue: number;

  /**
   * How many tiles are inserted when a stage begins.
   *
   * A non-negative integer. Ported from js/game_manager.js L7,
   * `this.startTiles     = 2;`, which js/game_manager.js L62-L66
   * consumes as the bound of the start-tile loop.
   */
  startTiles: number;

  /**
   * Distribution a newly spawned tile's value is drawn from.
   *
   * Ported from js/game_manager.js L71.
   */
  spawn: SpawnDistribution;

  /**
   * Rule deciding which tiles merge and what value the merge yields.
   *
   * Ported from js/game_manager.js L156 and L157.
   */
  merge: MergeRules;
}
