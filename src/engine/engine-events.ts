// The typed engine event contract and its emitter.
//
// Successor to the single push call at js/game_manager.js L91-L97, where the
// manager handed the board and five metadata members to a view it held a
// reference to. `state:commit` carries those same six values and adds the
// stage and relic slices; this module names no view and holds no reference
// to one.
//
// HOW THE BOARD AND ITS TILES TRAVEL. Every payload carrying a board carries
// the LIVE `Grid`, and `tile:merge` carries the two LIVE `Tile`s, exactly as
// js/game_manager.js L91 passed `this.grid` itself and js/html_actuator.js
// read `cells` (L16-L22), `value` (L58, L65), `previousPosition` (L54, L67)
// and `mergedFrom` (L73-L80) off those same objects. Nothing here copies,
// clones or freezes a payload, so a subscriber treats every payload — and
// everything reachable through it — as read-only. The path that TRANSFORMS
// engine state is the hook bus of src/engine/hook-bus.ts, whose handlers are
// dispatched separately and whose returns the engine reads back.
//
// The two tiles a merged tile holds in `mergedFrom` are already out of
// `grid.cells` when a subscriber reads them: js/game_manager.js L160 inserted
// the merged tile over one of them and L161 removed the other, and
// js/html_actuator.js L78-L80 drew each of them from the live reference alone.
//
// `move:before` IS CANCELLABLE. Its `cancelled` member is the one mutable
// member of any payload in this module: the engine emits it BEFORE it has
// decided, a subscriber may set it to `true`, and the engine reads it back and
// carries it into the `onBeforeMove` dispatch — so a handler sees a veto a
// listener already cast, and a withdrawn move changes no state. It is the same
// member `BeforeMoveDispatchPayload` of src/engine/hooks.ts declares, which an
// `onBeforeMove` relic handler returns set.
//
// The six lifecycle event payloads are the corresponding dispatch payloads
// declared in src/engine/hooks.ts, so the hook contract and the event contract
// cannot drift apart. Three of them — `tile:merge`, `tile:spawn` and
// `move:after` — carry one member the dispatch payload does not: the monotonic
// `turn` of the commit that turn ends, which is what lets a buffering view tell
// which commit a buffered animation belongs to. `move:before`, `stage:start`
// and `stage:end` are bare aliases. Only `state:commit` is declared here,
// because no hook corresponds to it.
//
// docs/TRACEABILITY_MATRIX.md apiece:
//   TR-EVENT-01  stage:start   js/game_manager.js L35-L59   setup()
//   TR-EVENT-02  move:before   js/game_manager.js L130-L143 move() entry
//   TR-EVENT-03  tile:merge    js/game_manager.js L156-L170 merge branch
//   TR-EVENT-04  tile:spawn    js/game_manager.js L69-L76   addRandomTile()
//   TR-EVENT-05  move:after    js/game_manager.js L182-L190 post-move branch
//   TR-EVENT-06  stage:end     no vanilla analogue, target-only row
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
// so one subscriber cannot abort an emission.
//
// Decisions behind this file, argued in docs/DECISION_LOG.md and named here
// only so the construct can be found from the log:
//   DL-EVENT-01  the board travelling by reference on a commit
//   DL-EVENT-02  the six lifecycle payloads resolving to the dispatch payloads
//                of src/engine/hooks.ts, three of them widened by the `turn`
//                correlation member alone
//   DL-EVENT-03  per-listener error containment inside `emit`

import type { Grid } from './grid';
import type {
  AfterMoveDispatchPayload,
  MergeDispatchPayload,
  SpawnPayload,
  StageEndPayload,
  StageStartPayload,
} from './hooks';
import type {
  BestScoreValue,
  CorrelationId,
  CorrelationSource,
  Direction,
  EngineReporter,
  RelicCommitContext,
  StageCommitContext,
} from './types';
import { NOOP_ENGINE_REPORTER, correlationReader } from './types';
import type { Tile } from './tile';


/**
 * Every event name, in canonical lifecycle order: `stage:start` and
 * `stage:end` bracket a stage, the four between them are the order one turn
 * reaches them, and `state:commit` closes each turn. Frozen at runtime and a
 * readonly tuple at compile time, matching `HOOK_NAMES` of
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
 * Live collaborators
 * ----------------------------------------------------------------------- */

// A payload carrying a board carries the live `Grid`, and `tile:merge` carries
// the live `Tile` pair. The member names a view reads off them — `cells`,
// `size`, `value`, `previousPosition`, `mergedFrom` — are the names
// js/html_actuator.js read, and they are read off the same objects it read
// them off.
//
// The two tiles a merged tile records in `mergedFrom` are already out of
// `grid.cells` when a subscriber reads them: the merged tile was inserted over
// one of them and the other removed.

