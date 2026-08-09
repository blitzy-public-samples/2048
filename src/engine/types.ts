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
// Decisions: DL-TYPES-01, DL-TYPES-02, DL-TYPES-03, DL-TYPES-04
// (docs/DECISION_LOG.md).

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
 * THE RUNTIME HALF OF THE `Direction` CONTRACT: the type is a compile-time
 * claim, and this is the check a value crossing a structural port is admitted
 * by. Strict — no coercion, so `'0'` and `true` are refused rather than read
 * as directions. Decision DL-TYPES-07.
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

/**
 * The run correlation identifier every report, hook context and log record
 * carries.
 *
 * Declared here, with the reporter ports, so the engine, src/run/ and
 * src/observability/ name one type. Exactly one function derives a value of it,
 * `deriveCorrelationId` of src/observability/logger.ts, from the run seed and —
 * as the composition root supplies it — the run identifier: the seed-derived
 * prefix groups replays of one seed, and the run-instance component makes full
 * values differ when `runId` differs. No module in src/engine/, src/run/,
 * src/input/, src/render/ or src/audio/ derives one; each receives it by
 * injection, which is why none of them imports src/observability/.
 *
 * The value is pseudonymous rather than anonymous — the derivation is unsalted
 * and deterministic, so a candidate seed can be hashed and matched — and it is
 * neither a secret nor a safe carrier for a sensitive seed.
 *
 * The empty string is the value carried by a module that was constructed
 * without one.
 */
export type CorrelationId = string;

/**
 * What a reporting module accepts for its correlation identifier: the value,
 * or a reader that answers with the value in force.
 *
 * A STRING PINS one identifier for the life of the module; A READER is
 * consulted on every report and reads a shared scope, so a reporter constructed
 * once follows the run in force. Decision DL-TYPES-04.
 *
 * The one deriver of a value is `deriveCorrelationId` in
 * src/observability/logger.ts; this type only says where a value it produced is
 * read from.
 */
export type CorrelationSource = CorrelationId | (() => CorrelationId);

/**
 * Reduces a correlation source to a reader that always returns a string.
 *
 * TOTAL. A reader built from a function contains that function's throw and
 * refuses a value that is not a non-empty string, so a reporting path can
 * neither be taken down nor made to report `undefined` by the source it reads
 * through. One implementation, so the engine, src/run/ and src/relics/ resolve
 * a source identically.
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

/** An error thrown by a hook handler and caught around it. */
export interface EngineHookErrorReport {
  /**
   * Correlation identifier of the run in progress, injected into the engine
   * and the hook bus rather than derived by either.
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
 */
export interface EngineCountReport {
  /**
   * Correlation identifier of the run in progress, injected into the engine
   * and the hook bus rather than derived by either.
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
   * Event the count is attributed to, one of `ENGINE_EVENT_NAMES`. Absent on a
   * count that is not event-scoped.
   */
  readonly event?: string;
}

/**
 * The report sink the engine, the emitter and the hook bus deliver to.
 *
 * EVERY MEMBER IS OPTIONAL, so an implementation of a caller's own may carry
 * one, two or none. A MEMBER THAT THROWS IS CONTAINED at every one of the
 * three delivery sites: the throw reaches neither the caller that asked for
 * the operation nor the operation itself, so a game-domain call —
 * `Engine.setup()`, `Engine.move()`, `Engine.restart()`, an emission, a hook
 * dispatch — completes with the board, the score and the events it would have
 * produced anyway. Each contained throw is counted, on `Engine.reporterFaults`
 * and described by `Engine.lastReporterFault` for the engine's own counters,
 * and on `HookBusMetrics.reporterFaults` for the bus's. Nothing is
 * re-delivered: the sink is the only place a report could go.
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

/** The best score exactly as `BestScorePort.getBestScore` returns it. */
export type BestScoreValue = ReturnType<BestScorePort['getBestScore']>;

/**
 * The stage-facing slice of a state commit. Plain data throughout, so a
 * context whose numbers are finite round-trips through JSON unchanged; the
 * types themselves admit `NaN` and `Infinity`, which JSON does not preserve.
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
 * The neutral goal is the sentinel for "no stage source supplied a goal", and
 * it crosses src/engine/hook-bus.ts on the `onStageStart` payload, which the
 * bus rebuilds per subscriber: what comes back is a structurally-equal COPY
 * rather than this object, so identity is not available to compare. Decision
 * DL-TYPES-06.
 *
 * A goal a stage source genuinely declares as a zero-target score threshold is
 * indistinguishable from the sentinel and is treated as one.
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
