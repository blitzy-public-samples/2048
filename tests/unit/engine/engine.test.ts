// Orchestration suite of src/engine/engine.ts: the DOM-free rules engine and
// turn orchestrator, and the primary successor to js/game_manager.js.
//
// Every collaborator arrives through the single options object, so this suite
// needs no mocking library and no module mocking; the doubles in the next
// section are hand written. It reads no DOM and no storage, and runs in the
// `unit:dom-free` project of vitest.config.ts, whose environment is 'node'.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_BOARD_SIZE,
  createDefaultRulesConfig,
} from '../../../src/config/default-config';
import type { RulesConfig } from '../../../src/config/rules-config';
import {
  DEFAULT_STAGE_CONFIG,
  createDefaultStageConfig,
  stageGoalForIndex,
} from '../../../src/config/stage-config';
import type { StageGoal } from '../../../src/config/stage-config';
import { Engine } from '../../../src/engine/engine';
import type { EngineStoragePort } from '../../../src/engine/engine';
import {
  ENGINE_EVENT_NAMES,
  createEngineEvents,
} from '../../../src/engine/engine-events';
import type {
  BoardProjection,
  EngineEventName,
  MoveAfterEvent,
  StateCommitEvent,
} from '../../../src/engine/engine-events';
import { Grid } from '../../../src/engine/grid';
import { createHookBus } from '../../../src/engine/hook-bus';
import type { BeforeMovePayload } from '../../../src/engine/hooks';
import { Tile } from '../../../src/engine/tile';
import { InputManager } from '../../../src/input/input-manager';
import { INPUT_EVENT_NAMES } from '../../../src/input/keymap';
import type { InputEventPayload } from '../../../src/input/keymap';
import {
  DIRECTION_DOWN,
  DIRECTION_LEFT,
  DIRECTION_RIGHT,
  DIRECTION_UP,
  EMPTY_RELIC_CONTEXT,
  EMPTY_STAGE_CONTEXT,
  NOOP_ENGINE_REPORTER,
} from '../../../src/engine/types';
import type {
  BestScorePort,
  CellMatrix,
  Direction,
  EngineCountReport,
  EngineReporter,
  Position,
  SerializedGameState,
  SerializedTile,
  StageCommitContext,
} from '../../../src/engine/types';
import { createLogger } from '../../../src/observability/logger';
import {
  METRIC_NAMES,
  createMetricsRegistry,
} from '../../../src/observability/metrics';
import {
  SPAN_ATTRIBUTES,
  SPAN_NAMES,
  SPAN_OUTCOMES,
  attachEngineTracing,
  createTracer,
} from '../../../src/observability/tracer';
import { createRngStreams } from '../../../src/rng/rng-streams';
import type { RngStreams } from '../../../src/rng/rng-streams';
import {
  BLOCKED_BOARD,
  EMPTY_BOARD,
  MERGE_PAIR_BOARD,
  NEAR_LOSS_BOARD,
  NEAR_WIN_BOARD,
  copyBoard,
  createEmptyBoard,
  createNearWinBoard,
} from '../../fixtures/boards';

/** Run seed every deterministic case below is built from. */
const RUN_SEED = 'engine-suite-seed-1';

/** A second run seed, for the cases that compare two runs. */
const OTHER_SEED = 'engine-suite-seed-2';

/** Correlation identifier the tracer-integration cases key their spans on. */
const TRACED_CORRELATION_ID = 'run-engine-suite-traced';

/** The win value js/game_manager.js L170 compared against. */
const VANILLA_WIN_VALUE = 2048;

/** The start-tile count js/game_manager.js L7 held. */
const VANILLA_START_TILES = 2;

/** The two spawn values js/game_manager.js L71 could produce. */
const VANILLA_SPAWN_VALUES: readonly number[] = [2, 4];

/** The weights js/game_manager.js L71's `< 0.9` expressed. */
const VANILLA_SPAWN_WEIGHTS: readonly number[] = [0.9, 0.1];

/** The four members of `HookPayloadMap` a dispatch order is recorded as. */
const ALL_HOOK_ORDER: readonly string[] = [
  'onStageStart',
  'onBeforeMove',
  'onMerge',
  'onSpawn',
  'onAfterMove',
  'onStageEnd',
];

/**
 * Builds the run's four substreams.
 *
 * @param seed Run seed. Defaults to `RUN_SEED`.
 * @returns Substreams standing at cursor zero in every stream.
 */
function streamsFor(seed: string = RUN_SEED): RngStreams {
  return createRngStreams(seed);
}

/** One call the engine made on its persistence port. */
type PortCall =
  | 'getBestScore'
  | 'setBestScore'
  | 'getGameState'
  | 'setGameState'
  | 'clearGameState';

/** A persistence port that records what the engine asked of it. */
interface RecordingPort {
  /** The port itself, for `EngineOptions.storage`. */
  readonly port: EngineStoragePort;

  /** Every call, in the order the engine made it. */
  readonly calls: PortCall[];

  /** Every snapshot written through `setGameState`. */
  readonly written: SerializedGameState[];

  /**
   * The stored best score, in the frozen shape js/local_storage_manager.js
   * L43-L45 returned: the raw string when a value is present, and the number
   * `0` when it is absent.
   */
  best: string | 0;

  /** The stored board snapshot `getGameState` returns. */
  snapshot: unknown;

  /** Discards the call log and the written snapshots. */
  reset(): void;
}

/**
 * Builds a recording persistence port.
 *
 * @param snapshot Snapshot `getGameState` reports. Defaults to none.
 * @param best Best score `getBestScore` reports. Defaults to the absent
 *   reading `0`.
 * @returns The port and the three recordings taken through it.
 */
function createRecordingPort(
  snapshot: unknown = null,
  best: string | 0 = 0,
): RecordingPort {
  const calls: PortCall[] = [];
  const written: SerializedGameState[] = [];

  const recording: RecordingPort = {
    calls,
    written,
    best,
    snapshot,

    reset(): void {
      calls.length = 0;
      written.length = 0;
    },

    port: {
      getBestScore(): string | 0 {
        calls.push('getBestScore');

        return recording.best;
      },

      setBestScore(score: number): unknown {
        calls.push('setBestScore');
        recording.best = String(score);

        return true;
      },

      getGameState(): unknown {
        calls.push('getGameState');

        return recording.snapshot;
      },

      setGameState(state: unknown): unknown {
        calls.push('setGameState');
        written.push(state as SerializedGameState);

        return true;
      },

      clearGameState(): unknown {
        calls.push('clearGameState');
        recording.snapshot = null;

        return true;
      },
    },
  };

  return recording;
}

/** A report sink that keeps every count it receives. */
interface RecordingReporter {
  /** The sink itself, for `EngineOptions.reporter`. */
  readonly reporter: EngineReporter;

  /** Every count, in the order it was reported. */
  readonly counts: EngineCountReport[];
}

/**
 * Builds a recording report sink.
 *
 * @returns The sink and the counts taken through it.
 */
function createRecordingReporter(): RecordingReporter {
  const counts: EngineCountReport[] = [];

  return {
    counts,

    reporter: {
      onCount(report: EngineCountReport): void {
        counts.push(report);
      },
    },
  };
}

/** Correlation identifier the counter assertions pin every report to. */
const CORRELATION_ID_UNDER_TEST = 'run-correlation-metrics';

/** Every counter src/engine/engine.ts raises itself, as literals. */
const ENGINE_OWNED_METRICS: readonly string[] = Object.freeze([
  'engine.move.blocked',
  'engine.move.refused',
  'engine.move.cancelled',
  'engine.move.idle',
  'engine.move.resolved',
  'engine.spawn.attempt',
  'engine.spawn.suppressed',
  'engine.snapshot.rejected',
  'engine.snapshot.restored',
  'engine.board.reconciled',
  'engine.stage.cleared',
  'engine.storage.failed',
]);

/**
 * The counter names captured, in arrival order.
 *
 * @param counts Reports the sink captured.
 * @returns The `metric` of each, in order.
 */
function metricNamesOf(counts: readonly EngineCountReport[]): string[] {
  return counts.map((count) => count.metric);
}

/**
 * The engine's own counter names, in arrival order, with the emitter's and the
 * bus's removed.
 *
 * @param counts Reports the sink captured.
 * @returns The `metric` of each engine-owned report, in order.
 */
function engineMetricNamesOf(
  counts: readonly EngineCountReport[],
): string[] {
  return metricNamesOf(counts).filter((metric) =>
    ENGINE_OWNED_METRICS.includes(metric),
  );
}

/**
 * Sums the values captured under one counter name.
 *
 * @param counts Reports the sink captured.
 * @param metric Counter name to total.
 * @returns The total recorded under `metric`.
 */
function countOf(
  counts: readonly EngineCountReport[],
  metric: string,
): number {
  return counts
    .filter((count) => count.metric === metric)
    .reduce((total, count) => total + count.value, 0);
}

/**
 * Reads the report sink the engine holds.
 *
 * @param engine Engine to read.
 * @returns The sink in force.
 */
function reporterOf(engine: Engine): EngineReporter {
  return (engine as unknown as { readonly reporter: EngineReporter }).reporter;
}

/**
 * Projects the board to face values, in the x-major order js/grid.js L102-L117
 * serialised.
 *
 * @param engine Engine to read.
 * @returns `values[x][y]`, with `null` in every empty cell.
 */
function boardValues(engine: Engine): (number | null)[][] {
  return engine.grid.cells.map((column) =>
    column.map((tile) => (tile === null ? null : tile.value)),
  );
}

/**
 * Projects an emitted board to face values, in the same order `boardValues`
 * reads the live lattice in.
 *
 * @param board The projection an event carried.
 * @returns `values[x][y]`, with `null` in every empty cell.
 */
function boardValuesOf(board: BoardProjection): (number | null)[][] {
  return board.cells.map((column) =>
    column.map((tile) => (tile === null ? null : tile.value)),
  );
}

/**
 * Counts the tiles on the board, through the walk js/grid.js L58-L64
 * performed.
 *
 * @param engine Engine to read.
 * @returns The number of occupied cells.
 */
function tileCount(engine: Engine): number {
  let held = 0;

  engine.grid.eachCell((_x, _y, tile) => {
    if (tile !== null) {
      held += 1;
    }
  });

  return held;
}

/**
 * Reads one cell's face value.
 *
 * @param engine Engine to read.
 * @param x Column.
 * @param y Row.
 * @returns The value, or `null` where the cell is empty or out of bounds.
 */
function valueAt(engine: Engine, x: number, y: number): number | null {
  const tile = engine.grid.cellContent({ x, y });

  return tile === null ? null : tile.value;
}

/**
 * Collects every face value on the board.
 *
 * @param engine Engine to read.
 * @returns The values of the occupied cells, in the walk's order.
 */
function faceValues(engine: Engine): number[] {
  const values: number[] = [];

  engine.grid.eachCell((_x, _y, tile) => {
    if (tile !== null) {
      values.push(tile.value);
    }
  });

  return values;
}

/**
 * Builds a persisted snapshot from a y-major visual matrix.
 *
 * @param rows Row-major values, `null` for an empty cell.
 * @param overrides Snapshot members to replace; the four defaults are the
 *   fresh-game values js/game_manager.js L48-L51 assigned.
 * @returns A fresh, unfrozen snapshot.
 */
function snapshotFromRows(
  rows: readonly (readonly (number | null)[])[],
  overrides: Partial<SerializedGameState> = {},
): SerializedGameState {
  const size = rows.length;
  const cells: CellMatrix<SerializedTile> = [];

  for (let x = 0; x < size; x += 1) {
    const column: (SerializedTile | null)[] = [];

    for (let y = 0; y < size; y += 1) {
      const value = rows[y][x];

      column.push(value === null ? null : { position: { x, y }, value });
    }

    cells.push(column);
  }

  return {
    grid: { size, cells },
    score: 0,
    over: false,
    won: false,
    keepPlaying: false,
    ...overrides,
  };
}

/**
 * The rules with a single-valued spawn distribution, so a spawned value is
 * fixed whatever the seed draws.
 *
 * @param value The only value a spawn can take.
 * @returns A fresh configuration.
 */
function withFixedSpawn(value: number): RulesConfig {
  const config = createDefaultRulesConfig();

  config.spawn = { values: [value], weights: [1] };

  return config;
}

/**
 * The board that is one left move from having no move available, given a spawn
 * of 8: the pair in row 0 merges, the freed cell takes the spawn, and no two
 * neighbours then match.
 *
 * @returns A fresh, unfrozen snapshot.
 */
function createLosingBoard(): SerializedGameState {
  return snapshotFromRows([
    [2, 2],
    [16, 32],
  ]);
}

/**
 * Registers one subscriber bound to all six hooks, appending each hook's name
 * to `log` as it is dispatched.
 *
 * @param engine Engine whose bus to register on.
 * @param log List each dispatch appends to.
 */
function recordHooks(engine: Engine, log: string[]): void {
  engine.hooks.register({
    id: 'hook-order-recorder',
    hooks: {
      onStageStart: () => {
        log.push('onStageStart');
      },
      onBeforeMove: () => {
        log.push('onBeforeMove');
      },
      onMerge: () => {
        log.push('onMerge');
      },
      onSpawn: () => {
        log.push('onSpawn');
      },
      onAfterMove: () => {
        log.push('onAfterMove');
      },
      onStageEnd: () => {
        log.push('onStageEnd');
      },
    },
  });
}

/**
 * Subscribes to all seven events, appending each event's name to `log` as it
 * is emitted.
 *
 * @param engine Engine whose emitter to subscribe to.
 * @param log List each emission appends to.
 */
function recordEvents(engine: Engine, log: string[]): void {
  for (const name of ENGINE_EVENT_NAMES) {
    engine.events.on(name, () => {
      log.push(name);
    });
  }
}

/**
 * Subscribes to `state:commit` and collects every payload emitted after the
 * call.
 *
 * @param engine Engine whose emitter to subscribe to.
 * @returns The growing list of commits.
 */
function captureCommits(engine: Engine): StateCommitEvent[] {
  const commits: StateCommitEvent[] = [];

  engine.events.on('state:commit', (payload) => {
    commits.push(payload);
  });

  return commits;
}

/**
 * Plays a list of directions in order.
 *
 * @param engine Engine to drive.
 * @param directions Directions to play.
 * @returns One entry per direction, `true` where the board changed.
 */
function play(engine: Engine, directions: readonly Direction[]): boolean[] {
  return directions.map((direction) => engine.move(direction));
}

