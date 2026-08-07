// Shared type declarations of the rules engine.
//
// The board's backing store is x-major (`cells[x][y]`). The persisted snapshot
// types reproduce the shape the pre-migration game wrote under the `gameState`
// key, so an existing save still loads.
//
// This module names no sibling engine module, reads no DOM, performs no I/O,
// consumes no randomness and reads no clock. Evaluating it creates the four
// frozen neutral constants below and nothing else.

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

/** One countable engine occurrence, such as a hook dispatch. */
export interface EngineCountReport {
  /**
   * Correlation identifier of the run in progress, injected into the
   * engine and the hook bus rather than derived by either.
   */
  readonly correlationId: CorrelationId;

  /** Counter name. */
  readonly metric: string;
  readonly value: number;
  readonly hook?: string;
}

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
