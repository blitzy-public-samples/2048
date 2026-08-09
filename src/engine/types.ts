// Shared type declarations of the rules engine.
//
// The board's backing store is x-major (`cells[x][y]`). The persisted snapshot
// types reproduce the shape the pre-migration game wrote under the `gameState`
// key, so an existing save still loads.
//
// This module names no sibling engine module, reads no DOM, performs no I/O,
// consumes no randomness and reads no clock. Evaluating it creates the four
// frozen neutral constants below and nothing else.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
// this module's area enumerated:
//   TR-TYPES-01  js/tile.js L19-L27       `SerializedTile`
//   TR-TYPES-02  js/grid.js L102-L117     `SerializedGrid` and `CellMatrix`
//   TR-TYPES-03  js/game_manager.js
//                L226-L234                `SerializedGameState`
//   TR-TYPES-04  js/game_manager.js
//                L194-L204                `Direction` and `Vector`
//   TR-TYPES-05  js/local_storage_manager.js
//                L43-L45                  `BestScorePort` and
//                                         `BestScoreValue`, the string-or-0
//                                         return
//   TR-TYPES-06  target-only row          `EngineReporter` and its three
//                                         report shapes
//   TR-TYPES-07  target-only row          `StageCommitContext`,
//                                         `RelicCommitContext` and the four
//                                         frozen neutral constants
//   TR-TYPES-08  target-only row          `CorrelationSource` and
//                                         `correlationReader()`, the reader
//                                         every reporter resolves its
//                                         correlation identifier through
//
// Decisions behind this file, argued in docs/DECISION_LOG.md and named here
// only so the construct can be found from the log:
//   DL-TYPES-01  the persisted snapshot types reproducing the pre-migration
//                `gameState` shape member for member
//   DL-TYPES-02  `BestScoreValue` derived from the port's own return type
//                rather than widened to `string | number`
//   DL-TYPES-03  the neutral stage and relic contexts declared here as frozen
//                constants, so the engine is constructible with no run system
//   DL-TYPES-04  a correlation identifier accepted as a VALUE OR A READER, so
//                a reporter constructed once follows the run in force instead
//                of the run its construction happened in

import type { StageGoal } from '../config/stage-config';

export interface Position {
  x: number;
  y: number;
}

export interface Vector {
  x: number;
  y: number;
}

export type Direction = 0 | 1 | 2 | 3;

export const DIRECTION_UP: Direction = 0;

export const DIRECTION_RIGHT: Direction = 1;

export const DIRECTION_DOWN: Direction = 2;

export const DIRECTION_LEFT: Direction = 3;

/**
 * Reports whether a value is one of the four declared move directions.
 *
 * THE RUNTIME HALF OF THE `Direction` CONTRACT. The type alone is a
 * compile-time claim, and a direction reaches the engine from an input adapter,
 * a structural port that widens it to `number`, and a caller that may hold a
 * string from a data attribute — so a claim is all it is. Without this measure a
 * value outside the four raised a bare `TypeError` from the vector lookup deep
 * inside the move pipeline, AFTER the move had been announced and the pre-move
 * hook dispatched, leaving the turn open; and a numeric STRING was coerced by
 * the lookup into a real, committed move.
 *
 * Strict: no coercion, so `'0'` and `true` are refused rather than read as
 * directions.
 *
 * @param value Candidate direction.
 * @returns `true` for exactly `0`, `1`, `2` and `3`.
 */
export function isMoveDirection(value: unknown): value is Direction {
  return (
    value === DIRECTION_UP ||
    value === DIRECTION_RIGHT ||
    value === DIRECTION_DOWN ||
    value === DIRECTION_LEFT
  );
}

/**
 * The board's backing store: a square matrix indexed `cells[x][y]`, x-major on
 * the outer array, holding `null` in every empty cell.
 */
export type CellMatrix<T> = (T | null)[][];

export interface SerializedTile {
  position: Position;
  value: number;
}

export interface SerializedGrid {
  size: number;
  cells: CellMatrix<SerializedTile>;
}

/**
 * The board snapshot as it is persisted under the `gameState` key: the frozen
 * shape the pre-migration game wrote, carried forward field for field.
 */
export interface SerializedGameState {
  grid: SerializedGrid;
  score: number;
  over: boolean;
  won: boolean;
  /** Name frozen. */
  keepPlaying: boolean;
}

/* --------------------------------------------------------------------------
 * Correlation identity
 * ----------------------------------------------------------------------- */

/**
 * The run correlation identifier every report, hook context and log record
 * carries.
 *
 * Declared here, in the module that declares the reporter ports, so the
 * engine, src/run/ and src/observability/ all name one type. Exactly one
 * function derives a value of it: `deriveCorrelationId` in
 * src/observability/logger.ts, from the run seed alone. No module in
 * src/engine/, src/run/, src/input/, src/render/ or src/audio/ derives one
 * of its own; each receives the identifier by injection, which is why none
 * of them imports src/observability/.
 *
 * The empty string is the value carried by a module that was constructed
 * without one.
 */
