// The typed engine event contract and its emitter.
//
// This is the inversion of js/game_manager.js L91-L97, the single push
// call that handed the grid and a five-member metadata object to a view
// the controller held a reference to. The engine now emits; nothing it
// emits to is named here, and no member of this module reads the DOM.
//
// The `state:commit` payload carries the same information that push call
// carried — the board, `score`, `over`, `won`, `bestScore` and
// `terminated` — extended with the stage and relic slices.
//
// Provenance of each event:
//   stage:start    js/game_manager.js L35-L59  setup()
//   move:before    js/game_manager.js L130-L143 move() entry
//   tile:merge     js/game_manager.js L156-L170 merge branch
//   tile:spawn     js/game_manager.js L69-L76   addRandomTile()
//   move:after     js/game_manager.js L182-L190 post-move branch
//   stage:end      no vanilla analogue
//   state:commit   js/game_manager.js L91-L97   actuate()
//
// Invariants of this module: it names no engine module other than the
// type-only imports below, reads no DOM, performs no I/O, consumes no
// randomness and reads no clock.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import type { StageGoal } from '../config/stage-config';
import type {
  AfterMovePayload,
  BeforeMovePayload,
  MergePayload,
  SpawnPayload,
  StageEndPayload,
  StageStartPayload,
} from './hooks';
import type {
  EngineReporter,
  RelicCommitContext,
  SerializedGrid,
  StageCommitContext,
} from './types';
import { NOOP_ENGINE_REPORTER } from './types';

/* --------------------------------------------------------------------------
 * Counter names
 * ----------------------------------------------------------------------- */

/** Counter name for one emitted event. */
const EMIT_METRIC = 'engine.event.emit';

/** Counter name for a listener that threw. */
const LISTENER_ERROR_METRIC = 'engine.event.error';

/* --------------------------------------------------------------------------
 * Board projection
 * ----------------------------------------------------------------------- */

/**
 * One tile as an event carries it.
 *
 * A projection, not the engine's own tile: it carries the two animation
 * members a view needs and no method. `previousPosition` is the value
 * js/tile.js L11 saved and js/html_actuator.js L54 and L67 read;
 * `mergedFrom` is the pair js/game_manager.js L158 assigned and
 * js/html_actuator.js L73-L80 recursed into.
 */
export interface TileProjection {
  /** Zero-based column index of the tile's current cell. */
  readonly x: number;

  /** Zero-based row index of the tile's current cell. */
  readonly y: number;

  /** Face value. */
  readonly value: number;

  /** Cell the tile occupied before this move, or `null`. */
  readonly previousPosition: { readonly x: number; readonly y: number } | null;

  /** The two tiles this tile was produced by, or `null`. */
  readonly mergedFrom: readonly TileProjection[] | null;
}

/**
 * The board as an event carries it.
 *
 * `cells[x][y]`, x-major on the outer array, `null` in every empty cell —
 * the order js/grid.js L7-L19 builds and js/html_actuator.js L16-L22
 * iterates.
 */
export interface BoardProjection {
  /** Edge length in cells. */
  readonly size: number;

  /** Tiles by `cells[x][y]`, `null` where the cell is empty. */
  readonly cells: readonly (readonly (TileProjection | null)[])[];
}

/* --------------------------------------------------------------------------
 * Event payloads
 * ----------------------------------------------------------------------- */

/** Payload of `stage:start`. */
export interface StageStartEvent extends StageStartPayload {
  /** The board as the stage begins. */
  readonly board: BoardProjection;
}

/** Payload of `move:before`, emitted after `onBeforeMove` has resolved. */
export interface MoveBeforeEvent extends BeforeMovePayload {
  /** The board before the move resolves. */
  readonly board: BoardProjection;
}

/** Payload of `tile:merge`, emitted once per merge. */
export type TileMergeEvent = MergePayload;

/** Payload of `tile:spawn`, emitted once per spawn attempt. */
export type TileSpawnEvent = SpawnPayload;

