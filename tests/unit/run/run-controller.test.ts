/**
 * The run lifecycle, composed.
 *
 * WHAT IS UNDER TEST
 *   `RunController` of src/run/run-controller.ts, from two directions.
 *
 *   Sections 1 to 20 exercise the COMPOSITION of the run layer: a real `Engine`
 *   against a real `RunStateStore` over an injected store.
 *
 *   Sections 21 to 31 exercise the controller against its OWN declared ports —
 *   `EnginePort`, `EngineEventSource` and `RelicRegistryPort` — with plain
 *   recording objects, and cover the units the composition reaches only
 *   indirectly: seed origination and entry, the stage-goal authority, the
 *   reward triple, the run summary, the correlation identifier and the commit
 *   context providers. NO MOCKING LIBRARY is used anywhere in this file: every
 *   collaborator arrives by constructor injection.
 *
 *   Decisions of docs/DECISION_LOG.md this file is the evidence for, one
 *   apiece: DL-RUNCTL-01, DL-RUNCTL-02, DL-RUNCTL-03, DL-RUNCTL-04,
 *   DL-STAGE-02, DL-TEST-01. Rows of docs/TRACEABILITY_MATRIX.md it covers, one
 *   apiece: TR-RUNCTL-01, TR-RUNCTL-02, TR-RUNCTL-03, TR-RUNCTL-04,
 *   TR-RUNCTL-05, TR-RUNCTL-06, TR-RUNCTL-07, TR-RUNCTL-08.
 *
 * THE STORE IS INJECTED
 *   `tests/unit/run/` runs in both the `unit:dom-free` project, which has no
 *   Web Storage at all, and the `unit:dom` project, which has jsdom's. A
 *   `MemoryStorage` handed to `LocalStorageManager` makes every case below
 *   behave identically in both, and keeps one test's storage out of the next
 *   test's reach without depending on teardown. Decision DL-TEST-01. Section 21
 *   adds the `afterEach` that empties every store this file tracked, of every
 *   key `OWNED_STORAGE_KEYS` and `BEST_SCORE_KEY` name.
 *
 * WHAT THIS FILE DOES NOT OWN
 *   The loader's verdict matrix (tests/unit/run/run-state-store.test.ts), the
 *   envelope's nine-member shape (tests/unit/run/run-state.test.ts), board-size
 *   reconciliation (tests/unit/run/run-relic-board-size.test.ts), the RNG cursor
 *   mechanism (tests/unit/run/rng-cursor-persistence.test.ts), the frozen
 *   best-score contract (tests/unit/storage/best-score.test.ts) and the seeded
 *   relic draw (tests/unit/relics/relic-draw.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import type { RulesConfig } from '../../../src/config/rules-config';
import {
  createDefaultStageConfig,
  evaluateStageGoal,
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
  type RunScope,
} from '../../../src/run/run-controller';
import { drawRelicOffers } from '../../../src/relics/relic-draw';
import {
  RELIC_CATALOGUE,
  RelicRegistry,
} from '../../../src/relics/relic-registry';
import type { Relic } from '../../../src/relics/relic-types';
import {
  RUN_STATE_SCHEMA_VERSION,
  createFreshRunState,
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

/** Every report the controller and the store made, in order. */
interface RecordedReports {
  readonly started: { runId: string; stageIndex: number; resumed: boolean; seedProvided: boolean }[];
  readonly advanced: { fromStageIndex: number; toStageIndex: number; target: number }[];
  readonly ended: { outcome: string; stageIndex: number; score: number }[];
  readonly corrupted: string[];
  readonly reconciled: number[];
}

function createRecorder(): { reports: RecordedReports; reporter: RunReporter } {
  const reports: RecordedReports = {
    started: [],
    advanced: [],
    ended: [],
    corrupted: [],
    reconciled: [],
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
  readonly seed?: string;
  readonly tokens?: readonly string[];
  readonly setup?: boolean;
}

/**
 * Composes storage, identity, store, controller, substreams and engine in the
 * root's order, and attaches the controller to the engine.
 *
 * `setup()` is called unless suppressed, because the first commit is what the
 * envelope's board comes from and several cases below assert on it.
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
    seed: options.seed,
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
 *
 * `MemoryStorage.getItem` yields `undefined` for an absent key while the DOM
 * contract yields `null`; every assertion below reads through this so it does
 * not depend on which of the two is under it.
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

/* ==========================================================================
 * 1. Identity resolution
 * ========================================================================== */

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

    // A seed the player chose starts a fresh run: it cannot continue a run that
    // was played under a different sequence.
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

/* ==========================================================================
 * 2. begin(): the authoritative load
 * ========================================================================== */

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
      seed: 'the-seed-i-typed',
      setup: false,
    });

    // Adopting another run's stage and relics onto a board playing a different
    // sequence would be a different run wearing this one's progress.
    expect(controller.seed()).toBe('the-seed-i-typed');
    expect(controller.state().stageIndex).toBe(0);
    expect(controller.relicContext()).toEqual([]);
    expect(controller.cursors()['spawn-value']).toBe(0);
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

