// The six named engine hooks and the payload each one carries.
//
// A relic binds handlers by these names and src/engine/hook-bus.ts
// dispatches by them. Type declarations and one frozen tuple only: no
// dispatch, no registry, no state.
//
// Provenance of each dispatch point in the retired sources:
//   onStageStart  js/game_manager.js L35-L59   setup()
//   onBeforeMove  js/game_manager.js L134      terminal-state guard
//                 js/game_manager.js L113-L120 prepareTiles()
//   onMerge       js/game_manager.js L156-L170 merge branch
//   onSpawn       js/game_manager.js L69-L76   addRandomTile()
//                 js/game_manager.js L183      post-move spawn
//   onAfterMove   js/game_manager.js L185-L189 loss check, actuation
//   onStageEnd    no vanilla analogue
//
// Invariants of this module: it names no engine module other than the
// type-only imports below, reads no DOM, performs no I/O, consumes no
// randomness and reads no clock. Importing it declares types and freezes
// one array, and does nothing else.
//
// Decision log: docs/DECISION_LOG.md.

import type { RulesConfig } from '../config/rules-config';
import type { StageGoal } from '../config/stage-config';
import type { RngStreams } from '../rng/rng-streams';
import type { Grid } from './grid';
import type { Tile } from './tile';
import type { Direction, Position } from './types';

/* --------------------------------------------------------------------------
 * Hook names
 * ----------------------------------------------------------------------- */

/**
 * Every hook name, in the order one turn reaches them.
 *
 * Frozen at runtime and a readonly tuple at compile time: the single
 * declaration of the six names, and the canonical iteration order over
 * them.
 */
export const HOOK_NAMES = Object.freeze([
  'onStageStart',
  'onBeforeMove',
  'onMerge',
  'onSpawn',
  'onAfterMove',
  'onStageEnd',
] as const);

/**
 * Name of one hook.
 *
 * Derived from `HOOK_NAMES`, so that tuple is the only place the six
 * names are written.
 */
export type HookName = (typeof HOOK_NAMES)[number];

/* --------------------------------------------------------------------------
 * Payloads
 * ----------------------------------------------------------------------- */

/**
 * Payload of `onStageStart`, dispatched once as a stage's board is
 * prepared.
 *
 * Ported from js/game_manager.js L35-L59, `setup()`, which built a grid
 * at `this.size` (L47) or restored one at `previousState.grid.size`
 * (L40-L41) and carried no stage vocabulary of its own.
 *
 * `boardSize` is the reconciled edge length the stage's grid was built
 * at, which is the size the restored snapshot carried where one was
 * restored.
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
 * Ported from js/game_manager.js L134, the terminal-state guard
 * `if (this.isGameTerminated()) return;`, and L113-L120,
 * `prepareTiles()`.
 *
 * CANCELLABLE. `cancelled` is the only mutable payload member on any
 * hook: a handler may assign it, or return a payload carrying it as
 * `true`. Either withdraws the move, and a withdrawn move changes no
 * state at all — no tile moves, no merge resolves, no tile spawns, the
 * score does not change and nothing is committed.
 */
export interface BeforeMovePayload {
  /** Direction the move was requested in. */
  readonly direction: Direction;

  /** The live board the move would resolve on. */
  readonly board: Grid;

  /** Whether the move is withdrawn. `false` on dispatch. */
  cancelled: boolean;
}

/**
 * Payload of `onMerge`, dispatched once per merge, so a move that
 * resolves two merges dispatches it twice.
 *
 * Ported from js/game_manager.js L156-L170. `resultValue` is the value
 * L157 produced as `tile.value * 2` and `scoreDelta` is the amount L167
 * added as `merged.value`; the two are separate members here, so a
 * handler transforms either without the other. `source` and `target`
 * are the two live tiles L158 recorded as `mergedFrom = [tile, next]`.
 */
export interface MergePayload {
  /** The live tile that moved into the target's cell. */
  readonly source: Tile;

  /** The live tile already occupying the destination cell. */
  readonly target: Tile;

  /** Face value of the tile the merge yields. */
  readonly resultValue: number;

  /** Amount the merge adds to the score. */
  readonly scoreDelta: number;
}

/**
 * Payload of `onSpawn`, dispatched once per spawn attempt.
 *
 * Ported from js/game_manager.js L69-L76, `addRandomTile()`, which
 * L183 reached after a move that changed the board.
 *
 * `position` is ABSENT where no cell was available, which is the
 * boundary js/grid.js L37-L43 produced: its `if (cells.length)` at L40
 * has no else branch, so `randomAvailableCell` returns `undefined` on a
 * full board. A handler that returns the payload without a position
 * suppresses the spawn; one that transforms `value` or `position`
 * biases it.
 */
export interface SpawnPayload {
  /** Cell the tile spawns in. Absent when none is available. */
  readonly position?: Position | undefined;

  /** Face value of the spawning tile. */
  readonly value: number;
}

