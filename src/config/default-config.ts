/**
 * Vanilla-equivalent default rules: two merge rules, five values, one factory
 * and one frozen template. No value here is retuned from the behaviour the
 * pre-migration game shipped, and no rule is declared that it did not have.
 *
 * Mutability contract: `createDefaultRulesConfig()` returns an unfrozen object
 * sharing no object with `DEFAULT_RULES_CONFIG` or with any earlier return
 * value, and `DEFAULT_RULES_CONFIG` is frozen at every level.
 *
 * This module reads no DOM and no storage, consumes no randomness and takes no
 * spawn draw: it declares the distribution the engine's seeded draw resolves
 * against.
 */

// The specifier carries its `.ts` extension because this module is reached
// from vite.config.ts, whose native config loader resolves no extensionless
// specifier.
import type {
  MergePredicate,
  MergeProducer,
  MergeTileView,
  RulesConfig,
} from './rules-config.ts';

/**
 * The default merge predicate: a moving tile merges into the tile it has run
 * into when the two carry the same value and the target has not already merged
 * this turn. Reads `moving.value`, `target.value` and `target.mergedFrom` only,
 * and mutates neither operand.
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
 */
export function defaultProduceMergeValue(
  moving: MergeTileView,
  _target: MergeTileView,
): number {
  return moving.value * 2;
}

/**
 * Default edge length of the square board, in cells. The single board-size
 * value: it supersedes the stylesheet's own cell count and the static cell
 * elements the markup used to declare.
 */
export const DEFAULT_BOARD_SIZE = 4;

/**
 * Highest board edge length the product supports, in cells.
 *
 * The single board-edge ceiling. src/run/run-state.ts,
 * src/run/run-state-store.ts, src/render/number-only-renderer.ts and
 * src/ui/a11y/focus-manager.ts all measure a candidate edge against this one
 * value, so an edge cannot be accepted by one of them and refused by another.
 * Each of those modules turns an accepted edge into a `size` by `size`
 * allocation — a cell matrix, a lattice of grid cells, or a pair of parallel
 * arrays — so this is the bound on all of them.
 *
 * src/engine/grid.ts allocates the size it is handed and does not test it:
 * every caller reaching it has already been through this ceiling.
 * src/engine/hook-bus.ts measures a payload's board size against the live
 * grid's own `size` instead, so the engine folder reads no constant from here.
 *
 * Recorded in docs/DECISION_LOG.md.
 */
export const MAX_BOARD_SIZE = 16;

/**
 * Reports whether `value` is a board edge length the product supports: an
 * integer from 1 through `MAX_BOARD_SIZE`.
 *
 * Pure and total, and accepts a value of any type: a candidate edge reaches a
 * caller from persisted JSON, from a `state:commit` payload or from a
 * board-mutating relic. Rejects `NaN`, both infinities, every fractional and
 * negative value, zero, every magnitude beyond the exactly representable
 * integer range, everything above `MAX_BOARD_SIZE`, and every value that is
 * not a number.
 *
 * @param value Value to test.
 * @returns `true` for a positive safe integer at or below `MAX_BOARD_SIZE`.
 */
export function isSupportedBoardSize(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_BOARD_SIZE
  );
}

/**
 * Default tile value that wins the game. How a tile value is compared against it
 * belongs to src/engine/terminal-state.ts, and the visual band above it to
 * src/theme/tile-ramp.ts.
 */
const DEFAULT_WIN_VALUE = 2048;

const DEFAULT_START_TILES = 2;

/**
 * Default tile values a spawn draws from, paired with `DEFAULT_SPAWN_WEIGHTS`
 * by index in the order the selection convention walks; this order is not
 * reversed.
 */
const DEFAULT_SPAWN_VALUES: readonly number[] = [2, 4];

/**
 * Default selection probability of each entry of `DEFAULT_SPAWN_VALUES`, in the
 * same index order; the two members sum to 1. One draw `r` in [0, 1) therefore
 * selects 2 when `r` is below 0.9 and 4 otherwise.
 */
const DEFAULT_SPAWN_WEIGHTS: readonly number[] = [0.9, 0.1];

/**
 * Builds the vanilla-equivalent rules: a freshly allocated, unfrozen
 * `RulesConfig` on every call, sharing no object — not the config, its `spawn`,
 * either spawn array, or its `merge` — with `DEFAULT_RULES_CONFIG` or an
 * earlier return value. The two merge members are this module's exported
 * functions; they hold no state and are shared, not copied.
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

/**
 * Freezes a config at every level: both spawn arrays, its `spawn`, its `merge`,
 * and the object itself.
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
 * default merge rules. No consumer can mutate the shared template;
 * `createDefaultRulesConfig()` returns a mutable copy.
 */
export const DEFAULT_RULES_CONFIG: RulesConfig = deepFreezeRulesConfig(
  /* @__PURE__ */ createDefaultRulesConfig(),
);
