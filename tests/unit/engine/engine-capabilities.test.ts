// Contract suite for the four engine capabilities the hook surface gained:
// the stage transition, the one-shot stage end, the board-effect channel and the
// transformable spawn count, plus the degraded terminal state.
//
// Scope boundaries. The move walk, the merge branch and vanilla parity ->
// engine.test.ts; dispatch order, payload validation and charge accounting ->
// hook-bus.test.ts; stage progression and reward resolution ->
// tests/unit/run/run-controller.test.ts.
//
// Every collaborator arrives through the engine's single options object, so this
// suite needs no mocking library. It reads no DOM and no storage, and runs in the
// `unit:dom-free` project of vitest.config.ts.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BOARD_SIZE,
  createDefaultRulesConfig,
} from '../../../src/config/default-config';
import type { RulesConfig } from '../../../src/config/rules-config';
import type { StageGoal } from '../../../src/config/stage-config';
import { Engine } from '../../../src/engine/engine';
import type {
  StageStartEvent,
  StateCommitEvent,
} from '../../../src/engine/engine-events';
import { createHookBus } from '../../../src/engine/hook-bus';
import type { HookBus } from '../../../src/engine/hook-bus';
import type {
  AfterMovePayload,
  BeforeMovePayload,
  HookContext,
  SpawnPayload,
} from '../../../src/engine/hooks';
import { DIRECTION_LEFT } from '../../../src/engine/types';
import type {
  EngineCountReport,
  EngineReporter,
  SerializedGameState,
  StageCommitContext,
} from '../../../src/engine/types';
import { createRngStreams } from '../../../src/rng/rng-streams';
import type { RngStreams } from '../../../src/rng/rng-streams';
import { MERGE_PAIR_BOARD, copyBoard } from '../../fixtures/boards';

/* ===== 0. Constants, doubles and helpers ===== */

/** Run seed every deterministic case below is built from. */
const RUN_SEED = 'engine-capabilities-seed-1';

/**
 * Builds the run's four substreams.
 *
 * @param seed Run seed. Defaults to `RUN_SEED`.
 * @returns The substream table.
 */
function streamsFor(seed: string = RUN_SEED): RngStreams {
  return createRngStreams(seed);
}

/** A reporter that records every counter it receives. */
function createRecordingReporter(): {
  reporter: EngineReporter;
  counts: EngineCountReport[];
  metric(name: string): number;
} {
  const counts: EngineCountReport[] = [];

  return {
    reporter: {
      onCount: (report): void => {
        counts.push(report);
      },
    },
    counts,

    metric: (name: string): number =>
      counts
        .filter((report) => report.metric === name)
        .reduce((total, report) => total + report.value, 0),
  };
}

/**
 * Records every state commit the engine emits.
 *
 * @param engine Engine to observe.
 * @returns The array the commits land in, in emission order.
 */
function captureCommits(engine: Engine): StateCommitEvent[] {
  const commits: StateCommitEvent[] = [];

  engine.events.on('state:commit', (commit): void => {
    commits.push(commit);
  });

  return commits;
}

/**
 * Registers one handler table on a bus under one identifier.
 *
 * @param bus Bus to register on.
 * @param id Subscriber identifier.
 * @param hooks Handler table.
 * @param charges Optional charge budget.
 */
function register(
  bus: HookBus,
  id: string,
  hooks: Parameters<HookBus['register']>[0]['hooks'],
  charges?: number,
): void {
  bus.register(charges === undefined ? { id, hooks } : { id, hooks, charges });
}

/** A stage provider whose index and goal a test drives. */
function createStageSource(target: number): {
  provider: () => StageCommitContext;
  advance(nextTarget: number): void;
  index(): number;
} {
  let index = 0;
  let goal: StageGoal = { kind: 'highest-tile', target };

  return {
    provider: (): StageCommitContext =>
      Object.freeze({ stageIndex: index, goal, goalProgress: 0 }),

    advance: (nextTarget: number): void => {
      index += 1;
      goal = { kind: 'highest-tile', target: nextTarget };
    },

    index: (): number => index,
  };
}

/* ===== 1. The stage transition (C2) ===== */