describe('constructor (js/game_manager.js L1-L14)', () => {
  it('constructs with every option but the substreams defaulted', () => {
    const engine = new Engine({ streams: streamsFor() });

    expect(engine.config.boardSize).toBe(DEFAULT_BOARD_SIZE);
    expect(engine.config.winValue).toBe(VANILLA_WIN_VALUE);
    expect(engine.config.startTiles).toBe(VANILLA_START_TILES);
    expect(engine.config.spawn.values).toEqual(VANILLA_SPAWN_VALUES);
    expect(engine.config.spawn.weights).toEqual(VANILLA_SPAWN_WEIGHTS);
    expect(engine.stages).toBe(DEFAULT_STAGE_CONFIG);
    expect(engine.stageResolution).toBe('observer');
    expect(engine.correlationId).toBe('');
    expect(engine.grid).toBeInstanceOf(Grid);
    expect(engine.grid.size).toBe(DEFAULT_BOARD_SIZE);
    expect(engine.score).toBe(0);
    expect(engine.over).toBe(false);
    expect(engine.won).toBe(false);
    expect(engine.continuedPlay).toBe(false);
  });

  it('plays a complete turn with no option beyond the substreams', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(valueAt(engine, 0, 0)).toBe(4);
    expect(engine.score).toBe(4);
  });

  it('leaves the board empty rather than setting up, unlike L13', () => {
    const engine = new Engine({ streams: streamsFor() });

    expect(tileCount(engine)).toBe(0);
  });

  it('takes a replacement rules configuration', () => {
    const config = createDefaultRulesConfig();

    config.winValue = 512;

    const engine = new Engine({ streams: streamsFor(), config });

    expect(engine.config).toBe(config);
    expect(engine.config.winValue).toBe(512);
  });

  it('takes a replacement progression curve', () => {
    const stages = createDefaultStageConfig();
    const engine = new Engine({ streams: streamsFor(), stages });

    expect(engine.stages).toBe(stages);
    expect(engine.stages).not.toBe(DEFAULT_STAGE_CONFIG);
  });

  it('takes the substreams, the emitter and the bus by reference', () => {
    const streams = streamsFor();
    const events = createEngineEvents();
    const hooks = createHookBus();
    const engine = new Engine({ streams, events, hooks });

    expect(engine.streams).toBe(streams);
    expect(engine.events).toBe(events);
    expect(engine.hooks).toBe(hooks);
  });

  it('takes a replacement stage-resolution authority', () => {
    const engine = new Engine({
      streams: streamsFor(),
      stageResolution: 'engine',
    });

    expect(engine.stageResolution).toBe('engine');
  });

  it('takes a correlation identifier verbatim', () => {
    const engine = new Engine({
      streams: streamsFor(),
      correlationId: 'run-correlation-1',
    });

    expect(engine.correlationId).toBe('run-correlation-1');
  });

  it('takes a correlation READER and resolves it on every read', () => {
    let current = 'run-first';
    const engine = new Engine({
      streams: streamsFor(),
      correlationId: (): string => current,
    });

    expect(engine.correlationId).toBe('run-first');

    // One page load can play more than one run.
    current = 'run-second';

    expect(engine.correlationId).toBe('run-second');
    expect(engine.hooks.metrics().correlationId).toBe('run-second');
  });

  it('reads the empty string where a correlation reader raises', () => {
    const engine = new Engine({
      streams: streamsFor(),
      correlationId: (): string => {
        throw new Error('correlation unavailable');
      },
    });

    expect(engine.correlationId).toBe('');
  });

  it('takes a persistence port carrying the best-score pair alone', () => {
    // js/local_storage_manager.js L43-L49 is the whole surface this port
    // exposes; the three snapshot calls L52-L63 made are absent.
    const bestScoreOnly: BestScorePort = {
      getBestScore: (): string | 0 => 0,
      setBestScore: (): unknown => undefined,
    };
    const engine = new Engine({
      streams: streamsFor(),
      storage: bestScoreOnly,
    });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(engine.score).toBe(4);
  });

  it('takes stage and relic context providers', () => {
    const goal: StageGoal = { kind: 'score-threshold', target: 500 };
    const engine = new Engine({
      streams: streamsFor(),
      stageContext: () => ({
        stageIndex: 4,
        goal,
        goalProgress: 0.25,
      }),
      relicContext: () => [{ id: 'relic-a', charges: 2 }],
    });
    const commits = captureCommits(engine);

    engine.setup(null);

    expect(commits).toHaveLength(1);
    expect(commits[0].stage.stageIndex).toBe(4);
    expect(commits[0].stage.goal).toEqual(goal);
    expect(commits[0].stage.goalProgress).toBe(0.25);
    expect(commits[0].relics).toEqual([{ id: 'relic-a', charges: 2 }]);
  });

  it('defaults the report sink to NOOP_ENGINE_REPORTER', () => {
    const engine = new Engine({ streams: streamsFor() });

    expect(reporterOf(engine)).toBe(NOOP_ENGINE_REPORTER);
  });

  it('takes an injected report sink and counts through it', () => {
    const recording = createRecordingReporter();
    const engine = new Engine({
      streams: streamsFor(),
      reporter: recording.reporter,
      correlationId: 'run-correlation-counted',
    });

    expect(reporterOf(engine)).toBe(recording.reporter);

    engine.setup(null);
    engine.move(DIRECTION_LEFT);

    // Named exactly and in order, not merely typed.
    expect(engineMetricNamesOf(recording.counts)).toEqual([
      // `setup(null)` restores nothing, which the engine counts as a refused
      // snapshot whether one was unreadable or none was offered.
      'engine.snapshot.rejected',
      // The two start tiles of js/game_manager.js L7.
      'engine.spawn.attempt',
      'engine.spawn.attempt',
      // The move's own spawn, then the resolution.
      'engine.spawn.attempt',
      'engine.move.resolved',
    ]);
    expect(countOf(recording.counts, 'engine.spawn.attempt')).toBe(3);
    expect(countOf(recording.counts, 'engine.move.resolved')).toBe(1);
    expect(countOf(recording.counts, 'engine.spawn.suppressed')).toBe(0);
    expect(countOf(recording.counts, 'engine.storage.failed')).toBe(0);

    for (const count of recording.counts) {
      expect(count.correlationId).toBe('run-correlation-counted');
      expect(count.value).toBe(1);
    }
  });

  it('names the counter of every branch one move can take', () => {
    const blocked = createRecordingReporter();
    const blockedEngine = new Engine({
      streams: streamsFor(),
      reporter: blocked.reporter,
      correlationId: CORRELATION_ID_UNDER_TEST,
    });

    blockedEngine.setup(copyBoard(NEAR_LOSS_BOARD));
    play(blockedEngine, [
      DIRECTION_LEFT,
      DIRECTION_UP,
      DIRECTION_RIGHT,
      DIRECTION_DOWN,
      DIRECTION_LEFT,
      DIRECTION_UP,
      DIRECTION_RIGHT,
      DIRECTION_DOWN,
    ]);

    expect(blockedEngine.isGameTerminated()).toBe(true);

    blocked.counts.length = 0;

    expect(blockedEngine.move(DIRECTION_LEFT)).toBe(false);

    // The refusal is the FIRST thing the move does, so nothing else counts: no
    // hook is dispatched and no event is emitted.
    expect(metricNamesOf(blocked.counts)).toEqual(['engine.move.blocked']);

    const cancelled = createRecordingReporter();
    const hooks = createHookBus({ correlationId: CORRELATION_ID_UNDER_TEST });

    hooks.register({
      id: 'veto',
      hooks: {
        onBeforeMove: (payload: BeforeMovePayload): BeforeMovePayload => ({
          ...payload,
          cancelled: true,
        }),
      },
    });

    const cancelledEngine = new Engine({
      streams: streamsFor(),
      reporter: cancelled.reporter,
      correlationId: CORRELATION_ID_UNDER_TEST,
      hooks,
    });

    cancelledEngine.setup(copyBoard(MERGE_PAIR_BOARD));
    cancelled.counts.length = 0;

    expect(cancelledEngine.move(DIRECTION_LEFT)).toBe(false);
    expect(engineMetricNamesOf(cancelled.counts)).toEqual([
      'engine.move.cancelled',
    ]);
    expect(countOf(cancelled.counts, 'engine.spawn.attempt')).toBe(0);
    expect(countOf(cancelled.counts, 'engine.move.resolved')).toBe(0);

    const idle = createRecordingReporter();
    const idleEngine = new Engine({
      streams: streamsFor(),
      reporter: idle.reporter,
      correlationId: CORRELATION_ID_UNDER_TEST,
    });

    idleEngine.setup(copyBoard(BLOCKED_BOARD));
    idle.counts.length = 0;

    expect(idleEngine.move(DIRECTION_LEFT)).toBe(false);
    expect(engineMetricNamesOf(idle.counts)).toEqual(['engine.move.idle']);

    // The no-op branch spawns nothing and resolves nothing, and after the
    // move:after it now emits it still commits nothing.
    expect(countOf(idle.counts, 'engine.spawn.attempt')).toBe(0);
    expect(countOf(idle.counts, 'engine.move.resolved')).toBe(0);

    for (const count of [
      ...blocked.counts,
      ...cancelled.counts,
      ...idle.counts,
    ]) {
      expect(count.correlationId).toBe(CORRELATION_ID_UNDER_TEST);
      expect(count.value).toBe(1);
    }
  });

  it('names the snapshot counters of a restored and a refused load', () => {
    const restored = createRecordingReporter();
    const restoringPort: EngineStoragePort = {
      getBestScore: (): string | 0 => 0,
      setBestScore: (): unknown => undefined,
      getGameState: (): unknown => copyBoard(MERGE_PAIR_BOARD),
      setGameState: (): unknown => undefined,
      clearGameState: (): unknown => undefined,
    };

    new Engine({
      streams: streamsFor(),
      reporter: restored.reporter,
      correlationId: CORRELATION_ID_UNDER_TEST,
      storage: restoringPort,
    }).setup();

    expect(engineMetricNamesOf(restored.counts)[0]).toBe(
      'engine.snapshot.restored'
    );
    expect(countOf(restored.counts, 'engine.snapshot.restored')).toBe(1);
    expect(countOf(restored.counts, 'engine.snapshot.rejected')).toBe(0);

    const rejected = createRecordingReporter();
    const rejectingPort: EngineStoragePort = {
      ...restoringPort,
      getGameState: (): unknown => ({ grid: 'not a grid' }),
    };

    new Engine({
      streams: streamsFor(),
      reporter: rejected.reporter,
      correlationId: CORRELATION_ID_UNDER_TEST,
      storage: rejectingPort,
    }).setup();

    expect(countOf(rejected.counts, 'engine.snapshot.rejected')).toBe(1);
    expect(countOf(rejected.counts, 'engine.snapshot.restored')).toBe(0);

    for (const count of [...restored.counts, ...rejected.counts]) {
      expect(count.correlationId).toBe(CORRELATION_ID_UNDER_TEST);
    }
  });

  it('plays a complete game with no report sink wired', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(null);

    expect(() => {
      play(engine, [DIRECTION_LEFT, DIRECTION_UP, DIRECTION_RIGHT]);
    }).not.toThrow();
    expect(tileCount(engine)).toBeGreaterThanOrEqual(VANILLA_START_TILES);
  });

  it('holds no view collaborator, which is AAP Figure 2', () => {
    const engine = new Engine({ streams: streamsFor() });
    const members = [
      ...Object.keys(engine),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(engine) as object),
    ];

    // js/game_manager.js L5 held `this.actuator` and L58, L91 and L189 called
    // into it; js/html_actuator.js exposed `actuate` at L10 and `continueGame`
    // at L39.
    expect(members).not.toContain('actuator');
    expect(members).not.toContain('actuate');
    expect(members).not.toContain('continueGame');
    expect(members).not.toContain('renderer');
    expect(members).not.toContain('render');
    expect(members).not.toContain('view');

    for (const key of Object.keys(engine)) {
      const held = (engine as unknown as Record<string, unknown>)[key];

      if (typeof held !== 'object' || held === null) {
        continue;
      }

      expect(held).not.toHaveProperty('actuate');
      expect(held).not.toHaveProperty('continueGame');
    }
  });
});

describe('setup() (js/game_manager.js L35-L59)', () => {
  it('resets the score and the three flags on a fresh board (L46-L55)', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(
      snapshotFromRows([[2, null], [null, null]], {
        score: 900,
        over: true,
        won: true,
        keepPlaying: true,
      }),
    );
    engine.setup(null);

    expect(engine.score).toBe(0);
    expect(engine.over).toBe(false);
    expect(engine.won).toBe(false);
    expect(engine.continuedPlay).toBe(false);
  });

  it('restores the grid, the score and the flags (L36-L45)', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(
      snapshotFromRows([
        [2, 4, null, null],
        [null, 8, null, null],
        [null, null, null, null],
        [null, null, null, 16],
      ], { score: 128, over: false, won: true, keepPlaying: true }),
    );

    expect(engine.score).toBe(128);
    expect(engine.over).toBe(false);
    expect(engine.won).toBe(true);
    expect(engine.continuedPlay).toBe(true);
    expect(valueAt(engine, 0, 0)).toBe(2);
    expect(valueAt(engine, 1, 0)).toBe(4);
    expect(valueAt(engine, 1, 1)).toBe(8);
    expect(valueAt(engine, 3, 3)).toBe(16);
    expect(tileCount(engine)).toBe(4);
  });

  it('rebuilds the grid at the SAVED size (L40-L41)', () => {
    const config = createDefaultRulesConfig();
    const engine = new Engine({ streams: streamsFor(), config });

    expect(config.boardSize).toBe(DEFAULT_BOARD_SIZE);

    engine.setup(createEmptyBoard(3));

    expect(engine.grid).toBeInstanceOf(Grid);
    expect(engine.grid.size).toBe(3);
    expect(engine.grid.cells).toHaveLength(3);
    expect(engine.grid.cells[0]).toHaveLength(3);
  });

  it('reconciles a saved size against the configured one', () => {
    // AAP section 0.4.1.3 names this the corruption risk.
    const config = createDefaultRulesConfig();
    const engine = new Engine({ streams: streamsFor(), config });

    engine.setup(
      snapshotFromRows([
        [2, null, null],
        [null, null, null],
        [null, null, 4],
      ]),
    );

    expect(config.boardSize).toBe(3);
    expect(engine.config.boardSize).toBe(3);
    expect(engine.grid.size).toBe(3);
    expect(valueAt(engine, 0, 0)).toBe(2);
    expect(valueAt(engine, 2, 2)).toBe(4);
    expect(tileCount(engine)).toBe(2);
  });

  it('keeps the configured size when no snapshot is restored', () => {
    const config = createDefaultRulesConfig();

    config.boardSize = 5;

    const engine = new Engine({ streams: streamsFor(), config });

    engine.setup(null);

    expect(engine.grid.size).toBe(5);
    expect(config.boardSize).toBe(5);
  });

  it('plays on after a reconciled size without corrupting the board', () => {
    const config = createDefaultRulesConfig();
    const engine = new Engine({ streams: streamsFor(), config });

    engine.setup(
      snapshotFromRows([
        [2, 2, null],
        [null, null, null],
        [null, null, null],
      ]),
    );

    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(valueAt(engine, 0, 0)).toBe(4);
    expect(engine.score).toBe(4);
    expect(engine.over).toBe(false);
    expect(engine.grid.size).toBe(3);
  });

  it('reads the port only when no snapshot is supplied (L36)', () => {
    const recording = createRecordingPort(null);
    const engine = new Engine({
      streams: streamsFor(),
      storage: recording.port,
    });

    engine.setup();

    expect(recording.calls).toContain('getGameState');

    recording.reset();
    engine.setup(null);

    expect(recording.calls).not.toContain('getGameState');

    recording.reset();
    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    expect(recording.calls).not.toContain('getGameState');
  });

  it('restores the snapshot the port reports (L36-L45)', () => {
    const recording = createRecordingPort(
      snapshotFromRows([
        [2, null, null, null],
        [null, null, null, null],
        [null, null, null, null],
        [null, null, null, null],
      ], { score: 64, won: true, keepPlaying: true }),
    );
    const engine = new Engine({
      streams: streamsFor(),
      storage: recording.port,
    });

    engine.setup();

    expect(engine.score).toBe(64);
    expect(engine.won).toBe(true);
    expect(engine.continuedPlay).toBe(true);
    expect(tileCount(engine)).toBe(1);
  });

  it('starts fresh from an unusable snapshot rather than throwing', () => {
    const engine = new Engine({ streams: streamsFor() });

    expect(() => {
      engine.setup({ nonsense: true } as unknown as SerializedGameState);
    }).not.toThrow();
    expect(engine.score).toBe(0);
    expect(tileCount(engine)).toBe(VANILLA_START_TILES);
  });

  it('commits once at the end, as L58 actuated', () => {
    const engine = new Engine({ streams: streamsFor() });
    const commits = captureCommits(engine);

    engine.setup(null);

    expect(commits).toHaveLength(1);
    expect(commits[0].score).toBe(0);
    expect(commits[0].over).toBe(false);
    expect(commits[0].won).toBe(false);
    expect(commits[0].terminated).toBe(false);
  });
});

