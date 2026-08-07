// The six named engine hooks and the payload each one carries.
//
// A relic binds handlers by these names and src/engine/hook-bus.ts dispatches
// by them. Type declarations and one frozen tuple only: no dispatch, no
// registry, no state.
//
// This module reads no DOM, performs no I/O, consumes no randomness and reads
// no clock.
//
// traceability row of docs/TRACEABILITY_MATRIX.md apiece:
//   TR-HOOK-01  onStageStart  js/game_manager.js L35-L59   setup()
//   TR-HOOK-02  onBeforeMove  js/game_manager.js L134      terminal guard
//   TR-HOOK-03  onMerge       js/game_manager.js L156-L170 merge branch
//   TR-HOOK-04  onSpawn       js/game_manager.js L69-L76   addRandomTile()
//   TR-HOOK-05  onAfterMove   js/game_manager.js L185-L189 loss, actuation
//   TR-HOOK-06  onStageEnd    no vanilla analogue
// Decisions behind this file: DL-HOOK-01, the exact six names AAP R2
// mandates as the whole hook surface, and DL-HOOK-02, the live

import type { RulesConfig } from '../config/rules-config';
import type { StageGoal } from '../config/stage-config';
import type {
  RngCursorMap,
  RngStream,
  RngStreams,
  StreamName,
} from '../rng/rng-streams';
import type { Grid } from './grid';
import type {
  CorrelationId,
  Direction,
  Position,
  SerializedGrid,
} from './types';
import type { Tile } from './tile';


/**
 * Every hook name, in the order one turn reaches them. Frozen at runtime and a
 * readonly tuple at compile time, and the canonical iteration order over the
 * six.
 */
export const HOOK_NAMES = Object.freeze([
  'onStageStart',
  'onBeforeMove',
  'onMerge',
  'onSpawn',
  'onAfterMove',
  'onStageEnd',
] as const);

export type HookName = (typeof HOOK_NAMES)[number];

/**
 * Payload of `onStageStart`, dispatched once as a stage's board is prepared.
 *
 * `boardSize` is the reconciled edge length the stage's grid was built at,
 * which is the size the restored snapshot carried where one was restored.
 */
export interface StageStartPayload {
  /**
   * TRANSFORMABLE: `goal` alone. INVARIANT: `stageIndex`, `seed` and
   * `boardSize`, each of which the bus refuses a return that changes.
   */
  readonly stageIndex: number;

  /**
   * Goal the stage RESOLVES against: the engine adopts the goal this payload
   * carries once every handler has run, and emits it on `stage:start`.
   */
  readonly goal: StageGoal;

  /** Seed of the run in progress, exactly as supplied to the engine. */
  readonly seed: string;
  readonly boardSize: number;
}

/**
 * Payload of `onBeforeMove`, dispatched before a move is resolved.
 *
 * TRANSFORMABLE: `direction` and `cancelled`. INVARIANT: `board`, which must
 * be returned as the same object it arrived as.
 *
 * CANCELLABLE. `cancelled` is the only mutable payload member on any hook: a
 * handler may assign it, or return a payload carrying it as `true`. Either
 * withdraws the move, and a withdrawn move changes no state at all — no tile
 * moves, no merge resolves, no tile spawns, the score does not change and
 * nothing is committed.
 *
 * `direction` is the direction the move RESOLVES in: the engine executes the
 * direction this payload carries once every handler has run, so a handler
 * that returns another one redirects the move rather than only relabelling
 * it.
 *
 * `board` is the capability view of `ReadonlyGridView`, not the live `Grid`.
 */
export interface BeforeMovePayload {
  readonly direction: Direction;
  readonly board: ReadonlyGridView;

  /** Whether the move is withdrawn. `false` on dispatch. */
  cancelled: boolean;
}