/** One tile as an event carries it: the live `Tile`. */
export type TileProjection = Tile;

/** The board as an event carries it: the live `Grid`. */
export type BoardProjection = Grid;

/* --------------------------------------------------------------------------
 * Event payloads
 * ----------------------------------------------------------------------- */

/**
 * Payload of `stage:start`, emitted once as a stage's board is prepared.
 *
 * `StageStartPayload` of src/engine/hooks.ts, which `onStageStart` carries.
 * `boardSize` is the size the stage's grid was built at, which for a board
 * restored from a snapshot is the size that snapshot carried
 * (js/game_manager.js L40-L41).
 */
export type StageStartEvent = StageStartPayload;

/**
 * Payload of `move:before`, emitted BEFORE the engine has decided whether the
 * move proceeds and before `onBeforeMove` is dispatched.
 *
 * CANCELLABLE, which is what AAP Contract 1 declares it. `cancelled` is the
 * one writable member on any payload in this module: a listener that assigns
 * it `true` withdraws the move, and a withdrawn move changes no state at all —
 * no tile moves, no merge resolves, no tile spawns, the score does not change
 * and nothing is committed. The engine reads the member back after the
 * emission and carries it into the `onBeforeMove` dispatch, so an
 * `onBeforeMove` handler sees a veto a listener already cast and may cast one
 * of its own; the hook remains the privileged path, because it can also
 * redirect the move.
 *
 * `direction` is readonly here: redirection is the hook's, not a listener's.
 */
export interface MoveBeforeEvent {
  readonly direction: Direction;
  readonly board: BoardProjection;

  /**
   * Whether the move is withdrawn. `false` on emission, and read back by the
   * engine once every listener has run.
   */
  cancelled: boolean;
}

/**
 * Payload of `tile:merge`.
 *
 * `MergeDispatchPayload` of src/engine/hooks.ts: the two live tiles.
 *
 * EMITTED ONCE PER MERGE: a move that resolves two merges emits this twice,
 * once per merge, so a subscriber counting emissions counts merges and not
 * moves.
 *
 * `source` is the tile that moved into the destination cell and `target` the
 * tile that already occupied it — the pair js/game_manager.js L158 assigned
 * to `mergedFrom` as `[tile, next]`. Both are out of `grid.cells` by L161.
 */
export type TileMergeEvent = MergeDispatchPayload & {
  /**
   * The commit this merge belongs to: the value `state:commit` carries as
   * `turn` for the turn that resolved it.
   *
   * A view that buffers merge animations and replays them against the next
   * commit uses this to tell which commit a buffered entry belongs to, so a
   * delayed, duplicated or nested commit cannot animate a merge from an earlier
   * turn against a later board.
   */
  readonly turn: number;
};

/**
 * Payload of `tile:spawn`, emitted once a spawn has been RESOLVED.
 *
 * EMITTED FOR EVERY SPAWN ATTEMPT, the full-board one included, which is what
 * AAP Contract 1 means by "position may be absent when the board is full".
 * The engine does NOT dispatch `onSpawn` for a full board and consumes no
 * draw from either substream for it — the boundary js/grid.js L37-L43
 * expressed by returning no cell — so the emission carries
 * `SUPPRESSED_SPAWN_VALUE` as its `value` and no position.
 *
 * `position` IS THE CELL THE TILE ENTERED, and it is absent for every attempt
 * that inserted nothing: the full board, one an `onSpawn` handler suppressed
 * by returning the payload without a cell, and one whose handler returned a
 * cell outside the lattice. So a subscriber counting the emissions that carry
 * a position counts tiles inserted exactly, and a subscriber drawing the
 * position never draws a tile the board does not hold.
 */
export type TileSpawnEvent = SpawnPayload & {
  /** The commit this spawn belongs to. See `TileMergeEvent.turn`. */
  readonly turn: number;
};

/**
 * Payload of `move:after`, emitted once a move has been resolved.
 *
 * `AfterMoveDispatchPayload` of src/engine/hooks.ts: `moved` is the flag the
 * position comparison at js/game_manager.js L175-L177 set, and `board` is the
 * live board the move left.
 *
 * Emitted for EVERY move the terminal-state guard let through and an
 * `onBeforeMove` handler did not withdraw, so a move that changed no cell emits
 * it with `moved` as `false`. That emission carries the state the turn began
 * with and is followed by no spawn and no `state:commit`; the `onAfterMove` hook
 * is dispatched only on the branch that changed the board. A move withdrawn on
 * `onBeforeMove` emits no `move:after` at all: its outcome is `move:before`'s
 * own `cancelled` flag.
 */