describe('addStartTiles() (js/game_manager.js L62-L66)', () => {
  it('places config.startTiles tiles, defaulting to the 2 of L7', () => {
    const config = createDefaultRulesConfig();

    expect(config.startTiles).toBe(VANILLA_START_TILES);

    const engine = new Engine({ streams: streamsFor(), config });

    engine.setup(null);

    expect(tileCount(engine)).toBe(VANILLA_START_TILES);
  });

  it('places three tiles for a configuration asking for three', () => {
    const config = createDefaultRulesConfig();

    config.startTiles = 3;

    const engine = new Engine({ streams: streamsFor(), config });

    engine.setup(null);

    expect(tileCount(engine)).toBe(3);
  });

  it('places none for a configuration asking for none', () => {
    const config = createDefaultRulesConfig();

    config.startTiles = 0;

    const engine = new Engine({ streams: streamsFor(), config });

    engine.setup(null);

    expect(tileCount(engine)).toBe(0);
  });

  it('places none when a snapshot was restored (L53-L55)', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(EMPTY_BOARD));

    expect(tileCount(engine)).toBe(0);
  });
});

describe('addRandomTile() (js/game_manager.js L69-L76)', () => {
  it('draws values from config.spawn.values alone (L71)', () => {
    const config = createDefaultRulesConfig();

    config.startTiles = 8;

    const engine = new Engine({ streams: streamsFor(), config });

    engine.setup(null);

    const spawned = faceValues(engine);

    expect(spawned).toHaveLength(8);

    for (const value of spawned) {
      expect(VANILLA_SPAWN_VALUES).toContain(value);
    }
  });

  it('honours a replacement distribution (L71)', () => {
    const config = withFixedSpawn(8);

    config.startTiles = 5;

    const engine = new Engine({ streams: streamsFor(), config });

    engine.setup(null);

    expect(faceValues(engine)).toEqual([8, 8, 8, 8, 8]);
  });

  it('spawns identical values at identical cells for one seed', () => {
    const first = new Engine({ streams: streamsFor(RUN_SEED) });
    const second = new Engine({ streams: streamsFor(RUN_SEED) });

    first.setup(null);
    second.setup(null);

    expect(boardValues(second)).toEqual(boardValues(first));

    play(first, [DIRECTION_LEFT, DIRECTION_DOWN, DIRECTION_RIGHT]);
    play(second, [DIRECTION_LEFT, DIRECTION_DOWN, DIRECTION_RIGHT]);

    expect(boardValues(second)).toEqual(boardValues(first));
    expect(second.score).toBe(first.score);
  });

  it('spawns a different opening board for a different seed', () => {
    const first = new Engine({ streams: streamsFor(RUN_SEED) });
    const second = new Engine({ streams: streamsFor(OTHER_SEED) });

    first.setup(null);
    second.setup(null);

    expect(boardValues(second)).not.toEqual(boardValues(first));
  });

  it('never calls Math.random across a turn (L71, js/grid.js L41)', () => {
    // The two audited call sites are the only randomness the vanilla game
    // held, and both are substream draws now.
    const spy = vi.spyOn(Math, 'random');

    try {
      const engine = new Engine({ streams: streamsFor() });

      engine.setup(null);
      play(engine, [DIRECTION_LEFT, DIRECTION_UP, DIRECTION_RIGHT]);
      engine.serialize();
      engine.continuePlaying();
      engine.endStage(true);
      engine.restart();

      expect(spy).toHaveBeenCalledTimes(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('inserts no tile on a full board, does not throw, and emits the attempt ' +
    'with no position (L70)', () => {
    // js/grid.js L37-L43 returned no cell on a full board, which is the
    // boundary the guard at L70 kept the spawn away from.
    const config = createDefaultRulesConfig();

    config.boardSize = 2;
    config.startTiles = 6;

    const engine = new Engine({ streams: streamsFor(), config });
    const spawned: (Position | undefined)[] = [];

    engine.events.on('tile:spawn', (payload) => {
      spawned.push(payload.position);
    });

    expect(() => {
      engine.setup(null);
    }).not.toThrow();

    expect(tileCount(engine)).toBe(4);

    // AAP Contract 1: every attempt is emitted, and the two that found no cell
    // carry no position.
    expect(spawned).toHaveLength(6);
    expect(spawned.filter((cell) => cell !== undefined)).toHaveLength(4);
    expect(spawned.slice(4)).toEqual([undefined, undefined]);
  });

  it('takes no draw for a full-board attempt, so the sequence is unmoved ' +
    '(L70)', () => {
    const config = createDefaultRulesConfig();

    config.boardSize = 2;
    config.startTiles = 6;

    const streams = streamsFor();
    const engine = new Engine({ streams, config });

    engine.setup(null);

    const afterSix = streams.snapshotCursors();

    const reference = streamsFor();
    const referenceConfig = createDefaultRulesConfig();

    referenceConfig.boardSize = 2;
    referenceConfig.startTiles = 4;
    new Engine({ streams: reference, config: referenceConfig }).setup(null);

    expect(afterSix).toEqual(reference.snapshotCursors());
  });

  it('spawns nothing further once a move leaves the board full', () => {
    const config = withFixedSpawn(8);
    const engine = new Engine({ streams: streamsFor(), config });

    engine.setup(createLosingBoard());

    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(tileCount(engine)).toBe(4);
    expect(engine.over).toBe(true);
    expect(() => {
      engine.move(DIRECTION_RIGHT);
    }).not.toThrow();
    expect(tileCount(engine)).toBe(4);
  });
});

describe('move(): the terminal guard (js/game_manager.js L134)', () => {
  /**
   * Builds an engine standing on a win that has not been acknowledged, which
   * is the state L31 refused a move in.
   *
   * @returns The engine and its recording port.
   */
  function createTerminatedEngine(): {
    readonly engine: Engine;
    readonly recording: RecordingPort;
  } {
    const recording = createRecordingPort();
    const engine = new Engine({
      streams: streamsFor(),
      storage: recording.port,
    });

    engine.setup(copyBoard(NEAR_WIN_BOARD));
    engine.move(DIRECTION_LEFT);

    expect(engine.won).toBe(true);
    expect(engine.isGameTerminated()).toBe(true);

    return { engine, recording };
  }

  it('refuses the move and reports no change', () => {
    const { engine } = createTerminatedEngine();
    const before = boardValues(engine);
    const score = engine.score;

    expect(engine.move(DIRECTION_LEFT)).toBe(false);
    expect(boardValues(engine)).toEqual(before);
    expect(engine.score).toBe(score);
  });

  it('returns ahead of prepareTiles, so no tile is prepared (L143)', () => {
    const { engine } = createTerminatedEngine();
    const tile = engine.grid.cellContent({ x: 0, y: 0 });

    expect(tile).not.toBeNull();

    const marker: [Tile, Tile] = [
      new Tile({ x: 0, y: 0 }, 2),
      new Tile({ x: 1, y: 0 }, 2),
    ];

    // js/game_manager.js L113-L120 cleared `mergedFrom` and saved the position
    // on every tile; both markers survive a refused move.
    (tile as Tile).mergedFrom = marker;
    (tile as Tile).previousPosition = null;

    expect(engine.move(DIRECTION_LEFT)).toBe(false);
    expect((tile as Tile).mergedFrom).toBe(marker);
    expect((tile as Tile).previousPosition).toBeNull();
  });

  it('dispatches no hook and emits no event', () => {
    const { engine } = createTerminatedEngine();
    const hooks: string[] = [];
    const events: string[] = [];

    recordHooks(engine, hooks);
    recordEvents(engine, events);

    expect(engine.move(DIRECTION_LEFT)).toBe(false);
    expect(hooks).toEqual([]);
    expect(events).toEqual([]);
  });

  it('makes no persistence call', () => {
    const { engine, recording } = createTerminatedEngine();

    recording.reset();

    expect(engine.move(DIRECTION_LEFT)).toBe(false);
    expect(recording.calls).toEqual([]);
  });

  it('accepts moves again once the win is acknowledged (L30-L32)', () => {
    const { engine } = createTerminatedEngine();

    engine.continuePlaying();

    expect(engine.isGameTerminated()).toBe(false);
    expect(engine.move(DIRECTION_DOWN)).toBe(true);
  });

  it('refuses every move once the game is lost', () => {
    const engine = new Engine({
      streams: streamsFor(),
      config: withFixedSpawn(8),
    });

    engine.setup(createLosingBoard());
    engine.move(DIRECTION_LEFT);

    expect(engine.over).toBe(true);
    expect(engine.isGameTerminated()).toBe(true);

    const before = boardValues(engine);

    for (const direction of [
      DIRECTION_UP,
      DIRECTION_RIGHT,
      DIRECTION_DOWN,
      DIRECTION_LEFT,
    ]) {
      expect(engine.move(direction)).toBe(false);
    }

    expect(boardValues(engine)).toEqual(before);
  });
});

describe('move(): the moved? decision (js/game_manager.js L182-L190)', () => {
  it('spawns nothing and commits nothing when no position changed', () => {
    // BLOCKED_BOARD's tiles already sit in column 0, so L175's
    // `positionsEqual` check never reports a change and the whole `if (moved)`
    // block of L182-L190 is skipped.
    const recording = createRecordingPort();
    const engine = new Engine({
      streams: streamsFor(),
      storage: recording.port,
    });

    engine.setup(copyBoard(BLOCKED_BOARD));

    const before = boardValues(engine);
    const events: string[] = [];

    recordEvents(engine, events);
    recording.reset();

    expect(engine.move(DIRECTION_LEFT)).toBe(false);
    expect(boardValues(engine)).toEqual(before);
    expect(tileCount(engine)).toBe(4);
    expect(engine.score).toBe(0);
    expect(events).not.toContain('tile:spawn');
    expect(events).not.toContain('state:commit');
    expect(recording.calls).toEqual([]);
  });

  it('completes the turn through move:after carrying moved as false', () => {
    // The completion signal of the no-op branch.
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(BLOCKED_BOARD));

    const after: MoveAfterEvent[] = [];
    const events: string[] = [];

    recordEvents(engine, events);
    engine.events.on('move:after', (payload) => {
      after.push(payload);
    });

    expect(engine.move(DIRECTION_LEFT)).toBe(false);
    expect(events).toContain('move:after');
    expect(after).toHaveLength(1);
    expect(after[0].moved).toBe(false);
    expect(after[0].score).toBe(0);
    expect(after[0].over).toBe(false);
    expect(after[0].won).toBe(false);
    expect(after[0].terminated).toBe(false);
    expect(boardValuesOf(after[0].board)).toEqual(boardValues(engine));

    // The emission is beside L182-L190's skipped block, not inside it.
    expect(events).not.toContain('tile:spawn');
    expect(events).not.toContain('state:commit');
  });

  it('dispatches no hook for the turn that changed nothing', () => {
    // `onAfterMove` belongs to the branch that changed the board.
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(BLOCKED_BOARD));

    const dispatched: string[] = [];

    recordHooks(engine, dispatched);

    expect(engine.move(DIRECTION_LEFT)).toBe(false);
    expect(dispatched).toEqual(['onBeforeMove']);
  });

  it('closes an unmoved turn span on the real Performance-API tracer', () => {
    // The cross-module contract of finding M12, driven end to end: a real
    // `Engine`, a real `Tracer`, and no fabricated event anywhere.
    const logger = createLogger({ correlationId: TRACED_CORRELATION_ID });
    const registry = createMetricsRegistry({ logger });
    const tracer = createTracer({ logger, metrics: registry, marks: false });
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(BLOCKED_BOARD));

    const detach = attachEngineTracing(engine.events, tracer);

    expect(engine.move(DIRECTION_LEFT)).toBe(false);

    const turns = tracer
      .recent()
      .filter((record) => record.name === SPAN_NAMES.engineTurn);

    expect(turns).toHaveLength(1);
    expect(turns[0].attributes[SPAN_ATTRIBUTES.moved]).toBe(false);
    expect(turns[0].attributes[SPAN_ATTRIBUTES.outcome]).toBe(
      SPAN_OUTCOMES.unmoved,
    );

    const snapshot = tracer.snapshot();

    expect(snapshot.open).toBe(0);
    expect(snapshot.anomalies).toBe(0);
    expect(snapshot.faults).toBe(0);
    expect(
      registry.histogram(METRIC_NAMES.turnLatencyMilliseconds).count,
    ).toBe(0);

    detach();

    expect(tracer.snapshot().open).toBe(0);
  });

  it('spawns exactly one tile and commits once when a position changed', () => {
    // A right move on BLOCKED_BOARD slides every tile and merges none, so the
    // tile count rises by exactly the one tile L183 spawned.
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(BLOCKED_BOARD));

    const commits = captureCommits(engine);
    const spawns: number[] = [];

    engine.events.on('tile:spawn', (payload) => {
      spawns.push(payload.value);
    });

    expect(tileCount(engine)).toBe(4);
    expect(engine.move(DIRECTION_RIGHT)).toBe(true);
    expect(tileCount(engine)).toBe(5);
    expect(spawns).toHaveLength(1);
    expect(commits).toHaveLength(1);
  });

  it('nets no tile for a move that merged one pair', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    expect(tileCount(engine)).toBe(2);
    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(valueAt(engine, 0, 0)).toBe(4);
    expect(tileCount(engine)).toBe(2);
  });

  it('checks for a loss after the spawn and still commits (L185-L189)', () => {
    const recording = createRecordingPort();
    const engine = new Engine({
      streams: streamsFor(),
      config: withFixedSpawn(8),
      storage: recording.port,
    });

    engine.setup(createLosingBoard());

    const commits = captureCommits(engine);

    recording.reset();

    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(tileCount(engine)).toBe(4);
    expect(engine.over).toBe(true);
    expect(commits).toHaveLength(1);
    expect(commits[0].over).toBe(true);
    expect(commits[0].terminated).toBe(true);
    expect(recording.calls).toContain('clearGameState');
  });

  it('leaves the game unlost while a move remains available', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(NEAR_LOSS_BOARD));

    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(tileCount(engine)).toBe(16);
    expect(engine.over).toBe(false);
    expect(engine.score).toBe(8);
  });

  it('accumulates the score from the merges of the turn (L167)', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(
      snapshotFromRows([
        [2, 2, null, null],
        [4, 4, null, null],
        [null, null, null, null],
        [null, null, null, null],
      ]),
    );

    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(valueAt(engine, 0, 0)).toBe(4);
    expect(valueAt(engine, 0, 1)).toBe(8);
    expect(engine.score).toBe(12);
  });
});