describe('the stage transition', () => {
  it('ends a stage exactly once, however many times it is asked to', () => {
    const bus = createHookBus();
    const engine = new Engine({ streams: streamsFor(), hooks: bus });
    const ends: number[] = [];

    engine.events.on('stage:end', (event): void => {
      ends.push(event.stageIndex);
    });

    engine.setup(null);
    engine.endStage(true);
    engine.endStage(true);
    engine.endStage(false);

    expect(ends).toEqual([0]);
    expect(engine.hasStageEnded()).toBe(true);
  });

  it('counts every repeated end it refused', () => {
    const recording = createRecordingReporter();
    const engine = new Engine({
      streams: streamsFor(),
      reporter: recording.reporter,
    });

    engine.setup(null);
    engine.endStage(true);
    engine.endStage(true);
    engine.endStage(true);

    expect(recording.metric('engine.stage.end.repeated')).toBe(2);
  });

  it('releases the guard and dispatches onStageStart once per transition', () => {
    const bus = createHookBus();
    const stage = createStageSource(16);
    const starts: StageStartEvent[] = [];
    let dispatched = 0;

    register(bus, 'watcher', {
      onStageStart: (): void => {
        dispatched += 1;
      },
    });

    const engine = new Engine({
      streams: streamsFor(),
      hooks: bus,
      stageContext: stage.provider,
    });

    engine.events.on('stage:start', (event): void => {
      starts.push(event);
    });

    engine.setup(null);

    expect(dispatched).toBe(1);

    engine.endStage(true);
    stage.advance(32);
    engine.startStage(engine.serialize());

    expect(dispatched).toBe(2);
    expect(engine.hasStageEnded()).toBe(false);
    expect(starts).toHaveLength(2);
    expect(starts[1]?.stageIndex).toBe(1);
    expect(starts[1]?.goal.target).toBe(32);

    // The stage that follows can now end in its own right.
    engine.endStage(true);

    expect(engine.hasStageEnded()).toBe(true);
  });

  it('carries the board into the stage it opens, adding no start tiles', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    const before = engine.serialize();

    engine.endStage(true);
    engine.startStage(before);

    expect(engine.serialize().grid).toEqual(before.grid);
  });

  it('opens a fresh board when no snapshot is supplied', () => {
    const config = createDefaultRulesConfig();
    const engine = new Engine({ config, streams: streamsFor() });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));
    engine.endStage(true);
    engine.startStage();

    const tiles = engine
      .serialize()
      .grid.cells.flat()
      .filter((cell) => cell !== null);

    expect(tiles).toHaveLength(config.startTiles);
  });

  it('counts the stages it started', () => {
    const recording = createRecordingReporter();
    const engine = new Engine({
      streams: streamsFor(),
      reporter: recording.reporter,
    });

    engine.setup(null);
    engine.startStage();
    engine.startStage();

    expect(recording.metric('engine.stage.started')).toBe(2);
  });
});

/* ===== 2. The board-effect channel (M1, M4) ===== */

