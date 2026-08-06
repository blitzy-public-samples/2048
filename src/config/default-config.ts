/**
 * Vanilla-equivalent default rules: two merge rules, five values, one factory
 * and one frozen template. No value here is retuned from the behaviour the
 * pre-migration game shipped, and no rule is declared that it did not have.
 *
 * Mutability contract: `createDefaultRulesConfig()` returns an unfrozen object
 * sharing no object with `DEFAULT_RULES_CONFIG` or with any earlier return
 * value, and `DEFAULT_RULES_CONFIG` is frozen at every level.
 *
 * This module imports only the types of src/config/rules-config.ts. It reads no
 * DOM and no storage, consumes no randomness and takes no spawn draw: it
 * declares the distribution the engine's seeded draw resolves against.
 */

// The specifier carries its `.ts` extension: vite.config.ts imports
// src/theme/tokens.ts for the Sass token projection and that module imports this
// one, so every specifier in the chain must resolve under Vite's native config
// loader, which resolves no extensionless specifier.
import type {
  MergePredicate,
  MergeProducer,
  MergeTileView,
  RulesConfig,
} from './rules-config.ts';

/* ===== 1. Default merge rules ===== */

/**
 * The default merge predicate: a moving tile merges into the tile it has run
 * into when the two carry the same value and the target has not already merged
 * this turn. Reads `moving.value`, `target.value` and `target.mergedFrom` only,
 * and mutates neither operand.
 *
 * @param moving Tile being moved into the target's cell.
 * @param target Tile already occupying the destination cell; its presence is
 *   established by the move resolver and is not retested here.
 * @returns `true` when the pair merges, `false` when the moving tile instead
 *   stops short of the target.
 */
export function defaultCanMerge(
  moving: MergeTileView,
  target: MergeTileView,
): boolean {
  return moving.value === target.value && !target.mergedFrom;
}

/**
 * The default merge producer: the merge of a pair yields double the moving
 * tile's value. Returns a face value only and constructs nothing. The engine
 * adds this value to the score, so this module declares no separate score rule
 * and a replaced producer changes scoring with it.
 *
 * @param moving Tile being moved into the target's cell.
 * @param _target Tile already occupying the destination cell; unread.
 * @returns Face value of the tile the merge yields — a positive integer for any
 *   pair of positive-integer values. Called only for a pair a `MergePredicate`
 *   has already accepted, so the two operands carry equal values here.
 */
export function defaultProduceMergeValue(
  moving: MergeTileView,
  _target: MergeTileView,
): number {
  return moving.value * 2;
}

/* ===== 2. Default rule values ===== */

/**
 * Default edge length of the square board, in cells. The single board-size
 * value: it supersedes the stylesheet's own cell count and the static cell
 * elements the markup used to declare.
 */
export const DEFAULT_BOARD_SIZE = 4;

/**
 * Default tile value that wins the game. How a tile value is compared against it
 * belongs to src/engine/terminal-state.ts, and the visual band above it to
 * src/theme/tile-ramp.ts.
 */
const DEFAULT_WIN_VALUE = 2048;

/** Default number of tiles inserted when a stage begins. */
const DEFAULT_START_TILES = 2;

/**
 * Default tile values a spawn draws from, in the index order the
 * `SpawnDistribution` selection convention walks. Paired with
 * `DEFAULT_SPAWN_WEIGHTS` by index, and this order is not reversed.
 */
const DEFAULT_SPAWN_VALUES: readonly number[] = [2, 4];

/**
 * Default selection probability of each entry of `DEFAULT_SPAWN_VALUES`, in the
 * same index order; the two members sum to 1. One draw `r` in [0, 1) therefore
 * selects 2 when `r` is below 0.9 and 4 otherwise.
 */
const DEFAULT_SPAWN_WEIGHTS: readonly number[] = [0.9, 0.1];

/* ===== 3. Factory ===== */

/**
 * Builds the vanilla-equivalent rules: a freshly allocated, unfrozen
 * `RulesConfig` on every call, sharing no object — not the config, its `spawn`,
 * either spawn array, or its `merge` — with `DEFAULT_RULES_CONFIG` or an earlier
 * return value. The two merge members are this module's exported functions; they
 * hold no state and are shared, not copied.
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

/* ===== 4. Frozen template ===== */

/**
 * Freezes a config at every level: both spawn arrays, its `spawn`, its `merge`,
 * and the object itself.
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
 * The vanilla-equivalent rules, deep-frozen: `boardSize` 4, `winValue` 2048,
 * `startTiles` 2, spawn values `[2, 4]` at weights `[0.9, 0.1]`, and the two
 * default merge rules. Frozen at every level, so no consumer can mutate the
 * shared template; `createDefaultRulesConfig()` returns a mutable copy.
 */
export const DEFAULT_RULES_CONFIG: RulesConfig = deepFreezeRulesConfig(
  /* @__PURE__ */ createDefaultRulesConfig(),
);