/* ==========================================================================
 * 3. The commit contexts
 * ========================================================================== */

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

    // The commit the rewind made carries progress measured from the RESTORED
    // board, not from the board the run stood on before the rewind — which
    // held a single tile of 2 and would have reported an eighth of this.
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
    // Projected from the envelope instead, the count reached a consumer one
    // commit late: the tray showed the old budget and a reload restored it.
    expect(charges).toEqual([1]);

    stop();
  });

  it('hands out a frozen copy of the stage goal, never the live one', () => {
    const { controller, stages } = compose({ setup: false });
    const target = stages.ladder[0].target;
    const projected = controller.stageContext().goal;

    // `readonly` in `StageCommitContext` binds the reference, not the object, so
    // the projection is frozen as well: a listener cannot retarget the goal the
    // run is measured against and the goal that reaches storage.
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

    // A relic whose state slot cannot be read: `cloneRunState()` raises while
    // copying it, which is the one path `state()` falls back on.
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

    // The commit is what puts the hostile relic and the engine's board into the
    // envelope.
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

    // Absent rather than `undefined`, so the projection round-trips through JSON.
    expect('charges' in (carried[1] ?? {})).toBe(false);

    for (const entry of carried) {
      expect('state' in entry).toBe(false);
    }
  });
});

/* ==========================================================================
 * 4. Persistence
 * ========================================================================== */

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

    // The two describe one board. The envelope wraps a copy; `gameState`
    // remains the board's home, written by the engine exactly as before.
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

    // The best score is stored as the raw decimal string the pre-migration
    // manager wrote, and reads back as that string rather than a number.
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

    // The same seed, interrupted after half the moves and resumed from storage.
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

    // `setup()` restored the board rather than seeding it, so the resumed
    // composition's first commit records the cursor it inherited.
    expect(readStored(second.backing)?.rngCursor['spawn-value']).toBe(
      beforeReload,
    );
  });
});

/* ==========================================================================
 * 6. Stage advancement
 * ========================================================================== */

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

    // `setup()` is deferred so the assertions can watch the emission it makes:
    // its first commit already meets the goal, so the resolution happens there.
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

    // A stage transition CARRIES the board, so the stage now in force opens
    // measured against the tiles still in play rather than at zero: the 16 that
    // cleared stage 0 is already part of the way to stage 1's target.
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

    // A commit reports the stage now in force. The advance happens during the
    // `stage:end` emission, and the commit `endStage()` ends with assembles its
    // payload after that emission completes.
    expect(commits).toContainEqual({
      stageIndex: 1,
      target: stages.ladder[1]?.target,
    });

    // NEVER a mismatched pair. The engine adopts the goal an `onStageStart`
    // handler returns and prefers it over the provider's thereafter; an
    // adopted goal left in place across a stage transition would make a commit
    // report the new stage index beside the OLD stage's target.
    //
    // Order is not asserted: the controller is registered before this listener
    // here, so this listener receives the re-entrant stage-end commit before
    // the commit that triggered it. src/main.ts registers the controller LAST
    // for exactly that reason.
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

    // One further stage per move, because a move is what measures the board
    // against the stage now in force. RIGHT, not UP: the tile sits in the
    // top-left cell, and a move that changes nothing never reaches a commit.
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

/* ==========================================================================
 * 7. Run end
 * ========================================================================== */

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

    // The engine clears `gameState` on a loss; the envelope goes with it, so a
    // reload opens a fresh run rather than a fresh board wearing a lost run's
    // stage and relics.
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

/* ==========================================================================
 * 8. Detachment
 * ========================================================================== */

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

/* ==========================================================================
 * 9. The relic registry, bound
 *
 * The port and the registry shipped with DIFFERENT MEMBER NAMES, so nothing
 * could satisfy the port and no production wiring existed. Every case below
 * binds the REAL `RelicRegistry` as the port, which is what makes the naming
 * assertion mechanical rather than a matter of reading two files: if the names
 * disagreed again this section would not compile.
 * ========================================================================== */

/** One composed run with a real registry over the engine's own hook bus. */
interface ComposedWithRelics extends Composed {
  readonly registry: RelicRegistry;
}