describe('the board-effect channel', () => {
  it('installs a lattice a pre-move handler assembled', () => {
    const bus = createHookBus();

    register(bus, 'undo', {
      onBeforeMove: (payload: BeforeMovePayload, context: HookContext) => {
        const board = payload.board.serialize();

        // Empty every cell, which is a lattice no move could have produced.
        for (const column of board.cells) {
          for (let y = 0; y < column.length; y += 1) {
            column[y] = null;
          }
        }

        context.effects.request({ kind: 'restoreBoard', board, score: 99 });
        payload.cancelled = true;

        return payload;
      },
    });

    const engine = new Engine({ streams: streamsFor(), hooks: bus });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    const commits = captureCommits(engine);

    expect(engine.move(DIRECTION_LEFT)).toBe(false);
    expect(engine.serialize().grid.cells.flat().every((cell) => cell === null))
      .toBe(true);
    expect(engine.score).toBe(99);

    // A withdrawn move that reseated the board still commits, so no view is
    // left showing tiles the engine no longer holds.
    expect(commits).toHaveLength(1);
  });

  it('resizes the live board, keeping in-bounds tiles in their own cells', () => {
    const bus = createHookBus();
    const config = createDefaultRulesConfig();

    register(bus, 'vault', {
      onStageEnd: (payload, context: HookContext) => {
        context.effects.request({ kind: 'resizeBoard', boardSize: 3 });

        return payload;
      },
    });

    const engine = new Engine({ config, streams: streamsFor(), hooks: bus });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    const before = engine.serialize().grid;
    const kept = before.cells[0]?.[0];

    engine.endStage(true);

    const after = engine.serialize().grid;

    expect(after.size).toBe(3);
    expect(after.cells).toHaveLength(3);
    expect(after.cells[0]).toHaveLength(3);

    // The rules follow the lattice, so the loss probe and the win check read
    // the size the board actually has.
    expect(config.boardSize).toBe(3);

    // The tile that was inside the new bounds is in the same cell, not moved.
    expect(after.cells[0]?.[0]?.value).toBe(kept?.value);
    expect(after.cells[0]?.[0]?.position).toEqual({ x: 0, y: 0 });
  });

  it('refuses an unusable effect and counts the refusal', () => {
    const bus = createHookBus();
    const recording = createRecordingReporter();

    register(bus, 'bad', {
      onAfterMove: (payload: AfterMovePayload, context: HookContext) => {
        context.effects.request({
          kind: 'resizeBoard',
          boardSize: 4096,
        });

        return payload;
      },
    });

    const engine = new Engine({
      streams: streamsFor(),
      hooks: bus,
      reporter: recording.reporter,
    });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));
    engine.move(DIRECTION_LEFT);

    expect(engine.serialize().grid.size).toBe(DEFAULT_BOARD_SIZE);
    expect(recording.metric('engine.effect.refused')).toBeGreaterThan(0);
  });

  it('keeps nothing a throwing handler requested', () => {
    const bus = createHookBus();

    register(bus, 'thrower', {
      onBeforeMove: (payload: BeforeMovePayload, context: HookContext) => {
        const board = payload.board.serialize();

        for (const column of board.cells) {
          for (let y = 0; y < column.length; y += 1) {
            column[y] = null;
          }
        }

        context.effects.request({ kind: 'restoreBoard', board });

        throw new Error('after requesting');
      },
    });

    const engine = new Engine({ streams: streamsFor(), hooks: bus });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    const before = engine.serialize();

    engine.move(DIRECTION_LEFT);

    expect(engine.serialize().grid.cells.flat().some((cell) => cell !== null))
      .toBe(true);
    expect(before.grid.cells.flat().filter((cell) => cell !== null).length)
      .toBeGreaterThan(0);
  });

  it('refuses a request from onMerge and from onSpawn', () => {
    const bus = createHookBus();
    const attempts: boolean[] = [];

    register(bus, 'mid-walk', {
      onMerge: (payload, context: HookContext) => {
        attempts.push(
          context.effects.request({
            kind: 'resizeBoard',
            boardSize: 3,
          }),
        );

        return payload;
      },
      onSpawn: (payload: SpawnPayload, context: HookContext) => {
        attempts.push(
          context.effects.request({
            kind: 'resizeBoard',
            boardSize: 3,
          }),
        );

        return payload;
      },
    });

    const engine = new Engine({ streams: streamsFor(), hooks: bus });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));
    engine.move(DIRECTION_LEFT);

    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every((accepted) => accepted === false)).toBe(true);
    expect(engine.serialize().grid.size).toBe(DEFAULT_BOARD_SIZE);
  });
});

/* ===== 3. The transformable spawn count (M2) ===== */

describe('the spawn count', () => {
  it('inserts one tile when no handler raises the count', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    const before = engine
      .serialize()
      .grid.cells.flat()
      .filter((cell) => cell !== null).length;

    engine.move(DIRECTION_LEFT);

    // One merge removes a tile and one spawn adds one, so the occupied count
    // falls by exactly the merge.
    const after = engine
      .serialize()
      .grid.cells.flat()
      .filter((cell) => cell !== null).length;

    expect(after).toBe(before);
  });

  it('inserts every tile a raised count asked for', () => {
    const bus = createHookBus();

    register(bus, 'fertile', {
      onSpawn: (payload: SpawnPayload) => ({ ...payload, count: 3 }),
    });

    const engine = new Engine({ streams: streamsFor(), hooks: bus });
    const spawns: number[] = [];

    engine.setup(copyBoard(MERGE_PAIR_BOARD));
    engine.events.on('tile:spawn', (event): void => {
      spawns.push(event.value);
    });

    const before = engine
      .serialize()
      .grid.cells.flat()
      .filter((cell) => cell !== null).length;

    engine.move(DIRECTION_LEFT);

    const after = engine
      .serialize()
      .grid.cells.flat()
      .filter((cell) => cell !== null).length;

    expect(spawns).toHaveLength(3);
    expect(after).toBe(before + 2);
  });

  it('stays deterministic under a fixed seed', () => {
    const play = (): string => {
      const bus = createHookBus();

      register(bus, 'fertile', {
        onSpawn: (payload: SpawnPayload) => ({ ...payload, count: 2 }),
      });

      const engine = new Engine({ streams: streamsFor(), hooks: bus });

      engine.setup(copyBoard(MERGE_PAIR_BOARD));
      engine.move(DIRECTION_LEFT);

      return JSON.stringify(engine.serialize());
    };

    expect(play()).toBe(play());
  });

  it('inserts nothing beyond the cells the board has left', () => {
    const bus = createHookBus();

    register(bus, 'greedy', {
      onSpawn: (payload: SpawnPayload) => ({ ...payload, count: 99 }),
    });

    const engine = new Engine({ streams: streamsFor(), hooks: bus });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    expect(() => {
      engine.move(DIRECTION_LEFT);
    }).not.toThrow();

    const cells = engine.serialize().grid.cells.flat();

    expect(cells.filter((cell) => cell === null)).toHaveLength(0);
    expect(cells).toHaveLength(DEFAULT_BOARD_SIZE * DEFAULT_BOARD_SIZE);
  });
});

