/**
 * The run lifecycle: identity resolution, run-state persistence, the stage and
 * relic slices of every commit, stage advancement and the run summary.
 *
 * WHAT THIS MODULE IS FOR
 *   src/run/run-state.ts declares the nine-member envelope and
 *   src/run/run-state-store.ts reads and writes it, but nothing joined either
 *   to a running game: the runtime persisted the legacy board snapshot alone
 *   and handed the engine the neutral stage and relic contexts. This module is
 *   that join. It resolves the run's identity before anything else exists,
 *   adopts a stored envelope where one is readable, supplies the engine's two
 *   context providers from it, and writes it back on every commit.
 *
 * THE TWO STORAGE KEYS STAY SEPARATE
 *   The board keeps living under `gameState`, written and cleared by the engine
 *   exactly as js/game_manager.js wrote and cleared it, and the best score
 *   keeps living under `bestScore` in its frozen format. The envelope WRAPS a
 *   copy of the board snapshot under its own namespaced key; it never becomes
 *   the board's home. So a save written by the pre-migration game still loads,
 *   and a build that never reaches this module still plays.
 *
 * DETERMINISM
 *   `rngCursor` is what makes a resumed run continue its sequence instead of
 *   restarting it, so the cursor map is snapshotted into the envelope on every
 *   commit and read back out at composition. Cursors only ever move forward:
 *   `createRngStreams` fast-forwards past the draws a map records, and nothing
 *   here rewinds one — a restart within a run continues the sequence rather
 *   than replaying it.
 *
 * NO RANDOMNESS, NO CLOCK, NO DOM
 *   Neither the seed nor the run identifier is originated here: both arrive
 *   through an injected token factory, which is the same factory the
 *   composition root uses for its own identity. Nothing in this module reads
 *   the document.
 */

import type { RulesConfig } from '../config/rules-config';
import {
  DEFAULT_STAGE_CONFIG,
  evaluateStageGoal,
  stageGoalForIndex,
  type StageConfig,
  type StageGoal,
} from '../config/stage-config';
import type {
  EngineEvents,
  MoveAfterEvent,
  StateCommitEvent,
} from '../engine/engine-events';
import type {
  CorrelationId,
  RelicCommitContext,
  RelicCommitEntry,
  SerializedGameState,
  StageCommitContext,
} from '../engine/types';
import { isAcceptableRunSeed, type RngCursorMap } from '../rng/rng-streams';
import { RUN_STATE_KEY } from '../storage/storage-keys';
import {
  classifyRunStateVersion,
  createFreshRunState,
  NOOP_RUN_REPORTER,
  normalizeRngCursor,
  redactRunSummary,
  summarizeRunState,
  type LegacyBoardSnapshot,
  type RunOutcome,
  type RunReporter,
  type RunState,
  type RunSummary,
} from './run-state';
import {
  migrateRunState,
  type RunStateLoadOutcome,
  type RunStatePersistencePort,
  type RunStateStore,
} from './run-state-store';

/* --------------------------------------------------------------------------
 * Identity resolution
 * ----------------------------------------------------------------------- */

/** The stage index every run opens on. */
const FIRST_STAGE_INDEX = 0;

/**
 * The identity one run plays under.
 *
 * Resolved BEFORE the logger, the metrics registry, the substreams, the store
 * or the engine exist, because every one of those is constructed with a value
 * derived from it: the correlation identifier comes from `seed` and `runId`
 * together, and the substreams come from `seed`.
 */
export interface RunIdentity {
  /**
   * The run seed, verbatim, as `createRngStreams()` takes it. Guaranteed to
   * satisfy `isAcceptableRunSeed()`, so building the substreams from it cannot
   * throw.
   */
  readonly seed: string;

  /** Identifier of this run instance. A resumed run keeps the stored one. */
  readonly runId: string;

  /** Whether a readable stored envelope supplied `seed` and `runId`. */
  readonly resumed: boolean;

  /** Whether `seed` came from the caller rather than being originated. */
  readonly seedProvided: boolean;
}

