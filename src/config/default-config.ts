/**
 * Vanilla-equivalent default rules: two merge rules, five values, one factory
 * and one frozen template. No value here is retuned from the behaviour the
 * pre-migration game shipped, and no rule is declared that it did not have.
 *
 * Mutability contract: `createDefaultRulesConfig` returns an unfrozen object
 * sharing no object with `DEFAULT_RULES_CONFIG` or with any earlier return
 * value, and `DEFAULT_RULES_CONFIG` is frozen at every level.
 * `snapshotRulesConfig()` and `restoreRulesConfig()` are the run-boundary pair:
 * the first takes a baseline of the live rules, the second writes that baseline
 * back through the SAME object every collaborator holds.
 *
 * This module reads no DOM and no storage, consumes no randomness and takes no
 * spawn draw: it declares the distribution the engine's seeded draw resolves
 * against.
 *
 * One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
 * this module's area enumerated:
 *   TR-DEFAULT-01  js/application.js L3    `DEFAULT_BOARD_SIZE`, the board-size
 *                                          literal
 *   TR-DEFAULT-02  js/game_manager.js L170 `winValue`
 *   TR-DEFAULT-03  js/game_manager.js L7   `startTiles`
 *   TR-DEFAULT-04  js/game_manager.js L71  `spawn.values` and `spawn.weights`
 *   TR-DEFAULT-05  js/game_manager.js L156 `defaultCanMerge`
 *   TR-DEFAULT-06  js/game_manager.js L157 `defaultProduceMergeValue`
 *   TR-DEFAULT-07  target-only row         `MAX_BOARD_SIZE` and
 *                                          `isSupportedBoardSize`
 *   TR-DEFAULT-08  target-only row         `createDefaultRulesConfig` and
 *                                          `DEFAULT_RULES_CONFIG`
 *   TR-DEFAULT-09  target-only row         `snapshotRulesConfig` and
 *                                          `restoreRulesConfig`, the run-scoped
 *                                          reset of the live rules
 *
 * Decisions behind this file, argued in docs/DECISION_LOG.md and named here
 * only so the construct can be found from the log:
 *   DL-DEFAULT-01  the five default values reproducing vanilla behaviour
 *                  exactly, so a Phase 1 board is comparable move for move
 *   DL-DEFAULT-02  `MAX_BOARD_SIZE` at 16, as the one board-edge ceiling every
 *                  allocating module measures against
 *   DL-DEFAULT-03  a factory returning an unfrozen config beside a deeply
 *                  frozen template
 *   DL-DEFAULT-04  the live rules being restored IN PLACE from a baseline at a
 *                  run boundary rather than replaced with a fresh object
 */

import type {
  MergePredicate,
  MergeProducer,
  MergeTileView,
  RulesConfig,
} from './rules-config.ts';

/**
 * The default merge predicate: a moving tile merges into the tile it has run
 * into when the two carry the same value and the target has not already merged
 * this turn. Reads `moving.value`, `target.value` and `target.mergedFrom`
 * only, and mutates neither operand.
 *
 * From js/game_manager.js L156, `next.value === tile.value &&
 * !next.mergedFrom`.
 */
export function defaultCanMerge(
  moving: MergeTileView,
  target: MergeTileView,
): boolean {
  return moving.value === target.value && !target.mergedFrom;
}

/**
 * The default merge producer: the merge of a pair yields double the moving
 * tile's value. Returns a face value only and constructs nothing.
 *
 * From js/game_manager.js L157, `new Tile(positions.next, tile.value * 2)`.
 */
export function defaultProduceMergeValue(
  moving: MergeTileView,
  _target: MergeTileView,
): number {
  return moving.value * 2;
}

/**
 * Default edge length of the square board, in cells. Traceability row.
 *
 * From js/application.js L3, the literal `4` handed to `new GameManager(...)`.
 */
export const DEFAULT_BOARD_SIZE = 4;

