// The rules engine: turn orchestration, state ownership and event
// emission, with no reference to any view.
//
// Ported from js/game_manager.js, which is deleted. Method for method,
// each row a traceability row of docs/TRACEABILITY_MATRIX.md:
//   TR-ENGINE-01  L1-L14    constructor        -> constructor
//   TR-ENGINE-02  L17-L21   restart()          -> restart()
//   TR-ENGINE-03  L24-L27   keepPlaying()      -> continuePlaying()
//   TR-ENGINE-04  L30-L32   isGameTerminated() -> isGameTerminated()
//   TR-ENGINE-05  L35-L59   setup()            -> setup()
//   TR-ENGINE-06  L62-L66   addStartTiles()    -> addStartTiles()
//   TR-ENGINE-07  L69-L76   addRandomTile()    -> addRandomTile()
//   TR-ENGINE-08  L79-L99   actuate()          -> commit()
//   TR-ENGINE-09  L102-L110 serialize()        -> serialize()
//   TR-ENGINE-10  L130-L191 move()             -> move()
// The tile preparation, tile relocation, vector, traversal,
// farthest-position and comparison helpers and the merge branch
// — L113-L127, L146-L180, L194-L236 and L270-L272 — moved to
// src/engine/move-resolver.ts, whose `resolveMove` this file's `move()`
// calls, and the terminal-state checks to
// src/engine/terminal-state.ts.
//
// The members below have no vanilla counterpart and are target-only rows of
// the same matrix; each carries the phrase "no vanilla source" at its
// declaration:
//   TR-ENGINE-11  endStage()
//   TR-ENGINE-12  stageProgress()
//   TR-ENGINE-13  goalInForce()
//   TR-ENGINE-14  resolveMetStageGoal()
//   TR-ENGINE-15  resolveStage()
//   TR-ENGINE-16  hookEnvironment()
//   TR-ENGINE-17  throughPort()
//
// SEVEN CHANGES TO THE PORTED BEHAVIOUR, EACH REQUIRED BY THE SPLIT. Each
// carries its own decision identifier, argued in docs/DECISION_LOG.md and
// named here only so the construct can be found from the log:
//   DL-ENGINE-01  The push call at L91-L97 becomes the `state:commit` event.
//   The engine holds no view reference and calls no renderer.
//
//   DL-ENGINE-02  The two randomness call sites of the vanilla sources — L71
//   and js/grid.js L41 — become draws on the `spawn-value` and
//   `spawn-position` substreams. Those two were the only ones.
//
//   DL-ENGINE-03  The win literal (L170), the spawn distribution (L71), the
//   start-tile count (L7) and the merge condition (L156-L157) are read from
//   `RulesConfig`.
//
//   DL-ENGINE-04  `keepPlaying` at L24-L27 assigned a boolean over the
//   prototype method of the same name. The flag is `continuedPlay` and the
//   method is `continuePlaying()`. The persisted member name is unchanged: it
//   is still written as `keepPlaying` by `serialize()`.
//
//   DL-ENGINE-05  The snapshot L36 read from storage reaches `setup()` as an
//   ARGUMENT. The port is read only where no argument was supplied.
//
//   DL-ENGINE-06  The persistence port L4 constructed is INJECTED and
//   OPTIONAL, and its three snapshot calls are optional members, so a port
//   carrying the best-score pair alone satisfies it and an engine built
//   without one plays a complete game.
//
//   DL-ENGINE-07  The stage goal is evaluated where `onAfterMove` is
//   dispatched, through `evaluateStageGoal` of src/config/stage-config.ts, and
//   a met goal is resolved through `endStage()`. Stage handling has no vanilla
//   source.
//
// TWO IDENTIFIERS, NOT ONE
//   `runId` identifies the run instance and is the value `RunState.runId`
//   persists. `correlationId` is what the observability layer keys records,
//   counters and spans on, and it is derived from the run seed and the run
//   identifier together by src/observability/logger.ts. This module derives
//   neither — it reaches no observability module — so the composition root
//   supplies both and every report and every dispatch context carries both.
//
// Invariants of this module: it reads no DOM, opens no timer, reads no
// clock and touches no storage key of its own — every persistence call
// goes through the injected port.
//
// DL-ENGINE-08 is the run identifier and the correlation identifier being
// separate values, described under TWO IDENTIFIERS, NOT ONE above.

import {
  createDefaultRulesConfig,
  DEFAULT_BOARD_SIZE,
  isSupportedBoardSize,
} from '../config/default-config';
import type { RulesConfig } from '../config/rules-config';
import type {
  StageConfig,
  StageGoal,
  StageGoalProgress,
} from '../config/stage-config';
import {
  DEFAULT_STAGE_CONFIG,
  evaluateStageGoal,
  stageGoalForIndex,
} from '../config/stage-config';
import type { RngStreams } from '../rng/rng-streams';
import type { EngineEvents, MoveBeforeEvent } from './engine-events';
import { createEngineEvents } from './engine-events';
import { Grid } from './grid';
import type { HookBus } from './hook-bus';
import { createHookBus } from './hook-bus';
import type {
  BoardEffect,
  HookEnvironment,
  MergeDispatchPayload,
  MergePayload,
  StageStartPayload,
} from './hooks';
import type { MoveOutcome } from './move-resolver';
import { resolveMove } from './move-resolver';
import {
  highestTileValue,
  isGameTerminated as isTerminated,
  isWinningMergeValue,
  movesAvailable,
} from './terminal-state';
import { Tile } from './tile';
import type {
  BestScorePort,
  CellMatrix,
  CorrelationId,
  Direction,
  EngineReporter,
  RelicCommitContext,
  RelicCommitContextProvider,
  SerializedGameState,
  SerializedTile,
  StageCommitContext,
  StageCommitContextProvider,
} from './types';
import {
  EMPTY_RELIC_CONTEXT,
  EMPTY_STAGE_CONTEXT,
  NOOP_ENGINE_REPORTER,
} from './types';

/* --------------------------------------------------------------------------
 * Constants
 * ----------------------------------------------------------------------- */

/**
 * Value a spawn falls back to when the configured distribution cannot
 * be sampled.
 *
 * js/tile.js L4 coerced a falsy tile value to 2, so 2 is the floor the
 * vanilla sources already guaranteed. Reaching this value consumes no
 * draw, so a substream's cursor is unaffected by the fallback.
 */
const FALLBACK_SPAWN_VALUE = 2;

/** Counter name for one board effect a hook handler asked for and got. */
const EFFECT_APPLIED_METRIC = 'engine.effect.applied';

/** Counter name for one board effect the engine refused as unusable. */
const EFFECT_REFUSED_METRIC = 'engine.effect.refused';

/** Counter name for one stage started through `startStage()`. */
const STAGE_STARTED_METRIC = 'engine.stage.started';

/** Counter name for a stage end refused because the stage had already ended. */
const STAGE_END_REPEATED_METRIC = 'engine.stage.end.repeated';

/**
 * Counter name for a terminal-state or stage-goal measurement that could not
 * be taken.
 *
 * Raised with the engine's `degraded` flag, so a turn whose terminal status is
 * unknown is visible rather than silently committed as playable.
 */
const TERMINAL_UNKNOWN_METRIC = 'engine.terminal.unknown';

/**
 * `value` carried by the `tile:spawn` emission of a full-board attempt.
 *
 * Zero, because no value was drawn: the full-board branch dispatches no
 * `onSpawn` and takes no draw from either substream, and a subscriber reading
 * a spawn value of zero beside an absent position is reading an attempt that
 * inserted nothing. Exported so a subscriber tests against the constant rather
 * than a literal.
 */
export const SUPPRESSED_SPAWN_VALUE = 0;


/** Counter name for a move refused because play is blocked. */
const MOVE_BLOCKED_METRIC = 'engine.move.blocked';

/** Counter name for a move withdrawn by an `onBeforeMove` handler. */
const MOVE_CANCELLED_METRIC = 'engine.move.cancelled';

/** Counter name for a move that changed no cell. */
const MOVE_IDLE_METRIC = 'engine.move.idle';

/**
 * Counter name for one spawn attempt.
 *
 * THE AUTHORITATIVE SPAWN-ATTEMPT BOUNDARY. Raised on entry to the spawn,
 * which is js/game_manager.js L69, so it counts every attempt whether or not
 * a cell was available. The `tile:spawn` event is NOT that boundary: the
 * spawn returns before dispatching `onSpawn` and before emitting when the
 * board is full, which is what keeps a full board free of draws, so an
 * emission count measures resolved spawns instead. Attempts are accounted
 * here and nowhere else.
 */
