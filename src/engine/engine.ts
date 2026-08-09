// The rules engine: turn orchestration, state ownership and event emission,
// with no reference to any view.
//
// Invariants of this module: it reads no DOM, opens no timer, reads no clock
// and touches no storage key of its own — every persistence call goes through
// the injected port.
//
// Decisions: DL-ENGINE-01, DL-ENGINE-02, DL-ENGINE-03, DL-ENGINE-04,
// DL-ENGINE-05, DL-ENGINE-06, DL-ENGINE-07, DL-ENGINE-08, DL-ENGINE-09,
// DL-ENGINE-10 (docs/DECISION_LOG.md).

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
  CorrelationSource,
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
  correlationReader,
  isMoveDirection,
  isNeutralStageGoal,
} from './types';

/**
 * Value a spawn falls back to when the configured distribution cannot be
 * sampled.
 */
const FALLBACK_SPAWN_VALUE = 2;

/** Counter name for one board effect a hook handler asked for and got. */
const EFFECT_APPLIED_METRIC = 'engine.effect.applied';

/** Counter name for one board effect the engine refused as unusable. */
const EFFECT_REFUSED_METRIC = 'engine.effect.refused';

/** Counter name for one stage started through `startStage`. */
const STAGE_STARTED_METRIC = 'engine.stage.started';

const STAGE_END_REPEATED_METRIC = 'engine.stage.end.repeated';

/**
 * Counter name for a stage start refused on a board terminated by a win the
 * player has not resolved. Decision DL-ENGINE-11.
 */
const STAGE_START_REFUSED_METRIC = 'engine.stage.start.refused';

/**
 * Counter name for a terminal-state or stage-goal measurement that could not
 * be taken.
 */
const TERMINAL_UNKNOWN_METRIC = 'engine.terminal.unknown';

/** `value` carried by the `tile:spawn` emission of a full-board attempt. */
export const SUPPRESSED_SPAWN_VALUE = 0;


const MOVE_BLOCKED_METRIC = 'engine.move.blocked';

const MOVE_REFUSED_METRIC = 'engine.move.refused';

/** Counter name for a move withdrawn by an `onBeforeMove` handler. */
const MOVE_CANCELLED_METRIC = 'engine.move.cancelled';

/** Counter name for a move that changed no cell. */
const MOVE_IDLE_METRIC = 'engine.move.idle';

/**
 * Counter name for one spawn attempt, raised on ENTRY to the spawn.
 *
 * Three boundaries are distinct and must not be read for one another: the
 * ATTEMPT is this counter; the EVENT `tile:spawn` is emitted for every attempt,
 * carrying no position and `SUPPRESSED_SPAWN_VALUE` where nothing was inserted;
 * and the INSERTION is attempts minus `SPAWN_SUPPRESSED_METRIC`, which is what
 * a position on the event records.
 */
export const SPAWN_ATTEMPT_METRIC = 'engine.spawn.attempt';

/**
 * Counter name for one spawn attempt that inserted no tile: the board was
 * full, or an `onSpawn` handler returned the payload without a usable cell.
 * `SPAWN_ATTEMPT_METRIC` minus this counter is the number of tiles inserted.
 * A suppressed attempt still emits `tile:spawn`; it dispatches no `onSpawn`
 * and draws from neither substream only when the board was full.
 */
export const SPAWN_SUPPRESSED_METRIC = 'engine.spawn.suppressed';

/**
 * Counter name for a resolved move: one whose slide moved at least one tile,
 * raised immediately before the commit that ends the turn.
 *
 * This is the SLIDE signal, not the only way the board can change. A turn that
 * changed the board through a hook effect alone settles through
 * `settleEffectOnlyTurn` and commits with `moved === false`, so it is not
 * counted here. `move:after` is emitted for every turn that reached the walk,
 * idle turns included, so an emission count measures turns attempted.
 */
export const MOVE_RESOLVED_METRIC = 'engine.move.resolved';

/** Counter name for a discarded persisted snapshot. */
const SNAPSHOT_REJECTED_METRIC = 'engine.snapshot.rejected';

/** Counter name for a restored persisted snapshot. */
const SNAPSHOT_RESTORED_METRIC = 'engine.snapshot.restored';

/** Counter name for a board size reconciled away from the configured one. */
const SIZE_RECONCILED_METRIC = 'engine.board.reconciled';

/** Counter name for a stage goal the engine found met and resolved. */
const STAGE_CLEARED_METRIC = 'engine.stage.cleared';

const LOSS_REOPENED_METRIC = 'engine.move.lossReopened';

/** Counter name for a call to the injected persistence port that raised. */
const STORAGE_FAILED_METRIC = 'engine.storage.failed';

/**
 * Counter name for an injected tracing wrapper that broke its own contract.
 */
const TRACING_FAULT_METRIC = 'engine.move.tracing.fault';

/** The persistence surface the engine consumes. */
export interface EngineStoragePort extends BestScorePort {
  /**
   * Reads the persisted board snapshot.
   *
   * @returns The parsed snapshot, or anything else — including `null` — when
   *   none is readable. The engine validates the shape itself.
   */
  getGameState?(): unknown;

  /**
   * Persists the board snapshot.
   *
   * @param state Snapshot to write.
   * @returns Whatever the implementation reports; the engine reads nothing
   *   from it.
   */
  setGameState?(state: unknown): unknown;

  /**
   * Discards the persisted board snapshot.
   *
   * @returns Whatever the implementation reports; the engine reads nothing
   *   from it.
   */
  clearGameState?(): unknown;
}

/**
 * Which of its four paths a requested move took.
 *
 * The four the engine already counts, named: `'blocked'` for a move refused
 * before it began (`engine.move.blocked` where the game is over,
 * `engine.move.refused` where the direction is not one of the four),
 * `'cancelled'` for one a listener or an `onBeforeMove` handler withdrew
 * (`engine.move.cancelled`), `'idle'` for one the resolver found changed
 * nothing (`engine.move.idle`), and `'moved'` for one that resolved
 * (`engine.move.resolved`).
 */
