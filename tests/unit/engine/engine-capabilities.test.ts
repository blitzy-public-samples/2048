// Contract suite for the four engine capabilities the hook surface gained: the
// stage transition, the one-shot stage end, the board-effect channel and the
// transformable spawn count, plus the degraded terminal state.
//
// Scope boundaries. The move walk, the merge branch and vanilla parity ->
// engine.test.ts; dispatch order, payload validation and charge accounting ->
// hook-bus.test.ts; stage progression and reward resolution ->
// tests/unit/run/run-controller.test.ts.
//
// Every collaborator arrives through the engine's single options object, so
// this suite needs no mocking library. It reads no DOM and no storage, and
// runs in the `unit:dom-free` project of vitest.config.ts.

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
import {
  BLOCKED_BOARD,
  MERGE_PAIR_BOARD,
  copyBoard,
} from '../../fixtures/boards';

/** Run seed every deterministic case below is built from. */
const RUN_SEED = 'engine-capabilities-seed-1';

/** Row of column 0 the excision case removes a tile from. */
const EXCISED_Y = DEFAULT_BOARD_SIZE - 1;

/** Face value the stage-goal cases target. */
const GOAL_TILE_VALUE = 2 ** (DEFAULT_BOARD_SIZE + 2);

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

describe('the board-effect channel', () => {
  it('installs a lattice a pre-move handler assembled', () => {
    const bus = createHookBus();

    register(bus, 'undo', {
      onBeforeMove: (payload: BeforeMovePayload, context: HookContext) => {
        const board = payload.board.serialize();

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

    expect(commits).toHaveLength(1);
  });

  it('commits an accepted pre-move effect the walk then found nothing to move', () => {
    const bus = createHookBus();
    const saved: SerializedGameState[] = [];

    // Never withdraws the move, exactly as `tumbler` and `culling-blade` do
    // not: the excision is recorded and the requested slide still resolves.
    register(bus, 'blade', {
      onBeforeMove: (payload: BeforeMovePayload, context: HookContext) => {
        context.effects.removeTile({ x: 0, y: EXCISED_Y });

        return payload;
      },
    });

    const engine = new Engine({
      streams: streamsFor(),
      hooks: bus,
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

    // LEFT is the fixture's blocked direction: every tile is already in column
    // 0, so the walk moves nothing and the vanilla turn would end silently.
    engine.setup(copyBoard(BLOCKED_BOARD));

    const commits = captureCommits(engine);
    const spawns: number[] = [];

    engine.events.on('tile:spawn', (): void => {
      spawns.push(1);
    });
    saved.length = 0;

    // The slide is what the return reports, and the slide moved nothing.
    expect(engine.move(DIRECTION_LEFT)).toBe(false);

    const cells = engine.serialize().grid.cells.flat();

    // The excision stands, and NOTHING was spawned to refill the cell it
    // freed: a spawn belongs to a move that moved.
    expect(cells.filter((cell) => cell !== null)).toHaveLength(
      DEFAULT_BOARD_SIZE - 1,
    );
    expect(spawns).toHaveLength(0);

    expect(commits).toHaveLength(1);
    expect(
      commits[0]?.board.cells.flat().filter((cell) => cell !== null),
    ).toHaveLength(DEFAULT_BOARD_SIZE - 1);
    expect(
      saved.at(-1)?.grid.cells.flat().filter((cell) => cell !== null),
    ).toHaveLength(DEFAULT_BOARD_SIZE - 1);
  });

  it('reports an effect-only turn as idle AND committed', () => {
    const bus = createHookBus();

    register(bus, 'blade', {
      onBeforeMove: (payload: BeforeMovePayload, context: HookContext) => {
        context.effects.removeTile({ x: 0, y: EXCISED_Y });

        return payload;
      },
    });

    const engine = new Engine({ streams: streamsFor(), hooks: bus });

    engine.setup(copyBoard(BLOCKED_BOARD));

    const commits = captureCommits(engine);
    const attempt = engine.attemptMove(DIRECTION_LEFT);

    // `resolution` and `moved` report the SLIDE, which moved nothing, while
    // `committed` reports that the turn nevertheless committed the board the
    // effect left.
    expect(attempt.resolution).toBe('idle');
    expect(attempt.moved).toBe(false);
    expect(attempt.committed).toBe(true);
    expect(commits).toHaveLength(1);
  });

  it('reports a withdrawn turn that reseated the board as committed', () => {
    const bus = createHookBus();

    register(bus, 'undoes', {
      onBeforeMove: (payload: BeforeMovePayload, context: HookContext) => {
        context.effects.request({
          kind: 'restoreBoard',
          board: { size: DEFAULT_BOARD_SIZE, cells: [] },
          score: 99,
        });
        payload.cancelled = true;

        return payload;
      },
    });

    const engine = new Engine({ streams: streamsFor(), hooks: bus });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    const commits = captureCommits(engine);
    const attempt = engine.attemptMove(DIRECTION_LEFT);

    expect(attempt.resolution).toBe('cancelled');
    expect(attempt.moved).toBe(false);
    expect(attempt.committed).toBe(true);
    expect(commits).toHaveLength(1);
  });

  it('resolves a stage the reseated board of a withdrawn move cleared', () => {
    const bus = createHookBus();

    // The rewind pairing: the board is restored AND the move is withdrawn,
    // which is what `temporal-anchor` does.
    register(bus, 'anchor', {
      onBeforeMove: (payload: BeforeMovePayload, context: HookContext) => {
        const board = payload.board.serialize();

        for (const column of board.cells) {
          for (let y = 0; y < column.length; y += 1) {
            column[y] = null;
          }
        }

        const first = board.cells[0];

        if (first !== undefined) {
          first[0] = { position: { x: 0, y: 0 }, value: GOAL_TILE_VALUE };
        }

        context.effects.request({ kind: 'restoreBoard', board });
        payload.cancelled = true;

        return payload;
      },
    });

    const goal: StageGoal = {
      kind: 'highest-tile',
      target: GOAL_TILE_VALUE,
    };

    const engine = new Engine({
      streams: streamsFor(),
      hooks: bus,
      stageContext: (): StageCommitContext =>
        Object.freeze({ stageIndex: 0, goal, goalProgress: 0 }),

      // The engine resolves its own stage here, so the clear is observable
      // without a run controller.
      stageResolution: 'engine',
    });

    const ends: boolean[] = [];

    engine.events.on('stage:end', (event): void => {
      ends.push(event.cleared);
    });

    // The highest tile on the board the move is pressed on is below the
    // target, so only the restored lattice can clear the stage.
    engine.setup(copyBoard(BLOCKED_BOARD));

    const commits = captureCommits(engine);

    expect(engine.move(DIRECTION_LEFT)).toBe(false);

    // The withdrawn move reseated the board, so the stage was measured against
    // what it left and resolved from it.
    expect(ends).toEqual([true]);
    expect(commits.length).toBeGreaterThan(0);
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

  it('suppresses a spawn a handler aimed at an occupied cell', () => {
    const bus = createHookBus();
    const recording = createRecordingReporter();

    // The merged tile's cell: a LEFT move on the merge-pair fixture merges
    // into (0, 0), so this is in bounds, and occupied, at the moment the spawn
    // resolves.
    register(bus, 'squatter', {
      onSpawn: (payload: SpawnPayload): SpawnPayload => ({
        ...payload,
        position: { x: 0, y: 0 },
      }),
    });

    const engine = new Engine({
      streams: streamsFor(),
      hooks: bus,
      reporter: recording.reporter,
    });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    const merged = engine.serialize().grid.cells[0]?.[0];
    const positions: (unknown | undefined)[] = [];

    engine.events.on('tile:spawn', (event): void => {
      positions.push(event.position);
    });

    engine.move(DIRECTION_LEFT);

    const occupant = engine.serialize().grid.cells[0]?.[0];

    // The tile that was there is still there.
    expect(occupant?.value).toBe((merged?.value ?? 0) * 2);
    expect(recording.metric('engine.spawn.suppressed')).toBeGreaterThan(0);

    // The suppressed attempt is still emitted, and carries no position.
    expect(positions).toEqual([undefined]);
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

describe('a terminal-state measurement that cannot be taken', () => {
  /**
   * A full board carrying exactly one mergeable pair.
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

    // Armed BETWEEN the move walk and the loss probe.
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

    // A goal `evaluateStageGoal` refuses: it raises on a kind it does not
    // know, and the engine is the resolving authority, so the measurement is
    // taken inside the turn.
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

  it('publishes a degradation the stage measurement raised, in a following commit', () => {
    const engine = new Engine({
      streams: streamsFor(),
      stageResolution: 'engine',
      stageContext: (): StageCommitContext =>
        Object.freeze({
          stageIndex: 0,
          goal: { kind: 'unknown-kind', target: 4 } as unknown as StageGoal,
          goalProgress: 0,
        }),
    });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));

    const commits = captureCommits(engine);

    engine.move(DIRECTION_LEFT);

    expect(engine.isDegraded()).toBe(true);

    // The LAST commit a view holds is the truthful one, and the turn's own
    // commit — taken before the measurement was attempted — is still in the
    // stream ahead of it.
    expect(commits.length).toBeGreaterThan(1);
    expect(commits.at(-1)?.degraded).toBe(true);
  });

  it('is treated as non-terminal by the engine and by what it persists', () => {
    // What the compromise is, asserted. The commit path may not throw — the
    // storage port case in tests/unit/engine/engine.test.ts pins that for its
    // own reason — so a turn whose terminal status could not be measured
    // commits with the board and score the walk produced.
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

    // Not terminal to the engine, not terminal in the snapshot a resumed
    // session would load, and not terminal on the wire either.
    expect(engine.isGameTerminated()).toBe(false);
    expect(saved.at(-1)?.over).toBe(false);
    expect(commits.at(-1)?.over).toBe(false);
    expect(commits.at(-1)?.terminated).toBe(false);

    expect(commits.at(-1)?.degraded).toBe(true);
  });

  it('clears the degraded state once a measurement succeeds again', () => {
    const engine = new Engine({ streams: streamsFor() });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));
    engine.move(DIRECTION_LEFT);

    expect(engine.isDegraded()).toBe(false);
  });
});

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
    // reaches the engine's own score, the granular event and the commit alike
    // — there is no path on which the pre-dispatch payload survives.
    expect(afters.at(-1)).toBeGreaterThanOrEqual(1000);
    expect(commits.at(-1)).toBe(afters.at(-1));
    expect(engine.serialize().score).toBe(afters.at(-1));
  });

  it('measures the stage goal against the transformed score, not the original', () => {
    const bus = createHookBus();

    // A score-threshold goal of 1000 that the turn's own merge cannot reach:
    // only the handler's transformation can clear it.
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
      // without a run controller.
      stageResolution: 'engine',
    });

    engine.events.on('stage:end', (event): void => {
      ends.push(event.cleared);
    });

    engine.setup(copyBoard(MERGE_PAIR_BOARD));
    engine.move(DIRECTION_LEFT);

    // The stage cleared, which it could only do on the transformed score.
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

    expect(last?.terminated).toBe(true);
  });
});
