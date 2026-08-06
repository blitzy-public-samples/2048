// The rules engine: turn orchestration, state ownership and event
// emission, with no reference to any view.
//
// Ported from js/game_manager.js, which is deleted. Method for method:
//   js/game_manager.js L1-L14    constructor            -> constructor
//   js/game_manager.js L17-L21   restart()              -> restart()
//   js/game_manager.js L24-L27   keepPlaying()          -> continuePlaying()
//   js/game_manager.js L30-L32   isGameTerminated()     -> isGameTerminated()
//   js/game_manager.js L35-L59   setup()                -> setup()
//   js/game_manager.js L62-L66   addStartTiles()        -> addStartTiles()
//   js/game_manager.js L69-L76   addRandomTile()        -> addRandomTile()
//   js/game_manager.js L79-L99   actuate()              -> commit()
//   js/game_manager.js L102-L110 serialize()            -> serialize()
//   js/game_manager.js L113-L120 prepareTiles()         -> prepareTiles()
//   js/game_manager.js L123-L127 moveTile()             -> moveTile()
//   js/game_manager.js L130-L191 move()                 -> move()
// The vector, traversal, farthest-position and comparison helpers moved
// to src/engine/move-resolver.ts and the terminal-state checks to
// src/engine/terminal-state.ts.
//
// FOUR CHANGES TO THE PORTED BEHAVIOUR, EACH REQUIRED BY THE SPLIT
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
// Invariants of this module: it reads no DOM, opens no timer, reads no
// clock and touches no storage key of its own — every persistence call
// goes through the injected port.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import type { RulesConfig } from '../config/rules-config';
import type { RngStreams } from '../rng/rng-streams';
import type {
  BoardProjection,
  EngineEvents,
  TileProjection,
} from './engine-events';
import { createEngineEvents } from './engine-events';
import { Grid } from './grid';
import type { HookBus } from './hook-bus';
import { createHookBus } from './hook-bus';
import {
  buildTraversals,
  findFarthestPosition,
  positionsEqual,
  vectorForDirection,
} from './move-resolver';
import {
  highestTileValue,
  isTerminated,
  isWinningValue,
  movesAvailable,
} from './terminal-state';
import { Tile } from './tile';
import type {
  BestScorePort,
  CellMatrix,
  Direction,
  EngineReporter,
  Position,
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
   * Correlation identifier of the run, carried into every report.
   * Defaults to the run seed.
   */
  readonly runId?: string;

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
 * Narrows an unknown value to a serialised tile.
 *
 * @param value Value to test.
 * @returns `true` when it carries a numeric position and value.
 */
function isSerializedTile(value: unknown): value is SerializedTile {
  if (!isRecord(value)) {
    return false;
  }

  const position = value.position;

  return (
    isRecord(position) &&
    typeof position.x === 'number' &&
    typeof position.y === 'number' &&
    typeof value.value === 'number'
  );
}

/**
 * Reduces an unknown cell matrix to one the grid can restore from.
 *
 * Anything that is not a serialised tile becomes an empty cell, so a
 * partially corrupted matrix loses tiles rather than failing the load.
 *
 * @param value Value read from the snapshot.
 * @returns The matrix, or `null` when the value is not a matrix at all.
 */
function readCellMatrix(value: unknown): CellMatrix<SerializedTile> | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const columns: CellMatrix<SerializedTile> = [];

  for (const column of value) {
    if (!Array.isArray(column)) {
      return null;
    }

    columns.push(
      column.map((cell: unknown): SerializedTile | null =>
        isSerializedTile(cell) ? cell : null,
      ),
    );
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

  if (!isRecord(grid) || typeof grid.size !== 'number') {
    return null;
  }

  if (!Number.isSafeInteger(grid.size) || grid.size <= 0) {
    return null;
  }

  const cells = readCellMatrix(grid.cells);

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
 * Board projection
 * ----------------------------------------------------------------------- */

/**
 * Projects one tile, and the pair it merged from, to the immutable form
 * an event carries.
 *
 * @param tile Tile to project.
 * @returns A frozen projection.
 */
function projectTile(tile: Tile): TileProjection {
  const previous = tile.previousPosition;
  const merged = tile.mergedFrom;

  return Object.freeze({
    x: tile.x,
    y: tile.y,
    value: tile.value,
    previousPosition:
      previous === null
        ? null
        : Object.freeze({ x: previous.x, y: previous.y }),
    mergedFrom:
      merged === null
        ? null
        : Object.freeze(merged.map((source: Tile) => projectTile(source))),
  });
}

/**
 * Projects a grid to the immutable form an event carries.
 *
 * The vanilla actuation call passed the grid itself by reference
 * (js/game_manager.js L91), and the view read and could have written its
 * tiles. The projection is a copy, so a subscriber cannot reach engine
 * state through an event.
 *
 * @param grid Grid to project.
 * @returns A frozen projection, `cells[x][y]`, x-major.
 */
function projectBoard(grid: Grid): BoardProjection {
  const columns: readonly (TileProjection | null)[][] = grid.cells.map(
    (column: (Tile | null)[]) =>
      column.map((tile: Tile | null): TileProjection | null =>
        tile === null ? null : projectTile(tile),
      ),
  );

  return Object.freeze({
    size: grid.size,
    cells: Object.freeze(columns.map((column) => Object.freeze(column))),
  });
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

  /** Correlation identifier of the run. */
  readonly runId: string;

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
   * @param options Rules, substreams, persistence port and the optional
   *   emitter, bus, reporter, correlation identifier and context
   *   providers.
   */
  constructor(options: EngineOptions) {
    this.config = options.config;
    this.streams = options.streams;
    this.storage = options.storage;
    this.reporter = options.reporter ?? NOOP_ENGINE_REPORTER;
    this.runId = options.runId ?? options.streams.seed;
    this.events =
      options.events ??
      createEngineEvents({ runId: this.runId, reporter: this.reporter });
    this.hooks =
      options.hooks ??
      createHookBus({ runId: this.runId, reporter: this.reporter });
    this.stageContext =
      options.stageContext ?? ((): StageCommitContext => EMPTY_STAGE_CONTEXT);
    this.relicContext =
      options.relicContext ?? ((): RelicCommitContext => EMPTY_RELIC_CONTEXT);

    // Constructed empty so every field is initialised before `setup()`
    // decides whether the board is restored or fresh. js/game_manager.js
    // L13 called `setup()` from its constructor; here the caller does,
    // so a subscriber can attach before the first commit is emitted.
    this.grid = new Grid(this.config.boardSize);
    this.score = 0;
    this.over = false;
    this.won = false;
    this.continuedPlay = false;
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
        runId: this.runId,
        metric: SNAPSHOT_REJECTED_METRIC,
        value: 1,
      });
    } else {
      this.reporter.onCount?.({
        runId: this.runId,
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
    const size = snapshot === null ? this.config.boardSize : snapshot.grid.size;

    if (size !== this.config.boardSize) {
      this.reporter.onCount?.({
        runId: this.runId,
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

    const stage = this.stageContext();

    this.hooks.dispatch('onStageStart', {
      stageIndex: stage.stageIndex,
      goal: stage.goal,
      seed: this.streams.seed,
      boardSize: this.grid.size,
    });

    if (!restored) {
      this.addStartTiles();
    }

    this.events.emit('stage:start', {
      stageIndex: stage.stageIndex,
      goal: stage.goal,
      seed: this.streams.seed,
      boardSize: this.grid.size,
      board: projectBoard(this.grid),
    });

    this.events.emit('state:restore', {
      reason: restored ? 'snapshot' : 'stage-start',
      snapshot: this.grid.serialize(),
      goal: stage.goal,
    });

    this.commit(0);
  }

  /**
   * Discards the persisted snapshot and starts a fresh board.
   *
   * Ported from js/game_manager.js L17-L21. The actuator call at L19
   * that cleared the win and loss message becomes the `state:restore`
   * event `setup()` emits, whose `reason` tells a view the board is new.
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

    this.events.emit('state:restore', {
      reason: 'continue',
      snapshot: this.grid.serialize(),
      goal: this.stageContext().goal,
    });

    this.commit(0);
  }

  /**
   * Reports whether play is blocked pending an acknowledgement.
   *
   * Ported from js/game_manager.js L30-L32.
   *
   * @returns `true` when the engine refuses further moves.
   */
  isGameTerminated(): boolean {
    return isTerminated(this.over, this.won, this.continuedPlay);
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
        runId: this.runId,
        metric: MOVE_BLOCKED_METRIC,
        value: 1,
      });

      return false;
    }

    const before = this.hooks.dispatch('onBeforeMove', {
      direction,
      boardSize: this.grid.size,
      score: this.score,
      cancelled: false,
    });

    this.events.emit('move:before', {
      ...before.payload,
      board: projectBoard(this.grid),
    });

    if (before.payload.cancelled) {
      this.reporter.onCount?.({
        runId: this.runId,
        metric: MOVE_CANCELLED_METRIC,
        value: 1,
      });

      return false;
    }

    const vector = vectorForDirection(direction);
    const traversals = buildTraversals(vector, this.grid.size);

    let moved = false;
    let scoreDelta = 0;

    // Ported from L143.
    this.prepareTiles();

    // Ported from L146-L180. The two loops are the traversal orders,
    // x-outer and y-inner, each already reversed where the vector
    // requires it.
    for (const x of traversals.x) {
      for (const y of traversals.y) {
        const cell: Position = { x, y };
        const tile = this.grid.cellContent(cell);

        if (!tile) {
          continue;
        }

        const positions = findFarthestPosition(this.grid, cell, vector);
        const next = this.grid.cellContent(positions.next);

        if (next && this.config.merge.canMerge(tile, next)) {
          scoreDelta += this.resolveMerge(tile, next, positions.next);
        } else {
          this.moveTile(tile, positions.farthest);
        }

        // Ported from L175-L177: the sole signal that the board changed.
        if (!positionsEqual(cell, tile)) {
          moved = true;
        }
      }
    }

    if (!moved) {
      this.reporter.onCount?.({
        runId: this.runId,
        metric: MOVE_IDLE_METRIC,
        value: 1,
      });

      return false;
    }

    // Ported from L183.
    this.addRandomTile();

    // Ported from L185-L187.
    if (!movesAvailable(this.grid, this.config)) {
      this.over = true;
    }

    const after = this.hooks.dispatch('onAfterMove', {
      direction,
      moved: true,
      score: this.score,
      scoreDelta,
      highestTileValue: highestTileValue(this.grid),
      over: this.over,
      won: this.won,
      terminated: this.isGameTerminated(),
    });

    // Two members are read back from the resolved payload: a handler may
    // declare the game lost or won, which is how a cursed relic ends a
    // run and how an alternative win condition is expressed. Every other
    // member is reported and is not read back — the score is changed
    // through `onMerge`, whose `scoreDelta` the engine applies.
    this.over = after.payload.over;
    this.won = after.payload.won;

    this.events.emit('move:after', {
      ...after.payload,
      over: this.over,
      won: this.won,
      terminated: this.isGameTerminated(),
      board: projectBoard(this.grid),
    });

    this.reporter.onCount?.({
      runId: this.runId,
      metric: MOVE_RESOLVED_METRIC,
      value: 1,
    });

    // Ported from L189.
    this.commit(scoreDelta);

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
    const stage = this.stageContext();

    const resolved = this.hooks.dispatch('onStageEnd', {
      stageIndex: stage.stageIndex,
      cleared,
      score: this.score,
    });

    this.events.emit('stage:end', resolved.payload);
    this.commit(0);
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
   * Ported from js/game_manager.js L69-L76 with both randomness call
   * sites replaced: the value is drawn from the `spawn-value` substream
   * against the configured distribution, which reproduces
   * `Math.random() < 0.9 ? 2 : 4` under the default weights, and the
   * cell is drawn from the `spawn-position` substream over the list
   * js/grid.js L45-L55 collects. The value is drawn before the cell,
   * which is the order L71 and js/grid.js L41 were reached in.
   *
   * A full board spawns nothing, which is the boundary js/grid.js
   * L37-L43 expressed by returning no cell.
   */
  private addRandomTile(): void {
    const available = this.grid.availableCells();

    if (available.length === 0) {
      return;
    }

    const drawn = this.streams
      .stream('spawn-value')
      .pickWeighted(this.config.spawn.values, this.config.spawn.weights);
    const value = drawn ?? FALLBACK_SPAWN_VALUE;
    const cell = this.streams.stream('spawn-position').pick(available) ?? null;

    const spawned = this.hooks.dispatch('onSpawn', {
      position: cell === null ? null : { x: cell.x, y: cell.y },
      value,
      availableCells: available.length,
    });

    const payload = spawned.payload;
    const position = payload.position;

    if (position !== null && this.grid.withinBounds(position)) {
      this.grid.insertTile(new Tile(position, payload.value));
    }

    this.events.emit('tile:spawn', payload);
  }

  /**
   * Resolves one merge and returns what it added to the score.
   *
   * Ported from js/game_manager.js L156-L170. The produced value comes
   * from the configured producer and the score addition is carried
   * separately, so a handler can change either. The insert-then-remove
   * order is the vanilla order: the merged tile overwrites the target's
   * cell first, and the moving tile's own cell is cleared second.
   *
   * @param tile Tile that moved into the target's cell.
   * @param target Tile already occupying the destination cell.
   * @param destination Cell the merge resolves in.
   * @returns The amount added to the score.
   */
  private resolveMerge(
    tile: Tile,
    target: Tile,
    destination: Position,
  ): number {
    const produced = this.config.merge.produce(tile, target);

    const resolved = this.hooks.dispatch('onMerge', {
      sourceValue: tile.value,
      targetValue: target.value,
      position: { x: destination.x, y: destination.y },
      resultValue: produced,
      scoreDelta: produced,
    });

    const payload = resolved.payload;

    // A handler may move the merge, and the lattice is the authority on
    // where a tile can go: an out-of-bounds cell falls back to the cell
    // the traversal resolved. src/engine/grid.ts applies the same valve
    // to every read.
    const cell = this.grid.withinBounds(payload.position)
      ? payload.position
      : destination;

    const merged = new Tile(cell, payload.resultValue);

    merged.mergedFrom = [tile, target];

    this.grid.insertTile(merged);
    this.grid.removeTile(tile);
    tile.updatePosition(cell);

    this.score += payload.scoreDelta;

    // Ported from L170: strict equality against the configured value.
    if (isWinningValue(merged.value, this.config)) {
      this.won = true;
    }

    this.events.emit('tile:merge', payload);

    return payload.scoreDelta;
  }

  /**
   * Records every tile's cell and clears its merge history.
   *
   * Ported from js/game_manager.js L113-L120.
   */
  private prepareTiles(): void {
    this.grid.eachCell((_x: number, _y: number, tile: Tile | null) => {
      if (tile) {
        tile.mergedFrom = null;
        tile.savePosition();
      }
    });
  }

  /**
   * Moves a tile to a cell, in the lattice and on the tile.
   *
   * Ported from js/game_manager.js L123-L127.
   *
   * @param tile Tile to move.
   * @param cell Cell to move it to.
   */
  private moveTile(tile: Tile, cell: Position): void {
    this.grid.cells[tile.x][tile.y] = null;
    this.grid.cells[cell.x][cell.y] = tile;
    tile.updatePosition(cell);
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
   * @param scoreDelta Amount the turn that produced this commit added to
   *   the score.
   */
  private commit(scoreDelta: number): void {
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

    this.events.emit('state:commit', {
      board: projectBoard(this.grid),
      score: this.score,
      scoreDelta,
      bestScore: this.storage.getBestScore(),
      over: this.over,
      won: this.won,
      terminated: this.isGameTerminated(),
      stage: this.stageContext(),
      relics: this.relicContext(),
    });
  }
}
