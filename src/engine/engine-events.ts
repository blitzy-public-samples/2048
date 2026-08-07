// The typed engine event contract and its emitter.
//
// Successor to the single push call at js/game_manager.js L91-L97, where the
// manager handed the board and five metadata members to a view it held a
// reference to. `state:commit` carries those same six values and adds the
// stage and relic slices; this module names no view and holds no reference
// to one.
//
// OBSERVATION ONLY. An event listener is an OBSERVER: the payload it
// receives is a detached, deeply frozen projection of the engine's state at
// the moment of emission, so nothing a listener does — and nothing it writes
// — can reach the engine, the board, a tile, or the turn that emitted. The
// path that TRANSFORMS engine state is the hook bus of
// src/engine/hook-bus.ts, whose handlers are dispatched separately and whose
// returns the engine reads back. Previously the six event payloads aliased
// the mutable hook payloads and were emitted by reference, which let an
// ordinary listener write `move:before.cancelled` and withdraw a move; the
// payload types below are declared here instead, readonly throughout, and
// `emit` projects before it walks its listeners.
//
// Each event payload corresponds member for member to the hook payload of
// the same stage in src/engine/hooks.ts, with every live collaborator
// replaced by its projection. Only `state:commit` corresponds to no hook.
//
// docs/TRACEABILITY_MATRIX.md apiece:
//   TR-EVENT-01  stage:start   js/game_manager.js L35-L59   setup()
//   TR-EVENT-02  move:before   js/game_manager.js L130-L143 move() entry
//   TR-EVENT-03  tile:merge    js/game_manager.js L156-L170 merge branch
//   TR-EVENT-04  tile:spawn    js/game_manager.js L69-L76   addRandomTile()
//   TR-EVENT-05  move:after    js/game_manager.js L182-L190 post-move branch
//   TR-EVENT-06  stage:end     no vanilla analogue
//   TR-EVENT-07  state:commit  js/game_manager.js L91-L97   actuate()
//   TR-EVENT-08  the emitter   js/keyboard_input_manager.js L18-L32, `on`
//
// The seven event names are colon-namespaced; the six hook names are
// camelCase. The two sets share no name.
//
// This module reads no DOM, performs no I/O, consumes no randomness and
// reads no clock. It guards no charge and returns no payload to a caller —
// those live in src/engine/hook-bus.ts. It does contain each listener
// invocation: a listener that throws is reported and the emission walks on,
// so one subscriber can neither abort an emission nor reach the engine
// operation that emitted it.
//
// Decisions behind this file: DL-EVENT-01, the board travelling by
// reference on a commit, and DL-EVENT-02, the event payloads aliasing the

import type { StageGoal } from '../config/stage-config';
import type {
  BestScoreValue,
  CorrelationId,
  Direction,
  EngineReporter,
  Position,
  RelicCommitContext,
  StageCommitContext,
} from './types';
import { NOOP_ENGINE_REPORTER } from './types';


/**
 * Every event name, in the order one turn reaches them. Frozen at runtime and
 * a readonly tuple at compile time, matching `HOOK_NAMES` of
 * src/engine/hooks.ts, and the canonical iteration order over the seven.
 */
export const ENGINE_EVENT_NAMES = Object.freeze([
  'stage:start',
  'move:before',
  'tile:merge',
  'tile:spawn',
  'move:after',
  'stage:end',
  'state:commit',
] as const);

export type EngineEventName = (typeof ENGINE_EVENT_NAMES)[number];

/* --------------------------------------------------------------------------
 * Detached projections
 * ----------------------------------------------------------------------- */

// A payload carrying a board carries a projection of it rather than the live
// `Grid`, and `tile:merge` carries tile projections rather than live `Tile`s.
// The member names are the ones js/html_actuator.js read off the grid and its
// tiles — `cells`, `size`, `value`, `previousPosition`, `mergedFrom` — so a
// view reads the same shape it always read; what changed is that the shape is
// a copy, and frozen.
//
// The two tiles a merged tile records in `mergedFrom` were already out of
// `grid.cells` when a subscriber read them: the merged tile was inserted over
// one of them and the other removed. Their projections carry that same
// relationship.

/**
 * One tile as an event carries it: the four members a view reads, projected
 * off the live tile at the moment of emission and frozen.
 *
 * A projection is a SNAPSHOT. It does not track the tile it was taken from,
 * so a later move leaves it as it stands, and writing to it changes nothing.
 */
