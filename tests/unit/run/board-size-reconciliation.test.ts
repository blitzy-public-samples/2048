// Board-size reconciliation: the policy arithmetic, the shrink and the grow
// rehydration, and the terminal-state reads over the reconciled lattice.
//
// AAP 0.4.1.3 names board-size rehydration as the corruption risk of the
// persistence boundary. Gate V6 requires tile positions and the win/lose check
// to survive a board-mutating cursed relic INCLUDING ACROSS A RELOAD, and
// Contract 5 places the reconciliation on the load path, ahead of any lattice
// construction. The prompt's edge case this discharges: a board-size-altering
// cursed relic must not corrupt existing tile positions or the win/lose check.
//
// THE DEFECT THIS SUITE MEASURES
//   js/game_manager.js L40-L41 rebuilt the lattice from the size the SNAPSHOT
//   recorded, `new Grid(previousState.grid.size, previousState.grid.cells)`,
//   and left L2's `this.size` — the constructor argument, which
//   js/application.js L3 supplied as the literal 4 — untouched. L248-L249 then
//   bounded the neighbour probe by that captured size rather than by
//   `this.grid.size`, while every method of js/grid.js read the live one:
//   L10/L13, L59-L60, L98-L99 and L105/L108. A board grown past the captured
//   size therefore had its outer row and column skipped by the probe, which is
//   a game over declared while a legal merge remained; a board shrunk below it
//   had cells outside the lattice probed, which js/grid.js L80-L86 answers with
//   `null` and no throw. src/engine/terminal-state.ts reads the edge length off
//   its argument at every call, and that is what the sections below measure.
//
// Superseded constructs this suite is the named verification target for, in
// docs/TRACEABILITY_MATRIX.md order:
//   GameManager.prototype.setup            js/game_manager.js L36-L45, the
//                                          saved-size rebuild at L40-L41
//   GameManager.prototype.movesAvailable   js/game_manager.js L238-L240
//   GameManager.prototype.tileMatchesAvailable
//                                          js/game_manager.js L243-L268, the
//                                          captured-size loop at L248-L249
//   GameManager.prototype.getVector        js/game_manager.js L194-L204
//   GameManager.prototype.positionsEqual   js/game_manager.js L270-L272
//   Grid.prototype.fromState               js/grid.js L21-L34, read as
//                                          state[x][y]
//   Grid.prototype.cellContent             js/grid.js L80-L86, the
//                                          out-of-bounds `null` valve
//   Grid.prototype.withinBounds            js/grid.js L97-L100
//   Grid.prototype.serialize               js/grid.js L102-L117, `null` in an
//                                          empty cell at L109
//   Tile.prototype.serialize               js/tile.js L19-L27
//   LocalStorageManager, the probe run once at construction and the single
//   snapshot read                          js/local_storage_manager.js
//                                          L25-L26, L52-L55
//
// Figure this suite is the mechanical proof of: Figure 4 (Turn Data Flow) of
// docs/architecture/data-flow.md, whose win check reads `config.winValue` and
// whose loss check is the `Moves available?` decision. Both reads are asserted
// here over the reconciled edge length, which is the size Figure 4's COMMIT
// stage persists.
//
// Collected by the unit:dom-free project of vitest.config.ts, environment
// 'node'. Nothing here reads a document, a Web Storage global or a clock;
// `Math.random` is read for reference identity and never called, wrapped,
// stubbed or written. No mocking api, no replaced global, no snapshot
// artifact, and every store and sink is injected.
//
// Coverage boundaries this suite stays inside. The loader's five verdicts are
// tests/unit/run/run-state-store.test.ts, which is also where the surfacing of
// the reconciled discriminant is asserted; section 15 reads that discriminant
// only as the entry to the board-integrity assertions it owns. Further out:
// the registry and controller wiring that supplies a relic-implied size is
// tests/unit/run/run-relic-board-size.test.ts; cursor resume is
// tests/unit/run/rng-cursor-persistence.test.ts; relic behaviour, charges and
// hook dispatch are tests/unit/relics/; the frozen best-score accessor is
// tests/unit/storage/best-score.test.ts. This file owns the reconciliation
// policy arithmetic, the rehydrated lattice, and the terminal-state reads over
// it. Classic dimensionality is frozen: a reconciled edge length is a per-run
// value, and nothing here assumes a third axis.
//
// Decisions behind this file: docs/DECISION_LOG.md.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_BOARD_SIZE,
  MAX_BOARD_SIZE,
  createDefaultRulesConfig,
} from '../../../src/config/default-config';
import type { RulesConfig } from '../../../src/config/rules-config';
import { Grid } from '../../../src/engine/grid';
import {
  hasReachedWinValue,
  highestTileValue,
  movesAvailable,
  tileMatchesAvailable,
} from '../../../src/engine/terminal-state';
import { Tile } from '../../../src/engine/tile';
import type {
  CellMatrix,
  Position,
  SerializedGameState,
  SerializedGrid,
  SerializedTile,
  Vector,
} from '../../../src/engine/types';
import type { PersistedRelic } from '../../../src/relics/relic-types';
import {
  MAX_SUPPORTED_BOARD_SIZE,
  createFreshRunState,
  isRunStateShape,
} from '../../../src/run/run-state';
import type {
  BoardSizeReconciliationReport,
  RunReporter,
  RunState,
} from '../../../src/run/run-state';
import {
  RunStateStore,
  reconcileBoardSize,
} from '../../../src/run/run-state-store';
import type {
  BoardSizeReconciliation,
  BoardSizeReconciliationAction,
  BoardSizeReconciliationDetail,
  BoardSizeReconciliationInput,
  BoardSizeReconciliationResult,
  PersistedStageGoal,
  RunStateLoadOutcome,
} from '../../../src/run/run-state-store';
import {
  LocalStorageManager,
} from '../../../src/storage/local-storage-manager';
import { MemoryStorage } from '../../../src/storage/memory-storage';
import {
  BEST_SCORE_KEY,
  OWNED_STORAGE_KEYS,
  RUN_STATE_KEY,
} from '../../../src/storage/storage-keys';
import {
  copyBoard,
  createBlockedBoard,
  createEmptyBoard,
  createMergePairBoard,
  createNearLossBoard,
  createNearWinBoard,
} from '../../fixtures/boards';

/* ==========================================================================
 * 1. Sizes, actions and the reference captured at load
 * ========================================================================== */

/** The edge length every saved fixture below is written at. */
const SAVED_SIZE = DEFAULT_BOARD_SIZE;

/** The edge length the grow cases reconcile up to. */
const GROWN_SIZE = SAVED_SIZE + 1;

/** The edge length the shrink cases reconcile down to. */
const SHRUNK_SIZE = SAVED_SIZE - 1;

/** The smallest edge length `isSupportedBoardSize()` accepts. */
const SMALLEST_SIZE = 1;

const NO_CHANGE: BoardSizeReconciliationAction = 'none';

const GREW: BoardSizeReconciliationAction = 'grew';

const SHRANK: BoardSizeReconciliationAction = 'shrank';

const REPAIRED: BoardSizeReconciliationAction = 'repaired';

/** Every action `BoardSizeReconciliationAction` declares. */
const BOARD_SIZE_ACTIONS: readonly BoardSizeReconciliationAction[] =
  Object.freeze([NO_CHANGE, GREW, SHRANK, REPAIRED]);

/**
 * `Math.random` as this module found it. Read for reference identity by the
 * purity section and never called.
 */
const MATH_RANDOM_AT_LOAD = Math.random;

/** Face value the mid-board tiles of the win and highest cases carry. */
const MID_VALUE = 64;

/** Face value the dropped-tile cases of the highest section carry. */
const HIGH_VALUE = 1024;

/* ==========================================================================
 * 2. Local board vocabulary
 * ========================================================================== */

/**
 * The five distinct values the bespoke lattices cycle through, as the crowded
 * fixture of tests/fixtures/boards.ts cycles through.
 */
const CYCLE: readonly number[] = Object.freeze([2, 4, 8, 16, 32]);

/** Row offset of the cycle index. */
const CYCLE_ROW_STEP = 2;

/**
 * The cycle entry a cell carries. A horizontal neighbour differs by one index
 * and a vertical neighbour by two, over five distinct values, so a lattice
 * filled by this function carries no adjacent equal pair at any edge length.
 */
function cycleValueAt(x: number, y: number): number {
  return CYCLE[(x + CYCLE_ROW_STEP * y) % CYCLE.length];
}

/** Reads the face value of a cell, or `null` for an empty one. */
type CellValue = (x: number, y: number) => number | null;

/**
 * Builds a serialised matrix, `cells[x][y]`, x-outer and y-inner, with `null`
 * in every empty cell and every tile's `position` set to the cell it occupies.
 * This is the form js/grid.js L102-L117 wrote and js/grid.js L21-L34 read back.
 */