/**
 * One of the two tiles a merge consumed, as the merge payload carries it: its
 * cell and its face value, and nothing writable.
 *
 * A PROJECTION, NOT THE TILE. The merge branch builds it and freezes it before
 * the dispatch, so a handler reads which tiles merged and where without
 * holding either of them. Previously the payload carried the live `Tile`
 * objects, which the merge branch was about to write to the board: a handler
 * could set `source.value` and then throw, and no rollback could undo that
 * write because the object was the board's own. A handler changes the merge
 * through `resultValue` and `scoreDelta`, which the resolver reads back.
 */
export interface MergeTileView {
  readonly x: number;
  readonly y: number;
  readonly value: number;
}

/**
 * Payload of `onMerge`, dispatched once per merge, so a move that resolves two
 * merges dispatches it twice.
 *
 * TRANSFORMABLE: `resultValue` and `scoreDelta`. INVARIANT: `source` and
 * `target`.
 *
 * `resultValue` is the value the merge produces and `scoreDelta` the amount it
 * adds to the score; the two are separate members, so a handler transforms
 * either without the other. `source` and `target` are the capability views of
 * the two tiles the merged tile records in `mergedFrom`, not those live tiles.
 */
export interface MergePayload {
  readonly source: ReadonlyTileView;
  readonly target: ReadonlyTileView;
  readonly resultValue: number;
  readonly scoreDelta: number;
}

/**
 * Payload of `onSpawn`, dispatched once a spawn cell is available.
 *
 * TRANSFORMABLE: `position` and `value`. There is no invariant member.
 *
 * NOT DISPATCHED ON A FULL BOARD, AND NOT THE ATTEMPT BOUNDARY. The engine
 * returns before this dispatch when no cell is available, so a handler never
 * sees the full-board case. That early return is what keeps a full board free
 * of draws from either substream — the boundary js/grid.js L37-L43 expressed
 * by returning no cell — and it is deliberate rather than an oversight, so
 * spawn ATTEMPTS are not countable from this dispatch. The engine's own
 * `engine.spawn.attempt` counter, raised on entry to the spawn at
 * js/game_manager.js L69, is the one authoritative attempt boundary.
 *
 * `position` is therefore absent only where a handler returned the payload
 * without one, which suppresses the spawn; one that transforms `value` or
 * `position` biases it.
 */
export interface SpawnPayload {
  readonly position?: Position | undefined;
  readonly value: number;
}

/**
 * Payload of `onAfterMove`, dispatched once a move has been resolved.
 *
 * TRANSFORMABLE: `score`, `over` and `won`. The engine adopts all three from
 * the payload this dispatch resolves to and emits exactly what it adopted.
 *
 * INVARIANT: `board` and `moved`. `terminated` is DERIVED — the engine
 * recomputes it from the adopted `over` and `won` rather than reading it back,
 * so a handler cannot leave a `terminated` that contradicts them.
 *
 * `board` is the capability view of `ReadonlyGridView`, not the live `Grid`.
 */
export interface AfterMovePayload {
  readonly moved: boolean;
  readonly board: ReadonlyGridView;
  readonly score: number;
  readonly over: boolean;
  readonly won: boolean;

  /** Whether play is blocked pending an acknowledgement. */
  readonly terminated: boolean;
}

/**
 * Payload of `onStageEnd`, dispatched as a stage resolves.
 *
 * TRANSFORMABLE: `cleared` and `score`. INVARIANT: `stageIndex`. The engine
 * adopts the resolved `score` before it commits, so `stage:end` and the
 * `state:commit` that follows it carry the same number.
 */
export interface StageEndPayload {
  readonly stageIndex: number;
  readonly cleared: boolean;
  readonly score: number;
}

/**
 * The payload type each hook name carries. A handler bound to a name receives
 * and returns that name's payload and no other.
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
 * Dispatch-input payloads
 * ----------------------------------------------------------------------- */

/**
 * `onBeforeMove` as the ENGINE hands it to the bus: the live board rather than
 * the view. src/engine/hook-bus.ts substitutes the view before the first
 * handler is invoked.
 */
export interface BeforeMoveDispatchPayload {
  readonly direction: Direction;
  readonly board: Grid;
  cancelled: boolean;
}

/**
 * `onMerge` as the merge branch hands it to the bus: the two live tiles rather
 * than their views. src/engine/hook-bus.ts substitutes the views before the
 * first handler is invoked.
 */
