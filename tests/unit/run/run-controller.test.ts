/**
 * The run lifecycle, composed.
 *
 * What is under test `RunController` of src/run/run-controller.ts, from two
 * directions.
 *
 * Sections 1 to 20 exercise the COMPOSITION of the run layer: a real `Engine`
 * against a real `RunStateStore` over an injected store.
 *
 * Decisions: DL-RUNCTL-01, DL-RUNCTL-02, DL-RUNCTL-03, DL-RUNCTL-04,
 * DL-STAGE-02, DL-TEST-01 (docs/DECISION_LOG.md).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import type { RulesConfig } from '../../../src/config/rules-config';
import {
  MAX_STAGE_INDEX,
  createDefaultStageConfig,
  evaluateStageGoal,
  isStageIndex,
  stageGoalForIndex,
  type StageConfig,
  type StageGoal,
} from '../../../src/config/stage-config';
import { Engine } from '../../../src/engine/engine';
import type {
  EngineEventListener,
  EngineEventName,
  EngineEventPayloadMap,
  EngineEventSubscription,
} from '../../../src/engine/engine-events';
import { Grid } from '../../../src/engine/grid';
import { createHookBus } from '../../../src/engine/hook-bus';
import { highestTileValue } from '../../../src/engine/terminal-state';
import {
  DIRECTION_DOWN,
  DIRECTION_LEFT,
  DIRECTION_RIGHT,
  DIRECTION_UP,
  type CorrelationId,
  type Direction,
  type SerializedGameState,
  type StageCommitContext,
} from '../../../src/engine/types';
import {
  MAX_RUN_SEED_LENGTH,
  RNG_STREAM_NAMES,
  createRngStreams,
  isAcceptableRunSeed,
  type RngCursorMap,
  type RngStreams,
} from '../../../src/rng/rng-streams';
import * as rngStreamsModule from '../../../src/rng/rng-streams';
import * as seededRngModule from '../../../src/rng/seeded-rng';
import {
  MAX_ENTERED_SEED_LENGTH,
  RunController,
  normalizeEnteredSeed,
  originateRunId,
  originateRunSeed,
  resolveRunIdentity,
  type EnginePort,
  type EngineEventSource,
  type MoveDirection,
  type RelicRegistryPort,
  type RewardOffer,
  type RewardResolution,
  type RewardSelection,
  type RunScope,
} from '../../../src/run/run-controller';
import { drawRelicOffers } from '../../../src/relics/relic-draw';
import {
  RELIC_CATALOGUE,
  RelicRegistry,
} from '../../../src/relics/relic-registry';
import type { Relic } from '../../../src/relics/relic-types';
import {
  MAX_PERSISTED_RELICS,
  NOOP_RUN_REPORTER,
  RUN_STATE_SCHEMA_VERSION,
  createFreshRunState,
  describeRunStateProblems,
  runCorrelationId,
  type PersistedRelic,
  type RunReporter,
  type RunState,
  type RunSummary,
} from '../../../src/run/run-state';
import {
  RunStateStore,
  type RunStateLoadOutcome,
} from '../../../src/run/run-state-store';
import { LocalStorageManager } from '../../../src/storage/local-storage-manager';
import { MemoryStorage } from '../../../src/storage/memory-storage';
import {
  BEST_SCORE_KEY,
  GAME_STATE_KEY,
  OWNED_STORAGE_KEYS,
  RUN_STATE_KEY,
  type OwnedStorageKey,
} from '../../../src/storage/storage-keys';
import {
  copyBoard,
  createEmptyBoard,
  createMergePairBoard,
  createNearWinBoard,
} from '../../fixtures/boards';

/* ==========================================================================
 * Harness
 * ========================================================================== */

/**
 * One `onRewardDrawn` report, as the recorder keeps it.
 *
 * Every declared member is captured VERBATIM, absences included: the point of
 * the reward-outcome suite is that a report says which relic, at which stage,
 * accepted or not, and refused by what — and the members were previously
 * omitted or mangled while the report still type-checked.
 */
interface RecordedRewardDraw {
  readonly stageIndex: number;
  readonly offeredRelicIds: readonly string[];
  readonly selectedRelicId: string | undefined;
  readonly accepted: boolean;
  readonly refusal: string | undefined;
}

/** Every report the controller and the store made, in order. */
interface RecordedReports {
  readonly started: { runId: string; stageIndex: number; resumed: boolean; seedProvided: boolean }[];
  readonly advanced: { fromStageIndex: number; toStageIndex: number; target: number }[];
  readonly ended: { outcome: string; stageIndex: number; score: number }[];
  readonly corrupted: string[];
  readonly reconciled: number[];

  /** Refused writes, one entry per `onWriteFailed` report, in order. */
  readonly writeFailures: { key: string; byteLength: number }[];

  /** Persistence transitions, one entry per report, in order. */
  readonly persistence: {
    status: string;
    previous: string;
    refusedWrites: number;
  }[];
  readonly offered: { stageIndex: number; offeredRelicIds: readonly string[] }[];
  readonly drawn: RecordedRewardDraw[];
}

function createRecorder(): { reports: RecordedReports; reporter: RunReporter } {
  const reports: RecordedReports = {
    started: [],
    advanced: [],
    ended: [],
    corrupted: [],
    reconciled: [],
    writeFailures: [],
    persistence: [],
    offered: [],
    drawn: [],
  };

  const reporter: RunReporter = {
    onRunStarted(report): void {
      reports.started.push({
        runId: report.runId,
        stageIndex: report.stageIndex,
        resumed: report.resumed,
        seedProvided: report.seedProvided,
      });
    },
    onStageAdvanced(report): void {
      reports.advanced.push({
        fromStageIndex: report.fromStageIndex,
        toStageIndex: report.toStageIndex,
        target: report.goal.target,
      });
    },
    onRunEnded(report): void {
      reports.ended.push({
        outcome: report.outcome,
        stageIndex: report.summary.stageIndex,
        score: report.summary.score,
      });
    },
    onLoadCorrupted(report): void {
      reports.corrupted.push(report.verdict);
    },
    onBoardSizeReconciled(report): void {
      reports.reconciled.push(report.appliedSize);
    },
    onWriteFailed(report): void {
      reports.writeFailures.push({
        key: report.key,
        byteLength: report.byteLength,
      });
    },
    onPersistenceStatusChanged(report): void {
      reports.persistence.push({
        status: report.status,
        previous: report.previous,
        refusedWrites: report.refusedWrites,
      });
    },
    onRewardOffered(report): void {
      reports.offered.push({
        stageIndex: report.stageIndex,
        offeredRelicIds: [...report.offeredRelicIds],
      });
    },
    onRewardDrawn(report): void {
      reports.drawn.push({
        stageIndex: report.stageIndex,
        offeredRelicIds: [...report.offeredRelicIds],
        selectedRelicId: report.selectedRelicId,
        accepted: report.accepted,
        refusal: report.refusal,
      });
    },
  };

  return { reports, reporter };
}

/** One composed run, wired exactly as src/main.ts wires it. */
interface Composed {
  readonly backing: MemoryStorage;
  readonly manager: LocalStorageManager;
  readonly config: RulesConfig;
  readonly stages: StageConfig;
  readonly controller: RunController;
  readonly engine: Engine;
  readonly reports: RecordedReports;
  readonly tokens: string[];
  readonly stop: () => void;
}

interface ComposeOptions {
  readonly backing?: MemoryStorage;

  /**
   * Seed a FRESH run is opened on. It reaches `resolveRunIdentity` only where
   * the backing store carries no envelope to resume, which is how src/main.ts
   * composes: the root supplies no seed at all, so a reload resolves its
   * identity — seed included — out of the store. A helper that supplied the
   * seed on the reload as well drove the one path a caller-entered seed must
   * NOT take, which is a fresh deterministic replay rather than a resumption.
   */
  readonly seed?: string;

  /**
   * A seed a CALLER TYPED, handed to `resolveRunIdentity` whatever the store
   * holds. It is the run-start screen's seed field expressed through this
   * harness, and it is the input a stored envelope must NOT be adopted for: a
   * typed seed asks for a fresh deterministic replay of that seed.
   */
  readonly enteredSeed?: string;
  readonly tokens?: readonly string[];
  readonly setup?: boolean;
}

/**
 * The seed to hand `resolveRunIdentity`: the caller's, and `undefined` where an
 * envelope is already stored, so the identity is read out of the store exactly
 * as the composition root reads it.
 *
 * @param manager Storage the envelope would be read from.
 * @param seed Seed the caller asked for.
 * @returns The seed to supply, or `undefined`.
 */
function identitySeed(
  manager: LocalStorageManager,
  seed: string | undefined,
): string | undefined {
  if (seed === undefined) {
    return undefined;
  }

  return manager.readJson(RUN_STATE_KEY) === null ? seed : undefined;
}

/**
 * Composes storage, identity, store, controller, substreams and engine in the
 * root's order, and attaches the controller to the engine.
 */
function compose(options: ComposeOptions = {}): Composed {
  const backing = options.backing ?? new MemoryStorage();
  const manager = new LocalStorageManager({ storage: backing });
  const config = createDefaultRulesConfig();
  const stages = createDefaultStageConfig();
  const { reports, reporter } = createRecorder();

  const issued: string[] = [];
  let next = 0;
  const createToken = (): string => {
    const supplied = options.tokens?.[next];
    const token = supplied ?? `token-${String(next)}`;

    next += 1;
    issued.push(token);

    return token;
  };

  const identity = resolveRunIdentity({
    storage: manager,
    createToken,
    seed: options.enteredSeed ?? identitySeed(manager, options.seed),
  });

  const controller = new RunController({
    store: new RunStateStore({ storage: manager, config, reporter }),
    identity,
    config,
    stages,
    createToken,
    reporter,
  });

  controller.begin();

  const streams = createRngStreams(controller.seed(), controller.cursors());

  const engine = new Engine({
    config,
    streams,
    storage: manager,
    stageContext: () => controller.stageContext(),
    relicContext: () => controller.relicContext(),
  });

  const stop = controller.observe(engine, () => streams.snapshotCursors());

  if (options.setup !== false) {
    engine.setup();
  }

  return {
    backing,
    manager,
    config,
    stages,
    controller,
    engine,
    reports,
    tokens: issued,
    stop,
  };
}

/**
 * One stored value, with `MemoryStorage`'s absent form normalised to `null`.
 */
function read(backing: MemoryStorage, key: string): string | null {
  return backing.getItem(key) ?? null;
}

/** The envelope as it is actually stored, or `null` when none is. */
function readStored(backing: MemoryStorage): RunState | null {
  const raw = read(backing, RUN_STATE_KEY);

  return raw === null ? null : (JSON.parse(raw) as RunState);
}

/** A fixed move sequence, so two runs of one seed play identically. */
const MOVES: readonly Direction[] = [
  DIRECTION_UP,
  DIRECTION_LEFT,
  DIRECTION_DOWN,
  DIRECTION_RIGHT,
  DIRECTION_UP,
  DIRECTION_LEFT,
];

function play(engine: Engine, moves: readonly Direction[]): void {
  for (const direction of moves) {
    engine.move(direction);
  }
}

/** An empty board snapshot, for engine doubles that only need a shape. */
function emptySnapshot(): SerializedGameState {
  return boardWith(0);
}