export interface TileProjection {
  readonly x: number;
  readonly y: number;
  readonly value: number;

  /**
   * The cell this tile occupied before the move being reported, or `null`
   * when it had not moved.
   */
  readonly previousPosition: Readonly<Position> | null;

  /**
   * Projections of the two tiles this tile was produced by, or `null` when
   * it was not produced by a merge this turn.
   */
  readonly mergedFrom: readonly [TileProjection, TileProjection] | null;
}

/**
 * The board as an event carries it: the edge length and the x-major cell
 * matrix, projected off the live board at the moment of emission and frozen
 * to its leaves.
 *
 * `cells[x][y]` is the same indexing js/html_actuator.js walked, so a view
 * reads the matrix exactly as it did; the difference is that the matrix, its
 * columns and every tile in it are copies.
 */
export interface BoardProjection {
  readonly size: number;
  readonly cells: readonly (readonly (TileProjection | null)[])[];
}

/* --------------------------------------------------------------------------
 * Event payloads
 * ----------------------------------------------------------------------- */

/**
 * Payload of `stage:start`, emitted once as a stage's board is prepared.
 *
 * Corresponds to `StageStartPayload` of src/engine/hooks.ts. `boardSize` is
 * the size the stage's grid was built at, which for a board restored from a
 * snapshot is the size that snapshot carried.
 */
export interface StageStartEvent {
  readonly stageIndex: number;
  readonly goal: Readonly<StageGoal>;

  /** Seed of the run in progress, exactly as supplied to the engine. */
  readonly seed: string;
  readonly boardSize: number;
}

/**
 * Payload of `move:before`, emitted after `onBeforeMove` has resolved and
 * after the engine has decided whether the move proceeds.
 *
 * NOT CANCELLABLE FROM HERE. `cancelled` REPORTS the decision the engine
 * already took; it does not make it. Every member is readonly and the payload
 * is frozen, so a listener cannot withdraw a move, cause one to proceed, or
 * change what any other listener sees. A subscriber that has to veto a move
 * registers an `onBeforeMove` handler on the hook bus, which is the
 * privileged path the engine reads back.
 */
export interface MoveBeforeEvent {
  readonly direction: Direction;
  readonly board: BoardProjection;

  /**
   * Whether the engine withdrew the move. A withdrawn move changes no
   * state.
   */
  readonly cancelled: boolean;
}

/**
 * Payload of `tile:merge`.
 *
 * EMITTED ONCE PER MERGE: a move that resolves two merges emits this twice,
 * once per merge, so a subscriber counting emissions counts merges and not
 * moves.
 *
 * `source` projects the tile that moved into the destination cell and
 * `target` the tile that already occupied it. Both tiles were out of
 * `grid.cells` by the time the event was emitted.
 */
export interface TileMergeEvent {
  readonly source: TileProjection;
  readonly target: TileProjection;
  readonly resultValue: number;
  readonly scoreDelta: number;
}

/**
 * Payload of `tile:spawn`, emitted once a spawn has been RESOLVED.
 *
 * NOT THE SPAWN-ATTEMPT BOUNDARY. The engine returns before dispatching
 * `onSpawn` and before emitting this when no cell is available — the
 * boundary js/grid.js L37-L43 expressed by returning no cell, and the reason
 * a full board consumes no draw from either substream. A subscriber counting
 * these emissions therefore counts RESOLVED spawns and not attempts. The
 * authoritative attempt boundary is the engine's own
 * `engine.spawn.attempt` counter, raised on entry to the spawn at
 * js/game_manager.js L69, and it is the only place attempts are accounted.
 *
 * `position` IS THE CELL THE TILE ENTERED, and it is absent for every spawn
 * that inserted nothing: one an `onSpawn` handler suppressed by returning the
 * payload without a cell, and one whose handler returned a cell outside the
 * lattice. So a subscriber counting the emissions that carry a position
 * counts tiles inserted exactly, and a subscriber drawing the position never
 * draws a tile the board does not hold.
 */
export interface TileSpawnEvent {
  readonly position?: Readonly<Position> | undefined;
  readonly value: number;
}

/**
 * Payload of `move:after`, emitted once a move has been resolved.
 * Corresponds to `AfterMovePayload` of src/engine/hooks.ts: `moved` is the
 * flag the position comparison set, and `board` projects the board the move
 * left.
 */
export interface MoveAfterEvent {
  readonly moved: boolean;
  readonly board: BoardProjection;
  readonly score: number;
  readonly over: boolean;
  readonly won: boolean;

