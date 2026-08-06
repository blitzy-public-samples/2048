/**
 * Vanilla-equivalent default rules.
 *
 * PROVENANCE
 *   Every value and every rule declared here is ported from a
 *   superseded vanilla source line, cited at its own declaration
 *   below. The complete set this module supersedes is:
 *
 *     boardSize        js/application.js L3
 *     winValue         js/game_manager.js L170
 *     startTiles       js/game_manager.js L7
 *     spawn            js/game_manager.js L71
 *     merge.canMerge   js/game_manager.js L156
 *     merge.produce    js/game_manager.js L157
 *
 * INVARIANT
 *   No value here is adjusted, rounded or retuned from its cited
 *   source line, and this module declares no rule without a vanilla
 *   counterpart.
 *
 * CONTENTS
 *   Two merge rules, five values, one factory and one frozen
 *   template. This module imports the types of
 *   src/config/rules-config.ts and nothing else. It reads no DOM and
 *   no Web Storage, consumes no randomness, reads no clock, emits no
 *   output and performs no I/O. Its only module-scope work builds
 *   `DEFAULT_RULES_CONFIG` and freezes it.
 *
 *   Stage goals and the progression curve have no vanilla counterpart
 *   and are declared in src/config/stage-config.ts, not here. The
 *   spawn draw itself is taken by the engine from the seeded
 *   spawn-value stream: this module declares only the distribution
 *   that draw resolves against, and takes no draw.
 *
 * MUTABILITY CONTRACT
 *   `createDefaultRulesConfig()` returns an unfrozen object that
 *   shares no object with `DEFAULT_RULES_CONFIG` or with any earlier
 *   return value. `DEFAULT_RULES_CONFIG` is frozen at every level.
 *
 * The rationale, alternatives and risks behind the choices above are
 * recorded in docs/DECISION_LOG.md. This file carries provenance and
 * invariants only.
 */

import type {
  MergePredicate,
  MergeProducer,
  MergeTileView,
  RulesConfig,
} from './rules-config';

/* ==========================================================================
 * 1. Default merge rules
 * ========================================================================== */

/**
 * The default merge predicate: a moving tile merges into the tile it
 * has run into when the two carry the same value and the target has
 * not already merged this turn.
 *
 * Implements `MergePredicate`. `createDefaultRulesConfig()` binds it
 * to `merge.canMerge`.
 *
 * OPERANDS READ
 *   `moving.value`, `target.value` and `target.mergedFrom`, and
 *   nothing else. Neither operand is mutated.
 *
 * PRECONDITION
 *   `target` is present. The existence half of the vanilla condition,
 *   `next &&`, is retained by src/engine/move-resolver.ts and is not
 *   retested here.
 *
 * Ported from the two remaining conjuncts of js/game_manager.js L156,
 * `if (next && next.value === tile.value && !next.mergedFrom) {`,
 * where vanilla's `tile` is `moving` and vanilla's `next` is
 * `target`.
 *
 * @param moving Tile being moved into the target's cell.
 * @param target Tile already occupying the destination cell.
 * @returns `true` when the pair merges, `false` when the moving tile
 *   instead stops short of the target.
 */
export function defaultCanMerge(
  moving: MergeTileView,
  target: MergeTileView,
): boolean {
  return moving.value === target.value && !target.mergedFrom;
}

/**
 * The default merge producer: the merge of a pair yields double the
 * moving tile's value.
 *
 * Implements `MergeProducer`. `createDefaultRulesConfig()` binds it
 * to `merge.produce`.
 *
 * Returns a face value only and constructs nothing; the engine builds
 * the resulting tile. The engine also adds this return value to the
 * score exactly as js/game_manager.js L167 does,
 * `self.score += merged.value;`, so this module declares no separate
 * score rule: a replaced producer changes scoring with it.
 *
 * `_target` is unread. js/game_manager.js L157 reads only the moving
 * tile's value.
 *
 * PRECONDITION
 *   Called only for a pair a `MergePredicate` has already accepted,
 *   so under `defaultCanMerge` the two operands carry equal values.
 *
 * INVARIANT
 *   Returns a positive integer for any pair of positive-integer tile
 *   values. js/tile.js L4, `this.value            = value || 2;`,
 *   coerces a falsy tile value to 2, and neither default spawn value
 *   reaches that path.
 *
 * Ported from js/game_manager.js L157,
 * `var merged = new Tile(positions.next, tile.value * 2);`.
 *
 * @param moving Tile being moved into the target's cell.
 * @param _target Tile already occupying the destination cell; unread.
 * @returns Face value of the tile the merge yields.
 */
export function defaultProduceMergeValue(
  moving: MergeTileView,
  _target: MergeTileView,
): number {
  return moving.value * 2;
}

/* ==========================================================================
 * 2. Default values
 * ========================================================================== */