describe('move(): the win check (js/game_manager.js L170)', () => {
  it('sets won when a merge reaches the configured 2048', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(NEAR_WIN_BOARD));

    expect(engine.won).toBe(false);
    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(engine.won).toBe(true);
    expect(engine.score).toBe(VANILLA_WIN_VALUE);
    expect(engine.isGameTerminated()).toBe(true);
  });

  it('honours a replacement win value', () => {
    const config = createDefaultRulesConfig();

    config.winValue = 512;

    const engine = new Engine({ streams: streamsFor(), config });

    engine.setup(createNearWinBoard(DEFAULT_BOARD_SIZE, 512));

    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(engine.won).toBe(true);
    expect(valueAt(engine, 0, 0)).toBe(512);
  });

  it('keeps the strict equality of L170 for a value past the target', () => {
    const config = createDefaultRulesConfig();

    config.winValue = 6;

    const engine = new Engine({ streams: streamsFor(), config });

    engine.setup(createNearWinBoard(DEFAULT_BOARD_SIZE, 8));

    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(valueAt(engine, 0, 0)).toBe(8);
    expect(engine.won).toBe(false);
    expect(engine.isGameTerminated()).toBe(false);
  });

  it('leaves won false while no merge reaches the target', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(engine.won).toBe(false);
  });
});

describe('the six hooks dispatch at their mapped points', () => {
  it('dispatches all six across a stage, a turn and a stage end', () => {
    const engine = new Engine({ streams: streamsFor() });
    const dispatched: string[] = [];

    recordHooks(engine, dispatched);
    engine.setup(copyBoard(MERGE_PAIR_BOARD));
    engine.move(DIRECTION_LEFT);
    engine.endStage(true);

    for (const hook of ALL_HOOK_ORDER) {
      expect(dispatched).toContain(hook);
    }
  });

  it('dispatches onStageStart once as the stage is prepared (L35-L59)', () => {
    const engine = new Engine({ streams: streamsFor() });
    const dispatched: string[] = [];

    recordHooks(engine, dispatched);
    engine.setup(null);

    expect(
      dispatched.filter((hook) => hook === 'onStageStart'),
    ).toHaveLength(1);
    expect(dispatched[0]).toBe('onStageStart');
  });

  it('dispatches onStageStart before the start tiles are spawned', () => {
    const config = createDefaultRulesConfig();

    config.startTiles = VANILLA_START_TILES;

    const engine = new Engine({ streams: streamsFor(), config });
    const dispatched: string[] = [];

    recordHooks(engine, dispatched);
    engine.setup(null);

    expect(dispatched).toEqual(['onStageStart', 'onSpawn', 'onSpawn']);
  });

  it('dispatches one turn in the order of AAP Figure 4', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    const dispatched: string[] = [];

    recordHooks(engine, dispatched);

    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(dispatched).toEqual([
      'onBeforeMove',
      'onMerge',
      'onSpawn',
      'onAfterMove',
    ]);
  });

  it('dispatches onBeforeMove before any board mutation', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    const seen: (number | null)[] = [];

    engine.hooks.register({
      id: 'board-reader',
      hooks: {
        onBeforeMove: () => {
          seen.push(valueAt(engine, 0, 0), valueAt(engine, 1, 0));
        },
      },
    });

    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(seen).toEqual([2, 2]);
    expect(valueAt(engine, 0, 0)).toBe(4);
  });

  it('dispatches onMerge once per merge, so twice for two merges', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(
      snapshotFromRows([
        [2, 2, null, null],
        [4, 4, null, null],
        [null, null, null, null],
        [null, null, null, null],
      ]),
    );

    const dispatched: string[] = [];

    recordHooks(engine, dispatched);

    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(dispatched.filter((hook) => hook === 'onMerge')).toHaveLength(2);
  });

  it('dispatches no onMerge for a move that merged nothing', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(BLOCKED_BOARD));

    const dispatched: string[] = [];

    recordHooks(engine, dispatched);

    expect(engine.move(DIRECTION_RIGHT)).toBe(true);
    expect(dispatched).toEqual(['onBeforeMove', 'onSpawn', 'onAfterMove']);
  });

  it('dispatches onSpawn after the move resolves, before onAfterMove', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(BLOCKED_BOARD));

    const dispatched: string[] = [];

    recordHooks(engine, dispatched);
    engine.move(DIRECTION_RIGHT);

    expect(dispatched.indexOf('onSpawn')).toBeGreaterThan(
      dispatched.indexOf('onBeforeMove'),
    );
    expect(dispatched.indexOf('onAfterMove')).toBeGreaterThan(
      dispatched.indexOf('onSpawn'),
    );
  });

  it('dispatches onStageEnd when the stage is resolved', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(null);

    const dispatched: string[] = [];

    recordHooks(engine, dispatched);
    engine.endStage(true);

    expect(dispatched).toEqual(['onStageEnd']);
  });

  it('completes the stage transition: end, advance, then start', () => {
    let stageIndex = 0;
    const engine = new Engine({
      streams: streamsFor(),
      stageContext: (): StageCommitContext =>
        Object.freeze({
          stageIndex,
          goal: stageGoalForIndex(stageIndex, DEFAULT_STAGE_CONFIG),
          goalProgress: 0,
        }),
    });

    engine.setup(null);

    const dispatched: string[] = [];
    const events: string[] = [];

    recordHooks(engine, dispatched);
    engine.events.on('stage:end', () => {
      events.push('stage:end');
    });
    engine.events.on('stage:start', () => {
      events.push('stage:start');
    });

    // The three steps of the transition: the engine resolves the stage that
    // finished, the observer authority advances the provider, and the engine
    // begins the stage that follows.
    engine.endStage(true);
    stageIndex = 1;
    engine.startStage();

    expect(dispatched).toEqual(['onStageEnd', 'onStageStart']);
    expect(events).toEqual(['stage:end', 'stage:start']);
    expect(engine.stageGoalInForce()).toEqual(
      stageGoalForIndex(1, DEFAULT_STAGE_CONFIG),
    );
  });

  it('starts the next stage on the board already in play', () => {
    let stageIndex = 0;
    const engine = new Engine({
      streams: streamsFor(),
      stageContext: (): StageCommitContext =>
        Object.freeze({
          stageIndex,
          goal: stageGoalForIndex(stageIndex, DEFAULT_STAGE_CONFIG),
          goalProgress: 0,
        }),
    });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    const board = boardValues(engine);
    const tiles = tileCount(engine);

    expect(engine.move(DIRECTION_LEFT)).toBe(true);

    const played = boardValues(engine);
    const score = engine.score;

    engine.endStage(true);
    stageIndex = 1;
    engine.startStage();

    // No rebuild and no start tiles: the board, the score and the tile count
    // are exactly what the stage before them left.
    expect(boardValues(engine)).toEqual(played);
    expect(engine.score).toBe(score);
    expect(boardValues(engine)).not.toEqual(board);
    expect(tileCount(engine)).toBeGreaterThanOrEqual(tiles);
  });

  it('reports the goal an onStageStart handler adopted as in force', () => {
    const engine = new Engine({ streams: streamsFor() });
    const adopted: StageGoal = Object.freeze({
      kind: 'score-threshold',
      target: 4242,
    });

    engine.hooks.register({
      id: 'goal-replacer',
      hooks: {
        onStageStart: (payload) => ({ ...payload, goal: adopted }),
      },
    });

    engine.setup(null);

    // The engine's own measurement and the goal it publishes are the same
    // object, so an observer adopting this cannot disagree with the engine.
    expect(engine.stageGoalInForce()).toEqual(adopted);
  });

  it('resolves the stage itself under the engine authority', () => {
    const engine = new Engine({
      streams: streamsFor(),
      stageResolution: 'engine',
    });

    engine.setup(createNearWinBoard(DEFAULT_BOARD_SIZE, 32));

    const dispatched: string[] = [];

    recordHooks(engine, dispatched);

    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(engine.stageProgress().cleared).toBe(true);
    expect(dispatched).toContain('onStageEnd');
    expect(dispatched.indexOf('onStageEnd')).toBeGreaterThan(
      dispatched.indexOf('onAfterMove'),
    );
  });

  it('leaves the stage to a subscriber under the observer authority', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(createNearWinBoard(DEFAULT_BOARD_SIZE, 32));

    const dispatched: string[] = [];

    recordHooks(engine, dispatched);

    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(engine.stageProgress().cleared).toBe(true);
    expect(dispatched).not.toContain('onStageEnd');
  });

  it('refuses to carry a board over while a win stands unresolved', () => {
    const engine = new Engine({ streams: streamsFor() });

    // The canonical win: `won` is set and play is blocked until the player
    // takes Keep Going or ends the run.
    engine.setup(createNearWinBoard(DEFAULT_BOARD_SIZE, 2048));

    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(engine.won).toBe(true);
    expect(engine.isGameTerminated()).toBe(true);

    const played = boardValues(engine);
    const events: string[] = [];

    recordEvents(engine, events);

    engine.startStage();

    // No stage started, no board rebuilt, and the win still stands: the
    // terminal decision outranks the stage transition. DL-ENGINE-11.
    expect(events).not.toContain('stage:start');
    expect(boardValues(engine)).toEqual(played);
    expect(engine.isGameTerminated()).toBe(true);
  });

  it('carries the board over once Keep Going has cleared the win', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(createNearWinBoard(DEFAULT_BOARD_SIZE, 2048));

    expect(engine.move(DIRECTION_LEFT)).toBe(true);

    engine.continuePlaying();

    const played = boardValues(engine);
    const events: string[] = [];

    recordEvents(engine, events);

    engine.startStage();

    expect(events).toContain('stage:start');
    expect(engine.isGameTerminated()).toBe(false);
    expect(engine.won).toBe(true);
    expect(boardValues(engine)).toEqual(played);
  });

  it('rebuilds on a supplied board even while a win stands', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(createNearWinBoard(DEFAULT_BOARD_SIZE, 2048));

    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(engine.isGameTerminated()).toBe(true);

    const events: string[] = [];

    recordEvents(engine, events);

    // The REBUILDING path installs a board of its own, so it is not guarded:
    // a restored snapshot carries its own terminal status.
    engine.startStage(copyBoard(MERGE_PAIR_BOARD));

    expect(events).toContain('stage:start');
    expect(engine.won).toBe(false);
  });

  it('honours an onBeforeMove veto, which is Figure 4\'s vetoed edge', () => {
    const recording = createRecordingPort();
    const engine = new Engine({
      streams: streamsFor(),
      storage: recording.port,
    });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    const before = boardValues(engine);
    const tile = engine.grid.cellContent({ x: 0, y: 0 }) as Tile;
    const marker: [Tile, Tile] = [
      new Tile({ x: 0, y: 0 }, 2),
      new Tile({ x: 1, y: 0 }, 2),
    ];

    tile.mergedFrom = marker;

    const dispatched: string[] = [];
    const events: string[] = [];

    recordHooks(engine, dispatched);
    recordEvents(engine, events);
    engine.hooks.register({
      id: 'veto',
      hooks: {
        onBeforeMove: (payload): BeforeMovePayload => ({
          ...payload,
          cancelled: true,
        }),
      },
    });
    recording.reset();

    expect(engine.move(DIRECTION_LEFT)).toBe(false);
    expect(boardValues(engine)).toEqual(before);
    expect(engine.score).toBe(0);
    expect(tile.mergedFrom).toBe(marker);
    expect(dispatched).toEqual(['onBeforeMove']);
    expect(events).not.toContain('tile:merge');
    expect(events).not.toContain('tile:spawn');
    expect(events).not.toContain('move:after');
    expect(events).not.toContain('state:commit');
    expect(recording.calls).toEqual([]);
  });

  it('reports a vetoed move to a subscriber through move:before', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    const cancelled: boolean[] = [];

    engine.events.on('move:before', (payload) => {
      cancelled.push(payload.cancelled);
    });
    engine.hooks.register({
      id: 'veto',
      hooks: {
        onBeforeMove: (payload): BeforeMovePayload => ({
          ...payload,
          cancelled: true,
        }),
      },
    });

    // The emission precedes the hook dispatch, so the subscriber sees the flag
    // as it stood before the veto was cast, and the move is still withdrawn.
    expect(engine.move(DIRECTION_LEFT)).toBe(false);
    expect(cancelled).toEqual([false]);
  });

  it('withdraws the move a move:before LISTENER vetoed (AAP Contract 1)',
    () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    const dispatched: boolean[] = [];

    engine.events.on('move:before', (payload) => {
      payload.cancelled = true;
    });
    engine.hooks.register({
      id: 'observes-the-veto',
      hooks: {
        onBeforeMove: (payload): void => {
          dispatched.push(payload.cancelled);
        },
      },
    });

    const before = engine.serialize();

    // `move:before` is cancellable, and the veto reaches the hook dispatch, so
    // an `onBeforeMove` handler sees a veto a listener already cast.
    expect(engine.move(DIRECTION_LEFT)).toBe(false);
    expect(dispatched).toEqual([true]);
    expect(engine.serialize()).toEqual(before);
  });
});

