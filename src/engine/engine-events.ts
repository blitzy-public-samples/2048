// The typed engine event contract and its emitter.
//
// Successor to the single push call at js/game_manager.js L91-L97, where
// `this.actuator.actuate(this.grid, { score, over, won, bestScore,
// terminated })` handed the board and five metadata members to a view the
// manager held a reference to. `state:commit` below carries those same
// six values and adds the stage and relic slices; this module names no
// view and holds no reference to one.
//
// Provenance of each event:
//   stage:start   js/game_manager.js L35-L59   setup()
//   move:before   js/game_manager.js L130-L143 move() entry
//   tile:merge    js/game_manager.js L156-L170 merge branch
//   tile:spawn    js/game_manager.js L69-L76   addRandomTile()
//   move:after    js/game_manager.js L182-L190 post-move branch
//   stage:end     no vanilla analogue
//   state:commit  js/game_manager.js L91-L97   actuate()
//
// The emitter is ported from js/keyboard_input_manager.js L18-L32: `on`
// at L18-L23 and `emit` at L25-L32.
//
// The seven event names are colon-namespaced; the six hook names in
// src/engine/hooks.ts are camelCase. The two sets share no name.
//
// The six hook payloads are declared once, in src/engine/hooks.ts, and the
// six corresponding event payloads below alias them, so the hook contract
// and the event contract cannot drift apart.
//
// Invariants of this module: its only imports are the type-only ones
// below, it reads no DOM, performs no I/O, consumes no randomness, reads
// no clock, logs nothing and makes no diagnostic call of any kind. It
// catches no error, guards no charge and returns no payload to a caller —
// those live in src/engine/hook-bus.ts.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import type { Grid } from './grid';
import type {
  AfterMovePayload,
  BeforeMovePayload,
  MergePayload,
  SpawnPayload,
  StageEndPayload,
  StageStartPayload,
} from './hooks';
import type { RelicCommitContext, StageCommitContext } from './types';

/* --------------------------------------------------------------------------
 * Event names
 * ----------------------------------------------------------------------- */

/**
 * Every event name, in the order one turn reaches them.
 *
 * `EngineEventName` is derived from this tuple, so the seven names are
 * declared once and in one place.
 */
export const ENGINE_EVENT_NAMES = [
  'stage:start',
  'move:before',
  'tile:merge',
  'tile:spawn',
  'move:after',
  'stage:end',
  'state:commit',
] as const;

/** Union of the names in `ENGINE_EVENT_NAMES`. */
export type EngineEventName = (typeof ENGINE_EVENT_NAMES)[number];

/* --------------------------------------------------------------------------
 * How the board and its tiles travel
 * ----------------------------------------------------------------------- */

// Every payload carrying a board carries the live `Grid`, and
// `tile:merge` carries live `Tile`s. js/game_manager.js L91 passed
// `this.grid` itself, and js/html_actuator.js read `cells` (L16-L22),
// `value` (L58, L65), `previousPosition` (L54, L67) and `mergedFrom`
// (L73-L80) off those same objects.
//
// The two tiles a merged tile holds in `mergedFrom` are already out of
// `grid.cells` when a subscriber reads them: js/game_manager.js L160
// inserted the merged tile over one of them and L161 removed the other,
// and js/html_actuator.js L78-L80 drew each of them from the live
// reference alone.
//
// Payloads are not copied, cloned or frozen here, so a subscriber treats
// every payload — and everything reachable through it — as read-only.

/* --------------------------------------------------------------------------
 * Event payloads
 * ----------------------------------------------------------------------- */

// Each event payload below is a type alias of the matching hook payload in
// src/engine/hooks.ts, which is the single place the members are declared.
// The two contracts therefore cannot diverge: `move:before` carries exactly
// what `onBeforeMove` carries, `tile:merge` exactly what `onMerge` carries,
// and so on. Only `state:commit` is declared here, because no hook
// corresponds to it.

/**
 * Payload of `stage:start`, emitted once as a stage's board is prepared.
 *
 * Ported from js/game_manager.js L35-L59, which prepared the board from a
 * restored snapshot (L40-L45) or fresh (L47-L54). Drives the
 * `onStageStart` hook. `boardSize` is the size the stage's grid was built
 * at, which for a restored board is the size the snapshot carried
 * (js/game_manager.js L40-L41).
 */
export type StageStartEvent = StageStartPayload;

/**
 * Payload of `move:before`, emitted after `onBeforeMove` has resolved.
 *
 * Ported from the entry of js/game_manager.js L130-L143, between the
 * terminal-state guard at L134 and the tile preparation at L143.
 *
 * CANCELLABLE: `cancelled` is the only mutable member of any payload in
 * this module. A subscriber may set it to `true`; the engine reads it
 * back after the emission and withdraws the move, and a withdrawn move
 * changes no state. It is the same member `BeforeMovePayload` in
 * src/engine/hooks.ts declares, which a relic returns set.
 */
