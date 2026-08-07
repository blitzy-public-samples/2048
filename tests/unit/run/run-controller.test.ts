/**
 * The run lifecycle, composed.
 *
 * WHY THIS SUITE EXISTS
 *   The nine-member envelope and its store both shipped complete and neither
 *   was ever joined to a running game: the runtime persisted the legacy board
 *   snapshot alone and handed the engine the neutral stage and relic contexts.
 *   The defect was therefore in the COMPOSITION, not in either module, so most
 *   of what follows drives a real `Engine` against a real `RunStateStore` over
 *   an injected store rather than exercising the controller against fakes.
 *
 * WHY THE STORE IS INJECTED
 *   `tests/unit/run/` runs in both the `unit:dom-free` project, which has no
 *   Web Storage at all, and the `unit:dom` project, which has jsdom's. A
 *   `MemoryStorage` handed to `LocalStorageManager` makes every case below
 *   behave identically in both, and keeps one test's storage out of the next
 *   test's reach without depending on teardown.
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
import { RunController, resolveRunIdentity } from '../../../src/run/run-controller';
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
    expect(controller.state().goalProgress).toBe(0);
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