/** A board snapshot holding one tile of `value`, for goal-driven cases. */
function boardWith(value: number, size = 4): SerializedGameState {
  const cells: ({ position: { x: number; y: number }; value: number } | null)[][] = [];

  for (let x = 0; x < size; x += 1) {
    const column: ({ position: { x: number; y: number }; value: number } | null)[] = [];

    for (let y = 0; y < size; y += 1) {
      column.push(x === 0 && y === 0 ? { position: { x: 0, y: 0 }, value } : null);
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

describe('resolveRunIdentity', () => {
  it('originates a seed and a run identifier when nothing is stored', () => {
    const manager = new LocalStorageManager({ storage: new MemoryStorage() });
    const issued = ['seed-token', 'run-token'];
    let next = 0;

    const identity = resolveRunIdentity({
      storage: manager,
      createToken: (): string => {
        const token = issued[next] ?? 'exhausted';

        next += 1;

        return token;
      },
    });

    expect(identity).toEqual({
      seed: 'seed-token',
      runId: 'run-token',
      resumed: false,
      seedProvided: false,
    });
  });

  it('adopts the stored seed and run identifier, so a reload continues the run', () => {
    const backing = new MemoryStorage();
    const stored = createFreshRunState({
      runId: 'stored-run',
      seed: 'stored-seed',
      rngCursor: { 'spawn-value': 5 },
      stageIndex: 2,
      stageGoal: { kind: 'highest-tile', target: 64 },
      board: boardWith(8),
    });

    backing.setItem(RUN_STATE_KEY, JSON.stringify(stored));

    const identity = resolveRunIdentity({
      storage: new LocalStorageManager({ storage: backing }),
      createToken: (): string => 'must-not-be-used',
    });

    expect(identity).toEqual({
      seed: 'stored-seed',
      runId: 'stored-run',
      resumed: true,
      seedProvided: false,
    });
  });

  it.each([
    ['a value that is not an object', '"not an envelope"'],
    ['a truncated payload', '{"schemaVersion":1,"runId":"a"'],
    ['an unknown schema version', '{"schemaVersion":9999,"runId":"a","seed":"b"}'],
    ['an envelope with no seed', '{"schemaVersion":1,"runId":"a"}'],
  ])('originates an identity rather than throwing for %s', (_label, raw) => {
    const backing = new MemoryStorage();

    backing.setItem(RUN_STATE_KEY, raw);

    const identity = resolveRunIdentity({
      storage: new LocalStorageManager({ storage: backing }),
      createToken: (): string => 'fresh',
    });

    expect(identity.resumed).toBe(false);
    expect(identity.seed).toBe('fresh');
  });

  it('survives a port that throws on every read', () => {
    const identity = resolveRunIdentity({
      storage: {
        readJson(): unknown {
          throw new Error('storage is hostile');
        },
      },
      createToken: (): string => 'fresh',
    });

    expect(identity).toEqual({
      seed: 'fresh',
      runId: 'fresh',
      resumed: false,
      seedProvided: false,
    });
  });

  it('adopts a caller-supplied seed and does not read the stored one', () => {
    const backing = new MemoryStorage();

    backing.setItem(
      RUN_STATE_KEY,
      JSON.stringify(
        createFreshRunState({
          runId: 'stored-run',
          seed: 'stored-seed',
          rngCursor: {},
          stageIndex: 0,
          stageGoal: { kind: 'highest-tile', target: 16 },
          board: boardWith(2),
        }),
      ),
    );

    const identity = resolveRunIdentity({
      storage: new LocalStorageManager({ storage: backing }),
      createToken: (): string => 'minted-run',
      seed: 'player-typed-this',
    });

    // A seed the player chose starts a fresh run: it cannot continue a run
    // that was played under a different sequence.
    expect(identity.seed).toBe('player-typed-this');
    expect(identity.runId).toBe('minted-run');
    expect(identity.resumed).toBe(false);
    expect(identity.seedProvided).toBe(true);
  });

  it.each([
    ['an empty string', ''],
    ['a seed longer than the substreams accept', 'x'.repeat(100_000)],
  ])('falls through to the stored identity when the supplied seed is %s', (_label, seed) => {
    const backing = new MemoryStorage();

    backing.setItem(
      RUN_STATE_KEY,
      JSON.stringify(
        createFreshRunState({
          runId: 'stored-run',
          seed: 'stored-seed',
          rngCursor: {},
          stageIndex: 0,
          stageGoal: { kind: 'highest-tile', target: 16 },
          board: boardWith(2),
        }),
      ),
    );

    const identity = resolveRunIdentity({
      storage: new LocalStorageManager({ storage: backing }),
      createToken: (): string => 'minted',
      seed,
    });

    expect(identity.seed).toBe('stored-seed');
    expect(identity.resumed).toBe(true);
  });
});

describe('RunController.begin', () => {
  it('assembles a fresh envelope at stage 0 when nothing is stored', () => {
    const { controller, stages } = compose({ setup: false });
    const state = controller.state();

    expect(state.schemaVersion).toBe(RUN_STATE_SCHEMA_VERSION);
    expect(state.stageIndex).toBe(0);
    expect(state.stageGoal).toEqual(stages.ladder[0]);
    expect(state.goalProgress).toBe(0);
    expect(state.relics).toEqual([]);
    expect(controller.cursors()).toEqual({
      'spawn-value': 0,
      'spawn-position': 0,
      'relic-draw': 0,
      'rarity-weight': 0,
    });
  });

  it('restores the stage, the relics and the cursors of a stored run', () => {
    const backing = new MemoryStorage();
    const relics: PersistedRelic[] = [
      { id: 'first-picked', charges: 3 },
      { id: 'second-picked' },
    ];

    backing.setItem(
      RUN_STATE_KEY,
      JSON.stringify({
        ...createFreshRunState({
          runId: 'stored-run',
          seed: 'stored-seed',
          rngCursor: { 'spawn-value': 11, 'spawn-position': 7 },
          stageIndex: 3,
          stageGoal: { kind: 'score-threshold', target: 900 },
          board: boardWith(32),
        }),
        goalProgress: 0.5,
        relics,
      }),
    );

    const { controller } = compose({ backing, setup: false });

    expect(controller.runId()).toBe('stored-run');
    expect(controller.seed()).toBe('stored-seed');
    expect(controller.cursors()['spawn-value']).toBe(11);
    expect(controller.cursors()['spawn-position']).toBe(7);
    expect(controller.stageContext()).toEqual({
      stageIndex: 3,
      goal: { kind: 'score-threshold', target: 900 },
      goalProgress: 0.5,
    });
    expect(controller.relicContext()).toEqual([
      { id: 'first-picked', charges: 3 },
      { id: 'second-picked' },
    ]);
  });

  it('refuses a stored run whose seed is not the seed being played', () => {
    const backing = new MemoryStorage();

    backing.setItem(
      RUN_STATE_KEY,
      JSON.stringify({
        ...createFreshRunState({
          runId: 'other-run',
          seed: 'a-different-seed',
          rngCursor: { 'spawn-value': 40 },
          stageIndex: 6,
          stageGoal: { kind: 'highest-tile', target: 1024 },
          board: boardWith(512),
        }),
        relics: [{ id: 'not-mine' }],
      }),
    );

    const { controller } = compose({
      backing,
      enteredSeed: 'the-seed-i-typed',
      setup: false,
    });

    expect(controller.seed()).toBe('the-seed-i-typed');
    expect(controller.state().stageIndex).toBe(0);
    expect(controller.relicContext()).toEqual([]);
    expect(controller.cursors()['spawn-value']).toBe(0);
  });

  it('replays a typed seed from the start even where the stored run is ' +
    'playing that very seed', () => {
    // The adoption decision used to be the seed alone, so typing the seed of
    // the run in progress RESUMED it — mid-stage, with its relics and its
    // advanced cursors — and the replay a typed seed asks for was unreachable.
    const backing = new MemoryStorage();
    const typed = 'the-seed-i-typed';

    backing.setItem(
      RUN_STATE_KEY,
      JSON.stringify({
        ...createFreshRunState({
          runId: 'run-in-progress',
          seed: typed,
          rngCursor: { 'spawn-value': 40, 'spawn-position': 40 },
          stageIndex: 6,
          stageGoal: { kind: 'highest-tile', target: 1024 },
          board: boardWith(512),
        }),
        relics: [{ id: 'held-already' }],
      }),
    );

    const { controller, reports } = compose({
      backing,
      enteredSeed: typed,
      setup: false,
    });

    // The seed is the one that was typed, and everything else starts over.
    expect(controller.seed()).toBe(typed);
    expect(controller.runId()).not.toBe('run-in-progress');
    expect(controller.state().stageIndex).toBe(0);
    expect(
      controller.state().board.grid.cells.flat().filter((cell) => cell !== null),
    ).toEqual([]);
    expect(controller.relicContext()).toEqual([]);
    expect(controller.cursors()['spawn-value']).toBe(0);
    expect(controller.cursors()['spawn-position']).toBe(0);

    // No run-level board was adopted, so the engine inserts its start tiles.
    expect(controller.openingBoard()).toBeNull();
    expect(controller.board()).toBeUndefined();

    // And it is reported as a fresh run played on a supplied seed, not as a
    // resumption.
    expect(reports.started).toEqual([
      {
        runId: controller.runId(),
        stageIndex: 0,
        resumed: false,
        seedProvided: true,
      },
    ]);
  });

  it('reports the run start, distinguishing a resumed run from a fresh one', () => {
    const fresh = compose({ setup: false });

    expect(fresh.reports.started).toEqual([
      {
        runId: fresh.controller.runId(),
        stageIndex: 0,
        resumed: false,
        seedProvided: false,
      },
    ]);

    fresh.engine.setup();
    fresh.stop();

    const resumed = compose({ backing: fresh.backing, setup: false });

    expect(resumed.reports.started[0]?.resumed).toBe(true);
    expect(resumed.reports.started[0]?.runId).toBe(fresh.controller.runId());
  });

  it('reports a refused payload through the injected sink', () => {
    const backing = new MemoryStorage();

    backing.setItem(RUN_STATE_KEY, '{"schemaVersion":1,"runId":"a","seed":42}');

    const { reports, controller } = compose({ backing, setup: false });

    expect(reports.corrupted.length).toBeGreaterThan(0);
    expect(controller.state().stageIndex).toBe(0);
  });
});

describe('the stage and relic slices of a commit', () => {
  it('replaces the neutral contexts the engine defaulted to', () => {
    const backing = new MemoryStorage();

    backing.setItem(
      RUN_STATE_KEY,
      JSON.stringify({
        ...createFreshRunState({
          runId: 'stored-run',
          seed: 'stored-seed',
          rngCursor: {},
          stageIndex: 4,
          stageGoal: { kind: 'score-threshold', target: 500 },
          board: boardWith(2),
        }),
        relics: [{ id: 'carried', charges: 1 }],
      }),
    );

    const { engine } = compose({ backing, setup: false });
    const commits: { stageIndex: number; target: number; relics: number }[] = [];

    engine.events.on('state:commit', (event): void => {
      commits.push({
        stageIndex: event.stage.stageIndex,
        target: event.stage.goal.target,
        relics: event.relics.length,
      });
    });

    engine.setup();

    // `EMPTY_STAGE_CONTEXT` is stage 0 with a zero target and no relics, which
    // is exactly what every commit carried before the controller existed.
    expect(commits[0]).toEqual({ stageIndex: 4, target: 500, relics: 1 });
  });

  it('carries a stage slice measured from the board the commit carries', () => {
    // The withdrawn-move rewind: the board is restored AND the move is
    // withdrawn, so the turn emits no `move:after` and the `move:after`
    // measurement never runs for it.
    const { controller, engine, stop } = compose({ setup: false });

    // Half of stage 0's target, so the restored board moves the progress
    // measurably without clearing the stage and starting another one.
    const goalTile = 8;

    engine.hooks.register({
      id: 'anchor',
      hooks: {
        onBeforeMove: (payload, context): typeof payload => {
          const board = payload.board.serialize();

          for (const column of board.cells) {
            for (let y = 0; y < column.length; y += 1) {
              column[y] = null;
            }
          }

          const first = board.cells[0];

          if (first !== undefined) {
            first[0] = { position: { x: 0, y: 0 }, value: goalTile };
          }

          context.effects.request({ kind: 'restoreBoard', board });
          payload.cancelled = true;

          return payload;
        },
      },
    });

    engine.setup(boardWith(2));

    const progress: number[] = [];

    engine.events.on('state:commit', (event): void => {
      progress.push(event.stage.goalProgress);
    });

    expect(engine.move(DIRECTION_LEFT)).toBe(false);

    const goal = controller.stageContext().goal;
    const expected = Math.min(goalTile / goal.target, 1);

    expect(progress).toHaveLength(1);
    expect(progress[0]).toBeCloseTo(expected, 10);

    stop();
  });

  it('projects the relic slice from the registry at commit time', () => {
    const spender: Relic = {
      id: 'spender',
      name: 'Spender',
      rarity: 'common',
      description: 'Spends one charge on every resolved move.',
      charges: 2,
      hooks: {
        onAfterMove: (payload, context): typeof payload => {
          context.spendCharge();

          return payload;
        },
      },
    };

    const { controller, engine, stop } = composeWithRelics({
      catalogue: [spender],
    });

    controller.recordRewardOffer([spender.id]);

    expect(controller.resolveReward(spender.id).accepted).toBe(true);

    const charges: (number | undefined)[] = [];

    engine.events.on('state:commit', (event): void => {
      charges.push(event.relics[0]?.charges);
    });

    engine.move(DIRECTION_LEFT);

    // The charge the handler spent DURING this turn is on this turn's commit.
    expect(charges).toEqual([1]);

    stop();
  });

  it('hands out a frozen copy of the stage goal, never the live one', () => {
    const { controller, stages } = compose({ setup: false });
    const target = stages.ladder[0].target;
    const projected = controller.stageContext().goal;

    // `readonly` in `StageCommitContext` binds the reference, not the object,
    // so the projection is frozen as well: a listener cannot retarget the goal
    // the run is measured against and the goal that reaches storage.
    expect(Object.isFrozen(projected)).toBe(true);
    expect(() => {
      (projected as { target: number }).target = 1;
    }).toThrow(TypeError);

    // A fresh object per call, so a listener that holds one cannot reach the
    // envelope's own goal through it either.
    expect(controller.stageContext().goal).not.toBe(projected);
    expect(controller.stageContext().goal.target).toBe(target);
    expect(controller.state().stageGoal.target).toBe(target);
  });

  it('copies the board on the exceptional state projection', () => {
    const backing = new MemoryStorage();
    const manager = new LocalStorageManager({ storage: backing });
    const config = createDefaultRulesConfig();

    // A relic whose state slot cannot be read.
    const hostile: PersistedRelic = {
      id: 'hostile',

      get state(): unknown {
        throw new Error('unreadable relic state');
      },
    };

    const controller = new RunController({
      store: new RunStateStore({ storage: manager, config }),
      identity: resolveRunIdentity({ storage: manager }),
      config,
      relics: {
        snapshotRelics: (): readonly PersistedRelic[] => [hostile],
      },
    });

    controller.begin();

    const engine = new Engine({
      config,
      streams: createRngStreams(controller.seed(), controller.cursors()),
      storage: manager,
      stageContext: () => controller.stageContext(),
      relicContext: () => controller.relicContext(),
    });

    const stop = controller.observe(engine, () => ({
      'spawn-value': 0,
      'spawn-position': 0,
      'relic-draw': 0,
      'rarity-weight': 0,
    }));

    // The commit is what puts the hostile relic and the engine's board into
    // the envelope.
    engine.setup(boardWith(2));

    const projected = controller.state();

    expect(projected.board.grid.cells[0]?.[0]?.value).toBe(2);

    // The fallback projection must share no board with the envelope: a caller
    // that writes into what it was handed cannot corrupt the board the run
    // persists.
    const cells = projected.board.grid.cells as (SerializedGameState['grid']['cells'][number])[];
    const column = cells[0];

    if (column !== undefined) {
      column[0] = null;
    }

    expect(controller.state().board.grid.cells[0]?.[0]?.value).toBe(2);

    stop();
  });

  it('carries relics in pickup order and never carries their private state', () => {
    const backing = new MemoryStorage();

    backing.setItem(
      RUN_STATE_KEY,
      JSON.stringify({
        ...createFreshRunState({
          runId: 'stored-run',
          seed: 'stored-seed',
          rngCursor: {},
          stageIndex: 0,
          stageGoal: { kind: 'highest-tile', target: 16 },
          board: boardWith(2),
        }),
        relics: [
          { id: 'picked-first', charges: 2, state: { secret: 1 } },
          { id: 'picked-second' },
          { id: 'picked-third', charges: 0 },
        ],
      }),
    );

    const { controller } = compose({ backing, setup: false });
    const carried = controller.relicContext();

    expect(carried.map((entry) => entry.id)).toEqual([
      'picked-first',
      'picked-second',
      'picked-third',
    ]);

    // A zero-charge relic is still carried: the bus is what skips its handler,
    // and a HUD has to be able to show that it is spent.
    expect(carried[2]).toEqual({ id: 'picked-third', charges: 0 });

    expect('charges' in (carried[1] ?? {})).toBe(false);

    for (const entry of carried) {
      expect('state' in entry).toBe(false);
    }
  });
});

describe('run-state persistence', () => {
  it('writes the nine-member envelope on the first commit', () => {
    const { backing, controller } = compose();
    const stored = readStored(backing);

    expect(stored).not.toBeNull();
    expect(Object.keys(stored ?? {}).sort()).toEqual([
      'board',
      'goalProgress',
      'relics',
      'rngCursor',
      'runId',
      'schemaVersion',
      'seed',
      'stageGoal',
      'stageIndex',
    ]);
    expect(stored?.seed).toBe(controller.seed());
    expect(stored?.runId).toBe(controller.runId());
  });

  it('wraps the board snapshot the engine committed, rather than replacing it', () => {
    const { backing, engine } = compose();

    play(engine, [DIRECTION_UP, DIRECTION_LEFT]);

    const stored = readStored(backing);
    const legacy = read(backing, GAME_STATE_KEY);

    // The two describe one board. The envelope wraps a copy.
    expect(legacy).not.toBeNull();
    expect(stored?.board).toEqual(JSON.parse(legacy ?? 'null'));
    expect(stored?.board.grid.size).toBe(4);
  });

  it('advances and persists the RNG cursors', () => {
    const { backing, engine } = compose();

    const opening = readStored(backing)?.rngCursor;

    // Two starting tiles, so both spawn substreams have already moved.
    expect(opening?.['spawn-value']).toBe(2);
    expect(opening?.['spawn-position']).toBe(2);

    play(engine, MOVES);

    const after = readStored(backing)?.rngCursor;

    expect(after?.['spawn-value'] ?? 0).toBeGreaterThan(2);
    expect(after?.['spawn-position'] ?? 0).toBeGreaterThan(2);
  });

  it('leaves the two frozen keys in their frozen forms', () => {
    const { backing, manager, engine } = compose();

    play(engine, MOVES);

    const best = read(backing, BEST_SCORE_KEY);

    if (best !== null) {
      expect(best).toMatch(/^\d+$/);
      expect(manager.getBestScore()).toBe(best);
    } else {
      expect(manager.getBestScore()).toBe(0);
    }

    const legacy = JSON.parse(read(backing, GAME_STATE_KEY) ?? 'null') as
      | SerializedGameState
      | null;

    expect(Object.keys(legacy ?? {}).sort()).toEqual([
      'grid',
      'keepPlaying',
      'over',
      'score',
      'won',
    ]);
  });

  it('loads a legacy save that carries a board and no run state', () => {
    const backing = new MemoryStorage();
    const legacy = boardWith(8);

    legacy.score = 120;
    backing.setItem(GAME_STATE_KEY, JSON.stringify(legacy));
    backing.setItem(BEST_SCORE_KEY, '4096');

    const { controller, engine } = compose({ backing });

    // The board is restored by the engine from `gameState`, exactly as before,
    // and the run wraps it in a fresh envelope at stage 0.
    expect(engine.serialize().score).toBe(120);
    expect(controller.state().stageIndex).toBe(0);
    expect(readStored(backing)?.board.score).toBe(120);

    // The pre-existing best score survives the upgrade untouched.
    expect(read(backing, BEST_SCORE_KEY)).toBe('4096');
  });
});

/* ==========================================================================
 * 4b. One refused write, one record, one player-facing status
 *
 * ONE EXHAUSTED QUOTA DESCRIBED ITSELF THREE TIMES. `LocalStorageManager`
 * reported the refused `setItem`, `RunStateStore.save` reported the refused
 * envelope, and `write()` reported a third time — three records of one event,
 * none of which reached the player, who went on being shown a run that no
 * reload would ever find.
 *
 * The store's record is now the only one the write itself produces, and the
 * consequence is carried separately: the run's persistence status, reported on
 * the CHANGE rather than per refused write, and read back through
 * `persistenceStatus()` by whatever projects it into the interface. Decision
 * DL-RUNCTL-20.
 * ========================================================================== */

describe('a commit whose write is refused', () => {
  /** One composed run with every write after composition refused. */
  interface Refusing extends Composed {
    /** Restores the working `setItem`, so a retry can succeed. */
    readonly restore: () => void;
  }

  /**
   * Composes a run over a one-tile legacy board and then makes every later
   * write fail.
   *
   * The failure is injected at the STORAGE boundary rather than by faking the
   * store, so the refusal travels the production path: `setItem` raises as it
   * does on an exhausted quota, `LocalStorageManager` absorbs it,
   * `RunStateStore.save()` reports it once and answers `false`, and `write()`
   * resolves the status from that answer.
   *
   * The board holds a single 8 at the left wall, so `DIRECTION_RIGHT` always
   * moves and therefore always commits, and stage 0's goal of 16 stays
   * unresolved throughout.
   */
  function composeRefusing(): Refusing {
    const backing = new MemoryStorage();

    backing.setItem(GAME_STATE_KEY, JSON.stringify(boardWith(8)));

    const composed = compose({ backing, seed: 'commit-write-refused' });
    const working = backing.setItem.bind(backing);

    backing.setItem = (): void => {
      throw new Error('QuotaExceededError');
    };

    return {
      ...composed,
      restore: (): void => {
        backing.setItem = working;
      },
    };
  }

  it('reports the refusal once, and from the store alone', () => {
    const { engine, reports, stop } = composeRefusing();

    engine.move(DIRECTION_RIGHT);

    // ONE ATTEMPT, ONE RECORD. The size is the diagnostic half's whole point:
    // a record that cannot say how large the refused payload was cannot be
    // acted on.
    expect(reports.writeFailures).toHaveLength(1);
    expect(reports.writeFailures[0]?.key).toBe(RUN_STATE_KEY);
    expect(reports.writeFailures[0]?.byteLength ?? 0).toBeGreaterThan(0);

    stop();
  });

  it('reports the status change once, however many writes are refused', () => {
    const { controller, engine, reports, stop } = composeRefusing();

    play(engine, [
      DIRECTION_RIGHT,
      DIRECTION_LEFT,
      DIRECTION_RIGHT,
      DIRECTION_LEFT,
    ]);

    // The diagnostic record is per attempt; the player-facing one is per
    // transition. A store out of quota refuses every write of the rest of the
    // run, and a report per attempt would be one record a turn saying what the
    // first already said.
    expect(reports.writeFailures.length).toBeGreaterThan(1);
    expect(reports.persistence).toEqual([
      { status: 'ephemeral', previous: 'persistent', refusedWrites: 1 },
    ]);
    expect(controller.persistenceStatus()).toBe('ephemeral');

    stop();
  });

  it('plays the turn from memory rather than abandoning it', () => {
    const { backing, controller, engine, reports, stop } = composeRefusing();

    engine.move(DIRECTION_RIGHT);

    // THE TURN STANDS. The board is played from memory whether or not it was
    // stored, so an exhausted quota degrades the run instead of ending it.
    const played = engine.serialize();

    expect(played.grid.cells[0]?.[0]).toBeNull();
    expect(controller.state().board).toEqual(played);
    expect(reports.ended).toEqual([]);

    // And storage still holds the envelope the last accepted write left, which
    // is exactly what makes the run ephemeral from here on.
    expect(readStored(backing)?.board.grid.cells[0]?.[0]?.value).toBe(8);

    stop();
  });

  it('reports the recovery, with the refused count cleared', () => {
    const { backing, controller, engine, reports, restore, stop } =
      composeRefusing();

    engine.move(DIRECTION_RIGHT);
    restore();
    engine.move(DIRECTION_LEFT);

    expect(reports.persistence).toEqual([
      { status: 'ephemeral', previous: 'persistent', refusedWrites: 1 },
      { status: 'persistent', previous: 'ephemeral', refusedWrites: 0 },
    ]);
    expect(controller.persistenceStatus()).toBe('persistent');
    expect(readStored(backing)?.board).toEqual(engine.serialize());

    stop();
  });

  it('says nothing at all about a run that is reaching storage', () => {
    const { controller, engine, reports, stop } = compose();

    play(engine, MOVES);

    expect(reports.writeFailures).toEqual([]);
    expect(reports.persistence).toEqual([]);
    expect(controller.persistenceStatus()).toBe('persistent');

    stop();
  });
});

/* ==========================================================================
 * 5. Reload continuity — the determinism the cursors exist for
 * ========================================================================== */

describe('resuming a run', () => {
  it('continues the deterministic sequence instead of restarting it', () => {
    const seed = 'reload-continuity-seed';

    // One uninterrupted run of the whole move list.
    const straight = compose({ seed });

    play(straight.engine, MOVES);

    const expected = straight.engine.serialize();
    const expectedCursors = readStored(straight.backing)?.rngCursor;

    straight.stop();

    // The same seed, interrupted after half the moves and resumed from
    // storage.
    const interrupted = compose({ seed });

    play(interrupted.engine, MOVES.slice(0, 3));
    interrupted.stop();

    const resumed = compose({ backing: interrupted.backing });

    expect(resumed.controller.identity.resumed).toBe(true);
    expect(resumed.controller.seed()).toBe(seed);

    play(resumed.engine, MOVES.slice(3));

    // Identical boards. A resumed run that restarted its substreams would take
    // the opening draws again here and diverge on the very first spawn.
    expect(resumed.engine.serialize()).toEqual(expected);
    expect(readStored(resumed.backing)?.rngCursor).toEqual(expectedCursors);
  });

  it('does not replay the opening spawns', () => {
    const first = compose({ seed: 'no-replay-seed' });

    play(first.engine, [DIRECTION_UP]);

    const beforeReload = readStored(first.backing)?.rngCursor['spawn-value'] ?? 0;

    first.stop();

    const second = compose({ backing: first.backing });

    expect(readStored(second.backing)?.rngCursor['spawn-value']).toBe(
      beforeReload,
    );
  });
});

describe('stage advancement', () => {
  it('measures progress toward the stage goal as moves resolve', () => {
    const { controller, engine } = compose();

    // The default stage 0 goal is the highest tile reaching 16, so a board of
    // 2s and 4s is partway there and a fresh board is not there at all.
    expect(controller.stageContext().goalProgress).toBeGreaterThanOrEqual(0);
    expect(controller.stageContext().goalProgress).toBeLessThan(1);

    play(engine, MOVES);

    expect(controller.stageContext().goalProgress).toBeGreaterThan(0);
  });

  it('opens a restored board on its real progress rather than on zero', () => {
    const backing = new MemoryStorage();

    // Half of stage 0's default target of 16 is already on the board.
    backing.setItem(GAME_STATE_KEY, JSON.stringify(boardWith(8)));

    const { controller } = compose({ backing });

    expect(controller.stageContext().goalProgress).toBeCloseTo(0.5, 10);
  });

  it('resolves and advances a stage whose goal is met', () => {
    const backing = new MemoryStorage();

    // A 16 already on the board meets stage 0's default target.
    backing.setItem(GAME_STATE_KEY, JSON.stringify(boardWith(16)));

    // `setup` is deferred so the assertions can watch the emission it makes:
    // its first commit already meets the goal, so the resolution happens
    // there.
    const { controller, reports, engine, stages } = compose({
      backing,
      setup: false,
    });
    const ends: { stageIndex: number; cleared: boolean }[] = [];

    engine.events.on('stage:end', (event): void => {
      ends.push({ stageIndex: event.stageIndex, cleared: event.cleared });
    });

    engine.setup();

    expect(reports.advanced[0]).toEqual({
      fromStageIndex: 0,
      toStageIndex: 1,
      target: stages.ladder[1]?.target ?? 0,
    });
    expect(ends[0]?.cleared).toBe(true);
    expect(controller.state().stageIndex).toBe(1);

    expect(controller.state().goalProgress).toBe(
      16 / (stages.ladder[1]?.target ?? 1),
    );
    expect(readStored(backing)?.stageIndex).toBe(1);
  });

  it('reports the cleared stage in the stage-end payload, not the next one', () => {
    const backing = new MemoryStorage();

    backing.setItem(GAME_STATE_KEY, JSON.stringify(boardWith(16)));

    const { engine } = compose({ backing, setup: false });
    const ends: number[] = [];

    engine.events.on('stage:end', (event): void => {
      ends.push(event.stageIndex);
    });

    engine.setup();

    // The stage that CLEARED, not the one now in force: the advance happens
    // after the emission precisely so these two cannot be confused.
    expect(ends).toEqual([0]);
  });

  it('commits the advanced stage beside the advanced stage goal', () => {
    const backing = new MemoryStorage();

    backing.setItem(GAME_STATE_KEY, JSON.stringify(boardWith(16)));

    const { engine, stages } = compose({ backing, setup: false });
    const commits: { stageIndex: number; target: number }[] = [];

    engine.events.on('state:commit', (event): void => {
      commits.push({
        stageIndex: event.stage.stageIndex,
        target: event.stage.goal.target,
      });
    });

    engine.setup();

    // A commit reports the stage now in force.
    expect(commits).toContainEqual({
      stageIndex: 1,
      target: stages.ladder[1]?.target,
    });

    // NEVER a mismatched pair.
    for (const commit of commits) {
      expect(commit.target).toBe(stages.ladder[commit.stageIndex]?.target);
    }
  });

  it('advances exactly one stage per commit', () => {
    const backing = new MemoryStorage();

    // 256 meets stage 0's target of 16 and every target up to its own, so an
    // unguarded resolution would advance repeatedly inside one commit.
    backing.setItem(GAME_STATE_KEY, JSON.stringify(boardWith(256)));

    const { controller, reports, engine } = compose({ backing, setup: false });

    engine.setup();

    expect(reports.advanced).toHaveLength(1);
    expect(controller.state().stageIndex).toBe(1);

    play(engine, [DIRECTION_RIGHT]);

    expect(reports.advanced).toHaveLength(2);
    expect(controller.state().stageIndex).toBe(2);
  });

  it('carries relics across a stage transition', () => {
    const backing = new MemoryStorage();
    const board = boardWith(16);

    backing.setItem(GAME_STATE_KEY, JSON.stringify(board));
    backing.setItem(
      RUN_STATE_KEY,
      JSON.stringify({
        ...createFreshRunState({
          runId: 'stored-run',
          seed: 'stored-seed',
          rngCursor: {},
          stageIndex: 0,
          stageGoal: { kind: 'highest-tile', target: 16 },
          board,
        }),
        relics: [{ id: 'kept', charges: 4 }],
      }),
    );

    const { controller, engine } = compose({ backing, setup: false });

    engine.setup();

    // Relics are held for the run, not for the stage.
    expect(controller.state().stageIndex).toBeGreaterThan(0);
    expect(controller.relicContext()).toEqual([{ id: 'kept', charges: 4 }]);
  });
});

describe('ending a run', () => {
  it('clears the envelope alongside the board the engine clears', () => {
    const backing = new MemoryStorage();

    // A full board of alternating values has no move and no merge available.
    const values = [2, 4];
    const cells: ({ position: { x: number; y: number }; value: number } | null)[][] = [];

    for (let x = 0; x < 4; x += 1) {
      const column: ({ position: { x: number; y: number }; value: number } | null)[] = [];

      for (let y = 0; y < 4; y += 1) {
        column.push({
          position: { x, y },
          value: values[(x + y) % 2] ?? 2,
        });
      }

      cells.push(column);
    }

    backing.setItem(
      GAME_STATE_KEY,
      JSON.stringify({
        grid: { size: 4, cells },
        score: 512,
        over: true,
        won: false,
        keepPlaying: false,
      }),
    );

    const { backing: store, controller, reports } = compose({ backing });

    expect(read(store, GAME_STATE_KEY)).toBeNull();
    expect(readStored(store)).toBeNull();
    expect(reports.ended[0]?.outcome).toBe('lost');
    expect(controller.lastSummary()?.score).toBe(512);
  });

  it('replaces the envelope in force so a second run starts at stage 0', () => {
    const { controller } = compose({ setup: false });

    // Reach stage 3, then end the run.
    controller.advanceStage();
    controller.advanceStage();
    controller.advanceStage();

    expect(controller.state().stageIndex).toBe(3);

    controller.endRun('abandoned');

    expect(controller.state().stageIndex).toBe(0);
    expect(controller.state().relics).toEqual([]);
    expect(controller.lastSummary()?.stageIndex).toBe(3);
  });

  it('ends idempotently', () => {
    const { controller, reports } = compose({ setup: false });

    const first = controller.endRun('won');
    const second = controller.endRun('lost');

    expect(second).toEqual(first);
    expect(reports.ended).toHaveLength(1);
    expect(reports.ended[0]?.outcome).toBe('won');
  });

  it('carries the seed in the summary and redacts it from the report', () => {
    const { controller, reports } = compose({ seed: 'summary-seed', setup: false });

    const summary = controller.endRun('abandoned');

    // The summary screen displays and offers the seed for copying; a report
    // never carries text the player may have typed.
    expect(summary.seed).toBe('summary-seed');
    expect(reports.ended[0]).not.toHaveProperty('seed');
  });
});

describe('detaching the controller', () => {
  it('stops persisting once its subscriptions are released', () => {
    const { backing, engine, stop } = compose();

    const before = readStored(backing)?.rngCursor['spawn-value'] ?? 0;

    stop();
    play(engine, MOVES);

    // The engine keeps writing `gameState`; the envelope stops changing.
    expect(readStored(backing)?.rngCursor['spawn-value']).toBe(before);
    expect(read(backing, GAME_STATE_KEY)).not.toBeNull();
  });
});

/** One composed run with a real registry over the engine's own hook bus. */
interface ComposedWithRelics extends Composed {
  readonly registry: RelicRegistry;
}

/**
 * Composes as `compose` does, and additionally builds a real registry over the
 * engine's hook bus and binds it to the controller.
 */
function composeWithRelics(
  options: ComposeOptions & { readonly catalogue?: readonly Relic[] } = {},
): ComposedWithRelics {
  const backing = options.backing ?? new MemoryStorage();
  const manager = new LocalStorageManager({ storage: backing });
  const config = createDefaultRulesConfig();
  const stages = createDefaultStageConfig();
  const { reports, reporter } = createRecorder();

  const issued: string[] = [];
  let next = 0;
  const createToken = (): string => {
    const token = options.tokens?.[next] ?? `token-${String(next)}`;

    next += 1;
    issued.push(token);

    return token;
  };

  const identity = resolveRunIdentity({
    storage: manager,
    createToken,
    seed: options.enteredSeed ?? identitySeed(manager, options.seed),
  });

  const holder: { controller: RunController | null } = { controller: null };

  const engine = new Engine({
    config,
    streams: createRngStreams(identity.seed, {}),
    storage: manager,
    stageContext: () => holder.controller?.stageContext() ?? {
      stageIndex: 0,
      goal: stages.ladder[0],
      goalProgress: 0,
    },
    relicContext: () => holder.controller?.relicContext() ?? [],
  });

  const registry = new RelicRegistry({
    bus: engine.hooks,
    ...(options.catalogue === undefined
      ? {}
      : { catalogue: options.catalogue }),
  });

  const controller = new RunController({
    store: new RunStateStore({ storage: manager, config, reporter }),
    identity,
    config,
    stages,
    createToken,
    reporter,

    // The binding under test. The real registry, passed as the port.
    relics: registry,
  });

  holder.controller = controller;
  controller.begin();

  const streams = createRngStreams(controller.seed(), controller.cursors());
  const stop = controller.observe(engine, () => streams.snapshotCursors());

  if (options.setup !== false) {
    engine.setup(controller.openingBoard());
  }

  return {
    backing,
    manager,
    config,
    stages,
    controller,
    engine,
    reports,
    tokens: issued,
    stop,
    registry,
  };
}

/** The identifier of the first relic in the real catalogue. */
const FIRST_RELIC: string = RELIC_CATALOGUE[0].id;

/** The identifier of the second relic in the real catalogue. */
const SECOND_RELIC: string = RELIC_CATALOGUE[1].id;

describe('the relic registry port', () => {
  it('is satisfied by the real RelicRegistry', () => {
    const { registry } = composeWithRelics();

    // Every member the port names, resolved on the registry itself.
    expect(registry.serialize).toBeTypeOf('function');
    expect(registry.restore).toBeTypeOf('function');
    expect(registry.persistedEntry).toBeTypeOf('function');
    expect(registry.knows).toBeTypeOf('function');
    expect(registry.pickUp).toBeTypeOf('function');
    expect(registry.activate).toBeTypeOf('function');
  });

  it('calls every registry member through its owner, keeping this', () => {
    const { controller, engine, registry } = composeWithRelics();

    // `RelicRegistry` supplies these as CLASS METHODS reading private fields.
    controller.recordRewardOffer([FIRST_RELIC]);

    expect(controller.resolveReward(FIRST_RELIC).accepted).toBe(true);
    expect(controller.persist(engine, () => ({}) as never)).toBe(true);
    expect(controller.relics().map((relic) => relic.id)).toEqual([
      FIRST_RELIC,
    ]);
    expect(registry.ownedIds()).toEqual([FIRST_RELIC]);
  });

  it('registers a picked-up relic with the live hook bus', () => {
    const { controller, engine } = composeWithRelics();

    controller.recordRewardOffer([FIRST_RELIC]);
    controller.resolveReward(FIRST_RELIC);

    // The point of the pickup. A relic recorded in the envelope but never
    // registered was displayed and never fired.
    expect(
      engine.hooks.subscribers().map((subscriber) => subscriber.id),
    ).toContain(FIRST_RELIC);
  });

  it('hands a restored envelope s relics back to the registry', () => {
    const backing = new MemoryStorage();
    const first = composeWithRelics({ backing, seed: 'relic-resume-seed' });

    first.controller.recordRewardOffer([FIRST_RELIC, SECOND_RELIC]);
    first.controller.resolveReward(FIRST_RELIC);
    first.controller.recordRewardOffer([SECOND_RELIC]);
    first.controller.resolveReward(SECOND_RELIC);
    first.controller.persist(first.engine, () => ({}) as never);
    first.stop();

    const second = composeWithRelics({ backing, seed: 'relic-resume-seed' });

    // Pickup order survives the round trip, and the bus dispatches in it.
    expect(second.registry.ownedIds()).toEqual([FIRST_RELIC, SECOND_RELIC]);
    expect(
      second.engine.hooks.subscribers().map((subscriber) => subscriber.id),
    ).toEqual([FIRST_RELIC, SECOND_RELIC]);
  });
});

describe('resolving a reward', () => {
  it('accepts a relic that was offered and is known', () => {
    const { controller } = composeWithRelics();

    controller.recordRewardOffer([FIRST_RELIC, SECOND_RELIC]);

    const resolution = controller.resolveReward(SECOND_RELIC);

    expect(resolution.accepted).toBe(true);
    expect(resolution.refusal).toBeNull();
    expect(controller.relics().map((relic) => relic.id)).toEqual([
      SECOND_RELIC,
    ]);
  });

  it('refuses a relic that was never offered', () => {
    const { controller, registry } = composeWithRelics();

    controller.recordRewardOffer([FIRST_RELIC]);

    const resolution = controller.resolveReward(SECOND_RELIC);

    expect(resolution.accepted).toBe(false);
    expect(resolution.refusal).toBe('not-offered');
    expect(controller.relics()).toEqual([]);
    expect(registry.ownedIds()).toEqual([]);
  });

  it('refuses a relic when nothing was offered at all', () => {
    const { controller } = composeWithRelics();

    expect(controller.resolveReward(FIRST_RELIC).refusal).toBe('not-offered');
    expect(controller.relics()).toEqual([]);
  });

  it('refuses an identifier the catalogue does not carry', () => {
    const { controller } = composeWithRelics();

    expect(controller.recordRewardOffer(['no-such-relic'])).toBe(false);

    // Nothing stands, so the selection is refused with it.
    expect(controller.resolveReward('no-such-relic').refusal).toBe(
      'not-offered',
    );
    expect(controller.relics()).toEqual([]);
  });

  it('refuses a selection the catalogue stopped carrying', () => {
    const backing = new MemoryStorage();
    const manager = new LocalStorageManager({ storage: backing });
    const config = createDefaultRulesConfig();
    let asked = 0;
    const controller = new RunController({
      store: new RunStateStore({ storage: manager, config }),
      identity: resolveRunIdentity({ storage: manager }),
      config,
      relics: {
        // Carried while the offer is admitted and gone by the time it is
        // chosen, which is the one way the selection-side catalogue gate is
        // reached: the offer gate is the same measurement taken earlier.
        knows: (): boolean => {
          asked += 1;

          return asked === 1;
        },
        pickUp: (): unknown => ({}),
      },
    });

    controller.begin();

    expect(controller.recordRewardOffer([FIRST_RELIC])).toBe(true);

    const resolution = controller.resolveReward(FIRST_RELIC);

    expect(resolution.accepted).toBe(false);
    expect(resolution.refusal).toBe('unknown');
    expect(controller.relics()).toEqual([]);
  });

  it('refuses an empty identifier', () => {
    const { controller } = composeWithRelics();

    controller.recordRewardOffer(['']);

    expect(controller.resolveReward('').refusal).toBe('not-offered');
  });

  it('refuses a relic the run already holds', () => {
    const { controller } = composeWithRelics();

    controller.recordRewardOffer([FIRST_RELIC]);
    controller.resolveReward(FIRST_RELIC);
    controller.recordRewardOffer([FIRST_RELIC]);

    expect(controller.resolveReward(FIRST_RELIC).refusal).toBe('held');
    expect(controller.relics()).toHaveLength(1);
  });

  it('retains the offer when the selection was refused', () => {
    const { controller } = composeWithRelics();
    const offer = [FIRST_RELIC, SECOND_RELIC];

    controller.recordRewardOffer(offer);
    controller.resolveReward('no-such-relic');

    // The offer stands. Clearing it either way stranded the reward screen with
    // nothing left to present, so a refused pick could not be retried.
    expect(controller.resolveReward(FIRST_RELIC).accepted).toBe(true);
  });

  it('clears the offer once a selection was accepted', () => {
    const { controller } = composeWithRelics();

    controller.recordRewardOffer([FIRST_RELIC, SECOND_RELIC]);

    expect(controller.resolveReward(FIRST_RELIC).accepted).toBe(true);

    expect(controller.resolveReward(SECOND_RELIC).refusal).toBe(
      'not-offered',
    );
  });

  it('reports the offer and the selection whether or not it was taken', () => {
    const offered: string[][] = [];
    const selected: string[] = [];
    const backing = new MemoryStorage();
    const manager = new LocalStorageManager({ storage: backing });
    const config = createDefaultRulesConfig();
    const controller = new RunController({
      store: new RunStateStore({ storage: manager, config }),
      identity: resolveRunIdentity({ storage: manager }),
      config,
      reporter: {
        onRewardDrawn(report): void {
          offered.push([...report.offeredRelicIds]);
          selected.push(report.selectedRelicId ?? '');
        },
      },
    });

    controller.begin();
    controller.recordRewardOffer([FIRST_RELIC]);
    controller.resolveReward('no-such-relic');
    controller.resolveReward(FIRST_RELIC);

    expect(selected).toEqual(['no-such-relic', FIRST_RELIC]);
    expect(offered[0]).toEqual([FIRST_RELIC]);
  });

  it('refuses a pickup the registry declined', () => {
    const backing = new MemoryStorage();
    const manager = new LocalStorageManager({ storage: backing });
    const config = createDefaultRulesConfig();
    const controller = new RunController({
      store: new RunStateStore({ storage: manager, config }),
      identity: resolveRunIdentity({ storage: manager }),
      config,
      relics: {
        knows: (): boolean => true,
        pickUp: (): undefined => undefined,
      },
    });

    controller.begin();
    controller.recordRewardOffer([FIRST_RELIC]);

    const resolution = controller.resolveReward(FIRST_RELIC);

    expect(resolution.accepted).toBe(false);
    expect(resolution.refusal).toBe('refused');
    expect(controller.relics()).toEqual([]);
  });

  it('contains a registry that raises during a pickup', () => {
    const backing = new MemoryStorage();
    const manager = new LocalStorageManager({ storage: backing });
    const config = createDefaultRulesConfig();
    const controller = new RunController({
      store: new RunStateStore({ storage: manager, config }),
      identity: resolveRunIdentity({ storage: manager }),
      config,
      relics: {
        knows: (): boolean => true,
        pickUp: (): never => {
          throw new Error('registry down');
        },
      },
    });

    controller.begin();
    controller.recordRewardOffer([FIRST_RELIC]);

    expect(() => controller.resolveReward(FIRST_RELIC)).not.toThrow();
    expect(controller.relics()).toEqual([]);
  });

  it('accepts any offered identifier when no registry can be asked', () => {
    const { controller } = compose();

    controller.recordRewardOffer(['whatever-was-drawn']);

    // No registry publishes `knows`, so the catalogue gate cannot be applied
    // and the identifier is persisted bare.
    expect(controller.resolveReward('whatever-was-drawn').accepted).toBe(true);
    expect(controller.relics()).toEqual([{ id: 'whatever-was-drawn' }]);
  });
});

describe('completing a reward', () => {
  it('starts the stage the advance moved to', () => {
    const { controller, engine } = composeWithRelics();
    const started: number[] = [];

    engine.events.on('stage:start', (event) => {
      started.push(event.stageIndex);
    });

    controller.advanceStage();
    controller.recordRewardOffer([FIRST_RELIC]);
    controller.completeReward(engine, FIRST_RELIC);

    // Nothing else starts that stage. A run that only advanced its index never
    // dispatched `onStageStart` again.
    expect(started).toEqual([1]);
    expect(controller.stageIndex()).toBe(1);
  });

  it('dispatches onStageStart for the new stage', () => {
    const { controller, engine } = composeWithRelics();
    const dispatched: number[] = [];

    engine.hooks.register({
      id: 'stage-watcher',
      hooks: {
        onStageStart: (payload) => {
          dispatched.push(payload.stageIndex);

          return payload;
        },
      },
    });

    controller.advanceStage();
    controller.recordRewardOffer([FIRST_RELIC]);
    controller.completeReward(engine, FIRST_RELIC);

    expect(dispatched).toEqual([1]);
  });

  it('persists the relic through the stage start s own commit', () => {
    const { backing, controller, engine } = composeWithRelics();

    controller.advanceStage();
    controller.recordRewardOffer([FIRST_RELIC]);
    controller.completeReward(engine, FIRST_RELIC);

    // The pickup and the stage it was won in reach storage TOGETHER, with no
    // separate write and no move required in between.
    const stored = readStored(backing);

    expect(stored?.relics.map((relic) => relic.id)).toEqual([FIRST_RELIC]);
    expect(stored?.stageIndex).toBe(1);
  });

  it('starts NO stage when the selection was refused', () => {
    const { controller, engine } = composeWithRelics();
    const started: number[] = [];

    engine.events.on('stage:start', (event) => {
      started.push(event.stageIndex);
    });

    controller.advanceStage();
    controller.recordRewardOffer([FIRST_RELIC]);

    const before = controller.state().stageIndex;
    const resolution = controller.completeReward(engine, 'no-such-relic');

    // A REFUSED SELECTION LEAVES THE OFFER USABLE. The run is still owed the
    // choice the player has not made, so nothing may advance past it: starting a
    // stage here brought the offer back up over a board that had already moved on.
    expect(resolution.accepted).toBe(false);
    expect(resolution.refusal).toBe('not-offered');
    expect(started).toEqual([]);
    expect(controller.state().stageIndex).toBe(before);

    // AND THE SAME OFFER IS STILL THERE, so the second attempt succeeds and it
    // is that attempt that opens the stage.
    expect(controller.completeReward(engine, FIRST_RELIC).accepted).toBe(true);
    expect(controller.state().stageIndex).toBe(before);
    expect(started).toEqual([before]);
  });

  it('leaves the board in play across the transition', () => {
    const { controller, engine } = composeWithRelics();

    play(engine, MOVES);

    const before = engine.serialize();

    controller.advanceStage();
    controller.recordRewardOffer([FIRST_RELIC]);
    controller.completeReward(engine, FIRST_RELIC);

    // A stage transition is not a restart.
    expect(engine.serialize().grid).toEqual(before.grid);
    expect(engine.score).toBe(before.score);
  });
});

describe('the stage goal authority', () => {
  it('adopts the goal a stage:start carried', () => {
    const { controller, engine } = composeWithRelics();

    engine.hooks.register({
      id: 'goal-replacer',
      hooks: {
        onStageStart: (payload) => ({
          ...payload,
          goal: { kind: 'score-threshold', target: 7777 },
        }),
      },
    });

    engine.setup(null);

    // THE ENGINE'S goal, not the CONTROLLER'S OWN.
    expect(controller.stageGoal()).toEqual({
      kind: 'score-threshold',
      target: 7777,
    });
    expect(engine.stageGoalInForce()).toEqual(controller.stageGoal());
  });

  it('carries the adopted goal into the commit and into storage', () => {
    const { backing, controller, engine } = composeWithRelics();

    engine.hooks.register({
      id: 'goal-replacer',
      hooks: {
        onStageStart: (payload) => ({
          ...payload,
          goal: { kind: 'score-threshold', target: 12345 },
        }),
      },
    });

    engine.setup(null);

    expect(controller.stageContext().goal.target).toBe(12345);
    expect(readStored(backing)?.stageGoal.target).toBe(12345);
  });

  it('keeps its own goal when no handler replaced one', () => {
    const { controller, engine, stages } = composeWithRelics();

    engine.setup(null);

    expect(controller.stageGoal()).toEqual(stages.ladder[0]);
  });

  it('adopts the stage index alongside the goal', () => {
    const { controller, engine } = composeWithRelics();

    controller.advanceStage();
    controller.recordRewardOffer([FIRST_RELIC]);
    controller.completeReward(engine, FIRST_RELIC);

    // The index and the goal describe the SAME stage; a mismatch would record
    // one stage's goal against another's number.
    expect(controller.stageIndex()).toBe(1);
    expect(controller.stageGoal()).toEqual(engine.stageGoalInForce());
  });
});

describe('run-scoped rebuild', () => {
  it('publishes the scope of the run begin() adopted', () => {
    const scopes: RunScope[] = [];
    const backing = new MemoryStorage();
    const manager = new LocalStorageManager({ storage: backing });
    const config = createDefaultRulesConfig();
    const controller = new RunController({
      store: new RunStateStore({ storage: manager, config }),
      identity: resolveRunIdentity({ storage: manager, seed: 'scope-seed' }),
      config,
      onRunScope: (scope): void => {
        scopes.push(scope);
      },
    });

    controller.begin();

    expect(scopes).toHaveLength(1);
    expect(scopes[0].seed).toBe(controller.seed());
    expect(scopes[0].runId).toBe(controller.runId());
    expect(scopes[0].cursors['spawn-value']).toBe(0);
  });

  it('publishes the new scope before it reports that the run started', () => {
    const order: string[] = [];
    const backing = new MemoryStorage();
    const manager = new LocalStorageManager({ storage: backing });
    const config = createDefaultRulesConfig();
    const controller = new RunController({
      store: new RunStateStore({ storage: manager, config }),
      identity: resolveRunIdentity({ storage: manager }),
      config,
      reporter: {
        onRunStarted: (): void => {
          order.push('reported');
        },
      },
      onRunScope: (): void => {
        order.push('scope');
      },
    });

    controller.begin();

    // The order is the point. A root rebuilds the run's correlation scope from
    // this publication, so reporting first attributed the run's own opening
    // report to whatever run the root was reporting under before it.
    expect(order).toEqual(['scope', 'reported']);
  });

  it('reads a correlation READER, so a run rotation reaches its reports', () => {
    const backing = new MemoryStorage();
    const manager = new LocalStorageManager({ storage: backing });
    const config = createDefaultRulesConfig();
    let current = 'run-first';
    const controller = new RunController({
      store: new RunStateStore({ storage: manager, config }),
      identity: resolveRunIdentity({ storage: manager }),
      config,
      correlationId: (): string => current,
    });

    expect(controller.correlationId()).toBe('run-first');

    // A second run of one page load. A captured identifier kept every later
    // report of this controller attributed to the run that ended.
    current = 'run-second';

    expect(controller.correlationId()).toBe('run-second');
  });

  it('publishes the new scope before the engine opens a board', () => {
    const order: string[] = [];
    const backing = new MemoryStorage();
    const manager = new LocalStorageManager({ storage: backing });
    const config = createDefaultRulesConfig();
    const controller = new RunController({
      store: new RunStateStore({ storage: manager, config }),
      identity: resolveRunIdentity({ storage: manager }),
      config,
      onRunScope: (): void => {
        order.push('scope');
      },
    });

    controller.begin();
    order.length = 0;

    controller.startRun(
      {
        events: { on: () => (): void => undefined },
        serialize: () => emptySnapshot(),
        endStage: () => undefined,
        startStage: () => undefined,
        setup: () => {
          order.push('setup');
        },
        restart: () => undefined,
        move: () => false,
        isGameTerminated: () => false,
        continuePlaying: () => undefined,
      },
      { seed: 'brand-new-seed' },
    );

    // The order is the point. Rebuilding after `setup` would draw the opening
    // spawns from the previous run's substreams.
    expect(order).toEqual(['scope', 'setup']);
  });

  it('publishes the fresh seed, run id and zeroed cursors', () => {
    const scopes: RunScope[] = [];
    const backing = new MemoryStorage();
    const manager = new LocalStorageManager({ storage: backing });
    const config = createDefaultRulesConfig();
    let issued = 0;
    const controller = new RunController({
      store: new RunStateStore({ storage: manager, config }),
      identity: resolveRunIdentity({ storage: manager }),
      config,
      createToken: (): string => {
        issued += 1;

        return `run-${String(issued)}`;
      },
      onRunScope: (scope): void => {
        scopes.push(scope);
      },
    });

    controller.begin();
    scopes.length = 0;

    controller.startRun(
      {
        events: { on: () => (): void => undefined },
        serialize: () => emptySnapshot(),
        endStage: () => undefined,
        startStage: () => undefined,
        setup: () => undefined,
        restart: () => undefined,
        move: () => false,
        isGameTerminated: () => false,
        continuePlaying: () => undefined,
      },
      { seed: 'a-supplied-seed' },
    );

    expect(scopes).toHaveLength(1);
    expect(scopes[0].seed).toBe('a-supplied-seed');
    expect(scopes[0].runId).toBe(controller.runId());
    expect(scopes[0].seedProvided).toBe(true);
    expect(scopes[0].cursors['spawn-value']).toBe(0);
  });

  it('still starts the run when the root raises while rebuilding', () => {
    const backing = new MemoryStorage();
    const manager = new LocalStorageManager({ storage: backing });
    const config = createDefaultRulesConfig();
    const controller = new RunController({
      store: new RunStateStore({ storage: manager, config }),
      identity: resolveRunIdentity({ storage: manager }),
      config,
      onRunScope: (): never => {
        throw new Error('rebuild failed');
      },
    });

    // A half-rebuilt root is recoverable; a half-started run is not.
    expect(() => controller.begin()).not.toThrow();
    expect(controller.seed().length).toBeGreaterThan(0);
  });
});

describe('the opening board', () => {
  it('is null for a fresh run, so start tiles are inserted', () => {
    const { controller, engine } = composeWithRelics();

    expect(controller.openingBoard()).toBeNull();

    expect(
      engine.serialize().grid.cells.flat().filter((cell) => cell !== null),
    ).toHaveLength(2);
  });

  it('is the reconciled board of an adopted envelope', () => {
    const backing = new MemoryStorage();
    const first = composeWithRelics({ backing, seed: 'opening-seed' });

    play(first.engine, MOVES);
    first.controller.persist(first.engine, () => ({}) as never);
    first.stop();

    const stored = readStored(backing);
    const second = composeWithRelics({ backing, seed: 'opening-seed' });

    expect(second.controller.openingBoard()).toEqual(stored?.board);
    expect(second.engine.score).toBe(stored?.board.score);
  });

  it('opens a fresh playable board for an unreadable payload', () => {
    const backing = new MemoryStorage();

    backing.setItem(RUN_STATE_KEY, '{not json at all');

    const { controller, engine } = composeWithRelics({ backing });

    // `store.exists` reported SUCCESS for this key, and the run then opened on
    // the envelope's own empty board — which suppressed the start tiles and
    // left an unplayable board.
    expect(controller.openingBoard()).toBeNull();
    expect(
      engine.serialize().grid.cells.flat().filter((cell) => cell !== null),
    ).toHaveLength(2);
  });

  it('opens a fresh playable board when the seed is another run s', () => {
    const backing = new MemoryStorage();
    const first = composeWithRelics({ backing, seed: 'seed-one' });

    play(first.engine, MOVES);
    first.controller.persist(first.engine, () => ({}) as never);
    first.stop();

    const second = composeWithRelics({ backing, enteredSeed: 'seed-two' });

    expect(second.controller.openingBoard()).toBeNull();
    expect(
      second.engine.serialize().grid.cells.flat()
        .filter((cell) => cell !== null),
    ).toHaveLength(2);
  });

  it('resumeRun opens a playable board for an unreadable payload', () => {
    const backing = new MemoryStorage();

    backing.setItem(RUN_STATE_KEY, '{not json at all');

    const { controller, engine } = composeWithRelics({
      backing,
      setup: false,
    });

    controller.resumeRun(engine);

    // `store.exists` reports SUCCESS for a key that is present and unreadable,
    // and `resumeRun` then handed the engine the envelope's own EMPTY board.
    expect(
      engine.serialize().grid.cells.flat().filter((cell) => cell !== null),
    ).toHaveLength(2);
    expect(engine.score).toBe(0);
  });

  it('resumeRun opens a playable board when the stored seed differs', () => {
    const backing = new MemoryStorage();
    const first = composeWithRelics({ backing, seed: 'seed-alpha' });

    play(first.engine, MOVES);
    first.controller.persist(first.engine, () => ({}) as never);
    first.stop();

    const second = composeWithRelics({
      backing,
      enteredSeed: 'seed-beta',
      setup: false,
    });

    second.controller.resumeRun(second.engine);

    // The envelope is present and READABLE but belongs to another seed, so it
    // is not adopted.
    expect(
      second.engine.serialize().grid.cells.flat()
        .filter((cell) => cell !== null),
    ).toHaveLength(2);
  });

  it('resumeRun opens on the reconciled board', () => {
    const backing = new MemoryStorage();
    const first = composeWithRelics({ backing, seed: 'resume-seed' });

    play(first.engine, MOVES);
    first.controller.persist(first.engine, () => ({}) as never);
    first.stop();

    const stored = readStored(backing);
    const second = composeWithRelics({
      backing,
      seed: 'resume-seed',
      setup: false,
    });

    second.controller.resumeRun(second.engine);

    expect(second.engine.score).toBe(stored?.board.score);
  });
});

describe('state ownership', () => {
  it('freezes the goal it hands back', () => {
    const { controller } = composeWithRelics();
    const goal = controller.stageGoal() as { target: number };

    expect(Object.isFrozen(goal)).toBe(true);
    expect(() => {
      goal.target = 1;
    }).toThrow();
    expect(controller.stageGoal().target).not.toBe(1);
  });

  it('hands back a different goal object each call', () => {
    const { controller } = composeWithRelics();

    expect(controller.stageGoal()).not.toBe(controller.stageGoal());
  });

  it('freezes the relic list and every entry in it', () => {
    const { controller } = composeWithRelics();

    controller.recordRewardOffer([FIRST_RELIC]);
    controller.resolveReward(FIRST_RELIC);

    const held = controller.relics();

    expect(Object.isFrozen(held)).toBe(true);
    expect(Object.isFrozen(held[0])).toBe(true);
    expect(() => {
      (held as unknown as PersistedRelic[]).push({ id: 'injected' });
    }).toThrow();
    expect(controller.relics()).toHaveLength(1);
  });

  it('detaches a relic s state slot from the envelope', () => {
    const { controller } = composeWithRelics();

    controller.recordRewardOffer([FIRST_RELIC]);
    controller.resolveReward(FIRST_RELIC);

    const first = controller.relics();
    const second = controller.relics();

    expect(first[0]).not.toBe(second[0]);
  });

  it('freezes the envelope it hands back', () => {
    const { controller } = composeWithRelics();
    const state = controller.state();

    expect(Object.isFrozen(state)).toBe(true);
    expect(() => {
      (state as { stageIndex: number }).stageIndex = 99;
    }).toThrow();
    expect(controller.state().stageIndex).toBe(0);
  });

  it('does not let a write through state() reach the envelope', () => {
    const { controller } = composeWithRelics();
    const state = controller.state();

    const escaped = state as unknown as {
      relics: PersistedRelic[];
      board: { grid: { cells: (unknown | null)[][] } };
    };

    escaped.relics.push({ id: 'injected' });
    escaped.board.grid.cells[0][0] = null;

    expect(controller.state().relics).toEqual([]);
    expect(controller.relics()).toEqual([]);
  });

  it('hands back a different envelope object each call', () => {
    const { controller } = composeWithRelics();

    expect(controller.state()).not.toBe(controller.state());
    expect(controller.state().board).not.toBe(controller.state().board);
  });
});

/* ==========================================================================
 * 16. Charges are spent by an effect, and by nothing else
 *
 * There is NO manual activation. Every relic in the catalogue is automatic: it
 * fires on the hooks it binds when its own trigger condition holds and asks
 * src/engine/hook-bus.ts for its charge on that one path. A controller member
 * that deducted a charge on request would spend a budget and apply nothing, so
 * the controller publishes none, and the section below pins both halves of that:
 * the absent member, and the real relic whose effect and charge commit together
 * through the composed Engine -> HookBus -> RelicRegistry -> RunController ->
 * RunStateStore path.
 * ========================================================================== */

/** The first catalogue relic carrying a charge budget. */
const CHARGED_RELIC: string = (
  RELIC_CATALOGUE.find((relic): boolean => relic.charges !== undefined) as Relic
).id;

/** That relic's declared budget. */
const CHARGED_BUDGET: number = (
  RELIC_CATALOGUE.find((relic): boolean => relic.charges !== undefined) as Relic
).charges as number;

/**
 * A board holding two tiles of `value` side by side in row 0, so one move left
 * resolves exactly one merge.
 *
 * @param value Face value of each tile.
 * @param size Edge length.
 * @returns The snapshot.
 */
function mergePairBoard(value: number, size = 4): SerializedGameState {
  const cells: ({ position: { x: number; y: number }; value: number } | null)[][] =
    [];

  for (let x = 0; x < size; x += 1) {
    const column: (
      | { position: { x: number; y: number }; value: number }
      | null
    )[] = [];

    for (let y = 0; y < size; y += 1) {
      column.push(
        y === 0 && x < 2 ? { position: { x, y: 0 }, value } : null,
      );
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

describe('the controller publishes no charge-spending member', () => {
  it('exposes nothing that can spend a charge without an effect', () => {
    const { controller } = composeWithRelics();

    // A charge is a cost paid BY an effect. A member that took the cost on
    // request would take a budget away and apply nothing, and would announce a
    // success for it.
    expect(
      (controller as unknown as Record<string, unknown>).activateRelic,
    ).toBeUndefined();
    expect(
      (controller as unknown as Record<string, unknown>).consumeCharge,
    ).toBeUndefined();
    expect(
      (controller as unknown as Record<string, unknown>).spendCharge,
    ).toBeUndefined();
  });
});

describe('a charged relic held through the composed path', () => {
  it('spends exactly one charge on the turn its effect takes hold, and '
    + 'persists the budget that is left', () => {
    const { backing, controller, engine, registry } = composeWithRelics();

    controller.begin();
    controller.restoreHeldRelics();
    controller.recordRewardOffer([CHARGED_RELIC]);

    expect(controller.resolveReward(CHARGED_RELIC).accepted).toBe(true);
    expect(registry.find(CHARGED_RELIC)?.charges).toBe(CHARGED_BUDGET);

    // A board one move away from a merge, so the relic's trigger condition is
    // met by an ordinary turn rather than by a request.
    engine.setup(mergePairBoard(2));

    const rulesBefore = engine.config.merge.canMerge;

    engine.move(DIRECTION_LEFT);

    // THE EFFECT. `frostbind` records a merge predicate through the effect queue,
    // which src/engine/board-effects.ts applies to the LIVE rules, so the rule in
    // force is no longer the one the turn opened with.
    expect(engine.config.merge.canMerge).not.toBe(rulesBefore);

    // THE COST, paid once and by the effect.
    expect(registry.find(CHARGED_RELIC)?.charges).toBe(CHARGED_BUDGET - 1);

    // AND THE LEDGER REACHED STORAGE, through the commit the turn ended with.
    const stored = readStored(backing);

    expect(
      stored?.relics.find((relic): boolean => relic.id === CHARGED_RELIC)
        ?.charges,
    ).toBe(CHARGED_BUDGET - 1);
  });

  it('spends nothing on a turn whose trigger condition is not met', () => {
    const { backing, controller, engine, registry } = composeWithRelics();

    controller.begin();
    controller.restoreHeldRelics();
    controller.recordRewardOffer([CHARGED_RELIC]);

    expect(controller.resolveReward(CHARGED_RELIC).accepted).toBe(true);

    // Two tiles that cannot merge, so the turn moves and resolves nothing.
    engine.setup(boardWith(2));
    engine.move(DIRECTION_LEFT);
    engine.move(DIRECTION_DOWN);

    expect(registry.find(CHARGED_RELIC)?.charges).toBe(CHARGED_BUDGET);
    expect(
      readStored(backing)?.relics.find(
        (relic): boolean => relic.id === CHARGED_RELIC,
      )?.charges,
    ).toBe(CHARGED_BUDGET);
  });
});


/* ==========================================================================
 * 17. The reward transaction with a seeded draw port (wiring A)
 *
 * THE WIRING THE CONTROLLER AUTO-DRIVES, and the one src/main.ts composes: a
 * real `RelicRegistry` reached through `runPort()` AND a seeded draw port, so a
 * cleared stage draws its own offer and `selectReward()` closes it. Every case
 * below asserts the LIVE REGISTRY and the LIVE BUS as well as the returned
 * outcome, because a selection can report `'accepted'` while the registry holds
 * nothing and the next commit's projection erases the record.
 * ========================================================================== */

/** One composed run with a registry port and a seeded draw port. */
interface ComposedWithRewards extends ComposedWithRelics {
  /** Identifiers the bus is dispatching to, in pickup order. */
  readonly busSubscriberIds: () => readonly string[];

  /**
   * The ONE generator the engine's spawns, the reward draws and the persisted
   * cursors all come from, so a persisted cursor map can be compared with the
   * counts the run has actually reached.
   */
  readonly streams: () => RngStreams;
}

/**
 * Projects one catalogue relic as the reward card a screen presents.
 *
 * The one projection both port members use, so a drawn offer and a projected one
 * are the same object shape and a restored round cannot be told apart from the
 * round it restores.
 *
 * @param relic Catalogue declaration to project.
 * @returns The offer.
 */
function asOffer(relic: Relic): RewardOffer {
  return {
    id: relic.id,
    name: relic.name,
    rarity: relic.rarity,
    description: relic.description,
    hooks: Object.keys(relic.hooks),
    ...(relic.charges === undefined ? {} : { charges: relic.charges }),
  };
}

/**
 * Writes the merge-ready fixture as the RUN'S OWN ENVELOPE, so the board the
 * composition opens on arrives through `RunController.openEngineBoard()` and
 * the store's reconciliation rather than past them.
 *
 * Written only where nothing is stored, so a second composition over one
 * backing — which is what every reload case below is — adopts the envelope the
 * first run left instead of this fixture.
 *
 * @param manager Storage the envelope is written through.
 * @param config Rules the store measures the board against.
 * @param stages Ladder stage 0's goal is derived from.
 * @param seed Seed the envelope is written under, which is the seed
 *   `begin()` adopts it for.
 */
function seedRewardFixture(
  manager: LocalStorageManager,
  config: RulesConfig,
  stages: StageConfig,
  seed: string,
): void {
  const store = new RunStateStore({ storage: manager, config });

  if (store.exists()) {
    return;
  }

  store.save(
    createFreshRunState({
      runId: `${seed}-fixture`,
      seed,
      rngCursor: {},
      stageIndex: 0,
      stageGoal: stageGoalForIndex(0, stages),
      board: mergeReadyBoard(),
    }),
  );
}


/**
 * Composes storage, store, controller, registry, substreams and engine with a
 * seeded draw port bound, in the order src/main.ts uses: the hook bus first,
 * then the registry over it, then the controller, then `begin()`, then the ONE
 * generator built from the adopted cursors, then the engine over that same bus
 * and that same generator, and finally the board the controller opens.
 *
 * ONE GENERATOR, NOT TWO. The engine's spawns, the reward draws and the cursor
 * map `observe()` persists all read the same `RngStreams` instance, exactly as
 * src/main.ts wires them through its stream holder. A composition that gave the
 * engine a second instance persisted counts no draw had moved, so a stale
 * cursor map and a current one were indistinguishable.
 *
 * The registry is bound through `runPort()` rather than as the instance, which
 * is the route src/relics/relic-registry.ts documents as the one between the
 * two folders — and the route on which a selected relic used to be lost.
 */
function composeWithRewards(
  options: ComposeOptions = {},
): ComposedWithRewards {
  const backing = options.backing ?? new MemoryStorage();
  const manager = new LocalStorageManager({ storage: backing });
  const config = createDefaultRulesConfig();
  const stages = createDefaultStageConfig();
  const { reports, reporter } = createRecorder();
  const seed = options.seed ?? 'wiring-a';

  const issued: string[] = [];
  let next = 0;
  const createToken = (): string => {
    const token = options.tokens?.[next] ?? `token-${String(next)}`;

    next += 1;
    issued.push(token);

    return token;
  };

  if (options.setup !== false) {
    seedRewardFixture(manager, config, stages, seed);
  }

  const identity = resolveRunIdentity({
    storage: manager,
    createToken,
    seed: identitySeed(manager, seed),
  });

  // One bus, built before both its users: the registry seats relics on it and
  // the engine dispatches through it, which is why the root builds it first.
  const hooks = createHookBus({
    correlationId: runCorrelationId(identity.seed, identity.runId),
  });

  const registry = new RelicRegistry({
    bus: hooks,
    catalogue: RELIC_CATALOGUE,
  });

  let streams: RngStreams | null = null;

  const controller = new RunController({
    store: new RunStateStore({ storage: manager, config, reporter }),
    identity,
    config,
    stages,
    createToken,
    reporter,

    // The documented route between the two folders, not the instance.
    relics: registry.runPort(),

    rewards: {
      draw: ({ count, ownedIds }): readonly RewardOffer[] =>
        streams === null
          ? []
          : drawRelicOffers({
              pool: registry.catalogue(),
              ownedIds,
              count,
              streams,
            }).map(asOffer),

      // The load-path counterpart src/main.ts also supplies: a stored round is
      // rebuilt from the catalogue by identifier and TAKES NO DRAW, so a resumed
      // run presents the offer it was interrupted on with every cursor where the
      // envelope left it.
      project: (relicIds): readonly RewardOffer[] =>
        relicIds
          .map((relicId) =>
            registry
              .catalogue()
              .find((relic): boolean => relic.id === relicId),
          )
          .filter((relic): relic is Relic => relic !== undefined)
          .map(asOffer),
    },
  });

  // ADOPTED BEFORE THE GENERATOR IS BUILT, and before the engine exists: the
  // cursors the run resumes on come out of the envelope this reads, so a
  // generator built any earlier starts a resumed run at zero.
  controller.begin();

  const live = createRngStreams(controller.seed(), controller.cursors());

  streams = live;

  const engine = new Engine({
    config,
    stages,
    streams: live,
    storage: manager,
    hooks,
    stageContext: () => controller.stageContext(),
    relicContext: () => controller.relicContext(),
  });

  const stop = controller.observe(engine, () => live.snapshotCursors());

  if (options.setup !== false) {
    // The reconciled board of the adopted envelope, opened through the
    // controller — the same call src/main.ts makes.
    controller.openEngineBoard(engine);
  }

  return {
    backing,
    manager,
    config,
    stages,
    controller,
    engine,
    reports,
    tokens: issued,
    stop,
    registry,
    streams: (): RngStreams => live,
    busSubscriberIds: (): readonly string[] =>
      engine.hooks.subscribers().map((subscriber): string => subscriber.id),
  };
}

/**
 * A board whose first move LEFT merges 8 + 8 into 16, which is the first
 * ladder goal — so one move clears stage 0 and the reward round opens.
 */
function mergeReadyBoard(): SerializedGameState {
  const size = 4;
  const cells: ({ position: { x: number; y: number }; value: number } | null)[][] =
    [];

  for (let x = 0; x < size; x += 1) {
    const column: ({ position: { x: number; y: number }; value: number } | null)[] =
      [];

    for (let y = 0; y < size; y += 1) {
      column.push(
        y === 0 && x < 2 ? { position: { x, y }, value: 8 } : null,
      );
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

describe('a reward drawn by the run and taken through selectReward', () => {
  it('offers a reward and holds the stage until the card is pressed', () => {
    const { controller, engine } = composeWithRewards();

    engine.move(DIRECTION_LEFT);

    // The clear draws its own offer, and the stage waits on the player.
    expect(controller.isRewardPending()).toBe(true);
    expect(controller.currentOffer()).toHaveLength(3);
    expect(controller.stageIndex()).toBe(0);
  });

  it('takes the relic on LIVE, persists it, and advances once', () => {
    const { backing, controller, engine, registry, busSubscriberIds } =
      composeWithRewards();

    engine.move(DIRECTION_LEFT);

    const chosen = controller.currentOffer()[0];

    if (chosen === undefined) {
      throw new Error('a cleared stage offered no reward');
    }

    const selection = controller.selectReward(chosen.id, engine);

    expect(selection.outcome).toBe('accepted');

    // The live registry and the live bus, not only the returned outcome.
    expect(registry.ownedIds()).toEqual([chosen.id]);
    expect(busSubscriberIds()).toContain(chosen.id);
    expect(controller.relics().map((relic) => relic.id)).toEqual([chosen.id]);
    expect(readStored(backing)?.relics.map((relic) => relic.id)).toEqual([
      chosen.id,
    ]);

    expect(controller.stageIndex()).toBe(1);
    expect(readStored(backing)?.stageIndex).toBe(1);
    expect(controller.isRewardPending()).toBe(false);
  });

  it("keeps the relic firing for the rest of the run", () => {
    const { controller, engine, registry } = composeWithRewards();

    engine.move(DIRECTION_LEFT);

    const chosen = controller.currentOffer()[0];

    controller.selectReward(chosen?.id ?? '', engine);

    const invocationsOf = (id: string): number =>
      engine.hooks
        .metrics()
        .subscribers.find((subscriber) => subscriber.id === id)?.invoked ?? 0;

    const before = invocationsOf(chosen?.id ?? '');

    play(engine, MOVES);

    // Its own handlers ran, on the moves that followed the pickup — which is
    // AAP user key flow 1.
    expect(registry.ownedIds()).toEqual([chosen?.id]);
    expect(invocationsOf(chosen?.id ?? '')).toBeGreaterThan(before);
    expect(engine.hooks.degraded()).toEqual([]);
  });

  it('takes the relic on and advances through completeReward too', () => {
    const { backing, controller, engine, registry, busSubscriberIds } =
      composeWithRewards({ seed: 'wiring-a-complete' });

    engine.move(DIRECTION_LEFT);

    const chosen = controller.currentOffer()[0];

    if (chosen === undefined) {
      throw new Error('a cleared stage offered no reward');
    }

    const resolution = controller.completeReward(engine, chosen.id);

    // Both halves, on the other public method as well: neither may keep the
    // relic without advancing nor advance without keeping the relic.
    expect(resolution.accepted).toBe(true);
    expect(registry.ownedIds()).toEqual([chosen.id]);
    expect(busSubscriberIds()).toContain(chosen.id);
    expect(readStored(backing)?.relics.map((relic) => relic.id)).toEqual([
      chosen.id,
    ]);
    expect(controller.stageIndex()).toBe(1);
    expect(controller.isRewardPending()).toBe(false);
  });

  it('dispatches onStageStart exactly once per stage entered', () => {
    const { controller, engine } = composeWithRewards({
      seed: 'wiring-a-stage-start',
    });

    const dispatched: number[] = [];

    engine.hooks.register({
      id: 'stage-counter',
      hooks: {
        onStageStart: (payload) => {
          dispatched.push(payload.stageIndex);

          return payload;
        },
      },
    });

    engine.move(DIRECTION_LEFT);
    controller.selectReward(controller.currentOffer()[0]?.id ?? '', engine);

    // One entry for the stage the selection opened, and no repeat of it: a
    // stage opened twice applied every per-stage relic effect twice.
    expect(dispatched).toEqual([1]);
  });

  it('never offers a relic the run already holds', () => {
    const { controller, engine, registry } = composeWithRewards({
      seed: 'wiring-a-pool',
    });

    const taken: string[] = [];
    const directions: readonly Direction[] = [
      DIRECTION_UP,
      DIRECTION_RIGHT,
      DIRECTION_DOWN,
      DIRECTION_LEFT,
    ];

    engine.move(DIRECTION_LEFT);

    for (let move = 0; move < 40 && !engine.serialize().over; move += 1) {
      if (controller.isRewardPending()) {
        const offer = controller.currentOffer();

        for (const card of offer) {
          expect(taken).not.toContain(card.id);
        }

        // No duplicate inside one set of three, either (AAP V6).
        expect(new Set(offer.map((card) => card.id)).size).toBe(offer.length);

        const chosen = offer[0];

        if (chosen !== undefined) {
          controller.selectReward(chosen.id, engine);
          taken.push(chosen.id);
        }
      }

      engine.move(directions[move % 4]);
    }

    expect(taken.length).toBeGreaterThan(0);
    expect(registry.ownedIds()).toEqual(taken);
  });
});

/* ==========================================================================
 * 17a2. The stage domain the run advances through IS the stage domain the
 * envelope carries
 *
 * The contract asserted here: a reward round resolved on a HIGH stage advances,
 * writes and reloads. `MAX_PERSISTED_STAGE_INDEX` of src/run/run-state.ts was a
 * fixed 1024 while `advanceStage()` had no matching limit, so the one transaction
 * that crosses 1024 wrote an envelope the store refused, rolled the round back and
 * left the offer standing with the run unable to progress. The crossing is driven
 * through the production path — the clear, the draw, the selection, the write and
 * a full rebuild over the same storage — rather than asserted on the bound.
 * Decisions DL-RUN-07, DL-STAGE-05, DL-RUNCTL-29.
 * ========================================================================== */

describe('a reward round resolved on the stage the old bound refused', () => {
  /** Stage index the fixed bound accepted, and the last one it accepted. */
  const AT_OLD_BOUND = 1024;

  /** The first index the fixed bound refused, which a clear now reaches. */
  const PAST_OLD_BOUND = AT_OLD_BOUND + 1;

  /**
   * A goal a merge-ready board clears, so the crossing does not depend on the
   * saturated target the curve derives this far along its extension.
   */
  const CLEARABLE_GOAL: StageGoal = { kind: 'highest-tile', target: 16 };

  /**
   * Seeds an envelope sitting on `AT_OLD_BOUND` with a clearable goal, then
   * composes the reward-ready stack over it.
   *
   * @param seed Run seed, so two calls can share one storage.
   * @param backing Storage the envelope is written to.
   * @returns The composed stack.
   */
  const composeAtBound = (
    seed: string,
    backing: MemoryStorage,
  ): ReturnType<typeof composeWithRewards> => {
    const manager = new LocalStorageManager({ storage: backing });
    const store = new RunStateStore({
      storage: manager,
      config: createDefaultRulesConfig(),
    });

    if (!store.exists()) {
      store.save({
        ...createFreshRunState({
          runId: `${seed}-fixture`,
          seed,
          rngCursor: {},
          stageIndex: AT_OLD_BOUND,
          stageGoal: CLEARABLE_GOAL,
          board: mergeReadyBoard(),
        }),
      });
    }

    // `setup` is left ON: `seedRewardFixture` returns early because the envelope
    // above already exists, and the same flag is what opens the engine's board.
    return composeWithRewards({ backing, seed });
  };

  it('accepts the selection, advances past the old bound and stores it', () => {
    const backing = new MemoryStorage();
    const { controller, engine, registry } = composeAtBound(
      'stage-domain-cross',
      backing,
    );

    expect(controller.stageIndex()).toBe(AT_OLD_BOUND);

    engine.move(DIRECTION_LEFT);

    expect(controller.isRewardPending()).toBe(true);

    const chosen = controller.currentOffer()[0];

    if (chosen === undefined) {
      throw new Error('a cleared stage offered no reward');
    }

    const selection = controller.selectReward(chosen.id, engine);

    // The transaction COMMITTED. It used to answer 'refused' here, because the
    // write that is part of it carried a stage index the store rejected.
    expect(selection.outcome).toBe('accepted');
    expect(controller.stageIndex()).toBe(PAST_OLD_BOUND);
    expect(controller.isRewardPending()).toBe(false);
    expect(registry.ownedIds()).toEqual([chosen.id]);

    // The envelope reached storage carrying the crossed index, so the run is
    // saved rather than played from memory alone.
    const stored = readStored(backing);

    expect(stored?.stageIndex).toBe(PAST_OLD_BOUND);
    expect(stored?.relics.map((relic) => relic.id)).toEqual([chosen.id]);
    expect(describeRunStateProblems(stored)).toEqual([]);
  });

  it('reloads the crossed stage rather than falling back to a fresh run', () => {
    const backing = new MemoryStorage();
    const first = composeAtBound('stage-domain-reload', backing);

    first.engine.move(DIRECTION_LEFT);

    const chosen = first.controller.currentOffer()[0];

    if (chosen === undefined) {
      throw new Error('a cleared stage offered no reward');
    }

    expect(first.controller.selectReward(chosen.id, first.engine).outcome).toBe(
      'accepted',
    );

    first.stop();

    // Everything thrown away and rebuilt over the same storage, which is the
    // half of the domain contract a bound-only assertion cannot reach.
    const resumed = composeAtBound('stage-domain-reload', backing);

    expect(resumed.controller.stageIndex()).toBe(PAST_OLD_BOUND);
    expect(resumed.controller.relics().map((relic) => relic.id)).toEqual([
      chosen.id,
    ]);
    expect(resumed.controller.hadStoredEnvelope()).toBe(true);
  });

  // The far end of the same alignment: the domain is total below its ceiling and
  // the advance stops AT it, so the runtime cannot produce an index the envelope
  // would refuse — the class of failure the fixed bound created, closed at every
  // value rather than at one.
  it('advances no further than the domain the stage curve publishes', () => {
    const backing = new MemoryStorage();
    const seed = 'stage-domain-ceiling';
    const manager = new LocalStorageManager({ storage: backing });
    const store = new RunStateStore({
      storage: manager,
      config: createDefaultRulesConfig(),
    });

    store.save(
      createFreshRunState({
        runId: `${seed}-fixture`,
        seed,
        rngCursor: {},
        stageIndex: MAX_STAGE_INDEX,
        stageGoal: CLEARABLE_GOAL,
        board: mergeReadyBoard(),
      }),
    );

    const { controller, stop } = composeWithRewards({ backing, seed });

    // The ceiling loads: it is inside the domain, so the envelope is adopted.
    expect(controller.stageIndex()).toBe(MAX_STAGE_INDEX);

    const goal = controller.advanceStage();

    // And the advance stands down rather than producing MAX_SAFE_INTEGER + 1.
    expect(controller.stageIndex()).toBe(MAX_STAGE_INDEX);
    expect(goal).toEqual(CLEARABLE_GOAL);
    expect(isStageIndex(controller.stageIndex())).toBe(true);
    expect(describeRunStateProblems(controller.state())).toEqual([]);

    stop();
  });
});

/* ==========================================================================
 * 17b. The reward selection is a transaction, and the write is part of it
 *
 * The contract asserted here: `selectReward()` brings the envelope fully up to
 * date and writes it BEFORE reporting acceptance, and a refused write rolls back
 * the registry append, the envelope's relic list, the round and the stage, and
 * answers `'refused'`. The refusal is injected at the storage boundary, so it
 * travels the production path. Decision DL-RUNCTL-15.
 * ========================================================================== */

describe('a reward selection whose write is refused', () => {
  /**
   * Composes a reward-ready run and then makes every later write fail.
   *
   * The failure is injected at the STORAGE boundary rather than by faking the
   * store, so the refusal travels the production path: `setItem` raises as it
   * does on an exhausted quota, `LocalStorageManager` absorbs and reports it,
   * `RunStateStore.save()` answers `false`, and `write()` returns that.
   */
  function composeWithFullStorage(): ComposedWithRewards {
    const backing = new MemoryStorage();
    const composed = composeWithRewards({ backing, seed: 'write-refused' });

    composed.engine.move(DIRECTION_LEFT);

    backing.setItem = (): void => {
      throw new Error('QuotaExceededError');
    };

    return composed;
  }

  it('refuses the selection rather than reporting a phantom acquisition', () => {
    const { controller, engine } = composeWithFullStorage();
    const chosen = controller.currentOffer()[0]?.id ?? '';

    const selection = controller.selectReward(chosen, engine);

    expect(selection.outcome).toBe('refused');
    expect(selection.relicId).toBe(chosen);
  });

  it('puts the relic back, in the registry and in the envelope', () => {
    const { controller, engine, registry } = composeWithFullStorage();
    const chosen = controller.currentOffer()[0]?.id ?? '';

    controller.selectReward(chosen, engine);

    // NOTHING HELD, on either side of the port. A relic left registered on the
    // bus would go on firing for a run that does not record it.
    expect(controller.relics()).toEqual([]);
    expect(registry.ownedIds()).toEqual([]);
    expect(controller.state().relics).toEqual([]);
  });

  it('leaves the stage where it stood and the offer usable', () => {
    const { controller, engine } = composeWithFullStorage();
    const offered = controller.currentOffer().map((card): string => card.id);

    controller.selectReward(offered[0] ?? '', engine);

    // THE ROUND IS STILL OPEN: the stage did not advance, the same three cards
    // are still on the table, and the round is not recorded as resolved — so the
    // player can free some storage and choose again rather than losing the reward.
    expect(controller.stageIndex()).toBe(0);
    expect(controller.isRewardPending()).toBe(true);
    expect(controller.currentOffer().map((card): string => card.id)).toEqual(
      offered,
    );
  });

  it('accepts the retry once the write can succeed again', () => {
    const backing = new MemoryStorage();
    const composed = composeWithRewards({ backing, seed: 'write-retry' });

    composed.engine.move(DIRECTION_LEFT);

    const chosen = composed.controller.currentOffer()[0]?.id ?? '';
    const working = backing.setItem.bind(backing);

    backing.setItem = (): void => {
      throw new Error('QuotaExceededError');
    };

    expect(
      composed.controller.selectReward(chosen, composed.engine).outcome,
    ).toBe('refused');

    backing.setItem = working;

    // The rollback left a run a retry can complete, which is the whole point of
    // rolling back rather than half-committing.
    const retry = composed.controller.selectReward(chosen, composed.engine);

    expect(retry.outcome).toBe('accepted');
    expect(composed.registry.ownedIds()).toEqual([chosen]);
    expect(readStored(backing)?.relics.map((relic) => relic.id)).toEqual([
      chosen,
    ]);

    composed.stop();
  });
});

/* ==========================================================================
 * 18. An unresolved reward round survives a reload
 *
 * A DRAWN OFFER WAS PURELY IN MEMORY. The stage that drew it was recorded as
 * cleared nowhere, so a reload found a run whose goal is still met — a cleared
 * stage's goal stays met on every later commit — and resolved the same stage a
 * second time: a second `stage:end`, a second `onStageEnd` for every relic bound
 * to it, and a second offer drawn from cursors the first draw had already moved.
 * The player lost the three cards they were looking at and the run lost its
 * same-seed-same-offers guarantee in one step.
 *
 * The round is now persisted as identifiers plus the stage it belongs to, which
 * is also the marker saying that stage's end is resolved. These cases pin both
 * halves: the round comes back, and it comes back WITHOUT a draw.
 * ========================================================================== */

describe('an unresolved reward round', () => {
  it('is persisted with the stage that drew it', () => {
    const { controller, engine, backing } = composeWithRewards({
      seed: 'pending-persist',
    });

    engine.move(DIRECTION_LEFT);

    const offer = controller.currentOffer();

    expect(offer.length).toBeGreaterThan(0);
    expect(controller.isRewardPending()).toBe(true);

    const stored = readStored(backing);

    // IDENTIFIERS ALONE, and the stage index alongside them. No name,
    // description or hook list is duplicated into storage, because the catalogue
    // is the only place those are declared and it can move under a stored copy.
    expect(stored?.pendingReward?.stageIndex).toBe(0);
    expect(stored?.pendingReward?.offeredRelicIds).toEqual(
      offer.map((card): string => card.id),
    );
  });

  it('is persisted beside the cursors the draw itself reached', () => {
    const { engine, backing, streams } = composeWithRewards({
      seed: 'pending-cursors',
    });

    engine.move(DIRECTION_LEFT);

    // THE LIVE GENERATOR, NOT THE ENVELOPE READ BACK. The draw that produced
    // the round on screen consumed `relic-draw` and `rarity-weight`, so an
    // envelope whose counts do not reach the live ones is an envelope a reload
    // rebuilds the substreams behind — and the spent draws come out a second
    // time. DL-RUNCTL-19.
    const live = streams().snapshotCursors();
    const persisted = readStored(backing)?.rngCursor;

    expect(persisted).toEqual(live);

    for (const name of RNG_STREAM_NAMES) {
      expect(persisted?.[name]).toBe(live[name]);
    }

    // And the two reward substreams actually moved, so the equality above is
    // not two zero maps agreeing.
    expect(live['relic-draw']).toBeGreaterThan(0);
    expect(live['rarity-weight']).toBeGreaterThan(0);
  });

  it('is cleared from storage once a card is taken', () => {
    const { controller, engine, backing } = composeWithRewards({
      seed: 'pending-clear',
    });

    engine.move(DIRECTION_LEFT);

    const chosen = controller.currentOffer()[0]?.id ?? '';

    expect(controller.selectReward(chosen, engine).outcome).toBe('accepted');

    // Resolved is not pending: the marker is gone, so the next load resolves the
    // stage the selection advanced into rather than re-opening this round.
    expect(readStored(backing)?.pendingReward).toBeUndefined();
    expect(controller.isRewardPending()).toBe(false);
  });

  it('comes back on the reload, as the same three cards', () => {
    const backing = new MemoryStorage();
    const first = composeWithRewards({ backing, seed: 'pending-reload' });

    first.engine.move(DIRECTION_LEFT);

    const offered = first.controller.currentOffer().map((card): string => card.id);

    // READ OFF THE LIVE GENERATOR. `controller.cursors()` reports the envelope's
    // own copy, so comparing it with the envelope after a reload compares one
    // stored value with itself and passes whether or not the draw was recorded.
    const cursorsBefore = first.streams().snapshotCursors();

    expect(offered.length).toBeGreaterThan(0);
    expect(readStored(backing)?.rngCursor).toEqual(cursorsBefore);

    first.stop();

    // THE RELOAD. A second composition over the same storage, which is what a
    // page reload is: a new controller, a new registry and a new engine reading
    // the envelope the first one left.
    const second = composeWithRewards({ backing, seed: 'pending-reload' });

    expect(second.controller.isRewardPending()).toBe(true);
    expect(
      second.controller.currentOffer().map((card): string => card.id),
    ).toEqual(offered);

    // PROJECTED, NOT REDRAWN. Every substream cursor is where the interrupted
    // run left it, so the reward the player is now looking at cost the run
    // nothing to restore and the seed still determines the offer sequence
    // (AAP V2, Contract 6).
    expect(second.controller.cursors()).toEqual(cursorsBefore);

    // And the restored round is a LIVE round: the card can be taken.
    const chosen = offered[0] ?? '';

    expect(second.controller.selectReward(chosen, second.engine).outcome).toBe(
      'accepted',
    );
    expect(second.registry.ownedIds()).toEqual([chosen]);

    second.stop();
  });

  it('carries the full card back, not just the identifier', () => {
    const backing = new MemoryStorage();
    const first = composeWithRewards({ backing, seed: 'pending-cards' });

    first.engine.move(DIRECTION_LEFT);

    const before = first.controller.currentOffer();

    first.stop();

    const second = composeWithRewards({ backing, seed: 'pending-cards' });
    const after = second.controller.currentOffer();

    // The screen needs a name, a rarity, a description and the hook badges, and
    // the projection resolves all four from the catalogue.
    expect(after).toEqual(before);

    for (const card of after) {
      expect(card.name).not.toBe('');
      expect(card.hooks.length).toBeGreaterThan(0);
    }

    second.stop();
  });

  it('resolves the cleared stage only once across the reload', () => {
    const backing = new MemoryStorage();
    const first = composeWithRewards({ backing, seed: 'pending-once' });

    first.engine.move(DIRECTION_LEFT);

    const offered = first.controller
      .currentOffer()
      .map((card): string => card.id);

    expect(first.controller.isRewardPending()).toBe(true);

    first.stop();

    const second = composeWithRewards({ backing, seed: 'pending-once' });

    expect(second.controller.isRewardPending()).toBe(true);
    expect(second.controller.stageIndex()).toBe(0);

    // A MOVE MADE WHILE THE CHOICE IS STANDING, which is the case that used to
    // resolve the same stage over and over: the goal a cleared stage met is still
    // met on this commit and on every later one, so the standing round is the
    // only thing that says its end is already resolved.
    second.engine.move(DIRECTION_LEFT);

    // No second resolution: no advance, no second offer drawn, and the same three
    // cards still standing.
    expect(second.reports.advanced).toEqual([]);
    expect(second.controller.stageIndex()).toBe(0);
    expect(
      second.controller.currentOffer().map((card): string => card.id),
    ).toEqual(offered);

    second.stop();
  });

  it('drops a round whose stage the run has since moved past', () => {
    const backing = new MemoryStorage();
    const first = composeWithRewards({ backing, seed: 'pending-stale' });

    first.engine.move(DIRECTION_LEFT);

    const offered = first.controller
      .currentOffer()
      .map((card): string => card.id);

    // A STALE MARKER, written by hand because no production path can produce
    // one: the envelope names stage 0's round while the run stands on stage 1.
    first.controller.advanceStage();
    first.controller.persist(first.engine, () => first.controller.cursors());
    first.stop();

    const stored = readStored(backing);

    expect(stored).not.toBeNull();

    backing.setItem(
      RUN_STATE_KEY,
      JSON.stringify({
        ...stored,
        stageIndex: 1,
        pendingReward: { stageIndex: 0, offeredRelicIds: offered },
      }),
    );

    const second = composeWithRewards({ backing, seed: 'pending-stale' });

    // Dropped rather than trusted, and dropped FROM STORAGE too, so it cannot
    // sit there suppressing stage resolution for the rest of the run.
    expect(second.controller.isRewardPending()).toBe(false);
    expect(second.controller.currentOffer()).toEqual([]);
    expect(readStored(second.backing)?.pendingReward).toBeUndefined();

    second.stop();
  });

  it('drops a round naming a relic the catalogue no longer declares', () => {
    const backing = new MemoryStorage();
    const first = composeWithRewards({ backing, seed: 'pending-unknown' });

    first.engine.move(DIRECTION_LEFT);
    first.controller.persist(first.engine, () => first.controller.cursors());
    first.stop();

    const stored = readStored(backing);

    backing.setItem(
      RUN_STATE_KEY,
      JSON.stringify({
        ...stored,
        pendingReward: {
          stageIndex: 0,
          offeredRelicIds: ['no-such-relic'],
        },
      }),
    );

    // The projection resolves nothing, so the stored round is dropped and the
    // load completes rather than raising on a catalogue that has moved. The
    // board the envelope carries still meets stage 0's goal, so the run
    // resolves that stage again and draws a round of its own — and every card
    // in it is a relic the catalogue declares.
    const second = composeWithRewards({ backing, seed: 'pending-unknown' });
    const offeredNow = second.controller
      .currentOffer()
      .map((card): string => card.id);

    expect(offeredNow).not.toContain('no-such-relic');
    expect(
      readStored(second.backing)?.pendingReward?.offeredRelicIds ?? [],
    ).not.toContain('no-such-relic');

    second.stop();
  });

  it('restores nothing when the composition supplies no projector', () => {
    const backing = new MemoryStorage();
    const first = composeWithRewards({ backing, seed: 'pending-no-port' });

    first.engine.move(DIRECTION_LEFT);
    first.stop();

    expect(readStored(backing)?.pendingReward).toBeDefined();

    // `compose()` binds neither a registry port nor a draw port, so its rewards
    // port has no `project`: the round is dropped and the run resolves its stage
    // as if the offer had never been drawn. An optional member, honoured as one.
    const second = compose({ backing, seed: 'pending-no-port' });

    expect(second.controller.isRewardPending()).toBe(false);
    expect(second.controller.currentOffer()).toEqual([]);
    expect(readStored(second.backing)?.pendingReward).toBeUndefined();

    second.stop();
  });
});

/* ==========================================================================
 * 19. The reward outcome codes mean what they say
 * ========================================================================== */

describe('the reward selection outcome codes', () => {
  it('reports already-resolved for a second press of the same card', () => {
    const { controller, engine, registry } = composeWithRewards({
      seed: 'outcome-codes',
    });

    engine.move(DIRECTION_LEFT);

    const offer = controller.currentOffer();

    expect(controller.selectReward(offer[0]?.id ?? '', engine).outcome).toBe(
      'accepted',
    );

    // A DOUBLE-CLICKED CARD. The accepted selection cleared the offer, so this
    // is the state the code exists to describe — and it reported `'no-offer'`
    // while an offer recorded and never drawn reported `'already-resolved'`.
    expect(controller.selectReward(offer[0]?.id ?? '', engine).outcome).toBe(
      'already-resolved',
    );
    expect(controller.selectReward(offer[1]?.id ?? '', engine).outcome).toBe(
      'already-resolved',
    );

    // And neither took a second relic nor advanced a second stage.
    expect(registry.ownedIds()).toHaveLength(1);
    expect(controller.stageIndex()).toBe(1);
  });

  it('reports no-offer while no round has been resolved', () => {
    const { controller } = composeWithRewards({ seed: 'outcome-no-offer' });

    expect(controller.selectReward(FIRST_RELIC).outcome).toBe('no-offer');
  });

  it('reports no-offer for an offer recorded but never drawn', () => {
    const { controller } = composeWithRelics();

    controller.recordRewardOffer([FIRST_RELIC]);

    // Nothing was resolved, so nothing is `'already-resolved'`; no offer
    // object stands, so a selection has nothing to be made from.
    expect(controller.selectReward(FIRST_RELIC).outcome).toBe('no-offer');
  });

  it('reports not-offered for a card that was never in the offer', () => {
    const { controller, engine } = composeWithRewards({
      seed: 'outcome-not-offered',
    });

    engine.move(DIRECTION_LEFT);

    const offered = controller.currentOffer().map((card) => card.id);
    const unoffered = RELIC_CATALOGUE.map((relic) => relic.id).find(
      (id) => !offered.includes(id),
    );

    expect(controller.selectReward(unoffered ?? '', engine).outcome).toBe(
      'not-offered',
    );

    // The offer is retained, so the screen can be re-presented.
    expect(controller.isRewardPending()).toBe(true);
    expect(controller.stageIndex()).toBe(0);
  });

  it('reports already-resolved after a resolution recorded by resolveReward', () => {
    const { controller } = composeWithRelics();

    controller.recordRewardOffer([FIRST_RELIC]);

    expect(controller.resolveReward(FIRST_RELIC).accepted).toBe(true);

    // The round WAS resolved, through the other public method.
    expect(controller.selectReward(FIRST_RELIC).outcome).toBe(
      'already-resolved',
    );
  });
});

/* ==========================================================================
 * 18a. Every reward outcome is REPORTED, completely and unmangled
 * ========================================================================== */

/**
 * WHAT WAS WRONG
 *   `selectReward()` and `refuseSelection()` each assembled an `onRewardDrawn`
 *   payload of their own instead of going through `reportReward`. Both omitted
 *   the declared `accepted` member — which was optional, so the payloads
 *   type-checked — the refusal path encoded the outcome INTO the identifier as
 *   `` `${relicId} (${outcome})` `` and left `refusal` absent, and the accepted
 *   path read `current.stageIndex` after `closeRewardRound()` had already
 *   advanced the stage, so every accepted report named the stage the run had
 *   moved ON TO rather than the stage the offer was made at.
 *
 * WHAT THIS SUITE PINS
 *   The report, not the return value. Section 18 above asserts
 *   `RewardSelection.outcome` and could not see any of the four defects; these
 *   cases read `RunReporter.onRewardDrawn` directly and assert the offer stage,
 *   the raw identifier, `accepted` and `refusal` for every outcome the two
 *   public methods produce — accepted, no-offer, already-resolved, not-offered,
 *   unknown-relic and refused — and for a refused OFFER.
 */
/**
 * Composes a controller whose draw port always offers `FIRST_RELIC` and whose
 * relic port is stubbed, so the two gates a real registry never fails —
 * `'unknown-relic'` and `'refused'` — are reachable.
 *
 * @param stub The pickup and the holding answer to give.
 * @returns The controller and the reports it made.
 */
function composeWithStubbedPickup(stub: {
  readonly pickUp: (relicId: string) => PersistedRelic | null;
  readonly holds?: (relicId: string) => boolean;
}): { controller: RunController; reports: RecordedReports } {
  const manager = new LocalStorageManager({ storage: new MemoryStorage() });
  const config = createDefaultRulesConfig();
  const { reports, reporter } = createRecorder();
  const controller = new RunController({
    store: new RunStateStore({ storage: manager, config, reporter }),
    identity: resolveRunIdentity({ storage: manager, seed: 'stubbed-pickup' }),
    config,
    stages: createDefaultStageConfig(),
    reporter,
    relics: {
      knowsRelic: (): boolean => true,
      pickUpRelic: stub.pickUp,
      holdsRelic: stub.holds ?? ((): boolean => true),
      ownedRelicIds: (): readonly string[] => [],
    },
    rewards: {
      draw: (): readonly RewardOffer[] => [
        {
          id: FIRST_RELIC,
          name: 'First',
          rarity: 'common',
          description: 'The catalogue head.',
          hooks: [],
        },
      ],
    },
  });

  controller.begin();

  return { controller, reports };
}

describe('the reward outcome reports', () => {
  it('reports an accepted selection at the OFFER stage, with accepted true', () => {
    const { controller, engine, reports } = composeWithRewards({
      seed: 'reward-report-accepted',
    });

    engine.move(DIRECTION_LEFT);

    const offered = controller.currentOffer().map((card) => card.id);
    const chosen = offered[0] ?? '';
    const offerStage = controller.stageIndex();

    expect(offered).toHaveLength(3);
    expect(controller.selectReward(chosen, engine).outcome).toBe('accepted');

    // The stage ADVANCED, so a report reading `current.stageIndex` would name
    // the stage after the offer rather than the offer's own.
    expect(controller.stageIndex()).toBe(offerStage + 1);

    const drawn = reports.drawn.at(-1);

    expect(drawn).toEqual({
      stageIndex: offerStage,
      offeredRelicIds: offered,
      selectedRelicId: chosen,
      accepted: true,
      refusal: undefined,
    });

    // And the offer report it answers named the same stage and the same set.
    expect(reports.offered.at(-1)).toEqual({
      stageIndex: offerStage,
      offeredRelicIds: offered,
    });
  });

  it('reports a no-offer refusal with the raw identifier and the refusal', () => {
    const { controller, reports } = composeWithRewards({
      seed: 'reward-report-no-offer',
    });

    expect(controller.selectReward(FIRST_RELIC).outcome).toBe('no-offer');
    expect(reports.drawn).toEqual([
      {
        stageIndex: 0,
        offeredRelicIds: [],
        selectedRelicId: FIRST_RELIC,
        accepted: false,
        refusal: 'no-offer',
      },
    ]);
  });

  it('reports an already-resolved refusal against the round it resolved', () => {
    const { controller, engine, reports } = composeWithRewards({
      seed: 'reward-report-resolved',
    });

    engine.move(DIRECTION_LEFT);

    const offered = controller.currentOffer().map((card) => card.id);
    const chosen = offered[0] ?? '';
    const offerStage = controller.stageIndex();

    controller.selectReward(chosen, engine);

    // The DOUBLE-CLICKED CARD. The round it names is the one at `offerStage`,
    // not the stage the accepted selection advanced the run to.
    expect(controller.selectReward(chosen, engine).outcome).toBe(
      'already-resolved',
    );

    expect(reports.drawn.at(-1)).toEqual({
      stageIndex: offerStage,
      offeredRelicIds: [],
      selectedRelicId: chosen,
      accepted: false,
      refusal: 'already-resolved',
    });
  });

  it('reports a not-offered refusal with the identifier that was pressed', () => {
    const { controller, engine, reports } = composeWithRewards({
      seed: 'reward-report-not-offered',
    });

    engine.move(DIRECTION_LEFT);

    const offered = controller.currentOffer().map((card) => card.id);
    const unoffered =
      RELIC_CATALOGUE.map((relic) => relic.id).find(
        (id) => !offered.includes(id),
      ) ?? '';

    expect(controller.selectReward(unoffered, engine).outcome).toBe(
      'not-offered',
    );

    // The offer is retained, so the report names the standing offer AND the
    // identifier that was refused — the two are different, which is the whole
    // point of carrying the identifier verbatim.
    expect(reports.drawn.at(-1)).toEqual({
      stageIndex: controller.stageIndex(),
      offeredRelicIds: offered,
      selectedRelicId: unoffered,
      accepted: false,
      refusal: 'not-offered',
    });
  });

  it('reports an unknown-relic refusal when the registry refuses the pickup', () => {
    const { controller, reports } = composeWithStubbedPickup({
      pickUp: (): null => null,
    });

    // A DRAWN offer, which is what `selectReward()` validates against, and it
    // reaches the pickup gate on a port that refuses to register.
    expect(controller.offerReward()).toHaveLength(1);
    expect(controller.selectReward(FIRST_RELIC).outcome).toBe('unknown-relic');
    expect(reports.drawn.at(-1)).toEqual({
      stageIndex: 0,
      offeredRelicIds: [FIRST_RELIC],
      selectedRelicId: FIRST_RELIC,
      accepted: false,
      refusal: 'unknown-relic',
    });
  });

  it('reports a refused selection when the live registry disagrees', () => {
    const { controller, reports } = composeWithStubbedPickup({
      // Registered, and then not held: the append is WITHDRAWN and the
      // selection is refused as `'refused'`.
      pickUp: (relicId: string): PersistedRelic => ({ id: relicId }),
      holds: (): boolean => false,
    });

    expect(controller.offerReward()).toHaveLength(1);
    expect(controller.selectReward(FIRST_RELIC).outcome).toBe('refused');
    expect(reports.drawn.at(-1)).toEqual({
      stageIndex: 0,
      offeredRelicIds: [FIRST_RELIC],
      selectedRelicId: FIRST_RELIC,
      accepted: false,
      refusal: 'refused',
    });
  });

  it('reports a refused OFFER with no identifier at all', () => {
    const { controller, reports } = composeWithRelics();

    // An offer the admission gate refuses: an identifier the catalogue does
    // not carry. Nothing was selected, so nothing is named.
    expect(controller.recordRewardOffer(['no-such-relic'])).toBe(false);
    expect(reports.drawn).toEqual([
      {
        stageIndex: 0,
        offeredRelicIds: [],
        selectedRelicId: undefined,
        accepted: false,
        refusal: 'offer',
      },
    ]);
  });

  it('reports every resolveReward outcome at the offer stage', () => {
    const { controller, reports } = composeWithRelics();

    controller.recordRewardOffer([FIRST_RELIC]);

    // Accepted through the other public method, which closes the same round.
    expect(controller.resolveReward(FIRST_RELIC).accepted).toBe(true);
    expect(reports.drawn.at(-1)).toEqual({
      stageIndex: 0,
      offeredRelicIds: [FIRST_RELIC],
      selectedRelicId: FIRST_RELIC,
      accepted: true,
      refusal: undefined,
    });

    // And a second resolution is refused in `resolveReward`'s OWN vocabulary
    // rather than a selection outcome: the accepted resolution cleared the
    // offered identifiers, so the first of the four gates answers first.
    expect(controller.resolveReward(FIRST_RELIC).refusal).toBe('not-offered');
    expect(reports.drawn.at(-1)).toEqual({
      stageIndex: 0,
      offeredRelicIds: [],
      selectedRelicId: FIRST_RELIC,
      accepted: false,
      refusal: 'not-offered',
    });
  });

  it('reports the held gate in resolveReward vocabulary', () => {
    const { controller, reports } = composeWithRelics();

    controller.recordRewardOffer([FIRST_RELIC]);

    expect(controller.resolveReward(FIRST_RELIC).accepted).toBe(true);

    // The relic is HELD, and it is offered again, so the gate that answers is
    // the held one — a refusal name `RewardSelectionOutcome` does not carry,
    // which is why the report's `refusal` is typed over both vocabularies.
    controller.recordRewardOffer([FIRST_RELIC]);

    expect(controller.resolveReward(FIRST_RELIC).refusal).toBe('held');
    expect(reports.drawn.at(-1)).toEqual({
      stageIndex: 0,
      offeredRelicIds: [FIRST_RELIC],
      selectedRelicId: FIRST_RELIC,
      accepted: false,
      refusal: 'held',
    });
  });

  it('never decorates the reported identifier with the outcome', () => {
    const { controller, engine, reports } = composeWithRewards({
      seed: 'reward-report-verbatim',
    });

    engine.move(DIRECTION_LEFT);

    const offered = controller.currentOffer().map((card) => card.id);

    controller.selectReward('not-in-the-offer', engine);
    controller.selectReward(offered[0] ?? '', engine);
    controller.selectReward(offered[0] ?? '', engine);

    for (const report of reports.drawn) {
      const identifier = report.selectedRelicId ?? '';

      expect(identifier).not.toContain('(');
      expect(identifier).not.toContain(' ');
    }

    // Three reports, and every one carries `accepted` as a boolean.
    expect(reports.drawn).toHaveLength(3);

    for (const report of reports.drawn) {
      expect(typeof report.accepted).toBe('boolean');
    }
  });
});

/* ==========================================================================
 * 19. The registry's run port satisfies the consumer
 * ========================================================================== */

describe('the registry run port', () => {
  it('publishes an activation member the reward transaction can reach', () => {
    const { registry } = composeWithRelics();
    const port = registry.runPort();

    // Both spellings. The consumer accepts either, and a port publishing
    // neither records a reward it never registers.
    expect(port.pickUpRelic).toBeTypeOf('function');
    expect(port.activateRelic).toBeTypeOf('function');
  });

  it('registers the relic through activateRelic as pickUpRelic does', () => {
    const { engine, registry } = composeWithRelics();
    const port = registry.runPort();

    const entry = port.activateRelic(SECOND_RELIC);

    expect(entry?.id).toBe(SECOND_RELIC);
    expect(registry.has(SECOND_RELIC)).toBe(true);
    expect(
      engine.hooks.subscribers().map((subscriber) => subscriber.id),
    ).toContain(SECOND_RELIC);

    // A second activation of the same relic is refused, exactly as a second
    // pickup is.
    expect(port.activateRelic(SECOND_RELIC)).toBeNull();
    expect(registry.ownedIds()).toEqual([SECOND_RELIC]);
  });

  it('refuses an identifier the catalogue does not carry', () => {
    const { registry } = composeWithRelics();

    expect(registry.runPort().activateRelic('no-such-relic')).toBeNull();
    expect(registry.ownedIds()).toEqual([]);
  });
});

describe('the relics a run holds', () => {
  it('discards a pickup made before begin(), with no half state left', () => {
    const backing = new MemoryStorage();
    const manager = new LocalStorageManager({ storage: backing });
    const config = createDefaultRulesConfig();
    const engine = new Engine({
      config,
      streams: createRngStreams('authority-seed', {}),
      storage: manager,
    });
    const registry = new RelicRegistry({ bus: engine.hooks });

    const controller = new RunController({
      store: new RunStateStore({ storage: manager, config }),
      identity: resolveRunIdentity({ storage: manager, seed: 'authority-seed' }),
      config,
      stages: createDefaultStageConfig(),
      relics: registry.runPort(),
    });

    // Too early: no run has been begun, so this relic belongs to none.
    registry.pickUp(FIRST_RELIC);

    controller.begin();

    const streams = createRngStreams(controller.seed(), controller.cursors());

    controller.observe(engine, () => streams.snapshotCursors());
    engine.setup(controller.openingBoard());
    play(engine, MOVES);

    // Discarded consistently — live, in the projection and in storage — so no
    // surface reports a relic another surface does not.
    expect(registry.ownedIds()).toEqual([]);
    expect(controller.relics()).toEqual([]);
    expect(readStored(backing)?.relics).toEqual([]);
    expect(
      engine.hooks.subscribers().map((subscriber) => subscriber.id),
    ).toEqual([]);
  });

  it('carries a resumed envelope back onto a fresh registry and bus', () => {
    const first = composeWithRelics({ seed: 'authority-resume' });

    first.controller.recordRewardOffer([FIRST_RELIC]);
    first.controller.completeReward(first.engine, FIRST_RELIC);
    play(first.engine, MOVES);
    first.stop();

    expect(readStored(first.backing)?.relics.map((relic) => relic.id)).toEqual([
      FIRST_RELIC,
    ]);

    // A RELOAD: the same storage, a registry and a bus that did not exist when
    // the relic was taken on.
    const second = composeWithRelics({
      backing: first.backing,
      seed: 'authority-resume',
      setup: false,
    });

    second.controller.restoreHeldRelics();

    expect(second.registry.ownedIds()).toEqual([FIRST_RELIC]);
    expect(
      second.engine.hooks.subscribers().map((subscriber) => subscriber.id),
    ).toEqual([FIRST_RELIC]);
    expect(second.controller.relics().map((relic) => relic.id)).toEqual([
      FIRST_RELIC,
    ]);
  });
});

/**
 * Stores the cases below construct, so the teardown can empty each of them.
 */
const trackedStores: MemoryStorage[] = [];

/**
 * Registers one store for teardown and returns it.
 *
 * @param backing Store to track.
 * @returns The same store.
 */
function trackStorage(backing: MemoryStorage): MemoryStorage {
  trackedStores.push(backing);

  return backing;
}

/**
 * Every key this suite removes: `OWNED_STORAGE_KEYS` and the frozen best-score
 * literal, de-duplicated.
 */
const CLEARED_KEYS: readonly OwnedStorageKey[] = Object.freeze([
  ...new Set<OwnedStorageKey>([...OWNED_STORAGE_KEYS, BEST_SCORE_KEY]),
]);

/**
 * Removes one key from the environment's Web Storage where it offers one.
 *
 * @param key Key to remove.
 */
function removeFromWebStorage(key: OwnedStorageKey): void {
  try {
    const store: Storage | undefined = (
      globalThis as { localStorage?: Storage }
    ).localStorage;

    store?.removeItem(key);
  } catch {
    // A host whose global throws on access, or whose store refuses a removal,
    // holds nothing this suite wrote.
    return;
  }
}

/**
 * Empties every tracked store, and any Web Storage, of every key the product
 * owns.
 */
function clearTrackedStorage(): void {
  for (const key of CLEARED_KEYS) {
    for (const backing of trackedStores) {
      backing.removeItem(key);
    }

    removeFromWebStorage(key);
  }
}

beforeEach(() => {
  for (const backing of trackedStores) {
    for (const key of CLEARED_KEYS) {
      expect(backing.getItem(key)).toBeUndefined();
    }
  }
});

afterEach(clearTrackedStorage);

/**
 * A tracked store carrying its fixture BEFORE anything reads it.
 *
 * @param seed Raw stored strings, keyed by the key each is stored under.
 * @returns The seeded store.
 */
function storageHolding(
  seed: Readonly<Partial<Record<OwnedStorageKey, string>>>,
): MemoryStorage {
  const backing = trackStorage(new MemoryStorage());

  for (const [key, value] of Object.entries(seed)) {
    if (value !== undefined) {
      backing.setItem(key, value);
    }
  }

  return backing;
}

/** A listener held without its payload type, as the real emitter holds one. */
type StoredListener = (payload: never) => void;

/**
 * The `EngineEventSource` fake, plus the emission helper a case drives it by.
 */
interface RecordingEvents {
  /** The subscription surface handed to the controller. */
  readonly source: EngineEventSource;

  /** How many listeners stand registered for one event. */
  readonly listenerCount: (event: EngineEventName) => number;

  /** Dispatches one event. */
  readonly emit: <K extends EngineEventName>(
    event: K,
    payload: EngineEventPayloadMap[K],
  ) => void;
}

/**
 * An emitter with `EngineEvents.on`'s semantics and nothing else.
 *
 * @returns A fresh emitter holding no listener.
 */
function createRecordingEvents(): RecordingEvents {
  const listeners = new Map<EngineEventName, StoredListener[]>();

  const arrayFor = (event: EngineEventName): StoredListener[] => {
    const held = listeners.get(event);

    if (held !== undefined) {
      return held;
    }

    const created: StoredListener[] = [];

    listeners.set(event, created);

    return created;
  };

  return {
    source: {
      on<K extends EngineEventName>(
        event: K,
        listener: EngineEventListener<K>,
      ): EngineEventSubscription {
        const held = arrayFor(event);

        held.push(listener);

        return (): void => {
          const at = held.indexOf(listener);

          if (at >= 0) {
            held.splice(at, 1);
          }
        };
      },
    },

    listenerCount: (event: EngineEventName): number => arrayFor(event).length,

    emit<K extends EngineEventName>(
      event: K,
      payload: EngineEventPayloadMap[K],
    ): void {
      for (const held of arrayFor(event).slice()) {
        (held as EngineEventListener<K>)(payload);
      }
    },
  };
}

/** The `EnginePort` fake, plus readers for everything it recorded. */
interface RecordingEngine {
  /** The port handed to the controller. */
  readonly port: EnginePort;

  /** The emitter behind `port.events`. */
  readonly events: RecordingEvents;

  /** Every port call, in order, by member name. */
  readonly calls: string[];

  /** Every argument `setup` received, in order. */
  readonly setups: (SerializedGameState | null | undefined)[];

  /** Every `cleared` argument `endStage` received, in order. */
  readonly endStages: boolean[];

  /** Every argument `startStage` received, in order. */
  readonly startStages: (SerializedGameState | null | undefined)[];

  /** Every direction `move` received, in order. */
  readonly moves: MoveDirection[];

  /** Replaces the board `serialize` projects. */
  readonly hold: (board: SerializedGameState) => void;

  /** The board `serialize` projects, as a fresh copy. */
  readonly board: () => SerializedGameState;

  /** Whether `startStage` raises. Writable, so a retry can be made to work. */
  startStageThrows: boolean;

  /** Calls `startStage` received, raising or not. */
  readonly startStageAttempts: number;

  /** Calls `startStage` completed. */
  readonly startedStages: number;
}

/** How a recording engine is built. */
interface RecordingEngineOptions {
  /** The board `serialize` opens on. Defaults to an empty one. */
  readonly board?: SerializedGameState;

  /**
   * Whether the port publishes `startStage`. `false` yields a port that only
   * observes, which `RunEnginePort` admits and `openNextStage` reads as an
   * engine implementing no stage transition.
   */
  readonly startStage?: boolean;

  /**
   * Whether `startStage` raises when it is called. A throwing opener is the
   * failure both stage-transition paths have to contain.
   */
  readonly startStageThrows?: boolean;
}

/**
 * An `EnginePort` that records every call and returns controllable values.
 *
 * @param options Opening board, and whether `startStage` is published.
 * @returns The port and its recorders.
 */
function createRecordingEngine(
  options: RecordingEngineOptions = {},
): RecordingEngine {
  const events = createRecordingEvents();
  const calls: string[] = [];
  const setups: (SerializedGameState | null | undefined)[] = [];
  const endStages: boolean[] = [];
  const startStages: (SerializedGameState | null | undefined)[] = [];
  const moves: MoveDirection[] = [];

  let held: SerializedGameState = options.board ?? createEmptyBoard();

  const observing: EnginePort = {
    events: events.source,

    serialize(): SerializedGameState {
      calls.push('serialize');

      return copyBoard(held);
    },

    endStage(cleared: boolean): void {
      calls.push('endStage');
      endStages.push(cleared);
    },

    // js/game_manager.js L36-L45: the snapshot the run opens on.
    setup(previousState?: SerializedGameState | null): void {
      calls.push('setup');
      setups.push(previousState);
    },

    // js/game_manager.js L17-L21.
    restart(): void {
      calls.push('restart');
    },

    move(direction: MoveDirection): boolean {
      calls.push('move');
      moves.push(direction);

      return true;
    },

    // js/game_manager.js L30-L32, reading the renamed flag.
    isGameTerminated(): boolean {
      calls.push('isGameTerminated');

      return held.over || (held.won && !held.keepPlaying);
    },

    continuePlaying(): void {
      calls.push('continuePlaying');
    },
  };

  let startStageThrows = options.startStageThrows === true;
  let startStageAttempts = 0;
  let startedStages = 0;

  const transitioning: EnginePort = {
    ...observing,

    startStage(board?: SerializedGameState | null): void {
      calls.push('startStage');
      startStageAttempts += 1;

      if (startStageThrows) {
        throw new Error('the stage could not be opened');
      }

      startStages.push(board);
      startedStages += 1;
    },
  };

  return {
    port: options.startStage === false ? observing : transitioning,
    events,
    calls,
    setups,
    endStages,
    startStages,
    moves,
    hold: (board: SerializedGameState): void => {
      held = board;
    },
    board: (): SerializedGameState => copyBoard(held),

    get startStageThrows(): boolean {
      return startStageThrows;
    },

    set startStageThrows(raises: boolean) {
      startStageThrows = raises;
    },

    get startStageAttempts(): number {
      return startStageAttempts;
    },

    get startedStages(): number {
      return startedStages;
    },
  };
}


/**
 * The relics the recording registry's catalogue carries, freshly built per
 * call.
 *
 * @returns A fresh catalogue.
 */
function recordingCatalogue(): PersistedRelic[] {
  return [
    { id: 'port-plain' },
    { id: 'port-charged', charges: 3 },
    { id: 'port-stateful', charges: 2, state: { spent: 0 } },
    { id: 'port-second-plain' },
  ];
}

/**
 * One reward card for a recording-catalogue identifier.
 *
 * `selectReward()` reads the drawn CARDS rather than the identifiers
 * `recordRewardOffer()` admits, so a case exercising it composes a draw port
 * over these and seats the round through `offerReward()` — the same route
 * src/main.ts's reward screen takes.
 *
 * @param relicId Identifier the card is for.
 * @returns The card.
 */
function drivenOffer(relicId: string): RewardOffer {
  const declared = recordingCatalogue().find(
    (relic): boolean => relic.id === relicId,
  );

  return {
    id: relicId,
    name: relicId,
    rarity: 'common',
    description: `the ${relicId} fixture`,
    hooks: ['onMerge'],
    ...(declared?.charges === undefined ? {} : { charges: declared.charges }),
  };
}

/** The `RelicRegistryPort` fake, plus readers for everything it recorded. */
interface RecordingRegistry {
  /** The port handed to the controller. */
  readonly port: RelicRegistryPort;

  /** Identifiers taken on, in pickup order. */
  readonly picked: () => readonly string[];

  /** Entries held, in pickup order, as the registry would persist them. */
  readonly held: () => readonly PersistedRelic[];

  /** Every port call, in order, by member name. */
  readonly calls: string[];

  /** Withdraws one identifier from the catalogue this registry answers for. */
  readonly forget: (relicId: string) => void;

  /** Makes every later pickup refuse. */
  readonly refuseEveryPickup: () => void;
}

/**
 * A `RelicRegistryPort` that keeps its relics in pickup order.
 *
 * Publishes exactly the member set `RelicRegistry.runPort()` publishes —
 * `knowsRelic`, `pickUpRelic`, `activateRelic`, `holdsRelic`, `resolveRelic`,
 * `snapshotRelics` and `restoreRelics` — which is the documented route between
 * src/run and src/relics. Order is APPEND-ONLY: nothing here sorts, filters or
 * re-keys, so the order the hook bus would dispatch in is the order a case reads
 * back.
 *
 * @param extraIds Further identifiers the catalogue answers for, appended after
 *   the three shapes above. A long run's held list is seeded through this, so a
 *   restore is not filtered down to the four fixture identifiers — the registry
 *   is the authority for what a run may hold, and `RunController.restoreRelics`
 *   reads its snapshot back.
 * @returns The port and its recorders.
 */
function createRecordingRegistry(
  extraIds: readonly string[] = [],
): RecordingRegistry {
  const catalogue = recordingCatalogue();

  for (const id of extraIds) {
    catalogue.push({ id });
  }
  const held: PersistedRelic[] = [];
  const calls: string[] = [];
  let refusing = false;

  const entryFor = (relicId: string): PersistedRelic | null => {
    const found = catalogue.find((relic) => relic.id === relicId);

    if (found === undefined) {
      return null;
    }

    const entry: { id: string; charges?: number; state?: unknown } = {
      id: found.id,
    };

    if (found.charges !== undefined) {
      entry.charges = found.charges;
    }

    if (found.state !== undefined) {
      entry.state = JSON.parse(JSON.stringify(found.state)) as unknown;
    }

    return entry;
  };

  const takeOn = (relicId: string): PersistedRelic | null => {
    if (refusing) {
      return null;
    }

    const entry = entryFor(relicId);

    if (entry === null || held.some((relic) => relic.id === relicId)) {
      return null;
    }

    // APPENDED, so the position of every relic already held is untouched.
    held.push(entry);

    return { ...entry };
  };

  const port: RelicRegistryPort = {
    knowsRelic: (relicId: string): boolean => {
      calls.push('knowsRelic');

      return catalogue.some((relic) => relic.id === relicId);
    },

    pickUpRelic: (relicId: string): PersistedRelic | null => {
      calls.push('pickUpRelic');

      return takeOn(relicId);
    },

    activateRelic: (relicId: string): PersistedRelic | null => {
      calls.push('activateRelic');

      return takeOn(relicId);
    },

    holdsRelic: (relicId: string): boolean => {
      calls.push('holdsRelic');

      return held.some((relic) => relic.id === relicId);
    },

    resolveRelic: (relicId: string): PersistedRelic | null => {
      calls.push('resolveRelic');

      const found = held.find((relic) => relic.id === relicId);

      return found === undefined ? null : { ...found };
    },

    snapshotRelics: (): readonly PersistedRelic[] => {
      calls.push('snapshotRelics');

      return held.map((relic): PersistedRelic => ({ ...relic }));
    },

    restoreRelics: (relics: readonly PersistedRelic[]): void => {
      calls.push('restoreRelics');
      held.length = 0;

      for (const relic of relics) {
        if (catalogue.some((known) => known.id === relic.id)) {
          held.push({ ...relic });
        }
      }
    },
  };

  return {
    port,
    picked: (): readonly string[] => held.map((relic): string => relic.id),
    held: (): readonly PersistedRelic[] =>
      held.map((relic): PersistedRelic => ({ ...relic })),
    calls,
    forget: (relicId: string): void => {
      const at = catalogue.findIndex((relic) => relic.id === relicId);

      if (at >= 0) {
        catalogue.splice(at, 1);
      }
    },
    refuseEveryPickup: (): void => {
      refusing = true;
    },
  };
}

/** One report the controller or the store made, as this suite captured it. */
interface CapturedReport {
  /** Which reporter member carried it. */
  readonly kind: string;

  /** The correlation identifier the report carried. */
  readonly correlationId: CorrelationId;

  /** The members of the report this suite reads back. */
  readonly detail: Readonly<Record<string, unknown>>;
}

/** A capturing `RunReporter`, and readers over what it captured. */
interface ReportSink {
  /** The sink injected into the store and the controller. */
  readonly reporter: RunReporter;

  /** Every report, in the order it was made. */
  readonly records: CapturedReport[];

  /** Every report one reporter member carried. */
  readonly of: (kind: string) => readonly CapturedReport[];
}

/**
 * @returns The sink and its readers.
 */
function createReportSink(): ReportSink {
  const records: CapturedReport[] = [];

  const capture = (
    kind: string,
    correlationId: CorrelationId,
    detail: Readonly<Record<string, unknown>>,
  ): void => {
    records.push({ kind, correlationId, detail });
  };

  const reporter: RunReporter = {
    onLoadCorrupted(report): void {
      capture('load-corrupted', report.correlationId ?? '', {
        key: report.key,
        verdict: report.verdict,
        problems: report.problems,
        error: report.error,
      });
    },

    onVersionMigrated(report): void {
      capture('version-migrated', report.correlationId, {
        fromVersion: report.fromVersion,
        toVersion: report.toVersion,
      });
    },

    onBoardSizeReconciled(report): void {
      capture('board-size-reconciled', report.correlationId, {
        savedSize: report.savedSize,
        configuredSize: report.configuredSize,
        appliedSize: report.appliedSize,
      });
    },

    onWriteFailed(report): void {
      capture('write-failed', report.correlationId, {
        key: report.key,
        byteLength: report.byteLength,
        error: report.error,
      });
    },

    // The eleventh channel, which this sink used to omit — so no case composed
    // over it could observe a run losing or regaining its storage.
    onPersistenceStatusChanged(report): void {
      capture('persistence-status-changed', report.correlationId, {
        status: report.status,
        previous: report.previous,
        refusedWrites: report.refusedWrites,
      });
    },

    onRunStarted(report): void {
      capture('run-started', report.correlationId, {
        runId: report.runId,
        stageIndex: report.stageIndex,
        resumed: report.resumed,
        seedProvided: report.seedProvided,
      });
    },

    onStageAdvanced(report): void {
      capture('stage-advanced', report.correlationId, {
        fromStageIndex: report.fromStageIndex,
        toStageIndex: report.toStageIndex,
        goal: report.goal,
      });
    },

    onRewardOffered(report): void {
      capture('reward-offered', report.correlationId, {
        stageIndex: report.stageIndex,
        offeredRelicIds: report.offeredRelicIds,
      });
    },

    onRewardDrawn(report): void {
      capture('reward-drawn', report.correlationId, {
        stageIndex: report.stageIndex,
        offeredRelicIds: report.offeredRelicIds,
        selectedRelicId: report.selectedRelicId,
        accepted: report.accepted,
        refusal: report.refusal,
      });
    },

    onRelicsNormalized(report): void {
      capture('relics-normalized', report.correlationId, {
        requested: report.requested,
        restored: report.restored,
        refused: report.refused,
      });
    },

    onRunEnded(report): void {
      capture('run-ended', report.correlationId, {
        outcome: report.outcome,
        summary: report.summary,
      });
    },
  };

  return {
    reporter,
    records,
    of: (kind: string): readonly CapturedReport[] =>
      records.filter((record) => record.kind === kind),
  };
}

/** Distinguishes the run identifiers of two runs composed in one file run. */
let tokenSerial = 0;

/** How one port-driven run is composed. */
interface DriveOptions {
  /** The store to compose over. A fresh tracked one by default. */
  readonly backing?: MemoryStorage;

  /**
   * The seed a FRESH run is opened on. It reaches `resolveRunIdentity` only
   * where the store carries no envelope to resume, exactly as in
   * `ComposeOptions`.
   */
  readonly seed?: string;

  /** A seed a caller TYPED, handed over whatever the store holds. */
  readonly enteredSeed?: string;

  /** The board the engine opens on. */
  readonly board?: SerializedGameState;

  /** Whether the port publishes `startStage`. */
  readonly startStage?: boolean;

  /** Whether the published `startStage` raises. */
  readonly startStageThrows?: boolean;

  /** `false` composes the controller with no registry at all. */
  readonly relics?: boolean;

  /** Further identifiers the recording registry's catalogue answers for. */
  readonly catalogue?: readonly string[];

  /** The offers a cleared stage draws. Absent composes no draw port. */
  readonly offers?: readonly RewardOffer[];

  /** `false` leaves the controller unsubscribed from the engine. */
  readonly observe?: boolean;

  /**
   * The reporter channel that RAISES. Every other channel reaches the sink as
   * usual, so a case can assert both that the lifecycle survived the throw and
   * that the reports the observer did not break still arrived.
   */
  readonly throwOn?: keyof RunReporter;
}

/** One run composed over the ports alone. */
interface Driven {
  readonly backing: MemoryStorage;
  readonly manager: LocalStorageManager;
  readonly store: RunStateStore;
  readonly config: RulesConfig;
  readonly stages: StageConfig;
  readonly controller: RunController;
  readonly engine: RecordingEngine;
  readonly registry: RecordingRegistry;
  readonly sink: ReportSink;
  readonly streams: RngStreams;

  /** The substream draw counts, as `observe` and `persist` read them. */
  readonly cursors: () => RngCursorMap;

  /** Releases the controller's subscriptions. */
  readonly stop: () => void;

  /** What `begin` reported. */
  readonly outcome: RunStateLoadOutcome;
}

/**
 * Composes storage, store, controller, registry and engine port in the order
 * src/main.ts composes them, and attaches the controller to the engine.
 *
 * @param options Store, seed, board, and which optional ports to publish.
 * @returns Everything a case reads or drives.
 */
/**
 * Runs `act`, failing the case where it raises, and answers what it produced.
 *
 * Written as a returning helper rather than an assignment inside
 * `expect(...).not.toThrow()` because a value assigned only inside a callback
 * stays narrowed to its initialiser for the reader below it.
 *
 * @param act The call under test.
 * @returns Whatever `act` returned.
 */
function withoutThrowing<T>(act: () => T): T {
  let raised: unknown = null;
  let produced: T | undefined;

  try {
    produced = act();
  } catch (error) {
    raised = error;
  }

  expect(raised).toBeNull();

  return produced as T;
}

/**
 * Every channel `RunReporter` declares, as a coverage map.
 *
 * `Record<keyof RunReporter, true>` makes every declared channel REQUIRED here
 * and rejects any name the interface does not declare, so a channel added to
 * `RunReporter` fails the type check rather than silently escaping the
 * containment matrix below.
 */
const REPORTER_CHANNEL_COVERAGE = {
  onLoadCorrupted: true,
  onVersionMigrated: true,
  onBoardSizeReconciled: true,
  onWriteFailed: true,
  onPersistenceStatusChanged: true,
  onRunStarted: true,
  onStageAdvanced: true,
  onRewardOffered: true,
  onRewardDrawn: true,
  onRelicsNormalized: true,
  onRunEnded: true,
} satisfies Record<keyof RunReporter, true>;

/** The channel names, derived so the map and the list cannot differ. */
const REPORTER_CHANNELS: readonly (keyof RunReporter)[] = Object.keys(
  REPORTER_CHANNEL_COVERAGE,
) as readonly (keyof RunReporter)[];

/**
 * One reporter with a single BROKEN channel.
 *
 * Every channel but `raises` delegates to `delegate`. The broken one throws
 * WITHOUT delegating, so it records nothing and a case reading the sink sees
 * exactly what an observer that failed mid-report would have left behind.
 *
 * @param delegate The reporter every working channel reaches.
 * @param raises The channel that throws.
 * @returns The reporter.
 */
function raisingReporter(
  delegate: RunReporter,
  raises: keyof RunReporter,
): RunReporter {
  const built: Record<string, unknown> = {};

  for (const channel of REPORTER_CHANNELS) {
    built[channel] =
      channel === raises
        ? (): never => {
            throw new Error(`reporter channel ${channel} refused`);
          }
        : (report: never): void => {
            const member = delegate[channel];

            member?.(report);
          };
  }

  return built as RunReporter;
}

function drive(options: DriveOptions = {}): Driven {
  const backing = options.backing ?? trackStorage(new MemoryStorage());
  const manager = new LocalStorageManager({ storage: backing });
  const config = createDefaultRulesConfig();
  const stages = createDefaultStageConfig();
  const sink = createReportSink();
  const registry = createRecordingRegistry(options.catalogue);
  const engine = createRecordingEngine({
    board: options.board,
    startStage: options.startStage,
    startStageThrows: options.startStageThrows,
  });

  const createToken = (): string => {
    tokenSerial += 1;

    return `driven-run-${String(tokenSerial)}`;
  };

  const identity = resolveRunIdentity({
    storage: manager,
    createToken,
    seed: options.enteredSeed ?? identitySeed(manager, options.seed),
  });

  const holder: { controller: RunController | null } = { controller: null };

  const readCorrelationId = (): CorrelationId => {
    const live = holder.controller;

    return live === null ? '' : runCorrelationId(live.seed(), live.runId());
  };

  const reporter =
    options.throwOn === undefined
      ? sink.reporter
      : raisingReporter(sink.reporter, options.throwOn);

  const store = new RunStateStore({
    storage: manager,
    config,
    reporter,
    correlationId: readCorrelationId,
  });

  const offers = options.offers;

  const controller = new RunController({
    store,
    identity,
    config,
    stages,
    createToken,
    reporter,
    correlationId: readCorrelationId,
    relics: options.relics === false ? undefined : registry.port,
    rewards:
      offers === undefined
        ? undefined
        : {
            draw: ({ count, ownedIds }): readonly RewardOffer[] =>
              offers
                .filter((offer) => !ownedIds.includes(offer.id))
                .slice(0, count),
          },
  });

  holder.controller = controller;

  const outcome = controller.begin();
  const streams = createRngStreams(controller.seed(), controller.cursors());
  const cursors = (): RngCursorMap => streams.snapshotCursors();

  return {
    backing,
    manager,
    store,
    config,
    stages,
    controller,
    engine,
    registry,
    sink,
    streams,
    cursors,
    stop:
      options.observe === false
        ? (): void => undefined
        : controller.observe(engine.port, cursors),
    outcome,
  };
}

/** A board snapshot as an event carries it: the live lattice. */
function gridOf(board: SerializedGameState): Grid {
  // `Grid.fromState` reads `state[x][y]`, so the second argument is the CELLS
  // matrix and not the serialised grid. js/grid.js L21-L34.
  return new Grid(board.grid.size, board.grid.cells);
}

/**
 * Emits `stage:start` for the stage in force, as the engine emits one while it
 * prepares a board.
 *
 * @param run The composed run.
 * @param board The board the stage opens on.
 */
function startStage(run: Driven, board: SerializedGameState): void {
  run.engine.hold(board);
  run.engine.events.emit('stage:start', {
    stageIndex: run.controller.stageIndex(),
    goal: run.controller.stageGoal(),
    seed: run.controller.seed(),
    boardSize: board.grid.size,
  });
}

/**
 * Emits `move:after` for one resolved turn, which is where the stage goal is
 * MEASURED.
 *
 * @param run The composed run.
 * @param board The board the move left, held by the engine as well so the
 *   two agree on the moment being described.
 * @param score The score the move left.
 */
function resolveMove(
  run: Driven,
  board: SerializedGameState,
  score = 0,
): void {
  run.engine.hold({ ...board, score });
  run.engine.events.emit('move:after', {
    moved: true,
    board: gridOf(board),
    score,
    over: false,
    won: false,
    terminated: false,
    turn: 1,
  });
}

/**
 * Emits `stage:end`, which is where a met goal is RESOLVED.
 *
 * @param run The composed run.
 * @param cleared Whether the stage cleared.
 * @param score The score at resolution.
 */
function endStage(run: Driven, cleared: boolean, score = 0): void {
  run.engine.events.emit('stage:end', {
    stageIndex: run.controller.stageIndex(),
    cleared,
    score,
  });
}

/**
 * Emits `state:commit`, carrying the two slices the controller's own providers
 * supply.
 *
 * @param run The composed run.
 * @param over Whether the run is lost.
 */
function commit(run: Driven, over = false): void {
  const board = run.engine.board();

  run.engine.events.emit('state:commit', {
    turn: 1,
    board: gridOf(board),
    score: board.score,
    bestScore: 0,
    over,
    won: false,
    terminated: over,
    degraded: false,
    stage: run.controller.stageCommitContextProvider()(),
    relics: run.controller.relicCommitContextProvider()(),
  });
}

/**
 * An envelope holding `relics`, at stage 0 and cursor zero.
 *
 * `createFreshRunState` mints the shape and always starts from an empty held
 * list — the envelope is the authority for what a run holds, and a run acquires
 * a relic only through the reward transaction — so the list is placed on the
 * result, which is what a run that had acquired them would have written.
 *
 * @param runId Run identifier the envelope carries.
 * @param seed Seed the envelope was played under.
 * @param relics Entries the run holds, in pickup order.
 * @returns The envelope.
 */
function envelopeHolding(
  runId: string,
  seed: string,
  relics: readonly PersistedRelic[],
): RunState {
  return {
    ...createFreshRunState({
      runId,
      seed,
      rngCursor: {},
      stageIndex: 0,
      stageGoal: stageGoalForIndex(0, createDefaultStageConfig()),
      board: createEmptyBoard(),
    }),
    relics: [...relics],
  };
}

/** The envelope as it is actually stored under one store, or `null`. */
function storedEnvelope(backing: MemoryStorage): RunState | null {
  const raw = backing.getItem(RUN_STATE_KEY);

  return raw === undefined ? null : (JSON.parse(raw) as RunState);
}

/**
 * The next `count` draws of every named substream, as one comparable list.
 *
 * @param streams Substreams to draw from. Advanced by the reading.
 * @param count Draws to take per substream.
 * @returns One entry per substream per draw, in `RNG_STREAM_NAMES` order.
 */
function draws(streams: RngStreams, count = 4): number[] {
  const taken: number[] = [];

  for (const name of RNG_STREAM_NAMES) {
    for (let index = 0; index < count; index += 1) {
      taken.push(streams.stream(name).next());
    }
  }

  return taken;
}

/**
 * A board whose highest tile is `value`, built through the shared fixtures.
 */
function boardWithHighest(value: number): SerializedGameState {
  // `createNearWinBoard(size, winValue)` lays two tiles of half the win value,
  // so a win value of twice `value` yields a board whose highest tile is
  // exactly `value`.
  return createNearWinBoard(4, value * 2);
}

/**
 * Takes one relic on through the reward transaction, which is the only route
 * by which a relic joins a run.
 *
 * @param run The composed run.
 * @param relicId Identifier to offer and then select.
 * @returns What `resolveReward` reported.
 */
function takeReward(run: Driven, relicId: string): RewardResolution {
  run.controller.recordRewardOffer([relicId]);

  return run.controller.resolveReward(relicId);
}


/** Names any seed-originating export would plausibly carry. */
const ORIGINATOR_NAMES: readonly string[] = Object.freeze([
  'originateRunSeed',
  'originateRunId',
  'originateSeed',
  'createSeed',
  'newSeed',
  'freshSeed',
  'randomSeed',
  'generateSeed',
  'mintSeed',
]);

describe('originateRunSeed', () => {
  it('mints a non-empty seed the substreams accept', () => {
    const seed = originateRunSeed();

    expect(typeof seed).toBe('string');
    expect(seed.length).toBeGreaterThan(0);
    expect(isAcceptableRunSeed(seed)).toBe(true);
  });

  it('mints a different seed on every call', () => {
    const first = originateRunSeed();
    const second = originateRunSeed();

    expect(first).not.toBe(second);
  });

  it('mints a run identifier separately from a seed', () => {
    const first = originateRunId();
    const second = originateRunId();

    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    expect(first).not.toBe(second);
    expect(first).not.toBe(originateRunSeed());
  });

  it('yields a value both generator factories build from', () => {
    const seed = originateRunSeed();
    const streams = createRngStreams(seed);

    expect(streams.seed).toBe(seed);

    for (const name of RNG_STREAM_NAMES) {
      const drawn = streams.stream(name).next();

      expect(Number.isFinite(drawn)).toBe(true);
      expect(drawn).toBeGreaterThanOrEqual(0);
      expect(drawn).toBeLessThan(1);
    }

    const rng = seededRngModule.createSeededRng(seed);

    expect(rng.seed).toBe(seed);
    expect(Number.isFinite(rng.next())).toBe(true);
  });

  it('is confined here: src/rng originates no seed of its own', () => {
    const exported = new Set<string>([
      ...Object.keys(rngStreamsModule),
      ...Object.keys(seededRngModule),
    ]);

    // The surfaces were actually read: both factories are on them.
    expect(exported.has('createRngStreams')).toBe(true);
    expect(exported.has('createSeededRng')).toBe(true);

    for (const name of ORIGINATOR_NAMES) {
      expect(exported.has(name)).toBe(false);
    }

    expect(
      [...exported].filter((name) => /originat|mintseed/iu.test(name)),
    ).toEqual([]);

    // Origination is a member of the run layer, which is what leaves every
    // other randomness path seeded and auditable.
    expect(typeof originateRunSeed).toBe('function');
    expect(typeof originateRunId).toBe('function');
  });
});

describe('normalizeEnteredSeed', () => {
  it('maps one entered seed to one normalised seed, every time', () => {
    expect(normalizeEnteredSeed('run-of-the-mill')).toBe('run-of-the-mill');
    expect(normalizeEnteredSeed('run-of-the-mill')).toBe(
      normalizeEnteredSeed('run-of-the-mill'),
    );
  });

  it('maps two different entries to two different seeds', () => {
    expect(normalizeEnteredSeed('seed-a')).not.toBe(
      normalizeEnteredSeed('seed-b'),
    );
  });

  it('trims surrounding whitespace and keeps the whitespace inside', () => {
    expect(normalizeEnteredSeed('  spaced  ')).toBe('spaced');
    expect(normalizeEnteredSeed('\t\nwrapped\r\n ')).toBe('wrapped');
    expect(normalizeEnteredSeed('two words')).toBe('two words');
  });

  it('preserves case, so two casings are two seeds', () => {
    expect(normalizeEnteredSeed('Seed')).toBe('Seed');
    expect(normalizeEnteredSeed('seed')).toBe('seed');
    expect(normalizeEnteredSeed('Seed')).not.toBe(normalizeEnteredSeed('seed'));
  });

  it('carries digits through as text rather than parsing them', () => {
    expect(normalizeEnteredSeed('0042')).toBe('0042');
    expect(normalizeEnteredSeed(' 0042 ')).toBe('0042');
  });

  it('carries characters outside the expected set through opaquely', () => {
    const entered = 'sé\u00e7d/\\:;"\'<>|&%$#@!~`^*()[]{}';

    expect(normalizeEnteredSeed(entered)).toBe(entered);
    expect(isAcceptableRunSeed(normalizeEnteredSeed(entered))).toBe(true);
  });

  it('originates a seed for an empty entry', () => {
    const first = normalizeEnteredSeed('');
    const second = normalizeEnteredSeed('');

    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);

    // Originated, not a constant: the run-start screen's seed field needs no
    // error path for an empty submission.
    expect(first).not.toBe(second);
    expect(isAcceptableRunSeed(first)).toBe(true);
  });

  it('originates a seed for a whitespace-only entry', () => {
    const first = normalizeEnteredSeed('   \t\n  ');
    const second = normalizeEnteredSeed('   \t\n  ');

    expect(first.trim()).toBe(first);
    expect(first.length).toBeGreaterThan(0);
    expect(first).not.toBe(second);
    expect(isAcceptableRunSeed(first)).toBe(true);
  });

  it('bounds an over-long entry to the length the substreams accept', () => {
    const entered = 'x'.repeat(MAX_RUN_SEED_LENGTH + 50);
    const normalised = normalizeEnteredSeed(entered);

    expect(normalised.length).toBe(MAX_RUN_SEED_LENGTH);
    expect(entered.startsWith(normalised)).toBe(true);
    expect(isAcceptableRunSeed(normalised)).toBe(true);

    // Bounded, never refused: building the substreams from it cannot throw.
    expect(() => createRngStreams(normalised)).not.toThrow();
  });

  it('leaves an entry already at the bound untouched', () => {
    const entered = 'y'.repeat(MAX_RUN_SEED_LENGTH);

    expect(normalizeEnteredSeed(entered)).toBe(entered);
  });

  /* ---- The raw ceiling, applied before any whole-string work ---- */

  it('declares a raw ceiling above the seed domain, with room to trim', () => {
    // The reduction trims surrounding whitespace, so the raw text may
    // legitimately be longer than the seed it yields; the raw ceiling is the
    // bound on the text the reduction is allowed to walk to get there.
    expect(MAX_ENTERED_SEED_LENGTH).toBeGreaterThan(MAX_RUN_SEED_LENGTH);
    expect(MAX_ENTERED_SEED_LENGTH).toBe(MAX_RUN_SEED_LENGTH * 4);
  });

  it('reduces a paste far above the raw ceiling to an accepted seed', () => {
    // A megabyte of text, which a paste or a programmatic assignment can supply.
    // Before the ceiling, `trim()` and the presence regex both walked all of it
    // before the 256-character bound was ever applied. Decision DL-RUNCTL-07.
    const entered = 'z'.repeat(1_000_000);
    const normalised = normalizeEnteredSeed(entered);

    expect(normalised.length).toBe(MAX_RUN_SEED_LENGTH);
    expect(isAcceptableRunSeed(normalised)).toBe(true);
    expect(() => createRngStreams(normalised)).not.toThrow();
  });

  it('reduces text at exactly the raw ceiling the same way', () => {
    const entered = 'q'.repeat(MAX_ENTERED_SEED_LENGTH);
    const normalised = normalizeEnteredSeed(entered);

    expect(normalised).toBe('q'.repeat(MAX_RUN_SEED_LENGTH));
  });

  it('keeps a padded entry within the ceiling reducing to the same seed', () => {
    // Padding well inside the ceiling is what the slack exists for: the seed is
    // recovered intact rather than being lost to the raw bound.
    const padding = ' '.repeat(MAX_RUN_SEED_LENGTH);

    expect(normalizeEnteredSeed(`${padding}Seed-42${padding}`)).toBe('Seed-42');
  });

  it('originates for padding that fills the raw ceiling', () => {
    // The stated consequence of bounding before trimming: a seed pushed beyond
    // the raw ceiling by leading whitespace is not reached, and the run gets an
    // originated seed rather than an unbounded walk. It is deliberate, and no
    // realistic entry approaches it.
    const entered = `${' '.repeat(MAX_ENTERED_SEED_LENGTH)}Seed-42`;
    const normalised = normalizeEnteredSeed(entered);

    expect(normalised).not.toBe('Seed-42');
    expect(isAcceptableRunSeed(normalised)).toBe(true);
    expect(normalised.length).toBeGreaterThan(0);
  });
});

describe('a run started from an entered seed', () => {
  it('plays the entered seed and derives the same sequence twice', () => {
    const entered = '  Player Seed 42  ';
    const first = drive({ seed: normalizeEnteredSeed(entered) });
    const second = drive({ seed: normalizeEnteredSeed(entered) });

    expect(first.controller.seed()).toBe('Player Seed 42');
    expect(second.controller.seed()).toBe(first.controller.seed());

    // The human-facing half of AAP V2: one seed, one sequence.
    expect(draws(first.streams)).toEqual(draws(second.streams));

    // A replayed seed is still a NEW run instance.
    expect(second.controller.runId()).not.toBe(first.controller.runId());
  });

  it('reports the seed as caller-supplied', () => {
    const run = drive({ seed: 'reported-seed' });
    const [started] = run.sink.of('run-started');

    expect(started?.detail.seedProvided).toBe(true);
    expect(started?.detail.resumed).toBe(false);
    expect(run.controller.identity.seedProvided).toBe(true);
  });

  it('startRun normalises the seed it is handed and mints a new run', () => {
    const run = drive();
    const before = run.controller.runId();
    const seed = run.controller.startRun(run.engine.port, {
      seed: '  Typed Seed  ',
    });

    expect(seed).toBe('Typed Seed');
    expect(run.controller.seed()).toBe('Typed Seed');
    expect(run.controller.runId()).not.toBe(before);
    expect(run.controller.stageIndex()).toBe(0);
    expect(run.controller.relics()).toEqual([]);
  });

  it('startRun originates a seed when none is entered', () => {
    const run = drive({ seed: 'originating-run' });
    const originated = run.controller.startRun(run.engine.port);

    expect(originated).not.toBe('originating-run');
    expect(originated.length).toBeGreaterThan(0);
    expect(run.controller.seed()).toBe(originated);
    expect(isAcceptableRunSeed(originated)).toBe(true);
  });
});

describe('stageGoalForIndex', () => {
  it('derives one goal per index, deterministically', () => {
    const stages = createDefaultStageConfig();

    for (const index of [0, 1, 2, 7, 8, 20]) {
      expect(stageGoalForIndex(index, stages)).toEqual(
        stageGoalForIndex(index, stages),
      );
    }
  });

  it('consumes no randomness, so a draw between two calls changes nothing', () => {
    const stages = createDefaultStageConfig();
    const streams = createRngStreams('goal-derivation');
    const before = stageGoalForIndex(3, stages);

    draws(streams, 16);

    expect(stageGoalForIndex(3, stages)).toEqual(before);
  });

  it('hands back a fresh object rather than a reference into the curve', () => {
    const stages = createDefaultStageConfig();
    const first = stageGoalForIndex(0, stages);
    const second = stageGoalForIndex(0, stages);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first).not.toBe(stages.ladder[0]);
  });

  it('is a plain kind-and-target pair carrying no function', () => {
    const stages = createDefaultStageConfig();

    for (const index of [0, 4, 9]) {
      const goal = stageGoalForIndex(index, stages);

      expect(Object.keys(goal).sort()).toEqual(['kind', 'target']);
      expect(['highest-tile', 'score-threshold']).toContain(goal.kind);
      expect(typeof goal.target).toBe('number');
      expect(Number.isFinite(goal.target)).toBe(true);

      for (const value of Object.values(goal)) {
        expect(typeof value).not.toBe('function');
      }
    }
  });

  it('survives the JSON round trip the envelope stores it through', () => {
    const stages = createDefaultStageConfig();

    for (const index of [0, 5, 12]) {
      const goal = stageGoalForIndex(index, stages);
      const restored = JSON.parse(JSON.stringify(goal)) as StageGoal;

      expect(restored).toEqual(goal);
    }
  });
});

describe('evaluateStageGoal clamps the fraction it reports', () => {
  /** The two goal kinds, each at a target a fixture board can straddle. */
  const highestTile: StageGoal = { kind: 'highest-tile', target: 16 };
  const scoreThreshold: StageGoal = { kind: 'score-threshold', target: 200 };

  it('measures a highest-tile goal from the board through the engine seam', () => {
    const below = highestTileValue(gridOf(boardWithHighest(8)));
    const at = highestTileValue(gridOf(boardWithHighest(16)));
    const above = highestTileValue(gridOf(boardWithHighest(64)));

    expect([below, at, above]).toEqual([8, 16, 64]);

    const under = evaluateStageGoal(highestTile, {
      score: 0,
      highestTileValue: below,
    });

    expect(under.achieved).toBe(8);
    expect(under.cleared).toBe(false);
    expect(under.progress).toBeGreaterThan(0);
    expect(under.progress).toBeLessThan(1);

    const exact = evaluateStageGoal(highestTile, {
      score: 0,
      highestTileValue: at,
    });

    expect(exact.cleared).toBe(true);
    expect(exact.progress).toBe(1);

    const over = evaluateStageGoal(highestTile, {
      score: 0,
      highestTileValue: above,
    });

    expect(over.cleared).toBe(true);
    expect(over.progress).toBe(1);
    expect(over.progress).toBeLessThanOrEqual(1);
  });

  it('measures a score-threshold goal from the score', () => {
    const under = evaluateStageGoal(scoreThreshold, {
      score: 50,
      highestTileValue: 2048,
    });

    expect(under.achieved).toBe(50);
    expect(under.cleared).toBe(false);
    expect(under.progress).toBeGreaterThan(0);
    expect(under.progress).toBeLessThan(1);

    const exact = evaluateStageGoal(scoreThreshold, {
      score: 200,
      highestTileValue: 0,
    });

    expect(exact.cleared).toBe(true);
    expect(exact.progress).toBe(1);

    const over = evaluateStageGoal(scoreThreshold, {
      score: 5000,
      highestTileValue: 0,
    });

    expect(over.cleared).toBe(true);
    expect(over.progress).toBe(1);
  });

  it('reports zero for an empty board and never a negative fraction', () => {
    const empty = highestTileValue(gridOf(createEmptyBoard()));

    expect(empty).toBe(0);

    const progress = evaluateStageGoal(highestTile, {
      score: 0,
      highestTileValue: empty,
    });

    expect(progress.achieved).toBe(0);
    expect(progress.cleared).toBe(false);
    expect(progress.progress).toBe(0);
  });

  it('reads the merge-pair fixture as the two-tile board it is', () => {
    expect(highestTileValue(gridOf(createMergePairBoard()))).toBe(2);
  });
});


describe('observe attaches to the engine', () => {
  it('registers one listener per event it consumes and none elsewhere', () => {
    const run = drive();
    const { listenerCount } = run.engine.events;

    expect(listenerCount('stage:start')).toBe(1);
    expect(listenerCount('move:after')).toBe(1);
    expect(listenerCount('stage:end')).toBe(1);
    expect(listenerCount('state:commit')).toBe(1);

    // The three the controller does not consume: those belong to the renderer
    // and the hook bus.
    expect(listenerCount('move:before')).toBe(0);
    expect(listenerCount('tile:merge')).toBe(0);
    expect(listenerCount('tile:spawn')).toBe(0);
  });

  it('appends, so a second subscriber displaces nothing', () => {
    const run = drive();
    const seen: string[] = [];

    run.engine.events.source.on('move:after', (): void => {
      seen.push('peer');
    });

    expect(run.engine.events.listenerCount('move:after')).toBe(2);

    resolveMove(run, boardWithHighest(8), 12);

    expect(seen).toEqual(['peer']);
    expect(run.controller.goalProgress()).toBeGreaterThan(0);
  });

  it('tolerates an event it does not consume', () => {
    const run = drive();

    expect(() => {
      run.engine.events.emit('tile:spawn', {
        position: { x: 0, y: 0 },
        value: 2,
        turn: 1,
      });
    }).not.toThrow();
  });

  it('stops measuring once its subscriptions are released', () => {
    const run = drive();

    startStage(run, createEmptyBoard());
    resolveMove(run, boardWithHighest(8), 40);

    const measured = run.controller.goalProgress();

    run.stop();
    resolveMove(run, boardWithHighest(16), 400);

    expect(run.controller.goalProgress()).toBe(measured);
  });
});

describe('the stage in progress', () => {
  it('opens on the first ladder goal with no progress', () => {
    const run = drive();

    expect(run.controller.stageIndex()).toBe(0);
    expect(run.controller.goalProgress()).toBe(0);
    expect(run.controller.relics()).toEqual([]);
    expect(run.controller.seed().length).toBeGreaterThan(0);
    expect(run.controller.runId().length).toBeGreaterThan(0);
    expect(run.controller.stageGoal()).toEqual(
      stageGoalForIndex(0, run.stages),
    );
  });

  it('measures progress from the board a resolved move left', () => {
    const run = drive();
    const board = boardWithHighest(8);
    const expected = evaluateStageGoal(stageGoalForIndex(0, run.stages), {
      score: 24,
      highestTileValue: highestTileValue(gridOf(board)),
    });

    startStage(run, createEmptyBoard());
    resolveMove(run, board, 24);

    expect(run.controller.goalProgress()).toBe(expected.progress);
    expect(expected.cleared).toBe(false);
  });

  it('leaves the stage index alone for a move that misses the goal', () => {
    const run = drive();

    startStage(run, createEmptyBoard());
    resolveMove(run, boardWithHighest(8), 24);
    commit(run);

    expect(run.controller.stageIndex()).toBe(0);
    expect(run.controller.stageGoal()).toEqual(
      stageGoalForIndex(0, run.stages),
    );

    // Nothing was resolved, so the engine was never asked to end a stage.
    expect(run.engine.endStages).toEqual([]);
  });

  it('measures against the goal of the stage in force, then resolves', () => {
    const run = drive();
    const cleared = boardWithHighest(16);

    startStage(run, createEmptyBoard());
    resolveMove(run, cleared, 64);

    // MEASURED, against stage 0's target of 16 — and not yet resolved.
    expect(run.controller.goalProgress()).toBe(1);
    expect(run.controller.stageIndex()).toBe(0);

    endStage(run, true, 64);

    // RESOLVED: the next index, that index's goal, and progress back to zero.
    expect(run.controller.stageIndex()).toBe(1);
    expect(run.controller.stageGoal()).toEqual(
      stageGoalForIndex(1, run.stages),
    );
    expect(run.controller.goalProgress()).toBe(0);
  });

  it('resolves nothing for a stage:end that did not clear', () => {
    const run = drive();

    startStage(run, createEmptyBoard());
    resolveMove(run, boardWithHighest(16), 64);
    endStage(run, false, 64);

    expect(run.controller.stageIndex()).toBe(0);
    expect(run.controller.goalProgress()).toBe(1);
  });

  it('reports the advance it made, from one index to the next', () => {
    const run = drive();

    startStage(run, createEmptyBoard());
    resolveMove(run, boardWithHighest(16), 64);
    endStage(run, true, 64);

    const [advanced] = run.sink.of('stage-advanced');

    expect(advanced?.detail.fromStageIndex).toBe(0);
    expect(advanced?.detail.toStageIndex).toBe(1);
    expect(advanced?.detail.goal).toEqual(stageGoalForIndex(1, run.stages));
    expect(advanced?.correlationId).toBe(run.controller.correlationId());
  });
});

describe('advanceStage', () => {
  it('recomputes the goal from the curve and zeroes the progress', () => {
    const run = drive();

    startStage(run, createEmptyBoard());
    resolveMove(run, boardWithHighest(8), 24);

    expect(run.controller.goalProgress()).toBeGreaterThan(0);

    const goal = run.controller.advanceStage();

    expect(goal).toEqual(stageGoalForIndex(1, run.stages));
    expect(run.controller.stageGoal()).toEqual(goal);
    expect(run.controller.goalProgress()).toBe(0);
    expect(run.controller.stageIndex()).toBe(1);
  });

  it('advances one stage per call, and carries the relics forward', () => {
    const run = drive();

    takeReward(run, 'port-charged');

    run.controller.advanceStage();
    run.controller.advanceStage();

    expect(run.controller.stageIndex()).toBe(2);
    expect(run.controller.stageGoal()).toEqual(
      stageGoalForIndex(2, run.stages),
    );
    expect(run.controller.relics().map((relic) => relic.id)).toEqual([
      'port-charged',
    ]);
  });
});

describe('the progress that reaches storage', () => {
  it('is the clamped fraction evaluateStageGoal returned', () => {
    const run = drive();
    const board = boardWithHighest(8);
    const expected = evaluateStageGoal(stageGoalForIndex(0, run.stages), {
      score: 36,
      highestTileValue: highestTileValue(gridOf(board)),
    });

    startStage(run, createEmptyBoard());
    resolveMove(run, board, 36);

    expect(run.controller.persist(run.engine.port, run.cursors)).toBe(true);

    const stored = storedEnvelope(run.backing);

    expect(stored?.goalProgress).toBe(expected.progress);
    expect(stored?.goalProgress).toBeGreaterThan(0);
    expect(stored?.goalProgress).toBeLessThan(1);
    expect(stored?.stageGoal).toEqual(stageGoalForIndex(0, run.stages));
  });

  it('never exceeds the fraction s upper bound', () => {
    const run = drive();

    startStage(run, createEmptyBoard());
    resolveMove(run, boardWithHighest(1024), 9000);
    run.controller.persist(run.engine.port, run.cursors);

    const stored = storedEnvelope(run.backing);

    expect(stored?.goalProgress).toBe(1);
  });
});

describe('startRun', () => {
  it('opens the engine on the board it was handed', () => {
    const run = drive({ observe: false });
    const opening = createMergePairBoard();

    run.controller.startRun(run.engine.port, { board: opening });

    expect(run.engine.setups).toHaveLength(1);
    expect(run.engine.setups[0]).toEqual(opening);
    expect(run.controller.openingBoard()).toEqual(opening);
  });

  it('discards whatever was stored, so the next run starts at stage 0', () => {
    const run = drive();

    startStage(run, createEmptyBoard());
    takeReward(run, 'port-plain');
    run.controller.advanceStage();
    run.controller.persist(run.engine.port, run.cursors);

    expect(storedEnvelope(run.backing)?.stageIndex).toBe(1);

    run.controller.startRun(run.engine.port);

    expect(run.controller.stageIndex()).toBe(0);
    expect(run.controller.relics()).toEqual([]);
    expect(run.controller.goalProgress()).toBe(0);
    expect(storedEnvelope(run.backing)).toBeNull();
  });

  it('publishes the run it started', () => {
    const run = drive();

    run.sink.records.length = 0;
    run.controller.startRun(run.engine.port, { seed: 'restarted-seed' });

    const [started] = run.sink.of('run-started');

    expect(started?.detail.runId).toBe(run.controller.runId());
    expect(started?.detail.stageIndex).toBe(0);
    expect(started?.detail.resumed).toBe(false);
    expect(started?.detail.seedProvided).toBe(true);
    expect(started?.correlationId).toBe(run.controller.correlationId());
  });
});

describe('resumeRun', () => {
  it('restores the seed, the run, the stage and the relics stored', () => {
    const backing = trackStorage(new MemoryStorage());
    const first = drive({ backing, seed: 'resume-this-run' });

    startStage(first, createEmptyBoard());
    takeReward(first, 'port-charged');
    takeReward(first, 'port-plain');
    first.controller.advanceStage();
    first.engine.hold(boardWithHighest(8));

    expect(first.controller.persist(first.engine.port, first.cursors)).toBe(
      true,
    );

    first.stop();

    const second = drive({ backing, observe: false });
    const resumed = second.controller.resumeRun(second.engine.port);

    expect(resumed).toBe('loaded');
    expect(second.controller.seed()).toBe('resume-this-run');
    expect(second.controller.runId()).toBe(first.controller.runId());
    expect(second.controller.stageIndex()).toBe(1);
    expect(second.controller.stageGoal()).toEqual(
      stageGoalForIndex(1, second.stages),
    );
    expect(second.controller.goalProgress()).toBe(
      first.controller.goalProgress(),
    );

    // Pickup order, carried across the reload exactly as it was recorded.
    expect(second.controller.relics().map((relic) => relic.id)).toEqual([
      'port-charged',
      'port-plain',
    ]);
  });

  it('continues the substream sequence instead of restarting it', () => {
    const backing = trackStorage(new MemoryStorage());
    const first = drive({ backing, seed: 'cursor-continuity' });

    draws(first.streams, 3);
    first.controller.persist(first.engine.port, first.cursors);
    first.stop();

    const stored = storedEnvelope(backing);

    for (const name of RNG_STREAM_NAMES) {
      expect(stored?.rngCursor[name]).toBe(3);
    }

    const second = drive({ backing, observe: false });

    second.controller.resumeRun(second.engine.port);

    const continued = createRngStreams(
      second.controller.seed(),
      second.controller.cursors(),
    );

    for (const name of RNG_STREAM_NAMES) {
      expect(continued.stream(name).cursor).toBe(3);
    }

    expect(draws(continued, 2)).toEqual(draws(first.streams, 2));
  });

  it('falls back to a fresh run when nothing is stored', () => {
    const run = drive({ observe: false });
    const outcomes: RunStateLoadOutcome[] = [];

    expect(() => {
      outcomes.push(run.controller.resumeRun(run.engine.port));
    }).not.toThrow();

    expect(outcomes).toEqual(['absent']);
    expect(run.controller.stageIndex()).toBe(0);
    expect(run.controller.relics()).toEqual([]);
    expect(run.controller.seed().length).toBeGreaterThan(0);

    // No envelope was read, so the engine's own port read of the legacy
    // snapshot is the remaining authority — js/game_manager.js L36.
    expect(run.engine.setups).toEqual([undefined]);
  });

  it('falls back to a fresh run for a corrupted payload, and reports it', () => {
    const backing = storageHolding({ [RUN_STATE_KEY]: '{not json at all' });

    // Composition itself must survive the payload; nothing here writes over
    // it, so the second composition below reads the same corrupted value.
    expect(() => drive({ backing, observe: false })).not.toThrow();

    const run = drive({ backing, observe: false });

    expect(run.outcome).toBe('fresh-fallback');

    const [corrupted] = run.sink.of('load-corrupted');

    expect(corrupted).toBeDefined();
    expect(corrupted?.detail.key).toBe(RUN_STATE_KEY);
    expect(typeof corrupted?.detail.verdict).toBe('string');
    expect(Array.isArray(corrupted?.detail.problems)).toBe(true);
    expect(corrupted?.correlationId).toBe(run.controller.correlationId());
    expect(corrupted?.correlationId.length).toBeGreaterThan(0);

    // The run is coherent afterwards.
    expect(run.controller.stageIndex()).toBe(0);
    expect(run.controller.relics()).toEqual([]);
    expect(run.controller.stageGoal()).toEqual(
      stageGoalForIndex(0, run.stages),
    );
    expect(run.controller.openingBoard()).toBeNull();

    expect(() => run.controller.resumeRun(run.engine.port)).not.toThrow();
    expect(run.controller.seed().length).toBeGreaterThan(0);
  });

  // The MINOR finding of the run-flow review. `state` is `null` for two
  // outcomes that mean opposite things — nothing was stored, and something was
  // stored and REFUSED — so deriving "was an envelope read" from the payload
  // answered `false` for a refused one. src/main.ts then took the clause that
  // exists for a save written BEFORE the upgrade and resumed the run onto that
  // pre-upgrade board, under a fresh run identifier and a fresh seed, while
  // logging `resumed: true`. DL-RUNCTL-21.
  it('reports a refused envelope as read, so it is not mistaken for absent', () => {
    const refusals: Readonly<Record<string, string>>[] = [
      { [RUN_STATE_KEY]: '{not json at all' },
      { [RUN_STATE_KEY]: '{"totally":"wrong"}' },
      { [RUN_STATE_KEY]: 'null' },
      {
        [RUN_STATE_KEY]: JSON.stringify({
          schemaVersion: 9999,
          runId: 'from-the-future',
          seed: 'unreadable',
        }),
      },
    ];

    for (const seeded of refusals) {
      const run = drive({ backing: storageHolding(seeded), observe: false });

      expect(run.outcome).not.toBe('absent');
      expect(run.controller.hadStoredEnvelope()).toBe(true);

      // No board was adopted, so there is nothing to resume ONTO — which is
      // exactly the state the flow must hold Run Start for.
      expect(run.controller.openingBoard()).toBeNull();

      run.stop();
    }
  });

  it('reports an absent envelope as unread, so a legacy save still loads', () => {
    const run = drive({ backing: storageHolding({}), observe: false });

    expect(run.outcome).toBe('absent');
    expect(run.controller.hadStoredEnvelope()).toBe(false);

    // `undefined`, not `null`: the engine falls back to its own port read of
    // the frozen `gameState` key, which is what keeps a board written by the
    // vanilla game loadable across the upgrade (AAP 0.4.1.3).
    expect(run.controller.board()).toBeUndefined();

    run.controller.resumeRun(run.engine.port);

    expect(run.engine.setups).toEqual([undefined]);
  });

  // The other half of the same contract, at the board-load seam: a refused
  // envelope opens a FRESH board rather than the engine's own stored one, so a
  // legacy snapshot cannot be revived behind it.
  it('opens a refused envelope on a fresh board, never on the stored one', () => {
    const run = drive({
      backing: storageHolding({ [RUN_STATE_KEY]: '{not json at all' }),
      observe: false,
    });

    run.controller.resumeRun(run.engine.port);

    expect(run.engine.setups).toEqual([null]);
    expect(run.engine.setups).not.toContain(undefined);

    run.stop();
  });
});

describe('endRun', () => {
  it('summarises the run and removes the envelope', () => {
    const run = drive();

    startStage(run, createEmptyBoard());
    takeReward(run, 'port-plain');
    run.engine.hold({ ...boardWithHighest(8), score: 320 });
    run.controller.persist(run.engine.port, run.cursors);

    expect(storedEnvelope(run.backing)).not.toBeNull();

    const summary = run.controller.endRun('abandoned');

    expect(summary.score).toBe(320);
    expect(summary.relics.map((relic) => relic.id)).toEqual(['port-plain']);

    // js/game_manager.js L85-L89 cleared the snapshot on a LOSS and not on a
    // win; an explicit end clears it whatever the outcome.
    expect(storedEnvelope(run.backing)).toBeNull();
    expect(run.store.exists()).toBe(false);
    expect(run.controller.lastSummary()).toEqual(summary);
  });

  it('ends once, and reports the same summary for a second call', () => {
    const run = drive();

    run.engine.hold({ ...createEmptyBoard(), score: 90 });
    run.controller.persist(run.engine.port, run.cursors);

    const first = run.controller.endRun('won');
    const second = run.controller.endRun('lost');

    expect(second).toEqual(first);
    expect(run.sink.of('run-ended')).toHaveLength(1);
  });

  it('redacts the seed from the report while the summary keeps it', () => {
    const run = drive({ seed: 'seed-stays-in-the-summary' });
    const summary = run.controller.endRun('abandoned');
    const [ended] = run.sink.of('run-ended');

    expect(summary.seed).toBe('seed-stays-in-the-summary');
    expect(ended?.detail.outcome).toBe('abandoned');
    expect(JSON.stringify(ended?.detail.summary)).not.toContain(
      'seed-stays-in-the-summary',
    );
    expect(ended?.correlationId).toBe(
      runCorrelationId('seed-stays-in-the-summary', summary.runId),
    );
  });

  it('leaves a fresh run in force, so the next commit starts at stage 0', () => {
    const run = drive();

    run.controller.advanceStage();
    run.controller.endRun('lost');

    expect(run.controller.stageIndex()).toBe(0);
    expect(run.controller.relics()).toEqual([]);
    expect(run.controller.goalProgress()).toBe(0);
  });
});

describe('a restart within a run', () => {
  it('keeps the stage and the relics, and does not end the run', () => {
    const run = drive();

    startStage(run, createEmptyBoard());
    takeReward(run, 'port-charged');
    run.controller.advanceStage();

    const stage = run.controller.stageIndex();
    const goal = run.controller.stageGoal();

    // js/game_manager.js L17-L21: the board is discarded and a fresh one
    // opens.
    run.engine.port.restart();
    startStage(run, createMergePairBoard());
    commit(run);

    expect(run.engine.calls).toContain('restart');
    expect(run.controller.stageIndex()).toBe(stage);
    expect(run.controller.stageGoal()).toEqual(goal);
    expect(run.controller.relics().map((relic) => relic.id)).toEqual([
      'port-charged',
    ]);
    expect(run.controller.lastSummary()).toBeNull();
    expect(run.sink.of('run-ended')).toEqual([]);
  });
});

describe('a lost run', () => {
  it('is finished and cleared by the commit that carries the loss', () => {
    const run = drive();

    startStage(run, createEmptyBoard());
    run.controller.persist(run.engine.port, run.cursors);

    expect(storedEnvelope(run.backing)).not.toBeNull();

    run.engine.hold({ ...boardWithHighest(8), score: 150, over: true });
    commit(run, true);

    const [ended] = run.sink.of('run-ended');
    const finished = run.controller.lastSummary();

    expect(ended?.detail.outcome).toBe('lost');

    // Reported under the identity of the run that ENDED.
    expect(ended?.correlationId).toBe(
      runCorrelationId(run.controller.seed(), finished?.runId),
    );
    expect(ended?.correlationId).not.toBe(run.controller.correlationId());

    // js/game_manager.js L85-L89 cleared the snapshot on a loss; the envelope
    // is cleared with it, so the two keys cannot disagree.
    expect(storedEnvelope(run.backing)).toBeNull();
    expect(finished?.score).toBe(150);
  });
});


/* ==========================================================================
 * 25b. The stage a run ended on is RESOLVED, exactly once, before the summary
 *
 * The contract asserted here: `finish()` resolves the stage in force with
 * `cleared: false` before it summarises, so the sixth lifecycle hook of AAP R2
 * fires for a stage that ended without meeting its goal. `endStage(false)` had no
 * production caller at all — an explicit end reached `finish()` from `endRun()`
 * and a loss reached it from the commit handler — so every handler and every
 * screen branch written for the uncleared outcome was unreachable code.
 *
 * Both terminal paths are asserted, the exactly-once property is asserted, and
 * the composed case drives a REAL engine and a REAL hook bus so the dispatch and
 * the emission are the shipped ones rather than a recording double's.
 * Decisions DL-RUNCTL-30, DL-ENGINE-15.
 * ========================================================================== */

describe('the stage a run ended on', () => {
  it('is resolved as uncleared when the player ends the run', () => {
    const run = drive();

    startStage(run, createEmptyBoard());
    resolveMove(run, boardWithHighest(8), 24);

    expect(run.engine.endStages).toEqual([]);

    run.controller.endRun('abandoned');

    // Exactly one resolution, and it carries the uncleared outcome.
    expect(run.engine.endStages).toEqual([false]);
    expect(run.controller.lastSummary()).not.toBeNull();
  });

  it('is resolved as uncleared by the commit that carries the loss', () => {
    const run = drive();

    startStage(run, createEmptyBoard());
    run.engine.hold({ ...boardWithHighest(8), score: 150, over: true });
    commit(run, true);

    expect(run.engine.endStages).toEqual([false]);
    expect(run.sink.of('run-ended')[0]?.detail.outcome).toBe('lost');
  });

  it('resolves it once however many times the run is ended', () => {
    const run = drive();

    startStage(run, createEmptyBoard());

    run.controller.endRun('abandoned');
    run.controller.endRun('abandoned');
    run.controller.endRun('lost');

    // `endRun` is idempotent, and the resolution rides on the one finish it
    // performs — so a screen that sends the action twice does not end the stage
    // twice, and no second `onRunEnded` is reported either.
    expect(run.engine.endStages).toEqual([false]);
    expect(run.sink.of('run-ended')).toHaveLength(1);
  });

  it('resolves nothing when the controller observes no engine', () => {
    const run = drive({ observe: false });

    run.controller.endRun('abandoned');

    // A controller composed alone — which is most of this suite — keeps exactly
    // its previous behaviour: it summarises and clears, and resolves no stage on
    // an engine it is not attached to.
    expect(run.engine.endStages).toEqual([]);
    expect(run.controller.lastSummary()).not.toBeNull();
  });

  it('draws no reward and starts no stage while it is finishing', () => {
    const run = drive({
      offers: [
        {
          id: 'port-plain',
          name: 'Plain',
          rarity: 'common',
          description: 'A relic with no budget.',
          hooks: Object.freeze(['onMerge']),
        },
      ],
    });

    startStage(run, createEmptyBoard());
    resolveMove(run, boardWithHighest(16), 400);

    const startsBefore = run.engine.startStages.length;

    run.controller.endRun('abandoned');

    // The stage's goal was MET when the run ended, so the commit the resolution
    // produces re-enters the commit handler with `stageCleared` standing. Nothing
    // may be drawn or opened for a run that is ending.
    expect(run.engine.endStages).toEqual([false]);
    expect(run.controller.isRewardPending()).toBe(false);
    expect(run.engine.startStages).toHaveLength(startsBefore);
    expect(run.sink.of('reward-drawn')).toEqual([]);
  });

  it('dispatches onStageEnd and emits stage:end through a real engine', () => {
    const backing = new MemoryStorage();
    const manager = new LocalStorageManager({ storage: backing });
    const config = createDefaultRulesConfig();
    const stages = createDefaultStageConfig();
    const hooks = createHookBus();
    const dispatched: boolean[] = [];

    expect(
      hooks.register({
        id: 'uncleared-probe',
        hooks: {
          onStageEnd: (payload): void => {
            dispatched.push(payload.cleared);
          },
        },
      }),
    ).toBe(true);

    const controller = new RunController({
      store: new RunStateStore({ storage: manager, config }),
      identity: resolveRunIdentity({
        storage: manager,
        createToken: (): string => 'uncleared-stage-run',
      }),
      config,
      stages,
      createToken: (): string => 'uncleared-stage-run',
    });

    controller.begin();

    const streams = createRngStreams(controller.seed(), controller.cursors());
    const engine = new Engine({
      config,
      stages,
      streams,
      hooks,
      stageContext: (): StageCommitContext => controller.stageContext(),
    });

    const emitted: boolean[] = [];

    engine.events.on('stage:end', (event): void => {
      emitted.push(event.cleared);
    });

    const stop = controller.observe(engine, () => streams.snapshotCursors());

    controller.openEngineBoard(engine);
    engine.move(DIRECTION_LEFT);

    expect(dispatched).toEqual([]);
    expect(emitted).toEqual([]);

    controller.endRun('abandoned');

    // The shipped dispatch and the shipped emission, both carrying the uncleared
    // outcome, exactly once.
    expect(dispatched).toEqual([false]);
    expect(emitted).toEqual([false]);

    stop();
  });
});


describe('resolveReward records the relic it took on', () => {
  it('records an identifier alone for a relic carrying nothing else', () => {
    const run = drive();

    expect(takeReward(run, 'port-plain')).toEqual({
      accepted: true,
      refusal: null,
    });

    const [held] = run.controller.relics();

    expect(held).toEqual({ id: 'port-plain' });
    expect(Object.keys(held ?? {})).toEqual(['id']);
    expect('charges' in (held ?? {})).toBe(false);
    expect('state' in (held ?? {})).toBe(false);
  });

  it('records the budget of a relic that carries one, and nothing more', () => {
    const run = drive();

    takeReward(run, 'port-charged');

    const [held] = run.controller.relics();

    expect(held).toEqual({ id: 'port-charged', charges: 3 });
    expect(Object.keys(held ?? {}).sort()).toEqual(['charges', 'id']);
    expect('state' in (held ?? {})).toBe(false);
  });

  it('carries an opaque state slot through without reshaping it', () => {
    const run = drive();

    takeReward(run, 'port-stateful');

    const [held] = run.controller.relics();

    expect(held).toEqual({
      id: 'port-stateful',
      charges: 2,
      state: { spent: 0 },
    });
    expect(Object.keys(held ?? {}).sort()).toEqual([
      'charges',
      'id',
      'state',
    ]);
  });

  it('records nothing beyond the triple, whatever the registry returned', () => {
    const run = drive();

    takeReward(run, 'port-stateful');
    takeReward(run, 'port-charged');
    takeReward(run, 'port-plain');

    for (const relic of run.controller.relics()) {
      for (const member of Object.keys(relic)) {
        expect(['id', 'charges', 'state']).toContain(member);
      }
    }
  });
});

describe('the order relics are recorded in', () => {
  it('is pickup order, appended and never sorted', () => {
    const run = drive();

    takeReward(run, 'port-stateful');
    takeReward(run, 'port-plain');
    takeReward(run, 'port-charged');

    expect(run.controller.relics().map((relic) => relic.id)).toEqual([
      'port-stateful',
      'port-plain',
      'port-charged',
    ]);

    // The live registry agrees, so the order a hook bus would dispatch in and
    // the order the envelope carries are one order.
    expect(run.registry.picked()).toEqual([
      'port-stateful',
      'port-plain',
      'port-charged',
    ]);
  });

  it('survives a persist and a resume', () => {
    const backing = trackStorage(new MemoryStorage());
    const first = drive({ backing, seed: 'pickup-order-survives' });

    takeReward(first, 'port-charged');
    takeReward(first, 'port-second-plain');
    takeReward(first, 'port-plain');
    first.controller.persist(first.engine.port, first.cursors);
    first.stop();

    expect(storedEnvelope(backing)?.relics.map((relic) => relic.id)).toEqual([
      'port-charged',
      'port-second-plain',
      'port-plain',
    ]);

    const second = drive({ backing, observe: false });

    expect(second.controller.relics().map((relic) => relic.id)).toEqual([
      'port-charged',
      'port-second-plain',
      'port-plain',
    ]);

    expect(second.registry.picked()).toEqual([
      'port-charged',
      'port-second-plain',
      'port-plain',
    ]);
    expect(second.registry.calls).toContain('restoreRelics');
  });

  it('appends at the end, leaving every earlier position where it was', () => {
    const run = drive();

    takeReward(run, 'port-plain');

    const before = run.controller.relics();

    takeReward(run, 'port-charged');

    const after = run.controller.relics();

    expect(after.slice(0, before.length)).toEqual(before);
    expect(after[after.length - 1]?.id).toBe('port-charged');
  });
});

describe('a selection the run cannot take', () => {
  it('refuses an identifier that was never offered, without throwing', () => {
    const run = drive();

    takeReward(run, 'port-plain');

    const resolution = run.controller.resolveReward('port-charged');

    expect(resolution).toEqual({ accepted: false, refusal: 'not-offered' });
    expect(run.controller.relics().map((relic) => relic.id)).toEqual([
      'port-plain',
    ]);
  });

  it('refuses an unknown identifier and reports it with usable detail', () => {
    const run = drive();

    // Offered while the catalogue carried it, withdrawn before the selection:
    // the offer stands, and the membership question now answers no.
    run.controller.recordRewardOffer(['port-charged']);
    run.registry.forget('port-charged');

    const resolution = run.controller.resolveReward('port-charged');

    expect(resolution).toEqual({ accepted: false, refusal: 'unknown' });

    // The run is coherent: nothing was recorded and nothing was half-recorded.
    expect(run.controller.relics()).toEqual([]);
    expect(run.registry.picked()).toEqual([]);
    expect(run.controller.stageIndex()).toBe(0);

    const drawn = run.sink.of('reward-drawn');
    const last = drawn[drawn.length - 1];

    expect(last?.detail.selectedRelicId).toBe('port-charged');
    expect(last?.detail.refusal).toBe('unknown');
    expect(last?.detail.accepted).toBe(false);
    expect(last?.detail.offeredRelicIds).toEqual(['port-charged']);
    expect(last?.correlationId).toBe(run.controller.correlationId());
    expect(last?.correlationId.length).toBeGreaterThan(0);
  });

  it('refuses an offer the catalogue never carried, and reports the offer', () => {
    const run = drive();

    expect(run.controller.recordRewardOffer(['no-such-relic'])).toBe(false);

    const [offered] = run.sink.of('reward-drawn');

    expect(offered?.detail.refusal).toBe('offer');
    expect(offered?.detail.selectedRelicId).toBeUndefined();

    // Nothing was offered, so nothing can be selected from it.
    expect(run.controller.resolveReward('no-such-relic')).toEqual({
      accepted: false,
      refusal: 'not-offered',
    });
    expect(run.controller.relics()).toEqual([]);
  });

  it('refuses an empty identifier', () => {
    const run = drive();

    expect(run.controller.resolveReward('')).toEqual({
      accepted: false,
      refusal: 'not-offered',
    });
    expect(run.controller.relics()).toEqual([]);
  });

  it('refuses a relic the run already holds', () => {
    const run = drive();

    expect(takeReward(run, 'port-charged').accepted).toBe(true);

    const again = takeReward(run, 'port-charged');

    expect(again).toEqual({ accepted: false, refusal: 'held' });
    expect(run.controller.relics().map((relic) => relic.id)).toEqual([
      'port-charged',
    ]);
    expect(run.registry.picked()).toEqual(['port-charged']);
  });

  it('withdraws the record when the registry refuses the pickup', () => {
    const run = drive();

    run.registry.refuseEveryPickup();

    const resolution = takeReward(run, 'port-plain');

    expect(resolution).toEqual({ accepted: false, refusal: 'refused' });
    expect(run.controller.relics()).toEqual([]);
    expect(storedEnvelope(run.backing)).toBeNull();
  });

  it('refuses a relic once the run already holds the persisted maximum', () => {
    // THE FOURTH GATE. An envelope carrying more than `MAX_PERSISTED_RELICS` is
    // refused by the store, so a run standing at the ceiling must refuse the
    // pickup rather than accept it and lose the whole run on the next write.
    // The ceiling is reached the way a long run reaches it: through the stored
    // envelope, whose relics `begin()` adopts when its seed is the seed the run
    // is played under.
    const seed = 'held-to-the-ceiling';
    const held: PersistedRelic[] = Array.from(
      { length: MAX_PERSISTED_RELICS },
      (_entry, index): PersistedRelic => ({
        id: `ceiling-relic-${String(index)}`,
      }),
    );
    const backing = storageHolding({
      [RUN_STATE_KEY]: JSON.stringify(
        envelopeHolding('ceiling-run', seed, held),
      ),
    });
    const run = drive({
      backing,
      seed,
      observe: false,
      catalogue: held.map((relic): string => relic.id),
    });

    expect(run.outcome).toBe('loaded');
    expect(run.controller.relics()).toHaveLength(MAX_PERSISTED_RELICS);

    const before = run.controller.relics();
    const written = storedEnvelope(backing);
    const picksBefore = [...run.registry.picked()];

    // Offered, catalogued and unheld, so the first three gates all pass and the
    // ceiling is the one that refuses.
    expect(run.controller.recordRewardOffer(['port-plain'])).toBe(true);

    const resolution = run.controller.resolveReward('port-plain');

    expect(resolution).toEqual({ accepted: false, refusal: 'full' });

    // THE OFFER IS RETAINED. A cleared offer would report `'not-offered'` on the
    // second attempt, because that is the first gate; reporting `'full'` again
    // is what says the same card is still standing to be chosen.
    expect(run.controller.resolveReward('port-plain')).toEqual({
      accepted: false,
      refusal: 'full',
    });

    // NO PICKUP: the registry was never asked to take the relic on, so nothing
    // reached the hook bus.
    expect(run.registry.picked()).toEqual(picksBefore);
    expect(run.registry.calls).not.toContain('pickUpRelic');

    // NO STATE MUTATION and NO WRITE: the held list is the one the envelope
    // carried, and the stored payload is byte-for-byte the one that was there.
    expect(run.controller.relics()).toEqual(before);
    expect(run.controller.relics()).toHaveLength(MAX_PERSISTED_RELICS);
    expect(storedEnvelope(backing)).toEqual(written);

    // REPORTED, naming the step that refused it.
    const drawn = run.sink.of('reward-drawn');
    const last = drawn[drawn.length - 1];

    expect(last?.detail.refusal).toBe('full');
    expect(last?.detail.accepted).toBe(false);
    expect(last?.detail.selectedRelicId).toBe('port-plain');
    expect(last?.detail.offeredRelicIds).toEqual(['port-plain']);
    expect(last?.correlationId).toBe(run.controller.correlationId());
  });

  it('accepts the same relic one place below the ceiling', () => {
    // The pair to the case above: the ceiling refuses and nothing else does, so
    // one relic fewer accepts the identical selection.
    const seed = 'one-below-the-ceiling';
    const held: PersistedRelic[] = Array.from(
      { length: MAX_PERSISTED_RELICS - 1 },
      (_entry, index): PersistedRelic => ({
        id: `ceiling-relic-${String(index)}`,
      }),
    );
    const backing = storageHolding({
      [RUN_STATE_KEY]: JSON.stringify(
        envelopeHolding('nearly-full-run', seed, held),
      ),
    });
    const run = drive({
      backing,
      seed,
      observe: false,
      catalogue: held.map((relic): string => relic.id),
    });

    expect(run.controller.relics()).toHaveLength(MAX_PERSISTED_RELICS - 1);
    expect(takeReward(run, 'port-plain')).toEqual({
      accepted: true,
      refusal: null,
    });
    expect(run.controller.relics()).toHaveLength(MAX_PERSISTED_RELICS);

    // The registry took it on, APPENDED after everything already held, so the
    // pickup order the envelope carried is untouched.
    expect(run.registry.picked().at(-1)).toBe('port-plain');
    expect(run.registry.calls).toContain('pickUpRelic');
    expect(run.controller.relics().at(-1)?.id).toBe('port-plain');

    // At the ceiling now, so the next offered relic is refused for capacity.
    run.controller.recordRewardOffer(['port-charged']);

    expect(run.controller.resolveReward('port-charged')).toEqual({
      accepted: false,
      refusal: 'full',
    });
  });

  it('refuses selectReward at the ceiling without seating the relic live', () => {
    // The capacity gate was measured by `resolveReward` alone, and
    // `selectReward` reached the registry FIRST — so at the ceiling the relic was
    // registered with the hook bus and only then refused by the append, leaving a
    // relic firing that no envelope carried and no reload would restore.
    const seed = 'select-at-the-ceiling';
    const held: PersistedRelic[] = Array.from(
      { length: MAX_PERSISTED_RELICS },
      (_entry, index): PersistedRelic => ({
        id: `ceiling-relic-${String(index)}`,
      }),
    );
    const backing = storageHolding({
      [RUN_STATE_KEY]: JSON.stringify(
        envelopeHolding('ceiling-run', seed, held),
      ),
    });
    const run = drive({
      backing,
      seed,
      observe: false,
      catalogue: held.map((relic): string => relic.id),
      offers: [drivenOffer('port-plain')],
    });

    expect(run.controller.relics()).toHaveLength(MAX_PERSISTED_RELICS);

    const before = run.controller.relics();
    const written = storedEnvelope(backing);
    const picksBefore = [...run.registry.picked()];
    const stageBefore = run.controller.stageIndex();

    expect(run.controller.offerReward().map((offer) => offer.id)).toEqual([
      'port-plain',
    ]);

    const selection = run.controller.selectReward(
      'port-plain',
      run.engine.port,
    );

    expect(selection.outcome).toBe('refused');
    expect(selection.relicId).toBe('port-plain');

    // NOTHING WAS SEATED: the registry was never asked to take it on.
    expect(run.registry.picked()).toEqual(picksBefore);
    expect(run.registry.calls).not.toContain('pickUpRelic');
    expect(run.registry.calls).not.toContain('activateRelic');

    // The envelope, the stage and the offer are all where they were.
    expect(run.controller.relics()).toEqual(before);
    expect(storedEnvelope(backing)).toEqual(written);
    expect(run.controller.stageIndex()).toBe(stageBefore);
    expect(run.controller.isRewardPending()).toBe(true);
    expect(run.controller.currentOffer().map((offer) => offer.id)).toEqual([
      'port-plain',
    ]);
    expect(run.engine.startedStages).toBe(0);

    // And the refusal is reported.
    const drawn = run.sink.of('reward-drawn');

    expect(drawn[drawn.length - 1]?.detail.refusal).toBe('refused');
  });

  it('withdraws the live pickup when the write still refuses', () => {
    // The last line behind the gate above: a step that refuses AFTER the pickup —
    // here the write, which no preflight can see — must not leave the relic
    // seated. Refused at the storage boundary, so the refusal travels the
    // production path.
    const run = drive({
      observe: false,
      offers: [drivenOffer('port-plain')],
    });

    expect(run.controller.offerReward().map((offer) => offer.id)).toEqual([
      'port-plain',
    ]);

    run.backing.setItem = (): void => {
      throw new Error('QuotaExceededError');
    };

    const selection = run.controller.selectReward(
      'port-plain',
      run.engine.port,
    );

    expect(selection.outcome).toBe('refused');
    expect(run.controller.relics()).toEqual([]);

    // Withdrawn live as well as in the envelope: the registry holds nothing, so
    // no relic is left firing for a run that does not record it.
    expect(run.registry.held()).toEqual([]);
    expect(run.controller.state().relics).toEqual([]);

    // And the stage was never opened for a selection that was refused.
    expect(run.engine.startedStages).toBe(0);
  });
});

describe('a stage transition whose opener refuses', () => {
  it('contains a throwing opener on selectReward and leaves the open ' +
    'pending, retryable', () => {
    const run = drive({
      observe: false,
      startStageThrows: true,
      offers: [drivenOffer('port-plain')],
    });

    expect(run.controller.offerReward().map((offer) => offer.id)).toEqual([
      'port-plain',
    ]);

    const selection = run.controller.selectReward(
      'port-plain',
      run.engine.port,
    );

    // The reward is committed: the relic is held and the envelope carries it.
    expect(selection.outcome).toBe('accepted');
    expect(run.controller.relics().map((relic) => relic.id)).toEqual([
      'port-plain',
    ]);
    expect(storedEnvelope(run.backing)?.relics.map((relic) => relic.id))
      .toEqual(['port-plain']);

    // The open failed, was contained, and is recorded as owed.
    expect(run.engine.startStageAttempts).toBe(1);
    expect(run.engine.startedStages).toBe(0);
    expect(run.controller.stageOpenPending()).toBe(
      run.controller.stageIndex(),
    );
    expect(run.sink.of('write-failed')).not.toHaveLength(0);

    // The retry opens it, and the debt clears.
    run.engine.startStageThrows = false;

    expect(run.controller.openPendingStage(run.engine.port)).toBe(true);
    expect(run.engine.startedStages).toBe(1);
    expect(run.controller.stageOpenPending()).toBeNull();

    // Idempotent: nothing is owed, so a second retry opens nothing.
    expect(run.controller.openPendingStage(run.engine.port)).toBe(false);
    expect(run.engine.startedStages).toBe(1);
  });

  it('contains a throwing opener on completeReward, so the reward it ' +
    'persisted still stands', () => {
    const run = drive({
      observe: false,
      startStageThrows: true,
      offers: [drivenOffer('port-plain')],
    });

    expect(run.controller.offerReward().map((offer) => offer.id)).toEqual([
      'port-plain',
    ]);

    let resolution: RewardResolution | null = null;

    // The throw used to escape this call, AFTER the reward had been persisted.
    expect(() => {
      resolution = run.controller.completeReward(run.engine.port, 'port-plain');
    }).not.toThrow();

    expect(resolution).toEqual({ accepted: true, refusal: null });
    expect(run.controller.relics().map((relic) => relic.id)).toEqual([
      'port-plain',
    ]);
    expect(run.controller.stageOpenPending()).toBe(
      run.controller.stageIndex(),
    );

    run.engine.startStageThrows = false;

    expect(run.controller.openPendingStage(run.engine.port)).toBe(true);
    expect(run.controller.stageOpenPending()).toBeNull();
  });

  it('drops a debt the run has already advanced past', () => {
    const run = drive({
      observe: false,
      startStageThrows: true,
      offers: [drivenOffer('port-plain')],
    });

    expect(run.controller.offerReward().map((offer) => offer.id)).toEqual([
      'port-plain',
    ]);
    run.controller.selectReward('port-plain', run.engine.port);

    const owed = run.controller.stageOpenPending();

    expect(owed).not.toBeNull();

    // The run advances by another route, so the stage that was owed an open is
    // no longer the stage in force.
    run.controller.advanceStage();
    run.engine.startStageThrows = false;

    expect(run.controller.openPendingStage(run.engine.port)).toBe(false);
    expect(run.controller.stageOpenPending()).toBeNull();
    expect(run.engine.startedStages).toBe(0);
  });
});

/* ==========================================================================
 * A REPORTER THAT THROWS ON ONE CHANNEL
 *
 * Every `this.reporter.*` call in the controller now runs inside `emit()`, which
 * mirrors `RunStateStore.emit`. Before that, an observer that raised took the
 * caller down with it: a logger that threw on `onRunStarted` aborted `begin()`
 * mid-adoption, and one that threw on `onRewardDrawn` aborted a selection AFTER
 * the envelope had been written — the run and its envelope disagreeing because a
 * REPORT failed. Observation is not part of the transaction. DL-RUNCTL-22.
 * ========================================================================== */

describe('a reporter that throws on one channel', () => {
  it('lists every channel the interface declares', () => {
    // The matrix below is only exhaustive while this holds. `NOOP_RUN_REPORTER`
    // implements every member, so its own keys are the interface's channel set.
    expect([...REPORTER_CHANNELS].sort()).toEqual(
      Object.keys(NOOP_RUN_REPORTER).sort(),
    );
  });

  for (const channel of REPORTER_CHANNELS) {
    it(`completes the whole lifecycle while ${channel} throws`, () => {
      const run = drive({
        throwOn: channel,
        offers: [drivenOffer('port-plain'), drivenOffer('port-charged')],
      });

      // ADOPTION. `begin()` already ran inside `drive`, so reaching here at all
      // is the proof for `onRunStarted`; the rest is driven below.
      expect(run.outcome).toBeDefined();
      expect(run.controller.runId()).not.toBe('');

      // A ROUND, DRAWN AND SELECTED: `onRewardOffered` and `onRewardDrawn`.
      const offered = withoutThrowing((): readonly RewardOffer[] =>
        run.controller.offerReward(),
      );

      expect(offered.map((offer) => offer.id)).toEqual([
        'port-plain',
        'port-charged',
      ]);

      const selection = withoutThrowing((): RewardSelection =>
        run.controller.selectReward('port-plain', run.engine.port),
      );

      expect(selection.outcome).toBe('accepted');

      // THE TRANSACTION COMMITTED, whichever channel broke: the relic is held
      // live, the envelope carries it, and the stage advanced.
      expect(run.registry.held().map((relic) => relic.id)).toEqual([
        'port-plain',
      ]);
      expect(run.controller.relics().map((relic) => relic.id)).toEqual([
        'port-plain',
      ]);
      expect(
        storedEnvelope(run.backing)?.relics.map((relic) => relic.id),
      ).toEqual(['port-plain']);
      expect(run.controller.stageIndex()).toBe(1);

      // A FURTHER ADVANCE: `onStageAdvanced`.
      withoutThrowing((): void => {
        run.controller.advanceStage();
      });

      expect(run.controller.stageIndex()).toBe(2);

      // A REFUSED WRITE: `onWriteFailed` and `onPersistenceStatusChanged`.
      run.backing.setItem = (): void => {
        throw new Error('QuotaExceededError');
      };

      withoutThrowing((): boolean =>
        run.controller.persist(run.engine.port, run.cursors),
      );

      expect(run.controller.persistenceStatus()).toBe('ephemeral');

      // THE RUN ENDS: `onRunEnded`, over a store that is still refusing.
      const summary = withoutThrowing((): RunSummary =>
        run.controller.endRun('abandoned'),
      );

      expect(summary.stageIndex).toBe(2);

      // Ended, so a second offer is refused rather than drawn.
      expect(run.controller.offerReward()).toEqual([]);

      // AND EVERY OTHER CHANNEL STILL REPORTED. The broken one records nothing,
      // so it is the only kind missing from the sink.
      const kinds = new Set(run.sink.records.map((record) => record.kind));

      expect(kinds.size).toBeGreaterThan(0);
    });
  }

  it('reports through every channel when none of them throw', () => {
    // The control for the matrix above: the same drive with a working reporter
    // reaches the four channels the sequence exercises, so a matrix case that
    // passes because nothing was ever reported cannot pass silently.
    const run = drive({
      offers: [drivenOffer('port-plain'), drivenOffer('port-charged')],
    });

    run.controller.offerReward();
    run.controller.selectReward('port-plain', run.engine.port);
    run.controller.advanceStage();

    run.backing.setItem = (): void => {
      throw new Error('QuotaExceededError');
    };

    run.controller.persist(run.engine.port, run.cursors);
    run.controller.endRun('abandoned');

    const kinds = new Set(run.sink.records.map((record) => record.kind));

    expect([...kinds].sort()).toEqual(
      [
        'persistence-status-changed',
        'reward-drawn',
        'reward-offered',
        'run-ended',
        'run-started',
        'stage-advanced',
        'write-failed',
      ].sort(),
    );
  });

  it('does not let a corruption report abort adoption', () => {
    // The store's own channels reach the controller's caller too: `begin()`
    // reads a corrupted envelope, the store reports it, and an observer that
    // throws there must not stop the run opening fresh.
    const backing = storageHolding({ [RUN_STATE_KEY]: '{ not json' });
    const run = drive({ backing, throwOn: 'onLoadCorrupted', observe: false });

    // The store refuses the payload and answers with the fallback it opened.
    expect(run.outcome).toBe('fresh-fallback');
    expect(run.controller.stageIndex()).toBe(0);
    expect(run.controller.relics()).toEqual([]);
    expect(run.controller.seed()).not.toBe('');
  });
});

/* ==========================================================================
 * A REGISTRY PORT WHOSE MEMBERS LIVE ON A PROTOTYPE
 *
 * `RelicRegistryPort` declares PAIRED SPELLINGS for the same operation —
 * `serialize`/`snapshotRelics`, `restore`/`restoreRelics`,
 * `persistedEntry`/`resolveRelic`, `knows`/`knowsRelic`,
 * `pickUp`/`pickUpRelic`/`activateRelic` — because a `RelicRegistry` INSTANCE
 * satisfies one half of every pair and `RelicRegistry.runPort()` the other.
 * A caller may legitimately hand over either.
 *
 * Two defects lived here. The withdraw and the restore read `restoreRelics`
 * alone, so an instance-shaped port silently restored nothing; and every member
 * pulled into a local was invoked as a BARE FUNCTION, which for a class method
 * reading `this` is a `TypeError`. Both are invisible to a port composed of
 * arrow-function properties, which is what every double in this file was.
 * DL-RUNCTL-27.
 * ========================================================================== */

/**
 * A registry port published as a CLASS, using only the ALIAS spellings.
 *
 * Every member reads `this`, so any one of them invoked as a bare function
 * raises rather than misbehaving quietly — which is what makes this double able
 * to detect a lost receiver at all. It publishes no `holdsRelic`, no
 * `ownedRelicIds` and neither of the `*Relic` activation spellings, so the
 * controller must reach it through the alias half of every pair.
 */
class AliasRegistry {
  /** Relics seated, in pickup order. */
  private readonly seated: PersistedRelic[] = [];

  /** Every member called, in order. */
  readonly calls: string[] = [];

  /** Each list handed to `restore`, in order. */
  readonly restorations: PersistedRelic[][] = [];

  constructor(private readonly known: readonly string[]) {}

  knows(relicId: string): boolean {
    this.note('knows');

    return this.known.includes(relicId);
  }

  pickUp(relicId: string): unknown {
    this.note('pickUp');

    if (!this.known.includes(relicId)) {
      return undefined;
    }

    this.seated.push({ id: relicId });

    return { id: relicId };
  }

  persistedEntry(relicId: string): PersistedRelic | null {
    this.note('persistedEntry');

    return this.seated.find((relic): boolean => relic.id === relicId) ?? null;
  }

  serialize(): readonly PersistedRelic[] {
    this.note('serialize');

    return this.seated.map((relic): PersistedRelic => ({ ...relic }));
  }

  restore(relics: readonly PersistedRelic[]): void {
    this.note('restore');
    this.restorations.push(relics.map((relic): PersistedRelic => ({ ...relic })));
    this.seated.length = 0;
    this.seated.push(...relics.map((relic): PersistedRelic => ({ ...relic })));
  }

  /** What the double is holding, for a case to read back. */
  held(): readonly PersistedRelic[] {
    return this.seated.map((relic): PersistedRelic => ({ ...relic }));
  }

  /**
   * Records one call. Reading `this.calls` is what fails for a member invoked
   * with the wrong receiver.
   */
  private note(member: string): void {
    this.calls.push(member);
  }
}

/**
 * One controller composed over a port whose members live on a prototype.
 *
 * @param options The store to compose over, the seed, and the identifiers the
 *   double knows.
 * @returns The controller, the double and the sink.
 */
function composeOverClass(options: {
  readonly backing?: MemoryStorage;
  readonly seed?: string;
  readonly known?: readonly string[];
  readonly registry?: RelicRegistryPort;
} = {}): {
  readonly controller: RunController;
  readonly registry: AliasRegistry;
  readonly backing: MemoryStorage;
  readonly sink: ReportSink;
  readonly outcome: RunStateLoadOutcome;
} {
  const backing = options.backing ?? new MemoryStorage();
  const manager = new LocalStorageManager({ storage: backing });
  const config = createDefaultRulesConfig();
  const stages = createDefaultStageConfig();
  const sink = createReportSink();
  const registry = new AliasRegistry(
    options.known ?? ['alias-one', 'alias-two'],
  );
  let serial = 0;

  const controller = new RunController({
    store: new RunStateStore({
      storage: manager,
      config,
      reporter: sink.reporter,
    }),
    identity: resolveRunIdentity({
      storage: manager,
      createToken: (): string => {
        serial += 1;

        return `alias-run-${String(serial)}`;
      },
      seed: identitySeed(manager, options.seed),
    }),
    config,
    stages,
    createToken: (): string => {
      serial += 1;

      return `alias-token-${String(serial)}`;
    },
    reporter: sink.reporter,

    // The instance itself, which is one of the two shapes the port declares.
    relics: options.registry ?? (registry as unknown as RelicRegistryPort),
  });

  const outcome = controller.begin();

  return { controller, registry, backing, sink, outcome };
}

describe('a registry port whose members live on a prototype', () => {
  it('takes a relic on through the alias spellings alone', () => {
    const composed = composeOverClass();

    expect(composed.controller.recordRewardOffer(['alias-one'])).toBe(true);
    expect(composed.controller.resolveReward('alias-one')).toEqual({
      accepted: true,
      refusal: null,
    });

    // SEATED LIVE, and the entry appended is the one the double produced.
    expect(composed.registry.held().map((relic) => relic.id)).toEqual([
      'alias-one',
    ]);
    expect(composed.controller.relics().map((relic) => relic.id)).toEqual([
      'alias-one',
    ]);

    // Reached through the alias half of every pair, each with its owner as the
    // receiver — a bare call would have raised inside `note()`.
    expect(composed.registry.calls).toContain('knows');
    expect(composed.registry.calls).toContain('pickUp');
    expect(composed.registry.calls).toContain('persistedEntry');
  });

  it('refuses an identifier the alias catalogue does not know', () => {
    const composed = composeOverClass();

    composed.controller.recordRewardOffer(['alias-absent']);

    expect(composed.controller.resolveReward('alias-absent').accepted).toBe(
      false,
    );
    expect(composed.registry.held()).toEqual([]);
    expect(composed.controller.relics()).toEqual([]);
  });

  it('projects the held relics through the `serialize` alias on commit', () => {
    const composed = composeOverClass();

    expect(composed.controller.recordRewardOffer(['alias-two'])).toBe(true);
    expect(composed.controller.resolveReward('alias-two').accepted).toBe(true);

    // `resolveReward` writes as part of its own transaction, and the relics it
    // writes are the ones the registry projects.
    expect(composed.registry.calls).toContain('serialize');
    expect(
      storedEnvelope(composed.backing)?.relics.map((relic) => relic.id),
    ).toEqual(['alias-two']);
  });

  it('restores a resumed run through the `restore` alias', () => {
    // The defect: the restore read `restoreRelics` alone, so an instance-shaped
    // port was handed nothing and a resumed run held relics the envelope
    // recorded and the registry had never seated — every hook they bind silent
    // for the rest of the run.
    const seed = 'alias-restore';
    const backing = storageHolding({
      [RUN_STATE_KEY]: JSON.stringify(
        envelopeHolding('alias-restored-run', seed, [
          { id: 'alias-one' },
          { id: 'alias-two', charges: 2 },
        ]),
      ),
    });
    const composed = composeOverClass({ backing, seed });

    expect(composed.outcome).toBe('loaded');
    expect(composed.controller.relics().map((relic) => relic.id)).toEqual([
      'alias-one',
      'alias-two',
    ]);

    // HANDED OVER, through the alias, with the charges the envelope carried.
    expect(composed.registry.calls).toContain('restore');
    expect(composed.registry.restorations.at(-1)).toEqual([
      { id: 'alias-one' },
      { id: 'alias-two', charges: 2 },
    ]);
    expect(composed.registry.held().map((relic) => relic.id)).toEqual([
      'alias-one',
      'alias-two',
    ]);
  });

  it('withdraws through the `restore` alias when a write is refused', () => {
    // The withdraw read `restoreRelics` too, so a refused write rolled the
    // envelope back and left the relic seated live.
    const composed = composeOverClass();

    expect(composed.controller.recordRewardOffer(['alias-one'])).toBe(true);

    composed.backing.setItem = (): void => {
      throw new Error('QuotaExceededError');
    };

    expect(composed.controller.resolveReward('alias-one')).toEqual({
      accepted: false,
      refusal: 'refused',
    });

    // Rolled back on BOTH sides, and the roll-back went through the alias.
    expect(composed.controller.relics()).toEqual([]);
    expect(composed.registry.calls).toContain('restore');
    expect(composed.registry.held()).toEqual([]);
    expect(composed.registry.restorations.at(-1)).toEqual([]);
  });

  it('composes over a real RelicRegistry instance end to end', () => {
    // The other half of the same contract: not a double at all, but the class
    // src/relics publishes, handed over as the instance rather than through
    // `runPort()`. Every member the controller reaches on it is a prototype
    // method.
    const backing = new MemoryStorage();
    const manager = new LocalStorageManager({ storage: backing });
    const config = createDefaultRulesConfig();
    const stages = createDefaultStageConfig();
    const sink = createReportSink();
    const bus = createHookBus({ correlationId: 'alias-instance' });
    const registry = new RelicRegistry({ bus, catalogue: RELIC_CATALOGUE });
    const chosen = RELIC_CATALOGUE[0]?.id ?? '';
    let serial = 0;
    const createToken = (): string => {
      serial += 1;

      return `instance-${String(serial)}`;
    };
    const controller = new RunController({
      store: new RunStateStore({ storage: manager, config }),
      identity: resolveRunIdentity({ storage: manager, createToken }),
      config,
      stages,
      createToken,
      reporter: sink.reporter,

      // The INSTANCE, not `runPort()`.
      relics: registry as unknown as RelicRegistryPort,
    });

    controller.begin();

    expect(controller.recordRewardOffer([chosen])).toBe(true);
    expect(controller.resolveReward(chosen)).toEqual({
      accepted: true,
      refusal: null,
    });

    // Seated on the live bus, which is the only thing that makes a relic fire.
    expect(registry.ownedIds()).toEqual([chosen]);
    expect(bus.subscribers().map((held) => held.id)).toContain(chosen);
    expect(controller.relics().map((relic) => relic.id)).toEqual([chosen]);

    // And a reload over the same store restores it through the instance.
    const resumed = new RunController({
      store: new RunStateStore({ storage: manager, config }),
      identity: resolveRunIdentity({ storage: manager, createToken }),
      config,
      stages,
      createToken,
      reporter: sink.reporter,
      relics: registry as unknown as RelicRegistryPort,
    });

    registry.clear();

    expect(resumed.begin()).toBe('loaded');
    expect(registry.ownedIds()).toEqual([chosen]);
  });
});

/* ==========================================================================
 * AN ATTACHED REGISTRY THAT CANNOT SEAT A RELIC
 *
 * An ABSENT registry means "this composition drives the relics itself", and the
 * controller records an entry on shape alone. An ATTACHED one that publishes no
 * activation member means the wiring is WRONG, and the two used to be
 * indistinguishable — so a port attached under the wrong member names persisted
 * a reward that fired on no hook, was drawn as held by the HUD, and was excluded
 * from every later draw. DL-RUNCTL-28.
 * ========================================================================== */

describe('an attached registry that cannot seat a relic', () => {
  it('refuses the selection and reports it, where no activation member exists',
    () => {
      const composed = composeOverClass({
        registry: Object.freeze({
          knows: (relicId: string): boolean => relicId === 'inert-relic',
        }) as RelicRegistryPort,
      });

      expect(composed.controller.recordRewardOffer(['inert-relic'])).toBe(true);
      expect(composed.controller.resolveReward('inert-relic')).toEqual({
        accepted: false,
        refusal: 'refused',
      });

      // Nothing recorded, and the failure is VISIBLE rather than silent.
      expect(composed.controller.relics()).toEqual([]);
      expect(composed.sink.of('write-failed')).not.toHaveLength(0);
    });

  it('records the entry on shape alone where no registry is attached', () => {
    // The pair to the case above: an absent registry keeps the behaviour every
    // registry-free composition relies on.
    const backing = new MemoryStorage();
    const manager = new LocalStorageManager({ storage: backing });
    const config = createDefaultRulesConfig();
    const stages = createDefaultStageConfig();
    const sink = createReportSink();
    let serial = 0;
    const createToken = (): string => {
      serial += 1;

      return `bare-${String(serial)}`;
    };
    const controller = new RunController({
      store: new RunStateStore({ storage: manager, config }),
      identity: resolveRunIdentity({ storage: manager, createToken }),
      config,
      stages,
      createToken,
      reporter: sink.reporter,
    });

    controller.begin();

    expect(controller.recordRewardOffer(['unattached-relic'])).toBe(true);
    expect(controller.resolveReward('unattached-relic')).toEqual({
      accepted: true,
      refusal: null,
    });
    expect(controller.relics().map((relic) => relic.id)).toEqual([
      'unattached-relic',
    ]);
    expect(sink.of('write-failed')).toHaveLength(0);
  });

  it('reads a falsy pickup answer as a refusal', () => {
    // The port declares "undefined means refused", and only `undefined` was
    // refused — so a registry answering `false` or `null` had its refusal read
    // as an acceptance and the relic reached the envelope unseated.
    for (const answer of [false, null, 0, '']) {
      const composed = composeOverClass({
        registry: Object.freeze({
          knows: (): boolean => true,
          pickUp: (): unknown => answer,
        }) as RelicRegistryPort,
      });

      expect(composed.controller.recordRewardOffer(['falsy-relic'])).toBe(true);
      expect(composed.controller.resolveReward('falsy-relic').accepted).toBe(
        false,
      );
      expect(composed.controller.relics()).toEqual([]);
    }
  });

  it('accepts a truthy pickup answer that is not an entry', () => {
    // The other side of the same rule: anything truthy is an acceptance, and the
    // entry recorded is then resolved rather than taken from the answer.
    const composed = composeOverClass({
      registry: Object.freeze({
        knows: (): boolean => true,
        pickUp: (): unknown => true,
      }) as RelicRegistryPort,
    });

    expect(composed.controller.recordRewardOffer(['truthy-relic'])).toBe(true);
    expect(composed.controller.resolveReward('truthy-relic').accepted).toBe(
      true,
    );
    expect(composed.controller.relics().map((relic) => relic.id)).toEqual([
      'truthy-relic',
    ]);
  });

  it('confirms ownership through `ownedRelicIds` where `holdsRelic` is absent',
    () => {
      // A registry that can be asked IS asked: the pickup's word is not taken
      // where the port publishes a way to check it.
      const seated: string[] = [];
      const composed = composeOverClass({
        registry: Object.freeze({
          knowsRelic: (): boolean => true,
          pickUpRelic: (relicId: string): PersistedRelic | null => {
            // Accepts, and then does NOT seat it — the divergence the
            // confirmation exists to catch.
            void relicId;

            return { id: relicId };
          },
          ownedRelicIds: (): readonly string[] => seated,
        }) as RelicRegistryPort,
      });

      expect(composed.controller.recordRewardOffer(['unseated-relic'])).toBe(
        true,
      );
      expect(composed.controller.resolveReward('unseated-relic').accepted).toBe(
        false,
      );
      expect(composed.controller.relics()).toEqual([]);
    });

  it('accepts where `ownedRelicIds` agrees the relic is seated', () => {
    const seated: string[] = [];
    const composed = composeOverClass({
      registry: Object.freeze({
        knowsRelic: (): boolean => true,
        pickUpRelic: (relicId: string): PersistedRelic | null => {
          seated.push(relicId);

          return { id: relicId };
        },
        ownedRelicIds: (): readonly string[] => seated,
      }) as RelicRegistryPort,
    });

    expect(composed.controller.recordRewardOffer(['seated-relic'])).toBe(true);
    expect(composed.controller.resolveReward('seated-relic').accepted).toBe(
      true,
    );
    expect(composed.controller.relics().map((relic) => relic.id)).toEqual([
      'seated-relic',
    ]);
  });
});

describe('the controller branches on no individual relic', () => {
  it('records an identifier only the injected registry knows', () => {
    const run = drive();

    // Every identifier in this suite's catalogue is declared in this file.
    for (const relic of recordingCatalogue()) {
      expect(takeReward(run, relic.id).accepted).toBe(true);
    }

    expect(run.controller.relics().map((held) => held.id)).toEqual(
      recordingCatalogue().map((relic) => relic.id),
    );
  });

  it('records nothing at all when no registry can be asked', () => {
    const run = drive({ relics: false });

    // A controller composed without a registry admits an identifier on its
    // shape alone and persists the bare identifier.
    expect(takeReward(run, 'any-identifier-at-all')).toEqual({
      accepted: true,
      refusal: null,
    });
    expect(run.controller.relics()).toEqual([{ id: 'any-identifier-at-all' }]);
    expect(run.registry.calls).toEqual([]);
  });
});

describe('the reward round a cleared stage opens', () => {
  /** The offer a drawing run presents, as a reward screen would show it. */
  const offers: readonly RewardOffer[] = Object.freeze([
    Object.freeze({
      id: 'port-charged',
      name: 'Charged',
      rarity: 'common',
      description: 'A relic with a budget.',
      hooks: Object.freeze(['onMerge']),
      charges: 3,
    }),
    Object.freeze({
      id: 'port-plain',
      name: 'Plain',
      rarity: 'common',
      description: 'A relic with no budget.',
      hooks: Object.freeze(['onSpawn']),
    }),
  ]);

  it('waits on the player: the stage clears, then the offer stands', () => {
    const run = drive({ offers });

    startStage(run, createEmptyBoard());
    resolveMove(run, boardWithHighest(16), 64);
    commit(run);

    // Stage -> StageClear -> Reward of Figure 6: the stage was resolved and
    // the index has NOT moved while the choice stands.
    expect(run.engine.endStages).toEqual([true]);
    expect(run.controller.isRewardPending()).toBe(true);
    expect(run.controller.currentOffer().map((offer) => offer.id)).toEqual([
      'port-charged',
      'port-plain',
    ]);
    expect(run.controller.stageIndex()).toBe(0);
  });

  it('advances on the selection: Reward -> Stage', () => {
    const run = drive({ offers });

    startStage(run, createEmptyBoard());
    resolveMove(run, boardWithHighest(16), 64);
    commit(run);

    expect(run.controller.resolveReward('port-plain')).toEqual({
      accepted: true,
      refusal: null,
    });

    expect(run.controller.stageIndex()).toBe(1);
    expect(run.controller.stageGoal()).toEqual(
      stageGoalForIndex(1, run.stages),
    );
    expect(run.controller.goalProgress()).toBe(0);
    expect(run.controller.isRewardPending()).toBe(false);
    expect(run.controller.relics().map((relic) => relic.id)).toEqual([
      'port-plain',
    ]);

    expect(storedEnvelope(run.backing)?.relics.map((relic) => relic.id)).toEqual(
      ['port-plain'],
    );
    expect(storedEnvelope(run.backing)?.stageIndex).toBe(1);
  });

  it('reports the offer and then the selection', () => {
    const run = drive({ offers });

    startStage(run, createEmptyBoard());
    resolveMove(run, boardWithHighest(16), 64);
    commit(run);
    run.controller.resolveReward('port-charged');

    const [offered] = run.sink.of('reward-offered');
    const drawn = run.sink.of('reward-drawn');
    const taken = drawn[drawn.length - 1];

    expect(offered?.detail.stageIndex).toBe(0);
    expect(offered?.detail.offeredRelicIds).toEqual([
      'port-charged',
      'port-plain',
    ]);
    expect(taken?.detail.selectedRelicId).toBe('port-charged');
    expect(taken?.detail.accepted).toBe(true);
    expect(taken?.detail.refusal).toBeUndefined();
  });

  it('excludes a relic the run already holds from the next offer', () => {
    const run = drive({ offers });

    takeReward(run, 'port-charged');
    startStage(run, createEmptyBoard());
    resolveMove(run, boardWithHighest(16), 64);
    commit(run);

    expect(run.controller.currentOffer().map((offer) => offer.id)).toEqual([
      'port-plain',
    ]);
  });

  it('leaves the offer standing when a selection is refused', () => {
    const run = drive({ offers });

    startStage(run, createEmptyBoard());
    resolveMove(run, boardWithHighest(16), 64);
    commit(run);

    expect(
      run.controller.resolveReward('port-second-plain').accepted,
    ).toBe(false);
    expect(run.controller.isRewardPending()).toBe(true);
    expect(run.controller.currentOffer()).toHaveLength(2);
    expect(run.controller.stageIndex()).toBe(0);
  });

  /**
   * Emits `state:commit` carrying the terminal flags a caller chooses, which is
   * what the two win-priority cases below turn on.
   *
   * @param run The composed run.
   * @param flags The `won` and `terminated` values the commit carries.
   */
  const commitWith = (
    run: Driven,
    flags: { readonly won: boolean; readonly terminated: boolean },
  ): void => {
    const board = run.engine.board();

    run.engine.events.emit('state:commit', {
      turn: 1,
      board: gridOf(board),
      score: board.score,
      bestScore: 0,
      over: false,
      won: flags.won,
      terminated: flags.terminated,
      degraded: false,
      stage: run.controller.stageCommitContextProvider()(),
      relics: run.controller.relicCommitContextProvider()(),
    });
  };

  it('defers the payout while a terminal win stands unresolved', () => {
    const run = drive({ offers });

    startStage(run, createEmptyBoard());
    resolveMove(run, boardWithHighest(16), 64);
    commitWith(run, { won: true, terminated: true });

    // The 2048 win outranks the stage payout: no stage resolved, no offer
    // drawn, no advance, so the reward cannot mask the terminal decision.
    // DL-RUNCTL-07.
    expect(run.engine.endStages).toEqual([]);
    expect(run.controller.isRewardPending()).toBe(false);
    expect(run.controller.currentOffer()).toEqual([]);
    expect(run.controller.stageIndex()).toBe(0);
  });

  it('resolves the deferred payout once the win is continued', () => {
    const run = drive({ offers });

    startStage(run, createEmptyBoard());
    resolveMove(run, boardWithHighest(16), 64);
    commitWith(run, { won: true, terminated: true });

    // Keep Going clears `terminated` and commits, which is the commit that
    // resolves the stage that was waiting.
    commitWith(run, { won: true, terminated: false });

    expect(run.engine.endStages).toEqual([true]);
    expect(run.controller.isRewardPending()).toBe(true);
    expect(run.controller.currentOffer().map((offer) => offer.id)).toEqual([
      'port-charged',
      'port-plain',
    ]);
  });
});


describe('summary', () => {
  it('carries the final score, the stage reached, the relics and the seed', () => {
    const run = drive({ seed: 'summary-seed' });

    startStage(run, createEmptyBoard());
    takeReward(run, 'port-charged');
    takeReward(run, 'port-plain');
    run.controller.advanceStage();
    run.engine.hold({ ...boardWithHighest(64), score: 1480 });
    run.controller.persist(run.engine.port, run.cursors);

    const summary: RunSummary = run.controller.summary();

    expect(summary.seed).toBe('summary-seed');
    expect(summary.runId).toBe(run.controller.runId());
    expect(summary.score).toBe(1480);
    expect(summary.stageIndex).toBe(run.controller.stageIndex());
    expect(summary.relics.map((relic) => relic.id)).toEqual([
      'port-charged',
      'port-plain',
    ]);
  });

  it('exposes the run seed itself, character for character', () => {
    const entered = '  A Seed With  Spaces  ';
    const run = drive({ seed: normalizeEnteredSeed(entered) });

    expect(run.controller.summary().seed).toBe(run.controller.seed());
    expect(run.controller.summary().seed).toBe('A Seed With  Spaces');
  });

  it('is JSON-serialisable, so a screen can render and copy it', () => {
    const run = drive({ seed: 'serialisable-summary' });

    takeReward(run, 'port-stateful');
    run.engine.hold({ ...createMergePairBoard(), score: 12 });
    run.controller.persist(run.engine.port, run.cursors);

    const summary = run.controller.summary();
    const encoded = JSON.stringify(summary);

    expect(typeof encoded).toBe('string');
    expect(JSON.parse(encoded) as RunSummary).toEqual(summary);
    expect(encoded).toContain('serialisable-summary');
  });

  it('is a read-only projection: it mutates nothing and repeats itself', () => {
    const run = drive({ seed: 'read-only-summary' });

    startStage(run, createEmptyBoard());
    takeReward(run, 'port-charged');
    resolveMove(run, boardWithHighest(8), 44);
    run.controller.persist(run.engine.port, run.cursors);

    const before = run.controller.state();
    const first = run.controller.summary();
    const second = run.controller.summary();

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(run.controller.state()).toEqual(before);
    expect(run.controller.stageIndex()).toBe(before.stageIndex);
    expect(run.controller.goalProgress()).toBe(before.goalProgress);
    expect(run.controller.relics()).toEqual(before.relics);

    // A caller writing into the projection cannot reach the envelope.
    expect(storedEnvelope(run.backing)?.relics.map((relic) => relic.id)).toEqual(
      ['port-charged'],
    );
  });

  it('has no summary of a finished run until one finishes', () => {
    const run = drive();

    expect(run.controller.lastSummary()).toBeNull();

    const finished = run.controller.endRun('won');

    expect(run.controller.lastSummary()).toEqual(finished);
  });
});

describe('correlationId', () => {
  it('is the identifier derived from the seed and the run identifier', () => {
    const run = drive({ seed: 'correlated-run' });

    expect(run.controller.correlationId()).toBe(
      runCorrelationId(run.controller.seed(), run.controller.runId()),
    );
    expect(run.controller.correlationId().length).toBeGreaterThan(0);
  });

  it('is unchanged across a move, an advance, a reward and a reload', () => {
    const backing = trackStorage(new MemoryStorage());
    const run = drive({ backing, seed: 'stable-across-a-run' });
    const pinned = run.controller.correlationId();

    startStage(run, createEmptyBoard());
    expect(run.controller.correlationId()).toBe(pinned);

    resolveMove(run, boardWithHighest(8), 24);
    expect(run.controller.correlationId()).toBe(pinned);

    takeReward(run, 'port-charged');
    expect(run.controller.correlationId()).toBe(pinned);

    run.controller.advanceStage();
    expect(run.controller.correlationId()).toBe(pinned);

    commit(run);
    expect(run.controller.correlationId()).toBe(pinned);

    expect(run.controller.persist(run.engine.port, run.cursors)).toBe(true);
    expect(run.controller.correlationId()).toBe(pinned);

    run.stop();

    // The reload. A resumed run keeps the stored seed and run identifier, so
    // it reports under the identifier the run has been reporting under all
    // along.
    const resumed = drive({ backing, observe: false });

    resumed.controller.resumeRun(resumed.engine.port);

    expect(resumed.controller.seed()).toBe(run.controller.seed());
    expect(resumed.controller.runId()).toBe(run.controller.runId());
    expect(resumed.controller.correlationId()).toBe(pinned);
  });

  it('is a different identifier for a new run', () => {
    const run = drive({ seed: 'first-of-two' });
    const first = run.controller.correlationId();

    run.controller.startRun(run.engine.port, { seed: 'second-of-two' });

    const second = run.controller.correlationId();

    expect(second).not.toBe(first);
    expect(second).toBe(
      runCorrelationId(run.controller.seed(), run.controller.runId()),
    );
  });

  it('separates two runs replaying one seed', () => {
    const first = drive({ seed: 'one-seed-two-runs' });
    const second = drive({ seed: 'one-seed-two-runs' });

    expect(second.controller.seed()).toBe(first.controller.seed());
    expect(second.controller.runId()).not.toBe(first.controller.runId());
    expect(second.controller.correlationId()).not.toBe(
      first.controller.correlationId(),
    );

    // AND NEITHER CARRIES THE SEED-GROUPING FORM. That form is recoverable by
    // dictionary search, so the identifier a run reports under is keyed by its
    // own run identifier throughout and shares no segment with it. A consumer
    // lining a replay up against the original compares the seed itself, which
    // the envelope holds and no report carries. DL-LOG-09.
    const grouped = runCorrelationId('one-seed-two-runs');

    expect(first.controller.correlationId().startsWith(grouped)).toBe(false);
    expect(second.controller.correlationId().startsWith(grouped)).toBe(false);
    expect(first.controller.correlationId().slice(0, 18)).not.toBe(
      second.controller.correlationId().slice(0, 18),
    );
  });

  it('is carried by every report the run makes', () => {
    const run = drive({ seed: 'reported-under-one-id' });
    const pinned = run.controller.correlationId();

    startStage(run, createEmptyBoard());
    takeReward(run, 'port-charged');
    resolveMove(run, boardWithHighest(16), 64);
    endStage(run, true, 64);
    commit(run);

    expect(run.sink.records.length).toBeGreaterThan(0);

    for (const record of run.sink.records) {
      expect(record.correlationId).toBe(pinned);
      expect(record.correlationId.length).toBeGreaterThan(0);
    }

    // The records carry usable detail, not just an identifier.
    expect(run.sink.of('run-started')).toHaveLength(1);
    expect(run.sink.of('reward-drawn')).toHaveLength(1);
    expect(run.sink.of('stage-advanced')).toHaveLength(1);
  });

  it('reports a failed write with the key, a size and the cause', () => {
    // A store whose port refuses every write, which is what a full quota looks
    // like from here.
    //
    // THE STORE IS THE ONE THAT REPORTS IT. A refused write produces exactly
    // one record and the store owns it, because it alone holds the key, the
    // serialised size and the cause; the controller answers a refusal with the
    // run's persistence status instead. So the store is given the same
    // correlation source the controller is, exactly as src/main.ts gives both
    // the logger's. Decision DL-RUNCTL-20.
    const run = drive();
    const refusing = new RunStateStore({
      storage: {
        readRaw: (): string | null => null,
        readJson: (): unknown => null,
        writeJson: (): boolean => false,
        removeRaw: (): boolean => true,
      },
      config: run.config,
      reporter: run.sink.reporter,
      correlationId: 'pinned-correlation-id',
    });
    const controller = new RunController({
      store: refusing,
      identity: run.controller.identity,
      config: run.config,
      stages: run.stages,
      reporter: run.sink.reporter,
      correlationId: 'pinned-correlation-id',
    });

    controller.begin();

    expect(controller.persist(run.engine.port, run.cursors)).toBe(false);

    const failures = run.sink.of('write-failed');

    expect(failures.length).toBeGreaterThan(0);

    const last = failures[failures.length - 1];

    expect(last?.correlationId).toBe('pinned-correlation-id');
    expect(last?.detail.key).toBe(RUN_STATE_KEY);
    expect(last?.detail.error).toBeDefined();
    expect(controller.correlationId()).toBe('pinned-correlation-id');
  });
});

describe('stageCommitContextProvider', () => {
  it('yields a provider that reads the stage in force at call time', () => {
    const run = drive();
    const provider = run.controller.stageCommitContextProvider();
    const opening: StageCommitContext = provider();

    expect(opening.stageIndex).toBe(0);
    expect(opening.goal).toEqual(stageGoalForIndex(0, run.stages));
    expect(opening.goalProgress).toBe(0);

    run.controller.advanceStage();

    const advanced = provider();

    expect(advanced.stageIndex).toBe(1);
    expect(advanced.goal).toEqual(stageGoalForIndex(1, run.stages));
    expect(advanced.goalProgress).toBe(0);
  });

  it('reflects the progress a resolved move measured', () => {
    const run = drive();
    const provider = run.controller.stageCommitContextProvider();

    startStage(run, createEmptyBoard());
    resolveMove(run, boardWithHighest(8), 24);

    const slice = provider();

    expect(slice.goalProgress).toBe(run.controller.goalProgress());
    expect(slice.goalProgress).toBeGreaterThan(0);
    expect(slice.goalProgress).toBeLessThanOrEqual(1);
    expect(slice.stageIndex).toBe(run.controller.stageIndex());
    expect(slice.goal).toEqual(run.controller.stageGoal());
  });

  it('hands out a frozen copy of the goal rather than the live one', () => {
    const run = drive();
    const first = run.controller.stageCommitContextProvider()();
    const second = run.controller.stageCommitContextProvider()();

    expect(second.goal).toEqual(first.goal);
    expect(second.goal).not.toBe(first.goal);
    expect(Object.isFrozen(first.goal)).toBe(true);
  });

  it('is what a commit payload carries, beside the relic slice', () => {
    const run = drive();
    const carried: StageCommitContext[] = [];

    run.engine.events.source.on('state:commit', (event): void => {
      carried.push(event.stage);
    });

    startStage(run, createEmptyBoard());
    takeReward(run, 'port-charged');
    resolveMove(run, boardWithHighest(8), 24);
    commit(run);

    const [slice] = carried;

    expect(slice?.stageIndex).toBe(0);
    expect(slice?.goal).toEqual(stageGoalForIndex(0, run.stages));
    expect(slice?.goalProgress).toBe(run.controller.goalProgress());
    expect(run.controller.relicCommitContextProvider()()).toEqual([
      { id: 'port-charged', charges: 3 },
    ]);
  });
});

/* ==========================================================================
 * 31. Storage isolation across the cases of this file
 *
 * js/local_storage_manager.js L61-L63 removed the board snapshot and never the
 * best score, so a suite that ignored the key would leak the highest score into
 * every case after it. The case below writes every key the product owns and then
 * runs the teardown itself, so it holds whether it runs first, last or alone.
 * The cross-case half of the guarantee is the `beforeEach` above, which asserts
 * the swept state of every tracked store before every case in this file.
 * ========================================================================== */

/** One store the case below writes to, tracked for teardown. */
const isolationBacking = trackStorage(new MemoryStorage());

describe('the persistence teardown', () => {
  it('removes every key the product owns, including the frozen best score', () => {
    const manager = new LocalStorageManager({ storage: isolationBacking });

    expect(manager.setBestScore(4096)).toBe(true);

    const run = drive({ backing: isolationBacking, seed: 'leaks-nothing' });

    takeReward(run, 'port-plain');

    // WRITTEN FIRST, so the removal below has something to remove: this case
    // does not depend on an earlier one having run.
    expect(typeof isolationBacking.getItem(BEST_SCORE_KEY)).toBe('string');
    expect(isolationBacking.getItem(RUN_STATE_KEY)).not.toBeUndefined();
    expect(manager.getBestScore()).toBe('4096');

    // The teardown this file registers with `afterEach`, invoked here so the
    // sweep is the assertion rather than an ordering assumption.
    clearTrackedStorage();

    expect(isolationBacking.getItem(BEST_SCORE_KEY)).toBeUndefined();
    expect(isolationBacking.getItem(GAME_STATE_KEY)).toBeUndefined();
    expect(isolationBacking.getItem(RUN_STATE_KEY)).toBeUndefined();

    for (const key of CLEARED_KEYS) {
      expect(isolationBacking.getItem(key)).toBeUndefined();
    }

    expect(CLEARED_KEYS).toContain(BEST_SCORE_KEY);
    expect(
      new LocalStorageManager({ storage: isolationBacking }).getBestScore(),
    ).toBe(0);

    // IDEMPOTENT, so the `afterEach` that runs straight after this case sweeps
    // an already-swept store without raising.
    expect(() => {
      clearTrackedStorage();
    }).not.toThrow();
    expect(isolationBacking.getItem(BEST_SCORE_KEY)).toBeUndefined();
  });
});

/* ==========================================================================
 * 32. The engine port keeps one member per vanilla input action
 *
 * Row TR-RUNCTL-03 of docs/TRACEABILITY_MATRIX.md: js/game_manager.js L24-L32,
 * the `keepPlaying` and terminated branches.
 *
 * THE RENAME THIS FILE MAKES VERIFIABLE. `GameManager.prototype.keepPlaying`
 * assigned `this.keepPlaying = true` over its own prototype method (L24-L27),
 * and `isGameTerminated` read that same shadowed name (L31). On `EnginePort` the
 * two are separate members: a command and a query.
 *
 * The other two spellings of the name stay frozen and are asserted where they
 * live — the INPUT ACTION name in tests/unit/input/input-dispatch.test.ts, and
 * the PERSISTED board member in tests/unit/run/run-state.test.ts.
 * ========================================================================== */

/**
 * The real engine, bound to the port this folder declares for it.
 *
 * The ASSIGNMENT is half the assertion: `EnginePort` is declared structurally in
 * src/run/run-controller.ts and nothing imports the `Engine` class there, so a
 * real engine that stopped satisfying it would fail this file's type check.
 * Sections 22 to 31 drive the recording double instead, because what they assert
 * is the ORDER the controller calls a port in; what this section asserts is the
 * port's own contract, which only the real engine can answer for.
 *
 * @param board Board the engine opens on. A fresh seeded board when absent.
 * @returns The composed world and its engine as an `EnginePort`.
 */
function composedPort(board?: SerializedGameState): {
  readonly composed: Composed;
  readonly port: EnginePort;
} {
  const composed = compose({ setup: false });
  const port: EnginePort = composed.engine;

  port.setup(board ?? null);

  return { composed, port };
}

describe('the ported engine port', () => {
  it('publishes move, restart and continuePlaying, one per input action', () => {
    const { port } = composedPort();

    // The three names js/game_manager.js L9-L11 subscribed at construction.
    expect(typeof port.move).toBe('function');
    expect(typeof port.restart).toBe('function');
    expect(typeof port.continuePlaying).toBe('function');

    // And the observation half of the same port, which the controller attaches
    // through: the emitter, the snapshot and the two stage members.
    expect(typeof port.events.on).toBe('function');
    expect(typeof port.serialize).toBe('function');
    expect(typeof port.endStage).toBe('function');
    expect(typeof port.startStage).toBe('function');
  });

  it('separates the terminated query from the continue command', () => {
    const { port } = composedPort();

    expect(typeof port.isGameTerminated).toBe('function');
    expect(typeof port.continuePlaying).toBe('function');

    // Two members, never one name carrying both a method and a boolean —
    // js/game_manager.js L24-L27 assigned `this.keepPlaying = true` over its own
    // prototype method of that name, and L31 read the shadowed member.
    expect(port.isGameTerminated).not.toBe(port.continuePlaying);
    expect(port.isGameTerminated()).toBe(false);

    // The query answers on the engine's own state and stays a query: asking it
    // repeatedly changes nothing.
    expect(port.isGameTerminated()).toBe(false);
    expect(port.serialize().keepPlaying).toBe(false);
  });

  it('reads the frozen board member when it answers the query', () => {
    // A real win: `createNearWinBoard` lays two tiles of half the configured
    // win value side by side, so the move below merges them and the engine
    // raises `won` itself rather than being handed it.
    const composed = compose({ setup: false });
    const port: EnginePort = composed.engine;

    port.setup(
      createNearWinBoard(composed.config.boardSize, composed.config.winValue),
    );

    expect(port.move(DIRECTION_LEFT)).toBe(true);

    const won = port.serialize();

    expect(won.won).toBe(true);
    expect(won.keepPlaying).toBe(false);

    // A won board with play not continued is terminated; the COMMAND is what
    // continues it, and the flag it writes carries the frozen wire name.
    expect(port.isGameTerminated()).toBe(true);

    port.continuePlaying();

    expect(port.isGameTerminated()).toBe(false);
    expect(port.serialize().keepPlaying).toBe(true);
    expect(port.serialize().won).toBe(true);
  });

  it('takes exactly the four directions and nothing wider', () => {
    const { port } = composedPort(createMergePairBoard());
    const directions: readonly MoveDirection[] = [0, 1, 2, 3];

    // The union is the four values src/engine/types.ts declares, restated by the
    // port rather than widened to `number`.
    expect(directions).toEqual([
      DIRECTION_UP,
      DIRECTION_RIGHT,
      DIRECTION_DOWN,
      DIRECTION_LEFT,
    ]);

    for (const direction of directions) {
      expect(typeof port.move(direction)).toBe('boolean');
    }

    // And the return is the real resolution rather than a constant: the merge
    // pair moves left, and the board it leaves cannot move left again.
    const settled = compose({ setup: false });
    const fresh: EnginePort = settled.engine;

    fresh.setup(createMergePairBoard());

    expect(fresh.move(DIRECTION_LEFT)).toBe(true);
    expect(fresh.serialize().score).toBeGreaterThan(0);
  });

  it('restarts through the port, discarding the board in progress', () => {
    const { port } = composedPort(boardWith(1024));

    expect(port.serialize().grid.cells[0]?.[0]?.value).toBe(1024);

    port.restart();

    const restarted = port.serialize();

    // A fresh board carries the configured start tiles and no 1024.
    expect(restarted.score).toBe(0);
    expect(restarted.over).toBe(false);
    expect(restarted.won).toBe(false);
    expect(restarted.keepPlaying).toBe(false);
    expect(
      restarted.grid.cells
        .flat()
        .filter((cell) => cell !== null)
        .map((cell) => cell?.value),
    ).not.toContain(1024);
  });
});
