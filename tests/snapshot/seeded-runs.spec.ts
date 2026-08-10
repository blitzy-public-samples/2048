// Seeded run snapshots: the separately stored regression gate of AAP V1 and
// V2.
//
// The `snapshot` project runs in the `node` environment: no document and no
// Web Storage. Every store below is a MemoryStorage behind the real manager.
//
// Snapshot artifacts land in tests/snapshot/__snapshots__/ through
// `resolveSnapshotPath` of vitest.snapshot.config.ts.
//
// Decisions behind this file are recorded in docs/DECISION_LOG.md.

// Declared first. A module's dependencies are evaluated in the order their
// declarations appear, and this one captures the platform generator in its own
// body; it imports nothing.
import {
  PLATFORM_MATH_RANDOM,
  PLATFORM_MATH_RANDOM_DESCRIPTOR,
} from '../fixtures/math-random-reference';

import { afterEach, describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../src/config/default-config';
import type { MergeTileView } from '../../src/config/rules-config';
import {
  createDefaultStageConfig,
  stageGoalForIndex,
} from '../../src/config/stage-config';
import { Engine } from '../../src/engine/engine';
import { ENGINE_EVENT_NAMES } from '../../src/engine/engine-events';
import { Grid } from '../../src/engine/grid';
import { createHookBus } from '../../src/engine/hook-bus';
import type { HookBus } from '../../src/engine/hook-bus';
import { movesAvailable } from '../../src/engine/terminal-state';
import {
  DIRECTION_DOWN,
  DIRECTION_LEFT,
  DIRECTION_RIGHT,
  DIRECTION_UP,
  type CorrelationId,
  type Direction,
  type EngineReporter,
  type SerializedGameState,
  type SerializedTile,
} from '../../src/engine/types';
import { HOOK_NAMES } from '../../src/engine/hooks';
import {
  createLogger,
  deriveCorrelationId,
  type Logger,
} from '../../src/observability/logger';
import {
  METRIC_PREFIX,
  attachRngCursorMetrics,
  createMetricsRegistry,
  type MetricsRegistry,
  type SpawnDetail,
} from '../../src/observability/metrics';
import {
  attachEngineTracing,
  createTracer,
  type Tracer,
} from '../../src/observability/tracer';
import { drawRelicOffers } from '../../src/relics/relic-draw';
import { RELIC_CATALOGUE, RelicRegistry } from '../../src/relics/relic-registry';
import type { Relic } from '../../src/relics/relic-types';
import {
  RNG_STREAM_NAMES,
  createRngStreams,
  type RngCursorMap,
  type RngStreams,
} from '../../src/rng/rng-streams';
import { createSeededRng } from '../../src/rng/seeded-rng';
import {
  RUN_STATE_SCHEMA_VERSION,
  createFreshRunState,
  type RunState,
} from '../../src/run/run-state';
import {
  RunController,
  resolveRunIdentity,
} from '../../src/run/run-controller';
import { RunStateStore } from '../../src/run/run-state-store';
import { LocalStorageManager } from '../../src/storage/local-storage-manager';
import { MemoryStorage } from '../../src/storage/memory-storage';
import {
  BEST_SCORE_KEY,
  OWNED_STORAGE_KEYS,
} from '../../src/storage/storage-keys';
import {
  BLOCKED_BOARD,
  EMPTY_BOARD,
  MERGE_PAIR_BOARD,
  NEAR_LOSS_BOARD,
  NEAR_WIN_BOARD,
  copyBoard,
} from '../fixtures/boards';

/** The run seed every leg below plays from. */
const RUN_SEED = 'run-seed-2048';

/** A second seed. Its board is compared against `RUN_SEED`'s. */
const OTHER_RUN_SEED = 'run-seed-2049';

const FIXED_RUN_ID = 'seeded-runs-fixture';

/** Directions every leg plays, in this order. */
const MOVE_LIST: readonly Direction[] = [
  DIRECTION_UP,
  DIRECTION_RIGHT,
  DIRECTION_DOWN,
  DIRECTION_LEFT,
  DIRECTION_UP,
  DIRECTION_RIGHT,
  DIRECTION_DOWN,
  DIRECTION_LEFT,
];

/** `MOVE_LIST` three times over, played to reach a terminal board. */
const TERMINAL_MOVE_LIST: readonly Direction[] = [
  ...MOVE_LIST,
  ...MOVE_LIST,
  ...MOVE_LIST,
];

/** Moves played before the run is interrupted and persisted. */
const MOVES_BEFORE_RELOAD = 4;

/**
 * Moves played before the reward-carrying leg of section 6b is interrupted.
 *
 * Far enough in that a stage has been cleared and a relic taken, so the reload
 * has a reward round and a held relic to carry rather than a board alone.
 */
const MOVES_BEFORE_REWARD_RELOAD = 30;

/** Offer sets drawn in sequence, one per stage. */
const OFFER_SET_COUNT = 3;

/** Relics offered per set. */
const OFFERS_PER_SET = 3;

/** Offers drawn between moves by the interleaving leg. */
const INTERLEAVED_OFFER_COUNT = 2;

/** Board edge length js/application.js L3 declared. */
const VANILLA_BOARD_SIZE = 4;

/** Width of one rendered cell. Fits every value the tile ramp defines. */
const CELL_WIDTH = 6;

/** What an empty cell renders as. */
const EMPTY_CELL = '.';

/** Width the substream names are padded to. */
const STREAM_NAME_WIDTH = 16;

const HAND_BUILT_POOL: readonly Relic[] = [
  {
    id: 'gate-common',
    name: 'Gate Common',
    rarity: 'common',
    description: 'A pool member of the common tier.',
    hooks: {},
  },
  {
    id: 'gate-uncommon',
    name: 'Gate Uncommon',
    rarity: 'uncommon',
    description: 'A pool member of the uncommon tier.',
    hooks: {},
  },
  {
    id: 'gate-rare',
    name: 'Gate Rare',
    rarity: 'rare',
    description: 'A pool member of the rare tier.',
    hooks: {},
  },
  {
    id: 'gate-legendary',
    name: 'Gate Legendary',
    rarity: 'legendary',
    description: 'A pool member of the legendary tier.',
    hooks: {},
  },
];

/** Injected stores this file created, emptied after every test. */
const injectedStores: MemoryStorage[] = [];

/** Builds a store and registers it for teardown. */
function createBacking(): MemoryStorage {
  const backing = new MemoryStorage();

  injectedStores.push(backing);

  return backing;
}

/**
 * Removes every key `src/storage/storage-keys.ts` reports as owned from every
 * store this file built, and empties the registry.
 */
function clearInjectedStores(): void {
  for (const backing of injectedStores) {
    for (const key of OWNED_STORAGE_KEYS) {
      backing.removeItem(key);
    }

    backing.removeItem(BEST_SCORE_KEY);
  }

  injectedStores.length = 0;
}

/** Removes the owned keys from ambient Web Storage where one exists. */
function clearAmbientOwnedKeys(): void {
  if (typeof localStorage === 'undefined') {
    return;
  }

  for (const key of OWNED_STORAGE_KEYS) {
    localStorage.removeItem(key);
  }

  localStorage.removeItem(BEST_SCORE_KEY);
}

afterEach(() => {
  clearInjectedStores();
  clearAmbientOwnedKeys();
});

/** Renders one board snapshot as fixed-width columns under a metadata line. */
function projectBoard(state: SerializedGameState): string {
  const size = state.grid.size;
  const lines: string[] = [
    `size ${String(size)}  score ${String(state.score)}  ` +
      `over ${String(state.over)}  won ${String(state.won)}  ` +
      `keepPlaying ${String(state.keepPlaying)}`,
  ];

  for (let x = 0; x < size; x += 1) {
    const rendered: string[] = [];

    for (let y = 0; y < size; y += 1) {
      const cell: SerializedTile | null = state.grid.cells[x]?.[y] ?? null;

      rendered.push(
        (cell === null ? EMPTY_CELL : String(cell.value)).padStart(CELL_WIDTH),
      );
    }

    lines.push(`x=${String(x)}${rendered.join('')}`);
  }

  return lines.join('\n');
}

function projectCursors(cursors: RngCursorMap): string {
  return RNG_STREAM_NAMES.map(
    (name) => `  ${name.padEnd(STREAM_NAME_WIDTH)}${String(cursors[name])}`,
  ).join('\n');
}

/**
 * Renders the SEEDED members of one run-state envelope, in declared order:
 * eight of the nine, `runId` excluded.
 *
 * `runId` is run identity rather than seeded state — nothing about it is
 * derived from the seed or the move list — so it is asserted against
 * `FIXED_RUN_ID` in the case above rather than recorded in the artifact.
 */
function projectEnvelope(state: RunState): string {
  return [
    `schemaVersion  ${String(state.schemaVersion)}`,
    `seed           ${state.seed}`,
    `stageIndex     ${String(state.stageIndex)}`,
    `stageGoal      ${state.stageGoal.kind} ` +
      `${String(state.stageGoal.target)}`,
    `goalProgress   ${String(state.goalProgress)}`,
    `relics         ${String(state.relics.length)} held`,
    'rngCursor',
    projectCursors(state.rngCursor),
    'board',
    projectBoard(state.board),
  ].join('\n');
}

/**
 * One tile as the merge predicate reads it: its value, and whether it already
 * merged this turn. js/game_manager.js L158 assigned `mergedFrom` the pair of
 * tiles a merge consumed.
 */
function mergeView(value: number, alreadyMerged: boolean): MergeTileView {
  return { value, mergedFrom: alreadyMerged ? [value, value] : null };
}

/** What one leg of a seeded run is driven with. */
interface RunLegOptions {
  readonly seed: string;

  /** Directions to play. `MOVE_LIST` when absent. */
  readonly moves?: readonly Direction[];

  /** Board to restore. A fresh board is seeded when absent. */
  readonly board?: SerializedGameState;

  /**
   * Bus the engine dispatches its hooks through. A private one when absent.
   */
  readonly hooks?: HookBus;

  /**
   * Sink the engine's own counts and contained failures report through. The
   * `NOOP_ENGINE_REPORTER` default of src/engine/engine.ts applies when absent,
   * which is the observer-free baseline.
   */
  readonly reporter?: EngineReporter;

  /**
   * Identifier the engine stamps on those reports. Absent, the engine's own
   * default applies; nothing about the board or the draw order reads it.
   */
  readonly correlationId?: CorrelationId;

  /**
   * Runs after construction and before `setup()`. The substreams are handed
   * over as well, because a production observer reads the cursor map — see
   * `MetricsRegistry.recordRngCursors` — and reading it must not advance it.
   */
  readonly attach?: (engine: Engine, streams: RngStreams) => void;

  /** Runs before each move. */
  readonly betweenMoves?: (streams: RngStreams) => void;
}

/** What one leg of a seeded run produced. */
interface RunLeg {
  readonly engine: Engine;
  readonly streams: RngStreams;

  /** The board as js/game_manager.js L102-L110 projected it. */
  readonly serialized: SerializedGameState;
  readonly cursors: RngCursorMap;

  /** Whether each move in order changed the board. */
  readonly resolved: readonly boolean[];
}

/**
 * Drives one seeded run and reports what it produced.
 *
 * Wires only what the caller supplies. With no `reporter` and no `attach`, no
 * logger, tracer, metrics collector, relic registry, run controller or renderer
 * is wired: every one of those is a subscriber, and the `NOOP_*` defaults of
 * src/engine/ apply where none is passed. That absence is what makes a leg the
 * baseline the observed leg of section 8 is compared against.
 */
function driveRun(options: RunLegOptions): RunLeg {
  const config = createDefaultRulesConfig();
  const streams = createRngStreams(options.seed);
  const engine = new Engine({
    config,
    streams,
    hooks: options.hooks,
    reporter: options.reporter,
    correlationId: options.correlationId,
    storage: new LocalStorageManager({ storage: createBacking() }),
  });

  options.attach?.(engine, streams);

  // js/game_manager.js L13 called setup from the constructor; here the caller
  // does, after a subscriber has attached.
  engine.setup(options.board);

  const resolved: boolean[] = [];

  for (const direction of options.moves ?? MOVE_LIST) {
    options.betweenMoves?.(streams);
    resolved.push(engine.move(direction));
  }

  return {
    engine,
    streams,
    serialized: engine.serialize(),
    cursors: streams.snapshotCursors(),
    resolved,
  };
}

/** Renders one leg: its board, the cursors it reached, and its turn count. */
function renderLeg(leg: RunLeg): string {
  const turns = leg.resolved.filter((moved) => moved).length;

  return [
    projectBoard(leg.serialized),
    'rngCursor',
    projectCursors(leg.cursors),
    `turns resolved  ${String(turns)} of ${String(leg.resolved.length)}`,
  ].join('\n');
}

/**
 * Draws `OFFER_SET_COUNT` sets of `OFFERS_PER_SET` offers from `pool`, taking
 * the first offer of each set into the owned list before the next set is
 * drawn.
 *
 * @returns The identifiers of each set, in draw order.
 */
function drawOfferSets(
  streams: RngStreams,
  pool: readonly Relic[],
): readonly (readonly string[])[] {
  const owned: string[] = [];
  const sets: string[][] = [];

  for (let stage = 0; stage < OFFER_SET_COUNT; stage += 1) {
    const offers = drawRelicOffers({
      pool,
      ownedIds: owned,
      count: OFFERS_PER_SET,
      streams,
    });
    const ids = offers.map((relic) => relic.id);

    sets.push(ids);

    const taken = ids[0];

    if (taken !== undefined) {
      owned.push(taken);
    }
  }

  return sets;
}

/** Renders offer sets, one line per set, numbered from 1. */
function projectOfferSets(sets: readonly (readonly string[])[]): string {
  return sets
    .map((ids, index) => `  set ${String(index + 1)}  ${ids.join(', ')}`)
    .join('\n');
}

/* --------------------------------------------------------------------------
 * 1b. The real observability stack, as one attachable set
 * ------------------------------------------------------------------------ */

/**
 * Family the engine's own counts land in when the observed leg's reporter
 * records them. One family with the dotted metric name carried as a label,
 * which is the collapsing src/main.ts applies, and the real `METRIC_PREFIX` so
 * the name is as well-formed as a production family. DL-METRIC-04.
 */
const ENGINE_COUNTER_NAME = `${METRIC_PREFIX}snapshot_engine_reports_total`;

/** Records `logger.recent()` is asked for. Above any one leg can produce. */
const LOG_RECORD_LIMIT = 5000;

/** What one real-observer attachment recorded, read after its leg has run. */
interface ObserverEvidence {
  readonly logRecords: number;
  readonly metricSeries: number;
  readonly spansStarted: number;
  readonly spansEnded: number;
  readonly spansOpen: number;
  readonly traceFaults: number;

  /** Counts the engine reported through `EngineReporter.onCount`. */
  readonly engineCounts: number;

  /**
   * Series the registry actually stored those counts as. Read from the
   * registry's own snapshot rather than from a local tally, so the evidence
   * covers the recording path and not only the callback.
   */
  readonly engineCountSeries: number;

  /** Event emissions the metric feed observed. */
  readonly eventsObserved: number;

  /** Times an observer read the substream cursor map. */
  readonly cursorsRead: number;
}

/**
 * The production observability stack, wired as one set and attachable to one
 * engine.
 *
 * THE REAL MODULES, not a stand-in: `createLogger`, `createMetricsRegistry`,
 * `createTracer` and `attachEngineTracing` of src/observability, wired at the
 * seams src/main.ts wires them at — the engine reporter, `attachEngineTracing`
 * over the emitter, one `recordEngineEvent` feed per member of
 * `ENGINE_EVENT_NAMES`, and a cursor read per commit.
 */
interface RealObservers {
  readonly correlationId: CorrelationId;
  readonly reporter: EngineReporter;
  readonly attach: (engine: Engine, streams: RngStreams) => void;

  /** Detaches every listener and closes whatever span is still open. */
  readonly release: () => void;

  readonly evidence: () => ObserverEvidence;
}

/**
 * Builds the real observer set for one seed.
 *
 * `consoleOutput` is off: the records are read back through `logger.recent()`,
 * and a snapshot run writes nothing to the console it does not assert on.
 *
 * @param seed Seed the correlation identifier derives from.
 * @returns The set, unattached.
 */
function createRealObservers(seed: string): RealObservers {
  const correlationId = deriveCorrelationId(seed, FIXED_RUN_ID);
  const logger: Logger = createLogger({
    correlationId,
    subsystem: 'seeded-runs',

    // The most attached posture there is: `debug` retains every record the
    // observers emit, where the `info` default of src/observability/logger.ts
    // would drop the per-event ones and leave the evidence assertion vacuous.
    level: 'debug',
    consoleOutput: false,
  });
  const metrics: MetricsRegistry = createMetricsRegistry({ logger });
  const tracer: Tracer = createTracer({ logger, metrics, correlationId });
  const engineLog = logger.child('engine');
  const stops: (() => void)[] = [];

  let engineCounts = 0;
  let eventsObserved = 0;
  let cursorsRead = 0;

  const reporter: EngineReporter = {
    onCount(report): void {
      engineCounts += 1;
      metrics
        .counter(ENGINE_COUNTER_NAME, { metric: report.metric })
        .inc(report.value);
    },

    onHookError(report): void {
      engineLog.failure('error', `A ${report.hook} handler threw.`, {
        fields: { hook: report.hook, subscriber: report.subscriberId },
        thrown: report.error,
      });
    },

    onListenerError(report): void {
      engineLog.failure('error', `A ${report.event} listener threw.`, {
        fields: { event: report.event, listenerIndex: report.listenerIndex },
        thrown: report.error,
      });
    },
  };

  return {
    correlationId,
    reporter,

    attach: (engine, streams): void => {
      // The turn and stage spans, subscribed through `on` alone.
      stops.push(attachEngineTracing(engine.events, tracer));

      for (const name of ENGINE_EVENT_NAMES) {
        stops.push(
          engine.events.on(name, (payload): void => {
            eventsObserved += 1;
            metrics.recordEngineEvent(
              name,
              name === 'tile:spawn' ? (payload as SpawnDetail) : undefined,
            );
            engineLog.debug('an engine event was observed', { event: name });
          }),
        );
      }

      // A READING observer, and the one that matters most here: the cursor
      // gauge family is fed from the same map the run envelope persists, so
      // this leg proves that reading the substreams does not advance them.
      //
      // THROUGH THE SHIPPING ATTACHMENT, not a listener written here.
      // `attachRngCursorMetrics` is what src/main.ts installs, so the
      // subscription graph this leg measures is the one production runs; a
      // listener of this suite's own proved non-interference for a graph
      // nothing shipped. `cursorsRead` counts the same commits by subscribing
      // beside it.
      stops.push(
        attachRngCursorMetrics(engine.events, metrics, () =>
          streams.snapshotCursors(),
        ),
      );
      stops.push(
        engine.events.on('state:commit', (): void => {
          cursorsRead += 1;
        }),
      );
    },

    release: (): void => {
      for (const stop of stops) {
        stop();
      }

      stops.length = 0;
    },

    evidence: (): ObserverEvidence => {
      const spans = tracer.snapshot();
      const { series } = metrics.snapshot();

      return {
        logRecords: logger.recent(LOG_RECORD_LIMIT).length,
        metricSeries: series.length,
        spansStarted: spans.started,
        spansEnded: spans.ended,
        spansOpen: spans.open,
        traceFaults: spans.faults,
        engineCounts,
        engineCountSeries: series.filter(
          (entry) => entry.name === ENGINE_COUNTER_NAME,
        ).length,
        eventsObserved,
        cursorsRead,
      };
    },
  };
}

/* --------------------------------------------------------------------------
 * 1c. The reward scenario both legs of section 8 play
 * ------------------------------------------------------------------------ */

/** What one leg of the reward scenario produced. */
interface RewardScenario {
  readonly leg: RunLeg;

  /** Offer identifiers of each set, in draw order. */
  readonly offerSets: readonly (readonly string[])[];
}

/**
 * Drives `MOVE_LIST` under `RUN_SEED` with `OFFER_SET_COUNT` reward draws
 * interleaved, and optionally with the real observer set attached.
 *
 * THE DRAWS TAKE FROM THE RUN'S OWN SUBSTREAMS rather than from a generator of
 * their own, which is what makes the offer identifiers a non-interference
 * probe: an observer that consumed from any substream would move the board, the
 * cursors AND the offers, and each is compared separately below.
 *
 * @param observers Observer set to attach, or `undefined` for the baseline.
 * @returns The leg and the offer identifiers it drew.
 */
function driveRewardScenario(observers?: RealObservers): RewardScenario {
  const owned: string[] = [];
  const offerSets: string[][] = [];
  let movesPlayed = 0;

  const leg = driveRun({
    seed: RUN_SEED,
    reporter: observers?.reporter,
    correlationId: observers?.correlationId,
    attach: observers?.attach,
    betweenMoves: (streams): void => {
      const index = movesPlayed;

      movesPlayed += 1;

      // One draw per stage, taken before the earliest moves so the remaining
      // moves are played with the draws already behind them.
      if (index >= OFFER_SET_COUNT) {
        return;
      }

      const ids = drawRelicOffers({
        pool: RELIC_CATALOGUE,
        ownedIds: owned,
        count: OFFERS_PER_SET,
        streams,
      }).map((relic) => relic.id);

      offerSets.push(ids);

      const taken = ids[0];

      if (taken !== undefined) {
        owned.push(taken);
      }
    },
  });

  observers?.release();

  return { leg, offerSets };
}

/**
 * Renders one reward-scenario leg as the text the artifact pins: the board, the
 * cursors every substream reached, the turn count and the offer sets.
 */
function projectRewardScenario(scenario: RewardScenario): string {
  return [
    renderLeg(scenario.leg),
    'offers',
    projectOfferSets(scenario.offerSets),
  ].join('\n');
}

/** Renders a dispatch record one line per dispatch, numbered from 1. */
function projectDispatchPairs(record: readonly string[]): string {
  const lines: string[] = [];

  for (let index = 0; index < record.length; index += 2) {
    const ordinal = String(index / 2 + 1).padStart(2);

    lines.push(`  ${ordinal}. ${record.slice(index, index + 2).join(' ')}`);
  }

  return lines.join('\n');
}

describe('js/application.js L3 — the sole board-size literal', () => {
  it('configures a board four cells to an edge', () => {
    expect(createDefaultRulesConfig().boardSize).toBe(VANILLA_BOARD_SIZE);
  });
});

describe('js/game_manager.js L170 — the mighty 2048 tile', () => {
  it('configures a win value of 2048', () => {
    expect(createDefaultRulesConfig().winValue).toBe(2048);
  });
});

describe('js/game_manager.js L7 — this.startTiles', () => {
  it('configures two start tiles', () => {
    expect(createDefaultRulesConfig().startTiles).toBe(2);
  });
});

describe('js/game_manager.js L71 — the spawn distribution', () => {
  it('configures the values [2, 4] at the weights [0.9, 0.1]', () => {
    const spawn = createDefaultRulesConfig().spawn;

    expect(spawn.values).toEqual([2, 4]);
    expect(spawn.weights).toEqual([0.9, 0.1]);
  });
});

describe('js/game_manager.js L156 — the merge predicate', () => {
  it('accepts equal values where the target has not merged', () => {
    const canMerge = createDefaultRulesConfig().merge.canMerge;

    expect(canMerge(mergeView(4, false), mergeView(4, false))).toBe(true);
  });

  it('refuses a target that already merged this turn', () => {
    const canMerge = createDefaultRulesConfig().merge.canMerge;

    expect(canMerge(mergeView(4, false), mergeView(4, true))).toBe(false);
  });

  it('refuses unequal values', () => {
    const canMerge = createDefaultRulesConfig().merge.canMerge;

    expect(canMerge(mergeView(2, false), mergeView(4, false))).toBe(false);
  });
});

describe('js/game_manager.js L157 — the merge producer', () => {
  it('produces twice the merged value', () => {
    const produce = createDefaultRulesConfig().merge.produce;

    expect(produce(mergeView(2, false), mergeView(2, false))).toBe(4);
    expect(produce(mergeView(1024, false), mergeView(1024, false))).toBe(2048);
  });
});

describe('js/game_manager.js L167 — self.score += merged.value', () => {
  it('adds the merged value and not the value of the moving tile', () => {
    // MERGE_PAIR_BOARD holds two tiles of value 2, so one move merges them.
    const leg = driveRun({
      seed: RUN_SEED,
      board: copyBoard(MERGE_PAIR_BOARD),
      moves: [DIRECTION_LEFT],
    });

    expect(leg.resolved).toEqual([true]);
    expect(leg.serialized.score).toBe(4);
  });
});

describe('js/game_manager.js L62-L76 — addRandomTile', () => {
  it('takes two value draws and two position draws at setup', () => {
    const streams = createRngStreams(RUN_SEED);
    const engine = new Engine({
      config: createDefaultRulesConfig(),
      streams,
      storage: new LocalStorageManager({ storage: createBacking() }),
    });

    engine.setup();

    const cursors = streams.snapshotCursors();

    // L71 draws the value, then L72 draws the position, twice over for the two
    // start tiles of L7.
    expect(cursors['spawn-value']).toBe(2);
    expect(cursors['spawn-position']).toBe(2);
    expect(cursors['relic-draw']).toBe(0);
    expect(cursors['rarity-weight']).toBe(0);
  });

  it('takes one value draw and one position draw per resolved move', () => {
    const leg = driveRun({ seed: RUN_SEED });
    const resolvedTurns = leg.resolved.filter((moved) => moved).length;

    // L182-L183 spawn only where a position changed.
    expect(leg.cursors['spawn-value']).toBe(2 + resolvedTurns);
    expect(leg.cursors['spawn-position']).toBe(2 + resolvedTurns);
  });
});

describe('js/grid.js L45-L64 — availableCells traverses x then y', () => {
  it('lists the empty cells x-outer and y-inner', () => {
    const grid = new Grid(
      MERGE_PAIR_BOARD.grid.size,
      MERGE_PAIR_BOARD.grid.cells,
    );

    // MERGE_PAIR_BOARD holds its two tiles at (0,0) and (1,0), so those two
    // cells are the ones missing from this list.
    expect(grid.availableCells()).toEqual([
      { x: 0, y: 1 },
      { x: 0, y: 2 },
      { x: 0, y: 3 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
      { x: 1, y: 3 },
      { x: 2, y: 0 },
      { x: 2, y: 1 },
      { x: 2, y: 2 },
      { x: 2, y: 3 },
      { x: 3, y: 0 },
      { x: 3, y: 1 },
      { x: 3, y: 2 },
      { x: 3, y: 3 },
    ]);
  });
});

describe('js/grid.js L80-L86 — cellContent off the lattice', () => {
  it('answers null beyond each of the four edges', () => {
    const size = BLOCKED_BOARD.grid.size;
    const grid = new Grid(size, BLOCKED_BOARD.grid.cells);

    expect(grid.cellContent({ x: -1, y: 0 })).toBeNull();
    expect(grid.cellContent({ x: 0, y: -1 })).toBeNull();
    expect(grid.cellContent({ x: size, y: 0 })).toBeNull();
    expect(grid.cellContent({ x: 0, y: size })).toBeNull();
  });

  it('answers the tile inside the lattice', () => {
    const grid = new Grid(
      MERGE_PAIR_BOARD.grid.size,
      MERGE_PAIR_BOARD.grid.cells,
    );
    const tile = grid.cellContent({ x: 0, y: 0 });

    expect(tile).not.toBeNull();
    expect(tile?.value).toBe(2);
    expect(grid.cellContent({ x: 0, y: 1 })).toBeNull();
  });
});

describe('js/grid.js L37-L43 — randomAvailableCell on a full board', () => {
  it('yields nothing and consumes no draw', () => {
    // NEAR_LOSS_BOARD fills all sixteen cells.
    const full = NEAR_LOSS_BOARD.grid;
    const grid = new Grid(full.size, full.cells);
    const stream = createRngStreams(RUN_SEED).stream('spawn-position');

    expect(grid.availableCells()).toEqual([]);
    expect(grid.cellsAvailable()).toBe(false);
    expect(grid.randomAvailableCell(stream)).toBeUndefined();
    expect(stream.cursor).toBe(0);
  });

  it('leaves the cursor where it stood when pick is given no candidate', () => {
    const stream = createRngStreams(RUN_SEED).stream('spawn-position');

    stream.next();

    expect(stream.cursor).toBe(1);
    expect(stream.pick([])).toBeUndefined();
    expect(stream.cursor).toBe(1);
  });
});

describe('js/game_manager.js L134 — the terminal-state guard', () => {
  it('refuses a further move and consumes no randomness', () => {
    const leg = driveRun({
      seed: RUN_SEED,
      board: copyBoard(NEAR_LOSS_BOARD),
      moves: TERMINAL_MOVE_LIST,
    });

    expect(leg.engine.isGameTerminated()).toBe(true);
    expect(leg.engine.over).toBe(true);
    expect(movesAvailable(leg.engine.grid, leg.engine.config)).toBe(false);

    const before = leg.engine.serialize();

    expect(leg.engine.move(DIRECTION_UP)).toBe(false);
    expect(leg.engine.move(DIRECTION_RIGHT)).toBe(false);
    expect(leg.engine.move(DIRECTION_DOWN)).toBe(false);
    expect(leg.engine.move(DIRECTION_LEFT)).toBe(false);
    expect(leg.engine.serialize()).toEqual(before);
    expect(leg.streams.snapshotCursors()).toEqual(leg.cursors);
  });
});

describe('js/game_manager.js L170 — won is raised at the win value', () => {
  it('raises won where a merge reaches the configured value', () => {
    // NEAR_WIN_BOARD holds two tiles of half the win value, so one move
    // produces 2048 through the L157 producer.
    const leg = driveRun({
      seed: RUN_SEED,
      board: copyBoard(NEAR_WIN_BOARD),
    });

    expect(leg.serialized.won).toBe(true);
    expect(leg.serialized.keepPlaying).toBe(false);
    expect(leg.engine.isGameTerminated()).toBe(true);
  });
});

describe('js/game_manager.js L102-L110 — serialize()', () => {
  it('carries the five frozen members, keepPlaying among them', () => {
    const leg = driveRun({ seed: RUN_SEED });

    // The in-class flag was renamed by the I15 repair; the persisted member
    // name is unchanged.
    expect(Object.keys(leg.serialized).sort()).toEqual([
      'grid',
      'keepPlaying',
      'over',
      'score',
      'won',
    ]);
    expect(leg.serialized.grid.size).toBe(VANILLA_BOARD_SIZE);
  });

  it('reproduces its recorded board from a fresh start', () => {
    expect(renderLeg(driveRun({ seed: RUN_SEED }))).toMatchSnapshot(
      'fresh board',
    );
  });
});

describe('js/game_manager.js L36-L45 — a restored run', () => {
  it('reproduces its recorded board from the empty fixture', () => {
    expect(
      renderLeg(driveRun({ seed: RUN_SEED, board: copyBoard(EMPTY_BOARD) })),
    ).toMatchSnapshot('restored from the empty fixture');
  });

  it('reproduces its recorded board from the merge-pair fixture', () => {
    expect(
      renderLeg(
        driveRun({ seed: RUN_SEED, board: copyBoard(MERGE_PAIR_BOARD) }),
      ),
    ).toMatchSnapshot('restored from the merge-pair fixture');
  });

  it('reproduces its recorded board from the blocked fixture', () => {
    expect(
      renderLeg(driveRun({ seed: RUN_SEED, board: copyBoard(BLOCKED_BOARD) })),
    ).toMatchSnapshot('restored from the blocked fixture');
  });

  it('reproduces its recorded board from the near-win fixture', () => {
    expect(
      renderLeg(driveRun({ seed: RUN_SEED, board: copyBoard(NEAR_WIN_BOARD) })),
    ).toMatchSnapshot('restored from the near-win fixture');
  });

  it('reproduces its recorded board from the near-loss fixture', () => {
    expect(
      renderLeg(
        driveRun({ seed: RUN_SEED, board: copyBoard(NEAR_LOSS_BOARD) }),
      ),
    ).toMatchSnapshot('restored from the near-loss fixture');
  });
});

describe('AAP V2 — two engines from one seed and one move list', () => {
  it('reaches the same board, the same cursors and the same turns', () => {
    const first = driveRun({ seed: RUN_SEED });
    const second = driveRun({ seed: RUN_SEED });

    expect(second.serialized).toEqual(first.serialized);
    expect(second.cursors).toEqual(first.cursors);
    expect(second.resolved).toEqual(first.resolved);
  });

  it('reproduces the board recorded for that seed', () => {
    expect(renderLeg(driveRun({ seed: RUN_SEED }))).toMatchSnapshot(
      'second engine, same seed',
    );
  });

  it('reaches a different board from a different seed', () => {
    const first = driveRun({ seed: RUN_SEED });
    const other = driveRun({ seed: OTHER_RUN_SEED });

    expect(other.serialized).not.toEqual(first.serialized);
  });
});

describe('createSeededRng — a start cursor fast-forwards', () => {
  it('stands where an instance advanced by that many draws stands', () => {
    const seed = 'fast-forward-seed';
    const advanced = createSeededRng(seed);
    const skipped = 3;

    for (let draw = 0; draw < skipped; draw += 1) {
      advanced.next();
    }

    const jumped = createSeededRng(seed, skipped);

    expect(jumped.cursor).toBe(advanced.cursor);

    const fromAdvanced: number[] = [];
    const fromJumped: number[] = [];

    for (let draw = 0; draw < skipped; draw += 1) {
      fromAdvanced.push(advanced.next());
      fromJumped.push(jumped.next());
    }

    expect(fromJumped).toEqual(fromAdvanced);
    expect(jumped.cursor).toBe(skipped * 2);
  });
});

/** What the interrupted half of the reload leg produced. */
interface Interruption {
  readonly backing: MemoryStorage;
  readonly envelope: RunState;
  readonly halfway: SerializedGameState;
}

/**
 * Plays the first `MOVES_BEFORE_RELOAD` moves and persists the run through
 * `RunStateStore`.
 */
function interruptRun(): Interruption {
  const backing = createBacking();
  const manager = new LocalStorageManager({ storage: backing });
  const config = createDefaultRulesConfig();
  const streams = createRngStreams(RUN_SEED);
  const engine = new Engine({ config, streams, storage: manager });

  engine.setup();

  for (const direction of MOVE_LIST.slice(0, MOVES_BEFORE_RELOAD)) {
    engine.move(direction);
  }

  const halfway = engine.serialize();
  const envelope = createFreshRunState({
    runId: FIXED_RUN_ID,
    seed: RUN_SEED,
    rngCursor: streams.snapshotCursors(),
    stageIndex: 0,
    stageGoal: stageGoalForIndex(0, createDefaultStageConfig()),
    board: halfway,
  });

  const written = new RunStateStore({ storage: manager, config }).save(
    envelope,
  );

  expect(written).toBe(true);

  return { backing, envelope, halfway };
}

/**
 * Reads the envelope back through a reader stack built after the write, and
 * plays the remaining moves.
 */
function resumeRun(backing: MemoryStorage): RunLeg {
  const manager = new LocalStorageManager({ storage: backing });
  const config = createDefaultRulesConfig();
  const loaded = new RunStateStore({ storage: manager, config }).load();

  expect(loaded.outcome).toBe('loaded');
  expect(loaded.verdict).toBe('current');

  const envelope = loaded.state;

  if (envelope === null) {
    throw new Error('the persisted run envelope was refused on load');
  }

  const streams = createRngStreams(envelope.seed, envelope.rngCursor);
  const engine = new Engine({ config, streams, storage: manager });

  engine.setup(envelope.board);

  const resolved: boolean[] = [];

  for (const direction of MOVE_LIST.slice(MOVES_BEFORE_RELOAD)) {
    resolved.push(engine.move(direction));
  }

  return {
    engine,
    streams,
    serialized: engine.serialize(),
    cursors: streams.snapshotCursors(),
    resolved,
  };
}

describe('AAP Contract 5 — the persisted run envelope', () => {
  it('wraps the legacy board snapshot verbatim', () => {
    const interrupted = interruptRun();

    expect(interrupted.envelope.board).toEqual(interrupted.halfway);
    expect(Object.keys(interrupted.envelope.board).sort()).toEqual([
      'grid',
      'keepPlaying',
      'over',
      'score',
      'won',
    ]);
  });

  it('carries a schema version and a cursor for every substream', () => {
    const interrupted = interruptRun();

    expect(interrupted.envelope.schemaVersion).toBe(RUN_STATE_SCHEMA_VERSION);
    expect(interrupted.envelope.runId).toBe(FIXED_RUN_ID);
    expect(interrupted.envelope.seed).toBe(RUN_SEED);

    for (const name of RNG_STREAM_NAMES) {
      expect(typeof interrupted.envelope.rngCursor[name]).toBe('number');
    }

    expect(Object.keys(interrupted.envelope.rngCursor).sort()).toEqual(
      [...RNG_STREAM_NAMES].sort(),
    );
  });

  it('reproduces its recorded envelope', () => {
    const interrupted = interruptRun();
    const projected = projectEnvelope(interrupted.envelope);

    // The run identifier is carried by the envelope and NOT by the artifact:
    // asserted here against the fixed fixture value, and absent from the text
    // the snapshot records.
    expect(interrupted.envelope.runId).toBe(FIXED_RUN_ID);
    expect(projected).not.toContain(FIXED_RUN_ID);
    expect(projected).not.toContain('runId');

    expect(projected).toMatchSnapshot('envelope at the interruption');
  });
});

describe('AAP V2 — a run interrupted and resumed from storage', () => {
  it('reaches the board the uninterrupted run reached', () => {
    const straight = driveRun({ seed: RUN_SEED });
    const resumed = resumeRun(interruptRun().backing);

    expect(resumed.serialized).toEqual(straight.serialized);
  });

  it('reaches the cursors the uninterrupted run reached', () => {
    const straight = driveRun({ seed: RUN_SEED });
    const resumed = resumeRun(interruptRun().backing);

    expect(resumed.cursors).toEqual(straight.cursors);
  });

  it('reproduces the recorded board after the resume', () => {
    expect(renderLeg(resumeRun(interruptRun().backing))).toMatchSnapshot(
      'resumed run',
    );
  });
});

/* ==========================================================================
 * 6b. A REWARD ROUND carried across the reload — AAP V2
 * ==========================================================================
 *
 * The leg composes what src/main.ts composes — a `RelicRegistry` over
 * `RELIC_CATALOGUE`, a `RunController` over a `RunStateStore`, `drawRelicOffers`
 * as the draw port and a real `Engine` over the shared hook bus — plays a fixed
 * move list, takes a real relic from a real offer, throws the whole stack away,
 * rebuilds it over the same storage and plays on. It is compared against the
 * same run played straight through with no interruption.
 *
 * What it measures: board state, the relics held, the offer sets drawn and the
 * persisted `rngCursor` are all identical across the two legs, which is the half
 * of gate V2 (AAP 0.8.2) covering IDENTICAL RELIC DRAWS across a reload.
 * Decisions DL-RUNCTL-02, DL-RUN-06, DL-TEST-08.
 */

/**
 * Directions the reward-carrying leg plays: 44 moves, over which three stages
 * clear and a relic is taken at each — two before the interruption and one after
 * it — with the run still LIVE at the end. DL-TEST-08.
 */
const REWARD_MOVE_LIST: readonly Direction[] = Array.from(
  { length: 44 },
  (_value, index): Direction =>
    [DIRECTION_UP, DIRECTION_RIGHT, DIRECTION_DOWN, DIRECTION_LEFT][
      index % 4
    ] as Direction,
);

/** One reward round as this section records it. */
interface RewardRound {
  readonly stageIndex: number;
  readonly offered: readonly string[];
  readonly taken: string;
}

/** The whole production stack, composed the way src/main.ts composes it. */
interface ProductionStack {
  readonly controller: RunController;
  readonly engine: Engine;
  readonly registry: RelicRegistry;
  readonly streams: () => RngStreams;
  readonly stop: () => void;
}

/**
 * Composes the run controller, the relic registry, the draw port and the engine
 * over one storage backing.
 *
 * Nothing here is a double: the registry holds the shipped catalogue, the draw
 * is `drawRelicOffers`, and the controller's two ports delegate to the registry
 * on every call rather than capturing a snapshot, so a relic picked up between
 * calls is seen.
 *
 * @param seed Seed a FRESH run would be played under. A stored envelope's own
 *   seed wins, which is what makes the resumed leg continue rather than restart.
 * @param backing Storage the envelope is written to and read from.
 * @returns The composed stack, and the release for the controller's subscription.
 */
function composeProductionStack(
  seed: string,
  backing: MemoryStorage,
): ProductionStack {
  const manager = new LocalStorageManager({ storage: backing });
  const config = createDefaultRulesConfig();
  const stages = createDefaultStageConfig();
  const tokens = [seed, FIXED_RUN_ID];

  let nextToken = 0;
  const createToken = (): string =>
    tokens[nextToken++] ?? `token-${String(nextToken)}`;

  const hooks = createHookBus({ correlationId: seed });
  const registry = new RelicRegistry({ catalogue: RELIC_CATALOGUE, bus: hooks });

  let streams: RngStreams | null = null;

  const controller = new RunController({
    store: new RunStateStore({ storage: manager, config }),
    identity: resolveRunIdentity({ storage: manager, createToken }),
    config,
    stages,
    createToken,
    relics: {
      snapshotRelics: () => registry.serialize(),
      activateRelic: (relicId) =>
        registry.pickUp(relicId) === undefined
          ? null
          : (registry.serialize().find((held) => held.id === relicId) ?? null),
      ownedRelicIds: () => registry.ownedIds(),
      restoreRelics: (relics) => {
        registry.restore(relics);
      },
      resolveRelic: (relicId) => {
        const known = registry
          .catalogue()
          .find((relic) => relic.id === relicId);

        return known === undefined
          ? null
          : Object.freeze({
              id: known.id,
              ...(known.charges === undefined ? {} : { charges: known.charges }),
            });
      },
    },
    rewards: {
      draw: ({ count, ownedIds }) =>
        streams === null
          ? []
          : drawRelicOffers({
              pool: registry.catalogue(),
              ownedIds,
              count,
              streams,
            }).map((relic) => ({
              id: relic.id,
              name: relic.name,
              rarity: relic.rarity,
              description: relic.description,
              hooks: Object.freeze(
                HOOK_NAMES.filter((name) => relic.hooks[name] !== undefined),
              ),
              ...(relic.charges === undefined ? {} : { charges: relic.charges }),
            })),

      // The non-random projector: a round restored from the envelope is rebuilt
      // from the catalogue by identifier, so no draw is repeated on a reload.
      project: (relicIds) =>
        relicIds.flatMap((relicId) => {
          const known = registry
            .catalogue()
            .find((relic) => relic.id === relicId);

          return known === undefined
            ? []
            : [
                {
                  id: known.id,
                  name: known.name,
                  rarity: known.rarity,
                  description: known.description,
                  hooks: Object.freeze(
                    HOOK_NAMES.filter(
                      (name) => known.hooks[name] !== undefined,
                    ),
                  ),
                  ...(known.charges === undefined
                    ? {}
                    : { charges: known.charges }),
                },
              ];
        }),
    },
  });

  // `begin()` adopts the stored envelope where there is one — its seed, its
  // cursors, its relics and any round left standing — and only then is the
  // generator built, so a resumed leg continues the sequence it was on.
  controller.begin();

  streams = createRngStreams(controller.seed(), controller.cursors());

  const engine = new Engine({
    config,
    streams,
    storage: manager,
    hooks,
    stageContext: () => controller.stageContext(),
    relicContext: () => controller.relicContext(),
  });

  const live = streams;
  const stop = controller.observe(engine, () => live.snapshotCursors());

  controller.openEngineBoard(engine);

  return {
    controller,
    engine,
    registry,
    streams: (): RngStreams => live,
    stop,
  };
}

/**
 * Plays a slice of `REWARD_MOVE_LIST` on a composed stack, taking every reward
 * the run is offered.
 *
 * @param stack Stack to play on.
 * @param from First move index to play, inclusive.
 * @param to Last move index to play, exclusive.
 * @param rounds Collector every reward round is appended to.
 */
function playTakingRewards(
  stack: ProductionStack,
  from: number,
  to: number,
  rounds: RewardRound[],
): void {
  for (const direction of REWARD_MOVE_LIST.slice(from, to)) {
    stack.engine.move(direction);

    if (stack.engine.serialize().over || !stack.controller.isRewardPending()) {
      continue;
    }

    const cards = stack.controller.currentOffer();
    const chosen = cards[0];

    if (chosen === undefined) {
      throw new Error('a pending reward held no card');
    }

    const stageIndex = stack.controller.stageIndex();
    const selection = stack.controller.selectReward(chosen.id, stack.engine);

    expect(selection.outcome).toBe('accepted');

    rounds.push({
      stageIndex,
      offered: cards.map((card): string => card.id),
      taken: chosen.id,
    });
  }
}

/** What one leg of the reward-carrying comparison produced. */
interface RewardLeg {
  readonly rounds: readonly RewardRound[];
  readonly owned: readonly string[];
  readonly board: SerializedGameState;
  readonly cursors: RngCursorMap;
  readonly stageIndex: number;
}

/** Reads a played stack's outcome and releases its subscription. */
function closeLeg(
  stack: ProductionStack,
  rounds: readonly RewardRound[],
): RewardLeg {
  const leg: RewardLeg = {
    rounds,
    owned: stack.registry.ownedIds(),
    board: stack.engine.serialize(),
    cursors: stack.streams().snapshotCursors(),
    stageIndex: stack.controller.stageIndex(),
  };

  stack.stop();

  return leg;
}

/** Plays the whole move list on one stack, with no interruption. */
function playStraightThrough(): RewardLeg {
  const stack = composeProductionStack(RUN_SEED, createBacking());
  const rounds: RewardRound[] = [];

  playTakingRewards(stack, 0, REWARD_MOVE_LIST.length, rounds);

  return closeLeg(stack, rounds);
}

/**
 * Plays the same move list, throwing the entire stack away partway and
 * rebuilding it over the same storage.
 *
 * The rebuild is what a reload is: a new manager, a new store, a new registry,
 * a new controller, a new generator and a new engine, with nothing carried in
 * memory across the boundary.
 */
function playAcrossReload(): { readonly leg: RewardLeg; readonly halfway: number } {
  const backing = createBacking();
  const first = composeProductionStack(RUN_SEED, backing);
  const rounds: RewardRound[] = [];

  playTakingRewards(first, 0, MOVES_BEFORE_REWARD_RELOAD, rounds);

  const roundsBeforeReload = rounds.length;

  first.stop();

  const second = composeProductionStack(RUN_SEED, backing);

  playTakingRewards(
    second,
    MOVES_BEFORE_REWARD_RELOAD,
    REWARD_MOVE_LIST.length,
    rounds,
  );

  return { leg: closeLeg(second, rounds), halfway: roundsBeforeReload };
}

/** Renders a leg's rounds, relics, board and cursors as one artifact. */
function renderRewardLeg(leg: RewardLeg): string {
  return [
    'reward rounds, in the order they were offered',
    ...leg.rounds.map(
      (round): string =>
        `  stage ${String(round.stageIndex + 1)}  TAKEN ${round.taken.padEnd(
          18,
        )}offered ${round.offered.join(', ')}`,
    ),
    '',
    `relics held, in pickup order: ${leg.owned.join(', ')}`,
    `stage reached: ${String(leg.stageIndex + 1)}`,
    '',
    projectBoard(leg.board),
    'rngCursor',
    projectCursors(leg.cursors),
  ].join('\n');
}

describe('AAP V2 — a REWARD ROUND survives the reload', () => {
  it('takes relics on BOTH sides of the interruption, so the case has teeth', () => {
    const { leg, halfway } = playAcrossReload();

    // Guards the whole section: were the move slice ever to stop clearing a
    // stage, every assertion below would compare two runs that had never been
    // offered anything and would pass without meaning. A round on each side is
    // what makes this a continuation rather than a replay.
    expect(halfway).toBeGreaterThan(0);
    expect(leg.rounds.length).toBeGreaterThan(halfway);

    // And the run is still in progress, so the comparison is between two live
    // runs rather than two finished ones.
    expect(leg.board.over).toBe(false);
  });

  it('reaches the board the uninterrupted run reached', () => {
    expect(playAcrossReload().leg.board).toEqual(playStraightThrough().board);
  });

  it('holds the same relics, in the same pickup order', () => {
    const resumed = playAcrossReload().leg;
    const straight = playStraightThrough();

    expect(resumed.owned).toEqual(straight.owned);
    expect(resumed.owned.length).toBeGreaterThan(0);
  });

  it('is offered the same cards, in the same order, at every stage', () => {
    const resumed = playAcrossReload().leg;
    const straight = playStraightThrough();

    // The offer identifiers themselves, not their count: this is the assertion
    // that the reward substreams resumed where they stood.
    expect(resumed.rounds).toEqual(straight.rounds);
  });

  it('reaches all four cursors the uninterrupted run reached', () => {
    const resumed = playAcrossReload().leg;
    const straight = playStraightThrough();

    expect(resumed.cursors).toEqual(straight.cursors);

    for (const name of RNG_STREAM_NAMES) {
      expect(resumed.cursors[name]).toBe(straight.cursors[name]);
    }

    // And the reward substreams actually moved, so the equality above is not two
    // runs agreeing that nothing happened.
    expect(resumed.cursors['relic-draw']).toBeGreaterThan(0);
    expect(resumed.cursors['rarity-weight']).toBeGreaterThan(0);
  });

  it('reaches the same stage', () => {
    expect(playAcrossReload().leg.stageIndex).toBe(
      playStraightThrough().stageIndex,
    );
  });

  it('reproduces its recorded rounds, relics, board and cursors', () => {
    expect(renderRewardLeg(playAcrossReload().leg)).toMatchSnapshot(
      'a reward round carried across a reload',
    );
  });
});

/* ==========================================================================
 * 6c. A STANDING OFFER carried across the reload — AAP V2, K2
 * ==========================================================================
 *
 * Section 6b interrupts between rounds: every offer it draws is taken in the
 * same move it is drawn, so no round is ever standing when the stack is thrown
 * away. This section interrupts WITH ONE STANDING — after the draw and before
 * the selection — which is the state a player reloading the reward screen is in.
 *
 * Contract 5's `rngCursor` is what the leg measures: the envelope written while
 * a round stands must carry the counts the draw itself reached, or the resumed
 * substreams are rebuilt behind their real position and the spent draws come
 * out again. Decisions DL-RUNCTL-02, DL-RUNCTL-19.
 * ========================================================================== */

/** Takes the standing offer's first card and records the round. */
function takeStandingOffer(
  stack: ProductionStack,
  rounds: RewardRound[],
): readonly string[] {
  const cards = stack.controller.currentOffer();
  const chosen = cards[0];

  if (chosen === undefined) {
    throw new Error('a pending reward held no card');
  }

  const stageIndex = stack.controller.stageIndex();
  const selection = stack.controller.selectReward(chosen.id, stack.engine);

  expect(selection.outcome).toBe('accepted');

  const offered = cards.map((card): string => card.id);

  rounds.push({ stageIndex, offered, taken: chosen.id });

  return offered;
}

/** Where a pause left the move list, and the offer left standing on it. */
interface StandingOffer {
  /** First move index not yet played. */
  readonly next: number;
  readonly offered: readonly string[];
}

/**
 * Plays moves from `from` and stops on the first one that leaves an offer
 * standing, WITHOUT taking it.
 *
 * @param stack Stack to play on.
 * @param from First move index to play, inclusive.
 * @param to Last move index to play, exclusive.
 * @returns The pause, or `null` where no round stood and no move was left.
 */
function playToStandingOffer(
  stack: ProductionStack,
  from: number,
  to: number,
): StandingOffer | null {
  for (let index = from; index < to; index += 1) {
    const direction = REWARD_MOVE_LIST[index];

    if (direction === undefined) {
      return null;
    }

    stack.engine.move(direction);

    if (stack.engine.serialize().over) {
      return null;
    }

    if (stack.controller.isRewardPending()) {
      return {
        next: index + 1,
        offered: stack.controller
          .currentOffer()
          .map((card): string => card.id),
      };
    }
  }

  return null;
}

/** The cursors the stored envelope carries, read through the store. */
function readPersistedCursors(backing: MemoryStorage): RngCursorMap {
  const loaded = new RunStateStore({
    storage: new LocalStorageManager({ storage: backing }),
    config: createDefaultRulesConfig(),
  }).load();
  const envelope = loaded.state;

  if (envelope === null) {
    throw new Error('the persisted run envelope was refused on load');
  }

  return envelope.rngCursor;
}

/** What the standing-offer interruption produced. */
interface StandingInterruption {
  readonly leg: RewardLeg;

  /** Offer identifiers standing when the stack was thrown away. */
  readonly interrupted: readonly string[];

  /** The same offer as the rebuilt stack restored it. */
  readonly restored: readonly string[];

  /** Cursors the live generator had reached at the interruption. */
  readonly live: RngCursorMap;

  /** Cursors the envelope carried at the interruption. */
  readonly persisted: RngCursorMap;

  /** Rounds taken before the interruption. */
  readonly before: number;
}

/**
 * Plays the move list with the stack thrown away while a round stands, and the
 * standing card taken by the rebuilt stack.
 *
 * One round is taken before the interruption and the rest after it, so the leg
 * is a continuation rather than a replay.
 */
function playAcrossStandingReload(): StandingInterruption {
  const backing = createBacking();
  const first = composeProductionStack(RUN_SEED, backing);
  const rounds: RewardRound[] = [];
  const opened = playToStandingOffer(first, 0, REWARD_MOVE_LIST.length);

  if (opened === null) {
    throw new Error('no reward round stood before the interruption');
  }

  takeStandingOffer(first, rounds);

  const paused = playToStandingOffer(
    first,
    opened.next,
    REWARD_MOVE_LIST.length,
  );

  if (paused === null) {
    throw new Error('no second reward round stood to be interrupted');
  }

  const live = first.streams().snapshotCursors();
  const persisted = readPersistedCursors(backing);
  const before = rounds.length;

  first.stop();

  const second = composeProductionStack(RUN_SEED, backing);
  const restored = second.controller
    .currentOffer()
    .map((card): string => card.id);

  takeStandingOffer(second, rounds);
  playTakingRewards(second, paused.next, REWARD_MOVE_LIST.length, rounds);

  return {
    leg: closeLeg(second, rounds),
    interrupted: paused.offered,
    restored,
    live,
    persisted,
    before,
  };
}

describe('AAP V2 — a STANDING reward offer survives the reload', () => {
  it('interrupts with a round standing, after one has been taken', () => {
    const observed = playAcrossStandingReload();

    expect(observed.before).toBeGreaterThan(0);
    expect(observed.interrupted).toHaveLength(OFFERS_PER_SET);
    expect(observed.leg.rounds.length).toBeGreaterThan(observed.before + 1);
    expect(observed.leg.board.over).toBe(false);
  });

  it('persists the cursors the standing draw itself reached', () => {
    const observed = playAcrossStandingReload();

    expect(observed.persisted).toEqual(observed.live);

    for (const name of RNG_STREAM_NAMES) {
      expect(observed.persisted[name]).toBe(observed.live[name]);
    }

    expect(observed.live['relic-draw']).toBeGreaterThan(0);
    expect(observed.live['rarity-weight']).toBeGreaterThan(0);
  });

  it('restores the same three cards the interruption left standing', () => {
    const observed = playAcrossStandingReload();

    expect(observed.restored).toEqual(observed.interrupted);
  });

  it('reaches the board, relics, offers and cursors of one straight run', () => {
    const observed = playAcrossStandingReload();
    const straight = playStraightThrough();

    expect(observed.leg.rounds).toEqual(straight.rounds);
    expect(observed.leg.owned).toEqual(straight.owned);
    expect(observed.leg.board).toEqual(straight.board);
    expect(observed.leg.cursors).toEqual(straight.cursors);
    expect(observed.leg.stageIndex).toBe(straight.stageIndex);
  });

  it('reproduces its recorded rounds, relics, board and cursors', () => {
    expect(renderRewardLeg(playAcrossStandingReload().leg)).toMatchSnapshot(
      'a standing reward offer carried across a reload',
    );
  });
});

/* ==========================================================================
 * 7. The relic offers one seed draws — AAP V2
 * ========================================================================== */

describe('AAP V2 — the reward offers of one seed', () => {
  it('reproduces its recorded offer sequence', () => {
    // Identifiers alone, not whole relic objects.
    expect(
      projectOfferSets(
        drawOfferSets(createRngStreams(RUN_SEED), RELIC_CATALOGUE),
      ),
    ).toMatchSnapshot('catalogue offer ids by stage');
  });

  it('offers no identifier twice within one set', () => {
    const sets = drawOfferSets(createRngStreams(RUN_SEED), RELIC_CATALOGUE);

    expect(sets).toHaveLength(OFFER_SET_COUNT);

    for (const ids of sets) {
      expect(ids).toHaveLength(OFFERS_PER_SET);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('reproduces the sequence from a second generator on that seed', () => {
    expect(drawOfferSets(createRngStreams(RUN_SEED), RELIC_CATALOGUE)).toEqual(
      drawOfferSets(createRngStreams(RUN_SEED), RELIC_CATALOGUE),
    );
  });

  it('excludes an owned identifier from every later set', () => {
    const sets = drawOfferSets(createRngStreams(RUN_SEED), RELIC_CATALOGUE);
    const owned: string[] = [];

    for (const ids of sets) {
      for (const held of owned) {
        expect(ids).not.toContain(held);
      }

      const taken = ids[0];

      if (taken !== undefined) {
        owned.push(taken);
      }
    }

    expect(owned).toHaveLength(OFFER_SET_COUNT);
    expect(new Set(owned).size).toBe(owned.length);
  });

  it('draws one relic-draw and one rarity-weight per offer', () => {
    const streams = createRngStreams(RUN_SEED);
    const sets = drawOfferSets(streams, RELIC_CATALOGUE);
    const offered = sets.reduce((total, ids) => total + ids.length, 0);
    const cursors = streams.snapshotCursors();

    expect(cursors['relic-draw']).toBe(offered);
    expect(cursors['rarity-weight']).toBe(offered);

    // The board substreams are untouched by a reward draw.
    expect(cursors['spawn-value']).toBe(0);
    expect(cursors['spawn-position']).toBe(0);
  });
});

describe('AAP Contract 6 — the four substreams are independent', () => {
  it('leaves the board and the spawn cursors at the baseline', () => {
    const baseline = driveRun({ seed: RUN_SEED });
    const noisy = driveRun({
      seed: RUN_SEED,
      betweenMoves: (streams) => {
        drawRelicOffers({
          pool: HAND_BUILT_POOL,
          count: INTERLEAVED_OFFER_COUNT,
          streams,
        });
      },
    });

    expect(noisy.serialized).toEqual(baseline.serialized);
    expect(noisy.serialized.score).toBe(baseline.serialized.score);
    expect(noisy.resolved).toEqual(baseline.resolved);
    expect(projectBoard(noisy.serialized)).toBe(
      projectBoard(baseline.serialized),
    );
    expect(noisy.cursors['spawn-value']).toBe(baseline.cursors['spawn-value']);
    expect(noisy.cursors['spawn-position']).toBe(
      baseline.cursors['spawn-position'],
    );

    // The interleaved draws were taken.
    expect(noisy.cursors['relic-draw']).toBeGreaterThan(
      baseline.cursors['relic-draw'],
    );
    expect(noisy.cursors['rarity-weight']).toBeGreaterThan(
      baseline.cursors['rarity-weight'],
    );
  });

  it('draws the same hand-built offers whatever the board consumed', () => {
    const bare = createRngStreams(RUN_SEED);
    const played = driveRun({ seed: RUN_SEED }).streams;

    expect(
      drawOfferSets(played, HAND_BUILT_POOL),
    ).toEqual(drawOfferSets(bare, HAND_BUILT_POOL));
  });
});

describe('AAP Contract 2 — dispatch follows pickup order', () => {
  /** Two subscribers on one hook, in a fixed pickup order. */
  function createOrderedBus(record: string[]): HookBus {
    const bus = createHookBus();

    // Registered without a pickupOrder, so each is appended to the end of the
    // order.
    for (const id of ['first', 'second']) {
      expect(
        bus.register({
          id,
          hooks: {
            onSpawn: (): void => {
              record.push(id);
            },
          },
        }),
      ).toBe(true);
    }

    return bus;
  }

  it('invokes both subscribers, in pickup order, on every spawn', () => {
    const record: string[] = [];
    const leg = driveRun({ seed: RUN_SEED, hooks: createOrderedBus(record) });

    expect(record.length).toBeGreaterThan(0);
    expect(record.length % 2).toBe(0);

    for (let index = 0; index < record.length; index += 2) {
      expect(record[index]).toBe('first');
      expect(record[index + 1]).toBe('second');
    }

    // One dispatch pair per spawn, and a spawn per start tile and per resolved
    // move.
    expect(record.length).toBe(leg.cursors['spawn-value'] * 2);
  });

  it('reproduces the run for the same pickup order', () => {
    const firstRecord: string[] = [];
    const secondRecord: string[] = [];
    const first = driveRun({
      seed: RUN_SEED,
      hooks: createOrderedBus(firstRecord),
    });
    const second = driveRun({
      seed: RUN_SEED,
      hooks: createOrderedBus(secondRecord),
    });

    expect(secondRecord).toEqual(firstRecord);
    expect(second.serialized).toEqual(first.serialized);
    expect(second.cursors).toEqual(first.cursors);
  });

  it('reproduces the recorded board and dispatch order', () => {
    const record: string[] = [];
    const leg = driveRun({ seed: RUN_SEED, hooks: createOrderedBus(record) });

    expect(
      [
        renderLeg(leg),
        'dispatch order, one line per spawn',
        projectDispatchPairs(record),
      ].join('\n'),
    ).toMatchSnapshot('pickup-ordered dispatch');
  });

  it('leaves the baseline board unchanged', () => {
    const record: string[] = [];
    const bus = createOrderedBus(record);
    const hooked = driveRun({ seed: RUN_SEED, hooks: bus });

    expect(hooked.serialized).toEqual(driveRun({ seed: RUN_SEED }).serialized);
  });
});

describe('AAP Contract 6 — the platform generator is never patched', () => {
  it('captured the platform implementation, not an installed one', () => {
    expect(Function.prototype.toString.call(PLATFORM_MATH_RANDOM)).toContain(
      '[native code]',
    );
  });

  it('holds that exact reference after a run, a draw and a reload', () => {
    driveRun({ seed: RUN_SEED });
    drawOfferSets(createRngStreams(RUN_SEED), RELIC_CATALOGUE);
    resumeRun(interruptRun().backing);

    const { random: platformRandomNow } = Math;

    expect(platformRandomNow).toBe(PLATFORM_MATH_RANDOM);
  });

  it('holds the descriptor the platform installed it under', () => {
    driveRun({ seed: RUN_SEED });

    expect(Object.getOwnPropertyDescriptor(Math, 'random')).toEqual(
      PLATFORM_MATH_RANDOM_DESCRIPTOR,
    );
  });
});

describe('AAP Rule 3 — an appended subscriber is omittable', () => {
  it('leaves the board and the cursors identical to the baseline', () => {
    const baseline = driveRun({ seed: RUN_SEED });
    const seen: string[] = [];
    const watched = driveRun({
      seed: RUN_SEED,
      attach: (engine) => {
        for (const name of ENGINE_EVENT_NAMES) {
          engine.events.on(name, () => {
            seen.push(name);
          });
        }
      },
    });

    expect(seen.length).toBeGreaterThan(0);
    expect(watched.serialized).toEqual(baseline.serialized);
    expect(watched.cursors).toEqual(baseline.cursors);
    expect(renderLeg(watched)).toBe(renderLeg(baseline));
  });
});

/*
 * The gate above proves the append-only property with one collector. The gate
 * below proves it with the PRODUCTION observability stack — the real logger, the
 * real metrics registry, the real tracer and `attachEngineTracing` — over a run
 * that also draws its reward offers from the substreams the board consumes, so
 * every consumer of Contract 6 is compared at once: the serialised board byte
 * for byte, the cursor text in `RNG_STREAM_NAMES` order, and the offer
 * identifiers in draw order. The observed leg's projection is pinned, so the
 * artifact is the expectation for a run WITH observability enabled.
 *
 * Decision DL-TEST-07.
 */

describe('AAP Rule 3 — the real observer stack is omittable', () => {
  it('serialises the board to the same bytes as the observer-free leg', () => {
    const baseline = driveRewardScenario();
    const observed = driveRewardScenario(createRealObservers(RUN_SEED));

    // Byte for byte, not member by member: a reordered or re-typed member is a
    // difference in the persisted board even where a deep compare passes.
    expect(JSON.stringify(observed.leg.serialized)).toBe(
      JSON.stringify(baseline.leg.serialized),
    );
    expect(observed.leg.serialized).toEqual(baseline.leg.serialized);
    expect(observed.leg.resolved).toEqual(baseline.leg.resolved);
  });

  it('reaches the same cursor on every substream', () => {
    const baseline = driveRewardScenario();
    const observed = driveRewardScenario(createRealObservers(RUN_SEED));

    // The rendered text, in `RNG_STREAM_NAMES` order rather than in whatever
    // order the object's own keys happen to be in.
    expect(projectCursors(observed.leg.cursors)).toBe(
      projectCursors(baseline.leg.cursors),
    );

    for (const name of RNG_STREAM_NAMES) {
      expect(observed.leg.cursors[name]).toBe(baseline.leg.cursors[name]);
    }

    // The scenario consumed from every substream, so an observer that consumed
    // one would move a cursor this assertion pins rather than one it ignores.
    expect(observed.leg.cursors['spawn-value']).toBeGreaterThan(0);
    expect(observed.leg.cursors['spawn-position']).toBeGreaterThan(0);
    expect(observed.leg.cursors['relic-draw']).toBe(
      OFFER_SET_COUNT * OFFERS_PER_SET,
    );
    expect(observed.leg.cursors['rarity-weight']).toBe(
      OFFER_SET_COUNT * OFFERS_PER_SET,
    );
  });

  it('draws the same relic offers in the same order', () => {
    const baseline = driveRewardScenario();
    const observed = driveRewardScenario(createRealObservers(RUN_SEED));

    expect(projectOfferSets(observed.offerSets)).toBe(
      projectOfferSets(baseline.offerSets),
    );
    expect(observed.offerSets).toEqual(baseline.offerSets);
    expect(observed.offerSets).toHaveLength(OFFER_SET_COUNT);

    for (const ids of observed.offerSets) {
      expect(ids).toHaveLength(OFFERS_PER_SET);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('pins the observed board, cursors and offers', () => {
    const observed = projectRewardScenario(
      driveRewardScenario(createRealObservers(RUN_SEED)),
    );

    // Recorded from the OBSERVED leg, and asserted to be what the observer-free
    // leg renders as well, so one pinned artifact is the expectation for both
    // and a divergence in either direction fails this gate.
    expect(projectRewardScenario(driveRewardScenario())).toBe(observed);
    expect(observed).toMatchSnapshot('observed run: board, cursors and offers');
  });

  it('ran the real observers rather than nothing at all', () => {
    const observers = createRealObservers(RUN_SEED);

    driveRewardScenario(observers);

    const evidence = observers.evidence();

    // Without these the gate would pass with nothing attached, which is exactly
    // the way an observer-omittable assertion goes quietly vacuous.
    expect(evidence.eventsObserved).toBeGreaterThan(0);
    expect(evidence.cursorsRead).toBeGreaterThan(0);
    expect(evidence.engineCounts).toBeGreaterThan(0);
    expect(evidence.engineCountSeries).toBeGreaterThan(0);
    expect(evidence.logRecords).toBeGreaterThan(0);
    expect(evidence.metricSeries).toBeGreaterThan(0);
    expect(evidence.spansStarted).toBeGreaterThan(0);

    // Released after the leg, so every span the tracer opened is closed and
    // none was faulted.
    expect(evidence.spansEnded).toBe(evidence.spansStarted);
    expect(evidence.spansOpen).toBe(0);
    expect(evidence.traceFaults).toBe(0);
  });

  it('holds the platform generator unpatched with the stack attached', () => {
    driveRewardScenario(createRealObservers(RUN_SEED));

    const { random: platformRandomNow } = Math;

    expect(platformRandomNow).toBe(PLATFORM_MATH_RANDOM);
    expect(Object.getOwnPropertyDescriptor(Math, 'random')).toEqual(
      PLATFORM_MATH_RANDOM_DESCRIPTOR,
    );
  });
});

/* ==========================================================================
 * 9. Teardown
 * ========================================================================== */

describe('js/local_storage_manager.js L22 — the best-score key', () => {
  it('is one of the keys the teardown iterates', () => {
    expect(OWNED_STORAGE_KEYS).toContain(BEST_SCORE_KEY);
  });

  it('reads back as the stored string and is removed by the teardown', () => {
    const backing = createBacking();
    const manager = new LocalStorageManager({ storage: backing });

    expect(manager.setBestScore(1024)).toBe(true);

    // L43-L45 returned the stored value with no conversion.
    expect(manager.getBestScore()).toBe('1024');

    clearInjectedStores();

    expect(backing.getItem(BEST_SCORE_KEY)).toBeUndefined();
  });
});
