// The six named engine hooks and the payload each one carries.
//
// A relic binds handlers by these names and src/engine/hook-bus.ts dispatches
// by them. Type declarations and one frozen tuple only: no dispatch, no
// registry, no state.
//
// This module reads no DOM, performs no I/O, consumes no randomness and reads
// no clock.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, and that document
// is delivered, so each ordinal below resolves to a row in it:
//   TR-HOOK-01  onStageStart  js/game_manager.js L35-L59   setup()
//   TR-HOOK-02  onBeforeMove  js/game_manager.js L134      terminal guard
//   TR-HOOK-03  onMerge       js/game_manager.js L156-L170 merge branch
//   TR-HOOK-04  onSpawn       js/game_manager.js L69-L76   addRandomTile()
//   TR-HOOK-05  onAfterMove   js/game_manager.js L185-L189 loss, actuation
//   TR-HOOK-06  onStageEnd    no vanilla analogue, target-only row
//
// One further row of the same matrix, target-only and owned here:
//   TR-EFFECT-04  the board-write vocabulary re-exported from this module, so
//                 a handler takes its context and its command types from one
//                 module
//
// Decisions behind this file, argued in docs/DECISION_LOG.md and named here
// only so the construct can be found from the log:
//   DL-HOOK-01  the exact six names AAP R2 mandates as the whole hook surface
//   DL-HOOK-02  the two payload families: `HookPayloadMap`, which a handler
//               receives with each live collaborator replaced by a
//               capability view, and `HookDispatchPayloadMap`, which the
//               engine dispatches with the live `Grid` and `Tile`
//   DL-HOOKBUS-07  the charge guard withholding ALL SIX hooks from an
//                  exhausted subscriber, with no hook exempted

import type { RulesConfig } from '../config/rules-config';
import type { StageGoal } from '../config/stage-config';
import type {
  RngCursorMap,
  RngStream,
  RngStreams,
  StreamName,
} from '../rng/rng-streams';
import type { BoardEffectQueue } from './board-effects';
import type { Grid } from './grid';
import type {
  CorrelationId,
  Direction,
  Position,
  SerializedGrid,
} from './types';
import type { Tile } from './tile';


/**
 * Every hook name, in canonical lifecycle order: the stage bracket first and
 * last, the four a move passes through between them. Frozen at runtime and a
 * readonly tuple at compile time, and the canonical iteration order over the
 * six.
 *
 * `onStageStart` and `onStageEnd` bracket a STAGE and a turn reaches neither.
 * The four a turn reaches, in the order it reaches them, are `onBeforeMove`,
 * `onMerge`, `onSpawn` and `onAfterMove`.
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
 * No hook is exempt from the charge guard: this module declares no exemption
 * set, and src/engine/hook-bus.ts withholds every one of the six hooks above
 * from a subscriber whose budget is spent, so a limited-charge relic stops
 * firing once exhausted (AAP R3, V6). Standing rules a relic's persisted
 * `state` slot records are reinstated by `applyStandingRelicRules` of
 * src/relics/relic-registry.ts on the rehydration path, never by dispatching to
 * an exhausted handler. `DL-HOOKBUS-07`.
 */

/**
 * Payload of `onStageStart`, dispatched once as a stage's board is prepared.
 *
 * `boardSize` is the reconciled edge length the stage's grid was built at,
 * which is the size the restored snapshot carried where one was restored.
 */
export interface StageStartPayload {
  /** TRANSFORMABLE: `goal` alone. */
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
 * `position` is therefore absent only where a handler returned the payload
 * without one, which suppresses the spawn; one that transforms `value` or
 * `position` biases it.
 */
export interface SpawnPayload {
  readonly position?: Position | undefined;
  readonly value: number;

  /**
   * How many tiles this spawn inserts. `1` on dispatch, which is the vanilla
   * count js/game_manager.js L183 produced.
   */
  readonly count?: number | undefined;
}

/**
 * Payload of `onAfterMove`, dispatched once a move has been resolved.
 *
 * TRANSFORMABLE: `score`, `over` and `won`. The engine adopts all three from
 * the payload this dispatch resolves to and emits exactly what it adopted.
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
 */
export interface HookDispatchPayloadMap {
  onStageStart: StageStartPayload;
  onBeforeMove: BeforeMoveDispatchPayload;
  onMerge: MergeDispatchPayload;
  onSpawn: SpawnPayload;
  onAfterMove: AfterMoveDispatchPayload;
  onStageEnd: StageEndPayload;
}

/** The live collaborators a dispatch carries to its handlers. */
export interface HookEnvironment {
  readonly config: RulesConfig;

  /** The run's named seeded substreams, the only randomness available. */
  readonly rng: RngStreams;
  readonly grid: Grid;
}

/** The rules a handler reads, with every member readonly. */
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
 * The board a handler reads: the query half of `Grid` and none of its writes.
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
   * Reports whether a cell holds no tile. A cell outside the lattice reads as
   * available, as js/grid.js L72-L74 did.
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
   * Lists the empty cells, x-outer and y-inner — the order the spawn position
   * draw resolves against.
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
 */
export interface ReadonlyTileView {
  /** Zero-based column the tile occupies, read at projection time. */
  readonly x: number;