/**
 * Payload of `onAfterMove`, dispatched after a move has resolved and
 * before the state is committed.
 *
 * Ported from js/game_manager.js L185-L189, the loss check
 * `if (!this.movesAvailable()) { this.over = true; }` followed by
 * `this.actuate()`.
 */
export interface AfterMovePayload {
  /** Whether any tile changed cell. */
  readonly moved: boolean;

  /** The live board as the move left it. */
  readonly board: Grid;

  /** Accumulated score after the move. */
  readonly score: number;

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
 * NO VANILLA ANALOGUE. js/game_manager.js resolves no stage: it holds no
 * stage index, no goal and no end-of-stage branch. This payload is
 * introduced by the stage system and ports from nothing.
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
 * A handler bound to a name receives and returns that name's payload and
 * no other.
 */
export interface HookPayloadMap {
  onStageStart: StageStartPayload;
  onBeforeMove: BeforeMovePayload;
  onMerge: MergePayload;
  onSpawn: SpawnPayload;
  onAfterMove: AfterMovePayload;
  onStageEnd: StageEndPayload;
}

/* --------------------------------------------------------------------------
 * Handler context
 * ----------------------------------------------------------------------- */

/**
 * The live collaborators a dispatch carries to its handlers.
 *
 * Supplied per dispatch, so each member is the instance in force at that
 * moment. `config` is therefore read at use time and never captured at
 * module load: its `boardSize` is the value a board-mutating relic may
 * have changed during the run, and it is the value the win and loss
 * evaluations read. `grid` is likewise the board object in force, which
 * the engine replaces on every stage start and every restore.
 */
export interface HookEnvironment {
  /** The rules in force, read at use time. */
  readonly config: RulesConfig;

  /** The run's named seeded substreams, the only randomness available. */
  readonly rng: RngStreams;

  /** The live board, reached through its own public surface. */
  readonly grid: Grid;
}

/**
 * What a handler receives besides its payload: the live collaborators of
 * `HookEnvironment`, the identity of the dispatch, and the subscriber's
 * own state slot.
 *
 * Carries no bus and no logger: nothing on it re-enters dispatch, and
 * reporting is injected into src/engine/hook-bus.ts.
 */
export interface HookContext extends HookEnvironment {
  /** Correlation identifier of the run in progress. */
  readonly runId: string;

  /** Hook being dispatched. */
  readonly hook: HookName;

  /** Identifier of the subscriber whose handler is running. */
  readonly subscriberId: string;

  /** Zero-based position of that subscriber in pickup order. */
  readonly pickupOrder: number;

  /**
   * Charges the subscriber holds on entry. Absent on a subscriber that
   * carries no charge budget.
   */
  readonly charges?: number | undefined;

  /**
   * The subscriber's own state slot, mutable. Assigning it carries state
   * from one dispatch to the next: src/engine/hook-bus.ts writes the
   * value back onto the subscriber once the handler returns.
   */
  state: unknown;
}

/* --------------------------------------------------------------------------
 * Handlers
 * ----------------------------------------------------------------------- */

/**
 * A handler bound to one hook.
 *
 * The handler is given the payload as accumulated by the handlers
 * dispatched before it, and returns either a payload, which replaces the
 * accumulated one, or nothing, which leaves it as it stands. A handler
 * that only observes returns nothing.
 *
 * @param payload Payload accumulated so far.
 * @param context Live collaborators, the dispatch's identity and the
 *   subscriber's state slot.
 * @returns The transformed payload, or nothing to leave it unchanged.
 */
export type HookHandler<K extends HookName = HookName> = (
  payload: HookPayloadMap[K],
  context: HookContext,
) => HookPayloadMap[K] | void;

/**
 * The handler table a subscriber binds: `Partial<Record<HookName,
 * HookHandler>>` with every entry narrowed to its own hook's payload.
 *
 * Partial by construction — a subscriber binds the hooks it acts on and
 * omits the rest. This is the `hooks` member of the relic data shape.
 */
export type HookHandlerTable = {
  readonly [K in HookName]?: HookHandler<K>;
};

/**
 * One handler paired with the metadata a dispatch needs to invoke it.
 *
 * `pickupOrder` is assigned when the subscriber is taken on and is never
 * reassigned. `charges` is declared here and guarded in
 * src/engine/hook-bus.ts, never in a handler.
 */
export interface HookSubscription<K extends HookName = HookName> {
  /** Identifier of the subscriber the handler belongs to. */
  readonly subscriberId: string;

  /** Zero-based position of that subscriber in pickup order. */
  readonly pickupOrder: number;

  /** The handler to invoke. */
  readonly handler: HookHandler<K>;

  /**
   * Charges remaining. Absent on a subscriber with no charge budget,
   * which is never charge-guarded; present and at or below zero, the
   * handler is not invoked.
   */
  charges?: number | undefined;

  /** The subscriber's own state slot, carried through to the context. */
  state?: unknown;
}
