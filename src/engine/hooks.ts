// The six named engine hooks and the payload each one carries.
//
// The hook names are the six the feature specification fixes and are
// frozen: `onStageStart`, `onBeforeMove`, `onMerge`, `onSpawn`,
// `onAfterMove`, `onStageEnd`. A relic binds handlers by these names and
// src/engine/hook-bus.ts dispatches by them.
//
// Provenance of each dispatch point in the retired sources:
//   onStageStart  js/game_manager.js L35-L59  setup()
//   onBeforeMove  js/game_manager.js L134     terminal-state guard
//                 js/game_manager.js L113-L120 prepareTiles()
//   onMerge       js/game_manager.js L156-L170 merge branch
//   onSpawn       js/game_manager.js L69-L76   addRandomTile()
//                 js/game_manager.js L183      post-move spawn
//   onAfterMove   js/game_manager.js L185-L189 loss check and actuation
//   onStageEnd    no vanilla analogue
//
// Invariants of this module: it names no sibling engine module other than
// the type-only imports below, reads no DOM, performs no I/O, consumes no
// randomness and reads no clock. Importing it defines types and freezes
// one array, and does nothing else.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import type { StageGoal } from '../config/stage-config';
import type { Direction, Position } from './types';

/* --------------------------------------------------------------------------
 * Hook names
 * ----------------------------------------------------------------------- */

/**
 * Every hook name, in dispatch order across one turn.
 *
 * The order of this tuple is the order a turn reaches the hooks, and it
 * is the order src/engine/hook-bus.ts reports counters in. It is not the
 * order handlers of one hook run in; that order is pickup order and is
 * owned by the bus.
 */
export const HOOK_NAMES = [
  'onStageStart',
  'onBeforeMove',
  'onMerge',
  'onSpawn',
  'onAfterMove',
  'onStageEnd',
] as const;

/**
 * Union of the names in `HOOK_NAMES`.
 *
 * Derived from the tuple so it stays the single declaration of the six
 * names.
 */
export type HookName = (typeof HOOK_NAMES)[number];

/* --------------------------------------------------------------------------
 * Payloads
 * ----------------------------------------------------------------------- */

/**
 * Payload of `onStageStart`, dispatched once as a stage's board is
 * prepared.
 *
 * `boardSize` is the reconciled size the stage's grid was built at,
 * which is the size a restored snapshot carried where one was restored.
 */
export interface StageStartPayload {
  /** Zero-based index of the stage beginning. */
  readonly stageIndex: number;

  /** The stage's clear condition, carried verbatim. */
  readonly goal: StageGoal;

  /** Seed of the run in progress, exactly as supplied to the engine. */
  readonly seed: string;

  /** Edge length in cells of the grid the stage begins on. */
  readonly boardSize: number;
}

/**
 * Payload of `onBeforeMove`, dispatched before a move is resolved.
 *
 * The only cancellable payload: a handler that returns this payload with
 * `cancelled` set to `true` withdraws the move, and the turn ends with
 * no state change. `direction` is carried for inspection and is not
 * rewritten by the engine.
 */
export interface BeforeMovePayload {
  /** Direction the move was requested in. */
  readonly direction: Direction;

  /** Edge length in cells of the board the move would resolve on. */
  readonly boardSize: number;

  /** Score before the move. */
  readonly score: number;

  /** Whether the move is withdrawn. `false` on dispatch. */
  readonly cancelled: boolean;
}

/**
 * Payload of `onMerge`, dispatched once per merge.
 *
 * Two merges in one move dispatch this hook twice. `resultValue` and
 * `scoreDelta` are separable: the engine inserts a tile of
 * `resultValue` and adds `scoreDelta` to the score, so a handler can
 * change either without the other.
 *
 * Ported from js/game_manager.js L156-L170, where the produced value and
 * the score addition were the same expression (`merged.value`).
 */
export interface MergePayload {
  /** Value of the tile that moved into the target's cell. */
  readonly sourceValue: number;

  /** Value of the tile already occupying the destination cell. */
  readonly targetValue: number;

  /** Cell the merged tile occupies. */
  readonly position: Position;