/**
 * Default edge length of the square board, in cells.
 *
 * Ported from the literal `4` of js/application.js L3,
 * `new GameManager(4, KeyboardInputManager, HTMLActuator,
 * LocalStorageManager);`, the only board-size value in the vanilla
 * JavaScript. It supersedes `$grid-row-cells: 4` of style/main.scss
 * L6 and the sixteen static `.grid-cell` elements of index.html
 * L43-L68 as well.
 */
const DEFAULT_BOARD_SIZE = 4;

/**
 * Default tile value that wins the game.
 *
 * Ported from js/game_manager.js L170,
 * `if (merged.value === 2048) self.won = true;`. How a tile value is
 * compared against this one is owned by src/engine/terminal-state.ts;
 * this module supplies the number only. It is a rule value, unrelated
 * to the visual band above it that src/theme/tile-ramp.ts owns.
 */
const DEFAULT_WIN_VALUE = 2048;

/**
 * Default number of tiles inserted when a stage begins.
 *
 * Ported from js/game_manager.js L7, `this.startTiles     = 2;`,
 * which js/game_manager.js L62-L66 consumes as the bound of the
 * start-tile loop.
 */
const DEFAULT_START_TILES = 2;

/**
 * Default tile values a spawn draws from, in the index order the
 * `SpawnDistribution` selection convention walks.
 *
 * Ported from the two tile-value literals of the ternary at
 * js/game_manager.js L71: index 0 holds `2`, the value that line
 * yields on its `< 0.9` branch, and index 1 holds `4`, the value it
 * yields on the complementary branch. The pairing with
 * `DEFAULT_SPAWN_WEIGHTS` is by index, and this order is not
 * reversed.
 */
const DEFAULT_SPAWN_VALUES: readonly number[] = [2, 4];

/**
 * Default selection probability of each entry of
 * `DEFAULT_SPAWN_VALUES`, in the same index order. The two members
 * sum to 1.
 *
 * Ported from the `0.9` threshold of the ternary at
 * js/game_manager.js L71: index 0 holds `0.9`, the probability of
 * that line's `< 0.9` branch, and index 1 holds `0.1`, the
 * probability of its complement. One draw `r` in the half-open
 * interval [0, 1) therefore selects the value `2` when `r` is less
 * than 0.9 and the value `4` otherwise, which is the selection L71
 * makes.
 */
const DEFAULT_SPAWN_WEIGHTS: readonly number[] = [0.9, 0.1];

/* ==========================================================================
 * 3. Factory
 * ========================================================================== */

/**
 * Builds the vanilla-equivalent rules.
 *
 * Returns a freshly allocated, unfrozen `RulesConfig` on every call,
 * sharing no object — not the config, not its `spawn`, not either
 * spawn array, not its `merge` — with `DEFAULT_RULES_CONFIG` or with
 * any earlier return value. Every member of the returned object is
 * plainly mutable, `boardSize` included.
 *
 * The two merge members are this module's two exported functions;
 * they hold no state and are shared, not copied.
 *
 * @returns a new vanilla-equivalent `RulesConfig`.
 */
export function createDefaultRulesConfig(): RulesConfig {
  const canMerge: MergePredicate = defaultCanMerge;
  const produce: MergeProducer = defaultProduceMergeValue;

  return {
    boardSize: DEFAULT_BOARD_SIZE,
    winValue: DEFAULT_WIN_VALUE,
    startTiles: DEFAULT_START_TILES,
    spawn: {
      values: DEFAULT_SPAWN_VALUES.slice(),
      weights: DEFAULT_SPAWN_WEIGHTS.slice(),
    },
    merge: { canMerge, produce },
  };
}

/* ==========================================================================
 * 4. Frozen template
 * ========================================================================== */

/**
 * Freezes a config at every level: both spawn arrays, its `spawn`,
 * its `merge`, and the object itself.
 *
 * @param config the config to freeze in place.
 * @returns the same object, frozen.
 */
function deepFreezeRulesConfig(config: RulesConfig): RulesConfig {
  Object.freeze(config.spawn.values);
  Object.freeze(config.spawn.weights);
  Object.freeze(config.spawn);
  Object.freeze(config.merge);
  return Object.freeze(config);
}

/**
 * The vanilla-equivalent rules, deep-frozen.
 *
 * `boardSize` 4, `winValue` 2048, `startTiles` 2, spawn values
 * `[2, 4]` at weights `[0.9, 0.1]`, `merge.canMerge` bound to
 * `defaultCanMerge` and `merge.produce` bound to
 * `defaultProduceMergeValue`.
 *
 * Every level of the object is frozen, so no consumer can mutate the
 * shared template; `createDefaultRulesConfig()` returns a mutable
 * copy of the same rules.
 */
export const DEFAULT_RULES_CONFIG: RulesConfig = deepFreezeRulesConfig(
  /* @__PURE__ */ createDefaultRulesConfig(),
);