export const SPAWN_ATTEMPT_METRIC = 'engine.spawn.attempt';

/**
 * Counter name for one spawn attempt that inserted no tile: the board was
 * full, or an `onSpawn` handler returned the payload without a usable cell.
 * The difference between this and `SPAWN_ATTEMPT_METRIC` is the number of
 * tiles inserted.
 */
export const SPAWN_SUPPRESSED_METRIC = 'engine.spawn.suppressed';

/** Counter name for a resolved move. */
const MOVE_RESOLVED_METRIC = 'engine.move.resolved';

/** Counter name for a discarded persisted snapshot. */
const SNAPSHOT_REJECTED_METRIC = 'engine.snapshot.rejected';

/** Counter name for a restored persisted snapshot. */
const SNAPSHOT_RESTORED_METRIC = 'engine.snapshot.restored';

/** Counter name for a board size reconciled away from the configured one. */
const SIZE_RECONCILED_METRIC = 'engine.board.reconciled';

/** Counter name for a stage goal the engine found met and resolved. */
const STAGE_CLEARED_METRIC = 'engine.stage.cleared';

/**
 * Counter name for a loss the engine had declared and then withdrew, because an
 * `onAfterMove` handler's board effect reopened the board it was declared on.
 */
const LOSS_REOPENED_METRIC = 'engine.move.lossReopened';

/**
 * Counter name for a call to the injected persistence port that raised.
 *
 * js/local_storage_manager.js L57-L59 called `setItem` with no handler, so a
 * quota exhaustion left the commit path by raising. Every port call the
 * engine makes now goes through `throughPort()`, which raises this counter
 * instead.
 */
const STORAGE_FAILED_METRIC = 'engine.storage.failed';

/* --------------------------------------------------------------------------
 * Ports
 * ----------------------------------------------------------------------- */

/**
 * The persistence surface the engine consumes.
 *
 * Extends the best-score pair with the three board-snapshot calls
 * js/game_manager.js made — `getGameState` at L36, `setGameState` at L88
 * and `clearGameState` at L18 and L86. Those three are OPTIONAL members, so
 * a port carrying the best-score pair alone — the `BestScorePort` the engine
 * promotes through — satisfies this shape.
 * src/storage/local-storage-manager.ts satisfies it in full
 * structurally; neither module imports the other.
 */
export interface EngineStoragePort extends BestScorePort {
  /**
   * Reads the persisted board snapshot.
   *
   * @returns The parsed snapshot, or anything else — including `null` —
   *   when none is readable. The engine validates the shape itself.
   */
  getGameState?(): unknown;

  /**
   * Persists the board snapshot.
   *
   * @param state Snapshot to write.
   * @returns Whatever the implementation reports; the engine reads
   *   nothing from it.
   */
  setGameState?(state: unknown): unknown;

  /**
   * Discards the persisted board snapshot.
   *
   * @returns Whatever the implementation reports; the engine reads
   *   nothing from it.
   */
  clearGameState?(): unknown;
}

/**
 * Which collaborator resolves a stage whose goal has been met.
 *
 * `'observer'` leaves the resolution to a subscriber, which calls
 * `Engine.endStage()` itself; `'engine'` has the engine call it, from the
 * turn that met the goal. Either way one method resolves the stage.
 */
export type StageResolutionAuthority = 'engine' | 'observer';

/**
 * The authority assumed when none is injected: a subscriber resolves.
 * src/run/run-controller.ts is the subscriber that does so in the composed
 * application.
 */
const DEFAULT_STAGE_RESOLUTION: StageResolutionAuthority = 'observer';

/**
 * The port an engine built without one uses: the absent best score
 * js/local_storage_manager.js L43-L45 reported as the number `0`, and a
 * write that keeps nothing. Its three snapshot members are absent, so no
 * snapshot is read, written or cleared.
 */
const NOOP_STORAGE_PORT: EngineStoragePort = Object.freeze({
  getBestScore(): 0 {
    return 0;
  },
  setBestScore(): boolean {
    return false;
  },
});

/** Construction parameters. `streams` is the only required member. */
export interface EngineOptions {
  /**
   * The rules in force. Every member is read at use time, so a value
   * changed between turns takes effect on the next turn. Defaults to a
   * fresh `createDefaultRulesConfig()`, which reproduces the vanilla rules.
   */
  readonly config?: RulesConfig;

  /**
   * The run's seeded substreams. Every draw the engine takes is one of
   * these. Required: the engine constructs no generator and consumes no
   * other source of randomness.
   */
  readonly streams: RngStreams;

  /**
   * The progression curve, read for the goal of the stage in force when the
   * stage source supplies none of its own. Defaults to
   * `DEFAULT_STAGE_CONFIG`.
   */
  readonly stages?: StageConfig;

  /** Which collaborator resolves a met goal. Defaults to `'observer'`. */
  readonly stageResolution?: StageResolutionAuthority;

  /**
   * Persistence port. Defaults to a port reporting no best score and
   * keeping nothing, so an engine built without one plays a complete game
   * and persists nothing.
   */
  readonly storage?: EngineStoragePort;

  /** Event emitter. One is created when none is supplied. */
  readonly events?: EngineEvents;

  /** Hook bus. One is created when none is supplied. */
  readonly hooks?: HookBus;

  /** Sink for caught errors and counters. */
  readonly reporter?: EngineReporter;

  /**
   * Correlation identifier of the run, carried into every report and
   * into every hook context. Injected, never derived here: the one
   * authority is `deriveCorrelationId` in src/observability/logger.ts,
   * and src/main.ts supplies the value it derives from the run seed.
   * Defaults to the empty string, which reports no correlation rather
   * than putting the seed itself into a report.
   */
  readonly correlationId?: CorrelationId;

  /**
   * Supplies the stage slice of every commit. Defaults to a provider
   * returning `EMPTY_STAGE_CONTEXT`.
   */
  readonly stageContext?: StageCommitContextProvider;

  /**
   * Supplies the relic slice of every commit. Defaults to a provider
   * returning `EMPTY_RELIC_CONTEXT`.
   */
  readonly relicContext?: RelicCommitContextProvider;

  /**
   * Span wrappers for the boundaries inside a turn. Absent, the turn runs
   * exactly as it ran before tracing existed.
   */
  readonly tracing?: EngineTracing;
}

/**
 * The span wrappers the engine runs its own internal boundary inside.
 *
 * DECLARED HERE, STRUCTURALLY, AND NEVER IMPORTED. src/engine names no module
 * under src/observability — the engine is the DOM-free, dependency-free half of
 * the split (AAP R1) — so the wrapper is injected in the same way the hook bus
 * takes `HookBusTracing` and the run controller takes `RelicRegistryPort`.
 * `BoundaryTracing` of src/observability/tracer.ts satisfies this shape without
 * either module naming the other.
 *
 * The wrapper must run the function it is handed exactly once and return its
 * value, and rethrow whatever it threw: it is a measurement, never a
 * transformation.
 */
export interface EngineTracing {
  /**
   * Wraps the traversal walk and the merge resolution of one turn.
   *
   * INSIDE THE TURN, DELIBERATELY. It is opened after `move:before` has been
   * emitted and the veto resolved, so a turn span opened by that emission
   * ENCLOSES this one. Wrapping `Engine.move()` from the composition root
   * instead would invert that nesting and make the resolution appear to
   * contain the turn it is part of.
   */
  readonly traceMoveResolution?: <T>(run: () => T) => T;
}

/* --------------------------------------------------------------------------
 * Snapshot validation
 * ----------------------------------------------------------------------- */

/**
 * Narrows an unknown value to a plain object.
 *
 * @param value Value to test.
 * @returns `true` when it is a non-null object and not an array.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads one persisted cell, reduced to a tile the grid can restore safely.
 *
 * THE POSITION IS NORMALISED TO THE CELL THAT HOLDS IT. `Grid.fromState`
 * builds each tile from the recorded `position` while placing it at the matrix
 * coordinate it was found at, so a snapshot whose two disagree produced a tile
 * that believed it was somewhere it was not — and the first move then indexed
 * `grid.cells[tile.x]` at a column outside the lattice and threw. The recorded
 * position is therefore accepted only as far as it is usable and the cell
 * coordinate is authoritative.
 *
 * The value is also bounded: a tile value that is not a finite number above
 * zero is not a tile. `Tile` coerces a falsy value to 2, which would silently
 * turn a corrupted entry into a playable tile of a value the snapshot never
 * held.
 *
 * @param value Value read from the matrix.
 * @param x Column the value was found at.
 * @param y Row the value was found at.
 * @returns The tile to restore, or `null` where the cell holds no usable tile.
 */
