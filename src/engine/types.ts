// Shared type declarations of the rules engine.
//
// Ported from js/game_manager.js, js/grid.js, js/tile.js and
// js/local_storage_manager.js, all four of which are deleted.
// Provenance for every construct declared here:
//   js/game_manager.js L148, L228, L250  inline { x, y } -> Position
//   js/game_manager.js L196-L201  vector map            -> Vector
//   js/game_manager.js L131       direction encoding    -> Direction
//   js/grid.js         L7-L19     empty()               -> CellMatrix
//   js/tile.js         L19-L27    serialize()           -> SerializedTile
//   js/grid.js         L102-L117  serialize()           -> SerializedGrid
//   js/game_manager.js L102-L110  serialize()      -> SerializedGameState
//   js/local_storage_manager.js L37  discarded error
//                                     -> EngineHookErrorReport
//   js/game_manager.js L80-L82 with js/local_storage_manager.js
//                     L43-L49     best-score accessors -> BestScorePort
//
// StageCommitContext, RelicCommitContext and EngineReporter have no
// vanilla analogue; each carries its own provenance note below.
//
// Invariants of this module: it names no sibling engine module, reads no
// DOM, performs no I/O, consumes no randomness and reads no clock. Its
// only import is the type-only StageGoal below. Importing it defines
// types and freezes four objects, and does nothing else.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import type { StageGoal } from '../config/stage-config';

/* --------------------------------------------------------------------------
 * Geometry
 * ----------------------------------------------------------------------- */

/**
 * A cell coordinate on the board lattice.
 *
 * The shape js/tile.js L2-L3 destructures onto `this.x` and `this.y`,
 * that js/tile.js L11 and L21-L24 re-nest, and that js/game_manager.js
 * builds inline at L148 (`{ x: x, y: y }`), L228 and L250.
 *
 * Both members are zero-based indices, bounded by the board size that
 * js/grid.js L97-L100 checks against.
 */
export interface Position {
  /** Zero-based column index. */
  x: number;
  /** Zero-based row index. */
  y: number;
}

/**
 * A single-step delta added to a `Position`.
 *
 * The shape of the four values in the direction map at
 * js/game_manager.js L196-L201, read at L216-L217, L228 and L255. Every
 * member of every mapped value is -1, 0 or 1.
 *
 * Structurally identical to `Position` and semantically distinct: a
 * `Position` addresses a cell, a `Vector` steps between cells.
 */
export interface Vector {
  /** Column delta: -1, 0 or 1. */
  x: number;
  /** Row delta: -1, 0 or 1. */
  y: number;
}

/* --------------------------------------------------------------------------
 * Directions
 * ----------------------------------------------------------------------- */

/**
 * A move direction, carried as the bare number the direction map keys
 * by.
 *
 * The encoding is js/game_manager.js L131 — `0: up, 1: right, 2: down,
 * 3: left` — and the four members are the four keys of the map at
 * L196-L201. js/game_manager.js L253 iterates the same four values.
 *
 * An identical union, with identically valued constants, is declared at
 * src/input/keymap.ts L33-L45. Both are bare numeric literal unions and
 * are therefore mutually assignable, so a direction the input layer
 * emits reaches the engine unconverted and uncast. This declaration is
 * recorded in docs/DECISION_LOG.md.
 */
export type Direction = 0 | 1 | 2 | 3;

/** Upward move. The `0` key of the map at js/game_manager.js L197. */
export const DIRECTION_UP: Direction = 0;

/** Rightward move. The `1` key at js/game_manager.js L198. */
export const DIRECTION_RIGHT: Direction = 1;

/** Downward move. The `2` key at js/game_manager.js L199. */
export const DIRECTION_DOWN: Direction = 2;

/** Leftward move. The `3` key at js/game_manager.js L200. */
export const DIRECTION_LEFT: Direction = 3;

/* --------------------------------------------------------------------------
 * Board storage
 * ----------------------------------------------------------------------- */