export type MoveResolution = 'blocked' | 'cancelled' | 'idle' | 'moved';

/** The outcome of one `Engine.attemptMove`, frozen. */
export interface MoveAttempt {
  /**
   * Whether the slide moved at least one tile — the value `move` returns, taken
   * from `MoveOutcome.moved`. An effect-only turn can change and commit the
   * board with this `false`.
   */
  readonly moved: boolean;

  /** Which path the attempt took. */
  readonly resolution: MoveResolution;

  /**
   * Whether the attempt committed. `true` for every resolved move, and for the
   * two paths that commit without moving: a withdrawn move and an idle move
   * whose pre-move dispatch reseated the board.
   */
  readonly committed: boolean;

  /**
   * The direction the caller asked for, echoed back as it arrived — including
   * a value outside the four, which is refused as `'blocked'` rather than
   * substituted, so a caller reading this sees what it passed.
   */
  readonly direction: Direction;

  /**
   * The direction the move resolved in, which an `onBeforeMove` handler may
   * have redirected. Equal to `direction` on every path no handler changed.
   */
  readonly resolvedDirection: Direction;
}

/** Text recorded for a report sink's throw that offered nothing readable. */
const UNREADABLE_REPORTER_FAULT = 'unreadable thrown value';

/**
 * Reads text from a value the injected report sink threw.
 *
 * @param thrown The caught value.
 * @returns Text describing `thrown`.
 */
function describeThrown(thrown: unknown): string {
  if (typeof thrown === 'string') {
    return thrown.length > 0 ? thrown : UNREADABLE_REPORTER_FAULT;
  }

  if (typeof thrown === 'number' || typeof thrown === 'boolean') {
    return String(thrown);
  }

  if (thrown === null || thrown === undefined) {
    return UNREADABLE_REPORTER_FAULT;
  }

  if (typeof thrown === 'object' || typeof thrown === 'function') {
    try {
      const carried: unknown = Reflect.get(thrown as object, 'message');

      if (typeof carried === 'string' && carried.length > 0) {
        return carried;
      }
    } catch {
      return UNREADABLE_REPORTER_FAULT;
    }

    return UNREADABLE_REPORTER_FAULT;
  }

  return UNREADABLE_REPORTER_FAULT;
}

/**
 * Builds one frozen `MoveAttempt`.
 *
 * @param resolution Path the attempt took.
 * @param direction Direction requested.
 * @param resolvedDirection Direction resolved in.
 * @param committed Whether a commit was made.
 * @returns The frozen outcome.
 */
function frozenAttempt(
  resolution: MoveResolution,
  direction: Direction,
  resolvedDirection: Direction,
  committed: boolean,
): MoveAttempt {
  return Object.freeze({
    moved: resolution === 'moved',
    resolution,
    committed,
    direction,
    resolvedDirection,
  });
}

/**
 * Which collaborator resolves a stage whose goal has been met.
 *
 * `'observer'` leaves the resolution to a subscriber, which calls
 * `Engine.endStage` itself; `'engine'` has the engine call it, from the turn
 * that met the goal. Either way one method resolves the stage.
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
 * js/local_storage_manager.js L43-L45 reported as the number `0`, and a write
 * that keeps nothing.
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
   * The rules in force. Every member is read at use time, so a value changed
   * between turns takes effect on the next turn.
   */
  readonly config?: RulesConfig;

  /**
   * The run's seeded substreams. Every draw the engine takes is one of these.
   */
  readonly streams: RngStreams;

  /**
   * The progression curve, read for the goal of the stage in force when the
   * stage source supplies none of its own. Defaults to `DEFAULT_STAGE_CONFIG`.
   */
  readonly stages?: StageConfig;

  /** Which collaborator resolves a met goal. Defaults to `'observer'`. */
  readonly stageResolution?: StageResolutionAuthority;

  /**
   * Persistence port. Defaults to a port reporting no best score and keeping
   * nothing, so an engine built without one plays a complete game and persists
   * nothing.
   */
  readonly storage?: EngineStoragePort;

  /** Event emitter. One is created when none is supplied. */
  readonly events?: EngineEvents;

  /** Hook bus. One is created when none is supplied. */
  readonly hooks?: HookBus;

  /** Sink for caught errors and counters. */
  readonly reporter?: EngineReporter;

  /**
   * Correlation identifier of the run, carried into every report and into
   * every hook context. Injected, never derived here: the one authority is
   * `deriveCorrelationId` in src/observability/logger.ts, and src/main.ts
   * supplies the value it derives from the run seed.
   */
  readonly correlationId?: CorrelationSource;

  /**
   * Supplies the stage slice of every commit. Defaults to a provider returning
   * `EMPTY_STAGE_CONTEXT`.
   */
  readonly stageContext?: StageCommitContextProvider;

  /**
   * Supplies the relic slice of every commit. Defaults to a provider returning
   * `EMPTY_RELIC_CONTEXT`.
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
 * under src/observability — the engine is the DOM-free, dependency-free half
 * of the split (AAP R1) — so the wrapper is injected in the same way the hook
 * bus takes `HookBusTracing` and the run controller takes `RelicRegistryPort`.
 * `BoundaryTracing` of src/observability/tracer.ts satisfies this shape
 * without either module naming the other.
 *
 * The wrapper must run the function it is handed exactly once and return its
 * value, and rethrow whatever it threw: it is a measurement, never a
 * transformation.
 */
export interface EngineTracing {
  /** Wraps the traversal walk and the merge resolution of one turn. */
  readonly traceMoveResolution?: <T>(run: () => T) => T;
}

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
 * @param value Value read from the matrix.
 * @param x Column the value was found at.
 * @param y Row the value was found at.
 * @returns The tile to restore, or `null` where the cell holds no usable
 *   tile.
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
 * @param value Value read from the snapshot.
 * @param size Declared edge length, already bounded by
 *   `isSupportedBoardSize`.
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

  // Bounded by the product-wide ceiling, not merely by being a positive
  // integer.
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