function readSerializedTile(
  value: unknown,
  x: number,
  y: number,
): SerializedTile | null {
  if (!isRecord(value)) {
    return null;
  }

  const face = value.value;

  if (typeof face !== 'number' || !Number.isFinite(face) || face <= 0) {
    return null;
  }

  return { position: { x, y }, value: face };
}

/**
 * Reduces an unknown cell matrix to one the grid can restore from.
 *
 * Anything that is not a usable serialised tile becomes an empty cell, so a
 * partially corrupted matrix loses tiles rather than failing the load. The
 * matrix is walked to the SIZE THE SNAPSHOT DECLARED rather than to the length
 * the stored arrays happen to have, so a matrix wider or taller than the
 * declared board contributes nothing outside it, and every tile that survives
 * carries the coordinate of the cell it occupies.
 *
 * @param value Value read from the snapshot.
 * @param size Declared edge length, already bounded by `isSupportedBoardSize`.
 * @returns The matrix, or `null` when the value is not a matrix at all.
 */
function readCellMatrix(
  value: unknown,
  size: number,
): CellMatrix<SerializedTile> | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const columns: CellMatrix<SerializedTile> = [];

  for (const column of value) {
    if (!Array.isArray(column)) {
      return null;
    }
  }

  for (let x = 0; x < size; x += 1) {
    const stored: unknown = value[x];
    const column: (SerializedTile | null)[] = [];

    for (let y = 0; y < size; y += 1) {
      const cell: unknown = Array.isArray(stored) ? stored[y] : null;

      column.push(readSerializedTile(cell, x, y));
    }

    columns.push(column);
  }

  return columns;
}

/**
 * Validates a persisted snapshot without throwing.
 *
 * js/local_storage_manager.js L47-L50 parsed the stored value with no
 * guard, so a corrupted entry threw during startup;
 * src/storage/local-storage-manager.ts contains the parse, and this
 * function contains the shape. A snapshot that fails any check is
 * discarded and the engine starts fresh.
 *
 * @param value Value the storage port returned.
 * @returns The snapshot, or `null` when it is unusable.
 */
function readSnapshot(value: unknown): SerializedGameState | null {
  if (!isRecord(value)) {
    return null;
  }

  const grid = value.grid;

  if (!isRecord(grid)) {
    return null;
  }

  // BOUNDED BY THE PRODUCT-WIDE CEILING, not merely by being a positive
  // integer. This size drives a `size` by `size` allocation in `Grid` and the
  // two loops of every traversal, so a stored value of 2**40 froze startup on
  // every load until the entry was cleared by hand. `isSupportedBoardSize` of
  // src/config/default-config.ts is the one predicate src/run/ and src/render/
  // already measure an edge against; the engine now measures against it too,
  // and does so BEFORE any grid is constructed.
  if (!isSupportedBoardSize(grid.size)) {
    return null;
  }

  const cells = readCellMatrix(grid.cells, grid.size);

  if (cells === null) {
    return null;
  }

  if (typeof value.score !== 'number' || !Number.isFinite(value.score)) {
    return null;
  }

  return {
    grid: { size: grid.size, cells },
    score: value.score,
    over: value.over === true,
    won: value.won === true,
    keepPlaying: value.keepPlaying === true,
  };
}

/* --------------------------------------------------------------------------
 * The engine
 * ----------------------------------------------------------------------- */

/**
 * The rules engine.
 *
 * Owns the board, the score and the three state flags, resolves moves,
 * dispatches the six hooks and emits the events of the engine event
 * contract. It holds no reference to a renderer, to a screen or to
 * anything the browser supplies.
 *
 * @example
 * ```ts
 * const engine = new Engine({ streams });
 *
 * engine.events.on('state:commit', (commit) => renderer.render(commit));
 * engine.setup();
 * engine.move(0); // up
 * ```
 */
export class Engine {
  /** The rules in force. Read at use time on every turn. */
  readonly config: RulesConfig;

  /** The progression curve a stage goal is read from at use time. */
  readonly stages: StageConfig;

  /** Which collaborator resolves a met stage goal. */
  readonly stageResolution: StageResolutionAuthority;

  /** The run's substreams. */
  readonly streams: RngStreams;

  /** The event emitter every subscriber attaches to. */
  readonly events: EngineEvents;

  /** The hook bus relics register on. */
  readonly hooks: HookBus;

  /** Correlation identifier of the run, exactly as it was injected. */
  readonly correlationId: CorrelationId;

  /** The board. Replaced by `setup()`, mutated in place by a move. */
  grid: Grid;

  /** Accumulated score. Ported from js/game_manager.js L48. */
  score: number;

  /** Whether the game is lost. Ported from L49. */
  over: boolean;

  /** Whether the win value has been reached. Ported from L50. */
  won: boolean;

  /**
   * Whether play continued past the win.
   *
   * The flag js/game_manager.js L25 assigned over its own prototype
   * method. Renamed here; the persisted member name `keepPlaying` is
   * unchanged.
   */
  continuedPlay: boolean;

  /** Persistence port. */
  private readonly storage: EngineStoragePort;

  /** Sink for caught errors and counters. */
  private readonly reporter: EngineReporter;

  /** Supplies the stage slice of a commit. */
  private readonly stageContext: StageCommitContextProvider;

  /** Supplies the relic slice of a commit. */
  private readonly relicContext: RelicCommitContextProvider;

  /**
   * Runs the traversal walk and merge resolution of a turn inside its span.
   *
   * Identity where no wrapper was injected, so the untraced turn is exactly the
   * turn that ran before tracing existed.
   */
  private readonly traceResolution: <T>(run: () => T) => T;

  /**
   * The stage goal an `onStageStart` handler returned, and `null` while the
   * goal in force is the one the provider supplies.
   *
   * `goal` is the transformable member of `onStageStart`, so the goal a
   * handler returns has to reach the stage rather than being reported and
   * dropped. Assigned by `setup()` from the resolved dispatch and read by
   * `resolveStage()`, which is the one path a commit's stage slice is built
   * through.
   */
  private stageGoalOverride: StageGoal | null;

  /**
   * Whether the stage in progress has already been resolved.
   *
   * THE ONE-SHOT STAGE-END GUARD. A stage's goal stays satisfied for every turn
   * after the one that met it — the highest tile does not fall and the score
   * does not drop — so without this the engine would dispatch `onStageEnd` and
   * emit `stage:end` again on every later commit. Set by `endStage()` and
   * cleared only by `startStage()` and by the fresh-board paths of `setup()`.
   */
  private stageEnded: boolean;

  /**
   * Whether the last turn's terminal status could not be established.
   *
   * Read through `isDegraded()`. A measurement that raises leaves this set and
   * raises `TERMINAL_UNKNOWN_METRIC`, so a turn whose loss state is unknown is
   * surfaced rather than committed as playable and forgotten. Cleared by the
   * next turn whose measurement succeeds, and by every board rebuild.
   */
  private terminalUnknown: boolean;

  /**
   * Monotonic turn counter, raised once for every commit the engine emits.
   *
   * Carried on `tile:merge`, `tile:spawn`, `move:after` and `state:commit`, so a
   * view that buffers granular events can tell which commit they belong to and
   * discard the ones orphaned by a restart, a stage transition or a lost
   * rendering context. Never reset: a monotonic value is what makes an orphan
   * detectable at all.
   */
  private turnCounter: number;