export interface MergeDispatchPayload {
  readonly source: Tile;
  readonly target: Tile;
  readonly resultValue: number;
  readonly scoreDelta: number;
}

/**
 * `onAfterMove` as the ENGINE hands it to the bus: the live board rather than
 * the view. src/engine/hook-bus.ts substitutes the view before the first
 * handler is invoked.
 */
export interface AfterMoveDispatchPayload {
  readonly moved: boolean;
  readonly board: Grid;
  readonly score: number;
  readonly over: boolean;
  readonly won: boolean;
  readonly terminated: boolean;
}

/**
 * The payload type each hook name is DISPATCHED WITH, which differs from
 * `HookPayloadMap` for the three hooks carrying a live engine object: the
 * caller supplies the live `Grid` or the live `Tile` pair and the bus hands
 * handlers the frozen capability views of `HookPayloadMap` in their place.
 *
 * The three plain-data hooks carry the same type in both maps, because a
 * handler cannot reach engine state through them at all.
 */
export interface HookDispatchPayloadMap {
  onStageStart: StageStartPayload;
  onBeforeMove: BeforeMoveDispatchPayload;
  onMerge: MergeDispatchPayload;
  onSpawn: SpawnPayload;
  onAfterMove: AfterMoveDispatchPayload;
  onStageEnd: StageEndPayload;
}

/**
 * The live collaborators a dispatch carries to its handlers.
 *
 * Supplied per dispatch, so each member is the instance in force at that
 * moment. `config` is therefore read at use time and never captured at module
 * load: its `boardSize` is the value a board-mutating relic may have changed
 * during the run, and it is the value the win and loss evaluations read.
 * `grid` is likewise the board object in force, which the engine replaces on
 * every stage start and every restore.
 */
export interface HookEnvironment {
  readonly config: RulesConfig;

  /** The run's named seeded substreams, the only randomness available. */
  readonly rng: RngStreams;
  readonly grid: Grid;
}

/* --------------------------------------------------------------------------
 * Capability-limited collaborator views
 * ----------------------------------------------------------------------- */

/**
 * The rules a handler reads, with every member readonly.
 *
 * The projection src/engine/hook-bus.ts builds from `HookEnvironment.config`
 * once per dispatch and freezes. Structurally a `RulesConfig` with nothing
 * writable: a handler reads the rule in force — including `boardSize`,
 * which a board-mutating relic changes during the run — and changes the
 * run's rules through the payload it returns rather than by writing here.
 */
export interface ReadonlyRulesView {
  /** Edge length of the square board, in cells. */
  readonly boardSize: number;

  /** Tile value that wins the game. */
  readonly winValue: number;

  /** How many tiles are inserted when a stage begins. */
  readonly startTiles: number;

  /** Distribution a newly spawned tile's value is drawn from. */
  readonly spawn: {
    /** Tile values that can be spawned, in selection-walk order. */
    readonly values: readonly number[];

    /** Selection probability of each entry of `values`. */
    readonly weights: readonly number[];
  };

  /** Rule deciding which tiles merge and what value the merge yields. */
  readonly merge: {
    /** Whether a given pair of tiles merges. */
    readonly canMerge: RulesConfig['merge']['canMerge'];

    /** Face value the merge of a given pair yields. */
    readonly produce: RulesConfig['merge']['produce'];
  };
}

/**
 * The board a handler reads: the query half of `Grid` and none of its
 * writes.
 *
 * The facade src/engine/hook-bus.ts builds over the live board once per
 * dispatch and freezes. Reads are live — they resolve against the board in
 * force at the moment they are called — while `insertTile`, `removeTile`,
 * the `cells` matrix and the live `Tile` objects are all absent, so a
 * handler cannot rewrite the board out from under the turn that dispatched
 * it. `cellValue` is what stands in for `cellContent`: the face value of a
 * cell rather than the mutable tile occupying it.
 */
export interface ReadonlyGridView {
  /** Edge length in cells, read at call time. */
  readonly size: number;

