// The typed engine event contract and its emitter.
//
// The two tiles a merged tile holds in `mergedFrom` are already out of
// `grid.cells` when a subscriber reads them: js/game_manager.js L160 inserted
// the merged tile over one of them and L161 removed the other, and
// js/html_actuator.js L78-L80 drew each of them from the live reference alone.
//
// The seven event names are colon-namespaced; the six hook names are
// camelCase. The two sets share no name.
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
// Decisions: DL-EVENT-01, DL-EVENT-02, DL-EVENT-03 (docs/DECISION_LOG.md).

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
 * reaches them, and `state:commit` closes each turn.
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

// A payload carrying a board carries the live `Grid`, and `tile:merge` carries
// the live `Tile` pair.

/** One tile as an event carries it: the live `Tile`. */
export type TileProjection = Tile;

/** The board as an event carries it: the live `Grid`. */
export type BoardProjection = Grid;

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
 * `source` is the tile that moved into the destination cell and `target` the
 * tile that already occupied it — the pair js/game_manager.js L158 assigned to
 * `mergedFrom` as `[tile, next]`. Both are out of `grid.cells` by L161.
 */
export type TileMergeEvent = MergeDispatchPayload & {
  /**
   * The commit this merge belongs to: the value `state:commit` carries as
   * `turn` for the turn that resolved it.
   *
   * A view that buffers merge animations and replays them against the next
   * commit uses this to tell which commit a buffered entry belongs to, so a
   * delayed, duplicated or nested commit cannot animate a merge from an
   * earlier turn against a later board.
   */
  readonly turn: number;
};

/** Payload of `tile:spawn`, emitted once a spawn has been RESOLVED. */
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
 */
export type MoveAfterEvent = AfterMoveDispatchPayload & {
  /** The commit this resolved move ends with. See `TileMergeEvent.turn`. */
  readonly turn: number;
};

/**
 * Payload of `stage:end`, emitted once a stage is resolved.
 *
 * `StageEndPayload` of src/engine/hooks.ts. has no vanilla analogue: no
 * construct in js/game_manager.js, js/grid.js or js/tile.js resolved a stage.
 */
export type StageEndEvent = StageEndPayload;


/**
 * Payload of `state:commit`, the successor to the vanilla actuation payload at
 * js/game_manager.js L91-L97: the same six members, with `stage` and `relics`
 * added.
 */
export interface StateCommitEvent {
  /**
   * Monotonic commit number, counting from one and never reset.
   *
   * The correlation identifier for the granular events of the turn this commit
   * ends: `tile:merge`, `tile:spawn` and `move:after` all carry the same
   * value.
   */
  readonly turn: number;

  /** The live board. Ported from js/game_manager.js L91. */
  readonly board: Grid;

  /** Accumulated score. Ported from L92. */
  readonly score: number;

  /**
   * Persisted best score, carried exactly as the best-score port returned it
   * and never coerced here.
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
   */
  readonly degraded: boolean;

  /**
   * The stage slice, supplied to the engine by an injected provider whose
   * neutral default is `EMPTY_STAGE_CONTEXT`.
   */
  readonly stage: StageCommitContext;

  /**
   * The active relics in pickup order, supplied to the engine by an injected
   * provider whose neutral default is `EMPTY_RELIC_CONTEXT`. Pickup order is
   * the provider's invariant, not a property of the array type, and it is the
   * order handlers of one hook are dispatched in.
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
 * argument and returns nothing: what a listener returns is not read back.
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
   * registration order, with the payload as supplied as the single argument,
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

/** Counter name for one emission of any event, carried with the event name. */
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
   */
  readonly correlationId?: CorrelationSource;

  /**
   * Sink the contained listener errors and the emission counters reach.
   * Defaults to `NOOP_ENGINE_REPORTER`.
   */
  readonly reporter?: EngineReporter;
}

/**
 * Creates a typed event emitter.
 *
 * The state js/keyboard_input_manager.js L2 held for its own bus — one table
 * of listener arrays — plus the correlation identifier and the report sink the
 * containment in `emit` writes through.
 *
 * @param options Correlation identifier and report sink. Both optional; an
 *   emitter constructed with neither contains a throwing listener exactly as
 *   one constructed with both, and discards the report.
 * @returns A frozen emitter with no listener registered.
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

  const readCorrelationId = correlationReader(
    options.correlationId,
    ANONYMOUS_CORRELATION_ID,
  );
  // One array per event name, appended to in registration order.
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
   * Adds to one counter, without letting a throwing sink reach the caller that
   * emitted.
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

  // Each member below is a closure over `listeners`, so the three are callable
  // detached from the frozen object they are returned on.
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
      // Counted before the listener table is consulted, so the count measures
      // emissions and not observers: an event with no listener counts exactly
      // as one with three.
      count(EMIT_METRIC, event);

      const held = listeners.get(event);

      if (held === undefined || held.length === 0) {
        return;
      }

      // Walked over a copy taken before the walk, so a listener that registers
      // or unsubscribes during this emission does not change it: one
      // registered during it is not invoked by it, and one removed during it
      // still is.
      const walking = held.slice();

      // Ported from L28-L30: invoked synchronously, in registration order,
      // with the payload as the single argument.
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