  /**
   * @param options The substreams, and optionally the rules, the
   *   progression curve, the stage-resolution authority, the persistence
   *   port, the emitter, the bus, the reporter, the correlation identifier,
   *   the two context providers and the tracing port. Every member but
   *   `streams` carries a default, so `new Engine({ streams })` plays a
   *   complete vanilla game.
   */
  constructor(options: EngineOptions) {
    this.config = options.config ?? createDefaultRulesConfig();
    this.streams = options.streams;
    this.stages = options.stages ?? DEFAULT_STAGE_CONFIG;
    this.stageResolution =
      options.stageResolution ?? DEFAULT_STAGE_RESOLUTION;
    this.storage = options.storage ?? NOOP_STORAGE_PORT;
    this.reporter = options.reporter ?? NOOP_ENGINE_REPORTER;
    this.correlationId = options.correlationId ?? '';
    // The emitter is handed the reporter, so a listener that throws is
    // contained and reported rather than aborting the emission.
    this.events =
      options.events ??
      createEngineEvents({
        correlationId: this.correlationId,
        reporter: this.reporter,
      });
    this.hooks =
      options.hooks ??
      createHookBus({
        correlationId: this.correlationId,

        reporter: this.reporter,
      });
    this.stageContext =
      options.stageContext ?? ((): StageCommitContext => EMPTY_STAGE_CONTEXT);
    this.relicContext =
      options.relicContext ?? ((): RelicCommitContext => EMPTY_RELIC_CONTEXT);

    // Read once and bound, rather than read per turn off the options object:
    // the wrapper is a composition-time decision, and a turn must not pay a
    // property lookup per move for a capability it may not have.
    const traceMoveResolution = options.tracing?.traceMoveResolution;

    this.traceResolution =
      traceMoveResolution === undefined
        ? <T>(run: () => T): T => run()
        : traceMoveResolution;

    // Constructed empty so every field is initialised before `setup()`
    // decides whether the board is restored or fresh. js/game_manager.js
    // L13 called `setup()` from its constructor; here the caller does,
    // so a subscriber can attach before the first commit is emitted.
    // Bounded here for the same reason `setup()` bounds it: this is an
    // allocation of `size` by `size` cells, and the configured value reaches it
    // before any snapshot has been read.
    this.grid = new Grid(
      isSupportedBoardSize(this.config.boardSize)
        ? this.config.boardSize
        : DEFAULT_BOARD_SIZE,
    );
    this.score = 0;
    this.over = false;
    this.won = false;
    this.continuedPlay = false;
    this.stageGoalOverride = null;
    this.stageEnded = false;
    this.terminalUnknown = false;
    this.turnCounter = 0;
  }

  /**
   * Reports whether the last turn's terminal status could not be established.
   *
   * Has no vanilla source. `true` means a loss or stage-goal measurement raised:
   * the board and the score are the ones the turn produced, and whether play is
   * blocked is unknown. A caller surfaces this rather than treating the turn as
   * playable.
   *
   * @returns `true` while the engine is in the degraded state.
   */
  isDegraded(): boolean {
    return this.terminalUnknown;
  }

  /**
   * The number of commits the engine has emitted.
   *
   * Has no vanilla source. The value carried on `tile:merge`, `tile:spawn`,
   * `move:after` and `state:commit` as `turn`.
   *
   * @returns The monotonic turn counter.
   */
  currentTurn(): number {
    return this.turnCounter;
  }

  /**
   * Reports whether the stage in progress has already been resolved.
   *
   * @returns `true` once `endStage()` has run for this stage and until
   *   `startStage()` or a fresh `setup()` opens the next one.
   */
  hasStageEnded(): boolean {
    return this.stageEnded;
  }

  /**
   * Assembles the stage slice of a commit.
   *
   * Has no vanilla source. The provider is authoritative for `stageIndex`
   * and `goalProgress`; `goal`
   * is the one an `onStageStart` handler returned where one did, so each
   * stage-carrying payload — `stage:start`, `stage:end`, `state:commit` —
   * reports the goal the stage is actually running against.
   *
   * @returns The stage slice.
   */
  private resolveStage(): StageCommitContext {
    const context = this.stageContext();
    const adopted = this.stageGoalOverride;

    if (adopted === null || adopted === context.goal) {
      return context;
    }

    return Object.freeze({
      stageIndex: context.stageIndex,
      goal: adopted,
      goalProgress: context.goalProgress,
    });
  }

  /**
   * Makes one call to the injected persistence port, containing a failure.
   *
   * Has no vanilla source. The port is injected and structural, so any of
   * its five calls may raise;
   * js/game_manager.js L79-L99 made all of them bare. A raise is counted
   * under `engine.storage.failed` and the fallback stands in for the call's
   * value, so a turn completes and the board stays consistent.
   *
   * @param call The port call to make.
   * @param fallback Value taken when the call raises.
   * @returns The call's own value, or `fallback` where it raised.
   */
  private throughPort<T>(call: () => T, fallback: T): T {
    try {
      return call();
    } catch {
      this.reporter.onCount?.({
        correlationId: this.correlationId,
        metric: STORAGE_FAILED_METRIC,
        value: 1,
      });

      return fallback;
    }
  }

  /**
   * The goal the stage in progress is measured against.
   *
   * Has no vanilla source. Three sources in precedence order: the goal an
   * `onStageStart` handler adopted, then the injected stage source's own
   * goal, and finally `stageGoalForIndex()` over the injected curve — which
   * is reached whenever the two above it yield `EMPTY_STAGE_CONTEXT`'s
   * neutral goal, the zero-target goal src/engine/types.ts declares for an
   * engine built without a stage source. `setup()` adopts the resolved
   * `onStageStart` goal on every stage start, so the adopted goal is that
   * same neutral object where no handler replaced it.
   *
   * Read only by `stageProgress()`. The stage slice `resolveStage()`
   * assembles for `stage:start`, `stage:end` and `state:commit` reports the
   * source's own goal and is not affected by the fallback.
   *
   * @returns The goal in force.
   */
  private goalInForce(): StageGoal {
    const context = this.stageContext();
    const adopted = this.stageGoalOverride;
    const goal = adopted === null ? context.goal : adopted;

    if (goal !== EMPTY_STAGE_CONTEXT.goal) {
      return goal;
    }

    // `stageGoalForIndex` raises on an index that is not a non-negative
    // integer, and the index reaches it from an injected provider, so an
    // index it would refuse leaves the neutral goal in force rather than
    // raising out of a query.
    if (!Number.isInteger(context.stageIndex) || context.stageIndex < 0) {
      return goal;
    }

    return stageGoalForIndex(context.stageIndex, this.stages);
  }

  /**
   * Measures the stage in progress against its goal.
   *
   * Has no vanilla source. A query: it emits nothing, dispatches nothing,
   * counts nothing and mutates nothing, so a subscriber may call it as
   * freely as the turn pipeline does. `move()` calls it once per resolved
   * move, which is where `onAfterMove` is dispatched.
   *
   * The two measured quantities are the live score and
   * `highestTileValue()` of src/engine/terminal-state.ts over the board in
   * force, which are the two members of `StageProgressInput`.
   *
   * @returns The measured quantity, the fraction of the target reached, and
   *   whether the goal is met.
   */
  stageProgress(): StageGoalProgress {
    return evaluateStageGoal(this.goalInForce(), {
      score: this.score,
      highestTileValue: highestTileValue(this.grid),
    });
  }

  /**
   * Builds the board, restoring a snapshot when one is readable, and
   * commits the result.
   *
   * Ported from js/game_manager.js L35-L59. Three additions: the snapshot
   * arrives as an argument rather than from the read L36 performed, the
   * board size is reconciled before the grid is constructed, and
   * `onStageStart` is dispatched before the start tiles are inserted so
   * a spawn-affecting handler applies to them.
   *
   * @param previousState The snapshot to restore, or `null` to start fresh
   *   without consulting the port. Omit it to fall back to the port's
   *   `getGameState()` — the read js/game_manager.js L36 performed — which
   *   is skipped entirely whenever an argument is supplied. The value is
   *   validated either way, so a caller may pass an unvalidated snapshot;
   *   src/run/run-controller.ts owns the version-tolerant load that
   *   produces one.
   */
  setup(previousState?: SerializedGameState | null): void {
    const supplied = previousState !== undefined;
    const source: unknown = supplied
      ? previousState
      : this.throughPort(() => this.storage.getGameState?.(), null);
    const snapshot = readSnapshot(source);
    const restored = snapshot !== null;

    if (snapshot === null) {
      this.reporter.onCount?.({
        correlationId: this.correlationId,

        metric: SNAPSHOT_REJECTED_METRIC,
        value: 1,
      });
    } else {
      this.reporter.onCount?.({
        correlationId: this.correlationId,

        metric: SNAPSHOT_RESTORED_METRIC,
        value: 1,
      });
    }

    // Board-size reconciliation. A snapshot carries the size its board
    // was built at, and that size is authoritative for the tiles inside
    // it: rebuilding at a different size would move or drop them. The
    // reconciled value is written back to the configuration, so every
    // later read — including the win and loss checks — sees the size the
    // lattice actually has rather than a captured constant.
    //
    // Both candidates are measured against the product-wide ceiling before
    // either reaches `new Grid()`: a snapshot's size was bounded as it was
    // read, and the configured size is bounded here because a board-mutating
    // relic writes it during a run. An unsupported configured size falls back
    // to the default edge length rather than allocating from it.
    const configured = isSupportedBoardSize(this.config.boardSize)
      ? this.config.boardSize
      : DEFAULT_BOARD_SIZE;
    const size = snapshot === null ? configured : snapshot.grid.size;

    if (size !== this.config.boardSize) {
      this.reporter.onCount?.({
        correlationId: this.correlationId,

        metric: SIZE_RECONCILED_METRIC,
        value: 1,
      });
      this.config.boardSize = size;
    }

    if (snapshot === null) {
      this.grid = new Grid(size);
      this.score = 0;
      this.over = false;
      this.won = false;
      this.continuedPlay = false;
    } else {
      this.grid = new Grid(size, snapshot.grid.cells);
      this.score = snapshot.score;
      this.over = snapshot.over;
      this.won = snapshot.won;
      this.continuedPlay = snapshot.keepPlaying;
    }

    const started = this.beginStage();

    if (!restored) {
      this.addStartTiles();
    }

    this.events.emit('stage:start', started);

    this.commit();
  }