  /**
   * Reports whether a position lies inside the lattice.
   *
   * @param position Position to test.
   * @returns `true` when both coordinates are within `[0, size)`.
   */
  withinBounds(position: Position): boolean;

  /**
   * Reports whether a cell holds no tile. A cell outside the lattice
   * reads as available, as js/grid.js L72-L74 did.
   *
   * @param cell Cell to test.
   * @returns `true` when the cell holds no tile.
   */
  cellAvailable(cell: Position): boolean;

  /**
   * Reports whether a cell holds a tile.
   *
   * @param cell Cell to test.
   * @returns `true` when the cell holds a tile.
   */
  cellOccupied(cell: Position): boolean;

  /**
   * Reads the face value a cell holds.
   *
   * @param cell Cell to read.
   * @returns The value, or `null` where the cell is empty or lies outside
   *   the lattice.
   */
  cellValue(cell: Position): number | null;

  /**
   * Lists the empty cells, x-outer and y-inner — the order the spawn
   * position draw resolves against.
   *
   * @returns A fresh array of fresh coordinates on each call.
   */
  availableCells(): Position[];

  /**
   * Reports whether any cell is empty.
   *
   * @returns `true` when at least one cell is empty.
   */
  cellsAvailable(): boolean;

  /**
   * Projects the lattice to its persisted form.
   *
   * @returns A fresh plain object; mutating it does not reach the board.
   */
  serialize(): SerializedGrid;
}

/**
 * One tile a handler reads: its cell, its face value and the cell it came
 * from, with nothing writable and nothing reachable through it.
 *
 * The projection src/engine/hook-bus.ts builds over a live `Tile` once per
 * dispatch and freezes. `savePosition`, `updatePosition` and `mergedFrom` are
 * all absent: the first two write the tile, and the third holds two more live
 * tiles, so exposing any of them would hand a handler the board's own objects
 * back. A handler that throws therefore cannot leave a tile moved, revalued
 * or re-parented behind it.
 */
export interface ReadonlyTileView {
  /** Zero-based column the tile occupies, read at projection time. */
  readonly x: number;

  /** Zero-based row the tile occupies, read at projection time. */
  readonly y: number;

  /** Face value the tile carries, read at projection time. */
  readonly value: number;

  /**
   * The cell `savePosition()` last recorded, as a fresh frozen pair, and
   * `null` where none was recorded.
   */
  readonly previousPosition: Position | null;
}

/**
 * The randomness a handler draws from: the run's named substreams and
 * nothing else.
 *
 * TRANSACTIONAL. The facade src/engine/hook-bus.ts builds is opened per
 * HANDLER and frozen, and `stream` hands back a FORK of the named substream
 * standing exactly where the substream stands. A handler can therefore take
 * draws — which is how a spawn-biasing relic stays deterministic — while the
 * run's own substreams move only once the handler has returned and its return
 * has been accepted. A handler that draws and then throws, or whose return the
 * bus refuses, consumes no randomness: the fork is discarded and the sequence
 * the engine and every later handler read is the sequence they would have read
 * had the handler never run. The substream table itself cannot be replaced
 * through the facade.
 */
export interface ReadonlyRngView {
  /** Seed of the run these substreams were derived from. */
  readonly seed: string;

  /**
   * Returns this handler's fork of the substream registered under `name`.
   *
   * Memoised per handler, so addressing one name twice within one dispatch
   * yields one fork and a cursor that accounts every draw once.
   *
   * @param name Substream to address.
   * @returns The handler's fork of that substream.
   */
  stream(name: StreamName): RngStream;

  /**
   * Reads the current draw count of every named substream: this handler's own
   * position for a substream it has drawn from, and the run's position for the
   * rest.
   *
   * @returns A fresh total cursor map; consumes no draw.
   */
  snapshotCursors(): RngCursorMap;
}

