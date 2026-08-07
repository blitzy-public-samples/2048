// Seeded board snapshots: seed + move list -> exact board state.
//
// THE GATE THIS IS HALF OF
//   AAP V2 requires that one seed and one move list yield an identical board
//   every time, and it requires that to be enforceable as a REGRESSION gate
//   rather than as a property a unit test happens to assert. The unit suite
//   already proves the engine is deterministic; what it cannot prove is that the
//   sequence has not CHANGED, because a unit test computes both sides of its own
//   comparison and therefore agrees with whatever the code now does. A stored
//   snapshot is the only artifact that disagrees.
//
//   So the failure this file is built to catch is a silent one: a change to the
//   PRNG, to the substream derivation, to the traversal order, to the spawn
//   distribution or to the merge rule that leaves every unit test green while
//   making every previously recorded run unreproducible. Any of those breaks a
//   snapshot here on the next run.
//
// WHY THE RECORDED VALUES ARE NOT DERIVED FROM ANYTHING
//   Nothing in this file computes an expected board. Each snapshot is whatever
//   the engine produced when it was recorded, checked in, and thereafter
//   compared byte for byte. That is the point: a recorded value cannot be
//   rationalised into agreement with a regression.
//
// RE-RECORDING IS DELIBERATE
//   `npm run test:snapshot` passes no update flag, so an existing snapshot is
//   never rewritten by it and a mismatch fails. Re-recording is the explicit
//   opt-in `vitest run --config vitest.snapshot.config.ts -u`, and doing so
//   after a rules change is a decision to declare every prior run
//   unreproducible.
//
// This project runs in `node` with no DOM and no Web Storage. The engine is
// DOM-free, so nothing here needs either: storage is a `MemoryStorage` behind
// the real manager.

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

/* ==========================================================================
 * Harness
 * ========================================================================== */

/**
 * The move list every board case plays, unless it names its own.
 *
 * Sixteen moves cycling all four directions four times. All four appear because
 * a move that changes nothing resolves to no turn at all, and which single
 * direction changes a given seeded board is a property of that seed; cycling
 * guarantees real turns for every seed below.
 */
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

/**
 * Plays one seeded run and returns what it produced.
 *
 * Deliberately minimal: no hooks, no relics, no run controller, no renderer, no
 * observability. Every one of those is a subscriber, and a subscriber that
 * changed the recorded board would be a defect this file should surface rather
 * than absorb.
 */
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

/* ==========================================================================
 * 1. A fresh board, several seeds
 * ========================================================================== */

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

    // Determinism within one process, asserted directly rather than through the
    // store: two independent compositions of one seed are the same run.
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

/* ==========================================================================
 * 2. The five board fixtures
 * ========================================================================== */

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
    // One move left merges the two 1024s into the configured win value, so this
    // records the win transition as well as the board.
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
    // Records the loss transition: the board runs out of moves during the cycle.
    expect(
      render(playSeeded({ seed: 'fixture-near-loss', board: NEAR_LOSS_BOARD })),
    ).toMatchSnapshot();
  });
});

/* ==========================================================================
 * 3. Configured rules
 * ========================================================================== */

describe('a fixed seed under configured rules', () => {
  it.each([2, 3, 5, 6, 8])(
    'reproduces its recorded board at board size %i',
    (boardSize) => {
      // R4: the board dimension is configuration, not a literal. A snapshot per
      // size records that the traversal, the spawn positions and the terminal
      // checks all follow the configured lattice rather than a captured 4.
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
            // The vanilla distribution inverted: mostly 4s. Recorded so a change
            // to `pickWeighted`'s walk — which selects the first index whose
            // running total exceeds the scaled draw — cannot pass unnoticed.
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

/* ==========================================================================
 * 4. The invariant the whole gate rests on
 * ========================================================================== */

describe('the randomness contract', () => {
  it('never replaces Math.random', () => {
    // The seeded-PRNG pitfall this guards: a generator installed globally makes
    // the whole runtime predictable, and a snapshot recorded under that
    // condition would be reproducible for the wrong reason. Every module under
    // src/ draws from an injected substream instead.
    playSeeded({ seed: 'math-random-guard' });

    expect(Math.random).toBe(PLATFORM_MATH_RANDOM);
  });

  it('takes no draw from the relic substreams while playing', () => {
    const played = playSeeded({ seed: 'substream-independence' });

    // Substream separation is what lets a relic be added without invalidating
    // every board snapshot in this file: a relic draws from `relic-draw` and
    // `rarity-weight`, and neither shares a sequence with the two spawn
    // substreams. If play consumed them, the addition of the relic system would
    // shift every recorded board here.
    expect(played.cursors).toContain('relic-draw      0');
    expect(played.cursors).toContain('rarity-weight   0');
  });
});