  /**
   * Dispatches `onStageStart` for the stage the provider now reports and
   * adopts the goal the dispatch resolved.
   *
   * Has no vanilla source. Shared by `setup()` and `startStage()`, which are
   * the two ways a stage begins; it emits nothing and commits nothing, so each
   * caller owns the order its own emission and commit take. `setup()` inserts
   * the start tiles between this dispatch and its emission, which is why the
   * insertion is not done here: a spawn-affecting handler must be bound before
   * the tiles it applies to are drawn.
   *
   * @returns The resolved `onStageStart` payload, which is what `stage:start`
   *   carries.
   */
  private beginStage(): StageStartPayload {
    // A new stage starts from the provider's own goal, so a goal adopted for
    // the stage before this one is not carried into the dispatch below.
    this.stageGoalOverride = null;

    const stage = this.stageContext();

    // The dispatch's resolved payload is ADOPTED rather than discarded:
    // `goal` is the one transformable member of `onStageStart`, so the goal a
    // handler returned is the goal this stage runs against and is the goal
    // `stage:start` carries. The three invariant members cannot have
    // changed — the bus refuses a return that changes any of them.
    const started = this.hooks.dispatch(
      'onStageStart',
      {
        stageIndex: stage.stageIndex,
        goal: stage.goal,
        seed: this.streams.seed,
        boardSize: this.grid.size,
      },
      this.hookEnvironment(),
    );

    this.stageGoalOverride = started.payload.goal;

    // Board commands the stage-start dispatch wrote reached the board DURING the
    // dispatch and before the start tiles are inserted, so a relic that resized
    // or reseated the board for the opening position has those tiles placed on
    // the board it asked for. Accounted for here.
    this.accountEffects(started.effects, started.effectsRefused);

    // A board opened afresh — or reopened at another edge length — has its own
    // terminal status and its own unresolved stage.
    this.stageEnded = false;
    this.terminalUnknown = false;

    return started.payload;
  }

  /**
   * Starts the next stage of the run in progress.
   *
   * Has no vanilla source. The counterpart of `endStage()`: `endStage()`
   * resolves the stage that finished, and this begins the one that follows it,
   * so a run advances through stages without the board being rebuilt. The
   * grid, the score, the win flag and the continued-play flag are all left
   * exactly as they stand — only the stage is new — which is what separates
   * this from `setup()`, whose job is to build a board.
   *
   * No start tiles are inserted, for the same reason: the tiles in play carry
   * over into the new stage.
   *
   * THE STAGE INDEX COMES FROM THE INJECTED PROVIDER, not from an argument.
   * The provider is the authority for which stage is current — under the
   * `'observer'` resolution src/run/run-controller.ts owns it — so a caller
   * advances the provider and then calls this, and the two steps together are
   * the stage transition. Calling this without having advanced restarts the
   * same stage rather than raising.
   *
   * @param board Snapshot to REBUILD the board from for the stage that is
   *   starting, or `null` to rebuild it fresh at the configured edge length.
   *   Omitted — which is what a stage transition wants — the board in play is
   *   carried into the new stage untouched.
   */
  startStage(board?: SerializedGameState | null): void {
    this.reporter.onCount?.({
      correlationId: this.correlationId,
      metric: STAGE_STARTED_METRIC,
      value: 1,
    });

    // Released before either path below runs, so the dispatch each makes and the
    // commit it ends with both see an unresolved stage.
    this.stageEnded = false;

    // The REBUILDING path, for a caller that opens the stage on a board of its
    // own: `setup()` installs the lattice, dispatches `onStageStart` through
    // `beginStage()`, emits and commits, so nothing is done twice here.
    if (board !== undefined) {
      this.setup(board);

      return;
    }

    this.events.emit('stage:start', this.beginStage());

    this.commit();
  }

  /**
   * The goal the stage in progress is actually measured against.
   *
   * Has no vanilla source. THE ONE GOAL AUTHORITY. `goalInForce()` resolves
   * three sources in precedence order — the goal an `onStageStart` handler
   * adopted, the injected provider's own goal, then the configured curve — and
   * this exposes that result so an observer measures against the same goal the
   * engine does. A subscriber that measured against its own recorded goal
   * instead would disagree with the engine whenever a handler replaced it.
   *
   * A query: it emits nothing, dispatches nothing and mutates nothing.
   *
   * @returns The goal in force, as `stage:start` carried it.
   */
  stageGoalInForce(): StageGoal {
    return this.goalInForce();
  }

  /**
   * Discards the persisted snapshot and starts a fresh board.
   *
   * Ported from js/game_manager.js L17-L21. The actuator call at L19
   * that cleared the win and loss message is not made here: the commit
   * `setup()` ends with carries `terminated` as `false`, which is what a
   * view clears the message on.
   *
   * `setup(null)` is called rather than `setup()`. The clear above goes
   * through `throughPort`, so a port that raised leaves the stored snapshot
   * in place and counts the failure; the argument-less form would then read
   * that surviving snapshot back and restart onto the board being discarded.
   * Passing `null` skips the port read entirely, so a restart is a fresh
   * board whether or not the clear succeeded.
   */
  restart(): void {
    this.throughPort(() => this.storage.clearGameState?.(), undefined);
    this.setup(null);
  }

  /**
   * Continues play past the win.
   *
   * Ported from js/game_manager.js L24-L27. The flag it assigned over
   * its own method name is `continuedPlay`, and the actuator call at
   * L26 becomes a commit whose `terminated` is now `false`.
   *
   * TWO NAMES THE RENAME LEAVES UNCHANGED. The input event name L11
   * subscribed with is still `keepPlaying`, and src/main.ts wires it to
   * this method; the persisted member name L108 wrote is still
   * `keepPlaying`, and `serialize()` writes it.
   */
  continuePlaying(): void {
    this.continuedPlay = true;

    this.commit();
  }

  /**
   * Assembles the live collaborators handed to every hook handler.
   *
   * Extension with no vanilla source. Rebuilt on each dispatch, so every
   * member is the instance in force: `setup()` replaces `this.grid` on
   * every stage start and every restore.
   *
   * @returns The environment for one dispatch.
   */
  private hookEnvironment(): HookEnvironment {
    return {
      config: this.config,
      rng: this.streams,
      grid: this.grid,
    };
  }

  /**
   * Reports whether play is blocked pending an acknowledgement.
   *
   * Ported from js/game_manager.js L30-L32.
   *
   * @returns `true` when the engine refuses further moves.
   */
  isGameTerminated(): boolean {
    return isTerminated({
      over: this.over,
      won: this.won,
      continuedPlay: this.continuedPlay,
    });
  }

  /**
   * Projects the game to its persisted form.
   *
   * Ported from js/game_manager.js L102-L110. The member name
   * `keepPlaying` is the persisted name and is frozen, so a snapshot
   * written by the vanilla game loads here and one written here loads
   * there.
   *
   * @returns A fresh plain object.
   */
  serialize(): SerializedGameState {
    return {
      grid: this.grid.serialize(),
      score: this.score,
      over: this.over,
      won: this.won,
      keepPlaying: this.continuedPlay,
    };
  }