  /** Face value of the tile the merge yields. */
  readonly resultValue: number;

  /** Amount the merge adds to the score. */
  readonly scoreDelta: number;
}

/**
 * Payload of `onSpawn`, dispatched once per spawn attempt.
 *
 * `position` is `null` where no cell was available, which is the
 * boundary js/grid.js L37-L43 expressed by returning `undefined` from
 * `randomAvailableCell` on a full board. A handler that returns
 * `position: null` suppresses the spawn.
 */
export interface SpawnPayload {
  /** Cell the tile spawns in, or `null` when none is available. */
  readonly position: Position | null;

  /** Face value of the spawning tile. */
  readonly value: number;

  /** Cells that were available when the draw was taken. */
  readonly availableCells: number;
}

/**
 * Payload of `onAfterMove`, dispatched after a move has been resolved
 * and before the state is committed.
 *
 * Ported from the post-move branch at js/game_manager.js L182-L190.
 */
export interface AfterMovePayload {
  /** Direction the move resolved in. */
  readonly direction: Direction;

  /** Whether any tile changed cell. */
  readonly moved: boolean;

  /** Score after the move. */
  readonly score: number;

  /** Amount the move added to the score. */
  readonly scoreDelta: number;

  /** Highest tile value on the board after the move. */
  readonly highestTileValue: number;

  /** Whether the game is lost. */
  readonly over: boolean;

  /** Whether the win value has been reached. */
  readonly won: boolean;

  /** Whether play is blocked pending an acknowledgement. */
  readonly terminated: boolean;
}

/**
 * Payload of `onStageEnd`, dispatched once a stage is resolved.
 *
 * Has no vanilla analogue.
 */
export interface StageEndPayload {
  /** Zero-based index of the stage that ended. */
  readonly stageIndex: number;

  /** Whether the stage's goal was met. */
  readonly cleared: boolean;

  /** Score at the moment the stage ended. */
  readonly score: number;
}

/* --------------------------------------------------------------------------
 * Name-to-payload map
 * ----------------------------------------------------------------------- */

/**
 * The payload type each hook name carries.
 *
 * `HookBus.dispatch` is keyed by this map, so a handler bound to a name
 * receives and returns that name's payload and no other.
 */
export interface HookPayloadMap {
  onStageStart: StageStartPayload;
  onBeforeMove: BeforeMovePayload;
  onMerge: MergePayload;
  onSpawn: SpawnPayload;
  onAfterMove: AfterMovePayload;
  onStageEnd: StageEndPayload;
}

/**
 * A handler bound to one hook.
 *
 * COMPOUNDING PROTOCOL
 *   The handler receives the payload accumulated by every handler
 *   dispatched before it, and returns either a payload — which the next
 *   handler receives — or `undefined`, which leaves the accumulated
 *   payload as it stands. A handler that only observes returns nothing.
 *
 * @param payload Payload accumulated so far.
 * @param context Identity of the dispatch in progress.
 * @returns The transformed payload, or `undefined` to leave it
 *   unchanged.
 */
export type HookHandler<K extends HookName = HookName> = (
  payload: HookPayloadMap[K],
  context: HookDispatchContext,
) => HookPayloadMap[K] | undefined | void;

/**
 * The handler table a subscriber binds.
 *
 * Partial by construction: a subscriber binds the hooks it acts on and
 * omits the rest. This is the `hooks` member of the relic data shape.
 */
export type HookHandlerTable = {
  readonly [K in HookName]?: HookHandler<K>;
};

/**
 * What a handler is told about the dispatch it is running inside.
 *
 * Carries identity only: no engine reference, no grid and no method a
 * handler could re-enter the bus through.
 */
export interface HookDispatchContext {
  /** Hook being dispatched. */
  readonly hook: HookName;

  /** Identifier of the subscriber whose handler is running. */
  readonly subscriberId: string;

  /** Correlation identifier of the run in progress. */
  readonly runId: string;

  /**
   * Charges the subscriber holds on entry, or `undefined` when it
   * carries no charge budget.
   */
  readonly charges: number | undefined;

  /** Zero-based position of this subscriber in pickup order. */
  readonly pickupIndex: number;
}