/**
 * The board's backing store: a square matrix indexed `cells[x][y]`,
 * x-major on the outer array, holding `null` in every empty cell.
 *
 * Ported from js/grid.js L7-L19, where `empty()` assigns the outer entry
 * `cells[x]` and pushes one `null` per `y`. Every access in the vanilla
 * sources uses that order: js/grid.js L28, L61, L82, L90, L94 and L109,
 * and js/game_manager.js L124-L125.
 *
 * The x-outer, y-inner traversal of js/grid.js L58-L64 is the order
 * js/grid.js L45-L55 collects available cells in, and js/grid.js L41
 * indexes that collection with a random draw. The ordering is therefore
 * part of the seeded-spawn contract and is fixed.
 */
export type CellMatrix<T> = (T | null)[][];

/* --------------------------------------------------------------------------
 * Persisted snapshot
 * ----------------------------------------------------------------------- */

/**
 * One tile as it is persisted.
 *
 * Ported verbatim from js/tile.js L19-L27. The coordinates the
 * constructor flattened onto `this.x` and `this.y` at L2-L3 are
 * re-nested under `position` at L21-L24, and no animation state is
 * carried: neither `previousPosition` (L6) nor `mergedFrom` (L7)
 * appears.
 */
export interface SerializedTile {
  /** The tile's cell, re-nested at L21-L24. */
  position: Position;
  /** The tile's face value, from L25. */
  value: number;
}

/**
 * One grid as it is persisted.
 *
 * Ported verbatim from js/grid.js L102-L117: the grid's own `size` at
 * L114 and, at L115, a matrix of serialised tiles in which an empty cell
 * is the `null` pushed at L109 and is never omitted or compacted.
 * js/grid.js L21-L34 rebuilds a grid from this matrix, reading it as
 * `state[x][y]` at L28.
 */
export interface SerializedGrid {
  /** Board edge length in cells, from L114. */
  size: number;
  /** Tiles by `cells[x][y]`, `null` where the cell is empty (L109). */
  cells: CellMatrix<SerializedTile>;
}

/**
 * The board snapshot as it is persisted under the `gameState` key.
 *
 * Ported verbatim from js/game_manager.js L102-L110, which
 * js/local_storage_manager.js L57-L59 writes and L52-L55 reads back, and
 * which js/game_manager.js L39-L45 restores from. src/run/run-state.ts
 * carries this shape unchanged inside the run-state envelope, so a
 * snapshot written by the vanilla game loads unmodified.
 *
 * The member name `keepPlaying` is the persisted name at L108 and is
 * frozen. src/engine/engine.ts carries the same flag under a different
 * member name — js/game_manager.js L24-L27 assigned the flag over the
 * prototype method of that name — and this member does not change with
 * it.
 */
export interface SerializedGameState {
  /** The serialised grid, from L104. */
  grid: SerializedGrid;
  /** Accumulated score, from L105. */
  score: number;
  /** Whether the game is lost, from L106. */
  over: boolean;
  /** Whether the win value has been reached, from L107. */
  won: boolean;
  /** Whether play continued past the win, from L108. Name frozen. */
  keepPlaying: boolean;
}

/* --------------------------------------------------------------------------
 * Report sink
 * ----------------------------------------------------------------------- */

/**
 * An error thrown by a hook handler and caught around it.
 *
 * js/local_storage_manager.js L37 holds the vanilla sources' only
 * `catch` clause and discards its error object; this report carries the
 * caught value together with the identity of what threw it.
 */
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

/**
 * One countable engine occurrence, such as a hook dispatch.
 *
 * Has no vanilla analogue: the vanilla sources contain no counter, no
 * `console` call and no Performance API call.
 */
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

/**
 * Sink for the engine's caught handler errors and counters.
 *
 * Declared in this module, and supplied by the composition root. Every
 * member is optional, so a sink that accepts one kind of report and not
 * the other is a complete implementation.
 */
export interface EngineReporter {
  /** Receives every error caught around a hook handler. */
  readonly onHookError?: (report: EngineHookErrorReport) => void;

  /** Receives every countable occurrence. */
  readonly onCount?: (report: EngineCountReport) => void;
}