export type CorrelationId = string;

/**
 * What a reporting module accepts for its correlation identifier: the value, or
 * a reader that answers with the value in force.
 *
 * A STRING PINS one identifier for the life of the module; A READER is consulted
 * on every report and reads a shared scope.
 *
 * WHY A READER IS ACCEPTED. A page load can play more than one run — the
 * run-start screen's own control starts a second — and every run mints a new
 * identifier. A module that captured the value at construction went on
 * attributing its reports to the run the page loaded with, so one page load
 * produced records from two runs under one identifier. Passing a reader instead
 * lets a composition root hold ONE mutable correlation scope that every reporter
 * follows, without any of them deriving an identifier or importing the module
 * that does.
 *
 * A plain string is still accepted and still means a fixed identifier, so a
 * caller with one run per page needs no reader. The one deriver of a value is
 * still `deriveCorrelationId` in src/observability/logger.ts; this type only
 * says where a value it produced is read from.
 */
export type CorrelationSource = CorrelationId | (() => CorrelationId);

/**
 * Reduces a correlation source to a reader that always returns a string.
 *
 * TOTAL. A reader built from a function contains that function's throw and
 * refuses a value that is not a non-empty string, so a reporting path can
 * neither be taken down nor made to report `undefined` by the source it reads
 * through. One implementation, so the engine, src/run/ and src/relics/ resolve a
 * source identically.
 *
 * @param source The pinned identifier, the shared scope, or `undefined`.
 * @param fallback What to report when the source yields nothing usable.
 *   Defaults to the empty string, which is the value a module constructed
 *   without a source carries.
 * @returns A reader that never throws, safe to call on any reporting path.
 */
export function correlationReader(
  source?: CorrelationSource,
  fallback: CorrelationId = '',
): () => CorrelationId {
  if (typeof source === 'function') {
    return (): CorrelationId => {
      try {
        const read: unknown = source();

        return typeof read === 'string' && read.length > 0 ? read : fallback;
      } catch {
        return fallback;
      }
    };
  }

  const pinned =
    typeof source === 'string' && source.length > 0 ? source : fallback;

  return (): CorrelationId => pinned;
}

/* --------------------------------------------------------------------------
 * Report sink
 * ----------------------------------------------------------------------- */

/** An error thrown by a hook handler and caught around it. */
export interface EngineHookErrorReport {
  /**
   * Correlation identifier of the run in progress, injected into the
   * engine and the hook bus rather than derived by either.
   */
  readonly correlationId: CorrelationId;

  /** Name of the hook that was dispatching. */
  readonly hook: string;
  readonly subscriberId: string;
  readonly error: unknown;
}

/**
 * An error thrown by an event listener and caught around it.
 *
 * The event counterpart of `EngineHookErrorReport`: that one names the hook
 * that was dispatching and the subscriber whose handler threw, this one names
 * the event that was emitting and the listener's position in registration
 * order, which is the only identity an event listener has.
 */
export interface EngineListenerErrorReport {
  /** Correlation identifier of the run in progress. */
  readonly correlationId: CorrelationId;

  /** Name of the event that was emitting. */
  readonly event: string;

  /**
   * Zero-based position of the listener in the registration order of the
   * emission that caught the error.
   */
  readonly listenerIndex: number;

  /** The caught value, exactly as it was thrown. */
  readonly error: unknown;
}

/**
 * One countable engine occurrence, such as a hook dispatch or an event
 * emission.
 *
 * TWO SEPARATE DIMENSIONS. `hook` names one of the six hooks of
 * src/engine/hooks.ts and `event` one of the seven events of
 * src/engine/engine-events.ts. The two name sets are disjoint and a report
 * carries at most one of them: a hook dispatch carries `hook`, an event
 * emission carries `event`, and a count attributed to neither carries
 * neither. `event` was added because event names were previously reported
 * under `hook`, which made the two indistinguishable to a consumer.
 */
export interface EngineCountReport {
  /**
   * Correlation identifier of the run in progress, injected into the
   * engine and the hook bus rather than derived by either.
   */
  readonly correlationId: CorrelationId;

  /** Counter name. */
  readonly metric: string;
  readonly value: number;

  /**
   * Hook the count is attributed to, one of `HOOK_NAMES`. Absent on a count
   * that is not hook-scoped.
   */
  readonly hook?: string;

  /**
   * Event the count is attributed to, one of `ENGINE_EVENT_NAMES`. Absent on
   * a count that is not event-scoped.
   */
  readonly event?: string;
}