export type MoveBeforeEvent = BeforeMovePayload;

/**
 * Payload of `tile:merge`.
 *
 * Ported from the merge branch at js/game_manager.js L156-L170.
 *
 * EMITTED ONCE PER MERGE: a move that resolves two merges emits this
 * twice, once per merge, so a subscriber counting emissions counts
 * merges and not moves.
 *
 * `source` is the tile that moved into the destination cell and `target`
 * the tile that already occupied it — the pair js/game_manager.js L158
 * assigned to `mergedFrom` as `[tile, next]`. Both are out of
 * `grid.cells` by L161. `resultValue` and `scoreDelta` are separate
 * members; L167 added the produced value to the score, so under the
 * default rules the two are equal.
 */
export type TileMergeEvent = MergePayload;

/**
 * Payload of `tile:spawn`, emitted once per spawn attempt.
 *
 * Ported from js/game_manager.js L69-L76, reached from the start tiles at
 * L62-L66 and from the post-move spawn at L183.
 *
 * `position` is ABSENT when no cell was available: js/grid.js L40 guarded
 * with `if (cells.length)` and had no else branch, so
 * `randomAvailableCell` returned `undefined` on a full board and no tile
 * was inserted. A subscriber handles the absent case.
 */
export type TileSpawnEvent = SpawnPayload;

/**
 * Payload of `move:after`, emitted once a move has been resolved.
 *
 * Ported from the post-move branch at js/game_manager.js L182-L190: the
 * spawn at L183, the loss check at L185-L187 and the actuation at L189.
 * `moved` is the flag L175-L177 set from the position comparison, and
 * `board` is the live board the move left.
 */
export type MoveAfterEvent = AfterMovePayload;

/**
 * Payload of `stage:end`, emitted once a stage is resolved.
 *
 * HAS NO VANILLA ANALOGUE: no construct in js/game_manager.js, js/grid.js
 * or js/tile.js resolved a stage, so this event has no source lines to
 * cite.
 */
export type StageEndEvent = StageEndPayload;

/**
 * Payload of `state:commit`, the successor to the vanilla actuation
 * payload.
 *
 * Ported from js/game_manager.js L91-L97, which passed the grid by
 * reference (L91) alongside `score` (L92), `over` (L93), `won` (L94),
 * `bestScore` (L95) and `terminated` (L96). All six are carried below,
 * and `stage` and `relics` are added.
 */
export interface StateCommitEvent {
  /** The live board. Ported from js/game_manager.js L91. */
  readonly board: Grid;

  /** Accumulated score. Ported from L92. */
  readonly score: number;

  /**
   * Persisted best score, exactly as the storage layer returns it.
   *
   * js/local_storage_manager.js L43-L45 is
   * `storage.getItem(bestScoreKey) || 0`, which yields the raw stored
   * STRING when a value is present and the number `0` when it is absent,
   * and js/game_manager.js L95 placed that value in this field. The union
   * is carried unconverted: no member of this module coerces it, and the
   * relational comparison at js/game_manager.js L80-L82 reads it as it
   * stands.
   */
  readonly bestScore: string | number;

  /** Whether the game is lost. Ported from L93. */
  readonly over: boolean;

  /** Whether the win value has been reached. Ported from L94. */
  readonly won: boolean;

  /** Whether play is blocked pending acknowledgement. Ported from L96. */
  readonly terminated: boolean;

  /**
   * The stage slice, supplied to the engine by an injected provider whose
   * neutral default is `EMPTY_STAGE_CONTEXT` in src/engine/types.ts.
   */
  readonly stage: StageCommitContext;

  /**
   * The active relics IN PICKUP ORDER, supplied to the engine by an
   * injected provider whose neutral default is `EMPTY_RELIC_CONTEXT` in
   * src/engine/types.ts. The order is carried through by the readonly
   * array type and is the order handlers of one hook are dispatched in.
   */
  readonly relics: RelicCommitContext;
}

/* --------------------------------------------------------------------------
 * Name-to-payload map
 * ----------------------------------------------------------------------- */

/**
 * The payload each event name carries.
 *
 * `EngineEvents.on` and `EngineEvents.emit` are keyed by this map, so a
 * listener bound to one name receives that name's payload and no other: a
 * `tile:merge` listener cannot be registered under `tile:spawn`.
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
 * A listener bound to one event.
 *
 * Called with the payload as its single argument, which is what
 * js/keyboard_input_manager.js L28-L30 called its own subscribers with.
 * Returns nothing: a listener observes, and the payload it received is
 * not read back. The path that transforms a payload is the hook bus in
 * src/engine/hook-bus.ts.
 *
 * @param payload The event's payload.
 */
