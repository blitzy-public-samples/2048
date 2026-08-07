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
// FOUR CHANGES TO THE PORTED BEHAVIOUR, EACH REQUIRED BY THE SPLIT,
// decisions DL-ENGINE-01 through DL-ENGINE-04 in that order
//   The push call at L91-L97 becomes the `state:commit` event. The engine
//   holds no view reference and calls no renderer.
//
//   The two `Math.random()` calls at L71 and js/grid.js L41 become draws
//   on the `spawn-value` and `spawn-position` substreams. Those were the
//   vanilla sources' only two randomness call sites.
//
//   The literals `2048` (L170), `0.9 ? 2 : 4` (L71), `2` (L7) and the
//   merge condition (L156-L157) are read from `RulesConfig`.
//
//   `keepPlaying` at L24-L27 assigned a boolean over the prototype method
//   of the same name. The flag is `continuedPlay` and the method is
//   `continuePlaying()`. The persisted member name is unchanged: it is
//   still written as `keepPlaying` by `serialize()`.
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
// Decisions behind this file: DL-ENGINE-01, the push call becoming the
// `state:commit` event; DL-ENGINE-02, the two `Math.random()` sites
// becoming named substream draws; DL-ENGINE-03, the four rule literals
// moving into `RulesConfig`; DL-ENGINE-04, the forced `keepPlaying`
// DL-ENGINE-05, the run identifier and the correlation identifier being

