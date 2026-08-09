// Seeded board snapshots: seed + move list -> exact board state.
//
// This project runs in `node` with no DOM and no Web Storage. The engine is
// DOM-free, so nothing here needs either: storage is a `MemoryStorage` behind
// the real manager.
//
// Decisions: DL-FIXTURE-03 (docs/DECISION_LOG.md).

import { describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../src/config/default-config';
import type { RulesConfig } from '../../src/config/rules-config';
import { Engine } from '../../src/engine/engine';
import {
  DIRECTION_DOWN,
  DIRECTION_LEFT,
  DIRECTION_RIGHT,
  DIRECTION_UP,
  type Direction,
  type SerializedGameState,
} from '../../src/engine/types';
import { createRngStreams } from '../../src/rng/rng-streams';
import { LocalStorageManager } from '../../src/storage/local-storage-manager';
import { MemoryStorage } from '../../src/storage/memory-storage';
import { GAME_STATE_KEY } from '../../src/storage/storage-keys';
import {
  BLOCKED_BOARD,
  MERGE_PAIR_BOARD,
  NEAR_LOSS_BOARD,
  NEAR_WIN_BOARD,
} from '../fixtures/boards';
import { formatBoard, formatCursors } from '../fixtures/snapshot-format';
import { PLATFORM_MATH_RANDOM } from '../fixtures/math-random-reference';

/** The move list every board case plays, unless it names its own. */
const MOVE_CYCLE: readonly Direction[] = [
  DIRECTION_UP,
  DIRECTION_RIGHT,
  DIRECTION_DOWN,
  DIRECTION_LEFT,
  DIRECTION_UP,
  DIRECTION_RIGHT,
  DIRECTION_DOWN,
  DIRECTION_LEFT,
  DIRECTION_UP,
  DIRECTION_RIGHT,
  DIRECTION_DOWN,
  DIRECTION_LEFT,
  DIRECTION_UP,
  DIRECTION_RIGHT,
  DIRECTION_DOWN,
  DIRECTION_LEFT,
];

interface PlayOptions {
  readonly seed: string;
  readonly moves?: readonly Direction[];

  /** Board to restore before setup. A fresh board is seeded when absent. */
  readonly board?: SerializedGameState;

  /** Applied to the configuration before the engine is constructed. */
  readonly configure?: (config: RulesConfig) => void;
}

interface Played {
  readonly board: SerializedGameState;
  readonly cursors: string;
  readonly moved: readonly boolean[];
}

/** Plays one seeded run and returns what it produced. */
function playSeeded(options: PlayOptions): Played {
  const backing = new MemoryStorage();

  if (options.board !== undefined) {
    backing.setItem(GAME_STATE_KEY, JSON.stringify(options.board));
  }

  const config = createDefaultRulesConfig();

  options.configure?.(config);

  const engine = new Engine({
    config,
    streams: createRngStreams(options.seed),
    storage: new LocalStorageManager({ storage: backing }),
  });

  engine.setup();

  const moved: boolean[] = [];

  for (const direction of options.moves ?? MOVE_CYCLE) {
    moved.push(engine.move(direction));
  }

  return {
    board: engine.serialize(),
    cursors: formatCursors(
      // Read back through the engine's own substreams, so the recorded cursor
      // is the one the recorded board was produced with.
      engine.streams.snapshotCursors(),
    ),
    moved,
  };
}

/** Renders a run for snapshotting: the board, then the cursors it reached. */
function render(played: Played): string {
  return [
    formatBoard(played.board),
    'rngCursor',
    played.cursors,
    `turns resolved  ${String(played.moved.filter(Boolean).length)} of ${String(played.moved.length)}`,
  ].join('\n');
}

describe('a fresh board played from a fixed seed', () => {
  it.each([
    'snapshot-seed-alpha',
    'snapshot-seed-bravo',
    'snapshot-seed-charlie',
    // A seed the player could plausibly type, including a space and a digit.
    'daily 2048',
    // A single character, and the shortest seed the substreams accept.
    'x',
  ])('reproduces its recorded board for seed "%s"', (seed) => {
    expect(render(playSeeded({ seed }))).toMatchSnapshot();
  });

  it('reproduces the same board on a second run of one seed', () => {
    const first = playSeeded({ seed: 'snapshot-seed-alpha' });
    const second = playSeeded({ seed: 'snapshot-seed-alpha' });

    expect(render(second)).toBe(render(first));
  });

  it('reproduces a different board for a seed one character apart', () => {
    const alpha = playSeeded({ seed: 'snapshot-seed-alpha' });
    const shifted = playSeeded({ seed: 'snapshot-seed-alphb' });

    // The substream seeds are derived per name from the run seed, so a
    // one-character change must not leave the sequence nearly unchanged.
    expect(render(shifted)).not.toBe(render(alpha));
  });
});

describe('a restored board played from a fixed seed', () => {
  it('reproduces its recorded board from the merge-pair fixture', () => {
    expect(
      render(playSeeded({ seed: 'fixture-merge-pair', board: MERGE_PAIR_BOARD })),
    ).toMatchSnapshot();
  });

  it('reproduces its recorded board from the blocked fixture', () => {
    expect(
      render(playSeeded({ seed: 'fixture-blocked', board: BLOCKED_BOARD })),
    ).toMatchSnapshot();
  });

  it('reproduces its recorded board from the near-win fixture', () => {
    // One move left merges the two 1024s into the configured win value, so
    // this records the win transition as well as the board.
    expect(
      render(
        playSeeded({
          seed: 'fixture-near-win',
          board: NEAR_WIN_BOARD,
          moves: [DIRECTION_LEFT, DIRECTION_UP, DIRECTION_RIGHT],
        }),
      ),
    ).toMatchSnapshot();
  });

  it('reproduces its recorded board from the near-loss fixture', () => {
    // Records the loss transition: the board runs out of moves during the
    // cycle.
    expect(
      render(playSeeded({ seed: 'fixture-near-loss', board: NEAR_LOSS_BOARD })),
    ).toMatchSnapshot();
  });
});

describe('a fixed seed under configured rules', () => {
  it.each([2, 3, 5, 6, 8])(
    'reproduces its recorded board at board size %i',
    (boardSize) => {
      // R4: the board dimension is configuration, not a literal.
      expect(
        render(
          playSeeded({
            seed: 'configured-board-size',
            configure: (config): void => {
              config.boardSize = boardSize;
            },
          }),
        ),
      ).toMatchSnapshot();
    },
  );

  it('reproduces its recorded board with four starting tiles', () => {
    expect(
      render(
        playSeeded({
          seed: 'configured-start-tiles',
          configure: (config): void => {
            config.startTiles = 4;
          },
        }),
      ),
    ).toMatchSnapshot();
  });

  it('reproduces its recorded board under a reversed spawn distribution', () => {
    expect(
      render(
        playSeeded({
          seed: 'configured-spawn-weights',
          configure: (config): void => {
            // The vanilla distribution inverted: mostly 4s.
            config.spawn = { values: [2, 4], weights: [0.1, 0.9] };
          },
        }),
      ),
    ).toMatchSnapshot();
  });

  it('reproduces its recorded board under a lowered win value', () => {
    expect(
      render(
        playSeeded({
          seed: 'configured-win-value',
          configure: (config): void => {
            config.winValue = 16;
          },
        }),
      ),
    ).toMatchSnapshot();
  });
});

describe('the randomness contract', () => {
  it('never replaces Math.random', () => {
    playSeeded({ seed: 'math-random-guard' });

    expect(Math.random).toBe(PLATFORM_MATH_RANDOM);
  });

  it('takes no draw from the relic substreams while playing', () => {
    const played = playSeeded({ seed: 'substream-independence' });

    // Substream separation is what lets a relic be added without invalidating
    // every board snapshot in this file: a relic draws from `relic-draw` and
    // `rarity-weight`, and neither shares a sequence with the two spawn
    // substreams.
    expect(played.cursors).toContain('relic-draw      0');
    expect(played.cursors).toContain('rarity-weight   0');
  });
});