  /** Zero-based row the tile occupies, read at projection time. */
  readonly y: number;

  /** Face value the tile carries, read at projection time. */
  readonly value: number;

  /**
   * The cell `savePosition` last recorded, as a fresh frozen pair, and `null`
   * where none was recorded.
   */
  readonly previousPosition: Position | null;
}

/**
 * The randomness a handler draws from: the run's named substreams and nothing
 * else.
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

/** The board-write vocabulary, RE-EXPORTED from where it is declared. */
export type {
  BoardEffect,
  BoardEffectRequest,
  BoardEffectQueue,
} from './board-effects';

/**
 * What a handler receives besides its payload: capability-limited views of the
 * three collaborators of `HookEnvironment`, the identity of the dispatch, and
 * the subscriber's own state slot.
 */
export interface HookContext {
  /** The rules in force, read at use time. */
  readonly config: ReadonlyRulesView;

  /** The run's named seeded substreams, the only randomness available. */
  readonly rng: ReadonlyRngView;

  /** The live board, reached through its query surface alone. */
  readonly grid: ReadonlyGridView;

  /**
   * The board and the rules a handler WRITES, as commands recorded now and
   * applied by the bus once this handler has returned and its return has
   * validated.
   *
   * TRANSACTIONAL, like `rng` and `state` beside it: the queue is opened per
   * handler and resolved with them, so a handler that records and then throws,
   * or whose return the bus refuses, changes neither the board nor the rules.
   * Every member reports whether the command was accepted and none throws.
   */
  readonly effects: BoardEffectQueue;

  /**
   * Correlation identifier of the run in progress, injected into the bus and
   * carried verbatim.
   */
  readonly correlationId: CorrelationId;

  /** Hook being dispatched. */
  readonly hook: HookName;
  readonly subscriberId: string;
  readonly pickupOrder: number;
  readonly charges?: number | undefined;

  /**
   * Requests that a charge be spent for this dispatch, because the effect the
   * handler was invoked for has been APPLIED.
   *
   * THE HANDLER ASKS AND THE BUS DECIDES. AAP Contract 2 places the charge
   * guard and the decrement in src/engine/hook-bus.ts, so no handler reads,
   * compares or writes a budget; this is the signal that a dispatch applied the
   * effect it was invoked for. Nothing in the bus is relic-specific. Decision
   * DL-HOOKBUS-01.
   *
   * A HANDLER THAT DOES NOT ASK PAYS NOTHING, whatever else it did: a
   * transformed payload member and a written board command each cost nothing on
   * their own. A stage-start rule installation writes a command and costs
   * nothing.
   *
   * FULFILLED WITH THE REST OF THE TRANSACTION. The request is recorded, not
   * applied: the bus spends the charge only once the handler has returned and
   * its return has been ACCEPTED, in the same commit as the state slot, the
   * randomness and the board effects. A handler that requests a charge and then
   * throws, or whose return the bus refuses, spends nothing.
   *
   * ONE POOL PER SUBSCRIBER, SHARED ACROSS ITS HOOKS. `temporal-anchor` binds
   * two hooks and draws on one budget, so a charge spent on `onAfterMove`
   * leaves fewer for `onBeforeMove`.
   *
   * A subscriber carrying no budget is unlimited, and a request against it
   * spends nothing and is not an error. Repeated requests within one dispatch
   * accumulate, so a handler that triggered twice may ask twice.
   *
   * @param amount Charges to spend. Rounded towards zero, clamped to zero
   *   from below, clamped to the budget the subscriber holds, and defaulting
   *   to `1`.
   * @returns Whether a charge will be spent: `false` for a subscriber
   *   carrying no budget, for an amount that rounds to zero, and for a call
   *   made after the handler has returned, which belongs to no transaction.
   */
  readonly spendCharge: (amount?: number) => boolean;

  /**
   * The subscriber's own state slot, mutable, and a COPY of the value the bus
   * holds rather than that value itself.
   */
  state: unknown;
}

/**
 * A handler bound to one hook.
 *
 * The handler is given the payload as accumulated by the handlers dispatched
 * before it, and returns either a payload, which replaces the accumulated one,
 * or nothing, which leaves it as it stands.
 */
export type HookHandler<K extends HookName = HookName> = (
  payload: HookPayloadMap[K],
  context: HookContext,
) => HookPayloadMap[K] | void;

/**
 * The handler table a subscriber binds, with every entry narrowed to its own
 * hook's payload. Partial by construction — a subscriber binds the hooks it
 * acts on and omits the rest.
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
  readonly subscriberId: string;
  readonly pickupOrder: number;
  readonly handler: HookHandler<K>;

  /**
   * Charges remaining as at the call that returned this snapshot. Absent on a
   * subscriber with no charge budget, which is never charge-guarded; present
   * and at or below zero, the handler is not invoked.
   */
  readonly charges?: number | undefined;

  /**
   * The subscriber's own state slot as at the call that returned this
   * snapshot, carried through to the context on each dispatch.
   */
  readonly state?: unknown;
}