/**
 * Composes as `compose()` does, and additionally builds a real registry over
 * the engine's hook bus and binds it to the controller.
 *
 * The engine is constructed FIRST so the registry can attach to its live bus,
 * then the controller's registry member is supplied — which is the order
 * src/main.ts must use for the same reason.
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
    seed: options.seed,
  });

  // A holder, because the engine needs the controller's providers and the
  // registry needs the engine's bus.
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

    // THE BINDING UNDER TEST. The real registry, passed as the port.
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
    // A member extracted into a local and invoked bare would enter with `this`
    // undefined and raise on the first field read, so every one of these
    // completing is the assertion.
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

    // THE POINT OF THE PICKUP. A relic recorded in the envelope but never
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

/* ==========================================================================
 * 10. Reward selection is validated
 * ========================================================================== */

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

    // REFUSED AT THE OFFER, which is the earlier of the two gates that measure
    // catalogue membership: an identifier no catalogue carries is one no seeded
    // draw could have produced, so the whole offer is refused rather than
    // recorded and then declined a step later.
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

    // THE OFFER STANDS. Clearing it either way stranded the reward screen with
    // nothing left to present, so a refused pick could not be retried.
    expect(controller.resolveReward(FIRST_RELIC).accepted).toBe(true);
  });

  it('clears the offer once a selection was accepted', () => {
    const { controller } = composeWithRelics();

    controller.recordRewardOffer([FIRST_RELIC, SECOND_RELIC]);

    expect(controller.resolveReward(FIRST_RELIC).accepted).toBe(true);

    // The set is spent; a second pick from it is no longer on offer.
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

/* ==========================================================================
 * 11. The stage transition completes
 * ========================================================================== */

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

    // NOTHING ELSE STARTS THAT STAGE. A run that only advanced its index never
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

  it('starts the stage even when the selection was refused', () => {
    const { controller, engine } = composeWithRelics();
    const started: number[] = [];

    engine.events.on('stage:start', (event) => {
      started.push(event.stageIndex);
    });

    controller.advanceStage();

    const resolution = controller.completeReward(engine, 'no-such-relic');

    // Withholding the start would strand the run between stages.
    expect(resolution.accepted).toBe(false);
    expect(started).toEqual([1]);
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

/* ==========================================================================
 * 12. One goal authority
 * ========================================================================== */

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

    // THE ENGINE'S GOAL, NOT THE CONTROLLER'S OWN. Measuring against a
    // separately recorded goal left two authorities that disagreed the moment a
    // relic replaced one of them.
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

/* ==========================================================================
 * 13. A new run replaces everything scoped to it
 * ========================================================================== */

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

    // THE ORDER IS THE POINT. A root rebuilds the run's correlation scope from
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

    // THE ORDER IS THE POINT. Rebuilding after `setup()` would draw the opening
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

/* ==========================================================================
 * 14. The board a run opens on
 * ========================================================================== */

describe('the opening board', () => {
  it('is null for a fresh run, so start tiles are inserted', () => {
    const { controller, engine } = composeWithRelics();

    expect(controller.openingBoard()).toBeNull();

    // Two start tiles, which an empty supplied snapshot would have suppressed.
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

    // `store.exists()` reported SUCCESS for this key, and the run then opened
    // on the envelope's own empty board — which suppressed the start tiles and
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

    const second = composeWithRelics({ backing, seed: 'seed-two' });

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

    // `store.exists()` reports SUCCESS for a key that is present and
    // unreadable, and `resumeRun` then handed the engine the envelope's own
    // EMPTY board. A supplied snapshot tells the engine the board was restored,
    // so no start tiles were inserted and the run opened unplayable.
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
      seed: 'seed-beta',
      setup: false,
    });

    second.controller.resumeRun(second.engine);

    // The envelope is present and READABLE but belongs to another seed, so it
    // is not adopted; `exists()` reported success for it all the same.
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

/* ==========================================================================
 * 15. Projections are detached
 * ========================================================================== */

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
 * 16. Charge activation, and the write that follows it
 * ========================================================================== */

/** The first catalogue relic carrying a charge budget. */
const CHARGED_RELIC: string = (
  RELIC_CATALOGUE.find((relic): boolean => relic.charges !== undefined) as Relic
).id;

/** That relic's declared budget. */
const CHARGED_BUDGET: number = (
  RELIC_CATALOGUE.find((relic): boolean => relic.charges !== undefined) as Relic
).charges as number;

describe('activating a relic', () => {
  it('spends a charge and persists the budget that remains', () => {
    const { backing, controller, engine } = composeWithRelics();

    controller.recordRewardOffer([CHARGED_RELIC]);
    controller.resolveReward(CHARGED_RELIC);

    const outcome = controller.activateRelic(
      engine,
      () => ({}) as never,
      CHARGED_RELIC,
    );

    expect(outcome.held).toBe(true);
    expect(outcome.limited).toBe(true);
    expect(outcome.consumed).toBe(1);
    expect(outcome.remaining).toBe(CHARGED_BUDGET - 1);

    // AN ACTIVATION IS NOT A MOVE, so no commit follows it on its own; the
    // write is part of the transaction or the spend is lost on reload.
    expect(outcome.persisted).toBe(true);
    expect(
      readStored(backing)?.relics.find((relic) => relic.id === CHARGED_RELIC)
        ?.charges,
    ).toBe(CHARGED_BUDGET - 1);
  });

  it('spends an explicit amount', () => {
    const { controller, engine } = composeWithRelics();

    controller.recordRewardOffer([CHARGED_RELIC]);
    controller.resolveReward(CHARGED_RELIC);

    expect(
      controller.activateRelic(engine, () => ({}) as never, CHARGED_RELIC, 2)
        .remaining,
    ).toBe(CHARGED_BUDGET - 2);
  });

  it('stops spending once the budget is exhausted, and writes nothing', () => {
    const { controller, engine } = composeWithRelics();
    const cursors = (): never => ({}) as never;

    controller.recordRewardOffer([CHARGED_RELIC]);
    controller.resolveReward(CHARGED_RELIC);

    for (let spent = 0; spent < CHARGED_BUDGET; spent += 1) {
      expect(
        controller.activateRelic(engine, cursors, CHARGED_RELIC).consumed,
      ).toBe(1);
    }

    const exhausted = controller.activateRelic(engine, cursors, CHARGED_RELIC);

    expect(exhausted.held).toBe(true);
    expect(exhausted.consumed).toBe(0);
    expect(exhausted.remaining).toBe(0);
    expect(exhausted.persisted).toBe(false);
  });

  it('reports an unheld relic and writes nothing', () => {
    const { controller, engine } = composeWithRelics();

    const outcome = controller.activateRelic(
      engine,
      () => ({}) as never,
      CHARGED_RELIC,
    );

    expect(outcome.held).toBe(false);
    expect(outcome.consumed).toBe(0);
    expect(outcome.persisted).toBe(false);
  });

  it('reports nothing spent on a relic with no budget', () => {
    const { controller, engine } = composeWithRelics();

    controller.recordRewardOffer([FIRST_RELIC]);
    controller.resolveReward(FIRST_RELIC);

    const outcome = controller.activateRelic(
      engine,
      () => ({}) as never,
      FIRST_RELIC,
    );

    expect(outcome.limited).toBe(false);
    expect(outcome.consumed).toBe(0);
    expect(outcome.persisted).toBe(false);
  });

  it('reports nothing when no registry publishes an activation', () => {
    const { controller, engine } = compose();

    const outcome = controller.activateRelic(
      engine,
      () => ({}) as never,
      CHARGED_RELIC,
    );

    expect(outcome.consumed).toBe(0);
    expect(outcome.persisted).toBe(false);
  });

  it('contains a registry that raises during an activation', () => {
    const backing = new MemoryStorage();
    const manager = new LocalStorageManager({ storage: backing });
    const config = createDefaultRulesConfig();
    const controller = new RunController({
      store: new RunStateStore({ storage: manager, config }),
      identity: resolveRunIdentity({ storage: manager }),
      config,
      relics: {
        activate: (): never => {
          throw new Error('registry down');
        },
      },
    });

    controller.begin();

    const port = {
      events: { on: () => (): void => undefined },
      serialize: () => emptySnapshot(),
      endStage: () => undefined,
      startStage: () => undefined,
    };

    expect(() =>
      controller.activateRelic(port, () => ({}) as never, CHARGED_RELIC),
    ).not.toThrow();
    expect(
      controller.activateRelic(port, () => ({}) as never, CHARGED_RELIC)
        .consumed,
    ).toBe(0);
  });

  it('refuses a registry report of the wrong shape', () => {
    const backing = new MemoryStorage();
    const manager = new LocalStorageManager({ storage: backing });
    const config = createDefaultRulesConfig();
    const controller = new RunController({
      store: new RunStateStore({ storage: manager, config }),
      identity: resolveRunIdentity({ storage: manager }),
      config,
      relics: {
        // A structural port, so its return is measured rather than trusted: a
        // non-finite count must not reach the write path.
        activate: () =>
          ({ held: true, limited: true, consumed: Number.NaN }) as never,
      },
    });

    controller.begin();

    const outcome = controller.activateRelic(
      {
        events: { on: () => (): void => undefined },
        serialize: () => emptySnapshot(),
        endStage: () => undefined,
        startStage: () => undefined,
      },
      () => ({}) as never,
      CHARGED_RELIC,
    );

    expect(outcome.consumed).toBe(0);
    expect(outcome.persisted).toBe(false);
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
}

/**
 * Composes storage, store, controller, registry, substreams and engine with a
 * seeded draw port bound, in the order src/main.ts uses.
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
    seed: options.seed ?? 'wiring-a',
  });

  const holder: { controller: RunController | null } = { controller: null };

  const engine = new Engine({
    config,
    stages,
    streams: createRngStreams(identity.seed, {}),
    storage: manager,
    stageContext: () =>
      holder.controller?.stageContext() ?? {
        stageIndex: 0,
        goal: stages.ladder[0],
        goalProgress: 0,
      },
    relicContext: () => holder.controller?.relicContext() ?? [],
  });

  const registry = new RelicRegistry({
    bus: engine.hooks,
    catalogue: RELIC_CATALOGUE,
  });

  let streams: ReturnType<typeof createRngStreams> | null = null;

  const controller = new RunController({
    store: new RunStateStore({ storage: manager, config, reporter }),
    identity,
    config,
    stages,
    createToken,
    reporter,

    // THE DOCUMENTED ROUTE between the two folders, not the instance.
    relics: registry.runPort(),

    // The seeded draw, which is what makes the cleared stage offer a reward of
    // its own instead of waiting for a caller to record one.
    rewards: {
      draw: ({ count, ownedIds }): readonly RewardOffer[] =>
        streams === null
          ? []
          : drawRelicOffers({
              pool: registry.catalogue(),
              ownedIds,
              count,
              streams,
            }).map((relic): RewardOffer => ({
              id: relic.id,
              name: relic.name,
              rarity: relic.rarity,
              description: relic.description,
              hooks: Object.keys(relic.hooks),
              ...(relic.charges === undefined ? {} : { charges: relic.charges }),
            })),
    },
  });

  holder.controller = controller;
  controller.begin();

  const live = createRngStreams(controller.seed(), controller.cursors());

  streams = live;

  const stop = controller.observe(engine, () => live.snapshotCursors());

  if (options.setup !== false) {
    engine.setup(mergeReadyBoard());
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
    busSubscriberIds: (): readonly string[] =>
      engine.hooks.subscribers().map((subscriber): string => subscriber.id),
  };
}

/**
 * A board whose first move LEFT merges 8 + 8 into 16, which is the first ladder
 * goal — so one move clears stage 0 and the reward round opens.
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

    // THE LIVE REGISTRY AND THE LIVE BUS, not only the returned outcome. A
    // selection that reported `'accepted'` while these were empty is exactly
    // the defect this case exists for: the relic was displayed, dispatched to
    // nothing, and erased by the next commit's projection.
    expect(registry.ownedIds()).toEqual([chosen.id]);
    expect(busSubscriberIds()).toContain(chosen.id);
    expect(controller.relics().map((relic) => relic.id)).toEqual([chosen.id]);
    expect(readStored(backing)?.relics.map((relic) => relic.id)).toEqual([
      chosen.id,
    ]);

    // EXACTLY ONE ADVANCE, and the reward is no longer pending.
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

    // ITS OWN HANDLERS RAN, on the moves that followed the pickup — which is
    // AAP user key flow 1: "chosen relic effects immediately fire on subsequent
    // moves/merges/spawns for rest of run".
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

    // BOTH HALVES, on the other public method as well: neither may keep the
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

    // One entry for the stage the selection opened, and no repeat of it: a stage
    // opened twice applied every per-stage relic effect twice.
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
 * 18. The reward outcome codes mean what they say
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

    // Nothing was resolved, so nothing is `'already-resolved'`; no offer object
    // stands, so a selection has nothing to be made from.
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
 * 19. The registry's run port satisfies the consumer
 * ========================================================================== */

describe('the registry run port', () => {
  it('publishes an activation member the reward transaction can reach', () => {
    const { registry } = composeWithRelics();
    const port = registry.runPort();

    // BOTH SPELLINGS. The consumer accepts either, and a port publishing
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

/* ==========================================================================
 * 20. The envelope is the authority for the relics a run holds
 *
 * `begin()` and `restoreHeldRelics()` make the LIVE registry agree with the
 * envelope, which means a relic picked up on the registry before a run began
 * belongs to no run and does not survive it. That is the reason a relic must be
 * taken on through the reward transaction, which records it as it registers it,
 * or restored from an envelope after `begin()` — the order src/main.ts composes
 * in. The cases below pin both halves, so a composition that gets the order
 * wrong fails here rather than losing a player's relics silently.
 * ========================================================================== */

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

    // TOO EARLY: no run has been begun, so this relic belongs to none.
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

/* ==========================================================================
 * 21. Storage hygiene, and the ports the sections below drive
 *
 * Sections 22 to 28 drive the controller through the THREE STRUCTURAL PORTS it
 * declares for itself — `EnginePort`, `EngineEventSource` and
 * `RelicRegistryPort` of src/run/run-controller.ts — using plain objects that
 * record their calls. No mocking library is imported and no module is replaced:
 * the collaborators arrive by constructor injection, ported from
 * js/application.js L3 and covered by row TR-RUNCTL-01 of
 * docs/TRACEABILITY_MATRIX.md.
 *
 * Every judgement the sections below pin is argued in docs/DECISION_LOG.md,
 * under DL-RUNCTL-01 to DL-RUNCTL-04, DL-STAGE-01 to DL-STAGE-03 and DL-TEST-01.
 * ========================================================================== */

/**
 * Stores the cases below construct, so the teardown can empty each of them.
 *
 * `tests/unit/run/` runs in the `unit:dom-free` project, which offers no Web
 * Storage, so the store every case injects is the only one holding what a case
 * wrote. Registered here, cleared in `afterEach`.
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
 * literal, de-duplicated. Imported constants throughout; no key is spelled as a
 * literal here.
 */
const CLEARED_KEYS: readonly OwnedStorageKey[] = Object.freeze([
  ...new Set<OwnedStorageKey>([...OWNED_STORAGE_KEYS, BEST_SCORE_KEY]),
]);

/**
 * Removes one key from the environment's Web Storage where it offers one.
 *
 * Total in every environment: the `unit:dom-free` project offers none, and
 * every case below injects `MemoryStorage`.
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
 *
 * IDEMPOTENT, so it composes with the `afterEach(clearOwnedStorage)` that
 * tests/fixtures/storage.ts registers as a setup file for both unit projects.
 * js/local_storage_manager.js L61-L63 removed the board snapshot and never the
 * best score, which is the key this suite is careful to remove.
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
  // The invariant the teardown leaves behind, asserted before every case rather
  // than in one of them: no tracked store carries a key an earlier case wrote.
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
 * The writability probe and the single snapshot read both happen while
 * `LocalStorageManager`, `RunStateStore` and `RunController` are constructed —
 * js/local_storage_manager.js L25-L26 and js/game_manager.js L36 — so a fixture
 * written afterwards is invisible to them.
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

/** The `EngineEventSource` fake, plus the emission helper a case drives it by. */
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
 * `on()` APPENDS and returns a handle that removes exactly its own listener;
 * `emit()` walks a copy of the list synchronously, in registration order, with
 * the payload as the single argument — ported from js/keyboard_input_manager.js
 * L18-L32. Listener containment is src/engine/engine-events.ts's own and is not
 * reproduced here, so a controller listener that throws fails the case that
 * emitted to it.
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

  /** Every argument `setup()` received, in order. */
  readonly setups: (SerializedGameState | null | undefined)[];

  /** Every `cleared` argument `endStage()` received, in order. */
  readonly endStages: boolean[];

  /** Every argument `startStage()` received, in order. */
  readonly startStages: (SerializedGameState | null | undefined)[];

  /** Every direction `move()` received, in order. */
  readonly moves: MoveDirection[];

  /** Replaces the board `serialize()` projects. */
  readonly hold: (board: SerializedGameState) => void;

  /** The board `serialize()` projects, as a fresh copy. */
  readonly board: () => SerializedGameState;
}

/** How a recording engine is built. */
interface RecordingEngineOptions {
  /** The board `serialize()` opens on. Defaults to an empty one. */
  readonly board?: SerializedGameState;

  /**
   * Whether the port publishes `startStage`. `false` yields a port that only
   * observes, which `RunEnginePort` admits and `openNextStage()` reads as an
   * engine implementing no stage transition.
   */
  readonly startStage?: boolean;
}

/**
 * An `EnginePort` that records every call and returns controllable values.
 *
 * `serialize()` returns a FRESH DEEP COPY of the board held, as
 * `Engine.serialize()` does, so the controller needs no defensive clone and a
 * case can compare what it stored against what it held.
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

    // js/game_manager.js L24-L27, under the name that no longer shadows it.
    continuePlaying(): void {
      calls.push('continuePlaying');
    },
  };

  const transitioning: EnginePort = {
    ...observing,

    startStage(board?: SerializedGameState | null): void {
      calls.push('startStage');
      startStages.push(board);
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
  };
}


/**
 * The relics the recording registry's catalogue carries, freshly built per call.
 *
 * Three shapes, one apiece: an identifier alone, an identifier with a budget,
 * and one with a budget and an opaque state slot. `PersistedRelic` fixes the
 * triple to `id`, optional `charges` and optional `state`.
 *
 * These identifiers exist ONLY here. Nothing in src/run reads one, which is what
 * a case asserting the absence of per-relic branching relies on.
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

/** The `RelicRegistryPort` fake, plus readers for everything it recorded. */
interface RecordingRegistry {
  /** The port handed to the controller. */
  readonly port: RelicRegistryPort;

  /** Identifiers taken on, IN PICKUP ORDER. */
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
 * @returns The port and its recorders.
 */
function createRecordingRegistry(): RecordingRegistry {
  const catalogue = recordingCatalogue();
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
 * A reporter that COLLECTS rather than discards.
 *
 * Every member `RunReporter` declares is captured with its correlation
 * identifier, so a case asserts on what was reported rather than on the fact
 * that reporting happened. Nothing here reaches `console`, and nothing here is a
 * no-op stub.
 *
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

/**
 * Distinguishes the run identifiers of two runs composed in one file run.
 *
 * `originateRunId()` mints a fresh identifier per run; this counter is the
 * deterministic stand-in a case injects through `createToken`, so two runs never
 * share an identifier and no case asserts an originated value.
 */
let tokenSerial = 0;

/** How one port-driven run is composed. */
interface DriveOptions {
  /** The store to compose over. A fresh tracked one by default. */
  readonly backing?: MemoryStorage;

  /** The seed to play, as the run-start screen supplies one. */
  readonly seed?: string;

  /** The board the engine opens on. */
  readonly board?: SerializedGameState;

  /** Whether the port publishes `startStage`. */
  readonly startStage?: boolean;

  /** `false` composes the controller with no registry at all. */
  readonly relics?: boolean;

  /** The offers a cleared stage draws. Absent composes no draw port. */
  readonly offers?: readonly RewardOffer[];

  /** `false` leaves the controller unsubscribed from the engine. */
  readonly observe?: boolean;
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

  /** The substream draw counts, as `observe()` and `persist()` read them. */
  readonly cursors: () => RngCursorMap;

  /** Releases the controller's subscriptions. */
  readonly stop: () => void;

  /** What `begin()` reported. */
  readonly outcome: RunStateLoadOutcome;
}

/**
 * Composes storage, store, controller, registry and engine port in the order
 * src/main.ts composes them, and attaches the controller to the engine.
 *
 * The correlation identifier is injected as a READER, which is the form
 * `RunControllerOptions.correlationId` accepts, and it is derived by
 * `runCorrelationId()` from the seed and run identifier in force. DL-RUNCTL-04.
 *
 * @param options Store, seed, board, and which optional ports to publish.
 * @returns Everything a case reads or drives.
 */
function drive(options: DriveOptions = {}): Driven {
  const backing = options.backing ?? trackStorage(new MemoryStorage());
  const manager = new LocalStorageManager({ storage: backing });
  const config = createDefaultRulesConfig();
  const stages = createDefaultStageConfig();
  const sink = createReportSink();
  const registry = createRecordingRegistry();
  const engine = createRecordingEngine({
    board: options.board,
    startStage: options.startStage,
  });

  const createToken = (): string => {
    tokenSerial += 1;

    return `driven-run-${String(tokenSerial)}`;
  };

  const identity = resolveRunIdentity({
    storage: manager,
    createToken,
    seed: options.seed,
  });

  const holder: { controller: RunController | null } = { controller: null };

  const readCorrelationId = (): CorrelationId => {
    const live = holder.controller;

    return live === null ? '' : runCorrelationId(live.seed(), live.runId());
  };

  const store = new RunStateStore({
    storage: manager,
    config,
    reporter: sink.reporter,
    correlationId: readCorrelationId,
  });

  const offers = options.offers;

  const controller = new RunController({
    store,
    identity,
    config,
    stages,
    createToken,
    reporter: sink.reporter,
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
 * MEASURED. DL-STAGE-02.
 *
 * @param run The composed run.
 * @param board The board the move left, held by the engine as well so the two
 *   agree on the moment being described.
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
 * Emits `stage:end`, which is where a met goal is RESOLVED. DL-STAGE-02.
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

/** A board whose highest tile is `value`, built through the shared fixtures. */
function boardWithHighest(value: number): SerializedGameState {
  // `createNearWinBoard(size, winValue)` lays two tiles of half the win value,
  // so a win value of twice `value` yields a board whose highest tile is
  // exactly `value`.
  return createNearWinBoard(4, value * 2);
}

/**
 * Takes one relic on through the reward transaction, which is the only route by
 * which a relic joins a run.
 *
 * `resolveReward()` measures a selection against the offer standing, so the
 * identifier is recorded as that offer first.
 *
 * @param run The composed run.
 * @param relicId Identifier to offer and then select.
 * @returns What `resolveReward()` reported.
 */
function takeReward(run: Driven, relicId: string): RewardResolution {
  run.controller.recordRewardOffer([relicId]);

  return run.controller.resolveReward(relicId);
}


/* ==========================================================================
 * 22. The seed a run is played under
 *
 * Row TR-RUNCTL-07 of docs/TRACEABILITY_MATRIX.md: `originateRunSeed()` is the
 * ONE unseeded randomness source in the product, and it lives here rather than
 * in src/rng. Decision DL-RUNCTL-01.
 * ========================================================================== */

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

/* ==========================================================================
 * 23. Stage goals are data, and the measurement is one function
 *
 * Rows TR-STAGE-01 to TR-STAGE-03 of docs/TRACEABILITY_MATRIX.md, reached
 * through the run layer that consumes them. The controller holds no second
 * evaluator: decision DL-RUNCTL-03.
 * ========================================================================== */

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


/* ==========================================================================
 * 24. The controller SUBSCRIBES; it is never called by the engine
 *
 * Row TR-RUNCTL-01 of docs/TRACEABILITY_MATRIX.md: the three input
 * subscriptions js/game_manager.js L9-L11 installed at construction become the
 * four engine subscriptions `observe()` installs.
 * ========================================================================== */

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

/* ==========================================================================
 * 25. A stage is MEASURED at move:after and RESOLVED at stage:end
 *
 * The order Figure 4 (Turn Data Flow) publishes as `SG{"Stage goal met?"} ->
 * SE["onStageEnd dispatch to reward screen"]`, and Figure 6 (Screen Flow State
 * Machine) as `Stage -> StageClear -> Reward -> Stage`. Decision DL-STAGE-02.
 * ========================================================================== */

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

/* ==========================================================================
 * 26. startRun, resumeRun and endRun over the ports
 *
 * Rows TR-RUNCTL-02 (js/game_manager.js L17-L21 `restart()`), TR-RUNCTL-04
 * (L35-L45 `setup()`), TR-RUNCTL-05 (L85-L89 the save-or-clear branch) and
 * TR-RUNCTL-06 (L95 the read-after-write) of docs/TRACEABILITY_MATRIX.md.
 * ========================================================================== */

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

    // PICKUP ORDER, carried across the reload exactly as it was recorded.
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

    // Composition itself must survive the payload; nothing here writes over it,
    // so the second composition below reads the same corrupted value.
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

    // js/game_manager.js L17-L21: the board is discarded and a fresh one opens.
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

    // Reported under the identity of the run that ENDED. `finish()` replaces the
    // envelope with a fresh run afterwards, so the identifier the controller
    // publishes from here on belongs to the next run rather than to this one.
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
 * 27. Reward resolution records the triple, in pickup order
 *
 * Contract 3 of AAP 0.6.1.3 fixes the persisted relic to `id`, optional
 * `charges` and optional `state`. What an OFFER is drawn from — rarity
 * weighting, sampling without replacement, the no-duplicate-in-three property —
 * belongs to src/relics/relic-draw.ts and is asserted in
 * tests/unit/relics/relic-draw.test.ts; what is asserted here is that the
 * SELECTED relic is recorded correctly.
 * ========================================================================== */

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

    // Handed back to the registry in the same order, so a resumed run dispatches
    // to its relics rather than only displaying them.
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

    // Offered and selected a second time: the run holds it, so it is refused
    // rather than recorded twice.
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
});

describe('the controller branches on no individual relic', () => {
  it('records an identifier only the injected registry knows', () => {
    const run = drive();

    // Every identifier in this suite's catalogue is declared in this file.
    // Nothing in src/run names one, so the registry is the only construct that
    // knows the relic exists.
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

    // Stage -> StageClear -> Reward of Figure 6: the stage was resolved and the
    // index has NOT moved while the choice stands.
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

    // The selection persisted itself, rather than waiting for a later commit.
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
});


/* ==========================================================================
 * 28. summary(): the run as a summary screen reads it
 *
 * Working assumption A4 of AAP 0.1.1.4: the seed is DISPLAYED AND COPYABLE on
 * the run summary and accepted on the run-start screen. Sharing, networking and
 * daily seeds are out of scope per AAP 0.7.2.1, and nothing here asserts one.
 * ========================================================================== */

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

/* ==========================================================================
 * 29. The correlation identifier every report of a run carries
 *
 * Row TR-RUNCTL-04 and decision DL-RUNCTL-04: the identifier is REPUBLISHED
 * from an injected source, never derived here, and `runCorrelationId()` of
 * src/run/run-state.ts is the derivation the composition root supplies. An
 * identifier that shifted mid-run would leave every log line of that run
 * unjoinable.
 * ========================================================================== */

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

    // THE RELOAD. A resumed run keeps the stored seed and run identifier, so it
    // reports under the identifier the run has been reporting under all along.
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

    // Both still group under the seed, which is the grouping form's whole point.
    const grouped = runCorrelationId('one-seed-two-runs');

    expect(first.controller.correlationId().startsWith(grouped)).toBe(true);
    expect(second.controller.correlationId().startsWith(grouped)).toBe(true);
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

/* ==========================================================================
 * 30. stageCommitContextProvider: the stage slice the engine places on a commit
 *
 * Row TR-RUNCTL-08 of docs/TRACEABILITY_MATRIX.md. The provider is HANDED TO the
 * engine, which is what keeps src/engine from importing src/run or src/relics.
 * ========================================================================== */

describe('stageCommitContextProvider', () => {
  it('yields a provider that reads the stage in force at call time', () => {
    const run = drive();
    const provider = run.controller.stageCommitContextProvider();
    const opening: StageCommitContext = provider();

    expect(opening.stageIndex).toBe(0);
    expect(opening.goal).toEqual(stageGoalForIndex(0, run.stages));
    expect(opening.goalProgress).toBe(0);

    run.controller.advanceStage();

    // The SAME provider, read again: it resolves the envelope fresh rather than
    // capturing it.
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
 * The two cases below are ORDERED: the first writes the frozen best-score key
 * into a tracked store, the second finds it gone. js/local_storage_manager.js
 * L61-L63 removed the board snapshot and never the best score, so a suite that
 * ignored the key would leak the highest score into every case after it.
 * ========================================================================== */

/** One store the ordered pair below shares, tracked for teardown. */
const isolationBacking = trackStorage(new MemoryStorage());

describe('the persistence teardown', () => {
  it('leaves a best score and an envelope for the teardown to remove', () => {
    const manager = new LocalStorageManager({ storage: isolationBacking });

    expect(manager.setBestScore(4096)).toBe(true);

    const run = drive({ backing: isolationBacking, seed: 'leaks-nothing' });

    takeReward(run, 'port-plain');

    expect(typeof isolationBacking.getItem(BEST_SCORE_KEY)).toBe('string');
    expect(isolationBacking.getItem(RUN_STATE_KEY)).not.toBeUndefined();
    expect(manager.getBestScore()).toBe('4096');
  });

  it('finds every key the product owns gone at the start of a later case', () => {
    expect(isolationBacking.getItem(BEST_SCORE_KEY)).toBeUndefined();
    expect(isolationBacking.getItem(GAME_STATE_KEY)).toBeUndefined();
    expect(isolationBacking.getItem(RUN_STATE_KEY)).toBeUndefined();

    for (const key of CLEARED_KEYS) {
      expect(isolationBacking.getItem(key)).toBeUndefined();
    }

    // The frozen literal is one of the keys removed, named through the imported
    // constant rather than spelled out here.
    expect(CLEARED_KEYS).toContain(BEST_SCORE_KEY);
    expect(new LocalStorageManager({ storage: isolationBacking }).getBestScore())
      .toBe(0);
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

describe('the ported engine port', () => {
  it('publishes move, restart and continuePlaying, one per input action', () => {
    const run = drive({ observe: false });
    const port = run.engine.port;

    // The three names js/game_manager.js L9-L11 subscribed at construction.
    expect(typeof port.move).toBe('function');
    expect(typeof port.restart).toBe('function');
    expect(typeof port.continuePlaying).toBe('function');
  });

  it('separates the terminated query from the continue command', () => {
    const run = drive({ observe: false });
    const port = run.engine.port;

    expect(typeof port.isGameTerminated).toBe('function');
    expect(typeof port.continuePlaying).toBe('function');

    // Two members, never one name carrying both a method and a boolean.
    expect(port.isGameTerminated).not.toBe(port.continuePlaying);
    expect(port.isGameTerminated()).toBe(false);
    expect(run.engine.calls).toContain('isGameTerminated');
  });

  it('reads the frozen board member when it answers the query', () => {
    const run = drive({ observe: false });

    // A won board with play not continued is terminated; continuing it is what
    // the command does, and the flag it reads carries the frozen wire name.
    run.engine.hold({ ...createMergePairBoard(), won: true });

    expect(run.engine.port.isGameTerminated()).toBe(true);

    run.engine.hold({
      ...createMergePairBoard(),
      won: true,
      keepPlaying: true,
    });

    expect(run.engine.port.isGameTerminated()).toBe(false);
  });

  it('takes exactly the four directions and nothing wider', () => {
    const run = drive({ observe: false });
    const directions: readonly MoveDirection[] = [0, 1, 2, 3];

    for (const direction of directions) {
      expect(run.engine.port.move(direction)).toBe(true);
    }

    expect(run.engine.moves).toEqual([0, 1, 2, 3]);
  });
});