/**
 * A fully implemented `EngineReporter` that discards every report, used
 * by every engine module constructed without one.
 *
 * @example
 * const reporter = options.reporter ?? NOOP_ENGINE_REPORTER;
 * reporter.onCount?.({ runId, metric: 'hook.dispatch', value: 1 });
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

/**
 * The best-score accessors, as the engine consumes them.
 *
 * Ported from the pair js/game_manager.js L80-L82 calls:
 * `getBestScore` at js/local_storage_manager.js L43-L45 and
 * `setBestScore` at L47-L49. src/storage/local-storage-manager.ts
 * satisfies this shape structurally, and neither module imports the
 * other. This port is recorded in docs/DECISION_LOG.md.
 */
export interface BestScorePort {
  /**
   * Reads the persisted best score.
   *
   * js/local_storage_manager.js L44 returns
   * `this.storage.getItem(this.bestScoreKey) || 0`: the raw stored
   * string when a value is present, and the number `0` when it is
   * absent or empty. js/game_manager.js L80 applies the relational
   * operator to that value as returned.
   *
   * TypeScript rejects the relational operator applied to this union
   * and a number, so a caller narrows or asserts the value before
   * comparing; the runtime coercion L80 performs is unchanged by
   * either.
   *
   * @returns The stored string, or the number `0`.
   */
  getBestScore(): string | number;

  /**
   * Persists `score` as the best score.
   *
   * @param score Score to persist, from js/game_manager.js L81.
   * @returns Whatever the implementation reports; the engine reads
   *   nothing from it. The vanilla setter at
   *   js/local_storage_manager.js L47-L49 returned nothing, and
   *   src/storage/local-storage-manager.ts returns a success flag.
   */
  setBestScore(score: number): unknown;
}

/* --------------------------------------------------------------------------
 * Commit-time context
 * ----------------------------------------------------------------------- */

/**
 * The stage-facing slice of a state commit.
 *
 * Has no vanilla analogue: the actuation payload at js/game_manager.js
 * L91-L97 carries `score`, `over`, `won`, `bestScore` and `terminated`,
 * and names no stage. The three members below are the three stage fields
 * the run-state envelope persists, and all three are primitives or the
 * plain `StageGoal` data, so a value of this type is deep-equal to its
 * own `JSON.parse(JSON.stringify(value))` round trip.
 */
export interface StageCommitContext {
  /** Zero-based index of the stage in progress. */
  readonly stageIndex: number;

  /** The stage's clear condition, carried verbatim. */
  readonly goal: StageGoal;

  /**
   * Fraction of `goal.target` reached: finite, and within the closed
   * interval [0, 1].
   */
  readonly goalProgress: number;
}

/**
 * One active relic as a state commit carries it.
 *
 * A structural shape: no relic module is named here, and no member
 * beyond these two is read by the engine.
 */
export interface RelicCommitEntry {
  /** The relic's identifier. */
  readonly id: string;

  /** Charges remaining, absent on a relic with no charge budget. */
  readonly charges?: number;
}

/**
 * The relic-facing slice of a state commit: the active relics in pickup
 * order.
 *
 * A read-only array: the order is carried by the value itself, with
 * index 0 the earliest pickup and the first hook handler invoked.
 */
export type RelicCommitContext = readonly RelicCommitEntry[];

/** The goal `EMPTY_STAGE_CONTEXT` carries: a score target of zero. */
const NEUTRAL_STAGE_GOAL: StageGoal = Object.freeze({
  kind: 'score-threshold' as const,
  target: 0,
});

/**
 * The stage slice committed by an engine constructed without a stage
 * source: stage index 0, a zero-target score goal, and no progress.
 */
export const EMPTY_STAGE_CONTEXT: StageCommitContext = Object.freeze({
  stageIndex: 0,
  goal: NEUTRAL_STAGE_GOAL,
  goalProgress: 0,
});

/**
 * The relic slice committed by an engine constructed without a relic
 * source: no relics.
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
 * @returns The active relics in pickup order, or `EMPTY_RELIC_CONTEXT`
 *   when none is active.
 */
export type RelicCommitContextProvider = () => RelicCommitContext;