  /**
   * Resolves one move.
   *
   * Ported from js/game_manager.js L130-L191, with the three hook
   * dispatches the split adds. A move that changes no cell spawns
   * nothing and commits nothing, which is L182's behaviour; it does emit
   * `move:after` carrying `moved: false`, which is the completion signal
   * L182's silent return had no equivalent of.
   *
   * @param direction Direction to move in: 0 up, 1 right, 2 down, 3
   *   left.
   * @returns `true` when the board changed.
   */
  move(direction: Direction): boolean {
    // Ported from L134.
    if (this.isGameTerminated()) {
      this.reporter.onCount?.({
        correlationId: this.correlationId,

        metric: MOVE_BLOCKED_METRIC,
        value: 1,
      });

      return false;
    }

    // EMITTED BEFORE THE DECISION, and CANCELLABLE, which is what AAP
    // Contract 1 declares `move:before` to be. `cancelled` is the one
    // writable member on any event payload: a listener that sets it withdraws
    // the move, and the value is read back below and carried into the hook
    // dispatch, so an `onBeforeMove` handler sees a veto a listener already
    // cast. Emitted for every requested move, vetoed or not, so a subscriber
    // sees the attempt as well as its outcome.
    const requested: MoveBeforeEvent = {
      direction,
      board: this.grid,
      cancelled: false,
    };

    this.events.emit('move:before', requested);

    // The hook path is the PRIVILEGED one: it is seeded with the veto a
    // listener cast, and unlike a listener it can also redirect the move.
    // `direction` is seeded from the REQUESTED direction rather than from the
    // emitted payload, so `cancelled` is the only member a listener changes the
    // turn through — which is the whole of what AAP Contract 1 declares
    // cancellable.
    const before = this.hooks.dispatch(
      'onBeforeMove',
      {
        direction,
        board: this.grid,
        cancelled: requested.cancelled === true,
      },
      this.hookEnvironment(),
    );

    // Board commands the pre-move dispatch wrote reached the board DURING the
    // dispatch and so before the walk: undo restoring an anchored position, a
    // permutation and an excision are all recorded here, and each is on the board
    // the move then resolves against — or, for a withdrawn move, is the board the
    // turn leaves behind. Accounted for here, and whether anything was written is
    // what decides that a withdrawn move still commits.
    const reseated = this.accountEffects(
      before.effects,
      before.effectsRefused,
    );

    // The resolved veto: what a listener cast, as carried into the dispatch,
    // and what any `onBeforeMove` handler cast on top of it.
    const cancelled = before.payload.cancelled;

    if (cancelled) {
      this.reporter.onCount?.({
        correlationId: this.correlationId,

        metric: MOVE_CANCELLED_METRIC,
        value: 1,
      });

      // A withdrawn move normally changes nothing and commits nothing, which is
      // L134's behaviour. A withdrawn move that ALSO reseated the board — undo
      // is exactly that pairing — has changed state, so it commits, or the board
      // the engine holds and the board every view shows would diverge until the
      // next resolved turn.
      if (reseated) {
        this.commit();
      }

      return false;
    }

    // The direction the move RESOLVES in is the one the HOOK payload carries,
    // not the one the caller asked for: `direction` is a transformable member
    // of `onBeforeMove`, so a handler that returned another direction
    // redirects the move.
    const resolved = before.payload.direction;

    // Ported from L138-L143 and L146-L180, which
    // src/engine/move-resolver.ts owns: the vector, the two traversal
    // orders, the tile preparation, the walk, the merge branch and the
    // change signal. The board is mutated in place, as those lines did.
    // The `onMerge` dispatch reaches the merge branch as a callback, and
    // a handler's `resultValue` is the value written to the board.
    // Wrapped in the resolution span, which the turn span opened by the
    // emission above encloses. Identity where no wrapper was injected.
    const outcome = this.traceResolution((): MoveOutcome =>
      resolveMove(this.grid, resolved, this.config, {
        dispatchMerge: (payload: MergeDispatchPayload): MergePayload =>
          this.hooks.dispatch('onMerge', payload, this.hookEnvironment())
            .payload,
      }),
    );

    // Ported from L167: the sum of the additions each merge made, every
    // one of which an `onMerge` handler may have transformed.
    this.score += outcome.scoreDelta;

    for (const merge of outcome.merges) {
      // Ported from L170: strict equality against the configured value.
      if (isWinningMergeValue(merge.merged.value, this.config)) {
        this.won = true;
      }

      // The pair L158 assigned to `mergedFrom` travels by reference: both
      // tiles are out of `grid.cells` by L161 and reach a subscriber as
      // live references alone.
      this.events.emit('tile:merge', {
        // The commit this merge belongs to, which is the NEXT one the engine
        // emits: a view buffering merge animations replays them against that
        // commit and discards anything left over from an earlier turn.
        turn: this.turnCounter + 1,
        source: merge.source,
        target: merge.target,
        resultValue: merge.merged.value,
        scoreDelta: merge.scoreDelta,
      });
    }

    // Ported from L175-L177 through the resolver's outcome.
    if (!outcome.moved) {
      this.reporter.onCount?.({
        correlationId: this.correlationId,

        metric: MOVE_IDLE_METRIC,
        value: 1,
      });

      // THE COMPLETION SIGNAL OF A TURN THAT CHANGED NOTHING. Emitted from
      // the state already in force, so nothing here writes engine state: no
      // hook is dispatched, no tile is spawned, the loss check is not run,
      // nothing is persisted and no commit is made. L182-L190's `if (moved)`
      // block stays skipped exactly as it was; this emission is beside that
      // block, not inside it.
      //
      // `moved` is `false`, and `score`, `over` and `won` are the values the
      // turn began with because the resolver reported no change. A subscriber
      // that opened work on `move:before` closes it here rather than holding
      // it open until the next turn supersedes it.
      this.events.emit('move:after', {
        // The turn this emission ends, numbered as every granular event of a
        // turn is: the counter advances only on a commit, and this turn makes
        // none, so the number is the one the NEXT committed turn will carry.
        turn: this.turnCounter + 1,
        moved: false,
        board: this.grid,
        score: this.score,
        over: this.over,
        won: this.won,
        terminated: this.isGameTerminated(),
      });

      return false;
    }

    // Ported from L183.
    this.addRandomTile();

    // Ported from L185-L187. The live configuration travels with the
    // board, so the neighbour probe reads the merge predicate in force
    // rather than a comparison of its own.
    //
    // The probe reads an injected merge predicate, so it CAN raise. A raise no
    // longer resolves to `over = false`: `measured()` records the engine as
    // degraded and raises `TERMINAL_UNKNOWN_METRIC`, the loss flag is left
    // exactly as it stood rather than being asserted, and the commit below
    // carries `degraded: true` so a view and the diagnostics surface both see
    // that this turn's terminal status could not be established.
    const available = this.measured((): boolean =>
      movesAvailable(this.grid, this.config),
    );

    if (available === false) {
      this.over = true;
    }

    if (available !== null) {
      this.terminalUnknown = false;
    }

    // The verdict as the ENGINE left it, kept so a handler that changed the
    // board can be told apart from one that declared the run lost.
    const lostBeforeDispatch = this.over;

    const after = this.hooks.dispatch(
      'onAfterMove',
      {
        moved: true,
        board: this.grid,
        score: this.score,
        over: this.over,
        won: this.won,
        terminated: this.isGameTerminated(),
      },
      this.hookEnvironment(),
    );

    // Every transformable member of `onAfterMove` is applied, and only those:
    // `score`, `over` and `won` are adopted from the resolved payload — a
    // handler may rescore the turn, declare the game lost, or declare it won,
    // which is how a cursed relic ends a run and how an alternative win
    // condition is expressed. `board` and `moved` are invariant and the bus
    // refuses a return that changes either. `terminated` is DERIVED from the
    // adopted `over` and `won` rather than read back, so a handler cannot
    // leave a flag that contradicts them.
    const declaredOver = after.payload.over;

    this.score = after.payload.score;
    this.over = declaredOver;
    this.won = after.payload.won;

    // Board commands the post-move dispatch wrote — a line clear is the case
    // this exists for — reached the board before the emission below, so the board
    // `move:after` reports and the board the commit carries are the same board.
    this.accountEffects(after.effects, after.effectsRefused);

    // The loss was evaluated above, BEFORE the dispatch. An `onAfterMove`
    // handler's board effect — a cleared row, an excised tile — is applied
    // during the dispatch and can reopen the board the verdict was taken on,
    // so the verdict is re-derived here against the board as it now stands.
    //
    // Re-derived ONLY where the handler left the flag as it found it. A handler
    // that itself set `over` has declared the run lost, which is a decision the
    // board cannot overturn.
    if (
      this.over &&
      declaredOver === lostBeforeDispatch &&
      // Through `measured()`, so a substituted merge predicate that raises leaves
      // the engine degraded and the verdict as it stood rather than reopening a
      // board that could not be probed.
      this.measured((): boolean => movesAvailable(this.grid, this.config)) ===
        true
    ) {
      this.over = false;
      this.reporter.onCount?.({
        correlationId: this.correlationId,
        metric: LOSS_REOPENED_METRIC,
        value: 1,
      });
    }

    // Emitted from what was applied, member for member, so `move:after` and
    // the `state:commit` below it cannot disagree.
    this.events.emit('move:after', {
      turn: this.turnCounter + 1,
      moved: after.payload.moved,
      board: this.grid,
      score: this.score,
      over: this.over,
      won: this.won,
      terminated: this.isGameTerminated(),
    });

    this.reporter.onCount?.({
      correlationId: this.correlationId,

      metric: MOVE_RESOLVED_METRIC,
      value: 1,
    });

    // Ported from L189.
    this.commit();

    this.resolveMetStageGoal();

    return true;
  }

