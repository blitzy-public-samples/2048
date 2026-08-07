// The six named engine hooks and the payload each one carries.
//
// A relic binds handlers by these names and src/engine/hook-bus.ts dispatches
// by them. Type declarations and one frozen tuple only: no dispatch, no
// registry, no state.
//
// This module reads no DOM, performs no I/O, consumes no randomness and reads
// no clock.

import type { RulesConfig } from '../config/rules-config';
import type { StageGoal } from '../config/stage-config';
import type {
  RngCursorMap,
  RngStream,
  RngStreams,
  StreamName,
} from '../rng/rng-streams';
import type { Grid } from './grid';
import type { Tile } from './tile';
import type {
  CorrelationId,
  Direction,
  Position,
  SerializedGrid,
} from './types';

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
  readonly stageIndex: number;
  readonly goal: StageGoal;

  /** Seed of the run in progress, exactly as supplied to the engine. */
  readonly seed: string;
  readonly boardSize: number;
}

/**
 * Payload of `onBeforeMove`, dispatched before a move is resolved.
 *
 * CANCELLABLE. `cancelled` is the only mutable payload member on any hook: a
 * handler may assign it, or return a payload carrying it as `true`. Either
 * withdraws the move, and a withdrawn move changes no state at all — no tile
 * moves, no merge resolves, no tile spawns, the score does not change and
 * nothing is committed.
 */
export interface BeforeMovePayload {
  readonly direction: Direction;
  readonly board: Grid;

  /** Whether the move is withdrawn. `false` on dispatch. */
  cancelled: boolean;
}

/**
 * Payload of `onMerge`, dispatched once per merge, so a move that resolves two
 * merges dispatches it twice.
 *
 * `resultValue` is the value the merge produces and `scoreDelta` the amount it
 * adds to the score; the two are separate members, so a handler transforms
 * either without the other. `source` and `target` are the two live tiles the
 * merged tile records in `mergedFrom`.
 */
export interface MergePayload {
  readonly source: Tile;
  readonly target: Tile;
  readonly resultValue: number;
  readonly scoreDelta: number;
}

/**
 * Payload of `onSpawn`, dispatched once a spawn cell is available.
 *
 * NOT DISPATCHED ON A FULL BOARD: the engine returns before this dispatch
 * when no cell is available, so a handler never sees the full-board case.
 *
 * `position` is therefore absent only where a handler returned the payload
 * without one, which suppresses the spawn; one that transforms `value` or
 * `position` biases it.
 */
export interface SpawnPayload {
  readonly position?: Position | undefined;
  readonly value: number;
}

export interface AfterMovePayload {
  readonly moved: boolean;
  readonly board: Grid;
  readonly score: number;
  readonly over: boolean;
  readonly won: boolean;

  /** Whether play is blocked pending an acknowledgement. */
  readonly terminated: boolean;
}

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
 * The randomness a handler draws from: the run's named substreams and
 * nothing else.
 *
 * The facade src/engine/hook-bus.ts builds over `HookEnvironment.rng` once
 * per dispatch and freezes, so a handler can take draws — which is how a
 * spawn-biasing relic stays deterministic — but cannot replace the
 * substream table for the handlers dispatched after it.
 */
export interface ReadonlyRngView {
  /** Seed of the run these substreams were derived from. */
  readonly seed: string;

  /**
   * Returns the substream registered under `name`.
   *
   * @param name Substream to address.
   * @returns The stable substream instance for that name.
   */
  stream(name: StreamName): RngStream;

  /**
   * Reads the current draw count of every named substream.
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
   * The subscriber's own state slot, mutable. Assigning it carries state from
   * one dispatch to the next: the bus writes the value back onto the
   * subscriber once the handler returns.
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