describe('the seven engine events (js/game_manager.js L91-L97)', () => {
  it('emits every event name across a stage, a turn and a stage end', () => {
    const engine = new Engine({ streams: streamsFor() });
    const emitted: string[] = [];

    recordEvents(engine, emitted);
    engine.setup(copyBoard(MERGE_PAIR_BOARD));
    engine.move(DIRECTION_LEFT);
    engine.endStage(true);

    for (const name of ENGINE_EVENT_NAMES) {
      expect(emitted).toContain(name);
    }
  });

  it('emits one turn in the order of AAP Figure 4', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    const emitted: string[] = [];

    recordEvents(engine, emitted);

    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(emitted).toEqual([
      'move:before',
      'tile:merge',
      'tile:spawn',
      'move:after',
      'state:commit',
    ]);
  });

  it('emits tile:merge once per merge with the produced value', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(
      snapshotFromRows([
        [2, 2, null, null],
        [4, 4, null, null],
        [null, null, null, null],
        [null, null, null, null],
      ]),
    );

    const results: number[] = [];
    const deltas: number[] = [];

    engine.events.on('tile:merge', (payload) => {
      results.push(payload.resultValue);
      deltas.push(payload.scoreDelta);

      expect(payload.source).not.toBeNull();
      expect(payload.target).not.toBeNull();
    });

    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(results).toEqual([4, 8]);
    expect(deltas).toEqual([4, 8]);
  });

  it('emits tile:spawn with the cell the tile was inserted into', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(BLOCKED_BOARD));

    const spawns: { x: number; y: number; value: number }[] = [];

    engine.events.on('tile:spawn', (payload) => {
      expect(payload.position).toBeDefined();
      spawns.push({
        x: payload.position?.x ?? -1,
        y: payload.position?.y ?? -1,
        value: payload.value,
      });
    });

    expect(engine.move(DIRECTION_RIGHT)).toBe(true);
    expect(spawns).toHaveLength(1);
    expect(valueAt(engine, spawns[0].x, spawns[0].y)).toBe(spawns[0].value);
  });

  it('emits move:after carrying what was applied', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    const after: {
      moved: boolean;
      score: number;
      over: boolean;
      won: boolean;
      terminated: boolean;
    }[] = [];

    engine.events.on('move:after', (payload) => {
      after.push({
        moved: payload.moved,
        score: payload.score,
        over: payload.over,
        won: payload.won,
        terminated: payload.terminated,
      });
    });

    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(after).toEqual([
      {
        moved: true,
        score: 4,
        over: false,
        won: false,
        terminated: false,
      },
    ]);
  });

  it('emits stage:start with the seed and the reconciled board size', () => {
    const engine = new Engine({ streams: streamsFor() });
    const starts: { seed: string; boardSize: number }[] = [];

    engine.events.on('stage:start', (payload) => {
      starts.push({ seed: payload.seed, boardSize: payload.boardSize });
    });

    engine.setup(createEmptyBoard(3));

    expect(starts).toEqual([{ seed: RUN_SEED, boardSize: 3 }]);
  });

  it('emits stage:end with the resolution it was given', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(null);

    const ends: { stageIndex: number; cleared: boolean; score: number }[] = [];

    engine.events.on('stage:end', (payload) => {
      ends.push({
        stageIndex: payload.stageIndex,
        cleared: payload.cleared,
        score: payload.score,
      });
    });
    engine.endStage(false);

    expect(ends).toEqual([{ stageIndex: 0, cleared: false, score: 0 }]);
  });

  it('carries the ten members of the commit payload', () => {
    // Successor to L91-L97's `actuate(grid, {score, over, won, bestScore,
    // terminated})`, extended with the stage and relic slices.
    const engine = new Engine({ streams: streamsFor() });
    const commits = captureCommits(engine);

    engine.setup(null);

    expect(commits).toHaveLength(1);
    expect(Object.keys(commits[0]).sort()).toEqual([
      'bestScore',
      'board',
      'degraded',
      'over',
      'relics',
      'score',
      'stage',
      'terminated',
      'turn',
      'won',
    ]);
  });

  it('fills the stage and relic slices with the neutral defaults', () => {
    // No provider is injected, so src/engine/types.ts's two frozen neutral
    // constants stand in and the engine reaches no src/run or src/relics
    // module to obtain them.
    const engine = new Engine({ streams: streamsFor() });
    const commits = captureCommits(engine);

    engine.setup(null);

    expect(commits).toHaveLength(1);
    expect(commits[0].stage.stageIndex).toBe(EMPTY_STAGE_CONTEXT.stageIndex);
    expect(commits[0].stage.goal).toEqual(EMPTY_STAGE_CONTEXT.goal);
    expect(commits[0].stage.goalProgress).toBe(
      EMPTY_STAGE_CONTEXT.goalProgress,
    );
    expect(commits[0].relics).toEqual(EMPTY_RELIC_CONTEXT);
  });

  it('commits a complete payload with no provider and no port', () => {
    const engine = new Engine({ streams: streamsFor() });
    const commits = captureCommits(engine);

    engine.setup(null);
    engine.move(DIRECTION_LEFT);
    engine.move(DIRECTION_UP);

    for (const commit of commits) {
      expect(commit.board.size).toBe(DEFAULT_BOARD_SIZE);
      expect(typeof commit.score).toBe('number');
      expect(commit.bestScore).toBe(0);
      expect(typeof commit.over).toBe('boolean');
      expect(typeof commit.won).toBe('boolean');
      expect(typeof commit.terminated).toBe('boolean');
      expect(commit.stage).toBeDefined();
      expect(commit.relics).toEqual([]);
    }
  });

  it('takes the stage and relic slices from injected providers', () => {
    let stageIndex = 0;
    const goal: StageGoal = { kind: 'highest-tile', target: 64 };
    const engine = new Engine({
      streams: streamsFor(),
      stageContext: () => ({ stageIndex, goal, goalProgress: 0.5 }),
      relicContext: () => [{ id: 'first' }, { id: 'second', charges: 1 }],
    });
    const commits = captureCommits(engine);

    engine.setup(copyBoard(MERGE_PAIR_BOARD));
    stageIndex = 3;
    engine.move(DIRECTION_LEFT);

    expect(commits).toHaveLength(2);
    expect(commits[0].stage.stageIndex).toBe(0);
    expect(commits[1].stage.stageIndex).toBe(3);
    expect(commits[1].stage.goal).toEqual(goal);
    expect(commits[1].relics).toEqual([
      { id: 'first' },
      { id: 'second', charges: 1 },
    ]);
  });

  it('commits the live lattice, as L91 handed it over', () => {
    // L91's by-reference hand-off, which js/html_actuator.js L16-L22 read
    // `grid.cells` straight out of: a subscriber receives the engine's own
    // board and treats it as read-only.
    const engine = new Engine({ streams: streamsFor() });
    const commits = captureCommits(engine);

    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    expect(commits).toHaveLength(1);
    expect(commits[0].board as unknown).toBe(engine.grid as unknown);
    expect(commits[0].board.cells as unknown).toBe(
      engine.grid.cells as unknown,
    );
    expect(Object.isFrozen(commits[0])).toBe(false);
    expect(Object.isFrozen(commits[0].board)).toBe(false);
  });

  it('carries the members js/html_actuator.js L16-L22 read', () => {
    const engine = new Engine({ streams: streamsFor() });
    const commits = captureCommits(engine);

    engine.setup(copyBoard(MERGE_PAIR_BOARD));
    engine.move(DIRECTION_LEFT);

    const board = commits[commits.length - 1].board;
    const merged = board.cells[0][0];

    expect(merged).not.toBeNull();
    expect(merged?.x).toBe(0);
    expect(merged?.y).toBe(0);
    expect(merged?.value).toBe(4);
    expect(merged?.previousPosition).not.toBeUndefined();
    expect(merged?.mergedFrom).not.toBeUndefined();
  });

  it('follows the live board a listener holds across a later move', () => {
    const engine = new Engine({ streams: streamsFor() });
    const commits = captureCommits(engine);

    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    const held = commits[0].board;
    const before = boardValues(engine);

    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(boardValues(engine)).not.toEqual(before);

    // The commit carried the board by reference, so the reference a subscriber
    // kept is the board the move mutated in place.
    expect(held).toBe(engine.grid);
    expect(held.cells[0][0]?.value).toBe(4);
    expect(held.cells[1][0]).toBeNull();
  });
});

describe('keepPlaying() (js/game_manager.js L24-L27)', () => {
  /**
   * Builds an engine standing on an unacknowledged win.
   *
   * @returns The engine.
   */
  function createWonEngine(): Engine {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(NEAR_WIN_BOARD));
    engine.move(DIRECTION_LEFT);

    expect(engine.won).toBe(true);

    return engine;
  }

  it('separates the method from the flag L25 assigned over it', () => {
    const engine = new Engine({ streams: streamsFor() });
    const members = engine as unknown as Record<string, unknown>;

    expect(typeof members.continuePlaying).toBe('function');
    expect(typeof members.continuedPlay).toBe('boolean');
    expect(engine.continuedPlay).toBe(false);
  });

  it('leaves no callable shadowing the flag after the method runs', () => {
    const engine = createWonEngine();

    engine.continuePlaying();

    const members = engine as unknown as Record<string, unknown>;

    expect(typeof members.continuedPlay).toBe('boolean');
    expect(members.continuedPlay).toBe(true);
    expect(typeof members.continuePlaying).toBe('function');
  });

  it('carries no member under the shadowed name at all', () => {
    const engine = new Engine({ streams: streamsFor() });

    expect('keepPlaying' in (engine as unknown as object)).toBe(false);
    expect(
      (engine as unknown as Record<string, unknown>).keepPlaying,
    ).toBeUndefined();
  });

  it('sets the flag and clears the terminal condition (L26)', () => {
    const engine = createWonEngine();

    expect(engine.isGameTerminated()).toBe(true);

    engine.continuePlaying();

    expect(engine.continuedPlay).toBe(true);
    expect(engine.won).toBe(true);
    expect(engine.isGameTerminated()).toBe(false);
  });

  it('commits once rather than calling a view, as L26 did', () => {
    const engine = createWonEngine();
    const commits = captureCommits(engine);

    engine.continuePlaying();

    expect(commits).toHaveLength(1);
    expect(commits[0].won).toBe(true);
    expect(commits[0].terminated).toBe(false);
  });

  it('declares the three frozen names L9-L11 subscribed, in that order', () => {
    expect(INPUT_EVENT_NAMES.slice(0, 3)).toEqual([
      'move',
      'restart',
      'keepPlaying',
    ]);
  });

  it('reaches the method through the REAL input manager bus', () => {
    const engine = new Engine({ streams: streamsFor() });
    const input = new InputManager();

    engine.setup(copyBoard(NEAR_WIN_BOARD));

    input.on('move', (direction) => {
      engine.move(direction);
    });
    input.on('restart', () => {
      engine.restart();
    });
    input.on('keepPlaying', () => {
      engine.continuePlaying();
    });

    // Emitted through the manager's own public entry points, so the name each
    // one dispatches under is the manager's choice and not this test's.
    expect(input.emitMove(DIRECTION_LEFT)).toBe(1);
    expect(engine.won).toBe(true);
    expect(engine.isGameTerminated()).toBe(true);

    input.keepPlaying();

    expect(engine.continuedPlay).toBe(true);
    expect(engine.isGameTerminated()).toBe(false);

    input.restart();

    expect(engine.won).toBe(false);
    expect(engine.continuedPlay).toBe(false);

    input.destroy();
  });

  it('is reached by no OTHER name the input layer emits', () => {
    // `continuePlaying` must be reachable from `keepPlaying` and from nothing
    // else, so a later input event cannot silently resume a won run.
    const engine = new Engine({ streams: streamsFor() });
    const input = new InputManager();

    engine.setup(copyBoard(NEAR_WIN_BOARD));
    input.on('keepPlaying', () => {
      engine.continuePlaying();
    });
    engine.move(DIRECTION_LEFT);

    expect(engine.isGameTerminated()).toBe(true);

    for (const name of INPUT_EVENT_NAMES) {
      if (name === 'keepPlaying') {
        continue;
      }

      // Every other name dispatches to zero subscribers here, so none of them
      // can reach the method.
      expect(
        input.emit(name, undefined as InputEventPayload[typeof name])
      ).toBe(0);
    }

    expect(engine.continuedPlay).toBe(false);
    expect(engine.isGameTerminated()).toBe(true);

    input.keepPlaying();

    expect(engine.continuedPlay).toBe(true);

    input.destroy();
  });
});

describe('isGameTerminated() (js/game_manager.js L30-L32)', () => {
  it('reports false on a fresh board', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(null);

    expect(engine.isGameTerminated()).toBe(false);
  });

  it('reports true once the game is lost', () => {
    const engine = new Engine({
      streams: streamsFor(),
      config: withFixedSpawn(8),
    });

    engine.setup(createLosingBoard());
    engine.move(DIRECTION_LEFT);

    expect(engine.over).toBe(true);
    expect(engine.isGameTerminated()).toBe(true);
  });

  it('reports true on a win that has not been acknowledged', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(
      snapshotFromRows([
        [2, null, null, null],
        [null, null, null, null],
        [null, null, null, null],
        [null, null, null, null],
      ], { won: true, keepPlaying: false }),
    );

    expect(engine.isGameTerminated()).toBe(true);
  });

  it('reports false on a win that has been acknowledged', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(
      snapshotFromRows([
        [2, null, null, null],
        [null, null, null, null],
        [null, null, null, null],
        [null, null, null, null],
      ], { won: true, keepPlaying: true }),
    );

    expect(engine.isGameTerminated()).toBe(false);
  });

  it('reports true on a loss even after the win was acknowledged', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(
      snapshotFromRows([
        [2, null, null, null],
        [null, null, null, null],
        [null, null, null, null],
        [null, null, null, null],
      ], { over: true, won: true, keepPlaying: true }),
    );

    expect(engine.isGameTerminated()).toBe(true);
  });
});