function buildMatrix(
  size: number,
  cellValue: CellValue,
): CellMatrix<SerializedTile> {
  const cells: CellMatrix<SerializedTile> = [];

  for (let x = 0; x < size; x += 1) {
    const column: (SerializedTile | null)[] = [];

    cells[x] = column;

    for (let y = 0; y < size; y += 1) {
      const value = cellValue(x, y);

      column.push(value === null ? null : { position: { x, y }, value });
    }
  }

  return cells;
}

/** A serialised grid at `size`, filled by `cellValue`. */
function buildGrid(size: number, cellValue: CellValue): SerializedGrid {
  return { size, cells: buildMatrix(size, cellValue) };
}

/** One tile as the cell it occupies and the face value it carries. */
interface PlacedTile {
  readonly x: number;
  readonly y: number;
  readonly value: number;
}

/**
 * Every tile a serialised matrix holds, x-outer and y-inner, which is the
 * order js/grid.js L58-L64 walked.
 */
function tilesOf(grid: SerializedGrid): PlacedTile[] {
  const placed: PlacedTile[] = [];

  for (let x = 0; x < grid.cells.length; x += 1) {
    const column = grid.cells[x];

    for (let y = 0; y < column.length; y += 1) {
      const cell = column[y];

      if (cell !== null && cell !== undefined) {
        placed.push({ x, y, value: cell.value });
      }
    }
  }

  return placed;
}

/** The tiles of a matrix lying inside a square lattice of edge `size`. */
function tilesWithin(grid: SerializedGrid, size: number): PlacedTile[] {
  return tilesOf(grid).filter((tile) => tile.x < size && tile.y < size);
}

/** The tiles of a matrix lying outside a square lattice of edge `size`. */
function tilesOutside(grid: SerializedGrid, size: number): PlacedTile[] {
  return tilesOf(grid).filter((tile) => tile.x >= size || tile.y >= size);
}

/**
 * Asserts the lattice guarantees `reconcileBoardSize()` states for every
 * input: the recorded edge length, a dense square matrix, a cell that is
 * `null` or a tile, and a tile whose `position` is the cell it occupies.
 *
 * js/grid.js L109 wrote `null` into an empty cell and left no hole, so a hole
 * is asserted against rather than tolerated.
 */
function expectWellFormedGrid(grid: SerializedGrid, size: number): void {
  expect(grid.size).toBe(size);
  expect(grid.cells).toHaveLength(size);

  for (let x = 0; x < size; x += 1) {
    const column = grid.cells[x];

    expect(column).toHaveLength(size);
    expect(Object.keys(column)).toHaveLength(size);

    for (let y = 0; y < size; y += 1) {
      const cell: SerializedTile | null | undefined = column[y];

      expect(cell === undefined).toBe(false);

      if (cell !== null && cell !== undefined) {
        expect(cell.position).toEqual({ x, y });
      }
    }
  }
}

/**
 * Asserts the bounds every record carries: an applied edge length that is a
 * positive integer at or below the persistence ceiling, a non-negative
 * integral dropped count, and an action drawn from the declared four.
 */
function expectBoundedRecord(reconciliation: BoardSizeReconciliation): void {
  expect(Number.isSafeInteger(reconciliation.appliedSize)).toBe(true);
  expect(reconciliation.appliedSize).toBeGreaterThanOrEqual(SMALLEST_SIZE);
  expect(reconciliation.appliedSize).toBeLessThanOrEqual(
    MAX_SUPPORTED_BOARD_SIZE,
  );
  expect(Number.isSafeInteger(reconciliation.tilesDropped)).toBe(true);
  expect(reconciliation.tilesDropped).toBeGreaterThanOrEqual(0);
  expect(BOARD_SIZE_ACTIONS).toContain(reconciliation.action);
}

/** Reconciles a saved grid against a configured edge length. */
function reconcileTo(
  savedGrid: SerializedGrid,
  configuredSize: number,
): BoardSizeReconciliationResult {
  return reconcileBoardSize({ savedGrid, configuredSize });
}

/** Rehydrates a lattice at the edge length the reconciliation applied. */
function rehydrate(result: BoardSizeReconciliationResult): Grid {
  return new Grid(result.grid.size, result.grid.cells);
}

/* ==========================================================================
 * 3. The captured-size neighbour probe, as js/game_manager.js ran it
 * ========================================================================== */

/**
 * The four direction vectors of js/game_manager.js L194-L204: 0 up, 1 right,
 * 2 down and 3 left, with y increasing downward. Declared here rather than
 * imported, src/engine/move-resolver.ts being outside this suite's
 * dependencies.
 */
const PROBE_VECTORS: readonly Vector[] = Object.freeze([
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
]);

/**
 * Whether any of the four neighbours of `cell` merges with `value` under the
 * configured predicate. Both operands reach the predicate with no merge
 * history, which is how src/engine/terminal-state.ts presents them and the
 * state js/game_manager.js L113-L120 had already produced.
 */
function probesMatch(
  grid: Grid,
  config: RulesConfig,
  cell: Position,
  value: number,
): boolean {
  for (const vector of PROBE_VECTORS) {
    const other = grid.cellContent({
      x: cell.x + vector.x,
      y: cell.y + vector.y,
    });

    if (
      other !== null &&
      config.merge.canMerge(
        { value, mergedFrom: null },
        { value: other.value, mergedFrom: null },
      )
    ) {
      return true;
    }
  }

  return false;
}

/**
 * js/game_manager.js L243-L268's neighbour probe with its loop bound supplied
 * as an argument. That is the one difference from the source: L248-L249 read
 * the captured `this.size`, where src/engine/terminal-state.ts reads
 * `grid.size`. A bound above the lattice addresses cells outside it, which
 * js/grid.js L80-L86 answers with `null`.
 */