/** Everything `resolveRunIdentity()` reads. */
export interface ResolveRunIdentityOptions {
  /**
   * Where the stored envelope is read from. Only `readJson` is used, and the
   * value it returns is validated before a single member of it is adopted.
   */
  readonly storage: Pick<RunStatePersistencePort, 'readJson'>;

  /**
   * Originates a seed or a run identifier. Called at most twice, and not at
   * all when a stored envelope supplies both.
   */
  readonly createToken: () => string;

  /**
   * A caller-supplied seed — the run-start screen's optional seed input.
   * Adopted only when `isAcceptableRunSeed()` accepts it, and adopting one
   * starts a FRESH run: a seed the player chose cannot continue a run that was
   * played under a different one.
   */
  readonly seed?: string;
}

/**
 * Resolves the identity of the run about to be composed.
 *
 * REPORTS NOTHING, AND NEVER THROWS. This runs before the observability layer
 * exists — it is what supplies the correlation identifier that layer is keyed
 * on — so it has no sink to report to and cannot acquire one without inverting
 * the dependency. The authoritative load is `RunController.begin()`, which runs
 * once the sink exists and is the read that reports a corrupted payload, a
 * migration or a board-size reconciliation.
 *
 * The two reads agree because both reduce the same stored value through the
 * same validation: an envelope this function adopts is an envelope
 * `RunStateStore.load()` also adopts.
 *
 * @param options Port, token factory and optional caller-supplied seed.
 * @returns The resolved identity. A stored envelope that is absent,
 *   unreadable, of an unknown version or invalid in any member yields an
 *   originated seed and run identifier rather than a refusal.
 */
export function resolveRunIdentity(
  options: ResolveRunIdentityOptions,
): RunIdentity {
  const requested = options.seed;

  if (
    typeof requested === 'string' &&
    requested.length > 0 &&
    isAcceptableRunSeed(requested)
  ) {
    return {
      seed: requested,
      runId: options.createToken(),
      resumed: false,
      seedProvided: true,
    };
  }

  const restored = readStoredIdentity(options.storage);

  if (restored !== null) {
    return { ...restored, resumed: true, seedProvided: false };
  }

  return {
    seed: options.createToken(),
    runId: options.createToken(),
    resumed: false,
    seedProvided: false,
  };
}

/**
 * Reads `seed` and `runId` out of the stored envelope, or reports that none is
 * usable.
 *
 * Every failure mode collapses to `null`: a port that throws, a value that is
 * not an envelope, a version outside the readable history, and a payload whose
 * validation refuses any member. The seed of a validated envelope has already
 * been measured against `isAcceptableRunSeed()` by that validation, so what
 * this returns is safe to build substreams from.
 */
