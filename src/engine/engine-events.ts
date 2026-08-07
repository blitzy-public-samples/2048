// The typed engine event contract and its emitter.
//
// Successor to the single push call at js/game_manager.js L91-L97, where the
// manager handed the board and five metadata members to a view it held a
// reference to. `state:commit` carries those same six values and adds the
// stage and relic slices; this module names no view and holds no reference
// to one.
//
// The six hook payloads are declared once, in src/engine/hooks.ts, and the
// six corresponding event payloads below alias them, so the hook contract
// and the event contract cannot drift apart. Only `state:commit` is declared
// here, because no hook corresponds to it.
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

import type { Grid } from './grid';
import type {
  AfterMovePayload,
  BeforeMovePayload,
  MergePayload,
  SpawnPayload,
  StageEndPayload,
  StageStartPayload,
} from './hooks';
import type {
  CorrelationId,
  EngineReporter,
  RelicCommitContext,
  StageCommitContext,
} from './types';
import { NOOP_ENGINE_REPORTER } from './types';

/** Every event name, in the order one turn reaches them. */
export const ENGINE_EVENT_NAMES = [
  'stage:start',
  'move:before',
  'tile:merge',
  'tile:spawn',
  'move:after',
  'stage:end',
  'state:commit',
] as const;

export type EngineEventName = (typeof ENGINE_EVENT_NAMES)[number];

// Every payload carrying a board carries the live `Grid`, and `tile:merge`
// carries live `Tile`s, which is what js/game_manager.js L91 passed and what
// js/html_actuator.js read `cells`, `value`, `previousPosition` and
// `mergedFrom` off.
//
// The two tiles a merged tile holds in `mergedFrom` are already out of
// `grid.cells` when a subscriber reads them: the merged tile was inserted
// over one of them and the other removed.
//
// Payloads are not copied, cloned or frozen here, so a subscriber treats
// every payload — and everything reachable through it — as read-only.

/**
 * Payload of `stage:start`, emitted once as a stage's board is prepared.
 *
 * `boardSize` is the size the stage's grid was built at, which for a board
 * restored from a snapshot is the size that snapshot carried.
 */
export type StageStartEvent = StageStartPayload;

/**
 * Payload of `move:before`, emitted after `onBeforeMove` has resolved.
 *
 * CANCELLABLE: `cancelled` is the only mutable member of any payload in this
 * module. A subscriber may set it to `true`; the engine reads it back after
 * the emission and withdraws the move, and a withdrawn move changes no
 * state.
 */
export type MoveBeforeEvent = BeforeMovePayload;

/**
 * Payload of `tile:merge`.
 *
 * EMITTED ONCE PER MERGE: a move that resolves two merges emits this twice,
 * once per merge, so a subscriber counting emissions counts merges and not
 * moves.
 *
 * `source` is the tile that moved into the destination cell and `target` the
 * tile that already occupied it. Both are out of `grid.cells` by the time
 * the event is emitted.
 */
export type TileMergeEvent = MergePayload;

/**
 * Payload of `tile:spawn`, emitted once a spawn has been resolved.
 *
 * NOT EMITTED ON A FULL BOARD: the engine returns before dispatching
 * `onSpawn` and before emitting this when no cell is available, so a
 * subscriber counting emissions never sees the full-board case.
 *
 * `position` is therefore absent only where an `onSpawn` handler returned
 * the payload without one, which suppresses the spawn.
 */
export type TileSpawnEvent = SpawnPayload;

/**
 * Payload of `move:after`, emitted once a move has been resolved. `moved` is
 * the flag the position comparison set, and `board` is the live board the
 * move left.
 */
export type MoveAfterEvent = AfterMovePayload;

export type StageEndEvent = StageEndPayload;

/**
 * Payload of `state:commit`, the successor to the vanilla actuation payload
 * at js/game_manager.js L91-L97: the same six members, with `stage` and
 * `relics` added.
 */
export interface StateCommitEvent {
  readonly board: Grid;
  readonly score: number;

  /**
   * Persisted best score, carried exactly as the best-score port returned it
   * and never coerced here.
   *
   * The port's frozen contract is the raw stored STRING when a value is
   * present and the number `0` when it is absent, which is what
   * js/local_storage_manager.js L43-L45 returned and what
   * js/game_manager.js L95 placed in this field. This member is typed wider
   * than that contract, so a subscriber must handle any number and must not
   * assume a string.
   */
  readonly bestScore: string | number;
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
   * registration order, with the payload as the single argument, and nothing
   * at all for an event with no listeners. Nothing is queued and nothing is
   * deferred to a microtask, a timer or a frame.
   *
   * No error is caught here: a listener that throws propagates to the caller
   * that emitted. Catching, charge guarding and payload compounding are
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
   * @param metric Counter name.
   * @param event Event the count is attributed to.
   */
  const count = (metric: string, event: EngineEventName): void => {
    try {
      reporter.onCount?.({ correlationId, metric, value: 1, hook: event });
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
      const held = listeners.get(event);

      if (held === undefined || held.length === 0) {
        return;
      }

      count(EMIT_METRIC, event);

      // Walked over a copy taken before the walk, so a listener that
      // registers or unsubscribes during this emission does not change it:
      // one registered during it is not invoked by it, and one removed
      // during it still is.
      const walking = held.slice();

      // Ported from L28-L30: invoked synchronously, in registration
      // order, with the payload as the single argument. Each invocation
      // is contained, so the snapshot is walked to its end whatever any
      // listener does, and `index` is the identity a caught error is
      // reported under.
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