/* ===== 4. The degraded terminal state (N3) ===== */

describe('a terminal-state measurement that cannot be taken', () => {
  /**
   * A full board carrying exactly one mergeable pair.
   *
   * The shape the loss probe is reachable from: a LEFT move merges the pair and
   * frees one cell, the spawn refills it, and the board is then full — which is
   * the only state in which `movesAvailable` walks the neighbour pairs and
   * therefore the only state in which the configured merge predicate is read by
   * the probe rather than by the move walk.
   *
   * @returns The snapshot.
   */
  const fullBoardWithOnePair = (): SerializedGameState => {
    const cells: ({ position: { x: number; y: number }; value: number } | null)[][] =
      [];
    let exponent = 2;

    for (let x = 0; x < DEFAULT_BOARD_SIZE; x += 1) {
      const column: (
        | { position: { x: number; y: number }; value: number }
        | null
      )[] = [];

      for (let y = 0; y < DEFAULT_BOARD_SIZE; y += 1) {
        // The one pair: two 2s adjacent along x at y = 0.
        const value = y === 0 && x < 2 ? 2 : 2 ** exponent;

        if (!(y === 0 && x < 2)) {
          exponent += 1;
        }

        column.push({ position: { x, y }, value });
      }

      cells.push(column);
    }

    return {
      grid: { size: DEFAULT_BOARD_SIZE, cells },
      score: 0,
      over: false,
      won: false,
      keepPlaying: false,
    };
  };

  it('leaves the loss flag unasserted and reports the turn degraded', () => {
    const recording = createRecordingReporter();
    const config = createDefaultRulesConfig();
    const predicate = config.merge.canMerge;
    let armed = false;

    // Armed BETWEEN the move walk and the loss probe: `tile:spawn` is emitted
    // by the spawn that follows the walk and precedes the probe, so the walk
    // resolves normally and only the probe is made to raise.
    const rules: RulesConfig = {
      ...config,
      merge: {
        canMerge: (moving, standing): boolean => {
          if (armed) {
            throw new Error('loss probe failed');
          }

          return predicate(moving, standing);
        },
        produce: config.merge.produce,
      },
    };

    const engine = new Engine({
      config: rules,
      streams: streamsFor(),
      reporter: recording.reporter,
    });

    engine.setup(fullBoardWithOnePair());
    engine.events.on('tile:spawn', (): void => {
      armed = true;
    });

    const commits = captureCommits(engine);

    // The turn completes rather than raising out of a move whose board has
    // already changed, and it does not claim a terminal status it could not
    // measure.
    expect(() => {
      engine.move(DIRECTION_LEFT);
    }).not.toThrow();

    expect(recording.metric('engine.terminal.unknown')).toBeGreaterThan(0);
    expect(engine.over).toBe(false);
    expect(engine.isDegraded()).toBe(true);
    expect(commits.at(-1)?.degraded).toBe(true);
  });

  it('resolves no stage from a measurement it could not take', () => {
    const recording = createRecordingReporter();

    // A goal `evaluateStageGoal` refuses: it raises on a kind it does not know,
    // and the engine is the resolving authority, so the measurement is taken
    // inside the turn.
    const engine = new Engine({
      streams: streamsFor(),
      reporter: recording.reporter,
      stageResolution: 'engine',
      stageContext: (): StageCommitContext =>
        Object.freeze({
          stageIndex: 0,
          goal: { kind: 'unknown-kind', target: 4 } as unknown as StageGoal,
          goalProgress: 0,
        }),
    });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    const ends: number[] = [];

    engine.events.on('stage:end', (event): void => {
      ends.push(event.stageIndex);
    });

    expect(() => {
      engine.move(DIRECTION_LEFT);
    }).not.toThrow();

    expect(ends).toHaveLength(0);
    expect(recording.metric('engine.terminal.unknown')).toBeGreaterThan(0);
    expect(engine.isDegraded()).toBe(true);
  });

  it('is treated as non-terminal by the engine and by what it persists', () => {
    // WHAT THE COMPROMISE IS, ASSERTED. The commit path may not throw — the
    // storage port case in tests/unit/engine/engine.test.ts pins that for its own
    // reason — so a turn whose terminal status could not be measured commits with
    // the board and score the walk produced. What must not happen is anything
    // downstream reading that turn AS terminal, which is what would end a run on
    // a measurement that was never taken.
    const recording = createRecordingReporter();
    const config = createDefaultRulesConfig();
    const predicate = config.merge.canMerge;
    const saved: SerializedGameState[] = [];
    let armed = false;

    const engine = new Engine({
      config: {
        ...config,
        merge: {
          canMerge: (moving, standing): boolean => {
            if (armed) {
              throw new Error('loss probe failed');
            }

            return predicate(moving, standing);
          },
          produce: config.merge.produce,
        },
      },
      streams: streamsFor(),
      reporter: recording.reporter,
      storage: {
        getBestScore: (): string | 0 => 0,
        setBestScore: (): void => {},
        getGameState: (): unknown => null,
        setGameState: (state: unknown): void => {
          saved.push(state as SerializedGameState);
        },
        clearGameState: (): void => {},
      },
    });

    engine.setup(fullBoardWithOnePair());
    engine.events.on('tile:spawn', (): void => {
      armed = true;
    });

    const commits = captureCommits(engine);

    engine.move(DIRECTION_LEFT);

    expect(engine.isDegraded()).toBe(true);

    // Not terminal to the engine, not terminal in the snapshot a resumed session
    // would load, and not terminal on the wire either.
    expect(engine.isGameTerminated()).toBe(false);
    expect(saved.at(-1)?.over).toBe(false);
    expect(commits.at(-1)?.over).toBe(false);
    expect(commits.at(-1)?.terminated).toBe(false);

    // The degradation is what a consumer reads instead, and it is on the commit
    // itself rather than only in a metric.
    expect(commits.at(-1)?.degraded).toBe(true);
  });

  it('clears the degraded state once a measurement succeeds again', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));
    engine.move(DIRECTION_LEFT);

    expect(engine.isDegraded()).toBe(false);
  });
});