/**
 * What a handler receives besides its payload: capability-limited views of
 * the three collaborators of `HookEnvironment`, the identity of the
 * dispatch, and the subscriber's own state slot.
 *
 * Carries no bus and no logger: nothing on it re-enters dispatch, and
 * reporting is injected into src/engine/hook-bus.ts. The three
 * collaborators are the frozen views above rather than the live objects,
 * so a handler that throws cannot leave the rules, the board or the
 * substream table changed behind it.
 *
 * EVERYTHING ON IT IS TRANSACTIONAL. The three views are read-only, the
 * randomness view is per handler and commits only on success, and `state`
 * below is a full copy of the bus's slot. A handler that throws therefore
 * leaves NOTHING behind: not a payload member, not a nested state member, not
 * a tile, and not a draw.
 */
export interface HookContext {
  /** The rules in force, read at use time. */
  readonly config: ReadonlyRulesView;

  /** The run's named seeded substreams, the only randomness available. */
  readonly rng: ReadonlyRngView;

  /** The live board, reached through its query surface alone. */
  readonly grid: ReadonlyGridView;

  /**
   * Correlation identifier of the run in progress, injected into the bus
   * and carried verbatim. Named `correlationId` because that is what it
   * is: the run instance identifier `RunState.runId` in
   * src/run/run-state.ts is a different value with a different purpose,
   * and the two were previously conflated under one name.
   */
  readonly correlationId: CorrelationId;

  /** Hook being dispatched. */
  readonly hook: HookName;
  readonly subscriberId: string;
  readonly pickupOrder: number;
  readonly charges?: number | undefined;

  /**
   * The subscriber's own state slot, mutable, and a COPY of the value the bus
   * holds rather than that value itself.
   *
   * Assigning it — or writing into it at any depth — carries state from one
   * dispatch to the next: the bus copies what it finds here back onto the
   * subscriber once the handler has returned and its return has been accepted.
   * Because the slot is a copy on the way in and a copy on the way out, a
   * handler that writes a nested member and then throws leaves the bus's slot
   * exactly as it was; the copy the handler wrote into is discarded with the
   * rest of the transaction.
   *
   * JSON DATA ONLY, which is what `Relic.state` declares: a function, a
   * symbol or a `bigint` written here does not survive the copy, for the same
   * reason it would not survive the run envelope's serialisation.
   */
  state: unknown;
}

/**
 * A handler bound to one hook.
 *
 * The handler is given the payload as accumulated by the handlers dispatched
 * before it, and returns either a payload, which replaces the accumulated
 * one, or nothing, which leaves it as it stands.
 */
export type HookHandler<K extends HookName = HookName> = (
  payload: HookPayloadMap[K],
  context: HookContext,
) => HookPayloadMap[K] | void;

/**
 * The handler table a subscriber binds, with every entry narrowed to its own
 * hook's payload. Partial by construction — a subscriber binds the hooks it
 * acts on and omits the rest. This is the `hooks` member of the relic data
 * shape.
 */
export type HookHandlerTable = {
  readonly [K in HookName]?: HookHandler<K>;
};

/**
 * One handler paired with the metadata a dispatch needs to invoke it.
 *
 * A READ-ONLY SNAPSHOT. Every member is readonly, and
 * src/engine/hook-bus.ts freezes each object it returns: the bus owns
 * `charges` and `state`, and a caller reads them here rather than writing
 * them. `consumeCharge` on the bus is the one path that changes a charge
 * budget, and a handler's own `HookContext.state` slot is the one path
 * that changes a state slot.
 *
 * `pickupOrder` is assigned when the subscriber is taken on and is never
 * reassigned. `charges` is declared here and guarded in
 * src/engine/hook-bus.ts, never in a handler.
 */
export interface HookSubscription<K extends HookName = HookName> {
  readonly subscriberId: string;
  readonly pickupOrder: number;
  readonly handler: HookHandler<K>;

  /**
   * Charges remaining as at the call that returned this snapshot. Absent
   * on a subscriber with no charge budget, which is never charge-guarded;
   * present and at or below zero, the handler is not invoked.
   */
  readonly charges?: number | undefined;

  /**
   * The subscriber's own state slot as at the call that returned this
   * snapshot, carried through to the context on each dispatch.
   */
  readonly state?: unknown;
}