/**
 * Highest board edge length the product supports, in cells.
 *
 * src/engine/grid.ts allocates the size it is handed and does not test it:
 * every caller reaching it has already been through this ceiling.
 * src/engine/hook-bus.ts measures a payload's board size against the live
 * grid's own `size` instead, so the engine folder reads no constant from here.
 */
export const MAX_BOARD_SIZE = 16;

/**
 * Reports whether `value` is a board edge length the product supports: an
 * integer from 1 through `MAX_BOARD_SIZE`.
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
 * Default tile value that wins the game. How a tile value is compared against
 * it belongs to src/engine/terminal-state.ts, and the visual band above it to
 * src/theme/tile-ramp.ts.
 */
const DEFAULT_WIN_VALUE = 2048;

/** Default number of tiles the board opens with. */
const DEFAULT_START_TILES = 2;

/**
 * Default tile values a spawn draws from, paired with `DEFAULT_SPAWN_WEIGHTS`
 * by index in the order the selection convention walks; this order is not
 * reversed.
 */
const DEFAULT_SPAWN_VALUES: readonly number[] = [2, 4];

/**
 * Default selection probability of each entry of `DEFAULT_SPAWN_VALUES`, in
 * the same index order; the two members sum to 1.
 */
const DEFAULT_SPAWN_WEIGHTS: readonly number[] = [0.9, 0.1];

/**
 * Builds the vanilla-equivalent rules: a freshly allocated, unfrozen
 * `RulesConfig` on every call, sharing no object — not the config, its
 * `spawn`, either spawn array, or its `merge` — with `DEFAULT_RULES_CONFIG` or
 * an earlier return value. The two merge members are this module's exported
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
 * Copies a `RulesConfig` deeply enough to be a baseline: a fresh config, a fresh
 * `spawn` with fresh arrays and a fresh `merge`, sharing nothing mutable with
 * `config`. The two merge members are functions and are carried by reference,
 * which is what makes a restored baseline reinstate the SAME predicate object
 * the run opened with.
 *
 * Reads `config` and writes nothing.
 *
 * @param config Config to snapshot.
 * @returns The snapshot.
 */
export function snapshotRulesConfig(config: RulesConfig): RulesConfig {
  return {
    boardSize: config.boardSize,
    winValue: config.winValue,
    startTiles: config.startTiles,
    spawn: {
      values: config.spawn.values.slice(),
      weights: config.spawn.weights.slice(),
    },
    merge: { canMerge: config.merge.canMerge, produce: config.merge.produce },
  };
}

/**
 * Restores every mutable member of the LIVE rules object from a baseline,
 * IN PLACE.
 *
 * Identity is the whole point. `RulesConfig` is a single mutable object every
 * collaborator holds a reference to — the engine, the move resolver, the
 * terminal-state checks, the renderer, the hook bus's per-dispatch view and
 * `src/engine/board-effects.ts`, which is the only writer — so a run boundary
 * cannot hand out a replacement without reconstructing all of them. This writes
 * through the same `target`, the same `target.spawn` and the same `target.merge`,
 * and replaces the two spawn arrays with copies of the baseline's so a later
 * write to one cannot reach the baseline.
 *
 * The three members a relic effect can write — `boardSize`, `merge.canMerge` and
 * `spawn.weights` — are therefore all returned to the values the baseline holds,
 * which is what stops one run's mutations from being inherited by the next.
 *
 * @param target Live config to write.
 * @param baseline Values to restore, unmodified by the call.
 * @returns `target`, for chaining.
 */
export function restoreRulesConfig(
  target: RulesConfig,
  baseline: RulesConfig,
): RulesConfig {
  target.boardSize = baseline.boardSize;
  target.winValue = baseline.winValue;
  target.startTiles = baseline.startTiles;
  target.spawn.values = baseline.spawn.values.slice();
  target.spawn.weights = baseline.spawn.weights.slice();
  target.merge.canMerge = baseline.merge.canMerge;
  target.merge.produce = baseline.merge.produce;

  return target;
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
 * default merge rules.
 */
export const DEFAULT_RULES_CONFIG: RulesConfig = deepFreezeRulesConfig(
  /* @__PURE__ */ createDefaultRulesConfig(),
);