export type MoveAfterEvent = AfterMoveDispatchPayload & {
  /** The commit this resolved move ends with. See `TileMergeEvent.turn`. */
  readonly turn: number;
};

/**
 * Payload of `stage:end`, emitted once a stage is resolved.
 *
 * `StageEndPayload` of src/engine/hooks.ts. HAS NO VANILLA ANALOGUE: no
 * construct in js/game_manager.js, js/grid.js or js/tile.js resolved a stage.
 */
export type StageEndEvent = StageEndPayload;


/**
 * Payload of `state:commit`, the successor to the vanilla actuation payload
 * at js/game_manager.js L91-L97: the same six members, with `stage` and
 * `relics` added.
 */
export interface StateCommitEvent {
  /**
   * Monotonic commit number, counting from one and never reset.
   *
   * The correlation identifier for the granular events of the turn this commit
   * ends: `tile:merge`, `tile:spawn` and `move:after` all carry the same value.
   */
  readonly turn: number;

  /** The live board. Ported from js/game_manager.js L91. */
  readonly board: Grid;

  /** Accumulated score. Ported from L92. */
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

  /** Whether the game is lost. Ported from L93. */
  readonly over: boolean;

  /** Whether the win value has been reached. Ported from L94. */
  readonly won: boolean;

  /** Whether play is blocked pending acknowledgement. Ported from L96. */
  readonly terminated: boolean;

  /**
   * Whether the terminal status of the turn this commit ends could not be
   * established.
   *
   * `true` means the loss probe or the stage-goal measurement raised: the board
   * and the score are the ones the turn produced, `over` is the value that stood
   * before the failed measurement rather than an asserted one, and a view is to
   * surface the uncertainty rather than present the turn as ordinary.
   */
  readonly degraded: boolean;

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
 * argument and returns nothing: what a listener returns is not read back. The
 * one member a listener may write is `move:before.cancelled`; the path that
 * transforms a payload is the hook bus in src/engine/hook-bus.ts.
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
   * registration order, with THE PAYLOAD AS SUPPLIED as the single argument,
   * live collaborators included. Nothing is copied, queued or deferred to a
   * microtask, a timer or a frame.
   *
   * The emission is counted whether or not a listener is registered, so an
   * emission count measures the engine and not its observers.
   *
   * A listener that throws is caught, reported and counted, and the emission
   * continues with the listeners after it. Charge guarding and payload
   * compounding are src/engine/hook-bus.ts.
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
 * Correlation identifier an emitter constructed without one carries into its
 * reports.
 */
const ANONYMOUS_CORRELATION_ID: CorrelationId = '';

/** Every construction parameter of an emitter. Both are optional. */
export interface EngineEventsOptions {
  /**
   * Correlation identifier carried into every report. Defaults to
   * `ANONYMOUS_CORRELATION_ID`; src/engine/engine.ts passes its own.
   *
   * A READER IS ACCEPTED as well as a value, and the engine passes one, so an
   * emitter that outlives the run it was built for reports under the run in
   * force rather than the run its construction happened in.
   */
  readonly correlationId?: CorrelationSource;

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

  // Read on every report rather than captured, so a rotated correlation scope
  // reaches the emissions of the run that follows it. Total: the reader answers
  // with `ANONYMOUS_CORRELATION_ID` where nothing was injected.
  const readCorrelationId = correlationReader(
    options.correlationId,
    ANONYMOUS_CORRELATION_ID,
  );
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
   * here, so a consumer can tell an event count from a hook count.
   *
   * @param metric Counter name.
   * @param event Event the count is attributed to.
   */
  const count = (metric: string, event: EngineEventName): void => {
    try {
      reporter.onCount?.({
        correlationId: readCorrelationId(),
        metric,
        value: 1,
        event,
      });
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
        correlationId: readCorrelationId(),
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

      // Walked over a copy taken before the walk, so a listener that
      // registers or unsubscribes during this emission does not change it:
      // one registered during it is not invoked by it, and one removed
      // during it still is.
      const walking = held.slice();

      // Ported from L28-L30: invoked synchronously, in registration order,
      // with the payload as the single argument. Each invocation is
      // contained, so the snapshot is walked to its end whatever any listener
      // does, and `index` is the identity a caught error is reported under.
      for (let index = 0; index < walking.length; index += 1) {
        const listener = walking[index] as EngineEventListener<K>;

        try {
          listener(payload);
        } catch (error: unknown) {
          reportListenerError(event, index, error);
        }
      }
    },
  });
}