/** Payload of `move:after`. */
export interface MoveAfterEvent extends AfterMovePayload {
  /** The board after the move resolved. */
  readonly board: BoardProjection;
}

/** Payload of `stage:end`. */
export type StageEndEvent = StageEndPayload;

/**
 * Payload of `state:commit`, the successor to the vanilla actuation
 * payload.
 *
 * `bestScore` is carried exactly as the storage layer returns it — the
 * raw stored string when a value is present and the number `0` when it
 * is absent — which is what js/game_manager.js L95 placed in the same
 * field.
 */
export interface StateCommitEvent {
  /** The board. */
  readonly board: BoardProjection;

  /** Accumulated score. */
  readonly score: number;

  /** Amount the move that produced this commit added to the score. */
  readonly scoreDelta: number;

  /** Persisted best score, as the storage layer returns it. */
  readonly bestScore: string | number;

  /** Whether the game is lost. */
  readonly over: boolean;

  /** Whether the win value has been reached. */
  readonly won: boolean;

  /** Whether play is blocked pending an acknowledgement. */
  readonly terminated: boolean;

  /** The stage slice. */
  readonly stage: StageCommitContext;

  /** The active relics, in pickup order. */
  readonly relics: RelicCommitContext;
}

/**
 * Payload of `state:restore`, emitted when a commit follows a board
 * being adopted rather than a move: a stage beginning, a restored
 * snapshot, or a terminal state being acknowledged.
 *
 * Carries the reason so a view can suppress movement animation for a
 * board it has not seen before.
 */
export type RestoreReason = 'stage-start' | 'snapshot' | 'continue';

/** Payload of `state:restore`. */
export interface StateRestoreEvent {
  /** Why the board was adopted. */
  readonly reason: RestoreReason;

  /** The serialised board that was adopted. */
  readonly snapshot: SerializedGrid;

  /** The stage goal in force, carried verbatim. */
  readonly goal: StageGoal;
}

/* --------------------------------------------------------------------------
 * Name-to-payload map
 * ----------------------------------------------------------------------- */

/**
 * Every event the engine emits and the payload it carries.
 *
 * `EngineEvents.on` is keyed by this map, so a listener bound to a name
 * receives that name's payload and no other.
 */
export interface EngineEventMap {
  'stage:start': StageStartEvent;
  'move:before': MoveBeforeEvent;
  'tile:merge': TileMergeEvent;
  'tile:spawn': TileSpawnEvent;
  'move:after': MoveAfterEvent;
  'stage:end': StageEndEvent;
  'state:commit': StateCommitEvent;
  'state:restore': StateRestoreEvent;
}

/** Union of the event names. */
export type EngineEventName = keyof EngineEventMap;

/**
 * A listener bound to one event.
 *
 * Returns nothing: an event listener observes and cannot transform. The
 * transforming path is the hook bus.
 *
 * @param payload The event's payload.
 */
export type EngineEventListener<K extends EngineEventName> = (
  payload: EngineEventMap[K],
) => void;

/** Removes one listener. Calling it more than once is harmless. */
export type EngineEventSubscription = () => void;

/**
 * The emitter.
 *
 * Frozen: the three members below are its whole surface.
 */
export interface EngineEvents {
  /**
   * Registers a listener.
   *
   * Listeners of one event are invoked in registration order, which is
   * the order js/keyboard_input_manager.js L28-L30 invoked its own
   * subscribers in.
   *
   * @param event Event to listen for.
   * @param listener Called with the event's payload.
   * @returns A handle that removes this listener.
   */
  on<K extends EngineEventName>(
    event: K,
    listener: EngineEventListener<K>,
  ): EngineEventSubscription;

  /**
   * Removes a listener.
   *
   * @param event Event the listener was registered for.
   * @param listener The exact function that was registered.
   * @returns `true` when a listener was removed.
   */
  off<K extends EngineEventName>(
    event: K,
    listener: EngineEventListener<K>,
  ): boolean;