  /** Whether play is blocked pending acknowledgement. */
  readonly terminated: boolean;
}

/** Payload of `stage:end`. Corresponds to `StageEndPayload`. */
export interface StageEndEvent {
  readonly stageIndex: number;
  readonly cleared: boolean;
  readonly score: number;
}


/**
 * Payload of `state:commit`, the successor to the vanilla actuation payload
 * at js/game_manager.js L91-L97: the same six members, with `stage` and
 * `relics` added.
 */
export interface StateCommitEvent {
  readonly board: BoardProjection;
  readonly score: number;

  /**
   * Persisted best score, carried exactly as the best-score port returned it
   * and never coerced here.
   *
   * Typed as `BestScoreValue`, which is the port's own return type: the raw
   * stored STRING when a value is present and the number `0` when it is
   * absent, which is what js/local_storage_manager.js L43-L45 returned and
   * what js/game_manager.js L95 placed in this field. The type is the port's
   * exactly and is not widened here.
   */
  readonly bestScore: BestScoreValue;
  readonly over: boolean;
  readonly won: boolean;

  /** Whether play is blocked pending acknowledgement. */
  readonly terminated: boolean;

  /**
   * The stage slice, supplied to the engine by an injected provider whose
   * neutral default is `EMPTY_STAGE_CONTEXT`.
   */
  readonly stage: StageCommitContext;

  /**
   * The active relics IN PICKUP ORDER, supplied to the engine by an injected
   * provider whose neutral default is `EMPTY_RELIC_CONTEXT`. Pickup order is
   * the provider's invariant, not a property of the array type, and it is
   * the order handlers of one hook are dispatched in.
   */
  readonly relics: RelicCommitContext;
}

/**
 * The payload each event name carries. `EngineEvents.on` and
 * `EngineEvents.emit` are keyed by this map, so a listener bound to one name
 * receives that name's payload and no other.
 */
export interface EngineEventPayloadMap {
  'stage:start': StageStartEvent;
  'move:before': MoveBeforeEvent;
  'tile:merge': TileMergeEvent;
  'tile:spawn': TileSpawnEvent;
  'move:after': MoveAfterEvent;
  'stage:end': StageEndEvent;
  'state:commit': StateCommitEvent;
}

/**
 * A listener bound to one event. Called with the payload as its single
 * argument and returns nothing: a listener observes, and what it returns is
 * not read back. The path that transforms a payload is the hook bus in
 * src/engine/hook-bus.ts.
 */
export type EngineEventListener<K extends EngineEventName> = (
  payload: EngineEventPayloadMap[K],
) => void;

/**
 * Removes the listener that returned it. Calling it more than once removes
 * nothing further and throws nothing.
 */
export type EngineEventSubscription = () => void;

type StoredListener = (payload: never) => void;

/* --------------------------------------------------------------------------
 * Projection
 * ----------------------------------------------------------------------- */

/**
 * How far the merge chain of one tile is followed. A tile's `mergedFrom` pair
 * is cleared at the start of every move, so a projected pair never carries a
 * pair of its own and depth 2 is one level more than the contract can
 * produce. The bound exists so the walk terminates on any input, a cycle
 * included.
 */
const MAX_MERGE_DEPTH = 2;

/** Edge length a board projection will walk. */
const MAX_PROJECTED_BOARD_SIZE = 64;

/** The shape a tile is read through while it is being projected. */
interface TileLike {
  readonly x?: unknown;
  readonly y?: unknown;
  readonly value?: unknown;
  readonly previousPosition?: unknown;
  readonly mergedFrom?: unknown;
}

/** The shape a board is read through while it is being projected. */
interface BoardLike {
  readonly size?: unknown;
  readonly cells?: unknown;
}