function readStoredIdentity(
  storage: Pick<RunStatePersistencePort, 'readJson'>,
): { readonly seed: string; readonly runId: string } | null {
  try {
    const stored = storage.readJson(RUN_STATE_KEY);
    const restored = migrateRunState(stored, classifyRunStateVersion(stored));

    if (restored === null) {
      return null;
    }

    return { seed: restored.seed, runId: restored.runId };
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------------------
 * The engine port
 * ----------------------------------------------------------------------- */

/**
 * The slice of the engine this controller uses.
 *
 * Narrowed to three members so the controller cannot reach anything else:
 * it observes, it reads the board snapshot it persists, and it resolves a
 * stage whose goal has been met. `Engine` in src/engine/engine.ts satisfies
 * this structurally; nothing imports the class.
 */
export interface RunEnginePort {
  /** Subscription surface. The controller never emits. */
  readonly events: Pick<EngineEvents, 'on'>;

  /** The board snapshot to wrap in the envelope. */
  serialize(): SerializedGameState;

  /** Resolves the stage in progress. Called when its goal has been met. */
  endStage(cleared: boolean): void;
}

/* --------------------------------------------------------------------------
 * The controller
 * ----------------------------------------------------------------------- */

/** Every construction parameter. `store`, `identity` and `config` are required. */
export interface RunControllerOptions {
  /** Where the envelope is read and written. */
  readonly store: RunStateStore;

  /** The identity `resolveRunIdentity()` produced. */
  readonly identity: RunIdentity;

  /**
   * The live rules configuration, read for `boardSize` alone: the edge length
   * a fresh envelope's empty board records, and the size the store reconciles
   * a stored board against.
   */
  readonly config: RulesConfig;

  /** The progression curve. Defaults to `DEFAULT_STAGE_CONFIG`. */
  readonly stages?: StageConfig;

  /**
   * Originates the run identifier of a run started after one ended in the same
   * page load. Defaults to reusing the injected identity's, which is correct
   * for the common case of a page load that plays one run.
   */
  readonly createToken?: () => string;

  /** Lifecycle sink. Defaults to `NOOP_RUN_REPORTER`. */
  readonly reporter?: RunReporter;

  /**
   * Correlation identifier every report from this controller carries.
   * Injected, never derived here.
   */
  readonly correlationId?: CorrelationId;
}

/**
 * Owns the run in progress.
 *
 * LIFECYCLE
 *   `begin()` adopts a stored envelope or assembles a fresh one. `observe()`
 *   attaches to the engine, after which the controller keeps the envelope
 *   current: the stage's goal progress is measured as each move resolves, the
 *   envelope is written on each commit, a stage whose goal is met is resolved
 *   and advanced, and a lost run is summarised and cleared.
 *
 * WRITES ARE BEST-EFFORT AND NEVER THROW
 *   `RunStateStore` reports and returns rather than throwing, for every input
 *   and against any port, so a full quota or a hostile storage implementation
 *   degrades to an unpersisted run rather than an exception on the commit path.
 */
export class RunController {
  readonly identity: RunIdentity;

  private readonly store: RunStateStore;

  private readonly config: RulesConfig;

  private readonly stages: StageConfig;

  private readonly createToken: () => string;

  private readonly reporter: RunReporter;

  private readonly correlationId: CorrelationId;

  /** The envelope in force. Replaced wholesale; never mutated in place. */
  private current: RunState;

  /**
   * Whether the stage's goal has been met and not yet resolved. Set by the
   * progress measurement and cleared by `advanceStage()`.
   */
  private stageCleared: boolean;

  /**
   * Guards the one re-entrant path: `endStage()` commits, so the commit
   * handler that called it is re-entered before it returns. At most one stage
   * is resolved per commit, and a board that clears several stages at once
   * advances one stage per commit until it does not.
   */
  private resolvingStage: boolean;

  /** Whether the run in force has ended. Set by `finish()`. */
  private ended: boolean;

  /** The last finished run, for a summary screen to read. */
  private finished: RunSummary | null;

  constructor(options: RunControllerOptions) {
    this.store = options.store;
    this.identity = options.identity;
    this.config = options.config;
    this.stages = options.stages ?? DEFAULT_STAGE_CONFIG;
    this.createToken =
      options.createToken ?? ((): string => this.identity.runId);
    this.reporter = options.reporter ?? NOOP_RUN_REPORTER;
    this.correlationId = options.correlationId ?? '';
    this.current = this.freshState(this.identity.runId);
    this.stageCleared = false;
    this.resolvingStage = false;
    this.ended = false;
    this.finished = null;
  }

  /**
   * Performs the authoritative load and adopts its result.
   *
   * THE READ THAT REPORTS. `resolveRunIdentity()` read the same value silently
   * to produce the identity; this read goes through `RunStateStore.load()`, so
   * a corrupted payload, a migrated version and a board-size reconciliation all
   * reach the injected sink here.
   *
   * A stored envelope is adopted only when its seed is the seed the run is
   * being played under. It always is when the identity was resolved from that
   * same envelope; it is not when a caller supplied a seed, and adopting the
   * stored stage and relics in that case would put another run's progress on a
   * board playing a different sequence.
   *
   * @returns The load outcome, for a caller that wants to report or display it.
   */
  begin(): RunStateLoadOutcome {
    const result = this.store.load({
      runId: this.identity.runId,
      seed: this.identity.seed,
      stageGoal: this.goalForStage(FIRST_STAGE_INDEX),
      boardSize: this.config.boardSize,
    });

    const restored = result.state;
    const adopted = restored !== null && restored.seed === this.identity.seed;

    this.current = adopted
      ? (restored as RunState)
      : this.freshState(this.identity.runId);

    this.stageCleared = false;
    this.ended = false;

    this.reporter.onRunStarted?.({
      correlationId: this.correlationId,
      runId: this.current.runId,
      stageIndex: this.current.stageIndex,

      // Whether a stored run was ADOPTED, which is the question the report
      // asks. Not the identity's own `resumed`, which records only where the
      // seed came from: a caller can supply the seed of the run already stored,
      // and that run is resumed even though its seed was not read from it.
      resumed: adopted,
      seedProvided: this.identity.seedProvided,
    });

    return result.outcome;
  }

  /** The seed the run is played under. Authoritative over the identity's. */
  seed(): string {
    return this.current.seed;
  }

  /** The identifier of the run in force. */
  runId(): string {
    return this.current.runId;
  }

  /**
   * The draw counts to resume the substreams from.
   *
   * Read once at composition, after `begin()` and before
   * `createRngStreams(seed, cursors)`. A fresh run yields zeros, so the opening
   * spawns are taken rather than skipped.
   */
  cursors(): RngCursorMap {
    return normalizeRngCursor(this.current.rngCursor);
  }

  /** The envelope in force, by reference. Callers read; they do not mutate. */
  state(): RunState {
    return this.current;
  }

  /**
   * The stage slice of a commit.
   *
   * Bound as the engine's `stageContext` provider and therefore called once per
   * commit, so what it returns is read fresh each time rather than captured.
   */
  stageContext(): StageCommitContext {
    return {
      stageIndex: this.current.stageIndex,
      goal: this.current.stageGoal,
      goalProgress: this.current.goalProgress,
    };
  }

  /**
   * The relic slice of a commit, IN PICKUP ORDER.
   *
   * Projected from the envelope's `relics` in array order, which IS the pickup
   * order, so the order the hook bus dispatches in and the order a HUD renders
   * are one order. `state` is not carried: a commit's consumers show a relic
   * and its remaining charges, and its private state is nobody else's.
   */
  relicContext(): RelicCommitContext {
    return this.current.relics.map((relic): RelicCommitEntry =>
      relic.charges === undefined
        ? { id: relic.id }
        : { id: relic.id, charges: relic.charges },
    );
  }

  /**
   * Attaches to the engine.
   *
   * THREE SUBSCRIPTIONS, each doing what only it can:
   *   - `stage:start` measures the opening progress. It is emitted before the
   *     commit that ends `setup()`, so a restored board that already meets part
   *     of its goal is reported correctly on the very first commit rather than
   *     as zero.
   *   - `move:after` measures progress from the board the move left. It, too,
   *     precedes its commit, so the stage slice a commit carries describes the
   *     board that commit carries.
   *   - `state:commit` writes the envelope, resolves a met goal and finishes a
   *     lost run.
   *   - `stage:end` advances the stage. Advancing HERE rather than after
   *     `endStage()` returns is what makes the commit `endStage()` ends with
   *     report the stage now in force: the payload of that commit is assembled
   *     after this emission completes, so a stage advanced during it is the
   *     stage the commit carries, while `stage:end`'s own payload — assembled
   *     before the emission — still reports the stage that cleared.
   *
   * @param engine The engine to observe.
   * @param cursors Reads the substreams' current draw counts. Called once per
   *   commit; the substreams are constructed after this controller, so the
   *   accessor is injected rather than the streams themselves.
   * @returns Releases all three subscriptions.
   */
  observe(engine: RunEnginePort, cursors: () => RngCursorMap): () => void {
    const stopStageStart = engine.events.on('stage:start', (): void => {
      this.measureSnapshot(engine.serialize());
    });

    const stopMoveAfter = engine.events.on(
      'move:after',
      (event: MoveAfterEvent): void => {
        this.measure(highestOnBoard(event.board), event.score);
      },
    );

    const stopStageEnd = engine.events.on('stage:end', (event): void => {
      if (event.cleared) {
        this.advanceStage();
      }
    });

    const stopCommit = engine.events.on(
      'state:commit',
      (event: StateCommitEvent): void => {
        this.onCommit(engine, event, cursors);
      },
    );

    return (): void => {
      stopStageStart();
      stopMoveAfter();
      stopStageEnd();
      stopCommit();
    };
  }

  /**
   * Advances to the next stage: the next index, that index's goal, and progress
   * back to zero.
   *
   * The relics are carried forward untouched — they are held for the run, not
   * for the stage — and so is the board snapshot, because a stage transition is
   * not a restart.
   *
   * @returns The goal of the stage now in force.
   */
  advanceStage(): StageGoal {
    const from = this.current.stageIndex;
    const to = from + 1;
    const goal = this.goalForStage(to);

    this.current = {
      ...this.current,
      stageIndex: to,
      stageGoal: goal,
      goalProgress: 0,
    };
    this.stageCleared = false;

    this.reporter.onStageAdvanced?.({
      correlationId: this.correlationId,
      fromStageIndex: from,
      toStageIndex: to,
      goal,
    });

    return goal;
  }

  /** The run in force, as data. Includes the seed, for a screen to display. */
  summary(): RunSummary {
    return summarizeRunState(this.current);
  }

  /**
   * The last finished run, or `null` when none has finished in this page load.
   *
   * Held in memory precisely because the envelope is cleared when a run ends:
   * a summary screen needs the finished run after the storage entry is gone.
   */
  lastSummary(): RunSummary | null {
    return this.finished;
  }

  /**
   * Ends the run in force explicitly, as a run-summary screen's end-run action
   * does, and clears the stored envelope.
   *
   * Idempotent: ending a run that has already ended reports nothing further and
   * returns the same summary.
   *
   * @param outcome How the run ended.
   * @returns The finished run, including its seed.
   */
  endRun(outcome: RunOutcome): RunSummary {
    if (this.ended) {
      return this.finished ?? this.summary();
    }

    return this.finish(outcome);
  }

  /** Removes the stored envelope and nothing else. */
  clear(): boolean {
    return this.store.clear();
  }

  /* ----------------------------------------------------------------------
   * Internals
   * ------------------------------------------------------------------- */

  /**
   * Handles one commit: records the state that was committed, then decides
   * whether the run or the stage resolved.
   *
   * ORDER MATTERS. The envelope is brought up to date first, so whatever
   * follows — a write, a summary, a clear — describes the state that was
   * actually committed rather than the state before it.
   */
  private onCommit(
    engine: RunEnginePort,
    event: StateCommitEvent,
    cursors: () => RngCursorMap,
  ): void {
    this.current = {
      ...this.current,
      rngCursor: normalizeRngCursor(cursors()),
      board: engine.serialize(),
    };

    if (event.over) {
      // The engine clears `gameState` on a loss, exactly as
      // js/game_manager.js L84-L86 did. The envelope is cleared with it, so
      // the two keys cannot disagree about whether a run is in progress, and a
      // reload after a loss opens a fresh run rather than a fresh board
      // carrying the lost run's stage and relics.
      this.finish('lost');

      return;
    }

    this.store.save(this.current);

    if (!this.stageCleared || this.resolvingStage) {
      return;
    }

    // `endStage()` emits `stage:end` — where the advance happens — and then
    // commits, so this handler is re-entered before the call returns. That
    // re-entrant commit is what persists the advanced stage; the guard is what
    // stops it from resolving a stage of its own.
    this.resolvingStage = true;

    try {
      engine.endStage(true);
    } finally {
      this.resolvingStage = false;
    }
  }

  /**
   * Summarises the run, reports it, clears the stored envelope and replaces the
   * envelope in force with a fresh one.
   *
   * The replacement is what keeps a second run played without a reload honest:
   * the next commit persists a run at stage 0 with no relics, rather than
   * carrying the finished run's progress onto a fresh board. It is a new run
   * instance, so it carries a new run identifier.
   */
  private finish(outcome: RunOutcome): RunSummary {
    const summary = this.summary();

    this.finished = summary;
    this.ended = true;
    this.stageCleared = false;

    this.reporter.onRunEnded?.({
      correlationId: this.correlationId,
      outcome,
      summary: redactRunSummary(summary),
    });

    this.store.clear();
    this.current = this.freshState(this.createToken());

    return summary;
  }

  /**
   * Measures the stage's progress and records whether its goal is met.
   *
   * The two inputs are checked for finiteness before they reach
   * `evaluateStageGoal()`, which throws on a value that is not finite: an
   * `onAfterMove` handler may set the score, so the number reaching here is not
   * guaranteed to be one this module produced. An unusable measurement leaves
   * the last good progress in place rather than replacing it with a guess.
   */
  private measure(highestTileValue: number, score: number): void {
    if (!Number.isFinite(score) || !Number.isFinite(highestTileValue)) {
      return;
    }

    const progress = evaluateStageGoal(this.current.stageGoal, {
      score,
      highestTileValue,
    });

    this.current = { ...this.current, goalProgress: progress.progress };
    this.stageCleared = progress.cleared;
  }

  /** Measures from a board snapshot, for the paths that carry no live board. */
  private measureSnapshot(state: SerializedGameState): void {
    this.measure(highestInSnapshot(state), state.score);
  }

  /** The goal of one stage, freshly derived from the progression curve. */
  private goalForStage(stageIndex: number): StageGoal {
    return stageGoalForIndex(stageIndex, this.stages);
  }

  /**
   * Assembles a fresh envelope: stage 0, its goal, no progress, no relics and
   * an empty board of the configured size.
   *
   * The board is a placeholder for exactly one moment — the first commit
   * replaces it with the engine's own snapshot — and it is a truthful one: a
   * run that has not started holds no tiles.
   */
  private freshState(runId: string): RunState {
    return createFreshRunState({
      runId,
      seed: this.identity.seed,
      rngCursor: {},
      stageIndex: FIRST_STAGE_INDEX,
      stageGoal: this.goalForStage(FIRST_STAGE_INDEX),
      board: emptyBoardSnapshot(this.config.boardSize),
    });
  }
}

/* --------------------------------------------------------------------------
 * Board readers
 * ----------------------------------------------------------------------- */

/** The value of a board holding no tiles, as `StageProgressInput` defines it. */
const NO_TILES = 0;

/**
 * The minimum a board must expose to be measured: the x-major cell matrix.
 *
 * Declared structurally so this module names no engine class. The
 * `BoardProjection` of src/engine/engine-events.ts satisfies it, which is what
 * `MoveAfterEvent.board` is — an event carries a frozen projection of the board
 * rather than the live lattice, so no measurement can reach engine state.
 */
interface WalkableBoard {
  readonly cells: readonly (readonly ({ readonly value: number } | null)[])[];
}

/** The highest tile value on a board, and 0 for a board holding none. */
function highestOnBoard(board: WalkableBoard): number {
  let highest = NO_TILES;

  for (const column of board.cells) {
    for (const tile of column) {
      if (tile !== null && Number.isFinite(tile.value) && tile.value > highest) {
        highest = tile.value;
      }
    }
  }

  return highest;
}

/**
 * The highest tile value in a board snapshot, and 0 for one holding none.
 *
 * Tolerant of a matrix that came out of Web Storage: a row that is not an
 * array, a cell that is not a tile and a value that is not a finite number are
 * skipped rather than measured.
 */
function highestInSnapshot(state: SerializedGameState): number {
  let highest = NO_TILES;

  const columns = state.grid.cells;

  if (!Array.isArray(columns)) {
    return highest;
  }

  for (const column of columns) {
    if (!Array.isArray(column)) {
      continue;
    }

    for (const cell of column) {
      if (
        cell !== null &&
        typeof cell === 'object' &&
        Number.isFinite(cell.value) &&
        cell.value > highest
      ) {
        highest = cell.value;
      }
    }
  }

  return highest;
}

/**
 * An empty board snapshot of one edge length, in the frozen persisted shape:
 * `cells` indexed `[x][y]` with every empty cell retained as `null` rather than
 * compacted away.
 */
function emptyBoardSnapshot(size: number): LegacyBoardSnapshot {
  const cells: (null)[][] = [];

  for (let x = 0; x < size; x += 1) {
    const column: null[] = [];

    for (let y = 0; y < size; y += 1) {
      column.push(null);
    }

    cells.push(column);
  }

  return {
    grid: { size, cells },
    score: 0,
    over: false,
    won: false,
    keepPlaying: false,
  };
}