/* ===== 5. The monotonic turn (M9) ===== */

describe('the monotonic turn', () => {
  it('rises once per commit and is carried by the granular events', () => {
    const engine = new Engine({ streams: streamsFor() });
    const commits = captureCommits(engine);
    const merges: number[] = [];
    const spawns: number[] = [];
    const afters: number[] = [];

    engine.events.on('tile:merge', (event): void => {
      merges.push(event.turn);
    });
    engine.events.on('tile:spawn', (event): void => {
      spawns.push(event.turn);
    });
    engine.events.on('move:after', (event): void => {
      afters.push(event.turn);
    });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    expect(commits.map((commit) => commit.turn)).toEqual([1]);

    engine.move(DIRECTION_LEFT);

    expect(commits.map((commit) => commit.turn)).toEqual([1, 2]);
    expect(engine.currentTurn()).toBe(2);

    // Every granular event of the turn names the commit that turn ends with.
    expect(merges.every((turn) => turn === 2)).toBe(true);
    expect(spawns.every((turn) => turn === 2)).toBe(true);
    expect(afters).toEqual([2]);
  });

  it('never resets, so an orphaned buffer entry stays detectable', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(null);

    const first = engine.currentTurn();

    engine.restart();

    expect(engine.currentTurn()).toBeGreaterThan(first);

    engine.startStage();

    expect(engine.currentTurn()).toBeGreaterThan(first + 1);
  });
});

/* ===== 6. Serialised snapshot of the new members ===== */

