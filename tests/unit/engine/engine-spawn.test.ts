// Spawn-integration suite of src/engine/engine.ts: the one place the engine
// consumes randomness, and the two substreams it consumes it from.
//
// This suite reads no DOM and no storage; the storage port and the
// stream-order recorder below are hand-written doubles. It runs in the
// `unit:dom-free` project of vitest.config.ts, whose environment is 'node'.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import { describe, expect, it, vi } from 'vitest';

import { createBlockedBoard } from '../../fixtures/boards';
import { DEFAULT_RULES_CONFIG } from '../../../src/config/default-config';
import { Engine } from '../../../src/engine/engine';
import type { EngineStoragePort } from '../../../src/engine/engine';
import { Grid } from '../../../src/engine/grid';
import type { SerializedGameState } from '../../../src/engine/types';
import { createRngStreams } from '../../../src/rng/rng-streams';
import type { RngStreams, StreamName } from '../../../src/rng/rng-streams';

/**
 * A port that reports no best score and holds the snapshot it is given.
 *
 * @param restored Snapshot `getGameState` returns. Defaults to none.
 * @returns The port.
 */
function createPort(restored: SerializedGameState | null = null): {
  readonly port: EngineStoragePort;
  readonly written: unknown[];
} {
  const written: unknown[] = [];

  return {
    written,

    port: {
      getBestScore: (): string | 0 => 0,
      setBestScore: (): unknown => undefined,
      getGameState: (): unknown => restored,
      setGameState: (state: unknown): unknown => {
        written.push(state);

        return undefined;
      },
      clearGameState: (): unknown => undefined,
    },
  };
}

/**
 * Wraps a set of substreams, recording the order they are addressed in.
 *
 * @param streams Substreams to wrap.
 * @param addressed List each `stream` call appends its name to.
 * @returns The wrapper.
 */
function recordOrder(streams: RngStreams, addressed: StreamName[]): RngStreams {
  return {
    seed: streams.seed,

    stream(name: StreamName) {
      addressed.push(name);

      return streams.stream(name);
    },

    snapshotCursors: () => streams.snapshotCursors(),
  };
}

/**
 * Builds an engine on the default rules.
 *
 * @param seed Run seed.
 * @param options Storage port and substreams to use.
 * @returns The engine.
 */
function createEngine(
  seed: string,
  options: {
    readonly port?: EngineStoragePort;
    readonly streams?: RngStreams;
  } = {},
): Engine {
  return new Engine({
    config: DEFAULT_RULES_CONFIG,
    streams: options.streams ?? createRngStreams(seed),
    storage: options.port ?? createPort().port,
  });
}

describe('the spawn draws its cell through Grid.randomAvailableCell', () => {
  it('calls the method once per starting tile', () => {
    const draw = vi.spyOn(Grid.prototype, 'randomAvailableCell');

    createEngine('seed-42').setup();

    expect(draw).toHaveBeenCalledTimes(DEFAULT_RULES_CONFIG.startTiles);
  });

  it('hands it the spawn-position substream and nothing else', () => {
    const streams = createRngStreams('seed-42');
    const draw = vi.spyOn(Grid.prototype, 'randomAvailableCell');

    createEngine('seed-42', { streams }).setup();

    for (const call of draw.mock.calls) {
      expect(call[0]).toBe(streams.stream('spawn-position'));
    }
  });

  it('calls it again for the tile a changed move spawns', () => {
    const engine = createEngine('seed-42');

    engine.setup();

    const draw = vi.spyOn(Grid.prototype, 'randomAvailableCell');

    expect(engine.move(0)).toBe(true);
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it('guards the spawn with cellsAvailable, as L70 did', () => {
    const engine = createEngine('seed-42');
    const guard = vi.spyOn(Grid.prototype, 'cellsAvailable');

    engine.setup();

    expect(guard).toHaveBeenCalledTimes(DEFAULT_RULES_CONFIG.startTiles);
  });
});

describe('the value is drawn before the cell', () => {
  it('addresses spawn-value then spawn-position, once each per tile', () => {
    const addressed: StreamName[] = [];
    const streams = recordOrder(createRngStreams('seed-42'), addressed);

    createEngine('seed-42', { streams }).setup();

    expect(addressed).toEqual([
      'spawn-value',
      'spawn-position',
      'spawn-value',
      'spawn-position',
    ]);
  });

  it('advances both cursors by one per spawned tile', () => {
    const streams = createRngStreams('seed-42');

    createEngine('seed-42', { streams }).setup();

    expect(streams.snapshotCursors()).toEqual({
      'spawn-value': DEFAULT_RULES_CONFIG.startTiles,
      'spawn-position': DEFAULT_RULES_CONFIG.startTiles,
      'relic-draw': 0,
      'rarity-weight': 0,
    });
  });

  it('consumes no draw for a move that changed nothing', () => {
    const streams = createRngStreams('seed-42');
    const engine = createEngine('seed-42', {
      port: createPort(createBlockedBoard()).port,
      streams,
    });

    engine.setup();

    const before = streams.snapshotCursors();

    // LEFT is the blocked fixture's blocked direction, so no position changes,
    // `moved` is false and js/game_manager.js L182-L183 spawns nothing.
    expect(engine.move(3)).toBe(false);
    expect(streams.snapshotCursors()).toEqual(before);
  });

  it('consumes no draw restoring a snapshot', () => {
    const streams = createRngStreams('seed-42');

    createEngine('seed-42', {
      port: createPort(createBlockedBoard()).port,
      streams,
    }).setup();

    expect(streams.snapshotCursors()).toEqual({
      'spawn-value': 0,
      'spawn-position': 0,
      'relic-draw': 0,
      'rarity-weight': 0,
    });
  });
});

describe('the same seed spawns the same board', () => {
  it('reproduces a twelve-move run exactly', () => {
    const directions = [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3] as const;

    /**
     * Plays the run and returns what it left.
     *
     * @param seed Run seed.
     * @returns The serialized board and the cursor map.
     */
    const play = (
      seed: string,
    ): { board: SerializedGameState; cursors: unknown } => {
      const streams = createRngStreams(seed);
      const engine = createEngine(seed, { streams });

      engine.setup();

      for (const direction of directions) {
        engine.move(direction);
      }

      return { board: engine.serialize(), cursors: streams.snapshotCursors() };
    };

    expect(play('seed-42')).toEqual(play('seed-42'));
    expect(play('run-seed-2048')).toEqual(play('run-seed-2048'));
    expect(play('seed-42')).not.toEqual(play('run-seed-2048'));
  });

  it('spawns the pinned first two tiles for a fixed seed', () => {
    const engine = createEngine('seed-42');

    engine.setup();

    expect(engine.serialize().grid).toEqual({
      size: 4,
      cells: [
        [null, null, null, null],
        [null, null, null, null],
        [null, null, null, { position: { x: 2, y: 3 }, value: 2 }],
        [null, { position: { x: 3, y: 1 }, value: 2 }, null, null],
      ],
    });
  });
});
