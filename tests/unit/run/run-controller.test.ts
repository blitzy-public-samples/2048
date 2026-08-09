/**
 * The run lifecycle, composed.
 *
 * WHAT IS UNDER TEST
 *   The COMPOSITION of the run layer: most of what follows drives a real
 *   `Engine` against a real `RunStateStore` over an injected store, not the
 *   controller against fakes. Decisions of docs/DECISION_LOG.md it is the
 *   evidence for, one apiece: DL-RUNCTL-01, DL-RUNCTL-02, DL-RUNCTL-03,
 *   DL-RUNCTL-04. Rows of docs/TRACEABILITY_MATRIX.md it covers, one apiece:
 *   TR-RUNCTL-01, TR-RUNCTL-02, TR-RUNCTL-03, TR-RUNCTL-04, TR-RUNCTL-05,
 *   TR-RUNCTL-06, TR-RUNCTL-07, TR-RUNCTL-08.
 *
 * THE STORE IS INJECTED
 *   `tests/unit/run/` runs in both the `unit:dom-free` project, which has no
 *   Web Storage at all, and the `unit:dom` project, which has jsdom's. A
 *   `MemoryStorage` handed to `LocalStorageManager` makes every case below
 *   behave identically in both, and keeps one test's storage out of the next
 *   test's reach without depending on teardown. Decision DL-TEST-01.
 */

import { describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import type { RulesConfig } from '../../../src/config/rules-config';
import {
  createDefaultStageConfig,
  type StageConfig,
} from '../../../src/config/stage-config';
import { Engine } from '../../../src/engine/engine';
import {
  DIRECTION_DOWN,
  DIRECTION_LEFT,
  DIRECTION_RIGHT,
  DIRECTION_UP,
  type Direction,
  type SerializedGameState,
} from '../../../src/engine/types';
import { createRngStreams } from '../../../src/rng/rng-streams';
import {
  RunController,
  resolveRunIdentity,
  type RewardOffer,
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
  type PersistedRelic,
  type RunReporter,
  type RunState,
} from '../../../src/run/run-state';
import { RunStateStore } from '../../../src/run/run-state-store';
import { LocalStorageManager } from '../../../src/storage/local-storage-manager';
import { MemoryStorage } from '../../../src/storage/memory-storage';
import {
  BEST_SCORE_KEY,
  GAME_STATE_KEY,
  RUN_STATE_KEY,
} from '../../../src/storage/storage-keys';

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