describe('serialize() (js/game_manager.js L102-L110)', () => {
  it('returns exactly the five members L103-L109 wrote', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    const snapshot = engine.serialize();

    expect(Object.keys(snapshot)).toEqual([
      'grid',
      'score',
      'over',
      'won',
      'keepPlaying',
    ]);
  });

  it('keeps the persisted member name of L108 spelled keepPlaying', () => {
    // The in-class flag is `continuedPlay`; the persisted name is frozen, so
    // src/run/run-state.ts can wrap this shape verbatim and a snapshot written
    // by the pre-migration game still loads.
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(NEAR_WIN_BOARD));
    engine.move(DIRECTION_LEFT);
    engine.continuePlaying();

    const snapshot = engine.serialize();

    expect(engine.continuedPlay).toBe(true);
    expect(snapshot.keepPlaying).toBe(true);
    expect(
      Object.prototype.hasOwnProperty.call(snapshot, 'keepPlaying'),
    ).toBe(true);
    expect(
      Object.prototype.hasOwnProperty.call(snapshot, 'continuedPlay'),
    ).toBe(false);
  });

  it('projects the grid in the shape js/grid.js L102-L117 wrote', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    const snapshot = engine.serialize();

    expect(Object.keys(snapshot.grid)).toEqual(['size', 'cells']);
    expect(snapshot.grid.size).toBe(DEFAULT_BOARD_SIZE);
    expect(snapshot.grid.cells).toHaveLength(DEFAULT_BOARD_SIZE);
    expect(snapshot.grid.cells[0][0]).toEqual({
      position: { x: 0, y: 0 },
      value: 2,
    });
    expect(snapshot.grid.cells[0][1]).toBeNull();
  });

  it('returns a fresh object on every call', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    const first = engine.serialize();
    const second = engine.serialize();

    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });

  it('round-trips its own output through setup()', () => {
    const source = new Engine({ streams: streamsFor() });

    source.setup(copyBoard(NEAR_LOSS_BOARD));
    source.move(DIRECTION_LEFT);

    const snapshot = source.serialize();
    const restored = new Engine({ streams: streamsFor() });

    restored.setup(snapshot);

    expect(boardValues(restored)).toEqual(boardValues(source));
    expect(restored.score).toBe(source.score);
    expect(restored.over).toBe(source.over);
    expect(restored.won).toBe(source.won);
    expect(restored.continuedPlay).toBe(source.continuedPlay);
  });

  it('loads a snapshot written under the pre-migration name', () => {
    const legacy: SerializedGameState = {
      grid: {
        size: 4,
        cells: [
          [{ position: { x: 0, y: 0 }, value: 1024 }, null, null, null],
          [null, null, null, null],
          [null, null, null, null],
          [null, null, null, null],
        ],
      },
      score: 20_140,
      over: false,
      won: true,
      keepPlaying: true,
    };
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(legacy);

    expect(engine.score).toBe(20_140);
    expect(engine.won).toBe(true);
    expect(engine.continuedPlay).toBe(true);
    expect(engine.isGameTerminated()).toBe(false);
    expect(valueAt(engine, 0, 0)).toBe(1024);
  });
});

describe('restart() (js/game_manager.js L17-L21)', () => {
  it('clears the persisted snapshot before setting up (L18, L20)', () => {
    const recording = createRecordingPort(
      snapshotFromRows([
        [1024, null, null, null],
        [null, null, null, null],
        [null, null, null, null],
        [null, null, null, null],
      ], { score: 4096, won: true, keepPlaying: true }),
    );
    const engine = new Engine({
      streams: streamsFor(),
      storage: recording.port,
    });

    engine.setup();

    expect(engine.score).toBe(4096);

    recording.reset();
    engine.restart();

    expect(recording.calls[0]).toBe('clearGameState');

    // `restart` passes `null` to `setup`, so the port is never read back.
    expect(recording.calls).not.toContain('getGameState');
    expect(engine.score).toBe(0);
  });

  it('restarts onto a fresh board even when the clear failed', () => {
    const snapshot = snapshotFromRows([
      [1024, null, null, null],
      [null, null, null, null],
      [null, null, null, null],
      [null, null, null, null],
    ], { score: 4096, won: true, keepPlaying: true });
    const engine = new Engine({
      streams: streamsFor(),
      storage: {
        getBestScore: (): 0 => 0,
        setBestScore: (): void => undefined,

        // The snapshot survives the clear, which is what a port that raises on
        // `clearGameState` leaves behind.
        getGameState: (): SerializedGameState => snapshot,
        clearGameState: (): void => {
          throw new Error('quota');
        },
        setGameState: (): void => undefined,
      },
    });

    engine.setup();

    expect(engine.score).toBe(4096);

    engine.restart();

    // Fresh board, fresh score, fresh flags — the surviving snapshot is not
    // read back.
    expect(engine.score).toBe(0);
    expect(engine.won).toBe(false);
    expect(tileCount(engine)).toBe(VANILLA_START_TILES);
  });

  it('resets to a fresh board, score and flags', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(NEAR_WIN_BOARD));
    engine.move(DIRECTION_LEFT);

    expect(engine.won).toBe(true);
    expect(engine.score).toBe(VANILLA_WIN_VALUE);

    engine.restart();

    expect(engine.score).toBe(0);
    expect(engine.over).toBe(false);
    expect(engine.won).toBe(false);
    expect(engine.continuedPlay).toBe(false);
    expect(tileCount(engine)).toBe(VANILLA_START_TILES);
  });

  it('clears the terminal condition rather than calling a view (L19)', () => {
    // js/game_manager.js L19 called `actuator.continueGame` to clear the win
    // and loss message; the commit setup ends with carries `terminated` as
    // false instead, which is what a view clears on.
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(NEAR_WIN_BOARD));
    engine.move(DIRECTION_LEFT);

    expect(engine.isGameTerminated()).toBe(true);

    const commits = captureCommits(engine);

    engine.restart();

    expect(engine.isGameTerminated()).toBe(false);
    expect(commits).toHaveLength(1);
    expect(commits[0].terminated).toBe(false);
    expect(commits[0].over).toBe(false);
    expect(commits[0].won).toBe(false);
    expect(commits[0].score).toBe(0);
  });

  it('restarts a lost game into a playable one', () => {
    const engine = new Engine({
      streams: streamsFor(),
      config: withFixedSpawn(8),
    });

    engine.setup(createLosingBoard());
    engine.move(DIRECTION_LEFT);

    expect(engine.over).toBe(true);

    engine.restart();

    expect(engine.over).toBe(false);
    expect(engine.grid.size).toBe(2);
    expect(tileCount(engine)).toBe(VANILLA_START_TILES);
  });

  it('restarts without a port that can clear anything', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));
    engine.move(DIRECTION_LEFT);

    expect(() => {
      engine.restart();
    }).not.toThrow();
    expect(engine.score).toBe(0);
  });
});

describe('actuate() -> commit() (js/game_manager.js L79-L99)', () => {
  it('promotes the score only when it beats the stored one (L80-L82)', () => {
    const recording = createRecordingPort(null, '3');
    const engine = new Engine({
      streams: streamsFor(),
      storage: recording.port,
    });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));
    recording.reset();

    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(engine.score).toBe(4);
    expect(recording.calls).toContain('setBestScore');
    expect(recording.best).toBe('4');
  });

  it('writes nothing when the stored score already leads', () => {
    const recording = createRecordingPort(null, '1024');
    const engine = new Engine({
      streams: streamsFor(),
      storage: recording.port,
    });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));
    recording.reset();

    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(recording.calls).not.toContain('setBestScore');
    expect(recording.best).toBe('1024');
  });

  it('compares the stored string relationally, without coercing it', () => {
    // js/local_storage_manager.js L43-L45 returned the raw stored string, and
    // L80 compared against it relationally.
    const stored = createRecordingPort(null, '1024');
    const numeric = createRecordingPort(null, 0);

    numeric.best = 1024 as unknown as string;

    const fromString = new Engine({
      streams: streamsFor(),
      storage: stored.port,
    });
    const fromNumber = new Engine({
      streams: streamsFor(),
      storage: numeric.port,
    });

    fromString.setup(copyBoard(MERGE_PAIR_BOARD));
    fromNumber.setup(copyBoard(MERGE_PAIR_BOARD));
    stored.reset();
    numeric.reset();
    fromString.move(DIRECTION_LEFT);
    fromNumber.move(DIRECTION_LEFT);

    expect(stored.calls.includes('setBestScore')).toBe(
      numeric.calls.includes('setBestScore'),
    );
    expect(stored.calls).not.toContain('setBestScore');
  });

  it('promotes past a stored string a numeric reading would also pass', () => {
    const recording = createRecordingPort(null, '2');
    const engine = new Engine({
      streams: streamsFor(),
      storage: recording.port,
    });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));
    recording.reset();
    engine.move(DIRECTION_LEFT);

    expect(recording.calls).toContain('setBestScore');
    expect(recording.best).toBe('4');
  });

  it('reads the absent best score as the number 0 (L43-L45)', () => {
    const recording = createRecordingPort(null, 0);
    const engine = new Engine({
      streams: streamsFor(),
      storage: recording.port,
    });
    const commits = captureCommits(engine);

    engine.setup(null);

    expect(recording.best).toBe(0);
    expect(commits[0].bestScore).toBe(0);
  });

  it('re-reads the best score after the possible write (L95)', () => {
    const recording = createRecordingPort(null, '3');
    const engine = new Engine({
      streams: streamsFor(),
      storage: recording.port,
    });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    const commits = captureCommits(engine);

    recording.reset();

    expect(engine.move(DIRECTION_LEFT)).toBe(true);

    const write = recording.calls.indexOf('setBestScore');
    const reads = recording.calls.reduce<number[]>((found, call, index) => {
      if (call === 'getBestScore') {
        found.push(index);
      }

      return found;
    }, []);

    expect(write).toBeGreaterThanOrEqual(0);
    expect(reads.some((index) => index < write)).toBe(true);
    expect(reads.some((index) => index > write)).toBe(true);
    expect(commits).toHaveLength(1);
    expect(commits[0].bestScore).toBe('4');
    expect(commits[0].bestScore).toBe(recording.best);
  });

  it('clears the persisted snapshot on a loss alone (L84-L89)', () => {
    const recording = createRecordingPort();
    const engine = new Engine({
      streams: streamsFor(),
      config: withFixedSpawn(8),
      storage: recording.port,
    });

    engine.setup(createLosingBoard());
    recording.reset();
    engine.move(DIRECTION_LEFT);

    expect(engine.over).toBe(true);
    expect(recording.calls).toContain('clearGameState');
    expect(recording.calls).not.toContain('setGameState');
  });

  it('saves the snapshot on a win, which L85 did not clear', () => {
    const recording = createRecordingPort();
    const engine = new Engine({
      streams: streamsFor(),
      storage: recording.port,
    });

    engine.setup(copyBoard(NEAR_WIN_BOARD));
    recording.reset();
    engine.move(DIRECTION_LEFT);

    expect(engine.won).toBe(true);
    expect(engine.over).toBe(false);
    expect(recording.calls).toContain('setGameState');
    expect(recording.calls).not.toContain('clearGameState');
    expect(recording.written).toHaveLength(1);
    expect(recording.written[0].won).toBe(true);
    expect(recording.written[0].keepPlaying).toBe(false);
  });

  it('saves the snapshot on an ordinary turn', () => {
    const recording = createRecordingPort();
    const engine = new Engine({
      streams: streamsFor(),
      storage: recording.port,
    });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));
    recording.reset();
    engine.move(DIRECTION_LEFT);

    expect(recording.written).toHaveLength(1);
    expect(recording.written[0].score).toBe(4);
    expect(recording.written[0].over).toBe(false);
    expect(recording.written[0].grid.size).toBe(DEFAULT_BOARD_SIZE);
  });

  // The storage port, not the terminal-state probe.
  it('completes the turn when every port call raises', () => {
    const failing: EngineStoragePort = {
      getBestScore: (): string | 0 => {
        throw new Error('quota');
      },
      setBestScore: (): unknown => {
        throw new Error('quota');
      },
      getGameState: (): unknown => {
        throw new Error('quota');
      },
      setGameState: (): unknown => {
        throw new Error('quota');
      },
      clearGameState: (): unknown => {
        throw new Error('quota');
      },
    };
    const recording = createRecordingReporter();
    const engine = new Engine({
      streams: streamsFor(),
      storage: failing,
      reporter: recording.reporter,
      correlationId: CORRELATION_ID_UNDER_TEST,
    });

    expect(() => {
      engine.setup();
    }).not.toThrow();

    // Every raise is ACCOUNTED, not merely survived. js/game_manager.js
    // L79-L99 made all five port calls bare, so a quota exhaustion left the
    // commit path by raising and nothing recorded that it had happened.
    const setupFailures = countOf(recording.counts, 'engine.storage.failed');

    // Setup reads the snapshot, then the commit reads the best score, promotes
    // it and writes the snapshot: four port calls, four raises, four counts.
    expect(setupFailures).toBe(4);

    for (const count of recording.counts) {
      expect(count.correlationId).toBe(CORRELATION_ID_UNDER_TEST);
      expect(count.value).toBe(1);
    }

    const commits = captureCommits(engine);

    recording.counts.length = 0;

    expect(engine.move(DIRECTION_LEFT)).toBe(true);

    const firstTurn = recording.counts.filter(
      (count) => count.metric === 'engine.storage.failed',
    );

    expect(firstTurn).toHaveLength(engine.score > 0 ? 4 : 3);

    recording.counts.length = 0;

    expect(() => {
      play(engine, [DIRECTION_UP]);
    }).not.toThrow();

    const secondTurn = recording.counts.filter(
      (count) => count.metric === 'engine.storage.failed',
    );

    expect(secondTurn.length).toBeGreaterThanOrEqual(3);
    expect(secondTurn.length).toBeLessThanOrEqual(4);

    for (const report of [...firstTurn, ...secondTurn]) {
      expect(report.metric).toBe('engine.storage.failed');
      expect(report.value).toBe(1);
      expect(report.correlationId).toBe(CORRELATION_ID_UNDER_TEST);

      // The counter is not hook-scoped and not event-scoped: it is raised
      // inside the port wrapper, outside any dispatch.
      expect(report.hook).toBeUndefined();
      expect(report.event).toBeUndefined();
    }

    // No OTHER counter reports the failure, so a consumer alerting on this one
    // name sees every port failure and nothing double-counts it.
    expect(
      engineMetricNamesOf(recording.counts).filter(
        (metric) =>
          metric !== 'engine.storage.failed' &&
          metric !== 'engine.move.resolved' &&
          metric !== 'engine.spawn.attempt',
      ),
    ).toEqual([]);

    for (const commit of commits) {
      expect(commit.bestScore).toBe(0);
    }

    expect(countOf(recording.counts, 'engine.move.resolved')).toBe(1);
  });

  it('raises the port counter for each of the five calls in turn', () => {
    const calls = [
      'getBestScore',
      'setBestScore',
      'getGameState',
      'setGameState',
      'clearGameState',
    ] as const;

    for (const hostile of calls) {
      const recording = createRecordingReporter();
      const port: EngineStoragePort = {
        getBestScore: (): string | 0 => 0,
        setBestScore: (): unknown => undefined,
        getGameState: (): unknown => null,
        setGameState: (): unknown => undefined,
        clearGameState: (): unknown => undefined,
        [hostile]: (): never => {
          throw new Error(`${hostile} raised`);
        },
      };
      const engine = new Engine({
        streams: streamsFor(),
        storage: port,
        reporter: recording.reporter,
        correlationId: CORRELATION_ID_UNDER_TEST,
      });

      expect(() => {
        // The board is supplied, so this setup consults no port; the second
        // one OMITS it, which is the call that reads `getGameState` — the read
        // js/game_manager.js L36 performed.
        engine.setup(copyBoard(NEAR_WIN_BOARD));
        engine.move(DIRECTION_LEFT);
        engine.restart();
        engine.setup();
      }).not.toThrow();

      const failures = countOf(recording.counts, 'engine.storage.failed');

      expect(failures).toBeGreaterThanOrEqual(1);

      for (const count of recording.counts) {
        expect(count.correlationId).toBe(CORRELATION_ID_UNDER_TEST);
      }
    }
  });
});