/**
 * The report sink the engine, the emitter and the hook bus deliver to.
 *
 * EVERY MEMBER IS OPTIONAL, so an implementation of a caller's own may carry
 * one, two or none. A MEMBER THAT THROWS IS CONTAINED at every one of the three
 * delivery sites: the throw reaches neither the caller that asked for the
 * operation nor the operation itself, so a game-domain call — `Engine.setup()`,
 * `Engine.move()`, `Engine.restart()`, an emission, a hook dispatch — completes
 * with the board, the score and the events it would have produced anyway. Each
 * contained throw is counted, on `Engine.reporterFaults` and described by
 * `Engine.lastReporterFault` for the engine's own counters, and on
 * `HookBusMetrics.reporterFaults` for the bus's. Nothing is re-delivered: the
 * sink is the only place a report could go.
 */
export interface EngineReporter {
  readonly onHookError?: (report: EngineHookErrorReport) => void;

  /** Receives every error caught around an event listener. */
  readonly onListenerError?: (report: EngineListenerErrorReport) => void;

  /** Receives every countable occurrence. */
  readonly onCount?: (report: EngineCountReport) => void;
}

export const NOOP_ENGINE_REPORTER: EngineReporter = Object.freeze({
  onHookError(): void {
    return;
  },
  onListenerError(): void {
    return;
  },
  onCount(): void {
    return;
  },
});

export interface BestScorePort {
  /**
   * Reads the persisted best score. The frozen contract of the storage layer:
   * the raw stored string when a value is present, and the number `0` when it
   * is absent or empty.
   */
  getBestScore(): string | 0;
  setBestScore(score: number): unknown;
}

/**
 * The best score exactly as `BestScorePort.getBestScore` returns it.
 *
 * THE ONE DECLARATION OF THAT TYPE. Every contract carrying a best score
 * onwards from the port — the `state:commit` payload, the score panel's
 * snapshot and the rendered-board projection — aliases this rather than
 * restating it, so none of them can widen the frozen contract to
 * `string | number` and invite a consumer to handle a number that the port
 * never produces other than `0`.
 */
export type BestScoreValue = ReturnType<BestScorePort['getBestScore']>;

/**
 * The stage-facing slice of a state commit. Plain data throughout, so a context
 * whose numbers are finite round-trips through JSON unchanged; the types
 * themselves admit `NaN` and `Infinity`, which JSON does not preserve.
 */
export interface StageCommitContext {
  readonly stageIndex: number;
  readonly goal: StageGoal;

  /**
   * Fraction of `goal.target` reached: finite, and within the closed interval
   * [0, 1].
   */
  readonly goalProgress: number;
}

export interface RelicCommitEntry {
  readonly id: string;
  readonly charges?: number;
}

/** The relic-facing slice of a commit: the active relics in pickup order. */
export type RelicCommitContext = readonly RelicCommitEntry[];

const NEUTRAL_STAGE_GOAL: StageGoal = Object.freeze({
  kind: 'score-threshold' as const,
  target: 0,
});

/**
 * The stage slice committed by an engine constructed without a stage source:
 * stage index 0, a zero-target score goal, and no progress.
 */
export const EMPTY_STAGE_CONTEXT: StageCommitContext = Object.freeze({
  stageIndex: 0,
  goal: NEUTRAL_STAGE_GOAL,
  goalProgress: 0,
});

/**
 * Reports whether a goal IS the neutral one `EMPTY_STAGE_CONTEXT` carries,
 * measured by VALUE rather than by object identity.
 *
 * WHY BY VALUE. The neutral goal is a sentinel meaning "no stage source supplied
 * a goal", and it crosses src/engine/hook-bus.ts on the `onStageStart` payload:
 * the bus rebuilds that payload whenever it invokes a subscriber, so what comes
 * back is a structurally-equal COPY rather than this object. A consumer
 * comparing identity therefore read "a handler supplied a goal" from the mere
 * presence of a subscriber, and adopted a zero-target goal that every board
 * meets. Comparing the two members instead cannot be defeated by a copy.
 *
 * A goal a stage source genuinely declares as a zero-target score threshold is
 * indistinguishable from the sentinel, and is treated as the sentinel: it is met
 * by every board, so resolving it through the configured curve is what the
 * fallback exists for.
 *
 * @param goal Goal to measure.
 * @returns `true` for the neutral goal, by value.
 */
export function isNeutralStageGoal(goal: StageGoal): boolean {
  return (
    goal.kind === NEUTRAL_STAGE_GOAL.kind &&
    goal.target === NEUTRAL_STAGE_GOAL.target
  );
}

/**
 * The relic slice committed by an engine constructed without a relic source.
 */
export const EMPTY_RELIC_CONTEXT: RelicCommitContext = Object.freeze([]);

/**
 * Supplies the stage slice each time a state commit is assembled, and yields
 * `EMPTY_STAGE_CONTEXT` when no stage is in progress.
 */
export type StageCommitContextProvider = () => StageCommitContext;

/**
 * Supplies the relic slice each time a state commit is assembled, in pickup
 * order, and yields `EMPTY_RELIC_CONTEXT` when no relic is active.
 */
export type RelicCommitContextProvider = () => RelicCommitContext;