  /**
   * Emits one event to every listener bound to it.
   *
   * A listener that throws is caught and reported, and the remaining
   * listeners still run: one failing view cannot abort a turn.
   *
   * @param event Event to emit.
   * @param payload Payload every listener receives.
   * @returns How many listeners were invoked.
   */
  emit<K extends EngineEventName>(
    event: K,
    payload: EngineEventMap[K],
  ): number;
}

/** Construction parameters. */
export interface EngineEventsOptions {
  /** Correlation identifier of the run. Defaults to the empty string. */
  readonly runId?: string;

  /** Sink for caught listener errors and counters. */
  readonly reporter?: EngineReporter;
}

/* --------------------------------------------------------------------------
 * Construction
 * ----------------------------------------------------------------------- */

/**
 * Creates a typed event emitter.
 *
 * @param options Correlation identifier and report sink. Both optional.
 * @returns A frozen emitter.
 *
 * @example
 * ```ts
 * const events = createEngineEvents({ runId, reporter });
 * const stop = events.on('state:commit', (commit) => renderer.render(commit));
 * stop();
 * ```
 */
export function createEngineEvents(
  options: EngineEventsOptions = {},
): EngineEvents {
  const runId = options.runId ?? '';
  const reporter = options.reporter ?? NOOP_ENGINE_REPORTER;

  // One array per event name, appended to in registration order. Typed
  // as the unconstrained listener because the map's per-key type is
  // recovered at the call sites below, each of which is keyed by K.
  const listeners = new Map<
    EngineEventName,
    EngineEventListener<EngineEventName>[]
  >();

  /**
   * Reads the listener array for an event, creating it on first use.
   *
   * @param event Event to read.
   * @returns The array, which is the live one the emitter walks.
   */
  const arrayFor = (
    event: EngineEventName,
  ): EngineEventListener<EngineEventName>[] => {
    const held = listeners.get(event);

    if (held !== undefined) {
      return held;
    }

    const created: EngineEventListener<EngineEventName>[] = [];

    listeners.set(event, created);

    return created;
  };

  return Object.freeze({
    on<K extends EngineEventName>(
      event: K,
      listener: EngineEventListener<K>,
    ): EngineEventSubscription {
      const bound = listener as EngineEventListener<EngineEventName>;

      arrayFor(event).push(bound);

      let removed = false;

      return (): void => {
        if (removed) {
          return;
        }

        removed = true;

        const held = listeners.get(event);

        if (held === undefined) {
          return;
        }

        const index = held.indexOf(bound);

        if (index >= 0) {
          held.splice(index, 1);
        }
      };
    },

    off<K extends EngineEventName>(
      event: K,
      listener: EngineEventListener<K>,
    ): boolean {
      const held = listeners.get(event);

      if (held === undefined) {
        return false;
      }

      const index = held.indexOf(
        listener as EngineEventListener<EngineEventName>,
      );

      if (index < 0) {
        return false;
      }

      held.splice(index, 1);

      return true;
    },

    emit<K extends EngineEventName>(
      event: K,
      payload: EngineEventMap[K],
    ): number {
      reporter.onCount?.({ runId, metric: EMIT_METRIC, value: 1 });

      const held = listeners.get(event);

      if (held === undefined || held.length === 0) {
        return 0;
      }

      // Snapshotted before the walk, so a listener that subscribes or
      // unsubscribes during the emission does not alter this emission.
      const walking = held.slice() as EngineEventListener<K>[];

      let invoked = 0;

      for (const listener of walking) {
        invoked += 1;

        try {
          listener(payload);
        } catch (error: unknown) {
          reporter.onHookError?.({
            runId,
            hook: event,
            subscriberId: event,
            error,
          });
          reporter.onCount?.({
            runId,
            metric: LISTENER_ERROR_METRIC,
            value: 1,
          });
        }
      }

      return invoked;
    },
  });
}