/**
 * The rules engine.
 *
 * Owns the board, the score and the three state flags, resolves moves,
 * dispatches the six hooks and emits the events of the engine event contract.
 * It holds no reference to a renderer, to a screen or to anything the browser
 * supplies.
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

  /** The board. Replaced by `setup`, mutated in place by a move. */
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
   * The flag js/game_manager.js L25 assigned over its own prototype method.
   * Renamed here; the persisted member name `keepPlaying` is unchanged.
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

  /** The injected span wrapper, or identity where none was injected. */
  private readonly traceResolution: <T>(run: () => T) => T;

  /**
   * The stage goal an `onStageStart` handler returned, and `null` while the
   * goal in force is the one the provider supplies.
   */
  private stageGoalOverride: StageGoal | null;

  /**
   * Whether the stage in progress has already been resolved.
   *
   * THE ONE-SHOT STAGE-END GUARD. A stage's goal stays satisfied for every
   * turn after the one that met it — the highest tile does not fall and the
   * score does not drop — so without this the engine would dispatch
   * `onStageEnd` and emit `stage:end` again on every later commit. Set by
   * `endStage()` and cleared only by `startStage()` and by the fresh-board
   * paths of `setup()`.
   */
  private stageEnded: boolean;

  /** Whether the last turn's terminal status could not be established. */
  private terminalUnknown: boolean;

  /**
   * Monotonic turn counter, raised once for every commit the engine emits.
   *
   * Carried on `tile:merge`, `tile:spawn`, `move:after` and `state:commit`, so
   * a view that buffers granular events can tell which commit they belong to
   * and discard the ones orphaned by a restart, a stage transition or a lost
   * rendering context. Never reset: a monotonic value is what makes an orphan
   * detectable at all.
   */
  private turnCounter: number;

  /** Reads the run correlation identifier every report carries. */
  private readonly readCorrelationId: () => CorrelationId;

  /**
   * Counter reports the injected sink threw out of, contained by `count`. Read
   * through `reporterFaults`.
   */
  private reporterFaultCount: number;

  /**
   * Text of the most recent contained sink throw. Read through
   * `lastReporterFault`.
   */
  private lastReporterFaultText: string | undefined;

  /**
   * @param options The substreams, and optionally the rules, the progression
   *   curve, the stage-resolution authority, the persistence port, the
   *   emitter, the bus, the reporter, the correlation identifier, the two
   *   context providers and the tracing port. Every member but `streams`
   *   carries a default, so `new Engine({ streams })` plays a complete vanilla
   *   game.
   */
  constructor(options: EngineOptions) {
    this.config = options.config ?? createDefaultRulesConfig();
    this.streams = options.streams;
    this.stages = options.stages ?? DEFAULT_STAGE_CONFIG;
    this.stageResolution =
      options.stageResolution ?? DEFAULT_STAGE_RESOLUTION;
    this.storage = options.storage ?? NOOP_STORAGE_PORT;
    this.reporter = options.reporter ?? NOOP_ENGINE_REPORTER;
    this.readCorrelationId = correlationReader(options.correlationId);
    this.events =
      options.events ??
      createEngineEvents({
        // The READER, not a value read once: an emitter and a bus built here
        // follow the run in force exactly as this engine does.
        correlationId: this.readCorrelationId,
        reporter: this.reporter,
      });
    this.hooks =
      options.hooks ??
      createHookBus({
        correlationId: this.readCorrelationId,

        reporter: this.reporter,
      });
    this.stageContext =
      options.stageContext ?? ((): StageCommitContext => EMPTY_STAGE_CONTEXT);
    this.relicContext =
      options.relicContext ?? ((): RelicCommitContext => EMPTY_RELIC_CONTEXT);

    const traceMoveResolution = options.tracing?.traceMoveResolution;

    this.traceResolution =
      traceMoveResolution === undefined
        ? <T>(run: () => T): T => run()
        : traceMoveResolution;

    // Constructed empty so every field is initialised before `setup` decides
    // whether the board is restored or fresh. js/game_manager.js L13 called
    // `setup` from its constructor; here the caller does, so a subscriber can
    // attach before the first commit is emitted.
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
    this.reporterFaultCount = 0;
    this.lastReporterFaultText = undefined;
  }

  /**
   * Correlation identifier of the run in force, read through the injected
   * source on every access.
   *
   * A GETTER, NOT A CAPTURED FIELD. Every report this engine makes reads it
   * here, so a composition root that rotates one shared correlation scope for
   * a new run rotates this engine's attribution with it. Where a plain value
   * was injected the getter answers with that value, unchanged.
   */
  get correlationId(): CorrelationId {
    return this.readCorrelationId();
  }

  /**
   * Reports whether the last turn's terminal status could not be established.
   *
   * Has no vanilla source. `true` means a loss or stage-goal measurement
   * raised: the board and the score are the ones the turn produced, and whether
   * play is blocked is unknown. A caller surfaces this rather than treating the
   * turn as playable.
   *
   * @returns `true` while the engine is in the degraded state.
   */
  isDegraded(): boolean {
    return this.terminalUnknown;
  }

  /**
   * How many counter reports the injected sink threw out of, contained by
   * `count`.
   *
   * Has no vanilla source; js/game_manager.js reported nothing. `0` for a sink
   * that behaves. A non-zero count means reporting is failing while the turns
   * themselves are not: every board, score and event of every counted
   * occurrence is the one the engine produced.
   *
   * The member `LocalStorageManager.reporterFaults` and
   * `HookBusMetrics.reporterFaults` carry for the two sibling ports, so one
   * reading answers the same question at all three layers.
   *
   * @returns The contained-throw count.
   */
  get reporterFaults(): number {
    return this.reporterFaultCount;
  }

  /**
   * Text of the most recent contained report-sink throw, and `undefined` while
   * there has been none.
   *
   * The member `LocalStorageManager.lastReporterFault` carries, in this
   * layer's plain-text form.
   *
   * @returns The description, or `undefined`.
   */
  get lastReporterFault(): string | undefined {
    return this.lastReporterFaultText;
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
   * @returns `true` once `endStage` has run for this stage and until
   *   `startStage` or a fresh `setup` opens the next one.
   */
  hasStageEnded(): boolean {
    return this.stageEnded;
  }

  /**
   * Assembles the stage slice of a commit.
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
   * Raises one counter through the injected report sink, containing a throw
   * from the sink itself.
   *
   * Has no vanilla source. THE ONE PATH EVERY COUNTER THIS FILE RAISES TAKES:
   * each of the counter sites called `this.reporter.onCount?.()` directly,
   * and an `EngineReporter` — whose three members are all optional and which
   * src/engine/types.ts exports for an implementation of a caller's own —
   * that threw from `onCount` took `setup()`, `move()` and `restart()` down
   * with it. The two sibling ports at this layer already contain such a throw
   * and count it: src/engine/hook-bus.ts `deliver` and
   * src/storage/local-storage-manager.ts's reporter delivery.
   *
   * The report is built inside the sink's own guard and the correlation
   * identifier is read there too, so neither a hostile identifier source nor a
   * hostile sink reaches the turn pipeline. A contained throw is counted on
   * `reporterFaults` and described by `lastReporterFault`; nothing is
   * re-delivered, because the sink is the only place a report could go.
   *
   * @param metric Counter name, one of this module's own constants.
   */
  private count(metric: string): void {
    // Nothing to deliver to, and nothing to build: an engine constructed
    // without a sink — `NOOP_ENGINE_REPORTER` carries all three members, a
    // caller's object may carry none — allocates no report here.
    if (this.reporter.onCount === undefined) {
      return;
    }

    try {
      this.reporter.onCount({
        correlationId: this.correlationId,
        metric,
        value: 1,
      });
    } catch (thrown: unknown) {
      this.reporterFaultCount += 1;
      this.lastReporterFaultText = describeThrown(thrown);
    }
  }

  /**
   * Makes one call to the injected persistence port, containing a failure.
   *
   * @param call The port call to make.
   * @param fallback Value taken when the call raises.
   * @returns The call's own value, or `fallback` where it raised.
   */
  private throughPort<T>(call: () => T, fallback: T): T {
    try {
      return call();
    } catch {
      // THROUGH `count`, so a sink that throws from inside this catch is
      // contained: a contained port failure was being replaced by an escaping
      // report failure.
      this.count(STORAGE_FAILED_METRIC);

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
   * same neutral goal where no handler replaced it.
   *
   * THE NEUTRAL GOAL IS RECOGNISED BY VALUE, through `isNeutralStageGoal()`,
   * not by object identity: the hook bus rebuilds the `onStageStart` payload
   * whenever it invokes a subscriber, so the goal `beginStage()` adopts is a
   * structurally-equal COPY of the neutral goal as soon as any subscriber is
   * registered — and an identity comparison read that copy as a goal a
   * handler had supplied, leaving a zero-target goal in force that a fresh
   * board already meets.
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

    if (!isNeutralStageGoal(goal)) {
      return goal;
    }

    if (!Number.isInteger(context.stageIndex) || context.stageIndex < 0) {
      return goal;
    }

    return stageGoalForIndex(context.stageIndex, this.stages);
  }

  /**
   * Measures the stage in progress against its goal.
   *
   * Has no vanilla source. A query: it emits nothing, dispatches nothing,
   * counts nothing and mutates nothing, so a subscriber may call it as freely
   * as the turn pipeline does. `move` calls it once per resolved move, which
   * is where `onAfterMove` is dispatched.
   *
   * The two measured quantities are the live score and `highestTileValue` of
   * src/engine/terminal-state.ts over the board in force, which are the two
   * members of `StageProgressInput`.
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
   * Builds the board, restoring a snapshot when one is readable, and commits
   * the result.
   *
   * @param previousState The snapshot to restore, or `null` to start fresh
   *   without consulting the port. Omit it to fall back to the port's
   *   `getGameState` — the read js/game_manager.js L36 performed — which is
   *   skipped entirely whenever an argument is supplied.
   */
  setup(previousState?: SerializedGameState | null): void {
    const supplied = previousState !== undefined;
    const source: unknown = supplied
      ? previousState
      : this.throughPort(() => this.storage.getGameState?.(), null);
    const snapshot = readSnapshot(source);
    const restored = snapshot !== null;

    if (snapshot === null) {
      this.count(SNAPSHOT_REJECTED_METRIC);
    } else {
      this.count(SNAPSHOT_RESTORED_METRIC);
    }

    // Board-size reconciliation. A snapshot carries the size its board was
    // built at, and that size is authoritative for the tiles inside it:
    // rebuilding at a different size would move or drop them.
    const configured = isSupportedBoardSize(this.config.boardSize)
      ? this.config.boardSize
      : DEFAULT_BOARD_SIZE;
    const size = snapshot === null ? configured : snapshot.grid.size;

    if (size !== this.config.boardSize) {
      this.count(SIZE_RECONCILED_METRIC);
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
   * @returns The resolved `onStageStart` payload, which is what
   *   `stage:start` carries.
   */
  private beginStage(): StageStartPayload {
    // A new stage starts from the provider's own goal, so a goal adopted for
    // the stage before this one is not carried into the dispatch below.
    this.stageGoalOverride = null;

    const stage = this.stageContext();

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

    // Board commands the stage-start dispatch wrote reached the board DURING
    // the dispatch and before the start tiles are inserted, so a relic that
    // resized or reseated the board for the opening position has those tiles
    // placed on the board it asked for. Accounted for here.
    this.accountEffects(started.effects, started.effectsRefused);

    // A board opened afresh — or reopened at another edge length — has its
    // own terminal status and its own unresolved stage.
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
   * THE CARRY-OVER PATH REFUSES A BOARD TERMINATED BY AN UNRESOLVED WIN, the
   * state js/game_manager.js L30-L32 held between the win value being reached
   * and `keepPlaying()`: the win outranks a stage transition, so a caller
   * resolves it — `continuePlaying()`, or ending the run — before the next
   * stage opens. Refused rather than cleared here. The REBUILDING path is not
   * guarded: it installs a board of its own, and a restored snapshot carries
   * its own terminal status. Decision DL-ENGINE-11.
   *
   * @param board Snapshot to REBUILD the board from for the stage that is
   *   starting, or `null` to rebuild it fresh at the configured edge length.
   *   Omitted, which is what a stage transition wants, the board in play is
   *   carried into the new stage untouched.
   */
  startStage(board?: SerializedGameState | null): void {
    if (board === undefined && this.won && !this.over && !this.continuedPlay) {
      this.count(STAGE_START_REFUSED_METRIC);

      return;
    }

    this.count(STAGE_STARTED_METRIC);

    // Released before either path below runs, so the dispatch each makes and
    // the commit it ends with both see an unresolved stage.
    this.stageEnded = false;

    // The REBUILDING path, for a caller that opens the stage on a board of its
    // own.
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
   * adopted, the injected provider's own goal, then the configured curve —
   * and this exposes that result so an observer measures against the same
   * goal the engine does. A subscriber that measured against its own recorded
   * goal instead would disagree with the engine whenever a handler replaced
   * it.
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
   * Ported from js/game_manager.js L17-L21. The actuator call at L19 that
   * cleared the win and loss message is not made here: the commit `setup` ends
   * with carries `terminated` as `false`, which is what a view clears the
   * message on.
   */
  restart(): void {
    this.throughPort(() => this.storage.clearGameState?.(), undefined);
    this.setup(null);
  }

  /**
   * Continues play past the win.
   *
   * Ported from js/game_manager.js L24-L27. The flag it assigned over its own
   * method name is `continuedPlay`, and the actuator call at L26 becomes a
   * commit whose `terminated` is now `false`.
   */
  continuePlaying(): void {
    this.continuedPlay = true;

    this.commit();
  }

  /**
   * Assembles the live collaborators handed to every hook handler.
   *
   * Extension with no vanilla source. Rebuilt on each dispatch, so every
   * member is the instance in force: `setup` replaces `this.grid` on every
   * stage start and every restore.
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
   * Ported from js/game_manager.js L102-L110. The member name `keepPlaying` is
   * the persisted name and is frozen, so a snapshot written by the vanilla
   * game loads here and one written here loads there.
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
   * ONE ADDITION L182 HAS NO ANALOGUE OF: a turn whose `onBeforeMove` dispatch
   * reseated the board has changed state whether or not the walk then moved
   * anything, so it re-derives the verdict, commits and resolves the stage
   * through `settleEffectOnlyTurn()` — still without spawning, because the
   * spawn belongs to a move that moved. The returned value reports the SLIDE,
   * so such a turn returns `false`.
   *
   * A direction outside the four is refused as a no-op returning `false`; see
   * `attemptMove`, whose boolean projection this is.
   *
   * @param direction Direction to move in: 0 up, 1 right, 2 down, 3 left.
   * @returns `true` when the board changed.
   */
  move(direction: Direction): boolean {
    return this.attemptMove(direction).moved;
  }

  /**
   * Resolves one move and reports WHICH of its four paths it took.
   *
   * The same turn `move()` resolves — that member is this one's boolean
   * projection and every existing caller is unaffected — reported in the
   * terms the four counters this method raises already distinguish: a move
   * refused because the game is over, a move a listener or an `onBeforeMove`
   * handler withdrew, a move the resolver found changed nothing, and a move
   * that resolved. A boolean collapses the first three onto one value, so a
   * caller holding it cannot tell a withdrawn move from an idle one, and an
   * observer settling on the boolean alone labelled every one of them the
   * same way.
   *
   * No new event is emitted and no emission is reordered: AAP Contract 1 fixes
   * the seven events, so the outcome is RETURNED rather than announced.
   *
   * A DIRECTION OUTSIDE THE FOUR IS REFUSED AS `'blocked'`, before anything is
   * emitted or dispatched. `Direction` is a compile-time claim and the value
   * arrives from an input adapter, from a structural port that widens it to
   * `number`, and from callers holding strings — so an unusable one used to
   * reach the vector lookup and raise a bare `TypeError` from inside the
   * pipeline, after `move:before` had been emitted and `onBeforeMove`
   * dispatched, leaving the turn with no `move:after` to close it and a
   * subscriber's turn span open. A numeric string was worse: the lookup coerced
   * it into a real, committed move.
   *
   * @param direction Direction to move in: 0 up, 1 right, 2 down, 3 left.
   * @returns The frozen outcome of the attempt.
   */
  attemptMove(direction: Direction): MoveAttempt {
    // The contract measured, not assumed, and measured FIRST: nothing is
    // emitted, dispatched, drawn or written for a direction the engine cannot
    // resolve, so the board, the score and all four RNG cursors stand exactly
    // as they did and the turn is closed by the returned outcome alone.
    if (!isMoveDirection(direction)) {
      // THROUGH `count`, like every other counter this file raises, so a
      // report sink that throws cannot turn a refused direction into an
      // escaping report failure.
      this.count(MOVE_REFUSED_METRIC);

      return frozenAttempt('blocked', direction, direction, false);
    }

    // Ported from L134.
    if (this.isGameTerminated()) {
      this.count(MOVE_BLOCKED_METRIC);

      return frozenAttempt('blocked', direction, direction, false);
    }

    // Emitted before the decision, and CANCELLABLE, which is what AAP Contract
    // 1 declares `move:before` to be.
    const requested: MoveBeforeEvent = {
      direction,
      board: this.grid,
      cancelled: false,
    };

    this.events.emit('move:before', requested);

    // The hook path is the PRIVILEGED one: it is seeded with the veto a
    // listener cast, and unlike a listener it can also redirect the move.
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
    // permutation and an excision are all recorded here, and each is on the
    // board the move then resolves against — or, for a withdrawn move, is the
    // board the turn leaves behind. Accounted for here, and whether anything
    // was written is what decides that a withdrawn move still commits.
    const reseated = this.accountEffects(
      before.effects,
      before.effectsRefused,
    );

    // The resolved veto: what a listener cast, as carried into the dispatch,
    // and what any `onBeforeMove` handler cast on top of it.
    const cancelled = before.payload.cancelled;

    if (cancelled) {
      this.count(MOVE_CANCELLED_METRIC);

      // A withdrawn move normally changes nothing and commits nothing, which
      // is L134's behaviour. A withdrawn move that ALSO reseated the board —
      // undo is exactly that pairing — has changed state, so it SETTLES: the
      // terminal verdict is re-derived against the board the effect left, the
      // state is committed, and the stage is resolved against it. Without the
      // re-derivation and the resolution the board the engine holds and the
      // board every view shows diverged until the next resolved turn, and a
      // rewind that met the stage goal could never clear the stage.
      if (reseated) {
        this.settleEffectOnlyTurn();
      }

      return frozenAttempt(
        'cancelled',
        direction,
        before.payload.direction,
        reseated,
      );
    }

    // The direction the move RESOLVES in is the one the HOOK payload carries,
    // not the one the caller asked for.
    const resolved = before.payload.direction;

    // Ported from L138-L143 and L146-L180, which src/engine/move-resolver.ts
    // owns: the vector, the two traversal orders, the tile preparation, the
    // walk, the merge branch and the change signal.
    const outcome = this.tracedResolution((): MoveOutcome =>
      resolveMove(this.grid, resolved, this.config, {
        dispatchMerge: (payload: MergeDispatchPayload): MergePayload =>
          this.hooks.dispatch('onMerge', payload, this.hookEnvironment())
            .payload,
      }),
    );

    // Ported from L167: the sum of the additions each merge made, every one of
    // which an `onMerge` handler may have transformed.
    this.score += outcome.scoreDelta;

    for (const merge of outcome.merges) {
      // Ported from L170: strict equality against the configured value.
      if (isWinningMergeValue(merge.merged.value, this.config)) {
        this.won = true;
      }

      // The pair L158 assigned to `mergedFrom` travels by reference: both
      // tiles are out of `grid.cells` by L161 and reach a subscriber as live
      // references alone.
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
      this.count(MOVE_IDLE_METRIC);

      // AN ACCEPTED PRE-MOVE EFFECT IS A STATE CHANGE, SLIDE OR NO SLIDE. A
      // permutation, an excision or a restore recorded on `onBeforeMove`
      // reached the board before the walk, and the walk can then find nothing
      // left to move — a tumbled board whose tiles are already against the
      // wall, a thinned board that was already settled. The verdict is
      // re-derived here, BEFORE the emission below, so the completion signal
      // and the commit that follows it report one state. Nothing is spawned:
      // the spawn belongs to a move that moved, which is L183's placement.
      if (reseated) {
        this.deriveTerminalState();
      }

      // The completion signal of a turn that moved nothing.
      this.events.emit('move:after', {
        // The turn this emission ends, numbered as every granular event of a
        // turn is: the counter advances only on a commit, so the number is
        // the one the commit below carries, or — where nothing was reseated
        // and no commit is made — the one the NEXT committed turn will carry.
        turn: this.turnCounter + 1,
        moved: false,
        board: this.grid,
        score: this.score,
        over: this.over,
        won: this.won,
        terminated: this.isGameTerminated(),
      });

      // A turn that changed the board persists and publishes it.
      if (reseated) {
        this.commit();
        this.resolveMetStageGoal();
      }

      // THE RESOLUTION IS `idle` EITHER WAY: a reseated board is a state
      // change, not a move that moved, so the slide's own verdict is what the
      // tracer and every caller of `attemptMove()` are told. `committed` is
      // `reseated`, because the block above is the one idle path that does
      // commit.
      return frozenAttempt('idle', direction, resolved, reseated);
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
    //
    // `deriveTerminalState()` is the one implementation of that measurement;
    // the two turns that change the board without resolving a slide take it
    // too.
    this.deriveTerminalState();

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

    // Every transformable member of `onAfterMove` is applied, and only those.
    const declaredOver = after.payload.over;

    this.score = after.payload.score;
    this.over = declaredOver;
    this.won = after.payload.won;

    // Board commands the post-move dispatch wrote — a line clear is the case
    // this exists for — reached the board before the emission below, so the
    // board `move:after` reports and the board the commit carries are the same
    // board.
    this.accountEffects(after.effects, after.effectsRefused);

    // The loss was evaluated above, BEFORE the dispatch.
    if (
      this.over &&
      declaredOver === lostBeforeDispatch &&
      // Through `measured()`, so a substituted merge predicate that raises
      // leaves the engine degraded and the verdict as it stood rather than
      // reopening a board that could not be probed.
      this.measured((): boolean => movesAvailable(this.grid, this.config)) ===
        true
    ) {
      this.over = false;
      this.count(LOSS_REOPENED_METRIC);
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

    this.count(MOVE_RESOLVED_METRIC);

    // Ported from L189.
    this.commit();

    this.resolveMetStageGoal();

    return frozenAttempt('moved', direction, resolved, true);
  }

  /**
   * Runs the resolution work inside the injected wrapper, exactly once.
   *
   * THE WORK RUNS ONCE WHATEVER THE WRAPPER DOES, and the outcome the turn
   * adopts is the work's own. `EngineTracing.traceMoveResolution` declares that
   * a wrapper must run the function it is handed exactly once and return its
   * value, but a wrapper is composition-root code and nothing enforced it here,
   * while the sibling port `HookBusTracing.traceHookDispatch` of
   * src/engine/hook-bus.ts has held its work to one run all along. Two of the
   * four ways a wrapper can break the contract were SILENT at this boundary,
   * and both are contained here:
   *
   *   the wrapper calls the
   *   work more than once    the first outcome is replayed, the held value or
   *                          the held throw, and the walk is NOT re-entered. A
   *                          second walk of an already-resolved board reports
   *                          `moved: false` with no score delta, and the turn
   *                          adopted it: the board merged, the score was not
   *                          credited and no tile spawned.
   *   the wrapper returns
   *   something else         a completed walk's own outcome is returned, so a
   *                          wrapper is a measurement and never a
   *                          transformation.
   *
   * The two LOUD ways are left exactly as they were, because a broken tracer
   * that announces itself is better than one this quietly repairs: a wrapper
   * that throws on its own account still propagates — the behaviour
   * tests/unit/engine/engine-tracing.test.ts pins deliberately, since
   * swallowing it would hide a broken tracer behind a game that stopped
   * resolving moves — and a wrapper that never runs the work at all still
   * fails on the value it substituted.
   *
   * Every contained violation raises `TRACING_FAULT_METRIC`.
   *
   * @param body The resolution work.
   * @returns Whatever `body` returned, on its first and only run.
   */
  private tracedResolution<T>(body: () => T): T {
    /** Whether the work has been entered. Raised BEFORE it runs. */
    let started = false;

    /** Whether the work returned. */
    let settled = false;

    /** Whether the WORK threw, which is separate from the wrapper throwing. */
    let failed = false;

    let thrown: unknown;
    let held: T | undefined;

    const once = (): T => {
      if (started) {
        this.count(TRACING_FAULT_METRIC);

        if (failed) {
          throw thrown;
        }

        return held as T;
      }

      started = true;

      try {
        const value = body();

        held = value;
        settled = true;

        return value;
      } catch (error: unknown) {
        failed = true;
        thrown = error;

        throw error;
      }
    };

    const returned = this.traceResolution(once);

    // Guarded on `settled` DELIBERATELY. Only a walk that returned has an
    // outcome to prefer; a wrapper that never started the work has none, and
    // substituting one would turn that loud failure into a silent half-turn —
    // which is the class of defect this method exists to close.
    if (settled && !Object.is(returned, held)) {
      this.count(TRACING_FAULT_METRIC);

      return held as T;
    }

    return returned;
  }

  /**
   * Re-derives the loss flag against the board as it now stands.
   *
   * Extracted from the post-spawn check of L185-L187 so the two turns that
   * change the board WITHOUT resolving a slide — a withdrawn move that
   * reseated it, and a move whose walk found nothing to move after a pre-move
   * effect had already rearranged it — take the same measurement the resolved
   * turn takes.
   *
   * Taken through `measured()`, so a substituted merge predicate that raises
   * leaves the engine degraded and the flag exactly as it stood rather than
   * asserting a verdict that could not be established.
   */
  private deriveTerminalState(): void {
    const available = this.measured((): boolean =>
      movesAvailable(this.grid, this.config),
    );

    if (available === false) {
      this.over = true;
    }

    if (available !== null) {
      this.terminalUnknown = false;
    }
  }

  /**
   * Settles a turn whose board changed through an accepted effect alone.
   *
   * Has no vanilla source: no vanilla turn could change the board without
   * resolving. The three steps are the ones a resolved turn ends with, minus
   * the spawn — the verdict re-derived against the board the effect left, the
   * state committed and persisted, and the stage resolved against what was
   * committed. A spawn belongs to a move that moved, which is L183's placement.
   *
   * Called by the withdrawn-move path, which emits no `move:after`: the
   * measurement its commit reports is taken by the stage-context provider
   * while that commit's payload is assembled.
   */
  private settleEffectOnlyTurn(): void {
    this.deriveTerminalState();
    this.commit();
    this.resolveMetStageGoal();
  }

  /**
   * Resolves the stage in progress when its goal is met and the engine is the
   * resolving authority.
   */
  private resolveMetStageGoal(): void {
    if (this.stageResolution !== 'engine') {
      return;
    }

    // A stage already resolved is not resolved again; the guard lives in
    // `endStage` too, and checking here as well keeps the counters honest.
    if (this.stageEnded) {
      return;
    }

    // `evaluateStageGoal` raises on a non-finite input.
    const measurable = this.measured(
      (): boolean =>
        Number.isFinite(this.score) &&
        Number.isFinite(this.goalInForce().target) &&
        Number.isFinite(highestTileValue(this.grid)),
    );

    if (measurable !== true) {
      this.publishRaisedDegradation(measurable);

      return;
    }

    const cleared = this.measured((): boolean => this.stageProgress().cleared);

    if (cleared !== true) {
      this.publishRaisedDegradation(cleared);

      return;
    }

    this.count(STAGE_CLEARED_METRIC);

    this.endStage(true);
  }

  /**
   * Publishes a degradation the stage resolution recorded, in a FOLLOWING
   * authoritative commit.
   *
   * Only a RAISE publishes: `measured` yields `null` for one, and a plain
   * `false` — a non-finite score or target the measurement itself reported —
   * is "goal not met" and changes no flag, so it publishes nothing.
   *
   * Only a RAISE publishes: `measured()` yields `null` for one, and a plain
   * `false` — a non-finite score or target the measurement itself reported
   * — is "goal not met" and changes no flag, so it publishes nothing.
   *
   * @param measurement What `measured()` returned, `null` where it raised.
   */
  private publishRaisedDegradation(measurement: boolean | null): void {
    if (measurement !== null) {
      return;
    }

    this.commit();
  }

  /**
   * Ends the stage in progress.
   *
   * Has no vanilla source. It dispatches `onStageEnd`, emits `stage:end` and
   * commits, so a subscriber sees the stage resolve and the state that
   * resolved it in one turn.
   *
   * @param cleared Whether the stage's goal was met.
   */
  endStage(cleared: boolean): void {
    // ONE END PER STAGE. A cleared goal stays cleared for every later turn, so
    // without this guard `resolveMetStageGoal()` would dispatch `onStageEnd`
    // and emit `stage:end` again on every commit that followed the clearing one
    // — paying out a stage bounty repeatedly and offering a reward per turn.
    // Released by `startStage()` and by every fresh `setup()`.
    if (this.stageEnded) {
      this.count(STAGE_END_REPEATED_METRIC);

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
    // handler returned is ADOPTED before the commit below reads it.
    this.score = resolved.score;

    // Board commands the stage-end dispatch wrote — a cursed relic collapsing
    // the board is the case this exists for — reached the board before the
    // emission, so a subscriber to `stage:end` and the commit below it both see
    // the board the stage actually ended on. Accounted for here.
    this.accountEffects(dispatched.effects, dispatched.effectsRefused);

    this.events.emit('stage:end', resolved);

    this.stageGoalOverride = null;

    this.commit();
  }

  /** Inserts the configured number of starting tiles. */
  private addStartTiles(): void {
    for (let index = 0; index < this.config.startTiles; index += 1) {
      this.addRandomTile();
    }
  }

  /**
   * Spawns one tile.
   *
   * A full board spawns nothing, dispatches no `onSpawn` and consumes no draw
   * from either substream, which is the boundary js/grid.js L37-L43 expressed
   * by returning no cell. It DOES emit `tile:spawn` with no position, which is
   * what AAP Contract 1 specifies for that attempt.
   */
  private addRandomTile(): void {
    this.count(SPAWN_ATTEMPT_METRIC);

    if (!this.grid.cellsAvailable()) {
      this.count(SPAWN_SUPPRESSED_METRIC);

      // AAP Contract 1: `tile:spawn` carries no position when the board is
      // full.
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

    // A handler is typed to return a cell or nothing.
    const position = payload.position ?? undefined;

    // An absent position spawns nothing, which is the boundary js/grid.js
    // L37-L43 produced on a full board, and a handler reaches the same state
    // by returning the payload without one.
    const inserted =
      position !== undefined &&
      this.grid.withinBounds(position) &&
      this.grid.cellAvailable(position);

    if (inserted) {
      this.grid.insertTile(new Tile(position, payload.value));
    } else {
      this.count(SPAWN_SUPPRESSED_METRIC);
    }

    // The emitted position is the inserted cell or nothing.
    this.events.emit('tile:spawn', {
      turn: this.turnCounter + 1,
      position: inserted ? position : undefined,
      value: payload.value,
    });

    // A tile a spawn handler inserted is a spawn, so it is emitted as one. Only
    // `insertTile` is: a remove or a move from this hook is not a spawn.
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
    // moves.
    this.addExtraTiles(payload.count, inserted ? 1 : 0);
  }

  /**
   * Inserts the tiles beyond the first that a raised `onSpawn` count asked for.
   *
   * Has no vanilla source. Each tile's value comes from `spawn-value` against
   * the configured distribution and its cell from `spawn-position` over the
   * cells still empty — the same two substreams and the same order as the
   * first tile — so a raised count is reproducible under a fixed seed. A
   * count that is not a finite number above one, and a board with no cell
   * left, both insert nothing and consume no draw.
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
   * Promotes the best score, persists or clears the snapshot, and emits the
   * state commit.
   *
   * Ported from js/game_manager.js L79-L99, preserving three properties of it
   * exactly.
   *
   * The best-score comparison is relational against the value the port returns
   * as it returns it — the raw stored string when one is present — so the
   * coercion L80 relied on is unchanged.
   *
   * The best score placed in the payload is re-read from storage after the
   * possible write (L95), so the value a view shows is the value that is
   * persisted.
   */
  private commit(): void {
    // Every port call below goes through `throughPort`, which reports a raise
    // and stands the absent-value reading `0` in for a failed read.
    const best = this.throughPort(
      (): string | 0 => this.storage.getBestScore(),
      0,
    );

    // Ported from L80-L82. The union is narrowed for the operator; the runtime
    // comparison is the one L80 performed.
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

    // Ported from L91-L97: the board travels by reference, as L91 passed it,
    // and the five metadata members L92-L96 carried are joined by the stage
    // and relic slices the injected providers supply, plus the monotonic turn
    // a buffering view correlates granular events against.
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

  /**
   * Accounts for the board and rules commands one dispatch wrote.
   *
   * Has no vanilla source. The WRITE itself is not made here: a handler
   * records through `HookContext.effects`, src/engine/board-effects.ts
   * validates each command against a projection of the live board, and the
   * bus writes the recorded commands to the lattice and the rules in the same
   * transaction that adopts the handler's return — so a handler that threw,
   * or whose return was refused, has nothing applied. What is left to the
   * engine is everything the board and the rules do not own:
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
   * @returns `true` when at least one command changed the board or the
   *   rules.
   */
  private accountEffects(
    effects: readonly BoardEffect[],
    refused: number,
  ): boolean {
    for (const effect of effects) {
      this.count(EFFECT_APPLIED_METRIC);

      // The score travels with the lattice a restore installed.
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
        this.count(SIZE_RECONCILED_METRIC);
      }
    }

    for (let index = 0; index < refused; index += 1) {
      this.count(EFFECT_REFUSED_METRIC);
    }

    return effects.length > 0;
  }

  /**
   * Takes a measurement that may raise, and records a raise as degraded.
   *
   * Has no vanilla source. `movesAvailable` reads the configured merge
   * predicate and `evaluateStageGoal` reads an injected target, so both can be
   * made to raise by a substituted rule. A raise leaves the engine degraded and
   * counted rather than silently reported as playable: the caller decides what
   * a measurement it could not take means for the turn.
   *
   * @param measure The measurement to take.
   * @returns The measurement's value, or `null` where it raised.
   */
  private measured<T>(measure: () => T): T | null {
    try {
      return measure();
    } catch {
      this.terminalUnknown = true;
      this.count(TERMINAL_UNKNOWN_METRIC);

      return null;
    }
  }
}