describe('vanilla parity from the five fixtures (gate V1)', () => {
  /**
   * Builds a set-up engine on one seed.
   *
   * @param board Snapshot to restore.
   * @param seed Run seed. Defaults to `RUN_SEED`.
   * @returns The engine, ready for its first move.
   */
  function engineOn(
    board: SerializedGameState,
    seed: string = RUN_SEED,
  ): Engine {
    const engine = new Engine({ streams: streamsFor(seed) });

    engine.setup(board);

    return engine;
  }

  it('leaves the empty board unchanged in every direction', () => {
    const engine = engineOn(copyBoard(EMPTY_BOARD));
    const commits = captureCommits(engine);

    expect(tileCount(engine)).toBe(0);
    expect(
      play(engine, [
        DIRECTION_UP,
        DIRECTION_RIGHT,
        DIRECTION_DOWN,
        DIRECTION_LEFT,
      ]),
    ).toEqual([false, false, false, false]);
    expect(tileCount(engine)).toBe(0);
    expect(engine.score).toBe(0);
    expect(engine.over).toBe(false);
    expect(engine.won).toBe(false);
    expect(commits).toEqual([]);
  });

  it('merges the merge-pair board once in each horizontal direction', () => {
    const left = engineOn(copyBoard(MERGE_PAIR_BOARD));

    expect(left.move(DIRECTION_LEFT)).toBe(true);
    expect(valueAt(left, 0, 0)).toBe(4);
    expect(left.score).toBe(4);
    expect(tileCount(left)).toBe(2);
    expect(left.over).toBe(false);
    expect(left.won).toBe(false);

    const right = engineOn(copyBoard(MERGE_PAIR_BOARD));

    expect(right.move(DIRECTION_RIGHT)).toBe(true);
    expect(valueAt(right, DEFAULT_BOARD_SIZE - 1, 0)).toBe(4);
    expect(right.score).toBe(4);
  });

  it('leaves the merge-pair board unchanged moving up', () => {
    const engine = engineOn(copyBoard(MERGE_PAIR_BOARD));

    expect(engine.move(DIRECTION_UP)).toBe(false);
    expect(engine.score).toBe(0);
    expect(tileCount(engine)).toBe(2);
  });

  it('slides the merge-pair board down without merging it', () => {
    const engine = engineOn(copyBoard(MERGE_PAIR_BOARD));
    const last = DEFAULT_BOARD_SIZE - 1;

    expect(engine.move(DIRECTION_DOWN)).toBe(true);
    expect(valueAt(engine, 0, last)).toBe(2);
    expect(valueAt(engine, 1, last)).toBe(2);
    expect(engine.score).toBe(0);
    expect(tileCount(engine)).toBe(3);
  });

  it('refuses the blocked board in three directions and moves in one', () => {
    for (const direction of [DIRECTION_LEFT, DIRECTION_UP, DIRECTION_DOWN]) {
      const engine = engineOn(copyBoard(BLOCKED_BOARD));

      expect(engine.move(direction)).toBe(false);
      expect(engine.score).toBe(0);
      expect(tileCount(engine)).toBe(4);
    }

    const engine = engineOn(copyBoard(BLOCKED_BOARD));
    const last = DEFAULT_BOARD_SIZE - 1;

    expect(engine.move(DIRECTION_RIGHT)).toBe(true);
    expect(engine.score).toBe(0);
    expect(tileCount(engine)).toBe(5);
    expect(valueAt(engine, last, 0)).toBe(2);
    expect(valueAt(engine, last, 1)).toBe(4);
    expect(valueAt(engine, last, 2)).toBe(8);
    expect(valueAt(engine, last, 3)).toBe(16);
  });

  it('wins on the near-win board and refuses to play on', () => {
    const engine = engineOn(copyBoard(NEAR_WIN_BOARD));

    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(valueAt(engine, 0, 0)).toBe(VANILLA_WIN_VALUE);
    expect(engine.score).toBe(VANILLA_WIN_VALUE);
    expect(engine.won).toBe(true);
    expect(engine.over).toBe(false);
    expect(engine.isGameTerminated()).toBe(true);
    expect(engine.move(DIRECTION_DOWN)).toBe(false);
  });

  it('merges the one pair of the near-loss board and stays playable', () => {
    const engine = engineOn(copyBoard(NEAR_LOSS_BOARD));
    const full = DEFAULT_BOARD_SIZE * DEFAULT_BOARD_SIZE;

    expect(tileCount(engine)).toBe(full);
    expect(engine.move(DIRECTION_UP)).toBe(false);
    expect(engine.move(DIRECTION_DOWN)).toBe(false);
    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(engine.score).toBe(8);
    expect(tileCount(engine)).toBe(full);
    expect(engine.over).toBe(false);
    expect(engine.won).toBe(false);
  });

  it('reaches the same state from one seed and one move list', () => {
    // The unit-level echo of gate V2. The seeded regression gate itself is
    // tests/snapshot, which holds the recorded sequences.
    const moves: readonly Direction[] = [
      DIRECTION_LEFT,
      DIRECTION_DOWN,
      DIRECTION_RIGHT,
      DIRECTION_UP,
      DIRECTION_LEFT,
      DIRECTION_DOWN,
      DIRECTION_RIGHT,
      DIRECTION_UP,
    ];
    const first = new Engine({ streams: streamsFor(RUN_SEED) });
    const second = new Engine({ streams: streamsFor(RUN_SEED) });

    first.setup(null);
    second.setup(null);

    expect(play(second, moves)).toEqual(play(first, moves));
    expect(boardValues(second)).toEqual(boardValues(first));
    expect(second.score).toBe(first.score);
    expect(second.over).toBe(first.over);
    expect(second.won).toBe(first.won);
    expect(second.continuedPlay).toBe(first.continuedPlay);
    expect(second.serialize()).toEqual(first.serialize());
  });

  it('reaches the same state from each fixture on one seed', () => {
    const moves: readonly Direction[] = [
      DIRECTION_LEFT,
      DIRECTION_UP,
      DIRECTION_RIGHT,
      DIRECTION_DOWN,
    ];
    const fixtures: readonly SerializedGameState[] = [
      EMPTY_BOARD,
      MERGE_PAIR_BOARD,
      BLOCKED_BOARD,
      NEAR_WIN_BOARD,
      NEAR_LOSS_BOARD,
    ];

    for (const fixture of fixtures) {
      const first = engineOn(copyBoard(fixture));
      const second = engineOn(copyBoard(fixture));

      expect(play(second, moves)).toEqual(play(first, moves));
      expect(second.serialize()).toEqual(first.serialize());
    }
  });

  it('advances the substream cursors identically for one seed', () => {
    const moves: readonly Direction[] = [
      DIRECTION_LEFT,
      DIRECTION_DOWN,
      DIRECTION_RIGHT,
    ];
    const first = new Engine({ streams: streamsFor(RUN_SEED) });
    const second = new Engine({ streams: streamsFor(RUN_SEED) });

    first.setup(null);
    second.setup(null);
    play(first, moves);
    play(second, moves);

    expect(second.streams.snapshotCursors()).toEqual(
      first.streams.snapshotCursors(),
    );
  });

  it('reaches a different state from a different seed', () => {
    const moves: readonly Direction[] = [
      DIRECTION_LEFT,
      DIRECTION_DOWN,
      DIRECTION_RIGHT,
      DIRECTION_UP,
    ];
    const first = new Engine({ streams: streamsFor(RUN_SEED) });
    const second = new Engine({ streams: streamsFor(OTHER_SEED) });

    first.setup(null);
    second.setup(null);
    play(first, moves);
    play(second, moves);

    expect(boardValues(second)).not.toEqual(boardValues(first));
  });

  it('plays a long run without throwing or corrupting the board', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(null);

    const cycle: readonly Direction[] = [
      DIRECTION_LEFT,
      DIRECTION_UP,
      DIRECTION_RIGHT,
      DIRECTION_DOWN,
    ];

    expect(() => {
      for (let turn = 0; turn < 200; turn += 1) {
        engine.move(cycle[turn % cycle.length]);
      }
    }).not.toThrow();

    const size = engine.grid.size;

    expect(size).toBe(DEFAULT_BOARD_SIZE);
    expect(engine.grid.cells).toHaveLength(size);

    engine.grid.eachCell((x, y, tile) => {
      if (tile === null) {
        return;
      }

      expect(tile.x).toBe(x);
      expect(tile.y).toBe(y);
      expect(tile.value).toBeGreaterThan(0);
    });

    expect(engine.score).toBeGreaterThan(0);
    expect(tileCount(engine)).toBeLessThanOrEqual(size * size);
  });
});

describe('attemptMove(): which of the four paths a move took', () => {
  it('reports a resolved move as moved and committed', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    const attempt = engine.attemptMove(DIRECTION_LEFT);

    expect(attempt).toEqual({
      moved: true,
      resolution: 'moved',
      committed: true,
      direction: DIRECTION_LEFT,
      resolvedDirection: DIRECTION_LEFT,
    });
  });

  it('reports a move refused by the terminal guard as blocked', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(NEAR_WIN_BOARD));
    engine.move(DIRECTION_LEFT);

    expect(engine.isGameTerminated()).toBe(true);

    const attempt = engine.attemptMove(DIRECTION_LEFT);

    // The path a boolean could not distinguish from an idle turn, although the
    // engine has counted the two separately all along.
    expect(attempt.resolution).toBe('blocked');
    expect(attempt.moved).toBe(false);
    expect(attempt.committed).toBe(false);
  });

  it('reports a move a listener withdrew as cancelled', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));
    engine.events.on('move:before', (payload) => {
      payload.cancelled = true;
    });

    const attempt = engine.attemptMove(DIRECTION_LEFT);

    expect(attempt.resolution).toBe('cancelled');
    expect(attempt.moved).toBe(false);
    expect(attempt.committed).toBe(false);
  });

  it('reports a move an onBeforeMove handler withdrew as cancelled', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));
    engine.hooks.register({
      id: 'vetoes',
      hooks: {
        onBeforeMove: (payload): BeforeMovePayload => ({
          ...payload,
          cancelled: true,
        }),
      },
    });

    const attempt = engine.attemptMove(DIRECTION_LEFT);

    // A veto a HANDLER cast is resolved after `move:before` was emitted, so no
    // listener sees it and the returned outcome is the only report of it.
    expect(attempt.resolution).toBe('cancelled');
    expect(attempt.committed).toBe(false);
  });

  it('reports the direction a handler redirected the move to', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));
    engine.hooks.register({
      id: 'redirects',
      hooks: {
        onBeforeMove: (payload): BeforeMovePayload => ({
          ...payload,
          direction: DIRECTION_RIGHT,
        }),
      },
    });

    const attempt = engine.attemptMove(DIRECTION_LEFT);

    expect(attempt.direction).toBe(DIRECTION_LEFT);
    expect(attempt.resolvedDirection).toBe(DIRECTION_RIGHT);
  });

  it('reports a move that changed nothing as idle', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup({
      grid: {
        size: DEFAULT_BOARD_SIZE,
        cells: [
          [{ position: { x: 0, y: 0 }, value: 2 }, null, null, null],
          [null, null, null, null],
          [null, null, null, null],
          [null, null, null, null],
        ],
      },
      score: 0,
      over: false,
      won: false,
      keepPlaying: false,
    });

    const attempt = engine.attemptMove(DIRECTION_LEFT);

    expect(attempt.resolution).toBe('idle');
    expect(attempt.moved).toBe(false);
    expect(attempt.committed).toBe(false);
  });

  it('is the outcome move() projects to a boolean', () => {
    const engine = new Engine({ streams: streamsFor() });
    const control = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));
    control.setup(copyBoard(MERGE_PAIR_BOARD));

    // `move` is `attemptMove.moved` and nothing else: the same board, the same
    // score and the same return value.
    expect(control.move(DIRECTION_LEFT)).toBe(
      engine.attemptMove(DIRECTION_LEFT).moved,
    );
    expect(engine.serialize()).toEqual(control.serialize());
  });

  it('freezes the outcome it reports', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    expect(Object.isFrozen(engine.attemptMove(DIRECTION_LEFT))).toBe(true);
  });
});

