// Shared type declarations of the rules engine.
//
// The board's backing store is x-major (`cells[x][y]`), and the persisted
// snapshot types reproduce the shape the pre-migration game wrote under the
// `gameState` key, so an existing save still loads. The injected ports and the
// reporter are the engine's only outward dependencies.
//
// This module names no sibling engine module, reads no DOM, performs no I/O,
// consumes no randomness and reads no clock. Its only import is the type-only
// StageGoal below; importing it declares types and freezes four objects.

import type { StageGoal } from '../config/stage-config';

/* --------------------------------------------------------------------------
 * Geometry
 * ----------------------------------------------------------------------- */

/** A cell coordinate on the board lattice. */
export interface Position {
  /** Zero-based column index. */
  x: number;
  /** Zero-based row index. */
  y: number;
}

/** A single-step delta added to a `Position`. */
export interface Vector {
  /** Column delta: -1, 0 or 1. */
  x: number;
  /** Row delta: -1, 0 or 1. */
  y: number;
}

/* --------------------------------------------------------------------------
 * Directions
 * ----------------------------------------------------------------------- */

/** A move direction, carried as the bare number the direction map keys by. */
export type Direction = 0 | 1 | 2 | 3;

/** Upward move. */
export const DIRECTION_UP: Direction = 0;

/** Rightward move. */
export const DIRECTION_RIGHT: Direction = 1;

/** Downward move. */
export const DIRECTION_DOWN: Direction = 2;

/** Leftward move. */
export const DIRECTION_LEFT: Direction = 3;

/* --------------------------------------------------------------------------
 * Board storage
 * ----------------------------------------------------------------------- */

/**
 * The board's backing store: a square matrix indexed `cells[x][y]`, x-major on
 * the outer array, holding `null` in every empty cell.
 */
export type CellMatrix<T> = (T | null)[][];

/* --------------------------------------------------------------------------
 * Persisted snapshot
 * ----------------------------------------------------------------------- */

/** One tile as it is persisted. */
export interface SerializedTile {
  position: Position;
  value: number;
}

/** One grid as it is persisted. */
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
 * Report sink
 * ----------------------------------------------------------------------- */

/** An error thrown by a hook handler and caught around it. */
export interface EngineHookErrorReport {
  /** Correlation identifier of the run in progress. */
  readonly runId: string;

  /** Name of the hook that was dispatching. */
  readonly hook: string;

  /** Identifier of the subscriber whose handler threw. */
  readonly subscriberId: string;

  /** The caught value, exactly as it was thrown. */
  readonly error: unknown;
}

/** One countable engine occurrence, such as a hook dispatch. */
export interface EngineCountReport {
  /** Correlation identifier of the run in progress. */
  readonly runId: string;

  /** Counter name. */
  readonly metric: string;

  /** Amount to add to the counter. */
  readonly value: number;

  /** Hook the count is attributed to, when it is hook-scoped. */
  readonly hook?: string;
}

/** Sink for the engine's caught handler errors and counters. */
export interface EngineReporter {
  /** Receives every error caught around a hook handler. */
  readonly onHookError?: (report: EngineHookErrorReport) => void;

  /** Receives every countable occurrence. */
  readonly onCount?: (report: EngineCountReport) => void;
}

/**
 * A fully implemented `EngineReporter` that discards every report, used by
 * every engine module constructed without one.
 */
export const NOOP_ENGINE_REPORTER: EngineReporter = Object.freeze({
  onHookError(): void {
    return;
  },
  onCount(): void {
    return;
  },
});

/* --------------------------------------------------------------------------
 * Injected ports
 * ----------------------------------------------------------------------- */

/** The best-score accessors, as the engine consumes them. */
export interface BestScorePort {
  /**
   * Reads the persisted best score. The frozen contract of the storage layer:
   * the raw stored string when a value is present, and the number `0` when it is
   * absent or empty.
   *
   * @returns The stored string, or the number `0`.
   */
  getBestScore(): string | 0;

  /**
   * Persists `score` as the best score.
   *
   * @returns Whatever the implementation reports; the engine reads nothing from
   *   it.
   */
  setBestScore(score: number): unknown;
}

/* --------------------------------------------------------------------------
 * Commit-time context
 * ----------------------------------------------------------------------- */

/**
 * The stage-facing slice of a state commit. Plain data throughout, so a context
 * whose numbers are finite round-trips through JSON unchanged; the types
 * themselves admit `NaN` and `Infinity`, which JSON does not preserve.
 */
export interface StageCommitContext {
  /** Zero-based index of the stage in progress. */
  readonly stageIndex: number;

  /** The stage's clear condition, carried verbatim. */
  readonly goal: StageGoal;

  /**
   * Fraction of `goal.target` reached: finite, and within the closed interval
   * [0, 1].
   */
  readonly goalProgress: number;
}

/** One active relic as a state commit carries it. */
export interface RelicCommitEntry {
  /** The relic's identifier. */
  readonly id: string;

  /** Charges remaining, absent on a relic with no charge budget. */
  readonly charges?: number;
}

/**
 * The relic-facing slice of a state commit: the active relics in pickup order.
 */
export type RelicCommitContext = readonly RelicCommitEntry[];

/** The goal `EMPTY_STAGE_CONTEXT` carries: a score target of zero. */
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
 * The relic slice committed by an engine constructed without a relic source: no
 * relics.
 */
export const EMPTY_RELIC_CONTEXT: RelicCommitContext = Object.freeze([]);

/**
 * Supplies the stage slice each time a state commit is assembled.
 *
 * @returns The stage slice, or `EMPTY_STAGE_CONTEXT` when no stage is in
 *   progress.
 */
export type StageCommitContextProvider = () => StageCommitContext;

/**
 * Supplies the relic slice each time a state commit is assembled.
 *
 * @returns The active relics in pickup order, or `EMPTY_RELIC_CONTEXT` when
 * none is active.
 */
export type RelicCommitContextProvider = () => RelicCommitContext;
