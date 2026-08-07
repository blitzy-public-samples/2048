// Contract suite for src/engine/terminal-state.ts: win and loss evaluation read
// from the rules in force rather than from a literal, AAP R4.
//
// Constructs pinned, with the vanilla line range of each:
//   js/game_manager.js L170      the win test the merge branch performed inline
//   js/game_manager.js L238-L240 movesAvailable()
//   js/game_manager.js L243-L268 tileMatchesAvailable()
//   js/game_manager.js L30-L32   isGameTerminated()
//
// The loss probe is the assertion set this suite exists for: L259 compared
// face values with `===`, which is one hardcoded merge rule, and the probe
// resolves a merge through `RulesConfig.merge.canMerge` instead. Both halves
// are pinned — that the default configuration reproduces L259's verdict for
// every board, and that a configured predicate admitting an unequal pair keeps
// the game alive on a full board L259 would have declared lost.
//
// This suite reads no DOM, no storage and no clock, consumes no randomness,
// installs no mock library and writes no snapshot.

import { describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import type {
  MergeTileView,
  RulesConfig,
} from '../../../src/config/rules-config';
import { Grid } from '../../../src/engine/grid';
import {
  hasReachedWinValue,
  highestTileValue,
  isGameTerminated,
  movesAvailable,
  tileMatchesAvailable,
} from '../../../src/engine/terminal-state';
import { Tile } from '../../../src/engine/tile';

/** Edge length every board below is built at. */
const BOARD_SIZE = 4;

/**
 * Builds a grid from a row-major table of values, `null` for an empty cell.
 *
 * @param rows One array per row, outermost row first, which is the reading
 *   order the fixture tables below are written in.
 * @returns The populated grid.
 */
function gridOf(rows: readonly (readonly (number | null)[])[]): Grid {
  const grid = new Grid(rows.length);

  rows.forEach((row, y) => {
    row.forEach((value, x) => {
      if (value !== null) {
        grid.insertTile(new Tile({ x, y }, value));
      }
    });
  });

  return grid;
}

/**
 * A full board carrying no two adjacent equal values: the board L243-L268
 * reported no match for.
 *
 * @returns The grid.
 */
function fullBoardWithNoEqualNeighbours(): Grid {
  return gridOf([
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [4, 2, 4, 2],
  ]);
}

/**
 * The rules in force, with `merge.canMerge` replaced.
 *
 * @param canMerge Predicate to install.
 * @returns The configuration.
 */
function configWithPredicate(
  canMerge: (moving: MergeTileView, target: MergeTileView) => boolean,
): RulesConfig {
  const config = createDefaultRulesConfig();

  config.merge.canMerge = canMerge;

  return config;
}

/* ===== 1. The loss probe reads the configured merge rule (AAP R4) ===== */

describe('tileMatchesAvailable resolves a merge through ' +
  'config.merge.canMerge (js/game_manager.js L243-L268)', () => {
  it('reports a match for an adjacent equal pair, as L259 did', () => {
    const config = createDefaultRulesConfig();

    expect(
      tileMatchesAvailable(
        gridOf([
          [2, 2, 4, 8],
          [4, 8, 16, 32],
          [8, 16, 32, 64],
          [16, 32, 64, 128],
        ]),
        config,
      ),
    ).toBe(true);
  });

  it('reports no match for a full board of unequal neighbours, as L267 did',
    () => {
      expect(
        tileMatchesAvailable(
          fullBoardWithNoEqualNeighbours(),
          createDefaultRulesConfig(),
        ),
      ).toBe(false);
    });

  it('reports a match a configured predicate admits and L259 refused', () => {
    // Sums to a power of two: the 2-and-4 pairs of the fixture merge, which
    // equality never admitted.
    const config = configWithPredicate(
      (moving, target) => moving.value + target.value === 6,
    );

    expect(
      tileMatchesAvailable(fullBoardWithNoEqualNeighbours(), config),
    ).toBe(true);
  });

  it('reports no match where a configured predicate refuses an equal pair',
    () => {
      const config = configWithPredicate(() => false);

      expect(
        tileMatchesAvailable(
          gridOf([
            [2, 2, null, null],
            [null, null, null, null],
            [null, null, null, null],
            [null, null, null, null],
          ]),
          config,
        ),
      ).toBe(false);
    });

  it('presents both operands unmerged, so a tile merged this turn still ' +
    'counts as a match (L259 read no merge state)', () => {
    const grid = gridOf([
      [4, 4, 2, 8],
      [2, 8, 16, 32],
      [8, 16, 32, 64],
      [16, 32, 64, 128],
    ]);
    const merged = grid.cellContent({ x: 0, y: 0 });

    // The state js/game_manager.js L163 left on a tile the merge branch
    // produced, which L253's probe ran against on the same turn.
    if (merged !== null) {
      merged.mergedFrom = [
        new Tile({ x: 0, y: 0 }, 2),
        new Tile({ x: 1, y: 0 }, 2),
      ];
    }

    expect(tileMatchesAvailable(grid, createDefaultRulesConfig())).toBe(true);
  });

  it('asks an asymmetric predicate about both orderings of every pair', () => {
    const seen: [number, number][] = [];
    const config = configWithPredicate((moving, target) => {
      seen.push([moving.value, target.value]);

      return false;
    });

    tileMatchesAvailable(
      gridOf([
        [2, 4, null, null],
        [null, null, null, null],
        [null, null, null, null],
        [null, null, null, null],
      ]),
      config,
    );

    expect(seen).toContainEqual([2, 4]);
    expect(seen).toContainEqual([4, 2]);
  });

  it('probes cells outside the lattice without raising (js/grid.js L80-L86)',
    () => {
      expect(() =>
        tileMatchesAvailable(
          gridOf([
            [2, null, null, null],
            [null, null, null, null],
            [null, null, null, null],
            [null, null, null, 2],
          ]),
          createDefaultRulesConfig(),
        ),
      ).not.toThrow();
    });
});

/* ===== 2. movesAvailable keeps L238-L240's short circuit ===== */

describe('movesAvailable (js/game_manager.js L238-L240)', () => {
  it('reports a move for a board with an empty cell without probing', () => {
    let probed = false;
    const config = configWithPredicate(() => {
      probed = true;

      return false;
    });

    expect(
      movesAvailable(
        gridOf([
          [2, 4, 2, 4],
          [4, 2, 4, 2],
          [2, 4, 2, 4],
          [4, 2, 4, null],
        ]),
        config,
      ),
    ).toBe(true);
    expect(probed).toBe(false);
  });

  it('reports no move for a full board no configured merge admits', () => {
    expect(
      movesAvailable(
        fullBoardWithNoEqualNeighbours(),
        createDefaultRulesConfig(),
      ),
    ).toBe(false);
  });

  it('reports a move for a full board a configured merge admits', () => {
    const config = configWithPredicate(
      (moving, target) => moving.value !== target.value,
    );

    expect(movesAvailable(fullBoardWithNoEqualNeighbours(), config)).toBe(true);
  });
});

/* ===== 3. The win value and the board reading are unchanged ===== */

describe('win evaluation reads RulesConfig.winValue (L170)', () => {
  it('reports the win where a tile reaches the configured value', () => {
    const config = createDefaultRulesConfig();

    config.winValue = 8;

    expect(
      hasReachedWinValue(
        gridOf([
          [8, null, null, null],
          [null, null, null, null],
          [null, null, null, null],
          [null, null, null, null],
        ]),
        config,
      ),
    ).toBe(true);
  });

  it('reports no win below the configured value', () => {
    expect(
      hasReachedWinValue(
        gridOf([
          [1024, null, null, null],
          [null, null, null, null],
          [null, null, null, null],
          [null, null, null, null],
        ]),
        createDefaultRulesConfig(),
      ),
    ).toBe(false);
  });

  it('reads the highest face value, and 0 for an empty board', () => {
    expect(highestTileValue(new Grid(BOARD_SIZE))).toBe(0);
    expect(highestTileValue(fullBoardWithNoEqualNeighbours())).toBe(4);
  });

  it('carries L30-L32 unchanged', () => {
    expect(
      isGameTerminated({ over: false, won: true, continuedPlay: false }),
    ).toBe(true);
    expect(
      isGameTerminated({ over: false, won: true, continuedPlay: true }),
    ).toBe(false);
    expect(
      isGameTerminated({ over: true, won: false, continuedPlay: true }),
    ).toBe(true);
  });
});