describe('the configured stage curve stands behind an onStageStart observer', () => {
  it('keeps the ladder goal in force when a void observer is registered', () => {
    const bare = new Engine({ streams: streamsFor() });

    bare.setup(null);

    const observed = new Engine({ streams: streamsFor() });

    // A PURE OBSERVER: it returns nothing, so it changes nothing.
    observed.hooks.register({
      id: 'observer',
      hooks: { onStageStart: (): void => undefined },
    });
    observed.setup(null);

    expect(bare.stageGoalInForce()).toEqual(
      stageGoalForIndex(0, DEFAULT_STAGE_CONFIG),
    );
    expect(observed.stageGoalInForce()).toEqual(bare.stageGoalInForce());
  });

  it('does not report a fresh board as clearing stage zero', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.hooks.register({
      id: 'observer',
      hooks: { onStageStart: (): void => undefined },
    });
    engine.setup(null);

    const progress = engine.stageProgress();

    // The zero-target goal the identity comparison left in force measured
    // every board as complete: progress 1 and cleared on the opening position.
    expect(progress.cleared).toBe(false);
    expect(progress.progress).toBeLessThan(1);
  });

  it('resolves no stage on the first move under the engine authority', () => {
    const engine = new Engine({
      streams: streamsFor(),
      stageResolution: 'engine',
    });
    const ended: boolean[] = [];

    engine.hooks.register({
      id: 'observer',
      hooks: { onStageStart: (): void => undefined },
    });
    engine.events.on('stage:end', (event): void => {
      ended.push(event.cleared);
    });
    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    engine.move(DIRECTION_LEFT);

    // A run composed without a stage-context provider — the composition
    // tests/unit/relics/relic-integration.test.ts documents — declared its
    // stage cleared on the first move it played.
    expect(ended).toEqual([]);
    expect(engine.hasStageEnded()).toBe(false);
  });

  it('still adopts a goal an onStageStart handler genuinely replaced', () => {
    const engine = new Engine({ streams: streamsFor() });
    const replaced: StageGoal = Object.freeze({
      kind: 'score-threshold',
      target: 7777,
    });

    engine.hooks.register({
      id: 'goal-replacer',
      hooks: {
        onStageStart: (payload) => ({ ...payload, goal: replaced }),
      },
    });
    engine.setup(null);

    // Recognising the sentinel by value must not cost the handler its
    // authority.
    expect(engine.stageGoalInForce()).toEqual(replaced);
  });

  it('keeps an injected provider goal ahead of the configured curve', () => {
    const supplied: StageGoal = Object.freeze({
      kind: 'highest-tile',
      target: 128,
    });

    const engine = new Engine({
      streams: streamsFor(),
      stageContext: (): StageCommitContext =>
        Object.freeze({ stageIndex: 3, goal: supplied, goalProgress: 0 }),
    });

    engine.hooks.register({
      id: 'observer',
      hooks: { onStageStart: (): void => undefined },
    });
    engine.setup(null);

    // The provider's own goal, not stage 3 of the ladder: the fallback is only
    // for a source that supplied none.
    expect(engine.stageGoalInForce()).toEqual(supplied);
  });

  it('falls back to the curve for a provider goal that is the neutral one', () => {
    const engine = new Engine({
      streams: streamsFor(),
      stageContext: (): StageCommitContext =>
        Object.freeze({
          stageIndex: 2,
          goal: { kind: 'score-threshold' as const, target: 0 },
          goalProgress: 0,
        }),
    });

    engine.setup(null);

    // A zero-target score threshold is met by every board, so it is read as
    // the sentinel it is identical to and the curve decides.
    expect(engine.stageGoalInForce()).toEqual(
      stageGoalForIndex(2, DEFAULT_STAGE_CONFIG),
    );
  });
});

/**
 * Every value outside the four directions a caller can reach the engine with.
 */
const OUT_OF_CONTRACT_DIRECTIONS: readonly { label: string; value: unknown }[] =
  Object.freeze([
    { label: 'one past the last direction', value: 4 },
    { label: 'a larger integer', value: 7 },
    { label: 'a negative integer', value: -1 },
    { label: 'a fraction', value: 1.5 },
    { label: 'NaN', value: Number.NaN },
    { label: 'Infinity', value: Number.POSITIVE_INFINITY },
    { label: '-Infinity', value: Number.NEGATIVE_INFINITY },
    { label: 'undefined', value: undefined },
    { label: 'null', value: null },
    { label: 'an object', value: {} },
    { label: 'an array', value: [] },
    { label: 'true', value: true },
    { label: 'false', value: false },
    { label: "the numeric string '0'", value: '0' },
    { label: "the numeric string '3'", value: '3' },
    { label: 'a word', value: 'left' },
    { label: 'a symbol', value: Symbol('up') },
    { label: 'a bigint', value: 1n },
  ]);

describe('attemptMove(): an out-of-contract direction', () => {
  it.each(OUT_OF_CONTRACT_DIRECTIONS)(
    'refuses $label without throwing and without opening a turn',
    ({ value }: { value: unknown }) => {
      const recording = createRecordingReporter();
      const streams = streamsFor();
      const engine = new Engine({
        streams,
        reporter: recording.reporter,
        correlationId: CORRELATION_ID_UNDER_TEST,
      });

      const events: string[] = [];
      const dispatched: string[] = [];

      engine.setup(copyBoard(MERGE_PAIR_BOARD));

      for (const name of ENGINE_EVENT_NAMES) {
        engine.events.on(name, (): void => {
          events.push(name);
        });
      }

      recordHooks(engine, dispatched);

      const board = engine.serialize();
      const cursors = streams.snapshotCursors();

      recording.counts.length = 0;

      const attempt = engine.attemptMove(value as Direction);

      // Refused, closed and uncommitted: the outcome is the whole of the turn.
      expect(attempt.moved).toBe(false);
      expect(attempt.resolution).toBe('blocked');
      expect(attempt.committed).toBe(false);

      // Nothing was announced and nothing was dispatched, so a subscriber that
      // opens work on `move:before` has nothing left open.
      expect(events).toEqual([]);
      expect(dispatched).toEqual([]);

      // And nothing moved: not the board, not the score, not one cursor.
      expect(engine.serialize()).toEqual(board);
      expect(streams.snapshotCursors()).toEqual(cursors);

      // Counted under its own name, which is what separates a caller defect
      // from the ordinary refusal of a finished game.
      expect(engineMetricNamesOf(recording.counts)).toEqual([
        'engine.move.refused',
      ]);
      expect(countOf(recording.counts, 'engine.move.refused')).toBe(1);
      expect(countOf(recording.counts, 'engine.move.blocked')).toBe(0);
    },
  );

  it.each(OUT_OF_CONTRACT_DIRECTIONS)(
    'reports false from move() for $label',
    ({ value }: { value: unknown }) => {
      const engine = new Engine({ streams: streamsFor() });

      engine.setup(copyBoard(MERGE_PAIR_BOARD));

      expect(engine.move(value as Direction)).toBe(false);
    },
  );

  it('echoes the direction it was given back rather than substituting one', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    const attempt = engine.attemptMove(9 as Direction);

    expect(attempt.direction).toBe(9);
    expect(attempt.resolvedDirection).toBe(9);
    expect(Object.isFrozen(attempt)).toBe(true);
  });

  it('refuses a numeric string rather than coercing it into a move', () => {
    const engine = new Engine({ streams: streamsFor() });
    const control = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));
    control.setup(copyBoard(MERGE_PAIR_BOARD));

    expect(engine.move('3' as unknown as Direction)).toBe(false);
    expect(engine.serialize()).toEqual(control.serialize());
    expect(engine.score).toBe(0);
  });

  it('refuses an out-of-contract direction on a terminated game too', () => {
    const recording = createRecordingReporter();
    const engine = new Engine({
      streams: streamsFor(),
      reporter: recording.reporter,
      correlationId: CORRELATION_ID_UNDER_TEST,
    });

    // Two half-value tiles: one move to the configured win value, which blocks
    // play pending an acknowledgement.
    engine.setup(createNearWinBoard(DEFAULT_BOARD_SIZE));
    engine.move(DIRECTION_LEFT);

    expect(engine.isGameTerminated()).toBe(true);

    recording.counts.length = 0;

    expect(engine.attemptMove(4 as Direction).resolution).toBe('blocked');
    expect(engineMetricNamesOf(recording.counts)).toEqual([
      'engine.move.refused',
    ]);
  });

  it('still resolves the four directions and a legitimate redirect', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    const straight = engine.attemptMove(DIRECTION_LEFT);

    expect(straight.resolution).toBe('moved');

    const redirected = new Engine({ streams: streamsFor() });

    redirected.hooks.register({
      id: 'redirect',
      hooks: {
        onBeforeMove: (payload: BeforeMovePayload): BeforeMovePayload => ({
          ...payload,
          direction: DIRECTION_UP,
        }),
      },
    });
    redirected.setup(copyBoard(MERGE_PAIR_BOARD));

    const viaHook = redirected.attemptMove(DIRECTION_LEFT);

    // The guard measures what the CALLER passed; a handler's redirect is
    // validated by the bus and still resolves the move it names.
    expect(viaHook.direction).toBe(DIRECTION_LEFT);
    expect(viaHook.resolvedDirection).toBe(DIRECTION_UP);
  });
});

describe('a report sink that throws (Engine.reporterFaults)', () => {
  /**
   * Builds a sink whose `onCount` throws `thrown` and which records nothing.
   *
   * @param thrown Value `onCount` throws. Defaults to an `Error`.
   * @returns The sink, for `EngineOptions.reporter`.
   */
  const throwingCountReporter = (
    thrown: unknown = new Error('onCount exploded'),
  ): EngineReporter =>
    Object.freeze({
      onCount(): void {
        throw thrown;
      },
    });

  it('does not escape setup(), move() or restart()', () => {
    const engine = new Engine({
      streams: streamsFor(),
      reporter: throwingCountReporter(),
    });

    expect(() => {
      engine.setup(null);
    }).not.toThrow();
    expect(() => {
      engine.move(DIRECTION_LEFT);
    }).not.toThrow();
    expect(() => {
      engine.restart();
    }).not.toThrow();
    expect(() => {
      engine.serialize();
    }).not.toThrow();
  });

  it('counts every contained throw and describes the last one', () => {
    const engine = new Engine({
      streams: streamsFor(),
      reporter: throwingCountReporter(),
    });

    expect(engine.reporterFaults).toBe(0);
    expect(engine.lastReporterFault).toBeUndefined();

    engine.setup(null);

    // `setup` raises the snapshot counter, so at least one report was
    // delivered and at least one throw was contained.
    expect(engine.reporterFaults).toBeGreaterThan(0);
    expect(engine.lastReporterFault).toBe('onCount exploded');

    const afterSetup = engine.reporterFaults;

    engine.move(DIRECTION_LEFT);

    expect(engine.reporterFaults).toBeGreaterThan(afterSetup);
  });

  it('describes a thrown value that carries no message', () => {
    const engine = new Engine({
      streams: streamsFor(),
      reporter: throwingCountReporter({ code: 'E_NO_MESSAGE' }),
    });

    engine.setup(null);

    expect(engine.lastReporterFault).toBe('unreadable thrown value');
  });

  it('describes a thrown string and a thrown number', () => {
    const thrownString = new Engine({
      streams: streamsFor(),
      reporter: throwingCountReporter('sink refused'),
    });
    const thrownNumber = new Engine({
      streams: streamsFor(),
      reporter: throwingCountReporter(7),
    });

    thrownString.setup(null);
    thrownNumber.setup(null);

    expect(thrownString.lastReporterFault).toBe('sink refused');
    expect(thrownNumber.lastReporterFault).toBe('7');
  });

  it('contains a value whose own message read raises', () => {
    const hostile = new Proxy(
      {},
      {
        get(): never {
          throw new Error('read trap');
        },
      },
    );
    const engine = new Engine({
      streams: streamsFor(),
      reporter: throwingCountReporter(hostile),
    });

    expect(() => {
      engine.setup(null);
    }).not.toThrow();
    expect(engine.lastReporterFault).toBe('unreadable thrown value');
  });

  it('plays the same game a sink that behaves plays', () => {
    // The game-domain result is the measure. One engine reports to a sink that
    // throws from every count, the other to a sink that records them; the two
    // play the same scripted moves on the same seed and must agree on the
    // board, the score and what they persist.
    const hostile = new Engine({
      streams: streamsFor(),
      reporter: throwingCountReporter(),
    });
    const recording = createRecordingReporter();
    const control = new Engine({
      streams: streamsFor(),
      reporter: recording.reporter,
    });

    hostile.setup(null);
    control.setup(null);

    const script: readonly Direction[] = [
      DIRECTION_LEFT,
      DIRECTION_UP,
      DIRECTION_RIGHT,
      DIRECTION_DOWN,
      DIRECTION_LEFT,
      DIRECTION_UP,
    ];

    for (const direction of script) {
      expect(hostile.move(direction)).toBe(control.move(direction));
    }

    expect(hostile.serialize()).toEqual(control.serialize());
    expect(hostile.score).toBe(control.score);
    expect(hostile.currentTurn()).toBe(control.currentTurn());

    // The ENGINE-OWNED counts the control sink took are the reports the
    // hostile sink threw out of.
    expect(hostile.reporterFaults).toBe(
      engineMetricNamesOf(recording.counts).length,
    );
    expect(hostile.reporterFaults).toBeLessThan(recording.counts.length);
  });

  it('emits every event a sink that behaves emits', () => {
    const seen: EngineEventName[] = [];
    const engine = new Engine({
      streams: streamsFor(),
      reporter: throwingCountReporter(),
    });

    for (const event of ENGINE_EVENT_NAMES) {
      engine.events.on(event, (): void => {
        seen.push(event);
      });
    }

    engine.setup(null);
    engine.move(DIRECTION_LEFT);

    expect(seen).toContain('state:commit');
    expect(seen).toContain('move:before');
  });

  it('keeps the frozen best-score contract under a throwing sink', () => {
    // AAP 0.8.3 V3: the port reports the raw string when a value is present,
    // the promotion comparison relies on the relational coercion of it, and
    // the committed value is the one re-read after the possible write.
    const recordingPort = createRecordingPort(null, '1000');
    const commits: (string | 0)[] = [];
    const engine = new Engine({
      streams: streamsFor(),
      storage: recordingPort.port,
      reporter: throwingCountReporter(),
    });

    engine.events.on('state:commit', (payload): void => {
      commits.push(payload.bestScore);
    });

    engine.setup(null);

    expect(typeof commits[0]).toBe('string');
    expect(commits[0]).toBe('1000');
    expect(recordingPort.best).toBe('1000');
    expect(engine.reporterFaults).toBeGreaterThan(0);
  });

  it('contains a throw from a port failure report', () => {
    // `throughPort` reports the failure from inside its own catch, so a sink
    // that throws there replaced a contained port failure with an escaping
    // report failure.
    const engine = new Engine({
      streams: streamsFor(),
      storage: {
        getBestScore(): string | 0 {
          return 0;
        },
        setBestScore(): unknown {
          return true;
        },
        getGameState(): unknown {
          throw new Error('port refused the read');
        },
      },
      reporter: throwingCountReporter(),
    });

    expect(() => {
      engine.setup();
    }).not.toThrow();
    expect(engine.reporterFaults).toBeGreaterThan(0);
  });

  it('leaves the fault count at zero for a sink that behaves', () => {
    const recording = createRecordingReporter();
    const engine = new Engine({
      streams: streamsFor(),
      reporter: recording.reporter,
    });

    engine.setup(null);
    engine.move(DIRECTION_LEFT);

    expect(recording.counts.length).toBeGreaterThan(0);
    expect(engine.reporterFaults).toBe(0);
    expect(engine.lastReporterFault).toBeUndefined();
  });

  it('reports nothing and counts nothing for a sink with no onCount', () => {
    const engine = new Engine({
      streams: streamsFor(),
      reporter: Object.freeze({}),
    });

    engine.setup(null);
    engine.move(DIRECTION_LEFT);

    expect(engine.reporterFaults).toBe(0);
  });
});