  /**
   * Resolves the stage in progress when its goal is met and the engine is
   * the resolving authority.
   *
   * Has no vanilla source. Called once per resolved move, after the commit
   * that move ended with, so the state the resolution reads is the state
   * that was committed. Under the `'observer'` authority the measurement is
   * not taken here at all and a subscriber resolves the stage instead, by
   * calling `endStage()` itself.
   */
  private resolveMetStageGoal(): void {
    if (this.stageResolution !== 'engine') {
      return;
    }

    // A stage already resolved is not resolved again; the guard lives in
    // `endStage()` too, and checking here as well keeps the counters honest.
    if (this.stageEnded) {
      return;
    }

    // `evaluateStageGoal` raises on a non-finite input. An `onAfterMove`
    // handler writes `score` and an injected provider supplies `target`, so
    // both are measured for finiteness first, and a measurement that cannot be
    // taken is RECORDED as degraded rather than silently leaving the stage
    // unresolved: the turn is already committed, and a caller has to be able to
    // tell "goal not met" from "goal not measurable".
    const measurable = this.measured(
      (): boolean =>
        Number.isFinite(this.score) &&
        Number.isFinite(this.goalInForce().target) &&
        Number.isFinite(highestTileValue(this.grid)),
    );

    if (measurable !== true) {
      return;
    }

    const cleared = this.measured((): boolean => this.stageProgress().cleared);

    if (cleared !== true) {
      return;
    }

    this.reporter.onCount?.({
      correlationId: this.correlationId,
      metric: STAGE_CLEARED_METRIC,
      value: 1,
    });

    this.endStage(true);
  }

  /**
   * Ends the stage in progress.
   *
   * Has no vanilla source. It dispatches `onStageEnd`, emits
   * `stage:end` and commits, so a subscriber sees the stage resolve and
   * the state that resolved it in one turn.
   *
   * @param cleared Whether the stage's goal was met.
   */
  endStage(cleared: boolean): void {
    // ONE END PER STAGE. A cleared goal stays cleared for every later turn, so
    // without this guard `resolveMetStageGoal()` would dispatch `onStageEnd` and
    // emit `stage:end` again on every commit that followed the clearing one —
    // paying out a stage bounty repeatedly and offering a reward per turn.
    // Released by `startStage()` and by every fresh `setup()`.
    if (this.stageEnded) {
      this.reporter.onCount?.({
        correlationId: this.correlationId,
        metric: STAGE_END_REPEATED_METRIC,
        value: 1,
      });

      return;
    }

    this.stageEnded = true;

    const stage = this.resolveStage();

    const dispatched = this.hooks.dispatch(
      'onStageEnd',
      {
        stageIndex: stage.stageIndex,
        cleared,
        score: this.score,
      },
      this.hookEnvironment(),
    );
    const resolved = dispatched.payload;

    // `score` is a transformable member of `onStageEnd`, so the score a
    // handler returned is ADOPTED before the commit below reads it. Without
    // this the emitted stage result and the commit that immediately follows it
    // reported two different scores.
    this.score = resolved.score;

    // Board commands the stage-end dispatch wrote — a cursed relic collapsing the
    // board is the case this exists for — reached the board before the emission,
    // so a subscriber to `stage:end` and the commit below it both see the board
    // the stage actually ended on. Accounted for here.
    this.accountEffects(dispatched.effects, dispatched.effectsRefused);

    this.events.emit('stage:end', resolved);

    // The adopted goal belonged to the stage that has just ended, so it is
    // released here rather than surviving into the commit below.
    //
    // `resolveStage()` prefers the adopted goal over the provider's whenever
    // the two are not the same object. A subscriber to the emission above
    // advances the stage, which replaces the provider's goal with the next
    // stage's — a different object — so an override left in place would
    // make this commit report the new stage index beside the old stage's
    // goal. The next `setup()` dispatches `onStageStart` and adopts afresh.
    this.stageGoalOverride = null;

    this.commit();
  }

  /**
   * Inserts the configured number of starting tiles.
   *
   * Ported from js/game_manager.js L62-L66, reading `startTiles` from
   * the configuration rather than from the literal at L7.
   */
  private addStartTiles(): void {
    for (let index = 0; index < this.config.startTiles; index += 1) {
      this.addRandomTile();
    }
  }

  /**
   * Spawns one tile.
   *
   * Ported from js/game_manager.js L69-L76, keeping its two calls and
   * their order: `cellsAvailable()` at L70 guards the spawn, and the cell
   * comes from `Grid.randomAvailableCell` — js/grid.js L37-L43 — which is
   * the sole position-draw implementation. Both randomness call sites are
   * replaced by substreams: the value is drawn from `spawn-value` against
   * the configured distribution, which reproduces the two-outcome draw of
   * L71 under the default weights, and the cell is drawn from
   * `spawn-position` inside `randomAvailableCell` over the list
   * js/grid.js L45-L55 collects. The value is drawn before the cell, which
   * is the order L71 and js/grid.js L41 were reached in.
   *
   * A full board spawns nothing, dispatches no `onSpawn` and consumes no draw
   * from either substream, which is the boundary js/grid.js L37-L43 expressed
   * by returning no cell. It DOES emit `tile:spawn` with no position, which is
   * what AAP Contract 1 specifies for that attempt.
   *
   * THE ATTEMPT IS COUNTED HERE, on entry, so `SPAWN_ATTEMPT_METRIC`
   * measures every attempt, the full-board one included.
   * `SPAWN_SUPPRESSED_METRIC` counts the attempts that inserted nothing, so
   * attempts minus suppressions is the number of tiles inserted, and
   * `tile:spawn` is emitted for every attempt whether or not it inserted.
   */
  private addRandomTile(): void {
    this.reporter.onCount?.({
      correlationId: this.correlationId,
      metric: SPAWN_ATTEMPT_METRIC,
      value: 1,
    });

    if (!this.grid.cellsAvailable()) {
      this.reporter.onCount?.({
        correlationId: this.correlationId,
        metric: SPAWN_SUPPRESSED_METRIC,
        value: 1,
      });

      // AAP Contract 1: `tile:spawn` carries no position when the board is
      // full. The attempt is therefore EMITTED, so a subscriber counting
      // emissions counts attempts, while `onSpawn` is still not dispatched and
      // neither substream is drawn from — the boundary js/grid.js L37-L43
      // expressed by returning no cell, and the reason a full board leaves
      // every seeded sequence exactly where it stood. `value` carries
      // `SUPPRESSED_SPAWN_VALUE` because no value was drawn.
      this.events.emit('tile:spawn', {
        turn: this.turnCounter + 1,
        position: undefined,
        value: SUPPRESSED_SPAWN_VALUE,
      });

      return;
    }

    const drawn = this.streams
      .stream('spawn-value')
      .pickWeighted(this.config.spawn.values, this.config.spawn.weights);
    const value = drawn ?? FALLBACK_SPAWN_VALUE;
    const cell = this.grid.randomAvailableCell(
      this.streams.stream('spawn-position'),
    );

    const spawned = this.hooks.dispatch(
      'onSpawn',
      {
        position: cell === undefined ? undefined : { x: cell.x, y: cell.y },
        value,
      },
      this.hookEnvironment(),
    );

    const payload = spawned.payload;

    // A handler is typed to return a cell or nothing; `?? undefined` also
    // folds a `null` a handler returned in spite of the type into the
    // no-cell case, so the bounds check below is never handed one.
    const position = payload.position ?? undefined;

    // An absent position spawns nothing, which is the boundary
    // js/grid.js L37-L43 produced on a full board, and a handler
    // reaches the same state by returning the payload without one. A
    // position outside the lattice reaches the same state, because
    // `withinBounds` refuses it.
    const inserted =
      position !== undefined && this.grid.withinBounds(position);

    if (inserted) {
      this.grid.insertTile(new Tile(position, payload.value));
    } else {
      this.reporter.onCount?.({
        correlationId: this.correlationId,
        metric: SPAWN_SUPPRESSED_METRIC,
        value: 1,
      });
    }

    // THE EMITTED POSITION IS THE INSERTED CELL OR NOTHING. Carrying a
    // position a suppressed spawn never used would let a subscriber count
    // an insertion that did not happen and draw a tile the board does not
    // hold, so the member is omitted for every suppressed spawn: the full
    // board of js/grid.js L37-L43, a handler that returned no cell, and a
    // handler that returned one outside the lattice.
    this.events.emit('tile:spawn', {
      turn: this.turnCounter + 1,
      position: inserted ? position : undefined,
      value: payload.value,
    });

    // A TILE A SPAWN HANDLER INSERTED IS A SPAWN, so it is emitted as one. The
    // bus applied the command already — an accepted board effect is written
    // inside the dispatch transaction — and this is the emission that lets a
    // renderer animate it as an appearance rather than discover it at the next
    // full commit. Only `insertTile` is emitted: a remove or a move from this
    // hook is not a spawn, and the two whole-lattice commands are refused here.
    for (const effect of spawned.effects) {
      if (effect.kind === 'insertTile') {
        this.events.emit('tile:spawn', {
          turn: this.turnCounter + 1,
          position: { x: effect.cell.x, y: effect.cell.y },
          value: effect.value,
        });
      }
    }

    this.accountEffects(spawned.effects, spawned.effectsRefused);

    // `count` is the pre-spawn decision that changes how many tiles a turn
    // adds; it is `1` unless an `onSpawn` handler raised it, so the vanilla
    // turn draws exactly what it always drew and no recorded seeded board
    // moves. Each further tile is drawn HERE rather than by re-dispatching
    // `onSpawn`, which keeps the hook one dispatch per turn and keeps a
    // handler from re-entering itself.
    this.addExtraTiles(payload.count, inserted ? 1 : 0);
  }