function matchesWithinBound(
  grid: Grid,
  config: RulesConfig,
  bound: number,
): boolean {
  for (let x = 0; x < bound; x += 1) {
    for (let y = 0; y < bound; y += 1) {
      const tile = grid.cellContent({ x, y });

      if (tile !== null && probesMatch(grid, config, { x, y }, tile.value)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Every adjacent equal pair on the board, each counted once, as
 * `"(x,y)-(x,y)"`. Walks the two forward vectors of `PROBE_VECTORS`, so a pair
 * is not reported twice.
 */
function adjacentEqualPairs(grid: Grid): string[] {
  const forward = PROBE_VECTORS.filter(
    (vector) => vector.x > 0 || vector.y > 0,
  );
  const pairs: string[] = [];

  grid.eachCell((x, y, tile) => {
    for (const vector of forward) {
      const other = grid.cellContent({ x: x + vector.x, y: y + vector.y });

      if (tile !== null && other !== null && tile.value === other.value) {
        pairs.push(`(${x},${y})-(${x + vector.x},${y + vector.y})`);
      }
    }
  });

  return pairs;
}

/* ==========================================================================
 * 4. The capturing report sink
 * ========================================================================== */

/**
 * A sink that appends every reconciliation report to a list. A plain object
 * collecting values: nothing here spies on a console, replaces a member or
 * discards a report.
 */
interface CapturingReporter {
  readonly reporter: RunReporter;
  readonly reconciliations: BoardSizeReconciliationReport[];
}

function createCapturingReporter(): CapturingReporter {
  const reconciliations: BoardSizeReconciliationReport[] = [];

  const reporter: RunReporter = {
    onBoardSizeReconciled: (report) => {
      reconciliations.push(report);
    },
  };

  return { reporter, reconciliations };
}

/**
 * Narrows a captured report to the detail src/run/run-state-store.ts hands the
 * sink, which carries the action, the dropped count and the reportable flag
 * beyond the four sizes `BoardSizeReconciliationReport` declares.
 *
 * @param report Report the sink captured.
 * @returns The detail, or `null` when the report carries none of the three.
 */
function detailOf(
  report: BoardSizeReconciliationReport,
): BoardSizeReconciliationDetail | null {
  const carried = report as unknown as Record<string, unknown>;

  if (
    typeof carried['action'] !== 'string' ||
    typeof carried['tilesDropped'] !== 'number' ||
    typeof carried['reportable'] !== 'boolean'
  ) {
    return null;
  }

  return report as BoardSizeReconciliationDetail;
}

/* ==========================================================================
 * 5. The injected world, seeded before the subject is constructed
 * ========================================================================== */

const FIXTURE_RUN_ID = 'run-board-size-0001';

const FIXTURE_SEED = 'seed-board-size';

const FIXTURE_STAGE_INDEX = 0;

const FIXTURE_STAGE_GOAL: PersistedStageGoal = {
  kind: 'highest-tile',
  target: 16,
};

const CORRELATION_ID = 'run-correlation-board-size';

/** Value the teardown case writes under the frozen best-score key. */
const BEST_SCORE_SENTINEL = '4096';

/** Every store a case built, emptied by the teardown below. */
const trackedStorages: MemoryStorage[] = [];

/** An envelope at the current schema version wrapping `board`. */
function buildEnvelope(board: SerializedGameState): RunState {
  return createFreshRunState({
    runId: FIXTURE_RUN_ID,
    seed: FIXTURE_SEED,
    rngCursor: {},
    stageIndex: FIXTURE_STAGE_INDEX,
    stageGoal: FIXTURE_STAGE_GOAL,
    board,
  });
}

interface WorldOptions {
  readonly board: SerializedGameState;
  readonly config: RulesConfig;

  /**
   * Entries the envelope carries. A board-mutating relic reaches the
   * reconciliation as an input alone: one entry declaring `boardSize` on its
   * own state slot. No behaviour, charge budget or hook table is involved.
   */
  readonly relics?: readonly PersistedRelic[];
}

/** One case's injected world: the backing store, the sink and the subject. */
interface World {
  readonly storage: MemoryStorage;
  readonly reconciliations: BoardSizeReconciliationReport[];
  readonly store: RunStateStore;
}

/**
 * Builds a world in the mandatory order: allocate the store, WRITE THE
 * ENVELOPE, then construct `LocalStorageManager` and `RunStateStore`.
 *
 * js/local_storage_manager.js L25-L26 ran the writability probe once in the
 * constructor, and js/game_manager.js L13 reached L36's single snapshot read
 * from the constructor as well, so an envelope written after construction
 * would not be seen.
 */
function createWorld(options: WorldOptions): World {
  const storage = new MemoryStorage();

  trackedStorages.push(storage);

  const envelope: RunState = {
    ...buildEnvelope(options.board),
    relics: options.relics ?? [],
  };

  storage.setItem(RUN_STATE_KEY, JSON.stringify(envelope));

  const sink = createCapturingReporter();

  const store = new RunStateStore({
    storage: new LocalStorageManager({ storage }),
    reporter: sink.reporter,
    config: options.config,
    correlationId: CORRELATION_ID,
  });

  return { storage, reconciliations: sink.reconciliations, store };
}

/**
 * Removes every key the product owns, then the best-score key by name, using
 * the exported constants and no string literal.
 *
 * js/local_storage_manager.js L61-L63 removed the board snapshot and never
 * L22's best score. Idempotent: `MemoryStorage.removeItem` of an absent key is
 * a no-op, and the setup file vitest.config.ts names registers an `afterEach`
 * of its own over the Web Storage global.
 */
function clearOwnedKeysOf(storage: MemoryStorage): void {
  for (const key of OWNED_STORAGE_KEYS) {
    storage.removeItem(key);
  }

  storage.removeItem(BEST_SCORE_KEY);
}

/**
 * The rules every case reads, rebuilt from the factory before each one. The
 * factory returns a fresh unfrozen config per call, and
 * `DEFAULT_RULES_CONFIG` is neither read nor written here.
 */
let config: RulesConfig;

beforeEach(() => {
  config = createDefaultRulesConfig();
});

afterEach(() => {
  for (const storage of trackedStorages) {
    clearOwnedKeysOf(storage);
  }

  trackedStorages.length = 0;
});

/* ==========================================================================
 * 6. The three inputs and the precedence between them
 * ========================================================================== */

describe('reconcileBoardSize weighs the saved and configured sizes', () => {
  it('changes nothing when the saved size already matches', () => {
    const { reconciliation } = reconcileTo(
      buildGrid(SAVED_SIZE, cycleValueAt),
      SAVED_SIZE,
    );

    expect(reconciliation.savedSize).toBe(SAVED_SIZE);
    expect(reconciliation.configuredSize).toBe(SAVED_SIZE);
    expect(reconciliation.relicSize).toBe(0);
    expect(reconciliation.appliedSize).toBe(SAVED_SIZE);
    expect(reconciliation.action).toBe(NO_CHANGE);
    expect(reconciliation.tilesDropped).toBe(0);
    expect(reconciliation.reportable).toBe(false);
  });

  it('echoes both inputs rather than collapsing them into one member', () => {
    const { reconciliation } = reconcileTo(
      buildGrid(SAVED_SIZE, cycleValueAt),
      GROWN_SIZE,
    );

    expect(reconciliation.savedSize).toBe(SAVED_SIZE);
    expect(reconciliation.configuredSize).toBe(GROWN_SIZE);
    expect(reconciliation.appliedSize).toBe(GROWN_SIZE);
  });

  it('takes the configured size over the saved one, growing to it', () => {
    const { reconciliation } = reconcileTo(
      buildGrid(SAVED_SIZE, cycleValueAt),
      GROWN_SIZE,
    );

    expect(reconciliation.appliedSize).toBe(GROWN_SIZE);
    expect(reconciliation.action).toBe(GREW);
    expect(reconciliation.reportable).toBe(true);
  });

  it('takes the configured size over the saved one, shrinking to it', () => {
    const { reconciliation } = reconcileTo(
      buildGrid(SAVED_SIZE, cycleValueAt),
      SHRUNK_SIZE,
    );

    expect(reconciliation.appliedSize).toBe(SHRUNK_SIZE);
    expect(reconciliation.action).toBe(SHRANK);
    expect(reconciliation.reportable).toBe(true);
  });

  it('applies one of the sizes it was given and never a third value', () => {
    for (const configuredSize of [SMALLEST_SIZE, 2, 3, 4, 5, 8]) {
      const { reconciliation } = reconcileTo(
        buildGrid(SAVED_SIZE, cycleValueAt),
        configuredSize,
      );

      expect([
        reconciliation.savedSize,
        reconciliation.configuredSize,
      ]).toContain(reconciliation.appliedSize);
    }
  });

  it('falls back to the saved size when no other size is supplied', () => {
    const { reconciliation } = reconcileBoardSize({
      savedGrid: buildGrid(SAVED_SIZE, cycleValueAt),
    });

    expect(reconciliation.configuredSize).toBe(0);
    expect(reconciliation.relicSize).toBe(0);
    expect(reconciliation.appliedSize).toBe(SAVED_SIZE);
    expect(reconciliation.action).toBe(NO_CHANGE);
    expect(reconciliation.reportable).toBe(false);
  });
});

describe('a board-mutating relic outweighs the configured size', () => {
  it('applies the size the relic implies, shrinking to it', () => {
    const { reconciliation } = reconcileBoardSize({
      savedGrid: buildGrid(SAVED_SIZE, cycleValueAt),
      configuredSize: SAVED_SIZE,
      relicBoardSize: SHRUNK_SIZE,
    });

    expect(reconciliation.relicSize).toBe(SHRUNK_SIZE);
    expect(reconciliation.appliedSize).toBe(SHRUNK_SIZE);
    expect(reconciliation.action).toBe(SHRANK);
  });

  it('still records the saved and configured sizes it set aside', () => {
    const { reconciliation } = reconcileBoardSize({
      savedGrid: buildGrid(SAVED_SIZE, cycleValueAt),
      configuredSize: SAVED_SIZE,
      relicBoardSize: SHRUNK_SIZE,
    });

    expect(reconciliation.savedSize).toBe(SAVED_SIZE);
    expect(reconciliation.configuredSize).toBe(SAVED_SIZE);
    expect(reconciliation.reportable).toBe(true);
  });

  it('resolves one deterministic size when all three disagree', () => {
    const input: BoardSizeReconciliationInput = {
      savedGrid: buildGrid(SAVED_SIZE, cycleValueAt),
      configuredSize: GROWN_SIZE,
      relicBoardSize: 2,
    };
    const first = reconcileBoardSize(input);
    const second = reconcileBoardSize(input);

    expect(first.reconciliation.savedSize).toBe(SAVED_SIZE);
    expect(first.reconciliation.configuredSize).toBe(GROWN_SIZE);
    expect(first.reconciliation.relicSize).toBe(2);
    expect(first.reconciliation.appliedSize).toBe(2);
    expect(first.reconciliation.action).toBe(SHRANK);
    expect(second.reconciliation).toEqual(first.reconciliation);
  });

  it('applies a relic size the configuration would not have reached', () => {
    const { grid, reconciliation } = reconcileBoardSize({
      savedGrid: buildGrid(SAVED_SIZE, cycleValueAt),
      configuredSize: SAVED_SIZE,
      relicBoardSize: GROWN_SIZE,
    });

    expect(reconciliation.appliedSize).toBe(GROWN_SIZE);
    expect(reconciliation.action).toBe(GREW);
    expectWellFormedGrid(grid, GROWN_SIZE);
  });
});

/* ==========================================================================
 * 7. Purity over the arguments, and totality over degenerate ones
 * ========================================================================== */

describe('reconcileBoardSize is pure over the values it is handed', () => {
  it('mutates neither the saved grid nor the sizes', () => {
    const savedGrid = buildGrid(SAVED_SIZE, cycleValueAt);
    const input: BoardSizeReconciliationInput = {
      savedGrid,
      configuredSize: GROWN_SIZE,
      relicBoardSize: SHRUNK_SIZE,
    };
    const before = JSON.stringify(input);

    reconcileBoardSize(input);
    reconcileBoardSize(input);

    expect(JSON.stringify(input)).toBe(before);
    expect(savedGrid.size).toBe(SAVED_SIZE);
    expect(savedGrid.cells).toHaveLength(SAVED_SIZE);
    expect(tilesOf(savedGrid)).toHaveLength(SAVED_SIZE * SAVED_SIZE);
  });

  it('returns a lattice sharing no array with the saved grid', () => {
    const savedGrid = buildGrid(SAVED_SIZE, cycleValueAt);
    const first = reconcileTo(savedGrid, SAVED_SIZE);
    const second = reconcileTo(savedGrid, SAVED_SIZE);

    expect(first.grid).not.toBe(savedGrid);
    expect(first.grid.cells).not.toBe(savedGrid.cells);
    expect(first.grid.cells[0]).not.toBe(savedGrid.cells[0]);
    expect(first.grid.cells).not.toBe(second.grid.cells);
  });

  it('returns an equal record on every repeated call', () => {
    const input: BoardSizeReconciliationInput = {
      savedGrid: buildGrid(SAVED_SIZE, cycleValueAt),
      configuredSize: SHRUNK_SIZE,
    };
    const records: BoardSizeReconciliation[] = [];

    for (let repeat = 0; repeat < 8; repeat += 1) {
      records.push(reconcileBoardSize(input).reconciliation);
    }

    for (const record of records) {
      expect(record).toEqual(records[0]);
    }
  });

  it('leaves Math.random the reference this module found', () => {
    reconcileTo(buildGrid(SAVED_SIZE, cycleValueAt), SHRUNK_SIZE);

    expect(Math.random).toBe(MATH_RANDOM_AT_LOAD);
  });
});

/** One degenerate input and the resolution it is expected to reach. */
interface DegenerateCase {
  readonly name: string;
  readonly input: BoardSizeReconciliationInput;
  readonly appliedSize: number;
  readonly action: BoardSizeReconciliationAction;
}

/**
 * Every degenerate input the reconciliation absorbs. A saved grid is typed
 * `unknown` by `BoardSizeReconciliationInput`, so a hostile value needs no
 * cast; the two numeric members are cast through `unknown` where the value
 * under test is not a number at all.
 */
const DEGENERATE_CASES: readonly DegenerateCase[] = [
  {
    name: 'an absent saved grid',
    input: { savedGrid: undefined },
    appliedSize: SMALLEST_SIZE,
    action: GREW,
  },
  {
    name: 'a saved grid that is not an object',
    input: { savedGrid: 42 },
    appliedSize: SMALLEST_SIZE,
    action: GREW,
  },
  {
    name: 'a saved grid carrying no cells member',
    input: { savedGrid: { size: SAVED_SIZE } },
    appliedSize: SAVED_SIZE,
    action: NO_CHANGE,
  },
  {
    name: 'a saved size of zero over an empty matrix',
    input: { savedGrid: { size: 0, cells: [] } },
    appliedSize: SMALLEST_SIZE,
    action: GREW,
  },
  {
    name: 'a negative saved size over a usable matrix',
    input: {
      savedGrid: { size: -1, cells: buildMatrix(SAVED_SIZE, cycleValueAt) },
    },
    appliedSize: SAVED_SIZE,
    action: NO_CHANGE,
  },
  {
    name: 'a fractional saved size',
    input: {
      savedGrid: { size: 1.5, cells: buildMatrix(SAVED_SIZE, cycleValueAt) },
    },
    appliedSize: SAVED_SIZE,
    action: NO_CHANGE,
  },
  {
    name: 'a saved size above the supported ceiling',
    input: {
      savedGrid: {
        size: MAX_BOARD_SIZE + 1,
        cells: buildMatrix(SAVED_SIZE, cycleValueAt),
      },
    },
    appliedSize: SAVED_SIZE,
    action: NO_CHANGE,
  },
  {
    name: 'a saved size that is not a number',
    input: {
      savedGrid: { size: '4', cells: buildMatrix(SAVED_SIZE, cycleValueAt) },
    },
    appliedSize: SAVED_SIZE,
    action: NO_CHANGE,
  },
  {
    name: 'a configured size of zero',
    input: {
      savedGrid: buildGrid(SAVED_SIZE, cycleValueAt),
      configuredSize: 0,
    },
    appliedSize: SAVED_SIZE,
    action: NO_CHANGE,
  },
  {
    name: 'a fractional configured size',
    input: {
      savedGrid: buildGrid(SAVED_SIZE, cycleValueAt),
      configuredSize: 2.5,
    },
    appliedSize: SAVED_SIZE,
    action: NO_CHANGE,
  },
  {
    name: 'a configured size above the supported ceiling',
    input: {
      savedGrid: buildGrid(SAVED_SIZE, cycleValueAt),
      configuredSize: MAX_BOARD_SIZE + 1,
    },
    appliedSize: SAVED_SIZE,
    action: NO_CHANGE,
  },
  {
    name: 'a configured size that is not a number',
    input: {
      savedGrid: buildGrid(SAVED_SIZE, cycleValueAt),
      configuredSize: '3' as unknown as number,
    },
    appliedSize: SAVED_SIZE,
    action: NO_CHANGE,
  },
  {
    name: 'a relic size that is not a finite number',
    input: {
      savedGrid: buildGrid(SAVED_SIZE, cycleValueAt),
      relicBoardSize: Number.NaN,
    },
    appliedSize: SAVED_SIZE,
    action: NO_CHANGE,
  },
  {
    name: 'a negative relic size',
    input: {
      savedGrid: buildGrid(SAVED_SIZE, cycleValueAt),
      relicBoardSize: -SAVED_SIZE,
    },
    appliedSize: SAVED_SIZE,
    action: NO_CHANGE,
  },
  {
    name: 'a hole where js/grid.js L109 wrote null',
    input: {
      savedGrid: {
        size: 2,
        cells: [
          [null, undefined],
          [null, null],
        ],
      },
    },
    appliedSize: 2,
    action: REPAIRED,
  },
  {
    name: 'a cell that is neither a tile nor null',
    input: {
      savedGrid: {
        size: 2,
        cells: [
          [7, null],
          [null, null],
        ],
      },
    },
    appliedSize: 2,
    action: REPAIRED,
  },
  {
    name: 'a tile recorded at a cell other than the one it occupies',
    input: {
      savedGrid: {
        size: 2,
        cells: [
          [{ position: { x: 1, y: 1 }, value: 8 }, null],
          [null, null],
        ],
      },
    },
    appliedSize: 2,
    action: REPAIRED,
  },
  {
    name: 'a jagged matrix',
    input: { savedGrid: { size: 2, cells: [[null], [null, null]] } },
    appliedSize: 2,
    action: REPAIRED,
  },
];

describe('reconcileBoardSize is total over a degenerate saved payload', () => {
  it('throws for no degenerate input', () => {
    for (const testCase of DEGENERATE_CASES) {
      const resolve = (): BoardSizeReconciliationResult =>
        reconcileBoardSize(testCase.input);

      expect(resolve, testCase.name).not.toThrow();
    }
  });

  it('applies the documented size and action for each', () => {
    for (const testCase of DEGENERATE_CASES) {
      const { reconciliation } = reconcileBoardSize(testCase.input);

      expect(reconciliation.appliedSize, testCase.name).toBe(
        testCase.appliedSize,
      );
      expect(reconciliation.action, testCase.name).toBe(testCase.action);
    }
  });

  it('keeps the applied size a positive integer within the ceiling', () => {
    for (const testCase of DEGENERATE_CASES) {
      expectBoundedRecord(reconcileBoardSize(testCase.input).reconciliation);
    }
  });

  it('rebuilds a dense square lattice at the applied size', () => {
    for (const testCase of DEGENERATE_CASES) {
      const { grid, reconciliation } = reconcileBoardSize(testCase.input);

      expectWellFormedGrid(grid, reconciliation.appliedSize);
    }
  });

  it('resolves each degenerate input identically on a repeated call', () => {
    for (const testCase of DEGENERATE_CASES) {
      const first = reconcileBoardSize(testCase.input).reconciliation;
      const second = reconcileBoardSize(testCase.input).reconciliation;

      expect(second, testCase.name).toEqual(first);
    }
  });

  it('reports a configured size it refused', () => {
    const { reconciliation } = reconcileTo(
      buildGrid(SAVED_SIZE, cycleValueAt),
      0,
    );

    expect(reconciliation.configuredSize).toBe(0);
    expect(reconciliation.appliedSize).toBe(SAVED_SIZE);
    expect(reconciliation.reportable).toBe(true);
  });

  it('reports a relic size it refused', () => {
    const { reconciliation } = reconcileBoardSize({
      savedGrid: buildGrid(SAVED_SIZE, cycleValueAt),
      relicBoardSize: MAX_BOARD_SIZE + 1,
    });

    expect(reconciliation.relicSize).toBe(0);
    expect(reconciliation.appliedSize).toBe(SAVED_SIZE);
    expect(reconciliation.reportable).toBe(true);
  });
});

/* ==========================================================================
 * 8. A shrink keeps every surviving tile where it was, and accounts for the
 *    tiles it dropped
 *
 *    `reconcileBoardSize()` reports nothing, so the reporter half of this
 *    accounting is asserted over `RunStateStore.load()` in section 15.
 * ========================================================================== */

describe('a shrink retains in-bounds tiles and counts the rest', () => {
  it('drops exactly the tiles lying outside the smaller lattice', () => {
    const saved = createNearLossBoard(SAVED_SIZE).grid;
    const { reconciliation } = reconcileTo(saved, SHRUNK_SIZE);
    const expected = tilesOutside(saved, SHRUNK_SIZE);

    // The fixture premise: a full 4x4 lattice carries tiles on both sides of
    // the 3x3 boundary, nine inside and seven outside.
    expect(tilesWithin(saved, SHRUNK_SIZE)).toHaveLength(
      SHRUNK_SIZE * SHRUNK_SIZE,
    );

    // A full 4x4 lattice shrunk to 3 loses column 3 and the remainder of row
    // 3: four cells plus three.
    expect(expected).toHaveLength(7);
    expect(reconciliation.tilesDropped).toBe(expected.length);
    expect(reconciliation.action).toBe(SHRANK);
  });

  it('keeps every surviving tile at its original cell and value', () => {
    const saved = createNearLossBoard(SAVED_SIZE).grid;
    const { grid } = reconcileTo(saved, SHRUNK_SIZE);

    expect(tilesOf(grid)).toEqual(tilesWithin(saved, SHRUNK_SIZE));
  });

  // The coordinate equality js/game_manager.js L270-L272 compared, applied to
  // every surviving cell: a reconciliation that moved a tile would show here.
  it('translates, rotates and re-packs nothing', () => {
    const saved = createNearLossBoard(SAVED_SIZE).grid;
    const { grid } = reconcileTo(saved, SHRUNK_SIZE);

    for (let x = 0; x < SHRUNK_SIZE; x += 1) {
      for (let y = 0; y < SHRUNK_SIZE; y += 1) {
        const before = saved.cells[x][y];
        const after = grid.cells[x][y];

        expect(after?.value ?? null).toBe(before?.value ?? null);
        expect(after?.position ?? null).toEqual(
          before === null ? null : { x, y },
        );
      }
    }
  });

  // js/grid.js L109 pushed `null` for an empty cell, never a hole.
  it('rebuilds a dense square lattice with null in every empty cell', () => {
    const saved = createMergePairBoard(SAVED_SIZE).grid;
    const { grid, reconciliation } = reconcileTo(saved, SHRUNK_SIZE);
    const occupied = tilesOf(grid).length;
    const last = SHRUNK_SIZE - 1;

    expectWellFormedGrid(grid, reconciliation.appliedSize);
    expect(occupied).toBe(2);
    expect(SHRUNK_SIZE * SHRUNK_SIZE - occupied).toBe(7);
    expect(grid.cells[last][last]).toBeNull();
    expect(grid.cells[last][last]).not.toBeUndefined();
  });

  it('leaves the saved board the shrink was handed untouched', () => {
    const board = createNearLossBoard(SAVED_SIZE);
    const pristine = copyBoard(board);

    reconcileTo(board.grid, SHRUNK_SIZE);

    expect(board).toEqual(pristine);
  });

  it('rehydrates a Grid at the applied size, holding Tile instances', () => {
    const saved = createNearLossBoard(SAVED_SIZE).grid;
    const result = reconcileTo(saved, SHRUNK_SIZE);
    const grid = rehydrate(result);

    expect(grid.size).toBe(SHRUNK_SIZE);
    expect(grid.cells).toHaveLength(SHRUNK_SIZE);
    expect(grid.cells[0]).toHaveLength(SHRUNK_SIZE);
    expect(grid.cellContent({ x: 0, y: 0 })).toBeInstanceOf(Tile);
  });

  it('serialises the rehydrated lattice back at the applied size', () => {
    const saved = createNearLossBoard(SAVED_SIZE).grid;
    const result = reconcileTo(saved, SHRUNK_SIZE);
    const serialized = rehydrate(result).serialize();

    expectWellFormedGrid(serialized, SHRUNK_SIZE);
    expect(serialized).toEqual(result.grid);
  });

  it('round-trips the rehydrated lattice through JSON unchanged', () => {
    const saved = createNearLossBoard(SAVED_SIZE).grid;
    const result = reconcileTo(saved, SHRUNK_SIZE);
    const serialized = rehydrate(result).serialize();
    const revived: unknown = JSON.parse(JSON.stringify(serialized));

    expect(revived).toEqual(serialized);
  });

  it('drops nothing when every tile already lies inside the lattice', () => {
    const saved = createMergePairBoard(SAVED_SIZE).grid;
    const { reconciliation } = reconcileTo(saved, SHRUNK_SIZE);

    expect(tilesOutside(saved, SHRUNK_SIZE)).toEqual([]);
    expect(reconciliation.tilesDropped).toBe(0);
    expect(reconciliation.action).toBe(SHRANK);
  });

  it('drops exactly one tile from the filled first column', () => {
    const saved = createBlockedBoard(SAVED_SIZE).grid;
    const { grid, reconciliation } = reconcileTo(saved, SHRUNK_SIZE);

    expect(reconciliation.tilesDropped).toBe(1);
    expect(tilesOf(grid)).toHaveLength(SHRUNK_SIZE);
  });

  it('drops every tile, without throwing, when none survives', () => {
    const board = createEmptyBoard(SAVED_SIZE);

    board.grid.cells[SAVED_SIZE - 1][0] = {
      position: { x: SAVED_SIZE - 1, y: 0 },
      value: 2,
    };
    board.grid.cells[SAVED_SIZE - 1][1] = {
      position: { x: SAVED_SIZE - 1, y: 1 },
      value: 4,
    };

    const shrink = (): BoardSizeReconciliationResult =>
      reconcileTo(board.grid, SHRUNK_SIZE);

    expect(shrink).not.toThrow();

    const { grid, reconciliation } = shrink();

    expect(reconciliation.tilesDropped).toBe(2);
    expect(tilesOf(grid)).toEqual([]);
    expectWellFormedGrid(grid, SHRUNK_SIZE);
  });

  it('shrinks to the smallest legal size without throwing', () => {
    const saved = createNearLossBoard(SAVED_SIZE).grid;
    const shrink = (): BoardSizeReconciliationResult =>
      reconcileTo(saved, SMALLEST_SIZE);

    expect(shrink).not.toThrow();

    const { grid, reconciliation } = shrink();

    expect(reconciliation.appliedSize).toBe(SMALLEST_SIZE);
    expect(reconciliation.tilesDropped).toBe(SAVED_SIZE * SAVED_SIZE - 1);
    expect(tilesOf(grid)).toEqual([tilesWithin(saved, SMALLEST_SIZE)[0]]);
    expectWellFormedGrid(grid, SMALLEST_SIZE);
  });
});

/* ==========================================================================
 * 9. A grow adds empty cells and moves nothing
 *
 *    The reporter half, for a grow that dropped nothing, is asserted over
 *    `RunStateStore.load()` in section 15.
 * ========================================================================== */

describe('a grow adds empty cells and re-centres nothing', () => {
  it('grows to the configured size and drops no tile', () => {
    const { reconciliation } = reconcileTo(
      createNearLossBoard(SAVED_SIZE).grid,
      GROWN_SIZE,
    );

    expect(reconciliation.appliedSize).toBe(GROWN_SIZE);
    expect(reconciliation.action).toBe(GREW);
    expect(reconciliation.tilesDropped).toBe(0);
  });

  it('keeps every original tile at its original cell and value', () => {
    const saved = createNearLossBoard(SAVED_SIZE).grid;
    const { grid } = reconcileTo(saved, GROWN_SIZE);

    expect(tilesOf(grid)).toEqual(tilesOf(saved));
  });

  it('leaves the first cell occupied and the far corner empty', () => {
    const saved = createNearLossBoard(SAVED_SIZE).grid;
    const { grid } = reconcileTo(saved, GROWN_SIZE);
    const corner = GROWN_SIZE - 1;

    expect(grid.cells[0][0]?.position).toEqual({ x: 0, y: 0 });
    expect(grid.cells[corner][corner]).toBeNull();
  });

  it('fills every newly added cell with null', () => {
    const { grid } = reconcileTo(
      createNearLossBoard(SAVED_SIZE).grid,
      GROWN_SIZE,
    );

    expectWellFormedGrid(grid, GROWN_SIZE);
    expect(tilesOutside(grid, SAVED_SIZE)).toEqual([]);
    expect(tilesOf(grid)).toHaveLength(SAVED_SIZE * SAVED_SIZE);

    for (let x = 0; x < GROWN_SIZE; x += 1) {
      for (let y = 0; y < GROWN_SIZE; y += 1) {
        if (x >= SAVED_SIZE || y >= SAVED_SIZE) {
          expect(grid.cells[x][y]).toBeNull();
        }
      }
    }
  });

  it('re-centres nothing, leaving each saved cell exactly as it was', () => {
    const saved = createNearLossBoard(SAVED_SIZE).grid;
    const { grid } = reconcileTo(saved, GROWN_SIZE);

    for (let x = 0; x < SAVED_SIZE; x += 1) {
      for (let y = 0; y < SAVED_SIZE; y += 1) {
        expect(grid.cells[x][y]).toEqual(saved.cells[x][y]);
      }
    }
  });

  it('serialises the rehydrated lattice at the grown size', () => {
    const result = reconcileTo(
      createNearLossBoard(SAVED_SIZE).grid,
      GROWN_SIZE,
    );
    const serialized = rehydrate(result).serialize();
    const corner = GROWN_SIZE - 1;

    expect(serialized.size).toBe(GROWN_SIZE);
    expect(serialized.cells).toHaveLength(GROWN_SIZE);
    expect(serialized.cells[corner]).toHaveLength(GROWN_SIZE);
    expect(serialized.cells[corner][corner]).toBeNull();
    expect(serialized).toEqual(result.grid);
  });

  it('leaves the saved board the grow was handed untouched', () => {
    const board = createNearLossBoard(SAVED_SIZE);
    const pristine = copyBoard(board);

    reconcileTo(board.grid, GROWN_SIZE);

    expect(board).toEqual(pristine);
  });
});

/* ==========================================================================
 * 10. The loss check reads the reconciled edge length
 * ========================================================================== */

/** The corner cell of a grown lattice. */
const OUTER = GROWN_SIZE - 1;

/**
 * The value a cell of the outer band takes. With `pair` set, the corner takes
 * the value of the cell above it, which is the one adjacent equal pair the
 * grown lattice carries.
 */
function outerBandValue(x: number, y: number, pair: boolean): number {
  return pair && x === OUTER && y === OUTER
    ? cycleValueAt(OUTER, OUTER - 1)
    : cycleValueAt(x, y);
}

/**
 * A saved 4x4 lattice grown to `GROWN_SIZE` and then filled to the edge, as a
 * spawn fills a cell the grow added.
 *
 * The saved lattice carries no adjacent equal pair at all, so with `pair` set
 * the only merge on the finished board is the one in the outer column, and
 * with it clear there is none anywhere.
 */
function grownAndFilledBoard(pair: boolean): Grid {
  const grid = rehydrate(
    reconcileTo(buildGrid(SAVED_SIZE, cycleValueAt), GROWN_SIZE),
  );

  for (let x = 0; x < GROWN_SIZE; x += 1) {
    for (let y = 0; y < GROWN_SIZE; y += 1) {
      if (x >= SAVED_SIZE || y >= SAVED_SIZE) {
        grid.insertTile(new Tile({ x, y }, outerBandValue(x, y, pair)));
      }
    }
  }

  return grid;
}

describe('a grown board is scanned to its own edge, not the saved one', () => {
  it('carries no empty cell once the outer band is filled', () => {
    for (const pair of [true, false]) {
      const grid = grownAndFilledBoard(pair);

      expect(grid.size).toBe(GROWN_SIZE);
      expect(grid.cellsAvailable()).toBe(false);
      expect(grid.availableCells()).toEqual([]);
    }
  });

  it('carries exactly one pair, and it lies in the outer column', () => {
    expect(adjacentEqualPairs(grownAndFilledBoard(true))).toEqual([
      `(${OUTER},${OUTER - 1})-(${OUTER},${OUTER})`,
    ]);
  });

  it('carries no pair at all with the outer column left unmergeable', () => {
    expect(adjacentEqualPairs(grownAndFilledBoard(false))).toEqual([]);
  });

  // js/game_manager.js L243-L268. The pair sits in the row and column the
  // captured bound never reaches, so this is the assertion the file exists for.
  it('finds the outer merge, where a captured bound of 4 finds none', () => {
    const grid = grownAndFilledBoard(true);

    expect(tileMatchesAvailable(grid, config)).toBe(true);
    expect(matchesWithinBound(grid, config, GROWN_SIZE)).toBe(true);
    expect(matchesWithinBound(grid, config, SAVED_SIZE)).toBe(false);
  });

  // js/game_manager.js L238-L240.
  it('reports a move available on a full board whose pair is outermost', () => {
    const grid = grownAndFilledBoard(true);

    expect(grid.cellsAvailable()).toBe(false);
    expect(movesAvailable(grid, config)).toBe(true);
  });

  it('reports no move when the outer column carries no pair either', () => {
    const grid = grownAndFilledBoard(false);

    expect(tileMatchesAvailable(grid, config)).toBe(false);
    expect(movesAvailable(grid, config)).toBe(false);
    expect(matchesWithinBound(grid, config, GROWN_SIZE)).toBe(false);
    expect(matchesWithinBound(grid, config, SAVED_SIZE)).toBe(false);
  });

  it('reaches every cell of the grown lattice when walking it', () => {
    const grid = grownAndFilledBoard(true);
    const visited: string[] = [];

    grid.eachCell((x, y) => {
      visited.push(`${x},${y}`);
    });

    expect(visited).toHaveLength(GROWN_SIZE * GROWN_SIZE);
    expect(visited).toContain(`${OUTER},${OUTER}`);
  });
});

/* ==========================================================================
 * 11. The loss check over a shrunk board stays inside the new lattice
 * ========================================================================== */

/**
 * A saved 4x4 lattice whose one adjacent equal pair lies wholly in the band a
 * shrink to `SHRUNK_SIZE` drops: the last column's final two cells.
 */
function savedGridWithPairInDroppedBand(): SerializedGrid {
  return buildGrid(SAVED_SIZE, (x, y) =>
    x === SAVED_SIZE - 1 && y === SAVED_SIZE - 1
      ? cycleValueAt(SAVED_SIZE - 1, SAVED_SIZE - 2)
      : cycleValueAt(x, y),
  );
}

describe('a shrunk board is scanned to its own edge, not the saved one', () => {
  it('carried that pair before the shrink', () => {
    const saved = savedGridWithPairInDroppedBand();
    const grid = new Grid(saved.size, saved.cells);

    expect(grid.cellsAvailable()).toBe(false);
    expect(tileMatchesAvailable(grid, config)).toBe(true);
    expect(adjacentEqualPairs(grid)).toEqual([
      `(${SAVED_SIZE - 1},${SAVED_SIZE - 2})-` +
        `(${SAVED_SIZE - 1},${SAVED_SIZE - 1})`,
    ]);
  });

  it('reports no merge from a pair that lay only among dropped tiles', () => {
    const grid = rehydrate(
      reconcileTo(savedGridWithPairInDroppedBand(), SHRUNK_SIZE),
    );

    expect(grid.size).toBe(SHRUNK_SIZE);
    expect(grid.cellsAvailable()).toBe(false);
    expect(adjacentEqualPairs(grid)).toEqual([]);
    expect(tileMatchesAvailable(grid, config)).toBe(false);
    expect(movesAvailable(grid, config)).toBe(false);
  });

  // js/grid.js L80-L86 and L97-L100: a cell outside the lattice reads as
  // `null`, and that is what a probe stepping off the edge relies on.
  it('answers null for the cells the shrink removed', () => {
    const grid = rehydrate(
      reconcileTo(savedGridWithPairInDroppedBand(), SHRUNK_SIZE),
    );

    for (let index = SHRUNK_SIZE; index < SAVED_SIZE; index += 1) {
      expect(grid.withinBounds({ x: index, y: 0 })).toBe(false);
      expect(grid.withinBounds({ x: 0, y: index })).toBe(false);
      expect(grid.cellContent({ x: index, y: 0 })).toBeNull();
      expect(grid.cellContent({ x: 0, y: index })).toBeNull();
      expect(grid.cellContent({ x: index, y: index })).toBeNull();
    }
  });

  it('probes off the lattice without throwing under the saved bound', () => {
    const grid = rehydrate(
      reconcileTo(savedGridWithPairInDroppedBand(), SHRUNK_SIZE),
    );
    const probe = (): boolean => matchesWithinBound(grid, config, SAVED_SIZE);

    expect(probe).not.toThrow();
    expect(probe()).toBe(false);
  });
});

/* ==========================================================================
 * 12. movesAvailable keeps the short circuit of the vanilla check
 * ========================================================================== */

// js/game_manager.js L238-L240: `cellsAvailable() || tileMatchesAvailable()`.
describe('movesAvailable keeps its operand order and its short circuit', () => {
  it('is carried by the free cells a grow added, with no pair present', () => {
    const grid = rehydrate(
      reconcileTo(buildGrid(SAVED_SIZE, cycleValueAt), GROWN_SIZE),
    );

    expect(grid.cellsAvailable()).toBe(true);
    expect(grid.availableCells()).toHaveLength(
      GROWN_SIZE * GROWN_SIZE - SAVED_SIZE * SAVED_SIZE,
    );
    expect(tileMatchesAvailable(grid, config)).toBe(false);
    expect(movesAvailable(grid, config)).toBe(true);
  });

  it('falls through to the probe when the shrunk lattice is full', () => {
    const grid = rehydrate(
      reconcileTo(savedGridWithPairInDroppedBand(), SHRUNK_SIZE),
    );

    expect(grid.cellsAvailable()).toBe(false);
    expect(tileMatchesAvailable(grid, config)).toBe(false);
    expect(movesAvailable(grid, config)).toBe(false);
  });

  it('falls through to the probe and finds the outer pair when full', () => {
    const grid = grownAndFilledBoard(true);

    expect(grid.cellsAvailable()).toBe(false);
    expect(tileMatchesAvailable(grid, config)).toBe(true);
    expect(movesAvailable(grid, config)).toBe(true);
  });

  it('keeps a merge that survived a shrink available', () => {
    const grid = rehydrate(
      reconcileTo(createMergePairBoard(SAVED_SIZE).grid, SHRUNK_SIZE),
    );

    expect(grid.cellsAvailable()).toBe(true);
    expect(tileMatchesAvailable(grid, config)).toBe(true);
    expect(movesAvailable(grid, config)).toBe(true);
  });
});

/* ==========================================================================
 * 13. The win check reads config.winValue over the reconciled lattice
 * ========================================================================== */

/**
 * A saved 4x4 board carrying the win value at one cell and `MID_VALUE` at the
 * other of the two cells named.
 */
function boardWithWinnerAt(winner: Position, other: Position): SerializedGrid {
  const board = createEmptyBoard(SAVED_SIZE);

  board.grid.cells[winner.x][winner.y] = {
    position: { x: winner.x, y: winner.y },
    value: config.winValue,
  };
  board.grid.cells[other.x][other.y] = {
    position: { x: other.x, y: other.y },
    value: MID_VALUE,
  };

  return board.grid;
}

const FIRST_CELL: Position = { x: 0, y: 0 };

const LAST_CELL: Position = { x: SAVED_SIZE - 1, y: SAVED_SIZE - 1 };

// js/game_manager.js L170 compared a merged value against the literal 2048;
// src/engine/terminal-state.ts compares against `config.winValue`.
describe('the win check reads the reconciled lattice', () => {
  it('still wins on a winning tile that survived the shrink', () => {
    const result = reconcileTo(
      boardWithWinnerAt(FIRST_CELL, LAST_CELL),
      SHRUNK_SIZE,
    );
    const grid = rehydrate(result);

    expect(result.reconciliation.tilesDropped).toBe(1);
    expect(hasReachedWinValue(grid, config)).toBe(true);
  });

  it('does not win on a winning tile the shrink dropped', () => {
    const result = reconcileTo(
      boardWithWinnerAt(LAST_CELL, FIRST_CELL),
      SHRUNK_SIZE,
    );
    const grid = rehydrate(result);

    expect(result.reconciliation.tilesDropped).toBe(1);
    expect(tilesOf(result.grid)).toEqual([
      { x: 0, y: 0, value: MID_VALUE },
    ]);
    expect(hasReachedWinValue(grid, config)).toBe(false);
  });

  it('wins on that same tile when the board grew instead', () => {
    const result = reconcileTo(
      boardWithWinnerAt(LAST_CELL, FIRST_CELL),
      GROWN_SIZE,
    );

    expect(result.reconciliation.tilesDropped).toBe(0);
    expect(hasReachedWinValue(rehydrate(result), config)).toBe(true);
  });

  it('reads the win value from the configuration it is handed', () => {
    const board = createEmptyBoard(SAVED_SIZE);

    board.grid.cells[0][0] = { position: { x: 0, y: 0 }, value: MID_VALUE };

    const grid = rehydrate(reconcileTo(board.grid, SHRUNK_SIZE));

    expect(hasReachedWinValue(grid, config)).toBe(false);

    config.winValue = MID_VALUE;

    expect(hasReachedWinValue(grid, config)).toBe(true);
  });

  it('does not win on the near-win fixture carried across a grow', () => {
    const saved = createNearWinBoard(SAVED_SIZE, config.winValue).grid;
    const grid = rehydrate(reconcileTo(saved, GROWN_SIZE));

    expect(hasReachedWinValue(grid, config)).toBe(false);
    expect(movesAvailable(grid, config)).toBe(true);
  });
});

/* ==========================================================================
 * 14. The highest tile value is read from the reconciled lattice
 * ========================================================================== */

/** A saved 4x4 board carrying `MID_VALUE` first and `HIGH_VALUE` last. */
function boardWithHighTileLast(): SerializedGrid {
  const board = createEmptyBoard(SAVED_SIZE);

  board.grid.cells[0][0] = { position: { x: 0, y: 0 }, value: MID_VALUE };
  board.grid.cells[SAVED_SIZE - 1][SAVED_SIZE - 1] = {
    position: { x: SAVED_SIZE - 1, y: SAVED_SIZE - 1 },
    value: HIGH_VALUE,
  };

  return board.grid;
}

// The quantity src/config/stage-config.ts evaluates a highest-tile goal
// against, through `StageProgressInput.highestTileValue`.
describe('the highest tile value is read from the reconciled lattice', () => {
  it('reports no value from a tile the shrink dropped', () => {
    const grid = rehydrate(reconcileTo(boardWithHighTileLast(), SHRUNK_SIZE));

    expect(highestTileValue(grid)).toBe(MID_VALUE);
  });

  it('reports the same highest value across a grow', () => {
    const grid = rehydrate(reconcileTo(boardWithHighTileLast(), GROWN_SIZE));

    expect(highestTileValue(grid)).toBe(HIGH_VALUE);
  });

  it('reports zero for a lattice the shrink emptied', () => {
    const board = createEmptyBoard(SAVED_SIZE);

    board.grid.cells[SAVED_SIZE - 1][SAVED_SIZE - 1] = {
      position: { x: SAVED_SIZE - 1, y: SAVED_SIZE - 1 },
      value: HIGH_VALUE,
    };

    const grid = rehydrate(reconcileTo(board.grid, SHRUNK_SIZE));

    expect(tilesOf(grid.serialize())).toEqual([]);
    expect(highestTileValue(grid)).toBe(0);
  });

  it('reports half the win value for the near-win fixture', () => {
    const saved = createNearWinBoard(SAVED_SIZE, config.winValue).grid;
    const grid = rehydrate(reconcileTo(saved, GROWN_SIZE));

    expect(highestTileValue(grid)).toBe(config.winValue / 2);
  });
});

/* ==========================================================================
 * 15. Post-reload board integrity, through the store (gate V6)
 * ========================================================================== */

/**
 * A relic entry declaring an edge length on its own state slot, which is the
 * whole of what a board-mutating relic contributes here.
 */
function relicDeclaring(boardSize: number): PersistedRelic {
  return { id: 'collapsing-vault', state: { boardSize } };
}

/** One load, with the world that performed it. */
interface LoadedWorld {
  readonly world: World;
  readonly state: RunState | null;
  readonly outcome: RunStateLoadOutcome;
  readonly reconciliation: BoardSizeReconciliation | undefined;
}

/**
 * Loads a saved board against a configured edge length, through the store.
 *
 * @param board Board the envelope wraps.
 * @param boardSize Edge length the load reconciles against.
 * @param relics Entries the envelope carries.
 * @returns The world and the load result.
 */
function loadAgainst(
  board: SerializedGameState,
  boardSize: number,
  relics?: readonly PersistedRelic[],
): LoadedWorld {
  const world = createWorld({ board, config, relics });
  const result = world.store.load({ boardSize });

  return {
    world,
    state: result.state,
    outcome: result.outcome,
    reconciliation: result.reconciliation,
  };
}

/** The board every case of this section saves: a full 4x4 lattice. */
function savedBoard(): SerializedGameState {
  return {
    ...createEmptyBoard(SAVED_SIZE),
    grid: savedGridWithPairInDroppedBand(),
  };
}

/**
 * The grid a load returned. A load that returned no envelope yields an edge
 * length of zero, which fails every assertion made about a loaded lattice.
 */
function gridOf(loaded: LoadedWorld): SerializedGrid {
  return loaded.state?.board.grid ?? { size: 0, cells: [] };
}

describe('a reconciled load leaves the envelope internally consistent', () => {
  it('surfaces the reconciliation record with the reconciled outcome', () => {
    const loaded = loadAgainst(savedBoard(), SHRUNK_SIZE);

    expect(loaded.outcome).toBe('reconciled');
    expect(loaded.reconciliation?.appliedSize).toBe(SHRUNK_SIZE);
    expect(loaded.reconciliation?.action).toBe(SHRANK);
  });

  // An envelope claiming one edge length over a matrix of another is the
  // corruption js/game_manager.js L40-L41 could rehydrate; the loaded matrix
  // measures the size it declares.
  it('agrees between board.grid.size and the matrix it carries', () => {
    for (const boardSize of [SHRUNK_SIZE, SAVED_SIZE, GROWN_SIZE]) {
      const grid = gridOf(loadAgainst(savedBoard(), boardSize));

      expect(grid.size).toBe(boardSize);
      expectWellFormedGrid(grid, boardSize);
    }
  });

  it('places every tile position inside board.grid.size', () => {
    for (const boardSize of [SMALLEST_SIZE, SHRUNK_SIZE, GROWN_SIZE]) {
      const grid = gridOf(loadAgainst(savedBoard(), boardSize));

      expect(grid.size).toBe(boardSize);

      for (const tile of tilesOf(grid)) {
        expect(tile.x).toBeLessThan(boardSize);
        expect(tile.y).toBeLessThan(boardSize);
      }
    }
  });

  it('carries no tile the shrink dropped', () => {
    const grid = gridOf(loadAgainst(savedBoard(), SHRUNK_SIZE));

    expect(tilesOutside(grid, SHRUNK_SIZE)).toEqual([]);
    expect(tilesOf(grid)).toEqual(
      tilesWithin(savedGridWithPairInDroppedBand(), SHRUNK_SIZE),
    );
  });

  it('keeps the reconciled envelope a structurally complete run state', () => {
    const loaded = loadAgainst(savedBoard(), SHRUNK_SIZE);

    expect(isRunStateShape(loaded.state)).toBe(true);
  });

  it('round-trips the reconciled envelope through JSON unchanged', () => {
    const loaded = loadAgainst(savedBoard(), GROWN_SIZE);
    const revived: unknown = JSON.parse(JSON.stringify(loaded.state));

    expect(revived).toEqual(loaded.state);
    expect(JSON.stringify(revived)).toBe(JSON.stringify(loaded.state));
  });

  it('leaves the five wrapped board members beside the rebuilt grid', () => {
    const loaded = loadAgainst(savedBoard(), SHRUNK_SIZE);

    expect(Object.keys(loaded.state?.board ?? {})).toEqual([
      'grid',
      'score',
      'over',
      'won',
      'keepPlaying',
    ]);
  });
});

// Rule 3: a reconciliation that discarded tiles without saying so would be the
// same class of defect as js/local_storage_manager.js L37's discarded error.
describe('a reconciliation reaches the reporter with its counts', () => {
  it('reports the shrink with the sizes and the dropped count', () => {
    const loaded = loadAgainst(savedBoard(), SHRUNK_SIZE);
    const reports = loaded.world.reconciliations;

    expect(reports).toHaveLength(1);

    const report = reports[0];
    const detail = report === undefined ? null : detailOf(report);

    expect(report?.correlationId).toBe(CORRELATION_ID);
    expect(report?.savedSize).toBe(SAVED_SIZE);
    expect(report?.configuredSize).toBe(SHRUNK_SIZE);
    expect(report?.appliedSize).toBe(SHRUNK_SIZE);
    expect(detail).not.toBeNull();
    expect(detail?.action).toBe(SHRANK);
    expect(detail?.tilesDropped).toBe(7);
    expect(detail?.tilesDropped).toBe(loaded.reconciliation?.tilesDropped);
  });

  it('reports the grow, where nothing was dropped, all the same', () => {
    const loaded = loadAgainst(savedBoard(), GROWN_SIZE);
    const report = loaded.world.reconciliations[0];
    const detail = report === undefined ? null : detailOf(report);

    expect(loaded.world.reconciliations).toHaveLength(1);
    expect(report?.savedSize).toBe(SAVED_SIZE);
    expect(report?.appliedSize).toBe(GROWN_SIZE);
    expect(detail).not.toBeNull();
    expect(detail?.action).toBe(GREW);
    expect(detail?.tilesDropped).toBe(0);
  });

  it('names the relic-implied size it applied over the configured one', () => {
    const loaded = loadAgainst(savedBoard(), SAVED_SIZE, [
      relicDeclaring(SHRUNK_SIZE),
    ]);
    const report = loaded.world.reconciliations[0];

    expect(report?.relicSize).toBe(SHRUNK_SIZE);
    expect(report?.configuredSize).toBe(SAVED_SIZE);
    expect(report?.appliedSize).toBe(SHRUNK_SIZE);
  });

  it('reports nothing at all when the saved size already matches', () => {
    const loaded = loadAgainst(savedBoard(), SAVED_SIZE);

    expect(loaded.world.reconciliations).toEqual([]);
    expect(loaded.reconciliation?.reportable).toBe(false);
    expect(loaded.state?.board.grid.size).toBe(SAVED_SIZE);
  });
});

// Gate V6's "including after reload": the run resumes on the board the relic
// left, and the loss check over it reads that board's own edge length.
describe('a relic-shrunk board is not lost when it is reloaded', () => {
  it('rebuilds the lattice at the size the relic declared', () => {
    const loaded = loadAgainst(savedBoard(), SAVED_SIZE, [
      relicDeclaring(SHRUNK_SIZE),
    ]);

    expect(loaded.outcome).toBe('reconciled');
    expect(loaded.state?.board.grid.size).toBe(SHRUNK_SIZE);
    expect(loaded.reconciliation?.relicSize).toBe(SHRUNK_SIZE);
    expect(loaded.reconciliation?.tilesDropped).toBe(7);
  });

  it('reads the loss check over the reconciled lattice alone', () => {
    const loaded = loadAgainst(savedBoard(), SAVED_SIZE, [
      relicDeclaring(SHRUNK_SIZE),
    ]);
    const reloaded = gridOf(loaded);
    const grid = new Grid(reloaded.size, reloaded.cells);
    const probe = (): boolean => matchesWithinBound(grid, config, SAVED_SIZE);

    expect(grid.size).toBe(SHRUNK_SIZE);
    expect(grid.cellsAvailable()).toBe(false);
    expect(tileMatchesAvailable(grid, config)).toBe(false);
    expect(movesAvailable(grid, config)).toBe(false);
    expect(probe).not.toThrow();
    expect(probe()).toBe(false);
  });

  it('keeps the relic entry that declared the size', () => {
    const loaded = loadAgainst(savedBoard(), SAVED_SIZE, [
      relicDeclaring(SHRUNK_SIZE),
    ]);

    expect(loaded.state?.relics).toEqual([relicDeclaring(SHRUNK_SIZE)]);
  });

  it('reads the win check over the reconciled lattice alone', () => {
    const board = createEmptyBoard(SAVED_SIZE);

    board.grid.cells[SAVED_SIZE - 1][SAVED_SIZE - 1] = {
      position: { x: SAVED_SIZE - 1, y: SAVED_SIZE - 1 },
      value: config.winValue,
    };

    const loaded = loadAgainst(board, SAVED_SIZE, [
      relicDeclaring(SHRUNK_SIZE),
    ]);
    const reloaded = gridOf(loaded);
    const grid = new Grid(reloaded.size, reloaded.cells);

    expect(loaded.reconciliation?.tilesDropped).toBe(1);
    expect(hasReachedWinValue(grid, config)).toBe(false);
    expect(highestTileValue(grid)).toBe(0);
  });
});

/* ==========================================================================
 * 16. The teardown removes the keys the game never did
 * ========================================================================== */

describe('the teardown clears every owned key, idempotently', () => {
  it('empties a store carrying a run envelope and a best score', () => {
    const storage = new MemoryStorage();

    storage.setItem(
      RUN_STATE_KEY,
      JSON.stringify(buildEnvelope(createEmptyBoard(SAVED_SIZE))),
    );
    storage.setItem(BEST_SCORE_KEY, BEST_SCORE_SENTINEL);

    const clearTwice = (): void => {
      clearOwnedKeysOf(storage);
      clearOwnedKeysOf(storage);
    };

    expect(clearTwice).not.toThrow();

    for (const key of OWNED_STORAGE_KEYS) {
      expect(storage.getItem(key)).toBeUndefined();
    }

    expect(storage.getItem(BEST_SCORE_KEY)).toBeUndefined();
  });
});
