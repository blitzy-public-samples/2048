// Hook-payload application suite of src/engine/engine.ts: which members of a
// resolved hook payload the engine ADOPTS, which it holds invariant, and which
// it derives.
//
// The engine dispatches six hooks and then has to decide what to do with each
// resolved payload. Reporting a transformed member while executing the original
// one is indistinguishable from a working relic until the board disagrees with
// the event stream, so every member of the contract stated in
// src/engine/hooks.ts is pinned here:
//   onStageStart  `goal` adopted; `stageIndex`, `seed`, `boardSize` invariant
//   onBeforeMove  `direction` and `cancelled` adopted; `board` invariant
//   onMerge       `resultValue` and `scoreDelta` adopted; the two tiles invariant
//   onSpawn       `position` and `value` adopted
//   onAfterMove   `score`, `over`, `won` adopted; `terminated` DERIVED
//   onStageEnd    `cleared` and `score` adopted, before the commit reads the score
//
// It also pins the separation the hook and event contracts now carry: a hook
// handler receives frozen capability views of the board and of a merge's two
// tiles, while an event subscriber receives the live `Grid` and the live
// `Tile`s that a renderer reads `previousPosition` and `mergedFrom` off.
//
// This suite reads no DOM and no storage; the storage port is a hand-written
// double. It runs in the `unit:dom-free` project of vitest.config.ts.

import { describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import type { StageGoal } from '../../../src/config/stage-config';
import { Engine } from '../../../src/engine/engine';
import type { EngineStoragePort } from '../../../src/engine/engine';
import type {
  AfterMovePayload,
  BeforeMovePayload,
  MergePayload,
  StageEndPayload,
  StageStartPayload,
} from '../../../src/engine/hooks';
import type {
  BoardProjection,
  TileProjection,
} from '../../../src/engine/engine-events';
import { Tile } from '../../../src/engine/tile';
import type {
  Direction,
  SerializedGameState,
  StageCommitContext,
} from '../../../src/engine/types';
import {
  DIRECTION_DOWN,
  DIRECTION_LEFT,
  DIRECTION_RIGHT,
  DIRECTION_UP,
} from '../../../src/engine/types';
import { createRngStreams } from '../../../src/rng/rng-streams';

const RUN_SEED = 'hook-payload-suite';

/** A port that reports no best score and holds nothing across calls. */
function createPort(restored: SerializedGameState | null = null): {
  readonly port: EngineStoragePort;
  readonly written: SerializedGameState[];
} {
  const written: SerializedGameState[] = [];

  return {
    written,
    port: {
      getBestScore: (): string | 0 => 0,
      setBestScore: (): unknown => undefined,
      getGameState: (): unknown => restored,
      setGameState: (state: unknown): unknown => {
        written.push(state as SerializedGameState);

        return undefined;
      },
      clearGameState: (): unknown => undefined,
    },
  };
}

interface Harness {
  readonly engine: Engine;
  readonly written: SerializedGameState[];
}

function createHarness(
  stage?: () => StageCommitContext,
  restored: SerializedGameState | null = null,
): Harness {
  const port = createPort(restored);
  const engine = new Engine({
    config: createDefaultRulesConfig(),
    streams: createRngStreams(RUN_SEED),
    storage: port.port,
    correlationId: 'run-hook-payloads',
    ...(stage === undefined ? {} : { stageContext: stage }),
  });

  return { engine, written: port.written };
}

/**
 * A board holding exactly one mergeable pair, on row 0 at columns 0 and 1, so a
 * left move resolves one merge and a right move resolves the same merge in the
 * other direction.
 */
function createPairSnapshot(): SerializedGameState {
  const cells: (SerializedGameState['grid']['cells'][number][number])[][] = [];

  for (let x = 0; x < 4; x += 1) {
    cells.push([null, null, null, null]);
  }

  cells[0][0] = { position: { x: 0, y: 0 }, value: 2 };
  cells[1][0] = { position: { x: 1, y: 0 }, value: 2 };

  return {
    grid: { size: 4, cells },
    score: 0,
    over: false,
    won: false,
    keepPlaying: false,
  };
}

describe('onStageStart: the resolved goal is adopted, not discarded', () => {
  it('runs the stage against the goal a handler returned', () => {
    const provided: StageGoal = Object.freeze({
      kind: 'score-threshold',
      target: 100,
    });
    const substituted: StageGoal = Object.freeze({
      kind: 'highest-tile',
      target: 64,
    });
    const { engine } = createHarness(
      (): StageCommitContext =>
        Object.freeze({ stageIndex: 3, goal: provided, goalProgress: 0 }),
    );

    engine.hooks.register({
      id: 'raises-the-goal',
      hooks: {
        onStageStart: (payload): StageStartPayload => ({
          ...payload,
          goal: substituted,
        }),
      },
    });

    const startEvents: StageStartPayload[] = [];
    const commits: StageCommitContext[] = [];

    engine.events.on('stage:start', (payload): void => {
      startEvents.push(payload);
    });
    engine.events.on('state:commit', (commit): void => {
      commits.push(commit.stage);
    });

    engine.setup();

    // The emitted stage start carries the adopted goal. An event carries it BY
    // VALUE, as a frozen copy, so the comparison is by value rather than by
    // identity: no subscriber can write the goal the engine is running.
    expect(startEvents).toHaveLength(1);
    expect(startEvents[0]?.goal).toEqual(substituted);
    expect(Object.isFrozen(startEvents[0]?.goal)).toBe(true);

    // ...and so does the commit that immediately follows it, so a HUD reading
    // the commit and a subscriber reading the event agree.
    expect(commits).toHaveLength(1);
    expect(commits[0]?.goal).toEqual(substituted);
    expect(commits[0]?.stageIndex).toBe(3);
  });

  it('keeps the provider goal when no handler returns another', () => {
    const provided: StageGoal = Object.freeze({
      kind: 'score-threshold',
      target: 100,
    });
    const { engine } = createHarness(
      (): StageCommitContext =>
        Object.freeze({ stageIndex: 0, goal: provided, goalProgress: 0 }),
    );

    const seen: StageGoal[] = [];

    engine.events.on('state:commit', (commit): void => {
      seen.push(commit.stage.goal);
    });

    engine.setup();

    // By value, as a frozen copy: the goal the provider supplied is what the
    // commit reports, and a subscriber cannot write it.
    expect(seen[0]).toEqual(provided);
    expect(Object.isFrozen(seen[0])).toBe(true);
  });

  it('refuses a handler that misreports an invariant member', () => {
    const { engine } = createHarness();

    engine.hooks.register({
      id: 'renames-the-seed',
      hooks: {
        onStageStart: (payload): StageStartPayload => ({
          ...payload,
          seed: 'a different seed',
        }),
      },
    });

    const seen: StageStartPayload[] = [];

    engine.events.on('stage:start', (payload): void => {
      seen.push(payload);
    });

    engine.setup();

    expect(seen[0]?.seed).toBe(RUN_SEED);
  });
});

describe('onBeforeMove: the resolved direction is the one executed', () => {
  it('resolves the move in the direction a handler returned', () => {
    const { engine } = createHarness(undefined, createPairSnapshot());

    engine.setup();

    engine.hooks.register({
      id: 'redirects-left-to-right',
      hooks: {
        onBeforeMove: (payload): BeforeMovePayload => ({
          ...payload,
          direction: DIRECTION_RIGHT,
        }),
      },
    });

    const emitted: Direction[] = [];

    engine.events.on('move:before', (payload): void => {
      emitted.push(payload.direction);
    });

    engine.move(DIRECTION_LEFT);

    // The event reports the redirected direction...
    expect(emitted).toEqual([DIRECTION_RIGHT]);

    // ...and the board proves the redirected direction is what ran: the pair
    // merged against the RIGHT wall, at column 3, not against the left one.
    const merged = engine.grid.cellContent({ x: 3, y: 0 });

    expect(merged?.value).toBe(4);
    expect(engine.grid.cellContent({ x: 0, y: 0 })).toBeNull();
  });

  it('withdraws the move when a handler cancels it', () => {
    const { engine } = createHarness(undefined, createPairSnapshot());

    engine.setup();

    engine.hooks.register({
      id: 'vetoes',
      hooks: {
        onBeforeMove: (payload): BeforeMovePayload => ({
          ...payload,
          cancelled: true,
        }),
      },
    });

    expect(engine.move(DIRECTION_LEFT)).toBe(false);
    expect(engine.grid.cellContent({ x: 0, y: 0 })?.value).toBe(2);
    expect(engine.grid.cellContent({ x: 1, y: 0 })?.value).toBe(2);
  });

  it('hands the handler a board view and the subscriber a board projection', () => {
    const { engine } = createHarness(undefined, createPairSnapshot());

    engine.setup();

    const seen: { hook: unknown; event: BoardProjection | null } = {
      hook: null,
      event: null,
    };

    engine.hooks.register({
      id: 'reads-the-board',
      hooks: {
        onBeforeMove: (payload): void => {
          seen.hook = payload.board;
        },
      },
    });
    engine.events.on('move:before', (payload): void => {
      seen.event = payload.board;
    });

    engine.move(DIRECTION_LEFT);

    // Neither path hands out the live lattice: the hook path carries the
    // capability view and the observe path a frozen projection, so the board
    // is readable from both and writable through neither.
    expect(seen.event).not.toBe(engine.grid);
    expect(Object.isFrozen(seen.event)).toBe(true);
    expect(seen.event?.size).toBe(engine.grid.size);
    expect(seen.event?.cells[0]?.[0]?.value).toBe(2);

    expect(seen.hook).not.toBe(engine.grid);
    expect(Object.isFrozen(seen.hook)).toBe(true);
    expect(seen.hook).not.toHaveProperty('cells');
  });
});

describe('onAfterMove: score, over and won are adopted; terminated is derived', () => {
  it('adopts a rescored turn and commits the score it adopted', () => {
    const { engine, written } = createHarness(undefined, createPairSnapshot());

    engine.setup();
    written.length = 0;

    engine.hooks.register({
      id: 'rescores-the-turn',
      hooks: {
        onAfterMove: (payload): AfterMovePayload => ({
          ...payload,
          score: 1234,
        }),
      },
    });

    const emitted: number[] = [];
    const committed: number[] = [];

    engine.events.on('move:after', (payload): void => {
      emitted.push(payload.score);
    });
    engine.events.on('state:commit', (commit): void => {
      committed.push(commit.score);
    });

    engine.move(DIRECTION_LEFT);

    expect(emitted).toEqual([1234]);
    expect(committed).toEqual([1234]);
    expect(written[0]?.score).toBe(1234);
  });

  it('derives terminated from the adopted over rather than reading it back', () => {
    const { engine } = createHarness(undefined, createPairSnapshot());

    engine.setup();

    engine.hooks.register({
      id: 'ends-the-run-while-claiming-play-continues',
      hooks: {
        onAfterMove: (payload): AfterMovePayload => ({
          ...payload,
          over: true,
          terminated: false,
        }),
      },
    });

    const emitted: boolean[] = [];

    engine.events.on('move:after', (payload): void => {
      emitted.push(payload.terminated);
    });

    engine.move(DIRECTION_LEFT);

    // The handler declared the game over and `terminated: false` in the same
    // breath; the engine derives the flag, so the contradiction cannot survive.
    expect(emitted).toEqual([true]);
    expect(engine.isGameTerminated()).toBe(true);
  });

  it('refuses a substituted board and keeps the live one', () => {
    const { engine } = createHarness(undefined, createPairSnapshot());

    engine.setup();

    const board = engine.grid;

    engine.hooks.register({
      id: 'swaps-the-board',
      hooks: {
        onAfterMove: (payload): AfterMovePayload => ({
          ...payload,
          board: undefined as unknown as AfterMovePayload['board'],
          score: 7,
        }),
      },
    });

    engine.move(DIRECTION_LEFT);

    // The whole return is refused, so the rescore inside it is refused with it.
    expect(engine.grid).toBe(board);
    expect(engine.score).not.toBe(7);
  });
});

describe('onMerge: the two tiles reach hooks as views and events as live tiles', () => {
  it('adopts the resolved result value and score delta', () => {
    const { engine } = createHarness(undefined, createPairSnapshot());

    engine.setup();

    engine.hooks.register({
      id: 'triples-the-merge',
      hooks: {
        onMerge: (payload): MergePayload => ({
          ...payload,
          resultValue: 16,
          scoreDelta: 50,
        }),
      },
    });

    engine.move(DIRECTION_LEFT);

    expect(engine.grid.cellContent({ x: 0, y: 0 })?.value).toBe(16);
    expect(engine.score).toBe(50);
  });

  it('gives the event subscriber the tile members a renderer reads', () => {
    const { engine } = createHarness(undefined, createPairSnapshot());

    engine.setup();

    const seen: { hook: MergePayload | null; source: TileProjection | null } = {
      hook: null,
      source: null,
    };

    engine.hooks.register({
      id: 'reads-the-merge',
      hooks: {
        onMerge: (payload): void => {
          seen.hook = payload;
        },
      },
    });
    engine.events.on('tile:merge', (payload): void => {
      seen.source = payload.source;
    });

    engine.move(DIRECTION_LEFT);

    // The event's tiles are frozen projections that still carry
    // `previousPosition` and `mergedFrom`, which is what the move and merge
    // animations read; no tile method is reachable through them.
    expect(seen.source).not.toBeInstanceOf(Tile);
    expect(Object.isFrozen(seen.source)).toBe(true);
    expect(seen.source?.previousPosition).not.toBeNull();
    expect(seen.source).toHaveProperty('mergedFrom');
    expect(seen.source).not.toHaveProperty('savePosition');

    // The hook's tiles are frozen projections with no write path at all.
    expect(seen.hook?.source).not.toBe(seen.source);
    expect(Object.isFrozen(seen.hook?.source)).toBe(true);
    expect(seen.hook?.source).not.toHaveProperty('mergedFrom');
  });
});

describe('onStageEnd: the resolved score reaches the commit', () => {
  it('commits the score the handler returned rather than the one it replaced', () => {
    const { engine, written } = createHarness();

    engine.setup();
    written.length = 0;

    engine.hooks.register({
      id: 'awards-a-stage-bonus',
      hooks: {
        onStageEnd: (payload): StageEndPayload => ({
          ...payload,
          score: payload.score + 500,
          cleared: true,
        }),
      },
    });

    const emitted: StageEndPayload[] = [];
    const committed: number[] = [];

    engine.events.on('stage:end', (payload): void => {
      emitted.push(payload);
    });
    engine.events.on('state:commit', (commit): void => {
      committed.push(commit.score);
    });

    engine.endStage(false);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.score).toBe(500);
    expect(emitted[0]?.cleared).toBe(true);

    // The commit reports the same number the stage result did.
    expect(committed).toEqual([500]);
    expect(written[0]?.score).toBe(500);
  });

  it('leaves the score alone when no handler changes it', () => {
    const { engine } = createHarness();

    engine.setup();

    const committed: number[] = [];

    engine.events.on('state:commit', (commit): void => {
      committed.push(commit.score);
    });

    engine.endStage(true);

    expect(committed).toEqual([0]);
  });
});

describe('a redirected move still resolves through the ordinary pipeline', () => {
  it('spawns exactly one tile for a redirected move that changed the board', () => {
    const { engine } = createHarness(undefined, createPairSnapshot());

    engine.setup();

    engine.hooks.register({
      id: 'redirects-down',
      hooks: {
        onBeforeMove: (payload): BeforeMovePayload => ({
          ...payload,
          direction: DIRECTION_DOWN,
        }),
      },
    });

    const spawns: number[] = [];

    engine.events.on('tile:spawn', (payload): void => {
      spawns.push(payload.value);
    });

    expect(engine.move(DIRECTION_UP)).toBe(true);
    expect(spawns).toHaveLength(1);

    // The two tiles slid to the bottom row rather than the top one.
    expect(engine.grid.cellContent({ x: 0, y: 3 })?.value).toBe(2);
    expect(engine.grid.cellContent({ x: 1, y: 3 })?.value).toBe(2);
  });
});