import {
  DEFAULT_BOARD_SIZE,
  isSupportedBoardSize,
} from '../config/default-config';
import type { RulesConfig } from '../config/rules-config';
import type { StageGoal } from '../config/stage-config';
import type { RngStreams } from '../rng/rng-streams';
import type { EngineEvents, MoveBeforeEvent } from './engine-events';
import { createEngineEvents } from './engine-events';
import { Grid } from './grid';
import type { HookBus } from './hook-bus';
import { createHookBus } from './hook-bus';
import type {
  HookEnvironment,
  MergeDispatchPayload,
  MergePayload,
} from './hooks';
import { resolveMove } from './move-resolver';
import {
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

/* --------------------------------------------------------------------------
 * Ports
 * ----------------------------------------------------------------------- */

/**
 * The persistence surface the engine consumes.
 *
 * Extends the best-score pair with the three board-snapshot calls
 * js/game_manager.js made — `getGameState` at L36, `setGameState` at L88
 * and `clearGameState` at L18 and L86.
 * src/storage/local-storage-manager.ts satisfies this shape
 * structurally; neither module imports the other.
 */
export interface EngineStoragePort extends BestScorePort {
  /**
   * Reads the persisted board snapshot.
   *
   * @returns The parsed snapshot, or anything else — including `null` —
   *   when none is readable. The engine validates the shape itself.
   */
  getGameState(): unknown;

  /**
   * Persists the board snapshot.
   *
   * @param state Snapshot to write.
   * @returns Whatever the implementation reports; the engine reads
   *   nothing from it.
   */
  setGameState(state: unknown): unknown;

  /**
   * Discards the persisted board snapshot.
   *
   * @returns Whatever the implementation reports; the engine reads
   *   nothing from it.
   */
  clearGameState(): unknown;
}

/** Construction parameters. */
export interface EngineOptions {
  /**
   * The rules in force. Every member is read at use time, so a value
   * changed between turns takes effect on the next turn.
   */
  readonly config: RulesConfig;

  /**
   * The run's seeded substreams. Every draw the engine takes is one of
   * these.
   */
  readonly streams: RngStreams;

  /** Persistence port. */
  readonly storage: EngineStoragePort;

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
 * contract. It holds no reference to a renderer, a screen or the
 * document.
 *
 * @example
 * ```ts
 * const engine = new Engine({ config, streams, storage });
 *
 * engine.events.on('state:commit', (commit) => renderer.render(commit));
 * engine.setup();
 * engine.move(0); // up
 * ```
 */
export class Engine {
  /** The rules in force. Read at use time on every turn. */
  readonly config: RulesConfig;

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
   * @param options Rules, substreams, persistence port and the optional
   *   emitter, bus, reporter, run identifier, correlation identifier and
   *   context providers.
   */
  constructor(options: EngineOptions) {
    this.config = options.config;
    this.streams = options.streams;
    this.storage = options.storage;
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
  }

  /**
   * Assembles the stage slice of a commit.
   *
   * The provider is authoritative for `stageIndex` and `goalProgress`; `goal`
   * is the one an `onStageStart` handler returned where one did, so every
   * stage-carrying payload — `stage:start`, `stage:end` and `state:commit` —
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
   * Builds the board, restoring a persisted snapshot when one is
   * readable, and commits the result.
   *
   * Ported from js/game_manager.js L35-L59. Two additions: the board
   * size is reconciled before the grid is constructed, and
   * `onStageStart` is dispatched before the start tiles are inserted so
   * a spawn-affecting handler applies to them.
   */
  setup(): void {
    const snapshot = readSnapshot(this.storage.getGameState());
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

    // A new stage starts from the provider's own goal, so a goal adopted for
    // the stage before this one is not carried into the dispatch below.
    this.stageGoalOverride = null;

    const stage = this.stageContext();

    // The dispatch's resolved payload is ADOPTED rather than discarded:
    // `goal` is the one transformable member of `onStageStart`, so the goal a
    // handler returned is the goal this stage runs against and is the goal
    // `stage:start` carries. The three invariant members cannot have changed —
    // the bus refuses a return that changes any of them.
    const started = this.hooks.dispatch(
      'onStageStart',
      {
        stageIndex: stage.stageIndex,
        goal: stage.goal,
        seed: this.streams.seed,
        boardSize: this.grid.size,
      },
      this.hookEnvironment(),
    ).payload;

    this.stageGoalOverride = started.goal;

    if (!restored) {
      this.addStartTiles();
    }

    this.events.emit('stage:start', started);

    this.commit();
  }

  /**
   * Discards the persisted snapshot and starts a fresh board.
   *
   * Ported from js/game_manager.js L17-L21. The actuator call at L19
   * that cleared the win and loss message is not made here: the commit
   * `setup()` ends with carries `terminated` as `false`, which is what a
   * view clears the message on.
   */
  restart(): void {
    this.storage.clearGameState();
    this.setup();
  }

  /**
   * Continues play past the win.
   *
   * Ported from js/game_manager.js L24-L27. The flag it assigned over
   * its own method name is `continuedPlay`, and the actuator call at
   * L26 becomes a commit whose `terminated` is now `false`.
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
   * nothing and commits nothing, which is L182's behaviour.
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

    // The board reaches the handler as its read-only facade rather than as
    // the lattice, so a handler cannot rewrite the board through the payload
    // and then throw. Reads through it are live.
    const before = this.hooks.dispatch(
      'onBeforeMove',
      {
        direction,
        board: this.grid,
        cancelled: false,
      },
      this.hookEnvironment(),
    );

    // THE VETO IS DECIDED ON THE HOOK PATH ALONE. `cancelled` is read off
    // the resolved hook payload, which only an `onBeforeMove` handler can
    // have written, and the decision is taken here — before anything is
    // emitted. The emission below therefore REPORTS the decision to
    // observers; it does not gather it. An event listener consequently
    // cannot withdraw a move, cannot cause one to proceed, and cannot
    // become gameplay-relevant through its registration order.
    const cancelled = before.payload.cancelled;

    // Emitted for every requested move, vetoed or not, so a subscriber sees
    // the attempt and its outcome. src/engine/engine-events.ts projects the
    // payload before any listener is reached, so the board inside it is a
    // frozen copy rather than the live lattice.
    const requested: MoveBeforeEvent = {
      direction: before.payload.direction,
      board: this.grid,
      cancelled,
    };

    this.events.emit('move:before', requested);

    if (cancelled) {
      this.reporter.onCount?.({
        correlationId: this.correlationId,

        metric: MOVE_CANCELLED_METRIC,
        value: 1,
      });

      return false;
    }

    // The direction the move RESOLVES in is the one the payload carries, not
    // the one the caller asked for: `direction` is a transformable member of
    // `onBeforeMove`, so a handler that returned another direction redirects
    // the move, and the direction emitted above is therefore the direction
    // executed below.
    const resolved = requested.direction;

    // Ported from L138-L143 and L146-L180, which
    // src/engine/move-resolver.ts owns: the vector, the two traversal
    // orders, the tile preparation, the walk, the merge branch and the
    // change signal. The board is mutated in place, as those lines did.
    // The `onMerge` dispatch reaches the merge branch as a callback, and
    // a handler's `resultValue` is the value written to the board.
    const outcome = resolveMove(this.grid, resolved, this.config, {
      dispatchMerge: (payload: MergeDispatchPayload): MergePayload =>
        this.hooks.dispatch('onMerge', payload, this.hookEnvironment())
          .payload,
    });

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

      return false;
    }

    // Ported from L183.
    this.addRandomTile();

    // Ported from L185-L187. The live configuration travels with the
    // board, so the neighbour probe reads the merge predicate in force
    // rather than a comparison of its own.
    if (!movesAvailable(this.grid, this.config)) {
      this.over = true;
    }

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
    this.score = after.payload.score;
    this.over = after.payload.over;
    this.won = after.payload.won;

    // Emitted from what was applied, member for member, so `move:after` and
    // the `state:commit` below it cannot disagree.
    this.events.emit('move:after', {
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

    return true;
  }

  /**
   * Ends the stage in progress.
   *
   * Has no vanilla analogue. It dispatches `onStageEnd`, emits
   * `stage:end` and commits, so a subscriber sees the stage resolve and
   * the state that resolved it in one turn.
   *
   * @param cleared Whether the stage's goal was met.
   */
  endStage(cleared: boolean): void {
    const stage = this.resolveStage();

    const resolved = this.hooks.dispatch(
      'onStageEnd',
      {
        stageIndex: stage.stageIndex,
        cleared,
        score: this.score,
      },
      this.hookEnvironment(),
    ).payload;

    // `score` is a transformable member of `onStageEnd`, so the score a
    // handler returned is ADOPTED before the commit below reads it. Without
    // this the emitted stage result and the commit that immediately follows it
    // reported two different scores.
    this.score = resolved.score;

    this.events.emit('stage:end', resolved);

    // The adopted goal belonged to the stage that has just ended, so it is
    // released here rather than surviving into the commit below.
    //
    // `resolveStage()` prefers the adopted goal over the provider's whenever
    // the two are not the same object. A subscriber to the emission above
    // advances the stage, which replaces the provider's goal with the next
    // stage's — a different object — so an override left in place would make
    // this commit report the new stage index beside the old stage's goal. The
    // next `setup()` dispatches `onStageStart` and adopts afresh.
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
   * the configured distribution, which reproduces
   * `Math.random() < 0.9 ? 2 : 4` under the default weights, and the cell
   * is drawn from `spawn-position` inside `randomAvailableCell` over the
   * list js/grid.js L45-L55 collects. The value is drawn before the cell,
   * which is the order L71 and js/grid.js L41 were reached in.
   *
   * A full board spawns nothing and consumes no draw from either
   * substream, which is the boundary js/grid.js L37-L43 expressed by
   * returning no cell.
   *
   * THE ATTEMPT IS COUNTED HERE, on entry, so `SPAWN_ATTEMPT_METRIC`
   * measures every attempt including the full-board one that emits no
   * event. `SPAWN_SUPPRESSED_METRIC` counts the attempts that inserted
   * nothing, so attempts minus suppressions is the number of tiles
   * inserted.
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
      position: inserted ? position : undefined,
      value: payload.value,
    });
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
   */
  private commit(): void {
    const best = this.storage.getBestScore();

    // Ported from L80-L82. The union is narrowed for the operator; the
    // runtime comparison is the one L80 performed.
    if ((best as number) < this.score) {
      this.storage.setBestScore(this.score);
    }

    if (this.over) {
      this.storage.clearGameState();
    } else {
      this.storage.setGameState(this.serialize());
    }

    // Ported from L91-L97: the board travels by reference, as L91 passed
    // it, and the five metadata members L92-L96 carried are joined by the
    // stage and relic slices the injected providers supply.
    this.events.emit('state:commit', {
      board: this.grid,
      score: this.score,
      bestScore: this.storage.getBestScore(),
      over: this.over,
      won: this.won,
      terminated: this.isGameTerminated(),
      stage: this.resolveStage(),
      relics: this.relicContext(),
    });
  }
}