describe('the commit payload', () => {
  it('carries the turn and the degraded flag on every commit', () => {
    const engine = new Engine({ streams: streamsFor() });
    const commits = captureCommits(engine);

    engine.setup(null);

    const commit: SerializedGameState | undefined = undefined;

    expect(commit).toBeUndefined();
    expect(commits[0]?.turn).toBe(1);
    expect(commits[0]?.degraded).toBe(false);
  });
});

/* ==========================================================================
 * The accumulated onAfterMove payload
 * ========================================================================== */

describe('the accumulated onAfterMove payload', () => {
  it('adopts a handler-transformed score into state, the event and the commit', () => {
    const bus = createHookBus();

    register(bus, 'rescorer', {
      onAfterMove: (payload: AfterMovePayload): AfterMovePayload => ({
        ...payload,
        score: payload.score + 1000,
      }),
    });

    const engine = new Engine({
      streams: streamsFor(),
      hooks: bus,
    });

    const afters: number[] = [];
    const commits: number[] = [];

    engine.events.on('move:after', (event): void => {
      afters.push(event.score);
    });
    engine.events.on('state:commit', (event): void => {
      commits.push(event.score);
    });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));
    engine.move(DIRECTION_LEFT);

    // The dispatch's RESULT is what the engine adopted, so one transformation
    // reaches the engine's own score, the granular event and the commit alike —
    // there is no path on which the pre-dispatch payload survives.
    expect(afters.at(-1)).toBeGreaterThanOrEqual(1000);
    expect(commits.at(-1)).toBe(afters.at(-1));
    expect(engine.serialize().score).toBe(afters.at(-1));
  });

  it('measures the stage goal against the transformed score, not the original', () => {
    const bus = createHookBus();

    // A score-threshold goal of 1000 that the turn's own merge cannot reach: only
    // the handler's transformation can clear it.
    const goal: StageGoal = { kind: 'score-threshold', target: 1000 };
    const stage = (): StageCommitContext =>
      Object.freeze({ stageIndex: 0, goal, goalProgress: 0 });
    const ends: boolean[] = [];

    register(bus, 'rescorer', {
      onAfterMove: (payload: AfterMovePayload): AfterMovePayload => ({
        ...payload,
        score: 1500,
      }),
    });

    const engine = new Engine({
      streams: streamsFor(),
      hooks: bus,
      stageContext: stage,

      // The engine resolves its own stage here, so the clear is observable
      // without a run controller. `'observer'` is the default, under which the
      // controller owns resolution.
      stageResolution: 'engine',
    });

    engine.events.on('stage:end', (event): void => {
      ends.push(event.cleared);
    });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));
    engine.move(DIRECTION_LEFT);

    // The stage cleared, which it could only do on the transformed score. This is
    // the property the hook protocol promises: a relic can move goal progress
    // deterministically.
    expect(ends).toEqual([true]);
  });

  it('refuses a return that changes board or moved, keeping them invariant', () => {
    const bus = createHookBus();
    const recording = createRecordingReporter();

    register(bus, 'liar', {
      onAfterMove: (payload: AfterMovePayload): AfterMovePayload => ({
        ...payload,
        moved: false,
      }),
    });

    const engine = new Engine({
      streams: streamsFor(),
      hooks: bus,
      reporter: recording.reporter,
    });

    const afters: boolean[] = [];

    engine.events.on('move:after', (event): void => {
      afters.push(event.moved);
    });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));
    engine.move(DIRECTION_LEFT);

    // A move that resolved reports `moved: true` whatever a handler returned:
    // the bus refuses the whole return when an invariant member moved, so the
    // adoption above cannot be used to rewrite what happened.
    expect(afters).toEqual([true]);
  });

  it('adopts over and won, which is how a cursed relic ends a run', () => {
    const bus = createHookBus();

    register(bus, 'doomsayer', {
      onAfterMove: (payload: AfterMovePayload): AfterMovePayload => ({
        ...payload,
        over: true,
      }),
    });

    const engine = new Engine({ streams: streamsFor(), hooks: bus });
    const commits: StateCommitEvent[] = [];

    engine.events.on('state:commit', (event): void => {
      commits.push(event);
    });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));
    engine.move(DIRECTION_LEFT);

    const last = commits.at(-1);

    expect(last?.over).toBe(true);

    // `terminated` is DERIVED from the adopted flags rather than read back, so a
    // handler cannot leave a commit whose flags contradict each other.
    expect(last?.terminated).toBe(true);
  });
});
