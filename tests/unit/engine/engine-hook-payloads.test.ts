// Hook-payload application suite of src/engine/engine.ts: which members of a
// resolved hook payload the engine ADOPTS, which it holds invariant, and which
// it derives.
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
  ReadonlyGridView,
  StageEndPayload,
  StageStartPayload,
} from '../../../src/engine/hooks';
import type { Grid } from '../../../src/engine/grid';
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
 * A board holding exactly one mergeable pair, on row 0 at columns 0 and 1, so
 * a left move resolves one merge and a right move resolves the same merge in
 * the other direction.
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

    // The emitted stage start carries the adopted goal.
    expect(startEvents).toHaveLength(1);
    expect(startEvents[0]?.goal).toEqual(substituted);
    expect(Object.isFrozen(startEvents[0]?.goal)).toBe(true);

    // and so does the commit that immediately follows it, so a HUD reading the
    // commit and a subscriber reading the event agree.
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

    // The event is emitted BEFORE the hook resolves, so it reports the
    // direction the caller asked for...
    expect(emitted).toEqual([DIRECTION_LEFT]);

    // while the board proves the REDIRECTED direction is what ran: the pair
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

  it('hands the handler a board view and the subscriber the live board', () => {
    const { engine } = createHarness(undefined, createPairSnapshot());

    engine.setup();

    const seen: {
      hook: unknown;
      event: Grid | null;
      valueAtEmission: number | undefined;
    } = {
      hook: null,
      event: null,
      valueAtEmission: undefined,
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
      seen.valueAtEmission = payload.board.cells[0]?.[0]?.value;
    });

    engine.move(DIRECTION_LEFT);

    // The two paths differ: AAP Contract 1 hands an event subscriber the LIVE
    // board, while the hook path substitutes the capability view so a handler
    // cannot write engine state through its payload.
    expect(seen.event).toBe(engine.grid);
    expect(seen.event?.size).toBe(engine.grid.size);

    // Read inside the emission, before the move resolved the pair.
    expect(seen.valueAtEmission).toBe(2);

    // CHANGED: this line repeated the assertion above it. It now proves the other
    // half of the comment: the hook path receives the CAPABILITY VIEW, which is
    // a different object from the live board the event path receives, reporting
    // the same size and carrying no `cells` to write engine state through.
    const hookBoard = seen.hook as ReadonlyGridView | null;

    expect(hookBoard).not.toBe(engine.grid);
    expect(hookBoard?.size).toBe(engine.grid.size);
    expect(hookBoard !== null && 'cells' in hookBoard).toBe(false);

    expect(seen.event?.cells[0]?.[0]?.value).toBe(4);
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
    // breath; the engine derives the flag, so the contradiction cannot
    // survive.
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

    // The whole return is refused, so the rescore inside it is refused with
    // it.
    expect(engine.grid).toBe(board);
    expect(engine.score).not.toBe(7);
  });
});

describe('onMerge: the event carries the live tiles and the hook a projection of them', () => {
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

    const seen: { hook: MergePayload | null; source: Tile | null } = {
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

    // The EVENT's tiles are the live `Tile`s, and they carry
    // `previousPosition` and `mergedFrom`, which is what the move and merge
    // animations read.
    expect(seen.source).toBeInstanceOf(Tile);
    expect(seen.source?.previousPosition).not.toBeNull();
    expect(seen.source).toHaveProperty('mergedFrom');

    // The HOOK is handed a projection of the same two tiles, read at the
    // moment the merge resolved: the source still standing in the cell it
    // merged out of, carrying the position it began the turn in.
    expect(seen.hook?.source).not.toBe(seen.source);
    expect(seen.hook?.source.value).toBe(seen.source?.value);
    expect(seen.hook?.source.x).toBe(1);
    expect(seen.hook?.source.y).toBe(0);
    expect(seen.hook?.source.previousPosition).toEqual({ x: 1, y: 0 });
    expect(seen.hook?.target.x).toBe(0);
    expect(seen.hook?.target.y).toBe(0);
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

    expect(engine.grid.cellContent({ x: 0, y: 3 })?.value).toBe(2);
    expect(engine.grid.cellContent({ x: 1, y: 3 })?.value).toBe(2);
  });
});