function readNumber(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Projects one cell reference to a frozen position, or `null`.
 *
 * @param value Candidate position, of any shape.
 * @returns A frozen copy of its two coordinates, or `null` where it is not a
 *   position at all.
 */
function projectPosition(value: unknown): Readonly<Position> | null {
  if (!isRecordValue(value)) {
    return null;
  }

  return Object.freeze({ x: readNumber(value.x), y: readNumber(value.y) });
}

/**
 * Projects one tile to a frozen `TileProjection`.
 *
 * @param value The tile, live or already projected.
 * @param depth How many merge levels have been followed already.
 * @returns The frozen projection, or `null` where `value` is not a tile.
 */
function projectTile(value: unknown, depth: number): TileProjection | null {
  if (!isRecordValue(value)) {
    return null;
  }

  const tile = value as TileLike;
  const pair: unknown = tile.mergedFrom;
  let mergedFrom: readonly [TileProjection, TileProjection] | null = null;

  if (depth < MAX_MERGE_DEPTH && Array.isArray(pair) && pair.length === 2) {
    const first = projectTile(pair[0], depth + 1);
    const second = projectTile(pair[1], depth + 1);

    if (first !== null && second !== null) {
      mergedFrom = Object.freeze([first, second] as [
        TileProjection,
        TileProjection,
      ]);
    }
  }

  return Object.freeze({
    x: readNumber(tile.x),
    y: readNumber(tile.y),
    value: readNumber(tile.value),
    previousPosition: projectPosition(tile.previousPosition),
    mergedFrom,
  });
}

/**
 * Projects one board to a frozen `BoardProjection`: the edge length, then the
 * x-major matrix walked column by column, with every occupied cell projected
 * and every empty one carried as `null`.
 *
 * @param value The board, live `Grid` or already projected.
 * @returns The frozen projection. A board whose size is not a usable edge
 *   length projects as an empty matrix at that size.
 */
function projectBoard(value: unknown): BoardProjection {
  const board = isRecordValue(value) ? (value as BoardLike) : {};
  const declared = readNumber(board.size);
  const size =
    Number.isInteger(declared) && declared > 0
      ? Math.min(declared, MAX_PROJECTED_BOARD_SIZE)
      : 0;
  const source: unknown = board.cells;
  const built: (readonly (TileProjection | null)[])[] = [];

  for (let x = 0; x < size; x += 1) {
    const column: (TileProjection | null)[] = [];
    const sourceColumn: unknown = Array.isArray(source) ? source[x] : undefined;

    for (let y = 0; y < size; y += 1) {
      const cell: unknown = Array.isArray(sourceColumn)
        ? sourceColumn[y]
        : undefined;

      column.push(projectTile(cell, 0));
    }

    built.push(Object.freeze(column));
  }

  return Object.freeze({ size, cells: Object.freeze(built) });
}

/**
 * Projects one payload to the detached, deeply frozen form a listener
 * receives.
 *
 * THE NON-INTERFERENCE BOUNDARY. Every live collaborator the engine put in
 * the payload — the board, the two merged tiles — is replaced by a
 * projection, every plain-data member is copied, and every object is frozen,
 * so what a listener holds reaches neither the engine's state nor another
 * listener's view of it. A payload is projected ONCE per emission and the one
 * projection is shared, since a frozen projection cannot carry a change from
 * one listener to the next.
 *
 * @param event Event being emitted.
 * @param payload Payload the engine supplied.
 * @returns The frozen projection to hand to every listener of this emission.
 */
function projectPayload<K extends EngineEventName>(
  event: K,
  payload: EngineEventPayloadMap[K],
): EngineEventPayloadMap[K] {
  switch (event) {
    case 'stage:start': {
      const start = payload as StageStartEvent;

      return Object.freeze({
        stageIndex: start.stageIndex,
        goal: Object.freeze({ ...start.goal }),
        seed: start.seed,
        boardSize: start.boardSize,
      }) as EngineEventPayloadMap[K];
    }

    case 'move:before': {
      const before = payload as MoveBeforeEvent;

      return Object.freeze({
        direction: before.direction,
        board: projectBoard(before.board),
        cancelled: before.cancelled,
      }) as EngineEventPayloadMap[K];
    }

    case 'tile:merge': {
      const merge = payload as TileMergeEvent;

      return Object.freeze({
        source: projectTile(merge.source, 0),
        target: projectTile(merge.target, 0),
        resultValue: merge.resultValue,
        scoreDelta: merge.scoreDelta,
      }) as EngineEventPayloadMap[K];
    }

    case 'tile:spawn': {
      const spawn = payload as TileSpawnEvent;
      const position = projectPosition(spawn.position);

      // The member is omitted rather than carried as `null`, which is the
      // distinction `SpawnPayload` draws and what a subscriber tests for.
      return Object.freeze(
        position === null
          ? { value: spawn.value }
          : { position, value: spawn.value },
      ) as EngineEventPayloadMap[K];
    }

    case 'move:after': {
      const after = payload as MoveAfterEvent;

      return Object.freeze({
        moved: after.moved,
        board: projectBoard(after.board),
        score: after.score,
        over: after.over,
        won: after.won,
        terminated: after.terminated,
      }) as EngineEventPayloadMap[K];
    }

    case 'stage:end': {
      const end = payload as StageEndEvent;

      return Object.freeze({
        stageIndex: end.stageIndex,
        cleared: end.cleared,
        score: end.score,
      }) as EngineEventPayloadMap[K];
    }

    case 'state:commit': {
      const commit = payload as StateCommitEvent;
      const stage = commit.stage;

      return Object.freeze({
        board: projectBoard(commit.board),
        score: commit.score,
        bestScore: commit.bestScore,
        over: commit.over,
        won: commit.won,
        terminated: commit.terminated,
        stage: Object.freeze({
          stageIndex: stage.stageIndex,
          goal: Object.freeze({ ...stage.goal }),
          goalProgress: stage.goalProgress,
        }),
        relics: Object.freeze(
          commit.relics.map((relic) => Object.freeze({ ...relic })),
        ),
      }) as EngineEventPayloadMap[K];
    }

    default: {
      const unhandled: never = event;

      return unhandled;
    }
  }
}

/**
 * The engine's event emitter. Frozen: these three members are its whole
 * surface.
 */
export interface EngineEvents {
  /**
   * Registers a listener.
   *
   * APPENDS: registering a second listener for an event never replaces the
   * first, so a subscriber attaches alongside every subscriber already
   * attached, and listeners of one event are invoked in registration order.
   *
   * @returns A handle that removes this listener.
   */
  on<K extends EngineEventName>(
    event: K,
    listener: EngineEventListener<K>,
  ): EngineEventSubscription;

  /**
   * Removes the first registration of `listener` under `event`, and does
   * nothing when it is not registered.
   */
  off<K extends EngineEventName>(
    event: K,
    listener: EngineEventListener<K>,
  ): void;

  /**
   * Emits one event to every listener registered for it: synchronous, in
   * registration order, with a DETACHED FROZEN PROJECTION of the payload as
   * the single argument. Nothing is queued and nothing is deferred to a
   * microtask, a timer or a frame.
   *
   * The emission is counted whether or not a listener is registered, so an
   * emission count measures the engine and not its observers.
   *
   * A listener that throws — a write to the frozen projection included — is
   * caught, reported and counted, and the emission continues with the
   * listeners after it. Charge guarding and payload compounding are
   * src/engine/hook-bus.ts.
   */
  emit<K extends EngineEventName>(
    event: K,
    payload: EngineEventPayloadMap[K],
  ): void;
}

/* --------------------------------------------------------------------------
 * Construction parameters
 * ----------------------------------------------------------------------- */

/**
 * Counter name for one emission of any event, carried with the event name.
 */
const EMIT_METRIC = 'engine.event.emit';

/** Counter name for one listener that threw and was contained. */
const LISTENER_ERROR_METRIC = 'engine.event.listener.error';

/**
 * Counter name for one emission whose payload could not be projected and was
 * therefore withheld from every listener.
 */
const PROJECTION_ERROR_METRIC = 'engine.event.projection.error';

/**
 * Correlation identifier an emitter constructed without one carries into its
 * reports.
 */
const ANONYMOUS_CORRELATION_ID: CorrelationId = '';

/** Every construction parameter of an emitter. Both are optional. */
export interface EngineEventsOptions {
  /**
   * Correlation identifier carried into every report. Defaults to
   * `ANONYMOUS_CORRELATION_ID`; src/engine/engine.ts passes its own.
   */
  readonly correlationId?: CorrelationId;

  /**
   * Sink the contained listener errors and the emission counters reach.
   * Defaults to `NOOP_ENGINE_REPORTER`.
   */
  readonly reporter?: EngineReporter;
}

/* --------------------------------------------------------------------------
 * Construction
 * ----------------------------------------------------------------------- */

/**
 * Creates a typed event emitter.
 *
 * The state js/keyboard_input_manager.js L2 held for its own bus — one
 * table of listener arrays — plus the correlation identifier and the
 * report sink the containment in `emit` writes through.
 *
 * @param options Correlation identifier and report sink. Both optional; an
 *   emitter constructed with neither contains a throwing listener exactly
 *   as one constructed with both, and discards the report.
 * @returns A frozen emitter with no listener registered.
 *
 * @example
 * ```ts
 * const events = createEngineEvents();
 * const stop = events.on('state:commit', (commit) => {
 *   renderer.render(commit);
 * });
 *
 * stop();
 * ```
 */
export function createEngineEvents(
  options: EngineEventsOptions = {},
): EngineEvents {
  const reporter = options.reporter ?? NOOP_ENGINE_REPORTER;
  const correlationId = options.correlationId ?? ANONYMOUS_CORRELATION_ID;
  // One array per event name, appended to in registration order. Ported
  // from js/keyboard_input_manager.js L2, `this.events = {}`, which held
  // the same one-array-per-name table.
  const listeners = new Map<EngineEventName, StoredListener[]>();

  const arrayFor = (event: EngineEventName): StoredListener[] => {
    const held = listeners.get(event);

    if (held !== undefined) {
      return held;
    }

    const created: StoredListener[] = [];

    listeners.set(event, created);

    return created;
  };

  const remove = <K extends EngineEventName>(
    event: K,
    listener: EngineEventListener<K>,
  ): void => {
    const held = listeners.get(event);

    if (held === undefined) {
      return;
    }

    const index = held.indexOf(listener);

    if (index >= 0) {
      held.splice(index, 1);
    }
  };

  /**
   * Adds to one counter, without letting a throwing sink reach the caller
   * that emitted.
   *
   * The event is reported on the report's own `event` dimension.
   * `EngineCountReport.hook` names one of the six hooks and is left absent
   * here, so a consumer can tell an event count from a hook count; event
   * names were previously reported under `hook`, which it could not.
   *
   * @param metric Counter name.
   * @param event Event the count is attributed to.
   */
  const count = (metric: string, event: EngineEventName): void => {
    try {
      reporter.onCount?.({ correlationId, metric, value: 1, event });
    } catch {
      // A sink that throws is contained here for the same reason a
      // listener is: neither may abort an engine operation.
      return;
    }
  };

  /**
   * Reports one contained listener error, without letting a throwing sink
   * reach the caller that emitted.
   *
   * @param event Event that was emitting.
   * @param listenerIndex Position of the listener in the snapshot walked.
   * @param error The caught value, exactly as it was thrown.
   */
  const reportListenerError = (
    event: EngineEventName,
    listenerIndex: number,
    error: unknown,
  ): void => {
    try {
      reporter.onListenerError?.({
        correlationId,
        event,
        listenerIndex,
        error,
      });
    } catch {
      return;
    }

    count(LISTENER_ERROR_METRIC, event);
  };

  // Each member below is a closure over `listeners`, so the three are
  // callable detached from the frozen object they are returned on.
  return Object.freeze({
    on<K extends EngineEventName>(
      event: K,
      listener: EngineEventListener<K>,
    ): EngineEventSubscription {
      arrayFor(event).push(listener);

      let removed = false;

      return (): void => {
        if (removed) {
          return;
        }

        removed = true;

        remove(event, listener);
      };
    },

    off<K extends EngineEventName>(
      event: K,
      listener: EngineEventListener<K>,
    ): void {
      remove(event, listener);
    },

    emit<K extends EngineEventName>(
      event: K,
      payload: EngineEventPayloadMap[K],
    ): void {
      // Counted before the listener table is consulted, so the count
      // measures emissions and not observers: an event with no listener
      // counts exactly as one with three.
      count(EMIT_METRIC, event);

      const held = listeners.get(event);

      if (held === undefined || held.length === 0) {
        return;
      }

      let projected: EngineEventPayloadMap[K];

      try {
        projected = projectPayload(event, payload);
      } catch {
        // A payload that cannot be projected is withheld rather than
        // handed over live: the non-interference guarantee is not
        // suspended for it. The withholding is counted so it is visible.
        count(PROJECTION_ERROR_METRIC, event);

        return;
      }

      // Walked over a copy taken before the walk, so a listener that
      // registers or unsubscribes during this emission does not change it:
      // one registered during it is not invoked by it, and one removed
      // during it still is.
      const walking = held.slice();

      // Ported from L28-L30: invoked synchronously, in registration
      // order, with the projection as the single argument. Each invocation
      // is contained, so the snapshot is walked to its end whatever any
      // listener does — a write to the frozen projection throws in module
      // strict mode and is caught here — and `index` is the identity a
      // caught error is reported under.
      for (let index = 0; index < walking.length; index += 1) {
        const listener = walking[index] as EngineEventListener<K>;

        try {
          listener(projected);
        } catch (error: unknown) {
          reportListenerError(event, index, error);
        }
      }
    },
  });
}