  /**
   * Inserts the tiles beyond the first that a raised `onSpawn` count asked for.
   *
   * Has no vanilla source. Each tile's value comes from `spawn-value` against
   * the configured distribution and its cell from `spawn-position` over the
   * cells still empty — the same two substreams and the same order as the first
   * tile — so a raised count is reproducible under a fixed seed. A count that is
   * not a finite number above one, and a board with no cell left, both insert
   * nothing and consume no draw.
   *
   * @param count The count the resolved payload carried.
   * @param already How many tiles this spawn has already inserted.
   */
  private addExtraTiles(count: number | undefined, already: number): void {
    if (count === undefined || !Number.isFinite(count)) {
      return;
    }

    const wanted = Math.floor(count);

    for (let index = already; index < wanted; index += 1) {
      if (!this.grid.cellsAvailable()) {
        return;
      }

      const drawn = this.streams
        .stream('spawn-value')
        .pickWeighted(this.config.spawn.values, this.config.spawn.weights);
      const cell = this.grid.randomAvailableCell(
        this.streams.stream('spawn-position'),
      );

      if (cell === undefined) {
        return;
      }

      const value = drawn ?? FALLBACK_SPAWN_VALUE;

      this.grid.insertTile(new Tile({ x: cell.x, y: cell.y }, value));

      this.events.emit('tile:spawn', {
        turn: this.turnCounter + 1,
        position: { x: cell.x, y: cell.y },
        value,
      });
    }
  }

  /**
   * Promotes the best score, persists or clears the snapshot, and emits
   * the state commit.
   *
   * Ported from js/game_manager.js L79-L99, preserving three properties
   * of it exactly:
   *
   *   The best-score comparison is relational against the value the
   *   port returns as it returns it — the raw stored string when one is
   *   present — so the coercion L80 relied on is unchanged.
   *
   *   The snapshot is cleared on a loss and written otherwise (L84-L89).
   *   A win does not clear it.
   *
   *   The best score placed in the payload is re-read from storage after
   *   the possible write (L95), so the value a view shows is the value
   *   that is persisted.
   *
   * ONE ADDITION: each of the four port calls is made through
   * `throughPort()`, so a port that raises is counted rather than left to
   * leave the commit path. The call order and the values are otherwise
   * those of L80-L95.
   */
  private commit(): void {
    // Every port call below goes through `throughPort`, which reports a
    // raise and stands the absent-value reading `0` in for a failed read.
    const best = this.throughPort(
      (): string | 0 => this.storage.getBestScore(),
      0,
    );

    // Ported from L80-L82. The union is narrowed for the operator; the
    // runtime comparison is the one L80 performed.
    if ((best as number) < this.score) {
      this.throughPort(() => this.storage.setBestScore(this.score), undefined);
    }

    if (this.over) {
      this.throughPort(() => this.storage.clearGameState?.(), undefined);
    } else {
      this.throughPort(
        () => this.storage.setGameState?.(this.serialize()),
        undefined,
      );
    }

    // Ported from L91-L97: the board travels by reference, as L91 passed
    // it, and the five metadata members L92-L96 carried are joined by the
    // stage and relic slices the injected providers supply, plus the
    // monotonic turn a buffering view correlates granular events against.
    this.turnCounter += 1;

    this.events.emit('state:commit', {
      turn: this.turnCounter,
      board: this.grid,
      score: this.score,
      bestScore: this.throughPort(
        (): string | 0 => this.storage.getBestScore(),
        0,
      ),
      over: this.over,
      won: this.won,
      terminated: this.isGameTerminated(),
      degraded: this.terminalUnknown,
      stage: this.resolveStage(),
      relics: this.relicContext(),
    });
  }

  /* ----------------------------------------------------------------------
   * Board effects
   * ------------------------------------------------------------------- */

  /**
   * Accounts for the board and rules commands one dispatch wrote.
   *
   * Has no vanilla source. The WRITE itself is not made here: a handler records
   * through `HookContext.effects`, src/engine/board-effects.ts validates each
   * command against a projection of the live board, and the bus writes the
   * recorded commands to the lattice and the rules in the same transaction that
   * adopts the handler's return — so a handler that threw, or whose return was
   * refused, has nothing applied. What is left to the engine is everything the
   * board and the rules do not own:
   *
   * - the SCORE a restore reinstates, which an undo needs so the points a
   *   withdrawn move scored are withdrawn with it;
   * - the RECONCILIATION count a resize raises, because the win and loss checks
   *   and the renderer's framing all follow the edge length;
   * - the applied and refused COUNTS, so a refused command — an off-lattice
   *   cell, an occupied destination, an unsupported edge length — is reported
   *   rather than silently changing nothing.
   *
   * @param effects Commands the dispatch wrote, in the order it wrote them.
   * @param refused How many commands the dispatch refused.
   * @returns `true` when at least one command changed the board or the rules.
   */
  private accountEffects(
    effects: readonly BoardEffect[],
    refused: number,
  ): boolean {
    for (const effect of effects) {
      this.reporter.onCount?.({
        correlationId: this.correlationId,
        metric: EFFECT_APPLIED_METRIC,
        value: 1,
      });

      // The score travels with the lattice a restore installed. Bounded exactly
      // as a restored snapshot's score is, so a handler cannot install a
      // negative or fractional score through the channel.
      if (
        effect.kind === 'restoreBoard' &&
        effect.score !== undefined &&
        Number.isFinite(effect.score)
      ) {
        this.score = Math.max(0, Math.floor(effect.score));
      }

      // The rules already carry the new edge length — board-effects writes
      // `boardSize` with the lattice — so this is the count, not the write.
      if (effect.kind === 'resizeBoard') {
        this.reporter.onCount?.({
          correlationId: this.correlationId,
          metric: SIZE_RECONCILED_METRIC,
          value: 1,
        });
      }
    }

    for (let index = 0; index < refused; index += 1) {
      this.reporter.onCount?.({
        correlationId: this.correlationId,
        metric: EFFECT_REFUSED_METRIC,
        value: 1,
      });
    }

    return effects.length > 0;
  }

  /**
   * Takes a measurement that may raise, and records a raise as degraded.
   *
   * Has no vanilla source. `movesAvailable` reads the configured merge
   * predicate and `evaluateStageGoal` reads an injected target, so both can be
   * made to raise by a substituted rule. A raise leaves the engine degraded and
   * counted rather than silently reported as playable: the caller decides what a
   * measurement it could not take means for the turn.
   *
   * @param measure The measurement to take.
   * @returns The measurement's value, or `null` where it raised.
   */
  private measured<T>(measure: () => T): T | null {
    try {
      return measure();
    } catch {
      this.terminalUnknown = true;
      this.reporter.onCount?.({
        correlationId: this.correlationId,
        metric: TERMINAL_UNKNOWN_METRIC,
        value: 1,
      });

      return null;
    }
  }
}