export type EngineEventListener<K extends EngineEventName> = (
  payload: EngineEventPayloadMap[K],
) => void;

/**
 * Removes the listener that returned it. Calling it more than once
 * removes nothing further and throws nothing.
 */
export type EngineEventSubscription = () => void;

/**
 * One listener as the table holds it.
 *
 * Every entry of one table row holds listeners of that row's event name;
 * `on`, `off` and `emit` are each keyed by `K`, which is where the
 * per-name payload type is recovered.
 */
type StoredListener = (payload: never) => void;

/* --------------------------------------------------------------------------
 * The emitter
 * ----------------------------------------------------------------------- */

/**
 * The engine's event emitter.
 *
 * Frozen: the three members below are its whole surface.
 */
export interface EngineEvents {
  /**
   * Registers a listener.
   *
   * APPENDS: ported from js/keyboard_input_manager.js L18-L23, which
   * created the event's array on first use (L19-L21) and pushed onto it
   * (L22). Registering a second listener for an event never replaces the
   * first, so a subscriber attaches alongside every subscriber already
   * attached, and listeners of one event are invoked in registration
   * order.
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
   * An EXTENSION, not a port: js/keyboard_input_manager.js L18-L32
   * declared `on` and `emit` and no counterpart to either. Removes the
   * first registration of `listener` under `event`, and does nothing
   * when it is not registered.
   *
   * @param event Event the listener was registered for.
   * @param listener The exact function that was registered.
   */
  off<K extends EngineEventName>(
    event: K,
    listener: EngineEventListener<K>,
  ): void;

  /**
   * Emits one event to every listener registered for it.
   *
   * Ported from js/keyboard_input_manager.js L25-L32: synchronous, in
   * registration order, with the payload as the single argument (L29),
   * returning nothing (L25-L32), and doing nothing at all for an event
   * with no listeners (L27). Nothing is queued and nothing is deferred to
   * a microtask, a timer or a frame.
   *
   * No error is caught here: a listener that throws propagates to the
   * caller that emitted. Catching, charge guarding and payload
   * compounding are src/engine/hook-bus.ts.
   *
   * @param event Event to emit.
   * @param payload Payload every listener receives.
   */
  emit<K extends EngineEventName>(
    event: K,
    payload: EngineEventPayloadMap[K],
  ): void;
}

/* --------------------------------------------------------------------------
 * Construction
 * ----------------------------------------------------------------------- */

/**
 * Creates a typed event emitter.
 *
 * Takes no arguments: it holds no correlation identifier, no report sink
 * and no configuration, which is the whole state
 * js/keyboard_input_manager.js L2 held for its own bus — one table of
 * listener arrays.
 *
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
export function createEngineEvents(): EngineEvents {
  // One array per event name, appended to in registration order. Ported
  // from js/keyboard_input_manager.js L2, `this.events = {}`, which held
  // the same one-array-per-name table.
  const listeners = new Map<EngineEventName, StoredListener[]>();

  /**
   * Reads the listener array of an event, creating it on first use.
   *
   * Ported from js/keyboard_input_manager.js L19-L21.
   *
   * @param event Event to read.
   * @returns The live array the emitter walks.
   */
  const arrayFor = (event: EngineEventName): StoredListener[] => {
    const held = listeners.get(event);

    if (held !== undefined) {
      return held;
    }

    const created: StoredListener[] = [];

    listeners.set(event, created);

    return created;
  };

  /**
   * Removes one registration of a listener.
   *
   * @param event Event the listener was registered for.
   * @param listener The exact function that was registered.
   */
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

  // Each member below is a closure over `listeners`, so the three are
  // callable detached from the frozen object they are returned on.
  return Object.freeze({
    on<K extends EngineEventName>(
      event: K,
      listener: EngineEventListener<K>,
    ): EngineEventSubscription {
      // Ported from js/keyboard_input_manager.js L22.
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

      // Ported from js/keyboard_input_manager.js L26-L27: the table is
      // read, and an event with no listeners does nothing.
      if (held === undefined || held.length === 0) {
        return;
      }

      // Walked over a copy taken before the walk, so a listener that
      // registers or unsubscribes during this emission does not change
      // this emission: a listener registered during it is not invoked by
      // it, and one removed during it still is. L28 walked the live array
      // with `forEach`, which likewise never visited a listener appended
      // during the walk.
      const walking = held.slice();

      // Ported from L28-L30: invoked synchronously, in registration
      // order, with the payload as the single argument.
      for (const listener of walking) {
        (listener as EngineEventListener<K>)(payload);
      }
    },
  });
}

